import { describe, it, expect } from 'vitest';
import { crossWaveCheck } from './cross-wave';

const ROOT = '/repo'; // concrete paths are compared as-is; no fs needed

describe('crossWaveCheck — can this wave run alongside the running ones?', () => {
  it('parallel-safe when the candidate scope is disjoint from all claimed scopes', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/x.ts'] }],
      claimed: [{ id: 'c', files: ['src/y.ts'] }],
      repoRoot: ROOT,
    });
    expect(r.parallelSafe).toBe(true);
    expect(r.crossWaveConflicts).toEqual([]);
  });

  it('flags a cross-wave conflict when a candidate overlaps a claimed issue', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/x.ts', 'src/shared.ts'] }],
      claimed: [{ id: 'c', files: ['src/shared.ts'] }],
      repoRoot: ROOT,
    });
    expect(r.parallelSafe).toBe(false);
    expect(r.crossWaveConflicts).toHaveLength(1);
    expect(r.crossWaveConflicts[0].files).toEqual(['src/shared.ts']);
    expect([r.crossWaveConflicts[0].a, r.crossWaveConflicts[0].b].sort()).toEqual(['a', 'c']);
  });

  it('separates intra-wave (candidate↔candidate) from cross-wave conflicts', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'a', files: ['src/barrel.ts'] },
        { id: 'b', files: ['src/barrel.ts'] },
      ],
      claimed: [{ id: 'c', files: ['src/other.ts'] }],
      repoRoot: ROOT,
    });
    expect(r.parallelSafe).toBe(true); // no candidate↔claimed overlap
    expect(r.intraWaveConflicts).toHaveLength(1);
    expect(r.intraWaveConflicts[0].files).toEqual(['src/barrel.ts']);
  });

  it('ignores claimed↔claimed overlaps (already running, not ours to gate)', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/x.ts'] }],
      claimed: [
        { id: 'c', files: ['src/dup.ts'] },
        { id: 'd', files: ['src/dup.ts'] },
      ],
      repoRoot: ROOT,
    });
    expect(r.parallelSafe).toBe(true);
    expect(r.crossWaveConflicts).toEqual([]);
    expect(r.intraWaveConflicts).toEqual([]);
  });

  it('handles an empty claimed set (first wave) as trivially parallel-safe', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'a', files: ['src/x.ts'] },
        { id: 'b', files: ['src/y.ts'] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.parallelSafe).toBe(true);
    expect(r.intraWaveConflicts).toEqual([]);
  });

  it('deduplicates intraWaveConflicts to one canonical cell per pair when candidates == claimed (own-wave soft-claim)', () => {
    // Regression for the live-gate finding: own wave rows are soft-claimed at
    // wave-create, so `candidates` and `claimed` routinely carry the same
    // issues. Feeding the union in as a naive concatenation (pre-fix)
    // produced up to 4 duplicate cells per overlapping pair.
    const shared = [
      { id: 'b', files: ['src/one.ts'] },
      { id: 'a', files: ['src/one.ts', 'src/two.ts'] },
      { id: 'c', files: ['src/two.ts'] },
    ];
    const r = crossWaveCheck({
      candidates: shared,
      claimed: shared, // candidates == claimed
      repoRoot: ROOT,
    });

    // Two overlapping pairs: (a,b) via src/one.ts, (a,c) via src/two.ts.
    expect(r.intraWaveConflicts).toHaveLength(2);
    const pairs = r.intraWaveConflicts.map((c) => [c.a, c.b]);
    // Canonical order a < b on every cell.
    for (const [a, b] of pairs) {
      expect(a < b).toBe(true);
    }
    // Each unordered pair appears exactly once.
    const seen = new Set(pairs.map((p) => p.join('|')));
    expect(seen.size).toBe(pairs.length);
    expect(pairs.sort()).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);

    // candidates == claimed alone (no third-party claim) means nothing here
    // is a genuine cross-wave conflict.
    expect(r.crossWaveConflicts).toEqual([]);
    expect(r.parallelSafe).toBe(true);
  });

  it('deduplicates crossWaveConflicts to one canonical cell when a soft-claimed candidate also overlaps a genuinely external claim', () => {
    // Regression: issue "b" is both a candidate AND already claimed (own-wave
    // soft-claim), while issue "c" is a different wave's claim that overlaps
    // b's files. Pre-fix this produced 2 duplicate crossWaveConflicts cells
    // for the single (b,c) pair (one per copy of "b" in the concatenated input).
    const r = crossWaveCheck({
      candidates: [{ id: 'b', files: ['src/shared.ts'] }],
      claimed: [
        { id: 'b', files: ['src/shared.ts'] },
        { id: 'c', files: ['src/shared.ts'] },
      ],
      repoRoot: ROOT,
    });

    expect(r.crossWaveConflicts).toHaveLength(1);
    expect(r.crossWaveConflicts[0]).toEqual({ a: 'b', b: 'c', files: ['src/shared.ts'] });
    expect(r.parallelSafe).toBe(false);
    expect(r.intraWaveConflicts).toEqual([]);
  });
});

describe('crossWaveCheck — intraWaveBlockedByPairs (FOR-8: intra-wave blocked-by membership)', () => {
  it('returns an empty array when no candidate declares a blockedBy', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'] },
        { id: '6', files: ['src/b.ts'] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([]);
  });

  it('detects an intra-wave pair via a bare-number ref matching a roster id directly (GitHub-style)', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'], blockedBy: 'none' },
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([{ blocked: '6', blocker: '5', resolved: false }]);
  });

  it('ignores a blockedBy ref that resolves outside the roster', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'] },
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 99 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([]);
  });

  it('resolves an explicit-slug ref against a roster id of the form <slug>-<issue> (Linear-style)', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'FOR-5', files: ['src/a.ts'] },
        { id: 'FOR-8', files: ['src/b.ts'], blockedBy: [{ slug: 'FOR', issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([
      { blocked: 'FOR-8', blocker: 'FOR-5', resolved: false },
    ]);
  });

  it('resolves a slug-less ref against the referencing issue’s own slug (same-team shorthand)', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'FOR-5', files: ['src/a.ts'] },
        { id: 'FOR-8', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([
      { blocked: 'FOR-8', blocker: 'FOR-5', resolved: false },
    ]);
  });

  it('resolves against a `<slug>#<nn>` roster id, including its zero-padded numeric tail (MarkdownFsStore convention — a different joiner AND padding than Linear)', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'wave-orchestration#05', files: ['src/a.ts'] }, // zero-padded NN — nextNN()'s convention
        {
          id: 'wave-orchestration#08',
          files: ['src/b.ts'],
          blockedBy: [{ issue: 5 }], // slug-less shorthand, un-padded ref.issue number
        },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([
      { blocked: 'wave-orchestration#08', blocker: 'wave-orchestration#05', resolved: false },
    ]);
  });

  it('does not throw on an id whose tail is not numeric — simply excludes it from matching', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'not-a-wave-issue-id', files: ['src/a.ts'] },
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([]);
  });

  it('resolves an explicit cross-slug ref (MarkdownFsStore) using the referencing id’s own `#` joiner', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: 'billing#05', files: ['src/a.ts'] },
        {
          id: 'checkout#08',
          files: ['src/b.ts'],
          blockedBy: [{ slug: 'billing', issue: 5 }],
        },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([
      { blocked: 'checkout#08', blocker: 'billing#05', resolved: false },
    ]);
  });

  it('marks a pair resolved when the blocker has reached in-review', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'], status: 'in-review' },
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([{ blocked: '6', blocker: '5', resolved: true }]);
  });

  it('marks a pair resolved when the blocker has reached done', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'], status: 'done' },
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([{ blocked: '6', blocker: '5', resolved: true }]);
  });

  it('marks a pair unresolved when the blocker status is anything short of in-review/done', () => {
    for (const status of ['available', 'queued', 'in-flight', 'needs-attention'] as const) {
      const r = crossWaveCheck({
        candidates: [
          { id: '5', files: ['src/a.ts'], status },
          { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
        ],
        claimed: [],
        repoRoot: ROOT,
      });
      expect(r.intraWaveBlockedByPairs).toEqual([{ blocked: '6', blocker: '5', resolved: false }]);
    }
  });

  it('treats a missing status on the blocker as unresolved (safe default)', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'] }, // no status field at all
        { id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([{ blocked: '6', blocker: '5', resolved: false }]);
  });

  it('excludes a self-referencing blockedBy ref (defensive — malformed data)', () => {
    const r = crossWaveCheck({
      candidates: [{ id: '5', files: ['src/a.ts'], blockedBy: [{ issue: 5 }] }],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([]);
  });

  it('reports one pair per blocker when an issue has multiple intra-wave blockers, independently resolved', () => {
    const r = crossWaveCheck({
      candidates: [
        { id: '5', files: ['src/a.ts'], status: 'done' },
        { id: '6', files: ['src/b.ts'], status: 'queued' },
        { id: '7', files: ['src/c.ts'], blockedBy: [{ issue: 5 }, { issue: 6 }] },
      ],
      claimed: [],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toHaveLength(2);
    expect(r.intraWaveBlockedByPairs).toEqual(
      expect.arrayContaining([
        { blocked: '7', blocker: '5', resolved: true },
        { blocked: '7', blocker: '6', resolved: false },
      ]),
    );
  });

  it('is scoped to the candidates array — a blockedBy ref resolving only inside `claimed` is not intra-wave', () => {
    const r = crossWaveCheck({
      candidates: [{ id: '6', files: ['src/b.ts'], blockedBy: [{ issue: 5 }] }],
      claimed: [{ id: '5', files: ['src/a.ts'], status: 'done' }],
      repoRoot: ROOT,
    });
    expect(r.intraWaveBlockedByPairs).toEqual([]);
  });
});

describe('crossWaveCheck — FOR-38: no repoRoot supplied (fail loud / warn, never a silently smaller conflict set)', () => {
  it('does not throw when repoRoot is entirely omitted', () => {
    expect(() =>
      crossWaveCheck({
        candidates: [{ id: 'a', files: ['src/*.ts'] }],
        claimed: [],
      }),
    ).not.toThrow();
  });

  it('flags a cross-wave conflict for two byte-identical glob patterns even with no repoRoot', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'FOR-6', files: ['.claude/skills/wave-shared/**'] }],
      claimed: [{ id: 'FOR-33', files: ['.claude/skills/wave-shared/**'] }],
      // no repoRoot — the exact live-finding shape
    });
    expect(r.parallelSafe).toBe(false);
    expect(r.crossWaveConflicts).toHaveLength(1);
    expect([r.crossWaveConflicts[0].a, r.crossWaveConflicts[0].b].sort()).toEqual([
      'FOR-33',
      'FOR-6',
    ]);
  });

  it('surfaces warnings naming every unexpanded glob pattern, never a silently smaller conflict set', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/**/*.ts'] }],
      claimed: [{ id: 'c', files: ['other/**/*.ts'] }],
    });
    expect(r.warnings).toBeDefined();
    expect(r.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('src/**/*.ts')]),
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('other/**/*.ts')]),
    );
  });

  it('omits warnings entirely for concrete-path-only inputs, with or without repoRoot', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/x.ts'] }],
      claimed: [{ id: 'c', files: ['src/y.ts'] }],
    });
    expect(r.warnings).toBeUndefined();
  });

  it('regression: warnings is absent when a real repoRoot is supplied, and results are otherwise unchanged', () => {
    const r = crossWaveCheck({
      candidates: [{ id: 'a', files: ['src/x.ts', 'src/shared.ts'] }],
      claimed: [{ id: 'c', files: ['src/shared.ts'] }],
      repoRoot: ROOT,
    });
    expect(r.warnings).toBeUndefined();
    expect(r.parallelSafe).toBe(false);
    expect(r.crossWaveConflicts[0].files).toEqual(['src/shared.ts']);
  });
});
