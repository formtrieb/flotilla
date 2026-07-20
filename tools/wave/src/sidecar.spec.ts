import { describe, it, expect } from 'vitest';
import { readSidecars, parseSidecarName, type SidecarReader } from './sidecar';
import type { WorkerReport } from './worker-report-schema';
import type { ReviewerVerdict } from './reviewer-verdict-schema';

function report(over: Partial<WorkerReport> = {}): WorkerReport {
  return {
    outcome: 'done',
    issue: '08',
    branch: 'wave-orch/08-thing',
    commitShas: ['abc1234'],
    filesChanged: { new: 0, modified: 1, renamed: 0 },
    tests: '5/5 green',
    lint: '0 affected',
    judgmentCalls: [],
    reviewerFocusItems: [],
    ...over,
  };
}
function verdict(over: Partial<ReviewerVerdict> = {}): ReviewerVerdict {
  return {
    verdict: 'approve',
    branchReviewed: 'wave-orch/08-thing',
    riskClass: 'mechanical',
    workerReportDigest: 'ok',
    acVerification: [],
    reviewerFocusItems: [],
    lintTestSummary: '1/1 green',
    gitStateSane: true,
    ...over,
  };
}
const fenced = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```\n';

/** In-memory reader from a { 'dir/file': contents } map. */
function memReader(files: Record<string, string>): SidecarReader {
  return {
    list: (dir) =>
      Object.keys(files)
        .filter((k) => k.startsWith(dir + '/'))
        .map((k) => k.slice(dir.length + 1)),
    read: (dir, file) => files[`${dir}/${file}`],
  };
}

describe('parseSidecarName — opaque id + trailing iter', () => {
  it('splits on the LAST -<iter> (id may contain hyphens and #NN)', () => {
    expect(parseSidecarName('08-1.md')).toEqual({ id: '08', iter: 1 });
    expect(parseSidecarName('wave-tools-cleanup#08-3.md')).toEqual({
      id: 'wave-tools-cleanup#08',
      iter: 3,
    });
    expect(parseSidecarName('not-a-sidecar.txt')).toBeNull();
  });
});

describe('readSidecars', () => {
  it('returns the MAX-iter valid report + verdict per id', () => {
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({
        'reports/08-1.md': fenced(report()),
        'reports/08-2.md': fenced(report({ tests: '6/6 green' })),
        'verdicts/08-1.md': fenced(verdict()),
      }),
    );
    expect(idx.reportFor('08')?.iter).toBe(2);
    expect(idx.reportFor('08')?.report.tests).toBe('6/6 green');
    expect(idx.verdictFor('08')?.iter).toBe(1);
    expect(idx.reportFor('99')).toBeNull();
  });

  it('tracks report.iter and verdict.iter separately (fresh report, stale verdict)', () => {
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({
        'reports/08-2.md': fenced(report()),
        'verdicts/08-1.md': fenced(verdict()),
      }),
    );
    expect(idx.reportFor('08')?.iter).toBe(2);
    expect(idx.verdictFor('08')?.iter).toBe(1); // not collapsed into one max
  });

  it('records a schema-invalid sidecar as corrupt and treats it as absent', () => {
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({
        'reports/08-1.md': fenced({ outcome: 'nonsense' }), // fails the schema
      }),
    );
    expect(idx.reportFor('08')).toBeNull();
    expect(idx.corruptFor('08')).toHaveLength(1);
    expect(idx.corruptFor('08')[0].kind).toBe('report');
  });

  it('records unparseable JSON as corrupt', () => {
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({ 'reports/08-1.md': '```json\n{ not json\n```\n' }),
    );
    expect(idx.corruptFor('08')).toHaveLength(1);
  });

  it('flags a filename id that disagrees with the payload issue', () => {
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({ 'reports/99-1.md': fenced(report({ issue: '08' })) }),
    );
    expect(idx.reportFor('99')).toBeNull();
    expect(idx.corruptFor('99')[0].reason).toMatch(/disagrees/);
  });

  it('handles an absent dir (empty listing) without throwing', () => {
    const idx = readSidecars('reports', 'verdicts', memReader({}));
    expect(idx.reportFor('08')).toBeNull();
    expect(idx.verdictFor('08')).toBeNull();
  });
});
