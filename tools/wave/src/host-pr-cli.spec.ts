/**
 * host-pr-cli.spec.ts — the `host-pr arm | merge | status` verb group (FOR-26 /
 * ADR-0023).
 *
 * Two things are under test, and only these two — the runner is a THIN router:
 *   1. **detect-host routing.** github → the GitHub landing adapter, bitbucket →
 *      the Bitbucket one; an unknown host → a typed adapter-not-implemented exit
 *      on EVERY verb. Driven by `--remote`, so no git process and no network are
 *      touched.
 *   2. **The verb → engine mapping + exit codes.** The arm INTENT itself is
 *      host-pr.spec.ts's job; the request shaping is real-github-api.spec.ts's
 *      and bitbucket-api.spec.ts's.
 *
 * Every test injects a LandingHost (or, for the Bitbucket end-to-end block, a
 * real `RealBitbucketApi` over a fixture HTTP seam), so neither adapter factory
 * — and therefore no credential resolution and no network — is ever reached
 * except where a test is specifically about that failure.
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
import {
  RealBitbucketApi,
  type BitbucketHttp,
  type BitbucketHttpRequest,
  type BitbucketHttpResponse,
} from './adapters/bitbucket/bitbucket-api';

const GITHUB_REMOTE = 'git@github.com:example-org/example-repo.git';
const BITBUCKET_REMOTE = 'git@bitbucket.org:example-team/example-repo.git';
const UNKNOWN_REMOTE = 'git@gitlab.com:example-org/example-repo.git';

function fakeHost(opts: {
  status?: PrLandingStatus;
  onEnableAutoMerge?: () => void;
  onMerge?: () => MergeResult;
  onDeleteBranch?: () => void;
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
    async deleteBranch(branch: string) {
      calls.push(`deleteBranch:${branch}`);
      opts.onDeleteBranch?.();
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
  it('an unknown host (GitLab) → exit 1 with a typed adapter-not-implemented payload, and NO host call', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', UNKNOWN_REMOTE], host);

    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
    // The ROUTER decides by host — an injected adapter must not smuggle an
    // unrecognised remote onto a host path.
    expect(calls).toEqual([]);
  });

  it('EVERY verb refuses an unknown host, not just the landing three', async () => {
    for (const args of [
      ['status', '--branch', 'b'],
      ['arm', '--branch', 'b'],
      ['merge', '--branch', 'b'],
      ['create', '--branch', 'b', '--title', 'T', '--body', 'x'],
      ['preflight'],
    ]) {
      stdout = '';
      const { host, calls } = fakeHost({ status: openPr('clean') });
      const code = await runHostPr([...args, '--remote', UNKNOWN_REMOTE], host);
      expect(code).toBe(1);
      expect(out()).toMatchObject({
        ok: false,
        code: 'adapter-not-implemented',
        host: 'unknown',
        verb: args[0],
      });
      expect(calls).toEqual([]);
    }
  });

  it('the not-implemented message names the host and points at the LandingHost seam', async () => {
    const { host } = fakeHost({});
    await runHostPr(['merge', '--branch', 'b', '--remote', UNKNOWN_REMOTE], host);
    expect(String(out().error)).toMatch(/remote/i);
    expect(String(out().error)).toMatch(/github|bitbucket/);
  });

  it('bitbucket is a SHIPPED adapter now — the landing verbs route to it instead of refusing', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(['status', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);

    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, verb: 'status', host: 'bitbucket', state: 'open' });
    expect(out().code).toBeUndefined();
    expect(calls).toEqual(['getPrStatus:b']);
  });
});

// ─── the Bitbucket landing verbs, end to end through the REAL adapter ────────
//
// The blocks below drive `runHostPr` with a genuine `RealBitbucketApi` over a
// fixture HTTP seam, so the arm INTENT (host-pr.ts) and the adapter's typed
// refusal (bitbucket-api.ts) are exercised together, exactly as a pilot's
// `wave-close --auto` would. This is the AC that the Bitbucket adapter
// "inherits the verbs with no new skills" — the router, the intent, the exit
// codes and the JSON shape are all the shipped ones.

describe('host-pr on bitbucket — arm | merge | status through RealBitbucketApi', () => {
  const bbHost = (
    routes: Array<[(req: BitbucketHttpRequest) => boolean, BitbucketHttpResponse]>,
  ): { host: RealBitbucketApi; calls: BitbucketHttpRequest[] } => {
    const calls: BitbucketHttpRequest[] = [];
    const http: BitbucketHttp = {
      async request(req) {
        calls.push(req);
        for (const [match, res] of routes) if (match(req)) return res;
        return { status: 404, json: null };
      },
    };
    return { host: new RealBitbucketApi('ws', 'repo', 'Bearer t', http), calls };
  };

  const bbPr = (over: Record<string, unknown> = {}) => ({
    id: 7,
    state: 'OPEN',
    links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/7' } },
    source: { branch: { name: 'b' }, commit: { hash: 'abc123' } },
    destination: { branch: { name: 'main' } },
    ...over,
  });

  const prList = (values: unknown[]): [(r: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
    (r) => r.url.includes('/pullrequests?'),
    { status: 200, json: { values } },
  ];
  const restrictions = (values: unknown[]): [(r: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
    (r) => r.url.includes('/branch-restrictions'),
    { status: 200, json: { values } },
  ];
  const buildStatuses = (values: unknown[]): [(r: BitbucketHttpRequest) => boolean, BitbucketHttpResponse] => [
    (r) => r.url.includes('/statuses'),
    { status: 200, json: { values } },
  ];
  const REQUIRE_ONE = restrictions([
    { kind: 'require_passing_builds_to_merge', pattern: '*', value: 1, branch_match_kind: 'glob' },
  ]);

  it('status resolves a MERGED PR — the tier-2 done-reconcile evidence, in the shipped vocabulary', async () => {
    const { host } = bbHost([prList([bbPr({ state: 'MERGED' })])]);
    const code = await runHostPr(['status', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'status',
      host: 'bitbucket',
      state: 'merged',
      url: 'https://bitbucket.org/ws/repo/pull-requests/7',
      prUrl: 'https://bitbucket.org/ws/repo/pull-requests/7',
      number: 7,
      prNumber: 7,
    });
  });

  it('status on a branch with no PR answers `none` at exit 0 — an answer, not a failure', async () => {
    const { host } = bbHost([prList([])]);
    const code = await runHostPr(['status', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, state: 'none' });
  });

  it('arm on a PR with nothing pending DIRECT-MERGES — the measured degrade, since this host cannot arm', async () => {
    const { host } = bbHost([
      prList([bbPr()]),
      restrictions([]), // no required builds → nothing to wait for
      [(r) => r.method === 'POST' && r.url.endsWith('/merge'), { status: 200, json: { merge_commit: { hash: 'cafe1' } } }],
    ]);
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, verb: 'arm', host: 'bitbucket', outcome: 'merged', sha: 'cafe1' });
  });

  it('arm on a PR whose required build has not reported REFUSES — it never merges past a gate', async () => {
    const { host, calls } = bbHost([
      prList([bbPr()]),
      REQUIRE_ONE,
      buildStatuses([]), // the check-attach latency window: nothing reported yet
    ]);
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'arm', outcome: 'refused' });
    expect(String(out().reason)).toMatch(/auto-merge|merge-order/i);
    // The decisive assertion: no merge was POSTed.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // …and this is the DOMINANT Bitbucket landing outcome, so the remedy it
    // teaches has to be reachable on this host. The CLI is what threads
    // `ArmOptions.host` (the arm intent carries no host tag of its own), so
    // asserting it HERE — end to end, from argv through the real adapter —
    // is what proves the wiring rather than the string.
    const reason = String(out().reason);
    expect(reason).not.toMatch(/Settings → General/);
    expect(reason).not.toMatch(/Enable "Allow auto-merge"/);
    expect(reason).toMatch(/no per-pull-request auto-merge arming primitive/i);
    expect(reason).toMatch(/merge-order/);
  });

  it('arm on a PR whose required build PASSED merges directly', async () => {
    const { host } = bbHost([
      prList([bbPr()]),
      REQUIRE_ONE,
      buildStatuses([{ state: 'SUCCESSFUL' }]),
      [(r) => r.method === 'POST' && r.url.endsWith('/merge'), { status: 200, json: { merge_commit: { hash: 'cafe2' } } }],
    ]);
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'merged', sha: 'cafe2' });
  });

  it('merge --delete-branch merges and then DELETEs the head ref, reporting the deletion structurally', async () => {
    const { host, calls } = bbHost([
      prList([bbPr()]),
      restrictions([]),
      [(r) => r.method === 'POST' && r.url.endsWith('/merge'), { status: 200, json: { merge_commit: { hash: 'cafe3' } } }],
      [(r) => r.method === 'DELETE', { status: 204, json: null }],
    ]);
    const code = await runHostPr(
      ['merge', '--branch', 'wave/461-x', '--delete-branch', '--remote', BITBUCKET_REMOTE],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      outcome: 'merged',
      branchDeletion: { branch: 'wave/461-x', deleted: true },
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/refs/branches/wave/461-x'))).toBe(true);
  });

  it('a FAILED branch deletion is a reported degradation, never a merge failure', async () => {
    const { host } = bbHost([
      prList([bbPr()]),
      restrictions([]),
      [(r) => r.method === 'POST' && r.url.endsWith('/merge'), { status: 200, json: { merge_commit: { hash: 'cafe4' } } }],
      [(r) => r.method === 'DELETE', { status: 400, json: { error: { message: 'Branch not found' } } }],
    ]);
    const code = await runHostPr(['merge', '--branch', 'b', '--delete-branch', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0); // the merge landed
    expect(out()).toMatchObject({ ok: true, outcome: 'merged' });
    expect((out().branchDeletion as { deleted: boolean; error: string }).deleted).toBe(false);
    expect((out().branchDeletion as { error: string }).error).toMatch(/Branch not found/);
  });

  it('an already-merged PR is an idempotent no-op — no write of any kind', async () => {
    const { host, calls } = bbHost([prList([bbPr({ state: 'MERGED' })])]);
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(0);
    expect(out()).toMatchObject({ outcome: 'already-merged' });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('a host error surfaces LOUDLY as exit 1 with Bitbucket\'s own message, never a silent success', async () => {
    const { host } = bbHost([
      [(r) => r.url.includes('/pullrequests?'), { status: 403, json: { error: { message: 'Access denied' } } }],
    ]);
    const code = await runHostPr(['status', '--branch', 'b', '--remote', BITBUCKET_REMOTE], host);
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'status', host: 'bitbucket' });
    expect(String(out().error)).toMatch(/Access denied/);
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

describe('host-pr merge --delete-branch (consumer KW-F6 — remote branch hygiene)', () => {
  it('deletes the head branch after a successful merge, reported structurally, exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(
      ['merge', '--branch', 'wave/FOR-66-x', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'merge',
      outcome: 'merged',
      branchDeletion: { branch: 'wave/FOR-66-x', deleted: true },
    });
    expect(calls).toContain('deleteBranch:wave/FOR-66-x');
  });

  it('without the flag, the merge JSON is byte-identical — no branchDeletion key, no delete call', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(['merge', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect('branchDeletion' in out()).toBe(false);
    expect(calls).not.toContain('deleteBranch:b');
  });

  it('a FAILED deletion after a successful merge stays exit 0 + outcome merged (degradation, not failure)', async () => {
    const { host } = fakeHost({
      status: openPr('blocked'),
      onDeleteBranch: () => {
        throw new Error('Reference does not exist');
      },
    });
    const code = await runHostPr(
      ['merge', '--branch', 'b', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      outcome: 'merged',
      branchDeletion: { branch: 'b', deleted: false, error: 'Reference does not exist' },
    });
  });

  it('--delete-branch on status is a usage error (exit 2) — status never lands anything to delete a branch from', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(
      ['status', '--branch', 'b', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(2);
    expect(stderr).toMatch(/--delete-branch is only supported by 'arm' and 'merge'/);
    expect(calls).not.toContain('deleteBranch:b');
  });
});

describe('host-pr arm --delete-branch (issue #140 — reaching the engine capability landed in #132)', () => {
  // These tests drive the flag through the CLI ENTRYPOINT (`runHostPr`) down to
  // the `armPullRequest` engine call — the wiring under test here is the CLI's
  // routing of `--delete-branch` onto `arm`, not the arm decision logic itself
  // (that is host-pr.spec.ts's job, already covered there).

  it('a clean PR merges immediately AND deletes the head branch, reported structurally, exit 0', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(
      ['arm', '--branch', 'wave/FOR-140-x', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'arm',
      outcome: 'merged',
      branchDeletion: { branch: 'wave/FOR-140-x', deleted: true },
    });
    expect(calls).toEqual([
      'getPrStatus:wave/FOR-140-x',
      'mergePullRequest:42:squash',
      'deleteBranch:wave/FOR-140-x',
    ]);
  });

  it('a blocked PR only ARMS (auto-merge enabled, merge deferred to the host) — no delete call, and the reason records the deferral', async () => {
    const { host, calls } = fakeHost({ status: openPr('blocked') });
    const code = await runHostPr(
      ['arm', '--branch', 'b', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'armed' });
    expect(String(out().reason)).toMatch(/DEFERRED/);
    expect(calls).toEqual(['getPrStatus:b', 'enableAutoMerge:42:squash']);
    expect(calls).not.toContain('deleteBranch:b');
  });

  it('without the flag, arming a clean PR is byte-identical — no branchDeletion key, no delete call', async () => {
    const { host, calls } = fakeHost({ status: openPr('clean') });
    const code = await runHostPr(['arm', '--branch', 'b', '--remote', GITHUB_REMOTE], host);
    expect(code).toBe(0);
    expect('branchDeletion' in out()).toBe(false);
    expect(calls).not.toContain('deleteBranch:b');
  });

  it('a FAILED deletion after an immediate arm-merge stays exit 0 + outcome merged (degradation, not failure)', async () => {
    const { host } = fakeHost({
      status: openPr('clean'),
      onDeleteBranch: () => {
        throw new Error('Reference does not exist');
      },
    });
    const code = await runHostPr(
      ['arm', '--branch', 'b', '--remote', GITHUB_REMOTE, '--delete-branch'],
      host,
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      outcome: 'merged',
      branchDeletion: { branch: 'b', deleted: false, error: 'Reference does not exist' },
    });
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

// ─── issue #505 — a known verb's usage error teaches ONLY its own contract ──
//
// The motivating misfire: `host-pr arm --pr <url>` (the flag guessed from
// `create`'s response shape) left --branch missing, and the pre-fix error
// answered with the ENTIRE ~60-line multi-verb dump — the correct lesson at
// an oversized price. These specs prove the per-verb contract fires for a
// KNOWN verb, and that the full dump survives for an unknown/absent one.

describe('host-pr usage errors — per-verb contract vs the full dump (issue #505)', () => {
  it("a KNOWN verb's usage error (arm, missing --branch) names ONLY arm's own contract", async () => {
    const code = await runHostPr(['arm', '--remote', GITHUB_REMOTE]);

    expect(code).toBe(2);
    expect(stderr).toContain('usage: host-pr arm --branch');
    expect(stderr).toContain('output: a single JSON object on stdout');
    // Text that ONLY the full multi-verb dump carries must be absent — the
    // tell that this is arm's contract, not the whole usage() text.
    expect(stderr).not.toContain('Report the code-host landing posture');
    expect(stderr).not.toContain('GITHUB_TOKEN_CMD');
    expect(stderr).not.toContain('NOT a read-only probe');
  });

  it('the arm --pr misfire itself: a --pr typo leaves --branch missing, and the error stays SHORT (arm-only), not the ~60-line dump', async () => {
    const code = await runHostPr([
      'arm',
      '--pr',
      'https://github.com/example-org/example-repo/pull/1',
      '--remote',
      GITHUB_REMOTE,
    ]);

    expect(code).toBe(2);
    expect(stderr).toMatch(/--branch/);
    expect(stderr).toContain('usage: host-pr arm --branch');
    // The oversized-price tell: the full dump runs to dozens of lines; the
    // per-verb contract is a handful.
    expect(stderr.trim().split('\n').length).toBeLessThan(10);
  });

  it("a wrong --method on a KNOWN verb (merge) names merge's own contract, not create's or preflight's", async () => {
    const code = await runHostPr([
      'merge',
      '--branch',
      'b',
      '--remote',
      GITHUB_REMOTE,
      '--method',
      'fast-forward',
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain('usage: host-pr merge --branch');
    expect(stderr).not.toContain('find-before-create');
    expect(stderr).not.toContain('create-credentials');
  });

  it('an UNKNOWN verb still gets the full dump — the credential footer and every verb\'s own prose included', async () => {
    const code = await runHostPr(['bogus', '--branch', 'b']);

    expect(code).toBe(2);
    // preflight's own prose line — present ONLY in the full dump.
    expect(stderr).toContain('Report the code-host landing posture');
    expect(stderr).toContain('GITHUB_TOKEN_CMD');
  });

  it('no verb at all still gets the full dump', async () => {
    const code = await runHostPr([]);

    expect(code).toBe(2);
    expect(stderr).toContain('GITHUB_TOKEN_CMD');
  });

  // ── AC4: each verb's own contract states its output format ─────────────────

  it('arm, merge, and status each state "a single JSON object on stdout" in their own usage error', async () => {
    for (const argv of [
      ['arm', '--remote', GITHUB_REMOTE],
      ['merge', '--remote', GITHUB_REMOTE],
      ['status', '--remote', GITHUB_REMOTE],
    ]) {
      stderr = '';
      await runHostPr(argv);
      expect(stderr).toContain('output: a single JSON object on stdout');
    }
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

describe('host-pr create — routing (detect-host: github + bitbucket ship adapters)', () => {
  /** The Bitbucket credential pair (ADR-0029 secret + the non-secret username). */
  const BB_ENV = {
    BITBUCKET_TOKEN: 'test-token',
    BITBUCKET_EMAIL: 'dev@example.com',
  } as NodeJS.ProcessEnv;

  it('an unknown host (GitLab) → exit 1, adapter-not-implemented, and NO http call', async () => {
    const { http, requests } = fakeHttp({
      get: () => {
        throw new Error('routing must reject a host with no adapter before any network');
      },
    });
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'x', '--remote', UNKNOWN_REMOTE],
      undefined,
      { http, env: ENV },
    );
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
    expect(requests).toEqual([]);
  });

  it('bitbucket runs the SAME find-before-create path — no second implementation, just the host gate removed', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: { values: [] } }), // Bitbucket's paged shape
      post: () => ({
        status: 201,
        json: { links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/12' } } },
      }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', BITBUCKET_REMOTE],
      undefined,
      { http, env: BB_ENV },
    );

    expect(code).toBe(0);
    expect(out()).toMatchObject({
      ok: true,
      verb: 'create',
      host: 'bitbucket',
      outcome: 'created',
      url: 'https://bitbucket.org/ws/repo/pull-requests/12',
    });
    // find first, then create — the cross-host idempotency, unchanged.
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    // Basic auth pairs the ATLASSIAN ACCOUNT EMAIL with the API token. App
    // passwords (`username:app_password`) stopped working on 2026-06-09.
    expect(requests[0].auth).toBe('dev@example.com:test-token');
  });

  it('the open-PR query is well-formed BBQL: `state` is its OWN parameter, never an `&` inside `q`', async () => {
    // BBQL's boolean operator is `and`; an `&` encoded into the `q` value is
    // junk inside the expression, and a rejected query reads as "no open PR" —
    // which turns find-before-create into create-a-duplicate.
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: { values: [] } }),
      post: () => ({ status: 201, json: { links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1' } } } }),
    });
    await runHostPr(
      ['create', '--branch', 'wave/EX-1-x', '--title', 'T', '--body', 'Fixes EX-1', '--remote', BITBUCKET_REMOTE],
      undefined,
      { http, env: BB_ENV },
    );
    const q = requests[0].url;
    expect(q).toContain(`q=${encodeURIComponent('source.branch.name="wave/EX-1-x"')}`);
    expect(q).toContain('&state=OPEN');
    expect(q).not.toContain(encodeURIComponent('&state=OPEN'));
  });

  it('bitbucket without BITBUCKET_EMAIL refuses LOUDLY rather than sending a request that would 401', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-1', '--remote', BITBUCKET_REMOTE],
      undefined,
      { http, env: { BITBUCKET_TOKEN: 'test-token' } },
    );
    expect(code).toBe(1);
    expect(String(out().error)).toMatch(/BITBUCKET_EMAIL/);
    expect(requests).toEqual([]);
  });

  it('bitbucket with no credential at all is the engine-owned typed error, never an anonymous request', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-1', '--remote', BITBUCKET_REMOTE],
      undefined,
      { http, env: {} },
    );
    expect(code).toBe(1);
    expect(String(out().error)).toMatch(/BITBUCKET_TOKEN is required/);
    expect(requests).toEqual([]);
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

// ─── host-pr create + preflight resolve through the ONE seam (ADR-0029) ──────
//
// Both credential edges of this runner obtain their token from the shared
// credential resolver, not from a lookup of their own. The proofs are the two
// halves that a per-edge `env.GITHUB_TOKEN` read could never produce: a token
// that came out of a lookup COMMAND reaching the Basic-auth header, and a
// BROKEN lookup command failing loud while a perfectly good ambient token sits
// right there unused.

describe('host-pr — credential resolution through the engine seam (ADR-0029)', () => {
  it('create: a configured GITHUB_TOKEN_CMD resolves and its stdout becomes the Basic-auth credential', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: () => ({ status: 201, json: { html_url: NEW_PR } }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: { GITHUB_TOKEN_CMD: 'echo tok-from-the-lookup' } as NodeJS.ProcessEnv },
    );
    expect(code).toBe(0);
    expect(out()).toMatchObject({ ok: true, outcome: 'created', url: NEW_PR });
    // The header carries the LOOKUP's stdout — only the shared resolver produces this.
    expect(requests.map((r) => r.auth)).toEqual([
      'x-access-token:tok-from-the-lookup',
      'x-access-token:tok-from-the-lookup',
    ]);
  });

  it('create: a configured command WINS over a set ambient GITHUB_TOKEN', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: () => ({ status: 201, json: { html_url: NEW_PR } }),
    });
    await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'echo tok-from-the-lookup' } as NodeJS.ProcessEnv },
    );
    expect(requests[0].auth).toBe('x-access-token:tok-from-the-lookup');
    expect(stdout + stderr).not.toContain('ambient-tok');
  });

  it('create: an empty GITHUB_TOKEN_CMD counts as not configured — the ambient token applies (the CI escape hatch)', async () => {
    const { http, requests } = fakeHttp({
      get: () => ({ status: 200, json: [] }),
      post: () => ({ status: 201, json: { html_url: NEW_PR } }),
    });
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: '' } as NodeJS.ProcessEnv },
    );
    expect(code).toBe(0);
    expect(requests[0].auth).toBe('x-access-token:ambient-tok');
  });

  it('create: a BROKEN lookup command → exit 1, the command named, no network, no fallback to the ambient token', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'exit 9' } as NodeJS.ProcessEnv },
    );
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'create' });
    expect(String(out().error)).toContain('exit 9');
    expect(requests).toEqual([]);
    // The loud failure is the point: the good ambient token was NOT used, and
    // neither it nor any lookup output reached a stream.
    expect(stdout + stderr).not.toContain('ambient-tok');
  });

  it('create: a lookup that prints NOTHING → exit 1 (an empty secret is a failure, not a fallback)', async () => {
    const { http, requests } = fakeHttp({});
    const code = await runHostPr(
      ['create', '--branch', 'b', '--title', 'T', '--body', 'Fixes EX-9', '--remote', GITHUB_REMOTE],
      undefined,
      { http, env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'true' } as NodeJS.ProcessEnv },
    );
    expect(code).toBe(1);
    expect(String(out().error)).toMatch(/printed no secret/);
    expect(requests).toEqual([]);
    expect(stdout + stderr).not.toContain('ambient-tok');
  });

  it('preflight: a BROKEN lookup command fails loud with the command named (the posture reader resolves through the seam too)', async () => {
    // No injected posture → the real construction path, which builds the posture
    // reader from the resolved credential. The resolver refuses BEFORE any
    // network, so this stays hermetic.
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, {
      env: { GITHUB_TOKEN: 'ambient-tok', GITHUB_TOKEN_CMD: 'exit 9' } as NodeJS.ProcessEnv,
    });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'preflight' });
    expect(String(out().error)).toContain('exit 9');
    expect(String(out().error)).toContain('GITHUB_TOKEN_CMD');
    expect(stdout + stderr).not.toContain('ambient-tok');
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

  it('an unknown host (GitLab) → exit 1, adapter-not-implemented, and the posture is NEVER probed', async () => {
    const code = await runHostPr(['preflight', '--remote', UNKNOWN_REMOTE], undefined, { posture: throwingPosture });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, code: 'adapter-not-implemented', host: 'unknown' });
  });

  it('bitbucket reports the same three posture checks (plus the create-credentials advisory) — and its allow-auto-merge OFF is ADVISORY, never a hard fail', async () => {
    // The `off` is a real READ here (the adapter reads the
    // `allow_auto_merge_when_builds_pass` branch restriction), but no value of
    // it gives the engine an arming call — the restriction only enables a human
    // to click Merge. So there is no misconfiguration for an operator to fix,
    // and grading it `fail` (as a visible GitHub `off` with required checks is
    // graded) would leave every correctly-configured Bitbucket consumer
    // permanently red.
    //
    // `env` is injected (empty) rather than left to default: this host's report
    // now carries an AMBIENT-credential check too, and a spec whose answer
    // depended on the real process environment would pass or fail by machine.
    const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
      env: {} as NodeJS.ProcessEnv,
      posture: fakePosture({
        canMerge: true,
        autoMerge: 'off',
        required: { state: 'present', contexts: [], detail: 'two successful builds' },
      }),
    });
    expect(code).toBe(0);
    const o = out();
    expect(o).toMatchObject({ ok: true, verb: 'preflight', host: 'bitbucket' });
    const checks = o.checks as { name: string; status: string; detail: string }[];
    // The three posture checks keep their names AND their order; the ambient
    // check is APPENDED — that ordering is the additive claim, asserted.
    expect(checks.map((c) => c.name)).toEqual([
      'pr-merge-token',
      'allow-auto-merge',
      'required-checks',
      'create-credentials',
    ]);
    const autoMerge = checks.find((c) => c.name === 'allow-auto-merge');
    expect(autoMerge?.status).toBe('advisory');
    expect(autoMerge?.detail).toMatch(/no per-pull-request auto-merge arming primitive/i);
    // The read that produced the value is named, so the report is auditable.
    expect(autoMerge?.detail).toMatch(/allow_auto_merge_when_builds_pass/);
    // The required-checks line must NOT promise an arm this host cannot perform.
    expect(checks.find((c) => c.name === 'required-checks')?.detail).not.toMatch(/will ARM these PRs/);
  });

  it('with no injected posture, a missing GITHUB_TOKEN fails loud (exit 1) without printing a token', async () => {
    const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, { env: {} as NodeJS.ProcessEnv });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'preflight' });
    expect(String(out().error)).toMatch(/GITHUB_TOKEN/);
  });

  it('with no injected posture on bitbucket, a missing BITBUCKET_TOKEN fails loud (exit 1) without printing a token', async () => {
    const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
      env: {} as NodeJS.ProcessEnv,
    });
    expect(code).toBe(1);
    expect(out()).toMatchObject({ ok: false, verb: 'preflight', host: 'bitbucket' });
    expect(String(out().error)).toMatch(/BITBUCKET_TOKEN/);
  });
});

// ─── host-pr preflight → the create-credentials advisory ─────────────────────
//
// The wiring half of the check: `deps.env` reaching `preflightHost`, the check
// landing in the printed JSON, and the exit code staying where it was. The
// GRADING (the detail text, the host-conditionality, the derivation from
// `bitbucketCreateCreds`) is host-pr.spec.ts's job, as with every other check.
//
// EVERY test here injects its own `env` object. None reads, writes, or depends
// on `process.env`, and none resolves a credential: the posture reader is
// injected, so no adapter factory is reached. `SET_EMAIL_ENV`'s value is a
// synthetic fixture, not anyone's account.

const NO_EMAIL_ENV = {} as NodeJS.ProcessEnv;
const SET_EMAIL_ENV = { BITBUCKET_EMAIL: 'wave-fixture@example.test' } as NodeJS.ProcessEnv;

describe('host-pr preflight — the create-credentials advisory (BITBUCKET_EMAIL)', () => {
  it('bitbucket + BITBUCKET_EMAIL UNSET → the check reports `advisory`, ok stays true, exit stays 0', async () => {
    const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
      env: NO_EMAIL_ENV,
      posture: fakePosture({ canMerge: true, autoMerge: 'on' }),
    });

    // The whole point of the settled grade: an unset email is STATED, never
    // enforced. A land-only consumer must not be refused.
    expect(code).toBe(0);
    const o = out();
    expect(o.ok).toBe(true);
    const check = (o.checks as { name: string; status: string }[]).find((c) => c.name === 'create-credentials');
    expect(check?.status).toBe('advisory');
  });

  it('bitbucket + BITBUCKET_EMAIL SET → the same check reports `pass`', async () => {
    const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
      env: SET_EMAIL_ENV,
      posture: fakePosture({ canMerge: true, autoMerge: 'on' }),
    });
    expect(code).toBe(0);
    const check = (out().checks as { name: string; status: string }[]).find((c) => c.name === 'create-credentials');
    expect(check?.status).toBe('pass');
  });

  // The env THREADING itself, asserted as a property rather than assumed: the
  // same posture and the same argv produce two different answers, and the only
  // difference between the two runs is the injected environment. A check that
  // read `process.env` at a new site would answer identically both times.
  it('the answer is a function of the INJECTED env — same argv, same posture, two envs, two verdicts', async () => {
    const statusFor = async (env: NodeJS.ProcessEnv): Promise<string | undefined> => {
      stdout = '';
      await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
        env,
        posture: fakePosture({ canMerge: true, autoMerge: 'on' }),
      });
      return (out().checks as { name: string; status: string }[]).find((c) => c.name === 'create-credentials')?.status;
    };

    expect(await statusFor(NO_EMAIL_ENV)).toBe('advisory');
    expect(await statusFor(SET_EMAIL_ENV)).toBe('pass');
  });

  it('github never reports the check — with the variable unset AND with it set (no spurious advisory)', async () => {
    for (const env of [NO_EMAIL_ENV, SET_EMAIL_ENV]) {
      stdout = '';
      const code = await runHostPr(['preflight', '--remote', GITHUB_REMOTE], undefined, {
        env,
        posture: fakePosture({ canMerge: true, autoMerge: 'on' }),
      });
      expect(code).toBe(0);
      const names = (out().checks as { name: string }[]).map((c) => c.name);
      // Byte-identical to the shipped GitHub report: three checks, same order.
      expect(names).toEqual(['pr-merge-token', 'allow-auto-merge', 'required-checks']);
    }
  });

  it('never flips the exit code on ANY bitbucket posture — it is advisory in every combination', async () => {
    for (const env of [NO_EMAIL_ENV, SET_EMAIL_ENV]) {
      for (const autoMerge of ['on', 'off', 'unknown'] as AutoMergeSetting[]) {
        stdout = '';
        const code = await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
          env,
          posture: fakePosture({
            canMerge: true,
            autoMerge,
            required: { state: 'present', contexts: ['build'], detail: 'one build' },
          }),
        });
        expect(code).toBe(0);
        const check = (out().checks as { name: string; status: string }[]).find(
          (c) => c.name === 'create-credentials',
        );
        expect(check?.status).not.toBe('fail');
      }
    }
  });

  it('the printed payload never carries the variable VALUE — presence is graded, the value is not echoed', async () => {
    await runHostPr(['preflight', '--remote', BITBUCKET_REMOTE], undefined, {
      env: SET_EMAIL_ENV,
      posture: fakePosture({ canMerge: true }),
    });
    // Not just the one check's detail — the WHOLE stdout payload, because the
    // helper this check calls builds a `user:secret` pair and a leak of it
    // anywhere in the report would be the damaging kind.
    expect(stdout).not.toContain('wave-fixture@example.test');
    expect(stdout).not.toContain('preflight-probe-not-a-credential');
  });
});
