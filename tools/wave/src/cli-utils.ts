/**
 * cli-utils.ts — the tiny shared helpers every engine CLI runner uses.
 *
 * Extracted (P7.2.0) from the byte-identical `flag()` that had been copied into
 * cross-wave-cli / issue-store-cli / resume-cli, plus the identical pretty-JSON
 * stdout pattern. Each CLI keeps its OWN usage strings local; only these two
 * mechanical helpers are shared.
 *
 * {@link describeConfigLoadError} (issue #505) joined them for the same reason:
 * every `loadWaveConfig` call site in the CLI edge (`resolveStore`,
 * `runStorePreflight`, `dor --config`, `worktree-cleanup --config`, …) used to
 * let a missing file's raw `ENOENT: no such file or directory, open '...'`
 * reach the operator unmodified — informative to Node, not to the caller who
 * forgot `--config`. One transform, shared, so the teaching text cannot drift
 * per call site the way four independent catch blocks eventually would.
 */

/** Find the value of a named flag in an args array, or undefined. */
export function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/** Write a value to stdout as pretty (2-space) JSON with a trailing newline. */
export function printJson(x: unknown): void {
  process.stdout.write(JSON.stringify(x, null, 2) + '\n');
}

/**
 * Turn a `loadWaveConfig(configPath)` failure into a message that teaches the
 * fix, rather than surfacing Node's bare ENOENT verbatim (issue #505 — the
 * `triage-apply` without `--config` misfire: a bare fs error with no mention
 * of the flag that would have fixed it).
 *
 * Only the "the file genuinely does not exist" case (`ENOENT`) is rewritten.
 * Every OTHER `loadWaveConfig` failure — malformed JSON, an unknown
 * `store.kind`, a missing `linear` `team`, an invalid `verify`/`cleanup` shape
 * — already names its own fix in `err.message` and passes through unchanged;
 * rewriting those too would blunt a message that is already specific.
 *
 * `wasExplicit` distinguishes the two fixable mistakes a caller can make,
 * because one sentence cannot teach both: the DEFAULT `wave.config.json`
 * wasn't found in cwd (the fix is to pass `--config <path>`) vs. the
 * `--config <path>` the caller DID pass doesn't resolve (the fix is to check
 * that path — telling them to "pass --config" when they just did teaches
 * nothing).
 *
 * @param err - whatever `loadWaveConfig` (or the `readFileSync` inside it) threw
 * @param configPath - the path that was attempted (the caller's `--config`
 *   value, or the literal default `'wave.config.json'`)
 * @param wasExplicit - `true` iff the caller supplied `--config` themselves
 */
export function describeConfigLoadError(
  err: unknown,
  configPath: string,
  wasExplicit: boolean,
): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'ENOENT') return (err as Error).message ?? String(err);
  return wasExplicit
    ? `no config file found at "${configPath}" — check the --config path`
    : 'no wave.config.json in cwd — pass --config <path>';
}
