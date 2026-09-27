/**
 * verify.ts — the VerifyGate config function (CHARTER §VerifyGate, M1-PRD §2e).
 *
 * `verifyCommands(changedFiles, config)` selects the build/test/lint commands to
 * run, by matching changed files against per-profile globs. Profiles: nx / npm /
 * composer / none — a consumer declares its own; a file matching no profile
 * verifies to `none` (empty). VerifyGate output feeds BOTH the worker brief AND
 * the reviewer's independent re-run (worker-report drift is failure-mode #1).
 */

import micromatch from 'micromatch';

/**
 * What a {@link VerifyCommand} NEEDS from the sandbox it runs in, so it can run
 * at all (ADR-0049). A **requirement class**, never a harness knob: the engine
 * learns the *need*, and the skill tier translates that need into whatever
 * binding the harness in front of it actually has. That split is what keeps the
 * engine harness-agnostic (ADR-0009) — a boolean `unsandboxed` was rejected for
 * the opposite reason, it would put one harness's knob in the engine and force
 * the broadest possible translation every time.
 *
 * The set is CLOSED at three, each naming one sandbox dimension:
 *
 * - `writes` — paths the command must write OUTSIDE the worktree (a shared
 *   build cache, a derived-data directory, a simulator's own tree).
 * - `network` — hosts the command must reach.
 * - `host` — literally `true`: the class that cannot be narrowed to a path or
 *   a host at all (a daemon socket, a simulator, a physical device).
 *
 * `config validate` refuses any other key and any other value shape, naming
 * the closed set (see `loadWaveConfig` in `wave-config.ts`, which owns every
 * refusal about `verify`'s shape — this module owns the type, that one owns
 * the rule, exactly as it already does for `verify.profiles`).
 *
 * Declaring a need is NOT the same as being granted it. Setup provides what it
 * can (`writes`/`network` into the tracked sandbox block; `host` operator-local
 * only, because a tracked command exclusion is a host-escape for every future
 * agent of the repo). What a declaration buys unconditionally is honesty: a
 * command refused for a capability reason is reported as not run, with the
 * reason, and the Reviewer defers the acceptance criteria it would have backed
 * as `capability-gated` — it is never re-run with the sandbox off.
 *
 * **Named rather than inline (issue #724).** It shipped as an anonymous shape on
 * `VerifyCommand.needs` for a PLACEMENT reason, not a design one: the row that
 * introduced it (ADR-0049) owned neither the package-root barrel (`index.ts`)
 * nor the drift guard (`barrel-drift.spec.ts`), and that guard fails ANY new
 * module export whose barrel entry does not move in the same diff — so the only
 * in-glob move available to that row was to leave the shape unexported and tell
 * consumers to spell it `NonNullable<VerifyCommand['needs']>`. This row owns the
 * barrel, so the promotion happens here. Strictly ADDITIVE (Minor, ADR-0035):
 * the indexed spelling still resolves to exactly this declaration — verify.spec
 * pins the two forms as the SAME type with a type-level identity assertion — so
 * no existing consumer annotation changes meaning, and nothing on the value side
 * moves at all.
 */
export interface VerifyCommandNeeds {
  /** Paths this command must write OUTSIDE the worktree. Non-empty when present. */
  writes?: string[];
  /** Hosts this command must reach. Non-empty when present. */
  network?: string[];
  /** The un-narrowable class — a daemon socket, a simulator, a device. Literally `true`. */
  host?: true;
}

export interface VerifyCommand {
  /** Working directory relative to the repo root (e.g. `cms`); omit for root. */
  cwd?: string;
  /** The shell command to run. */
  command: string;
  /**
   * What this command NEEDS from the sandbox it runs in, so it can run at all
   * (ADR-0049) — see {@link VerifyCommandNeeds} for the closed set of three and
   * for why a declaration is never a grant.
   *
   * **Optional, and additive.** A config that carries no `needs` anywhere loads,
   * selects and composes byte-identically to how it did before this field
   * existed.
   */
  needs?: VerifyCommandNeeds;
  /**
   * **Environment notes** (ADR-0049 Amendment 2026-09-27): observed facts about
   * how THIS command behaves inside the sandbox a dispatched agent runs it in —
   * a toolchain that exits 1 without output, a browser that will not start.
   * Operator-authored, beside {@link needs}: `needs` is the capability half
   * (what the command must reach), a note is the knowledge half (how it
   * behaves once it runs). A note grants nothing, withholds nothing and changes
   * no gate's outcome — it explains a failure, it never excuses one.
   *
   * **Bounded at load**: at most three notes, each a non-empty string of at
   * most 200 characters (`loadWaveConfig` in `wave-config.ts` owns the
   * refusal, exactly as it owns `needs`'). Every brief clause is paid per
   * dispatch (ADR-0034), and the bound keeps a consumer's troubleshooting
   * document from moving into the brief wholesale.
   *
   * **Optional, and additive.** A config that carries no notes anywhere loads,
   * selects and composes byte-identically to how it did before this field
   * existed. Like `needs`, it is passed through {@link verifyCommands}
   * verbatim and is not part of the de-duplication key.
   */
  environmentNotes?: string[];
}

export interface VerifyProfile {
  name: string;
  /** Globs (micromatch) — the profile fires if ANY changed file matches. */
  appliesTo: string[];
  commands: VerifyCommand[];
}

export interface VerifyConfig {
  profiles: VerifyProfile[];
}

/**
 * The one character that separates the two halves of a de-duplication key.
 *
 * **Printable, deliberately (issue #724).** It used to be a literal NUL
 * byte, chosen because no `cwd` and no `command` can contain one, so the
 * concatenation was injective for free. The cost was paid by every reader of
 * this file rather than by the code: one control byte anywhere in a file makes
 * git treat the whole file as BINARY, so `git diff tools/wave/src/verify.ts`
 * printed `Binary files differ` and a reviewer had to know to reach for
 * `git diff --text`. A module this small, this central and this often-reviewed
 * is the wrong place to spend that.
 *
 * Injectivity is now bought by {@link deduplicationKey}'s LENGTH PREFIX instead
 * of by an unspellable character, which is strictly stronger: the key stays
 * unambiguous even when the `cwd` or the `command` contains this very
 * character. A colon is a legal (and common) character in both halves — that is
 * precisely why the separator alone was never allowed to carry the argument.
 */
const KEY_SEPARATOR = ':';

/**
 * The de-duplication key for one command: `<cwd length><sep><cwd><sep><command>`.
 *
 * Injective by construction, and provably so without appealing to any character
 * being impossible: the digits up to the first separator give the exact length
 * of the `cwd`, so a reader consumes that many characters, skips one separator,
 * and everything that remains — separators included — is the command. Two
 * distinct `(cwd, command)` pairs therefore cannot share a key even when either
 * half contains {@link KEY_SEPARATOR}, which is the property the old NUL byte
 * provided by fiat and this provides by arithmetic.
 *
 * The classic near-miss this exists to rule out: `{ cwd: 'a:b', command: 'c' }`
 * and `{ cwd: 'a', command: 'b:c' }` both render as `a:b:c` under a plain
 * `cwd + sep + command` join, so one of two genuinely different verify commands
 * would silently vanish from the selection. Length-prefixed they are `3:a:b:c`
 * and `1:a:b:c`, and both survive.
 */
function deduplicationKey(cmd: VerifyCommand): string {
  const cwd = cmd.cwd ?? '';
  return `${cwd.length}${KEY_SEPARATOR}${cwd}${KEY_SEPARATOR}${cmd.command}`;
}

/**
 * The verify commands for a change-set: the de-duplicated union (in profile
 * order) of the commands of every profile that matches at least one changed
 * file. No match anywhere → `[]` (the `none` profile).
 *
 * Each selected command is passed through **verbatim**, `needs` and
 * `environmentNotes` included — this function selects, it never rewrites. The
 * de-duplication key stays `cwd + command` ({@link deduplicationKey}) and does
 * NOT include `needs` (nor the notes, by the same first-profile-wins rule), so
 * two profiles declaring the same command with different needs still collapse
 * to one entry and the FIRST profile's declaration wins. That is deliberate rather than merged: a merge
 * rule is a decision ADR-0049 does not make, and the under-declared case has a
 * designed landing already — the command is refused, reported as not run with
 * its reason, deferred as `capability-gated`, and the operator turns the
 * disclosure into a declaration the next wave carries (ADR-0049 decision 5, the
 * system learns one round late).
 */
export function verifyCommands(
  changedFiles: string[],
  config: VerifyConfig,
): VerifyCommand[] {
  const out: VerifyCommand[] = [];
  const seen = new Set<string>();
  for (const profile of config.profiles) {
    if (!changedFiles.some((f) => micromatch.isMatch(f, profile.appliesTo))) continue;
    for (const cmd of profile.commands) {
      const key = deduplicationKey(cmd);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cmd);
    }
  }
  return out;
}
