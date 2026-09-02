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
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import type {
  CreateInput,
  ClosingState,
  GoalContainer,
  GoalUpdateReceipt,
  PublishGoalUpdateInput,
} from './adapters/issue-store';
import type { IssueView } from './contract';

function tmpStore(): MarkdownFsStore {
  const repoRoot = mkdtempSync(join(tmpdir(), 'is-'));
  mkdirSync(join(repoRoot, '.scratch'), { recursive: true });
  return new MarkdownFsStore({ repoRoot, slug: '2026-06-06-x' });
}

/**
 * A linear store that already knows its container binding — what a consumer's
 * `wave.config.json` supplies through `store.goal.container`.
 *
 * Needed because an INJECTED store makes `resolveGoalContainer` return
 * `undefined` on purpose (there is no config file to read in these tests), and
 * the linear store deliberately has no default binding. The subject of the cases
 * below is the OP — its output, its exit codes, its usage errors — not the
 * binding resolution, which has its own case a few tests down. Nothing in
 * production is overridden: the binding is passed exactly where the CLI would
 * have passed a configured one.
 */
class ProjectBoundLinearStore extends LinearIssuesStore {
  async publishGoalUpdate(
    goalId: string,
    input?: PublishGoalUpdateInput,
    container?: GoalContainer,
  ): Promise<GoalUpdateReceipt> {
    return super.publishGoalUpdate(goalId, input, container ?? 'project');
  }
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

  // ── bare create (ADR-0027 — the `filed:` disposition through the CLI) ───────
  //
  // The disposition step files a BARE issue inline: title, gap description,
  // provenance line — no eligibility marker, no Header-Block. This is the verb
  // the Coordinator invokes, so the CLI must accept the bare shape end-to-end
  // (previously it could not, and bare finding-issues went out through the host
  // CLI instead, outside the engine seam).
  function writeJson(prefix: string, value: unknown): string {
    const p = join(mkdtempSync(join(tmpdir(), prefix)), 'input.json');
    writeFileSync(p, JSON.stringify(value), 'utf-8');
    return p;
  }

  const BARE_INPUT = {
    title: 'Gate 8 ships inert',
    filingHint: 'gate-8-ships-inert',
    bodySections: [
      { heading: 'Gap', markdown: 'the verify config is never threaded through.' },
      { heading: 'Provenance', markdown: 'wave hardening, row 3, iteration 1.' },
    ],
  };

  it('create accepts a BARE input (title + filingHint + bodySections) and files it undecorated', async () => {
    const store = tmpStore();
    const code = await runIssueStore(
      ['create', '--input', writeJson('is-bare-', BARE_INPUT)],
      store,
    );
    expect(code).toBe(0);
    const id = captured.trim();
    expect(id.length).toBeGreaterThan(0);

    // the authored content landed…
    const triage = await store.readTriage(id);
    expect(triage.title).toBe('Gate 8 ships inert');
    expect(triage.body).toContain('the verify config is never threaded through.');
    expect(triage.body).toContain('wave hardening, row 3, iteration 1.');

    // …and nothing else did: no eligibility stamp (absent from listOpen), no
    // Header-Block, no acceptance-criteria checklist fabricated from nothing.
    captured = '';
    await runIssueStore(['listOpen'], store);
    expect((JSON.parse(captured) as IssueView[]).map((v) => v.id)).not.toContain(id);
    expect(triage.body).not.toMatch(/^##\s+Acceptance criteria\s*$/im);
    expect(triage.body).not.toMatch(/^\*\*Risk:\*\*/m);
  });

  // ── the BARE `blockedBy` arm through the CLI (ADR-0044) ───────────────────
  it('create accepts a BARE input carrying blockedBy and lands it as a NATIVE dependency (no Header-Block written)', async () => {
    const api = new InMemoryGitHubApi();
    const store = new GitHubIssuesStore({ api });

    await runIssueStore(['create', '--input', writeJson('is-arm-a-', BARE_INPUT)], store);
    const blocker = captured.trim();

    captured = '';
    const code = await runIssueStore(
      [
        'create',
        '--input',
        writeJson('is-arm-b-', {
          ...BARE_INPUT,
          filingHint: 'workstream-b',
          blockedBy: [{ issue: Number(blocker) }],
        }),
      ],
      store,
    );
    expect(code).toBe(0);
    const blocked = captured.trim();

    // the edge is native…
    expect(await api.getBlockedBy(Number(blocked))).toEqual([Number(blocker)]);
    // …and the filed issue is still bare: no labels, no managed body sections.
    const gh = await api.getIssue(Number(blocked));
    expect(gh.labels).toEqual([]);
    expect(gh.body).not.toMatch(/^##\s+Blocked by\s*$/im);
  });

  it('a BARE blockedBy the store cannot realize is a DOMAIN failure (exit 1) that files nothing', async () => {
    // The markdown store's only blocker representation IS the Header-Block line
    // a bare issue must not have, so it refuses. Exit 1, not 2: this layer's
    // store-agnostic pre-check cannot know a store's capability, so the refusal
    // arrives as "the store threw" — the documented meaning of exit 1.
    const store = tmpStore();
    const p = writeJson('is-arm-md-', {
      ...BARE_INPUT,
      blockedBy: [{ issue: 1 }],
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(1);

    captured = '';
    await runIssueStore(['listOpen'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
  });

  it('read on a bare issue is a domain failure (exit 1) — never a fabricated empty view', async () => {
    const store = tmpStore();
    await runIssueStore(['create', '--input', writeJson('is-bare2-', BARE_INPUT)], store);
    const id = captured.trim();

    const code = await runIssueStore(['read', id], store);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  // ── #278: a bare create with no body content is rejected, loud ──────────────
  //
  // The defect this closes: a bare `--input` that forgot the Gap/Provenance
  // prose used to sail through `create` and file an issue with literally
  // nothing in its body. Ten dispositions from one wave's Disclosures all
  // landed on the tracker measuring 0 body chars this way. These specs are the
  // negative control (Convention 11): each ACCEPT variant below is the
  // BARE_INPUT shape (already covered above), and each REJECT variant removes
  // exactly the content the rule exists to require — proving it can fail, not
  // just that it always passes.
  //
  // #309: the RULE no longer lives here. `classifyCreateInput` owns it (its own
  // unit specs pin the typed `CreateInputError`; the conformance suite pins that
  // every store rejects the same way for a non-CLI caller). What these CLI cases
  // now measure is this layer's remaining job — the exit code and the message
  // the operator reads — which must be exactly what it was before the move.
  it('create rejects a BARE input with bodySections entirely ABSENT (exit 2, files nothing)', async () => {
    const store = tmpStore();
    const p = writeJson('is-nobody-', {
      title: 'Gate 8 ships inert',
      filingHint: 'gate-8-ships-inert',
      // no bodySections key at all
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(2);
    expect(errSpy).toHaveBeenCalled();

    captured = '';
    await runIssueStore(['listOpen'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
  });

  it('create rejects a BARE input with bodySections as an EMPTY array (exit 2, files nothing)', async () => {
    const store = tmpStore();
    const p = writeJson('is-emptybody-', {
      title: 'Gate 8 ships inert',
      filingHint: 'gate-8-ships-inert',
      bodySections: [],
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(2);
    expect(errSpy).toHaveBeenCalled();

    captured = '';
    await runIssueStore(['listOpen'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
  });

  it('create rejects a BARE input whose bodySections entries are all BLANK markdown (exit 2, files nothing)', async () => {
    const store = tmpStore();
    const p = writeJson('is-blankbody-', {
      title: 'Gate 8 ships inert',
      filingHint: 'gate-8-ships-inert',
      bodySections: [
        { heading: 'Gap', markdown: '   ' },
        { heading: 'Provenance', markdown: '' },
      ],
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(2);
    expect(errSpy).toHaveBeenCalled();

    captured = '';
    await runIssueStore(['listOpen'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
  });

  it('create accepts a BARE input with at least one non-blank bodySections entry (the accept path stays open)', async () => {
    const store = tmpStore();
    // one blank entry alongside one real one — the guard asks for AT LEAST ONE
    // non-blank section, not that every section carry content.
    const p = writeJson('is-mixedbody-', {
      title: 'Gate 8 ships inert',
      filingHint: 'gate-8-ships-inert',
      bodySections: [
        { heading: 'Gap', markdown: '   ' },
        { heading: 'Provenance', markdown: 'wave hardening, row 3, iteration 1.' },
      ],
    });
    const code = await runIssueStore(['create', '--input', p], store);
    expect(code).toBe(0);
    const id = captured.trim();
    expect(id.length).toBeGreaterThan(0);
    const triage = await store.readTriage(id);
    expect(triage.body).toContain('wave hardening, row 3, iteration 1.');
  });

  it('the bare-no-body rejection keeps its message quality on stderr (the CLI renders it)', async () => {
    // The layer move (#309) is only honest if the operator-facing text survives
    // it: the message must still name the field to supply and what would
    // otherwise be filed, not degrade to a generic "invalid input".
    const store = tmpStore();
    const p = writeJson('is-msg-', {
      title: 'Gate 8 ships inert',
      filingHint: 'gate-8-ships-inert',
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(2);

    const stderr = (errSpy.mock.calls as unknown[][]).map((c) => String(c[0])).join('');
    expect(stderr).toContain('bodySections');
    expect(stderr).toContain('no body at all');
    expect(stderr).toContain('Header-Block');
    // …and it is rendered as a USAGE error (the usage banner rides along),
    // which is what exit 2 promises.
    expect(stderr).toContain('usage: issue-store');
  });

  it('create with a HALF-WRITTEN Header-Block is a usage error (exit 2) and files nothing', async () => {
    const store = tmpStore();
    // risk supplied, the rest of the block missing — neither bare nor decorated.
    const p = writeJson('is-partial-', {
      title: 'Half a header',
      filingHint: 'half-a-header',
      risk: 'mechanical',
    });
    expect(await runIssueStore(['create', '--input', p], store)).toBe(2);
    expect(errSpy).toHaveBeenCalled();

    captured = '';
    await runIssueStore(['listOpen'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
    captured = '';
    await runIssueStore(['listClaimed'], store);
    expect(JSON.parse(captured) as IssueView[]).toHaveLength(0);
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

// ─── issue #505 — every usage error teaches the complete first lesson ───────
//
// The motivating misfires (2026-08-13 coordination session): `triage-apply`'s
// `{state, category, comment}` input shape was discoverable only by reading
// `contract.ts`, and a wrong/missing flag on a KNOWN op used to answer with the
// full nineteen-op dump rather than that op's own contract. These specs prove
// both AC1 (the inline worked-example shape) and AC3 (per-op contract, not the
// full dump) actually fire — none of this is new BEHAVIOUR (exit codes are
// unchanged, pinned above), only the stderr TEXT a caller reads.

describe('issue-store-cli — usage errors teach the op\'s own contract (issue #505)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderr += chunk.toString();
        return true;
      });
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  // ── AC1 — the inline input-shape worked example (≤6 lines) ─────────────────

  it('triage-apply without --input shows its OWN {state, category, comment} shape inline — the reference case', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['triage-apply', 'x#01'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('"state"');
    expect(stderr).toContain('"category"');
    expect(stderr).toContain('"comment"');
    // The whole contract section (error line included) is a compact worked
    // example, not a source-code hunt.
    expect(stderr.trim().split('\n').length).toBeLessThanOrEqual(6);
  });

  it('create without --input shows the bare CreateInput shape inline ({title, filingHint, bodySections})', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['create'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('"title"');
    expect(stderr).toContain('"filingHint"');
    expect(stderr).toContain('"bodySections"');
  });

  it("create's contract documents the WIDENED bare shape — the optional blockedBy arm and how it is realized", async () => {
    // AC5 of the ADR-0044 arm: the shape a caller has to compose is the one this
    // op teaches. Before the arm, `blockedBy` appeared only on the decorated
    // line, so a caller reading this contract would have concluded a bare issue
    // cannot carry a dependency at all — which was true, and is not any more.
    const code = await runIssueStore(['create'], tmpStore());

    expect(code).toBe(2);
    const bareArm = stderr
      .split('\n')
      .find((l) => l.includes('bare MAY also add'));
    expect(bareArm).toBeDefined();
    expect(bareArm).toContain('"blockedBy"');
    expect(bareArm).toMatch(/natively/);
    expect(bareArm).toMatch(/no Header-Block written/);
  });

  it('annotate without --patch shows the AnnotatePatch shape inline', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['annotate', 'x#01'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('"risk"');
    expect(stderr).toContain('"worker"');
    expect(stderr).toContain('"bodySections"');
  });

  it('amend without --patch shows the AmendPatch shape inline', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['amend', 'x#01'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('"sections"');
  });

  it('publishDocument without --input shows the PublishDocumentInput shape inline', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['publishDocument'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('"title"');
    expect(stderr).toContain('"bodySections"');
  });

  it('flag without --kind shows a worked full-invocation example (its "input" is flags, not a file)', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['flag', 'x#01'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('--kind recoverable-stop');
    expect(stderr).toContain('--option');
  });

  // ── AC3 — a known op's usage error names only ITS OWN contract, never the
  //         full multi-op dump; the full dump survives for an unknown op ──────

  it("a KNOWN op's usage error names only that op — sibling op names are absent", async () => {
    const store = tmpStore();
    const code = await runIssueStore(['triage-apply', 'x#01'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('triage-apply');
    // Sibling op names that the FULL dump would list must be absent — this is
    // the tell that distinguishes "this op's contract" from "the whole list".
    expect(stderr).not.toContain('publishDocument');
    expect(stderr).not.toContain('triage-close');
    expect(stderr).not.toContain('clear-flag');
    expect(stderr).not.toContain('parse-ref');
  });

  it('an UNKNOWN op still gets the full dump — every op name present', async () => {
    const store = tmpStore();
    const code = await runIssueStore(['frobnicate'], store);

    expect(code).toBe(2);
    expect(stderr).toContain('create');
    expect(stderr).toContain('triage-apply');
    expect(stderr).toContain('publishDocument');
    expect(stderr).toContain('clear-flag');
  });

  it('a missing op ALSO gets the full dump — there is no op yet to narrow by', async () => {
    const store = tmpStore();
    const code = await runIssueStore([], store);

    expect(code).toBe(2);
    expect(stderr).toContain('create');
    expect(stderr).toContain('clear-flag');
  });

  // ── AC4 — each op's usage line states its output format ────────────────────

  it('a text-output op (create) states its plain-text output; a JSON op (read) states "as JSON"', async () => {
    await runIssueStore(['create'], tmpStore());
    expect(stderr).toMatch(/plain text \(not JSON\)/);

    stderr = '';
    await runIssueStore(['read'], tmpStore());
    expect(stderr).toMatch(/as JSON/);
    expect(stderr).not.toContain('plain text');
  });

  it('a no-stdout-on-success op (annotate) says so, distinguishing it from the JSON ops', async () => {
    await runIssueStore(['annotate', 'x#01'], tmpStore());
    expect(stderr).toMatch(/nothing on success/);
  });
});

// ─── issue #650 — the unknown-op full dump now lists every op, one per line ──
//
// Convention 11 falsification for this block: comment out the `'ops:'`
// block in issue-store-cli.ts's `usage()` (leaving only the pre-existing
// `usage: ${FULL_OP_LIST}` line) and this test fails — the per-op search
// below finds zero matches for every registered op, since none of their own
// `OP_CONTRACT[op][0]` usage lines are printed anywhere. Restoring the block
// makes it pass again. See this row's report for the observed failing output.

describe('issue-store-cli — unknown op prints the full op list, one line per op (issue #650)', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let stderr: string;

  beforeEach(() => {
    stderr = '';
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderr += chunk.toString();
        return true;
      });
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('every registered op appears exactly once, each on its own line naming its own usage, and the exit code is unchanged', async () => {
    const code = await runIssueStore(['definitely-bogus-op'], tmpStore());
    expect(code).toBe(2);

    // Ground truth roster: parsed off the PRE-EXISTING `usage: issue-store
    // <op1|op2|...> [...args] [--config <path>]` line itself — never a
    // second, hand-typed roster in this spec that could drift from
    // `FULL_OP_LIST` / `OP_CONTRACT`.
    const usageLine = stderr
      .split('\n')
      .find((l) => l.startsWith('usage: issue-store <'));
    expect(usageLine, 'the pre-existing full usage line must survive byte-for-byte').toBeDefined();
    const ops = usageLine!
      .slice(usageLine!.indexOf('<') + 1, usageLine!.indexOf('>'))
      .split('|');
    expect(ops.length).toBeGreaterThan(20); // sanity: this is the real, long roster

    const lines = stderr.split('\n');
    for (const op of ops) {
      const matches = lines.filter((l) => l.trim().startsWith(`usage: issue-store ${op} `));
      expect(matches, `expected exactly one usage line for op "${op}"`).toHaveLength(1);
    }
  });

  it('a missing op ALSO gets the per-op list — there is no op yet to narrow by', async () => {
    const code = await runIssueStore([], tmpStore());
    expect(code).toBe(2);
    expect(stderr).toContain('usage: issue-store create ');
    expect(stderr).toContain('usage: issue-store goal-publish-update ');
  });

  it("a KNOWN op's usage error is UNCHANGED — no per-op list leaks into its own contract section", async () => {
    const code = await runIssueStore(['triage-apply', 'x#01'], tmpStore());
    expect(code).toBe(2);
    // triage-apply's own contract is a handful of lines; the full 26-op list
    // would blow well past that.
    expect(stderr.trim().split('\n').length).toBeLessThanOrEqual(6);
    expect(stderr).not.toContain('ops:');
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

  it('closed-unknown path: read-closing reports the fourth outcome through the CLI (closed, NO PR evidence — never a rejection)', async () => {
    // W2-F1c: a row that resolved to done outside flotilla (a foreign-id mention,
    // a hand-close) has no PR evidence either way. The CLI must surface the fourth
    // ClosingState so the done-reconcile can REPORT it, never auto-flag it as a
    // rejected PR (which closed-unmerged is reserved for).
    const api = new InMemoryLinearApi();
    const store = new LinearIssuesStore({ api });
    const id = await store.create(linearInput());
    await store.transition(id, 'in-review');
    api.simulateCloseWithoutPrEvidence(id); // closed with no attachment at all

    captured = '';
    expect(await runIssueStore(['read-closing', id], store)).toBe(0);
    expect(JSON.parse(captured) as ClosingState).toMatchObject({ state: 'closed-unknown' });
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

// ── #399: `close` probes + reports the native end-state loudly ──────────────
// `close` is deliberately no-op-or-reconcile: it records the closing PR +
// cosmetic AC tick but does NOT natively close an issue whose satisfying act
// was not a merged PR carrying its own close phrase. Before this slice that
// gap was silent — exit 0, `Closed-by:` written, issue still OPEN — the exact
// shape #339 (1.0.0) and #397 (1.0.1) both hit and had to be rescued by hand
// (docs/RELEASING.md step 7). These specs exercise that shared shape on
// GitHubIssuesStore (the store both occurrences lived on): `close()` there
// never calls `nativeClose`, so a row whose satisfying act was never a
// merged-PR `Closes #N` stays open after the call — the same shape a
// release-bump PR that names no issue produces.
describe('issue-store-cli — close reports the native end-state loudly (#399)', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outCaptured: string;
  let errCaptured: string;

  beforeEach(() => {
    outCaptured = '';
    errCaptured = '';
    outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        outCaptured += chunk.toString();
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        errCaptured += chunk.toString();
        return true;
      });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  function ghInput(): CreateInput {
    return {
      title: 'A release-resolved issue',
      filingHint: 'release-resolved-issue',
      risk: 'mechanical',
      worker: 'background',
      files: ['tools/wave/src/issue-store-cli.ts'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'ships in the release', checked: false }],
    };
  }

  it('the #339/#397 shape: a satisfied-but-not-by-PR close prints the still-open state AND an unmistakable STILL OPEN line', async () => {
    const api = new InMemoryGitHubApi();
    const store = new GitHubIssuesStore({ api });
    const id = await store.create(ghInput());
    await store.transition(id, 'in-review');
    // No merged PR ever referenced this issue (mirrors a release-bump PR that
    // names no issue) — the issue stays open natively; GitHubIssuesStore's
    // close() never calls nativeClose().

    const code = await runIssueStore(
      ['close', id, 'https://github.com/o/r/pull/999'],
      store,
    );
    expect(code).toBe(0); // exit-code meaning unchanged (ADR-0035): still 0

    const printed = JSON.parse(outCaptured) as ClosingState;
    expect(printed.state).toBe('open'); // the JSON key naming the tracker state

    expect(errCaptured).toMatch(/STILL OPEN/);
    expect(errCaptured).toContain(id);
    expect(errCaptured).toContain('https://github.com/o/r/pull/999');
  });

  it('contrast — an ordinary merged-PR close reports `merged` and stays silent (no STILL OPEN line)', async () => {
    const api = new InMemoryGitHubApi();
    const store = new GitHubIssuesStore({ api });
    const id = await store.create(ghInput());
    await store.transition(id, 'in-review');
    const PR = 'https://github.com/o/r/pull/1';
    await api.setClosingPr(Number(id), { merged: true, url: PR });
    await api.nativeClose(Number(id)); // the merged PR's `Closes #N`, out of band

    const code = await runIssueStore(['close', id, PR], store);
    expect(code).toBe(0);

    const printed = JSON.parse(outCaptured) as ClosingState;
    expect(printed).toMatchObject({ state: 'merged', prUrl: PR });
    expect(errCaptured).not.toMatch(/STILL OPEN/);
  });
});

// ── the Goal facet ops (ADR-0044) ───────────────────────────────────────────
//
// The facet's own behaviour is proven across all three stores in
// `adapters/goal-facet.spec.ts`. This block pins the CLI CONTRACT the skills
// consume: which ops exist, what each prints, which exit code each returns, and
// — the load-bearing one — that a store which cannot resolve a container binding
// surfaces its refusal as a domain failure naming the config key, rather than
// being papered over at this layer.
describe('issue-store-cli — goal ops', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outCaptured: string;
  let errCaptured: string;

  beforeEach(() => {
    outCaptured = '';
    errCaptured = '';
    outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        outCaptured += chunk.toString();
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        errCaptured += chunk.toString();
        return true;
      });
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  function writeGoalInput(input: unknown): string {
    const p = join(mkdtempSync(join(tmpdir(), 'goal-in-')), 'goal.json');
    writeFileSync(p, JSON.stringify(input), 'utf-8');
    return p;
  }

  it('goal-create prints the opaque id as TEXT (not JSON), and goal-read round-trips it', async () => {
    const store = tmpStore();
    const p = writeGoalInput({
      title: '1.0.0',
      filingHint: 'one-oh-oh',
      description: 'the contract freeze',
    });

    expect(await runIssueStore(['goal-create', '--input', p], store)).toBe(0);
    const id = outCaptured.trim();
    expect(id.length).toBeGreaterThan(0);
    expect(() => JSON.parse(id)).toThrow(); // plain text, like `create`/`publishDocument`

    outCaptured = '';
    expect(await runIssueStore(['goal-read', id], store)).toBe(0);
    const goal = JSON.parse(outCaptured) as {
      id: string;
      title: string;
      description: string;
      container: string;
      memberIds: string[];
    };
    expect(goal).toMatchObject({
      id,
      title: '1.0.0',
      container: 'goal-file',
      memberIds: [],
    });
    expect(goal.description).toContain('the contract freeze');
  });

  it('goal-list prints GoalView[] as JSON', async () => {
    const store = tmpStore();
    const p = writeGoalInput({ title: 'g', filingHint: 'g' });
    await runIssueStore(['goal-create', '--input', p], store);
    outCaptured = '';

    expect(await runIssueStore(['goal-list'], store)).toBe(0);
    const goals = JSON.parse(outCaptured) as { title: string }[];
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe('g');
  });

  it('goal-assign curates a member in, printing NOTHING on success', async () => {
    const store = tmpStore();
    const issueInput = writeInput();
    await runIssueStore(['create', '--input', issueInput], store);
    const issueId = outCaptured.trim();
    outCaptured = '';
    await runIssueStore(['goal-create', '--input', writeGoalInput({ title: 'g', filingHint: 'g' })], store);
    const goalId = outCaptured.trim();
    outCaptured = '';

    expect(await runIssueStore(['goal-assign', goalId, issueId], store)).toBe(0);
    expect(outCaptured).toBe(''); // a mutation op, like transition/annotate

    await runIssueStore(['goal-read', goalId], store);
    expect((JSON.parse(outCaptured) as { memberIds: string[] }).memberIds).toEqual([issueId]);
  });

  it('goal-create-member mints a BARE member, joins it, and prints its id as TEXT', async () => {
    // The cut pass's one-call write path (ADR-0045 decision 3). Three claims in
    // one run, because any two without the third would pass while the verb was
    // still broken: the id is printed, the member IS in the goal, and the member
    // is bare (`unready`) rather than something a wave could draw.
    const store = tmpStore();
    const goalPath = writeGoalInput({ title: 'Ship it', filingHint: 'ship-it' });
    await runIssueStore(['goal-create', '--input', goalPath], store);
    const goalId = outCaptured.trim();
    outCaptured = '';

    const memberPath = writeGoalInput({
      title: 'a workstream that must exist',
      filingHint: 'a-workstream',
      bodySections: [{ heading: 'Gap', markdown: 'the shape is not known yet.' }],
    });
    expect(await runIssueStore(['goal-create-member', goalId, '--input', memberPath], store)).toBe(
      0,
    );
    const memberId = outCaptured.trim();
    expect(memberId.length).toBeGreaterThan(0);
    expect(memberId).not.toContain('{'); // TEXT, not JSON — same as create/goal-create
    outCaptured = '';

    await runIssueStore(['goal-read', goalId], store);
    expect((JSON.parse(outCaptured) as { memberIds: string[] }).memberIds).toEqual([memberId]);
    outCaptured = '';

    await runIssueStore(['goal-frontier', goalId], store);
    const frontier = JSON.parse(outCaptured) as { readings: { id: string; state: string }[] };
    expect(frontier.readings).toEqual([
      { id: memberId, state: 'unready', unresolvedBlockers: [] },
    ]);
  });

  it('goal-create-member rejects a malformed/incomplete input as a USAGE error, minting nothing', async () => {
    const store = tmpStore();
    const goalPath = writeGoalInput({ title: 'g', filingHint: 'g' });
    await runIssueStore(['goal-create', '--input', goalPath], store);
    const goalId = outCaptured.trim();
    outCaptured = '';

    const bad = join(mkdtempSync(join(tmpdir(), 'goal-member-bad-')), 'x.json');
    writeFileSync(bad, '{ not json', 'utf-8');
    expect(await runIssueStore(['goal-create-member', goalId, '--input', bad], store)).toBe(2);

    errCaptured = '';
    expect(
      await runIssueStore(
        ['goal-create-member', goalId, '--input', writeGoalInput({ filingHint: 'x' })],
        store,
      ),
    ).toBe(2);
    expect(errCaptured).toContain('title');

    errCaptured = '';
    expect(
      await runIssueStore(
        ['goal-create-member', goalId, '--input', writeGoalInput({ title: 'x' })],
        store,
      ),
    ).toBe(2);
    expect(errCaptured).toContain('filingHint');

    // …and none of the three refusals filed anything.
    outCaptured = '';
    await runIssueStore(['goal-read', goalId], store);
    expect((JSON.parse(outCaptured) as { memberIds: string[] }).memberIds).toEqual([]);
  });

  it('goal-create-member surfaces a store REFUSAL as a domain failure (exit 1), not a usage error', async () => {
    // A bodyless member is `classifyCreateInput`'s rule, not the CLI's — the
    // runner deliberately does not restate it, so the refusal arrives from the
    // store. Exit 1 is the honest code: the store threw.
    const store = tmpStore();
    const goalPath = writeGoalInput({ title: 'g', filingHint: 'g' });
    await runIssueStore(['goal-create', '--input', goalPath], store);
    const goalId = outCaptured.trim();
    outCaptured = '';
    errCaptured = '';

    expect(
      await runIssueStore(
        [
          'goal-create-member',
          goalId,
          '--input',
          writeGoalInput({ title: 'x', filingHint: 'x', bodySections: [] }),
        ],
        store,
      ),
    ).toBe(1);
    expect(outCaptured).toBe('');
  });

  it('goal-frontier prints the full reading — states, counts, the open remainder, and `complete`', async () => {
    const store = tmpStore();
    await runIssueStore(['create', '--input', writeInput()], store);
    const issueId = outCaptured.trim();
    outCaptured = '';
    await runIssueStore(['goal-create', '--input', writeGoalInput({ title: 'g', filingHint: 'g' })], store);
    const goalId = outCaptured.trim();
    await runIssueStore(['goal-assign', goalId, issueId], store);
    outCaptured = '';

    expect(await runIssueStore(['goal-frontier', goalId], store)).toBe(0);
    const frontier = JSON.parse(outCaptured) as {
      goalId: string;
      readings: { id: string; state: string }[];
      counts: Record<string, number>;
      open: { id: string }[];
      complete: boolean;
    };
    expect(frontier.goalId).toBe(goalId);
    expect(frontier.readings).toEqual([
      { id: issueId, state: 'actionable', unresolvedBlockers: [] },
    ]);
    expect(frontier.counts.actionable).toBe(1);
    expect(frontier.open.map((r) => r.id)).toEqual([issueId]);
    expect(frontier.complete).toBe(false);
  });

  // ── goal-publish-update: the mirror pass at the CLI (ADR-0046) ─────────────

  it('goal-publish-update REFUSES on a store whose container has no update surface', async () => {
    // The markdown store's goal file has no timeline. A domain failure (exit 1)
    // naming the config key — the caller's INPUT is fine, the binding cannot
    // carry this pass.
    const store = tmpStore();
    await runIssueStore(
      ['goal-create', '--input', writeGoalInput({ title: 'g', filingHint: 'g' })],
      store,
    );
    const goalId = outCaptured.trim();
    outCaptured = '';

    expect(await runIssueStore(['goal-publish-update', goalId], store)).toBe(1);
    expect(errCaptured).toContain('store.goal.container');
    expect(outCaptured).toBe(''); // nothing published, nothing printed
  });

  it('goal-publish-update prints the receipt, with an anchor no flag could have supplied', async () => {
    const store = new ProjectBoundLinearStore({ api: new InMemoryLinearApi() });
    const goalId = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'project');
    outCaptured = '';

    // No `--input` at all: an anchor-only update is a complete artifact, so the
    // flag is how a caller ADDS prose rather than how it satisfies the op.
    expect(await runIssueStore(['goal-publish-update', goalId], store)).toBe(0);
    const receipt = JSON.parse(outCaptured) as {
      goalId: string;
      container: string;
      updateId: string;
      body: string;
      frontier: { goalId: string };
    };
    expect(receipt.goalId).toBe(goalId);
    expect(receipt.container).toBe('project');
    expect(receipt.updateId).toBeTruthy();
    // The engine-owned half is present although the caller supplied nothing —
    // and there is no flag on this op that could have supplied, edited or
    // omitted it.
    expect(receipt.body).toContain('## Frontier');
    expect(receipt.frontier.goalId).toBe(goalId);
  });

  it('goal-publish-update carries a narrative and a transcribed health from --input', async () => {
    const store = new ProjectBoundLinearStore({ api: new InMemoryLinearApi() });
    const goalId = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'project');
    const p = join(mkdtempSync(join(tmpdir(), 'goal-upd-')), 'input.json');
    writeFileSync(
      p,
      JSON.stringify({ narrative: 'Cut the branch on Tuesday.', health: 'onTrack' }),
      'utf-8',
    );
    outCaptured = '';

    expect(
      await runIssueStore(['goal-publish-update', goalId, '--input', p], store),
    ).toBe(0);
    const receipt = JSON.parse(outCaptured) as { body: string; health?: string };
    expect(receipt.health).toBe('onTrack');
    // Prose ABOVE the anchor, in that order.
    expect(receipt.body.indexOf('Cut the branch on Tuesday.')).toBeLessThan(
      receipt.body.indexOf('## Frontier'),
    );
  });

  it('goal-publish-update rejects a malformed --input as a USAGE error, publishing nothing', async () => {
    const store = new ProjectBoundLinearStore({ api: new InMemoryLinearApi() });
    const goalId = await store.createGoal({ title: 'Ship it', filingHint: 'ship' }, 'project');
    const bad = join(mkdtempSync(join(tmpdir(), 'goal-upd-bad-')), 'x.json');
    writeFileSync(bad, '{ not json', 'utf-8');
    outCaptured = '';

    expect(
      await runIssueStore(['goal-publish-update', goalId, '--input', bad], store),
    ).toBe(2);
    expect(outCaptured).toBe('');
  });

  it('a store that cannot resolve a binding fails as a DOMAIN failure naming the config key', async () => {
    // Linear has no default container, so an unbound goal op must surface the
    // refusal rather than have the CLI quietly choose one. Exit 1 (the store
    // threw), never exit 0 and never a usage error — the caller's INPUT is fine;
    // the repo's configuration is what is missing.
    const store = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    const p = writeGoalInput({ title: 'g', filingHint: 'g' });

    expect(await runIssueStore(['goal-create', '--input', p], store)).toBe(1);
    expect(errCaptured).toContain('store.goal.container');
    expect(outCaptured).toBe(''); // nothing minted, nothing printed

    // …and the SAME store with the binding declared works, so the failure above
    // is about the missing binding and not about the store being unusable.
    errCaptured = '';
    const bound = new LinearIssuesStore({ api: new InMemoryLinearApi() });
    expect(await bound.createGoal({ title: 'g', filingHint: 'g' }, 'project')).toBeTruthy();
  });

  it('every goal op teaches ITS OWN contract on a usage error, never the full op list', async () => {
    const store = tmpStore();
    for (const [args, marker] of [
      [['goal-create'], 'goal-create --input'],
      [['goal-read'], 'goal-read <goalId>'],
      // `<memberId>`, not `<issueId>`: the member kind follows the binding
      // (ADR-0045), and the usage line is where a caller finds that out.
      [['goal-assign'], 'goal-assign <goalId> <memberId>'],
      [['goal-create-member'], 'goal-create-member <goalId> --input'],
      [['goal-create-member', 'g1'], 'goal-create-member <goalId> --input'],
      [['goal-frontier'], 'goal-frontier <goalId>'],
    ] as [string[], string][]) {
      errCaptured = '';
      expect(await runIssueStore(args, store)).toBe(2);
      expect(errCaptured).toContain(marker);
      // the per-op section, not the nineteen-op dump (issue #505).
      expect(errCaptured).not.toContain('publishDocument|readDocument');
    }
  });

  it('goal-create rejects a malformed input file, and an input missing title/filingHint, as USAGE errors', async () => {
    const store = tmpStore();
    const bad = join(mkdtempSync(join(tmpdir(), 'goal-bad-')), 'x.json');
    writeFileSync(bad, '{ not json', 'utf-8');
    expect(await runIssueStore(['goal-create', '--input', bad], store)).toBe(2);

    expect(
      await runIssueStore(['goal-create', '--input', writeGoalInput({ filingHint: 'g' })], store),
    ).toBe(2);
    expect(errCaptured).toContain('title');

    errCaptured = '';
    expect(
      await runIssueStore(['goal-create', '--input', writeGoalInput({ title: 'g' })], store),
    ).toBe(2);
    expect(errCaptured).toContain('filingHint');
  });

  it('an unknown goal id is a DOMAIN failure (exit 1), not a usage error', async () => {
    const store = tmpStore();
    expect(await runIssueStore(['goal-read', 'nope'], store)).toBe(1);
    expect(await runIssueStore(['goal-frontier', 'nope'], store)).toBe(1);
  });

  it('there is NO goal-close op and NO goal-dispatch op — an unknown op, not a hidden one', async () => {
    // ADR-0044 decisions 5 and 6, at the CLI: the runner must not have quietly
    // grown a completion or execution verb. `unknown op` is the answer, and the
    // full op list is what the caller gets, since they have not named a contract.
    const store = tmpStore();
    for (const op of ['goal-close', 'goal-complete', 'goal-dispatch', 'goal-start']) {
      errCaptured = '';
      expect(await runIssueStore([op, 'x'], store)).toBe(2);
      expect(errCaptured).toContain(`unknown op "${op}"`);
    }
    // Non-vacuity: a REAL op does not answer `unknown op`.
    errCaptured = '';
    await runIssueStore(['goal-list'], store);
    expect(errCaptured).not.toContain('unknown op');
  });
});
