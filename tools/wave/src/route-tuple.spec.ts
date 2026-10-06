/**
 * route-tuple.spec.ts — every branch of the post-return sequence, driven end to
 * end against real durable state and injected host/store seams.
 *
 * The fixture is deliberately REAL where realness is the point and injected
 * where the network is: a real spine file on disk (so the two spine writes are
 * observed as bytes, not as calls), real sidecar files under a real reports/
 * verdicts pair (so the presence-and-validation step is exercised by the same
 * reader `resume` uses), a real {@link MarkdownFsStore} (so the rung transition
 * and its read-back are the store's own semantics, not a stub's), and injected
 * `HttpProbe` + `LandingHost` fakes for the two host questions.
 *
 * Three properties get the most attention, because each is a place a hand-run
 * sequence has actually gone wrong:
 *
 *  1. **The routing derivations.** `--state` for the reviewer phase is
 *     verdict-keyed, not iteration-keyed, and getting that backwards turns a
 *     second-round approve into a silent noop. Both halves of both derivations
 *     are pinned directly, and the four verdict/iteration cells are driven
 *     through the whole verb as well.
 *  2. **Idempotence, step by step.** A second run must reuse the open PR, must
 *     not stack a second verdict section into its body, and must not re-transition
 *     a rung already at `in-review` — each reported as `performed-before`, never
 *     as an error.
 *  3. **Nothing is written before the sequence has an answer.** Every refusal
 *     asserts the spine is byte-identical and the tracker rung unmoved, which is
 *     the property the write-ahead order exists to give.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composePrBody,
  resolveTitle,
  reviewerStateForVerdict,
  runRouteTuple,
  workerStateForIteration,
  workerSummaryFromBody,
  type RouteTupleDeps,
  type StepResult,
} from './route-tuple';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import { MarkdownFsStore } from './adapters/markdown-fs-store';
import type { IssueStore } from './adapters/issue-store';
import { stripBareIds } from './compose-driver';
import { renderSidecarBody } from './route-cli';
import { readDisclosures } from './spine-store';
import { readSpine, renderSpine, setRowState, upsertDispatchLogEntry } from './wave-md-rw';
import type {
  Creds,
  HttpProbe,
  HttpRequest,
  HttpResponse,
  LandingHost,
  PrLandingStatus,
} from './host-pr';
import type { ReviewerVerdict } from './reviewer-verdict-schema';
import type { WorkerReport } from './worker-report-schema';

// ─── fixtures ─────────────────────────────────────────────────────────────────

const SLUG = 'route-tuple-wave';
const REMOTE = 'https://github.com/example-org/example-repo.git';
const EXISTING_PR = 'https://github.com/example-org/example-repo/pull/7';
const NEW_PR = 'https://github.com/example-org/example-repo/pull/8';
const ANCHOR = 'a'.repeat(40);
const CREDS: Creds = { auth: 'x-access-token:test-token' };
/**
 * The Operator's stated reason for a Reviewer-only round above the cap, shaped
 * like the ones the two live occurrences produced. It is a SENTENCE on purpose:
 * a bare token is refused, which is what keeps a ruled round from being
 * something a script can mint.
 */
const RULING =
  'Operator ruling 03:50 — the throwaway repository was deleted; re-dispatch the Reviewer only.';

function report(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    outcome: 'done',
    issue: 'PLACEHOLDER',
    branch: 'PLACEHOLDER',
    commitShas: ['abc1234'],
    prUrl: EXISTING_PR,
    filesChanged: { new: 1, modified: 2, renamed: 0 },
    tests: '4161/4161 green',
    lint: 'clean',
    judgmentCalls: [],
    reviewerFocusItems: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: 'approve',
    branchReviewed: 'PLACEHOLDER',
    riskClass: 'mechanical',
    workerReportDigest: 'Worker reports 4161/4161 green, 0 judgment calls.',
    acVerification: [{ ac: 'the verb routes one tuple', met: 'met', evidence: 'src/route-tuple.ts:1' }],
    reviewerFocusItems: [],
    lintTestSummary: 'vitest 4161/4161, tsc clean',
    ...overrides,
  };
}

/** An injected HttpProbe over the three requests create-or-reuse can make. */
function fakeHttp(handlers: {
  get?: (url: string) => HttpResponse;
  post?: (url: string, body?: string) => HttpResponse;
  patch?: (url: string, body?: string) => HttpResponse;
}): { http: HttpProbe; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    http: {
      async request(req: HttpRequest): Promise<HttpResponse> {
        requests.push(req);
        if (req.method === 'GET') return handlers.get?.(req.url) ?? { status: 200, json: [] };
        if (req.method === 'PATCH') return handlers.patch?.(req.url, req.body) ?? { status: 200, json: {} };
        return handlers.post?.(req.url, req.body) ?? { status: 201, json: { html_url: NEW_PR } };
      },
    },
  };
}

/** An injected LandingHost answering only the one question this verb asks. */
function fakeLanding(status: PrLandingStatus): LandingHost {
  return {
    getPrStatus: async () => status,
    enableAutoMerge: async () => {
      throw new Error('route-tuple must never arm a PR');
    },
    mergePullRequest: async () => {
      throw new Error('route-tuple must never merge a PR');
    },
    deleteBranch: async () => {
      throw new Error('route-tuple must never delete a branch');
    },
  };
}

describe('route-tuple', () => {
  let repoRoot: string;
  let spinePath: string;
  let configPath: string;
  let reportsDir: string;
  let verdictsDir: string;
  let payloadDir: string;
  let id: string;
  let branch: string;
  let store: IssueStore;
  let stdout: string;
  let stderr: string;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Seed a wave: one issue in an in-memory GitHub store, a dispatched spine row
   * on disk, a config.
   *
   * The store is `GitHubIssuesStore` over `InMemoryGitHubApi` rather than the
   * markdown dogfood store for one load-bearing reason: its ids are the numeric
   * tracker ids the close phrase is built from (`Closes #1`), which is the only
   * shape `host-pr`'s close-phrase guard recognises as a phrase at all. A
   * fixture whose composed phrase the guard cannot see would make every reuse
   * assertion below a test of the wrong thing.
   *
   * `markdown: true` swaps in the real dogfood store instead, for the one
   * property only its id shape can exercise: a `<slug>#NN` id is the compound
   * shape `closePhraseFor` has to lift the numeric tail out of before the guard
   * can see the phrase at all.
   */
  async function seed(opts: { markdown?: boolean } = {}): Promise<void> {
    store = opts.markdown
      ? new MarkdownFsStore({ repoRoot, slug: SLUG })
      : new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
    id = await store.create({
      title: 'Route one returned tuple in one call',
      filingHint: 'route-tuple-verb',
      risk: 'mechanical',
      worker: 'background',
      files: ['tools/wave/**'],
      blockedBy: 'none',
      acceptanceCriteria: [{ text: 'the verb routes one tuple', checked: false }],
      bodySections: [{ heading: 'What to build', markdown: 'The verb.' }],
    });
    await store.transition(id, 'in-flight');
    branch = `wave/${id}-route-tuple-verb`;

    let spine = renderSpine(
      {
        slug: SLUG,
        description: 'route',
        coordinator: 'c',
        model: 'm',
        created: '2026-09-03',
        lastUpdated: '2026-09-03',
      },
      [{ id, title: 'Route one returned tuple in one call', worker: 'background', risk: 'mechanical' }],
      { issues: [], cells: [] },
      'ok',
    );
    spine = setRowState(spine, id, 'reviewing');
    spine = upsertDispatchLogEntry(spine, id, branch);

    mkdirSync(join(repoRoot, '.flotilla', 'waves'), { recursive: true });
    spinePath = join(repoRoot, '.flotilla', 'waves', `${SLUG}.md`);
    writeFileSync(spinePath, spine, 'utf8');

    reportsDir = join(repoRoot, '.flotilla', 'waves', SLUG, 'reports');
    verdictsDir = join(repoRoot, '.flotilla', 'waves', SLUG, 'verdicts');
    payloadDir = join(repoRoot, '.flotilla', 'tmp', SLUG);
    mkdirSync(payloadDir, { recursive: true });

    configPath = join(repoRoot, 'wave.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        store: opts.markdown ? { kind: 'markdown', repoRoot, slug: SLUG } : { kind: 'github' },
        engine: { cli: './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts' },
      }),
      'utf8',
    );
  }

  /** Put a report + verdict on disk as sidecars AND as the raw tuple payloads. */
  function landTuple(iter: number, r: WorkerReport, v: ReviewerVerdict): void {
    const filledReport: WorkerReport = { ...r, issue: id, branch };
    const filledVerdict: ReviewerVerdict = { ...v, branchReviewed: branch };
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, `${id}-${iter}.md`),
      renderSidecarBody('WorkerReport', id, iter, filledReport),
      'utf8',
    );
    writeFileSync(
      join(verdictsDir, `${id}-${iter}.md`),
      renderSidecarBody('ReviewerVerdict', id, iter, filledVerdict),
      'utf8',
    );
    writePayloads(filledReport, filledVerdict);
  }

  /** Write only the raw tuple payloads — the recovery inputs, no sidecars. */
  function writePayloads(r: WorkerReport, v: ReviewerVerdict): void {
    writeFileSync(join(payloadDir, 'report.json'), JSON.stringify(r), 'utf8');
    writeFileSync(join(payloadDir, 'verdict.json'), JSON.stringify(v), 'utf8');
  }

  function argv(iter: number, extra: string[] = []): string[] {
    return [
      '--spine',
      spinePath,
      '--id',
      id,
      '--iter',
      String(iter),
      '--report',
      join(payloadDir, 'report.json'),
      '--verdict',
      join(payloadDir, 'verdict.json'),
      '--anchor',
      ANCHOR,
      '--config',
      configPath,
      '--repo-root',
      repoRoot,
      '--remote',
      REMOTE,
      ...extra,
    ];
  }

  function deps(over: Partial<RouteTupleDeps> = {}): RouteTupleDeps {
    return { creds: CREDS, store, ...over };
  }

  const result = (): Record<string, unknown> => JSON.parse(stdout) as Record<string, unknown>;
  const steps = (): StepResult[] => result().steps as StepResult[];
  const step = (name: string): StepResult | undefined => steps().find((s) => s.step === name);
  const spineSource = (): string => readFileSync(spinePath, 'utf8');
  const rungOf = async (): Promise<string> => (await store.read(id)).status;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'route-tuple-'));
    stdout = '';
    stderr = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      stdout += String(c);
      return true;
    });
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  // ── the pure derivations ───────────────────────────────────────────────────

  describe('the two --state derivations (the shell arithmetic this verb retires)', () => {
    it('the worker phase is ITERATION-keyed', () => {
      expect(workerStateForIteration(1)).toBe('dispatched');
      expect(workerStateForIteration(2)).toBe('re-dispatched');
    });

    it('the reviewer phase is VERDICT-keyed — `re-dispatched` for a 2nd changes-requested and NOTHING else', () => {
      // The one cell the cap-exhaustion STOP is reachable from…
      expect(reviewerStateForVerdict('changes-requested', 2)).toBe('re-dispatched');
      // …and every other cell, including the approve at iteration 2 that an
      // iteration-keyed derivation would silently route into a noop.
      expect(reviewerStateForVerdict('changes-requested', 1)).toBe('reviewing');
      expect(reviewerStateForVerdict('approve', 1)).toBe('reviewing');
      expect(reviewerStateForVerdict('approve', 2)).toBe('reviewing');
      expect(reviewerStateForVerdict('questions-blocking', 1)).toBe('reviewing');
      expect(reviewerStateForVerdict('questions-blocking', 2)).toBe('reviewing');
    });
  });

  describe('PR-body composition', () => {
    it('keeps the Worker summary, drops the section this verb owns, and drops the close phrase with it', () => {
      const live = [
        'Lifted the create-or-reuse decision into the library.',
        '',
        'Semver: minor.',
        '',
        '## Reviewer verdict',
        '',
        '**Verdict:** approve (iteration 1)',
        '',
        'Closes #681',
      ].join('\n');
      expect(workerSummaryFromBody(live)).toBe(
        'Lifted the create-or-reuse decision into the library.\n\nSemver: minor.',
      );
    });

    it('a body with no verdict section is its own summary, minus the close phrase', () => {
      expect(workerSummaryFromBody('Did the thing.\n\nFixes EX-9\n')).toBe('Did the thing.');
    });

    it('composes summary → verdict → close phrase, with the phrase on the LAST line', () => {
      const body = composePrBody({
        summary: 'Summary.',
        verdictSection: '## Reviewer verdict\n\n**Verdict:** approve (iteration 1)',
        closePhrase: 'Closes #681',
      });
      expect(body.split('\n').at(-1)).toBe('Closes #681');
      expect(body.indexOf('Summary.')).toBeLessThan(body.indexOf('## Reviewer verdict'));
    });
  });

  // ── resolveTitle: the three-way precedence, pinned directly (issue #743) ───
  //
  // Everywhere else in this file the precedence is only OBSERVABLE through the
  // full `runRouteTuple` sequence — real host I/O, a real spine, a real
  // sidecar pair — which pins the OUTCOME of each cell but pays for it with the
  // whole apparatus around it. `resolveTitle` is exported precisely so the
  // RULE itself is pinnable in isolation (see its own doc comment), and until
  // this row nothing did: a swap in the precedence ladder was only ever caught
  // as a side effect of an end-to-end assertion elsewhere, never named as the
  // thing under test. These four pin exactly the three cells the catalog line
  // and route-tuple's own usage text both describe, plus the fact that the
  // result always NAMES which cell fired.
  describe('resolveTitle — the three-way precedence the catalog and usage text both describe', () => {
    const ROW_TITLE = 'Route one returned tuple in one call';
    const ID = '743';

    it('the flag RENAMES — --title wins even over a present, non-empty live title', () => {
      const result = resolveTitle({
        args: ['--title', 'The Coordinator means to rename this'],
        existing: { url: EXISTING_PR, title: 'The Worker\'s own live title' },
        rowTitle: ROW_TITLE,
        id: ID,
      });
      expect(result).toEqual({
        title: 'The Coordinator means to rename this',
        titleSource: 'flag',
      });
    });

    it('a REUSE without --title preserves the live PR title BYTE-IDENTICALLY — no trim, no strip', () => {
      // Trailing whitespace on purpose, exactly as the end-to-end sibling test
      // above does: byte-identical means untouched, not re-normalised.
      const liveTitle = 'The Worker\'s own one-line account of this change  ';
      const result = resolveTitle({
        args: [],
        existing: { url: EXISTING_PR, title: liveTitle },
        rowTitle: ROW_TITLE,
        id: ID,
      });
      expect(result).toEqual({ title: liveTitle, titleSource: 'live-pr' });
    });

    it('a CREATE without --title falls back to the row title with bare tracker ids stripped', () => {
      const rowTitleWithId = `Fix the flaky thing (#${ID})`;
      const result = resolveTitle({
        args: [],
        existing: null,
        rowTitle: rowTitleWithId,
        id: ID,
      });
      const expectedTitle = stripBareIds(rowTitleWithId, ID);
      // The fixture is only a meaningful pin if the strip actually changes
      // something — otherwise "falls back to the stripped row title" and
      // "falls back to the row title, unstripped" would look identical here.
      expect(expectedTitle).not.toBe(rowTitleWithId);
      expect(expectedTitle).not.toContain(ID);
      expect(result).toEqual({ title: expectedTitle, titleSource: 'row' });
    });

    it('the result NAMES which of the three cells fired, for all three', () => {
      expect(
        resolveTitle({ args: ['--title', 'x'], existing: null, rowTitle: ROW_TITLE, id: ID })
          .titleSource,
      ).toBe('flag');
      expect(
        resolveTitle({
          args: [],
          existing: { url: EXISTING_PR, title: 'y' },
          rowTitle: ROW_TITLE,
          id: ID,
        }).titleSource,
      ).toBe('live-pr');
      expect(
        resolveTitle({ args: [], existing: null, rowTitle: ROW_TITLE, id: ID }).titleSource,
      ).toBe('row');
    });

    it('a title read from --title-file occupies the flag rung — it outranks the live title (issue #1065)', () => {
      expect(
        resolveTitle({
          args: [],
          existing: { url: EXISTING_PR, title: 'live' },
          rowTitle: ROW_TITLE,
          id: ID,
          titleFromFile: 'from the file',
        }),
      ).toEqual({ title: 'from the file', titleSource: 'flag' });
    });
  });

  // ── approve: the full terminator ───────────────────────────────────────────

  describe('approve → the full write-ahead sequence', () => {
    it('performs every step in the mechanics\' order and prints ONE JSON result', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const { http, requests } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );

      expect(stderr).toBe('');
      expect(code).toBe(0);
      // ONE JSON object on stdout, nothing else.
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(result()).toMatchObject({
        ok: true,
        verb: 'route-tuple',
        id,
        iter: 1,
        disposition: 'pr-created',
        branch,
        prUrl: NEW_PR,
      });

      // The order IS the assertion — start-mechanics 7.0 → 7c, verbatim.
      expect(steps().map((s) => s.step)).toEqual([
        'sidecar-check',
        'route-outcome',
        'route-verdict',
        'render-verdict',
        'pr-create-or-reuse',
        'pr-status',
        'spine-row-state',
        'spine-row-pr',
        'rung-transition',
      ]);
      expect(step('route-outcome')).toMatchObject({
        from: 'dispatched',
        event: 'worker-done',
        outcome: { type: 'transition', nextState: 'report-in' },
      });
      expect(step('route-verdict')).toMatchObject({
        from: 'reviewing',
        event: 'reviewer-approve',
        outcome: { type: 'transition', nextState: 'approved' },
      });
      expect(step('pr-create-or-reuse')).toMatchObject({ outcome: 'created', url: NEW_PR });
      expect(step('pr-status')).toMatchObject({ state: 'open', url: NEW_PR });

      // The durable writes actually landed, in the spine's own bytes…
      expect(spineSource()).toContain('pr-created');
      expect(spineSource()).toContain(NEW_PR);
      // …and on the tracker.
      expect(await rungOf()).toBe('in-review');
      // find-before-create: one GET, then the POST. Never two POSTs.
      expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    });

    it('the created PR body is digest → verdict section → close phrase, and the title carries no tracker id', async () => {
      await seed();
      landTuple(1, report(), verdict());
      let posted: Record<string, string> = {};
      const { http } = fakeHttp({
        get: () => ({ status: 200, json: [] }),
        post: (_url, body) => {
          posted = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 201, json: { html_url: NEW_PR } };
        },
      });
      await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      // No live body existed, so the verdict's own digest stands in as the summary.
      expect(posted.body.startsWith('Worker reports 4161/4161 green')).toBe(true);
      expect(posted.body).toContain('## Reviewer verdict');
      expect(posted.body.split('\n').at(-1)).toBe(`Closes #${id}`);
      expect(step('pr-create-or-reuse')).toMatchObject({
        summarySource: 'workerReportDigest',
        // The NEGATIVE CONTROL for the preserve-on-reuse rule: with no live PR
        // there is no live title, so the create path is exactly what it always
        // was — the spine row's title with bare ids stripped.
        titleSource: 'row',
      });
      expect(result()).toMatchObject({ titleSource: 'row' });
      expect(posted.title).toBe('Route one returned tuple in one call');
      expect(posted.title).not.toContain(id);
    });

    it('a Worker-opened PR is REUSED: its body becomes the summary, the verdict goes beneath it, no second PR', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const workerBody = `Lifted create-or-reuse into the library.\n\nSemver: minor.\n\nCloses #${id}`;
      let patched: Record<string, string> = {};
      const { http, requests } = fakeHttp({
        get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7, body: workerBody }] }),
        post: () => {
          throw new Error('a create POST must never fire when an open PR exists');
        },
        patch: (_url, body) => {
          patched = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR, number: 7 }) }),
      );

      expect(code).toBe(0);
      expect(step('pr-create-or-reuse')).toMatchObject({
        status: 'performed-before',
        outcome: 'reused',
        updated: true,
        summarySource: 'live-pr-body',
      });
      // The Worker's own summary survives, the verdict lands UNDER it, the phrase last.
      expect(patched.body.startsWith('Lifted create-or-reuse into the library.')).toBe(true);
      expect(patched.body).toContain('Semver: minor.');
      expect(patched.body).toContain('## Reviewer verdict');
      expect(patched.body.split('\n').at(-1)).toBe(`Closes #${id}`);
      // ONE find, ONE update — and the find is not paid for twice.
      expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
      expect(result().prUrl).toBe(EXISTING_PR);
      // This fixture's list response carries no `title`, which is "not readable
      // here" rather than "no title": the row title stands in, and says so.
      expect(step('pr-create-or-reuse')).toMatchObject({ titleSource: 'row' });
    });

    /**
     * The asymmetry this row exists to close: the live BODY was preserved on
     * reuse by acceptance criterion while the live TITLE was overwritten from
     * the spine row in the same call, so one change wore three titles (the
     * Worker's commit subject and PR title, this verb's row title, then the
     * Worker's again on the squash commit).
     *
     * The live title and the row title are deliberately DIFFERENT here — an
     * assertion against a fixture where they agree could not tell "preserved"
     * from "coincidentally rewritten to the same string".
     */
    it('a reuse WITHOUT --title preserves the live PR title byte-identically', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // Trailing whitespace on purpose: BYTE-identical means the host's own
      // string goes back unaltered, not a re-derived or re-normalised one. A
      // trim here would be a small silent edit of a Worker-authored title, and
      // "small silent edit" is the whole failure class this row removes.
      const workerTitle = 'The Worker\'s own one-line account of this change  ';
      const workerBody = `Lifted create-or-reuse into the library.\n\nCloses #${id}`;
      let patched: Record<string, string> = {};
      const { http } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, title: workerTitle, body: workerBody }],
        }),
        post: () => {
          throw new Error('a create POST must never fire when an open PR exists');
        },
        patch: (_url, body) => {
          patched = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR, number: 7 }) }),
      );

      expect(code).toBe(0);
      // The row title is a different string, and it is NOT what landed.
      expect(workerTitle).not.toBe('Route one returned tuple in one call');
      expect(patched.title).toBe(workerTitle);
      expect(result()).toMatchObject({ title: workerTitle, titleSource: 'live-pr' });
      expect(step('pr-create-or-reuse')).toMatchObject({ titleSource: 'live-pr' });
      // The body is still re-written from the composed render — the two halves
      // of the rule are preserve-title AND rewrite-body, not preserve-both.
      expect(patched.body).toContain('## Reviewer verdict');
      expect(patched.body.split('\n').at(-1)).toBe(`Closes #${id}`);
    });

    it('a reuse WITH --title takes the flag — the explicit override outranks the live title', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const workerTitle = 'The Worker\'s own one-line account of this change';
      const override = 'The title the Coordinator means to land';
      let patched: Record<string, string> = {};
      const { http } = fakeHttp({
        get: () => ({
          status: 200,
          json: [
            { html_url: EXISTING_PR, number: 7, title: workerTitle, body: `Live.\n\nCloses #${id}` },
          ],
        }),
        patch: (_url, body) => {
          patched = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1, ['--title', override]),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR, number: 7 }) }),
      );

      expect(code).toBe(0);
      expect(patched.title).toBe(override);
      expect(result()).toMatchObject({ title: override, titleSource: 'flag' });
      expect(step('pr-create-or-reuse')).toMatchObject({ titleSource: 'flag' });
    });

    // ── --title-file (issue #1065): the flag rung, read from a file ─────────
    //
    // The same semantics `host-pr create --title-file` has — both verbs call the
    // one shared reader in `title-file.ts` (pinned on its own in
    // title-file.spec.ts). This block still pins the cases through the VERB, as
    // host-pr-cli.spec.ts does, so each call site's wiring and printed message
    // stay covered.

    /** Run a REUSE with `extra` flags; return the exit code and the PATCHed title. */
    async function reuseWith(extra: string[]): Promise<{ code: number; patchedTitle?: string; methods: string[] }> {
      await seed();
      landTuple(1, report(), verdict());
      let patchedTitle: string | undefined;
      const { http, requests } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, title: 'Live title', body: `Live.\n\nCloses #${id}` }],
        }),
        patch: (_url, body) => {
          patchedTitle = (JSON.parse(body ?? '{}') as Record<string, string>).title;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1, extra),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR, number: 7 }) }),
      );
      return {
        code,
        ...(patchedTitle === undefined ? {} : { patchedTitle }),
        methods: requests.map((r) => r.method),
      };
    }

    function titleFile(content: string, name = 'pr-title.txt'): string {
      const p = join(repoRoot, name);
      writeFileSync(p, content, 'utf8');
      return p;
    }

    it('--title-file takes the flag rung: the PR title equals the file content, trailing newline trimmed', async () => {
      const gitFlavoured = 'Fall back to `git reset --mixed` when `git reset --hard` is refused';
      const r = await reuseWith(['--title-file', titleFile(`${gitFlavoured}\n`)]);
      expect(r.code).toBe(0);
      expect(r.patchedTitle).toBe(gitFlavoured);
      expect(result()).toMatchObject({ title: gitFlavoured, titleSource: 'flag' });
    });

    it('--title-file trims ONE trailing newline (\\n or \\r\\n), and only one', async () => {
      expect((await reuseWith(['--title-file', titleFile('T\r\n', 'a.txt')])).patchedTitle).toBe('T');
      stdout = '';
      expect((await reuseWith(['--title-file', titleFile('T\n\n', 'b.txt')])).patchedTitle).toBe('T\n');
    });

    it('BOTH --title and --title-file → exit 2 naming both flags, before any request', async () => {
      const r = await reuseWith(['--title', 'T', '--title-file', titleFile('T\n')]);
      expect(r.code).toBe(2);
      expect(stderr).toMatch(/at most ONE of --title <title> and --title-file <path>/);
      expect(r.methods).toEqual([]);
    });

    it('an EMPTY --title-file → exit 2 naming the path, before any request', async () => {
      const empty = titleFile('\n', 'empty.txt');
      const r = await reuseWith(['--title-file', empty]);
      expect(r.code).toBe(2);
      expect(stderr).toContain(empty);
      expect(stderr).toMatch(/is empty/);
      expect(r.methods).toEqual([]);
    });

    it('an unreadable --title-file → exit 2 naming the path', async () => {
      const missing = join(repoRoot, 'no-such-title.txt');
      const r = await reuseWith(['--title-file', missing]);
      expect(r.code).toBe(2);
      expect(stderr).toMatch(/could not read --title-file/);
      expect(r.methods).toEqual([]);
    });

    it('an EMPTY live title is not a title worth preserving — the row stands in, never ""', async () => {
      await seed();
      landTuple(1, report(), verdict());
      let patched: Record<string, string> = {};
      const { http } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, title: '   ', body: `Live.\n\nCloses #${id}` }],
        }),
        patch: (_url, body) => {
          patched = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR, number: 7 }) }),
      );

      expect(code).toBe(0);
      expect(patched.title).toBe('Route one returned tuple in one call');
      expect(result()).toMatchObject({ titleSource: 'row' });
    });

    it('a public-API-change approve STOPs before any write — the G3 guard, end to end', async () => {
      await seed();
      landTuple(1, report(), verdict({ riskClass: 'public-API-change' }));
      const before = spineSource();
      const { http, requests } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(argv(1), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'stop',
        stop: { phase: 'route-verdict', reason: 'public-api-approval-required', severity: 'blocking' },
        wrote: { spine: false, host: false, tracker: false },
      });
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
      expect(requests).toHaveLength(0);
    });
  });

  // ── a row landed while still flagged (issue #1017) ─────────────────────────
  //
  // The step-8 STOP sets the needs-attention flag; a Reviewer-only re-review
  // that approves lands the row through this verb. The verb never clears the
  // flag (the Coordinator does, at the point the Operator answers) — it WARNS
  // when the row it just landed still reads flagged, and changes nothing else.

  describe('a row landed while its tracker still reads needs-attention', () => {
    const FLAG = {
      kind: 'recoverable-stop' as const,
      question: 'Which reading of the criterion is meant?',
      options: ['the narrow one', 'the wide one'],
    };

    it('prints a `warning:` naming the row, still exits 0, writes exactly what an unflagged landing writes, and leaves the flag standing', async () => {
      await seed();
      await store.flag(id, FLAG);
      expect(await rungOf()).toBe('needs-attention');
      landTuple(1, report(), verdict());
      const { http, requests } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );

      expect(code).toBe(0);
      const warnings = stderr.split('\n').filter((l) => l.startsWith('warning:'));
      expect(warnings).toEqual([
        `warning: route-tuple: row ${JSON.stringify(id)} landed at pr-created, but its tracker status still reads needs-attention.`,
      ]);
      expect(stderr).toContain(`issue-store clear-flag ${id}`);
      // The landing itself is the ordinary one: same disposition, same writes.
      expect(result()).toMatchObject({
        ok: true,
        disposition: 'pr-created',
        prUrl: NEW_PR,
        wrote: { spine: true, host: true, tracker: true },
      });
      expect(step('rung-transition')).toMatchObject({ status: 'performed', rung: 'in-review' });
      expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
      // Warned, never cleared: the flag still overlays the rung it now sits on.
      expect(await rungOf()).toBe('needs-attention');
      await store.clearFlag(id);
      expect(await rungOf()).toBe('in-review');
    });

    it('CONTROL — an unflagged row lands with no warning at all', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(stderr).not.toContain('needs-attention');
    });

    it('the markdown store reads the same way — its flag overlays the rung and draws the same warning', async () => {
      await seed({ markdown: true });
      await store.flag(id, FLAG);
      landTuple(1, report(), verdict());
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );
      expect(code).toBe(0);
      expect(stderr).toContain(`warning: route-tuple: row ${JSON.stringify(id)} landed at pr-created`);
      expect(await rungOf()).toBe('needs-attention');
    });
  });

  // ── the stop branches ──────────────────────────────────────────────────────

  describe('stop outcomes write nothing and say what is needed next', () => {
    it('questions-blocking', async () => {
      await seed();
      landTuple(1, report(), verdict({ verdict: 'questions-blocking' }));
      const before = spineSource();
      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'stop',
        stop: { phase: 'route-verdict', reason: 'reviewer-questions-blocking' },
        wrote: { spine: false, host: false, tracker: false },
      });
      expect(result().next).toContain('issue-store flag');
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a 2nd changes-requested exhausts the cap — routed from `re-dispatched`, the only state it is reachable from', async () => {
      await seed();
      landTuple(2, report(), verdict({ verdict: 'changes-requested' }));
      const before = spineSource();
      const code = await runRouteTuple(argv(2), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(step('route-verdict')).toMatchObject({
        from: 're-dispatched',
        event: 'reviewer-changes-requested-2nd',
        outcome: { type: 'stop', reason: 're-dispatch-cap-exhausted', severity: 'error' },
      });
      expect(result()).toMatchObject({ disposition: 'stop', wrote: { spine: false } });
      expect(spineSource()).toBe(before);
    });

    it('a Worker `blocked` stops in the WORKER phase — the verdict is never even routed', async () => {
      await seed();
      landTuple(1, report({ outcome: 'blocked' }), verdict());
      const before = spineSource();
      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'stop',
        stop: { phase: 'route-outcome', reason: 'worker-failed', severity: 'error' },
      });
      expect(steps().map((s) => s.step)).toEqual(['sidecar-check', 'route-outcome']);
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });
  });

  // ── the re-dispatch branch ─────────────────────────────────────────────────

  describe('re-dispatch writes the spine only', () => {
    it('a 1st changes-requested bumps the row state and the iteration, and touches neither host nor tracker', async () => {
      await seed();
      landTuple(1, report(), verdict({ verdict: 'changes-requested' }));
      const { http, requests } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(argv(1), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 're-dispatched',
        nextIteration: 2,
        wrote: { spine: true, host: false, tracker: false },
      });
      expect(step('spine-row-state')).toMatchObject({ status: 'performed', state: 're-dispatched' });
      expect(step('spine-row-iter')).toMatchObject({ status: 'performed', iter: 2 });
      expect(step('pr-create-or-reuse')).toMatchObject({ status: 'skipped' });
      expect(step('rung-transition')).toMatchObject({ status: 'skipped' });

      // BOTH spine writes landed — one store, one flush. A mixed store/raw-writer
      // pair would have flushed the pristine source over the iteration bump.
      const row = spineSource()
        .split('\n')
        .find((l) => l.startsWith(`| ${id} |`))!;
      expect(row).toContain('re-dispatched');
      expect(row.split('|').map((c) => c.trim())).toContain('2');

      expect(requests).toHaveLength(0);
      expect(await rungOf()).toBe('in-flight');
      expect(result().next).toEqual(
        expect.arrayContaining([expect.stringContaining('worktree-cleanup --branches')]),
      );
    });

    it('a Worker `needs-context` short-circuits review entirely and re-dispatches', async () => {
      await seed();
      landTuple(1, report({ outcome: 'needs-context' }), verdict());
      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(0);
      expect(result()).toMatchObject({ disposition: 're-dispatched', nextIteration: 2 });
      // The verdict phase never ran — the worker phase already answered.
      expect(steps().map((s) => s.step)).not.toContain('route-verdict');
    });
  });

  // ── idempotence ────────────────────────────────────────────────────────────

  describe('re-runnable: a second run reports performed-before, never an error', () => {
    it('reuses the open PR, appends no second verdict section, and does not re-transition the rung', async () => {
      await seed();
      landTuple(1, report(), verdict());

      // Run 1 — creates.
      let live = '';
      const http1 = fakeHttp({
        get: () => ({ status: 200, json: [] }),
        post: (_url, body) => {
          live = (JSON.parse(body ?? '{}') as Record<string, string>).body;
          return { status: 201, json: { html_url: NEW_PR } };
        },
      });
      expect(
        await runRouteTuple(argv(1), deps({ http: http1.http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) })),
      ).toBe(0);
      const afterRun1 = spineSource();
      const verdictSections1 = live.split('## Reviewer verdict').length - 1;
      expect(verdictSections1).toBe(1);

      // Run 2 — the host now knows the PR, and reports the body run 1 wrote.
      stdout = '';
      stderr = '';
      let rewritten = '';
      const http2 = fakeHttp({
        get: () => ({ status: 200, json: [{ html_url: NEW_PR, number: 8, body: live }] }),
        post: () => {
          throw new Error('run 2 must NEVER create a second PR');
        },
        patch: (_url, body) => {
          rewritten = (JSON.parse(body ?? '{}') as Record<string, string>).body;
          return { status: 200, json: {} };
        },
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http: http2.http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );

      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(result()).toMatchObject({ disposition: 'pr-created', prUrl: NEW_PR });
      // Every already-done step says so, and none of them is an error.
      expect(step('sidecar-check')).toMatchObject({ status: 'performed-before' });
      expect(step('pr-create-or-reuse')).toMatchObject({ status: 'performed-before', outcome: 'reused' });
      expect(step('spine-row-state')).toMatchObject({ status: 'performed-before', state: 'pr-created' });
      expect(step('spine-row-pr')).toMatchObject({ status: 'performed-before' });
      expect(step('rung-transition')).toMatchObject({
        status: 'performed-before',
        trackerStatus: 'in-review',
      });
      expect(result().wrote).toMatchObject({ spine: false, tracker: false });
      // The spine is byte-identical — a re-run rewrites nothing it already wrote.
      expect(spineSource()).toBe(afterRun1);
      // …and exactly ONE verdict section, not two stacked.
      expect(rewritten.split('## Reviewer verdict').length - 1).toBe(1);
    });

    it('a re-run of the re-dispatch branch re-reports the two spine writes as already done', async () => {
      await seed();
      landTuple(1, report(), verdict({ verdict: 'changes-requested' }));
      expect(await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }))).toBe(0);
      const afterRun1 = spineSource();

      stdout = '';
      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(0);
      expect(step('spine-row-state')).toMatchObject({ status: 'performed-before' });
      expect(step('spine-row-iter')).toMatchObject({ status: 'performed-before' });
      expect(result().wrote).toMatchObject({ spine: false });
      expect(spineSource()).toBe(afterRun1);
    });
  });

  // ── the sidecar step ───────────────────────────────────────────────────────

  describe('sidecar presence + validation (the recovery path, not the default)', () => {
    it('a MISSING sidecar is recovered from the passed payload, through the same renderer write-report uses', async () => {
      await seed();
      // Payloads only — no sidecars on disk at all.
      writePayloads({ ...report(), issue: id, branch }, { ...verdict(), branchReviewed: branch });

      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(step('sidecar-check')).toMatchObject({ status: 'performed', recovered: ['report', 'verdict'] });
      // The recovered records are byte-identical to what `write-report` renders.
      expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toBe(
        renderSidecarBody('WorkerReport', id, 1, { ...report(), issue: id, branch }),
      );
      expect(readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8')).toBe(
        renderSidecarBody('ReviewerVerdict', id, 1, { ...verdict(), branchReviewed: branch }),
      );
    });

    it('a CORRUPT sidecar with no usable payload REFUSES — exit 1, and nothing else is touched', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // Corrupt the verdict sidecar and remove the payload it could be rebuilt from.
      writeFileSync(join(verdictsDir, `${id}-1.md`), '```json\n{"verdict":"nonsense"}\n```\n', 'utf8');
      writeFileSync(join(payloadDir, 'verdict.json'), 'not json at all', 'utf8');
      const before = spineSource();

      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/no valid ReviewerVerdict sidecar/);
      expect(stderr).toMatch(/CORRUPT/);
      expect(stderr).toMatch(/write-verdict/);
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a recovery SWEEPS its target dir for misnamed sidecars — the litter an existence probe cannot see', async () => {
      // Convention 5 says the routing-time recovery is what catches a MISNAMED
      // sidecar, because `[ -f <dir>/<id>-<iter>.md ]` answers false for a
      // misnamed file exactly as it does for a missing one. That was true of
      // `write-report` (the resume path's recovery) and false of THIS verb (the
      // dispatch path's), which recovered through its own writer and swept
      // nothing — rewriting the correctly-named file and walking past the
      // leftover in silence.
      await seed();
      writePayloads({ ...report(), issue: id, branch }, { ...verdict(), branchReviewed: branch });
      mkdirSync(reportsDir, { recursive: true });
      // A real, schema-valid record filed under a DECORATED id: present to an
      // `ls`, resolvable for no row at all.
      writeFileSync(
        join(reportsDir, `#${id}-1.md`),
        renderSidecarBody('WorkerReport', `#${id}`, 1, { ...report(), issue: id, branch }),
        'utf8',
      );

      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      // Loud, and never a refusal: the record this step was asked to persist is
      // on disk, and litter beside it is an operator finding about the DIRECTORY.
      expect(code).toBe(0);
      expect(stderr).toMatch(/MISNAMED SIDECAR/);
      expect(stderr).toContain(`#${id}-1.md`);
      expect(stderr).toMatch(/present to an `ls` and\n {2}absent to resume/);
      // ── the EXACT text, byte for byte (issue #724) ──────────────────────────
      //
      // The twin of route-cli.spec.ts's pin, and identical to it apart from the
      // label — which is the whole property the shared renderer
      // (`renderMisnamedSidecarWarning`, route-cli.ts) exists to keep true. This
      // verb used to carry its own verbatim copy of these six lines; the regex
      // assertions above are green for a sentence that has lost half its remedy,
      // which is exactly how two copies drift apart unnoticed.
      //
      // Written as a LITERAL, not assembled from the renderer under test.
      expect(stderr).toContain(
        `warning: route-tuple: MISNAMED SIDECAR ${JSON.stringify(join(reportsDir, `#${id}-1.md`))} — its\n` +
          `  filename id ${JSON.stringify(`#${id}`)} contains "#" — an id must be filename-safe AND literally matchable, so it carries no whitespace, no "#", and no path character, so the reader resolves it for NO row\n` +
          `  (it holds the record for ${JSON.stringify(id)}, which would be filed as\n` +
          `  ${JSON.stringify(`${id}-1.md`)}). A file like this is present to an \`ls\` and\n` +
          '  absent to resume, and an existence probe cannot tell it from a missing one.\n' +
          '  Confirm the correctly-named record holds the same content, then delete it.\n',
      );
      // Carried structurally too — this verb's output is a JSON result the
      // Coordinator reads at routing, and a stderr line alone would leave the
      // finding out of the record.
      expect(step('sidecar-check')).toMatchObject({
        status: 'performed',
        recovered: ['report', 'verdict'],
        misnamed: [`#${id}-1.md`],
      });
      // Never deleted: it may hold the only copy of a report.
      expect(readFileSync(join(reportsDir, `#${id}-1.md`), 'utf8')).toContain('WorkerReport');
    });

    it('a recovery over a CLEAN directory sweeps and says nothing', async () => {
      // The other half of the pair: the sweep must be silent when there is
      // nothing to report, or every recovery would carry noise and the warning
      // above would stop meaning anything.
      await seed();
      writePayloads({ ...report(), issue: id, branch }, { ...verdict(), branchReviewed: branch });

      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(step('sidecar-check')).toMatchObject({ recovered: ['report', 'verdict'], misnamed: [] });
    });

    it('a payload that fails its schema is refused rather than written — nothing recovered, nothing routed', async () => {
      await seed();
      writePayloads({ ...report(), issue: id, branch }, { verdict: 'approve' } as unknown as ReviewerVerdict);
      const before = spineSource();

      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(1);
      expect(stderr).toMatch(/not a valid ReviewerVerdict/);
      expect(spineSource()).toBe(before);
    });
  });

  // ── the divergence repair ──────────────────────────────────────────────────
  //
  // The live occurrence this block pins: a Worker's in-band report carried a
  // `prUrl`, the Scribe-written sidecar for the same row and iteration did not,
  // and `write-report`'s absent-`prUrl` notice fired on the sidecar write. The
  // row landed anyway (the terminator re-queries the host), but the DURABLE
  // record disagreed with the in-band one — and a resume reads only the durable
  // one. The sidecar step used to read the passed payload only when the sidecar
  // was missing, so it never saw the disagreement. It now compares, and on a
  // divergence the passed payload wins (Operator ruling).

  describe('a sidecar that DISAGREES with its payload — the passed payload wins and the record is repaired', () => {
    /** A writer that records every write and still lands the bytes, as production does. */
    function spyWriter(): { writer: NonNullable<RouteTupleDeps['sidecarWriter']>; writes: string[] } {
      const writes: string[] = [];
      return {
        writes,
        writer: (dir, file, content) => {
          writes.push(join(dir, file));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, file), content, 'utf8');
        },
      };
    }

    /** The two payloads exactly as `landTuple` fills them — what the tuple carried in band. */
    const filledReport = (over: Partial<WorkerReport> = {}): WorkerReport => ({
      ...report(over),
      issue: id,
      branch,
    });
    const filledVerdict = (over: Partial<ReviewerVerdict> = {}): ReviewerVerdict => ({
      ...verdict(over),
      branchReviewed: branch,
    });

    /** Overwrite one sidecar at `iter` with an arbitrary (schema-valid) record. */
    function writeSidecar(kind: 'report' | 'verdict', iter: number, record: unknown): void {
      writeFileSync(
        join(kind === 'report' ? reportsDir : verdictsDir, `${id}-${iter}.md`),
        renderSidecarBody(kind === 'report' ? 'WorkerReport' : 'ReviewerVerdict', id, iter, record),
        'utf8',
      );
    }

    it('a report sidecar that LOST prUrl is rewritten from the payload, the warning names prUrl, and the result records the repair', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // The live shape, exactly: everything the in-band report carried, minus prUrl.
      const lost: Partial<WorkerReport> = filledReport();
      delete lost.prUrl;
      writeSidecar('report', 1, lost);

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      // Rewritten to match the payload — byte-identical to what write-report
      // renders from it, through the one renderer the recovery also uses.
      expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toBe(
        renderSidecarBody('WorkerReport', id, 1, filledReport()),
      );
      expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toContain(`"prUrl": "${EXISTING_PR}"`);
      // Exactly one write — the report — and none to the verdict that agreed.
      expect(writes).toEqual([join(reportsDir, `${id}-1.md`)]);
      // Loud: ONE `warning:` line naming the row, the iteration, the kind and
      // the field. Written as a literal, not assembled from the code under test.
      expect(stderr).toContain(
        `warning: route-tuple: REPAIRED the report sidecar for row ${JSON.stringify(id)} at iteration 1 — ` +
          'it disagreed with the --report-file payload (missing: prUrl).\n',
      );
      expect(stderr.split('\n').filter((l) => l.startsWith('warning:'))).toHaveLength(1);
      // The result records the repair, beside `recovered` — which stays empty,
      // because the sidecar was never missing.
      expect(step('sidecar-check')).toMatchObject({
        status: 'performed',
        recovered: [],
        repaired: ['report'],
        reportIter: 1,
      });
      // Routing proceeds (from the payload — the next spec makes that visible
      // on a field routing actually reads, which prUrl is not).
      expect(result()).toMatchObject({ disposition: 'pr-created', reportOutcome: 'done' });
    });

    it('routing follows the PAYLOAD, not the stale sidecar — a divergent outcome routes the payload\'s way', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // A stale sidecar whose outcome would re-dispatch the row, and which lost
      // prUrl besides; the payload says `done`.
      const stale: Partial<WorkerReport> = filledReport({ outcome: 'needs-context' });
      delete stale.prUrl;
      writeSidecar('report', 1, stale);

      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(stderr).toContain('(missing: prUrl; different: outcome)');
      // Routed from the payload: the Worker phase saw `done`, so the row landed
      // rather than re-dispatching on the sidecar's `needs-context`.
      expect(step('route-outcome')).toMatchObject({ workerOutcome: 'done', event: 'worker-done' });
      expect(result()).toMatchObject({ disposition: 'pr-created', reportOutcome: 'done' });
      expect(step('sidecar-check')).toMatchObject({ repaired: ['report'] });
    });

    it('sidecar and payload EQUAL — no write, no warning, no repair entry', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const reportBytes = readFileSync(join(reportsDir, `${id}-1.md`), 'utf8');
      const verdictBytes = readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8');

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(writes).toEqual([]);
      expect(stderr).toBe('');
      expect(step('sidecar-check')).toMatchObject({
        status: 'performed-before',
        recovered: [],
        repaired: [],
      });
      expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toBe(reportBytes);
      expect(readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8')).toBe(verdictBytes);
    });

    it('EQUAL after the write path\'s normalisation — key order and a decorated issue are not a divergence', async () => {
      // "Equal" is judged after the normalisation `write-report` applies: a
      // decorated `issue` reconciles to the bare row id, and a payload staged
      // by a different hand in a different key order holds the same facts.
      await seed();
      landTuple(1, report(), verdict());
      const reordered = Object.fromEntries(Object.entries(filledReport()).reverse());
      writeFileSync(
        join(payloadDir, 'report.json'),
        JSON.stringify({ ...reordered, issue: `#${id}`, filesChanged: { renamed: 0, modified: 2, new: 1 } }),
        'utf8',
      );

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(writes).toEqual([]);
      expect(stderr).toBe('');
      expect(step('sidecar-check')).toMatchObject({ status: 'performed-before', repaired: [] });
    });

    it('a Reviewer-only round that OVERWROTE its verdict sidecar at the same iteration (last-writer-wins) stays silent', async () => {
      // Two such rounds ran in one wave: the verdict sidecar at iteration N was
      // overwritten by the round's own Scribe, and the Coordinator routed with
      // the matching payload. Sidecar and payload are equal after the overwrite,
      // so the comparison must say nothing.
      await seed();
      landTuple(1, report(), verdict({ workerReportDigest: 'the first round, against a bad anchor' }));
      writeSidecar('verdict', 1, filledVerdict());
      writeFileSync(join(payloadDir, 'verdict.json'), JSON.stringify(filledVerdict()), 'utf8');

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(writes).toEqual([]);
      expect(stderr).toBe('');
      expect(step('sidecar-check')).toMatchObject({ repaired: [] });
    });

    it('the VERDICT half repairs the same way — every missing, extra and different field named, and the PR body renders from the payload', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // A stale verdict sidecar: an older digest, no lint summary, and a field
      // the payload does not carry — one of each divergence kind.
      const stale: Partial<ReviewerVerdict> = filledVerdict({
        workerReportDigest: 'STALE digest from an earlier write.',
        gitStateSane: true,
      });
      delete stale.lintTestSummary;
      writeSidecar('verdict', 1, stale);

      const { writer, writes } = spyWriter();
      let posted: Record<string, string> = {};
      const { http } = fakeHttp({
        get: () => ({ status: 200, json: [] }),
        post: (_url, body) => {
          posted = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 201, json: { html_url: NEW_PR } };
        },
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8')).toBe(
        renderSidecarBody('ReviewerVerdict', id, 1, filledVerdict()),
      );
      expect(writes).toEqual([join(verdictsDir, `${id}-1.md`)]);
      expect(stderr).toContain(
        `warning: route-tuple: REPAIRED the verdict sidecar for row ${JSON.stringify(id)} at iteration 1 — ` +
          'it disagreed with the --verdict-file payload ' +
          '(missing: lintTestSummary; extra: gitStateSane; different: workerReportDigest).\n',
      );
      expect(step('sidecar-check')).toMatchObject({
        status: 'performed',
        recovered: [],
        repaired: ['verdict'],
      });
      // Rendered from the payload: the create path's summary IS the verdict's
      // digest, so the stale one would be visible here if it had routed.
      expect(posted.body.startsWith('Worker reports 4161/4161 green')).toBe(true);
      expect(posted.body).not.toContain('STALE digest');
    });

    it.each([
      ['report', 'unreadable', 'not json at all'],
      ['report', 'invalid', JSON.stringify({ outcome: 'done' })],
      ['verdict', 'unreadable', 'not json at all'],
      ['verdict', 'invalid', JSON.stringify({ verdict: 'approve' })],
    ] as const)(
      'a %s payload that is %s, with a valid sidecar present — no write, no warning, routing from the sidecar',
      async (kind, _why, content) => {
        await seed();
        landTuple(1, report(), verdict());
        // The sidecar lost prUrl — a divergence a VALID payload would repair —
        // so a write here would be visible. An unusable payload repairs nothing.
        const lost: Partial<WorkerReport> = filledReport();
        delete lost.prUrl;
        writeSidecar('report', 1, lost);
        const reportBytes = readFileSync(join(reportsDir, `${id}-1.md`), 'utf8');
        const verdictBytes = readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8');
        writeFileSync(join(payloadDir, `${kind}.json`), content, 'utf8');

        const { writer, writes } = spyWriter();
        const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
        const code = await runRouteTuple(
          argv(1),
          deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
        );

        expect(code).toBe(0);
        expect(result()).toMatchObject({ disposition: 'pr-created' });
        // The unusable half wrote nothing; the verdict half had nothing to repair.
        const unusableDir = kind === 'report' ? reportsDir : verdictsDir;
        expect(writes.filter((w) => w.startsWith(unusableDir))).toEqual([]);
        expect(readFileSync(join(verdictsDir, `${id}-1.md`), 'utf8')).toBe(verdictBytes);
        if (kind === 'report') {
          expect(writes).toEqual([]);
          expect(stderr).toBe('');
          expect(step('sidecar-check')).toMatchObject({ status: 'performed-before', repaired: [] });
          expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toBe(reportBytes);
        } else {
          // The REPORT payload is still valid here, so the report half repairs
          // exactly as it would alone: the halves are independent.
          expect(step('sidecar-check')).toMatchObject({ repaired: ['report'] });
          expect(stderr).not.toContain('REPAIRED the verdict sidecar');
        }
      },
    );

    it('a report payload that names a DIFFERENT row is refused as a source — the valid sidecar stands, nothing written', async () => {
      // The one payload the write path refuses after validation: reconciliation
      // finds a mis-paired record. A record this verb would refuse to RECOVER
      // from may not OVERWRITE a valid one either.
      await seed();
      landTuple(1, report(), verdict());
      const reportBytes = readFileSync(join(reportsDir, `${id}-1.md`), 'utf8');
      writeFileSync(
        join(payloadDir, 'report.json'),
        // `issue` set AFTER the fill, which would otherwise restore the row id.
        JSON.stringify({ ...filledReport({ tests: 'a different row entirely' }), issue: `${id}999` }),
        'utf8',
      );

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(code).toBe(0);
      expect(writes).toEqual([]);
      expect(stderr).toBe('');
      expect(readFileSync(join(reportsDir, `${id}-1.md`), 'utf8')).toBe(reportBytes);
      expect(step('sidecar-check')).toMatchObject({ repaired: [] });
    });

    it('a usable sidecar from a LATER iteration is not compared — the payload is not that round\'s source', async () => {
      await seed();
      // A report sidecar at iteration 2 exists; the call routes iteration 1
      // with a payload that differs from it. Only the routed iteration is
      // compared, so nothing is repaired and nothing is written.
      landTuple(1, report(), verdict());
      mkdirSync(reportsDir, { recursive: true });
      writeSidecar('report', 2, filledReport({ tests: 'the iteration-2 run' }));

      const { writer, writes } = spyWriter();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      await runRouteTuple(
        argv(1),
        deps({ http, sidecarWriter: writer, landingHost: fakeLanding({ state: 'open', url: NEW_PR }) }),
      );

      expect(writes).toEqual([]);
      expect(step('sidecar-check')).toMatchObject({ reportIter: 2, repaired: [] });
    });
  });

  // ── the host refusals ──────────────────────────────────────────────────────

  describe('host refusals stop the sequence before any spine or tracker write', () => {
    it('a failed create refuses with the pre-fill fallback — the row is NOT flipped to pr-created', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const before = spineSource();
      const { http } = fakeHttp({
        get: () => ({ status: 200, json: [] }),
        post: () => ({ status: 401, json: null }),
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'none' }) }),
      );

      expect(code).toBe(1);
      expect(stderr).toMatch(/host-pr create failed/);
      expect(stderr).toMatch(/Open it by hand/);
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a live body whose close phrase names a DIFFERENT row is still rewritten — the guard refuses absence, not mismatch', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const before = spineSource();
      const { http } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, body: 'Live body.\n\nCloses #999999' }],
        }),
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR }) }),
      );

      // The composed body carries `Closes #<id>`, so the guard lets it through.
      // This is the direction that matters most in practice: a legitimate rewrite
      // is never refused, however wrong the phrase already on the PR happens to be.
      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(step('pr-create-or-reuse')).toMatchObject({ outcome: 'reused' });
      expect(spineSource()).not.toBe(before);
    });

    it('NEGATIVE CONTROL — a composed phrase the guard cannot SEE is refused before any write, and the message says why', async () => {
      // The reachable form of `reuse-refused` for this verb, found while writing
      // this file. The composed phrase is `<keyword> <ref>`, and the guard only
      // recognises a ref shaped `#<digits>`, `TEAM-<digits>` or an issue URL. A
      // `linear`-kind config over a numeric id composes `Fixes 1` — a phrase to
      // a human and nothing at all to the guard — so replacing a live body that
      // DOES carry one is a drop, and the guard stops before writing anything.
      //
      // This control is deliberately KEPT as the reachable form. The other one
      // it used to name — a markdown-store id composing `Closes #<slug>#NN` —
      // was a defect rather than a control and is now closed: `closePhraseFor`
      // lifts the numeric tail, and the test below drives that whole way through
      // this verb. What stays reachable here is a genuinely misconfigured pair
      // (a `linear` kind over an id that is not a Linear reference), which no
      // phrase composition can rescue.
      await seed();
      landTuple(1, report(), verdict());
      writeFileSync(configPath, JSON.stringify({ store: { kind: 'linear', team: 'EX' } }), 'utf8');
      const before = spineSource();
      const { http, requests } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, body: `Live body.\n\nCloses #${id}` }],
        }),
      });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR }) }),
      );

      expect(code).toBe(1);
      expect(stderr).toMatch(/close-phrase guard REFUSED/);
      expect(stderr).toMatch(/not a shape a tracker resolves/);
      expect(stderr).toMatch(/no spine or tracker write happened/);
      // Refused BEFORE any write: the find happened, the PATCH never did.
      expect(requests.map((r) => r.method)).toEqual(['GET']);
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a markdown-store row REWRITES its live PR body — the composed phrase is one the guard can see', async () => {
      // The positive half of the control above, and the reason the defect was
      // worth closing at all: on the dogfood store the id is `<slug>#NN`, so the
      // composed phrase used to be `Closes #<slug>#01` — invisible to the guard,
      // which then refused a legitimate reuse as a close-phrase LOSS. Nothing
      // about the row was wrong; only the phrase was unreadable.
      await seed({ markdown: true });
      expect(id).toMatch(/#\d+$/); // the compound shape this test exists for
      landTuple(1, report(), verdict());
      const { http, requests } = fakeHttp({
        get: () => ({
          status: 200,
          json: [{ html_url: EXISTING_PR, number: 7, body: 'Live body.\n\nCloses #01' }],
        }),
      });

      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: EXISTING_PR }) }),
      );

      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(step('pr-create-or-reuse')).toMatchObject({ outcome: 'reused' });
      // The rewrite actually landed: a PATCH went out, and its body ends on the
      // tail-lifted phrase rather than on the whole compound id.
      expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
      const patched = JSON.parse(requests.find((r) => r.method === 'PATCH')!.body!) as {
        body: string;
      };
      expect(patched.body.split('\n').at(-1)).toBe('Closes #01');
      expect(patched.body).not.toContain(`Closes #${id}`);
    });

    it('a status re-query that finds no PR refuses — the row is not flipped and the PR cell stays empty', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const before = spineSource();
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'none' }) }),
      );

      expect(code).toBe(1);
      expect(stderr).toMatch(/host-pr status reports "none"/);
      expect(stderr).toMatch(/NOT flipped to pr-created/);
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });
  });

  // ── the Operator-ruled round (issue #684) ──────────────────────────────────
  //
  // The ruled round had to reach THIS verb and not only the single
  // `route-verdict`: the whole post-return sequence runs through route-tuple on
  // the ordinary dispatch path, so a cell admitted only by the single verb would
  // work on a resume and nowhere else. The two properties asserted here are the
  // PASSTHROUGH (the ruling reaches the adapter and comes back out in the
  // printed result) and the REFUSAL (without it, an above-cap `--iter` is
  // refused with the adapter's own pre-existing message, having written nothing).

  describe('an Operator-ruled round above the cap', () => {
    it('lands the PR at iteration 3 with a ruling, and the result quotes the ruling', async () => {
      await seed();
      landTuple(3, report(), verdict());
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(3, ['--ruling', RULING]),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );

      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'pr-created',
        iter: 3,
        prUrl: NEW_PR,
        ruled: { cell: 'reviewer-approve-ruled', ruling: RULING },
      });
      // The `--state` derivation is unmoved by the ruling: a ruled approve
      // routes from `reviewing`, exactly as an ordinary one does, and reaches
      // the state an ordinary approve reaches.
      expect(step('route-verdict')).toMatchObject({
        from: 'reviewing',
        event: 'reviewer-approve',
        outcome: { type: 'transition', nextState: 'approved' },
        ruled: { cell: 'reviewer-approve-ruled', ruling: RULING },
      });
      expect(spineSource()).toContain('pr-created');
      expect(await rungOf()).toBe('in-review');
    });

    it('NEGATIVE CONTROL — the same tuple WITHOUT --ruling is refused, and nothing is written', async () => {
      await seed();
      landTuple(3, report(), verdict());
      const before = spineSource();
      const code = await runRouteTuple(
        argv(3),
        deps({ landingHost: fakeLanding({ state: 'none' }) }),
      );

      expect(code).toBe(1);
      expect(stderr).toBe(
        'error: route-tuple: verdictToEvent: iteration 3 is out of range. ' +
          'Expected an integer in [1, 2] (re-dispatch cap = 1).\n',
      );
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a ruled changes-requested STOPs on the cap-exhaustion cell — no spine, host or tracker write', async () => {
      await seed();
      landTuple(3, report(), verdict({ verdict: 'changes-requested' }));
      const before = spineSource();
      const code = await runRouteTuple(
        argv(3, ['--ruling', RULING]),
        deps({ landingHost: fakeLanding({ state: 'none' }) }),
      );

      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'stop',
        stop: { phase: 'route-verdict', reason: 're-dispatch-cap-exhausted', severity: 'error' },
        wrote: { spine: false, host: false, tracker: false },
        ruled: { cell: 'reviewer-changes-requested-ruled', ruling: RULING },
      });
      // The row is NOT handed a fresh round by the ruling it already used.
      expect(result().disposition).not.toBe('re-dispatched');
      expect(spineSource()).toBe(before);
      expect(await rungOf()).toBe('in-flight');
    });

    it('a ruling that states no reason is refused as loudly as a missing one', async () => {
      await seed();
      landTuple(3, report(), verdict());
      const before = spineSource();
      const code = await runRouteTuple(
        argv(3, ['--ruling', 'true']),
        deps({ landingHost: fakeLanding({ state: 'none' }) }),
      );

      expect(code).toBe(1);
      expect(stderr).toMatch(/A ruled round is auditable only if it states WHY it exists/);
      expect(spineSource()).toBe(before);
    });

    it('an ORDINARY iteration-1 run is unchanged — no `ruled` key anywhere in the result', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      await runRouteTuple(
        argv(1),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );
      expect(result()).not.toHaveProperty('ruled');
      expect(step('route-verdict')).not.toHaveProperty('ruled');
    });
  });

  // ── the Operator's approval past the public-API STOP (ADR-0047) ───────────
  //
  // A `public-API-change` row the Reviewer approved stops at
  // `public-api-approval-required` and writes nothing. `--approve "<reason>"` is
  // the continuation: it fires `human-approve` and runs the approve path end to
  // end — the PR body gains an `## Operator approval` section quoting the reason,
  // the spine gets `pr-created` + the PR url + a recorded approval, and the
  // tracker's flag is cleared before the `in-review` rung. Everything below is
  // asserted through the same fakes the approve path above is.

  describe('--approve: the Operator\'s approval past the public-API STOP', () => {
    const APPROVAL =
      'Operator approved 2026-09-28: the new flag is additive and ships in the next minor.';
    const FLAG = {
      kind: 'recoverable-stop' as const,
      question: 'Approve landing this public-API change?',
      options: ['approve', 'park'],
    };

    /** Seed a public-API row, route it once (the STOP), and flag it as step 8 does. */
    async function stopAndFlag(): Promise<void> {
      await seed();
      landTuple(1, report(), verdict({ riskClass: 'public-API-change' }));
      const stopped = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));
      expect(stopped).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'stop',
        stop: { reason: 'public-api-approval-required' },
      });
      // The STOP now names the continuation it has.
      expect(result().next).toContain('--approve');
      stdout = '';
      await store.flag(id, FLAG);
      expect(await rungOf()).toBe('needs-attention');
    }

    const rowOf = () => readSpine(spineSource()).planTable.find((r) => r.id === id);

    it('writes PR body (approval + reason), spine (pr-created + url + recorded approval) and tracker (flag cleared, in-review)', async () => {
      await stopAndFlag();
      let posted: Record<string, string> = {};
      const { http, requests } = fakeHttp({
        get: () => ({ status: 200, json: [] }),
        post: (_url, body) => {
          posted = JSON.parse(body ?? '{}') as Record<string, string>;
          return { status: 201, json: { html_url: NEW_PR } };
        },
      });
      const code = await runRouteTuple(
        argv(1, ['--approve', APPROVAL]),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );

      expect(stderr).toBe('');
      expect(code).toBe(0);
      expect(result()).toMatchObject({
        disposition: 'pr-created',
        prUrl: NEW_PR,
        approved: { event: 'human-approve', from: 'reviewing', reason: APPROVAL, disclosure: `${id}.1` },
        wrote: { spine: true, host: true, tracker: true },
      });
      // The route-verdict step still records the STOP it routed to; the
      // continuation is its own step, through the state machine's own cell.
      expect(step('route-verdict')).toMatchObject({
        outcome: { type: 'stop', reason: 'public-api-approval-required' },
      });
      expect(step('operator-approve')).toMatchObject({
        status: 'performed',
        from: 'reviewing',
        event: 'human-approve',
        outcome: { type: 'transition', nextState: 'approved' },
        reason: APPROVAL,
      });
      expect(steps().map((s) => s.step)).toEqual([
        'sidecar-check',
        'route-outcome',
        'route-verdict',
        'operator-approve',
        'render-verdict',
        'pr-create-or-reuse',
        'pr-status',
        'spine-row-state',
        'spine-row-pr',
        'spine-approval',
        'clear-flag',
        'rung-transition',
      ]);

      // PR body: summary → verdict → approval → close phrase (last line).
      expect(posted.body).toContain('## Reviewer verdict');
      expect(posted.body).toContain('## Operator approval');
      expect(posted.body).toContain(`Reason: ${APPROVAL}`);
      expect(posted.body.indexOf('## Reviewer verdict')).toBeLessThan(posted.body.indexOf('## Operator approval'));
      expect(posted.body.split('\n').at(-1)).toBe(`Closes #${id}`);
      expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);

      // Spine: pr-created, the PR url, and the approval recorded — dispositioned,
      // so it is durable without ever blocking the archive gate.
      expect(rowOf()?.state).toBe('pr-created');
      expect(spineSource()).toContain(NEW_PR);
      const recorded = readDisclosures(spineSource()).filter((d) => d.rowId === id);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        source: 'coordinator',
        disposition: 'resolved-in-slice',
        iter: 1,
      });
      expect(recorded[0]?.text).toContain('public-api-approval-required');
      expect(recorded[0]?.text).toContain(APPROVAL);

      // Tracker: flag cleared, rung in-review — and no still-flagged warning.
      expect(await rungOf()).toBe('in-review');
      expect(step('clear-flag')).toMatchObject({ status: 'performed' });
    });

    it('a re-run is idempotent: the open PR is reused, ONE approval section, ONE recorded approval', async () => {
      await stopAndFlag();
      let livePrBody = '';
      const { http, requests } = fakeHttp({
        get: () => ({
          status: 200,
          json: livePrBody === '' ? [] : [{ html_url: NEW_PR, number: 8, title: 'T', body: livePrBody }],
        }),
        post: (_url, body) => {
          livePrBody = (JSON.parse(body ?? '{}') as Record<string, string>).body ?? '';
          return { status: 201, json: { html_url: NEW_PR } };
        },
        patch: (_url, body) => {
          livePrBody = (JSON.parse(body ?? '{}') as Record<string, string>).body ?? '';
          return { status: 200, json: {} };
        },
      });
      const run = () =>
        runRouteTuple(
          argv(1, ['--approve', APPROVAL]),
          deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
        );
      expect(await run()).toBe(0);
      const afterFirst = spineSource();
      stdout = '';
      expect(await run()).toBe(0);

      expect(step('spine-approval')).toMatchObject({ status: 'performed-before', ref: `${id}.1` });
      expect(step('clear-flag')).toMatchObject({ status: 'performed-before' });
      expect(step('rung-transition')).toMatchObject({ status: 'performed-before' });
      expect(result()).toMatchObject({ wrote: { spine: false, tracker: false } });
      expect(spineSource()).toBe(afterFirst);
      expect(livePrBody.split('## Operator approval')).toHaveLength(2);
      expect(livePrBody.split('## Reviewer verdict')).toHaveLength(2);
      expect(livePrBody.split('\n').at(-1)).toBe(`Closes #${id}`);
      expect(requests.map((r) => r.method)).toEqual(['GET', 'POST', 'GET', 'PATCH']);
    });

    it('a re-run after a PARTIAL failure (tracker down after the spine landed) finishes the job', async () => {
      await stopAndFlag();
      let trackerDown = true;
      const flaky = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === 'clearFlag' && trackerDown) {
            return async () => {
              throw new Error('tracker unreachable');
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const run = () =>
        runRouteTuple(
          argv(1, ['--approve', APPROVAL]),
          deps({ store: flaky, http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
        );

      expect(await run()).toBe(1);
      expect(stderr).toContain('tracker unreachable');
      // The spine is the WAL: it landed before the tracker, approval included.
      expect(rowOf()?.state).toBe('pr-created');
      expect(await rungOf()).toBe('needs-attention');

      trackerDown = false;
      stdout = '';
      expect(await run()).toBe(0);
      expect(step('spine-row-state')).toMatchObject({ status: 'performed-before' });
      expect(step('spine-approval')).toMatchObject({ status: 'performed-before' });
      expect(step('clear-flag')).toMatchObject({ status: 'performed' });
      expect(await rungOf()).toBe('in-review');
      expect(readDisclosures(spineSource()).filter((d) => d.rowId === id)).toHaveLength(1);
    });

    it('from a cap=1 second round (spine row re-dispatched, iteration 2) it lands the same way', async () => {
      await seed();
      writeFileSync(spinePath, setRowState(spineSource(), id, 're-dispatched'), 'utf8');
      landTuple(2, report(), verdict({ riskClass: 'public-API-change' }));
      const { http } = fakeHttp({ get: () => ({ status: 200, json: [] }) });
      const code = await runRouteTuple(
        argv(2, ['--approve', APPROVAL]),
        deps({ http, landingHost: fakeLanding({ state: 'open', url: NEW_PR, number: 8 }) }),
      );
      expect(code).toBe(0);
      expect(result()).toMatchObject({ disposition: 'pr-created', iter: 2 });
      expect(rowOf()?.state).toBe('pr-created');
    });

    // ── refusals: exit non-zero, nothing written ────────────────────────────

    /** Assert the refusal wrote NOTHING: spine bytes, tracker rung, sidecars, host. */
    async function expectNothingWritten(
      before: { spine: string; rung: string; reports: string; verdicts: string },
      requests: HttpRequest[],
    ): Promise<void> {
      expect(spineSource()).toBe(before.spine);
      expect(await rungOf()).toBe(before.rung);
      expect(sidecarListing(reportsDir)).toBe(before.reports);
      expect(sidecarListing(verdictsDir)).toBe(before.verdicts);
      expect(requests).toHaveLength(0);
      expect(stdout).toBe('');
    }

    function sidecarListing(dir: string): string {
      try {
        return readdirSync(dir).sort().join('\n');
      } catch {
        return '<absent>';
      }
    }

    async function snapshot() {
      return {
        spine: spineSource(),
        rung: await rungOf(),
        reports: sidecarListing(reportsDir),
        verdicts: sidecarListing(verdictsDir),
      };
    }

    for (const [label, extra, refusal] of [
      ['an EMPTY reason', ['--approve', ''], /the --approve reason is blank/],
      ['a whitespace-only reason', ['--approve', '   '], /the --approve reason is blank/],
      ['a bare token', ['--approve', 'yes'], /the --approve reason is 3 characters long/],
      ['a trailing --approve with no value', ['--approve'], /--approve takes the Operator's reason as its value/],
    ] as const) {
      it(`${label} → exit 2 (usage), nothing written`, async () => {
        await stopAndFlag();
        const before = await snapshot();
        const { http, requests } = fakeHttp({});
        const code = await runRouteTuple(argv(1, [...extra]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
        expect(code).toBe(2);
        expect(stderr).toMatch(refusal);
        await expectNothingWritten(before, requests);
      });
    }

    it('an ORDINARY approve (not public-API) is refused — --approve is not a way around the routing', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const before = await snapshot();
      const { http, requests } = fakeHttp({});
      const code = await runRouteTuple(argv(1, ['--approve', APPROVAL]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(1);
      expect(stderr).toMatch(/--approve continues ONLY a row stopped at public-api-approval-required/);
      expect(stderr).toMatch(/a transition to approved/);
      await expectNothingWritten(before, requests);
    });

    for (const [label, v, reason] of [
      ['changes-requested', verdict({ verdict: 'changes-requested', riskClass: 'public-API-change' }), /a transition to re-dispatched/],
      ['questions-blocking', verdict({ verdict: 'questions-blocking', riskClass: 'public-API-change' }), /the reviewer-questions-blocking STOP/],
    ] as const) {
      it(`a public-API row whose Reviewer said ${label} is refused — it is not at the approval STOP`, async () => {
        await seed();
        landTuple(1, report(), v);
        const before = await snapshot();
        const { http, requests } = fakeHttp({});
        const code = await runRouteTuple(argv(1, ['--approve', APPROVAL]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
        expect(code).toBe(1);
        expect(stderr).toMatch(reason);
        await expectNothingWritten(before, requests);
      });
    }

    it('a Worker `blocked` row is refused in the worker phase', async () => {
      await seed();
      landTuple(1, report({ outcome: 'blocked' }), verdict({ riskClass: 'public-API-change' }));
      const before = await snapshot();
      const { http, requests } = fakeHttp({});
      const code = await runRouteTuple(argv(1, ['--approve', APPROVAL]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(1);
      expect(stderr).toMatch(/its worker phase routes to the worker-failed STOP/);
      await expectNothingWritten(before, requests);
    });

    it('a PARKED row is refused off its spine state, before anything is read', async () => {
      await seed();
      landTuple(1, report(), verdict({ riskClass: 'public-API-change' }));
      writeFileSync(spinePath, setRowState(spineSource(), id, 'parked'), 'utf8');
      const before = await snapshot();
      const { http, requests } = fakeHttp({});
      const code = await runRouteTuple(argv(1, ['--approve', APPROVAL]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(1);
      expect(stderr).toMatch(/its spine row reads "parked"/);
      await expectNothingWritten(before, requests);
    });

    it('a row whose sidecar record is NOT on disk is refused — under --approve the sidecar step only reads', async () => {
      await seed();
      writePayloads(
        { ...report(), issue: id, branch },
        { ...verdict({ riskClass: 'public-API-change' }), branchReviewed: branch },
      );
      const before = await snapshot();
      const { http, requests } = fakeHttp({});
      const code = await runRouteTuple(argv(1, ['--approve', APPROVAL]), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(1);
      expect(stderr).toMatch(/--approve continues an already-routed STOP/);
      await expectNothingWritten(before, requests);
    });

    it('CONTROL — the same stopped row WITHOUT --approve still stops and writes nothing', async () => {
      await stopAndFlag();
      const before = await snapshot();
      const { http, requests } = fakeHttp({});
      const code = await runRouteTuple(argv(1), deps({ http, landingHost: fakeLanding({ state: 'none' }) }));
      expect(code).toBe(0);
      expect(result()).toMatchObject({ disposition: 'stop', wrote: { spine: false, host: false, tracker: false } });
      expect(result()).not.toHaveProperty('approved');
      expect(spineSource()).toBe(before.spine);
      expect(await rungOf()).toBe('needs-attention');
      expect(requests).toHaveLength(0);
    });
  });

  // ── usage + preconditions ──────────────────────────────────────────────────

  describe('usage and preconditions', () => {
    it('names each required flag, exit 2', async () => {
      expect(await runRouteTuple([])).toBe(2);
      expect(stderr.split('\n')[0]).toBe('error: route-tuple requires --spine <spine>');
      expect(stderr).toMatch(/--id/);
      expect(stderr).toMatch(/--iter/);
      expect(stderr).toMatch(/--report/);
      expect(stderr).toMatch(/--verdict/);
      expect(stderr).toMatch(/--anchor/);
      // …and the optional flag that admits the Operator-ruled round.
      expect(stderr).toMatch(/--ruling/);
    });

    it('a --ruling with no value is usage, not a message about the iteration', async () => {
      await seed();
      landTuple(3, report(), verdict());
      const code = await runRouteTuple(argv(3, ['--ruling']), deps());
      expect(code).toBe(2);
      expect(stderr).toMatch(/--ruling takes the Operator's reason as its value/);
      expect(stderr).not.toMatch(/out of range/);
    });

    it('a non-integer --iter is usage, not a domain failure', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const args = argv(1);
      args[args.indexOf('--iter') + 1] = 'two';
      expect(await runRouteTuple(args, deps())).toBe(2);
      expect(stderr).toMatch(/--iter must be a positive integer/);
    });

    it('an id that names no Plan-Table row refuses before anything is read', async () => {
      await seed();
      landTuple(1, report(), verdict());
      // Replace the value AFTER `--id` only. A blanket `a === id` map would also
      // hit `--iter 1` whenever the store hands out `1` as the row id, which is
      // how this fixture nearly asserted a usage error while claiming a domain one.
      const args = argv(1);
      args[args.indexOf('--id') + 1] = 'no-such-row';
      const code = await runRouteTuple(args, deps());
      expect(code).toBe(1);
      expect(stderr).toMatch(/no Plan-Table row with id "no-such-row"/);
    });

    it('a row with no recorded branch refuses at the terminator — the ADR-0021 WAL precondition', async () => {
      await seed();
      landTuple(1, report(), verdict());
      writeFileSync(spinePath, spineSource().replace(/branch wave\/[^\s"]+/, ''), 'utf8');
      const before = spineSource();
      const code = await runRouteTuple(argv(1), deps({ landingHost: fakeLanding({ state: 'none' }) }));

      expect(code).toBe(1);
      expect(stderr).toMatch(/spine set-branch/);
      expect(spineSource()).toBe(before);
    });

    it('an unreadable config is usage (exit 2), never a half-run', async () => {
      await seed();
      landTuple(1, report(), verdict());
      const code = await runRouteTuple(
        argv(1).map((a) => (a === configPath ? join(repoRoot, 'nope.json') : a)),
        deps(),
      );
      expect(code).toBe(2);
      expect(stderr).toMatch(/could not load --config/);
    });
  });

  // `execFileSync` keeps the harness honest about the fixture being a real
  // directory tree rather than a mocked fs — referenced so the import is used.
  it('the fixture repo root is a real directory on disk', async () => {
    await seed();
    expect(execFileSync('ls', [repoRoot], { encoding: 'utf-8' })).toContain('wave.config.json');
  });
});
