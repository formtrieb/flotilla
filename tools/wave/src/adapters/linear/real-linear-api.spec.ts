import { describe, it, expect } from 'vitest';
import { RealLinearApi, LinearApiError } from './real-linear-api';
import { FakeLinearHttp, type LinearHttpFakeHandler } from './linear-http-fake';
import {
  PROJECT_BLOCKS_RELATION_TYPE,
  PROJECT_RELATION_ANCHOR_TYPE,
} from './linear-api';
import type { LinearHttpResponse } from './linear-http';

/** The team-catalog response `ensureCatalog()` resolves once, on first use. */
function teamCatalogResponse(opts: { id?: string; key?: string; labels?: { id: string; name: string }[] } = {}): LinearHttpResponse {
  return {
    status: 200,
    json: {
      data: {
        teams: {
          nodes: [
            {
              id: opts.id ?? 'team-uuid-1',
              key: opts.key ?? 'EX',
              states: {
                nodes: [
                  // Live-faithful example workflow (e2e find 2026-07-15):
                  // Linear has a SEVENTH state category, `duplicate` — the
                  // first live run died in ensureCatalog on it. Keeping it in
                  // the default fixture makes every test parse the real shape.
                  { id: 'state-triage', name: 'Triage', type: 'triage' },
                  { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                  { id: 'state-inprog', name: 'In Progress', type: 'started' },
                  { id: 'state-inreview', name: 'In Review', type: 'started' },
                  { id: 'state-done', name: 'Done', type: 'completed' },
                  { id: 'state-canceled', name: 'Canceled', type: 'canceled' },
                  { id: 'state-dup', name: 'Duplicate', type: 'duplicate' },
                  { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
                ],
              },
              labels: {
                nodes: opts.labels ?? [
                  { id: 'label-ready', name: 'ready-for-agent' },
                  { id: 'label-risk', name: 'risk/isolated-refactor' },
                  { id: 'label-worker', name: 'worker/general' },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

function makeApi(
  routes: Record<string, LinearHttpFakeHandler>,
  opts: { project?: string } = {},
): { api: RealLinearApi; http: FakeLinearHttp } {
  const http = new FakeLinearHttp(routes);
  const api = new RealLinearApi('EX', opts.project, 'lin_api_abc', http);
  return { api, http };
}

describe('RealLinearApi', () => {
  describe('preflight', () => {
    it('resolves when the query returns a viewer id', async () => {
      const { api, http } = makeApi({
        Preflight: (req) => {
          expect(req.query).toContain('viewer');
          expect(req.token).toBe('lin_api_abc');
          return { status: 200, json: { data: { viewer: { id: 'user-1' } } } };
        },
      });
      await expect(api.preflight()).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(1);
    });

    it('throws LinearApiError on a non-200 (bad key)', async () => {
      const { api } = makeApi({
        Preflight: () => ({ status: 401, json: { errors: [{ message: 'Authentication required' }] } }),
      });
      await expect(api.preflight()).rejects.toMatchObject({ op: 'Preflight', status: 401 });
      await expect(api.preflight()).rejects.toBeInstanceOf(LinearApiError);
    });
  });

  describe('createIssue', () => {
    it('resolves the team catalog then POSTs issueCreate with resolved label ids, returns the identifier', async () => {
      const { api, http } = makeApi({
        ResolveTeamCatalog: (req) => {
          expect(req.variables).toEqual({ match: 'EX' });
          return teamCatalogResponse();
        },
        CreateIssue: (req) => {
          expect(req.variables).toEqual({
            input: {
              teamId: 'team-uuid-1',
              title: 'T',
              description: 'B',
              labelIds: ['label-ready'],
            },
          });
          return { status: 200, json: { data: { issueCreate: { success: true, issue: { identifier: 'EX-42' } } } } };
        },
      });
      const result = await api.createIssue({ title: 'T', description: 'B', labels: ['ready-for-agent'] });
      expect(result).toEqual({ identifier: 'EX-42' });
      expect(http.requests.map((r) => r.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1])).toEqual([
        'ResolveTeamCatalog',
        'CreateIssue',
      ]);
    });

    it('auto-creates a missing label via issueLabelCreate before attaching it', async () => {
      const { api } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse({ labels: [] }), // no labels known yet
        CreateIssueLabel: (req) => {
          expect(req.variables).toEqual({ input: { name: 'wave/needs-attention', teamId: 'team-uuid-1' } });
          return { status: 200, json: { data: { issueLabelCreate: { success: true, issueLabel: { id: 'label-new', name: 'wave/needs-attention' } } } } };
        },
        CreateIssue: (req) => {
          expect(req.variables).toEqual({
            input: { teamId: 'team-uuid-1', title: 'T', description: 'B', labelIds: ['label-new'] },
          });
          return { status: 200, json: { data: { issueCreate: { success: true, issue: { identifier: 'EX-43' } } } } };
        },
      });
      const result = await api.createIssue({ title: 'T', description: 'B', labels: ['wave/needs-attention'] });
      expect(result).toEqual({ identifier: 'EX-43' });
    });

    it('includes projectId once the project name is resolved', async () => {
      const { api } = makeApi(
        {
          ResolveTeamCatalog: () => teamCatalogResponse(),
          ResolveProject: (req) => {
            expect(req.variables).toEqual({ teamId: 'team-uuid-1', name: 'Example Project' });
            return { status: 200, json: { data: { team: { projects: { nodes: [{ id: 'proj-1', name: 'Example Project' }] } } } } };
          },
          CreateIssue: (req) => {
            expect((req.variables as { input: Record<string, unknown> }).input.projectId).toBe('proj-1');
            return { status: 200, json: { data: { issueCreate: { success: true, issue: { identifier: 'EX-44' } } } } };
          },
        },
        { project: 'Example Project' },
      );
      await expect(api.createIssue({ title: 'T', description: 'B', labels: ['ready-for-agent'] })).resolves.toEqual({
        identifier: 'EX-44',
      });
    });
  });

  function issueByIdentifierResponse(overrides: Record<string, unknown> = {}): LinearHttpResponse {
    return {
      status: 200,
      json: {
        data: {
          issues: {
            nodes: [
              {
                id: 'issue-uuid-16',
                identifier: 'EX-16',
                title: 'Some issue',
                description: 'body text',
                labels: { nodes: [{ id: 'label-ready', name: 'ready-for-agent' }, { id: 'label-risk', name: 'risk/isolated-refactor' }] },
                state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                attachments: { nodes: [] },
                inverseRelations: { nodes: [] },
                comments: { nodes: [] },
                ...overrides,
              },
            ],
          },
        },
      },
    };
  }

  describe('getIssue', () => {
    it('parses "EX-16" into team key + number and returns a LinearIssue', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: (req) => {
          expect(req.variables).toEqual({ teamKey: 'EX', number: 16 });
          return issueByIdentifierResponse();
        },
      });
      const issue = await api.getIssue('EX-16');
      expect(issue).toEqual({
        identifier: 'EX-16',
        title: 'Some issue',
        description: 'body text',
        labels: ['ready-for-agent', 'risk/isolated-refactor'],
        stateName: 'Todo',
        stateType: 'unstarted',
      });
      expect(http.requests).toHaveLength(1);
    });

    // The tracker-update instant behind the DoR staleness advisory. Linear's own
    // schema declares `Issue.updatedAt: DateTime!` — "the last time at which the
    // entity was meaningfully updated" — and `DateTime` is documented as ISO
    // 8601, so the wire value is carried through verbatim rather than reformatted.
    it('carries the wire `updatedAt` through onto the LinearIssue', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () =>
          issueByIdentifierResponse({ updatedAt: '2026-08-09T10:11:12.000Z' }),
      });
      const issue = await api.getIssue('EX-16');
      expect(issue.updatedAt).toBe('2026-08-09T10:11:12.000Z');
    });

    it('leaves updatedAt ABSENT (never fabricated) when the field is missing from the response', async () => {
      const { api } = makeApi({ IssueByIdentifier: () => issueByIdentifierResponse() });
      const issue = await api.getIssue('EX-16');
      // Absence must propagate: the DoR staleness advisory reads an absent
      // instant as `deferred`, and any invented value would turn that honest
      // "unknown" into a silent, wrong "nothing moved".
      expect(issue.updatedAt).toBeUndefined();
    });

    it('asks the wire for `updatedAt` — the field is IN the query, not just tolerated in the response', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
      });
      await api.getIssue('EX-16');
      expect(http.requests[0].query).toContain('updatedAt');
    });

    it('throws a plain (non-wire) error when the identifier is unknown', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => ({ status: 200, json: { data: { issues: { nodes: [] } } } }),
      });
      await expect(api.getIssue('EX-999')).rejects.toThrow(/EX-999/);
      await expect(api.getIssue('EX-999')).rejects.not.toBeInstanceOf(LinearApiError);
    });

    it('throws LinearApiError when the GraphQL response carries errors[] (HTTP 200)', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => ({ status: 200, json: { data: null, errors: [{ message: 'insufficient scope' }] } }),
      });
      await expect(api.getIssue('EX-16')).rejects.toSatisfy(
        (e: unknown) => e instanceof LinearApiError && e.message.includes('GraphQL error'),
      );
    });
  });

  describe('listOpenIssues', () => {
    it('paginates via pageInfo{hasNextPage,endCursor}, filtering out completed/canceled', async () => {
      const page1Nodes = Array.from({ length: 2 }, (_, i) => ({
        id: `u${i}`,
        identifier: `EX-${i}`,
        title: `t${i}`,
        description: '',
        labels: { nodes: [] },
        state: { id: 's1', name: 'Todo', type: 'unstarted' },
      }));
      const page2Nodes = [
        { id: 'u9', identifier: 'EX-9', title: 'open one', description: '', labels: { nodes: [] }, state: { id: 's1', name: 'Todo', type: 'unstarted' } },
        { id: 'u10', identifier: 'EX-10', title: 'done one', description: '', labels: { nodes: [] }, state: { id: 's4', name: 'Done', type: 'completed' } },
      ];
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        ListOpenIssues: (req) => {
          const vars = req.variables as { filter: unknown; first: number; after?: string };
          expect(vars.filter).toEqual({ team: { id: { eq: 'team-uuid-1' } } });
          expect(vars.first).toBe(100);
          if (vars.after === undefined) {
            return { status: 200, json: { data: { issues: { nodes: page1Nodes, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } } } };
          }
          expect(vars.after).toBe('cursor-1');
          return { status: 200, json: { data: { issues: { nodes: page2Nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
        },
      });
      const issues = await api.listOpenIssues();
      const listOpenRequests = http.requests.filter((r) => r.query.includes('ListOpenIssues'));
      expect(listOpenRequests).toHaveLength(2);
      expect(issues.map((i) => i.identifier)).toEqual(['EX-0', 'EX-1', 'EX-9']); // EX-10 (completed) excluded
    });

    it('scopes the filter to the resolved project id when a project is configured', async () => {
      const { api } = makeApi(
        {
          ResolveTeamCatalog: () => teamCatalogResponse(),
          ResolveProject: () => ({ status: 200, json: { data: { team: { projects: { nodes: [{ id: 'proj-1', name: 'Example Project' }] } } } } }),
          ListOpenIssues: (req) => {
            expect((req.variables as { filter: unknown }).filter).toEqual({
              team: { id: { eq: 'team-uuid-1' } },
              project: { id: { eq: 'proj-1' } },
            });
            return { status: 200, json: { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
          },
        },
        { project: 'Example Project' },
      );
      await expect(api.listOpenIssues()).resolves.toEqual([]);
    });
  });

  describe('addLabel', () => {
    it('is idempotent: no mutation is sent when the label is already present', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(), // already has 'ready-for-agent'
      });
      await expect(api.addLabel('EX-16', 'ready-for-agent')).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(1); // only the read; no UpdateIssue mutation
    });

    it('resolves the label id from the team catalog and PATCHes labelIds', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        ResolveTeamCatalog: () => teamCatalogResponse(),
        UpdateIssue: (req) => {
          expect(req.variables).toEqual({
            id: 'issue-uuid-16',
            input: { labelIds: ['label-ready', 'label-risk', 'label-worker'] },
          });
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await expect(api.addLabel('EX-16', 'worker/general')).resolves.toBeUndefined();
      expect(http.requests.some((r) => r.query.includes('UpdateIssue'))).toBe(true);
    });

    it('auto-creates the label via issueLabelCreate when missing from the team catalog', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        ResolveTeamCatalog: () => teamCatalogResponse({ labels: [] }),
        CreateIssueLabel: (req) => {
          expect(req.variables).toEqual({ input: { name: 'wave/needs-attention', teamId: 'team-uuid-1' } });
          return { status: 200, json: { data: { issueLabelCreate: { success: true, issueLabel: { id: 'label-na', name: 'wave/needs-attention' } } } } };
        },
        UpdateIssue: (req) => {
          expect((req.variables as { input: { labelIds: string[] } }).input.labelIds).toEqual(['label-ready', 'label-risk', 'label-na']);
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await expect(api.addLabel('EX-16', 'wave/needs-attention')).resolves.toBeUndefined();
    });
  });

  describe('removeLabel', () => {
    it('is idempotent: no mutation is sent when the label is absent', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
      });
      await expect(api.removeLabel('EX-16', 'wave/needs-attention')).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(1);
    });

    it('drops the label id from labelIds when present', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpdateIssue: (req) => {
          expect(req.variables).toEqual({ id: 'issue-uuid-16', input: { labelIds: ['label-risk'] } });
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await expect(api.removeLabel('EX-16', 'ready-for-agent')).resolves.toBeUndefined();
    });
  });

  describe('setDescription', () => {
    it('PATCHes the description via issueUpdate', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpdateIssue: (req) => {
          expect(req.variables).toEqual({ id: 'issue-uuid-16', input: { description: 'new body' } });
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await expect(api.setDescription('EX-16', 'new body')).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(2);
    });
  });

  describe('setState', () => {
    it('resolves the state name to id via the team catalog and PATCHes stateId', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        ResolveTeamCatalog: () => teamCatalogResponse(),
        UpdateIssue: (req) => {
          expect(req.variables).toEqual({ id: 'issue-uuid-16', input: { stateId: 'state-inprog' } });
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await expect(api.setState('EX-16', 'In Progress')).resolves.toBeUndefined();
    });

    it('throws a plain (non-wire) error on an unknown state name', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        ResolveTeamCatalog: () => teamCatalogResponse(),
      });
      await expect(api.setState('EX-16', 'Flying')).rejects.toThrow(/Flying/);
      await expect(api.setState('EX-16', 'Flying')).rejects.not.toBeInstanceOf(LinearApiError);
    });
  });

  describe('addComment / getComments', () => {
    it('addComment posts commentCreate with the resolved issue uuid', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        CreateComment: (req) => {
          expect(req.variables).toEqual({ input: { issueId: 'issue-uuid-16', body: 'hello' } });
          return { status: 200, json: { data: { commentCreate: { success: true } } } };
        },
      });
      await expect(api.addComment('EX-16', 'hello')).resolves.toBeUndefined();
    });

    it('getComments returns the oldest-first comment bodies', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse({ comments: { nodes: [{ body: 'first' }, { body: 'second' }] } }),
      });
      await expect(api.getComments('EX-16')).resolves.toEqual([{ body: 'first' }, { body: 'second' }]);
    });
  });

  describe('getPrAttachments', () => {
    // ─────────────────────────────────────────────────────────────────────────
    // LIVE-CAPTURED FIXTURE (FOR-23, captured 2026-07-16).
    //
    // The verbatim `attachments.nodes[0]` the LIVE Linear API returned for
    // FOR-11 (a genuinely merged PR: formtrieb/flotilla#14, merge commit
    // d1e5192), queried with the same ISSUE_BY_IDENTIFIER_QUERY selection the
    // adapter ships. Only the merge-status keys matter to the parser; the rest
    // is kept EXACTLY as the wire returned it so the shape is pinned by
    // evidence, not by assumption.
    //
    // Why this fixture exists: the previous hand-written fixture asserted
    // `metadata: { state: 'merged' }`. The live API has NO `state` key on
    // attachment metadata at all — it reports `status`. The fake and the
    // fixture encoded the same wrong guess, so the suite was green against a
    // shape the API never returns, and every merged row probed
    // `closed-unmerged` (live-confirmed in wave 2026-07-16-hardening-w3).
    // Re-verified 2026-07-16 across all 13 GitHub attachments in the live
    // workspace: `status` present on every one, `state` on none.
    const LIVE_MERGED_PR_ATTACHMENT = {
      url: 'https://github.com/formtrieb/flotilla/pull/14',
      sourceType: 'github',
      metadata: {
        id: '4068723377',
        url: 'https://github.com/formtrieb/flotilla/pull/14',
        draft: false,
        title: 'fix(cli-trust): non-zero exit on pre-dispatch store failures, one resume entrypoint',
        branch: 'wave/FOR-11-cli-trust',
        number: 14,
        repoId: '1260685843',
        status: 'merged',
        userId: '9096140',
        reviews: [],
        closedAt: '2026-07-16T15:07:53Z',
        linkKind: 'closes',
        mergedAt: '2026-07-16T15:07:53Z',
        repoName: 'flotilla',
        createdAt: '2026-07-16T12:53:07Z',
        repoLogin: 'formtrieb',
        reviewers: [],
        updatedAt: '2026-07-16T15:07:53Z',
        userLogin: 'NeoGolightly',
        hasConflicts: false,
        previewLinks: [],
        targetBranch: 'main',
        reviewerDetails: [],
      },
    };

    it('reads merge status from the LIVE metadata shape (metadata.status === "merged") — FOR-23 regression', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () =>
          issueByIdentifierResponse({ attachments: { nodes: [LIVE_MERGED_PR_ATTACHMENT] } }),
      });
      // Negative control: against the old `metadata.state === 'merged'` read this
      // is `merged: false` — the live defect, reproduced exactly.
      expect(await api.getPrAttachments('FOR-11')).toEqual([
        { url: 'https://github.com/formtrieb/flotilla/pull/14', merged: true },
      ]);
    });

    it('does NOT treat the absent legacy `metadata.state` key as merge evidence', async () => {
      // The live API never sends `state`. If a fixture (or a future schema
      // change) resurrects it, it must not be read as merge status: `status` is
      // the only verified key.
      const { api } = makeApi({
        IssueByIdentifier: () =>
          issueByIdentifierResponse({
            attachments: {
              nodes: [
                { url: 'https://github.com/x/y/pull/9', sourceType: 'github', metadata: { state: 'merged' } },
              ],
            },
          }),
      });
      expect(await api.getPrAttachments('EX-16')).toEqual([
        { url: 'https://github.com/x/y/pull/9', merged: false },
      ]);
    });

    it('parses a GitHub-integration attachment, defensively reading merge status from metadata', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () =>
          issueByIdentifierResponse({
            attachments: {
              nodes: [
                { url: 'https://github.com/x/y/pull/5', sourceType: 'github', metadata: { status: 'merged' } },
                { url: 'https://github.com/x/y/pull/6', sourceType: 'github', metadata: { status: 'open' } },
                { url: 'https://github.com/x/y/pull/7', sourceType: 'github', metadata: { status: 'closed' } },
                { url: 'https://figma.com/z', sourceType: 'figma', metadata: {} }, // non-GitHub attachment dropped
              ],
            },
          }),
      });
      const attachments = await api.getPrAttachments('EX-16');
      expect(attachments).toEqual([
        { url: 'https://github.com/x/y/pull/5', merged: true },
        { url: 'https://github.com/x/y/pull/6', merged: false },
        { url: 'https://github.com/x/y/pull/7', merged: false },
      ]);
    });
  });

  describe('getBlockedBy', () => {
    it('filters inverseRelations to type==="blocks" and returns blocker identifiers', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () =>
          issueByIdentifierResponse({
            inverseRelations: {
              nodes: [
                { type: 'blocks', issue: { identifier: 'EX-1' } },
                { type: 'duplicate', issue: { identifier: 'EX-2' } },
              ],
            },
          }),
      });
      await expect(api.getBlockedBy('EX-16')).resolves.toEqual(['EX-1']);
    });
  });

  // ── native blocked-by WRITE half (ADR-0020 fast-follow) ───────────────────
  describe('addBlockedBy', () => {
    // Resolve each identifier to a distinct uuid by its number, so the mutation
    // args can be asserted to encode the RIGHT direction.
    const resolveByNumber: LinearHttpFakeHandler = (req) => {
      const n = (req.variables as { number: number }).number;
      return issueByIdentifierResponse({ id: `issue-uuid-${n}`, identifier: `EX-${n}` });
    };

    it('creates a `blocks` relation with the BLOCKER as issueId and the BLOCKED issue as relatedIssueId (direction: blocker blocks blocked)', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: resolveByNumber,
        CreateIssueRelation: (req) => {
          // THE load-bearing direction assertion (adversarial focus): the read
          // half reads `blocked`'s inverseRelations for `type:'blocks'` and
          // returns the SOURCE issue — so the source (`issueId`) MUST be the
          // blocker, the target (`relatedIssueId`) the blocked issue.
          expect(req.variables).toEqual({
            input: { issueId: 'issue-uuid-1', relatedIssueId: 'issue-uuid-16', type: 'blocks' },
          });
          return { status: 200, json: { data: { issueRelationCreate: { success: true, issueRelation: { id: 'rel-1' } } } } };
        },
      });
      // addBlockedBy(blocked = EX-16, blocker = EX-1): EX-16 is blocked BY EX-1.
      await expect(api.addBlockedBy('EX-16', 'EX-1')).resolves.toBeUndefined();
      // two resolveIssue round-trips (blocked + blocker) + the mutation.
      expect(http.requests).toHaveLength(3);
    });

    it('throws a plain (non-wire) error when the BLOCKER identifier cannot be resolved (store skips that single mirror)', async () => {
      const { api } = makeApi({
        IssueByIdentifier: (req) => {
          const n = (req.variables as { number: number }).number;
          if (n === 999) return { status: 200, json: { data: { issues: { nodes: [] } } } };
          return issueByIdentifierResponse({ id: `issue-uuid-${n}`, identifier: `EX-${n}` });
        },
      });
      await expect(api.addBlockedBy('EX-16', 'EX-999')).rejects.toThrow(/EX-999/);
      await expect(api.addBlockedBy('EX-16', 'EX-999')).rejects.not.toBeInstanceOf(LinearApiError);
    });

    it('throws LinearApiError when issueRelationCreate does not report success', async () => {
      const { api } = makeApi({
        IssueByIdentifier: resolveByNumber,
        CreateIssueRelation: () => ({ status: 200, json: { data: { issueRelationCreate: { success: false } } } }),
      });
      await expect(api.addBlockedBy('EX-16', 'EX-1')).rejects.toSatisfy(
        (e: unknown) => e instanceof LinearApiError && e.op === 'CreateIssueRelation',
      );
    });

    it('propagates a LinearApiError when the GraphQL response carries errors[] (HTTP 200)', async () => {
      const { api } = makeApi({
        IssueByIdentifier: resolveByNumber,
        CreateIssueRelation: () => ({ status: 200, json: { data: null, errors: [{ message: 'not allowed' }] } }),
      });
      await expect(api.addBlockedBy('EX-16', 'EX-1')).rejects.toSatisfy(
        (e: unknown) => e instanceof LinearApiError && e.message.includes('GraphQL error'),
      );
    });
  });

  // ── attachment upsert (issue #511, mechanics proven consumer-side) ────────
  describe('upsertAttachment', () => {
    it('resolves the issue uuid and POSTs attachmentCreate with issueId/url/title/subtitle', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpsertAttachment: (req) => {
          expect(req.variables).toEqual({
            input: {
              issueId: 'issue-uuid-16',
              url: 'https://github.com/o/r/pull/511',
              title: 'PR #511',
              subtitle: 'merged',
            },
          });
          return { status: 200, json: { data: { attachmentCreate: { success: true } } } };
        },
      });
      await expect(
        api.upsertAttachment('EX-16', {
          url: 'https://github.com/o/r/pull/511',
          title: 'PR #511',
          subtitle: 'merged',
        }),
      ).resolves.toBeUndefined();
      expect(http.requests).toHaveLength(2); // the resolveIssue read + the mutation
    });

    it('sends NO find-before-create read for the url — attachmentCreate is asked to upsert directly (one mutation call)', async () => {
      const { api, http } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpsertAttachment: () => ({ status: 200, json: { data: { attachmentCreate: { success: true } } } }),
      });
      await api.upsertAttachment('EX-16', { url: 'https://x/1', title: 't', subtitle: 's' });
      const upsertCalls = http.requests.filter((r) => r.query.includes('UpsertAttachment'));
      expect(upsertCalls).toHaveLength(1);
    });

    it('throws LinearApiError when attachmentCreate does not report success', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpsertAttachment: () => ({ status: 200, json: { data: { attachmentCreate: { success: false } } } }),
      });
      await expect(
        api.upsertAttachment('EX-16', { url: 'https://x/1', title: 't', subtitle: 's' }),
      ).rejects.toSatisfy((e: unknown) => e instanceof LinearApiError && e.op === 'UpsertAttachment');
    });

    it('propagates a LinearApiError when the GraphQL response carries errors[] (HTTP 200)', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => issueByIdentifierResponse(),
        UpsertAttachment: () => ({ status: 200, json: { data: null, errors: [{ message: 'not allowed' }] } }),
      });
      await expect(
        api.upsertAttachment('EX-16', { url: 'https://x/1', title: 't', subtitle: 's' }),
      ).rejects.toSatisfy((e: unknown) => e instanceof LinearApiError && e.message.includes('GraphQL error'));
    });

    it('throws a plain (non-wire) error when the identifier is unknown', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => ({ status: 200, json: { data: { issues: { nodes: [] } } } }),
      });
      await expect(
        api.upsertAttachment('EX-999', { url: 'https://x/1', title: 't', subtitle: 's' }),
      ).rejects.toThrow(/EX-999/);
      await expect(
        api.upsertAttachment('EX-999', { url: 'https://x/1', title: 't', subtitle: 's' }),
      ).rejects.not.toBeInstanceOf(LinearApiError);
    });
  });

  // ── Document facet (ADR-0017): a PRD is a NATIVE Linear Document ───────────
  describe('createDocument', () => {
    it('resolves the project id and POSTs documentCreate with title/content/projectId, returns the uuid', async () => {
      const { api, http } = makeApi(
        {
          ResolveTeamCatalog: () => teamCatalogResponse(),
          ResolveProject: () => ({ status: 200, json: { data: { team: { projects: { nodes: [{ id: 'proj-1', name: 'Example Project' }] } } } } }),
          CreateDocument: (req) => {
            // UNCHANGED direction (ADR-0017 amendment): a project-bound api
            // still sends `projectId` and ONLY `projectId` — the exact-match
            // assertion is what proves no `teamId` crept in beside it.
            expect(req.variables).toEqual({
              input: { title: 'PRD: thing', content: '# body\n', projectId: 'proj-1' },
            });
            return { status: 200, json: { data: { documentCreate: { success: true, document: { id: 'doc-uuid-1' } } } } };
          },
        },
        { project: 'Example Project' },
      );
      await expect(api.createDocument({ title: 'PRD: thing', content: '# body\n' })).resolves.toEqual({ id: 'doc-uuid-1' });
      expect(http.requests.some((r) => r.query.includes('CreateDocument'))).toBe(true);
    });

    it('attaches to the TEAM when no project is bound — no refusal, no orphan (ADR-0017 amendment)', async () => {
      // The team-pool consumer's shape: `project` is deliberately unset (it
      // would also narrow the candidate pool, ADR-0020), and the facet must
      // still work. The Document hangs off the REQUIRED team instead.
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        CreateDocument: (req) => {
          expect(req.variables).toEqual({
            input: { title: 'PRD: thing', content: '# body\n', teamId: 'team-uuid-1' },
          });
          return { status: 200, json: { data: { documentCreate: { success: true, document: { id: 'doc-uuid-2' } } } } };
        },
      });
      await expect(api.createDocument({ title: 'PRD: thing', content: '# body\n' })).resolves.toEqual({ id: 'doc-uuid-2' });
      // exactly one parent goes on the wire — never both, never neither.
      const sent = (http.requests.find((r) => r.query.includes('CreateDocument'))!.variables as { input: Record<string, unknown> }).input;
      expect(sent.projectId).toBeUndefined();
      // and no project resolution was attempted for an api that has no project.
      expect(http.requests.some((r) => r.query.includes('ResolveProject'))).toBe(false);
    });

    it('surfaces an unknown team LOUDLY rather than minting a parentless document', async () => {
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => ({ status: 200, json: { data: { teams: { nodes: [] } } } }),
      });
      await expect(api.createDocument({ title: 'T', content: 'C' })).rejects.toThrow(/team not found/i);
      expect(http.requests.some((r) => r.query.includes('CreateDocument'))).toBe(false);
    });
  });

  describe('getDocument', () => {
    it('queries document(id) and returns { id, title, content }', async () => {
      const { api } = makeApi({
        GetDocument: (req) => {
          expect(req.variables).toEqual({ id: 'doc-uuid-1' });
          return { status: 200, json: { data: { document: { id: 'doc-uuid-1', title: 'PRD: thing', content: '# body\n' } } } };
        },
      });
      await expect(api.getDocument('doc-uuid-1')).resolves.toEqual({
        id: 'doc-uuid-1',
        title: 'PRD: thing',
        content: '# body\n',
      });
    });

    it('throws a plain (non-wire) error when the document id is unknown', async () => {
      const { api } = makeApi({
        GetDocument: () => ({ status: 200, json: { data: { document: null } } }),
      });
      await expect(api.getDocument('doc-nope')).rejects.toThrow(/doc-nope/);
      await expect(api.getDocument('doc-nope')).rejects.not.toBeInstanceOf(LinearApiError);
    });

    it('throws LinearApiError when the GraphQL response carries errors[] (HTTP 200)', async () => {
      const { api } = makeApi({
        GetDocument: () => ({ status: 200, json: { data: null, errors: [{ message: 'insufficient scope' }] } }),
      });
      await expect(api.getDocument('doc-uuid-1')).rejects.toSatisfy(
        (e: unknown) => e instanceof LinearApiError && e.message.includes('GraphQL error'),
      );
    });
  });

  describe('listDocuments', () => {
    it('paginates via pageInfo, scoped to the resolved project id when a project is bound', async () => {
      const page1 = [{ id: 'doc-1', title: 'PRD 1', content: 'a' }];
      const page2 = [{ id: 'doc-2', title: 'PRD 2', content: 'b' }];
      const { api, http } = makeApi(
        {
          ResolveTeamCatalog: () => teamCatalogResponse(),
          ResolveProject: () => ({ status: 200, json: { data: { team: { projects: { nodes: [{ id: 'proj-1', name: 'Example Project' }] } } } } }),
          ListDocuments: (req) => {
            const vars = req.variables as { filter?: unknown; first: number; after?: string };
            // UNCHANGED direction (ADR-0017 amendment): the project predicate
            // alone — the exact-match assertion proves no team predicate was
            // added beside it.
            expect(vars.filter).toEqual({ project: { id: { eq: 'proj-1' } } });
            expect(vars.first).toBe(100);
            if (vars.after === undefined) {
              return { status: 200, json: { data: { documents: { nodes: page1, pageInfo: { hasNextPage: true, endCursor: 'cursor-d1' } } } } };
            }
            expect(vars.after).toBe('cursor-d1');
            return { status: 200, json: { data: { documents: { nodes: page2, pageInfo: { hasNextPage: false, endCursor: null } } } } };
          },
        },
        { project: 'Example Project' },
      );
      const docs = await api.listDocuments();
      expect(http.requests.filter((r) => r.query.includes('ListDocuments'))).toHaveLength(2);
      expect(docs).toEqual([
        { id: 'doc-1', title: 'PRD 1', content: 'a' },
        { id: 'doc-2', title: 'PRD 2', content: 'b' },
      ]);
    });

    it("narrows SERVER-side to the configured team's documents when no project is bound (ADR-0017 amendment)", async () => {
      // Was: an UNFILTERED query — workspace-wide, not even team-scoped, so a
      // team-pool consumer's PRD panel listed every other team's documents.
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        ListDocuments: (req) => {
          expect((req.variables as { filter?: unknown }).filter).toEqual({ team: { id: { eq: 'team-uuid-1' } } });
          return { status: 200, json: { data: { documents: { nodes: [{ id: 'doc-9', title: 'T', content: 'C' }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
        },
      });
      await expect(api.listDocuments()).resolves.toEqual([{ id: 'doc-9', title: 'T', content: 'C' }]);
      // the one catalog round-trip this arm now pays for, and no more: the
      // team resolution, never a project resolution.
      expect(http.requests.some((r) => r.query.includes('ResolveTeamCatalog'))).toBe(true);
      expect(http.requests.some((r) => r.query.includes('ResolveProject'))).toBe(false);
      expect(http.requests).toHaveLength(2);
    });

    it('an unknown team fails the listing LOUDLY rather than falling back to workspace-wide', async () => {
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => ({ status: 200, json: { data: { teams: { nodes: [] } } } }),
      });
      await expect(api.listDocuments()).rejects.toThrow(/team not found/i);
      expect(http.requests.some((r) => r.query.includes('ListDocuments'))).toBe(false);
    });
  });

  describe('hasGitHubIntegration (FOR-12 store-preflight)', () => {
    it('returns true when a github integration is present in the workspace', async () => {
      const { api } = makeApi({
        GitHubIntegration: () => ({
          status: 200,
          json: { data: { integrations: { nodes: [{ id: 'int-1', service: 'slack' }, { id: 'int-2', service: 'github' }] } } },
        }),
      });
      expect(await api.hasGitHubIntegration()).toBe(true);
    });

    it('returns false when no github integration is installed (githubImport does NOT count)', async () => {
      const { api } = makeApi({
        GitHubIntegration: () => ({
          status: 200,
          json: { data: { integrations: { nodes: [{ id: 'int-1', service: 'githubImport' }] } } },
        }),
      });
      expect(await api.hasGitHubIntegration()).toBe(false);
    });

    it('throws LinearApiError on GraphQL errors', async () => {
      const { api } = makeApi({
        GitHubIntegration: () => ({ status: 200, json: { errors: [{ message: 'nope' }] } }),
      });
      await expect(api.hasGitHubIntegration()).rejects.toBeInstanceOf(LinearApiError);
    });
  });

  describe('listStates (FOR-12 store-preflight)', () => {
    it('resolves the team catalog and returns each state name → fixed category', async () => {
      const { api } = makeApi({ ResolveTeamCatalog: () => teamCatalogResponse() });
      const states = await api.listStates();
      const byName = Object.fromEntries(states.map((s) => [s.name, s.type]));
      expect(byName['In Review']).toBe('started'); // the claim-ledger state a fresh team may lack
      expect(byName['Todo']).toBe('unstarted');
      expect(byName['Done']).toBe('completed');
      expect(Object.keys(byName)).toEqual(expect.arrayContaining(['Backlog', 'Canceled']));
    });
  });

  // ── the Goal facet's project substrate (ADR-0044) ─────────────────────────
  //
  // UNEXECUTABLE CORE PATH (ADR-0030): no live Linear credential is available to
  // this row, so none of the five operations below has been run against a real
  // workspace. Every shape is pinned against Linear's PUBLISHED GraphQL schema
  // (`linear/linear` → `packages/sdk/src/schema.graphql`), read in THIS dispatch
  // (2026-08-15):
  //
  //   projectCreate(input: ProjectCreateInput!): ProjectPayload!
  //   ProjectPayload { lastSyncId: Float!, project: Project, success: Boolean! }
  //   ProjectCreateInput { name: String!, teamIds: [String!]!, description: String, … }
  //   project(id: String!): Project!
  //   Team.projects(first, after, …): ProjectConnection!
  //   Project.issues(first, after, …): IssueConnection!
  //   IssueUpdateInput { …, projectId: String, … }
  //
  // The first live `goal` station run on a linear-store consumer is the gate —
  // the same stance `addBlockedBy` records for its own mirror.
  describe('projects (the Goal container, ADR-0044)', () => {
    it('createProject sends name+description AND the REQUIRED teamIds, returning the project id', async () => {
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        CreateProject: (req) => {
          // `ProjectCreateInput.teamIds` is `[String!]!` — required, non-null. A
          // create that omitted it would be rejected by the schema, which is why
          // the catalog resolve has to precede the mutation.
          expect((req.variables as { input: Record<string, unknown> }).input).toEqual({
            name: '1.0.0',
            description: 'the freeze',
            teamIds: ['team-uuid-1'],
          });
          return {
            status: 200,
            json: {
              data: {
                projectCreate: {
                  success: true,
                  project: { id: 'prj-uuid-1', name: '1.0.0', description: 'the freeze' },
                },
              },
            },
          };
        },
      });

      expect(await api.createProject({ name: '1.0.0', description: 'the freeze' })).toEqual({
        id: 'prj-uuid-1',
      });
      // catalog resolve, then the mutation — never the other way round.
      expect(http.requests).toHaveLength(2);
    });

    it('createProject throws when the payload does not report success', async () => {
      const { api } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        CreateProject: () => ({
          status: 200,
          json: { data: { projectCreate: { success: false, project: null } } },
        }),
      });
      await expect(api.createProject({ name: 'x', description: '' })).rejects.toBeInstanceOf(
        LinearApiError,
      );
    });

    it('createProject throws when success is reported without a project id', async () => {
      const { api } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        CreateProject: () => ({
          status: 200,
          json: { data: { projectCreate: { success: true, project: null } } },
        }),
      });
      await expect(api.createProject({ name: 'x', description: '' })).rejects.toBeInstanceOf(
        LinearApiError,
      );
    });

    it('getProject maps the node onto LinearProject, status CATEGORY included', async () => {
      const { api } = makeApi({
        GetProject: (req) => {
          expect(req.variables).toEqual({ id: 'prj-uuid-1' });
          return {
            status: 200,
            json: {
              data: {
                project: {
                  id: 'prj-uuid-1',
                  name: '1.0.0',
                  description: 'd',
                  // `ProjectStatus.type`, not `.name`: the NAME is
                  // consumer-customizable and so unreadable as a rule, while the
                  // fixed category is what the frontier maps (ADR-0045
                  // decision 2).
                  status: { type: 'started' },
                },
              },
            },
          };
        },
      });
      expect(await api.getProject('prj-uuid-1')).toEqual({
        id: 'prj-uuid-1',
        name: '1.0.0',
        description: 'd',
        statusType: 'started',
      });
    });

    it('an unreadable status category degrades to `backlog` — never to a closed or eligible reading', async () => {
      // The safe direction, and the same evidence discipline `closed-unknown`
      // takes: a category this adapter cannot read makes the member read
      // `unready`, never `done` and never `actionable`. Absent evidence must not
      // clear a member.
      for (const status of [undefined, null, {}, { type: 'invented' }]) {
        const { api } = makeApi({
          GetProject: () => ({
            status: 200,
            json: { data: { project: { id: 'p', name: 'n', description: '', status } } },
          }),
        });
        expect((await api.getProject('p')).statusType, JSON.stringify(status)).toBe('backlog');
      }
    });

    it('getProject reports a NULL node as a domain 404, not a wire failure', async () => {
      // HTTP 200 with a null node is Linear's shape for "no such thing" — the
      // same reading `resolveIssue` gives an identifier that does not resolve.
      const { api } = makeApi({
        GetProject: () => ({ status: 200, json: { data: { project: null } } }),
      });
      await expect(api.getProject('nope')).rejects.toThrow(/not found/i);
    });

    it('listProjects is TEAM-scoped and pages to exhaustion', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: `prj-${i}`,
        name: `p${i}`,
        description: '',
      }));
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        ListTeamProjects: (req) => {
          const vars = req.variables as { teamId: string; after?: string };
          // Scoped through the TEAM connection rather than a root filter, so the
          // scoping is structural and cannot be omitted by accident: a goal panel
          // showing every team's finish lines is not this consumer's panel.
          expect(vars.teamId).toBe('team-uuid-1');
          return vars.after === undefined
            ? {
                status: 200,
                json: {
                  data: {
                    team: {
                      projects: {
                        nodes: page1,
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                      },
                    },
                  },
                },
              }
            : {
                status: 200,
                json: {
                  data: {
                    team: {
                      projects: {
                        nodes: [{ id: 'prj-last', name: 'last', description: '' }],
                        pageInfo: { hasNextPage: false, endCursor: null },
                      },
                    },
                  },
                },
              };
        },
      });

      const projects = await api.listProjects();
      expect(projects).toHaveLength(101);
      expect(projects[projects.length - 1].id).toBe('prj-last');
      expect(http.requests.filter((r) => r.query.includes('ListTeamProjects'))).toHaveLength(2);
    });

    it('listProjects stops rather than looping when hasNextPage is true but no cursor comes back', async () => {
      const { api, http } = makeApi({
        ResolveTeamCatalog: () => teamCatalogResponse(),
        ListTeamProjects: () => ({
          status: 200,
          json: {
            data: {
              team: {
                projects: {
                  nodes: [{ id: 'p', name: 'p', description: '' }],
                  pageInfo: { hasNextPage: true, endCursor: null },
                },
              },
            },
          },
        }),
      });
      expect(await api.listProjects()).toHaveLength(1);
      expect(http.requests.filter((r) => r.query.includes('ListTeamProjects'))).toHaveLength(1);
    });

    it('setIssueProject resolves the identifier, then updates the ISSUE with projectId', async () => {
      const { api } = makeApi({
        IssueByIdentifier: () => ({
          status: 200,
          json: {
            data: {
              issues: {
                nodes: [
                  {
                    id: 'issue-uuid-1',
                    identifier: 'EX-16',
                    title: 't',
                    description: 'd',
                    labels: { nodes: [] },
                    state: { id: 'state-todo', name: 'Todo', type: 'unstarted' },
                  },
                ],
              },
            },
          },
        }),
        UpdateIssue: (req) => {
          expect(req.variables).toEqual({
            id: 'issue-uuid-1',
            input: { projectId: 'prj-uuid-1' },
          });
          return { status: 200, json: { data: { issueUpdate: { success: true } } } };
        },
      });
      await api.setIssueProject('EX-16', 'prj-uuid-1');
    });

    it('listProjectIssues resolves the project first, then pages members OPEN AND CLOSED', async () => {
      const node = (identifier: string, state: { name: string; type: string }) => ({
        id: `uuid-${identifier}`,
        identifier,
        title: identifier,
        description: '',
        labels: { nodes: [] },
        state: { id: `state-${state.type}`, ...state },
      });
      const { api, http } = makeApi({
        GetProject: () => ({
          status: 200,
          json: { data: { project: { id: 'prj-uuid-1', name: 'g', description: '' } } },
        }),
        ListProjectIssues: (req) => {
          expect((req.variables as { id: string }).id).toBe('prj-uuid-1');
          return {
            status: 200,
            json: {
              data: {
                project: {
                  issues: {
                    nodes: [
                      node('EX-1', { name: 'Todo', type: 'unstarted' }),
                      // A COMPLETED member must come back: `done` is one of the
                      // five frontier readings, unlike listOpenIssues where a
                      // completed issue is correctly filtered away.
                      node('EX-2', { name: 'Done', type: 'completed' }),
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        },
      });

      const members = await api.listProjectIssues('prj-uuid-1');
      expect(http.requests[0].query).toContain('GetProject'); // resolve came first
      expect(members.map((m) => m.identifier)).toEqual(['EX-1', 'EX-2']);
      expect(members.some((m) => m.stateType === 'completed')).toBe(true);
    });

    it('listProjectIssues FAILS on an unknown project rather than reading back as an empty goal', async () => {
      // "no members" and "no such goal" are different claims: without the
      // up-front resolve, a project id that does not exist would yield an empty
      // member list and the frontier would report `complete`.
      const { api, http } = makeApi({
        GetProject: () => ({ status: 200, json: { data: { project: null } } }),
      });
      await expect(api.listProjectIssues('nope')).rejects.toThrow(/not found/i);
      expect(http.requests).toHaveLength(1); // it never got as far as listing
    });
  });

  // ── initiatives, and native project dependencies (ADR-0045) ───────────────
  //
  // These pin the WIRE SHAPE of the two pieces this row could not prove live:
  // the direct-membership read and the project-relation write. Neither has a
  // credential to run against, so the variables sent are the strongest evidence
  // available short of a real call — and for `includeSubInitiatives` in
  // particular the vendor's DEFAULT is the wrong answer, so "we sent it
  // explicitly" is exactly the claim that needs a check behind it.
  describe('initiatives and project relations (ADR-0045)', () => {
    it('createInitiative sends NO team — an initiative lives above teams', async () => {
      // The asymmetry with `createProject`, which must resolve the team first
      // because `ProjectCreateInput.teamIds` is required. Asserted as an ABSENCE
      // plus a request count, because a stray `ResolveTeamCatalog` round-trip is
      // the shape a copy-paste from the project arm would take.
      const { api, http } = makeApi({
        CreateInitiative: (req) => {
          const vars = req.variables as { input: Record<string, unknown> };
          expect(vars.input).toEqual({ name: 'Epic', description: 'the span' });
          expect(vars.input).not.toHaveProperty('teamId');
          expect(vars.input).not.toHaveProperty('teamIds');
          return {
            status: 200,
            json: { data: { initiativeCreate: { success: true, initiative: { id: 'init-1' } } } },
          };
        },
      });
      expect(await api.createInitiative({ name: 'Epic', description: 'the span' })).toEqual({
        id: 'init-1',
      });
      expect(http.requests).toHaveLength(1); // no catalog resolve at all
    });

    it('createInitiative reports a non-success payload as a typed API error', async () => {
      const { api } = makeApi({
        CreateInitiative: () => ({
          status: 200,
          json: { data: { initiativeCreate: { success: false, initiative: null } } },
        }),
      });
      await expect(api.createInitiative({ name: 'x', description: '' })).rejects.toBeInstanceOf(
        LinearApiError,
      );
    });

    it('getInitiative reports a NULL node as a domain 404, not a wire failure', async () => {
      const { api } = makeApi({
        GetInitiative: () => ({ status: 200, json: { data: { initiative: null } } }),
      });
      await expect(api.getInitiative('nope')).rejects.toThrow(/initiative not found/i);
    });

    it('listInitiatives uses the ROOT connection — workspace-wide, with no team variable', async () => {
      // ADR-0045 decision 5 at the wire: initiatives span teams, so a team
      // filter would silently hide a cross-team finish line. The absence of a
      // team variable IS the scope claim.
      const { api, http } = makeApi({
        ListInitiatives: (req) => {
          const vars = req.variables as { first: number; after?: string; teamId?: string };
          expect(vars.teamId).toBeUndefined();
          expect(req.query).toContain('initiatives(');
          expect(req.query).not.toContain('team(');
          return vars.after === undefined
            ? {
                status: 200,
                json: {
                  data: {
                    initiatives: {
                      nodes: [{ id: 'init-1', name: 'Design epic', description: '' }],
                      pageInfo: { hasNextPage: true, endCursor: 'c1' },
                    },
                  },
                },
              }
            : {
                status: 200,
                json: {
                  data: {
                    initiatives: {
                      nodes: [{ id: 'init-2', name: 'Dev epic', description: '' }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
              };
        },
      });
      const initiatives = await api.listInitiatives();
      expect(initiatives.map((i) => i.id)).toEqual(['init-1', 'init-2']); // paged to exhaustion
      expect(http.requests).toHaveLength(2);
    });

    it('listInitiativeProjects sends includeSubInitiatives:false — the vendor default is the WRONG answer', async () => {
      // The single highest-risk line in this realization. Linear documents
      // `Initiative.projects(includeSubInitiatives:)` as "Defaults to true", so
      // omitting it would return a SUB-initiative's projects as this goal's own
      // direct members — the flattening ADR-0045 decision 1 rejects, arriving
      // through a default rather than through a query anyone wrote.
      const { api } = makeApi({
        GetInitiative: () => ({
          status: 200,
          json: { data: { initiative: { id: 'init-1', name: 'Epic', description: '' } } },
        }),
        ListInitiativeProjects: (req) => {
          expect(req.query).toContain('includeSubInitiatives: false');
          return {
            status: 200,
            json: {
              data: {
                initiative: {
                  projects: {
                    nodes: [
                      {
                        id: 'prj-1',
                        name: 'story',
                        description: '',
                        status: { type: 'paused' },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        },
      });
      const members = await api.listInitiativeProjects('init-1');
      expect(members).toEqual([
        { id: 'prj-1', name: 'story', description: '', statusType: 'paused' },
      ]);
    });

    it('listInitiativeProjects FAILS on an unknown initiative rather than reading back empty', async () => {
      const { api, http } = makeApi({
        GetInitiative: () => ({ status: 200, json: { data: { initiative: null } } }),
      });
      await expect(api.listInitiativeProjects('nope')).rejects.toThrow(/not found/i);
      expect(http.requests).toHaveLength(1); // resolved first, never listed
    });

    it('addProjectToInitiative FINDS BEFORE IT CREATES — the join entity is not idempotent by nature', async () => {
      // Unlike `setIssueProject`, which writes a pointer, this membership is an
      // `InitiativeToProject` row: calling the mutation twice would mint two.
      // The facet documents `assignToGoal` as idempotent, so the guard is bought
      // here.
      const existing = {
        id: 'prj-1',
        name: 'already in',
        description: '',
        status: { type: 'backlog' },
      };
      const { api, http } = makeApi({
        GetInitiative: () => ({
          status: 200,
          json: { data: { initiative: { id: 'init-1', name: 'E', description: '' } } },
        }),
        ListInitiativeProjects: () => ({
          status: 200,
          json: {
            data: {
              initiative: {
                projects: { nodes: [existing], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        }),
        CreateInitiativeToProject: () => {
          throw new Error('the mutation must not run for an existing member');
        },
      });
      await api.addProjectToInitiative('init-1', 'prj-1');
      expect(http.requests.some((r) => r.query.includes('CreateInitiativeToProject'))).toBe(false);
    });

    it('addProjectToInitiative sends {initiativeId, projectId} for a member not yet joined', async () => {
      const { api } = makeApi({
        GetInitiative: () => ({
          status: 200,
          json: { data: { initiative: { id: 'init-1', name: 'E', description: '' } } },
        }),
        ListInitiativeProjects: () => ({
          status: 200,
          json: {
            data: {
              initiative: {
                projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        }),
        GetProject: () => ({
          status: 200,
          json: {
            data: {
              project: { id: 'prj-2', name: 'new', description: '', status: { type: 'backlog' } },
            },
          },
        }),
        CreateInitiativeToProject: (req) => {
          expect(req.variables).toEqual({
            input: { initiativeId: 'init-1', projectId: 'prj-2' },
          });
          return {
            status: 200,
            json: { data: { initiativeToProjectCreate: { success: true } } },
          };
        },
      });
      await expect(api.addProjectToInitiative('init-1', 'prj-2')).resolves.toBeUndefined();
    });

    it('getProjectBlockedBy reads the INVERSE side and keeps ONLY blocking relations', async () => {
      // Direction: a relation "A blocks B" is stored on A and surfaces on B as
      // an inverse — the same asymmetry the issue arm reads. And a `related`
      // edge is not a dependency: counting it would report `blocked` over a
      // merely-adjacent project.
      const { api } = makeApi({
        GetProject: () => ({
          status: 200,
          json: {
            data: {
              project: { id: 'prj-b', name: 'B', description: '', status: { type: 'backlog' } },
            },
          },
        }),
        ListProjectInverseRelations: (req) => {
          expect(req.query).toContain('inverseRelations');
          expect(req.query).not.toContain('\n    relations(');
          return {
            status: 200,
            json: {
              data: {
                project: {
                  inverseRelations: {
                    nodes: [
                      { type: PROJECT_BLOCKS_RELATION_TYPE, project: { id: 'prj-a' } },
                      { type: 'related', project: { id: 'prj-neighbour' } },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          };
        },
      });
      expect(await api.getProjectBlockedBy('prj-b')).toEqual(['prj-a']);
    });

    it('addProjectBlockedBy sends the five REQUIRED input fields, blocker-as-source', async () => {
      // `ProjectRelationCreateInput` requires anchorType / projectId /
      // relatedAnchorType / relatedProjectId / type (published schema, read
      // 2026-08-15). The two milestone ids are deliberately absent: the facet
      // anchors at whole-project granularity.
      //
      // The VALUES of `type` and the two anchor types are the row's declared
      // unproven pieces — Linear types all three as free `String` — so pinning
      // them here at least makes a silent drift impossible: a change to either
      // constant fails this assertion.
      const project = (id: string) => ({
        status: 200 as const,
        json: {
          data: {
            project: { id, name: id, description: '', status: { type: 'backlog' } },
          },
        },
      });
      const { api } = makeApi({
        GetProject: (req) => project((req.variables as { id: string }).id),
        CreateProjectRelation: (req) => {
          expect(req.variables).toEqual({
            input: {
              projectId: 'prj-a', // the BLOCKER is the source that "blocks"
              relatedProjectId: 'prj-b', // …and the BLOCKED project is the target
              type: PROJECT_BLOCKS_RELATION_TYPE,
              anchorType: PROJECT_RELATION_ANCHOR_TYPE,
              relatedAnchorType: PROJECT_RELATION_ANCHOR_TYPE,
            },
          });
          return {
            status: 200,
            json: {
              data: { projectRelationCreate: { success: true, projectRelation: { id: 'rel-1' } } },
            },
          };
        },
      });
      await expect(api.addProjectBlockedBy('prj-b', 'prj-a')).resolves.toBeUndefined();
    });

    it('addProjectBlockedBy resolves BOTH sides first, so an unknown project is a domain 404', async () => {
      const { api } = makeApi({
        GetProject: () => ({ status: 200, json: { data: { project: null } } }),
        CreateProjectRelation: () => {
          throw new Error('the mutation must not run when a side does not resolve');
        },
      });
      await expect(api.addProjectBlockedBy('prj-b', 'nope')).rejects.toThrow(/not found/i);
    });

    it('addProjectBlockedBy reports a non-success payload as a typed API error', async () => {
      const { api } = makeApi({
        GetProject: (req) => ({
          status: 200,
          json: {
            data: {
              project: {
                id: (req.variables as { id: string }).id,
                name: 'p',
                description: '',
                status: { type: 'backlog' },
              },
            },
          },
        }),
        CreateProjectRelation: () => ({
          status: 200,
          json: { data: { projectRelationCreate: { success: false } } },
        }),
      });
      await expect(api.addProjectBlockedBy('prj-b', 'prj-a')).rejects.toBeInstanceOf(
        LinearApiError,
      );
    });
  });
});
