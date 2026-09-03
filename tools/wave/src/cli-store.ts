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
 * ── Router unification (issue #77) ────────────────────────────────────────────
 * The probe is now ALSO reachable as a `cli.ts` router subcommand,
 * `{{wave-cli}} store-preflight [--config <path>]`, so the whole engine surface
 * speaks one `{{wave-cli}} <sub>` idiom (the precondition for a single npm
 * `bin`). That route is NOT a second implementation: it goes through
 * {@link runStorePreflightSubcommand}, a one-line shim that prepends the
 * `preflight` op token and delegates to {@link runStorePreflight} — one runner,
 * two spellings, identical output and exit codes.
 *
 * The direct-module entrypoint below is deliberately KEPT as an alias rather
 * than deleted: existing `wave-setup` call-sites still spell it
 * `npx tsx tools/wave/src/cli-store.ts preflight …`, and rewriting those skill
 * docs is a separate, out-of-scope slice (see
 * docs/plans/2026-07-26-plugin-beta-ship-plan.md, Workstream 2).
 *
 * Store-preflight is TRACKER FACTS ONLY. The three code-host posture checks it
 * used to carry (`pr-merge-token`, `allow-auto-merge`, `required-checks`) moved
 * to `host-pr preflight` under the ADR-0023 amendment's single-owner discipline:
 * a code-host fact has ONE owner, the host seam, and `host-pr preflight` reports
 * it store-blind on every store kind. See {@link preflightHost} in host-pr.ts.
 *
 * ── The plugin/engine lockstep version check (ADR-0032) ──────────────────────
 * This module also owns the engine-version reading + comparison the `version`
 * verb and the store-preflight advisory both report. It lives HERE, beside
 * `preflightStore`, because it is a precondition fact of exactly that kind —
 * "does this installation satisfy what the wave is about to assume?" — and
 * because the alternative placements are worse: `cli.ts` already imports this
 * module (so a definition there would need a circular import back), and a new
 * module would put a second owner between the verb and the preflight, which is
 * the drift ADR-0032 exists to end. The router verb is the usual thin case
 * router; the logic is here. See {@link compareEngineVersion}.
 * Cycle-avoidance stays the default here; ADR-0037 is only a narrow engine-adapter exception, which this edge is not.
 *
 * ── The ROOT SURFACE of this module (issue #325) ─────────────────────────────
 * RECORDED DECISION, so the next reader does not have to re-derive it from the
 * absence of an export line: the store-preflight family — {@link resolveStore},
 * {@link preflightStore}, {@link runStorePreflight},
 * {@link runStorePreflightSubcommand}, {@link PreflightCheck},
 * {@link StorePreflightReport}, {@link StorePreflightOptions} — is PUBLIC API,
 * re-exported from the package root (`src/index.ts`) and pinned there by
 * `index.spec.ts`. The probe is pure over the store's own api seam, so a
 * root-only consumer can run it against a fake and get the report `wave-setup`
 * reads without shelling a verb; and the CLI runners were already a
 * root-exported family, so this one's absence was an omission rather than a
 * stance. Public-API rules apply: a change to any of those seven shapes is a
 * consumer-visible change, and the root pairing spec is where it must be seen.
 *
 * {@link engineVersionPreflightCheck} is the one member of this module's
 * preflight vocabulary that stays engine-internal — see its own doc comment for
 * why, which is no longer "its return type is not root-reachable".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_ELIGIBILITY,
  RUNG_PRECEDENCE,
  parseGoalContainer,
  type IssueStore,
  type GoalContainer,
  type ClaimRung,
} from './adapters/issue-store';
import { buildStore } from './store-factory';
import { loadWaveConfig, type WaveConfig, type StoreConfig, type GitHubStoreConfig, type LinearStoreConfig, type StoreGoalConfig } from './wave-config';
import { createGitHubApiFromEnv } from './adapters/github/github-api-factory';
import { createLinearApiFromEnv } from './adapters/linear/linear-api-factory';
import type { CheckStatus } from './host-pr';
import type { GitHubApi } from './adapters/github/github-api';
import type { GitHubIssuesStore } from './adapters/github/github-issues-store';
import type { LinearApi } from './adapters/linear/linear-api';
import type { LinearIssuesStore } from './adapters/linear/linear-issues-store';
import { DEFAULT_LINEAR_STATES, type LinearStateMap } from './adapters/linear/linear-issues-store';
import { RISK_VALUES, WORKER_VALUES, type Risk, type Worker } from './header-parser';
import { flag, printJson, describeConfigLoadError } from './cli-utils';

/**
 * Read `--config <path>` (default `wave.config.json`, resolved against cwd)
 * through `loadWaveConfig`, turning a missing-file failure into a teaching
 * message (issue #505) rather than letting Node's bare ENOENT reach the
 * caller — see {@link describeConfigLoadError}. Every OTHER `loadWaveConfig`
 * failure (malformed JSON, an unknown store kind, …) already names its own
 * fix and rethrows unchanged.
 */
function loadConfigOrTeach(args: string[]): WaveConfig {
  const explicitConfigPath = flag(args, '--config');
  const configPath = explicitConfigPath ?? 'wave.config.json';
  try {
    return loadWaveConfig(configPath);
  } catch (err) {
    throw new Error(
      describeConfigLoadError(err, configPath, explicitConfigPath !== undefined),
    );
  }
}

export async function resolveStore(args: string[], injected?: IssueStore): Promise<IssueStore> {
  if (injected) return injected;
  const config = loadConfigOrTeach(args);
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

// ── the Goal container binding (ADR-0044 decision 4) ──────────────────────

/**
 * Read the consumer's declared goal-container binding out of a loaded wave
 * config — `store.goal.container`.
 *
 * The binding is a SETUP-TIME config fact, and this is the one place it is read,
 * so no store carries it as construction state and `buildStore`'s contract is
 * untouched by the Goal facet existing. `undefined` means "nothing declared",
 * which each store answers for itself: GitHub falls back to `milestone`,
 * MarkdownFs to its goal file, and Linear refuses loudly — deliberately, because
 * live consumer conventions disagree about what a Linear project MEANS.
 *
 * A present-but-wrong value fails HERE, at config-read time, through
 * {@link parseGoalContainer} — "configured means authoritative" (ADR-0029): a
 * malformed declaration must never be quietly read as unbound, which on GitHub
 * would silently fall back to a container the author did not ask for.
 *
 * SHAPE NOTE — why a TYPED field is still re-checked here. `store.goal` is
 * declared on all three `StoreConfig` variants as the named
 * {@link StoreGoalConfig} (`wave-config.ts`), so the read below is by NAME
 * rather than through a shape restated inline here, and the schema — a semver
 * contract — names a key the engine acts on. What that does NOT do is make the
 * value trustworthy: `loadWaveConfig` hands back parsed JSON under the
 * interface, so the declaration describes what a config OUGHT to carry and
 * proves nothing about what THIS one does. Hence every runtime narrow below
 * survives the typing unchanged, and the refusal stays a
 * {@link parseGoalContainer} call rather than being duplicated into the loader:
 * the container ladder has exactly one owner (ADR-0044), and a second copy at
 * config-load time could disagree with it.
 */
export function readGoalContainer(config: WaveConfig): GoalContainer | undefined {
  // Read the TYPED field, then immediately widen to `unknown`: what the
  // interface promises and what the file contains are different claims, and
  // only the second one is checked below.
  const goal: unknown = config.store.goal;
  if (goal === undefined || goal === null) return undefined;
  if (typeof goal !== 'object' || Array.isArray(goal)) {
    throw new Error('wave config "store.goal" must be an object');
  }
  // The KEY comes from {@link StoreGoalConfig} — `keyof` it, so renaming or
  // dropping `container` upstream breaks HERE at compile time instead of
  // silently reading `undefined` off a name nothing declares any more. The VALUE
  // stays `unknown` on purpose: naming the interface says what the key is
  // called, never that this file's JSON honoured it, and `parseGoalContainer` is
  // the one place that grades it.
  return parseGoalContainer(
    (goal as Partial<Record<keyof StoreGoalConfig, unknown>>).container,
  );
}

/**
 * The goal-verb counterpart of {@link resolveStore}: the container role a goal
 * op addresses, or `undefined` when nothing is declared.
 *
 * Mirrors `resolveStore`'s own injected-store short-circuit exactly, and for the
 * same reason: with a store injected there is no config path to read at all, so
 * the binding is `undefined` and the injected store applies its own rule (its
 * default, or its loud refusal). That keeps the two resolutions in lockstep — a
 * caller can never end up with a config-derived binding pointed at a store built
 * from somewhere else.
 */
export function resolveGoalContainer(
  args: string[],
  injected?: IssueStore,
): GoalContainer | undefined {
  if (injected) return undefined;
  return readGoalContainer(loadConfigOrTeach(args));
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
 *
 * `engine-version` (ADR-0032) is the one non-tracker entry, and it is here for a
 * reason that does not reopen that split: it is not a fact about the tracker OR
 * the code host, it is a fact about the INSTALLATION the probe is already
 * running inside, and setup/plan time is when it is cheap to notice. It appears
 * only when the caller supplies an expectation, and it is reported
 * `pass`/`advisory` and NEVER `fail` — see {@link engineVersionPreflightCheck}.
 */
export interface PreflightCheck {
  /** Stable machine key for the precondition. */
  name: 'tracker-host-integration' | 'state-catalog' | 'engine-version';
  status: CheckStatus;
  detail: string;
}

export interface StorePreflightReport {
  /** true iff no check is `fail` — `not-applicable` never blocks. */
  ok: boolean;
  storeKind: StoreConfig['kind'];
  checks: PreflightCheck[];
}

// ── the plugin/engine lockstep version check (ADR-0032) ───────────────────────

/**
 * The engine package name used in the repair line when the manifest could not
 * be read (so its own `name` field is unavailable). A literal only as a LAST
 * resort: the reading below prefers the manifest's own `name`, so a rename of
 * the published package cannot leave a stale instruction behind on the path
 * that matters.
 */
const ENGINE_PACKAGE_NAME_FALLBACK = '@formtrieb/flotilla-engine';

/** What reading the engine package's own manifest produced. */
export interface EngineVersionReading {
  /** The `version` field, trimmed — `null` when it could not be read at all. */
  readonly version: string | null;
  /** The `name` field, trimmed — `null` when it could not be read. */
  readonly packageName: string | null;
  /** The manifest actually read, so a surprising answer is traceable. */
  readonly manifestPath: string;
  /**
   * Why `version` is `null`, verbatim — `null` exactly when `version` is
   * non-null. An unreadable manifest is a REPORTED state, never a throw: the
   * verb's whole job is to answer a question about the installation, and
   * "I could not tell" is an answer callers must be able to see rather than a
   * stack trace they have to parse.
   */
  readonly unreadable: string | null;
}

/**
 * The comparison's outcome. Deliberately five-valued rather than a boolean:
 * "the versions differ" and "I could not read one side" are different facts
 * with the same non-match consequence, and collapsing them is how a gate ends
 * up passing vacuously on an absent input.
 */
export type EngineVersionOutcome =
  /** Both sides read, and equal. */
  | 'match'
  /** Both sides read, and different. */
  | 'mismatch'
  /** No expectation supplied — nothing was compared. */
  | 'no-expectation'
  /** An expectation was supplied, but the engine's own version is unreadable. */
  | 'engine-version-unreadable'
  /** An expectation was supplied but is unusable (empty/whitespace-only). */
  | 'expectation-unusable';

/** The machine-readable result of the lockstep comparison. */
export interface EngineVersionReport {
  /** The engine package's own version — `null` when unreadable. */
  readonly version: string | null;
  /** The caller-supplied expectation, trimmed — `null` when none was given. */
  readonly expected: string | null;
  /**
   * `true` ONLY on a real, both-sides-read equality; `false` for every other
   * comparison that was requested (differing, unreadable engine version,
   * unusable expectation); `null` exactly when no comparison was requested.
   *
   * The asymmetry is the point (ADR-0032 applies the ADR-0029 fail-loud
   * principle): a check whose two inputs are "equal" and "I could not read one
   * of them" must not report the same thing for both, or the absent side
   * silently becomes a pass.
   */
  readonly match: boolean | null;
  readonly outcome: EngineVersionOutcome;
  /** Human-legible one-liner naming what was compared and what came back. */
  readonly detail: string;
  /**
   * The one-line repair, non-null exactly when there is something to repair
   * (every outcome except `match` and `no-expectation`). Single-owner: the
   * skills quote this field rather than re-deriving the command, so the repair
   * a Coordinator prints and the repair the engine believes in cannot drift.
   */
  readonly repair: string | null;
}

/**
 * The engine package's own `package.json`, resolved from THIS module's location
 * rather than from cwd. Correct in both distribution forms (ADR-0032): the
 * vendored source form has `tools/wave/src/…` → `tools/wave/package.json`, and
 * the installed form has `node_modules/@formtrieb/flotilla-engine/src/…` →
 * that package's own manifest. cwd would answer a different question entirely
 * (the CONSUMER's manifest), which is exactly the version nobody is asking for.
 */
export function engineManifestPath(): string {
  return resolve(__dirname, '..', 'package.json');
}

/**
 * Read the engine package's own name + version. Never throws: an unreadable or
 * malformed manifest comes back as `version: null` with the reason in
 * `unreadable`, which the comparison below turns into a non-match rather than a
 * silent pass.
 *
 * @param manifestPath - override for tests (and for a caller inspecting a
 *   different installation); defaults to {@link engineManifestPath}.
 */
export function readEngineVersion(
  manifestPath: string = engineManifestPath(),
): EngineVersionReading {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (err) {
    return {
      version: null,
      packageName: null,
      manifestPath,
      unreadable: `could not read or parse ${manifestPath}: ${(err as Error).message}`,
    };
  }
  const name = (raw as { name?: unknown } | null)?.name;
  const packageName =
    typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    return {
      version: null,
      packageName,
      manifestPath,
      // A manifest that parses but carries no usable `version` is the quietest
      // form of this failure — it must not read as "version: undefined, equal
      // to nothing, carry on".
      unreadable: `${manifestPath} has no non-empty "version" string`,
    };
  }
  return { version: version.trim(), packageName, manifestPath, unreadable: null };
}

/**
 * Compare the engine's own version against a caller-supplied expectation.
 *
 * The DIVISION OF LABOUR is ADR-0032's: the engine knows only its own version
 * and how to compare it. The expectation comes from the Coordinator, which
 * reads the plugin version out of the plugin manifest at the skill's own
 * resolution anchor (the plugin clone ships `.claude-plugin/plugin.json` —
 * ADR-0031's full-clone premise). The engine deliberately does NOT go looking
 * for a plugin manifest itself: it has no way to know which clone is the one
 * the running skills came from, and guessing is worse than being told.
 *
 * Equality is EXACT string equality, pre-1.0 — `plugin.json` and the npm
 * package carry the same version per release, so equality is the whole check.
 * Loosening it (a semver range, a major/minor-only compare) is a post-1.0
 * decision, deliberately not anticipated here.
 *
 * @param expected - the expectation, or `undefined` for "just tell me the version"
 * @param reading - override for tests; defaults to reading the real manifest
 */
export function compareEngineVersion(
  expected: string | undefined,
  reading: EngineVersionReading = readEngineVersion(),
): EngineVersionReport {
  const pkg = reading.packageName ?? ENGINE_PACKAGE_NAME_FALLBACK;

  if (expected === undefined) {
    // No comparison was requested. `match` is null, not true — nothing was
    // compared, and a caller reading `match` must be able to tell that apart
    // from an equality that really held.
    if (reading.version === null) {
      return {
        version: null,
        expected: null,
        match: null,
        outcome: 'engine-version-unreadable',
        detail: `the engine could not read its own version — ${reading.unreadable}`,
        repair: `reinstall the engine (\`npm i -D ${pkg}\`) — its package manifest is missing or malformed.`,
      };
    }
    return {
      version: reading.version,
      expected: null,
      match: null,
      outcome: 'no-expectation',
      detail: `engine ${pkg} is at ${reading.version}; no expected version was supplied, so nothing was compared.`,
      repair: null,
    };
  }

  const want = expected.trim();
  if (want.length === 0) {
    // An empty expectation is not "no expectation" — it is an expectation the
    // caller failed to produce (an unset shell variable, a `jq` miss). Reading
    // it as absent would turn the gate off precisely when its input broke.
    return {
      version: reading.version,
      expected: null,
      match: false,
      outcome: 'expectation-unusable',
      detail:
        'an expected version was supplied but is empty — that is a caller whose lookup produced nothing, not a request to skip the check.',
      repair:
        'recover the expected version (the plugin manifest\'s "version" field) and re-run — an empty expectation is never treated as a match.',
    };
  }

  if (reading.version === null) {
    return {
      version: null,
      expected: want,
      match: false,
      outcome: 'engine-version-unreadable',
      detail: `expected ${want}, but the engine could not read its own version — ${reading.unreadable}`,
      repair: `npm i -D ${pkg}@${want}`,
    };
  }

  if (reading.version === want) {
    return {
      version: reading.version,
      expected: want,
      match: true,
      outcome: 'match',
      detail: `engine ${pkg} is at ${reading.version}, matching the expected version.`,
      repair: null,
    };
  }

  return {
    version: reading.version,
    expected: want,
    match: false,
    outcome: 'mismatch',
    detail: `engine ${pkg} is at ${reading.version} but ${want} was expected — the plugin and the engine are not in lockstep.`,
    repair: `npm i -D ${pkg}@${want}`,
  };
}

/**
 * The exit code for the `version` verb, derived from the outcome rather than
 * from `match` — `match: null` means two different things (nothing compared vs.
 * nothing readable) and only the outcome separates them.
 *
 * 0 — the question was answered affirmatively (`match`, or a bare read)
 * 1 — the comparison did not hold, or could not be made
 */
export function engineVersionExitCode(report: EngineVersionReport): number {
  switch (report.outcome) {
    case 'match':
    case 'no-expectation':
      return 0;
    case 'mismatch':
    case 'engine-version-unreadable':
    case 'expectation-unusable':
      return 1;
  }
}

/**
 * The same comparison, as a store-preflight check. ADVISORY BY CONSTRUCTION:
 * the return type narrows `status` to `'pass' | 'advisory'`, so a future editor
 * cannot make this check `fail` — and therefore cannot make it flip
 * `StorePreflightReport.ok` — without changing this signature and being seen
 * doing it. Setup/plan time is the moment to NOTICE a version skew, not the
 * moment to refuse; the refusal lives in wave-start's gate phase, where the
 * next action is a dispatch (ADR-0032).
 *
 * **Deliberately NOT public API (issue #325).** It is not re-exported from the
 * package root, and the reason is recorded here rather than left to the barrel's
 * export list. The ORIGINAL reason — its return type, {@link PreflightCheck},
 * was itself unreachable from the root — is spent: that family is public now.
 * The surviving reason is one-way-to-ask. A root consumer that wants the
 * lockstep row IN a preflight report passes
 * {@link StorePreflightOptions.expectedEngineVersion} to {@link preflightStore},
 * which appends exactly this check; a consumer that wants the comparison ALONE
 * calls {@link compareEngineVersion}. Exporting the constructor between those
 * two would add a third spelling of one question and a second place for the
 * `pass`/`advisory` mapping to drift — the same reason
 * {@link engineManifestPath} is held back.
 */
export function engineVersionPreflightCheck(
  report: EngineVersionReport,
): PreflightCheck & { status: 'pass' | 'advisory' } {
  return {
    name: 'engine-version',
    status: report.outcome === 'match' ? 'pass' : 'advisory',
    detail:
      report.repair === null
        ? report.detail
        : `${report.detail} Repair: ${report.repair}`,
  };
}

/**
 * Probe the store's live TRACKER preconditions THROUGH its API seam. Each store
 * kind reports the tracker checks meaningful for it and marks the rest
 * `not-applicable`:
 *   - github → `tracker-host-integration` is n/a (GitHub is its own host —
 *     code-host posture is `host-pr preflight`'s concern now, ADR-0023
 *     amendment); `state-catalog` is a REAL check (issue #131): GitHub's claims
 *     ARE labels, which is exactly why they need verifying, not why the check
 *     should be skipped — see {@link githubChecks};
 *   - linear → the GitHub integration + the workflow-state catalog (ADR-0020).
 *     `tracker-host-integration` is n/a WITHOUT probing whenever
 *     `states.doneState` is configured (FOR-13 fallback, issue #493) — see
 *     {@link linearChecks};
 *   - markdown → all n/a (a local dev/dogfood store).
 * Pure over the seam — `store` may wrap an in-memory fake (test) or a real impl.
 *
 * `opts.expectedEngineVersion` (ADR-0032) appends the plugin/engine lockstep
 * check. It is appended ONLY when an expectation is supplied — a probe with
 * nothing to compare against reports nothing rather than a permanent
 * `not-applicable` row nobody reads — and it can only be `pass`/`advisory`, so
 * it never moves `ok`.
 */
export async function preflightStore(
  config: WaveConfig,
  store: IssueStore,
  opts: StorePreflightOptions = {},
): Promise<StorePreflightReport> {
  const s = config.store;
  const checks: PreflightCheck[] =
    s.kind === 'github'
      ? await githubChecks((store as GitHubIssuesStore).api, s)
      : s.kind === 'linear'
        ? await linearChecks((store as LinearIssuesStore).api, s)
        : markdownChecks();
  if (opts.expectedEngineVersion !== undefined) {
    checks.push(
      engineVersionPreflightCheck(
        compareEngineVersion(opts.expectedEngineVersion, opts.engineVersionReading),
      ),
    );
  }
  return { ok: checks.every((c) => c.status !== 'fail'), storeKind: s.kind, checks };
}

/** Options for {@link preflightStore}. All optional — omitting them is today's behaviour. */
export interface StorePreflightOptions {
  /**
   * The plugin version the caller expects the engine to be at (ADR-0032).
   * Supplied by the Coordinator, which reads it from the plugin manifest at the
   * skill's own resolution anchor. Absent → the lockstep check is not reported
   * at all.
   */
  readonly expectedEngineVersion?: string;
  /** Override for the engine's own version reading (tests). */
  readonly engineVersionReading?: EngineVersionReading;
}

/**
 * The orthogonal needs-attention overlay label (ADR-0006) — mirrors
 * `github-issues-store.ts`'s (unexported) `NEEDS_ATTENTION_LABEL`. Duplicated as
 * a literal rather than imported: the string is ADR-pinned, not derived, and
 * this module already reaches into that store only for its injected `api`.
 */
const GITHUB_NEEDS_ATTENTION_LABEL = 'wave/needs-attention';

/**
 * The exact label set a GitHub-store wave will read or write (issue #131),
 * derived from config rather than hardcoded to the thirteen a fresh setup
 * happens to need today:
 *   - the configured eligibility OR-set (default {@link DEFAULT_ELIGIBILITY}) —
 *     a consumer may legitimately rename this;
 *   - the Risk/Worker vocabulary `GitHubIssuesStore` actually annotates with
 *     ({@link RISK_VALUES}/{@link WORKER_VALUES} — the DEFAULT_WAVE_SCHEMA set.
 *     GitHub has no per-store schema override yet, so this shared default IS
 *     what will be read/written; the check follows it, not a copy of it);
 *   - the four engine-written `wave/<rung>` claim labels: the three
 *     `transition()` rungs ({@link RUNG_PRECEDENCE}) plus the orthogonal
 *     needs-attention overlay — non-negotiable, the projection writes them.
 */
function requiredGitHubLabels(storeConfig: GitHubStoreConfig): string[] {
  return requiredGitHubWaveLabels(storeConfig).map((label) => label.name);
}

// ── the label set the `--create-missing-labels` repair writes (issue #675) ────

/**
 * flotilla's DEFAULT presentation for one wave label — the colour and the
 * one-sentence description a create gives it.
 *
 * `color` is a 6-digit hexadecimal code WITHOUT a leading `#` and `description`
 * is at most 100 characters, because those are GitHub's own constraints on the
 * create-label endpoint (docs.github.com/en/rest/issues/labels, read
 * 2026-09-03) — see `CreateLabelInput`, the seam this feeds.
 *
 * MODULE-PRIVATE, with the three shapes and the pass below it, for a reason
 * worth stating rather than re-deriving: the way a caller reaches this repair
 * is the flag on the probe that found the gap, which reports what it wrote in
 * the same detail. A root-exported constructor beside it would be a second,
 * report-less spelling of one question — the same one-way-to-ask reason
 * {@link engineVersionPreflightCheck} and {@link engineManifestPath} are held
 * back for.
 */
interface GitHubLabelDefault {
  readonly color: string;
  readonly description: string;
}

/** One required wave label, carrying the presentation a create would give it. */
interface GitHubWaveLabel extends GitHubLabelDefault {
  readonly name: string;
}

/**
 * ONE table, in the engine, for the colour + description every wave label is
 * created with. Deliberately not restated in skill prose: the flag and the
 * documentation would then be two owners of one fact, and a fresh repository's
 * appearance would drift from whichever one the operator happened to read. The
 * values are the ones flotilla's own repository uses.
 *
 * KEYED BY THE VOCABULARIES THEMSELVES rather than by label string, which makes
 * the table EXHAUSTIVE AT COMPILE TIME: a fifth `RISK_VALUES` member, a fourth
 * claim rung, a renamed worker tier — each breaks `tsc` right here instead of
 * silently inheriting some other row's wording through a string lookup that
 * missed. That is the same reason {@link requiredGitHubWaveLabels} derives its
 * list from the constants rather than hardcoding the thirteen names a fresh
 * setup happens to need today.
 *
 * `eligibility` is the one row applied BY ROLE rather than by name: the
 * eligibility OR-set is the consumer's own declaration (ADR-0003), so a repo
 * that renamed `ready-for-agent` gets this colour and description under its own
 * chosen name.
 */
const GITHUB_LABEL_DEFAULTS: {
  readonly eligibility: GitHubLabelDefault;
  readonly risk: Readonly<Record<Risk, GitHubLabelDefault>>;
  readonly worker: Readonly<Record<Worker, GitHubLabelDefault>>;
  readonly rung: Readonly<Record<ClaimRung, GitHubLabelDefault>>;
  readonly needsAttention: GitHubLabelDefault;
} = {
  eligibility: {
    color: '0e8a16',
    description: 'Wave-eligible: an AFK agent may grab this issue',
  },
  risk: {
    'cross-feature-refactor': {
      color: 'f9d0c4',
      description: 'Risk: touches 2+ areas or shared infra',
    },
    'isolated-refactor': {
      color: 'fef2c0',
      description: 'Risk: one module/area, no cross-cutting impact',
    },
    mechanical: {
      color: 'c2e0c6',
      description: 'Risk: script/codemod, no judgment calls',
    },
    'public-API-change': {
      color: 'e99695',
      description: 'Risk: adds/changes a public input/output/contract',
    },
  },
  worker: {
    background: {
      color: '1d76db',
      description: 'Worker: autonomous AFK agent',
    },
    'background-heavy': {
      color: '0052cc',
      description: 'Worker: autonomous AFK agent, strong model tier',
    },
    foreground: {
      color: '5319e7',
      description: 'Worker: human co-pilots in chat',
    },
    'HITL-required': {
      color: 'b60205',
      description: 'Worker: cannot be delegated, pure human judgment',
    },
  },
  rung: {
    'in-flight': {
      color: 'bfd4f2',
      description: 'Claim: a Worker is actively on this row',
    },
    'in-review': {
      color: 'c5def5',
      description: 'Claim: Worker finished, PR open / under review',
    },
    queued: {
      color: 'd4c5f9',
      description: 'Claim: soft-claimed by a wave, not yet dispatched',
    },
  },
  needsAttention: {
    color: 'd93f0b',
    description: 'Orthogonal: this row STOPped and needs a human',
  },
};

/**
 * The same required set {@link requiredGitHubLabels} names, each row carrying
 * the presentation a create would give it.
 *
 * ONE OWNER for the list: the string form above is literally this function's
 * names, so the check that REPORTS a missing label and the repair that CREATES
 * it can never disagree about what "required" means — which is the whole reason
 * the repair is a flag on this probe rather than a verb of its own.
 */
function requiredGitHubWaveLabels(storeConfig: GitHubStoreConfig): GitHubWaveLabel[] {
  const eligibility = storeConfig.eligibility ?? DEFAULT_ELIGIBILITY;
  const rows: GitHubWaveLabel[] = [
    ...eligibility.map((name) => ({ name, ...GITHUB_LABEL_DEFAULTS.eligibility })),
    ...RISK_VALUES.map((r) => ({ name: `risk/${r}`, ...GITHUB_LABEL_DEFAULTS.risk[r] })),
    ...WORKER_VALUES.map((w) => ({ name: `worker/${w}`, ...GITHUB_LABEL_DEFAULTS.worker[w] })),
    ...RUNG_PRECEDENCE.map((r) => ({ name: `wave/${r}`, ...GITHUB_LABEL_DEFAULTS.rung[r] })),
    { name: GITHUB_NEEDS_ATTENTION_LABEL, ...GITHUB_LABEL_DEFAULTS.needsAttention },
  ];
  // First occurrence wins, exactly as the `new Set([...])` dedup the string form
  // used to do — a consumer whose eligibility token collides with an engine
  // label keeps the eligibility row's presentation, and the name appears once.
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.name)) return false;
    seen.add(row.name);
    return true;
  });
}

/**
 * What one `--create-missing-labels` pass did. Names only — the presentation it
 * wrote is {@link GITHUB_LABEL_DEFAULTS}'s and is not restated per row.
 *
 * THREE buckets rather than a count, because they are three different facts
 * about the repository and only the first one is a write this pass performed:
 * conflating "I created it" with "it was already there" is what makes a second
 * run read like a first one.
 */
interface GitHubLabelEnsureResult {
  /** Created by THIS pass, in required-list order. */
  readonly created: string[];
  /**
   * Reported missing by this pass's own probe, but the API answered
   * already-exists — some other actor created them in between. Treated as
   * PRESENT, never as a failure (the {@link GitHubApi.createLabel} contract).
   */
  readonly concurrentlyCreated: string[];
  /** Already in the registry when the pass began — nothing was written. */
  readonly alreadyPresent: string[];
}

/**
 * Create every wave label the repository lacks, through the engine's own
 * credential — the repair half of the `state-catalog` check (issue #675).
 *
 * IDEMPOTENT: it probes the registry first and writes only the difference, so a
 * second run creates nothing and says so. RACE-SAFE: a label that appears
 * between that probe and the create comes back as `created: false` from the
 * seam and lands in {@link GitHubLabelEnsureResult.concurrentlyCreated} —
 * present, not failed. Any other rejected write throws, and the runner reports
 * it as the loud failure it is.
 *
 * MODULE-PRIVATE — see {@link GitHubLabelDefault} for the reason. Its one
 * caller is {@link runStorePreflight}, and the specs reach it through that verb
 * rather than around it, which is also the only way a consumer can.
 */
async function ensureGitHubWaveLabels(
  api: GitHubApi,
  storeConfig: GitHubStoreConfig,
): Promise<GitHubLabelEnsureResult> {
  const required = requiredGitHubWaveLabels(storeConfig);
  const existing = new Set(await api.listLabels());
  const created: string[] = [];
  const concurrentlyCreated: string[] = [];
  const alreadyPresent: string[] = [];
  for (const label of required) {
    if (existing.has(label.name)) {
      alreadyPresent.push(label.name);
      continue;
    }
    const answer = await api.createLabel({
      name: label.name,
      color: label.color,
      description: label.description,
    });
    (answer.created ? created : concurrentlyCreated).push(label.name);
  }
  return { created, concurrentlyCreated, alreadyPresent };
}

/** `"a", "b"` — the same quoting the missing-label detail uses. */
function quoteNames(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ');
}

/**
 * The one sentence (two, when a race happened) the create pass adds to the
 * re-probed `state-catalog` detail. It names each label it created, so the
 * operator sees the repair rather than only its absence of complaint — and, on
 * a second run, says plainly that it created nothing.
 */
function describeLabelCreation(result: GitHubLabelEnsureResult): string {
  const head =
    result.created.length === 0
      ? "--create-missing-labels created nothing: every label the wave will read or write already existed."
      : `--create-missing-labels created ${result.created.length} missing label(s) through the engine's own credential: ${quoteNames(result.created)}.`;
  if (result.concurrentlyCreated.length === 0) return head;
  return `${head} Created by someone else between the probe and the create, and read as present rather than as a failure: ${quoteNames(result.concurrentlyCreated)}.`;
}

/**
 * The report to PRINT after a create pass: the re-probe, with that pass's
 * account appended to the `state-catalog` detail.
 *
 * The created names travel in `detail` on purpose — {@link PreflightCheck} keeps
 * its three-member `name` union and gains no field, so a root consumer's
 * exhaustive switch over the check names is untouched by this flag existing.
 */
function withLabelCreation(
  report: StorePreflightReport,
  result: GitHubLabelEnsureResult,
): StorePreflightReport {
  return {
    ...report,
    checks: report.checks.map((check) =>
      check.name === 'state-catalog'
        ? { ...check, detail: `${check.detail} ${describeLabelCreation(result)}` }
        : check,
    ),
  };
}

async function githubChecks(api: GitHubApi, storeConfig: GitHubStoreConfig): Promise<PreflightCheck[]> {
  const required = requiredGitHubLabels(storeConfig);
  const existing = new Set(await api.listLabels());
  const missing = required.filter((label) => !existing.has(label));
  const labelsOk = missing.length === 0;

  return [
    {
      name: 'tracker-host-integration',
      status: 'not-applicable',
      detail: 'GitHub is its own code host — there is no external tracker↔host integration to install.',
    },
    {
      name: 'state-catalog',
      status: labelsOk ? 'pass' : 'fail',
      detail: labelsOk
        ? 'GitHub claims are labels (eligibility, risk/*, worker/*, wave/* rungs) — every one the wave will read or write exists in the repository.'
        : `GitHub claims are labels — which is exactly why they need verifying: the following are missing from the repository and must be created before running a wave: ${missing.map((m) => `"${m}"`).join(', ')}.`,
    },
  ];
}

async function linearChecks(api: LinearApi, storeConfig: LinearStoreConfig): Promise<PreflightCheck[]> {
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

  // `tracker-host-integration` (issue #493 / field report). When
  // `states.doneState` is configured (the FOR-13 fallback), done resolves via
  // the forced flip on merge-confirmation, NEVER via the closing attachment the
  // Linear↔GitHub integration would create — so whether that integration is
  // installed is not a precondition here at all, and reference/setup-mechanics.md
  // documents exactly that: this check is `not-applicable` whenever `doneState`
  // is set. The pre-fix version probed anyway and reported `pass`/`fail` on
  // whatever the integration happened to be, which is a check that ran and
  // answered a question nobody needed answered. Fixed here by deciding on
  // `doneState` FIRST and skipping the probe entirely on that branch — the
  // integration API is not even called.
  let integration: PreflightCheck;
  if (effective.doneState !== undefined) {
    integration = {
      name: 'tracker-host-integration',
      status: 'not-applicable',
      detail: `states.doneState ("${effective.doneState}") is configured — rows resolve to done via the FOR-13 fallback, so the Linear↔GitHub integration was not probed.`,
    };
  } else {
    const hasIntegration = await api.hasGitHubIntegration();
    // The LinearApi seam reaches the TRACKER only (see the code-host-facts note
    // below) — it has no way to learn THIS repo's code host, so a `pass` here
    // can state only what was actually probed (the Linear WORKSPACE's GitHub
    // integration) and must CONDITION the done-derivation conclusion on a
    // GitHub code host rather than assert it unconditionally. Asserting it
    // unconditionally was the false-reassurance the field report caught: the
    // integration can be installed workspace-wide (from other repos sharing the
    // workspace) while THIS repo's PRs are on a different code host (e.g.
    // Bitbucket), where no closing attachment is ever created and `pass` would
    // have promised one anyway.
    integration = hasIntegration
      ? {
          name: 'tracker-host-integration',
          status: 'pass',
          detail:
            'Linear↔GitHub integration is installed — on a GitHub code host, a merged PR creates the closing attachment the done-derivation reads; on any other code host (e.g. Bitbucket), that attachment is never created and states.doneState must be configured for done-derivation to work.',
        }
      : {
          name: 'tracker-host-integration',
          status: 'fail',
          detail:
            'Linear↔GitHub integration is NOT installed and no states.doneState fallback is configured — merged PRs will never resolve rows to done. Install the Linear↔GitHub integration, or set states.doneState in wave.config.json to a Linear workflow state name. Background: https://github.com/formtrieb/flotilla/blob/main/docs/adr/0020-linear-claims-live-in-workflow-states-triage-vocabulary-stays-labels.md',
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

/**
 * The opt-in repair flag (issue #675): create every label the `state-catalog`
 * check reports missing, then re-probe. A NAMED CONSTANT because three places
 * spell it — the parse, the refusal message and the usage text — and a typo in
 * any one of them would present as a silently read-only run.
 */
const CREATE_MISSING_LABELS_FLAG = '--create-missing-labels';

function preflightUsage(message: string): number {
  process.stderr.write(
    [
      `error: ${message}`,
      `usage: cli-store preflight [--config <path>] [--expect <plugin-version>] [${CREATE_MISSING_LABELS_FLAG}]   # prints the StorePreflightReport as JSON`,
      '  Probes TRACKER preconditions only (tracker↔host integration, workflow-state catalog).',
      '  --expect <plugin-version> additionally reports the plugin/engine lockstep',
      '  comparison as an ADVISORY check — it never fails the preflight.',
      `  ${CREATE_MISSING_LABELS_FLAG} creates every label the state-catalog check reports`,
      "  missing, through the engine's own credential, then re-probes and names what it",
      '  created. `github` store only (exit 2 on any other kind), idempotent, and never',
      '  the default — without it the probe writes nothing at all.',
      '  For code-host posture (pr-merge-token, allow-auto-merge, required-checks) run',
      '  `host-pr preflight` — it is store-blind and reports on every store kind.',
      '',
    ].join('\n'),
  );
  return 2;
}

/**
 * Read `--expect <version>` off an arg list, distinguishing "absent" from
 * "present with nothing usable after it".
 *
 * `flag()` cannot make that distinction — a trailing `--expect` with no value
 * comes back `undefined`, byte-identical to the flag never being there — and
 * that collapse is exactly how a version gate ends up silently disabled by the
 * command that was supposed to arm it. So this parses positionally: present but
 * value-less (or followed by the next flag) is a USAGE ERROR, never a silent
 * "no expectation".
 *
 * @returns the raw value, `undefined` when the flag is absent, or `null` when it
 *   is present but has no usable value (the caller turns that into exit 2)
 */
function readExpectFlag(args: string[]): string | undefined | null {
  const idx = args.indexOf('--expect');
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
    return null;
  }
  return value;
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
 *
 * `--expect <plugin-version>` (ADR-0032) adds the lockstep comparison as an
 * ADVISORY check. It deliberately does not move the exit code: a version skew
 * noticed at setup/plan time is information, and turning it into a refusal here
 * would block a `wave-plan` on a fact that only bites at dispatch. The hard
 * refusal is wave-start's gate phase.
 *
 * `--create-missing-labels` (issue #675) is the probe's one WRITE, and it is
 * opt-in: with it, a `github` store's missing wave labels are created through
 * the engine's own credential before the checks are read, so the printed
 * `state-catalog` is the RE-PROBE and its detail names what was created. The
 * read-only default is unchanged — without the flag this runner touches nothing
 * and prints byte-identical output. On any other store kind the flag is a usage
 * error (exit 2) raised BEFORE the store is even built: Linear's workflow states
 * are configured in the workspace and the markdown store has no label registry,
 * so there is nothing for the engine to create in either case.
 */
export async function runStorePreflight(args: string[], injected?: IssueStore): Promise<number> {
  const op = args[0];
  if (op !== 'preflight') {
    return preflightUsage(`unknown op "${op ?? ''}" — only "preflight" is supported`);
  }
  const expected = readExpectFlag(args);
  if (expected === null) {
    return preflightUsage(
      '--expect requires a <plugin-version> value — a value-less --expect is a caller whose lookup produced nothing, not a request to skip the lockstep check',
    );
  }
  let config: WaveConfig;
  try {
    config = loadConfigOrTeach(args);
  } catch (err) {
    // config unreadable/invalid → a usage-class problem (couldn't even run the probe).
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  // The repair flag, resolved to the GitHub store config it applies to — or
  // `undefined`, which on a flagged run is the refusal below. Narrowing HERE
  // rather than at the call site keeps `config.store` a discriminated read
  // instead of a cast, and puts the refusal ahead of `resolveStore`: on a store
  // kind the flag cannot serve, nothing is built, nothing is probed, and above
  // all nothing is written.
  const createMissingLabels = args.includes(CREATE_MISSING_LABELS_FLAG);
  const labelRepairTarget =
    createMissingLabels && config.store.kind === 'github' ? config.store : undefined;
  if (createMissingLabels && labelRepairTarget === undefined) {
    return preflightUsage(
      `${CREATE_MISSING_LABELS_FLAG} applies to a "github" store only — this config is "${config.store.kind}". Linear's claims are workflow states, configured in the workspace (create them in Linear, or fix the states map); the markdown store has no label registry at all. Nothing was written.`,
    );
  }
  try {
    const store = await resolveStore(args, injected);
    // The repair runs BEFORE the checks are read, which is what makes the
    // printed `state-catalog` the re-probe the flag promises rather than a
    // stale first look.
    const labelRepair =
      labelRepairTarget === undefined
        ? undefined
        : await ensureGitHubWaveLabels(
            (store as GitHubIssuesStore).api,
            labelRepairTarget,
          );
    const report = await preflightStore(config, store, {
      ...(expected !== undefined ? { expectedEngineVersion: expected } : {}),
    });
    printJson(labelRepair === undefined ? report : withLabelCreation(report, labelRepair));
    return report.ok ? 0 : 1; // 1 = a precondition failed LOUDLY (the FOR-12 signal)
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

/**
 * The router-facing spelling of the store-preflight (issue #77):
 * `{{wave-cli}} store-preflight [--config <path>]`.
 *
 * The standalone module form carries the op as `args[0]` (`cli-store.ts
 * preflight …`); as a router subcommand the SUBCOMMAND NAME already is the op,
 * so this shim prepends the `preflight` token and delegates to
 * {@link runStorePreflight}. There is exactly one runner, one probe and one set
 * of exit codes (0 all preconditions pass/n-a; 1 a precondition FAILED loudly or
 * the probe threw; 2 usage error or unreadable/invalid config) — this adds no
 * logic of its own, so the two spellings can never drift.
 *
 * Note the arg-shape consequence: a BARE `{{wave-cli}} store-preflight` (no
 * flags) is legal and probes against the default `wave.config.json`, exactly as
 * a bare `cli-store.ts preflight` does. `cli.ts` therefore intercepts this
 * subcommand in `mainAsync` BEFORE the router's zero-arg guard.
 *
 * `--expect <plugin-version>` and `--create-missing-labels` ride through
 * unchanged like every other flag — the shim adds no parsing of its own, so the
 * two spellings cannot drift on either.
 */
export function runStorePreflightSubcommand(
  args: string[],
  injected?: IssueStore,
): Promise<number> {
  return runStorePreflight(['preflight', ...args], injected);
}

// Only execute when this file is run directly (not when imported for
// resolveStore). Retained as an ALIAS for `{{wave-cli}} store-preflight`
// (issue #77) — the existing `wave-setup` call-sites still spell it this way.
if (require.main === module) {
  runStorePreflight(process.argv.slice(2))
    .then((c) => process.exit(c))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
