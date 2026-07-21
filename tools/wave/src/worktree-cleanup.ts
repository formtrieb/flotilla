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
 * ── macOS ENOTEMPTY hardening (FOR-45) ────────────────────────────────────────
 *
 * Live finding W9-F1 (docs/retros/2026-07-20-landing-seam-w9.md): the physical
 * step-1 delete above errored `ENOTEMPTY` on every worktree in a wave close, with
 * a Finder-created `.DS_Store` as the suspected obstruction — macOS Finder (or
 * Spotlight) can recreate housekeeping files in a directory the instant it goes
 * empty, racing our own recursive delete so the final `rmdir` sees a
 * "non-empty" directory again. {@link defaultWorktreeRemover} now treats a
 * small, fixed allowlist of known Finder junk (`.DS_Store` etc. — see
 * `isFinderJunkName`) as deletable debris: on `ENOTEMPTY` it purges any junk
 * found under the worktree and retries the physical delete exactly ONCE. If no
 * junk was found, the original error is propagated unchanged — this can never
 * be used to route around a real (non-junk) obstruction, and never touches the
 * dirty-worktree safety invariant above (dirtiness is decided entirely upstream
 * in {@link planCleanup}, before a worktree ever reaches the remover).
 *
 * The same incident's error text rendered a non-ASCII path segment (an en dash)
 * as mojibake. {@link describeError} centralizes error-message extraction with
 * an explicit UTF-8 decode rather than an implicit/platform-default one, so a
 * path with non-ASCII segments always renders correctly.
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
 *
 * ── Editor/harness junk-class hardening (FOR-56) ──────────────────────────────
 *
 * Live finding W12-F2 (docs/retros/2026-07-20-preflight-hardening-w12.md): worktree
 * removal failed ENOTEMPTY on all five wave worktrees in a close (`errors:5,
 * removed:0`) although every worktree was clean at the git-status snapshot taken
 * upstream in `planCleanup` — the VS Code extension host, still attached to a
 * worktree after its agent exited, wrote post-agent leftovers into it
 * (`.vscode/settings.json`, a `.claude/agents/<file>` remnant, plus a NESTED
 * `.DS_Store`) during the physical delete, racing it exactly like the FOR-45
 * Finder race above — just from a different actor. The FOR-45 junk purge only
 * recognized individual Finder-junk FILE names; it had no notion of an entire
 * editor/harness-owned DIRECTORY as disposable, so `.vscode/settings.json` and
 * the `.claude/agents/` remnant were never purged and the retry kept failing.
 *
 * `JUNK_DIR_NAMES` (`.vscode`, `.claude`) extends the purge pass
 * ({@link removeAllowlistedJunk}, the FOR-45 `removeFinderJunk` generalized) so
 * that a directory whose OWN name matches is purged as a single allowlisted unit
 * — its entire subtree, at whatever depth it is found — rather than requiring
 * every file inside it to individually match a known junk name. This is
 * deliberately a fixed two-name allowlist, never a wildcard/dot-dir glob (a bare
 * `.*` would also swallow `.git`), matching the same "small, fixed allowlist"
 * discipline as `FINDER_JUNK_NAMES`.
 *
 * This purge pass runs ONLY after `defaultWorktreeRemover`'s initial physical
 * delete already threw `ENOTEMPTY` on a worktree `planCleanup` already decided
 * was safe to remove (git-clean, upstream, unchanged by this hardening — see the
 * dedicated regression test in the spec file). It is not a second dirty-content
 * gate: exactly like the FOR-45 Finder-junk case, once a worktree has reached
 * the remover at all, ordinary co-resident content is torn down along with it as
 * part of the full worktree teardown — the purge's only job is breaking the
 * ENOTEMPTY race, never deciding removal eligibility (that stays entirely in
 * `planCleanup`'s `git status --porcelain` check, per the dirty-worktree
 * safety invariant at the top of this file).
 *
 * ── Orphan-dir misclassification + skip reasons + local branch hygiene (FOR-59) ──
 *
 * W13 close evidence: six junk-only orphan worktree dirs — deregistered by git
 * (`prunable` in `git worktree list --porcelain`) while their physical
 * directories, holding nothing but the exact FOR-56 editor/harness junk shape,
 * still sat on disk — were ALL misclassified `dirty: true` and skipped, so the
 * junk purge-then-retry above never even got a chance. Root cause: `git status
 * --porcelain` (and `git rev-parse --show-toplevel`) invoked with `cwd` set to
 * such a directory does not error — since `.claude/worktrees/<id>` sits INSIDE
 * the parent checkout, git silently walks UP and resolves against the nearest
 * ANCESTOR repository instead, reporting THAT repo's status. One unrelated
 * untracked file at the parent repo root was enough to flip every orphaned
 * dir's classification.
 *
 * The fix is a TOPLEVEL GUARD: `probeWorktreeGitState` (used by
 * `listAgentWorktrees`) resolves `git rev-parse --show-toplevel` for the
 * worktree path FIRST. A `git status --porcelain` call there is trusted only
 * when the resolved toplevel equals the worktree path itself — the ordinary,
 * still-registered case, where the probe's result is byte-for-byte the
 * pre-FOR-59 behaviour. Otherwise the directory is `orphan: true` and NO git
 * status call is ever attempted; `listAgentWorktrees` instead classifies it
 * directly against the junk allowlist via `isDirExclusivelyJunk` (the
 * read-only counterpart to `removeAllowlistedJunk` above) — all-junk sets
 * `orphanAllJunk: true` so `planCleanup` selects it for the ordinary removal
 * pipeline (which purges + removes it cleanly — see the two-phase
 * `defaultWorktreeRemover` doc comment above; a deregistered-but-still-present
 * worktree directory removes via the exact same `rmSync`-then-`git worktree
 * remove` sequence, live-verified), while any real file present skips it with
 * `reason: 'orphan-with-real-files'` instead. `planCleanup` additionally now
 * tags every `locked` worktree `reason: 'locked'` up front (previously it
 * reached the remover and failed loudly as an `errors` entry instead) — every
 * entry `planCleanup` places in `skipped` carries a machine-readable `reason`.
 *
 * ── Local branch hygiene — a W13/W14 accumulation follow-up (FOR-59 scope
 *    extension) ──
 *
 * Second accumulation observed live: every Workflow-driver worktree leaves its
 * harness throwaway branch (`worktree-wf_<run>-<n>` — the branch `isolation:
 * 'worktree'` checks out FIRST, before the dispatched agent `git checkout -b`'s
 * away to its real work branch) behind once the worktree is removed, and every
 * landed row leaves its local `wave/<id>-<slug>` branch behind too (a
 * squash-merge means a plain `git branch -d` merged-check refuses it forever).
 * `executeCleanup` now runs `runBranchHygiene` after each worktree it actually
 * removes/purges, via the injectable `BranchHygieneOps` seam (same injection
 * pattern as `WorktreeRemover`/`RedispatchCleanupOps`):
 *   (a) `worktree-<dir-basename>`, when it is `wf_`-shaped, is ALWAYS
 *       force-deleted — by construction its tip sits on the wave anchor
 *       commit, so it can never carry unique work (live-verified: a fresh
 *       `wf_*` Workflow worktree's throwaway branch and `main` share a tip
 *       the instant the worktree is created).
 *   (b) the worktree's own checked-out branch, when it is `wave/`-shaped, is
 *       force-deleted ONLY when there is merge evidence — its upstream is
 *       confirmed gone (`[gone]`, the git track marker; wave-close deletes the
 *       remote after a successful squash-merge) OR its tip is already
 *       contained in the default branch.
 *   (c) — the safety floor for both — a branch checked out in ANY live
 *       worktree is never deleted; `listCheckedOutBranches()` is queried fresh
 *       on every call, so a branch THIS removal just vacated reads as free
 *       while one still live elsewhere does not.
 * This is deliberately independent of, and additive to, the plain worktree
 * removal above — `skipBranchHygiene: true` (or the FOR-10 crash-cleanup path,
 * which never calls `executeCleanup` at all) opts a caller out entirely.
 *
 * ── remote-ref-gone — a third rule-(b) signal (FOR-62 — a W14 accumulation
 *    follow-up) ──────────────────────────────────────────────────────────────
 *
 * Live finding (docs/retros/2026-07-21-afk-polish-w14.md, W14-F1): rule (b)'s
 * two signals — upstream-gone, tip-contained-in-default — structurally never
 * fire for a wave dispatch branch in this repo's actual close flow. Workers
 * push without `-u` (no upstream is ever configured, so `[gone]` can never
 * appear), and `wave-close` lands every row via a SQUASH merge (the tip commit
 * is never an ancestor of the default branch). Nine `wave/*` locals had
 * accumulated after 13 waves — exactly the accumulation rule (b) exists to stop.
 *
 * `runBranchHygiene` now also accepts **remote-ref-gone** as merge evidence:
 * `ops.probeRemoteRef(branch)` asks the remote, authoritatively, whether a ref
 * for exactly that branch name still exists — `wave-close` deletes the remote
 * branch immediately after a successful squash-merge, so a confirmed-absent
 * remote ref IS the merge evidence the other two signals can't produce here.
 * This is an ADDITIONAL sufficient condition alongside (not a replacement for)
 * the existing two — any one of the three still qualifies a branch for rule (b).
 *
 * The safety-critical part is the FAILURE case: a probe that could not
 * authoritatively determine "no ref" (network/transport error, a non-zero exit
 * that is not git's own "no match" signal) must never be read as `gone` — that
 * would turn a flaky network into silent data loss of a real, unlanded branch.
 * {@link RemoteRefProbeResult} is therefore a 3-way discriminated union
 * (`'gone' | 'present' | 'probe-failed'`) rather than a boolean, so the
 * distinction is STRUCTURAL — carried in the return type itself — not inferred
 * by the caller from "was stdout empty". {@link defaultBranchHygieneOps}'s
 * implementation uses `git ls-remote --exit-code --heads origin <branch>`:
 * git's own `--exit-code` contract exits `2` for an authoritatively-empty
 * match (this is `gone`) and a DIFFERENT non-zero status for every other
 * failure mode (network error, auth failure, remote unreachable — all
 * `probe-failed`, carrying a machine-readable `reason`, NEVER treated as
 * `gone`). A `probe-failed` branch is left alone by rule (b) — never deleted
 * — but unlike the pre-existing "no evidence at all" refusal (silent, as
 * before), it is NOT silent: `runBranchHygiene` records a
 * {@link BranchHygieneSkip} (`reason: 'branch-probe-failed'`, plus the
 * probe's own detail) onto {@link CleanupResult.branchHygieneSkipped} — the
 * caller-visible surface, not just the ops-level `RemoteRefProbeResult` the
 * seam itself returns — because an inconclusive probe is the one outcome a
 * human reading the cleanup result cannot already infer from "the branch
 * didn't move" (iter-2 coordinator resolution on top of the FOR-62 slice).
 *
 * A note on the non-throwing success branch itself: exit 0 is `present`
 * UNCONDITIONALLY (never inferred from stdout length) — real
 * `git ls-remote --exit-code` never exits 0 with empty stdout, a genuine
 * no-match is always the structural exit-2 case above.
 */

import { execFileSync } from 'node:child_process';
import { rmSync, readdirSync, realpathSync } from 'node:fs';
import type { Dirent } from 'node:fs';
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
  /**
   * True when this worktree's own git context does NOT resolve to itself —
   * a deregistered/prunable directory where `git status`/`git rev-parse`
   * silently fall back to an ANCESTOR repository instead of erroring
   * (FOR-59, W13 close finding: `.claude/worktrees/<id>` sits INSIDE the
   * parent checkout, so that ancestor is the very main repo). Populated
   * only by `listAgentWorktrees`'s toplevel-guarded probe
   * ({@link probeWorktreeGitState}) — never by `parseWorktreeList` alone
   * (pure text parsing, no filesystem access). Absent/undefined for an
   * ordinary, still-registered worktree.
   */
  orphan?: boolean;
  /**
   * Present only when `orphan` is true: whether the directory's own content
   * is EXCLUSIVELY allowlisted editor/harness/Finder junk (the same
   * `FINDER_JUNK_NAMES` ∪ `JUNK_DIR_NAMES` allowlist
   * {@link removeAllowlistedJunk} purges, checked read-only by
   * {@link isDirExclusivelyJunk}). `planCleanup` selects such an entry for
   * removal; any real file present makes this `false` and the entry is
   * skipped instead (FOR-59).
   */
  orphanAllJunk?: boolean;
  /**
   * Present only on an entry `planCleanup` places into
   * `CleanupPlan.skipped` / `CleanupResult.skipped` (FOR-59) — names the
   * machine-readable skip cause. Absent on a `selected` entry, and absent
   * on a bare `parseWorktreeList`/`listAgentWorktrees` result before
   * `planCleanup` has run.
   */
  reason?: SkipReason;
}

/** Machine-readable cause a `planCleanup` skip is tagged with (FOR-59). */
export type SkipReason = 'dirty' | 'locked' | 'orphan-with-real-files';

/**
 * The result of a cleanup plan — which worktrees are selected for removal and
 * which are skipped (each tagged with a {@link SkipReason}, FOR-59).
 */
export interface CleanupPlan {
  /** Worktrees selected for removal (agent-path + clean, or orphan+all-junk). */
  selected: WorktreeEntry[];
  /** Worktrees that were skipped, each carrying a `reason` (FOR-59). */
  skipped: WorktreeEntry[];
}

/**
 * Result of executing a cleanup plan.
 */
export interface CleanupResult {
  /** Worktrees that were successfully removed. */
  removed: WorktreeEntry[];
  /** Worktrees that were skipped (never removed) — each carries a `reason`. */
  skipped: WorktreeEntry[];
  /** Errors encountered during removal (worktree path → error message). */
  errors: Array<{ path: string; message: string }>;
  /**
   * Local branches force-deleted as a side-effect of a successful removal in
   * this call (FOR-59) — the harness throwaway (`worktree-wf_*`) and/or the
   * worktree's own dispatch branch, when merge evidence allowed it. Empty
   * when hygiene is disabled (`skipBranchHygiene: true`) or nothing was
   * eligible.
   */
  branchesDeleted: string[];
  /**
   * `wave/*` branches local-branch hygiene left in place because their
   * FOR-62 remote-ref probe FAILED (network/transport error) rather than
   * authoritatively confirming presence or absence — additive surface for
   * the "skipped with a machine-readable reason" AC (see
   * {@link BranchHygieneSkip}). Distinct from `branchesDeleted` (nothing
   * here was deleted) and from the ordinary "no merge evidence at all"
   * refusal, which stays a silent no-op exactly as before FOR-62. Empty
   * when hygiene is disabled (`skipBranchHygiene: true`) or nothing hit
   * this case.
   */
  branchHygieneSkipped: BranchHygieneSkip[];
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
  /**
   * Default/protected branch name used by the local-branch-hygiene rule (b)
   * "tip contained in default branch" check (FOR-59). Defaults to `'main'`
   * — flotilla's protected default branch (CHARTER/CLAUDE.md convention).
   */
  defaultBranch?: string;
  /** Injectable local-branch-hygiene seam. Defaults to {@link defaultBranchHygieneOps}. */
  branchHygiene?: BranchHygieneOps;
  /**
   * Opt out of local-branch hygiene entirely — `executeCleanup` then behaves
   * exactly like pre-FOR-59: only the worktree itself is ever touched.
   * Defaults to `false` (hygiene runs after every successful removal/purge).
   */
  skipBranchHygiene?: boolean;
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

    // A locked worktree is never auto-selected — git itself refuses to
    // `remove` one without an explicit unlock/--force. Surfaced here as a
    // machine-readable skip rather than reaching the remover and failing
    // loudly as an `errors` entry instead (FOR-59).
    if (wt.locked) {
      skipped.push({ ...wt, reason: 'locked' });
      continue;
    }

    // Deregistered/prunable/orphan directory (FOR-59): its `dirty` flag was
    // never trusted for this path in the first place — see
    // `probeWorktreeGitState` in `listAgentWorktrees` — so classify it
    // directly from the pre-computed content scan instead. All-junk →
    // selected for the ordinary removal pipeline (which purges + removes it
    // cleanly, see the file-level doc comment); any real file → skipped
    // with a reason, never silently dropped.
    if (wt.orphan) {
      if (wt.orphanAllJunk) {
        selected.push(wt);
      } else {
        skipped.push({ ...wt, reason: 'orphan-with-real-files' });
      }
      continue;
    }

    if (wt.dirty) {
      skipped.push({ ...wt, reason: 'dirty' });
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
  // we verify each worktree's dirty state via a toplevel-guarded probe
  // (FOR-59 — see `probeWorktreeGitState`'s doc comment for why the guard
  // exists: an unguarded `git status --porcelain` silently leaks an
  // ancestor repository's status for a deregistered/prunable directory).
  return entries.map((entry) => {
    // Porcelain already reported dirty — trust it outright, no further
    // probing needed (byte-for-byte the pre-FOR-59 short-circuit).
    if (entry.dirty) return entry;

    const probe = probeWorktreeGitState(entry.path);
    if (probe.orphan) {
      return {
        ...entry,
        dirty: false,
        orphan: true,
        orphanAllJunk: isDirExclusivelyJunk(entry.path),
      };
    }
    return { ...entry, dirty: probe.dirty };
  });
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
  const repoRoot = opts.repoRoot ?? process.cwd();
  const remover = opts.remover ?? defaultWorktreeRemover(repoRoot);
  const hygieneEnabled = opts.skipBranchHygiene !== true;
  const branchHygiene = hygieneEnabled
    ? (opts.branchHygiene ?? defaultBranchHygieneOps(repoRoot))
    : null;
  const defaultBranch = opts.defaultBranch ?? 'main';

  const removed: WorktreeEntry[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const branchesDeleted: string[] = [];
  const branchHygieneSkipped: BranchHygieneSkip[] = [];

  for (const wt of plan.selected) {
    try {
      remover.remove(wt.path);
      removed.push(wt);
      // Local branch hygiene (FOR-59) — best-effort, additive: it runs only
      // after a successful removal/purge, and never affects `removed`/
      // `errors` classification. See `runBranchHygiene`'s doc comment for
      // the exact per-branch rules.
      if (branchHygiene) {
        const hygieneResult = runBranchHygiene(wt, branchHygiene, defaultBranch);
        branchesDeleted.push(...hygieneResult.deleted);
        branchHygieneSkipped.push(...hygieneResult.skipped);
      }
    } catch (err) {
      errors.push({
        path: wt.path,
        message: describeError(err),
      });
    }
  }

  return { removed, skipped: plan.skipped, errors, branchesDeleted, branchHygieneSkipped };
}

/**
 * Local branch hygiene after ONE successful worktree removal/purge (FOR-59
 * scope extension — see the file-level doc comment's dedicated section for
 * the full accumulation writeup). Two independent branches are considered:
 *
 *   (a) the harness's own THROWAWAY branch, `worktree-<dir-basename>` — only
 *       relevant when that derived name is itself `wf_`-shaped (i.e. `wt`
 *       is a Workflow-driver worktree). ALWAYS force-deleted: by
 *       construction its tip sits on the wave anchor commit, so it can
 *       never carry unique work.
 *   (b) the worktree's OWN checked-out branch (`wt.branch`), when it looks
 *       like a wave dispatch branch (`wave/...`) — force-deleted ONLY when
 *       there is merge evidence: its upstream is confirmed gone, its tip is
 *       already contained in the default branch, or (FOR-62) the remote ref
 *       for this exact branch name is authoritatively confirmed gone (see
 *       the file-level "remote-ref-gone" doc section above — this is the
 *       signal that actually fires in this repo's no-upstream/squash-merge
 *       close flow). A `probe-failed` remote-ref result is NEVER treated as
 *       evidence — it contributes nothing, exactly like "no evidence" from
 *       the other two checks. No signal present → real, unlanded work (or an
 *       inconclusive probe) → left alone.
 *
 * Rule (c), the safety floor for both: `listCheckedOutBranches()` is
 * queried FRESH on every call (i.e. after this worktree's own removal
 * already happened) — a branch still checked out in some OTHER live
 * worktree is never deleted.
 *
 * Returns the branch names actually deleted (0, 1, or 2 entries) alongside
 * any {@link BranchHygieneSkip} entries — today, only ever populated when
 * rule (b)'s remote-ref probe itself FAILED (FOR-62 coordinator resolution):
 * the ordinary "no merge evidence at all" refusal is NOT recorded here and
 * remains a silent no-op, exactly as before FOR-62.
 */
function runBranchHygiene(
  wt: WorktreeEntry,
  ops: BranchHygieneOps,
  defaultBranch: string,
): { deleted: string[]; skipped: BranchHygieneSkip[] } {
  const deleted: string[] = [];
  const skipped: BranchHygieneSkip[] = [];
  const checkedOut = ops.listCheckedOutBranches();

  const throwaway = `worktree-${nodePath.basename(wt.path)}`;
  if (/^worktree-wf_/.test(throwaway) && !checkedOut.has(throwaway)) {
    ops.deleteBranch(throwaway);
    deleted.push(throwaway);
  }

  const dispatchBranch = wt.branch;
  if (
    dispatchBranch !== null &&
    dispatchBranch !== throwaway &&
    dispatchBranch.startsWith('wave/') &&
    !checkedOut.has(dispatchBranch)
  ) {
    if (
      ops.isUpstreamGone(dispatchBranch) ||
      ops.isContainedInDefaultBranch(dispatchBranch, defaultBranch)
    ) {
      ops.deleteBranch(dispatchBranch);
      deleted.push(dispatchBranch);
    } else {
      // Neither earlier signal fired — the remote-ref probe (FOR-62) is the
      // deciding evidence. Its full result (not just a boolean) is inspected
      // here so a genuine `probe-failed` can be threaded onto the
      // caller-visible `CleanupResult.branchHygieneSkipped`, distinct from a
      // `present` result (authoritatively NOT evidence — correctly left
      // alone, nothing ambiguous to report).
      const probe = ops.probeRemoteRef(dispatchBranch);
      if (probe.status === 'gone') {
        ops.deleteBranch(dispatchBranch);
        deleted.push(dispatchBranch);
      } else if (probe.status === 'probe-failed') {
        skipped.push({
          branch: dispatchBranch,
          reason: 'branch-probe-failed',
          detail: probe.reason,
        });
      }
    }
  }

  return { deleted, skipped };
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
      const message = describeError(err);
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

// ─── Local branch hygiene (FOR-59) ──────────────────────────────────────────

/**
 * Result of an authoritative remote-ref probe for ONE branch name (FOR-62 —
 * see the file-level "remote-ref-gone" doc section for the full writeup). A
 * discriminated union, deliberately NOT a boolean: a probe that
 * authoritatively confirms no matching ref (`'gone'`) must be structurally
 * distinguishable from a probe that simply could not complete
 * (`'probe-failed'`) — the latter is NEVER treated as evidence of deletion,
 * no matter how empty its output looked.
 */
export type RemoteRefProbeResult =
  | { status: 'gone' }
  | { status: 'present' }
  | { status: 'probe-failed'; reason: string };

/**
 * Machine-readable cause recorded on {@link CleanupResult.branchHygieneSkipped}
 * (FOR-62 coordinator resolution) — today the only member is the case where
 * rule (b)'s remote-ref probe itself FAILED (network/transport error) rather
 * than authoritatively confirming the branch present or gone. This is
 * deliberately NOT recorded for the pre-existing "no evidence at all" refusal
 * (all three signals came back negative/absent) — that stays the silent,
 * unremarkable no-op it always was; only an inconclusive PROBE is surfaced,
 * because that is the one outcome a human/caller cannot already infer from
 * "the branch didn't move".
 */
export type BranchHygieneSkipReason = 'branch-probe-failed';

/**
 * One `wave/*` branch that local-branch hygiene left in place because its
 * FOR-62 remote-ref probe could not authoritatively complete — additive,
 * caller-visible surface (see {@link CleanupResult.branchHygieneSkipped})
 * distinct from the ops-level {@link RemoteRefProbeResult} the seam itself
 * returns, which the caller of `executeCleanup` never sees directly.
 */
export interface BranchHygieneSkip {
  /** The `wave/*` branch left in place. */
  branch: string;
  /** Machine-readable cause. */
  reason: BranchHygieneSkipReason;
  /** Human-readable detail carried over from the underlying probe's `reason`. */
  detail: string;
}

/**
 * Injectable local-branch-hygiene seam, mirroring the
 * `WorktreeRemover`/`RedispatchCleanupOps` injection pattern above. All
 * methods are read/best-effort — `deleteBranch` is IDEMPOTENT (no-op, never
 * throws, if the branch is already absent), matching
 * `RedispatchCleanupOps.deleteBranch`'s contract.
 */
export interface BranchHygieneOps {
  /**
   * Every branch name currently checked out across ALL live worktrees (this
   * repo's primary checkout included) — queried fresh on every call so a
   * branch a just-completed removal vacated is correctly seen as free.
   */
  listCheckedOutBranches(): Set<string>;
  /**
   * True when `branch`'s configured upstream is confirmed gone (the git
   * `[gone]` track marker) — merge evidence for rule (b). False both when
   * there is no upstream configured at all and when the upstream is still
   * live — never a false positive.
   */
  isUpstreamGone(branch: string): boolean;
  /**
   * True when `branch`'s tip commit is an ancestor of (contained in)
   * `defaultBranch` — the other merge-evidence path for rule (b). False on
   * any error (invalid ref, `defaultBranch` absent locally, etc.) — never a
   * false positive.
   */
  isContainedInDefaultBranch(branch: string, defaultBranch: string): boolean;
  /**
   * Authoritative remote-ref probe for exactly `branch` (FOR-62) — a third,
   * additional merge-evidence path for rule (b): `wave-close` deletes the
   * remote branch right after a successful squash-merge, so a confirmed-gone
   * remote ref is merge evidence even when neither upstream-tracking nor
   * tip-containment can ever fire (no `-u` push, squash merge). MUST return
   * `'probe-failed'` — never `'gone'` — for anything short of an
   * authoritative "no matching ref" answer from the remote (network error,
   * non-zero exit that isn't the remote's own "not found" signal, timeout,
   * ...); see {@link RemoteRefProbeResult}.
   */
  probeRemoteRef(branch: string): RemoteRefProbeResult;
  /**
   * Force-delete a local branch ref. MUST NOT throw when the branch is
   * already absent (idempotent no-op).
   */
  deleteBranch(branch: string): void;
}

/**
 * Default {@link BranchHygieneOps} backed by real git.
 */
export function defaultBranchHygieneOps(repoRoot: string): BranchHygieneOps {
  return {
    listCheckedOutBranches(): Set<string> {
      const raw = shellGit(['worktree', 'list', '--porcelain'], repoRoot);
      const branches = new Set<string>();
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('branch ')) {
          branches.add(
            trimmed
              .slice('branch '.length)
              .replace(/^refs\/heads\//, '')
              .trim(),
          );
        }
      }
      return branches;
    },
    isUpstreamGone(branch: string): boolean {
      try {
        const out = execFileSync(
          'git',
          ['for-each-ref', '--format=%(upstream:track)', `refs/heads/${branch}`],
          {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        return out.trim() === '[gone]';
      } catch {
        return false;
      }
    },
    isContainedInDefaultBranch(branch: string, defaultBranch: string): boolean {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', branch, defaultBranch], {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return true; // exit 0 → branch IS an ancestor of defaultBranch.
      } catch {
        // exit 1 (not an ancestor) OR any other error (invalid ref, missing
        // defaultBranch locally, ...) — both mean "no evidence", never
        // treated as a false positive.
        return false;
      }
    },
    probeRemoteRef(branch: string): RemoteRefProbeResult {
      // `--exit-code` is git's own authoritative "did we find a match" signal:
      // exit 0 with output = at least one matching ref found; exit 2 = the
      // remote was reached successfully and reported NO matching ref for
      // exactly this branch name (git's documented "no matching refs" exit
      // code) — THIS, and only this, is `gone`. Any other outcome (a
      // different non-zero status, a thrown error with no `status` at all —
      // e.g. `git` itself missing, a timeout, DNS/network failure) is a probe
      // that could not authoritatively answer and is always `probe-failed`,
      // never `gone` — the gone-vs-failure distinction is carried by the exit
      // status itself, not inferred from whether stdout happened to be empty.
      try {
        execFileSync(
          'git',
          ['ls-remote', '--exit-code', '--heads', 'origin', branch],
          {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 15_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        // Exit 0 is git's own "at least one matching ref found" signal —
        // `present` UNCONDITIONALLY. Real `git ls-remote --exit-code` never
        // exits 0 with empty stdout (a true no-match is always the `2` exit
        // handled in the catch below), so there is no stdout-length case to
        // infer from here; doing so would contradict the exit-code-is-the-
        // only-authority contract this function documents (FOR-62 iter-2 fix).
        return { status: 'present' };
      } catch (err) {
        const exitStatus = (err as { status?: unknown }).status;
        if (exitStatus === 2) return { status: 'gone' };
        return { status: 'probe-failed', reason: describeError(err) };
      }
    },
    deleteBranch(branch: string): void {
      try {
        execFileSync('git', ['branch', '-D', branch], {
          cwd: repoRoot,
          encoding: 'utf-8',
          timeout: 15_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // Already gone — idempotent no-op (mirrors
        // defaultRedispatchCleanupOps.deleteBranch's contract).
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
      try {
        rmSync(abs, { recursive: true, force: true });
      } catch (err) {
        if (!isEnotempty(err)) throw err;

        // macOS/editor-host reality (FOR-45 Finder race, generalized by
        // FOR-56 to editor/harness junk classes): Finder/Spotlight — or a
        // still-attached VS Code extension host — can recreate housekeeping
        // files (`.DS_Store`, `.vscode/settings.json`, a `.claude/agents/`
        // remnant) in a directory the instant it becomes empty, racing our
        // recursive delete so the final rmdir sees a "non-empty" directory
        // again. Purge known junk (files anywhere, plus whole allowlisted
        // junk directories per {@link JUNK_DIR_NAMES}) and retry ONCE. A
        // worktree with zero junk found was never junk-shaped to begin with
        // — propagate the ORIGINAL error unchanged rather than masking a
        // real obstruction.
        const junkRemoved = removeAllowlistedJunk(abs);
        if (junkRemoved === 0) throw err;

        try {
          rmSync(abs, { recursive: true, force: true });
        } catch (retryErr) {
          throw new Error(
            `worktree removal still failed after purging ${junkRemoved} allowlisted-junk item(s) at ${abs}: ${describeError(retryErr)}`,
          );
        }
      }
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

/**
 * Known macOS Finder / Spotlight housekeeping debris (FOR-45). A FIXED
 * allowlist of names/patterns only — never a wildcard — so purging it can
 * never be used to route around the dirty-worktree safety invariant: a real
 * (non-junk, e.g. actually-uncommitted) file is never touched by this pass,
 * and the never-removed-when-dirty guarantee is decided entirely upstream in
 * {@link planCleanup} anyway (a dirty worktree never reaches the remover).
 */
const FINDER_JUNK_NAMES = new Set<string>([
  '.DS_Store',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
]);

/** AppleDouble sidecar files macOS can drop for xattr-bearing files (e.g. `._foo.txt`). */
const APPLE_DOUBLE_PATTERN = /^\._/;

function isFinderJunkName(name: string): boolean {
  return FINDER_JUNK_NAMES.has(name) || APPLE_DOUBLE_PATTERN.test(name);
}

/**
 * Editor/harness junk DIRECTORY names (FOR-56 — see the file-level "Editor/
 * harness junk-class hardening" doc comment for the live incident this
 * closes). Unlike {@link FINDER_JUNK_NAMES} (individual junk FILE names,
 * recognized wherever found), a name in this set marks an entire subtree as
 * a single allowlisted purge unit: once a directory's own name matches, its
 * whole contents are purged without inspecting individual file names inside
 * it — a `.vscode/` or `.claude/` directory is itself editor/harness-owned
 * debris in this worktree-teardown context.
 *
 * Exactly two fixed names — never a wildcard/dot-dir glob (a bare `.*` would
 * also swallow `.git`) — keeps this allowlist conservative, matching the
 * same fixed-set discipline as `FINDER_JUNK_NAMES`.
 */
const JUNK_DIR_NAMES = new Set<string>(['.vscode', '.claude']);

function isJunkDirName(name: string): boolean {
  return JUNK_DIR_NAMES.has(name);
}

/** True when `err` is a Node errno exception with `code === 'ENOTEMPTY'`. */
function isEnotempty(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOTEMPTY'
  );
}

/**
 * Recursively delete known junk debris (FOR-45 Finder files, FOR-56
 * editor/harness directories) from a directory tree. Returns the count of
 * junk entries removed, so the caller can tell whether an `ENOTEMPTY` was
 * junk-shaped (>0 → worth retrying) or something else entirely (0 →
 * propagate the original error, never mask a real obstruction).
 *
 * Two allowlist tiers:
 *   - {@link FINDER_JUNK_NAMES} / the AppleDouble pattern — individual junk
 *     FILE names, recognized at any depth (nested `.DS_Store` included).
 *   - {@link JUNK_DIR_NAMES} — whole directory trees (`.vscode/`, `.claude/`)
 *     purged as one allowlisted unit the moment the directory's own name
 *     matches, at any depth, without recursing into it to check individual
 *     file names first.
 *
 * Best-effort: an unreadable/already-gone directory, or a junk entry that
 * itself fails to delete, does not throw here — it simply isn't counted, and
 * the retry `rmSync` back in {@link defaultWorktreeRemover} is what surfaces
 * any real obstruction that remains.
 */
function removeAllowlistedJunk(dir: string): number {
  let removed = 0;

  function readEntries() {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
  }
  const entries = readEntries();
  if (entries === null) return removed;

  for (const entry of entries) {
    const entryPath = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isJunkDirName(entry.name)) {
        // Whole allowlisted editor/harness directory tree (FOR-56): purge it
        // as a single unit rather than recursing name-by-name into it.
        try {
          rmSync(entryPath, { recursive: true, force: true });
          removed += 1;
        } catch {
          // Best-effort, same rationale as the file-level catch below — the
          // retry rmSync surfaces whatever obstruction remains.
        }
        continue;
      }
      removed += removeAllowlistedJunk(entryPath);
      continue;
    }
    if (isFinderJunkName(entry.name)) {
      try {
        rmSync(entryPath, { force: true });
        removed += 1;
      } catch {
        // Leave it — the retry in defaultWorktreeRemover surfaces whatever
        // obstruction remains; we never want a partial junk-delete failure
        // to mask itself as a thrown error from this best-effort pass.
      }
    }
  }

  return removed;
}

/**
 * True when every entry inside `dir` (recursively) is allowlisted
 * editor/harness/Finder junk — the READ-ONLY counterpart to
 * {@link removeAllowlistedJunk}, used to CLASSIFY an orphan directory
 * (FOR-59) rather than delete anything. The actual purge for a directory
 * this returns `true` for happens later, in `defaultWorktreeRemover`'s
 * existing physical-delete step, once `planCleanup` has selected the entry
 * for removal — this function never touches the filesystem beyond reading
 * it.
 *
 * An unreadable or already-gone directory counts as vacuously all-junk
 * (`true`) — there is nothing real left to lose.
 */
function isDirExclusivelyJunk(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isJunkDirName(entry.name)) continue;
      if (!isDirExclusivelyJunk(nodePath.join(dir, entry.name))) return false;
      continue;
    }
    if (!isFinderJunkName(entry.name)) return false;
  }
  return true;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Extract a human-readable message from a thrown value, decoding explicitly
 * as UTF-8 rather than relying on an implicit/platform-default conversion.
 *
 * Defensive hardening (FOR-45): the live incident (docs/retros/2026-07-20-
 * landing-seam-w9.md) saw a worktree-removal error render a non-ASCII path
 * segment as mojibake (an en dash decoded as "â"). A thrown `Error`'s
 * `.message` is normally already a correctly-encoded JS string, but a raw
 * errno/stderr payload can in principle arrive as a `Buffer` — decoding that
 * implicitly (or with a non-UTF-8 encoding) is what corrupts multi-byte
 * characters. This helper is the single place that turns "whatever was
 * thrown" into a string, and it always decodes as UTF-8.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const raw: unknown = err.message;
    return Buffer.isBuffer(raw) ? Buffer.from(raw).toString('utf-8') : String(raw);
  }
  if (Buffer.isBuffer(err)) return Buffer.from(err).toString('utf-8');
  return String(err);
}

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

/**
 * Resolve `git rev-parse --show-toplevel` for `cwd`, or `null` when git
 * cannot resolve one at all (`cwd` doesn't exist, or truly no `.git` exists
 * anywhere in its ancestry).
 */
function resolveGitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Resolve symlinks for a stable path comparison (macOS's `/tmp` →
 * `/private/tmp`, etc.); falls back to a plain `path.resolve` when the path
 * cannot be `realpath`'d (already gone, or a fixture path that never
 * existed on disk).
 */
function realpathForCompare(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return nodePath.resolve(p);
  }
}

/**
 * Toplevel-guarded dirty/orphan probe for ONE worktree path (FOR-59 — see
 * the file-level doc comment's dedicated section for the full live-incident
 * writeup).
 *
 * `git status --porcelain` invoked with `cwd` set to a deregistered/
 * prunable worktree directory does not error — it silently resolves to the
 * nearest ANCESTOR repository (since `.claude/worktrees/<id>` sits INSIDE
 * the parent checkout) and reports THAT repo's status instead. The guard:
 * resolve the git toplevel for the worktree path FIRST, and only trust a
 * `git status` call there when it resolves back to the worktree path
 * itself — the ordinary, still-registered-worktree case, where this
 * probe's `dirty` result is exactly the pre-FOR-59 `isWorktreeDirty`
 * behaviour, unchanged.
 *
 * When the toplevel does not self-resolve (including when git cannot
 * resolve one at all), `orphan: true` is returned and NO git status call is
 * even attempted — the caller ({@link listAgentWorktrees}) falls back to a
 * content-based classification instead of trusting any git-derived signal
 * for this path.
 */
function probeWorktreeGitState(worktreePath: string): {
  dirty: boolean;
  orphan: boolean;
} {
  const toplevel = resolveGitToplevel(worktreePath);
  const selfScoped =
    toplevel !== null &&
    realpathForCompare(toplevel) === realpathForCompare(worktreePath);

  if (!selfScoped) {
    return { dirty: false, orphan: true };
  }

  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { dirty: out.trim().length > 0, orphan: false };
  } catch {
    // If git status fails (e.g. path no longer exists), treat as not dirty
    // (the worktree is stale/gone — removal would be a no-op anyway).
    return { dirty: false, orphan: false };
  }
}
