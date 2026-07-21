/**
 * real-linear-api.ts — the M2 production LinearApi (ADR-0020, ADR-0019
 * pattern): raw `fetch` GraphQL over the single Linear endpoint, behind the
 * `LinearHttp` seam. No `@linear/sdk`, no CLI subprocess. Everything is
 * GraphQL (Linear has no REST branch, unlike GitHub), so unlike
 * `RealGitHubApi` — which only reaches for GraphQL in `getClosingState` — this
 * adapter centralizes ALL error handling in one `gql()` helper (non-2xx OR a
 * 200-with-`errors[]` response both throw a typed {@link LinearApiError}).
 *
 * Construction-time caching (documented choice, Task 6 brief): the team's
 * workflow-state catalog (`team.states`), its label name→id map
 * (`team.labels`), and the optional `project` name→id resolution are fetched
 * ONCE via {@link RealLinearApi.ensureCatalog} on first use and cached for the
 * adapter's lifetime. This trades a small staleness window (a state/label
 * renamed mid-process) for not re-resolving those on every single issue
 * operation — the same trade-off ADR-0019 accepts by deriving owner/repo once
 * rather than per call. `addLabel`'s missing-label path self-heals regardless
 * (it auto-creates + caches the new id), so the only real exposure is a state
 * renamed after the process started, which is out of scope for M1/M2.
 *
 * Per-issue reads are deliberately NOT cached — state is exactly what this
 * store exists to observe fresh. Every identifier-taking method re-resolves
 * the issue via the single `IssueByIdentifier` query (see
 * {@link RealLinearApi.resolveIssue}); an identifier like `"EX-16"` is
 * self-describing (team key + number), so this resolution needs no team/label
 * catalog at all — only writes (`addLabel`/`setState`) touch the catalog.
 *
 * `"not found"` (an empty GraphQL result set) is a domain-level condition, not
 * a wire failure — Linear returns HTTP 200 either way. Per the `LinearApi`
 * contract's own wording ("throws on an unknown identifier" / "throws on
 * unknown state name", no type mandated) these throw a plain `Error`,
 * mirroring `InMemoryLinearApi`; `LinearApiError` is reserved for actual
 * transport/GraphQL failures (non-2xx, or a 200 carrying `errors[]`).
 */

import type {
  LinearApi,
  LinearIssue,
  LinearStateType,
  LinearCreateIssueInput,
  LinearPrAttachment,
} from './linear-api';
import { defaultLinearHttp, type LinearHttp } from './linear-http';

/** A non-success Linear response (non-2xx) or a 200 carrying GraphQL `errors[]`. */
export class LinearApiError extends Error {
  constructor(readonly op: string, readonly status: number, message: string) {
    super(message);
    this.name = 'LinearApiError';
  }
}

/** State categories that make an issue closed — the same set `LinearIssuesStore` uses (ADR-0020). */
const CLOSED_TYPES = new Set<LinearStateType>(['completed', 'canceled', 'duplicate']);
const STATE_TYPES: readonly LinearStateType[] = [
  'triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate',
];

// ── GraphQL documents — every one is a NAMED operation. The name doubles as
// the `op` tag on `LinearApiError` and as the fixture-routing key in
// `FakeLinearHttp` (which extracts it from the query text), so there is one
// name per wire call, not two independent labels to keep in sync. ──────────

const PREFLIGHT_QUERY = `query Preflight { viewer { id } }`;

/**
 * Store-preflight (FOR-12): list the workspace integrations so the probe can
 * check the GitHub one is installed (the substrate PR attachments — the closing
 * probe — depend on).
 *
 * **e2e-VERIFIED 2026-07-16 (FOR-23)** against the live `Formtrieb` workspace:
 * the `integrations` connection IS readable with a plain `LINEAR_API_KEY`, and
 * the GitHub sync integration's `service` enum IS the literal `"github"`. The
 * warning below is confirmed too — the live workspace also reports a distinct
 * `githubCodeAccessPersonal` service, so matching only `github` is load-bearing.
 */
const GITHUB_INTEGRATION_QUERY = `query GitHubIntegration { integrations(first: 250) { nodes { id service } } }`;
/** The `service` enum value of the PR-attachment-creating GitHub integration (e2e-VERIFIED 2026-07-16 — see GITHUB_INTEGRATION_QUERY). */
const GITHUB_INTEGRATION_SERVICE = 'github';

/**
 * `team` may be a key ("EX") or a display name ("Example") per
 * `LinearStoreConfig.team`'s doc comment — matched via an `or` filter combinator.
 * e2e-VERIFIED 2026-07-16 (FOR-23): `TeamFilter` DOES support `or: [...]` live
 * (queried against the `Formtrieb` workspace), so the single-lookup shape holds
 * and no sequential-lookup fallback is needed.
 *
 * e2e-VERIFIED 2026-07-16 (FOR-23): the `key: { eq }` arm IS case-sensitive —
 * Linear does NOT normalize server-side. Proven live against team `FOR`:
 * `key: { eq: "FOR" }` matches it, `key: { eq: "for" }` matches nothing. So a
 * config'd lowercase `team: "ex"` really does fall through to the `name: { eq }`
 * arm, which also wants an exact case match against the display name — i.e. a
 * lowercase team key in `wave.config.json` resolves NOTHING and the store fails
 * to find its team. Keep the config'd `team` exactly as Linear spells it.
 */
const RESOLVE_TEAM_CATALOG_QUERY = `query ResolveTeamCatalog($match: String!) {
  teams(filter: { or: [{ key: { eq: $match } }, { name: { eq: $match } }] }, first: 1) {
    nodes {
      id
      key
      states(first: 250) { nodes { id name type } }
      labels(first: 250) { nodes { id name } }
    }
  }
}`;

/** `project` is a display name (`LinearStoreConfig.project`); resolved against the team's own projects connection. */
const RESOLVE_PROJECT_QUERY = `query ResolveProject($teamId: String!, $name: String!) {
  team(id: $teamId) {
    projects(filter: { name: { eq: $name } }, first: 1) {
      nodes { id name }
    }
  }
}`;

/**
 * The identifier↔UUID resolution query (brief Task 6): `"EX-16"` = team key +
 * number → `issues(filter: { team: { key: { eq } }, number: { eq } } })`. One
 * shared shape backs every identifier-taking method (getIssue, comments,
 * attachments, blockedBy, and the pre-write read for label/description/state
 * mutations) — fields unused by a given caller are simply ignored.
 */
/** e2e-VERIFIED 2026-07-16 (FOR-23): `$number: Float!` is correct — live schema introspection reports `IssueFilter.number → NumberComparator`, whose `eq` field is typed `Float` (not `Int`). An `Int!` declaration would be rejected at the wire, so this stays `Float!`. */
const ISSUE_BY_IDENTIFIER_QUERY = `query IssueByIdentifier($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      id
      identifier
      title
      description
      labels(first: 250) { nodes { id name } }
      state { id name type }
      attachments(first: 250) { nodes { url sourceType metadata } }
      inverseRelations(first: 250) { nodes { type issue { identifier } } }
      comments(first: 250) { nodes { body } }
    }
  }
}`;

/** `listOpenIssues`: GraphQL cursor pagination (`pageInfo`, `first: 100`) — Linear is GraphQL-native, no REST count heuristic needed (ADR-0019 was forced into one; this adapter is not). */
const LIST_OPEN_ISSUES_QUERY = `query ListOpenIssues($filter: IssueFilter, $first: Int!, $after: String) {
  issues(filter: $filter, first: $first, after: $after) {
    nodes {
      id
      identifier
      title
      description
      labels(first: 250) { nodes { id name } }
      state { id name type }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const CREATE_ISSUE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { identifier }
  }
}`;

/** One generic mutation backs setDescription/addLabel/removeLabel/setState — all are just different `IssueUpdateInput` fields. e2e-VERIFIED 2026-07-16 (FOR-23): live schema introspection confirms `IssueUpdateInput` carries all three field names — `description`, `labelIds`, `stateId`. */
const UPDATE_ISSUE_MUTATION = `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
  }
}`;

const CREATE_COMMENT_MUTATION = `mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
  }
}`;

/**
 * The native blocked-by WRITE half (ADR-0020 fast-follow): mirror ONE body-codec
 * blockedBy ref into a Linear issue relation. `issueRelationCreate` takes an
 * `IssueRelationCreateInput` of `{ issueId, relatedIssueId, type }` — a directed
 * relation FROM `issueId` TO `relatedIssueId`.
 *
 * e2e-verify — STILL UNPROVEN. This wave ships NO live Linear probe (hermetic
 * specs only); the first subsequent `wave-create` carrying a real blockedBy ref
 * is the live gate. Pinned from Linear's documented `issueRelationCreate` /
 * `IssueRelationCreateInput` shape, alongside the `description`/`labelIds`/
 * `stateId` inputs already e2e-VERIFIED on {@link UPDATE_ISSUE_MUTATION}
 * (FOR-23). Flip to VERIFIED on that first live mirror.
 */
const CREATE_ISSUE_RELATION_MUTATION = `mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { id }
  }
}`;

/**
 * The `IssueRelationType` enum value for a blocking relation.
 *
 * e2e-verify — STILL UNPROVEN (this wave has no live probe). Pinned from
 * Linear's documented `IssueRelationType` enum (`blocks | duplicate | related |
 * similar`). It is the SAME literal the READ half already filters on —
 * `toBlockedByIdentifiers` keeps `inverseRelations` nodes whose `type ===
 * 'blocks'` — so read and write are pinned to one constant string, not two
 * independent guesses. Flip to VERIFIED on the first live mirror.
 */
const BLOCKS_RELATION_TYPE = 'blocks';

/** `addLabel`'s auto-create fallback: mirrors Task 3's seam-doc "auto-create missing labels" contract. */
const CREATE_ISSUE_LABEL_MUTATION = `mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

// ── Document facet documents (ADR-0017): a PRD is a NATIVE Linear Document —
// categorically not an issue, so it can never pollute listOpen. `content` is
// the markdown body and the facet id is the Document uuid (both live-verified
// in ADR-0017's live probe). e2e-VERIFIED 2026-07-16 (FOR-23): live schema
// introspection confirms `DocumentCreateInput` carries a `projectId` field. ───

const CREATE_DOCUMENT_MUTATION = `mutation CreateDocument($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document { id }
  }
}`;

const GET_DOCUMENT_QUERY = `query GetDocument($id: String!) {
  document(id: $id) {
    id
    title
    content
  }
}`;

/** e2e-VERIFIED 2026-07-16 (FOR-23): `DocumentFilter` DOES support `project: { id: { eq } }` — live schema introspection reports `DocumentFilter.project → ProjectFilter`, whose `id` field is an `IDComparator` (so `eq` is available). */
const LIST_DOCUMENTS_QUERY = `query ListDocuments($filter: DocumentFilter, $first: Int!, $after: String) {
  documents(filter: $filter, first: $first, after: $after) {
    nodes {
      id
      title
      content
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** The team-scoped substrate resolved once and cached (ADR-0020, documented above). */
interface StateEntry {
  id: string;
  type: LinearStateType;
}

/** The full issue node shape `IssueByIdentifier` can return; unused fields are simply left at their defaults by the light-weight `ListOpenIssues` query. */
interface ResolvedIssueNode {
  uuid: string;
  identifier: string;
  title: string;
  description: string;
  /** name → id, for THIS issue's current labels (not the team catalog). */
  labelIds: Map<string, string>;
  stateName: string;
  stateType: LinearStateType;
  attachments: LinearPrAttachment[];
  blockedByIdentifiers: string[];
  comments: { body: string }[];
}

export class RealLinearApi implements LinearApi {
  private teamId: string | undefined;
  private stateCatalog: Map<string, StateEntry> | undefined;
  private labelCatalog: Map<string, string> | undefined;
  private projectId: string | undefined;
  private catalogLoaded = false;

  constructor(
    private readonly team: string,
    private readonly project: string | undefined,
    private readonly token: string,
    private readonly http: LinearHttp = defaultLinearHttp(),
  ) {}

  /** Verify the API key before any wave op (ADR-0019/0020 construction preflight). */
  async preflight(): Promise<void> {
    const { data, status } = await this.gql('Preflight', PREFLIGHT_QUERY);
    const viewer = data.viewer as Record<string, unknown> | null | undefined;
    if (!viewer || typeof viewer.id !== 'string') {
      throw new LinearApiError('Preflight', status, 'LINEAR_API_KEY rejected (viewer.id missing from the response)');
    }
  }

  async createIssue(input: LinearCreateIssueInput): Promise<{ identifier: string }> {
    await this.ensureCatalog();
    const labelIds = await this.resolveOrCreateLabelIds(input.labels);
    const gqlInput: Record<string, unknown> = {
      teamId: this.teamId,
      title: input.title,
      description: input.description,
      labelIds,
    };
    if (this.projectId) gqlInput.projectId = this.projectId;
    const { data } = await this.gql('CreateIssue', CREATE_ISSUE_MUTATION, { input: gqlInput });
    const payload = data.issueCreate as Record<string, unknown> | undefined;
    const issue = payload?.issue as Record<string, unknown> | undefined;
    const identifier = issue?.identifier;
    if (typeof identifier !== 'string') {
      throw new LinearApiError('CreateIssue', 200, 'issueCreate did not return an issue identifier');
    }
    return { identifier };
  }

  async getIssue(identifier: string): Promise<LinearIssue> {
    const node = await this.resolveIssue(identifier);
    return toLinearIssue(node);
  }

  async listOpenIssues(): Promise<LinearIssue[]> {
    await this.ensureCatalog();
    const filter: Record<string, unknown> = { team: { id: { eq: this.teamId } } };
    if (this.projectId) filter.project = { id: { eq: this.projectId } };

    const out: LinearIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListOpenIssues', LIST_OPEN_ISSUES_QUERY, { filter, first: 100, after });
      const connection = (data.issues ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      for (const raw of nodes) {
        const node = toResolvedIssueNode(raw);
        if (CLOSED_TYPES.has(node.stateType)) continue; // Open = stateType ∉ {completed, canceled} (ADR-0020)
        out.push(toLinearIssue(node));
      }
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor — stop rather than loop forever
    }
    return out;
  }

  async setDescription(identifier: string, description: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    await this.updateIssue(node.uuid, { description });
  }

  /**
   * e2e-verify — `IssueUpdateInput` carries a `title` field. Pinned from
   * Linear's documented `IssueUpdateInput` (the same input shape `description`/
   * `labelIds`/`stateId` are e2e-VERIFIED on, FOR-23); the Amend facet's title
   * write (ADR-0025) had no live run yet. Flip to VERIFIED on a real amend.
   */
  async setTitle(identifier: string, title: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    await this.updateIssue(node.uuid, { title });
  }

  async addLabel(identifier: string, label: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    if (node.labelIds.has(label)) return; // idempotent
    await this.ensureCatalog();
    const labelId = await this.resolveOrCreateLabelId(label);
    const labelIds = [...node.labelIds.values(), labelId];
    await this.updateIssue(node.uuid, { labelIds });
  }

  async removeLabel(identifier: string, label: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    if (!node.labelIds.has(label)) return; // idempotent — no-op if absent
    const labelIds = [...node.labelIds.entries()].filter(([name]) => name !== label).map(([, id]) => id);
    await this.updateIssue(node.uuid, { labelIds });
  }

  async addComment(identifier: string, body: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    const { data } = await this.gql('CreateComment', CREATE_COMMENT_MUTATION, { input: { issueId: node.uuid, body } });
    const payload = data.commentCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('CreateComment', 200, 'commentCreate did not report success');
    }
  }

  /**
   * e2e-verify — STILL UNPROVEN (attempted 2026-07-16, FOR-23). Relies on
   * Linear's default `comments` connection order being creation-ascending
   * (oldest-first, matching the `LinearApi` contract); no explicit `orderBy` is
   * sent. Verification was attempted against the live `Formtrieb` workspace and
   * could NOT be completed: no issue there carries 2+ comments, so ordering is
   * unobservable — a single-element list is sorted under every ordering. This is
   * the ONE assumption in this file the 2026-07-16 sweep could not settle; the
   * others are now confirmed. Verify on a workspace with a multi-comment issue,
   * or make it moot by sending an explicit `orderBy: createdAt`.
   */
  async getComments(identifier: string): Promise<{ body: string }[]> {
    const node = await this.resolveIssue(identifier);
    return node.comments;
  }

  async setState(identifier: string, stateName: string): Promise<void> {
    const node = await this.resolveIssue(identifier);
    await this.ensureCatalog();
    const entry = this.stateCatalog!.get(stateName);
    if (!entry) {
      throw new Error(`Linear state not found in the team workflow: "${stateName}"`);
    }
    await this.updateIssue(node.uuid, { stateId: entry.id });
  }

  async getPrAttachments(identifier: string): Promise<LinearPrAttachment[]> {
    const node = await this.resolveIssue(identifier);
    return node.attachments;
  }

  async getBlockedBy(identifier: string): Promise<string[]> {
    const node = await this.resolveIssue(identifier);
    return node.blockedByIdentifiers;
  }

  /**
   * Mirror ONE blockedBy ref natively (ADR-0020 write half). Both identifiers
   * are resolved to their UUIDs (either resolution throwing on an unknown id —
   * the store treats that as a non-fatal single-mirror skip), then a `blocks`
   * relation is created with the BLOCKER as the source (`issueId`) and the
   * BLOCKED issue as the target (`relatedIssueId`): "blocker blocks blocked",
   * i.e. from the blocked issue's own perspective it is blocked-BY the blocker
   * ({@link BLOCKS_RELATION_TYPE} direction). ADDITIVE-ONLY — this method has no
   * delete/update branch by construction (ADR-0020: never remove a relation).
   */
  async addBlockedBy(blockedIdentifier: string, blockerIdentifier: string): Promise<void> {
    const blockedUuid = (await this.resolveIssue(blockedIdentifier)).uuid;
    const blockerUuid = (await this.resolveIssue(blockerIdentifier)).uuid;
    const { data } = await this.gql('CreateIssueRelation', CREATE_ISSUE_RELATION_MUTATION, {
      // issueId = the BLOCKER (source that "blocks"), relatedIssueId = the
      // BLOCKED issue (target). This is the exact inverse the READ half reads
      // back: the blocked issue's `inverseRelations` will then carry this
      // node with `type: 'blocks'` and `issue` = the blocker.
      input: { issueId: blockerUuid, relatedIssueId: blockedUuid, type: BLOCKS_RELATION_TYPE },
    });
    const payload = data.issueRelationCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('CreateIssueRelation', 200, 'issueRelationCreate did not report success');
    }
  }

  async hasGitHubIntegration(): Promise<boolean> {
    const { data } = await this.gql('GitHubIntegration', GITHUB_INTEGRATION_QUERY);
    const nodes = ((data.integrations as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
    return nodes.some((n) => n.service === GITHUB_INTEGRATION_SERVICE);
  }

  async listStates(): Promise<{ name: string; type: LinearStateType }[]> {
    await this.ensureCatalog();
    return [...this.stateCatalog!.entries()].map(([name, entry]) => ({ name, type: entry.type }));
  }

  // ── Document facet (ADR-0017): a PRD is a NATIVE Linear Document — it lives
  // outside the issue-space entirely, so the ADR-0011 "never enters
  // listOpen('wave-ready')" constraint holds structurally, not by label
  // discipline. `content` is the markdown body; the facet id is the uuid. ────

  /**
   * Documented choice (per ADR-0017's project-binding option): when this api
   * was constructed WITH a `project`, the new Document attaches to that
   * project (`projectId` from the cached resolution) — the wave≈Project
   * binding that recovers the "this PRD was sliced into these issues"
   * grouping. WITHOUT a bound project it throws up-front (status 0 = no wire
   * call was made — a client-side precondition, not an HTTP failure): a clear
   * error beats silently minting an orphan Document nothing scopes to.
   */
  async createDocument(input: { title: string; content: string }): Promise<{ id: string }> {
    if (!this.project) {
      throw new LinearApiError(
        'CreateDocument',
        0,
        'RealLinearApi was constructed without a project — refusing to create an orphan Document. ' +
          'Bind a `project` in the linear store config (ADR-0017 wave≈Project binding).',
      );
    }
    await this.ensureCatalog(); // resolves this.projectId (throws if the project name is unknown)
    const { data } = await this.gql('CreateDocument', CREATE_DOCUMENT_MUTATION, {
      input: { title: input.title, content: input.content, projectId: this.projectId },
    });
    const payload = data.documentCreate as Record<string, unknown> | undefined;
    const doc = payload?.document as Record<string, unknown> | undefined;
    const id = doc?.id;
    if (typeof id !== 'string') {
      throw new LinearApiError('CreateDocument', 200, 'documentCreate did not return a document id');
    }
    return { id };
  }

  async getDocument(id: string): Promise<{ id: string; title: string; content: string }> {
    const { data } = await this.gql('GetDocument', GET_DOCUMENT_QUERY, { id });
    const doc = data.document as Record<string, unknown> | null | undefined;
    if (!doc) {
      throw new Error(`Linear document not found: ${id}`); // domain 404 — HTTP 200 with a null node
    }
    return toDocumentNode(doc);
  }

  /**
   * Scoped to the bound project when one is configured (the PRD panel wants
   * the wave's own project docs); workspace-wide otherwise — with NO catalog
   * round-trip, since an unbound listing needs no id resolution at all.
   */
  async listDocuments(): Promise<{ id: string; title: string; content: string }[]> {
    let filter: Record<string, unknown> | undefined;
    if (this.project) {
      await this.ensureCatalog();
      filter = { project: { id: { eq: this.projectId } } };
    }
    const out: { id: string; title: string; content: string }[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListDocuments', LIST_DOCUMENTS_QUERY, { filter, first: 100, after });
      const connection = (data.documents ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      for (const raw of nodes) out.push(toDocumentNode(raw));
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor — stop rather than loop forever
    }
    return out;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** One GraphQL round-trip; centralizes both failure modes (brief: non-2xx OR `errors[]` → typed error). */
  private async gql(
    op: string,
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const res = await this.http.request({ query, variables, token: this.token });
    if (res.status !== 200) {
      throw new LinearApiError(op, res.status, `Linear ${op} failed (HTTP ${res.status})`);
    }
    const body = (res.json ?? {}) as Record<string, unknown>;
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new LinearApiError(op, res.status, `GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    return { status: res.status, data: (body.data ?? {}) as Record<string, unknown> };
  }

  /**
   * Resolve the team's state catalog + label catalog + (if configured) the
   * project id — ONCE, on first use (documented construction-time caching,
   * see the file header). Idempotent no-op on every subsequent call.
   */
  private async ensureCatalog(): Promise<void> {
    if (this.catalogLoaded) return;
    const { data } = await this.gql('ResolveTeamCatalog', RESOLVE_TEAM_CATALOG_QUERY, { match: this.team });
    const teams = ((data.teams as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
    const teamNode = teams[0];
    if (!teamNode) {
      throw new Error(`Linear team not found (key or name): "${this.team}"`);
    }
    this.teamId = String(teamNode.id);

    const statesRaw = ((teamNode.states as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
    this.stateCatalog = new Map(
      statesRaw.map((s) => [String(s.name), { id: String(s.id), type: toStateType(s.type) }]),
    );

    const labelsRaw = ((teamNode.labels as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
    this.labelCatalog = new Map(labelsRaw.map((l) => [String(l.name), String(l.id)]));

    if (this.project) {
      const { data: pdata } = await this.gql('ResolveProject', RESOLVE_PROJECT_QUERY, {
        teamId: this.teamId,
        name: this.project,
      });
      const teamForProject = pdata.team as Record<string, unknown> | null | undefined;
      const projects = ((teamForProject?.projects as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
      const projectNode = projects[0];
      if (!projectNode) {
        throw new Error(`Linear project not found in team "${this.team}": "${this.project}"`);
      }
      this.projectId = String(projectNode.id);
    }

    this.catalogLoaded = true;
  }

  /** name → id, creating the label on the team via `issueLabelCreate` when absent (auto-create, Task 3 parity). */
  private async resolveOrCreateLabelIds(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) ids.push(await this.resolveOrCreateLabelId(name));
    return ids;
  }

  private async resolveOrCreateLabelId(name: string): Promise<string> {
    const existing = this.labelCatalog?.get(name);
    if (existing) return existing;
    const { data } = await this.gql('CreateIssueLabel', CREATE_ISSUE_LABEL_MUTATION, {
      input: { name, teamId: this.teamId },
    });
    const payload = data.issueLabelCreate as Record<string, unknown> | undefined;
    const label = payload?.issueLabel as Record<string, unknown> | undefined;
    const id = label?.id;
    if (typeof id !== 'string') {
      throw new LinearApiError('CreateIssueLabel', 200, `issueLabelCreate did not return an id for label "${name}"`);
    }
    this.labelCatalog?.set(name, id);
    return id;
  }

  /**
   * Resolve `"EX-16"` → the live issue node. Identifiers are self-describing
   * (team key + number, ADR-0001) so this needs NO catalog resolution — only
   * `addLabel`/`setState` (writes) touch `ensureCatalog()` afterwards.
   */
  private async resolveIssue(identifier: string): Promise<ResolvedIssueNode> {
    const { teamKey, number } = parseIdentifier(identifier);
    const { data } = await this.gql('IssueByIdentifier', ISSUE_BY_IDENTIFIER_QUERY, { teamKey, number });
    const nodes = ((data.issues as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
    const raw = nodes[0];
    if (!raw) {
      throw new Error(`Linear issue not found: ${identifier}`); // domain 404 — not a wire failure (HTTP 200, empty result)
    }
    return toResolvedIssueNode(raw);
  }

  private async updateIssue(uuid: string, input: Record<string, unknown>): Promise<void> {
    const { data } = await this.gql('UpdateIssue', UPDATE_ISSUE_MUTATION, { id: uuid, input });
    const payload = data.issueUpdate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('UpdateIssue', 200, 'issueUpdate did not report success');
    }
  }
}

/** `"EX-16"` → `{ teamKey: "EX", number: 16 }`. Mirrors `LinearIssuesStore.parseRef`'s pattern. */
function parseIdentifier(identifier: string): { teamKey: string; number: number } {
  const m = /^(.+)-(\d+)$/.exec(identifier);
  if (!m) {
    throw new Error(`RealLinearApi: "${identifier}" is not a "<TEAM>-<number>" Linear identifier.`);
  }
  return { teamKey: m[1], number: Number(m[2]) };
}

function toStateType(raw: unknown): LinearStateType {
  const s = String(raw);
  if ((STATE_TYPES as readonly string[]).includes(s)) return s as LinearStateType;
  throw new Error(`Unknown Linear workflow state type: "${s}"`);
}

/**
 * The `metadata.status` value a MERGED GitHub PR attachment carries.
 *
 * **e2e-VERIFIED 2026-07-16 (FOR-23)** against the live `Formtrieb` workspace:
 * queried all 13 GitHub-integration attachments; every merged PR reports
 * `status: "merged"` alongside a non-null `mergedAt`. `status` is the ONLY
 * merge-status key — the metadata object carries no `state` key whatsoever.
 *
 * History: this read was originally `metadata.state === 'merged'`, an
 * *assumed* shape the fake and the fixture both encoded, so the suite was
 * green against a shape the API never returns. Live effect: `merged` was
 * always false ⇒ every merged row probed `closed-unmerged` (confirmed in wave
 * `2026-07-16-hardening-w3`, where three genuinely-merged rows would have been
 * flagged `recoverable-stop`). The regression fixture in the spec is captured
 * verbatim from the wire — do not hand-write this shape.
 */
const MERGED_PR_STATUS = 'merged';

/**
 * Defensive attachment parse (`unknown` + narrowing, `real-github-api.ts:138-150`
 * style): only GitHub-integration attachments (`sourceType === 'github'`)
 * carry a PR merge status, so non-GitHub attachments (Figma links, etc.) are
 * dropped — an empty result therefore means "no PR evidence at all", which the
 * store maps to `closed-unknown` rather than to a rejected PR (W2-F1c).
 *
 * e2e-VERIFIED 2026-07-16 (FOR-23): `sourceType === 'github'` is the exact live
 * string (all 13 live attachments), and merge status lives at
 * {@link MERGED_PR_STATUS `metadata.status`}. Both assumptions are now
 * confirmed against the wire, not assumed.
 */
function toPrAttachment(raw: Record<string, unknown>): LinearPrAttachment | null {
  const url = raw.url;
  if (typeof url !== 'string') return null;
  if (raw.sourceType !== 'github') return null;
  const metadata = raw.metadata;
  const merged =
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<string, unknown>).status === MERGED_PR_STATUS;
  return { url, merged };
}

/** `issue.inverseRelations.nodes` filtered to `type === 'blocks'` (brief Task 6) — a relation "A blocks B" surfaces on B as an inverse relation. */
function toBlockedByIdentifiers(nodes: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    if (n.type !== 'blocks') continue;
    const issue = n.issue as Record<string, unknown> | undefined;
    if (typeof issue?.identifier === 'string') out.push(issue.identifier);
  }
  return out;
}

/** Narrow one raw GraphQL issue node (from either `IssueByIdentifier` or the lighter `ListOpenIssues`) into the typed internal shape. */
function toResolvedIssueNode(raw: Record<string, unknown>): ResolvedIssueNode {
  const labelNodes = ((raw.labels as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
  const labelIds = new Map<string, string>();
  for (const l of labelNodes) labelIds.set(String(l.name), String(l.id));

  const state = (raw.state ?? {}) as Record<string, unknown>;

  const attachmentNodes = ((raw.attachments as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
  const attachments = attachmentNodes
    .map(toPrAttachment)
    .filter((a): a is LinearPrAttachment => a !== null);

  const relationNodes = ((raw.inverseRelations as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
  const blockedByIdentifiers = toBlockedByIdentifiers(relationNodes);

  const commentNodes = ((raw.comments as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
  const comments = commentNodes.map((c) => ({ body: typeof c.body === 'string' ? c.body : '' }));

  return {
    uuid: String(raw.id),
    identifier: String(raw.identifier),
    title: typeof raw.title === 'string' ? raw.title : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    labelIds,
    stateName: typeof state.name === 'string' ? state.name : '',
    stateType: toStateType(state.type),
    attachments,
    blockedByIdentifiers,
    comments,
  };
}

function toLinearIssue(node: ResolvedIssueNode): LinearIssue {
  return {
    identifier: node.identifier,
    title: node.title,
    description: node.description,
    labels: [...node.labelIds.keys()],
    stateName: node.stateName,
    stateType: node.stateType,
  };
}

/** Narrow one raw Document node — `content` is the markdown body (ADR-0017 live-verified shape). */
function toDocumentNode(raw: Record<string, unknown>): { id: string; title: string; content: string } {
  return {
    id: String(raw.id),
    title: typeof raw.title === 'string' ? raw.title : '',
    content: typeof raw.content === 'string' ? raw.content : '',
  };
}
