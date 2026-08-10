/**
 * bitbucket-api.ts — the Bitbucket Cloud LANDING adapter (ADR-0023's named
 * pilot), implementing host-pr's two host-local seams and nothing else:
 *
 *   - {@link LandingHost}    — `getPrStatus` / `enableAutoMerge` /
 *                              `mergePullRequest` / `deleteBranch` (the per-PR
 *                              arm/merge/status verbs).
 *   - {@link LandingPosture} — `canMergePullRequests` / `getAutoMergeSetting` /
 *                              `getRequiredChecks` (the repo-level `host-pr
 *                              preflight` probe).
 *
 * What this file deliberately does NOT contain: a second Bitbucket PR-CREATE
 * implementation. `host-pr create` already ships a Bitbucket arm on the
 * cross-host Basic-auth `HttpProbe` (`bitbucketApi()` in `host-pr.ts` — open-PR
 * query, create payload, `PUT` update semantics, pre-fill fallback); this slice
 * UNLOCKS that path in the CLI router rather than re-implementing it. The
 * ADR-0019 seam discipline is why the two live apart: `HttpProbe` is
 * GET|POST + Basic across BOTH hosts and stays untouched, while the landing
 * reads/writes here need `DELETE` and a Bearer option, so they get their own
 * adapter-local {@link BitbucketHttp} seam — exactly the split `GitHubHttp` has.
 *
 * ## Credentials (ADR-0029)
 *
 * The secret is `BITBUCKET_TOKEN`, resolved through the ONE engine credential
 * seam (`BITBUCKET_TOKEN_CMD` — a lookup command — wins over the ambient
 * `BITBUCKET_TOKEN`). The USERNAME half is `BITBUCKET_EMAIL`, read as a plain
 * environment value because it is an identifier, not a secret.
 *
 * The pairing is a MEASUREMENT, not an assumption (this issue asked for one),
 * and the measurement changed the answer the field report hypothesised:
 *
 *   - **App passwords are gone.** Atlassian's own deprecation schedule: no new
 *     app passwords since 2025-09-09, existing ones "cease to function" on
 *     2026-06-09, full removal 2026-07-28 (atlassian.com/blog/bitbucket,
 *     "Bitbucket Cloud transitions to API tokens", read 2026-08-10). A
 *     `username:app_password` pair is therefore NOT a shape to build against
 *     today — it is a shape that has already stopped working.
 *   - **Atlassian API token, Basic auth** — the documented replacement. The
 *     username is the ATLASSIAN ACCOUNT EMAIL, not the Bitbucket username:
 *     `--user '{atlassian_account_email}:{api_token}'`
 *     (support.atlassian.com/bitbucket-cloud/docs/using-api-tokens, read
 *     2026-08-10). Scopes are required on the token; the repository-level pair
 *     that covers this adapter's reads and writes is
 *     `read:repository:bitbucket` + `write:repository:bitbucket`.
 *   - **Repository / project / workspace access token, Bearer auth** — the
 *     other live shape (`Authorization: Bearer <token>`; the same form
 *     Atlassian's own `refs/branches` DELETE example uses). It has no user
 *     context, which is why {@link RealBitbucketApi.canMergePullRequests}
 *     treats a blind user-scoped permission read as absence of evidence
 *     rather than as a finding.
 *
 * So: `BITBUCKET_EMAIL` set → Basic `email:token`; unset → `Bearer token`.
 * `host-pr create` can only speak Basic (it rides the shared cross-host
 * `HttpProbe`, which this slice does NOT widen), so it REQUIRES
 * `BITBUCKET_EMAIL` and refuses loud and typed without it — see
 * {@link bitbucketCreateCreds}.
 *
 * ## What is NOT executable from this repo
 *
 * flotilla's own remote is GitHub, and no Bitbucket credential is reachable
 * here, so every path below is specced hermetically over the injectable seam
 * and compared against Atlassian's own documentation (cited inline, each read
 * on 2026-08-10). The pilot consumer's first wave is the live reading — the
 * ADR-0030 declared-unexecutable stance `RealLinearApi` and `RealGitHubApi`
 * already take for their own unproven arms.
 */

import {
  AutoMergeUnavailableError,
  DEFAULT_MERGE_METHOD,
  type AutoMergeSetting,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type MergeResult,
  type PrLandingStatus,
  type PrMergeability,
  type RequiredChecksInfo,
} from '../../host-pr';
import { resolveCredential } from '../../credential-resolver';

const API = 'https://api.bitbucket.org/2.0';

/** The ambient variable the Bitbucket secret is known by (ADR-0029 naming). */
export const BITBUCKET_TOKEN_VAR = 'BITBUCKET_TOKEN';

/**
 * The Basic-auth USERNAME half. Not a secret and therefore not routed through
 * the credential resolver: Atlassian's API-token form wants the account EMAIL
 * here, and an email is an identifier that belongs in the tracked settings `env`
 * block next to the `BITBUCKET_TOKEN_CMD` pointer.
 */
export const BITBUCKET_EMAIL_VAR = 'BITBUCKET_EMAIL';

/** A non-success Bitbucket response. `status` is the HTTP code; `op` the failed operation. */
export class BitbucketApiError extends Error {
  readonly name = 'BitbucketApiError';
  constructor(readonly status: number, readonly op: string, message?: string) {
    super(message ?? `Bitbucket ${op} failed (HTTP ${status})`);
  }
}

// ─── The adapter-local HTTP seam (ADR-0019 discipline) ───────────────────────

/**
 * One Bitbucket HTTP request. `auth` is the ALREADY-BUILT `Authorization` header
 * value (`Basic …` or `Bearer …`) rather than a raw secret: the header shape is
 * a credential-form decision ({@link bitbucketAuthHeader}), and keeping it out
 * of the transport means the transport has one job and the secret has one
 * builder.
 *
 * `DELETE` is in the verb set for the branch-hygiene step; `POST` carries the
 * merge. Bitbucket Cloud has no GraphQL surface flotilla needs.
 */
export interface BitbucketHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  /** The full `Authorization` header value. */
  auth: string;
  /** Already-serialised JSON payload for writes; omitted for reads. */
  body?: string;
}

/** The response slice the impl needs: numeric status + pre-parsed JSON (null when empty/unparseable). */
export interface BitbucketHttpResponse {
  status: number;
  json: unknown;
}

/** Network seam. `defaultBitbucketHttp` uses global `fetch`; specs inject a fixture. */
export interface BitbucketHttp {
  request(req: BitbucketHttpRequest): Promise<BitbucketHttpResponse>;
}

/**
 * Default {@link BitbucketHttp} backed by global `fetch` (Node 18+). ALL real
 * network for this adapter lives here; every other path is pure so the spec
 * drives it with a fixture. A non-JSON / empty body resolves to `json: null`
 * (a 204 branch-delete has no body at all, and the status alone decides).
 */
export function defaultBitbucketHttp(): BitbucketHttp {
  return {
    async request(req: BitbucketHttpRequest): Promise<BitbucketHttpResponse> {
      const headers: Record<string, string> = {
        Authorization: req.auth,
        Accept: 'application/json',
        'User-Agent': 'flotilla-wave-tools',
      };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(req.url, { method: req.method, headers, body: req.body });
      let json: unknown;
      try {
        const text = await res.text();
        json = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, json };
    },
  };
}

/**
 * Build the `Authorization` header value for a resolved Bitbucket credential.
 * Pure — the two documented live shapes, and nothing else (app passwords are
 * removed; see the module docblock).
 */
export function bitbucketAuthHeader(token: string, email?: string): string {
  if (email !== undefined && email.length > 0) {
    return `Basic ${Buffer.from(`${email}:${token}`, 'utf-8').toString('base64')}`;
  }
  return `Bearer ${token}`;
}

// ─── Merge-method mapping ────────────────────────────────────────────────────

/**
 * flotilla's host-neutral {@link MergeMethod} → Bitbucket's `merge_strategy`.
 *
 * Bitbucket Cloud offers exactly three strategies — `merge_commit`, `squash`,
 * `fast_forward` (support.atlassian.com/bitbucket-cloud/docs/merge-a-pull-request,
 * read 2026-08-10) — and `rebase` is NOT among them. It is therefore absent from
 * this map on purpose and refused loudly at the call site rather than silently
 * rounded to `fast_forward`, which is a different operation (`git merge
 * --ff-only`, and only possible when the destination has no new commits). The
 * wave default is `squash`, so no flotilla path depends on the gap.
 */
const BB_MERGE_STRATEGY: Partial<Record<MergeMethod, string>> = {
  squash: 'squash',
  merge: 'merge_commit',
};

// ─── Bitbucket's merge-check posture, as a count ─────────────────────────────

/**
 * The `require_passing_builds_to_merge` branch restriction, resolved for one
 * branch. Bitbucket's required-builds gate is a COUNT, not a list of named
 * contexts — Atlassian's own wording for the check is "Minimum number of
 * successful builds for the last commit with no failed builds and no in
 * progress builds" (support.atlassian.com/bitbucket-cloud/docs/
 * suggest-or-require-checks-before-a-merge, read 2026-08-10). That single
 * sentence is the whole rule this adapter implements in
 * {@link RealBitbucketApi.mergeabilityOf}.
 */
interface RequiredBuilds {
  state: 'present' | 'absent' | 'unknown';
  /** Minimum successful builds required. `0` for absent/unknown. */
  count: number;
  detail: string;
}

/**
 * Whether a Bitbucket branch-restriction entry applies to `branch`.
 *
 * Two shapes, and the tie-break in BOTH is deliberately the OVER-matching one:
 * over-reporting a restriction makes {@link RealBitbucketApi.mergeabilityOf}
 * answer `blocked` more often, which makes `arm` REFUSE more often — never
 * merge past a gate. Under-matching would do the opposite, and that is the one
 * error this whole file exists to avoid.
 *
 *   - `branch_match_kind: "glob"` (the shape Atlassian's own create example
 *     uses: `{kind, pattern: "*", value: 1, branch_match_kind: "glob"}`) — the
 *     `pattern` is matched with `*` as "any characters", INCLUDING `/`. That is
 *     wider than a shell glob's `*` on purpose: a `feature/*` restriction that
 *     did not cover `feature/a/b` here would silently drop a real gate.
 *   - `branch_match_kind: "branching_model"` — the restriction is keyed to a
 *     branching-model branch TYPE, which cannot be resolved from a branch name
 *     alone. Treated as APPLYING.
 */
export function bitbucketBranchRestrictionApplies(
  restriction: { pattern?: unknown; branch_match_kind?: unknown },
  branch: string,
): boolean {
  if (restriction.branch_match_kind === 'branching_model') return true;
  const pattern = restriction.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) return true;
  const rx = new RegExp(
    `^${pattern.split('*').map(escapeRegExp).join('.*')}$`,
  );
  return rx.test(branch);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// ─── The adapter ─────────────────────────────────────────────────────────────

export class RealBitbucketApi implements LandingHost, LandingPosture {
  constructor(
    private readonly workspace: string,
    private readonly repo: string,
    /** The full `Authorization` header value (see {@link bitbucketAuthHeader}). */
    private readonly auth: string,
    private readonly http: BitbucketHttp = defaultBitbucketHttp(),
  ) {}

  private base(): string {
    return `${API}/repositories/${this.workspace}/${this.repo}`;
  }

  private send(
    method: BitbucketHttpRequest['method'],
    url: string,
    body?: unknown,
  ): Promise<BitbucketHttpResponse> {
    return this.http.request({
      method,
      url,
      auth: this.auth,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /**
   * Verify the credential before any wave op (the ADR-0019 construction
   * preflight, Bitbucket's equivalent of `RealGitHubApi.preflight`).
   *
   * Deliberately `GET /2.0/repositories/{w}/{r}` and NOT `GET /2.0/user`: the
   * user endpoint is user-scoped, so a repository/project/workspace access
   * token — one of the two live credential shapes — cannot answer it, and a
   * preflight that rejected a perfectly good access token would be worse than
   * no preflight at all. Reaching the bound repo is exactly the capability
   * every verb below needs.
   */
  async preflight(): Promise<void> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) {
      throw new BitbucketApiError(
        res.status,
        'preflight',
        `${BITBUCKET_TOKEN_VAR} rejected (GET /2.0/repositories/${this.workspace}/${this.repo} → ${res.status})`,
      );
    }
  }

  // ─── LandingHost ───────────────────────────────────────────────────────

  /**
   * Branch → the PR's landing state (the tier-2 probe of the done-reconcile
   * evidence hierarchy, Convention 7).
   *
   * `GET /2.0/repositories/{w}/{r}/pullrequests` filtered by BBQL on the source
   * branch. Two documented details this call depends on, both read 2026-08-10:
   *
   *   1. The `q` parameter is BBQL — its boolean operator is `and`, NOT an `&`
   *      (developer.atlassian.com example: `?q=size>1024+and+attributes="binary"`).
   *   2. `state` is a first-class query parameter, "By default only open pull
   *      requests are returned"; to see several states you "repeat the state
   *      parameter for each individual state". All four documented values are
   *      requested — `OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED` — because a
   *      MERGED PR is the evidence that retires the hand-asserted merge, and
   *      the default (OPEN only) would report `none` for exactly the row the
   *      done-reconcile is asking about.
   *
   * Selection mirrors the GitHub adapter: an OPEN PR wins (the only actionable
   * one), then MERGED (the stronger evidence), then DECLINED/SUPERSEDED, which
   * both project onto `closed-unmerged` — flotilla never re-opens a PR
   * (ADR-0005), so the two need no separate outcome.
   */
  async getPrStatus(branch: string): Promise<PrLandingStatus> {
    const q = encodeURIComponent(`source.branch.name="${branch}"`);
    const states = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']
      .map((s) => `state=${s}`)
      .join('&');
    const res = await this.send(
      'GET',
      `${this.base()}/pullrequests?q=${q}&${states}&sort=-updated_on&pagelen=50`,
    );
    if (res.status !== 200) {
      throw new BitbucketApiError(res.status, 'getPrStatus', bbMessage(res.json, 'getPrStatus'));
    }

    const items = valuesOf(res.json);
    if (items.length === 0) return { state: 'none' };

    const open = items.find((p) => p.state === 'OPEN');
    if (open === undefined) {
      const merged = items.find((p) => p.state === 'MERGED');
      const chosen = merged ?? items[0];
      return {
        state: merged !== undefined ? 'merged' : 'closed-unmerged',
        ...prIdentity(chosen),
      };
    }

    return {
      state: 'open',
      ...prIdentity(open),
      mergeability: await this.mergeabilityOf(open),
      ...prRefs(open),
    };
  }

  /**
   * ARM — and the MEASURED answer this issue's AC4 asked for.
   *
   * **Bitbucket Cloud exposes no arming primitive through its REST API.** What
   * it has instead is a merge CHECK, "Allow automatic merge when builds pass",
   * enabled per destination branch under Repository settings → Branch
   * restrictions → Merge checks; it is armed by a HUMAN CLICKING **Merge** in
   * the pull-request UI while a build is still running ("After clicking on the
   * Merge option, Bitbucket will watch the build for you and merge it if the
   * build passes" — support.atlassian.com/bitbucket-cloud/kb, "Using Pull
   * Request Pipelines and Auto-Merging…", read 2026-08-10; Atlassian's own
   * announcement of the feature says the same and mentions no API). There is no
   * request parameter on `POST …/pullrequests/{id}/merge`, and no separate
   * endpoint, that arms a PR to land itself later.
   *
   * So the interface's own escape hatch is the correct implementation:
   * {@link AutoMergeUnavailableError} with reason `not-allowed`. That reason is
   * chosen over `clean-status` deliberately — the two route DIFFERENTLY in
   * `armPullRequest`, and only `not-allowed` is safe here:
   *
   *   - `not-allowed` degrades to a direct merge ONLY when no required check is
   *     reported pending, and REFUSES otherwise ("arm must never merge past a
   *     check"). That is precisely "falls back to direct-merge-when-clean".
   *   - `clean-status` would merge unconditionally, on the strength of a
   *     "nothing is pending" claim nobody made here.
   *
   * The pending case is not lost: {@link mergeabilityOf} reports `blocked`
   * whenever Bitbucket's own required-builds rule is unmet, so an arm on a
   * checks-pending Bitbucket PR ends at `refused` with the merge-order
   * instruction — never at a merge.
   */
  async enableAutoMerge(prNumber: number, _method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<void> {
    throw new AutoMergeUnavailableError(
      'not-allowed',
      `Bitbucket Cloud offers no auto-merge arming primitive in its REST API, so PR #${prNumber} cannot be armed ` +
        `(measured 2026-08-10 against Atlassian's own documentation; ADR-0023 records the finding). Its nearest ` +
        `equivalent — the "Allow automatic merge when builds pass" merge check — is triggered by a human clicking ` +
        `Merge in the pull-request UI, not by an API call. host-pr therefore lands a Bitbucket row by direct merge ` +
        `when nothing required is pending, and refuses while a required build has not reported success.`,
    );
  }

  /**
   * Merge a PR now — `POST /2.0/repositories/{w}/{r}/pullrequests/{id}/merge`
   * with `{ merge_strategy }` (support.atlassian.com/bitbucket-cloud/docs/
   * merge-a-pull-request + developer.atlassian.com pullrequests group, read
   * 2026-08-10).
   *
   * Two success shapes, both documented and both real:
   *   - **200** with the merged pull-request object → `{ merged: true, sha }`,
   *     the merge commit read off `merge_commit.hash`.
   *   - **202** with a merge TASK, returned "when merging a pull request takes
   *     too long"; the merge is ACCEPTED and completes server-side. Reported as
   *     `{ merged: true }` with NO sha — the same "landed, commit unknown yet"
   *     shape `MergeResult` already allows, and honest: polling the task-status
   *     endpoint would be a watch loop, which ADR-0023 decision 4 rejects.
   *
   * `close_source_branch` is NOT sent: branch hygiene is `--delete-branch`'s
   * job through {@link deleteBranch}, whose outcome is reported structurally
   * (`branchDeletion`). Folding it into the merge body would make a deletion
   * silently succeed or silently not happen with nothing to report.
   *
   * Every non-2xx is a typed throw carrying Bitbucket's own message — a merge
   * refused by an unmet merge check surfaces verbatim, which is what keeps the
   * host the final gate.
   */
  async mergePullRequest(prNumber: number, method: MergeMethod = DEFAULT_MERGE_METHOD): Promise<MergeResult> {
    const strategy = BB_MERGE_STRATEGY[method];
    if (strategy === undefined) {
      throw new BitbucketApiError(
        0,
        'mergePullRequest',
        `Bitbucket Cloud has no '${method}' merge strategy — it offers merge_commit, squash and fast_forward only. ` +
          `Re-run with --method squash (the flotilla default) or --method merge.`,
      );
    }
    const res = await this.send('POST', `${this.base()}/pullrequests/${prNumber}/merge`, {
      merge_strategy: strategy,
    });
    if (res.status === 202) {
      // Accepted as an async merge task: the merge WILL happen, the commit is
      // not known at this instant. `sha` is absent rather than invented.
      return { merged: true };
    }
    if (res.status !== 200) {
      throw new BitbucketApiError(res.status, 'mergePullRequest', bbMessage(res.json, 'mergePullRequest'));
    }
    const sha = mergeCommitHash(res.json);
    return sha === null ? { merged: true } : { merged: true, sha };
  }

  /**
   * Delete a remote branch — `DELETE /2.0/repositories/{w}/{r}/refs/branches/{name}`,
   * documented as 204 No Content on success, with the branch name carrying "no
   * prefixes (e.g. refs/heads)" (developer.atlassian.com refs group, read
   * 2026-08-10).
   *
   * The name is interpolated as a REF PATH, the same treatment
   * `RealGitHubApi.deleteBranch` gives it: a `wave/461-…` branch's slashes are
   * path separators, so each segment is encoded individually while the slashes
   * survive. Throws on any other status so the merge path records a structural
   * {@link BranchDeletionResult} degradation — a failed delete never un-merges
   * the PR.
   */
  async deleteBranch(branch: string): Promise<void> {
    const ref = branch.split('/').map(encodeURIComponent).join('/');
    const res = await this.send('DELETE', `${this.base()}/refs/branches/${ref}`);
    // 204 is the documented success; 200 is tolerated defensively, exactly as
    // the GitHub sibling does.
    if (res.status !== 204 && res.status !== 200) {
      throw new BitbucketApiError(res.status, 'deleteBranch', bbMessage(res.json, 'deleteBranch'));
    }
  }

  // ─── LandingPosture ────────────────────────────────────────────────────

  /**
   * Whether the resolved credential can merge PRs on the bound repo.
   *
   * `GET /2.0/user/permissions/repositories?q=repository.full_name="w/r"` — the
   * effective repository permission for the AUTHENTICATED USER (`read` |
   * `write` | `admin`); `write` or higher can merge.
   *
   * The deliberate departure from the GitHub sibling (which throws on any
   * non-200): a NON-200 here resolves to `true`, not `false` and not a throw.
   * The endpoint is user-scoped, and one of Bitbucket's two live credential
   * shapes — a repository/project/workspace access token — has NO user context
   * at all, so it cannot be graded here. Grading that credential `fail` would
   * make `host-pr preflight` permanently red for a correctly-configured pilot;
   * the ADR-0023-amendment doctrine is that absence of evidence is not a
   * finding and must never block. `LandingPosture` types this read as a plain
   * boolean, so "no evidence" projects onto the NON-blocking value, and the
   * bitbucket wording of the `pr-merge-token` check says so in as many words
   * rather than claiming a permission was proven.
   */
  async canMergePullRequests(): Promise<boolean> {
    const q = encodeURIComponent(`repository.full_name="${this.workspace}/${this.repo}"`);
    const res = await this.send('GET', `${API}/user/permissions/repositories?q=${q}`);
    if (res.status !== 200) return true; // no user context → no evidence → never a finding
    const first = valuesOf(res.json)[0];
    if (first === undefined) return true; // the credential is not a user of this repo → likewise
    return first.permission === 'write' || first.permission === 'admin';
  }

  /**
   * The "can a checks-pending PR be armed?" posture. Always `'off'` on this
   * host, and that is a MEASUREMENT rather than a read: Bitbucket Cloud has no
   * REST arming primitive to enable (see {@link enableAutoMerge}), so there is
   * no setting whose value could make one appear. `'unknown'` would be the
   * dishonest answer here — it means "the credential cannot see the setting",
   * and the setting does not exist.
   *
   * The GRADING of this `off` is host-aware in `preflightHost`: on GitHub an
   * OFF is a fixable misconfiguration and can be a hard `fail`; on Bitbucket it
   * is a platform property, so it is `advisory` — a permanently-red preflight
   * would be noise, not a signal.
   */
  async getAutoMergeSetting(): Promise<AutoMergeSetting> {
    return 'off';
  }

  /**
   * Required status checks on `branch` (default: the repo's main branch) —
   * report-only and CONTRACTUALLY throw-free, like the GitHub sibling.
   *
   * Bitbucket's shape differs in a way that matters downstream: its gate is
   * `require_passing_builds_to_merge`, a COUNT, so there are no named contexts
   * to report and `contexts` stays empty even when `state` is `present`. That
   * is also exactly why this adapter does NOT implement host-pr's optional
   * `CheckAttachReader` — see the note on {@link mergeabilityOf}.
   */
  async getRequiredChecks(branch?: string): Promise<RequiredChecksInfo> {
    try {
      const target = branch ?? (await this.mainBranch());
      const required = await this.requiredBuilds(target);
      return { state: required.state, contexts: [], detail: required.detail };
    } catch (err) {
      return {
        state: 'unknown',
        contexts: [],
        detail: `Could not probe Bitbucket merge checks: ${errMessage(err)}. Advisory only — the wave is not blocked.`,
      };
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  /**
   * An OPEN Bitbucket PR's mergeability, in host-pr's neutral vocabulary.
   *
   * Bitbucket's PR payload carries NO `mergeable_state` equivalent, so this is
   * derived from the two facts that actually gate a Bitbucket merge, applying
   * Atlassian's own sentence for the required-builds check verbatim: "Minimum
   * number of successful builds for the last commit with no failed builds and
   * no in progress builds."
   *
   *   - a draft PR → `draft` (refuse; never landed).
   *   - the merge-check read was blind → `unknown`. Never `clean`: `unknown`
   *     arms rather than merges, and the merge WRITE stays the final gate — a
   *     Bitbucket merge that violates a merge check is refused by Bitbucket
   *     with its own message, which {@link mergePullRequest} surfaces verbatim.
   *   - no required builds → `clean` (direct merge; the same behaviour a
   *     no-CI GitHub repo gets).
   *   - any build status on the head commit that is not SUCCESSFUL, or fewer
   *     of them than the required minimum → `blocked`. The
   *     fewer-than-required case is the CHECK-ATTACH LATENCY WINDOW: zero
   *     reports is `0 < N`, so a PR whose builds have not started yet is
   *     `blocked`, not `clean`. That is the same defect the GitHub adapter
   *     closes with `CheckAttachReader`, closed here at the mergeability layer
   *     instead — which is why this class deliberately does NOT implement
   *     `getReportedChecks`: pairing it with a `getRequiredChecks` that can
   *     only return an EMPTY context list would make host-pr's
   *     required-vs-reported NAME comparison vacuously "attached" and re-open
   *     the very window this branch closes.
   *   - a failed build-status read → `unknown`, never `clean`.
   */
  private async mergeabilityOf(pr: Record<string, unknown>): Promise<PrMergeability> {
    if (pr.draft === true) return 'draft';

    const destination = branchNameOf(pr.destination);
    const required = await this.requiredBuildsSafe(destination);
    if (required.state === 'unknown') return 'unknown';
    if (required.count === 0) return 'clean';

    const headSha = commitHashOf(pr.source);
    if (headSha === null) return 'unknown';

    let statuses: { state: string }[];
    try {
      statuses = await this.commitStatuses(headSha);
    } catch {
      return 'unknown';
    }
    // "no failed builds and no in progress builds" is graded by what a status
    // is NOT, rather than by enumerating FAILED / INPROGRESS / STOPPED. The
    // enumeration would be a spelling dependency on tokens this slice could
    // confirm only partially (`SUCCESSFUL` and `FAILED` appear verbatim in
    // Atlassian's build-status docs; the in-progress token is written "IN
    // PROGRESS" in prose), and getting that spelling wrong would fail OPEN — a
    // running build the matcher missed, with the successful count already met,
    // would read `clean` and be merged. Grading by NOT-SUCCESSFUL fails closed
    // for every present and future state name instead.
    if (statuses.some((s) => s.state !== 'SUCCESSFUL')) return 'blocked';
    return statuses.length >= required.count ? 'clean' : 'blocked';
  }

  /** {@link requiredBuilds}, degraded to `unknown` rather than throwing. */
  private async requiredBuildsSafe(branch: string | null): Promise<RequiredBuilds> {
    if (branch === null) {
      return { state: 'unknown', count: 0, detail: 'The pull request reported no destination branch.' };
    }
    try {
      return await this.requiredBuilds(branch);
    } catch (err) {
      return { state: 'unknown', count: 0, detail: `Could not read branch restrictions: ${errMessage(err)}.` };
    }
  }

  /**
   * The minimum successful builds `branch` requires, from
   * `GET /2.0/repositories/{w}/{r}/branch-restrictions?kind=require_passing_builds_to_merge`.
   *
   * Every entry the endpoint returns is filtered by
   * {@link bitbucketBranchRestrictionApplies} and the MAXIMUM `value` wins —
   * several restrictions can cover one branch, and the strictest is the one
   * that actually gates the merge.
   */
  private async requiredBuilds(branch: string): Promise<RequiredBuilds> {
    const entries = await this.paged(
      `${this.base()}/branch-restrictions?kind=require_passing_builds_to_merge&pagelen=100`,
      'getRequiredChecks',
    );
    let count = 0;
    for (const e of entries) {
      if (e.kind !== 'require_passing_builds_to_merge') continue;
      if (!bitbucketBranchRestrictionApplies(e, branch)) continue;
      const v = typeof e.value === 'number' ? e.value : 0;
      if (v > count) count = v;
    }
    if (count > 0) {
      return {
        state: 'present',
        count,
        detail:
          `Branch '${branch}' requires at least ${count} successful build(s) on the pull request's last commit, ` +
          `with no failed and no in-progress builds (Bitbucket merge check "require_passing_builds_to_merge"). ` +
          `Bitbucket states the requirement as a COUNT, not as named check contexts, so no context names are reported.`,
      };
    }
    return {
      state: 'absent',
      count: 0,
      detail: `Branch '${branch}' has no "require_passing_builds_to_merge" branch restriction in force.`,
    };
  }

  /**
   * The build statuses Bitbucket has recorded for a commit —
   * `GET /2.0/repositories/{w}/{r}/commit/{sha}/statuses`. States seen in
   * Atlassian's own documentation and KB: `SUCCESSFUL` and `FAILED` appear
   * verbatim; the in-progress and stopped states are named in prose only. Only
   * `SUCCESSFUL` is therefore matched by name — every other value, known or
   * not, counts as "not a successful build", which is the direction that fails
   * closed (see {@link RealBitbucketApi.mergeabilityOf}).
   *
   * THROWS on a non-200, deliberately: an empty list is EVIDENCE that nothing
   * has reported for this commit yet, and that is the input that forces a
   * refusal — so a failed read must never be able to counterfeit it.
   */
  private async commitStatuses(sha: string): Promise<{ state: string }[]> {
    const entries = await this.paged(
      `${this.base()}/commit/${encodeURIComponent(sha)}/statuses?pagelen=100`,
      'commitStatuses',
    );
    return entries.map((e) => ({ state: typeof e.state === 'string' ? e.state : '' }));
  }

  /**
   * The repo's main branch, for the no-argument `getRequiredChecks` read.
   * `GET /2.0/repositories/{w}/{r}` carries it as `mainbranch: { type:
   * "branch", name }` — a branch object DIRECTLY, not the `{ branch: { name } }`
   * nesting a pull request's `source`/`destination` use, so it is read with its
   * own accessor rather than {@link branchNameOf}.
   */
  private async mainBranch(): Promise<string> {
    const res = await this.send('GET', this.base());
    if (res.status !== 200) {
      throw new BitbucketApiError(res.status, 'mainBranch', bbMessage(res.json, 'mainBranch'));
    }
    const main = (res.json as Record<string, unknown>)?.mainbranch as Record<string, unknown> | undefined;
    const name = main?.name;
    return typeof name === 'string' && name.length > 0 ? name : 'main';
  }

  /**
   * Follow Bitbucket's paged collections to exhaustion via the `next` LINK
   * rather than an incrementing `page` number. Bitbucket documents two
   * pagination flavours and the iterator-based one's `next` "often contains an
   * unpredictable hash instead of an explicit page number", so the link is the
   * only form that is correct for both. A missing `next` ends the walk; a
   * `next` that does not move is treated as the end (a defensive stop, never a
   * hang).
   */
  private async paged(firstUrl: string, op: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let url: string | undefined = firstUrl;
    while (url !== undefined && !seen.has(url)) {
      seen.add(url);
      const res: BitbucketHttpResponse = await this.send('GET', url);
      if (res.status !== 200) {
        throw new BitbucketApiError(res.status, op, bbMessage(res.json, op));
      }
      out.push(...valuesOf(res.json));
      const next = (res.json as Record<string, unknown>)?.next;
      url = typeof next === 'string' && next.length > 0 ? next : undefined;
    }
    return out;
  }
}

// ─── Factory (the CLI edge, ADR-0019 + ADR-0029) ─────────────────────────────

export interface BitbucketApiFactoryOptions {
  /** Injectable network seam (tests). Defaults to `defaultBitbucketHttp` inside the class. */
  http?: BitbucketHttp;
  /** Environment the credential is resolved from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Git remote URL — REQUIRED here (the CLI already resolved it). */
  remoteUrl: string;
  /** Bitbucket coordinates, already parsed by `detectHost`. */
  workspace: string;
  repo: string;
}

/**
 * Build a {@link RealBitbucketApi} from the resolved credential, with a
 * construction-time preflight — the Bitbucket twin of
 * `createGitHubApiFromEnv`. The secret goes through the ONE engine credential
 * seam (ADR-0029): `BITBUCKET_TOKEN_CMD` wins over an ambient
 * `BITBUCKET_TOKEN`, and a configured command that fails is a typed loud error
 * naming the command, never its output.
 */
export async function createBitbucketApiFromEnv(
  opts: BitbucketApiFactoryOptions,
): Promise<RealBitbucketApi> {
  const token = resolveCredential(BITBUCKET_TOKEN_VAR, {
    env: opts.env,
    purpose: 'reach the Bitbucket Cloud landing seam (`host-pr arm|merge|status|preflight`, ADR-0023)',
  });
  const email = (opts.env ?? process.env)[BITBUCKET_EMAIL_VAR];
  const api = new RealBitbucketApi(
    opts.workspace,
    opts.repo,
    bitbucketAuthHeader(token, email),
    opts.http,
  );
  await api.preflight(); // fail a bad credential now, not mid-wave
  return api;
}

/**
 * The Basic-auth `user:secret` pair `host-pr create` needs for Bitbucket.
 *
 * `create` rides the SHARED cross-host `HttpProbe`, which speaks Basic and only
 * Basic — and this slice deliberately does not widen it (the ADR-0019 boundary
 * the issue's plan pins). So the Bearer shape an access token would use is out
 * of reach on this one verb, and the honest response is a loud typed refusal
 * naming the fix rather than a request that would 401 with nothing to read.
 *
 * Returns the pair, or throws with the instruction.
 */
export function bitbucketCreateCreds(token: string, email: string | undefined): string {
  if (email === undefined || email.length === 0) {
    throw new Error(
      `${BITBUCKET_EMAIL_VAR} is required to open a PR on Bitbucket Cloud through \`host-pr create\`. ` +
        `Bitbucket's REST Basic auth pairs your ATLASSIAN ACCOUNT EMAIL with an API token ` +
        `(\`--user '{atlassian_account_email}:{api_token}'\`), and app passwords — the old ` +
        `username:password pairing — stopped working on 2026-06-09. Set ${BITBUCKET_EMAIL_VAR} to that account ` +
        `email alongside ${BITBUCKET_TOKEN_VAR} (or ${BITBUCKET_TOKEN_VAR}_CMD). A repository/workspace access ` +
        `token authenticates with Bearer, which the shared cross-host create seam does not speak — the landing ` +
        `verbs (arm | merge | status | preflight) accept it, \`create\` does not.`,
    );
  }
  return `${email}:${token}`;
}

// ─── payload readers (tolerant, present-only) ────────────────────────────────

/** A Bitbucket paged collection's `values`, or `[]` for any other shape. */
function valuesOf(json: unknown): Record<string, unknown>[] {
  const v = (json as Record<string, unknown>)?.values;
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/**
 * A PR object's `{ number?, url? }`, as PRESENT-ONLY keys. The number is
 * Bitbucket's `id`; the URL is `links.html.href` — the same two coordinates
 * `host-pr.ts`'s own `bbRef` reads for the create path, kept identical on
 * purpose so a row's PR URL is one value across `create` and `status`.
 */
function prIdentity(pr: Record<string, unknown>): { number?: number; url?: string } {
  const id = pr.id;
  const links = pr.links as Record<string, unknown> | undefined;
  const html = links?.html as Record<string, unknown> | undefined;
  const href = html?.href;
  return {
    ...(typeof id === 'number' ? { number: id } : {}),
    ...(typeof href === 'string' && href.length > 0 ? { url: href } : {}),
  };
}

/** A PR object's `headSha`/`baseRef`, as PRESENT-ONLY keys (absent → omitted). */
function prRefs(pr: Record<string, unknown>): { headSha?: string; baseRef?: string } {
  const sha = commitHashOf(pr.source);
  const ref = branchNameOf(pr.destination);
  return {
    ...(sha !== null ? { headSha: sha } : {}),
    ...(ref !== null ? { baseRef: ref } : {}),
  };
}

/** `{ branch: { name } }` → the name, or `null`. */
function branchNameOf(node: unknown): string | null {
  const branch = (node as Record<string, unknown>)?.branch as Record<string, unknown> | undefined;
  const name = branch?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** `{ commit: { hash } }` → the hash, or `null`. */
function commitHashOf(node: unknown): string | null {
  const commit = (node as Record<string, unknown>)?.commit as Record<string, unknown> | undefined;
  const hash = commit?.hash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/** A merged PR payload's `merge_commit.hash`, or `null`. */
function mergeCommitHash(json: unknown): string | null {
  const mc = (json as Record<string, unknown>)?.merge_commit as Record<string, unknown> | undefined;
  const hash = mc?.hash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

/**
 * Surface Bitbucket's own error text in the typed error — operators need it
 * verbatim (an unmet merge check explains itself there and nowhere else).
 * Bitbucket's shape is `{ error: { message, detail? } }`.
 */
function bbMessage(json: unknown, op: string): string | undefined {
  const err = (json as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
  const m = err?.message;
  return typeof m === 'string' && m.length > 0 ? `Bitbucket ${op} failed: ${m}` : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
