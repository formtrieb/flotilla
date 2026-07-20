/**
 * host-pr-cli.spec.ts — the `host-pr arm | merge | status` verb group (FOR-26 /
 * ADR-0023).
 *
 * Two things are under test, and only these two — the runner is a THIN router:
 *   1. **detect-host routing.** github → the GitHub landing adapter; bitbucket /
 *      unknown → a typed adapter-not-implemented exit. Driven by `--remote`, so
 *      no git process and no network are touched.
 *   2. **The verb → engine mapping + exit codes.** The arm INTENT itself is
 *      host-pr.spec.ts's job; the request shaping is real-github-api.spec.ts's.
 *
 * Every test injects a LandingHost, so `createGitHubApiFromEnv` (which would do
 * a real `GET /user` preflight) is never reached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHostPr } from './host-pr-cli';
import {
  AutoMergeUnavailableError,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type HttpProbe,
  type HttpRequest,
  type HttpResponse,
  type AutoMergeSetting,
  type RequiredChecksInfo,
} from './host-pr';

const GITHUB_REMOTE = 'git@github.com:example-org/example-repo.git';
const BITBUCKET_REMOTE = 'git@bitbucket.org:example-team/example-repo.git';
const UNKNOWN_REMOTE = 'git@gitlab.com:example-org/example-repo.git';

function fakeHost(opts: {
  status?: PrLandingStatus;
  onEnableAutoMerge?: () => void;
  onMerge?: () => MergeResult;
}): { host: LandingHost; calls: string[] } {
  const calls: string[] = [];
  const host: LandingHost = {
    async getPrStatus(branch) {
      calls.push(`getPrStatus:${branch}`);
      return opts.status ?? { state: 'none' };
    },
    async enableAutoMerge(n: number, m?: MergeMethod) {
      calls.push(`enableAutoMerge:${n}:${m ?? ''}`);
      opts.onEnableAutoMerge?.();
    },
    async mergePullRequest(n: number, m?: MergeMethod) {
      calls.push(`mergePullRequest:${n}:${m ?? ''}`);
      return opts.onMerge?.() ?? { merged: true, sha: 'sha1' };
    },
  };
  return { host, calls };
}

const openPr = (mergeability: PrLandingStatus['mergeability']): PrLandingStatus => ({
  state: 'open',
  number: 42,
  url: 'https://github.com/example-org/example-repo/pull/42',
  mergeability,
});

let stdout = '';
let stderr = '';

beforeEach(() => {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    stdout += String(c);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
    stderr += String(c);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const out = (): Record<string, unknown> => JSON.parse(stdout);

describe('host-pr routing (detect-host)', () => {
  it('bitbucket → exit 1 with a typed adapter-not-implemented payload, and NO host call', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);

    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'bitbucket' });
    // The ROUTER decides by host — an injected adapter must not smuggle a
    // bitbucket wave onto the GitHub path.
    expect(calls).toEqual([]);
  });

  it('an unknown host (GitLab) → exit 1, adapter-not-implemented', async () => {
    const { host } = fakeHost({});
    const code = await runHostPr(['status', '--branch', 'b', '--remote', UNKNOWN_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
  });

  it('the not-implemented message names the host and points at the LandingHost seam', async () => {
    const { host } = fakeHost({});
    await runHostPr(['merge', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(String(out().error)).toMatch(/bitbucket/);
    expect(String(out().error)).toMatch(/LandingHost|adapter/i);
  });
});

describe('host-pr status', () => {
  it('reports an open PR + its mergeability, exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(['status', '--branch', 'wave/FOR-26-x', '--remote', GITHUB_REMOTE], host);

    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'status',
      host: 'github',
      branch: 'wave/FOR-26-x',
      state: 'open',
      number: 42,
      mergeability: 'blocked',
    });
    expect(calls).toEqual(['getPrStatus:wave/FOR-26-x']); // read-only: no writes
  });

  it('reports a merged PR — the done-reconcile evidence probe (ADR-0023), exit 0', async () => {
    const { host } = fakeHost({ status: { state: 'merged', number: 9, url: 'u9' } });
    const code = await runHostPr(['status', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, state: 'merged', url: 'u9' });
  });

  it('state:none is a successful probe (exit 0), not an error — the caller reads `state`', async () => {
    const { host } = fakeHost({ status: { state: 'none' } });
    const code = await runHostPr(['status', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, state: 'none' });
  });
});

describe('host-pr arm', () => {
  it('a clean PR merges directly → outcome merged, exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, verb: 'arm', outcome: 'merged', prNumber: 42, sha: 'sha1' });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
  });

  it('a blocked PR arms → outcome armed, exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'armed', prNumber: 42 });
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
  });

  it('--method is forwarded to the host', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE, '--method', 'rebase'], host);
    expect(calls).toContain('enableAutoMerge:42:rebase');
  });

  it('an already-merged PR is an idempotent success (exit 0) — wave-close re-runs', async () => {
    const { host, calls } = fakeHost({ status: { state: 'merged', number: 42, url: 'u' } });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'already-merged' });
    expect(calls).toEqual(['getPrStatus:b']);
  });

  it('no PR for the branch → exit 1, outcome no-pr', async () => {
    const { host } = fakeHost({ status: { state: 'none' } });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, outcome: 'no-pr' });
  });

  it('a conflicted PR → exit 1, outcome refused, reason surfaced', async () => {
    const { host } = fakeHost({ status: openPr('dirty') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, outcome: 'refused' });
    expect(String(out().reason)).toMatch(/conflict/i);
  });

  it('a repo with auto-merge OFF and a pending required check (blocked) → refused (exit 1) with the fix instruction, never merged', async () => {
    const { host, calls } = fakeHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'Auto merge is not allowed for this repository');
      },
    });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, outcome: 'refused' });
    expect(String(out().reason)).toMatch(/allow auto-merge/i);
    expect(calls).not.toContain('mergePullRequest:42:squash');
  });

  it('a repo with auto-merge OFF but ZERO pending required checks (unstable) → controlled degrade to a direct merge, exit 0 (the live refused-then-merged sequence, ADR-0023 amendment / W10-F1)', async () => {
    const { host, calls } = fakeHost({
      status: openPr('unstable'),
      onEnableAutoMerge: () => {
        throw new AutoMergeUnavailableError('not-allowed', 'The repository does not permit auto-merge');
      },
    });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'merged', prNumber: 42 });
    expect(String(out().reason)).toMatch(/controlled degrade/i);
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash', 'mergePullRequest:42:squash']);
  });

  it('an unexpected host error → exit 1 with the message on stderr, never a false success', async () => {
    const { host } = fakeHost({
      status: openPr('blocked'),
      onEnableAutoMerge: () => {
        throw new Error('HTTP 502 upstream');
      },
    });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(1);
    expect(stderr).toMatch(/HTTP 502 upstream/);
  });
});

describe('host-pr merge', () => {
  it('merges a blocked PR without arming (the human already decided), exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(['merge', '--branch', 'b', '--remote', GITHUB_REMOTE], host);

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, verb: 'merge', outcome: 'merged' });
    expect(calls).toEqual(['getPrStatus:b', 'mergePullRequest:42:squash']);
    expect(calls).not.toContain('enableAutoMerge:42:squash');
  });

  it('is idempotent on an already-merged PR (exit 0)', async () => {
    const { host } = fakeHost({ status: { state: 'merged', number: 42 } });
    expect(await runHostPr(['merge', '--branch', 'b', '--remote', GITHUB_REMOTE], host)).toBe(0);
    expect(out()).toMatchObject({ outcome: 'already-merged' });
  });
});

describe('host-pr usage errors (exit 2)', () => {
  it('no verb → 2', async () => {
    expect(await runHostPr([])).toBe(2);
    expect(stderr).toMatch(/usage/);
  });

  it('an unknown verb → 2 and names the real verbs (create, arm, merge, status, preflight)', async () => {
    expect(await runHostPr(['bogus', '--branch', 'b'])).toBe(2);
    expect(stderr).toMatch(/create/);
    expect(stderr).toMatch(/arm/);
    expect(stderr).toMatch(/merge/);
    expect(stderr).toMatch(/status/);
    expect(stderr).toMatch(/preflight/);
  });

  it('a missing --branch → 2', async () => {
    expect(await runHostPr(['arm', '--remote', GITHUB_REMOTE])).toBe(2);
    expect(stderr).toMatch(/--branch/);
  });

  it('an invalid --method → 2 (never silently downgraded to squash)', async () => {
    expect(await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE, '--method', 'fast-forward'])).toBe(2);
    expect(stderr).toMatch(/squash/);
  });

  it('usage errors are decided BEFORE the host is routed or built', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    await runHostPr(['arm', '--remote', GITHUB_REMOTE], host);
    expect(calls).toEqual([]);
  });
});

// ─── host-pr create (FOR-28 / ADR-0019 find-before-create) ──────────────────
//
// `create` is on the OTHER seam from arm/merge/status: the cross-host Basic-auth
// `HttpProbe` (findOpenPr/createPr), not the LandingHost. Every path is driven by
// an injected HttpProbe + a fixture env — no git process, no real network, and
// no LandingHost. What is under test: find-before-create idempotency (reuse vs
// create), the close phrase surviving into the PR body, detect-host routing
// (github only; others fail loud+typed), and the create-specific usage guards.

const ENV = { GITHUB_TOKEN: 'test-token' } as NodeJS.ProcessEnv;

function fakeHttp(handlers: {
  get?: (url: string) => HttpResponse;
  post?: (url: string, body?: string) => HttpResponse;
  patch?: (url: string, body?: string) => HttpResponse;
}): { http: HttpProbe; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpProbe = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      if (req.method === 'GET') {
        return handlers.get?.(req.url) ?? { status: 200, json: [] };
      }
      if (req.method === 'PATCH') {
        // The reuse-time update (FOR-58). Default 200 = the PATCH landed.
        return handlers.patch?.(req.url, req.body) ?? { status: 200, json: {} };
      }
      return (
        handlers.post?.(req.url, req.body) ?? {
          status: 201,
          json: { html_url: 'https://github.com/example-org/example-repo/pull/1' },
        }
      );
    },
  };
  return { http, requests };
}

const EXISTING_PR = 'https://github.com/example-org/example-repo/pull/7';
const NEW_PR = 'https://github.com/example-org/example-repo/pull/8';

describe('host-pr create — find-before-create idempotency', () => {
  it('an OPEN PR already on the branch is reused (no create POST) and its body/title updated, exit 0', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7 }] }),
      post: () => {
        throw new Error('createPr must NOT be called when an open PR exists');
      },
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'B\n\nFixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'create',
      host: 'github',
      outcome: 'reused',
      updated: true,
      url: EXISTING_PR,
    });
    // Idempotent: find then update, and NO create POST (never a duplicate).
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
  });

  it('a cap=1 re-dispatch onto an existing branch reuses the already-open PR (never a duplicate)', async () => {
    // The exact operational scenario FOR-28 exists for: a second Worker runs on
    // the same branch. find-before-create returns the open PR — no second PR,
    // and its body/title are re-written to the re-dispatch's values (FOR-58).
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7 }] }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'reused', updated: true, url: EXISTING_PR });
    // Find + update, never a create POST.
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('the reuse PATCH carries the composed title/body verbatim — the terminator render lands on the open PR (FOR-58)', async () => {
    // The exact FOR-58 scenario: the terminator composes verdict-render + close
    // phrase; a Worker already opened the PR, so `create` hits the reused branch.
    // The composed body must reach the LIVE PR via the update, not be discarded.
    let patched: { url?: string; body?: string } = {};
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7 }] }),
      patch: (url, body) => {
        patched = { url, body };
        return { status: 200, json: {} };
      },
    });
    const composedBody = 'Summary line.\n\n## Reviewer verdict\napprove\n\nFixes EX-1';
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'Composed title', '--body', composedBody, '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'reused', updated: true });
    // The PATCH is addressed to the numbered pull and carries both authored fields.
    expect(patched.url).toBe('https://api.github.com/repos/example-org/example-repo/pulls/7');
    expect(JSON.parse(patched.body ?? '{}')).toEqual({ title: 'Composed title', body: composedBody });
  });

  it('a declined reuse update still re-pins the PR (ok:true, outcome reused) but discloses updated:false — never aborts the wave', async () => {
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7 }] }),
      patch: () => ({ status: 403, json: null }), // the host refuses the edit
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    // The reuse itself is still a success: the URL is re-pinned, no duplicate.
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'reused', updated: false, url: EXISTING_PR });
  });

  it('a reused PR whose find body carries no number re-pins the URL without a PATCH (updated:false, never a duplicate)', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR }] }), // no `number`
      post: () => {
        throw new Error('createPr must NOT be called when an open PR exists');
      },
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'reused', updated: false, url: EXISTING_PR });
    // No addressable number → no PATCH, and never a create POST.
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a missing PR is created — exit 0, outcome created, url returned', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [] }), // no open PR
      post: () => ({ status: 201, json: { html_url: NEW_PR } }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-2-y', '--title', 'Add thing', '--body', 'body\n\nCloses #42', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, verb: 'create', outcome: 'created', url: NEW_PR });
    // find first, then create.
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
  });

  it('the PR-create body carries the title + branch + base + the store-kind close phrase verbatim', async () => {
    let posted: string | undefined;
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: (_url, body) => {
        posted = body;
        return { status: 201, json: { html_url: NEW_PR } };
      },
    });
    await runHostPr(
      ['create', '--branch', 'wave/EX-3-z', '--title', 'Wire the verb', '--body', 'Summary line.\n\nFixes EX-3', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(posted).toBeDefined();
    const payload = JSON.parse(posted as string);
    expect(payload).toMatchObject({ title: 'Wire the verb', head: 'wave/EX-3-z', base: 'main' });
    // Convention 4: the close phrase lands in the PR body exactly as passed.
    expect(payload.body).toContain('Fixes EX-3');
    expect(payload.body).toBe('Summary line.\n\nFixes EX-3');
  });

  it('--base overrides the default destination branch', async () => {
    let posted: string | undefined;
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: (_url, body) => {
        posted = body;
        return { status: 201, json: { html_url: NEW_PR } };
      },
    });
    await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--base', 'develop', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(JSON.parse(posted as string)).toMatchObject({ base: 'develop' });
  });

  it('a PR-create failure (401) → exit 1, outcome create-failed, error + fallbackPrefillUrl', async () => {
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: () => ({ status: 401, json: {} }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-4-w', '--title', 'T', '--body', 'Fixes EX-4', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );

    expect(code).toBe(1);
    const o = out();
    expect(o).toMatchObject({ ok: false, verb: 'create', outcome: 'create-failed' });
    expect(String(o.error)).toMatch(/401|unauthor/i);
    expect(String(o.fallbackPrefillUrl)).toMatch(/github\.com\/example-org\/example-repo\/pull\/new/);
  });
});

describe('host-pr create — routing (detect-host, github only)', () => {
  it('bitbucket → exit 1, adapter-not-implemented, and NO http call', async () => {
    const { http, requests } = fakeHttp({
      get: () => {
        throw new Error('routing must reject a non-github host before any network');
      },
    });
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'x', '--remote', BITBUCKET_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'bitbucket' });
    expect(requests).toEqual([]);
  });

  it('an unknown host (GitLab) → exit 1, adapter-not-implemented', async () => {
    const { http } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'x', '--remote', UNKNOWN_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
  });
});

describe('host-pr create — usage + credential guards', () => {
  it('a missing --title → exit 2, decided BEFORE any host routing or network', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--body', 'x', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--title/);
    expect(requests).toEqual([]);
  });

  it('a missing --body → exit 2 (the body carries the close phrase)', async () => {
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--remote', GITHUB_REMOTE],
      undefined,
      { env: ENV },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--body/);
  });

  it('an empty --body → exit 2', async () => {
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', '', '--remote', GITHUB_REMOTE],
      undefined,
      { env: ENV },
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--body/);
  });

  it('a missing GITHUB_TOKEN → exit 1, loud, never printing a token', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-5', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: {} as NodeJS.ProcessEnv },
    );
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'create' });
    expect(String(out().error)).toMatch(/GITHUB_TOKEN/);
    // No network was attempted without a credential.
    expect(requests).toEqual([]);
  });
});

// ─── Aligned url/number field names across every verb (FOR-54) ───────────────
//
// The CONTRACT the skills parse. Every verb result must expose the PR URL under
// ONE consistent field name and the PR number under ONE — done ADDITIVELY, so
// each verb carries BOTH `url`+`prUrl` and BOTH `number`+`prNumber`. This proves
// the shape per verb AND that the pre-FOR-54 live-consumer reads still resolve
// (Worker terminator: `create.url`; wave-close: `status`/`arm` url+number).

describe('host-pr — aligned url/number field names (FOR-54), per verb', () => {
  it('create (reused) carries the URL under BOTH `url` and `prUrl`; no number emitted even though the reuse knows it (documented omission)', async () => {
    // The find body carries a `number` (needed to address the FOR-58 PATCH), yet
    // the EMITTED create shape still omits it — the FOR-54 documented omission
    // ("create carries no PR number") survives the number-carrying reuse.
    const { http } = fakeHttp({ get: () => ({ status: 200, json: [{ html_url: EXISTING_PR, number: 7 }] }) });
    await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    const o = out();
    expect(o.url).toBe(EXISTING_PR); // live consumer: Worker terminator reads create.url
    expect(o.prUrl).toBe(EXISTING_PR);
    expect('number' in o).toBe(false);
    expect('prNumber' in o).toBe(false);
  });

  it('create (created) carries the URL under BOTH `url` and `prUrl`', async () => {
    const { http } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: () => ({ status: 201, json: { html_url: NEW_PR } }),
    });
    await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-2', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    const o = out();
    expect(o.url).toBe(NEW_PR);
    expect(o.prUrl).toBe(NEW_PR);
  });

  it('status carries url+number under BOTH conventions (`url`/`prUrl`, `number`/`prNumber`)', async () => {
    const { host } = fakeHost({ status: openPr('blocked') });
    await runHostPr(['status', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    const o = out();
    const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
    // live consumer: wave-close reads status.url + status.number
    expect(o.url).toBe(PR_URL);
    expect(o.number).toBe(42);
    // …and now the aligned aliases too
    expect(o.prUrl).toBe(PR_URL);
    expect(o.prNumber).toBe(42);
  });

  it('arm carries url+number under BOTH conventions (`prUrl`/`prNumber`, `url`/`number`)', async () => {
    const { host } = fakeHost({ status: openPr('clean') }); // clean → direct merge, outcome merged
    await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    const o = out();
    const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
    // live consumer: wave-close reads arm.prUrl + arm.prNumber
    expect(o.prUrl).toBe(PR_URL);
    expect(o.prNumber).toBe(42);
    // …and now the aligned aliases too
    expect(o.url).toBe(PR_URL);
    expect(o.number).toBe(42);
  });

  it('merge carries url+number under BOTH conventions', async () => {
    const { host } = fakeHost({ status: openPr('blocked') });
    await runHostPr(['merge', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    const o = out();
    const PR_URL = 'https://github.com/example-org/example-repo/pull/42';
    expect(o.prUrl).toBe(PR_URL);
    expect(o.prNumber).toBe(42);
    expect(o.url).toBe(PR_URL);
    expect(o.number).toBe(42);
  });

  it('a no-pr arm outcome carries none of the four ref fields (nothing to align)', async () => {
    const { host } = fakeHost({ status: { state: 'none' } });
    await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    const o = out();
    expect(o).toMatchObject({ ok: false, outcome: 'no-pr' });
    for (const k of ['url', 'prUrl', 'number', 'prNumber']) expect(k in o).toBe(false);
  });
});

// ─── host-pr preflight (FOR-52 / ADR-0023 amendment — code-host posture) ─────
//
// preflight is store-BLIND: no --config, no --branch. It probes the code host
// via an injected LandingPosture (tests) — the routing (github only), the
// wiring (checks → JSON, exit code), and the store-blindness are what is under
// test here; the GRADING matrix is host-pr.spec.ts's job.

function fakePosture(
  over: Partial<{ canMerge: boolean; autoMerge: AutoMergeSetting; required: RequiredChecksInfo }> = {},
): LandingPosture {
  return {
    async canMergePullRequests() {
      return over.canMerge ?? true;
    },
    async getAutoMergeSetting() {
      return over.autoMerge ?? 'on';
    },
    async getRequiredChecks() {
      return over.required ?? { state: 'absent', contexts: [], detail: 'no required checks' };
    },
  };
}

/** A posture that throws if touched — proves routing rejects a host BEFORE probing. */
const throwingPosture: LandingPosture = {
  async canMergePullRequests() {
    throw new Error('routing must reject a non-github host before probing');
  },
  async getAutoMergeSetting() {
    throw new Error('routing must reject a non-github host before probing');
  },
  async getRequiredChecks() {
    throw new Error('routing must reject a non-github host before probing');
  },
};

describe('host-pr preflight — code-host posture, store-blind', () => {
  it('github: reports the three code-host checks + exit 0 on a healthy posture', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, {
      posture: fakePosture({ canMerge: true, autoMerge: 'on', required: { state: 'present', contexts: ['ci/test'], detail: 'one check' } }),
    });
    expect(code).toBe(0);
    const o = out();
    expect(o).toMatchObject({ ok: true, verb: 'preflight', host: 'github' });
    const names = (o.checks as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(['pr-merge-token', 'allow-auto-merge', 'required-checks']);
  });

  it('takes NO --branch (a repo-level probe) — succeeds without one', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, { posture: fakePosture() });
    expect(code).toBe(0);
    expect(out()).toMatchObject({ verb: 'preflight' });
  });

  it('is store-BLIND: no --config, identical on every store kind (this is the linear/markdown-store invocation)', async () => {
    // host-pr preflight never reads a wave.config.json — it probes the code host
    // directly, so `wave-close --auto` runs the SAME command whether the tracker
    // is github, linear, or markdown. There is no store to build, so a linear or
    // markdown wave gets a real code-host answer (the W10-F1 fix), not the
    // `not-applicable` the store-preflight reported. Passing an ignored --config
    // does not change the answer.
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE, '--config', 'irrelevant.json'], undefined, {
      posture: fakePosture(),
    });
    expect(code).toBe(0);
    expect((out().checks as { name: string }[]).map((c) => c.name)).toEqual([
      'pr-merge-token',
      'allow-auto-merge',
      'required-checks',
    ]);
  });

  it('exit 1 when a check FAILs — allow-auto-merge OFF with required checks present', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, {
      posture: fakePosture({ autoMerge: 'off', required: { state: 'present', contexts: ['ci/test'], detail: 'one check' } }),
    });
    expect(code).toBe(1);
    const o = out();
    expect(o.ok).toBe(false);
    expect((o.checks as { name: string; status: string }[]).find((c) => c.name === 'allow-auto-merge')?.status).toBe('fail');
  });

  it('exit 0 on an UNKNOWN allow-auto-merge — the token cannot see it, which never blocks', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, {
      posture: fakePosture({ autoMerge: 'unknown', required: { state: 'unknown', contexts: [], detail: 'needs admin' } }),
    });
    expect(code).toBe(0);
    expect(out().ok).toBe(true);
  });

  it('bitbucket → exit 1, adapter-not-implemented, and the posture is NEVER probed', async () => {
    const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, { posture: throwingPosture });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'bitbucket' });
  });

  it('an unknown host (GitLab) → exit 1, adapter-not-implemented', async () => {
    const code = await runHostPr(['preflight', '--remote', UNKNOWN_REMOTE], undefined, { posture: throwingPosture });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
  });

  it('with no injected posture, a missing GITHUB_TOKEN fails loud (exit 1) without printing a token', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, { env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'preflight' });
    expect(String(out().error)).toMatch(/GITHUB_TOKEN/);
  });
});
