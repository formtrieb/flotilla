import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeConflictMap,
  loadIssueGlobs,
  extractIssueId,
  type IssueGlobs,
} from './conflict-map';

/**
 * Each test spins up a throwaway repo-like tree under $TMPDIR. Real files
 * back the glob expansion so the fast-glob side-effect is exercised end-to-
 * end; concrete-path entries skip the fs entirely (mirrors the prod policy).
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-conflict-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeRealFile(relPath: string): void {
  const abs = join(root, relPath);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '// placeholder', 'utf-8');
}

function writeIssue(slug: string, name: string, body: string): string {
  const dir = join(root, '.scratch', slug, 'issues');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
}

describe('computeConflictMap — AC case 1: disjoint globs', () => {
  it('returns an empty cells array when every issue touches different files', () => {
    writeRealFile('libs/features/tasks/add-jobticket/src/lib/strings.ts');
    writeRealFile('libs/features/tasks/edit-jobticket/src/lib/strings.ts');
    writeRealFile(
      'libs/example-ds/src/lib/components/2-input-and-form-controls/text-field/text-field.ts',
    );

    const inputs: IssueGlobs[] = [
      {
        issueId: '01',
        files: ['libs/features/tasks/add-jobticket/src/lib/strings.ts'],
      },
      {
        issueId: '02',
        files: ['libs/features/tasks/edit-jobticket/src/lib/strings.ts'],
      },
      {
        issueId: '03',
        files: [
          'libs/example-ds/src/lib/components/2-input-and-form-controls/text-field/**',
        ],
      },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.issues).toEqual(['01', '02', '03']);
    expect(result.cells).toEqual([]);
  });
});

describe('computeConflictMap — AC case 2: same-file overlap', () => {
  it('detects identical concrete-path entries in two issues', () => {
    const inputs: IssueGlobs[] = [
      {
        issueId: '04',
        files: ['libs/features/shared/src/lib/_internal/format-validators.ts'],
      },
      {
        issueId: '05',
        files: [
          'libs/features/shared/src/lib/_internal/format-validators.ts',
          'libs/features/tasks/edit-jobticket/src/lib/save.ts',
        ],
      },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual({
      a: '04',
      b: '05',
      files: ['libs/features/shared/src/lib/_internal/format-validators.ts'],
    });
  });

  it('emits exactly one cell per pair (canonical lexicographic order)', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '20', files: ['libs/foo/x.ts'] },
      { issueId: '10', files: ['libs/foo/x.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].a).toBe('10');
    expect(result.cells[0].b).toBe('20');
  });
});

describe('computeConflictMap — AC case 3: dir-glob overlap', () => {
  it('detects collision when a glob and a concrete path resolve to the same file', () => {
    writeRealFile('libs/features/tasks/foo/src/lib/strings.ts');
    writeRealFile('libs/features/tasks/bar/src/lib/strings.ts');
    writeRealFile('libs/features/tasks/baz/src/lib/strings.ts');

    const inputs: IssueGlobs[] = [
      { issueId: '06', files: ['libs/features/tasks/*/src/lib/strings.ts'] },
      {
        issueId: '07',
        files: ['libs/features/tasks/foo/src/lib/strings.ts'],
      },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].files).toEqual([
      'libs/features/tasks/foo/src/lib/strings.ts',
    ]);
  });

  it('detects collision when two globs overlap on a subset of files', () => {
    writeRealFile('libs/features/pages/a/src/lib/foo.ts');
    writeRealFile('libs/features/pages/a/src/lib/bar.ts');
    writeRealFile('libs/features/pages/b/src/lib/foo.ts');

    const inputs: IssueGlobs[] = [
      { issueId: '08', files: ['libs/features/pages/a/src/lib/*.ts'] },
      { issueId: '09', files: ['libs/features/pages/**/foo.ts'] },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].files).toEqual([
      'libs/features/pages/a/src/lib/foo.ts',
    ]);
  });
});

describe('computeConflictMap — AC case 4: cross-slug globs', () => {
  it('detects same-file overlap when issues come from different scratch slugs', () => {
    writeRealFile('libs/features/shared/src/lib/_internal/strings.ts');

    const inputs: IssueGlobs[] = [
      {
        issueId: 'wave-orch#11',
        files: ['libs/features/shared/src/lib/_internal/strings.ts'],
      },
      {
        issueId: 'design-system#04',
        files: ['libs/features/shared/src/lib/_internal/strings.ts'],
      },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].files).toEqual([
      'libs/features/shared/src/lib/_internal/strings.ts',
    ]);
  });
});

describe('computeConflictMap — edge cases', () => {
  it('handles empty input', () => {
    expect(computeConflictMap([], { repoRoot: root })).toEqual({
      issues: [],
      cells: [],
    });
  });

  it('handles single-issue input (no pairs possible)', () => {
    const result = computeConflictMap(
      [{ issueId: '01', files: ['libs/x.ts'] }],
      { repoRoot: root },
    );
    expect(result.issues).toEqual(['01']);
    expect(result.cells).toEqual([]);
  });

  it('handles 4-issue wave with one overlapping pair', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['libs/a.ts'] },
      { issueId: '02', files: ['libs/b.ts'] },
      { issueId: '03', files: ['libs/b.ts'] },
      { issueId: '04', files: ['libs/d.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toEqual({
      a: '02',
      b: '03',
      files: ['libs/b.ts'],
    });
  });

  it('handles a glob that resolves to nothing (no contribution to intersections)', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['libs/no-match-anywhere/**/*.ts'] },
      { issueId: '02', files: ['libs/no-match-anywhere/**/*.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    // Both globs resolve to ∅; intersection of ∅ ∩ ∅ is ∅ → no cell.
    expect(result.cells).toEqual([]);
  });

  it('sorts files within a cell for deterministic output', () => {
    writeRealFile('libs/zzz.ts');
    writeRealFile('libs/aaa.ts');
    writeRealFile('libs/mmm.ts');

    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['libs/zzz.ts', 'libs/aaa.ts', 'libs/mmm.ts'] },
      { issueId: '02', files: ['libs/aaa.ts', 'libs/zzz.ts', 'libs/mmm.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells[0].files).toEqual([
      'libs/aaa.ts',
      'libs/mmm.ts',
      'libs/zzz.ts',
    ]);
  });
});

// ─── Regression: cross-slug same-NN no false positive ───────────────────────

describe('computeConflictMap — regression: cross-slug same NN, disjoint files', () => {
  it('produces empty cells when NN=01 appears in two different slugs with disjoint file lists', () => {
    // AC #3: two issues at NN=01 across two different slugs, disjoint files.
    // Before the fix, both resolved to issueId="01" and the second's files
    // silently overwrote the first's in the internal map — causing a false
    // collision cell. After the fix they are keyed by slug#NN, so they are
    // independent entries and the intersection is empty.
    const inputs: IssueGlobs[] = [
      {
        issueId: 'claude-automation-gaps#01',
        files: ['libs/features/tasks/add-jobticket/src/lib/component.ts'],
      },
      {
        issueId: 'create-feature-generator#01',
        files: ['tools/generators/src/generators/create-feature/generator.ts'],
      },
    ];

    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.issues).toEqual([
      'claude-automation-gaps#01',
      'create-feature-generator#01',
    ]);
    expect(result.cells).toEqual([]);
  });
});

// ─── extractIssueId unit tests ───────────────────────────────────────────────

describe('extractIssueId — slug-qualified key derivation', () => {
  it('returns <slug>#<NN> for a standard .scratch/<slug>/issues/<NN>-name.md path', () => {
    expect(
      extractIssueId('.scratch/claude-automation-gaps/issues/01-my-issue.md'),
    ).toBe('claude-automation-gaps#01');
  });

  it('handles absolute paths', () => {
    expect(
      extractIssueId(
        '/repo/.scratch/create-feature-generator/issues/02-generator-gaps.md',
      ),
    ).toBe('create-feature-generator#02');
  });

  it('handles Windows-style backslash paths', () => {
    expect(
      extractIssueId(
        'C:\\repo\\.scratch\\wave-orchestration\\issues\\22-conflict-map.md',
      ),
    ).toBe('wave-orchestration#22');
  });

  it('falls back to bare NN for paths not under .scratch/<slug>/issues/', () => {
    // Ad-hoc invocation with a path that doesn't match the canonical structure.
    expect(extractIssueId('/tmp/fixtures/01-some-issue.md')).toBe('01');
    expect(extractIssueId('arbitrary/path/07-thing.md')).toBe('07');
  });

  it('falls back to filename stem when there is no NN prefix', () => {
    expect(extractIssueId('/tmp/my-issue.md')).toBe('my-issue');
  });
});

// ─── loadIssueGlobs — slug-qualified IDs via file paths ──────────────────────

describe('loadIssueGlobs — issue-file convenience loader', () => {
  it('parses N issue files and extracts slug-qualified ID + files-list', () => {
    const path1 = writeIssue(
      'demo',
      '11-foo.md',
      [
        '# 11 — foo',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- libs/x.ts',
        '**Blocked by:** none',
      ].join('\n'),
    );
    const path2 = writeIssue(
      'demo',
      '12-bar.md',
      [
        '# 12 — bar',
        '**Status:** ready-for-agent',
        '**Risk:** isolated-refactor',
        '**Worker:** background-heavy',
        '**Files:**',
        '- libs/x.ts',
        '- libs/y.ts',
        '**Blocked by:** #11',
      ].join('\n'),
    );

    const loaded = loadIssueGlobs([path1, path2]);
    expect(loaded).toEqual([
      { issueId: 'demo#11', files: ['libs/x.ts'] },
      { issueId: 'demo#12', files: ['libs/x.ts', 'libs/y.ts'] },
    ]);
  });

  it('skips files whose Header-Block fails to parse', () => {
    const broken = writeIssue(
      'demo',
      '13-broken.md',
      '# 13 — broken (no header block at all)',
    );
    const good = writeIssue(
      'demo',
      '14-good.md',
      [
        '# 14 — good',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- libs/z.ts',
        '**Blocked by:** none',
      ].join('\n'),
    );

    const loaded = loadIssueGlobs([broken, good]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].issueId).toBe('demo#14');
  });

  it('assigns slug-qualified IDs across two different slugs at the same NN', () => {
    const pathA = writeIssue(
      'claude-automation-gaps',
      '01-first-issue.md',
      [
        '# 01 — first issue',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- libs/features/tasks/add-jobticket/src/lib/component.ts',
        '**Blocked by:** none',
      ].join('\n'),
    );
    const pathB = writeIssue(
      'create-feature-generator',
      '01-generator-gaps.md',
      [
        '# 01 — generator gaps',
        '**Status:** ready-for-agent',
        '**Risk:** mechanical',
        '**Worker:** background',
        '**Files:**',
        '- tools/generators/src/generators/create-feature/generator.ts',
        '**Blocked by:** none',
      ].join('\n'),
    );

    const loaded = loadIssueGlobs([pathA, pathB]);
    expect(loaded[0].issueId).toBe('claude-automation-gaps#01');
    expect(loaded[1].issueId).toBe('create-feature-generator#01');
    // They must be distinct keys — if still bare NN, both would be '01'.
    expect(loaded[0].issueId).not.toBe(loaded[1].issueId);
  });
});

describe('computeConflictMap — duplicate issueId guard', () => {
  it('skips the degenerate self-cell instead of emitting {a:id, b:id}', () => {
    // a duplicate id must never produce an a===b cell (the a<b invariant)
    const inputs: IssueGlobs[] = [
      { issueId: 'X', files: ['src/dup.ts'] },
      { issueId: 'X', files: ['src/dup.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toEqual([]);
    expect(result.cells.every((c) => c.a !== c.b)).toBe(true);
  });
});

// ─── FOR-38: fail loud / warn on glob patterns without a repoRoot ───────────

describe('computeConflictMap — FOR-38: no repoRoot supplied', () => {
  it('does not throw when repoRoot is omitted entirely', () => {
    expect(() =>
      computeConflictMap(
        [{ issueId: '01', files: ['src/*.ts'] }],
        {},
      ),
    ).not.toThrow();
  });

  it('produces a cell for two issues declaring the byte-identical glob pattern, with no repoRoot', () => {
    const inputs: IssueGlobs[] = [
      { issueId: 'FOR-6', files: ['.claude/skills/wave-shared/**'] },
      { issueId: 'FOR-33', files: ['.claude/skills/wave-shared/**'] },
    ];
    // No `repoRoot` passed at all — the exact live-finding shape.
    const result = computeConflictMap(inputs, {});
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].a).toBe('FOR-33');
    expect(result.cells[0].b).toBe('FOR-6');
    // Not silently dropped: never never an empty cells array here.
    expect(result.cells[0].files.length).toBeGreaterThan(0);
  });

  it('never silently drops a glob entry into an empty conflict set — it always surfaces a warning naming it', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['tools/wave/src/**/*.ts'] },
      { issueId: '02', files: ['libs/other/**/*.ts'] },
    ];
    const result = computeConflictMap(inputs, {});
    expect(result.warnings).toBeDefined();
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('01'),
        expect.stringContaining('tools/wave/src/**/*.ts'),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('02'),
        expect.stringContaining('libs/other/**/*.ts'),
      ]),
    );
  });

  it('does NOT warn about concrete (non-glob) Files entries — only globs are affected', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['src/literal-a.ts'] },
      { issueId: '02', files: ['src/literal-b.ts'] },
    ];
    const result = computeConflictMap(inputs, {});
    expect(result.warnings).toBeUndefined();
  });

  it('still detects concrete-path overlaps with no repoRoot (unaffected by the glob fallback)', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['src/shared.ts'] },
      { issueId: '02', files: ['src/shared.ts'] },
    ];
    const result = computeConflictMap(inputs, {});
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].files).toEqual(['src/shared.ts']);
    expect(result.warnings).toBeUndefined();
  });

  it('two DIFFERENT unexpanded glob patterns do not spuriously collide (exact-text match only)', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['src/a/**'] },
      { issueId: '02', files: ['src/b/**'] },
    ];
    const result = computeConflictMap(inputs, {});
    expect(result.cells).toEqual([]);
    expect(result.warnings).toHaveLength(2);
  });

  it('omits the warnings key entirely (no empty array) when repoRoot IS supplied — regression', () => {
    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['libs/a.ts'] },
      { issueId: '02', files: ['libs/b.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.warnings).toBeUndefined();
  });

  it('regression: WITH repoRoot, cell counts are unchanged from the pre-fix behaviour (real glob expansion, not exact-text)', () => {
    writeRealFile('libs/for38/a/src/lib/strings.ts');
    writeRealFile('libs/for38/b/src/lib/strings.ts');

    const inputs: IssueGlobs[] = [
      { issueId: '01', files: ['libs/for38/*/src/lib/strings.ts'] },
      { issueId: '02', files: ['libs/for38/*/src/lib/strings.ts'] },
    ];
    const result = computeConflictMap(inputs, { repoRoot: root });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].files).toEqual([
      'libs/for38/a/src/lib/strings.ts',
      'libs/for38/b/src/lib/strings.ts',
    ]);
    expect(result.warnings).toBeUndefined();
  });
});
