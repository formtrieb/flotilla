/**
 * route-cli.ts — the THIN top-level routers + the paired sidecar WRITE verbs
 * (P7.4 + FOR-6/ADR-0024), siblings of closed-by / detect-host. Each wraps an
 * already-tested library function and adds no domain logic of its own (mirrors
 * runClosedBy / runDetectHost in cli.ts):
 *
 *   route-verdict    verdictToRouting(verdict, iteration, risk, ruling?) → transition(state, event, risk)
 *   route-outcome    outcomeToEvent(outcome)                  → transition(state, event)
 *   validate-report  validateWorkerReport(JSON.parse(file))
 *   validate-verdict validateReviewerVerdict(JSON.parse(file))
 *   write-report     validateWorkerReport   → render sidecar.ts-readable <id>-<iter>.md
 *   write-verdict    validateReviewerVerdict → render sidecar.ts-readable <id>-<iter>.md
 *
 * The wave-reviewer / wave-start skills shell these so the routing event + the
 * state-machine outcome are computed by the tested engine, never hand-synthesised
 * in skill prose (the G3 failure class). The write verbs give the sidecar format
 * a single engine owner — the printer paired with the sidecar.ts reader (the way
 * renderSpine is paired with readSpine, ADR-0016) — so the Scribe stages of the
 * wave-start driver persist a durable record the moment the work exists (ADR-0024),
 * never a hand-formatted one. The library exports stay the single source of truth;
 * this file only parses flags and shapes JSON, files, and exit codes.
 *
 * route-verdict / route-outcome exit codes:
 *   0 — routed (JSON { event, outcome } on stdout; route-verdict adds a `ruled`
 *       object — the cell and the Operator's ruling — on an above-cap ruled round)
 *   1 — the library rejected an input (out-of-enum verdict/outcome/risk/state, an
 *       above-cap iteration with no ruling, or a ruling that states no reason)
 *   2 — usage (a required flag is missing, or `--ruling` was passed no value)
 *
 * validate-report / validate-verdict exit codes:
 *   0 — valid ("valid" on stdout)
 *   1 — invalid (the errors[] on stderr)
 *   2 — usage / unreadable-or-unparseable file
 *   `--json` prints `{ verb, file, valid, errors }` on stdout instead of the
 *   prose, on both the 0 and the 1 outcome, and moves neither code.
 *
 * write-report / write-verdict exit codes (mirror validate-*):
 *   0 — written (absolute path of the written file on stdout; `--json` prints
 *       `{ verb, path, id, iter }` there instead, and the notice:/warning:
 *       findings below stay on stderr either way). A `notice:` line
 *       on stderr means a decorated `report.issue` was NORMALIZED on the way in,
 *       or that a FINISHING report reached the write with no usable `prUrl`
 *       (issue #556 — a finding about the report, never a refusal of it);
 *       a `warning:` line means MISNAMED litter was found in the target dir.
 *   1 — invalid payload / `report.issue` names a different row than --id (NOTHING written)
 *   2 — usage / unreadable-or-unparseable <json-file> / a --id that is not a bare id
 *
 * ## Why `--id` is validated and `report.issue` is repaired (issue #138)
 *
 * The two flags come from opposite places. `--id` is the COMPOSE-TIME row id, set
 * by the Coordinator; `issue` is authored by an agent that was told the field's
 * name and nothing about its shape. The verb used to validate a *relationship*
 * between them and refuse on mismatch — which put the refusal where it could not
 * be obeyed: given a refusal, the caller varies the argument it controls, and a
 * Scribe that reached for `--id "<the decorated string>"` turned a loud refusal
 * into `#126-1.md` — a real file, listed by `ls`, that the reader can never
 * resolve for row `126`. So the two halves are now treated asymmetrically:
 *
 *  - **`--id` is validated against the bare-id shape rule and never repaired**
 *    (exit 2). Varying it is not a way past a refusal any more; it is the
 *    refusal, and the message says so.
 *  - **`report.issue` IS repaired** when it decorates the same id (exit 0 + a
 *    loud `notice:`), and refused only when it names a genuinely different row.
 *    A decorated payload therefore no longer produces a refusal for a caller to
 *    route around — there is nothing left to route around.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag, printJson } from './cli-utils';
import { verdictToRouting, type Verdict } from './verdict-to-event';
import {
  finishingReportLacksUsablePrUrl,
  outcomeToEvent,
  validateWorkerReport,
  type WorkerOutcome,
} from './worker-report-schema';
import { validateReviewerVerdict } from './reviewer-verdict-schema';
import {
  bareIssueIdViolation,
  findMisnamedSidecars,
  normalizeIssueRef,
  type MisnamedSidecar,
  type SidecarReader,
} from './sidecar';
import { transition, type IssueState } from './stop-condition-state-machine';
import type { Risk } from './header-parser';
import {
  defineVerb,
  hasFlag,
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  resolveTwin,
  type JsonNote,
  type VerbContract,
} from './verb-contract';

// ─── `--json` on this module's four prose verbs (ADR-0051 decision 7, V5) ────
//
// **ONE table, two readers**, the discipline `RECEIPT_SHAPES` established in
// spine-cli.ts: each shape below is rendered into its verb's own `usage` (what
// `--help` and every refusal print, and what cli.ts's roster reads back through
// `jsonFormNote`) AND is the shape the runner builds. An advertised shape and an
// emitted shape maintained separately are two vocabularies that can disagree,
// and the emitted one is the half a caller cannot see until after the call.
//
// `--json` REPLACES the prose answer; it never rides beside it. Without the flag
// all four print today's bytes exactly, and the flag moves no exit code: an
// invalid payload still exits 1 — with its errors in the JSON rather than as the
// `invalid:` block on stderr.
//
// What deliberately does NOT move onto stdout with the flag: the `notice:` and
// `warning:` lines the two write verbs emit. Those are findings ABOUT the record
// and its directory, not the result of the call, they are already on stderr, and
// a caller reading stdout as JSON keeps reading them exactly where it did.

/** The shape each prose verb here answers `--json` with. ONE owner per verb. */
const JSON_SHAPES: Readonly<Record<string, string>> = {
  'validate-report': '{ verb, file, valid, errors }',
  'validate-verdict': '{ verb, file, valid, errors }',
  // The three facts a caller needs in order to find the record again: WHERE it
  // landed, and the (id, iter) pair the sidecar reader resolves it by. `path` is
  // the very string the prose form prints, so the two renderings never name two
  // different files.
  'write-report': '{ verb, path, id, iter }',
  'write-verdict': '{ verb, path, id, iter }',
};

/** The `--json:` clause each of those four declares, off {@link JSON_SHAPES}. */
function jsonNote(
  verb: keyof typeof JSON_SHAPES & string,
  lead: string,
  continuation?: readonly string[],
): JsonNote {
  return continuation === undefined
    ? { lead, shape: JSON_SHAPES[verb] }
    : { lead, shape: JSON_SHAPES[verb], continuation };
}

/**
 * What `validate-report` / `validate-verdict` answer `--json` with.
 *
 * `errors` is present on BOTH outcomes — `[]` when the payload validated. An
 * empty list is not a claim the receipt cannot support (the way a `"model":
 * null` would be, one module over): it says zero errors, which is exactly what
 * was found. A caller therefore reads `.errors` without first branching on
 * `.valid`.
 */
interface ValidateJsonResult {
  readonly verb: string;
  readonly file: string;
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * What `write-report` / `write-verdict` answer `--json` with — printed only
 * AFTER the bytes are on disk, which is what makes "never changes an exit code"
 * structural rather than asserted: every refusal above the write returns before
 * this shape is built, so a failed run prints no receipt at all.
 */
interface WriteSidecarJsonResult {
  readonly verb: string;
  readonly path: string;
  readonly id: string;
  readonly iter: number;
}

/**
 * The `outcome` field both routing verbs print — the state machine's
 * {@link Outcome} union, as the shape clause states it (issue #913).
 *
 * `type` is the discriminant and the other keys follow from it, so a flat key
 * list would be a lie about three of the four members. Declared once because
 * both verbs print the identical field: `route-verdict` and `route-outcome`
 * differ in how they DERIVE the event, never in what `transition` hands back.
 */
const ROUTE_OUTCOME_SHAPE =
  '{ type: <transition>, nextState } | { type: <stop>, reason, severity } | ' +
  '{ type: <warn>, reason } | { type: <noop> }';

/**
 * The six verbs this module runs, each declaring its own contract beside its own
 * runner (ADR-0051 decision 2).
 *
 * Two of ADR-0051's four measured axes are settled HERE, and this file is where
 * the drift was most visible: `route-cli.ts` carried BOTH `--iter` and
 * `--iteration` for one axis, in one file.
 *
 *   - **The iteration is `--iter`** (decision 3: the spelling of the family with
 *     the most verbs — write-report, write-verdict, route-tuple, spine
 *     add-disclosure). `route-verdict` keeps `--iteration` as its silent alias.
 *   - **The directories are `--reports-dir` / `--verdicts-dir`** (decision 3: a
 *     tie goes to the spelling that NAMES the thing — `--verdicts-dir` says
 *     which directory, `--dir` does not). `--dir` stays as each write verb's
 *     alias, and resolves to a DIFFERENT canonical on each of them: possible
 *     only because a contract is per verb.
 *
 * `write-report` and `write-verdict` are two of decision 6's five named twins:
 * the `<json-file>` a sibling verb would take as a flag is accepted as
 * `--report-file` / `--verdict-file` (canonical) or as the leading positional
 * (its alias), never as both.
 */
export const ROUTE_CONTRACTS: Readonly<Record<string, VerbContract>> = {
  'route-verdict': defineVerb({
    verb: 'route-verdict',
    flags: [
      // `--verdict` here is the ENUM — approve | changes-requested | question.
      // It is the one spelling decision 5 keeps polymorphism-free by renaming
      // the OTHER side: route-tuple's file path became `--verdict-file`.
      { canonical: '--verdict', value: 'one', valueType: 'enum', required: true, placeholder: '<v>' },
      { canonical: '--iter', aliases: ['--iteration'], value: 'one', valueType: 'int', required: true },
      { canonical: '--risk', value: 'one', valueType: 'enum', required: true, placeholder: '<r>' },
      { canonical: '--state', value: 'one', valueType: 'enum', required: true, placeholder: '<s>' },
      { canonical: '--ruling', value: 'one', valueType: 'text' },
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  --iteration is accepted as an alias of --iter.',
      "  --ruling <text> is the Operator's stated reason for a Reviewer-only round ABOVE the",
      '  re-dispatch cap, and the only thing that admits an iteration above it.',
    ],
    outputNote: 'JSON',
    // Issue #913. The `output:` line used to carry this as prose and stopped at
    // the top level, so `outcome` — a four-member discriminated union, and the
    // only field a caller branches on — had no stated shape at all. Read off the
    // `printJson` call in `runRouteVerdict`, then confirmed by running all three
    // branches (transition, noop + ruled, and a stop).
    json: {
      shape: `{ event, outcome: ${ROUTE_OUTCOME_SHAPE}, ruled?: { cell, ruling } }`,
      trail: 'ruled rides along ONLY on an above-cap Operator-ruled round',
    },
  }),
  'route-outcome': defineVerb({
    verb: 'route-outcome',
    flags: [
      { canonical: '--outcome', value: 'one', valueType: 'enum', required: true, placeholder: '<o>' },
      { canonical: '--state', value: 'one', valueType: 'enum', required: true, placeholder: '<s>' },
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    outputNote: 'JSON',
    json: { shape: `{ event, outcome: ${ROUTE_OUTCOME_SHAPE} }` },
  }),
  'validate-report': defineVerb({
    verb: 'validate-report',
    flags: [],
    positionals: { kind: 'fixed', count: 1, labels: ['<file>'] },
    output: 'prose',
    outputNote: 'text ("valid"), not JSON; the errors[] on stderr when invalid',
    json: jsonNote('validate-report', 'the same answer as JSON on stdout, valid or not'),
  }),
  'validate-verdict': defineVerb({
    verb: 'validate-verdict',
    flags: [],
    positionals: { kind: 'fixed', count: 1, labels: ['<file>'] },
    output: 'prose',
    outputNote: 'text ("valid"), not JSON; the errors[] on stderr when invalid',
    json: jsonNote('validate-verdict', 'the same answer as JSON on stdout, valid or not'),
  }),
  'write-report': defineVerb({
    verb: 'write-report',
    flags: [
      { canonical: '--report-file', value: 'one', valueType: 'path' },
      { canonical: '--reports-dir', aliases: ['--dir'], value: 'one', valueType: 'dir', required: true },
      { canonical: '--id', value: 'one', valueType: 'id', required: true },
      { canonical: '--iter', value: 'one', valueType: 'int', required: true },
    ],
    positionals: { kind: 'fixed', count: 1, labels: ['<json-file>'] },
    output: 'prose',
    twin: [{ flag: '--report-file', label: '<json-file>' }],
    notes: [
      '  --dir is accepted as an alias of --reports-dir. The payload file is named EITHER',
      '  by --report-file or as the leading positional — never both (a mixed call is a usage error).',
    ],
    outputNote: 'text (the written file path), not JSON',
    json: jsonNote('write-report', 'the same path, with the id and iteration it was filed under', [
      '  The notice:/warning: findings stay on stderr under --json — they are about the record, not the result.',
    ]),
  }),
  'write-verdict': defineVerb({
    verb: 'write-verdict',
    flags: [
      { canonical: '--verdict-file', value: 'one', valueType: 'path' },
      { canonical: '--verdicts-dir', aliases: ['--dir'], value: 'one', valueType: 'dir', required: true },
      { canonical: '--id', value: 'one', valueType: 'id', required: true },
      { canonical: '--iter', value: 'one', valueType: 'int', required: true },
    ],
    positionals: { kind: 'fixed', count: 1, labels: ['<json-file>'] },
    output: 'prose',
    twin: [{ flag: '--verdict-file', label: '<json-file>' }],
    notes: [
      '  --dir is accepted as an alias of --verdicts-dir. The payload file is named EITHER',
      '  by --verdict-file or as the leading positional — never both (a mixed call is a usage error).',
    ],
    outputNote: 'text (the written file path), not JSON',
    json: jsonNote('write-verdict', 'the same path, with the id and iteration it was filed under', [
      '  The notice:/warning: findings stay on stderr under --json — they are about the record, not the result.',
    ]),
  }),
};

/**
 * The shared entry gate for every verb in this module: answer `--help` from the
 * contract (constructing nothing), then refuse anything the contract does not
 * declare (ADR-0051 decision 4). Returns `null` when the call may proceed.
 */
function gate(contract: VerbContract, args: string[]): number | null {
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  return refusal === 0 ? null : refusal;
}

/**
 * `route-verdict --verdict <v> --iteration <n> --risk <r> --state <s> [--ruling <text>]`.
 * Wraps verdictToRouting → transition. The library throws (TypeError/RangeError)
 * on any out-of-enum/out-of-range input — we catch and map to exit 1 so a bad
 * subagent return is a loud failure, never a silent mis-route.
 *
 * `--ruling` is the Operator's stated reason for a **Reviewer-only round above
 * the re-dispatch cap**, and it is the ONLY thing that admits an iteration above
 * it. Without the flag an above-cap iteration is refused exactly as it always
 * was; with it, the printed result grows a `ruled` object naming the cell and
 * quoting the ruling, so the round is auditable from the verb's own output
 * rather than from a Coordinator's memory. Cap accounting is untouched: a ruled
 * approve routes to the state an ordinary approve reaches, and a ruled
 * changes-requested lands on the cap-exhaustion STOP rather than buying a round.
 */
export function runRouteVerdict(args: string[]): number {
  const contract = ROUTE_CONTRACTS['route-verdict'];
  const gated = gate(contract, args);
  if (gated !== null) return gated;
  const verdict = flag(args, contract, 'verdict');
  // Resolves `--iter` (canonical) OR `--iteration` (the alias every existing
  // skill invocation still spells) through the one contract — ADR-0051's
  // iteration axis, settled.
  const iterationRaw = flag(args, contract, 'iter');
  const risk = flag(args, contract, 'risk');
  const state = flag(args, contract, 'state');
  const ruling = flag(args, contract, 'ruling');
  if (verdict === undefined || iterationRaw === undefined || risk === undefined || state === undefined) {
    process.stderr.write(
      'error: route-verdict requires --verdict <v> --iter <n> --risk <r> --state <s> [--ruling <text>]\n',
    );
    return 2;
  }
  // A bare trailing `--ruling` reads as "no ruling" to the flag parser, which
  // would surface as the out-of-range refusal — a message about the iteration
  // for a mistake about the flag. Name the real fault instead.
  if (ruling === undefined && hasFlag(contract, args, 'ruling')) {
    process.stderr.write(
      "error: route-verdict: --ruling takes the Operator's reason as its value — the ruling IS the reason,\n" +
        '  so pass it as a quoted sentence a reader can quote back.\n',
    );
    return 2;
  }
  const iteration = Number(iterationRaw);
  try {
    const routing = verdictToRouting(verdict as Verdict, iteration, risk as Risk, ruling);
    const outcome = transition(state as IssueState, routing.event, risk as Risk);
    printJson(
      routing.ruled === undefined
        ? { event: routing.event, outcome }
        : { event: routing.event, outcome, ruled: routing.ruled },
    );
    return 0;
  } catch (err) {
    process.stderr.write(`error: route-verdict: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * `route-outcome --outcome <o> --state <s>`.
 * Wraps outcomeToEvent → transition. The library throws on an out-of-enum
 * outcome; transition throws on a corrupt state — both map to exit 1.
 */
export function runRouteOutcome(args: string[]): number {
  const contract = ROUTE_CONTRACTS['route-outcome'];
  const gated = gate(contract, args);
  if (gated !== null) return gated;
  const outcomeArg = flag(args, contract, 'outcome');
  const state = flag(args, contract, 'state');
  if (outcomeArg === undefined || state === undefined) {
    process.stderr.write('error: route-outcome requires --outcome <o> --state <s>\n');
    return 2;
  }
  try {
    const event = outcomeToEvent(outcomeArg as WorkerOutcome);
    const outcome = transition(state as IssueState, event);
    printJson({ event, outcome });
    return 0;
  } catch (err) {
    process.stderr.write(`error: route-outcome: ${(err as Error).message}\n`);
    return 1;
  }
}

/** Shared body: read+parse a JSON file, run a validator, print "valid" or the errors. */
function runValidateFile(
  label: string,
  args: string[],
  validate: (v: unknown) => { valid: boolean; errors: string[] },
): number {
  const contract = ROUTE_CONTRACTS[label];
  const gated = gate(contract, args);
  if (gated !== null) return gated;
  const wantJson = hasFlag(contract, args, 'json');
  // Read through the contract rather than off `args[0]`: now that a
  // router-global flag MEANS something here, `validate-report --json <file>`
  // would otherwise have tried to open `"--json"` as the payload.
  const file = positionalsOf(contract, args)[0];
  if (file === undefined) {
    process.stderr.write(`error: ${label} requires a <file>\n`);
    return 2;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    // An unreadable file is a USAGE error (exit 2), not a validation answer, so
    // it stays prose on stderr under --json too: there is no `valid` verdict to
    // report about a payload that was never read. Same rule the silent-write
    // receipts follow — a refusal prints no receipt.
    process.stderr.write(`error: cannot read/parse ${file}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = validate(value);
  if (wantJson) {
    const answer: ValidateJsonResult = {
      verb: label,
      file,
      valid: result.valid,
      errors: result.errors,
    };
    printJson(answer);
    // The same line the prose form returns: the flag chose a rendering, not a
    // verdict — an invalid payload still exits 1, now with its errors ON STDOUT
    // inside the answer rather than as the `invalid:` block on stderr.
    return result.valid ? 0 : 1;
  }
  if (result.valid) {
    process.stdout.write('valid\n');
    return 0;
  }
  process.stderr.write(`invalid:\n  - ${result.errors.join('\n  - ')}\n`);
  return 1;
}

/** `validate-report <file>` — wraps validateWorkerReport. */
export function runValidateReport(args: string[]): number {
  return runValidateFile('validate-report', args, validateWorkerReport);
}

/** `validate-verdict <file>` — wraps validateReviewerVerdict. */
export function runValidateVerdict(args: string[]): number {
  return runValidateFile('validate-verdict', args, validateReviewerVerdict);
}

/** Minimal real-fs listing seam for {@link findMisnamedSidecars}. */
const fsSidecarReader: SidecarReader = {
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return []; // absent dir — nothing to find, never a failure
    }
  },
  read: (dir, file) => readFileSync(join(dir, file), 'utf-8'),
};

/** Outcome of reconciling a payload's own id field against `--id`. */
export type Reconciled =
  | { payload: unknown; notice?: string }
  | { error: string };

interface WriteSidecarSpec {
  label: 'write-report' | 'write-verdict';
  /**
   * The canonical spelling of this verb's target-directory flag —
   * `reports-dir` or `verdicts-dir` (ADR-0051 decision 3). `--dir` is the alias
   * of BOTH, resolving to a different canonical on each: possible only because
   * a contract is per verb.
   */
  dirFlag: 'reports-dir' | 'verdicts-dir';
  /** Human-scan heading rendered above the fenced json (the reader ignores it). */
  heading: 'WorkerReport' | 'ReviewerVerdict';
  kind: 'report' | 'verdict';
  validate: (v: unknown) => { valid: boolean; errors: string[] };
  /**
   * Report-only: reconcile the payload's `issue` field with `--id` at WRITE
   * time. Returns the payload to render (possibly with `issue` normalized to
   * the bare `--id`) plus an optional loud notice, or an error to refuse on.
   * Omitted for the verdict path (a verdict has no issue field — the reader
   * checks none either).
   */
  reconcile?: (payload: unknown, id: string) => Reconciled;
  /**
   * An exit-0 FINDING about an otherwise-valid payload, evaluated only AFTER
   * the sidecar has landed on disk. Returns the notice text, or `undefined`
   * when there is nothing to say.
   *
   * Placement is the point: `reconcile` runs BEFORE the write because it can
   * still refuse one, whereas this hook exists precisely for findings that must
   * NOT stop a write. Emitting it after `writeFileSync` means the `notice:` line
   * can only ever appear on a run that genuinely persisted the record — the
   * Scribe's contract is "on an EXIT-0 run only", and this shape makes that
   * true by construction rather than by the reader's good manners.
   */
  postWriteNotice?: (payload: unknown) => string | undefined;
}

/**
 * The on-disk sidecar body — a human-scan heading over the fenced `json` block
 * the `sidecar.ts` reader parses. THE single owner of that format: the write
 * verbs render through it, and so does `route-tuple`'s sidecar-recovery step,
 * which persists the very same record from an in-memory payload rather than
 * from a file. A second renderer is how the printer half of the
 * printer/parser pair (ADR-0016) drifts from the reader.
 */
export function renderSidecarBody(
  heading: 'WorkerReport' | 'ReviewerVerdict',
  id: string,
  iter: number,
  payload: unknown,
): string {
  return (
    `# ${heading} ${id} iter ${iter}\n\n` +
    '```json\n' +
    JSON.stringify(payload, null, 2) +
    '\n```\n'
  );
}

/**
 * Shared body for write-report / write-verdict: check `--id` against the bare-id
 * shape rule, read+parse the JSON payload, validate it against the matching
 * schema, reconcile the (report-only) `issue` field with `--id`, and — ONLY if
 * all pass — render the fenced-json sidecar the sidecar.ts reader accepts into
 * `<dir>/<id>-<iter>.md`. The filename is engine-computed (the caller cannot
 * misname it); the target dir is `mkdir -p`'d; a same-iter write is
 * last-writer-wins (idempotent re-entries + the w2 bad-anchor corrected-verdict
 * round). A malformed payload is never written (exit 1).
 *
 * After a successful write two exit-0 findings are reported on stderr, in the
 * order a reader wants them: first anything wrong with THIS payload
 * (`postWriteNotice` — the finishing-outcome `prUrl` gate, issue #556), then
 * anything wrong with the DIRECTORY around it (the misnamed sweep below).
 * Neither can fail the write, by construction: both run after the bytes are on
 * disk, so `notice:`/`warning:` on this verb always means "the record exists,
 * and here is what else you should know."
 *
 * The target dir is swept for MISNAMED sidecars (see
 * the header note): they are reported loudly on stderr and never touched. This
 * is what makes the Coordinator's routing-time recovery catch the misnamed case
 * — on a RESUME that recovery IS this verb, and its `[ -f … ]` trigger fires for
 * a misnamed file exactly as it does for a missing one, so the sweep runs
 * precisely when it is needed. Deleting the litter is deliberately NOT
 * automatic: a misnamed sidecar may hold the only copy of a report, and
 * destroying data to tidy a directory is the wrong trade for a verb whose whole
 * purpose is durability.
 *
 * **This verb is not the only recovery, and was not the only one that needed the
 * sweep.** On the DISPATCH path the recovery is `route-tuple`'s `sidecar-check`
 * step, which renders through {@link renderSidecarBody} and writes with its own
 * injected writer rather than through here — so for several wave-generations the
 * sweep did not run at the routing-time recovery the sentence above describes.
 * That verb now runs the same sweep, over the same shared detector
 * (`findMisnamedSidecars`), after each of its own successful writes. The rule
 * about what a misnamed name IS therefore still has exactly one owner
 * (`sidecar.ts`); only the `warning:` label differs, because the two verbs speak
 * under their own names.
 */
function runWriteSidecar(args: string[], spec: WriteSidecarSpec): number {
  const contract = ROUTE_CONTRACTS[spec.label];
  const gated = gate(contract, args);
  if (gated !== null) return gated;

  // The named twin (ADR-0051 decision 6): the payload file arrives EITHER as
  // `--report-file`/`--verdict-file` (canonical) OR as the leading positional
  // (its alias) — never as both. A mixed call reads, to its caller, as though
  // both halves landed, which is precisely the class this refusal exists for.
  const twin = resolveTwin(contract, args);
  if (!twin.ok) {
    process.stderr.write([`error: ${twin.error}`, ...contract.usage, ''].join('\n'));
    return 2;
  }
  const file = twin.values[0];
  const dir = flag(args, contract, spec.dirFlag);
  const id = flag(args, contract, 'id');
  const iterRaw = flag(args, contract, 'iter');
  if (file === undefined || dir === undefined || id === undefined || iterRaw === undefined) {
    process.stderr.write(
      `error: ${spec.label} requires <json-file> --${spec.dirFlag} <dir> --id <id> --iter <n>\n`,
    );
    return 2;
  }
  const iter = Number(iterRaw);
  if (!Number.isInteger(iter) || iter < 1) {
    process.stderr.write(`error: ${spec.label}: --iter must be a positive integer, got "${iterRaw}"\n`);
    return 2;
  }
  const idViolation = bareIssueIdViolation(id);
  if (idViolation) {
    process.stderr.write(
      `error: ${spec.label}: --id ${JSON.stringify(id)} ${idViolation} — nothing written.\n` +
        '  --id is the COMPOSE-TIME ROW ID and is never the caller\'s to vary: pass the\n' +
        "  row id verbatim, NEVER the payload's own decorated reference. Substituting a\n" +
        `  decorated --id does not make this command succeed — it would file\n` +
        `  ${JSON.stringify(`${id}-${iter}.md`)}, a real file that an \`ls\` shows and that the\n` +
        `  reader can never resolve for row ${JSON.stringify(normalizeIssueRef(id))}: present to\n` +
        '  the operator, absent to resume.\n' +
        "  If the payload's own id field is decorated, THAT is what gets normalized (this\n" +
        '  verb does it for you, exit 0 + a notice) — the filename id is not.\n',
    );
    return 2;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    process.stderr.write(`error: cannot read/parse ${file}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = spec.validate(value);
  if (!result.valid) {
    process.stderr.write(
      `invalid ${spec.label} payload — nothing written:\n  - ${result.errors.join('\n  - ')}\n`,
    );
    return 1;
  }
  let payload = value;
  if (spec.reconcile) {
    const reconciled = spec.reconcile(value, id);
    if ('error' in reconciled) {
      process.stderr.write(`error: ${spec.label}: ${reconciled.error} — nothing written\n`);
      return 1;
    }
    payload = reconciled.payload;
    if (reconciled.notice) {
      process.stderr.write(`notice: ${spec.label}: ${reconciled.notice}\n`);
    }
  }
  const body = renderSidecarBody(spec.heading, id, iter, payload);
  const target = join(dir, `${id}-${iter}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, body, 'utf-8');
  } catch (err) {
    process.stderr.write(`error: ${spec.label}: cannot write ${target}: ${(err as Error).message}\n`);
    return 2;
  }
  // ADR-0051 decision 7, row V5: the written path, the id and the iteration —
  // built only HERE, after the bytes have landed, so a refused write can never
  // print one. The prose form's single line is the same `target` string, so the
  // two renderings never name two different files.
  if (hasFlag(contract, args, 'json')) {
    const answer: WriteSidecarJsonResult = { verb: spec.label, path: target, id, iter };
    printJson(answer);
  } else {
    process.stdout.write(target + '\n');
  }
  const finding = spec.postWriteNotice?.(payload);
  if (finding) {
    process.stderr.write(`notice: ${spec.label}: ${finding}\n`);
  }
  warnAboutMisnamedSidecars(dir, spec);
  return 0;
}

/**
 * One misnamed-sidecar finding as the `warning:` line every sweep prints — the
 * SHARED renderer (issue #724).
 *
 * The rule about what a misnamed name IS has always had exactly one owner
 * (`sidecar.ts`'s {@link findMisnamedSidecars} over `bareIssueIdViolation`); the
 * SENTENCE about it did not. Two verbs sweep — `write-report`/`write-verdict`
 * here, and `route-tuple`'s `sidecar-check` step, which is the recovery on the
 * DISPATCH path — and each carried its own copy of these six lines, identical
 * but for the label. That is precisely the shape that drifts: a later row
 * improves the remedy sentence in one copy and the other verb keeps telling
 * operators the old thing.
 *
 * `label` is the only thing that ever differed and the only thing that varies
 * now — each verb speaks under its own name, because an operator reading stderr
 * needs to know which invocation found the litter.
 *
 * Never deletes, and never fails anything: a misnamed sidecar may hold the only
 * copy of a report, and destroying data to tidy a directory is the wrong trade
 * for a durability path. This function only renders; the caller decides where
 * the text goes.
 */
export function renderMisnamedSidecarWarning(
  label: string,
  dir: string,
  m: MisnamedSidecar,
): string {
  return (
    `warning: ${label}: MISNAMED SIDECAR ${JSON.stringify(join(dir, m.file))} — its\n` +
    `  filename id ${JSON.stringify(m.filenameId)} ${m.reason}, so the reader resolves it for NO row\n` +
    `  (it holds the record for ${JSON.stringify(m.resolvesAs)}, which would be filed as\n` +
    `  ${JSON.stringify(`${m.resolvesAs}-${m.iter}.md`)}). A file like this is present to an \`ls\` and\n` +
    '  absent to resume, and an existence probe cannot tell it from a missing one.\n' +
    '  Confirm the correctly-named record holds the same content, then delete it.\n'
  );
}

/**
 * Sweep `dir` for sidecars filed under a name the reader cannot resolve and say
 * so, loudly, naming the file and the id it should have been filed under. Never
 * fails the write: the record this invocation was asked to persist is already on
 * disk, and litter next to it is an operator finding, not a write failure.
 */
function warnAboutMisnamedSidecars(dir: string, spec: WriteSidecarSpec): void {
  for (const m of findMisnamedSidecars(dir, spec.kind, fsSidecarReader)) {
    process.stderr.write(renderMisnamedSidecarWarning(spec.label, dir, m));
  }
}

/**
 * Reconcile a WorkerReport's `issue` field against `--id`.
 *
 * Three outcomes, matching the three shapes seen live in `2026-07-27-consumer-gaps`:
 *  - already the bare id (or absent/blank — the reader checks neither) → pass through;
 *  - a DECORATED form of the same id (`#126`, `#118 — <title>`) → rewrite the field
 *    to the bare `--id` and return a loud notice. The sidecar that lands is
 *    resolvable, and the decoration is reported rather than silently tolerated;
 *  - a genuinely DIFFERENT row → refuse (exit 1). This is a mis-paired payload,
 *    and no amount of renaming makes it the right record for this row.
 *
 * Note this is strictly tighter than the prefix rule it replaces: `issue: "13"`
 * against `--id "138"` used to pass on `"138".startsWith("13")` — a wrong report
 * accepted by an accident of string prefixes — and now refuses.
 */
export function reconcileReportIssue(payload: unknown, id: string): Reconciled {
  const record = payload as Record<string, unknown>;
  const issue = record.issue;
  if (typeof issue !== 'string' || issue.length === 0) return { payload };
  if (issue === id) return { payload };
  if (normalizeIssueRef(issue) === id) {
    return {
      // Spread preserves key order — `issue` keeps its position in the rendered json.
      payload: { ...record, issue: id },
      notice:
        `report.issue ${JSON.stringify(issue)} is a DECORATED form of row ${JSON.stringify(id)} — ` +
        'normalized to the bare id in the written sidecar so the reader can resolve it ' +
        '(ADR-0001: a row id is opaque, therefore matched literally, therefore never decorated). ' +
        'The Worker brief requires the bare id; this is a repair, not a licence — fix it at the source.',
    };
  }
  return {
    error:
      `report.issue ${JSON.stringify(issue)} names a DIFFERENT row than --id ${JSON.stringify(id)} ` +
      `(it normalizes to ${JSON.stringify(normalizeIssueRef(issue))}, not to the row id). ` +
      'That is a mis-paired payload, not a decoration — re-check which row this report belongs to. ' +
      'Do NOT "fix" it by changing --id',
  };
}

/**
 * The finishing-outcome `prUrl` gate (issue #556, ADR-0034 Amendment
 * 2026-08-14): a report that says the work is finished but carries no usable
 * PR URL is reported here, at the moment the record becomes durable.
 *
 * **Notice, never refusal — and that is the whole placement argument.** The
 * report is valid data about work that genuinely happened; the missing URL is
 * a finding *about* the report. Refusing the write would cost a finished row
 * its durable record to punish an omission the Coordinator's terminator
 * already recovers by re-querying the host — the wrong trade, and the wrong
 * rung. The schema root was measured available for this rule and deliberately
 * rejected for a different reason: a root conditional's antecedent is
 * `outcome`, a field the Worker itself authors, so an agent cornered on the
 * consequent reports a NON-finishing outcome instead — a loud failure traded
 * for an expensive silent one. This gate constrains nobody's composition; it
 * observes what was already written and says so.
 *
 * Why it had to move below prose at all: the invariant is the most heavily
 * reinforced clause in the Worker brief and still failed three times across
 * waves, each time strengthened in between. Prose was not converging.
 */
function noticeMissingPrUrl(payload: unknown): string | undefined {
  if (!finishingReportLacksUsablePrUrl(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const seen =
    record.prUrl === undefined
      ? 'ABSENT'
      : `${JSON.stringify(record.prUrl)} — present but not a usable URL`;
  return (
    `outcome ${JSON.stringify(record.outcome)} asserts the work is FINISHED, but prUrl is ${seen}. ` +
    'The sidecar was written anyway — this is a finding ABOUT the report, not a refusal of it. ' +
    'Two consumers read the field as fact and both fail SILENTLY on absence: the Reviewer skips ' +
    'its PR-body check (reporting the PR as not yet opened, so the store-kind close phrase goes ' +
    'unverified), and the terminator reads it as no PR existing and attempts a duplicate. ' +
    "The only legitimate value is the url the Worker's own `host-pr status --branch` re-query " +
    'answered, verbatim. Recover it by re-querying the host for this branch; do not hand-type one'
  );
}

/** `write-report <json-file> --dir <reportsDir> --id <id> --iter <n>`. */
export function runWriteReport(args: string[]): number {
  return runWriteSidecar(args, {
    label: 'write-report',
    dirFlag: 'reports-dir',
    heading: 'WorkerReport',
    kind: 'report',
    validate: validateWorkerReport,
    reconcile: reconcileReportIssue,
    postWriteNotice: noticeMissingPrUrl,
  });
}

/** `write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>`. */
export function runWriteVerdict(args: string[]): number {
  return runWriteSidecar(args, {
    label: 'write-verdict',
    dirFlag: 'verdicts-dir',
    heading: 'ReviewerVerdict',
    kind: 'verdict',
    validate: validateReviewerVerdict,
  });
}
