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
 * The raw Linear **project** substrate — the Goal facet's native container on
 * this store, and the ONLY realization v1 ships (ADR-0044 decision 4).
 *
 * There is no default binding on Linear, deliberately: one shipped consumer runs
 * Initiative=Epic / Project=User Story (motivated by Linear's timeline and
 * health views living at project/initiative level, not on issues), while
 * ADR-0017 once sketched "Wave ≈ Linear Project". Both conventions are live, so
 * any built-in choice here would silently overwrite somebody's meaning — hence
 * `store.goal.container` is explicit on this store and a goal verb without it
 * refuses loudly.
 *
 * `id` is Linear's project UUID and IS the store's opaque goal id (ADR-0001) —
 * the one place a Linear UUID legitimately crosses this seam, because a project
 * has no human `<TEAM>-<n>` identifier the way an issue does.
 */
export interface LinearProject {
  id: string;
  name: string;
  /** Free prose; the empty string when the project carries none. */
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
   * Every issue in a project, OPEN AND CLOSED — the frontier's member list.
   * Real impl: the `Project.issues` connection, paged to exhaustion.
   *
   * Unlike {@link listOpenIssues} this one must NOT filter by state: `done` is
   * one of the five frontier readings, so dropping closed members would report a
   * finished goal as an empty one. Throws on an unknown project id.
   */
  listProjectIssues(projectId: string): Promise<LinearIssue[]>;
}
