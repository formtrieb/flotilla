/**
 * real-github-api.ts — the P8 production GitHubApi (ADR-0019): raw `fetch` REST
 * (issue CRUD / labels / comments / close) + GraphQL (the closing-probe only),
 * over the GitHub-local `GitHubHttp` seam. No `@octokit`, no `gh` subprocess.
 */

import type {
  GitHubApi, GhIssue, GhStateReason, CreateIssueInput, ClosingPrState, RequiredChecksInfo,
} from './github-api';
import {
  AutoMergeUnavailableError,
  DEFAULT_MERGE_METHOD,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type PrMergeability,
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
 * `errors[].type: "UNPROCESSABLE"`. This is the runtime face of the hard
 * precondition the store-preflight probes via `allowsAutoMerge()` — GitHub ships
 * "Allow auto-merge" OFF by default.
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

  async nativeClose(number: number, reason: GhStateReason = 'completed'): Promise<void> {
    const body: Record<string, unknown> = { state: 'closed' };
    if (reason === 'completed' || reason === 'not_planned') body.state_reason = reason;
    const res = await this.send('PATCH', `${this.base()}/issues/${number}`, body);
    if (res.status !== 200) throw new GitHubApiError(res.status, 'nativeClose');
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
    return { state: 'open', number, url, mergeability: toMergeability(detail.json) };
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
   * ADR-0023 preflight probe: is the repo's "Allow auto-merge" setting ON?
   * GitHub ships it OFF, so `false` is the DEFAULT, not an anomaly — an absent
   * field reads as off (fail closed: claiming auto-merge is available when the
   * response did not say so would fail later, at arm time, mid-wave).
   */
  async allowsAutoMerge(): Promise<boolean> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) throw new GitHubApiError(res.status, 'allowsAutoMerge', ghMessage(res.json, 'allowsAutoMerge'));
    return (res.json as Record<string, unknown>)?.allow_auto_merge === true;
  }

  /**
   * ADR-0023 report-only probe: does `branch` (default: the repo's default
   * branch) carry required status checks?
   *
   * **Never throws** — that is a contract, not defensiveness. This probe is
   * advisory (a no-CI repo keeps `--auto`), so any failure to read it must
   * degrade to `unknown`, never block the preflight. That matters concretely:
   * the branch-protection endpoint needs ADMIN rights, which the ambient wave
   * token routinely lacks — a 403 here is an ordinary, expected answer.
   *
   * Responses: 200 → contexts (legacy `contexts[]` or newer `checks[].context`);
   * 404 → the branch is unprotected → `absent`; 403 → `unknown`.
   */
  async getRequiredChecks(branch?: string): Promise<RequiredChecksInfo> {
    try {
      const target = branch ?? (await this.defaultBranch());
      const res = await this.send('GET', `${this.base()}/branches/${encodeURIComponent(target)}/protection/required_status_checks`);

      if (res.status === 404) {
        return {
          state: 'absent',
          contexts: [],
          detail: `Branch '${target}' has no required status checks (not protected, or protection carries none).`,
        };
      }
      if (res.status === 403) {
        return {
          state: 'unknown',
          contexts: [],
          detail: `Could not read branch protection for '${target}' — the endpoint requires admin rights on the repository (HTTP 403). This is advisory only and does not block the wave.`,
        };
      }
      if (res.status !== 200) {
        return {
          state: 'unknown',
          contexts: [],
          detail: `Could not read required checks for '${target}' (HTTP ${res.status}). Advisory only — the wave is not blocked.`,
        };
      }

      const contexts = toContexts(res.json);
      return contexts.length > 0
        ? {
            state: 'present',
            contexts,
            detail: `Branch '${target}' requires ${contexts.length} status check(s): ${contexts.join(', ')}.`,
          }
        : {
            state: 'absent',
            contexts: [],
            detail: `Branch '${target}' is protected but requires no status checks.`,
          };
    } catch (err) {
      return {
        state: 'unknown',
        contexts: [],
        detail: `Could not probe required checks: ${(err as Error).message ?? String(err)}. Advisory only — the wave is not blocked.`,
      };
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
  return {
    number: Number(o.number),
    title: typeof o.title === 'string' ? o.title : '',
    body: typeof o.body === 'string' ? o.body : '',
    labels,
    state: o.state === 'closed' ? 'closed' : 'open',
    stateReason: reason === 'completed' || reason === 'not_planned' || reason === 'reopened' ? reason : null,
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
