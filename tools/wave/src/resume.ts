/**
 * resume.ts — the durable-state reconciler (ADR-0002, the load-bearing M1 resume).
 *
 * A PURE function: it takes three already-gathered durable inputs — the spine
 * fine-state, the live `git worktree list` (parsed + dirtied by the skill), and
 * the on-disk sidecars — and returns a per-row reconstruction + adopt/redispatch
 * decision. It performs NO I/O and NEVER reads the tracker (the tracker claims are
 * healed FROM this reconstruction, never into it — one-way, ADR-0002).
 *
 * Scope boundary (deliberate): `resume()` projects each row to a ClaimRung only —
 * it CANNOT reach `done`/`available` (those are derived from native PR-merge /
 * eligibility, not from any fine state — see coarse-projection.ts). Reaching
 * `done` for a row whose PR merged during the kill is the SKILL's separate
 * post-resume merge-reconcile phase (a 4th, PR-state input the skill probes and
 * applies); it is intentionally not part of the pure reconciler.
 */

import type { Spine } from './wave-md-rw';
import { branchesByIssueId } from './wave-md-rw';
import type { WorktreeEntry } from './worktree-cleanup';
import { ISSUE_STATES, type IssueState } from './stop-condition-state-machine';
import { coarse } from './coarse-projection';
import type { ClaimRung } from './contract';
import type { SidecarIndex } from './sidecar';
import type { WorkerReport } from './worker-report-schema';
import type { ReviewerVerdict } from './reviewer-verdict-schema';

export interface ResumeInputs {
  spine: Spine;
  /** Live worktrees, pre-filtered to the wave's agentPathMarker + dirtied by the skill. */
  worktrees: WorktreeEntry[];
  sidecars: SidecarIndex;
}

export type ResumeDecision = 'adopt' | 'redispatch' | 'keep' | 'needs-attention';

export interface RowReconstruction {
  id: string;
  branch: string | null;
  /** Disk-corrected fine state (never below the spine's, never above disk truth). */
  reconstructedState: IssueState;
  decision: ResumeDecision;
  /**
   * Coarse rung to re-project to the tracker, or `null` for a `parked` row —
   * "no claim to hold" (ADR-0022). The skill executes a `null` as `unclaim()`,
   * NOT as a rung write; re-projecting it is idempotent (the issue is already
   * released back to the derived `available` pool).
   */
  coarse: ClaimRung | null;
  worktree: WorktreeEntry | null;
  latestReport: WorkerReport | null;
  reportIter: number | null;
  latestVerdict: ReviewerVerdict | null;
  verdictIter: number | null;
  notes: string[];
}

export interface ResumeResult {
  rows: RowReconstruction[];
  /** Rows needing manual disposition (orphaned in-flight claim or corrupt sidecar). */
  fatals: { id: string; reason: string }[];
}

const ISSUE_STATE_SET = new Set<string>(ISSUE_STATES);
/**
 * Past-the-gate / terminal states resume never downgrades and never redispatches.
 *
 * `parked` (ADR-0022 §Decisions 4) belongs here for three reasons, each pinned by
 * a spec: it must not be reconstructed forward off a stale sidecar (that would
 * re-claim a released issue on every resume), a leftover worktree from a
 * `failed → parked` row must never be adopted (no work-carryover promise — a
 * future wave starts fresh from its own anchor), and it must not fall through to
 * the orphan branch, which would raise needs-attention on a deliberate decision.
 */
const TERMINAL = new Set<IssueState>(['approved', 'pr-created', 'failed', 'abandoned', 'parked']);
/** "Spawn may never have landed" states where a redispatch is safe. */
const PRE_LANDING = new Set<IssueState>(['planned', 'dispatched', 're-dispatched']);

export function resume(inputs: ResumeInputs): ResumeResult {
  const branchOf = branchesByIssueId(inputs.spine);
  const worktreeByBranch = new Map<string, WorktreeEntry>();
  for (const w of inputs.worktrees) {
    if (w.branch) worktreeByBranch.set(w.branch, w);
  }

  const rows: RowReconstruction[] = [];
  const fatals: { id: string; reason: string }[] = [];

  for (const row of inputs.spine.planTable) {
    const id = row.id;
    const notes: string[] = [];
    const branch = branchOf[id] ?? row.branch ?? null;
    const worktree = branch ? worktreeByBranch.get(branch) ?? null : null;

    const reportHit = inputs.sidecars.reportFor(id);
    const verdictHit = inputs.sidecars.verdictFor(id);
    const corrupt = inputs.sidecars.corruptFor(id);

    // spine state must be a known fine state; otherwise the row is unroutable.
    if (!ISSUE_STATE_SET.has(String(row.state))) {
      const reason = `unknown spine state "${row.state}"`;
      notes.push(reason);
      fatals.push({ id, reason });
      rows.push(mkRow(id, branch, 'failed', 'needs-attention', worktree, reportHit, verdictHit, notes));
      continue;
    }
    const spineState = row.state as IssueState;

    // a corrupt sidecar makes the row unroutable — never silently route/backfill.
    if (corrupt.length > 0) {
      const reason = `corrupt sidecar(s): ${corrupt.map((c) => `${c.kind}@${c.iter}`).join(', ')}`;
      notes.push(reason);
      fatals.push({ id, reason });
      rows.push(mkRow(id, branch, spineState, 'needs-attention', worktree, reportHit, verdictHit, notes));
      continue;
    }

    // ── reconstruct the fine state from the latest DURABLE artifact ──
    // disk beats a non-landed spine flip (ADR-0002): the state is whatever the
    // newest sidecar proves, NOT what the spine claims. A missing verdict sidecar
    // under a spine `verdict-in` downgrades to `report-in` (the flip never landed);
    // a fresh report (iter > the verdict's) is `report-in` even from a stale
    // `reviewing`/`verdict-in` (a re-dispatch restarted the review cycle).
    let reconstructed = spineState;
    if (!TERMINAL.has(spineState)) {
      if (verdictHit && (!reportHit || verdictHit.iter >= reportHit.iter)) {
        reconstructed = 'verdict-in';
      } else if (reportHit) {
        reconstructed = 'report-in';
        if (verdictHit) {
          notes.push(
            `report@${reportHit.iter} newer than verdict@${verdictHit.iter} → report-in (awaiting review)`,
          );
        }
      }
      if (reconstructed !== spineState) {
        notes.push(`reconstructed ${spineState} → ${reconstructed} from disk (beats non-landed spine flip)`);
      }
    }

    // ── decision ──
    let decision: ResumeDecision;
    if (TERMINAL.has(reconstructed)) {
      decision = 'keep';
    } else if (reportHit || verdictHit) {
      decision = 'adopt'; // durable progress on disk — resume from it, never redispatch (would duplicate landed work)
    } else if (worktree) {
      decision = 'adopt'; // worktree landed but no report → worker died mid-run; re-run into the same tree
      notes.push(worktree.dirty ? 'worktree dirty, no report → adopt-redispatch in place' : 'worktree clean, no report → adopt');
    } else if (PRE_LANDING.has(reconstructed)) {
      decision = 'redispatch'; // nothing on disk, no worktree → the spawn never landed; safe to (re)create
    } else {
      // claims in-flight progress but every durable artifact is gone → orphan
      decision = 'needs-attention';
      const reason = `orphaned in-flight claim (state ${reconstructed}, no worktree, no sidecar)`;
      notes.push(reason);
      fatals.push({ id, reason });
    }

    rows.push(mkRow(id, branch, reconstructed, decision, worktree, reportHit, verdictHit, notes));
  }

  return { rows, fatals };
}

function mkRow(
  id: string,
  branch: string | null,
  reconstructedState: IssueState,
  decision: ResumeDecision,
  worktree: WorktreeEntry | null,
  reportHit: { iter: number; report: WorkerReport } | null,
  verdictHit: { iter: number; verdict: ReviewerVerdict } | null,
  notes: string[],
): RowReconstruction {
  return {
    id,
    branch,
    reconstructedState,
    decision,
    coarse: coarse(reconstructedState),
    worktree,
    latestReport: reportHit?.report ?? null,
    reportIter: reportHit?.iter ?? null,
    latestVerdict: verdictHit?.verdict ?? null,
    verdictIter: verdictHit?.iter ?? null,
    notes,
  };
}
