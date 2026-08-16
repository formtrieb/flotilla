/**
 * goal-facet.spec.ts — ONE conformance suite for the Goal facet (ADR-0044),
 * driven unchanged against all three shipped stores.
 *
 * The same rule of engagement the IssueStore conformance suite lives by, applied
 * one facet over:
 *
 *   ☞ the suite observes ONLY facet-contract values — `GoalView`, `GoalFrontier`,
 *     the typed `GoalBindingError`. It NEVER inspects a milestone number, a
 *     project UUID, a `goals/` path, or any storage mechanism.
 *
 * so a markdown-only mechanism cannot leak into the contract and falsely fail
 * GitHub, and the three genuinely different native containers are held to one
 * rule rather than three lookalikes. The one place the stores legitimately
 * diverge — WHICH container role each realizes, and whether it has a default at
 * all — is reached through the harness's own declaration
 * ({@link GoalHarness.binding} / {@link GoalHarness.defaultsWithoutBinding}),
 * exactly as `simulateClosedUnmergedPr` declares its per-store honest answer
 * rather than forcing a lowest-common mechanism.
 *
 * The suite is defined HERE rather than in `conformance/issue-store-conformance.ts`
 * for a reason worth stating: that module is loaded through the package graph and
 * imports `vitest`, which is why the barrel refuses to re-export it. Keeping the
 * goal suite inside a `.spec.ts` costs nothing (it is registered three times
 * below, unchanged) and adds no new vitest-importing production module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore } from './markdown-fs-store';
import { GitHubIssuesStore } from './github/github-issues-store';
import { InMemoryGitHubApi } from './github/github-api-fake';
import { LinearIssuesStore } from './linear/linear-issues-store';
import { InMemoryLinearApi } from './linear/linear-api-fake';
import {
  CreateInputError,
  GoalBindingError,
  GoalMemberKindError,
  GoalMemberJoinError,
  GOAL_CONTAINERS,
  GOAL_MEMBER_KIND_BY_CONTAINER,
  goalMemberKind,
  parseGoalContainer,
  requireGoalContainer,
  requireGoalMemberKind,
  type CreateGoalMemberInput,
  type CreateInput,
  type GoalContainer,
  type GoalMemberKind,
  type IssueStore,
} from './issue-store';
import { GOAL_MEMBER_STATES, type GoalMemberState } from '../goal-frontier';

// ── the harness ─────────────────────────────────────────────────────────────

interface GoalHarness {
  /** A fresh, empty store whose eligibility OR-set makes created issues wave-ready. */
  makeStore(): Promise<IssueStore>;
  /**
   * The container role this store realizes — passed on every goal call the suite
   * makes, so the shared cases run identically on a store that HAS a default and
   * one that deliberately has none.
   */
  binding: GoalContainer;
  /**
   * What this store does with NO binding supplied: its own default role, or
   * `null` when it deliberately has none and must refuse.
   *
   * The whole ADR-0044 decision-4 asymmetry, declared per store rather than
   * assumed by the suite — GitHub may default to milestone, MarkdownFs realizes
   * its goal file, Linear gets no default because live consumer conventions
   * disagree about what a project MEANS.
   */
  defaultsWithoutBinding: GoalContainer | null;
  /** A container role this store does NOT realize — the `unrealized-container` driver. */
  unrealizedBinding: GoalContainer;
  /** A minimal valid decorated CreateInput; the suite overrides fields per case. */
  baseInput(overrides?: Partial<CreateInput>): CreateInput;
  /** A minimal valid BARE CreateInput (title + filingHint + bodySections). */
  bareInput(overrides?: Partial<CreateInput>): CreateInput;
}

function assertGoalBindingError(err: unknown): GoalBindingError {
  expect(err).toBeInstanceOf(GoalBindingError);
  return err as GoalBindingError;
}

/** Run `fn`, returning whatever it threw (or `undefined` when it did not throw). */
async function thrownBy(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

function runGoalFacetConformance(
  label: string,
  makeHarness: () => Promise<GoalHarness> | GoalHarness,
): void {
  describe(`Goal facet conformance — ${label}`, () => {
    async function fresh() {
      const h = await makeHarness();
      const store = await h.makeStore();
      return { h, store };
    }

    /** Mint a goal on the harness's own binding. */
    async function makeGoal(
      h: GoalHarness,
      store: IssueStore,
      title = 'Ship 1.0.0',
    ): Promise<string> {
      return store.createGoal(
        { title, filingHint: title.toLowerCase().replace(/[^a-z0-9]+/g, '-') },
        h.binding,
      );
    }

    // ── mint / read ────────────────────────────────────────────────────────
    it('createGoal returns an opaque id that readGoal round-trips', async () => {
      const { h, store } = await fresh();
      const id = await store.createGoal(
        { title: 'Ship 1.0.0', filingHint: 'ship-1-0-0', description: 'the contract freeze' },
        h.binding,
      );
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);

      const goal = await store.readGoal(id, h.binding);
      expect(goal.id).toBe(id);
      expect(goal.title).toBe('Ship 1.0.0');
      expect(goal.description).toContain('the contract freeze');
      expect(goal.container).toBe(h.binding);
      expect(goal.memberIds).toEqual([]); // freshly cut — nothing curated in yet
    });

    it('a goal with no description reads back EMPTY prose, never undefined', async () => {
      const { h, store } = await fresh();
      const id = await makeGoal(h, store, 'Bare finish line');
      expect((await store.readGoal(id, h.binding)).description).toBe('');
    });

    it('two createGoals yield distinct ids, both readable (the id is opaque)', async () => {
      const { h, store } = await fresh();
      const a = await makeGoal(h, store, 'Alpha');
      const b = await makeGoal(h, store, 'Beta');
      expect(a).not.toBe(b);
      expect((await store.readGoal(a, h.binding)).title).toBe('Alpha');
      expect((await store.readGoal(b, h.binding)).title).toBe('Beta');
    });

    it('readGoal throws on an unknown id', async () => {
      const { h, store } = await fresh();
      await expect(store.readGoal('definitely-not-a-goal', h.binding)).rejects.toThrow();
    });

    it('listGoals returns every goal this store can see, each with its membership', async () => {
      const { h, store } = await fresh();
      const a = await makeGoal(h, store, 'Alpha');
      const b = await makeGoal(h, store, 'Beta');
      const issue = await store.create(h.baseInput({ title: 'a slice' }));
      await store.assignToGoal(a, issue, h.binding);

      const goals = await store.listGoals(h.binding);
      expect(goals.map((g) => g.id).sort()).toEqual([a, b].sort());
      const alpha = goals.find((g) => g.id === a);
      expect(alpha?.memberIds).toEqual([issue]);
      expect(goals.find((g) => g.id === b)?.memberIds).toEqual([]);
      for (const g of goals) expect(g.container).toBe(h.binding);
    });

    it('listGoals is empty on a fresh store (an empty answer, not a throw)', async () => {
      const { h, store } = await fresh();
      expect(await store.listGoals(h.binding)).toEqual([]);
    });

    // ── curation ───────────────────────────────────────────────────────────
    it('assignToGoal joins a member by curation, and readGoal reports it', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const one = await store.create(h.baseInput({ title: 'one' }));
      const two = await store.create(h.baseInput({ title: 'two' }));

      await store.assignToGoal(goal, one, h.binding);
      await store.assignToGoal(goal, two, h.binding);

      expect((await store.readGoal(goal, h.binding)).memberIds.sort()).toEqual(
        [one, two].sort(),
      );
    });

    it('assignToGoal is idempotent — re-joining does not double the membership', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const issue = await store.create(h.baseInput());
      await store.assignToGoal(goal, issue, h.binding);
      await store.assignToGoal(goal, issue, h.binding);
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([issue]);
    });

    it('a BARE issue can be curated in — existence first, readiness later', async () => {
      // ADR-0044 decision 1: at a goal's cut you know THAT a workstream must
      // exist before anyone can say WHAT it is, so the station files bare members
      // and joins them. A facet that could only curate decorated issues would
      // make the cut impossible.
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const bare = await store.create(h.bareInput());
      await store.assignToGoal(goal, bare, h.binding);
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([bare]);
    });

    it('curation touches NOTHING else — not the claim ledger, not eligibility, not the open state', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const issue = await store.create(h.baseInput());
      const before = await store.read(issue);

      await store.assignToGoal(goal, issue, h.binding);

      const after = await store.read(issue);
      expect(after.status).toBe(before.status);
      expect(after.risk).toBe(before.risk);
      expect(after.worker).toBe(before.worker);
      expect(after.files).toEqual(before.files);
      expect(after.acceptanceCriteria).toEqual(before.acceptanceCriteria);
      // still wave-eligible and still unclaimed: membership grants nothing and
      // takes nothing away (sight, never permission).
      expect((await store.listOpen('wave-ready')).map((v) => v.id)).toContain(issue);
    });

    it('a goal is NOT an issue and an issue is NOT a goal — neither pollutes the other listing', async () => {
      // Measured as POPULATION DELTAS, never by comparing a goal id to an issue
      // id, and the reason is a real property of one of the three stores: a goal
      // id and an issue id live in SEPARATE opaque id spaces, so on GitHub
      // milestone #1 and issue #1 both stringify to `"1"` while naming entirely
      // different objects. An id-membership assertion would have read that
      // collision as pollution — a false failure that says nothing about the
      // contract. The contract's real claim is about populations: minting a goal
      // adds nothing to the wave candidate set, and filing an issue adds nothing
      // to the goal listing.
      const { h, store } = await fresh();
      const openBefore = (await store.listOpen('wave-ready')).length;
      const claimedBefore = (await store.listClaimed()).length;

      const goal = await makeGoal(h, store);

      expect((await store.listOpen('wave-ready')).length).toBe(openBefore);
      expect((await store.listClaimed()).length).toBe(claimedBefore);

      const goalsBefore = (await store.listGoals(h.binding)).length;
      const issue = await store.create(h.baseInput());
      expect((await store.listGoals(h.binding)).length).toBe(goalsBefore);
      // …and the issue really did land somewhere (so the equality above is not
      // green because nothing happened at all).
      expect((await store.listOpen('wave-ready')).length).toBe(openBefore + 1);

      // Curation itself moves neither population either.
      await store.assignToGoal(goal, issue, h.binding);
      expect((await store.listOpen('wave-ready')).length).toBe(openBefore + 1);
      expect((await store.listGoals(h.binding)).length).toBe(goalsBefore);
    });

    it('assignToGoal throws on an unknown goal id', async () => {
      const { h, store } = await fresh();
      const issue = await store.create(h.baseInput());
      await expect(
        store.assignToGoal('definitely-not-a-goal', issue, h.binding),
      ).rejects.toThrow();
    });

    // ── the frontier query ─────────────────────────────────────────────────
    it('classifies every member into exactly ONE of the five states', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      for (const title of ['one', 'two', 'three']) {
        await store.assignToGoal(goal, await store.create(h.baseInput({ title })), h.binding);
      }
      const frontier = await store.readGoalFrontier(goal, h.binding);

      expect(frontier.goalId).toBe(goal);
      expect(frontier.readings).toHaveLength(3);
      for (const reading of frontier.readings) {
        expect(GOAL_MEMBER_STATES).toContain(reading.state);
      }
      // the tally accounts for every member exactly once — no member classified
      // twice, none dropped.
      const total = Object.values(frontier.counts).reduce((a, b) => a + b, 0);
      expect(total).toBe(frontier.readings.length);
    });

    it('`actionable`: eligible, unblocked, unclaimed', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const issue = await store.create(h.baseInput());
      await store.assignToGoal(goal, issue, h.binding);

      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.readings[0].state).toBe('actionable');
      expect(frontier.counts.actionable).toBe(1);
      expect(frontier.complete).toBe(false);
    });

    it('`in-motion`: a claimed member — at every rung', async () => {
      for (const rung of ['queued', 'in-flight', 'in-review'] as const) {
        const { h, store } = await fresh();
        const goal = await makeGoal(h, store);
        const issue = await store.create(h.baseInput());
        await store.assignToGoal(goal, issue, h.binding);
        await store.transition(issue, rung);

        const frontier = await store.readGoalFrontier(goal, h.binding);
        expect(frontier.readings[0].state, `claimed at ${rung}`).toBe('in-motion');
      }
    });

    it('`in-motion`: a needs-attention member is still somebody\'s problem, never back in the pool', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const issue = await store.create(h.baseInput());
      await store.assignToGoal(goal, issue, h.binding);
      await store.transition(issue, 'in-flight');
      await store.flag(issue, {
        kind: 'recoverable-stop',
        question: 'which branch?',
        options: ['main'],
      });

      expect((await store.readGoalFrontier(goal, h.binding)).readings[0].state).toBe(
        'in-motion',
      );
    });

    it('`blocked`: an unresolved dependency, and the reading NAMES it', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const blocker = await store.create(h.baseInput({ title: 'the blocker' }));
      const blocked = await store.create(
        h.baseInput({ title: 'the blocked', blockedBy: [store.parseRef(blocker)] }),
      );
      await store.assignToGoal(goal, blocked, h.binding);

      const reading = (await store.readGoalFrontier(goal, h.binding)).readings[0];
      expect(reading.state).toBe('blocked');
      expect(reading.unresolvedBlockers.length).toBeGreaterThanOrEqual(1);
    });

    it('`blocked` clears to `actionable` once the blocker actually closes', async () => {
      // The blocked reading must rest on the blocker's live state, not on the
      // mere presence of a dependency edge — otherwise a goal would never
      // progress past its first dependency.
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const blocker = await store.create(h.baseInput({ title: 'the blocker' }));
      const blocked = await store.create(
        h.baseInput({ title: 'the blocked', blockedBy: [store.parseRef(blocker)] }),
      );
      await store.assignToGoal(goal, blocked, h.binding);
      expect((await store.readGoalFrontier(goal, h.binding)).readings[0].state).toBe(
        'blocked',
      );

      await store.closeUnplanned(blocker, 'superseded');

      const reading = (await store.readGoalFrontier(goal, h.binding)).readings[0];
      expect(reading.state).toBe('actionable');
      expect(reading.unresolvedBlockers).toEqual([]);
    });

    it('`unready`: a BARE member — absent eligibility, awaiting sharpening', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const bare = await store.create(h.bareInput());
      await store.assignToGoal(goal, bare, h.binding);

      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.readings[0].state).toBe('unready');
      expect(frontier.counts.unready).toBe(1);
    });

    it('`done`: a natively-closed member, and the frontier drops it from the remainder', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const finished = await store.create(h.baseInput({ title: 'finished' }));
      const open = await store.create(h.baseInput({ title: 'still open' }));
      await store.assignToGoal(goal, finished, h.binding);
      await store.assignToGoal(goal, open, h.binding);
      await store.closeUnplanned(finished, 'landed elsewhere');

      const frontier = await store.readGoalFrontier(goal, h.binding);
      const byId = new Map(frontier.readings.map((r) => [r.id, r.state]));
      expect(byId.get(finished)).toBe('done');
      expect(byId.get(open)).toBe('actionable');
      // a closed member stays a MEMBER — dropping it would make a finished goal
      // indistinguishable from an empty one.
      expect(frontier.readings).toHaveLength(2);
      expect(frontier.open.map((r) => r.id)).toEqual([open]);
      expect(frontier.complete).toBe(false);
    });

    it('completion is literally "the frontier is empty" — and only ever REPORTED', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const a = await store.create(h.baseInput({ title: 'a' }));
      const b = await store.create(h.baseInput({ title: 'b' }));
      await store.assignToGoal(goal, a, h.binding);
      await store.assignToGoal(goal, b, h.binding);
      await store.closeUnplanned(a, 'done');
      await store.closeUnplanned(b, 'done');

      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.open).toEqual([]);
      expect(frontier.complete).toBe(true);
      // …and the container is untouched by the report: still readable, still
      // carrying its members. Closing it is the Operator's act in the tracker.
      const goalView = await store.readGoal(goal, h.binding);
      expect(goalView.memberIds.sort()).toEqual([a, b].sort());
    });

    it('the frontier query is READ-ONLY — a second read reports the identical answer', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      await store.assignToGoal(goal, await store.create(h.baseInput()), h.binding);
      const first = await store.readGoalFrontier(goal, h.binding);
      const second = await store.readGoalFrontier(goal, h.binding);
      expect(second).toEqual(first);
    });

    it('a goal with no members reads complete (an empty remainder is empty)', async () => {
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.readings).toEqual([]);
      expect(frontier.complete).toBe(true);
    });

    it('readGoalFrontier throws on an unknown goal id', async () => {
      const { h, store } = await fresh();
      await expect(
        store.readGoalFrontier('definitely-not-a-goal', h.binding),
      ).rejects.toThrow();
    });

    // ── the reading's live NATIVE facts ────────────────────────────────────
    it('an ISSUE-DIRECT binding reports the native facts it does not have as ABSENT — never a placeholder', async () => {
      // The obligation `readGoalFrontier`'s contract puts on a fourth adapter,
      // pinned where all three shipped stores answer it in one body: a reading
      // carries `nativeState` and `health` where the binding HAS them, and says
      // NOTHING where it does not.
      //
      // All three bindings this suite drives are issue-direct — a GitHub
      // milestone's members, a Linear project's members and a MarkdownFs goal
      // file's members are all ISSUES — and for an issue there is no second,
      // richer native fact left to report: its workflow state is already spent
      // in full on `closed`/`claimed`, and none of the three trackers records a
      // health on an issue at all. So absence is the honest answer here, and
      // this is the case that holds a fourth adapter to giving it.
      //
      // **Asserted as key ABSENCE, which is the whole clause.** The failure this
      // catches is not "reported the wrong word" — it is a store filling the
      // field with something rather than leaving it out: `'open'`, `''`, `null`,
      // the state name it already spent on `closed`, or a key set to
      // `undefined`. Every one of those satisfies "the field is not a real
      // value" and every one of them destroys the distinction a caller needs —
      // "this binding has no such value" vs "this member's value is blank" —
      // and `toBeUndefined()` would wave three of them through.
      const { h, store } = await fresh();
      const goal = await makeGoal(h, store);
      const actionable = await store.create(h.baseInput({ title: 'ready' }));
      const bare = await store.create(h.bareInput({ title: 'bare' }));
      const finished = await store.create(h.baseInput({ title: 'finished' }));
      const moving = await store.create(h.baseInput({ title: 'moving' }));
      for (const id of [actionable, bare, finished, moving]) {
        await store.assignToGoal(goal, id, h.binding);
      }
      await store.closeUnplanned(finished, 'landed elsewhere');
      await store.transition(moving, 'in-flight');

      const frontier = await store.readGoalFrontier(goal, h.binding);
      // …across FOUR readings spanning four different states, so a green here is
      // not one state's accident: `done` in particular is the reading a store is
      // most tempted to decorate, because it is the one the five-state
      // vocabulary is lossiest about.
      expect(frontier.readings).toHaveLength(4);
      expect(new Set(frontier.readings.map((r) => r.state))).toEqual(
        new Set(['actionable', 'unready', 'done', 'in-motion']),
      );
      for (const reading of frontier.readings) {
        expect(Object.keys(reading).sort(), `${reading.id} (${reading.state})`).toEqual([
          'id',
          'state',
          'unresolvedBlockers',
        ]);
      }
    });

    // ── the container binding (ADR-0044 decision 4) ────────────────────────
    it('an ABSENT binding resolves to this store\'s own default, or refuses loudly — never a silent pick', async () => {
      const { h, store } = await fresh();
      const input = { title: 'Unbound', filingHint: 'unbound' };

      if (h.defaultsWithoutBinding === null) {
        // Linear's case: NO default, so every goal verb refuses, naming the key.
        const err = assertGoalBindingError(await thrownBy(() => store.createGoal(input)));
        expect(err.failure).toBe('unbound');
        expect(err.field).toBe('store.goal.container');
        expect(err.message).toContain('store.goal.container');
      } else {
        // GitHub / MarkdownFs: a default exists, and it is the one declared.
        const id = await store.createGoal(input);
        expect((await store.readGoal(id)).container).toBe(h.defaultsWithoutBinding);
      }
    });

    it('EVERY goal verb applies the binding rule — not just the one that mints', async () => {
      // A refusal that fired only on `createGoal` would leave four verbs able to
      // address a container nobody bound.
      const { h, store } = await fresh();
      if (h.defaultsWithoutBinding !== null) return; // no unbound case on this store

      const verbs: [string, () => Promise<unknown>][] = [
        ['createGoal', () => store.createGoal({ title: 'x', filingHint: 'x' })],
        ['readGoal', () => store.readGoal('anything')],
        ['listGoals', () => store.listGoals()],
        ['assignToGoal', () => store.assignToGoal('anything', 'anything')],
        ['readGoalFrontier', () => store.readGoalFrontier('anything')],
      ];
      for (const [name, call] of verbs) {
        const err = assertGoalBindingError(await thrownBy(call));
        expect(err.failure, `${name} did not refuse the unbound binding`).toBe('unbound');
        expect(err.field, name).toBe('store.goal.container');
      }
    });

    it('a role this store does NOT realize is refused BY NAME, before any write', async () => {
      const { h, store } = await fresh();
      const before = (await store.listGoals(h.binding)).length;

      const err = assertGoalBindingError(
        await thrownBy(() =>
          store.createGoal({ title: 'x', filingHint: 'x' }, h.unrealizedBinding),
        ),
      );
      expect(err.failure).toBe('unrealized-container');
      expect(err.configured).toBe(h.unrealizedBinding);
      expect(err.message).toContain(h.unrealizedBinding);
      // the refusal MINTED NOTHING — the same no-partial-application property
      // the create classifier gives `create()`.
      expect((await store.listGoals(h.binding)).length).toBe(before);
    });

    it('the refusal is STRUCTURED — a typed failure a caller routes on, not a message to grep', async () => {
      const { h, store } = await fresh();
      await expect(
        store.createGoal({ title: 'x', filingHint: 'x' }, h.unrealizedBinding),
      ).rejects.toMatchObject({
        name: 'GoalBindingError',
        code: 'goal-binding-invalid',
        field: 'store.goal.container',
        failure: 'unrealized-container',
      });
    });

    // ── the two ABSENCES, pinned rather than merely absent ─────────────────
    it('the facet exposes NO closeGoal and NO dispatch verb (ADR-0044 decisions 5 and 6)', async () => {
      const { store } = await fresh();
      // Walked over the whole prototype chain, not just own properties: a verb
      // added to a base class would be just as reachable and just as wrong.
      const surface = new Set<string>();
      for (
        let proto: object | null = store;
        proto !== null && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        for (const name of Object.getOwnPropertyNames(proto)) surface.add(name);
      }

      const forbidden = [
        // completion is the Operator's act in the tracker — the station owes
        // accounting, never the declaration.
        'closeGoal',
        'completeGoal',
        'shipGoal',
        'releaseGoal',
        // sight, never permission: a planning artifact must grant no execution.
        'dispatchGoal',
        'startGoal',
        'runGoal',
        'queueGoal',
        'claimGoal',
        'executeGoal',
        'goalDispatch',
      ];
      for (const name of forbidden) {
        expect(surface.has(name), `the facet must not expose \`${name}\``).toBe(false);
      }

      // Non-vacuity: the surface walk really can SEE a method — otherwise the
      // loop above would be green against any name at all, forbidden or not.
      expect(surface.has('createGoal')).toBe(true);
      expect(surface.has('readGoalFrontier')).toBe(true);
    });

    it('the goal surface is EXACTLY the five verbs ADR-0044 sanctions', async () => {
      const { store } = await fresh();
      const surface = new Set<string>();
      for (
        let proto: object | null = store;
        proto !== null && proto !== Object.prototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        for (const name of Object.getOwnPropertyNames(proto)) surface.add(name);
      }
      // Every PUBLIC goal-named member, whatever it is called: a sixth verb of
      // any spelling shows up here and fails, which is what makes this a pin on
      // the surface rather than a restatement of the interface.
      const goalVerbs = [...surface]
        .filter((n) => /goal/i.test(n) && !n.startsWith('_'))
        // `goalRole` / `goalMemberFacts` / `goalNumber` / `locateGoal` /
        // `nextGoalNN` / `goalIdFor` / `goalsDir` are per-adapter PRIVATE
        // helpers — TypeScript-private, so they are still own-property names at
        // runtime. The contract is about what a CALLER can meaningfully invoke,
        // and every one of those is named after its own store's mechanism, so
        // the filter keeps the five contract verbs.
        .filter((n) =>
          [
            'createGoal',
            'readGoal',
            'listGoals',
            'assignToGoal',
            'readGoalFrontier',
          ].includes(n),
        )
        .sort();
      expect(goalVerbs).toEqual(
        ['assignToGoal', 'createGoal', 'listGoals', 'readGoal', 'readGoalFrontier'].sort(),
      );
    });
  });
}

// ── the three registrations ─────────────────────────────────────────────────

function baseInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    title: 'A test issue',
    filingHint: 'a-test-issue',
    risk: 'mechanical',
    worker: 'background',
    files: ['src/x.ts'],
    blockedBy: 'none',
    acceptanceCriteria: [{ text: 'does the thing', checked: false }],
    ...overrides,
  };
}

function bareInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    title: 'A bare workstream',
    filingHint: 'a-bare-workstream',
    bodySections: [
      { heading: 'Gap', markdown: 'the workstream exists; its shape does not yet.' },
      { heading: 'Provenance', markdown: 'filed at the goal cut.' },
    ],
    ...overrides,
  };
}

const markdownRoots: string[] = [];
runGoalFacetConformance('MarkdownFsStore', async (): Promise<GoalHarness> => ({
  async makeStore() {
    const root = await mkdtemp(join(tmpdir(), 'goal-mdfs-'));
    markdownRoots.push(root);
    return new MarkdownFsStore({ repoRoot: root, slug: 'goal-feature' });
  },
  binding: 'goal-file',
  // No native container at all, so the facet IS the realization — nothing here
  // for a consumer convention to collide with, hence a default.
  defaultsWithoutBinding: 'goal-file',
  unrealizedBinding: 'milestone',
  baseInput,
  bareInput,
}));
afterEach(async () => {
  await Promise.all(
    markdownRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

runGoalFacetConformance('GitHubIssuesStore', (): GoalHarness => ({
  async makeStore() {
    return new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
  },
  binding: 'milestone',
  // Milestone is the ONLY GitHub container with direct issue membership, so the
  // default collides with no convention.
  defaultsWithoutBinding: 'milestone',
  unrealizedBinding: 'project',
  baseInput,
  bareInput,
}));

runGoalFacetConformance('LinearIssuesStore', (): GoalHarness => ({
  async makeStore() {
    return new LinearIssuesStore({ api: new InMemoryLinearApi() });
  },
  binding: 'project',
  // NO default, deliberately: one shipped consumer runs Initiative=Epic /
  // Project=User Story while ADR-0017 once sketched "Wave ≈ Linear Project", so
  // any built-in choice would silently overwrite somebody's meaning.
  defaultsWithoutBinding: null,
  // `initiative` is no longer the unrealized role on THIS store (ADR-0045
  // realized it here); `milestone` is a GitHub container Linear cannot be.
  unrealizedBinding: 'milestone',
  baseInput,
  bareInput,
}));

// ── `initiative` is realized on Linear ONLY (ADR-0045 / AC5) ─────────────────

describe('the initiative binding is realized on linear and refused elsewhere', () => {
  const initiativeRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      initiativeRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
    );
  });

  it('a LINEAR store mints, reads and lists an initiative-bound goal', async () => {
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const id = await store.createGoal(
      { title: 'Unternehmen verwalten', filingHint: 'uv', description: 'the epic' },
      'initiative',
    );
    const goal = await store.readGoal(id, 'initiative');
    expect(goal.container).toBe('initiative');
    expect(goal.title).toBe('Unternehmen verwalten');
    expect(goal.description).toBe('the epic');
    expect(goal.memberIds).toEqual([]);
    expect((await store.listGoals('initiative')).map((g) => g.id)).toEqual([id]);
  });

  it('GITHUB still refuses an initiative binding — `unrealized-container`, before any write', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const err = assertGoalBindingError(
      await thrownBy(() => store.createGoal({ title: 'x', filingHint: 'x' }, 'initiative')),
    );
    expect(err.failure).toBe('unrealized-container');
    expect(err.configured).toBe('initiative');
    expect((await store.listGoals('milestone')).length).toBe(0);
  });

  it('MARKDOWN-FS still refuses an initiative binding — `unrealized-container`, before any write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goal-init-refuse-'));
    initiativeRoots.push(root);
    const store = new MarkdownFsStore({ repoRoot: root, slug: 'goal-feature' });
    const err = assertGoalBindingError(
      await thrownBy(() => store.createGoal({ title: 'x', filingHint: 'x' }, 'initiative')),
    );
    expect(err.failure).toBe('unrealized-container');
    expect(err.configured).toBe('initiative');
    expect((await store.listGoals('goal-file')).length).toBe(0);
  });

  it('EVERY goal verb refuses the unrealized initiative binding, not just the one that mints', async () => {
    // The same completeness the binding suite demands of `unbound`: a refusal
    // that fired only on `createGoal` would leave five verbs able to address a
    // container this store does not have.
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const verbs: [string, () => Promise<unknown>][] = [
      ['createGoal', () => store.createGoal({ title: 'x', filingHint: 'x' }, 'initiative')],
      ['readGoal', () => store.readGoal('1', 'initiative')],
      ['listGoals', () => store.listGoals('initiative')],
      ['assignToGoal', () => store.assignToGoal('1', '2', 'initiative')],
      [
        'createGoalMember',
        () => store.createGoalMember('1', memberInput(), 'initiative'),
      ],
      ['readGoalFrontier', () => store.readGoalFrontier('1', 'initiative')],
    ];
    for (const [name, call] of verbs) {
      const err = assertGoalBindingError(await thrownBy(call));
      expect(err.failure, `${name} did not refuse the initiative binding`).toBe(
        'unrealized-container',
      );
    }
  });

  // ── the one binding whose members HAVE a native state (the other half of
  //    the issue-direct absence the conformance suite pins) ────────────────
  it('an initiative-bound member STATES its live native category — and the two lossy folds come apart', async () => {
    // Why this binding and no other: a member here is itself a CONTAINER, so it
    // carries a status category of its own, and five readings over six
    // categories is a lossy projection by construction. `started` and `paused`
    // both read `in-motion`; `completed` and `canceled` both read `done`. Those
    // two folds are the entire reason the field exists, so they are what this
    // case reads — a green on the four unfolded categories alone would prove
    // nothing about the ambiguity anyone actually hit.
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const goal = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'initiative');
    const member = await store.createGoalMember(goal, memberInput(), 'initiative');

    const seen = new Map<string, string[]>();
    for (const [category, state] of [
      ['backlog', 'unready'],
      ['planned', 'unready'],
      ['started', 'in-motion'],
      ['paused', 'in-motion'],
      ['completed', 'done'],
      ['canceled', 'done'],
    ] as const) {
      api.setProjectStatus(member, category);
      const reading = (await store.readGoalFrontier(goal, 'initiative')).readings[0];
      expect(reading.state, category).toBe(state);
      // the vendor's own word, verbatim — not a re-spelling of the reading.
      expect(reading.nativeState, category).toBe(category);
      seen.set(state, [...(seen.get(state) ?? []), category]);
    }
    // …and the folds really are folds: one reading, two native words, now
    // distinguishable at the far end.
    expect(seen.get('in-motion')).toEqual(['started', 'paused']);
    expect(seen.get('done')).toEqual(['completed', 'canceled']);
  });

  it('a category the ADAPTER could not read never reaches the reading dressed as one it could', async () => {
    // The failure this row would otherwise have SHIPPED. `LinearProject.statusType`
    // is a classification substrate and is allowed to be a substitute: an adapter
    // meeting a category outside the six narrows it to `backlog`, which is right
    // for classification and catastrophic the moment it is reported — a seventh
    // vendor category would surface here as `backlog`, a native fact the vendor
    // never stated, through the very field added to make native facts honest.
    //
    // Driven at the STORE, over a substituting producer, because that is the
    // seam that decides what a caller sees; `real-linear-api.spec.ts` pins the
    // other end (that the real query path discloses the substitution at all).
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const goal = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'initiative');
    await store.createGoalMember(goal, memberInput(), 'initiative');

    const listing = api.listInitiativeProjects.bind(api);
    api.listInitiativeProjects = async (initiativeId: string) =>
      (await listing(initiativeId)).map((p) => ({
        ...p,
        statusType: 'backlog' as const,
        unreadStatusType: 'archived_v2',
      }));

    const reading = (await store.readGoalFrontier(goal, 'initiative')).readings[0];
    // the vendor's actual word travels — opaque, unparsed, unmangled.
    expect(reading.nativeState).toBe('archived_v2');
    // …and the classification is EXACTLY what the narrowing's own justification
    // promised: an unreadable category reads `unready`, never `done` and never
    // `actionable`. Making the report honest must not cost that.
    expect(reading.state).toBe('unready');
  });

  it('…and a response that stated NO category at all reports NO native state — not the substitute', async () => {
    // The second substitution case, and the one a fix aimed only at "unknown
    // word" would miss: `status` absent from the projection entirely. There is
    // no vendor word to carry, so the honest report is the same absence the
    // three issue-direct bindings give — never the `backlog` the narrowing put
    // in `statusType` to keep the member off the wave's candidate set.
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const goal = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'initiative');
    await store.createGoalMember(goal, memberInput(), 'initiative');

    const listing = api.listInitiativeProjects.bind(api);
    api.listInitiativeProjects = async (initiativeId: string) =>
      (await listing(initiativeId)).map((p) => ({
        ...p,
        statusType: 'backlog' as const,
        unreadStatusType: null,
      }));

    const reading = (await store.readGoalFrontier(goal, 'initiative')).readings[0];
    expect('nativeState' in reading).toBe(false);
    expect(reading.state).toBe('unready');
  });
});

// ── the MEMBER verbs, driven across all FOUR bindings (ADR-0045) ─────────────
//
// A second conformance suite rather than more cases in the first one, and the
// split is the point: the suite above mints its members with `store.create` and
// so is issue-shaped by construction, which is exactly right for pinning that
// the three issue-direct bindings ship UNCHANGED. This one is member-kind-
// GENERIC — every member it touches comes from `createGoalMember` or from the
// harness's own minter — so the same clauses run against `initiative`, where a
// member is a project, without a single `if` about which store is under test.

/** A minimal valid {@link CreateGoalMemberInput}; cases override per clause. */
function memberInput(overrides: Partial<CreateGoalMemberInput> = {}): CreateGoalMemberInput {
  return {
    title: 'A workstream that must exist',
    filingHint: 'a-workstream',
    bodySections: [
      { heading: 'Gap', markdown: 'the workstream exists; its shape does not yet.' },
      { heading: 'Provenance', markdown: 'filed at the goal cut.' },
    ],
    ...overrides,
  };
}

interface GoalMemberHarness {
  makeStore(): Promise<IssueStore>;
  /** The binding every call in this suite passes explicitly. */
  binding: GoalContainer;
  /**
   * Mint a member of THIS binding's kind that is joined to NO goal — the driver
   * `assignToGoal` needs, and the only place in this suite where a store's own
   * mechanism is allowed to show (the `simulateNativeClose` precedent).
   */
  mintLooseMember(store: IssueStore, title: string): Promise<string>;
  /**
   * How many members this store has minted in total — the no-partial-mint probe.
   * Declared per store because "did anything get filed?" is unanswerable from
   * the facet contract alone: a minted-but-unjoined member is in no goal, so
   * `listGoals` cannot see it, which is precisely the state the probe is for.
   */
  mintedMemberCount(store: IssueStore): Promise<number>;
  /**
   * An id shaped like the OTHER member kind, or `null` when this store's two id
   * spaces are INDISTINGUISHABLE by shape. GitHub is the `null` case and it is a
   * real property, not a gap: milestone `'1'` and issue `'1'` are the same three
   * bytes, so no shape rule could tell them apart there.
   */
  wrongKindMemberId: string | null;
  /**
   * Can this store realize `createGoalMember`'s `blockedBy` arm natively?
   * `false` is MarkdownFs's honest answer — its only blocker representation is
   * the Header-Block line a bare member must not carry.
   */
  blockedByRealizable: boolean;
}

function runGoalMemberVerbConformance(
  label: string,
  makeHarness: () => Promise<GoalMemberHarness> | GoalMemberHarness,
): void {
  describe(`Goal member verbs — ${label}`, () => {
    async function fresh() {
      const h = await makeHarness();
      const store = await h.makeStore();
      const goal = await store.createGoal(
        { title: 'Ship it', filingHint: 'ship-it' },
        h.binding,
      );
      return { h, store, goal };
    }

    // ── createGoalMember: ONE act ──────────────────────────────────────────
    it('mints a direct member AND joins it — one act, not two', async () => {
      const { h, store, goal } = await fresh();
      const id = await store.createGoalMember(goal, memberInput(), h.binding);

      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([id]);
    });

    it('the minted member is BARE — it reads `unready`, so no wave can draw it', async () => {
      // The invariant that makes this verb safe for the cut pass: existence
      // first, readiness later. Stated through the FRONTIER rather than through
      // a label or a status, so it means the same thing at both member
      // granularities — an unmarked issue and an empty project both read
      // `unready`, and neither is drawable.
      const { h, store, goal } = await fresh();
      const id = await store.createGoalMember(goal, memberInput(), h.binding);

      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.readings.map((r) => r.id)).toEqual([id]);
      expect(frontier.readings[0].state).toBe('unready');
      // …and it is nowhere near the wave candidate set.
      expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(id);
    });

    it('two members join the same goal, each with its own id', async () => {
      const { h, store, goal } = await fresh();
      const a = await store.createGoalMember(goal, memberInput({ title: 'A' }), h.binding);
      const b = await store.createGoalMember(goal, memberInput({ title: 'B' }), h.binding);
      expect(a).not.toBe(b);
      expect((await store.readGoal(goal, h.binding)).memberIds.sort()).toEqual([a, b].sort());
    });

    it('an UNKNOWN goal id refuses BEFORE the mint — nothing is filed', async () => {
      // Pre-validation is the whole no-partial-application property here: a
      // typo'd goal must not leave a real member behind for someone to find
      // later with no idea where it came from.
      const { h, store } = await fresh();
      const before = await h.mintedMemberCount(store);

      await expect(
        store.createGoalMember('definitely-not-a-goal', memberInput(), h.binding),
      ).rejects.toThrow();

      expect(await h.mintedMemberCount(store)).toBe(before);
    });

    it('an unrealizable BINDING refuses before the mint too', async () => {
      const { h, store } = await fresh();
      const unrealized: GoalContainer = h.binding === 'milestone' ? 'project' : 'milestone';
      const before = await h.mintedMemberCount(store);

      const err = assertGoalBindingError(
        await thrownBy(() => store.createGoalMember('anything', memberInput(), unrealized)),
      );
      expect(err.failure).toBe('unrealized-container');
      expect(await h.mintedMemberCount(store)).toBe(before);
    });

    // ── assignToGoal, member-kind-generically ──────────────────────────────
    it('assignToGoal joins a loose member of this binding\'s own kind', async () => {
      const { h, store, goal } = await fresh();
      const loose = await h.mintLooseMember(store, 'joined by hand');
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([]);

      await store.assignToGoal(goal, loose, h.binding);

      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([loose]);
    });

    it('assignToGoal stays idempotent at every member kind', async () => {
      const { h, store, goal } = await fresh();
      const loose = await h.mintLooseMember(store, 'twice');
      await store.assignToGoal(goal, loose, h.binding);
      await store.assignToGoal(goal, loose, h.binding);
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual([loose]);
    });

    // ── the id-KIND refusal (ADR-0045 decision 3) ──────────────────────────
    it('refuses a WRONG-KIND member id, typed, before any write', async () => {
      const { h, store, goal } = await fresh();
      if (h.wrongKindMemberId === null) {
        // GitHub: the two id spaces collide by value, so there is no shape rule
        // to apply — and the honest thing is to say so rather than assert a
        // refusal that could not exist. The clause still runs: it pins that this
        // store's member kind is `issue`, which is WHY no refusal is owed.
        expect(goalMemberKind(h.binding)).toBe('issue');
        return;
      }
      const before = (await store.readGoal(goal, h.binding)).memberIds;

      const err = await thrownBy(() =>
        store.assignToGoal(goal, h.wrongKindMemberId as string, h.binding),
      );
      expect(err).toBeInstanceOf(GoalMemberKindError);
      expect((err as GoalMemberKindError).expected).toBe(goalMemberKind(h.binding));
      expect((err as GoalMemberKindError).memberId).toBe(h.wrongKindMemberId);
      // …and the refusal wrote NOTHING.
      expect((await store.readGoal(goal, h.binding)).memberIds).toEqual(before);
    });

    // ── the blockedBy arm (ADR-0045 decision 4) ────────────────────────────
    it('blockedBy draws a native edge the frontier reads back — or refuses typed', async () => {
      const { h, store, goal } = await fresh();
      const blocker = await store.createGoalMember(
        goal,
        memberInput({ title: 'workstream A', filingHint: 'a' }),
        h.binding,
      );

      if (!h.blockedByRealizable) {
        // MarkdownFs's honest refusal: report what the storage cannot
        // represent, never fake it. Typed, and before any write.
        const before = await h.mintedMemberCount(store);
        const err = await thrownBy(() =>
          store.createGoalMember(
            goal,
            memberInput({ title: 'workstream B', filingHint: 'b', blockedBy: [blocker] }),
            h.binding,
          ),
        );
        expect(err).toBeInstanceOf(CreateInputError);
        expect((err as CreateInputError).failure).toBe('bare-blocked-by-unrepresentable');
        expect(await h.mintedMemberCount(store)).toBe(before);
        return;
      }

      const blocked = await store.createGoalMember(
        goal,
        memberInput({ title: 'workstream B', filingHint: 'b', blockedBy: [blocker] }),
        h.binding,
      );

      const frontier = await store.readGoalFrontier(goal, h.binding);
      const reading = frontier.readings.find((r) => r.id === blocked);
      // The edge was drawn NATIVELY at the cut — between two BARE members, with
      // no header line anywhere — which is the whole reason this arm exists.
      expect(reading?.state).toBe('blocked');
      // …and the reading NAMES what it waits on rather than merely asserting it.
      expect(reading?.unresolvedBlockers.length).toBeGreaterThanOrEqual(1);
    });

    // ── the live native facts, stated MEMBER-KIND-GENERICALLY ──────────────
    it('a native fact is either a real word or ABSENT — never a placeholder, on any binding', async () => {
      // The contract clause a fourth adapter inherits, in the form that holds
      // for all four bindings at once — including `initiative`, where a member
      // is a PROJECT and DOES have a native state to state. The suite above
      // pins the issue-direct half (absent, because there is nothing to say);
      // this one pins the half that survives a binding which has something to
      // say, and it needs no `if` about which store is under test because it
      // asserts the SHAPE rather than the value:
      //
      //   present ⇒ a non-empty string the tracker actually uses
      //   otherwise ⇒ the key is not there at all
      //
      // Everything a store might reach for to avoid saying "I don't know" —
      // `null`, `''`, `undefined`-as-a-value, a `{}`, a number — fails this,
      // which is the point. An adapter that fills the field with a placeholder
      // is worse than one that leaves it out, because a caller can act on
      // absence and cannot act on a lie.
      const { h, store, goal } = await fresh();
      const a = await store.createGoalMember(goal, memberInput({ title: 'A' }), h.binding);
      const b = await store.createGoalMember(
        goal,
        memberInput({ title: 'B', filingHint: 'b' }),
        h.binding,
      );

      const frontier = await store.readGoalFrontier(goal, h.binding);
      expect(frontier.readings.map((r) => r.id).sort()).toEqual([a, b].sort());
      for (const reading of frontier.readings) {
        for (const field of ['nativeState', 'health'] as const) {
          // A MISSING key is a complete answer and asserts nothing further. The
          // clause bites on a key that is THERE: it must hold a real word.
          // `undefined`-as-a-value fails here too, and deliberately — a key set
          // to `undefined` is present, disappears from a JSON render, and is
          // exactly the half-absence that makes "absent stays absent all the way
          // out" untestable at the far end.
          if (!(field in reading)) continue;
          const value = reading[field];
          expect(typeof value, `${field} on ${reading.id}`).toBe('string');
          expect((value as string).length, `${field} on ${reading.id}`).toBeGreaterThan(0);
        }
      }
    });
  });
}

const memberVerbRoots: string[] = [];
runGoalMemberVerbConformance('MarkdownFsStore', async (): Promise<GoalMemberHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'goal-member-mdfs-'));
  memberVerbRoots.push(root);
  return {
    async makeStore() {
      return new MarkdownFsStore({ repoRoot: root, slug: 'goal-feature' });
    },
    binding: 'goal-file',
    async mintLooseMember(store, title) {
      return store.create(bareInput({ title, filingHint: title.replace(/\W+/g, '-') }));
    },
    async mintedMemberCount() {
      // Mechanism, and legitimately so — the harness is where a store's own
      // storage is allowed to show. Counting FILES is the only way to see a
      // member that was minted and never joined. Open issues sit directly in
      // `issues/` (`done/` is a subdirectory), hence the `.md` filter.
      const dir = join(root, '.scratch', 'goal-feature', 'issues');
      try {
        return (await readdir(dir)).filter((n) => n.endsWith('.md')).length;
      } catch {
        return 0; // the directory is not made until the first mint
      }
    },
    // A goal id here is `<slug>#goal-NN` and an issue id `<slug>#NN`, so the two
    // ARE distinguishable — but this binding's members are issues, so there is
    // no wrong-kind refusal owed. Declared `null` for the same reason GitHub is.
    wrongKindMemberId: null,
    // Its ONLY blocker representation is the Header-Block line a bare member
    // must not carry (ADR-0044's recorded refusal).
    blockedByRealizable: false,
  };
});
afterEach(async () => {
  await Promise.all(
    memberVerbRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

runGoalMemberVerbConformance('GitHubIssuesStore', (): GoalMemberHarness => {
  const api = new InMemoryGitHubApi();
  return {
    async makeStore() {
      return new GitHubIssuesStore({ api });
    },
    binding: 'milestone',
    async mintLooseMember(store, title) {
      return store.create(bareInput({ title, filingHint: title.replace(/\W+/g, '-') }));
    },
    async mintedMemberCount() {
      return (await api.listOpenIssues()).length;
    },
    // The id-space COLLISION this codebase records: milestone `'1'` and issue
    // `'1'` are the same three bytes, so no shape rule could tell them apart.
    wrongKindMemberId: null,
    blockedByRealizable: true,
  };
});

runGoalMemberVerbConformance('LinearIssuesStore (project binding)', (): GoalMemberHarness => {
  const api = new InMemoryLinearApi();
  return {
    async makeStore() {
      return new LinearIssuesStore({ api });
    },
    binding: 'project',
    async mintLooseMember(store, title) {
      return store.create(bareInput({ title, filingHint: title.replace(/\W+/g, '-') }));
    },
    async mintedMemberCount() {
      return (await api.listOpenIssues()).length;
    },
    wrongKindMemberId: null,
    blockedByRealizable: true,
  };
});

runGoalMemberVerbConformance('LinearIssuesStore (INITIATIVE binding)', (): GoalMemberHarness => {
  const api = new InMemoryLinearApi();
  return {
    async makeStore() {
      return new LinearIssuesStore({ api });
    },
    binding: 'initiative',
    async mintLooseMember(_store, title) {
      // A PROJECT, minted straight on the substrate: there is no facet verb for
      // a free-floating member, deliberately (creation is goal-anchored), so the
      // harness reaches the api exactly as the conformance hooks do.
      const { id } = await api.createProject({ name: title, description: '' });
      return id;
    },
    async mintedMemberCount() {
      return (await api.listProjects()).length;
    },
    // The predictable confusion this refusal exists for: reaching for the ISSUE
    // somebody is looking at instead of the project it lives in.
    wrongKindMemberId: 'EX-16',
    blockedByRealizable: true,
  };
});

// ── the binding vocabulary and its resolvers (store-independent) ─────────────

describe('the goal-container binding vocabulary (ADR-0044 decision 4)', () => {
  it('GOAL_CONTAINERS names all four roles, including the DEFERRED one', () => {
    expect([...GOAL_CONTAINERS].sort()).toEqual(
      ['goal-file', 'initiative', 'milestone', 'project'].sort(),
    );
    // `initiative` is in the vocabulary precisely so the deferral can be a NAMED
    // follow-up: a consumer binding it gets "this store does not realize it
    // yet", not "that is not a container".
    expect(GOAL_CONTAINERS).toContain('initiative');
  });

  it('parseGoalContainer reads an absent binding as absent, never as a failure', () => {
    expect(parseGoalContainer(undefined)).toBeUndefined();
    expect(parseGoalContainer(null)).toBeUndefined();
  });

  it('parseGoalContainer accepts every declared role verbatim', () => {
    for (const role of GOAL_CONTAINERS) {
      expect(parseGoalContainer(role)).toBe(role);
    }
  });

  it('parseGoalContainer REFUSES a present-but-wrong value — configured means authoritative', () => {
    for (const bad of ['Milestone', 'epic', '', 7, {}, []]) {
      let thrown: unknown;
      try {
        parseGoalContainer(bad);
      } catch (err) {
        thrown = err;
      }
      const err = assertGoalBindingError(thrown);
      expect(err.failure).toBe('unknown-container');
      expect(err.field).toBe('store.goal.container');
    }
    // the offending value is echoed when it was a string at all — a role name
    // from tracked config is a pointer, never a secret.
    try {
      parseGoalContainer('Milestone');
    } catch (err) {
      expect((err as GoalBindingError).configured).toBe('Milestone');
    }
  });

  it('requireGoalContainer prefers the configured role over the fallback', () => {
    expect(
      requireGoalContainer({
        storeKind: 'test',
        configured: 'milestone',
        fallback: 'goal-file',
        realizable: ['milestone', 'goal-file'],
      }),
    ).toBe('milestone');
  });

  it('requireGoalContainer falls back only when NOTHING is configured', () => {
    expect(
      requireGoalContainer({
        storeKind: 'test',
        configured: undefined,
        fallback: 'goal-file',
        realizable: ['goal-file'],
      }),
    ).toBe('goal-file');
  });

  it('requireGoalContainer refuses `unbound` when there is no configured role AND no fallback', () => {
    let thrown: unknown;
    try {
      requireGoalContainer({
        storeKind: 'linear',
        configured: undefined,
        fallback: undefined,
        realizable: ['project'],
      });
    } catch (err) {
      thrown = err;
    }
    const err = assertGoalBindingError(thrown);
    expect(err.failure).toBe('unbound');
    expect(err.configured).toBeUndefined();
    // the message must NAME the key to set and the roles that are on offer,
    // or it teaches nothing the caller can act on.
    expect(err.message).toContain('store.goal.container');
    expect(err.message).toContain('project');
  });

  it('requireGoalContainer refuses `initiative` by NAME on a store that does not realize it', () => {
    // ADR-0045 realized `initiative` on Linear and ONLY there, so this refusal
    // is now about the store rather than about a deferral: the message must say
    // where the role DOES live, or it teaches nothing the author can act on.
    let thrown: unknown;
    try {
      requireGoalContainer({
        storeKind: 'github',
        configured: 'initiative',
        fallback: 'milestone',
        realizable: ['milestone'],
      });
    } catch (err) {
      thrown = err;
    }
    const err = assertGoalBindingError(thrown);
    expect(err.failure).toBe('unrealized-container');
    expect(err.message).toMatch(/initiative/i);
    expect(err.message).toMatch(/linear/i);
    // …and the roles actually on offer, so the fix is spelled out.
    expect(err.message).toMatch(/milestone/);
  });
});

// ── the member KIND, and the two write verbs that follow it (ADR-0045) ───────

describe('a Goal member\'s KIND follows the binding (ADR-0045 decision 1)', () => {
  it('the mapping covers EVERY declared container — no role can be reached without an answer', () => {
    // A container added to the vocabulary without a member kind would leave
    // `goalMemberKind` returning undefined and every branch below it silently
    // taking the issue arm. Enumerating the vocabulary rather than the mapping
    // is what makes this catch that.
    for (const role of GOAL_CONTAINERS) {
      expect(['issue', 'project'], role).toContain(goalMemberKind(role));
    }
    expect(Object.keys(GOAL_MEMBER_KIND_BY_CONTAINER).sort()).toEqual(
      [...GOAL_CONTAINERS].sort(),
    );
  });

  it('the three issue-direct roles hold ISSUES; `initiative` alone holds PROJECTS', () => {
    expect(goalMemberKind('milestone')).toBe('issue');
    expect(goalMemberKind('project')).toBe('issue');
    expect(goalMemberKind('goal-file')).toBe('issue');
    expect(goalMemberKind('initiative')).toBe('project');
  });

  it('requireGoalMemberKind refuses an issue-shaped id under a PROJECT-member binding, typed', () => {
    let thrown: unknown;
    try {
      requireGoalMemberKind({
        storeKind: 'linear',
        container: 'initiative',
        memberId: 'EX-16',
        isIssueShaped: () => true,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GoalMemberKindError);
    const err = thrown as GoalMemberKindError;
    expect(err.name).toBe('GoalMemberKindError');
    expect(err.code).toBe('goal-member-kind-invalid');
    expect(err.expected).toBe('project');
    expect(err.container).toBe('initiative');
    expect(err.memberId).toBe('EX-16');
    // The message must name the fix, not just the fault — either pass the
    // project, or rebind the container.
    expect(err.message).toMatch(/project/i);
    expect(err.message).toMatch(/store\.goal\.container/);
  });

  it('…and stays silent on EVERY issue-direct binding — the three ship unchanged', () => {
    // The negative control for the clause above: if this rule fired under an
    // issue binding it would newly reject ids the shipped stores accept. Driven
    // with `isIssueShaped` BOTH ways, so the silence is about the binding and
    // not about the id happening to look right.
    for (const role of ['milestone', 'project', 'goal-file'] as const) {
      for (const shaped of [true, false]) {
        expect(() =>
          requireGoalMemberKind({
            storeKind: 'test',
            container: role,
            memberId: 'whatever',
            isIssueShaped: () => shaped,
          }),
        ).not.toThrow();
      }
    }
  });

  it('a PROJECT-shaped id under a project-member binding passes — the rule is one-directional', () => {
    expect(() =>
      requireGoalMemberKind({
        storeKind: 'linear',
        container: 'initiative',
        memberId: 'prj-uuid-1',
        isIssueShaped: () => false,
      }),
    ).not.toThrow();
  });
});

// ── the frontier vocabulary, read through the facet ──────────────────────────

describe('every frontier state is REACHED through a real store (not just typed)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goal-reach-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('one goal, five members, five distinct readings', async () => {
    // The suite above pins each state on its own; this one proves the five are
    // simultaneously reachable through one container — i.e. the classification
    // is not quietly collapsing two of them on a real store.
    const store = new MarkdownFsStore({ repoRoot: root, slug: 'reach' });
    const goal = await store.createGoal({ title: 'Everything', filingHint: 'everything' });

    const finished = await store.create(baseInput({ title: 'finished' }));
    const moving = await store.create(baseInput({ title: 'moving' }));
    const ready = await store.create(baseInput({ title: 'ready' }));
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const waiting = await store.create(
      baseInput({ title: 'waiting', blockedBy: [store.parseRef(blocker)] }),
    );
    const bare = await store.create(bareInput());

    for (const id of [finished, moving, ready, waiting, bare]) {
      await store.assignToGoal(goal, id);
    }
    await store.closeUnplanned(finished, 'landed');
    await store.transition(moving, 'in-flight');

    const frontier = await store.readGoalFrontier(goal);
    const byId = new Map(frontier.readings.map((r) => [r.id, r.state]));
    expect(byId.get(finished)).toBe('done');
    expect(byId.get(moving)).toBe('in-motion');
    expect(byId.get(ready)).toBe('actionable');
    expect(byId.get(waiting)).toBe('blocked');
    expect(byId.get(bare)).toBe('unready');

    // …and the five observed readings really are five DIFFERENT ones.
    const observed = new Set<GoalMemberState>(frontier.readings.map((r) => r.state));
    expect([...observed].sort()).toEqual([...GOAL_MEMBER_STATES].sort());
    expect(frontier.counts).toEqual({
      done: 1,
      'in-motion': 1,
      actionable: 1,
      blocked: 1,
      unready: 1,
    });
    expect(frontier.open).toHaveLength(4);
    expect(frontier.complete).toBe(false);
  });
});
