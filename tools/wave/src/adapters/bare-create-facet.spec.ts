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
import { runDorById } from '../cli';
import type { CreateInput } from './issue-store';

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
