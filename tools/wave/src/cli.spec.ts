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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, mainAsync, runDorById, findRepoRoot } from './cli';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import type { CreateInput, IssueStore } from './adapters/issue-store';
import type { IssueView } from './contract';
// Imported ONLY to derive the real op vocab from the actual dispatch tables
// (FOR-11 AC2) — never to duplicate a hand-maintained list in this spec.
import { runSpine } from './spine-cli';
import { runIssueStore } from './issue-store-cli';

// Mock node:child_process so files-drift integration tests can control the
// git diff output without spawning a real git process. The mock is applied
// to the whole module; tests that do NOT call files-drift are unaffected
// because they never reach getChangedFilesFromGit.
vi.mock('node:child_process', () => ({
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

  it('a real (non-dry-run) run surfaces every structural field — deregisteredNotDeleted, branchesDeleted, branchHygieneSkipped — so work is never invisible', () => {
    const code = main(['worktree-cleanup', root]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as Record<string, unknown>;
    expect(parsed.removed).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.deregisteredNotDeleted).toEqual([]);
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
});

// ─── resume entrypoint duplication resolved (FOR-11) ──────────────────────────
//
// The reconciler has its OWN separate entrypoint, `resume-cli.ts` — it is not
// a `cli.ts` subcommand (and was never meant to be one; the wave-resume skill
// has always documented it that way). It used to ALSO be reachable as
// `cli.ts resume`, which was the two-entrypoint confusion the live-gate retro
// flagged (docs/retros/2026-07-15-wire-contract.md, P-12). These specs pin the
// resolution: `main(['resume', ...])` is now an ordinary unknown subcommand
// (not silently routed to a runner), and the usage text points operators at
// the one canonical entrypoint instead.

describe('resume entrypoint — cli.ts has no "resume" subcommand (FOR-11)', () => {
  it('"resume" is not in the unknown-subcommand available list', () => {
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
    expect(list).not.toContain('resume');
  });

  it('main(["resume", ...]) is routed as an UNKNOWN subcommand (exit 2), not to a runner', () => {
    const code = main(['resume', '--spine', 'whatever']);
    expect(code).toBe(2);
    expect(stderrBuf).toMatch(/unknown subcommand: resume/);
  });

  it('the top-level usage points to resume-cli.ts as the separate canonical entrypoint', () => {
    main([]);
    expect(stderrBuf).toMatch(/resume-cli\.ts/);
    expect(stderrBuf).toMatch(/separate entrypoint/i);
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
      .find((l) => l.includes('wave-validate spine '));
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
