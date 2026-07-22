import { describe, it, expect, beforeEach } from 'vitest';
import { LinearIssuesStore, DEFAULT_LINEAR_STATES, LinearTransitionVerifyError } from './linear-issues-store';
import { InMemoryLinearApi, linearConformanceHooks } from './linear-api-fake';
import type { LinearStateType } from './linear-api';
import type { CreateInput } from '../issue-store';
import { parseBody } from '../body-codec';
import { DEFAULT_TRIAGE_SCHEMA } from '../../contract';
import {
  runIssueStoreConformance,
  type ConformanceHarness,
} from '../conformance/issue-store-conformance';

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

// ── the SAME shared contract MarkdownFsStore + GitHubIssuesStore pass, zero suite changes ──
runIssueStoreConformance('LinearIssuesStore', (): ConformanceHarness => ({
  async makeStore() {
    return new LinearIssuesStore({ api: new InMemoryLinearApi() });
  },
  hooks: linearConformanceHooks,
  baseInput,
}));

// ── Linear-specific mapping (storage-aware: the part conformance can't see) ──
describe('LinearIssuesStore — Linear-specific mapping (ADR-0020)', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  it("transition('in-flight') sets the workflow state NAME 'In Progress' (the claim IS the state)", async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'in-flight');
    const issue = await api.getIssue(id);
    expect(issue.stateName).toBe(DEFAULT_LINEAR_STATES.inFlight); // 'In Progress'
    expect(issue.stateType).toBe('started');
    // and the claim is NOT written as a label (the GitHub mechanism), ADR-0020.
    expect(issue.labels).not.toContain('wave/in-flight');
  });

  it("transition('queued') then 'in-review' moves state names (mutually exclusive, one state)", async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'queued');
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.queued); // 'Todo'
    await store.transition(id, 'in-review');
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.inReview); // 'In Review'
  });

  it('transition twice is idempotent (state set twice, no error)', async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'in-flight');
    await store.transition(id, 'in-flight');
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.inFlight);
    expect((await store.read(id)).status).toBe('in-flight');
  });

  // ── verify-after-write (consumer KW-F2, FOR-64) ──────────────────────────
  it('transition() throws a named LinearTransitionVerifyError when setState reports success but silently drops the write', async () => {
    const id = await store.create(baseInput());
    api.simulateDroppedStateWrite(id);
    await expect(store.transition(id, 'in-flight')).rejects.toThrow(LinearTransitionVerifyError);
    // the fake genuinely dropped the write — the issue never actually moved.
    expect((await api.getIssue(id)).stateName).not.toBe(DEFAULT_LINEAR_STATES.inFlight);
  });

  it('the LinearTransitionVerifyError carries the issue id, expected state, and the (unmoved) actual state', async () => {
    const id = await store.create(baseInput());
    const before = (await api.getIssue(id)).stateName;
    api.simulateDroppedStateWrite(id);
    let thrown: unknown;
    try {
      await store.transition(id, 'in-flight');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinearTransitionVerifyError);
    const e = thrown as LinearTransitionVerifyError;
    expect(e.issueId).toBe(id);
    expect(e.expectedState).toBe(DEFAULT_LINEAR_STATES.inFlight);
    expect(e.actualState).toBe(before);
  });

  it('after a dropped-write failure is surfaced, a retried transition (drop budget spent) succeeds and is verified normally', async () => {
    const id = await store.create(baseInput());
    api.simulateDroppedStateWrite(id); // drops exactly the next call
    await expect(store.transition(id, 'in-flight')).rejects.toThrow(LinearTransitionVerifyError);
    await store.transition(id, 'in-flight'); // retry — no more drops queued
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.inFlight);
  });

  it('the happy path is unaffected — a normal transition still sets the mapped state with no error', async () => {
    const id = await store.create(baseInput());
    await expect(store.transition(id, 'in-review')).resolves.toBeUndefined();
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.inReview);
  });

  it("unclaim from 'Todo' moves to 'Backlog'; unclaim when 'Backlog' is a no-op", async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'queued'); // → 'Todo'
    await store.unclaim(id);
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unclaimTarget); // 'Backlog'
    // a second unclaim (already in Backlog, not a claim state) is a no-op.
    await store.unclaim(id);
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unclaimTarget);
  });

  it("a fake issue hand-set to state 'Done' (type completed) reads status 'done'", async () => {
    const id = await store.create(baseInput());
    await api.setState(id, 'Done');
    expect((await store.read(id)).status).toBe('done');
  });

  it("a fake issue hand-set to 'Canceled' (type canceled) reads status 'done' (lossy, ADR-0002)", async () => {
    const id = await store.create(baseInput());
    await api.setState(id, 'Canceled');
    expect((await store.read(id)).status).toBe('done');
  });

  it("a fake issue in a 'duplicate'-TYPE state reads 'done', is excluded from listOpen, and probes closed-unknown (live e2e find, 2026-07-15)", async () => {
    // Linear's live workflow-state categories include a SEVENTH type,
    // `duplicate` (a live team carries one) — the first live run died
    // in ensureCatalog on it. A duplicate-closed issue must project `done`
    // (ADR-0020: done ⊇ completed ∪ canceled/duplicate) and never re-surface
    // as a wave-ready candidate.
    //
    // The probe reads `closed-unknown`, NOT `closed-unmerged` (W2-F1c): closing
    // an issue as a duplicate involves no PR at all, so there is no evidence a
    // PR was rejected. Calling it `closed-unmerged` would make wave-close flag
    // a deliberate triage decision as a rejected PR.
    const id = await store.create(baseInput());
    await api.setState(id, 'Duplicate');
    expect((await store.read(id)).status).toBe('done');
    const open = await store.listOpen('wave-ready');
    expect(open.map((v) => v.id)).not.toContain(id);
    expect((await store.readClosing(id)).state).toBe('closed-unknown');
  });

  it("custom states map: states:{queued:'Agent-Queue'} → transition('queued') sets 'Agent-Queue'", async () => {
    const customApi = new InMemoryLinearApi();
    // the consumer's workflow has an 'Agent-Queue' column instead of 'Todo'.
    const catalog: { name: string; type: LinearStateType }[] = [
      { name: 'Backlog', type: 'backlog' },
      { name: 'Agent-Queue', type: 'unstarted' },
      { name: 'In Progress', type: 'started' },
      { name: 'In Review', type: 'started' },
      { name: 'Done', type: 'completed' },
      { name: 'Canceled', type: 'canceled' },
    ];
    customApi.setStateCatalog(catalog);
    const customStore = new LinearIssuesStore({
      api: customApi,
      states: { queued: 'Agent-Queue' },
    });
    const id = await customStore.create(baseInput());
    await customStore.transition(id, 'queued');
    expect((await customApi.getIssue(id)).stateName).toBe('Agent-Queue');
    // and read() projects it back to the 'queued' rung via the custom mapping.
    expect((await customStore.read(id)).status).toBe('queued');
  });

  it('create() puts risk/worker/eligibility into labels and Files/AC into the description', async () => {
    const id = await store.create(
      baseInput({
        risk: 'isolated-refactor',
        worker: 'background-heavy',
        files: ['src/one.ts', 'src/two.ts'],
        acceptanceCriteria: [
          { text: 'first', checked: false },
          { text: 'second', checked: false },
        ],
      }),
    );
    const issue = await api.getIssue(id);
    // vocabulary-shaped → LABELS (eligibility token + risk/* + worker/*), ADR-0020.
    expect(issue.labels).toContain('ready-for-agent');
    expect(issue.labels).toContain('risk/isolated-refactor');
    expect(issue.labels).toContain('worker/background-heavy');
    // files/AC → the DESCRIPTION via the shared body-codec (parseBody round-trip).
    const parsed = parseBody(issue.description);
    expect(parsed.files).toEqual(['src/one.ts', 'src/two.ts']);
    expect(parsed.acceptanceCriteria.map((a) => a.text)).toEqual(['first', 'second']);
    expect(parsed.acceptanceCriteria.every((a) => a.checked === false)).toBe(true);
  });

  it('needs-attention is a LABEL orthogonal to the claim state (ADR-0006)', async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'in-flight'); // state → 'In Progress'
    await store.flag(id, {
      kind: 'recoverable-stop',
      question: 'proceed?',
      options: ['yes', 'no'],
    });
    const issue = await api.getIssue(id);
    // the flag is a label; the underlying claim STATE survives untouched.
    expect(issue.labels).toContain('wave/needs-attention');
    expect(issue.stateName).toBe(DEFAULT_LINEAR_STATES.inFlight);
    expect((await store.read(id)).status).toBe('needs-attention');
    // clearing the flag re-surfaces the preserved claim rung.
    await store.clearFlag(id);
    expect((await store.read(id)).status).toBe('in-flight');
  });

  it('done wins over a needs-attention flag (coarse projection: closed wins, ADR-0006 carve-out, final review)', async () => {
    const id = await store.create(baseInput());
    await store.flag(id, { kind: 'terminal-failure', question: 'q', options: ['a'] });
    api.simulateUnmergedClose(id); // terminal state category, no merged attachment
    expect((await store.read(id)).status).toBe('done');
  });

  it('the closing probe reads the GitHub-integration PR attachment (merged vs unmerged)', async () => {
    const merged = await store.create(baseInput());
    api.simulateMergedPrClose(merged, 'https://github.com/o/r/pull/9');
    expect(await store.readClosing(merged)).toEqual({
      state: 'merged',
      prUrl: 'https://github.com/o/r/pull/9',
    });

    const unmerged = await store.create(baseInput());
    api.simulateUnmergedClose(unmerged);
    expect((await store.readClosing(unmerged)).state).toBe('closed-unmerged');
  });
});

// ── blockedBy read-union (ADR-0020 DoR-gate fix): the body-codec can't see the
// consumer's existing NATIVE Linear blocked-by relations — read() must union
// both sides, deduped by normalized ref identity, or the DoR gate dispatches a
// row whose real blocker is still open. ──────────────────────────────────────
describe('LinearIssuesStore — blockedBy read-union (ADR-0020 DoR-gate fix)', () => {
  it('read() unions body-codec blockedBy with native relations', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(blocker)] }),
    );
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    api.addNativeRelation(blocked, nativeBlocker);
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toHaveLength(2); // codec ref + native ref, deduped
    expect(ids.sort()).toEqual([store.parseRef(blocker).issue, store.parseRef(nativeBlocker).issue].sort());
  });

  it('a purely-native blocker surfaces even with an empty codec block', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    const blocked = await store.create(baseInput({ title: 'blocked', blockedBy: 'none' }));
    api.addNativeRelation(blocked, nativeBlocker);
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toEqual([store.parseRef(nativeBlocker).issue]);
  });

  it('duplicate codec+native refs dedupe to one', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(blocker)] }),
    );
    api.addNativeRelation(blocked, blocker); // the SAME blocker, both ways
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toEqual([store.parseRef(blocker).issue]);
  });

  it('a slug-less codec ref (hand-written same-team shorthand, e.g. "#16") dedupes against a native ref for the same blocker', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    // parse the number out of the blocker id — a hand-edited body can omit the
    // slug for a same-team ref (body-codec REF_RE: `#16` → `{issue: 16}`), while
    // a native relation is always minted via parseRef() and so always carries
    // the resolved team slug (e.g. `EX#16`). Both name the SAME blocker.
    const blockerNumber = store.parseRef(blocker).issue;
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [{ issue: blockerNumber }] }),
    );
    api.addNativeRelation(blocked, blocker);
    const view = await store.read(blocked);
    expect(view.blockedBy === 'none' ? [] : view.blockedBy).toHaveLength(1);
  });
});

// ── blockedBy native WRITE half (ADR-0020 fast-follow): create/annotate MIRROR
// the canonical body-codec blockedBy into native Linear relations so a blocked
// row carries a visible board relation, not just a body line. Additive-only
// (never deletes), best-effort (a failed mirror never fails the issue write),
// and the body codec stays the canonical, store-agnostic home. ───────────────
describe('LinearIssuesStore — blockedBy native WRITE half (ADR-0020 fast-follow)', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  it('create mirrors EVERY blockedBy ref into a native relation (multi-ref)', async () => {
    const b1 = await store.create(baseInput({ title: 'blocker one' }));
    const b2 = await store.create(baseInput({ title: 'blocker two' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(b1), store.parseRef(b2)] }),
    );
    expect((await api.getBlockedBy(blocked)).sort()).toEqual([b1, b2].sort());
  });

  it('create resolves a slug-less codec ref through the issue\'s own team slug before mirroring', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const num = store.parseRef(blocker).issue;
    // a hand-written same-team shorthand `#num` (no slug) must still mirror to EX-num.
    const blocked = await store.create(baseInput({ title: 'blocked', blockedBy: [{ issue: num }] }));
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
  });

  it('create with blockedBy "none" mirrors nothing', async () => {
    const id = await store.create(baseInput({ blockedBy: 'none' }));
    expect(await api.getBlockedBy(id)).toEqual([]);
  });

  it('the body codec stays the CANONICAL home — the blockedBy wire form is written unchanged alongside the native mirror', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    const codec = parseBody((await api.getIssue(blocked)).description).blockedBy;
    expect(codec).not.toBe('none');
    expect((codec as { issue: number }[]).map((r) => r.issue)).toEqual([store.parseRef(blocker).issue]);
  });

  it('annotate mirrors a body-codec blockedBy ref not yet represented natively ("newly added" reconcile)', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failRelationWrites(new Error('relation write down')); // create-time mirror fails
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    expect(await api.getBlockedBy(blocked)).toEqual([]); // create mirror was skipped
    api.failRelationWrites(null);
    await store.annotate(blocked, { files: ['src/new.ts'] }); // any annotate reconciles the native side
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
  });

  it('annotate is strictly ADDITIVE — a pre-existing native relation is never deleted, and an already-native ref is not duplicated', async () => {
    const codecBlocker = await store.create(baseInput({ title: 'codec blocker' }));
    const humanBlocker = await store.create(baseInput({ title: 'human-drawn blocker' }));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(codecBlocker)] }));
    expect(await api.getBlockedBy(blocked)).toEqual([codecBlocker]); // create mirror
    // a human draws a native relation to a blocker that is NOT in the body codec:
    api.addNativeRelation(blocked, humanBlocker);

    await store.annotate(blocked, { risk: 'isolated-refactor' });

    const native = await api.getBlockedBy(blocked);
    // no-delete guarantee: BOTH survive; no-duplicate: the codec ref stays single.
    expect(native.filter((n) => n === codecBlocker)).toEqual([codecBlocker]);
    expect(native).toContain(humanBlocker);
    expect(native.sort()).toEqual([codecBlocker, humanBlocker].sort());
  });

  it('a REJECTED native relation write is non-fatal for create — the issue write survives, the codec ref stays authoritative', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failRelationWrites(new Error('issueRelationCreate rejected'));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    // create RESOLVED (never threw); read() still surfaces the codec ref.
    const view = await store.read(blocked);
    expect(view.blockedBy).not.toBe('none');
    expect(await api.getBlockedBy(blocked)).toEqual([]); // the mirror was skipped
  });

  it('a REJECTED native relation write is non-fatal for annotate — the annotate body write still lands', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failRelationWrites(new Error('relation write down'));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    await expect(store.annotate(blocked, { files: ['src/x.ts'] })).resolves.toBeUndefined();
    expect((await store.read(blocked)).files).toEqual(['src/x.ts']);
  });

  it('an UNRESOLVABLE blockedBy ref is skipped non-fatally; a resolvable sibling still mirrors', async () => {
    const realBlocker = await store.create(baseInput({ title: 'real blocker' }));
    const blocked = await store.create(
      baseInput({ blockedBy: [{ issue: 9999 }, store.parseRef(realBlocker)] }),
    );
    // only the resolvable ref mirrored; the phantom `#9999` was skipped, not thrown.
    expect(await api.getBlockedBy(blocked)).toEqual([realBlocker]);
    // and the body codec (authoritative) still carries BOTH refs untouched.
    const codec = parseBody((await api.getIssue(blocked)).description).blockedBy;
    expect((codec as { issue: number }[]).map((r) => r.issue).sort()).toEqual(
      [9999, store.parseRef(realBlocker).issue].sort(),
    );
  });
});

// ── Linear-only facet semantics (ADR-0020 / ADR-0015-as-amended / ADR-0017) ──
// The parts of the four shared facet suites (triage/document/needs-attention/
// closing) that can't see Linear's OWN extra behaviour, because the shared
// suites are deliberately store-blind: the cosmetic inbox clear (no other
// store has an inbox column to clear) and the categoryLabels inversion (no
// other store's triage vocab remaps onto a pre-existing label name).
describe('LinearIssuesStore — Linear-only facet semantics (ADR-0020/ADR-0015-amended/ADR-0017)', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  it("applyTriage from a 'Triage'-state issue moves it to 'Backlog' (inbox cosmetic)", async () => {
    const id = await store.create(baseInput());
    await api.setState(id, 'Triage');
    await store.applyTriage(id, { state: 'needs-info' });
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unclaimTarget); // 'Backlog'
    // and the LOAD-BEARING label vocab still applied — the state move is cosmetic ONLY.
    expect((await store.readTriage(id)).state).toBe('needs-info');
  });

  it("applyTriage on a 'Backlog' issue does NOT touch the state", async () => {
    const id = await store.create(baseInput()); // lands in 'Backlog' by default
    expect((await api.getIssue(id)).stateName).toBe('Backlog');
    await store.applyTriage(id, { state: 'needs-info' });
    expect((await api.getIssue(id)).stateName).toBe('Backlog');
  });

  it("applyTriage cosmetic move is best-effort — a state the catalog can't set is swallowed, not thrown", async () => {
    // an unclaimTarget that doesn't exist in the team's workflow → setState
    // throws inside the store; the cosmetic branch must swallow it (ADR-0004
    // class) rather than surface it, since the LOAD-BEARING label write above
    // it already succeeded.
    const misconfigured = new LinearIssuesStore({
      api,
      states: { unclaimTarget: 'No Such Column' },
    });
    const id = await misconfigured.create(baseInput());
    await api.setState(id, 'Triage');
    await expect(
      misconfigured.applyTriage(id, { state: 'needs-info' }),
    ).resolves.toBeUndefined();
    // the state is left untouched (the failed cosmetic move didn't apply)...
    expect((await api.getIssue(id)).stateName).toBe('Triage');
    // ...but the label vocab DID apply.
    expect((await misconfigured.readTriage(id)).state).toBe('needs-info');
  });

  it("applyTriage({category:'bug'}) with categoryLabels {bug:'Bug'} writes label 'Bug'; readTriage returns category 'bug'", async () => {
    const mappedApi = new InMemoryLinearApi();
    const mappedStore = new LinearIssuesStore({
      api: mappedApi,
      categoryLabels: { bug: 'Bug' },
    });
    const id = await mappedStore.create(baseInput());
    await mappedStore.applyTriage(id, { category: 'bug' });
    // the NATIVE label written is the mapped consumer label, not the schema name.
    expect((await mappedApi.getIssue(id)).labels).toContain('Bug');
    expect((await mappedApi.getIssue(id)).labels).not.toContain('bug');
    // and the inversion reads the native label back as the schema category.
    expect((await mappedStore.readTriage(id)).category).toBe('bug');
  });

  it("closeUnplanned sets state 'Canceled' → read().status === 'done', readTriage().state === schema.unplannedState", async () => {
    const id = await store.create(baseInput());
    await store.closeUnplanned(id, 'not in scope for this repo');
    expect((await api.getIssue(id)).stateName).toBe(DEFAULT_LINEAR_STATES.unplanned); // 'Canceled'
    expect((await store.read(id)).status).toBe('done');
    expect((await store.readTriage(id)).state).toBe(DEFAULT_TRIAGE_SCHEMA.unplannedState); // 'wontfix'
  });

  it('readClosing: Done + merged attachment → merged with url; Done + rejected-PR attachment → closed-unmerged; Todo → open', async () => {
    const merged = await store.create(baseInput());
    api.simulateMergedPrClose(merged, 'https://github.com/o/r/pull/42');
    expect((await api.getIssue(merged)).stateName).toBe('Done');
    expect(await store.readClosing(merged)).toEqual({
      state: 'merged',
      prUrl: 'https://github.com/o/r/pull/42',
    });

    const unmerged = await store.create(baseInput());
    api.simulateUnmergedClose(unmerged);
    expect((await api.getIssue(unmerged)).stateName).toBe('Done');
    expect(await store.readClosing(unmerged)).toEqual({ state: 'closed-unmerged' });

    const open = await store.create(baseInput());
    await store.transition(open, 'queued'); // → 'Todo'
    expect(await store.readClosing(open)).toEqual({ state: 'open' });
  });

  // ── W2-F1c: absence of evidence is NOT evidence of rejection ───────────────
  // The probe must not report "the PR was rejected" when what actually happened
  // is "no PR attachment was found". A row closed by hand, by a foreign-id
  // mention, or on a workspace whose GitHub integration never attached anything
  // has NO merge evidence either way — `closed-unknown`. wave-close routes that
  // to a report line, NOT to an automatic `recoverable-stop` flag.
  it('readClosing: Done with NO PR attachment at all → closed-unknown, not closed-unmerged (W2-F1c)', async () => {
    const id = await store.create(baseInput());
    api.simulateCloseWithoutPrEvidence(id);
    expect((await api.getIssue(id)).stateName).toBe('Done');
    expect(await store.readClosing(id)).toEqual({ state: 'closed-unknown' });
  });

  it('readClosing: a non-merged PR attachment IS positive rejection evidence → closed-unmerged (W2-F1c: the two are distinguished)', async () => {
    const id = await store.create(baseInput());
    api.simulateUnmergedClose(id, 'https://github.com/o/r/pull/77');
    expect(await store.readClosing(id)).toEqual({ state: 'closed-unmerged' });
  });
});

// ── opt-in done-state fallback (FOR-13) ─────────────────────────────────────
// At the live gate, merged rows sat in-review forever in a workspace with no
// Linear↔GitHub integration — the closing probe could never see the merge, and
// done stays deliberately DERIVED (ADR-0002/0020), so nothing moved them. This
// gives consumers without the integration an explicit, OPT-IN fallback: an
// optional `states.doneState` mapping. Unset (default) → close() is byte-for-
// byte unchanged (no-op-or-reconcile, AC#3). Set → close() may force the
// mapped transition once the wave itself already knows the PR merged (the very
// fact close() was called with a `prUrl` at all — the same established
// contract every store's close() relies on), but ONLY when the tracker's own
// probe hasn't already caught up (state not already terminal) — so a genuinely
// already-closed issue (merged via the real integration, or closed unmerged by
// some other means) is never clobbered by the fallback (AC#2/#3).
describe('LinearIssuesStore — opt-in done-state fallback (FOR-13)', () => {
  const PR = 'https://github.com/o/r/pull/13';

  it('WITHOUT states.doneState (default/recommended mode): close() is byte-for-byte unchanged — no state change, no comment (AC#3)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api }); // no doneState
    const id = await store.create(baseInput());
    await store.transition(id, 'in-review'); // → 'In Review'
    await store.close(id, PR, []);
    const issue = await api.getIssue(id);
    expect(issue.stateName).toBe(DEFAULT_LINEAR_STATES.inReview); // untouched
    expect(issue.stateType).toBe('started'); // still open — done stays derived
    expect(await api.getComments(id)).toEqual([]); // no advisory posted
    expect((await store.readClosing(id)).state).toBe('open');
    // and the existing no-op-or-reconcile record-keeping still happens:
    expect(parseBody(issue.description).closedBy).toBe(PR);
  });

  it('WITH states.doneState set: close() transitions to the mapped state + posts a LOUD advisory, when the probe cannot see a merged PR (AC#2)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(baseInput());
    await store.transition(id, 'in-review'); // → 'In Review', still open — no integration
    await store.close(id, PR, []);
    const issue = await api.getIssue(id);
    expect(issue.stateName).toBe('Done'); // the opt-in fallback forced the transition
    expect(issue.stateType).toBe('completed');
    const comments = await api.getComments(id);
    expect(comments).toHaveLength(1);
    // LOUD: names the fallback explicitly and states derived-done is preferred.
    expect(comments[0].body).toMatch(/opt-in/i);
    expect(comments[0].body).toMatch(/done-state fallback/i);
    expect(comments[0].body).toMatch(/derived.*(done|preferred)|preferred.*derived/i);
    expect(comments[0].body).toContain(PR);
  });

  it('WITH states.doneState set, but the tracker probe ALREADY sees a merged PR (integration present + working): close() does not override or double-comment (AC#2 — derived-done still wins)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(baseInput());
    api.simulateMergedPrClose(id, PR); // the REAL integration already did its job
    await store.close(id, PR, []);
    expect(await api.getComments(id)).toEqual([]); // no redundant fallback advisory
    expect((await store.readClosing(id)).state).toBe('merged'); // still the real signal
    expect((await store.readClosing(id)).prUrl).toBe(PR);
  });

  it('WITH states.doneState set, on an issue ALREADY closed unmerged by other means: close() does not stomp a genuine unmerged close with a false fallback "done" (AC#2 — "genuinely unmerged" is distinguished from "integration missing")', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(baseInput());
    api.simulateUnmergedClose(id); // already terminal, no merged attachment
    await store.close(id, PR, []);
    expect(await api.getComments(id)).toEqual([]); // the fallback stayed inert
    expect((await store.readClosing(id)).state).toBe('closed-unmerged'); // unchanged, honest
  });

  it('WITH states.doneState set: close() is idempotent — a second call does not post a second advisory (re-entrant wave-close, ADR-0018)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(baseInput());
    await store.close(id, PR, []); // first close applies the fallback
    await store.close(id, PR, []); // re-entrant re-close (already terminal now)
    expect(await api.getComments(id)).toHaveLength(1); // not doubled
  });
});
