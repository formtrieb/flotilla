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
 * **ADR-0045 amendment — one vocabulary at every member GRANULARITY.** A Goal's
 * members are the bound container's direct native members, so a member is an
 * issue under three of the four bindings and a PROJECT under a Linear
 * Initiative. The five readings, the ladder below, and
 * {@link computeGoalFrontier} are untouched by that: the adapter maps its own
 * per-kind facts onto the same four booleans-plus-blockers. A project reads
 * `closed` from its own `completed`/`canceled` status exactly as an issue reads
 * it from a terminal state, `claimed` from `started`/`paused` or a wave-claimed
 * open issue inside, and `eligible` from an open issue inside carrying the
 * marker. The engine never grew a second, lookalike ladder — which is precisely
 * what the classification rule being ONE seam is worth.
 *
 * **A reading also CARRIES the facts it was folded from.** Five readings over a
 * six-value native vocabulary is a lossy projection by construction: `started`
 * and `paused` both read `in-motion`, and so does a `backlog` project with one
 * wave-claimed issue inside. That fold used to be invisible past this seam, so
 * the only honest rendering downstream was a static mapping *naming* what each
 * word could mean. It no longer is: {@link GoalMemberReading.nativeState} and
 * {@link GoalMemberReading.health} travel out beside the state, so a caller can
 * say WHICH native fact produced a reading, and the mirror pass's anchor block
 * (ADR-0046 decision 3) and the status pass read one derivation instead of two.
 *
 * The widening is deliberately to what a reading CARRIES, never to what it
 * MEANS: the vocabulary, the ladder, and {@link classifyGoalMember} are
 * byte-unchanged, and no reading flips because a native value is now visible.
 * And health is TRANSPORT ONLY — see {@link GoalMemberHealth}.
 *
 * **Completion is literally "the frontier is empty."** {@link GoalFrontier.complete}
 * reports it; nothing here closes anything. Closing the container is the
 * Operator's act in the tracker and is deliberately NOT a facet verb — the
 * station owes accounting, never the declaration (ADR-0042's sentence, one
 * station over).
 */

import type { IssueRef } from './contract';

/**
 * How a reading NAMES one unresolved blocker.
 *
 * Two spellings, because a Goal's members are the bound container's DIRECT
 * native members (ADR-0045 decision 1) and the two member kinds have two id
 * shapes:
 *
 *  - an `IssueRef` for an ISSUE member — the `{slug?, issue}` shape the body
 *    codec, the DoR gate and the conflict map already speak, unchanged from
 *    ADR-0044;
 *  - a bare opaque MEMBER ID for a member kind that has no `IssueRef` spelling
 *    at all: a Linear project id is a UUID, not `<slug>#<n>`, and there is no
 *    honest `IssueRef` to squeeze it into.
 *
 * Deliberately a union rather than a widened `IssueRef` with optional halves: a
 * ref that could be *either* shape would make every existing consumer's
 * `ref.issue` read possibly-undefined, and the two shapes are genuinely
 * different id spaces rather than two renderings of one. A caller narrows with
 * `typeof b === 'string'`.
 */
export type GoalBlocker = IssueRef | string;

/**
 * A member's LIVE native state, in the TRACKER's own vocabulary — a Linear
 * project's `backlog` / `planned` / `started` / `paused` / `completed` /
 * `canceled`, and whatever a fourth adapter's container calls its own.
 *
 * **A `string`, deliberately, and the looseness is the design.** The engine is
 * tracker-agnostic (CHARTER §4) and this value is a VENDOR enum living one layer
 * behind a schema the engine never reads. Spelling the six Linear words into an
 * engine union would import a vendor vocabulary into the store-blind layer, and
 * would go stale the day a tracker adds a seventh — silently, because a value
 * outside a union is a compile error at the adapter and an invisible
 * mis-classification everywhere else. An opaque string cannot rot that way, and
 * it makes the transport rule STRUCTURAL rather than merely stated: nothing here
 * can branch on a value it does not enumerate.
 *
 * Same opacity contract as an id (ADR-0001): carried verbatim, compared against
 * nothing, parsed nowhere. A renderer that wants to *display* it prints it; a
 * renderer that wants to *reason* about it is asking the classification's
 * question and must ask {@link GoalMemberState} instead.
 */
export type GoalMemberNativeState = string;

/**
 * A member's OWN health — the human-authored judgment recorded on the tracker
 * (`onTrack` / `atRisk` / `offTrack` on Linear), carried out to a caller
 * untouched.
 *
 * A `string` for the reason {@link GoalMemberNativeState} is, plus a sharper one
 * that is the whole safety property of this field: **health is never derived
 * here.** The frontier computes accounting; it does not author an assessment
 * (ADR-0042's sentence, one station over; ADR-0046 decision 4 spells out the two
 * sanctioned sources, and neither is this module). Carrying a health value
 * through is TRANSPORT, and transport only — the moment this module computed,
 * defaulted, coalesced or inferred one, the station would be judging, which is
 * exactly the line it exists to hold.
 *
 * So: absent stays absent, all the way out. There is no fallback, no `??`, and
 * no mapping from a five-state reading back onto a health — a `blocked` member
 * with no authored health reports NO health, not `atRisk`.
 */
export type GoalMemberHealth = string;

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
   *
   * Under a PROJECT-member binding these are the member's native project
   * relations whose other side is not closed, named as bare member ids — see
   * {@link GoalBlocker}.
   */
  unresolvedBlockers: readonly GoalBlocker[];
  /**
   * The member's live native state, when the binding HAS one to report.
   *
   * **Optional because absence is the honest answer for three of the four
   * container bindings, not a gap to paper over.** A native state of this kind
   * belongs to a member that is itself a CONTAINER — a Linear project under an
   * `initiative` binding, whose own status category the frontier folds into a
   * reading. Under the three issue-direct bindings (GitHub milestone, Linear
   * project, MarkdownFs goal file) the member is an issue, and everything its
   * workflow state says is already fully spent on {@link closed} and
   * {@link claimed}: there is no second, richer native fact left over to report.
   * Those stores therefore leave this ABSENT rather than inventing a placeholder,
   * an empty string, or a re-spelling of a boolean they already stated.
   *
   * Reported for EVERY reading, `done` included — this is a fact ABOUT the
   * member, not evidence FOR one rung, which is exactly why it is not gated the
   * way {@link unresolvedBlockers} is.
   */
  nativeState?: GoalMemberNativeState;
  /**
   * The member's own human-authored health, when the tracker records one and the
   * store can see it. Optional for the same reason {@link nativeState} is, and
   * NEVER derived — see {@link GoalMemberHealth}.
   */
  health?: GoalMemberHealth;
}

/**
 * One member's reading — its state, the evidence that state rests on, and the
 * live native facts the state was folded FROM.
 *
 * The last part is what makes a reading informative rather than merely correct:
 * `in-motion` is one word over several different native situations, and a caller
 * that can see WHICH one produced it (a project a person moved to `started`, a
 * project someone `paused`, a `backlog` project with one wave-claimed issue
 * inside) can say so instead of documenting the ambiguity around a gap.
 */
export interface GoalMemberReading {
  id: string;
  state: GoalMemberState;
  /**
   * Carried through from {@link GoalMemberFacts.unresolvedBlockers} so a
   * `blocked` reading names WHAT it waits on rather than merely asserting it
   * waits. Empty for every other state.
   */
  unresolvedBlockers: readonly GoalBlocker[];
  /**
   * {@link GoalMemberFacts.nativeState}, carried verbatim and ungated — present
   * on every reading whose store reported one, `done` included, and ABSENT (the
   * key itself missing, not `undefined`) on every reading whose store did not.
   */
  nativeState?: GoalMemberNativeState;
  /**
   * {@link GoalMemberFacts.health}, carried verbatim and ungated, with the same
   * absence rule — and nothing in this module can put a value here that the
   * facts did not already carry.
   */
  health?: GoalMemberHealth;
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
      // TRANSPORT, and transport only — deliberately UNGATED where the blockers
      // above are gated, because these are facts about the MEMBER rather than
      // evidence for one rung: the reading a `done` project fell into says
      // nothing about whether it was `completed` or `canceled`, and the whole
      // point of carrying the native value is that a caller no longer has to
      // guess.
      //
      // Conditional spread, not `nativeState: facts.nativeState`, and the
      // difference is the contract: an absent fact yields an absent KEY rather
      // than a key set to `undefined`, so "absent stays absent all the way out"
      // is literally true (`'health' in reading === false`) and the rendered
      // JSON of an issue-direct store is byte-identical to what it was before
      // this field existed.
      //
      // There is no `??` here and there must never be one. A default would make
      // this module author a native state or a HEALTH — a human's judgment
      // recorded on the tracker — and the station computes accounting, never an
      // assessment. Nothing is normalized either: whatever the store said
      // travels byte-for-byte, because deciding that some value "means absent"
      // is already interpreting it. The obligation to answer honestly (report
      // it, or leave it out) sits on the store, where the native fact is.
      ...(facts.nativeState !== undefined ? { nativeState: facts.nativeState } : {}),
      ...(facts.health !== undefined ? { health: facts.health } : {}),
    });
  }
  const open = readings.filter((r) => r.state !== 'done');
  return { goalId, readings, counts, open, complete: open.length === 0 };
}
