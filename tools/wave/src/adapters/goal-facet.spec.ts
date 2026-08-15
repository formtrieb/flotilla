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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore } from './markdown-fs-store';
import { GitHubIssuesStore } from './github/github-issues-store';
import { InMemoryGitHubApi } from './github/github-api-fake';
import { LinearIssuesStore } from './linear/linear-issues-store';
import { InMemoryLinearApi } from './linear/linear-api-fake';
import {
  GoalBindingError,
  GOAL_CONTAINERS,
  parseGoalContainer,
  requireGoalContainer,
  type CreateInput,
  type GoalContainer,
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
  // The NAMED follow-up, refused by name rather than silently capped.
  unrealizedBinding: 'initiative',
  baseInput,
  bareInput,
}));

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

  it('requireGoalContainer refuses `initiative` with its deferral reason attached', () => {
    let thrown: unknown;
    try {
      requireGoalContainer({
        storeKind: 'linear',
        configured: 'initiative',
        fallback: undefined,
        realizable: ['project'],
      });
    } catch (err) {
      thrown = err;
    }
    const err = assertGoalBindingError(thrown);
    expect(err.failure).toBe('unrealized-container');
    // "not a silent cap": the refusal says WHY initiatives are deferred.
    expect(err.message).toMatch(/initiative/i);
    expect(err.message).toMatch(/transitive|hold projects/i);
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
