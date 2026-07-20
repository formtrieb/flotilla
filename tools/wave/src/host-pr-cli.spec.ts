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
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type HttpProbe,
  type HttpRequest,
  type HttpResponse,
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

  it('an unknown verb → 2 and names the real verbs (create, arm, merge, status)', async () => {
    expect(await runHostPr(['bogus', '--branch', 'b'])).toBe(2);
    expect(stderr).toMatch(/create/);
    expect(stderr).toMatch(/arm/);
    expect(stderr).toMatch(/merge/);
    expect(stderr).toMatch(/status/);
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
}): { http: HttpProbe; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpProbe = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      if (req.method === 'GET') {
        return handlers.get?.(req.url) ?? { status: 200, json: [] };
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
  it('an OPEN PR already on the branch is reused — no create POST, exit 0', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR }] }),
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
    expect(out()).toMatchObject({ ok: true, verb: 'create', host: 'github', outcome: 'reused', url: EXISTING_PR });
    // Idempotent: exactly one request (the find query), zero writes.
    expect(requests.map((r) => r.method)).toEqual(['GET']);
  });

  it('a cap=1 re-dispatch onto an existing branch reuses the already-open PR (never a duplicate)', async () => {
    // The exact operational scenario FOR-28 exists for: a second Worker runs on
    // the same branch. find-before-create returns the open PR — no second PR.
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [{ html_url: EXISTING_PR }] }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'reused', url: EXISTING_PR });
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
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
