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

import type { LandingHost, LandingPosture, RulesetChecksInfo } from '../../host-pr';

// The code-host posture type `RequiredChecksInfo` was re-homed to the host seam
// (host-pr.ts) by the ADR-0023 amendment — one owner for the landing-posture
// facts. Re-exported here so the GitHub adapter's existing importers are
// unchanged; the shape is host-neutral (the Bitbucket pilot produces it too).
export type { RequiredChecksInfo, RulesetChecksInfo, AutoMergeSetting } from '../../host-pr';

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
  // The three code-host posture reads — `canMergePullRequests`,
  // `getAutoMergeSetting`, `getRequiredChecks` — are inherited from
  // `LandingPosture` (host-pr.ts). They were declared here (FOR-12/ADR-0023) but
  // re-homed to the host seam by the ADR-0023 amendment (single-owner): `host-pr
  // preflight` grades them on every store kind, store-blind.
}
