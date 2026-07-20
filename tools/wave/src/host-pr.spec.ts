/**
 * host-pr.spec.ts — fixtures for the host-aware PR boundary
 * (wave-orchestration #56).
 *
 * The single network side-effect (`verifyAuth` / `findOpenPr` / `createPr`) is
 * isolated behind the injectable `HttpProbe` seam, so every test is hermetic —
 * NO real network is touched (mirrors the `GitProbe` injection in
 * merge-order.spec.ts and the `FfProbe` injection in ff-guard.spec.ts).
 *
 * `detectHost` is a pure parser and needs no seam at all.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectHost,
  verifyAuth,
  findOpenPr,
  createPr,
  decideArmAction,
  armPullRequest,
  mergePullRequestNow,
  preflightHost,
  alignedPrRef,
  AutoMergeUnavailableError,
  LandingNotImplementedError,
  DEFAULT_MERGE_METHOD,
  type ArmOptions,
  type HttpProbe,
  type HttpRequest,
  type HttpResponse,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type PrMergeability,
  type AutoMergeSetting,
  type RequiredChecksInfo,
} from './host-pr';

// ─── HTTP seam fixture ───────────────────────────────────────────────────────

/**
 * Build a fake {@link HttpProbe} that answers each request with a canned
 * response chosen by a matcher, and records every request it received so a test
 * can assert ordering (e.g. find-before-create) and the zero-network contract.
 *
 * Each route is `[predicate, response]`; the first matching predicate wins.
 * An unmatched request resolves to `{ status: 404, json: null }` rather than
 * hitting the network — there is no `fetch` anywhere in this file.
 */
function fakeProbe(
  routes: Array<[(req: HttpRequest) => boolean, HttpResponse]>,
): { http: HttpProbe; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const http: HttpProbe = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      calls.push(req);
      for (const [match, res] of routes) {
        if (match(req)) return res;
      }
      return { status: 404, json: null };
    },
  };
  return { http, calls };
}

const isGet = (req: HttpRequest) => req.method === 'GET';
const isPost = (req: HttpRequest) => req.method === 'POST';
const urlHas = (frag: string) => (req: HttpRequest) => req.url.includes(frag);

// ─── detectHost (pure, no seam) ──────────────────────────────────────────────

describe('detectHost', () => {
  it('parses a GitHub SSH remote', () => {
    expect(detectHost('git@github.com:acme/widgets.git')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('parses a GitHub HTTPS remote', () => {
    expect(detectHost('https://github.com/acme/widgets.git')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('parses a Bitbucket SSH remote', () => {
    expect(
      detectHost('git@bitbucket.org:acme-team/nx-ui.git'),
    ).toEqual({
      host: 'bitbucket',
      workspace: 'acme-team',
      repo: 'nx-ui',
    });
  });

  it('parses a Bitbucket HTTPS remote', () => {
    expect(
      detectHost('https://bitbucket.org/acme-team/nx-ui.git'),
    ).toEqual({
      host: 'bitbucket',
      workspace: 'acme-team',
      repo: 'nx-ui',
    });
  });

  it('strips the trailing .git and tolerates a missing .git suffix', () => {
    expect(detectHost('https://github.com/acme/widgets')).toEqual({
      host: 'github',
      workspace: 'acme',
      repo: 'widgets',
    });
  });

  it('tolerates inline HTTPS credentials and a trailing slash', () => {
    expect(detectHost('https://user@bitbucket.org/ws/repo.git/')).toEqual({
      host: 'bitbucket',
      workspace: 'ws',
      repo: 'repo',
    });
  });

  it('returns unknown for a non-supported host (GitLab)', () => {
    expect(detectHost('git@gitlab.com:acme/widgets.git')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
  });

  it('returns unknown for junk / empty / local-path input', () => {
    expect(detectHost('not a url')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
    expect(detectHost('')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
    expect(detectHost('/Users/me/repos/widgets')).toEqual({
      host: 'unknown',
      workspace: '',
      repo: '',
    });
  });
});

// ─── verifyAuth ──────────────────────────────────────────────────────────────

describe('verifyAuth', () => {
  it('returns ok:true with the identity on a 200 (Bitbucket GET /2.0/user)', async () => {
    const { http, calls } = fakeProbe([
      [
        urlHas('api.bitbucket.org/2.0/user'),
        { status: 200, json: { username: 'svc-bot' } },
      ],
    ]);
    const r = await verifyAuth('bitbucket', { auth: 'u:p' }, { http });
    expect(r).toEqual({ ok: true, identity: 'svc-bot' });
    // Exactly one network call, and it was the preflight GET.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('returns ok:true for GitHub via GET /user, reading the login field', async () => {
    const { http } = fakeProbe([
      [
        urlHas('api.github.com/user'),
        { status: 200, json: { login: 'octocat' } },
      ],
    ]);
    const r = await verifyAuth('github', { auth: 'u:t' }, { http });
    expect(r).toEqual({ ok: true, identity: 'octocat' });
  });

  it('returns ok:false with the status on a 401', async () => {
    const { http } = fakeProbe([
      [urlHas('/user'), { status: 401, json: null }],
    ]);
    const r = await verifyAuth('bitbucket', { auth: 'u:wrong' }, { http });
    expect(r).toEqual({ ok: false, status: 401 });
  });

  it('falls back to the supplied username when the body carries no identity', async () => {
    const { http } = fakeProbe([[urlHas('/user'), { status: 200, json: {} }]]);
    const r = await verifyAuth(
      'bitbucket',
      { auth: 'u:p', username: 'hinted' },
      { http },
    );
    expect(r).toEqual({ ok: true, identity: 'hinted' });
  });

  it('returns ok:false for an unknown host without making a request', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await verifyAuth('unknown', { auth: 'u:p' }, { http });
    expect(r).toEqual({ ok: false, status: 0 });
    expect(calls).toHaveLength(0);
  });
});

// ─── findOpenPr ──────────────────────────────────────────────────────────────

describe('findOpenPr', () => {
  it('returns the URL on a hit (Bitbucket values[0].links.html.href)', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: {
            values: [
              {
                links: {
                  html: {
                    href: 'https://bitbucket.org/ws/repo/pull-requests/7',
                  },
                },
              },
            ],
          },
        },
      ],
    ]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBe('https://bitbucket.org/ws/repo/pull-requests/7');
  });

  it('returns null on a miss (empty values array)', async () => {
    const { http } = fakeProbe([
      [isGet, { status: 200, json: { values: [] } }],
    ]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBeNull();
  });

  it('returns the URL on a GitHub hit (array of PRs, html_url)', async () => {
    const { http } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: [{ html_url: 'https://github.com/acme/w/pull/9' }],
        },
      ],
    ]);
    const r = await findOpenPr(
      'github',
      { auth: 'u:t' },
      'feat/x',
      { workspace: 'acme', repo: 'w' },
      { http },
    );
    expect(r).toBe('https://github.com/acme/w/pull/9');
  });

  it('returns null when the query itself fails (non-200)', async () => {
    const { http } = fakeProbe([[isGet, { status: 500, json: null }]]);
    const r = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'b',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(r).toBeNull();
  });
});

// ─── createPr ────────────────────────────────────────────────────────────────

const createReq = {
  branch: 'wave-orch/56-host-pr',
  title: '[wave] host-pr',
  body: 'Closes #56',
  destination: 'main',
  info: { host: 'bitbucket' as const, workspace: 'ws', repo: 'repo' },
};

describe('createPr', () => {
  it('returns the real URL on a 201 (Bitbucket)', async () => {
    const { http, calls } = fakeProbe([
      [
        isPost,
        {
          status: 201,
          json: {
            links: {
              html: { href: 'https://bitbucket.org/ws/repo/pull-requests/12' },
            },
          },
        },
      ],
    ]);
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect(r).toEqual({
      url: 'https://bitbucket.org/ws/repo/pull-requests/12',
    });
    expect(calls[0].method).toBe('POST');
    // The serialised body carries the close_source_branch flag + destination.
    const sent = JSON.parse(calls[0].body ?? '{}');
    expect(sent.close_source_branch).toBe(true);
    expect(sent.destination.branch.name).toBe('main');
    expect(sent.source.branch.name).toBe('wave-orch/56-host-pr');
  });

  it('returns the real URL on a 201 (GitHub)', async () => {
    const { http } = fakeProbe([
      [
        isPost,
        { status: 201, json: { html_url: 'https://github.com/acme/w/pull/3' } },
      ],
    ]);
    const r = await createPr(
      'github',
      { auth: 'u:t' },
      { ...createReq, info: { host: 'github', workspace: 'acme', repo: 'w' } },
      { http },
    );
    expect(r).toEqual({ url: 'https://github.com/acme/w/pull/3' });
  });

  it('returns the pre-fill fallback signal on a 401 (a value, not a throw)', async () => {
    const { http } = fakeProbe([[isPost, { status: 401, json: null }]]);
    const r = await createPr('bitbucket', { auth: 'u:wrong' }, createReq, {
      http,
    });
    expect('url' in r).toBe(false);
    if ('error' in r) {
      expect(r.error).toContain('401');
      expect(r.fallbackPrefillUrl).toBe(
        'https://bitbucket.org/ws/repo/pull-requests/new?source=wave-orch%2F56-host-pr&t=1',
      );
    }
  });

  it('returns the pre-fill fallback on any non-2xx failure', async () => {
    const { http } = fakeProbe([[isPost, { status: 500, json: null }]]);
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect(
      'error' in r && r.fallbackPrefillUrl.includes('/pull-requests/new'),
    ).toBe(true);
  });

  it('returns the pre-fill fallback (not a throw) when the probe itself rejects', async () => {
    const http: HttpProbe = {
      request: () => Promise.reject(new Error('network down')),
    };
    const r = await createPr('bitbucket', { auth: 'u:p' }, createReq, { http });
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.error).toContain('network down');
      expect(r.fallbackPrefillUrl).toContain('/pull-requests/new');
    }
  });

  it('returns a GitHub pre-fill URL on GitHub failure', async () => {
    const { http } = fakeProbe([[isPost, { status: 422, json: null }]]);
    const r = await createPr(
      'github',
      { auth: 'u:t' },
      { ...createReq, info: { host: 'github', workspace: 'acme', repo: 'w' } },
      { http },
    );
    expect('error' in r).toBe(true);
    if ('error' in r) {
      expect(r.fallbackPrefillUrl).toBe(
        'https://github.com/acme/w/pull/new/wave-orch%2F56-host-pr',
      );
    }
  });

  it('falls back when an unknown host is asked to create a PR (no network)', async () => {
    const { http, calls } = fakeProbe([]);
    const r = await createPr(
      'unknown',
      { auth: 'u:p' },
      { ...createReq, info: { host: 'unknown', workspace: '', repo: '' } },
      { http },
    );
    expect('error' in r).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ─── Idempotency contract: find-before-create ────────────────────────────────

describe('find-before-create idempotency', () => {
  it('an open PR found by findOpenPr short-circuits createPr (no duplicate POST)', async () => {
    // Simulate the terminator's sequence: find first, only POST on a miss.
    const { http, calls } = fakeProbe([
      [
        isGet,
        {
          status: 200,
          json: {
            values: [
              {
                links: {
                  html: {
                    href: 'https://bitbucket.org/ws/repo/pull-requests/7',
                  },
                },
              },
            ],
          },
        },
      ],
      [
        isPost,
        {
          status: 201,
          json: { links: { html: { href: 'SHOULD-NOT-BE-USED' } } },
        },
      ],
    ]);

    const existing = await findOpenPr(
      'bitbucket',
      { auth: 'u:p' },
      'wave-orch/56-host-pr',
      { workspace: 'ws', repo: 'repo' },
      { http },
    );
    expect(existing).toBe('https://bitbucket.org/ws/repo/pull-requests/7');

    // Caller would skip createPr — assert only the GET happened.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ─── Landing: arm | merge | status (ADR-0023) ────────────────────────────────

/**
 * Fake {@link LandingHost}. The landing logic under test is host-NEUTRAL — it
 * routes on `PrMergeability` and on the two typed errors, never on GitHub
 * specifics — so a hand-rolled fake is the whole seam. Zero network.
 *
 * `statuses`, when given, answers `getPrStatus` from a QUEUE — call 1 gets
 * `statuses[0]`, call 2 gets `statuses[1]`, etc., sticking on the last entry
 * once exhausted. Models a mergeability that resolves over a few probes
 * (the W10-F1 behind/recomputing race) without needing a real clock; `status`
 * (singular) stays the fixed-answer form every existing test already uses.
 */
function fakeLandingHost(opts: {
  status?: PrLandingStatus;
  statuses?: PrLandingStatus[];
  onEnableAutoMerge?: () => void;
  onMerge?: () => MergeResult;
}): { host: LandingHost; calls: string[] } {
  const calls: string[] = [];
  let statusCall = 0;
  const host: LandingHost = {
    async getPrStatus(branch: string): Promise<PrLandingStatus> {
      calls.push(`getPrStatus:${branch}`);
      if (opts.statuses !== undefined) {
        const next = opts.statuses[Math.min(statusCall, opts.statuses.length - 1)];
        statusCall++;
        return next;
      }
      return opts.status ?? { state: 'none' };
    },
    async enableAutoMerge(prNumber: number, method?: MergeMethod): Promise<void> {
      calls.push(`enableAutoMerge:${prNumber}:${method ?? ''}`);
      opts.onEnableAutoMerge?.();
    },
    async mergePullRequest(prNumber: number, method?: MergeMethod): Promise<MergeResult> {
      calls.push(`mergePullRequest:${prNumber}:${method ?? ''}`);
      return opts.onMerge?.() ?? { merged: true, sha: 'deadbeef' };
    },
  };
  return { host, calls };
}

const openPr = (mergeability: PrMergeability): PrLandingStatus => ({
  state: 'open',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  mergeability,
});

/** No-op {@link ArmOptions.sleep} — keeps recompute-retry specs hermetic and fast. */
const instantSleep: NonNullable<ArmOptions['sleep']> = async () => {};

describe('alignedPrRef (FOR-54 — one url/number field name across every verb)', () => {
  it('projects a url onto BOTH `url` and `prUrl`', () => {
    expect(alignedPrRef({ url: 'https://x/pull/7' })).toEqual({
      url: 'https://x/pull/7',
      prUrl: 'https://x/pull/7',
    });
  });

  it('projects a number onto BOTH `number` and `prNumber`', () => {
    expect(alignedPrRef({ number: 42 })).toEqual({ number: 42, prNumber: 42 });
  });

  it('carries a url AND a number under all four aligned names (the status/arm/merge shape)', () => {
    expect(alignedPrRef({ url: 'u', number: 9 })).toEqual({
      url: 'u',
      prUrl: 'u',
      number: 9,
      prNumber: 9,
    });
  });

  it('omits an absent number entirely — the documented `create` shape (url only, no number)', () => {
    const ref = alignedPrRef({ url: 'u' });
    expect(ref).toEqual({ url: 'u', prUrl: 'u' });
    // ABSENT keys, not `undefined` values — so JSON.stringify drops them too.
    expect('number' in ref).toBe(false);
    expect('prNumber' in ref).toBe(false);
  });

  it('an empty ref (the `no-pr` outcome) yields no fields at all', () => {
    expect(alignedPrRef({})).toEqual({});
  });

  it('a number of 0 is preserved (not treated as absent)', () => {
    expect(alignedPrRef({ number: 0 })).toEqual({ number: 0, prNumber: 0 });
  });
});

describe('decideArmAction (ADR-0023 deterministic arm intent)', () => {
  it('clean → direct merge (nothing pending; arming a clean PR is rejected by the host)', () => {
    expect(decideArmAction('clean')).toMatchObject({ action: 'merge' });
  });

  it.each<PrMergeability>(['blocked', 'unstable', 'behind', 'unknown'])(
    '%s → enable-auto-merge (checks may still land)',
    (m) => {
      expect(decideArmAction(m)).toMatchObject({ action: 'enable-auto-merge' });
    },
  );

  it.each<PrMergeability>(['dirty', 'draft'])(
    '%s → refuse (no host action can land it — a human must act)',
    (m) => {
      expect(decideArmAction(m)).toMatchObject({ action: 'refuse' });
    },
  );

  it('every decision carries a non-empty human reason', () => {
    const all: PrMergeability[] = ['clean', 'blocked', 'unstable', 'behind', 'unknown', 'dirty', 'draft'];
    for (const m of all) expect(decideArmAction(m).reason.length).toBeGreaterThan(0);
  });
});

describe('armPullRequest', () => {
  it('clean PR → merges directly, never arms', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('clean') });
    const out = await armPullRequest(host, 'wave/FOR-26-x');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42, sha: 'deadbeef' });
    expect(calls).toEqual(['getPrStatus:wave/FOR-26-x', 'mergePullRequest:42:squash']);
  });

  it('blocked PR (required checks pending) → arms, never merges directly', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'armed', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('defaults to the squash merge method and honours an explicit override', async () => {
    expect(DEFAULT_MERGE_METHOD).toBe('squash');
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    await armPullRequest(host, 'b', 'rebase');
    expect(calls).toContain('enableAutoMerge:42:rebase');
  });

  it('an already-merged PR is an idempotent no-op (re-running wave-close never re-merges)', async () => {
    const { host, calls } = fakeLandingHost({
      status: { state: 'merged', number: 42, url: 'https://github.com/acme/widgets/pull/42' },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'already-merged', prUrl: 'https://github.com/acme/widgets/pull/42' });
    expect(calls).toEqual(['getPrStatus:b']); // no write of any kind
  });

  it('no PR for the branch → no-pr, no writes', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'none' } });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'no-pr' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('a closed-unmerged PR is refused, never re-opened or merged', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'closed-unmerged', number: 42 } });
    expect(await armPullRequest(host, 'b')).toMatchObject({ outcome: 'refused' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('a dirty (conflicted) PR is refused with a reason', async () => {
    const { host } = fakeLandingHost({ status: openPr('dirty') });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused' });
    expect((out as { reason: string }).reason).toMatch(/conflict/i);
  });

  it('an open PR with no mergeability reported is treated as unknown → armed (never blind-merged)', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'open', number: 42 } });
    // 'unknown' is a recomputing read too — inject an instant sleep so the
    // default retry (which never resolves against a fixed fake) stays fast.
    expect(await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep })).toMatchObject({
      outcome: 'armed',
    });
    expect(calls).toContain('enableAutoMerge:42:squash');
  });

  // ── Spike 2: arming an already-clean PR ─────────────────────────────────
  it('SPIKE-2: arm rejected with reason "clean-status" → falls back to a direct merge', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unknown'), // host had not computed mergeability → we arm…
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    // …the host says "it is already clean" → the deterministic recovery is to merge.
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    // 'unknown' also triggers the default recompute retry (2 extra probes,
    // instant here) before the arm is even attempted; still never resolves
    // against the fixed fake, so it decides on the last-known read.
    expect(calls).toEqual([
      'getPrStatus:b',
      'getPrStatus:b',
      'getPrStatus:b',
      'enableAutoMerge:42:squash',
      'mergePullRequest:42:squash',
    ]);
  });

  it('arm rejected with reason "not-allowed" (repo setting off) + a pending required check (blocked) → refused, NOT merged', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'refused' });
    // The whole point (AC3, ADR-0023 amendment): a repo with auto-merge OFF
    // must NOT silently become an immediate merge of a PR whose required
    // checks are still pending — the controlled-degrade fallback below NEVER
    // fires while mergeability is `blocked`.
    expect(calls).not.toContain('mergePullRequest:42:squash');
    expect((out as { reason: string }).reason).toMatch(/allow auto-merge/i);
  });

  it('an unexpected host error propagates (never swallowed into a false "armed")', async () => {
    const { host } = fakeLandingHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new Error('HTTP 500');
      },
    });
    await expect(armPullRequest(host, 'b')).rejects.toThrow('HTTP 500');
  });
});

// ─── Recompute retry (AC2, ADR-0023 amendment / W10-F1) ──────────────────────

describe('armPullRequest — recompute retry on a transient behind/recomputing read', () => {
  it('a transient behind read resolves to clean via retry — never wastes an arm attempt', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('behind'), openPr('behind'), openPr('clean')],
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'getPrStatus:b', 'getPrStatus:b', 'mergePullRequest:42:squash']);
    expect(calls).not.toContain('enableAutoMerge:42:squash');
  });

  it('an unresolved recompute after the retry budget proceeds with the last-known read (never blocks indefinitely)', async () => {
    const { host, calls } = fakeLandingHost({ statuses: [openPr('unknown')] }); // never settles
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'armed' });
    // Default budget: the initial read + 2 retries = 3 probes, then decide.
    expect(calls.filter((c) => c.startsWith('getPrStatus'))).toHaveLength(3);
    expect(calls).toContain('enableAutoMerge:42:squash');
  });

  it('recomputeRetries is honoured — 0 decides on the very first read', async () => {
    const { host, calls } = fakeLandingHost({ statuses: [openPr('behind')] });
    await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep, recomputeRetries: 0 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('a PR that reaches a terminal state during the retry window is reported honestly, never re-armed', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [
        openPr('behind'),
        { state: 'merged', number: 42, url: 'https://github.com/acme/widgets/pull/42' },
      ],
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'already-merged' });
    expect(calls).not.toContain('enableAutoMerge:42:squash');
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('N-PR sequential arm: a PR briefly behind right after a sibling merged still lands, no refusal (W10-F1)', async () => {
    // PR #1 reads clean immediately and merges directly (mirrors the live #9).
    const { host: host1 } = fakeLandingHost({ status: openPr('clean') });
    expect(await armPullRequest(host1, 'wave/pr-1')).toMatchObject({ outcome: 'merged' });

    // PR #2: the base just moved out from under it — briefly `behind`,
    // resolving to `clean` on retry, exactly as the retro's #10 did ("an
    // idempotent retry landed #10, in the window again clean").
    const { host: host2, calls: calls2 } = fakeLandingHost({
      statuses: [openPr('behind'), openPr('clean')],
    });
    const out2 = await armPullRequest(host2, 'wave/pr-2', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out2).toMatchObject({ outcome: 'merged' });
    expect(calls2).not.toContain('enableAutoMerge:42:squash');
  });

  it('the default recompute delay is a real timer in production (no injected sleep) — not synchronous', async () => {
    vi.useFakeTimers();
    try {
      const { host, calls } = fakeLandingHost({ statuses: [openPr('behind'), openPr('clean')] });
      const pending = armPullRequest(host, 'b'); // no opts — exercises defaultSleep for real
      await vi.advanceTimersByTimeAsync(0);
      // Still waiting on the timer: only the initial probe has happened.
      expect(calls).toEqual(['getPrStatus:b']);
      await vi.advanceTimersByTimeAsync(1000); // comfortably covers the default delay
      const out = await pending;
      expect(out).toMatchObject({ outcome: 'merged' });
      expect(calls).toEqual(['getPrStatus:b', 'getPrStatus:b', 'mergePullRequest:42:squash']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Controlled degrade: refused + zero pending required checks (AC1/AC3) ────

describe('armPullRequest — refused+mergeable controlled degrade (ADR-0023 amendment, W10-F1)', () => {
  it('not-allowed refusal + zero pending required checks (unstable) → falls back to a direct merge, reason names the fallback (the live refused-then-merged sequence)', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash', 'mergePullRequest:42:squash']);
    expect((out as { reason: string }).reason).toMatch(/controlled degrade/i);
    expect((out as { reason: string }).reason).toMatch(/does not permit auto-merge/i);
  });

  it('not-allowed refusal + a still-behind read after the retry budget → also falls back (zero pending required checks)', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('behind')], // never resolves away from `behind`
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('clean-status refusal stays an UNCONDITIONAL fallback (SPIKE 2 unaffected by the new gate)', async () => {
    const { host, calls } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('clean-status', 'Pull request is in clean status');
      },
    });
    const out = await armPullRequest(host, 'b');
    expect(out).toMatchObject({ outcome: 'merged' });
    expect(calls).toContain('mergePullRequest:42:squash');
  });

  it('NEGATIVE SPEC (AC3): not-allowed refusal + a pending required check — even one only revealed after the recompute retry — NEVER falls back; refused stays refused', async () => {
    const { host, calls } = fakeLandingHost({
      statuses: [openPr('unknown'), openPr('blocked')], // recompute settles into a REAL block
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const out = await armPullRequest(host, 'b', DEFAULT_MERGE_METHOD, { sleep: instantSleep });
    expect(out).toMatchObject({ outcome: 'refused' });
    // The whole point of the gate: a required check IS pending — merging here
    // would land a PR past exactly the check the human expected to hold.
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('a merge the host declines during the fallback (merged:false) is still reported as refused, not merged', async () => {
    const { host } = fakeLandingHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
      onMerge: () => ({ merged: false }),
    });
    const out = await armPullRequest(host, 'b');
    // The host is the FINAL gate even inside the fallback: a decline is a
    // decline, never silently upgraded to a false "merged".
    expect(out).toMatchObject({ outcome: 'refused' });
  });
});

describe('mergePullRequestNow (the `merge` verb — no arming, no decision)', () => {
  it('merges an open PR regardless of pending checks', async () => {
    const { host, calls } = fakeLandingHost({ status: openPr('blocked') });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'merged', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
  });

  it('is idempotent on an already-merged PR', async () => {
    const { host, calls } = fakeLandingHost({ status: { state: 'merged', number: 42 } });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'already-merged' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('no PR → no-pr, no writes', async () => {
    const { host } = fakeLandingHost({ status: { state: 'none' } });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'no-pr' });
  });

  it('reports a merge the host declined (merged:false) as refused, not merged', async () => {
    const { host } = fakeLandingHost({
      status: openPr('blocked'),
      onMerge: () => ({ merged: false }),
    });
    expect(await mergePullRequestNow(host, 'b')).toMatchObject({ outcome: 'refused' });
  });
});

describe('LandingNotImplementedError', () => {
  it('is typed with a stable code + names the host', () => {
    const err = new LandingNotImplementedError('bitbucket');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('adapter-not-implemented');
    expect(err.host).toBe('bitbucket');
    expect(err.message).toMatch(/bitbucket/);
  });

  it('a NAMED host is told an adapter can be written for it', () => {
    expect(new LandingNotImplementedError('bitbucket').message).toMatch(/LandingHost/);
  });

  it('an UNKNOWN host is told the remote was unparseable — not to "write an unknown adapter"', () => {
    const err = new LandingNotImplementedError('unknown');
    expect(err.code).toBe('adapter-not-implemented');
    // The actionable fact for an unrecognised remote is that the REMOTE could
    // not be identified; advising "implement a LandingHost for 'unknown'" is
    // nonsense (and reads as broken English).
    expect(err.message).toMatch(/remote/i);
    expect(err.message).not.toMatch(/A unknown/);
  });
});

// ─── preflightHost (ADR-0023 amendment — code-host posture probe) ─────────────
//
// The pure GRADING matrix, driven by a fake LandingPosture (no network, no
// GitHub adapter). The CLI wiring (detect-host routing, $GITHUB_TOKEN build,
// store-blindness) is host-pr-cli.spec.ts's job; this covers what each posture
// grades to.

const REQUIRED_PRESENT: RequiredChecksInfo = {
  state: 'present',
  contexts: ['ci/test', 'ci/lint'],
  detail: 'Branch requires 2 checks.',
};
const REQUIRED_ABSENT: RequiredChecksInfo = {
  state: 'absent',
  contexts: [],
  detail: 'Branch has no required status checks.',
};
const REQUIRED_UNKNOWN: RequiredChecksInfo = {
  state: 'unknown',
  contexts: [],
  detail: 'Could not read branch protection — needs admin (HTTP 403). Advisory only.',
};

function fakePosture(opts: {
  canMerge?: boolean;
  autoMerge?: AutoMergeSetting;
  required?: RequiredChecksInfo;
  onGetRequiredChecks?: (branch?: string) => void;
}): LandingPosture {
  return {
    async canMergePullRequests() {
      return opts.canMerge ?? true;
    },
    async getAutoMergeSetting() {
      return opts.autoMerge ?? 'on';
    },
    async getRequiredChecks(branch?: string) {
      opts.onGetRequiredChecks?.(branch);
      return opts.required ?? REQUIRED_ABSENT;
    },
  };
}

const byName = (checks: { name: string; status: string; detail: string }[]) =>
  Object.fromEntries(checks.map((c) => [c.name, c]));

describe('preflightHost (ADR-0023 amendment posture grading)', () => {
  it('reports exactly the three code-host checks and echoes the host', async () => {
    const report = await preflightHost('github', fakePosture({ autoMerge: 'on', required: REQUIRED_ABSENT }));
    expect(report.host).toBe('github');
    expect(report.checks.map((c) => c.name)).toEqual(['pr-merge-token', 'allow-auto-merge', 'required-checks']);
  });

  it('reads required-checks against the DEFAULT branch (no branch argument)', async () => {
    let seen: string | undefined | 'UNCALLED' = 'UNCALLED';
    await preflightHost('github', fakePosture({ onGetRequiredChecks: (b) => (seen = b) }));
    expect(seen).toBeUndefined(); // called with no arg → the default branch
  });

  describe('pr-merge-token', () => {
    it('pass when the token can merge', async () => {
      const report = await preflightHost('github', fakePosture({ canMerge: true }));
      expect(byName(report.checks)['pr-merge-token'].status).toBe('pass');
    });

    it('FAIL (ok:false) with a write-access instruction when it cannot', async () => {
      const report = await preflightHost('github', fakePosture({ canMerge: false }));
      const c = byName(report.checks)['pr-merge-token'];
      expect(c.status).toBe('fail');
      expect(c.detail).toMatch(/write/i);
      expect(report.ok).toBe(false);
    });
  });

  describe('allow-auto-merge', () => {
    it('ON → pass', async () => {
      const report = await preflightHost('github', fakePosture({ autoMerge: 'on', required: REQUIRED_PRESENT }));
      expect(byName(report.checks)['allow-auto-merge'].status).toBe('pass');
      expect(report.ok).toBe(true);
    });

    it('a visible OFF with required checks present → FAIL (ok:false) + the fix instruction', async () => {
      const report = await preflightHost('github', fakePosture({ autoMerge: 'off', required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('fail');
      expect(c.detail).toMatch(/Settings/);
      expect(c.detail).toMatch(/auto-merge/i);
      expect(report.ok).toBe(false); // structurally impossible to arm those rows
    });

    it('a visible OFF with NO required checks → advisory (a clean PR direct-merges today), never blocks', async () => {
      const report = await preflightHost('github', fakePosture({ autoMerge: 'off', required: REQUIRED_ABSENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('advisory');
      expect(report.ok).toBe(true);
    });

    it('UNKNOWN (the token cannot see it) → unknown, never blocks, detail carries the manual-verify/permission fix and demands no admin', async () => {
      const report = await preflightHost('github', fakePosture({ autoMerge: 'unknown', required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['allow-auto-merge'];
      expect(c.status).toBe('unknown');
      expect(report.ok).toBe(true); // absence of evidence is not a finding
      expect(c.detail).toMatch(/maintain\/admin|cannot see/i);
      expect(c.detail).toMatch(/no admin|needs no admin/i);
      expect(c.detail).toMatch(/Settings|verify by hand/i);
    });
  });

  describe('required-checks', () => {
    it('present → advisory, names the contexts, and says --auto will ARM', async () => {
      const report = await preflightHost('github', fakePosture({ required: REQUIRED_PRESENT }));
      const c = byName(report.checks)['required-checks'];
      expect(c.status).toBe('advisory');
      expect(c.detail).toContain('ci/test');
      expect(c.detail).toMatch(/ARM/);
    });

    it('absent → advisory, states that confirming means an IMMEDIATE merge', async () => {
      const report = await preflightHost('github', fakePosture({ required: REQUIRED_ABSENT }));
      const c = byName(report.checks)['required-checks'];
      expect(c.status).toBe('advisory');
      expect(c.detail).toMatch(/immediate/i);
    });

    it('unknown → unknown (report-only), never blocks', async () => {
      const report = await preflightHost('github', fakePosture({ required: REQUIRED_UNKNOWN }));
      expect(byName(report.checks)['required-checks'].status).toBe('unknown');
      expect(report.ok).toBe(true);
    });
  });

  it('unknown + advisory NEVER drag ok to false — only a fail blocks', async () => {
    const report = await preflightHost(
      'github',
      fakePosture({ canMerge: true, autoMerge: 'unknown', required: REQUIRED_UNKNOWN }),
    );
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.status).sort()).toEqual(['pass', 'unknown', 'unknown']);
  });
});
