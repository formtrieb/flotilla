/**
 * verdict-to-event.ts — deterministic Reviewer-Verdict → WaveEvent adapter.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/64-verdict-to-event-adapter.md
 * Audit source:   .scratch/wave-orchestration/autonomy-audit-2026-06-03.md §2 (G3)
 *
 * The wave-loop's Reviewer-Subagent emits a 3-value Verdict
 * (`approve | changes-requested | questions-blocking`). The Stop-Condition
 * state-machine (`transition()`) consumes the wider `WaveEvent` enum. The chat
 * (and later the #61 Workflow driver) used to bridge the two by hand — which is
 * exactly the "caller bug" the SM spec names: a `public-API-change` approve
 * silently routed to the auto-PR fast path because the synthesised event was
 * plain `reviewer-approve` (or `riskClass` was omitted).
 *
 * This module removes that hand-synthesis. It is a pure function — no I/O, no
 * seam — that maps (verdict, iteration, risk) → WaveEvent deterministically and
 * **rejects loudly** on anything it cannot map (mirrors the #55 closed-by
 * classifier's "classify by strongest signal, reject ambiguous" discipline).
 * `transition()` stays unchanged; this adapter feeds it.
 *
 * Usage:
 *   import { verdictToEvent } from './verdict-to-event';
 *   import { transition } from './stop-condition-state-machine';
 *   const event = verdictToEvent('approve', 1, 'public-API-change');
 *   //  → 'reviewer-approve-public-api'  (NEVER plain 'reviewer-approve')
 *   const outcome = transition('reviewing', event);
 *   //  → STOP public-api-approval-required
 */

import { RISK_VALUES, type Risk } from './header-parser';
import type { WaveEvent } from './stop-condition-state-machine';

// ─── Verdict enum ───────────────────────────────────────────────────────────

/**
 * The three Verdict values the `wave-reviewer` subagent emits, verbatim.
 * Source: `.claude/agents/wave-reviewer.md` §Verdict routing.
 */
export const VERDICT_VALUES = [
  'approve',
  'changes-requested',
  'questions-blocking',
] as const;

export type Verdict = (typeof VERDICT_VALUES)[number];

/**
 * Maximum Worker attempts per issue (initial + one re-dispatch). The SM's
 * re-dispatch cap is **1**, so a Reviewer Verdict is only ever produced for
 * iteration 1 or iteration 2. An iteration outside `[1, 2]` is a caller bug,
 * not a state the loop can reach.
 */
const MAX_ITERATION = 2;

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * Translate a Reviewer Verdict into the `WaveEvent` the Stop-Condition
 * state-machine expects.
 *
 * | verdict             | risk                | iteration | → WaveEvent                        |
 * |---------------------|---------------------|-----------|------------------------------------|
 * | `approve`           | `public-API-change` | any       | `reviewer-approve-public-api` (G3) |
 * | `approve`           | (other)             | any       | `reviewer-approve`                 |
 * | `changes-requested` | any                 | `1`       | `reviewer-changes-requested-1st`   |
 * | `changes-requested` | any                 | `2`       | `reviewer-changes-requested-2nd`   |
 * | `questions-blocking`| any                 | any       | `reviewer-questions-blocking`      |
 *
 * @param verdict   — One of {@link VERDICT_VALUES}. Throws on anything else.
 * @param iteration — Worker iteration: `1` (initial) or `2` (re-dispatch).
 *                    Throws on a non-integer or a value outside `[1, 2]`.
 * @param risk      — The issue's `Risk:` class. Required because it bifurcates
 *                    the `approve` branch; throws on an unrecognised value so a
 *                    garbled/omitted risk can never silently collapse a
 *                    public-API approval onto the auto-PR fast path (G3 guard).
 *
 * @throws {TypeError}  on an unrecognised `verdict` or `risk`.
 * @throws {RangeError} on an `iteration` outside `[1, 2]`.
 * @returns the deterministically-mapped {@link WaveEvent}.
 */
export function verdictToEvent(
  verdict: Verdict,
  iteration: number,
  risk: Risk,
): WaveEvent {
  // ── Reject loudly — never guess. ──────────────────────────────────────────
  if (!(VERDICT_VALUES as readonly string[]).includes(verdict)) {
    throw new TypeError(
      `verdictToEvent: unrecognised verdict ${JSON.stringify(verdict)}. ` +
        `Expected one of: ${VERDICT_VALUES.join(' | ')}.`,
    );
  }
  if (
    !Number.isInteger(iteration) ||
    iteration < 1 ||
    iteration > MAX_ITERATION
  ) {
    throw new RangeError(
      `verdictToEvent: iteration ${JSON.stringify(iteration)} is out of range. ` +
        `Expected an integer in [1, ${MAX_ITERATION}] (re-dispatch cap = 1).`,
    );
  }
  if (!(RISK_VALUES as readonly string[]).includes(risk)) {
    throw new TypeError(
      `verdictToEvent: unrecognised risk ${JSON.stringify(risk)}. ` +
        `Expected one of: ${RISK_VALUES.join(' | ')}.`,
    );
  }

  switch (verdict) {
    case 'approve':
      // G3 guard: a public-API-change approve MUST route to the STOP path, so
      // the Coordinator final-confirms before `gh pr create`. Never the
      // 'reviewer-approve' auto-PR fast path.
      return risk === 'public-API-change'
        ? 'reviewer-approve-public-api'
        : 'reviewer-approve';

    case 'changes-requested':
      // The SM enforces the re-dispatch cap; the adapter just hands it the
      // iteration-correct event (1st triggers re-dispatch, 2nd STOPs).
      return iteration === 1
        ? 'reviewer-changes-requested-1st'
        : 'reviewer-changes-requested-2nd';

    case 'questions-blocking':
      return 'reviewer-questions-blocking';
  }
}
