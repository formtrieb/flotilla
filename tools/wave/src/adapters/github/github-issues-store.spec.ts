import { describe, it, expect, beforeEach } from 'vitest';
import { GitHubIssuesStore } from './github-issues-store';
import { InMemoryGitHubApi, githubConformanceHooks } from './github-api-fake';
import type { CreateInput } from '../issue-store';
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
