/**
 * merge-order.spec.ts — fixtures for computeMergeOrder (wave-orchestration #44).
 *
 * The git side-effect (`merge-base --is-ancestor`, `ls-remote`, `fetch`) is
 * isolated behind the injectable `GitProbe` seam, so every test here is fully
 * hermetic — NO real `wave-orch/*` branches need to exist. Each test injects a
 * `fakeProbe(...)` that returns canned branch names + ancestry edges (mirrors
 * the `changedFiles`-injection pattern in files-drift.spec.ts).
 *
 * Issue files are written to a throwaway $TMPDIR tree (same pattern as
 * conflict-map.spec.ts) so the `Files:` header is parsed end-to-end for the
 * fileCount sort key.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  computeMergeOrder,
  computeMergeOrderFromSpine,
  parseWaveSpine,
  type GitProbe,
  type PR,
} from './merge-order';
import type { ConflictMap, ConflictCell } from './conflict-map';
import {
  renderSpine,
  setRowState,
  setRowPrCell,
  upsertDispatchLogEntry,
  type SpineMeta,
  type SpineRosterRow,
} from './wave-md-rw';

// ─── Temp-dir issue authoring ────────────────────────────────────────────────

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'wave-merge-order-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Write an issue file under `.scratch/<slug>/issues/<NN>-name.md` with a valid
 * Header-Block whose `Files:` list has exactly `fileCount` entries. Returns the
 * absolute path. The concrete file paths don't need to exist — fileCount is a
 * pure list-length read.
 */
function writeIssue(
  slug: string,
  nn: number,
  title: string,
  fileCount: number,
): string {
  const dir = join(root, '.scratch', slug, 'issues');
  mkdirSync(dir, { recursive: true });
  const files = Array.from(
    { length: fileCount },
    (_, i) => `- libs/${slug}/file-${nn}-${i}.ts`,
  );
  const body = [
    `# ${nn} — ${title}`,
    '',
    '**Status:** ready-for-agent',
    '**Risk:** mechanical',
    '**Worker:** background',
    '**Files:**',
    ...files,
    '**Blocked by:** none',
    '',
    '## What to build',
    '',
    'A thing.',
  ].join('\n');
  const path = join(
    dir,
    `${String(nn).padStart(2, '0')}-${title.replace(/\s+/g, '-')}.md`,
  );
  writeFileSync(path, body, 'utf-8');
  return path;
}

// ─── Conflict-Map + GitProbe fixture builders ────────────────────────────────

function conflictMap(
  issues: string[],
  cells: ConflictCell[] = [],
): ConflictMap {
  return { issues, cells };
}

/**
 * Build a hermetic GitProbe.
 *
 * @param branches   issueId → branch name (omit an id to simulate an
 *                   unresolved branch → it never participates in a stack).
 * @param stackEdges list of `[ancestorBranch, descendantBranch]` DIRECT pairs.
 *                   The probe derives the full ancestry closure so transitive
 *                   `--is-ancestor` queries (29→34 through 32) also return true,
 *                   exactly as real git would.
 */
function fakeProbe(
  branches: Record<string, string>,
  stackEdges: Array<[string, string]> = [],
): GitProbe {
  // Build ancestor-closure: descendant → Set(ancestor branches).
  const directChildren = new Map<string, Set<string>>();
  for (const [anc, desc] of stackEdges) {
    const set = directChildren.get(anc) ?? new Set<string>();
    set.add(desc);
    directChildren.set(anc, set);
  }
  // For each branch, compute all reachable descendants (so ancestor->desc is
  // true transitively).
  const descendantsOf = new Map<string, Set<string>>();
  const allBranches = new Set<string>([
    ...Object.values(branches),
    ...stackEdges.flat(),
  ]);
  for (const b of allBranches) {
    const seen = new Set<string>();
    const queue = [...(directChildren.get(b) ?? [])];
    let next = queue.shift();
    while (next !== undefined) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(...(directChildren.get(next) ?? []));
      }
      next = queue.shift();
    }
    descendantsOf.set(b, seen);
  }

  return {
    resolveBranch(_nn: number, issueId: string): string | null {
      return branches[issueId] ?? null;
    },
    isAncestor(ancestor: string, descendant: string): boolean {
      return descendantsOf.get(ancestor)?.has(descendant) ?? false;
    },
  };
}

/**
 * Build an `isAncestor`-only ancestry closure over an explicit list of stack
 * edges (mirrors {@link fakeProbe}'s closure builder, factored out so a probe
 * whose `resolveBranch` is overridden separately can still answer ancestry for
 * ALL participating branches — stale glob results included).
 */
function ancestryClosure(
  stackEdges: Array<[string, string]>,
): (ancestor: string, descendant: string) => boolean {
  const directChildren = new Map<string, Set<string>>();
  for (const [anc, desc] of stackEdges) {
    const set = directChildren.get(anc) ?? new Set<string>();
    set.add(desc);
    directChildren.set(anc, set);
  }
  const descendantsOf = new Map<string, Set<string>>();
  const allBranches = new Set<string>(stackEdges.flat());
  for (const b of allBranches) {
    const seen = new Set<string>();
    const queue = [...(directChildren.get(b) ?? [])];
    let next = queue.shift();
    while (next !== undefined) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(...(directChildren.get(next) ?? []));
      }
      next = queue.shift();
    }
    descendantsOf.set(b, seen);
  }
  return (ancestor, descendant) =>
    descendantsOf.get(ancestor)?.has(descendant) ?? false;
}

/**
 * A GitProbe that models the Wave 2026-06-03 §L3 defect: the NN-glob
 * `resolveBranch` mis-resolves to a STALE prior-wave branch (or `null`) that is
 * NOT part of the current wave's stack. `globBranches` is what the glob returns
 * per issueId; `stackEdges` is the REAL ancestry (over the correct, exact
 * branches). If the exact branches are not fed in via `branchesByIssueId`, the
 * glob's stale branches drive detection and the stack is missed — the bug.
 */
function fakeProbeWithGlobCollision(
  globBranches: Record<string, string | null>,
  stackEdges: Array<[string, string]>,
): GitProbe {
  const isAncestor = ancestryClosure(stackEdges);
  return {
    resolveBranch(_nn: number, issueId: string): string | null {
      return globBranches[issueId] ?? null;
    },
    isAncestor,
  };
}

const ids = (prs: PR[]): string[] => prs.map((p) => p.issueId);

/** Assert the override is present and return it (avoids non-null assertions). */
function expectOverride(override: PR[] | null): PR[] {
  expect(override).not.toBeNull();
  if (override === null) throw new Error('expected an override, got null');
  return override;
}

// ─── AC case 1: all-disjoint (Wave 9 shape) — no override ────────────────────

describe('computeMergeOrder — AC case 1: all-disjoint wave (Wave 9 shape)', () => {
  it('returns algorithmic order as-is and override = null when no branch is stacked', () => {
    // Wave 9: 6 pairwise-disjoint singletons. Vary fileCounts to exercise the
    // sort; one Conflict-Map cell (bct/03 ↔ wo/36 on CLAUDE.md) is non-empty but
    // the branches are NOT stacked → still no override.
    const p1 = writeIssue('claude-automation-gaps', 2, 'hook', 2);
    const p2 = writeIssue('browser-component-tests', 3, 'runner', 5);
    const p3 = writeIssue('claude-automation-gaps', 3, 'slug-skill', 1);
    const p4 = writeIssue('claude-automation-gaps', 4, 'auditor', 1);
    const p5 = writeIssue('wave-orchestration', 35, 'cli-enoent', 2);
    const p6 = writeIssue('wave-orchestration', 36, 'nx-ignore', 3);

    const cm = conflictMap(
      [
        'claude-automation-gaps#02',
        'browser-component-tests#03',
        'claude-automation-gaps#03',
        'claude-automation-gaps#04',
        'wave-orchestration#35',
        'wave-orchestration#36',
      ],
      [
        {
          a: 'browser-component-tests#03',
          b: 'wave-orchestration#36',
          files: ['CLAUDE.md'],
        },
      ],
    );

    // All branches resolved, NO stack edges.
    const probe = fakeProbe({
      'claude-automation-gaps#02': 'wave-orch/2-hook',
      'browser-component-tests#03': 'wave-orch/3-runner',
      'claude-automation-gaps#03': 'wave-orch/3-slug',
      'claude-automation-gaps#04': 'wave-orch/4-auditor',
      'wave-orchestration#35': 'wave-orch/35-cli',
      'wave-orchestration#36': 'wave-orch/36-nx',
    });

    const result = computeMergeOrder([p1, p2, p3, p4, p5, p6], cm, {
      repoRoot: root,
      git: probe,
    });

    expect(result.override).toBeNull();
    // fewer-files-first, NN ASC tiebreak:
    // 1f: cag#03(nn3), cag#04(nn4) → cag#03, cag#04
    // 2f: cag#02(nn2), wo#35(nn35)  → cag#02, wo#35
    // 3f: wo#36(nn36)
    // 5f: bct#03(nn3)
    expect(ids(result.algorithmic)).toEqual([
      'claude-automation-gaps#03',
      'claude-automation-gaps#04',
      'claude-automation-gaps#02',
      'wave-orchestration#35',
      'wave-orchestration#36',
      'browser-component-tests#03',
    ]);
    expect(result.reason).toMatch(/no stacked branches/i);
  });

  it('mentions the Conflict-Map overlap in the reason when a cell is non-empty but disjoint', () => {
    const p1 = writeIssue('s1', 10, 'a', 1);
    const p2 = writeIssue('s1', 11, 'b', 1);
    const cm = conflictMap(
      ['s1#10', 's1#11'],
      [{ a: 's1#10', b: 's1#11', files: ['libs/shared.ts'] }],
    );
    const probe = fakeProbe({
      's1#10': 'wave-orch/10-a',
      's1#11': 'wave-orch/11-b',
    });
    const result = computeMergeOrder([p1, p2], cm, {
      repoRoot: root,
      git: probe,
    });
    expect(result.override).toBeNull();
    expect(result.reason).toMatch(/libs\/shared\.ts/);
  });
});

// ─── AC case 2: Wave 10 Row A (3-deep stack + 4 disjoint) ────────────────────

describe('computeMergeOrder — AC case 2: Wave 10 Row A (3-deep stack + 4 disjoint)', () => {
  // Wave 10 file counts (from the spine PR roster):
  //   wo/29 = 3, wo/32 = 1, wo/34 = 2, wo/39 = 1, wo/41 = 3, wo/42 = 2, smdx/03 = 15
  // Stack: wave-orch/29  ◁  wave-orch/32  ◁  wave-orch/34 (29 is the base).
  const slug = 'wave-orchestration';

  function buildWave10(): {
    paths: string[];
    cm: ConflictMap;
    probe: GitProbe;
  } {
    const paths = [
      writeIssue(slug, 29, 'l11-rewrite', 3),
      writeIssue(slug, 32, 'grep-gate', 1),
      writeIssue(slug, 34, 'bb-two-commit', 2),
      writeIssue(slug, 39, 'plan-time-glob', 1),
      writeIssue(slug, 41, 'files-drift', 3),
      writeIssue(slug, 42, 'nightly', 2),
      writeIssue('storybook-mdx-hygiene', 3, 'gap-sweep', 15),
    ];
    const cm = conflictMap(
      [
        `${slug}#29`,
        `${slug}#32`,
        `${slug}#34`,
        `${slug}#39`,
        `${slug}#41`,
        `${slug}#42`,
        'storybook-mdx-hygiene#03',
      ],
      [
        {
          a: `${slug}#29`,
          b: `${slug}#32`,
          files: ['worker-brief-template.md'],
        },
        {
          a: `${slug}#29`,
          b: `${slug}#34`,
          files: ['pr-create-template.md', 'worker-brief-template.md'],
        },
        {
          a: `${slug}#32`,
          b: `${slug}#34`,
          files: ['worker-brief-template.md'],
        },
      ],
    );
    const probe = fakeProbe(
      {
        [`${slug}#29`]: 'wave-orch/29-l11-rewrite',
        [`${slug}#32`]: 'wave-orch/32-grep-gate',
        [`${slug}#34`]: 'wave-orch/34-bb-two-commit',
        [`${slug}#39`]: 'wave-orch/39-plan-time-glob',
        [`${slug}#41`]: 'wave-orch/41-files-drift',
        [`${slug}#42`]: 'wave-orch/42-nightly',
        'storybook-mdx-hygiene#03': 'wave-orch/smdx-03-gap-sweep',
      },
      [
        ['wave-orch/29-l11-rewrite', 'wave-orch/32-grep-gate'],
        ['wave-orch/32-grep-gate', 'wave-orch/34-bb-two-commit'],
      ],
    );
    return { paths, cm, probe };
  }

  it('emits the algorithmic order = fewer-files-first, NN ASC (matches the spine)', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    // 1f: wo/32(32), wo/39(39); 2f: wo/34(34), wo/42(42); 3f: wo/29(29), wo/41(41); 15f: smdx/03(3)
    expect(ids(result.algorithmic)).toEqual([
      `${slug}#32`,
      `${slug}#39`,
      `${slug}#34`,
      `${slug}#42`,
      `${slug}#29`,
      `${slug}#41`,
      'storybook-mdx-hygiene#03',
    ]);
  });

  it('emits an override (stack is present)', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    expect(result.override).not.toBeNull();
  });

  it('override puts the stacked subgraph in topological build-order (wo/29 → wo/32 → wo/34)', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    const order = ids(expectOverride(result.override));
    // Stack first, in build order:
    expect(order.slice(0, 3)).toEqual([
      `${slug}#29`,
      `${slug}#32`,
      `${slug}#34`,
    ]);
  });

  it('override interleaves the 4 disjoint nodes fewer-files-first after the stack', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    const order = ids(expectOverride(result.override));
    // Disjoint by fewer-files-first: wo/39(1f), wo/42(2f), wo/41(3f), smdx/03(15f)
    expect(order.slice(3)).toEqual([
      `${slug}#39`,
      `${slug}#42`,
      `${slug}#41`,
      'storybook-mdx-hygiene#03',
    ]);
  });

  it('full override order matches Wave 10 §Closed-by final recommendation', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    expect(ids(expectOverride(result.override))).toEqual([
      `${slug}#29`, // PR #26 — stack base
      `${slug}#32`, // PR #28 — stacked
      `${slug}#34`, // PR #29 — stacked
      `${slug}#39`, // PR #25 — disjoint
      `${slug}#42`, // PR #24 — disjoint
      `${slug}#41`, // PR #30 — disjoint
      'storybook-mdx-hygiene#03', // PR #27 — disjoint
    ]);
  });

  it('reason names the stacked chain and the stacked-build rationale', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    expect(result.reason).toMatch(/stacked/i);
    expect(result.reason).toMatch(/wave-orch\/29-l11-rewrite/);
    expect(result.reason).toMatch(/wave-orch\/32-grep-gate/);
    expect(result.reason).toMatch(/wave-orch\/34-bb-two-commit/);
  });

  it('preserves all 7 PRs in both orders (no drops)', () => {
    const { paths, cm, probe } = buildWave10();
    const result = computeMergeOrder(paths, cm, { repoRoot: root, git: probe });
    expect(result.algorithmic).toHaveLength(7);
    expect(result.override).toHaveLength(7);
    expect(new Set(ids(expectOverride(result.override)))).toEqual(
      new Set(ids(result.algorithmic)),
    );
  });
});

// ─── AC case 3: 2-deep stack only ────────────────────────────────────────────

describe('computeMergeOrder — AC case 3: 2-deep stack only', () => {
  it('orders the two stacked nodes parent-first even when the parent has MORE files', () => {
    // The parent (#50, 3 files) would sort AFTER the child (#51, 1 file) in the
    // algorithmic order — the override must still put the parent first because
    // the child is built on its tip.
    const slug = 'demo-stack';
    const pParent = writeIssue(slug, 50, 'base', 3);
    const pChild = writeIssue(slug, 51, 'tip', 1);
    const cm = conflictMap([`${slug}#50`, `${slug}#51`]);
    const probe = fakeProbe(
      {
        [`${slug}#50`]: 'wave-orch/50-base',
        [`${slug}#51`]: 'wave-orch/51-tip',
      },
      [['wave-orch/50-base', 'wave-orch/51-tip']],
    );
    const result = computeMergeOrder([pParent, pChild], cm, {
      repoRoot: root,
      git: probe,
    });

    // Algorithmic: child first (1f < 3f).
    expect(ids(result.algorithmic)).toEqual([`${slug}#51`, `${slug}#50`]);
    // Override: parent (base) first.
    expect(result.override).not.toBeNull();
    expect(ids(expectOverride(result.override))).toEqual([
      `${slug}#50`,
      `${slug}#51`,
    ]);
  });

  it('no override when the two branches are NOT stacked', () => {
    const slug = 'demo-flat';
    const p1 = writeIssue(slug, 60, 'a', 1);
    const p2 = writeIssue(slug, 61, 'b', 2);
    const cm = conflictMap([`${slug}#60`, `${slug}#61`]);
    const probe = fakeProbe({
      [`${slug}#60`]: 'wave-orch/60-a',
      [`${slug}#61`]: 'wave-orch/61-b',
    });
    const result = computeMergeOrder([p1, p2], cm, {
      repoRoot: root,
      git: probe,
    });
    expect(result.override).toBeNull();
    expect(ids(result.algorithmic)).toEqual([`${slug}#60`, `${slug}#61`]);
  });
});

// ─── AC case 4: empty wave ───────────────────────────────────────────────────

describe('computeMergeOrder — AC case 4: empty wave', () => {
  it('returns a clean empty result for 0 issues', () => {
    const result = computeMergeOrder([], conflictMap([]), {
      repoRoot: root,
      git: fakeProbe({}),
    });
    expect(result.algorithmic).toEqual([]);
    expect(result.override).toBeNull();
    expect(result.reason).toMatch(/empty/i);
  });

  it('returns a single-issue result with no override', () => {
    const p = writeIssue('solo', 1, 'only', 2);
    const result = computeMergeOrder([p], conflictMap(['solo#1']), {
      repoRoot: root,
      git: fakeProbe({ 'solo#1': 'wave-orch/1-only' }),
    });
    expect(result.algorithmic).toHaveLength(1);
    expect(result.override).toBeNull();
    expect(result.reason).toMatch(/single issue/i);
  });
});

// ─── Edge: unresolved branches never join a stack ────────────────────────────

describe('computeMergeOrder — unresolved branches', () => {
  it('skips override when the stacked branches cannot be resolved (probe returns null)', () => {
    const slug = 'no-branch';
    const p1 = writeIssue(slug, 70, 'a', 1);
    const p2 = writeIssue(slug, 71, 'b', 2);
    const cm = conflictMap([`${slug}#70`, `${slug}#71`]);
    // No branches resolved → isAncestor never sees a real branch → no stack.
    const probe = fakeProbe({});
    const result = computeMergeOrder([p1, p2], cm, {
      repoRoot: root,
      git: probe,
    });
    expect(result.override).toBeNull();
    expect(ids(result.algorithmic)).toEqual([`${slug}#70`, `${slug}#71`]);
  });
});

// ─── Edge: unparseable issue files are skipped ───────────────────────────────

describe('computeMergeOrder — header-parse failures', () => {
  it('skips issues whose Header-Block fails to parse', () => {
    const good = writeIssue('mix', 80, 'good', 1);
    const dir = join(root, '.scratch', 'mix', 'issues');
    mkdirSync(dir, { recursive: true });
    const broken = join(dir, '81-broken.md');
    writeFileSync(broken, '# 81 — broken (no header block)', 'utf-8');

    const cm = conflictMap(['mix#80']);
    const probe = fakeProbe({ 'mix#80': 'wave-orch/80-good' });
    const result = computeMergeOrder([good, broken], cm, {
      repoRoot: root,
      git: probe,
    });
    expect(ids(result.algorithmic)).toEqual(['mix#80']);
    expect(result.override).toBeNull();
  });
});

// ─── AC2 (#58): frozen Wave 2026-06-03 §L3 regression ────────────────────────
//
// The empirical defect: a stacked pair #14 ◁ #09 PLUS same-NN stale prior-wave
// branches on origin (`wave-orch/09-composite-required-roles`, …) made the
// NN-glob `resolveBranch` mis-resolve #09 to the stale branch (which is NOT
// stacked on #14). Stacked detection silently failed and the algorithmic order
// placed #09 BEFORE #14 (NN-ASC at equal file count). The Coordinator overrode
// by hand. The fix sources the EXACT branch from the spine and resolves by it,
// so the override emits parent-before-child even with the stale branch present.
describe('computeMergeOrder — AC2 (#58): Wave 2026-06-03 §L3 frozen regression', () => {
  const slug = 'frozen-l3';

  // The real wave: #14 (link-fix, 2 files) is the stack PARENT; #09 (affected-
  // axe, built on #14's tip) is the CHILD. #09 sorts before #14 in the strict
  // algorithmic order (equal-ish file counts, lower NN wins) — the inversion.
  function buildFrozen(): {
    paths: { p14: string; p09: string; p08: string };
    cm: ConflictMap;
    // The EXACT branches as they really were post-close.
    exact: Record<string, string>;
    // The STALE branches the NN-glob returns (the bug source).
    globStale: Record<string, string | null>;
    probe: GitProbe;
  } {
    const p14 = writeIssue(slug, 14, 'fix-broken-doc-links', 2);
    const p09 = writeIssue(slug, 9, 'a11y-affected-axe', 2);
    const p08 = writeIssue(slug, 8, 'adr-0005-eslint', 3);
    const cm = conflictMap([`${slug}#14`, `${slug}#09`, `${slug}#08`]);

    const exact: Record<string, string> = {
      [`${slug}#14`]: 'wave-orch/14-fix-broken-doc-links',
      [`${slug}#09`]: 'wave-orch/09-a11y-affected-axe',
      [`${slug}#08`]: 'wave-orch/08-adr-0005-eslint',
    };

    // The glob hit stale prior-wave branches for the same NNs. Those branches
    // are NOT stacked on #14 — so if they drive detection, the stack is missed.
    const globStale: Record<string, string | null> = {
      [`${slug}#14`]: 'wave-orch/14-fix-broken-doc-links', // #14 had no NN collision
      [`${slug}#09`]: 'wave-orch/09-composite-required-roles', // STALE — wrong branch
      [`${slug}#08`]: 'wave-orch/08-listbox-aria-naming', // STALE — wrong branch
    };

    // REAL ancestry is over the EXACT branches: #14 ◁ #09. The stale branches
    // appear in the closure as isolated (no edges) so probing them = not stacked.
    const probe = fakeProbeWithGlobCollision(globStale, [
      [exact[`${slug}#14`], exact[`${slug}#09`]],
    ]);

    return { paths: { p14, p09, p08 }, cm, exact, globStale, probe };
  }

  it('WITHOUT the fix (glob only) the stack is missed and #09 sorts before #14 (the bug)', () => {
    const { paths, cm, probe } = buildFrozen();
    // No branchesByIssueId → loadPrs falls back to the glob → stale branches →
    // no stack detected → override null → algorithmic inversion (#09 < #14).
    const result = computeMergeOrder([paths.p14, paths.p09, paths.p08], cm, {
      repoRoot: root,
      git: probe,
    });
    expect(result.override).toBeNull();
    // 2f: #09(nn9), #14(nn14); 3f: #08 — algorithmic puts #09 BEFORE #14.
    expect(ids(result.algorithmic)).toEqual([
      `${slug}#09`,
      `${slug}#14`,
      `${slug}#08`,
    ]);
  });

  it('WITH the exact spine branches the override emits parent-before-child (#14 before #09)', () => {
    const { paths, cm, exact, probe } = buildFrozen();
    const result = computeMergeOrder([paths.p14, paths.p09, paths.p08], cm, {
      repoRoot: root,
      git: probe,
      branchesByIssueId: exact,
    });
    // The exact branch wins → #14 ◁ #09 detected → override present.
    const order = ids(expectOverride(result.override));
    // Parent #14 strictly before child #09.
    expect(order.indexOf(`${slug}#14`)).toBeLessThan(
      order.indexOf(`${slug}#09`),
    );
    // Stack subgraph first (in build order), disjoint #08 after.
    expect(order.slice(0, 2)).toEqual([`${slug}#14`, `${slug}#09`]);
    expect(order[2]).toBe(`${slug}#08`);
    // No PRs dropped.
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(ids(result.algorithmic)));
  });

  it('reason names the exact stacked chain (wave-orch/14 → wave-orch/09)', () => {
    const { paths, cm, exact, probe } = buildFrozen();
    const result = computeMergeOrder([paths.p14, paths.p09, paths.p08], cm, {
      repoRoot: root,
      git: probe,
      branchesByIssueId: exact,
    });
    expect(result.reason).toMatch(/stacked/i);
    expect(result.reason).toMatch(/wave-orch\/14-fix-broken-doc-links/);
    expect(result.reason).toMatch(/wave-orch\/09-a11y-affected-axe/);
    // The stale branch names must NOT appear — exact input shadowed the glob.
    expect(result.reason).not.toMatch(/composite-required-roles/);
    expect(result.reason).not.toMatch(/listbox-aria-naming/);
  });
});

// ─── #58 AC3: exact-branch input wins over the NN-glob ────────────────────────

describe('computeMergeOrder — exact-branch input precedence (AC3)', () => {
  it('uses the exact spine branch even when the glob would resolve a different branch', () => {
    const slug = 'precedence';
    const pParent = writeIssue(slug, 50, 'base', 3);
    const pChild = writeIssue(slug, 51, 'tip', 1);
    const cm = conflictMap([`${slug}#50`, `${slug}#51`]);

    // Glob returns NON-stacked stale branches; exact returns the real stacked
    // pair. Only if the exact input wins does the override appear.
    const exact = {
      [`${slug}#50`]: 'wave-orch/50-base',
      [`${slug}#51`]: 'wave-orch/51-tip',
    };
    const probe = fakeProbeWithGlobCollision(
      {
        [`${slug}#50`]: 'wave-orch/50-stale-other-wave',
        [`${slug}#51`]: 'wave-orch/51-stale-other-wave',
      },
      [['wave-orch/50-base', 'wave-orch/51-tip']],
    );

    const result = computeMergeOrder([pParent, pChild], cm, {
      repoRoot: root,
      git: probe,
      branchesByIssueId: exact,
    });
    expect(ids(expectOverride(result.override))).toEqual([
      `${slug}#50`,
      `${slug}#51`,
    ]);
  });

  it('falls back to the NN-glob ONLY for issues the spine declares no branch for', () => {
    const slug = 'partial';
    const pParent = writeIssue(slug, 52, 'base', 3);
    const pChild = writeIssue(slug, 53, 'tip', 1);
    const cm = conflictMap([`${slug}#52`, `${slug}#53`]);

    // Spine declares the PARENT exactly, leaves the CHILD undeclared → child
    // must resolve via the glob. Both glob + exact agree on the real branches,
    // so the stack is still detected end-to-end.
    const exact = { [`${slug}#52`]: 'wave-orch/52-base' };
    const probe = fakeProbeWithGlobCollision(
      {
        [`${slug}#52`]: 'wave-orch/52-base', // glob agrees (unused — exact wins)
        [`${slug}#53`]: 'wave-orch/53-tip', // glob is the ONLY source for child
      },
      [['wave-orch/52-base', 'wave-orch/53-tip']],
    );

    const result = computeMergeOrder([pParent, pChild], cm, {
      repoRoot: root,
      git: probe,
      branchesByIssueId: exact,
    });
    expect(ids(expectOverride(result.override))).toEqual([
      `${slug}#52`,
      `${slug}#53`,
    ]);
  });
});

// ─── #58: parseWaveSpine extracts exact branches from the dispatch-log ────────

describe('parseWaveSpine — exact branch extraction (#54 readSpine bridge)', () => {
  /** A minimal spine carrying a Plan-Table, footnotes, and a dispatch-log. */
  function frozenSpine(): string {
    return [
      '# Wave — frozen-l3 regression',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title          | Worker  | Risk       | Reviewer     | PR  | State      | Iter | Reports → Verdicts |',
      '| --- | -------------- | ------- | ---------- | ------------ | --- | ---------- | ---- | ------------------ |',
      '| 14  | link-fix[^source-14] | opus | mechanical | quick-verify | — | dispatched | 1 | — |',
      '| 09  | affected-axe[^source-09] | sonnet | mechanical | quick-verify | — | dispatched | 1 | — |',
      '',
      '[^source-14]: Source: [`14`](../../.scratch/wave-orchestration/issues/14-fix-broken-doc-links.md)',
      '[^source-09]: Source: [`09`](../../.scratch/wave-orchestration/issues/09-a11y-affected-axe.md)',
      '',
      '## Resume-Metadata',
      '',
      '```yaml',
      'dispatch-log:',
      '  - "14 → agent a84 (sonnet) branch wave-orch/14-fix-broken-doc-links"',
      '  - "09 → agent abc (opus)   branch wave-orch/09-a11y-affected-axe"',
      'notes: |',
      '  stacked',
      '```',
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  it('maps the dispatch-log NN → exact branch keyed by canonical issueId', () => {
    const parsed = parseWaveSpine(frozenSpine(), '/tmp/spine-dir');
    expect(parsed.branchesByIssueId).toEqual({
      'wave-orchestration#14': 'wave-orch/14-fix-broken-doc-links',
      'wave-orchestration#09': 'wave-orch/09-a11y-affected-axe',
    });
  });

  it('returns an empty branch map for a planned spine with no dispatch-log', () => {
    const planned = [
      '# Wave — planned',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 58  | x[^source-58] | opus | mechanical | quick-verify | — | planned | 1 | — |',
      '',
      '[^source-58]: Source: [`58`](../../.scratch/wave-orchestration/issues/58-merge-order.md)',
      '',
    ].join('\n');
    const parsed = parseWaveSpine(planned, '/tmp/spine-dir');
    expect(parsed.branchesByIssueId).toEqual({});
  });
});

// ─── wo/72: parseWaveSpine — cross-slug footnote parsing ──────────────────────
//
// AC #1: value-keyed parser accepts both [^source-*] and [^<slug>-<NN>] labels.
// AC #3 table-driven fixtures: single-slug, cross-slug, mixed, and empty cases.

describe('parseWaveSpine — wo/72: cross-slug footnote parsing (value-keyed)', () => {
  /**
   * A cross-slug spine using only the slug-prefixed backtick format:
   *   [^tch-06]: `.scratch/test-coverage-hardening/issues/06-...md`
   * This is the format Wave 20 (harness-guards) uses.
   */
  function crossSlugSpine(): string {
    return [
      '# Wave 2026-06-04 — harness-guards',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID              | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --------------- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| tch/06[^tch-06] | E2E strategy | opus | cross-feature-refactor | full-review | — | dispatched | 1 | — |',
      '| cag/17[^cag-17] | Inventory guard | sonnet | isolated-refactor | quick-verify | — | dispatched | 1 | — |',
      '| wo/63[^wo-63]   | QC gate runner | sonnet | isolated-refactor | quick-verify | — | dispatched | 1 | — |',
      '',
      // Cross-slug backtick form — repo-root-relative paths.
      `[^tch-06]: \`.scratch/test-coverage-hardening/issues/06-e2e-strategy.md\``,
      `[^cag-17]: \`.scratch/claude-automation-gaps/issues/17-inventory-guard.md\``,
      `[^wo-63]: \`.scratch/wave-orchestration/issues/63-qc-gate-runner.md\``,
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  /**
   * A single-slug spine using the legacy [^source-*] linked-path format.
   * Back-compat: must behave identically to before this fix.
   */
  function singleSlugSpine(): string {
    return [
      '# Wave — single-slug legacy',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 29  | l11-rewrite[^source-29] | sonnet | mechanical | quick-verify | — | planned | 1 | — |',
      '| 32  | grep-gate[^source-32]   | sonnet | mechanical | quick-verify | — | planned | 1 | — |',
      '',
      '[^source-29]: Source: [`29`](../../.scratch/wave-orchestration/issues/29-l11-rewrite.md)',
      '[^source-32]: Source: [`32`](../../.scratch/wave-orchestration/issues/32-grep-gate.md)',
      '',
    ].join('\n');
  }

  /**
   * A mixed spine: some footnotes use [^source-*] links and some use
   * slug-prefixed backtick paths. Validates that both coexist correctly.
   */
  function mixedSpine(): string {
    return [
      '# Wave — mixed formats',
      '',
      '## Plan-Table',
      '',
      '| ID              | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --------------- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| wo/29[^source-wo-29] | l11 | sonnet | mechanical | quick-verify | — | planned | 1 | — |',
      '| cag/17[^cag-17]      | inv | sonnet | isolated-refactor | quick-verify | — | planned | 1 | — |',
      '',
      // Legacy link form for the wo/ issue.
      '[^source-wo-29]: Source: [`29`](../../.scratch/wave-orchestration/issues/29-l11-rewrite.md)',
      // Cross-slug backtick form for the cag/ issue.
      `[^cag-17]: \`.scratch/claude-automation-gaps/issues/17-inventory-guard.md\``,
      '',
    ].join('\n');
  }

  /**
   * An empty spine with no footnotes at all.
   */
  function emptySpine(): string {
    return [
      '# Wave — empty',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| -- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  // (i) Single-slug [^source-*] — back-compat: must still parse correctly.
  it('(i) single-slug [^source-*] spine: extracts both issue paths', () => {
    const parsed = parseWaveSpine(singleSlugSpine(), '/tmp/spine-dir');
    expect(parsed.issuePaths).toHaveLength(2);
    expect(parsed.issuePaths[0]).toMatch(/29-l11-rewrite\.md$/);
    expect(parsed.issuePaths[1]).toMatch(/32-grep-gate\.md$/);
  });

  it('(i) single-slug spine: issueIds are slug-qualified', () => {
    const parsed = parseWaveSpine(singleSlugSpine(), '/tmp/spine-dir');
    expect(parsed.conflictMap.issues).toContain('wave-orchestration#29');
    expect(parsed.conflictMap.issues).toContain('wave-orchestration#32');
  });

  // (ii) Cross-slug [^<slug>-<NN>] — the new format this fix enables.
  it('(ii) cross-slug [^slug-NN] spine: extracts all 3 issue paths', () => {
    // Use the real repo root so repo-root-relative resolution works.
    const parsed = parseWaveSpine(crossSlugSpine(), root);
    expect(parsed.issuePaths).toHaveLength(3);
    expect(parsed.issuePaths[0]).toMatch(/06-e2e-strategy\.md$/);
    expect(parsed.issuePaths[1]).toMatch(/17-inventory-guard\.md$/);
    expect(parsed.issuePaths[2]).toMatch(/63-qc-gate-runner\.md$/);
  });

  it('(ii) cross-slug spine: issueIds are slug-qualified from different slugs', () => {
    const parsed = parseWaveSpine(crossSlugSpine(), root);
    expect(parsed.conflictMap.issues).toContain('test-coverage-hardening#06');
    expect(parsed.conflictMap.issues).toContain('claude-automation-gaps#17');
    expect(parsed.conflictMap.issues).toContain('wave-orchestration#63');
  });

  it('(ii) cross-slug spine: resolved paths are under the repo root (not the spine dir)', () => {
    const parsed = parseWaveSpine(crossSlugSpine(), root);
    // All paths must start at the repo root, NOT a spurious /tmp/spine-dir/.scratch/ subtree.
    for (const p of parsed.issuePaths) {
      expect(p).toMatch(
        new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      );
    }
  });

  // (iii) Mixed spine — both formats coexist.
  it('(iii) mixed spine: parses both legacy [^source-*] and cross-slug [^slug-NN] footnotes', () => {
    // The legacy path resolves relative to spineDir; the cross-slug path resolves
    // relative to the repo root. We use root as spineDir so both resolve cleanly.
    const parsed = parseWaveSpine(mixedSpine(), root);
    expect(parsed.issuePaths).toHaveLength(2);
    expect(parsed.issuePaths[0]).toMatch(/29-l11-rewrite\.md$/);
    expect(parsed.issuePaths[1]).toMatch(/17-inventory-guard\.md$/);
  });

  it('(iii) mixed spine: issueIds cover both slug origins', () => {
    const parsed = parseWaveSpine(mixedSpine(), root);
    expect(parsed.conflictMap.issues).toContain('wave-orchestration#29');
    expect(parsed.conflictMap.issues).toContain('claude-automation-gaps#17');
  });

  // (iv) Empty / no-footnotes spine — still returns 0 issues (exit 1 from CLI).
  it('(iv) empty spine: returns 0 issuePaths (→ CLI exits 1)', () => {
    const parsed = parseWaveSpine(emptySpine(), '/tmp/spine-dir');
    expect(parsed.issuePaths).toHaveLength(0);
    expect(parsed.conflictMap.issues).toHaveLength(0);
  });

  // Footnotes that do NOT point at .scratch/ issue files are NOT accepted.
  it('non-issue-path footnotes (no .scratch/) are ignored', () => {
    const spine = [
      '# Wave — spurious footnotes',
      '',
      '[^ref-1]: `docs/some-doc.md`',
      '[^ref-2]: Some plain text note without a path.',
      '[^wo-29]: `.scratch/wave-orchestration/issues/29-l11-rewrite.md`',
      '',
    ].join('\n');
    const parsed = parseWaveSpine(spine, root);
    // Only the .scratch/ footnote is accepted.
    expect(parsed.issuePaths).toHaveLength(1);
    expect(parsed.issuePaths[0]).toMatch(/29-l11-rewrite\.md$/);
  });
});

// ─── wo/80: parseWaveSpine — `**Source issues**` bullet-list fallback ─────────
//
// `/wave create` emits footnote-less spines that list their issues as a
// `**Source issues**` bullet list (`- NN → \`path\``) instead of `[^key]:`
// footnotes. Before #80, neither footnote regex fired on a bullet line, so
// `issuePaths = []` and `cli.ts merge-order <spine>` hard-stopped with
// "no issues found" (exit 1) on every footnote-less spine — despite the spine
// carrying well-formed source issues. parseWaveSpine must read the bullet form
// too, value-gated on a `.scratch/` path and resolved identically to the
// footnote matcher. The genuinely-empty spine (no footnotes AND no bullets)
// must still yield 0 issues (the done/72 contract).

describe('parseWaveSpine — wo/80: `**Source issues**` bullet-list fallback', () => {
  /** Repo-root-relative `.scratch/...` path for an issue written under `root`. */
  function scratchRel(absPath: string): string {
    return relative(root, absPath).replace(/\\/g, '/');
  }

  /** Three real temp issues mirroring the wave-tools-sweep source slugs. */
  function buildSources(): Array<{ nn: number; rel: string }> {
    const a = writeIssue('wave-orchestration', 73, 'reviewer-worktree', 2);
    const b = writeIssue('wave-orchestration', 74, 'p90-recompute', 1);
    const c = writeIssue('wave-orchestration', 75, 'files-drift-exempt', 3);
    return [
      { nn: 73, rel: scratchRel(a) },
      { nn: 74, rel: scratchRel(b) },
      { nn: 75, rel: scratchRel(c) },
    ];
  }

  /**
   * A footnote-less spine whose issues live under a `**Source issues**` bullet
   * list (mirrors `2026-06-05-wave-tools-sweep.md`). `linked` switches the
   * bullet rendering between the backtick form (`- NN → \`path\``) and the
   * linked-display variant (`- NN → [NN-name](path)`).
   */
  function bulletSpine(
    sources: Array<{ nn: number; rel: string }>,
    linked = false,
  ): string {
    return [
      '# Wave 2026-06-05 — bullet-source-issues',
      '',
      '**Status:** ready',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| -- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      ...sources.map(
        (s) =>
          `| ${s.nn} | t | background | isolated-refactor | quick-verify | — | planned | 1 | — |`,
      ),
      '',
      '**Source issues** (authoritative path-resolver for `/wave start`; bare NN safe):',
      '',
      ...sources.map((s) =>
        linked ? `- ${s.nn} → [${s.nn}](${s.rel})` : `- ${s.nn} → \`${s.rel}\``,
      ),
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  /** The same issues expressed via cross-slug `[^slug-NN]` footnotes. */
  function footnoteSpine(sources: Array<{ nn: number; rel: string }>): string {
    return [
      '# Wave 2026-06-05 — equivalent footnotes',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| -- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      ...sources.map(
        (s) =>
          `| ${s.nn} | t[^wo-${s.nn}] | background | isolated-refactor | quick-verify | — | planned | 1 | — |`,
      ),
      '',
      ...sources.map((s) => `[^wo-${s.nn}]: \`${s.rel}\``),
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  it('(tracer) recognises the `- NN → `path`` bullet form on a footnote-less spine', () => {
    const sources = buildSources();
    const parsed = parseWaveSpine(bulletSpine(sources), root);
    expect(parsed.issuePaths).toHaveLength(3);
    expect(parsed.issuePaths[0]).toMatch(/73-reviewer-worktree\.md$/);
    expect(parsed.issuePaths[1]).toMatch(/74-p90-recompute\.md$/);
    expect(parsed.issuePaths[2]).toMatch(/75-files-drift-exempt\.md$/);
  });

  // AC #2: a footnote-less bullet spine yields the SAME issuePaths (and, via the
  // unchanged nnToIssueId bridge, the same conflictMap.issues) as the equivalent
  // footnote spine — the two encodings are interchangeable to the parser.
  it('issuePaths === the equivalent cross-slug footnote spine (footnote-less ≡ footnoted)', () => {
    const sources = buildSources();
    const fromBullets = parseWaveSpine(bulletSpine(sources), root);
    const fromFootnotes = parseWaveSpine(footnoteSpine(sources), root);
    expect(fromBullets.issuePaths).toHaveLength(3);
    expect(fromBullets.issuePaths).toEqual(fromFootnotes.issuePaths);
    expect(fromBullets.conflictMap.issues).toEqual(
      fromFootnotes.conflictMap.issues,
    );
  });

  // AC #2: end-to-end the bullet spine produces a valid algorithmic order — NOT
  // the "no issues found" / empty result — and it matches the footnote spine's.
  it('produces a valid algorithmic order (NOT "no issues found"), identical to the footnote spine', () => {
    const sources = buildSources();
    const order = (parsed: ReturnType<typeof parseWaveSpine>): string[] =>
      ids(
        computeMergeOrder(parsed.issuePaths, parsed.conflictMap, {
          repoRoot: root,
          git: fakeProbe({}),
        }).algorithmic,
      );
    const bulletOrder = order(parseWaveSpine(bulletSpine(sources), root));
    // fewer-Files-first, NN ASC tiebreak: 74(1f) → 73(2f) → 75(3f).
    expect(bulletOrder).toEqual([
      'wave-orchestration#74',
      'wave-orchestration#73',
      'wave-orchestration#75',
    ]);
    expect(bulletOrder).toEqual(
      order(parseWaveSpine(footnoteSpine(sources), root)),
    );
  });

  // AC #1: the linked-display variant `- NN → [..](path)` is read as a link
  // target (the path), not a backtick path.
  it('recognises the linked bullet variant `- NN → [..](path)`', () => {
    const sources = buildSources();
    const parsed = parseWaveSpine(bulletSpine(sources, true), root);
    expect(parsed.issuePaths).toHaveLength(3);
    expect(parsed.issuePaths[0]).toMatch(/73-reviewer-worktree\.md$/);
    expect(parsed.issuePaths[2]).toMatch(/75-files-drift-exempt\.md$/);
  });

  // AC #3: the genuinely-empty spine — no footnotes AND no `**Source issues**`
  // bullets AND the Plan-Table NNs do not resolve to any real issue files —
  // still yields 0 issues.
  //
  // Note (wo/84 update): the Plan-Table fallback (#84) fires when issuePaths is
  // empty, but can only yield paths for NNs that have a matching file on disk.
  // This test uses NN=999 (guaranteed never to be written by any test) so the
  // fallback finds nothing and the result stays empty — preserving the done/72
  // "unresolvable Plan-Table yields 0" contract.
  it('a footnote-less AND bullet-less spine with unresolvable NN still yields 0 issues (done/72 contract)', () => {
    const noSource = [
      '# Wave — neither footnotes nor source bullets',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| -- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 999 | t | background | isolated-refactor | quick-verify | — | planned | 1 | — |',
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
    const parsed = parseWaveSpine(noSource, root);
    expect(parsed.issuePaths).toHaveLength(0);
    expect(parsed.conflictMap.issues).toHaveLength(0);
  });

  // The `.scratch/` value-gate still rejects non-issue bullets even when they
  // carry a leading NN + backtick/linked path (`- 5 → `docs/...`` ) or no NN at
  // all (`- None …`, `- #77 …`).
  it('ignores non-issue bullets (no `.scratch/` path, or no leading NN)', () => {
    const spine = [
      '# Wave — non-issue bullets',
      '',
      '**Coordinator decisions on non-empty cells:**',
      '',
      '- None — every cell is empty.',
      '- #77 is the sole toucher of `cli.ts`.',
      '- 5 → `docs/some-doc.md`',
      '',
    ].join('\n');
    const parsed = parseWaveSpine(spine, root);
    expect(parsed.issuePaths).toHaveLength(0);
  });
});

// ─── wo/84: parseWaveSpine — Plan-Table fallback when footnotes absent ────────
//
// wave-driver-followups §L4: `cli.ts merge-order` returned "no issues found"
// for a spine that had a Plan-Table but no `[^source-*]` footnotes and no
// `**Source issues**` bullets.  The fallback introduced in #84 derives issue
// identity from the Plan-Table rows (NN → locate issue file → fileCount +
// branch) so the CLI returns a valid order for footnote-less spines.
//
// Two ACs verified here:
//   AC 1 — footnote-less Plan-Table spine yields a valid algorithmic order
//           (no more "no issues found"); ordering matches fewer-Files-first /
//           NN-ASC.
//   AC 2 (regression guard) — the footnote-driven path wins unchanged when both
//           footnotes AND a Plan-Table are present; the fallback does NOT fire.

describe('parseWaveSpine — wo/84: Plan-Table fallback when footnotes absent', () => {
  /**
   * Build a spine that has a Plan-Table with bare NN IDs but NO footnotes and
   * NO `**Source issues**` bullets — the exact shape of the wave-driver-followups
   * spine that caused §L4 (the live failure this issue fixes).
   *
   * Issue files are written to the shared `root` temp tree via `writeIssue` so
   * `findIssuePathByNN` can locate them (`root` is the simulated repo root when
   * passed as `spineDir` to `parseWaveSpine` — see `findRepoRootFrom` fallback
   * comment above).
   */
  function planTableOnlySpine(issues: Array<{ nn: number }>): string {
    return [
      '# Wave 2026-06-06 — wave-driver-followups (driver first-real-wave gaps)',
      '',
      '**Status:** in-flight',
      '**Coordinator:** human + Opus 4.8 (1M context)',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      ...issues.map(
        (i) =>
          `| ${i.nn}  | issue-${i.nn} | background | isolated-refactor | quick-verify | — | planned | 1 | — |`,
      ),
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');
  }

  // AC 1: footnote-less Plan-Table spine → valid order (NOT "no issues found").
  it('AC 1: footnote-less Plan-Table spine yields issuePaths from the Plan-Table rows', () => {
    // Write 3 issues with distinct file counts so the sort is exercised.
    const wf81 = writeIssue('wave-orchestration', 91, 'wf-driver-example', 1);
    const wf82 = writeIssue('wave-orchestration', 92, 'worktree-cleanup', 2);
    const wf83 = writeIssue('wave-orchestration', 93, 'branch-names', 3);

    const spine = planTableOnlySpine([{ nn: 91 }, { nn: 92 }, { nn: 93 }]);
    const parsed = parseWaveSpine(spine, root);

    // All 3 issue files must be discovered.
    expect(parsed.issuePaths).toHaveLength(3);
    expect(parsed.issuePaths[0]).toBe(wf81);
    expect(parsed.issuePaths[1]).toBe(wf82);
    expect(parsed.issuePaths[2]).toBe(wf83);
  });

  it('AC 1: footnote-less Plan-Table spine produces a valid algorithmic order (fewer-Files-first, NN-ASC)', () => {
    // Issues already written above (91: 1f, 92: 2f, 93: 3f).
    const spine = planTableOnlySpine([{ nn: 91 }, { nn: 92 }, { nn: 93 }]);
    const parsed = parseWaveSpine(spine, root);
    expect(parsed.issuePaths.length).toBeGreaterThan(0);

    const result = computeMergeOrder(parsed.issuePaths, parsed.conflictMap, {
      repoRoot: root,
      git: fakeProbe({}),
    });

    // 1f: wave-orchestration#91, 2f: wave-orchestration#92, 3f: wave-orchestration#93.
    expect(ids(result.algorithmic)).toEqual([
      'wave-orchestration#91',
      'wave-orchestration#92',
      'wave-orchestration#93',
    ]);
    expect(result.override).toBeNull();
  });

  it('AC 1: end-to-end — NOT the "no issues found" empty result that broke §L4', () => {
    const spine = planTableOnlySpine([{ nn: 91 }, { nn: 92 }]);
    const parsed = parseWaveSpine(spine, root);
    // Must NOT be empty — the §L4 failure was issuePaths = [].
    expect(parsed.issuePaths.length).toBeGreaterThan(0);
  });

  // AC 1: ordering reproduces the hand-computed wave-driver-followups result
  // (§L4: "#89 → #90, 2 disjoint issues, fewer-Files-first"). Using fresh NNs
  // to avoid collisions with earlier wrote-issue calls.
  it('AC 1: ordering matches fewer-Files-first (replicates the wave-driver-followups hand-computed result)', () => {
    // Issue 94 = 2 files; issue 95 = 1 file → correct order is 95 (1f) → 94 (2f).
    writeIssue('wave-orchestration', 94, 'args-channel', 2);
    writeIssue('wave-orchestration', 95, 'wf-glob', 1);

    const spine = planTableOnlySpine([{ nn: 94 }, { nn: 95 }]);
    const parsed = parseWaveSpine(spine, root);
    const result = computeMergeOrder(parsed.issuePaths, parsed.conflictMap, {
      repoRoot: root,
      git: fakeProbe({}),
    });
    // 95 (1f) should sort first, then 94 (2f).
    expect(ids(result.algorithmic)).toEqual([
      'wave-orchestration#95',
      'wave-orchestration#94',
    ]);
  });

  // AC 2 (regression guard): when footnotes ARE present, the footnote-driven
  // path wins and the fallback does NOT fire (issuePaths.length remains the
  // exact footnote set, not doubled).
  it('AC 2 (regression guard): footnote-driven path wins when both footnotes and Plan-Table are present', () => {
    // Write the target issue files.
    const p96 = writeIssue('wave-orchestration', 96, 'footnote-winner', 2);
    const p97 = writeIssue('wave-orchestration', 97, 'also-footnote', 1);

    // A spine that has BOTH [^source-*] footnotes AND a Plan-Table.  The
    // fallback must NOT fire — footnotes are the authority.
    const mixedSpine = [
      '# Wave — mixed footnote + plan-table',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 96  | footnote-winner[^source-96] | background | isolated-refactor | quick-verify | — | planned | 1 | — |',
      '| 97  | also-footnote[^source-97]   | background | isolated-refactor | quick-verify | — | planned | 1 | — |',
      '',
      // Footnotes that resolve to the real issue files (repo-root-relative
      // paths starting with `.scratch/` — resolved against repoRoot = root).
      `[^source-96]: Source: [\`96\`](.${p96.slice(root.length)})`,
      `[^source-97]: Source: [\`97\`](.${p97.slice(root.length)})`,
      '',
      '## Conflict-Map',
      '',
      '_No overlaps._',
      '',
    ].join('\n');

    const parsed = parseWaveSpine(mixedSpine, root);

    // Footnotes found → fallback did NOT fire → exactly 2 paths (not 4).
    expect(parsed.issuePaths).toHaveLength(2);
    // Both paths come from the footnote-resolved set.
    expect(parsed.issuePaths).toContain(p96);
    expect(parsed.issuePaths).toContain(p97);
  });
});

// ─── ADR-0019: computeMergeOrderFromSpine — GitHub spine, no issue files ─────
//
// A flotilla GitHub spine has bare-number Plan-Table ids ("42") and the same
// bare ids in the Conflict-Map. No footnotes, no `.scratch/` tree, no issue
// files on disk. Today `computeMergeOrderFromSpine` returns "Empty wave" because
// (1) `parseWaveSpine`'s `.scratch` fallback finds no files → empty issuePaths,
// and (2) `parseWaveSpine` routes conflict ids through `tableIdToIssueId` which
// returns null for a bare number (no slash, no footnote) → cells silently
// dropped. Fix: read the Conflict-Map via `readSpine(source).conflictMap` (bare
// ids verbatim) and build PRs from the Plan-Table with a conflict-footprint
// fileCount (distinct files an issue overlaps on across cells).
//
// Footprints: 42 ↔ 43 overlap {contract.ts} → 42:1, 43:1, 44:0.
// Algorithmic (fewer-files-first, NN tiebreak) → 44, 42, 43.

describe('computeMergeOrderFromSpine — ADR-0019: GitHub spine, no issue files on disk', () => {
  function githubSpine(): string {
    return [
      '# Wave 2026-06-20 — sample',
      '',
      '**Status:** in-flight',
      '**Coordinator:** human + claude',
      '**Created:** 2026-06-20',
      '**Last-updated:** 2026-06-20',
      '',
      '## Plan-Table',
      '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 42 | first | background | isolated-refactor | universal | — | dispatched | 1 | — |',
      '| 43 | second | background | isolated-refactor | universal | — | dispatched | 1 | — |',
      '| 44 | third | background | isolated-refactor | universal | — | dispatched | 1 | — |',
      '',
      '## DOR-check',
      '',
      'ok',
      '',
      '## Conflict-Map',
      '',
      '1. **42 ↔ 43** at `tools/wave/src/contract.ts`',
      '',
      '## PR-Log',
      '',
      '## Resume-Metadata',
      '',
      '## Closed-by',
      '',
    ].join('\n');
  }

  it('orders from the spine alone — not "Empty wave" — and joins the Conflict-Map', () => {
    // Use a FRESH temp dir with NO `.scratch` subtree so the Plan-Table fallback
    // and `.scratch` scan both reliably find nothing → issuePaths stays empty →
    // the spine-self-contained branch is exercised.
    const dir = mkdtempSync(join(tmpdir(), 'flotilla-gh-spine-'));
    const spinePath = join(dir, 'sample.md');
    writeFileSync(spinePath, githubSpine(), 'utf-8');

    // No stack edges → detectStack sees no ancestry → no override, disjoint
    // reason. The probe maps bare issueIds to branch names.
    const probe = fakeProbe({
      '42': 'wave-orch/42-first',
      '43': 'wave-orch/43-second',
      '44': 'wave-orch/44-third',
    });

    const result = computeMergeOrderFromSpine(spinePath, { repoRoot: dir, git: probe });

    expect(result.algorithmic).toHaveLength(3);
    expect(result.reason).not.toMatch(/Empty wave/);
    expect(result.algorithmic.map((p) => p.issueId)).toEqual(['44', '42', '43']);
    const byId = Object.fromEntries(result.algorithmic.map((p) => [p.issueId, p.fileCount]));
    expect(byId).toEqual({ '42': 1, '43': 1, '44': 0 });
    expect(result.reason).toMatch(/42 ↔ 43/);
  });
});

// ─── FOR-15: merge-order sources real branches on the spine-self-contained
// path, excludes never-dispatched rows, and gates the .scratch-glob warning
// to the path where it is meaningful ─────────────────────────────────────────
//
// The retro finding (F2, docs/retros/2026-07-16-hardening-w1.md): `buildSpinePrs`
// re-resolved each row's branch through `resolveExactOrGlob`'s `.scratch`
// NN-glob fallback (`wave-orch/<NN>-*`) — a convention that has no meaning for a
// self-contained GitHub/Linear spine, whose Plan-Table `id` (`FOR-15`, a bare
// GitHub number, …) already IS the canonical join key and whose `branch` is
// already correctly resolved by `readSpine` from the dispatch-log (ADR-0021).
// So the glob fallback could only ever return null or a stale wrong branch —
// never the real one — producing exactly the "advisory order reports null on a
// Linear wave" defect F2 describes.

/** Minimal SpineMeta for the fixtures below — only shape matters, not content. */
function forFifteenMeta(slug: string): SpineMeta {
  return {
    slug,
    description: 'FOR-15 fixture',
    coordinator: 'human + claude',
    model: 'opus',
    created: '2026-07-17',
    lastUpdated: '2026-07-17',
  };
}

/** Write `source` to a fresh temp dir (no `.scratch` subtree) and return its path + dir. */
function writeSpineFile(source: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flotilla-for15-'));
  const path = join(dir, 'sample.md');
  writeFileSync(path, source, 'utf-8');
  return { dir, path };
}

describe('computeMergeOrderFromSpine — FOR-15 AC1: dispatch-log branch is reported, never null', () => {
  it('reports the exact dispatch-log branch for a Linear-shaped id, via the REAL spine writers (renderSpine + setRowState + upsertDispatchLogEntry)', () => {
    const roster: SpineRosterRow[] = [
      { id: 'FOR-15', title: 'merge-order branches', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac1'),
      roster,
      { issues: ['FOR-15'], cells: [] },
      'PASS — DoR satisfied.',
    );
    source = setRowState(source, 'FOR-15', 'dispatched');
    source = upsertDispatchLogEntry(source, 'FOR-15', 'wave/FOR-15-merge-order-branches');
    const { dir, path } = writeSpineFile(source);

    // A probe that would ALWAYS resolve via the (irrelevant) NN-glob, so a
    // non-null branch in the result can only have come from the dispatch-log.
    const probe = fakeProbe({});
    const result = computeMergeOrderFromSpine(path, { repoRoot: dir, git: probe });

    expect(result.algorithmic).toHaveLength(1);
    expect(result.algorithmic[0].issueId).toBe('FOR-15');
    expect(result.algorithmic[0].branch).toBe('wave/FOR-15-merge-order-branches');
    expect(result.algorithmic[0].branch).not.toBeNull();
  });

  it('an explicit branchesByIssueId override still wins over the row-derived branch', () => {
    const roster: SpineRosterRow[] = [
      { id: 'FOR-16', title: 'x', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac1-override'),
      roster,
      { issues: ['FOR-16'], cells: [] },
      'PASS',
    );
    source = setRowState(source, 'FOR-16', 'dispatched');
    source = upsertDispatchLogEntry(source, 'FOR-16', 'wave/FOR-16-from-dispatch-log');
    const { dir, path } = writeSpineFile(source);

    const result = computeMergeOrderFromSpine(path, {
      repoRoot: dir,
      git: fakeProbe({}),
      branchesByIssueId: { 'FOR-16': 'wave/FOR-16-explicit-override' },
    });

    expect(result.algorithmic[0].branch).toBe('wave/FOR-16-explicit-override');
  });
});

describe('computeMergeOrderFromSpine — FOR-15 AC2: never-dispatched rows excluded, listed as notInPlay', () => {
  it('excludes a still-planned row with no branch and no PR; keeps a dispatched row', () => {
    const roster: SpineRosterRow[] = [
      { id: 'FOR-20', title: 'dispatched row', worker: 'background', risk: 'isolated-refactor' },
      { id: 'FOR-21', title: 'never dispatched row', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac2'),
      roster,
      { issues: ['FOR-20', 'FOR-21'], cells: [] },
      'PASS',
    );
    source = setRowState(source, 'FOR-20', 'dispatched');
    source = upsertDispatchLogEntry(source, 'FOR-20', 'wave/FOR-20-dispatched-row');
    // FOR-21 is left at its rendered default: state=planned, PR=—, no dispatch-log entry.
    const { dir, path } = writeSpineFile(source);

    const result = computeMergeOrderFromSpine(path, { repoRoot: dir, git: fakeProbe({}) });

    expect(ids(result.algorithmic)).toEqual(['FOR-20']);
    expect(ids(result.notInPlay)).toEqual(['FOR-21']);
    // A single in-play issue → no merge-order constraints, no override.
    expect(result.override).toBeNull();
  });

  it('a row with a PR but no recorded branch is NOT excluded (PR alone proves it was dispatched)', () => {
    const roster: SpineRosterRow[] = [
      { id: 'FOR-30', title: 'has a PR, no branch', worker: 'background', risk: 'isolated-refactor' },
      { id: 'FOR-31', title: 'never dispatched', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac2-pr'),
      roster,
      { issues: ['FOR-30', 'FOR-31'], cells: [] },
      'PASS',
    );
    source = setRowPrCell(source, 'FOR-30', '[PR#12](https://github.com/formtrieb/flotilla/pull/12)');
    const { dir, path } = writeSpineFile(source);

    const result = computeMergeOrderFromSpine(path, { repoRoot: dir, git: fakeProbe({}) });

    expect(ids(result.algorithmic)).toEqual(['FOR-30']);
    expect(ids(result.notInPlay)).toEqual(['FOR-31']);
  });

  it('a dispatched-state row with no branch YET recorded (pre-ADR-0021 spine shape) is still in-play, not excluded', () => {
    // Regression guard: state is the authority. A row can be legitimately
    // dispatched before its branch was ever recorded to the dispatch-log —
    // that must NOT be conflated with "never dispatched".
    const roster: SpineRosterRow[] = [
      { id: 'FOR-40', title: 'dispatched, no branch yet', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac2-predr21'),
      roster,
      { issues: ['FOR-40'], cells: [] },
      'PASS',
    );
    source = setRowState(source, 'FOR-40', 'dispatched');
    // No upsertDispatchLogEntry call — branch stays unrecorded.
    const { dir, path } = writeSpineFile(source);

    const result = computeMergeOrderFromSpine(path, { repoRoot: dir, git: fakeProbe({}) });

    expect(ids(result.algorithmic)).toEqual(['FOR-40']);
    expect(result.notInPlay).toEqual([]);
    expect(result.algorithmic[0].branch).toBeNull();
  });
});

describe('computeMergeOrder — FOR-15 AC3: the .scratch NN-glob warning fires on the Ur fallback path', () => {
  it('emits a warning when a MarkdownFs issue resolves its branch via the NN-glob (no exact spine branch declared)', () => {
    const p1 = writeIssue('for15-warn', 90, 'a', 1);
    const cm = conflictMap(['for15-warn#90']);
    // No branchesByIssueId → falls back to the glob, which DOES resolve (a hit).
    const probe = fakeProbe({ 'for15-warn#90': 'wave-orch/90-a' });
    const result = computeMergeOrder([p1], cm, { repoRoot: root, git: probe });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/NN-glob/i);
    expect(result.warnings[0]).toMatch(/for15-warn#90/);
  });

  it('does NOT warn when the exact spine branch is supplied (glob never needed)', () => {
    const p1 = writeIssue('for15-nowarn', 91, 'a', 1);
    const cm = conflictMap(['for15-nowarn#91']);
    const probe = fakeProbe({ 'for15-nowarn#91': 'wave-orch/91-a' });
    const result = computeMergeOrder([p1], cm, {
      repoRoot: root,
      git: probe,
      branchesByIssueId: { 'for15-nowarn#91': 'wave/91-a' },
    });

    expect(result.warnings).toEqual([]);
  });

  it('does NOT warn when the glob simply fails to resolve anything (no hit → no stale-collision risk)', () => {
    const p1 = writeIssue('for15-nohit', 92, 'a', 1);
    const cm = conflictMap(['for15-nohit#92']);
    const result = computeMergeOrder([p1], cm, { repoRoot: root, git: fakeProbe({}) });

    expect(result.warnings).toEqual([]);
  });
});

describe('computeMergeOrderFromSpine — FOR-15 AC3: no .scratch NN-glob warning on the spine-self-contained path', () => {
  it('never consults GitProbe.resolveBranch at all, and warnings stays empty, even when the probe would resolve a hit', () => {
    let resolveBranchCalls = 0;
    const probe: GitProbe = {
      resolveBranch(): string | null {
        resolveBranchCalls++;
        return 'wave-orch/999-should-never-be-consulted';
      },
      isAncestor(): boolean {
        return false;
      },
    };

    const roster: SpineRosterRow[] = [
      { id: 'FOR-50', title: 'dispatched', worker: 'background', risk: 'isolated-refactor' },
    ];
    let source = renderSpine(
      forFifteenMeta('for15-ac3-self-contained'),
      roster,
      { issues: ['FOR-50'], cells: [] },
      'PASS',
    );
    source = setRowState(source, 'FOR-50', 'dispatched');
    source = upsertDispatchLogEntry(source, 'FOR-50', 'wave/FOR-50-dispatched');
    const { dir, path } = writeSpineFile(source);

    const result = computeMergeOrderFromSpine(path, { repoRoot: dir, git: probe });

    expect(result.algorithmic[0].branch).toBe('wave/FOR-50-dispatched');
    expect(result.warnings).toEqual([]);
    expect(resolveBranchCalls).toBe(0);
  });
});
