/**
 * cli-store.ts — the CLI-edge store resolver + the store-preflight probe.
 *
 * The store-consuming CLIs (issue-store-cli, cli `dor`) share `resolveStore` so
 * the real-impl wiring for each tracker lives in ONE place: build the
 * in-memory/markdown store directly, but inject a RealGitHubApi (via
 * createGitHubApiFromEnv) for a `github` config, or a RealLinearApi (via
 * createLinearApiFromEnv) for a `linear` config. buildStore stays pure; this is
 * the impure edge. KEY DIFFERENCE between the two: github's owner/repo derive
 * from the git remote; linear's team/project are passed through from the
 * consumer's own config (ADR-0020) — Linear is the issue tracker, not the code
 * host.
 *
 * This module is ALSO a runnable CLI (the `preflight` verb, FOR-12): invoked as
 * `tsx cli-store.ts preflight [--config <path>]`, it probes the store's live
 * preconditions THROUGH the existing API seams (tracker↔GitHub integration,
 * the workflow-state catalog, the ambient token's PR-merge ability) so
 * `wave-setup` RUNS the checks instead of merely asserting they hold. The probe
 * is pure over the seam — testable against the in-memory fakes with no network.
 */

import type { IssueStore } from './adapters/issue-store';
import { buildStore } from './store-factory';
import { loadWaveConfig, type WaveConfig, type StoreConfig, type LinearStoreConfig } from './wave-config';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import { createLinearApiFromEnv } from './adapters/linear/linear-api-factory';
import type { GitHubApi, RequiredChecksInfo } from './adapters/github/github-api';
import type { LinearApi } from './adapters/linear/linear-api';
import type { GitHubIssuesStore } from './adapters/github/github-issues-store';
import type { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { DEFAULT_LINEAR_STATES, type LinearStateMap } from './adapters/linear/linear-issues-store';
import { flag, printJson } from './cli-utils';

export async function resolveStore(args: string[], injected?: IssueStore): Promise<IssueStore> {
  if (injected) return injected;
  const config = loadWaveConfig(flag(args, '--config') ?? 'wave.config.json');
  if (config.store.kind === 'github') {
    const githubApi = await createGitHubApiFromEnv();
    return buildStore(config, { githubApi });
  }
  if (config.store.kind === 'linear') {
    const linearApi = await createLinearApiFromEnv({ team: config.store.team, project: config.store.project });
    return buildStore(config, { linearApi });
  }
  return buildStore(config);
}

// ── store-preflight (FOR-12) ──────────────────────────────────────────────

/**
 * One probed precondition. Only `fail` blocks — `not-applicable` and `advisory`
 * are both ignored by `ok`.
 *
 * `advisory` (ADR-0023) is the third rung and is deliberately distinct from
 * `pass`: the probe RAN and has something the human should read, but the answer
 * is not a verdict — there is no "correct" value. `required-checks` is the case
 * that needed it: a repo with no CI is a perfectly valid `--auto` consumer (the
 * confirm just states that confirming means an immediate merge), so reporting
 * `pass`/`fail` would have to invent a policy flotilla explicitly declines to
 * have ("visibility over gatekeeping" — hard gates only where failure would be
 * silent, and this one is loud).
 */
export interface PreflightCheck {
  /** Stable machine key for the precondition. */
  name:
    | 'tracker-host-integration'
    | 'state-catalog'
    | 'pr-merge-token'
    | 'allow-auto-merge'
    | 'required-checks';
  status: 'pass' | 'fail' | 'not-applicable' | 'advisory';
  detail: string;
}

export interface StorePreflightReport {
  /** true iff no check is `fail` — `not-applicable` / `advisory` never block. */
  ok: boolean;
  storeKind: StoreConfig['kind'];
  checks: PreflightCheck[];
}

/**
 * Probe the store's live preconditions THROUGH its API seam. Each store kind
 * reports the checks that are meaningful for it and marks the rest
 * `not-applicable` — the union covers all three "for real" in exactly the store
 * where each is enforceable:
 *   - github → the ambient token's PR-merge ability (integration + catalog n/a:
 *     GitHub is its own host, claims are labels);
 *   - linear → the GitHub integration + the workflow-state catalog (PR-merge
 *     n/a: PRs land on GitHub with the consumer's own credentials, ADR-0020);
 *   - markdown → all n/a (a local dev/dogfood store).
 * Pure over the seam — `store` may wrap an in-memory fake (test) or a real impl.
 */
export async function preflightStore(config: WaveConfig, store: IssueStore): Promise<StorePreflightReport> {
  const s = config.store;
  const checks =
    s.kind === 'github'
      ? await githubChecks((store as GitHubIssuesStore).api)
      : s.kind === 'linear'
        ? await linearChecks((store as LinearIssuesStore).api, s)
        : markdownChecks();
  return { ok: checks.every((c) => c.status !== 'fail'), storeKind: s.kind, checks };
}

async function githubChecks(api: GitHubApi): Promise<PreflightCheck[]> {
  const canMerge = await api.canMergePullRequests();
  // ADR-0023 landing preconditions. `getRequiredChecks` is contractually
  // throw-free (an advisory probe may never block), so it needs no guard here.
  const allowsAuto = await api.allowsAutoMerge();
  const required = await api.getRequiredChecks();
  return [
    {
      name: 'tracker-host-integration',
      status: 'not-applicable',
      detail: 'GitHub is its own code host — there is no external tracker↔host integration to install.',
    },
    {
      name: 'state-catalog',
      status: 'not-applicable',
      detail: 'GitHub claims are labels (wave/<rung>) — there is no workflow-state catalog to verify.',
    },
    {
      name: 'pr-merge-token',
      status: canMerge ? 'pass' : 'fail',
      detail: canMerge
        ? 'The ambient GITHUB_TOKEN has write access — it can merge PRs on the bound repo.'
        : 'The ambient GITHUB_TOKEN lacks write (push) access — it CANNOT merge PRs on the bound repo. Grant the token write access before running a wave.',
    },
    {
      name: 'allow-auto-merge',
      status: allowsAuto ? 'pass' : 'fail',
      detail: allowsAuto
        ? 'The repo setting "Allow auto-merge" is ON — PRs with pending checks can be armed to land themselves.'
        : 'The repo setting "Allow auto-merge" is OFF (the GitHub default) — arming a PR will FAIL, so `wave-close --auto` cannot land rows whose checks are still pending. ' +
          'Fix: Settings → General → Pull Requests → tick "Allow auto-merge" (API: PATCH /repos/{owner}/{repo} with allow_auto_merge=true). ' +
          'Without it, land this wave via the advisory merge-order instead (ADR-0023).',
    },
    {
      // REPORT-ONLY (ADR-0023): never a FAIL. A repo with no required checks is
      // a valid --auto consumer — the confirm just has to say so out loud.
      name: 'required-checks',
      status: 'advisory',
      detail: requiredChecksDetail(required),
    },
  ];
}

/**
 * Turn the required-checks probe into the sentence the wave-close confirm needs.
 *
 * The check CONTEXTS are read from the structured `contexts[]` — the contract —
 * not from the probe's `detail` prose, so the confirm names the real gates even
 * if an adapter words its detail differently.
 */
function requiredChecksDetail(required: RequiredChecksInfo): string {
  if (required.state === 'present') {
    const named = required.contexts.length > 0 ? ` Required: ${required.contexts.join(', ')}.` : '';
    return `${required.detail}${named} \`--auto\` will ARM these PRs: they land themselves once the checks pass.`;
  }
  if (required.state === 'absent') {
    return `${required.detail} There is nothing to wait for, so confirming \`--auto\` means these PRs merge IMMEDIATELY — backed by the Worker's verify run and the Reviewer's independent one, not by CI. This is expected, not a fault (ADR-0023).`;
  }
  return `${required.detail} \`--auto\` still works: the arm intent is decided per-PR from its live merge-state, not from this probe.`;
}

async function linearChecks(api: LinearApi, storeConfig: LinearStoreConfig): Promise<PreflightCheck[]> {
  const hasIntegration = await api.hasGitHubIntegration();
  const catalog = await api.listStates();
  const catalogNames = new Set(catalog.map((c) => c.name));

  // Every claim-ledger state name the wave will `setState` to must exist in the
  // team catalog. The store merges config over defaults the SAME way (see
  // LinearIssuesStore), so unclaimTarget/unplanned stay at Backlog/Canceled
  // unless a future config exposes them; doneState is checked only when set.
  const effective: LinearStateMap = { ...DEFAULT_LINEAR_STATES, ...storeConfig.states };
  const required = [
    effective.queued,
    effective.inFlight,
    effective.inReview,
    effective.unclaimTarget,
    effective.unplanned,
  ];
  if (effective.doneState !== undefined) required.push(effective.doneState);
  const missing = [...new Set(required)].filter((n) => !catalogNames.has(n));
  const catalogOk = missing.length === 0;

  // A missing integration is a hard FAIL — UNLESS the consumer opted into the
  // FOR-13 no-integration `doneState` fallback, in which case its absence is
  // expected (done resolves via the forced flip, not the attachment probe).
  let integration: PreflightCheck;
  if (hasIntegration) {
    integration = {
      name: 'tracker-host-integration',
      status: 'pass',
      detail: 'Linear↔GitHub integration is installed — a merged PR creates the closing attachment the done-derivation reads.',
    };
  } else if (effective.doneState !== undefined) {
    integration = {
      name: 'tracker-host-integration',
      status: 'not-applicable',
      detail: `Linear↔GitHub integration is NOT installed, but states.doneState ("${effective.doneState}") is configured — rows resolve to done via the FOR-13 fallback once the wave confirms the merge.`,
    };
  } else {
    integration = {
      name: 'tracker-host-integration',
      status: 'fail',
      detail: 'Linear↔GitHub integration is NOT installed and no states.doneState fallback is configured — merged PRs will never resolve rows to done (ADR-0020). Install the integration or set states.doneState.',
    };
  }

  return [
    integration,
    {
      name: 'state-catalog',
      status: catalogOk ? 'pass' : 'fail',
      detail: catalogOk
        ? 'Every configured workflow-state name resolves to a state in the team catalog.'
        : `Configured workflow states missing from the team catalog: ${missing.map((m) => `"${m}"`).join(', ')}. Create them in Linear (or fix the states map) before running a wave.`,
    },
    {
      name: 'pr-merge-token',
      status: 'not-applicable',
      detail: "PRs merge on the GitHub code host with the consumer's own GitHub credentials — not checkable from the Linear tracker (ADR-0020).",
    },
    {
      // Same boundary as pr-merge-token: these are CODE-HOST facts, and the
      // LinearApi seam reaches the tracker only. `host-pr` probes the host
      // directly at landing time, where the repo credentials actually live.
      name: 'allow-auto-merge',
      status: 'not-applicable',
      detail: 'Landing happens on the GitHub code host, not in Linear — the repo\'s "Allow auto-merge" setting is not reachable through the Linear seam (ADR-0020/0023).',
    },
    {
      name: 'required-checks',
      status: 'not-applicable',
      detail: 'Required status checks live on the GitHub code host, not in Linear — not reachable through the Linear seam (ADR-0020/0023).',
    },
  ];
}

function markdownChecks(): PreflightCheck[] {
  return [
    {
      name: 'tracker-host-integration',
      status: 'not-applicable',
      detail: 'The markdown store is a local dev/dogfood store — there is no tracker↔host integration.',
    },
    {
      name: 'state-catalog',
      status: 'not-applicable',
      detail: 'The markdown store has no workflow-state catalog (claims live in the Status line).',
    },
    {
      name: 'pr-merge-token',
      status: 'not-applicable',
      detail: 'The markdown store lands no PRs — there is nothing to merge.',
    },
    {
      name: 'allow-auto-merge',
      status: 'not-applicable',
      detail: 'The markdown store lands no PRs — there is nothing to arm.',
    },
    {
      name: 'required-checks',
      status: 'not-applicable',
      detail: 'The markdown store lands no PRs — there are no required checks to report.',
    },
  ];
}

function preflightUsage(message: string): number {
  process.stderr.write(
    [`error: ${message}`, 'usage: cli-store preflight [--config <path>]', ''].join('\n'),
  );
  return 2;
}

/**
 * Run the store-preflight CLI (FOR-12).
 *
 * @param args - CLI args (typically `process.argv.slice(2)`); `args[0]` must be
 *   `preflight`. `--config <path>` selects the store config (default
 *   `wave.config.json`).
 * @param injected - a store to probe directly (tests); when absent the store is
 *   built from the config via resolveStore (impure — hits the real factory).
 * @returns exit code: 0 all preconditions pass (or n/a); 1 a precondition FAILED
 *   loudly, or the probe/host threw; 2 usage error or unreadable/invalid config.
 */
export async function runStorePreflight(args: string[], injected?: IssueStore): Promise<number> {
  const op = args[0];
  if (op !== 'preflight') {
    return preflightUsage(`unknown op "${op ?? ''}" — only "preflight" is supported`);
  }
  let config: WaveConfig;
  try {
    config = loadWaveConfig(flag(args, '--config') ?? 'wave.config.json');
  } catch (err) {
    // config unreadable/invalid → a usage-class problem (couldn't even run the probe).
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    const store = await resolveStore(args, injected);
    const report = await preflightStore(config, store);
    printJson(report);
    return report.ok ? 0 : 1; // 1 = a precondition failed LOUDLY (the FOR-12 signal)
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when this file is run directly (not when imported for resolveStore).
if (require.main === module) {
  runStorePreflight(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
