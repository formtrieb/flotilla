import { describe, it, expect } from 'vitest';
import { RealLinearApi, LinearApiError } from './real-linear-api';
import { FakeLinearHttp, type LinearHttpFakeHandler } from './linear-http-fake';
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

  // ── Document facet (ADR-0017): a PRD is a NATIVE Linear Document ───────────
  describe('createDocument', () => {
    it('resolves the project id and POSTs documentCreate with title/content/projectId, returns the uuid', async () => {
      const { api, http } = makeApi(
        {
          ResolveTeamCatalog: () => teamCatalogResponse(),
          ResolveProject: () => ({ status: 200, json: { data: { team: { projects: { nodes: [{ id: 'proj-1', name: 'Example Project' }] } } } } }),
          CreateDocument: (req) => {
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

    it('throws LinearApiError BEFORE any wire call when no project is bound (no silent orphan document)', async () => {
      const { api, http } = makeApi({}); // no project configured, no routes needed — nothing may be sent
      await expect(api.createDocument({ title: 'T', content: 'C' })).rejects.toSatisfy(
        (e: unknown) => e instanceof LinearApiError && e.op === 'CreateDocument' && /project/.test(e.message),
      );
      expect(http.requests).toHaveLength(0);
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

    it('lists workspace-wide (no filter, no catalog resolution) when no project is bound', async () => {
      const { api, http } = makeApi({
        ListDocuments: (req) => {
          expect((req.variables as { filter?: unknown }).filter).toBeUndefined();
          return { status: 200, json: { data: { documents: { nodes: [{ id: 'doc-9', title: 'T', content: 'C' }], pageInfo: { hasNextPage: false, endCursor: null } } } } };
        },
      });
      await expect(api.listDocuments()).resolves.toEqual([{ id: 'doc-9', title: 'T', content: 'C' }]);
      expect(http.requests).toHaveLength(1); // no ResolveTeamCatalog/ResolveProject round-trips
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
});
