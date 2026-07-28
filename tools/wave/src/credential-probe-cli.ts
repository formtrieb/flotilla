#!/usr/bin/env node
/**
 * credential-probe-cli.ts — the value-free `credential-probe` verb (ADR-0029).
 *
 * It answers exactly one question: **can every configured credential be
 * resolved right now?** — and it answers by EXIT CODE plus a value-free JSON
 * summary. It is the sanctioned auth check a Coordinator runs at the two auth
 * preflights (wave-start step 4, wave-close phase 2), and it exists because the
 * two things a human would otherwise reach for are both wrong:
 *
 *   - `[ -n "$GITHUB_TOKEN" ] && echo set` proves *presence*, and after ADR-0029
 *     the environment carries the POINTER, not the secret — an adopted consumer
 *     has no ambient value to be present. Presence is no longer resolvability.
 *   - Running the configured `<VAR>_CMD` by hand is the thing Convention 8
 *     forbids outright: **its stdout IS the secret**. This verb runs it inside
 *     the engine, where the resolver's containment properties hold.
 *
 * ## AFK posture — why this runs at a preflight and not mid-wave
 *
 * ADR-0029: keychain and session-auth prompts must fire in the INTERACTIVE
 * session, before dispatch. A locked keychain or an expired secret-manager
 * session discovered mid-wave is a row failure (loud, per the resolver's typed
 * error) — but it is a row failure that a 3-second probe before the flip would
 * have prevented. So the probe deliberately performs a REAL lookup per
 * credential: it passes `env` explicitly into {@link resolveCredential}, which
 * disables that function's once-per-process memo. A memo hit would prove only
 * that something resolved earlier in this process — the one thing a probe must
 * never accept as evidence.
 *
 * ## Why nothing here can print a secret — by construction, not by promise
 *
 * 1. The resolved secret is **never bound to a name**. {@link probeCredential}
 *    calls the resolver as a `void` expression and returns a result type that
 *    has no field capable of holding it. There is no variable to interpolate by
 *    accident, and no field a caller could serialize.
 * 2. Only fields the resolver already proves value-free are reported: the
 *    ambient variable NAME, the command-variable NAME, the CONFIGURED COMMAND
 *    (the pointer that travels in tracked settings — ADR-0029 makes naming it
 *    the point), the machine-readable {@link CredentialFailure}, and the typed
 *    error's `.message`. The lookup's stdout/stderr never reach the resolver's
 *    error in the first place (`credential-resolver.ts` has no stderr field at
 *    all), so there is nothing here to filter.
 * 3. A throw that is NOT a {@link CredentialResolutionError} carries no
 *    value-free guarantee, so its own message is **discarded**: the outcome
 *    reports `failure: 'unexpected'` and a fixed sentence naming only the
 *    variable and the thrown value's class. An unknown error class is exactly
 *    where an unfiltered `${err.message}` would leak.
 *
 * ## Which credentials get probed
 *
 *   `credential-probe --all`                 every CONFIGURED credential this
 *                                            engine's own adapters read
 *                                            ({@link KNOWN_CREDENTIAL_VARIABLES}).
 *   `credential-probe --var <VAR> [--var …]` exactly the named credentials —
 *                                            the form an out-of-tree store
 *                                            adapter uses, since `<VAR>_CMD` is
 *                                            mechanical (ADR-0029) and every
 *                                            adapter inherits it for free.
 *
 * The two forms differ deliberately on the not-configured case, and the
 * difference is the whole reason both exist:
 *   - `--all` only SELECTS credentials that are configured, so it never fails a
 *     preflight over a credential this consumer does not use (a github-store
 *     repo has no `LINEAR_API_KEY`, and that is not a defect).
 *   - `--var <VAR>` names a credential the caller says it needs, so an
 *     unconfigured one IS a failure (`not-configured`) — naming it is the
 *     assertion.
 *
 * Exit codes:
 *   0 — every probed credential resolved (including "nothing configured" under
 *       `--all`, which is vacuously true — the JSON still reports `probed: []`
 *       plus a `note`, so a run can never do nothing and show nothing)
 *   1 — at least one probed credential failed to resolve
 *   2 — usage (no selection given, an unknown flag, a stray positional)
 */

import {
  resolveCredential,
  commandVariableFor,
  CredentialResolutionError,
  type CredentialFailure,
  type CredentialLookupSpawn,
} from './credential-resolver';
import { printJson } from './cli-utils';

/**
 * The credentials THIS engine's own adapters read (ADR-0029's two mechanical
 * pairs). `--all` discovers over exactly this list: it is what "every configured
 * credential" means for a flotilla consumer, and it deliberately does NOT scan
 * the environment for arbitrary `*_CMD` keys — an unrelated `EDITOR_CMD` is not
 * a credential, and spawning it at a preflight would be a surprise.
 *
 * An out-of-tree store adapter is not shut out: it names its credential with
 * `--var`, which inherits the same precedence, the same loud failures, and the
 * same containment.
 */
export const KNOWN_CREDENTIAL_VARIABLES = ['GITHUB_TOKEN', 'LINEAR_API_KEY'] as const;

/** Why a probe failed. The resolver's own vocabulary, plus the unknown-throw catch-all. */
export type CredentialProbeFailure = CredentialFailure | 'unexpected';

/** Where a credential WOULD resolve from, as configured right now. Reporting only. */
export type CredentialSource = 'command' | 'ambient' | 'none';

/**
 * One credential's probe outcome. Note what this type CANNOT hold: the secret.
 * There is no `value`, no `secret`, no `stdout` field — a field that does not
 * exist cannot be printed by a caller, which is the same structural argument
 * `CredentialResolutionError` makes about its own shape.
 */
export interface CredentialProbeOutcome {
  /** The ambient variable name the credential is known by (e.g. `GITHUB_TOKEN`). */
  variable: string;
  /** Its mechanical command counterpart (`<VAR>_CMD`). */
  commandVariable: string;
  /** Which source the precedence rule selects for this credential right now. */
  source: CredentialSource;
  /** The configured lookup command, when one is configured. A pointer — never its output. */
  command?: string;
  /** Whether the credential resolved. The probe's actual answer. */
  resolved: boolean;
  /** Machine-readable failure mode, when it did not resolve. */
  failure?: CredentialProbeFailure;
  /** The typed error's own value-free message, when it did not resolve. */
  message?: string;
}

/** The whole probe run, as printed. `probed` is always present — even when empty. */
export interface CredentialProbeReport {
  /** True iff every probed credential resolved. Mirrors the exit code. */
  ok: boolean;
  /** Every credential this run probed, in selection order. */
  probed: CredentialProbeOutcome[];
  /** The variable names that failed — the quick read for a human or a shell. */
  failed: string[];
  /** Present only when `--all` selected nothing, so an empty run explains itself. */
  note?: string;
}

/** Impure inputs; production defaults `env` to `process.env` and uses the real shell. */
export interface CredentialProbeOptions {
  /** Environment to read `<VAR>` / `<VAR>_CMD` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable lookup spawn (specs). Defaults to the resolver's real-shell spawn. */
  spawn?: CredentialLookupSpawn;
}

/**
 * The configured lookup command for a credential, or `undefined` when none is
 * configured. ONE place applies ADR-0029's blank rule (an empty or
 * whitespace-only `<VAR>_CMD` counts as not configured — the deliberate
 * per-environment escape hatch back to the ambient path), and both discovery
 * and reporting read it, so they cannot disagree with each other.
 */
export function configuredLookupCommand(
  variable: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const command = (env[commandVariableFor(variable)] ?? '').trim();
  return command.length > 0 ? command : undefined;
}

/** Which source the precedence rule selects right now (reporting only — the resolver decides). */
function sourceOf(variable: string, env: NodeJS.ProcessEnv): CredentialSource {
  if (configuredLookupCommand(variable, env) !== undefined) return 'command';
  const ambient = env[variable];
  return ambient !== undefined && ambient.length > 0 ? 'ambient' : 'none';
}

/**
 * A credential counts as CONFIGURED when either source is present: a non-blank
 * `<VAR>_CMD`, or a non-empty ambient `<VAR>`. `--all` probes exactly these —
 * an ambient-only credential resolves trivially, which folds the old
 * presence check into the same run rather than leaving it as a second, weaker
 * ritual beside it.
 */
export function discoverConfiguredCredentials(env: NodeJS.ProcessEnv): string[] {
  return KNOWN_CREDENTIAL_VARIABLES.filter((v) => sourceOf(v, env) !== 'none');
}

/**
 * Probe ONE credential: run the real resolver, keep the answer, discard the
 * secret.
 *
 * The `void` is load-bearing and deliberate — the resolved secret is never
 * bound to a name in this function, so no later edit can interpolate it into a
 * message, and no field of the returned {@link CredentialProbeOutcome} can
 * carry it.
 */
export function probeCredential(
  variable: string,
  opts: CredentialProbeOptions = {},
): CredentialProbeOutcome {
  const env = opts.env ?? process.env;
  const command = configuredLookupCommand(variable, env);
  const base = {
    variable,
    commandVariable: commandVariableFor(variable),
    source: sourceOf(variable, env),
    ...(command !== undefined ? { command } : {}),
  };

  try {
    // The secret is DISCARDED here — never named, never returned, never logged.
    // `env` is passed explicitly so the resolver's once-per-process memo is
    // bypassed: a probe that could be satisfied by a memo hit proves nothing.
    void resolveCredential(variable, {
      env,
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
      purpose: 'authenticate this wave step',
    });
    return { ...base, resolved: true };
  } catch (err) {
    if (err instanceof CredentialResolutionError) {
      // Only fields the resolver already proves value-free (its spec asserts
      // the message, the stack, and every own property are free of the
      // lookup's stdout/stderr and of the ambient value).
      return { ...base, resolved: false, failure: err.failure, message: err.message };
    }
    // An unknown error class carries NO value-free guarantee, so its own
    // message is dropped rather than forwarded: this is precisely where an
    // unfiltered `${err.message}` would leak a quoted command line or worse.
    return {
      ...base,
      resolved: false,
      failure: 'unexpected',
      message:
        `${variable} could not be probed: the lookup threw an unexpected ` +
        `${errorClassName(err)}. Its message is deliberately not reported — ` +
        'only a typed CredentialResolutionError is known to be value-free (ADR-0029).',
    };
  }
}

/** The thrown value's class name — a type, never its content. */
function errorClassName(err: unknown): string {
  if (err instanceof Error) return err.constructor.name;
  return typeof err;
}

/**
 * Probe a set of credentials and assemble the report. Pure over its inputs
 * except for the lookups themselves; the CLI runner below only formats and
 * exits.
 */
export function probeCredentials(
  variables: string[],
  opts: CredentialProbeOptions = {},
): CredentialProbeReport {
  const probed = variables.map((v) => probeCredential(v, opts));
  const failed = probed.filter((p) => !p.resolved).map((p) => p.variable);
  return { ok: failed.length === 0, probed, failed };
}

function printUsage(): void {
  process.stderr.write(
    [
      'usage:',
      '  credential-probe --all                          # probe every CONFIGURED credential (ADR-0029)',
      '  credential-probe --var <VAR> [--var <VAR> ...]  # probe exactly these (e.g. GITHUB_TOKEN)',
      '',
      '  Answers "can every configured credential be resolved right now?" by exit',
      '  code. It runs each configured <VAR>_CMD through the engine resolver and',
      '  NEVER prints the secret, the lookup stdout, or the lookup stderr — only',
      '  the variable name, the configured command (a pointer), and a typed failure.',
      '',
      '  Do NOT run a configured <VAR>_CMD value yourself: its stdout IS the secret.',
      '  This verb is the sanctioned check (wave-shared Convention 8).',
      '',
      `  known credentials for --all: ${KNOWN_CREDENTIAL_VARIABLES.join(', ')}`,
      '',
      'exit codes:',
      '  0  every probed credential resolved (or --all found none configured)',
      '  1  at least one probed credential failed to resolve',
      '  2  usage',
      '',
    ].join('\n'),
  );
}

/**
 * Run the `credential-probe` verb.
 *
 * `--config <path>` is accepted and DISCARDED (the FOR-87/W25-F2 precedent): a
 * Coordinator wrapper appends it uniformly to every engine invocation, and a
 * probe that reads only the environment has no use for it. Any OTHER unknown
 * `--flag`, and any stray positional, is a hard usage error — a flag-shaped
 * token must never silently bind as data.
 */
export function runCredentialProbe(
  args: string[],
  opts: CredentialProbeOptions = {},
): number {
  const env = opts.env ?? process.env;
  const named: string[] = [];
  let all = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') {
      all = true;
      continue;
    }
    if (a === '--var') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write('error: credential-probe: --var requires a variable name\n');
        printUsage();
        return 2;
      }
      named.push(value);
      i++;
      continue;
    }
    if (a === '--config') {
      i++; // accepted-and-ignored, value token consumed (FOR-87 uniform-wrapper tolerance)
      continue;
    }
    process.stderr.write(
      a.startsWith('--')
        ? `error: credential-probe: unknown flag ${a}\n`
        : `error: credential-probe: unexpected argument "${a}" — select with --all or --var <VAR>\n`,
    );
    printUsage();
    return 2;
  }

  if (!all && named.length === 0) {
    process.stderr.write(
      'error: credential-probe requires a selection: --all or --var <VAR>\n',
    );
    printUsage();
    return 2;
  }

  // De-duplicate while preserving selection order: `--all --var GITHUB_TOKEN`
  // must not probe the same credential (and spawn the same lookup) twice.
  const selection: string[] = [];
  for (const v of [...(all ? discoverConfiguredCredentials(env) : []), ...named]) {
    if (!selection.includes(v)) selection.push(v);
  }

  const report = probeCredentials(selection, { ...opts, env });
  printJson(
    selection.length === 0
      ? {
          ...report,
          note:
            'no configured credential found — neither a non-blank <VAR>_CMD nor an ' +
            `ambient value is set for any of: ${KNOWN_CREDENTIAL_VARIABLES.join(', ')}. ` +
            'Nothing was probed; name one explicitly with --var <VAR> to assert it must resolve.',
        }
      : report,
  );

  if (!report.ok) {
    // The count and the variable names only — every detail already rode the
    // value-free JSON above.
    process.stderr.write(
      `error: credential-probe: ${report.failed.length} of ${report.probed.length} ` +
        `credential(s) failed to resolve: ${report.failed.join(', ')}\n`,
    );
    return 1;
  }
  return 0;
}

// Only execute when run directly (not when imported by tests).
if (require.main === module) {
  process.exit(runCredentialProbe(process.argv.slice(2)));
}
