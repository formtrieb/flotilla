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
  metAcIndexes,
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

// ─── metAcIndexes — the single-owner met-AC derivation (FOR-17) ────────────
//
// This is the ONE engine owner of "which AC indexes does wave-close tick at
// close?" — the wire `IssueStore.close(id, prUrl, ackedAcIndexes)` has taken
// since ADR-0004, dead until this. Covered here so no skill ever re-derives
// it by ad-hoc parsing acVerification[] itself.

/**
 * Render a ReviewerVerdict exactly as `write-verdict` (route-cli.ts) writes a
 * real sidecar to `<verdictsDir>/<id>-<iter>.md` — a fenced ```json block
 * under a heading — and extract it back the way the resume-path reader
 * (sidecar.ts's `readSidecars`) does. Round-tripping through this on-disk
 * shape (rather than handing `metAcIndexes` an in-memory object straight from
 * the test) is the "real verdict sidecar fixture" the derivation is proven
 * against — the exact bytes wave-close's engine verb reads off disk.
 */
function renderSidecar(id: string, iter: number, verdict: ReviewerVerdict): string {
  return (
    `# ReviewerVerdict ${id} iter ${iter}\n\n` +
    '```json\n' +
    JSON.stringify(verdict, null, 2) +
    '\n```\n'
  );
}

function parseSidecarJson(raw: string): unknown {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(raw);
  return JSON.parse(m ? m[1] : raw);
}

describe('metAcIndexes — met-AC index derivation (FOR-17, the dead --acked wire)', () => {
  it('returns the 0-based indexes of ONLY the `met` rows — partial/not-met/deferred excluded', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'partial', evidence: 'b' },
        { ac: '#3', met: 'not-met', evidence: 'c' },
        { ac: '#4', met: 'met', evidence: 'd' },
        { ac: '#5', met: 'deferred', evidence: 'e' },
      ],
    });
    expect(metAcIndexes(v)).toEqual([0, 3]);
  });

  it('returns [] when no AC is met', () => {
    const v = validVerdict({
      acVerification: [
        { ac: '#1', met: 'partial', evidence: 'a' },
        { ac: '#2', met: 'not-met', evidence: 'b' },
      ],
    });
    expect(metAcIndexes(v)).toEqual([]);
  });

  it('returns [] on an empty acVerification (issue with no ACs)', () => {
    expect(metAcIndexes(validVerdict({ acVerification: [] }))).toEqual([]);
  });

  it('derives against a REAL verdict sidecar fixture — the on-disk write-verdict shape', () => {
    const written = validVerdict({
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'tools/wave/src/cli.ts:42' },
        { ac: '#2', met: 'partial', evidence: 'reviewed, one edge case missing' },
        { ac: '#3', met: 'met', evidence: 'tools/wave/src/reviewer-verdict-schema.ts:99' },
      ],
    });
    const sidecar = renderSidecar('17', 1, written);
    const parsed = parseSidecarJson(sidecar);
    const check = validateReviewerVerdict(parsed);
    expect(check).toEqual({ valid: true, errors: [] });
    expect(metAcIndexes(parsed as ReviewerVerdict)).toEqual([0, 2]);
  });

  it('after a changes-requested → re-dispatch cycle, indexes come from the LATEST iteration', () => {
    // iter 1: changes-requested, only AC #1 verified met so far.
    const iter1 = validVerdict({
      verdict: 'changes-requested',
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'not-met', evidence: 'missing test' },
      ],
    });
    // iter 2 (post re-dispatch): approve, both ACs now met.
    const iter2 = validVerdict({
      verdict: 'approve',
      acVerification: [
        { ac: '#1', met: 'met', evidence: 'a' },
        { ac: '#2', met: 'met', evidence: 'fixed in re-dispatch' },
      ],
    });
    const sidecar1 = parseSidecarJson(renderSidecar('17', 1, iter1)) as ReviewerVerdict;
    const sidecar2 = parseSidecarJson(renderSidecar('17', 2, iter2)) as ReviewerVerdict;

    expect(metAcIndexes(sidecar1)).toEqual([0]);
    // The engine's sidecar reader (sidecar.ts's readSidecars/verdictFor) is the
    // MAX-iter selector wave-close's `verdict-acked` CLI verb calls before
    // handing the verdict to metAcIndexes — this proves the derivation itself
    // reflects whichever verdict it is given, so the LATEST iteration's verdict
    // (never the stale one) is what must reach it.
    expect(metAcIndexes(sidecar2)).toEqual([0, 1]);
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
