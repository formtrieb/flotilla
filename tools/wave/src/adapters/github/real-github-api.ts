/**
 * real-github-api.ts — the P8 production GitHubApi (ADR-0019): raw `fetch` REST
 * (issue CRUD / labels / comments / close) + GraphQL (the closing-probe only),
 * over the GitHub-local `GitHubHttp` seam. No `@octokit`, no `gh` subprocess.
 */

import type {
  GitHubApi, GhIssue, GhMilestone, GhStateReason, CreateIssueInput, CreateMilestoneInput,
  CreateLabelInput,
  ClosingPrState, RequiredChecksInfo, RulesetChecksInfo,
  ReportedCheck,
} from './github-api';
import {
  AutoMergeUnavailableError,
  mergeRequiredChecks,
  DEFAULT_MERGE_METHOD,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type PrMergeability,
  type AutoMergeSetting,
} from '../../host-pr';
import { defaultGitHubHttp, type GitHubHttp, type GitHubHttpResponse } from './github-http';

const API = 'https://api.github.com';

/** A non-success GitHub response. `status` is the HTTP code; `op` the failed operation. */
export class GitHubApiError extends Error {
  constructor(readonly status: number, readonly op: string, message?: string) {
    super(message ?? `GitHub ${op} failed (HTTP ${status})`);
    this.name = 'GitHubApiError';
  }
}

// ─── ADR-0023 spikes: pinned constants ───────────────────────────────────────
//
// Both ADR-0023 build-slice spikes are resolved HERE, as named constants with
// source notes + the fixture tests in real-github-api.spec.ts that pin the
// routing they drive. Following the RealLinearApi precedent (ADR-0020): a
// schema/behaviour assumption that cannot be observed without live credentials
// is pinned as a named constant, flagged for e2e verification, and given a
// tolerant matcher so a cosmetic upstream reword cannot silently break routing.

/**
 * SPIKE 2 — the exact error shape of arming an ALREADY-CLEAN PR.
 *
 * GraphQL `enablePullRequestAutoMerge` on a PR with nothing pending does NOT
 * return a non-200: it returns **HTTP 200 with an `errors[]` entry** of
 * `type: "UNPROCESSABLE"` and this message. (Same refusal `gh pr merge --auto`
 * surfaces on a clean PR — the undocumented fallback ADR-0023 declined to
 * reverse-engineer. flotilla instead decides `clean → merge` up front, and keeps
 * this mapping only as the recovery for a mergeability the host had not yet
 * computed; see `decideArmAction('unknown')`.)
 *
 * Matched via {@link CLEAN_STATUS_RE}, not by equality — see that regex.
 *
 * e2e-verify: assert a live arm of a clean PR still returns this message.
 */
export const ARM_CLEAN_STATUS_ERROR = 'Pull request is in clean status';

/**
 * SPIKE 2 (companion) — arming when the repo forbids auto-merge. Also HTTP 200 +
 * `errors[].type: "UNPROCESSABLE"`. This is the runtime face of the precondition
 * the host-preflight probes via `getAutoMergeSetting()` — GitHub ships "Allow
 * auto-merge" OFF by default (ADR-0023 amendment re-homed the probe to `host-pr
 * preflight`).
 *
 * e2e-verify: assert a live arm against an auto-merge-disabled repo matches.
 */
export const ARM_NOT_ALLOWED_ERROR = 'Auto merge is not allowed for this repository';

/**
 * SPIKE 1 — the GraphQL `errors[].type` returned when the token lacks the
 * permission for the arm mutation (message: "Resource not accessible by
 * personal access token"). Mapped to a plain {@link GitHubApiError} that names
 * the fix, NOT to {@link AutoMergeUnavailableError}: a credentials failure must
 * never route into the clean-status → merge recovery, which would land a PR
 * whose checks are still pending.
 */
export const ARM_FORBIDDEN_ERROR_TYPE = 'FORBIDDEN';

/**
 * SPIKE 1 — the token shape that can arm.
 *
 *   - **Classic PAT**: the `repo` scope. This is the live-proven path (ADR-0023;
 *     runs 1–4 landed under a classic PAT).
 *   - **Fine-grained PAT**: `Pull requests: Read and write` (the arm mutation +
 *     the merge) and `Contents: Read and write` (writing the merge commit to the
 *     protected branch). Fine-grained PATs *do* reach `POST /graphql` — they
 *     could not at their 2022 launch, which is the origin of the "fine-grained
 *     PATs don't do GraphQL" folklore this spike existed to settle; GitHub added
 *     GraphQL support for them, so the arm mutation is reachable.
 *
 * `e2eVerified: false` is deliberate and load-bearing: this is pinned from
 * GitHub's documented behaviour, NOT from a live fine-grained-PAT arm — the
 * build slice has no live credentials. The live §6-style confirmation belongs to
 * the FOR-27 `--auto` run. Flip to `true` only with a real transcript.
 */
export const ARM_TOKEN_REQUIREMENTS = {
  classicPatScopes: ['repo'],
  fineGrainedPermissions: {
    'Pull requests': 'read-write',
    Contents: 'read-write',
  },
  fineGrainedSupportsGraphql: true,
  e2eVerified: false,
} as const;

/**
 * Tolerant matcher for {@link ARM_CLEAN_STATUS_ERROR}. Case-insensitive and
 * anchored on the two load-bearing words, so "Pull Request is in Clean Status."
 * still routes. Equality-matching an upstream human-readable string would turn a
 * cosmetic reword into a silently-wrong merge decision.
 */
const CLEAN_STATUS_RE = /clean\s+status/i;

/** Tolerant matcher for {@link ARM_NOT_ALLOWED_ERROR}. */
const NOT_ALLOWED_RE = /auto[-\s]?merge is not allowed/i;

/** REST `mergeable_state` → the host-neutral {@link PrMergeability} vocabulary. */
const MERGEABLE_STATE: Record<string, PrMergeability> = {
  clean: 'clean',
  blocked: 'blocked',
  unstable: 'unstable',
  behind: 'behind',
  dirty: 'dirty',
  draft: 'draft',
  unknown: 'unknown',
};

/**
 * GitHub's own validation-error code for "another resource already has this
 * value" — the answer a duplicate `POST …/labels` gets
 * (docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api,
 * read 2026-09-03: `already_exists` — "Another resource has the same value as
 * one of your parameters… resources requiring unique keys, like label names").
 *
 * Pinned as a NAMED CONSTANT with a TOLERANT companion matcher, the ADR-0020
 * precedent for a schema fact that cannot be observed without live credentials:
 * the machine `code` is the primary read and the human `message` a secondary
 * one, so a cosmetic upstream reword cannot turn an already-existing label back
 * into a hard failure — the one outcome {@link GitHubApi.createLabel}'s
 * contract forbids.
 */
const VALIDATION_CODE_ALREADY_EXISTS = 'already_exists';

/** True when a 422 body says the resource already exists. See {@link VALIDATION_CODE_ALREADY_EXISTS}. */
function saysAlreadyExists(json: unknown): boolean {
  const errors = (json as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const code = (entry as { code?: unknown } | null)?.code;
      if (code === VALIDATION_CODE_ALREADY_EXISTS) return true;
    }
  }
  // Secondary, deliberately tolerant: some validation failures carry the fact
  // only in the human message. Never the primary read — see the constant.
  const message = (json as { message?: unknown } | null)?.message;
  return typeof message === 'string' && /already exists/i.test(message);
}

/** {@link MergeMethod} → the GraphQL `PullRequestMergeMethod` enum. */
const GQL_MERGE_METHOD: Record<MergeMethod, string> = {
  squash: 'SQUASH',
  merge: 'MERGE',
  rebase: 'REBASE',
};

export class RealGitHubApi implements GitHubApi {
  constructor(
    private readonly owner: string,
    private readonly repo: string,
    private readonly token: string,
    private readonly http: GitHubHttp = defaultGitHubHttp(),
  ) {}

  private base(): string {
    return `/repos/${this.owner}/${this.repo}`;
  }

  private send(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<GitHubHttpResponse> {
    return this.http.request({
      method,
      url: `${API}${path}`,
      token: this.token,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Verify the token before any wave op (ADR-0019 construction preflight). */
  async preflight(): Promise<void> {
    const res = await this.send('GET', '/user');
    if (res.status !== 200) {
      throw new GitHubApiError(res.status, 'preflight', `GITHUB_TOKEN rejected (GET /user → ${res.status})`);
    }
  }

  async createIssue(input: CreateIssueInput): Promise<{ number: number }> {
    const res = await this.send('POST', `${this.base()}/issues`, {
      title: input.title, body: input.body, labels: input.labels,
    });
    if (res.status !== 201) throw new GitHubApiError(res.status, 'createIssue');
    return { number: Number((res.json as Record<string, unknown>).number) };
  }

  async getIssue(number: number): Promise<GhIssue> {
    const res = await this.send('GET', `${this.base()}/issues/${number}`);
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getIssue');
    return toGhIssue(res.json);
  }

  async listOpenIssues(): Promise<GhIssue[]> {
    const out: GhIssue[] = [];
    for (let page = 1; ; page++) {
      const res = await this.send('GET', `${this.base()}/issues?state=open&per_page=100&page=${page}`);
      if (res.status !== 200) throw new GitHubApiError(res.status, 'listOpenIssues');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (it.pull_request) continue; // the issues endpoint also lists PRs — drop them
        out.push(toGhIssue(it));
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  async setBody(number: number, body: string): Promise<void> {
    const res = await this.send('PATCH', `${this.base()}/issues/${number}`, { body });
    if (res.status !== 200) throw new GitHubApiError(res.status, 'setBody');
  }

  async setTitle(number: number, title: string): Promise<void> {
    const res = await this.send('PATCH', `${this.base()}/issues/${number}`, { title });
    if (res.status !== 200) throw new GitHubApiError(res.status, 'setTitle');
  }

  async addLabel(number: number, label: string): Promise<void> {
    const res = await this.send('POST', `${this.base()}/issues/${number}/labels`, { labels: [label] });
    if (res.status !== 200) throw new GitHubApiError(res.status, 'addLabel');
  }

  async removeLabel(number: number, label: string): Promise<void> {
    const res = await this.send('DELETE', `${this.base()}/issues/${number}/labels/${encodeURIComponent(label)}`);
    if (res.status !== 200 && res.status !== 404) throw new GitHubApiError(res.status, 'removeLabel');
    // 404 = label already absent → idempotent no-op (the GitHubApi contract).
  }

  async listLabels(): Promise<string[]> {
    // The repo's label REGISTRY (`GET /repos/{o}/{r}/labels`) — a distinct
    // endpoint from the per-issue label lists above. PAGINATED like
    // listOpenIssues; the store-preflight (issue #131) needs the full set, not
    // just the first page, or a large label set would silently under-report.
    const out: string[] = [];
    for (let page = 1; ; page++) {
      const res = await this.send('GET', `${this.base()}/labels?per_page=100&page=${page}`);
      if (res.status !== 200) throw new GitHubApiError(res.status, 'listLabels');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (typeof it.name === 'string') out.push(it.name);
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  async createLabel(input: CreateLabelInput): Promise<{ created: boolean }> {
    // The registry's WRITE half (`POST /repos/{o}/{r}/labels` → 201 Created;
    // docs.github.com/en/rest/issues/labels, read 2026-09-03). `description` is
    // OMITTED from the payload rather than sent as `null` when the caller has
    // none, so an absent description stays absent instead of blanking one.
    const res = await this.send('POST', `${this.base()}/labels`, {
      name: input.name,
      color: input.color,
      ...(input.description === undefined ? {} : { description: input.description }),
    });
    if (res.status === 201) return { created: true };
    // 422 `already_exists` = the label was created between the caller's probe
    // and this write (or was always there). The seam's contract calls that a
    // PRESENT label, so it is ANSWERED (`created: false`), never thrown — a
    // concurrent creator must not fail a preflight repair.
    if (res.status === 422 && saysAlreadyExists(res.json)) return { created: false };
    throw new GitHubApiError(res.status, 'createLabel');
  }

  async addComment(number: number, body: string): Promise<void> {
    const res = await this.send('POST', `${this.base()}/issues/${number}/comments`, { body });
    if (res.status !== 201) throw new GitHubApiError(res.status, 'addComment');
  }

  async getComments(number: number): Promise<{ body: string }[]> {
    const out: { body: string }[] = [];
    for (let page = 1; ; page++) {
      const res = await this.send('GET', `${this.base()}/issues/${number}/comments?per_page=100&page=${page}`);
      if (res.status !== 200) throw new GitHubApiError(res.status, 'getComments');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) out.push({ body: typeof it.body === 'string' ? it.body : '' });
      if (items.length < 100) break;
    }
    return out;
  }

  // ─── Goal facet substrate (ADR-0044): milestones ────────────────────────
  //
  // Documented form, all four endpoints read 2026-08-15:
  //   docs.github.com/en/rest/issues/milestones  — create (201), get (200),
  //     list (200, `state` defaults to `open`, `per_page` max 100)
  //   docs.github.com/en/rest/issues/issues      — the `milestone` QUERY param on
  //     "List repository issues" ("If an integer is passed, it should refer to a
  //     milestone by its `number` field") and the `milestone` BODY field on
  //     "Update an issue" ("The number of the milestone to associate this issue
  //     with", 200).
  //
  // UNPROVEN LIVE — the writes need a credential this slice does not have, and
  // the reads were not probed either (ADR-0030's declared-unexecutable path; the
  // divergence report rides the row's own disclosure). The first `goal` station
  // run on a github-store consumer is the live gate, the same stance
  // {@link addBlockedBy} records for its own mirror.

  async createMilestone(input: CreateMilestoneInput): Promise<{ number: number }> {
    const res = await this.send('POST', `${this.base()}/milestones`, {
      title: input.title,
      description: input.description,
    });
    // 201, not 200 — the create endpoints in this file are consistent about it.
    if (res.status !== 201) {
      throw new GitHubApiError(res.status, 'createMilestone', ghMessage(res.json, 'createMilestone'));
    }
    return { number: Number((res.json as Record<string, unknown>).number) };
  }

  async getMilestone(number: number): Promise<GhMilestone> {
    const res = await this.send('GET', `${this.base()}/milestones/${number}`);
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getMilestone');
    return toGhMilestone(res.json);
  }

  async listMilestones(): Promise<GhMilestone[]> {
    const out: GhMilestone[] = [];
    for (let page = 1; ; page++) {
      // `state=all` is load-bearing: the endpoint defaults to `open`, and a goal
      // panel that dropped closed finish lines would make shipped goals vanish.
      //
      // `sort` and `direction` are DELIBERATELY left unpinned, and this comment
      // is the acceptance rather than a to-do. "List milestones"
      // (docs.github.com/en/rest/issues/milestones, re-read 2026-08-15)
      // documents `sort` as `due_on | completeness`, **default `due_on`**, and
      // `direction` as `asc | desc`, **default `asc`** — so this query INHERITS
      // the vendor's ordering and would follow it if GitHub ever changed it.
      // Accepted because order is IMMATERIAL to the facet: `listGoals` answers
      // a SET of finish lines, `GoalView` carries no rank, and the frontier
      // reads membership rather than position. Pinning a server-side sort would
      // be a promise the contract does not make, and a caller that wants an
      // order sorts the result itself — the ordinary discipline everywhere else
      // in this adapter. `per_page` is a different question and IS pinned: the
      // documented default is 30 against a max of 100, and that one is about
      // round-trips, not order.
      const res = await this.send(
        'GET',
        `${this.base()}/milestones?state=all&per_page=100&page=${page}`,
      );
      if (res.status !== 200) throw new GitHubApiError(res.status, 'listMilestones');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) out.push(toGhMilestone(it));
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  /**
   * Set an issue's milestone — the Goal facet's JOIN, and only the join.
   *
   * DELIBERATE DEPARTURE from the documented form. "Update an issue"
   * (docs.github.com/en/rest/issues/issues, re-read 2026-08-15) types the
   * `milestone` body field as **"null or string or integer"** and documents it
   * as *"The number of the milestone to associate this issue with or use null
   * to remove the current milestone."* The `null` UN-ASSIGN arm is realized by
   * nothing here — and the signature makes it UNREACHABLE rather than merely
   * unused: `milestoneNumber` is a `number`, so no caller can express the null
   * form even by accident.
   *
   * That is the facet's shape, not an oversight. ADR-0044 gives the Goal facet
   * a join verb and no LEAVE verb, on the same line that keeps `closeGoal` off
   * the seam: curation-leave is the Operator's act in the tracker, and a
   * facet-side unassign is its own engine slice with its own design pass (who
   * may remove a member, on whose authority, and what the frontier reports
   * mid-leave) — not a passthrough this method can quietly grow. Widening the
   * parameter to `number | null` is therefore a CONTRACT change, not a
   * convenience, and belongs to that slice.
   */
  async setIssueMilestone(issueNumber: number, milestoneNumber: number): Promise<void> {
    const res = await this.send('PATCH', `${this.base()}/issues/${issueNumber}`, {
      milestone: milestoneNumber,
    });
    if (res.status !== 200) {
      throw new GitHubApiError(res.status, 'setIssueMilestone', ghMessage(res.json, 'setIssueMilestone'));
    }
  }

  async listMilestoneIssues(milestoneNumber: number): Promise<GhIssue[]> {
    // A missing milestone must FAIL rather than read as an empty goal: the list
    // endpoint below answers 200 + `[]` for a milestone number that does not
    // exist on some responses, and "no members" and "no such goal" are different
    // claims — the same absent-vs-broken line the create classifier draws. So
    // the milestone is resolved first, and its 404 is the one that surfaces.
    await this.getMilestone(milestoneNumber);
    const out: GhIssue[] = [];
    for (let page = 1; ; page++) {
      // `state=all` for the same reason `listMilestones` uses it, one level down:
      // `done` is a frontier reading, so closed members must come back.
      const res = await this.send(
        'GET',
        `${this.base()}/issues?milestone=${milestoneNumber}&state=all&per_page=100&page=${page}`,
      );
      if (res.status !== 200) throw new GitHubApiError(res.status, 'listMilestoneIssues');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (it.pull_request) continue; // the issues endpoint also lists PRs — drop them
        out.push(toGhIssue(it));
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  async nativeClose(number: number, reason: GhStateReason = 'completed'): Promise<void> {
    const body: Record<string, unknown> = { state: 'closed' };
    if (reason === 'completed' || reason === 'not_planned') body.state_reason = reason;
    const res = await this.send('PATCH', `${this.base()}/issues/${number}`, body);
    if (res.status !== 200) throw new GitHubApiError(res.status, 'nativeClose');
  }

  /**
   * The native blocked-by READ half. `GET …/issues/{n}/dependencies/blocked_by`
   * answers 200 with an array of full issue objects; only their `number` is
   * projected out (the store's own identity, ADR-0001).
   *
   * PAGINATED like {@link listOpenIssues} and {@link listLabels} (`per_page`
   * default 30, max 100) and paged to exhaustion by the same short-page count
   * heuristic — a truncated blocker list would silently UNBLOCK a row at the DoR
   * gate, the exact correctness hole the read-union exists to close.
   *
   * Documented form: docs.github.com/en/rest/issues/issue-dependencies, read
   * 2026-08-03. Live-confirmed 2026-08-03 against this repo — an unauthenticated
   * `GET /repos/formtrieb/flotilla/issues/380/dependencies/blocked_by?per_page=
   * 100&page=1` answered 200 with `[]` under the `X-GitHub-Api-Version:
   * 2022-11-28` this adapter's HTTP seam pins (the doc page's own curl example
   * shows `2026-03-10`; the endpoint is reachable under both, so the seam-wide
   * pin is deliberately left alone by this slice).
   */
  async getBlockedBy(number: number): Promise<number[]> {
    const out: number[] = [];
    for (let page = 1; ; page++) {
      const res = await this.send(
        'GET',
        `${this.base()}/issues/${number}/dependencies/blocked_by?per_page=100&page=${page}`,
      );
      if (res.status !== 200) throw new GitHubApiError(res.status, 'getBlockedBy');
      const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
      for (const it of items) {
        const n = Number(it.number);
        if (Number.isInteger(n)) out.push(n);
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  /**
   * The native blocked-by WRITE half (best-effort mirror; the store swallows a
   * throw per-ref). Two calls, in this order:
   *
   *   1. resolve the BLOCKER's DATABASE id — the dependency endpoints are keyed
   *      by `id`, NOT by `number`, and the two are different values on the same
   *      issue object. Doing this read first also makes an unknown blocker fail
   *      BEFORE any write is attempted.
   *   2. `POST …/issues/{blockedNumber}/dependencies/blocked_by` with
   *      `{ issue_id }` — "The id of the issue that blocks the current issue" —
   *      which the docs pin at **201**, not 200.
   *
   * ADDITIVE-ONLY by construction: this method has no delete/update branch
   * (ADR-0020 — never remove a dependency), which is why the documented
   * `DELETE …/dependencies/blocked_by/{issue_id}` companion is not implemented.
   *
   * Documented form: docs.github.com/en/rest/issues/issue-dependencies, read
   * 2026-08-03. UNPROVEN LIVE — the write needs a credential this slice does not
   * have; the read half of the same endpoint family WAS live-confirmed (see
   * {@link getBlockedBy}). The first `wave-create` carrying a real blockedBy ref
   * on a github-store consumer is the live gate, the same stance
   * `RealLinearApi.addBlockedBy` records for its own mirror.
   */
  async addBlockedBy(blockedNumber: number, blockerNumber: number): Promise<void> {
    const blockerId = await this.issueDatabaseId(blockerNumber);
    const res = await this.send(
      'POST',
      `${this.base()}/issues/${blockedNumber}/dependencies/blocked_by`,
      { issue_id: blockerId },
    );
    if (res.status !== 201) {
      throw new GitHubApiError(res.status, 'addBlockedBy', ghMessage(res.json, 'addBlockedBy'));
    }
  }

  /**
   * An issue's DATABASE id (`id`) from its number — the key the dependency
   * endpoints take. Kept private: the seam speaks issue numbers, so the database
   * id never leaves this file (the same containment `RealLinearApi` gives
   * Linear's UUIDs).
   */
  private async issueDatabaseId(number: number): Promise<number> {
    const res = await this.send('GET', `${this.base()}/issues/${number}`);
    if (res.status !== 200) {
      throw new GitHubApiError(res.status, 'addBlockedBy', ghMessage(res.json, 'addBlockedBy'));
    }
    const id = Number((res.json as Record<string, unknown>)?.id);
    if (!Number.isInteger(id)) {
      throw new GitHubApiError(
        res.status,
        'addBlockedBy',
        `issue #${number} carries no database id — cannot key the dependency write`,
      );
    }
    return id;
  }

  async getClosingState(number: number): Promise<ClosingPrState> {
    const query =
      'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){state closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{merged url}}}}}';
    const res = await this.send('POST', '/graphql', { query, variables: { owner: this.owner, repo: this.repo, number } });
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getClosingState');
    const body = res.json as Record<string, unknown>;
    if (body && body.errors) {
      throw new GitHubApiError(res.status, 'getClosingState', `GraphQL error: ${JSON.stringify(body.errors)}`);
    }
    const issue = graphqlIssue(res.json);
    if (issue === null) throw new GitHubApiError(res.status, 'getClosingState', `issue #${number} not found`);
    if (issue.state === 'OPEN') return { state: 'open' };
    const merged = issue.nodes.find((n) => n.merged);
    if (merged) return merged.url ? { state: 'merged', prUrl: merged.url } : { state: 'merged' };
    // Closed, no merged PR. Distinguish PROVEN rejection from absence of evidence
    // (W2-F1c): a closing-PR reference that did not merge is `closed-unmerged`; a
    // closed issue with NO reference at all (closed by hand, as a duplicate, via a
    // foreign-id mention, or on a repo whose PR was never linked) is
    // `closed-unknown` — never a rejection the probe cannot prove.
    if (issue.nodes.length === 0) return { state: 'closed-unknown' };
    return { state: 'closed-unmerged' };
  }

  /**
   * Store-preflight (FOR-12): whether the token can merge PRs on the bound repo.
   * `GET /repos/{o}/{r}` returns a `permissions` object for the authenticated
   * user; write access (`push`) or higher (`maintain`/`admin`) is what a PR
   * merge needs. e2e-verify: the `permissions` object is present on the repo
   * response for a token-authenticated GET (it is for user tokens; a fine-grained
   * token with only issues:read would report `push:false`, which is exactly the
   * case this probe exists to surface).
   */
  async canMergePullRequests(): Promise<boolean> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) throw new GitHubApiError(res.status, 'canMergePullRequests');
    const perms = (res.json as Record<string, unknown>)?.permissions as Record<string, unknown> | undefined;
    if (!perms) return false;
    return perms.push === true || perms.maintain === true || perms.admin === true;
  }

  // ─── Landing (ADR-0023) ────────────────────────────────────────────────

  /**
   * Branch → the PR's landing state. Two REST calls, and only when needed:
   *
   *   1. `GET …/pulls?head={owner}:{branch}&state=all` — resolves the PR. The
   *      LIST payload does not carry `mergeable_state` (GitHub computes
   *      mergeability lazily, per-PR), so it cannot answer the arm question.
   *   2. `GET …/pulls/{n}` — only for an OPEN PR, only to read `mergeable_state`.
   *      A merged / closed PR short-circuits after call 1 (nothing to decide).
   *
   * Selection when a branch has several PRs: an OPEN one wins (it is the only
   * actionable one), then a MERGED one (a merge is the stronger evidence for the
   * done-reconcile hierarchy), then closed-unmerged.
   *
   * The OPEN case additionally reports the PR's `headSha` and `baseRef` when the
   * detail payload carries them — the two coordinates the arm verb's check-ATTACH
   * comparison needs (which COMMIT to ask for reports about, and which branch's
   * required checks are in force). Both come out of call 2, which was already being
   * made for `mergeable_state`, so this costs no extra request; both keys stay
   * ABSENT when the payload omits them, so a host/fixture that does not surface
   * them yields the exact shape this method always returned.
   */
  async getPrStatus(branch: string): Promise<PrLandingStatus> {
    const head = `${this.owner}:${branch}`;
    const res = await this.send(
      'GET',
      `${this.base()}/pulls?head=${encodeURIComponent(head)}&state=all&per_page=100&sort=created&direction=desc`,
    );
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getPrStatus', ghMessage(res.json, 'getPrStatus'));

    const items = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
    if (items.length === 0) return { state: 'none' };

    const open = items.find((p) => p.state === 'open');
    if (open === undefined) {
      const merged = items.find((p) => p.merged_at != null);
      const chosen = merged ?? items[0];
      return {
        state: merged !== undefined ? 'merged' : 'closed-unmerged',
        number: Number(chosen.number),
        url: typeof chosen.html_url === 'string' ? chosen.html_url : undefined,
      };
    }

    const number = Number(open.number);
    const url = typeof open.html_url === 'string' ? open.html_url : undefined;
    const detail = await this.send('GET', `${this.base()}/pulls/${number}`);
    if (detail.status !== 200) {
      throw new GitHubApiError(detail.status, 'getPrStatus', ghMessage(detail.json, 'getPrStatus'));
    }
    return {
      state: 'open',
      number,
      url,
      mergeability: toMergeability(detail.json),
      ...prRefs(detail.json),
    };
  }

  /**
   * The checks GitHub has REPORTED for `ref` — the arm verb's check-ATTACH input
   * (2026-07-30 live occurrences). BOTH sources a required status-check context can
   * be satisfied by are folded into one list, because GitHub matches a required
   * context against either:
   *
   *   1. `GET /repos/{o}/{r}/commits/{ref}/check-runs` — GitHub Actions and every
   *      other Checks-API app. Response: `{ total_count, check_runs: [{ name,
   *      status, conclusion }] }`. `filter` is passed as `latest` EXPLICITLY even
   *      though that is the documented default, so one re-run cannot turn into two
   *      reports if the default ever changes.
   *   2. `GET /repos/{o}/{r}/commits/{ref}/status` — the legacy commit-status API
   *      (external CI). Response: `{ state, statuses: [{ context, state }], … }`.
   *
   * `ref` is a commit SHA, or a branch in GitHub's documented `heads/<branch>` form
   * — its slashes are path separators GitHub matches on, so each segment is encoded
   * individually while the slashes survive (the same treatment `deleteBranch` gives
   * a ref path).
   *
   * PAGINATION CONTRACT (issue #263, closed by issue #287): BOTH sources are
   * paginated to exhaustion, not just the check-runs source. Confirmed against
   * GitHub's own REST reference for "Get the combined status for a specific
   * reference" (docs.github.com/en/rest/commits/statuses, read 2026-07-30): the
   * endpoint documents standard `page`/`per_page` parameters (`per_page` max 100,
   * default 30) with no stated hard cap on `statuses` that would make pagination
   * unnecessary or unsafe — the same shape as the check-runs source, so it is read
   * the identical way (`per_page=100`, loop until a short page). A cap on one
   * source paired with exhaustive pagination on its sibling would silently
   * under-report every legacy commit status past the first page.
   *
   * THROWS on a non-200, deliberately, against the report-only stance of the
   * posture probes next to it: an empty result is EVIDENCE that nothing has attached
   * to this commit yet, and that is the one input that forces the arm verb away from
   * a direct merge — so a failed read must not be able to counterfeit it. The arm
   * catches the throw and treats it as "no evidence", i.e. unchanged behaviour.
   */
  async getReportedChecks(ref: string): Promise<ReportedCheck[]> {
    const path = ref.split('/').map(encodeURIComponent).join('/');
    const out: ReportedCheck[] = [];

    for (let page = 1; ; page++) {
      const res = await this.send('GET', `${this.base()}/commits/${path}/check-runs?filter=latest&per_page=100&page=${page}`);
      if (res.status !== 200) {
        throw new GitHubApiError(res.status, 'getReportedChecks', ghMessage(res.json, 'getReportedChecks'));
      }
      const runs = (res.json as Record<string, unknown>)?.check_runs;
      const items = Array.isArray(runs) ? (runs as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (typeof it.name !== 'string' || it.name.length === 0) continue;
        out.push({ name: it.name, state: toCheckRunState(it) });
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }

    for (let page = 1; ; page++) {
      const res = await this.send('GET', `${this.base()}/commits/${path}/status?per_page=100&page=${page}`);
      if (res.status !== 200) {
        throw new GitHubApiError(res.status, 'getReportedChecks', ghMessage(res.json, 'getReportedChecks'));
      }
      const statuses = (res.json as Record<string, unknown>)?.statuses;
      const items = Array.isArray(statuses) ? (statuses as Record<string, unknown>[]) : [];
      for (const it of items) {
        if (typeof it.context !== 'string' || it.context.length === 0) continue;
        out.push({ name: it.context, state: toCommitStatusState(it.state) });
      }
      if (items.length < 100) break; // short page → exhausted (count heuristic, ADR-0019)
    }
    return out;
  }

  /**
   * Merge a PR now — REST `PUT /repos/{o}/{r}/pulls/{n}/merge`, the exact call
   * that landed run 1. A 200 with `merged:false` is a host DECISION and is
   * returned (the caller normalises it to `refused`); every non-200 is a typed
   * throw carrying GitHub's own message (405 "not mergeable", 409 "head branch
   * was modified" — both things an operator must read verbatim).
   */
  async mergePullRequest(prNumber: number, method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<MergeResult> {
    const res = await this.send('PUT', `${this.base()}/pulls/${prNumber}/merge`, { merge_method: method });
    if (res.status !== 200) {
      throw new GitHubApiError(res.status, 'mergePullRequest', ghMessage(res.json, 'mergePullRequest'));
    }
    const o = (res.json ?? {}) as Record<string, unknown>;
    if (o.merged !== true) return { merged: false };
    return typeof o.sha === 'string' ? { merged: true, sha: o.sha } : { merged: true };
  }

  /**
   * Delete a remote branch — REST `DELETE /repos/{o}/{r}/git/refs/heads/{branch}`
   * (204 No Content on success). The `host-pr merge --delete-branch` hygiene step
   * (consumer KW-F6), called only after a successful merge. Throws a typed
   * {@link GitHubApiError} on any non-204 so the merge path records the failure
   * STRUCTURALLY — e.g. a 422 "Reference does not exist" (the branch is already
   * gone) surfaces as a reported degradation, never a merge failure.
   *
   * The branch is interpolated as a REF PATH: a `wave/FOR-xx` branch's slashes
   * are path separators GitHub matches on, so each segment is encoded
   * individually (odd characters within a segment are escaped) while the slashes
   * are preserved.
   */
  async deleteBranch(branch: string): Promise<void> {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.send('DELETE', `${this.base()}/git/refs/heads/${ref}`);
    // GitHub returns 204 on a successful ref delete; tolerate a 200 defensively.
    if (res.status !== 204 && res.status !== 200) {
      throw new GitHubApiError(res.status, 'deleteBranch', ghMessage(res.json, 'deleteBranch'));
    }
  }

  /**
   * Arm a PR to merge itself once its checks pass — GraphQL
   * `enablePullRequestAutoMerge`. GraphQL because **REST has no arming
   * endpoint** at all (the ADR-0019 "GraphQL only where REST is weak" pattern,
   * same seam as the closing probe).
   *
   * Two calls: the mutation addresses a PR by GraphQL node id, so `GET
   * …/pulls/{n}` resolves `node_id` first.
   *
   * Error mapping is the load-bearing part — GraphQL reports all three of these
   * as **HTTP 200 with `errors[]`**:
   *   - clean-status  → {@link AutoMergeUnavailableError}('clean-status') — the
   *     caller merges instead (SPIKE 2).
   *   - not-allowed   → {@link AutoMergeUnavailableError}('not-allowed') — the
   *     caller REFUSES (never merges: checks may still be pending).
   *   - FORBIDDEN / anything else → {@link GitHubApiError}, so a credentials or
   *     unknown failure can never be mistaken for a landing decision.
   */
  async enableAutoMerge(prNumber: number, method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<void> {
    const pr = await this.send('GET', `${this.base()}/pulls/${prNumber}`);
    if (pr.status !== 200) {
      throw new GitHubApiError(pr.status, 'enableAutoMerge', ghMessage(pr.json, 'enableAutoMerge'));
    }
    const nodeId = (pr.json as Record<string, unknown>)?.node_id;
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new GitHubApiError(pr.status, 'enableAutoMerge', `PR #${prNumber} carries no node_id — cannot address the auto-merge mutation`);
    }

    const query =
      'mutation($pullRequestId:ID!,$mergeMethod:PullRequestMergeMethod!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:$mergeMethod}){pullRequest{number autoMergeRequest{enabledAt}}}}';
    const res = await this.send('POST', '/graphql', {
      query,
      variables: { pullRequestId: nodeId, mergeMethod: GQL_MERGE_METHOD[method] },
    });
    if (res.status !== 200) {
      throw new GitHubApiError(res.status, 'enableAutoMerge', ghMessage(res.json, 'enableAutoMerge'));
    }

    const errors = (res.json as Record<string, unknown>)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw mapArmError(errors as Record<string, unknown>[], res.status, prNumber);
    }
  }

  /**
   * ADR-0023 (amendment) posture probe: the repo's "Allow auto-merge" setting, as
   * the ambient token can OBSERVE it. `GET /repos/{o}/{r}` carries `allow_auto_merge`
   * only for maintain/admin tokens — below that GitHub omits the field entirely.
   * So the three cases are distinct and each load-bearing:
   *   - field present, `true`  → `'on'`
   *   - field present, `false` → `'off'`  (a VISIBLE off — the confirm can act on it)
   *   - field ABSENT           → `'unknown'`  (the token cannot see it; NOT "off")
   * Conflating absent with off (the pre-amendment behaviour) wrongly flagged an
   * external consumer's read-scoped token as a hard precondition failure — the
   * `closed-unknown` lesson at the settings layer: absence of evidence is not a
   * finding, and no consumer token must ever NEED admin (ADR-0023 amendment).
   */
  async getAutoMergeSetting(): Promise<AutoMergeSetting> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getAutoMergeSetting', ghMessage(res.json, 'getAutoMergeSetting'));
    // Value-based, NOT `'x' in o` (which throws on a non-object body): a present
    // boolean is on/off; anything else — the field is ABSENT (undefined) because
    // the token cannot see it below maintain/admin — is `unknown`, never off.
    const v = (res.json as Record<string, unknown>)?.allow_auto_merge;
    if (v === true) return 'on';
    if (v === false) return 'off';
    return 'unknown';
  }

  /**
   * ADR-0023 report-only probe: does `branch` (default: the repo's default
   * branch) carry required status checks?
   *
   * Reads BOTH sources and merges them (2026-07-23 gate-arm gap, doc slug
   * 2026-07-23-ci-gate-arm): the effective-rules endpoint (ruleset-aware, needs
   * no admin) via {@link getRulesetRequiredChecks}, and the legacy
   * branch-protection endpoint (admin-gated, ruleset-blind) via
   * {@link legacyRequiredChecks}. `mergeRequiredChecks` (host-pr, single owner)
   * reconciles them: either source finding checks → `present`, and a readable
   * effective-rules answer lets a non-admin token reach `absent` instead of the
   * legacy admin-403 `unknown`.
   *
   * **Never throws** — that is a contract, not defensiveness. This probe is
   * advisory (a no-CI repo keeps `--auto`), so any failure to read it must
   * degrade to `unknown`, never block the preflight. Both underlying reads are
   * themselves throw-free; the outer guard is a final safety net (e.g. the
   * default-branch resolve).
   */
  async getRequiredChecks(branch?: string): Promise<RequiredChecksInfo> {
    try {
      const target = branch ?? (await this.defaultBranch());
      // Resolve the branch ONCE, then read both endpoints against it (the ruleset
      // read is passed the concrete target so it never re-resolves the default).
      const legacy = await this.legacyRequiredChecks(target);
      const ruleset = await this.getRulesetRequiredChecks(target);
      return mergeRequiredChecks(target, legacy, ruleset);
    } catch (err) {
      return {
        state: 'unknown',
        contexts: [],
        detail: `Could not probe required checks: ${(err as Error).message ?? String(err)}. Advisory only — the wave is not blocked.`,
      };
    }
  }

  /**
   * The LEGACY required-status-checks read — classic branch protection
   * (`GET .../branches/{b}/protection/required_status_checks`). Admin-gated and
   * ruleset-blind; kept ONLY as the fallback source `getRequiredChecks` merges
   * with the effective-rules read. Throw-free by the same report-only contract:
   *   200 → contexts (legacy `contexts[]` or newer `checks[].context`)
   *   404 → the branch carries no classic protection → `absent`
   *   403 → admin-gated → `unknown` (the defect the effective-rules read routes around)
   */
  private async legacyRequiredChecks(target: string): Promise<RequiredChecksInfo> {
    const res = await this.send('GET', `${this.base()}/branches/${encodeURIComponent(target)}/protection/required_status_checks`);
    if (res.status === 404) {
      return { state: 'absent', contexts: [], detail: `Branch '${target}' carries no classic branch-protection required status checks.` };
    }
    if (res.status === 403) {
      return { state: 'unknown', contexts: [], detail: `Classic branch protection for '${target}' is admin-gated (HTTP 403).` };
    }
    if (res.status !== 200) {
      return { state: 'unknown', contexts: [], detail: `Could not read classic branch protection for '${target}' (HTTP ${res.status}).` };
    }
    const contexts = toContexts(res.json);
    return contexts.length > 0
      ? { state: 'present', contexts, detail: `Classic branch protection on '${target}' requires: ${contexts.join(', ')}.` }
      : { state: 'absent', contexts: [], detail: `Branch '${target}' has classic protection but requires no status checks.` };
  }

  /**
   * The RULESET required-status-checks read — GitHub's effective-rules endpoint
   * (`GET /repos/{o}/{r}/rules/branches/{branch}`; default: the repo's default
   * branch). It aggregates classic branch protection AND every active ruleset into
   * the rules in force, and needs only READ access — so it both SEES
   * ruleset-carried checks the legacy endpoint is blind to and never degrades to
   * the admin-403 `unknown` (2026-07-23 gate-arm gap).
   *
   * Report-only: NEVER throws; a non-200 / transport failure degrades to
   * `readable:false` (contributes no evidence — the merge falls back to legacy).
   * The response is an array of rule objects; every `type:"required_status_checks"`
   * rule carries the check contexts under `parameters.required_status_checks[].context`.
   */
  async getRulesetRequiredChecks(branch?: string): Promise<RulesetChecksInfo> {
    try {
      const target = branch ?? (await this.defaultBranch());
      const res = await this.send('GET', `${this.base()}/rules/branches/${encodeURIComponent(target)}`);
      if (res.status !== 200) {
        return { readable: false, contexts: [], detail: `Could not read the effective rules for '${target}' (HTTP ${res.status}). Advisory only.` };
      }
      const contexts = toRulesetContexts(res.json);
      return contexts.length > 0
        ? { readable: true, contexts, detail: `Active rulesets on '${target}' require: ${contexts.join(', ')}.` }
        : { readable: true, contexts: [], detail: `The effective rules on '${target}' require no status checks.` };
    } catch (err) {
      return { readable: false, contexts: [], detail: `Could not probe the effective rules: ${(err as Error).message ?? String(err)}. Advisory only.` };
    }
  }

  private async defaultBranch(): Promise<string> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) throw new GitHubApiError(res.status, 'getRequiredChecks', ghMessage(res.json, 'getRequiredChecks'));
    const b = (res.json as Record<string, unknown>)?.default_branch;
    return typeof b === 'string' && b.length > 0 ? b : 'main';
  }
}

/**
 * Route a GraphQL `errors[]` from the arm mutation onto the two typed refusals
 * the intent logic understands, or onto a loud {@link GitHubApiError}. Every
 * message is joined so a multi-error payload cannot hide the decisive one.
 */
function mapArmError(errors: Record<string, unknown>[], status: number, prNumber: number): Error {
  const messages = errors.map((e) => String(e.message ?? '')).join('; ');
  const types = errors.map((e) => String(e.type ?? ''));

  if (CLEAN_STATUS_RE.test(messages)) {
    return new AutoMergeUnavailableError('clean-status', messages || ARM_CLEAN_STATUS_ERROR);
  }
  if (NOT_ALLOWED_RE.test(messages)) {
    return new AutoMergeUnavailableError('not-allowed', messages || ARM_NOT_ALLOWED_ERROR);
  }
  if (types.includes(ARM_FORBIDDEN_ERROR_TYPE)) {
    // SPIKE 1: name the exact grant rather than echoing GitHub's opaque
    // "Resource not accessible by personal access token".
    return new GitHubApiError(
      status,
      'enableAutoMerge',
      `The token may not arm PR #${prNumber}: ${messages}. A classic PAT needs the '${ARM_TOKEN_REQUIREMENTS.classicPatScopes.join("', '")}' scope; ` +
        `a fine-grained PAT needs 'Pull requests: Read and write' and 'Contents: Read and write' on this repository (ADR-0023).`,
    );
  }
  return new GitHubApiError(status, 'enableAutoMerge', `GraphQL error: ${JSON.stringify(errors)}`);
}

/** Read a PR's mergeability. An unrecognised/absent state degrades to `unknown` — NEVER to `clean`. */
function toMergeability(json: unknown): PrMergeability {
  const o = (json ?? {}) as Record<string, unknown>;
  if (o.draft === true) return 'draft';
  const raw = typeof o.mergeable_state === 'string' ? o.mergeable_state : '';
  return MERGEABLE_STATE[raw] ?? 'unknown';
}

/**
 * A PR detail payload's `head.sha` + `base.ref`, as PRESENT-ONLY keys (an absent
 * one is omitted, never emitted as `undefined`) so a payload carrying neither
 * yields `{}` and `getPrStatus`'s shape is unchanged from before this read existed.
 */
function prRefs(json: unknown): { headSha?: string; baseRef?: string } {
  const o = (json ?? {}) as Record<string, unknown>;
  const sha = (o.head as Record<string, unknown> | undefined)?.sha;
  const ref = (o.base as Record<string, unknown> | undefined)?.ref;
  return {
    ...(typeof sha === 'string' && sha.length > 0 ? { headSha: sha } : {}),
    ...(typeof ref === 'string' && ref.length > 0 ? { baseRef: ref } : {}),
  };
}

/**
 * A check run → the normalised {@link ReportedCheck} state. `status` other than
 * `completed` (`queued`, `in_progress`, `waiting`, `requested`, `pending`) is
 * `pending`; a completed run is green for the three NON-BLOCKING conclusions —
 * `success`, plus `skipped` (GitHub: a skipped job "will report its status as
 * 'Success'. It will not prevent a pull request from merging, even if it is a
 * required check" — docs.github.com/en/pull-requests/reference/status-checks,
 * read 2026-07-30) and `neutral` (its other non-blocking conclusion, but a
 * WEAKER inference than `skipped`'s: the same page's conclusions table
 * describes `neutral` with wording IDENTICAL to `skipped`'s — "treated as a
 * success" — and its merge-blocking framing lists only `failure`, `timed_out`
 * and `action_required` as conclusions requiring review before merge, so
 * `neutral` is absent from that list too; but the page never spells "required
 * check" out next to `neutral` the way it does for `skipped`, so this rests on
 * table-parity plus the blocking-list omission, not an equally explicit
 * standalone sentence — see {@link ReportedCheck} in `host-pr.ts` for the full
 * citation, issue #263) — and `failure` for everything else (`failure`,
 * `cancelled`, `timed_out`, `action_required`, or a missing conclusion on a
 * completed run).
 */
function toCheckRunState(run: Record<string, unknown>): ReportedCheck['state'] {
  if (run.status !== 'completed') return 'pending';
  const c = run.conclusion;
  return c === 'success' || c === 'skipped' || c === 'neutral' ? 'success' : 'failure';
}

/** A commit status's `state` (`success` | `pending` | `failure` | `error`) → the normalised state. */
function toCommitStatusState(state: unknown): ReportedCheck['state'] {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure'; // `failure` | `error` | anything unrecognised
}

/** Required-check contexts from either the legacy `contexts[]` or the newer `checks[].context`. */
function toContexts(json: unknown): string[] {
  const o = (json ?? {}) as Record<string, unknown>;
  if (Array.isArray(o.contexts)) {
    return o.contexts.filter((c): c is string => typeof c === 'string');
  }
  if (Array.isArray(o.checks)) {
    return (o.checks as Record<string, unknown>[])
      .map((c) => (typeof c.context === 'string' ? c.context : ''))
      .filter((s) => s.length > 0);
  }
  return [];
}

/**
 * Required-check contexts from the effective-rules endpoint's array of rule
 * objects: every `type:"required_status_checks"` rule's
 * `parameters.required_status_checks[].context`, aggregated across rules and
 * de-duplicated (first-seen order). A body that is not an array, or carries no
 * such rule, yields `[]`.
 */
function toRulesetContexts(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const out: string[] = [];
  for (const rule of json) {
    if (rule === null || typeof rule !== 'object') continue;
    const r = rule as Record<string, unknown>;
    if (r.type !== 'required_status_checks') continue;
    const params = r.parameters as Record<string, unknown> | undefined;
    const checks = params?.required_status_checks;
    if (!Array.isArray(checks)) continue;
    for (const c of checks) {
      const ctx = c !== null && typeof c === 'object' ? (c as Record<string, unknown>).context : undefined;
      if (typeof ctx === 'string' && ctx.length > 0) out.push(ctx);
    }
  }
  return [...new Set(out)];
}

/** Surface GitHub's own `message` in the typed error — operators need it verbatim. */
function ghMessage(json: unknown, op: string): string | undefined {
  const m = (json as Record<string, unknown>)?.message;
  return typeof m === 'string' && m.length > 0 ? `GitHub ${op} failed: ${m}` : undefined;
}

function toGhIssue(json: unknown): GhIssue {
  const o = (json ?? {}) as Record<string, unknown>;
  const labels = Array.isArray(o.labels)
    ? o.labels
        .map((l) => (typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? '')))
        .filter((s) => s.length > 0)
    : [];
  const reason = o.state_reason;
  // `updated_at` is declared REQUIRED on the issue schema, `string` with
  // `format: date-time`, and is returned by both "Get an issue" and "List
  // repository issues" (GitHub REST issues docs, read 2026-08-09). Carried
  // straight through as `GhIssue.updatedAt` → the store's
  // `IssueView.trackerUpdatedAt`, verbatim rather than reformatted.
  //
  // e2e-verify — UNPROVEN in this slice (hermetic specs only, no live probe;
  // ADR-0030's declared-unexecutable path). Narrowed the same defensive way
  // every other field here is: a non-string leaves it absent — and the tolerant
  // branch is the SAFE one, since absence `defer`s the DoR staleness advisory
  // instead of passing it.
  const updatedAt = typeof o.updated_at === 'string' && o.updated_at.length > 0 ? o.updated_at : undefined;
  return {
    number: Number(o.number),
    title: typeof o.title === 'string' ? o.title : '',
    body: typeof o.body === 'string' ? o.body : '',
    labels,
    state: o.state === 'closed' ? 'closed' : 'open',
    stateReason: reason === 'completed' || reason === 'not_planned' || reason === 'reopened' ? reason : null,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

/**
 * Project a REST milestone resource onto {@link GhMilestone}. Narrowed the same
 * defensive way {@link toGhIssue} is: `description` is documented "string or
 * null", and the null lands as `''` rather than as a `"null"` string — a goal
 * with no prose has empty prose, which is what {@link GhMilestone.description}
 * promises.
 */
function toGhMilestone(json: unknown): GhMilestone {
  const o = (json ?? {}) as Record<string, unknown>;
  return {
    number: Number(o.number),
    title: typeof o.title === 'string' ? o.title : '',
    description: typeof o.description === 'string' ? o.description : '',
    state: o.state === 'closed' ? 'closed' : 'open',
  };
}

function graphqlIssue(json: unknown): { state: string; nodes: { merged: boolean; url?: string }[] } | null {
  const issue = (((json as Record<string, unknown>)?.data as Record<string, unknown>)?.repository as Record<string, unknown>)?.issue as Record<string, unknown> | null | undefined;
  if (!issue) return null;
  const rawNodes = ((issue.closedByPullRequestsReferences as Record<string, unknown>)?.nodes ?? []) as Record<string, unknown>[];
  return {
    state: String(issue.state ?? ''),
    nodes: rawNodes.map((n) => ({ merged: n.merged === true, url: typeof n.url === 'string' ? n.url : undefined })),
  };
}
