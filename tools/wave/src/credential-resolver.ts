/**
 * credential-resolver.ts — the ONE engine-owned credential seam (ADR-0029).
 *
 * Every edge that needs a secret — the github store factory, the linear store
 * factory, and the `host-pr` create/preflight edge — asks this module, and this
 * module is the only place in the engine that knows where a secret can come
 * from. Before ADR-0029 each edge read its own ambient variable; those copies
 * are gone, because a per-edge copy is exactly how a precedence rule drifts.
 *
 * ## The contract, in one paragraph
 *
 * A credential is named by its AMBIENT variable (`GITHUB_TOKEN`,
 * `LINEAR_API_KEY`). Its command counterpart is mechanically `<VAR>_CMD` (see
 * {@link commandVariableFor}) — so every future store adapter inherits the
 * naming for free, and the precedence rule is statable per pair: **`X_CMD` wins
 * over `X`**. When `<VAR>_CMD` carries a non-blank command, the engine spawns it
 * through the platform shell (`sh -c` on POSIX), bounded by
 * {@link CREDENTIAL_LOOKUP_TIMEOUT_MS}, and its stdout — trailing newlines
 * trimmed — IS the secret. When it does not, the ambient variable applies.
 *
 * ## Why the failure modes are loud
 *
 * A configured command that exits non-zero, times out, spawns at all, or prints
 * nothing is a typed {@link CredentialResolutionError} — never a silent fallback
 * to the ambient variable. Silent fallback re-opens the wrong-token class
 * invisibly: you believe you are running the repo-scoped credential and you are
 * actually running the over-broad one. An empty or whitespace-only `<VAR>_CMD`
 * is the ONE way back to the ambient path, and it is deliberate — the
 * per-environment escape hatch a CI job uses (`GITHUB_TOKEN_CMD=""`) when it
 * injects a per-job token into a minutes-lived environment with no keychain.
 *
 * ## Why nothing here can leak the secret
 *
 * Three structural properties, not three promises:
 *   1. The lookup's **stderr is never surfaced**. The spawn seam
 *      ({@link CredentialLookupSpawn}) has no stderr field at all — the default
 *      implementation pipes it (so it never reaches the parent's terminal) and
 *      drops it on the floor. There is no value to accidentally interpolate.
 *   2. The **error carries the command, never its output**. `command` is the
 *      configured string from the settings env block — a pointer, by design;
 *      `stdout` never reaches an error, a log line, or a thrown value.
 *   3. This module **writes nothing** — no `console`, no `process.stderr`, no
 *      file, no `process.env` mutation. Callers decide what to print, and every
 *      one of them prints only `.message`.
 *
 * Resolution is memoised per credential per process (ADR-0029: "once per
 * credential per process; nothing is persisted") — in memory only, for the
 * lifetime of the CLI invocation.
 */

import { spawnSync } from 'node:child_process';

/**
 * The lookup-command spawn budget: 60 seconds. A hung GUI prompt (a locked
 * keychain, an expired secret-manager session) fails LOUD instead of hanging a
 * wave — the AFK-posture requirement in ADR-0029.
 */
export const CREDENTIAL_LOOKUP_TIMEOUT_MS = 60_000;

/**
 * The mechanical naming rule, in one place: whatever ambient variable an adapter
 * reads, `<VAR>_CMD` is its command counterpart. `GITHUB_TOKEN` →
 * `GITHUB_TOKEN_CMD`; `LINEAR_API_KEY` → `LINEAR_API_KEY_CMD`.
 */
export function commandVariableFor(variable: string): string {
  return `${variable}_CMD`;
}

/** Why a credential could not be resolved. Machine-readable; never carries output. */
export type CredentialFailure =
  /** No `<VAR>_CMD` command and no ambient `<VAR>` — nothing to resolve from. */
  | 'not-configured'
  /** The configured command ran and exited non-zero. */
  | 'lookup-exit'
  /** The configured command exceeded {@link CREDENTIAL_LOOKUP_TIMEOUT_MS}. */
  | 'lookup-timeout'
  /** The configured command exited 0 but printed nothing usable on stdout. */
  | 'lookup-empty'
  /** The configured command could not be spawned at all (no shell, EACCES, …). */
  | 'lookup-spawn-error';

/**
 * The typed credential failure (ADR-0029). It names the CONFIGURED COMMAND (a
 * pointer that travels in tracked settings) and never its stdout or stderr —
 * the whole point of the indirection is that the pointer is safe to print and
 * the output is not. There is deliberately no `stdout`/`stderr` field: a field
 * that does not exist cannot be logged by a caller.
 */
export class CredentialResolutionError extends Error {
  readonly name = 'CredentialResolutionError';
  readonly code = 'credential-resolution-failed';
  constructor(
    /** The ambient variable name the credential is known by (e.g. `GITHUB_TOKEN`). */
    readonly variable: string,
    /** Which failure mode this is. */
    readonly failure: CredentialFailure,
    /** The configured lookup command, when one was configured. Never its output. */
    readonly command: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What a lookup spawn reports back. Note what is ABSENT: stderr. The seam cannot
 * hand the child's stderr to the resolver, so the resolver cannot leak it (the
 * default implementation pipes it and drops it — captured, never re-printed).
 */
export interface CredentialLookupResult {
  /** The command's raw stdout. Trailing newlines are trimmed by the resolver. */
  stdout: string;
  /** Exit status, or `null` when the process was killed (e.g. by the timeout). */
  status: number | null;
  /** Whether the {@link CREDENTIAL_LOOKUP_TIMEOUT_MS} budget killed it. */
  timedOut: boolean;
  /**
   * The errno CODE when the spawn itself failed (`ENOENT`, `EACCES`, …). A code,
   * never a message: a spawn error message can quote the command line, and a
   * quoted command line is the one string we are careful about.
   */
  spawnErrorCode?: string;
}

/** The spawn seam — real shell in production, a fixture in specs. */
export type CredentialLookupSpawn = (command: string, timeoutMs: number) => CredentialLookupResult;

/**
 * Spawn the lookup command through the PLATFORM SHELL (ADR-0029 rejected an
 * argv whitespace-split: it breaks the quoting real lookup tools need, e.g.
 * `op read "op://vault/item/field"`). stdin is closed, stdout is captured, and
 * stderr is captured-and-dropped — never inherited (it would print straight to
 * the operator's terminal), never returned (it cannot then be interpolated).
 */
export const defaultCredentialLookupSpawn: CredentialLookupSpawn = (command, timeoutMs) => {
  const onWindows = process.platform === 'win32';
  const shell = onWindows ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args = onWindows ? ['/d', '/s', '/c', command] : ['-c', command];

  const res = spawnSync(shell, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const err = res.error as NodeJS.ErrnoException | undefined;
  // Node reports a timeout kill as `error.code === 'ETIMEDOUT'` (with the child
  // signalled). Classify it FIRST — a timeout is its own diagnosis, not a
  // generic spawn failure.
  const timedOut = err !== undefined && err.code === 'ETIMEDOUT';

  return {
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    status: res.status,
    timedOut,
    ...(err !== undefined && !timedOut ? { spawnErrorCode: err.code ?? 'UNKNOWN' } : {}),
  };
};

/** Impure inputs for {@link resolveCredential}; production defaults all of them. */
export interface ResolveCredentialOptions {
  /** Environment to read `<VAR>` and `<VAR>_CMD` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable lookup spawn (specs). Defaults to {@link defaultCredentialLookupSpawn}. */
  spawn?: CredentialLookupSpawn;
  /**
   * What the credential is for, phrased to follow "…is required to " — it lands
   * in the not-configured message so the operator learns which edge asked.
   */
  purpose?: string;
}

/**
 * The once-per-credential-per-process memo (ADR-0029). In memory only, for the
 * lifetime of the CLI invocation: nothing is written to disk, to `process.env`,
 * or anywhere else.
 */
const memo = new Map<string, string>();

/**
 * Resolve one credential to its secret, or throw {@link CredentialResolutionError}.
 *
 * Precedence (ADR-0029): a non-blank `<VAR>_CMD` wins over a set `<VAR>` and
 * fails LOUD rather than falling back; a missing / empty / whitespace-only
 * `<VAR>_CMD` means "not configured", so the ambient `<VAR>` applies.
 *
 * @param variable - the ambient variable name (`GITHUB_TOKEN`, `LINEAR_API_KEY`).
 * @param opts - impure inputs; specs inject `env`/`spawn`, production defaults.
 * @returns the secret. Callers pass it straight to the auth header and never log it.
 */
export function resolveCredential(variable: string, opts: ResolveCredentialOptions = {}): string {
  // The memo covers the PRODUCTION path only (real `process.env`, real shell).
  // A caller-supplied env or spawn is a different world by construction, and
  // memoising across worlds would hand one world's answer to another.
  const memoizable = opts.env === undefined && opts.spawn === undefined;
  if (memoizable) {
    const hit = memo.get(variable);
    if (hit !== undefined) return hit;
  }
  const secret = resolveOnce(variable, opts);
  if (memoizable) memo.set(variable, secret);
  return secret;
}

function resolveOnce(variable: string, opts: ResolveCredentialOptions): string {
  const env = opts.env ?? process.env;
  const commandVariable = commandVariableFor(variable);

  // An empty or whitespace-only `_CMD` counts as NOT CONFIGURED — the deliberate
  // per-environment escape hatch back to the ambient path (ADR-0029).
  const command = (env[commandVariable] ?? '').trim();
  if (command.length > 0) {
    return runLookup(variable, commandVariable, command, opts.spawn ?? defaultCredentialLookupSpawn);
  }

  const ambient = env[variable];
  if (ambient === undefined || ambient.length === 0) {
    throw new CredentialResolutionError(
      variable,
      'not-configured',
      undefined,
      `${variable} is required to ${opts.purpose ?? 'run this command'}, and neither source is configured. ` +
        `Set ${commandVariable} to a lookup command that prints the secret on stdout (ADR-0029) — ` +
        `the per-project indirection — or export ${variable} directly (the ephemeral-environment path).`,
    );
  }
  return ambient;
}

/**
 * Run a configured lookup and turn it into a secret or a typed loud failure.
 * Every failure path names the command and NONE of them reaches for the ambient
 * variable: the fallback that would be convenient here is exactly the one
 * ADR-0029 rejected.
 */
function runLookup(
  variable: string,
  commandVariable: string,
  command: string,
  spawn: CredentialLookupSpawn,
): string {
  const result = spawn(command, CREDENTIAL_LOOKUP_TIMEOUT_MS);
  const neverFallsBack =
    `The credential was NOT resolved, and ${variable} is never used as a fallback (ADR-0029). ` +
    `The command's own output is deliberately not reported — it would be the secret.`;

  if (result.timedOut) {
    throw new CredentialResolutionError(
      variable,
      'lookup-timeout',
      command,
      `${commandVariable} timed out after ${CREDENTIAL_LOOKUP_TIMEOUT_MS / 1000}s: \`${command}\`. ` +
        `A lookup that waits on a prompt is AFK-incompatible — it must resolve unattended. ${neverFallsBack}`,
    );
  }

  if (result.spawnErrorCode !== undefined) {
    throw new CredentialResolutionError(
      variable,
      'lookup-spawn-error',
      command,
      `${commandVariable} could not be spawned (${result.spawnErrorCode}): \`${command}\`. ${neverFallsBack}`,
    );
  }

  if (result.status !== 0) {
    throw new CredentialResolutionError(
      variable,
      'lookup-exit',
      command,
      `${commandVariable} exited ${result.status === null ? 'abnormally' : result.status}: \`${command}\`. ${neverFallsBack}`,
    );
  }

  // Trailing newlines only — a lookup tool ends its line (`security
  // find-generic-password -w`, `op read`), and that newline is not the secret.
  const secret = result.stdout.replace(/[\r\n]+$/, '');
  if (secret.trim().length === 0) {
    throw new CredentialResolutionError(
      variable,
      'lookup-empty',
      command,
      `${commandVariable} exited 0 but printed no secret on stdout: \`${command}\`. ` +
        `An empty secret is a failure, never a silent fallback. ${neverFallsBack}`,
    );
  }
  return secret;
}
