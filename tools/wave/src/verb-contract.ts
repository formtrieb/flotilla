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
 * ({@link helpRequested} + the contract's own `usage`), and the {@link Catalog}
 * — the `catalog` verb, which emits the contracts as JSON.
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
   * What this flag's VALUE is called in THIS verb's own usage section —
   * `--input <CreateInput.json>`, `--var <VAR>`, `--method <squash|merge|rebase>`.
   *
   * Optional, and read by ONE surface: the verb's own rendered section, which is
   * the place a caller goes to learn what to put after the flag. The router's
   * roster deliberately ignores it and prints the placeholder of the value TYPE
   * instead ({@link FlagValueType}) — the roster is a uniform one-line index of
   * the whole engine, and sixty verbs each naming their own value shape would
   * make its columns unreadable. One declaration, two renderings, neither
   * hand-written.
   */
  readonly placeholder?: string;
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

/**
 * A RELATIONSHIP between several flags of one verb (Coordinator decision 15,
 * 2026-09-21; ADR-0051's 2026-09-21 note).
 *
 * The roster and the flag list are faithful about flag NAMES and were lossy
 * about how they go together: `host-pr create … [--body <text>] [--body-file
 * <path>]` read as two independent optionals where the parser requires exactly
 * one of them. A group says which, and the renderer turns it into the
 * alternation a caller can act on.
 *
 * **Reporting only.** The parser is not changed by a group: every runner still
 * checks its own combinations and emits its own message, and
 * {@link checkUndeclared} never reads this. A group that disagreed with a
 * runner would be a second, silent parser — exactly what ADR-0051 exists to
 * forbid — so it declares what the runner already enforces and is rendered,
 * nothing more.
 */
export interface FlagGroup {
  /**
   * `exactly-one` — the verb refuses with neither and with both; renders
   * `(--a | --b)`.
   * `at-most-one` — either alone, or neither; renders `[--a | --b]`.
   */
  readonly kind: 'exactly-one' | 'at-most-one';
  /**
   * The alternatives, in render order — one inner list per branch, because a
   * branch is not always a single flag. `spine add-disclosure`'s row-scoped
   * branch is a POSITIONAL and a flag together (`<row-id> --iter <n>`) against
   * a wave-scoped branch that is one switch; rendering those as two bare flag
   * names would lose the half that makes the choice legible.
   *
   * A token starting with `--` is a canonical flag spelling and renders with
   * its value placeholder; anything else is a positional LABEL and renders
   * verbatim.
   */
  readonly branches: readonly (readonly string[])[];
  /**
   * How many of the contract's TRAILING positional slots this group's branches
   * already account for — `1` on `spine add-disclosure`, whose `<row-id>` slot
   * appears inside the group rather than beside it. Without it the slot would
   * be printed twice: once bracketed by the arity, once inside the branch.
   *
   * A group that consumes a slot also renders WHERE that slot is — directly
   * after the remaining positionals — rather than after the required flags,
   * which is where a purely-flag group belongs.
   */
  readonly consumesPositionals?: number;
}

/**
 * One CALL SHAPE of a verb that has more than one (Coordinator decision 15).
 *
 * Three verbs take two genuinely different invocations — `dor` by path or by
 * `--id`, `conflict-map` the same, `credential-probe` by `--all` or by `--var`
 * — and one signature line cannot state that without lying about one of them.
 * A form declares the positionals and the flags of ONE shape; the section
 * renders one invocation line per form.
 *
 * A form, not a {@link FlagGroup}, when the two shapes differ in their
 * POSITIONALS as well as their flags: `dor --id <id>` takes none where the path
 * form takes at least one, and an alternation inside one line cannot say that.
 * Where only the flags differ — `spine add-disclosure`'s two scopes, whose
 * `--source` and `--text` are the same on both sides — a group keeps it to one
 * line, which is also what keeps the op's `available:` vocabulary one entry.
 *
 * Like {@link FlagGroup} this is reporting only: the runner still decides which
 * form a call is in (usually by whether a discriminating flag is present), and
 * {@link CheckOptions.positionals} is the one place a form narrows what the
 * refusal measures against.
 */
export interface VerbForm {
  /** This form's positional arity. Defaults to the contract's own. */
  readonly positionals?: PositionalArity;
  /** Canonical spellings this form REQUIRES, in render order — unbracketed. */
  readonly requires?: readonly string[];
  /** Canonical spellings this form also accepts, in render order — bracketed. */
  readonly accepts?: readonly string[];
  /** Relationships scoped to this form. Defaults to the contract's own. */
  readonly groups?: readonly FlagGroup[];
  /** The trailing `# …` comment this form's line carries, aligned with its siblings. */
  readonly note?: string;
}

/**
 * The SHAPE clause of a verb's section, as declared parts rather than as a
 * sentence (ADR-0051 decision 7 gave `--json` its meaning; this states the
 * shape that answer carries).
 *
 * Rendered as `  <label>: <lead> — <shape> — <trail>`, dropping every part the
 * verb does not declare, then the continuation lines verbatim.
 *
 * ## One field, two headings — and why it is one field (issue #913)
 *
 * The question "what shape does this verb's JSON have?" has ONE answer per
 * verb, so it has one declaration site, whatever the verb's {@link
 * OutputClass}. What differs is only the HEADING it renders under, and the
 * renderer derives that from the output class rather than asking each verb to
 * repeat it:
 *
 *   - a `prose` / `silent-write` / `product` verb prints JSON only when asked,
 *     so its clause is headed `--json:` — the flag IS the subject;
 *   - a `json` verb's whole stdout is already that JSON, so its clause is
 *     headed `shape:` — there is no flag to explain, only a shape to state.
 *
 * Before this, a `json` verb could carry `output: 'json'` and stop, and every
 * one but `catalog` did. An undeclared output shape is what let two shipped
 * reference documents describe `merge-order`'s output as an array of branch
 * STRINGS when it prints an array of OBJECTS: nothing rendered the real shape
 * anywhere a reader would meet it, so the disagreement had nowhere to surface.
 * `verb-contract-drift.spec.ts` now fails a `json` verb that declares no
 * `shape`.
 */
export interface JsonNote {
  /**
   * The clause label. Defaults to `shape` on an `output: 'json'` verb and to
   * `--json` on every other class; the write receipts say `--json receipt`.
   *
   * Declared only to OVERRIDE that default — the class already decides it, and
   * a per-verb repetition of what the class says is the second copy this
   * module exists to avoid.
   */
  readonly label?: string;
  /** Prose BEFORE the shape (`one receipt on stdout, after the write lands`). */
  readonly lead?: string;
  /** The declared shape (`{ op, spine, id, written: { state } }`). */
  readonly shape?: string;
  /** Prose AFTER the shape (`the rung swapped to`). */
  readonly trail?: string;
  /** Lines printed under the clause, verbatim — indentation included. */
  readonly continuation?: readonly string[];
}

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
  /**
   * THIS verb's usage lines — printed on a refusal and by `--help`.
   *
   * A COMPUTED field: {@link defineVerb} fills it from everything else on the
   * declaration, so a flag the parser reads cannot be missing from `--help` by
   * construction. It stays a plain `readonly string[]` on the type (rather than
   * a method a caller has to invoke) because every root-exported contract is
   * read for it — `host-pr`'s group dump, `issue-store`'s op roster and the
   * router's own `--json` clause all take `usage[0]` or scan the array — and a
   * shape change there would break every one of them.
   */
  readonly usage: readonly string[];
  /** The named-twin slots (ADR-0051 decision 6), in positional order. */
  readonly twin?: readonly TwinSlot[];

  // ── what the section is rendered FROM (Coordinator decision 15) ───────────

  /**
   * How a caller SPELLS this verb at a shell prompt, if not the default.
   *
   * Three prefix kinds and no more: a router verb is `flotilla-engine <verb>`
   * (the default), a verb group's op is its own two tokens (`spine set-status`
   * — derived, because a group op's `verb` already carries both), and a module
   * with its own entry point names itself (`store-preflight`, `resume`,
   * `wave-conflict-map`), which is the only kind that has to be declared.
   */
  readonly program?: string;
  /** How this verb's flags relate — rendered into the signature, never parsed. */
  readonly groups?: readonly FlagGroup[];
  /** The verb's call shapes, where it has more than one. One line each. */
  readonly forms?: readonly VerbForm[];
  /** This verb's own prose, verbatim — indentation included. */
  readonly notes?: readonly string[];
  /** What follows `output: `; an array states the continuation lines too. */
  readonly outputNote?: string | readonly string[];
  /**
   * The shape clause — the `--json:` clause on a verb that answers JSON only
   * when asked, and the `shape:` clause on a verb whose whole stdout is JSON.
   *
   * REQUIRED, by drift spec rather than by type, on every `output: 'json'`
   * verb, and its `shape` must be declared there (issue #913). The type keeps
   * it optional because the three other output classes genuinely may have
   * nothing to say — a `silent-write` op without a receipt, a `product` verb
   * whose stdout is the artifact.
   */
  readonly json?: JsonNote;
}

/**
 * A verb's contract as an author DECLARES it — everything except the `usage`
 * section, which {@link defineVerb} renders from it.
 */
export type VerbContractDeclaration = Omit<VerbContract, 'usage'>;

/**
 * The **Catalog** (ADR-0051 decision 2; CONTEXT.md `### Engine surface`) — the
 * sum of every {@link VerbContract} the router collects, as the payload the
 * `catalog` verb prints. The fourth reader of a contract, and the last one
 * ADR-0051 named that did not exist: 2.7.0 shipped the contracts, the roster
 * rendered from them and `--help` on every verb, and said so in its own
 * CHANGELOG under *Not yet proven* — "the Catalog (contracts as JSON) is
 * decided, not built".
 *
 * `verbs` carries the contracts THEMSELVES, not a projection of them, and that
 * is the whole design. A projection would name the fields somebody thought
 * mattered, and every field it did not name would be a field the Catalog could
 * never carry — the omission class ADR-0051 closes at the parser, re-opened one
 * layer out at the emitter. Verbatim, a field added to {@link VerbContract}
 * tomorrow is in the Catalog with no edit to the emitter at all.
 *
 * Ordered by `verb`, so a consumer diffing two engine versions reads contract
 * changes and not declaration-order churn.
 */
export interface Catalog {
  /** The verb that printed this — the envelope every engine JSON answer opens with. */
  readonly verb: 'catalog';
  /** Every contract: one entry per verb and per verb-group op, sorted by `verb`. */
  readonly verbs: readonly VerbContract[];
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

// ─── The usage renderer (issue #856) ─────────────────────────────────────────
//
// Row 758 rendered the router's ROSTER from the contracts and closed the
// omission class there; a verb's OWN section — the text `--help` prints and
// every refusal reprints — stayed 331 lines of declared prose held to the
// parser by a guard rather than by construction. This is the other half: the
// signature line, the `output:` line and the shape clause of every verb and
// every group op are BUILT from the declaration, so a flag the parser reads
// cannot be missing from `--help` any more than it can be missing from the
// roster. The guard row 758 installed stays, as the regression net it now is.
//
// What is NOT rendered is the verb's prose. It survives verbatim as declared
// `notes` — a sentence like "a reuse that would drop the close phrase is
// REFUSED" is knowledge about the verb, not a fact about its argument shape,
// and generating it from structure would either lose it or invent it.
//
// **Two surfaces, one declaration.** The roster and the section render the same
// contract differently on purpose: the roster is a uniform index (value-TYPE
// placeholders, no alternations — sixty lines that have to scan as columns),
// the section is one verb's teaching surface (its own placeholders, its
// relationships spelled out). Both go through {@link renderInvocations}, so
// neither can name a flag the other does not.

/** The placeholder a flag's VALUE is printed as, from its declared value TYPE. */
const VALUE_PLACEHOLDER: Readonly<Record<FlagValueType, string>> = {
  none: '',
  path: '<path>',
  dir: '<dir>',
  id: '<id>',
  int: '<n>',
  text: '<text>',
  enum: '<value>',
  sha: '<sha>',
  url: '<url>',
  branch: '<branch>',
  version: '<version>',
  list: '<a,b>',
  json: '<json>',
};

/** How one contract is rendered — the two surfaces differ only by these. */
export interface UsageRenderOptions {
  /**
   * The program prefix to use instead of the contract's own. The roster passes
   * `flotilla-engine <verb>` for EVERY verb (every one of them is reachable as
   * a subcommand of the one CLI, whatever its module is called), and the empty
   * string renders the bare signature.
   */
  readonly program?: string;
  /**
   * `declared` (the default) — a flag prints its own {@link
   * FlagContract.placeholder} where it declares one. `type` — every flag prints
   * the placeholder of its value TYPE, which is what keeps the roster's columns
   * uniform.
   */
  readonly placeholders?: 'declared' | 'type';
  /**
   * Render the declared relationships — the alternations and the second form.
   * Default true; the roster passes `false` and lists each flag as the
   * independent optional it is declared to be, sending the reader to the verb's
   * own section for how they go together.
   */
  readonly relationships?: boolean;
}

/**
 * How a caller spells this verb at a prompt — the three prefix kinds, decided
 * by the declaration alone (see {@link VerbContract.program}).
 */
function programNameOf(decl: VerbContractDeclaration): string {
  if (decl.program !== undefined) return decl.program;
  return decl.verb.includes(' ') ? decl.verb : `flotilla-engine ${decl.verb}`;
}

/** One flag as a caller types it, with the repeat form on a repeatable flag. */
function flagForm(f: FlagContract, mode: 'declared' | 'type'): string {
  const placeholder =
    mode === 'declared' && f.placeholder !== undefined
      ? f.placeholder
      : VALUE_PLACEHOLDER[f.valueType];
  const head = placeholder === '' ? f.canonical : `${f.canonical} ${placeholder}`;
  return f.value === 'repeatable' ? `${head} [${head} ...]` : head;
}

/**
 * The positional segment of a signature.
 *
 * A named-twin verb (ADR-0051 decision 6) renders as the alternation it really
 * is — `(--verdicts-dir <dir> --id <id> | <verdictsDir> <id>)` — because on
 * those verbs the positionals ARE the flags, spelled the other way, and listing
 * both segments separately would read as a verb that takes four arguments.
 */
function positionalForm(
  decl: VerbContractDeclaration,
  arity: PositionalArity,
  twin: readonly TwinSlot[],
  mode: 'declared' | 'type',
): string {
  if (twin.length > 0) {
    const named = twin
      .map((slot) => {
        const f = decl.flags.find((c) => c.canonical === slot.flag);
        return f === undefined ? slot.flag : flagForm(f, mode);
      })
      .join(' ');
    return `(${named} | ${twin.map((s) => s.label).join(' ')})`;
  }
  if (arity.kind === 'variadic') {
    const label = arity.label ?? '<arg>';
    return arity.min === 0 ? `[${label} ...]` : `${label} [${label} ...]`;
  }
  if (arity.count === 0) return '';
  const labels =
    arity.labels ?? Array.from({ length: arity.count }, (_, i) => `<arg${i + 1}>`);
  const required = arity.min ?? arity.count;
  return labels.map((label, i) => (i < required ? label : `[${label}]`)).join(' ');
}

/**
 * The whole argument shape of one verb (or one of its forms): its positionals,
 * then its REQUIRED flags, then its declared relationships, then its optional
 * flags in brackets.
 *
 * Positionals lead because a verb group's positional grammar is its canonical
 * spelling (`issue-store triage-apply <id> --input <path>`, decision 6's "no
 * named twin for a group"), and a required flag leads an optional one because
 * that is the order a caller has to satisfy them in. A group sits between the
 * two: its members are what a caller decides about once the required flags are
 * settled.
 */
function signatureSegments(
  decl: VerbContractDeclaration,
  form: VerbForm | undefined,
  opts: UsageRenderOptions,
): string[] {
  const mode = opts.placeholders ?? 'declared';
  const byName = new Map(decl.flags.map((f) => [f.canonical, f]));
  const named = (token: string): string => {
    const f = byName.get(token);
    return f === undefined ? token : flagForm(f, mode);
  };
  const groups = opts.relationships === false ? [] : (form?.groups ?? decl.groups ?? []);
  const grouped = new Set(groups.flatMap((g) => g.branches.flat()));
  const render = (g: FlagGroup): string => {
    const inner = g.branches.map((branch) => branch.map(named).join(' ')).join(' | ');
    return g.kind === 'exactly-one' ? `(${inner})` : `[${inner}]`;
  };
  // A group that occupies a positional slot renders where that slot is; one
  // made of flags alone renders after the flags a caller has no choice about.
  const atPositionals = groups.filter((g) => (g.consumesPositionals ?? 0) > 0);
  const afterRequired = groups.filter((g) => (g.consumesPositionals ?? 0) === 0);
  const consumed = atPositionals.reduce((n, g) => n + (g.consumesPositionals ?? 0), 0);

  // A twin's slots ARE the positionals, so a FORM (which states its own
  // positionals) never renders the twin alternation on top of them.
  const twin = form === undefined ? (decl.twin ?? []) : [];
  const segments: string[] = [
    positionalForm(decl, narrowArity(form?.positionals ?? decl.positionals, consumed), twin, mode),
    ...atPositionals.map(render),
  ];

  if (form !== undefined) {
    for (const token of form.requires ?? []) {
      if (!grouped.has(token)) segments.push(named(token));
    }
    segments.push(...afterRequired.map(render));
    for (const token of form.accepts ?? []) {
      if (!grouped.has(token)) segments.push(`[${named(token)}]`);
    }
    return segments.filter((s) => s !== '');
  }

  const twinFlags = new Set(twin.map((s) => s.flag));
  const rest = decl.flags.filter(
    (f) => !twinFlags.has(f.canonical) && !grouped.has(f.canonical),
  );
  segments.push(...rest.filter((f) => f.required === true).map((f) => flagForm(f, mode)));
  segments.push(...afterRequired.map(render));
  segments.push(
    ...rest.filter((f) => f.required !== true).map((f) => `[${flagForm(f, mode)}]`),
  );
  return segments.filter((s) => s !== '');
}

/** `arity` with its last `consumed` slots taken over by a group that renders them. */
function narrowArity(arity: PositionalArity, consumed: number): PositionalArity {
  if (consumed === 0 || arity.kind === 'variadic') return arity;
  const count = Math.max(0, arity.count - consumed);
  return {
    kind: 'fixed',
    count,
    ...(arity.labels === undefined ? {} : { labels: arity.labels.slice(0, count) }),
    ...(arity.min === undefined ? {} : { min: Math.min(arity.min, count) }),
  };
}

/**
 * Every invocation line of one contract — the program prefix plus the rendered
 * signature, ONE line per declared {@link VerbForm} (and exactly one line for a
 * verb that declares none).
 *
 * The router's roster and the verb's own section both come through here, which
 * is the point: a flag on one and not the other is not expressible.
 */
export function renderInvocations(
  decl: VerbContractDeclaration,
  opts: UsageRenderOptions = {},
): string[] {
  const program = opts.program ?? programNameOf(decl);
  const forms: readonly (VerbForm | undefined)[] =
    opts.relationships === false || decl.forms === undefined ? [undefined] : decl.forms;
  return forms.map((form) =>
    [program, ...signatureSegments(decl, form, opts)].filter((s) => s !== '').join(' '),
  );
}

/**
 * The shape clause, as lines — the declared parts, joined by em-dashes.
 *
 * The heading comes from the OUTPUT CLASS, not from the verb (issue #913): a
 * verb whose whole stdout is JSON has no flag to explain, so its clause reads
 * `shape:`; every other class answers JSON only on request, so its clause
 * reads `--json:`. A verb overrides that with {@link JsonNote.label} — the
 * write receipts do, to say `--json receipt`.
 */
function renderJsonNote(json: JsonNote, output: OutputClass): string[] {
  const body = [json.lead, json.shape, json.trail]
    .filter((part): part is string => part !== undefined)
    .join(' — ');
  const label = json.label ?? (output === 'json' ? 'shape' : '--json');
  return [`  ${label}: ${body}`, ...(json.continuation ?? [])];
}

/**
 * ONE verb's whole usage section, rendered from its declaration — the text
 * `--help` prints, the text every refusal reprints, and the text a runner's own
 * missing-argument branch prints.
 *
 * Shape, in order: the invocation line(s), the verb's declared prose, the
 * `output:` line, the shape clause (`shape:` on a `json` verb, `--json:`
 * elsewhere — {@link JsonNote}). A form's trailing `# …` comment is
 * aligned across the invocation block, so two forms read as a table rather than
 * as two sentences that happen to be adjacent.
 */
export function renderUsageSection(decl: VerbContractDeclaration): string[] {
  const invocations = renderInvocations(decl);
  // Every invocation line carries the same 7-character prefix (`usage: ` or the
  // continuation indent), so the comment column can be measured on the finished
  // lines rather than on the signatures inside them.
  const head = invocations.map((inv, i) => (i === 0 ? `usage: ${inv}` : `       ${inv}`));
  const formNotes = decl.forms?.map((f) => f.note);
  const column =
    Math.max(
      0,
      ...head.filter((_, i) => formNotes?.[i] !== undefined).map((line) => line.length),
    ) + 3;
  const lines = head.map((line, i) => {
    const note = formNotes?.[i];
    return note === undefined ? line : `${line.padEnd(column)}# ${note}`;
  });
  lines.push(...(decl.notes ?? []));
  if (decl.outputNote !== undefined) {
    const [first, ...rest] =
      typeof decl.outputNote === 'string' ? [decl.outputNote] : decl.outputNote;
    lines.push(`output: ${first}`, ...rest);
  }
  if (decl.json !== undefined) lines.push(...renderJsonNote(decl.json, decl.output));
  return lines;
}

/**
 * Declare one verb: the declaration, plus the `usage` section rendered from it.
 *
 * Every contract in the engine is built through this, which is what makes
 * `usage` a computed field rather than a second hand-maintained description of
 * the parser. Nothing stops a caller writing a `VerbContract` literal with a
 * hand-typed `usage` — the type still allows it, so a consumer's own tooling
 * can hand one in — but no contract this engine ships does.
 */
export function defineVerb(decl: VerbContractDeclaration): VerbContract {
  return { ...decl, usage: renderUsageSection(decl) };
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
