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
  method: 'GET' | 'POST';
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
  /** Pull the FIRST open-PR url out of a list response, or `null`. */
  extractFirstOpenPr: (json: unknown) => string | null;
  /** Build the manual pre-fill "open a PR" URL for the fallback signal. */
  prefillUrl: (info: HostInfo, req: CreatePrRequest) => string;
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
 * Query the host for an OPEN PR whose source branch is `branch`. Returns the
 * PR's html URL on a hit, or `null` on a miss (no open PR, or a non-200 query —
 * a query failure is treated as "no known open PR" so the caller proceeds to
 * create; the create step has its own failure handling).
 *
 * This is the idempotency guard: `/wave close` calls it before `createPr` so a
 * re-run that already opened the PR re-pins the existing URL instead of opening
 * a duplicate.
 */
export async function findOpenPr(
  host: Host,
  creds: Creds,
  branch: string,
  info: Pick<HostInfo, 'workspace' | 'repo'>,
  opts: HostOptions = {},
): Promise<string | null> {
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
  return api.extractFirstOpenPr(res.json);
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
 * The host-local landing seam (ADR-0023). GitHub's implementation is
 * `RealGitHubApi` (which structurally satisfies this — see `GitHubApi extends
 * LandingHost`); the Bitbucket pilot implements the same three methods.
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
            `(host-pr create|arm|merge|status supports 'github'; ADR-0023). Check the remote URL, or pass --remote <url> explicitly.`
        : `No landing adapter for host '${host}' — host-pr create|arm|merge|status is implemented for 'github' only (ADR-0023). ` +
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
  | { outcome: 'merged'; prNumber: number; prUrl?: string; sha?: string; reason: string }
  | { outcome: 'armed'; prNumber: number; prUrl?: string; reason: string }
  | { outcome: 'already-merged'; prNumber?: number; prUrl?: string; reason: string }
  | { outcome: 'refused'; prNumber?: number; prUrl?: string; reason: string }
  | { outcome: 'no-pr'; reason: string };

/**
 * Land a branch's PR by the ADR-0023 arm intent: probe → decide → act.
 *
 * Idempotent and re-entrant, because `wave-close` is: an already-merged PR is a
 * no-op (no write of any kind), and a branch with no PR is reported, not thrown.
 * Unexpected host errors propagate — only the two typed
 * {@link AutoMergeUnavailableError} refusals are routed.
 */
export async function armPullRequest(
  host: LandingHost,
  branch: string,
  method: MergeMethod = DEFAULT_MERGE_METHOD,
): Promise<LandingOutcome> {
  const status = await host.getPrStatus(branch);
  const terminal = terminalStatus(status, branch);
  if (terminal !== null) return terminal;

  const prNumber = status.number as number;
  // An open PR with no reported mergeability is `unknown`, NEVER `clean`.
  const decision = decideArmAction(status.mergeability ?? 'unknown');

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
      // Deliberately NOT a merge fallback: checks may still be pending, and
      // merging here would bypass the gate the human expected to hold.
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

/**
 * Merge a branch's PR NOW — the `merge` verb. No decision, no arming: the caller
 * (a human at the wave-close confirm) has already decided. Same idempotency as
 * {@link armPullRequest}.
 */
export async function mergePullRequestNow(
  host: LandingHost,
  branch: string,
  method: MergeMethod = DEFAULT_MERGE_METHOD,
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

/** Perform the merge write + normalise a declined merge into `refused`. */
async function merge(
  host: LandingHost,
  prNumber: number,
  prUrl: string | undefined,
  method: MergeMethod,
  reason: string,
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
  return { outcome: 'merged', prNumber, prUrl, sha: res.sha, reason };
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
    extractFirstOpenPr: (json) => {
      if (json === null || typeof json !== 'object') return null;
      const values = (json as Record<string, unknown>).values;
      if (!Array.isArray(values) || values.length === 0) return null;
      return bbHref(values[0]);
    },
    prefillUrl: (info, req) =>
      `https://bitbucket.org/${info.workspace}/${info.repo}/pull-requests/new?source=${encodeURIComponent(
        req.branch,
      )}&t=1`,
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
    extractFirstOpenPr: (json) => {
      if (!Array.isArray(json) || json.length === 0) return null;
      return ghHtmlUrl(json[0]);
    },
    prefillUrl: (info, req) =>
      `https://github.com/${info.workspace}/${info.repo}/pull/new/${encodeURIComponent(
        req.branch,
      )}`,
  };
}

/** Pull `html_url` from a GitHub PR object. */
function ghHtmlUrl(json: unknown): string | null {
  if (json === null || typeof json !== 'object') return null;
  const href = (json as Record<string, unknown>).html_url;
  return typeof href === 'string' && href.length > 0 ? href : null;
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
