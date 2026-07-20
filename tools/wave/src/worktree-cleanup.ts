/**
 * worktree-cleanup.ts — list and plan safe removal of agent-managed worktrees
 * (`.claude/worktrees/agent-*` and `.claude/worktrees/wf_*`) once their
 * branches are pushed.
 *
 * Cleanup is WORKTREES ONLY — origin branch-pruning is explicitly out of scope.
 *
 * Safety invariant: a dirty worktree (uncommitted changes) is NEVER removed.
 * It is reported and skipped. Only clean worktrees that match a recognized
 * path prefix are selected for removal.
 *
 * Recognized prefixes (allowlist — not every `.claude/worktrees/` child):
 *   - `.claude/worktrees/agent-`  — prose-loop Agent-tool worktrees (#57)
 *   - `.claude/worktrees/wf_`     — Workflow-driver worktrees (#82)
 * A human-created scratch worktree directly under `.claude/worktrees/` that
 * does NOT start with either prefix is never auto-selected.
 *
 * The removal side-effect (`git worktree remove`) is isolated behind the
 * injectable `WorktreeRemover` seam (same pattern as ff-guard.ts's `FfProbe`)
 * so the listing + selection logic is fully tested without touching real worktrees.
 *
 * Atomicity (FOR-34): `executeCleanup` only ever moves an entry into `removed`
 * when `remover.remove()` returns without throwing — a throw always lands the
 * entry in `errors`, never `removed`, so a per-item failure is reported loudly
 * and never silently dropped. The default remover ({@link defaultWorktreeRemover})
 * additionally guarantees this holds against real git, not just the seam
 * contract: it deletes the directory itself BEFORE asking git to deregister,
 * so a failed directory removal never reaches — and therefore never corrupts —
 * git's worktree registration (see that function's doc comment for the
 * live-verified git behaviour this closes).
 *
 * wave-orchestration #57, #82.
 *
 * ── Crash-cleanup before redispatch (FOR-10) ──────────────────────────────────
 *
 * A separate, narrower mechanism lives here too: `cleanupCrashedRowForRedispatch`
 * / `cleanupRedispatchRows`. When `wave-resume`'s reconciler decides a row is
 * `redispatch`, a prior crashed attempt can still have a LOCKED worktree with the
 * wave branch checked out on disk — that collides with a fresh
 * `git checkout -b <branch>` even though it fell outside the plain GC allowlist
 * pass above. This mechanism unlocks + removes that debris and deletes the stale
 * branch ref BEFORE the row is handed back to `wave-start`, mirroring the same
 * work-preservation invariant: a dirty worktree is never destroyed without an
 * explicit `force` acknowledgment. It is deliberately independent of the GC path
 * above (`planCleanup`/`executeCleanup`) — GC only ever touches clean worktrees
 * and never deletes branches; crash-cleanup targets one specific branch's debris
 * and, with `force`, may destroy a dirty worktree on explicit confirmation.
 */

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as nodePath from 'node:path';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * A single git worktree entry as parsed from `git worktree list --porcelain`.
 */
export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** The branch ref name (e.g. `wave-orch/57-worktree-cleanup`), or `null` when HEAD is detached. */
  branch: string | null;
  /** The commit SHA at HEAD for this worktree. */
  head: string;
  /** Whether the worktree has uncommitted changes (dirty). */
  dirty: boolean;
  /**
   * Whether the worktree is `git worktree lock`ed (protected from `remove`/
   * `prune` without `--force`). Optional — pre-existing callers that build a
   * `WorktreeEntry` literal without this field (e.g. resume.spec.ts fixtures)
   * stay valid; absent is treated as not-locked. Populated from the porcelain
   * `locked`/`locked <reason>` line by {@link parseWorktreeList}.
   */
  locked?: boolean;
}

/**
 * The result of a cleanup plan — which worktrees are selected for removal and
 * which are skipped (dirty).
 */
export interface CleanupPlan {
  /** Worktrees selected for removal (agent-path + clean). */
  selected: WorktreeEntry[];
  /** Worktrees that were skipped because they are dirty. */
  skipped: WorktreeEntry[];
}

/**
 * Result of executing a cleanup plan.
 */
export interface CleanupResult {
  /** Worktrees that were successfully removed. */
  removed: WorktreeEntry[];
  /** Worktrees that were skipped (dirty — never removed). */
  skipped: WorktreeEntry[];
  /** Errors encountered during removal (worktree path → error message). */
  errors: Array<{ path: string; message: string }>;
}

/**
 * Removal side-effect seam. The default implementation shells out to git;
 * the spec injects a fixture so tests need no real worktrees.
 */
export interface WorktreeRemover {
  /**
   * Remove a single worktree by its absolute path.
   * Implementations must call `git worktree remove <path>`.
   * Throws on failure.
   */
  remove(worktreePath: string): void;
}

export interface CleanupOptions {
  /**
   * Absolute repo root — the directory where `git worktree list` is invoked and
   * against which the agent-worktree path is resolved.
   * Defaults to `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * Path prefix(es) that identify auto-managed worktrees eligible for cleanup.
   * A worktree path must contain at least one of these substrings to be
   * considered a candidate. This is a bounded allowlist — it does NOT match
   * every child of `.claude/worktrees/`, so a human-created scratch worktree
   * without a recognized prefix is never auto-selected.
   *
   * Defaults to `['.claude/worktrees/agent-', '.claude/worktrees/wf_']`
   * (prose-loop Agent-tool worktrees + Workflow-driver worktrees).
   *
   * Accepts a single string for backward-compatibility (treated as a
   * one-element array).
   */
  agentPathMarker?: string | readonly string[];
  /** Injectable removal seam. Defaults to {@link defaultWorktreeRemover}. */
  remover?: WorktreeRemover;
  /**
   * Optional branch-scoped filter. When provided, a candidate worktree is
   * selected **only if** its checked-out branch is a member of this set (in
   * addition to the existing pushed-and-clean predicate). When absent (the
   * default), all agent worktrees are eligible — the original global-GC
   * behaviour is preserved byte-for-byte.
   *
   * Use this to restrict a `/wave close` Phase 5 run to the branches that
   * belong to the closing wave, so a parallel-wave close does not accidentally
   * remove the sibling wave's still-live worktrees (issue #77).
   */
  branchFilter?: Set<string>;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * The default set of path prefix markers that identify auto-managed worktrees.
 *
 * - `.claude/worktrees/agent-` — prose-loop Agent-tool worktrees (issue #57)
 * - `.claude/worktrees/wf_`   — Workflow-driver worktrees (issue #82)
 *
 * A worktree whose path matches NONE of these prefixes is not auto-selected,
 * preserving the safety invariant that human-created scratch worktrees under
 * `.claude/worktrees/` are never touched.
 */
export const DEFAULT_AGENT_PATH_MARKERS: readonly string[] = [
  '.claude/worktrees/agent-',
  '.claude/worktrees/wf_',
];

/** Normalize the `agentPathMarker` option to an array of substrings. */
function normalizeMarkers(
  marker: string | readonly string[] | undefined,
): string[] {
  if (marker === undefined) return [...DEFAULT_AGENT_PATH_MARKERS];
  return Array.isArray(marker) ? [...(marker as string[])] : [marker as string];
}

/**
 * Returns true if `path` contains at least one of the recognized `markers`.
 * This is a substring check — the marker need not be a path prefix.
 */
function isRecognizedWorktree(path: string, markers: string[]): boolean {
  return markers.some((m) => path.includes(m));
}

/**
 * Parse `git worktree list --porcelain` output into structured `WorktreeEntry`
 * objects, filtered to auto-managed worktrees only (paths matching at least
 * one entry in `agentPathMarkers`).
 *
 * Each worktree block in porcelain output looks like:
 *
 * ```
 * worktree /abs/path/to/wt
 * HEAD <sha>
 * branch refs/heads/<branch-name>
 * ```
 *
 * A detached HEAD block omits the `branch` line. A dirty worktree has a
 * `bare` or no extra info — the dirty flag is determined separately via
 * `git -C <path> status --porcelain`.
 *
 * @param porcelainOutput Raw stdout from `git worktree list --porcelain`.
 * @param agentPathMarker Substring(s) that identify auto-managed worktrees.
 *   Defaults to {@link DEFAULT_AGENT_PATH_MARKERS}. Accepts a single string
 *   for backward-compatibility.
 */
export function parseWorktreeList(
  porcelainOutput: string,
  agentPathMarker: string | readonly string[] = DEFAULT_AGENT_PATH_MARKERS,
): WorktreeEntry[] {
  const markers = normalizeMarkers(agentPathMarker);
  const blocks = porcelainOutput.trim().split(/\n\n+/);
  const entries: WorktreeEntry[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());

    const pathLine = lines.find((l) => l.startsWith('worktree '));
    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const branchLine = lines.find((l) => l.startsWith('branch '));

    if (!pathLine || !headLine) continue;

    const path = pathLine.slice('worktree '.length).trim();
    const head = headLine.slice('HEAD '.length).trim();
    const branch = branchLine
      ? branchLine
          .slice('branch '.length)
          .replace(/^refs\/heads\//, '')
          .trim()
      : null;

    // Filter: only auto-managed worktrees (recognized prefix allowlist).
    if (!isRecognizedWorktree(path, markers)) continue;

    // Dirty flag: the `dirty` line appears in `--porcelain` blocks for
    // worktrees that have uncommitted changes (git 2.36+). We also accept
    // `prunable` (stale) but still check for safety.
    const dirty = lines.some((l) => l === 'dirty');

    // Locked flag: `locked` (no reason) or `locked <reason>` — a worktree
    // git protects from `remove`/`prune` until explicitly unlocked. A crashed
    // worker's worktree can be left locked with its branch still checked out
    // (FOR-10) — crash-cleanup below unlocks it before removal.
    const locked = lines.some((l) => l === 'locked' || l.startsWith('locked '));

    entries.push({ path, branch, head, dirty, locked });
  }

  return entries;
}

/**
 * Build a cleanup plan from a list of already-parsed agent worktrees.
 *
 * Selects only worktrees that are (a) under the agent path AND (b) clean AND
 * (c) in the optional `branchFilter` set when one is provided.
 *
 * A dirty worktree is put in `skipped` and never removed.
 *
 * `listAgentWorktrees` already filters by agent path, so every entry in
 * `worktrees` is an agent worktree — this planner additionally gates on:
 *   1. the `dirty` flag (existing invariant), and
 *   2. the `branchFilter` when provided (issue #77 wave-scoped cleanup).
 *
 * When `branchFilter` is absent (the default), behaviour is byte-identical to
 * the original single-argument form — all clean agent worktrees are selected.
 *
 * @param worktrees Parsed agent worktrees from {@link listAgentWorktrees}.
 * @param branchFilter Optional set of branch names to restrict selection to.
 *   A worktree whose branch is NOT in the set is silently excluded from
 *   `selected` (it is neither selected nor placed in `skipped`). A worktree
 *   with `branch: null` (detached HEAD) is always excluded when a filter is
 *   active (there is nothing to match against).
 */
export function planCleanup(
  worktrees: WorktreeEntry[],
  branchFilter?: Set<string>,
): CleanupPlan {
  const selected: WorktreeEntry[] = [];
  const skipped: WorktreeEntry[] = [];

  for (const wt of worktrees) {
    // When a branch filter is active, skip worktrees whose branch is not in
    // the set (or has no branch — detached HEAD). These are not reported in
    // `skipped` either; they simply fall outside this wave's scope.
    if (branchFilter !== undefined) {
      if (wt.branch === null || !branchFilter.has(wt.branch)) {
        continue;
      }
    }

    if (wt.dirty) {
      skipped.push(wt);
    } else {
      selected.push(wt);
    }
  }

  return { selected, skipped };
}

/**
 * List all auto-managed worktrees for a given repo root, including their dirty
 * state.
 *
 * Shells out to `git worktree list --porcelain` (and optionally
 * `git -C <path> status --porcelain` for git versions that do not emit the
 * `dirty` line in worktree porcelain output).
 *
 * @param repoRoot Absolute path to the repository root. Defaults to `process.cwd()`.
 * @param agentPathMarker Substring(s) that identify auto-managed worktrees.
 *   Defaults to {@link DEFAULT_AGENT_PATH_MARKERS} (`agent-` + `wf_` prefixes).
 *   Accepts a single string for backward-compatibility.
 */
export function listAgentWorktrees(
  repoRoot = process.cwd(),
  agentPathMarker: string | readonly string[] = DEFAULT_AGENT_PATH_MARKERS,
): WorktreeEntry[] {
  const raw = shellGit(['worktree', 'list', '--porcelain'], repoRoot);

  const entries = parseWorktreeList(raw, agentPathMarker);

  // For git versions that don't emit the `dirty` line in porcelain output,
  // we verify each worktree's dirty state via `git status --porcelain`.
  return entries.map((entry) => ({
    ...entry,
    dirty: entry.dirty || isWorktreeDirty(entry.path),
  }));
}

/**
 * List EVERY live worktree for a repo root — no agent-path allowlist filter.
 *
 * Used by the crash-cleanup layer (FOR-10), not the GC path above: a crashed
 * worktree still blocks a fresh `git checkout -b <branch>` for its wave branch
 * regardless of whether its path happens to match the recognized `agent-`/`wf_`
 * prefixes (e.g. a `--marker`-scoped `wave-resume` run, or debris predating a
 * naming-convention change). Crash-cleanup targets one specific row's branch,
 * so over-including here is harmless — only an exact branch match is ever acted
 * on by the caller.
 *
 * Implemented via the empty-string marker (`isRecognizedWorktree` treats `''`
 * as a substring of every path), so this reuses {@link listAgentWorktrees}'s
 * dirty-detection fallback with zero duplicated shelling logic.
 *
 * @param repoRoot Absolute path to the repository root. Defaults to `process.cwd()`.
 */
export function listAllWorktrees(repoRoot = process.cwd()): WorktreeEntry[] {
  return listAgentWorktrees(repoRoot, ['']);
}

/**
 * Execute a cleanup: invoke the remover for each selected-clean worktree,
 * collect errors, and return a structured result.
 *
 * The seam (`remover`) is called ONLY for worktrees in the `selected` set.
 * Dirty/skipped worktrees never reach the remover.
 *
 * Idempotent: if `selected` is empty, returns immediately with no side-effects.
 */
export function executeCleanup(
  plan: CleanupPlan,
  opts: CleanupOptions = {},
): CleanupResult {
  const remover =
    opts.remover ?? defaultWorktreeRemover(opts.repoRoot ?? process.cwd());

  const removed: WorktreeEntry[] = [];
  const errors: Array<{ path: string; message: string }> = [];

  for (const wt of plan.selected) {
    try {
      remover.remove(wt.path);
      removed.push(wt);
    } catch (err) {
      errors.push({
        path: wt.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { removed, skipped: plan.skipped, errors };
}

// ─── Convenience wrapper ───────────────────────────────────────────────────────

/**
 * High-level convenience: list → plan → execute in one call.
 *
 * When `opts.branchFilter` is provided, only worktrees whose branch is in the
 * set are selected (the wave-scoped path, issue #77). Without it, all clean
 * agent worktrees are selected (the original global-GC behaviour).
 *
 * @param opts Cleanup options including injectable seam + optional branch filter.
 */
export function cleanAgentWorktrees(opts: CleanupOptions = {}): CleanupResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const agentPathMarker = opts.agentPathMarker ?? DEFAULT_AGENT_PATH_MARKERS;

  const worktrees = listAgentWorktrees(repoRoot, agentPathMarker);
  const plan = planCleanup(worktrees, opts.branchFilter);
  return executeCleanup(plan, opts);
}

// ─── Crash-cleanup before redispatch (FOR-10) ───────────────────────────────

/**
 * Injectable side-effect seam for crash-cleanup of a single row's stale
 * worktree + branch ahead of a redispatch (mirrors the `WorktreeRemover`
 * pattern used by the GC path above).
 *
 * Contract:
 *   - `unlock` and `deleteBranch` are IDEMPOTENT — implementations MUST NOT
 *     throw when there is nothing to do (already unlocked / branch absent).
 *   - `remove` throws on failure (same contract as `WorktreeRemover.remove`).
 */
export interface RedispatchCleanupOps {
  /** Unlock a worktree at `worktreePath`. No-op if it isn't locked. */
  unlock(worktreePath: string): void;
  /** Remove a worktree. `force: true` is required for a dirty worktree. Throws on failure. */
  remove(worktreePath: string, opts?: { force?: boolean }): void;
  /** Delete a local branch ref. No-op if the branch doesn't exist. */
  deleteBranch(branchName: string): void;
}

/** A row about to be redispatched: the branch to clean, and any live worktree matched to it. */
export interface RedispatchCleanupInput {
  /** The wave branch this row dispatches to (e.g. `wave/FOR-10-resume-cleanup`). */
  branch: string;
  /** The live worktree currently checked out on `branch`, or `null` if none was found. */
  worktree: WorktreeEntry | null;
}

export interface RedispatchCleanupOptions {
  /** Absolute repo root the git side-effects run against. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Injectable seam. Defaults to {@link defaultRedispatchCleanupOps}. */
  ops?: RedispatchCleanupOps;
  /**
   * Explicit override to destroy a DIRTY worktree (uncommitted changes).
   * Defaults to `false` — the work-preservation safety invariant: a dirty
   * worktree is never destroyed silently. Without `force`, a dirty worktree
   * is reported via `blockedByDirty: true` and left untouched (worktree AND
   * branch — the branch stays checked out there, so deleting it would fail
   * anyway).
   */
  force?: boolean;
}

export interface RedispatchCleanupResult {
  branch: string;
  /** Absolute path of the worktree found for `branch`, or `null` if none was found. */
  worktreePath: string | null;
  /** Whether the worktree (if any) was locked before this call. */
  wasLocked: boolean;
  /** Whether the worktree (if any) had uncommitted changes before this call. */
  wasDirty: boolean;
  /** Whether the worktree was actually removed by this call. */
  worktreeRemoved: boolean;
  /** Whether the branch ref is confirmed absent after this call. */
  branchDeleted: boolean;
  /** True when a dirty worktree blocked cleanup — surfaced, not destroyed, `force` was not set. */
  blockedByDirty: boolean;
  /** Human-readable trace of what happened, in order. */
  notes: string[];
}

/**
 * Clean up ONE row's crashed worktree + stale branch ahead of a redispatch.
 *
 * Preserves the reconciler's work-preservation posture (mirrors the
 * adopt-beats-redispatch precedence in resume.ts): a DIRTY worktree is never
 * destroyed without an explicit `force` acknowledgment — it is surfaced via
 * `blockedByDirty: true` instead, exactly like a dirty worktree is never
 * silently removed by the GC path (`planCleanup`) above.
 *
 * Idempotent: safe to call repeatedly for the same branch —
 *   - no worktree found → no-op unlock/remove; branch delete is still
 *     attempted (idempotent by the `ops` contract — a no-op if already gone).
 *   - `remove` failing (e.g. a permission error) leaves the branch untouched
 *     (it would still fail to delete while checked out there) rather than
 *     silently reporting false success.
 *
 * Ordering when a worktree IS found and cleanup proceeds: unlock (if locked)
 * → remove → delete branch. A branch cannot be deleted while still checked
 * out in a worktree, so the branch delete only runs after a successful (or
 * unnecessary) worktree removal.
 */
export function cleanupCrashedRowForRedispatch(
  input: RedispatchCleanupInput,
  opts: RedispatchCleanupOptions = {},
): RedispatchCleanupResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const ops = opts.ops ?? defaultRedispatchCleanupOps(repoRoot);
  const force = opts.force ?? false;
  const wt = input.worktree;
  const notes: string[] = [];

  if (wt && wt.dirty && !force) {
    notes.push(
      `worktree at ${wt.path} has uncommitted changes — refusing to remove without explicit force (work-preservation)`,
    );
    return {
      branch: input.branch,
      worktreePath: wt.path,
      wasLocked: wt.locked ?? false,
      wasDirty: true,
      worktreeRemoved: false,
      branchDeleted: false,
      blockedByDirty: true,
      notes,
    };
  }

  let worktreeRemoved = false;
  let removeFailed = false;

  if (wt) {
    if (wt.locked) {
      ops.unlock(wt.path);
      notes.push(`unlocked worktree at ${wt.path}`);
    }
    try {
      ops.remove(wt.path, { force: wt.dirty });
      worktreeRemoved = true;
      notes.push(`removed worktree at ${wt.path}`);
    } catch (err) {
      removeFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      notes.push(
        `worktree remove failed for ${wt.path}: ${message} — branch left in place (still checked out there)`,
      );
    }
  } else {
    notes.push('no live worktree found for this branch — nothing to unlock/remove');
  }

  let branchDeleted = false;
  if (!removeFailed) {
    ops.deleteBranch(input.branch);
    branchDeleted = true;
    notes.push(`deleted branch ${input.branch} (idempotent — no-op if already absent)`);
  }

  return {
    branch: input.branch,
    worktreePath: wt?.path ?? null,
    wasLocked: wt?.locked ?? false,
    wasDirty: wt?.dirty ?? false,
    worktreeRemoved,
    branchDeleted,
    blockedByDirty: false,
    notes,
  };
}

/** The minimal row shape `cleanupRedispatchRows` needs — structurally satisfied by `RowReconstruction`. */
export interface RedispatchRow {
  branch: string | null;
  decision: string;
}

/**
 * Batch crash-cleanup: run {@link cleanupCrashedRowForRedispatch} for every row
 * whose `decision === 'redispatch'`, matching each against `worktrees` by
 * branch. Rows with any other decision, or a `null` branch, are skipped —
 * this function never touches an `adopt`/`keep`/`needs-attention` row's
 * worktree (those either resume in place or are paused for a human).
 *
 * Accepts a structural `RedispatchRow[]` (not `resume.ts`'s `RowReconstruction`
 * directly) so this module never imports from `resume.ts` — `resume.ts`
 * already imports `WorktreeEntry` from here; this avoids a cycle.
 */
export function cleanupRedispatchRows(
  rows: readonly RedispatchRow[],
  worktrees: readonly WorktreeEntry[],
  opts: RedispatchCleanupOptions = {},
): RedispatchCleanupResult[] {
  const worktreeByBranch = new Map<string, WorktreeEntry>();
  for (const w of worktrees) {
    if (w.branch) worktreeByBranch.set(w.branch, w);
  }

  const ops = opts.ops ?? defaultRedispatchCleanupOps(opts.repoRoot ?? process.cwd());

  const results: RedispatchCleanupResult[] = [];
  for (const row of rows) {
    if (row.decision !== 'redispatch' || !row.branch) continue;
    results.push(
      cleanupCrashedRowForRedispatch(
        { branch: row.branch, worktree: worktreeByBranch.get(row.branch) ?? null },
        { ...opts, ops },
      ),
    );
  }
  return results;
}

/**
 * Default {@link RedispatchCleanupOps} backed by real git.
 * `unlock` and `deleteBranch` swallow failures (idempotent by contract);
 * `remove` propagates failures (same contract as {@link defaultWorktreeRemover}).
 */
export function defaultRedispatchCleanupOps(repoRoot: string): RedispatchCleanupOps {
  return {
    unlock(worktreePath: string): void {
      try {
        execFileSync('git', ['worktree', 'unlock', nodePath.resolve(worktreePath)], {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // Already unlocked (or never locked) — idempotent no-op.
      }
    },
    remove(worktreePath: string, removeOpts?: { force?: boolean }): void {
      const abs = nodePath.resolve(worktreePath);
      const args = ['worktree', 'remove', abs];
      if (removeOpts?.force) args.push('--force');
      execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
    deleteBranch(branchName: string): void {
      try {
        execFileSync('git', ['branch', '-D', branchName], {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // Branch already gone — idempotent no-op.
      }
    },
  };
}

// ─── Default git probe (real side-effects, isolated here) ──────────────────

/**
 * Default {@link WorktreeRemover} backed by real git.
 *
 * Two-phase removal (FOR-34 — the deregister-despite-failed-rm orphan fix):
 *
 *   1. Physically delete the worktree directory ourselves via `fs.rmSync`.
 *      If this throws (`EACCES`/`EPERM` from a sandbox, `ENOTEMPTY` from a
 *      file the OS refuses to unlink, ...) we propagate immediately — no git
 *      command has run yet, so git's registration is completely untouched.
 *   2. Only once the directory is confirmed gone do we call
 *      `git worktree remove <path>` to deregister it.
 *
 * This deliberately does NOT delegate the directory deletion to
 * `git worktree remove` itself. Live-verified git behaviour (FOR-34): when
 * `git worktree remove` cannot fully delete the directory tree (e.g. a
 * subdirectory it cannot open), it still DEREGISTERS the worktree from
 * `.git/worktrees/` before/regardless of reporting the deletion failure —
 * the CLI exits non-zero, but the git-side damage (an orphaned physical
 * directory no `git worktree` command can see any more) is already done.
 * Splitting the two steps here means our own removal step is the one that
 * can fail loudly WITHOUT git ever being told to forget the worktree.
 *
 * Once the directory is already gone, `git worktree remove` on that path
 * succeeds cleanly (git detects the now-"prunable" administrative entry) —
 * no `--force` needed, since removal is not gated on a dirty-tree check for
 * a directory that no longer exists.
 */
export function defaultWorktreeRemover(repoRoot: string): WorktreeRemover {
  return {
    remove(worktreePath: string): void {
      // `git worktree remove` requires an absolute path or relative-from-cwd.
      // We pass absolute to be unambiguous.
      const abs = nodePath.resolve(worktreePath);
      // Step 1 — physical deletion. `force: true` only suppresses the
      // exception for an ALREADY-missing path (idempotent re-run); it does
      // NOT swallow real errors like permission or non-empty-directory
      // failures, which is exactly the loud-failure behaviour we need.
      rmSync(abs, { recursive: true, force: true });
      // Step 2 — deregister. Reached only if step 1 fully succeeded.
      execFileSync('git', ['worktree', 'remove', abs], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function shellGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    const out =
      typeof (err as { stdout?: unknown }).stdout === 'string'
        ? (err as { stdout: string }).stdout
        : '';
    return out;
  }
}

/** Check if a worktree has uncommitted changes via `git status --porcelain`. */
function isWorktreeDirty(worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    // If git status fails (e.g. path no longer exists), treat as not dirty
    // (the worktree is stale/gone — removal would be a no-op anyway).
    return false;
  }
}
