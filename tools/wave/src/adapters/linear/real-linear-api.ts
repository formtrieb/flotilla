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
  LinearInitiative,
  LinearProject,
  LinearProjectStatusType,
  LinearStateType,
  LinearCreateIssueInput,
  LinearPrAttachment,
} from './linear-api';
import {
  PROJECT_BLOCKS_RELATION_TYPE,
  PROJECT_RELATION_ANCHOR_PAIR,
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
      updatedAt
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
      updatedAt
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

// ── Goal facet (ADR-0044): a Goal is a native Linear PROJECT ────────────────
//
// Every shape below is read verbatim from Linear's published GraphQL schema
// (`linear/linear` → `packages/sdk/src/schema.graphql`, read 2026-08-15, THIS
// dispatch — ADR-0030's declared-unexecutable-path comparison; no live Linear
// credential is available to this row, so none of it is live-proven and the
// first `goal` station run on a linear-store consumer is the gate):
//
//   - `projectCreate(input: ProjectCreateInput!): ProjectPayload!`, and
//     `ProjectPayload { lastSyncId, project: Project, success: Boolean! }` — so
//     the success check below matches every other mutation in this file.
//   - `ProjectCreateInput` requires exactly two fields: `name: String!` and
//     `teamIds: [String!]!`; `description: String` is optional. The required
//     `teamIds` arity is why {@link RealLinearApi.createProject} calls
//     `ensureCatalog()` first — a project is never minted parentless, the same
//     property `createDocument` has.
//   - `project(id: String!): Project!` for the single read.
//   - `Team.projects(first, after, …): ProjectConnection!` for the scoped list —
//     the TEAM connection rather than the root `projects(filter:)`, so the
//     scoping is structural instead of a filter that could be omitted.
//   - `Project.issues(first, after, …): IssueConnection!` for membership, and
//     `IssueUpdateInput.projectId: String` for the curation write.
//
// `Project.state` is deliberately NOT selected anywhere here: the schema marks
// it `@deprecated(reason: "Use project.status instead")`, and the facet has no
// use for it either way — whether the CONTAINER is open says nothing about
// whether its members are done, and the facet ships no `closeGoal`.

// `status { type }` joins every project selection below (ADR-0045 decision 2):
// `Project.status: ProjectStatus!` and `ProjectStatus.type: ProjectStatusType!`
// (`backlog | planned | started | paused | completed | canceled`), read from the
// published schema 2026-08-15, this dispatch. The status NAME is
// consumer-customizable and so unreadable as a rule; the fixed CATEGORY is what
// the frontier maps. This is also why `Project.state` stays unselected — the
// schema marks it `@deprecated(reason: "Use project.status instead")`.
const CREATE_PROJECT_MUTATION = `mutation CreateProject($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    success
    project { id name description status { type } }
  }
}`;

const GET_PROJECT_QUERY = `query GetProject($id: String!) {
  project(id: $id) {
    id
    name
    description
    status { type }
  }
}`;

const LIST_TEAM_PROJECTS_QUERY = `query ListTeamProjects($teamId: String!, $first: Int!, $after: String) {
  team(id: $teamId) {
    projects(first: $first, after: $after) {
      nodes {
        id
        name
        description
        status { type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// ── Goal facet (ADR-0045): initiatives, and native project dependencies ──────
//
// Read verbatim from Linear's published GraphQL schema (`linear/linear` →
// `packages/sdk/src/schema.graphql`, read 2026-08-15, THIS dispatch — ADR-0030's
// declared-unexecutable-path comparison; no live Linear credential is available
// to this row, so none of it is live-proven and the first `goal` station run on
// an initiative-bound consumer is the gate):
//
//   - `initiativeCreate(input: InitiativeCreateInput!): InitiativePayload!`,
//     payload `{ initiative, lastSyncId, success }`. `InitiativeCreateInput`
//     requires only `name: String!`; `description: String` is optional and there
//     is NO team field — initiatives live above teams.
//   - `initiative(id: String!): Initiative!` for the single read.
//   - the ROOT `initiatives(first, after, …): InitiativeConnection!` for the
//     list — workspace-wide by construction, which is the documented divergence
//     from the team-scoped `Team.projects` connection (ADR-0045 decision 5).
//   - `Initiative.projects(first, after, includeSubInitiatives, …):
//     ProjectConnection!` for membership. `includeSubInitiatives` is documented
//     "Defaults to true", so it is passed EXPLICITLY false below — the default
//     would flatten a sub-initiative's projects into this goal's members.
//   - `initiativeToProjectCreate(input: InitiativeToProjectCreateInput!):
//     InitiativeToProjectPayload!` for the join; its input requires
//     `initiativeId: String!` and `projectId: String!`.
//   - `projectRelationCreate` / `Project.inverseRelations` for the dependency
//     arm. Its three VALUE-level strings are the one part of this block that is
//     no longer schema-read at all: they were MEASURED against a live workspace
//     on 2026-08-16, which falsified both originally-pinned values. Read the
//     read-stamp on `PROJECT_BLOCKS_RELATION_TYPE` in linear-api.ts before
//     trusting any `String!` in the list above as an unconstrained field —
//     Linear validates several of them as enums one layer behind GraphQL, where
//     no schema read can see it.

const CREATE_INITIATIVE_MUTATION = `mutation CreateInitiative($input: InitiativeCreateInput!) {
  initiativeCreate(input: $input) {
    success
    initiative { id name description }
  }
}`;

const GET_INITIATIVE_QUERY = `query GetInitiative($id: String!) {
  initiative(id: $id) {
    id
    name
    description
  }
}`;

const LIST_INITIATIVES_QUERY = `query ListInitiatives($first: Int!, $after: String) {
  initiatives(first: $first, after: $after) {
    nodes {
      id
      name
      description
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * An initiative's DIRECT member projects. `includeSubInitiatives: false` is the
 * whole of ADR-0045 decision 1 at the wire: Linear defaults that argument to
 * TRUE, so omitting it would quietly report a sub-initiative's projects as this
 * goal's own members — a flattening arriving through a vendor default rather
 * than through a query anyone wrote.
 */
const LIST_INITIATIVE_PROJECTS_QUERY = `query ListInitiativeProjects($id: String!, $first: Int!, $after: String) {
  initiative(id: $id) {
    projects(first: $first, after: $after, includeSubInitiatives: false) {
      nodes {
        id
        name
        description
        status { type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CREATE_INITIATIVE_TO_PROJECT_MUTATION = `mutation CreateInitiativeToProject($input: InitiativeToProjectCreateInput!) {
  initiativeToProjectCreate(input: $input) {
    success
  }
}`;

/**
 * A project's blocked-by side. `inverseRelations` — never `relations` — for the
 * same directional reason the issue arm reads the inverse side: a relation "A
 * blocks B" is stored on A and surfaces on B as an inverse.
 */
const LIST_PROJECT_INVERSE_RELATIONS_QUERY = `query ListProjectInverseRelations($id: String!, $first: Int!, $after: String) {
  project(id: $id) {
    inverseRelations(first: $first, after: $after) {
      nodes {
        type
        project { id }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const CREATE_PROJECT_RELATION_MUTATION = `mutation CreateProjectRelation($input: ProjectRelationCreateInput!) {
  projectRelationCreate(input: $input) {
    success
    projectRelation { id }
  }
}`;

/**
 * A project's membership — OPEN AND CLOSED, deliberately unfiltered, unlike
 * {@link LIST_OPEN_ISSUES_QUERY}: `done` is one of the five frontier readings,
 * so dropping closed members would report a finished goal as an empty one. The
 * node selection matches `ListOpenIssues` exactly so both feed the same
 * {@link toResolvedIssueNode} projection.
 */
const LIST_PROJECT_ISSUES_QUERY = `query ListProjectIssues($id: String!, $first: Int!, $after: String) {
  project(id: $id) {
    issues(first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        description
        updatedAt
        labels(first: 250) { nodes { id name } }
        state { id name type }
      }
      pageInfo { hasNextPage endCursor }
    }
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
 * similar`), and the WRITE this constant feeds is genuinely governed by it:
 * `IssueRelationCreateInput.type` is typed `IssueRelationType!`. Flip to
 * VERIFIED on the first live mirror.
 *
 * **The READ half is a different story, and an earlier wording here overstated
 * it.** `toBlockedByIdentifiers` does keep `inverseRelations` nodes whose
 * `type === 'blocks'`, but that field is `IssueRelation.type: String!` — bare,
 * as is `IssueRelationUpdateInput.type`. The enum governs one input field, not
 * the arm. And the filter does not even reach this constant: it repeats
 * `'blocks'` as an inline literal, so the two halves agree by coincidence of
 * spelling rather than by construction. The PROJECT arm is the better shape on
 * both counts — `PROJECT_BLOCKS_RELATION_TYPE` is imported by its read filter
 * and its write alike.
 *
 * **This enum is real, and it is exactly the one that must NOT be carried
 * sideways.** The schema types `IssueRelationCreateInput.type` as
 * `IssueRelationType!`; the parallel PROJECT arm publishes no enum at all and
 * types its `type` as bare `String!`. `PROJECT_BLOCKS_RELATION_TYPE` in
 * `linear-api.ts` originally borrowed `'blocks'` from HERE and was refused live
 * — that constant's read-stamp carries the full account and the rule. Do not
 * read this pin as evidence about any project-side value.
 */
const BLOCKS_RELATION_TYPE = 'blocks';

/**
 * The attachment upsert (issue #511, mechanics proven consumer-side).
 * `attachmentCreate` IS the upsert — no find-before-create needed on this
 * side. Read verbatim from Linear's published GraphQL schema
 * (`linear/linear` → `packages/sdk/src/schema.graphql`, read 2026-08-14, this
 * dispatch — ADR-0030 declared-unexecutable-path comparison, no live
 * credential available here): `AttachmentCreateInput.url`'s doc string reads
 * "Attachment location which is also used as an unique identifier for the
 * attachment. If another attachment is created with the same `url` value,
 * existing record is updated instead." — the exact idempotency the consumer
 * report proved live. `issueId: String!` accepts either a UUID or a human
 * identifier per its own doc string, but this adapter always resolves and
 * passes the UUID (consistent with every other mutation here). The schema
 * carries NO `sourceType` input field — `Attachment.sourceType` is a DERIVED
 * read field ("the integration type... or 'unknown' if source is absent"),
 * and `AttachmentCreateInput` has no `source` field either — so a card minted
 * here can never read back `sourceType: 'github'` and can never be picked up
 * by {@link toPrAttachment}'s github-sourced filter (see that function's doc
 * and `LinearApi.getPrAttachments`'s).
 */
const UPSERT_ATTACHMENT_MUTATION = `mutation UpsertAttachment($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
  }
}`;

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
// introspection confirms `DocumentCreateInput` carries a `projectId` field.
//
// `DocumentCreateInput` ALSO carries a `teamId` — the parent the unbound arm
// of {@link RealLinearApi.createDocument} uses. Read from Linear's published
// GraphQL schema (`linear/linear` → `packages/sdk/src/schema.graphql`, read
// 2026-08-10): `DocumentCreateInput.teamId: String`, doc-string "[Internal]
// Related team for the document." The rule the two arms below implement is
// stated by Linear's own agent-facing `save_document` tool — quoted from the
// tool description Linear's MCP server serves, which has no stable public URL
// to cite (re-verified verbatim against the served description 2026-08-10;
// the published schema above corroborates the substance): on create, "exactly
// one parent (`project`, `issue`, `initiative`, `cycle`, or `team`) must be
// specified", with `team` documented as "Attaches the document to the team".
// So a team parent is a first-class Document parent, not a workaround.
// e2e-VERIFIED 2026-08-10 (second external consumer's live workspace,
// unbound engine CLI at 1.2.0): documentCreate carrying teamId is accepted
// live and yields a clean team parent — the [Internal] annotation is a
// docs-visibility marker, not a functional reservation. ────────────────────

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

/**
 * e2e-VERIFIED 2026-07-16 (FOR-23): `DocumentFilter` DOES support
 * `project: { id: { eq } }` — live schema introspection reports
 * `DocumentFilter.project → ProjectFilter`, whose `id` field is an
 * `IDComparator` (so `eq` is available).
 *
 * `DocumentFilter` carries a TEAM predicate too, so the unbound listing narrows
 * SERVER-side rather than fetching the workspace and filtering in memory. Read
 * from Linear's published GraphQL schema (`linear/linear` →
 * `packages/sdk/src/schema.graphql`, read 2026-08-10): `DocumentFilter.team:
 * NullableTeamFilter`, and `NullableTeamFilter.id: IDComparator` (`eq: ID`) —
 * the exact `{ team: { id: { eq } } }` shape sent below. Annotation status,
 * stated symmetrically with the create-side comment above: `DocumentFilter.team`
 * carries NO `[Internal]` marker (its doc-string reads "Filters that the
 * document's team must satisfy."); it is `Document.team` — the node field —
 * that is annotated `[Internal]` and documented "Null if the document belongs
 * to a different parent entity type."
 *
 * That null is a structural consequence worth stating: a team-filtered listing
 * can NEVER return a project-attached Document (its `team` is null, so no team
 * predicate matches). A workspace mixing ADR-0017's optional richer project
 * binding with team-parented PRDs will not see the project-attached ones in
 * the unbound (team-filtered) panel. Deliberately accepted, not a gap to fix:
 * the team-central convention keeps an unbound consumer's PRDs team-parented —
 * exactly what the unbound `createDocument` arm produces — and a project-bound
 * consumer lists through the project arm instead. e2e-VERIFIED 2026-08-10
 * (second external consumer's live workspace, unbound engine CLI at 1.2.0):
 * a team-parented document returns from the team-filtered listing while a
 * document attached to a project through the Linear UI never appears in it —
 * no error, no warning. The null itself is corroborated from a second
 * workspace via Linear's own API the same day: two project-attached documents
 * both read `team: null`.
 *
 * The client-side fallback the same read makes available (`Document.team: Team`
 * is selectable on the node) is therefore NOT taken: it would page the whole
 * workspace to discard most of it.
 */
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
  /**
   * Linear's own `updatedAt` on the Issue node (ISO-8601). Undefined when the
   * query that produced this node did not ask for it, or the field came back a
   * non-string; the store passes that absence through and the DoR staleness
   * advisory `defer`s rather than falsely passing.
   */
  updatedAt: string | undefined;
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
      // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50.
      // Linear's pagination reference (linear.app/developers/pagination, re-read
      // 2026-08-15) states "The first 50 results are returned by default without
      // query arguments" and names no maximum; this asks for twice the documented
      // default, deliberately. Reason: the loop below drains `pageInfo.hasNextPage`
      // to cursor exhaustion rather than trusting one page, so the number decides
      // how many round-trips a full read costs and can never decide WHAT it
      // returns — a smaller page is more requests for the identical result set.
      // The same deliberate 100 is stated at the adapter's three other paged
      // reads: `listDocuments`, `listProjects`, `listProjectIssues`.
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

  /**
   * Upsert one attachment card, keyed by `input.url` (issue #511). No
   * find-before-create: `attachmentCreate` itself is the upsert (see
   * {@link UPSERT_ATTACHMENT_MUTATION}'s doc). `issueId` is resolved to the
   * UUID via the same `resolveIssue` every other write already uses.
   */
  async upsertAttachment(
    identifier: string,
    input: { url: string; title: string; subtitle: string },
  ): Promise<void> {
    const node = await this.resolveIssue(identifier);
    const { data } = await this.gql('UpsertAttachment', UPSERT_ATTACHMENT_MUTATION, {
      input: { issueId: node.uuid, url: input.url, title: input.title, subtitle: input.subtitle },
    });
    const payload = data.attachmentCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('UpsertAttachment', 200, 'attachmentCreate did not report success');
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
   * Attach the new Document to the ONE parent this adapter has (Linear's own
   * create contract: exactly one of project / issue / initiative / cycle /
   * team):
   *
   *   - **project-bound api** → `projectId` from the cached resolution. This
   *     is ADR-0017's wave≈Project binding, which recovers the human-visible
   *     "this PRD was sliced into these issues" grouping. Unchanged.
   *   - **unbound api** → `teamId` from the *required* `team` config, resolved
   *     through the same cached catalog every other write already uses.
   *
   * The unbound arm replaced an up-front refusal (a `LinearApiError` with
   * status 0, thrown before any wire call). That refusal was **adapter policy,
   * never a platform constraint**: ADR-0017's own live probe observed the
   * team-scoped shape natively (`project: null`, `initiative: null` — attached
   * only to a team). Its cost was that the whole Document facet sat behind a
   * config field a team-pool consumer must leave UNSET, because `project` also
   * narrows the candidate pool `listOpen` draws from (ADR-0020) — such a
   * consumer had to choose between its candidate pool and its PRDs.
   *
   * No arm can mint an orphan: `team` is required config, so every Document
   * this adapter creates hangs off at least the configured team.
   */
  async createDocument(input: { title: string; content: string }): Promise<{ id: string }> {
    // resolves this.teamId, and this.projectId when a project name is bound
    // (either resolution throws loudly if the configured name is unknown).
    await this.ensureCatalog();
    const parent = this.project ? { projectId: this.projectId } : { teamId: this.teamId };
    const { data } = await this.gql('CreateDocument', CREATE_DOCUMENT_MUTATION, {
      input: { title: input.title, content: input.content, ...parent },
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
   * Always scoped, never workspace-wide — the PRD panel is a view of THIS
   * consumer's planning docs, not of every document anyone in the workspace
   * ever wrote:
   *
   *   - **project-bound api** → the bound project's documents. Unchanged.
   *   - **unbound api** → the configured team's documents, narrowed
   *     SERVER-side via `DocumentFilter.team` (see
   *     {@link LIST_DOCUMENTS_QUERY} for the schema read that pins the shape).
   *
   * The unbound arm replaced an *unfiltered* query — workspace-wide, not even
   * team-scoped — which made a team-pool consumer's PRD panel a listing of
   * every other team's documents too. It costs the one catalog round-trip that
   * arm used to skip; a listing scoped to the wrong thing is not worth saving
   * it.
   */
  async listDocuments(): Promise<{ id: string; title: string; content: string }[]> {
    await this.ensureCatalog();
    const filter: Record<string, unknown> = this.project
      ? { project: { id: { eq: this.projectId } } }
      : { team: { id: { eq: this.teamId } } };
    const out: { id: string; title: string; content: string }[] = [];
    let after: string | undefined;
    for (;;) {
      // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50
      // ("The first 50 results are returned by default without query arguments",
      // linear.app/developers/pagination, re-read 2026-08-15; no maximum stated).
      // Deliberate: this loop drains the cursor to exhaustion, so the page size
      // changes only the round-trip count of a full read, never its result set.
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

  // ── Goal facet (ADR-0044): projects ───────────────────────────────────────

  async createProject(input: { name: string; description: string }): Promise<{ id: string }> {
    // `ProjectCreateInput.teamIds` is REQUIRED (`[String!]!`), so the team must
    // resolve before the mutation — a project is never minted parentless.
    await this.ensureCatalog();
    const { data } = await this.gql('CreateProject', CREATE_PROJECT_MUTATION, {
      input: {
        name: input.name,
        description: input.description,
        teamIds: [this.teamId],
      },
    });
    const payload = data.projectCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('CreateProject', 200, 'projectCreate did not report success');
    }
    const project = payload.project as Record<string, unknown> | undefined;
    const id = project?.id;
    if (typeof id !== 'string') {
      throw new LinearApiError('CreateProject', 200, 'projectCreate did not return a project id');
    }
    return { id };
  }

  async getProject(id: string): Promise<LinearProject> {
    const { data } = await this.gql('GetProject', GET_PROJECT_QUERY, { id });
    const node = data.project as Record<string, unknown> | null | undefined;
    if (!node) {
      // A domain 404 (HTTP 200, null node) — not a wire failure, the same shape
      // `resolveIssue` reports for an identifier that does not resolve.
      throw new Error(`Linear project not found: ${id}`);
    }
    return toLinearProject(node);
  }

  async listProjects(): Promise<LinearProject[]> {
    await this.ensureCatalog();
    const out: LinearProject[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListTeamProjects', LIST_TEAM_PROJECTS_QUERY, {
        teamId: this.teamId,
        // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50
        // ("The first 50 results are returned by default without query arguments",
        // linear.app/developers/pagination, re-read 2026-08-15; no maximum stated).
        // Deliberate: this loop drains the cursor to exhaustion, so the page size
        // changes only the round-trip count of a full read, never its result set.
        first: 100,
        after,
      });
      const team = (data.team ?? {}) as Record<string, unknown>;
      const connection = (team.projects ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      for (const raw of nodes) out.push(toLinearProject(raw));
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor — stop rather than loop forever
    }
    return out;
  }

  async setIssueProject(identifier: string, projectId: string): Promise<void> {
    const node = await this.resolveIssue(identifier); // throws on an unknown issue
    await this.updateIssue(node.uuid, { projectId });
  }

  async listProjectIssues(projectId: string): Promise<LinearIssue[]> {
    // Resolve the project FIRST so an unknown id fails as "no such goal" rather
    // than reading back as "a goal with no members" — absent and empty are
    // different claims, the same line the create classifier draws.
    await this.getProject(projectId);
    const out: LinearIssue[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListProjectIssues', LIST_PROJECT_ISSUES_QUERY, {
        id: projectId,
        // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50
        // ("The first 50 results are returned by default without query arguments",
        // linear.app/developers/pagination, re-read 2026-08-15; no maximum stated).
        // Deliberate: this loop drains the cursor to exhaustion, so the page size
        // changes only the round-trip count of a full read, never its result set.
        first: 100,
        after,
      });
      const project = (data.project ?? {}) as Record<string, unknown>;
      const connection = (project.issues ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      // NO state filter here, unlike listOpenIssues — closed members are the
      // frontier's `done` readings.
      for (const raw of nodes) out.push(toLinearIssue(toResolvedIssueNode(raw)));
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor
    }
    return out;
  }

  // ── Goal facet (ADR-0045): initiatives, and native project dependencies ────

  async createInitiative(input: { name: string; description: string }): Promise<{ id: string }> {
    // NO `ensureCatalog()` here, and the omission is the decision:
    // `InitiativeCreateInput` carries no team field at all, because initiatives
    // live above teams. `createProject` calls it precisely because
    // `ProjectCreateInput.teamIds` is required — the asymmetry is the schema's.
    const { data } = await this.gql('CreateInitiative', CREATE_INITIATIVE_MUTATION, {
      input: { name: input.name, description: input.description },
    });
    const payload = data.initiativeCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError('CreateInitiative', 200, 'initiativeCreate did not report success');
    }
    const initiative = payload.initiative as Record<string, unknown> | undefined;
    const id = initiative?.id;
    if (typeof id !== 'string') {
      throw new LinearApiError('CreateInitiative', 200, 'initiativeCreate did not return an initiative id');
    }
    return { id };
  }

  async getInitiative(id: string): Promise<LinearInitiative> {
    const { data } = await this.gql('GetInitiative', GET_INITIATIVE_QUERY, { id });
    const node = data.initiative as Record<string, unknown> | null | undefined;
    if (!node) {
      // A domain 404 (HTTP 200, null node), mirroring `getProject`.
      throw new Error(`Linear initiative not found: ${id}`);
    }
    return toLinearInitiative(node);
  }

  async listInitiatives(): Promise<LinearInitiative[]> {
    // Workspace-wide, deliberately — the ROOT connection rather than any team
    // one, because initiatives span teams (ADR-0045 decision 5). No
    // `ensureCatalog()`: there is no team id to resolve for this read.
    const out: LinearInitiative[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListInitiatives', LIST_INITIATIVES_QUERY, {
        // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50
        // ("The first 50 results are returned by default without query arguments",
        // linear.app/developers/pagination, re-read 2026-08-15; no maximum stated).
        // Deliberate, and the same call this adapter's four other paged reads make:
        // the loop drains the cursor to exhaustion, so the page size changes only
        // the round-trip count of a full read, never its result set.
        first: 100,
        after,
      });
      const connection = (data.initiatives ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      for (const raw of nodes) out.push(toLinearInitiative(raw));
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor
    }
    return out;
  }

  async listInitiativeProjects(initiativeId: string): Promise<LinearProject[]> {
    // Resolve the initiative FIRST so an unknown id fails as "no such goal"
    // rather than reading back as "a goal with no members" — the same line
    // `listProjectIssues` draws one container down.
    await this.getInitiative(initiativeId);
    const out: LinearProject[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql('ListInitiativeProjects', LIST_INITIATIVE_PROJECTS_QUERY, {
        id: initiativeId,
        // ACCEPTED DIVERGENCE — page size 100 where the vendor documents 50; see
        // `listInitiatives` above for the full reasoning.
        first: 100,
        after,
      });
      const initiative = (data.initiative ?? {}) as Record<string, unknown>;
      const connection = (initiative.projects ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      // NO status filter: an EMPTY or a COMPLETED member project is still a
      // member, and dropping either would report a goal complete over work that
      // was never built (the falsification ADR-0045 rests on).
      for (const raw of nodes) out.push(toLinearProject(raw));
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor
    }
    return out;
  }

  async addProjectToInitiative(initiativeId: string, projectId: string): Promise<void> {
    // Find-before-create, because this membership is a JOIN ENTITY rather than a
    // pointer: `initiativeToProjectCreate` called twice would mint two rows,
    // where `setIssueProject` called twice writes the same field. The facet
    // documents `assignToGoal` as idempotent, so the idempotence has to be
    // bought here rather than inherited.
    const existing = await this.listInitiativeProjects(initiativeId); // throws on an unknown initiative
    if (existing.some((p) => p.id === projectId)) return;
    await this.getProject(projectId); // throws on an unknown project
    const { data } = await this.gql(
      'CreateInitiativeToProject',
      CREATE_INITIATIVE_TO_PROJECT_MUTATION,
      { input: { initiativeId, projectId } },
    );
    const payload = data.initiativeToProjectCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError(
        'CreateInitiativeToProject',
        200,
        'initiativeToProjectCreate did not report success',
      );
    }
  }

  async getProjectBlockedBy(projectId: string): Promise<string[]> {
    await this.getProject(projectId); // throws on an unknown project
    const out: string[] = [];
    let after: string | undefined;
    for (;;) {
      const { data } = await this.gql(
        'ListProjectInverseRelations',
        LIST_PROJECT_INVERSE_RELATIONS_QUERY,
        { id: projectId, first: 100, after },
      );
      const project = (data.project ?? {}) as Record<string, unknown>;
      const connection = (project.inverseRelations ?? {}) as Record<string, unknown>;
      const nodes = (connection.nodes ?? []) as Record<string, unknown>[];
      for (const raw of nodes) {
        // Keep ONLY blocking relations: `related` and any other free-form type
        // are not dependencies, and a frontier that read them as blockers would
        // report `blocked` over a merely-adjacent project. Same filter the issue
        // arm's `toBlockedByIdentifiers` applies, on the same constant.
        if (raw.type !== PROJECT_BLOCKS_RELATION_TYPE) continue;
        const source = (raw.project ?? {}) as Record<string, unknown>;
        if (typeof source.id === 'string') out.push(source.id);
      }
      const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
      if (pageInfo.hasNextPage !== true) break;
      after = typeof pageInfo.endCursor === 'string' ? pageInfo.endCursor : undefined;
      if (!after) break; // defensive: hasNextPage=true but no cursor
    }
    return out;
  }

  async addProjectBlockedBy(
    blockedProjectId: string,
    blockerProjectId: string,
  ): Promise<void> {
    // Both sides resolved first, so an unknown project fails as a domain 404
    // rather than as a GraphQL rejection nobody can read.
    await this.getProject(blockedProjectId);
    await this.getProject(blockerProjectId);
    const { data } = await this.gql('CreateProjectRelation', CREATE_PROJECT_RELATION_MUTATION, {
      // `projectId` = the BLOCKER (the source that "blocks"), `relatedProjectId`
      // = the BLOCKED project — the exact inverse `getProjectBlockedBy` reads
      // back, which is why that read goes through `inverseRelations`. Same
      // direction the issue arm's `addBlockedBy` writes.
      //
      // The two milestone ids are deliberately never sent: the facet anchors at
      // whole-project granularity, which the anchor pair below declares — and
      // which the live read-back confirmed as `projectMilestone: null`.
      input: {
        projectId: blockerProjectId,
        relatedProjectId: blockedProjectId,
        type: PROJECT_BLOCKS_RELATION_TYPE,
        // SPREAD WHOLESALE, never field-by-field. The anchor is asymmetric —
        // finish-to-start, the blocker's `end` onto the blocked project's
        // `start` — and the fragment's own keys are the wire field names, so
        // there is no step here at which the two ends could be swapped. A
        // swapped pair would be SILENT: both are valid enum members in valid
        // fields, so Linear would happily record a backwards dependency.
        ...PROJECT_RELATION_ANCHOR_PAIR,
      },
    });
    const payload = data.projectRelationCreate as Record<string, unknown> | undefined;
    if (payload?.success !== true) {
      throw new LinearApiError(
        'CreateProjectRelation',
        200,
        'projectRelationCreate did not report success',
      );
    }
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
    // `updatedAt` is declared on Linear's own `Issue` type as `DateTime!` —
    // "the last time at which the entity was meaningfully updated. This is the
    // same as the creation time if the entity hasn't been updated after
    // creation" — and the `DateTime` scalar is documented as ISO 8601 (Linear's
    // published GraphQL schema, read 2026-08-09). Both issue queries above ask
    // for it, and the value is carried through VERBATIM rather than reformatted.
    //
    // e2e-verify — UNPROVEN in this slice (hermetic specs only, no live probe;
    // ADR-0030's declared-unexecutable path). The schema declares it
    // non-nullable, so a live read should always carry it; this narrowing is
    // deliberately tolerant anyway, matching how every other field here is read
    // — and the tolerant branch is the SAFE one, since an absent instant defers
    // the DoR staleness advisory instead of passing it.
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.length > 0 ? raw.updatedAt : undefined,
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
    ...(node.updatedAt !== undefined ? { updatedAt: node.updatedAt } : {}),
  };
}

/**
 * Narrow one raw Project node (ADR-0044). `Project.description` is `String!` in
 * the published schema — non-null — but it is narrowed defensively anyway, the
 * same way every other projection in this file narrows: a partial/aliased
 * selection or a schema move must degrade to empty prose, never to the literal
 * `"undefined"` a bare cast would produce.
 */
function toLinearProject(raw: Record<string, unknown>): LinearProject {
  const status = (raw.status ?? {}) as Record<string, unknown>;
  const statusType = toProjectStatusType(status.type);
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    statusType,
    // …and when that narrowing SUBSTITUTED, say so, carrying what the vendor
    // actually said. The narrowing itself is unchanged and stays right for what
    // it is for (classification, safe direction); this is the second reading it
    // cannot serve — a caller REPORTING a live native fact must never be handed
    // `backlog` for a category the vendor never stated. The conditional spread
    // is the contract: an absent KEY, not a key set to `undefined`, so a
    // recognized category leaves the projection byte-identical to what it was
    // before this field existed.
    ...vendorStatusTypeIfSubstituted(status.type, statusType),
  };
}

/**
 * The disclosure half of {@link toProjectStatusType}: `{ unreadStatusType }` when
 * that narrowing substituted, `{}` when it did not.
 *
 * Deliberately derived from the NARROWING'S OWN RESULT rather than from a second,
 * independent membership test — `statusType !== raw` is true exactly when the
 * substitution happened, whatever the vocabulary grows to, so the disclosure
 * cannot drift out of step with the thing it discloses. The two cases it
 * distinguishes are genuinely different facts and are reported differently: the
 * vendor stated a category this adapter does not know (carry the word verbatim —
 * it is an opaque `GoalMemberNativeState` downstream, compared against nothing),
 * or the response carried no category at all (`null`: there is no vendor word to
 * report, and inventing one is the failure this whole field exists to prevent).
 */
function vendorStatusTypeIfSubstituted(
  raw: unknown,
  narrowed: LinearProjectStatusType,
): { unreadStatusType?: string | null } {
  if (typeof raw === 'string') return raw === narrowed ? {} : { unreadStatusType: raw };
  return { unreadStatusType: null };
}

/**
 * The six `ProjectStatusType` categories, as data — the membership test
 * {@link toProjectStatusType} applies (published schema, read 2026-08-15).
 */
const PROJECT_STATUS_TYPES: readonly LinearProjectStatusType[] = [
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
];

/**
 * Narrow a raw `ProjectStatus.type` to the fixed category union.
 *
 * An unrecognized value falls back to `backlog` — the same defensive stance
 * {@link toStateType} takes for issues, and the safe direction here: `backlog`
 * is neither closed nor claimed nor eligible, so a category this adapter cannot
 * read makes the member read `unready` rather than counterfeiting the positive
 * claim `actionable` or the terminal claim `done`. Absent evidence must never
 * clear a member (the `closed-unknown` discipline, on the frontier side).
 *
 * That justification is about CLASSIFICATION and remains exactly true — this
 * function is deliberately unchanged. What it does NOT justify is REPORTING the
 * substitute to a caller as the member's live native state, which is what
 * {@link vendorStatusTypeIfSubstituted} exists to prevent: the fallback is
 * disclosed beside the value, never silently indistinguishable from a real
 * `backlog`.
 */
function toProjectStatusType(raw: unknown): LinearProjectStatusType {
  return typeof raw === 'string' &&
    (PROJECT_STATUS_TYPES as readonly string[]).includes(raw)
    ? (raw as LinearProjectStatusType)
    : 'backlog';
}

/** Narrow one raw Initiative node (ADR-0045) — same defensive narrowing as {@link toLinearProject}. */
function toLinearInitiative(raw: Record<string, unknown>): LinearInitiative {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : '',
    description: typeof raw.description === 'string' ? raw.description : '',
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
