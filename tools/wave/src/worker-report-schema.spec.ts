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
  FINISHING_OUTCOMES,
  WORKER_OUTCOME_VALUES,
  WORKER_REPORT_JSON_SCHEMA,
  finishingReportLacksUsablePrUrl,
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

// ─── the engine-side prUrl gate (issue #556) ────────────────────────────────
//
// The canonical literal's `anyOf` never reaches the shipped dispatch (the
// driver copy must drop every top-level combinator), so the same invariant
// gets a second home the boundary cannot strip: a predicate the sidecar-write
// verb consults the moment the report becomes durable. These tests pin the
// PREDICATE; route-cli.spec.ts pins the notice it produces and the fact the
// sidecar still lands.

describe('finishingReportLacksUsablePrUrl — the sidecar-write gate predicate', () => {
  it('is keyed on FINISHING_OUTCOMES, which is exactly the set the schema conditional requires prUrl for', () => {
    // The AC's "referenced from the canonical const rather than re-enumerated"
    // half, asserted where it can actually be checked: the exported set and the
    // `anyOf` branch that demands `prUrl` must be one set, not two lists that
    // happen to agree today.
    const requiring = (plainSchema().anyOf ?? []).filter((b) =>
      (b.required ?? []).includes('prUrl'),
    );
    expect(requiring).toHaveLength(1);
    expect(requiring[0]!.properties?.outcome?.enum).toEqual([
      ...FINISHING_OUTCOMES,
    ]);
  });

  it('FINISHING_OUTCOMES is a strict subset of WORKER_OUTCOME_VALUES', () => {
    for (const outcome of FINISHING_OUTCOMES) {
      expect(WORKER_OUTCOME_VALUES).toContain(outcome);
    }
    expect(FINISHING_OUTCOMES.length).toBeLessThan(WORKER_OUTCOME_VALUES.length);
  });

  // ── fires: finished, no usable URL ──
  for (const outcome of FINISHING_OUTCOMES) {
    it(`fires on ${outcome} with prUrl ABSENT (the recurring live failure)`, () => {
      expect(
        finishingReportLacksUsablePrUrl(without(validReport({ outcome }), 'prUrl')),
      ).toBe(true);
    });

    it(`fires on ${outcome} with an EMPTY-STRING prUrl — usable means non-empty (issue #303)`, () => {
      // A presence-only check would walk straight past this shape, which is the
      // one that actually shipped: two rows returned `done` with `prUrl: ""`
      // while their PRs demonstrably existed.
      expect(finishingReportLacksUsablePrUrl(validReport({ outcome, prUrl: '' }))).toBe(
        true,
      );
    });

    it(`fires on ${outcome} with a WHITESPACE-ONLY prUrl (unusable by the same standard)`, () => {
      expect(
        finishingReportLacksUsablePrUrl(validReport({ outcome, prUrl: '   ' })),
      ).toBe(true);
    });
  }

  it('fires on a non-string prUrl — the structural validator does not type this field, so one can arrive', () => {
    expect(
      finishingReportLacksUsablePrUrl({ ...validReport(), prUrl: 42 }),
    ).toBe(true);
    expect(
      finishingReportLacksUsablePrUrl({ ...validReport(), prUrl: null }),
    ).toBe(true);
  });

  // ── silent: nothing to report ──
  for (const outcome of FINISHING_OUTCOMES) {
    it(`is SILENT on ${outcome} carrying a real URL`, () => {
      expect(finishingReportLacksUsablePrUrl(validReport({ outcome }))).toBe(false);
    });
  }

  for (const outcome of ['needs-context', 'blocked'] as const) {
    it(`is SILENT on ${outcome} without prUrl — a row that did not finish has no PR to name`, () => {
      expect(
        finishingReportLacksUsablePrUrl(without(validReport({ outcome }), 'prUrl')),
      ).toBe(false);
    });

    it(`is SILENT on ${outcome} with an empty prUrl — the gate asks about FINISHED work only`, () => {
      expect(
        finishingReportLacksUsablePrUrl(validReport({ outcome, prUrl: '' })),
      ).toBe(false);
    });
  }

  it('is SILENT on a non-object and on an out-of-enum outcome (this gate is not a validator)', () => {
    // validateWorkerReport owns "is this a report at all"; a malformed payload
    // is refused there and never reaches the write, so answering `true` here
    // would only add a second, redundant complaint about the same bytes.
    expect(finishingReportLacksUsablePrUrl(null)).toBe(false);
    expect(finishingReportLacksUsablePrUrl('done')).toBe(false);
    expect(finishingReportLacksUsablePrUrl([])).toBe(false);
    expect(
      finishingReportLacksUsablePrUrl({ outcome: 'shipped', prUrl: '' }),
    ).toBe(false);
  });

  it('validateWorkerReport stays silent about prUrl — the gate is a notice, not a validity rule', () => {
    // Load-bearing: if the validator ever rejected this shape, `write-report`
    // would refuse the write and a finished row would lose its durable record.
    for (const outcome of FINISHING_OUTCOMES) {
      expect(validateWorkerReport(without(validReport({ outcome }), 'prUrl')).valid).toBe(
        true,
      );
      expect(validateWorkerReport(validReport({ outcome, prUrl: '' })).valid).toBe(true);
    }
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
