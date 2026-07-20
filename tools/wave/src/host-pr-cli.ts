/**
 * host-pr-cli.ts — the `host-pr arm | merge | status` verb group (ADR-0023).
 *
 * The landing half of the host boundary, exposed as ONE narrow CLI surface.
 * Why a CLI verb at all: a Workflow driver cannot import the engine, and
 * `gh` left the landing path entirely (sandbox-denied creds + keychain/proxy TLS
 * failures, live-proven in runs 1 and 3) — so the permission classifier gets one
 * auditable verb instead of a broad `gh pr merge` bash rule.
 *
 * This runner is a THIN router, in the house style — it holds no landing logic:
 *
 *   detect-host  → picks the host-local {@link LandingHost}. `github` is the one
 *                  shipped implementation (`RealGitHubApi`, which satisfies the
 *                  interface directly); `bitbucket` / `unknown` fail LOUD and
 *                  typed. The Bitbucket pilot implements `LandingHost` and
 *                  inherits every verb below — new adapter, no new skills.
 *   arm          → `armPullRequest`  (host-pr.ts owns the arm intent)
 *   merge        → `mergePullRequestNow`
 *   status       → `LandingHost.getPrStatus`
 *
 * Exit codes:
 *   0 — the op succeeded (`arm`/`merge`: merged, armed, or already-merged;
 *       `status`: the probe answered — read `state` for the answer, which may
 *       legitimately be `none`).
 *   1 — the op did not land the row (`no-pr`, `refused`), the host has no
 *       landing adapter (`code: "adapter-not-implemented"`), or the host errored.
 *   2 — usage error.
 *
 * stdout is ALWAYS a single JSON object carrying `ok` + the outcome, so the
 * caller can branch on either the exit code or the payload.
 */

import { execFileSync } from 'node:child_process';
import {
  detectHost,
  armPullRequest,
  mergePullRequestNow,
  LandingNotImplementedError,
  DEFAULT_MERGE_METHOD,
  type Host,
  type LandingHost,
  type MergeMethod,
} from './host-pr';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import { flag, printJson } from './cli-utils';

const VERBS = ['arm', 'merge', 'status'] as const;
type Verb = (typeof VERBS)[number];

const MERGE_METHODS: MergeMethod[] = ['squash', 'merge', 'rebase'];

function usage(message: string): number {
  process.stderr.write(
    [
      `error: ${message}`,
      // NB: deliberately NO --config. Landing talks to the code HOST, not the
      // tracker, so there is no store to build and no wave.config.json to read.
      `usage: host-pr <${VERBS.join('|')}> --branch <branch> [--remote <url>] [--method <${MERGE_METHODS.join('|')}>]`,
      '',
      '  arm     Land the PR by the ADR-0023 arm intent: pending checks → enable auto-merge;',
      '          already clean → direct merge. Idempotent.',
      '  merge   Merge the PR now, no arm intent (the caller has already decided). Idempotent.',
      '  status  Report the PR for a branch: open | merged | closed-unmerged | none (+ url).',
      '',
      '  --remote defaults to `git remote get-url origin`.',
      `  --method defaults to '${DEFAULT_MERGE_METHOD}'.`,
      '',
    ].join('\n'),
  );
  return 2;
}

/**
 * Run the `host-pr` CLI (FOR-26 / ADR-0023).
 *
 * @param args - CLI args; `args[0]` is the verb.
 * @param injected - a {@link LandingHost} to drive (tests). It is used ONLY when
 *   the detected host is `github`: routing is the ROUTER's decision, never the
 *   caller's, so an injected adapter can never smuggle a non-GitHub wave onto
 *   the GitHub path. When absent, the GitHub adapter is built from the env
 *   (impure — `GITHUB_TOKEN` + a construction-time preflight).
 * @returns the process exit code (see the module docblock).
 */
export async function runHostPr(args: string[], injected?: LandingHost): Promise<number> {
  // ── Usage is decided FIRST — before any routing, host build, or network. ──
  const verb = args[0] as Verb | undefined;
  if (verb === undefined) return usage('a verb is required');
  if (!VERBS.includes(verb)) {
    return usage(`unknown verb "${verb}" — expected one of: ${VERBS.join(', ')}`);
  }

  const branch = flag(args, '--branch');
  if (branch === undefined || branch.length === 0) {
    return usage('--branch <branch> is required');
  }

  const rawMethod = flag(args, '--method');
  if (rawMethod !== undefined && !MERGE_METHODS.includes(rawMethod as MergeMethod)) {
    // Never silently downgrade to the default: a caller who asked for a merge
    // method flotilla does not know must be told, not quietly squash-merged.
    return usage(`invalid --method "${rawMethod}" — expected one of: ${MERGE_METHODS.join(', ')}`);
  }
  const method: MergeMethod = (rawMethod as MergeMethod) ?? DEFAULT_MERGE_METHOD;

  let remoteUrl: string;
  try {
    remoteUrl = flag(args, '--remote') ?? gitRemoteUrl();
  } catch (err) {
    return usage(`could not read the git remote (pass --remote <url>): ${(err as Error).message}`);
  }

  // ── Route by host. ──
  const info = detectHost(remoteUrl);
  if (info.host !== 'github') {
    return notImplemented(verb, info.host, branch);
  }

  // ── Build the host adapter + run the verb. ──
  try {
    const host: LandingHost = injected ?? (await createGitHubApiFromEnv({ remoteUrl }));
    return await dispatch(verb, host, branch, method, info.host);
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
    printJson({ ok: true, verb, host: hostName, branch, ...status });
    return 0;
  }

  const outcome =
    verb === 'arm'
      ? await armPullRequest(host, branch, method)
      : await mergePullRequestNow(host, branch, method);

  const ok = outcome.outcome === 'merged' || outcome.outcome === 'armed' || outcome.outcome === 'already-merged';
  printJson({ ok, verb, host: hostName, branch, method, ...outcome });
  return ok ? 0 : 1;
}

/** The typed adapter-not-implemented exit — a distinct, machine-readable answer. */
function notImplemented(verb: Verb, host: Host, branch: string): number {
  const err = new LandingNotImplementedError(host);
  process.stderr.write(`error: ${err.message}\n`);
  printJson({ ok: false, code: err.code, verb, host, branch, error: err.message });
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
