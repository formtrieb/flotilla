import { describe, it, expect } from 'vitest';
import { coarse } from './coarse-projection';
import { ISSUE_STATES, type IssueState } from './stop-condition-state-machine';

describe('coarse() — fine-state → claim rung projection', () => {
  it('is total over every engine fine state (a rung, or an explicit no-claim null)', () => {
    for (const s of ISSUE_STATES) {
      expect(['queued', 'in-flight', 'in-review', null]).toContain(coarse(s));
    }
  });

  // ADR-0022 §Decisions 3 — the projection becomes honest about "no claim".
  // `parked` is the ONLY state that holds no claim; the write path executes the
  // `null` as `unclaim()`. Mapping it to any rung (e.g. `queued`) would make
  // resume's ledger re-projection RE-CLAIM the issue on every resume and re-tell
  // exactly the lie the state exists to end.
  it('maps parked to null — the one no-claim state (ADR-0022)', () => {
    expect(coarse('parked')).toBeNull();
  });

  it('parked is the ONLY state that projects to no-claim', () => {
    const noClaim = ISSUE_STATES.filter((s) => coarse(s) === null);
    expect(noClaim).toEqual(['parked']);
  });

  it('maps the ledger points per CHARTER §6', () => {
    expect(coarse('planned')).toBe('queued');
    expect(coarse('dispatched')).toBe('in-flight');
    expect(coarse('approved')).toBe('in-review');
    expect(coarse('pr-created')).toBe('in-review');
  });

  it('collapses the mid-flight states to in-flight (lossy, ADR-0002)', () => {
    for (const s of ['report-in', 'reviewing', 'verdict-in', 're-dispatched'] as IssueState[]) {
      expect(coarse(s)).toBe('in-flight');
    }
  });

  it('keeps terminal-failure states on the in-flight claim (needs-attention is orthogonal)', () => {
    expect(coarse('failed')).toBe('in-flight');
    expect(coarse('abandoned')).toBe('in-flight');
  });

  // The boundary the ADR sharpens: `abandoned` = "never" (claim held until
  // dispositioned, alarm), `parked` = "later" (claim released, silent).
  it('separates the two terminal dispositions: abandoned holds the claim, parked releases it', () => {
    expect(coarse('abandoned')).toBe('in-flight');
    expect(coarse('parked')).toBeNull();
  });

  it('never yields a derived/orthogonal value (available/done/needs-attention)', () => {
    const yielded = new Set(ISSUE_STATES.map(coarse));
    for (const forbidden of ['available', 'done', 'needs-attention']) {
      expect(yielded.has(forbidden as never)).toBe(false);
    }
  });
});
