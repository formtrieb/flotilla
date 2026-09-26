import { describe, it, expect } from 'vitest';
import {
  RealGitHubApi,
  GitHubApiError,
  ARM_CLEAN_STATUS_ERROR,
  ARM_NOT_ALLOWED_ERROR,
  ARM_FORBIDDEN_ERROR_TYPE,
  ARM_TOKEN_REQUIREMENTS,
} from './real-github-api';
import { AutoMergeUnavailableError, HeadMismatchError, armPullRequest, mergePullRequestNow } from '../../host-pr';
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

  // ── `duplicate` is a READ-side value of the close reason ───────────────────
  //
  // GitHub's REST "Update an issue" reference documents `state_reason` as
  // `completed | not_planned | duplicate | reopened | null`, and its issue
  // RESPONSE object carries the same enum (vendor reference read 2026-09-17).
  // `GhStateReason` used to spell four of the five, so a close made in GitHub's
  // own duplicate flow reached this seam as `null` — "no reason recorded", a
  // claim the tracker never made. The two cases below are the read and the
  // write halves of that correction, and they deliberately disagree with each
  // other: the type carries five values, the write path sends two.
  it('getIssue maps a `duplicate` close to `duplicate`, not to null', async () => {
    const { api } = makeApi(() => ({
      status: 200,
      json: { number: 7, title: 'X', body: 'Y', labels: [], state: 'closed', state_reason: 'duplicate' },
    }));
    expect(await api.getIssue(7)).toEqual({
      number: 7, title: 'X', body: 'Y', labels: [], state: 'closed', stateReason: 'duplicate',
    });
  });

  it('a state_reason GitHub does not document still lands as null — the ladder narrows, it does not widen', async () => {
    // The negative control for the case above: the read ladder gained exactly
    // one member, and anything outside the documented enum is still narrowed
    // away rather than carried through as an unknown string.
    const { api } = makeApi(() => ({
      status: 200,
      json: { number: 7, title: 'X', body: '', labels: [], state: 'closed', state_reason: 'invented' },
    }));
    expect((await api.getIssue(7)).stateReason).toBeNull();
  });

  it('nativeClose still WRITES only completed / not_planned — `duplicate` is dropped, not forwarded', async () => {
    // flotilla has no verb that closes an issue as a duplicate, so widening the
    // READ type must not widen what goes over the wire. The request body below
    // carries no `state_reason` at all, exactly as `nativeClose(7, null)` does.
    const { api, http } = makeApi(() => ({ status: 200, json: {} }));
    await api.nativeClose(7, 'duplicate');
    expect(JSON.parse(http.requests[0].body!)).toEqual({ state: 'closed' });
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

    // ── the delete (ADR-0054's unblock path). Shaped against the same doc page,
    // "Remove dependency an issue is blocked by", read 2026-09-26: DELETE
    // …/dependencies/blocked_by/{issue_id} with the BLOCKER's database id in the
    // path, answering 200.
    it('removeBlockedBy resolves the BLOCKER\'s database id first, then DELETEs …/blocked_by/{issue_id} and requires 200', async () => {
      const { api, http } = makeApi((req) => {
        if (req.method === 'GET') return { status: 200, json: { number: 11, id: 3_000_001 } };
        return { status: 200, json: { number: 11 } };
      });
      await expect(api.removeBlockedBy(7, 11)).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(2);
      expect(http.requests[0].url).toBe('https://api.github.com/repos/example-org/example-repo/issues/11');
      expect(http.requests[1].method).toBe('DELETE');
      expect(http.requests[1].url).toBe(
        'https://api.github.com/repos/example-org/example-repo/issues/7/dependencies/blocked_by/3000001',
      );
      expect(http.requests[1].body).toBeUndefined();
    });

    it('removeBlockedBy throws on any non-200 — a refused delete must never read as success', async () => {
      for (const status of [204, 403, 404, 410]) {
        const { api } = makeApi((req) =>
          req.method === 'GET'
            ? { status: 200, json: { number: 11, id: 3_000_001 } }
            : { status, json: { message: `refused ${status}` } },
        );
        await expect(api.removeBlockedBy(7, 11)).rejects.toSatisfy(
          (e: unknown) =>
            e instanceof GitHubApiError && e.op === 'removeBlockedBy' && e.status === status,
        );
      }
    });

    it('removeBlockedBy fails BEFORE the DELETE when the blocker does not resolve', async () => {
      const { api, http } = makeApi(() => ({ status: 404, json: { message: 'Not Found' } }));
      await expect(api.removeBlockedBy(7, 999)).rejects.toSatisfy(
        (e: unknown) => e instanceof GitHubApiError && e.op === 'removeBlockedBy',
      );
      expect(http.requests).toHaveLength(1);
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

    // ─── title + body: what the PR SAYS, not only where it is ──────────────
    //
    // Before these two keys, `status` answered where a PR was and never what it
    // said, so an acceptance criterion about the PR BODY was unreachable from
    // the one role contractually barred from writing to the host and from
    // reaching it by a raw CLI (wave-shared Convention 7). The read is
    // deliberately parasitic on the requests this method already makes — the
    // request-count assertions below are the load-bearing half, because a
    // correct-looking implementation that fetched the PR a second time would
    // satisfy every value assertion here and nothing else would catch it.

    it('surfaces the OPEN PR\'s title and body off the detail payload — at no extra request', async () => {
      const { api, http } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : {
              status: 200,
              json: {
                number: 7,
                mergeable_state: 'clean',
                draft: false,
                title: 'fix(engine): the landing seam reads what a PR says',
                body: 'The mutation that made the new check fail.\n\nCloses the row.',
              },
            },
      );
      expect(await api.getPrStatus('b')).toEqual({
        state: 'open',
        number: 7,
        url: 'u7',
        mergeability: 'clean',
        title: 'fix(engine): the landing seam reads what a PR says',
        body: 'The mutation that made the new check fail.\n\nCloses the row.',
      });
      // The list GET + the single-PR GET this method already made. A THIRD
      // request here would mean the content was fetched rather than read.
      expect(http.requests).toHaveLength(2);
    });

    it('a merged/closed PR surfaces them off the LIST payload — still exactly one request', async () => {
      const { api, http } = makeApi(() => ({
        status: 200,
        json: [
          {
            number: 9,
            state: 'closed',
            merged_at: '2026-09-16T10:00:00Z',
            html_url: 'u9',
            title: 'landed title',
            body: 'landed body',
          },
        ],
      }));
      expect(await api.getPrStatus('b')).toEqual({
        state: 'merged',
        number: 9,
        url: 'u9',
        title: 'landed title',
        body: 'landed body',
      });
      expect(http.requests).toHaveLength(1);
    });

    it('state:none carries NEITHER key — there is no PR to have a title or a body', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: [] }));
      const status = await api.getPrStatus('nope');
      expect(status).toEqual({ state: 'none' });
      expect('title' in status).toBe(false);
      expect('body' in status).toBe(false);
      expect(http.requests).toHaveLength(1);
    });

    it('a payload that LACKS them leaves both keys absent — never an empty string', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : { status: 200, json: { mergeable_state: 'clean', draft: false } },
      );
      const status = await api.getPrStatus('b');
      expect('title' in status).toBe(false);
      expect('body' in status).toBe(false);
    });

    it('GitHub\'s `body: null` (a PR with no description) is ABSENCE, not `null` and not `\'\'`', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : { status: 200, json: { mergeable_state: 'clean', draft: false, title: 'T', body: null } },
      );
      const status = await api.getPrStatus('b');
      expect(status.title).toBe('T');
      expect('body' in status).toBe(false);
    });

    it('an EMPTY-STRING title/body is folded into absence — the two-valued contract', async () => {
      // The departure from OpenPrRef's three-valued reading, pinned: `status`
      // never emits `''`, so a caller can test `typeof status.body === 'string'`
      // and know it holds text.
      const { api } = makeApi((req) =>
        req.url.includes('/pulls?')
          ? { status: 200, json: [{ number: 7, state: 'open', merged_at: null, html_url: 'u7' }] }
          : { status: 200, json: { mergeable_state: 'clean', draft: false, title: '', body: '' } },
      );
      const status = await api.getPrStatus('b');
      expect('title' in status).toBe(false);
      expect('body' in status).toBe(false);
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

    // ── the throw NAMES the endpoint that answered (consumer report 2026-09-04) ──
    //
    // One `op` fronts TWO endpoints here, so `{status, op}` alone cannot say
    // which read refused — and the two have different fixes on a fine-grained
    // token (Checks: Read for the check-runs source, Commit statuses: Read for
    // the combined-status source). Without the endpoint the arm's reason can
    // only say that something could not be read, which is the collapse the
    // consumer report is downstream of.

    it('a 403 on the CHECK-RUNS read names the check-runs endpoint', async () => {
      const { api } = makeApi(() => ({ status: 403, json: { message: 'Resource not accessible by personal access token' } }));
      await expect(api.getReportedChecks('c0ffee1')).rejects.toMatchObject({
        status: 403,
        op: 'getReportedChecks',
        endpoint: 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      });
    });

    it('a 403 on the COMBINED-STATUS read names the combined-status endpoint — a DIFFERENT name', async () => {
      const { api } = makeApi((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 403, json: { message: 'Resource not accessible by personal access token' } },
      );
      await expect(api.getReportedChecks('c0ffee1')).rejects.toMatchObject({
        status: 403,
        op: 'getReportedChecks',
        endpoint: 'GET /repos/{owner}/{repo}/commits/{ref}/status',
      });
    });

    it('the endpoint is a TEMPLATE, not the live URL — no owner, repo or ref leaks into a landing reason', async () => {
      const { api } = makeApi(() => ({ status: 403, json: {} }));
      let endpoint: string | undefined;
      try {
        await api.getReportedChecks('c0ffee1');
      } catch (e) {
        endpoint = (e as GitHubApiError).endpoint;
      }
      expect(endpoint).toBe('GET /repos/{owner}/{repo}/commits/{ref}/check-runs');
      expect(endpoint).not.toContain('example-org');
      expect(endpoint).not.toContain('c0ffee1');
    });
  });

  // ─── the endpoint reaches the ARM's own reason (the reported symptom) ──────
  //
  // The two fixtures above pin the thrown error. What an operator actually
  // reads is `host-pr arm`'s printed `reason`, so the claim is carried all the
  // way there: a REAL `RealGitHubApi` over a fixture HTTP seam, armed, and the
  // resulting reason inspected. Nothing here is faked between the 403 and the
  // sentence.
  //
  // Both fixtures land the SAME way — a direct merge, exactly as before the
  // endpoint existed — because a failed reports read is no evidence and no
  // evidence never changes the decision. Only the reason differs, which is
  // precisely the fix.

  describe('the reports-read endpoint reaches `host-pr arm`\'s reason (two fixtures, two names)', () => {
    /**
     * Answer every request an arm makes against a `clean` PR whose base branch
     * requires one check — up to the reports read, which the caller decides.
     */
    function armingApi(reports: (req: GitHubHttpRequest) => GitHubHttpResponse): RealGitHubApi {
      return makeApi((req) => {
        // getPrStatus — the branch list, then the single-PR detail.
        if (req.url.includes('/pulls?head=')) {
          return { status: 200, json: [{ number: 42, state: 'open', html_url: 'https://github.com/example-org/example-repo/pull/42' }] };
        }
        if (req.url.endsWith('/pulls/42')) {
          return {
            status: 200,
            json: {
              number: 42,
              mergeable_state: 'clean',
              head: { sha: 'c0ffee1' },
              base: { ref: 'main' },
            },
          };
        }
        // getRequiredChecks — legacy branch protection, then effective rules.
        if (req.url.includes('/protection/required_status_checks')) {
          return { status: 404, json: { message: 'Branch not protected' } };
        }
        if (req.url.includes('/rules/branches/')) {
          return {
            status: 200,
            json: [
              {
                type: 'required_status_checks',
                parameters: { required_status_checks: [{ context: 'Engine Tests (vitest)' }] },
              },
            ],
          };
        }
        // …and the two reads this block is about.
        if (req.url.includes('/check-runs') || req.url.includes('/commits/')) return reports(req);
        // The landing itself.
        if (req.method === 'PUT') return { status: 200, json: { merged: true, sha: 'merged1' } };
        throw new Error(`unexpected request: ${req.method} ${req.url}`);
      }).api;
    }

    const reasonAfterArm = async (reports: (req: GitHubHttpRequest) => GitHubHttpResponse): Promise<string> => {
      const out = await armPullRequest(armingApi(reports), 'b');
      // Unchanged landing: the message was wrong, the merge was not.
      expect(out).toMatchObject({ outcome: 'merged', prNumber: 42 });
      return (out as { reason: string }).reason;
    };

    it('a 403 on the check-runs read puts the check-runs endpoint in the reason', async () => {
      const reason = await reasonAfterArm(() => ({
        status: 403,
        json: { message: 'Resource not accessible by personal access token' },
      }));
      expect(reason).toContain('GET /repos/{owner}/{repo}/commits/{ref}/check-runs');
      expect(reason).toContain('HTTP 403');
      expect(reason).toContain('Resource not accessible by personal access token');
    });

    it('a 403 on the combined-status read puts the OTHER endpoint in the reason', async () => {
      const reason = await reasonAfterArm((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 403, json: { message: 'Resource not accessible by personal access token' } },
      );
      expect(reason).toContain('GET /repos/{owner}/{repo}/commits/{ref}/status');
      expect(reason).not.toContain('/check-runs');
    });

    it('…and the two reasons are DIFFERENT — which is the whole point of naming the endpoint', async () => {
      const checkRuns = await reasonAfterArm(() => ({ status: 403, json: { message: 'Forbidden' } }));
      const combined = await reasonAfterArm((req) =>
        req.url.includes('/check-runs')
          ? { status: 200, json: { check_runs: [] } }
          : { status: 403, json: { message: 'Forbidden' } },
      );
      expect(checkRuns).not.toBe(combined);
      // Both still disclose the merge was unverified, in the shipped wording.
      for (const reason of [checkRuns, combined]) {
        expect(reason).toContain('NOT verified against the required-check names:');
        expect(reason).toMatch(/the host's word alone/);
      }
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

    // ── ADR-0053: the landing message on the wire ──────────────────────────
    it('with a landing message, sends it as commit_title + commit_message — the whole body pinned', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 's' } }));
      await api.mergePullRequest(42, 'squash', { title: 'Land the fix (#42)', body: 'Why.\n\nCloses #42' });
      expect(JSON.parse(http.requests[0].body!)).toEqual({
        merge_method: 'squash',
        commit_title: 'Land the fix (#42)',
        commit_message: 'Why.\n\nCloses #42',
      });
    });

    it('an EMPTY body is sent as "" — never dropped, which would let GitHub compose its own from the commits', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 's' } }));
      await api.mergePullRequest(42, 'squash', { title: 'T (#42)', body: '' });
      const sent = JSON.parse(http.requests[0].body!);
      expect(sent).toEqual({ merge_method: 'squash', commit_title: 'T (#42)', commit_message: '' });
      expect('commit_message' in sent).toBe(true);
    });

    it('without a message (--commit-message host) sends NEITHER field — the body is exactly the pre-ADR-0053 one', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 's' } }));
      await api.mergePullRequest(42, 'squash');
      const sent = JSON.parse(http.requests[0].body!);
      expect(sent).toEqual({ merge_method: 'squash' });
      expect('commit_title' in sent).toBe(false);
      expect('commit_message' in sent).toBe(false);
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

    // ── ADR-0053: the landing message is frozen at arming ────────────────────
    const MESSAGE = { title: 'Land the fix (#42)', body: 'Why.\n\nCloses #42' };
    /** Which GraphQL mutation a request carries, read off its query — or the REST verb for a non-GraphQL call. */
    const opOf = (req: GitHubHttpRequest): string => {
      if (req.url !== 'https://api.github.com/graphql') return `${req.method} ${req.url.replace('https://api.github.com/repos/example-org/example-repo', '')}`;
      const q = JSON.parse(req.body!).query as string;
      return /disablePullRequestAutoMerge/.test(q) ? 'disable' : 'enable';
    };

    it('with a landing message, the mutation carries commitHeadline + commitBody — the variables pinned whole', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'PR_kwDO42', auto_merge: null } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
      );
      await api.enableAutoMerge(42, 'squash', MESSAGE);
      const sent = JSON.parse(http.requests[1].body!);
      expect(sent.variables).toEqual({
        pullRequestId: 'PR_kwDO42',
        mergeMethod: 'SQUASH',
        commitHeadline: 'Land the fix (#42)',
        commitBody: 'Why.\n\nCloses #42',
      });
      // The input fields are WIRED into the mutation, not merely sent as unused variables.
      expect(sent.query).toContain('commitHeadline:$commitHeadline');
      expect(sent.query).toContain('commitBody:$commitBody');
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'enable']);
    });

    it('an EMPTY body is sent as commitBody "" — never omitted (GitHub: "if omitted, a default message will be used")', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
      );
      await api.enableAutoMerge(42, 'squash', { title: 'T (#42)', body: '' });
      const vars = JSON.parse(http.requests[1].body!).variables;
      expect(vars.commitBody).toBe('');
      expect('commitBody' in vars).toBe(true);
    });

    it('without a message (--commit-message host) the mutation is the pre-ADR-0053 one: no headline, no body', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n' } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
      );
      await api.enableAutoMerge(42, 'squash');
      const sent = JSON.parse(http.requests[1].body!);
      expect(sent.variables).toEqual({ pullRequestId: 'n', mergeMethod: 'SQUASH' });
      expect(sent.query).not.toContain('commitHeadline');
      expect(sent.query).not.toContain('commitBody');
    });

    // ── The re-arm refresh (AC6): disable, then enable — the pinned sequence ──
    //
    // GitHub's own GraphQL schema documents `enablePullRequestAutoMerge` only as
    // "Enable the default auto-merge on a pull request" and says nothing of a
    // second enable on an armed PR, so the adapter relies on the sequence whose
    // every step IS documented: disable, then enable with the new message.
    it('a PR already armed with a DIFFERENT message is refreshed: GET → disable → enable(new message), in that order', async () => {
      const { api, http } = makeApi((req) => {
        if (req.method === 'GET') {
          return {
            status: 200,
            json: {
              node_id: 'PR_kwDO42',
              auto_merge: { merge_method: 'squash', commit_title: 'The old title (#42)', commit_message: 'The old body.' },
            },
          };
        }
        return opOf(req) === 'disable'
          ? { status: 200, json: { data: { disablePullRequestAutoMerge: { pullRequest: { number: 42 } } } } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } };
      });
      await api.enableAutoMerge(42, 'squash', MESSAGE);

      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'disable', 'enable']);
      expect(JSON.parse(http.requests[1].body!).variables).toEqual({ pullRequestId: 'PR_kwDO42' });
      expect(JSON.parse(http.requests[2].body!).variables).toMatchObject({
        commitHeadline: 'Land the fix (#42)',
        commitBody: 'Why.\n\nCloses #42',
      });
    });

    it('a changed MERGE METHOD alone also refreshes — the frozen request is the whole landing, not just its text', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n', auto_merge: { merge_method: 'merge', commit_title: MESSAGE.title, commit_message: MESSAGE.body } } }
          : { status: 200, json: { data: {} } },
      );
      await api.enableAutoMerge(42, 'squash', MESSAGE);
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'disable', 'enable']);
    });

    it('a PR already armed with EXACTLY this method, title and body is a no-op — an idempotent re-run never disarms it', async () => {
      const { api, http } = makeApi(() => ({
        status: 200,
        json: { node_id: 'n', auto_merge: { merge_method: 'squash', commit_title: MESSAGE.title, commit_message: MESSAGE.body } },
      }));
      await expect(api.enableAutoMerge(42, 'squash', MESSAGE)).resolves.toBeUndefined();
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42']);
    });

    it('under --commit-message host an armed PR is re-enabled exactly as before ADR-0053 — no disable', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n', auto_merge: { merge_method: 'squash', commit_title: 'x', commit_message: 'y' } } }
          : { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } },
      );
      await api.enableAutoMerge(42, 'squash');
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'enable']);
    });

    it('a FAILED disable is a loud GitHubApiError, sends no enable, and is never routed as clean-status — even when its text says "clean status"', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n', auto_merge: { merge_method: 'squash', commit_title: 'old', commit_message: '' } } }
          : { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: 'Pull request is in clean status' }] } },
      );
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);
      // A clean-status mapping here would send the arm into a DIRECT MERGE on
      // the strength of a failed disable — the one routing this must never do.
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(AutoMergeUnavailableError);
      expect((err as Error).message).toMatch(/refreshing its frozen landing message failed while disabling/);
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'disable']);
    });

    it('a non-200 disable is a loud GitHubApiError too', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'n', auto_merge: { merge_method: 'squash', commit_title: 'old', commit_message: '' } } }
          : { status: 502, json: null },
      );
      await expect(api.enableAutoMerge(42, 'squash', MESSAGE)).rejects.toMatchObject({
        name: 'GitHubApiError',
        status: 502,
        op: 'enableAutoMerge',
      });
    });

    // ── The refresh's one failure edge: disable succeeded, re-enable failed ──
    //
    // The disable has run, so the PR is no longer the PR the operator armed: it
    // is UNARMED. An error that only says "the enable failed" reads as "nothing
    // changed". So every UNTYPED re-enable failure must say what state it left
    // the PR in and how to get back — while the two TYPED refusals keep the
    // routing they had before the refresh existed.
    const ARMED_WITH_OLD = { node_id: 'n', auto_merge: { merge_method: 'squash', commit_title: 'old (#42)', commit_message: 'old' } };
    /** GET → the PR armed with an older message; disable → ok; enable → `enable(req)`. */
    function refreshApi(enable: (req: GitHubHttpRequest) => GitHubHttpResponse) {
      return makeApi((req) => {
        if (req.method === 'GET') return { status: 200, json: ARMED_WITH_OLD };
        return opOf(req) === 'disable'
          ? { status: 200, json: { data: { disablePullRequestAutoMerge: { pullRequest: { number: 42 } } } } }
          : enable(req);
      });
    }
    /**
     * The things the unarmed error has to say — each its own assertion, so a
     * regression names which one went. The recovery sentence (Symptom 2, issue
     * #995) is CONDITIONAL: "restores it" must never stand alone — it is
     * qualified by a transient/persistent split, both halves present.
     */
    function expectSaysUnarmed(err: unknown): void {
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(AutoMergeUnavailableError);
      const text = (err as Error).message;
      expect(text).toMatch(/DISABLED its auto-merge/);
      expect(text).toMatch(/PR #42 is now UNARMED/);
      expect(text).toMatch(/Re-running `host-pr arm` restores it/);
      // The recovery is CONDITIONAL, not asserted flat — no unconditional
      // "restores it" (AC3). Both the transient case (restores) and the
      // persistent case (fails the re-run the same way) are named.
      expect(text).toMatch(/restores it[^.]*transient/i);
      expect(text).toMatch(/persistent[^.]*fails[^.]*same way/i);
      expect((err as GitHubApiError).op).toBe('enableAutoMerge');
    }

    it.each([
      ['a non-200 answer', (): GitHubHttpResponse => ({ status: 502, json: { message: 'Bad Gateway' } }), 502, /Bad Gateway/],
      [
        'an unrecognised GraphQL error',
        (): GitHubHttpResponse => ({ status: 200, json: { errors: [{ type: 'INTERNAL', message: 'something else entirely' }] } }),
        200,
        /something else entirely/,
      ],
      [
        'a FORBIDDEN GraphQL error — its token guidance kept',
        (): GitHubHttpResponse => ({
          status: 200,
          json: { errors: [{ type: ARM_FORBIDDEN_ERROR_TYPE, message: 'Resource not accessible by personal access token' }] },
        }),
        200,
        /Pull requests: Read and write/,
      ],
    ])('re-enable fails with %s after the disable → the error says auto-merge was disabled, the PR is unarmed, and re-running arm restores it', async (_label, answer, status, cause) => {
      const { api, http } = refreshApi(answer);
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);
      expectSaysUnarmed(err);
      // The underlying failure is kept, verbatim, and its HTTP status carried over.
      expect((err as Error).message).toMatch(cause);
      expect((err as GitHubApiError).status).toBe(status);
      // The disable DID run — the claim in the message is about a write that happened.
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'disable', 'enable']);
    });

    it('re-enable request THROWS before any answer (transport) after the disable → the same three statements, status 0', async () => {
      const { api } = makeApi((req) => {
        if (req.method === 'GET') return { status: 200, json: ARMED_WITH_OLD };
        if (opOf(req) === 'disable') return { status: 200, json: { data: {} } };
        throw new TypeError('fetch failed');
      });
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);
      expectSaysUnarmed(err);
      expect((err as Error).message).toMatch(/fetch failed/);
      expect((err as GitHubApiError).status).toBe(0);
    });

    it('CONTROL — the same untyped failure on a FIRST arm (nothing disabled) claims no disable and no unarmed PR', async () => {
      // The wording is conditional on the disable having run. A PR that was never
      // armed was never disarmed, and saying so would send an operator hunting
      // for a state change that did not happen.
      const { api, http } = makeApi((req) =>
        req.method === 'GET' ? { status: 200, json: { node_id: 'n', auto_merge: null } } : { status: 502, json: { message: 'Bad Gateway' } },
      );
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as Error).message).not.toMatch(/DISABLED|UNARMED|restores it/);
      expect((err as Error).message).toBe('GitHub enableAutoMerge failed: Bad Gateway');
      expect(http.requests.map(opOf)).toEqual(['GET /pulls/42', 'enable']);
    });

    // AC1 (not-allowed) and AC2 (clean-status), driven by the same table: a
    // TYPED refusal that follows a successful disable keeps its ERROR CLASS
    // and its ROUTING KEY (`.reason`) exactly as a first arm's — the arm
    // intent's `err.reason` switch (host-pr.ts) must fire identically either
    // way — but its MESSAGE now additionally states that the refresh's own
    // disable already ran and the PR is unarmed (Symptom 1, issue #995).
    //
    // NEGATIVE CONTROL for the first row (`not-allowed`): reverting the
    // `disarmedRefusal` production change and re-running this exact spec was
    // observed to fail on the two new assertions below (`toMatch(/disabled its
    // auto-merge/)` and `toMatch(/now unarmed/)`) while the pre-existing
    // class/reason assertions kept passing — see the PR body for the verbatim
    // failing output.
    it.each([
      ['not-allowed', ARM_NOT_ALLOWED_ERROR],
      ['clean-status', ARM_CLEAN_STATUS_ERROR],
    ] as const)('a TYPED %s refusal on the re-enable keeps its class and reason, but the message now names the disarm', async (reason, hostSays) => {
      const typed = (): GitHubHttpResponse => ({ status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: hostSays }] } });
      const afterRefresh = await refreshApi(typed).api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);
      const firstArm = await makeApi((req) =>
        req.method === 'GET' ? { status: 200, json: { node_id: 'n', auto_merge: null } } : typed(),
      ).api.enableAutoMerge(42, 'squash', MESSAGE).catch((e: unknown) => e);

      // CLASS and ROUTING (`.reason`) — unchanged on both paths.
      expect(afterRefresh).toBeInstanceOf(AutoMergeUnavailableError);
      expect((afterRefresh as AutoMergeUnavailableError).reason).toBe(reason);
      expect(firstArm).toBeInstanceOf(AutoMergeUnavailableError);
      expect((firstArm as AutoMergeUnavailableError).reason).toBe(reason);

      // A first arm (nothing was ever disabled) says nothing about a disarm —
      // its message is the host's refusal text, untouched.
      expect((firstArm as Error).message).toBe(hostSays);
      expect((firstArm as Error).message).not.toMatch(/disabled its auto-merge/i);

      // The refresh path's message differs from the first-arm one: it now
      // names the disarm, says the PR is unarmed, AND keeps the host's own
      // refusal text verbatim (so an operator loses no information).
      const text = (afterRefresh as Error).message;
      expect(text).not.toBe((firstArm as Error).message);
      expect(text).toMatch(/disabled its auto-merge/i);
      expect(text).toMatch(/now unarmed/i);
      expect(text.endsWith(hostSays)).toBe(true);
    });
  });

  // ── The typed refusals after a refresh, routed by the arm intent itself ──────
  //
  // The adapter rethrowing them untouched is half the claim; the other half is
  // that `armPullRequest` still routes each one exactly as it would on a first
  // arm. Driven through a real RealGitHubApi so the refresh's disable is on the
  // wire in front of the refusal.
  describe('typed refusals on a refresh re-enable keep their routing (ADR-0053)', () => {
    const PR_TITLE = 'Land the fix';
    /** PR #42 on branch `b`, armed with an OLDER message; the re-enable answers with `refusal`. */
    function armedApi(refusal: string, mergeable = 'blocked') {
      return makeApi((req) => {
        if (req.url.includes('/pulls?head=')) {
          return { status: 200, json: [{ number: 42, state: 'open', html_url: 'https://github.com/example-org/example-repo/pull/42' }] };
        }
        if (req.method === 'GET' && req.url.endsWith('/pulls/42')) {
          return {
            status: 200,
            json: {
              number: 42,
              node_id: 'PR_42',
              mergeable_state: mergeable,
              title: PR_TITLE,
              body: 'New body.',
              auto_merge: { merge_method: 'squash', commit_title: 'Old (#42)', commit_message: 'Old body.' },
            },
          };
        }
        if (req.url.endsWith('/graphql')) {
          return /disablePullRequestAutoMerge/.test(JSON.parse(req.body!).query)
            ? { status: 200, json: { data: { disablePullRequestAutoMerge: { pullRequest: { number: 42 } } } } }
            : { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: refusal }] } };
        }
        if (req.method === 'PUT') return { status: 200, json: { merged: true, sha: 'm1' } };
        if (req.url.includes('/protection/required_status_checks')) return { status: 404, json: {} };
        if (req.url.includes('/rules/branches/')) return { status: 200, json: [] };
        if (req.method === 'GET' && req.url.endsWith('/example-repo')) return { status: 200, json: { default_branch: 'main' } };
        throw new Error(`unexpected request: ${req.method} ${req.url}`);
      });
    }

    it('clean-status → still merged directly, carrying the new message', async () => {
      const { api, http } = armedApi(ARM_CLEAN_STATUS_ERROR);
      const out = await armPullRequest(api, 'b');
      expect(out).toMatchObject({ outcome: 'merged', landingMessage: { title: `${PR_TITLE} (#42)` } });
      expect(out.reason).toMatch(/already clean/);
      expect(out.reason).not.toMatch(/UNARMED/);
      const put = http.requests.find((r) => r.method === 'PUT')!;
      expect(JSON.parse(put.body!)).toMatchObject({ commit_title: `${PR_TITLE} (#42)`, commit_message: 'New body.' });
    });

    // Disclosure 995.1: the refusal's message says "the PR is now unarmed" —
    // true when it is thrown — and the two legs that go on to MERGE used to
    // quote it whole, so a successful outcome's reason claimed the PR it had
    // just landed was unarmed. The `/UNARMED/` checks above are case-sensitive
    // and never saw the lower-case phrase; these pin the whole reason instead.
    it('clean-status → merged, and the reason (pinned whole) never claims the PR is unarmed', async () => {
      const { api } = armedApi(ARM_CLEAN_STATUS_ERROR);
      const out = await armPullRequest(api, 'b');
      expect(out.outcome).toBe('merged');
      expect(out.reason).toBe(
        'Host rejected the arm: the PR is already clean (nothing pending) — merged directly instead. ' +
          `[${ARM_CLEAN_STATUS_ERROR}] This arm had first disabled the PR's earlier auto-merge, to refresh its ` +
          'frozen landing message (ADR-0053).',
      );
      expect(out.reason).not.toMatch(/unarmed/i);
    });

    it('not-allowed with nothing required pending (controlled degrade) → merged, and the reason never claims the PR is unarmed', async () => {
      const { api } = armedApi(ARM_NOT_ALLOWED_ERROR, 'unstable');
      const out = await armPullRequest(api, 'b');
      expect(out.outcome).toBe('merged');
      expect(out.reason).toBe(
        'Host rejected the arm: this repository does not permit auto-merge, and no required check is pending — ' +
          `merged directly instead (controlled degrade). [${ARM_NOT_ALLOWED_ERROR}] This arm had first disabled ` +
          "the PR's earlier auto-merge, to refresh its frozen landing message (ADR-0053).",
      );
      expect(out.reason).not.toMatch(/unarmed/i);
    });

    it('not-allowed with a required check pending → still refused, with the not-allowed reason', async () => {
      const { api, http } = armedApi(ARM_NOT_ALLOWED_ERROR, 'blocked');
      const out = await armPullRequest(api, 'b');
      expect(out.outcome).toBe('refused');
      expect(out.reason).toMatch(/does not permit auto-merge/);
      expect(out.reason).not.toMatch(/UNARMED/);
      expect(http.requests.some((r) => r.method === 'PUT')).toBe(false);
    });
  });

  // ── ADR-0053 end to end: from the PR payload's title/body to the wire ────────
  //
  // The engine composes the message from the status read; the adapter puts it
  // on the wire. These drive BOTH through a real RealGitHubApi, so the pinned
  // request bodies are the ones a live landing sends for this PR payload.
  describe('the landing message, from the PR payload to the request body (ADR-0053)', () => {
    const PR_TITLE = 'Three residues around the staleness advisory';
    const PR_BODY = 'What changed and why.\n\nCloses #42\n';

    /** A GitHub whose PR #42 carries PR_TITLE/PR_BODY; `mergeable` is the detail read's mergeable_state. */
    function landingApi(mergeable: string, body: string | null = PR_BODY) {
      return makeApi((req) => {
        if (req.url.includes('/pulls?head=')) {
          return { status: 200, json: [{ number: 42, state: 'open', html_url: 'https://github.com/example-org/example-repo/pull/42' }] };
        }
        if (req.method === 'GET' && req.url.endsWith('/pulls/42')) {
          return { status: 200, json: { number: 42, node_id: 'PR_42', mergeable_state: mergeable, title: PR_TITLE, body, auto_merge: null } };
        }
        if (req.method === 'PUT') return { status: 200, json: { merged: true, sha: 'm1' } };
        if (req.url.endsWith('/graphql')) return { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } };
        // A `clean` arm also consults the required checks: answer "none required".
        if (req.url.includes('/protection/required_status_checks')) return { status: 404, json: {} };
        if (req.url.includes('/rules/branches/')) return { status: 200, json: [] };
        if (req.method === 'GET' && req.url.endsWith('/example-repo')) return { status: 200, json: { default_branch: 'main' } };
        throw new Error(`unexpected request: ${req.method} ${req.url}`);
      });
    }

    it('merge: the PUT carries commit_title "<PR title> (#42)" and commit_message = the PR body verbatim', async () => {
      const { api, http } = landingApi('blocked');
      const out = await mergePullRequestNow(api, 'b');
      const put = http.requests.find((r) => r.method === 'PUT')!;
      expect(JSON.parse(put.body!)).toEqual({
        merge_method: 'squash',
        commit_title: `${PR_TITLE} (#42)`,
        commit_message: PR_BODY,
      });
      expect(out).toMatchObject({
        outcome: 'merged',
        landingMessage: { title: `${PR_TITLE} (#42)`, bodyBytes: Buffer.byteLength(PR_BODY, 'utf8') },
      });
    });

    it('arm: the mutation carries commitHeadline/commitBody with the SAME two values', async () => {
      const { api, http } = landingApi('blocked');
      const out = await armPullRequest(api, 'b');
      const gql = http.requests.find((r) => r.url.endsWith('/graphql'))!;
      expect(JSON.parse(gql.body!).variables).toEqual({
        pullRequestId: 'PR_42',
        mergeMethod: 'SQUASH',
        commitHeadline: `${PR_TITLE} (#42)`,
        commitBody: PR_BODY,
      });
      expect(out).toMatchObject({ outcome: 'armed', landingMessage: { title: `${PR_TITLE} (#42)` } });
    });

    it('arm on a clean PR merges with the same title and body', async () => {
      const { api, http } = landingApi('clean');
      expect(await armPullRequest(api, 'b')).toMatchObject({ outcome: 'merged' });
      const put = http.requests.find((r) => r.method === 'PUT')!;
      expect(JSON.parse(put.body!)).toMatchObject({ commit_title: `${PR_TITLE} (#42)`, commit_message: PR_BODY });
    });

    it('a PR with NO description (GitHub sends body: null) lands with commit_message "" — not "null", not "undefined"', async () => {
      const { api, http } = landingApi('blocked', null);
      await mergePullRequestNow(api, 'b');
      const put = http.requests.find((r) => r.method === 'PUT')!;
      expect(put.body).not.toMatch(/null|undefined/);
      expect(JSON.parse(put.body!)).toEqual({ merge_method: 'squash', commit_title: `${PR_TITLE} (#42)`, commit_message: '' });
    });

    it('--commit-message host: neither path sends any title or body field', async () => {
      const merged = landingApi('blocked');
      await mergePullRequestNow(merged.api, 'b', 'squash', { commitMessage: 'host' });
      expect(JSON.parse(merged.http.requests.find((r) => r.method === 'PUT')!.body!)).toEqual({ merge_method: 'squash' });

      const armed = landingApi('blocked');
      await armPullRequest(armed.api, 'b', 'squash', { commitMessage: 'host' });
      const vars = JSON.parse(armed.http.requests.find((r) => r.url.endsWith('/graphql'))!.body!).variables;
      expect(vars).toEqual({ pullRequestId: 'PR_42', mergeMethod: 'SQUASH' });
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

// ─── ADR-0055: the expected head, handed to the host itself ─────────────────
//
// On GitHub the pin is the host's: the REST merge's `sha` ("SHA that pull
// request head must match to allow merge"; 409 when it does not) and the arm
// mutation's `expectedHeadOid` ("The expected head OID of the pull request").
// Each is sent ONLY when an expected head is supplied, so a landing without
// one is byte-identical to before.
describe('RealGitHubApi — the expected head (ADR-0055)', () => {
  const REVIEWED = 'a'.repeat(40);
  const MOVED = 'b'.repeat(40);
  const MESSAGE = { title: 'Land the fix (#42)', body: 'Why.\n\nCloses #42' };
  const isGraphql = (req: GitHubHttpRequest) => req.url === 'https://api.github.com/graphql';
  const queryOf = (req: GitHubHttpRequest) => JSON.parse(req.body!).query as string;
  const ARMED_OK = { status: 200, json: { data: { enablePullRequestAutoMerge: {} } } };

  describe('mergePullRequest', () => {
    it('sends the expected head as `sha` beside the method and the message', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 'm' } }));
      await api.mergePullRequest(42, 'squash', MESSAGE, REVIEWED);
      expect(JSON.parse(http.requests[0].body!)).toEqual({
        merge_method: 'squash',
        commit_title: MESSAGE.title,
        commit_message: MESSAGE.body,
        sha: REVIEWED,
      });
      expect(http.requests).toHaveLength(1); // the host pins it — no read of our own first
    });

    it('without an expected head, no `sha` key is sent', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { merged: true, sha: 'm' } }));
      await api.mergePullRequest(42, 'squash', MESSAGE);
      expect('sha' in JSON.parse(http.requests[0].body!)).toBe(false);
    });

    it('a 409 on a pinned merge is a HeadMismatchError naming both heads — the actual one read back', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'PUT'
          ? { status: 409, json: { message: 'Head branch was modified. Review and try the merge again.' } }
          : { status: 200, json: { number: 42, head: { sha: MOVED } } },
      );
      const err = await api.mergePullRequest(42, 'squash', undefined, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HeadMismatchError);
      expect(err).toMatchObject({ expected: REVIEWED, actual: MOVED });
      expect((err as HeadMismatchError).hostSaid).toMatch(/HTTP 409: Head branch was modified/);
      expect(http.requests.map((r) => r.method)).toEqual(['PUT', 'GET']);
    });

    it('a 409 whose read-back fails still refuses, naming the actual head as not readable', async () => {
      const { api } = makeApi((req) =>
        req.method === 'PUT' ? { status: 409, json: { message: 'Head branch was modified.' } } : { status: 500, json: null },
      );
      const err = await api.mergePullRequest(42, 'squash', undefined, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HeadMismatchError);
      expect((err as HeadMismatchError).actual).toBeUndefined();
      expect((err as Error).message).toContain('(not readable)');
    });
  });

  describe('enableAutoMerge', () => {
    it('a first arm carries `expectedHeadOid`, wired into the mutation input', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET' ? { status: 200, json: { node_id: 'PR_42', auto_merge: null, head: { sha: REVIEWED } } } : ARMED_OK,
      );
      await api.enableAutoMerge(42, 'squash', undefined, REVIEWED);
      const sent = JSON.parse(http.requests[1].body!);
      expect(sent.variables).toEqual({ pullRequestId: 'PR_42', mergeMethod: 'SQUASH', expectedHeadOid: REVIEWED });
      expect(sent.query).toContain('$expectedHeadOid:GitObjectID!');
      expect(sent.query).toContain('expectedHeadOid:$expectedHeadOid');
    });

    it('with a landing message too, the mutation carries the headline, the body AND the head', async () => {
      const { api, http } = makeApi((req) =>
        req.method === 'GET' ? { status: 200, json: { node_id: 'PR_42', auto_merge: null, head: { sha: REVIEWED } } } : ARMED_OK,
      );
      await api.enableAutoMerge(42, 'squash', MESSAGE, REVIEWED);
      const sent = JSON.parse(http.requests[1].body!);
      expect(sent.variables).toEqual({
        pullRequestId: 'PR_42',
        mergeMethod: 'SQUASH',
        commitHeadline: MESSAGE.title,
        commitBody: MESSAGE.body,
        expectedHeadOid: REVIEWED,
      });
      expect(sent.query).toContain('commitBody:$commitBody,expectedHeadOid:$expectedHeadOid');
    });

    it('without an expected head, neither the variable nor the input field is sent', async () => {
      for (const message of [undefined, MESSAGE]) {
        const { api, http } = makeApi((req) =>
          req.method === 'GET' ? { status: 200, json: { node_id: 'PR_42', auto_merge: null, head: { sha: REVIEWED } } } : ARMED_OK,
        );
        await api.enableAutoMerge(42, 'squash', message);
        const sent = JSON.parse(http.requests[1].body!);
        expect('expectedHeadOid' in sent.variables).toBe(false);
        expect(sent.query).not.toContain('expectedHeadOid');
      }
    });

    it('a head in the PR payload that differs refuses BEFORE any mutation — and before a refresh could disarm the PR', async () => {
      const { api, http } = makeApi(() => ({
        status: 200,
        json: {
          node_id: 'PR_42',
          head: { sha: MOVED },
          auto_merge: { merge_method: 'squash', commit_title: 'Old (#42)', commit_message: 'Old.' },
        },
      }));
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HeadMismatchError);
      expect(err).toMatchObject({ expected: REVIEWED, actual: MOVED });
      expect(http.requests.filter(isGraphql)).toHaveLength(0); // no disable, no enable
    });

    it('an untyped GraphQL error on a pinned arm is re-checked against the head: a moved head is the refusal', async () => {
      let reads = 0;
      const { api } = makeApi((req) => {
        if (req.method === 'GET') {
          reads++;
          // First read (node id): the reviewed head. Second read (after the error): moved.
          return { status: 200, json: { node_id: 'PR_42', auto_merge: null, head: { sha: reads === 1 ? REVIEWED : MOVED } } };
        }
        return { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: 'some wording the schema never documented' }] } };
      });
      const err = await api.enableAutoMerge(42, 'squash', undefined, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HeadMismatchError);
      expect(err).toMatchObject({ expected: REVIEWED, actual: MOVED });
      expect((err as HeadMismatchError).hostSaid).toMatch(/some wording the schema never documented/);
    });

    it('CONTROL — the same untyped error with the head unmoved stays the ordinary GitHubApiError', async () => {
      const { api } = makeApi((req) =>
        req.method === 'GET'
          ? { status: 200, json: { node_id: 'PR_42', auto_merge: null, head: { sha: REVIEWED } } }
          : { status: 200, json: { errors: [{ type: 'INTERNAL', message: 'boom' }] } },
      );
      const err = await api.enableAutoMerge(42, 'squash', undefined, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(HeadMismatchError);
    });

    it('a head that moves INSIDE a refresh keeps its class and says the disable already ran', async () => {
      let reads = 0;
      const { api, http } = makeApi((req) => {
        if (req.method === 'GET') {
          reads++;
          return {
            status: 200,
            json: {
              node_id: 'PR_42',
              head: { sha: reads === 1 ? REVIEWED : MOVED },
              auto_merge: { merge_method: 'squash', commit_title: 'Old (#42)', commit_message: 'Old.' },
            },
          };
        }
        return /disablePullRequestAutoMerge/.test(queryOf(req))
          ? { status: 200, json: { data: {} } }
          : { status: 200, json: { errors: [{ type: 'UNPROCESSABLE', message: 'head moved' }] } };
      });
      const err = await api.enableAutoMerge(42, 'squash', MESSAGE, REVIEWED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HeadMismatchError);
      expect((err as HeadMismatchError).hostSaid).toMatch(/now unarmed/);
      expect(http.requests.filter(isGraphql).map((r) => (/disable/.test(queryOf(r)) ? 'disable' : 'enable'))).toEqual([
        'disable',
        'enable',
      ]);
    });
  });

  // Through the landing verbs, so the host's refusal is seen as the verbs
  // report it: outcome `refused`, both commits named.
  describe('through the landing verbs', () => {
    function hostApi(mergeable: string, onPut: () => GitHubHttpResponse) {
      // The status read sees the reviewed head; a 409 means a push landed in
      // between, so every read after it sees the moved one.
      let moved = false;
      return makeApi((req) => {
        if (req.url.includes('/pulls?head=')) {
          return { status: 200, json: [{ number: 42, state: 'open', html_url: 'https://github.com/example-org/example-repo/pull/42' }] };
        }
        if (req.method === 'GET' && req.url.endsWith('/pulls/42')) {
          return {
            status: 200,
            json: { number: 42, node_id: 'PR_42', mergeable_state: mergeable, title: 'T', head: { sha: moved ? MOVED : REVIEWED } },
          };
        }
        if (req.method === 'PUT') {
          const res = onPut();
          moved = res.status === 409;
          return res;
        }
        if (req.url.includes('/protection/required_status_checks')) return { status: 404, json: {} };
        if (req.url.includes('/rules/branches/')) return { status: 200, json: [] };
        if (req.method === 'GET' && req.url.endsWith('/example-repo')) return { status: 200, json: { default_branch: 'main' } };
        throw new Error(`unexpected request: ${req.method} ${req.url}`);
      });
    }

    it('merge: the host 409s the pinned merge → refused, the reason naming both commits', async () => {
      const { api, http } = hostApi('clean', () => ({ status: 409, json: { message: 'Head branch was modified.' } }));
      const out = await mergePullRequestNow(api, 'b', 'squash', { expectHead: REVIEWED });
      expect(out.outcome).toBe('refused');
      expect(out.reason).toContain(REVIEWED);
      expect(out.reason).toContain(MOVED);
      expect(out.reason).toMatch(/host refused/i);
      expect(JSON.parse(http.requests.find((r) => r.method === 'PUT')!.body!).sha).toBe(REVIEWED);
    });

    it('merge: a matching head lands, and the pin rode the request', async () => {
      const { api, http } = hostApi('clean', () => ({ status: 200, json: { merged: true, sha: 'm' } }));
      const out = await mergePullRequestNow(api, 'b', 'squash', { expectHead: REVIEWED });
      expect(out.outcome).toBe('merged');
      expect(JSON.parse(http.requests.find((r) => r.method === 'PUT')!.body!).sha).toBe(REVIEWED);
    });
  });
});
