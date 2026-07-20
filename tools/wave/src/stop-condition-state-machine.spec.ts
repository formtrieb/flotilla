/**
 * Exhaustive fixture-matrix test for the Stop-Condition state-machine.
 *
 * Covers all 143 cells of the 11-state × 13-event matrix documented in
 * .claude/skills/wave-start/references/stop-condition-handling.md §Fixture-matrix.
 *
 * Each cell is tested by the `matrix` table at the bottom of this file.
 * Re-generate snapshots with:
 *   NX_DAEMON=false NX_WORKSPACE_ROOT_PATH="" npx nx test wave-tools --update-snapshots
 */

import { describe, expect, it } from 'vitest';
import {
  ISSUE_STATES,
  WAVE_EVENTS,
  PARKABLE_FROM,
  canPark,
  transition,
  type IssueState,
  type Outcome,
  type WaveEvent,
} from './stop-condition-state-machine';

// ─── helpers ──────────────────────────────────────────────────────────────────

function t(nextState: IssueState): Outcome {
  return { type: 'transition', nextState };
}
function stop(reason: string, severity: string): Outcome {
  return { type: 'stop', reason, severity } as Outcome;
}
const warn: Outcome = { type: 'warn', reason: 'wallclock-exceeded' };
const noop: Outcome = { type: 'noop' };

// ─── canonical 11×13 fixture matrix ─────────────────────────────────────────
//
// Rows  = ISSUE_STATES  (11 — incl. `parked`, ADR-0022)
// Cols  = WAVE_EVENTS   (13)
// Order matches the enum order in stop-condition-state-machine.ts
//
// Outcome abbreviations:
//   t()   = transition
//   stop()= STOP<reason, severity>
//   warn  = WARN wallclock-exceeded
//   noop  = NO-OP

type Cell = [IssueState, WaveEvent, Outcome];

const matrix: Cell[] = [
  // ── planned (all no-op) ────────────────────────────────────────────────────
  ['planned', 'worker-done', noop],
  ['planned', 'reviewer-approve', noop],
  ['planned', 'reviewer-approve-public-api', noop],
  ['planned', 'reviewer-changes-requested-1st', noop],
  ['planned', 'reviewer-changes-requested-2nd', noop],
  ['planned', 'reviewer-questions-blocking', noop],
  ['planned', 'worker-failed-after-retry', noop],
  ['planned', 'same-file-conflict-detected', noop],
  ['planned', 'wallclock-exceeded', noop],
  ['planned', 'all-issues-done', noop],

  // ── dispatched ────────────────────────────────────────────────────────────
  ['dispatched', 'worker-done', t('report-in')],
  ['dispatched', 'reviewer-approve', noop],
  ['dispatched', 'reviewer-approve-public-api', noop],
  ['dispatched', 'reviewer-changes-requested-1st', noop],
  ['dispatched', 'reviewer-changes-requested-2nd', noop],
  ['dispatched', 'reviewer-questions-blocking', noop],
  ['dispatched', 'worker-failed-after-retry', stop('worker-failed', 'error')],
  [
    'dispatched',
    'same-file-conflict-detected',
    stop('same-file-conflict', 'blocking'),
  ],
  ['dispatched', 'wallclock-exceeded', warn],
  ['dispatched', 'all-issues-done', noop],

  // ── report-in ─────────────────────────────────────────────────────────────
  ['report-in', 'worker-done', noop],
  ['report-in', 'reviewer-approve', noop],
  ['report-in', 'reviewer-approve-public-api', noop],
  ['report-in', 'reviewer-changes-requested-1st', noop],
  ['report-in', 'reviewer-changes-requested-2nd', noop],
  ['report-in', 'reviewer-questions-blocking', noop],
  ['report-in', 'worker-failed-after-retry', noop],
  [
    'report-in',
    'same-file-conflict-detected',
    stop('same-file-conflict', 'blocking'),
  ],
  ['report-in', 'wallclock-exceeded', warn],
  ['report-in', 'all-issues-done', noop],

  // ── reviewing ─────────────────────────────────────────────────────────────
  ['reviewing', 'worker-done', noop],
  ['reviewing', 'reviewer-approve', t('approved')],
  [
    'reviewing',
    'reviewer-approve-public-api',
    stop('public-api-approval-required', 'blocking'),
  ],
  ['reviewing', 'reviewer-changes-requested-1st', t('re-dispatched')],
  ['reviewing', 'reviewer-changes-requested-2nd', noop],
  [
    'reviewing',
    'reviewer-questions-blocking',
    stop('reviewer-questions-blocking', 'blocking'),
  ],
  ['reviewing', 'worker-failed-after-retry', noop],
  ['reviewing', 'same-file-conflict-detected', noop],
  ['reviewing', 'wallclock-exceeded', warn],
  ['reviewing', 'all-issues-done', noop],

  // ── verdict-in ────────────────────────────────────────────────────────────
  ['verdict-in', 'worker-done', noop],
  ['verdict-in', 'reviewer-approve', t('approved')],
  [
    'verdict-in',
    'reviewer-approve-public-api',
    stop('public-api-approval-required', 'blocking'),
  ],
  ['verdict-in', 'reviewer-changes-requested-1st', noop],
  ['verdict-in', 'reviewer-changes-requested-2nd', noop],
  [
    'verdict-in',
    'reviewer-questions-blocking',
    stop('reviewer-questions-blocking', 'blocking'),
  ],
  ['verdict-in', 'worker-failed-after-retry', noop],
  ['verdict-in', 'same-file-conflict-detected', noop],
  ['verdict-in', 'wallclock-exceeded', noop],
  ['verdict-in', 'all-issues-done', noop],

  // ── re-dispatched ─────────────────────────────────────────────────────────
  ['re-dispatched', 'worker-done', t('report-in')],
  ['re-dispatched', 'reviewer-approve', noop],
  ['re-dispatched', 'reviewer-approve-public-api', noop],
  ['re-dispatched', 'reviewer-changes-requested-1st', noop],
  [
    're-dispatched',
    'reviewer-changes-requested-2nd',
    stop('re-dispatch-cap-exhausted', 'error'),
  ],
  [
    're-dispatched',
    'reviewer-questions-blocking',
    stop('reviewer-questions-blocking', 'blocking'),
  ],
  [
    're-dispatched',
    'worker-failed-after-retry',
    stop('worker-failed', 'error'),
  ],
  [
    're-dispatched',
    'same-file-conflict-detected',
    stop('same-file-conflict', 'blocking'),
  ],
  ['re-dispatched', 'wallclock-exceeded', warn],
  ['re-dispatched', 'all-issues-done', noop],

  // ── approved ──────────────────────────────────────────────────────────────
  ['approved', 'worker-done', noop],
  ['approved', 'reviewer-approve', t('pr-created')],
  ['approved', 'reviewer-approve-public-api', noop],
  ['approved', 'reviewer-changes-requested-1st', noop],
  ['approved', 'reviewer-changes-requested-2nd', noop],
  ['approved', 'reviewer-questions-blocking', noop],
  ['approved', 'worker-failed-after-retry', noop],
  ['approved', 'same-file-conflict-detected', noop],
  ['approved', 'wallclock-exceeded', noop],
  ['approved', 'all-issues-done', stop('wave-complete-pending-close', 'info')],

  // ── pr-created (terminal) ─────────────────────────────────────────────────
  ['pr-created', 'worker-done', noop],
  ['pr-created', 'reviewer-approve', noop],
  ['pr-created', 'reviewer-approve-public-api', noop],
  ['pr-created', 'reviewer-changes-requested-1st', noop],
  ['pr-created', 'reviewer-changes-requested-2nd', noop],
  ['pr-created', 'reviewer-questions-blocking', noop],
  ['pr-created', 'worker-failed-after-retry', noop],
  ['pr-created', 'same-file-conflict-detected', noop],
  ['pr-created', 'wallclock-exceeded', noop],
  [
    'pr-created',
    'all-issues-done',
    stop('wave-complete-pending-close', 'info'),
  ],

  // ── failed (terminal) ─────────────────────────────────────────────────────
  ['failed', 'worker-done', noop],
  ['failed', 'reviewer-approve', noop],
  ['failed', 'reviewer-approve-public-api', noop],
  ['failed', 'reviewer-changes-requested-1st', noop],
  ['failed', 'reviewer-changes-requested-2nd', noop],
  ['failed', 'reviewer-questions-blocking', noop],
  ['failed', 'worker-failed-after-retry', noop],
  ['failed', 'same-file-conflict-detected', noop],
  ['failed', 'wallclock-exceeded', noop],
  ['failed', 'all-issues-done', stop('wave-complete-pending-close', 'info')],

  // ── abandoned (terminal) ──────────────────────────────────────────────────
  ['abandoned', 'worker-done', noop],
  ['abandoned', 'reviewer-approve', noop],
  ['abandoned', 'reviewer-approve-public-api', noop],
  ['abandoned', 'reviewer-changes-requested-1st', noop],
  ['abandoned', 'reviewer-changes-requested-2nd', noop],
  ['abandoned', 'reviewer-questions-blocking', noop],
  ['abandoned', 'worker-failed-after-retry', noop],
  ['abandoned', 'same-file-conflict-detected', noop],
  ['abandoned', 'wallclock-exceeded', noop],
  ['abandoned', 'all-issues-done', stop('wave-complete-pending-close', 'info')],

  // ── parked (terminal, ADR-0022) ───────────────────────────────────────────
  // The silent terminal: claim-releasing, set by the Coordinator, never reached
  // by an event. From `parked` every event is invalid — identical to `abandoned`.
  ['parked', 'worker-done', noop],
  ['parked', 'reviewer-approve', noop],
  ['parked', 'reviewer-approve-public-api', noop],
  ['parked', 'reviewer-changes-requested-1st', noop],
  ['parked', 'reviewer-changes-requested-2nd', noop],
  ['parked', 'reviewer-questions-blocking', noop],
  ['parked', 'worker-failed-after-retry', noop],
  ['parked', 'same-file-conflict-detected', noop],
  ['parked', 'wallclock-exceeded', noop],
  ['parked', 'all-issues-done', stop('wave-complete-pending-close', 'info')],

  // ── worker-needs-context column (#53 — re-dispatch-with-context) ────────────
  // Valid only from a live Worker state: `dispatched` (1st attempt) re-dispatches;
  // `re-dispatched` (2nd attempt) exhausts the re-dispatch cap and STOPs. Every
  // other state is a no-op (Worker not running / wrong phase).
  ['planned', 'worker-needs-context', noop],
  ['dispatched', 'worker-needs-context', t('re-dispatched')],
  ['report-in', 'worker-needs-context', noop],
  ['reviewing', 'worker-needs-context', noop],
  ['verdict-in', 'worker-needs-context', noop],
  [
    're-dispatched',
    'worker-needs-context',
    stop('re-dispatch-cap-exhausted', 'error'),
  ],
  ['approved', 'worker-needs-context', noop],
  ['pr-created', 'worker-needs-context', noop],
  ['failed', 'worker-needs-context', noop],
  ['abandoned', 'worker-needs-context', noop],
  ['parked', 'worker-needs-context', noop],

  // ── worker-stalled column (#66 — stall watchdog, warn→blocking escalation) ──
  // Valid only from a live Worker state: `dispatched` (1st stall) STOPs warn;
  // `re-dispatched` (2nd stall, hard ceiling) escalates to blocking. Every other
  // state is a no-op (Worker not running / wrong phase). Both bounded → terminates.
  ['planned', 'worker-stalled', noop],
  ['dispatched', 'worker-stalled', stop('worker-stalled', 'warn')],
  ['report-in', 'worker-stalled', noop],
  ['reviewing', 'worker-stalled', noop],
  ['verdict-in', 'worker-stalled', noop],
  ['re-dispatched', 'worker-stalled', stop('worker-stalled', 'blocking')],
  ['approved', 'worker-stalled', noop],
  ['pr-created', 'worker-stalled', noop],
  ['failed', 'worker-stalled', noop],
  ['abandoned', 'worker-stalled', noop],
  ['parked', 'worker-stalled', noop],

  // ── worker-failed-transient column (#66 — bounded auto-retry, cap = 1) ───────
  // From `dispatched` (1st attempt) the transient failure auto-retries once
  // (`→ re-dispatched`, consuming the re-dispatch budget). From `re-dispatched`
  // (retry spent) it routes to the genuine hard-failure STOP. Every other state
  // is a no-op. Cap = 1 → termination guaranteed.
  ['planned', 'worker-failed-transient', noop],
  ['dispatched', 'worker-failed-transient', t('re-dispatched')],
  ['report-in', 'worker-failed-transient', noop],
  ['reviewing', 'worker-failed-transient', noop],
  ['verdict-in', 'worker-failed-transient', noop],
  ['re-dispatched', 'worker-failed-transient', stop('worker-failed', 'error')],
  ['approved', 'worker-failed-transient', noop],
  ['pr-created', 'worker-failed-transient', noop],
  ['failed', 'worker-failed-transient', noop],
  ['abandoned', 'worker-failed-transient', noop],
  ['parked', 'worker-failed-transient', noop],
];

// ─── matrix completeness guard ────────────────────────────────────────────────

it('fixture matrix covers all 143 cells', () => {
  expect(matrix).toHaveLength(ISSUE_STATES.length * WAVE_EVENTS.length);

  // Every (state, event) combination must appear exactly once.
  const seen = new Set<string>();
  for (const [state, event] of matrix) {
    const key = `${state}|${event}`;
    expect(seen.has(key), `duplicate cell: (${state}, ${event})`).toBe(false);
    seen.add(key);
  }
  for (const state of ISSUE_STATES) {
    for (const event of WAVE_EVENTS) {
      expect(
        seen.has(`${state}|${event}`),
        `missing cell: (${state}, ${event})`,
      ).toBe(true);
    }
  }
});

// ─── snapshot test ────────────────────────────────────────────────────────────

describe('transition — all 143 cells', () => {
  for (const [state, event, expected] of matrix) {
    it(`(${state}, ${event})`, () => {
      const result = transition(state, event);
      expect(result).toEqual(expected);
    });
  }
});

// ─── worker-needs-context (#53 — four-status Worker Outcome) ──────────────────

describe('worker-needs-context — re-dispatch-with-context', () => {
  it('(dispatched, worker-needs-context) → re-dispatched (1st attempt re-dispatches with context)', () => {
    expect(transition('dispatched', 'worker-needs-context')).toEqual(
      t('re-dispatched'),
    );
  });

  it('(re-dispatched, worker-needs-context) → STOP re-dispatch-cap-exhausted (cap applies to context re-dispatch too)', () => {
    expect(transition('re-dispatched', 'worker-needs-context')).toEqual(
      stop('re-dispatch-cap-exhausted', 'error'),
    );
  });

  it('(reviewing, worker-needs-context) → noop (Worker event in a Reviewer state)', () => {
    expect(transition('reviewing', 'worker-needs-context')).toEqual(noop);
  });

  it('(planned, worker-needs-context) → noop (Worker not dispatched yet)', () => {
    expect(transition('planned', 'worker-needs-context')).toEqual(noop);
  });

  it('worker-needs-context is a registered WAVE_EVENTS value', () => {
    expect(WAVE_EVENTS).toContain('worker-needs-context');
  });
});

// ─── worker-stalled (#66 — stall watchdog, warn→blocking escalation) ──────────

describe('worker-stalled — stall watchdog', () => {
  it('(dispatched, worker-stalled) → STOP worker-stalled/warn (1st stall, non-terminal — surface §6.5 checklist)', () => {
    expect(transition('dispatched', 'worker-stalled')).toEqual(
      stop('worker-stalled', 'warn'),
    );
  });

  it('(re-dispatched, worker-stalled) → STOP worker-stalled/blocking (2nd stall = hard ceiling, escalates)', () => {
    expect(transition('re-dispatched', 'worker-stalled')).toEqual(
      stop('worker-stalled', 'blocking'),
    );
  });

  it('(reviewing, worker-stalled) → noop (Worker event in a Reviewer state)', () => {
    expect(transition('reviewing', 'worker-stalled')).toEqual(noop);
  });

  it('(planned, worker-stalled) → noop (Worker not dispatched yet)', () => {
    expect(transition('planned', 'worker-stalled')).toEqual(noop);
  });

  it('worker-stalled is a registered WAVE_EVENTS value', () => {
    expect(WAVE_EVENTS).toContain('worker-stalled');
  });

  it('escalation is bounded: warn then blocking, never loops back to a live state', () => {
    // 1st stall STOPs (warn); a 2nd stall STOPs harder (blocking). Neither
    // returns a transition, so the watchdog can never spin a 3rd live attempt.
    const first = transition('dispatched', 'worker-stalled');
    const second = transition('re-dispatched', 'worker-stalled');
    expect(first.type).toBe('stop');
    expect(second.type).toBe('stop');
  });
});

// ─── worker-failed-transient (#66 — bounded auto-retry, cap = 1) ──────────────

describe('worker-failed-transient — bounded transient-failure auto-retry', () => {
  it('(dispatched, worker-failed-transient) → re-dispatched (1st attempt auto-retries once with backoff)', () => {
    expect(transition('dispatched', 'worker-failed-transient')).toEqual(
      t('re-dispatched'),
    );
  });

  it('(re-dispatched, worker-failed-transient) → STOP worker-failed/error (retry spent — genuine hard-failure path)', () => {
    expect(transition('re-dispatched', 'worker-failed-transient')).toEqual(
      stop('worker-failed', 'error'),
    );
  });

  it('(reviewing, worker-failed-transient) → noop (Worker event in a Reviewer state)', () => {
    expect(transition('reviewing', 'worker-failed-transient')).toEqual(noop);
  });

  it('(planned, worker-failed-transient) → noop (Worker not dispatched yet)', () => {
    expect(transition('planned', 'worker-failed-transient')).toEqual(noop);
  });

  it('worker-failed-transient is a registered WAVE_EVENTS value', () => {
    expect(WAVE_EVENTS).toContain('worker-failed-transient');
  });

  it('retry cap = 1: 1st transient re-dispatches, 2nd STOPs (termination guaranteed)', () => {
    // The single retry from `dispatched` consumes the budget; the 2nd from
    // `re-dispatched` cannot re-dispatch again — it terminates via STOP.
    expect(transition('dispatched', 'worker-failed-transient').type).toBe(
      'transition',
    );
    expect(transition('re-dispatched', 'worker-failed-transient').type).toBe(
      'stop',
    );
  });
});

// ─── riskClass auto-promotion ─────────────────────────────────────────────────

describe('transition — riskClass auto-promotion', () => {
  it('reviewer-approve + riskClass=public-API-change → STOP', () => {
    expect(
      transition('reviewing', 'reviewer-approve', 'public-API-change'),
    ).toEqual(stop('public-api-approval-required', 'blocking'));
  });

  it('reviewer-approve + riskClass=isolated-refactor → approved (non-public-API fast path)', () => {
    expect(
      transition('reviewing', 'reviewer-approve', 'isolated-refactor'),
    ).toEqual(t('approved'));
  });

  it('reviewer-approve + no riskClass → approved (non-public-API fast path)', () => {
    expect(transition('reviewing', 'reviewer-approve')).toEqual(t('approved'));
  });

  it('reviewer-approve + riskClass=public-API-change on verdict-in → STOP', () => {
    expect(
      transition('verdict-in', 'reviewer-approve', 'public-API-change'),
    ).toEqual(stop('public-api-approval-required', 'blocking'));
  });
});

// ─── re-dispatch cap invariant ────────────────────────────────────────────────

describe('re-dispatch cap = 1', () => {
  it('(reviewing, reviewer-changes-requested-1st) → re-dispatched', () => {
    expect(transition('reviewing', 'reviewer-changes-requested-1st')).toEqual(
      t('re-dispatched'),
    );
  });

  it('(re-dispatched, reviewer-changes-requested-2nd) → STOP re-dispatch-cap-exhausted', () => {
    expect(
      transition('re-dispatched', 'reviewer-changes-requested-2nd'),
    ).toEqual(stop('re-dispatch-cap-exhausted', 'error'));
  });

  it('(reviewing, reviewer-changes-requested-2nd) → noop (wrong event for wrong state)', () => {
    expect(transition('reviewing', 'reviewer-changes-requested-2nd')).toEqual(
      noop,
    );
  });

  it('(dispatched, reviewer-changes-requested-1st) → noop (Reviewer not dispatched yet)', () => {
    expect(transition('dispatched', 'reviewer-changes-requested-1st')).toEqual(
      noop,
    );
  });
});

// ─── public-API STOP explicit ─────────────────────────────────────────────────

describe('public-API STOP explicit encoding', () => {
  it('(reviewing, reviewer-approve-public-api) → STOP blocking', () => {
    expect(transition('reviewing', 'reviewer-approve-public-api')).toEqual(
      stop('public-api-approval-required', 'blocking'),
    );
  });

  it('(verdict-in, reviewer-approve-public-api) → STOP blocking', () => {
    expect(transition('verdict-in', 'reviewer-approve-public-api')).toEqual(
      stop('public-api-approval-required', 'blocking'),
    );
  });

  it('(reviewing, reviewer-approve) → approved (non-public-API fast path)', () => {
    expect(transition('reviewing', 'reviewer-approve')).toEqual(t('approved'));
  });
});

// ─── sample wave-run trace (smoke test) ───────────────────────────────────────

describe('sample wave-run trace: planned → dispatched → report-in → reviewing → approved → pr-created', () => {
  it('dispatched + worker-done → report-in', () => {
    expect(transition('dispatched', 'worker-done')).toEqual(t('report-in'));
  });

  it('reviewing + reviewer-approve (non-public-API) → approved', () => {
    expect(
      transition('reviewing', 'reviewer-approve', 'isolated-refactor'),
    ).toEqual(t('approved'));
  });

  it('approved + reviewer-approve (loop-driver calls host-pr create) → pr-created', () => {
    expect(transition('approved', 'reviewer-approve')).toEqual(t('pr-created'));
  });

  it('pr-created + all-issues-done → STOP wave-complete-pending-close', () => {
    expect(transition('pr-created', 'all-issues-done')).toEqual(
      stop('wave-complete-pending-close', 'info'),
    );
  });
});

// The state machine's whole value is being a TOTAL function over the closed
// IssueState union. currentState arrives from durable I/O (the spine Plan-Table
// state column, parsed markdown), so a corrupt/unknown string is a real input.
// Without a default arm the outer switch falls through and returns `undefined`
// while the type says `Outcome` — a silent type lie. It must fail loud instead.
describe('out-of-union currentState from durable I/O — loud rejection (totality guard)', () => {
  it('throws rather than silently returning undefined for an unknown state', () => {
    expect(() =>
      transition('gibberish-from-spine' as IssueState, 'worker-done'),
    ).toThrow();
  });

  it('names the offending state in the thrown error', () => {
    expect(() =>
      transition('corrupt-state' as IssueState, 'worker-done'),
    ).toThrow(/corrupt-state/);
  });
});

// ─── parked (ADR-0022 — the claim-releasing, terminal-but-silent 11th state) ──

describe('parked — the claim-releasing terminal (ADR-0022)', () => {
  it('is a registered fine state; the vocabulary is now 11 states', () => {
    expect(ISSUE_STATES).toContain('parked');
    expect(ISSUE_STATES).toHaveLength(11);
  });

  // ADR-0022 §Decisions 1: "Entry edges: exactly two — planned → parked and
  // failed → parked." Parking is Coordinator-set, not event-emitted (§5), so no
  // WaveEvent carries the edge — `canPark` is the machine-checkable home of the
  // rule that the skills' scripted disposition consults.
  it('admits entry from EXACTLY planned and failed', () => {
    expect([...PARKABLE_FROM].sort()).toEqual(['failed', 'planned']);
  });

  it('canPark() is true for the two entry states', () => {
    expect(canPark('planned')).toBe(true);
    expect(canPark('failed')).toBe(true);
  });

  it('canPark() is false for every live state — a running row resolves first', () => {
    const live: IssueState[] = [
      'dispatched',
      'report-in',
      'reviewing',
      'verdict-in',
      're-dispatched',
      'approved',
      'pr-created',
    ];
    for (const s of live) expect(canPark(s), `canPark(${s})`).toBe(false);
  });

  it('canPark() is false from the other terminals — parked is not a re-disposition', () => {
    expect(canPark('abandoned')).toBe(false);
    // ADR-0022 §6: no un-park. `parked` is terminal; re-entry is a fresh row.
    expect(canPark('parked')).toBe(false);
  });

  it('canPark() partitions the vocabulary — no state outside PARKABLE_FROM parks', () => {
    const parkable: readonly IssueState[] = PARKABLE_FROM;
    for (const s of ISSUE_STATES) {
      expect(canPark(s), `canPark(${s})`).toBe(parkable.includes(s));
    }
  });

  it('every event from parked is invalid (terminal, like abandoned)', () => {
    for (const e of WAVE_EVENTS) {
      const expected =
        e === 'all-issues-done'
          ? stop('wave-complete-pending-close', 'info')
          : noop;
      expect(transition('parked', e), `(parked, ${e})`).toEqual(expected);
    }
  });
});
