import { describe, it, expect } from 'vitest';
import {
  createHeaderParser,
  parseHeaderBlock,
  DEFAULT_WAVE_SCHEMA,
  RISK_VALUES,
  WORKER_VALUES,
} from './header-parser';
import { validateHeaderBlock, DEFAULT_TRIAGE_SCHEMA, type WaveSchema } from './contract';

/**
 * P1 keystone: the enum vocabulary lives in config, not the parser.
 * These specs pin the parameterization seam — the default-bound parser stays
 * byte-identical (the 600+ existing specs already guard that), and a custom
 * vocabulary is honored end-to-end.
 */

const validBody = (risk: string, worker: string) => `**Risk:** ${risk}
**Worker:** ${worker}
**Files:**
- some/file.ts
**Blocked by:** none

## What to build
`;

describe('createHeaderParser — custom vocabulary', () => {
  it('a default-bound parser matches parseHeaderBlock exactly', () => {
    const src = validBody('mechanical', 'background');
    expect(createHeaderParser().parse(src)).toEqual(parseHeaderBlock(src));
  });

  it('accepts a Worker value from a custom vocab that the default rejects', () => {
    const schema: WaveSchema = {
      riskValues: RISK_VALUES,
      workerValues: ['ready-for-neo', 'background'],
    };
    const src = validBody('mechanical', 'ready-for-neo');

    // default parser rejects the custom worker...
    const def = parseHeaderBlock(src);
    expect(def.ok).toBe(false);

    // ...but the custom-vocab parser accepts it.
    const custom = createHeaderParser(schema).parse(src);
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.header.worker).toBe('ready-for-neo');
  });

  it('a custom vocab that omits a default Worker now rejects it', () => {
    const schema: WaveSchema = {
      riskValues: RISK_VALUES,
      workerValues: ['background'], // trimmed (ADR-0007: Worker is trimmable)
    };
    const src = validBody('mechanical', 'HITL-required');
    const res = createHeaderParser(schema).parse(src);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.field === 'Worker')).toBe(true);
    }
  });

  it("DEFAULT_WAVE_SCHEMA mirrors the Ur's frozen sets", () => {
    expect(DEFAULT_WAVE_SCHEMA.riskValues).toEqual(RISK_VALUES);
    expect(DEFAULT_WAVE_SCHEMA.workerValues).toEqual(WORKER_VALUES);
  });
});

describe('validateHeaderBlock — schema-governed predicate', () => {
  it('passes when risk + worker are in the vocab', () => {
    const res = validateHeaderBlock(
      { risk: 'mechanical', worker: 'background' },
      DEFAULT_WAVE_SCHEMA,
    );
    expect(res).toEqual({ valid: true, errors: [] });
  });

  it('flags an out-of-vocab risk and worker, naming the allowed set', () => {
    const res = validateHeaderBlock(
      { risk: 'nonsense', worker: 'nobody' },
      DEFAULT_WAVE_SCHEMA,
    );
    expect(res.valid).toBe(false);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]).toContain('mechanical');
    expect(res.errors[1]).toContain('background');
  });

  it('honors a custom vocab', () => {
    const schema: WaveSchema = {
      riskValues: ['lo', 'hi'],
      workerValues: ['bot'],
    };
    expect(validateHeaderBlock({ risk: 'hi', worker: 'bot' }, schema).valid).toBe(
      true,
    );
    expect(
      validateHeaderBlock({ risk: 'mechanical', worker: 'bot' }, schema).valid,
    ).toBe(false);
  });
});

describe('DEFAULT_TRIAGE_SCHEMA (ADR-0015)', () => {
  it('ships the documented default vocabulary', () => {
    expect(DEFAULT_TRIAGE_SCHEMA.states).toEqual([
      'needs-triage',
      'needs-info',
      'ready-for-agent',
      'ready-for-human',
      'wontfix',
    ]);
    expect(DEFAULT_TRIAGE_SCHEMA.categories).toEqual(['bug', 'enhancement']);
  });

  it('entry / eligibility / unplanned states are all members of states', () => {
    const { states, entryState, eligibilityStates, unplannedState } = DEFAULT_TRIAGE_SCHEMA;
    expect(states).toContain(entryState);
    expect(states).toContain(unplannedState);
    for (const e of eligibilityStates) expect(states).toContain(e);
  });

  it('eligibility default is exactly ready-for-agent (ADR-0003 coherence)', () => {
    expect(DEFAULT_TRIAGE_SCHEMA.eligibilityStates).toEqual(['ready-for-agent']);
  });
});
