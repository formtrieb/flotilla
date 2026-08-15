/**
 * github-api.ts — the injectable DOMAIN seam GitHubIssuesStore talks to.
 *
 * NOT a raw HTTP seam: the store speaks issue-shaped operations, so the
 * conformance fake is a small in-memory state machine rather than a pile of
 * canned HTTP routes. The real impl (`RealGitHubApi`, P8) speaks raw `fetch`
 * REST + GraphQL over its own GitHub-adapter-local `GitHubHttp` seam — NOT
 * host-pr's cross-host `HttpProbe` (ADR-0019: the verb/auth needs outgrew that
 * aspiration). The store body never does I/O.
 *
 * Coordinates (owner/repo) + creds are bound at construction of the *impl*, not
 * threaded per call — the seam stays about issues, not hosts.
 */

import type { LandingHost, LandingPosture, ReportedCheck, RulesetChecksInfo } from '../../host-pr';

// The code-host posture type `RequiredChecksInfo` was re-homed to the host seam
// (host-pr.ts) by the ADR-0023 amendment — one owner for the landing-posture
// facts. Re-exported here so the GitHub adapter's existing importers are
// unchanged; the shape is host-neutral (the Bitbucket pilot produces it too).
export type { RequiredChecksInfo, RulesetChecksInfo, AutoMergeSetting, ReportedCheck } from '../../host-pr';

/** GitHub's native issue lifecycle state. */
export type GhState = 'open' | 'closed';

/**
 * GitHub's native close reason. NB: the coarse projection is lossy (ADR-0002) —
 * `deriveStatus` maps ANY `closed` issue to `done`, so this reason is NOT
 * consulted (a `not_planned` close still projects to `done`). Kept on the
 * substrate for fidelity / possible future use, not for the done-derivation.
 */
export type GhStateReason = 'completed' | 'not_planned' | 'reopened' | null;

/** The raw GitHub issue substrate the store projects onto an IssueView. */
export interface GhIssue {
  number: number;
  title: string;
  /** Body sections + AC checklist + managed `**Closed-by:**`/wallclock lines. */
  body: string;
  /** Eligibility OR-set token(s) + `risk/<x>` + `worker/<x>` + `wave/<rung>`. */
  labels: string[];
  state: GhState;
  stateReason: GhStateReason;
  /**
   * GitHub's own `updated_at` on the issue resource — an ISO-8601 instant, the
   * substrate for `IssueView.trackerUpdatedAt` (the DoR staleness advisory's
   * `since`). OPTIONAL on this seam so a hand-built `GhIssue` in a spec stays
   * valid; the store projects absence straight through as absence, and the
   * advisory then `defer`s rather than falsely passing.
   */
  updatedAt?: string;
}

/**
 * The merge-state of an issue's CLOSING pull request (ADR-0005). Evidence-shaped,
 * mirroring {@link ClosingState} — each value is what the probe actually FOUND,
 * never inferred from an absence:
 *
 * - `open` — not closed.
 * - `merged` — the issue was closed by a merged PR (the wave's done signal).
 * - `closed-unmerged` — a closing PR was FOUND and did NOT merge: positive
 *   evidence of a genuine rejection (a `closedByPullRequestsReferences` node
 *   exists, none merged).
 * - `closed-unknown` — the issue is closed but NO closing-PR reference was found
 *   either way (closed by hand, as a duplicate, via a foreign-id mention, or with
 *   the tracker↔host integration never attaching a PR). NOT a rejection — callers
 *   MUST NOT treat it as one (W2-F1c). The absence-of-evidence case the probe
 *   used to collapse into `closed-unmerged`, wrongly flagging legitimately-
 *   finished rows as rejected PRs.
 *
 * The real impl resolves this via the GitHub `closedByPullRequestsReferences`/
 * timeline; the fake holds it explicitly (test affordance).
 */
export interface ClosingPrState {
  state: 'open' | 'merged' | 'closed-unmerged' | 'closed-unknown';
  prUrl?: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

/**
 * The raw GitHub **milestone** substrate — the Goal facet's native container on
 * this store (ADR-0044 decision 4). Milestone is the only GitHub container with
 * DIRECT issue membership, which is exactly why it can be a default no consumer
 * convention collides with: it is not a naming choice, it is the one shape that
 * answers "which issues are in this?" natively.
 *
 * `state` is carried for fidelity and is deliberately NOT consulted by the
 * frontier: whether the CONTAINER is open or closed says nothing about whether
 * its members are done, and closing it is the Operator's act (ADR-0044 decision
 * 5). Same stance {@link GhStateReason} takes toward the `done` derivation.
 */
export interface GhMilestone {
  number: number;
  title: string;
  /** Free prose; the empty string when the milestone carries none. */
  description: string;
  state: 'open' | 'closed';
}

/** What the Goal facet hands the seam to mint a milestone. */
export interface CreateMilestoneInput {
  title: string;
  description: string;
}

/**
 * The GitHub seam.
 *
 * It `extends LandingHost` (ADR-0023): the GitHub adapter IS the GitHub landing
 * adapter, so the landing methods — `getPrStatus` (branch → open/merged/
 * closed-unmerged + url), `enableAutoMerge` (GraphQL `enablePullRequestAutoMerge`
 * — REST has no arming endpoint), `mergePullRequest` (REST `PUT …/pulls/N/merge`),
 * and `deleteBranch` (REST `DELETE …/git/refs/heads/{branch}` — the `host-pr
 * merge --delete-branch` hygiene step, consumer KW-F6) — are inherited rather
 * than re-declared, and `RealGitHubApi` can be handed straight to
 * `armPullRequest` / `mergePullRequestNow` with no pass-through wrapper. A
 * Bitbucket adapter implements the same `LandingHost` and reuses the engine's
 * arm intent verbatim.
 *
 * It also `extends LandingPosture` (ADR-0023 amendment): the three code-host
 * posture reads — `canMergePullRequests`, `getAutoMergeSetting`,
 * `getRequiredChecks` — that `host-pr preflight` grades are inherited from the
 * host seam, so the GitHub adapter can be handed straight to `preflightHost`.
 * They moved off this interface to the host seam under the single-owner
 * discipline (one owner for the landing-posture facts); a Bitbucket adapter
 * implements the same `LandingPosture` and inherits the probe.
 */
export interface GitHubApi extends LandingHost, LandingPosture {
  /** Create an issue; return the server-assigned number. */
  createIssue(input: CreateIssueInput): Promise<{ number: number }>;
  /** Fetch one issue; throw on a number that does not resolve. */
  getIssue(number: number): Promise<GhIssue>;
  /**
   * Open issues only (state=open).
   *
   * P8 real-impl contract: the GitHub REST list is PAGINATED (30/page default,
   * 100 max). The real impl MUST page to exhaustion (or `gh issue list
   * --limit`), not return only the first page — a truncated candidate set would
   * silently shrink the wave. The in-memory fake returns all issues, so this
   * divergence is NOT covered by conformance and must be handled at wiring time.
   */
  listOpenIssues(): Promise<GhIssue[]>;
  /** Replace the body (cosmetic AC tick + the `**Closed-by:**` line). */
  setBody(number: number, body: string): Promise<void>;
  /** Replace the human-facing title (the Amend facet, ADR-0025). Real impl: `PATCH /issues/N {title}`. */
  setTitle(number: number, title: string): Promise<void>;
  /** Add a label (idempotent — no-op if already present). */
  addLabel(number: number, label: string): Promise<void>;
  /** Remove a label (idempotent — no-op if absent). */
  removeLabel(number: number, label: string): Promise<void>;
  /**
   * The repository's label REGISTRY — every label defined on the repo
   * (`GET /repos/{owner}/{repo}/labels`), NOT the per-issue label lists
   * `getIssue`/`listOpenIssues` return. Backs the store-preflight `state-catalog`
   * check's GitHub translation (issue #131): GitHub's claims ARE labels, which is
   * exactly why they need verifying, not why the check should be skipped — every
   * eligibility/`risk/*`/`worker/*`/`wave/*` label the wave will read or write
   * must exist here before a wave dispatches against it, the same precondition
   * `linearChecks` runs against the team's workflow-state catalog.
   */
  listLabels(): Promise<string[]>;
  /** Append a comment to an issue (NOT idempotent — each call adds one). Throws on an unknown number. */
  addComment(number: number, body: string): Promise<void>;
  /** All comments on an issue, oldest-first. Throws on an unknown number. */
  getComments(number: number): Promise<{ body: string }[]>;
  /**
   * Mark an issue closed. Two production-relevant callers:
   *   - the conformance hook ({@link IssueStoreConformanceHooks.simulateNativeClose})
   *     simulates the merged PR's `Closes #N` (reason `completed`/null);
   *   - the Triage facet's `closeUnplanned` closes a wontfix with reason
   *     `not_planned` (ADR-0015).
   * The wave merge path itself does NOT call this — the merged PR closes the
   * issue server-side, out of band (ADR-0005). `reason` defaults to `completed`;
   * the lossy coarse projection derives `done` for ANY closed issue (ADR-0002).
   */
  nativeClose(number: number, reason?: GhStateReason): Promise<void>;
  /**
   * Resolve how an issue was closed: open / closed-by-merged-PR (with url) /
   * closed-unmerged (a closing PR was FOUND, none merged) / closed-unknown (closed
   * with NO closing-PR reference either way — never a rejection, W2-F1c). The
   * store's {@link IssueStore.readClosing} probe (ADR-0005). Throws on an unknown
   * number. P8 real-impl: GraphQL `closedByPullRequestsReferences(includeClosedPrs:
   * true)` + the PR `merged` flag — an empty node set on a closed issue is
   * `closed-unknown`; the in-memory fake holds an explicit closing-PR record whose
   * absence is likewise `closed-unknown`.
   */
  getClosingState(number: number): Promise<ClosingPrState>;
  /**
   * Issue NUMBERS of the issues NATIVELY blocking this one, via GitHub's own
   * issue-dependencies API — orthogonal to the body-codec `## Blocked by`
   * section. {@link GitHubIssuesStore.read} unions both (ADR-0020's read-union,
   * ported: without it the DoR gate is blind to native relations a consumer
   * already maintains, and dispatches a row whose real blocker is still open).
   * The mirroring *write* half is {@link addBlockedBy}.
   *
   * The seam speaks the store's OWN identity — the issue number (ADR-0001) —
   * exactly as the Linear seam speaks `EX-16` identifiers. GitHub's separate
   * per-issue DATABASE id (the `id` field, distinct from `number`) is what the
   * dependency endpoints are actually keyed by; it stays seam-internal, the same
   * stance `LinearApi` takes with Linear's UUIDs.
   *
   * Real impl: `GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/
   * blocked_by` → 200 with an array of full issue objects (docs.github.com/en/
   * rest/issues/issue-dependencies, read 2026-08-03). PAGINATED (`per_page`
   * default 30, max 100) — it MUST page to exhaustion for the same reason
   * {@link listOpenIssues} does: a truncated blocker set silently UNBLOCKS a row.
   * Throws on an unknown number.
   */
  getBlockedBy(number: number): Promise<number[]>;
  /**
   * Mirror ONE body-codec blockedBy ref into a NATIVE GitHub issue dependency
   * (the write half of {@link getBlockedBy}): record that `blockerNumber` blocks
   * `blockedNumber` — so from `blockedNumber`'s own perspective it is
   * *blocked-by* `blockerNumber`. The read union then surfaces `blockerNumber`
   * in `blockedNumber`'s blockedBy, giving humans a visible dependency on the
   * issue itself rather than only a markdown line in its body.
   *
   * ADDITIVE-ONLY by contract, exactly as `LinearApi.addBlockedBy` is: this ONLY
   * ever creates a dependency. It never deletes or updates one, so a
   * human-drawn dependency survives any re-scope and a stale mirror is harmless
   * (the read-union's dedup tolerates double representation). The body codec
   * stays the canonical, store-agnostic home of blockedBy — this is a redundant
   * visibility mirror, never the source of truth. GitHub *does* publish a
   * removal endpoint (`DELETE …/dependencies/blocked_by/{issue_id}`, same doc
   * page) and it is deliberately NOT declared here: ADR-0020 settled that the
   * mirror has no delete path, so a delete verb would be unreachable surface.
   *
   * Real impl: resolve `blockerNumber` to its DATABASE id (readable as `id` off
   * the issue object), then `POST /repos/{owner}/{repo}/issues/{blockedNumber}/
   * dependencies/blocked_by` with `{ issue_id }` → 201 (same doc page, read
   * 2026-08-03).
   *
   * Throws on an unresolvable number (either side) or a rejected write. The
   * caller ({@link GitHubIssuesStore}) treats a throw as a best-effort mirror
   * skip: the authoritative body-codec write already happened, so a failed
   * native mirror is skipped, never fatal.
   */
  addBlockedBy(blockedNumber: number, blockerNumber: number): Promise<void>;
  /**
   * Required status checks a branch's ACTIVE RULESETS put in force, read from the
   * effective-rules endpoint (GitHub `GET /repos/{o}/{r}/rules/branches/{branch}`;
   * default: the repo's default branch). This is the ruleset-aware companion to
   * the inherited {@link LandingPosture.getRequiredChecks} legacy read: it needs
   * only READ access, and it SEES ruleset-carried checks the legacy admin-gated,
   * ruleset-blind branch-protection read cannot (2026-07-23 gate-arm gap). The
   * two are reconciled by `mergeRequiredChecks` (host-pr) inside
   * `getRequiredChecks`. REPORT-ONLY — MUST NOT throw; an unreadable answer
   * degrades to `{ readable:false }`. Distinct from the three inherited
   * `LandingPosture` posture reads because it is GitHub-effective-rules-specific;
   * a Bitbucket adapter (no rulesets endpoint) returns `readable:false`.
   */
  getRulesetRequiredChecks(branch?: string): Promise<RulesetChecksInfo>;
  /**
   * The checks the host has REPORTED for `ref` — the second half of the arm verb's
   * check-ATTACH comparison (the 2026-07-30 live occurrences: `host-pr arm`
   * direct-merged PRs ~90 s old whose two ruleset-required checks had not attached
   * yet). Declaring it here is what makes the GitHub adapter structurally a
   * `CheckAttachReader` (host-pr): the required NAMES come from the inherited
   * {@link LandingPosture.getRequiredChecks} — the preflight's own effective-rules
   * read, reused, not duplicated — and this is the only new fact needed.
   *
   * `ref` is a commit SHA or a `heads/<branch>` ref (GitHub's documented `ref`
   * forms). The real impl folds BOTH report sources GitHub matches a required
   * context against: check runs (`GET .../commits/{ref}/check-runs`, whose `filter`
   * defaults to `latest`, one report per name) and commit statuses
   * (`GET .../commits/{ref}/status`).
   *
   * Unlike the advisory posture reads this one MUST THROW on a failed read rather
   * than degrade to `[]`: an empty list is EVIDENCE that nothing has attached yet
   * (the input that forces an arm), so a read failure must never be able to
   * counterfeit it. The arm's own guard turns a throw into "no evidence", which
   * leaves the landing behaviour exactly as it was before this read existed.
   */
  getReportedChecks(ref: string): Promise<ReportedCheck[]>;

  // ── Goal facet substrate (ADR-0044) — milestones ─────────────────────────
  //
  // Four reads and one write, mirroring the facet's own read-heavy shape. No
  // milestone CLOSE verb is declared, and the omission is the point: the facet
  // has no `closeGoal`, so a close verb here would be unreachable surface —
  // the same reasoning that keeps GitHub's documented
  // `DELETE …/dependencies/blocked_by` off {@link addBlockedBy}'s side of this
  // seam.

  /**
   * Mint a milestone; return its server-assigned `number` (the store's opaque
   * goal id, ADR-0001). Real impl: `POST /repos/{owner}/{repo}/milestones` with
   * `{title, description}` → **201** (docs.github.com/en/rest/issues/milestones,
   * read 2026-08-15).
   */
  createMilestone(input: CreateMilestoneInput): Promise<{ number: number }>;

  /**
   * Fetch one milestone; throw on a number that does not resolve. Real impl:
   * `GET /repos/{owner}/{repo}/milestones/{milestone_number}` → 200 (same doc
   * page).
   */
  getMilestone(number: number): Promise<GhMilestone>;

  /**
   * Every milestone on the repo, OPEN AND CLOSED. Real impl: `GET
   * /repos/{owner}/{repo}/milestones?state=all` — `state` defaults to `open`, so
   * the parameter is load-bearing: a goal panel that silently dropped closed
   * finish lines would make a shipped goal look like one that never existed.
   * PAGINATED (`per_page` default 30, max 100) and MUST page to exhaustion, the
   * same reason {@link listOpenIssues} does.
   */
  listMilestones(): Promise<GhMilestone[]>;

  /**
   * Join an issue to a milestone — the curation write. Real impl: `PATCH
   * /repos/{owner}/{repo}/issues/{issue_number}` with `{milestone: <number>}` →
   * 200 (docs.github.com/en/rest/issues/issues, read 2026-08-15: the field
   * accepts "The number of the milestone to associate this issue with").
   * Idempotent by nature — re-setting the same milestone is the same write.
   *
   * Deliberately no un-assign path (`{milestone: null}` is documented and not
   * declared): curation joins members, and removing one is a human act in the
   * tracker, the same additive-only stance {@link addBlockedBy} takes.
   */
  setIssueMilestone(issueNumber: number, milestoneNumber: number): Promise<void>;

  /**
   * Every issue in a milestone, OPEN AND CLOSED — the frontier's member list.
   * Real impl: `GET /repos/{owner}/{repo}/issues?milestone={number}&state=all`
   * (same doc page: "If an integer is passed, it should refer to a milestone by
   * its `number` field"), paginated to exhaustion and with pull requests
   * filtered out exactly as {@link listOpenIssues} does.
   *
   * `state=all` is not an optimization: `done` is one of the five frontier
   * readings, so a member list that returned only open issues would report a
   * finished goal as an empty one. Throws on an unknown milestone number.
   */
  listMilestoneIssues(milestoneNumber: number): Promise<GhIssue[]>;
  // The three code-host posture reads — `canMergePullRequests`,
  // `getAutoMergeSetting`, `getRequiredChecks` — are inherited from
  // `LandingPosture` (host-pr.ts). They were declared here (FOR-12/ADR-0023) but
  // re-homed to the host seam by the ADR-0023 amendment (single-owner): `host-pr
  // preflight` grades them on every store kind, store-blind.
}
