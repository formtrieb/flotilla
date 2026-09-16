#!/usr/bin/env node
/**
 * spine-cli.ts — the thin shell the wave skills (wave-create/start/close) call
 * via `npx tsx` to read + mutate the WAVE.md orchestration spine. Most ops are
 * a pure router over the byte-preserving {@link SpineStore} (spine-store.ts):
 * they build a disk-backed store, delegate the single mutation, and flush.
 * `set-row-iter` is the one exception — it has no SpineStore method (yet), so
 * it calls the byte-preserving `wave-md-rw` writer directly against the file.
 * The CLI adds no spine logic of its own — the spine parser (wave-md-rw) validates.
 *
 * ── One entrypoint (issue #77) ────────────────────────────────────────────────
 * `cli.ts` has always ALSO routed `spine` here, which left two ways to reach the
 * same runner. The standalone path is now COLLAPSED onto the router case: the
 * direct-run block at the bottom of this file no longer dispatches on its own —
 * it forwards `process.argv` to `cli.ts`'s `main(['spine', …])`, which routes
 * straight back to {@link runSpine}. So `npx tsx tools/wave/src/spine-cli.ts
 * <op> …` survives as a documented ALIAS (the `wave-close` mechanics still spell
 * it that way) while there is exactly ONE dispatch path in the engine.
 *
 * Usage (canonical router spelling — the alias takes the same ops/args):
 *   {{wave-cli}} spine read <spine-path>
 *   {{wave-cli}} spine set-row-state <spine-path> <id> <state>
 *   {{wave-cli}} spine set-row-iter <spine-path> <id> <n>
 *   {{wave-cli}} spine set-row-pr <spine-path> <id> <pr-cell>
 *   {{wave-cli}} spine set-branch <spine-path> <id> <branch> [--model <m>]
 *   {{wave-cli}} spine replace-closed-by <spine-path> <body-file>
 *   {{wave-cli}} spine add-disclosure <spine-path> <row-id> --iter <n> --source <s> --text <t>
 *   {{wave-cli}} spine add-disclosure <spine-path> --wave --source <s> --text <t>
 *   {{wave-cli}} spine set-disposition <spine-path> <disclosure-ref> <disposition>
 *   {{wave-cli}} spine check-disclosures <spine-path>
 *   {{wave-cli}} spine human-gated <spine-path> [--workers <a,b>]
 *   {{wave-cli}} spine check-awaiting-human <spine-path> [--workers <a,b>]
 *
 * Ops:
 *   read              Print the current spine source to stdout (+ trailing \n).
 *   set-row-state     setRowState(id, state) then flush. The state token is
 *                     validated against ROW_STATES at this CLI boundary (the
 *                     spine writer writes any string verbatim, so an unchecked
 *                     typo would silently corrupt durable state — "fail loud").
 *   set-row-iter      setRowIter(id, n) then flush — bumps the Plan-Table
 *                     `Iter` cell and re-renders the `Reports → Verdicts`
 *                     sidecar-link cell to the <id>-<n> paths (FOR-53,
 *                     observability-only; the reconciler still reads the
 *                     max-iter sidecar off disk, ADR-0024). `wave-start` calls
 *                     this alongside `set-row-state <id> re-dispatched` at
 *                     cap=1 re-dispatch. `n` must be a positive integer — "fail
 *                     loud" at this CLI boundary, same stance as set-row-state.
 *                     Reads/writes the file directly (no SpineStore method for
 *                     this verb yet), so it is handled before the generic
 *                     store/apply/flush flow below.
 *   set-row-pr        setRowPrCell(id, prCell) then flush.
 *   set-branch        upsertDispatchLogEntry(id, branch) — records the durable
 *                     branch home (ADR-0021) resume() reads via branchesByIssueId;
 *                     optional `--model <m>` also upsertDispatchLogModel(id, m)
 *                     (ADR-0012). Then flush.
 *   replace-closed-by Read <body-file> from disk and replaceClosedByBlock(body)
 *                     then flush. The body lives in a file (not argv) so it can
 *                     carry newlines / a multi-line `## Closed-By` block.
 *
 * ── Disclosures (ADR-0027, ADR-0038) ──────────────────────────────────────────
 *   add-disclosure    Capture one disclosure — a Convention-9 wiring gap, a
 *                     Convention-10 runtime residue, or a same-shaped
 *                     Reviewer/Coordinator finding — against <row-id> at
 *                     disposition `open`, then flush. Materializes the
 *                     `## Disclosures` section on a spine that predates it.
 *                     Prints the created disclosure-ref (`<row-id>.<ordinal>`)
 *                     to stdout AFTER the flush — that ref is what
 *                     `set-disposition` addresses.
 *
 *                     TWO FORMS, the second ADDITIVE (ADR-0038 / ADR-0035):
 *                     `--wave` captures WAVE-SCOPED — a find about the wave's
 *                     own machinery (the sweep, a preflight posture, the
 *                     merge-order tool) that no Plan-Table row and no dispatch
 *                     iteration owns. It takes NO <row-id> and NO `--iter`
 *                     (passing either alongside `--wave` is a usage 2), and
 *                     mints a `wave.<ordinal>` ref. Everything downstream is
 *                     identical: same table, same `set-disposition`, same
 *                     `check-disclosures` counting. The row-scoped form above
 *                     keeps its exact shape, validation and output.
 *   set-disposition   Set exactly one entry's disposition. The vocabulary is
 *                     exactly `resolved-in-slice | scope-extension | filed:<id>
 *                     | dropped:<reason> | upstream:<ref>`; anything else
 *                     (including `open`, the capture default) is refused loud
 *                     with NOTHING written. `upstream:<ref>` is the fifth value
 *                     (ADR-0027 Amendment 2026-09-04): the find was about the
 *                     TOOLKIT, so it went to the toolkit's own tracker — a
 *                     `<ref>` there is free-form (URL, bare number, phrase) and
 *                     only a blank one is refused. The usage line renders from
 *                     DISPOSITION_VOCABULARY, which the validator derives from
 *                     the same lists, so this text can never drift from it.
 *   check-disclosures The fail-closed archive gate. Exits 0 iff no `open`
 *                     disclosure remains, non-zero otherwise — `wave-close`
 *                     reads the EXIT CODE, never this output's prose (ADR-0027
 *                     rejects a grep-the-markdown gate explicitly). Non-mutating,
 *                     and it needs its own exit code, so it is handled ahead of
 *                     the generic store/apply/flush flow (which always returns 0).
 *
 * ── The human lane (ADR-0012) ─────────────────────────────────────────────────
 *   human-gated       LISTING. Emits one JSON object describing the wave's human
 *                     lane and exits 0 on any readable spine. An empty lane is a
 *                     legitimate answer, never a gate.
 *   check-awaiting-human
 *                     The SECOND fail-closed archive gate, shaped exactly like
 *                     `check-disclosures`: exit != 0 iff a human-gated row still
 *                     holds the live `queued` claim nothing ever released.
 *
 * Both were introduced on `cli.ts`'s `spine` router case rather than here — the
 * slice that added them had `cli.ts` in its declared file scope and this file
 * outside it — and its own comment recorded the fold back as a PURE MOVE. This
 * is that move (issue #366): same args, same JSON, same exit codes, one dispatch
 * table. Neither touches the byte-preserving SpineStore (both are pure readers
 * over `wave-md-rw`'s human-lane predicate) and each owns its own usage message
 * and exit-code contract, so — like `check-disclosures` — they are handled ahead
 * of the generic store/apply/flush flow.
 *
 * NOTE on WHERE the disclosure vocabularies are validated. `set-row-state` /
 * `set-status` check their token HERE, at the CLI boundary, because their writer
 * stamps any string verbatim into the spine — this is the only place a typo can
 * be caught. The disclosure verbs are different: `spine-store.ts` OWNS the
 * `## Disclosures` section and its constructors enforce their own invariants, so
 * a bad `--source` / `<disposition>` / `<row-id>` throws in the DOMAIN and
 * surfaces here as exit 1 — the check cannot be bypassed by reaching the store
 * through another front end. Only shape errors argv alone can show (a missing
 * flag, a non-integer `--iter`) are caught at this boundary as usage 2.
 *
 * Exit codes:
 *   0 — success (for `check-disclosures`: the archive gate is clear)
 *   1 — domain failure: a spine mutator threw (bad row id, missing section,
 *       out-of-vocabulary disclosure source/disposition, unknown disclosure-ref)
 *       — or, for `check-disclosures`, at least one `open` disclosure remains.
 *       Both are "not clear": the gate is fail-closed, so an unreadable or
 *       corrupt spine blocks the archive exactly like an open disclosure does.
 *   2 — usage error (missing op/path/args, unknown op, bad state token, or a
 *       non-positive-integer `set-row-iter` / `add-disclosure --iter` <n>) or
 *       body-file read error
 */

import {
  createSpineStore,
  ensureDisclosuresSection,
  DISPOSITION_VOCABULARY,
  WAVE_SCOPE_ITER_CELL,
  type SpineIo,
  type DisclosureSource,
  defaultSpineIo,
} from './spine-store';
import { resolve } from 'node:path';
import {
  ROW_STATES,
  SPINE_STATUSES,
  renderSpine,
  setRowIter,
  readSpine,
  // The human-lane readers (ADR-0012). `humanGatedRows` is the state-BLIND view
  // (describe the lane) and `humanHeldRowIds` is the CONJUNCTION (human-gated ∧
  // still `planned`) that both the dispatch hold and the archive gate branch on.
  // Imported as a pair on purpose: the two ops below differ only in which of
  // them is the verdict, and deriving "awaiting" from the pair keeps `planned`
  // from being re-typed as a literal at a second site.
  humanGatedRows,
  humanHeldRowIds,
  HUMAN_GATED_WORKER,
  type RowState,
  type SpineMeta,
  type SpineRosterRow,
  type ConflictMap,
} from './wave-md-rw';
import { flag, printJson } from './cli-utils';
import {
  hasFlag,
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  type FlagContract,
  type OutputClass,
  type PositionalArity,
  type VerbContract,
} from './verb-contract';

/**
 * THE op vocabulary of this runner — every op it dispatches, in the order the
 * usage block prints them, each mapped to the argument spelling that follows it.
 *
 * ONE list feeds BOTH advertising surfaces: {@link printUsage} renders a line
 * per entry, and the `default:` case joins the keys into its `available:` list.
 * Before this table, each surface carried its own hand-maintained copy of the op
 * names — the exact drift the FOR-11 live-gate retro found (`set-status` was
 * missing from the router's usage) and the reason cli.spec.ts derives its
 * expectation from the `available:` message at runtime rather than transcribing
 * it. A new op is now one entry here plus its dispatch, never three edits that
 * can disagree.
 */
const SPINE_OP_ARGS: Readonly<Record<string, string>> = {
  create: '<out-path> <payload-file>',
  read: '<spine-path>',
  'set-row-state': '<spine-path> <id> <state>',
  'set-row-iter': '<spine-path> <id> <n>',
  'set-row-pr': '<spine-path> <id> <pr-cell>',
  'set-branch': '<spine-path> <id> <branch> [--model <m>]',
  'replace-closed-by': '<spine-path> <body-file>',
  'set-status': '<spine-path> <status>',
  // ONE entry, TWO forms — the wave-scoped alternative (ADR-0038) is additive,
  // so it is advertised on the same line rather than as a second op name (which
  // would change the `available:` vocabulary the FOR-11 guard reads back).
  // ADR-0051 decision 5 renamed the wave-scoped switch to `--wave-scoped` (the
  // glossary's own word, ADR-0038), because `--wave` was a spine PATH on
  // worktree-cleanup and a BOOLEAN here — one spelling, two value types, in a
  // surface a Coordinator reads flag-by-flag. `--wave` stays accepted as this
  // op's silent alias, so every existing invocation still resolves.
  'add-disclosure':
    '<spine-path> (<row-id> --iter <n> | --wave-scoped) --source <worker|reviewer|coordinator> --text <t>',
  'set-disposition': `<spine-path> <disclosure-ref> <${DISPOSITION_VOCABULARY}>`,
  'check-disclosures': '<spine-path>',
  'human-gated': '<spine-path> [--workers <a,b>]',
  'check-awaiting-human': '<spine-path> [--workers <a,b>]',
};

/** The op names, derived from {@link SPINE_OP_ARGS} — never a second copy. */
const SPINE_OPS: readonly string[] = Object.keys(SPINE_OP_ARGS);

function printUsage(): void {
  process.stderr.write(
    [
      'usage:',
      ...SPINE_OPS.map((op) => `  spine ${op} ${SPINE_OP_ARGS[op]}`),
      '',
    ].join('\n'),
  );
}

/**
 * The unknown-op refusal. DERIVED from `SPINE_OP_ARGS`, never transcribed —
 * this message IS the dispatch vocabulary, and cli.spec.ts's FOR-11 guard reads
 * it back at runtime to prove the router's own usage line names every op of it.
 *
 * Issue #650 — the summary line survives byte-for-byte (the FOR-11 guard's
 * regex captures only up to the first newline); the block below it is one line
 * per SPINE_OPS entry rendered the SAME way `printUsage()` renders it (`spine
 * <op> <args>`, straight off `SPINE_OP_ARGS`) — so a misspelled op
 * (`transition` for `set-row-state`) gets the whole vocabulary with each op's
 * own arg shape, not just a comma-separated list of bare names to re-guess
 * from.
 *
 * It moved out of the dispatch switch's `default:` case and up to the top of
 * {@link runSpine} (ADR-0051 decision 4): an unknown op is answerable from argv
 * alone, and answering it there means no spine is read and no store is built
 * first. The text is unchanged.
 */
function usageUnknownOp(op: string): number {
  process.stderr.write(
    [
      `unknown op: ${op}; available: ${SPINE_OPS.join(', ')}`,
      '',
      'ops:',
      ...SPINE_OPS.map((o) => `  spine ${o} ${SPINE_OP_ARGS[o]}`),
      '',
    ].join('\n'),
  );
  return 2;
}

/**
 * Every spine op's Verb contract (ADR-0051 decision 2), DERIVED from
 * {@link SPINE_OP_ARGS} rather than declared a second time: the `usage` line of
 * each entry is exactly the line {@link printUsage} prints, so the contract and
 * the advertising surface cannot drift the way two hand-maintained rosters
 * eventually would (the FOR-11 live-gate finding, applied one level up).
 *
 * A verb GROUP gets no named twin (decision 6): `spine <op> <spine-path> <id> …`
 * is one grammar, invoked over sixty times by the skills, and a second grammar
 * per group would breed the next misgrip class. So every op below declares its
 * positional arity and nothing is promoted to a flag.
 */
const SPINE_OP_SHAPES: Readonly<
  Record<string, { positionals: PositionalArity; output: OutputClass; flags: readonly FlagContract[] }>
> = {
  create: { positionals: fixed(2), output: 'silent-write', flags: [] },
  // Prints the spine SOURCE — the artifact itself, not a report about it.
  read: { positionals: fixed(1), output: 'product', flags: [] },
  'set-row-state': { positionals: fixed(3), output: 'silent-write', flags: [] },
  'set-row-iter': { positionals: fixed(3), output: 'silent-write', flags: [] },
  'set-row-pr': { positionals: fixed(3), output: 'silent-write', flags: [] },
  'set-branch': {
    positionals: fixed(3),
    output: 'silent-write',
    flags: [{ canonical: '--model', value: 'one', valueType: 'text' }],
  },
  'replace-closed-by': { positionals: fixed(2), output: 'silent-write', flags: [] },
  'set-status': { positionals: fixed(2), output: 'silent-write', flags: [] },
  'add-disclosure': {
    // <spine-path> plus, in the row-scoped form only, <row-id>. The wave-scoped
    // form takes the path alone.
    positionals: fixed(2),
    // Prints the disclosure-ref it minted — the thing `set-disposition`
    // addresses, so stdout IS the product.
    output: 'product',
    flags: [
      { canonical: '--iter', value: 'one', valueType: 'int' },
      { canonical: '--wave-scoped', aliases: ['--wave'], value: 'none', valueType: 'none' },
      { canonical: '--source', value: 'one', valueType: 'enum', required: true },
      { canonical: '--text', value: 'one', valueType: 'text', required: true },
    ],
  },
  'set-disposition': { positionals: fixed(3), output: 'silent-write', flags: [] },
  // Both gates print prose and answer by EXIT CODE; wave-close reads the code.
  'check-disclosures': { positionals: fixed(1), output: 'prose', flags: [] },
  'human-gated': {
    positionals: fixed(1),
    output: 'json',
    flags: [{ canonical: '--workers', value: 'one', valueType: 'list' }],
  },
  'check-awaiting-human': {
    positionals: fixed(1),
    output: 'prose',
    flags: [{ canonical: '--workers', value: 'one', valueType: 'list' }],
  },
};

function fixed(count: number): PositionalArity {
  return { kind: 'fixed', count };
}

/**
 * The spine group's contracts, keyed by op — the shapes above joined to the
 * usage line {@link SPINE_OP_ARGS} already owned.
 *
 * Root-exported (and collected by `cli.ts`'s aggregate reader) so the skill-side
 * pin and the later Catalog read ONE thing.
 */
export const SPINE_CONTRACTS: Readonly<Record<string, VerbContract>> =
  Object.fromEntries(
    Object.keys(SPINE_OP_SHAPES).map((op) => [
      op,
      {
        verb: `spine ${op}`,
        ...SPINE_OP_SHAPES[op],
        usage: [`usage: spine ${op} ${SPINE_OP_ARGS[op]}`],
      },
    ]),
  );

// ─── the human lane (ADR-0012) ───────────────────────────────────────────────
//
// Two ops over one engine predicate. They differ in KIND, not just in output,
// and that difference is the whole design:
//
//   - `human-gated` is a LISTING. It describes the lane and always exits 0 on a
//     readable spine. An empty lane is a legitimate answer, never a gate — the
//     same non-guard rule `humanHeldRowIds`' own doc states.
//   - `check-awaiting-human` is a GATE, shaped exactly like `check-disclosures`
//     above: its RESULT is the exit code, it is fail-closed in both directions
//     (a held row blocks; so does a spine that cannot be read), and `wave-close`
//     phase 6 branches on that code alone — never on this prose.

/** The one row shape both ops below report — the lane, as data. */
interface HumanLaneRow {
  id: string;
  title: string;
  worker: string;
  state: string;
  /** human-gated ∧ still `planned` — i.e. no human has released it yet. */
  awaitingHuman: boolean;
}

/**
 * Resolve the accepted human-gated Worker token set for one invocation.
 * `Worker` is a config-governed enum (ADR-0007), so the engine constant is a
 * DEFAULT, never a law: `--workers a,b` substitutes a consumer's own spelling.
 * An explicitly EMPTY `--workers ''` is honoured as the empty set (a fully
 * trimmed vocabulary holds nothing) rather than silently re-defaulting.
 */
function humanGatedWorkerSet(contract: VerbContract, args: string[]): readonly string[] {
  const raw = flag(args, contract, 'workers');
  if (raw === undefined) return [HUMAN_GATED_WORKER];
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Read `spinePath` through the injected {@link SpineIo} and project its human
 * lane. Throws whatever the read or `readSpine` throws — both callers turn that
 * into their own fail-closed exit.
 *
 * `awaitingHuman` is derived by JOINING the two engine readers rather than by
 * re-testing `state === 'planned'` here: the held-state literal has exactly one
 * owner (`HELD_ROW_STATE`, wave-md-rw.ts) and a second copy at this call site
 * would be precisely the drift that owner exists to stop.
 */
function readHumanLane(
  spinePath: string,
  workers: readonly string[],
  io: SpineIo,
): HumanLaneRow[] {
  const spine = readSpine(io.read(spinePath));
  const held = new Set(humanHeldRowIds(spine, workers));
  return humanGatedRows(spine, workers).map((row) => ({
    id: row.id,
    title: row.title,
    worker: row.worker,
    state: String(row.state),
    awaitingHuman: held.has(row.id),
  }));
}

/**
 * Run `spine human-gated <spine-path> [--workers <a,b>]` — the listing.
 *
 * Emits one JSON object: the accepted token set, every human-gated row with its
 * state and its `awaitingHuman` verdict, and the ids still awaiting a human.
 * A wave with no human lane emits `rows: []` and exits 0 — that is the answer,
 * not a failure, so nothing downstream may guard on emptiness.
 *
 * Exit codes:
 *   0 — the spine was read (with OR without a human lane)
 *   1 — the spine could not be read or parsed
 *   2 — missing <spine-path>
 */
function runSpineHumanGated(args: string[], io: SpineIo): number {
  const contract = SPINE_CONTRACTS['human-gated'];
  const spinePath = positionalsOf(contract, args)[0];
  if (!spinePath) {
    process.stderr.write(
      [
        'error: spine human-gated requires a <spine-path>',
        'usage: flotilla-engine spine human-gated <spine-path> [--workers <a,b>]',
        '',
      ].join('\n'),
    );
    return 2;
  }
  const workers = humanGatedWorkerSet(contract, args);
  let rows: HumanLaneRow[];
  try {
    rows = readHumanLane(resolve(spinePath), workers, io);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
  printJson({
    ok: true,
    verb: 'spine human-gated',
    spine: resolve(spinePath),
    humanGatedWorkers: workers,
    rows,
    awaitingHumanIds: rows.filter((r) => r.awaitingHuman).map((r) => r.id),
  });
  return 0;
}

/**
 * Run `spine check-awaiting-human <spine-path> [--workers <a,b>]` — the
 * fail-closed ARCHIVE gate for the human lane (wave-close phase 6).
 *
 * The hazard it closes is specific, and it is what separates an awaiting-human
 * row from every other non-terminal shape: the row's tracker claim is STILL
 * LIVE (`queued`). It was never dispatched, so nothing ever released it.
 * Archive past it and the issue reads as claimed to every future `wave-plan`,
 * with no live spine left to reconcile against — a leak with no self-healing
 * path, which is why this is a gate and not an advisory.
 *
 * It deliberately does NOT fire on a `parked` row (ADR-0022): park is terminal
 * AND claim-releasing, so a parked row has already left `planned` and dropped
 * out of the predicate. That is not a special case here — it is the reason park
 * is one of the two exits the block message names.
 *
 * Fail-closed in both directions, exactly like `spine check-disclosures`: a held
 * row blocks the archive, and so does a spine that cannot be read or parsed.
 *
 * Exit codes:
 *   0 — no human-gated row holds a live claim; the archive gate is CLEAR
 *   1 — at least one row is awaiting a human, OR the spine is unreadable
 *   2 — missing <spine-path>
 */
function runSpineCheckAwaitingHuman(args: string[], io: SpineIo): number {
  const contract = SPINE_CONTRACTS['check-awaiting-human'];
  const spinePath = positionalsOf(contract, args)[0];
  if (!spinePath) {
    process.stderr.write(
      [
        'error: spine check-awaiting-human requires a <spine-path>',
        'usage: flotilla-engine spine check-awaiting-human <spine-path> [--workers <a,b>]',
        '',
      ].join('\n'),
    );
    return 2;
  }
  const workers = humanGatedWorkerSet(contract, args);
  const abs = resolve(spinePath);
  let rows: HumanLaneRow[];
  try {
    rows = readHumanLane(abs, workers, io);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }

  const awaiting = rows.filter((r) => r.awaitingHuman);
  if (awaiting.length === 0) {
    process.stdout.write(
      `awaiting-human: 0 of ${rows.length} human-gated rows — archive gate CLEAR\n`,
    );
    return 0;
  }

  process.stdout.write(
    [
      `awaiting-human: ${awaiting.length} of ${rows.length} human-gated rows — archive gate BLOCKED (see .claude/skills/wave-close/reference/phase-6-archive.md)`,
      ...awaiting.map(
        (r) => `  row ${r.id}  worker ${r.worker}  state ${r.state}  ${r.title}`,
      ),
      // The claim is the hazard, so the message leads with it — an operator who
      // reads only the first line must still learn WHY this is not skippable.
      "each row above still holds a LIVE `queued` claim: it was never dispatched, so nothing released it. Archiving now leaves the issue reading as claimed to every future wave-plan, with no live spine to reconcile against.",
      'two exits, and only these two:',
      '  1. THE HUMAN ACTS — do the gated work, then let wave-start dispatch the row.',
      '     It leaves `planned`, stops matching this gate, and the wave finishes normally.',
      `  2. PARK + UNCLAIM — the row leaves the wave for re-planning:`,
      `       flotilla-engine spine set-row-state ${abs} <id> parked`,
      '       flotilla-engine issue-store unclaim <id>',
      '     `parked` is terminal AND claim-releasing, so the row drops out of this gate.',
      '',
    ].join('\n'),
  );
  return 1;
}

export function runSpine(args: string[], io: SpineIo = defaultSpineIo()): number {
  const op = args[0];
  if (op === undefined) {
    printUsage();
    return 2;
  }

  // `spine --help` — no op named yet, so the answer is the whole op roster, on
  // stdout, exit 0 (ADR-0051 decision 7).
  if (op === '--help') {
    process.stdout.write(
      ['usage:', ...SPINE_OPS.map((o) => `  spine ${o} ${SPINE_OP_ARGS[o]}`), ''].join('\n'),
    );
    return 0;
  }

  // ── The op's contract decides everything argv alone can decide ────────────
  //
  // An unknown op, a `--help`, and any undeclared flag or stray positional are
  // all answered here, before the spine is read or any store is constructed
  // (ADR-0051 decision 4 + 7). The unknown-op message is byte-identical to the
  // `default:` case it replaces — cli.spec.ts's FOR-11 guard reads it back at
  // runtime to prove the router's own usage line names every op of it.
  const contract = SPINE_CONTRACTS[op];
  if (contract === undefined) return usageUnknownOp(op);
  const opArgs = args.slice(1);
  if (helpRequested(contract, opArgs)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, opArgs);
  if (refusal !== 0) return refusal;

  // Positionals read through the contract, so a flag's VALUE can never be
  // mistaken for one (`--text "--wave"` is prose, and always was — this is the
  // same step-over the hand-rolled `hasBareFlag` used to perform for one flag,
  // now performed for every op by one reader).
  const positionals = positionalsOf(contract, opArgs);

  // `create` renders a NEW spine — there is no existing file to load, so it
  // cannot use the shared createSpineStore(path) path below.
  if (op === 'create') {
    const outPath = positionals[0];
    const payloadFile = positionals[1];
    if (!outPath || !payloadFile) {
      printUsage();
      return 2;
    }
    let payload: { meta: SpineMeta; roster: SpineRosterRow[]; conflict: ConflictMap; dorCheck: string };
    try {
      payload = JSON.parse(io.read(payloadFile));
    } catch (err) {
      process.stderr.write(`error: could not read/parse payload "${payloadFile}": ${(err as Error).message}\n`);
      return 2;
    }
    // ADR-0027: every freshly created wave carries the `## Disclosures` section
    // from birth, so the routing-time capture verb never has to grow one and the
    // archive gate always has a section to count. Composed here rather than
    // inside `renderSpine` because `wave-md-rw.ts` is outside this slice's
    // declared Files — `ensureDisclosuresSection` is idempotent, so folding the
    // call into `renderSpine` later is a pure move, not a behaviour change.
    // `spine create` is the ONLY path that produces a real wave's spine, so
    // every wave gets the section either way.
    const source = ensureDisclosuresSection(
      renderSpine(payload.meta, payload.roster, payload.conflict, payload.dorCheck),
    );
    io.write(outPath, source);
    return 0;
  }

  // The human lane (ADR-0012). Handled ahead of the shared `<spine-path>`
  // presence guard below because each op owns its own usage message — one that
  // NAMES the op and its `--workers` flag — and its own exit-code contract,
  // neither of which the generic guard can express. Folded here from `cli.ts`'s
  // `spine` router case as a pure move (issue #366); see this file's header.
  if (op === 'human-gated' || op === 'check-awaiting-human') {
    const laneArgs = args.slice(1);
    return op === 'human-gated'
      ? runSpineHumanGated(laneArgs, io)
      : runSpineCheckAwaitingHuman(laneArgs, io);
  }

  const path = positionals[0];

  if (!op || !path) {
    printUsage();
    return 2;
  }

  // `set-row-iter` has no SpineStore method (spine-store.ts is unchanged by
  // FOR-53) — it reads + writes the file directly through the wave-md-rw
  // writer, so it is handled here, ahead of the generic
  // createSpineStore/apply/store.flush() flow below (which would otherwise
  // flush the STORE's pristine, unmutated source over this op's own write).
  if (op === 'set-row-iter') {
    const id = positionals[1];
    const iterRaw = positionals[2];
    if (!id || iterRaw === undefined) {
      printUsage();
      return 2;
    }
    const iter = Number(iterRaw);
    // Fail loud at the CLI boundary — mirrors set-row-state's token check:
    // the writer accepts any number, so an unvalidated typo (non-numeric,
    // zero, negative, fractional) would silently corrupt durable state.
    if (!Number.isInteger(iter) || iter < 1) {
      process.stderr.write(
        `error: invalid iter "${iterRaw}"; expected a positive integer\n`,
      );
      return 2;
    }
    try {
      const next = setRowIter(io.read(path), id, iter);
      io.write(path, next);
      return 0;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      return 1;
    }
  }

  // `check-disclosures` is the fail-closed archive gate (ADR-0027). It mutates
  // nothing and — unlike every op below — its RESULT is the exit code, which the
  // generic flow (always 0 on success) cannot express. So it is handled here,
  // alongside `set-row-iter`, ahead of that flow.
  //
  // Fail-closed in both directions: an open disclosure blocks the archive, and so
  // does a spine that cannot be read or parsed. `wave-close` branches on this
  // code alone — it never reads the prose below (ADR-0027 rejected the
  // grep-the-markdown gate: the #141 class).
  if (op === 'check-disclosures') {
    try {
      const store = createSpineStore(path, io);
      const open = store.openDisclosures();
      const total = store.disclosures().length;
      if (open.length === 0) {
        process.stdout.write(
          `disclosures: 0 open of ${total} — archive gate CLEAR\n`,
        );
        return 0;
      }
      process.stdout.write(
        [
          `disclosures: ${open.length} open of ${total} — archive gate BLOCKED`,
          ...open.map(
            (d) =>
              // A wave-scoped entry (ADR-0038) has no iteration — print the same
              // house marker the spine itself carries, never `null`. Row-scoped
              // lines are byte-identical to before.
              `  ${d.ref}  row ${d.rowId}  iter ${d.iter ?? WAVE_SCOPE_ITER_CELL}  (${d.source})  ${d.text}`,
          ),
          `disposition each: spine set-disposition ${path} <ref> <${DISPOSITION_VOCABULARY}>`,
          '',
        ].join('\n'),
      );
      return 1;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      return 1;
    }
  }

  // ── Arg-presence + token validation FIRST (all usage errors → 2). These run
  // before the try/catch so a usage 2 is never reclassified as a domain 1. The
  // `apply` closure carries the validated mutation into the single try/catch
  // below, where any spine-mutator throw (bad row id, missing section) becomes a
  // clean domain-failure exit 1 — never an uncaught stack trace.
  let apply: (store: ReturnType<typeof createSpineStore>) => void;

  // `add-disclosure` reports the ref it minted — captured here and printed only
  // AFTER the flush succeeds, so stdout never advertises a ref that never landed.
  let createdRef: string | null = null;

  switch (op) {
    case 'read': {
      apply = (store) => process.stdout.write(store.source() + '\n');
      break;
    }

    case 'set-row-state': {
      const id = positionals[1];
      const state = positionals[2];
      if (!id || !state) {
        printUsage();
        return 2;
      }
      // Validate the state token at the CLI boundary: the spine writer writes
      // ANY string verbatim, so an unvalidated typo would silently corrupt
      // durable state. Mirror issue-store-cli's rung check — fail loud (return 2).
      if (!(ROW_STATES as readonly string[]).includes(state)) {
        process.stderr.write(
          `error: invalid state "${state}"; expected one of: ${ROW_STATES.join(', ')}\n`,
        );
        return 2;
      }
      apply = (store) => store.setRowState(id, state as RowState);
      break;
    }

    case 'set-row-pr': {
      const id = positionals[1];
      const prCell = positionals[2];
      if (!id || prCell === undefined) {
        printUsage();
        return 2;
      }
      apply = (store) => store.setRowPrCell(id, prCell);
      break;
    }

    case 'replace-closed-by': {
      const bodyFile = positionals[1];
      if (!bodyFile) {
        printUsage();
        return 2;
      }
      let body: string;
      try {
        body = io.read(bodyFile);
      } catch (err) {
        process.stderr.write(
          `error: could not read body-file "${bodyFile}": ${(err as Error).message}\n`,
        );
        return 2;
      }
      apply = (store) => store.replaceClosedByBlock(body);
      break;
    }

    case 'set-branch': {
      // Records a dispatched row's branch (the DURABLE branch home, ADR-0021) in
      // the Resume-Metadata dispatch-log — resume() joins worktrees to rows by
      // this branch. Optional `--model <m>` co-records the dispatched model
      // (ADR-0012). Mirrors set-row-pr's exit semantics (0/1/2).
      const id = positionals[1];
      const branch = positionals[2];
      if (!id || !branch) {
        printUsage();
        return 2;
      }
      let model: string | undefined;
      if (hasFlag(contract, args, 'model')) {
        model = flag(args, contract, 'model');
        if (!model) {
          printUsage();
          return 2;
        }
      }
      apply = (store) => {
        store.upsertDispatchLogEntry(id, branch);
        if (model) store.upsertDispatchLogModel(id, model);
      };
      break;
    }

    case 'set-status': {
      const status = positionals[1];
      if (!status) {
        printUsage();
        return 2;
      }
      if (!(SPINE_STATUSES as readonly string[]).includes(status)) {
        process.stderr.write(
          `error: invalid status "${status}"; expected one of: ${SPINE_STATUSES.join(', ')}\n`,
        );
        return 2;
      }
      apply = (store) => store.setFrontmatterStatus(status);
      break;
    }

    case 'add-disclosure': {
      const rowId = positionals[1];
      const iterRaw = flag(args, contract, 'iter');
      const sourceRaw = flag(args, contract, 'source');
      const text = flag(args, contract, 'text');

      // ── The wave-scoped form (ADR-0038), additive on this same op ──────────
      // Both forms need `--source` + `--text`; only this one is legal WITHOUT a
      // <row-id> and WITHOUT `--iter`, and mixing the two spellings is a usage
      // error rather than a silent preference for one of them.
      //
      // `hasFlag` resolves BOTH spellings of the switch — the canonical
      // `--wave-scoped` and its `--wave` alias (ADR-0051 decision 5) — and steps
      // over every value-taking flag while it looks, so `--text "--wave"` stays
      // prose. That step-over used to be this file's own `hasBareFlag`, with its
      // own hand-listed table of which flags carry a value; the contract now
      // states that per flag, so the list cannot go stale when a flag is added.
      if (hasFlag(contract, args, 'wave-scoped')) {
        if (sourceRaw === undefined || text === undefined) {
          printUsage();
          return 2;
        }
        if (rowId !== undefined || iterRaw !== undefined) {
          process.stderr.write(
            'error: --wave-scoped takes no <row-id> and no --iter — pass --wave-scoped alone with --source and --text to add a wave-scoped disclosure\n',
          );
          return 2;
        }
        // `--source` / `--text` are NOT checked here — same split as below: the
        // store's constructor owns those invariants (and the wave-scoped one
        // owns the sentinel-collision refusal), landing as exit 1.
        apply = (store) => {
          createdRef = store.addWaveDisclosure({
            source: sourceRaw as DisclosureSource,
            text,
          }).ref;
        };
        break;
      }

      // An omitted <row-id> no longer lets the first flag slide into its slot —
      // the contract-aware positional read never yields a flag token — so this
      // guard is now simply "the row-scoped form needs all four".
      if (
        !rowId ||
        iterRaw === undefined ||
        sourceRaw === undefined ||
        text === undefined
      ) {
        printUsage();
        return 2;
      }
      const iter = Number(iterRaw);
      if (!Number.isInteger(iter) || iter < 1) {
        process.stderr.write(
          `error: invalid --iter "${iterRaw}"; expected a positive integer\n`,
        );
        return 2;
      }
      // `--source` / `--text` / `<row-id>` are NOT checked here — the store's
      // constructor owns those invariants (see the NOTE in this file's header);
      // an out-of-vocabulary source throws there and lands as exit 1.
      apply = (store) => {
        createdRef = store.addDisclosure({
          rowId,
          iter,
          source: sourceRaw as DisclosureSource,
          text,
        }).ref;
      };
      break;
    }

    case 'set-disposition': {
      const ref = positionals[1];
      const disposition = positionals[2];
      if (!ref || !disposition) {
        printUsage();
        return 2;
      }
      // The vocabulary check lives in the store and throws → exit 1 with the
      // spine untouched (the throw happens before flush).
      apply = (store) => store.setDisposition(ref, disposition);
      break;
    }

    default:
      // Unreachable: `SPINE_CONTRACTS[op]` is resolved at the top of this
      // function and an unknown op returns {@link usageUnknownOp} there, before
      // any spine is read. Kept as the exhaustiveness floor.
      return usageUnknownOp(op);
  }

  // ── Store construction + the (possibly throwing) mutation + flush. A throw
  // here is a domain failure (bad row id, missing section) → clean exit 1.
  try {
    const store = createSpineStore(path, io);
    apply(store);
    // `read` is non-mutating; flushing it is a harmless byte-identical no-op.
    if (op !== 'read') store.flush();
    if (createdRef) process.stdout.write(createdRef + '\n');
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
//
// COLLAPSED onto the router (issue #77): rather than dispatching a second time
// here, the direct-module invocation is forwarded to `cli.ts`'s `spine` case —
// which routes straight back to `runSpine` above. `npx tsx
// tools/wave/src/spine-cli.ts <op> …` therefore stays a working ALIAS for
// `{{wave-cli}} spine <op> …` (the `wave-close` mechanics still document it),
// with exactly one dispatch path in the engine instead of two.
//
// `require` (not a static `import`) on purpose: `cli.ts` imports THIS module for
// its `spine` case, so a top-level import would be a load-order cycle. This line
// runs only when this file is the process entrypoint, after its own exports are
// fully initialised, so the require resolves a complete module either way.
if (require.main === module) {
  const { main } = require('./cli') as typeof import('./cli');
  process.exit(main(['spine', ...process.argv.slice(2)]));
}
