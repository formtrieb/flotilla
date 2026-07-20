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
 * TRACKER preconditions THROUGH the existing API seams (tracker↔GitHub
 * integration, the workflow-state catalog) so `wave-setup` RUNS the checks
 * instead of merely asserting they hold. The probe is pure over the seam —
 * testable against the in-memory fakes with no network.
 *
 * Store-preflight is TRACKER FACTS ONLY. The three code-host posture checks it
 * used to carry (`pr-merge-token`, `allow-auto-merge`, `required-checks`) moved
 * to `host-pr preflight` under the ADR-0023 amendment's single-owner discipline:
 * a code-host fact has ONE owner, the host seam, and `host-pr preflight` reports
 * it store-blind on every store kind. See {@link preflightHost} in host-pr.ts.
 */

import type { IssueStore } from './adapters/issue-store';
import { buildStore } from './store-factory';
import { loadWaveConfig, type WaveConfig, type StoreConfig, type LinearStoreConfig } from './wave-config';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import { createLinearApiFromEnv } from './adapters/linear/linear-api-factory';
import type { CheckStatus } from './host-pr';
import type { LinearApi } from './adapters/linear/linear-api';
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
 * One probed TRACKER precondition. Only `fail` blocks — `not-applicable` never
 * does. The `status` union is {@link CheckStatus}, SHARED with the host-preflight
 * (host-pr.ts) so the two probes speak one status vocabulary; the store-preflight
 * itself only ever emits `pass` / `fail` / `not-applicable` for its two checks.
 *
 * The `name` union is TRACKER FACTS ONLY. The three code-host checks it used to
 * carry (`pr-merge-token`, `allow-auto-merge`, `required-checks`) moved to
 * `host-pr preflight` (ADR-0023 amendment, single-owner) — a code-host fact has
 * one owner, the host seam.
 */
export interface PreflightCheck {
  /** Stable machine key for the precondition. */
  name: 'tracker-host-integration' | 'state-catalog';
  status: CheckStatus;
  detail: string;
}

export interface StorePreflightReport {
  /** true iff no check is `fail` — `not-applicable` never blocks. */
  ok: boolean;
  storeKind: StoreConfig['kind'];
  checks: PreflightCheck[];
}

/**
 * Probe the store's live TRACKER preconditions THROUGH its API seam. Each store
 * kind reports the tracker checks meaningful for it and marks the rest
 * `not-applicable`:
 *   - github → both n/a (GitHub is its own host, claims are labels — code-host
 *     posture is `host-pr preflight`'s concern now, ADR-0023 amendment);
 *   - linear → the GitHub integration + the workflow-state catalog (ADR-0020);
 *   - markdown → all n/a (a local dev/dogfood store).
 * Pure over the seam — `store` may wrap an in-memory fake (test) or a real impl.
 */
export async function preflightStore(config: WaveConfig, store: IssueStore): Promise<StorePreflightReport> {
  const s = config.store;
  const checks =
    s.kind === 'github'
      ? githubChecks()
      : s.kind === 'linear'
        ? await linearChecks((store as LinearIssuesStore).api, s)
        : markdownChecks();
  return { ok: checks.every((c) => c.status !== 'fail'), storeKind: s.kind, checks };
}

function githubChecks(): PreflightCheck[] {
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
  ];
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

  // Code-host facts (pr-merge-token / allow-auto-merge / required-checks) are NOT
  // reported here — the LinearApi seam reaches the tracker only, and those facts
  // now have one owner, `host-pr preflight`, which probes the code host directly
  // on every store kind (ADR-0020/0023 amendment).
  return [
    integration,
    {
      name: 'state-catalog',
      status: catalogOk ? 'pass' : 'fail',
      detail: catalogOk
        ? 'Every configured workflow-state name resolves to a state in the team catalog.'
        : `Configured workflow states missing from the team catalog: ${missing.map((m) => `"${m}"`).join(', ')}. Create them in Linear (or fix the states map) before running a wave.`,
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
  ];
}

function preflightUsage(message: string): number {
  process.stderr.write(
    [
      `error: ${message}`,
      'usage: cli-store preflight [--config <path>]',
      '  Probes TRACKER preconditions only (tracker↔host integration, workflow-state catalog).',
      '  For code-host posture (pr-merge-token, allow-auto-merge, required-checks) run',
      '  `host-pr preflight` — it is store-blind and reports on every store kind (ADR-0023).',
      '',
    ].join('\n'),
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
