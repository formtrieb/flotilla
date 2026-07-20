/**
 * Spec for the ReviewerVerdict schema (wave-orch #61).
 *
 * Two surfaces:
 *   1. `validateReviewerVerdict()` — a well-formed verdict parses; each
 *      load-bearing malformation is rejected. The headline guard is **the
 *      missing `riskClass`**: its omission was the G3 bug (a public-API approve
 *      silently fast-pathed past the human STOP). The schema makes it required.
 *   2. End-to-end routing: a validated verdict's `{ verdict, riskClass }` feed
 *      straight into the tested `verdictToEvent()` → `transition()` chain with
 *      no hand-synthesis — proving the typed return wires the existing router.
 */

import { describe, expect, it } from 'vitest';
import { RISK_VALUES, type Risk } from './header-parser';
import { transition } from './stop-condition-state-machine';
import {
  VERDICT_VALUES,
  verdictToEvent,
  type Verdict,
} from './verdict-to-event';
import {
  AC_STATUS_VALUES,
  REVIEWER_VERDICT_JSON_SCHEMA,
  validateReviewerVerdict,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';

// ─── fixture ────────────────────────────────────────────────────────────────

function validVerdict(over: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: 'approve',
    branchReviewed: 'wave-orch/61-wave-start-workflow-driver',
    riskClass: 'cross-feature-refactor',
    workerReportDigest: 'Worker reports 20/20 green, 1 judgment call',
    acVerification: [
      { ac: '#1', met: 'met', evidence: 'tools/wave/src/worker-report-schema.ts' },
    ],
    reviewerFocusItems: ['(advisory) consider a stall-watchdog follow-up'],
    lintTestSummary: '1/1 green',
    gitStateSane: true,
    ...over,
  };
}

// ─── validateReviewerVerdict — well-formed ──────────────────────────────────

describe('validateReviewerVerdict — well-formed', () => {
  it('accepts a complete verdict', () => {
    expect(validateReviewerVerdict(validVerdict())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts every verdict value', () => {
    for (const verdict of VERDICT_VALUES) {
      expect(validateReviewerVerdict(validVerdict({ verdict })).valid).toBe(
        true,
      );
    }
  });

  it('accepts an empty acVerification list (issue with no ACs)', () => {
    expect(
      validateReviewerVerdict(validVerdict({ acVerification: [] })).valid,
    ).toBe(true);
  });
});

// ─── validateReviewerVerdict — malformed ────────────────────────────────────

describe('validateReviewerVerdict — rejects malformed verdicts', () => {
  it('rejects a non-object', () => {
    expect(validateReviewerVerdict(undefined).valid).toBe(false);
  });

  it('rejects an out-of-enum verdict', () => {
    const r = validateReviewerVerdict(
      validVerdict({ verdict: 'approved' as Verdict }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/verdict .* not in/);
  });

  it('rejects a MISSING riskClass — the G3 fast-path guard', () => {
    const bad = { ...validVerdict() } as Partial<ReviewerVerdict>;
    delete bad.riskClass;
    const r = validateReviewerVerdict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/riskClass/);
    expect(r.errors.join(' ')).toMatch(/G3/);
  });

  it('rejects an out-of-enum riskClass', () => {
    const r = validateReviewerVerdict(
      validVerdict({ riskClass: 'public-api' as Risk }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/riskClass/);
  });

  it('rejects a malformed acVerification row (bad met status)', () => {
    const r = validateReviewerVerdict(
      validVerdict({
        acVerification: [
          {
            ac: '#1',
            met: 'passed' as ReviewerVerdict['acVerification'][number]['met'],
            evidence: 'x',
          },
        ],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/acVerification\[0\]\.met/);
  });

  it('rejects a non-array reviewerFocusItems', () => {
    const bad = { ...validVerdict(), reviewerFocusItems: 'none' };
    const r = validateReviewerVerdict(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/reviewerFocusItems/);
  });
});

// ─── end-to-end routing: validated verdict → verdictToEvent → transition ────

describe('a validated verdict routes through the tested chain without hand-synthesis', () => {
  it('approve + cross-feature-refactor → reviewer-approve → approved', () => {
    const v = validVerdict({
      verdict: 'approve',
      riskClass: 'cross-feature-refactor',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    const event = verdictToEvent(v.verdict, 1, v.riskClass);
    expect(event).toBe('reviewer-approve');
    expect(transition('reviewing', event, v.riskClass)).toEqual({
      type: 'transition',
      nextState: 'approved',
    });
  });

  it('approve + public-API-change → STOP (the human gate is preserved)', () => {
    const v = validVerdict({
      verdict: 'approve',
      riskClass: 'public-API-change',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    const event = verdictToEvent(v.verdict, 1, v.riskClass);
    expect(event).toBe('reviewer-approve-public-api');
    expect(transition('reviewing', event, v.riskClass)).toEqual({
      type: 'stop',
      reason: 'public-api-approval-required',
      severity: 'blocking',
    });
  });

  it('changes-requested (iter 1) → re-dispatched; (iter 2) → STOP cap-exhausted', () => {
    const v = validVerdict({
      verdict: 'changes-requested',
      riskClass: 'isolated-refactor',
    });
    expect(validateReviewerVerdict(v).valid).toBe(true);
    expect(
      transition('reviewing', verdictToEvent(v.verdict, 1, v.riskClass)),
    ).toEqual({
      type: 'transition',
      nextState: 're-dispatched',
    });
    expect(
      transition('re-dispatched', verdictToEvent(v.verdict, 2, v.riskClass)),
    ).toEqual({
      type: 'stop',
      reason: 're-dispatch-cap-exhausted',
      severity: 'error',
    });
  });
});

// ─── briefProfile is removed — it must NOT be required, and is now rejected ────

describe('briefProfile is removed (ADR-0016 uniform reviewer)', () => {
  it('a verdict without briefProfile is well-formed', () => {
    const v = validVerdict();
    expect('briefProfile' in v).toBe(false);
    expect(validateReviewerVerdict(v)).toEqual({ valid: true, errors: [] });
  });

  it('briefProfile is absent from required[] and properties', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.required).not.toContain('briefProfile');
    expect('briefProfile' in REVIEWER_VERDICT_JSON_SCHEMA.properties).toBe(false);
  });

  it('the schema is closed so a stray briefProfile would be rejected', () => {
    // additionalProperties:false is the enforcement surface (the Workflow tool
    // validates against the JSON Schema, not validateReviewerVerdict).
    expect(REVIEWER_VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

// ─── JSON-Schema shape (the artefact the Workflow tool enforces) ────────────

describe('REVIEWER_VERDICT_JSON_SCHEMA shape', () => {
  it('is a closed object (additionalProperties: false)', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.type).toBe('object');
    expect(REVIEWER_VERDICT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('requires riskClass (the G3 floor) alongside verdict', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.required).toEqual(
      expect.arrayContaining(['verdict', 'riskClass']),
    );
  });

  it('constrains verdict / riskClass to their canonical enums', () => {
    expect(REVIEWER_VERDICT_JSON_SCHEMA.properties.verdict.enum).toEqual([
      ...VERDICT_VALUES,
    ]);
    expect(REVIEWER_VERDICT_JSON_SCHEMA.properties.riskClass.enum).toEqual([
      ...RISK_VALUES,
    ]);
  });
});

// ─── enum sanity ────────────────────────────────────────────────────────────

describe('local enums', () => {
  it('AC_STATUS_VALUES is the four verification states', () => {
    expect([...AC_STATUS_VALUES]).toEqual([
      'met',
      'partial',
      'not-met',
      'deferred',
    ]);
  });
});
