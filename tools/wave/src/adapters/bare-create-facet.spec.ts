/**
 * bare-create-facet.spec.ts — the store-aware half of ADR-0027's undecorated
 * filing path (`filed:`), and the measured behaviour of the DoR gate when it is
 * pointed at a bare issue.
 *
 * The tracker-agnostic contract cases live in the shared conformance suite
 * (`conformance/issue-store-conformance.ts`), which proves a bare create
 * round-trips on all three stores. This file pins the two things that suite
 * deliberately cannot see:
 *
 *  1. the STORAGE shape of a bare issue on MarkdownFs (no `**Status:**`
 *     eligibility stamp, no Header-Block lines) and on GitHub (no labels at
 *     all) — the concrete "it carries no eligibility marker" claim; and
 *  2. how `dor --id` DEGRADES on a bare id. That entrypoint is the wave's
 *     readiness gate, and a bare issue is by construction not ready. The
 *     behaviour below is MEASURED, not assumed: it is what the seam actually
 *     does today, pinned so a later change to the bare path cannot quietly turn
 *     "not readable" into "ready".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownFsStore } from './markdown-fs-store';
import { GitHubIssuesStore } from './github/github-issues-store';
import { InMemoryGitHubApi } from './github/github-api-fake';
import { LinearIssuesStore } from './linear/linear-issues-store';
import { InMemoryLinearApi } from './linear/linear-api-fake';
import { runDorById } from '../cli';
import { CreateInputError, type CreateInput } from './issue-store';

const SLUG = 'bare-create';

const BARE: CreateInput = {
  title: 'Gate 8 ships inert',
  filingHint: 'gate-8-ships-inert',
  bodySections: [
    { heading: 'Gap', markdown: 'the verify config is never threaded through.' },
    { heading: 'Provenance', markdown: 'wave hardening, row 3, iteration 1.' },
  ],
};

const DECORATED: CreateInput = {
  title: 'A real slice',
  filingHint: 'a-real-slice',
  risk: 'mechanical',
  worker: 'background',
  files: ['src/x.ts'],
  blockedBy: 'none',
  acceptanceCriteria: [{ text: 'does the thing', checked: false }],
};

describe('bare create — MarkdownFs storage shape (ADR-0027)', () => {
  let root: string;
  let store: MarkdownFsStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bare-md-'));
    store = new MarkdownFsStore({ repoRoot: root, slug: SLUG });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const issuesDir = () => join(root, '.scratch', SLUG, 'issues');

  async function sourceOf(id: string): Promise<string> {
    const nn = id.slice(id.lastIndexOf('#') + 1);
    const names = await readdir(issuesDir());
    const name = names.find((n) => n.startsWith(`${nn}-`));
    if (name === undefined) throw new Error(`no file for ${id}`);
    return readFile(join(issuesDir(), name), 'utf-8');
  }

  it('writes the H1 + prose and NOTHING else — no eligibility stamp, no Header-Block', async () => {
    const id = await store.create(BARE);
    const src = await sourceOf(id);

    expect(src).toMatch(/^# 01 — Gate 8 ships inert$/m);
    expect(src).toContain('## Gap');
    expect(src).toContain('## Provenance');
    // the eligibility stamp create() writes for a decorated issue is ABSENT —
    // this is what keeps the bare issue out of the wave-ready pool.
    expect(src).not.toMatch(/^\*\*Status:\*\*/m);
    // …and so is every Header-Block field.
    for (const field of ['Risk', 'Worker', 'Files', 'Blocked by']) {
      expect(src).not.toMatch(new RegExp(`^\\*\\*${field}:\\*\\*`, 'm'));
    }
    expect(src).not.toMatch(/^##\s+Acceptance criteria\s*$/im);
  });

  it('the decorated create still writes the full stamped shape (unchanged)', async () => {
    const id = await store.create(DECORATED);
    const src = await sourceOf(id);
    expect(src).toMatch(/^\*\*Status:\*\* ready-for-agent$/m);
    expect(src).toMatch(/^\*\*Risk:\*\* mechanical$/m);
    expect(src).toMatch(/^\*\*Worker:\*\* background$/m);
    expect(src).toMatch(/^\*\*Blocked by:\*\* none$/m);
    expect(src).toMatch(/^##\s+Acceptance criteria\s*$/im);
  });

  it('a rejected half-written Header-Block writes no file at all', async () => {
    await expect(
      store.create({ title: 'Half', filingHint: 'half', risk: 'mechanical' }),
    ).rejects.toThrow(/Header-Block/i);
    // not even an empty issues/ dir entry: the classifier runs before mkdir.
    await expect(readdir(issuesDir())).rejects.toThrow();
  });

  // #309: the bare-body rule used to sit at the issue-store CLI, so a caller
  // holding the store directly — the shape this whole file exercises — could
  // still write a 0-body-char issue to disk. Now the classifier owns it, and
  // "rejects" means the same thing it means for a half-written header: nothing
  // reached the filesystem.
  it('a bodyless BARE input writes no file at all — the rule is not the CLI-layer predicate any more', async () => {
    await expect(
      store.create({ title: 'Bodyless', filingHint: 'bodyless' }),
    ).rejects.toThrow(/bodySections/i);
    await expect(
      store.create({ title: 'Bodyless', filingHint: 'bodyless', bodySections: [] }),
    ).rejects.toThrow(/bodySections/i);
    await expect(
      store.create({
        title: 'Bodyless',
        filingHint: 'bodyless',
        bodySections: [{ heading: 'Gap', markdown: '  \n ' }],
      }),
    ).rejects.toThrow(/bodySections/i);
    await expect(readdir(issuesDir())).rejects.toThrow();
  });
});

describe('bare create — GitHub storage shape (ADR-0027)', () => {
  it('files the issue with NO labels — no eligibility token, no risk/* or worker/* stamp', async () => {
    const api = new InMemoryGitHubApi();
    const store = new GitHubIssuesStore({ api });

    const id = await store.create(BARE);
    const gh = await api.getIssue(Number(id));
    expect(gh.labels).toEqual([]);
    expect(gh.title).toBe('Gate 8 ships inert');
    expect(gh.body).toContain('## Gap');
    expect(gh.body).not.toMatch(/^##\s+Files\s*$/im);

    // the decorated path is untouched: eligibility + risk/* + worker/* as before.
    const decorated = await store.create(DECORATED);
    expect((await api.getIssue(Number(decorated))).labels).toEqual([
      'ready-for-agent',
      'risk/mechanical',
      'worker/background',
    ]);
  });
});

// ── the BARE `blockedBy` arm (ADR-0044 decision 1) ───────────────────────────
//
// "Tickets that cannot be fully defined yet but already depend on each other"
// is the goal station's core mechanism: at a goal's cut you know THAT
// workstream B waits on workstream A before either is specifiable. Before this
// arm there was no write path for a dependency between two bare issues — the
// ADR-0020 write-mirror derives native dependencies from the Header-Block
// `Blocked by`, at decoration, and a bare issue has no Header-Block.
//
// The arm's whole claim, and what these cases pin: `blockedBy` on a bare input
// is realized NATIVELY per adapter and NEVER as a header line, so the bare
// invariant is byte-for-byte what it was. A store that cannot realize it
// natively refuses loudly rather than faking it (the `closed-unknown`
// precedent, applied to the write side).

/** The BARE fixture plus the ADR-0044 arm — used across all three stores below. */
function bareBlockedBy(refs: CreateInput['blockedBy']): CreateInput {
  return { ...BARE, blockedBy: refs };
}

/** Assert a thrown value is the typed create rejection, and hand back its fields. */
function createRejection(err: unknown): CreateInputError {
  expect(err).toBeInstanceOf(CreateInputError);
  return err as CreateInputError;
}

describe('bare create + blockedBy — GitHub realizes it as a NATIVE issue dependency', () => {
  let api: InMemoryGitHubApi;
  let store: GitHubIssuesStore;
  beforeEach(() => {
    api = new InMemoryGitHubApi();
    store = new GitHubIssuesStore({ api });
  });

  it('lands the dependency natively while the bare shape stays EXACTLY bare', async () => {
    const blocker = await store.create({ ...BARE, title: 'workstream A' });
    const blocked = await store.create(
      bareBlockedBy([store.parseRef(blocker)]),
    );

    // the edge is REAL on the tracker, not a body line…
    expect(await api.getBlockedBy(Number(blocked))).toEqual([Number(blocker)]);

    // …and the bare invariant is untouched: no labels at all (no eligibility
    // token, no risk/*, no worker/*) and no managed body sections — least of
    // all a `## Blocked by` one, which is the header line this arm exists to
    // avoid writing.
    const gh = await api.getIssue(Number(blocked));
    expect(gh.labels).toEqual([]);
    expect(gh.body).toContain('## Gap');
    expect(gh.body).not.toMatch(/^##\s+Blocked by\s*$/im);
    expect(gh.body).not.toMatch(/^##\s+Files\s*$/im);
    expect(gh.body).not.toMatch(/^##\s+Acceptance criteria\s*$/im);
    // still outside the wave-ready pool — existence, not readiness.
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(blocked);
  });

  it("the read-union reports the edge with NO `blockedBy` decoration — the native side is its only source", async () => {
    // A bare issue has no projectable IssueView at all (`read()` throws until it
    // is decorated — pinned above), so the union is measured at the first moment
    // the issue IS readable. `AnnotatePatch` deliberately carries no
    // `blockedBy`, and no `## Blocked by` section was ever written, so the codec
    // half of the union is `'none'`: every ref below came from the native
    // dependency the BARE create wrote.
    const blocker = await store.create({ ...BARE, title: 'workstream A' });
    const blocked = await store.create(bareBlockedBy([store.parseRef(blocker)]));
    await expect(store.read(blocked)).rejects.toThrow(); // bare: nothing to project yet

    await store.annotate(blocked, {
      risk: 'mechanical',
      worker: 'background',
      files: ['src/x.ts'],
      acceptanceCriteria: [{ text: 'the gap is closed', checked: false }],
    });

    const view = await store.read(blocked);
    expect(view.blockedBy).toEqual([{ issue: Number(blocker) }]);
    // and the body still carries no Blocked-by section — the edge is native-only.
    expect((await api.getIssue(Number(blocked))).body).not.toMatch(
      /^##\s+Blocked by\s*$/im,
    );
  });

  it('mirrors EVERY ref (multi-ref), and "none"/[] file exactly the blockedBy-less bare issue', async () => {
    const a = await store.create({ ...BARE, title: 'A' });
    const b = await store.create({ ...BARE, title: 'B' });
    const both = await store.create(
      bareBlockedBy([store.parseRef(a), store.parseRef(b)]),
    );
    expect((await api.getBlockedBy(Number(both))).sort()).toEqual(
      [Number(a), Number(b)].sort(),
    );

    const none = await store.create(bareBlockedBy('none'));
    const empty = await store.create(bareBlockedBy([]));
    expect(await api.getBlockedBy(Number(none))).toEqual([]);
    expect(await api.getBlockedBy(Number(empty))).toEqual([]);
    for (const id of [none, empty]) {
      expect((await api.getIssue(Number(id))).labels).toEqual([]);
      expect((await api.getIssue(Number(id))).body).not.toMatch(/^##\s+Blocked by\s*$/im);
    }
  });

  it('a CROSS-REPO ref is refused before anything is filed — never a silently-dropped edge', async () => {
    // The decorated path can afford to skip an unmirrorable ref: the body codec
    // recorded it authoritatively first. A bare issue has no codec line, so the
    // same skip would lose the edge entirely — so this is refused up front, and
    // no issue is created.
    const before = (await api.listOpenIssues()).length;
    let thrown: unknown;
    try {
      await store.create(bareBlockedBy([{ slug: 'other-repo', issue: 5 }]));
    } catch (err) {
      thrown = err;
    }
    const rejection = createRejection(thrown);
    expect(rejection.failure).toBe('bare-blocked-by-unrepresentable');
    expect(rejection.fields).toEqual(['blockedBy']);
    expect(rejection.message).toContain('other-repo#5');
    expect((await api.listOpenIssues()).length).toBe(before); // filed NOTHING
  });
});

describe('bare create + blockedBy — Linear realizes it as a NATIVE issue relation', () => {
  let api: InMemoryLinearApi;
  let store: LinearIssuesStore;
  beforeEach(() => {
    api = new InMemoryLinearApi();
    store = new LinearIssuesStore({ api });
  });

  it('lands the relation natively while the bare shape stays EXACTLY bare', async () => {
    const blocker = await store.create({ ...BARE, title: 'workstream A' });
    const blocked = await store.create(bareBlockedBy([store.parseRef(blocker)]));

    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);

    const issue = await api.getIssue(blocked);
    expect(issue.labels).toEqual([]);
    expect(issue.description).toContain('## Gap');
    expect(issue.description).not.toMatch(/^##\s+Blocked by\s*$/im);
    expect(issue.description).not.toMatch(/^##\s+Files\s*$/im);
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(blocked);
  });

  it('the read-union reports the edge once the issue is readable — native side only', async () => {
    const blocker = await store.create({ ...BARE, title: 'workstream A' });
    const blocked = await store.create(bareBlockedBy([store.parseRef(blocker)]));
    await expect(store.read(blocked)).rejects.toThrow(); // bare: nothing to project yet

    await store.annotate(blocked, {
      risk: 'mechanical',
      worker: 'background',
      files: ['src/x.ts'],
      acceptanceCriteria: [{ text: 'the gap is closed', checked: false }],
    });

    const view = await store.read(blocked);
    expect(view.blockedBy).toEqual([store.parseRef(blocker)]);
    expect((await api.getIssue(blocked)).description).not.toMatch(
      /^##\s+Blocked by\s*$/im,
    );
  });

  it('a CROSS-TEAM ref needs no refusal — a Linear identifier carries its own team slug', async () => {
    // The deliberate divergence from the GitHub adapter, pinned so the asymmetry
    // reads as a decision: `refToIdentifier` resolves `OTHER#7` to `OTHER-7`, so
    // there is nothing this store cannot represent.
    const foreignApi = new InMemoryLinearApi('OTHER');
    const foreignStore = new LinearIssuesStore({ api: foreignApi });
    const foreign = await foreignStore.create({ ...BARE, title: 'other-team blocker' });

    const blocked = await store.create(
      bareBlockedBy([foreignStore.parseRef(foreign)]),
    );
    // the create RESOLVED (no refusal) and filed the bare issue…
    expect((await api.getIssue(blocked)).labels).toEqual([]);
    // …and the mirror was attempted against the cross-team identifier. This
    // fake resolves only its OWN issues, so the write is a non-fatal skip here —
    // the point pinned is the ABSENCE of an up-front refusal, not the fake's
    // single-workspace reach.
    expect(await api.getBlockedBy(blocked)).toEqual([]);
  });
});

describe('bare create + blockedBy — MarkdownFs degrades HONESTLY (never a partial header)', () => {
  let root: string;
  let store: MarkdownFsStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bare-md-dep-'));
    store = new MarkdownFsStore({ repoRoot: root, slug: SLUG });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const issuesDir = () => join(root, '.scratch', SLUG, 'issues');

  it('refuses with the typed rejection, names BOTH sanctioned routes, and writes no file at all', async () => {
    let thrown: unknown;
    try {
      await store.create(bareBlockedBy([{ slug: SLUG, issue: 1 }]));
    } catch (err) {
      thrown = err;
    }
    const rejection = createRejection(thrown);
    expect(rejection.failure).toBe('bare-blocked-by-unrepresentable');
    expect(rejection.fields).toEqual(['blockedBy']);
    // route 1 — file it decorated now (the whole Header-Block);
    expect(rejection.message).toMatch(/DECORATED/);
    expect(rejection.message).toContain('risk, worker, files, blockedBy, acceptanceCriteria');
    // route 2 — file it bare and add the dependency at decoration time.
    expect(rejection.message).toMatch(/decoration time/);
    // and the honesty claim itself: no half-written header line was written…
    expect(rejection.message).toContain('**Blocked by:**');
    // …because nothing was written. The refusal precedes even the mkdir, the
    // same "files nothing" property the half-written and bodyless rejections have.
    await expect(readdir(issuesDir())).rejects.toThrow();
  });

  it('"none" and [] are NOT refused — they declare no edge, so they file the ordinary bare issue', async () => {
    // The negative control for the refusal above: it fires on an edge this store
    // cannot represent, not on the mere presence of the key.
    const none = await store.create(bareBlockedBy('none'));
    const empty = await store.create({ ...bareBlockedBy([]), filingHint: 'empty-arm' });
    const names = await readdir(issuesDir());
    expect(names).toHaveLength(2);
    for (const id of [none, empty]) {
      const nn = id.slice(id.lastIndexOf('#') + 1);
      const name = names.find((n) => n.startsWith(`${nn}-`));
      const src = await readFile(join(issuesDir(), name as string), 'utf-8');
      expect(src).toContain('## Gap');
      expect(src).not.toMatch(/^\*\*Blocked by:\*\*/m);
      expect(src).not.toMatch(/^\*\*Status:\*\*/m);
    }
  });
});

describe('the BARE invariant and both fail-loud rejections survive the new arm', () => {
  let store: GitHubIssuesStore;
  beforeEach(() => {
    store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
  });

  it('a HALF-WRITTEN Header-Block is still half-written when `blockedBy` is one of the fields present', async () => {
    // The arm sanctions `blockedBy` ALONE. Paired with any other Header-Block
    // field it is an ordinary partial set, and the rejection still names the
    // four that are missing — never "this is a bare issue with extras".
    let thrown: unknown;
    try {
      await store.create({ ...BARE, blockedBy: 'none', risk: 'mechanical' });
    } catch (err) {
      thrown = err;
    }
    const rejection = createRejection(thrown);
    expect(rejection.failure).toBe('header-block-half-written');
    expect(rejection.fields).toEqual(['worker', 'files', 'acceptanceCriteria']);
  });

  it('a DECORATION-ONLY stowaway is still refused on a bare input carrying `blockedBy`', async () => {
    let thrown: unknown;
    try {
      await store.create({ ...bareBlockedBy([{ issue: 1 }]), unblocks: [{ issue: 2 }] });
    } catch (err) {
      thrown = err;
    }
    const rejection = createRejection(thrown);
    expect(rejection.failure).toBe('bare-carries-decoration-only-fields');
    expect(rejection.fields).toEqual(['unblocks']);
  });

  it('a bodyless bare input carrying `blockedBy` is still refused for its BODY, not waved through', async () => {
    let thrown: unknown;
    try {
      await store.create({
        title: 'Bodyless',
        filingHint: 'bodyless',
        blockedBy: [{ issue: 1 }],
      });
    } catch (err) {
      thrown = err;
    }
    const rejection = createRejection(thrown);
    expect(rejection.failure).toBe('bare-without-body');
    expect(rejection.fields).toEqual(['bodySections']);
  });
});

// ── bare → decorate-later, the ADR-0027 second step (MEASURED) ───────────────
//
// ADR-0027 splits existence from readiness: a bare issue is filed now, and
// wave-readiness comes later through `to-issues` decorate-mode (`annotate`).
// These two cases measure how far that second step actually gets on each
// storage shape, so the split is pinned rather than assumed.
describe('a BARE issue decorated later via annotate', () => {
  it('GitHub: annotate completes it into a readable IssueView (eligibility stays a separate, consumer-owned act)', async () => {
    const api = new InMemoryGitHubApi();
    const store = new GitHubIssuesStore({ api });
    const id = await store.create(BARE);
    await expect(store.read(id)).rejects.toThrow(); // bare: nothing to project

    await store.annotate(id, {
      risk: 'mechanical',
      worker: 'background',
      files: ['src/x.ts'],
      acceptanceCriteria: [{ text: 'the gap is closed', checked: false }],
    });

    const view = await store.read(id);
    expect(view.risk).toBe('mechanical');
    expect(view.files).toEqual(['src/x.ts']);
    expect(view.blockedBy).toBe('none'); // an ABSENT Blocked-by section is "no blockers"
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['the gap is closed']);
    // …and the authored prose the bare filing carried survived the decorate.
    expect((await store.readTriage(id)).body).toContain('## Provenance');
    // Eligibility is NOT something annotate grants (ADR-0003 — the marker is
    // consumer-owned): the decorated-from-bare issue is readable and
    // DoR-checkable, but still outside the wave-ready pool until the tracker
    // side stamps it. Existence, readability, and readiness are three steps.
    expect((await store.listOpen('wave-ready')).map((v) => v.id)).not.toContain(id);
  });

  it('MarkdownFs: annotate alone canNOT complete it — `Blocked by` is not in AnnotatePatch (pre-existing ADR-0010 assumption)', async () => {
    // Measured, not a defect introduced here: ADR-0010 states decorate assumes
    // the target ALREADY carries `Blocked by`, and `AnnotatePatch` deliberately
    // omits it (dependency structure is out-of-band). On GitHub/Linear an absent
    // `## Blocked by` section legitimately reads as `none`; MarkdownFs's header
    // parser lists it as a REQUIRED field, so a bare markdown issue stays
    // unreadable after a decorate. Pinned so the asymmetry is visible.
    const root = await mkdtemp(join(tmpdir(), 'bare-dec-'));
    try {
      const store = new MarkdownFsStore({ repoRoot: root, slug: SLUG });
      const id = await store.create(BARE);
      await store.annotate(id, {
        risk: 'mechanical',
        worker: 'background',
        files: ['src/x.ts'],
        acceptanceCriteria: [{ text: 'the gap is closed', checked: false }],
      });
      await expect(store.read(id)).rejects.toThrow(/Blocked by/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── `dor --id` on a bare id (MEASURED, then pinned) ──────────────────────────
//
// A bare issue has no Header-Block, so there is no `IssueView` to project and
// no self-content gate to run. `runDorById` reads through the store first, and
// that read is exactly where the absence surfaces: the store reports WHICH
// required fields/sections it could not find, `runDorById` returns 1, and it
// resolves normally — no throw, no unhandled rejection, and critically no PASS
// rendered over emptiness. Deferring or failing honestly are both acceptable
// outcomes for a bare id; passing is not, and that is the property pinned here.
describe('dor --id on a BARE issue degrades gracefully (never passes on emptiness)', () => {
  let stdoutBuf: string;
  let stderrBuf: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  const roots: string[] = [];

  beforeEach(() => {
    stdoutBuf = '';
    stderrBuf = '';
    outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stdoutBuf += chunk.toString();
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrBuf += chunk.toString();
        return true;
      });
  });

  afterEach(async () => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  async function markdownStore(): Promise<MarkdownFsStore> {
    const root = await mkdtemp(join(tmpdir(), 'bare-dor-'));
    roots.push(root);
    return new MarkdownFsStore({ repoRoot: root, slug: SLUG });
  }

  it('MarkdownFs: resolves to exit 1, naming the required header fields it could not find', async () => {
    const store = await markdownStore();
    const id = await store.create(BARE);

    // resolves — the contract is "always a number", never a rejected promise.
    await expect(runDorById(['--id', id], store)).resolves.toBe(1);

    expect(stderrBuf).toContain(`cannot read issue ${id}`);
    // the non-parseable outcome is REPORTED, field by field, not swallowed.
    expect(stderrBuf).toMatch(/Required field "\*\*Risk:\*\*" is missing/);
    expect(stderrBuf).toMatch(/Required field "\*\*Blocked by:\*\*" is missing/);
    // and nothing was rendered as ready.
    expect(stdoutBuf).not.toMatch(/\bPASS\b/);
  });

  it('GitHub: same graceful degradation — exit 1 naming the missing managed section', async () => {
    const store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    const id = await store.create(BARE);

    await expect(runDorById(['--id', id], store)).resolves.toBe(1);

    expect(stderrBuf).toContain(`cannot read issue ${id}`);
    expect(stderrBuf).toMatch(/## Files/);
    expect(stdoutBuf).not.toMatch(/\bPASS\b/);
  });

  it('a DECORATED issue still passes dor --id — the gate is not broken for the normal path', async () => {
    const store = await markdownStore();
    const id = await store.create(DECORATED);

    await expect(runDorById(['--id', id], store)).resolves.toBe(0);
    expect(stdoutBuf).toMatch(new RegExp(`^PASS\\s+${id}`, 'm'));
  });
});
