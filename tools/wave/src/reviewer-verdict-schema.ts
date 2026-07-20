/**
 * reviewer-verdict-schema.ts — typed, schema-validated Reviewer-Verdict contract.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md
 * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 2-3, US-4/5)
 * Mirrors:        .claude/agents/wave-reviewer.md §"Output schema"
 *                 (synced copy: .claude/skills/wave-shared/references/reviewer-brief-template.md)
 *
 * The Wave-Reviewer subagent emitted its Verdict as free-text Markdown the
 * Coordinator chat re-read by eye to derive the routing event (G3: a forgotten
 * `riskClass` silently fast-pathed a public-API approve past the human STOP).
 * The #61 Workflow driver dispatches the Reviewer as
 * `agent({ agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_JSON_SCHEMA })`
 * — so the Verdict comes back **typed and tool-validated**, and the routing
 * reads `verdict.verdict` + `verdict.riskClass` straight into the tested
 * `verdictToEvent(verdict, iteration, risk)` adapter (#64) → `transition()`.
 * No prose re-parse, no hand-synthesised event, `riskClass` always present.
 *
 * The Verdict enum (`approve | changes-requested | questions-blocking`) and the
 * Risk enum are imported from their existing canonical homes
 * (`verdict-to-event.ts`, `header-parser.ts`) — never redefined — so the schema
 * stays in lockstep with the adapter it feeds.
 */

import { RISK_VALUES, type Risk } from './header-parser';
import { VERDICT_VALUES, type Verdict } from './verdict-to-event';
import type { SchemaValidation } from './types';

// ─── enums local to the Verdict shape ───────────────────────────────────────

// (removed) BRIEF_PROFILE_VALUES / BriefProfile — ADR-0016 uniform reviewer:
// there is no per-Risk brief profile any more.

/** Per-AC verification status from the Reviewer's AC table. */
export const AC_STATUS_VALUES = [
  'met',
  'partial',
  'not-met',
  'deferred',
] as const;
export type AcStatus = (typeof AC_STATUS_VALUES)[number];

// ─── TS view of the verdict ─────────────────────────────────────────────────

/** One row of the Reviewer's AC-verification table. */
export interface AcVerification {
  /** Short AC text or `#N`. */
  ac: string;
  /** Verification status. */
  met: AcStatus;
  /** `file:line`, `commit-sha`, or "deferred per marker". */
  evidence: string;
}

/**
 * The structured Reviewer-Verdict the driver routes on. `verdict` is the
 * routing discriminator; `riskClass` is the bifurcator `verdictToEvent()`
 * requires (its absence was the G3 bug). The remaining fields preserve the
 * Output-schema's structured sections so the Coordinator sees the same
 * evidence the prose Verdict carried, without re-parsing Markdown.
 */
export interface ReviewerVerdict {
  /** Routing discriminator — one of {@link VERDICT_VALUES}. */
  verdict: Verdict;
  /** Branch the Reviewer verified. */
  branchReviewed: string;
  /** Risk class — fed straight to `verdictToEvent()` so routing never omits it. */
  riskClass: Risk;
  /** One-line digest of the Worker report ("Worker reports X/Y green, 0 judgment calls"). */
  workerReportDigest: string;
  /** AC-verification table; `[]` allowed only when the issue declares no ACs. */
  acVerification: AcVerification[];
  /** Reviewer-focus items for the Coordinator — surfaced even on `approve`; `[]` when none. */
  reviewerFocusItems: string[];
  /** Lint/test re-verification summary (Reviewer re-ran, not re-read). */
  lintTestSummary?: string;
  /** Git-state sanity (globs match, AC ticks consistent with diff, Closed-by well-formed). */
  gitStateSane?: boolean;
}

// ─── met-AC index derivation (FOR-17 — the dead --acked wire) ──────────────

/**
 * Derive the 0-based `acVerification` indexes the Reviewer marked `met` —
 * the SINGLE-OWNER engine derivation `IssueStore.close(id, prUrl,
 * ackedAcIndexes)` expects (ADR-0004: `ackedAcIndexes` are "stable AC indexes
 * from the reviewer verdict"). `acVerification[]` is positional 1:1 with the
 * issue's declared `acceptanceCriteria[]` (ADR-0004's re-based AC-count gate),
 * so the index into this array IS the stable AC index `tickAcs()` consumes —
 * no separate id/ordinal field is needed.
 *
 * `partial` / `not-met` / `deferred` rows are excluded — only an
 * unambiguous `met` earns the cosmetic tick, so the issue's checklist reads
 * as done for exactly what the Reviewer verified with evidence, never more.
 *
 * COSMETIC ONLY (ADR-0004 boundary): this is the human-visibility tick wired
 * at `wave-close`'s done-reconcile step, at CLOSE time — never at verdict-in,
 * since an approved-but-later-closed-unmerged PR would otherwise overstate
 * what landed. The result is never fed back as gate input; `acVerification[]`
 * itself remains the ground truth the DOR/reviewer gates read.
 */
export function metAcIndexes(verdict: ReviewerVerdict): number[] {
  const indexes: number[] = [];
  verdict.acVerification.forEach((row, i) => {
    if (row.met === 'met') indexes.push(i);
  });
  return indexes;
}

// ─── JSON Schema (enforced by the Workflow tool at the agent() boundary) ─────

/**
 * The JSON Schema the Workflow driver passes as
 * `agent({ agentType: 'wave-reviewer', schema })`. The tool validates the
 * subagent's return against this before the driver routes — so a Verdict
 * missing `riskClass` (the G3 failure) cannot reach `verdictToEvent()`; the
 * model is forced to supply it. `additionalProperties: false` keeps the
 * subagent from returning un-modelled fields the router would ignore.
 */
export const REVIEWER_VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'branchReviewed',
    'riskClass',
    'workerReportDigest',
    'acVerification',
    'reviewerFocusItems',
  ],
  properties: {
    verdict: { type: 'string', enum: [...VERDICT_VALUES] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: [...RISK_VALUES] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ac', 'met', 'evidence'],
        properties: {
          ac: { type: 'string', minLength: 1 },
          met: { type: 'string', enum: [...AC_STATUS_VALUES] },
          evidence: { type: 'string' },
        },
      },
    },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' },
    gitStateSane: { type: 'boolean' },
  },
} as const;

// ─── dependency-free structural validator (for the spec) ─────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Dependency-free validator asserting the load-bearing `ReviewerVerdict`
 * constraints: `verdict` and `riskClass` within their enums (the two routing
 * inputs that must never be wrong), required strings present, `acVerification`
 * rows well-formed. Not a full JSON-Schema engine — {@link REVIEWER_VERDICT_JSON_SCHEMA}
 * is what the Workflow tool enforces; this lets the spec prove well-formed/malformed
 * without an ajv dependency.
 *
 * @returns `{ valid, errors }` — `errors` is empty iff `valid`.
 */
export function validateReviewerVerdict(value: unknown): SchemaValidation {
  const errors: string[] = [];

  if (!isPlainObject(value)) {
    return { valid: false, errors: ['verdict is not an object'] };
  }

  if (
    !(VERDICT_VALUES as readonly string[]).includes(value.verdict as string)
  ) {
    errors.push(
      `verdict ${JSON.stringify(value.verdict)} not in ${VERDICT_VALUES.join(' | ')}`,
    );
  }
  if (!(RISK_VALUES as readonly string[]).includes(value.riskClass as string)) {
    errors.push(
      `riskClass ${JSON.stringify(value.riskClass)} not in ${RISK_VALUES.join(' | ')} ` +
        '(its absence was the G3 fast-path bug)',
    );
  }
  for (const key of ['branchReviewed', 'workerReportDigest'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (!isStringArray(value.reviewerFocusItems)) {
    errors.push('reviewerFocusItems must be a string[]');
  }
  if (!Array.isArray(value.acVerification)) {
    errors.push('acVerification must be an array');
  } else {
    value.acVerification.forEach((row, i) => {
      if (!isPlainObject(row)) {
        errors.push(`acVerification[${i}] must be an object`);
        return;
      }
      if (typeof row.ac !== 'string' || row.ac.length === 0) {
        errors.push(`acVerification[${i}].ac must be a non-empty string`);
      }
      if (
        !(AC_STATUS_VALUES as readonly string[]).includes(row.met as string)
      ) {
        errors.push(
          `acVerification[${i}].met ${JSON.stringify(row.met)} not in ${AC_STATUS_VALUES.join(' | ')}`,
        );
      }
      if (typeof row.evidence !== 'string') {
        errors.push(`acVerification[${i}].evidence must be a string`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}
