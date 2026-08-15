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
});
