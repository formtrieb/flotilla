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
   *
   * **A CLASSIFICATION substrate, and it is allowed to be a SUBSTITUTE.** A
   * producer that meets a category outside the six above narrows it to the
   * safe-direction default rather than failing the read — see
   * {@link unreadStatusType}, which is how a consumer tells a substitute from
   * the vendor's own word. Anything that merely CLASSIFIES may read this field
   * directly; anything that REPORTS a native fact to a human must not.
   */
  statusType: LinearProjectStatusType;
  /**
   * Present **exactly when {@link statusType} is a SUBSTITUTE** — the narrowing's
   * classification-safe default standing in for a category the producer could
   * not read. Its value is what the vendor actually *said*: a category outside
   * the six ({@link LinearProjectStatusType} is a snapshot of a VENDOR
   * vocabulary, and a seventh value is a matter of when, not whether), or `null`
   * when the response carried no category at all.
   *
   * **Absent — the ordinary case, and the one every honest producer is in for
   * every real project — means {@link statusType} IS the vendor's own word.**
   * That asymmetry is deliberate: a producer that never substitutes (the
   * in-memory fake, whose statuses are drawn from the union by construction)
   * states nothing here and is automatically correct, while the one act that
   * needs disclosing — substituting — is the one act that has to say so.
   *
   * **Why this field exists at all: the two readings of a status category pulled
   * apart.** Narrowing an unknown category to `backlog` is right for
   * CLASSIFICATION — a category the adapter cannot read must make a member read
   * `unready`, never counterfeit the positive claim `actionable` or the terminal
   * claim `done`. It is wrong for REPORTING: a goal member's frontier reading
   * now carries its live native state out to a caller (`GoalMemberReading`), and
   * a substituted `backlog` would surface there as a native fact **the vendor
   * never stated**, through the very field added to make native facts honest.
   * One field cannot serve both readings, so there are two — and the honest
   * report is reconstructed as "the vendor's own word, or nothing."
   */
  unreadStatusType?: string | null;
  /**
   * The project's own health — `onTrack` / `atRisk` / `offTrack`, or ABSENT when
   * the project has none.
   *
   * ── What this field actually IS, corrected against the published schema ─────
   *
   * It is tempting to describe this as "a judgment a human recorded ON the
   * project", and that description is wrong in a way that matters to whoever
   * wires it next. Linear's published schema documents `Project.health` as:
   *
   *  > "The overall health of the project, **derived from the most recent project
   *  > update**. Possible values are onTrack, atRisk, or offTrack. **Null if no
   *  > health has been reported.**"
   *
   * (`linear/linear` → `packages/sdk/src/schema.graphql`, read 2026-08-16, THIS
   * dispatch.) So it is a ROLL-UP of the latest update's health, not a field
   * anyone sets on the project node. The value is still human-AUTHORED — a person
   * chose it when posting that update — which is why transporting it is honest;
   * but it is authored one node over, and two concrete mistakes follow from
   * getting that wrong:
   *
   *  1. **Selecting the wrong node.** The value lives on `Project.health` as a
   *     derived convenience; a producer reaching for "the project's own health
   *     field" and finding nothing might reach into `projectUpdates` and pick an
   *     arbitrary update instead. The roll-up is the right node precisely because
   *     Linear defines it as "the most recent".
   *  2. **Mishandling the documented NULL.** "Null if no health has been
   *     reported" is not a gap to paper over — it is the exact absence the
   *     frontier's contract cares about, and it must arrive at
   *     {@link GoalMemberHealth} as an absent KEY. A producer that coalesces it
   *     to `'onTrack'`, `''`, or the project's status category would be inventing
   *     a human judgment at the one seam built to prevent that.
   *
   * A `string` rather than the vendor's enum spelling, for the reason
   * {@link statusType}'s neighbours are opaque: this value is TRANSPORT on the
   * read side. Nothing in the engine branches on it, so nothing can rot when the
   * vendor adds a fourth word.
   *
   * OPTIONAL on this seam so a hand-built `LinearProject` in a spec stays valid,
   * the same stance {@link LinearIssue.updatedAt} takes. Absence means the store
   * reports no health for this member, which is the honest answer both when the
   * project genuinely has none and when a producer did not select the field.
   */
  health?: string;
  /**
   * The tracker's own URL for this project — the anchor's native link when this
   * project is a goal MEMBER (ADR-0046 decision 3).
   *
   * `Project.url: String!` in the published schema (read 2026-08-16, this
   * dispatch), and REPORTED rather than composed: the engine never builds a
   * Linear URL out of a workspace slug and a UUID, because a composed link is a
   * value the vendor never stated. Optional here for the same
   * hand-built-spec reason {@link health} is; absence renders the member's plain
   * name instead of a link.
   */
  url?: string;
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

  // ── Mirror-pass substrate (ADR-0046) — the native UPDATE surfaces ───────────
  //
  // Two writes, one per container role, and deliberately no read half: the facet
  // publishes an update and never lists, edits or deletes one. A consumer's own
  // timeline is not this station's to curate — the additive-only stance
  // {@link addBlockedBy} and {@link addProjectBlockedBy} already take, one
  // surface over.
  //
  // ── The build-time verification items, answered ─────────────────────────────
  //
  // ADR-0046 pinned three. Two are SHAPE questions and a careful read of the
  // published schema settles them; the third is a VALUE question and a read
  // cannot. All three are recorded on {@link LINEAR_UPDATE_HEALTH_VALUES}, with
  // the shape answers below.
  //
  // Read from Linear's published GraphQL schema (`linear/linear` →
  // `packages/sdk/src/schema.graphql`, read 2026-08-16, THIS dispatch):
  //
  //   - `projectUpdateCreate(input: ProjectUpdateCreateInput!): ProjectUpdatePayload!`
  //     `ProjectUpdateCreateInput { body: String, bodyData: JSON,
  //      health: ProjectUpdateHealthType, id: String, isDiffHidden: Boolean,
  //      projectId: String! }`
  //   - `initiativeUpdateCreate(input: InitiativeUpdateCreateInput!): InitiativeUpdatePayload!`
  //     `InitiativeUpdateCreateInput { body: String, bodyData: JSON,
  //      health: InitiativeUpdateHealthType, id: String, initiativeId: String!,
  //      isDiffHidden: Boolean }`
  //
  // **Item (a) — does the initiative-side create surface exist, and what is its
  // input shape? YES, and the shape is above.** It is the exact mirror of the
  // project side: one required id field, an optional markdown `body`, an optional
  // `health`. The only asymmetry is which id it takes.
  //
  // **Item (b) — is `health` OPTIONAL on BOTH create surfaces? YES, on both.**
  // Neither is `!`. This is the item ADR-0046 said must be settled BEFORE the
  // refusal arm is written, because it decides whether that arm exists at all:
  // since neither surface forces a value, "no health available" publishes an
  // update WITHOUT health, and the typed refusal is a contingency the vendor does
  // not currently trigger rather than a live path. It is still implemented and
  // still tested — see the store — because the ADR's rule is about what happens
  // IF a surface forces one, and a vendor can add a constraint without asking.
  //
  // Both are genuine SHAPE questions (does a field exist; is it nullable), which
  // is the class of question a schema read answers authoritatively. Item (c) is
  // not, and it is answered — as far as it can be from here — on the constant
  // below.

  /**
   * Publish ONE native project update. Real impl: `projectUpdateCreate`.
   *
   * `health` is passed through ONLY when the caller supplies one, and the KEY is
   * omitted otherwise — never sent as `null`, never defaulted. That distinction
   * is the wire-level form of the whole health prohibition: `{}` says "I record
   * no judgment", while `{health: null}` is an assertion about the value and a
   * default is a fabricated judgment. See {@link LINEAR_UPDATE_HEALTH_VALUES} for
   * what the vendor may do with the omission, which is the part no schema read
   * settles.
   *
   * Returns the update's own id and, when the API reports one, its URL —
   * reported, never composed.
   */
  createProjectUpdate(input: LinearUpdateInput & { projectId: string }): Promise<LinearUpdateResult>;

  /**
   * Publish ONE native initiative update. Real impl: `initiativeUpdateCreate`.
   * The initiative-side mirror of {@link createProjectUpdate}, with the same
   * health-omission contract.
   */
  createInitiativeUpdate(
    input: LinearUpdateInput & { initiativeId: string },
  ): Promise<LinearUpdateResult>;
}

/** The body-and-health half of an update write, shared by both container roles. */
export interface LinearUpdateInput {
  /** The update's markdown body — the composed narrative + engine anchor. */
  body: string;
  /**
   * The health to record, or ABSENT to record none. Absent must reach the wire as
   * an omitted key; see {@link LinearApi.createProjectUpdate}.
   */
  health?: string;
}

/** What an update write reports back. */
export interface LinearUpdateResult {
  /** The created update's own id, as the API assigned it. */
  id: string;
  /** The API's own URL for the update, when it returned one. Never composed. */
  url?: string;
}

/**
 * The health vocabulary Linear's update surfaces accept.
 *
 * ── READ-STAMP: SCHEMA-READ 2026-08-16, NOT LIVE-PROVEN ─────────────────────
 *
 * Read this before trusting any value here. This repo has now been burned TWICE
 * treating a published schema as evidence of a VALUE — see the read-stamp on
 * {@link PROJECT_BLOCKS_RELATION_TYPE}, where the schema declared free `String`
 * while the API validated an enum one layer behind GraphQL, and where the
 * vendor's own documented example named a value the API refuses. That cost a
 * major release. So the evidence class of every claim below is stated explicitly.
 *
 * **What IS schema-evidenced, and unusually strongly for this vendor.** Unlike
 * the project-relation fields, these are declared as REAL GraphQL enums, in the
 * published schema, by name (read 2026-08-16, this dispatch):
 *
 *     enum ProjectUpdateHealthType    { atRisk  offTrack  onTrack }
 *     enum InitiativeUpdateHealthType { atRisk  offTrack  onTrack }
 *
 * That is a categorically better position than the falsified pair was in: there,
 * the schema was *structurally incapable* of carrying the answer because the field
 * was typed `String!`. Here the vocabulary is published, both surfaces agree on
 * the same three members, and GraphQL's own type layer validates the value before
 * any class-validator can — so the hidden-enum failure mode that burned the
 * project-relation arm cannot repeat on THIS field in that form.
 *
 * **The loud-failure path, named as required.** The engine never authors a health
 * (ADR-0046 decision 4), so it pins no value from this list as a default — the
 * list is documentation and a validation aid, not a source of values. A health
 * that reaches the wire is one a human chose. If that value is outside the enum,
 * `projectUpdateCreate`/`initiativeUpdateCreate` fails at the GraphQL layer with a
 * variable-coercion error naming the enum and the offending value, and
 * {@link LinearApiError} surfaces it verbatim from the store's write — the pass
 * fails LOUDLY at publish time, with nothing written, and never degrades to a
 * silently-narrowed or defaulted health. That is the whole reason this seam types
 * health as an opaque `string` rather than a TS union: a union would tempt an
 * adapter into narrowing an unrecognized value locally, which is exactly how a
 * fabricated judgment would get onto the wire.
 *
 * ── ADR-0046 build-time item (c): the LIVE question, and it is UNANSWERED ────
 *
 * Item (c) asked what a real, UI-created update reads back as. **It could not be
 * measured from this dispatch: no live Linear write is reachable from a
 * worktree-isolated wave row, which runs no credential probe at all by policy.**
 * So it is reported UNSETTLED rather than closed on schema evidence, per the rule
 * above. What the schema read DID surface is the specific reason the question
 * still matters, and it is sharper than "we did not check":
 *
 *   **The create input and the read node disagree about whether health is
 *   optional.** `ProjectUpdateCreateInput.health` is nullable (item (b) above),
 *   but the node it creates declares `ProjectUpdate.health:
 *   ProjectUpdateHealthType!` — NON-NULL. Both initiative-side types say the same.
 *   An update created without a health therefore still reads back WITH one, which
 *   means the SERVER assigns a value when the caller omits the key.
 *
 *   **What that assigned value is, is a pure VALUE question, and no schema read
 *   can answer it.** It may be a fixed default, or the previous update's health
 *   carried forward. And it has a real consequence, because `Project.health` is
 *   documented as derived from the most recent update: publishing a
 *   health-less mirror may still MOVE the container's health to whatever the
 *   server picked.
 *
 * **What the engine does about it, and what it must not claim.** It omits the key
 * — the most conservative act available, and the only one that is literally "I
 * record no judgment". It does NOT send `health: null` (spellable, but an
 * assertion about the value, and whether null clears or defaults is the same
 * unmeasured question), and it does not default. And it deliberately does not
 * claim that a health-less publish leaves the container's health untouched:
 * {@link GoalUpdateReceipt.health} reports what the ENGINE SENT and says nothing
 * about what the container reads afterwards, precisely so this unproven point
 * cannot be silently asserted through a return value.
 *
 * **To settle item (c)**, a consumer with a live workspace posts one update by
 * hand in the UI, one through this seam with a health, and one through this seam
 * WITHOUT, then reads all three back (`ProjectUpdate.health`, and `Project.health`
 * before and after) and reports what the omission produced. Until then this
 * constant is documentation of a published vocabulary and nothing more.
 *
 * Exported so a consumer proposing a health can validate it against the vendor's
 * own list BEFORE a confirm round, rather than discovering the vocabulary from a
 * rejection — and so this stamp has a home a reader will actually find.
 */
export const LINEAR_UPDATE_HEALTH_VALUES: readonly string[] = Object.freeze([
  'onTrack',
  'atRisk',
  'offTrack',
]);

/**
 * The `ProjectRelation.type` value for a blocking project dependency.
 *
 * ── READ-STAMP: MEASURED LIVE 2026-08-16, and it FALSIFIED the read ──────────
 *
 * This constant shipped as `'blocks'`, pinned from Linear's published schema
 * and its own field prose. A live write against a real Linear workspace on
 * 2026-08-16 disproved it. `'dependency'` is the **only** value the API accepts;
 * every `projectRelationCreate` carrying `'blocks'` comes back as
 * `Argument Validation Error`. Verbatim from the rejection's
 * `extensions.validationErrors`:
 *
 *     property: "type"
 *     constraints: { isEnum: "type must be one of the following values: dependency" }
 *
 * **The structural finding — why a schema read could NEVER have produced this,
 * and the reason this stamp is worth more than a corrected string.** Linear
 * validates these fields as ENUMS ONE LAYER BEHIND GraphQL: a class-validator
 * `isEnum` constraint that surfaces only in a rejection's
 * `extensions.validationErrors` and appears NOWHERE in the schema. Live
 * introspection against the running API (read this dispatch) confirms the
 * schema still declares `ProjectRelationCreateInput.type: String!`,
 * `anchorType: String!`, `relatedAnchorType: String!`, and `ProjectRelation`
 * returning `String` on the read side — so the schema is not merely ambiguous
 * here, it is **structurally incapable of carrying the answer**. The general
 * rule for this vendor, and the one to carry to the next pinned value:
 *
 *  > A `String`-typed field in Linear's schema is NOT evidence of an
 *  > unconstrained field. Only a live write answers. The rejection payload is
 *  > generous when it comes — it names every offending property at once.
 *
 * **And the vendor's own prose actively misled.** `ProjectRelation.type` is
 * documented as "The type of dependency relationship from the project to the
 * related project (e.g., blocks)" — that example names the one value the API
 * refuses. It describes the relationship's SEMANTICS, not its wire value. The
 * corroboration the original stamp leaned on (`ProjectFilter.hasBlockingRelations`
 * / `hasBlockedByRelations` undeprecated while `hasDependsOnRelations` is
 * `[Deprecated]`) was real and is still true — it simply never spoke to the wire
 * value at all.
 *
 * ── WHY `'blocks'` WAS PLAUSIBLE: THE ARM ASYMMETRY, AND THE RULE IT YIELDS ───
 *
 * The correction above records THAT the value was measured. This records WHY the
 * wrong one looked safe, which is the half that stops the mistake recurring on
 * some other vendor field. `'blocks'` was not invented — it was CARRIED ACROSS
 * FROM A REAL ENUM IN THE NEIGHBOURING ARM. Linear's published schema
 * (`linear/linear` → `packages/sdk/src/schema.graphql` @ commit
 * `91456bbd299d7db1fd39f60782fa2a59393e8b9b`, re-read live this dispatch —
 * pinned 2026-08-16, the cheap moment: two independent fetches of that commit
 * in this same dispatch returned identical byte sizes, so nothing here had
 * drifted yet) treats its two relation arms completely differently:
 *
 *  - The **ISSUE** arm publishes a real enum — but it binds exactly ONE field
 *    with it, and naming WHICH field is the whole of the precision here. The
 *    schema declares `enum IssueRelationType { blocks  duplicate  related
 *    similar }` and then references it in exactly one place:
 *    `IssueRelationCreateInput.type: IssueRelationType!`. The object's own
 *    `IssueRelation.type` is `String!`, and `IssueRelationUpdateInput.type` is
 *    `String`. So `BLOCKS_RELATION_TYPE` in `real-linear-api.ts` is
 *    schema-pinned on the CREATE it feeds and NOT on the read that shares its
 *    spelling — `toBlockedByIdentifiers` filters a bare-`String` field. The
 *    rule this section yields already bites one field over, INSIDE the very arm
 *    being called "the explicit one".
 *  - The **PROJECT** arm declares NO enum anywhere. There is no
 *    `ProjectRelationType`, and no anchor enum at all — the schema's six anchor
 *    declarations (`anchorType`/`relatedAnchorType` on `ProjectRelation`,
 *    `ProjectRelationCreateInput` and `ProjectRelationUpdateInput`) are every
 *    one of them `String`. `ProjectRelationCreateInput.type` is bare `String!`
 *    too, and the two CREATE inputs' `type` fields even carry near-identical
 *    doc strings ("The type of relation of the {issue|project} to the related
 *    {issue|project}").
 *
 * So the original inference met an arm whose TYPES were silent, turned to the
 * parallel arm that was explicit, found `blocks` there among four named members,
 * and adopted it. Every step of that is reasonable; the conclusion was wrong,
 * because the two arms are validated by different vocabularies and only one of
 * them publishes its own.
 *
 * **But the project arm was never silent — only untyped, and that is the half
 * an account of "why it was plausible" must not leave out.** The published
 * schema DID carry the accepted value, in prose, in the same declaration: the
 * type description opens "A **dependency** relation between two projects",
 * `project` is "The source project in the **dependency** relation",
 * `relatedProject` is "The target project in the **dependency** relation", and
 * `type` itself reads "The type of **dependency** relationship from the project
 * to the related project (e.g., blocks)". The accepted wire value and the
 * refused one sit in the SAME SENTENCE — `dependency` is its noun, `blocks` is
 * its example — and the reading skimmed that sentence for the enum-shaped thing,
 * found the example, and took it. (The issue arm's prose really does enumerate,
 * and even there imperfectly: `IssueRelation.type` reads "Possible values
 * include blocks, duplicate, and related" — non-exhaustive, and it drops
 * `similar`.) So the correction was recoverable from the published schema after
 * all. It just was not recoverable from the schema's TYPES, which is where the
 * eye goes.
 *
 * **House ruling, 2026-08-16 (ADR-0045-a amendment "one house lesson, not
 * two"):** this section's hindsight framing and the decision record's TRAP
 * framing ("the prose actively misled") are not in tension — the operator
 * ruled the record's trap reading is the operative lesson (only a live
 * measurement settles a vendor value; a doc string is corroboration at best),
 * with the nuance above kept as a dated footnote to it. See that amendment
 * for the full ruling; this section is not rewritten to match it.
 *
 * Two rules come out of that, and the second is the one that was missing:
 *
 *  > A sibling field's enum is NOT this field's enum. Where one arm of a vendor
 *  > API publishes an enum and the parallel arm types the same-named field as
 *  > free `String`, that asymmetry is the SIGNAL — it usually means the second
 *  > arm is validated somewhere the schema cannot show you, with a vocabulary
 *  > that need not overlap the first. Carrying a member across is a guess
 *  > wearing an enum's clothes. Measure it.
 *
 *  > And where a field is UNTYPED, its doc string is the only vocabulary the
 *  > vendor hands you — so read it WHOLE, and weigh its NOUNS above its
 *  > EXAMPLES. An example says what the field is like; the noun is often what
 *  > the field IS. Measuring still beats both, but a doc string read whole
 *  > would have made this measurement a confirmation instead of a surprise.
 *
 * The anchor pair below is the same error's second head, and the read-side doc
 * string is where it came from — quoted WHOLE here, because the clause that
 * gets trimmed is the load-bearing one. `ProjectRelation.anchorType` reads, in
 * full:
 *
 *  > "The type of anchor on the source project end of the relation, indicating
 *  > whether it is anchored to the project itself or a specific milestone."
 *
 * `'project'` was lifted out of the TRAILING clause — out of English prose
 * rather than out of any enum, since there is none to lift from. But the
 * OPENING clause, the one a short citation drops, already says this field is
 * the anchor on ONE END of a relation: per-side, not per-relation. Read whole,
 * the measured vocabulary (`start | end | milestone`) stops looking like a
 * betrayal — "anchored to the project itself" names the CHOICE (project-level
 * versus milestone-level), while the words that EXPRESS it are the ends the
 * opening clause already promised. One symmetric value was never spellable in
 * a field the vendor documents per-end. Cited short, the doc string reads like
 * a clean binary the API then refused; cited whole, it reads like a per-end
 * anchor whose vocabulary was simply never published — which is what it is.
 *
 * ── What the SAME live probe CONFIRMED — do not re-measure this ──────────────
 *
 * With the corrected values a relation was created, read back and swept. Every
 * direction fact this adapter documents holds, so nothing below the strings
 * changed:
 *
 *  - The values round-trip VERBATIM, with no server-side normalization:
 *    `{"type":"dependency","anchorType":"end","relatedAnchorType":"start"}`,
 *    and `projectMilestone: null` — the whole-project anchor the facet wants.
 *  - `projectId` = the BLOCKER, `relatedProjectId` = the BLOCKED project is the
 *    correct assignment (what {@link LinearApi.addProjectBlockedBy} sends).
 *  - The relation surfaces on the BLOCKED project's `inverseRelations` and
 *    NEVER on its `relations`; the node's `project.id` is the BLOCKER — exactly
 *    what {@link LinearApi.getProjectBlockedBy}'s docblock promises.
 *  - Linear's own semantics agree: after the write, `hasBlockingRelations`
 *    returned the blocker and `hasBlockedByRelations` returned the blocked
 *    project. Both filter fields exist and work.
 *  - Uniqueness is enforced per (project pair, type), NOT per anchor pair — a
 *    second relation between the same two projects is refused with "A dependency
 *    of the same type already exists between the two projects" regardless of
 *    anchors. The facet's find-before-create idempotence therefore has exactly
 *    the right granularity.
 *
 * Still exported, and now for a sharper reason than "least-proven value": it is
 * the wire literal BOTH halves of the arm depend on — the write's `type` and
 * `getProjectBlockedBy`'s filter — so the two cannot drift apart, and a
 * consumer whose workspace ever answers differently can name exactly what to
 * report. ADR-0045's Amendment 2026-08-16 carries the falsification.
 */
export const PROJECT_BLOCKS_RELATION_TYPE = 'dependency';

/**
 * The two anchor-type fields of a WHOLE-PROJECT blocking relation, as an
 * inseparable pair keyed by their own wire names.
 *
 * ── The measurement ─────────────────────────────────────────────────────────
 *
 * This shipped as a SINGLE symmetric string, `'project'`, used for both ends on
 * the reading that "anchored to the project itself" was one value. The same
 * live write on 2026-08-16 falsified that too, and the rejection named both
 * properties at once:
 *
 *     property: "anchorType"         constraints: { isEnum: "anchorType must be one of the following values: start, end, milestone" }
 *     property: "relatedAnchorType"  constraints: { isEnum: "relatedAnchorType must be one of the following values: start, end, milestone" }
 *
 * `'project'` is not among them. The real model is a **finish-to-start
 * dependency**: the BLOCKER's `end` anchors to the BLOCKED project's `start`.
 * There is no symmetric value to correct the old constant to — a whole-project
 * anchor is asymmetric by construction, and `milestone` is the third value,
 * which this facet deliberately never uses (it sends no milestone ids, and the
 * confirmed read-back carries `projectMilestone: null`).
 *
 * ── Why THIS shape, stated where the shape is chosen ────────────────────────
 *
 * A frozen fragment KEYED BY THE WIRE FIELD NAMES, meant to be spread wholesale
 * into `ProjectRelationCreateInput` — never destructured, never read one field
 * at a time. The alternatives were weighed and rejected for the same reason:
 *
 *  - **A renamed single string** (e.g. `PROJECT_RELATION_BLOCKING_ANCHOR`) would
 *    satisfy the letter of the correction and REPRODUCE THE DEFECT — one value
 *    reachable for both ends is exactly what put `'project'` on both ends.
 *  - **Two separate constants** (`…_BLOCKING_ANCHOR` / `…_BLOCKED_ANCHOR`) are
 *    correct but still leave a caller holding two interchangeable strings and a
 *    hand-written mapping onto two similarly-named wire fields — the swap stays
 *    expressible, and a swapped pair is a SILENT defect: it is a valid enum
 *    value in a valid field, so the API accepts a backwards dependency.
 *  - **This fragment** removes the mapping step entirely. There is no scalar to
 *    put on the wrong end because there is no scalar at all, and the object's
 *    own keys ARE `anchorType`/`relatedAnchorType`, so `...` places each value
 *    on the end the measurement assigned it. Misuse is not discouraged, it is
 *    unspellable.
 *
 * The NAME says PAIR, and that is load-bearing rather than cosmetic. For one
 * cycle it did not: the reshape shipped under the old singular `…_ANCHOR_TYPE`
 * spelling, a name for a scalar, because the shape correction's row could not
 * reach `index.spec.ts` — where the root surface is pinned BY NAME and BY EXPORT
 * COUNT — so the declaration and its pins could not move in one diff. The rename
 * landed the moment a single row owned both, and BEFORE the reshape was
 * published, so the exported symbol breaks once rather than twice for what was
 * one repair. A name still promising a scalar was the last thing inviting a
 * caller to reach for one end of an asymmetric value.
 *
 * @see PROJECT_BLOCKS_RELATION_TYPE for the full read-stamp, the structural
 * finding behind it, the arm-asymmetry that made the original values plausible,
 * and what the same probe confirmed.
 */
export const PROJECT_RELATION_ANCHOR_PAIR: ProjectRelationAnchorPair = Object.freeze({
  anchorType: 'end',
  relatedAnchorType: 'start',
});

/**
 * The shape of {@link PROJECT_RELATION_ANCHOR_PAIR} — the two anchor fields of
 * a whole-project blocking relation, pinned to the literals measured live on
 * 2026-08-16 rather than widened to `string`.
 *
 * The literal types are the point: a value drifting to any other member of the
 * live enum (`start` | `end` | `milestone`) — or the two ends being swapped —
 * fails `tsc` at the binding above, before a single spec runs.
 */
export interface ProjectRelationAnchorPair {
  /** The BLOCKING (source, `projectId`) end. Finish-to-start: the blocker's END. */
  readonly anchorType: 'end';
  /** The BLOCKED (target, `relatedProjectId`) end. Finish-to-start: the blocked project's START. */
  readonly relatedAnchorType: 'start';
}
