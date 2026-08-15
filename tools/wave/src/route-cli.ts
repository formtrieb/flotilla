/**
 * route-cli.ts — the THIN top-level routers + the paired sidecar WRITE verbs
 * (P7.4 + FOR-6/ADR-0024), siblings of closed-by / detect-host. Each wraps an
 * already-tested library function and adds no domain logic of its own (mirrors
 * runClosedBy / runDetectHost in cli.ts):
 *
 *   route-verdict    verdictToEvent(verdict, iteration, risk) → transition(state, event, risk)
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
 *   0 — routed (JSON { event, outcome } on stdout)
 *   1 — the library rejected an input (out-of-enum verdict/outcome/risk/state)
 *   2 — usage (a required flag is missing)
 *
 * validate-report / validate-verdict exit codes:
 *   0 — valid ("valid" on stdout)
 *   1 — invalid (the errors[] on stderr)
 *   2 — usage / unreadable-or-unparseable file
 *
 * write-report / write-verdict exit codes (mirror validate-*):
 *   0 — written (absolute path of the written file on stdout). A `notice:` line
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
import { verdictToEvent, type Verdict } from './verdict-to-event';
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
  type SidecarReader,
} from './sidecar';
import { transition, type IssueState } from './stop-condition-state-machine';
import type { Risk } from './header-parser';

/**
 * `route-verdict --verdict <v> --iteration <n> --risk <r> --state <s>`.
 * Wraps verdictToEvent → transition. The library throws (TypeError/RangeError)
 * on any out-of-enum/out-of-range input — we catch and map to exit 1 so a bad
 * subagent return is a loud failure, never a silent mis-route.
 */
export function runRouteVerdict(args: string[]): number {
  const verdict = flag(args, '--verdict');
  const iterationRaw = flag(args, '--iteration');
  const risk = flag(args, '--risk');
  const state = flag(args, '--state');
  if (verdict === undefined || iterationRaw === undefined || risk === undefined || state === undefined) {
    process.stderr.write(
      'error: route-verdict requires --verdict <v> --iteration <n> --risk <r> --state <s>\n',
    );
    return 2;
  }
  const iteration = Number(iterationRaw);
  try {
    const event = verdictToEvent(verdict as Verdict, iteration, risk as Risk);
    const outcome = transition(state as IssueState, event, risk as Risk);
    printJson({ event, outcome });
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
  const outcomeArg = flag(args, '--outcome');
  const state = flag(args, '--state');
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
  const file = args[0];
  if (file === undefined) {
    process.stderr.write(`error: ${label} requires a <file>\n`);
    return 2;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    process.stderr.write(`error: cannot read/parse ${file}: ${(err as Error).message}\n`);
    return 2;
  }
  const result = validate(value);
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
type Reconciled =
  | { payload: unknown; notice?: string }
  | { error: string };

interface WriteSidecarSpec {
  label: 'write-report' | 'write-verdict';
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
 * — that recovery IS this verb, and its `[ -f … ]` trigger fires for a misnamed
 * file exactly as it does for a missing one, so the sweep runs precisely when it
 * is needed. Deleting the litter is deliberately NOT automatic: a misnamed
 * sidecar may hold the only copy of a report, and destroying data to tidy a
 * directory is the wrong trade for a verb whose whole purpose is durability.
 */
function runWriteSidecar(args: string[], spec: WriteSidecarSpec): number {
  const file = args[0];
  const dir = flag(args, '--dir');
  const id = flag(args, '--id');
  const iterRaw = flag(args, '--iter');
  if (file === undefined || dir === undefined || id === undefined || iterRaw === undefined) {
    process.stderr.write(
      `error: ${spec.label} requires <json-file> --dir <dir> --id <id> --iter <n>\n`,
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
  const body =
    `# ${spec.heading} ${id} iter ${iter}\n\n` +
    '```json\n' +
    JSON.stringify(payload, null, 2) +
    '\n```\n';
  const target = join(dir, `${id}-${iter}.md`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, body, 'utf-8');
  } catch (err) {
    process.stderr.write(`error: ${spec.label}: cannot write ${target}: ${(err as Error).message}\n`);
    return 2;
  }
  process.stdout.write(target + '\n');
  const finding = spec.postWriteNotice?.(payload);
  if (finding) {
    process.stderr.write(`notice: ${spec.label}: ${finding}\n`);
  }
  warnAboutMisnamedSidecars(dir, spec);
  return 0;
}

/**
 * Sweep `dir` for sidecars filed under a name the reader cannot resolve and say
 * so, loudly, naming the file and the id it should have been filed under. Never
 * fails the write: the record this invocation was asked to persist is already on
 * disk, and litter next to it is an operator finding, not a write failure.
 */
function warnAboutMisnamedSidecars(dir: string, spec: WriteSidecarSpec): void {
  for (const m of findMisnamedSidecars(dir, spec.kind, fsSidecarReader)) {
    process.stderr.write(
      `warning: ${spec.label}: MISNAMED SIDECAR ${JSON.stringify(join(dir, m.file))} — its\n` +
        `  filename id ${JSON.stringify(m.filenameId)} ${m.reason}, so the reader resolves it for NO row\n` +
        `  (it holds the record for ${JSON.stringify(m.resolvesAs)}, which would be filed as\n` +
        `  ${JSON.stringify(`${m.resolvesAs}-${m.iter}.md`)}). A file like this is present to an \`ls\` and\n` +
        '  absent to resume, and an existence probe cannot tell it from a missing one.\n' +
        '  Confirm the correctly-named record holds the same content, then delete it.\n',
    );
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
function reconcileReportIssue(payload: unknown, id: string): Reconciled {
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
    heading: 'ReviewerVerdict',
    kind: 'verdict',
    validate: validateReviewerVerdict,
  });
}
