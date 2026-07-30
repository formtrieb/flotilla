import { describe, it, expect } from 'vitest';
import {
  readSidecars,
  parseSidecarName,
  bareIssueIdViolation,
  isBareIssueId,
  normalizeIssueRef,
  findMisnamedSidecars,
  type SidecarReader,
} from './sidecar';
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

  it('a DECORATED payload issue under a bare filename still reads (the reader is the tolerant half)', () => {
    // The write verb normalizes before rendering, so a verb-written sidecar never
    // takes this shape. A hand-written or pre-normalization record still must be
    // readable rather than silently reclassified as corrupt on a resume.
    const idx = readSidecars(
      'reports',
      'verdicts',
      memReader({ 'reports/118-1.md': fenced(report({ issue: '#118 — A decorated title' })) }),
    );
    expect(idx.reportFor('118')?.iter).toBe(1);
    expect(idx.corruptFor('118')).toHaveLength(0);
  });
});

// ─── the bare-id contract (issue #138) ───────────────────────────────────────

describe('bareIssueIdViolation / isBareIssueId — the sidecar id shape rule', () => {
  it('accepts the id shapes the shipped adapters actually produce', () => {
    for (const id of ['138', '08', 'FOR-90', 'TEAM-1234', 'a.b_c-7']) {
      expect(bareIssueIdViolation(id), id).toBeNull();
      expect(isBareIssueId(id), id).toBe(true);
    }
  });

  it('rejects the two decorated forms seen live — they are what make a sidecar unresolvable', () => {
    expect(bareIssueIdViolation('#126')).toMatch(/"#"/);
    expect(bareIssueIdViolation("#118 — A Worker's decorated issue field")).toBeTruthy();
    expect(isBareIssueId('#126')).toBe(false);
    expect(isBareIssueId('118 — a title')).toBe(false);
  });

  it('rejects an id that is empty, a path, or an unusable filename stem', () => {
    expect(bareIssueIdViolation('')).toMatch(/empty/);
    expect(bareIssueIdViolation('a/b')).toBeTruthy();
    expect(bareIssueIdViolation('a\\b')).toBeTruthy();
    expect(bareIssueIdViolation('..')).toMatch(/starts with/);
    expect(bareIssueIdViolation('.hidden')).toMatch(/starts with/);
  });

  it('a dashed id round-trips through the filename it produces (the Linear adapter case)', () => {
    expect(isBareIssueId('FOR-90')).toBe(true);
    expect(parseSidecarName('FOR-90-1.md')).toEqual({ id: 'FOR-90', iter: 1 });
  });
});

describe('normalizeIssueRef — strip the decoration, keep the id', () => {
  it.each([
    ['138', '138'], // already bare — identity
    ['#126', '126'],
    ["#118 — A Worker's decorated issue field", '118'],
    ['#118: a title after a colon', '118'],
    ['FOR-90 — a Linear row with a title', 'FOR-90'],
    ['  #7  ', '7'],
  ])('%j → %j', (raw, bare) => {
    expect(normalizeIssueRef(raw)).toBe(bare);
  });

  it('never invents an id it was not given (a different row stays a different row)', () => {
    expect(normalizeIssueRef('OTHER-99')).toBe('OTHER-99');
    expect(normalizeIssueRef('13')).toBe('13'); // NOT '138' — no prefix growth
  });
});

describe('findMisnamedSidecars — the file an existence probe cannot see', () => {
  it('finds a sidecar filed under a decorated id and names the row it belongs to', () => {
    const found = findMisnamedSidecars(
      'reports',
      'report',
      memReader({
        'reports/#126-1.md': fenced(report({ issue: '#126' })),
        'reports/118-1.md': fenced(report({ issue: '118' })), // correctly named — not litter
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      file: '#126-1.md',
      kind: 'report',
      filenameId: '#126',
      iter: 1,
      resolvesAs: '126',
    });
  });

  it('the misnamed file is present to an ls and absent to the reader — both halves asserted', () => {
    const files = { 'reports/#126-1.md': fenced(report({ issue: '#126' })) };
    const reader = memReader(files);
    // present: the directory listing shows it
    expect(reader.list('reports')).toEqual(['#126-1.md']);
    // absent: nothing resolves for the row the operator would ask about
    expect(readSidecars('reports', 'verdicts', reader).reportFor('126')).toBeNull();
    // …and THIS is the detector that closes the gap
    expect(findMisnamedSidecars('reports', 'report', reader)).toHaveLength(1);
  });

  it('a clean directory and an absent directory both yield nothing', () => {
    expect(
      findMisnamedSidecars('reports', 'report', memReader({ 'reports/FOR-90-2.md': 'x' })),
    ).toEqual([]);
    expect(findMisnamedSidecars('nope', 'report', memReader({}))).toEqual([]);
  });

  it('ignores files that are not sidecars at all rather than guessing at them', () => {
    expect(
      findMisnamedSidecars('reports', 'verdict', memReader({ 'reports/README.md': 'x' })),
    ).toEqual([]);
  });
});
