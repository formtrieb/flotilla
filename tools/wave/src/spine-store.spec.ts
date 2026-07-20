import { describe, it, expect } from 'vitest';
import { spineStoreFromSource } from './spine-store';

const SRC = `# Wave 2026-06-06 — test

**Status:** in-flight

## Plan-Table

| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |
| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |
| 01  | T 01  | background | mechanical | quick-verify | — | planned | 1 | — |

## PR-Log

| Created | ID | PR | Closes | Merged | Notes |
| ------- | -- | -- | ------ | ------ | ----- |
| — | — | — | — | — | _(none)_ |

## Resume-Metadata

\`\`\`yaml
dispatch-log:
  - "01 → agent a01 (sonnet)  branch wave-orch/01-thing"
\`\`\`
`;

describe('SpineStore — byte-preserving wrapper over wave-md-rw', () => {
  it('parses the spine and exposes rowState + branchesByIssueId', () => {
    const s = spineStoreFromSource(SRC);
    expect(s.rowState('01')).toBe('planned');
    expect(s.branchesByIssueId()['01']).toBe('wave-orch/01-thing');
  });

  it('setRowState mutates + re-parses; source() reflects it; other bytes preserved', () => {
    const s = spineStoreFromSource(SRC);
    s.setRowState('01', 'dispatched');
    expect(s.rowState('01')).toBe('dispatched');
    expect(s.source()).toMatch(/\| dispatched \|/);
    expect(s.source()).toContain('## Resume-Metadata'); // surrounding sections intact
  });

  it('a no-op stays byte-identical', () => {
    const s = spineStoreFromSource(SRC);
    const before = s.source();
    expect(before).toBe(SRC);
  });

  it('reload()/flush() throw without a disk-backed store', () => {
    const s = spineStoreFromSource(SRC);
    expect(() => s.reload()).toThrow();
    expect(() => s.flush()).toThrow();
  });

  it('upsertDispatchLogModel records the model without disturbing the branch (ADR-0012)', () => {
    const s = spineStoreFromSource(SRC);
    s.upsertDispatchLogModel('01', 'claude-opus-4-8');
    const entry = s.spine().dispatchLog.find((e) => e.id === '01');
    expect(entry?.model).toBe('claude-opus-4-8');
    expect(entry?.branch).toBe('wave-orch/01-thing');
    expect(s.branchesByIssueId()['01']).toBe('wave-orch/01-thing');
  });
});
