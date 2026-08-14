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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
  readdirSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWaveConfig } from './wave-config';
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
  planOrphanBranchSweep,
  executeOrphanBranchSweep,
  defaultOrphanBranchSweepOps,
  normalizeDisposableNames,
  SCRIBE_SCRATCH_RELATIVE_DIR,
  listScribeScratchEntries,
  planScribeScratchSweep,
  sweepScribeScratch,
  defaultScratchRemover,
  type ScratchRemover,
  listDetachedScratchpadWorktrees,
  planDetachedScratchpadSweep,
  sweepDetachedScratchpadWorktrees,
  checkWorktreeCountAdvisory,
  WORKTREE_COUNT_ADVISORY_THRESHOLD,
  measureExecArgumentBytes,
  checkCommandLineSizeAdvisory,
  COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
  MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
  type ExecArgumentMeasurement,
  type CommandLineSizeAdvisory,
  type WorktreeEntry,
  type WorktreeRemover,
  type RedispatchCleanupOps,
  type BranchHygieneOps,
  type RemoteRefProbeResult,
  type BranchHygieneSkip,
  type OrphanDir,
  type OrphanRemover,
  type OrphanBranchSweepOps,
  type OrphanBranchSweepPlan,
} from './worktree-cleanup';
// The SAME five names, imported through the PACKAGE ROOT rather than the module
// file directly — proves the barrel actually re-exports the detached-sweep trio,
// the advisory function and the threshold constant (ADR-0028's explicit
// named-export style), aliased to avoid colliding with the direct-module imports
// above. Mirrors reviewer-verdict-schema.spec.ts's `…FromRoot` convention.
import {
  listDetachedScratchpadWorktrees as listDetachedScratchpadWorktreesFromRoot,
  planDetachedScratchpadSweep as planDetachedScratchpadSweepFromRoot,
  sweepDetachedScratchpadWorktrees as sweepDetachedScratchpadWorktreesFromRoot,
  checkWorktreeCountAdvisory as checkWorktreeCountAdvisoryFromRoot,
  WORKTREE_COUNT_ADVISORY_THRESHOLD as WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT,
  type DetachedSweepOptions as DetachedSweepOptionsFromRoot,
  type WorktreeCountAdvisory as WorktreeCountAdvisoryFromRoot,
  type WorktreeCountAdvisoryOptions as WorktreeCountAdvisoryOptionsFromRoot,
  type SkipReason as SkipReasonFromRoot,
} from './index';

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

/**
 * Type-erasing cast to reach vitest's mock methods on the mocked `rmSync`.
 * `mockImplementation` (issue #528) is the PERSISTENT sibling of
 * `mockImplementationOnce` — every existing caller passes a zero-arg
 * callback, which remains assignable to the widened `(...args: unknown[])`
 * signature below (a JS callback may always ignore extra arguments), so this
 * widening is backward-compatible with every pre-#528 call site.
 */
function asRmSyncMock(fn: typeof rmSync): {
  mockImplementationOnce: (impl: (...args: unknown[]) => void) => void;
  mockImplementation: (impl: (...args: unknown[]) => void) => void;
} {
  return fn as unknown as {
    mockImplementationOnce: (impl: (...args: unknown[]) => void) => void;
    mockImplementation: (impl: (...args: unknown[]) => void) => void;
  };
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
    // issue #304: `force` is always threaded explicitly — `false` here since
    // `cleanA` is plainly clean (never `dirtyAllJunk`/`orphanAllJunk`).
    expect(removeSpy).toHaveBeenCalledWith(AGENT_PATH_A, { force: false });
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
    // issue #304: `force` is always threaded explicitly — `false` here since
    // `wfClean` is plainly clean (never `dirtyAllJunk`/`orphanAllJunk`).
    expect(removeSpy).toHaveBeenCalledWith(WF_PATH_CLEAN, { force: false });
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
    // A real worktree always carries its own `.git` gitfile — present here so
    // these fixtures exercise the ORDINARY (git-present) removal path rather
    // than the FOR-86 half-removed-recovery branch (see section 23 below for
    // fixtures that deliberately omit it).
    writeFileSync(join(worktreePath, '.git'), 'gitdir: ../fake-admin/worktrees/fixture\n', 'utf-8');
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

  /**
   * A consumer repo that has NOT gitignored the harness's own files — which is
   * the default, since nothing tells a consumer to (issue #111). This repo does
   * ignore them, so the defect is invisible here; pinning `core.excludesFile`
   * to nothing keeps the fixture from inheriting whatever the developer's
   * global excludes happen to say, which is what made this bug hard to see.
   */
  function makeConsumerWorktree(name: string): { mainRoot: string; worktreePath: string } {
    const made = makeMainWithWorktree(name);
    realGit(['config', 'core.excludesFile', '/dev/null'], made.mainRoot);
    return made;
  }

  it('a registered worktree dirty with ONLY harness-written files reports dirty:true AND dirtyAllJunk:true', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_junk-only');
    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.claude', 'settings.local.json'),
      '{"permissions":{}}',
      'utf-8',
    );
    writeFileSync(join(worktreePath, '.DS_Store'), 'finder', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(true);
  });

  it('a registered worktree dirty with a real file ALONGSIDE harness files reports dirtyAllJunk:false', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_junk-plus-real');
    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    writeFileSync(join(worktreePath, '.claude', 'settings.local.json'), '{}', 'utf-8');
    writeFileSync(join(worktreePath, 'uncommitted.txt'), 'wip', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
  });

  // The safety boundary this fix must not cross. flotilla's own skills live
  // under `.claude/skills/`, so an uncommitted change there is a Worker's work.
  // The orphan classifier treats all of `.claude/` as one disposable unit; the
  // dirty classifier must not, or removing the worktree destroys the work.
  it('uncommitted work under .claude/skills/ is NOT disposable — dirtyAllJunk:false', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_skill-edit');
    mkdirSync(join(worktreePath, '.claude', 'skills', 'wave-plan'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.claude', 'skills', 'wave-plan', 'SKILL.md'),
      '# a skill a Worker is midway through writing',
      'utf-8',
    );
    writeFileSync(join(worktreePath, '.claude', 'settings.local.json'), '{}', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
  });

  it('a MODIFIED tracked file under .claude/ is NOT disposable — dirtyAllJunk:false', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_tracked-settings');
    mkdirSync(join(worktreePath, '.claude'), { recursive: true });
    writeFileSync(join(worktreePath, '.claude', 'settings.json'), '{"env":{}}', 'utf-8');
    realGit(['add', '.claude/settings.json'], worktreePath);
    realGit(['commit', '-q', '-m', 'track settings'], worktreePath);
    writeFileSync(join(worktreePath, '.claude', 'settings.json'), '{"env":{"X":"1"}}', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
  });

  // ── issue #142: harness-denied-path DELETIONS widen dirtyAllJunk ──────────
  //
  // The live shape: a sandboxed harness denies git write access to specific
  // repository paths, so a fresh agent-worktree checkout cannot materialize
  // the tracked files there — `git status` reports every one of them
  // DELETED, nothing else divergent, before the dispatched agent has touched
  // anything. Modeled here as closely as a hermetic fixture can: commit the
  // files, then `rmSync` them directly (never `git rm`) — the exact
  // "tracked, unstaged deletion" shape a denied write produces, regardless of
  // what actually denied the write.

  it('AC1/AC3 (issue #142): tracked files under harness-denied paths (.claude/agents, .claude/skills) reported DELETED — the exact observed harness-checkout shape — classifies dirtyAllJunk:true, making the worktree removable', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_harness-denied-deletion');
    mkdirSync(join(worktreePath, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(worktreePath, '.claude', 'skills', 'wave-plan'), { recursive: true });
    writeFileSync(
      join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'),
      'agent config, committed',
      'utf-8',
    );
    writeFileSync(
      join(worktreePath, '.claude', 'skills', 'wave-plan', 'SKILL.md'),
      '# a skill, committed',
      'utf-8',
    );
    realGit(
      ['add', '.claude/agents/wave-reviewer.md', '.claude/skills/wave-plan/SKILL.md'],
      worktreePath,
    );
    realGit(['commit', '-q', '-m', 'track harness-denied paths'], worktreePath);

    // The harness never materializes these on checkout — modeled here as a
    // plain, unstaged deletion from disk: the index still holds the exact
    // committed blob, nothing was ever `git rm`'d.
    rmSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), { force: true });
    rmSync(join(worktreePath, '.claude', 'skills', 'wave-plan', 'SKILL.md'), { force: true });

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(true);
  });

  // AC2/AC3's sibling: the recognition above is keyed on the PATH being a
  // fixed, narrow harness-denied allowlist — never on a blanket "a deletion
  // never counts as work" rule. A deleted file OUTSIDE that allowlist (an
  // ordinary tracked source file) must still block removal.
  it('AC2/AC3 (issue #142): a deleted SOURCE file (outside any harness-denied path) still blocks removal — dirtyAllJunk:false', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_source-deletion-blocks');
    writeFileSync(join(worktreePath, 'src-file.ts'), 'export const x = 1;\n', 'utf-8');
    realGit(['add', 'src-file.ts'], worktreePath);
    realGit(['commit', '-q', '-m', 'track a source file'], worktreePath);

    rmSync(join(worktreePath, 'src-file.ts'), { force: true });

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
  });

  // ── issue #150: the live pair this harness actually denies ────────────────
  //
  // A `git worktree add` run in THIS repo under this harness's sandbox is
  // refused on exactly two tracked paths — `.claude/agents/wave-reviewer.md`
  // and `.vscode/settings.json` — so a real dispatched worktree comes up
  // carrying BOTH as ` D`. `.vscode` was missing from HARNESS_DENIED_DIRS, and
  // one unrecognized path is enough for `isStatusExclusivelyDisposable` to
  // fail: the issue #142 carve-out never fired in this repo at all.

  it('AC1 (issue #150): the EXACT live denied pair — a ` D` under .claude/agents AND a ` D` .vscode/settings.json — classifies dirtyAllJunk:true', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_live-denied-pair');
    mkdirSync(join(worktreePath, '.claude', 'agents'), { recursive: true });
    mkdirSync(join(worktreePath, '.vscode'), { recursive: true });
    writeFileSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), 'agent\n', 'utf-8');
    writeFileSync(join(worktreePath, '.vscode', 'settings.json'), '{"files.exclude":{}}', 'utf-8');
    realGit(['add', '.claude/agents/wave-reviewer.md', '.vscode/settings.json'], worktreePath);
    realGit(['commit', '-q', '-m', 'track the two paths this sandbox denies'], worktreePath);

    rmSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), { force: true });
    rmSync(join(worktreePath, '.vscode', 'settings.json'), { force: true });

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(true);
  });

  // The same deletion-only discipline the `.claude/` entries already carry:
  // `.vscode` widened the DELETION half only. Editing editor config is work.
  it('a MODIFIED (not deleted) .vscode/settings.json is still NOT disposable — the issue #150 widening is deletion-only', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_vscode-modified');
    mkdirSync(join(worktreePath, '.vscode'), { recursive: true });
    writeFileSync(join(worktreePath, '.vscode', 'settings.json'), '{}', 'utf-8');
    realGit(['add', '.vscode/settings.json'], worktreePath);
    realGit(['commit', '-q', '-m', 'track editor config'], worktreePath);
    writeFileSync(join(worktreePath, '.vscode', 'settings.json'), '{"editor.tabSize":2}', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
  });

  // A MODIFICATION (never a deletion) under a harness-denied path is real
  // task work in this dogfood repo (`.claude/skills/` holds flotilla's own
  // product content) — the deletion-only gate must not swallow this shape.
  it('a MODIFIED (not deleted) tracked file under a harness-denied path (.claude/agents) is still NOT disposable — dirtyAllJunk:false', () => {
    const { mainRoot, worktreePath } = makeConsumerWorktree('wf_agents-modified');
    mkdirSync(join(worktreePath, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), 'v1', 'utf-8');
    realGit(['add', '.claude/agents/wave-reviewer.md'], worktreePath);
    realGit(['commit', '-q', '-m', 'track agents/'], worktreePath);
    writeFileSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), 'v2', 'utf-8');

    const result = listAgentWorktrees(mainRoot);

    expect(result).toHaveLength(1);
    expect(result[0].dirty).toBe(true);
    expect(result[0].dirtyAllJunk).toBe(false);
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

// ─── 13b. planCleanup — junk-only dirt on a REGISTERED worktree (issue #111) ──

describe('planCleanup — junk-only dirt on a registered worktree (issue #111)', () => {
  const registered: WorktreeEntry = {
    path: '/repo/.claude/worktrees/wf_harness-touched',
    branch: 'wave/111-junk-only',
    head: 'dddd1234dddd1234dddd1234dddd1234dddd1234',
    dirty: true,
  };

  it('a registered worktree dirty with NOTHING BUT allowlisted junk is SELECTED, not skipped', () => {
    const plan = planCleanup([{ ...registered, dirtyAllJunk: true }]);
    expect(plan.selected).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);
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
      // Zero-delay retry pause (FOR-84): the bounded one-shot retry fires here
      // (still on disk after the re-attempt), so keep the suite from sleeping.
      retryPause: () => {},
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
      retryPause: () => {}, // zero-delay (FOR-84): A retries once, still on disk.
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
      retryPause: () => {}, // zero-delay (FOR-84): retries once, still on disk.
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

// ─── 17b. executeCleanup — errored-yet-still-listed (ENOTEMPTY) class ─────────
//    made STRUCTURAL via a throw-path still-listed probe (FOR-73 — W18-F1)
//
// A THIRD form of the ENOTEMPTY family, distinct from both `removed` (confirmed
// gone) and `deregisteredNotDeleted` (a NON-throwing return whose directory
// survives). Wave 18's close hit the case where the remover THREW yet
// `git worktree list` still fully lists the worktree afterwards (as prunable)
// with the directory on disk. On the throw path, `executeCleanup` probes the
// injectable `stillListed` seam (default: a `git worktree list` membership
// check): still listed → recorded in its own `erroredStillListed` class (never
// the generic `errors`, and — like deregisteredNotDeleted — never handed to
// branch hygiene); genuinely no longer listed → stays in `errors`, unchanged.

describe('executeCleanup — errored-yet-still-listed (FOR-73)', () => {
  const cleanA: WorktreeEntry = {
    path: AGENT_PATH_A,
    branch: 'wave/FOR-73-a',
    head: 'a'.repeat(40),
    dirty: false,
  };
  const cleanB: WorktreeEntry = {
    path: AGENT_PATH_B,
    branch: 'wave/FOR-73-b',
    head: 'b'.repeat(40),
    dirty: false,
  };

  it('a removal that THROWS while git STILL lists the worktree → erroredStillListed, NOT errors', () => {
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A] });
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      // git still lists it afterwards (prunable, directory on disk).
      stillListed: () => true,
      // Zero-delay retry pause (FOR-84): the bounded one-shot retry fires here
      // (throws-still-listed on the re-attempt too), so keep the suite fast.
      retryPause: () => {},
      skipBranchHygiene: true,
    });

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].path).toBe(AGENT_PATH_A);
    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
  });

  it('a removal that THROWS with the worktree NO LONGER listed → stays in errors (no reclassification of genuine failures)', () => {
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A] });
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      // genuine failure — git no longer lists the worktree afterwards.
      stillListed: () => false,
      skipBranchHygiene: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(AGENT_PATH_A);
    expect(result.erroredStillListed).toHaveLength(0);
  });

  it('splits a mixed batch of throwing removals: still-listed → erroredStillListed, gone → errors', () => {
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A, AGENT_PATH_B] });
    const plan = { selected: [cleanA, cleanB], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      // A is still listed; B is genuinely gone from the list.
      stillListed: (p) => p === AGENT_PATH_A,
      retryPause: () => {}, // zero-delay (FOR-84): A retries once (still listed).
      skipBranchHygiene: true,
    });

    expect(result.erroredStillListed.map((w) => w.path)).toEqual([AGENT_PATH_A]);
    expect(result.errors.map((e) => e.path)).toEqual([AGENT_PATH_B]);
    expect(result.removed).toHaveLength(0);
  });

  it('an erroredStillListed entry is NEVER handed to local-branch hygiene', () => {
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A] });
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
      stillListed: () => true, // still listed → incomplete removal
      retryPause: () => {}, // zero-delay (FOR-84): retries once, still listed.
      branchHygiene,
    });

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.branchesDeleted).toHaveLength(0);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('the default stillListed probe (module-mocked git → empty worktree list) keeps a genuine throw in errors — backward-compatible', () => {
    // execFileSync is mocked module-wide to return '' → `git worktree list` is
    // empty → the default probe reports the worktree NOT listed, so a throwing
    // removal stays in `errors` exactly as before FOR-73 (no injected seam).
    const { remover } = fakeRemover({ failFor: [AGENT_PATH_A] });
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, { remover, skipBranchHygiene: true });

    expect(result.errors).toHaveLength(1);
    expect(result.erroredStillListed).toHaveLength(0);
  });
});

// ─── 17c. executeCleanup — bounded retry before classifying (FOR-84 — W22-F1) ─
//
// The two INCOMPLETE ENOTEMPTY-family outcomes — `deregisteredNotDeleted` (a
// non-throwing return whose directory survives the on-disk re-check) and
// `erroredStillListed` (a throwing removal git still lists) — had become the
// per-wave normal case, driven by a TRANSIENT OS race (Finder re-dropping
// `.DS_Store` mid-removal, Spotlight, a stale LSP). A transient race wants a
// bounded RETRY, not a force flag: `executeCleanup` now gives every ENOTEMPTY-
// family entry exactly ONE re-attempt — re-purge the allowlisted junk, pause
// (injectable; zero-delay in specs), retry the removal, re-probe — BEFORE
// classifying. A removal that only succeeds via the retry is `removed` with an
// additive `retried: true` marker; whatever survives the retry keeps today's
// classification and never reaches branch hygiene. The retry is bounded at one,
// never a loop; a genuine failure (throw + not still listed) never enters it.

describe('executeCleanup — bounded retry (FOR-84)', () => {
  const NOOP_PAUSE = () => {};

  const cleanA: WorktreeEntry = {
    path: AGENT_PATH_A,
    branch: 'wave/FOR-84-a',
    head: 'a'.repeat(40),
    dirty: false,
  };
  const cleanB: WorktreeEntry = {
    path: AGENT_PATH_B,
    branch: 'wave/FOR-84-b',
    head: 'b'.repeat(40),
    dirty: false,
  };

  /** A remover that THROWS on its first N calls, then succeeds — models a race that clears. */
  function throwThenSucceedRemover(throwTimes: number): {
    remover: WorktreeRemover;
    removeSpy: ReturnType<typeof vi.fn>;
  } {
    let calls = 0;
    const removeSpy = vi.fn((path: string) => {
      calls += 1;
      if (calls <= throwTimes) {
        throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
      }
    });
    return { remover: { remove: removeSpy }, removeSpy };
  }

  it('deregisteredNotDeleted on the first attempt, then GONE on the retry → removed with retried:true', () => {
    const { remover, removeSpy } = fakeRemover(); // never throws
    const plan = { selected: [cleanA], skipped: [] };
    // Dir survives the first probe, is gone after the retry's re-purge.
    let probes = 0;
    const pathExists = () => {
      probes += 1;
      return probes === 1;
    };
    const purgeJunk = vi.fn();

    const result = executeCleanup(plan, {
      remover,
      pathExists,
      purgeJunk,
      retryPause: NOOP_PAUSE,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].path).toBe(AGENT_PATH_A);
    expect(result.removed[0].retried).toBe(true);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
    // Exactly one re-attempt: two remover calls, one re-purge.
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(purgeJunk).toHaveBeenCalledTimes(1);
    expect(purgeJunk).toHaveBeenCalledWith(AGENT_PATH_A);
  });

  it('erroredStillListed on the first attempt, then succeeds on the retry → removed with retried:true', () => {
    const { remover, removeSpy } = throwThenSucceedRemover(1); // throws once, then OK
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      stillListed: () => true, // first (throwing) attempt is still listed
      pathExists: () => false, // second (succeeding) attempt is confirmed gone
      retryPause: NOOP_PAUSE,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].retried).toBe(true);
    expect(result.erroredStillListed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  it('a first-try removal is NOT retried and carries NO retried marker', () => {
    const { remover, removeSpy } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };
    const purgeJunk = vi.fn();
    const retryPause = vi.fn();

    const result = executeCleanup(plan, {
      remover,
      pathExists: () => false, // confirmed gone on the first probe
      purgeJunk,
      retryPause,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].retried).toBeUndefined();
    // No retry machinery ran at all on the ordinary path.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(purgeJunk).not.toHaveBeenCalled();
    expect(retryPause).not.toHaveBeenCalled();
  });

  it('still deregisteredNotDeleted AFTER the retry → classified deregisteredNotDeleted, NO marker, bounded at ONE re-attempt', () => {
    const { remover, removeSpy } = fakeRemover(); // never throws
    const plan = { selected: [cleanA], skipped: [] };
    const purgeJunk = vi.fn();

    const result = executeCleanup(plan, {
      remover,
      pathExists: () => true, // survives BOTH probes
      purgeJunk,
      retryPause: NOOP_PAUSE,
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(0);
    expect(result.deregisteredNotDeleted).toHaveLength(1);
    expect(result.deregisteredNotDeleted[0].path).toBe(AGENT_PATH_A);
    // The classified entry carries no marker (only removed entries do).
    expect(result.deregisteredNotDeleted[0].retried).toBeUndefined();
    // Bounded at ONE retry: exactly two removals, one re-purge — never a loop.
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(purgeJunk).toHaveBeenCalledTimes(1);
  });

  it('still erroredStillListed AFTER the retry → classified erroredStillListed, bounded at ONE re-attempt', () => {
    const { remover, removeSpy } = throwThenSucceedRemover(2); // throws on both attempts
    const plan = { selected: [cleanA], skipped: [] };

    const result = executeCleanup(plan, {
      remover,
      stillListed: () => true, // still listed after every throw
      retryPause: NOOP_PAUSE,
      skipBranchHygiene: true,
    });

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].path).toBe(AGENT_PATH_A);
    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    // Bounded at ONE retry: exactly two removals, never a loop.
    expect(removeSpy).toHaveBeenCalledTimes(2);
  });

  it('a genuine failure (throw + NOT still listed) never enters the retry — first-try errors, no re-purge/pause', () => {
    const { remover, removeSpy } = throwThenSucceedRemover(1);
    const plan = { selected: [cleanA], skipped: [] };
    const purgeJunk = vi.fn();
    const retryPause = vi.fn();

    const result = executeCleanup(plan, {
      remover,
      stillListed: () => false, // genuine failure — git no longer lists it
      purgeJunk,
      retryPause,
      skipBranchHygiene: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe(AGENT_PATH_A);
    expect(result.erroredStillListed).toHaveLength(0);
    // No retry for a genuine failure: one call, no re-purge, no pause.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(purgeJunk).not.toHaveBeenCalled();
    expect(retryPause).not.toHaveBeenCalled();
  });

  it('re-purges the allowlisted junk BEFORE the re-attempt (order: purge → pause → retry removal)', () => {
    const order: string[] = [];
    let calls = 0;
    const remover: WorktreeRemover = {
      remove: (path: string) => {
        calls += 1;
        order.push(`remove#${calls}`);
        if (calls === 1) {
          throw new Error(`ENOTEMPTY: directory not empty, rmdir '${path}'`);
        }
      },
    };
    const plan = { selected: [cleanA], skipped: [] };

    executeCleanup(plan, {
      remover,
      stillListed: () => true,
      pathExists: () => false,
      purgeJunk: () => order.push('purge'),
      retryPause: () => order.push('pause'),
      skipBranchHygiene: true,
    });

    // First removal, then re-purge, then pause, then the single re-attempt.
    expect(order).toEqual(['remove#1', 'purge', 'pause', 'remove#2']);
  });

  it('a retry-converted removal DOES reach local-branch hygiene (it is a clean removal)', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };
    let probes = 0;
    const pathExists = () => {
      probes += 1;
      return probes === 1; // survives first probe, gone after the retry
    };
    const deleteBranch = vi.fn();
    const branchHygiene: BranchHygieneOps = {
      listCheckedOutBranches: () => new Set<string>(),
      isUpstreamGone: () => false,
      isContainedInDefaultBranch: () => false,
      probeRemoteRef: () => ({ status: 'gone' }) as RemoteRefProbeResult,
      deleteBranch,
    };

    const result = executeCleanup(plan, {
      remover,
      pathExists,
      retryPause: NOOP_PAUSE,
      branchHygiene,
    });

    expect(result.removed[0].retried).toBe(true);
    // remote-ref-gone evidence → the wave/* branch is deleted for the converted removal.
    expect(deleteBranch).toHaveBeenCalledWith('wave/FOR-84-a');
    expect(result.branchesDeleted).toContain('wave/FOR-84-a');
  });

  it('an entry still incomplete after the retry is NEVER handed to local-branch hygiene', () => {
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
      pathExists: () => true, // survives both probes → stays incomplete
      retryPause: NOOP_PAUSE,
      branchHygiene,
    });

    expect(result.deregisteredNotDeleted).toHaveLength(1);
    expect(result.branchesDeleted).toHaveLength(0);
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('splits a batch: one first-try removed (no marker), one retry-converted (retried:true)', () => {
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA, cleanB], skipped: [] };
    // A: gone on the first probe (first-try). B: survives its first probe, gone after retry.
    const seen = new Map<string, number>();
    const pathExists = (p: string) => {
      const n = (seen.get(p) ?? 0) + 1;
      seen.set(p, n);
      if (p === AGENT_PATH_A) return false; // first-try removed
      return n === 1; // B: still-present first, gone on retry
    };

    const result = executeCleanup(plan, {
      remover,
      pathExists,
      retryPause: NOOP_PAUSE,
      skipBranchHygiene: true,
    });

    const a = result.removed.find((w) => w.path === AGENT_PATH_A);
    const b = result.removed.find((w) => w.path === AGENT_PATH_B);
    expect(a?.retried).toBeUndefined();
    expect(b?.retried).toBe(true);
  });

  it('the DEFAULT retryPause is a real (non-zero) pause on the retry path', () => {
    // No injected retryPause → the module default (a short real synchronous
    // pause) runs. A deregisteredNotDeleted first attempt forces the retry.
    const { remover } = fakeRemover();
    const plan = { selected: [cleanA], skipped: [] };
    let probes = 0;
    const pathExists = () => {
      probes += 1;
      return probes === 1; // retry then succeeds
    };

    const start = Date.now();
    const result = executeCleanup(plan, {
      remover,
      pathExists,
      // retryPause deliberately omitted — exercise the real default.
      skipBranchHygiene: true,
    });
    const elapsed = Date.now() - start;

    expect(result.removed[0].retried).toBe(true);
    // The default pause is ~250ms; assert a conservative lower bound so the
    // check proves a real pause happened without being flaky under load.
    expect(elapsed).toBeGreaterThanOrEqual(150);
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

// ─── 20b. planOrphanBranchSweep / executeOrphanBranchSweep — the previewable
//     split (issue #142) ───────────────────────────────────────────────────
//
// sweepOrphanBranches computed-and-deleted in one pass, so a `--dry-run`
// caller had no pure half to call — the branch sweep's preview reported
// nothing selected, and the very next real run deleted six branches with no
// preceding preview of that outcome. These tests prove
// planOrphanBranchSweep is a genuine, side-effect-free preview of EXACTLY
// what executeOrphanBranchSweep then does.
describe('planOrphanBranchSweep / executeOrphanBranchSweep — the previewable split (issue #142)', () => {
  function fakeOps(opts?: {
    localBranches?: string[];
    currentBranch?: string | null;
    checkedOut?: Set<string>;
    liveWorktreeBasenames?: Set<string>;
    remoteGone?: Set<string>;
    remoteProbeFailedFor?: Map<string, string>;
  }): { ops: OrphanBranchSweepOps; deleteSpy: ReturnType<typeof vi.fn> } {
    const deleteSpy = vi.fn();
    const ops: OrphanBranchSweepOps = {
      listLocalBranches: () => opts?.localBranches ?? [],
      currentBranch: () => opts?.currentBranch ?? null,
      listCheckedOutBranches: () => opts?.checkedOut ?? new Set<string>(),
      listLiveWorktreeBasenames: () => opts?.liveWorktreeBasenames ?? new Set<string>(),
      probeRemoteRef: (b: string): RemoteRefProbeResult => {
        if (opts?.remoteGone?.has(b)) return { status: 'gone' };
        const fail = opts?.remoteProbeFailedFor?.get(b);
        if (fail !== undefined) return { status: 'probe-failed', reason: fail };
        return { status: 'present' };
      },
      deleteBranch: deleteSpy,
    };
    return { ops, deleteSpy };
  }

  it('planOrphanBranchSweep computes the toDelete set WITHOUT calling deleteBranch at all', () => {
    const { ops, deleteSpy } = fakeOps({
      localBranches: ['main', 'wave/FOR-142-gone', 'worktree-wf_orphan-1'],
      currentBranch: 'main',
      remoteGone: new Set(['wave/FOR-142-gone']),
      liveWorktreeBasenames: new Set<string>(),
    });

    const plan = planOrphanBranchSweep({ ops });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(plan.toDelete.sort()).toEqual(['wave/FOR-142-gone', 'worktree-wf_orphan-1'].sort());
    expect(plan.branchHygieneSkipped).toEqual([]);
  });

  it('planOrphanBranchSweep still records a probe-failed branch in branchHygieneSkipped, never in toDelete', () => {
    const { ops, deleteSpy } = fakeOps({
      localBranches: ['wave/FOR-142-flaky'],
      remoteProbeFailedFor: new Map([['wave/FOR-142-flaky', 'network error']]),
    });

    const plan = planOrphanBranchSweep({ ops });

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(plan.toDelete).toEqual([]);
    expect(plan.branchHygieneSkipped).toEqual([
      { branch: 'wave/FOR-142-flaky', reason: 'branch-probe-failed', detail: 'network error' },
    ]);
  });

  it("executeOrphanBranchSweep deletes EXACTLY the plan's toDelete set and passes branchHygieneSkipped through unchanged", () => {
    const { ops, deleteSpy } = fakeOps();
    const plan: OrphanBranchSweepPlan = {
      toDelete: ['wave/FOR-142-a', 'worktree-wf_orphan-2'],
      branchHygieneSkipped: [
        { branch: 'wave/FOR-142-flaky', reason: 'branch-probe-failed', detail: 'x' },
      ],
    };

    const result = executeOrphanBranchSweep(plan, { ops });

    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledWith('wave/FOR-142-a');
    expect(deleteSpy).toHaveBeenCalledWith('worktree-wf_orphan-2');
    expect(result.branchesDeleted).toEqual(['wave/FOR-142-a', 'worktree-wf_orphan-2']);
    expect(result.branchHygieneSkipped).toBe(plan.branchHygieneSkipped);
  });

  it('an EMPTY plan (nothing eligible) deletes nothing — idempotent no-op', () => {
    const { ops, deleteSpy } = fakeOps();
    const result = executeOrphanBranchSweep({ toDelete: [], branchHygieneSkipped: [] }, { ops });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(result.branchesDeleted).toEqual([]);
  });

  it('the preview IS the outcome: planOrphanBranchSweep then executeOrphanBranchSweep deletes exactly what sweepOrphanBranches would, given the same scenario', () => {
    const scenario = {
      localBranches: [
        'main',
        'wave/FOR-live',
        'wave/FOR-gone',
        'worktree-wf_orphan-3',
        'worktree-wf_live-1',
      ],
      currentBranch: 'main',
      checkedOut: new Set(['main', 'wave/FOR-live']),
      liveWorktreeBasenames: new Set(['wf_live-1']),
      remoteGone: new Set(['wave/FOR-gone']),
    };

    const { ops: opsForPreview } = fakeOps(scenario);
    const plan = planOrphanBranchSweep({ ops: opsForPreview });
    const previewResult = executeOrphanBranchSweep(plan, { ops: opsForPreview });

    const { ops: opsForDirect } = fakeOps(scenario);
    const directResult = sweepOrphanBranches({ ops: opsForDirect });

    expect(previewResult.branchesDeleted.sort()).toEqual(directResult.branchesDeleted.sort());
    expect(previewResult.branchHygieneSkipped).toEqual(directResult.branchHygieneSkipped);
    expect(previewResult.branchesDeleted.sort()).toEqual(
      ['wave/FOR-gone', 'worktree-wf_orphan-3'].sort(),
    );
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

// ─── 23. defaultWorktreeRemover — `.git` deleted LAST (FOR-86 — W25-F1) ──────
//
// Live finding W25-F1 (docs/retros/2026-07-23-hardening-vendor-w25.md, 5×
// reproduced): the physical removal deleted a worktree's own `.git` gitfile
// at whatever point `rmSync`'s internal traversal order happened to reach it
// — often early — so an interruption partway through the rest of the removal
// left a directory git still LISTS as a registered worktree, on disk, but
// WITHOUT its own `.git`. `git worktree remove` validates `.git`'s existence
// unconditionally and refuses ("validation failed: '.git' does not exist")
// even though the directory is otherwise trivial to finish removing.
//
// These tests use REAL fs fixtures (mirroring Section 10's technique) so the
// ordering is exercised end to end; `git worktree remove`/`prune` are mocked
// to no-ops so no real git registration is required for the fixture
// directory.
describe('defaultWorktreeRemover — `.git` deleted LAST (FOR-86)', () => {
  const tempRoots: string[] = [];

  // A `beforeEach` clear (not just `afterEach`) is required here: earlier
  // describe blocks (e.g. Section 22's real-git end-to-end tests) reset their
  // OWN mock's *implementation* in their `afterEach` but don't clear its call
  // history — so the FIRST test in this block that asserts
  // `not.toHaveBeenCalled()` needs its own clean slate regardless of what ran
  // immediately before it.
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  function makeWorktreeWithGit(name: string): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-for86-order-'));
    tempRoots.push(root);
    const worktreePath = join(root, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), 'gitdir: ../fake-admin/worktrees/fixture\n', 'utf-8');
    writeFileSync(join(worktreePath, 'real-file.txt'), 'hello', 'utf-8');
    mkdirSync(join(worktreePath, 'nested'), { recursive: true });
    writeFileSync(join(worktreePath, 'nested', 'inner.txt'), 'wip', 'utf-8');
    return { root, worktreePath };
  }

  /** Build a Node errno exception shaped like a sandbox write-deny (NOT ENOTEMPTY — never junk-purge-retried). */
  function makeEacces(path: string): NodeJS.ErrnoException {
    const err = new Error(`EACCES: permission denied, unlink '${path}'`) as NodeJS.ErrnoException;
    err.code = 'EACCES';
    return err;
  }

  it('AC1: an interruption (sandbox write-deny) during the non-.git phase propagates the error and leaves `.git` fully intact on disk', () => {
    const { root, worktreePath } = makeWorktreeWithGit('agent-interrupted');

    // Simulates a PERSISTENT (non-transient) sandbox write-deny: NOT
    // ENOTEMPTY, so it is never routed through the junk-purge-retry at all —
    // it propagates on the very first attempt, exactly like a real EACCES.
    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw makeEacces(join(worktreePath, 'real-file.txt'));
    });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).toThrow(/EACCES/);

    // `.git` was never even attempted — it is phase 2, reached only after
    // phase 1 (every OTHER top-level entry) fully succeeds.
    expect(existsSync(join(worktreePath, '.git'))).toBe(true);
    // Nothing at all was deleted — the very first rmSync call threw.
    expect(existsSync(join(worktreePath, 'real-file.txt'))).toBe(true);
    expect(existsSync(join(worktreePath, 'nested', 'inner.txt'))).toBe(true);

    // Never reached the git-level step at all — the worktree git still
    // recognizes is left exactly as a later removal attempt (ours, retried,
    // or a bare `git worktree remove`) needs it: `.git` present, content
    // otherwise unchanged.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('AC1: a SUCCESSFUL removal still deletes `.git` strictly after every other top-level entry (and the parent dir last of all)', () => {
    const { root, worktreePath } = makeWorktreeWithGit('agent-ordered-success');

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).not.toThrow();

    expect(existsSync(worktreePath)).toBe(false);

    // Inspect the recorded call order on the (mostly-real-passthrough) rmSync
    // spy: every call whose target is `.git` or the worktree root itself must
    // come AFTER every call targeting `real-file.txt` or `nested`.
    const calls = (rmSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const targets = calls
      .map((args) => args[0])
      .filter((p): p is string => typeof p === 'string' && p.startsWith(worktreePath));

    const gitIndex = targets.findIndex((p) => p === join(worktreePath, '.git'));
    const rootIndex = targets.findIndex((p) => p === worktreePath);
    const otherIndices = targets
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => p === join(worktreePath, 'real-file.txt') || p === join(worktreePath, 'nested'))
      .map(({ i }) => i);

    expect(gitIndex).toBeGreaterThan(-1);
    expect(rootIndex).toBeGreaterThan(-1);
    for (const otherIndex of otherIndices) {
      expect(gitIndex).toBeGreaterThan(otherIndex);
    }
    // The parent directory's own removal call is the very last of the batch.
    expect(rootIndex).toBeGreaterThan(gitIndex);

    // Step 2 (deregister) was still reached — the ordinary two-step contract
    // holds once `.git` was actually present at the start.
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: root }),
    );
  });

  it("a directory that doesn't exist at all is a no-op for the ordering phase (mirrors rmSync's own force:true idempotence) and still reaches `git worktree remove`", () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-for86-gone-'));
    tempRoots.push(root);
    const worktreePath = join(root, 'agent-already-gone');
    // Never created — exercise the "directory absent" branch directly.

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).not.toThrow();
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.objectContaining({ cwd: root }),
    );
  });
});

// ─── 24. defaultWorktreeRemover — half-removed recovery (FOR-86 — W25-F1) ────
//
// The counterpart to Section 23: a worktree ALREADY left in the half-removed
// shape by an older, pre-fix interrupted removal (still on disk, still
// registered with git, its own `.git` already gone). Rather than reaching
// `git worktree remove` and tripping its `.git`-existence validation, cleanup
// finishes the physical delete directly and runs `git worktree prune`.
describe('defaultWorktreeRemover — half-removed recovery (FOR-86)', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  function makeHalfRemovedWorktree(name: string): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-for86-halfremoved-'));
    tempRoots.push(root);
    const worktreePath = join(root, name);
    // `.git` deliberately absent — the exact shape a pre-fix interrupted
    // removal (or a FOR-59 orphan) leaves behind. Some ordinary leftover
    // content remains, exactly as an interrupted removal would leave it.
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'leftover.txt'), 'residue', 'utf-8');
    return { root, worktreePath };
  }

  it('AC2: a registered worktree whose `.git` is already missing is finished off — directory removed, `git worktree prune` run (never `git worktree remove`)', () => {
    const { root, worktreePath } = makeHalfRemovedWorktree('agent-halfremoved-1');

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).not.toThrow();

    expect(existsSync(worktreePath)).toBe(false);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'prune'],
      expect.objectContaining({ cwd: root }),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', worktreePath],
      expect.anything(),
    );
  });

  it('AC2: an EMPTY half-removed directory (no leftover content, `.git` missing) is still finished off via prune, not remove', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-for86-halfremoved-empty-'));
    tempRoots.push(root);
    const worktreePath = join(root, 'agent-halfremoved-empty');
    mkdirSync(worktreePath, { recursive: true });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).not.toThrow();

    expect(existsSync(worktreePath)).toBe(false);
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'prune'],
      expect.objectContaining({ cwd: root }),
    );
  });

  it('AC2: a STILL-FAILING half-removed directory removal propagates the error (never a silent success) — `git worktree prune` is never reached', () => {
    const { root, worktreePath } = makeHalfRemovedWorktree('agent-halfremoved-stuck');

    // A persistent (non-ENOTEMPTY) obstruction — every attempt fails, exactly
    // like a genuinely sandbox-denied path with the sandbox still on.
    const stuck = new Error(`EACCES: permission denied, unlink '${join(worktreePath, 'leftover.txt')}'`) as NodeJS.ErrnoException;
    stuck.code = 'EACCES';
    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw stuck;
    });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).toThrow(/EACCES/);

    // The directory is still there — nothing was silently finished.
    expect(existsSync(worktreePath)).toBe(true);
    // `git worktree prune` is only reached AFTER the physical delete
    // succeeds — a throw here must never reach it.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('AC2 (integration): a still-failing half-removed worktree stays classified as `erroredStillListed` through the full executeCleanup pipeline (bounded retry included) — never `removed`', () => {
    const { root, worktreePath } = makeHalfRemovedWorktree('agent-halfremoved-pipeline');

    function throwStuck(): never {
      const err = new Error(
        `EACCES: permission denied, unlink '${join(worktreePath, 'leftover.txt')}'`,
      ) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    // Two queued throws (bounded, never a persistent `mockImplementation` —
    // that would leak into later tests since `clearAllMocks` doesn't reset
    // implementations): the initial attempt AND executeCleanup's own FOR-84
    // bounded retry. Each `remover.remove()` call makes exactly one rmSync
    // call in the half-removed recovery branch (EACCES is not `ENOTEMPTY`,
    // so it is never itself junk-purge-retried internally).
    asRmSyncMock(rmSync).mockImplementationOnce(throwStuck);
    asRmSyncMock(rmSync).mockImplementationOnce(throwStuck);

    const entry: WorktreeEntry = {
      path: worktreePath,
      branch: 'wave/FOR-86-halfremoved',
      head: 'a'.repeat(40),
      dirty: false,
    };
    const plan = { selected: [entry], skipped: [] };
    const remover = defaultWorktreeRemover(root);

    const result = executeCleanup(plan, {
      remover,
      // The exact "still registered" half-removed shape (FOR-86's own
      // premise) — `git worktree list` would still show this worktree.
      stillListed: () => true,
      retryPause: () => {},
      skipBranchHygiene: true,
    });

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.erroredStillListed.map((e) => e.path)).toEqual([worktreePath]);
    // Directory genuinely still present — never silently reported as removed.
    expect(existsSync(worktreePath)).toBe(true);
  });
});

// ─── 25. Consumer-declared disposable names (issue #115) ─────────────────────
//
// A consumer running this toolkit on a Swift codebase hit the same manual
// cleanup three times in one wave: every Worker left a `.build/` directory
// behind, the harness deregistered the worktree, the physical directory
// survived, and the orphan classifier refused it with
// `reason: 'orphan-with-real-files'` — resolved each time by a hand `rm -rf`
// with the sandbox disabled.
//
// The obstruction is the CLASSIFICATION, not a permission: `FINDER_JUNK_NAMES`
// and `JUNK_DIR_NAMES` know only the junk THIS repo's harness/editors produce,
// and there was no way for a consumer to name their own. These tests pin the
// declarable set — the validator that keeps it exact names (never a glob that
// would also match `.git`), the union-never-replace semantics, the
// absent-config byte-identity, and both negative controls: an UNDECLARED real
// file still refuses removal, and a name is only honoured because it was
// declared.

describe('normalizeDisposableNames — the exact-names rule (issue #115)', () => {
  it('accepts bare entry names, trimming surrounding whitespace and collapsing duplicates (first occurrence wins)', () => {
    expect(
      normalizeDisposableNames(['.build', '  target  ', 'node_modules', '.build']),
    ).toEqual(['.build', 'target', 'node_modules']);
  });

  it('absent / null normalize to an empty list — the "nothing declared" default that keeps behaviour byte-identical', () => {
    expect(normalizeDisposableNames(undefined)).toEqual([]);
    expect(normalizeDisposableNames(null)).toEqual([]);
    expect(normalizeDisposableNames([])).toEqual([]);
  });

  it('rejects a non-array value', () => {
    expect(() => normalizeDisposableNames('.build')).toThrow(
      /must be an array of exact names/,
    );
    expect(() => normalizeDisposableNames({ '.build': true })).toThrow(
      /must be an array of exact names/,
    );
  });

  it('rejects a non-string entry, naming its index', () => {
    expect(() => normalizeDisposableNames(['.build', 7])).toThrow(
      /disposableNames\[1\] must be a string/,
    );
  });

  it('rejects an empty / whitespace-only entry', () => {
    expect(() => normalizeDisposableNames([''])).toThrow(/must be a non-empty name/);
    expect(() => normalizeDisposableNames(['   '])).toThrow(/must be a non-empty name/);
  });

  // AC3 — the load-bearing refusal. A pattern is rejected rather than honoured
  // precisely because `.*` would also match `.git`, which is the failure the
  // fixed built-in lists exist to prevent.
  it.each(['.*', '*', '*.o', 'build?', '[Bb]uild', '{a,b}', '!keep', '**'])(
    'rejects the pattern %j — only exact names are accepted',
    (pattern) => {
      expect(() => normalizeDisposableNames([pattern])).toThrow(
        /is a pattern, not a name/,
      );
    },
  );

  it('the pattern refusal names ".git" in its message, so the reason is legible at the point of failure', () => {
    expect(() => normalizeDisposableNames(['.*'])).toThrow(/\.git/);
  });

  it.each(['src/gen', './build', 'a\\b', '/abs/path'])(
    'rejects the path %j — a declaration names ONE entry, matched at any depth',
    (path) => {
      expect(() => normalizeDisposableNames([path])).toThrow(
        /must be a bare entry name, not a path/,
      );
    },
  );

  it.each(['.git', '.', '..'])('rejects the reserved name %j outright', (reserved) => {
    expect(() => normalizeDisposableNames([reserved])).toThrow(/is never disposable/);
  });

  it('uses the caller-supplied label so the error points at where the bad value was written', () => {
    expect(() =>
      normalizeDisposableNames(['.*'], 'wave config "cleanup.disposableNames"'),
    ).toThrow(/wave config "cleanup\.disposableNames"\[0\]/);
  });
});

describe('loadWaveConfig — the cleanup.disposableNames key (issue #115)', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
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

  /** Write a wave config JSON to a temp dir and return its path. */
  function writeConfig(body: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), 'wave-config-115-'));
    tempRoots.push(root);
    const path = join(root, 'wave.config.json');
    writeFileSync(path, JSON.stringify(body), 'utf-8');
    return path;
  }

  const STORE = { kind: 'github' as const };

  it('accepts a declared list and round-trips it', () => {
    const path = writeConfig({
      store: STORE,
      cleanup: { disposableNames: ['.build', 'target'] },
    });
    expect(loadWaveConfig(path).cleanup?.disposableNames).toEqual(['.build', 'target']);
  });

  it('an ABSENT cleanup key is valid and leaves `cleanup` undefined — today\'s config stays valid unchanged', () => {
    const path = writeConfig({ store: STORE });
    expect(loadWaveConfig(path).cleanup).toBeUndefined();
  });

  it('a cleanup object with no disposableNames is valid (nothing declared)', () => {
    const path = writeConfig({ store: STORE, cleanup: {} });
    expect(loadWaveConfig(path).cleanup?.disposableNames).toBeUndefined();
  });

  it('rejects a non-object cleanup value', () => {
    const path = writeConfig({ store: STORE, cleanup: ['.build'] });
    expect(() => loadWaveConfig(path)).toThrow(/"cleanup" must be an object/);
  });

  // AC3 at the OTHER enforcement point: a glob fails at `config validate`
  // time, naming the key — never silently at cleanup time.
  it('rejects a glob in disposableNames, naming the config key', () => {
    const path = writeConfig({ store: STORE, cleanup: { disposableNames: ['.*'] } });
    expect(() => loadWaveConfig(path)).toThrow(
      /wave config "cleanup\.disposableNames"\[0\].*is a pattern, not a name/,
    );
  });

  it('rejects ".git" in disposableNames', () => {
    const path = writeConfig({ store: STORE, cleanup: { disposableNames: ['.git'] } });
    expect(() => loadWaveConfig(path)).toThrow(/is never disposable/);
  });
});

// The orphan classification the live incident actually hit, against REAL git +
// REAL directories — the same fixture technique Sections 12/19 use.
describe('orphan classification honours consumer-declared disposable names (issue #115)', () => {
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

  /** A real repo whose `.claude/worktrees/` holds unregistered leftover dirs. */
  function makeRepo(): { mainRoot: string; worktreesRoot: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-115-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    const worktreesRoot = join(mainRoot, '.claude', 'worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    return { mainRoot, worktreesRoot };
  }

  /** The exact reported leftover: built-in junk plus a Swift `.build/` tree. */
  function makeSwiftLeftover(worktreesRoot: string, name: string): string {
    const dir = join(worktreesRoot, name);
    mkdirSync(join(dir, '.build', 'arm64-apple-macosx', 'debug'), { recursive: true });
    writeFileSync(
      join(dir, '.build', 'arm64-apple-macosx', 'debug', 'Package.o'),
      'object-code',
      'utf-8',
    );
    writeFileSync(join(dir, '.build', 'manifest.db'), 'build-manifest', 'utf-8');
    writeFileSync(join(dir, '.DS_Store'), 'finder-debris', 'utf-8');
    return dir;
  }

  it('AC2: an orphan dir holding only built-in junk plus a DECLARED name classifies allJunk:true and is removed', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const leftover = makeSwiftLeftover(worktreesRoot, 'wf_swift-consumer');

    const found = listOrphanDirs(mainRoot, { disposableNames: ['.build'] });
    expect(found.map((o) => o.path)).toEqual([leftover]);
    expect(found[0].allJunk).toBe(true);

    const result = sweepOrphanWorktrees({
      repoRoot: mainRoot,
      disposableNames: ['.build'],
    });
    expect(result.errors).toHaveLength(0);
    expect(result.removed.map((o) => o.path)).toEqual([leftover]);
    expect(existsSync(leftover)).toBe(false);
  });

  // The negative control for AC1's "absent config leaves behaviour
  // byte-identical": the SAME fixture, with nothing declared, must still be
  // refused exactly as it was before this slice existed. Without this, the
  // test above could pass for reasons that have nothing to do with the
  // declaration.
  it('AC1 negative control: the SAME fixture with NOTHING declared still classifies allJunk:false and is skipped `orphan-with-real-files`', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const leftover = makeSwiftLeftover(worktreesRoot, 'wf_swift-undeclared');

    expect(listOrphanDirs(mainRoot)[0].allJunk).toBe(false);

    const result = sweepOrphanWorktrees({ repoRoot: mainRoot });
    expect(result.removed).toHaveLength(0);
    expect(result.skipped.map((o) => o.path)).toEqual([leftover]);
    expect(result.skipped[0].reason).toBe('orphan-with-real-files');
    expect(existsSync(leftover)).toBe(true);
  });

  // The negative control for AC2's second half — Convention 11: the check must
  // be provably able to fail. One UNDECLARED real file alongside the declared
  // build output still refuses the whole directory.
  it('AC2 negative control: one UNDECLARED real file alongside the declared build output still skips with `orphan-with-real-files`', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const leftover = makeSwiftLeftover(worktreesRoot, 'wf_swift-plus-real');
    writeFileSync(join(leftover, 'notes.txt'), 'uncommitted work', 'utf-8');

    const found = listOrphanDirs(mainRoot, { disposableNames: ['.build'] });
    expect(found[0].allJunk).toBe(false);

    const result = sweepOrphanWorktrees({
      repoRoot: mainRoot,
      disposableNames: ['.build'],
    });
    expect(result.removed).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('orphan-with-real-files');
    expect(existsSync(join(leftover, 'notes.txt'))).toBe(true);
  });

  it('a real file NESTED under an undeclared subdirectory still refuses the directory — the declaration widens nothing beyond the named entries', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const leftover = makeSwiftLeftover(worktreesRoot, 'wf_swift-nested-real');
    mkdirSync(join(leftover, 'Sources', 'App'), { recursive: true });
    writeFileSync(join(leftover, 'Sources', 'App', 'main.swift'), 'print("hi")', 'utf-8');

    expect(listOrphanDirs(mainRoot, { disposableNames: ['.build'] })[0].allJunk).toBe(
      false,
    );
  });

  it('the union is a UNION: built-in junk keeps classifying as junk when a consumer declares their own names', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const dir = join(worktreesRoot, 'wf_union');
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    writeFileSync(join(dir, '.vscode', 'settings.json'), '{}', 'utf-8');
    mkdirSync(join(dir, 'target'), { recursive: true });
    writeFileSync(join(dir, 'target', 'app.jar'), 'jar', 'utf-8');
    writeFileSync(join(dir, '.DS_Store'), 'debris', 'utf-8');

    expect(listOrphanDirs(mainRoot, { disposableNames: ['target'] })[0].allJunk).toBe(
      true,
    );
  });

  it('a declared name is honoured as a FILE name too, not only as a directory', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    const dir = join(worktreesRoot, 'wf_declared-file');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'compile_commands.json'), '[]', 'utf-8');

    expect(listOrphanDirs(mainRoot)[0].allJunk).toBe(false);
    expect(
      listOrphanDirs(mainRoot, { disposableNames: ['compile_commands.json'] })[0]
        .allJunk,
    ).toBe(true);
  });

  it('an invalid declaration throws at the engine entry point too — a glob never reaches a filesystem decision', () => {
    const { mainRoot, worktreesRoot } = makeRepo();
    makeSwiftLeftover(worktreesRoot, 'wf_swift-glob-refused');

    expect(() => listOrphanDirs(mainRoot, { disposableNames: ['.*'] })).toThrow(
      /is a pattern, not a name/,
    );
    expect(() =>
      sweepOrphanWorktrees({ repoRoot: mainRoot, disposableNames: ['.git'] }),
    ).toThrow(/is never disposable/);
  });

  // The FOR-59 registered-but-deregistered orphan path (`orphanAllJunk`), the
  // one `planCleanup` routes — same question, same answer, reached through
  // `listAgentWorktrees` instead of the standalone sweep.
  it('listAgentWorktrees → planCleanup: a DEREGISTERED worktree dir holding only build output is selected when declared, skipped when not', () => {
    const { mainRoot } = makeRepo();
    const relPath = join('.claude', 'worktrees', 'wf_swift-deregistered');
    realGit(['worktree', 'add', '-q', relPath, '-b', 'wave/115-swift'], mainRoot);
    const worktreePath = join(mainRoot, relPath);
    // Deregister exactly the way the live incident did: drop the worktree's own
    // `.git` pointer, leave the physical directory (and its build output).
    rmSync(join(worktreePath, '.git'), { force: true });
    mkdirSync(join(worktreePath, '.build', 'debug'), { recursive: true });
    writeFileSync(join(worktreePath, '.build', 'debug', 'App.o'), 'obj', 'utf-8');

    const undeclared = listAgentWorktrees(mainRoot);
    expect(undeclared[0].orphan).toBe(true);
    expect(undeclared[0].orphanAllJunk).toBe(false);
    expect(planCleanup(undeclared).skipped[0].reason).toBe('orphan-with-real-files');

    const declared = listAgentWorktrees(mainRoot, DEFAULT_AGENT_PATH_MARKERS, ['.build']);
    expect(declared[0].orphanAllJunk).toBe(true);
    expect(planCleanup(declared).selected.map((e) => e.path)).toEqual([worktreePath]);
    expect(planCleanup(declared).skipped).toHaveLength(0);
  });

  // The invariant this slice must not cross, restated against a declared set:
  // a DIRTY registered worktree is still never selected. The declaration
  // reaches the directory-scan classifier only — never the `git status`-driven
  // dirty decision.
  it('the dirty-worktree safety invariant is untouched: a REGISTERED worktree dirty with real work is still skipped even with a declaration active', () => {
    const { mainRoot } = makeRepo();
    const relPath = join('.claude', 'worktrees', 'wf_swift-dirty');
    realGit(['worktree', 'add', '-q', relPath, '-b', 'wave/115-dirty'], mainRoot);
    const worktreePath = join(mainRoot, relPath);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    writeFileSync(join(worktreePath, 'uncommitted.swift'), 'let x = 1', 'utf-8');

    const entries = listAgentWorktrees(mainRoot, DEFAULT_AGENT_PATH_MARKERS, ['.build']);
    expect(entries[0].dirty).toBe(true);
    expect(entries[0].dirtyAllJunk).toBeFalsy();
    expect(planCleanup(entries).selected).toHaveLength(0);
    expect(planCleanup(entries).skipped[0].reason).toBe('dirty');
  });
});

// The purge side of the union: the ENOTEMPTY junk-purge-then-retry must count a
// consumer-declared entry as junk, or a directory the classifier called
// disposable would still fail to actually come off disk.
describe('the junk purge honours consumer-declared names (issue #115)', () => {
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

  function makeTempWorktree(name: string): { root: string; worktreePath: string } {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-115-purge-'));
    tempRoots.push(root);
    const worktreePath = join(root, name);
    mkdirSync(join(worktreePath, '.build'), { recursive: true });
    writeFileSync(join(worktreePath, '.build', 'App.o'), 'obj', 'utf-8');
    writeFileSync(join(worktreePath, '.git'), 'gitdir: ../fake-admin/wt\n', 'utf-8');
    return { root, worktreePath };
  }

  it('a declared `.build` is purged on the ENOTEMPTY retry, so the removal completes', () => {
    const { root, worktreePath } = makeTempWorktree('agent-declared-purge');

    // The live race shape: the first physical delete throws ENOTEMPTY without
    // having deleted anything.
    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw makeEnotempty(worktreePath);
    });

    const remover = defaultWorktreeRemover(root, ['.build']);
    expect(() => remover.remove(worktreePath)).not.toThrow();
    expect(existsSync(worktreePath)).toBe(false);
  });

  // Convention 11 negative control for the purge: the identical fixture with
  // NOTHING declared finds zero junk, so the ORIGINAL error propagates
  // unchanged — a real obstruction is still never masked as a junk retry.
  it('negative control: the SAME fixture with nothing declared finds no junk and propagates the ORIGINAL ENOTEMPTY', () => {
    const { root, worktreePath } = makeTempWorktree('agent-undeclared-purge');

    asRmSyncMock(rmSync).mockImplementationOnce(() => {
      throw makeEnotempty(worktreePath);
    });

    const remover = defaultWorktreeRemover(root);
    expect(() => remover.remove(worktreePath)).toThrow(/ENOTEMPTY/);
    expect(existsSync(join(worktreePath, '.build', 'App.o'))).toBe(true);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('executeCleanup threads the declaration into the DEFAULT remover — an orphan of pure build output is removed end-to-end', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-cleanup-115-e2e-'));
    tempRoots.push(root);
    const orphanPath = join(root, 'wf_115-e2e');
    mkdirSync(join(orphanPath, '.build'), { recursive: true });
    writeFileSync(join(orphanPath, '.build', 'App.o'), 'obj', 'utf-8');

    const entry: WorktreeEntry = {
      path: orphanPath,
      branch: 'wave/115-e2e',
      head: 'b'.repeat(40),
      dirty: false,
      orphan: true,
      orphanAllJunk: true,
    };
    const plan = planCleanup([entry]);
    expect(plan.selected).toHaveLength(1);

    const result = executeCleanup(plan, {
      repoRoot: root,
      disposableNames: ['.build'],
      skipBranchHygiene: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it('an INJECTED remover is used exactly as given — the declaration never overrides a caller-supplied seam', () => {
    const { remover, removeSpy } = fakeRemover();
    const entry: WorktreeEntry = {
      path: '/repo/.claude/worktrees/wf_injected',
      branch: 'wave/115-injected',
      head: 'c'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [entry], skipped: [] },
      {
        remover,
        disposableNames: ['.build'],
        pathExists: () => false,
        skipBranchHygiene: true,
      },
    );

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(result.removed).toHaveLength(1);
    // No real git/fs work happened — the injected seam owns the removal.
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// ─── 26. A classified-disposable worktree is ACTUALLY removed (issue #150) ───
//
// The layer the issue #142 review never exercised. That slice taught
// `planCleanup` to SELECT a worktree whose only divergence is deletions of
// paths a sandboxed harness refused to write, and it was verified at exactly
// that layer: the plan selects it. The criterion said "is removable by the
// engine", and no test ever removed one. Measured on the wave that shipped it,
// five such worktrees still came back `erroredStillListed: 5` and were removed
// by hand.
//
// Every test here therefore drives the REAL `defaultWorktreeRemover` against a
// REAL git repository with a REAL `git worktree add`, and asserts the OUTCOME —
// the directory is gone from disk and git no longer lists it — never that a
// plan selected something.
//
// Two shapes are pinned, and they are the two halves of the seam:
//
//   a. the ordinary harness-denied-deletion worktree: classification and
//      removal agree end-to-end, directory gone.
//   b. the shape that produced the field symptom: a worktree directory that
//      still EXISTS but cannot be read. `physicallyDeleteGitLast` used to
//      swallow that read failure and return as if the worktree were already
//      gone, so `git worktree remove` was handed an intact, git-dirty
//      worktree and refused it with git's own dirty-check message —
//      overruling the `dirtyAllJunk` verdict this module had already reached.
//      The removal must now fail at OUR step, and git must never be asked.
describe('a classified-disposable worktree is ACTUALLY removed — real git, real fs (issue #150)', () => {
  const tempRoots: string[] = [];
  const modesToRestore: string[] = [];
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    // Restore any permission-stripped fixture directory BEFORE the recursive
    // cleanup below, or the cleanup itself cannot read it either.
    while (modesToRestore.length > 0) {
      const dir = modesToRestore.pop();
      if (dir) {
        try {
          chmodSync(dir, 0o755);
        } catch {
          // already gone
        }
      }
    }
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

  /** Real `git`, bypassing the mock — fixture SETUP and independent verification. */
  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /**
   * A real repo with a real worktree under `.claude/worktrees/wf_<name>`, whose
   * ONLY divergence is unstaged deletions of tracked files under harness-denied
   * paths — the exact `' D'` shape a sandboxed harness checkout produces, and
   * the exact shape the issue #142 gate targets.
   *
   * `core.excludesFile` is pinned to nothing so the fixture never inherits the
   * developer's global excludes (the same reason section 12 does it).
   */
  function makeHarnessDeniedWorktree(name: string): {
    mainRoot: string;
    worktreePath: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-150-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'skills', 'wave-plan'), { recursive: true });
    writeFileSync(join(mainRoot, '.claude', 'skills', 'wave-plan', 'SKILL.md'), '# skill\n');
    mkdirSync(join(mainRoot, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(mainRoot, '.claude', 'agents', 'wave-reviewer.md'), 'agent config\n');
    // `.vscode/settings.json` is in the fixture because it is in the LIVE
    // shape: it is one of exactly two paths this harness's sandbox refuses to
    // check out in this repo (issue #150 live gate).
    mkdirSync(join(mainRoot, '.vscode'), { recursive: true });
    writeFileSync(join(mainRoot, '.vscode', 'settings.json'), '{"files.exclude":{}}\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'track harness-owned paths'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    const relPath = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', relPath, '-b', `wave/150-${name}`], mainRoot);
    const worktreePath = join(mainRoot, relPath);

    // The denied checkout never materializes these — modeled as the plain,
    // unstaged deletion it actually produces (the index still holds the exact
    // committed blob; nothing was ever `git rm`'d).
    rmSync(join(worktreePath, '.claude', 'skills', 'wave-plan', 'SKILL.md'), { force: true });
    rmSync(join(worktreePath, '.claude', 'agents', 'wave-reviewer.md'), { force: true });
    rmSync(join(worktreePath, '.vscode', 'settings.json'), { force: true });

    return { mainRoot, worktreePath };
  }

  /** Is `path` still registered per real `git worktree list --porcelain`? */
  function stillRegistered(mainRoot: string, worktreePath: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`);
  }

  /** Every `git` argv this test recorded on the (real-delegating) execFileSync mock. */
  function recordedGitArgs(): string[][] {
    const calls = (execFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls
      .filter((args) => args[0] === 'git')
      .map((args) => (Array.isArray(args[1]) ? (args[1] as string[]) : []));
  }

  it('AC1/AC3: a worktree carrying ONLY harness-denied deletions is driven through a REAL removal — the directory is GONE afterwards and git no longer lists it', () => {
    const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-removed');

    // Precondition, stated so a failure downstream is unambiguous: the fixture
    // really is the `' D'`-only shape, and the module really does classify it
    // disposable.
    // NB: never `.trim()` porcelain — the ` D ` status code's own leading
    // space is significant (that space IS the "index unchanged" half of the
    // XY pair the issue #142 gate keys on).
    const status = realGit(['status', '--porcelain', '--untracked-files=all'], worktreePath);
    expect(status.split('\n').filter((l) => l.length > 0)).toEqual([
      ' D .claude/agents/wave-reviewer.md',
      ' D .claude/skills/wave-plan/SKILL.md',
      ' D .vscode/settings.json',
    ]);

    const entries = listAgentWorktrees(mainRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].dirty).toBe(true);
    expect(entries[0].dirtyAllJunk).toBe(true);

    const plan = planCleanup(entries);
    expect(plan.selected.map((e) => e.path)).toEqual([worktreePath]);

    // No injected remover, no injected pathExists/stillListed — the real
    // two-phase `defaultWorktreeRemover` against the real repo.
    const result = executeCleanup(plan, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    // THE OUTCOME — not the plan.
    expect(result.errors).toEqual([]);
    expect(result.erroredStillListed).toHaveLength(0);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
    expect(result.removed.map((e) => e.path)).toEqual([worktreePath]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(false);
  });

  it('AC2: the no-force stance is upheld by the mechanism, not merely stated — `git worktree remove` is invoked without `--force`, on an already-empty path', () => {
    const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-noforce');

    const result = executeCleanup(planCleanup(listAgentWorktrees(mainRoot)), {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });
    expect(result.removed).toHaveLength(1);

    const argvs = recordedGitArgs();
    expect(argvs).toContainEqual(['worktree', 'remove', worktreePath]);
    // Never `--force`, anywhere: the classification is carried out by deleting
    // the directory ourselves first, never by overriding git's own check.
    for (const argv of argvs) {
      expect(argv).not.toContain('--force');
      expect(argv).not.toContain('-f');
    }
  });

  it('the removal is verified before deregistration — a physical delete that silently leaves the directory behind throws instead of reaching `git worktree remove`', () => {
    const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-unverified');
    // Strip the worktree to just its `.git` gitfile, so the ordinary path makes
    // exactly two rmSync calls (phase 2 `.git`, phase 3 the directory) — both
    // neutered below, so nothing throws yet nothing is deleted either.
    for (const entry of readdirSync(worktreePath)) {
      if (entry !== '.git') rmSync(join(worktreePath, entry), { recursive: true, force: true });
    }
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});

    const remover = defaultWorktreeRemover(mainRoot);
    expect(() => remover.remove(worktreePath)).toThrow(/left the directory on disk/);

    // The directory is still there and — crucially — git was never told to
    // forget it, so the entry stays recoverable rather than becoming an orphan.
    expect(existsSync(worktreePath)).toBe(true);
    expect(recordedGitArgs()).not.toContainEqual(['worktree', 'remove', worktreePath]);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
  });

  // The field symptom, reproduced. Permission bits are the portable way to make
  // a directory that EXISTS but cannot be read; mode 0300 keeps traversal
  // working, so git can still run its own status inside it — which is exactly
  // what made git's dirty check fire and overrule the classification.
  const canDenyRead = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;

  it.skipIf(!canDenyRead)(
    'AC1: a worktree directory that EXISTS but cannot be read fails at OUR removal step — never handed to `git worktree remove` to be refused by git\'s own dirty check',
    () => {
      const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-unreadable');
      const plan = planCleanup(listAgentWorktrees(mainRoot));
      expect(plan.selected).toHaveLength(1);

      chmodSync(worktreePath, 0o300);
      modesToRestore.push(worktreePath);

      let thrown: unknown;
      try {
        defaultWorktreeRemover(mainRoot).remove(worktreePath);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      // The regression this pins: git must never have been asked. Before the
      // fix this message was, verbatim, git's own refusal —
      // `fatal: '<path>' contains modified or untracked files, use --force to
      // delete it` — a dirty verdict from a checker that never saw
      // `dirtyAllJunk`.
      expect(message).not.toMatch(/contains modified or untracked files/);
      expect(message).not.toMatch(/use --force/);
      expect(message).toMatch(/EACCES|EPERM|permission denied/i);
      expect(recordedGitArgs()).not.toContainEqual(['worktree', 'remove', worktreePath]);
      // Still fully registered — a failed removal never costs git's bookkeeping.
      expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
    },
  );

  it.skipIf(!canDenyRead)(
    'AC1 (integration): the same unreadable worktree stays honestly classified `erroredStillListed` through the full pipeline — never `removed`, never silently deregistered',
    () => {
      const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-unreadable-pipeline');
      const plan = planCleanup(listAgentWorktrees(mainRoot));
      expect(plan.selected).toHaveLength(1);

      chmodSync(worktreePath, 0o300);
      modesToRestore.push(worktreePath);

      const result = executeCleanup(plan, {
        repoRoot: mainRoot,
        skipBranchHygiene: true,
        retryPause: () => {},
      });

      expect(result.removed).toHaveLength(0);
      expect(result.erroredStillListed.map((e) => e.path)).toEqual([worktreePath]);
      expect(existsSync(worktreePath)).toBe(true);
      expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
      expect(recordedGitArgs()).not.toContainEqual(['worktree', 'remove', worktreePath]);
    },
  );

  it("regression: a directory that genuinely does NOT exist is still the idempotent no-op — it reaches `git worktree remove` and deregisters, exactly as before", () => {
    const { mainRoot, worktreePath } = makeHarnessDeniedWorktree('wf_e2e-already-gone');
    // Somebody (a harness that tore down its own worktree, an operator) already
    // deleted the directory. The read failure here is ENOENT, not a denial.
    rmSync(worktreePath, { recursive: true, force: true });
    expect(existsSync(worktreePath)).toBe(false);

    expect(() => defaultWorktreeRemover(mainRoot).remove(worktreePath)).not.toThrow();
    expect(recordedGitArgs()).toContainEqual(['worktree', 'remove', worktreePath]);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(false);
  });
});

// ─── 26b. Scoped force on the classifier-disposable removal path (issue #304) ─
//
// Issue #150 taught `defaultWorktreeRemover` to verify its OWN physical
// delete before ever handing git a directory to adjudicate — correct as a
// rule, but a live wave close showed it also meant an entry the classifier
// had ALREADY vouched disposable (`dirtyAllJunk`/`orphanAllJunk`) stayed
// permanently stuck in `erroredStillListed` whenever that physical delete
// could not fully finish on its own. `opts.force` on `WorktreeRemover.remove`
// closes that as a SCOPED last-resort fallback — see the file-level "the
// classifier's own fallback, scoped" doc section for the full amendment.
//
// First block: unit-level wiring, no real git/fs — pins exactly WHEN
// `executeCleanup` computes `force: true` (the reviewer-facing question:
// "is force scoped to the classifier-disposable path, and nothing else?").
// Second block: real git/fs — the refusal-shape regression net AC1 asks for
// (a remover that fails without force, succeeds with it) plus the AC2
// negative control (genuine non-junk modifications are never force-removed).
describe('executeCleanup — force is computed from the classifier verdict alone (issue #304)', () => {
  const baseEntry = {
    path: AGENT_PATH_A,
    head: 'a'.repeat(40),
    dirty: false,
  };

  it('a plain clean worktree (no dirtyAllJunk/orphanAllJunk) is removed with force: false', () => {
    const { remover, removeSpy } = fakeRemover();
    const clean: WorktreeEntry = { ...baseEntry, branch: 'wave/304-clean' };

    executeCleanup({ selected: [clean], skipped: [] }, { remover, skipBranchHygiene: true });

    expect(removeSpy).toHaveBeenCalledWith(AGENT_PATH_A, { force: false });
  });

  it('a dirtyAllJunk-classified worktree is removed with force: true', () => {
    const { remover, removeSpy } = fakeRemover();
    const junky: WorktreeEntry = {
      ...baseEntry,
      branch: 'wave/304-junky',
      dirty: true,
      dirtyAllJunk: true,
    };

    executeCleanup({ selected: [junky], skipped: [] }, { remover, skipBranchHygiene: true });

    expect(removeSpy).toHaveBeenCalledWith(AGENT_PATH_A, { force: true });
  });

  it('an orphanAllJunk-classified worktree is removed with force: true', () => {
    const { remover, removeSpy } = fakeRemover();
    const orphanJunky: WorktreeEntry = {
      ...baseEntry,
      branch: 'wave/304-orphan',
      orphan: true,
      orphanAllJunk: true,
    };

    executeCleanup({ selected: [orphanJunky], skipped: [] }, { remover, skipBranchHygiene: true });

    expect(removeSpy).toHaveBeenCalledWith(AGENT_PATH_A, { force: true });
  });

  // AC2's unit-level half: `planCleanup` — not `executeCleanup` — is what
  // keeps a genuinely-dirty, non-junk worktree away from `force` entirely.
  // The remover is never even invoked, so `force` is never computed for it.
  it('negative control: a genuinely-dirty non-junk worktree never reaches the remover at all — force is never computed for it', () => {
    const { remover, removeSpy } = fakeRemover();
    const dirtyReal: WorktreeEntry = {
      path: AGENT_PATH_B,
      branch: 'wave/304-real',
      head: 'b'.repeat(40),
      dirty: true,
      dirtyAllJunk: false,
    };

    const plan = planCleanup([dirtyReal]);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('dirty');

    executeCleanup(plan, { remover, skipBranchHygiene: true });

    expect(removeSpy).not.toHaveBeenCalled();
  });
});

describe('defaultWorktreeRemover — scoped force on the classifier-disposable path, real git/fs (issue #304)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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

  /** Real `git`, bypassing the mock — fixture SETUP and independent verification. */
  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /** Is `path` still registered per real `git worktree list --porcelain`? */
  function stillRegistered(mainRoot: string, worktreePath: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`);
  }

  /** A real repo with a real worktree carrying REAL, non-junk uncommitted content. */
  function makeDirtyWorktree(name: string): { mainRoot: string; worktreePath: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-304-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    const relPath = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', relPath, '-b', `wave/304-${name}`], mainRoot);
    const worktreePath = join(mainRoot, relPath);
    // Genuine uncommitted work — real content, never junk.
    writeFileSync(join(worktreePath, 'src.ts'), 'export const x = 1;\n', 'utf-8');
    return { mainRoot, worktreePath };
  }

  // The regression net AC1 asks for: "a remover that fails without force and
  // succeeds with it". Both tests sabotage the SAME three-call physical
  // delete (phase 1's one non-`.git` entry, phase 2's `.git`, phase 3's
  // parent dir — see `physicallyDeleteGitLast`) so real content survives it,
  // mirroring the exact no-op-mock technique the issue #150 section already
  // uses ("the removal is verified before deregistration").
  it('AC1: the refusal shape — a remover whose OWN physical delete left real content behind THROWS without force', () => {
    const { mainRoot, worktreePath } = makeDirtyWorktree('wf_304-noforce');
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});

    const remover = defaultWorktreeRemover(mainRoot);
    expect(() => remover.remove(worktreePath)).toThrow(/left the directory on disk/);

    // Never told to forget it — the worktree stays fully recoverable.
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'src.ts'))).toBe(true);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
  });

  it('AC1: the SAME leftover-content shape SUCCEEDS when force is explicitly requested — a real `git worktree remove --force` finishes the job', () => {
    const { mainRoot, worktreePath } = makeDirtyWorktree('wf_304-force');
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});

    const remover = defaultWorktreeRemover(mainRoot);
    expect(() => remover.remove(worktreePath, { force: true })).not.toThrow();

    expect(existsSync(worktreePath)).toBe(false);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(false);
  });

  it('force is never consulted on the ordinary already-empty path — no `--force` argv when the physical delete already succeeded', () => {
    const { mainRoot, worktreePath } = makeDirtyWorktree('wf_304-ordinary');
    // No sabotage: the real physical delete runs unmodified and succeeds.
    const remover = defaultWorktreeRemover(mainRoot);
    remover.remove(worktreePath, { force: true });

    const calls = (execFileSync as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const gitArgvs = calls
      .filter((args) => args[0] === 'git')
      .map((args) => (Array.isArray(args[1]) ? (args[1] as string[]) : []));
    expect(gitArgvs).toContainEqual(['worktree', 'remove', worktreePath]);
    for (const argv of gitArgvs) {
      expect(argv).not.toContain('--force');
    }
  });

  it('AC1 (integration): a classifier-disposable worktree whose OWN physical delete could not finish is STILL removed end-to-end — never `erroredStillListed`', () => {
    const { mainRoot, worktreePath } = makeDirtyWorktree('wf_304-e2e-removed');
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});
    asRmSyncMock(rmSync).mockImplementationOnce(() => {});

    // Modeling the classifier verdict `dirtyAllJunk: true` already reached
    // upstream (issue #142/#111) — this test is about the REMOVAL mechanism,
    // not re-deriving the classification (already covered elsewhere, e.g.
    // the issue #150 section's live-pair fixture).
    const entry: WorktreeEntry = {
      path: worktreePath,
      branch: 'wave/304-wf_304-e2e-removed',
      head: 'a'.repeat(40),
      dirty: true,
      dirtyAllJunk: true,
    };
    const plan = planCleanup([entry]);
    expect(plan.selected).toHaveLength(1);

    const result = executeCleanup(plan, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result.errors).toEqual([]);
    expect(result.erroredStillListed).toHaveLength(0);
    expect(result.deregisteredNotDeleted).toHaveLength(0);
    expect(result.removed.map((e) => e.path)).toEqual([worktreePath]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(false);
  });

  // AC2's real-git/fs half: a worktree with GENUINE non-junk uncommitted
  // content, run through the FULL classification pipeline, never reaches the
  // remover — so `force` can never apply to it, regardless of what the
  // remover itself is capable of (proven capable, immediately above).
  it('AC2: negative control — a REAL worktree with GENUINE non-junk uncommitted content is skipped by the classifier and NEVER force-removed', () => {
    const { mainRoot, worktreePath } = makeDirtyWorktree('wf_304-negative-control');
    // No sabotage: `src.ts` is real, genuinely uncommitted work.

    const entries = listAgentWorktrees(mainRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].dirty).toBe(true);
    expect(entries[0].dirtyAllJunk).toBeFalsy();

    const plan = planCleanup(entries);
    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped.map((e) => e.path)).toEqual([worktreePath]);
    expect(plan.skipped[0].reason).toBe('dirty');

    const removeSpy = vi.fn();
    const result = executeCleanup(plan, {
      repoRoot: mainRoot,
      remover: { remove: removeSpy },
      skipBranchHygiene: true,
    });

    // The remover — and therefore `force` — is NEVER invoked for this entry.
    expect(removeSpy).not.toHaveBeenCalled();
    expect(result.removed).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'src.ts'))).toBe(true);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
  });
});

// ─── 27. Detached-HEAD scratchpad sweep — planning (issue #238) ───────────────
//
// The population half of the E2BIG hardening. `planDetachedScratchpadSweep` is
// pure, so these fixtures pin every refusal by name with zero git/fs: the
// defining `live-branch` gate, and the three safety refusals it inherits
// (`locked`, `dirty`, `orphan-with-real-files`) which must keep behaving exactly
// as they do on the `planCleanup` path.
describe('planDetachedScratchpadSweep — selection + named refusals (issue #238)', () => {
  const SCRATCH = '/repo/.claude/worktrees/review-238';

  /** A candidate entry as `listDetachedScratchpadWorktrees` would return it. */
  function candidate(over: Partial<WorktreeEntry> = {}): WorktreeEntry {
    return {
      path: SCRATCH,
      branch: null,
      head: 'abc1234abc1234abc1234abc1234abc1234abcd',
      dirty: false,
      locked: false,
      ...over,
    };
  }

  it('selects a detached, clean, unlocked scratch checkout — the whole point of the sweep', () => {
    const plan = planDetachedScratchpadSweep([candidate()]);

    expect(plan.selected.map((w) => w.path)).toEqual([SCRATCH]);
    expect(plan.skipped).toHaveLength(0);
  });

  it("skips a worktree with a branch checked out — reason 'live-branch', never removed", () => {
    const plan = planDetachedScratchpadSweep([
      candidate({ path: '/repo/.claude/worktrees/wf_row-1', branch: 'wave/238-e2big-sweep' }),
    ]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('live-branch');
  });

  it("skips a DIRTY detached checkout — reason 'dirty' (the safety invariant is untouched)", () => {
    const plan = planDetachedScratchpadSweep([candidate({ dirty: true })]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('dirty');
  });

  it('selects a detached checkout whose dirt is EXCLUSIVELY the already-classified disposable shape', () => {
    const plan = planDetachedScratchpadSweep([
      candidate({ dirty: true, dirtyAllJunk: true }),
    ]);

    expect(plan.selected.map((w) => w.path)).toEqual([SCRATCH]);
    expect(plan.skipped).toHaveLength(0);
  });

  it("skips a LOCKED detached checkout up front — reason 'locked', it never reaches the remover", () => {
    const plan = planDetachedScratchpadSweep([candidate({ locked: true })]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('locked');
  });

  it("skips an orphaned detached dir holding real files — reason 'orphan-with-real-files'", () => {
    const plan = planDetachedScratchpadSweep([
      candidate({ orphan: true, orphanAllJunk: false }),
    ]);

    expect(plan.selected).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('orphan-with-real-files');
  });

  it('selects an orphaned detached dir that is exclusively allowlisted junk', () => {
    const plan = planDetachedScratchpadSweep([
      candidate({ orphan: true, orphanAllJunk: true }),
    ]);

    expect(plan.selected.map((w) => w.path)).toEqual([SCRATCH]);
  });

  it('a mixed batch: every skipped entry carries a machine-readable reason, nothing is silently dropped', () => {
    const plan = planDetachedScratchpadSweep([
      candidate({ path: '/repo/.claude/worktrees/review-a' }),
      candidate({ path: '/repo/.claude/worktrees/review-b', dirty: true }),
      candidate({ path: '/repo/.claude/worktrees/wf_row-1', branch: 'wave/1-x' }),
      candidate({ path: '/repo/.claude/worktrees/review-c', locked: true }),
    ]);

    expect(plan.selected.map((w) => w.path)).toEqual(['/repo/.claude/worktrees/review-a']);
    expect(plan.skipped.map((w) => w.reason)).toEqual(['dirty', 'live-branch', 'locked']);
    expect(plan.skipped.every((w) => w.reason !== undefined)).toBe(true);
  });

  it('empty candidate list → empty plan (idempotent no-op)', () => {
    expect(planDetachedScratchpadSweep([])).toEqual({ selected: [], skipped: [] });
  });
});

// ─── 28. Detached-HEAD scratchpad sweep — real git/fs end-to-end (issue #238) ─
//
// The gap this closes only exists against REAL git: an un-prefixed detached
// checkout is fully REGISTERED (so `listOrphanDirs` cannot see it) and carries
// no `agent-`/`wf_` prefix (so `listAgentWorktrees` filters it out). Both halves
// of that claim are asserted here against genuine `git worktree list` output,
// alongside the outcome — the directory is gone from disk AND deregistered.
describe('detached-scratchpad sweep — real git/fs end-to-end (issue #238)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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

  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /**
   * A real repo with a real worktrees root. `core.excludesFile` is pinned to
   * nothing so no developer's global excludes leak into the fixture (the same
   * reason sections 12 and 26 do it).
   */
  function makeRepo(label: string): { mainRoot: string; worktreesRoot: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), `wt-cleanup-238-${label}-`)));
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
    const worktreesRoot = join(mainRoot, '.claude', 'worktrees');
    mkdirSync(worktreesRoot, { recursive: true });
    return { mainRoot, worktreesRoot };
  }

  /** Plant an un-prefixed DETACHED scratch checkout — the reviewer-made shape. */
  function plantDetachedScratchpad(mainRoot: string, name: string): string {
    const rel = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', '--detach', rel, 'HEAD'], mainRoot);
    return join(mainRoot, rel);
  }

  /** Is `path` still registered per real `git worktree list --porcelain`? */
  function stillRegistered(mainRoot: string, path: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line.trim() === `worktree ${path}`);
  }

  it('the pre-existing GC and orphan-dir sweeps BOTH structurally miss a planted un-prefixed detached checkout — the gap this sweep exists for', () => {
    const { mainRoot } = makeRepo('gap');
    const scratch = plantDetachedScratchpad(mainRoot, 'review-238');

    // Registered, so it is not an orphan DIRECTORY at all.
    expect(stillRegistered(mainRoot, scratch)).toBe(true);
    expect(listOrphanDirs(mainRoot).map((o) => o.path)).not.toContain(scratch);
    // No recognized name prefix, so the name-allowlisted GC never lists it.
    expect(listAgentWorktrees(mainRoot).map((w) => w.path)).not.toContain(scratch);
    expect(
      planCleanup(listAgentWorktrees(mainRoot)).selected.map((w) => w.path),
    ).not.toContain(scratch);

    // The new sweep DOES see it.
    expect(
      listDetachedScratchpadWorktrees({ repoRoot: mainRoot }).map((w) => w.path),
    ).toContain(scratch);
  });

  it('sweepDetachedScratchpadWorktrees removes the planted detached checkout — gone from disk AND deregistered', () => {
    const { mainRoot } = makeRepo('remove');
    const scratch = plantDetachedScratchpad(mainRoot, 'review-238');

    const result = sweepDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result.errors).toEqual([]);
    expect(result.deregisteredNotDeleted).toEqual([]);
    expect(result.erroredStillListed).toEqual([]);
    expect(result.removed.map((w) => w.path)).toEqual([scratch]);
    expect(existsSync(scratch)).toBe(false);
    expect(stillRegistered(mainRoot, scratch)).toBe(false);
  });

  it("a branch-bearing dispatch worktree in the SAME root is skipped 'live-branch' and survives", () => {
    const { mainRoot } = makeRepo('live');
    const scratch = plantDetachedScratchpad(mainRoot, 'review-238');
    const relDispatch = join('.claude', 'worktrees', 'wf_row-1');
    realGit(['worktree', 'add', '-q', relDispatch, '-b', 'wave/238-live'], mainRoot);
    const dispatchPath = join(mainRoot, relDispatch);

    const result = sweepDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result.removed.map((w) => w.path)).toEqual([scratch]);
    const liveSkip = result.skipped.find((w) => w.path === dispatchPath);
    expect(liveSkip?.reason).toBe('live-branch');
    expect(existsSync(dispatchPath)).toBe(true);
    expect(stillRegistered(mainRoot, dispatchPath)).toBe(true);
  });

  it("a DIRTY detached checkout is skipped 'dirty' and survives — real uncommitted content, real git status", () => {
    const { mainRoot } = makeRepo('dirty');
    const dirtyScratch = plantDetachedScratchpad(mainRoot, 'review-dirty');
    writeFileSync(join(dirtyScratch, 'work-in-progress.txt'), 'do not lose me\n');

    const result = sweepDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result.removed).toEqual([]);
    expect(result.skipped.map((w) => w.path)).toEqual([dirtyScratch]);
    expect(result.skipped[0].reason).toBe('dirty');
    expect(existsSync(dirtyScratch)).toBe(true);
    expect(stillRegistered(mainRoot, dirtyScratch)).toBe(true);
  });

  it('the primary checkout is never a candidate, however the roots are pointed', () => {
    const { mainRoot } = makeRepo('primary');
    plantDetachedScratchpad(mainRoot, 'review-238');

    const candidates = listDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      // Deliberately hostile: declare the repo root ITSELF as a containment root.
      extraRoots: ['.'],
    });

    expect(candidates.map((w) => w.path)).not.toContain(mainRoot);
  });

  it('a detached worktree OUTSIDE every containment root is left strictly alone until its root is declared', () => {
    const { mainRoot } = makeRepo('outside');
    const outsideRel = join('scratchpad', 'probe-238');
    realGit(['worktree', 'add', '-q', '--detach', outsideRel, 'HEAD'], mainRoot);
    const outside = join(mainRoot, outsideRel);

    // Undeclared → not a candidate.
    expect(
      listDetachedScratchpadWorktrees({ repoRoot: mainRoot }).map((w) => w.path),
    ).not.toContain(outside);

    // Declared → a candidate, and selected.
    const declared = listDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      extraRoots: ['scratchpad'],
    });
    expect(declared.map((w) => w.path)).toContain(outside);
    expect(
      planDetachedScratchpadSweep(declared).selected.map((w) => w.path),
    ).toContain(outside);
  });

  it('is idempotent: a re-run after the sweep finds no candidate and removes nothing', () => {
    const { mainRoot } = makeRepo('idem');
    plantDetachedScratchpad(mainRoot, 'review-238');

    const first = sweepDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });
    expect(first.removed).toHaveLength(1);

    const second = sweepDetachedScratchpadWorktrees({
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });
    expect(second.removed).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });
});

// ─── 29. Worktree-count advisory (issue #238) ─────────────────────────────────
//
// The measurement half: a dispatch preflight that fires BEFORE the sandbox
// profile outgrows the exec argument limit. Advisory, never a refusal — and the
// message is load-bearing, because it is the only place an operator learns that
// cleanup alone does not heal an already-E2BIG session.
describe('checkWorktreeCountAdvisory — the E2BIG dispatch preflight (issue #238)', () => {
  it('a count at or under the threshold is `ok`, with NO message to print', () => {
    const under = checkWorktreeCountAdvisory({ countWorktrees: () => 3 });
    expect(under).toEqual({
      count: 3,
      threshold: WORKTREE_COUNT_ADVISORY_THRESHOLD,
      level: 'ok',
      message: null,
    });

    // Boundary: exactly AT the threshold is still ok — the advisory fires above it.
    const at = checkWorktreeCountAdvisory({
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD,
    });
    expect(at.level).toBe('ok');
    expect(at.message).toBeNull();
  });

  it('a count above the threshold fires an advisory naming the E2BIG shape, its subagent scope, and the RESTART requirement', () => {
    const advisory = checkWorktreeCountAdvisory({
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD + 1,
    });

    expect(advisory.level).toBe('advisory');
    expect(advisory.count).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD + 1);
    expect(advisory.threshold).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD);
    // The three load-bearing facts, pinned so a reword cannot silently drop one.
    expect(advisory.message).toContain('E2BIG');
    expect(advisory.message).toContain('subagent');
    expect(advisory.message).toContain('RESTART');
    expect(advisory.message).toContain(String(WORKTREE_COUNT_ADVISORY_THRESHOLD + 1));
  });

  it('an explicit threshold override is honoured in both directions', () => {
    expect(
      checkWorktreeCountAdvisory({ countWorktrees: () => 5, threshold: 4 }).level,
    ).toBe('advisory');
    expect(
      checkWorktreeCountAdvisory({ countWorktrees: () => 5, threshold: 40 }).level,
    ).toBe('ok');
  });

  it('a garbled threshold throws rather than silently disabling the advisory (a NaN compare always reads `ok`)', () => {
    expect(() =>
      checkWorktreeCountAdvisory({
        countWorktrees: () => 99,
        threshold: Number.NaN,
      }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      checkWorktreeCountAdvisory({ countWorktrees: () => 99, threshold: -1 }),
    ).toThrow(/non-negative integer/);
    expect(() =>
      checkWorktreeCountAdvisory({ countWorktrees: () => 99, threshold: 2.5 }),
    ).toThrow(/non-negative integer/);
  });

  it('the shipped threshold leaves a full seven-row wave (plus its primary checkout) under the advisory', () => {
    // The live E2BIG incident was a 7-row wave's third dispatch run of the day.
    // One wave's own worktrees must never trip the advisory, or the warning
    // becomes standing noise and gets ignored.
    expect(checkWorktreeCountAdvisory({ countWorktrees: () => 8 }).level).toBe('ok');
    expect(WORKTREE_COUNT_ADVISORY_THRESHOLD).toBeGreaterThan(8);
  });
});

// ─── 30. Worktree-count advisory — real git count (issue #238) ────────────────
describe('checkWorktreeCountAdvisory — counts real `git worktree list` output (issue #238)', () => {
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
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
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

  function realGit(args: string[], cwd: string): void {
    realExecFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  it('counts the primary checkout plus every added worktree, and fires once the override threshold is passed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-238-count-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['commit', '-q', '--allow-empty', '-m', 'init'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });

    // Primary only.
    expect(checkWorktreeCountAdvisory({ repoRoot: mainRoot, threshold: 1 }).count).toBe(1);

    for (let i = 0; i < 3; i++) {
      realGit(
        [
          'worktree',
          'add',
          '-q',
          '--detach',
          join('.claude', 'worktrees', `probe-${i}`),
          'HEAD',
        ],
        mainRoot,
      );
    }

    const withThree = checkWorktreeCountAdvisory({ repoRoot: mainRoot, threshold: 3 });
    expect(withThree.count).toBe(4);
    expect(withThree.level).toBe('advisory');
    expect(withThree.message).toContain('E2BIG');

    // Same population, a threshold above it → ok.
    expect(checkWorktreeCountAdvisory({ repoRoot: mainRoot, threshold: 4 }).level).toBe('ok');
  });
});

// ─── 30a. The command line is the OTHER E2BIG term (issue #266) ───────────────
//
// Section 29's advisory models E2BIG with ONE term — the registered-worktree
// population. The live occurrence this section exists for proved that model
// incomplete in the most expensive way available: an operator following it
// would have swept worktrees and fixed nothing. ~1019.5 KB of command line
// across THREE argv entries, 166 sandbox deny paths of which only 15 were
// worktree-derived, recovered by compressing the PR body being passed as an
// argument.
//
// Two things are therefore under test here: the new measurement/advisory pair
// itself, and the correction to the OLD advisory's threshold guidance (a count
// under threshold is not an E2BIG all-clear).
//
// NOTE (barrel): `measureExecArgumentBytes`, `checkCommandLineSizeAdvisory` and
// `COMMAND_LINE_ADVISORY_THRESHOLD_BYTES` are imported from the module directly,
// not through `./index` like section 32's symbols — the package-root re-export
// lies outside this slice's declared file scope and is disclosed as a wiring
// follow-up. The CONSUMING call-site that ships with them is the CLI's
// `worktree-cleanup` verb (see cli.spec.ts), which imports the module directly.

/** The measured occurrence's command-line size, in bytes: ~1019.5 KB. */
const MEASURED_E2BIG_COMMAND_LINE_BYTES = Math.round(1019.5 * 1024); // 1_043_968

/**
 * The measured occurrence's SHAPE, rebuilt exactly: a megabyte of command line
 * across three argv entries (`host-pr create <body>`), sized so the engine's own
 * accounting lands on the observed total rather than merely near it.
 */
function measuredOccurrenceArgv(): string[] {
  const fixed = ['host-pr', 'create'];
  const overhead = 3 * 9; // three entries × (NUL + pointer)
  const bodyBytes =
    MEASURED_E2BIG_COMMAND_LINE_BYTES -
    overhead -
    fixed.reduce((n, s) => n + s.length, 0);
  return [...fixed, 'x'.repeat(bodyBytes)];
}

/**
 * Build argv whose `measureExecArgumentBytes(...).bytes` equals EXACTLY
 * `totalBytes`, split across `entryCount` roughly-equal entries rather than
 * one giant string (issue #340). This is what isolates a TOTAL-threshold
 * boundary test from the PER-STRING (`MAX_ARG_STRLEN`) condition introduced
 * alongside it: every entry this returns is sized to stay far under
 * {@link MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES}, so only the SUM crosses a
 * boundary in the caller's test — never any one entry.
 */
function argvTotalling(totalBytes: number, entryCount = 8): string[] {
  const overheadTotal = entryCount * 9; // EXEC_ENTRY_OVERHEAD_BYTES per entry
  const payloadTotal = totalBytes - overheadTotal;
  const base = Math.floor(payloadTotal / entryCount);
  const remainder = payloadTotal - base * entryCount;
  const argv = new Array(entryCount).fill(0).map(() => 'x'.repeat(base));
  argv[argv.length - 1] = 'x'.repeat(base + remainder);
  return argv;
}

describe('measureExecArgumentBytes — the exec argument accounting (issue #266)', () => {
  it('charges every argv entry its UTF-8 bytes plus a NUL and a pointer', () => {
    expect(measureExecArgumentBytes([])).toEqual({
      bytes: 0,
      argvBytes: 0,
      envBytes: 0,
      argCount: 0,
      envCount: 0,
      maxEntryBytes: 0,
    });

    // 'ab' (2) + 9, 'cde' (3) + 9.
    const two = measureExecArgumentBytes(['ab', 'cde']);
    expect(two.argvBytes).toBe(2 + 9 + (3 + 9));
    expect(two.argCount).toBe(2);
    expect(two.bytes).toBe(two.argvBytes);
    // maxEntryBytes is the LARGEST single entry (with its own overhead), not
    // a sum — 'cde' (3+9=12) beats 'ab' (2+9=11).
    expect(two.maxEntryBytes).toBe(3 + 9);
  });

  it('counts UTF-8 BYTES, not code units — the long paths are exactly the non-ASCII ones', () => {
    // This repo's own checkout path contains an en dash; a `String.length`
    // accounting would understate precisely the paths that cost the most.
    const ascii = measureExecArgumentBytes(['a']);
    const nonAscii = measureExecArgumentBytes(['ä']);
    expect('ä'.length).toBe(1); // one code unit...
    expect(nonAscii.argvBytes).toBe(2 + 9); // ...two bytes
    expect(nonAscii.argvBytes).toBeGreaterThan(ascii.argvBytes);
  });

  it('charges env as `KEY=VALUE`, and skips a key whose value is undefined', () => {
    const withEnv = measureExecArgumentBytes([], { A: 'bc' });
    expect(withEnv.envBytes).toBe('A=bc'.length + 9);
    expect(withEnv.envCount).toBe(1);
    expect(withEnv.bytes).toBe(withEnv.envBytes);

    // `process.env`'s index signature admits undefined; a key that is not in
    // the environment is not in the exec buffer either, and must never be
    // charged as the literal string "undefined".
    const sparse = measureExecArgumentBytes([], { A: 'bc', GONE: undefined });
    expect(sparse).toEqual(withEnv);
  });

  it('bytes is the SUM of the two halves, and the halves are reported apart', () => {
    const m: ExecArgumentMeasurement = measureExecArgumentBytes(['arg'], {
      K: 'v',
    });
    expect(m.bytes).toBe(m.argvBytes + m.envBytes);
    expect(m.argvBytes).toBeGreaterThan(0);
    expect(m.envBytes).toBeGreaterThan(0);
  });

  it('maxEntryBytes is the largest SINGLE entry across BOTH argv and env, not a sum (issue #340)', () => {
    const argvWins = measureExecArgumentBytes(['x'.repeat(1000)], { K: 'v' });
    expect(argvWins.maxEntryBytes).toBe(1000 + 9);

    const envWins = measureExecArgumentBytes(['a'], { BIG: 'y'.repeat(1000) });
    expect(envWins.maxEntryBytes).toBe('BIG='.length + 1000 + 9);

    // Neither half's TOTAL leaks in: a small argv with a small env has a
    // small maxEntryBytes, however many entries are summed elsewhere.
    const manySmall = measureExecArgumentBytes(['a', 'b', 'c', 'd', 'e']);
    expect(manySmall.maxEntryBytes).toBe(1 + 9);
    expect(manySmall.argvBytes).toBeGreaterThan(manySmall.maxEntryBytes);
  });
});

describe('checkCommandLineSizeAdvisory — the second E2BIG term (issue #266)', () => {
  it('the MEASURED occurrence fires: ~1019.5 KB across just 3 argv entries', () => {
    const argv = measuredOccurrenceArgv();
    // The fixture reproduces the observed total exactly, by the engine's own
    // accounting — so this is a test about the real input, not about a number
    // chosen to pass.
    expect(measureExecArgumentBytes(argv).bytes).toBe(
      MEASURED_E2BIG_COMMAND_LINE_BYTES,
    );

    const advisory: CommandLineSizeAdvisory = checkCommandLineSizeAdvisory({
      argv,
      env: {},
    });

    expect(advisory.level).toBe('advisory');
    expect(advisory.bytes).toBe(MEASURED_E2BIG_COMMAND_LINE_BYTES);
    expect(advisory.argCount).toBe(3);
    expect(advisory.threshold).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    // The load-bearing facts, pinned so a reword cannot silently drop one: the
    // failure name, that ONE argument suffices, that a sweep is the wrong
    // remedy, and the evidence that settles it.
    expect(advisory.message).toContain('E2BIG');
    expect(advisory.message).toContain('single argument is enough');
    expect(advisory.message).toContain('SWEEPING WORKTREES DOES NOT MOVE THIS TERM');
    expect(advisory.message).toContain('~1019.5 KB');
    expect(advisory.message).toContain('166 sandbox deny paths');
    expect(advisory.message).toContain(String(MEASURED_E2BIG_COMMAND_LINE_BYTES));
  });

  it('THE two-term proof: that same command line fires while a pristine worktree count reads `ok`', () => {
    // The correction itself, mechanically: the term that actually blew the
    // budget is invisible to the count advisory, so a session with a single
    // registered worktree (the primary checkout) reads clean while the spawn
    // is already a megabyte over. Sweeping would have moved nothing.
    const count = checkWorktreeCountAdvisory({ countWorktrees: () => 1 });
    expect(count.level).toBe('ok');

    expect(
      checkCommandLineSizeAdvisory({ argv: measuredOccurrenceArgv(), env: {} })
        .level,
    ).toBe('advisory');
  });

  it('NEGATIVE CONTROL — an ordinary command line is `ok`, with NO message to print', () => {
    // Without this the advisory could be permanently on and every assertion
    // above would still pass. An ordinary engine invocation plus a realistic
    // environment must stay silent.
    const ordinary = checkCommandLineSizeAdvisory({
      argv: [
        '/usr/local/bin/node',
        '/repo/tools/wave/src/cli.ts',
        'worktree-cleanup',
        '--dry-run',
        '/repo',
      ],
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/someone', LANG: 'en_US.UTF-8' },
    });
    expect(ordinary.level).toBe('ok');
    expect(ordinary.message).toBeNull();
    expect(ordinary.bytes).toBeGreaterThan(0);
    expect(ordinary.bytes).toBeLessThan(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    // Both conditions must read clean, not just the total (issue #340) — a
    // negative control that only cleared one term would let the other stay
    // permanently on without any assertion here noticing.
    expect(ordinary.maxEntryBytes).toBeLessThan(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
  });

  it('fires strictly ABOVE the threshold — exactly at it is still `ok` (the count advisory’s boundary)', () => {
    // Spread across several entries (argvTotalling), each far under
    // MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES, so this test isolates the
    // TOTAL-threshold boundary from the per-string condition introduced
    // alongside it (issue #340) — a single giant string here would trip the
    // per-string condition regardless of the total and make this assertion
    // about the wrong term.
    const at = checkCommandLineSizeAdvisory({
      argv: argvTotalling(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES),
      env: {},
      threshold: COMMAND_LINE_ADVISORY_THRESHOLD_BYTES,
    });
    expect(at.bytes).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(at.maxEntryBytes).toBeLessThan(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES);
    expect(at.level).toBe('ok');
    expect(at.message).toBeNull();

    const oneOver = checkCommandLineSizeAdvisory({
      argv: argvTotalling(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES + 1),
      env: {},
    });
    expect(oneOver.bytes).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES + 1);
    expect(oneOver.maxEntryBytes).toBeLessThan(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES);
    expect(oneOver.level).toBe('advisory');
  });

  // ─── The PER-STRING (MAX_ARG_STRLEN) condition (issue #340) ────────────────
  //
  // execve documents E2BIG on TWO independent conditions: the combined total
  // (above) AND a hard cap on any ONE argv/env entry. A reviewer probe
  // demonstrated the gap directly: a single oversized string that passes the
  // total-only advisory comfortably and still kills the spawn. These tests
  // pin the SECOND condition the same way the total is pinned above:
  // strictly-above-threshold boundary, a fires-alone proof, and a negative
  // control.

  it('a SINGLE oversized argv entry trips the advisory even while the TOTAL is comfortably under budget (issue #340)', () => {
    // One entry alone breaches the per-string cap...
    const singleString = 'x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES + 1);
    const advisory = checkCommandLineSizeAdvisory({ argv: [singleString], env: {} });

    // ...while the TOTAL sits nowhere near its own, much larger threshold —
    // this is the exact shape the total-only advisory could not catch.
    expect(advisory.bytes).toBeLessThan(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(advisory.maxEntryBytes).toBeGreaterThan(
      MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES,
    );
    expect(advisory.level).toBe('advisory');
    expect(advisory.message).toContain('PER-STRING');
    expect(advisory.message).toContain('MAX_ARG_STRLEN');
    expect(advisory.message).toContain(
      String(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES),
    );
  });

  it('a SINGLE oversized ENV entry trips the advisory the same way an argv entry does', () => {
    const advisory = checkCommandLineSizeAdvisory({
      argv: ['flotilla-engine'],
      env: { BIG: 'y'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES + 1) },
    });
    expect(advisory.bytes).toBeLessThan(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(advisory.level).toBe('advisory');
  });

  it('the per-string condition fires strictly ABOVE its own threshold — exactly at it is still `ok`', () => {
    const at = checkCommandLineSizeAdvisory({
      argv: ['x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES - 9)],
      env: {},
    });
    expect(at.maxEntryBytes).toBe(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES);
    expect(at.level).toBe('ok');
    expect(at.message).toBeNull();

    const oneOver = checkCommandLineSizeAdvisory({
      argv: ['x'.repeat(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES - 8)],
      env: {},
    });
    expect(oneOver.maxEntryBytes).toBe(MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES + 1);
    expect(oneOver.level).toBe('advisory');
  });

  it('an explicit maxEntryThreshold override is honoured in both directions', () => {
    const argv = ['x'.repeat(1000)];
    expect(
      checkCommandLineSizeAdvisory({ argv, env: {}, maxEntryThreshold: 500 }).level,
    ).toBe('advisory');
    expect(
      checkCommandLineSizeAdvisory({ argv, env: {}, maxEntryThreshold: 500_000 })
        .level,
    ).toBe('ok');
  });

  it('a garbled maxEntryThreshold throws rather than silently disabling the advisory', () => {
    for (const maxEntryThreshold of [Number.NaN, -1, 2.5]) {
      expect(() =>
        checkCommandLineSizeAdvisory({ argv: ['x'], env: {}, maxEntryThreshold }),
      ).toThrow(/non-negative integer/);
    }
  });

  it('the env half is charged too — a small argv with a huge environment still fires', () => {
    // The kernel charges argv and envp to ONE buffer; an advisory that ignored
    // the inherited environment would report `ok` on a spawn that is about to
    // die, which is the exact failure mode this whole term exists to close.
    const advisory = checkCommandLineSizeAdvisory({
      argv: ['flotilla-engine', 'worktree-cleanup'],
      env: { BIG: 'y'.repeat(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES) },
    });
    expect(advisory.level).toBe('advisory');
    expect(advisory.argvBytes).toBeLessThan(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(advisory.envBytes).toBeGreaterThan(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
  });

  it('SECRET-SAFE — the message quotes byte counts only, never an argument or a variable', () => {
    const advisory = checkCommandLineSizeAdvisory({
      argv: ['--body', `sentinel-arg-${'z'.repeat(600_000)}`],
      env: { SENTINEL_VAR_NAME: 'sentinel-var-value' },
    });
    expect(advisory.level).toBe('advisory'); // the message is non-null to inspect
    expect(advisory.message).not.toContain('sentinel-arg');
    expect(advisory.message).not.toContain('SENTINEL_VAR_NAME');
    expect(advisory.message).not.toContain('sentinel-var-value');
    expect(advisory.message).not.toContain('--body');
  });

  it('an explicit threshold override is honoured in both directions', () => {
    const argv = ['x'.repeat(1000)];
    expect(checkCommandLineSizeAdvisory({ argv, env: {}, threshold: 500 }).level).toBe(
      'advisory',
    );
    expect(
      checkCommandLineSizeAdvisory({ argv, env: {}, threshold: 500_000 }).level,
    ).toBe('ok');
  });

  it('a garbled threshold throws rather than silently disabling the advisory', () => {
    for (const threshold of [Number.NaN, -1, 2.5]) {
      expect(() =>
        checkCommandLineSizeAdvisory({ argv: ['x'], env: {}, threshold }),
      ).toThrow(/non-negative integer/);
    }
  });

  it('defaults to THIS process — argv and env are measured first-hand, not estimated', () => {
    const observed = checkCommandLineSizeAdvisory();
    expect(observed.argCount).toBe(process.argv.length);
    expect(observed.threshold).toBe(COMMAND_LINE_ADVISORY_THRESHOLD_BYTES);
    expect(observed.envBytes).toBeGreaterThan(0);
    // `message` is non-null EXACTLY when level is 'advisory' — the same
    // contract WorktreeCountAdvisory carries, so a caller can print on the
    // advisory branch without a null check.
    expect(observed.message === null).toBe(observed.level === 'ok');
  });
});

describe('the count advisory carries the two-term correction (issue #266)', () => {
  it("the count advisory's own text says count alone is not an E2BIG all-clear", () => {
    const advisory = checkWorktreeCountAdvisory({
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD + 1,
    });
    expect(advisory.message).toContain('COUNT IS ONLY ONE OF TWO TERMS');
    expect(advisory.message).toContain('~1019.5 KB');
    expect(advisory.message).toContain('166 sandbox deny paths');
    expect(advisory.message).toContain('checkCommandLineSizeAdvisory');
    // ...and the pre-existing three facts are untouched by the append.
    expect(advisory.message).toContain('E2BIG');
    expect(advisory.message).toContain('subagent');
    expect(advisory.message).toContain('RESTART');
  });

  it('both advisories quote ONE evidence sentence, so the two can never drift apart', () => {
    const fromCount = checkWorktreeCountAdvisory({
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD + 1,
    }).message;
    const fromCmdline = checkCommandLineSizeAdvisory({
      argv: measuredOccurrenceArgv(),
      env: {},
    }).message;
    const evidence = 'COUNT IS ONLY ONE OF TWO TERMS.';

    // Guard the EXTRACTION itself, not just its eventual result (issue #340):
    // `String.prototype.slice` does not throw on a missing marker —
    // `indexOf` silently returns -1, and `slice(-1)` returns just the
    // message's LAST CHARACTER, which then trivially satisfies `toContain`
    // against the other message below (a lone `.` matches almost anything).
    // That silent fallback is the exact vacuous direction a dropped
    // evidence sentence in the COUNT message would exploit — asserting the
    // index explicitly, before slicing, turns it into a hard failure.
    expect(fromCount).not.toBeNull();
    const countIdx = fromCount!.indexOf(evidence);
    expect(countIdx).toBeGreaterThan(-1);

    const shared = fromCount!.slice(countIdx);
    // A meaningful shared BLOCK, not a coincidental token — this is what
    // makes the assertion below meaningful in the SYMMETRIC direction too: if
    // the CMDLINE message instead dropped the evidence, `toContain` fails on
    // its own merits, because `shared` is far too long for a coincidental
    // substring match to paper over.
    expect(shared.length).toBeGreaterThan(200);
    expect(fromCmdline).toContain(shared);
  });
});

// Section 31 ("`worktree-cleanup --detached` — the CLI wiring", issue #250) used
// to live here. Issue #265 moved it to cli.spec.ts, co-located with every other
// `worktree-cleanup` ROUTER spec (the `main([...])`-driven Forms 8/8b–8h) —
// this file keeps only the ENGINE-level coverage (sections above: parseWorktreeList
// through checkWorktreeCountAdvisory's own unit tests) plus the barrel/root-import
// proof directly below, which is not router-level.

// ─── 32. The E2BIG surface is reachable from the PACKAGE ROOT (issue #250) ─────
//
// The detached-sweep trio, `checkWorktreeCountAdvisory` and
// `WORKTREE_COUNT_ADVISORY_THRESHOLD` were engine-complete and spec-covered but
// reachable only via a deep import into `./worktree-cleanup` — the same
// barrel-gap class as `normalizeDisposableNames` (issue #184) and the
// Documented-Form types (issue #216). This block proves a consumer can drive the
// whole surface, and type every option/result it involves, from a PACKAGE-ROOT
// import alone: every symbol used below comes from `./index`.
describe('the detached-sweep + count-advisory surface is reachable from the package root (issue #250)', () => {
  it('all five root-imported bindings are the very same exports, not lookalikes', () => {
    expect(listDetachedScratchpadWorktreesFromRoot).toBe(
      listDetachedScratchpadWorktrees,
    );
    expect(planDetachedScratchpadSweepFromRoot).toBe(planDetachedScratchpadSweep);
    expect(sweepDetachedScratchpadWorktreesFromRoot).toBe(
      sweepDetachedScratchpadWorktrees,
    );
    expect(checkWorktreeCountAdvisoryFromRoot).toBe(checkWorktreeCountAdvisory);
    expect(WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT).toBe(
      WORKTREE_COUNT_ADVISORY_THRESHOLD,
    );
  });

  it('a root-only import types the sweep options, plans a fixture and reads a refusal reason', () => {
    // DetachedSweepOptions + SkipReason, both root-typed. `live-branch` is the
    // sweep's defining refusal, so a consumer that cannot name that type cannot
    // narrow the skip it is most likely to act on.
    const opts: DetachedSweepOptionsFromRoot = {
      repoRoot: '/repo',
      extraRoots: ['scratchpad'],
      skipBranchHygiene: true,
    };
    expect(opts.extraRoots).toEqual(['scratchpad']);

    const candidate: WorktreeEntry = {
      path: '/repo/.claude/worktrees/review-250',
      branch: 'wave/250-staked',
      head: 'deadbeefcafe',
      dirty: false,
      locked: false,
    };
    const plan = planDetachedScratchpadSweepFromRoot([candidate]);
    const reason: SkipReasonFromRoot | undefined = plan.skipped[0]?.reason;
    expect(reason).toBe('live-branch');
  });

  it('a root-only import types the advisory options and its result', () => {
    const opts: WorktreeCountAdvisoryOptionsFromRoot = {
      threshold: WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT,
      countWorktrees: () => WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT + 1,
    };
    const advisory: WorktreeCountAdvisoryFromRoot =
      checkWorktreeCountAdvisoryFromRoot(opts);

    expect(advisory.level).toBe('advisory');
    expect(advisory.threshold).toBe(WORKTREE_COUNT_ADVISORY_THRESHOLD_FROM_ROOT);
    expect(advisory.message).toContain('E2BIG');
  });
});

// ─── 33. The Scribe scratch sweep — a location with no lifecycle (issue #355) ─
//
// Every other population in this file is a WORKTREE that some sweep could not
// SEE. This one accumulated because no sweep was ever written for it: a
// repo-wide grep found `.flotilla/tmp` at four wave-start driver sites and two
// spec sites, and in NO cleanup path at all.
//
// These tests use REAL directories and REAL files throughout (only the
// module-wide `execFileSync` stub stays in place, so `listOrphanDirs`'s
// `git worktree list` call answers empty) — the sweep's whole job is a
// filesystem outcome, and a fixture that never touched disk would prove the
// classifier and nothing about the outcome.
describe('Scribe scratch sweep — listing + classification (issue #355)', () => {
  const tempRoots: string[] = [];

  function makeRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scribe-scratch-')));
    tempRoots.push(root);
    return root;
  }

  /** Create `<root>/.flotilla/tmp` and drop the named entries into it. */
  function seedScratch(root: string, names: string[]): string {
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), '{"ok":true}');
    return dir;
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an absent scratch directory reads as present:false with no entries — never an error', () => {
    const root = makeRepo();

    const listing = listScribeScratchEntries(root);

    expect(listing.present).toBe(false);
    expect(listing.entries).toEqual([]);
    expect(listing.dir).toBe(join(root, SCRIBE_SCRATCH_RELATIVE_DIR));
  });

  it('an EMPTY scratch directory reads present:true — "looked and found nothing" is not "did not look"', () => {
    const root = makeRepo();
    seedScratch(root, []);

    const listing = listScribeScratchEntries(root);

    expect(listing.present).toBe(true);
    expect(listing.entries).toEqual([]);
  });

  it('classifies both Scribe payload kinds as payloads', () => {
    const root = makeRepo();
    seedScratch(root, ['report-355-1.json', 'verdict-355-2.json']);

    const listing = listScribeScratchEntries(root);

    expect(listing.entries.map((e) => e.scribePayload)).toEqual([true, true]);
  });

  it('an opaque row id with dashes and non-numeric segments is still a payload — the id is never parsed', () => {
    const root = makeRepo();
    seedScratch(root, ['report-FOR-90-3.json', 'verdict-abc-def-12.json']);

    const listing = listScribeScratchEntries(root);

    expect(listing.entries.every((e) => e.scribePayload)).toBe(true);
  });

  it('anything NOT matching the payload shape is classified non-payload — a human-parked file is never a payload', () => {
    const root = makeRepo();
    const dir = seedScratch(root, [
      'notes.md',
      'report-355.json', // no iteration segment
      'report-355-1.txt', // wrong extension
      'draft-355-1.json', // an unknown kind
    ]);
    mkdirSync(join(dir, 'a-subdir'), { recursive: true });
    writeFileSync(join(dir, 'a-subdir', 'report-355-1.json'), '{}');

    const listing = listScribeScratchEntries(root);

    expect(listing.entries.every((e) => e.scribePayload === false)).toBe(true);
    // Never recursive: the payload nested one level down is not even listed.
    expect(listing.entries.map((e) => e.path)).not.toContain(
      join(dir, 'a-subdir', 'report-355-1.json'),
    );
  });

  it('planScribeScratchSweep selects payloads and skips everything else with a reason', () => {
    const root = makeRepo();
    seedScratch(root, ['report-355-1.json', 'notes.md']);

    const plan = planScribeScratchSweep(listScribeScratchEntries(root));

    expect(plan.selected.map((e) => e.path.endsWith('report-355-1.json'))).toEqual([true]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('not-a-scribe-payload');
    expect(plan.present).toBe(true);
    expect(plan.dir).toBe(join(root, SCRIBE_SCRATCH_RELATIVE_DIR));
  });

  it('honours a scratchDir override', () => {
    const root = makeRepo();
    const dir = join(root, 'custom', 'scratch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report-355-1.json'), '{}');

    const listing = listScribeScratchEntries(root, { scratchDir: 'custom/scratch' });

    expect(listing.present).toBe(true);
    expect(listing.entries).toHaveLength(1);
    expect(listing.entries[0].scribePayload).toBe(true);
  });
});

describe('Scribe scratch sweep — removal outcome on real files (issue #355)', () => {
  const tempRoots: string[] = [];

  function makeRepoWithPayloads(names: string[]): { root: string; dir: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scribe-scratch-rm-')));
    tempRoots.push(root);
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), '{"ok":true}');
    return { root, dir };
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweepScribeScratch physically deletes the payloads and leaves everything else on disk', () => {
    const { root, dir } = makeRepoWithPayloads([
      'report-355-1.json',
      'verdict-355-1.json',
      'notes.md',
    ]);

    const result = sweepScribeScratch({ repoRoot: root });

    expect(result.removed.map((e) => e.path).sort()).toEqual(
      [join(dir, 'report-355-1.json'), join(dir, 'verdict-355-1.json')].sort(),
    );
    expect(result.errors).toEqual([]);
    expect(existsSync(join(dir, 'report-355-1.json'))).toBe(false);
    expect(existsSync(join(dir, 'verdict-355-1.json'))).toBe(false);
    // The refusal half, verified on disk rather than only in the report.
    expect(result.skipped.map((e) => e.reason)).toEqual(['not-a-scribe-payload']);
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
  });

  it('is idempotent — a second sweep removes nothing and reports present:true, no errors', () => {
    const { root } = makeRepoWithPayloads(['report-355-1.json']);

    sweepScribeScratch({ repoRoot: root });
    const second = sweepScribeScratch({ repoRoot: root });

    expect(second.present).toBe(true);
    expect(second.removed).toEqual([]);
    expect(second.errors).toEqual([]);
  });

  it('a throwing remover lands the payload in errors, never removed', () => {
    const { root, dir } = makeRepoWithPayloads(['report-355-1.json']);
    const remover: ScratchRemover = {
      remove(): void {
        throw new Error('sandbox denied the delete');
      },
    };

    const result = sweepScribeScratch({ repoRoot: root, remover });

    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/sandbox denied the delete/);
    expect(existsSync(join(dir, 'report-355-1.json'))).toBe(true);
  });

  it('verify-after-write: a file still present after a "successful" remove → errors, not removed', () => {
    const { root } = makeRepoWithPayloads(['report-355-1.json']);
    const remover: ScratchRemover = { remove: () => {} }; // reports success, deletes nothing

    const result = sweepScribeScratch({ repoRoot: root, remover });

    expect(result.removed).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/still present after removal/);
  });

  it('defaultScratchRemover is non-recursive — a directory handed to it throws rather than being torn down', () => {
    const { dir } = makeRepoWithPayloads([]);
    mkdirSync(join(dir, 'a-subdir'), { recursive: true });
    writeFileSync(join(dir, 'a-subdir', 'kept.json'), '{}');

    expect(() => defaultScratchRemover().remove(join(dir, 'a-subdir'))).toThrow();
    expect(existsSync(join(dir, 'a-subdir', 'kept.json'))).toBe(true);
  });
});

// ─── 33b. The close path actually REACHES the scratch dir (issue #355) ────────
//
// AC1 is an OUTCOME claim, so it is tested as one: a stray payload is left on
// disk, the close path's own call composition is run, and the cleanup output is
// read. The composition below is byte-for-byte the one `cli.ts`'s
// `runWorktreeCleanup` performs for `--orphans` —
// `executeOrphanSweep(planOrphanSweep(listOrphanDirs(repoRoot, …)), { repoRoot })`
// — so this pins the reachability of the sweep through the ONE flag the close
// ceremony passes unconditionally, not merely the sweep function in isolation.
describe('the --orphans close path reaches the Scribe scratch dir (issue #355)', () => {
  const tempRoots: string[] = [];

  function makeRepo(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'scribe-close-path-')));
    tempRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a stray payload left before the close is reported and gone after it', () => {
    const root = makeRepo();
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report-355-1.json'), '{"issue":"355"}');
    writeFileSync(join(dir, 'verdict-355-1.json'), '{"issue":"355"}');

    // EXACTLY the cli.ts `--orphans` composition.
    const result = executeOrphanSweep(
      planOrphanSweep(listOrphanDirs(root, {})),
      { repoRoot: root },
    );

    expect(result.scratch).toBeDefined();
    expect(result.scratch?.present).toBe(true);
    expect(result.scratch?.dir).toBe(dir);
    expect(result.scratch?.removed.map((e) => e.path).sort()).toEqual(
      [join(dir, 'report-355-1.json'), join(dir, 'verdict-355-1.json')].sort(),
    );
    expect(result.scratch?.errors).toEqual([]);
    expect(existsSync(join(dir, 'report-355-1.json'))).toBe(false);
    expect(existsSync(join(dir, 'verdict-355-1.json'))).toBe(false);
  });

  it('the scratch sweep runs even when the orphan-DIRECTORY plan is empty — the two are independent', () => {
    const root = makeRepo();
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report-355-1.json'), '{}');

    const orphanPlan = planOrphanSweep(listOrphanDirs(root, {}));
    expect(orphanPlan.selected).toEqual([]);
    expect(orphanPlan.skipped).toEqual([]);

    const result = executeOrphanSweep(orphanPlan, { repoRoot: root });

    expect(result.removed).toEqual([]);
    expect(result.scratch?.removed).toHaveLength(1);
  });

  it('a repo where no wave ever dispatched reports present:false — an honest no-op, not silence', () => {
    const root = makeRepo();

    const result = executeOrphanSweep({ selected: [], skipped: [] }, { repoRoot: root });

    expect(result.scratch?.present).toBe(false);
    expect(result.scratch?.removed).toEqual([]);
    expect(result.scratch?.dir).toBe(join(root, SCRIBE_SCRATCH_RELATIVE_DIR));
  });

  it('NEGATIVE CONTROL — without an explicit repoRoot the sweep does not look at all, and the key is absent', () => {
    // The safety gate: a file-deleting sweep never guesses its root from
    // process.cwd(). This is what keeps every pre-existing `executeOrphanSweep`
    // caller (and this very test file's fixture-only sections) from reaching
    // the REAL repo's scratch directory.
    const result = executeOrphanSweep({ selected: [], skipped: [] });

    expect(result.scratch).toBeUndefined();
    expect('scratch' in result).toBe(false);
  });

  it('an entry the sweep refuses survives the close path on disk', () => {
    const root = makeRepo();
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'operator-notes.md'), 'do not delete me');

    const result = executeOrphanSweep(
      planOrphanSweep(listOrphanDirs(root, {})),
      { repoRoot: root },
    );

    expect(result.scratch?.removed).toEqual([]);
    expect(result.scratch?.skipped).toHaveLength(1);
    expect(result.scratch?.skipped[0].reason).toBe('not-a-scribe-payload');
    expect(existsSync(join(dir, 'operator-notes.md'))).toBe(true);
  });

  it('the scratchRemover seam is threaded through the --orphans pass, separate from the orphan-dir remover', () => {
    const root = makeRepo();
    const dir = join(root, '.flotilla', 'tmp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report-355-1.json'), '{}');

    const scratchRemoveSpy = vi.fn((p: string) => rmSync(p));
    const orphanRemoveSpy = vi.fn();

    const result = executeOrphanSweep(
      { selected: [], skipped: [] },
      {
        repoRoot: root,
        remover: { remove: orphanRemoveSpy },
        scratchRemover: { remove: scratchRemoveSpy },
      },
    );

    expect(orphanRemoveSpy).not.toHaveBeenCalled();
    expect(scratchRemoveSpy).toHaveBeenCalledTimes(1);
    expect(result.scratch?.removed).toHaveLength(1);
  });
});

// ─── 34. A loud, per-entry report for the EXHAUSTED erroredStillListed
//     reading (issue #483) ──────────────────────────────────────────────────
//
// Three consecutive wave closes showed the classified-disposable shape
// (`dirtyAllJunk`/`orphanAllJunk`) landing in `erroredStillListed` even AFTER
// both the bounded retry (FOR-84) and the scoped `--force` fallback (issue
// #304) ran against it — the deterministic sandbox write-deny on the
// physical delete that neither mechanism can override. `executeCleanup`
// already holds the one signal that tells that EXHAUSTED reading apart from
// the ordinary TRANSIENT one within the same `erroredStillListed` bucket:
// `forceEligible` (`dirtyAllJunk || orphanAllJunk`). This section pins the
// additive `WorktreeEntry.manualRecovery` surface built from it.
describe('executeCleanup — the EXHAUSTED vs TRANSIENT erroredStillListed reading (issue #483)', () => {
  const NOOP_PAUSE = () => {};

  /**
   * A remover that always throws a genuinely ENOTEMPTY-shaped error (`.code`
   * set, not just the message text) — models a removal git still lists, on
   * every attempt, via the SAME transient-race shape (issue #528)
   * {@link RemovalAttempt}'s `enotempty` flag now inspects. Reuses the
   * file-level {@link makeEnotempty} so this and every other real-`ENOTEMPTY`
   * fixture in this file stay byte-identical in shape.
   */
  function alwaysThrowRemover(): {
    remover: WorktreeRemover;
    removeSpy: ReturnType<typeof vi.fn>;
  } {
    const removeSpy = vi.fn(() => {
      throw makeEnotempty(AGENT_PATH_A);
    });
    return { remover: { remove: removeSpy }, removeSpy };
  }

  /**
   * A remover that always throws a DETERMINISTIC (non-ENOTEMPTY) error — the
   * exact shape a sandboxed harness's own write-deny produces (issue #528),
   * on a worktree `planCleanup` never classified disposable.
   */
  function alwaysThrowDeniedRemover(): {
    remover: WorktreeRemover;
    removeSpy: ReturnType<typeof vi.fn>;
  } {
    const removeSpy = vi.fn(() => {
      const err = new Error(
        `EACCES: permission denied, unlink '${AGENT_PATH_A}/locked/keep.txt'`,
      ) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    return { remover: { remove: removeSpy }, removeSpy };
  }

  it('a dirtyAllJunk-classified worktree still erroredStillListed after the retry AND the force fallback carries manualRecovery naming its own path', () => {
    const { remover, removeSpy } = alwaysThrowRemover();
    const junky: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/483-junky',
      head: 'a'.repeat(40),
      dirty: true,
      dirtyAllJunk: true,
    };

    const result = executeCleanup(
      { selected: [junky], skipped: [] },
      { remover, stillListed: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    // Both the bounded retry AND the scoped force fallback ran: two attempts,
    // both carrying `{ force: true }` (the classifier-disposable override).
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenNthCalledWith(1, AGENT_PATH_A, { force: true });
    expect(removeSpy).toHaveBeenNthCalledWith(2, AGENT_PATH_A, { force: true });

    expect(result.erroredStillListed).toHaveLength(1);
    const entry = result.erroredStillListed[0];
    expect(entry.path).toBe(AGENT_PATH_A);
    expect(entry.manualRecovery).toBeDefined();
    expect(entry.manualRecovery?.message).toMatch(/cannot succeed/i);
    expect(entry.manualRecovery?.message).toMatch(/deterministic/i);
    expect(entry.manualRecovery?.commands).toEqual([
      `git worktree remove --force '${AGENT_PATH_A}'`,
      'git worktree prune',
    ]);
  });

  it('an orphanAllJunk-classified worktree still erroredStillListed after the retry AND the force fallback ALSO carries manualRecovery', () => {
    const { remover } = alwaysThrowRemover();
    const orphanJunky: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: null,
      head: 'a'.repeat(40),
      dirty: false,
      orphan: true,
      orphanAllJunk: true,
    };

    const result = executeCleanup(
      { selected: [orphanJunky], skipped: [] },
      { remover, stillListed: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].manualRecovery).toBeDefined();
    expect(result.erroredStillListed[0].manualRecovery?.commands).toEqual([
      `git worktree remove --force '${AGENT_PATH_A}'`,
      'git worktree prune',
    ]);
  });

  it('a worktree path containing BOTH a space and a non-ASCII character (issue #515) is safely single-quoted in the printed commands', () => {
    // This repo's own checkout path is a ready-made live fixture for this
    // class (two spaces, one typographic en-dash) — the class is otherwise
    // invisible on a CI runner where every path is boring.
    const spacedPath =
      '/Users/neo/Documents/Brain/Freelancer/Projects – Clients/Projektionisten/DSW21/' +
      '06 Development/flotilla/.claude/worktrees/wf_f61d54a0-64f-1';
    const { remover } = alwaysThrowRemover();
    const junky: WorktreeEntry = {
      path: spacedPath,
      branch: 'wave/515-spaced',
      head: 'a'.repeat(40),
      dirty: true,
      dirtyAllJunk: true,
    };

    const result = executeCleanup(
      { selected: [junky], skipped: [] },
      { remover, stillListed: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    expect(result.erroredStillListed).toHaveLength(1);
    const commands = result.erroredStillListed[0].manualRecovery?.commands ?? [];
    expect(commands).toEqual([`git worktree remove --force '${spacedPath}'`, 'git worktree prune']);

    // Prove the check can fail (Convention 11): the UNQUOTED bare form this
    // spec exists to rule out — the pre-fix shape — parses on a POSIX shell
    // as MORE than one argument to `git worktree remove`, so asserting the
    // printed command against that bare interpolation is a genuinely
    // falsifiable claim, not a tautology.
    const bareForm = `git worktree remove --force ${spacedPath}`;
    expect(commands[0]).not.toBe(bareForm);
    expect(bareForm.split(' ').length).toBeGreaterThan(5); // splits into many argv words
    expect(commands[0].startsWith("git worktree remove --force '")).toBe(true);
    expect(commands[0].endsWith("'")).toBe(true);
  });

  it('a PLAIN clean worktree (never classified disposable) that lands in erroredStillListed keeps the TRANSIENT reading — no manualRecovery, today\'s reading unchanged', () => {
    const { remover, removeSpy } = alwaysThrowRemover();
    const clean: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/483-transient',
      head: 'a'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [clean], skipped: [] },
      { remover, stillListed: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    // Neither attempt was force-eligible — plainly clean, never classified.
    expect(removeSpy).toHaveBeenNthCalledWith(1, AGENT_PATH_A, { force: false });
    expect(removeSpy).toHaveBeenNthCalledWith(2, AGENT_PATH_A, { force: false });

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].manualRecovery).toBeUndefined();
    // The transient-shaped entry is byte-identical to the pre-#483 shape.
    expect(result.erroredStillListed[0]).toEqual(clean);
  });

  it('issue #528: a PLAINLY clean worktree whose removal fails with the SAME deterministic (non-ENOTEMPTY) obstruction on both the first attempt and the bounded retry now reads EXHAUSTED, without ever having been classified disposable', () => {
    const { remover, removeSpy } = alwaysThrowDeniedRemover();
    const plainlyClean: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/528-plain',
      head: 'a'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [plainlyClean], skipped: [] },
      { remover, stillListed: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    // Never force-eligible — never classified disposable, exactly like the
    // TRANSIENT case above; that half of the #483 contract is unchanged.
    expect(removeSpy).toHaveBeenNthCalledWith(1, AGENT_PATH_A, { force: false });
    expect(removeSpy).toHaveBeenNthCalledWith(2, AGENT_PATH_A, { force: false });

    expect(result.erroredStillListed).toHaveLength(1);
    const entry = result.erroredStillListed[0];
    expect(entry.manualRecovery).toBeDefined();
    expect(entry.manualRecovery?.message).toMatch(/cannot succeed/i);
    expect(entry.manualRecovery?.message).toMatch(/deterministic/i);
    // Honesty check (the whole point of threading `wasClassifiedDisposable`
    // through `exhaustedManualRecovery`): this worktree was NEVER classified
    // disposable, and the message must not claim otherwise.
    expect(entry.manualRecovery?.message).not.toMatch(/already classified disposable/i);
    expect(entry.manualRecovery?.commands).toEqual([
      `git worktree remove --force '${AGENT_PATH_A}'`,
      'git worktree prune',
    ]);
  });

  it('a genuinely-dirty non-junk worktree never reaches the remover at all, so it can never be misread as EXHAUSTED', () => {
    const { remover, removeSpy } = alwaysThrowRemover();
    const dirtyReal: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/483-real',
      head: 'a'.repeat(40),
      dirty: true,
      dirtyAllJunk: false,
    };

    const plan = planCleanup([dirtyReal]);
    expect(plan.selected).toHaveLength(0);

    const result = executeCleanup(plan, { remover, skipBranchHygiene: true });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(result.erroredStillListed).toHaveLength(0);
  });

  it('deregisteredNotDeleted NEVER carries manualRecovery, even for a classifier-disposable entry — the field is scoped strictly to erroredStillListed', () => {
    const { remover } = fakeRemover(); // never throws
    const junky: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/483-deregistered',
      head: 'a'.repeat(40),
      dirty: true,
      dirtyAllJunk: true,
    };

    const result = executeCleanup(
      { selected: [junky], skipped: [] },
      { remover, pathExists: () => true, retryPause: NOOP_PAUSE, skipBranchHygiene: true },
    );

    expect(result.deregisteredNotDeleted).toHaveLength(1);
    expect(result.deregisteredNotDeleted[0].manualRecovery).toBeUndefined();
    expect(result.erroredStillListed).toHaveLength(0);
  });
});

// ─── 35. The two-run classification flip against a REAL git worktree
//     (issue #528) ──────────────────────────────────────────────────────────
//
// Section 34 pins the EXHAUSTED/TRANSIENT split at the `executeCleanup` unit
// level with hand-built `WorktreeEntry` fixtures and an injected remover —
// sufficient to pin the classification LOGIC, but not to prove the actual
// two-run FLIP the issue reports: that logic alone cannot show run 1's own
// removal attempt is what changes what run 2 then reads.
//
// This section drives the full `listAgentWorktrees` → `planCleanup` →
// `executeCleanup` pipeline TWICE, back to back, against one REAL git
// worktree and one REAL, deterministically-denied physical delete — never a
// hand-set `dirtyAllJunk`/`orphanAllJunk` flag. `rmSync` is mocked
// module-wide (see the file-level comment above `vi.mock('node:fs', ...)`)
// with a PERSISTENT (not one-shot) override so ONE specific path is
// genuinely undeletable on EVERY attempt across BOTH runs, while everything
// else the module tries to delete goes through the REAL `rmSync` — the SAME
// "real fs fixture, one narrow injected throw" idiom Section 10/11 already
// establish for the ENOTEMPTY family, here modelling a deterministic,
// non-ENOTEMPTY denial instead.
describe('the two-run classification flip against a REAL git worktree (issue #528)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;
  let realRmSync: typeof rmSync;

  beforeAll(async () => {
    const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');
    realRmSync = fsActual.rmSync;
    const cpActual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = cpActual.execFileSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    asRmSyncMock(rmSync).mockImplementation((...args: unknown[]) =>
      (realRmSync as unknown as (...a: unknown[]) => void)(...args),
    );
    vi.clearAllMocks();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          realRmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
    }
  });

  /** Real `git`, bypassing the mock — fixture SETUP and independent verification. */
  function realGit(args: string[], cwd: string): string {
    return realExecFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as string;
  }

  /**
   * A real repo with a real worktree under `.claude/worktrees/wf_<name>`,
   * GENUINELY clean at checkout — unlike `makeHarnessDeniedWorktree` (issue
   * #150 section above), NOTHING is pre-deleted here. The worktree's own
   * `.claude/` is its ONLY top-level tracked content besides `.git`, holding:
   *   - `.claude/agents/wave-reviewer.md`  — ordinary, deletable content that
   *     also happens to sit under a `HARNESS_DENIED_DIRS` path (`.claude/
   *     agents`), so a bare unstaged DELETION of it reads disposable.
   *   - `.claude/vendor/data.bin`          — the genuinely-denied content;
   *     `.claude/vendor` is NOT in any disposable allowlist, but since this
   *     fixture ensures it is NEVER actually deleted, it never appears in
   *     `git status` at all and its own name is therefore irrelevant to the
   *     classification this section proves.
   */
  function makeCleanWorktree(name: string): { mainRoot: string; worktreePath: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-528-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(mainRoot, '.claude', 'agents', 'wave-reviewer.md'), 'agent config\n');
    mkdirSync(join(mainRoot, '.claude', 'vendor'), { recursive: true });
    writeFileSync(join(mainRoot, '.claude', 'vendor', 'data.bin'), 'vendored\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'track worktree content'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    const relPath = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', relPath, '-b', `wave/528-${name}`], mainRoot);
    const worktreePath = join(mainRoot, relPath);
    return { mainRoot, worktreePath };
  }

  /** Is `path` still registered per real `git worktree list --porcelain`? */
  function stillRegistered(mainRoot: string, worktreePath: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`);
  }

  /**
   * Installs a PERSISTENT `rmSync` override that models the exact shape a
   * sandboxed harness's write-deny produces mid-delete: the SAME single call
   * `physicallyDeleteGitLast`'s phase 1 makes for this worktree's ONLY
   * top-level entry (`.claude`) really deletes whatever it legitimately can
   * (`.claude/agents`, via the REAL `rmSync`) and leaves the one genuinely
   * undeletable path (`.claude/vendor/data.bin`) exactly as it was, then
   * throws an `EACCES` the SAME way on EVERY subsequent call — first
   * attempt, bounded retry (FOR-84), and any later run alike. The
   * obstruction is deterministic, never a one-shot race: this is what makes
   * the fixture "genuinely denied", not a hand-set flag.
   */
  function installDeterministicDenial(worktreePath: string): void {
    const claudeDir = join(worktreePath, '.claude');
    const agentsDir = join(claudeDir, 'agents');
    const deniedFile = join(claudeDir, 'vendor', 'data.bin');

    asRmSyncMock(rmSync).mockImplementation((...args: unknown[]) => {
      if (args[0] === claudeDir) {
        if (existsSync(agentsDir)) {
          realRmSync(agentsDir, { recursive: true, force: true });
        }
        const err = new Error(
          `EACCES: permission denied, unlink '${deniedFile}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (realRmSync as unknown as (...a: unknown[]) => void)(...args);
    });
  }

  it('AC1/AC2/AC3: run 1 already reads EXHAUSTED (the fix), run 2 reads the SAME, and run 1\'s own partial deletion is CONFIRMED as the mechanism that would otherwise flip run 2 alone', () => {
    const { mainRoot, worktreePath } = makeCleanWorktree('wf_528-flip');

    // Precondition, stated so a failure downstream is unambiguous: the
    // fixture really is clean — the premise the issue itself states ("a
    // clean worktree"), never a pre-set dirtyAllJunk flag.
    const preStatus = realGit(['status', '--porcelain', '--untracked-files=all'], worktreePath);
    expect(preStatus.trim()).toBe('');

    installDeterministicDenial(worktreePath);

    // ── run 1 ──────────────────────────────────────────────────────────────
    const entries1 = listAgentWorktrees(mainRoot);
    expect(entries1).toHaveLength(1);
    expect(entries1[0].dirty).toBe(false); // still clean — nothing has run yet
    expect(entries1[0].dirtyAllJunk).toBeUndefined();

    const plan1 = planCleanup(entries1);
    // Selected as a PLAIN clean worktree — the dirtyAllJunk/orphanAllJunk
    // override in planCleanup is never even reached for it.
    expect(plan1.selected.map((e) => e.path)).toEqual([worktreePath]);

    const result1 = executeCleanup(plan1, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result1.errors).toEqual([]);
    expect(result1.erroredStillListed).toHaveLength(1);
    expect(existsSync(worktreePath)).toBe(true); // still there — not removed
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);

    // THE FIX (AC3): the FIRST run already reads EXHAUSTED, not TRANSIENT.
    const entry1 = result1.erroredStillListed[0];
    expect(entry1.manualRecovery).toBeDefined();
    expect(entry1.manualRecovery?.message).toMatch(/cannot succeed/i);
    expect(entry1.manualRecovery?.message).toMatch(/deterministic/i);

    // ── the partial-deletion mechanism, CONFIRMED (AC2) ──────────────────
    // Run 1's own attempt (plus its internal bounded retry) really deleted
    // `.claude/agents` from disk and could never touch `.claude/vendor`. A
    // completely fresh, independent probe now sees that as `git status`
    // divergence — and, because the deleted path happens to be exactly
    // disposable-shaped, this is exactly the mechanism the issue's
    // hypothesis named: run 1's partial deletion is what would move the
    // worktree into the `dirtyAllJunk` class, were a naive re-run to trust
    // only a fresh classification instead of what just actually happened.
    expect(existsSync(join(worktreePath, '.claude', 'agents'))).toBe(false);
    expect(existsSync(join(worktreePath, '.claude', 'vendor', 'data.bin'))).toBe(true);
    const midStatus = realGit(['status', '--porcelain', '--untracked-files=all'], worktreePath);
    expect(midStatus.split('\n').filter((l) => l.length > 0)).toEqual([
      ' D .claude/agents/wave-reviewer.md',
    ]);

    // ── run 2: a completely fresh, independent invocation (AC1) ──────────
    const entries2 = listAgentWorktrees(mainRoot);
    expect(entries2).toHaveLength(1);
    expect(entries2[0].dirty).toBe(true);
    expect(entries2[0].dirtyAllJunk).toBe(true); // the flip run 2 alone used to need

    const plan2 = planCleanup(entries2);
    // This time selected via the dirtyAllJunk override — a DIFFERENT route
    // through planCleanup than run 1 took.
    expect(plan2.selected.map((e) => e.path)).toEqual([worktreePath]);

    const result2 = executeCleanup(plan2, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result2.erroredStillListed).toHaveLength(1);
    const entry2 = result2.erroredStillListed[0];
    expect(entry2.manualRecovery).toBeDefined();
    // Run 2 reaches EXHAUSTED via the ORIGINAL #483 route (pre-classified
    // disposable) — its wording differs from run 1's (#528 route), and both
    // are equally honest about which route fired.
    expect(entry2.manualRecovery?.message).toMatch(/already classified disposable/i);

    // The worktree is still fully registered and its one undeletable path is
    // still untouched — a re-run genuinely cannot succeed, on either run.
    expect(existsSync(worktreePath)).toBe(true);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
  });
});

// ─── 36. The errno alone cannot carry the denial: ENOTEMPTY can BE the
//     harness write-deny (issue #542) ──────────────────────────────────────
//
// The #528 fix (sections 34/35 above) closes the flip for a NON-ENOTEMPTY
// deterministic denial — its own spec modelled the obstruction as `EACCES`.
// Live measurement on the FIXED engine showed the flip surviving anyway: on
// the real harness the denial itself surfaces AS an `ENOTEMPTY` (the denied
// children make their enclosing directory look "not empty" to the failing
// call), so `!attempt.enotempty` alone reads it as the transient race the
// bounded retry exists to clear. `isSurvivorSetExclusivelyDenied` answers
// from evidence instead — what physically SURVIVED the attempt — and
// `RemovalAttempt.deniedResidue` carries that third signal into
// `executeCleanup`'s EXHAUSTED reading.
describe('executeCleanup — the errno alone cannot carry the denial (issue #542)', () => {
  const NOOP_PAUSE = () => {};
  const tempRoots: string[] = [];

  afterEach(() => {
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

  /** A real temp directory the filesystem residue scan can actually inspect. */
  function makeTempWorktreeDir(prefix: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    tempRoots.push(root);
    return root;
  }

  it('a PLAINLY clean worktree whose ENOTEMPTY-shaped removal leaves ONLY harness-denied paths on disk reads EXHAUSTED on the FIRST run', () => {
    const root = makeTempWorktreeDir('wt-cleanup-542-denied-');
    // Model exactly the SURVIVOR SET the live occurrence measured: only the
    // harness-denied `.claude/skills` subtree (HARNESS_DENIED_DIRS) is still
    // on disk after the (simulated) attempt.
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'foo.txt'), 'skill content\n');

    const removeSpy = vi.fn(() => {
      throw makeEnotempty(root);
    });
    const plainlyClean: WorktreeEntry = {
      path: root,
      branch: 'wave/542-plain',
      head: 'a'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [plainlyClean], skipped: [] },
      {
        remover: { remove: removeSpy },
        stillListed: () => true,
        retryPause: NOOP_PAUSE,
        skipBranchHygiene: true,
      },
    );

    // Never force-eligible — never classified disposable pre-attempt, the
    // same "plainly clean" precondition #528's own subject has.
    expect(removeSpy).toHaveBeenNthCalledWith(1, root, { force: false });
    expect(removeSpy).toHaveBeenNthCalledWith(2, root, { force: false });

    expect(result.erroredStillListed).toHaveLength(1);
    const entry = result.erroredStillListed[0];
    expect(entry.manualRecovery).toBeDefined();
    expect(entry.manualRecovery?.message).toMatch(/cannot succeed/i);
    expect(entry.manualRecovery?.message).toMatch(/deterministic/i);
    // Same honesty check as #528: never claims a plainly-clean worktree was
    // "already classified disposable".
    expect(entry.manualRecovery?.message).not.toMatch(/already classified disposable/i);
    expect(entry.manualRecovery?.commands).toEqual([
      `git worktree remove --force '${root}'`,
      'git worktree prune',
    ]);
  });

  it('a real on-disk survivor set that MIXES denied-path content with genuinely-real leftover content stays TRANSIENT, even though the error is ENOTEMPTY-shaped', () => {
    const root = makeTempWorktreeDir('wt-cleanup-542-mixed-');
    mkdirSync(join(root, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, '.claude', 'skills', 'foo.txt'), 'skill content\n');
    // A genuinely real leftover sits alongside the denied content — nothing
    // here entitles the classifier to call this exhausted; this is the
    // negative control that pins `isSurvivorSetExclusivelyDenied` itself,
    // not just the pre-existing errno-based signal.
    writeFileSync(join(root, 'real-uncommitted-work.txt'), 'not junk\n');

    const removeSpy = vi.fn(() => {
      throw makeEnotempty(root);
    });
    const plainlyClean: WorktreeEntry = {
      path: root,
      branch: 'wave/542-mixed',
      head: 'a'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [plainlyClean], skipped: [] },
      {
        remover: { remove: removeSpy },
        stillListed: () => true,
        retryPause: NOOP_PAUSE,
        skipBranchHygiene: true,
      },
    );

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].manualRecovery).toBeUndefined();
    expect(result.erroredStillListed[0]).toEqual(plainlyClean);
  });

  it('an unreadable/nonexistent worktree path (the same shape every fake-path unit fixture in this file already exercises) never reads EXHAUSTED via the residue signal alone', () => {
    // AGENT_PATH_A is never a real directory — readdirSync on it always
    // throws, and isSurvivorSetExclusivelyDenied must read that as `false`
    // (inconclusive), the OPPOSITE of its sibling isDirExclusivelyJunk's
    // vacuous `true` for an ORPHAN directory. Pins the existing "PLAIN clean
    // worktree ... keeps TRANSIENT" test's own precondition explicitly
    // against the NEW signal, not only the pre-existing errno-based one.
    const removeSpy = vi.fn(() => {
      throw makeEnotempty(AGENT_PATH_A);
    });
    const clean: WorktreeEntry = {
      path: AGENT_PATH_A,
      branch: 'wave/542-fake-path',
      head: 'a'.repeat(40),
      dirty: false,
    };

    const result = executeCleanup(
      { selected: [clean], skipped: [] },
      {
        remover: { remove: removeSpy },
        stillListed: () => true,
        retryPause: NOOP_PAUSE,
        skipBranchHygiene: true,
      },
    );

    expect(result.erroredStillListed).toHaveLength(1);
    expect(result.erroredStillListed[0].manualRecovery).toBeUndefined();
  });
});

// ─── 36b. The flip closed against a REAL git worktree, ENOTEMPTY-shaped
//     denial (issue #542) ───────────────────────────────────────────────────
//
// Section 36 pins the classification LOGIC with hand-built fixtures; this
// section drives the full `listAgentWorktrees` → `planCleanup` →
// `executeCleanup` pipeline against one REAL git worktree and one REAL,
// deterministically-denied physical delete whose thrown errno is genuinely
// `ENOTEMPTY` — mirroring section 35's "real fs fixture, one narrow injected
// throw" idiom, here modelling the real-harness denial shape instead of the
// #528 spec's `EACCES` one.
describe('the classification flip against a REAL git worktree, ENOTEMPTY-shaped denial (issue #542)', () => {
  const tempRoots: string[] = [];
  let realExecFileSync: typeof execFileSync;
  let realRmSync: typeof rmSync;

  beforeAll(async () => {
    const fsActual = await vi.importActual<typeof import('node:fs')>('node:fs');
    realRmSync = fsActual.rmSync;
    const cpActual = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
    realExecFileSync = cpActual.execFileSync;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    asExecFileSyncMock(execFileSync).mockImplementation(
      (...args: unknown[]) =>
        (realExecFileSync as unknown as (...a: unknown[]) => unknown)(...args),
    );
  });

  afterEach(() => {
    asExecFileSyncMock(execFileSync).mockImplementation(() => '');
    asRmSyncMock(rmSync).mockImplementation((...args: unknown[]) =>
      (realRmSync as unknown as (...a: unknown[]) => void)(...args),
    );
    vi.clearAllMocks();
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) {
        try {
          realRmSync(dir, { recursive: true, force: true });
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

  /**
   * A real repo with a real worktree, GENUINELY clean at checkout, whose ONLY
   * tracked content besides `.git` is exactly the harness-denied shape the
   * live occurrence measured: `.claude/settings.json` (HARNESS_DENIED_FILES)
   * and a file under `.claude/skills` (HARNESS_DENIED_DIRS).
   */
  function makeCleanWorktree(name: string): { mainRoot: string; worktreePath: string } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-cleanup-542-')));
    tempRoots.push(root);
    const mainRoot = join(root, 'main');
    mkdirSync(mainRoot, { recursive: true });
    realGit(['init', '-q'], mainRoot);
    realGit(['config', 'user.email', 'test@example.com'], mainRoot);
    realGit(['config', 'user.name', 'Test'], mainRoot);
    realGit(['config', 'core.excludesFile', '/dev/null'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(mainRoot, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(mainRoot, '.claude', 'skills', 'foo.txt'), 'skill\n');
    realGit(['add', '-A'], mainRoot);
    realGit(['commit', '-q', '-m', 'track worktree content'], mainRoot);
    mkdirSync(join(mainRoot, '.claude', 'worktrees'), { recursive: true });
    const relPath = join('.claude', 'worktrees', name);
    realGit(['worktree', 'add', '-q', relPath, '-b', `wave/542-${name}`], mainRoot);
    const worktreePath = join(mainRoot, relPath);
    return { mainRoot, worktreePath };
  }

  /** Is `path` still registered per real `git worktree list --porcelain`? */
  function stillRegistered(mainRoot: string, worktreePath: string): boolean {
    return realGit(['worktree', 'list', '--porcelain'], mainRoot)
      .split('\n')
      .some((line) => line === `worktree ${worktreePath}`);
  }

  /**
   * Installs a PERSISTENT `rmSync` override modelling the exact ENOTEMPTY
   * shape the live occurrence measured: the harness's write-deny lets the
   * TRACKED FILES under the denied paths be unlinked (matching the observed
   * post-run-1 `D` git-status entries), but the enclosing `.claude` directory
   * itself can never be fully cleared — `.claude/skills`, though now empty,
   * is never removed — so the SAME single call `physicallyDeleteGitLast`'s
   * phase 1 makes for `.claude` throws `ENOTEMPTY` on EVERY invocation, first
   * attempt and bounded retry (FOR-84) alike — deterministic, never a
   * one-shot race.
   */
  function installDeterministicEnotemptyDenial(worktreePath: string): void {
    const claudeDir = join(worktreePath, '.claude');
    const settingsFile = join(claudeDir, 'settings.json');
    const skillFile = join(claudeDir, 'skills', 'foo.txt');

    asRmSyncMock(rmSync).mockImplementation((...args: unknown[]) => {
      if (args[0] === claudeDir) {
        if (existsSync(settingsFile)) {
          realRmSync(settingsFile, { force: true });
        }
        if (existsSync(skillFile)) {
          realRmSync(skillFile, { force: true });
        }
        const err = new Error(
          `ENOTEMPTY: directory not empty, rmdir '${claudeDir}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOTEMPTY';
        throw err;
      }
      return (realRmSync as unknown as (...a: unknown[]) => void)(...args);
    });
  }

  it('run 1 already reads EXHAUSTED against a REAL, ENOTEMPTY-shaped harness denial — never needing a second run', () => {
    const { mainRoot, worktreePath } = makeCleanWorktree('wf_542-flip');

    // Precondition: the fixture really is clean at checkout — never a
    // pre-set dirtyAllJunk flag.
    const preStatus = realGit(['status', '--porcelain', '--untracked-files=all'], worktreePath);
    expect(preStatus.trim()).toBe('');

    installDeterministicEnotemptyDenial(worktreePath);

    // ── run 1 ──────────────────────────────────────────────────────────────
    const entries1 = listAgentWorktrees(mainRoot);
    expect(entries1).toHaveLength(1);
    expect(entries1[0].dirty).toBe(false); // still clean — nothing has run yet
    expect(entries1[0].dirtyAllJunk).toBeUndefined();

    const plan1 = planCleanup(entries1);
    expect(plan1.selected.map((e) => e.path)).toEqual([worktreePath]);

    const result1 = executeCleanup(plan1, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });

    expect(result1.errors).toEqual([]);
    expect(result1.erroredStillListed).toHaveLength(1);
    expect(existsSync(worktreePath)).toBe(true);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);

    // THE FIX: the FIRST run already reads EXHAUSTED, not TRANSIENT.
    const entry1 = result1.erroredStillListed[0];
    expect(entry1.manualRecovery).toBeDefined();
    expect(entry1.manualRecovery?.message).toMatch(/cannot succeed/i);
    expect(entry1.manualRecovery?.message).not.toMatch(/already classified disposable/i);

    // Confirm the mechanism: the tracked denied-path files really are gone
    // (matching the live occurrence's post-run-1 `D` entries) while the
    // undeletable `.claude/skills` directory itself survives.
    expect(existsSync(join(worktreePath, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(worktreePath, '.claude', 'skills', 'foo.txt'))).toBe(false);
    expect(existsSync(join(worktreePath, '.claude', 'skills'))).toBe(true);
    const midStatus = realGit(['status', '--porcelain', '--untracked-files=all'], worktreePath);
    expect(midStatus.split('\n').filter((l) => l.length > 0).sort()).toEqual(
      [' D .claude/settings.json', ' D .claude/skills/foo.txt'].sort(),
    );

    // ── run 2: a completely fresh, independent invocation ────────────────
    // Reaches the SAME EXHAUSTED reading, now via the ORIGINAL #483
    // dirtyAllJunk route — confirming run 1's reading was not a fluke, and
    // that this issue's two-run flip is closed for the ENOTEMPTY family too.
    const entries2 = listAgentWorktrees(mainRoot);
    expect(entries2[0].dirty).toBe(true);
    expect(entries2[0].dirtyAllJunk).toBe(true);

    const plan2 = planCleanup(entries2);
    const result2 = executeCleanup(plan2, {
      repoRoot: mainRoot,
      skipBranchHygiene: true,
      retryPause: () => {},
    });
    expect(result2.erroredStillListed).toHaveLength(1);
    expect(result2.erroredStillListed[0].manualRecovery).toBeDefined();
    expect(result2.erroredStillListed[0].manualRecovery?.message).toMatch(
      /already classified disposable/i,
    );

    expect(existsSync(worktreePath)).toBe(true);
    expect(stillRegistered(mainRoot, worktreePath)).toBe(true);
  });
});
