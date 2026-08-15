/**
 * wave-config.ts — minimal store-selection config slice.
 *
 * A thin config type + reader for choosing which IssueStore implementation to
 * use. Later P7.1 tasks extend this with wave-level options (schema, eligibility
 * overrides, etc.). Loaded from a JSON file; validated at read-time so callers
 * get a clear error rather than a runtime cast failure deep in the engine.
 */

import { readFileSync } from 'node:fs';
import type { VerifyConfig } from './verify';
import { normalizeDisposableNames } from './worktree-cleanup';
// The container vocabulary the Goal facet OWNS, imported rather than re-spelled
// — see the `store.goal.container` block below for why a hand-copied second
// union here would be a defect rather than a convenience. TYPE-ONLY, so it is
// erased at runtime and adds no module edge in either direction.
import type { GoalContainer } from './adapters/issue-store';

// ── the Goal container binding: `store.goal.container` (ADR-0044 decision 4) ──
//
// The one SETUP-TIME fact the Goal facet needs: which native container role a
// goal is realized as on this consumer's tracker. It is declared on the STORE
// config because that is where the tracker itself is chosen, and it is read
// exactly once, at the CLI edge (`readGoalContainer`, cli-store.ts) — so no
// store carries it as construction state and `buildStore`'s contract is
// untouched by the facet existing.
//
// TYPED, not a passthrough. The key shipped with the facet as a structural read
// off the parsed JSON. That worked end-to-end, but it left `wave.config.json`'s
// schema — a SEMVER CONTRACT — silent about a key the engine acts on, which is
// the one thing a contract may not be. Declaring it is strictly ADDITIVE: the
// field is optional on all three variants, so a config carrying no `goal` key
// parses, validates and reads back exactly as it did before the field existed.
// That is what makes this a MINOR, the same ruling `engine` (ADR-0032) and
// `cleanup` took at their own introductions.
//
// The type is the ADAPTER-OWNED {@link GoalContainer} union, imported. A second,
// hand-copied `'milestone' | 'project' | …` spelled here could silently
// disagree with `GOAL_CONTAINERS` and with the refusal ladder that applies it —
// the parallel-rule drift class this repo closes systematically, and the reason
// ADR-0037 permits an engine module to import an adapter-owned canonical fact
// rather than re-spell it. There is no cycle to weigh here: the import is
// type-only, and `adapters/issue-store.ts` imports `contract.ts` and
// `goal-frontier.ts` and nothing else, so no edge points back.
//
// TYPING IS NOT VALIDATION, and deliberately does not become it. `loadWaveConfig`
// does NOT check the role. The refusal ladder — `unbound` / `unknown-container`
// / `unrealized-container` — stays exactly where the facet put it, store-side
// behind `parseGoalContainer` + `requireGoalContainer`, because only a STORE
// knows which roles it realizes and whether an ABSENT binding is fatal (GitHub
// and MarkdownFs default; Linear refuses). A second check here would be a
// lookalike of that ladder, free to disagree with it — precisely what the
// imported union above exists to prevent one line up. So the type buys the
// compile-time half and a named place in the schema; the runtime half is
// unchanged, and `readGoalContainer` still re-checks what it reads, because
// JSON arrives untyped whatever the interface says.

export interface MarkdownStoreConfig {
  kind: 'markdown';
  repoRoot: string;
  slug: string;
  eligibility?: string[];
  /**
   * The Goal container role this consumer binds (ADR-0044) — see the block
   * above. MarkdownFs realizes `goal-file` and defaults to it, so an absent
   * binding is the ordinary case here rather than a refusal.
   */
  goal?: { container?: GoalContainer };
}

export interface GitHubStoreConfig {
  kind: 'github';
  eligibility?: string[];
  /**
   * The Goal container role this consumer binds (ADR-0044) — see the block
   * above. GitHub realizes `milestone` and defaults to it (its only native
   * container with direct issue membership), so an absent binding is the
   * ordinary case; declaring anything else is refused as `unrealized-container`.
   */
  goal?: { container?: GoalContainer };
}

export interface LinearStateMapConfig {
  queued?: string;    // default 'Todo'
  inFlight?: string;  // default 'In Progress'
  inReview?: string;  // default 'In Review'
  /**
   * Optional opt-in fallback done-state name. NO default — leave unset (the
   * recommended mode) and `done` stays fully DERIVED from the tracker's own
   * closing signal (ADR-0002/0020). Set this only for a consumer workspace with
   * NO Linear↔GitHub integration: it lets the close path force a transition to
   * this workflow state once the wave itself has confirmed the PR merged, since
   * the tracker's own probe can never see it otherwise (FOR-13).
   */
  doneState?: string;
}

export interface LinearStoreConfig {
  kind: 'linear';
  /** Linear team key or name — owns the workflow states + label namespace. Required. */
  team: string;
  /** Optional project name — the listOpen candidate filter (ADR-0020). */
  project?: string;
  eligibility?: string[];
  /** Claim-rung → workflow-state-name mapping (defaults per ADR-0020). */
  states?: LinearStateMapConfig;
  /** Schema-category → existing consumer label (e.g. {"bug":"Bug"}). */
  categoryLabels?: Record<string, string>;
  /**
   * The Goal container role this consumer binds (ADR-0044) — see the block
   * above {@link MarkdownStoreConfig}. Linear is the one store with NO default:
   * live consumer conventions disagree about what a Linear project MEANS, so an
   * absent binding is refused as `unbound` rather than guessed at, and this is
   * the key that answers it.
   */
  goal?: { container?: GoalContainer };
}

export type StoreConfig = MarkdownStoreConfig | GitHubStoreConfig | LinearStoreConfig;

/**
 * Optional worktree-cleanup options (issue #115). Everything here is additive:
 * omit the whole `cleanup` key and cleanup behaves exactly as it did before it
 * existed.
 */
export interface CleanupConfig {
  /**
   * Extra directory/file names this consumer's own toolchain leaves inside an
   * agent worktree and considers disposable — `.build` (Swift), `target`
   * (Rust/Maven), `node_modules`, `__pycache__`, …
   *
   * The engine's built-in disposable set knows only the junk flotilla's own
   * harness and editors produce, so an orphaned worktree directory holding
   * nothing but a consumer's build output is refused as
   * `orphan-with-real-files` and has to be removed by hand. Declaring the names
   * here closes that: they are UNIONED with the built-in set, never a
   * replacement.
   *
   * EXACT entry names only, matched at any depth. A glob/pattern, a path, `.`,
   * `..` or `.git` is rejected at load time rather than honoured — a wildcard
   * such as `.*` would also match `.git`, which is the exact failure the fixed
   * built-in list exists to prevent.
   */
  disposableNames?: string[];
  /**
   * ADDITIONAL containment roots for the detached-scratchpad sweep
   * (`worktree-cleanup --detached`), absolute or repo-root-relative — the
   * config-side declaration of the engine's
   * `DetachedSweepOptions.extraRoots`. UNIONED with the marker-derived
   * worktrees root(s), never a replacement.
   *
   * WHY THIS KEY EXISTS. The engine option it feeds had documented itself
   * since the sweep landed as *the* way for a consumer whose agents make their
   * scratch checkouts somewhere other than the worktrees root to have them
   * swept — but it was reachable from the LIBRARY API only. The configured
   * path — the `worktree-cleanup --detached --config <path>` invocation
   * wave-close's phase 3 actually runs — had no key to declare such a root
   * with, so an out-of-root detached scratch checkout stayed registered
   * indefinitely: counted by the `worktreeCount` E2BIG advisory, selected by
   * nothing, with both `detached` arrays empty. Reported by the first
   * installed-form consumer and reproduced on `main`.
   *
   * The conservative default is UNCHANGED: no declaration → an out-of-root
   * checkout is left strictly alone, exactly as before this key existed.
   * Declaring a root widens ONLY the containment test — every other refusal
   * the sweep makes (a live branch, a dirty worktree, a locked one, an orphan
   * holding real files) still holds inside a declared root, which is what
   * keeps the widening bounded.
   *
   * A path, not a name — the mirror image of `disposableNames` above, and the
   * reason the two keys have separate validators rather than one shared rule:
   * a containment root IS a location, so `/` is meaningful here and refused
   * there. Rejected at load time: a non-array, a non-string entry, an
   * empty/whitespace-only entry, and a `~`-rooted path (nothing expands `~`
   * here, so it would silently resolve to a literal `~` directory under the
   * repo root — a declaration that can only ever mean something other than
   * what its author wrote).
   */
  extraRoots?: string[];
}

/**
 * Validate a consumer-declared `cleanup.extraRoots` list — the containment
 * roots the detached-scratchpad sweep unions with its marker-derived ones.
 *
 * Deliberately module-private and deliberately NOT
 * {@link normalizeDisposableNames}: these two keys carry OPPOSITE rules. A
 * disposable name is a bare entry name matched at any depth, so a `/` in it is
 * an error; an extra root is a LOCATION, so `/` is the ordinary case and an
 * absolute path is explicitly supported. Folding them into one validator would
 * mean one of the two rules stops being enforced.
 *
 * The enforcement point is the CONFIG boundary, and only there, because that is
 * the only boundary where the value arrives untyped: `DetachedSweepOptions`
 * types `extraRoots` as `readonly string[]`, so a direct library caller is
 * already held to the array-of-strings shape by `tsc`, and the sweep's own
 * resolution (trim, resolve against the repo root, realpath-normalize) is
 * unchanged by this key existing. That is why this validator does not also run
 * inside the engine the way `normalizeDisposableNames` does — there, the rule
 * (no globs, no paths, never `.git`) is a SEMANTIC one no type can express, and
 * a bad name reaching a filesystem decision could delete the wrong thing.
 *
 * `undefined`/`null` are "nothing declared" — what keeps an absent key a no-op.
 *
 * @param value The raw config value, unvalidated.
 * @param label How to name the offending field in a thrown message.
 */
function validateExtraRoots(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of paths`);
  }

  for (let i = 0; i < value.length; i++) {
    const raw: unknown = value[i];
    if (typeof raw !== 'string') {
      throw new Error(`${label}[${i}] must be a string`);
    }
    const path = raw.trim();
    if (path.length === 0) {
      throw new Error(
        `${label}[${i}] must be a non-empty path — omit the entry entirely rather than declaring an empty one, which would resolve to the repo root itself`,
      );
    }
    if (path[0] === '~') {
      throw new Error(
        `${label}[${i}] ${JSON.stringify(raw)} is home-rooted — nothing expands "~" here, so it would resolve to a literal "~" directory under the repo root. Declare an absolute path, or one relative to the repo root.`,
      );
    }
  }
}

/**
 * The engine-invocation binding (ADR-0032) — the `engine` key of
 * `wave.config.json`.
 *
 * ONE authoritative command string per repo, authored once at setup time and
 * read host-side when a brief is composed. Deliberately not a list, and
 * deliberately not a runtime fallback chain: on wave
 * `2026-07-29-publish-prep-and-guards` a documented dual-form invocation
 * degraded to its fallback on 5 of 7 rows without anyone deciding that, and the
 * documented default was operationally dead for weeks before anyone noticed. So
 * a configured form that fails is a STOP/needs-attention finding — a broken
 * install, config or release — never a cue to try another form.
 *
 * ABSENT is valid at the ENGINE level: an unbound config still loads. What an
 * absent binding means operationally is the consuming skills' decision, not the
 * engine's. PRESENT-BUT-MALFORMED is emphatically not valid — *configured means
 * authoritative* (the ADR-0029 principle) only holds if a malformed binding
 * fails loud instead of quietly collapsing back to unbound, which would
 * reproduce the exact silent-divergence failure ADR-0032 exists to end.
 */
export interface EngineConfig {
  /**
   * The command that invokes the engine CLI, as a plain space-separated argv
   * word list — `./node_modules/.bin/flotilla-engine` for a consumer on the
   * installed form, `./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts`
   * for flotilla itself on the source form.
   *
   * Repo-relative by construction. The tracked permission allowlist an AFK
   * Worker's worktree inherits can only carry repo-relative prefixes, so an
   * absolute or `~`-rooted command is refused outright — either would stall
   * every dispatched row at the permission gate — the same structural
   * objection that ruled out the plugin-clone as a CLI provider (ADR-0032,
   * Considered Options).
   *
   * Validated by {@link normalizeEngineCli}.
   */
  cli?: string;
}

/**
 * Why an `engine.cli` binding was rejected. Present-but-invalid only — an
 * absent binding is not a failure, it is the unbound case.
 */
export type EngineCliBindingFailure =
  /** Present, but not a JSON string (a number, an object, `null`, …). */
  | 'not-a-string'
  /** A string, but empty or whitespace-only — nothing to invoke. */
  | 'empty'
  /**
   * A non-empty string that is not a plain argv word list: it carries a
   * character outside the accepted set — a shell metacharacter, a control
   * character, or an expansion sigil.
   */
  | 'not-plain-argv'
  /**
   * A non-empty, plain-argv string whose FIRST character is `/` — a
   * leading-slash absolute path. `/` stays allowed everywhere else in the
   * word list (every repo-relative form uses it: `./node_modules/.bin/…`),
   * so this is checked separately from `not-plain-argv` rather than folded
   * into the character allow-list.
   */
  | 'absolute-path';

/**
 * The typed `engine.cli` failure (ADR-0032, applying the ADR-0029 fail-loud
 * principle). It names the field so a caller can render an actionable message
 * without string-matching, and carries the offending value: unlike a credential
 * lookup, the binding is a repo-relative command from TRACKED config — a
 * pointer, never a secret — so echoing it is safe and is the whole point of the
 * message.
 */
export class EngineCliBindingError extends Error {
  readonly name = 'EngineCliBindingError';
  readonly code = 'engine-cli-binding-invalid';
  /** The config field this failure is about — always the dotted path. */
  readonly field = 'engine.cli';
  constructor(
    /** Which of the present-but-invalid shapes this is. */
    readonly failure: EngineCliBindingFailure,
    /**
     * The offending configured value AS AUTHORED (untrimmed), when it was a
     * string at all — so a caller can show the author their own bytes.
     */
    readonly configured: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Characters an `engine.cli` word list may carry, as a NEGATED class: ASCII
 * letters/digits, the space that separates argv words, and the punctuation real
 * commands need — `_ . / : @ = + , -` (repo-relative paths, scoped package
 * names, `--flag=value`, `VAR=value` prefixes).
 *
 * An ALLOW-list rather than a deny-list of shell metacharacters, on purpose: a
 * deny-list is only as good as its author's memory of `sh` grammar, and the one
 * it forgets is the one that ships. Everything else is refused — the operators
 * and expansions (`| & ; < > ( ) $ \` \\ ! #`), the quotes, the globs
 * (`* ? [ ] { }`), every control character including a newline (which a
 * whitespace-split would silently swallow as just another separator), and every
 * non-ASCII character (an invisible U+2060-class codepoint in a command string
 * is unreadable at review time and unrunnable at dispatch time).
 *
 * `~` is refused with the rest: a home-rooted command is machine-specific, and
 * ADR-0032 requires a repo-relative one so the tracked allowlist can carry it.
 *
 * `/` stays in the allow-list — every repo-relative form needs it
 * (`./node_modules/.bin/flotilla-engine`) — so this class cannot also be
 * where a leading-slash ABSOLUTE path is refused: the class has no notion of
 * position, only membership. That refusal is a dedicated first-character
 * check in {@link normalizeEngineCli}, applied before this one.
 */
const ENGINE_CLI_FORBIDDEN_CHAR = /[^ A-Za-z0-9_.\/:@=+,-]/;

/**
 * Validate + normalize an `engine.cli` binding, returning the trimmed command
 * or `undefined` when the binding is absent.
 *
 * The rule this applies is the SAME one a consumer should apply when it authors
 * a binding, which is why it is exported and re-exported from the package root
 * rather than left module-private: `wave-setup` writes the value, `config
 * validate` gates it, and a host-side brief composer reads it — one rule, one
 * implementation.
 *
 * @param value the raw `engine.cli` value straight out of the parsed config
 * @param label how to name the field in the thrown message
 * @throws EngineCliBindingError when the binding is present but unusable
 */
export function normalizeEngineCli(
  value: unknown,
  label = 'wave config "engine.cli"',
): string | undefined {
  // Absent means UNBOUND, and unbound is valid here. The engine has no opinion
  // about what a consumer should do without a binding — the consuming skills
  // own that STOP (ADR-0032).
  if (value === undefined) return undefined;

  if (typeof value !== 'string') {
    // `null` lands here deliberately, and is NOT treated as absent the way
    // `cleanup.disposableNames` treats it. A JSON `null` is something an author
    // wrote down; silently reading it as "unbound" is precisely the quiet
    // degradation this field exists to abolish.
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
    throw new EngineCliBindingError(
      'not-a-string',
      undefined,
      `${label} must be a command string — got ${got}. A configured binding is authoritative, so a malformed one fails here rather than being read as unbound.`,
    );
  }

  const cli = value.trim();
  if (cli.length === 0) {
    throw new EngineCliBindingError(
      'empty',
      value,
      `${label} must be a non-empty command string — an empty binding is not "unbound", it is a binding that cannot be invoked. Omit the key entirely to leave the engine unbound.`,
    );
  }

  if (cli[0] === '/') {
    // Leading-slash ABSOLUTE path — refused the same loud, typed way a
    // `~`-rooted path already is (ADR-0032's Considered-Options text frames
    // `engine.cli` as repo-relative, non-machine-specific, the exact ground
    // the plugin-clone option was rejected on). Checked ahead of the
    // character allow-list because `/` stays accepted everywhere else in the
    // word list — this rule is about POSITION, not membership, so the
    // negated-class regex above cannot express it.
    throw new EngineCliBindingError(
      'absolute-path',
      value,
      `${label} ${JSON.stringify(cli)} starts with ${JSON.stringify('/')} at index 0 — the binding must be repo-relative (ADR-0032), not a machine-specific absolute path; the tracked permission allowlist an AFK Worker's worktree inherits can only carry repo-relative prefixes. Use a repo-relative command such as "./node_modules/.bin/flotilla-engine".`,
    );
  }

  const offending = ENGINE_CLI_FORBIDDEN_CHAR.exec(cli);
  if (offending) {
    // The message quotes the TRIMMED command, not the raw one, so the quoted
    // string and the index agree — an index counted against the trimmed value
    // but printed beside the raw one would point at the wrong character for any
    // binding with leading whitespace. `configured` still carries what the
    // author actually wrote.
    throw new EngineCliBindingError(
      'not-plain-argv',
      value,
      `${label} ${JSON.stringify(cli)} carries ${JSON.stringify(offending[0])} at index ${offending.index} — the binding is a plain space-separated argv word list, not a shell line, so shell metacharacters, expansions, globs, quotes, control characters and non-ASCII characters are all refused. Use a repo-relative command such as "./node_modules/.bin/flotilla-engine".`,
    );
  }

  return cli;
}

export interface WaveConfig {
  store: StoreConfig;
  /** Optional inline verify profile (ADR-0016). No DEFAULT_VERIFY — verify is purely consumer config. */
  verify?: VerifyConfig;
  /** Optional worktree-cleanup options (issue #115) — omit entirely for today's behaviour. */
  cleanup?: CleanupConfig;
  /**
   * Optional engine-invocation binding (ADR-0032). Additive: omit the whole
   * `engine` key and every existing consumer config keeps validating exactly as
   * it did before the field existed.
   */
  engine?: EngineConfig;
}

/**
 * Read + JSON-parse a wave config file. Throws with a clear message if the
 * `store` object is missing/null, or if `store.kind` is not a known
 * discriminant, so the consumer never receives a config it cannot act on.
 *
 * `cleanup.disposableNames` (issue #115) is validated here too, through the
 * engine's own {@link normalizeDisposableNames} — the SAME rule the cleanup
 * module applies when the names reach it — so a glob or a path fails loud at
 * `config validate` time rather than silently at cleanup time.
 *
 * `cleanup.extraRoots` is validated beside it via {@link validateExtraRoots},
 * on the same fail-loud-at-author-time principle. Both keys are optional and
 * both additions to this schema have been strictly additive: no key here has
 * ever been renamed, removed or re-typed, which is what lets an existing
 * consumer config keep validating unchanged (the `wave.config` schema is a
 * semver contract). `store.goal.container` (ADR-0044) joins that list as the
 * newest additive optional key — and is the one addition this function
 * deliberately does NOT validate: its refusal ladder is store-side, for the
 * reason spelled out above {@link MarkdownStoreConfig}. The key survives the
 * load verbatim, which is exactly what `readGoalContainer` (cli-store.ts) then
 * re-checks.
 */
export function loadWaveConfig(path: string): WaveConfig {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || !('store' in raw) || !(raw as { store?: unknown }).store || typeof (raw as { store?: unknown }).store !== 'object') {
    throw new Error('wave config must have a "store" object');
  }
  const kind = ((raw as { store: { kind?: unknown } }).store).kind;
  if (kind !== 'markdown' && kind !== 'github' && kind !== 'linear') {
    throw new Error(`unknown store kind: ${String(kind)}`);
  }

  // Validate linear-specific requirements
  if (kind === 'linear') {
    const team = ((raw as { store: { team?: unknown } }).store).team;
    if (!team || typeof team !== 'string' || team.trim().length === 0) {
      throw new Error('linear store config requires a "team" string');
    }
  }
  const verify = (raw as { verify?: unknown }).verify;
  if (verify !== undefined) {
    if (!verify || typeof verify !== 'object' || !Array.isArray((verify as { profiles?: unknown }).profiles)) {
      throw new Error('wave config "verify" must have a "profiles" array');
    }
  }

  // issue #115 — the consumer-declared disposable set. Absent `cleanup` is the
  // default and is validated as nothing; a present one must be an object, and
  // its `disposableNames` must survive the engine's own exact-names rule.
  //
  // `extraRoots` (the detached sweep's declarable containment roots) is
  // validated beside it under the same rule of engagement — a bad declaration
  // fails loud HERE, at `config validate` time, rather than silently at cleanup
  // time — and by its own validator, because the two keys' rules are opposites
  // (see {@link validateExtraRoots}). Both are validation only: neither writes
  // a normalized value back, since every reader below already trims what it
  // reads.
  const cleanup = (raw as { cleanup?: unknown }).cleanup;
  if (cleanup !== undefined) {
    if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
      throw new Error('wave config "cleanup" must be an object');
    }
    normalizeDisposableNames(
      (cleanup as { disposableNames?: unknown }).disposableNames,
      'wave config "cleanup.disposableNames"',
    );
    validateExtraRoots(
      (cleanup as { extraRoots?: unknown }).extraRoots,
      'wave config "cleanup.extraRoots"',
    );
  }

  // ADR-0032 — the engine-invocation binding. Absent `engine` is valid and
  // means unbound; a present one must be an object, and its `cli` must survive
  // the plain-argv rule in {@link normalizeEngineCli}.
  const engine = (raw as { engine?: unknown }).engine;
  if (engine !== undefined) {
    if (!engine || typeof engine !== 'object' || Array.isArray(engine)) {
      throw new Error('wave config "engine" must be an object');
    }
    const cli = normalizeEngineCli((engine as { cli?: unknown }).cli);
    // Hand the caller the NORMALIZED command, not the raw one. `raw` is a fresh
    // JSON.parse result owned by this function, so writing the trimmed value
    // back mutates nothing the caller can also see, and it means every reader
    // of `config.engine.cli` — `config validate`'s report, a host-side brief
    // composer — gets the exact string that will be invoked.
    if (cli !== undefined) (engine as { cli?: string }).cli = cli;
  }

  return raw as WaveConfig;
}
