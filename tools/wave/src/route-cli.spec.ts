/**
 * Spec for route-cli — the thin top-level routers + the paired write verbs (P7.4 + FOR-6):
 *   route-verdict   verdictToEvent → transition
 *   route-outcome   outcomeToEvent → transition
 *   validate-report validateWorkerReport
 *   validate-verdict validateReviewerVerdict
 *   write-report    validateWorkerReport   → render <id>-<iter>.md sidecar (FOR-6)
 *   write-verdict   validateReviewerVerdict → render <id>-<iter>.md sidecar (FOR-6)
 *
 * The library functions are the single source of truth (their own specs prove
 * the logic). These tests prove only the routing/shape/exit-code contract, and —
 * for the write verbs — the writer→reader round-trip + the write→resume seam
 * (ADR-0024: the printer is paired with the sidecar.ts reader, the way renderSpine
 * is paired with readSpine).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRouteVerdict,
  runRouteOutcome,
  runValidateReport,
  runValidateVerdict,
  runWriteReport,
  runWriteVerdict,
} from './route-cli';
import { readSidecars, type SidecarReader } from './sidecar';
import { renderSpine, readSpine } from './wave-md-rw';
import { runSpine } from './spine-cli';
import { resume } from './resume';

function captureStdout(): { lines: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((c: string | Uint8Array) => {
      chunks.push(typeof c === 'string' ? c : c.toString());
      return true;
    });
  return { lines: () => chunks.join(''), restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

const tmp = () => mkdtempSync(join(tmpdir(), 'route-cli-'));

// ─── route-verdict ──────────────────────────────────────────────────────────

describe('route-verdict', () => {
  it('approve + cross-feature-refactor @ iter 1 → reviewer-approve / approved (exit 0)', () => {
    const out = captureStdout();
    const code = runRouteVerdict([
      '--verdict', 'approve',
      '--iteration', '1',
      '--risk', 'cross-feature-refactor',
      '--state', 'reviewing',
    ]);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'reviewer-approve',
      outcome: { type: 'transition', nextState: 'approved' },
    });
  });

  it('approve + public-API-change → STOP path (the G3 human gate) (exit 0)', () => {
    const out = captureStdout();
    const code = runRouteVerdict([
      '--verdict', 'approve',
      '--iteration', '1',
      '--risk', 'public-API-change',
      '--state', 'reviewing',
    ]);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'reviewer-approve-public-api',
      outcome: { type: 'stop', reason: 'public-api-approval-required', severity: 'blocking' },
    });
  });

  it('missing --verdict → usage (exit 2)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runRouteVerdict(['--iteration', '1', '--risk', 'mechanical', '--state', 'reviewing']);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it('out-of-enum --risk → exit 1 (library throws; router reports it)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runRouteVerdict([
      '--verdict', 'approve', '--iteration', '1', '--risk', 'bogus', '--state', 'reviewing',
    ]);
    err.mockRestore();
    expect(code).toBe(1);
  });
});

// ─── route-outcome ──────────────────────────────────────────────────────────

describe('route-outcome', () => {
  it('done @ dispatched → worker-done / report-in (exit 0)', () => {
    const out = captureStdout();
    const code = runRouteOutcome(['--outcome', 'done', '--state', 'dispatched']);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'worker-done',
      outcome: { type: 'transition', nextState: 'report-in' },
    });
  });

  it('blocked @ dispatched → worker-failed-after-retry / STOP (exit 0)', () => {
    const out = captureStdout();
    const code = runRouteOutcome(['--outcome', 'blocked', '--state', 'dispatched']);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'worker-failed-after-retry',
      outcome: { type: 'stop', reason: 'worker-failed', severity: 'error' },
    });
  });

  it('out-of-enum --outcome → exit 1', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runRouteOutcome(['--outcome', 'nope', '--state', 'dispatched']);
    err.mockRestore();
    expect(code).toBe(1);
  });
});

// ─── validate-report / validate-verdict ──────────────────────────────────────

describe('validate-report', () => {
  const validReport = {
    outcome: 'done', issue: '1-x', branch: 'w/1-x', commitShas: ['abc1234'],
    filesChanged: { new: 1, modified: 0, renamed: 0 },
    tests: '20/20 green', lint: 'clean', judgmentCalls: [], reviewerFocusItems: [],
  };

  it('a well-formed report → exit 0 + "valid"', () => {
    const dir = tmp();
    const f = join(dir, 'report.json');
    writeFileSync(f, JSON.stringify(validReport));
    const out = captureStdout();
    const code = runValidateReport([f]);
    out.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.lines()).toMatch(/valid/);
  });

  it('a malformed report → exit 1 + errors', () => {
    const dir = tmp();
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...validReport, outcome: 'shipped' }));
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runValidateReport([f]);
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(1);
  });

  it('no file arg → usage (exit 2)', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runValidateReport([]);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it('unreadable file → exit 2', () => {
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runValidateReport(['/nonexistent/nope.json']);
    err.mockRestore();
    expect(code).toBe(2);
  });
});

describe('validate-verdict', () => {
  const validVerdict = {
    verdict: 'approve', branchReviewed: 'w/1-x', riskClass: 'mechanical',
    workerReportDigest: '20/20 green', acVerification: [],
    reviewerFocusItems: [],
  };

  it('a well-formed verdict → exit 0 + "valid"', () => {
    const dir = tmp();
    const f = join(dir, 'verdict.json');
    writeFileSync(f, JSON.stringify(validVerdict));
    const out = captureStdout();
    const code = runValidateVerdict([f]);
    out.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(out.lines()).toMatch(/valid/);
  });

  it('a verdict missing riskClass (the G3 guard) → exit 1', () => {
    const dir = tmp();
    const f = join(dir, 'bad.json');
    const { riskClass: _omit, ...noRisk } = validVerdict;
    writeFileSync(f, JSON.stringify(noRisk));
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const code = runValidateVerdict([f]);
    err.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(1);
  });
});

// ─── write-report / write-verdict (FOR-6) ────────────────────────────────────
//
// The write verbs render the exact fenced-json sidecar the sidecar.ts reader
// accepts (the printer paired with the parser, ADR-0024). Every test rounds the
// written file back through `readSidecars` — the real reader — so a rename or a
// body-format drift fails loud here, not silently as "corrupt" at resume.

/** The real fs SidecarReader (mirrors resume-cli's defaultSidecarReader). */
const fsReader: SidecarReader = {
  list: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
  read: (d, file) => readFileSync(join(d, file), 'utf-8'),
};

const silenceStderr = () =>
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

const writtenReport = {
  outcome: 'done',
  issue: 'FOR-6',
  branch: 'wave/FOR-6-scribe',
  commitShas: ['abc1234'],
  filesChanged: { new: 1, modified: 0, renamed: 0 },
  tests: '20/20 green',
  lint: 'clean',
  judgmentCalls: [],
  reviewerFocusItems: [],
};

const writtenVerdict = {
  verdict: 'approve',
  branchReviewed: 'wave/FOR-6-scribe',
  riskClass: 'mechanical',
  workerReportDigest: '20/20 green',
  acVerification: [],
  reviewerFocusItems: [],
};

describe('write-report', () => {
  it('writes <id>-<iter>.md the reader accepts — a dashed id FOR-6 round-trips', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports'); // absent → verb must mkdir -p
    const f = join(dir, 'payload.json');
    writeFileSync(f, JSON.stringify(writtenReport));
    const out = captureStdout();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1']);
    out.restore();
    expect(code).toBe(0);
    // absolute path of the engine-computed filename on stdout — caller cannot misname it
    expect(out.lines().trim()).toBe(join(reportsDir, 'FOR-6-1.md'));
    // the REAL reader adopts it: dashed id split correctly, body parsed
    const idx = readSidecars(reportsDir, join(dir, 'verdicts'), fsReader);
    expect(idx.reportFor('FOR-6')?.iter).toBe(1);
    expect(idx.reportFor('FOR-6')?.report.tests).toBe('20/20 green');
    expect(idx.corruptFor('FOR-6')).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an invalid payload → exit 1 and NOTHING written', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, outcome: 'shipped' }));
    const err = silenceStderr();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(1);
    // "never write a malformed sidecar" — the reader sees nothing
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('report.issue disagreeing with --id (reader prefix rule) → exit 1, nothing written', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: 'OTHER-99' }));
    const err = silenceStderr();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(1); // fail loud at write time, not "corrupt" at resume
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('overwrite at the same iter — last writer wins (w2 bad-anchor re-round)', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f1 = join(dir, 'p1.json');
    const f2 = join(dir, 'p2.json');
    writeFileSync(f1, JSON.stringify(writtenReport));
    writeFileSync(f2, JSON.stringify({ ...writtenReport, tests: '99/99 green' }));
    const out = captureStdout();
    expect(runWriteReport([f1, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    expect(runWriteReport([f2, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    out.restore();
    expect(readdirSync(reportsDir)).toEqual(['FOR-6-1.md']); // one file, not two
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')?.report.tests).toBe(
      '99/99 green',
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('mkdir -p on an absent NESTED target dir', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'deep', 'nested', 'reports'); // parents absent
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(writtenReport));
    const out = captureStdout();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '2']);
    out.restore();
    expect(code).toBe(0);
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')?.iter).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('missing --dir → usage (exit 2)', () => {
    const err = silenceStderr();
    const code = runWriteReport(['/some/file.json', '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it('a non-integer --iter → usage (exit 2)', () => {
    const err = silenceStderr();
    const code = runWriteReport(['/some/file.json', '--dir', '/x', '--id', 'FOR-6', '--iter', 'two']);
    err.mockRestore();
    expect(code).toBe(2);
  });

  it('unreadable / unparseable json-file → exit 2', () => {
    const err = silenceStderr();
    const code = runWriteReport(['/nonexistent/nope.json', '--dir', '/x', '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(2);
  });
});

describe('write-verdict', () => {
  it('writes a verdict the reader accepts (no issue cross-check on the verdict path)', () => {
    const dir = tmp();
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'v.json');
    writeFileSync(f, JSON.stringify(writtenVerdict));
    const out = captureStdout();
    const code = runWriteVerdict([f, '--dir', verdictsDir, '--id', 'FOR-6', '--iter', '1']);
    out.restore();
    expect(code).toBe(0);
    expect(out.lines().trim()).toBe(join(verdictsDir, 'FOR-6-1.md'));
    const idx = readSidecars(join(dir, 'reports'), verdictsDir, fsReader);
    expect(idx.verdictFor('FOR-6')?.iter).toBe(1);
    expect(idx.verdictFor('FOR-6')?.verdict.verdict).toBe('approve');
    rmSync(dir, { recursive: true, force: true });
  });

  it('an invalid verdict (missing riskClass) → exit 1, nothing written', () => {
    const dir = tmp();
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'bad.json');
    const { riskClass: _omit, ...noRisk } = writtenVerdict;
    writeFileSync(f, JSON.stringify(noRisk));
    const err = silenceStderr();
    const code = runWriteVerdict([f, '--dir', verdictsDir, '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(1);
    expect(readSidecars(join(dir, 'reports'), verdictsDir, fsReader).verdictFor('FOR-6')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── write → resume seam (FOR-6 AC-3) ────────────────────────────────────────
//
// The whole point of FOR-6: a sidecar produced ONLY through the write verb — no
// Coordinator-side hand-write — must be what resume() reconstructs from. This
// crosses the real wire (render spine → dispatch WAL → write-report → readSidecars
// → resume). Negative control: the identical world WITHOUT the verb-written report
// redispatches, proving the verb-written sidecar is what flips redispatch → adopt.
describe('write verbs → resume seam (AC-3)', () => {
  it('resume ADOPTS a row whose report exists only via write-report; REDISPATCHES without it', () => {
    const meta = {
      slug: 'demo',
      description: 'scribe seam',
      coordinator: 'at',
      model: 'Opus 4.8',
      created: '2026-07-19',
      lastUpdated: '2026-07-19 10:00 CEST',
    };
    const roster = [{ id: 'FOR-6', title: 'Scribe sidecars', worker: 'background', risk: 'mechanical' }];
    const conflict = { issues: ['FOR-6'], cells: [] };

    const dir = mkdtempSync(join(tmpdir(), 'scribe-seam-'));
    const spinePath = join(dir, 'WAVE.md');
    writeFileSync(spinePath, renderSpine(meta, roster, conflict, 'ok.'), 'utf-8');
    // wave-start's dispatch WAL puts the row in a running, pre-landing state.
    expect(runSpine(['set-row-state', spinePath, 'FOR-6', 'dispatched'])).toBe(0);

    const reportsDir = join(dir, 'reports'); // by-convention sidecar dirs
    const verdictsDir = join(dir, 'verdicts');
    const readWorld = () =>
      resume({
        spine: readSpine(readFileSync(spinePath, 'utf-8')),
        worktrees: [], // no adoptable worktree — the sidecar alone must drive the decision
        sidecars: readSidecars(reportsDir, verdictsDir, fsReader),
      });

    // Negative control: nothing on disk, no worktree → redispatch.
    expect(readWorld().rows.find((r) => r.id === 'FOR-6')!.decision).toBe('redispatch');

    // Produce the report ONLY through the write verb (zero Coordinator hand-writes).
    const payload = join(dir, 'payload.json');
    writeFileSync(payload, JSON.stringify(writtenReport));
    const out = captureStdout();
    expect(runWriteReport([payload, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    out.restore();

    const row = readWorld().rows.find((r) => r.id === 'FOR-6')!;
    expect(row.decision).toBe('adopt'); // durable report on disk → resume in place, never redispatch
    expect(row.latestReport?.tests).toBe('20/20 green');
    rmSync(dir, { recursive: true, force: true });
  });
});
