/**
 * Spec for the WorkerReport schema + outcomeToEvent() adapter (wave-orch #61).
 *
 * Two surfaces:
 *   1. `validateWorkerReport()` — a well-formed report parses; each
 *      load-bearing malformation is rejected with a specific error (the typed
 *      structured return that replaces the L18 prose-fabrication class).
 *   2. `outcomeToEvent()` — the Worker-phase routing adapter: every Outcome →
 *      the correct WaveEvent; unknown Outcome rejected loudly (mirrors the #64
 *      verdictToEvent discipline).
 */

import { describe, expect, it } from 'vitest';
import { WAVE_EVENTS, type WaveEvent } from './stop-condition-state-machine';
import {
  WORKER_OUTCOME_VALUES,
  WORKER_REPORT_JSON_SCHEMA,
  outcomeToEvent,
  validateWorkerReport,
  type WorkerOutcome,
  type WorkerReport,
} from './worker-report-schema';

// ─── fixture ────────────────────────────────────────────────────────────────

function validReport(over: Partial<WorkerReport> = {}): WorkerReport {
  return {
    outcome: 'done',
    issue: '61-wave-start-workflow-driver',
    branch: 'wave-orch/61-wave-start-workflow-driver',
    worktree: '/tmp/example-wave-start-hardening',
    commitShas: ['abc1234'],
    prUrl: 'https://github.com/example/repo/pull/61',
    filesChanged: { new: 2, modified: 1, renamed: 1 },
    tests: '20/20 green for wave-tools',
    regressionSweep: '0 regressions',
    lint: '1/1 projects green',
    conflictMarkers: 'clean',
    judgmentCalls: [],
    reviewerFocusItems: [],
    ...over,
  };
}

// ─── validateWorkerReport — well-formed ─────────────────────────────────────

describe('validateWorkerReport — well-formed', () => {
  it('accepts a complete report', () => {
    expect(validateWorkerReport(validReport())).toEqual({
      valid: true,
      errors: [],
    });
  });

  it('accepts a minimal report (optional fields omitted)', () => {
    const minimal = {
      outcome: 'done' as const,
      issue: '61-x',
      branch: 'wave-orch/61-x',
      commitShas: ['deadbee'],
      filesChanged: { new: 0, modified: 1, renamed: 0 },
      tests: 'SKIPPED — docs-only',
      lint: '0 affected',
      judgmentCalls: [],
      reviewerFocusItems: [],
    };
    expect(validateWorkerReport(minimal).valid).toBe(true);
  });

  it('accepts each Outcome value', () => {
    for (const outcome of WORKER_OUTCOME_VALUES) {
      expect(validateWorkerReport(validReport({ outcome })).valid).toBe(true);
    }
  });
});

// ─── validateWorkerReport — malformed (rejected, not guessed) ───────────────

describe('validateWorkerReport — rejects malformed reports', () => {
  it('rejects a non-object', () => {
    expect(validateWorkerReport(null).valid).toBe(false);
    expect(validateWorkerReport('a report').valid).toBe(false);
    expect(validateWorkerReport([]).valid).toBe(false);
  });

  it('rejects an out-of-enum outcome', () => {
    const r = validateWorkerReport(
      validReport({ outcome: 'finished' as WorkerOutcome }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/outcome .* not in/);
  });

  it('rejects an empty commitShas (the L18 "no SHA" tell)', () => {
    const r = validateWorkerReport(validReport({ commitShas: [] }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/commitShas/);
  });

  it('rejects a non-integer filesChanged count', () => {
    const r = validateWorkerReport(
      validReport({ filesChanged: { new: 1.5, modified: 0, renamed: 0 } }),
    );
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/filesChanged\.new/);
  });

  it('rejects a missing required string (issue)', () => {
    const r = validateWorkerReport(validReport({ issue: '' }));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/issue/);
  });

  it('rejects a non-array judgmentCalls', () => {
    const bad = { ...validReport(), judgmentCalls: 'none' };
    const r = validateWorkerReport(bad);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/judgmentCalls/);
  });
});

// ─── outcomeToEvent — full mapping ──────────────────────────────────────────

const OUTCOME_EVENT: Array<[WorkerOutcome, WaveEvent]> = [
  ['done', 'worker-done'],
  ['done-with-concerns', 'worker-done'],
  ['needs-context', 'worker-needs-context'],
  ['blocked', 'worker-failed-after-retry'],
];

describe('outcomeToEvent — Outcome → WaveEvent', () => {
  for (const [outcome, expected] of OUTCOME_EVENT) {
    it(`${outcome} → ${expected}`, () => {
      expect(outcomeToEvent(outcome)).toBe(expected);
    });
  }

  it('covers every Outcome value (exhaustive)', () => {
    expect(OUTCOME_EVENT.map(([o]) => o).sort()).toEqual(
      [...WORKER_OUTCOME_VALUES].sort(),
    );
  });

  it('produces only events that exist in WAVE_EVENTS', () => {
    for (const outcome of WORKER_OUTCOME_VALUES) {
      expect(WAVE_EVENTS).toContain(outcomeToEvent(outcome));
    }
  });

  it('done and done-with-concerns both route to worker-done (advisory distinction)', () => {
    expect(outcomeToEvent('done')).toBe(outcomeToEvent('done-with-concerns'));
  });

  it('throws on an unknown outcome rather than guessing', () => {
    expect(() => outcomeToEvent('complete' as WorkerOutcome)).toThrow(
      /unrecognised outcome/,
    );
    expect(() => outcomeToEvent('' as WorkerOutcome)).toThrow(
      /unrecognised outcome/,
    );
  });
});

// ─── JSON-Schema shape (the artefact the Workflow tool enforces) ────────────

describe('WORKER_REPORT_JSON_SCHEMA shape', () => {
  it('is a closed object (additionalProperties: false)', () => {
    expect(WORKER_REPORT_JSON_SCHEMA.type).toBe('object');
    expect(WORKER_REPORT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('requires the routing-critical + count fields', () => {
    expect(WORKER_REPORT_JSON_SCHEMA.required).toEqual(
      expect.arrayContaining([
        'outcome',
        'issue',
        'branch',
        'commitShas',
        'filesChanged',
        'tests',
        'lint',
      ]),
    );
  });

  it('constrains outcome to exactly WORKER_OUTCOME_VALUES', () => {
    expect(WORKER_REPORT_JSON_SCHEMA.properties.outcome.enum).toEqual([
      ...WORKER_OUTCOME_VALUES,
    ]);
  });

  it('requires commitShas to be non-empty (minItems 1)', () => {
    expect(WORKER_REPORT_JSON_SCHEMA.properties.commitShas.minItems).toBe(1);
  });
});

// ─── prUrl is conditionally required (FOR-24 / retro W3-F2) ─────────────────

/**
 * Shape of the `anyOf` branch list, read back out of the literal under test.
 * A branch may pin which `outcome`s it applies to, and may add `required` keys.
 */
interface AnyOfBranch {
  properties?: { outcome?: { enum?: string[] } };
  required?: string[];
}

/** JSON round-trip: strips `as const` readonly typing for structural reads. */
function plainSchema(): { required: string[]; anyOf?: AnyOfBranch[] } {
  return JSON.parse(JSON.stringify(WORKER_REPORT_JSON_SCHEMA));
}

/**
 * Minimal evaluator for the ONE conditional this schema encodes — the `anyOf`
 * branch list. Deliberately not a JSON-Schema engine (the repo ships none): it
 * reads the branches **out of the literal under test** rather than restating
 * the rule, so weakening or deleting the conditional fails these specs.
 *
 * Scope: only `properties.outcome.enum` (which outcomes a branch covers) and
 * `required` (which keys it demands) — the two keywords the conditional uses.
 */
function satisfiesConditional(report: WorkerReport | Record<string, unknown>): boolean {
  const fields = report as Record<string, unknown>;
  const branches = plainSchema().anyOf ?? [];
  // No conditional encoded at all ⇒ nothing constrains prUrl. Pinned below.
  if (branches.length === 0) return true;
  return branches.some((branch) => {
    const covered = branch.properties?.outcome?.enum;
    if (covered && !covered.includes(fields.outcome as string)) return false;
    return (branch.required ?? []).every((key) => fields[key] !== undefined);
  });
}

/** The report minus a named key — for the "Worker omitted prUrl" case. */
function without(report: WorkerReport, key: keyof WorkerReport): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...report };
  delete copy[key];
  return copy;
}

describe('WORKER_REPORT_JSON_SCHEMA — prUrl conditional (W3-F2)', () => {
  it('encodes the conditional at all (guards the evaluator above)', () => {
    expect(plainSchema().anyOf ?? []).not.toHaveLength(0);
  });

  it('leaves prUrl out of the unconditional required list', () => {
    // Non-finishing outcomes legitimately have no PR — a blanket require would
    // reject every honest `blocked` report.
    expect(WORKER_REPORT_JSON_SCHEMA.required).not.toContain('prUrl');
  });

  // ── accept: a finishing report that carries the PR URL ──
  for (const outcome of ['done', 'done-with-concerns'] as const) {
    it(`accepts ${outcome} WITH prUrl`, () => {
      expect(satisfiesConditional(validReport({ outcome }))).toBe(true);
    });
  }

  // ── reject: the FOR-19 defect — finished, PR opened, prUrl omitted ──
  for (const outcome of ['done', 'done-with-concerns'] as const) {
    it(`rejects ${outcome} WITHOUT prUrl (the W3-F2 defect)`, () => {
      expect(satisfiesConditional(without(validReport({ outcome }), 'prUrl'))).toBe(
        false,
      );
    });
  }

  // ── accept: non-finishing outcomes, prUrl absent (no PR exists yet) ──
  for (const outcome of ['needs-context', 'blocked'] as const) {
    it(`accepts ${outcome} WITHOUT prUrl`, () => {
      expect(satisfiesConditional(without(validReport({ outcome }), 'prUrl'))).toBe(
        true,
      );
    });
  }

  it('still allows prUrl on a non-finishing outcome (permitted, not required)', () => {
    expect(satisfiesConditional(validReport({ outcome: 'blocked' }))).toBe(true);
  });

  it('routes every WorkerOutcome through exactly one branch (exhaustive)', () => {
    // A 5th outcome must not silently fall outside the conditional.
    const covered = (plainSchema().anyOf ?? []).flatMap(
      (b) => b.properties?.outcome?.enum ?? [],
    );
    expect([...covered].sort()).toEqual([...WORKER_OUTCOME_VALUES].sort());
  });

  it('uses anyOf, not if/then (the documented-supported keyword set)', () => {
    // Anthropic's structured-output schema subset documents anyOf/allOf but not
    // if/then — anyOf is the conservative encoding. See the source docblock.
    const schema = plainSchema() as Record<string, unknown>;
    expect(schema.anyOf).toBeDefined();
    expect(schema.if).toBeUndefined();
  });

  it('rejects an empty-string prUrl on a finishing outcome', () => {
    expect(WORKER_REPORT_JSON_SCHEMA.properties.prUrl.minLength).toBe(1);
  });
});

// ─── enum sanity ────────────────────────────────────────────────────────────

describe('WORKER_OUTCOME_VALUES', () => {
  it('is exactly the four #53 implementer-protocol statuses', () => {
    expect([...WORKER_OUTCOME_VALUES]).toEqual([
      'done',
      'done-with-concerns',
      'needs-context',
      'blocked',
    ]);
  });
});
