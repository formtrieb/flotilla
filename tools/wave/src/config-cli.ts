#!/usr/bin/env node
/**
 * config-cli.ts — `config validate <path>` runner.
 *
 * Store-INDEPENDENT: it calls loadWaveConfig (which validates `store`, `verify`
 * — including each command's ADR-0049 `needs` declaration against its closed set
 * of three — `cleanup`, the ADR-0032 `engine.cli` / `engine.install` bindings and
 * the ADR-0012 `models` tier→model-id block)
 * but never buildStore, so it validates a `github` config too — buildStore throws
 * the pre-P8 GitHub deferral, loadWaveConfig does not. This is how `wave-setup`
 * proves a freshly-written config loads (ADR-0016 skill-half grill 2026-06-18).
 *
 * Beside the refusals it reports WARNINGS (issue #761): an unknown key in any
 * block, a value whose shape is not the one its key is read as, and an absolute
 * path in an `engine` binding's argument position. All three are findings the
 * loader has always read past — a misspelled key validated `ok` and surfaced at
 * the first runtime use, or never. None of them refuses and none of them moves
 * the exit code; `wave.config.json` is a semver contract (ADR-0035) and a new
 * refusal on a config that validates today is a major. See the section banner
 * above {@link collectConfigWarnings}.
 *
 * Exit codes: 0 valid (warnings included) · 1 invalid/unreadable · 2 usage.
 *
 * `--json` (ADR-0051 decision 7, row V5) prints `{ verb, config, ok, message,
 * warnings }` on stdout INSTEAD of the prose line, with the warnings above
 * carried inside it rather than as `warning:` lines on stderr. Without the flag
 * every byte of both streams is what it has always been, and the flag moves no
 * exit code: an invalid config still exits 1, with `ok: false` and the loader's
 * own message. The flag follows the op (`config validate <path> --json`).
 */

import { loadWaveConfig, type WaveConfig } from './wave-config';
import type { VerifyConfig } from './verify';
// The Goal container vocabulary's OWN parser (ADR-0044) — called, never
// re-spelled. See {@link collectConfigWarnings}'s goal block for why a warning
// here is not the loader validating the role that ADR-0044 decision 4 keeps
// store-side.
import { parseGoalContainer } from './adapters/issue-store';
import { printJson } from './cli-utils';
import {
  defineVerb,
  hasFlag,
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  type VerbContract,
} from './verb-contract';

/**
 * The shape `config validate --json` prints (ADR-0051 decision 7, row V5).
 *
 * ONE constant, two readers — the verb's own `usage` below renders from it (so
 * `--help`, every refusal, and cli.ts's roster line all advertise it) and
 * {@link runConfig} builds exactly it. A shape advertised separately from the
 * shape emitted is two vocabularies that can disagree, and the emitted one is
 * the half a caller cannot see until it has already made the call.
 */
const VALIDATE_JSON_SHAPE = '{ verb, config, ok, message, warnings: [ { block, path, kind, message } ] }';

/**
 * What `config validate --json` answers with.
 *
 * `ok` is the verdict the exit code already carries; `message` is the one
 * sentence the prose line carries MINUS its `ok: `/`error: ` prefix — the same
 * string, so the two renderings never say two different things; `warnings` is
 * the issue-#761 finding list VERBATIM, each record with the four keys
 * {@link ConfigWarning} declares, because a `--json` caller that had to re-parse
 * `warning:` lines off stderr would be exactly where this row found it.
 *
 * `warnings` is `[]` rather than absent on the error outcome, and that is a
 * statement about the run, not a claim about the config: a refused load never
 * reaches the warning collector, so nothing was found — which is what an empty
 * list says. A stable shape is what lets a caller read `.warnings` without first
 * branching on `.ok`.
 *
 * `config` is the path AS THE CALLER SPELLED IT, matching the prose line, and is
 * deliberately not named `path`: `warnings[].path` is a dotted CONFIG KEY, and
 * two keys named `path` meaning two different things in one object is the kind
 * of surface a reader has to test rather than read.
 *
 * Module-local: a receipt is a CLI projection, and a new exported symbol here
 * would have to reach `index.ts` — outside this row's declared Files globs, the
 * same constraint the warning collector above records.
 */
interface ConfigValidateJsonResult {
  readonly verb: string;
  readonly config: string;
  readonly ok: boolean;
  readonly message: string;
  readonly warnings: readonly ConfigWarning[];
}

/**
 * `config validate`'s Verb contract (ADR-0051 decision 2), declared beside its
 * runner. The group has exactly one op and it is all-positional: `config
 * validate <path>` takes no flag at all, which is why the declaration below has
 * an empty `flags` list and a fixed arity of two (the op token plus the path).
 *
 * Output class `prose`: it prints a one-line ok/error message, not JSON — the
 * surprise this verb was part of when issue #505 measured it.
 */
export const CONFIG_CONTRACTS: Readonly<Record<string, VerbContract>> = {
  validate: defineVerb({
    verb: 'config validate',
    flags: [],
    positionals: { kind: 'fixed', count: 1, labels: ['<path>'] },
    output: 'prose',
    outputNote: 'text (a one-line ok/error message), not JSON',
    json: {
      lead: 'the same verdict as JSON, warnings included',
      shape: VALIDATE_JSON_SHAPE,
      continuation: [
        '  --json FOLLOWS the op: `config validate <path> --json`. Ahead of it,',
        '  `config --json validate <path>` reads --json as the op and exits 2 — the',
        '  group grammar is `config <op> …`, and it is the same on spine, issue-store',
        '  and host-pr.',
      ],
    },
  }),
};

/**
 * The group's roster. Issue #758: it used to be a hand-written `config validate
 * <path>` — a third spelling of a line the contract already owns — and it is
 * the op's own contract section now, so a flag this group learns to read cannot
 * go unmentioned here.
 */
function printUsage(): void {
  process.stderr.write([...CONFIG_CONTRACTS.validate.usage, ''].join('\n'));
}

/**
 * `[commands that declare a capability requirement, commands in total]` across
 * every verify profile (ADR-0049).
 *
 * Defensive by design: `loadWaveConfig` guarantees only that `verify.profiles`
 * is an ARRAY, and holds a command's `needs` to the closed set only where the
 * surrounding shapes were readable. So this counter walks past everything it
 * cannot read rather than throwing on it — a `config validate` that exited 1
 * from its own REPORTING line, on a config the validator itself just accepted,
 * would be a worse answer than a conservative count.
 */
function countDeclaredNeeds(verify: VerifyConfig): [declared: number, total: number] {
  let declared = 0;
  let total = 0;
  for (const profile of verify.profiles as readonly unknown[]) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) continue;
    const commands: unknown = (profile as { commands?: unknown }).commands;
    if (!Array.isArray(commands)) continue;
    for (const cmd of commands) {
      if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) continue;
      total += 1;
      if ((cmd as { needs?: unknown }).needs !== undefined) declared += 1;
    }
  }
  return [declared, total];
}

// ── non-fatal findings: what the loader read and did not grade (issue #761) ──
//
// THE WHOLE SECTION IS WARNINGS, AND THAT IS THE DESIGN, NOT A SHORTFALL.
// `wave.config.json` is a semver contract (ADR-0035), so a check that newly
// REFUSED a config validating today would be a major at blast radius zero —
// three of the findings this section reports look like they want a refusal and
// every one of them is that major. So nothing below throws, nothing below moves
// the exit code, and a config that printed `ok` before this section existed
// prints `ok` still. What changes is that its typos are no longer invisible.
//
// **Why it lives here and not in `wave-config.ts`.** The loader is the natural
// home — the keys these tables enumerate are the loader's own interfaces. A
// collector there would have to be EXPORTED for this runner to reach it, and a
// new exported symbol in an engine source module fails `barrel-drift.spec.ts`
// unless `index.ts` (or that spec's allowlist) moves in the same diff; both are
// outside this row's declared Files globs. So the collector sits beside its one
// consumer, and the tables are held to the loader's declarations by
// `wave-config.spec.ts`'s declaration-driven conformance test (every key the
// TypeScript compiler API finds on the config interfaces must validate WITHOUT
// a warning) rather than by a human keeping two lists in step. The trigger to
// move it is a second consumer — the store-preflight, or a shipped JSON schema.

/** One non-fatal finding about a config the loader accepted. */
interface ConfigWarning {
  /** Dotted path of the BLOCK the finding is about — `''` is the config root. */
  readonly block: string;
  /** Dotted path of the offending key or value. */
  readonly path: string;
  /** Which kind of finding this is — the machine key a JSON rendering would key on. */
  readonly kind: 'unknown-key' | 'wrong-shape' | 'absolute-path' | 'goal-binding';
  /** The one-line message: the key, its block, and what to do about it. */
  readonly message: string;
}

/**
 * The keys each block of `wave.config.json` declares, per
 * `wave-config.ts`/`verify.ts`. A key outside its block's list is read by
 * nothing — which is exactly why a typo in one has always validated `ok`.
 *
 * `store`'s list is per KIND, because the three store variants are a
 * discriminated union and `team` on a github store is as meaningless as
 * `repoRoot` on a linear one.
 */
const STORE_KEYS: Readonly<Record<'markdown' | 'github' | 'linear', readonly string[]>> = {
  markdown: ['kind', 'repoRoot', 'slug', 'eligibility', 'goal'],
  github: ['kind', 'eligibility', 'goal'],
  linear: ['kind', 'team', 'project', 'eligibility', 'states', 'categoryLabels', 'goal'],
};
const TOP_LEVEL_KEYS: readonly string[] = ['store', 'verify', 'cleanup', 'engine', 'models'];
const STORE_GOAL_KEYS: readonly string[] = ['container'];
/** The claim rungs plus the two non-rung write targets and the opt-in done state. */
const STORE_STATES_KEYS: readonly string[] = [
  'queued',
  'inFlight',
  'inReview',
  'unclaimTarget',
  'unplanned',
  'doneState',
];
const CLEANUP_KEYS: readonly string[] = ['disposableNames', 'extraRoots'];
const ENGINE_KEYS: readonly string[] = ['cli', 'install'];
/**
 * The tier→model-id bindings (ADR-0012 Amendment 2026-09-21). The two Risk-
 * derived tier markers plus the driver's fixed Scribe stage — the loader
 * refuses a non-object block and a bad VALUE, so what is left for this table is
 * exactly the misspelled KEY, which would otherwise bind nothing in silence.
 */
const MODELS_KEYS: readonly string[] = ['heavy', 'standard', 'scribe'];
const VERIFY_KEYS: readonly string[] = ['profiles'];
const VERIFY_PROFILE_KEYS: readonly string[] = ['name', 'appliesTo', 'commands'];
// `needs` is deliberately absent from the walk below: its keys are a CLOSED set
// the loader already refuses on (ADR-0049), and a warning beside a refusal would
// be a second, weaker owner of one rule.
const VERIFY_COMMAND_KEYS: readonly string[] = ['cwd', 'command', 'needs'];

/** A JSON object — never an array, never `null`. The only shape with keys to check. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a value is named in a wrong-shape warning: `a string ("milestone")`, `an array`, … */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value} (${JSON.stringify(value)})`;
}

/** `'store'` → `wave config "store"`; `''` → `the wave config root`. */
function blockLabel(block: string): string {
  return block === '' ? 'the wave config root' : `wave config "${block}"`;
}

function joinPath(block: string, key: string): string {
  return block === '' ? key : `${block}.${key}`;
}

/**
 * Report every key of `value` that its block does not declare.
 *
 * NAMES THE CLOSED SET, the way every refusal in `wave-config.ts` does: an
 * author who mistyped `eligibilty` is one line away from the spelling that
 * works, and an author who invented a key learns in the same line that nothing
 * reads it. A non-object (or absent) block has no keys to check and is skipped —
 * its SHAPE is reported separately.
 */
function collectUnknownKeys(
  value: unknown,
  block: string,
  known: readonly string[],
  out: ConfigWarning[],
): void {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (known.includes(key)) continue;
    out.push({
      block,
      path: joinPath(block, key),
      kind: 'unknown-key',
      message:
        `${blockLabel(block)} carries the unknown key ${JSON.stringify(key)} — nothing reads it, ` +
        `and it is reported rather than refused so a config that validates today keeps validating. ` +
        `The keys ${blockLabel(block)} declares are: ${known.join(', ')}.`,
    });
  }
}

/**
 * Report a present value whose SHAPE is not the one its key is read as.
 *
 * Applied only where the loader is SILENT today. `verify`, `cleanup` and
 * `engine` already refuse a non-object outright, and re-reporting a refusal as a
 * warning would be a second owner of one rule; `store.goal`, `store.states`,
 * `store.categoryLabels`, `store.eligibility` and each `verify.profiles[]` entry
 * are the ones that have always loaded as whatever they happened to be.
 */
function expectShape(
  value: unknown,
  path: string,
  want: 'object' | 'array',
  consequence: string,
  out: ConfigWarning[],
): boolean {
  if (value === undefined) return false;
  const ok = want === 'array' ? Array.isArray(value) : isPlainObject(value);
  if (ok) return true;
  out.push({
    block: path,
    path,
    kind: 'wrong-shape',
    message:
      `wave config "${path}" must be ${want === 'array' ? 'an array' : 'an object'} — got ` +
      `${describeValue(value)}. ${consequence} Reported rather than refused: refusing it would ` +
      `newly reject a config that validates today.`,
  });
  return false;
}

/**
 * Report an absolute path sitting in an ARGUMENT position of an `engine`
 * binding — the spelling the leading-slash rule cannot see (issues #725/#746).
 *
 * {@link normalizeEngineInstall}'s refusal is a POSITION check at index 0 of the
 * whole binding string, so `/usr/local/bin/install.sh` is refused and
 * `npm ci --prefix /abs/tools/wave` is not — and the second one is the spelling
 * that actually broke: a prefix reached through a symlink makes a lockfile-exact
 * install accuse a package that exists in neither the manifest nor the lockfile.
 *
 * A WARNING, emphatically. Widening the validator to refuse an absolute
 * argument would newly reject a config that validates today — a major at blast
 * radius zero, on the removal list of the vocabulary grill rather than in this
 * row. What belongs here is the spelling, named.
 */
function collectAbsoluteArgvWords(
  binding: string | undefined,
  path: string,
  out: ConfigWarning[],
): void {
  if (binding === undefined) return;
  const words = binding.split(' ').filter((w) => w.length > 0);
  // Word 0 is the command itself and a leading slash there is already REFUSED,
  // so this walk starts at the first argument — the position the rule misses.
  for (let i = 1; i < words.length; i++) {
    if (!words[i].startsWith('/')) continue;
    out.push({
      block: path,
      path,
      kind: 'absolute-path',
      message:
        `wave config "${path}" carries the absolute path ${JSON.stringify(words[i])} in an ARGUMENT ` +
        `position (word ${i + 1} of ${JSON.stringify(binding)}) — the leading-slash rule checks index 0 of ` +
        `the whole binding, so this spelling validates. It is the spelling that breaks: a directory ` +
        `argument that resolves through a symlink makes a lockfile-exact install report a missing ` +
        `package that appears in neither the manifest nor the lockfile, because the root's name is ` +
        `taken from the directory basename. Write it repo-relative instead. Reported rather than ` +
        `refused: refusing it would newly reject a config that validates today (ADR-0032/ADR-0035).`,
    });
  }
}

/**
 * Every non-fatal finding about a config the loader just accepted.
 *
 * Walks the value `loadWaveConfig` handed back — which IS the parsed JSON, so
 * the keys nothing declares are still on it — block by block, top level
 * downwards. Order is stable and structural (root, store, store's sub-blocks,
 * verify, cleanup, engine) so two runs over one file print the same lines.
 */
function collectConfigWarnings(config: WaveConfig): ConfigWarning[] {
  const raw = config as unknown as Record<string, unknown>;
  const out: ConfigWarning[] = [];

  collectUnknownKeys(raw, '', TOP_LEVEL_KEYS, out);

  // `store` is an object with a known kind by the time the loader returns — both
  // are refusals, not warnings — so the per-kind key list is always reachable.
  const store = raw.store as Record<string, unknown>;
  collectUnknownKeys(store, 'store', STORE_KEYS[config.store.kind], out);
  if (expectShape(store.eligibility, 'store.eligibility', 'array', 'The eligibility OR-set is the marker list a wave reads to decide what it may grab (ADR-0003); a non-array declares none, and the store falls back to its default.', out)) {
    const entries = store.eligibility as unknown[];
    for (let i = 0; i < entries.length; i++) {
      if (typeof entries[i] !== 'string') {
        out.push({
          block: 'store.eligibility',
          path: `store.eligibility[${i}]`,
          kind: 'wrong-shape',
          message:
            `wave config "store.eligibility[${i}]" must be a string — got ${describeValue(entries[i])}. ` +
            `Reported rather than refused: refusing it would newly reject a config that validates today.`,
        });
      }
    }
  }
  // ADR-0044 decision 4 — `store.goal` is read as an object with one key, and a
  // non-object has always loaded silently. The ROLE is still graded store-side
  // (`parseGoalContainer`, and the store-preflight's own goal-binding reading);
  // what is reported here is only the SHAPE the loader itself read past.
  if (expectShape(store.goal, 'store.goal', 'object', 'The Goal container binding is read off "store.goal.container" (ADR-0044); a non-object carries none, so every goal verb refuses.', out)) {
    collectUnknownKeys(store.goal, 'store.goal', STORE_GOAL_KEYS, out);
    // A VALUE that is no container role at all — `"not-a-real-container"`, an
    // invented role, a number. Graded by `parseGoalContainer`, the vocabulary's
    // own parser, so this is not a second copy of the closed set; the message it
    // throws is reproduced verbatim.
    //
    // NOT the loader validating the role, which ADR-0044 decision 4 keeps
    // store-side: nothing here refuses, and the two questions only a STORE can
    // answer — is an ABSENT binding fatal, and does this store realize the role
    // — are untouched and stay with the store-preflight's own `goalBinding`
    // reading. What is answered here is the store-INDEPENDENT half: whether the
    // authored string is in the vocabulary at all.
    const container: unknown = (store.goal as Record<string, unknown>).container;
    try {
      parseGoalContainer(container);
    } catch (err) {
      out.push({
        block: 'store.goal',
        path: 'store.goal.container',
        kind: 'goal-binding',
        message:
          `${(err as Error).message} Reported rather than refused here (ADR-0044 decision 4 keeps the ` +
          `container ladder store-side); \`store-preflight\` grades the same binding against the store ` +
          `that would have to realize it.`,
      });
    }
  }
  if (expectShape(store.states, 'store.states', 'object', 'The claim-rung → workflow-state-name overrides are read off this block (ADR-0020); a non-object declares none, so every rung stays at its default.', out)) {
    collectUnknownKeys(store.states, 'store.states', STORE_STATES_KEYS, out);
  }
  // `categoryLabels` keys are the consumer's own schema categories, so there is
  // no closed set to check INSIDE it — only that it is a block at all.
  expectShape(store.categoryLabels, 'store.categoryLabels', 'object', 'The schema-category → consumer-label map is read off this block; a non-object declares none.', out);

  const verify = raw.verify;
  if (isPlainObject(verify)) {
    collectUnknownKeys(verify, 'verify', VERIFY_KEYS, out);
    const profiles: unknown = verify.profiles;
    if (Array.isArray(profiles)) {
      for (let p = 0; p < profiles.length; p++) {
        const path = `verify.profiles[${p}]`;
        if (!expectShape(profiles[p], path, 'object', 'A profile that is not an object selects nothing — the VerifyGate walks past it.', out)) continue;
        const profile = profiles[p] as Record<string, unknown>;
        collectUnknownKeys(profile, path, VERIFY_PROFILE_KEYS, out);
        if (!expectShape(profile.commands, `${path}.commands`, 'array', 'A profile whose commands are not an array contributes no command at all.', out)) continue;
        const commands = profile.commands as unknown[];
        for (let c = 0; c < commands.length; c++) {
          const cmdPath = `${path}.commands[${c}]`;
          if (!expectShape(commands[c], cmdPath, 'object', 'A command that is not an object runs nothing.', out)) continue;
          collectUnknownKeys(commands[c], cmdPath, VERIFY_COMMAND_KEYS, out);
        }
      }
    }
  }

  const cleanup = raw.cleanup;
  if (isPlainObject(cleanup)) collectUnknownKeys(cleanup, 'cleanup', CLEANUP_KEYS, out);

  const engine = raw.engine;
  if (isPlainObject(engine)) {
    collectUnknownKeys(engine, 'engine', ENGINE_KEYS, out);
    // Both bindings, by the same rule: the leading-slash position check misses
    // an absolute ARGUMENT on either one, and `engine.cli` is as repo-relative a
    // binding as `engine.install` (ADR-0032).
    collectAbsoluteArgvWords(typeof engine.cli === 'string' ? engine.cli : undefined, 'engine.cli', out);
    collectAbsoluteArgvWords(typeof engine.install === 'string' ? engine.install : undefined, 'engine.install', out);
  }

  // ADR-0012 Amendment 2026-09-21 — the tier→model-id block. `isPlainObject`
  // rather than `expectShape`, for the same reason `verify`/`cleanup`/`engine`
  // above use it: the loader already REFUSES a non-object `models`, and
  // re-reporting a refusal as a warning would be a second, weaker owner of one
  // rule.
  const models = raw.models;
  if (isPlainObject(models)) collectUnknownKeys(models, 'models', MODELS_KEYS, out);

  return out;
}

// ── the summary line: what the loader actually read ──────────────────────────

/** `"a", "b"` — a string list as the summary line renders it. */
function quotedList(values: readonly unknown[]): string {
  return values.map((v) => (typeof v === 'string' ? JSON.stringify(v) : String(v))).join(', ');
}

/** `queued="Todo", unplanned="Discarded"` — the declared members of a key→value block. */
function renderPairs(block: Record<string, unknown>, keys: readonly string[]): string {
  return keys
    .filter((k) => block[k] !== undefined)
    .map((k) => `${k}=${typeof block[k] === 'string' ? JSON.stringify(block[k]) : String(block[k])}`)
    .join(', ');
}

/**
 * The parenthesized segments of the `ok:` line — everything the loader actually
 * read, not only the store kind, the profile count and the two engine bindings.
 *
 * EVERY SEGMENT IS CONDITIONAL, and that is the additive guarantee in one
 * property: a config that declares no eligibility, no states, no category
 * labels, no cleanup block and no goal binding prints the line it printed before
 * this row existed, byte for byte. A reader who has only ever seen the old shape
 * sees it unchanged until the config itself says more.
 */
function summarySegments(config: WaveConfig, warnings: readonly ConfigWarning[]): string[] {
  const raw = config as unknown as Record<string, unknown>;
  const store = raw.store as Record<string, unknown>;
  const segments: string[] = [`store.kind=${config.store.kind}`];

  if (Array.isArray(store.eligibility) && store.eligibility.length > 0) {
    segments.push(`store.eligibility: ${quotedList(store.eligibility)}`);
  }
  if (isPlainObject(store.states)) {
    const pairs = renderPairs(store.states, STORE_STATES_KEYS);
    if (pairs !== '') segments.push(`store.states: ${pairs}`);
  }
  if (isPlainObject(store.categoryLabels)) {
    const pairs = renderPairs(store.categoryLabels, Object.keys(store.categoryLabels));
    if (pairs !== '') segments.push(`store.categoryLabels: ${pairs}`);
  }
  if (isPlainObject(store.goal) && typeof store.goal.container === 'string') {
    segments.push(`store.goal.container: ${store.goal.container}`);
  }

  if (config.verify) {
    const [needsDeclared, needsTotal] = countDeclaredNeeds(config.verify);
    // ADR-0049 — the declared capability requirements WITH their denominator. An
    // operator running this line after `wave-setup` is asking "did the needs I
    // declared actually land?", and a count of 0 out of 3 answers it where
    // silence would not. Deliberately conditional for the same reason every
    // segment here is.
    const needsNote =
      needsDeclared > 0
        ? `, ${needsDeclared} of ${needsTotal} verify command(s) declare a sandbox need`
        : '';
    segments.push(`verify: ${config.verify.profiles.length} profile(s)${needsNote}`);
  }

  const cleanup = raw.cleanup;
  if (isPlainObject(cleanup)) {
    if (Array.isArray(cleanup.disposableNames) && cleanup.disposableNames.length > 0) {
      segments.push(`cleanup.disposableNames: ${quotedList(cleanup.disposableNames)}`);
    }
    if (Array.isArray(cleanup.extraRoots) && cleanup.extraRoots.length > 0) {
      segments.push(`cleanup.extraRoots: ${quotedList(cleanup.extraRoots)}`);
    }
  }

  // ADR-0032 — report the BOUND VALUE, not just that one exists. This is what an
  // operator reads to confirm the repo is bound to the form they think it is;
  // "engine.cli: present" would confirm nothing. An absent binding is silent
  // rather than reported as unbound: absence is valid at the engine level, and
  // whether it is acceptable is the consuming skills' call. `engine.install`
  // (issue #717) rides beside it for the identical reason — wherever `cli`
  // resolves through a gitignored path, the command that makes the binary exist
  // is half the answer.
  if (config.engine?.cli) segments.push(`engine.cli: ${config.engine.cli}`);
  if (config.engine?.install) segments.push(`engine.install: ${config.engine.install}`);

  // ADR-0012 Amendment 2026-09-21 — the BOUND VALUES, for the same reason the
  // two engine bindings above report theirs: an operator reads this line to
  // confirm which model each tier resolves to, and "models: present" would
  // confirm nothing. Conditional like every other segment, so a config that
  // declares no `models` prints the line it printed before this key existed.
  const models = raw.models;
  if (isPlainObject(models)) {
    const pairs = renderPairs(models, MODELS_KEYS);
    if (pairs !== '') segments.push(`models: ${pairs}`);
  }

  if (warnings.length > 0) segments.push(`${warnings.length} warning(s)`);
  return segments;
}

export function runConfig(args: string[]): number {
  const op = args[0];
  // `config --help` — the group has one op, so its roster IS that op's usage.
  if (op === '--help') {
    return printVerbHelp(CONFIG_CONTRACTS.validate);
  }
  if (op !== 'validate') {
    printUsage();
    return 2;
  }
  const contract = CONFIG_CONTRACTS.validate;
  const opArgs = args.slice(1);
  if (helpRequested(contract, opArgs)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, opArgs);
  if (refusal !== 0) return refusal;
  const path = positionalsOf(contract, opArgs)[0];
  if (!path) {
    printUsage();
    return 2;
  }
  // ADR-0051 decision 7, row V5. Read through the SAME contract-aware scan the
  // path came from. Note the position: `--json` is read AFTER the op token was
  // matched above, which is the whole of the positional-grammar decision this
  // verb's usage states — `config --json validate <path>` never reaches here,
  // because `--json` was taken as the op and refused. Accepting it ahead of the
  // op on THIS group alone would make `config --json validate` work while
  // `spine --json read` (same shape, same router, different module) still
  // exited 2, and one group's private grammar is a worse surface than one rule
  // that holds across all four.
  const wantJson = hasFlag(contract, opArgs, 'json');
  try {
    const config = loadWaveConfig(path);
    const warnings = collectConfigWarnings(config);
    // ONE message, two renderings: the prose line prefixes it with `ok: `, the
    // JSON carries it under `message`. Building it once is what keeps the two
    // from drifting into two different summaries of one config.
    const message = `"${path}" is a valid wave config (${summarySegments(config, warnings).join(', ')})`;
    if (wantJson) {
      // Under --json the findings ride INSIDE the answer rather than as
      // `warning:` lines on stderr — a caller that asked for one machine-readable
      // result should not have to re-parse prose off a second stream to get the
      // half of it that says what is wrong.
      const answer: ConfigValidateJsonResult = {
        verb: contract.verb,
        config: path,
        ok: true,
        message,
        warnings,
      };
      printJson(answer);
      return 0;
    }
    // The non-fatal findings, on stderr, BEFORE the ok line on stdout: a human
    // reads them above the verdict, and a caller that pipes stdout keeps reading
    // exactly the one line it always read. Never an exit code — see the section
    // banner above for why every one of these is a warning.
    for (const warning of warnings) process.stderr.write(`warning: ${warning.message}\n`);
    process.stdout.write(`ok: ${message}\n`);
    return 0;
  } catch (err) {
    // issue #759: a nonexistent <path> used to reach the operator as
    // `loadWaveConfig`'s bare `readFileSync` ENOENT, unprefixed — informative to
    // Node, not to the caller who mistyped a path. Only ENOENT is rewritten
    // (the same restraint `describeConfigLoadError` in cli-utils.ts takes):
    // every OTHER `loadWaveConfig` failure (malformed JSON, unknown store kind,
    // …) already names its own fix and passes through unchanged, below and
    // pinned by the specs beside this block. The prefix echoes `merge-order`'s
    // "could not read wave file" (cli.ts) — both name the file that would not
    // read. Exit code is unchanged: an invalid/unreadable config already
    // exited 1 here; re-meaning it would be a major under ADR-0035.
    const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const message = isEnoent
      ? `could not read config file: ${(err as Error).message}`
      : (err as Error).message;
    if (wantJson) {
      // A refused load never reached the warning collector, so `warnings` is
      // empty — a statement about this run, not a claim that the config has
      // none. The exit code is the one the prose form returns: --json chose a
      // rendering, never a verdict.
      const answer: ConfigValidateJsonResult = {
        verb: contract.verb,
        config: path,
        ok: false,
        message,
        warnings: [],
      };
      printJson(answer);
      return 1;
    }
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
if (require.main === module) {
  process.exit(runConfig(process.argv.slice(2)));
}
