/**
 * linear-api.ts — the injectable DOMAIN seam LinearIssuesStore talks to (ADR-0020).
 *
 * The Linear parallel of {@link ../github/github-api.GitHubApi}: an issue-shaped
 * domain seam, NOT a raw HTTP seam, so the conformance fake is a small in-memory
 * state machine rather than canned GraphQL routes. The store speaks
 * issue-operations; the seam hides Linear's UUIDs, team binding, and workflow
 * plumbing. The real impl (M2) is raw `fetch` GraphQL behind a `LinearHttp`
 * seam (`LINEAR_API_KEY`) — simpler than GitHub's since Linear has no REST branch.
 *
 * Two Linear-specific shapes that shape the mapping (ADR-0020):
 *   - the **claim ledger is the workflow state** ({@link LinearIssue.stateName}),
 *     not a label — the board is the live wave dashboard humans watch;
 *   - `done` derives from the state's fixed **category** ({@link LinearStateType})
 *     `completed`/`canceled`, and the closing probe reads the GitHub-integration
 *     PR attachments ({@link LinearPrAttachment}) rather than cross-calling GitHub.
 */

/**
 * Linear's fixed category for a workflow state (drives the `done` derivation).
 * SEVEN values — `duplicate` is a distinct live category (verified against a
 * live workspace at the 2026-07-15 e2e gate; the first run died on it), not a
 * `canceled` alias. It joins `completed`/`canceled` in the closed set.
 */
export type LinearStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled'
  | 'duplicate';

/** The raw Linear issue substrate the store projects onto an IssueView. */
export interface LinearIssue {
  /** Human team key, e.g. "EX-16" — the store's opaque id (ADR-0001/0020). */
  identifier: string;
  title: string;
  /** Markdown description — the body-codec home. */
  description: string;
  /** Label names (eligibility token(s) + risk/<x> + worker/<x> + triage vocab + wave/needs-attention). */
  labels: string[];
  /** Workflow state NAME, e.g. "Todo" — the claim ledger (ADR-0020). */
  stateName: string;
  /** Linear's fixed category for the state — the done derivation input. */
  stateType: LinearStateType;
  /**
   * Linear's own `updatedAt` on the Issue node — an ISO-8601 instant, the
   * substrate for `IssueView.trackerUpdatedAt` (the DoR staleness advisory's
   * `since`). OPTIONAL on this seam so a hand-built `LinearIssue` in a spec
   * stays valid; the store projects absence straight through as absence, and
   * the advisory then `defer`s rather than falsely passing.
   */
  updatedAt?: string;
}

export interface LinearCreateIssueInput {
  title: string;
  description: string;
  labels: string[];
}

/** A GitHub-integration PR attachment (the closing probe substrate, ADR-0020). */
export interface LinearPrAttachment {
  url: string;
  merged: boolean;
}

/**
 * Linear's fixed category for a PROJECT status — `ProjectStatusType` in the
 * published GraphQL schema (`linear/linear` → `packages/sdk/src/schema.graphql`,
 * read 2026-08-15, this dispatch). SIX values, and the two that matter to the
 * facet map onto the frontier exactly as an issue's terminal categories do
 * (ADR-0045 decision 2): `completed`/`canceled` are the closed set, and
 * `started`/`paused` are the claimed set.
 *
 * `paused` deliberately reads as claimed rather than blocked: `blocked` asserts
 * a NAMED unresolved dependency, which a paused project lacks.
 */
export type LinearProjectStatusType =
  | 'backlog'
  | 'planned'
  | 'started'
  | 'paused'
  | 'completed'
  | 'canceled';

/**
 * The raw Linear **project** substrate. Under a `project` binding a project IS
 * the Goal container (ADR-0044 decision 4); under an `initiative` binding it is
 * a goal MEMBER instead (ADR-0045 decision 1). Same node, two roles, one shape.
 *
 * There is no default binding on Linear, deliberately: one shipped consumer runs
 * Initiative=Epic / Project=User Story (motivated by Linear's timeline and
 * health views living at project/initiative level, not on issues), while
 * ADR-0017 once sketched "Wave ≈ Linear Project". Both conventions are live, so
 * any built-in choice here would silently overwrite somebody's meaning — hence
 * `store.goal.container` is explicit on this store and a goal verb without it
 * refuses loudly.
 *
 * `id` is Linear's project UUID and IS the store's opaque goal-or-member id
 * (ADR-0001) — the one place a Linear UUID legitimately crosses this seam,
 * because a project has no human `<TEAM>-<n>` identifier the way an issue does.
 */
export interface LinearProject {
  id: string;
  name: string;
  /** Free prose; the empty string when the project carries none. */
  description: string;
  /**
   * The project status's fixed CATEGORY — the frontier's `closed`/`claimed`
   * substrate when this project is a goal member (ADR-0045 decision 2). The
   * status NAME is consumer-customizable and therefore unreadable as a rule;
   * the category is the fixed vocabulary, exactly as {@link LinearStateType} is
   * for issues.
   */
  statusType: LinearProjectStatusType;
}

/**
 * The raw Linear **initiative** substrate — the Goal facet's second native
 * container on this store (ADR-0045). An initiative holds PROJECTS, not issues,
 * which is why binding one changes the member kind of every goal verb.
 *
 * Initiatives live ABOVE teams (the recorded consumer's own span Design and
 * Dev), which is why {@link LinearApi.listInitiatives} is workspace-wide where
 * {@link LinearApi.listProjects} is team-scoped — a team filter here would
 * silently hide cross-team finish lines (ADR-0045 decision 5).
 */
export interface LinearInitiative {
  id: string;
  name: string;
  /** Free prose; the empty string when the initiative carries none. */
  description: string;
}

export interface LinearApi {
  /** Create an issue; return the server-assigned human identifier. */
  createIssue(input: LinearCreateIssueInput): Promise<{ identifier: string }>;
  /** Fetch one issue; throws on an unknown identifier. */
  getIssue(identifier: string): Promise<LinearIssue>;
  /** Open = stateType ∉ {completed, canceled}; scoped to the construction-time team (+ project filter when bound). */
  listOpenIssues(): Promise<LinearIssue[]>;
  /** Replace the markdown description (cosmetic AC tick + the `**Closed-by:**` line). */
  setDescription(identifier: string, description: string): Promise<void>;
  /** Replace the issue title (the Amend facet, ADR-0025). Real impl: `issueUpdate` `title`. Throws on an unknown identifier. */
  setTitle(identifier: string, title: string): Promise<void>;
  /** Add a label (idempotent; impl auto-creates missing labels). */
  addLabel(identifier: string, label: string): Promise<void>;
  /** Remove a label (idempotent — no-op if absent). */
  removeLabel(identifier: string, label: string): Promise<void>;
  /** Append a comment (NOT idempotent — each call adds one). Throws on an unknown identifier. */
  addComment(identifier: string, body: string): Promise<void>;
  /** All comments on an issue, oldest-first. Throws on an unknown identifier. */
  getComments(identifier: string): Promise<{ body: string }[]>;
  /** Set the workflow state by NAME (the impl resolves the team's state id). Throws on unknown state name. */
  setState(identifier: string, stateName: string): Promise<void>;
  /**
   * PR attachments from the GitHub integration (closing probe). Deliberately
   * NEVER includes cards minted by {@link upsertAttachment}: those carry no
   * `sourceType: 'github'` (Linear derives `sourceType` from integration
   * `source` metadata this adapter never sets), so the two attachment kinds
   * coexist on the same issue without either read confusing the other.
   */
  getPrAttachments(identifier: string): Promise<LinearPrAttachment[]>;
  /**
   * Identifiers of issues NATIVELY blocking this one, via Linear's own
   * blocked-by relation (ADR-0020 DoR-gate fix) — orthogonal to the
   * body-codec `**Blocked by:**` line. `read()` unions both. The mirroring
   * *write* half is {@link addBlockedBy} (ADR-0020 fast-follow).
   */
  getBlockedBy(identifier: string): Promise<string[]>;
  /**
   * Mirror ONE body-codec blockedBy ref into a NATIVE Linear issue relation
   * (ADR-0020 fast-follow, the write half of {@link getBlockedBy}): record that
   * `blockerIdentifier` **blocks** `blockedIdentifier` — so from
   * `blockedIdentifier`'s OWN perspective it is *blocked-by* `blockerIdentifier`
   * (the asymmetric-blockedBy direction fixed in the Linear-adapter grill). The
   * read union then surfaces `blockerIdentifier` in `blockedIdentifier`'s
   * blockedBy, giving humans a visible relation on the Linear board.
   *
   * ADDITIVE-ONLY by contract: this ONLY ever creates a relation. It never
   * deletes or updates one, so a human-drawn relation survives any re-scope and
   * a stale mirror is harmless (the read-union's ownSlug-normalized dedup
   * tolerates double representation). The body codec stays the canonical,
   * store-agnostic home of blockedBy — this is a redundant board-visibility
   * mirror, never the source of truth.
   *
   * Throws on an unresolvable identifier (either side) or a transport/GraphQL
   * failure. The caller ({@link LinearIssuesStore}) treats a throw as a
   * best-effort mirror skip: the authoritative body-codec write already
   * happened, so a failed native mirror is logged/disclosed, never fatal.
   */
  addBlockedBy(blockedIdentifier: string, blockerIdentifier: string): Promise<void>;
  /**
   * Upsert a native attachment card on the issue, keyed by `input.url` (issue
   * #511, mechanics proven consumer-side): a repeated call with the SAME url
   * updates the existing card's `title`/`subtitle` rather than creating a
   * duplicate — the idempotency rides Linear's OWN upsert-by-url semantics on
   * `attachmentCreate`, not a find-before-create this adapter has to
   * implement. Used by {@link ../linear-issues-store.LinearIssuesStore.close}
   * to give the closing PR a visible card in the issue's attachment section
   * (next to the body-codec `Closed-by:` line), independent of the
   * GitHub-integration-only {@link getPrAttachments} substrate the closing
   * probe reads — see that method's own doc for why the two never overlap.
   */
  upsertAttachment(
    identifier: string,
    input: {
      /**
       * Linear's own identity key for the card ("also used as an unique
       * identifier for the attachment" — `AttachmentCreateInput.url`'s
       * published schema doc): the SAME url on a later call updates
       * `title`/`subtitle` in place rather than minting a duplicate.
       */
      url: string;
      title: string;
      subtitle: string;
    },
  ): Promise<void>;
  /**
   * Whether the workspace has the GitHub integration installed — the substrate
   * the closing probe ({@link getPrAttachments}) depends on. Without it a
   * merged PR never creates the attachment `readClosing` reads, so a linear
   * wave's rows never resolve to `done` (ADR-0020). The store-preflight (FOR-12)
   * surfaces this at wave-setup so a missing integration fails LOUDLY there
   * rather than silently stalling every row at `in-review` mid-wave. Real impl:
   * query the workspace integrations; the in-memory fake holds an explicit flag.
   */
  hasGitHubIntegration(): Promise<boolean>;
  /**
   * The team's full workflow-state catalog (name → fixed category). The
   * store-preflight verifies every configured claim-ledger state name
   * (`queued`/`inFlight`/`inReview` + `unclaimTarget`/`unplanned` + an optional
   * `doneState`) resolves to a real state here — a fresh workspace missing e.g.
   * "In Review" fails LOUDLY at setup instead of throwing on the first
   * `setState` mid-wave (FOR-12). Real impl exposes the cached `team.states`.
   */
  listStates(): Promise<{ name: string; type: LinearStateType }[]>;
  // Document facet substrate (ADR-0017) — native Documents, categorically not issues:
  /**
   * Create a native Document under the ONE parent the api is bound to: the
   * configured `project` when one is bound, else the configured `team`
   * (ADR-0017 amendment — the facet needs no project binding, and a
   * team-attached Document is Linear's own native shape). Never an orphan:
   * `team` is required config, so there is always a parent.
   */
  createDocument(input: { title: string; content: string }): Promise<{ id: string }>;
  /** Fetch a native Document; throws on an unknown id. Never scope-filtered — an id the caller already holds resolves. */
  getDocument(id: string): Promise<{ id: string; title: string; content: string }>;
  /**
   * The Documents in the api's own scope — the bound `project`'s when one is
   * bound, else the configured `team`'s (ADR-0017 amendment). Never
   * workspace-wide: a PRD panel showing every team's documents is not this
   * consumer's panel.
   */
  listDocuments(): Promise<{ id: string; title: string; content: string }[]>;

  // ── Goal facet substrate (ADR-0044) — projects ───────────────────────────
  //
  // Four reads and one write, mirroring the GitHub milestone half. No project
  // CLOSE/archive verb is declared: the facet has no `closeGoal`, so one would
  // be unreachable surface — the same reasoning that keeps the documented
  // relation-DELETE off {@link addBlockedBy}'s side of this seam.

  /**
   * Mint a project under the api's configured TEAM and return its id (the
   * store's opaque goal id, ADR-0001). Real impl: `projectCreate(input:
   * ProjectCreateInput!)` → `ProjectPayload { success, project { id } }`.
   * `ProjectCreateInput` requires `name: String!` and `teamIds: [String!]!`
   * (Linear's published GraphQL schema, read 2026-08-15) — so a project is
   * never an orphan here, exactly as `createDocument` is never one.
   */
  createProject(input: { name: string; description: string }): Promise<{ id: string }>;

  /**
   * Fetch one project; throws on an unknown id. Real impl: `project(id: String!):
   * Project!`. Never scope-filtered — an id the caller already holds resolves.
   */
  getProject(id: string): Promise<LinearProject>;

  /**
   * The projects in the api's own TEAM scope — never workspace-wide, the same
   * stance {@link listDocuments} takes and for the same reason: a goal panel
   * showing every team's finish lines is not this consumer's panel.
   */
  listProjects(): Promise<LinearProject[]>;

  /**
   * Join an issue to a project — the curation write. Real impl: `issueUpdate(id,
   * input: { projectId })`; `IssueUpdateInput.projectId: String` is the
   * documented field. Idempotent by nature (a single pointer on the issue).
   *
   * Deliberately no un-assign path (`projectId: null` would be the shape):
   * curation joins members, and removing one is a human act in the tracker —
   * the additive-only stance {@link addBlockedBy} already takes.
   */
  setIssueProject(identifier: string, projectId: string): Promise<void>;

  /**
   * Every issue in a project, OPEN AND CLOSED. Under a `project` binding this is
   * the frontier's member list; under an `initiative` binding it is the
   * per-MEMBER fact source (which of a member project's issues are claimed,
   * which carry the eligibility marker). Real impl: the `Project.issues`
   * connection, paged to exhaustion.
   *
   * Unlike {@link listOpenIssues} this one must NOT filter by state: `done` is
   * one of the five frontier readings, so dropping closed members would report a
   * finished goal as an empty one. Throws on an unknown project id.
   */
  listProjectIssues(projectId: string): Promise<LinearIssue[]>;

  // ── Goal facet substrate (ADR-0045) — initiatives, and project relations ───
  //
  // The initiative half mirrors the project half one container up: mint, read,
  // list, and the membership join. No initiative CLOSE/archive verb, for the
  // reason the project half declares none — the facet has no `closeGoal`, so one
  // would be unreachable surface.

  /**
   * Mint an initiative and return its id (the store's opaque goal id,
   * ADR-0001). Real impl: `initiativeCreate(input: InitiativeCreateInput!):
   * InitiativePayload!`; `InitiativeCreateInput` requires exactly `name:
   * String!` and takes an optional `description: String` (Linear's published
   * GraphQL schema, read 2026-08-15, this dispatch).
   *
   * NOTE the deliberate asymmetry with {@link createProject}: an initiative
   * takes NO team, because initiatives live above teams. That is the same fact
   * {@link listInitiatives}'s workspace scope rests on.
   */
  createInitiative(input: { name: string; description: string }): Promise<{ id: string }>;

  /**
   * Fetch one initiative; throws on an unknown id. Real impl: `initiative(id:
   * String!): Initiative!`. Never scope-filtered — an id the caller already
   * holds resolves.
   */
  getInitiative(id: string): Promise<LinearInitiative>;

  /**
   * Every initiative in the WORKSPACE — deliberately not team-scoped, the
   * documented divergence from {@link listProjects} (ADR-0045 decision 5).
   * Initiatives span teams, so a team filter would silently hide cross-team
   * finish lines; the width costs nothing because `listGoals` is sight, never
   * the wave candidate set. Real impl: the root `initiatives(...)` connection,
   * paged to exhaustion.
   */
  listInitiatives(): Promise<LinearInitiative[]>;

  /**
   * An initiative's **DIRECT** member projects — the goal's membership under an
   * `initiative` binding. Real impl: the `Initiative.projects` connection with
   * `includeSubInitiatives: false`.
   *
   * That flag is load-bearing and its DEFAULT IS THE WRONG ANSWER HERE: Linear
   * documents `Initiative.projects(includeSubInitiatives:)` as "Defaults to
   * true" (published schema, read 2026-08-15, this dispatch), so leaving it off
   * would silently return a sub-initiative's projects as this goal's own
   * members — exactly the flattening ADR-0045 decision 1 rejects, arriving
   * through a default rather than through a query anyone wrote.
   *
   * Throws on an unknown initiative id, so an unknown goal fails as "no such
   * goal" rather than reading back as "a goal with no members".
   */
  listInitiativeProjects(initiativeId: string): Promise<LinearProject[]>;

  /**
   * Join a project to an initiative — the curation write one container up. Real
   * impl: `initiativeToProjectCreate(input: InitiativeToProjectCreateInput!)`,
   * whose input requires `initiativeId: String!` and `projectId: String!`
   * (published schema, read 2026-08-15, this dispatch).
   *
   * Membership is a JOIN ENTITY here, not a pointer on the project the way
   * {@link setIssueProject} is — so unlike that verb it is not idempotent by
   * nature, and the impl must find-before-create to keep the facet's documented
   * idempotence. Deliberately no leave path, the additive-only stance
   * {@link addBlockedBy} already takes.
   */
  addProjectToInitiative(initiativeId: string, projectId: string): Promise<void>;

  /**
   * The ids of projects NATIVELY blocking this one — the frontier's blocker
   * substrate at PROJECT granularity, and the read half of
   * {@link addProjectBlockedBy}. Real impl: the `Project.inverseRelations`
   * connection, keeping nodes whose `type` is {@link PROJECT_BLOCKS_RELATION_TYPE}
   * and reporting each node's source `project.id`.
   *
   * The direction mirrors the issue arm exactly: a relation "A blocks B"
   * surfaces on B as an INVERSE relation, so B's blocked-by list is read from
   * `inverseRelations` and never from `relations`.
   */
  getProjectBlockedBy(projectId: string): Promise<string[]>;

  /**
   * Draw ONE native project dependency: record that `blockerProjectId` **blocks**
   * `blockedProjectId`, so from the blocked project's own perspective it is
   * blocked-by the blocker (ADR-0045 decision 4 — the dependencies are the
   * feature, because Linear's timeline view renders them at exactly this
   * granularity). Real impl: `projectRelationCreate(input:
   * ProjectRelationCreateInput!)`.
   *
   * ADDITIVE-ONLY by contract, the same stance {@link addBlockedBy} takes: this
   * only ever creates a relation, never deletes or updates one, so a
   * human-drawn dependency survives.
   *
   * Throws on an unresolvable project id (either side) or a transport/GraphQL
   * failure. Unlike the issue mirror — which is best-effort because the body
   * codec already recorded the edge authoritatively — a caller of THIS verb has
   * no second representation to fall back on, so `createGoalMember` surfaces a
   * failure loudly rather than swallowing it.
   */
  addProjectBlockedBy(blockedProjectId: string, blockerProjectId: string): Promise<void>;
}

/**
 * The `ProjectRelation.type` value for a blocking project dependency, and the
 * `anchorType`/`relatedAnchorType` values that anchor it to the projects
 * themselves rather than to a milestone inside them.
 *
 * ── READ-STAMP (ADR-0030 declared-unexecutable-path comparison) ──────────────
 *
 * **What IS evidenced**, read verbatim in this dispatch from Linear's published
 * GraphQL schema (`linear/linear` → `packages/sdk/src/schema.graphql`, read
 * 2026-08-15) — the same source and the same standard as `projectCreate`'s
 * pinning one facet over:
 *
 *  - `projectRelationCreate(input: ProjectRelationCreateInput!):
 *    ProjectRelationPayload!`, payload `{ lastSyncId, projectRelation, success }`
 *    — so the success check matches every other mutation in this adapter.
 *  - `ProjectRelationCreateInput` requires FIVE fields: `anchorType: String!`,
 *    `projectId: String!`, `relatedAnchorType: String!`,
 *    `relatedProjectId: String!`, `type: String!`. The two milestone ids are
 *    optional and are deliberately never sent — the facet anchors at project
 *    granularity.
 *  - `ProjectRelation.type` is documented as "The type of dependency
 *    relationship from the project to the related project (**e.g., blocks**)" —
 *    the vendor's own example, and the same literal the ISSUE arm already pins
 *    as `IssueRelationType.blocks`.
 *  - Corroboration that `blocks` is the CURRENT spelling rather than a legacy
 *    one: `ProjectFilter.hasBlockedByRelations` ("projects which are blocked")
 *    and `hasBlockingRelations` ("projects which are blocking") carry no
 *    deprecation, while the `hasDependsOnRelations`/`hasDependedOnByRelations`
 *    pair is marked `[Deprecated]`.
 *  - `anchorType` is documented as "The type of anchor on the source project
 *    end of the relation, indicating whether it is anchored to the project
 *    itself or a specific milestone", with `ProjectRelation.projectMilestone`
 *    "Null if the relation applies to the project as a whole".
 *
 * **What is NOT evidenced, and this is the honest gap.** All three of these are
 * typed as free `String` in the schema, not as enums, so the schema pins their
 * SHAPE and not their VALUES. ADR-0045 decision 4 asks for the values to be
 * confirmed by creating one dependency by hand in the Linear UI and reading it
 * back through `Project.relations`/`inverseRelations`. That read-back is a
 * HUMAN act in the tracker plus a live Linear credential, and this row is a
 * worktree-isolated engine slice with neither — so the values below are pinned
 * from the documentation above and are STILL UNPROVEN LIVE, exactly as
 * `BLOCKS_RELATION_TYPE` and `CREATE_ISSUE_RELATION_MUTATION` were when the
 * issue arm shipped. `anchorType`'s value is the weakest of the three: it is an
 * inference from the field's own prose ("anchored to the project itself"), not
 * a quoted example.
 *
 * The read-back is therefore the FIRST live `goal` run on an initiative-bound
 * consumer, and the failure mode is loud rather than silent: a rejected `type`
 * or `anchorType` comes back as a GraphQL error from
 * {@link LinearApi.addProjectBlockedBy}, which `createGoalMember` surfaces as a
 * typed failure naming the minted member. Flip these to VERIFIED there.
 *
 * Exported so a consumer whose workspace answers differently can see exactly
 * which three strings to report — and so the spec suite pins all three in one
 * place instead of three inline literals.
 */
export const PROJECT_BLOCKS_RELATION_TYPE = 'blocks';

/** The `anchorType`/`relatedAnchorType` value for a whole-project anchor — see {@link PROJECT_BLOCKS_RELATION_TYPE}'s read-stamp. */
export const PROJECT_RELATION_ANCHOR_TYPE = 'project';
