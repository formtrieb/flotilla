import { describe, it, expect, beforeEach } from 'vitest';
import { LinearIssuesStore, DEFAULT_LINEAR_STATES, LinearTransitionVerifyError } from './linear-issues-store';
import { InMemoryLinearApi, linearConformanceHooks } from './linear-api-fake';
import type { LinearStateType } from './linear-api';
import { GoalMemberJoinError, GoalMemberKindError } from '../issue-store';
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

  // ── the BARE arm's share of this write half (ADR-0044) ────────────────────
  //
  // A bare create reaches the SAME mirror, so every property above holds for it
  // — with one consequence that does NOT carry over, measured here rather than
  // assumed: a bare issue has no body codec, so a refused `issueRelationCreate`
  // leaves NO record of the edge anywhere, and no later annotate can reconcile
  // it back (there is no codec ref to reconcile FROM).
  it('a REJECTED relation write on a BARE create is non-fatal — the issue is filed, and (no codec to fall back on) the edge is absent', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failRelationWrites(new Error('issueRelationCreate rejected'));

    const bare = await store.create({
      title: 'workstream B',
      filingHint: 'workstream-b',
      bodySections: [{ heading: 'Gap', markdown: 'not specifiable yet.' }],
      blockedBy: [store.parseRef(blocker)],
    });

    expect(bare.length).toBeGreaterThan(0);
    expect((await api.getIssue(bare)).description).toContain('## Gap');
    expect(await api.getBlockedBy(bare)).toEqual([]);
    expect((await api.getIssue(bare)).description).not.toMatch(/^##\s+Blocked by\s*$/im);

    api.failRelationWrites(null);
    await store.annotate(bare, { files: ['src/x.ts'] });
    expect(await api.getBlockedBy(bare)).toEqual([]);
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

  // ── FOR-77: annotate must not throw on a genuine decorate-target (a
  // pre-patch description with no parseable codec body yet — the exact case
  // decorate exists for). The mirror at the end of annotate must parse the
  // UPDATED (post-patch) description, and that parse must sit inside the same
  // best-effort boundary as the mirror call itself. ─────────────────────────
  it('annotate on a genuine decorate-target (no Files section pre-patch) exits 0 with labels + description writes applied', async () => {
    // a bare, not-yet-decorated issue: no `## Files` / `## Acceptance criteria`
    // section at all — parsing THIS pre-patch body throws (missing `## Files`).
    const { identifier: target } = await api.createIssue({
      title: 'not yet decorated',
      description: 'Some free-form prose with no managed sections yet.',
      labels: [],
    });

    await expect(
      store.annotate(target, {
        risk: 'isolated-refactor',
        worker: 'background',
        files: ['src/new.ts'],
        acceptanceCriteria: [{ text: 'does the thing', checked: false }],
      }),
    ).resolves.toBeUndefined(); // exit 0 — the old bug threw here (issue #FOR-77)

    const issue = await api.getIssue(target);
    expect(issue.labels).toEqual(
      expect.arrayContaining(['risk/isolated-refactor', 'worker/background']),
    );
    const parsed = parseBody(issue.description);
    expect(parsed.files).toEqual(['src/new.ts']);
    expect(parsed.acceptanceCriteria).toEqual([{ text: 'does the thing', checked: false }]);
  });

  it('the blockedBy mirror reconciles from the UPDATED (post-patch) description, not the stale pre-patch read', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blockerRef = store.parseRef(blocker);

    // a genuine decorate-target: the raw pre-patch description already carries
    // a `## Blocked by` ref (unaffected by annotate, which never rewrites that
    // section) but has NO `## Files` / `## Acceptance criteria` section — so
    // parsing the STALE pre-patch description throws, while parsing the
    // UPDATED post-patch description (Files + AC now present, Blocked by
    // carried through unchanged) succeeds and surfaces the ref to mirror.
    const { identifier: target } = await api.createIssue({
      title: 'decorate target with a pre-existing Blocked by ref',
      description: `## Blocked by\n\n${blockerRef.slug}#${blockerRef.issue}\n`,
      labels: [],
    });

    await expect(
      store.annotate(target, {
        files: ['src/new.ts'],
        acceptanceCriteria: [{ text: 'does the thing', checked: false }],
      }),
    ).resolves.toBeUndefined();

    // proof the mirror used the UPDATED description: the ref only becomes
    // parseable once Files/AC are present, and it WAS mirrored.
    expect(await api.getBlockedBy(target)).toEqual([blocker]);
  });

  it('a body that STILL fails to parse after the patch degrades to a skipped mirror — never a thrown/rejected annotate', async () => {
    // only `files` is patched, never `acceptanceCriteria` — so even the
    // UPDATED description is still missing the required `## Acceptance
    // criteria` section and parseBody keeps throwing. annotate must still
    // resolve (best-effort boundary swallows the parse failure too).
    const { identifier: target } = await api.createIssue({
      title: 'still unparseable after the patch',
      description: 'no managed sections at all',
      labels: [],
    });

    await expect(store.annotate(target, { files: ['src/x.ts'] })).resolves.toBeUndefined();
    const issue = await api.getIssue(target);
    expect(issue.description).toContain('## Files');
    expect(await api.getBlockedBy(target)).toEqual([]); // mirror skipped, not attempted
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

  // ── Document facet through the STORE, both binding directions (ADR-0017
  // amendment). The shared conformance suite already drives publish→read→list
  // round-trips, but it is deliberately store-blind: it cannot see that the
  // listing is SCOPED, because it only ever publishes into the one scope it
  // then lists. These two cases put an out-of-scope document in the substrate
  // so the DocumentView projection is asserted over a filter that actually
  // removes something.
  it("publishDocument on a project-UNBOUND store lands in the team scope, and listDocuments returns only that team's PRDs", async () => {
    const id = await store.publishDocument({
      title: 'PRD: the team-pool consumer',
      filingHint: 'prd-team-pool',
      bodySections: [{ heading: 'Problem Statement', markdown: 'the brief' }],
    });
    // a document belonging to a DIFFERENT team of the same workspace...
    api.seedDocument({ title: 'PRD: someone else entirely', content: '# theirs\n', team: 'OTHER' });

    // ...never reaches this consumer's PRD panel.
    const listed = await store.listDocuments();
    expect(listed.map((d) => d.id)).toEqual([id]);
    expect(listed[0].title).toBe('PRD: the team-pool consumer');
    expect(listed[0].body).toContain('## Problem Statement');
    // and the round-trip by id is unaffected by the scoping.
    expect((await store.readDocument(id)).title).toBe('PRD: the team-pool consumer');
  });

  it('publishDocument on a project-BOUND store is unchanged — project-scoped, and a same-team document stays out of the panel', async () => {
    const boundApi = new InMemoryLinearApi('EX', 'Example Project');
    const boundStore = new LinearIssuesStore({ api: boundApi });
    const id = await boundStore.publishDocument({
      title: 'PRD: the project-bound consumer',
      filingHint: 'prd-project-bound',
      bodySections: [{ heading: 'Problem Statement', markdown: 'the brief' }],
    });
    boundApi.seedDocument({ title: 'PRD: team-attached', content: '# team\n', team: 'EX' });

    expect((await boundStore.listDocuments()).map((d) => d.id)).toEqual([id]);
    expect((await boundStore.readDocument(id)).title).toBe('PRD: the project-bound consumer');
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

// ── native attachment upsert (issue #511 — mechanics proven consumer-side) ──
// close() additionally upserts a native Linear attachment card for the
// closing PR (next to the body-codec `Closed-by:` line), so the dedicated
// attachment section carries a visible ticket→PR link for the whole
// in-review window too — independent of the GitHub-integration-only evidence
// readClosing/getPrAttachments read (see LinearApi.getPrAttachments's doc for
// why the two substrates never merge).
describe('LinearIssuesStore — close() upserts the closing PR as a native attachment (issue #511)', () => {
  const PR = 'https://github.com/o/r/pull/511';

  it('close() upserts exactly one attachment card for the closing PR URL, subtitle "merged" (AC#1)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(baseInput());
    await store.close(id, PR, []);
    const cards = api.listUpsertedAttachments(id);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ url: PR, subtitle: 'merged' });
    expect(cards[0].title).toBeTruthy(); // AttachmentCreateInput.title is required (String!)
  });

  it('a repeated close() with the same issue+URL leaves exactly one attachment card — idempotent via Linear\'s own URL upsert (AC#1)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(baseInput());
    await store.close(id, PR, []);
    await store.close(id, PR, []); // re-entrant re-close (wave-close, ADR-0018)
    expect(api.listUpsertedAttachments(id)).toHaveLength(1);
  });

  it('the upserted card title carries a recognizable PR number for a GitHub-shaped closing PR URL', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(baseInput());
    await store.close(id, 'https://github.com/o/r/pull/130', []);
    expect(api.listUpsertedAttachments(id)[0].title).toBe('PR #130');
  });

  it('falls back to a generic title for a closing PR URL shape it cannot parse a number from', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(baseInput());
    await store.close(id, 'https://example.com/not-a-pr-url', []);
    expect(api.listUpsertedAttachments(id)[0].title).toBe('Closing PR');
  });

  it('readClosing/getPrAttachments evidence base is UNTOUCHED by the upserted card — the closing probe still reports no PR evidence (AC#4 disclosure)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api }); // no doneState — state is left alone
    const id = await store.create(baseInput());
    await store.transition(id, 'in-review');
    await store.close(id, PR, []);
    // the upsert landed...
    expect(api.listUpsertedAttachments(id)).toHaveLength(1);
    // ...into a DIFFERENT substrate from what the closing probe reads:
    expect(await api.getPrAttachments(id)).toEqual([]);
    expect((await store.readClosing(id)).state).toBe('open'); // untouched — still derived
  });

  it('a genuinely merged PR (GitHub-integration attachment) is still read correctly alongside the separately-upserted card', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(baseInput());
    api.simulateMergedPrClose(id, PR); // the REAL integration attachment
    await store.close(id, PR, []); // our upsert lands too, into the OTHER substrate
    expect(api.listUpsertedAttachments(id)).toHaveLength(1); // our card
    expect(await api.getPrAttachments(id)).toEqual([{ url: PR, merged: true }]); // probe evidence, untouched
    const closing = await store.readClosing(id);
    expect(closing.state).toBe('merged');
    expect(closing.prUrl).toBe(PR);
  });
});

// ── the Goal facet's Linear mapping (ADR-0044) ──────────────────────────────
//
// The tracker-agnostic contract cases live in `adapters/goal-facet.spec.ts`.
// This block pins what that suite cannot see: that a Goal is a PROJECT here,
// that the binding is mandatory on this store and on no other, and that the
// frontier reads a member's blockers through the ADR-0020 read-union.
describe('LinearIssuesStore — the Goal is a project (ADR-0044)', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  it('createGoal mints a real project; the id is the opaque project id', async () => {
    const id = await store.createGoal(
      { title: '1.0.0', filingHint: 'ignored-entirely', description: 'the freeze' },
      'project',
    );
    const project = await api.getProject(id);
    expect(project.name).toBe('1.0.0');
    expect(project.description).toBe('the freeze');
    // NOT a `<TEAM>-<n>` identifier: a project has no human identifier, so its
    // UUID is the opaque goal id (ADR-0001).
    expect(id).not.toMatch(/^EX-\d+$/);
  });

  it('assignToGoal writes the NATIVE project membership, not a description line', async () => {
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' }, 'project');
    const issue = await store.create(baseInput());
    const before = (await api.getIssue(issue)).description;

    await store.assignToGoal(goal, issue, 'project');

    expect((await api.listProjectIssues(goal)).map((i) => i.identifier)).toEqual([issue]);
    expect((await api.getIssue(issue)).description).toBe(before);
  });

  it('EVERY goal verb refuses without a binding — Linear has no default, by decision', async () => {
    // The asymmetry ADR-0044 decision 4 exists for: one shipped consumer runs
    // Initiative=Epic / Project=User Story while ADR-0017 once sketched
    // "Wave ≈ Linear Project". Both are live, so any built-in pick would
    // overwrite somebody's meaning.
    await expect(store.createGoal({ title: 'g', filingHint: 'g' })).rejects.toMatchObject({
      name: 'GoalBindingError',
      failure: 'unbound',
      field: 'store.goal.container',
    });
    await expect(store.listGoals()).rejects.toMatchObject({ failure: 'unbound' });
    await expect(store.readGoal('x')).rejects.toMatchObject({ failure: 'unbound' });
    await expect(store.assignToGoal('x', 'y')).rejects.toMatchObject({ failure: 'unbound' });
    await expect(store.readGoalFrontier('x')).rejects.toMatchObject({ failure: 'unbound' });
  });

  it('`initiative` is REALIZED here now (ADR-0045) — and it mints an initiative, not a project', async () => {
    // The ADR-0044 deferral is gone: what used to be an `unrealized-container`
    // refusal on this store is a real container. The assertion is deliberately
    // about the SUBSTRATE and not just the absence of a throw — a realization
    // that quietly minted a project under an initiative binding would satisfy
    // "does not refuse" and be exactly wrong.
    const goal = await store.createGoal({ title: 'Epic', filingHint: 'epic' }, 'initiative');
    expect((await api.listInitiatives()).map((i) => i.id)).toEqual([goal]);
    expect(await api.listProjects()).toEqual([]);
    expect((await store.readGoal(goal, 'initiative')).container).toBe('initiative');
  });

  it('the frontier reads blockers through the read-union — a NATIVE relation alone blocks', async () => {
    // The bare-arm case: the dependency exists only as a native relation, with
    // no `## Blocked by` section anywhere, so a codec-only frontier would report
    // the member `unready` and lose the edge entirely.
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' }, 'project');
    const blocker = await store.create({
      title: 'workstream A',
      filingHint: 'a',
      bodySections: [{ heading: 'Gap', markdown: 'A must exist first.' }],
    });
    const blocked = await store.create({
      title: 'workstream B',
      filingHint: 'b',
      bodySections: [{ heading: 'Gap', markdown: 'B waits on A.' }],
      blockedBy: [store.parseRef(blocker)],
    });
    await store.assignToGoal(goal, blocked, 'project');

    expect((await api.getIssue(blocked)).description).not.toMatch(/^##\s+Blocked by\s*$/im);
    const reading = (await store.readGoalFrontier(goal, 'project')).readings[0];
    expect(reading.state).toBe('blocked');
    expect(reading.unresolvedBlockers).toEqual([store.parseRef(blocker)]);
  });

  it('a blocker this workspace cannot resolve stays UNRESOLVED, never silently cleared', async () => {
    // Unlike GitHub there is no up-front cross-team refusal (a Linear identifier
    // carries its own team slug), so the reach question is settled by the READ —
    // and a read that cannot resolve the blocker is no evidence of clearance.
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' }, 'project');
    const member = await store.create(
      baseInput({ title: 'waits on another team', blockedBy: [{ slug: 'OTHER', issue: 7 }] }),
    );
    await store.assignToGoal(goal, member, 'project');
    const reading = (await store.readGoalFrontier(goal, 'project')).readings[0];
    expect(reading.state).toBe('blocked');
    expect(reading.unresolvedBlockers).toEqual([{ slug: 'OTHER', issue: 7 }]);
  });

  it('a member parked in the unclaim target reads `actionable`, not `in-motion`', async () => {
    // The Linear-specific half of the claim reading: the ledger is the workflow
    // STATE here, so "claimed" means one of the three MAPPED rung states — the
    // backlog/unclaim target is not one of them.
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' }, 'project');
    const issue = await store.create(baseInput());
    await store.assignToGoal(goal, issue, 'project');
    await store.transition(issue, 'in-flight');
    expect((await store.readGoalFrontier(goal, 'project')).readings[0].state).toBe('in-motion');

    await store.unclaim(issue);
    expect((await store.readGoalFrontier(goal, 'project')).readings[0].state).toBe('actionable');
  });
});

// ── the INITIATIVE realization (ADR-0045) ───────────────────────────────────
//
// Everything below is what the tracker-agnostic suite structurally cannot see:
// that membership is DIRECT projects, that `listGoals` widens to the workspace,
// and — the largest block — that each of ADR-0045 decision 2's fact mappings
// lands on the reading it claims. Each mapping gets its own case, with the
// SIBLING readings asserted alongside wherever a mis-mapping would otherwise hide
// (a rule that returned `unready` for everything would satisfy half of them).
describe('LinearIssuesStore — the Goal is an INITIATIVE whose members are projects (ADR-0045)', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  /** Mint an initiative-bound goal. */
  async function makeGoal(title = 'Unternehmen verwalten'): Promise<string> {
    return store.createGoal({ title, filingHint: 'uv' }, 'initiative');
  }

  /** Mint a member project on the goal and return its id. */
  async function member(goal: string, title: string): Promise<string> {
    return store.createGoalMember(
      goal,
      {
        title,
        filingHint: title.replace(/\W+/g, '-'),
        bodySections: [{ heading: 'Gap', markdown: 'the story exists; its shape does not yet.' }],
      },
      'initiative',
    );
  }

  /** The single reading for `memberId` in the goal's frontier. */
  async function reading(goal: string, memberId: string) {
    const frontier = await store.readGoalFrontier(goal, 'initiative');
    const found = frontier.readings.find((r) => r.id === memberId);
    if (!found) throw new Error(`no reading for ${memberId}`);
    return found;
  }

  // ── membership: DIRECT projects, never a flattening query ────────────────
  it('readGoal returns the DIRECT member PROJECT ids — never the issues inside them', async () => {
    const goal = await makeGoal();
    const story = await member(goal, 'Firmenadmin');
    // An issue living INSIDE the member project. A transitive read would report
    // this identifier as a goal member; a direct read must not.
    const inside = await store.create(baseInput({ title: 'an execution ticket' }));
    await api.setIssueProject(inside, story);

    const view = await store.readGoal(goal, 'initiative');
    expect(view.container).toBe('initiative');
    expect(view.memberIds).toEqual([story]);
    expect(view.memberIds).not.toContain(inside);
  });

  it('an EMPTY member project is a MEMBER — the falsification ADR-0045 rests on', async () => {
    // 13 of 19 initiative-member projects at the live consumer are empty. A
    // flattening frontier would report this goal COMPLETE, over a story nobody
    // has built. Both halves are asserted: the member is listed, and the goal is
    // not complete.
    const goal = await makeGoal();
    const empty = await member(goal, 'Firmenadmin');
    expect(await api.listProjectIssues(empty)).toEqual([]);

    const frontier = await store.readGoalFrontier(goal, 'initiative');
    expect(frontier.readings.map((r) => r.id)).toEqual([empty]);
    expect(frontier.complete).toBe(false);
  });

  it('an initiative with ONE closed issue in ONE of six empty stories is NOT complete', async () => {
    // The live shape, reproduced end to end: the transitive read would see a
    // single closed issue and report the whole epic finished.
    const goal = await makeGoal();
    const built = await member(goal, 'the built story');
    const done = await store.create(baseInput({ title: 'the one ticket' }));
    await api.setIssueProject(done, built);
    api.simulateMergedPrClose(done, 'https://github.com/o/r/pull/1');
    for (const n of [1, 2, 3, 4, 5, 6]) await member(goal, `unbuilt story ${n}`);

    const frontier = await store.readGoalFrontier(goal, 'initiative');
    expect(frontier.readings).toHaveLength(7);
    expect(frontier.complete).toBe(false);
    expect(frontier.counts.unready).toBe(7); // the built story's project is still open
  });

  it('listGoals is WORKSPACE-wide under initiative — the documented divergence from the project scope', async () => {
    // `listProjects` is team-scoped by construction (a project is minted under
    // this api's team); initiatives have no team at all, so hiding one behind a
    // team filter would hide a cross-team finish line. Driven through the fake's
    // own substrate so the claim is about SCOPE and not about what happens to
    // have been created here.
    const a = await makeGoal('Design epic');
    const b = await store.createGoal({ title: 'Dev epic', filingHint: 'dev' }, 'initiative');
    const otherTeamStore = new LinearIssuesStore({ api: new InMemoryLinearApi('OTHER') });

    const goals = await store.listGoals('initiative');
    expect(goals.map((g) => g.id).sort()).toEqual([a, b].sort());
    for (const g of goals) expect(g.container).toBe('initiative');
    // …and a store bound to a DIFFERENT team, on its own substrate, sees none of
    // them — proving the width above is the initiative connection's and not an
    // artefact of one shared map.
    expect(await otherTeamStore.listGoals('initiative')).toEqual([]);
  });

  // ── ADR-0045 decision 2: every fact mapping, one case each ───────────────
  it('EMPTY project → `unready` (it carries no drawable work at all)', async () => {
    const goal = await makeGoal();
    const empty = await member(goal, 'empty');
    expect((await reading(goal, empty)).state).toBe('unready');
  });

  it('project whose open issues ALL lack the eligibility marker → `unready`', async () => {
    // Sharpen first, then drawable. The project is populated and open, so only
    // the eligibility fact separates this from `actionable`.
    const goal = await makeGoal();
    const story = await member(goal, 'all untriaged');
    for (const t of ['bare one', 'bare two']) {
      const bare = await store.create({
        title: t,
        filingHint: t.replace(/\W+/g, '-'),
        bodySections: [{ heading: 'Gap', markdown: 'unsharpened.' }],
      });
      await api.setIssueProject(bare, story);
    }
    expect((await reading(goal, story)).state).toBe('unready');
  });

  it('≥1 eligible open issue, unclaimed, no relation → `actionable`', async () => {
    // The positive control for the two `unready` cases above: the ONLY change is
    // that one issue inside carries the marker.
    const goal = await makeGoal();
    const story = await member(goal, 'drawable');
    const ready = await store.create(baseInput({ title: 'a sharpened slice' }));
    await api.setIssueProject(ready, story);
    expect((await reading(goal, story)).state).toBe('actionable');
  });

  it('project status `started` → `in-motion`', async () => {
    const goal = await makeGoal();
    const story = await member(goal, 'moving');
    api.setProjectStatus(story, 'started');
    expect((await reading(goal, story)).state).toBe('in-motion');
  });

  it('project status `paused` → `in-motion`, NOT `blocked`', async () => {
    // `blocked` asserts a NAMED unresolved dependency, which paused lacks — so
    // reporting it as blocked would be a claim the store cannot back. The
    // reading carries no blockers, which is the assertion that says so.
    const goal = await makeGoal();
    const story = await member(goal, 'paused');
    api.setProjectStatus(story, 'paused');
    const r = await reading(goal, story);
    expect(r.state).toBe('in-motion');
    expect(r.unresolvedBlockers).toEqual([]);
  });

  it('≥1 WAVE-CLAIMED open issue inside → `in-motion`, even while the project sits in backlog', async () => {
    // The second claimed source, and the one a status-only rule would miss: the
    // project was never moved, but a wave has a row out of it.
    const goal = await makeGoal();
    const story = await member(goal, 'a wave is inside');
    const claimed = await store.create(baseInput({ title: 'drawn' }));
    await api.setIssueProject(claimed, story);
    expect((await reading(goal, story)).state).toBe('actionable'); // control: before the claim

    await store.transition(claimed, 'in-flight');
    expect((await api.getProject(story)).statusType).toBe('backlog'); // the project never moved
    expect((await reading(goal, story)).state).toBe('in-motion');
  });

  it('a needs-attention issue inside is a claim too — never back in the pool', async () => {
    const goal = await makeGoal();
    const story = await member(goal, 'flagged inside');
    const flagged = await store.create(baseInput({ title: 'stuck' }));
    await api.setIssueProject(flagged, story);
    await store.transition(flagged, 'in-flight');
    await store.flag(flagged, {
      kind: 'recoverable-stop',
      question: 'which branch?',
      options: ['main'],
    });
    expect((await reading(goal, story)).state).toBe('in-motion');
  });

  it('project status `completed` → `done`, and `canceled` → `done`', async () => {
    for (const status of ['completed', 'canceled'] as const) {
      const goal = await makeGoal(`goal ${status}`);
      const story = await member(goal, `finished ${status}`);
      api.setProjectStatus(story, status);
      const frontier = await store.readGoalFrontier(goal, 'initiative');
      expect(frontier.readings[0].state, status).toBe('done');
      // a closed member stays a MEMBER — dropping it would make a finished goal
      // indistinguishable from an empty one.
      expect(frontier.readings, status).toHaveLength(1);
      expect(frontier.open, status).toEqual([]);
      expect(frontier.complete, status).toBe(true);
    }
  });

  it('a closed member is `done` whatever is inside it — no issue or relation read at all', async () => {
    // The ladder's first rung, at project granularity: an eligible issue inside a
    // completed project must not drag it back to `actionable`.
    const goal = await makeGoal();
    const story = await member(goal, 'finished with leftovers');
    const leftover = await store.create(baseInput({ title: 'never landed' }));
    await api.setIssueProject(leftover, story);
    api.setProjectStatus(story, 'completed');
    expect((await reading(goal, story)).state).toBe('done');
  });

  it('an unresolved native project relation → `blocked`, NAMING the blocking member', async () => {
    const goal = await makeGoal();
    const blocker = await member(goal, 'workstream A');
    const blocked = await store.createGoalMember(
      goal,
      {
        title: 'workstream B',
        filingHint: 'b',
        bodySections: [{ heading: 'Gap', markdown: 'B waits on A.' }],
        blockedBy: [blocker],
      },
      'initiative',
    );
    // The edge is NATIVE — Linear's own project dependency, which is what makes
    // it visible on the timeline view that motivated this realization.
    expect(await api.getProjectBlockedBy(blocked)).toEqual([blocker]);

    const r = await reading(goal, blocked);
    expect(r.state).toBe('blocked');
    expect(r.unresolvedBlockers).toEqual([blocker]);
  });

  it('…and it clears to the eligibility question once the blocker actually closes', async () => {
    // The blocked reading must rest on the blocker's LIVE status, not on the
    // mere existence of an edge — otherwise a goal would never progress past its
    // first dependency.
    const goal = await makeGoal();
    const blocker = await member(goal, 'workstream A');
    const blocked = await store.createGoalMember(
      goal,
      {
        title: 'workstream B',
        filingHint: 'b',
        bodySections: [{ heading: 'Gap', markdown: 'B waits on A.' }],
        blockedBy: [blocker],
      },
      'initiative',
    );
    expect((await reading(goal, blocked)).state).toBe('blocked');

    api.setProjectStatus(blocker, 'completed');

    const r = await reading(goal, blocked);
    expect(r.state).toBe('unready'); // empty, so not yet drawable — but no longer blocked
    expect(r.unresolvedBlockers).toEqual([]);
  });

  it('`blocked` outranks the eligibility question — a drawable-looking member still waits', async () => {
    // Rung order at project granularity: without this the blocked member would
    // read `actionable` and invite a wave straight into a dependency.
    const goal = await makeGoal();
    const blocker = await member(goal, 'workstream A');
    const blocked = await store.createGoalMember(
      goal,
      {
        title: 'workstream B',
        filingHint: 'b',
        bodySections: [{ heading: 'Gap', markdown: 'B waits on A.' }],
        blockedBy: [blocker],
      },
      'initiative',
    );
    const ready = await store.create(baseInput({ title: 'sharpened, but waiting' }));
    await api.setIssueProject(ready, blocked);

    expect((await reading(goal, blocked)).state).toBe('blocked');
  });

  it('a blocker this store cannot READ stays unresolved — no-evidence never counterfeits `actionable`', async () => {
    // The `closed-unknown` discipline at project granularity: an edge the store
    // cannot resolve is not evidence the edge is clear.
    const goal = await makeGoal();
    const story = await member(goal, 'waits on a ghost');
    const ghost = await store.createGoalMember(
      goal,
      { title: 'ghost', filingHint: 'ghost', bodySections: [{ heading: 'Gap', markdown: 'g' }] },
      'initiative',
    );
    await api.addProjectBlockedBy(story, ghost);
    // Make the blocker unreadable the only way the fake can: hand the frontier a
    // relation whose other side is not in the project map.
    api.forgetProject(ghost);

    const r = await reading(goal, story);
    expect(r.state).toBe('blocked');
    expect(r.unresolvedBlockers).toEqual([ghost]);
  });

  // ── createGoalMember: one act, pre-validated, residue reported ───────────
  it('createGoalMember mints a PROJECT under the api team and joins it natively', async () => {
    const goal = await makeGoal();
    const id = await member(goal, 'Firmenadmin');
    // A project, not an issue — the member kind follows the binding.
    expect((await api.listProjects()).map((p) => p.id)).toEqual([id]);
    expect(await api.listOpenIssues()).toEqual([]);
    // …and the join is the native initiative membership.
    expect((await api.listInitiativeProjects(goal)).map((p) => p.id)).toEqual([id]);
  });

  it('an UNKNOWN blocker refuses BEFORE the mint — no orphan project is left behind', async () => {
    const goal = await makeGoal();
    await expect(
      store.createGoalMember(
        goal,
        {
          title: 'B',
          filingHint: 'b',
          bodySections: [{ heading: 'Gap', markdown: 'b' }],
          blockedBy: ['prj-does-not-exist'],
        },
        'initiative',
      ),
    ).rejects.toThrow(/not found/i);
    expect(await api.listProjects()).toEqual([]);
  });

  it('a post-mint EDGE failure is a typed error NAMING the minted member — never a silent rollback', async () => {
    // The honest failure mode of a two-write act. Rolling the mint back would be
    // a deletion this facet has no verb for; swallowing it would drop the edge
    // that is the whole feature. So the residue is reported, by id.
    const goal = await makeGoal();
    const blocker = await member(goal, 'workstream A');
    api.failProjectRelationWrites(new Error('projectRelationCreate rejected'));

    let thrown: unknown;
    try {
      await store.createGoalMember(
        goal,
        {
          title: 'workstream B',
          filingHint: 'b',
          bodySections: [{ heading: 'Gap', markdown: 'b' }],
          blockedBy: [blocker],
        },
        'initiative',
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GoalMemberJoinError);
    const err = thrown as GoalMemberJoinError;
    expect(err.stage).toBe('blocked-by');
    expect(err.goalId).toBe(goal);
    expect(err.message).toContain(err.memberId);
    // …and the residue is REAL: the minted project exists and is in the goal.
    expect((await api.listInitiativeProjects(goal)).map((p) => p.id)).toContain(err.memberId);
  });

  it('assignToGoal refuses an ISSUE-shaped id under this binding, before any write', async () => {
    const goal = await makeGoal();
    const issue = await store.create(baseInput());
    await expect(store.assignToGoal(goal, issue, 'initiative')).rejects.toBeInstanceOf(
      GoalMemberKindError,
    );
    expect(await api.listInitiativeProjects(goal)).toEqual([]);
  });

  it('…and a real PROJECT id joins fine — the refusal is about the id KIND, not about strictness', async () => {
    // The positive control. Without it the clause above is equally satisfied by
    // an `assignToGoal` that refuses everything.
    const goal = await makeGoal();
    const { id } = await api.createProject({ name: 'a loose story', description: '' });
    await store.assignToGoal(goal, id, 'initiative');
    expect((await store.readGoal(goal, 'initiative')).memberIds).toEqual([id]);
  });

  it('a project id whose last group is ALL DIGITS is NOT mistaken for an issue id', async () => {
    // The live UUID hazard the shape predicate was tightened for: a greedy
    // `<anything>-<digits>` rule reads `550e8400-e29b-41d4-a716-446655440000` as
    // an issue identifier and refuses a perfectly valid join — at random,
    // depending on the last twelve characters a server handed out.
    const goal = await makeGoal();
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    api.seedProject({ id: uuid, name: 'a UUID-shaped project' });
    await store.assignToGoal(goal, uuid, 'initiative');
    expect((await store.readGoal(goal, 'initiative')).memberIds).toEqual([uuid]);
  });
});
