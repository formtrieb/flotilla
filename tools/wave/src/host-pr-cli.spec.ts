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

  it('a repo with auto-merge OFF → refused (exit 1) with the fix instruction, never merged', async () => {
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

  it('an unknown verb → 2 and names the three real verbs', async () => {
    expect(await runHostPr(['bogus', '--branch', 'b'])).toBe(2);
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
