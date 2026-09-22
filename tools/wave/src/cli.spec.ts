/**
 * cli.spec.ts — Tests for the 4 invocation forms of tools/wave/src/cli.ts
 *
 * Tests are divided into:
 *  1. Direct unit tests on the exported `main(argv)` function, capturing
 *     stdout/stderr writes via spies.
 *  2. One smoke test per invocation form that confirms exit-code semantics.
 *
 * The spec uses a throw-away temp dir (same pattern as dor-gate.spec.ts) to
 * provide a real issue file for the happy-path forms.
 *
 * Section 5 adds `files-drift` CLI integration tests. These exercise
 * `runFilesDrift` through `main()` using a `vi.mock` on `node:child_process`
 * so that `getChangedFilesFromGit` returns a controlled file list without
 * spawning a real git process.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
  // Issue #417's fixture makes a REAL removal fail by denying write on the
  // payload's parent directory — permission bits are the portable way to do
  // that without mocking node:fs (which this spec deliberately leaves real).
  chmodSync,
  // Gate 9's fixtures back-date an issue file: on a markdown store the file's
  // own mtime IS the tracker-update signal, so setting it is how a "this row
  // was last touched before main moved" scenario is built without a clock race.
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, mainAsync, runDorById, findRepoRoot, verbContracts } from './cli';
// Issue #758: the roster is rendered FROM the contracts, so its expectations are
// derived from the contracts too — `canonicalFlagTokens` is the engine's own
// answer to "which spellings does this verb declare", never a list retyped here.
import {
  canonicalFlagTokens,
  defineVerb,
  renderInvocations,
  type VerbContract,
} from './verb-contract';
// Imported ONLY to reach `route-tuple`'s own usage() text (issue #743's
// catalog/usage agreement check below) — a bare `runRouteTuple([])` hits its
// first missing-flag check and writes that text to stderr, exactly the way
// route-tuple.spec.ts's own "usage and preconditions" block already drives it.
import { runRouteTuple } from './route-tuple';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import type { CreateInput, IssueStore } from './adapters/issue-store';
import type { IssueView } from './contract';
// Imported ONLY to derive the real op vocab from the actual dispatch tables
// (FOR-11 AC2) — never to duplicate a hand-maintained list in this spec.
import { runSpine } from './spine-cli';
// The human-lane token, imported rather than typed: the whole point of issue
// #323 is that no second copy of `HITL-required` may exist unpinned, and a
// spec fixture is exactly the kind of second copy that rots quietly.
import { HUMAN_GATED_WORKER } from './wave-md-rw';
import { runIssueStore } from './issue-store-cli';
// Imported to DERIVE the expected router output from the standalone runners
// themselves (issue #77) — the router-vs-standalone parity assertions below
// compare against what these actually produce, never against a transcribed copy.
import { runResume } from './resume-cli';
import { runStorePreflight } from './cli-store';
import { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
// Only the threshold constant + the advisory function itself (to derive an
// expectation, never to duplicate its wording) — the detached-sweep functions
// are exercised entirely through `main()` below (issue #265's co-location of
// the router-level `--detached` specs; see worktree-cleanup.spec.ts for the
// engine-level coverage of the sweep's own classification logic).
import {
  WORKTREE_COUNT_ADVISORY_THRESHOLD,
  checkWorktreeCountAdvisory,
  // The SECOND E2BIG term (issue #266) — same rule: the constant plus the
  // function, so the router-level expectation is DERIVED from the engine and
  // this file never restates the wording the engine owns.
  COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
  checkCommandLineSizeAdvisory,
  // The PER-STRING term's threshold (issue #340), surfaced on the CLI JSON by
  // issue #377. Same rule again: the constant is IMPORTED so the router-level
  // expectation is derived from the engine's own budget and can never drift
  // away from it by being retyped here.
  MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
  // The Scribe scratch directory's own path constant (issue #355), imported so
  // the issue-#377 fixture below plants its payloads where the ENGINE looks
  // rather than where this spec believes the engine looks — a transcribed
  // `.flotilla/tmp` would keep passing after the constant moved.
  SCRIBE_SCRATCH_RELATIVE_DIR,
} from './worktree-cleanup';

// Mock node:child_process so files-drift integration tests can control the
// git diff output without spawning a real git process. The mock is applied
// to the whole module; tests that do NOT call files-drift are unaffected
// because they never reach getChangedFilesFromGit.
//
// ONLY `execFileSync` is replaced — everything else is spread through from the
// real module (ADR-0029): the credential seam spawns its lookup with
// `spawnSync`, and the router specs for `credential-probe` below drive that
// through the REAL shell on purpose. A wholesale `() => ({ execFileSync })`
// factory left `spawnSync` undefined, which would make the negative control
// fail for the wrong reason — a missing binding, not a broken lookup. No engine
// module uses any other `node:child_process` export (execFileSync + spawnSync
// are the complete set), so nothing else changes behaviour here.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(() => ''),
}));

// ─── Temp-dir setup ───────────────────────────────────────────────────────────

let root: string;
let issueFile: string;
let spineFile: string;
let emptySpineFile: string;
let stackedSpineFile: string;
let githubSpineFile: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-cli-spec-'));

  // Create a minimal valid issue under a .scratch/ structure so the repo-root
  // detection in cli.ts works correctly.
  const issueDir = join(root, '.scratch', 'test-feature', 'issues');
  mkdirSync(issueDir, { recursive: true });

  // Write package.json at root so findRepoRoot stops walking.
  writeFileSync(join(root, 'package.json'), '{"name":"test-root"}', 'utf-8');

  issueFile = join(issueDir, '01-test-issue.md');
  writeFileSync(
    issueFile,
    [
      '# 01 — Test issue',
      '',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- some/file.ts',
      '**Blocked by:** none',
      '',
      '## What to build',
      '',
      'A thing.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] Thing is built',
    ].join('\n'),
    'utf-8',
  );

  // ── merge-order fixtures ──────────────────────────────────────────────────
  // Two issues + a spine that links them via [^source-*] footnotes. The
  // node:child_process mock (execFileSync → '') makes defaultGitProbe resolve
  // every branch to null, so the CLI run is hermetic: no override, deterministic
  // algorithmic order by fileCount (2 files vs 1 file).
  writeFileSync(
    join(issueDir, '02-second-issue.md'),
    [
      '# 02 — Second issue',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- some/a.ts',
      '- some/b.ts',
      '**Blocked by:** none',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    join(issueDir, '03-third-issue.md'),
    [
      '# 03 — Third issue',
      '**Status:** ready-for-agent',
      '**Risk:** mechanical',
      '**Worker:** background',
      '**Files:**',
      '- some/c.ts',
      '**Blocked by:** none',
    ].join('\n'),
    'utf-8',
  );

  const wavesDir = join(root, '.scratch', 'waves');
  mkdirSync(wavesDir, { recursive: true });
  spineFile = join(wavesDir, '2026-01-01-test-wave.md');
  writeFileSync(
    spineFile,
    [
      '# Test wave',
      '',
      '**Status:** closed',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title |',
      '| --- | ----- |',
      '| tf/02 | Second [^source-tf-02] |',
      '| tf/03 | Third [^source-tf-03] |',
      '',
      '[^source-tf-02]: Source: [`.scratch/test-feature/issues/02-second-issue.md`](../test-feature/issues/02-second-issue.md)',
      '',
      '[^source-tf-03]: Source: [`.scratch/test-feature/issues/03-third-issue.md`](../test-feature/issues/03-third-issue.md)',
      '',
      '## Conflict-Map',
      '',
      '1. **tf/02 ↔ tf/03** at `some/shared.ts`',
      '',
    ].join('\n'),
    'utf-8',
  );

  // A spine whose Resume-Metadata dispatch-log declares the EXACT branch name
  // for each issue (the §L3 stale-branch fix: the spine-declared branch must win
  // over the NN-glob git probe). Mirrors the happy-path spine but adds the
  // dispatch-log so parseWaveSpine yields a non-empty branchesByIssueId. With
  // execFileSync mocked to '' the git probe resolves nothing, so a non-null
  // branch in the output proves the spine map was threaded through to
  // computeMergeOrder (the regression guard for the cli.ts branchesByIssueId bug).
  stackedSpineFile = join(wavesDir, '2026-01-03-stacked-wave.md');
  writeFileSync(
    stackedSpineFile,
    [
      '# Stacked wave',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title |',
      '| --- | ----- |',
      '| tf/02 | Second [^source-tf-02] |',
      '| tf/03 | Third [^source-tf-03] |',
      '',
      '[^source-tf-02]: Source: [`.scratch/test-feature/issues/02-second-issue.md`](../test-feature/issues/02-second-issue.md)',
      '',
      '[^source-tf-03]: Source: [`.scratch/test-feature/issues/03-third-issue.md`](../test-feature/issues/03-third-issue.md)',
      '',
      '## Conflict-Map',
      '',
      '1. **tf/02 ↔ tf/03** at `some/shared.ts`',
      '',
      '## Resume-Metadata',
      '',
      '```yaml',
      'last-tick: 2026-01-03 — test',
      'dispatch-log:',
      '  - "02 → agent aaaaaaaa (sonnet) branch wave-orch/02-second-issue"',
      '  - "03 → agent bbbbbbbb (sonnet) branch wave-orch/03-third-issue"',
      'notes: |',
      '  none',
      '```',
      '',
    ].join('\n'),
    'utf-8',
  );

  // A spine with no [^source-*] footnotes → zero issues parsed.
  emptySpineFile = join(wavesDir, '2026-01-02-empty-wave.md');
  writeFileSync(
    emptySpineFile,
    [
      '# Empty wave',
      '',
      '**Status:** draft',
      '',
      'No footnotes here.',
      '',
    ].join('\n'),
    'utf-8',
  );

  // A GitHub-shaped spine: bare-number ids in the Plan-Table, a Conflict-Map
  // cell, NO [^source-*] footnotes and NO .scratch/ issue files on disk.
  // This is the ADR-0019 case: computeMergeOrderFromSpine must branch into
  // buildSpinePrs (conflict-footprint proxy) and return exit 0 with a
  // NON-empty advisory order — the CRITICAL finding this test guards.
  // Uses the canonical 9-column Plan-Table format that readSpine expects.
  githubSpineFile = join(wavesDir, '2026-01-04-github-wave.md');
  writeFileSync(
    githubSpineFile,
    [
      '# GitHub wave',
      '',
      '**Status:** in-review',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 7 | Add route handler | background | mechanical | universal | — | in-review | 1 | — |',
      '| 9 | Add config option | background | mechanical | universal | — | in-review | 1 | — |',
      '',
      '## Conflict-Map',
      '',
      '1. **7 ↔ 9** at `src/config.ts` and `src/router.ts`',
      '',
    ].join('\n'),
    'utf-8',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── Spy helpers ─────────────────────────────────────────────────────────────

let stdoutBuf: string;
let stderrBuf: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    });
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

// ─── Form 1: no-args ─────────────────────────────────────────────────────────

describe('no-args invocation', () => {
  it('exits with code 2', () => {
    const code = main([]);
    expect(code).toBe(2);
  });

  it('writes usage help to stderr', () => {
    main([]);
    expect(stderrBuf).toMatch(/usage/i);
  });

  it('mentions the dor subcommand in usage output', () => {
    main([]);
    expect(stderrBuf).toMatch(/dor/);
  });

  it('writes nothing to stdout', () => {
    main([]);
    expect(stdoutBuf).toBe('');
  });
});

// ─── The route-tuple `--title` catalog line agrees with route-tuple's OWN
//             usage text (issue #743) ────────────────────────────────────────
//
// The gap: the top-level catalog (this file's `printUsage`) states the
// `--title` flag's three-way precedence in its own line, and route-tuple.ts's
// own `usage()` states the identical rule in its own words — two independent
// copies of one fact, and nothing before this asserted they agreed. A later
// edit to either side (a re-worded precedence, a re-ordered `titleSource`
// vocabulary) would drift silently; only a human reading both surfaces side
// by side caught it the one time it mattered (issue #724).
//
// The two surfaces are not byte-identical top to bottom — the catalog line is
// a `--title <text> …` flag-signature bullet, the usage text folds the same
// clause into `--title renames the PR.` prose — so this pins the one fragment
// that IS meant to be the same fact stated twice: the precedence rule and the
// `titleSource` vocabulary, from "Without it, a REUSE preserves…" to the
// closing "(flag | live-pr | row).". Extracting that fragment independently
// from each REAL source (never a third hand-copied string) and asserting
// equality is what makes this bidirectional: a change to either side's
// wording of that fragment breaks the equality, regardless of which side
// moved.
describe('the route-tuple `--title` CONTRACT section agrees with route-tuple\'s own usage text (issue #743)', () => {
  const FRAGMENT_START = 'Without it, a REUSE preserves the live PR title';
  const FRAGMENT_END = '(flag | live-pr | row).';

  /**
   * The shared precedence-rule fragment, whitespace-normalized (both sources
   * wrap the same prose across different line lengths, so a raw substring
   * compare would fail on line breaks alone rather than on a real disagreement).
   */
  function titleFlagFragment(text: string): string {
    const start = text.indexOf(FRAGMENT_START);
    expect(start, `fragment start ${JSON.stringify(FRAGMENT_START)} not found in:\n${text}`).toBeGreaterThanOrEqual(0);
    const fromStart = text.slice(start);
    const endAt = fromStart.indexOf(FRAGMENT_END);
    expect(endAt, `fragment end ${JSON.stringify(FRAGMENT_END)} not found in:\n${fromStart}`).toBeGreaterThanOrEqual(0);
    return fromStart
      .slice(0, endAt + FRAGMENT_END.length)
      .replace(/\s+/g, ' ')
      .trim();
  }

  it('states the identical precedence rule and titleSource vocabulary — asserted from both directions', async () => {
    // Issue #758 moved the catalog half of this pair. The router's roster is
    // rendered from the contracts now and carries no verb's prose at all, so
    // the second copy this guard was written against no longer sits there —
    // it sits where it always belonged, in the verb's OWN contract section,
    // which `route-tuple --help` prints and every refusal for that verb
    // reprints. That is still a REAL second source (the contract lives in
    // verb-contract.ts, the usage text in route-tuple.ts), so the guard keeps
    // its whole point: two independently-maintained statements of one fact,
    // compared from both directions, never a third hand-copied string here.
    const catalogCode = await mainAsync(['route-tuple', '--help']);
    expect(catalogCode).toBe(0);
    const catalogFragment = titleFlagFragment(stdoutBuf);

    stderrBuf = ''; // the same global stderr spy captures the next call too
    const verbCode = await runRouteTuple([], {});
    expect(verbCode).toBe(2);
    const verbFragment = titleFlagFragment(stderrBuf);

    // Two directions, not one opaque equality: each fragment must contain the
    // other, which together are exactly as strong as equality and fail
    // independently readably depending on which side actually drifted.
    expect(catalogFragment, 'the contract no longer contains the verb\'s own wording').toContain(verbFragment);
    expect(verbFragment, 'the verb\'s usage text no longer contains the contract\'s own wording').toContain(catalogFragment);
  });
});

// ─── Form 2: legacy positional  <path>  ──────────────────────────────────────

describe('legacy positional form  <path>', () => {
  it('exits with code 0 (PASS) for a valid issue', () => {
    const code = main([issueFile]);
    expect(code).toBe(0);
  });

  it('writes PASS to stdout', () => {
    main([issueFile]);
    expect(stdoutBuf).toMatch(/^PASS/m);
  });

  it('writes nothing to stderr', () => {
    main([issueFile]);
    expect(stderrBuf).toBe('');
  });

  it('does NOT emit a false FAIL block for the path token', () => {
    // The regression: the old code treated the path as the subcommand token
    // and produced "FAIL  .../dor" before the real result.
    // There must be exactly one PASS block and zero FAIL blocks.
    main([issueFile]);
    expect(stdoutBuf).not.toMatch(/^FAIL/m);
  });

  it('exits with code 1 for a non-existent path', () => {
    const code = main([join(root, 'no-such-file.md')]);
    expect(code).toBe(1);
  });

  it('FAIL output for a non-existent path contains ENOENT', () => {
    main([join(root, 'no-such-file.md')]);
    expect(stdoutBuf).toMatch(/ENOENT/);
  });
});

// ─── Form 3: explicit subcommand  dor <path>  ────────────────────────────────

describe('explicit dor subcommand form  dor <path>', () => {
  it('exits with code 0 (PASS) for a valid issue', () => {
    const code = main(['dor', issueFile]);
    expect(code).toBe(0);
  });

  it('writes PASS to stdout', () => {
    main(['dor', issueFile]);
    expect(stdoutBuf).toMatch(/^PASS/m);
  });

  it('writes nothing to stderr', () => {
    main(['dor', issueFile]);
    expect(stderrBuf).toBe('');
  });

  it('does NOT emit a false FAIL .../dor block before the real result', () => {
    // The core bug fix: "dor" must not be treated as a file path.
    main(['dor', issueFile]);
    expect(stdoutBuf).not.toMatch(/FAIL\s+.*[/\\]dor/);
  });

  it('output is identical in shape to the legacy positional form', () => {
    const legacyCode = main([issueFile]);
    const legacyOut = stdoutBuf;
    stdoutBuf = '';

    const dorCode = main(['dor', issueFile]);
    const dorOut = stdoutBuf;

    expect(dorCode).toBe(legacyCode);
    // Both must PASS and show identical gate structure (path may differ — compare
    // everything after the first line which contains the absolute path).
    const legacyLines = legacyOut.split('\n').slice(1);
    const dorLines = dorOut.split('\n').slice(1);
    expect(dorLines).toEqual(legacyLines);
  });

  it('exits 2 and shows usage when dor is given with no path following', () => {
    const code = main(['dor']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/usage/i);
  });
});

// ─── Form 4: unknown subcommand  ─────────────────────────────────────────────

describe('unknown subcommand invocation', () => {
  it('exits with code 2', () => {
    const code = main(['unknown-token', issueFile]);
    expect(code).toBe(2);
  });

  it('writes an error to stderr containing "unknown subcommand: unknown-token"', () => {
    main(['unknown-token', issueFile]);
    expect(stderrBuf).toMatch(/unknown subcommand: unknown-token/);
  });

  it('error message suggests "dor" as an available subcommand', () => {
    main(['unknown-token', issueFile]);
    expect(stderrBuf).toMatch(/dor/);
  });

  it('writes nothing to stdout', () => {
    main(['unknown-token', issueFile]);
    expect(stdoutBuf).toBe('');
  });

  it('treats a path-like first arg (contains slash) as a legacy positional, not an unknown subcommand', () => {
    // A relative path like "./foo.md" or "../bar.md" must NOT trigger
    // "unknown subcommand" even if the file doesn't exist.
    const code = main([join(root, 'no-such.md')]);
    // exit 1 because the file doesn't exist, NOT exit 2 (unknown subcommand)
    expect(code).toBe(1);
    expect(stderrBuf).toBe('');
    expect(stdoutBuf).toMatch(/ENOENT/);
  });
});

// ─── issue #650 — the unknown-subcommand path lists every verb, one per line ──
//
// Convention 11 falsification for this block: comment out the `'available
// subcommands:'` block in cli.ts's unknown-subcommand branch (leaving only
// the pre-existing single `unknown subcommand: ...; available: a, b, c` line)
// and this test fails — the per-verb search below finds zero `  <verb>  `
// lines for every registered verb. Restoring the block makes it pass again.
// See this row's report for the observed failing output.

describe('unknown subcommand — full verb list with one-line purposes (issue #650)', () => {
  it('every known subcommand appears exactly once, each on its own line with a one-line purpose, and exit code 2 is unchanged', () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);

    // Ground truth roster: parsed off the PRE-EXISTING `unknown subcommand:
    // ...; available: a, b, c` line itself — never a second, hand-typed
    // roster in this spec that could drift from KNOWN_SUBCOMMANDS.
    const summaryLine = stderrBuf.split('\n').find((l) => l.includes('available:'));
    expect(summaryLine, 'the pre-existing summary line must survive byte-for-byte').toBeDefined();
    const verbs = summaryLine!
      .slice(summaryLine!.indexOf('available:') + 'available:'.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(verbs.length).toBeGreaterThan(20); // sanity: this is the real, long roster

    const lines = stderrBuf.split('\n');
    for (const verb of verbs) {
      const matches = lines.filter((l) => new RegExp(`^ {2}${verb} {2}\\S`).test(l));
      expect(matches, `expected exactly one purpose line for verb "${verb}"`).toHaveLength(1);
    }
  });

  it('a known subcommand routes normally — the new list never fires on a real verb', () => {
    main(['dor']); // no path following → dor's own (pre-existing) usage dump, exit 2, NOT the unknown-verb path
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });
});

// ─── issue #680 — the compose-driver verb is wired into the router ───────────
//
// The verb roster itself is self-pinning (the block above derives its ground
// truth from the printed `available:` line), so what needs its own assertions
// here is the ROUTING: compose-driver resolves a store — it re-reads every
// dispatchable row through `read`/`triage-read` at every compose — so it must
// be intercepted by `mainAsync` before the sync router, exactly as
// `issue-store` / `host-pr` / `store-preflight` are. A verb added to
// KNOWN_SUBCOMMANDS but NOT intercepted would reach the sync `case`, which is
// why that case exists and prints the "invoke it via mainAsync" refusal rather
// than silently returning nothing.
//
// Convention 11 falsification for this block: deleting the
// `if (argv[0] === 'compose-driver')` interception from `mainAsync` makes the
// first test below fail with the sync router's "compose-driver is async" line
// on stderr instead of the runner's own usage. See this row's report for the
// observed failing output.

describe('compose-driver — router wiring (issue #680)', () => {
  it('is on the verb roster, so it never reaches the unknown-subcommand path', () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);
    const summaryLine = stderrBuf.split('\n').find((l) => l.includes('available:'))!;
    expect(summaryLine).toContain('compose-driver');
    // …and its purpose line rides along, one per verb.
    expect(stderrBuf).toMatch(/^ {2}compose-driver {2}\S/m);
  });

  it('mainAsync intercepts it BEFORE the sync router — the answer is the RUNNER\'s own usage, not the router\'s whole-CLI dump', async () => {
    const code = await mainAsync(['compose-driver']);
    expect(code).toBe(2);
    // The discriminator has to be a line only the RUNNER can print. A bare
    // `compose-driver` reaching the sync router instead hits its zero-arg guard,
    // which dumps the whole-CLI usage — and that dump also names --spine/--out/
    // --anchor (the verb's own usage line lives in it), so asserting those flags
    // alone is a check that cannot fail. Observed live while falsifying this
    // block: with the interception deleted, the flag-only assertions stayed
    // green. The runner's first line is what tells the two apart.
    expect(stderrBuf.split('\n')[0]).toBe('error: compose-driver requires --spine <spine>');
    expect(stderrBuf).toMatch(/--out/);
    expect(stderrBuf).toMatch(/--anchor/);
    // …and neither the sync router's async refusal nor its whole-CLI dump answered.
    expect(stderrBuf).not.toMatch(/invoke it via the async entrypoint/);
    expect(stderrBuf).not.toMatch(/available subcommands:/);
  });

  it('the sync main() refuses it the way it refuses every other async verb', () => {
    const code = main(['compose-driver', '--spine', 'x']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/compose-driver is async/);
    expect(stderrBuf).toMatch(/mainAsync/);
  });

  it('the top-level usage names the verb and its required flags', () => {
    main([]); // zero args → printUsage()
    const usageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine compose-driver'))!;
    expect(usageLine).toBeDefined();
    expect(usageLine).toContain('--spine');
    expect(usageLine).toContain('--out');
    expect(usageLine).toContain('--anchor');
  });
});

// ─── issue #681 — the route-tuple verb is wired into the router ──────────────
//
// Same shape as the compose-driver block directly above, and for the same
// reason: the roster is self-pinning, so what needs its own assertions is the
// ROUTING. `route-tuple` is async twice over — it does host I/O AND resolves a
// store — so it must be intercepted by `mainAsync` before the sync router.
//
// Convention 11 falsification for this block: deleting the
// `if (argv[0] === 'route-tuple')` interception from `mainAsync` makes the
// SECOND test below fail. The discriminator is deliberately the runner's OWN
// first usage line, and it had to be: the sync router's zero-arg guard prints
// the whole-CLI usage dump, which ALSO names --spine/--id/--iter (the verb's
// own usage line lives in it), so asserting those flag names alone is a check
// that cannot fail. The observed failing output is recorded in this row's
// report.
describe('route-tuple — router wiring (issue #681)', () => {
  it('is on the verb roster, so it never reaches the unknown-subcommand path', () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);
    const summaryLine = stderrBuf.split('\n').find((l) => l.includes('available:'))!;
    expect(summaryLine).toContain('route-tuple');
    // …and its purpose line rides along, one per verb.
    expect(stderrBuf).toMatch(/^ {2}route-tuple {2}\S/m);
  });

  it("mainAsync intercepts it BEFORE the sync router — the answer is the RUNNER's own usage, not the router's whole-CLI dump", async () => {
    const code = await mainAsync(['route-tuple']);
    expect(code).toBe(2);
    // Only the RUNNER can print this line, and it is the first thing it prints.
    expect(stderrBuf.split('\n')[0]).toBe('error: route-tuple requires --spine <spine>');
    expect(stderrBuf).toMatch(/--report/);
    expect(stderrBuf).toMatch(/--verdict/);
    // …and neither the sync router's async refusal nor its whole-CLI dump answered.
    expect(stderrBuf).not.toMatch(/invoke it via the async entrypoint/);
    expect(stderrBuf).not.toMatch(/available subcommands:/);
  });

  it('the sync main() refuses it the way it refuses every other async verb', () => {
    const code = main(['route-tuple', '--spine', 'x']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/route-tuple is async/);
    expect(stderrBuf).toMatch(/mainAsync/);
  });

  it('the top-level usage names the verb and its required flags', () => {
    main([]); // zero args → printUsage()
    const usageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine route-tuple'))!;
    expect(usageLine).toBeDefined();
    for (const f of ['--spine', '--id', '--iter', '--report', '--verdict', '--anchor']) {
      expect(usageLine).toContain(f);
    }
  });
});

// ─── issue #684 — the Operator-ruled round is nameable from the CLI ──────────
//
// The flag is the documented exit of a cap-exhaustion STOP, so a Coordinator has
// to be able to FIND it: the usage that answers a misinvocation names it on both
// verbs that accept it, and the per-verb purpose line says what it is for. The
// adapter's and the runners' own specs own the behaviour; what is pinned here is
// only that the flag is discoverable from the surface a stranger reaches first.
describe('route-verdict --ruling — the flag is named on the CLI surface (issue #684)', () => {
  it('the route-verdict usage line names the flag, and drops the old <1|2> iteration bound', () => {
    main([]); // zero args → printUsage()
    const usageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine route-verdict'))!;
    expect(usageLine).toBeDefined();
    expect(usageLine).toContain('--ruling <text>');
    // The bound moved from the flag's own spelling into the adapter, where the
    // ruling can lift it; advertising `<1|2>` would now be a lie in the one
    // place a Coordinator looks first.
    expect(usageLine).not.toContain('<1|2>');
  });

  it('the route-tuple usage line names it too — the ruled round reaches the whole-tuple path', () => {
    main([]);
    const usageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine route-tuple'))!;
    expect(usageLine).toContain('--ruling <text>');
  });

  it("the verb's purpose line says what the flag admits, on the unknown-subcommand path", () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);
    const purposeLine = stderrBuf.split('\n').find((l) => /^ {2}route-verdict {2}\S/.test(l))!;
    expect(purposeLine).toBeDefined();
    expect(purposeLine).toContain('--ruling');
    expect(purposeLine).toMatch(/above the re-dispatch cap/);
  });
});

// ─── Form 5: files-drift subcommand ──────────────────────────────────────────
//
// Integration tests for `runFilesDrift` reached via `main(['files-drift', ...])`.
// They exercise the full path through cli.ts including:
//   - KNOWN_SUBCOMMANDS routing (files-drift is recognised, not treated as unknown)
//   - missing-args guard (exits 2 + usage when fewer than 2 args follow)
//   - exit-code switch: 0 (clean), 1 (same-project-drift), 2 (cross-project-drift)
//   - stdout JSON contains the correct `status` field
//
// `execFileSync` (imported from node:child_process) is mocked at module-scope
// above so that getChangedFilesFromGit returns a controlled file list without
// spawning a real git process. Each test configures the mock via
// `vi.mocked(execFileSync).mockReturnValue(...)` before calling main().
//
// The issue fixture used here is the same one set up in beforeAll() above:
// it declares `Files: some/file.ts`, giving project scope `some`.

describe('files-drift subcommand — missing-args guard', () => {
  it('exits with code 2 when no arguments follow "files-drift"', () => {
    const code = main(['files-drift']);
    expect(code).toBe(2);
  });

  it('writes a usage line to stderr', () => {
    main(['files-drift']);
    expect(stderrBuf).toMatch(/usage/i);
  });

  it('mentions the required arguments in the usage line', () => {
    main(['files-drift']);
    expect(stderrBuf).toMatch(/issue-path/i);
    expect(stderrBuf).toMatch(/sha-range/i);
  });

  it('writes nothing to stdout', () => {
    main(['files-drift']);
    expect(stdoutBuf).toBe('');
  });

  it('exits with code 2 when only one argument follows "files-drift" (missing sha-range)', () => {
    const code = main(['files-drift', issueFile]);
    expect(code).toBe(2);
  });

  it('writes a usage line to stderr when sha-range is missing', () => {
    main(['files-drift', issueFile]);
    expect(stderrBuf).toMatch(/usage/i);
  });
});

describe('files-drift subcommand — happy-path: clean (exit 0)', () => {
  beforeEach(() => {
    // All changed files are declared in the issue fixture (Files: some/file.ts).
    // getChangedFilesFromGit returns them via the execFileSync mock.
    vi.mocked(execFileSync).mockReturnValue('some/file.ts\n');
  });

  it('exits with code 0 for a clean commit range', () => {
    const code = main(['files-drift', issueFile, 'abc..def']);
    expect(code).toBe(0);
  });

  it('writes the clean status indicator to stdout', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stdoutBuf).toMatch(/clean/);
  });

  it('stdout JSON contains status: clean', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as { status: string };
    expect(parsed.status).toBe('clean');
  });

  it('stdout JSON driftedFiles is empty for a clean range', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      driftedFiles: string[];
    };
    expect(parsed.driftedFiles).toEqual([]);
  });

  it('writes nothing to stderr for a clean range', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stderrBuf).toBe('');
  });
});

describe('files-drift subcommand — same-project-drift (exit 1)', () => {
  beforeEach(() => {
    // Issue declares `Files: some/file.ts` → scope is `some`.
    // Changed files include an undeclared file inside the same scope.
    vi.mocked(execFileSync).mockReturnValue(
      'some/file.ts\nsome/extra-file.ts\n',
    );
  });

  it('exits with code 1 for same-project-drift', () => {
    const code = main(['files-drift', issueFile, 'abc..def']);
    expect(code).toBe(1);
  });

  it('stdout JSON contains status: same-project-drift', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as { status: string };
    expect(parsed.status).toBe('same-project-drift');
  });

  it('stdout JSON driftedFiles contains the undeclared in-scope file', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      driftedFiles: string[];
    };
    expect(parsed.driftedFiles).toContain('some/extra-file.ts');
  });

  it('stdout contains the advisory indicator', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stdoutBuf).toMatch(/same-project-drift/);
    expect(stdoutBuf).toMatch(/advisory/i);
  });

  it('writes nothing to stderr', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stderrBuf).toBe('');
  });
});

describe('files-drift subcommand — cross-project-drift (exit 2)', () => {
  beforeEach(() => {
    // Issue declares `Files: some/file.ts` → scope is `some`.
    // Changed files include a file in a completely different project scope.
    vi.mocked(execFileSync).mockReturnValue(
      'some/file.ts\nother-project/unrelated.ts\n',
    );
  });

  it('exits with code 2 for cross-project-drift', () => {
    const code = main(['files-drift', issueFile, 'abc..def']);
    expect(code).toBe(2);
  });

  it('stdout JSON contains status: cross-project-drift', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as { status: string };
    expect(parsed.status).toBe('cross-project-drift');
  });

  it('stdout JSON driftedFiles contains the cross-project file', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      driftedFiles: string[];
    };
    expect(parsed.driftedFiles).toContain('other-project/unrelated.ts');
  });

  it('stdout contains the blocking indicator', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stdoutBuf).toMatch(/cross-project-drift/);
    expect(stdoutBuf).toMatch(/blocking/i);
  });

  it('writes nothing to stderr', () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stderrBuf).toBe('');
  });
});

describe('files-drift subcommand — KNOWN_SUBCOMMANDS routing sanity', () => {
  it('routes "files-drift" via KNOWN_SUBCOMMANDS, NOT as an unknown subcommand', () => {
    // Confirm that "files-drift" is recognised as a known subcommand:
    // missing-args guard (exit 2) is triggered, NOT the unknown-subcommand
    // handler. The difference: missing-args guard writes to stderr as an error;
    // the unknown-subcommand handler writes "unknown subcommand: files-drift".
    main(['files-drift']);
    expect(stderrBuf).not.toMatch(/unknown subcommand: files-drift/);
  });

  it('does NOT route "files-drift" through the dor subcommand', () => {
    // Calling files-drift with missing args must not produce a DOR PASS/FAIL
    // output (which would indicate it was routed to runDor instead).
    main(['files-drift']);
    expect(stdoutBuf).not.toMatch(/^PASS/m);
    expect(stdoutBuf).not.toMatch(/^FAIL/m);
  });

  it('"unknown-subcommand" is still NOT routed to files-drift', () => {
    // The KNOWN_SUBCOMMANDS switch must NOT match arbitrary tokens.
    const code = main(['unknown-subcommand', issueFile]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/unknown subcommand: unknown-subcommand/);
  });
});

// ─── Form 6: merge-order subcommand ──────────────────────────────────────────
//
// Integration tests for `runMergeOrder` reached via `main(['merge-order', ...])`.
// They exercise:
//   - KNOWN_SUBCOMMANDS routing (merge-order recognised, not "unknown")
//   - missing-arg guard (exits 2 + usage when no path follows)
//   - unreadable-spine guard (exits 2)
//   - no-footnotes spine (exits 1 — nothing to order)
//   - happy-path: exits 0, stdout JSON has algorithmic[] + override + reason
//
// `execFileSync` is mocked at module scope (returns '') so defaultGitProbe
// resolves every branch to null → no override, fully hermetic (no real
// wave-orch/* branches needed). The algorithmic order is a pure fileCount sort.

describe('merge-order subcommand — missing-arg guard', () => {
  it('exits with code 2 when no path follows "merge-order"', () => {
    const code = main(['merge-order']);
    expect(code).toBe(2);
  });

  it('writes a usage line mentioning wave-md-path to stderr', () => {
    main(['merge-order']);
    expect(stderrBuf).toMatch(/usage/i);
    expect(stderrBuf).toMatch(/wave-md-path/i);
  });

  it('writes nothing to stdout', () => {
    main(['merge-order']);
    expect(stdoutBuf).toBe('');
  });
});

describe('merge-order subcommand — unreadable spine', () => {
  it('exits with code 2 for a non-existent wave file', () => {
    const code = main(['merge-order', join(root, 'no-such-wave.md')]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/could not read wave file/i);
  });
});

describe('merge-order subcommand — spine with no source footnotes and no Plan-Table rows', () => {
  it('exits with code 0 and returns an empty advisory order (Empty wave reason)', () => {
    // After the re-route to computeMergeOrderFromSpine the hard "no issues found"
    // exit-1 path is gone. An empty spine yields an empty MergeOrderResult (exit 0)
    // with an "Empty wave" reason, matching the library's orderPrs([]) contract.
    const code = main(['merge-order', emptySpineFile]);
    expect(code).toBe(0);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      algorithmic: unknown[];
      reason: string;
    };
    expect(parsed.algorithmic).toEqual([]);
    expect(parsed.reason).toMatch(/empty wave/i);
  });
});

describe('merge-order subcommand — GitHub spine (no .scratch/ files, ADR-0019)', () => {
  // This is the CRITICAL guard: on a GitHub wave there are no .scratch/ issue
  // files on disk. Before the computeMergeOrderFromSpine re-route, runMergeOrder
  // would hard-fail with exit 1 "no issues found in spine" — breaking wave-close's
  // `merge-order` shell-out on every real GitHub wave. After the fix the CLI must
  // return exit 0 with a NON-empty algorithmic order built from the Plan-Table.
  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('');
  });

  it('exits with code 0 for a GitHub-shaped spine (bare-number ids, no .scratch/ tree)', () => {
    const code = main(['merge-order', githubSpineFile]);
    expect(code).toBe(0);
  });

  it('stdout JSON has a non-empty algorithmic array sourced from the Plan-Table', () => {
    main(['merge-order', githubSpineFile]);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      algorithmic: Array<{ issueId: string }>;
    };
    // Both Plan-Table rows must appear — order is conflict-footprint-based.
    expect(parsed.algorithmic).toHaveLength(2);
    const ids = parsed.algorithmic.map((p) => p.issueId);
    expect(ids).toContain('7');
    expect(ids).toContain('9');
  });

  it('reason mentions the Conflict-Map overlap (proof that buildSpinePrs wired the conflict map)', () => {
    main(['merge-order', githubSpineFile]);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as { reason: string };
    // The reason must describe the conflict relationship — not "Empty wave".
    expect(parsed.reason).not.toMatch(/empty wave/i);
  });

  it('writes nothing to stderr on the GitHub-spine happy path', () => {
    main(['merge-order', githubSpineFile]);
    expect(stderrBuf).toBe('');
  });
});

// Issue #636: a `parked` Plan-Table row (ADR-0022 — a claim-releasing
// terminal, deliberately taken out of THIS wave) must never ride into
// `algorithmic` as a branch-null "in play" entry, and must never produce the
// "no branch could be recovered from the spine" warning — it has no
// dispatch-log entry by design. It belongs in the same `notInPlay` bucket the
// CLI already renders for never-dispatched rows.
describe('merge-order subcommand — a parked row in the rendered JSON (issue #636)', () => {
  let parkedRoot: string;
  let parkedSpineFile: string;

  beforeAll(() => {
    parkedRoot = mkdtempSync(join(tmpdir(), 'wave-cli-parked-'));
    parkedSpineFile = join(parkedRoot, 'parked-wave.md');
    writeFileSync(
      parkedSpineFile,
      [
        '# Wave with a parked row',
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 10 | Dispatched row | background | mechanical | universal | — | dispatched | 1 | — |',
        '| 11 | Held before dispatch | background | mechanical | universal | — | parked | — | — |',
        '',
        '## Conflict-Map',
        '',
        'none',
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        '  - "10 → agent wf_aaa branch wave/10-dispatched-row"',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(parkedRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('');
  });

  it('the parked row is in notInPlay, never in algorithmic, and warnings stays empty', () => {
    const code = main(['merge-order', parkedSpineFile]);
    expect(code).toBe(0);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      algorithmic: Array<{ issueId: string }>;
      notInPlay: Array<{ issueId: string }>;
      warnings: string[];
    };
    expect(parsed.algorithmic.map((p) => p.issueId)).toEqual(['10']);
    expect(parsed.notInPlay.map((p) => p.issueId)).toEqual(['11']);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('merge-order subcommand — happy path (exit 0)', () => {
  beforeEach(() => {
    // Reset the shared node:child_process mock so defaultGitProbe sees empty
    // git output → resolves no branches → no stacked subgraph. (The files-drift
    // describes above leave a `mockReturnValue('some/file.ts\n')` on the same
    // module-level mock; without this reset that value would leak in here and
    // fabricate a self-ancestor stack.)
    vi.mocked(execFileSync).mockReturnValue('');
  });

  it('exits with code 0 for a valid spine', () => {
    const code = main(['merge-order', spineFile]);
    expect(code).toBe(0);
  });

  it('stdout JSON has an algorithmic array of the two issues', () => {
    main(['merge-order', spineFile]);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      algorithmic: Array<{ issueId: string; fileCount: number }>;
    };
    expect(parsed.algorithmic).toHaveLength(2);
    // fewer-files-first: tf#03 (1 file) before tf#02 (2 files).
    expect(parsed.algorithmic.map((p) => p.issueId)).toEqual([
      'test-feature#03',
      'test-feature#02',
    ]);
  });

  it('override is null (mocked git → no branches resolved → no stack)', () => {
    main(['merge-order', spineFile]);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      override: unknown;
      hasOverride: boolean;
    };
    expect(parsed.override).toBeNull();
    expect(parsed.hasOverride).toBe(false);
  });

  it('reason mentions the Conflict-Map overlap parsed from the spine', () => {
    main(['merge-order', spineFile]);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as { reason: string };
    expect(parsed.reason).toMatch(/some\/shared\.ts/);
  });

  it('writes nothing to stderr on the happy path', () => {
    main(['merge-order', spineFile]);
    expect(stderrBuf).toBe('');
  });
});

// Regression for the cli.ts runMergeOrder bug: it destructured only
// { issuePaths, conflictMap } from parseWaveSpine and dropped branchesByIssueId,
// so the spine-declared exact branches never reached computeMergeOrder and it
// fell back to the NN-glob git probe — reintroducing the same-NN-stale-branch
// (§L3) defect computeMergeOrderFromSpine was built to fix. With git mocked to
// resolve nothing, a non-null branch in the output can ONLY come from the spine.
describe('merge-order subcommand — spine-declared branches are threaded (§L3 regression)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('');
  });

  it('emits the exact dispatch-log branch for each issue (not the null NN-glob fallback)', () => {
    const code = main(['merge-order', stackedSpineFile]);
    expect(code).toBe(0);
    const jsonMatch = stdoutBuf.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch?.[0] ?? '{}') as {
      algorithmic: Array<{ issueId: string; branch: string | null }>;
    };
    const branches = parsed.algorithmic.map((p) => p.branch);
    expect(branches).toContain('wave-orch/02-second-issue');
    expect(branches).toContain('wave-orch/03-third-issue');
    // Both issues had a spine branch → none may fall back to the null git probe.
    expect(branches.every((b) => b !== null)).toBe(true);
  });
});

describe('merge-order subcommand — KNOWN_SUBCOMMANDS routing sanity', () => {
  it('routes "merge-order" via KNOWN_SUBCOMMANDS, NOT as an unknown subcommand', () => {
    main(['merge-order']);
    expect(stderrBuf).not.toMatch(/unknown subcommand: merge-order/);
  });

  it('does NOT route "merge-order" through the dor subcommand', () => {
    main(['merge-order']);
    expect(stdoutBuf).not.toMatch(/^PASS/m);
    expect(stdoutBuf).not.toMatch(/^FAIL/m);
  });
});

// FOR-48: a repo with NO `.scratch/` ancestor ANYWHERE (the real shape of
// every GitHub/Linear-backed wave — `.scratch/` is a MarkdownFsStore-only
// convention). Before the fix, findRepoRoot's cwd fallback unconditionally
// printed a "no .scratch/ ancestor found" warning to stderr on every such
// run. The fixture below is deliberately NOT nested under the shared `root`
// (which has a `.scratch/` child directory) — it lives in its own bare temp
// dir so no `.scratch/` ancestor exists at all.
describe('merge-order subcommand — repo without a .scratch/ ancestor (FOR-48, no legacy warning)', () => {
  let noScratchRoot: string;
  let noScratchSpineFile: string;

  beforeAll(() => {
    noScratchRoot = mkdtempSync(join(tmpdir(), 'wave-cli-no-scratch-'));
    noScratchSpineFile = join(noScratchRoot, 'github-wave.md');
    writeFileSync(
      noScratchSpineFile,
      [
        '# GitHub wave (no .scratch/ layout)',
        '',
        '**Status:** in-review',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 7 | Add route handler | background | mechanical | universal | — | in-review | 1 | — |',
        '',
        '## Conflict-Map',
        '',
        'none',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    rmSync(noScratchRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('');
  });

  it('exits with code 0 for a spine with no .scratch/ ancestor anywhere', () => {
    const code = main(['merge-order', noScratchSpineFile]);
    expect(code).toBe(0);
  });

  it('prints NO legacy .scratch/ ancestor warning on stderr', () => {
    main(['merge-order', noScratchSpineFile]);
    expect(stderrBuf).not.toMatch(/no \.scratch\/ ancestor found/);
    expect(stderrBuf).toBe('');
  });

  it('still resolves the correct consumer root (process.cwd(), silently) via findRepoRoot', () => {
    expect(findRepoRoot(noScratchSpineFile)).toBe(process.cwd());
  });
});

// ─── Form 6: closed-by subcommand (wo/59) ────────────────────────────────────
//
// Thin router to closed-by.ts (#55). The CLI adds no classification logic of
// its own — these tests confirm the routing + the exit-code = needsPin mirror,
// not the classifier's correctness (that is closed-by.spec.ts's job).

describe('closed-by subcommand — missing-arg guard', () => {
  it('exits with code 2 when no argument follows "closed-by"', () => {
    const code = main(['closed-by']);
    expect(code).toBe(2);
  });

  it('writes a usage line to stderr', () => {
    main(['closed-by']);
    expect(stderrBuf).toMatch(/usage/i);
  });
});

describe('closed-by subcommand — classification + exit code', () => {
  it('exits 1 (needsPin) for a Bitbucket pre-fill URL', () => {
    const code = main([
      'closed-by',
      '**Closed-by:** https://bitbucket.org/ws/repo/pull-requests/new?source=wave-orch/59-x&t=1',
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as {
      class: string;
      needsPin: boolean;
    };
    expect(parsed.class).toBe('pre-fill');
    expect(parsed.needsPin).toBe(true);
  });

  it('exits 1 (needsPin) for a <PR-URL pending> placeholder', () => {
    const code = main(['closed-by', '**Closed-by:** <PR-URL pending>']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as { class: string };
    expect(parsed.class).toBe('placeholder');
  });

  it('exits 0 (already finalised) for a real Bitbucket PR URL', () => {
    const code = main([
      'closed-by',
      '**Closed-by:** https://bitbucket.org/ws/repo/pull-requests/61',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      class: string;
      needsPin: boolean;
    };
    expect(parsed.class).toBe('real-pr');
    expect(parsed.needsPin).toBe(false);
  });

  it('joins multi-token args into one line (so an unquoted URL+prose still classifies)', () => {
    const code = main([
      'closed-by',
      '**Closed-by:**',
      'https://github.com/o/r/pull/7',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { class: string };
    expect(parsed.class).toBe('real-pr');
  });

  it('routes "closed-by" via KNOWN_SUBCOMMANDS, not as unknown', () => {
    main(['closed-by']);
    expect(stderrBuf).not.toMatch(/unknown subcommand: closed-by/);
  });
});

// ─── Form 7: detect-host subcommand (wo/59) ──────────────────────────────────
//
// Thin router to host-pr.ts detectHost (#56). Pure URL parse, no network.

describe('detect-host subcommand — missing-arg guard', () => {
  it('exits with code 2 when no argument follows "detect-host"', () => {
    const code = main(['detect-host']);
    expect(code).toBe(2);
  });

  it('writes a usage line to stderr', () => {
    main(['detect-host']);
    expect(stderrBuf).toMatch(/usage/i);
  });
});

describe('detect-host subcommand — host parsing + exit code', () => {
  it('exits 0 and reports bitbucket for a Bitbucket SSH remote', () => {
    const code = main([
      'detect-host',
      'git@bitbucket.org:example-workspace/nx-ui-angular-lib.git',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      host: string;
      workspace: string;
      repo: string;
    };
    expect(parsed.host).toBe('bitbucket');
    expect(parsed.workspace).toBe('example-workspace');
    expect(parsed.repo).toBe('nx-ui-angular-lib');
  });

  it('exits 0 and reports github for a GitHub HTTPS remote', () => {
    const code = main(['detect-host', 'https://github.com/owner/repo.git']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { host: string };
    expect(parsed.host).toBe('github');
  });

  it('exits 1 for an unknown host', () => {
    const code = main(['detect-host', 'https://gitlab.example.com/o/r.git']);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as { host: string };
    expect(parsed.host).toBe('unknown');
  });
});

// ─── Form 8: worktree-cleanup subcommand (wo/59, no-args guard FOR-34) ───────
//
// Thin router to worktree-cleanup.ts (#57). The module-level node:child_process
// mock returns '' for execFileSync, so `git worktree list --porcelain` yields no
// worktrees → empty plan → nothing-to-do. This exercises the idempotent
// "already clean" path (Phase 5 re-run) without touching real worktrees.
//
// FOR-34 (W5-F4a): a bare `worktree-cleanup` used to run a REAL full cleanup
// against cwd — the one CLI op capable of destructive action that silently
// accepted zero arguments, unlike every other subcommand. It now requires an
// explicit target (repo-root, --wave, or --branches); `--dry-run` alone is
// still accepted since it performs no removal.

describe('worktree-cleanup subcommand — bare invocation requires an explicit target (FOR-34)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  it('main(["worktree-cleanup"]) with zero args prints usage and exits 2 — does NOT run a real cleanup', () => {
    const code = main(['worktree-cleanup']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/usage:/);
  });

  it('never shells out to git when invoked bare — the usage guard fires before any listing/removal', () => {
    // Local clear (no global mock reset in this file — prior describe blocks'
    // calls would otherwise make this assertion meaningless).
    vi.mocked(execFileSync).mockClear();
    main(['worktree-cleanup']);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('emits no JSON result on the bare-invocation usage path (stdout stays empty)', () => {
    main(['worktree-cleanup']);
    expect(stdoutBuf).toBe('');
  });

  it('still routes "worktree-cleanup" via KNOWN_SUBCOMMANDS, not as an unknown subcommand', () => {
    main(['worktree-cleanup']);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });
});

describe('worktree-cleanup subcommand — explicit-arg behavior is unchanged (FOR-34)', () => {
  beforeEach(() => {
    // Empty `git worktree list --porcelain` → no agent worktrees parsed.
    // (Reset via mockImplementation — cast-free, so this adds no new typecheck
    // error; the prior describes leave a `some/file.ts` return value on the
    // shared module-level mock that would otherwise leak in here.)
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  it('an explicit repo-root positional target still runs a real (non-dry-run) cleanup and exits 0', () => {
    const code = main(['worktree-cleanup', root]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      removed: unknown[];
      skipped: unknown[];
      errors: unknown[];
    };
    expect(parsed.dryRun).toBe(false);
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it('--dry-run ALONE (no repo-root/--wave/--branches) is still accepted — it performs no removal', () => {
    const code = main(['worktree-cleanup', '--dry-run']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      selected: unknown[];
      skipped: unknown[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.selected).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it('--dry-run with an explicit repo-root reports the plan (selected/skipped) and writes nothing destructive', () => {
    const code = main(['worktree-cleanup', '--dry-run', root]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      selected: unknown[];
      skipped: unknown[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.selected).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });
});

/**
 * A minimal, valid `wave.config.json` — a bare `store` block, no `cleanup`
 * key. `loadWaveConfig` requires a well-formed `store`; the tests in the two
 * blocks below care only that a config file's VALUE never binds as the
 * <repo-root> positional, so they load real (but cleanup-empty) files rather
 * than the pre-fix phantom paths that a purely discard-and-ignore `--config`
 * used to tolerate.
 */
function writeMinimalWaveConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wave-cli-cleanup-cfg-'));
  const cfgPath = join(dir, 'wave.config.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({ store: { kind: 'markdown', repoRoot: '.', slug: 'x' } }),
    'utf-8',
  );
  return cfgPath;
}

// ─── Form 8e: worktree-cleanup — --config tolerance + fail-loud on unknown
// flags (FOR-87, W25-F2) ──────────────────────────────────────────────────────
//
// Live finding from the hardening-vendor wave close: worktree-cleanup was the
// only store-adjacent CLI verb that did NOT tolerate a uniformly-appended
// `--config <path>` (the Coordinator wrapper's documented pattern for every
// sibling verb). Because `--config` wasn't in the flag vocabulary, its own
// token was silently dropped but its VALUE fell through to `positional` —
// binding as the <repo-root> positional and producing a confusing ENOTDIR on
// a concatenated phantom path once something joined it with a further
// relative path. `--config <path>` must now be accepted, and any OTHER
// unknown `--flag` must still fail loud (exit 2, naming the flag) instead of
// silently becoming data.
//
// `--config`'s value is no longer merely tolerated-and-discarded (issue
// #184): it is now actually loaded via `loadWaveConfig`, so every fixture
// below points at a real, readable, valid config file rather than the
// pre-fix phantom path — a nonexistent path now surfaces as a load error
// (see the dedicated describe block further down), which is the point of
// this fix, not a regression in these four.
describe('worktree-cleanup subcommand — --config is accepted and LOADED (FOR-87 / issue #184)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  it('a trailing --config <path> after an explicit repo-root does not shift into the <repo-root> positional', () => {
    const code = main(['worktree-cleanup', root, '--config', writeMinimalWaveConfig()]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      removed: unknown[];
      skipped: unknown[];
      errors: unknown[];
    };
    expect(parsed.dryRun).toBe(false);
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it('--config LEADING a bare (no positional) invocation resolves --wave against the real repo-root, not the config path (the exact ENOTDIR footgun from the retro)', () => {
    // No explicit repo-root positional here — the real-world Coordinator
    // shape this retro finding came from: `--wave <relative spine> --config
    // <path>` with the repo-root implied by cwd. Mock cwd to the fixture
    // root so a RELATIVE --wave path is meaningfully sensitive to which
    // value `repoRoot` actually resolved to.
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      const code = main([
        'worktree-cleanup',
        '--wave',
        join('.scratch', 'waves', '2026-01-03-stacked-wave.md'),
        '--config',
        writeMinimalWaveConfig(),
      ]);
      // Pre-fix, --config's value bound as <repo-root> (an absolute,
      // non-directory phantom path); resolving the RELATIVE --wave path
      // against it throws (ENOENT/ENOTDIR) and the CLI exits 2. Post-fix,
      // --config's value is a real file loaded (not bound as repoRoot),
      // repoRoot falls back to the mocked cwd (root), the relative spine
      // resolves and reads fine, and the spine's dispatch-log-declared
      // branches surface in the dry-run-free summary.
      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutBuf) as { branchFilter?: string[] };
      expect(parsed.branchFilter).toEqual(
        ['wave-orch/02-second-issue', 'wave-orch/03-third-issue'].sort(),
      );
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('--config before a --dry-run + explicit repo-root combination is tolerated identically to omitting it', () => {
    const code = main([
      'worktree-cleanup',
      '--config',
      writeMinimalWaveConfig(),
      '--dry-run',
      root,
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      selected: unknown[];
      skipped: unknown[];
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.selected).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it('--config combined with --orphans is tolerated (both flags recognized, neither becomes positional)', () => {
    const code = main([
      'worktree-cleanup',
      root,
      '--orphans',
      '--config',
      writeMinimalWaveConfig(),
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { orphans?: { selected: unknown[] } };
    expect(parsed.orphans).toBeDefined();
  });

  it('a --config pointing at an unreadable/nonexistent file now fails loud (exit 1) instead of being silently ignored', () => {
    const code = main([
      'worktree-cleanup',
      root,
      '--config',
      '/definitely/not/a/real/config/path.json',
    ]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/could not load --config/);
    expect(stdoutBuf).toBe('');
  });
});

// ─── Form 8g: worktree-cleanup — --config's cleanup.disposableNames reaches
//             the plan at ALL THREE entry points (issue #184) ────────────────
//
// The last-mile wiring gap: issue #115 made `listAgentWorktrees`,
// `listOrphanDirs`, and `executeCleanup` all ACCEPT a `disposableNames`
// option, and `loadWaveConfig` already validated `cleanup.disposableNames` at
// config-load time — but the CLI's `--config` handling discarded the value
// (see Form 8e above), so a `wave-close` run driven by `--config` could never
// make the declaration reach the plan. These specs drive the REAL
// `worktree-cleanup` CLI entry point (never the bare engine functions
// worktree-cleanup.spec.ts already covers) against a REAL git repository, with
// a REAL `--config` file on disk declaring `cleanup.disposableNames`, so the
// WIRING itself is under test — not the engine's own already-tested
// classification logic.
//
// One repo fixture exercises BOTH orphan shapes `--orphans` sweeps, so a
// single CLI invocation proves all three entry points at once:
//
//   • `orphanA` — a REGISTERED (`git worktree add`) worktree whose own `.git`
//     pointer file was then removed (the exact FOR-59 "deregistered but not
//     deleted" shape): `git worktree list --porcelain` still lists it, so it
//     is found by `listAgentWorktrees`'s `parseWorktreeList` and classified
//     via its filesystem-scan `orphanAllJunk` branch — proving
//     `listAgentWorktrees` AND (via the real, non-dry-run removal)
//     `executeCleanup` both honour the threaded declaration.
//   • `orphanB` — a plain directory under the SAME recognized `wf_` prefix
//     that was NEVER passed through `git worktree add` at all: `git worktree
//     list --porcelain` never mentions it, so it is found ONLY by
//     `listOrphanDirs` (the `--orphans` sweep) — proving that entry point
//     independently.
//
// Both hold ONLY a `.build/` tree (Swift build output — the exact issue #115
// live shape) — junk `orphanA`/`orphanB` are not, without the declaration.
describe('worktree-cleanup subcommand — --config cleanup.disposableNames reaches listAgentWorktrees, listOrphanDirs, and executeCleanup (issue #184)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** A `wave.config.json` declaring `cleanup.disposableNames` (issue #115/#184). */
  function writeCleanupConfig(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'wave-cli-184-cfg-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot: '.', slug: 'x' },
        cleanup: { disposableNames: names },
      }),
      'utf-8',
    );
    return cfgPath;
  }

  /** The exact issue #115 leftover shape: built-in junk plus a Swift `.build/` tree. */
  function makeSwiftLeftover(dir: string): void {
    mkdirSync(join(dir, '.build', 'arm64-apple-macosx', 'debug'), { recursive: true });
    writeFileSync(
      join(dir, '.build', 'arm64-apple-macosx', 'debug', 'Package.o'),
      'object-code',
      'utf-8',
    );
    writeFileSync(join(dir, '.build', 'manifest.db'), 'build-manifest', 'utf-8');
  }

  /**
   * A real repo with:
   *   - `orphanA`: a real `git worktree add`-ed worktree, still LISTED by git
   *     (its own `.git` pointer file removed — the FOR-59 fixture shape),
   *     holding only a `.build/` tree.
   *   - `orphanB`: a plain, never-registered directory under the same
   *     recognized `wf_` prefix, holding only a `.build/` tree.
   */
  function makeRepoWithBothOrphanShapes(): {
    mainRoot: string;
    orphanA: string;
    orphanB: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wave-cli-184-repo-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });

    const orphanARel = join('.claude', 'worktrees', 'wf_184-orphan-a');
    realGit(['worktree', 'add', '-q', orphanARel, '-b', 'wave/184-orphan-a'], mainRoot);
    const orphanA = join(mainRoot, orphanARel);
    rmSync(join(orphanA, '.git'), { force: true });
    makeSwiftLeftover(orphanA);

    const orphanB = join(mainRoot, '.claude', 'worktrees', 'wf_184-orphan-b');
    mkdirSync(orphanB, { recursive: true });
    makeSwiftLeftover(orphanB);

    return { mainRoot, orphanA, orphanB };
  }

  it('with --config declaring cleanup.disposableNames: [".build"], a real (non-dry-run) --orphans run removes BOTH orphan shapes', () => {
    const { mainRoot, orphanA, orphanB } = makeRepoWithBothOrphanShapes();
    const configPath = writeCleanupConfig(['.build']);

    const code = main(['worktree-cleanup', mainRoot, '--orphans', '--config', configPath]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      removed: Array<{ path: string }>;
      skipped: unknown[];
      errors: unknown[];
      orphans: { removed: Array<{ path: string }>; skipped: unknown[]; errors: unknown[] };
    };
    // orphanA is found via `listAgentWorktrees` (still git-worktree-listed) —
    // proves that entry point AND `executeCleanup` (the real removal) honour
    // the threaded declaration.
    expect(parsed.removed.map((w) => w.path)).toEqual([orphanA]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
    // orphanB is found ONLY via `listOrphanDirs` (the --orphans sweep) — proves
    // that entry point independently.
    expect(parsed.orphans.removed.map((o) => o.path)).toEqual([orphanB]);
    expect(parsed.orphans.skipped).toEqual([]);
    expect(parsed.orphans.errors).toEqual([]);

    expect(existsSync(orphanA)).toBe(false);
    expect(existsSync(orphanB)).toBe(false);
  });

  // Convention 11 negative control: the IDENTICAL fixture with NOTHING
  // declared (no --config at all) must classify both shapes as holding "real"
  // (undeclared) content and refuse to remove either — the exact pre-#184
  // behaviour, byte-identical. Without this, the test above could pass for a
  // reason unrelated to the declaration actually reaching the plan.
  it('the SAME fixture WITHOUT --config still classifies both shapes as real work and removes neither (negative control)', () => {
    const { mainRoot, orphanA, orphanB } = makeRepoWithBothOrphanShapes();

    const code = main(['worktree-cleanup', mainRoot, '--orphans']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      removed: unknown[];
      skipped: Array<{ path: string; reason: string }>;
      orphans: { removed: unknown[]; skipped: Array<{ path: string; reason: string }> };
    };
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped.map((w) => w.path)).toEqual([orphanA]);
    expect(parsed.skipped[0].reason).toBe('orphan-with-real-files');
    expect(parsed.orphans.removed).toEqual([]);
    expect(parsed.orphans.skipped.map((o) => o.path)).toEqual([orphanB]);
    expect(parsed.orphans.skipped[0].reason).toBe('orphan-with-real-files');

    expect(existsSync(orphanA)).toBe(true);
    expect(existsSync(orphanB)).toBe(true);
  });
});

describe('worktree-cleanup subcommand — unknown flags fail loud instead of silently binding as positional (FOR-87)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockClear();
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  it('an unrecognized --flag exits 2 with a usage error naming the offending flag', () => {
    const code = main(['worktree-cleanup', root, '--bogus']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--bogus/);
    expect(stderrBuf).toMatch(/usage:/);
  });

  it('never shells out to git when the unknown-flag guard fires — the usage error is raised before any listing/removal', () => {
    main(['worktree-cleanup', root, '--bogus']);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('emits no JSON result on the unknown-flag usage path (stdout stays empty)', () => {
    main(['worktree-cleanup', root, '--bogus']);
    expect(stdoutBuf).toBe('');
  });

  it('an unknown flag alongside otherwise-valid flags (--dry-run, --orphans) still fails loud naming the flag', () => {
    const code = main(['worktree-cleanup', root, '--dry-run', '--orphans', '--not-a-flag']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--not-a-flag/);
  });
});

// ─── Form 8b: worktree-cleanup — full summary + --orphans sweep (FOR-67) ─────
//
// FOR-67 (consumer KW-F6 + W15): the CLI must (1) print the FULL engine summary
// so a run can never do work and show nothing (branchesDeleted /
// branchHygieneSkipped / the deregistered-but-not-deleted class were computed
// but invisible), and (2) grow a --orphans sweep of directories under the
// worktrees root that `git worktree list` does not know about at all. The
// module-level execFileSync mock returns '' → `git worktree list` is empty, so
// every prefixed directory under a real (temp) worktrees root reads as an
// orphan; node:fs is NOT mocked here, so the physical removal is real.

describe('worktree-cleanup subcommand — full summary is always printed (FOR-67)', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  it('a real (non-dry-run) run surfaces every structural field — deregisteredNotDeleted, erroredStillListed, branchesDeleted, branchHygieneSkipped — so work is never invisible', () => {
    const code = main(['worktree-cleanup', root]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.deregisteredNotDeleted).toEqual([]);
    expect(parsed.erroredStillListed).toEqual([]);
    expect(parsed.branchesDeleted).toEqual([]);
    expect(parsed.branchHygieneSkipped).toEqual([]);
  });

  it('without --orphans there is no `orphans` key (scoping/behaviour untouched)', () => {
    main(['worktree-cleanup', root]);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect('orphans' in parsed).toBe(false);
  });
});

// ─── worktree-cleanup subcommand — `blockingPaths` rides the CLI's JSON
//     output (issue #718) ─────────────────────────────────────────────────
//
// The engine computes `WorktreeEntry.blockingPaths` (worktree-cleanup.spec.ts
// pins the classification itself); this describe block's only job is to
// prove the CLI verb does not drop it on the way to stdout — cli.ts spreads
// the whole `WorktreeEntry` into `skipped` with no field allowlist, so this
// is a pass-through proof, not a re-test of the classifier.

describe('worktree-cleanup subcommand — `blockingPaths` rides the CLI JSON output (issue #718)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function makeMainRoot(prefix: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempRoots.push(root);
    realGit(['init', '-q'], root);
    realGit(['config', 'user.email', 'test@example.com'], root);
    realGit(['config', 'user.name', 'Test'], root);
    // Pinned empty so this fixture never inherits the developer's own global
    // excludes — mirrors worktree-cleanup.spec.ts's makeConsumerWorktree.
    realGit(['config', 'core.excludesFile', '/dev/null'], root);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], root);
    return root;
  }

  type CleanupJson = {
    skipped: Array<{
      path: string;
      reason?: string;
      dirtyAllJunk?: boolean;
      blockingPaths?: {
        trackedDeleted: string[];
        trackedDeletedTotal: number;
        untracked: string[];
        untrackedTotal: number;
        otherTracked: string[];
        otherTrackedTotal: number;
        truncated: boolean;
        summary: string;
      };
    }>;
    removed: Array<{ path: string; blockingPaths?: unknown }>;
  };

  it('a worktree blocked by untracked residue reports `blockingPaths` on its `skipped` entry, named and bounded, exactly as the engine computed it', () => {
    const mainRoot = makeMainRoot('wave-cli-718-blocked-');
    const rel = join('.claude', 'worktrees', 'wf_718-blocked');
    realGit(['worktree', 'add', '-q', rel, '-b', 'wave/718-blocked'], mainRoot);
    const worktreePath = join(mainRoot, rel);
    mkdirSync(join(worktreePath, 'node_modules', 'some-pkg'), { recursive: true });
    writeFileSync(
      join(worktreePath, 'node_modules', 'some-pkg', 'index.js'),
      'module.exports = {};',
      'utf-8',
    );

    const code = main(['worktree-cleanup', mainRoot]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as CleanupJson;
    const entry = parsed.skipped.find((w) => w.path === worktreePath);
    expect(entry, `no skipped entry for ${worktreePath}: ${JSON.stringify(parsed.skipped)}`).toBeDefined();
    expect(entry?.reason).toBe('dirty');
    expect(entry?.dirtyAllJunk).toBe(false);
    expect(entry?.blockingPaths?.trackedDeleted).toEqual([]);
    expect(entry?.blockingPaths?.untracked).toEqual([
      expect.stringContaining('node_modules/'),
    ]);
    expect(entry?.blockingPaths?.untrackedTotal).toBe(1);
    expect(entry?.blockingPaths?.summary).toContain('untracked path');
    // Still on disk — a dirty worktree is never removed.
    expect(existsSync(worktreePath)).toBe(true);
  });

  it('negative control — a worktree dirtied ONLY by junk is REMOVED, not skipped, and carries no `blockingPaths`', () => {
    const mainRoot = makeMainRoot('wave-cli-718-junkonly-');
    const rel = join('.claude', 'worktrees', 'wf_718-junk-only');
    realGit(['worktree', 'add', '-q', rel, '-b', 'wave/718-junk-only'], mainRoot);
    const worktreePath = join(mainRoot, rel);
    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.claude', 'settings.local.json'),
      '{"permissions":{}}',
      'utf-8',
    );

    const code = main(['worktree-cleanup', mainRoot]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as CleanupJson;
    expect(parsed.skipped.find((w) => w.path === worktreePath)).toBeUndefined();
    const removedEntry = parsed.removed.find((w) => w.path === worktreePath);
    expect(removedEntry, `no removed entry for ${worktreePath}: ${JSON.stringify(parsed.removed)}`).toBeDefined();
    expect(removedEntry && 'blockingPaths' in removedEntry).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });
});

describe('worktree-cleanup subcommand — --orphans sweep (FOR-67)', () => {
  let orphanRepo: string;
  let worktreesRoot: string;
  let emptyOrphan: string;
  let junkOrphan: string;
  let realOrphan: string;
  let scratch: string;

  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    orphanRepo = mkdtempSync(join(tmpdir(), 'wave-cli-orphans-'));
    worktreesRoot = join(orphanRepo, '.claude', 'worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    // Empty leftover from an earlier wave — the exact "--wave scoping ignores
    // it but nothing reports it" case.
    emptyOrphan = join(worktreesRoot, 'wf_orphan-empty');
    mkdirSync(emptyOrphan, { recursive: true });
    // Deregistered-but-not-deleted junk leftover.
    junkOrphan = join(worktreesRoot, 'agent-orphan-junk');
    mkdirSync(junkOrphan, { recursive: true });
    writeFileSync(join(junkOrphan, '.DS_Store'), 'debris', 'utf-8');
    // Orphan holding real work — reported, never removed.
    realOrphan = join(worktreesRoot, 'wf_orphan-real');
    mkdirSync(realOrphan, { recursive: true });
    writeFileSync(join(realOrphan, 'notes.txt'), 'do not lose', 'utf-8');
    // Human scratch dir without a recognized prefix — never swept.
    scratch = join(worktreesRoot, 'my-scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'keep.txt'), 'keep', 'utf-8');
  });

  afterEach(() => {
    try {
      rmSync(orphanRepo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('--orphans --dry-run reports the orphan plan under `orphans` and removes nothing', () => {
    const code = main(['worktree-cleanup', orphanRepo, '--orphans', '--dry-run']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      orphans: { selected: Array<{ path: string }>; skipped: Array<{ path: string; reason: string }> };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.orphans.selected.map((o) => o.path).sort()).toEqual(
      [emptyOrphan, junkOrphan].sort(),
    );
    expect(parsed.orphans.skipped.map((o) => o.path)).toEqual([realOrphan]);
    // Dry-run: nothing removed from disk.
    expect(existsSync(emptyOrphan)).toBe(true);
    expect(existsSync(junkOrphan)).toBe(true);
  });

  it('--orphans (real run) removes empty + all-junk orphans, keeps the real-file orphan and the non-prefixed scratch dir', () => {
    const code = main(['worktree-cleanup', orphanRepo, '--orphans']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      orphans: { removed: Array<{ path: string }>; skipped: Array<{ path: string; reason: string }>; errors: unknown[] };
    };
    expect(parsed.orphans.removed.map((o) => o.path).sort()).toEqual(
      [emptyOrphan, junkOrphan].sort(),
    );
    expect(parsed.orphans.skipped[0].path).toBe(realOrphan);
    expect(parsed.orphans.skipped[0].reason).toBe('orphan-with-real-files');
    expect(parsed.orphans.errors).toEqual([]);
    // On-disk truth.
    expect(existsSync(emptyOrphan)).toBe(false);
    expect(existsSync(junkOrphan)).toBe(false);
    expect(existsSync(realOrphan)).toBe(true);
    expect(existsSync(scratch)).toBe(true);
  });
});

// ─── Form 8b-bis: worktree-cleanup — --dry-run previews the SCRIBE SCRATCH
//             population from the plan the real run executes (issue #377) ─────
//
// The gap: the --dry-run branch built its `orphans` object out of the orphan
// DIRECTORY plan's fields and returned before any execute — while the Scribe
// scratch sweep (issue #355) was reachable only from INSIDE executeOrphanSweep,
// through the one-shot `sweepScribeScratch`, which lists, plans and removes in
// a single opaque call. So `--orphans --dry-run` was SILENT on `.flotilla/tmp`
// — never "clean", because it had not looked — and the engine's own
// preview-and-run-share-one-plan discipline, which the detached sweep (Form 8h)
// and the orphan-BRANCH sweep (Form 8c-bis) both hold, was not met here.
//
// Same fixture rules as Form 8b above: `execFileSync` is mocked to '' so `git
// worktree list` is empty and no other population interferes, and node:fs is
// NOT mocked — every removal and every survival asserted below is a real
// on-disk fact. The scratch sweep touches only plain files, so the mocked git
// surface is irrelevant to it by construction.

describe('worktree-cleanup subcommand — --dry-run previews the Scribe scratch sweep from the plan the real run executes (issue #377)', () => {
  const repos: string[] = [];

  /** The scratch half of the `orphans` key, on either output shape. */
  type ScratchJson = {
    dir: string;
    present: boolean;
    selected?: Array<{ path: string }>;
    removed?: Array<{ path: string }>;
    skipped: Array<{ path: string; reason?: string }>;
    errors?: unknown[];
  };

  function parseScratch(): ScratchJson {
    expect(stdoutBuf, `stderr was: ${stderrBuf}`).not.toBe('');
    const parsed = JSON.parse(stdoutBuf) as { orphans?: { scratch?: ScratchJson } };
    const scratch = parsed.orphans?.scratch;
    expect(scratch, 'orphans.scratch missing from the CLI JSON').toBeDefined();
    return scratch as ScratchJson;
  }

  /**
   * A repo whose Scribe scratch directory is created at the path the ENGINE
   * constant names. `create: false` leaves the directory absent entirely — the
   * "did not look vs looked and found nothing" case.
   */
  function makeRepo(prefix: string, create = true): { repo: string; dir: string } {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    repos.push(repo);
    const dir = join(repo, SCRIBE_SCRATCH_RELATIVE_DIR);
    if (create) mkdirSync(dir, { recursive: true });
    return { repo, dir };
  }

  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  afterEach(() => {
    while (repos.length > 0) {
      const dir = repos.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  it('--orphans --dry-run names the payload files under orphans.scratch and removes NOTHING', () => {
    const { repo, dir } = makeRepo('wave-cli-377-preview-');
    // Both payload kinds the Scribe driver emits, plus a file a human parked in
    // the same directory — reported, never removed.
    const report = join(dir, 'report-377-1.json');
    const verdict = join(dir, 'verdict-377-2.json');
    const foreign = join(dir, 'notes.md');
    writeFileSync(report, '{}', 'utf-8');
    writeFileSync(verdict, '{}', 'utf-8');
    writeFileSync(foreign, 'human parked this here', 'utf-8');

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run'])).toBe(0);
    const scratch = parseScratch();

    expect(scratch.dir).toBe(dir);
    expect(scratch.present).toBe(true);
    expect((scratch.selected ?? []).map((e) => e.path).sort()).toEqual(
      [report, verdict].sort(),
    );
    expect(scratch.skipped.map((e) => e.path)).toEqual([foreign]);
    expect(scratch.skipped[0].reason).toBe('not-a-scribe-payload');

    // Dry-run: nothing was removed from disk.
    expect(existsSync(report)).toBe(true);
    expect(existsSync(verdict)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
  });

  it('the real run removes EXACTLY what the preview selected — one plan, derived expectation', () => {
    const { repo, dir } = makeRepo('wave-cli-377-parity-');
    const report = join(dir, 'report-377-1.json');
    const foreign = join(dir, 'notes.md');
    writeFileSync(report, '{}', 'utf-8');
    writeFileSync(foreign, 'human parked this here', 'utf-8');

    // 1. Preview.
    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run'])).toBe(0);
    const preview = parseScratch();
    const previewSelected = (preview.selected ?? []).map((e) => e.path).sort();
    const previewSkipped = new Map(preview.skipped.map((e) => [e.path, e.reason]));

    // 2. The same invocation without --dry-run — two separate `main()` calls,
    //    exactly like an operator's two separate CLI invocations.
    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo, '--orphans'])).toBe(0);
    const run = parseScratch();

    // THE parity assertion: the removed set is the previewed set, read OFF the
    // preview rather than transcribed here.
    expect((run.removed ?? []).map((e) => e.path).sort()).toEqual(previewSelected);
    expect(new Map(run.skipped.map((e) => [e.path, e.reason]))).toEqual(
      previewSkipped,
    );
    // Sanity on the fixture, so the parity above cannot be vacuous.
    expect(previewSelected).toEqual([report]);
    expect(previewSkipped.get(foreign)).toBe('not-a-scribe-payload');

    // The two assertions above are also this block's DOUBLE-SWEEP guard, and
    // that is not theoretical: restoring `repoRoot` to the `executeOrphanSweep`
    // call re-enables the engine's internal one-shot fold alongside the explicit
    // plan-then-execute pair, and it was observed failing exactly here —
    // `removed: []` against a preview that named one payload, because the
    // engine's pass deleted the file first. The empty `errors` list below is the
    // same guard read from the other side: the explicit pass then throws ENOENT
    // removing a file that is already gone, i.e. reports a failure for a removal
    // that in fact succeeded.
    expect(run.errors).toEqual([]);
    expect(existsSync(report)).toBe(false); // actually removed
    expect(existsSync(foreign)).toBe(true); // never touched
  });

  it('a preview reporting NOTHING selected is followed by a real run that removes nothing', () => {
    // The acceptance criterion in its own right, and the shape the disclosure
    // called out: a dry run that reports an empty selection must be a promise
    // the run keeps, not a coincidence. Here the directory exists and holds only
    // entries the allowlist refuses — a file that is not a payload, and a
    // subdirectory, which is never descended into.
    const { repo, dir } = makeRepo('wave-cli-377-empty-selection-');
    const foreign = join(dir, 'human-notes.txt');
    const nested = join(dir, 'a-subdirectory');
    writeFileSync(foreign, 'keep me', 'utf-8');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'report-377-1.json'), '{}', 'utf-8');

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run'])).toBe(0);
    const preview = parseScratch();
    expect(preview.present).toBe(true);
    expect(preview.selected ?? []).toEqual([]);
    expect(preview.skipped.map((e) => e.path).sort()).toEqual(
      [foreign, nested].sort(),
    );

    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo, '--orphans'])).toBe(0);
    const run = parseScratch();
    expect(run.removed ?? []).toEqual([]);
    expect(run.errors).toEqual([]);
    // Nothing was removed, including the payload-NAMED file one level down: the
    // sweep is never recursive, so a nested name cannot be reached.
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(nested, 'report-377-1.json'))).toBe(true);
  });

  it('an ABSENT scratch directory previews as `present: false`, not as an empty sweep', () => {
    // The distinction the engine's `present` flag exists for, carried into the
    // preview: "did not look" and "looked and found nothing" must not read the
    // same. Before this slice the dry run could report neither.
    const { repo, dir } = makeRepo('wave-cli-377-absent-', false);

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run'])).toBe(0);
    const preview = parseScratch();
    expect(preview.dir).toBe(dir);
    expect(preview.present).toBe(false);
    expect(preview.selected ?? []).toEqual([]);
    expect(preview.skipped).toEqual([]);

    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo, '--orphans'])).toBe(0);
    const run = parseScratch();
    expect(run.present).toBe(false);
    expect(run.removed ?? []).toEqual([]);
    expect(run.errors).toEqual([]);
  });

  it('NEGATIVE CONTROL — without --orphans neither shape carries the scratch sweep, and the payload survives a REAL run', () => {
    // Proves the flag is what reaches this sweep, and that nothing about the
    // preview widened the population a bare `worktree-cleanup` touches.
    const { repo, dir } = makeRepo('wave-cli-377-noorphans-');
    const report = join(dir, 'report-377-1.json');
    writeFileSync(report, '{}', 'utf-8');

    expect(main(['worktree-cleanup', repo, '--dry-run'])).toBe(0);
    expect('orphans' in (JSON.parse(stdoutBuf) as Record<string, unknown>)).toBe(
      false,
    );

    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo])).toBe(0);
    expect('orphans' in (JSON.parse(stdoutBuf) as Record<string, unknown>)).toBe(
      false,
    );
    expect(existsSync(report)).toBe(true);
  });
});

// ─── Form 8b-ter: worktree-cleanup — a FAILED Scribe-payload removal reaches
//             the EXIT CODE, not just the JSON (issue #417) ──────────────────
//
// The gap: `anyFailure` read `orphanResult.errors`, which carries orphan
// DIRECTORIES only. The scratch sweep's own errors sit one level down, under
// `orphans.scratch.errors`, outside every term of that verdict — so a payload
// removal that failed was printed in the summary and the verb still exited 0.
// The close ceremony and any operator branch on the exit status, so the one
// channel a caller actually reads carried no signal that a file was left
// behind. Every other incomplete-outcome class here (a removal error, an
// ENOTEMPTY deregistration, FOR-73's errored-yet-still-listed worktree, the
// detached sweep's three) already forces exit 1; this one now does too.
//
// Same fixture rules as Form 8b-bis above: `execFileSync` is mocked to '' so
// `git worktree list` is empty and no other population can contribute to the
// verdict, and node:fs is NOT mocked — the failure below is a REAL removal
// failure at the REAL seam (`rmSync` refused by the filesystem), never a
// stubbed error object handed to the CLI by a test double. That matters here
// more than anywhere else in this file: the whole claim under test is that a
// genuine on-disk failure changes the process exit status.

describe('worktree-cleanup subcommand — a failed Scribe-scratch payload removal drives exit 1 (issue #417)', () => {
  const repos: string[] = [];
  const modesToRestore: string[] = [];

  /** The whole real-run summary, so the verdict can be attributed to ONE class. */
  type CleanupJson = {
    errors: unknown[];
    deregisteredNotDeleted: unknown[];
    erroredStillListed: unknown[];
    orphans?: {
      errors: unknown[];
      scratch?: {
        dir: string;
        present: boolean;
        selected?: Array<{ path: string }>;
        removed?: Array<{ path: string }>;
        skipped: Array<{ path: string; reason?: string }>;
        errors?: Array<{ path: string; message: string }>;
      };
    };
  };

  function parseSummary(): CleanupJson {
    expect(stdoutBuf, `stderr was: ${stderrBuf}`).not.toBe('');
    return JSON.parse(stdoutBuf) as CleanupJson;
  }

  /**
   * Permission bits are the portable way to make a real removal fail; root
   * ignores them and Windows has no equivalent — the same guard the
   * unreadable-worktree specs in worktree-cleanup.spec.ts use.
   */
  const canDenyWrite =
    process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

  /** A repo whose Scribe scratch directory holds exactly one payload file. */
  function makeRepoWithPayload(prefix: string): {
    repo: string;
    dir: string;
    payload: string;
  } {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    repos.push(repo);
    const dir = join(repo, SCRIBE_SCRATCH_RELATIVE_DIR);
    mkdirSync(dir, { recursive: true });
    const payload = join(dir, 'report-417-1.json');
    writeFileSync(payload, '{}', 'utf-8');
    return { repo, dir, payload };
  }

  /**
   * Deny writes on the payload's PARENT: unlinking a file needs write
   * permission on its directory, while read+execute keeps the listing (and so
   * the plan's `selected`) exactly as it was. The removal is what fails, not
   * the classification — which is precisely the case the exit verdict missed.
   */
  function denyRemoval(dir: string): void {
    chmodSync(dir, 0o555);
    modesToRestore.push(dir);
  }

  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
  });

  afterEach(() => {
    // Restore modes BEFORE the recursive rm — a 0555 directory would otherwise
    // defeat the cleanup itself and leak the fixture into the temp dir.
    while (modesToRestore.length > 0) {
      const dir = modesToRestore.pop();
      if (dir) {
        try {
          chmodSync(dir, 0o755);
        } catch {
          // best-effort restore
        }
      }
    }
    while (repos.length > 0) {
      const dir = repos.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  it.skipIf(!canDenyWrite)(
    'a payload removal that FAILS is reported under orphans.scratch.errors AND exits 1',
    () => {
      const { repo, dir, payload } = makeRepoWithPayload('wave-cli-417-fail-');
      denyRemoval(dir);

      const code = main(['worktree-cleanup', repo, '--orphans']);

      expect(code).toBe(1);

      const summary = parseSummary();
      const scratch = summary.orphans?.scratch;
      expect(scratch, 'orphans.scratch missing from the CLI JSON').toBeDefined();
      expect((scratch?.removed ?? []).map((e) => e.path)).toEqual([]);
      expect((scratch?.errors ?? []).map((e) => e.path)).toEqual([payload]);
      expect((scratch?.errors ?? [])[0].message).toMatch(
        /EACCES|EPERM|permission denied/i,
      );

      // ATTRIBUTION: every OTHER term of the verdict is empty, so the 1 above
      // can only have come from the scratch errors. Without this the test would
      // pass just as happily if some unrelated population had failed.
      expect(summary.errors).toEqual([]);
      expect(summary.deregisteredNotDeleted).toEqual([]);
      expect(summary.erroredStillListed).toEqual([]);
      expect(summary.orphans?.errors).toEqual([]);

      // The exit code names a real leftover: the payload is still on disk.
      expect(existsSync(payload)).toBe(true);
    },
  );

  it('NEGATIVE CONTROL — the same sweep with a REMOVABLE payload still exits 0', () => {
    // Runs on every platform, including as root: it proves the new term did not
    // turn an ordinary successful sweep into a failure, which is the half of
    // "existing exit classes unchanged" that this population owns.
    const { repo, payload } = makeRepoWithPayload('wave-cli-417-ok-');

    const code = main(['worktree-cleanup', repo, '--orphans']);

    expect(code).toBe(0);
    const scratch = parseSummary().orphans?.scratch;
    expect((scratch?.removed ?? []).map((e) => e.path)).toEqual([payload]);
    expect(scratch?.errors ?? []).toEqual([]);
    expect(existsSync(payload)).toBe(false);
  });

  it.skipIf(!canDenyWrite)(
    'a DRY RUN over the same unremovable payload still exits 0 — a plan carries no errors',
    () => {
      // The dry-run branch returns before any execute, so there is nothing that
      // could fail and nothing the verdict could read. Pinned because the fix
      // lives in the shared verb: a preview that started failing here would be
      // a regression nobody asked for.
      const { repo, dir, payload } = makeRepoWithPayload('wave-cli-417-dry-');
      denyRemoval(dir);

      expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run'])).toBe(0);

      const scratch = parseSummary().orphans?.scratch;
      expect((scratch?.selected ?? []).map((e) => e.path)).toEqual([payload]);
      expect(scratch?.errors).toBeUndefined();
      expect(existsSync(payload)).toBe(true);
    },
  );
});

// ─── Form 8f: worktree-cleanup — the branch-scoping flag FAILS CLOSED and
//             reads the spine through the real reader (issue #141) ────────────
//
// Two defects, measured on a live wave, both landing here:
//
//  1. `resolveBranchFilter` read the spine via merge-order's `parseWaveSpine`,
//     which re-keys branches from row ids to canonical issueIds through the
//     `.scratch` footnote → issue-file bridge. A tracker-backed wave has no
//     such tree, so the re-key map was empty and EVERY branch was dropped — for
//     conventionally-named branches too. It now reads through
//     `readSpine` + `requireBranchesByIssueId` (wave-md-rw), which keys by the
//     row id verbatim.
//
//  2. It ended `return filter.size > 0 ? filter : undefined`, and `undefined`
//     downstream means NO filter. So a flag whose entire purpose is to narrow
//     scope silently widened to everything: a command asked to clean one wave's
//     worktrees would clean every agent worktree in the repo, tearing down a
//     sibling wave mid-flight. It must refuse instead — and that is the
//     load-bearing half, since ANY future path leaving the set empty produces
//     the same widening.
describe('worktree-cleanup --wave — reads the spine through the real reader (issue #141)', () => {
  let waveRepo: string;

  /** Write a tracker-backed spine (bare ids, NO `.scratch` footnotes) with the given dispatch-log. */
  function writeSpine(entries: string[]): string {
    const path = join(waveRepo, 'WAVE.md');
    writeFileSync(
      path,
      [
        '# Wave 2026-07-27 — scoping',
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 131 | Alpha | background | mechanical | universal | — | dispatched | 1 | — |',
        '| 132 | Beta | background | mechanical | universal | — | dispatched | 1 | — |',
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        ...entries.map((e) => `  - "${e}"`),
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  beforeEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    waveRepo = mkdtempSync(join(tmpdir(), 'wave-cli-141-'));
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(waveRepo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('derives the scope from a tracker-backed spine — the shape parseWaveSpine returned {} for', () => {
    const spine = writeSpine([
      '131 → agent wf_aaa (sonnet) branch wave/131-alpha',
      '132 → agent wf_bbb (sonnet) branch wave/132-beta',
    ]);
    const code = main(['worktree-cleanup', waveRepo, '--wave', spine]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { branchFilter?: string[] };
    expect(parsed.branchFilter).toEqual(['wave/131-alpha', 'wave/132-beta']);
  });

  it('derives the scope from branches named OUTSIDE the convention too', () => {
    const spine = writeSpine([
      '131 → agent wf_aaa (sonnet) branch w28/131-alpha',
      '132 → agent wf_bbb (sonnet) branch feature/132-beta',
    ]);
    const code = main(['worktree-cleanup', waveRepo, '--wave', spine]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { branchFilter?: string[] };
    expect(parsed.branchFilter).toEqual(['feature/132-beta', 'w28/131-alpha']);
  });
});

describe('worktree-cleanup --wave — an unresolvable scope REFUSES, never widens (issue #141)', () => {
  let waveRepo: string;
  const SIBLING_WORKTREE = '/repo/.claude/worktrees/wf_sibling-wave';
  const SIBLING_BRANCH = 'wave/999-sibling-in-flight';

  /**
   * Drive `git worktree list` to report ONE clean, registered agent worktree
   * that belongs to a DIFFERENT wave. It is the only candidate on the table, so
   * "did the fail-open fire?" reduces to "was it selected?".
   */
  function driveSiblingWorktree(): void {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'worktree' && cmdArgs[1] === 'list') {
        return `worktree ${SIBLING_WORKTREE}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/${SIBLING_BRANCH}\n`;
      }
      if (cmdArgs[0] === 'rev-parse') return `${SIBLING_WORKTREE}\n`;
      if (cmdArgs[0] === 'status') return ''; // clean → eligible for removal
      return '';
    });
  }

  /** A spine whose dispatch-log has entries but records no branch on any of them. */
  function writeBranchlessSpine(): string {
    const path = join(waveRepo, 'WAVE.md');
    writeFileSync(
      path,
      [
        '# Wave 2026-07-27 — branchless',
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 131 | Alpha | background | mechanical | universal | — | dispatched | 1 | — |',
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        '  - "131 → agent wf_aaa (sonnet) dispatched"',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  beforeEach(() => {
    waveRepo = mkdtempSync(join(tmpdir(), 'wave-cli-141-closed-'));
    driveSiblingWorktree();
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(waveRepo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('a spine yielding NO branch exits 2 and does NOT select a sibling wave\'s worktree — the fail-open case', () => {
    const code = main([
      'worktree-cleanup',
      waveRepo,
      '--wave',
      writeBranchlessSpine(),
    ]);
    // Pre-fix: the empty set became `undefined` → no filter → the sibling's
    // worktree was the sole selection of an unscoped global GC, and the run
    // exited 0 having removed it.
    expect(code).toBe(2);
    expect(stdoutBuf).toBe('');
    expect(stdoutBuf).not.toContain(SIBLING_WORKTREE);
    expect(stdoutBuf).not.toContain(SIBLING_BRANCH);
  });

  it('says WHY it refused — the scope was unresolvable, not that nothing matched', () => {
    main(['worktree-cleanup', waveRepo, '--wave', writeBranchlessSpine()]);
    expect(stderrBuf).toMatch(/no branch/i);
    expect(stderrBuf).toMatch(/refusing/i);
    // The underlying reader diagnostic is preserved through the wrap.
    expect(stderrBuf).toMatch(/no branch could be recovered/);
  });

  it('never issues a `git worktree remove` when the scope is unresolvable', () => {
    main(['worktree-cleanup', waveRepo, '--wave', writeBranchlessSpine()]);
    const removeCalled = vi
      .mocked(execFileSync)
      .mock.calls.some(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[])[0] === 'worktree' &&
          (c[1] as string[])[1] === 'remove',
      );
    expect(removeCalled).toBe(false);
  });

  it('--dry-run does not soften the refusal — an unresolvable scope is exit 2, not an empty preview', () => {
    const code = main([
      'worktree-cleanup',
      waveRepo,
      '--dry-run',
      '--wave',
      writeBranchlessSpine(),
    ]);
    expect(code).toBe(2);
    expect(stdoutBuf).toBe('');
  });

  it('--branches with only empty values refuses too — the fail-open was never spine-specific', () => {
    const code = main(['worktree-cleanup', waveRepo, '--branches', ' , ,']);
    expect(code).toBe(2);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/refusing/i);
  });

  it('a resolvable --branches scope still runs normally and excludes the out-of-scope sibling', () => {
    // The narrowing path itself is unaffected: a real scope selects nothing here
    // because the only candidate belongs to another wave.
    const code = main([
      'worktree-cleanup',
      waveRepo,
      '--branches',
      'wave/131-alpha',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      branchFilter: string[];
      removed: unknown[];
      skipped: unknown[];
    };
    expect(parsed.branchFilter).toEqual(['wave/131-alpha']);
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it('with NO scoping flag the global-GC path is untouched — the sibling IS selected (the behaviour that must stay opt-out)', () => {
    // The counterpart assertion: fail-closed changes the SCOPED path only. An
    // unscoped invocation is still a deliberate global GC, and this pins that
    // the refusal did not leak into it.
    const code = main(['worktree-cleanup', waveRepo]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      branchFilter?: string[];
      removed: Array<{ path: string }>;
    };
    expect(parsed.branchFilter).toBeUndefined();
    expect(parsed.removed.map((w) => w.path)).toEqual([SIBLING_WORKTREE]);
  });
});

// ─── Form 8c: worktree-cleanup — --orphans folds the standalone orphaned-BRANCH
//             sweep into branchesDeleted / branchHygieneSkipped (FOR-72) ───────
//
// FOR-72 (W15-F1, 3× reproduced): --orphans, besides the orphan-DIRECTORY sweep
// above, also deletes local branches orphaned WITHOUT a worktree-removal event
// — wave/* branches whose remote ref is gone and harness worktree-wf_* base
// branches whose worktree is gone. Those deletions ride the EXISTING
// branchesDeleted / branchHygieneSkipped summary fields. The whole git surface
// is driven through the module-level execFileSync mock (per git subcommand), so
// no real repo/branches are needed; the temp repo dir simply gives a resolvable
// repo-root with no worktrees dir (dir sweep + live-worktree scan both empty).
describe('worktree-cleanup subcommand — --orphans folds the orphaned-branch sweep into the summary (FOR-72)', () => {
  let repo: string;

  /**
   * Drive each git subcommand the cleanup path issues:
   *   - for-each-ref  → the local branch set (a gone wave branch, an orphaned
   *                     worktree-wf_ branch, and the current branch)
   *   - symbolic-ref  → the current branch (never deleted)
   *   - ls-remote     → exit 2 (git's authoritative "no matching ref" = gone)
   *   - everything else (worktree list, rev-parse, branch -D, ...) → ''
   */
  function driveBranchSweepGit(): void {
    // Reset call history first so `mock.calls` reflects only this invocation
    // (the shared module-level mock accumulates calls across the whole file).
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      const sub = cmdArgs[0];
      if (sub === 'for-each-ref') {
        return 'main\nwave/FOR-72-gone\nworktree-wf_orphan-1\n';
      }
      if (sub === 'symbolic-ref') return 'main\n';
      if (sub === 'ls-remote') {
        const err = new Error('') as NodeJS.ErrnoException & { status?: number };
        err.status = 2; // authoritative "no matching ref" → gone
        throw err;
      }
      return '';
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wave-cli-for72-'));
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('--orphans (real run) folds the gone wave branch + orphaned worktree-wf_ branch into branchesDeleted; the current branch is never deleted', () => {
    driveBranchSweepGit();
    const code = main(['worktree-cleanup', repo, '--orphans']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      branchesDeleted: string[];
      branchHygieneSkipped: unknown[];
    };
    expect(parsed.branchesDeleted.sort()).toEqual(
      ['wave/FOR-72-gone', 'worktree-wf_orphan-1'].sort(),
    );
    expect(parsed.branchesDeleted).not.toContain('main');
    expect(parsed.branchHygieneSkipped).toEqual([]);
    // The deletions actually went through `git branch -D`.
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'wave/FOR-72-gone'],
      expect.objectContaining({ cwd: repo }),
    );
  });

  it('WITHOUT --orphans the branch sweep never runs — branchesDeleted stays [] and `git for-each-ref` is never issued (no-flag path byte-identical)', () => {
    driveBranchSweepGit();
    const code = main(['worktree-cleanup', repo]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      branchesDeleted: string[];
      branchHygieneSkipped: unknown[];
    };
    expect(parsed.branchesDeleted).toEqual([]);
    expect(parsed.branchHygieneSkipped).toEqual([]);
    expect('orphans' in parsed).toBe(false);
    const forEachRefCalled = vi
      .mocked(execFileSync)
      .mock.calls.some((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'for-each-ref');
    expect(forEachRefCalled).toBe(false);
  });
});

// ─── Form 8c-ter: worktree-cleanup — the REVIEW-REF sweep's CLI wiring
//             (issue #732, unguarded until #743) ─────────────────────────────
//
// The gap this closes: the review-ref sweep (`listReviewRefs` /
// `planReviewRefSweep` / `executeReviewRefSweep`, worktree-cleanup.ts) is
// reachable only through THIS verb's `--orphans` flag, and — unlike every
// sibling population above (the orphan directories, the Scribe scratch sweep,
// the orphan-branch sweep) — nothing in this suite ever drove it through the
// CLI at all. The Reviewer that landed #732 closed the gap for that one
// landing with its own ad-hoc end-to-end probe against a throwaway repository
// with planted refs, but that probe was never committed, so the wiring has
// been unguarded from the next change onward.
//
// Same fixture shape as the orphan-branch block above: every git subcommand
// this verb issues is driven through the module-level `execFileSync` mock,
// routed by subcommand + format flag so the review-ref LISTING
// (`for-each-ref --format=%(refname) refs/review refs/sib`) is never confused
// with the orphan-branch LISTING (`for-each-ref --format=%(refname:short)
// refs/heads/`) that rides the same flag. `--wave <spine>` supplies the live
// row ids the sweep is scoped against (row 131), exactly as the FOR-141 block
// above supplies them for branch scoping — the same spine answers both
// questions because `resolveLiveRowIds` reads the identical Plan-Table.
describe('worktree-cleanup subcommand — the review-ref sweep rides --orphans under its own `orphans.reviewRefs` key (issue #732 wiring)', () => {
  let repo: string;

  // One live row (131), and five refs spanning every classification the
  // sweep can produce: a live-row skip, one selected ref per namespace (all
  // three), and an unresolvable-row skip (an extra path segment).
  const LIVE_REF = 'refs/review/131';
  const DEAD_REVIEW_REF = 'refs/review/999';
  const DEAD_REVIEW_SIB_REF = 'refs/review/sib/998';
  const DEAD_FLAT_SIB_REF = 'refs/sib/997';
  const UNRESOLVABLE_REF = 'refs/review/a/b';

  /**
   * Drive every git subcommand `worktree-cleanup --orphans` issues:
   *   - `for-each-ref --format=%(refname) …`       → the five review/sib refs
   *   - `for-each-ref --format=%(refname:short) …` → no local branches (the
   *     orphan-BRANCH sweep's own listing — kept empty so it contributes
   *     nothing and cannot be mistaken for this sweep's population)
   *   - `update-ref -d <ref>`                        → succeeds, unless
   *     `failRef` names the one ref this run should fail to delete
   *   - everything else (`worktree list`, `symbolic-ref`, `ls-remote`, …)   → ''
   */
  function driveReviewRefGit(failRef?: string): void {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'for-each-ref' && cmdArgs[1] === '--format=%(refname)') {
        return (
          [LIVE_REF, DEAD_REVIEW_REF, DEAD_REVIEW_SIB_REF, DEAD_FLAT_SIB_REF, UNRESOLVABLE_REF].join(
            '\n',
          ) + '\n'
        );
      }
      if (cmdArgs[0] === 'update-ref' && cmdArgs[1] === '-d') {
        if (failRef !== undefined && cmdArgs[2] === failRef) {
          throw new Error(`simulated ref-delete failure for ${failRef}`);
        }
        return '';
      }
      return '';
    });
  }

  /** A tracker-backed spine (FOR-141 shape) whose one row (131) is the live wave. */
  function writeLiveRowSpine(): string {
    const path = join(repo, 'WAVE.md');
    writeFileSync(
      path,
      [
        '# Wave 2026-09-07 — review-ref wiring',
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        '| 131 | Alpha | background | mechanical | universal | — | dispatched | 1 | — |',
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        '  - "131 → agent wf_aaa (sonnet) branch wave/131-alpha"',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wave-cli-732-wiring-'));
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('AC3 — --orphans --dry-run names the review-ref PLAN under orphans.reviewRefs: selected refs, and why every skip was skipped', () => {
    driveReviewRefGit();
    const spine = writeLiveRowSpine();
    const code = main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      orphans: {
        reviewRefs?: {
          namespaces: string[];
          liveRowIds: string[] | null;
          selected: Array<{ ref: string }>;
          skipped: Array<{ ref: string; reason: string }>;
        };
      };
    };
    const rr = parsed.orphans.reviewRefs;
    expect(rr, 'orphans.reviewRefs missing from the --dry-run CLI JSON').toBeDefined();
    expect([...rr!.namespaces].sort()).toEqual(['refs/review', 'refs/sib'].sort());
    expect(rr!.liveRowIds).toEqual(['131']);
    expect(rr!.selected.map((r) => r.ref).sort()).toEqual(
      [DEAD_REVIEW_REF, DEAD_REVIEW_SIB_REF, DEAD_FLAT_SIB_REF].sort(),
    );
    expect(rr!.skipped.find((s) => s.ref === LIVE_REF)?.reason).toBe('live-row');
    expect(rr!.skipped.find((s) => s.ref === UNRESOLVABLE_REF)?.reason).toBe('unresolvable-row');
    // A dry run previews the plan; it never deletes a ref.
    const updateRefCalled = vi
      .mocked(execFileSync)
      .mock.calls.some((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'update-ref');
    expect(updateRefCalled).toBe(false);
  });

  it('AC4 — the real run executes EXACTLY that plan: counts + errors under the SAME orphans.reviewRefs key, additive to (never merged into) the orphan-directory numbers', () => {
    driveReviewRefGit();
    const spine = writeLiveRowSpine();
    const code = main(['worktree-cleanup', repo, '--orphans', '--wave', spine]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      orphans: {
        removed: unknown[];
        errors: unknown[];
        reviewRefs?: {
          removed: Array<{ ref: string }>;
          skipped: Array<{ ref: string; reason: string }>;
          errors: unknown[];
        };
      };
    };
    const rr = parsed.orphans.reviewRefs;
    expect(rr, 'orphans.reviewRefs missing from the real-run CLI JSON').toBeDefined();
    expect(rr!.removed.map((r) => r.ref).sort()).toEqual(
      [DEAD_REVIEW_REF, DEAD_REVIEW_SIB_REF, DEAD_FLAT_SIB_REF].sort(),
    );
    expect(rr!.skipped.find((s) => s.ref === LIVE_REF)?.reason).toBe('live-row');
    expect(rr!.errors).toEqual([]);
    // Additive, never merged: this fixture plants no orphan DIRECTORY at all,
    // so the orphan-directory numbers stay empty — the three removed refs
    // above never leak into `orphans.removed`.
    expect(parsed.orphans.removed).toEqual([]);
    expect(parsed.orphans.errors).toEqual([]);
    // The deletions actually went through `git update-ref -d`, one call per
    // selected ref, and never for the live-row ref.
    for (const ref of [DEAD_REVIEW_REF, DEAD_REVIEW_SIB_REF, DEAD_FLAT_SIB_REF]) {
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['update-ref', '-d', ref],
        expect.objectContaining({ cwd: repo }),
      );
    }
    expect(execFileSync).not.toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', LIVE_REF],
      expect.anything(),
    );
  });

  it('a review-ref delete failure lands in orphans.reviewRefs.errors (never the orphan-directory errors) and forces a non-zero exit', () => {
    driveReviewRefGit(DEAD_REVIEW_REF);
    const spine = writeLiveRowSpine();
    const code = main(['worktree-cleanup', repo, '--orphans', '--wave', spine]);
    const parsed = JSON.parse(stdoutBuf) as {
      orphans: { errors: unknown[]; reviewRefs?: { errors: Array<{ ref: string; message: string }> } };
    };
    expect(parsed.orphans.reviewRefs?.errors).toEqual([
      { ref: DEAD_REVIEW_REF, message: expect.stringContaining('simulated ref-delete failure') },
    ]);
    expect(parsed.orphans.errors).toEqual([]);
    expect(code).toBe(1);
  });

  it('WITHOUT --orphans neither shape carries `orphans` at all, and the review-ref listing is never issued', () => {
    driveReviewRefGit();
    const code = main(['worktree-cleanup', repo, '--wave', writeLiveRowSpine()]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect('orphans' in parsed).toBe(false);
    const reviewListingCalled = vi
      .mocked(execFileSync)
      .mock.calls.some(
        (c) =>
          Array.isArray(c[1]) &&
          (c[1] as string[])[0] === 'for-each-ref' &&
          (c[1] as string[])[1] === '--format=%(refname)',
      );
    expect(reviewListingCalled).toBe(false);
  });
});

// ─── Form 8c-bis: worktree-cleanup — --dry-run previews the orphan-BRANCH
//             sweep too, against a REAL repo (issue #148) ───────────────────
//
// The live defect: `worktree-cleanup --orphans --dry-run` reported nothing
// selected/nothing to delete because the CLI's --dry-run branch never called
// planOrphanBranchSweep at all; the real run seconds later, against an
// unchanged repo, deleted six branches with no preceding preview of that
// outcome. Form 8c above drives the branch sweep through the module-level
// execFileSync FIXTURE; this block drives it through a REAL git repository
// (via `vi.importActual`, mirroring worktree-cleanup.spec.ts's own real
// git/fs end-to-end coverage of sweepOrphanBranches for FOR-72) — the live
// case was a real repository, not a fixture, so the regression test is too.
// Type-erasing cast to reach vitest's mock methods on the mocked
// `execFileSync` — mirrors worktree-cleanup.spec.ts's own `asExecFileSyncMock`.
// `execFileSync`'s real type is a complex overload set; this block's tests
// only need the mock-control surface, so this narrows to exactly that rather
// than fighting the overloads with an `unknown[]`-returning delegate.
function asExecFileSyncMock(fn: typeof execFileSync): {
  mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
} {
  return fn as unknown as {
    mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
  };
}

describe('worktree-cleanup subcommand — --dry-run previews the orphan-branch sweep against a real repo (issue #148)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function localBranches(mainRoot: string): Set<string> {
    const out = realExecFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      { cwd: mainRoot, encoding: 'utf-8' },
    ) as string;
    return new Set(
      out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
  }

  // A real repo with a `wave/*` branch never pushed (so its remote ref is
  // authoritatively gone — a real bare `origin.git` makes `git ls-remote
  // --exit-code` return exit 2, not a transport failure) and an unrelated
  // branch that matches neither sweep signal.
  function buildRepoWithSweepableBranch(prefix: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempRoots.push(root);

    const originPath = join(root, 'origin.git');
    realGit(['init', '-q', '--bare', originPath], root);

    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    realGit(['branch', '-M', 'main'], mainRoot); // deterministic current branch
    realGit(['remote', 'add', 'origin', originPath], mainRoot);

    realGit(['branch', 'wave/FOR-148-gone'], mainRoot); // sweepable
    realGit(['branch', 'feature/keep'], mainRoot); // neither signal

    return mainRoot;
  }

  it('--orphans --dry-run names the sweepable branch under orphanBranches.toDelete and deletes nothing', () => {
    const mainRoot = buildRepoWithSweepableBranch('wave-cli-for148-dryrun-');
    expect(localBranches(mainRoot)).toContain('wave/FOR-148-gone');

    const code = main(['worktree-cleanup', mainRoot, '--orphans', '--dry-run']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      dryRun: boolean;
      orphanBranches: { toDelete: string[]; branchHygieneSkipped: unknown[] };
    };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.orphanBranches.toDelete).toEqual(['wave/FOR-148-gone']);
    expect(parsed.orphanBranches.branchHygieneSkipped).toEqual([]);

    // Dry-run: nothing was actually deleted.
    const after = localBranches(mainRoot);
    expect(after.has('wave/FOR-148-gone')).toBe(true);
    expect(after.has('feature/keep')).toBe(true);
    expect(after.has('main')).toBe(true);
  });

  it('the real run (seconds later, unchanged repo) deletes exactly the branch the dry-run named — preview and execution share one plan', () => {
    const mainRoot = buildRepoWithSweepableBranch('wave-cli-for148-real-');

    const previewCode = main(['worktree-cleanup', mainRoot, '--orphans', '--dry-run']);
    expect(previewCode).toBe(0);
    const preview = JSON.parse(stdoutBuf) as { orphanBranches: { toDelete: string[] } };
    expect(preview.orphanBranches.toDelete).toEqual(['wave/FOR-148-gone']);

    // Two separate `main()` calls, exactly like an operator's two separate
    // CLI invocations (dry-run, then — seconds later — the real run).
    stdoutBuf = '';
    const realCode = main(['worktree-cleanup', mainRoot, '--orphans']);
    expect(realCode).toBe(0);
    const real = JSON.parse(stdoutBuf) as { branchesDeleted: string[] };
    expect(real.branchesDeleted).toEqual(preview.orphanBranches.toDelete);

    const after = localBranches(mainRoot);
    expect(after.has('wave/FOR-148-gone')).toBe(false); // actually deleted
    expect(after.has('feature/keep')).toBe(true); // preserved
    expect(after.has('main')).toBe(true); // current branch, preserved
  });

  it('without --orphans, --dry-run carries no orphanBranches key at all (scoping untouched)', () => {
    const mainRoot = buildRepoWithSweepableBranch('wave-cli-for148-noorphans-');
    const code = main(['worktree-cleanup', mainRoot, '--dry-run']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect('orphanBranches' in parsed).toBe(false);
  });
});

// ─── Form 8d: worktree-cleanup — a throwing removal git still lists lands in
//             erroredStillListed and counts as visible work (FOR-73 — W18-F1) ──
//
// The remover THROWS yet `git worktree list` still lists the worktree afterwards
// (as prunable) — a THIRD ENOTEMPTY-family form, distinct from a genuine failure
// (`errors`). The whole git surface is driven through the module-level
// execFileSync mock per subcommand: `worktree list` returns one clean registered
// agent worktree (so it is selected AND, on the throw-path re-probe, still
// listed), `worktree remove` throws, and everything else is ''. node:fs is NOT
// mocked here — the default remover's physical delete is a real no-op on the
// never-created directory, so the throw comes from the mocked `git worktree
// remove` step. The non-empty erroredStillListed field must force exit 1 (the
// work-visibility condition in the cleanup verb).
describe('worktree-cleanup subcommand — errored-yet-still-listed forces visible work (FOR-73)', () => {
  let repo: string;

  function driveErroredStillListed(worktreePath: string): void {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      const sub = cmdArgs[0];
      if (sub === 'worktree' && cmdArgs[1] === 'list') {
        // One clean, registered agent worktree — selected for removal, and
        // still listed on the throw-path re-probe.
        return `worktree ${worktreePath}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/wave/FOR-73-x\n`;
      }
      if (sub === 'rev-parse') return `${worktreePath}\n`; // toplevel self-resolves → not an orphan
      if (sub === 'status') return ''; // clean
      if (sub === 'worktree' && cmdArgs[1] === 'remove') {
        throw new Error(
          `git worktree remove: cannot remove worktree at '${worktreePath}': Directory not empty`,
        );
      }
      return '';
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wave-cli-for73-'));
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('surfaces the throwing-still-listed worktree in erroredStillListed (not errors) and exits 1', () => {
    const worktreePath = join(repo, '.claude', 'worktrees', 'wf_errored-1');
    driveErroredStillListed(worktreePath);
    const code = main(['worktree-cleanup', repo]);
    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as {
      erroredStillListed: Array<{ path: string }>;
      errors: unknown[];
      removed: unknown[];
      deregisteredNotDeleted: unknown[];
    };
    expect(parsed.erroredStillListed.map((w) => w.path)).toEqual([worktreePath]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.removed).toEqual([]);
    expect(parsed.deregisteredNotDeleted).toEqual([]);
  });
});

// ─── Form 8g2: worktree-cleanup — the survivor evidence reaches the JSON
//              through BOTH invocation forms (issue #560) ───────────────────
//
// The engine-level coverage of WHAT the survivor walk reports lives in
// worktree-cleanup.spec.ts §37. What this router spec answers is the wiring
// question that class has been burned by before: a field the engine computes
// and the CLI never prints is a field nobody reads. `erroredStillListed`'s
// entries are serialized WHOLE here, so the evidence rides along structurally
// — and the two invocation forms are asserted separately anyway, because
// "structurally" is a claim about code nobody re-checks after the next edit.
//
// The FULL close-sweep form (no scope flags) and the SCOPED single-branch form
// (`--branches`) run the identical `executeCleanup` on plans that differ only
// in which worktrees were selected, so the assertion is that the evidence is
// present and IDENTICAL across both — a scoped close must not report less than
// an unscoped one about the same worktree.
//
// `node:fs` is deliberately left real in this file, so the removal is made to
// fail the way issue #417's fixture does: permission bits. A worktree directory
// with its write bit cleared cannot have its children unlinked, so the physical
// delete throws for real while the directory stays READABLE — which is exactly
// the state the survivor walk exists to inspect.
describe('worktree-cleanup — the erroredStillListed survivor evidence rides both CLI forms (issue #560)', () => {
  let repo: string;
  let worktreePath: string;
  const BRANCH = 'wave/560-cli-survivors';

  type SurvivorEntry = {
    path: string;
    survivors?: { paths: string[]; total: number; exclusivelyDenied: boolean };
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'wave-cli-560-'));
    worktreePath = join(repo, '.claude', 'worktrees', 'wf_560-survivors');
    mkdirSync(join(worktreePath, 'src'), { recursive: true });
    writeFileSync(join(worktreePath, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(join(worktreePath, 'README.md'), '# readme\n');
    // The worktree's own gitfile, so `defaultWorktreeRemover` takes its
    // ORDINARY path rather than the half-removed recovery branch (FOR-86).
    writeFileSync(join(worktreePath, '.git'), 'gitdir: /nowhere/.git/worktrees/x\n');
    // Deny writes on the worktree directory itself: its children can still be
    // read and listed, but not unlinked. The physical delete throws; the walk
    // reads the survivors it left.
    chmodSync(worktreePath, 0o500);

    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      const sub = cmdArgs[0];
      if (sub === 'worktree' && cmdArgs[1] === 'list') {
        return `worktree ${worktreePath}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/${BRANCH}\n`;
      }
      if (sub === 'rev-parse') return `${worktreePath}\n`; // self-resolving toplevel → not an orphan
      if (sub === 'status') return ''; // clean → selected for removal
      if (sub === 'worktree' && cmdArgs[1] === 'remove') {
        throw new Error(`git worktree remove: cannot remove worktree at '${worktreePath}'`);
      }
      return '';
    });
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      chmodSync(worktreePath, 0o700); // restore write, or the temp tree leaks
    } catch {
      // best-effort
    }
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Drive one form and return its single `erroredStillListed` entry. */
  function runForm(args: string[]): SurvivorEntry {
    stdoutBuf = '';
    const code = main(args);
    expect(code).toBe(1); // an incomplete removal is still a visible failure
    const parsed = JSON.parse(stdoutBuf) as { erroredStillListed: SurvivorEntry[] };
    expect(parsed.erroredStillListed).toHaveLength(1);
    return parsed.erroredStillListed[0];
  }

  it('the FULL close-sweep form prints the survivors, their total, and the exclusively-denied verdict', () => {
    const entry = runForm(['worktree-cleanup', repo]);

    expect(entry.path).toBe(worktreePath);
    expect(entry.survivors).toBeDefined();
    // The REFUSED set, not an aborted tree (issue #621, ADR-0042 Amendment
    // decision 6): phase 1 now attempts every entry, so `src/index.ts` — which
    // sits in a writable subdirectory and was therefore always deletable — is
    // gone, and what survives is exactly what this fixture's permission bits
    // refuse: the two entries that would have to be unlinked from the
    // write-denied worktree directory itself. Before that change the delete
    // aborted at its first refusal and `src/index.ts` was never reached.
    expect(entry.survivors?.paths).toEqual(['README.md', 'src']);
    expect(entry.survivors?.total).toBe(2);
    // Ordinary deletable content survived, so the verdict is honestly `false`
    // — this obstruction is a permission bit on the directory, not the harness
    // deny list, and the TRANSIENT reading is the correct one for it.
    expect(entry.survivors?.exclusivelyDenied).toBe(false);
    // The worktree's own `.git` is excluded from the named set exactly as it is
    // from the verdict (expected FOR-86 scaffolding, evidence of nothing).
    expect(entry.survivors?.paths).not.toContain('.git');
  });

  it('the SCOPED single-branch form (--branches) reports the SAME evidence — a scoped close never sees less than an unscoped one', () => {
    const scoped = runForm(['worktree-cleanup', repo, '--branches', BRANCH]);
    const full = runForm(['worktree-cleanup', repo]);

    expect(scoped.survivors).toBeDefined();
    // Derived from the other form's own output rather than transcribed, so
    // this stays a PARITY assertion rather than two snapshots that happen to
    // agree — the same discipline the --detached dry-run parity test uses.
    expect(scoped.survivors).toEqual(full.survivors);
    expect(scoped.path).toBe(worktreePath);
  });
});

// ─── Form 8h: worktree-cleanup --detached — the CLI wiring (issues #238/#250;
//             co-located here from worktree-cleanup.spec.ts per issue #265) ──
//
// This block originally landed in worktree-cleanup.spec.ts (issue #250) purely
// because that slice's declared Files globs excluded this router spec file —
// leaving a router-level spec (driving `main([...])`) away from every OTHER
// `worktree-cleanup` CLI test (Forms 8/8b–8g above). Issue #265 moves it here
// verbatim in substance: only the module-local stdout/stderr capture was
// dropped in favor of this file's own shared `stdoutBuf`/`stderrBuf` (already
// installed by the top-level `beforeEach` near the top of this file). The
// ENGINE-level coverage of the sweep's own classification logic (locked /
// live-branch / dirty / orphan-with-real-files) and the count advisory's own
// unit tests stay in worktree-cleanup.spec.ts, unmoved.
//
// These specs drive the REAL CLI router (`main(['worktree-cleanup', …])`)
// against a REAL git repository, so the WIRING is what is under test, not the
// already-covered classification logic.
//
// The headline property is DRY-RUN PARITY, and it is structural rather than
// agreed: `runWorktreeCleanup` computes ONE `CleanupPlan` object above the
// `--dry-run` branch, prints its `selected`/`skipped` on the preview path and
// hands that same object to `executeCleanup` on the real path. The parity test
// below therefore derives its expectation from the preview's own output rather
// than transcribing a fixture, which is what makes it a parity assertion and not
// two independent snapshots that happen to match.
describe('worktree-cleanup --detached — CLI wiring + dry-run parity (issues #238/#250)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /** A real repo with a real worktrees root (same shape as worktree-cleanup.spec.ts's engine-level fixtures). */
  function makeRepo(label: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-cli-250-${label}-`)));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    writeFileSync(join(mainRoot, 'README.md'), '# fixture\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    return mainRoot;
  }

  /** Plant an un-prefixed DETACHED scratch checkout — the reviewer-made shape. */
  function plantDetached(mainRoot: string, name: string): string {
    const rel = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', '--detach', rel, 'HEAD'], mainRoot);
    return join(mainRoot, rel);
  }

  /** Plant a branch-bearing dispatch worktree — the sweep must refuse this. */
  function plantOnBranch(mainRoot: string, name: string, branch: string): string {
    const rel = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', rel, '-b', branch], mainRoot);
    return join(mainRoot, rel);
  }

  function stillRegistered(mainRoot: string, path: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line.trim() === `worktree ${path}`);
  }

  /** The shape both output paths carry for the detached sweep + the advisory. */
  type CleanupJson = {
    dryRun: boolean;
    removed?: Array<{ path: string }>;
    skipped?: Array<{ path: string; reason?: string }>;
    errors?: unknown[];
    detached?: {
      selected?: Array<{ path: string }>;
      removed?: Array<{ path: string }>;
      skipped: Array<{ path: string; reason?: string }>;
      errors?: unknown[];
      deregisteredNotDeleted?: unknown[];
      erroredStillListed?: unknown[];
    };
    orphans?: unknown;
    worktreeCount: {
      count: number;
      threshold: number;
      level: string;
      advisory: string | null;
    };
    commandLine: {
      bytes: number;
      argvBytes: number;
      envBytes: number;
      argCount: number;
      envCount: number;
      threshold: number;
      // The PER-STRING pair (issue #377) — the sibling of bytes/threshold for
      // execve's other independent E2BIG condition.
      maxEntryBytes: number;
      maxEntryThreshold: number;
      level: string;
      advisory: string | null;
    };
  };

  function parse(): CleanupJson {
    expect(stdoutBuf, `stderr was: ${stderrBuf}`).not.toBe('');
    return JSON.parse(stdoutBuf) as CleanupJson;
  }

  it('--dry-run --detached previews the sweep and removes NOTHING', () => {
    const mainRoot = makeRepo('preview');
    const scratch = plantDetached(mainRoot, 'review-250');

    const code = main(['worktree-cleanup', '--dry-run', '--detached', mainRoot]);

    expect(code).toBe(0);
    const parsed = parse();
    expect(parsed.dryRun).toBe(true);
    expect(parsed.detached?.selected?.map((w) => w.path)).toEqual([scratch]);
    // Nothing was touched: still on disk AND still registered with git.
    expect(existsSync(scratch)).toBe(true);
    expect(stillRegistered(mainRoot, scratch)).toBe(true);
  });

  it('the real run removes EXACTLY what the preview selected — one plan, derived expectation', () => {
    const mainRoot = makeRepo('parity');
    const scratch = plantDetached(mainRoot, 'review-250');
    const dirty = plantDetached(mainRoot, 'review-dirty');
    writeFileSync(join(dirty, 'work-in-progress.txt'), 'do not lose me\n');
    // Un-prefixed ON PURPOSE. A `wf_`/`agent-`-prefixed worktree belongs to the
    // name-allowlisted GC, which an unscoped (no --wave/--branches) run selects
    // for removal anyway and which the de-duplication then keeps out of the
    // detached candidates — so it could never demonstrate this sweep's own
    // `live-branch` refusal. An un-prefixed, branch-bearing checkout inside the
    // containment root is exactly the case only this sweep sees, and exactly the
    // one it must refuse.
    const live = plantOnBranch(mainRoot, 'review-live', 'wave/250-live');

    // 1. Preview.
    expect(main(['worktree-cleanup', '--dry-run', '--detached', mainRoot])).toBe(0);
    const preview = parse();
    const previewSelected = (preview.detached?.selected ?? [])
      .map((w) => w.path)
      .sort();
    const previewSkipped = new Map(
      (preview.detached?.skipped ?? []).map((w) => [w.path, w.reason]),
    );

    // 2. The same invocation without --dry-run.
    stdoutBuf = '';
    expect(main(['worktree-cleanup', '--detached', mainRoot])).toBe(0);
    const run = parse();

    // THE parity assertion: the removed set is the previewed set, and the
    // expectation is READ OFF the preview rather than transcribed here.
    expect((run.detached?.removed ?? []).map((w) => w.path).sort()).toEqual(
      previewSelected,
    );
    // ...and the refusals carry over verbatim, reason included.
    expect(
      new Map((run.detached?.skipped ?? []).map((w) => [w.path, w.reason])),
    ).toEqual(previewSkipped);

    // Sanity on the fixture itself, so the parity above cannot be vacuous:
    // exactly one sweepable checkout, and both refusals named by reason.
    expect(previewSelected).toEqual([scratch]);
    expect(previewSkipped.get(dirty)).toBe('dirty');
    expect(previewSkipped.get(live)).toBe('live-branch');

    // Real outcomes on disk.
    expect(existsSync(scratch)).toBe(false);
    expect(stillRegistered(mainRoot, scratch)).toBe(false);
    expect(existsSync(dirty)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(stillRegistered(mainRoot, live)).toBe(true);
    expect(run.detached?.errors).toEqual([]);
    expect(run.detached?.deregisteredNotDeleted).toEqual([]);
    expect(run.detached?.erroredStillListed).toEqual([]);
  });

  it('negative control — WITHOUT --detached the key is absent and the detached checkout survives a real run', () => {
    // Proves the flag is what reaches the sweep. Pre-#250 this was the ONLY
    // behaviour available: the verb could not sweep a detached checkout at all.
    const mainRoot = makeRepo('nodetach');
    const scratch = plantDetached(mainRoot, 'review-250');

    const code = main(['worktree-cleanup', mainRoot]);

    expect(code).toBe(0);
    const parsed = parse();
    expect(parsed.detached).toBeUndefined();
    expect(parsed.removed).toEqual([]);
    expect(existsSync(scratch)).toBe(true);
    expect(stillRegistered(mainRoot, scratch)).toBe(true);
  });

  it('a DETACHED wf_* worktree qualifies for both populations yet is removed exactly ONCE (no double-remove error)', () => {
    // The overlap the de-duplication exists for: a `wf_`-prefixed worktree on a
    // DETACHED head is a candidate for the name-allowlisted GC *and* for the
    // containment-scoped detached sweep. Two executeCleanup calls over one path
    // would remove it, then fail to remove it again — a spurious `errors` entry
    // for a worktree that was in fact cleaned correctly.
    const mainRoot = makeRepo('dedupe');
    const rel = join('.claude', 'worktrees', 'wf_250-detached');
    realGit(['worktree', 'add', '-q', '--detach', rel, 'HEAD'], mainRoot);
    const both = join(mainRoot, rel);

    const code = main(['worktree-cleanup', '--detached', mainRoot]);

    expect(code).toBe(0);
    const parsed = parse();
    // Accounted for once, by the registered GC (which saw it first).
    expect(parsed.removed?.map((w) => w.path)).toEqual([both]);
    expect((parsed.detached?.removed ?? []).map((w) => w.path)).toEqual([]);
    expect(parsed.detached?.skipped).toEqual([]);
    // No second removal attempt, therefore no error from one.
    expect(parsed.errors).toEqual([]);
    expect(parsed.detached?.errors).toEqual([]);
    expect(existsSync(both)).toBe(false);
  });

  it('--detached composes with --orphans: both sweeps report under their own keys', () => {
    const mainRoot = makeRepo('compose');
    const scratch = plantDetached(mainRoot, 'review-250');
    // A never-registered leftover dir under the recognized prefix → orphan sweep.
    const orphan = join(mainRoot, '.claude', 'worktrees', 'wf_250-orphan');
    mkdirSync(orphan, { recursive: true });

    const code = main([
      'worktree-cleanup',
      '--dry-run',
      '--detached',
      '--orphans',
      mainRoot,
    ]);

    expect(code).toBe(0);
    const parsed = parse();
    expect(parsed.detached?.selected?.map((w) => w.path)).toEqual([scratch]);
    expect(parsed.orphans).toBeDefined();
  });

  it('--detached is a recognized flag — it never falls through to the unknown-flag guard', () => {
    const mainRoot = makeRepo('flagvocab');
    expect(main(['worktree-cleanup', '--detached', mainRoot])).toBe(0);
    expect(stderrBuf).not.toMatch(/unknown flag/);
  });

  // ─── the worktree-count advisory on the CLI JSON (issue #250) ──────────────

  it('worktreeCount rides BOTH output shapes with count, threshold, level and advisory as named fields', () => {
    const mainRoot = makeRepo('advisory-ok');
    plantDetached(mainRoot, 'review-250');

    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const preview = parse();
    // primary checkout + one planted worktree
    expect(preview.worktreeCount.count).toBe(2);
    expect(preview.worktreeCount.threshold).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD);
    expect(preview.worktreeCount.level).toBe('ok');
    expect(preview.worktreeCount.advisory).toBeNull();

    stdoutBuf = '';
    expect(main(['worktree-cleanup', mainRoot])).toBe(0);
    // Unconditional — no flag to remember, and present on the real-run shape too.
    expect(parse().worktreeCount.threshold).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD);
  });

  it('over the threshold: level is advisory and `advisory` carries the ENGINE message verbatim', () => {
    const mainRoot = makeRepo('advisory-fires');
    // Deliberately OUTSIDE the worktrees root, so this population is about the
    // COUNT only and cannot interact with either sweep.
    mkdirSync(join(mainRoot, 'probes'), { recursive: true });
    for (let i = 0; i <= WORKTREE_COUNT_ADVISORY_THRESHOLD; i++) {
      realGit(
        ['worktree', 'add', '-q', '--detach', join('probes', `probe-${i}`), 'HEAD'],
        mainRoot,
      );
    }

    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const parsed = parse();

    expect(parsed.worktreeCount.count).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD + 2);
    expect(parsed.worktreeCount.level).toBe('advisory');
    // The rename (`message` → `advisory`) is pinned to the engine's own output
    // for the SAME repo, so the CLI boundary can never paraphrase the wording
    // the engine owns (the E2BIG shape, its subagent scope, the RESTART step).
    expect(parsed.worktreeCount.advisory).toBe(
      checkWorktreeCountAdvisory({ repoRoot: mainRoot }).message,
    );
    expect(parsed.worktreeCount.advisory).toContain('E2BIG');
    expect(parsed.worktreeCount.advisory).toContain('RESTART');
  });

  it('the advisory is ADVISORY: an over-threshold population still exits 0', () => {
    const mainRoot = makeRepo('advisory-not-a-gate');
    mkdirSync(join(mainRoot, 'probes'), { recursive: true });
    for (let i = 0; i <= WORKTREE_COUNT_ADVISORY_THRESHOLD; i++) {
      realGit(
        ['worktree', 'add', '-q', '--detach', join('probes', `probe-${i}`), 'HEAD'],
        mainRoot,
      );
    }

    // A REAL run (not a dry run) — the verb's exit code must ignore the level.
    const code = main(['worktree-cleanup', mainRoot]);

    expect(code).toBe(0);
    expect(parse().worktreeCount.level).toBe('advisory');
  });

  // ─── the command-line term rides beside it (issue #266) ────────────────────
  //
  // The count above models only the harness-injected half of the exec argument
  // budget. The live occurrence blew the OTHER half — ~1019.5 KB of command
  // line across 3 args, with only 15 of 166 sandbox deny paths worktree-derived
  // — so this verb's own sweep would have moved nothing. Both terms therefore
  // print side by side, and these specs pin that they do.

  /** The name is spec-local and its VALUE is never asserted on — only its size. */
  const BIG_ENV_KEY = 'FLOTILLA_SPEC_E2BIG_PROBE';

  /** Run `body` with an oversized environment entry, always removed afterwards. */
  function withOversizedEnv<T>(body: () => T): T {
    process.env[BIG_ENV_KEY] = 'z'.repeat(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES + 1,
    );
    try {
      return body();
    } finally {
      delete process.env[BIG_ENV_KEY];
    }
  }

  it('commandLine rides BOTH output shapes with every measured field named', () => {
    const mainRoot = makeRepo('cmdline-shape');

    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const preview = parse();
    expect(preview.commandLine.threshold).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(preview.commandLine.bytes).toBe(
      preview.commandLine.argvBytes + preview.commandLine.envBytes,
    );
    expect(preview.commandLine.argCount).toBeGreaterThan(0);
    expect(preview.commandLine.envCount).toBeGreaterThan(0);
    // The same message-null-iff-ok contract `worktreeCount.advisory` carries.
    expect(preview.commandLine.advisory === null).toBe(
      preview.commandLine.level === 'ok',
    );

    stdoutBuf = '';
    expect(main(['worktree-cleanup', mainRoot])).toBe(0);
    // Unconditional — no flag to remember, and present on the real-run shape too.
    expect(parse().commandLine.threshold).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
  });

  it('NEGATIVE CONTROL — an ordinary invocation reports commandLine `ok` with no advisory', () => {
    // Without this the field could be permanently firing and the assertions
    // below would still pass. The engine's own test suite runs with a normal
    // environment, so this is the honest baseline.
    const mainRoot = makeRepo('cmdline-quiet');
    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const parsed = parse();
    expect(parsed.commandLine.level).toBe('ok');
    expect(parsed.commandLine.advisory).toBeNull();
  });

  it('THE two-term proof at the CLI boundary: a clean worktreeCount beside a firing commandLine', () => {
    // Exactly the live occurrence's shape, at the seam an operator actually
    // reads: the population this verb sweeps is pristine, and the spawn is
    // already over budget. A report that printed only `worktreeCount` here
    // would have said "all clear" to a session that could not spawn.
    const mainRoot = makeRepo('cmdline-fires');

    const parsed = withOversizedEnv(() => {
      expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
      const json = parse();
      // Derived from the engine IN THE SAME process/env, so the CLI boundary
      // can never paraphrase the wording the engine owns.
      expect(json.commandLine.advisory).toBe(checkCommandLineSizeAdvisory().message);
      return json;
    });

    expect(parsed.worktreeCount.level).toBe('ok');
    expect(parsed.commandLine.level).toBe('advisory');
    expect(parsed.commandLine.envBytes).toBeGreaterThan(
      COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
    );
    expect(parsed.commandLine.advisory).toContain('E2BIG');
    expect(parsed.commandLine.advisory).toContain(
      'SWEEPING WORKTREES DOES NOT MOVE THIS TERM',
    );
    // ...and the count advisory, when it does fire, now says the same thing
    // from its own side (the correction to its threshold guidance).
    expect(
      checkWorktreeCountAdvisory({
        repoRoot: mainRoot,
        threshold: 0,
      }).message,
    ).toContain('COUNT IS ONLY ONE OF TWO TERMS');
  });

  it('the command-line advisory is ADVISORY too: an over-threshold spawn still exits 0', () => {
    const mainRoot = makeRepo('cmdline-not-a-gate');
    const code = withOversizedEnv(() => main(['worktree-cleanup', mainRoot]));
    expect(code).toBe(0);
    expect(parse().commandLine.level).toBe('advisory');
  });

  it('SECRET-SAFE — the printed JSON carries byte counts, never an argument or a variable', () => {
    const mainRoot = makeRepo('cmdline-secret-safe');
    withOversizedEnv(() => {
      expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    });
    // The whole stdout buffer, not just the parsed field: nothing anywhere in
    // the output names the environment entry that tripped the advisory.
    expect(stdoutBuf).not.toContain(BIG_ENV_KEY);
    expect(stdoutBuf).not.toContain('zzzzzzzzzz');
    expect(parse().commandLine.level).toBe('advisory');
  });

  // ─── the PER-STRING term's two NUMBERS reach the JSON too (issue #377) ─────
  //
  // execve documents E2BIG on TWO independent conditions and the engine models
  // both (issue #340) — but this CLI printed only one of them in numbers. The
  // per-string VERDICT did reach an operator, folded into `level` and stated in
  // the verbatim `advisory` prose; `maxEntryBytes` and `maxEntryThreshold`, the
  // two numbers a MACHINE reader needs to act on that verdict, were not
  // readable from this JSON at all. That is the same "ships the correction's
  // premise, withholds the correction" shape issue #357 closed one layer up at
  // the package root, recurring at the boundary a skill actually parses.

  /**
   * Plant a single entry over the PER-STRING budget but far under the TOTAL —
   * the one shape a total-only reader calls clear. Sized from the engine's own
   * constant, so this fixture cannot drift away from the budget it probes.
   */
  function withOversizedSingleEntry<T>(body: () => T): T {
    process.env[BIG_ENV_KEY] = 'q'.repeat(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES + 1,
    );
    try {
      return body();
    } finally {
      delete process.env[BIG_ENV_KEY];
    }
  }

  it('maxEntryBytes and maxEntryThreshold ride BOTH output shapes, carrying the ENGINE numbers', () => {
    const mainRoot = makeRepo('cmdline-perstring-shape');

    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const preview = parse();
    expect(preview.commandLine.maxEntryThreshold).toBe(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
    // DERIVED from the engine in the same process/env rather than transcribed:
    // this boundary's job is transport, and this is the assertion that fails the
    // day it becomes arithmetic of its own.
    expect(preview.commandLine.maxEntryBytes).toBe(
      checkCommandLineSizeAdvisory().maxEntryBytes,
    );

    stdoutBuf = '';
    expect(main(['worktree-cleanup', mainRoot])).toBe(0);
    // Unconditional — no flag to remember, and present on the real-run shape too.
    expect(parse().commandLine.maxEntryThreshold).toBe(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
  });

  it('the addition is PURELY ADDITIVE — the key set grows by exactly two names and nothing is re-pointed', () => {
    const mainRoot = makeRepo('cmdline-perstring-additive');
    expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    const { commandLine } = parse();

    // ENUMERATION: the pre-#377 key set plus exactly the two per-string names.
    // A rename anywhere in the object fails here, and so does a third field
    // riding along unnoticed on a surface consumers already read.
    expect(Object.keys(commandLine).sort()).toEqual([
      'advisory',
      'argCount',
      'argvBytes',
      'bytes',
      'envBytes',
      'envCount',
      'level',
      'maxEntryBytes',
      'maxEntryThreshold',
      'threshold',
    ]);

    // MEANING: `bytes` is still the TOTAL and `threshold` still the TOTAL
    // budget — neither was quietly re-pointed at the per-string term.
    expect(commandLine.bytes).toBe(
      commandLine.argvBytes + commandLine.envBytes,
    );
    expect(commandLine.threshold).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    // TYPE: both additions are numbers, not prose (the form the verdict already
    // had, and the one that made it unreadable to a machine).
    expect(typeof commandLine.maxEntryBytes).toBe('number');
    expect(typeof commandLine.maxEntryThreshold).toBe('number');
    // Two DISTINCT budgets, not one number under two names — the single way a
    // per-string "addition" could be present and still useless.
    expect(commandLine.maxEntryThreshold).not.toBe(commandLine.threshold);
    // A single entry can never exceed the total it is counted into.
    expect(commandLine.maxEntryBytes).toBeLessThanOrEqual(commandLine.bytes);
  });

  it('THE per-string proof at the CLI boundary: the numbers say WHY a total-clean spawn reads advisory', () => {
    const mainRoot = makeRepo('cmdline-perstring-fires');

    const parsed = withOversizedSingleEntry(() => {
      expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
      const json = parse();
      // Derived from the engine IN THE SAME process/env, so the CLI can never
      // paraphrase or recompute the number the engine owns.
      expect(json.commandLine.maxEntryBytes).toBe(
        checkCommandLineSizeAdvisory().maxEntryBytes,
      );
      return json;
    });

    // The TOTAL really is under budget — without this the story would prove
    // nothing the total term did not already catch.
    expect(parsed.commandLine.bytes).toBeLessThan(parsed.commandLine.threshold);
    // ...and the spawn is over the OTHER budget, which is now readable as two
    // numbers instead of only as level-plus-prose.
    expect(parsed.commandLine.maxEntryBytes).toBeGreaterThan(
      parsed.commandLine.maxEntryThreshold,
    );
    expect(parsed.commandLine.level).toBe('advisory');
    // The population this verb actually sweeps is pristine — the same two-term
    // proof the total case makes, for the condition sweeping cannot move either.
    expect(parsed.worktreeCount.level).toBe('ok');
    // The prose still names the condition; the point is that it is no longer the
    // ONLY place the per-string term is stated.
    expect(parsed.commandLine.advisory).toContain('MAX_ARG_STRLEN');
  });

  it('SECRET-SAFE — the per-string numbers name no argument and no variable either', () => {
    const mainRoot = makeRepo('cmdline-perstring-secret-safe');
    withOversizedSingleEntry(() => {
      expect(main(['worktree-cleanup', '--dry-run', mainRoot])).toBe(0);
    });
    // The whole stdout buffer: `maxEntryBytes` is derived from the LARGEST
    // entry, which is exactly the entry most tempting to name in a report.
    expect(stdoutBuf).not.toContain(BIG_ENV_KEY);
    expect(stdoutBuf).not.toContain('qqqqqqqqqq');
    expect(parse().commandLine.maxEntryBytes).toBeGreaterThan(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
  });
});

// ─── Form 8j: worktree-cleanup --detached — `cleanup.extraRoots` from --config
//             reaches the detached sweep (issue #451) ─────────────────────────
//
// The gap this closes, reported by the FIRST installed-form consumer and
// reproduced independently by the maintainer on main. `DetachedSweepOptions`
// has documented `extraRoots` since the sweep landed — ADDITIONAL containment
// roots, absolute or repo-root-relative, unioned with the marker-derived ones —
// as the declared way for a consumer whose agents make their scratch checkouts
// somewhere other than the worktrees root to have them swept. But the option
// was reachable from the LIBRARY API only: `CleanupConfig` carried
// `disposableNames` and nothing else, so the CONFIGURED path — the
// `worktree-cleanup --detached --config <path>` invocation wave-close's phase 3
// actually runs — could not declare such a root at all. An out-of-root detached
// scratch checkout therefore stayed registered indefinitely: counted by the
// `worktreeCount` advisory (which reads `git worktree list` whole), selected by
// nothing, with BOTH `detached` arrays empty. That exact reading is the
// negative control below.
//
// The consumer posture that makes this recurring rather than exotic: the
// reviewer probe license prescribes `git worktree add`, and where a tracked file
// sits on a sandbox write-deny list an IN-repo checkout aborts — so an
// outside-the-worktrees-root probe is the natural workaround, made over and
// over, by design.
//
// Same discipline as Form 8g (the `cleanup.disposableNames` wiring): a REAL git
// repository, a REAL `--config` file on disk, and the REAL router
// (`main([...])`), so the WIRING is what is under test — never the engine's own
// containment/classification logic, which worktree-cleanup.spec.ts already
// covers unmodified.
describe('worktree-cleanup --detached — --config cleanup.extraRoots reaches the detached sweep (issue #451)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /** A real repo with a real (marker-derived) worktrees root. */
  function makeRepo(label: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-cli-451-${label}-`)));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    writeFileSync(join(mainRoot, 'README.md'), '# fixture\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    return mainRoot;
  }

  /**
   * Plant a DETACHED scratch checkout at a repo-root-relative path. Used both
   * for the OUT-of-root probe (`scratchpad/probe-451` — the reported shape) and
   * for a checkout under the marker-derived root, so the union property below
   * can be shown with one helper.
   */
  function plantDetachedAt(mainRoot: string, relDir: string): string {
    realGit(['worktree', 'add', '-q', '--detach', relDir, 'HEAD'], mainRoot);
    return join(mainRoot, relDir);
  }

  /** A `wave.config.json` carrying a raw `cleanup` object, verbatim. */
  function writeCleanupConfig(cleanup: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'wave-cli-451-cfg-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        store: { kind: 'markdown', repoRoot: '.', slug: 'x' },
        cleanup,
      }),
      'utf-8',
    );
    return cfgPath;
  }

  type DetachedJson = {
    dryRun: boolean;
    detached?: {
      selected?: Array<{ path: string }>;
      removed?: Array<{ path: string }>;
      skipped: Array<{ path: string; reason?: string }>;
      errors?: unknown[];
    };
    worktreeCount: { count: number };
  };

  function parse(): DetachedJson {
    expect(stdoutBuf, `stderr was: ${stderrBuf}`).not.toBe('');
    return JSON.parse(stdoutBuf) as DetachedJson;
  }

  it('a detached checkout under a declared extra root is SELECTED in the preview and removed by the run — one shared plan', () => {
    const mainRoot = makeRepo('declared');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));
    const configPath = writeCleanupConfig({ extraRoots: ['scratchpad'] });

    // 1. Preview.
    expect(
      main(['worktree-cleanup', '--dry-run', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    const preview = parse();
    const previewSelected = (preview.detached?.selected ?? []).map((w) => w.path).sort();
    expect(previewSelected).toEqual([outside]);
    // A preview removes nothing — still on disk AND still registered.
    expect(existsSync(outside)).toBe(true);

    // 2. The same invocation without --dry-run.
    stdoutBuf = '';
    expect(
      main(['worktree-cleanup', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    const run = parse();

    // THE parity assertion, derived from the preview's own output rather than
    // transcribed: preview and execution share ONE plan object, computed above
    // the --dry-run branch, so this cannot pass by agreement.
    expect((run.detached?.removed ?? []).map((w) => w.path).sort()).toEqual(
      previewSelected,
    );
    expect(run.detached?.errors).toEqual([]);
    expect(existsSync(outside)).toBe(false);
  });

  it('NEGATIVE CONTROL — the identical fixture with NO declaration leaves the checkout strictly alone (the maintainer repro)', () => {
    // The conservative default, and the exact reading reported from the field:
    // the probe IS registered (worktreeCount counts it), and both detached
    // arrays are empty — nothing selected, nothing skipped, nothing to act on.
    const mainRoot = makeRepo('undeclared');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));

    const code = main(['worktree-cleanup', '--detached', mainRoot]);

    expect(code).toBe(0);
    const parsed = parse();
    expect(parsed.worktreeCount.count).toBe(2); // primary checkout + the probe
    expect(parsed.detached?.removed ?? []).toEqual([]);
    expect(parsed.detached?.skipped ?? []).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });

  it('an ABSOLUTE declared root works identically to a repo-root-relative one', () => {
    const mainRoot = makeRepo('absolute');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));
    const configPath = writeCleanupConfig({
      extraRoots: [join(mainRoot, 'scratchpad')],
    });

    expect(
      main(['worktree-cleanup', '--dry-run', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    expect((parse().detached?.selected ?? []).map((w) => w.path)).toEqual([outside]);
  });

  it('a declared root is UNIONED with the marker-derived one, never a replacement', () => {
    // Both populations in ONE run: the ordinary `.claude/worktrees` scratch
    // checkout the sweep already reached, and the out-of-root one only a
    // declaration reaches. A declaration that REPLACED the marker-derived root
    // would silently stop sweeping the population this verb was written for.
    const mainRoot = makeRepo('union');
    const inRoot = plantDetachedAt(mainRoot, join('.claude', 'worktrees', 'review-451'));
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));
    const configPath = writeCleanupConfig({ extraRoots: ['scratchpad'] });

    expect(
      main(['worktree-cleanup', '--dry-run', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    expect((parse().detached?.selected ?? []).map((w) => w.path).sort()).toEqual(
      [inRoot, outside].sort(),
    );
  });

  it('a MALFORMED cleanup.extraRoots fails loud (exit 1) and sweeps nothing', () => {
    // The schema's existing error style: a bad declaration is refused at
    // config-load time, so the operator learns why cleanup did not honour it
    // instead of getting a quietly narrower sweep.
    const mainRoot = makeRepo('malformed');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));
    const configPath = writeCleanupConfig({ extraRoots: 'scratchpad' });

    const code = main(['worktree-cleanup', '--detached', mainRoot, '--config', configPath]);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/could not load --config/);
    expect(stderrBuf).toMatch(/cleanup\.extraRoots/);
    expect(stdoutBuf).toBe('');
    expect(existsSync(outside)).toBe(true);
  });

  it('a non-string ENTRY in cleanup.extraRoots is refused the same way, naming the index', () => {
    const mainRoot = makeRepo('malformed-entry');
    const configPath = writeCleanupConfig({ extraRoots: ['scratchpad', 7] });

    const code = main(['worktree-cleanup', '--detached', mainRoot, '--config', configPath]);

    expect(code).toBe(1);
    // `wave config "cleanup.extraRoots"[1] must be a string` — the
    // quoted-label-then-index shape `normalizeDisposableNames` already prints
    // for its own bad entries, so an operator reads one error style, not two.
    expect(stderrBuf).toMatch(/cleanup\.extraRoots"\[1\]/);
    expect(stdoutBuf).toBe('');
  });

  it('a --config declaring only disposableNames keeps the pre-existing behaviour byte-identical', () => {
    // The additive guarantee at the CLI seam: an existing consumer config that
    // never heard of the new key behaves exactly as it did before it existed.
    const mainRoot = makeRepo('additive');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-451'));
    const configPath = writeCleanupConfig({ disposableNames: ['.build'] });

    expect(
      main(['worktree-cleanup', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    const parsed = parse();
    expect(parsed.detached?.removed ?? []).toEqual([]);
    expect(parsed.detached?.skipped ?? []).toEqual([]);
    expect(existsSync(outside)).toBe(true);
  });
});

// ─── Form 8k: worktree-cleanup — `unaccounted`, the count-vs-lists
//             reconciliation (issue #557, ADR-0042) ──────────────────────────
//
// Form 8j directly above ends at the conservative default: an out-of-root
// detached checkout with no declaration is "left strictly alone", and its
// negative control asserts the exact reading reported from the field — the
// count includes it, both `detached` arrays are empty. That reading is quiet by
// construction, and the only remedy the docs could offer was a HAND-DIFF of
// `worktreeCount.count` against the union of every array in this JSON.
//
// The live occurrence that made it a ticket (2026-08-14 wave close): the
// leftover was a Reviewer's probe checkout in the agent session's own
// SCRATCHPAD, whose path carries a per-session identifier — so
// `cleanup.extraRoots` (static strings) structurally cannot name it, and the
// documented remedy does not apply at all. ADR-0042 Decision 1: for residue the
// sweep cannot see, its duty is to NAME it; removal authority stays with the
// Operator.
//
// Same discipline as Form 8j: a REAL git repository, a REAL `--config` on disk,
// the REAL router — the WIRING and the REPORT SURFACE are what is under test,
// never the engine's own reconciliation logic (worktree-cleanup.spec.ts §30b/c).
describe('worktree-cleanup — `unaccounted` names what no sweep list accounts for (issue #557)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  function makeRepo(label: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-cli-557-${label}-`)));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    writeFileSync(join(mainRoot, 'README.md'), '# fixture\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    return mainRoot;
  }

  /** Plant a DETACHED scratch checkout at a repo-root-relative path. */
  function plantDetachedAt(mainRoot: string, relDir: string): string {
    realGit(['worktree', 'add', '-q', '--detach', relDir, 'HEAD'], mainRoot);
    return join(mainRoot, relDir);
  }

  function writeCleanupConfig(cleanup: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'wave-cli-557-cfg-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({ store: { kind: 'markdown', repoRoot: '.', slug: 'x' }, cleanup }),
      'utf-8',
    );
    return cfgPath;
  }

  type UnaccountedJson = {
    dryRun: boolean;
    errors?: unknown[];
    deregisteredNotDeleted?: unknown[];
    erroredStillListed?: unknown[];
    detached?: {
      selected?: Array<{ path: string }>;
      removed?: Array<{ path: string }>;
      skipped: Array<{ path: string }>;
      errors?: unknown[];
    };
    worktreeCount: { count: number; level: string };
    unaccounted: {
      entries: Array<{ path: string; branch: string | null; prunable: boolean }>;
      level: 'ok' | 'advisory';
      notice: string | null;
    };
  };

  function parse(): UnaccountedJson {
    expect(stdoutBuf, `stderr was: ${stderrBuf}`).not.toBe('');
    return JSON.parse(stdoutBuf) as UnaccountedJson;
  }

  it('a checkout outside every containment root is NAMED, on both shapes, while both `detached` arrays stay empty', () => {
    // The reported reading, now with the discrepancy said out loud rather than
    // left to a hand-diff: the sweep still (correctly) never considered it, and
    // the count still includes it — but a LIST now names it.
    const mainRoot = makeRepo('out-of-root');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-557'));

    for (const args of [
      ['worktree-cleanup', '--dry-run', '--detached', '--orphans', mainRoot],
      ['worktree-cleanup', '--detached', '--orphans', mainRoot],
    ]) {
      stdoutBuf = '';
      expect(main(args)).toBe(0);
      const parsed = parse();

      expect(parsed.worktreeCount.count).toBe(2); // primary checkout + the probe
      expect(parsed.detached?.selected ?? []).toEqual([]);
      expect(parsed.detached?.removed ?? []).toEqual([]);
      expect(parsed.detached?.skipped ?? []).toEqual([]);

      expect(parsed.unaccounted.entries).toEqual([
        { path: outside, branch: null, prunable: false },
      ]);
      expect(parsed.unaccounted.level).toBe('advisory');
      // AC4 — a notice line rides the non-empty list, on the same pattern
      // `worktreeCount.advisory` established, and it NAMES the path.
      expect(parsed.unaccounted.notice).toContain(outside);
      expect(parsed.unaccounted.notice).toContain('ADVISORY, NEVER A FAILURE');
      // Nothing was removed by either shape — this is accounting, not a sweep.
      expect(existsSync(outside)).toBe(true);
    }
  });

  it('declaring the root in `cleanup.extraRoots` moves it OUT of `unaccounted` and INTO the detached sweep', () => {
    // The other direction of the same fixture. Without it, the test above could
    // pass for a reason unrelated to containment — e.g. a field that names every
    // worktree it sees regardless of whether a population owns it.
    const mainRoot = makeRepo('declared');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-557'));
    const configPath = writeCleanupConfig({ extraRoots: ['scratchpad'] });

    expect(
      main(['worktree-cleanup', '--dry-run', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    const preview = parse();
    expect((preview.detached?.selected ?? []).map((w) => w.path)).toEqual([outside]);
    expect(preview.unaccounted.entries).toEqual([]);
    expect(preview.unaccounted.level).toBe('ok');
    expect(preview.unaccounted.notice).toBeNull();

    // ...and on the real run, which removes it: still nothing left over.
    stdoutBuf = '';
    expect(
      main(['worktree-cleanup', '--detached', mainRoot, '--config', configPath]),
    ).toBe(0);
    const run = parse();
    expect((run.detached?.removed ?? []).map((w) => w.path)).toEqual([outside]);
    expect(run.unaccounted.entries).toEqual([]);
  });

  it('ADVISORY, NEVER A FAILURE: a non-empty `unaccounted` with everything else clean still exits 0', () => {
    // ADR-0042 Decision 3, asserted at the seam where the exit contract lives.
    // The set has a legitimate permanent inhabitant (a human's own long-lived
    // second worktree), so a red close would push exactly the wrong fix.
    const mainRoot = makeRepo('advisory-exit');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-557'));
    // A human's own second worktree, ON A BRANCH, outside the worktrees root —
    // the inhabitant the decision protects, in the same run.
    realGit(['worktree', 'add', '-q', '-b', 'feature/human', join('..', 'human-wt')], mainRoot);

    const code = main(['worktree-cleanup', '--detached', '--orphans', mainRoot]);

    const parsed = parse();
    expect(parsed.unaccounted.entries.map((e) => e.path).sort()).toEqual(
      [outside, realpathSync(join(mainRoot, '..', 'human-wt'))].sort(),
    );
    expect(parsed.unaccounted.entries.some((e) => e.branch === 'feature/human')).toBe(true);
    // Every failure class the verb DOES exit 1 for is empty...
    expect(parsed.errors).toEqual([]);
    expect(parsed.deregisteredNotDeleted).toEqual([]);
    expect(parsed.erroredStillListed).toEqual([]);
    expect(parsed.detached?.errors ?? []).toEqual([]);
    // ...so the exit code is unchanged by the non-empty advisory list.
    expect(code).toBe(0);
  });

  it('a STALE registration — the directory already gone — is reported `prunable`, with `git worktree prune` named', () => {
    const mainRoot = makeRepo('stale');
    const outside = plantDetachedAt(mainRoot, join('scratchpad', 'probe-557'));
    rmSync(outside, { recursive: true, force: true });

    expect(main(['worktree-cleanup', '--detached', '--orphans', mainRoot])).toBe(0);
    const parsed = parse();

    expect(parsed.unaccounted.entries).toEqual([
      { path: outside, branch: null, prunable: true },
    ]);
    expect(parsed.unaccounted.notice).toContain('git worktree prune');
  });

  it('a repo whose every registration IS accounted for reports an EMPTY, `ok` reconciliation (negative control)', () => {
    // The field must be able to say "nothing left over" — otherwise every close
    // would carry a standing advisory and the signal would be worthless. An
    // ordinary wave worktree (name-prefixed, on a branch) belongs to the
    // registered-GC LISTING even when a `--wave` filter excludes it from the
    // plan, which is why the accounting is declared off the listing.
    const mainRoot = makeRepo('all-accounted');
    realGit(
      ['worktree', 'add', '-q', join('.claude', 'worktrees', 'wf_557'), '-b', 'wave/557-x'],
      mainRoot,
    );

    expect(
      main(['worktree-cleanup', '--dry-run', '--detached', '--orphans', mainRoot]),
    ).toBe(0);
    const parsed = parse();
    expect(parsed.worktreeCount.count).toBe(2);
    expect(parsed.unaccounted).toEqual({ entries: [], level: 'ok', notice: null });
  });
});

// ─── Form 8i: worktree-cleanup --detached — a SEEDED removal failure proves
//             the sweep's OWN nonzero-exit-code contribution directly (issue
//             #265) ──────────────────────────────────────────────────────────
//
// Prior to this slice the only evidence that a failing detached-sweep removal
// flips the verb's exit code was a SIDE EFFECT of the de-duplication test above
// ("removed exactly ONCE (no double-remove error)") — that test's own comment
// names the counterfactual ("a spurious `errors` entry ... would fail") but
// never actually seeds it: it exercises the happy de-dup path, not a genuine
// failure. This block seeds one directly, isolated from every other population
// (no --orphans, no agent-/wf_-prefixed worktree, so the registered GC selects
// nothing and cannot itself contribute a failure) so the observed nonzero exit
// is attributable to the detached sweep ALONE.
//
// The fixture: a REAL detached scratch checkout is planted and genuinely,
// physically removed (node:fs is not mocked here — `defaultWorktreeRemover`'s
// own `rmSync`-based delete runs for real); only the git-level DEREGISTRATION
// call for that exact path (`git worktree remove <path>`) is intercepted to
// throw — an equivalent fixture to Form 8d's FOR-73 pattern above, scoped to
// the detached population instead of the registered one. Because the
// directory is genuinely gone by the time the mocked `git worktree remove` is
// asked to deregister it, git's own admin entry survives untouched and a REAL
// `git worktree list --porcelain` still lists the path (prunable) — the exact
// erroredStillListed (FOR-73) shape, not a generic error, driven end-to-end
// through the real git binary rather than a hand-built porcelain fixture.
describe('worktree-cleanup --detached — a seeded removal failure is a DEDICATED nonzero-exit proof (issue #265)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = actual.execFileSync;
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  function makeRepo(label: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-cli-265-${label}-`)));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    writeFileSync(join(mainRoot, 'README.md'), '# fixture\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    return mainRoot;
  }

  function plantDetached(mainRoot: string, name: string): string {
    const rel = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', '--detach', rel, 'HEAD'], mainRoot);
    return join(mainRoot, rel);
  }

  it('a seeded git-level deregistration failure on the ONE detached candidate lands in detached.erroredStillListed and exits 1', () => {
    const mainRoot = makeRepo('seeded-failure');
    const scratch = plantDetached(mainRoot, 'review-265');

    // Every OTHER git call (worktree list/status/rev-parse, and the real
    // physical `rmSync` delete via node:fs, which is not mocked in this file)
    // proceeds for real; only the deregistration call for THIS exact path is
    // made to fail, mirroring a genuine `git worktree remove` failure (e.g. a
    // racing actor re-creating debris between our physical delete and git's
    // own bookkeeping update).
    asExecFileSyncMock(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (
        cmdArgs[0] === 'worktree' &&
        cmdArgs[1] === 'remove' &&
        cmdArgs[2] === scratch
      ) {
        throw new Error(
          `git worktree remove: cannot remove worktree at '${scratch}': Directory not empty`,
        );
      }
      return (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args);
    });

    const code = main(['worktree-cleanup', '--detached', mainRoot]);

    expect(code).toBe(1);
    const parsed = JSON.parse(stdoutBuf) as {
      removed: unknown[];
      errors: unknown[];
      detached?: {
        removed: unknown[];
        errors: unknown[];
        erroredStillListed: Array<{ path: string }>;
        deregisteredNotDeleted: unknown[];
      };
    };
    // Isolated to the detached population: the registered GC and top-level
    // errors both stay empty, so the failure is attributable to the sweep this
    // test targets and nothing else.
    expect(parsed.removed).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.detached?.erroredStillListed.map((w) => w.path)).toEqual([
      scratch,
    ]);
    expect(parsed.detached?.errors).toEqual([]);
    expect(parsed.detached?.removed).toEqual([]);
    expect(parsed.detached?.deregisteredNotDeleted).toEqual([]);
    // The directory really was deleted (the real physical delete ran); only
    // git's own admin record survives — exactly the prunable shape the
    // erroredStillListed class exists to name.
    expect(existsSync(scratch)).toBe(false);
  });
});

// ─── Form 9: P7.1-wired subcommands (cross-wave / spine / conflict-map
//             / issue-store) ─────────────────────────────────────────────────
//
// These confirm the new runners are wired into the main router. The runners
// themselves are exhaustively covered by their own *-cli.spec.ts files; here we
// only assert the routing seam: the unknown-subcommand usage lists them, and a
// bare (arg-less) invocation reaches the runner's own usage path (exit 2) rather
// than being mis-routed to dor / unknown-subcommand. issue-store is async and is
// routed through `mainAsync`, so it is exercised via the async entrypoint.
//
// `resume` is deliberately absent from this list (FOR-11) — see the
// "resume entrypoint" describe block below.

describe('P7.1 router wiring — unknown-subcommand usage lists the new subcommands', () => {
  it('lists cross-wave, issue-store, spine, conflict-map in the unknown-subcommand error', () => {
    const code = main(['frobnicate-xyz']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/cross-wave/);
    expect(stderrBuf).toMatch(/issue-store/);
    expect(stderrBuf).toMatch(/spine/);
    expect(stderrBuf).toMatch(/conflict-map/);
  });
});

describe('P7.1 router wiring — cross-wave', () => {
  it('main(["cross-wave"]) returns 2 (router zero-arg guard, before the runner)', () => {
    const code = main(['cross-wave']);
    expect(code).toBe(2);
  });

  it('routes "cross-wave" via KNOWN_SUBCOMMANDS, not as unknown', () => {
    main(['cross-wave']);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });
});

describe('P7.1 router wiring — spine', () => {
  it('main(["spine"]) returns 2 (runner usage path: missing op/path)', () => {
    const code = main(['spine']);
    expect(code).toBe(2);
  });

  it('routes "spine" via KNOWN_SUBCOMMANDS, not as unknown', () => {
    main(['spine']);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  // issue #77 — the standalone `spine-cli.ts` path is collapsed ONTO this case:
  // that module's direct-run block now forwards to `main(['spine', …])` instead
  // of dispatching a second time, so the router case is the engine's one and
  // only spine dispatch path. This pins that it really executes ops (not just
  // that the token is recognised) and that it is byte-identical to calling the
  // runner directly — the equivalence the collapsed alias relies on.
  it('executes a real op, byte-identically to calling runSpine directly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-spine-'));
    const path = join(dir, 'WAVE.md');
    writeFileSync(
      path,
      ['# Wave 2026-07-26 — spine route', '', '**Status:** draft', ''].join('\n'),
      'utf-8',
    );

    const routerCode = main(['spine', 'read', path]);
    const routerOut = stdoutBuf;

    stdoutBuf = '';
    const directCode = runSpine(['read', path]);

    expect(routerCode).toBe(0);
    expect(routerCode).toBe(directCode);
    expect(routerOut).toBe(stdoutBuf);
    expect(routerOut).toContain('# Wave 2026-07-26 — spine route');
  });
});

// ─── resume as a router subcommand (FOR-11 → issue #77) ──────────────────────
//
// History matters for reading these specs. FOR-11 DELETED the `resume` router
// case: the reconciler was reachable both here and as `resume-cli.ts`, and the
// live-gate retro (docs/retros/2026-07-15-wire-contract.md, P-12) flagged that
// as a "which one is canonical?" trust gap. Issue #77 reinstates the case for a
// reason FOR-11 could not have had: the engine is being packaged behind a single
// npm `bin`, so a verb not reachable as `{{wave-cli}} <sub>` is not shippable.
//
// The ambiguity P-12 objected to does not return, and these specs are what pin
// that: the router case is not a second implementation but a call into
// `runResume` — the very function `resume-cli.ts`'s own direct-run block calls.
// So the parity assertions below DERIVE their expectation by running that
// standalone runner and comparing, rather than transcribing an expected shape.
//
// Hermeticity: `node:child_process` is mocked at module scope (execFileSync →
// ''), so the reconciler's `git worktree list` / branch-delete shell-outs return
// empty and the run never touches a real repo.

/** A minimal valid WAVE.md spine with two rows, written to a fresh temp dir.
 *  Row `01` is `planned` (→ decision 'redispatch'), row `09` is `pr-created`
 *  (→ terminal 'keep') — the same fixture shape resume-cli.spec.ts uses. */
function writeResumeSpine(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-resume-'));
  const path = join(dir, 'WAVE.md');
  writeFileSync(
    path,
    [
      '# Wave 2026-07-26 — router test',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 01 | T 01 | background | mechanical | quick-verify | — | planned | 1 | — |',
      '| 09 | T 09 | background | mechanical | quick-verify | — | pr-created | 1 | — |',
      '',
      '## PR-Log',
      '',
      '| Created | ID | PR | Closes | Merged | Notes |',
      '| ------- | -- | -- | ------ | ------ | ----- |',
      '| — | — | — | — | — | _(none)_ |',
      '',
      '## Resume-Metadata',
      '',
      '```yaml',
      'dispatch-log:',
      '  - "01 → agent a01 (sonnet)  branch wave-orch/01-thing"',
      '  - "09 → agent a09 (sonnet)  branch wave-orch/09-thing"',
      '```',
      '',
    ].join('\n'),
    'utf-8',
  );
  return path;
}

describe('router wiring — resume (issue #77)', () => {
  it('"resume" IS in the unknown-subcommand available list', () => {
    const code = main(['frobnicate-xyz']);
    expect(code).toBe(2);
    // `main(['frobnicate-xyz'])` hits the unknown-subcommand branch (a single
    // `unknown subcommand: ...; available: <KNOWN_SUBCOMMANDS.join(', ')>`
    // line), not printUsage()'s dedicated "available subcommands:" line — so
    // parse the KNOWN_SUBCOMMANDS list off THAT line specifically.
    const availableLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('available:'));
    expect(availableLine).toBeDefined();
    const list = availableLine!
      .slice(availableLine!.indexOf('available:') + 'available:'.length)
      .split(',')
      .map((s) => s.trim());
    expect(list).toContain('resume');
  });

  it('main(["resume"]) hits the router zero-arg guard (exit 2), NOT unknown-subcommand', () => {
    const code = main(['resume']);
    expect(code).toBe(2);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('a missing required flag reaches runResume\'s OWN usage (exit 2) — proof of routing, not of an unknown verb', () => {
    // `--verdicts` is absent: the message is resume-cli's own missing-flag
    // usage, which the top-level router usage never prints.
    const code = main(['resume', '--spine', '/x', '--reports', '/r']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--spine, --reports-dir and --verdicts-dir are required/);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('runs the real reconcile: exit 0 and the ResumeResult + cleanup JSON on stdout', () => {
    const spine = writeResumeSpine();
    const code = main([
      'resume',
      '--spine', spine,
      '--reports', join(tmpdir(), 'cli-resume-absent-reports'),
      '--verdicts', join(tmpdir(), 'cli-resume-absent-verdicts'),
      '--repo-root', root,
    ]);

    expect(code).toBe(0);
    const result = JSON.parse(stdoutBuf) as {
      rows: { id: string; decision: string }[];
      fatals: unknown[];
      cleanup: { branch: string }[];
    };
    expect(result.rows).toHaveLength(2);
    expect(result).toHaveProperty('fatals');
    // The `planned` row reconciles to a redispatch, so crash-cleanup ran for it
    // (and only it) BEFORE the result was printed — the FOR-10 handback order.
    expect(result.cleanup).toHaveLength(1);
    expect(result.cleanup[0].branch).toBe('wave-orch/01-thing');
  });

  it('produces byte-identical stdout and the same exit code as the standalone resume-cli runner', () => {
    const spine = writeResumeSpine();
    const args = [
      '--spine', spine,
      '--reports', join(tmpdir(), 'cli-resume-absent-reports'),
      '--verdicts', join(tmpdir(), 'cli-resume-absent-verdicts'),
      '--repo-root', root,
    ];

    const routerCode = main(['resume', ...args]);
    const routerOut = stdoutBuf;

    stdoutBuf = '';
    // The direct-module alias's runner, called exactly as its own direct-run
    // block calls it (real disk-backed defaultDeps).
    const standaloneCode = runResume(args);

    expect(routerCode).toBe(standaloneCode);
    expect(routerOut).toBe(stdoutBuf);
  });

  it('an unreadable spine is a clean domain failure (exit 1), same as the standalone entrypoint', () => {
    const code = main([
      'resume',
      '--spine', join(tmpdir(), 'cli-resume-no-such-spine.md'),
      '--reports', '/r',
      '--verdicts', '/v',
      '--repo-root', root,
    ]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/error:/);
  });

  it('the top-level usage lists resume as a subcommand and names resume-cli.ts only as an alias', () => {
    main([]);
    expect(stderrBuf).toMatch(/flotilla-engine resume --spine/);
    expect(stderrBuf).toMatch(/resume-cli\.ts/);
    expect(stderrBuf).toMatch(/alias/i);
  });
});

// ─── store-preflight as a router subcommand (issue #77) ──────────────────────
//
// The tracker-precondition probe used to be reachable ONLY as its own runnable
// module (`cli-store.ts preflight`). It is now `{{wave-cli}} store-preflight`.
// Like `issue-store`/`host-pr` it is ASYNC, so `mainAsync` must intercept it
// before the sync `main()` — and, unlike those two, before the router's zero-arg
// guard as well, because a BARE `store-preflight` is a legal invocation that
// probes against the default `wave.config.json`.

/** Write a linear-store wave.config.json to a fresh temp dir; returns its path. */
function writeLinearConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-preflight-'));
  const path = join(dir, 'wave.config.json');
  writeFileSync(path, JSON.stringify({ store: { kind: 'linear', team: 'EX' } }), 'utf8');
  return path;
}

describe('router wiring — store-preflight (issue #77)', () => {
  it('"store-preflight" IS in the unknown-subcommand available list', () => {
    main(['frobnicate-xyz']);
    const availableLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('available:'));
    expect(availableLine).toBeDefined();
    const list = availableLine!
      .slice(availableLine!.indexOf('available:') + 'available:'.length)
      .split(',')
      .map((s) => s.trim());
    expect(list).toContain('store-preflight');
  });

  it('runs the probe through the injected store: exit 0 and the StorePreflightReport on stdout', async () => {
    const config = writeLinearConfig();
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });

    const code = await mainAsync(['store-preflight', '--config', config], store);

    expect(code).toBe(0);
    const report = JSON.parse(stdoutBuf) as { ok: boolean; storeKind: string };
    expect(report.ok).toBe(true);
    expect(report.storeKind).toBe('linear');
  });

  it('produces byte-identical stdout and the same exit code as `cli-store.ts preflight`', async () => {
    const config = writeLinearConfig();

    const routerCode = await mainAsync(
      ['store-preflight', '--config', config],
      new LinearIssuesStore({ api: new InMemoryLinearApi() }),
    );
    const routerOut = stdoutBuf;

    stdoutBuf = '';
    // The direct-module alias's runner, called exactly as its own direct-run
    // block calls it — the `preflight` op token leads the args there.
    const standaloneCode = await runStorePreflight(
      ['preflight', '--config', config],
      new LinearIssuesStore({ api: new InMemoryLinearApi() }),
    );

    expect(routerCode).toBe(standaloneCode);
    expect(routerOut).toBe(stdoutBuf);
  });

  it('a failing precondition still exits 1 (loud) through the router', async () => {
    const config = writeLinearConfig();
    const api = new InMemoryLinearApi();
    // A fresh team missing "In Review" — the state map names a state it lacks.
    api.setStateCatalog([
      { name: 'Triage', type: 'triage' },
      { name: 'Backlog', type: 'backlog' },
      { name: 'Todo', type: 'unstarted' },
      { name: 'In Progress', type: 'started' },
      { name: 'Done', type: 'completed' },
      { name: 'Canceled', type: 'canceled' },
    ]);

    const code = await mainAsync(
      ['store-preflight', '--config', config],
      new LinearIssuesStore({ api }),
    );

    expect(code).toBe(1);
    expect(JSON.parse(stdoutBuf).ok).toBe(false);
    expect(stdoutBuf).toContain('In Review');
  });

  it('an unreadable --config is a usage error (exit 2), same as the standalone entrypoint', async () => {
    const code = await mainAsync([
      'store-preflight',
      '--config',
      join(mkdtempSync(join(tmpdir(), 'cli-preflight-')), 'does-not-exist.json'),
    ]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/error:/);
  });

  it('a BARE `store-preflight` bypasses the router zero-arg guard and reaches the runner', async () => {
    // The zero-arg guard's tell is printUsage()'s "available subcommands:" line;
    // the runner never prints it. Whichever way the ambient default
    // wave.config.json resolves, the guard must not have fired.
    await mainAsync(['store-preflight']);
    expect(stderrBuf).not.toMatch(/available subcommands:/);
  });

  it('the sync main(["store-preflight", ...]) refuses with exit 2 and an async hint', () => {
    const code = main(['store-preflight', '--config', '/x.json']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/async/i);
  });
});

describe('P7.1 router wiring — conflict-map', () => {
  it('main(["conflict-map"]) returns 2 (runner usage path: no issue paths)', () => {
    const code = main(['conflict-map']);
    expect(code).toBe(2);
  });

  it('routes "conflict-map" via KNOWN_SUBCOMMANDS, not as unknown', () => {
    main(['conflict-map']);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  // issue #759: a nonexistent issue path used to reach the operator as
  // `loadIssueGlobs`'s bare `readFileSync` ENOENT (unguarded in
  // `runConflictMap`), falling through to `mainAsync`'s generic catch-all.
  // Now it is caught at the source and prefixed, matching `files-drift`'s own
  // "could not read issue file" wording — same failure, same name. The exit
  // code is UNCHANGED: this call already resolved to 1 via the catch-all, and
  // stays 1 (never 2) — unifying exit codes is out of scope (ADR-0035).
  it('a nonexistent issue path gets a prefixed "could not read issue file" message, still exit 1', () => {
    const code = main(['conflict-map', '/definitely/does-not-exist/issue.md']);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/^error: could not read issue file: .*ENOENT/);
  });
});

// ─── conflict-map --id: async store-form disambiguation (ADR-0014 parity) ───
//
// `--id` routes `conflict-map` to the async store reader exactly as `dor --id`
// does — bare `conflict-map <path>...` stays in the sync `main()`. These pin the
// mainAsync-level disambiguation: the store form reads through the injected
// store, the path form is untouched, and a path mixed with `--id` is a usage
// error surfaced by the store reader.

describe('conflict-map --id router wiring (mainAsync store form)', () => {
  it('routes `conflict-map --id` to the async store reader and prints the overlap', async () => {
    const store = fakeStore(async (id) => ({
      id,
      risk: 'mechanical',
      worker: 'background',
      files: id === 'A' ? ['src/shared.ts', 'src/a.ts'] : ['src/shared.ts', 'src/b.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    }));

    const code = await mainAsync(['conflict-map', '--id', 'A', '--id', 'B'], store);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as {
      issues: string[];
      cells: { a: string; b: string; files: string[] }[];
    };
    expect(out.issues).toEqual(['A', 'B']);
    expect(out.cells).toEqual([{ a: 'A', b: 'B', files: ['src/shared.ts'] }]);
  });

  it('errors with usage (exit 2) when a path is mixed with --id', async () => {
    const store = fakeStore(async () => {
      throw new Error('should not be read when args are rejected');
    });

    const code = await mainAsync(
      ['conflict-map', '--id', 'A', issueFile],
      store,
    );

    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/cannot mix issue paths and --id/);
  });

  it('leaves the bare path form on the sync path (no --id → unchanged exit 0)', async () => {
    const code = await mainAsync(['conflict-map', issueFile]);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as { issues: string[] };
    expect(Array.isArray(out.issues)).toBe(true);
  });
});

describe('P7.1 router wiring — issue-store (async via mainAsync)', () => {
  it('mainAsync(["issue-store"]) resolves to 2 (runner usage path: no op)', async () => {
    const code = await mainAsync(['issue-store']);
    expect(code).toBe(2);
  });

  it('the sync main(["issue-store", <op>]) refuses with exit 2 and an async hint', () => {
    // With an op present the pre-switch missing-args guard is passed, so the
    // switch's async-refusal case is reached (a bare `issue-store` would hit the
    // generic usage guard instead). Either way the sync path never runs the store.
    const code = main(['issue-store', 'listOpen']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/async/i);
  });

  it('mainAsync delegates non-issue-store subcommands to the sync main()', async () => {
    const code = await mainAsync(['dor', issueFile]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/^PASS/m);
  });
});

describe('P7.3 router wiring — config', () => {
  it('main(["config","validate",<path>]) routes to runConfig (exit 0 for a valid config)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-route-'));
    const path = join(dir, 'wave.config.json');
    writeFileSync(path, JSON.stringify({ store: { kind: 'github' } }), 'utf8');
    expect(main(['config', 'validate', path])).toBe(0);
  });
});

// ─── Form 5: `dor --id <id>` — the non-file store-backed entrypoint (ADR-0014) ──

function tmpStore(): MarkdownFsStore {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dor-id-'));
  mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
  return new MarkdownFsStore({ repoRoot, slug: '2026-06-06-x' });
}

const DOR_INPUT: CreateInput = {
  title: 'Add a config route',
  filingHint: 'add-config-route',
  risk: 'mechanical',
  worker: 'background',
  files: ['cms/site/config/config.php'],
  blockedBy: 'none',
  acceptanceCriteria: [{ text: 'route registered', checked: false }],
  bodySections: [{ heading: 'What to build', markdown: 'register the route' }],
};

function fakeStore(read: (id: string) => Promise<IssueView>): IssueStore {
  return { read } as unknown as IssueStore;
}

describe('dor --id <id> (store-backed, non-file)', () => {
  it('reads a real store by id, validates, and exits 0 for a ready issue', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    const code = await runDorById(['--id', id], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(new RegExp(`^PASS\\s+${id}`, 'm'));
  });

  it('renders the working-tree gates as deferred, and RUNS the cross-issue gate', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    await runDorById(['--id', id], store);

    expect(stdoutBuf).toMatch(/deferred\s+files-glob-valid/);
    // The FLIP (issue #750): this assertion read `deferred` until Gate 5 was
    // re-homed onto the store this entry point already holds. `DOR_INPUT`
    // declares `blockedBy: 'none'`, so the gate now answers `pass` — a row with
    // nothing declared is not held. The working-tree gate above still defers:
    // it keys off `--repo-root`, which this call does not pass, and Gate 5 no
    // longer rides along with it.
    expect(stdoutBuf).toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/deferred\s+blocked-by-chain-resolves/);
  });

  it('exits 1 when a content gate fails (worker outside the configured vocab)', async () => {
    const store = fakeStore(async (id) => ({
      id,
      risk: 'mechanical',
      worker: 'background-sonnet', // retired Ur value — not in the default set
      files: ['src/foo.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    }));

    const code = await runDorById(['--id', '42'], store);

    expect(code).toBe(1);
    expect(stdoutBuf).toMatch(/^FAIL\s+42/m);
  });

  it('exits 1 and reports to stderr when the store read fails', async () => {
    const store = fakeStore(async () => {
      throw new Error('no such issue');
    });

    const code = await runDorById(['--id', 'nope'], store);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/cannot read/i);
  });

  it('returns usage (2) when --id is missing', async () => {
    const code = await runDorById([], fakeStore(async () => {
      throw new Error('should not be read');
    }));

    expect(code).toBe(2);
  });

  it('mainAsync routes `dor --id` to the async store path', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    const code = await mainAsync(['dor', '--id', id], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(new RegExp(`^PASS\\s+${id}`, 'm'));
  });

  it('runs the working-tree gates (not deferred) when --repo-root is given', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);
    // tmpStore() roots the store at a fresh $TMPDIR repo; pass that same root.
    const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;

    await runDorById(['--id', id, '--repo-root', repoRoot], store);

    // With a checkout present, files-glob-valid no longer defers — it runs
    // (pass/warn/fail), so the "deferred files-glob-valid" line must be absent.
    expect(stdoutBuf).not.toMatch(/deferred\s+files-glob-valid/);
    // The FLIP (issue #750), second of the two: the cross-issue gate is not a
    // working-tree gate and never keyed off `--repo-root` — it now runs because
    // this entry point resolves the row's declared refs through the store, and
    // this row declares none, so it passes.
    expect(stdoutBuf).toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/deferred\s+blocked-by-chain-resolves/);
  });
});

// ─── Gate 5 (blocked-by-chain-resolves) threading — issue #750 ───────────────
//
// The defect: `runDorById` pushed the cross-issue gate as `deferred` with a
// fixed reason before any input was looked at, so a row whose declared blocker
// was still OPEN passed the readiness check and the hold that exists precisely
// for that case never fired — nine of twelve archived consumer waves resolved
// this by hand.
//
// These specs drive the REAL `dor --id` entry point against a LOCAL store
// (`MarkdownFsStore` on a fresh $TMPDIR repo) and a hand-built fake — never a
// live tracker — so the WIRING is what is under test, not just the pure gate
// dor-gate.spec.ts already exercises. dor-gate.spec.ts owns the gate's own
// four answers; this block owns "does the CLI actually read the tracker".

/** A blocked row for `tmpStore()`, declaring the refs the case needs. */
function blockedInput(blockedBy: CreateInput['blockedBy']): CreateInput {
  return { ...DOR_INPUT, title: 'Blocked row', filingHint: 'blocked-row', blockedBy };
}

describe('dor --id <id> — Gate 5 resolves declared blockers through the store', () => {
  it('FAILS the gate (exit 1) when a declared blocker is still open', async () => {
    const store = tmpStore();
    const blocker = await store.create(DOR_INPUT); // `…#01`, left open
    const blocked = await store.create(blockedInput([{ issue: 1 }]));

    const code = await runDorById(['--id', blocked], store);

    expect(code).toBe(1);
    expect(stdoutBuf).toMatch(/fail\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(/#1\b/); // the reason names the offending ref
    expect(stdoutBuf).toMatch(new RegExp(`^FAIL\\s+${blocked}`, 'm'));
    // the blocker itself is untouched by the probe
    expect((await store.readClosing(blocker)).state).toBe('open');
  });

  it('passes the gate (exit 0) once that same blocker is closed', async () => {
    const store = tmpStore();
    const blocker = await store.create(DOR_INPUT);
    const blocked = await store.create(blockedInput([{ issue: 1 }]));
    await store.close(blocker, 'https://example.test/pr/1', []);

    const code = await runDorById(['--id', blocked], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/pass\s+blocked-by-chain-resolves/);
  });

  it('DEFERS (never passes) when a declared ref cannot be resolved at all', async () => {
    const store = tmpStore();
    // Same-slug, but no such issue exists: the closing probe throws, which is
    // exactly the no-evidence arm.
    const blocked = await store.create(blockedInput([{ issue: 99 }]));

    const code = await runDorById(['--id', blocked], store);

    expect(code).toBe(0); // a deferral never flips overall to FAIL
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(/#99/);
  });

  it('DEFERS a ref naming a different slug rather than answering about its own tree', async () => {
    // `MarkdownFsStore.locate` ignores the slug part of an id entirely, so
    // probing `elsewhere#1` here would answer about THIS store's `#1` — the
    // silently-wrong answer the store-blind slug rule exists to refuse.
    const store = tmpStore();
    await store.create(DOR_INPUT); // this tree's `#01`, open — must NOT be consulted
    const blocked = await store.create(blockedInput([{ slug: 'elsewhere', issue: 1 }]));

    const code = await runDorById(['--id', blocked], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(/elsewhere#1/);
    expect(stdoutBuf).toMatch(/different slug/);
  });

  it('defers rather than crashing when the store cannot invert its own id', async () => {
    // A store whose `parseRef` throws on the id in hand has no way to address a
    // sibling; that is a missing capability, not a gate failure.
    const store = {
      read: async (id: string): Promise<IssueView> => ({
        id,
        risk: 'mechanical',
        worker: 'background',
        files: ['src/foo.ts'],
        blockedBy: [{ issue: 41 }],
        acceptanceCriteria: [{ text: 'x', checked: false }],
        status: 'available',
      }),
      parseRef: () => {
        throw new Error('not an invertible id');
      },
      readClosing: async () => {
        throw new Error('readClosing must not be reached');
      },
    } as unknown as IssueStore;

    const code = await runDorById(['--id', 'prd-sentinel'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(/not an invertible id/);
  });
});

// ─── Gate 5 candidate-id derivation — fail-safe null return spec (issue #780) ─
//
// `candidateIdFor` (in cli.ts, just above `resolveDeclaredBlockers`) has two
// independent fail-safe arms that return `null` rather than a candidate id:
// the own-id self-check (the row's own id must end in the decimal rendering of
// its own issue number) and the round-trip veto (the derived candidate must
// invert back through the store's own `parseRef` to the very ref asked for).
// Neither arm was exercised by a shipped spec before this row: every id shape
// the three shipped stores emit happens to satisfy the self-check, so the arm
// is unreachable by construction on the current adapters. A Reviewer probe on
// wave row 750 exercised it once, at review time, and that evidence was never
// captured as a test (issue #780's own Gap — the fail-safe is precisely what
// makes the forward id-parse defensible against the ADR-0001 "id is opaque"
// decision, so its absence of coverage matters more than its size suggests).
//
// These specs drive the REAL `dor --id` entry point with a hand-built fake
// `IssueStore` (never `MarkdownFsStore`, whose ids never reach this arm) so
// the id shape is fully under the spec's control, and assert the closing
// probe is never reached on either arm — across the two id shapes that DO
// carry a trailing number (numeric/GitHub, prefixed/Linear — reachable only
// via the round-trip veto) plus the shape that does not (reachable via the
// self-check). `candidateIdFor` and `resolveDeclaredBlockers` are untouched by
// this row; only this describe block is new.
describe('dor --id <id> — candidate-id derivation fail-safe null return (issue #780)', () => {
  /** A same-slug single-blocker view, echoing back whatever id it was read as. */
  function blockedView(id: string, blockerIssue: number): IssueView {
    return {
      id,
      risk: 'mechanical',
      worker: 'background',
      files: ['src/foo.ts'],
      blockedBy: [{ issue: blockerIssue }],
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    };
  }

  it('DEFERS — own-id self-check arm: an id with no trailing decimal run (parseRef still resolves it)', async () => {
    const readClosing = vi.fn(async () => {
      throw new Error('readClosing must not be reached');
    });
    const store = {
      read: async (id: string) => blockedView(id, 41),
      // The store's own id format does not carry a trailing number at all —
      // `parseRef` still yields an issue number for it (a store is free to
      // invert an id by any means of its own), so `own` resolves fine and the
      // failure is purely the self-check's own-id-shape mismatch.
      parseRef: () => ({ issue: 7 }),
      readClosing,
    } as unknown as IssueStore;

    const code = await runDorById(['--id', 'row-alpha'], store);

    expect(code).toBe(0); // a deferral never flips overall to FAIL
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/fail\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(
      /does not render 41 from the row's own id "row-alpha"/,
    );
    expect(readClosing).not.toHaveBeenCalled();
  });

  it('DEFERS — round-trip veto arm: a numeric/GitHub-shaped own id whose derived candidate inverts to a different issue', async () => {
    const readClosing = vi.fn(async () => {
      throw new Error('readClosing must not be reached');
    });
    const store = {
      read: async (id: string) => blockedView(id, 41),
      // The own id ("42") ends in its own issue number, so the self-check
      // passes and a candidate ("41") is derived — but this store's
      // `parseRef` inverts EVERY OTHER id to issue 999, never the number
      // asked for, so the round-trip veto is what kills it.
      parseRef: (id: string) => (id === '42' ? { issue: 42 } : { issue: 999 }),
      readClosing,
    } as unknown as IssueStore;

    const code = await runDorById(['--id', '42'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/fail\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(/does not render 41 from the row's own id "42"/);
    expect(readClosing).not.toHaveBeenCalled();
  });

  it('DEFERS — round-trip veto arm: a prefixed/Linear-shaped own id whose derived candidate inverts to a different issue', async () => {
    const readClosing = vi.fn(async () => {
      throw new Error('readClosing must not be reached');
    });
    const store = {
      read: async (id: string) => blockedView(id, 41),
      parseRef: (id: string) =>
        id === 'FOR-42' ? { issue: 42 } : { issue: 999 },
      readClosing,
    } as unknown as IssueStore;

    const code = await runDorById(['--id', 'FOR-42'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/pass\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).not.toMatch(/fail\s+blocked-by-chain-resolves/);
    expect(stdoutBuf).toMatch(
      /does not render 41 from the row's own id "FOR-42"/,
    );
    expect(readClosing).not.toHaveBeenCalled();
  });
});

// ─── Gate 8 (verify-profile-coverage) threading — FOR-151 ────────────────────
//
// The defect: `runDor`/`runDorById` built a `ValidateOptions`/`ValidateViewOptions`
// that never carried `opts.verify`, so Gate 8 (dor-gate.ts's own already-tested
// `checkVerifyProfileCoverage`, see dor-gate.spec.ts) always saw `verify ===
// undefined` and reported `deferred` — regardless of what `--config` on disk
// actually held. These specs drive the REAL `dor --id` CLI entry point (never
// the bare `validateIssueView` unit dor-gate.spec.ts already exercises) with a
// real `--config` file on disk, so the WIRING itself — not just the gate's
// internal logic — is under test.
//
// Judgment call (policy clause 1, AC-vs-repo-policy conflict — flagged in the
// WorkerReport): issue #151's suggested AC says a no-match row "fails the
// gate". dor-gate.ts's own doc comment + its existing spec coverage
// (dor-gate.spec.ts, gate 8 describe block) are unambiguous and pre-date this
// issue: Gate 8 is advisory-only by design (#127 AC2) — it WARNs, and
// deliberately never FAILs, so a row with no automated gate stays dispatchable
// rather than being blocked outright. Repo policy wins: these specs assert the
// REAL (warn, not fail) status and document the divergence here rather than
// changing dor-gate.ts's settled advisory semantics as a side effect of a
// wiring fix.

function writeVerifyConfig(profiles: { name: string; appliesTo: string[] }[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dor-verify-cfg-'));
  const cfgPath = join(dir, 'wave.config.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      store: { kind: 'markdown', repoRoot: '.', slug: 'x' },
      verify: {
        profiles: profiles.map((p) => ({
          ...p,
          commands: [{ command: 'npm test' }],
        })),
      },
    }),
    'utf-8',
  );
  return cfgPath;
}

/**
 * A config that loads successfully and carries no `verify` key at all — the
 * ordinary shape for a repo without a build gate (issue #676). Distinct from
 * `writeVerifyConfig([])`, which writes an EXPLICIT `verify: { profiles: [] }`
 * — both reach Gate 8 the same way (see `NOTE_VERIFY_PROFILES_EMPTY` in
 * dor-gate.ts), but this helper is the one that reproduces the actually
 * reported bug: no `verify` block, not an empty one.
 */
function writeConfigWithoutVerifyBlock(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dor-no-verify-cfg-'));
  const cfgPath = join(dir, 'wave.config.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      store: { kind: 'markdown', repoRoot: '.', slug: 'x' },
    }),
    'utf-8',
  );
  return cfgPath;
}

describe('dor --id <id> --config <path> threads verify profiles into Gate 8 (FOR-151)', () => {
  it("reports pass — never deferred — when the row's Files match a configured verify profile", async () => {
    const store = tmpStore();
    const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
    const id = await store.create({ ...DOR_INPUT, files: ['apps/web/src/thing.ts'] });
    const configPath = writeVerifyConfig([{ name: 'web', appliesTo: ['apps/web/**'] }]);

    const code = await runDorById(
      ['--id', id, '--repo-root', repoRoot, '--config', configPath],
      store,
    );

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/pass\s+verify-profile-coverage/);
    expect(stdoutBuf).not.toMatch(/deferred\s+verify-profile-coverage/);
  });

  it(
    "reports warn — never deferred — when the row's Files match NO configured verify profile " +
      '(advisory-only per repo policy, #127 AC2 — see the judgment-call note above the ' +
      'describe block; the row stays dispatchable, exit 0)',
    async () => {
      const store = tmpStore();
      const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
      const id = await store.create({ ...DOR_INPUT, files: ['apps/ios/src/thing.ts'] });
      const configPath = writeVerifyConfig([{ name: 'web', appliesTo: ['apps/web/**'] }]);

      const code = await runDorById(
        ['--id', id, '--repo-root', repoRoot, '--config', configPath],
        store,
      );

      expect(code).toBe(0);
      expect(stdoutBuf).toMatch(/warn\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/deferred\s+verify-profile-coverage/);
      expect(stdoutBuf).toMatch(/match no configured verify profile/);
    },
  );

  it(
    'defers ONLY because verify config is absent (never because of the working-tree gate) ' +
      'when --config is omitted but --repo-root is supplied — the sole deferring condition (AC3)',
    async () => {
      const store = tmpStore();
      const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
      const id = await store.create({ ...DOR_INPUT, files: ['apps/web/src/thing.ts'] });

      const code = await runDorById(['--id', id, '--repo-root', repoRoot], store);

      expect(code).toBe(0);
      // The other working-tree gate runs fine with --repo-root present — proving
      // the defer below is caused SPECIFICALLY by the absent verify config, not
      // by a missing checkout.
      expect(stdoutBuf).not.toMatch(/deferred\s+files-glob-valid/);
      expect(stdoutBuf).toMatch(/deferred\s+verify-profile-coverage/);
      // issue #676: this is the "resolvable" case — no --config reached this
      // call at all — so the text must say so AND name the flag, distinct
      // from a config that loaded but declared no `verify` block (below).
      expect(stdoutBuf).toMatch(/No verify config reached this check/);
      expect(stdoutBuf).toMatch(/--config/);
      expect(stdoutBuf).not.toMatch(/declares no profiles/);
    },
  );

  it(
    'reports pass — with a note, never the old "no config supplied" deferral — ' +
      'when --config loads a config that carries no `verify` block at all (issue #676)',
    async () => {
      const store = tmpStore();
      const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
      const id = await store.create({ ...DOR_INPUT, files: ['apps/web/src/thing.ts'] });
      const configPath = writeConfigWithoutVerifyBlock();

      const code = await runDorById(
        ['--id', id, '--repo-root', repoRoot, '--config', configPath],
        store,
      );

      expect(code).toBe(0);
      expect(stdoutBuf).toMatch(/pass\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/deferred\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/No verify config supplied/);
      expect(stdoutBuf).not.toMatch(/No verify config reached this check/);
      expect(stdoutBuf).toMatch(/declares no profiles/);
    },
  );

  it('exits 1 with a clear stderr message when --config points at an unreadable file', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);
    const badConfig = join(mkdtempSync(join(tmpdir(), 'dor-verify-bad-')), 'nope.json');

    const code = await runDorById(['--id', id, '--config', badConfig], store);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/could not load --config/);
  });

  it(
    'reports warn — naming the uncovered file — when only SOME of the row\'s Files match a ' +
      'configured verify profile (issue #711 — the partial case, threaded through the real ' +
      '`dor --id` CLI entry point, not just the bare dor-gate.ts unit)',
    async () => {
      const store = tmpStore();
      const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
      const id = await store.create({
        ...DOR_INPUT,
        files: ['apps/web/src/thing.ts', 'apps/ios/src/thing.ts'],
      });
      const configPath = writeVerifyConfig([{ name: 'web', appliesTo: ['apps/web/**'] }]);

      const code = await runDorById(
        ['--id', id, '--repo-root', repoRoot, '--config', configPath],
        store,
      );

      expect(code).toBe(0);
      expect(stdoutBuf).toMatch(/warn\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/deferred\s+verify-profile-coverage/);
      expect(stdoutBuf).toMatch(/partially match/);
      expect(stdoutBuf).toContain('apps/ios/src/thing.ts');
    },
  );
});

describe('dor <path> --config <path> threads verify profiles into Gate 8 (file form, FOR-151)', () => {
  it('reports pass (not deferred) when Files match a configured verify profile', () => {
    const matchedIssue = join(root, '.scratch', 'test-feature', 'issues', '90-verify-matched.md');
    writeFileSync(
      matchedIssue,
      [
        '# 90 — Verify matched',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- apps/web/src/thing.ts',
        '**Blocked by:** none',
      ].join('\n'),
      'utf-8',
    );
    const configPath = writeVerifyConfig([{ name: 'web', appliesTo: ['apps/web/**'] }]);

    const code = main(['dor', '--config', configPath, matchedIssue]);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/pass\s+verify-profile-coverage/);
  });

  it('preserves the pre-existing behaviour — Gate 8 still defers — when --config is omitted', () => {
    const code = main(['dor', issueFile]);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+verify-profile-coverage/);
    expect(stdoutBuf).toMatch(/No verify config reached this check/);
  });

  it(
    'reports pass — with a note, never a deferral — when --config loads a config ' +
      'that carries no `verify` block at all (issue #676)',
    () => {
      const configPath = writeConfigWithoutVerifyBlock();

      const code = main(['dor', '--config', configPath, issueFile]);

      expect(code).toBe(0);
      expect(stdoutBuf).toMatch(/pass\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/deferred\s+verify-profile-coverage/);
      expect(stdoutBuf).not.toMatch(/No verify config supplied/);
      expect(stdoutBuf).not.toMatch(/No verify config reached this check/);
      expect(stdoutBuf).toMatch(/declares no profiles/);
    },
  );

  it('exits 1 with a clear stderr message when --config points at an unreadable file', () => {
    const code = main(['dor', '--config', join(root, 'no-such-config.json'), issueFile]);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/could not load --config/);
  });
});

// --- Gate 9 (the staleness advisory) reaches BOTH dor forms ------------------
//
// Division of labour with dor-gate.spec.ts, stated because it is not obvious:
// that file drives the gate against REAL git repositories with pinned commit
// dates, so the date arithmetic, the pathspec translation and the
// absence-defers rule are proven there against the real tool. THIS file cannot
// do that — `node:child_process` is mocked module-wide at the top (the
// files-drift specs depend on it) — so what these specs prove is the half that
// only the CLI can prove: that the gate is reached at all from both `dor`
// forms, that its two different `since` sources are actually wired (the issue
// FILE's mtime on the file form, `IssueView.trackerUpdatedAt` on `--id`), and
// that the row's exit code is UNCHANGED by a firing advisory (ADR-0035: the
// addition is additive on the frozen CLI surface — a new gate line, nothing
// else).

describe('dor -- the staleness advisory reaches both entry points (exit code unchanged)', () => {
  const staleRoots: string[] = [];

  /**
   * One commit for the stub to answer with, as DATA. Deliberately NOT a wire
   * string (issue #939): the record separator, the field separator and the
   * `--name-only` layout are the module's business, and `stubGitLog` below
   * renders this through the very `--format` the module passed rather than
   * restating a shape this file would then have to keep in step by hand.
   */
  interface StubbedCommit {
    sha: string;
    date: string;
    subject: string;
    /** The declared file(s) `--name-only` reports this commit as touching. */
    files: string[];
  }

  const TOUCHING_COMMIT: StubbedCommit = {
    sha: 'abc1234',
    date: '2020-06-01T12:00:00Z',
    subject: 'retire the mechanism the row still names',
    files: ['src/foo.ts'],
  };

  /**
   * Stub the git calls gate 9 makes, in the same style the files-drift specs in
   * this file already stub `getChangedFilesFromGit`: answer each read the gate
   * performs, and hand back `commits` for the `git log`.
   *
   * The `git log` answer is RENDERED THROUGH THE REQUEST (issue #939). The stub
   * reads the `--format=<template>` argument the module actually passed,
   * substitutes `%h`/`%aI`/`%s` into it, and appends the file lines the same
   * invocation's `--name-only` asked for — blank line first, exactly as git
   * separates a commit header from its file list. Nothing here spells a
   * separator, so this stub cannot answer in a shape the module stopped asking
   * for.
   *
   * That mattered: the string this replaced was a FIXED one-line-per-commit
   * answer handed back regardless of the arguments, carrying no per-commit file
   * data and none of the record separator the module composes. `dor-gate.ts`
   * carried a whole second parse arm for it — an arm no real `git log` could
   * ever produce, an out-of-scope test double dictating a production branch.
   * The arm is gone; this is why it could go.
   */
  function stubGitLog(commits: readonly StubbedCommit[]): void {
    vi.mocked(execFileSync).mockImplementation(((_file: unknown, args: unknown) => {
      const a = Array.isArray(args) ? (args as string[]) : [];
      if (a[0] === 'rev-parse' && a[1] === '--git-dir') return '.git\n';
      if (a[0] === 'symbolic-ref') return 'origin/main\n';
      if (a[0] === 'log') {
        const formatArg = a.find((arg) => arg.startsWith('--format='));
        // A stub that silently answered an unrecognised request would be the
        // same defect in a new costume, so this refuses instead of guessing.
        if (formatArg === undefined) {
          throw new Error(`gate 9's git log carried no --format to answer: ${a.join(' ')}`);
        }
        const template = formatArg.slice('--format='.length);
        const wantsFiles = a.includes('--name-only');
        return commits
          .map((c) => {
            const header = template
              .replace('%h', c.sha)
              .replace('%aI', c.date)
              .replace('%s', c.subject);
            const fileList =
              wantsFiles && c.files.length > 0 ? `\n${c.files.join('\n')}\n` : '';
            return `${header}\n${fileList}`;
          })
          .join('');
      }
      return '';
    }) as never);
  }

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation((() => '') as never);
  });

  afterAll(() => {
    for (const r of staleRoots) rmSync(r, { recursive: true, force: true });
  });

  /** A temp root carrying the declared file, so the other working-tree gates pass. */
  function rootWithDeclaredFile(label: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `dor-stale-cli-${label}-`)));
    staleRoots.push(dir);
    mkdirSync(join(dir, '.scratch'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'foo.ts'), '// declared\n', 'utf-8');
    return dir;
  }

  it('the FILE form surfaces the advisory as a warn and still exits 0', () => {
    stubGitLog([TOUCHING_COMMIT]);
    const dir = rootWithDeclaredFile('file-form');
    const issueDir = join(dir, '.scratch', 'demo', 'issues');
    mkdirSync(issueDir, { recursive: true });
    const issuePath = join(issueDir, '01-demo.md');
    writeFileSync(
      issuePath,
      [
        '# 01 -- Demo',
        '',
        '**Status:** ready-for-agent',
        '**Risk:** isolated-refactor',
        '**Worker:** background',
        '**Files:**',
        '- src/foo.ts',
        '**Blocked by:** none',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] the thing is built',
      ].join('\n'),
      'utf-8',
    );

    const code = main(['dor', issuePath]);

    expect(code).toBe(0); // ADVISORY: a firing gate does not move the exit code
    expect(stdoutBuf).toMatch(/warn\s+files-touched-since-tracker-update/);
    expect(stdoutBuf).toMatch(/retire the mechanism the row still names/);
    expect(stdoutBuf).toMatch(/^PASS/m);
    // The #918 attribution wording, which the stub's old fixed string could not
    // produce because it carried no per-commit file data at all. Asserting it
    // HERE is what keeps the stub answering in the shape the module asks for:
    // regress the stub to a separator-less, file-less answer and this line goes
    // red rather than quietly falling back to the pre-#918 whole-list wording.
    expect(stdoutBuf).toContain('Declared file(s) actually touched');
    expect(stdoutBuf).toContain('src/foo.ts — touched by abc1234');
  });

  it('the FILE form passes the gate when git reports nothing touching the declared files', () => {
    stubGitLog([]);
    const dir = rootWithDeclaredFile('file-form-quiet');
    const issueDir = join(dir, '.scratch', 'demo', 'issues');
    mkdirSync(issueDir, { recursive: true });
    const issuePath = join(issueDir, '01-demo.md');
    writeFileSync(
      issuePath,
      [
        '# 01 -- Demo',
        '',
        '**Status:** ready-for-agent',
        '**Risk:** isolated-refactor',
        '**Worker:** background',
        '**Files:**',
        '- src/foo.ts',
        '**Blocked by:** none',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] the thing is built',
      ].join('\n'),
      'utf-8',
    );

    const code = main(['dor', issuePath]);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/pass\s+files-touched-since-tracker-update/);
  });

  it('the --id form surfaces the advisory, taking its window off IssueView.trackerUpdatedAt', async () => {
    stubGitLog([TOUCHING_COMMIT]);
    const dir = rootWithDeclaredFile('id-form');
    const store = new MarkdownFsStore({ repoRoot: dir, slug: 'demo' });
    const id = await store.create({ ...DOR_INPUT, files: ['src/foo.ts'] });

    // Proof the window came off the CONTRACT rather than from anything the CLI
    // reconstructed: the store's own read is what carries it.
    expect((await store.read(id)).trackerUpdatedAt).toBeDefined();

    const code = await runDorById(['--id', id, '--repo-root', dir], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/warn\s+files-touched-since-tracker-update/);
    expect(stdoutBuf).toMatch(/retire the mechanism the row still names/);
  });

  it('the --id form DEFERS the advisory without --repo-root, exactly like the other working-tree gates', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    const code = await runDorById(['--id', id], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+files-touched-since-tracker-update/);
    expect(stdoutBuf).not.toMatch(/pass\s+files-touched-since-tracker-update/);
  });

  it('the --id form DEFERS -- never passes -- when the store states no tracker-update instant', async () => {
    stubGitLog([TOUCHING_COMMIT]);
    const dir = rootWithDeclaredFile('id-form-no-ts');
    // A store whose read() omits trackerUpdatedAt entirely: the adapter could
    // not state one. The gate must not read that as "nothing moved".
    const store = fakeStore(async (id) => ({
      id,
      risk: 'isolated-refactor',
      worker: 'background',
      files: ['src/foo.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    }));

    const code = await runDorById(['--id', '42', '--repo-root', dir], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/deferred\s+files-touched-since-tracker-update/);
    expect(stdoutBuf).not.toMatch(/pass\s+files-touched-since-tracker-update/);
    expect(stdoutBuf).not.toMatch(/warn\s+files-touched-since-tracker-update/);
  });
});

// --- Gate 10 (the PR-title advisory) on the STORE-BACKED path ---------------
//
// The defect: the tenth gate shipped live on the FILE path and `deferred` on
// `dor --id` — the one form a decoration pass actually runs — because the
// runner built its `ValidateViewOptions` without the row's title. The gate was
// never wrong; nothing ever handed it its input, and a gate that cannot fire
// where it was designed to help is the same as a gate that is not there.
//
// Division of labour with dor-gate.spec.ts, stated because it is not obvious:
// that file owns the gate's four ANSWERS over a hand-built options object, plus
// the cross-pin against the composer's own strip. THIS block owns the half only
// the CLI can prove — that `dor --id` READS the row's title off the store's
// triage facet, that `--pr-title` reaches the same gate as the declared half,
// and that a title the runner could not obtain still `defer`s with the gate's
// OWN existing reason instead of passing, erroring, or inventing a second one.

/** The gate's rendered stdout line, matched by status. */
function prTitleGateLine(status: string): RegExp {
  return new RegExp(`${status}\\s+pr-title-id-independent`);
}

/** The full ten-gate roster, in emission order — the pin AC4's second half asks for. */
const STORE_PATH_GATE_ORDER = [
  'header-parseable',
  'files-glob-valid',
  'ac-section-consistent',
  'risk-file-count-consistent',
  'blocked-by-chain-resolves',
  'ac-files-coverage',
  'literal-files-exist',
  'verify-profile-coverage',
  'files-touched-since-tracker-update',
  'pr-title-id-independent',
];

/** A title whose SENTENCE leans on a tracker id — the live shape the gate exists for. */
const LEANING_TITLE =
  'After #791 the Reviewer agent definition still describes the sibling list';
/** What the compose-time strip leaves of it: grammatically valid, semantically wrong. */
const LEANING_TITLE_DERIVED =
  'After the Reviewer agent definition still describes the sibling list';

/**
 * A store that answers `read` and `readTriage` and nothing else — the shape
 * that lets a spec control the TRACKER TITLE exactly, which `MarkdownFsStore`
 * cannot do for the failure arms (its triage read cannot be made to throw
 * without also breaking the `read` above it).
 */
function storeWithTitle(title: string | (() => never)): IssueStore {
  const view = (id: string): IssueView => ({
    id,
    risk: 'mechanical',
    worker: 'background',
    files: ['src/foo.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'x', checked: false }],
    status: 'available',
  });
  return {
    read: async (id: string) => view(id),
    readTriage: async (id: string) => {
      if (typeof title !== 'string') title();
      return { id, title, body: '', comments: [] };
    },
  } as unknown as IssueStore;
}

describe('dor --id <id> — the PR-title advisory runs on the store-backed path', () => {
  it('WARNS on a tracker title that leans on a bare id and declares no PR title (was: deferred)', async () => {
    const store = tmpStore();
    const id = await store.create({
      ...DOR_INPUT,
      title: LEANING_TITLE,
      filingHint: 'leaning-title',
    });

    const code = await runDorById(['--id', id], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('warn'));
    // The regression itself: this line is what the row was filed for.
    expect(stdoutBuf).not.toMatch(prTitleGateLine('deferred'));
    // …and the advisory SHOWS both titles, read off a real store's triage facet.
    expect(stdoutBuf).toContain(`  tracker title:    "${LEANING_TITLE}"`);
    expect(stdoutBuf).toContain(`  derived PR title: "${LEANING_TITLE_DERIVED}"`);
  });

  it('PASSES a row whose tracker title carries no id at all', async () => {
    const store = tmpStore();
    const id = await store.create({
      ...DOR_INPUT,
      title: 'Reconcile the Reviewer brief with the composed sibling list',
      filingHint: 'clean-title',
    });

    const code = await runDorById(['--id', id], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('pass'));
    expect(stdoutBuf).not.toMatch(prTitleGateLine('deferred'));
    expect(stdoutBuf).not.toMatch(prTitleGateLine('warn'));
  });

  it('PASSES with the declared-title note when --pr-title states the title, leaning tracker title and all', async () => {
    const store = tmpStore();
    const id = await store.create({
      ...DOR_INPUT,
      title: LEANING_TITLE,
      filingHint: 'leaning-title-declared',
    });

    const code = await runDorById(
      ['--id', id, '--pr-title', 'Reconcile the Reviewer brief with the composed sibling list'],
      store,
    );

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('pass'));
    expect(stdoutBuf).toContain('A PR title is declared for this row');
    // Nothing is derived, so the orphaned derivation is never shown.
    expect(stdoutBuf).not.toContain(LEANING_TITLE_DERIVED);
  });

  it('a BLANK --pr-title is not a declaration — the advisory still warns', async () => {
    const store = tmpStore();
    const id = await store.create({
      ...DOR_INPUT,
      title: LEANING_TITLE,
      filingHint: 'leaning-title-blank-decl',
    });

    const code = await runDorById(['--id', id, '--pr-title', '   '], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('warn'));
  });

  // ── The negative control: `deferred` is still produced, and still means
  //    "nobody could supply a title" rather than "the title is clean". Three
  //    arms, because three different things can leave the runner without one.

  it('DEFERS with the gate’s existing reason when the triage read THROWS', async () => {
    const store = storeWithTitle(() => {
      throw new Error('triage facet unreachable');
    });

    const code = await runDorById(['--id', '42'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('deferred'));
    // The gate's OWN reason, unchanged — not a second one invented at the caller.
    expect(stdoutBuf).toContain('No row title reached this check');
    expect(stdoutBuf).toContain(
      'This is a capability gap (nobody supplied one), NOT evidence that the title is id-free.',
    );
    // …and the failure is not silent: the operator is told WHY it deferred.
    expect(stderrBuf).toContain('notice: dor:');
    expect(stderrBuf).toContain('triage facet unreachable');
  });

  it('DEFERS when the store answers `read` but has no triage facet at all', async () => {
    // The shape every pre-existing injected double in this file has: `read`
    // alone. Reaching for a method it does not carry must cost the gate its
    // answer, never the verb its exit code.
    const store = fakeStore(async (id) => ({
      id,
      risk: 'mechanical',
      worker: 'background',
      files: ['src/foo.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    }));

    const code = await runDorById(['--id', '42'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('deferred'));
    expect(stdoutBuf).toContain('No row title reached this check');
  });

  it('DEFERS on a BLANK tracker title rather than reading it as id-free', async () => {
    const store = storeWithTitle('   ');

    const code = await runDorById(['--id', '42'], store);

    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(prTitleGateLine('deferred'));
    expect(stdoutBuf).toContain('No row title reached this check');
    // A blank title is a read that SUCCEEDED, so there is nothing to notice.
    expect(stderrBuf).not.toContain('notice: dor:');
  });

  // ── The advisory stays advisory (AC4), and the roster is unchanged.

  it('never moves the verdict: a warning row is still PASS, still exit 0', async () => {
    const store = tmpStore();
    const repoRoot = (store as unknown as { repoRoot: string }).repoRoot;
    const id = await store.create({
      ...DOR_INPUT,
      title: LEANING_TITLE,
      filingHint: 'leaning-title-verdict',
    });

    const code = await runDorById(['--id', id, '--repo-root', repoRoot, '--json'], store);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as {
      overall: string;
      issues: { gates: { name: string; status: string }[] }[];
    };
    const gates = out.issues[0].gates;
    expect(gates.find((g) => g.name === 'pr-title-id-independent')?.status).toBe('warn');
    expect(gates.some((g) => g.status === 'fail')).toBe(false);
    expect(out.overall).toBe('PASS');
  });

  it('emits the same ten gates, in the same order, with the advisory last', async () => {
    const store = tmpStore();
    const id = await store.create({
      ...DOR_INPUT,
      title: LEANING_TITLE,
      filingHint: 'leaning-title-roster',
    });

    const code = await runDorById(['--id', id, '--json'], store);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as {
      issues: { gates: { name: string }[] }[];
    };
    expect(out.issues[0].gates.map((g) => g.name)).toEqual(STORE_PATH_GATE_ORDER);
  });

  // ── The operator-facing surface (AC5): `dor --help` says the gate is here.

  it("names --pr-title on the --id form's line, and never on the path form's", () => {
    expect(main(['dor', '--help'])).toBe(0);
    const lines = stdoutBuf.split('\n');
    const idFormLine = lines.find((l) => l.includes('--id <issue-id>'))!;
    const pathFormLine = lines.find((l) => l.includes('<issue-path>'))!;

    expect(idFormLine).toContain('[--pr-title <pr-title>]');
    // The path form is variadic — there is no single row one declared title
    // could belong to — so the flag is rendered where it is actually read.
    expect(pathFormLine).not.toContain('--pr-title');
  });

  it('tells a person, in its own usage, that the advisory runs on this path', () => {
    expect(main(['dor', '--help'])).toBe(0);
    expect(stdoutBuf).toContain(
      'PR-title advisory (pr-title-id-independent) runs there instead of deferring',
    );
    expect(stdoutBuf).toContain('--pr-title to declare the title the PR will open under');
  });
});

// ─── FOR-11 AC1: pre-op-dispatch store failures exit non-zero ────────────────
//
// The observed defect (dogfooding, CLAUDE.md): a store/network failure BEFORE
// op dispatch printed an error yet exited 0. `resolveStore` runs BEFORE the
// per-op switch in both `runDorById` (this file) and `runIssueStore`
// (issue-store-cli.ts) — a failure there is NOT a post-dispatch failure, so a
// regression spec that only injects a store whose *method* throws (the
// existing "store read fails" spec above) does not cover it: that store was
// already successfully resolved. These specs force the resolution step itself
// to fail (an unreadable --config stands in for "the network/API-client
// construction failed") and never pass an `injected` store, so the real
// (unguarded, out-of-file-scope) `resolveStore`/`createGitHubApiFromEnv` path
// actually runs.

describe('FOR-11 — pre-dispatch store-resolution failure exits non-zero, not 0', () => {
  it('runDorById never resolves 0 and never rejects when the store cannot be resolved', async () => {
    // No `injected` store — forces the real resolveStore(--config) path.
    const badConfig = join(mkdtempSync(join(tmpdir(), 'for11-')), 'nope.json');

    const code = await runDorById(['--id', 'X', '--config', badConfig]);

    expect(code).not.toBe(0);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/error:/);
  });

  it('mainAsync(["dor", "--id", ...]) surfaces the same failure as a clean non-zero resolve (never an unhandled rejection)', async () => {
    const badConfig = join(mkdtempSync(join(tmpdir(), 'for11-')), 'nope.json');

    // No .catch here on purpose: if mainAsync ever rejects instead of
    // resolving, this `await` throws and the test fails loudly rather than
    // silently observing a stray "exit 0".
    const code = await mainAsync(['dor', '--id', 'X', '--config', badConfig]);

    expect(code).not.toBe(0);
    expect(code).toBe(1);
  });

  it('mainAsync(["issue-store", ...]) also surfaces a pre-dispatch store-resolution failure as non-zero (never 0, never an unhandled rejection)', async () => {
    // issue-store-cli.ts's own resolveStore() call sits BEFORE its op-dispatch
    // try/catch (out of this issue's file scope) — mainAsync's wrapping
    // try/catch (cli.ts, FOR-11) is the safety net that keeps this contract
    // even though that inner file wasn't touched.
    const badConfig = join(mkdtempSync(join(tmpdir(), 'for11-')), 'nope.json');

    const code = await mainAsync(['issue-store', 'listOpen', '--config', badConfig]);

    expect(code).not.toBe(0);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/error:/);
  });
});

// ─── FOR-11 AC2: top-level usage stays synced to the real dispatch tables ────
//
// The live-gate retro (P-12) found the top-level usage stale against
// spine-cli's real ops (`spine set-status` was missing). Hand-copying the
// fix would only re-create the same staleness risk one release later, so
// these specs derive the EXPECTED op vocabulary at runtime from each
// runner's own dispatch table — by feeding it a deliberately-unknown op and
// reading back the "available: ..." list it reports itself — rather than
// hardcoding a second copy of the list here.

/**
 * Parse a runner's own reported op vocabulary off its stderr — either the
 * comma-separated `available: a, b, c` shape (spine-cli's `default:` case) or
 * the pipe-delimited `<a|b|c>` shape (issue-store-cli's `usage()`).
 */
function parseAvailableList(text: string): string[] {
  const commaForm = text.match(/available:\s*([^\n<]+)/i);
  if (commaForm) {
    return commaForm[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const pipeForm = text.match(/<([a-zA-Z0-9_-]+(?:\|[a-zA-Z0-9_-]+)+)>/);
  if (pipeForm) {
    return pipeForm[1].split('|').map((s) => s.trim()).filter(Boolean);
  }
  throw new Error(`no "available: a, b, c" or "<a|b|c>" op list found in: ${text}`);
}

describe('FOR-11 — top-level usage derives from the real dispatch tables', () => {
  it('every real `spine` op (from spine-cli\'s own dispatch table) resolves to a contract in the aggregate', () => {
    // Trigger spine-cli's own `default:` case — its "available: ..." message
    // IS the actual dispatch table, not a copy of it.
    const code = runSpine(['__unknown_op__', '/some/spine/path.md']);
    expect(code).toBe(2);
    const realOps = parseAvailableList(stderrBuf);
    expect(realOps.length).toBeGreaterThan(0);

    // Issue #758: this used to read ONE hand-maintained roster line — the
    // `flotilla-engine spine <op1|op2|…>` string — and assert each real op
    // appeared as a substring of it. That line is gone: the roster is rendered
    // from the contracts now, one line per op, so reading it back would only
    // ask the renderer whether it rendered. The claim FOR-11 actually cares
    // about is one level up and survives the change intact — every op the
    // dispatch table knows DECLARES a contract, which is what makes it
    // advertised, `--help`-able and refusable. That is asserted against the
    // aggregate directly.
    const aggregate = verbContracts();
    for (const op of realOps) {
      expect(aggregate[`spine ${op}`], `spine ${op} declares no contract`).toBeDefined();
    }

    // …and the rendered roster still names every one of them, because it is
    // built from that same aggregate — asserted as a consequence, not as the
    // ground truth.
    stderrBuf = '';
    main([]);
    for (const op of realOps) {
      expect(stderrBuf).toContain(`flotilla-engine spine ${op} `);
    }
  });

  it('every real `issue-store` op (from issue-store-cli\'s own dispatch table) is a real, dispatchable op — no drift between its usage() list and its switch', async () => {
    // issue-store-cli's usage() always reports the SAME fixed "available:
    // <op1|op2|...>" list regardless of which unknown op triggered it — that
    // literal is the closest-to-source list this file scope can reach
    // (issue-store-cli.ts itself is out of FOR-11's file scope). This derives
    // the expected op set from THAT runtime message, then proves each op is
    // genuinely wired into the switch (not just claimed) by confirming it is
    // never routed to the `default: unknown op` branch — a genuinely-known op
    // fails for a DOMAIN reason (missing id/flag, or a stub store method) —
    // never a "not an op" reason.
    const fake = new Proxy(
      {},
      {
        // Exclude `then`: returning a function for it would make `fake` look
        // like a thenable to `await`/`Promise.resolve` (resolveStore returns
        // `injected` from an async function), hanging the test forever.
        get: (_t, prop) => (prop === 'then' ? undefined : async () => ({})),
      },
    ) as unknown as IssueStore;
    const code = await runIssueStore(['__unknown_op__'], fake);
    expect(code).toBe(2);
    const realOps = parseAvailableList(stderrBuf);
    expect(realOps.length).toBeGreaterThan(0);

    for (const op of realOps) {
      stderrBuf = '';
      await runIssueStore([op], fake);
      // Whatever this op does next (usage-2 on a missing id/flag, or a clean
      // 0/1 against the stub store), it must NEVER be reported as unknown.
      expect(stderrBuf).not.toMatch(new RegExp(`unknown op "${op}"`));
    }
  });
});

// ─── the human lane as `spine` subverbs (issue #323, ADR-0012) ──────────────
//
// Two ops over one engine predicate. They were introduced on cli.ts's own
// `spine` case; issue #366 folded them into spine-cli's dispatch table as a
// PURE MOVE, and every assertion below is unchanged across that move — which is
// what makes this section the regression net for it: same args, same JSON, same
// exit codes, reached through the same router entry point as before.
//
// Three separable claims are pinned here:
//
//   1. ROUTING — both ops are reachable via `main(['spine', op, …])`, i.e. via
//      the very case `spine-cli.ts`'s direct-run block forwards to, so the
//      documented alias spelling reaches them exactly as it reaches spine-cli's
//      own ops.
//   2. BEHAVIOUR — the listing always exits 0 on a readable spine (an empty
//      lane is an answer, not a gate) while the gate is fail-closed in BOTH
//      directions and must not fire on a parked row (ADR-0022).
//   3. ONE DISPATCH TABLE — the guard at the end of this section is the INVERSE
//      of the parity guard that stood here before the fold. That one pinned a
//      deliberate two-table split; this one pins that no split remains, deriving
//      spine-cli's vocabulary at runtime exactly as its predecessor did.

/** A spine whose row `11` is human-gated; every row starts `planned`. */
function writeHumanLaneSpine(rows?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-human-lane-'));
  const path = join(dir, 'WAVE.md');
  writeFileSync(
    path,
    [
      '# Wave 2026-07-31 — human lane',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      ...(rows ?? [
        '| 10 | Ordinary AFK row | background | mechanical | quick-verify | — | planned | 1 | — |',
        // Deliberately space-padded well past the column width: the on-disk
        // shape a renderer produces, and the shape a substring match would miss.
        `| 11 | Rotate the credential by hand |   ${HUMAN_GATED_WORKER}   | cross-feature-refactor | quick-verify | — | planned | 1 | — |`,
        '| 12 | Another AFK row | background-heavy | isolated-refactor | quick-verify | — | pr-created | 1 | — |',
      ]),
      '',
    ].join('\n'),
    'utf-8',
  );
  return path;
}

describe('spine human-gated — the human-lane listing (issue #323)', () => {
  it('lists every human-gated row with its awaiting-human verdict, exit 0', () => {
    const code = main(['spine', 'human-gated', writeHumanLaneSpine()]);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf);
    expect(out.ok).toBe(true);
    expect(out.humanGatedWorkers).toEqual([HUMAN_GATED_WORKER]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      id: '11',
      worker: HUMAN_GATED_WORKER,
      state: 'planned',
      awaitingHuman: true,
    });
    expect(out.awaitingHumanIds).toEqual(['11']);
  });

  it('a wave with NO human lane is exit 0 with an empty listing — an answer, not a gate', () => {
    // The non-guard rule, at the CLI edge. A caller that treated `rows: []` as
    // a failure would turn "this wave has no human lane" into a stop, which is
    // exactly what `humanHeldRowIds`' own doc forbids.
    const code = main([
      'spine',
      'human-gated',
      writeHumanLaneSpine([
        '| 10 | Ordinary AFK row | background | mechanical | quick-verify | — | planned | 1 | — |',
      ]),
    ]);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf);
    expect(out.rows).toEqual([]);
    expect(out.awaitingHumanIds).toEqual([]);
  });

  it('reports a RELEASED human-gated row as still in the lane but no longer awaiting', () => {
    // The state-blind view and the conjunction, side by side in one payload —
    // the reason both engine readers are exported rather than just the second.
    const code = main([
      'spine',
      'human-gated',
      writeHumanLaneSpine([
        `| 11 | Rotate the credential by hand | ${HUMAN_GATED_WORKER} | cross-feature-refactor | quick-verify | — | dispatched | 1 | — |`,
      ]),
    ]);

    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].awaitingHuman).toBe(false);
    expect(out.awaitingHumanIds).toEqual([]);
  });

  it('honours --workers (Worker is a config-governed enum, ADR-0007)', () => {
    const path = writeHumanLaneSpine([
      '| 30 | gated on a human | needs-a-human | mechanical | quick-verify | — | planned | 1 | — |',
    ]);

    expect(main(['spine', 'human-gated', path])).toBe(0);
    expect(JSON.parse(stdoutBuf).rows).toEqual([]);

    stdoutBuf = '';
    expect(main(['spine', 'human-gated', path, '--workers', 'needs-a-human'])).toBe(0);
    const out = JSON.parse(stdoutBuf);
    expect(out.humanGatedWorkers).toEqual(['needs-a-human']);
    expect(out.awaitingHumanIds).toEqual(['30']);
  });

  it('exits 1 on an unreadable spine and 2 on a missing path', () => {
    expect(main(['spine', 'human-gated', join(root, 'no-such-spine.md')])).toBe(1);
    expect(stderrBuf).toMatch(/error:/);

    stderrBuf = '';
    expect(main(['spine', 'human-gated', '--workers', 'x'])).toBe(2);
    expect(stderrBuf).toMatch(/requires a <spine-path>/);
  });
});

describe('spine check-awaiting-human — the fail-closed archive gate (issue #323)', () => {
  it('BLOCKS an archive over a human-gated row with a live claim, naming both exits', () => {
    const code = main(['spine', 'check-awaiting-human', writeHumanLaneSpine()]);

    expect(code).toBe(1);
    expect(stdoutBuf).toContain('archive gate BLOCKED');
    // The gate cites the archive phase reference — the doc that actually
    // describes it — never ADR-0012 (which establishes the Worker vocabulary
    // and never mentions an archive gate at all).
    expect(stdoutBuf).toContain('.claude/skills/wave-close/reference/phase-6-archive.md');
    expect(stdoutBuf).not.toContain('ADR-0012');
    expect(stdoutBuf).toContain('row 11');
    // The hazard has to be named, not just the count — an operator who reads
    // only this output must learn WHY it is not skippable.
    expect(stdoutBuf).toMatch(/LIVE `queued` claim/);
    // …and both documented exits, or the block is a dead end.
    expect(stdoutBuf).toMatch(/THE HUMAN ACTS/);
    expect(stdoutBuf).toMatch(/PARK \+ UNCLAIM/);
    expect(stdoutBuf).toContain('spine set-row-state');
    expect(stdoutBuf).toContain('issue-store unclaim');
  });

  it('CLEARS a wave with no human lane at all', () => {
    const code = main([
      'spine',
      'check-awaiting-human',
      writeHumanLaneSpine([
        '| 10 | Ordinary AFK row | background | mechanical | quick-verify | — | pr-created | 1 | — |',
      ]),
    ]);

    expect(code).toBe(0);
    expect(stdoutBuf).toContain('archive gate CLEAR');
  });

  it('NEGATIVE CONTROL — a PARKED human-gated row does NOT block (ADR-0022)', () => {
    // The one false positive that would make this gate worse than nothing.
    // `parked` is terminal AND claim-releasing (the claim was dropped at park
    // time), so a parked row is precisely the shape an archive may proceed
    // past — and it is one of the two exits the block message offers. A gate
    // that fired on it would refuse to archive a wave that had already taken
    // the remedy the gate itself prescribed.
    const code = main([
      'spine',
      'check-awaiting-human',
      writeHumanLaneSpine([
        `| 11 | Rotate the credential by hand | ${HUMAN_GATED_WORKER} | cross-feature-refactor | quick-verify | — | parked | 1 | — |`,
      ]),
    ]);

    expect(code).toBe(0);
    expect(stdoutBuf).toContain('archive gate CLEAR');
    // …and the row is still visibly IN the lane — cleared by its state, never
    // by having fallen out of the human-gated set.
    stdoutBuf = '';
    main([
      'spine',
      'human-gated',
      writeHumanLaneSpine([
        `| 11 | Rotate the credential by hand | ${HUMAN_GATED_WORKER} | cross-feature-refactor | quick-verify | — | parked | 1 | — |`,
      ]),
    ]);
    expect(JSON.parse(stdoutBuf).rows[0]).toMatchObject({
      id: '11',
      state: 'parked',
      awaitingHuman: false,
    });
  });

  it('NEGATIVE CONTROL — a RELEASED (dispatched) human-gated row does NOT block', () => {
    const code = main([
      'spine',
      'check-awaiting-human',
      writeHumanLaneSpine([
        `| 11 | Rotate the credential by hand | ${HUMAN_GATED_WORKER} | cross-feature-refactor | quick-verify | — | dispatched | 1 | — |`,
      ]),
    ]);

    expect(code).toBe(0);
    expect(stdoutBuf).toContain('archive gate CLEAR');
  });

  it('is fail-closed on an UNREADABLE spine — exit 1, exactly like a held row', () => {
    // The second direction, and the one a "count the matches" gate gets wrong:
    // a spine that cannot be read is not "no held rows", it is "unknown", and
    // an archive gate must treat unknown as blocked. Same stance as
    // `spine check-disclosures`.
    const code = main(['spine', 'check-awaiting-human', join(root, 'no-such-spine.md')]);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/error:/);
    expect(stdoutBuf).not.toContain('CLEAR');
  });

  it('exits 2 on a missing <spine-path>', () => {
    expect(main(['spine', 'check-awaiting-human'])).toBe(2);
    expect(stderrBuf).toMatch(/requires a <spine-path>/);
  });

  // ── `--json`: the gate returns what HOLDS it (issue 859) ──────────────────
  //
  // Reached through the ROUTER here — `main(['spine', …])` — because that is
  // the spelling every skill and every pulse uses, and the surface a caller
  // sees. spine-cli.spec.ts pins the same answer against the runner directly,
  // plus the shapes and the refusal paths.
  //
  // The gate's exit code was always its machine verdict; what it could not say
  // is WHICH rows hold it, which left a headless `quiescent` read (ADR-0048)
  // re-parsing the spine for a fact this gate had just computed.

  it('--json returns the HELD row ids instead of the prose, exit unchanged', () => {
    const code = main(['spine', 'check-awaiting-human', writeHumanLaneSpine(), '--json']);

    expect(code).toBe(1);
    expect(JSON.parse(stdoutBuf)).toEqual({
      ok: false,
      verb: 'spine check-awaiting-human',
      holding: ['11'],
    });
    // The prose is REPLACED, not joined: stdout is one JSON document, so a
    // caller never has to strip a human-facing block off the front of it.
    expect(stdoutBuf).not.toContain('archive gate BLOCKED');
    expect(stdoutBuf).not.toContain('PARK + UNCLAIM');
  });

  it('--json on a CLEAR wave is `ok: true` with an empty `holding`, exit 0', () => {
    const code = main([
      'spine',
      'check-awaiting-human',
      writeHumanLaneSpine([
        '| 10 | Ordinary AFK row | background | mechanical | quick-verify | — | pr-created | 1 | — |',
      ]),
      '--json',
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(stdoutBuf)).toEqual({
      ok: true,
      verb: 'spine check-awaiting-human',
      holding: [],
    });
    expect(stdoutBuf).not.toContain('archive gate CLEAR');
  });

  it('NEGATIVE CONTROL — a PARKED and a RELEASED gated row are absent from `holding`', () => {
    // The two shapes the gate deliberately does not fire on (ADR-0022, and the
    // released row) must not appear in the list either — a `holding` that named
    // a row the exit code says is not holding anything would be worse than no
    // list at all.
    const rows = [
      `| 11 | Awaiting | ${HUMAN_GATED_WORKER} | mechanical | quick-verify | — | planned | 1 | — |`,
      `| 12 | Parked | ${HUMAN_GATED_WORKER} | mechanical | quick-verify | — | parked | 1 | — |`,
      `| 13 | Released | ${HUMAN_GATED_WORKER} | mechanical | quick-verify | — | dispatched | 1 | — |`,
    ];
    expect(main(['spine', 'check-awaiting-human', writeHumanLaneSpine(rows), '--json'])).toBe(1);
    expect(JSON.parse(stdoutBuf).holding).toEqual(['11']);
  });

  it('`holding` IS `human-gated`\'s `awaitingHumanIds` — same spine, same --workers', () => {
    // Derived by RUNNING the listing, never transcribed: the two ops read one
    // `awaitingHuman` projection, and this is the assertion that says a future
    // edit cannot give them two ideas of who holds the wave.
    const path = writeHumanLaneSpine([
      '| 30 | gated on a human | needs-a-human | mechanical | quick-verify | — | planned | 1 | — |',
      '| 31 | also gated | needs-a-human | mechanical | quick-verify | — | planned | 1 | — |',
      '| 32 | released | needs-a-human | mechanical | quick-verify | — | dispatched | 1 | — |',
    ]);

    expect(main(['spine', 'human-gated', path, '--workers', 'needs-a-human'])).toBe(0);
    const listed = JSON.parse(stdoutBuf).awaitingHumanIds;

    stdoutBuf = '';
    expect(
      main(['spine', 'check-awaiting-human', path, '--workers', 'needs-a-human', '--json']),
    ).toBe(1);
    expect(JSON.parse(stdoutBuf).holding).toEqual(listed);
    // Non-vacuity: an empty lane on both sides would satisfy the equality and
    // prove nothing about the projection they share.
    expect(listed).toEqual(['30', '31']);
  });

  it('--json prints NO JSON on an unreadable spine (exit 1) and none on a missing path (exit 2)', () => {
    // The row-825 rule, and the reason it is not a taste call: a
    // `{ ok: false, holding: [] }` here would be indistinguishable, to the very
    // pulse this answer exists for, from "the spine WAS read and nothing holds
    // the gate". Silence on stdout is the only honest answer.
    expect(
      main(['spine', 'check-awaiting-human', join(root, 'no-such-spine.md'), '--json']),
    ).toBe(1);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/error:/);

    stdoutBuf = '';
    stderrBuf = '';
    expect(main(['spine', 'check-awaiting-human', '--json'])).toBe(2);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/requires a <spine-path>/);
  });

  it('the group roster line keeps its prefix and GAINS the --json clause, for both gates', () => {
    // The structural carrier (Coordinator ruling 2026-09-21): no ADR edit, the
    // roster and `--help` are where the two gates now advertise their answer.
    // Rendered from each op's own contract by cli.ts's roster renderer, so this
    // fails if the advertised shape and the contract ever describe two things.
    main([]); // zero args → the whole-CLI roster on stderr
    const lineFor = (needle: string) => stderrBuf.split('\n').find((l) => l.includes(needle))!;

    for (const op of ['check-disclosures', 'check-awaiting-human']) {
      const line = lineFor(`flotilla-engine spine ${op} `);
      // The prefix the prose class already carried is untouched…
      expect(line, `\`spine ${op}\` lost its prose-class note`).toContain('# prints text, not JSON');
      // …and the clause is new beside it.
      expect(line, `\`spine ${op}\` roster line has no --json clause`).toContain(
        '--json: what HOLDS this gate',
      );
      expect(line).toContain('{ ok, verb, holding:');
    }
  });
});

describe('the human-lane ops are dispatched by spine-cli\'s ONE table (issue #366 — the fold)', () => {
  // The INVERTED parity guard. Its predecessor pinned a deliberate split — each
  // human-lane op unknown to `runSpine`, intercepted by the router instead — and
  // once the fold landed, that guard would have been asserting an arrangement
  // that no longer exists. Same derivation discipline, opposite claim: the ops
  // come from spine-cli's own `available:` message at runtime, never from a
  // transcribed list here.

  /** spine-cli's real op vocabulary, read off its own `default:` message. */
  function spineCliOps(): string[] {
    stderrBuf = '';
    expect(runSpine(['__unknown_op__', '/some/spine/path.md'])).toBe(2);
    const ops = parseAvailableList(stderrBuf);
    expect(ops.length).toBeGreaterThan(0);
    return ops;
  }

  it('both human-lane ops are IN spine-cli\'s own dispatch vocabulary', () => {
    // Non-vacuity for everything below: had the fold advertised without
    // dispatching (or dispatched without advertising), this is where it shows.
    expect(spineCliOps()).toEqual(
      expect.arrayContaining(['human-gated', 'check-awaiting-human']),
    );
  });

  it('the router intercepts NO spine op — every one reaches runSpine', () => {
    // The post-fold invariant, stated as a property over the WHOLE vocabulary
    // rather than over a two-element special case: for every op spine-cli
    // reports, `main(['spine', op, …])` and `runSpine([op, …])` must be the same
    // call. A re-introduced interception for any op fails here.
    for (const op of spineCliOps()) {
      stderrBuf = '';
      stdoutBuf = '';
      const viaRouter = main(['spine', op]);
      const routerOut = stdoutBuf;
      const routerErr = stderrBuf;

      stderrBuf = '';
      stdoutBuf = '';
      const direct = runSpine([op]);

      expect(viaRouter, `router vs direct exit code for \`spine ${op}\``).toBe(direct);
      expect(routerOut, `router vs direct stdout for \`spine ${op}\``).toBe(stdoutBuf);
      expect(routerErr, `router vs direct stderr for \`spine ${op}\``).toBe(stderrBuf);
    }
  });

  it('both are named in the top-level usage — now via the FOR-11 derivation', () => {
    // Before the fold this claim needed its own guard: the two ops were absent
    // from the table FOR-11 AC2 derives from, so that guard was structurally
    // blind to them. They are in that table now, so FOR-11 AC2 covers them — and
    // this asserts exactly that, rather than re-checking the strings by hand.
    // Issue #758: each op has its OWN rendered roster line, so "named in the
    // top-level usage" is now a line per op rather than a token inside one.
    const ops = spineCliOps();
    stderrBuf = '';
    main([]);
    for (const op of ['human-gated', 'check-awaiting-human']) {
      expect(ops).toContain(op);
      expect(verbContracts()[`spine ${op}`]).toBeDefined();
      expect(stderrBuf).toContain(`flotilla-engine spine ${op} <spine-path>`);
    }
  });

  it('both are reachable through the router case spine-cli.ts forwards to', () => {
    // `spine-cli.ts`'s direct-run block calls `main(['spine', ...process.argv])`,
    // so this IS the alias path — reached this way, neither op may fall through
    // to spine-cli's `unknown op`.
    for (const op of ['human-gated', 'check-awaiting-human']) {
      stderrBuf = '';
      stdoutBuf = '';
      const code = main(['spine', op, writeHumanLaneSpine()]);
      expect(stderrBuf).not.toContain('unknown op');
      // 0 (the listing) or 1 (the gate, blocked by row 11) — never a usage 2.
      expect([0, 1]).toContain(code);
    }
  });
});

// ─── host-pr subcommand routing (FOR-26 / ADR-0023) ─────────────────────────
//
// The `host-pr` verb group is ASYNC, so — like `issue-store` — it must be
// intercepted by `mainAsync` BEFORE the sync `main()` router. These tests pin
// exactly that wire; the verbs' own behaviour lives in host-pr-cli.spec.ts.

describe('host-pr subcommand routing', () => {
  let stderrBuf = '';
  let stdoutBuf = '';

  beforeEach(() => {
    stderrBuf = '';
    stdoutBuf = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrBuf += String(c);
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutBuf += String(c);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes "host-pr" as a known subcommand, NOT as an unknown one', async () => {
    // An UNRECOGNISED remote → the typed adapter-not-implemented exit, which
    // proves the args reached the host-pr runner (network is never touched).
    // This probe used a bitbucket remote until bitbucket became a shipped
    // adapter; a host with an adapter now builds one (and would need a
    // credential), so the routing proof moved to a host that still has none.
    const code = await mainAsync([
      'host-pr', 'status', '--branch', 'b',
      '--remote', 'git@gitlab.com:ws/repo.git',
    ]);
    expect(code).toBe(1);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
    expect(JSON.parse(stdoutBuf)).toMatchObject({ code: 'adapter-not-implemented' });
  });

  it('a bare "host-pr" prints usage and exits 2', async () => {
    expect(await mainAsync(['host-pr'])).toBe(2);
  });

  it('the sync main() refuses host-pr with a pointer to the async entrypoint', () => {
    const code = main(['host-pr', 'status', '--branch', 'b']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/async/i);
  });

  it('routes "host-pr create" as a known subcommand (FOR-28) — an unrecognised host → typed not-implemented', async () => {
    // An unrecognised remote proves the create verb reached the host-pr runner
    // and was host-gated there — no network, no credential needed. (Same
    // reason as the status probe above for not using a bitbucket remote: that
    // host has a shipped adapter now.)
    const code = await mainAsync([
      'host-pr', 'create', '--branch', 'b', '--title', 'T', '--body', 'x',
      '--remote', 'git@gitlab.com:ws/repo.git',
    ]);
    expect(code).toBe(1);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
    expect(JSON.parse(stdoutBuf)).toMatchObject({ verb: 'create', code: 'adapter-not-implemented' });
  });

  it('"host-pr create" without --title exits 2 (create-specific usage) via the async wire', async () => {
    const code = await mainAsync([
      'host-pr', 'create', '--branch', 'b', '--body', 'x',
      '--remote', 'git@github.com:o/r.git',
    ]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--title/);
  });

  // ── issue #702 — the file form of the PR body is reachable through the router ──
  //
  // The verb's own behaviour is host-pr-cli.spec.ts's; what is pinned here is
  // that `--body-file` survives the async wire (it is parsed by the runner, not
  // the router) and that the CLI surface a stranger reaches first NAMES it.

  it('"host-pr create --body-file" reaches the runner through the async wire — an unreadable path is the runner\'s own exit-2', async () => {
    const code = await mainAsync([
      'host-pr', 'create', '--branch', 'b', '--title', 'T',
      '--body-file', join(tmpdir(), 'flotilla-no-such-pr-body-702.md'),
      '--remote', 'git@github.com:o/r.git',
    ]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/could not read --body-file/);
    // The ROUTER never answered: no unknown-subcommand line, no async refusal.
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
    expect(stderrBuf).not.toMatch(/invoke it via the async entrypoint/);
  });

  it('"host-pr create" with BOTH body routes exits 2 through the same wire', async () => {
    const code = await mainAsync([
      'host-pr', 'create', '--branch', 'b', '--title', 'T',
      '--body', 'x', '--body-file', 'anything.md',
      '--remote', 'git@github.com:o/r.git',
    ]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/exactly ONE/);
    expect(stderrBuf).toContain('--body-file');
  });

  it('the top-level usage names the create body routes, so a caller can find --body-file without probing', async () => {
    // Issue #758 re-pin, and a deliberate split of one claim into two. The
    // roster line is rendered from the contract, so it names BOTH routes by
    // construction — with the placeholder each flag's declared value type gives
    // it (`--body <text>`, not the roster's old hand-written `<body>`). What the
    // roster no longer carries is the paragraph saying WHEN to reach for the
    // file; that prose belongs to the verb and is asserted where it now lives,
    // on `host-pr create --help`, which is one keystroke from the roster line
    // and is reprinted by every refusal this verb makes.
    main([]); // zero args → printUsage()
    const line = stderrBuf
      .split('\n')
      .find((l) => l.includes('host-pr create --branch'))!;
    expect(line).toBeDefined();
    expect(line).toContain('--body <text>');
    expect(line).toContain('--body-file <path>');

    stdoutBuf = '';
    expect(await mainAsync(['host-pr', 'create', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('--body <body>');
    expect(stdoutBuf).toContain('--body-file <path>');
    expect(stdoutBuf).toMatch(/one paragraph/);
  });

  it("the host-pr purpose line names both body routes (the unknown-subcommand answer)", () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);
    const purpose = stderrBuf.split('\n').find((l) => /^ {2}host-pr {2}\S/.test(l))!;
    expect(purpose).toBeDefined();
    expect(purpose).toContain('--body-file');
  });
});

// ─── verdict-acked subcommand (FOR-49 — end-to-end CLI composition) ─────────
//
// verdict-acked (route-cli's sibling write-verdict already has its own
// end-to-end round-trip spec in route-cli.spec.ts) was previously only
// unit-tested at its primitives (metAcIndexes, readSidecars) — the CLI
// composition itself (usage guard → readSidecars(verdictsDir, ...) →
// metAcIndexes → printJson) was only reviewer-eyeballed. These specs drive it
// end-to-end through `main()`, reading sidecars produced ONLY by the REAL
// `write-verdict` verb (also routed through `main()`) — never a hand-built
// fixture file — so a drift in either half (writer's on-disk shape, reader's
// parse, or the verdict-acked wiring itself) fails loud here.

function verdictAckedPayload(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'approve',
    branchReviewed: 'wave/FOR-49-verdict-acked-spec',
    riskClass: 'mechanical',
    workerReportDigest: '10/10 green',
    acVerification: [
      { ac: 'AC1', met: 'met', evidence: 'src/cli.ts:1' },
      { ac: 'AC2', met: 'partial', evidence: 'deferred' },
      { ac: 'AC3', met: 'met', evidence: 'src/cli.ts:2' },
    ],
    reviewerFocusItems: [],
    ...overrides,
  };
}

describe('verdict-acked subcommand', () => {
  let dir: string;
  let verdictsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verdict-acked-cli-'));
    verdictsDir = join(dir, 'verdicts');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path: { acked, iter, corrupt } from a sidecar written by the real write-verdict verb', () => {
    const payloadFile = join(dir, 'v1.json');
    writeFileSync(payloadFile, JSON.stringify(verdictAckedPayload()), 'utf-8');
    const writeCode = main([
      'write-verdict', payloadFile, '--dir', verdictsDir, '--id', 'FOR-49', '--iter', '1',
    ]);
    expect(writeCode).toBe(0);
    stdoutBuf = ''; // discard the write verb's own stdout (the sidecar path) before reading

    const code = main(['verdict-acked', verdictsDir, 'FOR-49']);
    expect(code).toBe(0);
    // met at indexes 0 and 2 only — the `partial` row at index 1 never earns a tick
    expect(JSON.parse(stdoutBuf)).toEqual({ acked: [0, 2], iter: 1, corrupt: 0 });
  });

  it('max-iter selection: a changes-requested iter-1 verdict is superseded by the approve iter-2 re-dispatch verdict', () => {
    const iter1 = join(dir, 'v1.json');
    writeFileSync(
      iter1,
      JSON.stringify(
        verdictAckedPayload({
          verdict: 'changes-requested',
          acVerification: [{ ac: 'AC1', met: 'not-met', evidence: 'missing' }],
        }),
      ),
      'utf-8',
    );
    expect(
      main(['write-verdict', iter1, '--dir', verdictsDir, '--id', 'FOR-49', '--iter', '1']),
    ).toBe(0);

    const iter2 = join(dir, 'v2.json');
    writeFileSync(
      iter2,
      JSON.stringify(
        verdictAckedPayload({
          acVerification: [
            { ac: 'AC1', met: 'met', evidence: 'src/cli.ts:1' },
            { ac: 'AC2', met: 'met', evidence: 'src/cli.ts:2' },
          ],
        }),
      ),
      'utf-8',
    );
    expect(
      main(['write-verdict', iter2, '--dir', verdictsDir, '--id', 'FOR-49', '--iter', '2']),
    ).toBe(0);
    stdoutBuf = '';

    const code = main(['verdict-acked', verdictsDir, 'FOR-49']);
    expect(code).toBe(0);
    // the LATEST (iter-2) verdict wins — never the stale iter-1 changes-requested indexes
    expect(JSON.parse(stdoutBuf)).toEqual({ acked: [0, 1], iter: 2, corrupt: 0 });
  });

  it('absent id → no-op { acked: [], iter: null, corrupt: 0 } (exit 0)', () => {
    // verdictsDir itself is absent too — readSidecars treats a missing dir as
    // "no sidecars", never an error.
    const code = main(['verdict-acked', verdictsDir, 'FOR-999']);
    expect(code).toBe(0);
    expect(JSON.parse(stdoutBuf)).toEqual({ acked: [], iter: null, corrupt: 0 });
  });

  it('corrupt-sidecar counting: a schema-invalid verdict file is reported via `corrupt`, never thrown or adopted', () => {
    mkdirSync(verdictsDir, { recursive: true });
    // Hand-write a fenced-json sidecar missing the required riskClass (the
    // write-verdict verb itself would refuse to write this — see
    // route-cli.spec.ts's "an invalid verdict" case — so a corrupt sidecar can
    // only arrive on disk some other way; write it directly here).
    const { riskClass: _omit, ...noRiskClass } = verdictAckedPayload();
    writeFileSync(
      join(verdictsDir, 'FOR-49-1.md'),
      '# ReviewerVerdict FOR-49 iter 1\n\n```json\n' +
        JSON.stringify(noRiskClass, null, 2) +
        '\n```\n',
      'utf-8',
    );

    const code = main(['verdict-acked', verdictsDir, 'FOR-49']);
    expect(code).toBe(0);
    expect(JSON.parse(stdoutBuf)).toEqual({ acked: [], iter: null, corrupt: 1 });
  });

  it('missing args (only <verdictsDir>, no <id>) → usage (exit 2)', () => {
    const code = main(['verdict-acked', verdictsDir]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/verdict-acked requires <verdictsDir> <id>/);
  });

  it('a bare "verdict-acked" (zero args) also exits 2, via the generic zero-rest usage guard', () => {
    expect(main(['verdict-acked'])).toBe(2);
  });
});

// ─── render-verdict subcommand (FOR-16 — end-to-end CLI composition) ────────
//
// render-verdict is verdict-acked's sibling: same readSidecars(verdictsDir,
// ...) → verdictFor(id) plumbing, but rendering (renderVerdictSection) rather
// than deriving ack indexes, and — unlike verdict-acked — a miss IS a failure
// (exit 1), never a silent no-op. renderVerdictSection's own rendering detail
// (table rows, escaping, "not reported" fallbacks, ...) is already exercised
// at the unit level in reviewer-verdict-schema.spec.ts; these specs drive the
// CLI composition itself (usage guard → readSidecars → verdictFor →
// renderVerdictSection → stdout) end-to-end through `main()`, reading
// sidecars produced ONLY by the REAL `write-verdict` verb (also routed
// through `main()`) — never a hand-built fixture file for the happy paths —
// so a drift in the writer's on-disk shape, the reader's parse, or the
// render-verdict wiring itself fails loud here.

const RENDER_ANCHOR = 'abc1234';

describe('render-verdict subcommand', () => {
  let dir: string;
  let verdictsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'render-verdict-cli-'));
    verdictsDir = join(dir, 'verdicts');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path: renders the ## Reviewer verdict section from a sidecar written by the real write-verdict verb (exit 0)', () => {
    const payloadFile = join(dir, 'v1.json');
    writeFileSync(payloadFile, JSON.stringify(verdictAckedPayload()), 'utf-8');
    const writeCode = main([
      'write-verdict', payloadFile, '--dir', verdictsDir, '--id', 'FOR-16', '--iter', '1',
    ]);
    expect(writeCode).toBe(0);
    stdoutBuf = ''; // discard the write verb's own stdout (the sidecar path) before reading

    const code = main(['render-verdict', verdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/^## Reviewer verdict/);
    expect(stdoutBuf).toMatch(/\*\*Verdict:\*\* approve \(iteration 1\)/);
    expect(stdoutBuf).toMatch(/\*\*Risk class:\*\* mechanical/);
    expect(stdoutBuf).toMatch(new RegExp(`\\*\\*Anchor SHA:\\*\\* \`${RENDER_ANCHOR}\``));
    expect(stdoutBuf).toMatch(/\| AC1 \| met \| src\/cli\.ts:1 \|/);
    expect(stderrBuf).toBe('');
  });

  it('threads the <id> argument into the render (mention footgun): a foreign id in evidence is neutralized, the own id passes through — no new caller-side step', () => {
    // A verdict whose evidence + advisory each smuggle a foreign tracker id
    // (the W19 shape) plus the row's own id as the close target. The verb
    // resolves the sidecar by <id> AND renders with that same <id> as the own
    // id — the whole scrub happens inside `render-verdict` with no extra step.
    const payloadFile = join(dir, 'v1.json');
    writeFileSync(
      payloadFile,
      JSON.stringify(
        verdictAckedPayload({
          acVerification: [
            { ac: 'AC1', met: 'met', evidence: 'same fix as FOR-72; closes FOR-16 (this row)' },
          ],
          reviewerFocusItems: ['sibling wave/FOR-55 overlaps — merge-tree'],
        }),
      ),
      'utf-8',
    );
    expect(
      main(['write-verdict', payloadFile, '--dir', verdictsDir, '--id', 'FOR-16', '--iter', '1']),
    ).toBe(0);
    stdoutBuf = '';

    const code = main(['render-verdict', verdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR]);
    expect(code).toBe(0);
    // The own id (the <id> argument) passes through — it is the close target.
    expect(stdoutBuf).toContain('FOR-16');
    // Every OTHER tracker-id-shaped token is neutralized (contiguous token gone).
    expect(stdoutBuf).not.toContain('FOR-72');
    expect(stdoutBuf).not.toContain('FOR-55');
    // An integration scan of the rendered markdown finds ONLY the own id.
    expect(stdoutBuf.match(/[A-Z][A-Z0-9]*-\d+|#\d+/g) ?? []).toEqual(['FOR-16']);
  });

  it('max-iter selection: a changes-requested iter-1 verdict is superseded by the approve iter-2 re-dispatch verdict in the render', () => {
    const iter1 = join(dir, 'v1.json');
    writeFileSync(
      iter1,
      JSON.stringify(
        verdictAckedPayload({
          verdict: 'changes-requested',
          acVerification: [{ ac: 'AC1', met: 'not-met', evidence: 'missing' }],
        }),
      ),
      'utf-8',
    );
    expect(
      main(['write-verdict', iter1, '--dir', verdictsDir, '--id', 'FOR-16', '--iter', '1']),
    ).toBe(0);

    const iter2 = join(dir, 'v2.json');
    writeFileSync(
      iter2,
      JSON.stringify(verdictAckedPayload({ verdict: 'approve' })),
      'utf-8',
    );
    expect(
      main(['write-verdict', iter2, '--dir', verdictsDir, '--id', 'FOR-16', '--iter', '2']),
    ).toBe(0);
    stdoutBuf = '';

    const code = main(['render-verdict', verdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR]);
    expect(code).toBe(0);
    // the LATEST (iter-2) verdict wins — never the stale iter-1 changes-requested render
    expect(stdoutBuf).toMatch(/\*\*Verdict:\*\* approve \(iteration 2\)/);
    expect(stdoutBuf).not.toMatch(/changes-requested/);
  });

  it('no sidecar found for <id> (empty verdictsDir) → exit 1, nothing printed to stdout', () => {
    // verdictsDir itself is absent — readSidecars treats a missing dir as "no
    // sidecars" (same as verdict-acked), but render-verdict treats the miss
    // as a failure rather than a cosmetic no-op.
    const code = main(['render-verdict', verdictsDir, 'FOR-999', '--anchor', RENDER_ANCHOR]);
    expect(code).toBe(1);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/no verdict sidecar found for "FOR-999"/);
  });

  it('a corrupt-only sidecar for <id> also exits 1, never silently rendering a schema-invalid verdict', () => {
    mkdirSync(verdictsDir, { recursive: true });
    // Hand-write a fenced-json sidecar missing the required riskClass (the
    // write-verdict verb itself would refuse to write this — see
    // route-cli.spec.ts's "an invalid verdict" case — so a corrupt sidecar can
    // only arrive on disk some other way; write it directly here, same fixture
    // pattern verdict-acked's corrupt-sidecar case uses).
    const { riskClass: _omit, ...noRiskClass } = verdictAckedPayload();
    writeFileSync(
      join(verdictsDir, 'FOR-16-1.md'),
      '# ReviewerVerdict FOR-16 iter 1\n\n```json\n' +
        JSON.stringify(noRiskClass, null, 2) +
        '\n```\n',
      'utf-8',
    );

    const code = main(['render-verdict', verdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR]);
    expect(code).toBe(1);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/no verdict sidecar found for "FOR-16"/);
  });

  it('missing --anchor → usage (exit 2)', () => {
    const code = main(['render-verdict', verdictsDir, 'FOR-16']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/render-verdict requires <verdictsDir> <id> --anchor <sha>/);
    expect(stdoutBuf).toBe('');
  });

  it('missing args (only <verdictsDir>, no <id>, no --anchor) → usage (exit 2)', () => {
    const code = main(['render-verdict', verdictsDir]);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/render-verdict requires <verdictsDir> <id> --anchor <sha>/);
  });

  it('a bare "render-verdict" (zero args) also exits 2, via the generic zero-rest usage guard', () => {
    expect(main(['render-verdict'])).toBe(2);
  });
});

// ─── credential-probe subcommand routing (ADR-0029) ─────────────────────────
//
// The value-free auth probe is SYNC (its lookup spawn is `spawnSync`) and
// resolves no store, so — unlike issue-store / host-pr / store-preflight — it
// belongs on the plain `main()` path. These specs pin exactly that wire plus the
// end-to-end reach into the real runner; the probe's own behaviour (precedence,
// discovery, containment) lives in credential-probe-cli.spec.ts.
//
// Every case here drives a FIXTURE credential variable (`EXAMPLE_TOKEN`) set on
// `process.env` and removed again — never `GITHUB_TOKEN` / `GITHUB_TOKEN_CMD`.
// A spec that reached the developer's real `_CMD` would fire a real credential
// lookup on every test run, which is the opposite of what this verb is for.

/**
 * A REAL lookup command whose secret lives in a temp FILE rather than in the
 * command string. The probe names the configured command by design (it is the
 * pointer, and naming it is the whole point of ADR-0029's indirection), so a
 * sentinel spelled inside the command would appear in the output legitimately
 * and make the containment assertion vacuous.
 */
function fixtureSecretLookup(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cli-probe-secret-')), 'secret');
  writeFileSync(file, 'SENTINEL-A-FIXTURE-SECRET-VALUE', 'utf-8');
  return `cat '${file}'`;
}

/** Run `fn` with the fixture credential env applied, then restore process.env exactly. */
function withFixtureCredentialEnv(
  vars: Record<string, string>,
  fn: () => number,
): number {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('credential-probe subcommand routing (ADR-0029)', () => {
  it('"credential-probe" IS in the unknown-subcommand available list', () => {
    main(['frobnicate-xyz']);
    const availableLine = stderrBuf.split('\n').find((l) => l.includes('available:'));
    expect(availableLine).toBeDefined();
    const list = availableLine!
      .slice(availableLine!.indexOf('available:') + 'available:'.length)
      .split(',')
      .map((s) => s.trim());
    expect(list).toContain('credential-probe');
  });

  it('main(["credential-probe"]) hits the router zero-arg guard (exit 2), NOT unknown-subcommand', () => {
    expect(main(['credential-probe'])).toBe(2);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('reaches the runner\'s OWN usage (exit 2) on a missing selection — proof of routing, not of an unknown verb', () => {
    // `--config` alone carries no selection: the message is credential-probe's
    // own, which the top-level router usage never prints.
    const code = main(['credential-probe', '--config', '/x.json']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/credential-probe requires a selection: --all or --var/);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('the top-level usage lists credential-probe with both selection forms', () => {
    // Issue #758 re-pin: the roster line is rendered from the contract, so the
    // two selection flags are listed as the optional flags they are declared to
    // be rather than as a hand-written `(--all | --var <VAR>)` alternation. The
    // alternation itself is still taught — by the verb's OWN contract section,
    // which is what `--help` and every refusal print, and which this asserts
    // second so the pair cannot silently lose it.
    main([]);
    const line = stderrBuf.split('\n').find((l) => l.includes('flotilla-engine credential-probe'))!;
    expect(line).toBeDefined();
    expect(line).toContain('[--all]');
    expect(line).toContain('[--var <text> [--var <text> ...]]');

    stdoutBuf = '';
    expect(main(['credential-probe', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('credential-probe --all');
    expect(stdoutBuf).toContain('credential-probe --var <VAR> [--var <VAR> ...]');
  });

  it('end-to-end through main(): a REAL resolving lookup exits 0 and prints no secret', () => {
    const code = withFixtureCredentialEnv(
      { EXAMPLE_TOKEN_CMD: fixtureSecretLookup() },
      () => main(['credential-probe', '--var', 'EXAMPLE_TOKEN']),
    );
    expect(code).toBe(0);
    const report = JSON.parse(stdoutBuf) as {
      ok: boolean;
      probed: { variable: string; resolved: boolean }[];
    };
    expect(report.ok).toBe(true);
    expect(report.probed[0]).toMatchObject({ variable: 'EXAMPLE_TOKEN', resolved: true });
    expect(stdoutBuf + stderrBuf).not.toContain('SENTINEL-A-FIXTURE-SECRET-VALUE');
  });

  it('NEGATIVE CONTROL (Convention 11): a deliberately broken configured command drives main() to exit 1, value-free', () => {
    // The whole verb, end to end, through the real router, the real resolver
    // and the real shell — with the one thing the probe exists to catch
    // genuinely broken: a lookup binary that does not exist.
    const broken = 'flotilla-no-such-lookup-binary-0029 --field token';
    const code = withFixtureCredentialEnv(
      { EXAMPLE_TOKEN_CMD: broken, EXAMPLE_TOKEN: 'SENTINEL-AMBIENT-VALUE' },
      () => main(['credential-probe', '--var', 'EXAMPLE_TOKEN']),
    );

    expect(code).toBe(1);
    const report = JSON.parse(stdoutBuf) as {
      ok: boolean;
      failed: string[];
      probed: { failure: string; command: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual(['EXAMPLE_TOKEN']);
    expect(report.probed[0].failure).toBe('lookup-exit'); // sh: command not found → 127
    expect(report.probed[0].command).toBe(broken);
    expect(stderrBuf).toMatch(/credential-probe: 1 of 1 credential\(s\) failed to resolve/);
    // It did NOT quietly fall back to the ambient value.
    expect(stdoutBuf + stderrBuf).not.toContain('SENTINEL-AMBIENT-VALUE');
  });

  it('RESTORED: repairing the same command turns the very same invocation green (exit 0)', () => {
    const code = withFixtureCredentialEnv(
      { EXAMPLE_TOKEN_CMD: fixtureSecretLookup() },
      () => main(['credential-probe', '--var', 'EXAMPLE_TOKEN']),
    );
    expect(code).toBe(0);
    expect((JSON.parse(stdoutBuf) as { ok: boolean }).ok).toBe(true);
  });
});

// ─── `version` subcommand routing (ADR-0032) ─────────────────────────────────
//
// The engine half of the plugin/engine lockstep gate. Three properties are
// asserted here, and only the first is about plumbing:
//
//   1. ROUTING — `version` is a real subcommand, `--version` is its alias, and
//      a BARE `version` is exempt from the router's zero-arg guard (it is that
//      verb's primary form, and it performs no action).
//   2. STORE-FREE — the verb answers with no wave config anywhere in sight.
//      That is the AC, and it is what makes the verb usable on a machine where
//      the skew is the reason nothing else works.
//   3. NON-VACUITY — a value-less or blank `--expect` is a usage error, and a
//      missing side of the comparison is a non-match. A version gate that can
//      be silently disarmed by the invocation meant to arm it is worse than no
//      gate, because it reads as green.
//
// The engine version is DERIVED from the package's own manifest in every
// assertion below, never transcribed: a literal would go stale at the next
// release and start failing for a healthy install.

describe('version subcommand routing (ADR-0032)', () => {
  const ENGINE_MANIFEST = join(__dirname, '..', 'package.json');
  const engineVersion = (): string =>
    (JSON.parse(readFileSync(ENGINE_MANIFEST, 'utf-8')) as { version: string }).version;

  it('a BARE `version` prints the engine version as JSON and exits 0 — no store config needed', () => {
    const code = main(['version']);

    expect(code).toBe(0);
    const report = JSON.parse(stdoutBuf) as {
      version: string;
      match: boolean | null;
      outcome: string;
    };
    expect(report.version).toBe(engineVersion());
    expect(report.outcome).toBe('no-expectation');
    expect(report.match).toBeNull();
    // The zero-arg guard did NOT fire: usage would have gone to stderr instead.
    expect(stderrBuf).toBe('');
  });

  it('is routed via KNOWN_SUBCOMMANDS, not treated as an unknown subcommand', () => {
    main(['version']);
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('the top-level usage lists the verb and its --expect flag', () => {
    // Issue #758 re-pin: `<plugin-version>` was the hand-written roster's own
    // placeholder; the rendered line prints the placeholder for the flag's
    // DECLARED value type (`version`), which is the one a reader can trace back
    // to the contract.
    main([]);
    expect(stderrBuf).toMatch(/flotilla-engine version \[--expect <version>\]/);
    expect(stderrBuf).toMatch(/available subcommands: .*\bversion\b/);
  });

  it('`--version` is an alias producing byte-identical output', () => {
    const subCode = main(['version']);
    const subOut = stdoutBuf;

    stdoutBuf = '';
    const aliasCode = main(['--version']);

    expect(aliasCode).toBe(subCode);
    expect(stdoutBuf).toBe(subOut);
    // Without the alias case this token would fall into looksLikeSubcommand().
    expect(stderrBuf).not.toMatch(/unknown subcommand/);
  });

  it('MATCH: --expect at the real engine version exits 0 with match:true', () => {
    const code = main(['version', '--expect', engineVersion()]);

    expect(code).toBe(0);
    const report = JSON.parse(stdoutBuf) as {
      match: boolean;
      outcome: string;
      repair: string | null;
    };
    expect(report.match).toBe(true);
    expect(report.outcome).toBe('match');
    expect(report.repair).toBeNull();
  });

  it('NEGATIVE CONTROL (Convention 11) — MISMATCH fires end-to-end: exit 1, match:false, one-line repair', () => {
    // The ONLY difference from the passing case above is the expectation, and
    // the whole verdict flips. This is what distinguishes "the gate works" from
    // "the gate cannot fail".
    const code = main(['version', '--expect', '9.9.9-no-such-release']);

    expect(code).toBe(1);
    const report = JSON.parse(stdoutBuf) as {
      version: string;
      expected: string;
      match: boolean;
      outcome: string;
      repair: string;
    };
    expect(report.match).toBe(false);
    expect(report.outcome).toBe('mismatch');
    expect(report.version).toBe(engineVersion());
    expect(report.expected).toBe('9.9.9-no-such-release');
    expect(report.repair).toBe('npm i -D @formtrieb/flotilla-engine@9.9.9-no-such-release');
  });

  it('RESTORED: the very same invocation at the right version is green again (exit 0)', () => {
    expect(main(['version', '--expect', engineVersion()])).toBe(0);
  });

  it('the alias carries the mismatch exit code too', () => {
    expect(main(['--version', '--expect', '9.9.9-no-such-release'])).toBe(1);
  });

  it('a value-less --expect is a usage error (exit 2) — never a silently skipped check', () => {
    const code = main(['version', '--expect']);

    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/--expect requires a <plugin-version> value/);
    expect(stdoutBuf).toBe(''); // no report at all, so nothing can read as a pass
  });

  it('a blank --expect value is refused rather than read as "no expectation"', () => {
    const code = main(['version', '--expect', '   ']);
    expect(code).toBe(2);
    expect(stdoutBuf).toBe('');
  });

  it('an --expect swallowed by the next flag is refused, not bound to the flag name', () => {
    const code = main(['version', '--expect', '--config']);
    expect(code).toBe(2);
    expect(stdoutBuf).toBe('');
  });

  it('an unknown flag is a usage error naming the flag', () => {
    const code = main(['version', '--bogus']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/unknown flag --bogus/);
  });

  it('a stray positional is a usage error — the verb takes none', () => {
    const code = main(['version', '0.1.0']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/takes no positional arguments/);
  });

  it('reaches the same runner through the async entrypoint (the shipped bin path)', async () => {
    const code = await mainAsync(['version', '--expect', '9.9.9-no-such-release']);
    expect(code).toBe(1);
    expect((JSON.parse(stdoutBuf) as { outcome: string }).outcome).toBe('mismatch');
  });
});

// ─── Form 8c-quater: worktree-cleanup — a TERMINAL wave sweeps its OWN
//             residue (issue #748, ADR-0042 Amendment decisions 9–11) ────────
//
// EXTENDS the review-ref wiring block above rather than replacing it. That
// block pins the plan SHAPE against a spine whose single row is `dispatched` —
// a NON-terminal wave — and it stays green here byte-for-byte, which is the
// point: the liveness RULE this block adds must not move the reading of a wave
// that is still running.
//
// Three cases, and the middle one is the pre-existing behaviour:
//   · every row terminal   → the wave's OWN refs go, across all three
//                            namespaces, and `liveRowIds` reads `[]`.
//   · any row non-terminal → every ref of the wave is spared `live-row`, and
//                            `liveRowIds` names them.
//   · no --wave at all     → nothing is removed (`live-rows-unknown`,
//                            `liveRowIds: null`) — the fail-closed floor.
//
// Beside them: the composed-driver population (`orphans.drivers`) under the
// same terminality rule, and the deferred-branch accounting the orphan-branch
// sweep now prints.
describe('worktree-cleanup subcommand — a terminal wave sweeps its own refs and its own composed drivers (issue #748)', () => {
  let repo: string;

  const LIVE_REVIEW_REF = 'refs/review/131';
  const LIVE_SIB_REF = 'refs/review/sib/131';
  const LIVE_FLAT_SIB_REF = 'refs/sib/131';
  const OTHER_WAVE_REF = 'refs/review/999';
  const OWN_REFS = [LIVE_REVIEW_REF, LIVE_SIB_REF, LIVE_FLAT_SIB_REF];

  const SLUG = '2026-09-08-terminal-wave';

  /**
   * Drive every git subcommand `worktree-cleanup --orphans` issues. Routed by
   * subcommand + format flag, so the review-ref LISTING is never confused with
   * the orphan-BRANCH listing that rides the same `for-each-ref` verb —
   * the same routing discipline the review-ref wiring block above uses.
   *
   * `heldBranch`, when given, makes `git worktree list --porcelain` report one
   * registered worktree holding that branch: the input the deferred-branch
   * accounting is computed from.
   */
  function driveGit(opts: { heldBranch?: string; localBranches?: string[] } = {}): void {
    // Deliberately OUTSIDE the agent worktrees root: this fixture is about the
    // branch a registered worktree HOLDS, not about the registered-GC
    // population, and a path under `.claude/worktrees/wf_*` would additionally
    // enter `listAgentWorktrees` and be planned for removal here.
    const wtPath = join(repo, 'checkouts', 'held-1');
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'for-each-ref' && cmdArgs[1] === '--format=%(refname)') {
        return [...OWN_REFS, OTHER_WAVE_REF].join('\n') + '\n';
      }
      if (cmdArgs[0] === 'for-each-ref' && cmdArgs[1] === '--format=%(refname:short)') {
        return (opts.localBranches ?? []).join('\n') + '\n';
      }
      if (cmdArgs[0] === 'worktree' && cmdArgs[1] === 'list') {
        if (opts.heldBranch === undefined) return '';
        return [`worktree ${wtPath}`, 'HEAD ' + 'a'.repeat(40), `branch refs/heads/${opts.heldBranch}`, ''].join('\n');
      }
      if (cmdArgs[0] === 'symbolic-ref') return 'main\n';
      return '';
    });
  }

  /** The absolute path a `driveGit({ heldBranch })` worktree is reported at. */
  function heldWorktreePath(): string {
    return join(repo, 'checkouts', 'held-1');
  }

  /**
   * Write a spine for `SLUG` whose single row carries `state`, into the repo's
   * own waves directory — so the CLI derives BOTH the review-ref scope and the
   * composed-driver waves directory from the path it was handed.
   */
  function writeSpine(state: string): string {
    const wavesDir = join(repo, '.flotilla', 'waves');
    mkdirSync(wavesDir, { recursive: true });
    const path = join(wavesDir, `${SLUG}.md`);
    writeFileSync(
      path,
      [
        `# Wave ${SLUG}`,
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        `| 131 | Alpha | background | mechanical | universal | — | ${state} | 1 | — |`,
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        '  - "131 → agent wf_aaa (sonnet) branch wave/131-alpha"',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  /** Plant `<repo>/.flotilla/tmp/<slug>/driver.js`, as compose-driver writes it. */
  function plantDriverDir(slug: string): string {
    const dir = join(repo, '.flotilla', 'tmp', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'driver.js'), '// composed driver\n', 'utf-8');
    return dir;
  }

  interface CleanupJson {
    orphans?: {
      reviewRefs?: {
        liveRowIds: string[] | null;
        selected?: Array<{ ref: string }>;
        removed?: Array<{ ref: string }>;
        skipped: Array<{ ref: string; reason: string }>;
      };
      drivers?: {
        present: boolean;
        wavesDir: string;
        selected?: Array<{ slug: string; finishedBy: string | null }>;
        removed?: Array<{ slug: string }>;
        skipped: Array<{ slug: string; reason: string }>;
      };
    };
    orphanBranches?: {
      toDelete: string[];
      branchHygieneDeferred: Array<{
        branch: string;
        worktreePath: string | null;
        reason: string;
      }>;
    };
    branchHygieneDeferred?: Array<{
      branch: string;
      worktreePath: string | null;
      reason: string;
    }>;
  }

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'wave-cli-748-')));
    writeFileSync(join(repo, 'package.json'), '{"name":"cli-748"}', 'utf-8');
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('CASE 1 — every row TERMINAL: the wave\'s own refs are removed across all three namespaces, and liveRowIds reads []', () => {
    driveGit();
    const spine = writeSpine('pr-created');
    const code = main(['worktree-cleanup', repo, '--orphans', '--wave', spine]);
    expect(code).toBe(0);
    const rr = (JSON.parse(stdoutBuf) as CleanupJson).orphans?.reviewRefs;
    expect(rr, 'orphans.reviewRefs missing').toBeDefined();
    // Declared, and legitimately empty — the reading `null` could not express.
    expect(rr!.liveRowIds).toEqual([]);
    expect(rr!.removed!.map((r) => r.ref).sort()).toEqual(
      [...OWN_REFS, OTHER_WAVE_REF].sort(),
    );
    expect(rr!.skipped).toEqual([]);
    for (const ref of OWN_REFS) {
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['update-ref', '-d', ref],
        expect.objectContaining({ cwd: repo }),
      );
    }
  });

  it('CASE 1 — PROVE THE CHECK CAN FAIL (Convention 11): the SAME spine with the SAME refs, under the pre-#748 row-membership rule, spares every one of them', () => {
    // The old rule is reproduced exactly by leaving the row NON-terminal: the
    // wave's rows are then the live set, which is what "membership, not
    // terminality" always computed — for every wave, at every close. Under it
    // the three refs the case above deletes are all skipped `live-row`, which
    // is the failing state of CASE 1's assertion.
    driveGit();
    const spine = writeSpine('dispatched');
    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const rr = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.reviewRefs!;
    expect(rr.removed!.map((r) => r.ref)).toEqual([OTHER_WAVE_REF]);
    expect(() => {
      expect(rr.removed!.map((r) => r.ref).sort()).toEqual(
        [...OWN_REFS, OTHER_WAVE_REF].sort(),
      );
    }).toThrow();
  });

  it('CASE 2 — ANY row non-terminal: every ref of the wave is spared live-row, exactly as before, and liveRowIds names them', () => {
    driveGit();
    const spine = writeSpine('reviewing');
    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const rr = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.reviewRefs!;
    expect(rr.liveRowIds).toEqual(['131']);
    for (const ref of OWN_REFS) {
      expect(rr.skipped.find((s) => s.ref === ref)?.reason).toBe('live-row');
    }
    expect(execFileSync).not.toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', LIVE_REVIEW_REF],
      expect.anything(),
    );
  });

  it('CASE 3 — no --wave at all: nothing is removed, every ref reads live-rows-unknown, and liveRowIds is null', () => {
    driveGit();
    expect(main(['worktree-cleanup', repo, '--orphans'])).toBe(0);
    const rr = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.reviewRefs!;
    expect(rr.liveRowIds).toBeNull();
    expect(rr.removed).toEqual([]);
    expect(rr.skipped.map((s) => s.reason)).toEqual([
      'live-rows-unknown',
      'live-rows-unknown',
      'live-rows-unknown',
      'live-rows-unknown',
    ]);
  });

  it('the composed-driver population rides the SAME terminality rule under orphans.drivers — removed when terminal, live-wave when not, unknown-wave when no spine answers', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const strangerDir = plantDriverDir('2026-01-01-nobody');
    const spine = writeSpine('approved');

    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const drivers = (JSON.parse(stdoutBuf) as CleanupJson).orphans?.drivers;
    expect(drivers, 'orphans.drivers missing from the real-run CLI JSON').toBeDefined();
    expect(drivers!.present).toBe(true);
    // The waves directory is derived from the --wave path the caller passed,
    // never from a second, independently-defaulted guess.
    expect(drivers!.wavesDir).toBe(join(repo, '.flotilla', 'waves'));
    expect(drivers!.removed!.map((d) => d.slug)).toEqual([SLUG]);
    expect(existsSync(ownDir)).toBe(false);
    // `unknown-wave` is accounting, never removal.
    expect(drivers!.skipped).toEqual([
      { path: strangerDir, slug: '2026-01-01-nobody', finishedBy: null, reason: 'unknown-wave' },
    ]);
    expect(existsSync(strangerDir)).toBe(true);
  });

  it('PROVE THE CHECK CAN FAIL (Convention 11): the same driver directory with a NON-terminal spine reads live-wave and survives', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const spine = writeSpine('verdict-in');

    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const drivers = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.drivers!;
    expect(drivers.removed).toEqual([]);
    expect(drivers.skipped.map((d) => d.reason)).toEqual(['live-wave']);
    expect(existsSync(ownDir)).toBe(true);
    // …and that is the failing state of the previous test's own assertion.
    expect(() => {
      expect(drivers.removed!.map((d) => d.slug)).toEqual([SLUG]);
    }).toThrow();
  });

  it('an ARCHIVED spine is enough on its own — no --wave declaration needed for a wave that already closed', () => {
    driveGit();
    const oldDir = plantDriverDir('2026-08-30-closed');
    mkdirSync(join(repo, '.flotilla', 'waves', '_archive'), { recursive: true });
    writeFileSync(
      join(repo, '.flotilla', 'waves', '_archive', '2026-08-30-closed.md'),
      '# archived\n',
      'utf-8',
    );

    expect(main(['worktree-cleanup', repo, '--orphans'])).toBe(0);
    const drivers = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.drivers!;
    expect(drivers.removed!.map((d) => d.slug)).toEqual(['2026-08-30-closed']);
    expect(existsSync(oldDir)).toBe(false);
  });

  it('--dry-run previews the IDENTICAL plan the real run executes, and removes nothing (the issue #377 discipline)', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    plantDriverDir('2026-01-01-nobody');
    const spine = writeSpine('failed');

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine])).toBe(0);
    const preview = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.drivers!;
    expect(preview.selected!.map((d) => d.slug)).toEqual([SLUG]);
    expect(preview.selected![0].finishedBy).toBe('wave-terminal');
    expect(preview.skipped.map((d) => d.reason)).toEqual(['unknown-wave']);
    // A preview removes nothing.
    expect(existsSync(ownDir)).toBe(true);

    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const real = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.drivers!;
    // The SAME plan: the preview's `selected` and the run's `removed` are the
    // same entries, and the refusals are identical.
    expect(real.removed).toEqual(preview.selected);
    expect(real.skipped).toEqual(preview.skipped);
    expect(existsSync(ownDir)).toBe(false);
  });

  it('the deferred-branch accounting reaches BOTH shapes: branchHygieneDeferred on the real run, and inside orphanBranches on the preview', () => {
    const HELD = 'wave/131-alpha';
    driveGit({ heldBranch: HELD, localBranches: ['main', HELD] });
    const spine = writeSpine('pr-created');

    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const real = JSON.parse(stdoutBuf) as CleanupJson;
    expect(real.branchHygieneDeferred).toEqual([
      { branch: HELD, worktreePath: heldWorktreePath(), reason: 'checked-out-in-worktree' },
    ]);

    stdoutBuf = '';
    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine])).toBe(0);
    const preview = JSON.parse(stdoutBuf) as CleanupJson;
    expect(preview.orphanBranches!.toDelete).toEqual([]);
    expect(preview.orphanBranches!.branchHygieneDeferred).toEqual([
      { branch: HELD, worktreePath: heldWorktreePath(), reason: 'checked-out-in-worktree' },
    ]);
  });

  it('PROVE THE CHECK CAN FAIL (Convention 11): with NO worktree holding the branch there is nothing to defer — the empty list is the honest reading, and it is the one an unfixed safety floor gives for BOTH cases', () => {
    const HELD = 'wave/131-alpha';
    driveGit({ localBranches: ['main', HELD] });
    const spine = writeSpine('pr-created');
    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as CleanupJson;
    expect(parsed.branchHygieneDeferred).toEqual([]);
    // The pre-#748 code produced this SAME empty list while a worktree WAS
    // holding the branch — which is exactly why the previous test's assertion
    // is falsifiable rather than tautological.
    expect(() => {
      expect(parsed.branchHygieneDeferred).toEqual([
        { branch: HELD, worktreePath: heldWorktreePath(), reason: 'checked-out-in-worktree' },
      ]);
    }).toThrow();
  });

  it('a composed-driver removal FAILURE forces exit 1, while both refusals never do', () => {
    driveGit();
    const dir = plantDriverDir(SLUG);
    const spine = writeSpine('abandoned');
    // Deny write on the scratch ROOT so the child directory cannot be unlinked
    // — a real permission refusal, the same technique issue #417's own fixture
    // uses rather than mocking node:fs.
    chmodSync(join(repo, '.flotilla', 'tmp'), 0o500);
    try {
      const code = main(['worktree-cleanup', repo, '--orphans', '--wave', spine]);
      const drivers = (JSON.parse(stdoutBuf) as CleanupJson).orphans!.drivers!;
      expect(drivers.removed).toEqual([]);
      expect(code).toBe(1);
    } finally {
      chmodSync(join(repo, '.flotilla', 'tmp'), 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WITHOUT --orphans neither shape carries orphans.drivers, and the scratch root is never read for this population', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const spine = writeSpine('parked');
    expect(main(['worktree-cleanup', repo, '--wave', spine])).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect('orphans' in parsed).toBe(false);
    expect(existsSync(ownDir)).toBe(true);
  });
});

// ─── worktree-cleanup — the PARKED-only wave, the fifth terminal state
//             (issue #772) ───────────────────────────────────────────────────
//
// The gap this block closes, stated as the measurement that found it: the
// terminal-wave verdict was driven through `pr-created`, `approved`, `failed`
// and `abandoned`, and `parked` only ever through a run WITHOUT `--orphans` —
// which never computes the verdict at all. A Reviewer replaced the CLI's
// `parked` literal with a typo and the whole suite (75 files, 4467 tests) stayed
// green. The literal is now a member of the spine reader's typed
// `TERMINAL_ROW_STATES`, so `tsc` catches a misspelling at the declaration; this
// block is the runtime half, and it is what fails if the member is ever dropped
// from the set rather than misspelled in it.
//
// Deliberately SELF-CONTAINED — its own repo, its own git drive, its own spine
// writer — rather than an `it` appended inside the issue-#748 block above. The
// wave that carries this row has three later rounds landing in this same file,
// and a block with no shared fixture is a block none of them can disturb.
//
// A parked-only wave is not a hypothetical shape: ADR-0022's park exit is what
// `wave-close`'s awaiting-human gate prescribes, so a wave whose every row was
// parked is a wave that took the documented exit on all of them. Its refs and
// its composed driver are residue exactly like any other finished wave's.
describe('worktree-cleanup — a PARKED-only wave is terminal and sweeps its own residue (issue #772)', () => {
  let repo: string;

  const SLUG = '2026-09-16-parked-only';
  // Row 131 carries all three ref namespaces; row 132 makes "EVERY row is
  // parked" a claim about more than one row — a per-row rule would read this
  // spine the same way, a wave-level one only agrees when both are terminal.
  const OWN_REFS = ['refs/review/131', 'refs/review/sib/131', 'refs/sib/131', 'refs/review/132'];
  const STRANGER_REF = 'refs/review/777';

  interface ParkedCleanupJson {
    orphans?: {
      reviewRefs?: {
        liveRowIds: string[] | null;
        selected?: Array<{ ref: string }>;
        removed?: Array<{ ref: string }>;
        skipped: Array<{ ref: string; reason: string }>;
      };
      drivers?: {
        selected?: Array<{ slug: string; finishedBy: string | null }>;
        removed?: Array<{ slug: string }>;
        skipped: Array<{ slug: string; reason: string }>;
      };
    };
  }

  /** Drive the git calls `worktree-cleanup --orphans` issues, and nothing else. */
  function driveGit(): void {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'for-each-ref' && cmdArgs[1] === '--format=%(refname)') {
        return [...OWN_REFS, STRANGER_REF].join('\n') + '\n';
      }
      if (cmdArgs[0] === 'for-each-ref' && cmdArgs[1] === '--format=%(refname:short)') {
        return '\n';
      }
      if (cmdArgs[0] === 'symbolic-ref') return 'main\n';
      return '';
    });
  }

  /**
   * A two-row spine for `SLUG`. Both rows carry `state` unless `secondState`
   * says otherwise — the mixed-spine case is the only caller that differs.
   */
  function writeSpine(state: string, secondState: string = state): string {
    const wavesDir = join(repo, '.flotilla', 'waves');
    mkdirSync(wavesDir, { recursive: true });
    const path = join(wavesDir, `${SLUG}.md`);
    writeFileSync(
      path,
      [
        `# Wave ${SLUG}`,
        '',
        '**Status:** in-flight',
        '',
        '## Plan-Table',
        '',
        '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
        '|---|---|---|---|---|---|---|---|---|',
        `| 131 | Alpha | background | mechanical | universal | — | ${state} | 1 | — |`,
        `| 132 | Beta | background | mechanical | universal | — | ${secondState} | 1 | — |`,
        '',
        '## Resume-Metadata',
        '',
        '```yaml',
        'dispatch-log:',
        '  - "131 → agent wf_aaa (sonnet) branch wave/131-alpha"',
        '  - "132 → agent wf_bbb (sonnet) branch wave/132-beta"',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    return path;
  }

  /** Plant `<repo>/.flotilla/tmp/<slug>/driver.js`, as compose-driver writes it. */
  function plantDriverDir(slug: string): string {
    const dir = join(repo, '.flotilla', 'tmp', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'driver.js'), '// composed driver\n', 'utf-8');
    return dir;
  }

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'wave-cli-772-')));
    writeFileSync(join(repo, 'package.json'), '{"name":"cli-772"}', 'utf-8');
  });

  afterEach(() => {
    vi.mocked(execFileSync).mockImplementation(() => '');
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('every row PARKED: the wave\'s own refs are selected across all three namespaces, its driver directory is selected wave-terminal, and liveRowIds reads []', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const spine = writeSpine('parked');

    // `--dry-run` so BOTH populations report under `selected` — and so the one
    // assertion this row exists for is about the PLAN, which the real run then
    // executes verbatim (the issue #377 discipline the block above pins).
    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine])).toBe(0);
    const preview = JSON.parse(stdoutBuf) as ParkedCleanupJson;

    const rr = preview.orphans!.reviewRefs!;
    // Declared, and legitimately empty — the reading `null` could not express,
    // and the reading a NON-terminal parked wave would not produce.
    expect(rr.liveRowIds).toEqual([]);
    expect(rr.selected!.map((r) => r.ref).sort()).toEqual([...OWN_REFS, STRANGER_REF].sort());
    expect(rr.skipped).toEqual([]);

    const drivers = preview.orphans!.drivers!;
    expect(drivers.selected!.map((d) => d.slug)).toEqual([SLUG]);
    expect(drivers.selected![0].finishedBy).toBe('wave-terminal');

    // A preview removes nothing.
    expect(existsSync(ownDir)).toBe(true);
    expect(execFileSync).not.toHaveBeenCalledWith(
      'git',
      ['update-ref', '-d', 'refs/review/131'],
      expect.anything(),
    );
  });

  it('...and the real run executes that plan: all four refs deleted, the driver directory gone', () => {
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const spine = writeSpine('parked');

    expect(main(['worktree-cleanup', repo, '--orphans', '--wave', spine])).toBe(0);
    const real = JSON.parse(stdoutBuf) as ParkedCleanupJson;
    expect(real.orphans!.reviewRefs!.removed!.map((r) => r.ref).sort()).toEqual(
      [...OWN_REFS, STRANGER_REF].sort(),
    );
    expect(real.orphans!.drivers!.removed!.map((d) => d.slug)).toEqual([SLUG]);
    expect(existsSync(ownDir)).toBe(false);
    for (const ref of OWN_REFS) {
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['update-ref', '-d', ref],
        expect.objectContaining({ cwd: repo }),
      );
    }
  });

  it('PROVE THE CHECK CAN FAIL (Convention 11): one row back to `reviewing` and the SAME refs and the SAME driver directory are spared live-row / live-wave', () => {
    // The falsifying input for the case above, and the one that would also fire
    // if `parked` were ever dropped from `TERMINAL_ROW_STATES` (or misspelled in
    // it, before the type gate made that impossible): a wave whose rows are not
    // all terminal keeps every one of its own refs and its own driver.
    driveGit();
    const ownDir = plantDriverDir(SLUG);
    const spine = writeSpine('reviewing');

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine])).toBe(0);
    const preview = JSON.parse(stdoutBuf) as ParkedCleanupJson;

    const rr = preview.orphans!.reviewRefs!;
    expect(rr.liveRowIds!.sort()).toEqual(['131', '132']);
    expect(rr.selected!.map((r) => r.ref)).toEqual([STRANGER_REF]);
    for (const ref of OWN_REFS) {
      expect(rr.skipped.find((s) => s.ref === ref)?.reason).toBe('live-row');
    }

    const drivers = preview.orphans!.drivers!;
    expect(drivers.selected).toEqual([]);
    expect(drivers.skipped.map((d) => d.reason)).toEqual(['live-wave']);
    expect(existsSync(ownDir)).toBe(true);

    // …and this IS the failing state of the parked case's own assertions, not a
    // merely different one.
    expect(() => {
      expect(rr.liveRowIds).toEqual([]);
    }).toThrow();
    expect(() => {
      expect(drivers.selected!.map((d) => d.slug)).toEqual([SLUG]);
    }).toThrow();
  });

  it('a MIXED spine is not terminal either — parked rows do not carry a still-running sibling over the line', () => {
    // The wave-level rule, asked of the state this row adds. A per-row reading
    // would sweep row 131's refs here; the shipped rule sweeps neither.
    driveGit();
    const spine = writeSpine('parked', 'dispatched');

    expect(main(['worktree-cleanup', repo, '--orphans', '--dry-run', '--wave', spine])).toBe(0);
    const rr = (JSON.parse(stdoutBuf) as ParkedCleanupJson).orphans!.reviewRefs!;
    expect(rr.liveRowIds!.sort()).toEqual(['131', '132']);
    expect(rr.selected!.map((r) => r.ref)).toEqual([STRANGER_REF]);
    expect(rr.skipped.find((s) => s.ref === 'refs/review/131')?.reason).toBe('live-row');
  });
});

// ─── issue #751 — the close-row verb is wired into the router ────────────────
//
// Same shape as the `compose-driver` and `route-tuple` blocks earlier in this
// file, and for the same reason: the roster is self-pinning (the unknown-verb
// block derives its ground truth from the printed `available:` line), so what
// needs its own assertions is the ROUTING. `close-row` resolves a store — the
// done-reconcile ends in the tracker's own `close(id, prUrl, acked)` — so it
// must be intercepted by `mainAsync` before the sync router.
//
// Convention 11 falsification for this block: deleting the
// `if (argv[0] === 'close-row')` interception from `mainAsync` makes the SECOND
// test below fail. The discriminator is deliberately the runner's OWN first
// usage line, and it had to be: the sync router's zero-arg guard prints the
// whole-CLI usage dump, which ALSO names --spine/--id (the verb's own usage
// line lives in it), so asserting those flag names alone is a check that cannot
// fail. The observed failing output is recorded in this row's report.
describe('close-row — router wiring (issue #751)', () => {
  it('is on the verb roster, so it never reaches the unknown-subcommand path', () => {
    const code = main(['definitely-bogus-verb']);
    expect(code).toBe(2);
    const summaryLine = stderrBuf.split('\n').find((l) => l.includes('available:'))!;
    expect(summaryLine).toContain('close-row');
    // …and its purpose line rides along, one per verb.
    expect(stderrBuf).toMatch(/^ {2}close-row {2}\S/m);
  });

  it("mainAsync intercepts it BEFORE the sync router — the answer is the RUNNER's own usage, not the router's whole-CLI dump", async () => {
    const code = await mainAsync(['close-row']);
    expect(code).toBe(2);
    // Only the RUNNER can print this line, and it is the first thing it prints.
    expect(stderrBuf.split('\n')[0]).toBe('error: close-row requires --spine <spine>');
    expect(stderrBuf).toMatch(/--pr-url/);
    // …and neither the sync router's async refusal nor its whole-CLI dump answered.
    expect(stderrBuf).not.toMatch(/invoke it via the async entrypoint/);
    expect(stderrBuf).not.toMatch(/available subcommands:/);
  });

  it('the sync main() refuses it the way it refuses every other async verb', () => {
    const code = main(['close-row', '--spine', 'x']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/close-row is async/);
    expect(stderrBuf).toMatch(/mainAsync/);
  });

  it('the top-level usage names the verb and its required flags', () => {
    main([]); // zero args → printUsage()
    const usageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine close-row'))!;
    expect(usageLine).toBeDefined();
    expect(usageLine).toContain('--spine');
    expect(usageLine).toContain('--id');
    expect(usageLine).toContain('--pr-url');
  });

  it('a missing --id reaches the runner too, not the router — the second required flag', async () => {
    const code = await mainAsync(['close-row', '--spine', 'x']);
    expect(code).toBe(2);
    expect(stderrBuf.split('\n')[0]).toBe('error: close-row requires --id <id>');
  });
});

// ─── `host-pr status` teaches its title/body read at the CLI edge (row 777) ──
//
// The verb grew two result keys — the PR's live `title` and `body` — and the
// only way a caller who did not read this row's diff finds out is the usage
// text. Two surfaces print it and they are maintained separately: the VERB's own
// contract section (issue #505 — printed once the verb is known, so a wrong flag
// on `status` teaches only `status`) and the full multi-verb dump (printed when
// no verb narrows it). A capability documented on one and not the other is the
// ordinary shape of this drift, so both are asserted here, through the real
// async wire rather than by reading the source.
//
// Deliberately NOT asserted here: the verb's behaviour. That is
// host-pr-cli.spec.ts's, and duplicating it would make this file fail for
// reasons that have nothing to do with the CLI edge.

describe('host-pr status usage names the title/body read (row 777)', () => {
  let stderrBuf = '';

  beforeEach(() => {
    stderrBuf = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrBuf += String(c);
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the status verb's OWN contract section names both fields, read-only and call-free", async () => {
    // A missing --branch is the cheapest way to the verb-scoped usage: the
    // router knows the verb, so `usage(msg, verb)` prints VERB_CONTRACT.status.
    const code = await mainAsync(['host-pr', 'status']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('`title`');
    expect(stderrBuf).toContain('`body`');
    expect(stderrBuf).toMatch(/Read-only/);
    expect(stderrBuf).toMatch(/no extra host call/);
    // …and it still teaches what an ABSENT key means, which is what stops a
    // caller reading "no body" off a host that simply does not surface one.
    expect(stderrBuf).toMatch(/absent/i);
    expect(stderrBuf).toMatch(/never an empty string/i);
  });

  it('the full multi-verb dump carries the same read, so a caller who named no verb finds it too', async () => {
    const code = await mainAsync(['host-pr']);
    expect(code).toBe(2);

    // Slice out STATUS's own paragraph rather than searching the whole dump: a
    // file-wide match would be satisfied by `create`'s section, which legitimately
    // talks about a PR's title and body because a reuse REWRITES them. That is the
    // opposite claim from this one, and a pin that cannot tell the two apart would
    // pass with status's paragraph deleted.
    const lines = stderrBuf.split('\n');
    const from = lines.findIndex((l) => l.startsWith('  status '));
    expect(from, 'the dump no longer carries a `status` verb paragraph').toBeGreaterThan(-1);
    const rest = lines.slice(from + 1);
    const nextVerb = rest.findIndex((l) => /^ {2}\S/.test(l));
    const statusSection = rest.slice(0, nextVerb === -1 ? rest.length : nextVerb).join('\n');

    expect(statusSection).toContain('`title`');
    expect(statusSection).toContain('`body`');
    expect(statusSection).toMatch(/no extra host call/);
    expect(statusSection).toMatch(/never an empty string/i);
  });
});

// ─── row V5 — `--json` on this file's prose/product verbs (ADR-0051 dec. 7) ──
//
// Three verbs of the eight this row covers live in cli.ts: `dor` (class `prose`,
// in BOTH its forms), `files-drift` (class `prose`, with a JSON block it has
// always embedded) and `render-verdict` (class `product`). The block below pins,
// for each of them:
//
//   1. the `--json` SHAPE — contract from landing (ADR-0035), so a Coordinator
//      or a pulse can key on it without probing;
//   2. the DEFAULT output, byte-identically — the flag adds a rendering, it
//      never edits the one that was already there;
//   3. that `--json` moves NO exit code — the negative control the row's body
//      names by hand: a failing gate still exits 1, WITH its JSON.
//
// The classes come from row V1's Verb contract and are read there rather than
// re-decided here: `files-drift` is `prose` with the note that `--json` prints
// only the embedded block, and `render-verdict` is `product`, which is why its
// pin below asserts the flag changes nothing at all.

/** The parsed `dor --json` answer, for the assertions below. */
interface DorJsonAnswer {
  verb: string;
  overall: string;
  issues: {
    issue: string;
    overall: string;
    gates: { name: string; status: string; reason?: string }[];
  }[];
}

describe('dor --json (row V5) — the readiness gate answers as JSON in both forms', () => {
  it('the FILE form prints { verb, overall, issues[] } and nothing else', () => {
    const code = main(['dor', '--json', issueFile]);
    expect(code).toBe(0);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.verb).toBe('dor');
    expect(answer.overall).toBe('PASS');
    expect(answer.issues).toHaveLength(1);
    expect(answer.issues[0].issue).toBe(issueFile);
    expect(answer.issues[0].overall).toBe('PASS');
    expect(stderrBuf).toBe('');
  });

  it('carries every gate with its own name, status and reason — the PROSE gate list, verbatim', () => {
    // Derived from the prose rather than transcribed: the two renderings are
    // two views of ONE result, and a spec that hard-codes the gate roster is a
    // spec that goes stale the day a gate is added.
    main(['dor', issueFile]);
    const proseGates = stdoutBuf
      .split('\n')
      .slice(1)
      .filter((l) => l.startsWith('  '))
      .map((l) => l.trim().split(/\s+/)[2]);
    stdoutBuf = '';

    main(['dor', '--json', issueFile]);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.issues[0].gates.map((g) => g.name)).toEqual(proseGates);
    for (const gate of answer.issues[0].gates) {
      expect(['pass', 'warn', 'fail', 'deferred']).toContain(gate.status);
    }
  });

  it('keeps the deferred/pass distinction the gate carries — never flattened to a boolean', () => {
    main(['dor', '--json', issueFile]);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    const statuses = new Set(answer.issues[0].gates.map((g) => g.status));
    // This fixture reaches both: the working-tree gates defer without a repo
    // checkout, and the self-content gates pass. A shape that said only
    // "ok: true/false" could not tell an operator which of the two it was.
    expect(statuses.has('deferred')).toBe(true);
    expect(statuses.has('pass')).toBe(true);
  });

  it('omits `reason` on a gate that gave none — a key that carried nothing did not carry anything', () => {
    main(['dor', '--json', issueFile]);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    const withReason = answer.issues[0].gates.filter((g) => 'reason' in g);
    const without = answer.issues[0].gates.filter((g) => !('reason' in g));
    expect(withReason.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const g of withReason) expect(typeof g.reason).toBe('string');
  });

  it('answers ONE envelope for several issue paths, with the roll-up over all of them', () => {
    const missing = join(root, 'no-such-file.md');
    const code = main(['dor', '--json', issueFile, missing]);
    // A gate FAILED, so the code is 1 — the flag chose a rendering, not a verdict.
    expect(code).toBe(1);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.overall).toBe('FAIL');
    expect(answer.issues.map((i) => i.issue)).toEqual([issueFile, missing]);
    expect(answer.issues[0].overall).toBe('PASS');
    // The unreadable file is reported as its own gate, not as a missing record.
    expect(answer.issues[1].gates).toEqual([
      { name: 'read-issue-file', status: 'fail', reason: expect.stringContaining('ENOENT') },
    ]);
  });

  it('NEGATIVE CONTROL: a failing gate still exits non-zero WITH its JSON', () => {
    const code = main(['dor', '--json', join(root, 'no-such-file.md')]);
    expect(code).toBe(1);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.overall).toBe('FAIL');
  });

  it("NEGATIVE CONTROL: without --json, dor prints TODAY'S prose, byte for byte", () => {
    main(['dor', issueFile]);
    const before = stdoutBuf;
    expect(before).toMatch(/^PASS {2}/);
    expect(before.endsWith('\n')).toBe(true);
    expect(before).not.toContain('{');
    stdoutBuf = '';
    // …and the SAME call again is the same bytes, so the pin above is a pin.
    main(['dor', issueFile]);
    expect(stdoutBuf).toBe(before);
  });

  it('the --id form answers the SAME envelope, holding one issue', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    const code = await runDorById(['--id', id, '--json'], store);
    expect(code).toBe(0);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.verb).toBe('dor');
    expect(answer.overall).toBe('PASS');
    expect(answer.issues).toHaveLength(1);
    // The subject is the ROW ID here and the path on the file form — exactly
    // what each form's prose header carries in its second column.
    expect(answer.issues[0].issue).toBe(id);
    expect(answer.issues[0].gates.length).toBeGreaterThan(0);
  });

  it('the --id form: a content-gate FAIL still exits 1, with the failing gate named in the JSON', async () => {
    const store = fakeStore(async (id) => ({
      id,
      risk: 'mechanical',
      worker: 'background-sonnet', // retired Ur value — not in the default set
      files: ['src/foo.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'x', checked: false }],
      status: 'available',
    }));

    const code = await runDorById(['--id', '42', '--json'], store);
    expect(code).toBe(1);
    const answer = JSON.parse(stdoutBuf) as DorJsonAnswer;
    expect(answer.overall).toBe('FAIL');
    expect(answer.issues[0].gates.some((g) => g.status === 'fail')).toBe(true);
  });

  it("NEGATIVE CONTROL: the --id form without --json prints TODAY'S prose", async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);
    await runDorById(['--id', id], store);
    expect(stdoutBuf).toMatch(new RegExp(`^PASS\\s+${id}`, 'm'));
    expect(stdoutBuf).not.toContain('"verb"');
  });

  it('the --id form still refuses a stray positional under --json — the flag is not a way past the arity', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);
    const code = await runDorById(['--id', id, '--json', 'stray.md'], store);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('unexpected argument "stray.md"');
  });

  it("dor's own usage names the JSON form beside the prose note", () => {
    expect(main(['dor', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('output: text (PASS/FAIL + gate lines), not JSON');
    expect(stdoutBuf).toContain('--json: the same result as JSON, in BOTH forms');
    expect(stdoutBuf).toContain(
      '{ verb, overall, issues: [ { issue, overall, gates: [ { name, status, reason? } ] } ] }',
    );
  });
});

describe('files-drift --json (row V5) — the embedded block, and only the block', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReturnValue('some/file.ts\n');
  });

  it('prints ONLY the JSON block — no status line, no rationale prose, no framing', () => {
    const code = main(['files-drift', issueFile, 'abc..def', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { status: string; driftedFiles: string[] };
    expect(parsed.status).toBe('clean');
    expect(parsed.driftedFiles).toEqual([]);
    expect(stdoutBuf).not.toContain('--- JSON output ---');
    expect(stdoutBuf).not.toContain('✓ clean');
    expect(stderrBuf).toBe('');
  });

  it('is byte-identical to the block the prose form embeds — one owner, two renderings', () => {
    main(['files-drift', issueFile, 'abc..def']);
    const embedded = stdoutBuf.split('--- JSON output ---\n')[1];
    stdoutBuf = '';
    main(['files-drift', issueFile, 'abc..def', '--json']);
    // The prose form's trailing newline is the one the renderer appends; the
    // --json form's is printJson's. Compare the JSON text itself.
    expect(stdoutBuf.trim()).toBe(embedded.trim());
  });

  it('reads the two positionals through the CONTRACT, so --json may lead', () => {
    // Before this row `args[0]` was the issue path outright, so a leading
    // `--json` would have been validated as an issue FILE.
    const code = main(['files-drift', '--json', issueFile, 'abc..def']);
    expect(code).toBe(0);
    expect((JSON.parse(stdoutBuf) as { status: string }).status).toBe('clean');
  });

  it('NEGATIVE CONTROL: a cross-project drift still exits 2, with its JSON', () => {
    vi.mocked(execFileSync).mockReturnValue('some/file.ts\nother-project/unrelated.ts\n');
    const code = main(['files-drift', issueFile, 'abc..def', '--json']);
    expect(code).toBe(2);
    expect((JSON.parse(stdoutBuf) as { status: string }).status).toBe('cross-project-drift');
  });

  it("NEGATIVE CONTROL: without --json the prose form prints TODAY'S bytes — framing included", () => {
    main(['files-drift', issueFile, 'abc..def']);
    expect(stdoutBuf).toMatch(/^✓ clean\n/);
    expect(stdoutBuf).toContain('\n--- JSON output ---\n');
    expect(stdoutBuf.endsWith('\n')).toBe(true);
  });

  it("files-drift's own usage names the JSON form beside the prose note", () => {
    expect(main(['files-drift', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('output: text, with a JSON block embedded at the end');
    expect(stdoutBuf).toContain(
      '--json: ONLY that block — { status, driftedFiles, rationale, projectScopes }',
    );
  });
});

describe('render-verdict --json (row V5) — class `product`, so the flag is inert', () => {
  let renderDir: string;
  let renderVerdictsDir: string;

  beforeEach(() => {
    renderDir = mkdtempSync(join(tmpdir(), 'render-verdict-json-'));
    renderVerdictsDir = join(renderDir, 'verdicts');
  });

  afterEach(() => {
    rmSync(renderDir, { recursive: true, force: true });
  });

  function writeVerdictSidecar(): void {
    const payloadFile = join(renderDir, 'v1.json');
    writeFileSync(payloadFile, JSON.stringify(verdictAckedPayload()), 'utf-8');
    expect(
      main([
        'write-verdict', payloadFile, '--dir', renderVerdictsDir, '--id', 'FOR-16', '--iter', '1',
      ]),
    ).toBe(0);
    stdoutBuf = '';
  }

  it('accepts --json and IGNORES it: the markdown is byte-identical either way', () => {
    writeVerdictSidecar();
    expect(main(['render-verdict', renderVerdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR])).toBe(0);
    const plain = stdoutBuf;
    stdoutBuf = '';
    expect(
      main(['render-verdict', renderVerdictsDir, 'FOR-16', '--anchor', RENDER_ANCHOR, '--json']),
    ).toBe(0);
    expect(stdoutBuf).toBe(plain);
    expect(stdoutBuf).toMatch(/^## Reviewer verdict/);
    // Not a JSON document, and deliberately not one: the markdown IS the result.
    expect(() => JSON.parse(stdoutBuf) as unknown).toThrow();
  });

  it('a MISS still exits 1 under --json, and still says so on stderr', () => {
    writeVerdictSidecar();
    const code = main([
      'render-verdict', renderVerdictsDir, 'FOR-999', '--anchor', RENDER_ANCHOR, '--json',
    ]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/no verdict sidecar found/);
    expect(stdoutBuf).toBe('');
  });

  it("render-verdict's own usage states the class, so nobody files the inertness as a gap", () => {
    expect(main(['render-verdict', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('--json: accepted and IGNORED');
    expect(stdoutBuf).toContain('product');
  });
});

describe('the router roster names each JSON form beside the prose note (row V5)', () => {
  // Rendered from each verb's OWN contract, never transcribed — so this pin
  // fails if the roster and the contract ever describe two shapes. Issue #758
  // moved that derivation INSIDE the roster renderer (row V5's standalone
  // `jsonFormNote()` helper is gone, as its own comment asked), and collapsed
  // `dor`'s two hand-written roster lines into the one signature its single
  // contract describes — so the `--id` form is a flag on that line now, not a
  // line of its own.
  it('names it on every one of the eight verbs this row covers', () => {
    main([]); // zero args → printUsage()
    const lineFor = (needle: string) => stderrBuf.split('\n').find((l) => l.includes(needle))!;

    expect(lineFor('flotilla-engine dor <issue-path>')).toContain('--json: the same result as JSON');
    expect(lineFor('flotilla-engine dor <issue-path>')).toContain('[--id <id>]');
    expect(lineFor('flotilla-engine files-drift')).toContain('--json: ONLY that block');
    expect(lineFor('flotilla-engine config validate')).toContain('--json: the same verdict as JSON');
    expect(lineFor('flotilla-engine validate-report')).toContain('{ verb, file, valid, errors }');
    expect(lineFor('flotilla-engine validate-verdict')).toContain('{ verb, file, valid, errors }');
    expect(lineFor('flotilla-engine write-report')).toContain('{ verb, path, id, iter }');
    expect(lineFor('flotilla-engine write-verdict')).toContain('{ verb, path, id, iter }');
    expect(lineFor('flotilla-engine render-verdict')).toContain('accepted and IGNORED');
  });

  it("each roster note is the verb's own contract line, not a second copy of it", () => {
    main([]);
    const rosterLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine files-drift'))!;
    stderrBuf = '';
    expect(main(['files-drift', '--help'])).toBe(0);
    const contractLine = stdoutBuf.split('\n').find((l) => l.trimStart().startsWith('--json'))!;
    expect(rosterLine).toContain(contractLine.trim());
  });
});

// ─── the roster is RENDERED from the contracts (issue #758) ──────────────────
//
// The router's whole-CLI usage used to be ~50 hand-maintained lines describing
// the same verbs the Verb contracts already describe, and a hand-maintained
// description of a parser drifts from it in exactly one direction: something
// the parser reads goes unmentioned. Three measured instances at the anchor —
// `compose-driver` naming ten of its thirteen flags, `store-preflight` naming
// one of its three, `host-pr status` naming neither `--method` nor `--config`.
//
// Rendered, an omission is no longer EXPRESSIBLE, and that is what the first
// test below asserts: for every verb and every group op in the aggregate, every
// canonical flag the contract declares appears on that verb's roster line. It
// is a structural check over the whole surface, not a list of the three lines
// that happened to be wrong — the same discipline verb-contract-drift.spec.ts
// applies to the flag literals themselves.

describe('the roster renders every verb and every group op from its contract (issue #758)', () => {
  /** The roster, as the router prints it on a bare invocation. */
  function roster(): string[] {
    stderrBuf = '';
    expect(main([])).toBe(2);
    return stderrBuf.split('\n');
  }

  /** The one roster line that invokes `verb` — never a prefix of another verb. */
  function lineFor(lines: string[], verb: string): string {
    const matches = lines.filter(
      (l) => l.startsWith(`  flotilla-engine ${verb} `) || l.trimEnd() === `  flotilla-engine ${verb}`,
    );
    expect(matches, `expected exactly one roster line for \`${verb}\``).toHaveLength(1);
    return matches[0];
  }

  it('names EVERY canonical flag of EVERY contract — the omission class, closed by construction', () => {
    const lines = roster();
    const missing: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const line = lineFor(lines, verb);
      for (const flagToken of canonicalFlagTokens(contract)) {
        // Word-boundary, so `--report` does not pass by riding inside
        // `--report-file`: a flag is named when its own spelling is a token.
        if (!new RegExp(`(?<![\\w-])${flagToken}(?![\\w-])`).test(line)) {
          missing.push(`${verb}: ${flagToken}`);
        }
      }
    }
    expect(missing.join('\n')).toBe('');
  });

  it('lists one line per top-level verb AND one per group op — no `<op>` stands in for a table', () => {
    const lines = roster();
    const keys = Object.keys(verbContracts());
    expect(keys.length).toBeGreaterThan(60);
    for (const verb of keys) expect(lineFor(lines, verb)).toBeDefined();
    // The four group tokens no longer get a line of their own that stands for
    // their ops — every op is there by name.
    for (const op of ['issue-store goal-frontier', 'spine set-status', 'host-pr preflight', 'config validate']) {
      expect(lineFor(lines, op)).toBeDefined();
    }
  });

  it('the driver-composition line carries the three flags it used to omit, by construction', () => {
    // The ticket's named defect. Asserted against the CONTRACT rather than a
    // transcribed list of thirteen spellings: what makes the omission
    // impossible is that the line is built from `contract.flags`, so the
    // expectation is built from the same place.
    const line = lineFor(roster(), 'compose-driver');
    for (const flagToken of canonicalFlagTokens(verbContracts()['compose-driver'])) {
      expect(line).toContain(flagToken);
    }
    for (const flagToken of ['--template', '--reports-dir', '--verdicts-dir']) {
      expect(line).toContain(flagToken);
    }
  });

  it('spells the CANONICAL flag first and names each alias exactly once', () => {
    const lines = roster();
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const line = lineFor(lines, verb);
      const aliases = contract.flags.flatMap((f) => (f.aliases ?? []).map((a) => [a, f.canonical]));
      if (aliases.length === 0) {
        expect(line, `${verb} declares no alias`).not.toContain('; aliases: ');
        continue;
      }
      for (const [alias, canonical] of aliases) {
        expect(line).toContain(`${alias} → ${canonical}`);
        // Named ONCE: in the alias note, never a second time in the signature.
        // Token-wise, because `--reports` is a PREFIX of the canonical
        // `--reports-dir` standing right there — a plain substring test reads
        // the canonical spelling as its own alias and fails on a correct line.
        const signature = line.slice(0, line.indexOf('   # '));
        expect(
          new RegExp(`(?<![\\w-])${alias}(?![\\w-])`).test(signature),
          `${verb} spells ${alias} in its signature`,
        ).toBe(false);
      }
    }
  });

  it("ends every line with the verb's declared output class as an inline note", () => {
    const lines = roster();
    const NOTE: Record<string, string> = {
      prose: 'prints text, not JSON',
      json: 'prints JSON',
      'silent-write': 'prints nothing on success',
      product: 'prints the artifact itself',
    };
    for (const [verb, contract] of Object.entries(verbContracts())) {
      expect(lineFor(lines, verb)).toContain(`   # ${NOTE[contract.output]}`);
    }
  });

  it('never prints an unnamed positional slot — every declared slot has a label', () => {
    // The renderer falls back to `<arg1>` when a contract declares a positional
    // count and no names for it. That fallback exists so a new contract cannot
    // crash the roster; a line that actually SHOWS it is a contract that has
    // not said what its arguments are, which is the same defect as a missing
    // flag one column over.
    for (const line of roster()) {
      expect(line).not.toMatch(/<arg\d+>/);
    }
  });

  it('the roster has no second copy of a verb\'s prose — the contract section is the one place', () => {
    // Row V5's `jsonFormNote()` is absorbed into the renderer, and the last
    // hand-copied paragraph pairs (`--title`'s precedence rule, `--body-file`'s
    // guidance) are gone from the roster. What proves the absorption is that
    // the `--json` clause a roster line carries is BYTE-IDENTICAL to the one
    // that verb's own `--help` prints.
    const line = lineFor(roster(), 'write-verdict');
    stdoutBuf = '';
    expect(main(['write-verdict', '--help'])).toBe(0);
    const contractClause = stdoutBuf.split('\n').find((l) => l.trimStart().startsWith('--json'))!;
    expect(contractClause).toBeDefined();
    expect(line).toContain(contractClause.trim());
  });
});

// ─── a flag the parser reads is named in the verb's OWN usage too ────────────
//
// The roster guard above closes the omission class for the roster. This closes
// it for the other surface a caller reads — the verb's own contract section,
// which `--help` prints and every refusal reprints. Both halves are needed:
// rendering the roster cannot fix a contract section that never mentioned
// `--method`, and `host-pr status`'s did not.
//
// The same check runs over the positional LABELS, because a slot the parser
// counts and the usage does not name is the same defect one column over.

describe('every contract section names every flag the parser reads (issue #758)', () => {
  it('names every canonical flag the contract declares', () => {
    const missing: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const text = contract.usage.join('\n');
      for (const flagToken of canonicalFlagTokens(contract)) {
        if (!new RegExp(`(?<![\\w-])${flagToken}(?![\\w-])`).test(text)) {
          missing.push(`${verb}: ${flagToken}`);
        }
      }
    }
    expect(missing.join('\n')).toBe('');
  });

  it('names every positional slot it declares a label for', () => {
    const missing: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const text = contract.usage.join('\n');
      const arity = contract.positionals;
      const labels =
        arity.kind === 'variadic'
          ? arity.label === undefined
            ? []
            : [arity.label]
          : (arity.labels ?? []);
      for (const label of [...labels, ...(contract.twin ?? []).map((t) => t.label)]) {
        if (!text.includes(label)) missing.push(`${verb}: ${label}`);
      }
    }
    expect(missing.join('\n')).toBe('');
  });
});

// ─── the zero-argument answer is THAT verb's usage (issue #758) ──────────────

describe('a subcommand invoked with no arguments gets its own usage, not the whole CLI', () => {
  // The eleven verbs the ticket measured falling back to the whole-CLI block,
  // plus the two the router reaches through the same guard.
  const VERBS = [
    'route-verdict',
    'route-outcome',
    'write-report',
    'write-verdict',
    'conflict-map',
    'cross-wave',
    'resume',
    'credential-probe',
    'validate-report',
    'validate-verdict',
    'verdict-acked',
    'render-verdict',
    'dor',
    'files-drift',
    'merge-order',
    'closed-by',
    'detect-host',
    'worktree-cleanup',
  ];

  for (const verb of VERBS) {
    it(`\`${verb}\` with no arguments prints its own contract section and nothing else`, () => {
      expect(main([verb])).toBe(2);
      // Its OWN usage — the same text `--help` prints…
      expect(stderrBuf).toContain(verbContracts()[verb].usage[0]);
      // …and NOT the whole-CLI block, whose two tells are the roster trailer
      // and a sibling verb that has nothing to do with this call.
      expect(stderrBuf).not.toContain('available subcommands:');
      expect(stderrBuf).not.toContain('flotilla-engine issue-store goal-frontier');
      expect(stdoutBuf).toBe('');
    });
  }

  it('a verb GROUP with no op gets THAT group\'s ops, not every verb in the engine', () => {
    expect(main(['config'])).toBe(2);
    expect(stderrBuf).toContain('usage: flotilla-engine config <validate> [...args]');
    expect(stderrBuf).toContain('flotilla-engine config validate <path>');
    expect(stderrBuf).not.toContain('available subcommands:');
    expect(stderrBuf).not.toContain('flotilla-engine spine ');
  });

  it('`spine` with no op lists the spine ops and no other verb', () => {
    expect(main(['spine'])).toBe(2);
    expect(stderrBuf).toContain('flotilla-engine spine set-row-state <spine-path> <id> <state>');
    expect(stderrBuf).toContain('flotilla-engine spine check-disclosures <spine-path>');
    expect(stderrBuf).not.toContain('flotilla-engine issue-store ');
    expect(stderrBuf).not.toContain('available subcommands:');
  });

  it('a BARE invocation still gets the whole roster — the router IS what is being asked about', () => {
    expect(main([])).toBe(2);
    expect(stderrBuf).toContain('available subcommands:');
  });

  it('`version` keeps its exemption: a bare call is that verb\'s primary form', () => {
    expect(main(['version'])).toBe(0);
    expect(JSON.parse(stdoutBuf)).toHaveProperty('version');
  });
});

// ─── row 821's two guarantees, ASSERTED here rather than re-implemented ──────
//
// `--help` interception before any store or host is constructed, and the
// unknown-flag refusal, are row 821's and are on `main`. This row renders the
// text those mechanisms print, so what it owes is a pin that neither moved —
// stated as this row's own spec (the issue's fifth acceptance criterion) rather
// than left to the specs that installed them.

describe('issue #758 asserts row 821: --help reaches no store, an undeclared flag exits 2', () => {
  it('`issue-store --help` answers with the op roster and never resolves a store', async () => {
    // No injected store and no config in reach: if this call resolved a store
    // it would throw — or, on a configured machine, reach the tracker, which is
    // the network probe the ticket measured. Exit 0 with the roster on stdout
    // is the proof that the interception still runs first.
    const code = await mainAsync(['issue-store', '--help']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('usage: issue-store <create|read|');
    expect(stderrBuf).toBe('');
  });

  it('`store-preflight --help` answers without resolving a store either', async () => {
    const code = await mainAsync(['store-preflight', '--help']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('usage: store-preflight');
    expect(stderrBuf).toBe('');
  });

  it('an undeclared flag still exits 2 with that verb\'s own usage and a did-you-mean', () => {
    expect(main(['worktree-cleanup', '--dry-runn'])).toBe(2);
    expect(stderrBuf).toContain('error: worktree-cleanup: unknown flag --dry-runn');
    expect(stderrBuf).toContain('did you mean --dry-run?');
    // That refusal prints the VERB's usage, never the roster — the #505 rule.
    expect(stderrBuf).not.toContain('available subcommands:');
  });
});

// ─── what moved, pinned line by line (issue #758) ────────────────────────────
//
// The roster stopped carrying verb prose, and three runners stopped carrying a
// hand-written copy of their own first usage line. Neither is a deletion: the
// prose moved into the contract that owns it, and the runners print that
// contract now. Each move is pinned here so "default prose changed only where
// the rendered usage replaced the hand-written one" is a claim with a test
// behind it rather than a sentence in a report.

describe('the prose the roster used to hold now lives in the contract that owns it (issue #758)', () => {
  it('worktree-cleanup teaches the --detached sweep population on its own usage', () => {
    // It used to be a roster detail line under the verb, reachable only by
    // provoking the whole-CLI dump.
    expect(main(['worktree-cleanup', '--help'])).toBe(0);
    expect(stdoutBuf).toMatch(/--detached also sweeps REGISTERED detached-HEAD scratch checkouts/);
    expect(stdoutBuf).toMatch(/E2BIG population/);
    expect(stdoutBuf).toContain('--wave is accepted as an alias of --spine.');
  });

  it('host-pr status states both accepted-and-discarded tolerances it never named', async () => {
    // `--method` and `--config` are read by the parser on this verb and were in
    // neither its usage line nor its prose — the omission class, found by the
    // contract-section guard above rather than by reading.
    expect(await mainAsync(['host-pr', 'status', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('--method');
    expect(stdoutBuf).toContain('--config <path>');
    expect(stdoutBuf).toMatch(/store-blind/);
  });

  it('credential-probe states its --config tolerance', () => {
    expect(main(['credential-probe', '--help'])).toBe(0);
    expect(stdoutBuf).toMatch(/--config <path> is accepted and IGNORED/);
  });

  it('`files-drift` answers a missing argument with its CONTRACT section, not a private copy of it', () => {
    // Reached with ONE positional, so the router's zero-argument guard is not
    // what answers — this is the runner's own missing-argument branch, which
    // used to carry a hand-written copy of the verb's first usage line.
    expect(main(['files-drift', 'only-one-argument'])).toBe(2);
    expect(stderrBuf).toContain('error: files-drift requires two arguments');
    // Byte-identical to what `--help` prints, which is the whole claim: one
    // text, two doors.
    for (const line of verbContracts()['files-drift'].usage) expect(stderrBuf).toContain(line);
  });

  for (const verb of ['closed-by', 'detect-host'] as const) {
    it(`\`${verb}\` answers an argument-less call with its CONTRACT section`, () => {
      // These two take a single positional and no flags, so "no argument" and
      // "no arguments at all" are the same call: the router's focused zero-arg
      // answer gets there first, and it prints the same contract section the
      // runner's own branch now prints. One text either way is the point.
      expect(main([verb])).toBe(2);
      for (const line of verbContracts()[verb].usage) expect(stderrBuf).toContain(line);
    });
  }

  it('`config validate` with no path answers with the op\'s contract section', () => {
    expect(main(['config', 'validate'])).toBe(2);
    for (const line of verbContracts()['config validate'].usage) expect(stderrBuf).toContain(line);
  });

  it("the host-pr group dump's per-verb signatures are each verb's own contract line", async () => {
    // It used to carry a shortened second copy of each signature, headed by a
    // comment asserting the group takes NO --config — while every verb of the
    // group declares it and the parser accepts it. Derived, the denial is not
    // expressible: each line IS the contract's, `--config` included.
    expect(await mainAsync(['host-pr'])).toBe(2);
    for (const verb of ['create', 'arm', 'merge', 'status', 'preflight']) {
      const contractLine = verbContracts()[`host-pr ${verb}`].usage[0].replace(/^usage: /, '');
      expect(stderrBuf).toContain(contractLine);
      expect(contractLine).toContain('--config <path>');
    }
    expect(stderrBuf).not.toContain('deliberately NO --config');
  });

  it('`cross-wave` missing a required flag answers with its contract section', () => {
    expect(main(['cross-wave', '--candidates', '/x.json'])).toBe(2);
    for (const line of verbContracts()['cross-wave'].usage) expect(stderrBuf).toContain(line);
  });

  it("the host-pr group dump names every check `preflight` reports, `pr-create-token` included", async () => {
    // A preflight report a caller cannot find the names of is a report they
    // have to run the verb to discover. The GitHub create-right check is the
    // newest of the five and the easiest to leave unmentioned — it is
    // host-conditional, so a reader on Bitbucket never sees it in output at
    // all. The usage text is where they learn it exists.
    expect(await mainAsync(['host-pr'])).toBe(2);
    for (const name of [
      'pr-merge-token',
      'allow-auto-merge',
      'required-checks',
      'create-credentials',
      'pr-create-token',
    ]) {
      expect(stderrBuf).toContain(name);
    }
  });
});

// ─── the sections are RENDERED now, and the guards became the net (issue #856)
//
// Row 758 closed the omission class on the roster by construction and on the
// verb's own section by GUARD: the two checks above read every contract's
// hand-written `usage` back against its flags and its positional labels, and
// found three real omissions on their first run. This row renders the section
// too, so those two guards can no longer be the mechanism — they are the
// regression net, and a net is worth what it can still catch.
//
// Hence this block. It does not re-assert what the guards assert; it asserts
// that they DISCRIMINATE — that a section missing a declared flag still fails
// them — and it pins the four refusal prints that stopped being private copies.

describe('the row-758 section guards still discriminate (issue #856)', () => {
  /** The flag half of the guard above, as a predicate over one contract. */
  function flagsMissingFromSection(contract: VerbContract): string[] {
    const text = contract.usage.join('\n');
    return canonicalFlagTokens(contract).filter(
      (token) => !new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text),
    );
  }

  it('finds nothing on the shipped surface — the guard above, restated as its predicate', () => {
    const missing = Object.entries(verbContracts()).flatMap(([verb, c]) =>
      flagsMissingFromSection(c).map((f) => `${verb}: ${f}`),
    );
    expect(missing.join('\n')).toBe('');
  });

  it('…and FIRES on a contract whose section leaves a declared flag unmentioned', () => {
    // Rendering makes the omission hard to reach, not impossible: a verb with
    // declared FORMS renders only the flags its forms name, so a flag left out
    // of every form and out of every note is invisible again. That is exactly
    // `credential-probe --config`'s shape — it is in no form and survives only
    // because the contract declares a note about it. Drop the note and the
    // guard fires, which is the demonstration.
    const live = verbContracts()['credential-probe'];
    expect(flagsMissingFromSection(live)).toEqual([]);

    const withoutTheNote = defineVerb({ ...live, notes: [] });
    expect(flagsMissingFromSection(withoutTheNote)).toEqual(['--config']);
  });

  it('…and the POSITIONAL half fires on a slot no form names', () => {
    const live = verbContracts()['conflict-map'];
    const labelsMissing = (c: VerbContract): string[] => {
      const text = c.usage.join('\n');
      const arity = c.positionals;
      const labels =
        arity.kind === 'variadic'
          ? arity.label === undefined
            ? []
            : [arity.label]
          : (arity.labels ?? []);
      return labels.filter((l) => !text.includes(l));
    };
    expect(labelsMissing(live)).toEqual([]);

    // The store form alone — the path form's `<issue-path>` slot is then
    // declared and never printed.
    const storeFormOnly = defineVerb({ ...live, forms: [(live.forms ?? [])[1]] });
    expect(labelsMissing(storeFormOnly)).toEqual(['<issue-path>']);
  });
});

describe('a missing required flag answers with the RENDERED section (issue #856)', () => {
  // Four runners kept a private hand-written usage printer, reached only by
  // getting the call wrong. `route-tuple`'s had gone stale against its own
  // `--help` — it still named the pre-decision-5 payload spellings — which is
  // the concrete harm of a second copy. All four print the contract now.

  it('`route-tuple` names the flag, then its own section, exit 2', async () => {
    expect(await mainAsync(['route-tuple', '--spine', 'x.md'])).toBe(2);
    const lines = stderrBuf.split('\n');
    expect(lines[0]).toBe('error: route-tuple requires --id <id>');
    for (const line of verbContracts()['route-tuple'].usage) {
      expect(stderrBuf).toContain(line);
    }
    // The renamed spellings, and only those.
    expect(stderrBuf).toContain('--report-file <path> --verdict-file <path>');
    expect(stdoutBuf).toBe('');
  });

  it('`compose-driver` does the same', async () => {
    expect(await mainAsync(['compose-driver', '--spine', 'x.md'])).toBe(2);
    expect(stderrBuf.split('\n')[0]).toBe('error: compose-driver requires --out <path>');
    for (const line of verbContracts()['compose-driver'].usage) {
      expect(stderrBuf).toContain(line);
    }
  });

  it('`close-row` does the same, and its four extra paragraphs came with it', async () => {
    expect(await mainAsync(['close-row', '--spine', 'x.md'])).toBe(2);
    expect(stderrBuf.split('\n')[0]).toBe('error: close-row requires --id <id>');
    for (const line of verbContracts()['close-row'].usage) {
      expect(stderrBuf).toContain(line);
    }
  });

  it('`store-preflight` does the same — and stops calling itself `cli-store preflight`', async () => {
    // Reached through the RUNNER, because this is the module-invocation door:
    // `npx tsx tools/wave/src/cli-store.ts <op> …`, where an op that is not
    // `preflight` is the refusal. Through the router the same mistake is a
    // stray positional and is answered by the shared refusal path instead —
    // which prints the same section, from the same place.
    expect(await runStorePreflight(['not-an-op'])).toBe(2);
    expect(stderrBuf.split('\n')[0]).toContain('error: unknown op "not-an-op"');
    for (const line of verbContracts()['store-preflight'].usage) {
      expect(stderrBuf).toContain(line);
    }
    // The private copy spelled the verb by its MODULE path; the contract spells
    // it by the subcommand every skill invokes.
    expect(stderrBuf).not.toContain('usage: cli-store preflight');
    expect(stderrBuf).toContain('usage: store-preflight ');
  });
});

describe('the spine group roster is rendered from SPINE_CONTRACTS (issue #856)', () => {
  it('the group\'s own roster lists every op, each line equal to that op\'s rendered invocation', () => {
    // `spine <op>` with a missing positional falls back to this runner's whole
    // op roster — the surface `SPINE_OP_ARGS` used to spell as prose.
    expect(main(['spine', 'set-row-state'])).toBe(2);
    const printed = stderrBuf.split('\n');
    expect(printed[0]).toBe('usage:');
    for (const [verb, contract] of Object.entries(verbContracts())) {
      if (!verb.startsWith('spine ')) continue;
      for (const invocation of renderInvocations(contract)) {
        expect(printed, verb).toContain(`  ${invocation}`);
      }
    }
  });

  it('the `available:` roster and the op sections come from the ONE table', () => {
    // FOR-11's finding was a hand-maintained roster that had lost `set-status`.
    // `SPINE_OP_ARGS` — the prose table those printers read — is gone; both
    // surfaces read the contracts now, so the two cannot disagree.
    expect(main(['spine', '__no_such_op__'])).toBe(2);
    const match = /available: ([^\n]+)/.exec(stderrBuf);
    expect(match).not.toBeNull();
    const advertised = (match as RegExpExecArray)[1].split(', ').map((s) => s.trim());
    const declared = Object.keys(verbContracts())
      .filter((v) => v.startsWith('spine '))
      .map((v) => v.slice('spine '.length));
    expect(advertised).toEqual(declared);
    for (const op of advertised) {
      const lines = stderrBuf
        .split('\n')
        .filter((l) => l.trim().startsWith(`spine ${op} `) || l.trim() === `spine ${op}`);
      expect(lines, `one arg-shape line for ${op}`).toHaveLength(1);
    }
  });
});

// ─── the Catalog: the aggregate, EMITTED (ADR-0051 decision 2) ───────────────
//
// ADR-0051 named four readers of a Verb contract — the parser, the refusal,
// `--help`, and the Catalog — and 2.7.0 shipped three of them. Its own
// CHANGELOG said so under *Not yet proven*: "the Catalog (contracts as JSON) is
// decided, not built; no out-of-tree reader of the exported contracts yet."
// This block is the fourth reader's spec.
//
// What it owes is not "some JSON appears on stdout" but that the JSON **is**
// the aggregate: one entry per verb and per group op, every field read from the
// contract rather than transcribed beside it. So every expectation here is
// derived from `verbContracts()`, the same discipline the roster guards above
// run under and for the same reason — a spec that retyped the five facts the
// Catalog publishes would itself be the second hand-maintained description of
// the contracts that ADR-0051 exists to make impossible.

describe('`catalog` emits the router aggregate as JSON (ADR-0051 decision 2)', () => {
  /** The parsed Catalog, off a real router run. */
  function emitted(): { verb: string; verbs: VerbContract[] } {
    stdoutBuf = '';
    expect(main(['catalog'])).toBe(0);
    return JSON.parse(stdoutBuf) as { verb: string; verbs: VerbContract[] };
  }

  /** One contract as JSON round-trips it — absent optionals dropped, nothing else. */
  function asJson(contract: VerbContract): VerbContract {
    return JSON.parse(JSON.stringify(contract)) as VerbContract;
  }

  it('prints one entry per verb AND per group op — the aggregate\'s own count', () => {
    const catalog = emitted();
    expect(catalog.verb).toBe('catalog');
    const aggregate = verbContracts();
    expect(catalog.verbs).toHaveLength(Object.keys(aggregate).length);
    expect(catalog.verbs.map((c) => c.verb).sort()).toEqual(Object.keys(aggregate).sort());
    // A group op is an entry in its own right: `spine <op>` does not stand in
    // for thirteen of them, the same rule the roster follows one surface over.
    for (const verb of [
      'spine add-disclosure',
      'issue-store triage-apply',
      'host-pr create',
      'config validate',
    ]) {
      expect(
        catalog.verbs.some((c) => c.verb === verb),
        verb,
      ).toBe(true);
    }
  });

  it('every entry IS its contract — nothing re-spelled on the way out', () => {
    // The strongest form of the claim, and the only one that also covers the
    // fields nobody thought to name: each emitted entry equals the exported
    // contract as JSON, field for field. An emitter that dropped `aliases`,
    // renamed `valueType` or transcribed a positional arity fails here whatever
    // else it gets right.
    const byVerb = new Map(emitted().verbs.map((c) => [c.verb, c]));
    const drifted: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      if (JSON.stringify(byVerb.get(verb)) !== JSON.stringify(asJson(contract))) {
        drifted.push(verb);
      }
    }
    expect(drifted.join(', ')).toBe('');
  });

  it('carries the five facts the Catalog exists to publish, each read off the contract', () => {
    // Canonical spelling, aliases, value kinds, positional arity, output class
    // — asserted one by one as well as wholesale above, because the equality
    // check would still pass if BOTH sides lost a field and these cannot.
    const byVerb = new Map(emitted().verbs.map((c) => [c.verb, c]));
    let aliasesSeen = 0;
    let repeatableSeen = 0;
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const entry = byVerb.get(verb) as VerbContract;
      expect(entry, verb).toBeDefined();
      expect(entry.output, `${verb} output class`).toBe(contract.output);
      expect(entry.positionals, `${verb} positional arity`).toEqual(asJson(contract).positionals);
      expect(
        entry.flags.map((f) => f.canonical),
        `${verb} canonical spellings`,
      ).toEqual(canonicalFlagTokens(contract));
      for (const [i, f] of contract.flags.entries()) {
        expect(entry.flags[i].value, `${verb} ${f.canonical} value kind`).toBe(f.value);
        expect(entry.flags[i].valueType, `${verb} ${f.canonical} value type`).toBe(f.valueType);
        expect(entry.flags[i].aliases ?? [], `${verb} ${f.canonical} aliases`).toEqual(
          f.aliases ?? [],
        );
        if ((f.aliases ?? []).length > 0) aliasesSeen++;
        if (f.value === 'repeatable') repeatableSeen++;
      }
    }
    // The two facts a contract may legally omit are actually PRESENT on the
    // shipped surface, so the loop measured them rather than walking past an
    // empty set on every verb and reporting a pass it never earned.
    expect(aliasesSeen).toBeGreaterThan(0);
    expect(repeatableSeen).toBeGreaterThan(0);
  });

  it('sorts by verb, and the sort is the only transformation', () => {
    const verbs = emitted().verbs.map((c) => c.verb);
    expect(verbs).toEqual([...verbs].sort());
    expect(new Set(verbs)).toEqual(new Set(Object.keys(verbContracts())));
  });

  it('declares its own contract, and the Catalog contains exactly one of it', () => {
    const contract = verbContracts().catalog;
    expect(contract).toBeDefined();
    expect(emitted().verbs.filter((c) => c.verb === 'catalog')).toHaveLength(1);
    // The roster names it like any other verb…
    stderrBuf = '';
    expect(main([])).toBe(2);
    expect(stderrBuf).toContain('  flotilla-engine catalog   # prints JSON');
    expect(stderrBuf).toMatch(/available subcommands: .*\bcatalog\b/);
    // …and `--help` answers with its own section, exit 0, nothing on stderr.
    stdoutBuf = '';
    stderrBuf = '';
    expect(main(['catalog', '--help'])).toBe(0);
    expect(stdoutBuf.split('\n')[0]).toBe(contract.usage[0]);
    expect(stderrBuf).toBe('');
  });

  it('a BARE call is its primary form — never the zero-argument usage', () => {
    // `catalog` joins `version` in the router's zero-arg exemption: it has no
    // target to name, so "no arguments" is the whole invocation rather than a
    // caller who left something out.
    stdoutBuf = '';
    stderrBuf = '';
    expect(main(['catalog'])).toBe(0);
    expect(stderrBuf).toBe('');
    expect(JSON.parse(stdoutBuf).verbs.length).toBeGreaterThan(60);
  });

  it('refuses an undeclared flag — exit 2, its own section, a did-you-mean', () => {
    stdoutBuf = '';
    stderrBuf = '';
    expect(main(['catalog', '--helpp'])).toBe(2);
    expect(stderrBuf).toContain('error: catalog: unknown flag --helpp');
    expect(stderrBuf).toContain('did you mean --help?');
    expect(stderrBuf).toContain(verbContracts().catalog.usage[0]);
    expect(stdoutBuf).toBe('');
  });

  it('`--json` is accepted and changes nothing — the output class is already json', () => {
    stdoutBuf = '';
    expect(main(['catalog'])).toBe(0);
    const bare = stdoutBuf;
    stdoutBuf = '';
    expect(main(['catalog', '--json'])).toBe(0);
    expect(stdoutBuf).toBe(bare);
  });

  it('NEGATIVE CONTROL — a projection that drops one field fails the equality check', () => {
    // The check above is worth exactly what it can fail on. This builds the
    // emitter's defect by hand — an entry naming four of the five facts and
    // silently losing the aliases — and runs the SAME comparison against it, so
    // the failure is observed here rather than assumed.
    const contract = verbContracts()['worktree-cleanup'];
    expect(contract.flags.some((f) => (f.aliases ?? []).length > 0)).toBe(true);
    const projected = {
      verb: contract.verb,
      flags: contract.flags.map((f) => ({
        canonical: f.canonical,
        value: f.value,
        valueType: f.valueType,
      })),
      positionals: contract.positionals,
      output: contract.output,
    };
    expect(JSON.stringify(projected)).not.toBe(JSON.stringify(asJson(contract)));
    // …and the live emitter does not look like that.
    const live = emitted().verbs.find((c) => c.verb === 'worktree-cleanup');
    expect(JSON.stringify(live)).toBe(JSON.stringify(asJson(contract)));
  });
});
