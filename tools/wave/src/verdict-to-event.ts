/**
 * verdict-to-event.ts — deterministic Reviewer-Verdict → WaveEvent adapter.
 *
 * Provenance:     the verdict-to-event adapter slice, and the autonomy audit
 *                 whose §2 finding G3 motivated it — both planned in the
 *                 predecessor wave-orchestration system flotilla was seeded from.
 *                 Named, not pathed: that system's planning tree (which these two
 *                 lines used to cite as `Canonical spec` and `Audit source`) never
 *                 existed in THIS repo and is in no published tarball, so the
 *                 pointers resolved only where they were written. G3 itself is
 *                 restated in full below, which is the whole of what they carried
 *                 (`shipped-citation-guard.spec.ts`).
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
 *
 * The richer entry point is {@link verdictToRouting}, which returns the same
 * event plus — on an Operator-RULED round only — the cell it landed in and the
 * ruling that admitted it. See §"The Operator-ruled round" below.
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
 * not a state the loop can reach — unless an Operator has RULED a
 * Reviewer-only round outside the cap (see below), which is the one documented
 * way past it and the only thing that opens the range.
 */
const MAX_ITERATION = 2;

// ─── The Operator-ruled round ───────────────────────────────────────────────

/**
 * ## The Operator-ruled round — the cell the cap has no room for
 *
 * A second `changes-requested` exhausts the cap and stops the row, by design.
 * The documented recovery is an Operator RULING: fix the world, then re-dispatch
 * the **Reviewer only**, outside the cap. The spine row is bumped so the sidecars
 * land at the third iteration — and the sidecar readers already handle that (both
 * the verdict render and the acked-AC derivation read the MAX-iteration sidecar).
 * Only the router did not: an iteration above the cap was refused outright, so
 * the round had to be routed by hand, or routed under an iteration it did not
 * run at. Both are the hand-routing the skills forbid, and both lose the one
 * fact worth keeping — WHY the round exists.
 *
 * ### The shape, and why it is a reason rather than a flag
 *
 * The admission is the RULING TEXT, never a boolean. A bare `--ruled` any script
 * could pass records THAT a ruled round happened; it cannot record why, and the
 * audit value of a ruled round is entirely the why. {@link rulingViolation}
 * therefore refuses a blank, a single token, or a stub too short to be a reason:
 * a ruled round is impossible to produce without stating one.
 *
 * ### Why no new `WaveEvent`
 *
 * The ruled round is a distinct routing CELL, recorded under its own name in
 * {@link RULED_CELLS} — and it is deliberately NOT a new member of the
 * state-machine's event enum. Cap accounting belongs to `transition()`, and the
 * whole point of the ruled round is that it neither consumes nor resets the cap;
 * teaching the machine a new event for it would move the ruled round INSIDE the
 * accounting it is defined to sit outside of. So the cells map onto events the
 * machine already has:
 *
 * | verdict              | risk                | WaveEvent                        | cell                                |
 * |----------------------|---------------------|----------------------------------|-------------------------------------|
 * | `approve`            | `public-API-change` | `reviewer-approve-public-api`    | `reviewer-approve-public-api-ruled` |
 * | `approve`            | (other)             | `reviewer-approve`               | `reviewer-approve-ruled`            |
 * | `changes-requested`  | any                 | `reviewer-changes-requested-2nd` | `reviewer-changes-requested-ruled`  |
 * | `questions-blocking` | any                 | `reviewer-questions-blocking`    | `reviewer-questions-blocking-ruled` |
 *
 * A ruled `approve` therefore reaches exactly the next state an ordinary approve
 * reaches — `approved` from `reviewing`, or the public-API STOP — which is the
 * property that makes the ruled round a recovery rather than a second machine.
 * A ruled `changes-requested` maps to the CAP-EXHAUSTION event, never to `-1st`:
 * the row stops again, and a further ruled round takes a further ruling from the
 * Operator rather than an entitlement the machine hands out on its own.
 */
export const RULED_CELLS = [
  'reviewer-approve-ruled',
  'reviewer-approve-public-api-ruled',
  'reviewer-changes-requested-ruled',
  'reviewer-questions-blocking-ruled',
] as const;

/** The distinct name an above-cap, Operator-ruled round is recorded under. */
export type RuledCell = (typeof RULED_CELLS)[number];

/** The audit half of a ruled round: which cell it landed in, and why it exists. */
export interface RuledRound {
  cell: RuledCell;
  /**
   * The Operator's stated reason, trimmed — never a bare token
   * (see {@link rulingViolation}). Carried through to the routing verbs' printed
   * result so a closing report can quote it rather than reconstruct it.
   */
  ruling: string;
}

/**
 * What {@link verdictToRouting} resolved. `ruled` is present ONLY on an
 * Operator-ruled above-cap round, so an ordinary round's routing — and the JSON
 * the verbs print for it — is byte-identical to what it has always been.
 */
export interface VerdictRouting {
  event: WaveEvent;
  ruled?: RuledRound;
}

/** A ruling has to read as a stated reason, not as a token that satisfies a parser. */
const MIN_RULING_CHARS = 12;
const MIN_RULING_WORDS = 3;

/**
 * Why this ruling text cannot admit an above-cap round, or `undefined` when it
 * can. The thresholds are deliberately low — the check exists to make a BARE
 * TOKEN (`true`, `yes`, `ok`, `ruled`) impossible, not to grade prose.
 */
export function rulingViolation(ruling: string): string | undefined {
  const text = ruling.trim();
  if (text.length === 0) return 'is blank';
  if (text.length < MIN_RULING_CHARS) {
    const plural = text.length === 1 ? '' : 's';
    return `is ${text.length} character${plural} long, under the ${MIN_RULING_CHARS}-character minimum`;
  }
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < MIN_RULING_WORDS) {
    const plural = words.length === 1 ? '' : 's';
    return `is ${words.length} word${plural} long, under the ${MIN_RULING_WORDS}-word minimum`;
  }
  return undefined;
}

/**
 * The label every refusal in this module carries. It stays `verdictToEvent`
 * whichever entry point threw: the out-of-range refusal below is pinned
 * byte-for-byte by its own spec — it is the negative control proving the cap was
 * not quietly widened for everyone — so the text is one string owned here rather
 * than a per-function prefix two callers could drift apart.
 */
const ADAPTER = 'verdictToEvent';

// ─── adapter ────────────────────────────────────────────────────────────────

/**
 * Translate a Reviewer Verdict into the `WaveEvent` the Stop-Condition
 * state-machine expects, plus — on an Operator-ruled round — the cell it landed
 * in and the ruling that admitted it.
 *
 * | verdict             | risk                | iteration | → WaveEvent                        |
 * |---------------------|---------------------|-----------|------------------------------------|
 * | `approve`           | `public-API-change` | any       | `reviewer-approve-public-api` (G3) |
 * | `approve`           | (other)             | any       | `reviewer-approve`                 |
 * | `changes-requested` | any                 | `1`       | `reviewer-changes-requested-1st`   |
 * | `changes-requested` | any                 | `2`       | `reviewer-changes-requested-2nd`   |
 * | `questions-blocking`| any                 | any       | `reviewer-questions-blocking`      |
 *
 * Above the cap the table is {@link RULED_CELLS}'s, and only a `ruling` opens it.
 *
 * @param verdict   — One of {@link VERDICT_VALUES}. Throws on anything else.
 * @param iteration — Worker iteration: `1` (initial) or `2` (re-dispatch), or an
 *                    above-cap iteration when — and only when — `ruling` is given.
 * @param risk      — The issue's `Risk:` class. Required because it bifurcates
 *                    the `approve` branch; throws on an unrecognised value so a
 *                    garbled/omitted risk can never silently collapse a
 *                    public-API approval onto the auto-PR fast path (G3 guard).
 * @param ruling    — The Operator's stated reason for a Reviewer-only round
 *                    ABOVE the re-dispatch cap. Omit it and an above-cap
 *                    iteration is refused exactly as it always was; supply it at
 *                    or below the cap (or on a corrupt iteration) and THAT is
 *                    refused, because there is nothing there for it to admit.
 *
 * @throws {TypeError}  on an unrecognised `verdict` or `risk`, on a ruling that
 *                      states no reason, or on a ruling where none applies.
 * @throws {RangeError} on an `iteration` outside `[1, 2]` with no ruling.
 */
export function verdictToRouting(
  verdict: Verdict,
  iteration: number,
  risk: Risk,
  ruling?: string,
): VerdictRouting {
  // ── Reject loudly — never guess. ──────────────────────────────────────────
  if (!(VERDICT_VALUES as readonly string[]).includes(verdict)) {
    throw new TypeError(
      `${ADAPTER}: unrecognised verdict ${JSON.stringify(verdict)}. ` +
        `Expected one of: ${VERDICT_VALUES.join(' | ')}.`,
    );
  }

  const aboveCap = Number.isInteger(iteration) && iteration > MAX_ITERATION;

  if (ruling === undefined) {
    // The pre-existing refusal, unchanged and unwidened. This message is the
    // negative control the ruled cell is measured against: with no ruling, an
    // above-cap iteration is refused here in exactly the bytes it always was.
    if (
      !Number.isInteger(iteration) ||
      iteration < 1 ||
      iteration > MAX_ITERATION
    ) {
      throw new RangeError(
        `${ADAPTER}: iteration ${JSON.stringify(iteration)} is out of range. ` +
          `Expected an integer in [1, ${MAX_ITERATION}] (re-dispatch cap = 1).`,
      );
    }
  } else {
    if (!aboveCap) {
      throw new TypeError(
        `${ADAPTER}: an Operator ruling was supplied for iteration ${JSON.stringify(iteration)}, ` +
          'which is not an above-cap round. A ruling admits the one thing the cap refuses — a ' +
          `Reviewer-only round at an iteration above ${MAX_ITERATION} — so inside ` +
          `[1, ${MAX_ITERATION}] there is nothing for it to admit, and a non-integer or below-1 ` +
          'iteration is a corrupt input no ruling repairs. Route the iteration the round actually ' +
          'ran at, without a ruling.',
      );
    }
    const violation = rulingViolation(ruling);
    if (violation !== undefined) {
      throw new TypeError(
        `${ADAPTER}: the Operator ruling admitting iteration ${JSON.stringify(iteration)} ` +
          `${violation}. A ruled round is auditable only if it states WHY it exists, so the ruling ` +
          'IS the reason — a sentence a reader can quote — never a bare token a script could type.',
      );
    }
  }

  if (!(RISK_VALUES as readonly string[]).includes(risk)) {
    throw new TypeError(
      `${ADAPTER}: unrecognised risk ${JSON.stringify(risk)}. ` +
        `Expected one of: ${RISK_VALUES.join(' | ')}.`,
    );
  }

  /** Attach the ruled half only on a ruled round; an ordinary one keeps `{ event }`. */
  const routing = (event: WaveEvent, cell: RuledCell): VerdictRouting =>
    ruling === undefined ? { event } : { event, ruled: { cell, ruling: ruling.trim() } };

  switch (verdict) {
    case 'approve':
      // G3 guard: a public-API-change approve MUST route to the STOP path, so
      // the Coordinator final-confirms before `host-pr create`. Never the
      // 'reviewer-approve' auto-PR fast path. A RULED approve takes the very
      // same branch, and that identity is the point: a ruled round is a
      // recovery, not a second state machine, so it reaches the state an
      // ordinary approve reaches and no other.
      return risk === 'public-API-change'
        ? routing('reviewer-approve-public-api', 'reviewer-approve-public-api-ruled')
        : routing('reviewer-approve', 'reviewer-approve-ruled');

    case 'changes-requested':
      // The SM enforces the re-dispatch cap; the adapter just hands it the
      // iteration-correct event (1st triggers re-dispatch, 2nd STOPs). A RULED
      // changes-requested is ALWAYS the 2nd — the cap-exhaustion cell — so it
      // can neither consume a budget that is already spent nor hand the row a
      // fresh one. The row stops again; a further round takes a further ruling.
      if (ruling !== undefined) {
        return routing('reviewer-changes-requested-2nd', 'reviewer-changes-requested-ruled');
      }
      return {
        event:
          iteration === 1
            ? 'reviewer-changes-requested-1st'
            : 'reviewer-changes-requested-2nd',
      };

    case 'questions-blocking':
      return routing('reviewer-questions-blocking', 'reviewer-questions-blocking-ruled');
  }
}

/**
 * The event half of {@link verdictToRouting} — the original three-argument
 * adapter, unchanged in behaviour and in every refusal it prints. Callers that
 * need a ruled round's audit half (the cell and the ruling) call
 * {@link verdictToRouting}; callers that only feed `transition()` keep using
 * this.
 *
 * @returns the deterministically-mapped {@link WaveEvent}.
 */
export function verdictToEvent(
  verdict: Verdict,
  iteration: number,
  risk: Risk,
  ruling?: string,
): WaveEvent {
  return verdictToRouting(verdict, iteration, risk, ruling).event;
}
