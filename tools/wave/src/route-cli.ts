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
 *   0 — written (absolute path of the written file on stdout)
 *   1 — invalid payload / failed report.issue↔--id cross-check (NOTHING written)
 *   2 — usage / unreadable-or-unparseable <json-file>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag, printJson } from './cli-utils';
import { verdictToEvent, type Verdict } from './verdict-to-event';
import { outcomeToEvent, validateWorkerReport, type WorkerOutcome } from './worker-report-schema';
import { validateReviewerVerdict } from './reviewer-verdict-schema';
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

interface WriteSidecarSpec {
  label: 'write-report' | 'write-verdict';
  /** Human-scan heading rendered above the fenced json (the reader ignores it). */
  heading: 'WorkerReport' | 'ReviewerVerdict';
  validate: (v: unknown) => { valid: boolean; errors: string[] };
  /**
   * Report-only: mirror the reader's `report.issue` prefix rule against `--id`
   * (sidecar.ts:101) at WRITE time — fail loud here instead of "corrupt" at
   * resume. Return an error message to reject, or null to accept. Omitted for
   * the verdict path (a verdict has no issue field — the reader checks none).
   */
  crossCheck?: (payload: unknown, id: string) => string | null;
}

/**
 * Shared body for write-report / write-verdict: read+parse the JSON payload,
 * validate it against the matching schema, run the (report-only) issue↔--id
 * cross-check, and — ONLY if all pass — render the fenced-json sidecar the
 * sidecar.ts reader accepts into `<dir>/<id>-<iter>.md`. The filename is
 * engine-computed (the caller cannot misname it); the target dir is `mkdir -p`'d;
 * a same-iter write is last-writer-wins (idempotent re-entries + the w2 bad-anchor
 * corrected-verdict round). A malformed payload is never written (exit 1).
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
  if (spec.crossCheck) {
    const reason = spec.crossCheck(value, id);
    if (reason) {
      process.stderr.write(`error: ${spec.label}: ${reason} — nothing written\n`);
      return 1;
    }
  }
  const body =
    `# ${spec.heading} ${id} iter ${iter}\n\n` +
    '```json\n' +
    JSON.stringify(value, null, 2) +
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
  return 0;
}

/**
 * Mirror of the reader's `report.issue` prefix check (sidecar.ts:101): the id in
 * the filename and the payload's `issue` must be prefix-compatible either way. A
 * missing/blank issue is not checked (the reader treats it the same).
 */
function reportIssueCrossCheck(payload: unknown, id: string): string | null {
  const issue = (payload as { issue?: unknown }).issue;
  if (
    typeof issue === 'string' &&
    issue.length > 0 &&
    !issue.startsWith(id) &&
    !id.startsWith(issue)
  ) {
    return `report.issue "${issue}" disagrees with --id "${id}" (the reader would reject it as corrupt)`;
  }
  return null;
}

/** `write-report <json-file> --dir <reportsDir> --id <id> --iter <n>`. */
export function runWriteReport(args: string[]): number {
  return runWriteSidecar(args, {
    label: 'write-report',
    heading: 'WorkerReport',
    validate: validateWorkerReport,
    crossCheck: reportIssueCrossCheck,
  });
}

/** `write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>`. */
export function runWriteVerdict(args: string[]): number {
  return runWriteSidecar(args, {
    label: 'write-verdict',
    heading: 'ReviewerVerdict',
    validate: validateReviewerVerdict,
  });
}
