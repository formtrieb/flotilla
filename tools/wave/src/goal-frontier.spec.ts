/**
 * goal-frontier.spec.ts — the Goal's derived open remainder (ADR-0044 decision 5).
 *
 * The store-facing half lives in `adapters/goal-facet.spec.ts`, which drives the
 * real classification through three native containers. This file pins the PURE
 * rule underneath, and it can make two claims that a store-level suite cannot:
 *
 *  1. **Exhaustive and mutually exclusive.** The whole fact space is enumerated
 *     — every combination of closed/claimed/eligible × blockers/none — and each
 *     combination is asserted to yield exactly one member of the vocabulary.
 *     "Exactly one of five" is the acceptance criterion; a spec that only
 *     demonstrated five reachable examples would leave the claim untested for
 *     the 11 combinations nobody thought to write down.
 *  2. **Every state is REACHABLE.** A ladder that could never emit `blocked`
 *     would satisfy "exactly one state" perfectly. So the enumeration also
 *     asserts the observed states are the WHOLE vocabulary, not a subset.
 *
 * The later blocks pin the widening that let a reading carry the LIVE NATIVE
 * FACTS it was folded from (`nativeState`, `health`), and they are deliberately
 * ADDITIONS: not one assertion above them moved, because a widening of what a
 * reading CARRIES must not move what it MEANS, and the untouched classification
 * cases are the proof of that rather than a claim about it. Three properties
 * carry the weight, each stated over the whole 16-point fact space rather than
 * over examples:
 *
 *  3. **No reclassification.** Attaching any native value to any combination
 *     answers exactly as it did without one.
 *  4. **Never authored.** No reading ever acquires a health the facts did not
 *     state — no default, no coalesce, no `blocked → atRisk`. Health is a
 *     human's judgment on the tracker; this layer transports it (ADR-0046
 *     decision 4).
 *  5. **Absent means absent.** An unstated fact leaves the KEY missing, so
 *     `'health' in reading` answers "did anybody state one" and an issue-direct
 *     store's rendered frontier is byte-identical to what it was before.
 */

import { describe, it, expect } from 'vitest';
import {
  GOAL_MEMBER_STATES,
  classifyGoalMember,
  computeGoalFrontier,
  type GoalMemberFacts,
  type GoalMemberState,
} from './goal-frontier';
import type { IssueRef } from './contract';

const BLOCKER: IssueRef = { issue: 41 };

function facts(overrides: Partial<GoalMemberFacts> = {}): GoalMemberFacts {
  return {
    id: 'm1',
    closed: false,
    claimed: false,
    eligible: false,
    unresolvedBlockers: [],
    ...overrides,
  };
}

/** Every point in the fact space: 2 × 2 × 2 × 2 = 16 combinations. */
function everyCombination(): GoalMemberFacts[] {
  const out: GoalMemberFacts[] = [];
  for (const closed of [false, true]) {
    for (const claimed of [false, true]) {
      for (const eligible of [false, true]) {
        for (const blockers of [[], [BLOCKER]]) {
          out.push(
            facts({
              id: `c${Number(closed)}-m${Number(claimed)}-e${Number(eligible)}-b${blockers.length}`,
              closed,
              claimed,
              eligible,
              unresolvedBlockers: blockers,
            }),
          );
        }
      }
    }
  }
  return out;
}

describe('classifyGoalMember — exactly one of five, for every possible member', () => {
  it('assigns every combination in the whole fact space a state from the vocabulary', () => {
    const combos = everyCombination();
    expect(combos).toHaveLength(16); // the enumeration really is the whole space

    for (const f of combos) {
      const state = classifyGoalMember(f);
      // EXHAUSTIVE: nothing falls through to undefined…
      expect(state, `${f.id} produced no state`).toBeDefined();
      // …and MUTUALLY EXCLUSIVE: the answer is a single vocabulary member, so
      // there is no combination a caller would have to disambiguate.
      expect(GOAL_MEMBER_STATES, `${f.id} → ${state}`).toContain(state);
    }
  });

  it('the five states are ALL reachable — the ladder emits the whole vocabulary, not a subset', () => {
    // Without this, "exactly one of five" would be satisfied by a rule that can
    // only ever emit two of them.
    const observed = new Set(everyCombination().map(classifyGoalMember));
    expect([...observed].sort()).toEqual([...GOAL_MEMBER_STATES].sort());
  });

  it('classification is a pure function of the facts — same input, same answer', () => {
    for (const f of everyCombination()) {
      expect(classifyGoalMember(f)).toBe(classifyGoalMember({ ...f }));
    }
  });
});

describe('classifyGoalMember — each rung, and the precedence between them', () => {
  it('`done`: natively closed, whatever else is still stamped on it', () => {
    expect(classifyGoalMember(facts({ closed: true }))).toBe('done');
    // A stale claim rung or a stale flag on an issue that later closed must not
    // report it as still in motion — the same precedence the three stores'
    // deriveStatus already applies.
    expect(
      classifyGoalMember(
        facts({ closed: true, claimed: true, eligible: true, unresolvedBlockers: [BLOCKER] }),
      ),
    ).toBe('done');
  });

  it('`in-motion`: claimed — and it OUTRANKS an unresolved blocker', () => {
    expect(classifyGoalMember(facts({ claimed: true }))).toBe('in-motion');
    // A claimed member is somebody's problem right now; reporting it `blocked`
    // would invite a second wave to wait on it rather than see it moving.
    expect(
      classifyGoalMember(facts({ claimed: true, unresolvedBlockers: [BLOCKER] })),
    ).toBe('in-motion');
  });

  it('`blocked`: an unresolved dependency — reachable WITHOUT eligibility (the bare-member case)', () => {
    // The load-bearing one for ADR-0044 decision 1: a bare member can depend on
    // another bare member through the native `blockedBy` arm, and neither
    // carries an eligibility marker. If `blocked` sat below the eligibility
    // question, a bare blocked member and a bare unblocked one would read
    // identically, and the whole read-union would be invisible at goal level.
    expect(
      classifyGoalMember(facts({ eligible: false, unresolvedBlockers: [BLOCKER] })),
    ).toBe('blocked');
    expect(
      classifyGoalMember(facts({ eligible: true, unresolvedBlockers: [BLOCKER] })),
    ).toBe('blocked');
  });

  it('`actionable`: eligible, unblocked, unclaimed — all three, or it is not actionable', () => {
    expect(classifyGoalMember(facts({ eligible: true }))).toBe('actionable');
    // drop any one of the three and the reading changes.
    expect(classifyGoalMember(facts({ eligible: true, claimed: true }))).toBe('in-motion');
    expect(
      classifyGoalMember(facts({ eligible: true, unresolvedBlockers: [BLOCKER] })),
    ).toBe('blocked');
    expect(classifyGoalMember(facts({ eligible: false }))).toBe('unready');
  });

  it('`unready`: via ABSENT eligibility, and nothing else', () => {
    expect(classifyGoalMember(facts({ eligible: false }))).toBe('unready');
    // The ONLY difference between this member and the actionable one above.
    expect(classifyGoalMember(facts({ eligible: true }))).toBe('actionable');
  });
});

describe('computeGoalFrontier — the remainder, its tally, and its completion reading', () => {
  it('carries one reading per member, in the order the adapter listed them', () => {
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'a', closed: true }),
      facts({ id: 'b', claimed: true }),
      facts({ id: 'c', eligible: true }),
    ]);
    expect(frontier.goalId).toBe('goal-1');
    expect(frontier.readings.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(frontier.readings.map((r) => r.state)).toEqual([
      'done',
      'in-motion',
      'actionable',
    ]);
  });

  it('the OPEN remainder is every member that is not done — that is the frontier', () => {
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'done-1', closed: true }),
      facts({ id: 'done-2', closed: true }),
      facts({ id: 'moving', claimed: true }),
      facts({ id: 'waiting', unresolvedBlockers: [BLOCKER] }),
      facts({ id: 'ready', eligible: true }),
      facts({ id: 'bare' }),
    ]);
    expect(frontier.open.map((r) => r.id)).toEqual([
      'moving',
      'waiting',
      'ready',
      'bare',
    ]);
    expect(frontier.complete).toBe(false);
  });

  it('counts tally the readings, with every state key present — an absent state reads 0, never undefined', () => {
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'a', closed: true }),
      facts({ id: 'b', closed: true }),
      facts({ id: 'c', eligible: true }),
    ]);
    expect(frontier.counts).toEqual({
      done: 2,
      'in-motion': 0,
      actionable: 1,
      blocked: 0,
      unready: 0,
    });
    // the tally is total: every member is counted exactly once.
    const total = Object.values(frontier.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(frontier.readings.length);
    for (const state of GOAL_MEMBER_STATES) {
      expect(frontier.counts[state as GoalMemberState]).toBeGreaterThanOrEqual(0);
    }
  });

  it('`complete` means the remainder is EMPTY — every member done', () => {
    const allDone = computeGoalFrontier('goal-1', [
      facts({ id: 'a', closed: true }),
      facts({ id: 'b', closed: true }),
    ]);
    expect(allDone.open).toEqual([]);
    expect(allDone.complete).toBe(true);

    // one open member is enough to keep the frontier non-empty.
    const almost = computeGoalFrontier('goal-1', [
      facts({ id: 'a', closed: true }),
      facts({ id: 'b', eligible: true }),
    ]);
    expect(almost.complete).toBe(false);
  });

  it('a goal with NO members reads complete — and completion is only ever REPORTED', () => {
    // The honest reading of an empty remainder, and precisely why the station
    // never acts on it: a freshly-cut, still-unpopulated container would
    // otherwise be a self-issued release authorization (ADR-0044 decision 5).
    const empty = computeGoalFrontier('goal-1', []);
    expect(empty.readings).toEqual([]);
    expect(empty.open).toEqual([]);
    expect(empty.complete).toBe(true);
    // …and there is nothing on the result that could close anything.
    expect(Object.keys(empty).sort()).toEqual(
      ['complete', 'counts', 'goalId', 'open', 'readings'].sort(),
    );
  });

  it('a `blocked` reading NAMES its blockers; every other reading carries none', () => {
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'waiting', unresolvedBlockers: [BLOCKER, { slug: 'other', issue: 7 }] }),
      // the same blockers, but outranked by a claim / a close — so they are not
      // what the reading rests on, and must not be reported as if they were.
      facts({ id: 'moving', claimed: true, unresolvedBlockers: [BLOCKER] }),
      facts({ id: 'finished', closed: true, unresolvedBlockers: [BLOCKER] }),
    ]);
    const byId = new Map(frontier.readings.map((r) => [r.id, r]));
    expect(byId.get('waiting')?.unresolvedBlockers).toEqual([
      { issue: 41 },
      { slug: 'other', issue: 7 },
    ]);
    expect(byId.get('moving')?.unresolvedBlockers).toEqual([]);
    expect(byId.get('finished')?.unresolvedBlockers).toEqual([]);
  });

  it('does not alias the caller\'s blocker array — a later mutation cannot rewrite a reading', () => {
    const blockers: IssueRef[] = [BLOCKER];
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'waiting', unresolvedBlockers: blockers }),
    ]);
    blockers.push({ issue: 99 });
    expect(frontier.readings[0].unresolvedBlockers).toEqual([{ issue: 41 }]);
  });
});

describe('the frontier vocabulary is the ADR-0044 five, and nothing else', () => {
  it('GOAL_MEMBER_STATES is exactly done / in-motion / blocked / actionable / unready', () => {
    expect([...GOAL_MEMBER_STATES].sort()).toEqual(
      ['actionable', 'blocked', 'done', 'in-motion', 'unready'].sort(),
    );
    expect(GOAL_MEMBER_STATES).toHaveLength(5);
  });

  it('…and it stays five at PROJECT member granularity too (ADR-0045 decision 2)', () => {
    // The claim the amendment turns on: the engine never grew a second,
    // lookalike ladder for the second member kind. Same facts in, same five
    // readings out — the only thing that changed is who states the facts.
    const projectMembers: GoalMemberFacts[] = [
      // completed/canceled project → done
      facts({ id: 'prj-done', closed: true }),
      // started/paused, or a wave-claimed issue inside → in-motion
      facts({ id: 'prj-moving', claimed: true }),
      // an unresolved native project relation → blocked
      facts({ id: 'prj-waiting', eligible: true, unresolvedBlockers: ['prj-blocker'] }),
      // ≥1 eligible open issue inside, unclaimed, no relation → actionable
      facts({ id: 'prj-drawable', eligible: true }),
      // EMPTY, or all-unmarked issues inside → unready
      facts({ id: 'prj-empty' }),
    ];
    const frontier = computeGoalFrontier('init-1', projectMembers);
    expect(frontier.readings.map((r) => r.state)).toEqual([
      'done',
      'in-motion',
      'blocked',
      'actionable',
      'unready',
    ]);
    expect(frontier.complete).toBe(false);
  });
});

describe('a blocker is named in whichever id space its member kind has (ADR-0045)', () => {
  it('a bare MEMBER-ID blocker survives the reading verbatim, beside the IssueRef form', () => {
    // A Linear project id is a UUID with no honest `IssueRef` spelling, so the
    // reading carries it as a plain string. Both spellings are asserted in one
    // frontier: the union is real, not a replacement.
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'issue-member', unresolvedBlockers: [{ slug: 'other', issue: 7 }] }),
      facts({
        id: 'project-member',
        unresolvedBlockers: ['550e8400-e29b-41d4-a716-446655440000'],
      }),
    ]);
    expect(frontier.readings[0].state).toBe('blocked');
    expect(frontier.readings[0].unresolvedBlockers).toEqual([{ slug: 'other', issue: 7 }]);
    expect(frontier.readings[1].state).toBe('blocked');
    expect(frontier.readings[1].unresolvedBlockers).toEqual([
      '550e8400-e29b-41d4-a716-446655440000',
    ]);
  });

  it('a non-`blocked` reading still carries NO blockers, whichever spelling they were', () => {
    // The rung above `blocked` already decided the reading, so reporting the
    // edge would claim it is load-bearing when it is not — unchanged by the
    // widening.
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'moving', claimed: true, unresolvedBlockers: ['prj-x'] }),
      facts({ id: 'finished', closed: true, unresolvedBlockers: ['prj-y'] }),
    ]);
    expect(frontier.readings[0].unresolvedBlockers).toEqual([]);
    expect(frontier.readings[1].unresolvedBlockers).toEqual([]);
  });
});

// ── the live native facts a reading carries beside its state ────────────────
//
// Five readings over a six-value native vocabulary is a lossy projection:
// `started` and `paused` both read `in-motion`, `completed` and `canceled` both
// read `done`. The reading now carries the fact it was folded FROM, so a caller
// can name which one produced it. Everything below pins the two properties that
// make that safe — the fold itself did not move, and health is transport only.

/** One member per reading, so a claim can be made about all five at once. */
function oneOfEachReading(
  extras: Partial<GoalMemberFacts> = {},
): GoalMemberFacts[] {
  return [
    facts({ id: 'r-done', closed: true, ...extras }),
    facts({ id: 'r-moving', claimed: true, ...extras }),
    facts({ id: 'r-waiting', unresolvedBlockers: [BLOCKER], ...extras }),
    facts({ id: 'r-ready', eligible: true, ...extras }),
    facts({ id: 'r-bare', ...extras }),
  ];
}

const EVERY_READING: readonly GoalMemberState[] = [
  'done',
  'in-motion',
  'blocked',
  'actionable',
  'unready',
];

describe('a reading CARRIES its native state — for every reading, ungated', () => {
  it('travels verbatim from the facts to the reading', () => {
    const frontier = computeGoalFrontier('init-1', [
      facts({ id: 'prj-paused', claimed: true, nativeState: 'paused' }),
      facts({ id: 'prj-started', claimed: true, nativeState: 'started' }),
      facts({ id: 'prj-backlog', claimed: true, nativeState: 'backlog' }),
    ]);
    // The whole point of the field in one assertion: three members, ONE reading
    // between them, three distinguishable native facts. Before this travelled,
    // a renderer could only name what `in-motion` might have meant.
    expect(frontier.readings.map((r) => r.state)).toEqual([
      'in-motion',
      'in-motion',
      'in-motion',
    ]);
    expect(frontier.readings.map((r) => r.nativeState)).toEqual([
      'paused',
      'started',
      'backlog',
    ]);
  });

  it('is carried on ALL FIVE readings, `done` included — it is a fact about the member, not evidence for a rung', () => {
    // Deliberately unlike `unresolvedBlockers`, which IS gated to the one
    // reading it is evidence for. `done` is the case that matters most here:
    // the reading cannot say whether a project was `completed` or `canceled`,
    // so gating the native value the way blockers are gated would put the gap
    // back exactly where it hurt.
    const frontier = computeGoalFrontier('init-1', oneOfEachReading({ nativeState: 'x' }));
    expect(frontier.readings.map((r) => r.state)).toEqual([...EVERY_READING]);
    for (const r of frontier.readings) {
      expect(r.nativeState, `${r.id} (${r.state}) dropped its native state`).toBe('x');
    }
  });

  it('survives onto the OPEN remainder — the frontier a caller actually renders', () => {
    const frontier = computeGoalFrontier('init-1', oneOfEachReading({ nativeState: 'started' }));
    expect(frontier.open).toHaveLength(4); // everything but `done`
    for (const r of frontier.open) expect(r.nativeState).toBe('started');
  });

  it('is NOT interpreted — an unknown vendor word travels byte-for-byte', () => {
    // The engine is store-blind: it never enumerates this vocabulary, so a
    // value it has never heard of is not a problem to normalize away. A tracker
    // that adds a seventh category tomorrow needs no engine change.
    const frontier = computeGoalFrontier('init-1', [
      facts({ id: 'a', nativeState: 'someFutureCategory' }),
      facts({ id: 'b', nativeState: 'Auf Eis' }),
    ]);
    expect(frontier.readings.map((r) => r.nativeState)).toEqual([
      'someFutureCategory',
      'Auf Eis',
    ]);
  });
});

describe('health is TRANSPORT ONLY — carried, never authored', () => {
  it('travels verbatim, on every reading', () => {
    const frontier = computeGoalFrontier('init-1', oneOfEachReading({ health: 'offTrack' }));
    for (const r of frontier.readings) {
      expect(r.health, `${r.id} (${r.state}) dropped its health`).toBe('offTrack');
    }
  });

  it('is never DERIVED from the reading — a `blocked` member with no authored health reports none', () => {
    // The single most tempting inference in this module, and the one the
    // station exists to refuse: `blocked` does not mean `atRisk`. Health is a
    // human's judgment recorded on the tracker (ADR-0046 decision 4 names the
    // only two sanctioned sources, and neither is a formula over this
    // classification). A `?? 'atRisk'`, a `blocked → atRisk` mapping, or any
    // other helpfulness fails right here.
    const frontier = computeGoalFrontier('init-1', [
      facts({ id: 'waiting', unresolvedBlockers: [BLOCKER] }),
      facts({ id: 'waiting-2', unresolvedBlockers: [BLOCKER, 'prj-x'] }),
    ]);
    expect(frontier.readings.map((r) => r.state)).toEqual(['blocked', 'blocked']);
    for (const r of frontier.readings) {
      expect(r.health, `${r.id} acquired a health nobody authored`).toBeUndefined();
      expect('health' in r, `${r.id} materialized a health key`).toBe(false);
    }
  });

  it('is never DEFAULTED — no reading in the WHOLE fact space acquires one the facts did not carry', () => {
    // The property form of the claim above: not "blocked doesn't infer", but
    // "nothing infers". Every one of the 16 combinations, none of which states
    // a health, and none of which may end up with one.
    for (const f of everyCombination()) {
      const [reading] = computeGoalFrontier('init-1', [f]).readings;
      expect(reading.health, `${f.id} acquired a health`).toBeUndefined();
      expect(reading.nativeState, `${f.id} acquired a native state`).toBeUndefined();
    }
  });

  it('is not COALESCED either — a value the store really stated survives, whatever it is', () => {
    // The mirror of the rule above, and the reason it is worth its own case: a
    // future `|| undefined` / `?.trim() || undefined` "cleanup" would be the
    // engine deciding which of a store's answers count. It does not get to.
    // Reporting honestly (state it, or leave it out) is the STORE's obligation,
    // pinned in `IssueStore.readGoalFrontier`'s contract.
    const frontier = computeGoalFrontier('init-1', [
      facts({ id: 'empty-ish', health: '', nativeState: '' }),
      facts({ id: 'spaces', health: '  ', nativeState: '  ' }),
    ]);
    expect(frontier.readings[0].health).toBe('');
    expect(frontier.readings[0].nativeState).toBe('');
    expect(frontier.readings[1].health).toBe('  ');
    expect(frontier.readings[1].nativeState).toBe('  ');
  });
});

describe('absent stays absent, all the way out', () => {
  it('an unstated fact yields an absent KEY, not a key set to undefined', () => {
    // The distinction a caller depends on: `'health' in reading` must answer
    // "did anybody state one", and a rendered frontier must not sprout null
    // columns for the three bindings that have nothing to report.
    const frontier = computeGoalFrontier('goal-1', oneOfEachReading());
    for (const r of frontier.readings) {
      expect(Object.keys(r).sort(), `${r.id} (${r.state})`).toEqual(
        ['id', 'state', 'unresolvedBlockers'].sort(),
      );
    }
  });

  it('the two fields are independent — stating one does not conjure the other', () => {
    const frontier = computeGoalFrontier('init-1', [
      facts({ id: 'state-only', nativeState: 'started' }),
      facts({ id: 'health-only', health: 'onTrack' }),
    ]);
    expect(Object.keys(frontier.readings[0]).sort()).toEqual(
      ['id', 'state', 'unresolvedBlockers', 'nativeState'].sort(),
    );
    expect(Object.keys(frontier.readings[1]).sort()).toEqual(
      ['id', 'state', 'unresolvedBlockers', 'health'].sort(),
    );
  });

  it('an issue-direct store\'s rendered frontier is byte-identical to what it was before the widening', () => {
    // The compatibility claim, made the way a consumer would notice it break:
    // three of the four bindings state neither field, so their serialized
    // output must not have moved at all.
    const frontier = computeGoalFrontier('goal-1', [
      facts({ id: 'a', closed: true }),
      facts({ id: 'b', eligible: true }),
      facts({ id: 'c', unresolvedBlockers: [BLOCKER] }),
    ]);
    expect(JSON.parse(JSON.stringify(frontier.readings))).toEqual([
      { id: 'a', state: 'done', unresolvedBlockers: [] },
      { id: 'b', state: 'actionable', unresolvedBlockers: [] },
      { id: 'c', state: 'blocked', unresolvedBlockers: [{ issue: 41 }] },
    ]);
  });
});

describe('the widening changed what a reading CARRIES, never what it MEANS', () => {
  it('no combination in the whole fact space reclassifies when native facts are attached', () => {
    // The byte-unchanged claim as a property over the entire space, not over
    // the handful of examples anyone would think to write down. If a native
    // state or a health could ever reach `classifyGoalMember`'s ladder, some
    // combination here would answer differently with the facts attached than
    // without.
    for (const f of everyCombination()) {
      const bare = classifyGoalMember(f);
      expect(classifyGoalMember({ ...f, nativeState: 'started' }), f.id).toBe(bare);
      expect(classifyGoalMember({ ...f, nativeState: 'completed' }), f.id).toBe(bare);
      expect(classifyGoalMember({ ...f, health: 'offTrack' }), f.id).toBe(bare);
      expect(
        classifyGoalMember({ ...f, nativeState: 'canceled', health: 'atRisk' }),
        f.id,
      ).toBe(bare);
    }
  });

  it('the tally and the completion reading are untouched by them too', () => {
    // The two places a stray native value could still leak into MEANING even
    // with the ladder intact: a `canceled` project must not count as `done`
    // unless its `closed` fact says so, and an `offTrack` health must not keep
    // a finished goal open.
    const withFacts = computeGoalFrontier(
      'init-1',
      oneOfEachReading({ nativeState: 'canceled', health: 'offTrack' }),
    );
    const withoutFacts = computeGoalFrontier('init-1', oneOfEachReading());
    expect(withFacts.counts).toEqual(withoutFacts.counts);
    expect(withFacts.open.map((r) => r.id)).toEqual(withoutFacts.open.map((r) => r.id));

    const allClosed = computeGoalFrontier('init-1', [
      facts({ id: 'a', closed: true, nativeState: 'completed', health: 'offTrack' }),
      facts({ id: 'b', closed: true, nativeState: 'canceled', health: 'atRisk' }),
    ]);
    expect(allClosed.complete).toBe(true);
  });

  it('the vocabulary is still the five, and the frontier still has no sixth key', () => {
    const frontier = computeGoalFrontier(
      'init-1',
      oneOfEachReading({ nativeState: 'started', health: 'onTrack' }),
    );
    expect(new Set(frontier.readings.map((r) => r.state)).size).toBe(5);
    expect(Object.keys(frontier).sort()).toEqual(
      ['complete', 'counts', 'goalId', 'open', 'readings'].sort(),
    );
  });
});
