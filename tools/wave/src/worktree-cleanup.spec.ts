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
 *   11. defaultWorktreeRemover — editor/harness junk-class hardening (FOR-56, W12-F2)
 *      a. the exact W12 leftover shape (.vscode/settings.json +
 *         .claude/agents/<file> + a NESTED .DS_Store) is purged and the
 *         removal retried once, succeeding cleanly
 *      b. a real top-level file coexisting with the new junk classes is
 *         still torn down once the remover is reached — the purge only
 *         breaks the ENOTEMPTY race, it never decides removal eligibility
 *      c. the dirty-worktree guarantee is unchanged: a real file nested
 *         inside `.vscode/`/`.claude/`, or at the top level alongside junk,
 *         still means `dirty: true` → skipped upstream in planCleanup, the
 *         remover is never reached at all
 *   12. listAgentWorktrees — toplevel-guarded orphan classification (FOR-59)
 *      a. an orphan dir's dirty state is classified from its OWN content,
 *         never leaked from a parent repo's unrelated untracked file
 *      b. an orphan dir that is exclusively allowlisted junk → orphanAllJunk: true
 *      c. an orphan dir with any real file (top-level, or nested in a
 *         JUNK_DIR_NAMES directory) → orphanAllJunk: false
 *      d. an empty orphan dir is vacuously all-junk
 *      e. regression: an ordinary registered worktree (dirty or clean) is
 *         still classified correctly via its own `git status` — unaffected
 *         by the guard
 *   13. planCleanup — orphan-dir routing + skip reasons (FOR-59)
 *      a. orphan + orphanAllJunk: true → selected
 *      b. orphan + orphanAllJunk: false → skipped, reason: 'orphan-with-real-files'
 *      c. locked → skipped, reason: 'locked' (never reaches the remover)
 *      d. dirty → skipped, reason: 'dirty'
 *      e. every skipped[] entry in a mixed batch carries a reason
 *   14. executeCleanup — local branch hygiene (FOR-59 scope extension, + FOR-62)
 *      a. rule (a): the wf_* harness throwaway branch is always force-deleted
 *      b. rule (b): the worktree's own wave/* branch is force-deleted only
 *         with merge evidence (upstream gone, tip contained in default, OR
 *         — FOR-62 — the remote ref for exactly that branch confirmed gone)
 *      c. rule (b) refusal: no evidence → branch left alone
 *      d. rule (c): a branch checked out elsewhere is never deleted, even
 *         with merge evidence (including remote-ref-gone evidence, FOR-62)
 *      e. an agent-* worktree never attempts the throwaway-branch rule; a
 *         non-`wave/`-prefixed branch never triggers rule (b) (nor the
 *         remote-ref probe)
 *      f. hygiene never runs for a failed removal, or when skipBranchHygiene
 *         is set, or when nothing was selected
 *      g. an orphan-dir purge also triggers hygiene, not just an ordinary removal
 *      h. FOR-62: remote-ref-gone alone is sufficient (no other signal needed)
 *      i. FOR-62: a probe FAILURE is never read as gone — branch left alone
 *      j. FOR-62: a probe that finds the ref still present is not evidence
 *   15. defaultBranchHygieneOps — real-git command shape (FOR-59, + FOR-62)
 *      a. listCheckedOutBranches parses porcelain `branch ` lines
 *      b. isUpstreamGone / isContainedInDefaultBranch: correct classification
 *         and fail-safe (false, never throws) on any git error
 *      c. deleteBranch: correct invocation + idempotent swallow on failure
 *      d. probeRemoteRef (FOR-62): `git ls-remote --exit-code --heads origin
 *         <branch>` — exit status 2 (git's own "no matching ref" signal) →
 *         'gone'; a match → 'present'; ANY OTHER non-zero exit or thrown
 *         error (incl. one with no exit status at all) → 'probe-failed',
 *         NEVER 'gone' — the distinction is structural (the exit status),
 *         not inferred from empty stdout
 *   16. defaultWorktreeRemover — orphan-dir purge end-to-end (FOR-59)
 *      a. an orphan dir selected by planCleanup removes cleanly through the
 *         SAME two-phase remover pipeline as an ordinary worktree
 *
 * Section 10 is the one place THROUGH Section 11 that exercises the REAL
 * `defaultWorktreeRemover` (every other section through 11 uses the
 * injectable `WorktreeRemover` seam). It mocks `node:child_process` and
 * partially mocks `node:fs` — only `rmSync` is overridden, and its default
 * behaviour delegates to the real implementation, so a test only diverges
 * from real fs behaviour where it explicitly queues a one-shot
 * `mockImplementationOnce` throw. Section 12 (FOR-59) is the other place
 * that touches real child_process: it temporarily reconfigures the SAME
 * module-level `execFileSync` mock to delegate to the actual implementation
 * (see `asExecFileSyncMock`), restoring the `() => ''` default afterward —
 * needed because the toplevel-guard fix can only be proven against git's
 * own toplevel-resolution fallback, not a hand-built porcelain fixture.
 */

import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
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
  listAgentWorktrees,
  defaultBranchHygieneOps,
  listOrphanDirs,
  planOrphanSweep,
  executeOrphanSweep,
  sweepOrphanWorktrees,
  sweepOrphanBranches,
  defaultOrphanBranchSweepOps,
  type WorktreeEntry,
  type WorktreeRemover,
  type RedispatchCleanupOps,
  type BranchHygieneOps,
  type RemoteRefProbeResult,
  type BranchHygieneSkip,
  type OrphanDir,
  type OrphanRemover,
  type OrphanBranchSweepOps,
} from './worktree-cleanup';

// node:child_process is mocked module-wide so Section 10's real
// `defaultWorktreeRemover` calls don't shell out to a real `git`. Sections 12
// and 15 (FOR-59: the toplevel-guard + orphan classification) are the
// exception — they temporarily reconfigure this SAME mock's implementation to
// delegate to the real `execFileSync` (see `asExecFileSyncMock` below,
// mirroring `asRmSyncMock`'s `node:fs` technique), then restore the `() => ''`
// default in `afterEach`. Every other section leaves the default untouched.
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

/**
 * Type-erasing cast to reach vitest's mock methods on the mocked
 * `execFileSync` (FOR-59) — mirrors {@link asRmSyncMock}. `execFileSync`'s
 * real type is a complex overload set; every caller here only needs the
 * mock-control surface, so this narrows to exactly that rather than fighting
 * the overloads with `unknown[]` args.
 */
function asExecFileSyncMock(fn: typeof execFileSync): {
  mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
  mockReturnValue: (value: string) => void;
} {
  return fn as unknown as {
    mockImplementation: (impl: (...args: unknown[]) => unknown) => void;
    mockReturnValue: (value: string) => void;
  };
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
    expect(result.skipped).toEqual([{ ...dirty, reason: 'dirty' }]);
  });

  // ─── FOR-56: editor/harness junk classes (W12-F2) ─────────────────────────
  //
  // Live finding W12-F2 (docs/retros/2026-07-20-preflight-hardening-w12.md):
  // the FOR-45 purge only recognized individual Finder-junk FILE names, not
  // an entire editor/harness-owned DIRECTORY as disposable — a still-attached
  // VS Code extension host wrote `.vscode/settings.json` and a
  // `.claude/agents/<file>` remnant into worktrees post-agent, alongside a
  // NESTED `.DS_Store`, and the ENOTEMPTY retry kept failing on all five.
  describe('FOR-56: editor/harness junk-class hardening', () => {
    it('purges the exact W12 leftover shape (.vscode/settings.json + .claude/agents/<file> + a NESTED .DS_Store) and retries once — the worktree is removed cleanly', () => {
      const { root, worktreePath } = makeTempWorktree('agent-w12-leftovers');

      // .vscode/settings.json — whole `.vscode/` directory tree.
      mkdirSync(join(worktreePath, '.vscode'), { recursive: true });
      writeFileSync(join(worktreePath, '.vscode', 'settings.json'), '{}', 'utf-8');

      // .claude/agents/<file> — whole `.claude/` directory tree.
      mkdirSync(join(worktreePath, '.claude', 'agents'), { recursive: true });
      writeFileSync(
        join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'),
        'post-agent leftover',
        'utf-8',
      );

      // A `.DS_Store` NESTED inside an ordinary subdirectory (not at the
      // worktree root) — proves "nested junk directories, not only
      // top-level files" per the FOR-56 acceptance criteria.
      mkdirSync(join(worktreePath, 'nested', 'deeper'), { recursive: true });
      writeFileSync(
        join(worktreePath, 'nested', 'deeper', '.DS_Store'),
        'finder-debris',
        'utf-8',
      );

      // The first rmSync attempt simulates the live race: nothing is
      // actually deleted on this call.
      asRmSyncMock(rmSync).mockImplementationOnce(() => {
        throw makeEnotempty(worktreePath);
      });

      const remover = defaultWorktreeRemover(root);
      expect(() => remover.remove(worktreePath)).not.toThrow();

      // The retry (real rmSync, after the allowlisted-junk purge) removed
      // the whole tree, including the now-empty `nested/` directory.
      expect(existsSync(worktreePath)).toBe(false);

      // Step 2 (deregister) was still reached — the 2-step contract holds.
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['worktree', 'remove', worktreePath],
        expect.objectContaining({ cwd: root }),
      );
    });

    it('a worktree with .vscode/.claude junk AND a real top-level file is still removed once it reaches the remover — the purge never blocks an otherwise-successful retry', () => {
      // Documents the boundary this hardening deliberately does NOT change:
      // once a worktree has reached the remover at all (i.e. planCleanup
      // already decided it is git-clean), ordinary co-resident content is
      // torn down along with it as part of the full worktree teardown,
      // exactly like the pre-existing FOR-45 `real-file.txt` + `.DS_Store`
      // case above. The junk purge's only job is breaking the ENOTEMPTY
      // race — it never decides removal eligibility; that stays entirely in
      // planCleanup's `git status --porcelain` check (see the two tests
      // below, which pin the actual "must skip, never remove" guarantee at
      // the layer where it is actually enforced).
      const { root, worktreePath } = makeTempWorktree('agent-mixed-content');
      writeFileSync(join(worktreePath, 'real-file.txt'), 'hello', 'utf-8');
      mkdirSync(join(worktreePath, '.vscode'), { recursive: true });
      writeFileSync(join(worktreePath, '.vscode', 'settings.json'), '{}', 'utf-8');

      asRmSyncMock(rmSync).mockImplementationOnce(() => {
        throw makeEnotempty(worktreePath);
      });

      const remover = defaultWorktreeRemover(root);
      expect(() => remover.remove(worktreePath)).not.toThrow();
      expect(existsSync(worktreePath)).toBe(false);
    });

    it('the dirty-worktree guarantee is unchanged: a real file nested INSIDE .vscode/ or .claude/, alongside allowlisted junk, still means dirty:true → skipped, never removed', () => {
      // A worktree carrying real, uncommitted content nested inside an
      // otherwise-junk-shaped directory (e.g. a stray note dropped next to
      // `.vscode/settings.json`) is caught by git status upstream — dirty is
      // decided entirely in planCleanup, unaffected by JUNK_DIR_NAMES.
      const dirty: WorktreeEntry = {
        path: '/repo/.claude/worktrees/agent-real-file-nested-in-vscode',
        branch: 'wave/FOR-56-nested-real-file',
        head: 'abc1234abc1234abc1234abc1234abc1234abcd',
        dirty: true,
      };
      const plan = planCleanup([dirty]);
      expect(plan.selected).toHaveLength(0);
      expect(plan.skipped).toEqual([{ ...dirty, reason: 'dirty' }]);

      const remover = defaultWorktreeRemover('/repo');
      const result = executeCleanup(plan, { remover });
      expect(execFileSync).not.toHaveBeenCalled();
      expect(result.removed).toHaveLength(0);
      expect(result.skipped).toEqual([{ ...dirty, reason: 'dirty' }]);
    });

    it('the dirty-worktree guarantee is unchanged: a real file at the worktree TOP LEVEL, with allowlisted junk below it, still means dirty:true → skipped, never removed', () => {
      // Same guarantee, mirrored for a real file living beside (rather than
      // nested inside) the junk-allowlisted directories — allowlisted junk
      // and real files coexisting never overrides the dirty flag.
      const dirty: WorktreeEntry = {
        path: '/repo/.claude/worktrees/agent-real-file-top-level',
        branch: 'wave/FOR-56-top-level-real-file',
        head: 'abc1234abc1234abc1234abc1234abc1234abcd',
        dirty: true,
      };
      const plan = planCleanup([dirty]);
      expect(plan.selected).toHaveLength(0);
      expect(plan.skipped).toEqual([{ ...dirty, reason: 'dirty' }]);

      const remover = defaultWorktreeRemover('/repo');
      const result = executeCleanup(plan, { remover });
      expect(execFileSync).not.toHaveBeenCalled();
      expect(result.removed).toHaveLength(0);
      expect(result.skipped).toEqual([{ ...dirty, reason: 'dirty' }]);
    });
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
      // allowlisted-junk purge's own (real) deletion of `.DS_Store` in between.
      const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const mockedRmSync = asRmSyncMock(rmSync);
      // 1st top-level call: initial attempt — junk-shaped ENOTEMPTY.
      mockedRmSync.mockImplementationOnce(() => {
        throw makeEnotempty(worktreePath);
      });
      // The allowlisted-junk purge's own `.DS_Store` deletion — let it really happen.
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
      expect(message).toMatch(/allowlisted-junk/);
    });
  });
});

// ─── 12. listAgentWorktrees — toplevel-guarded orphan classification (FOR-59) ─
//
// W13 close finding: `git status --porcelain` invoked with `cwd` set to a
// deregistered/prunable worktree directory does not error — since
// `.claude/worktrees/<id>` sits INSIDE the parent checkout, git silently
// walks UP and resolves against the nearest ANCESTOR repository instead,
// reporting THAT repo's status. These tests reproduce the exact live shape
// with REAL git repos + REAL worktrees (a hand-built porcelain fixture cannot
// exercise git's own toplevel-resolution fallback), so — uniquely in this
// file — the module-level `execFileSync` mock is temporarily reconfigured to
// delegate to the ACTUAL implementation for the duration of each test here,
// then restored to the file's `() => ''` default in `afterEach`.
describe('listAgentWorktrees — toplevel-guarded orphan classification (FOR-59)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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

  /** Real `git`, bypassing the mock — used only for fixture SETUP in this section. */
  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Build a real repo with a real worktree nested under `.claude/worktrees/<name>`. */
  function makeMainWithWorktree(name: string): { mainRoot: string; worktreePath: string } {
    // Resolve symlinks (macOS's `/tmp` → `/private/tmp`) up front — git
    // itself always reports fully-resolved paths (`git worktree list`,
    // `git rev-parse --show-toplevel`), so building every downstream path
    // off an already-resolved root keeps string-equality assertions honest.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-for59-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    const relPath = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', relPath, '-b', `${name}/branch`], mainRoot);
    return { mainRoot, worktreePath: join(mainRoot, relPath) };
  }

  /**
   * Build a real repo + worktree, then DEREGISTER the worktree the way the
   * live W13 incident did: remove ONLY the worktree's own `.git` pointer
   * file, leaving its physical directory (and whatever junk/real content is
   * written into it afterward) on disk — the exact orphan shape.
   */
  function makeOrphanedWorktree(name: string): { mainRoot: string; orphanPath: string } {
    const { mainRoot, worktreePath } = makeMainWithWorktree(name);
    rmSync(join(worktreePath, '.git'), { force: true });
    return { mainRoot, orphanPath: worktreePath };
  }

  it('AC1: an orphan dir is classified from its OWN content, never the parent repo\'s — dirty stays false despite an unrelated untracked file at the parent root', () => {
    const { mainRoot, orphanPath } = makeOrphanedWorktree('wf_orphan-dirty-leak');
    writeFileSync(join(orphanPath, '.DS_Store'), 'finder-debris', 'utf-8');
    // The exact leak vector the W13 incident hit: an untracked file sitting
    // at the PARENT repo's root, which a toplevel-unguarded `git status`
    // would silently attribute to the orphan dir instead.
    writeFileSync(join(mainRoot, 'unrelated-untracked.txt'), 'noise', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(orphanPath);
    expect(result[0].dirty).toBe(false);
    expect(result[0].orphan).toBe(true);
  });

  it('AC2a: an orphan dir whose content is EXCLUSIVELY allowlisted junk is classified orphanAllJunk: true', () => {
    const { mainRoot, orphanPath } = makeOrphanedWorktree('wf_orphan-all-junk');
    writeFileSync(join(orphanPath, '.DS_Store'), 'finder-debris', 'utf-8');
    mkdirSync(join(orphanPath, '.vscode'), { recursive: true });
    writeFileSync(join(orphanPath, '.vscode', 'settings.json'), '{}', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].orphan).toBe(true);
    expect(result[0].orphanAllJunk).toBe(true);
  });

  it('AC2b: an orphan dir containing ANY real file is classified orphanAllJunk: false', () => {
    const { mainRoot, orphanPath } = makeOrphanedWorktree('wf_orphan-real-file');
    writeFileSync(join(orphanPath, '.DS_Store'), 'finder-debris', 'utf-8');
    writeFileSync(join(orphanPath, 'notes.txt'), 'do not lose this', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].orphan).toBe(true);
    expect(result[0].orphanAllJunk).toBe(false);
  });

  it('a JUNK_DIR_NAMES directory (.vscode/, .claude/) is an OPAQUE disposable unit for classification too — matches removeAllowlistedJunk\'s existing whole-subtree purge semantics, so the canonical W12/FOR-56 leftover shape (arbitrarily-named files under .vscode/.claude) still classifies orphanAllJunk: true', () => {
    const { mainRoot, orphanPath } = makeOrphanedWorktree('wf_orphan-junkdir-shape');
    mkdirSync(join(orphanPath, '.vscode'), { recursive: true });
    // `settings.json` matches NEITHER FINDER_JUNK_NAMES nor the AppleDouble
    // pattern by its own filename — it is classified as junk ONLY because
    // `.vscode/` itself is a JUNK_DIR_NAMES unit (identical to how
    // `removeAllowlistedJunk` purges it, per the FOR-56 W12 leftover shape).
    writeFileSync(join(orphanPath, '.vscode', 'settings.json'), '{}', 'utf-8');
    mkdirSync(join(orphanPath, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(orphanPath, '.claude', 'agents', 'wave-reviewer.md'),
      'post-agent leftover',
      'utf-8',
    );

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].orphanAllJunk).toBe(true);
  });

  it('an empty orphan dir (no content at all) is vacuously all-junk: true', () => {
    const { mainRoot, orphanPath } = makeOrphanedWorktree('wf_orphan-empty');
    void orphanPath; // no writes — directory is empty aside from the removed `.git`

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].orphanAllJunk).toBe(true);
  });

  it('AC5 regression: an ORDINARY registered worktree with a real uncommitted change is still correctly classified dirty:true via its OWN status', () => {
    const { mainRoot, worktreePath } = makeMainWithWorktree('wf_normal-dirty');
    writeFileSync(join(worktreePath, 'uncommitted.txt'), 'wip', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(worktreePath);
    expect(result[0].dirty).toBe(true);
    expect(result[0].orphan).toBeFalsy();
  });

  it('AC5 regression: an ORDINARY registered+clean worktree is still correctly classified dirty:false, orphan unset', () => {
    const { mainRoot, worktreePath } = makeMainWithWorktree('wf_normal-clean');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(worktreePath);
    expect(result[0].dirty).toBe(false);
    expect(result[0].orphan).toBeFalsy();
  });
});

// ─── 13. planCleanup — orphan-dir routing + skip reasons (FOR-59) ────────────

describe('planCleanup — orphan-dir routing + skip reasons (FOR-59)', () => {
  const baseOrphan: WorktreeEntry = {
    path: '/repo/.claude/worktrees/wf_orphan-a',
    branch: 'wf_orphan-a/branch',
    head: 'aaaa1234aaaa1234aaaa1234aaaa1234aaaa1234',
    dirty: false,
  };

  it('an orphan dir with orphanAllJunk: true is SELECTED for removal (never skipped)', () => {
    const plan = planCleanup([{ ...baseOrphan, orphan: true, orphanAllJunk: true }]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it('an orphan dir with orphanAllJunk: false is SKIPPED with reason "orphan-with-real-files"', () => {
    const plan = planCleanup([{ ...baseOrphan, orphan: true, orphanAllJunk: false }]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('orphan-with-real-files');
  });

  it('a locked worktree is SKIPPED with reason "locked" — even when clean — and never reaches selected', () => {
    const locked: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-locked-1',
      branch: 'wave/FOR-10-locked',
      head: 'bbbb1234bbbb1234bbbb1234bbbb1234bbbb1234',
      dirty: false,
      locked: true,
    };
    const plan = planCleanup([locked]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('locked');
  });

  it('a dirty (non-orphan, non-locked) worktree is SKIPPED with reason "dirty"', () => {
    const dirty: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-dirty-1',
      branch: 'wave/FOR-59-dirty',
      head: 'cccc1234cccc1234cccc1234cccc1234cccc1234',
      dirty: true,
    };
    const plan = planCleanup([dirty]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('dirty');
  });

  it('every skipped[] entry carries a reason, across a mixed batch (dirty + locked + orphan-with-real-files + one clean)', () => {
    const dirty: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-d',
      branch: 'wave/d',
      head: '1'.repeat(40),
      dirty: true,
    };
    const locked: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-l',
      branch: 'wave/l',
      head: '2'.repeat(40),
      dirty: false,
      locked: true,
    };
    const orphanReal: WorktreeEntry = {
      ...baseOrphan,
      path: '/repo/.claude/worktrees/wf_o',
      orphan: true,
      orphanAllJunk: false,
    };
    const clean: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-c',
      branch: 'wave/c',
      head: '3'.repeat(40),
      dirty: false,
    };

    const plan = planCleanup([dirty, locked, orphanReal, clean]);

    expect(plan.selected.map((w) => w.path)).toEqual([clean.path]);
    expect(plan.skipped).toHaveLength(3);
    for (const s of plan.skipped) {
      expect(typeof s.reason).toBe('string');
      expect(s.reason).toBeTruthy();
    }
    expect(plan.skipped.find((s) => s.path === dirty.path)?.reason).toBe('dirty');
    expect(plan.skipped.find((s) => s.path === locked.path)?.reason).toBe('locked');
    expect(plan.skipped.find((s) => s.path === orphanReal.path)?.reason).toBe(
      'orphan-with-real-files',
    );
  });

  it('orphan routing is keyed on `orphan`/`orphanAllJunk`, not on the (untrusted) `dirty` flag — orphan+allJunk selects regardless', () => {
    const plan = planCleanup([{ ...baseOrphan, dirty: false, orphan: true, orphanAllJunk: true }]);
    expect(plan.selected).toHaveLength(1);
  });
});

// ─── 14. executeCleanup — local branch hygiene (FOR-59) ──────────────────────

describe('executeCleanup — local branch hygiene (FOR-59)', () => {
  /** Build a fake BranchHygieneOps backed by vitest spies, with configurable classification. */
  function fakeBranchHygiene(opts?: {
    checkedOut?: Set<string>;
    goneUpstream?: Set<string>;
    containedInDefault?: Set<string>;
    remoteGone?: Set<string>;
    remoteProbeFailedFor?: Map<string, string>;
  }): {
    ops: BranchHygieneOps;
    deleteSpy: ReturnType<typeof vi.fn>;
    probeRemoteRefSpy: ReturnType<typeof vi.fn>;
  } {
    const deleteSpy = vi.fn();
    const probeRemoteRefSpy = vi.fn(
      (b: string): RemoteRefProbeResult => {
        if (opts?.remoteGone?.has(b)) return { status: 'gone' };
        const failReason = opts?.remoteProbeFailedFor?.get(b);
        if (failReason !== undefined) return { status: 'probe-failed', reason: failReason };
        return { status: 'present' };
      },
    );
    const ops: BranchHygieneOps = {
      listCheckedOutBranches: () => opts?.checkedOut ?? new Set<string>(),
      isUpstreamGone: (b) => opts?.goneUpstream?.has(b) ?? false,
      isContainedInDefaultBranch: (b) => opts?.containedInDefault?.has(b) ?? false,
      probeRemoteRef: probeRemoteRefSpy,
      deleteBranch: deleteSpy,
    };
    return { ops, deleteSpy, probeRemoteRefSpy };
  }

  const wfWorktree: WorktreeEntry = {
    path: '/repo/.claude/worktrees/wf_5b3073fb-abc-1',
    branch: 'wave/FOR-59-fix',
    head: 'a'.repeat(40),
    dirty: false,
  };

  it('rule (a): the harness throwaway branch (worktree-wf_*) is ALWAYS force-deleted after a successful removal', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene();
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).toHaveBeenCalledWith('worktree-wf_5b3073fb-abc-1');
    expect(result.branchesDeleted).toContain('worktree-wf_5b3073fb-abc-1');
  });

  it("rule (b): the worktree's own wave/* branch is force-deleted when its upstream is gone", () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      goneUpstream: new Set([wfWorktree.branch as string]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).toHaveBeenCalledWith(wfWorktree.branch);
    expect(result.branchesDeleted).toContain(wfWorktree.branch);
  });

  it("rule (b): the worktree's own wave/* branch is force-deleted when its tip is contained in the default branch", () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      containedInDefault: new Set([wfWorktree.branch as string]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).toHaveBeenCalledWith(wfWorktree.branch);
  });

  it('rule (b) refusal: a wave/* branch with NEITHER upstream-gone NOR contained-in-default evidence is left alone — real, unlanded work', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene(); // no evidence configured
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).not.toHaveBeenCalledWith(wfWorktree.branch);
    expect(result.branchesDeleted).not.toContain(wfWorktree.branch);
    // The throwaway branch is still deleted independently — rule (a) is
    // unconditional and does not depend on rule (b)'s outcome.
    expect(deleteSpy).toHaveBeenCalledWith('worktree-wf_5b3073fb-abc-1');
  });

  it('rule (b), FOR-62: the remote-ref-gone signal alone is sufficient — deletes even with NO upstream-gone/tip-contained evidence (the no-`-u`-push, squash-merge reality)', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy, probeRemoteRefSpy } = fakeBranchHygiene({
      remoteGone: new Set([wfWorktree.branch as string]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(probeRemoteRefSpy).toHaveBeenCalledWith(wfWorktree.branch);
    expect(deleteSpy).toHaveBeenCalledWith(wfWorktree.branch);
    expect(result.branchesDeleted).toContain(wfWorktree.branch);
  });

  it('rule (b), FOR-62: a probe FAILURE (network/transport error, non-zero exit) is NEVER read as gone — the branch is left alone, never deleted', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy, probeRemoteRefSpy } = fakeBranchHygiene({
      remoteProbeFailedFor: new Map([[wfWorktree.branch as string, 'network error: could not resolve host']]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(probeRemoteRefSpy).toHaveBeenCalledWith(wfWorktree.branch);
    expect(deleteSpy).not.toHaveBeenCalledWith(wfWorktree.branch);
    expect(result.branchesDeleted).not.toContain(wfWorktree.branch);
  });

  it('rule (b), FOR-62 coordinator resolution: a probe FAILURE is threaded onto the caller-visible `CleanupResult.branchHygieneSkipped` with a machine-readable reason — not only the ops-level RemoteRefProbeResult', () => {
    const { remover } = fakeRemover();
    const { ops } = fakeBranchHygiene({
      remoteProbeFailedFor: new Map([[wfWorktree.branch as string, 'network error: could not resolve host']]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    const expected: BranchHygieneSkip = {
      branch: wfWorktree.branch as string,
      reason: 'branch-probe-failed',
      detail: 'network error: could not resolve host',
    };
    expect(result.branchHygieneSkipped).toEqual([expected]);
  });

  it('rule (b), FOR-62: a probe that authoritatively finds the remote ref still present is not evidence — branch left alone, and NOT recorded in branchHygieneSkipped (a confirmed "present" is not ambiguous)', () => {
    const { remover } = fakeRemover();
    // Default fakeBranchHygiene() (no remoteGone/remoteProbeFailedFor) already
    // resolves every branch to { status: 'present' } — assert that explicitly
    // as its own scenario, distinct from the "probe failed" case above.
    const { ops, deleteSpy, probeRemoteRefSpy } = fakeBranchHygiene();
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(probeRemoteRefSpy).toHaveBeenCalledWith(wfWorktree.branch);
    expect(deleteSpy).not.toHaveBeenCalledWith(wfWorktree.branch);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('rule (b), FOR-62 coordinator resolution: when EARLY merge evidence (upstream-gone) already deletes the branch, the probe is never reached and branchHygieneSkipped stays empty', () => {
    const { remover } = fakeRemover();
    const { ops, probeRemoteRefSpy } = fakeBranchHygiene({
      goneUpstream: new Set([wfWorktree.branch as string]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(probeRemoteRefSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toContain(wfWorktree.branch);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('rule (c) safety floor: a branch checked out in ANOTHER live worktree is NEVER deleted, for either rule — even with merge evidence present', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      checkedOut: new Set(['worktree-wf_5b3073fb-abc-1', wfWorktree.branch as string]),
      goneUpstream: new Set([wfWorktree.branch as string]), // would otherwise qualify
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('rule (c) safety floor extends to the FOR-62 remote-ref-gone signal too: a branch checked out elsewhere is never deleted even when the remote ref is confirmed gone', () => {
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      checkedOut: new Set(['worktree-wf_5b3073fb-abc-1', wfWorktree.branch as string]),
      remoteGone: new Set([wfWorktree.branch as string]), // would otherwise qualify
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('an agent-* (non-wf_) worktree never attempts the throwaway-branch rule — its derived name is not wf_-shaped', () => {
    const agentWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/agent-abc123',
      branch: 'wave/FOR-59-agent',
      head: 'b'.repeat(40),
      dirty: false,
    };
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      goneUpstream: new Set([agentWorktree.branch as string]),
    });
    const plan = { selected: [agentWorktree], skipped: [] };

    executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).not.toHaveBeenCalledWith('worktree-agent-abc123');
    expect(deleteSpy).toHaveBeenCalledWith(agentWorktree.branch);
  });

  it('a non-"wave/"-prefixed branch (foreign naming convention) is never touched by rule (b), even with full merge evidence', () => {
    const oddWorktree: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_odd-1',
      branch: 'not-a-wave-branch',
      head: 'c'.repeat(40),
      dirty: false,
    };
    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene({
      goneUpstream: new Set(['not-a-wave-branch']),
      containedInDefault: new Set(['not-a-wave-branch']),
    });
    const plan = { selected: [oddWorktree], skipped: [] };

    executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).not.toHaveBeenCalledWith('not-a-wave-branch');
  });

  it('branch hygiene NEVER runs for a failed removal — an errored remover leaves the branch(es) in place', () => {
    const { remover } = fakeRemover({ failFor: [wfWorktree.path] });
    const { ops, deleteSpy } = fakeBranchHygiene({
      goneUpstream: new Set([wfWorktree.branch as string]),
    });
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(result.errors).toHaveLength(1);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('skipBranchHygiene: true opts out entirely — no BranchHygieneOps method is ever invoked', () => {
    const { remover } = fakeRemover();
    const listSpy = vi.fn(() => new Set<string>());
    const ops: BranchHygieneOps = {
      listCheckedOutBranches: listSpy,
      isUpstreamGone: () => true,
      isContainedInDefaultBranch: () => true,
      probeRemoteRef: () => ({ status: 'gone' }),
      deleteBranch: vi.fn(),
    };
    const plan = { selected: [wfWorktree], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      branchHygiene: ops,
      skipBranchHygiene: true,
    });

    expect(listSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('an orphan-dir purge (not just an ordinary removal) also triggers branch hygiene', () => {
    const orphanWt: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_orphan-purge-1',
      branch: 'wf_orphan-purge-1/branch',
      head: 'd'.repeat(40),
      dirty: false,
      orphan: true,
      orphanAllJunk: true,
    };
    const plan = planCleanup([orphanWt]);
    expect(plan.selected).toHaveLength(1);

    const { remover } = fakeRemover();
    const { ops, deleteSpy } = fakeBranchHygiene();

    executeCleanup(plan, { remover, branchHygiene: ops });

    expect(deleteSpy).toHaveBeenCalledWith('worktree-wf_orphan-purge-1');
  });

  it('never invokes branch hygiene at all when the selected set is empty (idempotent no-op, unchanged from pre-FOR-59)', () => {
    const { remover } = fakeRemover();
    const listSpy = vi.fn(() => new Set<string>());
    const ops: BranchHygieneOps = {
      listCheckedOutBranches: listSpy,
      isUpstreamGone: () => false,
      isContainedInDefaultBranch: () => false,
      probeRemoteRef: () => ({ status: 'present' }),
      deleteBranch: vi.fn(),
    };
    const plan = { selected: [], skipped: [] };

    const result = executeCleanup(plan, { remover, branchHygiene: ops });

    expect(listSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });
});

// ─── 15. defaultBranchHygieneOps — real-git command shape (FOR-59) ───────────

describe('defaultBranchHygieneOps — real-git command shape (FOR-59)', () => {
  afterEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
  });

  it('listCheckedOutBranches parses "branch " lines from `git worktree list --porcelain`, stripping refs/heads/', () => {
    asExecFileSyncMock(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'worktree' && cmdArgs[1] === 'list') {
        return [
          'worktree /repo',
          'HEAD ' + 'a'.repeat(40),
          'branch refs/heads/main',
          '',
          'worktree /repo/.claude/worktrees/wf_x',
          'HEAD ' + 'b'.repeat(40),
          'branch refs/heads/wave/FOR-59-x',
          '',
        ].join('\n');
      }
      return '';
    });

    const ops = defaultBranchHygieneOps('/repo');
    const checkedOut = ops.listCheckedOutBranches();

    expect(checkedOut.has('main')).toBe(true);
    expect(checkedOut.has('wave/FOR-59-x')).toBe(true);
    expect(checkedOut.has('refs/heads/main')).toBe(false);
  });

  it('isUpstreamGone: true only when the upstream track marker is exactly "[gone]"', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '[gone]\n');
    expect(defaultBranchHygieneOps('/repo').isUpstreamGone('wave/x')).toBe(true);
  });

  it('isUpstreamGone: false when there is no upstream configured at all (empty output)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    expect(defaultBranchHygieneOps('/repo').isUpstreamGone('wave/x')).toBe(false);
  });

  it('isUpstreamGone: false — never throws — when the underlying git command itself fails', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error('fatal: not a valid ref');
    });
    const ops = defaultBranchHygieneOps('/repo');
    expect(() => ops.isUpstreamGone('wave/x')).not.toThrow();
    expect(ops.isUpstreamGone('wave/x')).toBe(false);
  });

  it('isContainedInDefaultBranch: true when `git merge-base --is-ancestor` exits 0', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    expect(
      defaultBranchHygieneOps('/repo').isContainedInDefaultBranch('wave/x', 'main'),
    ).toBe(true);
  });

  it('isContainedInDefaultBranch: false — never throws — when `git merge-base --is-ancestor` fails (not an ancestor, or an invalid ref)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error('not an ancestor');
    });
    const ops = defaultBranchHygieneOps('/repo');
    expect(() => ops.isContainedInDefaultBranch('wave/x', 'main')).not.toThrow();
    expect(ops.isContainedInDefaultBranch('wave/x', 'main')).toBe(false);
  });

  it('deleteBranch: swallows a failure (already-absent branch) — idempotent no-op, never throws', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error("error: branch 'wave/x' not found");
    });
    expect(() => defaultBranchHygieneOps('/repo').deleteBranch('wave/x')).not.toThrow();
  });

  it('deleteBranch: invokes `git branch -D <branch>` against the given repoRoot', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    defaultBranchHygieneOps('/repo').deleteBranch('wave/x');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'wave/x'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  // ── probeRemoteRef (FOR-62) — the gone-vs-failure distinction is carried by
  //    git's own `--exit-code` exit status, never inferred from empty stdout ──

  it('probeRemoteRef: invokes `git ls-remote --exit-code --heads origin <branch>` against the given repoRoot', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    defaultBranchHygieneOps('/repo').probeRemoteRef('wave/x');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--exit-code', '--heads', 'origin', 'wave/x'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('probeRemoteRef: { status: "present" } on ANY non-throwing (exit 0) invocation, even with empty stdout — "gone" is NEVER inferred from stdout length (FOR-62 iter-2: real `--exit-code` never exits 0 with empty output; a no-match is always the structural exit-2 case below)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    expect(defaultBranchHygieneOps('/repo').probeRemoteRef('wave/x')).toEqual({
      status: 'present',
    });
  });

  it('probeRemoteRef: { status: "gone" } when the underlying command exits with git\'s own "no matching ref" status (2)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      const err = new Error('') as NodeJS.ErrnoException & { status?: number };
      err.status = 2;
      throw err;
    });
    expect(defaultBranchHygieneOps('/repo').probeRemoteRef('wave/x')).toEqual({
      status: 'gone',
    });
  });

  it('probeRemoteRef: { status: "present" } when the command succeeds and reports a matching ref', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(
      () => 'a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4\trefs/heads/wave/x\n',
    );
    expect(defaultBranchHygieneOps('/repo').probeRemoteRef('wave/x')).toEqual({
      status: 'present',
    });
  });

  it('probeRemoteRef: { status: "probe-failed", reason } — NEVER "gone" — on a non-2 non-zero exit (a real transport/auth failure, structurally distinct from git\'s "no match" exit code)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      const err = new Error('fatal: unable to access remote: Could not resolve host') as NodeJS.ErrnoException & {
        status?: number;
      };
      err.status = 128;
      throw err;
    });
    const result = defaultBranchHygieneOps('/repo').probeRemoteRef('wave/x');
    expect(result.status).toBe('probe-failed');
    expect((result as { status: 'probe-failed'; reason: string }).reason).toContain(
      'Could not resolve host',
    );
  });

  it('probeRemoteRef: { status: "probe-failed" } — never throws, never "gone" — when the thrown error carries no exit status at all (e.g. git itself missing, a timeout)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error('spawnSync git ENOENT');
    });
    const ops = defaultBranchHygieneOps('/repo');
    expect(() => ops.probeRemoteRef('wave/x')).not.toThrow();
    expect(ops.probeRemoteRef('wave/x').status).toBe('probe-failed');
  });
});

// ─── 16. defaultWorktreeRemover — orphan-dir purge end-to-end (FOR-59) ───────
//
// Confirms the SAME two-phase remover that already handles ordinary
// worktrees (FOR-34/45/56 above) also cleanly removes an orphan directory
// `planCleanup` selected — no special-casing needed: `rmSync` does not care
// whether the directory is a registered git worktree, and `git worktree
// remove` on an already-physically-gone path succeeds cleanly (live-verified
// git behaviour — see the file-level doc comment).
describe('defaultWorktreeRemover — orphan-dir purge end-to-end (FOR-59)', () => {
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

  it('an orphan dir selected by planCleanup (orphanAllJunk: true) is removed cleanly through the SAME remover pipeline as an ordinary worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-orphan-e2e-'));
    tempRoots.push(root);
    const orphanPath = join(root, 'wf_orphan-e2e-1');
    mkdirSync(orphanPath, { recursive: true });
    writeFileSync(join(orphanPath, '.DS_Store'), 'finder-debris', 'utf-8');

    const orphanEntry: WorktreeEntry = {
      path: orphanPath,
      branch: 'wf_orphan-e2e-1/branch',
      head: 'e'.repeat(40),
      dirty: false,
      orphan: true,
      orphanAllJunk: true,
    };
    const plan = planCleanup([orphanEntry]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);

    const remover = defaultWorktreeRemover(root);
    const result = executeCleanup(plan, { remover, skipBranchHygiene: true });

    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(orphanPath)).toBe(false);
  });
});

// ─── 17. executeCleanup — deregistered-but-not-deleted (ENOTEMPTY) class ─────
//    made STRUCTURAL via verify-after-write (FOR-67 — consumer KW-F6 + W15)
//
// A remover's non-throwing return is not trusted on its own: after every
// successful `remover.remove()`, the worktree's own directory is re-checked on
// disk (the injectable `pathExists`, default `fs.existsSync`). A directory
// STILL present is the "deregistered-but-not-deleted" class — `git worktree
// remove` forgot the worktree (so `git worktree list` goes quiet) while a
// Finder/editor-host race left the physical directory behind. It is recorded in
// `deregisteredNotDeleted` instead of `removed`, so it stops depending on a
// careful human's on-disk check.

describe('executeCleanup — deregistered-but-not-deleted (FOR-67)', () => {
  const cleanA: WorktreeEntry = {
    path: AGENT_PATH_A,
    branch: 'wave/FOR-67-a',
    head: 'a'.repeat(40),
    dirty: false,
  };
  const cleanB: WorktreeEntry = {
    path: AGENT_PATH_B,
    branch: 'wave/FOR-67-b',
    head: 'b'.repeat(40),
    dirty: false,
  };

  it('a remover that reports success but leaves the dir on disk → deregisteredNotDeleted, NOT removed', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      // The verify probe reports the dir is STILL there after "removal".
      pathExists: () => true,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(0);
    expect(result.deregisteredNotDeleted).toHaveLength(1);
    expect(result.deregisteredNotDeleted[0].path).toBe(AGENT_PATH_A);
    expect(result.errors).toHaveLength(0);
  });

  it('a remover whose dir is confirmed gone → removed, deregisteredNotDeleted empty (ordinary path)', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      pathExists: () => false,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(AGENT_PATH_A);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
  });

  it('splits a mixed batch: one confirmed-gone → removed, one still-present → deregisteredNotDeleted', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA, cleanB], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      // AGENT_PATH_A stays on disk; AGENT_PATH_B is confirmed gone.
      pathExists: (p) => p === AGENT_PATH_A,
      skipBranchHygiene: true,
    });

    expect(result.removed.map((w) => w.path)).toEqual([AGENT_PATH_B]);
    expect(result.deregisteredNotDeleted.map((w) => w.path)).toEqual([AGENT_PATH_A]);
    expect(result.errors).toHaveLength(0);
  });

  it('a deregistered-but-not-deleted entry is NEVER handed to local-branch hygiene', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };
    const deleteBranch = vi.fn();
    const branchHygiene: BranchHygieneOps = {
      listCheckedOutBranches: () => new Set<string>(),
      isUpstreamGone: () => true, // would delete if it ran
      isContainedInDefaultBranch: () => false,
      probeRemoteRef: () => ({ status: 'gone' }) as RemoteRefProbeResult,
      deleteBranch,
    };

    const result = executeCleanup(plan, {
      remover,
      pathExists: () => true, // still on disk → incomplete removal
      branchHygiene,
    });

    expect(result.deregisteredNotDeleted).toHaveLength(1);
    expect(result.branchesDeleted).toHaveLength(0);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('the default pathExists (existsSync) treats a non-existent fixture path as removed — backward-compatible', () => {
    // AGENT_PATH_A is a synthetic path that never existed on disk, so the real
    // existsSync default returns false → the pre-FOR-67 `removed` classification.
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, { remover, skipBranchHygiene: true });

    expect(result.removed).toHaveLength(1);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
  });
});

// ─── 18. Orphan sweep — planOrphanSweep + executeOrphanSweep (FOR-67) ─────────

describe('planOrphanSweep (FOR-67)', () => {
  it('an all-junk (or empty) orphan is SELECTED for removal', () => {
    const plan = planOrphanSweep([{ path: '/r/.claude/worktrees/wf_x', allJunk: true }]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
  });

  it('an orphan holding a real file is SKIPPED with reason "orphan-with-real-files"', () => {
    const plan = planOrphanSweep([{ path: '/r/.claude/worktrees/wf_y', allJunk: false }]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('orphan-with-real-files');
  });

  it('splits a mixed batch by allJunk', () => {
    const plan = planOrphanSweep([
      { path: '/r/.claude/worktrees/wf_a', allJunk: true },
      { path: '/r/.claude/worktrees/wf_b', allJunk: false },
      { path: '/r/.claude/worktrees/agent-c', allJunk: true },
    ]);
    expect(plan.selected.map((o) => o.path)).toEqual([
      '/r/.claude/worktrees/wf_a',
      '/r/.claude/worktrees/agent-c',
    ]);
    expect(plan.skipped.map((o) => o.path)).toEqual(['/r/.claude/worktrees/wf_b']);
  });
});

describe('executeOrphanSweep (FOR-67)', () => {
  /** Fake OrphanRemover backed by a vitest spy, optionally failing for named paths. */
  function fakeOrphanRemover(opts?: { failFor?: string[] }): {
    remover: OrphanRemover;
    removeSpy: ReturnType<typeof vi.fn>;
  } {
    const failFor = new Set(opts?.failFor ?? []);
    const removeSpy = vi.fn((path: string) => {
      if (failFor.has(path)) throw new Error(`rm failed for ${path}`);
    });
    return { remover: { remove: removeSpy }, removeSpy };
  }

  const junkA: OrphanDir = { path: '/r/.claude/worktrees/wf_a', allJunk: true };
  const realB: OrphanDir = { path: '/r/.claude/worktrees/wf_b', allJunk: false, reason: 'orphan-with-real-files' };

  it('invokes the remover once per selected orphan; skipped pass through untouched', () => {
    const { remover, removeSpy } = fakeOrphanRemover();
    const plan = { selected: [junkA], skipped: [realB] };

    const result = executeOrphanSweep(plan, { remover, pathExists: () => false });

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(junkA.path);
    expect(result.removed.map((o) => o.path)).toEqual([junkA.path]);
    expect(result.skipped).toEqual([realB]);
    expect(result.errors).toHaveLength(0);
  });

  it('a throwing remover lands the orphan in errors, never removed', () => {
    const { remover } = fakeOrphanRemover({ failFor: [junkA.path] });
    const plan = { selected: [junkA], skipped: [] };

    const result = executeOrphanSweep(plan, { remover, pathExists: () => false });

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(junkA.path);
  });

  it('verify-after-write: a dir still present after a "successful" remove → errors, not removed', () => {
    const { remover } = fakeOrphanRemover();
    const plan = { selected: [junkA], skipped: [] };

    const result = executeOrphanSweep(plan, { remover, pathExists: () => true });

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/still present after removal/);
  });

  it('is idempotent: empty selected set → zero remover calls, empty result', () => {
    const { remover, removeSpy } = fakeOrphanRemover();
    const plan = { selected: [], skipped: [] };

    const result = executeOrphanSweep(plan, { remover });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── 19. Orphan sweep — listOrphanDirs + sweepOrphanWorktrees, real git/fs ────
//    (FOR-67 — consumer KW-F6 + W15 findings)
//
// The FOR-67 orphan class is a physical directory UNDER the worktrees root that
// `git worktree list` does not know about at ALL — a deregistered-but-not-
// deleted leftover, or an EMPTY leftover from an earlier wave that --wave
// scoping correctly ignores but nothing ever reports. This section builds the
// exact shape with a REAL repo + a REAL registered worktree (so the
// registered-exclusion runs against genuine `git worktree list` output),
// delegating the module-level execFileSync mock to real git for setup + the
// under-test listing, exactly like Section 12.
describe('orphan sweep — listOrphanDirs + sweepOrphanWorktrees, real git/fs (FOR-67)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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

  /**
   * Build a real repo with ONE registered worktree, plus arbitrary orphan
   * (unregistered) directories placed directly under `.claude/worktrees/` that
   * git never knew about — the exact leftover shape.
   */
  function makeRepoWithOrphans(): {
    mainRoot: string;
    registeredPath: string;
    worktreesRoot: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-for67-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    const worktreesRoot = join(mainRoot, '.claude', 'worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    // One genuinely-registered live worktree — must NEVER be swept.
    const relReg = join('.claude', 'worktrees', 'wf_registered-live');
    realGit(['worktree', 'add', '-q', relReg, '-b', 'wf_registered-live/branch'], mainRoot);
    return { mainRoot, registeredPath: join(mainRoot, relReg), worktreesRoot };
  }

  it('listOrphanDirs finds unregistered prefixed dirs, classifies junk vs real, excludes the registered worktree and non-prefixed scratch dirs', () => {
    const { mainRoot, registeredPath, worktreesRoot } = makeRepoWithOrphans();

    // Empty leftover from an earlier wave.
    const emptyOrphan = join(worktreesRoot, 'wf_orphan-empty');
    mkdirSync(emptyOrphan, { recursive: true });
    // Deregistered-but-not-deleted junk leftover.
    const junkOrphan = join(worktreesRoot, 'agent-orphan-junk');
    mkdirSync(join(junkOrphan, '.vscode'), { recursive: true });
    writeFileSync(join(junkOrphan, '.vscode', 'settings.json'), '{}', 'utf-8');
    writeFileSync(join(junkOrphan, '.DS_Store'), 'debris', 'utf-8');
    // Orphan holding real work — must be reported but never selected.
    const realOrphan = join(worktreesRoot, 'wf_orphan-real');
    mkdirSync(realOrphan, { recursive: true });
    writeFileSync(join(realOrphan, 'notes.txt'), 'do not lose', 'utf-8');
    // Human scratch dir without a recognized prefix — never swept.
    const scratch = join(worktreesRoot, 'my-scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'stuff.txt'), 'keep', 'utf-8');

    const found = listOrphanDirs(mainRoot);
    const byPath = new Map(found.map((o) => [o.path, o]));

    expect(byPath.get(emptyOrphan)?.allJunk).toBe(true);
    expect(byPath.get(junkOrphan)?.allJunk).toBe(true);
    expect(byPath.get(realOrphan)?.allJunk).toBe(false);
    // Registered worktree + non-prefixed scratch dir are NOT orphans.
    expect(byPath.has(registeredPath)).toBe(false);
    expect(byPath.has(scratch)).toBe(false);
    expect(found).toHaveLength(3);
  });

  it('sweepOrphanWorktrees removes empty + all-junk orphans, keeps the real-file orphan, and never touches the registered worktree', () => {
    const { mainRoot, registeredPath, worktreesRoot } = makeRepoWithOrphans();

    const emptyOrphan = join(worktreesRoot, 'wf_orphan-empty');
    mkdirSync(emptyOrphan, { recursive: true });
    const junkOrphan = join(worktreesRoot, 'agent-orphan-junk');
    mkdirSync(junkOrphan, { recursive: true });
    writeFileSync(join(junkOrphan, '.DS_Store'), 'debris', 'utf-8');
    const realOrphan = join(worktreesRoot, 'wf_orphan-real');
    mkdirSync(realOrphan, { recursive: true });
    writeFileSync(join(realOrphan, 'notes.txt'), 'do not lose', 'utf-8');

    const result = sweepOrphanWorktrees({ repoRoot: mainRoot });

    expect(result.errors).toHaveLength(0);
    expect(result.removed.map((o) => o.path).sort()).toEqual(
      [emptyOrphan, junkOrphan].sort(),
    );
    expect(result.skipped.map((o) => o.path)).toEqual([realOrphan]);
    expect(result.skipped[0].reason).toBe('orphan-with-real-files');

    // On-disk truth: removed dirs are gone; kept dirs remain.
    expect(existsSync(emptyOrphan)).toBe(false);
    expect(existsSync(junkOrphan)).toBe(false);
    expect(existsSync(realOrphan)).toBe(true);
    expect(existsSync(registeredPath)).toBe(true);
  });

  it('is idempotent: a re-run after everything is swept reports nothing to do', () => {
    const { mainRoot, worktreesRoot } = makeRepoWithOrphans();
    const emptyOrphan = join(worktreesRoot, 'wf_orphan-empty');
    mkdirSync(emptyOrphan, { recursive: true });

    const first = sweepOrphanWorktrees({ repoRoot: mainRoot });
    expect(first.removed).toHaveLength(1);

    const second = sweepOrphanWorktrees({ repoRoot: mainRoot });
    expect(second.removed).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });

  it('a worktrees root that does not exist yet (no wave ever ran) → empty sweep, no throw', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-for67-empty-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);

    const result = sweepOrphanWorktrees({ repoRoot: mainRoot });
    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── 20. Standalone orphaned-branch sweep — sweepOrphanBranches (FOR-72) ──────
//
// The counterpart to the orphan-DIRECTORY sweep (Section 18/19): the same
// --orphans flag, but for LOCAL branches orphaned WITHOUT a worktree-removal
// event (the manual force-remove ENOTEMPTY fallback leaves them behind — W15-F1,
// 3× reproduced). These pure tests inject a fake OrphanBranchSweepOps so the two
// signals + the safety floor are exercised with zero real git/fs.
describe('sweepOrphanBranches — standalone orphaned-branch sweep (FOR-72)', () => {
  /** Build a fake OrphanBranchSweepOps backed by vitest spies, fully configurable. */
  function fakeOrphanBranchOps(opts?: {
    localBranches?: string[];
    currentBranch?: string | null;
    checkedOut?: Set<string>;
    liveWorktreeBasenames?: Set<string>;
    remoteGone?: Set<string>;
    remoteProbeFailedFor?: Map<string, string>;
  }): {
    ops: OrphanBranchSweepOps;
    deleteSpy: ReturnType<typeof vi.fn>;
    probeSpy: ReturnType<typeof vi.fn>;
  } {
    const deleteSpy = vi.fn();
    const probeSpy = vi.fn((b: string): RemoteRefProbeResult => {
      if (opts?.remoteGone?.has(b)) return { status: 'gone' };
      const fail = opts?.remoteProbeFailedFor?.get(b);
      if (fail !== undefined) return { status: 'probe-failed', reason: fail };
      return { status: 'present' };
    });
    const ops: OrphanBranchSweepOps = {
      listLocalBranches: () => opts?.localBranches ?? [],
      currentBranch: () => opts?.currentBranch ?? null,
      listCheckedOutBranches: () => opts?.checkedOut ?? new Set<string>(),
      listLiveWorktreeBasenames: () => opts?.liveWorktreeBasenames ?? new Set<string>(),
      probeRemoteRef: probeSpy,
      deleteBranch: deleteSpy,
    };
    return { ops, deleteSpy, probeSpy };
  }

  // ── Signal 1: wave/* branch whose remote ref is gone ──────────────────────

  it('signal 1: a wave/* branch whose remote ref is authoritatively gone is force-deleted — WITHOUT any worktree-removal event', () => {
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: ['wave/FOR-72-x'],
      remoteGone: new Set(['wave/FOR-72-x']),
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).toHaveBeenCalledWith('wave/FOR-72-x');
    expect(result.branchesDeleted).toEqual(['wave/FOR-72-x']);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('signal 1: a wave/* branch whose remote ref is still PRESENT (real unlanded work) is left alone — not deleted, not recorded as a skip', () => {
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: ['wave/FOR-72-unlanded'],
      // default probe → 'present'
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('signal 1: a wave/* branch whose remote-ref probe FAILED is NEVER deleted, and is recorded in branchHygieneSkipped with a machine-readable reason + detail', () => {
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: ['wave/FOR-72-flaky'],
      remoteProbeFailedFor: new Map([['wave/FOR-72-flaky', 'network error: could not resolve host']]),
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
    const expected: BranchHygieneSkip = {
      branch: 'wave/FOR-72-flaky',
      reason: 'branch-probe-failed',
      detail: 'network error: could not resolve host',
    };
    expect(result.branchHygieneSkipped).toEqual([expected]);
  });

  // ── Signal 2: harness worktree-wf_* base branch whose worktree is gone ─────

  it('signal 2: a harness worktree-wf_* base branch whose worktree is neither registered nor on disk is force-deleted', () => {
    const { ops, deleteSpy, probeSpy } = fakeOrphanBranchOps({
      localBranches: ['worktree-wf_run9-3'],
      liveWorktreeBasenames: new Set<string>(), // wf_run9-3 absent → worktree gone
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).toHaveBeenCalledWith('worktree-wf_run9-3');
    expect(result.branchesDeleted).toEqual(['worktree-wf_run9-3']);
    // A worktree-* branch is never remote-ref-probed.
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('signal 2: a harness worktree-wf_* branch whose worktree is STILL LIVE (basename registered/on disk) is left alone — even though it is not itself checked out', () => {
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: ['worktree-wf_live-1'],
      liveWorktreeBasenames: new Set(['wf_live-1']), // worktree still present
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('signal 2 is restricted to the wf_ shape: a bare worktree-* branch (not wf_) is never touched, even with no matching worktree', () => {
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: ['worktree-notes', 'worktree-scratch'],
      liveWorktreeBasenames: new Set<string>(), // no matching worktrees
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  // ── Safety floor (rule c, made explicit) ──────────────────────────────────

  it('safety floor: the CURRENT branch is never deleted, even when it would otherwise match a signal', () => {
    const { ops, deleteSpy, probeSpy } = fakeOrphanBranchOps({
      localBranches: ['wave/FOR-72-current'],
      currentBranch: 'wave/FOR-72-current',
      remoteGone: new Set(['wave/FOR-72-current']), // would otherwise qualify
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled(); // never even probed
    expect(result.branchesDeleted).toEqual([]);
  });

  it('safety floor: a branch checked out in ANY live worktree is never deleted (or probed), for either signal', () => {
    const { ops, deleteSpy, probeSpy } = fakeOrphanBranchOps({
      localBranches: ['wave/FOR-72-elsewhere', 'worktree-wf_busy-2'],
      checkedOut: new Set(['wave/FOR-72-elsewhere', 'worktree-wf_busy-2']),
      remoteGone: new Set(['wave/FOR-72-elsewhere']), // would otherwise qualify
      liveWorktreeBasenames: new Set<string>(), // worktree-wf_busy-2 would otherwise qualify
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('a branch matching NEITHER signal (main, feature/*, a plain branch) is never touched and never probed', () => {
    const { ops, deleteSpy, probeSpy } = fakeOrphanBranchOps({
      localBranches: ['main', 'feature/keep', 'develop'],
      remoteGone: new Set(['feature/keep']), // irrelevant: not a wave/* branch
    });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('empty local-branch set → empty result, nothing probed or deleted (idempotent no-op)', () => {
    const { ops, deleteSpy, probeSpy } = fakeOrphanBranchOps({ localBranches: [] });
    const result = sweepOrphanBranches({ ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
    expect(result.branchHygieneSkipped).toEqual([]);
  });

  it('the W15-F1 accumulation shape: 7 gone wave/* + 7 orphaned worktree-wf_* branches all swept in ONE standalone run, while the current branch and a still-live worktree branch survive', () => {
    const waveGone = Array.from({ length: 7 }, (_, i) => `wave/FOR-${60 + i}-x`);
    const worktreeOrphans = Array.from({ length: 7 }, (_, i) => `worktree-wf_run${i}-1`);
    const { ops, deleteSpy } = fakeOrphanBranchOps({
      localBranches: [
        'main', // current + neither signal
        'wave/FOR-live', // checked out in a live worktree
        'worktree-wf_live-9', // its worktree is still live
        ...waveGone,
        ...worktreeOrphans,
      ],
      currentBranch: 'main',
      checkedOut: new Set(['main', 'wave/FOR-live']),
      liveWorktreeBasenames: new Set(['wf_live-9']),
      remoteGone: new Set(waveGone),
    });
    const result = sweepOrphanBranches({ ops });
    expect(result.branchesDeleted.sort()).toEqual([...waveGone, ...worktreeOrphans].sort());
    expect(deleteSpy).not.toHaveBeenCalledWith('main');
    expect(deleteSpy).not.toHaveBeenCalledWith('wave/FOR-live');
    expect(deleteSpy).not.toHaveBeenCalledWith('worktree-wf_live-9');
    expect(result.branchHygieneSkipped).toEqual([]);
  });
});

// ─── 21. defaultOrphanBranchSweepOps — real-git command shape (FOR-72) ────────

describe('defaultOrphanBranchSweepOps — real-git command shape (FOR-72)', () => {
  afterEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
  });

  it('listLocalBranches invokes `git for-each-ref --format=%(refname:short) refs/heads/` and parses newline-split branch names (trimming, dropping empties)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'for-each-ref') {
        return 'main\nwave/FOR-72-x\nworktree-wf_run9-3\n';
      }
      return '';
    });
    const ops = defaultOrphanBranchSweepOps('/repo', [...DEFAULT_AGENT_PATH_MARKERS]);
    expect(ops.listLocalBranches()).toEqual(['main', 'wave/FOR-72-x', 'worktree-wf_run9-3']);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('currentBranch invokes `git symbolic-ref --quiet --short HEAD` and returns the trimmed branch name', () => {
    asExecFileSyncMock(execFileSync).mockImplementation((...args: unknown[]) => {
      const cmdArgs = args[1] as string[];
      if (cmdArgs[0] === 'symbolic-ref') return 'wave/FOR-72-here\n';
      return '';
    });
    const ops = defaultOrphanBranchSweepOps('/repo');
    expect(ops.currentBranch()).toBe('wave/FOR-72-here');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('currentBranch returns null on a detached HEAD (symbolic-ref errors → empty output)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error('fatal: ref HEAD is not a symbolic ref');
    });
    expect(defaultOrphanBranchSweepOps('/repo').currentBranch()).toBeNull();
  });

  it('probeRemoteRef REUSES the FOR-62 signal verbatim — `git ls-remote --exit-code --heads origin <branch>`', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    defaultOrphanBranchSweepOps('/repo').probeRemoteRef('wave/x');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--exit-code', '--heads', 'origin', 'wave/x'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('deleteBranch REUSES `git branch -D <branch>` and is idempotent (swallows an already-absent failure)', () => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => {
      throw new Error("error: branch 'wave/x' not found");
    });
    expect(() => defaultOrphanBranchSweepOps('/repo').deleteBranch('wave/x')).not.toThrow();
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'wave/x'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});

// ─── 22. Standalone orphaned-branch sweep — real git/fs end-to-end (FOR-72) ───
//
// Builds a REAL repo with a REAL registered worktree and a REAL (local, bare)
// origin so the remote-ref-gone signal is exercised against genuine
// `git ls-remote --exit-code` behaviour (exit 2 = no matching ref = gone), and
// signal 2 + the safety floor run against real `git worktree list`/branch state.
describe('sweepOrphanBranches — real git/fs end-to-end (FOR-72)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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
    const out = realExecFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
      cwd: mainRoot,
      encoding: 'utf-8',
    }) as string;
    return new Set(out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0));
  }

  it('sweeps a gone-remote wave/* branch and an orphaned worktree-wf_* branch, while preserving the current branch, a live worktree branch, its still-live throwaway branch, and a neither-signal branch', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-for72-')));
    tempRoots.push(root);

    // A real bare origin so `git ls-remote --exit-code` can authoritatively
    // report a missing ref (exit 2) rather than a transport failure.
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

    // A live, registered worktree on wave/FOR-live at basename wf_live-1.
    const relLive = join('.claude', 'worktrees', 'wf_live-1');
    realGit(['worktree', 'add', '-q', relLive, '-b', 'wave/FOR-live'], mainRoot);

    // Orphaned + preserved local branches, all pointing at the initial commit.
    realGit(['branch', 'wave/FOR-gone'], mainRoot); // never pushed → remote ref gone
    realGit(['branch', 'worktree-wf_orphan-9'], mainRoot); // no such worktree
    realGit(['branch', 'worktree-wf_live-1'], mainRoot); // its worktree IS live
    realGit(['branch', 'feature/keep'], mainRoot); // neither signal

    const before = localBranches(mainRoot);
    expect(before).toContain('wave/FOR-gone');
    expect(before).toContain('worktree-wf_orphan-9');

    const result = sweepOrphanBranches({ repoRoot: mainRoot });

    expect(result.branchesDeleted.sort()).toEqual(
      ['wave/FOR-gone', 'worktree-wf_orphan-9'].sort(),
    );
    expect(result.branchHygieneSkipped).toEqual([]);

    const after = localBranches(mainRoot);
    // Deleted:
    expect(after.has('wave/FOR-gone')).toBe(false);
    expect(after.has('worktree-wf_orphan-9')).toBe(false);
    // Preserved:
    expect(after.has('main')).toBe(true); // current branch
    expect(after.has('wave/FOR-live')).toBe(true); // checked out in a live worktree
    expect(after.has('worktree-wf_live-1')).toBe(true); // worktree still live
    expect(after.has('feature/keep')).toBe(true); // neither signal
  });

  it('is idempotent: a second run after everything orphaned is swept deletes nothing more', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-for72-idem-')));
    tempRoots.push(root);
    const originPath = join(root, 'origin.git');
    realGit(['init', '-q', '--bare', originPath], root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    realGit(['branch', '-M', 'main'], mainRoot);
    realGit(['remote', 'add', 'origin', originPath], mainRoot);
    realGit(['branch', 'wave/FOR-gone'], mainRoot);

    const first = sweepOrphanBranches({ repoRoot: mainRoot });
    expect(first.branchesDeleted).toEqual(['wave/FOR-gone']);

    const second = sweepOrphanBranches({ repoRoot: mainRoot });
    expect(second.branchesDeleted).toEqual([]);
    expect(second.branchHygieneSkipped).toEqual([]);
  });
});
