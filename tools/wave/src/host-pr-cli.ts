/**
 * host-pr-cli.ts — the `host-pr create | arm | merge | status | preflight` verb
 * group (ADR-0019 PR-open + ADR-0023 landing + amendment).
 *
 * The whole host boundary, exposed as ONE narrow CLI surface. Why a CLI verb at
 * all: a Workflow driver cannot import the engine, and `gh` left the host path
 * entirely (sandbox-denied creds + keychain/proxy TLS failures, live-proven in
 * runs 1 and 3) — so the permission classifier gets one auditable verb instead
 * of a broad `gh pr create` / `gh pr merge` bash rule. `create` is the staged
 * second half of ADR-0023 ("every host write goes through the engine host
 * seam"): it retires the Worker terminator's last `gh pr create`.
 *
 * This runner is a THIN router, in the house style — it holds no host logic:
 *
 *   detect-host  → routes by host. `github` is the one shipped implementation;
 *                  `bitbucket` / `unknown` fail LOUD and typed for EVERY verb
 *                  (the Bitbucket pilot implements the seam and inherits them).
 *   create       → `findOpenPrRef` then `createPr` (host-pr.ts owns the
 *                  find-before-create idempotency): an existing open PR for the
 *                  branch is REUSED — and its title/body are RE-WRITTEN to the
 *                  passed values via `updateOpenPr` (PATCH), so the terminator's
 *                  composed render lands on a Worker-opened PR (`updated:true`
 *                  discloses it) — a missing one is created. Idempotent about
 *                  CREATION only — a cap=1 re-dispatch onto the same branch never
 *                  opens a second PR — and emphatically NOT read-only about
 *                  CONTENT: running it twice with different arguments changes the
 *                  live PR twice. Callers who only want to know whether a branch
 *                  has a PR belong on the read-only `status` verb. The one rewrite
 *                  `create` refuses (exit 1, `outcome: "reuse-refused"`) is one
 *                  that would drop the close phrase the live body carries;
 *                  `--allow-close-phrase-loss` is the deliberate override. This
 *                  is the ADR-0019 cross-host Basic-auth seam (`HttpProbe` +
 *                  `Creds`), NOT the ADR-0023 `LandingHost` seam.
 *   arm          → `armPullRequest` (host-pr.ts owns the arm intent). `--delete-branch`
 *                  (consumer KW-F6, threaded onto arm's own merge call-sites, #140)
 *                  deletes the head branch when the arm decision resolves to an
 *                  IMMEDIATE merge (a `clean` PR, or a refused-arm controlled
 *                  degrade) — best-effort, reported on `branchDeletion`, never an
 *                  arm failure. When the decision instead ARMS (auto-merge
 *                  enabled, the host completes the merge later, out of process)
 *                  there is no synchronous merge to delete after — nothing is
 *                  deleted at this call, and the `armed` outcome's `reason` says
 *                  so explicitly rather than staying silent about it.
 *   merge        → `mergePullRequestNow`. `--delete-branch` (consumer KW-F6)
 *                  deletes the PR's remote head branch after a successful merge
 *                  through `LandingHost.deleteBranch`; a failed delete is a
 *                  structural `branchDeletion` degradation, never a merge
 *                  failure. `arm` accepts the same flag independently — see above.
 *   status       → `LandingHost.getPrStatus`
 *   preflight    → `preflightHost` (host-pr.ts owns the posture grading): reports
 *                  the three code-host checks (pr-merge-token, allow-auto-merge,
 *                  required-checks). Store-BLIND (no `--config`, no `--branch`) —
 *                  identical on every store kind, because landing is always on the
 *                  code host (ADR-0023 amendment / W10-F1). Builds the posture
 *                  reader from the resolved GitHub credential, like arm/merge/status.
 *
 * Exit codes:
 *   0 — the op succeeded (`create`: the PR was created or an open one reused;
 *       `arm`/`merge`: merged, armed, or already-merged; `status`: the probe
 *       answered — read `state` for the answer, which may legitimately be `none`;
 *       `preflight`: every check passed / advisory / unknown — read `checks`).
 *   1 — the op did not land the row (`create`: the PR-create failed —
 *       `outcome: "create-failed"` with a `fallbackPrefillUrl` — or the reuse was
 *       refused by the close-phrase guard — `outcome: "reuse-refused"` with a
 *       `reason`; `arm`/`merge`: `no-pr`, `refused`; `preflight`: a check `fail`ed
 *       — read `checks`), the host has no adapter
 *       (`code: "adapter-not-implemented"`), or the host errored.
 *   2 — usage error.
 *
 * stdout is ALWAYS a single JSON object carrying `ok` + the outcome, so the
 * caller can branch on either the exit code or the payload.
 *
 * PR url/number field names are ALIGNED across every verb (FOR-54): a PR URL is
 * carried under BOTH `url` and `prUrl`, and a PR number under BOTH `number` and
 * `prNumber`, so a single field name resolves on `create | status | arm | merge`
 * alike. The alignment is additive — no historical name was renamed — so the
 * live consumers keep reading what they always did (the Worker terminator reads
 * `create.url`; wave-close reads `status`/`arm` url+number). `create` still
 * carries no PR number (a deliberate omission: find-before-create only
 * round-trips the URL). See {@link alignedPrRef}, the single owner of the shape.
 */

import { execFileSync } from 'node:child_process';
import {
  detectHost,
  armPullRequest,
  mergePullRequestNow,
  findOpenPrRef,
  updateOpenPr,
  createPr,
  preflightHost,
  alignedPrRef,
  LandingNotImplementedError,
  DEFAULT_MERGE_METHOD,
  type Host,
  type HostInfo,
  type LandingHost,
  type LandingPosture,
  type MergeMethod,
  type Creds,
  type HttpProbe,
} from './host-pr';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import { resolveCredential } from './credential-resolver';
import { flag, printJson } from './cli-utils';

const VERBS = ['create', 'arm', 'merge', 'status', 'preflight'] as const;
type Verb = (typeof VERBS)[number];

/**
 * Impure inputs for the `create` and `preflight` verbs, injectable for tests. In
 * production all default: the network seam is host-pr's `defaultHttpProbe`
 * (global `fetch`, the same path arm/merge/status use), the token is read from
 * `process.env`, and the posture reader is a `GitHubApi` built from the env.
 */
export interface HostPrDeps {
  /** `create`: injectable network seam (tests). Defaults inside `findOpenPr`/`createPr`. */
  http?: HttpProbe;
  /**
   * `create` + `preflight`: the environment the GitHub credential is RESOLVED
   * from (ADR-0029) — `GITHUB_TOKEN_CMD` (a lookup command) or `GITHUB_TOKEN`
   * (ambient). Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** `preflight`: a posture reader to probe (tests). Production builds a `GitHubApi` from the env. */
  posture?: LandingPosture;
}

const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];

function usage(message: string): number {
  process.stderr.write(
    [
      `error: ${message}`,
      // NB: deliberately NO --config. host-pr talks to the code HOST, not the
      // tracker, so there is no store to build and no wave.config.json to read.
      `usage: host-pr <${VERBS.join('|')}> [--branch <branch>] [--remote <url>]`,
      `         create: --branch <branch> --title <title> --body <body> [--base <branch>] [--allow-close-phrase-loss]`,
      `                 (a WRITE: the PR body carries the store-kind close phrase, and a reuse rewrites both fields)`,
      `         arm: --branch <branch> [--method <${MERGE_METHODS.join('|')}>] [--delete-branch]`,
      `         merge: --branch <branch> [--method <${MERGE_METHODS.join('|')}>] [--delete-branch]`,
      `         status: --branch <branch> [--method <${MERGE_METHODS.join('|')}>]`,
      `         preflight: (no --branch — a repo-level probe)`,
      '',
      '  create    Open the PR for --branch (find-before-create): an existing OPEN PR on the branch is reused',
      '            (never duplicated) and a missing one is created. Requires --title and --body.',
      '            NOT a read-only probe. "Idempotent" describes CREATION only: reuse RE-WRITES the live PR\'s',
      '            title AND body to the --title/--body you pass (last-writer-wins), so running this twice with',
      '            different arguments changes the PR twice. To ask whether a branch already has a PR without',
      '            touching it, use the read-only `status` verb instead.',
      '            A reuse that would drop the close phrase the live body carries — replacing it with a body',
      '            that has none — is REFUSED (exit 1, outcome reuse-refused, with a reason) rather than',
      '            silently merging a PR that closes nothing; --allow-close-phrase-loss overrides it.',
      '  arm       Land the PR by the ADR-0023 arm intent: pending checks → enable auto-merge;',
      '            already clean → direct merge. Idempotent. With --delete-branch, deletes the head branch',
      '            on the decision paths that merge IMMEDIATELY (clean, or a refused-arm controlled degrade)',
      '            — best-effort, reported in `branchDeletion`, never an arm failure. When the decision instead',
      '            ARMS (auto-merge enabled, the host merges later out of process), nothing is deleted at this',
      '            call — the deferral is recorded explicitly in the armed outcome\'s `reason`.',
      '  merge     Merge the PR now, no arm intent (the caller has already decided). Idempotent.',
      '            With --delete-branch, deletes the PR head branch after a successful merge (branch hygiene,',
      '            consumer KW-F6) — best-effort: a failed delete is reported in `branchDeletion`, never a merge',
      '            failure. `arm` accepts the same flag with its own (partially deferred) semantics — see above.',
      '  status    Report the PR for a branch: open | merged | closed-unmerged | none (+ url).',
      '  preflight Report the code-host landing posture: pr-merge-token, allow-auto-merge, required-checks.',
      '            Store-blind (no --config, no --branch) — identical on every store kind (ADR-0023 amendment).',
      '',
      '  --remote defaults to `git remote get-url origin`.',
      `  --method defaults to '${DEFAULT_MERGE_METHOD}' (arm | merge only).`,
      '  --allow-close-phrase-loss (create only) permits a reuse rewrite that drops the live PR body\'s close',
      '    phrase. Deliberate overwrites only — the terminator never needs it (a composed render carries one).',
      '  create + preflight resolve the GitHub credential through the engine credential seam (ADR-0029):',
      '    GITHUB_TOKEN_CMD (a lookup command, run via the shell, 60s budget) wins over GITHUB_TOKEN.',
      '    A configured command that fails is a loud typed error naming the command — never its output,',
      '    never a fallback to GITHUB_TOKEN. The secret itself is never printed.',
      '',
    ].join('\n'),
  );
  return 2;
}

/**
 * Run the `host-pr` CLI (FOR-26 / FOR-28 / ADR-0019 + ADR-0023).
 *
 * @param args - CLI args; `args[0]` is the verb.
 * @param injected - a {@link LandingHost} to drive the landing verbs
 *   (`arm`/`merge`/`status`) in tests. It is used ONLY when the detected host is
 *   `github`: routing is the ROUTER's decision, never the caller's, so an
 *   injected adapter can never smuggle a non-GitHub wave onto the GitHub path.
 *   When absent, the GitHub adapter is built from the env (impure — the
 *   credential resolver + a construction-time preflight). The `create` and `preflight`
 *   verbs do not use this seam (`create` is on the ADR-0019 `HttpProbe`/`Creds`
 *   boundary; `preflight` reads the posture via `deps.posture`).
 * @param deps - impure inputs for `create` (network seam + env) and `preflight`
 *   (posture reader + env); tests inject them, production defaults to real
 *   `fetch`, `process.env`, and a `GitHubApi` built from the env.
 * @returns the process exit code (see the module docblock).
 */
export async function runHostPr(
  args: string[],
  injected?: LandingHost,
  deps: HostPrDeps = {},
): Promise<number> {
  // ── Usage is decided FIRST — before any routing, host build, or network. ──
  const verb = args[0] as Verb | undefined;
  if (verb === undefined) return usage('a verb is required');
  if (!VERBS.includes(verb)) {
    return usage(`unknown verb "${verb}" — expected one of: ${VERBS.join(', ')}`);
  }

  // `preflight` is a REPO-level probe — it takes no --branch (it reads required
  // checks against the DEFAULT branch). Every other verb needs one.
  const branch = flag(args, '--branch');
  if (verb !== 'preflight' && (branch === undefined || branch.length === 0)) {
    return usage('--branch <branch> is required');
  }

  // `--allow-close-phrase-loss` is create's deliberate-overwrite override: it
  // permits the ONE reuse rewrite the guard refuses (dropping the close phrase
  // the live PR body carries). Rejected on every other verb rather than silently
  // ignored — the same discipline `--delete-branch` gets below, and for the same
  // reason: a flag that looks accepted but does nothing is a footgun.
  const allowClosePhraseLoss = args.includes('--allow-close-phrase-loss');
  if (allowClosePhraseLoss && verb !== 'create') {
    return usage(
      `--allow-close-phrase-loss is only supported by 'create' (it governs the reuse rewrite); '${verb}' never rewrites a PR body`,
    );
  }

  // `create`'s own required flags are decided here, before any host build or
  // network — same "usage first" discipline. `--method` is landing-only and is
  // neither read nor validated for `create` or `preflight`.
  let title: string | undefined;
  let body: string | undefined;
  let base = 'main';
  if (verb === 'create') {
    title = flag(args, '--title');
    if (title === undefined || title.length === 0) {
      return usage('--title <title> is required for create');
    }
    body = flag(args, '--body');
    if (body === undefined || body.length === 0) {
      // The body carries the store-kind close phrase (Convention 4); an empty
      // one would open a PR that closes nothing. Refuse, do not default.
      return usage('--body <body> is required for create (it carries the store-kind close phrase)');
    }
    base = flag(args, '--base') ?? 'main';
  }

  let method: MergeMethod = DEFAULT_MERGE_METHOD;
  if (verb === 'arm' || verb === 'merge' || verb === 'status') {
    const rawMethod = flag(args, '--method');
    if (rawMethod !== undefined && !MERGE_METHODS.includes(rawMethod as MergeMethod)) {
      // Never silently downgrade to the default: a caller who asked for a merge
      // method flotilla does not know must be told, not quietly squash-merged.
      return usage(`invalid --method "${rawMethod}" — expected one of: ${MERGE_METHODS.join(', ')}`);
    }
    method = (rawMethod as MergeMethod) ?? DEFAULT_MERGE_METHOD;
  }

  // `--delete-branch` is a branch-hygiene flag (consumer KW-F6): on a
  // successful `merge` it deletes the PR's remote head branch through the host
  // API. `arm` accepts it too (issue #140, wiring the engine's own
  // `ArmOptions.deleteBranch`, landed in #132): threaded through only on the
  // decision paths that resolve to an IMMEDIATE merge (a `clean` PR, or a
  // refused-arm controlled degrade) — `armPullRequest` itself defers the
  // deletion (and says so in `reason`) when the decision instead ARMS and
  // hands the merge to the host. Reject it on any other verb rather than
  // silently ignore it (the arm-delete footgun).
  const deleteBranch = args.includes('--delete-branch');
  if (deleteBranch && verb !== 'merge' && verb !== 'arm') {
    return usage(
      `--delete-branch is only supported by 'arm' and 'merge' (branch-hygiene steps); '${verb}' does not delete branches`,
    );
  }

  let remoteUrl: string;
  try {
    remoteUrl = flag(args, '--remote') ?? gitRemoteUrl();
  } catch (err) {
    return usage(`could not read the git remote (pass --remote <url>): ${(err as Error).message}`);
  }

  // ── Route by host. Every verb is github-only in M1; others fail loud+typed. ──
  const info = detectHost(remoteUrl);
  if (info.host !== 'github') {
    return notImplemented(verb, info.host, branch);
  }

  // ── preflight: the ADR-0023-amendment posture probe (LandingPosture seam). ──
  // NB: the `injected` LandingHost is the LANDING seam (arm/merge/status); the
  // posture reader is a different capability set, injected via `deps.posture`.
  if (verb === 'preflight') {
    return runPreflight(info, remoteUrl, deps);
  }

  // ── create: the ADR-0019 find-before-create seam (HttpProbe/Creds). ──
  if (verb === 'create') {
    return runCreate(
      info,
      branch as string,
      title as string,
      body as string,
      base,
      allowClosePhraseLoss,
      deps,
    );
  }

  // ── arm | merge | status: build the LandingHost adapter + run the verb. ──
  try {
    const host: LandingHost = injected ?? (await createGitHubApiFromEnv({ remoteUrl }));
    return await dispatch(verb, host, branch as string, method, info.host, deleteBranch);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb,
      host: info.host,
      branch,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

/**
 * The `create` verb — find-before-create, idempotently, over host-pr's
 * cross-host Basic-auth seam. An OPEN PR already on the branch is reused (exit 0,
 * `outcome: "reused"`) AND its title/body are re-written to the passed values
 * (`updated:true` when the PATCH landed) — the reuse re-pins the same PR and now
 * also carries the terminator's composed render onto it; a missing one is
 * created (exit 0, `outcome: "created"`); a create failure returns the pre-fill
 * fallback signal (exit 1, `outcome: "create-failed"` with `fallbackPrefillUrl`).
 *
 * The one reuse that does NOT proceed is the one whose damage would be silent: a
 * rewrite that drops the close phrase the live PR body carries (exit 1,
 * `outcome: "reuse-refused"` with a `reason`, and no write at all). It is a
 * refusal precisely because the alternative — a PR that merges normally while
 * closing nothing — leaves the wave looking finished with one row quietly open.
 * `allowClosePhraseLoss` is the deliberate override.
 *
 * The GitHub token is RESOLVED through the engine credential seam (ADR-0029) and
 * never printed; every way that can fail — nothing configured, a lookup command
 * that exits non-zero, times out, or prints nothing — fails loud (exit 1) with
 * an error naming the command, mirroring `createGitHubApiFromEnv`. The Basic-auth
 * credential is `x-access-token:<token>` — the GitHub form host-pr.ts's
 * `HttpProbe` documents.
 */
async function runCreate(
  info: HostInfo,
  branch: string,
  title: string,
  body: string,
  base: string,
  allowClosePhraseLoss: boolean,
  deps: HostPrDeps,
): Promise<number> {
  // One resolver seam (ADR-0029): `GITHUB_TOKEN_CMD` (a lookup command) wins
  // over an ambient `GITHUB_TOKEN`, and a configured command that fails is a
  // typed LOUD error here — never a silent fallback to the ambient variable.
  // Only `.message` is ever printed: it names the command, never its output.
  let token: string;
  try {
    token = resolveCredential('GITHUB_TOKEN', {
      env: deps.env,
      purpose: 'open a PR through `host-pr create` (ADR-0019)',
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    process.stderr.write(`error: ${message}\n`);
    printJson({ ok: false, verb: 'create', host: info.host, branch, error: message });
    return 1;
  }

  const creds: Creds = { auth: `x-access-token:${token}` };
  const opts = deps.http ? { http: deps.http } : {};
  // Only the reuse-time update reads the guard override; find/create ignore it.
  const updateOpts = { ...opts, allowClosePhraseLoss };

  try {
    // find-before-create: a re-run (or a cap=1 re-dispatch onto the same branch)
    // re-pins the already-open PR instead of opening a duplicate.
    const existing = await findOpenPrRef(info.host, creds, branch, info, opts);
    if (existing !== null) {
      // Update-on-reuse: re-write the open PR's title/body to the passed values
      // through the same seam (PATCH), so the terminator's composed render (the
      // authoritative final body) lands on a Worker-opened PR instead of being
      // silently discarded. Best-effort — a declined update still re-pins the
      // URL (`updated:false`), never a duplicate, never a wave-abort.
      const update = await updateOpenPr(
        info.host,
        creds,
        existing,
        { title, body },
        info,
        updateOpts,
      );
      if (update.refused === true) {
        // The close-phrase guard stopped the rewrite BEFORE any write: the live
        // body carries a phrase this body would have dropped. Loud + typed, not
        // a silent success — the whole point is that the damage is undetectable
        // afterwards. The PR's URL is still reported (it genuinely is this
        // branch's PR), but `ok:false` + exit 1 keep it out of a success path.
        process.stderr.write(`error: ${update.reason}\n`);
        printJson({
          ok: false,
          verb: 'create',
          host: info.host,
          branch,
          outcome: 'reuse-refused',
          // Unchanged meaning: the live PR body/title were NOT re-written.
          updated: false,
          error: update.reason,
          reason: update.reason,
          ...alignedPrRef({ url: update.url }),
        });
        return 1;
      }
      printJson({
        ok: true,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'reused',
        // Disclose whether the reuse re-wrote the live PR body/title (FOR-58).
        updated: update.updated,
        // Aligned url/number field names across every verb (FOR-54): `url` +
        // `prUrl`. `create` carries no PR number (documented omission) — even on
        // reuse, where the number is known internally but deliberately not emitted.
        ...alignedPrRef({ url: update.url }),
      });
      return 0;
    }

    const result = await createPr(
      info.host,
      creds,
      { branch, title, body, destination: base, info },
      opts,
    );
    if ('url' in result) {
      printJson({
        ok: true,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'created',
        // Aligned url/number field names across every verb (FOR-54): `url` +
        // `prUrl`. `create` carries no PR number (documented omission).
        ...alignedPrRef({ url: result.url }),
      });
      return 0;
    }

    // A create failure is a returned signal, not a throw (ADR-0019): surface the
    // pre-fill fallback so the caller can open the PR by hand and continue.
    process.stderr.write(`error: ${result.error}\n`);
    printJson({
      ok: false,
      verb: 'create',
      host: info.host,
      branch,
      outcome: 'create-failed',
      error: result.error,
      fallbackPrefillUrl: result.fallbackPrefillUrl,
    });
    return 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb: 'create',
      host: info.host,
      branch,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

/**
 * The `preflight` verb — the code-host posture probe (ADR-0023 amendment). It is
 * store-BLIND: no `--config`, no store, no `--branch`. It builds a posture reader
 * from the RESOLVED GitHub credential (ADR-0029 — the same construction-time
 * token preflight as arm/merge/status), then grades the three code-host checks
 * via `preflightHost`.
 * Reports on every store kind identically — landing is always on the code host.
 *
 * Exit 0 = every check passed / advisory / unknown (a probe answer, not a block);
 * exit 1 = a check `fail`ed (allow-auto-merge OFF with required checks present, or
 * the token cannot merge PRs), or the host build/probe threw.
 */
async function runPreflight(info: HostInfo, remoteUrl: string, deps: HostPrDeps): Promise<number> {
  try {
    const posture: LandingPosture = deps.posture ?? (await createGitHubApiFromEnv({ remoteUrl, env: deps.env }));
    const report = await preflightHost(info.host, posture);
    printJson({ ok: report.ok, verb: 'preflight', host: report.host, checks: report.checks });
    return report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    printJson({
      ok: false,
      verb: 'preflight',
      host: info.host,
      error: (err as Error).message ?? String(err),
    });
    return 1;
  }
}

async function dispatch(
  verb: Verb,
  host: LandingHost,
  branch: string,
  method: MergeMethod,
  hostName: Host,
  deleteBranch: boolean,
): Promise<number> {
  if (verb === 'status') {
    const status = await host.getPrStatus(branch);
    // A successful probe is exit 0 even when the answer is `none`: "there is no
    // PR" is an ANSWER (the done-reconcile evidence hierarchy consumes it), not
    // a failure. The caller reads `state`.
    printJson({
      ok: true,
      verb,
      host: hostName,
      branch,
      ...status,
      // Aligned url/number field names across every verb (FOR-54): `status`
      // natively carries `url`/`number`; add the `prUrl`/`prNumber` aliases so
      // the shape matches arm/merge/create.
      ...alignedPrRef({ url: status.url, number: status.number }),
    });
    return 0;
  }

  const outcome =
    verb === 'arm'
      ? await armPullRequest(host, branch, method, { deleteBranch })
      : await mergePullRequestNow(host, branch, method, { deleteBranch });

  const ok = outcome.outcome === 'merged' || outcome.outcome === 'armed' || outcome.outcome === 'already-merged';
  // Aligned url/number field names across every verb (FOR-54): the landing
  // outcomes natively carry `prUrl`/`prNumber`; add the `url`/`number` aliases so
  // the shape matches status/create. A `no-pr` outcome carries neither → `{}`.
  const prRef = outcome.outcome === 'no-pr' ? {} : { url: outcome.prUrl, number: outcome.prNumber };
  printJson({ ok, verb, host: hostName, branch, method, ...outcome, ...alignedPrRef(prRef) });
  return ok ? 0 : 1;
}

/** The typed adapter-not-implemented exit — a distinct, machine-readable answer. */
function notImplemented(verb: Verb, host: Host, branch: string | undefined): number {
  const err = new LandingNotImplementedError(host);
  process.stderr.write(`error: ${err.message}\n`);
  // `preflight` carries no branch — omit the key rather than emit `branch: null`.
  printJson({ ok: false, code: err.code, verb, host, ...(branch !== undefined ? { branch } : {}), error: err.message });
  return 1;
}

/** Read the origin remote URL (a local git read — not a gh-creds call, sandbox-OK). */
function gitRemoteUrl(): string {
  return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf-8' }).trim();
}

// Only execute when this file is run directly (not when imported by cli.ts/tests).
if (require.main === module) {
  runHostPr(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
