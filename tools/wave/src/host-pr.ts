/**
 * host-pr.ts — host-aware PR boundary for the `/wave close` terminator
 * (wave-orchestration #56, PRD stories 1, 2, 5, 19, 22 / Finding L1).
 *
 * Encapsulates all host-aware PR logic that is currently re-quoted as a raw
 * `curl` block in every Worker brief, behind one narrow interface:
 *
 *   - `detectHost(remoteUrl)` — pure URL parse → `{host, workspace, repo}`.
 *   - `verifyAuth(host, creds)` — the preflight that gates every write
 *     (Finding L1: a mid-flight 401 becomes an up-front warning).
 *   - `findOpenPr(host, creds, branch)` — idempotency: query open PRs on the
 *     source branch BEFORE creating, so a re-run never opens a duplicate.
 *     `findOpenPrRef` is the richer form that also surfaces the PR number.
 *   - `updateOpenPr(host, creds, ref, {title, body})` — on reuse, re-write the
 *     open PR's title/body to the passed values (PATCH/PUT through the same
 *     seam) so the terminator's composed render lands on a Worker-opened PR.
 *   - `createPr(host, creds, {...})` — 201 → real URL; 401/failure → the
 *     pre-fill fallback signal (a returned value, never a throw).
 *
 * The single network side-effect is isolated behind the injectable `HttpProbe`
 * seam (the same pattern `merge-order.ts` uses for its `GitProbe` and
 * `ff-guard.ts` for its `FfProbe`), so the spec drives the GitHub + Bitbucket
 * paths, the 200/401 auth split, the find-before-create idempotency, and the
 * 401 fallback entirely with fixtures and ZERO network access.
 *
 * The Worker-brief terminator should eventually call this same module rather
 * than re-quoting curl (story 19) — that migration is an explicit follow-up,
 * not part of this issue. This issue ships only the tested module.
 */

// ─── Host detection ──────────────────────────────────────────────────────────

/** Supported PR hosts. `unknown` is the safe fallback for any unparseable remote. */
export type Host = 'github' | 'bitbucket' | 'unknown';

/**
 * The parsed coordinates of a git remote. For an `unknown` host both
 * `workspace` and `repo` are empty strings (nothing reliable could be parsed).
 */
export interface HostInfo {
  host: Host;
  /** Owner / org (GitHub) or workspace (Bitbucket). `''` when unknown. */
  workspace: string;
  /** Repository slug, with any trailing `.git` stripped. `''` when unknown. */
  repo: string;
}

/**
 * Parse a git remote URL into `{host, workspace, repo}`.
 *
 * Handles all four canonical forms for both supported hosts:
 *   - GitHub SSH    `git@github.com:owner/repo.git`
 *   - GitHub HTTPS  `https://github.com/owner/repo.git`
 *   - Bitbucket SSH `git@bitbucket.org:workspace/repo.git`
 *   - Bitbucket HTTPS `https://bitbucket.org/workspace/repo.git`
 *
 * HTTPS forms may carry inline credentials (`https://user@host/...`) and an
 * optional trailing slash; both are tolerated. Anything else (a self-hosted
 * GitLab, a local path, junk) returns `{host:'unknown', workspace:'', repo:''}`
 * — the caller then falls back to the pre-fill flow rather than guessing.
 *
 * Pure: no I/O, no host network. Safe to call on any string.
 */
export function detectHost(remoteUrl: string): HostInfo {
  const url = (remoteUrl ?? '').trim();
  if (url === '') return unknownHost();

  const parsed = parseRemote(url);
  if (parsed === null) return unknownHost();

  const host = hostFromDomain(parsed.domain);
  if (host === 'unknown') return unknownHost();

  return {
    host,
    workspace: parsed.workspace,
    repo: stripGitSuffix(parsed.repo),
  };
}

interface RawRemote {
  domain: string;
  workspace: string;
  repo: string;
}

/** Extract `{domain, workspace, repo}` from an SSH or HTTPS remote, else `null`. */
function parseRemote(url: string): RawRemote | null {
  // SCP-like SSH: [user@]host:workspace/repo[.git]
  //   git@github.com:owner/repo.git
  const ssh = /^(?:[^@/]+@)?([^:/]+):([^/]+)\/(.+?)\/?$/.exec(url);
  if (ssh && !url.includes('://')) {
    return { domain: ssh[1], workspace: ssh[2], repo: ssh[3] };
  }

  // URL forms: ssh://, https://, http:// — host + first two path segments.
  //   https://[user@]host[:port]/workspace/repo[.git]
  const proto = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (proto) {
    const afterProto = url.slice(proto[0].length);
    const slash = afterProto.indexOf('/');
    if (slash === -1) return null;
    const authority = afterProto.slice(0, slash);
    const domain = authority.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
    const path = afterProto.slice(slash + 1).replace(/\/+$/, '');
    const segs = path.split('/').filter((s) => s.length > 0);
    if (segs.length < 2) return null;
    // workspace = first segment; repo = the remainder joined (keeps nested
    // Bitbucket workspaces working, though both hosts use exactly two here).
    const workspace = segs[0];
    const repo = segs.slice(1).join('/');
    return { domain, workspace, repo };
  }

  return null;
}

function hostFromDomain(domain: string): Host {
  const d = domain.toLowerCase();
  if (d === 'github.com' || d.endsWith('.github.com')) return 'github';
  if (d === 'bitbucket.org' || d.endsWith('.bitbucket.org')) return 'bitbucket';
  return 'unknown';
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, '');
}

function unknownHost(): HostInfo {
  return { host: 'unknown', workspace: '', repo: '' };
}

// ─── HTTP seam ───────────────────────────────────────────────────────────────

/**
 * One network request. `auth` is the raw credential string the host expects in
 * a Basic `Authorization` header (`user:app-password` for Bitbucket;
 * `x-access-token:<token>` or `user:token` for GitHub). `body` is the
 * already-serialised JSON payload for writes; omitted for reads.
 */
export interface HttpRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  url: string;
  auth: string;
  body?: string;
}

/**
 * The slice of an HTTP response this module needs: the numeric status and the
 * parsed JSON body (or `null` when the body was empty / unparseable). Keeping
 * `json` pre-parsed means the seam owns deserialisation and the pure logic
 * stays string/network-free.
 */
export interface HttpResponse {
  status: number;
  json: unknown;
}

/**
 * Network seam. The default implementation uses global `fetch`; the spec
 * injects a fixture so every path is exercised with NO real network (mirrors
 * the `GitProbe` / `FfProbe` injection in merge-order / ff-guard).
 */
export interface HttpProbe {
  request(req: HttpRequest): Promise<HttpResponse>;
}

// ─── Credentials ─────────────────────────────────────────────────────────────

/**
 * Credentials for a host. `auth` is the Basic-auth credential pair; `identity`
 * is an optional already-known username (used only to build the pre-fill URL —
 * it is never trusted for the auth decision, which always comes from the live
 * preflight).
 */
export interface Creds {
  /** `user:secret` pair placed into the Basic `Authorization` header. */
  auth: string;
  /** Optional username hint (cosmetic; the preflight is authoritative). */
  username?: string;
}

interface HostApi {
  /** Auth-preflight endpoint (`GET` → 200 identity / 401). */
  userUrl: string;
  /** Open-PRs-for-branch query URL builder. */
  openPrUrl: (info: HostInfo, branch: string) => string;
  /** PR-create endpoint. */
  createUrl: (info: HostInfo) => string;
  /** Build the create payload body from the create request. */
  createBody: (req: CreatePrRequest) => string;
  /** Pull the PR html URL out of a list/create response body. */
  extractPrUrl: (json: unknown) => string | null;
  /**
   * Pull the FIRST open-PR ref (html url + host-local number) out of a list
   * response, or `null`. The number is what {@link updateOpenPr} addresses the
   * update PATCH/PUT to; it is optional because a malformed body may omit it,
   * in which case the URL still round-trips (reuse never becomes a duplicate).
   */
  extractOpenPrRef: (json: unknown) => OpenPrRef | null;
  /** Build the manual pre-fill "open a PR" URL for the fallback signal. */
  prefillUrl: (info: HostInfo, req: CreatePrRequest) => string;
  /** HTTP verb the host expects for a PR update (GitHub `PATCH`, Bitbucket `PUT`). */
  updateMethod: 'PATCH' | 'PUT';
  /** Update endpoint for the open PR addressed by its host-local number. */
  updateUrl: (info: HostInfo, prNumber: number) => string;
  /** Serialise the title/body update payload for the host. */
  updateBody: (fields: PrUpdateFields) => string;
}

function apiFor(info: HostInfo): HostApi | null {
  if (info.host === 'bitbucket') return bitbucketApi();
  if (info.host === 'github') return githubApi();
  return null;
}

// ─── verifyAuth ──────────────────────────────────────────────────────────────

/**
 * Result of the auth preflight. `ok:true` carries the resolved `identity`
 * (username, when the host returned one); `ok:false` carries the HTTP status
 * that denied the write (typically 401) so the caller can surface a precise
 * up-front warning instead of failing mid-flight.
 */
export type AuthResult =
  | { ok: true; identity: string }
  | { ok: false; status: number };

export interface HostOptions {
  /** Injectable network seam. Defaults to {@link defaultHttpProbe}. */
  http?: HttpProbe;
}

/**
 * Preflight the credentials against the host's identity endpoint
 * (Finding L1 — Bitbucket `GET /2.0/user`, GitHub `GET /user`). A 200 means
 * the write will be authorised; a 401 means stop now and warn, rather than
 * discovering the 401 only when the PR-create POST fails.
 *
 * Returns `ok:false` (never throws) for an `unknown` host or any non-200.
 */
export async function verifyAuth(
  host: Host,
  creds: Creds,
  opts: HostOptions = {},
): Promise<AuthResult> {
  const api = apiFor({ host, workspace: '', repo: '' });
  if (api === null) return { ok: false, status: 0 };

  const http = opts.http ?? defaultHttpProbe();
  const res = await http.request({
    method: 'GET',
    url: api.userUrl,
    auth: creds.auth,
  });

  if (res.status === 200) {
    return {
      ok: true,
      identity: extractIdentity(res.json) ?? creds.username ?? '',
    };
  }
  return { ok: false, status: res.status };
}

function extractIdentity(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  // Bitbucket: { username } / { display_name }; GitHub: { login }.
  for (const key of ['username', 'login', 'display_name', 'nickname']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ─── findOpenPr ──────────────────────────────────────────────────────────────

/**
 * The coordinates of an already-open PR: its html `url` (the value the wave pins
 * as the row's PR URL) plus the host-local `number` that {@link updateOpenPr}
 * addresses its update to. `number` is optional — a malformed list body may omit
 * it, and the URL alone is enough to REUSE (never open a duplicate); only the
 * body/title UPDATE needs the number.
 */
export interface OpenPrRef {
  /** The PR's html URL. */
  url: string;
  /** The PR's host-local number, when the list body carried one. */
  number?: number;
}

/**
 * Query the host for an OPEN PR whose source branch is `branch`. Returns the
 * PR's `{ url, number? }` on a hit, or `null` on a miss (no open PR, or a
 * non-200 query — a query failure is treated as "no known open PR" so the caller
 * proceeds to create; the create step has its own failure handling).
 *
 * This is the richer form behind {@link findOpenPr}: it additionally surfaces
 * the PR number so the reuse path can PATCH the open PR's title/body to the
 * passed values (the terminator's composition is the authoritative final render;
 * see {@link updateOpenPr}) instead of silently discarding them.
 */
export async function findOpenPrRef(
  host: Host,
  creds: Creds,
  branch: string,
  info: Pick<HostInfo, 'workspace' | 'repo'>,
  opts: HostOptions = {},
): Promise<OpenPrRef | null> {
  const full: HostInfo = { host, workspace: info.workspace, repo: info.repo };
  const api = apiFor(full);
  if (api === null) return null;

  const http = opts.http ?? defaultHttpProbe();
  const res = await http.request({
    method: 'GET',
    url: api.openPrUrl(full, branch),
    auth: creds.auth,
  });

  if (res.status !== 200) return null;
  return api.extractOpenPrRef(res.json);
}

/**
 * Query the host for an OPEN PR whose source branch is `branch`. Returns the
 * PR's html URL on a hit, or `null` on a miss.
 *
 * This is the idempotency guard: `/wave close` calls it before `createPr` so a
 * re-run that already opened the PR re-pins the existing URL instead of opening
 * a duplicate. It delegates to {@link findOpenPrRef} (single query path) and
 * projects to the URL — kept for callers that need only "is there an open PR?".
 */
export async function findOpenPr(
  host: Host,
  creds: Creds,
  branch: string,
  info: Pick<HostInfo, 'workspace' | 'repo'>,
  opts: HostOptions = {},
): Promise<string | null> {
  const ref = await findOpenPrRef(host, creds, branch, info, opts);
  return ref?.url ?? null;
}

// ─── updateOpenPr (reuse-time body/title re-render) ──────────────────────────

/** The authored fields a reuse re-writes onto the open PR. */
export interface PrUpdateFields {
  title: string;
  body: string;
}

/**
 * Outcome of the reuse-time update. `url` is the PR's html URL (a title/body
 * edit never changes it, so it round-trips unchanged from the find). `updated`
 * DISCLOSES whether the PATCH/PUT actually landed: `true` on a 200, `false` when
 * there was nothing to address (no PR number in the find), an unsupported host,
 * or the host declined/errored. A `false` never fails the reuse — the URL is
 * still re-pinned (never a duplicate, never a wave-abort); it only signals that
 * the authoritative render did not reach the live PR body this time.
 */
export interface UpdateOpenPrResult {
  url: string;
  updated: boolean;
}

/**
 * Re-write an already-open PR's title/body to the passed values, through the
 * SAME cross-host `HttpProbe` seam `findOpenPr`/`createPr` use (no new
 * transport). This is the update-on-reuse the find-before-create path grew: when
 * a Worker already opened the PR, the terminator's composed body (verdict render
 * + close phrase) must still reach the live PR — last-writer-wins across a
 * re-dispatch, the render written once at PR-open.
 *
 * Best-effort by contract: a missing PR number, an unsupported host, or a host
 * decline all resolve to `{ url: ref.url, updated: false }` rather than throwing,
 * so a title/body edit the host refuses never aborts the wave — the reuse still
 * re-pins the same open PR.
 */
export async function updateOpenPr(
  host: Host,
  creds: Creds,
  ref: OpenPrRef,
  fields: PrUpdateFields,
  info: Pick<HostInfo, 'workspace' | 'repo'>,
  opts: HostOptions = {},
): Promise<UpdateOpenPrResult> {
  const full: HostInfo = { host, workspace: info.workspace, repo: info.repo };
  const api = apiFor(full);
  // No adapter, or no number to address the update to → re-pin the URL only.
  if (api === null || ref.number === undefined) {
    return { url: ref.url, updated: false };
  }

  const http = opts.http ?? defaultHttpProbe();
  try {
    const res = await http.request({
      method: api.updateMethod,
      url: api.updateUrl(full, ref.number),
      auth: creds.auth,
      body: api.updateBody(fields),
    });
    return { url: ref.url, updated: res.status === 200 };
  } catch {
    // A failed update must never abort the reuse: report the URL, disclose miss.
    return { url: ref.url, updated: false };
  }
}

// ─── createPr ────────────────────────────────────────────────────────────────

/** The PR-create payload (host-neutral; each host's `createBody` shapes it). */
export interface CreatePrRequest {
  /** Source branch. */
  branch: string;
  /** PR title. */
  title: string;
  /** PR description / body. */
  body: string;
  /** Destination branch. Defaults to `'main'` when omitted by the caller. */
  destination?: string;
  /** Host coordinates (workspace + repo). */
  info: HostInfo;
}

/**
 * Result of a create attempt.
 *   - Success → `{ url }` (the new PR's html URL).
 *   - 401 / any failure → `{ error, fallbackPrefillUrl }` — a *returned signal*,
 *     never a throw, so the terminator can write a pre-fill `Closed-by:` line
 *     and continue the wave instead of aborting.
 */
export type CreatePrResult =
  | { url: string }
  | { error: string; fallbackPrefillUrl: string };

/**
 * Create a PR on the host. On a 201 with a parseable html URL, returns
 * `{ url }`. On a 401, any non-2xx, an unparseable success body, or an
 * `unknown` host, returns `{ error, fallbackPrefillUrl }` where the pre-fill
 * URL opens the host's "create a pull request" page pre-seeded with the source
 * branch — the same fallback the curl-block terminator emits today.
 */
export async function createPr(
  host: Host,
  creds: Creds,
  req: Omit<CreatePrRequest, 'info'> & { info?: HostInfo },
  opts: HostOptions = {},
): Promise<CreatePrResult> {
  const info: HostInfo = req.info ?? { host, workspace: '', repo: '' };
  const fullReq: CreatePrRequest = { ...req, info };
  const api = apiFor(info);

  if (api === null) {
    return {
      error: `Unknown host — cannot create a PR for '${host}'.`,
      fallbackPrefillUrl: '',
    };
  }

  const http = opts.http ?? defaultHttpProbe();

  let res: HttpResponse;
  try {
    res = await http.request({
      method: 'POST',
      url: api.createUrl(info),
      auth: creds.auth,
      body: api.createBody(fullReq),
    });
  } catch (err) {
    return {
      error: `PR-create request failed: ${errMessage(err)}`,
      fallbackPrefillUrl: api.prefillUrl(info, fullReq),
    };
  }

  if (res.status === 201 || res.status === 200) {
    const url = api.extractPrUrl(res.json);
    if (url !== null) return { url };
    return {
      error: `PR created (HTTP ${res.status}) but no URL in the response body.`,
      fallbackPrefillUrl: api.prefillUrl(info, fullReq),
    };
  }

  return {
    error: `PR-create returned HTTP ${res.status}${
      res.status === 401 ? ' (unauthorised — check credentials)' : ''
    }.`,
    fallbackPrefillUrl: api.prefillUrl(info, fullReq),
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Landing: arm | merge | status (ADR-0023) ────────────────────────────────
//
// The LANDING half of this module is deliberately host-NEUTRAL and I/O-free: it
// routes on a `PrMergeability` and on two typed errors, nothing else. The host
// specifics live behind {@link LandingHost} — GitHub implements it on the
// `GitHubHttp` seam (RealGitHubApi); the Bitbucket pilot implements the same
// interface, and gets the arm-vs-merge intent below for free (ADR-0023: "new
// adapter, no new skills"). host-pr's OWN cross-host Basic-auth `HttpProbe`
// (verifyAuth/findOpenPr/createPr, above) is untouched — the ADR-0019 boundary
// holds.

/** How a PR is landed. flotilla squash-merges (every live wave to date did). */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** The wave default. Every live flotilla wave (runs 1–4) landed via squash. */
export const DEFAULT_MERGE_METHOD: MergeMethod = 'squash';

/**
 * A PR's landing posture — the host's merge-state, normalised.
 *
 * Mirrors GitHub's REST `mergeable_state` / GraphQL `mergeStateStatus` vocab,
 * chosen as the neutral vocabulary because it is the only one live-proven here;
 * a Bitbucket adapter maps its own state onto these seven.
 *
 *   - `clean`    — mergeable, nothing pending → the host will REJECT an arm.
 *   - `blocked`  — a required check or review is pending/failing.
 *   - `unstable` — a non-required check is failing; still mergeable.
 *   - `behind`   — the base moved ahead; strict-mode requires an update.
 *   - `dirty`    — merge conflicts. No host action lands it.
 *   - `draft`    — draft PR. Not landable until marked ready.
 *   - `unknown`  — the host has not computed mergeability yet (it is async).
 */
export type PrMergeability =
  | 'clean'
  | 'blocked'
  | 'unstable'
  | 'behind'
  | 'dirty'
  | 'draft'
  | 'unknown';

/**
 * The landing state of the PR for a branch. `none` = the host knows no PR for
 * this branch at all (distinct from a PR that exists and is closed).
 * `mergeability` is only meaningful while `state === 'open'`.
 */
export interface PrLandingStatus {
  state: 'open' | 'merged' | 'closed-unmerged' | 'none';
  /** The PR's html URL, when a PR exists. */
  url?: string;
  /** The PR's host-local number, when a PR exists. */
  number?: number;
  /** Only set for an open PR; absent is treated as `unknown` (never as clean). */
  mergeability?: PrMergeability;
}

/** Outcome of a merge write. `merged:false` = the host declined (not an error). */
export interface MergeResult {
  merged: boolean;
  /** The resulting merge commit SHA, when the host reports one. */
  sha?: string;
}

/**
 * The structural outcome of a `host-pr merge --delete-branch` request (consumer
 * KW-F6 — remote branch hygiene at landing). Present on a `merged` outcome ONLY
 * when the caller asked to delete the PR's head branch: its ABSENCE means no
 * deletion was requested, so a merge without the flag stays byte-identical to
 * before. A failed deletion (`deleted:false` + `error`) is a REPORTED
 * degradation, never a merge failure — the merge already happened, so the
 * outcome stays `merged` and the exit code stays 0.
 */
export interface BranchDeletionResult {
  /** The remote head branch the deletion targeted. */
  branch: string;
  /** Whether the host actually deleted the ref. */
  deleted: boolean;
  /** The host's failure message when `deleted:false`; absent on success. */
  error?: string;
}

/**
 * The host-local landing seam (ADR-0023). GitHub's implementation is
 * `RealGitHubApi` (which structurally satisfies this — see `GitHubApi extends
 * LandingHost`); the Bitbucket pilot implements the same methods.
 */
export interface LandingHost {
  /** Resolve the PR for a source branch → its landing state. */
  getPrStatus(branch: string): Promise<PrLandingStatus>;
  /**
   * Arm the PR to merge itself once its checks pass. MUST throw
   * {@link AutoMergeUnavailableError} for the two known refusals (the PR is
   * already clean / the repo forbids auto-merge) so the intent logic can route.
   */
  enableAutoMerge(prNumber: number, method?: MergeMethod): Promise<void>;
  /** Merge the PR now. */
  mergePullRequest(prNumber: number, method?: MergeMethod): Promise<MergeResult>;
  /**
   * Delete the remote head branch `branch` through the host API (GitHub REST
   * `DELETE …/git/refs/heads/{branch}`) — the `host-pr merge --delete-branch`
   * hygiene step (consumer KW-F6). Called ONLY after a successful merge, and
   * only when the caller requested it. MUST throw on a host-side failure so the
   * merge path can record a structural {@link BranchDeletionResult} degradation
   * rather than swallow it — a failed delete never turns the merge into a
   * failure (the merge already landed).
   */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * The host refused to ARM a PR, for a reason the arm-intent logic must route on
 * rather than propagate:
 *
 *   - `clean-status` — the PR has nothing pending, so there is nothing to wait
 *     for; the only landing action is a direct merge (SPIKE 2, ADR-0023).
 *   - `not-allowed`  — the repo's "Allow auto-merge" setting is off. NOT
 *     recoverable by merging: the checks may still be pending, and merging then
 *     would bypass exactly the gate the human expected. Refuse + instruct.
 */
export class AutoMergeUnavailableError extends Error {
  readonly name = 'AutoMergeUnavailableError';
  constructor(
    readonly reason: 'clean-status' | 'not-allowed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * The detected host has no landing adapter. Thrown by the `host-pr` router for
 * `bitbucket` (the pilot's own build) and `unknown`. Typed + coded so the caller
 * can distinguish "this host cannot" from "the arm failed" (ADR-0023).
 */
export class LandingNotImplementedError extends Error {
  readonly name = 'LandingNotImplementedError';
  readonly code = 'adapter-not-implemented';
  constructor(readonly host: Host) {
    super(
      host === 'unknown'
        ? // An unrecognised remote is a DIFFERENT problem from a recognised host
          // with no adapter: there is nothing to implement, because we could not
          // tell what to implement against.
          `Could not identify the code host from the git remote, so there is no landing adapter to route to ` +
            `(host-pr create|arm|merge|status|preflight supports 'github'; ADR-0023). Check the remote URL, or pass --remote <url> explicitly.`
        : `No landing adapter for host '${host}' — host-pr create|arm|merge|status|preflight is implemented for 'github' only (ADR-0023). ` +
            `Implementing the LandingHost interface for ${host} is all that is required; no skill changes are needed.`,
    );
  }
}

/** The deterministic arm intent. */
export type ArmDecision =
  | { action: 'merge'; reason: string }
  | { action: 'enable-auto-merge'; reason: string }
  | { action: 'refuse'; reason: string };

/**
 * Decide how to land an OPEN PR, from its mergeability alone (ADR-0023).
 *
 * This is the whole "arm intent", and it is deliberately a pure total function:
 * flotilla does NOT reverse-engineer `gh pr merge --auto`'s undocumented
 * clean-PR fallback — it decides, then acts.
 *
 *   pending required checks → enable auto-merge   ·   already clean → merge now
 *
 * `unknown` arms rather than merges: mergeability is computed asynchronously by
 * the host, so "not yet known" must never be read as "clean" (that would merge a
 * PR whose checks are still running). If the host then rejects the arm because
 * the PR was in fact clean, {@link armPullRequest} recovers via SPIKE 2's pinned
 * error — the safe order (arm, fall back to merge), not the unsafe one.
 */
export function decideArmAction(mergeability: PrMergeability): ArmDecision {
  switch (mergeability) {
    case 'clean':
      return {
        action: 'merge',
        reason:
          'PR is clean — no pending required checks. Arming a clean PR is rejected by the host; the only landing action is a direct merge.',
      };
    case 'blocked':
      return {
        action: 'enable-auto-merge',
        reason: 'A required check or review is still pending — arm the PR to land itself once it passes.',
      };
    case 'unstable':
      return {
        action: 'enable-auto-merge',
        reason: 'A non-required check is failing or still running — arm the PR rather than merging over it.',
      };
    case 'behind':
      return {
        action: 'enable-auto-merge',
        reason: 'The base branch moved ahead — arm the PR so the host updates and lands it under its own rules.',
      };
    case 'unknown':
      return {
        action: 'enable-auto-merge',
        reason:
          'The host has not computed mergeability yet — arm (never merge) so a PR with running checks is not landed blind.',
      };
    case 'dirty':
      return {
        action: 'refuse',
        reason: 'The PR has merge conflicts — no host action can land it. Rebase/resolve, then re-run.',
      };
    case 'draft':
      return {
        action: 'refuse',
        reason: 'The PR is a draft — mark it ready for review before landing.',
      };
  }
}

/** What a landing attempt did. Every variant is terminal + reportable. */
export type LandingOutcome =
  | {
      outcome: 'merged';
      prNumber: number;
      prUrl?: string;
      sha?: string;
      reason: string;
      /**
       * The `--delete-branch` outcome (consumer KW-F6). Present ONLY when the
       * `merge` verb was asked to delete the head branch — absent otherwise, so a
       * merge without the flag is byte-identical. A `deleted:false` here is a
       * reported degradation, never a merge failure (this stays `merged`).
       */
      branchDeletion?: BranchDeletionResult;
    }
  | { outcome: 'armed'; prNumber: number; prUrl?: string; reason: string }
  | { outcome: 'already-merged'; prNumber?: number; prUrl?: string; reason: string }
  | { outcome: 'refused'; prNumber?: number; prUrl?: string; reason: string }
  | { outcome: 'no-pr'; reason: string };

// ─── Aligned PR reference (one url/number field name across every verb) ───────
//
// FOR-54: the four `host-pr` verbs (create | status | arm | merge) historically
// carried the PR url/number under INCONSISTENT names — `url`/`number` on
// create+status, `prUrl`/`prNumber` on the landing outcomes — so no caller could
// read a single field name across all four (observed live filing a retro PR: a
// caller reading `.prUrl` off `create` got null even though the URL was really
// there under `.url`). The fix is deliberately ADDITIVE: every verb result now
// exposes the URL under BOTH `url` AND `prUrl`, and the number under BOTH
// `number` AND `prNumber`, so any single field name a caller picks resolves on
// every verb — and no historical name is renamed or dropped, so the live
// consumers keep working unchanged (the Worker terminator reads `create.url` as
// its prUrl; wave-close reads `status`/`arm` url+number).

/**
 * A PR's url/number exposed under BOTH field-name conventions at once — the
 * historical `url`/`number` AND the `prUrl`/`prNumber` the landing verbs grew.
 * Every key is optional because a given verb may lack one (a `create` result
 * carries no PR number — a deliberate, documented omission: find-before-create
 * only round-trips the URL).
 */
export interface AlignedPrRef {
  url?: string;
  prUrl?: string;
  number?: number;
  prNumber?: number;
}

/**
 * Project a canonical PR `{ url?, number? }` onto BOTH field-name conventions
 * (FOR-54, purely additive). A defined `url` is emitted as both `url` and
 * `prUrl`; a defined `number` as both `number` and `prNumber`. An `undefined`
 * input drops out entirely — the key is ABSENT, not `undefined` — so a create
 * result (no number) yields `{ url, prUrl }` and nothing else, and a `no-pr`
 * outcome (neither) yields `{}`.
 *
 * This is the single owner of the url/number alignment: the CLI emitters route
 * every verb's result through it so the four verbs read identically, regardless
 * of which builder produced the underlying value.
 */
export function alignedPrRef(ref: { url?: string; number?: number }): AlignedPrRef {
  const aligned: AlignedPrRef = {};
  if (ref.url !== undefined) {
    aligned.url = ref.url;
    aligned.prUrl = ref.url;
  }
  if (ref.number !== undefined) {
    aligned.number = ref.number;
    aligned.prNumber = ref.number;
  }
  return aligned;
}

/**
 * Mergeability values GitHub reports while it is still working something out —
 * "not yet computed" (`unknown`) or "the base moved, recomputing against it"
 * (`behind`) — rather than a genuine, settled read. Read at the wrong instant
 * either looks exactly like a real block, but neither IS one (W10-F1, the
 * 2026-07-20 live gate: once a sibling PR in the same wave merged, every OTHER
 * open PR briefly read one of these against the new base).
 */
const RECOMPUTING_MERGEABILITY = new Set<PrMergeability>(['unknown', 'behind']);

/** Default shape of {@link awaitStableMergeability}'s brief retry (ADR-0023 amendment). */
const DEFAULT_RECOMPUTE_RETRIES = 2;
const DEFAULT_RECOMPUTE_RETRY_DELAY_MS = 250;

/** Injectable knobs for {@link armPullRequest}'s recompute-retry (ADR-0023 amendment, W10-F1). */
export interface ArmOptions {
  /** Delay between recompute probes. Defaults to a real timer; tests inject an instant one. */
  sleep?: (ms: number) => Promise<void>;
  /** How many extra `getPrStatus` probes a recomputing mergeability gets before deciding anyway. Default 2. */
  recomputeRetries?: number;
  /** Delay per retry, in ms. Default 250. */
  recomputeRetryDelayMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give a `behind`/`unknown` mergeability a brief chance to settle before the
 * arm decision is made (ADR-0023 amendment, W10-F1 live gate): once a sibling
 * PR in the same wave merges, GitHub briefly recomputes every OTHER open PR's
 * mergeability against the new base. Deciding on that mid-flight read degrades
 * a perfectly-landable PR (arms — or worse, refuses — for no reason) instead of
 * just landing it. Re-probes up to `recomputeRetries` times, stopping at the
 * first settled (non-recomputing) read; if it never settles, the caller
 * proceeds with the last-known read anyway — the refused+mergeable fallback in
 * {@link armPullRequest} is what recovers that residual case.
 */
async function awaitStableMergeability(
  host: LandingHost,
  branch: string,
  status: PrLandingStatus,
  opts: ArmOptions,
): Promise<PrLandingStatus> {
  const retries = opts.recomputeRetries ?? DEFAULT_RECOMPUTE_RETRIES;
  const delayMs = opts.recomputeRetryDelayMs ?? DEFAULT_RECOMPUTE_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let current = status;
  for (
    let attempt = 0;
    attempt < retries && RECOMPUTING_MERGEABILITY.has(current.mergeability ?? 'unknown');
    attempt++
  ) {
    await sleep(delayMs);
    current = await host.getPrStatus(branch);
  }
  return current;
}

/**
 * Whether a (post-retry) mergeability rules out a pending REQUIRED check.
 * `blocked` is host-pr's own vocabulary for exactly that pending state (see
 * {@link PrMergeability}'s docblock) — every OTHER value reachable here
 * (`unstable`/`behind`/`unknown`) reports nothing required as still pending.
 * This reuses the module's existing fact rather than inventing a new one
 * (ADR-0016 single-owner): it is the "zero pending required checks" gate for
 * the refused+mergeable fallback below.
 */
function hasNoPendingRequiredCheck(mergeability: PrMergeability): boolean {
  return mergeability !== 'blocked';
}

/**
 * Land a branch's PR by the ADR-0023 arm intent: probe → decide → act.
 *
 * Idempotent and re-entrant, because `wave-close` is: an already-merged PR is a
 * no-op (no write of any kind), and a branch with no PR is reported, not thrown.
 * Unexpected host errors propagate — only the two typed
 * {@link AutoMergeUnavailableError} refusals are routed.
 *
 * Controlled degradation (ADR-0023 amendment, W10-F1): on ANY refusal — the
 * repo forbids auto-merge, or the host says the PR is already clean — with
 * zero pending required checks, the arm falls back to a direct merge instead
 * of stopping at `refused`; with a required check still pending it never does
 * (`refused` stays `refused` — arm must never merge past a check).
 */
export async function armPullRequest(
  host: LandingHost,
  branch: string,
  method: MergeMethod = DEFAULT_MERGE_METHOD,
  opts: ArmOptions = {},
): Promise<LandingOutcome> {
  const initial = await host.getPrStatus(branch);
  const initialTerminal = terminalStatus(initial, branch);
  if (initialTerminal !== null) return initialTerminal;

  // Let a transient behind/recomputing read settle before deciding (AC2).
  const status = await awaitStableMergeability(host, branch, initial, opts);
  // The PR may have reached a terminal state (e.g. merged elsewhere) DURING
  // the retry window — re-check rather than blindly acting on a stale `open`.
  const terminal = terminalStatus(status, branch);
  if (terminal !== null) return terminal;

  const prNumber = status.number as number;
  // An open PR with no reported mergeability is `unknown`, NEVER `clean`.
  const mergeability = status.mergeability ?? 'unknown';
  const decision = decideArmAction(mergeability);

  if (decision.action === 'refuse') {
    return { outcome: 'refused', prNumber, prUrl: status.url, reason: decision.reason };
  }

  if (decision.action === 'merge') {
    return merge(host, prNumber, status.url, method, decision.reason);
  }

  try {
    await host.enableAutoMerge(prNumber, method);
    return { outcome: 'armed', prNumber, prUrl: status.url, reason: decision.reason };
  } catch (err) {
    if (err instanceof AutoMergeUnavailableError && err.reason === 'clean-status') {
      // SPIKE 2 (ADR-0023): the host says the PR is already clean — the arm was
      // the safe guess, the merge is the correct action. This is the ONLY path
      // that converts an arm into an immediate merge, and the host itself is the
      // authority that nothing is pending.
      return merge(
        host,
        prNumber,
        status.url,
        method,
        `Host rejected the arm: the PR is already clean (nothing pending) — merged directly instead. [${err.message}]`,
      );
    }
    if (err instanceof AutoMergeUnavailableError && err.reason === 'not-allowed') {
      if (hasNoPendingRequiredCheck(mergeability)) {
        // Controlled degrade (ADR-0023 amendment, W10-F1 live gate): the repo
        // forbids arming, but nothing REQUIRED is reported pending, so there is
        // nothing to actually wait for — merge directly instead of stopping at
        // `refused`. The host stays the final gate: a genuine block still
        // declines/throws here, never silently bypassed.
        return merge(
          host,
          prNumber,
          status.url,
          method,
          `Host rejected the arm: this repository does not permit auto-merge, and no required check is pending — merged directly instead (controlled degrade). [${err.message}]`,
        );
      }
      // Deliberately NOT a merge fallback: a required check IS reported
      // pending, and merging here would bypass exactly the gate the human
      // expected to hold.
      return {
        outcome: 'refused',
        prNumber,
        prUrl: status.url,
        reason:
          `The repository does not permit auto-merge, so this PR cannot be armed. Enable "Allow auto-merge" ` +
          `(Settings → General → Pull Requests) and re-run, or land this row via the advisory merge-order. [${err.message}]`,
      };
    }
    throw err;
  }
}

/** Options for the `merge` verb ({@link mergePullRequestNow}). */
export interface MergeOptions {
  /**
   * After a successful merge, delete the PR's remote head branch through the
   * host API (`host-pr merge --delete-branch`, consumer KW-F6 — remote branch
   * hygiene at landing). Off by default: a merge without it is byte-identical to
   * before. A deletion failure is reported structurally on the `merged` outcome
   * ({@link BranchDeletionResult}), never a merge failure. Deliberately scoped to
   * the `merge` verb — `arm` DEFERS the merge to the host (auto-merge lands it
   * out of band, so there is no synchronous post-merge moment here to delete in;
   * repo-level "automatically delete head branches" is the arm-path story).
   */
  deleteBranch?: boolean;
}

/**
 * Merge a branch's PR NOW — the `merge` verb. No decision, no arming: the caller
 * (a human at the wave-close confirm) has already decided. Same idempotency as
 * {@link armPullRequest}.
 */
export async function mergePullRequestNow(
  host: LandingHost,
  branch: string,
  method: MergeMethod = DEFAULT_MERGE_METHOD,
  opts: MergeOptions = {},
): Promise<LandingOutcome> {
  const status = await host.getPrStatus(branch);
  const terminal = terminalStatus(status, branch);
  if (terminal !== null) return terminal;
  return merge(
    host,
    status.number as number,
    status.url,
    method,
    'Direct merge requested — no arm intent evaluated.',
    // Delete the just-merged head branch only when the flag was passed (KW-F6);
    // the branch is the PR's own source branch (`--branch`), which IS the head.
    opts.deleteBranch ? branch : undefined,
  );
}

/**
 * The status cases both verbs short-circuit on identically: no PR, an
 * already-merged PR (idempotent no-op), a closed-unmerged PR (refuse — never
 * re-open), and the defensive "open but the host reported no number".
 * `null` means "an open, actionable PR — carry on".
 */
function terminalStatus(status: PrLandingStatus, branch: string): LandingOutcome | null {
  if (status.state === 'none') {
    return { outcome: 'no-pr', reason: `No pull request found for branch '${branch}'.` };
  }
  if (status.state === 'merged') {
    return {
      outcome: 'already-merged',
      prNumber: status.number,
      prUrl: status.url,
      reason: 'The PR is already merged — nothing to do.',
    };
  }
  if (status.state === 'closed-unmerged') {
    return {
      outcome: 'refused',
      prNumber: status.number,
      prUrl: status.url,
      reason: 'The PR is closed without a merge — flotilla never re-opens a PR (ADR-0005). Resolve by hand.',
    };
  }
  if (status.number === undefined) {
    return {
      outcome: 'refused',
      prUrl: status.url,
      reason: 'The host reported an open PR without a number — cannot address it.',
    };
  }
  return null;
}

/**
 * Perform the merge write + normalise a declined merge into `refused`.
 *
 * `deleteBranchOf`, when given, is the head branch to delete AFTER a successful
 * merge (`host-pr merge --delete-branch`, consumer KW-F6). It is threaded only
 * by {@link mergePullRequestNow} — {@link armPullRequest}'s three merge call-sites
 * omit it, so the arm path never deletes and stays byte-identical. The deletion
 * is best-effort: a failure is captured on `branchDeletion` (a reported
 * degradation), never propagated, so the merge result never flips to a failure.
 */
async function merge(
  host: LandingHost,
  prNumber: number,
  prUrl: string | undefined,
  method: MergeMethod,
  reason: string,
  deleteBranchOf?: string,
): Promise<LandingOutcome> {
  const res = await host.mergePullRequest(prNumber, method);
  if (!res.merged) {
    return {
      outcome: 'refused',
      prNumber,
      prUrl,
      reason: `The host declined the merge (no error, but merged=false). ${reason}`,
    };
  }
  // The merge landed. Only when a deletion was requested do we touch the branch
  // — and its outcome is recorded structurally, so a failed delete degrades the
  // report without un-merging the PR. Absent the request, the merged shape is
  // exactly what it was before (no `branchDeletion` key at all).
  const branchDeletion =
    deleteBranchOf !== undefined ? await deleteHeadBranch(host, deleteBranchOf) : undefined;
  return {
    outcome: 'merged',
    prNumber,
    prUrl,
    sha: res.sha,
    reason,
    ...(branchDeletion !== undefined ? { branchDeletion } : {}),
  };
}

/**
 * Delete the just-merged PR's remote head branch, CAPTURING the outcome rather
 * than propagating a failure (consumer KW-F6): the merge already succeeded, so a
 * ref-deletion refusal — the branch is already gone, protected, or a transient
 * host error — is a reported degradation, never a merge failure.
 */
async function deleteHeadBranch(host: LandingHost, branch: string): Promise<BranchDeletionResult> {
  try {
    await host.deleteBranch(branch);
    return { branch, deleted: true };
  } catch (err) {
    return { branch, deleted: false, error: errMessage(err) };
  }
}

// ─── Host preflight: code-host posture probe (ADR-0023 amendment, W10-F1) ─────
//
// The POSTURE half of the host seam. Where `armPullRequest` acts on ONE PR,
// `preflightHost` answers the wave-level question "can this repo land rows under
// `--auto` at all?" — reusing the same host adapter. It is store-BLIND: the
// tracker (github/linear/markdown) is irrelevant, because landing always happens
// on the code host, so `host-pr preflight` gives an identical answer on every
// store kind (this is the W10-F1 fix — the store-preflight reported these
// `not-applicable` on a linear store, and the arm outcome was the only truth).
// GitHub implements `LandingPosture` on `RealGitHubApi`; the Bitbucket pilot
// inherits the probe by implementing the same three reads (ADR-0023: new
// adapter, no new skills).

/**
 * The repo's "Allow auto-merge" setting, as the ambient token can OBSERVE it.
 * `unknown` is a first-class answer, not a failure: GitHub hides the setting
 * below maintain/admin, and an external consumer token must never NEED admin
 * (ADR-0023 amendment — the `closed-unknown` lesson applied at the settings
 * layer: absence of evidence is not a finding).
 */
export type AutoMergeSetting = 'on' | 'off' | 'unknown';

/**
 * The presence of required status checks on a branch (ADR-0023). REPORT-ONLY: a
 * repo with none is a valid `--auto` consumer (a clean PR direct-merges), so this
 * never hard-FAILs, and `unknown` is first-class — the branch-protection read
 * needs admin the ambient token may lack. Host-neutral: GitHub and the Bitbucket
 * pilot both produce this shape (it lived on the GitHub adapter before the
 * ADR-0023 amendment re-homed the posture concern to the host seam).
 */
export interface RequiredChecksInfo {
  state: 'present' | 'absent' | 'unknown';
  /** The required check contexts, when readable. Empty for absent/unknown. */
  contexts: string[];
  /** Human-readable account of what was probed and what came back. */
  detail: string;
}

/**
 * The code-host POSTURE seam (ADR-0023 amendment). The three reads `host-pr
 * preflight` grades. `GitHubApi extends` this (RealGitHubApi implements it on the
 * `GitHubHttp` seam); a Bitbucket adapter implements the same three and inherits
 * the probe. Distinct from {@link LandingHost} (per-PR arm/merge/status): this is
 * the repo-level "can we `--auto` here?" question, not a single PR's landing.
 */
export interface LandingPosture {
  /**
   * Whether the ambient token can MERGE pull requests on the bound repo — write
   * (push) access or higher. Surfaces a read-only token LOUDLY up-front rather
   * than mid-wave at merge time.
   */
  canMergePullRequests(): Promise<boolean>;
  /**
   * The repo's "Allow auto-merge" setting as the token can see it. `unknown` when
   * the token cannot read it (GitHub hides it below maintain/admin) — never a
   * failure, never an admin requirement (ADR-0023 amendment).
   */
  getAutoMergeSetting(): Promise<AutoMergeSetting>;
  /**
   * Required status checks on `branch` (default: the repo's DEFAULT branch — the
   * branch that gates landing to `main`). REPORT-ONLY — MUST NOT throw (an
   * advisory probe may never block).
   */
  getRequiredChecks(branch?: string): Promise<RequiredChecksInfo>;
}

/**
 * The check-status union, SHARED with the store-preflight (`cli-store`). Only
 * `fail` blocks; `advisory` and `unknown` are read-and-carry-on. `unknown`
 * (ADR-0023 amendment) is "the token cannot see this setting" — absence of
 * evidence, never a finding, never an admin requirement.
 */
export type CheckStatus = 'pass' | 'fail' | 'not-applicable' | 'advisory' | 'unknown';

/**
 * The three code-host checks `host-pr preflight` reports. Single-owner (ADR-0023
 * amendment): they left `cli-store preflight` entirely — one fact, one owner.
 */
export type HostCheckName = 'pr-merge-token' | 'allow-auto-merge' | 'required-checks';

/** One probed code-host precondition. */
export interface HostPreflightCheck {
  name: HostCheckName;
  status: CheckStatus;
  detail: string;
}

/** The `host-pr preflight` report. `ok` is `true` iff no check is `fail`. */
export interface HostPreflightReport {
  ok: boolean;
  host: Host;
  checks: HostPreflightCheck[];
}

/**
 * Probe the code host's landing posture through the {@link LandingPosture} seam
 * (ADR-0023 amendment). Reports `pr-merge-token`, `allow-auto-merge`, and
 * `required-checks` — the three checks the `--auto` confirm and `wave-setup`
 * onboarding read. Advisory by design: the probe informs the confirm, the ARM
 * OUTCOME stays the ground truth. `unknown` never blocks; only a visible-OFF
 * auto-merge WITH required checks is a hard `fail`.
 */
export async function preflightHost(host: Host, posture: LandingPosture): Promise<HostPreflightReport> {
  const canMerge = await posture.canMergePullRequests();
  const autoMerge = await posture.getAutoMergeSetting();
  // Read against the DEFAULT branch (no branch arg). `getRequiredChecks` is
  // contractually throw-free, so it needs no guard here.
  const required = await posture.getRequiredChecks();

  const checks: HostPreflightCheck[] = [
    prMergeTokenCheck(canMerge),
    allowAutoMergeCheck(autoMerge, required.state),
    requiredChecksCheck(required),
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), host, checks };
}

function prMergeTokenCheck(canMerge: boolean): HostPreflightCheck {
  return {
    name: 'pr-merge-token',
    status: canMerge ? 'pass' : 'fail',
    detail: canMerge
      ? 'The ambient GITHUB_TOKEN has write access — it can merge PRs on the bound repo.'
      : 'The ambient GITHUB_TOKEN lacks write (push) access — it CANNOT merge PRs on the bound repo. Grant it write (push) access before landing a wave.',
  };
}

/**
 * Grade the "Allow auto-merge" setting. A visible OFF grades by CONTEXT
 * (ADR-0023 amendment): required checks present → `fail` (arming is structurally
 * impossible, and there IS something to arm for); none → `advisory` (a clean PR
 * direct-merges today, so it only matters once CI arrives). `unknown` (the token
 * cannot see the setting) never blocks and never demands admin.
 */
function allowAutoMergeCheck(setting: AutoMergeSetting, requiredState: RequiredChecksInfo['state']): HostPreflightCheck {
  if (setting === 'on') {
    return {
      name: 'allow-auto-merge',
      status: 'pass',
      detail: 'The repo setting "Allow auto-merge" is ON — PRs with pending checks can be armed to land themselves.',
    };
  }
  if (setting === 'unknown') {
    return {
      name: 'allow-auto-merge',
      status: 'unknown',
      detail:
        'Could not read the "Allow auto-merge" setting — the GITHUB_TOKEN cannot see it (GitHub hides it below maintain/admin). ' +
        'This is advisory only and never blocks: an external consumer token needs no admin rights. Verify by hand under ' +
        'Settings → General → Pull Requests, and tick "Allow auto-merge" if it is off. The arm outcome remains the ground truth (ADR-0023).',
    };
  }
  // setting === 'off' — a VISIBLE off, graded by whether there is anything to arm for.
  if (requiredState === 'present') {
    return {
      name: 'allow-auto-merge',
      status: 'fail',
      detail:
        'The repo setting "Allow auto-merge" is OFF (the GitHub default) and this branch has required status checks — a checks-pending PR ' +
        'CANNOT be armed, so `wave-close --auto` cannot land those rows. Fix: Settings → General → Pull Requests → tick "Allow auto-merge" ' +
        '(API: PATCH /repos/{owner}/{repo} with allow_auto_merge=true). Until then, land this wave via the advisory merge-order (ADR-0023).',
    };
  }
  return {
    name: 'allow-auto-merge',
    status: 'advisory',
    detail:
      'The repo setting "Allow auto-merge" is OFF (the GitHub default), but this branch has no required status checks to wait for — ' +
      'a clean PR direct-merges today, so arming is not needed yet. Tick "Allow auto-merge" (Settings → General → Pull Requests) before CI ' +
      'is added, so checks-pending PRs can be armed then (ADR-0023).',
  };
}

/**
 * Grade required-status-checks presence into the confirm sentence. `present` /
 * `absent` are advisory (report-only, never a fault); `unknown` (the probe needs
 * admin the token lacks) is `unknown` — the arm intent is decided per-PR anyway.
 */
function requiredChecksCheck(required: RequiredChecksInfo): HostPreflightCheck {
  if (required.state === 'present') {
    const named = required.contexts.length > 0 ? ` Required: ${required.contexts.join(', ')}.` : '';
    return {
      name: 'required-checks',
      status: 'advisory',
      detail: `${required.detail}${named} \`--auto\` will ARM these PRs: they land themselves once the checks pass.`,
    };
  }
  if (required.state === 'absent') {
    return {
      name: 'required-checks',
      status: 'advisory',
      detail: `${required.detail} There is nothing to wait for, so confirming \`--auto\` means these PRs merge IMMEDIATELY — backed by the Worker's verify run and the Reviewer's independent one, not by CI. This is expected, not a fault (ADR-0023).`,
    };
  }
  return {
    name: 'required-checks',
    status: 'unknown',
    detail: `${required.detail} Verify the branch's required checks by hand if you need certainty; \`--auto\` still works — the arm intent is decided per-PR from each PR's live merge-state, and the arm outcome is the ground truth (ADR-0023).`,
  };
}

// ─── Bitbucket API shape ─────────────────────────────────────────────────────

function bitbucketApi(): HostApi {
  const base = 'https://api.bitbucket.org/2.0';
  return {
    userUrl: `${base}/user`,
    openPrUrl: (info, branch) => {
      const q = `source.branch.name="${branch}"&state=OPEN`;
      return `${base}/repositories/${info.workspace}/${info.repo}/pullrequests?q=${encodeURIComponent(
        q,
      )}`;
    },
    createUrl: (info) =>
      `${base}/repositories/${info.workspace}/${info.repo}/pullrequests`,
    createBody: (req) =>
      JSON.stringify({
        title: req.title,
        description: req.body,
        source: { branch: { name: req.branch } },
        destination: { branch: { name: req.destination ?? 'main' } },
        close_source_branch: true,
      }),
    extractPrUrl: (json) => bbHref(json),
    extractOpenPrRef: (json) => {
      if (json === null || typeof json !== 'object') return null;
      const values = (json as Record<string, unknown>).values;
      if (!Array.isArray(values) || values.length === 0) return null;
      return bbRef(values[0]);
    },
    prefillUrl: (info, req) =>
      `https://bitbucket.org/${info.workspace}/${info.repo}/pull-requests/new?source=${encodeURIComponent(
        req.branch,
      )}&t=1`,
    updateMethod: 'PUT',
    updateUrl: (info, prNumber) =>
      `${base}/repositories/${info.workspace}/${info.repo}/pullrequests/${prNumber}`,
    updateBody: (fields) => JSON.stringify({ title: fields.title, description: fields.body }),
  };
}

/** Pull `links.html.href` from a Bitbucket PR object. */
function bbHref(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const links = (json as Record<string, unknown>).links;
  if (links === null || typeof links !== 'object') return null;
  const html = (links as Record<string, unknown>).html;
  if (html === null || typeof html !== 'object') return null;
  const href = (html as Record<string, unknown>).href;
  return typeof href === 'string' && href.length > 0 ? href : null;
}

/** Pull `{ url, number? }` from a Bitbucket PR object (`links.html.href` + `id`). */
function bbRef(json: unknown): OpenPrRef | null {
  const url = bbHref(json);
  if (url === null) return null;
  const id = (json as Record<string, unknown>).id;
  return typeof id === 'number' ? { url, number: id } : { url };
}

// ─── GitHub API shape ────────────────────────────────────────────────────────

function githubApi(): HostApi {
  const base = 'https://api.github.com';
  return {
    userUrl: `${base}/user`,
    openPrUrl: (info, branch) =>
      `${base}/repos/${info.workspace}/${info.repo}/pulls?state=open&head=${encodeURIComponent(
        `${info.workspace}:${branch}`,
      )}`,
    createUrl: (info) => `${base}/repos/${info.workspace}/${info.repo}/pulls`,
    createBody: (req) =>
      JSON.stringify({
        title: req.title,
        body: req.body,
        head: req.branch,
        base: req.destination ?? 'main',
      }),
    extractPrUrl: (json) => ghHtmlUrl(json),
    extractOpenPrRef: (json) => {
      if (!Array.isArray(json) || json.length === 0) return null;
      return ghRef(json[0]);
    },
    prefillUrl: (info, req) =>
      `https://github.com/${info.workspace}/${info.repo}/pull/new/${encodeURIComponent(
        req.branch,
      )}`,
    updateMethod: 'PATCH',
    updateUrl: (info, prNumber) => `${base}/repos/${info.workspace}/${info.repo}/pulls/${prNumber}`,
    updateBody: (fields) => JSON.stringify({ title: fields.title, body: fields.body }),
  };
}

/** Pull `html_url` from a GitHub PR object. */
function ghHtmlUrl(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const href = (json as Record<string, unknown>).html_url;
  return typeof href === 'string' && href.length > 0 ? href : null;
}

/** Pull `{ url, number? }` from a GitHub PR object (`html_url` + `number`). */
function ghRef(json: unknown): OpenPrRef | null {
  const url = ghHtmlUrl(json);
  if (url === null) return null;
  const number = (json as Record<string, unknown>).number;
  return typeof number === 'number' ? { url, number } : { url };
}

// ─── Default network probe (real side-effect, isolated here) ─────────────────

/**
 * Default {@link HttpProbe} backed by global `fetch` (Node 18+/24). All real
 * network lives here so the rest of the module is pure and the spec swaps a
 * fixture probe. Basic-auth header is built from the `user:secret` `auth`
 * string; a non-JSON / empty body resolves to `json: null` rather than throwing
 * (the status alone drives every decision).
 */
export function defaultHttpProbe(): HttpProbe {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const headers: Record<string, string> = {
        Authorization: `Basic ${base64(req.auth)}`,
        Accept: 'application/json',
        'User-Agent': 'flotilla-wave-tools',
      };
      if (req.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        body: req.body,
      });
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

function base64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}
