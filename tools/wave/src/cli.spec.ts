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
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, mainAsync, runDorById, findRepoRoot } from './cli';
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
    expect(stderrBuf).toMatch(/--spine, --reports and --verdicts are required/);
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

  it('renders the working-tree + cross-issue gates as deferred', async () => {
    const store = tmpStore();
    const id = await store.create(DOR_INPUT);

    await runDorById(['--id', id], store);

    expect(stdoutBuf).toMatch(/deferred\s+files-glob-valid/);
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
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
    // The cross-issue gate still defers (it needs other issues, not a checkout).
    expect(stdoutBuf).toMatch(/deferred\s+blocked-by-chain-resolves/);
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
// issue: Gate 8 is advisory-only by design (FOR-127 AC2) — it WARNs, and
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
      '(advisory-only per repo policy, FOR-127 AC2 — see the judgment-call note above the ' +
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
      expect(stdoutBuf).toMatch(/No verify config supplied/);
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
  });

  it('exits 1 with a clear stderr message when --config points at an unreadable file', () => {
    const code = main(['dor', '--config', join(root, 'no-such-config.json'), issueFile]);

    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/could not load --config/);
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
  it('every real `spine` op (from spine-cli\'s own dispatch table) appears in the top-level usage line for `spine`', () => {
    // Trigger spine-cli's own `default:` case — its "available: ..." message
    // IS the actual dispatch table, not a copy of it.
    const code = runSpine(['__unknown_op__', '/some/spine/path.md']);
    expect(code).toBe(2);
    const realOps = parseAvailableList(stderrBuf);
    expect(realOps.length).toBeGreaterThan(0);

    stderrBuf = ''; // fresh capture for the top-level usage output
    main([]);
    const spineUsageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine spine '));
    expect(spineUsageLine).toBeDefined();
    for (const op of realOps) {
      expect(spineUsageLine).toContain(op);
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
    const ops = spineCliOps();
    stderrBuf = '';
    main([]);
    const spineUsageLine = stderrBuf
      .split('\n')
      .find((l) => l.includes('flotilla-engine spine '));
    expect(spineUsageLine).toBeDefined();
    for (const op of ['human-gated', 'check-awaiting-human']) {
      expect(ops).toContain(op);
      expect(spineUsageLine).toContain(op);
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
    // A bitbucket remote → the typed adapter-not-implemented exit, which proves
    // the args reached the host-pr runner (network is never touched).
    const code = await mainAsync([
      'host-pr', 'status', '--branch', 'b',
      '--remote', 'git@bitbucket.org:ws/repo.git',
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

  it('routes "host-pr create" as a known subcommand (FOR-28) — bitbucket → typed not-implemented', async () => {
    // A bitbucket remote proves the create verb reached the host-pr runner and
    // was host-gated there — no network, no GITHUB_TOKEN needed.
    const code = await mainAsync([
      'host-pr', 'create', '--branch', 'b', '--title', 'T', '--body', 'x',
      '--remote', 'git@bitbucket.org:ws/repo.git',
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
    main([]);
    expect(stderrBuf).toMatch(/flotilla-engine credential-probe \(--all \| --var <VAR>/);
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
    main([]);
    expect(stderrBuf).toMatch(/flotilla-engine version \[--expect <plugin-version>\]/);
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
