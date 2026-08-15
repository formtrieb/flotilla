/**
 * goal-frontier.ts — the Goal's derived open remainder (ADR-0044 decision 5).
 *
 * A **Goal** is a named finish line whose members are issues in one config-bound
 * native container; its **Frontier** is the derived reading of that membership.
 * The frontier is DERIVED, NEVER WRITTEN: there is no durable release marker an
 * agent could author and no map document for one to accumulate in (the measured
 * Wayfinder failure mode — an agent wrote itself a release authorization into a
 * map's free-prose notes and executed against a live server). Goal state lives
 * in the container plus this query, and nothing else.
 *
 * This module is pure engine: it knows nothing about milestones, projects, or
 * goal files. An adapter states what it can SEE about each member
 * ({@link GoalMemberFacts}) and this module turns those facts into exactly one
 * reading per member. That split is what lets three genuinely different native
 * containers share one classification rule instead of three lookalikes.
 *
 * **Completion is literally "the frontier is empty."** {@link GoalFrontier.complete}
 * reports it; nothing here closes anything. Closing the container is the
 * Operator's act in the tracker and is deliberately NOT a facet verb — the
 * station owes accounting, never the declaration (ADR-0042's sentence, one
 * station over).
 */

import type { IssueRef } from './contract';

/**
 * The five readings a goal member can have — one terminal bookend and four open
 * states (ADR-0044 decision 5).
 *
 * - `done` — natively closed on the tracker. The coarse bookend (ADR-0003/0005),
 *   and deliberately NOT merge-evidence-checked here: whether a close was a real
 *   landing or an abandoned slice is `wave-close`'s per-issue concern (the
 *   `readClosing` probe), asked once per wave row. A goal spans months and
 *   origins; re-asking it per member would make a status read a wave audit.
 * - `in-motion` — claimed. Some wave has it.
 * - `actionable` — eligible, unblocked, unclaimed: a wave could pick it up now.
 * - `blocked` — an unresolved dependency, via the #381 read-union (codec ∪
 *   native), so a bare member that depends on another bare member is visible
 *   here with no Header-Block written anywhere.
 * - `unready` — bare, awaiting sharpening: it carries no eligibility marker, so
 *   no wave can draw it until triage / `to-issues` decorate-mode sharpens it.
 */
export type GoalMemberState =
  | 'done'
  | 'in-motion'
  | 'actionable'
  | 'blocked'
  | 'unready';

/**
 * The five states as data, in the ladder order {@link classifyGoalMember}
 * applies them. Exported so a caller (a `goal` skill panel, a report renderer)
 * can enumerate the vocabulary without re-spelling it — the same
 * one-source-of-truth stance `RUNG_PRECEDENCE` and `GOAL_CONTAINERS` take.
 */
export const GOAL_MEMBER_STATES: readonly GoalMemberState[] = [
  'done',
  'in-motion',
  'blocked',
  'actionable',
  'unready',
];

/**
 * What an adapter can SEE about one goal member — the whole input to the
 * classification, and deliberately not an `IssueView`.
 *
 * `IssueView` would have been the obvious choice and is the wrong one: a BARE
 * member has no projectable `IssueView` at all (`read()` throws on it until
 * `annotate` decorates it — the ADR-0027 honesty rule), and a bare member is
 * exactly what the `goal` station files at a cut. A frontier that could not
 * read its own bare members would be blind to the majority of a fresh goal. So
 * the facts below are the intersection every store can answer for EVERY member,
 * decorated or bare.
 */
export interface GoalMemberFacts {
  /** The member's opaque tracker id (ADR-0001) — never parsed here. */
  id: string;
  /** Natively closed on the tracker (the coarse `done` bookend). */
  closed: boolean;
  /**
   * Carries a wave claim (a `queued`/`in-flight`/`in-review` rung, or the
   * orthogonal needs-attention flag raised over one). A flagged member is still
   * a claimed member: it is neither available for another wave nor finished, so
   * it reads `in-motion` rather than dropping back into the actionable pool.
   */
  claimed: boolean;
  /**
   * Carries the eligibility marker (the ADR-0003 OR-set). A bare member never
   * does — that absence IS the `unready` reading.
   */
  eligible: boolean;
  /**
   * The blockers from the #381 read-union that the adapter could NOT see
   * resolved — a blocker it read as still-open, and (deliberately) also one it
   * could not resolve at all.
   *
   * The unresolvable case counts as unresolved on purpose, and it is the same
   * evidence discipline `ClosingState` takes on the read side: `actionable` is a
   * positive claim that NOTHING blocks this member. An edge the store cannot
   * see is not evidence that the edge is clear, so it must never be able to
   * counterfeit one.
   */
  unresolvedBlockers: readonly IssueRef[];
}

/** One member's reading — its state plus the evidence the state rests on. */
export interface GoalMemberReading {
  id: string;
  state: GoalMemberState;
  /**
   * Carried through from {@link GoalMemberFacts.unresolvedBlockers} so a
   * `blocked` reading names WHAT it waits on rather than merely asserting it
   * waits. Empty for every other state.
   */
  unresolvedBlockers: readonly IssueRef[];
}

/** The Goal's derived open remainder — the whole answer of the frontier query. */
export interface GoalFrontier {
  /** The container's opaque id (ADR-0001). */
  goalId: string;
  /** One reading per member, in the order the adapter listed them. */
  readings: GoalMemberReading[];
  /** How many members read as each state. Every state key is present, zeroes included. */
  counts: Readonly<Record<GoalMemberState, number>>;
  /** The OPEN remainder — every reading that is not `done`. This is the frontier. */
  open: GoalMemberReading[];
  /**
   * `open.length === 0` — every member is done. REPORTED, never acted on: the
   * facet has no `closeGoal`, because closing the container is the Operator's
   * act in the tracker (ADR-0044 decision 5).
   */
  complete: boolean;
}

/**
 * Classify ONE member into exactly one {@link GoalMemberState}.
 *
 * An if-else ladder, and the shape is the guarantee: exhaustive (the final
 * branch has no condition, so every input lands somewhere) and mutually
 * exclusive (the first matching rung returns, so nothing lands twice). A
 * predicate-per-state design could satisfy neither without a separate
 * reconciliation step nobody would run.
 *
 * The rung ORDER is itself a set of decisions, each recorded:
 *
 *  1. `done` first — a closed member is finished whatever labels it still
 *     carries. A stale claim rung or a stale needs-attention flag left on an
 *     issue that later closed must not report it as still in motion. Same
 *     precedence the three stores' own `deriveStatus` already applies.
 *  2. `in-motion` before `blocked` — a claimed member is somebody's problem
 *     right now, and reporting it as `blocked` would invite a second wave to
 *     wait on it rather than see it moving. (A row whose blocker reopened
 *     mid-flight is still in motion; the wave's own DoR gate owns that, not a
 *     status read.)
 *  3. `blocked` before the eligibility question — a bare member CAN depend on
 *     another bare member (ADR-0044 decision 1's bare `blockedBy` arm), so the
 *     dependency reading must not be reachable only through eligibility. This
 *     rung is why the arm and the read-union exist: without it a bare blocked
 *     member and a bare unblocked one would read identically.
 *  4. eligibility last, splitting the remainder — `actionable` when the member
 *     carries the OR-set marker, `unready` when it does not. "Unready via
 *     absent eligibility" is the whole definition; nothing here inspects the
 *     member's text to guess at readiness.
 */
export function classifyGoalMember(facts: GoalMemberFacts): GoalMemberState {
  if (facts.closed) return 'done';
  if (facts.claimed) return 'in-motion';
  if (facts.unresolvedBlockers.length > 0) return 'blocked';
  return facts.eligible ? 'actionable' : 'unready';
}

/** A zeroed tally over every state — so an absent state reads `0`, never `undefined`. */
function zeroCounts(): Record<GoalMemberState, number> {
  const counts = {} as Record<GoalMemberState, number>;
  for (const state of GOAL_MEMBER_STATES) counts[state] = 0;
  return counts;
}

/**
 * Derive a Goal's frontier from its members' facts. Pure — no I/O, no clock, no
 * store: an adapter gathers the facts through its own native container and this
 * turns them into the reading every store reports identically.
 *
 * A goal with NO members is `complete` (an empty remainder is empty), which is
 * the honest reading of "nothing is outstanding" and is exactly why the station
 * only ever REPORTS completion: a freshly-minted, still-unpopulated container
 * would otherwise be a self-issued release authorization.
 */
export function computeGoalFrontier(
  goalId: string,
  members: readonly GoalMemberFacts[],
): GoalFrontier {
  const counts = zeroCounts();
  const readings: GoalMemberReading[] = [];
  for (const facts of members) {
    const state = classifyGoalMember(facts);
    counts[state] += 1;
    readings.push({
      id: facts.id,
      state,
      // Only a `blocked` reading rests on blockers; carrying them on a `done` or
      // `in-motion` member would report an edge as load-bearing when the state
      // above it already decided the reading.
      unresolvedBlockers: state === 'blocked' ? [...facts.unresolvedBlockers] : [],
    });
  }
  const open = readings.filter((r) => r.state !== 'done');
  return { goalId, readings, counts, open, complete: open.length === 0 };
}
