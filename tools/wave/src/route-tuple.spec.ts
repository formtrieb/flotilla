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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composePrBody,
  reviewerStateForVerdict,
  runRouteTuple,
  workerStateForIteration,
  workerSummaryFromBody,
  type RouteTupleDeps,
  type StepResult,
} from './route-tuple';
import { GitHubIssuesStore } from './adapters/github/github-issues-store';
import { InMemoryGitHubApi } from './adapters/github/github-api-fake';
import { renderSidecarBody } from './route-cli';
import { renderSpine, setRowState, upsertDispatchLogEntry } from './wave-md-rw';
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
  let store: GitHubIssuesStore;
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
   */
  async function seed(): Promise<void> {
    store = new GitHubIssuesStore({ api: new InMemoryGitHubApi() });
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
        store: { kind: 'github' },
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
      expect(step('pr-create-or-reuse')).toMatchObject({ summarySource: 'workerReportDigest' });
      // The title is the spine row's title with bare ids stripped.
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
      // The same hole opens on a markdown-store id (`Closes #<slug>#NN`).
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
