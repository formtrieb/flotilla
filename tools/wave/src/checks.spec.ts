import { describe, it, expect } from 'vitest';
import {
  runChecks,
  conflictMarkerCheck,
  acCoverageCheck,
  type CheckContext,
  type Check,
} from './checks';
import type { AcVerification } from './reviewer-verdict-schema';

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    changedFiles: ['src/a.ts'],
    readFile: () => 'clean content\n',
    acVerification: [],
    declaredAcCount: 0,
    ...over,
  };
}
const ac = (a: string, met: AcVerification['met']): AcVerification => ({ ac: a, met, evidence: 'e' });

describe('conflictMarkerCheck', () => {
  it('passes on clean files', () => {
    expect(conflictMarkerCheck.run(ctx()).ok).toBe(true);
  });
  it('fails on a leftover conflict marker, naming the file', () => {
    const r = conflictMarkerCheck.run(
      ctx({ changedFiles: ['src/a.ts'], readFile: () => 'x\n<<<<<<< HEAD\ny\n' }),
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('src/a.ts');
  });
  it('does NOT false-positive on a Markdown setext-H1 underline (=======)', () => {
    const r = conflictMarkerCheck.run(
      ctx({ changedFiles: ['README.md'], readFile: () => 'Title\n=======\n\nbody\n' }),
    );
    expect(r.ok).toBe(true);
  });
  it('ignores a deleted file (readFile throws)', () => {
    const r = conflictMarkerCheck.run(
      ctx({ changedFiles: ['gone.ts'], readFile: () => { throw new Error('ENOENT'); } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('acCoverageCheck (sources acVerification, not markdown — ADR-0004)', () => {
  it('passes when the reviewer verified every declared AC and none is not-met', () => {
    const r = acCoverageCheck.run(ctx({ declaredAcCount: 2, acVerification: [ac('#1', 'met'), ac('#2', 'met')] }));
    expect(r.ok).toBe(true);
  });
  it('fails when coverage is not 1:1', () => {
    const r = acCoverageCheck.run(ctx({ declaredAcCount: 3, acVerification: [ac('#1', 'met')] }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/1.*3|3.*1/);
  });
  it('fails when an AC is not-met', () => {
    const r = acCoverageCheck.run(ctx({ declaredAcCount: 2, acVerification: [ac('#1', 'met'), ac('#2', 'not-met')] }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('#2');
  });
});

describe('runChecks', () => {
  it('always runs the two floor checks', () => {
    const names = runChecks(ctx()).map((r) => r.name);
    expect(names).toEqual(['conflict-markers', 'ac-coverage']);
  });

  it('appends consumer checks and respects their appliesTo glob', () => {
    const phpCheck: Check = {
      name: 'php-only',
      appliesTo: ['**/*.php'],
      run: () => ({ name: 'php-only', ok: true, detail: 'ran' }),
    };
    const skipped = runChecks(ctx({ changedFiles: ['src/a.ts'] }), [phpCheck]).map((r) => r.name);
    expect(skipped).not.toContain('php-only'); // no .php changed → skipped

    const ran = runChecks(ctx({ changedFiles: ['site/x.php'] }), [phpCheck]).map((r) => r.name);
    expect(ran).toContain('php-only');
  });
});
