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
 *
 * ADR-0051 added the {@link VerbContract} overload of `flag()`. The exact
 * `indexOf` form below is what an ALIAS cannot travel through: `--iteration`
 * and `--iter` were two spellings of one axis, and only the verb that happened
 * to spell it one way could read it. Passing a contract resolves every accepted
 * spelling of one canonical flag — so a rename is a contract edit, not a
 * search-and-replace across the runners.
 */

import {
  allValuesOf,
  firstValueOf,
  type VerbContract,
} from './verb-contract';

/**
 * Find the value of a named flag in an args array, or undefined.
 *
 * Two forms:
 *
 *   - `flag(args, '--config')` — the EXACT form. One spelling, `indexOf`,
 *     no alias resolution. Still correct for a flag whose contract declares no
 *     aliases, and it is what every pre-ADR-0051 call site spells.
 *   - `flag(args, CONTRACT, 'iter')` — the CONTRACT form (ADR-0051 decision 2).
 *     Resolves `iter` to the contract's canonical `--iter` and then finds
 *     whichever accepted spelling the caller actually typed (`--iter`,
 *     `--iteration`, …), scanning left to right and stepping over the VALUE of
 *     every value-taking flag, so `--text "--iter"` is never mistaken for the
 *     flag itself. The name may be given bare (`'iter'`) or dashed (`'--iter'`).
 */
export function flag(args: string[], name: string): string | undefined;
export function flag(
  args: string[],
  contract: VerbContract,
  name: string,
): string | undefined;
export function flag(
  args: string[],
  nameOrContract: string | VerbContract,
  name?: string,
): string | undefined {
  if (typeof nameOrContract !== 'string') {
    return firstValueOf(nameOrContract, args, name as string);
  }
  const idx = args.indexOf(nameOrContract);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/**
 * EVERY value of a repeatable flag, under any accepted spelling, in argv order
 * ({@link flag} returns only the first).
 *
 * The contract form is the only one offered: a repeatable flag is exactly the
 * shape whose hand-rolled loops drifted (issue-store-cli's `flagAll`,
 * conflict-map-cli's `partitionStoreArgs`, credential-probe-cli's `--var`
 * branch — three loops, three different ideas about what to do with a missing
 * value token).
 */
export function flagAll(
  args: string[],
  contract: VerbContract,
  name: string,
): string[] {
  return allValuesOf(contract, args, name);
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
