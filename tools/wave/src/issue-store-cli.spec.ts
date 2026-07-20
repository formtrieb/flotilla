/**
 * issue-store-cli.spec.ts — the store-agnostic IssueStore CLI runner.
 *
 * Tests inject a real on-disk `MarkdownFsStore` (not the github fake) so
 * create/read/transition/close round-trip on the filesystem, exercising the
 * full subcommand surface against the REAL store semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runIssueStore } from './issue-store-cli';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { InMemoryLinearApi } from './adapters/linear/linear-api-fake';
import type { CreateInput, ClosingState } from './adapters/issue-store';
import type { IssueView } from './contract';

function tmpStore(): MarkdownFsStore {
  const repoRoot = mkdtempSync(join(tmpdir(), 'is-'));
  mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
  return new MarkdownFsStore({ repoRoot, slug: '2026-06-06-x' });
}

const INPUT: CreateInput = {
  title: 'Add a config route',
  filingHint: 'add-config-route',
  risk: 'mechanical',
  worker: 'background',
  files: ['cms/site/config/config.php'],
  blockedBy: 'none',
  acceptanceCriteria: [{ text: 'route registered', checked: false }],
  bodySections: [{ heading: 'What to build', markdown: 'register the route' }],
};

function writeInput(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'is-in-')), 'input.json');
  writeFileSync(p, JSON.stringify(INPUT), 'utf-8');
  return p;
}

describe('issue-store-cli', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += chunk.toString();
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((): boolean => true);
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('create then read round-trips the issue view', async () => {
    const store = tmpStore();
    const p = writeInput();

    const createCode = await runIssueStore(['create', '--input', p], store);
    expect(createCode).toBe(0);
    const id = captured.trim();
    expect(id.length).toBeGreaterThan(0);

    captured = '';
    const readCode = await runIssueStore(['read', id], store);
    expect(readCode).toBe(0);
    const view = JSON.parse(captured) as IssueView;
    expect(view.id).toBe(id);
    expect(view.risk).toBe('mechanical');
    expect(view.files).toContain('cms/site/config/config.php');
  });

  it('parse-ref prints the IssueRef JSON for a minted id', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    captured = '';
    const code = await runIssueStore(['parse-ref', id], store);
    expect(code).toBe(0);
    expect(JSON.parse(captured)).toEqual({ slug: '2026-06-06-x', issue: 1 });
  });

  it('transition writes a claim rung that read reflects as status', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    captured = '';
    const code = await runIssueStore(['transition', id, 'queued'], store);
    expect(code).toBe(0);

    captured = '';
    await runIssueStore(['read', id], store);
    const view = JSON.parse(captured) as IssueView;
    expect(view.status).toBe('queued');
  });

  it('listOpen returns a freshly-created (unclaimed) issue', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    captured = '';
    const code = await runIssueStore(['listOpen'], store);
    expect(code).toBe(0);
    const views = JSON.parse(captured) as IssueView[];
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect(views.map((v) => v.id)).toContain(id);
  });

  it('listClaimed returns an issue after it is transitioned', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();
    await runIssueStore(['transition', id, 'in-flight'], store);

    captured = '';
    const code = await runIssueStore(['listClaimed'], store);
    expect(code).toBe(0);
    const views = JSON.parse(captured) as IssueView[];
    expect(views.map((v) => v.id)).toContain(id);
  });

  it('unclaim returns 0 and drops the claim (listOpen sees it again)', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();
    await runIssueStore(['transition', id, 'queued'], store);

    const code = await runIssueStore(['unclaim', id], store);
    expect(code).toBe(0);

    captured = '';
    await runIssueStore(['listOpen'], store);
    const views = JSON.parse(captured) as IssueView[];
    expect(views.map((v) => v.id)).toContain(id);
  });

  it('close returns 0 and does not throw', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    const code = await runIssueStore(
      ['close', id, 'https://github.com/x/y/pull/1', '--acked', '0'],
      store,
    );
    expect(code).toBe(0);
  });

  it('annotate applies a patch file that read then reflects', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    const patchPath = join(mkdtempSync(join(tmpdir(), 'is-patch-')), 'patch.json');
    writeFileSync(
      patchPath,
      JSON.stringify({
        risk: 'isolated-refactor',
        files: ['cms/site/snippets/new.php'],
        acceptanceCriteria: [{ text: 'snippet renders', checked: false }],
      }),
      'utf-8',
    );

    captured = '';
    const code = await runIssueStore(['annotate', id, '--patch', patchPath], store);
    expect(code).toBe(0);

    captured = '';
    await runIssueStore(['read', id], store);
    const view = JSON.parse(captured) as IssueView;
    expect(view.risk).toBe('isolated-refactor');
    expect(view.files).toEqual(['cms/site/snippets/new.php']);
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['snippet renders']);
  });

  it('annotate with missing id returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['annotate'], store);
    expect(code).toBe(2);
  });

  it('annotate with missing --patch returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['annotate', 'x#01'], store);
    expect(code).toBe(2);
  });

  it('annotate with an unreadable --patch file returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(
      ['annotate', 'x#01', '--patch', '/nonexistent/patch.json'],
      store,
    );
    expect(code).toBe(2);
  });

  // ── amend (ADR-0025 — authored content: title + free-prose sections) ────────
  it('amend applies a title + section patch that read/triage-read then reflect', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    const patchPath = join(mkdtempSync(join(tmpdir(), 'is-amend-')), 'patch.json');
    writeFileSync(
      patchPath,
      JSON.stringify({
        title: 'Renamed via amend',
        sections: [{ heading: 'What to build', markdown: 'the amended brief' }],
      }),
      'utf-8',
    );

    captured = '';
    const code = await runIssueStore(['amend', id, '--patch', patchPath], store);
    expect(code).toBe(0);

    captured = '';
    await runIssueStore(['triage-read', id], store);
    const triage = JSON.parse(captured) as { title: string; body: string };
    expect(triage.title).toBe('Renamed via amend');
    expect(triage.body).toContain('the amended brief');
    expect(triage.body).not.toContain('register the route'); // original section content replaced

    // modeled fields untouched (AC / files still read back)
    captured = '';
    await runIssueStore(['read', id], store);
    const view = JSON.parse(captured) as IssueView;
    expect(view.acceptanceCriteria.map((a) => a.text)).toEqual(['route registered']);
  });

  it('amend with missing id returns 2', async () => {
    const store = tmpStore();
    expect(await runIssueStore(['amend'], store)).toBe(2);
  });

  it('amend with missing --patch returns 2', async () => {
    const store = tmpStore();
    expect(await runIssueStore(['amend', 'x#01'], store)).toBe(2);
  });

  it('amend with an unreadable --patch file returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(
      ['amend', 'x#01', '--patch', '/nonexistent/patch.json'],
      store,
    );
    expect(code).toBe(2);
  });

  it('amend with an EMPTY patch is a usage error (exit 2), not a domain failure', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    const emptyPatch = join(mkdtempSync(join(tmpdir(), 'is-empty-')), 'patch.json');
    writeFileSync(emptyPatch, JSON.stringify({}), 'utf-8');
    expect(await runIssueStore(['amend', id, '--patch', emptyPatch], store)).toBe(2);

    const emptySections = join(mkdtempSync(join(tmpdir(), 'is-empty2-')), 'patch.json');
    writeFileSync(emptySections, JSON.stringify({ sections: [] }), 'utf-8');
    expect(await runIssueStore(['amend', id, '--patch', emptySections], store)).toBe(2);
  });

  it('amend with a reserved-heading section is a domain failure (exit 1)', async () => {
    const store = tmpStore();
    const p = writeInput();
    await runIssueStore(['create', '--input', p], store);
    const id = captured.trim();

    const patchPath = join(mkdtempSync(join(tmpdir(), 'is-reserved-')), 'patch.json');
    writeFileSync(
      patchPath,
      JSON.stringify({ sections: [{ heading: 'Acceptance criteria', markdown: 'x' }] }),
      'utf-8',
    );
    expect(await runIssueStore(['amend', id, '--patch', patchPath], store)).toBe(1);
  });

  it('read of a nonexistent id returns 1 (store threw, domain failure) and writes stderr', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['read', 'nonexistent#99'], store);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it('unknown op returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['frobnicate'], store);
    expect(code).toBe(2);
  });

  it('missing --input on create returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['create'], store);
    expect(code).toBe(2);
  });

  it('unreadable --input file returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(
      ['create', '--input', '/nonexistent/path/to/input.json'],
      store,
    );
    expect(code).toBe(2);
  });

  it('missing op returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore([], store);
    expect(code).toBe(2);
  });

  it('read with missing id returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['read'], store);
    expect(code).toBe(2);
  });

  it('transition with an invalid rung returns 2', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['transition', 'x#01', 'available'], store);
    expect(code).toBe(2);
  });

  it('transition with missing id returns 2', async () => {
    const store = tmpStore();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runIssueStore(['transition'], store);
    expect(code).toBe(2);
  });

  it('unclaim with missing id returns 2', async () => {
    const store = tmpStore();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runIssueStore(['unclaim'], store);
    expect(code).toBe(2);
  });

  it('close with missing prUrl returns 2', async () => {
    const store = tmpStore();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runIssueStore(['close', 'some-id'], store);
    expect(code).toBe(2);
  });
});

describe('issue-store-cli — triage ops (ADR-0015)', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('triage-apply then triage-read round-trips', async () => {
    const store = tmpStore();
    const id = await store.create(INPUT);
    const inputPath = join(mkdtempSync(join(tmpdir(), 'is-tri-')), 'patch.json');
    writeFileSync(inputPath, JSON.stringify({ state: 'needs-info', comment: 'repro?' }));
    expect(await runIssueStore(['triage-apply', id, '--input', inputPath], store)).toBe(0);
    expect(await runIssueStore(['triage-read', id], store)).toBe(0);
    expect((await store.readTriage(id)).state).toBe('needs-info');
  });

  it('triage-close closes as wontfix', async () => {
    const store = tmpStore();
    const id = await store.create(INPUT);
    expect(await runIssueStore(['triage-close', id, '--comment', 'out of scope'], store)).toBe(0);
    expect((await store.readTriage(id)).state).toBe('wontfix');
  });

  it('triage-apply without --input is a usage error (exit 2)', async () => {
    const store = tmpStore();
    const id = await store.create(INPUT);
    expect(await runIssueStore(['triage-apply', id], store)).toBe(2);
  });
});

// ── FOR-18: the done-reconcile close seam ────────────────────────────────────
// The live gate (F1) found no M1 skill ever called IssueStore.close(), so a
// merged row sat in-review forever and FOR-13's opt-in doneState fallback had no
// operational trigger. wave-close/wave-resume now wire the EXISTING `close` verb
// into their done-reconcile step. This spec crosses that SAME verb — the one the
// skills invoke — INTO a real store (not another hand-authored fixture), proving
// the row reaches `done` for BOTH the native-merged path (integration present)
// and the no-integration doneState fallback (FOR-13). The reconcile probe
// (`read-closing`) is exercised alongside it so the seam mirrors the skill flow.
describe('issue-store-cli — done-reconcile close seam (FOR-18)', () => {
  const PR = 'https://github.com/o/r/pull/18';
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        captured += chunk.toString();
        return true;
      });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  function linearInput(): CreateInput {
    return {
      title: 'Wire close into done-reconcile',
      filingHint: 'wire-close-done-reconcile',
      risk: 'mechanical',
      worker: 'background',
      files: ['tools/wave/src/issue-store-cli.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'merged row lands done', checked: false }],
    };
  }

  it('native-merged path: read-closing reports merged → the `close` verb lands the row `done` (idempotent reconcile)', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api }); // no doneState — the pure native path
    const id = await store.create(linearInput());
    await store.transition(id, 'in-review');
    api.simulateMergedPrClose(id, PR); // Linear↔GitHub integration saw the merge

    // the reconcile probe the skill runs first:
    captured = '';
    expect(await runIssueStore(['read-closing', id], store)).toBe(0);
    expect(JSON.parse(captured) as ClosingState).toMatchObject({ state: 'merged', prUrl: PR });

    // the newly-wired close verb: idempotent no-op-or-reconcile on an already-merged row.
    expect(await runIssueStore(['close', id, PR], store)).toBe(0);

    captured = '';
    await runIssueStore(['read', id], store);
    expect((JSON.parse(captured) as IssueView).status).toBe('done');
  });

  it('doneState fallback path (FOR-13, no integration): the SAME `close` verb transitions the row to `done` + posts the loud advisory', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(linearInput());
    await store.transition(id, 'in-review'); // stays open — no integration to see the merge

    // no integration → the probe can never report `merged`; it is `open`. The merge
    // is confirmed out-of-band and the SAME close verb lands it via the fallback.
    captured = '';
    expect(await runIssueStore(['read-closing', id], store)).toBe(0);
    expect(JSON.parse(captured) as ClosingState).toMatchObject({ state: 'open' });

    expect(await runIssueStore(['close', id, PR], store)).toBe(0);

    captured = '';
    await runIssueStore(['read', id], store);
    expect((JSON.parse(captured) as IssueView).status).toBe('done');

    // the FOR-13 fallback fired: exactly one loud advisory, naming it, carrying the PR.
    const comments = await api.getComments(id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toMatch(/done-state fallback/i);
    expect(comments[0].body).toContain(PR);
  });

  it('re-entrant re-run: a second `close` on the fallback-landed row does not double-post or throw', async () => {
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api, states: { doneState: 'Done' } });
    const id = await store.create(linearInput());
    await store.transition(id, 'in-review');

    expect(await runIssueStore(['close', id, PR], store)).toBe(0);
    expect(await runIssueStore(['close', id, PR], store)).toBe(0); // re-entrant wave-close/wave-resume

    captured = '';
    await runIssueStore(['read', id], store);
    expect((JSON.parse(captured) as IssueView).status).toBe('done');
    expect(await api.getComments(id)).toHaveLength(1); // advisory not doubled
  });
});
