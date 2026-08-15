import { describe, it, expect } from 'vitest';
import {
  RealGitHubApi,
  GitHubApiError,
  ARM_CLEAN_STATUS_ERROR,
  ARM_NOT_ALLOWED_ERROR,
  ARM_FORBIDDEN_ERROR_TYPE,
  ARM_TOKEN_REQUIREMENTS,
} from './real-github-api';
import { AutoMergeUnavailableError } from '../../host-pr';
import { FakeGitHubHttp } from './github-http-fake';
import type { GitHubHttpRequest, GitHubHttpResponse } from './github-http';

function makeApi(handler: (req: GitHubHttpRequest) => GitHubHttpResponse): {
  api: RealGitHubApi;
  http: FakeGitHubHttp;
} {
  const http = new FakeGitHubHttp(handler);
  return { api: new RealGitHubApi('example-org', 'example-repo', 'tok-abc', http), http };
}

describe('RealGitHubApi', () => {
  it('createIssue POSTs to /issues and returns the assigned number', async () => {
    const { api, http } = makeApi((req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/issues');
      expect(req.token).toBe('tok-abc');
      expect(JSON.parse(req.body!)).toEqual({ title: 'T', body: 'B', labels: ['ready-for-agent'] });
      return { status: 201, json: { number: 42 } };
    });
    expect(await api.createIssue({ title: 'T', body: 'B', labels: ['ready-for-agent'] })).toEqual({ number: 42 });
    expect(http.requests).toHaveLength(1);
  });

  it('getIssue maps GitHub label objects + state_reason to GhIssue', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      json: { number: 7, title: 'X', body: 'Y', labels: [{ name: 'risk/isolated-refactor' }, { name: 'wave/queued' }], state: 'open', state_reason: null },
    }));
    expect(await api.getIssue(7)).toEqual({
      number: 7, title: 'X', body: 'Y', labels: ['risk/isolated-refactor', 'wave/queued'], state: 'open', stateReason: null,
    });
  });

  // The tracker-update instant behind the DoR staleness advisory. GitHub's REST
  // issue schema declares `updated_at` as a REQUIRED string with format
  // date-time, so the wire value is carried through verbatim rather than
  // reformatted.
  it('getIssue carries the wire `updated_at` through as GhIssue.updatedAt', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      json: { number: 7, title: 'X', body: 'Y', labels: [], state: 'open', state_reason: null, updated_at: '2026-08-09T10:11:12Z' },
    }));
    expect((await api.getIssue(7)).updatedAt).toBe('2026-08-09T10:11:12Z');
  });

  it('getIssue leaves updatedAt ABSENT (never fabricated) when the wire omits updated_at', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      json: { number: 7, title: 'X', body: 'Y', labels: [], state: 'open', state_reason: null },
    }));
    // Absence must propagate: the DoR staleness advisory reads an absent instant
    // as `deferred`, and an invented value would turn that honest "unknown" into
    // a silent, wrong "nothing moved".
    expect((await api.getIssue(7)).updatedAt).toBeUndefined();
  });

  it('listOpenIssues pages to exhaustion and drops pull_request items', async () => {
    // page 1: 100 items (99 issues + 1 PR) → full page → fetch page 2; page 2: 1 issue → short → stop.
    const page1 = Array.from({ length: 99 }, (_, i) => ({ number: i + 1, title: `t${i}`, body: '', labels: [], state: 'open', state_reason: null }));
    page1.push({ number: 999, title: 'a pr', body: '', labels: [], state: 'open', state_reason: null, pull_request: { url: 'x' } } as never);
    const page2 = [{ number: 200, title: 'last', body: '', labels: [], state: 'open', state_reason: null }];
    const { api, http } = makeApi((req) => {
      const page = new URL(req.url).searchParams.get('page');
      return { status: 200, json: page === '1' ? page1 : page2 };
    });
    const issues = await api.listOpenIssues();
    expect(http.requests).toHaveLength(2); // exhausted via the count heuristic
    expect(issues).toHaveLength(100); // 99 + 1, PR dropped
    expect(issues.some((i) => i.number === 999)).toBe(false);
    expect(issues.some((i) => i.number === 200)).toBe(true);
  });

  it('removeLabel treats 404 as an idempotent no-op', async () => {
    const { api } = makeApi(() => ({ status: 404, json: { message: 'Label does not exist' } }));
    await expect(api.removeLabel(7, 'wave/queued')).resolves.toBeUndefined();
  });

  it('addLabel throws GitHubApiError on a non-200', async () => {
    const { api } = makeApi(() => ({ status: 403, json: { message: 'forbidden' } }));
    await expect(api.addLabel(7, 'x')).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('nativeClose PATCHes state=closed with state_reason', async () => {
    const { api, http } = makeApi(() => ({ status: 200, json: {} }));
    await api.nativeClose(7, 'not_planned');
    expect(http.requests[0].method).toBe('PATCH');
    expect(JSON.parse(http.requests[0].body!)).toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('getClosingState resolves merged via GraphQL closedByPullRequestsReferences', async () => {
    const { api, http } = makeApi((req) => {
      expect(req.url).toBe('https://api.github.com/graphql');
      return { status: 200, json: { data: { repository: { issue: { state: 'CLOSED', closedByPullRequestsReferences: { nodes: [{ merged: true, url: 'https://github.com/example-org/example-repo/pull/5' }] } } } } } };
    });
    expect(await api.getClosingState(7)).toEqual({ state: 'merged', prUrl: 'https://github.com/example-org/example-repo/pull/5' });
    expect(JSON.parse(http.requests[0].body!).variables).toEqual({ owner: 'example-org', repo: 'example-repo', number: 7 });
  });

  it('getClosingState → open when the issue is still OPEN', async () => {
    const { api } = makeApi(() => ({ status: 200, json: { data: { repository: { issue: { state: 'OPEN', closedByPullRequestsReferences: { nodes: [] } } } } } }));
    expect(await api.getClosingState(7)).toEqual({ state: 'open' });
  });

  it('getClosingState → closed-unmerged when a closing PR was FOUND and did not merge', async () => {
    const { api } = makeApi(() => ({ status: 200, json: { data: { repository: { issue: { state: 'CLOSED', closedByPullRequestsReferences: { nodes: [{ merged: false, url: 'u' }] } } } } } }));
    expect(await api.getClosingState(7)).toEqual({ state: 'closed-unmerged' });
  });

  it('getClosingState → closed-unknown when CLOSED with NO closing-PR reference (W2-F1c: not a rejection)', async () => {
    // Closed by hand / as a duplicate / via a foreign-id mention: the issue is
    // closed but no PR was ever linked. The old code collapsed this into
    // closed-unmerged and flagged legitimately-finished rows as rejected PRs.
    const { api } = makeApi(() => ({ status: 200, json: { data: { repository: { issue: { state: 'CLOSED', closedByPullRequestsReferences: { nodes: [] } } } } } }));
    expect(await api.getClosingState(7)).toEqual({ state: 'closed-unknown' });
  });

  it('preflight throws on a non-200 GET /user', async () => {
    const { api } = makeApi(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    await expect(api.preflight()).rejects.toMatchObject({ status: 401, op: 'preflight' });
  });

  it('nativeClose defaults to state_reason=completed', async () => {
    const { api, http } = makeApi(() => ({ status: 200, json: {} }));
    await api.nativeClose(7);
    expect(JSON.parse(http.requests[0].body!)).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('nativeClose(7, null) omits state_reason entirely', async () => {
    const { api, http } = makeApi(() => ({ status: 200, json: {} }));
    await api.nativeClose(7, null as never);
    expect(JSON.parse(http.requests[0].body!)).toEqual({ state: 'closed' });
  });

  it('getClosingState throws GitHubApiError when issue is null (not found)', async () => {
    const { api } = makeApi(() => ({ status: 200, json: { data: { repository: { issue: null } } } }));
    await expect(api.getClosingState(7)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('getClosingState throws GitHubApiError on GraphQL errors (HTTP 200 with errors[])', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      json: { data: null, errors: [{ message: 'insufficient scope' }] },
    }));
    await expect(api.getClosingState(7)).rejects.toSatisfy(
      (e: unknown) => e instanceof GitHubApiError && e.message.includes('GraphQL error'),
    );
  });

  it('addLabel happy path: POST to …/issues/7/labels with correct body', async () => {
    const { api, http } = makeApi(() => ({ status: 200, json: {} }));
    await expect(api.addLabel(7, 'wave/queued')).resolves.toBeUndefined();
    expect(http.requests[0].method).toBe('POST');
    expect(http.requests[0].url).toBe('https://api.github.com/repos/example-org/example-repo/issues/7/labels');
    expect(JSON.parse(http.requests[0].body!)).toEqual({ labels: ['wave/queued'] });
  });

  it('getComments paginates: full page then short page → 2 requests, all comments returned', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}` }));
    const page2 = [{ body: 'last comment' }];
    const { api, http } = makeApi((req) => {
      const page = new URL(req.url).searchParams.get('page');
      return { status: 200, json: page === '1' ? page1 : page2 };
    });
    const comments = await api.getComments(7);
    expect(http.requests).toHaveLength(2);
    expect(comments).toHaveLength(101);
    expect(comments[100]).toEqual({ body: 'last comment' });
  });

  // ── native issue dependencies (ADR-0020's read-union + write-mirror, ported).
  // Request shaping pinned against docs.github.com/en/rest/issues/
  // issue-dependencies (read 2026-08-03); the GET's path + query + 200 were also
  // live-confirmed unauthenticated against this repo the same day. ────────────
  describe('issue dependencies (ADR-0020 port)', () => {
    it('getBlockedBy GETs …/issues/{n}/dependencies/blocked_by and projects issue NUMBERS out of the full issue objects', async () => {
      const { api, http } = makeApi((req) => {
        expect(req.method).toBe('GET');
        return {
          status: 200,
          // the endpoint answers full issue objects: `id` (the DATABASE id) is a
          // DIFFERENT value from `number`, and only `number` is the store's id.
          json: [
            { id: 3_000_001, number: 11, title: 'blocker one', state: 'open' },
            { id: 3_000_002, number: 12, title: 'blocker two', state: 'open' },
          ],
        };
      });
      expect(await api.getBlockedBy(7)).toEqual([11, 12]);
      expect(http.requests[0].url).toBe(
        'https://api.github.com/repos/example-org/example-repo/issues/7/dependencies/blocked_by?per_page=100&page=1',
      );
    });

    it('getBlockedBy pages to exhaustion — a truncated blocker list would silently UNBLOCK a row', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 9000 + i, number: i + 1 }));
      const page2 = [{ id: 9999, number: 500 }];
      const { api, http } = makeApi((req) => {
        const page = new URL(req.url).searchParams.get('page');
        return { status: 200, json: page === '1' ? page1 : page2 };
      });
      const blockers = await api.getBlockedBy(7);
      expect(http.requests).toHaveLength(2); // full page → fetch page 2; short page → stop
      expect(blockers).toHaveLength(101);
      expect(blockers[100]).toBe(500);
    });

    it('getBlockedBy throws GitHubApiError on a non-200', async () => {
      const { api } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.getBlockedBy(7)).rejects.toBeInstanceOf(GitHubApiError);
    });

    it('addBlockedBy resolves the BLOCKER\'s database id first, then POSTs { issue_id } and requires 201', async () => {
      const { api, http } = makeApi((req) => {
        if (req.method === 'GET') return { status: 200, json: { number: 11, id: 3_000_001 } };
        return { status: 201, json: {} };
      });
      await expect(api.addBlockedBy(7, 11)).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(2);
      // 1: resolve the blocker (#11) → its database id
      expect(http.requests[0].url).toBe('https://api.github.com/repos/example-org/example-repo/issues/11');
      // 2: create the dependency ON the BLOCKED issue (#7), keyed by the blocker's DATABASE id
      expect(http.requests[1].method).toBe('POST');
      expect(http.requests[1].url).toBe(
        'https://api.github.com/repos/example-org/example-repo/issues/7/dependencies/blocked_by',
      );
      expect(JSON.parse(http.requests[1].body!)).toEqual({ issue_id: 3_000_001 });
    });

    it('addBlockedBy throws on a 200 (the docs pin 201) — a non-created dependency must never read as success', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { number: 11, id: 3_000_001 } }
          : { status: 200, json: {} },
      );
      await expect(api.addBlockedBy(7, 11)).rejects.toBeInstanceOf(GitHubApiError);
    });

    it('addBlockedBy surfaces GitHub\'s own message on a rejected write (422 validation failed)', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { number: 11, id: 3_000_001 } }
          : { status: 422, json: { message: 'Validation Failed' } },
      );
      await expect(api.addBlockedBy(7, 11)).rejects.toSatisfy(
        (e: unknown) => e instanceof GitHubApiError && e.message.includes('Validation Failed'),
      );
    });

    it('addBlockedBy fails BEFORE any write when the blocker does not resolve', async () => {
      const { api, http } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.addBlockedBy(7, 999)).rejects.toBeInstanceOf(GitHubApiError);
      expect(http.requests).toHaveLength(1); // the resolve only — no POST attempted
      expect(http.requests[0].method).toBe('GET');
    });

    it('addBlockedBy throws when the resolved issue carries no database id', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { number: 11 } })); // no `id`
      await expect(api.addBlockedBy(7, 11)).rejects.toSatisfy(
        (e: unknown) => e instanceof GitHubApiError && e.message.includes('database id'),
      );
    });
  });

  describe('canMergePullRequests (FOR-12 store-preflight)', () => {
    it('GETs the repo and returns true when permissions grant push', async () => {
      const { api, http } = makeApi((req) => {
        expect(req.method).toBe('GET');
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo');
        return { status: 200, json: { permissions: { push: true, maintain: false, admin: false } } };
      });
      expect(await api.canMergePullRequests()).toBe(true);
      expect(http.requests).toHaveLength(1);
    });

    it('returns false for a read-only token (no push/maintain/admin)', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { permissions: { push: false, maintain: false, admin: false, pull: true } } }));
      expect(await api.canMergePullRequests()).toBe(false);
    });

    it('returns true for maintain/admin even without push', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { permissions: { push: false, maintain: true } } }));
      expect(await api.canMergePullRequests()).toBe(true);
    });

    it('returns false when the response carries no permissions object', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { name: 'example-repo' } }));
      expect(await api.canMergePullRequests()).toBe(false);
    });

    it('throws GitHubApiError on a non-200', async () => {
      const { api } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.canMergePullRequests()).rejects.toBeInstanceOf(GitHubApiError);
    });
  });

  // ─── Landing verbs (ADR-0023 / FOR-26) ──────────────────────────────────

  describe('getPrStatus (branch → landing state)', () => {
    it('lists PRs for the branch head and returns the OPEN one + its mergeability', async () => {
      const { api, http } = makeApi((req) => {
        if (req.url.includes('/pulls?')) {
          expect(req.method).toBe('GET');
          const u = new URL(req.url);
          expect(u.searchParams.get('head')).toBe('example-org:wave/FOR-26-x');
          expect(u.searchParams.get('state')).toBe('all');
          return {
            status: 200,
            json: [{ number: 42, state: 'open', merged_at: null, html_url: 'https://github.com/example-org/example-repo/pull/42' }],
          };
        }
        // the single-PR GET carries mergeable_state (the list does NOT)
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/pulls/42');
        return { status: 200, json: { number: 42, state: 'open', mergeable_state: 'blocked', draft: false, html_url: 'https://github.com/example-org/example-repo/pull/42', node_id: 'PR_node42' } };
      });
      expect(await api.getPrStatus('wave/FOR-26-x')).toEqual({
        state: 'open',
        number: 42,
        url: 'https://github.com/example-org/example-repo/pull/42',
        mergeability: 'blocked',
      });
      expect(http.requests).toHaveLength(2);
    });

    it('returns state:none (and makes no second call) when the branch has no PR', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: [] }));
      expect(await api.getPrStatus('nope')).toEqual({ state: 'none' });
      expect(http.requests).toHaveLength(1);
    });

    it('a merged PR resolves to merged WITHOUT the mergeability call', async () => {
      const { api, http } = makeApi(() => ({
        status: 200,
        json: [{ number: 9, state: 'closed', merged_at: '2026-07-16T10:00:00Z', html_url: 'u9' }],
      }));
      expect(await api.getPrStatus('b')).toEqual({ state: 'merged', number: 9, url: 'u9' });
      expect(http.requests).toHaveLength(1);
    });

    it('a closed-unmerged PR resolves to closed-unmerged', async () => {
      const { api } = makeApi(() => ({
        status: 200,
        json: [{ number: 9, state: 'closed', merged_at: null, html_url: 'u9' }],
      }));
      expect(await api.getPrStatus('b')).toEqual({ state: 'closed-unmerged', number: 9, url: 'u9' });
    });

    it('prefers the OPEN PR when a branch has several', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [
              { number: 1, state: 'closed', merged_at: null, html_url: 'u1' },
              { number: 2, state: 'open', merged_at: null, html_url: 'u2' },
            ] }
          : { status: 200, json: { mergeable_state: 'clean', draft: false } },
      );
      expect(await api.getPrStatus('b')).toMatchObject({ state: 'open', number: 2 });
    });

    it('prefers a MERGED PR over a closed-unmerged one (merge is the stronger evidence)', async () => {
      const { api } = makeApi(() => ({
        status: 200,
        json: [
          { number: 1, state: 'closed', merged_at: null, html_url: 'u1' },
          { number: 2, state: 'closed', merged_at: '2026-07-16T10:00:00Z', html_url: 'u2' },
        ],
      }));
      expect(await api.getPrStatus('b')).toMatchObject({ state: 'merged', number: 2 });
    });

    it.each([
      ['clean', 'clean'],
      ['blocked', 'blocked'],
      ['unstable', 'unstable'],
      ['behind', 'behind'],
      ['dirty', 'dirty'],
      ['draft', 'draft'],
      ['unknown', 'unknown'],
      ['some_future_state', 'unknown'],
    ])('maps mergeable_state %s → mergeability %s', async (raw, expected) => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 1, state: 'open', merged_at: null, html_url: 'u' }] }
          : { status: 200, json: { mergeable_state: raw, draft: false } },
      );
      expect(await api.getPrStatus('b')).toMatchObject({ mergeability: expected });
    });

    it('an absent mergeable_state degrades to unknown, never to clean', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 1, state: 'open', merged_at: null, html_url: 'u' }] }
          : { status: 200, json: {} },
      );
      expect(await api.getPrStatus('b')).toMatchObject({ mergeability: 'unknown' });
    });

    it('draft:true wins over the reported mergeable_state', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 1, state: 'open', merged_at: null, html_url: 'u' }] }
          : { status: 200, json: { mergeable_state: 'clean', draft: true } },
      );
      expect(await api.getPrStatus('b')).toMatchObject({ mergeability: 'draft' });
    });

    it('throws a typed GitHubApiError on a non-200 list', async () => {
      const { api } = makeApi(() => ({ status: 401, json: { message: 'Bad credentials' } }));
      await expect(api.getPrStatus('b')).rejects.toMatchObject({ name: 'GitHubApiError', status: 401, op: 'getPrStatus' });
    });

    it('reports head.sha + base.ref off the detail payload — the check-attach coordinates, at no extra request', async () => {
      const { api, http } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : {
              status: 200,
              json: {
                number: 7,
                mergeable_state: 'clean',
                draft: false,
                head: { sha: 'c0ffee1', ref: 'wave/256-arm-check-attach' },
                base: { ref: 'main' },
              },
            },
      );
      expect(await api.getPrStatus('wave/256-arm-check-attach')).toEqual({
        state: 'open',
        number: 7,
        url: 'u7',
        mergeability: 'clean',
        headSha: 'c0ffee1',
        baseRef: 'main',
      });
      expect(http.requests).toHaveLength(2); // still exactly two calls
    });

    it('omits headSha/baseRef entirely when the payload carries neither (the pre-existing shape)', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : { status: 200, json: { mergeable_state: 'clean', draft: false } },
      );
      const status = await api.getPrStatus('b');
      expect('headSha' in status).toBe(false);
      expect('baseRef' in status).toBe(false);
    });
  });

  // ─── getReportedChecks (the arm verb's check-ATTACH input) ────────────────
  //
  // The read that closes the 2026-07-30 check-attach-latency defect: `host-pr arm`
  // direct-merged two PRs ~90 s old whose ruleset-required checks ("Engine Tests
  // (vitest)" / "Engine Typecheck (tsc)") had not attached to the head commit, on
  // the strength of GitHub reporting `mergeable_state: clean` for both "everything
  // passed" and "nothing has reported yet". These fixtures pin the request shapes
  // against GitHub's documented endpoints and the conclusion mapping.

  describe('getReportedChecks (check runs + commit statuses for a ref)', () => {
    const CHECK_RUNS = '/commits/c0ffee1/check-runs';
    const COMBINED = '/commits/c0ffee1/status';

    it('reads BOTH documented sources and folds them into one list', async () => {
      const seen: string[] = [];
      const { api } = makeApi((req) => {
        seen.push(req.url);
        if (req.url.includes('/check-runs')) {
          const u = new URL(req.url);
          // `filter=latest` is GitHub's documented default; passed EXPLICITLY so a
          // re-run can never arrive as two reports for one name.
          expect(u.searchParams.get('filter')).toBe('latest');
          expect(u.searchParams.get('per_page')).toBe('100');
          return {
            status: 200,
            json: {
              total_count: 2,
              check_runs: [
                { name: 'Engine Tests (vitest)', status: 'completed', conclusion: 'success' },
                { name: 'Engine Typecheck (tsc)', status: 'in_progress', conclusion: null },
              ],
            },
          };
        }
        return {
          status: 200,
          json: { state: 'pending', statuses: [{ context: 'ci/external', state: 'success' }] },
        };
      });
      expect(await api.getReportedChecks('c0ffee1')).toEqual([
        { name: 'Engine Tests (vitest)', state: 'success' },
        { name: 'Engine Typecheck (tsc)', state: 'pending' },
        { name: 'ci/external', state: 'success' },
      ]);
      expect(seen[0]).toContain(CHECK_RUNS);
      expect(seen[1]).toContain(COMBINED);
    });

    it('an EMPTY answer from both sources is the latency window — [] , not a failure', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { total_count: 0, check_runs: [] } }
          : { status: 200, json: { state: 'pending', statuses: [] } },
      );
      expect(await api.getReportedChecks('c0ffee1')).toEqual([]);
    });

    it.each([
      ['success', 'success'],
      ['skipped', 'success'],
      ['neutral', 'success'],
      ['failure', 'failure'],
      ['cancelled', 'failure'],
      ['timed_out', 'failure'],
      ['action_required', 'failure'],
      [null, 'failure'],
    ])('a COMPLETED run with conclusion %s maps to %s', async (conclusion, expected) => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [{ name: 'c', status: 'completed', conclusion }] } }
          : { status: 200, json: { statuses: [] } },
      );
      expect(await api.getReportedChecks('c0ffee1')).toEqual([{ name: 'c', state: expected }]);
    });

    it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
      'an UNSETTLED run status %s maps to pending, whatever the conclusion field says',
      async (status) => {
        const { api } = makeApi((req) =>
          req.url.includes('/check-runs')
            ? { status: 200, json: { check_runs: [{ name: 'c', status, conclusion: 'success' }] } }
            : { status: 200, json: { statuses: [] } },
        );
        expect(await api.getReportedChecks('c0ffee1')).toEqual([{ name: 'c', state: 'pending' }]);
      },
    );

    it.each([
      ['success', 'success'],
      ['pending', 'pending'],
      ['failure', 'failure'],
      ['error', 'failure'],
    ])('a commit status state %s maps to %s', async (state, expected) => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 200, json: { statuses: [{ context: 'ctx', state }] } },
      );
      expect(await api.getReportedChecks('c0ffee1')).toEqual([{ name: 'ctx', state: expected }]);
    });

    it('pages the check-runs list to exhaustion (a 100-item page is followed by another)', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `c${i}`, status: 'completed', conclusion: 'success' }));
      const { api, http } = makeApi((req) => {
        if (!req.url.includes('/check-runs')) return { status: 200, json: { statuses: [] } };
        return new URL(req.url).searchParams.get('page') === '1'
          ? { status: 200, json: { check_runs: page1 } }
          : { status: 200, json: { check_runs: [{ name: 'last', status: 'completed', conclusion: 'success' }] } };
      });
      const out = await api.getReportedChecks('c0ffee1');
      expect(out).toHaveLength(101);
      expect(out.at(-1)).toEqual({ name: 'last', state: 'success' });
      expect(http.requests).toHaveLength(3); // two check-run pages + the combined status
    });

    // Negative control for the fix this pins: a single-page combined-status read
    // (the pre-#287 shape) returns exactly 100 items here — never the 101 this
    // test asserts — so a regression back to one uncapped `per_page=100` GET
    // fails this exact assertion rather than being silently absorbed.
    // (Falsified live: with the pagination loop reverted to one GET, this test
    // failed with `expected 100 to be 101` / a request count of 2, not 3 — see
    // the Worker report for the verbatim transcript.)
    it('pages the combined-status list to exhaustion too — a 100-item page is followed by another (issue #287 negative control)', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ context: `ctx${i}`, state: 'success' }));
      const { api, http } = makeApi((req) => {
        if (!req.url.includes('/status')) return { status: 200, json: { check_runs: [] } };
        return new URL(req.url).searchParams.get('page') === '1'
          ? { status: 200, json: { statuses: page1 } }
          : { status: 200, json: { statuses: [{ context: 'last-ctx', state: 'success' }] } };
      });
      const out = await api.getReportedChecks('c0ffee1');
      expect(out).toHaveLength(101);
      expect(out.at(-1)).toEqual({ name: 'last-ctx', state: 'success' });
      expect(http.requests).toHaveLength(3); // the (empty) check-runs page + two combined-status pages
    });

    it('keeps the slashes of a `heads/<branch>` ref as path separators, encoding each segment', async () => {
      const { api, http } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 200, json: { statuses: [] } },
      );
      await api.getReportedChecks('heads/wave/256-arm check-attach');
      expect(http.requests[0].url).toContain('/commits/heads/wave/256-arm%20check-attach/check-runs');
    });

    it('THROWS on a non-200 check-runs read — a failed read must never counterfeit "nothing attached"', async () => {
      const { api } = makeApi(() => ({ status: 502, json: { message: 'Bad gateway' } }));
      await expect(api.getReportedChecks('c0ffee1')).rejects.toMatchObject({
        name: 'GitHubApiError',
        status: 502,
        op: 'getReportedChecks',
      });
    });

    it('THROWS on a non-200 combined-status read too', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 403, json: { message: 'Forbidden' } },
      );
      await expect(api.getReportedChecks('c0ffee1')).rejects.toMatchObject({ status: 403, op: 'getReportedChecks' });
    });

    it('drops entries with no usable name/context rather than reporting a nameless check', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [{ status: 'completed', conclusion: 'success' }, { name: '', status: 'completed', conclusion: 'success' }] } }
          : { status: 200, json: { statuses: [{ state: 'success' }, { context: '', state: 'success' }] } },
      );
      expect(await api.getReportedChecks('c0ffee1')).toEqual([]);
    });

    it('tolerates a body with no check_runs / statuses array at all', async () => {
      const { api } = makeApi(() => ({ status: 200, json: {} }));
      expect(await api.getReportedChecks('c0ffee1')).toEqual([]);
    });
  });

  describe('mergePullRequest (REST PUT .../pulls/N/merge)', () => {
    it('PUTs the merge with the requested method and returns the merge sha', async () => {
      const { api, http } = makeApi((req) => {
        expect(req.method).toBe('PUT');
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/pulls/42/merge');
        expect(JSON.parse(req.body!)).toEqual({ merge_method: 'squash' });
        return { status: 200, json: { merged: true, sha: 'abc123', message: 'Pull Request successfully merged' } };
      });
      expect(await api.mergePullRequest(42, 'squash')).toEqual({ merged: true, sha: 'abc123' });
      expect(http.requests).toHaveLength(1);
    });

    it('defaults to squash when no method is given', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 's' } }));
      await api.mergePullRequest(42);
      expect(JSON.parse(http.requests[0].body!)).toEqual({ merge_method: 'squash' });
    });

    it('honours rebase / merge methods', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 's' } }));
      await api.mergePullRequest(42, 'rebase');
      expect(JSON.parse(http.requests[0].body!)).toEqual({ merge_method: 'rebase' });
    });

    it('200 with merged:false is reported, not thrown', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { merged: false } }));
      expect(await api.mergePullRequest(42)).toEqual({ merged: false });
    });

    it('405 (not mergeable) throws a typed error carrying GitHub message', async () => {
      const { api } = makeApi(() => ({ status: 405, json: { message: 'Pull Request is not mergeable' } }));
      await expect(api.mergePullRequest(42)).rejects.toMatchObject({ name: 'GitHubApiError', status: 405, op: 'mergePullRequest' });
      await expect(api.mergePullRequest(42)).rejects.toThrow(/not mergeable/);
    });

    it('409 (head branch moved) throws a typed error', async () => {
      const { api } = makeApi(() => ({ status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } }));
      await expect(api.mergePullRequest(42)).rejects.toMatchObject({ status: 409, op: 'mergePullRequest' });
    });
  });

  describe('deleteBranch (REST DELETE .../git/refs/heads/{branch}, consumer KW-F6)', () => {
    it('DELETEs the head ref (slashes preserved as a ref path) and resolves on 204', async () => {
      const { api, http } = makeApi((req) => {
        expect(req.method).toBe('DELETE');
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/git/refs/heads/wave/FOR-66-x');
        expect(req.body).toBeUndefined();
        return { status: 204, json: null };
      });
      await expect(api.deleteBranch('wave/FOR-66-x')).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(1);
    });

    it('throws a typed GitHubApiError carrying GitHub message on a non-204 (422 reference not found)', async () => {
      const { api } = makeApi(() => ({ status: 422, json: { message: 'Reference does not exist' } }));
      await expect(api.deleteBranch('wave/x')).rejects.toMatchObject({ name: 'GitHubApiError', status: 422, op: 'deleteBranch' });
      await expect(api.deleteBranch('wave/x')).rejects.toThrow(/Reference does not exist/);
    });
  });

  describe('enableAutoMerge (GraphQL enablePullRequestAutoMerge)', () => {
    it('resolves the PR node id, then POSTs the mutation with the uppercased merge method', async () => {
      const { api, http } = makeApi((req) => {
        if (req.method === 'GET') {
          expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/pulls/42');
          return { status: 200, json: { node_id: 'PR_kwDO42' } };
        }
        expect(req.method).toBe('POST');
        expect(req.url).toBe('https://api.github.com/graphql');
        const sent = JSON.parse(req.body!);
        expect(sent.query).toContain('enablePullRequestAutoMerge');
        expect(sent.variables).toEqual({ pullRequestId: 'PR_kwDO42', mergeMethod: 'SQUASH' });
        return { status: 200, json: { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: '2026-07-16T10:00:00Z' } } } } } };
      });
      await expect(api.enableAutoMerge(42, 'squash')).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(2);
    });

    it('defaults to SQUASH', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
      );
      await api.enableAutoMerge(42);
      expect(JSON.parse(http.requests[1].body!).variables.mergeMethod).toBe('SQUASH');
    });

    it('maps rebase → REBASE and merge → MERGE', async () => {
      for (const [m, gql] of [['rebase', 'REBASE'], ['merge', 'MERGE']] as const) {
        const { api, http } = makeApi((req) =>
          req.method === 'GET'
            ? { status: 200, json: { node_id: 'n' } }
            : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
        );
        await api.enableAutoMerge(42, m);
        expect(JSON.parse(http.requests[1].body!).variables.mergeMethod).toBe(gql);
      }
    });

    // ── SPIKE 2 (ADR-0023): the exact error shape of arming an already-clean PR ──
    it('SPIKE-2: "Pull request is in clean status" → AutoMergeUnavailableError(clean-status)', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: null }, errors: [{ type: 'UNPROCESSABLE', message: ARM_CLEAN_STATUS_ERROR }] } },
      );
      const err = await api.enableAutoMerge(42).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AutoMergeUnavailableError);
      expect((err as AutoMergeUnavailableError).reason).toBe('clean-status');
    });

    it('SPIKE-2: the clean-status match is case/scope tolerant, not a byte-equality trap', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: 'Pull Request is in Clean Status.' }] } },
      );
      await expect(api.enableAutoMerge(42)).rejects.toMatchObject({ reason: 'clean-status' });
    });

    it('"Auto merge is not allowed for this repository" → AutoMergeUnavailableError(not-allowed)', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: ARM_NOT_ALLOWED_ERROR }] } },
      );
      const err = await api.enableAutoMerge(42).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AutoMergeUnavailableError);
      expect((err as AutoMergeUnavailableError).reason).toBe('not-allowed');
    });

    // ── SPIKE 1 (ADR-0023): fine-grained-PAT behaviour for the arm mutation ──
    it('SPIKE-1: a FORBIDDEN GraphQL error names the exact token permissions to grant', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { errors: [{ type: ARM_FORBIDDEN_ERROR_TYPE, message: 'Resource not accessible by personal access token' }] } },
      );
      const err = await api.enableAutoMerge(42).catch((e: unknown) => e);
      // NOT an AutoMergeUnavailableError: this is a credentials problem, and it must
      // never route into the arm-vs-merge fallback (which would merge unchecked).
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as Error).message).toMatch(/Pull requests/i);
      expect((err as Error).message).toMatch(/Contents/i);
    });

    it('SPIKE-1: the pinned token requirements are the documented arm shape', () => {
      expect(ARM_TOKEN_REQUIREMENTS.classicPatScopes).toEqual(['repo']);
      expect(ARM_TOKEN_REQUIREMENTS.fineGrainedPermissions).toEqual({
        'Pull requests': 'read-write',
        Contents: 'read-write',
      });
      // Fine-grained PATs DO reach the GraphQL endpoint (they did not at launch);
      // the arm mutation is therefore reachable with the permissions above.
      expect(ARM_TOKEN_REQUIREMENTS.fineGrainedSupportsGraphql).toBe(true);
      expect(ARM_TOKEN_REQUIREMENTS.e2eVerified).toBe(false); // honest: pinned from docs, not a live run
    });

    it('an unrecognised GraphQL error is a typed GitHubApiError, never a silent success', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { errors: [{ type: 'INTERNAL', message: 'something else entirely' }] } },
      );
      const err = await api.enableAutoMerge(42).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(AutoMergeUnavailableError);
    });

    it('throws when the PR carries no node_id (cannot address the mutation)', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { number: 42 } }));
      await expect(api.enableAutoMerge(42)).rejects.toMatchObject({ name: 'GitHubApiError', op: 'enableAutoMerge' });
    });

    it('throws on a non-200 node-id lookup', async () => {
      const { api } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.enableAutoMerge(42)).rejects.toBeInstanceOf(GitHubApiError);
    });

    it('throws on a non-200 GraphQL response', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET' ? { status: 200, json: { node_id: 'n' } } : { status: 502, json: null },
      );
      await expect(api.enableAutoMerge(42)).rejects.toMatchObject({ status: 502 });
    });
  });

  describe('getAutoMergeSetting (ADR-0023 amendment posture probe)', () => {
    it('GETs the repo and reports ON when allow_auto_merge is true', async () => {
      const { api, http } = makeApi((req) => {
        expect(req.method).toBe('GET');
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo');
        return { status: 200, json: { allow_auto_merge: true } };
      });
      expect(await api.getAutoMergeSetting()).toBe('on');
      expect(http.requests).toHaveLength(1);
    });

    it('reports OFF when the field is present and false (a VISIBLE off)', async () => {
      const { api } = makeApi(() => ({ status: 200, json: { allow_auto_merge: false } }));
      expect(await api.getAutoMergeSetting()).toBe('off');
    });

    it('reports UNKNOWN when the field is ABSENT — the token cannot see it (below maintain/admin), NOT off', async () => {
      // GitHub hides `allow_auto_merge` from a token below maintain/admin. The
      // pre-amendment code read absent as `false`; the amendment reads it as
      // `unknown` — absence of evidence is not a finding (ADR-0023 amendment).
      const { api } = makeApi(() => ({ status: 200, json: { name: 'example-repo' } }));
      expect(await api.getAutoMergeSetting()).toBe('unknown');
      // A null body is likewise unreadable → unknown, never off.
      const { api: api2 } = makeApi(() => ({ status: 200, json: null }));
      expect(await api2.getAutoMergeSetting()).toBe('unknown');
    });

    it('throws a typed error on a non-200', async () => {
      const { api } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.getAutoMergeSetting()).rejects.toMatchObject({ name: 'GitHubApiError', op: 'getAutoMergeSetting' });
    });
  });

  // A `GET /rules/branches/{branch}` response body carrying the given contexts as
  // one `required_status_checks` rule (plus an unrelated rule, to prove filtering).
  function rulesPayload(contexts: string[]): unknown {
    return [
      { type: 'commit_message_pattern', ruleset_source_type: 'Repository', ruleset_id: 7, parameters: { pattern: 'x' } },
      {
        type: 'required_status_checks',
        ruleset_source_type: 'Repository',
        ruleset_id: 42,
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: contexts.map((c) => ({ context: c, integration_id: 15368 })),
        },
      },
    ];
  }

  // Route the three GETs getRequiredChecks issues: the repo GET (default branch),
  // the legacy branch-protection GET, and the effective-rules GET.
  function routed(opts: {
    defaultBranch?: string;
    legacy: GitHubHttpResponse;
    rules: GitHubHttpResponse;
  }): (req: GitHubHttpRequest) => GitHubHttpResponse {
    return (req) => {
      if (/\/rules\/branches\//.test(req.url)) return opts.rules;
      if (/\/protection\/required_status_checks$/.test(req.url)) return opts.legacy;
      return { status: 200, json: { default_branch: opts.defaultBranch ?? 'main' } };
    };
  }

  describe('getRulesetRequiredChecks (effective-rules seam read — 2026-07-23 gate-arm gap)', () => {
    it('reads /rules/branches/{b} and extracts the required_status_checks contexts; needs only a read token', async () => {
      const { api, http } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 200, json: rulesPayload(['Engine Tests (vitest)', 'Engine Typecheck (tsc)']) },
      );
      expect(await api.getRulesetRequiredChecks()).toMatchObject({
        readable: true,
        contexts: ['Engine Tests (vitest)', 'Engine Typecheck (tsc)'],
      });
      expect(http.requests.some((r) => r.url.endsWith('/rules/branches/main'))).toBe(true);
    });

    it('a 200 with no required_status_checks rule → readable, empty (an AUTHORITATIVE "none")', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 200, json: [{ type: 'pull_request', parameters: {} }] },
      );
      expect(await api.getRulesetRequiredChecks()).toMatchObject({ readable: true, contexts: [] });
    });

    it('aggregates + de-duplicates contexts across MULTIPLE required_status_checks rules', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : {
              status: 200,
              json: [
                { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } },
                { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'b' }, { context: 'c' }] } },
              ],
            },
      );
      expect(await api.getRulesetRequiredChecks()).toMatchObject({ readable: true, contexts: ['a', 'b', 'c'] });
    });

    it('a non-200 → readable:false (no evidence), and a transport failure NEVER throws', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo') ? { status: 200, json: { default_branch: 'main' } } : { status: 404, json: {} },
      );
      expect(await api.getRulesetRequiredChecks()).toMatchObject({ readable: false, contexts: [] });
      const { api: api2 } = makeApi(() => {
        throw new Error('network down');
      });
      expect(await api2.getRulesetRequiredChecks()).toMatchObject({ readable: false });
    });
  });

  describe('getRequiredChecks (ruleset-aware, effective-rules + legacy merge — 2026-07-23 gate-arm gap)', () => {
    it('resolves the default branch, then reports present + the contexts (legacy + rules aggregate the same)', async () => {
      const { api, http } = makeApi(
        routed({
          legacy: { status: 200, json: { contexts: ['ci/test', 'ci/lint'] } },
          rules: { status: 200, json: rulesPayload(['ci/test', 'ci/lint']) },
        }),
      );
      // present, and the merged contexts are DE-DUPLICATED (the rules endpoint
      // aggregates classic branch protection, so both reads carry the same two).
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['ci/test', 'ci/lint'] });
      expect(http.requests).toHaveLength(3); // repo (default branch) + legacy + rules
    });

    it('AC1: required checks live ONLY in an active ruleset (no legacy protection) → present, names the contexts', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 404, json: { message: 'Branch not protected' } },
          rules: { status: 200, json: rulesPayload(['Engine Tests (vitest)', 'Engine Typecheck (tsc)']) },
        }),
      );
      const info = await api.getRequiredChecks();
      expect(info.state).toBe('present');
      expect(info.contexts).toEqual(['Engine Tests (vitest)', 'Engine Typecheck (tsc)']);
      expect(info.detail).toContain('Engine Tests (vitest)'); // names the found contexts
    });

    it('AC2: legacy protection 403s (no admin) but a ruleset carries checks → present, NEVER the admin-403 unknown', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 403, json: { message: 'Must have admin rights to Repository.' } },
          rules: { status: 200, json: rulesPayload(['build']) },
        }),
      );
      // The effective-rules endpoint needs no admin: the 403-degradation is gone.
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['build'] });
    });

    it('AC3: required checks live ONLY in legacy branch protection (rules endpoint carries none) → present, unchanged', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 200, json: { contexts: ['ci/test', 'ci/lint'] } },
          rules: { status: 200, json: [] }, // readable, but no required_status_checks rule
        }),
      );
      // Either source finding checks → present: the legacy read alone still answers.
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['ci/test', 'ci/lint'] });
    });

    it('AC3: still reads the newer legacy checks[] shape, merged', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 200, json: { checks: [{ context: 'build' }, { context: 'e2e' }] } },
          rules: { status: 200, json: [] },
        }),
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['build', 'e2e'] });
    });

    it('no checks in EITHER source (legacy 404 + rules readable-but-empty) → absent (the no-CI repo, KEEPS --auto)', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 404, json: { message: 'Branch not protected' } },
          rules: { status: 200, json: [] },
        }),
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'absent', contexts: [] });
    });

    it('BOTH reads blind (legacy 403 + rules read fails) → unknown — the residual advisory case, NEVER a throw', async () => {
      const { api } = makeApi(
        routed({
          legacy: { status: 403, json: { message: 'Must have admin rights to Repository.' } },
          rules: { status: 500, json: null },
        }),
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'unknown', contexts: [] });
    });

    it('an explicit branch skips the default-branch lookup and probes BOTH endpoints against it', async () => {
      const { api, http } = makeApi(
        routed({ legacy: { status: 404, json: {} }, rules: { status: 200, json: rulesPayload(['x']) } }),
      );
      await api.getRequiredChecks('release');
      expect(http.requests).toHaveLength(2); // legacy + rules, NO repo (default-branch) GET
      expect(http.requests.some((r) => r.url.includes('/branches/release/protection/'))).toBe(true);
      expect(http.requests.some((r) => r.url.endsWith('/rules/branches/release'))).toBe(true);
    });

    it('NEVER throws — a dead repo GET (default-branch resolve) degrades to unknown', async () => {
      const { api } = makeApi(() => {
        throw new Error('network down');
      });
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'unknown' });
    });
  });
});

// ── the Goal facet's milestone substrate (ADR-0044) ─────────────────────────
//
// UNEXECUTABLE CORE PATH (ADR-0030): these five endpoints cannot be driven live
// from this dispatch — the writes need a credential this row does not have, and
// no live probe was run against the reads either. So the specs below pin the
// REQUEST SHAPING against the documented form, read in this dispatch:
//
//   docs.github.com/en/rest/issues/milestones (2026-08-15) — create 201; get
//     200; list 200 with `state` DEFAULTING TO `open` and `per_page` max 100.
//   docs.github.com/en/rest/issues/issues (2026-08-15) — "List repository
//     issues"' `milestone` query parameter ("If an integer is passed, it should
//     refer to a milestone by its `number` field") and "Update an issue"'s
//     `milestone` body field ("The number of the milestone to associate this
//     issue with"), success 200.
//
// The two `state=all` assertions are the load-bearing ones: both endpoints
// default to OPEN, and either default left in place would make a shipped goal —
// or a finished member — silently vanish from the frontier.
describe('RealGitHubApi — milestones (the Goal container, ADR-0044)', () => {
  it('createMilestone POSTs title+description to /milestones and returns the number (201)', async () => {
    const { api, http } = makeApi((req) => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/milestones');
      expect(req.token).toBe('tok-abc');
      expect(JSON.parse(req.body!)).toEqual({ title: '1.0.0', description: 'the freeze' });
      return { status: 201, json: { number: 3 } };
    });
    expect(await api.createMilestone({ title: '1.0.0', description: 'the freeze' })).toEqual({
      number: 3,
    });
    expect(http.requests).toHaveLength(1);
  });

  it('createMilestone throws on a non-201 (the documented success code, not 200)', async () => {
    const { api } = makeApi(() => ({ status: 200, json: { number: 3 } }));
    await expect(api.createMilestone({ title: 'x', description: '' })).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });

  it('getMilestone maps the resource onto GhMilestone, with a null description as EMPTY prose', async () => {
    const { api } = makeApi((req) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe(
        'https://api.github.com/repos/example-org/example-repo/milestones/3',
      );
      return { status: 200, json: { number: 3, title: '1.0.0', description: null, state: 'open' } };
    });
    // `description` is documented "string or null"; the null must land as `''`,
    // never as the string "null" a bare cast would produce.
    expect(await api.getMilestone(3)).toEqual({
      number: 3,
      title: '1.0.0',
      description: '',
      state: 'open',
    });
  });

  it('getMilestone throws on a non-200', async () => {
    const { api } = makeApi(() => ({ status: 404, json: {} }));
    await expect(api.getMilestone(3)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('listMilestones asks for state=all and pages to exhaustion', async () => {
    // The `state=all` is the whole point: the endpoint DEFAULTS to `open`, so a
    // closed finish line would silently disappear from a goal panel.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `m${i}`,
      description: '',
      state: 'open',
    }));
    const page2 = [{ number: 200, title: 'shipped', description: 'd', state: 'closed' }];
    const { api, http } = makeApi((req) => {
      const url = new URL(req.url);
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('per_page')).toBe('100');
      return { status: 200, json: url.searchParams.get('page') === '1' ? page1 : page2 };
    });
    const milestones = await api.listMilestones();
    expect(http.requests).toHaveLength(2); // exhausted via the count heuristic
    expect(milestones).toHaveLength(101);
    // …and the CLOSED one really did come back.
    expect(milestones.some((m) => m.state === 'closed')).toBe(true);
  });

  it('setIssueMilestone PATCHes the ISSUE with the milestone NUMBER (200)', async () => {
    const { api, http } = makeApi((req) => {
      expect(req.method).toBe('PATCH');
      expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/issues/42');
      expect(JSON.parse(req.body!)).toEqual({ milestone: 3 });
      return { status: 200, json: {} };
    });
    await api.setIssueMilestone(42, 3);
    expect(http.requests).toHaveLength(1);
  });

  it('setIssueMilestone throws on a non-200', async () => {
    const { api } = makeApi(() => ({ status: 422, json: { message: 'nope' } }));
    await expect(api.setIssueMilestone(42, 3)).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('listMilestoneIssues resolves the milestone FIRST, then lists state=all and drops PRs', async () => {
    const members = [
      { number: 10, title: 'a', body: '', labels: [], state: 'open', state_reason: null },
      { number: 11, title: 'b', body: '', labels: [], state: 'closed', state_reason: 'completed' },
      { number: 12, title: 'a pr', body: '', labels: [], state: 'open', state_reason: null, pull_request: { url: 'x' } },
    ];
    const { api, http } = makeApi((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/milestones/3')) {
        return { status: 200, json: { number: 3, title: 'm', description: '', state: 'open' } };
      }
      expect(url.pathname).toMatch(/\/issues$/);
      expect(url.searchParams.get('milestone')).toBe('3');
      // Same reason as listMilestones, one level down: `done` is a frontier
      // reading, so closed MEMBERS must come back too.
      expect(url.searchParams.get('state')).toBe('all');
      return { status: 200, json: members };
    });

    const issues = await api.listMilestoneIssues(3);
    // the milestone resolve happened, and it happened first.
    expect(http.requests[0].url).toContain('/milestones/3');
    expect(issues.map((i) => i.number)).toEqual([10, 11]); // the PR is dropped
    expect(issues.some((i) => i.state === 'closed')).toBe(true);
  });

  it('listMilestoneIssues FAILS on an unknown milestone rather than reading back as an empty goal', async () => {
    // "no members" and "no such goal" are different claims — the same
    // absent-vs-broken line the create classifier draws. Without the up-front
    // resolve, a 200 + `[]` from the issues endpoint would launder the second
    // into the first, and the frontier would report `complete`.
    const { api, http } = makeApi((req) =>
      req.url.includes('/milestones/9')
        ? { status: 404, json: { message: 'Not Found' } }
        : { status: 200, json: [] },
    );
    await expect(api.listMilestoneIssues(9)).rejects.toBeInstanceOf(GitHubApiError);
    expect(http.requests).toHaveLength(1); // it never got as far as listing
  });
});
