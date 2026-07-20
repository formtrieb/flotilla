/**
 * worktree-cleanup.spec.ts — fixtures for the agent-worktree cleanup module
 * (wave-orchestration #57, #82).
 *
 * The git side-effects (`git worktree list --porcelain`, `git worktree remove`)
 * are isolated behind the injectable `WorktreeRemover` seam and the
 * `parseWorktreeList` pure function, so every test is hermetic — NO real
 * worktrees need to exist (mirrors the `FfProbe` injection in ff-guard.spec.ts).
 *
 * Covers:
 *   1. parseWorktreeList — canned porcelain → WorktreeEntry[]
 *      a. clean agent worktree
 *      b. dirty agent worktree (porcelain `dirty` line)
 *      c. detached-HEAD worktree (no `branch` line → branch: null)
 *      d. non-agent worktrees are filtered out
 *      e. empty output → []
 *   2. planCleanup — selection + dirty-skip
 *      a. selects only clean agent worktrees
 *      b. dirty worktrees go to skipped, never selected
 *      c. empty list → empty plan (idempotent no-op)
 *   3. executeCleanup — seam invocation guarantees
 *      a. remover called exactly for selected set
 *      b. remover NEVER called for dirty/skipped worktrees
 *      c. idempotent: empty selected set → zero remover calls
 *      d. errors from remover are collected, not thrown
 *   4. planCleanup — branch-scoped filter (issue #77)
 *      a. without filter: selects all clean worktrees (backward-compat)
 *      b. with filter: only in-scope branches selected
 *      c. worktrees outside the filter are silently excluded (not in skipped)
 *      d. detached-HEAD worktrees (branch: null) excluded when filter active
 *      e. Wave-21 scenario: 6 candidates (2 in-scope + 4 sibling) → only 2 selected
 *   5. wf_* Workflow-driver worktree recognition (issue #82)
 *      a. parseWorktreeList: wf_* worktree is parsed when path matches the marker
 *      b. wf_* worktree selected when clean (global GC, no --wave)
 *      c. wf_* worktree skipped (not removed) when dirty
 *      d. --wave filter correctly scopes a wf_* worktree (in-scope → selected)
 *      e. human-created non-prefixed .claude/worktrees/ child is NOT auto-selected
 *      f. DEFAULT_AGENT_PATH_MARKERS contains both agent- and wf_ prefixes
 *   6. parseWorktreeList — locked-worktree recognition (FOR-10)
 *      a. `locked` (no reason) line → locked: true
 *      b. `locked <reason>` line → locked: true
 *      c. no locked line → locked: false
 *      d. empty-string marker (listAllWorktrees) matches every worktree, agent or not
 *   7. cleanupCrashedRowForRedispatch — crash-cleanup before redispatch (FOR-10)
 *      a. no worktree found → idempotent no-op on the worktree; branch delete still attempted
 *      b. clean, unlocked worktree found → unlock NOT called; remove + deleteBranch called, in order
 *      c. locked worktree found → unlock called BEFORE remove
 *      d. dirty worktree, no force → refuses: unlock/remove/deleteBranch never called; blockedByDirty: true
 *      e. dirty worktree, force: true → proceeds: remove called with { force: true }; branch deleted
 *      f. idempotent: two consecutive calls (2nd with worktree: null) both succeed, no throw
 *      g. remove() throws → error captured in notes; deleteBranch NOT attempted; function does not throw
 *   8. cleanupRedispatchRows — batch wiring (FOR-10)
 *      a. only decision === 'redispatch' rows are processed; adopt/keep/needs-attention are skipped
 *      b. rows with branch: null are skipped
 *      c. each row is matched to its worktree by branch from the given worktrees list
 *      d. force option is threaded through to every row
 *   9. executeCleanup — per-worktree atomicity (FOR-34)
 *      a. a worktree whose removal fails via an injected failing remover never
 *         appears in `removed` (i.e. stays registered) and is reported as a
 *         loud per-item error in `errors`
 *      b. mixed batch: exactly the failed removals are excluded from `removed`
 *         (stay registered); the succeeded ones are removed — partial success
 *         never silently drops an item from either bucket
 *      c. a fully-clean batch (no failures) removes every item — unchanged
 *         from pre-FOR-34 behaviour
 *   10. defaultWorktreeRemover — macOS ENOTEMPTY hardening (FOR-45)
 *      a. an injected `.DS_Store` causing ENOTEMPTY is purged and the removal
 *         is retried once, succeeding cleanly (real fs fixture)
 *      b. an ENOTEMPTY with NO junk present propagates the ORIGINAL error —
 *         a real obstruction is never silently masked as a "junk" retry
 *      c. non-ASCII path segments render correctly in error messages — no
 *         mojibake — both through executeCleanup's error-collection path and
 *         through defaultWorktreeRemover's own post-purge-retry-failure path
 *
 * Section 10 is the one place in this file that exercises the REAL
 * `defaultWorktreeRemover` (every other section uses the injectable
 * `WorktreeRemover` seam). It mocks `node:child_process` (nothing else in this
 * file touches real child_process) and partially mocks `node:fs` — only
 * `rmSync` is overridden, and its default behaviour delegates to the real
 * implementation, so a test only diverges from real fs behaviour where it
 * explicitly queues a one-shot `mockImplementationOnce` throw.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENT_PATH_MARKERS,
  parseWorktreeList,
  planCleanup,
  executeCleanup,
  cleanupCrashedRowForRedispatch,
  cleanupRedispatchRows,
  defaultWorktreeRemover,
  type WorktreeEntry,
  type WorktreeRemover,
  type RedispatchCleanupOps,
} from './worktree-cleanup';

// node:child_process is mocked module-wide so Section 10's real
// `defaultWorktreeRemover` calls don't shell out to a real `git`. No test
// outside Section 10 touches real child_process (every other section uses an
// injected seam), so this is a no-op for the rest of the file.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(() => '') };
});

// node:fs is mocked module-wide but ONLY `rmSync` is overridden — and its
// default implementation forwards to the REAL rmSync. Every other fs call in
// this file (mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync
// inside worktree-cleanup.ts, and any un-queued rmSync call) is completely
// real; a test only diverges where it explicitly queues a one-shot throw via
// `mockImplementationOnce` to model the macOS Finder race (FOR-45 / W9-F1).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn((...args: unknown[]) =>
      (actual.rmSync as (...a: unknown[]) => void)(...args),
    ),
  };
});

/** Type-erasing cast to reach vitest's mock methods on the mocked `rmSync`. */
function asRmSyncMock(fn: typeof rmSync): { mockImplementationOnce: (impl: () => void) => void } {
  return fn as unknown as { mockImplementationOnce: (impl: () => void) => void };
}

/** Build a Node errno exception shaped like a real `rmSync` ENOTEMPTY failure. */
function makeEnotempty(path: string): NodeJS.ErrnoException {
  const err = new Error(
    `ENOTEMPTY: directory not empty, rmdir '${path}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOTEMPTY';
  return err;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT_PATH_A = '/repo/.claude/worktrees/agent-a1bfc5ae4aafaa4da';
const AGENT_PATH_B = '/repo/.claude/worktrees/agent-b2cef6bf5bbfbb5eb';
const NON_AGENT_PATH = '/repo';

/** Build a canned `git worktree list --porcelain` block for one worktree. */
function makeBlock(opts: {
  path: string;
  head?: string;
  branch?: string;
  dirty?: boolean;
  detached?: boolean;
  locked?: boolean | string;
}): string {
  const lines: string[] = [
    `worktree ${opts.path}`,
    `HEAD ${opts.head ?? 'abc1234abc1234abc1234abc1234abc1234abcd'}`,
  ];
  if (opts.detached) {
    lines.push('detached');
  } else {
    lines.push(
      `branch refs/heads/${opts.branch ?? 'wave-orch/57-worktree-cleanup'}`,
    );
  }
  if (opts.dirty) {
    lines.push('dirty');
  }
  if (opts.locked === true) {
    lines.push('locked');
  } else if (typeof opts.locked === 'string') {
    lines.push(`locked ${opts.locked}`);
  }
  return lines.join('\n');
}

/** Join multiple blocks as git would (double newline separator). */
function joinBlocks(...blocks: string[]): string {
  return blocks.join('\n\n');
}

/** Build a fake `WorktreeRemover` backed by a vitest spy. */
function fakeRemover(opts?: { failFor?: string[] }): {
  remover: WorktreeRemover;
  removeSpy: ReturnType<typeof vi.fn>;
} {
  const failFor = new Set(opts?.failFor ?? []);
  const removeSpy = vi.fn((path: string) => {
    if (failFor.has(path)) {
      throw new Error(`git worktree remove: cannot lock worktree at '${path}'`);
    }
  });
  return {
    remover: { remove: removeSpy },
    removeSpy,
  };
}

// ─── 1. parseWorktreeList ─────────────────────────────────────────────────────

describe('parseWorktreeList', () => {
  it('parses a single clean agent worktree', () => {
    const raw = makeBlock({ path: AGENT_PATH_A });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      path: AGENT_PATH_A,
      branch: 'wave-orch/57-worktree-cleanup',
      dirty: false,
    });
    expect(result[0].head).toBeTruthy();
  });

  it('parses a dirty agent worktree (porcelain `dirty` line present)', () => {
    const raw = makeBlock({ path: AGENT_PATH_A, dirty: true });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
  });

  it('parses a detached-HEAD worktree with branch: null', () => {
    const raw = makeBlock({ path: AGENT_PATH_A, detached: true });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].branch).toBeNull();
  });

  it('filters out non-agent worktrees (e.g. the main worktree at repo root)', () => {
    const raw = joinBlocks(
      makeBlock({ path: NON_AGENT_PATH, branch: 'main' }),
      makeBlock({ path: AGENT_PATH_A }),
    );
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(AGENT_PATH_A);
  });

  it('returns an empty array for empty porcelain output', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('\n\n')).toEqual([]);
  });

  it('parses multiple agent worktrees in one output', () => {
    const raw = joinBlocks(
      makeBlock({ path: NON_AGENT_PATH, branch: 'main' }),
      makeBlock({
        path: AGENT_PATH_A,
        branch: 'wave-orch/57-worktree-cleanup',
      }),
      makeBlock({
        path: AGENT_PATH_B,
        branch: 'wave-orch/58-some-other',
        dirty: true,
      }),
    );
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(2);
    expect(result[0].path).toBe(AGENT_PATH_A);
    expect(result[0].dirty).toBe(false);
    expect(result[1].path).toBe(AGENT_PATH_B);
    expect(result[1].dirty).toBe(true);
  });

  it('strips the refs/heads/ prefix from branch names', () => {
    const raw = makeBlock({
      path: AGENT_PATH_A,
      branch: 'wave-orch/57-worktree-cleanup',
    });
    const result = parseWorktreeList(raw);

    expect(result[0].branch).toBe('wave-orch/57-worktree-cleanup');
    // Must not have the refs/heads/ prefix
    expect(result[0].branch).not.toContain('refs/heads/');
  });
});

// ─── 2. planCleanup ──────────────────────────────────────────────────────────

describe('planCleanup', () => {
  const cleanA: WorktreeEntry = {
    path: AGENT_PATH_A,
    branch: 'wave-orch/57-worktree-cleanup',
    head: 'abc1234abc1234abc1234abc1234abc1234abcd',
    dirty: false,
  };
  const dirtyB: WorktreeEntry = {
    path: AGENT_PATH_B,
    branch: 'wave-orch/58-something',
    head: 'def5678def5678def5678def5678def5678def5',
    dirty: true,
  };

  it('selects only clean worktrees', () => {
    const plan = planCleanup([cleanA, dirtyB]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].path).toBe(AGENT_PATH_A);
  });

  it('moves dirty worktrees to skipped, never to selected', () => {
    const plan = planCleanup([cleanA, dirtyB]);

    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe(AGENT_PATH_B);
    // Critical invariant: dirty worktree must not appear in selected
    const selectedPaths = plan.selected.map((w) => w.path);
    expect(selectedPaths).not.toContain(AGENT_PATH_B);
  });

  it('returns an empty plan for an empty worktree list (idempotent no-op)', () => {
    const plan = planCleanup([]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });

  it('selects nothing when all worktrees are dirty', () => {
    const dirtyA: WorktreeEntry = { ...cleanA, dirty: true };
    const plan = planCleanup([dirtyA, dirtyB]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
  });

  it('selects all when all worktrees are clean', () => {
    const cleanB: WorktreeEntry = { ...dirtyB, dirty: false };
    const plan = planCleanup([cleanA, cleanB]);

    expect(plan.selected).toHaveLength(2);
    expect(plan.skipped).toHaveLength(0);
  });
});

// ─── 3. executeCleanup — seam invocation guarantees ──────────────────────────

describe('executeCleanup', () => {
  const cleanA: WorktreeEntry = {
    path: AGENT_PATH_A,
    branch: 'wave-orch/57-worktree-cleanup',
    head: 'abc1234abc1234abc1234abc1234abc1234abcd',
    dirty: false,
  };
  const dirtyB: WorktreeEntry = {
    path: AGENT_PATH_B,
    branch: 'wave-orch/58-something',
    head: 'def5678def5678def5678def5678def5678def5',
    dirty: true,
  };

  it('invokes the remover exactly once for each selected worktree', () => {
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, { remover });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(AGENT_PATH_A);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(AGENT_PATH_A);
  });

  it('NEVER invokes the remover for dirty/skipped worktrees', () => {
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [dirtyB] };

    executeCleanup(plan, { remover });

    // The remover must only have been called with the clean path
    const calledWith = removeSpy.mock.calls.map(([p]) => p as string);
    expect(calledWith).not.toContain(AGENT_PATH_B);
  });

  it('is idempotent: empty selected set → zero remover calls', () => {
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [], skipped: [dirtyB] };

    const result = executeCleanup(plan, { remover });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('collects remover errors without throwing', () => {
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A] });
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, { remover });

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(AGENT_PATH_A);
    expect(result.errors[0].message).toMatch(/cannot lock worktree/);
  });

  it('removes successful entries even when one fails', () => {
    const cleanC: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-cccccccc',
      branch: 'wave-orch/59-other',
      head: 'cccc1234cccc1234cccc1234cccc1234cccc1234',
      dirty: false,
    };
    // Only AGENT_PATH_A fails; cleanC succeeds
    const { remover, removeSpy } = fakeRemover({ failFor: [AGENT_PATH_A] });
    const plan = { selected: [cleanA, cleanC], skipped: [] };

    const result = executeCleanup(plan, { remover });

    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(cleanC.path);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(AGENT_PATH_A);
  });

  it('passes skipped set through to the result unchanged', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [dirtyB] };

    const result = executeCleanup(plan, { remover });

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].path).toBe(AGENT_PATH_B);
  });
});

// ─── 4. planCleanup — branch-scoped filter (issue #77) ───────────────────────

describe('planCleanup — branch-scoped filter (issue #77)', () => {
  // Six synthetic worktrees modelling the Wave-21 empirical scenario.
  // W21 = the closing wave; W22 = the live sibling wave (must not be touched).
  const W21_PATH_A = '/repo/.claude/worktrees/agent-w21aa';
  const W21_PATH_B = '/repo/.claude/worktrees/agent-w21bb';
  const W22_PATH_C = '/repo/.claude/worktrees/agent-cag13';
  const W22_PATH_D = '/repo/.claude/worktrees/agent-cag18';
  const W22_PATH_E = '/repo/.claude/worktrees/agent-wo67';
  const W22_PATH_F = '/repo/.claude/worktrees/agent-wo72';

  const W21_BRANCH_A = 'wave-orch/10-something';
  const W21_BRANCH_B = 'wave-orch/15-other';
  const W22_BRANCH_C = 'wave-orch/cag13-foo';
  const W22_BRANCH_D = 'wave-orch/cag18-bar';
  const W22_BRANCH_E = 'wave-orch/67-baz';
  const W22_BRANCH_F = 'wave-orch/72-qux';

  function makeEntry(
    path: string,
    branch: string | null,
    dirty = false,
  ): WorktreeEntry {
    return {
      path,
      branch,
      head: 'aabbccddaabbccddaabbccddaabbccddaabbccdd',
      dirty,
    };
  }

  const w21A = makeEntry(W21_PATH_A, W21_BRANCH_A);
  const w21B = makeEntry(W21_PATH_B, W21_BRANCH_B);
  const w22C = makeEntry(W22_PATH_C, W22_BRANCH_C);
  const w22D = makeEntry(W22_PATH_D, W22_BRANCH_D);
  const w22E = makeEntry(W22_PATH_E, W22_BRANCH_E);
  const w22F = makeEntry(W22_PATH_F, W22_BRANCH_F);

  /** All 6 candidates — the full set a global GC would see. */
  const allSix = [w21A, w21B, w22C, w22D, w22E, w22F];

  /** The Wave-21 branch filter (derived from the spine in production). */
  const w21Filter = new Set([W21_BRANCH_A, W21_BRANCH_B]);

  it('without filter: selects all clean worktrees (backward-compatible with pre-#77 behaviour)', () => {
    const plan = planCleanup(allSix);

    expect(plan.selected).toHaveLength(6);
    expect(plan.skipped).toHaveLength(0);
  });

  it('with filter: only worktrees whose branch is in the set are selected', () => {
    const plan = planCleanup(allSix, w21Filter);

    expect(plan.selected).toHaveLength(2);
    const selectedPaths = plan.selected.map((w) => w.path);
    expect(selectedPaths).toContain(W21_PATH_A);
    expect(selectedPaths).toContain(W21_PATH_B);
  });

  it('worktrees outside the filter are silently excluded — not in selected OR skipped', () => {
    const plan = planCleanup(allSix, w21Filter);

    // Sibling (W22) paths must appear in neither bucket.
    const allPaths = [
      ...plan.selected.map((w) => w.path),
      ...plan.skipped.map((w) => w.path),
    ];
    expect(allPaths).not.toContain(W22_PATH_C);
    expect(allPaths).not.toContain(W22_PATH_D);
    expect(allPaths).not.toContain(W22_PATH_E);
    expect(allPaths).not.toContain(W22_PATH_F);
  });

  it('detached-HEAD worktrees (branch: null) are excluded when filter is active', () => {
    const detached = makeEntry('/repo/.claude/worktrees/agent-detached', null);
    const plan = planCleanup([...allSix, detached], w21Filter);

    const allPaths = [
      ...plan.selected.map((w) => w.path),
      ...plan.skipped.map((w) => w.path),
    ];
    expect(allPaths).not.toContain(detached.path);
  });

  it('dirty in-scope worktrees go to skipped, clean in-scope go to selected', () => {
    const w21ADirty = makeEntry(W21_PATH_A, W21_BRANCH_A, true);
    // Mix: dirty in-scope + clean in-scope + out-of-scope entries
    const plan = planCleanup([w21ADirty, w21B, w22C, w22D], w21Filter);

    // w21ADirty is in-scope but dirty → skipped
    // w21B is in-scope and clean → selected
    // w22C, w22D are out-of-scope → neither bucket
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe(W21_PATH_A);
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].path).toBe(W21_PATH_B);
  });

  /**
   * AC#3 — Wave-21 scenario reproduction.
   *
   * Empirical context (Wave 21 close, 2026-06-04): the global dry-run selected
   * 6 worktrees — 2 from W21 (`wave-orch/10-*`, `wave-orch/15-*`) and 4 from the
   * still-live sibling W22 (`cag13`, `cag18`, `wo67`, `wo72`). Running global
   * cleanup would have removed the sibling's worktrees mid-flight.
   *
   * With `--wave <W21-spine>`, `resolveBranchFilter` derives `w21Filter` from the
   * spine's `branchesByIssueId` and passes it to `planCleanup`. Only the 2 W21
   * worktrees are selected; the 4 W22 worktrees are neither selected nor removed.
   */
  it('Wave-21 scenario: 6 candidates (2 in-scope + 4 sibling) → only the 2 in-scope selected', () => {
    const plan = planCleanup(allSix, w21Filter);

    // Exactly 2 selected.
    expect(plan.selected).toHaveLength(2);

    // Exactly the W21 paths.
    const selectedPaths = plan.selected.map((w) => w.path).sort();
    expect(selectedPaths).toEqual([W21_PATH_A, W21_PATH_B].sort());

    // Zero skipped (all W21 entries are clean; W22 entries are excluded, not skipped).
    expect(plan.skipped).toHaveLength(0);

    // The 4 sibling (W22) worktrees are neither selected nor placed in skipped.
    const siblingPaths = [W22_PATH_C, W22_PATH_D, W22_PATH_E, W22_PATH_F];
    for (const sibPath of siblingPaths) {
      expect(plan.selected.map((w) => w.path)).not.toContain(sibPath);
      expect(plan.skipped.map((w) => w.path)).not.toContain(sibPath);
    }
  });

  it('scoped run with empty filter set: no worktrees selected (reports removed: [] — no-op)', () => {
    // A filter of size 0 matches nothing — idempotent no-op like the empty-list case.
    const emptyFilter = new Set<string>();
    const plan = planCleanup(allSix, emptyFilter);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(0);
  });
});

// ─── 5. wf_* Workflow-driver worktree recognition (issue #82) ────────────────

describe('wf_* Workflow-driver worktree recognition (issue #82)', () => {
  const WF_PATH_CLEAN = '/repo/.claude/worktrees/wf_5b3073fb-12f-1';
  const WF_PATH_DIRTY = '/repo/.claude/worktrees/wf_5b3073fb-12f-2';
  const HUMAN_PATH = '/repo/.claude/worktrees/my-scratch-wt'; // no recognized prefix

  const WF_BRANCH_CLEAN = 'wave-orch/82-worktree-cleanup-wf';
  const WF_BRANCH_DIRTY = 'wave-orch/83-some-other';

  /** Inline makeEntry for wf_ tests (mirrors the fixture helper above). */
  function makeWfEntry(
    path: string,
    branch: string,
    dirty = false,
  ): WorktreeEntry {
    return {
      path,
      branch,
      head: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty,
    };
  }

  it('DEFAULT_AGENT_PATH_MARKERS includes both agent- and wf_ prefixes', () => {
    expect(DEFAULT_AGENT_PATH_MARKERS).toContain('.claude/worktrees/agent-');
    expect(DEFAULT_AGENT_PATH_MARKERS).toContain('.claude/worktrees/wf_');
  });

  it('parseWorktreeList: wf_* worktree is parsed with the default markers', () => {
    const raw = joinBlocks(
      makeBlock({ path: WF_PATH_CLEAN, branch: WF_BRANCH_CLEAN }),
    );
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(WF_PATH_CLEAN);
    expect(result[0].branch).toBe(WF_BRANCH_CLEAN);
    expect(result[0].dirty).toBe(false);
  });

  it('parseWorktreeList: dirty wf_* worktree is parsed with dirty: true', () => {
    const raw = joinBlocks(
      makeBlock({ path: WF_PATH_DIRTY, branch: WF_BRANCH_DIRTY, dirty: true }),
    );
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
  });

  it('parseWorktreeList: human-created non-prefixed .claude/worktrees/ child is NOT parsed', () => {
    // A worktree under .claude/worktrees/ that lacks either recognized prefix
    // must be filtered out — it is a human-created scratch worktree.
    const raw = joinBlocks(
      makeBlock({ path: HUMAN_PATH, branch: 'my-experiment' }),
    );
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(0);
  });

  it('global GC (no --wave): wf_* clean worktree is selected for removal', () => {
    const wfClean = makeWfEntry(WF_PATH_CLEAN, WF_BRANCH_CLEAN);
    const plan = planCleanup([wfClean]);

    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].path).toBe(WF_PATH_CLEAN);
    expect(plan.skipped).toHaveLength(0);
  });

  it('global GC: dirty wf_* worktree is skipped, NEVER selected', () => {
    const wfDirty = makeWfEntry(WF_PATH_DIRTY, WF_BRANCH_DIRTY, true);
    const plan = planCleanup([wfDirty]);

    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].path).toBe(WF_PATH_DIRTY);
    expect(plan.selected).toHaveLength(0);
  });

  it('global GC: wf_* and agent-* worktrees co-exist — both selected when clean', () => {
    const agentClean: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave-orch/57-worktree-cleanup',
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
    };
    const wfClean = makeWfEntry(WF_PATH_CLEAN, WF_BRANCH_CLEAN);

    const plan = planCleanup([agentClean, wfClean]);

    expect(plan.selected).toHaveLength(2);
    const selectedPaths = plan.selected.map((w) => w.path);
    expect(selectedPaths).toContain(AGENT_PATH_A);
    expect(selectedPaths).toContain(WF_PATH_CLEAN);
    expect(plan.skipped).toHaveLength(0);
  });

  it('--wave filter: in-scope wf_* branch is selected; out-of-scope is silently excluded', () => {
    const wfInScope = makeWfEntry(WF_PATH_CLEAN, WF_BRANCH_CLEAN);
    const wfOutScope = makeWfEntry(WF_PATH_DIRTY, 'wave-orch/99-unrelated');

    const branchFilter = new Set([WF_BRANCH_CLEAN]);
    const plan = planCleanup([wfInScope, wfOutScope], branchFilter);

    // In-scope clean wf_* → selected.
    expect(plan.selected).toHaveLength(1);
    expect(plan.selected[0].path).toBe(WF_PATH_CLEAN);

    // Out-of-scope wf_* → neither selected nor skipped (silently excluded).
    const allPaths = [
      ...plan.selected.map((w) => w.path),
      ...plan.skipped.map((w) => w.path),
    ];
    expect(allPaths).not.toContain(WF_PATH_DIRTY);
    expect(plan.skipped).toHaveLength(0);
  });

  it('executeCleanup: remover is called for clean wf_* worktrees via the injectable seam', () => {
    const wfClean = makeWfEntry(WF_PATH_CLEAN, WF_BRANCH_CLEAN);
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [wfClean], skipped: [] };

    const result = executeCleanup(plan, { remover });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(WF_PATH_CLEAN);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(WF_PATH_CLEAN);
  });

  it('executeCleanup: remover is NEVER called for dirty wf_* worktrees', () => {
    const wfDirty = makeWfEntry(WF_PATH_DIRTY, WF_BRANCH_DIRTY, true);
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [], skipped: [wfDirty] };

    executeCleanup(plan, { remover });

    expect(removeSpy).not.toHaveBeenCalled();
  });
});

// ─── 6. parseWorktreeList — locked-worktree recognition (FOR-10) ─────────────

describe('parseWorktreeList — locked-worktree recognition (FOR-10)', () => {
  it('a bare `locked` line (no reason) → locked: true', () => {
    const raw = makeBlock({ path: AGENT_PATH_A, locked: true });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].locked).toBe(true);
  });

  it('a `locked <reason>` line → locked: true', () => {
    const raw = makeBlock({
      path: AGENT_PATH_A,
      locked: 'crashed worker, manual disposition pending',
    });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].locked).toBe(true);
  });

  it('no locked line → locked: false', () => {
    const raw = makeBlock({ path: AGENT_PATH_A });
    const result = parseWorktreeList(raw);

    expect(result).toHaveLength(1);
    expect(result[0].locked).toBe(false);
  });

  it('an empty-string marker matches every worktree, agent-prefixed or not (listAllWorktrees)', () => {
    const raw = joinBlocks(
      makeBlock({ path: NON_AGENT_PATH, branch: 'main' }),
      makeBlock({ path: AGENT_PATH_A }),
    );
    const result = parseWorktreeList(raw, ['']);

    expect(result).toHaveLength(2);
    const paths = result.map((w) => w.path).sort();
    expect(paths).toEqual([AGENT_PATH_A, NON_AGENT_PATH].sort());
  });
});

// ─── 7. cleanupCrashedRowForRedispatch — crash-cleanup before redispatch (FOR-10) ──

describe('cleanupCrashedRowForRedispatch — crash-cleanup before redispatch (FOR-10)', () => {
  const BRANCH = 'wave/FOR-10-resume-cleanup';
  const WT_PATH = '/repo/.claude/worktrees/wf_deadbeef-10-1';

  /** Build a fake `RedispatchCleanupOps` backed by vitest spies, with a shared
   *  call-order log so ordering assertions don't depend on vitest internals. */
  function fakeOps(opts?: {
    removeThrows?: string;
  }): { ops: RedispatchCleanupOps; calls: string[] } {
    const calls: string[] = [];
    const ops: RedispatchCleanupOps = {
      unlock: vi.fn((path: string) => {
        calls.push(`unlock:${path}`);
      }),
      remove: vi.fn((path: string, removeOpts?: { force?: boolean }) => {
        calls.push(`remove:${path}:force=${Boolean(removeOpts?.force)}`);
        if (opts?.removeThrows) {
          throw new Error(opts.removeThrows);
        }
      }),
      deleteBranch: vi.fn((branch: string) => {
        calls.push(`deleteBranch:${branch}`);
      }),
    };
    return { ops, calls };
  }

  it('no worktree found → idempotent no-op on unlock/remove; branch delete still attempted', () => {
    const { ops, calls } = fakeOps();

    const result = cleanupCrashedRowForRedispatch(
      { branch: BRANCH, worktree: null },
      { ops },
    );

    expect(ops.unlock).not.toHaveBeenCalled();
    expect(ops.remove).not.toHaveBeenCalled();
    expect(ops.deleteBranch).toHaveBeenCalledTimes(1);
    expect(ops.deleteBranch).toHaveBeenCalledWith(BRANCH);
    expect(calls).toEqual([`deleteBranch:${BRANCH}`]);

    expect(result.worktreePath).toBeNull();
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(true);
    expect(result.blockedByDirty).toBe(false);
  });

  it('clean, unlocked worktree found → unlock NOT called; remove then deleteBranch, in order', () => {
    const { ops, calls } = fakeOps();
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: false,
    };

    const result = cleanupCrashedRowForRedispatch({ branch: BRANCH, worktree }, { ops });

    expect(ops.unlock).not.toHaveBeenCalled();
    expect(ops.remove).toHaveBeenCalledWith(WT_PATH, { force: false });
    expect(ops.deleteBranch).toHaveBeenCalledWith(BRANCH);
    // remove must precede deleteBranch — a branch can't be deleted while checked out.
    expect(calls).toEqual([
      `remove:${WT_PATH}:force=false`,
      `deleteBranch:${BRANCH}`,
    ]);

    expect(result.worktreePath).toBe(WT_PATH);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.blockedByDirty).toBe(false);
  });

  it('locked worktree found → unlock is called BEFORE remove', () => {
    const { ops, calls } = fakeOps();
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: true,
    };

    const result = cleanupCrashedRowForRedispatch({ branch: BRANCH, worktree }, { ops });

    expect(calls).toEqual([
      `unlock:${WT_PATH}`,
      `remove:${WT_PATH}:force=false`,
      `deleteBranch:${BRANCH}`,
    ]);
    expect(result.wasLocked).toBe(true);
    expect(result.worktreeRemoved).toBe(true);
  });

  it('dirty worktree, no force → refuses: unlock/remove/deleteBranch never called; blockedByDirty: true', () => {
    const { ops } = fakeOps();
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: true,
      locked: false,
    };

    const result = cleanupCrashedRowForRedispatch({ branch: BRANCH, worktree }, { ops });

    expect(ops.unlock).not.toHaveBeenCalled();
    expect(ops.remove).not.toHaveBeenCalled();
    expect(ops.deleteBranch).not.toHaveBeenCalled();

    expect(result.blockedByDirty).toBe(true);
    expect(result.worktreeRemoved).toBe(false);
    expect(result.branchDeleted).toBe(false);
    expect(result.notes.join(' ')).toMatch(/uncommitted changes/);
  });

  it('dirty worktree, force: true → proceeds: remove called with { force: true }; branch deleted', () => {
    const { ops, calls } = fakeOps();
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: true,
      locked: false,
    };

    const result = cleanupCrashedRowForRedispatch(
      { branch: BRANCH, worktree },
      { ops, force: true },
    );

    expect(ops.remove).toHaveBeenCalledWith(WT_PATH, { force: true });
    expect(calls).toEqual([
      `remove:${WT_PATH}:force=true`,
      `deleteBranch:${BRANCH}`,
    ]);
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(true);
    expect(result.blockedByDirty).toBe(false);
  });

  it('is idempotent: a second call with worktree: null (post-removal) succeeds without throwing', () => {
    const { ops: ops1 } = fakeOps();
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: false,
    };

    const first = cleanupCrashedRowForRedispatch({ branch: BRANCH, worktree }, { ops: ops1 });
    expect(first.worktreeRemoved).toBe(true);

    // A fresh listing after removal finds no worktree for this branch.
    const { ops: ops2 } = fakeOps();
    const second = cleanupCrashedRowForRedispatch(
      { branch: BRANCH, worktree: null },
      { ops: ops2 },
    );

    expect(second.worktreeRemoved).toBe(false);
    expect(second.branchDeleted).toBe(true);
    expect(second.blockedByDirty).toBe(false);
  });

  it('ops.remove() throwing → error captured in notes; deleteBranch NOT attempted; function does not throw', () => {
    const { ops, calls } = fakeOps({ removeThrows: 'git worktree remove: unable to unlink' });
    const worktree: WorktreeEntry = {
      path: WT_PATH,
      branch: BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: false,
    };

    let result: ReturnType<typeof cleanupCrashedRowForRedispatch> | undefined;
    expect(() => {
      result = cleanupCrashedRowForRedispatch({ branch: BRANCH, worktree }, { ops });
    }).not.toThrow();

    expect(ops.deleteBranch).not.toHaveBeenCalled();
    expect(calls).toEqual([`remove:${WT_PATH}:force=false`]);

    expect(result!.worktreeRemoved).toBe(false);
    expect(result!.branchDeleted).toBe(false);
    expect(result!.notes.join(' ')).toMatch(/unable to unlink/);
  });
});

// ─── 8. cleanupRedispatchRows — batch wiring (FOR-10) ────────────────────────

describe('cleanupRedispatchRows — batch wiring (FOR-10)', () => {
  const REDISPATCH_BRANCH = 'wave/FOR-10-redispatch-row';
  const ADOPT_BRANCH = 'wave/FOR-10-adopt-row';

  function fakeOps(): { ops: RedispatchCleanupOps } {
    return {
      ops: {
        unlock: vi.fn(),
        remove: vi.fn(),
        deleteBranch: vi.fn(),
      },
    };
  }

  it('only processes decision === "redispatch" rows; adopt/keep/needs-attention are skipped', () => {
    const { ops } = fakeOps();
    const rows = [
      { branch: REDISPATCH_BRANCH, decision: 'redispatch' },
      { branch: ADOPT_BRANCH, decision: 'adopt' },
      { branch: 'wave/FOR-10-keep-row', decision: 'keep' },
      { branch: 'wave/FOR-10-na-row', decision: 'needs-attention' },
    ];

    const results = cleanupRedispatchRows(rows, [], { ops });

    expect(results).toHaveLength(1);
    expect(results[0].branch).toBe(REDISPATCH_BRANCH);
    // The adopt row's worktree must never be touched by crash-cleanup.
    expect(ops.remove).not.toHaveBeenCalledWith(expect.stringContaining('adopt'), expect.anything());
  });

  it('rows with branch: null are skipped', () => {
    const { ops } = fakeOps();
    const rows = [{ branch: null, decision: 'redispatch' }];

    const results = cleanupRedispatchRows(rows, [], { ops });

    expect(results).toHaveLength(0);
    expect(ops.deleteBranch).not.toHaveBeenCalled();
  });

  it('matches each row to its worktree by branch from the given worktrees list', () => {
    const { ops } = fakeOps();
    const worktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-10-1',
      branch: REDISPATCH_BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: true,
    };
    const rows = [{ branch: REDISPATCH_BRANCH, decision: 'redispatch' }];

    const results = cleanupRedispatchRows(rows, [worktree], { ops });

    expect(results).toHaveLength(1);
    expect(results[0].worktreePath).toBe(worktree.path);
    expect(ops.unlock).toHaveBeenCalledWith(worktree.path);
    expect(ops.remove).toHaveBeenCalledWith(worktree.path, { force: false });
  });

  it('threads the force option through to every row', () => {
    const { ops } = fakeOps();
    const worktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_deadbeef-10-2',
      branch: REDISPATCH_BRANCH,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: true,
      locked: false,
    };
    const rows = [{ branch: REDISPATCH_BRANCH, decision: 'redispatch' }];

    const results = cleanupRedispatchRows(rows, [worktree], { ops, force: true });

    expect(results[0].blockedByDirty).toBe(false);
    expect(ops.remove).toHaveBeenCalledWith(worktree.path, { force: true });
  });
});

// ─── 9. executeCleanup — per-worktree atomicity (FOR-34) ─────────────────────
//
// The third-repeat live finding (W2-F6, W3-F4, W4-F3, W5-F4): the GC path used
// to deregister a worktree from git even when its directory failed to delete,
// leaving an orphan physical directory no `git worktree` command could see.
// `executeCleanup`'s per-item try/catch is the choke point that guarantees
// atomicity from the caller's perspective — an item only ever reaches
// `removed` when `remover.remove()` returns without throwing. These tests
// pin that contract via an injected FAILING remover (per the FOR-34 spec),
// exactly mirroring how the real `defaultWorktreeRemover` (worktree-cleanup.ts)
// is built to fail BEFORE calling any git deregistration command — so a throw
// here always means "nothing was touched", i.e. the worktree stays registered.

describe('executeCleanup — per-worktree atomicity (FOR-34)', () => {
  const wtFails: WorktreeEntry = {
    path: '/repo/.claude/worktrees/agent-fails11111',
    branch: 'wave/FOR-34-fails',
    head: '1111111111111111111111111111111111111111',
    dirty: false,
  };
  const wtSucceedsA: WorktreeEntry = {
    path: '/repo/.claude/worktrees/agent-okaaaaaaa22',
    branch: 'wave/FOR-34-ok-a',
    head: '2222222222222222222222222222222222222222',
    dirty: false,
  };
  const wtSucceedsB: WorktreeEntry = {
    path: '/repo/.claude/worktrees/agent-okbbbbbbb33',
    branch: 'wave/FOR-34-ok-b',
    head: '3333333333333333333333333333333333333333',
    dirty: false,
  };

  it('a worktree whose removal fails via an injected failing remover never appears in `removed` (stays registered) and is reported as a loud per-item error', () => {
    const { remover } = fakeRemover({ failFor: [wtFails.path] });
    const plan = { selected: [wtFails], skipped: [] };

    const result = executeCleanup(plan, { remover });

    // Never in `removed` — nothing in the system will treat it as gone.
    expect(result.removed.map((w) => w.path)).not.toContain(wtFails.path);
    expect(result.removed).toHaveLength(0);

    // Reported loudly, once, with an informative message.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(wtFails.path);
    expect(result.errors[0].message.length).toBeGreaterThan(0);
  });

  it('mixed batch: exactly the failed removal stays out of `removed`; the succeeded ones are removed — partial success never silently drops an item', () => {
    const { remover, removeSpy } = fakeRemover({ failFor: [wtFails.path] });
    const plan = { selected: [wtSucceedsA, wtFails, wtSucceedsB], skipped: [] };

    const result = executeCleanup(plan, { remover });

    // The remover is invoked for every selected item, regardless of outcome.
    expect(removeSpy).toHaveBeenCalledTimes(3);

    // Exactly the two successes are removed, in no particular guaranteed order,
    // but both present and the failure absent.
    const removedPaths = result.removed.map((w) => w.path).sort();
    expect(removedPaths).toEqual(
      [wtSucceedsA.path, wtSucceedsB.path].sort(),
    );

    // Exactly the one failure is reported — never silently dropped from both
    // buckets, never double-counted.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(wtFails.path);

    // Sanity: total accounted-for entries equal the selected count.
    expect(result.removed.length + result.errors.length).toBe(
      plan.selected.length,
    );
  });

  it('a fully-clean batch (no failures) removes every item — unchanged from pre-FOR-34 behaviour', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [wtSucceedsA, wtSucceedsB], skipped: [] };

    const result = executeCleanup(plan, { remover });

    expect(result.errors).toHaveLength(0);
    const removedPaths = result.removed.map((w) => w.path).sort();
    expect(removedPaths).toEqual(
      [wtSucceedsA.path, wtSucceedsB.path].sort(),
    );
  });
});

// ─── 10. defaultWorktreeRemover — macOS ENOTEMPTY hardening (FOR-45) ─────────
//
// Live finding W9-F1 (docs/retros/2026-07-20-landing-seam-w9.md): the real
// `defaultWorktreeRemover` errored ENOTEMPTY on every worktree in a wave
// close, with a Finder-created `.DS_Store` as the suspected obstruction, and
// the error text rendered a non-ASCII (en-dash) path segment as mojibake.
//
// These tests use REAL fs fixtures (mkdtemp'd temp dirs) so the removal path
// is exercised end to end; only the exact ENOTEMPTY race is simulated via a
// one-shot `rmSync` mock (see the module-level `vi.mock('node:fs', ...)`
// above), and `git worktree remove` is mocked to a no-op so no real git
// registration is required for the fixture directory.

describe('defaultWorktreeRemover — macOS ENOTEMPTY hardening (FOR-45)', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
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

  function makeTempWorktree(...subPathSegments: string[]): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-spec-'));
    tempRoots.push(root);
    const worktreePath = join(root, ...subPathSegments);
    mkdirSync(worktreePath, { recursive: true });
    return { root, worktreePath };
  }

  it('purges an injected .DS_Store and retries once when it is the only ENOTEMPTY obstruction — the worktree is removed cleanly', () => {
    const { root, worktreePath } = makeTempWorktree('agent-junk-only');
    writeFileSync(join(worktreePath, 'real-file.txt'), 'hello', 'utf-8');
    writeFileSync(join(worktreePath, '.DS_Store'), 'finder-debris', 'utf-8');

    // The first rmSync attempt simulates the live Finder race: nothing is
    // actually deleted on this call, so the fixture is untouched afterwards.
    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw makeEnotempty(worktreePath);
    });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).not.toThrow();

    // The retry (real rmSync, after the .DS_Store purge) removed the tree.
    expect(existsSync(worktreePath)).toBe(false);

    // Step 2 (deregister) was still reached — the 2-step contract holds.
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: root }),
    );
  });

  it('propagates the ORIGINAL ENOTEMPTY error when no Finder junk is found — a real obstruction is never silently masked', () => {
    const { worktreePath, root } = makeTempWorktree('agent-real-obstruction');
    writeFileSync(join(worktreePath, 'real-file.txt'), 'hello', 'utf-8');
    // No .DS_Store / junk present — this ENOTEMPTY is NOT junk-shaped.

    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw makeEnotempty(worktreePath);
    });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).toThrow(/ENOTEMPTY/);

    // Nothing was deleted, and step 2 (deregister) was never reached.
    expect(existsSync(join(worktreePath, 'real-file.txt'))).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('a dirty worktree never reaches the remover at all — the skip decision is made upstream in planCleanup, unchanged by this hardening', () => {
    // This is the same invariant Section 3 already pins ("NEVER invokes the
    // remover for dirty/skipped worktrees"); restated here against the REAL
    // defaultWorktreeRemover to document that FOR-45 touched only the
    // physical-removal implementation, never the dirty/clean selection.
    const dirty: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-dirty-untouched',
      branch: 'wave/FOR-45-dirty',
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: true,
    };
    const plan = planCleanup([dirty]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);

    // executeCleanup never calls a remover for a plan with nothing selected —
    // the real defaultWorktreeRemover is passed here specifically to prove
    // it is never invoked, not even indirectly.
    const remover = defaultWorktreeRemover('/repo');
    const result = executeCleanup(plan, { remover });
    expect(execFileSync).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toEqual([dirty]);
  });

  describe('non-ASCII path rendering — no mojibake', () => {
    // The live incident's path shape: an en dash (U+2013) path segment. The
    // observed corruption was the classic symptom of UTF-8 bytes decoded as
    // Latin-1/Windows-1252 (0xE2 0x80 0x93 → "â").
    const NON_ASCII_SEGMENT = 'Projects – Clients';
    const MOJIBAKE_SEGMENT = 'Projects â Clients';

    it('executeCleanup preserves a non-ASCII path segment in a remover error message, byte-for-byte', () => {
      const nonAsciiPath = `/Users/dev/${NON_ASCII_SEGMENT}/flotilla/.claude/worktrees/agent-nonascii1`;
      const remover: WorktreeRemover = {
        remove: () => {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${nonAsciiPath}'`);
        },
      };
      const wt: WorktreeEntry = {
        path: nonAsciiPath,
        branch: 'wave/FOR-45-nonascii',
        head: 'abc1234abc1234abc1234abc1234abc1234abcd',
        dirty: false,
      };
      const plan = { selected: [wt], skipped: [] };

      const result = executeCleanup(plan, { remover });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain(NON_ASCII_SEGMENT);
      expect(result.errors[0].message).not.toContain(MOJIBAKE_SEGMENT);
    });

    it('defaultWorktreeRemover renders a non-ASCII worktree path correctly when the post-purge retry itself still fails', async () => {
      const { worktreePath, root } = makeTempWorktree(NON_ASCII_SEGMENT, 'agent-stubborn');
      writeFileSync(join(worktreePath, 'real-file.txt'), 'hello', 'utf-8');
      writeFileSync(join(worktreePath, '.DS_Store'), 'finder-debris', 'utf-8');

      // Real rmSync, reached directly (bypassing the mock) so the queued
      // "once" throws below can be reserved precisely for the two TOP-LEVEL
      // calls (initial attempt + retry) without being consumed by the
      // Finder-junk purge's own (real) deletion of `.DS_Store` in between.
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const mockedRmSync = asRmSyncMock(rmSync);
      // 1st top-level call: initial attempt — junk-shaped ENOTEMPTY.
      mockedRmSync.mockImplementationOnce(() => {
        throw makeEnotempty(worktreePath);
      });
      // The Finder-junk purge's own `.DS_Store` deletion — let it really happen.
      (mockedRmSync as unknown as { mockImplementationOnce: (impl: (...args: unknown[]) => void) => void }).mockImplementationOnce(
        (...args: unknown[]) => (actualFs.rmSync as (...a: unknown[]) => void)(...args),
      );
      // 2nd top-level call: the post-purge retry ALSO fails (a genuine
      // obstruction alongside the junk) — the wrapped error must still
      // render correctly.
      mockedRmSync.mockImplementationOnce(() => {
        throw makeEnotempty(worktreePath);
      });

      const remover = defaultWorktreeRemover(root);
      let thrown: unknown;
      try {
        remover.remove(worktreePath);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message).toContain(NON_ASCII_SEGMENT);
      expect(message).not.toContain(MOJIBAKE_SEGMENT);
      // Confirms this went through the "still failed after purge" wrap
      // (proving describeError ran), not a pass-through of the raw error.
      expect(message).toMatch(/Finder-junk/);
    });
  });
});
