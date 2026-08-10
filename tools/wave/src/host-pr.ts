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
 *     `findOpenPrRef` is the richer form that also surfaces the PR number AND
 *     the PR's current body (the evidence the close-phrase guard below needs).
 *   - `updateOpenPr(host, creds, ref, {title, body})` — on reuse, re-write the
 *     open PR's title/body to the passed values (PATCH/PUT through the same
 *     seam) so the terminator's composed render lands on a Worker-opened PR —
 *     UNLESS that rewrite would drop a close phrase the live body carries
 *     (`closePhraseLossReason`, the one property the reuse must not lose).
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
  /**
   * The PR's CURRENT description, when the list response carried one. Read only
   * so the reuse can compare what is already on the PR against what it is about
   * to write ({@link closePhraseLossReason}) — nothing else consumes it.
   *
   * Three-valued on purpose, the same evidence-vs-absence distinction the
   * closing probe draws (W2-F1c): a string — INCLUDING `''` — is EVIDENCE of
   * what the live PR says; `undefined` means the body was not readable here (an
   * older/partial list shape, a host that omits it), which is absence of
   * evidence and therefore never a finding. The guard refuses only on evidence.
   */
  body?: string;
}

/**
 * Query the host for an OPEN PR whose source branch is `branch`. Returns the
 * PR's `{ url, number?, body? }` on a hit, or `null` on a miss (no open PR, or a
 * non-200 query — a query failure is treated as "no known open PR" so the caller
 * proceeds to create; the create step has its own failure handling).
 *
 * This is the richer form behind {@link findOpenPr}: it additionally surfaces
 * the PR number so the reuse path can PATCH the open PR's title/body to the
 * passed values (the terminator's composition is the authoritative final render;
 * see {@link updateOpenPr}) instead of silently discarding them — and the PR's
 * CURRENT body, which is the evidence {@link closePhraseLossReason} grades that
 * rewrite against.
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

// ─── The close-phrase guard (the one property a reuse must not lose) ─────────
//
// `create`'s reuse is last-writer-wins, and that is deliberate: a cap=1
// re-dispatch must land its freshly composed render on the PR the first Worker
// already opened. What made it a hazard is WHAT lives in that body — the
// store-kind close phrase (`Closes #N` / `Fixes TEAM-NN`, wave-shared
// Convention 4). A rewrite that drops it does not fail anywhere: the PR merges
// normally and the row simply never reaches `done`. One exploratory
// `--title probe --body probe` call reproduced exactly that on a live PR
// (docs/retros/2026-07-27-plugin-consumer-w1.md, DA-F6).
//
// So the guard is deliberately narrow — it protects the ONE property whose loss
// is silent, and nothing else. Everything the reuse legitimately rewrites (the
// verdict render, the summary, the title) stays last-writer-wins.

/**
 * The closing keywords a tracker acts on (`Closes`, `CLOSED`, `fix`, `Resolved`,
 * …), spelled with per-character classes rather than carried on an `i` flag.
 * The flag is unusable here because it would apply to the WHOLE pattern, and the
 * Linear reference form below is only tellable from prose by its team key being
 * genuinely UPPERCASE — under `i`, a lowercase `utf-8` reads as a team reference.
 */
const CLOSE_KEYWORD = String.raw`(?:[Cc][Ll][Oo][Ss][Ee][SsDd]?|[Ff][Ii][Xx](?:[Ee][SsDd])?|[Rr][Ee][Ss][Oo][Ll][Vv][Ee][SsDd]?)`;

/**
 * The reference shapes a tracker actually resolves: `#42` (GitHub), `TEAM-16`
 * (Linear — uppercase team key, no `_`, which is not a legal team-key char), or
 * a full issue URL. The trailing `(?![\w-])` makes the reference TOKEN-BOUNDED:
 * it must be a whole token, never the head of a longer hyphenated one, so
 * `ISO-8601-2019` or `EX-16-rc1` can never be read as a reference.
 */
const ISSUE_REF = String.raw`(?:#\d+|[A-Z][A-Z0-9]{0,9}-\d+|https?:\/\/\S+\/issues\/\d+)(?![\w-])`;

/**
 * A store-kind close phrase, on a line it OWNS: nothing before it but optional
 * indent or a list marker, nothing after it but optional sentence punctuation.
 * Tolerant of the `Closes: #42` colon form and of a `\r` line ending (GitHub
 * hands back CRLF bodies). This is presence detection for the guard below — NOT
 * a parser: it never needs to say WHICH issue closes, only whether a body
 * carries a closing phrase at all.
 *
 * The own-line anchoring is what keeps coincidental prose out, and it is the
 * only thing that can: a mid-sentence `…resolves UTF-8 encoding edge cases…` is
 * STRUCTURALLY identical to a genuine `Fixes EX-8` — keyword, space, uppercase
 * token, hyphen, digits — so no amount of shape-matching on the reference alone
 * separates them. What separates them is that every real phrase is composed as a
 * standalone line (wave-shared Convention 4, the `wave-start` terminator, the
 * Worker brief) and prose never is. A body that buries its phrase mid-sentence
 * is therefore not protected — which is the safe direction: the guard declines
 * to fire rather than refusing a legitimate rewrite it misread.
 */
const CLOSE_PHRASE_RE = new RegExp(
  String.raw`^[ \t]*(?:[-*+][ \t]+)?(` +
    CLOSE_KEYWORD +
    String.raw`[ \t]*:?[ \t]+` +
    ISSUE_REF +
    String.raw`)[ \t\r]*[.,;:!?)\]}]*[ \t\r]*$`,
  'm',
);

/**
 * The first store-kind close phrase in `body`, verbatim, or `null` when it
 * carries none. Pure — no I/O, safe on any string (including `''`).
 */
export function findClosePhrase(body: string): string | null {
  const m = CLOSE_PHRASE_RE.exec(body ?? '');
  return m === null ? null : m[1].trim();
}

/** Whether `body` carries a store-kind close phrase at all. */
export function hasClosePhrase(body: string): boolean {
  return findClosePhrase(body) !== null;
}

/**
 * Grade a reuse rewrite: `null` = allowed, a string = the REASON to refuse.
 *
 * Refuses on exactly one input — the live body carries a close phrase and the
 * replacement carries none — because that is the only rewrite whose damage is
 * silent. Every other combination passes untouched:
 *
 *   - `existingBody === undefined` (not readable) → allow. Absence of evidence
 *     is never a finding here (the W2-F1c discipline): refusing on a body we
 *     could not read would break reuse on any host/response that omits it.
 *   - the live body carries NO phrase → allow. There is nothing to lose, and
 *     `create` has never required the caller to supply one on this path.
 *   - the replacement carries a phrase → allow. This is the legitimate
 *     re-dispatch: a freshly composed render always carries one, so the guard
 *     costs the behaviour it protects exactly nothing.
 *
 * Presence, not identity: a replacement that carries a DIFFERENT phrase passes.
 * A re-dispatch legitimately recomposes its row's phrase, and refusing a changed
 * one would reject correct work to catch a case that has never occurred — where
 * the loss case has occurred, live, on a real PR.
 */
export function closePhraseLossReason(
  existingBody: string | undefined,
  nextBody: string,
): string | null {
  if (existingBody === undefined) return null;
  const existing = findClosePhrase(existingBody);
  if (existing === null) return null;
  if (hasClosePhrase(nextBody)) return null;
  return (
    `Refused: the open PR's body carries the close phrase "${existing}", and the body passed here carries none. ` +
    `Rewriting it would leave a PR that merges normally while closing nothing — the row silently never reaches ` +
    `\`done\` (wave-shared Convention 4). Pass a body that carries the store-kind close phrase; if you only wanted ` +
    `to know whether this branch already has a PR, use the READ-ONLY \`host-pr status\` verb (\`create\` is a write ` +
    `— its reuse rewrites title and body). To overwrite deliberately anyway, re-run with --allow-close-phrase-loss.`
  );
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
  /**
   * Present (and `true`) ONLY when the close-phrase guard REFUSED the rewrite —
   * the live body carries a close phrase the passed body would have dropped.
   * Distinguishes "the rewrite did not happen because it must not" from the
   * pre-existing `updated:false` cases ("nothing to address" / "the host
   * declined"), which stay exactly what they were. Absent on every other path,
   * so a caller reading only `updated` reads the same truth it always did.
   */
  refused?: boolean;
  /** Why the guard refused. Present iff `refused` is. */
  reason?: string;
}

/** Options for {@link updateOpenPr} — the network seam plus the guard override. */
export interface UpdateOpenPrOptions extends HostOptions {
  /**
   * Permit a rewrite that DROPS the close phrase the live PR body carries — the
   * deliberate-overwrite escape hatch the guard is refused-by-default without.
   * Off by default, and never set by the terminator: a composed render always
   * carries its phrase, so the only caller that needs this is a human who has
   * decided to replace a PR body wholesale.
   */
  allowClosePhraseLoss?: boolean;
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
 *
 * ONE rewrite is refused rather than performed: one that would drop a close
 * phrase the live body carries (see {@link closePhraseLossReason}) — a silent
 * failure the wave cannot detect afterwards. It resolves to
 * `{ url, updated:false, refused:true, reason }` and issues NO request at all;
 * `opts.allowClosePhraseLoss` is the deliberate override. The refusal is graded
 * BEFORE the host/number checks precisely because it is a verdict on the CALL,
 * not on whether this particular ref happened to be addressable.
 */
export async function updateOpenPr(
  host: Host,
  creds: Creds,
  ref: OpenPrRef,
  fields: PrUpdateFields,
  info: Pick<HostInfo, 'workspace' | 'repo'>,
  opts: UpdateOpenPrOptions = {},
): Promise<UpdateOpenPrResult> {
  const loss =
    opts.allowClosePhraseLoss === true ? null : closePhraseLossReason(ref.body, fields.body);
  if (loss !== null) {
    return { url: ref.url, updated: false, refused: true, reason: loss };
  }

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
// `GitHubHttp` seam (RealGitHubApi); Bitbucket Cloud implements the same
// interface on its own `BitbucketHttp` seam (RealBitbucketApi), and gets the
// arm-vs-merge intent below for free (ADR-0023: "new adapter, no new skills" —
// the pilot needed exactly zero changes here beyond this comment). host-pr's
// OWN cross-host Basic-auth `HttpProbe` (verifyAuth/findOpenPr/createPr, above)
// is untouched — the ADR-0019 boundary holds.

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
  /**
   * The PR's head commit SHA, when the host reported one. The commit the
   * check-attach comparison ({@link compareRequiredToReported}) asks about: check
   * reports are attached to a COMMIT, not to a branch, so a SHA is the precise
   * subject. Optional — a host that does not surface it degrades to the branch
   * ref, and a host that surfaces neither contributes no attach evidence at all.
   */
  headSha?: string;
  /**
   * The PR's BASE branch, when the host reported one — the branch whose required
   * status checks are in force for this PR. Optional: absent falls back to the
   * repo's default branch, which is the base for every flotilla wave row.
   */
  baseRef?: string;
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
 * LandingHost`); Bitbucket Cloud's is `RealBitbucketApi`, which implements the
 * same four methods and throws the typed {@link AutoMergeUnavailableError} from
 * `enableAutoMerge` because that host has no arming primitive at all — the
 * refusal this interface already mandates, used for exactly the case it was
 * written for.
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
 * The detected host has no landing adapter. Typed + coded so the caller can
 * distinguish "this host cannot" from "the arm failed" (ADR-0023).
 *
 * Since the Bitbucket adapter landed, the only host the `host-pr` router can
 * still raise this for is `unknown` — the two SHIPPED adapters are `github`
 * (`RealGitHubApi`) and `bitbucket` (`RealBitbucketApi`), both reached by
 * detect-host routing. The class stays parameterised over {@link Host} rather
 * than hard-coding `unknown`, because it is the standing answer for any FUTURE
 * host `detectHost` learns to recognise before an adapter exists for it — and
 * because that message is the one that tells the next pilot what to build.
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
            `(host-pr create|arm|merge|status|preflight supports 'github' and 'bitbucket'; ADR-0023). Check the remote URL, or pass --remote <url> explicitly.`
        : `No landing adapter for host '${host}' — host-pr create|arm|merge|status|preflight is implemented for 'github' and 'bitbucket' (ADR-0023). ` +
            `Implementing the LandingHost interface for ${host} is all that is required; no skill changes are needed.`,
    );
  }
}

// ─── The check-ATTACH comparison: required names vs. reported runs ────────────
//
// The defect this closes: a PR's mergeability alone cannot tell "every required
// check has PASSED" from "no required check has REPORTED YET". GitHub reports
// `mergeable_state: clean` for both — the second is the CHECK-ATTACH LATENCY
// WINDOW, the seconds between a push/PR-create and the first check run being
// attached to the head commit. `decideArmAction('clean')` then picks the direct
// merge, and the PR lands without the required checks ever having run.
//
// LIVE OCCURRENCES (2026-07-30, both on the same day, both on PRs ~90 s old):
//
//   1. The ops-guards wave's landing round: `host-pr arm` on the freshly created
//      row PRs answered `outcome: merged`, `reason: "PR is clean — no pending
//      required checks"` — while the branch ruleset named the TWO required checks
//      ("Engine Tests (vitest)" and "Engine Typecheck (tsc)") that the very same
//      session's `host-pr preflight` had just listed.
//   2. Minutes after the defect was filed, arming the retro docs PR (~90 s old)
//      produced the identical answer. Whether those docs-only checks had really
//      completed or had merely not attached yet is INDISTINGUISHABLE from the arm
//      output — and that indistinguishability is itself the defect: the caller
//      cannot tell all-required-passed from none-reported.
//
// The fix reuses the facts that already exist rather than inventing new ones: the
// required check NAMES come from the effective-rules read the preflight sibling
// already performs ({@link LandingPosture.getRequiredChecks}), and the reports
// come from one new host read ({@link CheckAttachReader.getReportedChecks}). The
// COMPARISON is pure and lives here, host-neutral, exactly like the arm intent.

/**
 * One check the host has REPORTED for a commit — a check run or a commit status,
 * normalised to the two facts the comparison needs.
 *
 * `name` is the identity a required-check context is matched on: GitHub matches a
 * required context against a check run's `name` OR a commit status's `context`,
 * so an adapter folds both sources into this one list.
 *
 * `state` is three-valued on purpose:
 *   - `success` — reported AND settled green. GitHub's `conclusion` values
 *     `success`, `neutral` and `skipped` all land here. `skipped` is
 *     confirmed VERBATIM by GitHub's current "Status checks" reference
 *     (docs.github.com/en/pull-requests/reference/status-checks, read
 *     2026-07-30): "A job that is skipped will report its status as
 *     'Success'. It will not prevent a pull request from merging, even if
 *     it is a required check." `neutral` is CONFORMANCE-CHECKED against the
 *     same page, not merely assumed: its conclusions table describes
 *     `neutral` with wording IDENTICAL to `skipped`'s — "The check run
 *     completed with a neutral result. This is treated as a success for
 *     dependent checks in GitHub Actions." — and the page's own
 *     merge-blocking framing lists only `failure`, `timed_out` and
 *     `action_required` as conclusions where "someone must review the
 *     details before the pull request can merge"; `neutral` is absent from
 *     that list. The vendor page does not spell "required check" out next to
 *     `neutral` the way it does for `skipped`, so the inference rests on
 *     that table-parity plus the blocking-list omission rather than on an
 *     equally explicit standalone sentence — recorded here so the gap in
 *     directness is visible rather than silently rounded up to "confirmed
 *     identically" (issue #263).
 *   - `pending` — reported but not settled (queued / in progress).
 *   - `failure` — reported, settled, and not green.
 *
 * NB the ABSENCE of a name from the reported list is the case this whole section
 * exists for, and it is deliberately NOT a `state`: "not reported" is a fact
 * about the list, not about a check.
 */
export interface ReportedCheck {
  /** The check run's name, or the commit status's context. */
  name: string;
  /** Reported-and-green / reported-but-unsettled / reported-and-not-green. */
  state: 'success' | 'pending' | 'failure';
}

/**
 * The required-vs-reported comparison for one head commit — the evidence the arm
 * decision needs to tell all-required-passed from none-reported.
 *
 * `attached` is the ONE question the decision asks, and it is deliberately
 * conjunctive: every required context must have a report AND that report must be
 * green. Zero reports therefore never satisfies it — which is the whole point.
 * A repo with NO required checks is vacuously `attached` (`required: []`), so it
 * keeps the direct-merge behaviour it has always had.
 */
export interface RequiredCheckAttachment {
  /** The required check contexts in force for the PR's base branch (de-duplicated). */
  required: string[];
  /** Required contexts with NO report at all for the head commit — the latency window. */
  unreported: string[];
  /** Required contexts that ARE reported but not settled green (queued / running / failed). */
  unsettled: string[];
  /** Whether EVERY required context is reported and green. Vacuously true when none are required. */
  attached: boolean;
}

/**
 * Compare the required check contexts against the checks actually reported for a
 * head commit. Pure and total — no I/O, safe on empty inputs.
 *
 * A required context is satisfied only by a report whose state is `success`. It
 * lands in `unreported` when the reported list names it nowhere, and in
 * `unsettled` when it is named but not green. The two are kept apart because they
 * are different facts about the world that happen to imply the same action: the
 * first is the latency window this defect is about, the second is an ordinary
 * pending/failing check.
 *
 * Duplicate names (a re-run) are read tolerantly — ANY green report for a name
 * counts — because the adapter is contracted to return the LATEST report per name
 * (GitHub's check-runs endpoint does exactly that: its `filter` parameter
 * defaults to `latest`), so a duplicate is already an unusual shape rather than a
 * history to re-derive here.
 */
export function compareRequiredToReported(
  required: string[],
  reported: ReportedCheck[],
): RequiredCheckAttachment {
  const green = new Set<string>();
  const seen = new Set<string>();
  for (const r of reported) {
    seen.add(r.name);
    if (r.state === 'success') green.add(r.name);
  }

  const names = [...new Set(required.filter((c) => c.length > 0))];
  const unreported: string[] = [];
  const unsettled: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) unreported.push(name);
    else if (!green.has(name)) unsettled.push(name);
  }
  return {
    required: names,
    unreported,
    unsettled,
    attached: unreported.length === 0 && unsettled.length === 0,
  };
}

/**
 * The OPTIONAL host capability the check-attach comparison consumes. Deliberately
 * not folded into {@link LandingHost}: a host that cannot answer it keeps today's
 * behaviour exactly (and says so in the outcome's `reason`), so the Bitbucket
 * pilot's `LandingHost` implementation stays valid unchanged (ADR-0023: "new
 * adapter, no new skills").
 *
 * `getRequiredChecks` is the preflight's OWN effective-rules read, reused rather
 * than duplicated — `GitHubApi extends LandingPosture` already declares it, so
 * `RealGitHubApi` satisfies this interface structurally the moment it gains
 * `getReportedChecks`.
 */
export interface CheckAttachReader {
  /**
   * Required status-check contexts in force for `branch` (default: the repo's
   * default branch). The preflight's effective-rules read — throw-free, and
   * `state: 'unknown'` when the probe was blind.
   */
  getRequiredChecks(branch?: string): Promise<RequiredChecksInfo>;
  /**
   * The checks the host has REPORTED for `ref` — a commit SHA, or a
   * `heads/<branch>` ref (GitHub's documented `ref` forms for the check-runs and
   * combined-status reads). MUST throw rather than return `[]` when the read
   * itself fails: an empty list is EVIDENCE of the latency window, and a failed
   * read must never be able to counterfeit it.
   *
   * PAGINATION CONTRACT (issue #263): both underlying reads — the check-runs
   * source and the legacy combined-status source — are pageable GitHub REST
   * endpoints (`per_page`/`page`), and a commit can carry more than one page
   * of EITHER. An implementation MUST paginate each to exhaustion, or MUST
   * comment any deliberate cap with its safety rationale at the exact point
   * the cap is applied. A cap on one source paired with exhaustive
   * pagination on its sibling, left uncommented, is an asymmetry that
   * silently under-reports — e.g. a commit carrying more than one page of
   * legacy commit statuses would lose every status past the first page. This
   * paragraph is the CONTRACT; conformance is an implementation property this
   * interface cannot enforce by type. It is stated here, not fixed there,
   * because the concrete violation (`RealGitHubApi.getReportedChecks`,
   * `adapters/github/real-github-api.ts`: an exhaustive check-runs loop
   * immediately above a single-page, uncommented combined-status GET) lives
   * outside this issue's declared Files — flagged for a follow-up rather than
   * silently left unstated.
   */
  getReportedChecks(ref: string): Promise<ReportedCheck[]>;
}

/**
 * Narrow a {@link LandingHost} to a {@link CheckAttachReader} when it happens to
 * implement both reads, else `null` ("this host cannot answer the attach
 * question"). Structural, runtime, and deliberately duck-typed — the alternative,
 * a required method on `LandingHost`, would break every existing implementer for
 * a capability that is legitimately optional.
 */
export function asCheckAttachReader(host: LandingHost): CheckAttachReader | null {
  const h = host as Partial<CheckAttachReader>;
  return typeof h.getRequiredChecks === 'function' && typeof h.getReportedChecks === 'function'
    ? (h as CheckAttachReader)
    : null;
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
 *
 * NB `clean` is the one mergeability this function CANNOT settle on its own: the
 * host reports it both when every required check has passed and when none has
 * reported yet (the check-attach latency window). The `merge` decision it returns
 * for `clean` is therefore PROVISIONAL — {@link refineArmDecisionForCheckAttach}
 * grades it against the required-vs-reported evidence, and `armPullRequest` runs
 * the two in that order. This function stays a pure function of mergeability
 * alone, because that is what makes the ambiguity nameable in the first place.
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

/**
 * Refine a `merge` decision against the check-ATTACH evidence — the second half of
 * the arm intent, and the fix for the two live occurrences documented above.
 *
 * `decideArmAction` decides from the host's mergeability alone, and `clean` is the
 * one value that is AMBIGUOUS: it means "nothing required is reported pending",
 * which is satisfied both by "everything required passed" and by "nothing required
 * has reported yet". This refinement asks the evidence which one it is, and is a
 * strict identity on every other decision (`enable-auto-merge`, `refuse`) — the
 * fix must not turn every landing into an arm.
 *
 * Pure and total, so the whole distinction is spec-drivable without a host:
 *
 *   - `attach === null` — no evidence available (the host cannot answer, or the
 *     read was blind). Decision UNCHANGED, and the reason DISCLOSES that `clean`
 *     is the host's unverified word. Absence of evidence is not a finding
 *     (the W2-F1c discipline) — but it is also not silence.
 *   - `required` empty — the branch requires no checks. Direct merge, reason says
 *     so. This is the "no required checks configured → unchanged" case, and it is
 *     authoritative, not a guess.
 *   - anything required unreported or unsettled → `enable-auto-merge`. The PR is
 *     treated as checks-pending and armed; it lands itself once the checks report.
 *   - everything required reported green → direct merge, reason NAMES the checks
 *     it verified. This is the only path on which a direct merge is now evidenced.
 */
export function refineArmDecisionForCheckAttach(
  decision: ArmDecision,
  attach: RequiredCheckAttachment | null,
): ArmDecision {
  if (decision.action !== 'merge') return decision;

  if (attach === null) {
    return {
      action: 'merge',
      reason:
        `${decision.reason} NOT verified against the required-check names: this host could not report ` +
        `which checks are required, or which have reported for the head commit — so "clean" is the host's ` +
        `word alone, not evidence that the required checks ran.`,
    };
  }

  if (attach.required.length === 0) {
    return {
      action: 'merge',
      reason:
        `${decision.reason} Verified: the base branch's effective rules require NO status checks, so there ` +
        `is genuinely nothing to wait for.`,
    };
  }

  const missing = [...attach.unreported, ...attach.unsettled];
  if (missing.length > 0) {
    return {
      action: 'enable-auto-merge',
      reason:
        `The host reports nothing pending, but ${missing.length} of ${attach.required.length} required ` +
        `check(s) have not reported a passing result for the head commit yet (${missing.join(', ')})` +
        (attach.unreported.length > 0
          ? ` — ${attach.unreported.length} of them have reported NOTHING AT ALL, which is the ` +
            `check-attach latency window, not a passing gate`
          : '') +
        `. "No pending required checks" is not "all required checks passed", so this PR is treated as ` +
        `checks-pending: arm it and let it land itself once the checks report.`,
    };
  }

  return {
    action: 'merge',
    reason:
      `${decision.reason} Verified: all ${attach.required.length} required check(s) have reported success ` +
      `for the head commit (${attach.required.join(', ')}).`,
  };
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
       * landing call — the `merge` verb, OR `arm` when its decision resolved to
       * an immediate merge — was asked to delete the head branch ({@link
       * MergeOptions.deleteBranch} / {@link ArmOptions.deleteBranch}); absent
       * otherwise, so a landing without the flag is byte-identical. A
       * `deleted:false` here is a reported degradation, never a merge failure
       * (this stays `merged`).
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
  /**
   * After the arm decision resolves to an IMMEDIATE merge — the PR was already
   * `clean`, or a refusal degrades to a direct merge (SPIKE 2 / the controlled
   * degrade) — delete the PR's remote head branch through the host API, the
   * same `--delete-branch` hygiene step {@link MergeOptions.deleteBranch} gives
   * the `merge` verb (consumer KW-F6), now threaded onto arm's OWN merge
   * call-sites too.
   *
   * This closes the reproduction of the FOR-66 class on the `arm` route: the
   * original fix was wired ONLY onto {@link mergePullRequestNow} — every merge
   * performed *inside* {@link armPullRequest} (the `clean` decision, the
   * `clean-status` recovery, and the `not-allowed` controlled-degrade) never
   * carried a delete option at all, so those branches survived even with the
   * repo's "Automatically delete head branches" setting ON.
   *
   * When the decision instead resolves to `enable-auto-merge` (outcome
   * `armed`), there is no synchronous merge here to delete after — the host
   * completes that merge later, out of process — so nothing is deleted at
   * this call; the `armed` outcome's `reason` says so explicitly whenever this
   * flag is set, so the close skill's checked step has a concrete place to
   * point at instead of assuming deletion already happened. Off by default: an
   * arm without it is byte-identical to before.
   */
  deleteBranch?: boolean;
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
 * Whether the check-ATTACH evidence FORBIDS an immediate merge: required checks
 * are in force and at least one has not reported a passing result for the head
 * commit. `null` (no evidence available) never forbids — absence of evidence is
 * not a finding, and forbidding on it would break every host that cannot answer.
 *
 * This is the gate on the THREE direct merges reachable from an arm, not just the
 * `clean` decision: the SPIKE-2 `clean-status` recovery and the `not-allowed`
 * controlled degrade both merge immediately too, and both take the host's word
 * that nothing is pending — the exact word this defect proved unreliable inside
 * the latency window. Gating only the first would leave the fix cosmetic: a
 * refined `clean → enable-auto-merge` on a PR the host still considers clean is
 * refused with `clean-status`, and the recovery would have merged it anyway.
 */
function attachForbidsDirectMerge(
  attach: RequiredCheckAttachment | null,
): attach is RequiredCheckAttachment {
  return attach !== null && attach.required.length > 0 && !attach.attached;
}

/** The refusal a direct merge becomes when the attach evidence forbids it. */
function attachRefusalReason(attach: RequiredCheckAttachment, hostSaid: string): string {
  const missing = [...attach.unreported, ...attach.unsettled];
  return (
    `${hostSaid} But ${missing.length} of ${attach.required.length} required check(s) have not reported a ` +
    `passing result for the head commit yet (${missing.join(', ')}) — "no pending required checks" is not ` +
    `"all required checks passed". Refusing rather than merging past a gate that has not run. Re-run ` +
    `\`host-pr arm\` once the checks have attached to the head commit (they normally report within a minute ` +
    `of the push), or land this row via the advisory merge-order.`
  );
}

/**
 * Read the check-ATTACH evidence for an open PR, or `null` when there is none to
 * be had. LAZY + memoised by the caller: an arm that never reaches a direct merge
 * (a `blocked` PR that arms cleanly) issues no extra host read at all, so that
 * path stays byte-identical in call count.
 *
 * Evidence discipline, in the order the reads happen:
 *   - the host does not implement the two reads → `null` (no evidence).
 *   - the required-checks read is blind (`state: 'unknown'`) → `null`. It must NOT
 *     be read as "nothing is required": that is precisely the admin-403 blindness
 *     the effective-rules read exists to route around.
 *   - nothing is required (`contexts: []`, authoritatively) → the vacuous
 *     comparison, WITHOUT asking for reports. There is nothing to compare them to,
 *     and a repo with no CI must not pay a request for the answer.
 *   - the reports read throws → `null`. A failed read contributes no evidence; it
 *     must never be able to counterfeit the empty list that means "nothing has
 *     attached yet", which is the one input that forces an arm.
 */
async function readCheckAttachment(
  host: LandingHost,
  status: PrLandingStatus,
  branch: string,
): Promise<RequiredCheckAttachment | null> {
  const reader = asCheckAttachReader(host);
  if (reader === null) return null;
  try {
    const required = await reader.getRequiredChecks(status.baseRef);
    if (required.state === 'unknown') return null;
    if (required.contexts.length === 0) return compareRequiredToReported([], []);
    // Check reports hang off a COMMIT. Prefer the head SHA; fall back to the
    // branch in GitHub's documented `heads/<branch>` ref form.
    const ref = status.headSha ?? `heads/${branch}`;
    return compareRequiredToReported(required.contexts, await reader.getReportedChecks(ref));
  } catch {
    return null;
  }
}

/** Memoise {@link readCheckAttachment} so the three merge legs share ONE read. */
function checkAttachmentOnce(
  host: LandingHost,
  status: PrLandingStatus,
  branch: string,
): () => Promise<RequiredCheckAttachment | null> {
  let pending: Promise<RequiredCheckAttachment | null> | undefined;
  return () => (pending ??= readCheckAttachment(host, status, branch));
}

/**
 * Append a deferred-deletion note to an `armed` outcome's reason when the
 * caller asked for `--delete-branch` (ADR-0023 amendment / FOR-66-class
 * reproduction fix). `armed` means the merge itself has not happened yet — the
 * host completes it later, out of process — so there is nothing to delete
 * from synchronously here. Recording that in the reason (rather than staying
 * silent) is what lets the close skill's checked step point at WHY the branch
 * is still present instead of assuming the request was honoured.
 */
function armedReason(reason: string, deleteBranchRequested: boolean): string {
  if (!deleteBranchRequested) return reason;
  return (
    `${reason} Branch deletion was requested but is DEFERRED: arm only enables auto-merge here — the ` +
    `PR is not merged yet, so there is no synchronous point to delete the branch from. Once the host ` +
    `completes the merge, deletion depends on the repo's "Automatically delete head branches" setting ` +
    `(Settings → General → Pull Requests) — flotilla cannot delete it from this call.`
  );
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
 *
 * Check-attach gate (the 2026-07-30 live occurrences): every leg that merges
 * IMMEDIATELY — the `clean` decision, the SPIKE-2 `clean-status` recovery, and the
 * `not-allowed` controlled degrade — first consults the required-vs-reported
 * evidence through {@link CheckAttachReader}, because all three rest on the host's
 * "nothing is pending", which is also what the host says when nothing has REPORTED
 * yet. Required checks in force with any of them unreported → the PR is armed
 * (never merged), and a host that then refuses the arm as clean is `refused`, not
 * merged. A host that cannot answer, or a repo with no required checks, behaves
 * exactly as before — and the outcome's `reason` always says which of those it was.
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
  // ONE attach read, shared by every leg that could merge immediately, and taken
  // only when one of them is actually reached (a `blocked` PR that arms cleanly
  // never asks). See `checkAttachmentOnce`.
  const attachOnce = checkAttachmentOnce(host, status, branch);
  // `clean` is the ambiguous mergeability: "nothing reported pending" is satisfied
  // by "all required passed" AND by "nothing has reported yet". Ask the evidence.
  const fromMergeability = decideArmAction(mergeability);
  const decision =
    fromMergeability.action === 'merge'
      ? refineArmDecisionForCheckAttach(fromMergeability, await attachOnce())
      : fromMergeability;
  // Only an IMMEDIATE merge (below) has a synchronous post-merge moment to
  // delete from — thread the same head branch every merge() call site inside
  // this function shares (FOR-66-class fix, now on the arm route too).
  const deleteBranchOf = opts.deleteBranch === true ? branch : undefined;

  if (decision.action === 'refuse') {
    return { outcome: 'refused', prNumber, prUrl: status.url, reason: decision.reason };
  }

  if (decision.action === 'merge') {
    return merge(host, prNumber, status.url, method, decision.reason, deleteBranchOf);
  }

  try {
    await host.enableAutoMerge(prNumber, method);
    // `armed` DEFERS the actual merge to the host — there is no synchronous
    // moment here to delete the branch from, so a requested deletion is
    // recorded as deferred (never silently dropped) rather than attempted.
    return {
      outcome: 'armed',
      prNumber,
      prUrl: status.url,
      reason: armedReason(decision.reason, opts.deleteBranch === true),
    };
  } catch (err) {
    if (err instanceof AutoMergeUnavailableError && err.reason === 'clean-status') {
      // SPIKE 2 (ADR-0023): the host says the PR is already clean — the arm was
      // the safe guess, the merge is the correct action. The host is the authority
      // that nothing is pending — EXCEPT inside the check-attach latency window,
      // where "clean" is exactly the claim this defect proved unreliable. This is
      // also the leg a refined `clean → enable-auto-merge` lands on (the host
      // still considers the PR clean and rejects the arm), so without this gate
      // the refinement above would be undone here and the fix would be cosmetic.
      const attach = await attachOnce();
      if (attachForbidsDirectMerge(attach)) {
        return {
          outcome: 'refused',
          prNumber,
          prUrl: status.url,
          reason: attachRefusalReason(
            attach,
            `The host rejected the arm because it considers this PR already clean (nothing pending) [${err.message}].`,
          ),
        };
      }
      return merge(
        host,
        prNumber,
        status.url,
        method,
        `Host rejected the arm: the PR is already clean (nothing pending) — merged directly instead. [${err.message}]`,
        deleteBranchOf,
      );
    }
    if (err instanceof AutoMergeUnavailableError && err.reason === 'not-allowed') {
      // The controlled degrade merges immediately too, on the strength of the same
      // "nothing required is pending" claim — so it takes the same attach gate.
      const attach = await attachOnce();
      if (attachForbidsDirectMerge(attach)) {
        return {
          outcome: 'refused',
          prNumber,
          prUrl: status.url,
          reason: attachRefusalReason(
            attach,
            `The repository does not permit auto-merge, so this PR cannot be armed [${err.message}]. Enable ` +
              `"Allow auto-merge" (Settings → General → Pull Requests).`,
          ),
        };
      }
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
          deleteBranchOf,
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
   * ({@link BranchDeletionResult}), never a merge failure.
   *
   * `arm` has its OWN, independently-set equivalent — {@link ArmOptions.deleteBranch}
   * — because arm is not always a deferral: when its decision resolves to an
   * immediate merge (a `clean` PR, or a refused-arm controlled degrade), it now
   * takes the exact same delete-after-merge action this verb does. Only when
   * arm truly DEFERS (outcome `armed`, auto-merge enabled and the actual merge
   * happens later, out of process) is there no synchronous post-merge moment
   * here to delete in — that leg still relies on the repo-level "Automatically
   * delete head branches" setting to finish the job once the host's own merge
   * lands.
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
 * merge (`host-pr merge --delete-branch`, consumer KW-F6). Every caller that can
 * reach an IMMEDIATE merge threads it: {@link mergePullRequestNow} (the `merge`
 * verb) and all three of {@link armPullRequest}'s own merge call-sites (the
 * `clean` decision, the `clean-status` recovery, and the `not-allowed`
 * controlled-degrade) — this is the fix for the FOR-66-class reproduction on
 * the `arm` route, where those three call-sites previously omitted it
 * unconditionally, so a landing through `arm` never deleted the branch even
 * when the caller asked. The deletion is best-effort: a failure is captured on
 * `branchDeletion` (a reported degradation), never propagated, so the merge
 * result never flips to a failure.
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
 * The repo's "Allow auto-merge" setting, as the resolved token can OBSERVE it.
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
 * needs admin the resolved token may lack. Host-neutral: GitHub and the Bitbucket
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
 * The required status checks a branch's ACTIVE RULESETS put in force, read from
 * GitHub's effective-rules endpoint (`GET /repos/{o}/{r}/rules/branches/{branch}`).
 *
 * That endpoint is the fix for two defects of the legacy branch-protection read
 * that the 2026-07-23 gate-arming row hit (doc slug 2026-07-23-ci-gate-arm): the
 * legacy `.../protection/required_status_checks` read is admin-gated (it degraded
 * to `unknown` on an HTTP 403 for months) AND ruleset-blind (it reported "no
 * required status checks" the instant required checks landed in the repo's active
 * ruleset). The effective-rules endpoint aggregates classic branch protection AND
 * every active ruleset into the rules actually in force, and needs only READ
 * access — so it SEES ruleset-carried checks and never 403s for a non-admin
 * token, fixing both defects at once.
 *
 * `readable` is the evidence-vs-absence distinction the closing-probe uses
 * (W2-F1c) applied here: `true` = the endpoint answered, so an empty `contexts`
 * is an AUTHORITATIVE "no rule requires checks"; `false` = the read itself failed
 * (a non-200 / transport error), so it contributes no evidence either way and the
 * merge falls back to the legacy read. Host-neutral in SHAPE (a Bitbucket adapter
 * with no rulesets endpoint returns `readable:false`), GitHub-specific in SOURCE.
 */
export interface RulesetChecksInfo {
  /** Whether the effective-rules endpoint answered at all. */
  readable: boolean;
  /** The required-status-check contexts the active rulesets put in force. */
  contexts: string[];
  /** Human-readable account of what was probed and what came back. */
  detail: string;
}

/**
 * Reconcile the two required-status-check reads — the effective-rules read
 * ({@link RulesetChecksInfo}) and the legacy branch-protection read
 * ({@link RequiredChecksInfo}) — into the single canonical answer the preflight
 * grades. The one owner of the ruleset-vs-legacy merge (single-owner discipline
 * for the landing-posture facts; 2026-07-23 gate-arm gap).
 *
 * "Either source finding checks means checks are present": the reported contexts
 * are the de-duplicated union of both reads (rulesets first), and ANY context →
 * `present`. With no context from either read, the state is `absent` when at
 * LEAST one read was authoritative that nothing is required — the effective-rules
 * endpoint answered (`ruleset.readable`), or legacy branch protection reported
 * `absent`. That read-only effective-rules answer is exactly what lets a
 * non-admin token reach `absent` instead of the legacy admin-403 `unknown`. Only
 * when BOTH reads were blind (the rules read failed AND legacy was `unknown`)
 * does the merge stay `unknown`. The three posture MEANINGS are unchanged from
 * the legacy-only probe (present/absent/unknown mean exactly what they did).
 */
export function mergeRequiredChecks(
  branch: string,
  legacy: RequiredChecksInfo,
  ruleset: RulesetChecksInfo,
): RequiredChecksInfo {
  const contexts = [...new Set([...ruleset.contexts, ...legacy.contexts].filter((c) => c.length > 0))];
  if (contexts.length > 0) {
    return {
      state: 'present',
      contexts,
      detail:
        `Branch '${branch}' requires ${contexts.length} status check(s): ${contexts.join(', ')} ` +
        `(read from the effective rules — active rulesets and legacy branch protection combined).`,
    };
  }
  if (ruleset.readable || legacy.state === 'absent') {
    return {
      state: 'absent',
      contexts: [],
      detail:
        `Branch '${branch}' has no required status checks in force — neither an active ruleset nor legacy ` +
        `branch protection requires any (read from the effective-rules endpoint, which needs no admin rights).`,
    };
  }
  return {
    state: 'unknown',
    contexts: [],
    detail:
      `Could not determine required checks for '${branch}' from either the effective-rules endpoint or legacy ` +
      `branch protection (both reads were unavailable). Advisory only — the wave is not blocked.`,
  };
}

/**
 * The code-host POSTURE seam (ADR-0023 amendment). The three reads `host-pr
 * preflight` grades. `GitHubApi extends` this (RealGitHubApi implements it on the
 * `GitHubHttp` seam); `RealBitbucketApi` implements the same three and inherits
 * the probe. Distinct from {@link LandingHost} (per-PR arm/merge/status): this is
 * the repo-level "can we `--auto` here?" question, not a single PR's landing.
 *
 * The three reads are host-NEUTRAL in shape but not in MEANING, so
 * {@link preflightHost} grades them per host: a Bitbucket `getAutoMergeSetting`
 * of `off` is a platform property (advisory), where a GitHub `off` is a fixable
 * setting (a `fail` when there are checks to wait for).
 */
export interface LandingPosture {
  /**
   * Whether the resolved token can MERGE pull requests on the bound repo — write
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
    prMergeTokenCheck(canMerge, host),
    allowAutoMergeCheck(autoMerge, required.state, host),
    requiredChecksCheck(required, host),
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), host, checks };
}

/**
 * The Bitbucket posture wording (measured 2026-08-10, recorded in ADR-0023).
 * Kept in ONE place so the three checks below tell the same story, and so the
 * GitHub texts stay byte-identical to what they always were — the host-aware
 * branches are additive, never a rewrite of the shipped GitHub report.
 */
const BITBUCKET_NO_ARM =
  'Bitbucket Cloud exposes NO auto-merge arming primitive in its REST API (measured 2026-08-10; ADR-0023 records ' +
  'the finding). Its nearest equivalent — the "Allow automatic merge when builds pass" merge check — is triggered ' +
  'by a human clicking Merge in the pull-request UI, not by an API call.';

function prMergeTokenCheck(canMerge: boolean, host: Host): HostPreflightCheck {
  if (host === 'bitbucket') {
    // Bitbucket's merge-capability read is USER-scoped
    // (`GET /2.0/user/permissions/repositories`), and a repository/project/
    // workspace access token has no user context to grade — so a `pass` here
    // means "no evidence of a read-only credential", not "write access proven".
    // Saying that plainly is the ADR-0023-amendment discipline (absence of
    // evidence is never a finding) applied to a probe whose seam types the
    // answer as a plain boolean.
    return {
      name: 'pr-merge-token',
      status: canMerge ? 'pass' : 'fail',
      detail: canMerge
        ? 'The resolved BITBUCKET_TOKEN can merge PRs on the bound repo — or the user-scoped repository-permission read could not grade it (a repository/workspace access token has no user context), which is absence of evidence and never a finding. The merge write remains the ground truth.'
        : 'The resolved BITBUCKET_TOKEN has only READ permission on the bound repo — it CANNOT merge PRs. Grant it write access (an Atlassian API token needs the `write:repository:bitbucket` scope) before landing a wave.',
    };
  }
  return {
    name: 'pr-merge-token',
    status: canMerge ? 'pass' : 'fail',
    // NB "the resolved GITHUB_TOKEN", never "the ambient" one (ADR-0029): after
    // the lookup-command indirection the credential usually is NOT an ambient
    // variable, and a posture text that said so would be simply false.
    detail: canMerge
      ? 'The resolved GITHUB_TOKEN has write access — it can merge PRs on the bound repo.'
      : 'The resolved GITHUB_TOKEN lacks write (push) access — it CANNOT merge PRs on the bound repo. Grant it write (push) access before landing a wave.',
  };
}

/**
 * Grade the "Allow auto-merge" setting. A visible OFF grades by CONTEXT
 * (ADR-0023 amendment): required checks present → `fail` (arming is structurally
 * impossible, and there IS something to arm for); none → `advisory` (a clean PR
 * direct-merges today, so it only matters once CI arrives). `unknown` (the token
 * cannot see the setting) never blocks and never demands admin.
 */
function allowAutoMergeCheck(
  setting: AutoMergeSetting,
  requiredState: RequiredChecksInfo['state'],
  host: Host,
): HostPreflightCheck {
  if (host === 'bitbucket') {
    // A Bitbucket `off` is a PLATFORM PROPERTY, not a fixable misconfiguration:
    // there is no setting to tick, so grading it `fail` (as a visible GitHub
    // `off` with required checks is graded) would make `host-pr preflight`
    // permanently red on every correctly-configured Bitbucket consumer. A
    // permanently-red gate is noise, not a signal — so this is `advisory`, and
    // the detail states the measurement plus what `--auto` actually does here.
    return {
      name: 'allow-auto-merge',
      status: 'advisory',
      detail:
        `${BITBUCKET_NO_ARM} \`wave-close --auto\` therefore lands a Bitbucket row by DIRECT MERGE when nothing ` +
        `required is pending, and REFUSES a row whose required builds have not all reported success — land that ` +
        `tail via the advisory merge-order (ADR-0023).`,
    };
  }
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
function requiredChecksCheck(required: RequiredChecksInfo, host: Host): HostPreflightCheck {
  if (required.state === 'present') {
    const named = required.contexts.length > 0 ? ` Required: ${required.contexts.join(', ')}.` : '';
    if (host === 'bitbucket') {
      // The GitHub sentence ("`--auto` will ARM these PRs") is simply false on
      // this host, so it is replaced rather than reused — a posture report that
      // promises an arm nothing can perform is worse than no report.
      return {
        name: 'required-checks',
        status: 'advisory',
        detail:
          `${required.detail}${named} \`--auto\` will NOT arm these PRs — ${BITBUCKET_NO_ARM} A row whose ` +
          `required builds have all reported success is merged directly; any other row is REFUSED and lands via ` +
          `the advisory merge-order (ADR-0023).`,
      };
    }
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
    // The open-PR query is TWO separate query parameters, and that is the fix
    // for a malformed URL this line used to build (issue: the Bitbucket landing
    // adapter): it previously URL-encoded `source.branch.name="b"&state=OPEN`
    // as ONE `q` value. `q` is BBQL, whose boolean operator is `and`, never an
    // `&` — Atlassian's own example is `?q=size>1024+and+attributes="binary"`
    // (developer.atlassian.com, filter-and-sort, read 2026-08-10) — so the
    // encoded `&state=OPEN` was junk inside the expression, and a rejected
    // query reads as "no open PR", which turns find-before-create into
    // create-a-duplicate. `state` is a first-class parameter of this endpoint
    // ("By default only open pull requests are returned"), so asking for OPEN
    // through it needs no BBQL boolean at all.
    openPrUrl: (info, branch) =>
      `${base}/repositories/${info.workspace}/${info.repo}/pullrequests?q=${encodeURIComponent(
        `source.branch.name="${branch}"`,
      )}&state=OPEN`,
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

/**
 * Pull `{ url, number?, body? }` from a Bitbucket PR object (`links.html.href` +
 * `id` + `description`). A non-string `description` (absent, or `null`) leaves
 * `body` ABSENT — "not readable", never a known-empty body.
 */
function bbRef(json: unknown): OpenPrRef | null {
  const url = bbHref(json);
  if (url === null) return null;
  const obj = json as Record<string, unknown>;
  const id = obj.id;
  const base: OpenPrRef = typeof id === 'number' ? { url, number: id } : { url };
  return typeof obj.description === 'string' ? { ...base, body: obj.description } : base;
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

/**
 * Pull `{ url, number?, body? }` from a GitHub PR object (`html_url` + `number` +
 * `body`). GitHub sends `body: null` for an empty description — a non-string
 * leaves `body` ABSENT ("not readable"), which the guard treats as no evidence.
 * That is the safe direction: an empty live body carries no close phrase to
 * lose either way, so both readings allow the rewrite.
 */
function ghRef(json: unknown): OpenPrRef | null {
  const url = ghHtmlUrl(json);
  if (url === null) return null;
  const obj = json as Record<string, unknown>;
  const number = obj.number;
  const base: OpenPrRef = typeof number === 'number' ? { url, number } : { url };
  return typeof obj.body === 'string' ? { ...base, body: obj.body } : base;
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
