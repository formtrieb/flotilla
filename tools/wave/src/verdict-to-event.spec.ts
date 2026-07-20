/**
 * Table-driven spec for the verdictToEvent() adapter (wave-orchestration #64).
 *
 * Covers every (verdict × iteration × risk) combination that maps to a
 * WaveEvent, plus the loud-rejection cases (unknown verdict / risk,
 * out-of-range iteration). The G3 regression guard — `approve` +
 * `public-API-change` → `reviewer-approve-public-api`, NEVER plain
 * `reviewer-approve` — is asserted explicitly.
 */

import { describe, expect, it } from 'vitest';
import { RISK_VALUES, type Risk } from './header-parser';
import { WAVE_EVENTS, type WaveEvent } from './stop-condition-state-machine';
import {
  VERDICT_VALUES,
  verdictToEvent,
  type Verdict,
} from './verdict-to-event';

// ─── full mapping matrix ────────────────────────────────────────────────────
//
// Every combination of (verdict, iteration, risk) that produces an event.
// iteration ∈ {1, 2}; risk ∈ all 4 RISK_VALUES.

type Row = {
  verdict: Verdict;
  iteration: 1 | 2;
  risk: Risk;
  expected: WaveEvent;
};

const NON_PUBLIC_RISKS: Risk[] = [
  'mechanical',
  'isolated-refactor',
  'cross-feature-refactor',
];

const matrix: Row[] = [
  // ── approve × public-API-change → public-api event (the G3 guard) ──────────
  {
    verdict: 'approve',
    iteration: 1,
    risk: 'public-API-change',
    expected: 'reviewer-approve-public-api',
  },
  {
    verdict: 'approve',
    iteration: 2,
    risk: 'public-API-change',
    expected: 'reviewer-approve-public-api',
  },

  // ── approve × non-public-API risk → plain approve (auto-PR fast path) ──────
  ...NON_PUBLIC_RISKS.flatMap((risk): Row[] => [
    { verdict: 'approve', iteration: 1, risk, expected: 'reviewer-approve' },
    { verdict: 'approve', iteration: 2, risk, expected: 'reviewer-approve' },
  ]),

  // ── changes-requested → 1st / 2nd by iteration (risk-independent) ──────────
  ...RISK_VALUES.flatMap((risk): Row[] => [
    {
      verdict: 'changes-requested',
      iteration: 1,
      risk,
      expected: 'reviewer-changes-requested-1st',
    },
    {
      verdict: 'changes-requested',
      iteration: 2,
      risk,
      expected: 'reviewer-changes-requested-2nd',
    },
  ]),

  // ── questions-blocking → single event (iteration- & risk-independent) ──────
  ...RISK_VALUES.flatMap((risk): Row[] => [
    {
      verdict: 'questions-blocking',
      iteration: 1,
      risk,
      expected: 'reviewer-questions-blocking',
    },
    {
      verdict: 'questions-blocking',
      iteration: 2,
      risk,
      expected: 'reviewer-questions-blocking',
    },
  ]),
];

describe('verdictToEvent — full (verdict × iteration × risk) matrix', () => {
  for (const { verdict, iteration, risk, expected } of matrix) {
    it(`(${verdict}, iter=${iteration}, ${risk}) → ${expected}`, () => {
      expect(verdictToEvent(verdict, iteration, risk)).toBe(expected);
    });
  }

  it('produces only events that exist in WAVE_EVENTS', () => {
    for (const { verdict, iteration, risk } of matrix) {
      expect(WAVE_EVENTS).toContain(verdictToEvent(verdict, iteration, risk));
    }
  });
});

// ─── G3 regression guard (explicit) ─────────────────────────────────────────

describe('G3 guard: public-API approve never collapses to the auto-PR fast path', () => {
  it('approve + public-API-change → reviewer-approve-public-api (the STOP path)', () => {
    expect(verdictToEvent('approve', 1, 'public-API-change')).toBe(
      'reviewer-approve-public-api',
    );
  });

  it('approve + public-API-change is NOT plain reviewer-approve', () => {
    expect(verdictToEvent('approve', 1, 'public-API-change')).not.toBe(
      'reviewer-approve',
    );
  });

  it('approve on every non-public-API risk IS plain reviewer-approve', () => {
    for (const risk of NON_PUBLIC_RISKS) {
      expect(verdictToEvent('approve', 1, risk)).toBe('reviewer-approve');
    }
  });
});

// ─── changes-requested iteration mapping ────────────────────────────────────

describe('changes-requested maps to -1st / -2nd by iteration', () => {
  it('iteration 1 → reviewer-changes-requested-1st', () => {
    expect(verdictToEvent('changes-requested', 1, 'isolated-refactor')).toBe(
      'reviewer-changes-requested-1st',
    );
  });

  it('iteration 2 → reviewer-changes-requested-2nd', () => {
    expect(verdictToEvent('changes-requested', 2, 'isolated-refactor')).toBe(
      'reviewer-changes-requested-2nd',
    );
  });
});

// ─── loud rejection (throw, do not guess) ───────────────────────────────────

describe('rejects loudly rather than returning a wrong event', () => {
  it('throws on an unknown verdict value', () => {
    expect(() =>
      verdictToEvent('approved' as Verdict, 1, 'mechanical'),
    ).toThrow(/unrecognised verdict/);
  });

  it('throws on an empty / missing verdict', () => {
    expect(() => verdictToEvent('' as Verdict, 1, 'mechanical')).toThrow(
      /unrecognised verdict/,
    );
  });

  it('throws on iteration > 2 (re-dispatch cap = 1)', () => {
    expect(() => verdictToEvent('changes-requested', 3, 'mechanical')).toThrow(
      /iteration .* out of range/,
    );
  });

  it('throws on iteration < 1', () => {
    expect(() => verdictToEvent('changes-requested', 0, 'mechanical')).toThrow(
      /iteration .* out of range/,
    );
  });

  it('throws on a non-integer iteration', () => {
    expect(() =>
      verdictToEvent('changes-requested', 1.5, 'mechanical'),
    ).toThrow(/iteration .* out of range/);
  });

  it('validates iteration uniformly — even verdicts that ignore it throw on out-of-range', () => {
    // The iteration guard runs before the switch, so a bad iteration is
    // rejected regardless of verdict (not only on the changes-requested path).
    expect(() => verdictToEvent('approve', 3, 'mechanical')).toThrow(
      /iteration .* out of range/,
    );
    expect(() => verdictToEvent('questions-blocking', 3, 'mechanical')).toThrow(
      /iteration .* out of range/,
    );
  });

  it('throws on an unknown risk value (so approve cannot silently fast-path)', () => {
    expect(() => verdictToEvent('approve', 1, 'public-api' as Risk)).toThrow(
      /unrecognised risk/,
    );
  });
});

// ─── enum sanity ────────────────────────────────────────────────────────────

describe('VERDICT_VALUES', () => {
  it('is exactly the three wave-reviewer Verdict values', () => {
    expect([...VERDICT_VALUES]).toEqual([
      'approve',
      'changes-requested',
      'questions-blocking',
    ]);
  });
});
