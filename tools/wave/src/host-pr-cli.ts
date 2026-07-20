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
 *   create       → `findOpenPr` then `createPr` (host-pr.ts owns the
 *                  find-before-create idempotency): an existing open PR for the
 *                  branch is REUSED, a missing one is created. Idempotent — a
 *                  cap=1 re-dispatch onto the same branch never opens a second
 *                  PR. This is the ADR-0019 cross-host Basic-auth seam
 *                  (`HttpProbe` + `Creds`), NOT the ADR-0023 `LandingHost` seam.
 *   arm          → `armPullRequest`  (host-pr.ts owns the arm intent)
 *   merge        → `mergePullRequestNow`
 *   status       → `LandingHost.getPrStatus`
 *   preflight    → `preflightHost` (host-pr.ts owns the posture grading): reports
 *                  the three code-host checks (pr-merge-token, allow-auto-merge,
 *                  required-checks). Store-BLIND (no `--config`, no `--branch`) —
 *                  identical on every store kind, because landing is always on the
 *                  code host (ADR-0023 amendment / W10-F1). Builds the posture
 *                  reader from `$GITHUB_TOKEN`, like arm/merge/status.
 *
 * Exit codes:
 *   0 — the op succeeded (`create`: the PR was created or an open one reused;
 *       `arm`/`merge`: merged, armed, or already-merged; `status`: the probe
 *       answered — read `state` for the answer, which may legitimately be `none`;
 *       `preflight`: every check passed / advisory / unknown — read `checks`).
 *   1 — the op did not land the row (`create`: the PR-create failed —
 *       `outcome: "create-failed"` with a `fallbackPrefillUrl`; `arm`/`merge`:
 *       `no-pr`, `refused`; `preflight`: a check `fail`ed — read `checks`), the
 *       host has no adapter (`code: "adapter-not-implemented"`), or the host errored.
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
  findOpenPr,
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
  /** `create` + `preflight`: environment to read GITHUB_TOKEN from. Defaults to `process.env`. */
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
      `         create: --branch <branch> --title <title> --body <body>   (the PR body carries the store-kind close phrase)`,
      `         arm | merge | status: --branch <branch> [--method <${MERGE_METHODS.join('|')}>]`,
      `         preflight: (no --branch — a repo-level probe)`,
      '',
      '  create    Open the PR for --branch idempotently (find-before-create): an existing OPEN PR on the',
      '            branch is reused (no duplicate), a missing one is created. Requires --title and --body.',
      '  arm       Land the PR by the ADR-0023 arm intent: pending checks → enable auto-merge;',
      '            already clean → direct merge. Idempotent.',
      '  merge     Merge the PR now, no arm intent (the caller has already decided). Idempotent.',
      '  status    Report the PR for a branch: open | merged | closed-unmerged | none (+ url).',
      '  preflight Report the code-host landing posture: pr-merge-token, allow-auto-merge, required-checks.',
      '            Store-blind (no --config, no --branch) — identical on every store kind (ADR-0023 amendment).',
      '',
      '  --remote defaults to `git remote get-url origin`.',
      `  --method defaults to '${DEFAULT_MERGE_METHOD}' (arm | merge only).`,
      '  create + preflight read GITHUB_TOKEN from the environment (never printed).',
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
 *   When absent, the GitHub adapter is built from the env (impure —
 *   `GITHUB_TOKEN` + a construction-time preflight). The `create` and `preflight`
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
    return runCreate(info, branch as string, title as string, body as string, base, deps);
  }

  // ── arm | merge | status: build the LandingHost adapter + run the verb. ──
  try {
    const host: LandingHost = injected ?? (await createGitHubApiFromEnv({ remoteUrl }));
    return await dispatch(verb, host, branch as string, method, info.host);
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
 * `outcome: "reused"`); a missing one is created (exit 0, `outcome: "created"`);
 * a create failure returns the pre-fill fallback signal (exit 1,
 * `outcome: "create-failed"` with `fallbackPrefillUrl`).
 *
 * The GitHub token comes from the env (never printed); its absence fails loud
 * (exit 1), mirroring `createGitHubApiFromEnv`. The Basic-auth credential is
 * `x-access-token:<token>` — the GitHub form host-pr.ts's `HttpProbe` documents.
 */
async function runCreate(
  info: HostInfo,
  branch: string,
  title: string,
  body: string,
  base: string,
  deps: HostPrDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  const token = env.GITHUB_TOKEN;
  if (token === undefined || token.length === 0) {
    const message =
      'GITHUB_TOKEN is required to open a PR through `host-pr create` (ADR-0019). Export it before running.';
    process.stderr.write(`error: ${message}\n`);
    printJson({ ok: false, verb: 'create', host: info.host, branch, error: message });
    return 1;
  }

  const creds: Creds = { auth: `x-access-token:${token}` };
  const opts = deps.http ? { http: deps.http } : {};

  try {
    // find-before-create: a re-run (or a cap=1 re-dispatch onto the same branch)
    // re-pins the already-open PR instead of opening a duplicate.
    const existing = await findOpenPr(info.host, creds, branch, info, opts);
    if (existing !== null) {
      printJson({
        ok: true,
        verb: 'create',
        host: info.host,
        branch,
        outcome: 'reused',
        // Aligned url/number field names across every verb (FOR-54): `url` +
        // `prUrl`. `create` carries no PR number (documented omission).
        ...alignedPrRef({ url: existing }),
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
 * from `$GITHUB_TOKEN` (the same construction-time token preflight as
 * arm/merge/status), then grades the three code-host checks via `preflightHost`.
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
      ? await armPullRequest(host, branch, method)
      : await mergePullRequestNow(host, branch, method);

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
