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
  /** PR attachments from the GitHub integration (closing probe). */
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
  /** Real impl requires a bound `project` and refuses to mint an orphan Document — a clear `LinearApiError` thrown before any wire call; the in-memory fake is lenient (no project required). */
  createDocument(input: { title: string; content: string }): Promise<{ id: string }>;
  /** Fetch a native Document; throws on an unknown id. */
  getDocument(id: string): Promise<{ id: string; title: string; content: string }>;
  listDocuments(): Promise<{ id: string; title: string; content: string }[]>;
}
