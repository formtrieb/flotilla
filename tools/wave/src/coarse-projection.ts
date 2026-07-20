/**
 * coarse-projection.ts — the lossy, one-way projection of the engine's 11 fine
 * states onto the coarse claim-ledger rung flotilla writes to the tracker
 * (CHARTER §6, ADR-0002, ADR-0022).
 *
 * flotilla writes ONLY `queued | in-flight | in-review`. `available` (eligible &
 * unclaimed) and `done` (natively closed) are DERIVED endpoints, never fine
 * states, so `coarse()` never returns them; `needs-attention` is an orthogonal
 * flag, not a rung. The projection is intentionally lossy — distinct fine states
 * (report-in / reviewing / verdict-in) collapse to one rung — which is exactly
 * why the spine, not the tracker, is the resume authority.
 *
 * `parked` (ADR-0022) is the one state holding NO claim: it projects to `null`,
 * which the write path executes as `unclaim()` rather than a rung write.
 */

import type { IssueState } from './stop-condition-state-machine';
import type { ClaimRung } from './contract';

/**
 * The ledger-point transitions, for documentation + table-driven derivation.
 * `null` = "no claim to hold" — the write path executes it as `unclaim()`.
 */
const RUNG_OF: Record<IssueState, ClaimRung | null> = {
  planned: 'queued', // soft claim (wave-create commits to scope)
  dispatched: 'in-flight', // hard claim (prevents double-dispatch)
  'report-in': 'in-flight', // collapses to in-flight (ADR-0002 lossy)
  reviewing: 'in-flight',
  'verdict-in': 'in-flight',
  're-dispatched': 'in-flight',
  approved: 'in-review', // PR about to exist
  'pr-created': 'in-review', // PR open, awaiting merge
  // Terminal-failure states keep the in-flight claim until dispositioned; the
  // needs-attention flag (ADR-0006) is the orthogonal signal, set separately.
  failed: 'in-flight',
  abandoned: 'in-flight',
  // ADR-0022 — `parked` is the disposition the vocabulary lacked: the row is
  // deliberately out of THIS wave and released for re-planning, so it holds no
  // claim and the issue derives back to `available`. This is the whole point of
  // the state — mapping it to a rung would re-claim the issue on every resume
  // re-projection and block exactly the re-planning it is being parked for.
  parked: null,
};

/**
 * Project an engine fine state onto the coarse claim rung written to the tracker.
 *
 * Total over {@link IssueState}; never yields `available`/`done`/`needs-attention`
 * (derived endpoints + the orthogonal flag, ADR-0002/ADR-0006).
 *
 * @returns the rung to write, or `null` for `parked` — "no claim to hold"
 *   (ADR-0022). A `null` is NOT "unknown": the caller must execute it as
 *   {@link IssueStore.unclaim}, which returns the issue to the derived
 *   `available` pool so a future `wave-plan` draw can pick it up.
 */
export function coarse(state: IssueState): ClaimRung | null {
  return RUNG_OF[state];
}
