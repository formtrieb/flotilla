/**
 * Table-driven spec for the verdictToEvent() adapter (wave-orchestration #64).
 *
 * Covers every (verdict × iteration × risk) combination that maps to a
 * WaveEvent, plus the loud-rejection cases (unknown verdict / risk,
 * out-of-range iteration). The G3 regression guard — `approve` +
 * `public-API-change` → `reviewer-approve-public-api`, NEVER plain
 * `reviewer-approve` — is asserted explicitly.
 *
 * The final three blocks cover the OPERATOR-RULED ROUND (issue #684): the
 * above-cap cell, its cap-accounting identity with an ordinary round, and — the
 * one that matters most — the NEGATIVE CONTROL that the cap was not quietly
 * widened for everyone. That control asserts the refusal message BYTE-FOR-BYTE,
 * because "iteration 3 is refused" and "iteration 3 is refused with a different,
 * vaguer message than it used to print" are not the same fact, and only the
 * first one means the fix is narrow.
 */

import { describe, expect, it } from 'vitest';
import { RISK_VALUES, type Risk } from './header-parser';
import { transition, WAVE_EVENTS, type WaveEvent } from './stop-condition-state-machine';
import {
  RULED_CELLS,
  rulingViolation,
  VERDICT_VALUES,
  verdictToEvent,
  verdictToRouting,
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

// ─── the Operator-ruled round (issue #684) ──────────────────────────────────
//
// A second changes-requested exhausts the cap and stops the row. The documented
// recovery is an Operator ruling: fix the world, re-dispatch the REVIEWER ONLY,
// outside the cap, with the spine row bumped so the sidecars land at iteration
// 3. Two live occurrences (2026-08-16, 2026-09-03) both ended with the routing
// done by hand, because the router had no cell for the round.

/** A ruling shaped like the ones the live occurrences produced. */
const RULING =
  'Operator ruling 03:50 — the throwaway repository was deleted; re-dispatch the Reviewer only.';

/**
 * The refusal an above-cap iteration gets with NO ruling. Asserted BYTE-FOR-BYTE
 * below and quoted here once: this string is the negative control for the whole
 * feature. A fix that widened the range for everyone would still pass every
 * positive assertion in this file and would fail exactly here.
 */
const OUT_OF_RANGE_3 =
  'verdictToEvent: iteration 3 is out of range. Expected an integer in [1, 2] (re-dispatch cap = 1).';

describe('a ruled round is admitted ONLY by a stated reason', () => {
  it('an above-cap approve with a ruling routes, and names its own cell', () => {
    expect(verdictToRouting('approve', 3, 'mechanical', RULING)).toEqual({
      event: 'reviewer-approve',
      ruled: { cell: 'reviewer-approve-ruled', ruling: RULING },
    });
  });

  it('the G3 bifurcation survives the ruled round — a public-API approve keeps the STOP event', () => {
    expect(verdictToRouting('approve', 3, 'public-API-change', RULING)).toEqual({
      event: 'reviewer-approve-public-api',
      ruled: { cell: 'reviewer-approve-public-api-ruled', ruling: RULING },
    });
  });

  it('an above-cap changes-requested routes to the CAP-EXHAUSTION event, never to -1st', () => {
    const routed = verdictToRouting('changes-requested', 3, 'isolated-refactor', RULING);
    expect(routed.event).toBe('reviewer-changes-requested-2nd');
    expect(routed.event).not.toBe('reviewer-changes-requested-1st');
    expect(routed.ruled).toEqual({ cell: 'reviewer-changes-requested-ruled', ruling: RULING });
  });

  it('an above-cap questions-blocking keeps its single event and gets its own cell', () => {
    expect(verdictToRouting('questions-blocking', 4, 'cross-feature-refactor', RULING)).toEqual({
      event: 'reviewer-questions-blocking',
      ruled: { cell: 'reviewer-questions-blocking-ruled', ruling: RULING },
    });
  });

  it('every ruled cell it can emit is one RULED_CELLS names, and every event still exists in WAVE_EVENTS', () => {
    for (const verdict of VERDICT_VALUES) {
      for (const risk of RISK_VALUES) {
        const routed = verdictToRouting(verdict, 3, risk, RULING);
        expect(WAVE_EVENTS).toContain(routed.event);
        expect(RULED_CELLS).toContain(routed.ruled!.cell);
      }
    }
  });

  it('the ruling is carried through trimmed, so a report can quote it verbatim', () => {
    const routed = verdictToRouting('approve', 3, 'mechanical', `  ${RULING}\n`);
    expect(routed.ruled!.ruling).toBe(RULING);
  });

  it('an ORDINARY round is untouched — no `ruled` key at all, so the printed JSON is what it always was', () => {
    expect(verdictToRouting('approve', 1, 'mechanical')).toEqual({ event: 'reviewer-approve' });
    expect(verdictToRouting('changes-requested', 1, 'mechanical')).toEqual({
      event: 'reviewer-changes-requested-1st',
    });
    expect(verdictToRouting('changes-requested', 2, 'mechanical')).toEqual({
      event: 'reviewer-changes-requested-2nd',
    });
  });

  it('verdictToEvent is still the event half of it, ruled round included', () => {
    expect(verdictToEvent('approve', 3, 'mechanical', RULING)).toBe('reviewer-approve');
    expect(verdictToEvent('approve', 1, 'mechanical')).toBe('reviewer-approve');
  });
});

describe('WITHOUT a ruling the cap is exactly where it was (the negative control)', () => {
  it('iteration 3 stays refused with the message it printed before the cell existed — byte for byte', () => {
    expect(() => verdictToRouting('approve', 3, 'mechanical')).toThrow(OUT_OF_RANGE_3);
    // …and the same string out of the original entry point, which is what the
    // CLI prints and what the issue that filed this row quoted.
    let message = '';
    try {
      verdictToEvent('changes-requested', 3, 'mechanical');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(OUT_OF_RANGE_3);
  });

  it('refuses an above-cap iteration for EVERY verdict, not only the one that reaches the cap', () => {
    for (const verdict of VERDICT_VALUES) {
      expect(() => verdictToRouting(verdict, 3, 'mechanical')).toThrow(RangeError);
    }
  });

  it('a ruling that states no reason does NOT admit the round — blank, bare token, or two words', () => {
    for (const stub of ['', '   ', 'true', 'yes', 'ok', 'ruled', 'operator ruling']) {
      expect(() => verdictToRouting('approve', 3, 'mechanical', stub)).toThrow(
        /A ruled round is auditable only if it states WHY it exists/,
      );
    }
  });

  it('rulingViolation names WHICH way the text falls short, so the refusal teaches', () => {
    expect(rulingViolation('   ')).toBe('is blank');
    expect(rulingViolation('too short')).toMatch(/character.* minimum/);
    expect(rulingViolation('reviewer-only-round-after-operator-ruling')).toMatch(/word.* minimum/);
    expect(rulingViolation(RULING)).toBeUndefined();
  });

  it('a ruling does NOT rescue a corrupt iteration — below 1, or not an integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => verdictToRouting('approve', bad, 'mechanical', RULING)).toThrow(
        /is not an above-cap round/,
      );
    }
  });

  it('a ruling INSIDE the cap is refused too — it is not decoration a caller may sprinkle on', () => {
    expect(() => verdictToRouting('approve', 1, 'mechanical', RULING)).toThrow(
      /is not an above-cap round/,
    );
    expect(() => verdictToRouting('changes-requested', 2, 'mechanical', RULING)).toThrow(
      /is not an above-cap round/,
    );
  });
});

describe('the ruled round never re-enters cap accounting', () => {
  it('a ruled approve at iteration 3 reaches the SAME next state an ordinary approve reaches', () => {
    const ruledAt3 = verdictToRouting('approve', 3, 'isolated-refactor', RULING).event;
    const ordinaryAt1 = verdictToRouting('approve', 1, 'isolated-refactor').event;
    expect(ruledAt3).toBe(ordinaryAt1);
    expect(transition('reviewing', ruledAt3, 'isolated-refactor')).toEqual(
      transition('reviewing', ordinaryAt1, 'isolated-refactor'),
    );
    expect(transition('reviewing', ruledAt3, 'isolated-refactor')).toEqual({
      type: 'transition',
      nextState: 'approved',
    });
  });

  it('a ruled changes-requested neither consumes nor resets the cap: it STOPs, it does not re-dispatch', () => {
    const event = verdictToRouting('changes-requested', 3, 'mechanical', RULING).event;
    // From the one state the cap-exhaustion STOP is reachable from — which is
    // the state a ruled changes-requested routes from, since the reviewer-phase
    // `--state` derivation is verdict-keyed and the ruling does not move it.
    expect(transition('re-dispatched', event)).toEqual({
      type: 'stop',
      reason: 're-dispatch-cap-exhausted',
      severity: 'error',
    });
    // The machine hands out no fresh round…
    expect(transition('re-dispatched', event)).not.toEqual({
      type: 'transition',
      nextState: 're-dispatched',
    });
  });

  it('a SECOND ruled round is still a ruling to be stated, never an entitlement the cap granted', () => {
    // The row stopped again at iteration 3. Iteration 4 is admitted by exactly
    // what iteration 3 was admitted by — another stated reason — and by nothing
    // the previous ruled round left behind.
    expect(() => verdictToRouting('approve', 4, 'mechanical')).toThrow(
      'verdictToEvent: iteration 4 is out of range. Expected an integer in [1, 2] (re-dispatch cap = 1).',
    );
    expect(verdictToRouting('approve', 4, 'mechanical', RULING).ruled).toEqual({
      cell: 'reviewer-approve-ruled',
      ruling: RULING,
    });
  });
});
