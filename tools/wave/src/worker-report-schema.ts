/**
 * worker-report-schema.ts — typed, schema-validated Worker-Report contract.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md
 * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 1, US-3)
 * Mirrors:        .claude/skills/wave-shared/references/worker-brief-template.md §Block 5
 *
 * The prose loop parsed Block-5 free-text by eye — the documented fabrication
 * class (L18: a Worker reported `162/162` where the truth was `20/20`). The #61
 * Workflow driver replaces that with a **schema-validated structured return**:
 * the Worker `agent()` is forced (via `agent({ schema: WORKER_REPORT_JSON_SCHEMA })`)
 * to return a `WorkerReport` the tool-call layer validates before the driver
 * ever sees it. No number is re-typed from prose; routing reads a typed field.
 *
 * Three exports do three jobs:
 *   1. `WORKER_REPORT_JSON_SCHEMA` — the JSON Schema literal the Workflow tool
 *      enforces at the `agent()` boundary (no runtime dep — a plain object).
 *   2. `WorkerReport` (+ `WorkerOutcome`) — the TS view the driver consumes.
 *   3. `outcomeToEvent()` — the Worker-phase analog of `verdictToEvent()`
 *      (#64): a pure, loud-rejecting map from the 4-status `Outcome` enum onto
 *      the `WaveEvent` the existing `transition()` routes. No hand-synthesis.
 *   + `validateWorkerReport()` — a dependency-free structural validator so the
 *      spec can assert "well-formed parses / malformed rejected" without
 *      pulling in ajv (the repo ships no JSON-Schema runtime).
 *
 * Naming note: the state-machine already exports a `type Outcome` (the
 * transition outcome) through the barrel, so the Worker status enum is
 * `WorkerOutcome` / `WORKER_OUTCOME_VALUES` to avoid clobbering it in
 * `index.ts`.
 */

import type { WaveEvent } from './stop-condition-state-machine';
import type { SchemaValidation } from './types';

// ─── Outcome enum (#53 four-status implementer protocol) ────────────────────

/**
 * The four-status top-line `Outcome:` a Worker emits. Source: #53 + the
 * worker-brief Block-5 table. Each maps deterministically onto a `WaveEvent`
 * via {@link outcomeToEvent}.
 */
export const WORKER_OUTCOME_VALUES = [
  'done',
  'done-with-concerns',
  'needs-context',
  'blocked',
] as const;

export type WorkerOutcome = (typeof WORKER_OUTCOME_VALUES)[number];

/**
 * The outcomes that assert the row's work is finished. A Worker reporting one
 * of these has, by protocol, opened its PR — so `prUrl` is a fact the whole
 * downstream chain reads, and {@link WORKER_REPORT_JSON_SCHEMA} requires it.
 */
const FINISHING_OUTCOMES = ['done', 'done-with-concerns'] as const;

/**
 * The outcomes that stop short of a PR. `prUrl` has no value to report here —
 * permitted (a Worker may have opened one before stalling), never required.
 */
const NON_FINISHING_OUTCOMES = ['needs-context', 'blocked'] as const;

// ─── TS view of the report ──────────────────────────────────────────────────

/** File-churn counts the Worker reports (Block-5 "Files changed"). */
export interface FilesChangedCounts {
  /** New files created. */
  new: number;
  /** Existing files modified. */
  modified: number;
  /** Files renamed/moved (e.g. the `git mv` to `done/`). */
  renamed: number;
}

/**
 * The structured Worker-Report the driver consumes. Mirrors Block 5 of the
 * worker-brief, with the free-text count fields kept as strings (they carry
 * the L18 "authoritative vs aggregate" distinction in prose) but the
 * routing-critical `outcome` typed as the {@link WorkerOutcome} enum.
 */
export interface WorkerReport {
  /** Routing discriminator — the top-line Block-5 `Outcome:`. */
  outcome: WorkerOutcome;
  /** Issue id + short slug, e.g. `61-wave-start-workflow-driver`. */
  issue: string;
  /** Work branch, e.g. `wave-orch/61-wave-start-workflow-driver`. */
  branch: string;
  /** Worktree path (omitted for foreground rows worked in-place). */
  worktree?: string;
  /** At least one closing commit SHA (short or full). */
  commitShas: string[];
  /**
   * The opened PR's URL. **Required by {@link WORKER_REPORT_JSON_SCHEMA} when
   * `outcome` is a finishing outcome** (`done` | `done-with-concerns`) and
   * optional otherwise — the agent boundary rejects the omission at return
   * time (retro W3-F2: FOR-19's Worker opened PR #13 and reported no `prUrl`,
   * blinding the Reviewer's PR-body check and nearly causing a duplicate PR).
   *
   * Stays `?: string` at the type level: the TS view is shared with the resume
   * read-path (`sidecar.ts`), which must stay liberal about historical reports.
   * The conditional is enforced on the return path, by the schema.
   */
  prUrl?: string;
  /** File-churn counts. */
  filesChanged: FilesChangedCounts;
  /**
   * Authoritative test count (`nx run <project>:test --skip-nx-cache`), e.g.
   * `"20/20 green for wave-tools"` — or `"SKIPPED — docs-only"`.
   */
  tests: string;
  /** Regression sweep summary (`nx affected -t test,lint`): "0 regressions" etc. */
  regressionSweep?: string;
  /** Lint summary (`nx affected -t lint`). */
  lint: string;
  /** Conflict-marker grep result (Block-4 step 1.5): "clean" or the offending files. */
  conflictMarkers?: string;
  /** One bullet per judgment call; `[]` when none. */
  judgmentCalls: string[];
  /** Items the Worker wants the Reviewer to verify with fresh eyes; `[]` when none. */
  reviewerFocusItems: string[];
}

// ─── JSON Schema (enforced by the Workflow tool at the agent() boundary) ─────

/**
 * The JSON Schema the Workflow driver passes as `agent({ schema })`. The tool
 * validates the subagent's structured return against this *before* it reaches
 * the driver — so a malformed report is rejected at the tool-call layer and the
 * model is forced to retry, never silently re-parsed. `additionalProperties:
 * false` keeps the Worker from smuggling un-modelled fields the driver would
 * ignore.
 *
 * ## `prUrl` is conditionally required (retro W3-F2)
 *
 * `prUrl` is **required when `outcome` is a finishing outcome** (`done` |
 * `done-with-concerns`) and optional for `needs-context` | `blocked`. It sits
 * in `anyOf`, not in the unconditional `required` list, because a Worker that
 * did not finish has no PR to report.
 *
 * The rule exists because `prUrl` was optional in the schema but load-bearing
 * in the protocol: every downstream consumer reads its absence as "no PR
 * exists", when it can equally mean "the Worker forgot". FOR-19's Worker
 * opened PR #13 correctly and returned no `prUrl` — the Reviewer could not
 * verify the PR body (incl. the Convention 4 close phrase that decides whether
 * a Linear row can ever reach `done`), and the Coordinator ran `gh pr create`
 * against a branch that already had a PR. Only `gh`'s own refusal stopped the
 * duplicate. A field the protocol reads as fact must not be omissible on the
 * path where the fact is required.
 *
 * **Encoded with `anyOf`, deliberately.** `if`/`then` reads more directly, but
 * the documented structured-output schema subset covers `anyOf`/`allOf` and
 * does *not* list `if`/`then` — `anyOf` is the conservative intersection that
 * standard validators and the documented subset both honour.
 *
 * **e2e-verify:** that the Workflow tool's validator honours `anyOf` (rather
 * than ignoring the unknown-to-it keyword and accepting a `done` report with no
 * `prUrl`) is an assumption this repo cannot prove — it holds no JSON-Schema
 * engine, and a hand-rolled fake would only restate the guess (retro W3-F1:
 * fake, fixture and impl sharing one assumption prove self-consistency, not
 * correctness). The live gate is the first thing that can falsify it. The
 * Worker brief in `wave-shared` states the requirement in prose as the
 * belt-and-braces companion, so a validator that silently ignores the
 * conditional still leaves the model told.
 */
export const WORKER_REPORT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'issue',
    'branch',
    'commitShas',
    'filesChanged',
    'tests',
    'lint',
    'judgmentCalls',
    'reviewerFocusItems',
  ],
  properties: {
    outcome: { type: 'string', enum: [...WORKER_OUTCOME_VALUES] },
    issue: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    worktree: { type: 'string' },
    commitShas: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    prUrl: { type: 'string', minLength: 1 },
    filesChanged: {
      type: 'object',
      additionalProperties: false,
      required: ['new', 'modified', 'renamed'],
      properties: {
        new: { type: 'integer', minimum: 0 },
        modified: { type: 'integer', minimum: 0 },
        renamed: { type: 'integer', minimum: 0 },
      },
    },
    tests: { type: 'string', minLength: 1 },
    regressionSweep: { type: 'string' },
    lint: { type: 'string', minLength: 1 },
    conflictMarkers: { type: 'string' },
    judgmentCalls: { type: 'array', items: { type: 'string' } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
  },
  anyOf: [
    // Finished ⇒ a PR exists ⇒ report it. The Reviewer's PR-body check and the
    // Coordinator's terminator both read this field as fact.
    {
      properties: { outcome: { enum: [...FINISHING_OUTCOMES] } },
      required: ['prUrl'],
    },
    // Did not finish ⇒ there may be no PR. prUrl permitted, never required.
    {
      properties: { outcome: { enum: [...NON_FINISHING_OUTCOMES] } },
    },
  ],
} as const;

// ─── outcome → WaveEvent adapter (Worker-phase analog of verdictToEvent) ─────

/**
 * Translate a Worker `Outcome` into the `WaveEvent` the Stop-Condition
 * state-machine expects. The worker-brief Block-5 table is the canonical
 * mapping:
 *
 * | `outcome`            | → WaveEvent                  | rationale                          |
 * |----------------------|------------------------------|------------------------------------|
 * | `done`               | `worker-done`                | proceed to Reviewer dispatch       |
 * | `done-with-concerns` | `worker-done`                | concerns ride along as focus items |
 * | `needs-context`      | `worker-needs-context`       | auto re-dispatch with context (#53)|
 * | `blocked`            | `worker-failed-after-retry`  | STOP, ping Coordinator             |
 *
 * Mirrors {@link verdictToEvent}'s "classify by the typed field, reject the
 * un-mappable loudly" discipline — so the Worker-phase routing is as
 * deterministic as the Reviewer-phase routing, with no hand-synthesised event.
 *
 * @throws {TypeError} on any value outside {@link WORKER_OUTCOME_VALUES}.
 */
export function outcomeToEvent(outcome: WorkerOutcome): WaveEvent {
  if (!(WORKER_OUTCOME_VALUES as readonly string[]).includes(outcome)) {
    throw new TypeError(
      `outcomeToEvent: unrecognised outcome ${JSON.stringify(outcome)}. ` +
        `Expected one of: ${WORKER_OUTCOME_VALUES.join(' | ')}.`,
    );
  }

  switch (outcome) {
    case 'done':
    case 'done-with-concerns':
      return 'worker-done';
    case 'needs-context':
      return 'worker-needs-context';
    case 'blocked':
      return 'worker-failed-after-retry';
  }
}

// ─── dependency-free structural validator (for the spec) ─────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * A lightweight, dependency-free validator that asserts the *load-bearing*
 * `WorkerReport` constraints: required keys present, correct types, `outcome`
 * within the enum, `commitShas`/`filesChanged` well-formed. It is NOT a full
 * JSON-Schema engine — {@link WORKER_REPORT_JSON_SCHEMA} is the artefact the
 * Workflow tool enforces. This exists so the spec can prove "well-formed parses
 * / malformed rejected" without an ajv dependency the repo doesn't carry.
 *
 * @returns `{ valid, errors }` — `errors` is empty iff `valid`.
 */
export function validateWorkerReport(value: unknown): SchemaValidation {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { valid: false, errors: ['report is not an object'] };
  }

  if (
    !(WORKER_OUTCOME_VALUES as readonly string[]).includes(
      value.outcome as string,
    )
  ) {
    errors.push(
      `outcome ${JSON.stringify(value.outcome)} not in ${WORKER_OUTCOME_VALUES.join(' | ')}`,
    );
  }
  for (const key of ['issue', 'branch', 'tests', 'lint'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (
    !isStringArray(value.commitShas) ||
    (value.commitShas as string[]).length === 0
  ) {
    errors.push('commitShas must be a non-empty string[]');
  }
  if (!isStringArray(value.judgmentCalls)) {
    errors.push('judgmentCalls must be a string[]');
  }
  if (!isStringArray(value.reviewerFocusItems)) {
    errors.push('reviewerFocusItems must be a string[]');
  }

  const fc = value.filesChanged;
  if (!isPlainObject(fc)) {
    errors.push('filesChanged must be an object');
  } else {
    for (const key of ['new', 'modified', 'renamed'] as const) {
      if (!Number.isInteger(fc[key]) || (fc[key] as number) < 0) {
        errors.push(`filesChanged.${key} must be a non-negative integer`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
