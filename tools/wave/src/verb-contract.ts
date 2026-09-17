/**
 * verb-contract.ts — what a verb accepts, declared once and read by four.
 *
 * ADR-0051. Before this module nothing declared what a verb accepts: `flag()`
 * was an exact `indexOf`, each runner knew its flags only implicitly, usage text
 * was hand-written in four places, four verbs refused unknown flags with four
 * private lists and the rest swallowed them silently — the class that fails with
 * a plausible spelling (`host-pr arm --pr`, issue #505).
 *
 * A **Verb contract** states, for ONE verb (or ONE op of a verb group):
 *
 *   - every flag it accepts, each with ONE canonical spelling, its aliases, the
 *     KIND of value it takes (`none` · `one` · `repeatable`), the TYPE of that
 *     value, and whether it is required;
 *   - its positional arity — `fixed` (n slots) or `variadic` (at least n);
 *   - its output class (`prose` · `json` · `silent-write` · `product`);
 *   - its own usage lines — the ONE verb's contract section, never the router's
 *     whole roster (issue #505's lesson).
 *
 * Four readers and nothing else know what a verb accepts: the parser
 * ({@link resolveFlagContract}, which `flag()` in cli-utils.ts resolves
 * through), the refusal ({@link checkUndeclared}), `--help`
 * ({@link helpRequested} + the contract's own `usage`), and — later — the
 * Catalog, which emits the contracts.
 *
 * ## Where a contract lives
 *
 * **Beside its runner, never in one central file** (ADR-0051 decision 2). Each
 * `*-cli.ts` module declares its own verbs' contracts; `cli.ts` declares the
 * verbs whose runners are in `cli.ts`; the router only COLLECTS them into the
 * aggregate `verbContracts()` reads. This module owns the TYPE and the
 * machinery, not the declarations.
 *
 * ## Why exit 2 and not a warning
 *
 * A stderr line is prose no Coordinator loop and no pulse reads, and a swallowed
 * flag is the false pass the gates already forbid. Exit 2 already MEANS usage on
 * the four verbs that refused before this module; nothing is re-meant.
 */

// ─── The type ────────────────────────────────────────────────────────────────

/**
 * How many values a flag consumes.
 *
 *   - `none`       — a boolean switch (`--dry-run`); the next token is NOT its value.
 *   - `one`        — takes the following token as its value (`--config <path>`).
 *   - `repeatable` — takes the following token, and may be given more than once
 *                    (`--id <id> --id <id>`, `--var <VAR> --var <VAR>`).
 */
export type FlagValueKind = 'none' | 'one' | 'repeatable';

/**
 * WHAT the value is. This is the half ADR-0051 decision 5 asserts over: "no
 * canonical spelling carries two value types across verbs". The measured
 * polymorphism it exists to forbid was `--verdict` — a file PATH on route-tuple,
 * an ENUM on route-verdict, in adjacent usage lines.
 *
 * Deliberately a small closed vocabulary rather than a free string: the drift
 * spec compares these across the whole aggregate, and two spellings of the same
 * idea ("dir" vs "directory") would make that comparison useless.
 */
export type FlagValueType =
  | 'none'
  | 'path'
  | 'dir'
  | 'id'
  | 'int'
  | 'text'
  | 'enum'
  | 'sha'
  | 'url'
  | 'branch'
  | 'version'
  | 'list'
  | 'json';

/** One flag of a verb: one canonical spelling, any number of silent aliases. */
export interface FlagContract {
  /** The ONE spelling `--help` and the Catalog print, and the skills are pinned to. */
  readonly canonical: string;
  /**
   * Accepted spellings that are NOT canonical. Silent (ADR-0051 decision 8): no
   * stderr note, no result field, and the word "deprecated" appears nowhere —
   * it would promise a removal this record does not date.
   */
  readonly aliases?: readonly string[];
  /** How many values it consumes. */
  readonly value: FlagValueKind;
  /** What that value IS — the axis decision 5's uniqueness rule runs over. */
  readonly valueType: FlagValueType;
  /** True when the verb refuses without it. Reporting only; runners still check. */
  readonly required?: boolean;
}

/**
 * How many positional arguments the verb takes.
 *
 * `fixed` names its slots so the refusal can say which one a stray token would
 * have been; `variadic` states the floor (`dor <path> [<path> ...]` is
 * `{ kind: 'variadic', min: 1 }`).
 *
 * `fixed.min` is how many of those slots the verb REQUIRES — `count` is the
 * ceiling the refusal measures against, `min` the floor a rendered usage line
 * reads to decide which slots are bracketed. It defaults to `count` (every slot
 * required) and is declared only where a slot is genuinely optional:
 * `worktree-cleanup [<repo-root>]` takes one slot and requires none, and
 * `spine add-disclosure <spine-path> [<row-id>]` requires the path alone
 * because its wave-scoped form carries no row. Without it a rendered line would
 * advertise an optional slot as mandatory — the mirror image of the omission
 * this row exists to make impossible.
 */
export type PositionalArity =
  | {
      readonly kind: 'fixed';
      readonly count: number;
      readonly labels?: readonly string[];
      readonly min?: number;
    }
  | { readonly kind: 'variadic'; readonly min: number; readonly label?: string };

/**
 * One slot of a NAMED TWIN (ADR-0051 decision 6) — a parameter a verb accepts
 * BOTH as a named flag and as a positional, because a sibling verb takes the
 * same thing as a flag. The named form is canonical; the positional survives as
 * an alias; a MIXED call (some slots named, some positional) is a usage error.
 *
 * Five top-level verbs have twins and no verb group does: a group's positional
 * grammar (`spine <op> <spine-path> <id> …`) IS its canonical spelling, and a
 * second grammar per group would breed the next misgrip class.
 */
export interface TwinSlot {
  /** The canonical named spelling of this slot (e.g. `--verdicts-dir`). */
  readonly flag: string;
  /** What the positional would be called in usage text (e.g. `<verdictsDir>`). */
  readonly label: string;
}

/**
 * What a verb's stdout IS. Row V5 gives `--json` its meaning per class; this row
 * only declares them.
 *
 *   - `prose`        — human text that has a machine-readable equivalent.
 *   - `json`         — stdout is already JSON.
 *   - `silent-write` — nothing on stdout on success; the write IS the result.
 *   - `product`      — stdout is the ARTIFACT itself (rendered markdown, a spine
 *                      source, a freshly minted opaque id).
 */
export type OutputClass = 'prose' | 'json' | 'silent-write' | 'product';

/** One verb's — or one group op's — whole contract. */
export interface VerbContract {
  /**
   * The verb as a caller spells it. A verb group's op carries BOTH tokens
   * (`spine add-disclosure`, `issue-store triage-apply`, `host-pr create`), so
   * the aggregate is addressable by exactly what the caller typed.
   */
  readonly verb: string;
  /** Every flag, canonical spelling first. Router globals are implicit. */
  readonly flags: readonly FlagContract[];
  /** How many positionals it takes. */
  readonly positionals: PositionalArity;
  /** What its stdout is. */
  readonly output: OutputClass;
  /** THIS verb's usage lines — printed on a refusal and by `--help`. */
  readonly usage: readonly string[];
  /** The named-twin slots (ADR-0051 decision 6), in positional order. */
  readonly twin?: readonly TwinSlot[];
}

// ─── Router-global flags ─────────────────────────────────────────────────────

/**
 * The two flags EVERY verb accepts (ADR-0051 decision 7).
 *
 * `--json` is a no-op in this row — the output classes are declared, rows V2/V3/
 * V5 give them meaning — and `--help` is intercepted by the router BEFORE any
 * store or host is constructed, so a help request never reaches the network.
 *
 * `--config` is deliberately NOT here: not every verb has a store.
 */
export const ROUTER_GLOBAL_FLAGS: readonly FlagContract[] = [
  { canonical: '--json', value: 'none', valueType: 'none' },
  { canonical: '--help', value: 'none', valueType: 'none' },
];

/** The router-global flag named by `token`, or `undefined`. */
export function routerGlobalFlag(token: string): FlagContract | undefined {
  return ROUTER_GLOBAL_FLAGS.find((f) => f.canonical === token);
}

// ─── Reading a contract ──────────────────────────────────────────────────────

/**
 * The {@link FlagContract} a TOKEN names within `contract` — matching the
 * canonical spelling OR any alias, and falling through to the router globals.
 * This is the resolution `flag()` performs, so `--iteration` finds the flag
 * declared canonical as `--iter`.
 */
export function flagContractForToken(
  contract: VerbContract,
  token: string,
): FlagContract | undefined {
  for (const f of contract.flags) {
    if (f.canonical === token) return f;
    if (f.aliases?.includes(token)) return f;
  }
  return routerGlobalFlag(token);
}

/**
 * The {@link FlagContract} a CALLER names — by canonical spelling, with or
 * without the leading dashes (`'iter'` and `'--iter'` both find `--iter`). An
 * alias is NOT accepted here: a call site asks for the thing by its one
 * canonical name, and the aliases are what the END USER may type.
 */
export function resolveFlagContract(
  contract: VerbContract,
  name: string,
): FlagContract | undefined {
  const canonical = name.startsWith('--') ? name : `--${name}`;
  return (
    contract.flags.find((f) => f.canonical === canonical) ??
    routerGlobalFlag(canonical)
  );
}

/**
 * Every spelling `contract` accepts for `name` — the canonical one first, then
 * its aliases, in declaration order. Used by the parser to scan argv for any
 * accepted spelling of one flag.
 */
export function acceptedSpellings(
  contract: VerbContract,
  name: string,
): readonly string[] {
  const f = resolveFlagContract(contract, name);
  if (f === undefined) return [];
  return [f.canonical, ...(f.aliases ?? [])];
}

/**
 * Every flag token this verb declares — canonical spellings, aliases, and the
 * two router globals. The candidate set the did-you-mean suggestion searches.
 */
export function declaredFlagTokens(contract: VerbContract): string[] {
  const out: string[] = [];
  for (const f of contract.flags) {
    out.push(f.canonical);
    for (const a of f.aliases ?? []) out.push(a);
  }
  for (const g of ROUTER_GLOBAL_FLAGS) out.push(g.canonical);
  return out;
}

/** Every CANONICAL flag spelling this verb declares (aliases excluded). */
export function canonicalFlagTokens(contract: VerbContract): string[] {
  return contract.flags.map((f) => f.canonical);
}

// ─── did-you-mean ────────────────────────────────────────────────────────────

/**
 * Levenshtein distance, iterative two-row form. Small inputs (flag spellings),
 * so the O(n·m) table is never a cost worth avoiding.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The nearest declared spelling to `token` at edit distance ≤ `max` (2 —
 * ADR-0051 decision 4), or `undefined` when nothing is that close.
 *
 * Ties go to the SHORTER candidate and then to declaration order, so the
 * suggestion is deterministic: a message that varies run to run is one an
 * operator cannot search for.
 */
export function nearestDeclared(
  token: string,
  candidates: readonly string[],
  max = 2,
): string | undefined {
  let best: string | undefined;
  let bestDistance = max + 1;
  for (const candidate of candidates) {
    const d = editDistance(token, candidate);
    if (d < bestDistance || (d === bestDistance && best !== undefined && candidate.length < best.length)) {
      best = candidate;
      bestDistance = d;
    }
  }
  return bestDistance <= max ? best : undefined;
}

// ─── Scanning argv against a contract ────────────────────────────────────────

/** What one argv scan found. */
export interface ScannedArgs {
  /** Tokens that are not flags and not the VALUE of a value-taking flag. */
  readonly positionals: string[];
  /** Flag tokens the contract declares, in the order they appeared. */
  readonly seen: string[];
  /** Flag-shaped tokens the contract does NOT declare. */
  readonly unknownFlags: string[];
  /** A declared value-taking flag that ran off the end of argv with no value. */
  readonly valueless: string[];
}

/**
 * Walk `args` against `contract`, stepping OVER the value of every value-taking
 * flag so a value can never be misread as a flag.
 *
 * That step-over is load-bearing and was the shape of a real bug:
 * `args.includes('--wave')` read `--text "--wave"` as a mode switch and silently
 * discarded the operator's row scope. The `--text` of a disclosure is free prose
 * lifted from an agent's report, so "no operator would ever type that" is not a
 * guarantee this parser gets to make.
 */
export function scanArgs(contract: VerbContract, args: readonly string[]): ScannedArgs {
  const positionals: string[] = [];
  const seen: string[] = [];
  const unknownFlags: string[] = [];
  const valueless: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const f = flagContractForToken(contract, token);
    if (f === undefined) {
      unknownFlags.push(token);
      continue;
    }
    seen.push(token);
    if (f.value !== 'none') {
      if (i + 1 >= args.length) valueless.push(token);
      i++; // the next token is this flag's VALUE — never a flag, never a positional
    }
  }
  return { positionals, seen, unknownFlags, valueless };
}

/**
 * True when `name` (canonical, with or without dashes) appears in `args` as a
 * BARE flag of its own — under any accepted spelling — rather than as the value
 * of a value-taking flag. The contract-aware replacement for
 * `args.includes('--x')`.
 */
export function hasFlag(
  contract: VerbContract,
  args: readonly string[],
  name: string,
): boolean {
  const spellings = acceptedSpellings(contract, name);
  if (spellings.length === 0) return false;
  const { seen } = scanArgs(contract, args);
  return seen.some((t) => spellings.includes(t));
}

/** The positional tokens of `args` under `contract` — values stepped over. */
export function positionalsOf(
  contract: VerbContract,
  args: readonly string[],
): string[] {
  return scanArgs(contract, args).positionals;
}

// ─── The refusal ─────────────────────────────────────────────────────────────

/** Why a call was refused, before it is rendered. */
export interface VerbContractViolation {
  /** `flag` — an undeclared `--token`; `positional` — a stray non-flag token. */
  readonly kind: 'flag' | 'positional';
  /** The offending token, verbatim. */
  readonly token: string;
  /** The nearest declared flag at edit distance ≤ 2, when there is one. */
  readonly suggestion?: string;
  /**
   * The arity this CALL was measured against, on a positional violation — the
   * contract's own, or the narrower one a second FORM of the verb declares
   * ({@link CheckOptions.positionals}).
   *
   * Carried so the message is TRUE of the call that was made: `dor --id <id>`
   * takes no positional, and telling that caller the verb "takes at least 1"
   * (the PATH form's arity) sends them to fix the wrong thing.
   */
  readonly arity?: PositionalArity;
}

/** Options for {@link checkUndeclared} — the one place a FORM narrows arity. */
export interface CheckOptions {
  /**
   * Override the contract's declared arity for this CALL. Used where one verb
   * has two forms: `dor <path>...` is variadic, `dor --id <id>` takes no
   * positional at all, and the discriminator is a flag rather than a verb name.
   */
  readonly positionals?: PositionalArity;
}

/**
 * The FIRST thing `args` carries that `contract` does not declare — an unknown
 * flag, or a positional beyond the declared arity — or `null` when everything
 * checks out.
 *
 * Flags are reported before positionals: a caller who mistyped a flag has, by
 * construction, also produced a stray positional out of that flag's value, and
 * naming the value would teach the wrong fix.
 */
export function checkUndeclared(
  contract: VerbContract,
  args: readonly string[],
  opts: CheckOptions = {},
): VerbContractViolation | null {
  const scan = scanArgs(contract, args);
  const declared = declaredFlagTokens(contract);
  if (scan.unknownFlags.length > 0) {
    const token = scan.unknownFlags[0];
    const suggestion = nearestDeclared(token, declared);
    return suggestion === undefined
      ? { kind: 'flag', token }
      : { kind: 'flag', token, suggestion };
  }
  const arity = opts.positionals ?? contract.positionals;
  const allowed = arity.kind === 'fixed' ? arity.count : Infinity;
  if (scan.positionals.length > allowed) {
    const token = scan.positionals[allowed];
    // A caller who dropped the dashes off a flag lands HERE, not above — so the
    // did-you-mean runs against the dashed form of the stray token too.
    const suggestion = nearestDeclared(`--${token}`, declared);
    return suggestion === undefined
      ? { kind: 'positional', token, arity }
      : { kind: 'positional', token, suggestion, arity };
  }
  return null;
}

/**
 * The refusal, as lines. Names the verb, the token, and the nearest declared
 * flag, then prints THAT ONE VERB's usage — never the router's roster (issue
 * #505: the `host-pr arm --pr` misfire answered a one-flag mistake with an
 * entire ~60-line dump).
 */
export function renderRefusal(
  contract: VerbContract,
  violation: VerbContractViolation,
): string[] {
  const hint =
    violation.suggestion === undefined
      ? ''
      : ` — did you mean ${violation.suggestion}?`;
  const head =
    violation.kind === 'flag'
      ? `error: ${contract.verb}: unknown flag ${violation.token}${hint}`
      : `error: ${contract.verb}: unexpected argument "${violation.token}"${
          hint === ''
            ? ` — ${contract.verb} ${describeArity(violation.arity ?? contract.positionals)}`
            : hint
        }`;
  return [head, ...contract.usage, ''];
}

/** A one-clause description of an arity, for the stray-positional refusal. */
export function describeArity(arity: PositionalArity): string {
  if (arity.kind === 'variadic') {
    return arity.min === 0
      ? 'takes no fixed positional arguments'
      : `takes at least ${arity.min} positional argument(s)`;
  }
  if (arity.count === 0) return 'takes no positional arguments';
  return `takes ${arity.count} positional argument(s)`;
}

/**
 * The ONE refusal path (ADR-0051 decision 4). Returns `2` having written the
 * refusal, or `0` when `args` is entirely declared — so a runner's first
 * statement can be:
 *
 * ```ts
 * const refusal = refuseUndeclared(MY_CONTRACT, args);
 * if (refusal !== 0) return refusal;
 * ```
 */
export function refuseUndeclared(
  contract: VerbContract,
  args: readonly string[],
  opts: CheckOptions = {},
): number {
  const violation = checkUndeclared(contract, args, opts);
  if (violation === null) return 0;
  process.stderr.write(renderRefusal(contract, violation).join('\n'));
  return 2;
}

// ─── `--help` ────────────────────────────────────────────────────────────────

/**
 * True when `args` asks for help — `--help` as a BARE flag, never as the value
 * of a value-taking flag (`--text "--help"` is prose, not a help request).
 *
 * The router calls this BEFORE constructing any store or host, which is the
 * whole point: `issue-store --help` and `store-preflight --help` used to resolve
 * a store and reach the tracker API just to print usage (issue #758).
 */
export function helpRequested(
  contract: VerbContract,
  args: readonly string[],
): boolean {
  return scanArgs(contract, args).seen.includes('--help');
}

/** Print `contract`'s own usage to stdout and return 0 — the `--help` answer. */
export function printVerbHelp(contract: VerbContract): number {
  process.stdout.write([...contract.usage, ''].join('\n'));
  return 0;
}

// ─── Named twins (ADR-0051 decision 6) ───────────────────────────────────────

/** How a twin verb's slots were supplied. */
export type TwinMode = 'named' | 'positional' | 'none';

/** The resolution of a twin verb's slots, or the mixed-form refusal. */
export type TwinResolution =
  | { readonly ok: true; readonly mode: TwinMode; readonly values: readonly (string | undefined)[] }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a twin verb's slots from `args`: ALL named, or ALL positional, never a
 * mix (ADR-0051 decision 6 — "exactly one body route", the `host-pr create
 * --body | --body-file` precedent applied to a whole verb).
 *
 * The named form is canonical, the positional form survives as an alias, and a
 * mixed call is a usage error rather than a silent preference for one of them:
 * `verdict-acked <dir> --id X` reads, to a caller, as though both halves landed.
 */
export function resolveTwin(
  contract: VerbContract,
  args: readonly string[],
): TwinResolution {
  const slots = contract.twin ?? [];
  if (slots.length === 0) return { ok: true, mode: 'none', values: [] };
  const scan = scanArgs(contract, args);
  const named = slots.map((slot) => {
    const spellings = acceptedSpellings(contract, slot.flag);
    return scan.seen.some((t) => spellings.includes(t));
  });
  const namedCount = named.filter(Boolean).length;
  const positionals = scan.positionals;

  if (namedCount > 0 && positionals.length > 0) {
    return {
      ok: false,
      error:
        `${contract.verb}: pass its arguments ALL named or ALL positional, never mixed — ` +
        `saw ${namedCount} named (${slots
          .filter((_, i) => named[i])
          .map((s) => s.flag)
          .join(', ')}) and ${positionals.length} positional (${positionals
          .map((p) => JSON.stringify(p))
          .join(', ')}). The named form is canonical; the positional form is its alias.`,
    };
  }

  if (namedCount > 0) {
    if (namedCount !== slots.length) {
      return {
        ok: false,
        error:
          `${contract.verb}: the named form requires every slot — ` +
          `${slots.map((s) => s.flag).join(' ')}; missing ${slots
            .filter((_, i) => !named[i])
            .map((s) => s.flag)
            .join(', ')}`,
      };
    }
    return {
      ok: true,
      mode: 'named',
      values: slots.map((slot) => firstValueOf(contract, args, slot.flag)),
    };
  }

  return {
    ok: true,
    mode: positionals.length > 0 ? 'positional' : 'none',
    values: slots.map((_, i) => positionals[i]),
  };
}

/**
 * The value of the first accepted spelling of `name` in `args`, scanning left to
 * right so an earlier alias never loses to a later canonical.
 *
 * Lives here rather than in cli-utils.ts because {@link resolveTwin} needs it
 * and cli-utils.ts imports THIS module (not the other way round).
 */
export function firstValueOf(
  contract: VerbContract,
  args: readonly string[],
  name: string,
): string | undefined {
  const spellings = acceptedSpellings(contract, name);
  if (spellings.length === 0) return undefined;
  for (let i = 0; i < args.length; i++) {
    if (spellings.includes(args[i])) return args[i + 1];
    // Step over the VALUE of any other value-taking flag, so `--text "--id"`
    // can never be mistaken for the `--id` flag itself.
    const f = flagContractForToken(contract, args[i]);
    if (f !== undefined && f.value !== 'none') i++;
  }
  return undefined;
}

/** EVERY value of a repeatable flag, under any accepted spelling, in order. */
export function allValuesOf(
  contract: VerbContract,
  args: readonly string[],
  name: string,
): string[] {
  const spellings = acceptedSpellings(contract, name);
  const out: string[] = [];
  if (spellings.length === 0) return out;
  for (let i = 0; i < args.length; i++) {
    if (spellings.includes(args[i])) {
      if (i + 1 < args.length) out.push(args[i + 1]);
      i++;
      continue;
    }
    const f = flagContractForToken(contract, args[i]);
    if (f !== undefined && f.value !== 'none') i++;
  }
  return out;
}
