import { describe, it, expect, beforeEach } from 'vitest';
import { GitHubIssuesStore } from './github-issues-store';
import { InMemoryGitHubApi, githubConformanceHooks } from './github-api-fake';
import type { CreateInput, AnnotatePatch } from '../issue-store';
import { parseBody } from '../body-codec';
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

// ── the SAME shared contract MarkdownFsStore passes, zero suite changes ──────
runIssueStoreConformance('GitHubIssuesStore', (): ConformanceHarness => ({
  async makeStore() {
    return new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
  },
  hooks: githubConformanceHooks,
  baseInput,
}));

// ── GitHub-specific properties (storage-aware: labels, body, derived status) ──
describe('GitHubIssuesStore — GitHub-specific mapping', () => {
  let api: InMemoryGitHubApi;
  let store: GitHubIssuesStore;
  beforeEach(() => {
    api = new InMemoryGitHubApi();
    store = new GitHubIssuesStore({ api });
  });

  it('id is the opaque issue number string (filingHint ignored — ADR-0001)', async () => {
    const id = await store.create(baseInput({ filingHint: 'whatever' }));
    expect(id).toBe('1');
  });

  it('create() writes risk/worker as labels + an eligibility label, status NOT a label', async () => {
    const id = await store.create(baseInput({ risk: 'public-API-change', worker: 'foreground' }));
    const gh = await api.getIssue(Number(id));
    expect(gh.labels).toContain('ready-for-agent');
    expect(gh.labels).toContain('risk/public-API-change');
    expect(gh.labels).toContain('worker/foreground');
    // no available/done label is ever written
    expect(gh.labels.some((l) => l === 'wave/available' || l === 'wave/done')).toBe(false);
  });

  it('files / blockedBy / AC live in the body and round-trip', async () => {
    const id = await store.create(
      baseInput({
        files: ['a/b.ts', 'c/d.ts'],
        blockedBy: [{ issue: 13 }, { slug: 'other', issue: 5 }],
        acceptanceCriteria: [
          { text: 'one', checked: false },
          { text: 'two', checked: false },
        ],
      }),
    );
    const view = await store.read(id);
    expect(view.files).toEqual(['a/b.ts', 'c/d.ts']);
    expect(view.blockedBy).toEqual([{ issue: 13 }, { slug: 'other', issue: 5 }]);
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['one', 'two']);
  });

  it('bodySections (Parent / What to build) are written verbatim into the body', async () => {
    const id = await store.create(
      baseInput({
        bodySections: [
          { heading: 'Parent', markdown: 'PRD 1 (#1)' },
          { heading: 'What to build', markdown: 'The thing that does the stuff.' },
        ],
      }),
    );
    const gh = await api.getIssue(Number(id));
    expect(gh.body).toMatch(/^## Parent$/m);
    expect(gh.body).toContain('PRD 1 (#1)');
    expect(gh.body).toMatch(/^## What to build$/m);
  });

  it('transition() maps to a single mutually-exclusive wave/* label', async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'queued');
    await store.transition(id, 'in-flight');
    const gh = await api.getIssue(Number(id));
    expect(gh.labels).toContain('wave/in-flight');
    expect(gh.labels).not.toContain('wave/queued');
    expect((await store.read(id)).status).toBe('in-flight');
  });

  it('status is DERIVED: closed issue → done even with no wave label', async () => {
    const id = await store.create(baseInput());
    await api.nativeClose(Number(id)); // as a merged PR's Closes #N would
    expect((await store.read(id)).status).toBe('done');
  });

  it('status is a LOSSY projection: a not_planned (wontfix) close still derives done (ADR-0002, decided 2026-06-06)', async () => {
    // The coarse vocab has no "cancelled" rung and no consumer branches on the
    // close reason, so a not_planned close deliberately collapses to done. This
    // pins that decision so a future "honour stateReason" change is a conscious
    // one, and closes the gap that the fake's always-'completed' close masked.
    const id = await store.create(baseInput());
    await api.nativeClose(Number(id), 'not_planned');
    expect((await store.read(id)).status).toBe('done');
  });

  it('read() status precedence picks the highest rung if two wave labels coexist (partial transition)', async () => {
    const id = await store.create(baseInput());
    // simulate a crashed transition that left both labels
    await api.addLabel(Number(id), 'wave/queued');
    await api.addLabel(Number(id), 'wave/in-review');
    expect((await store.read(id)).status).toBe('in-review'); // precedence wins
  });

  it('close() is no-op-or-reconcile: keeps the in-review claim → no reappearance in listOpen mid-merge', async () => {
    const id = await store.create(baseInput());
    await store.transition(id, 'in-review');
    await store.close(id, 'https://example/pr/1', [0]);

    // issue is still natively OPEN (close did not flip it) ...
    const gh = await api.getIssue(Number(id));
    expect(gh.state).toBe('open');
    // ... still carries the claim, so it does NOT reappear as available
    expect(gh.labels).toContain('wave/in-review');
    const open = await store.listOpen('wave-ready');
    expect(open.map((v) => v.id)).not.toContain(id);
    // closedBy recorded + AC ticked cosmetically
    const view = await store.read(id);
    expect(view.closedBy).toBe('https://example/pr/1');
    expect(view.acceptanceCriteria[0].checked).toBe(true);
    expect(view.status).toBe('in-review'); // not done until the native close lands
  });

  it('read() throws on a missing risk/worker label (malformed, no partial view)', async () => {
    const { number } = await api.createIssue({
      title: 'hand-made',
      body: '## Files\n- x.ts\n\n## Blocked by\nnone\n\n## Acceptance criteria\n- [ ] a\n',
      labels: ['ready-for-agent'], // no risk/* or worker/*
    });
    await expect(store.read(String(number))).rejects.toThrow(/risk/);
  });

  it('listOpen() skips a human-garbled body instead of aborting the scan', async () => {
    const good = await store.create(baseInput());
    // a hand-created eligible issue with a broken body (no ## Files)
    await api.createIssue({
      title: 'garbled',
      body: 'someone deleted the sections',
      labels: ['ready-for-agent', 'risk/mechanical', 'worker/background'],
    });
    const open = await store.listOpen('wave-ready');
    expect(open.map((v) => v.id)).toEqual([good]); // garbled one skipped, scan survived
  });

  // ── regression: review-confirmed defects (P3 impl review, 2026-06-06) ──────
  it('create() rejects a bodySections heading that collides with a managed section', async () => {
    await expect(
      store.create(baseInput({ bodySections: [{ heading: 'Files', markdown: 'oops' }] })),
    ).rejects.toThrow(/managed section/);
    // case/whitespace-insensitive
    await expect(
      store.create(baseInput({ bodySections: [{ heading: ' Acceptance Criteria ', markdown: 'x' }] })),
    ).rejects.toThrow(/managed section/);
  });

  it('read() throws on ambiguous duplicate risk/* labels (not silent first-wins)', async () => {
    const id = await store.create(baseInput());
    await api.addLabel(Number(id), 'risk/public-API-change'); // now two risk/* labels
    await expect(store.read(id)).rejects.toThrow(/ambiguous/);
  });

  it('parseRef() inverts a bare-number id into a slug-less {issue} (ADR-0001/0013)', () => {
    expect(store.parseRef('412')).toEqual({ issue: 412 });
  });

  it('parseRef() throws on a non-integer id', () => {
    expect(() => store.parseRef('not-a-number')).toThrow();
  });
});

// ── blockedBy read-union (ADR-0020's DoR-gate fix, ported to GitHub's native
// issue-dependencies API): the body-codec can't see a native blocked-by
// dependency a consumer already maintains — read() must union both sides,
// deduped by normalized ref identity, or the DoR gate dispatches a row whose
// real blocker is still open. ───────────────────────────────────────────────
describe('GitHubIssuesStore — blockedBy read-union (ADR-0020 DoR-gate fix)', () => {
  let api: InMemoryGitHubApi;
  let store: GitHubIssuesStore;
  beforeEach(() => {
    api = new InMemoryGitHubApi();
    store = new GitHubIssuesStore({ api });
  });

  it('read() unions body-codec blockedBy with native dependencies', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(blocker)] }),
    );
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    api.addNativeDependency(Number(blocked), Number(nativeBlocker));
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toHaveLength(2); // codec ref + native ref, deduped
    expect(ids.sort()).toEqual([Number(blocker), Number(nativeBlocker)].sort());
  });

  it('a purely-native blocker surfaces even with an empty codec block', async () => {
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    const blocked = await store.create(baseInput({ title: 'blocked', blockedBy: 'none' }));
    api.addNativeDependency(Number(blocked), Number(nativeBlocker));
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toEqual([Number(nativeBlocker)]);
  });

  it('duplicate codec+native refs dedupe to one', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(blocker)] }),
    );
    api.addNativeDependency(Number(blocked), Number(blocker)); // the SAME blocker, both ways
    const view = await store.read(blocked);
    const ids = (view.blockedBy === 'none' ? [] : view.blockedBy).map((r) => r.issue);
    expect(ids).toEqual([Number(blocker)]);
  });

  it('a FOREIGN-REPO codec ref never collapses into this repo\'s same-numbered native dependency', async () => {
    // GitHub ids are slug-less, so `other#N` names a DIFFERENT issue than `#N`.
    // The dedup key keeps them apart deliberately (the Linear port substitutes an
    // owning-team slug here; GitHub has none to substitute).
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    const n = Number(nativeBlocker);
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [{ slug: 'other', issue: n }] }),
    );
    api.addNativeDependency(Number(blocked), n);
    const view = await store.read(blocked);
    const refs = view.blockedBy === 'none' ? [] : view.blockedBy;
    expect(refs).toHaveLength(2); // NOT deduped — two different issues
    expect(refs).toEqual(expect.arrayContaining([{ slug: 'other', issue: n }, { issue: n }]));
  });

  it('the union is a read()-only layer — list scans stay codec-only (documented asymmetry)', async () => {
    const nativeBlocker = await store.create(baseInput({ title: 'native blocker' }));
    const blocked = await store.create(baseInput({ title: 'blocked', blockedBy: 'none' }));
    api.addNativeDependency(Number(blocked), Number(nativeBlocker));
    const listed = (await store.listOpen('wave-ready')).find((v) => v.id === blocked);
    expect(listed?.blockedBy).toBe('none'); // no per-issue getBlockedBy call in a scan
    expect((await store.read(blocked)).blockedBy).not.toBe('none'); // read() DOES union
  });
});

// ── blockedBy native WRITE half (ADR-0020's fast-follow, ported): create and
// annotate MIRROR the canonical body-codec blockedBy into native GitHub issue
// dependencies so a blocked row carries a visible dependency, not just a body
// line. Additive-only (never deletes), best-effort (a failed mirror never fails
// the issue write), and the body codec stays the canonical home. ─────────────
describe('GitHubIssuesStore — blockedBy native WRITE half (ADR-0020 fast-follow)', () => {
  let api: InMemoryGitHubApi;
  let store: GitHubIssuesStore;
  beforeEach(() => {
    api = new InMemoryGitHubApi();
    store = new GitHubIssuesStore({ api });
  });

  it('create mirrors EVERY blockedBy ref into a native dependency (multi-ref)', async () => {
    const b1 = await store.create(baseInput({ title: 'blocker one' }));
    const b2 = await store.create(baseInput({ title: 'blocker two' }));
    const blocked = await store.create(
      baseInput({ title: 'blocked', blockedBy: [store.parseRef(b1), store.parseRef(b2)] }),
    );
    expect((await api.getBlockedBy(Number(blocked))).sort()).toEqual(
      [Number(b1), Number(b2)].sort(),
    );
  });

  it('create with blockedBy "none" mirrors nothing', async () => {
    const id = await store.create(baseInput({ blockedBy: 'none' }));
    expect(await api.getBlockedBy(Number(id))).toEqual([]);
  });

  // ── the BARE arm's share of this write half (ADR-0044) ────────────────────
  //
  // A bare create reaches the SAME mirror, so the additive/dedup/best-effort
  // properties above hold for it — with one consequence that does NOT carry
  // over and is measured here rather than assumed: a bare issue has no body
  // codec, so a refused native write leaves NO record of the edge anywhere.
  // The deterministic unrepresentable case (a cross-repo ref) is refused before
  // the issue is filed; what remains is transport-level refusal, and this is
  // what it degrades to.
  it('a REJECTED dependency write on a BARE create is non-fatal — the issue is filed, and (no codec to fall back on) the edge is absent', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failDependencyWrites(new Error('POST dependencies/blocked_by rejected'));

    const bare = await store.create({
      title: 'workstream B',
      filingHint: 'workstream-b',
      bodySections: [{ heading: 'Gap', markdown: 'not specifiable yet.' }],
      blockedBy: [store.parseRef(blocker)],
    });

    // create RESOLVED — a failed mirror never fails the issue write…
    expect(bare.length).toBeGreaterThan(0);
    expect((await api.getIssue(Number(bare))).body).toContain('## Gap');
    // …and the honest measurement: unlike the decorated path, nothing recorded
    // the ref, because a bare issue carries no `## Blocked by` section by design.
    expect(await api.getBlockedBy(Number(bare))).toEqual([]);
    expect((await api.getIssue(Number(bare))).body).not.toMatch(/^##\s+Blocked by\s*$/im);

    // and it self-heals the same way the decorated path does: any later
    // create/annotate reconcile re-attempts nothing here (there is no codec ref
    // to reconcile FROM), so the recovery is to re-declare the edge at
    // decoration — pinned so the asymmetry is visible, not discovered live.
    api.failDependencyWrites(null);
    await store.annotate(bare, { files: ['src/x.ts'] });
    expect(await api.getBlockedBy(Number(bare))).toEqual([]);
  });

  it('the body codec stays the CANONICAL home — the blockedBy wire form is written unchanged alongside the native mirror', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    const codec = parseBody((await api.getIssue(Number(blocked))).body).blockedBy;
    expect(codec).not.toBe('none');
    expect((codec as { issue: number }[]).map((r) => r.issue)).toEqual([Number(blocker)]);
  });

  it('annotate mirrors a body-codec ref not yet represented natively ("newly added" reconcile)', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failDependencyWrites(new Error('dependency write down')); // create-time mirror fails
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    expect(await api.getBlockedBy(Number(blocked))).toEqual([]); // create mirror was skipped
    api.failDependencyWrites(null);
    await store.annotate(blocked, { files: ['src/new.ts'] }); // any annotate reconciles
    expect(await api.getBlockedBy(Number(blocked))).toEqual([Number(blocker)]);
  });

  it('annotate is strictly ADDITIVE — a pre-existing native dependency is never deleted, and an already-native ref is not duplicated', async () => {
    const codecBlocker = await store.create(baseInput({ title: 'codec blocker' }));
    const humanBlocker = await store.create(baseInput({ title: 'human-drawn blocker' }));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(codecBlocker)] }));
    expect(await api.getBlockedBy(Number(blocked))).toEqual([Number(codecBlocker)]); // create mirror
    // a human draws a native dependency on a blocker that is NOT in the body codec:
    api.addNativeDependency(Number(blocked), Number(humanBlocker));

    await store.annotate(blocked, { risk: 'isolated-refactor' });

    const native = await api.getBlockedBy(Number(blocked));
    // no-delete guarantee: BOTH survive; no-duplicate: the codec ref stays single.
    expect(native.filter((n) => n === Number(codecBlocker))).toEqual([Number(codecBlocker)]);
    expect(native).toContain(Number(humanBlocker));
    expect(native.sort()).toEqual([Number(codecBlocker), Number(humanBlocker)].sort());
  });

  it('a REJECTED native dependency write is non-fatal for create — the issue write survives, the codec ref stays authoritative', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failDependencyWrites(new Error('POST dependencies/blocked_by rejected'));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    // create RESOLVED (never threw); read() still surfaces the codec ref.
    const view = await store.read(blocked);
    expect(view.blockedBy).not.toBe('none');
    expect(await api.getBlockedBy(Number(blocked))).toEqual([]); // the mirror was skipped
  });

  it('a REJECTED native dependency write is non-fatal for annotate — the annotate body write still lands', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    api.failDependencyWrites(new Error('dependency write down'));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    await expect(store.annotate(blocked, { files: ['src/x.ts'] })).resolves.toBeUndefined();
    expect((await store.read(blocked)).files).toEqual(['src/x.ts']);
  });

  it('an UNRESOLVABLE blockedBy ref is skipped non-fatally; a resolvable sibling still mirrors', async () => {
    const realBlocker = await store.create(baseInput({ title: 'real blocker' }));
    const blocked = await store.create(
      baseInput({ blockedBy: [{ issue: 9999 }, store.parseRef(realBlocker)] }),
    );
    // only the resolvable ref mirrored; the phantom #9999 was skipped, not thrown.
    expect(await api.getBlockedBy(Number(blocked))).toEqual([Number(realBlocker)]);
    // and the body codec (authoritative) still carries BOTH refs untouched.
    const codec = parseBody((await api.getIssue(Number(blocked))).body).blockedBy;
    expect((codec as { issue: number }[]).map((r) => r.issue).sort()).toEqual(
      [9999, Number(realBlocker)].sort(),
    );
  });

  it('a CROSS-REPO ref is never mirrored onto this repo\'s same-numbered issue (the deliberate divergence from the Linear port)', async () => {
    // GitHub's dependency endpoints are repo-scoped, so mirroring `other#N`
    // here would create a dependency on THIS repo's #N — a silently wrong
    // relation, worse than a missing mirror. It is skipped instead.
    const localIssue = await store.create(baseInput({ title: 'this repo\'s same-numbered issue' }));
    const n = Number(localIssue);
    const blocked = await store.create(baseInput({ blockedBy: [{ slug: 'other', issue: n }] }));
    expect(await api.getBlockedBy(Number(blocked))).toEqual([]); // nothing mirrored
    // the codec keeps the cross-repo ref, authoritatively.
    const codec = parseBody((await api.getIssue(Number(blocked))).body).blockedBy;
    expect(codec).toEqual([{ slug: 'other', issue: n }]);
  });

  it('annotate on a genuine decorate-target (no Files section pre-patch) exits 0 with labels + body writes applied', async () => {
    // a bare, not-yet-decorated issue: no `## Files` / `## Acceptance criteria`
    // section at all — parsing THIS pre-patch body throws (missing `## Files`).
    const { number } = await api.createIssue({
      title: 'not yet decorated',
      body: 'Some free-form prose with no managed sections yet.',
      labels: [],
    });

    await expect(
      store.annotate(String(number), {
        risk: 'isolated-refactor',
        worker: 'background',
        files: ['src/new.ts'],
        acceptanceCriteria: [{ text: 'does the thing', checked: false }],
      }),
    ).resolves.toBeUndefined();

    const gh = await api.getIssue(number);
    expect(gh.labels).toEqual(
      expect.arrayContaining(['risk/isolated-refactor', 'worker/background']),
    );
    const parsed = parseBody(gh.body);
    expect(parsed.files).toEqual(['src/new.ts']);
    expect(parsed.acceptanceCriteria).toEqual([{ text: 'does the thing', checked: false }]);
  });

  it('the mirror reconciles from the UPDATED (post-patch) body, not the stale pre-patch read', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    // a genuine decorate-target: the raw pre-patch body already carries a
    // `## Blocked by` ref (unaffected by annotate, which never rewrites that
    // section) but has NO `## Files` / `## Acceptance criteria` section — so
    // parsing the STALE pre-patch body throws, while parsing the UPDATED
    // post-patch body succeeds and surfaces the ref to mirror.
    const { number } = await api.createIssue({
      title: 'decorate target with a pre-existing Blocked by ref',
      body: `## Blocked by\n\n#${Number(blocker)}\n`,
      labels: [],
    });

    await expect(
      store.annotate(String(number), {
        files: ['src/new.ts'],
        acceptanceCriteria: [{ text: 'does the thing', checked: false }],
      }),
    ).resolves.toBeUndefined();

    expect(await api.getBlockedBy(number)).toEqual([Number(blocker)]);
  });

  it('a body that STILL fails to parse after the patch degrades to a skipped mirror — never a thrown annotate', async () => {
    // only `files` is patched, never `acceptanceCriteria` — so even the UPDATED
    // body is missing the required `## Acceptance criteria` section and
    // parseBody keeps throwing. annotate must still resolve.
    const { number } = await api.createIssue({
      title: 'still unparseable after the patch',
      body: 'no managed sections at all',
      labels: [],
    });

    await expect(store.annotate(String(number), { files: ['src/x.ts'] })).resolves.toBeUndefined();
    expect((await api.getIssue(number)).body).toContain('## Files');
    expect(await api.getBlockedBy(number)).toEqual([]); // mirror skipped, not attempted
  });

  // ── ADR-0025's facet boundary: dependency structure is out-of-band. The
  // mirror reconciles the CANONICAL body codec, never a patch field. ─────────
  it('ADR-0025 boundary: blockedBy is NOT a member of AnnotatePatch', () => {
    // Compile-time assertion. Adding `blockedBy` to AnnotatePatch flips this
    // conditional type to `true`, and the `false` initialiser stops compiling —
    // `tsc --noEmit` is the gate that catches it; this expect() only keeps the
    // assertion reachable from (and reported by) the suite.
    const blockedByIsOnThePatch: 'blockedBy' extends keyof AnnotatePatch ? true : false = false;
    expect(blockedByIsOnThePatch).toBe(false);
  });

  it('ADR-0025 boundary: annotate never rewrites the Blocked by section — the mirror only ADDS a native representation of what the codec already says', async () => {
    const blocker = await store.create(baseInput({ title: 'blocker' }));
    const blocked = await store.create(baseInput({ blockedBy: [store.parseRef(blocker)] }));
    const before = (await api.getIssue(Number(blocked))).body;
    await store.annotate(blocked, { files: ['src/new.ts'] });
    const after = (await api.getIssue(Number(blocked))).body;
    const codecBefore = parseBody(before).blockedBy;
    const codecAfter = parseBody(after).blockedBy;
    expect(codecAfter).toEqual(codecBefore); // dependency structure untouched by the patch
  });
});

describe('GitHubIssuesStore — Triage facet (ADR-0015)', () => {
  it('applyTriage sets state + category + comment; readTriage round-trips', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const id = await store.create(baseInput());
    await store.applyTriage(id, { state: 'needs-info', category: 'bug', comment: 'need a repro' });
    const t = await store.readTriage(id);
    expect(t.state).toBe('needs-info');
    expect(t.category).toBe('bug');
    expect(t.comments[0].body).toBe('> *This was generated by AI during triage.*\n\nneed a repro');
  });

  it('applyTriage state is single-select (swaps the prior state label)', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const id = await store.create(baseInput()); // create stamps `ready-for-agent`
    await store.applyTriage(id, { state: 'needs-info' });
    await store.applyTriage(id, { state: 'ready-for-human' });
    const t = await store.readTriage(id);
    expect(t.state).toBe('ready-for-human');
  });

  it('applyTriage rejects an out-of-vocab state before writing', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const id = await store.create(baseInput());
    await expect(store.applyTriage(id, { state: 'bogus' })).rejects.toThrow();
    expect((await store.readTriage(id)).state).toBe('ready-for-agent');
  });

  it('closeUnplanned sets wontfix + comment and natively closes', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const id = await store.create(baseInput());
    await store.closeUnplanned(id, 'out of scope');
    expect((await store.readTriage(id)).state).toBe('wontfix');
    expect((await store.read(id)).status).toBe('done');
    expect((await store.readTriage(id)).comments[0].body).toContain('out of scope');
  });

  it('readTriage throws on an unknown id', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    await expect(store.readTriage('999')).rejects.toThrow();
  });
});

// ── the Goal facet's GitHub mapping (ADR-0044) ──────────────────────────────
//
// The tracker-agnostic contract cases live in `adapters/goal-facet.spec.ts`.
// This block pins what that suite deliberately cannot see: that a Goal is a
// MILESTONE here, and that the frontier reads a member's blockers through the
// #381 read-union rather than the body codec alone.
describe('GitHubIssuesStore — the Goal is a milestone (ADR-0044)', () => {
  let api: InMemoryGitHubApi;
  let store: GitHubIssuesStore;
  beforeEach(() => {
    api = new InMemoryGitHubApi();
    store = new GitHubIssuesStore({ api });
  });

  it('createGoal mints a real milestone; the id is the opaque milestone number', async () => {
    const id = await store.createGoal({
      title: '1.0.0',
      filingHint: 'ignored-entirely',
      description: 'the freeze',
    });
    const milestone = await api.getMilestone(Number(id));
    expect(milestone.title).toBe('1.0.0');
    expect(milestone.description).toBe('the freeze');
    // filingHint is ignored, exactly as `create()` ignores it (ADR-0001).
    expect(id).toBe('1');
  });

  it('assignToGoal writes the NATIVE milestone membership, not a body line', async () => {
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' });
    const issue = await store.create(baseInput());
    const bodyBefore = (await api.getIssue(Number(issue))).body;

    await store.assignToGoal(goal, issue);

    expect((await api.listMilestoneIssues(Number(goal))).map((i) => String(i.number))).toEqual([
      issue,
    ]);
    // the issue's own text is untouched — membership is tracker-native.
    expect((await api.getIssue(Number(issue))).body).toBe(bodyBefore);
    expect((await api.getIssue(Number(issue))).labels).toEqual([
      'ready-for-agent',
      'risk/mechanical',
      'worker/background',
    ]);
  });

  it('the frontier reads blockers through the #381 read-union — a NATIVE dependency alone blocks', async () => {
    // The load-bearing case for ADR-0044 decision 1: a bare member's dependency
    // exists ONLY natively (no `## Blocked by` section is ever written for it),
    // so a frontier that consulted the body codec alone would report it
    // `unready` — silently losing the edge the bare arm exists to record.
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' });
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
    await store.assignToGoal(goal, blocked);

    // no body-codec Blocked-by section exists at all…
    expect((await api.getIssue(Number(blocked))).body).not.toMatch(/^##\s+Blocked by\s*$/im);
    // …and the frontier still sees the edge.
    const reading = (await store.readGoalFrontier(goal)).readings[0];
    expect(reading.state).toBe('blocked');
    expect(reading.unresolvedBlockers).toEqual([{ issue: Number(blocker) }]);
  });

  it('a CROSS-REPO blocker is UNRESOLVED — this repo-scoped API can never prove it clear', async () => {
    // Resolving `other#5` against THIS repo's #5 would be the silently-wrong
    // answer `refToIssueNumber` already refuses to give on the write side. So it
    // stays unresolved: no evidence must never counterfeit `actionable`.
    const goal = await store.createGoal({ title: 'g', filingHint: 'g' });
    const member = await store.create(
      baseInput({ title: 'waits on another repo', blockedBy: [{ slug: 'other', issue: 5 }] }),
    );
    await store.assignToGoal(goal, member);
    const reading = (await store.readGoalFrontier(goal)).readings[0];
    expect(reading.state).toBe('blocked');
    expect(reading.unresolvedBlockers).toEqual([{ slug: 'other', issue: 5 }]);
  });

  it('a goal id that is not an integer is refused as malformed, never read as an empty goal', async () => {
    await expect(store.readGoal('not-a-number')).rejects.toThrow(/milestone id/i);
    await expect(store.readGoalFrontier('not-a-number')).rejects.toThrow(/milestone id/i);
  });
});
