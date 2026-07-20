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

  describe('getRequiredChecks (ADR-0023 report-only probe)', () => {
    it('resolves the default branch, then reports present + the contexts', async () => {
      const { api, http } = makeApi((req) => {
        if (req.url === 'https://api.github.com/repos/example-org/example-repo') {
          return { status: 200, json: { default_branch: 'main' } };
        }
        expect(req.url).toBe('https://api.github.com/repos/example-org/example-repo/branches/main/protection/required_status_checks');
        return { status: 200, json: { contexts: ['ci/test', 'ci/lint'] } };
      });
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['ci/test', 'ci/lint'] });
      expect(http.requests).toHaveLength(2);
    });

    it('reads the newer checks[] shape as well as the legacy contexts[]', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 200, json: { checks: [{ context: 'build' }, { context: 'e2e' }] } },
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'present', contexts: ['build', 'e2e'] });
    });

    it('an explicit branch skips the default-branch lookup', async () => {
      const { api, http } = makeApi(() => ({ status: 200, json: { contexts: ['x'] } }));
      await api.getRequiredChecks('release');
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0].url).toContain('/branches/release/protection/');
    });

    it('404 (branch not protected) → absent — the no-CI repo, which KEEPS --auto', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 404, json: { message: 'Branch not protected' } },
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'absent', contexts: [] });
    });

    it('an empty contexts list → absent', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 200, json: { contexts: [] } },
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'absent' });
    });

    it('403 (probe needs admin) → unknown, NEVER a throw', async () => {
      const { api } = makeApi((req) =>
        req.url.endsWith('/example-repo')
          ? { status: 200, json: { default_branch: 'main' } }
          : { status: 403, json: { message: 'Must have admin rights to Repository.' } },
      );
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'unknown' });
    });

    it('NEVER throws — it is report-only, so even a 500 or a dead repo GET degrades to unknown', async () => {
      const { api } = makeApi(() => ({ status: 500, json: null }));
      expect(await api.getRequiredChecks()).toMatchObject({ state: 'unknown' });
      const { api: api2 } = makeApi(() => {
        throw new Error('network down');
      });
      expect(await api2.getRequiredChecks()).toMatchObject({ state: 'unknown' });
    });
  });
});
