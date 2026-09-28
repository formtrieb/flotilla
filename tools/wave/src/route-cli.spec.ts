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
  mkdirSync,
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
  renderSidecarBody,
} from './route-cli';
import { canonicalDigest } from './canonical-json';
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

// ─── route-verdict --ruling: the Operator-ruled round (issue #684) ───────────
//
// The verb half of the adapter's ruled cell. The adapter's own spec owns the
// mapping; what is asserted here is the CLI contract a Coordinator actually sees
// — which exit code, which JSON, and (the one that matters) that the refusal a
// missing ruling produces is the pre-existing one, verbatim, prefixed only by
// the router's own `error: route-verdict: `.

/** The stated reason, shaped like the ones the two live occurrences produced. */
const RULING =
  'Operator ruling 03:50 — the throwaway repository was deleted; re-dispatch the Reviewer only.';

describe('route-verdict --ruling (the Operator-ruled round)', () => {
  it('an above-cap approve WITH a ruling routes, and the printed result quotes the ruling', () => {
    const out = captureStdout();
    const code = runRouteVerdict([
      '--verdict', 'approve',
      '--iteration', '3',
      '--risk', 'mechanical',
      '--state', 'reviewing',
      '--ruling', RULING,
    ]);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'reviewer-approve',
      outcome: { type: 'transition', nextState: 'approved' },
      ruled: { cell: 'reviewer-approve-ruled', ruling: RULING },
    });
  });

  it('the ruled approve reaches the same next state an ordinary approve reaches — cap accounting untouched', () => {
    const ruled = captureStdout();
    runRouteVerdict([
      '--verdict', 'approve', '--iteration', '3', '--risk', 'mechanical',
      '--state', 'reviewing', '--ruling', RULING,
    ]);
    ruled.restore();
    const ordinary = captureStdout();
    runRouteVerdict([
      '--verdict', 'approve', '--iteration', '1', '--risk', 'mechanical', '--state', 'reviewing',
    ]);
    ordinary.restore();
    expect(JSON.parse(ruled.lines()).outcome).toEqual(JSON.parse(ordinary.lines()).outcome);
  });

  it('a ruled changes-requested lands on the cap-exhaustion STOP — it buys the row no further round', () => {
    const out = captureStdout();
    const code = runRouteVerdict([
      '--verdict', 'changes-requested',
      '--iteration', '3',
      '--risk', 'isolated-refactor',
      // The reviewer-phase state is verdict-keyed; a changes-requested routes
      // from `re-dispatched` whatever its iteration, ruled or not.
      '--state', 're-dispatched',
      '--ruling', RULING,
    ]);
    out.restore();
    expect(code).toBe(0);
    expect(JSON.parse(out.lines())).toEqual({
      event: 'reviewer-changes-requested-2nd',
      outcome: { type: 'stop', reason: 're-dispatch-cap-exhausted', severity: 'error' },
      ruled: { cell: 'reviewer-changes-requested-ruled', ruling: RULING },
    });
  });

  it('WITHOUT a ruling, iteration 3 stays refused with the pre-existing message, byte for byte', () => {
    let stderr = '';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
    const code = runRouteVerdict([
      '--verdict', 'approve', '--iteration', '3', '--risk', 'mechanical', '--state', 'reviewing',
    ]);
    err.mockRestore();
    expect(code).toBe(1);
    expect(stderr).toBe(
      'error: route-verdict: verdictToEvent: iteration 3 is out of range. ' +
        'Expected an integer in [1, 2] (re-dispatch cap = 1).\n',
    );
  });

  it('a bare token is not a ruling — the round is refused, and the refusal says why', () => {
    let stderr = '';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
    const code = runRouteVerdict([
      '--verdict', 'approve', '--iteration', '3', '--risk', 'mechanical',
      '--state', 'reviewing', '--ruling', 'true',
    ]);
    err.mockRestore();
    expect(code).toBe(1);
    expect(stderr).toMatch(/A ruled round is auditable only if it states WHY it exists/);
  });

  it('a --ruling with no value is a USAGE error, not a message about the iteration', () => {
    let stderr = '';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
      stderr += String(c);
      return true;
    });
    const code = runRouteVerdict([
      '--verdict', 'approve', '--iteration', '3', '--risk', 'mechanical',
      '--state', 'reviewing', '--ruling',
    ]);
    err.mockRestore();
    expect(code).toBe(2);
    expect(stderr).toMatch(/--ruling takes the Operator's reason as its value/);
    expect(stderr).not.toMatch(/out of range/);
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

/**
 * A well-formed FINISHING report. It carries `prUrl` deliberately: `outcome:
 * done` without one is the shape the issue-#556 gate reports on, so a fixture
 * missing it would make every unrelated test in this file emit that notice and
 * quietly turn the gate's own assertions into background noise.
 */
const writtenReport = {
  outcome: 'done',
  issue: 'FOR-6',
  branch: 'wave/FOR-6-scribe',
  commitShas: ['abc1234'],
  prUrl: 'https://github.com/example/repo/pull/6',
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

  it('report.issue naming a DIFFERENT row than --id → exit 1, nothing written', () => {
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

  it('a report.issue that is a mere string PREFIX of --id is refused (tighter than the old rule)', () => {
    // "138".startsWith("13") — the old prefix rule accepted a wrong report by
    // accident of string shape. Normalization does not grow an id, so it refuses.
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: '13' }));
    const err = silenceStderr();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', '138', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(1);
    expect(fsReader.list(reportsDir)).toEqual([]); // nothing written at all
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

// ─── the bare-id contract at the write boundary (issue #138) ─────────────────
//
// Three shapes, all three observed live in `2026-07-27-consumer-gaps`, driven
// through the real verb and rounded back through the real reader. What each row
// asserts is not "the verb returned 0" but the two things the founding incident
// actually got wrong: WHAT LANDS ON DISK, and WHETHER THE READER RESOLVES IT.

describe('write-report — the bare-id contract (issue #138)', () => {
  const ROW_ID = '126';

  /** Run write-report for one payload shape and report what the world looks like after. */
  function write(issueField: string, idFlag = ROW_ID) {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: issueField }));
    const out = captureStdout();
    const err = silenceStderr();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', idFlag, '--iter', '1']);
    err.mockRestore();
    out.restore();
    const idx = readSidecars(reportsDir, verdictsDir, fsReader);
    return {
      code,
      stdout: out.lines().trim(),
      onDisk: fsReader.list(reportsDir).sort(),
      resolvedByRow: idx.reportFor(ROW_ID),
      corruptForRow: idx.corruptFor(ROW_ID),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
      reportsDir,
    };
  }

  it.each([
    ['the correct bare id', '126'],
    ['a bare-hash id', '#126'],
    ['a hash-and-title string', "#126 — A Worker's decorated issue field makes its own record unwritable"],
  ])('%s as report.issue → 126-1.md on disk, resolved by the reader for row 126', (_label, issueField) => {
    const w = write(issueField);
    expect(w.code).toBe(0);
    // WHAT LANDS: the engine-computed name, keyed on the row id — never the payload's string
    expect(w.onDisk).toEqual(['126-1.md']);
    expect(w.stdout).toBe(join(w.reportsDir, '126-1.md'));
    // WHETHER IT RESOLVES: the row the operator will ask about on resume
    expect(w.resolvedByRow?.iter).toBe(1);
    expect(w.resolvedByRow?.report.tests).toBe('20/20 green');
    expect(w.corruptForRow).toHaveLength(0);
    // …and the persisted field itself is the bare id, so the record stays resolvable
    // if it is ever re-read, re-written, or copied by something less forgiving.
    expect(w.resolvedByRow?.report.issue).toBe('126');
    w.cleanup();
  });

  it('the decorated shapes are REPAIRED, not merely tolerated — the written payload is normalized', () => {
    const w = write('#126');
    const raw = readFileSync(join(w.reportsDir, '126-1.md'), 'utf-8');
    expect(raw).toContain('"issue": "126"');
    expect(raw).not.toContain('"#126"');
    w.cleanup();
  });

  it('a decorated --id is REFUSED (exit 2, nothing written) — the Scribe cannot route around the rule by varying it', () => {
    // The founding incident: the verb refused the payload, so the caller varied
    // the one argument it controlled and got `#126-1.md` — a file `ls` shows and
    // `reportFor('126')` can never return. Varying --id is now the refusal.
    for (const badId of ['#126', "#126 — a title", '126 with a space', 'a/b']) {
      const w = write('#126', badId);
      expect(w.code, badId).toBe(2);
      expect(w.onDisk, badId).toEqual([]); // NOTHING written under any name
      expect(w.resolvedByRow, badId).toBeNull();
      w.cleanup();
    }
  });

  it('the refusal is louder than the payload refusal it replaces — it names --id as not the callers to vary', () => {
    const dir = tmp();
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: '#126' }));
    const chunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const code = runWriteReport([f, '--dir', join(dir, 'reports'), '--id', '#126', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(2);
    const msg = chunks.join('');
    expect(msg).toMatch(/COMPOSE-TIME ROW ID/);
    expect(msg).toMatch(/nothing written/);
    expect(msg).toMatch(/#126-1\.md/); // names the exact file it refused to create
    rmSync(dir, { recursive: true, force: true });
  });

  it('a normalized write says so on stderr — a repair is reported, never silent', () => {
    const dir = tmp();
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: '#126 — a title' }));
    const chunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    expect(runWriteReport([f, '--dir', join(dir, 'reports'), '--id', '126', '--iter', '1'])).toBe(0);
    out.restore();
    err.mockRestore();
    expect(chunks.join('')).toMatch(/notice: write-report: report\.issue .* DECORATED/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('write verbs — the routing-time recovery now catches a MISNAMED sidecar, not only a missing one', () => {
  /**
   * The Coordinator's recovery probe is `[ -f <dir>/<id>-<iter>.md ]`, which a
   * misnamed file fails identically to a missing one — so the recovery fires and
   * the recovery IS this verb. Before the fix it rewrote the correct file and
   * left the misnamed one behind, undetected. Now the same invocation reports it.
   */
  function withLitter(run: (dir: string, reportsDir: string) => string) {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    // The exact litter shape from the incident: a real, well-formed sidecar filed
    // under a decorated id. It is present to an `ls`…
    writeFileSync(
      join(reportsDir, '#126-1.md'),
      '# WorkerReport #126 iter 1\n\n```json\n' +
        JSON.stringify({ ...writtenReport, issue: '#126' }, null, 2) +
        '\n```\n',
      'utf-8',
    );
    expect(readdirSync(reportsDir)).toContain('#126-1.md');
    // …and absent to the reader, for the row anyone would actually ask about.
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('126')).toBeNull();
    const stderr = run(dir, reportsDir);
    rmSync(dir, { recursive: true, force: true });
    return stderr;
  }

  it('the recovery write reports the misnamed leftover by path and by the row it belongs to', () => {
    const msg = withLitter((dir, reportsDir) => {
      const f = join(dir, 'p.json');
      writeFileSync(f, JSON.stringify({ ...writtenReport, issue: '126' }));
      const chunks: string[] = [];
      const err = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((c: string | Uint8Array) => {
          chunks.push(typeof c === 'string' ? c : c.toString());
          return true;
        });
      const out = captureStdout();
      expect(runWriteReport([f, '--dir', reportsDir, '--id', '126', '--iter', '1'])).toBe(0);
      out.restore();
      err.mockRestore();
      // the correct record now exists AND resolves
      expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('126')?.iter).toBe(1);
      return chunks.join('');
    });
    expect(msg).toMatch(/MISNAMED SIDECAR/);
    expect(msg).toMatch(/#126-1\.md/);
    expect(msg).toMatch(/"126-1\.md"/); // names where the record belongs
  });

  // ── the EXACT text, byte for byte (issue #724) ────────────────────────────
  //
  // Every assertion above this one is a `toMatch` on a fragment, which is why
  // the six-line warning could be copied verbatim into `route-tuple.ts` and then
  // drift there — a regex on "MISNAMED SIDECAR" is green for a sentence that has
  // lost half its remedy. This one pins the WHOLE string, so the shared renderer
  // (`renderMisnamedSidecarWarning`, route-cli.ts) that both sweeps now call
  // cannot change what either of them says without a spec going red. Its twin
  // lives in route-tuple.spec.ts under the other label; the two literals are
  // identical apart from that label, which is the property the shared renderer
  // exists to keep true.
  //
  // Deliberately written as a LITERAL rather than assembled from the same
  // helpers the implementation uses: an expectation built by calling the code
  // under test asserts nothing.
  it('renders the whole warning EXACTLY — the pin the shared renderer must not move (issue #724)', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, '#126-1.md'),
      '# WorkerReport #126 iter 1\n\n```json\n' +
        JSON.stringify({ ...writtenReport, issue: '#126' }, null, 2) +
        '\n```\n',
      'utf-8',
    );
    const payload = join(dir, 'p.json');
    writeFileSync(payload, JSON.stringify({ ...writtenReport, issue: '126' }));
    const chunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    expect(runWriteReport([payload, '--dir', reportsDir, '--id', '126', '--iter', '1'])).toBe(0);
    out.restore();
    err.mockRestore();

    // The litter path is the one part that cannot be a literal — it lives in a
    // fresh mkdtemp dir — so it is spelled the way the renderer spells it.
    const litter = JSON.stringify(join(reportsDir, '#126-1.md'));
    const expected =
      `warning: write-report: MISNAMED SIDECAR ${litter} — its\n` +
      '  filename id "#126" contains "#" — an id must be filename-safe AND literally matchable, so it carries no whitespace, no "#", and no path character, so the reader resolves it for NO row\n' +
      '  (it holds the record for "126", which would be filed as\n' +
      '  "126-1.md"). A file like this is present to an `ls` and\n' +
      '  absent to resume, and an existence probe cannot tell it from a missing one.\n' +
      '  Confirm the correctly-named record holds the same content, then delete it.\n';
    expect(chunks.filter((c) => c.startsWith('warning:'))).toEqual([expected]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a clean reports dir produces no misnamed warning (the check is silent when there is nothing to say)', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, issue: '126' }));
    const chunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        chunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    expect(runWriteReport([f, '--dir', reportsDir, '--id', '126', '--iter', '1'])).toBe(0);
    out.restore();
    err.mockRestore();
    expect(chunks.join('')).not.toMatch(/MISNAMED/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-verdict enforces the same bare-id rule — a verdict has no payload id to fall back on', () => {
    const dir = tmp();
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'v.json');
    writeFileSync(f, JSON.stringify(writtenVerdict));
    const err = silenceStderr();
    const code = runWriteVerdict([f, '--dir', verdictsDir, '--id', '#126', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(2);
    expect(fsReader.list(verdictsDir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── the finishing-outcome prUrl gate (issue #556) ───────────────────────────
//
// The invariant "a finishing outcome implies a usable prUrl" lives in the
// canonical schema as a top-level `anyOf` that the agent boundary strips off
// the shipped copy, so on the live path it was brief-enforced only — and prose
// did not converge (three occurrences across waves, strengthened in between).
// It now ALSO sits here, at the moment the report becomes durable.
//
// What these tests hold, and the order matters: the sidecar IS WRITTEN, exit is
// 0, and the notice rides stderr. A refusal would cost a finished row its
// durable record — the exact damage the Scribe stage exists to prevent — so
// "notice, never refusal" is asserted on every row below, not just claimed.

describe('write-report — a finishing outcome with no usable prUrl is a NOTICE, never a refusal (issue #556)', () => {
  /** Drive the real verb over one payload and report everything observable. */
  function write(payload: Record<string, unknown>) {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(payload));
    const errChunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errChunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1']);
    out.restore();
    err.mockRestore();
    const idx = readSidecars(reportsDir, join(dir, 'verdicts'), fsReader);
    return {
      code,
      stdout: out.lines().trim(),
      stderr: errChunks.join(''),
      onDisk: fsReader.list(reportsDir).sort(),
      resolved: idx.reportFor('FOR-6'),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
      reportsDir,
    };
  }

  const { prUrl: _dropped, ...reportWithoutPrUrl } = writtenReport;

  it.each([
    ['prUrl ABSENT', reportWithoutPrUrl],
    ['prUrl EMPTY STRING (the #303 shape)', { ...writtenReport, prUrl: '' }],
    ['prUrl WHITESPACE-ONLY', { ...writtenReport, prUrl: '  ' }],
    ['outcome done-with-concerns, prUrl absent', { ...reportWithoutPrUrl, outcome: 'done-with-concerns' }],
  ])('%s → exit 0, the sidecar LANDS and RESOLVES, and stderr carries the notice', (_label, payload) => {
    const w = write(payload as Record<string, unknown>);
    // ── half one: the record exists. This is the half a refusal would destroy.
    expect(w.code).toBe(0);
    expect(w.onDisk).toEqual(['FOR-6-1.md']);
    expect(w.stdout).toBe(join(w.reportsDir, 'FOR-6-1.md'));
    expect(w.resolved?.report.tests).toBe('20/20 green');
    // ── half two: the omission is loud.
    expect(w.stderr).toMatch(/^notice: write-report: /m);
    expect(w.stderr).toMatch(/prUrl/);
    w.cleanup();
  });

  it('the notice distinguishes ABSENT from present-but-unusable, so the reader knows which shape shipped', () => {
    const absent = write(reportWithoutPrUrl as Record<string, unknown>);
    expect(absent.stderr).toMatch(/prUrl is ABSENT/);
    absent.cleanup();

    const empty = write({ ...writtenReport, prUrl: '' });
    expect(empty.stderr).toMatch(/prUrl is "" — present but not a usable URL/);
    empty.cleanup();
  });

  it('the notice names the recovery — the host re-query, never a hand-typed URL', () => {
    const w = write(reportWithoutPrUrl as Record<string, unknown>);
    expect(w.stderr).toMatch(/host-pr status --branch/);
    expect(w.stderr).toMatch(/do not hand-type one/);
    w.cleanup();
  });

  it('the notice names the outcome that triggered it', () => {
    const w = write({ ...reportWithoutPrUrl, outcome: 'done-with-concerns' } as Record<string, unknown>);
    expect(w.stderr).toMatch(/"done-with-concerns"/);
    w.cleanup();
  });

  it('SILENT when the finishing report carries a real URL (the check is quiet with nothing to say)', () => {
    const w = write(writtenReport);
    expect(w.code).toBe(0);
    expect(w.stderr).not.toMatch(/prUrl/);
    w.cleanup();
  });

  it.each(['needs-context', 'blocked'])(
    'SILENT on a %s report with no prUrl — a row that did not finish has no PR to name',
    (outcome) => {
      const w = write({ ...reportWithoutPrUrl, outcome } as Record<string, unknown>);
      expect(w.code).toBe(0);
      expect(w.onDisk).toEqual(['FOR-6-1.md']);
      expect(w.stderr).not.toMatch(/prUrl/);
      w.cleanup();
    },
  );

  it('the notice is emitted only on a run that ACTUALLY wrote — an unwritable dir exits 2 with no notice', () => {
    // The Scribe reports `notice` on an exit-0 run only, so a notice printed
    // beside a failed write would be reported through the wrong field. The hook
    // runs after writeFileSync, which makes that impossible by construction
    // rather than by the Scribe's good manners.
    const dir = tmp();
    const collide = join(dir, 'not-a-dir');
    writeFileSync(collide, 'i am a file, not a directory');
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(reportWithoutPrUrl));
    const errChunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errChunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const code = runWriteReport([f, '--dir', collide, '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(2);
    expect(errChunks.join('')).not.toMatch(/^notice: write-report: outcome/m);
    rmSync(dir, { recursive: true, force: true });
  });

  it('an INVALID payload is still refused outright — the gate did not soften validation', () => {
    // The gate is about a valid report missing a field, never about accepting
    // a malformed one. A malformed payload writes nothing, exit 1, as before.
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...reportWithoutPrUrl, outcome: 'shipped' }));
    const err = silenceStderr();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1']);
    err.mockRestore();
    expect(code).toBe(1);
    expect(fsReader.list(reportsDir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-verdict is untouched — a verdict has no outcome field and no PR to name', () => {
    const dir = tmp();
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'v.json');
    writeFileSync(f, JSON.stringify(writtenVerdict));
    const errChunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errChunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    const code = runWriteVerdict([f, '--dir', verdictsDir, '--id', 'FOR-6', '--iter', '1']);
    out.restore();
    err.mockRestore();
    expect(code).toBe(0);
    expect(errChunks.join('')).not.toMatch(/prUrl/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('both exit-0 findings ride the same run: the prUrl notice AND the misnamed-litter warning', () => {
    // The Scribe forwards every `notice:`/`warning:` line verbatim, so the two
    // must not shadow each other — a payload finding must not suppress the
    // directory sweep that runs after it.
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(
      join(reportsDir, '#FOR-6-1.md'),
      '# WorkerReport #FOR-6 iter 1\n\n```json\n' +
        JSON.stringify({ ...writtenReport, issue: '#FOR-6' }, null, 2) +
        '\n```\n',
      'utf-8',
    );
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(reportWithoutPrUrl));
    const errChunks: string[] = [];
    const err = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((c: string | Uint8Array) => {
        errChunks.push(typeof c === 'string' ? c : c.toString());
        return true;
      });
    const out = captureStdout();
    expect(runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    out.restore();
    err.mockRestore();
    const msg = errChunks.join('');
    expect(msg).toMatch(/notice: write-report: outcome "done"/);
    expect(msg).toMatch(/MISNAMED SIDECAR/);
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

// ─── row V5 — `--json` on this module's four prose verbs (ADR-0051 dec. 7) ───
//
// Four of the eight verbs this row covers live here, all output class `prose`
// and all with a result that is DATA: the two schema validators answer `valid`
// or the schema errors, and the two sidecar writers answer with the path they
// wrote, the id and the iteration. Before this row a caller that wanted the
// errors had to read them off STDERR as prose, and a caller that wanted the id
// it had just passed had to keep it.
//
// Each shape is contract from landing (ADR-0035): pinned below, with the default
// output pinned byte-identically beside it and the exit code asserted on every
// case — the flag chose a rendering, never a verdict.

/** Capture stdout AND stderr for one call, so "what moved where" is assertable. */
function captureBoth(): { out: () => string; err: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    outChunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    errChunks.push(typeof c === 'string' ? c : c.toString());
    return true;
  });
  return {
    out: () => outChunks.join(''),
    err: () => errChunks.join(''),
    restore: () => {
      o.mockRestore();
      e.mockRestore();
    },
  };
}

describe('validate-report / validate-verdict --json (row V5)', () => {
  const validReport = {
    outcome: 'done', issue: '1-x', branch: 'w/1-x', commitShas: ['abc1234'],
    filesChanged: { new: 1, modified: 0, renamed: 0 },
    tests: '20/20 green', lint: 'clean', judgmentCalls: [], reviewerFocusItems: [],
  };

  it('a VALID payload answers { verb, file, valid: true, errors: [] }, exit 0', () => {
    const dir = tmp();
    const f = join(dir, 'report.json');
    writeFileSync(f, JSON.stringify(validReport));
    const c = captureBoth();
    const code = runValidateReport([f, '--json']);
    c.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual({
      verb: 'validate-report',
      file: f,
      valid: true,
      errors: [],
    });
    // The prose `valid` line is REPLACED, not printed beside the JSON.
    expect(c.out()).not.toContain('valid\n');
    expect(c.err()).toBe('');
  });

  it('an INVALID payload carries the schema errors ON STDOUT and still exits 1', () => {
    const dir = tmp();
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...validReport, outcome: 'shipped' }));

    // The prose form first, so the expectation is DERIVED from the validator
    // rather than transcribed from it.
    const prose = captureBoth();
    expect(runValidateReport([f])).toBe(1);
    prose.restore();
    const proseErrors = prose
      .err()
      .split('\n')
      .filter((l) => l.startsWith('  - '))
      .map((l) => l.slice('  - '.length));
    expect(proseErrors.length).toBeGreaterThan(0);

    const c = captureBoth();
    const code = runValidateReport([f, '--json']);
    c.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(1); // the flag moved no exit code
    const answer = JSON.parse(c.out()) as { valid: boolean; errors: string[] };
    expect(answer.valid).toBe(false);
    expect(answer.errors).toEqual(proseErrors);
    // …and the `invalid:` block no longer duplicates them on stderr.
    expect(c.err()).toBe('');
  });

  it('validate-verdict answers the same shape under its own verb name', () => {
    const dir = tmp();
    const f = join(dir, 'verdict.json');
    writeFileSync(f, JSON.stringify(writtenVerdict));
    const c = captureBoth();
    const code = runValidateVerdict([f, '--json']);
    c.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual({
      verb: 'validate-verdict',
      file: f,
      valid: true,
      errors: [],
    });
  });

  it('reads the <file> through the CONTRACT, so --json may lead', () => {
    // Before this row the payload was `args[0]` outright, so a leading `--json`
    // would have been opened as the file.
    const dir = tmp();
    const f = join(dir, 'report.json');
    writeFileSync(f, JSON.stringify(validReport));
    const c = captureBoth();
    const code = runValidateReport(['--json', f]);
    c.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(0);
    expect((JSON.parse(c.out()) as { valid: boolean }).valid).toBe(true);
  });

  it('an UNREADABLE file stays a usage error — exit 2, prose on stderr, no answer', () => {
    // Not a validation outcome: nothing was read, so there is no `valid` verdict
    // to report about it. Same rule the silent-write receipts follow — a refusal
    // prints no receipt.
    const c = captureBoth();
    const code = runValidateReport(['/nonexistent/nope.json', '--json']);
    c.restore();
    expect(code).toBe(2);
    expect(c.out()).toBe('');
    expect(c.err()).toMatch(/cannot read\/parse/);
  });

  it("NEGATIVE CONTROL: without --json both verbs print TODAY'S bytes", () => {
    const dir = tmp();
    const ok = join(dir, 'report.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(ok, JSON.stringify(validReport));
    writeFileSync(bad, JSON.stringify({ ...validReport, outcome: 'shipped' }));

    const good = captureBoth();
    expect(runValidateReport([ok])).toBe(0);
    good.restore();
    expect(good.out()).toBe('valid\n');
    expect(good.err()).toBe('');

    const worse = captureBoth();
    expect(runValidateReport([bad])).toBe(1);
    worse.restore();
    expect(worse.out()).toBe('');
    expect(worse.err().startsWith('invalid:\n  - ')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('write-report / write-verdict --json (row V5)', () => {
  it('answers { verb, path, id, iter } — the written path, and the pair it was filed under', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'payload.json');
    writeFileSync(f, JSON.stringify(writtenReport));
    const c = captureBoth();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1', '--json']);
    c.restore();
    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual({
      verb: 'write-report',
      path: join(reportsDir, 'FOR-6-1.md'),
      id: 'FOR-6',
      iter: 1,
    });
    // `iter` is a NUMBER, not the string the caller typed — a consumer that
    // compares iterations should not have to coerce it first.
    expect(typeof (JSON.parse(c.out()) as { iter: unknown }).iter).toBe('number');
    // …and the record really is on disk under that name.
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')?.iter).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('`path` is the very string the prose form prints — one file, two renderings', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'payload.json');
    writeFileSync(f, JSON.stringify(writtenReport));

    const prose = captureBoth();
    expect(runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    prose.restore();

    const c = captureBoth();
    expect(runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1', '--json'])).toBe(0);
    c.restore();
    expect((JSON.parse(c.out()) as { path: string }).path).toBe(prose.out().trim());
    rmSync(dir, { recursive: true, force: true });
  });

  it('write-verdict answers the same shape under its own verb name', () => {
    const dir = tmp();
    const verdictsDir = join(dir, 'verdicts');
    const f = join(dir, 'verdict.json');
    writeFileSync(f, JSON.stringify(writtenVerdict));
    const c = captureBoth();
    const code = runWriteVerdict([f, '--dir', verdictsDir, '--id', 'FOR-6', '--iter', '2', '--json']);
    c.restore();
    expect(code).toBe(0);
    expect(JSON.parse(c.out())).toEqual({
      verb: 'write-verdict',
      path: join(verdictsDir, 'FOR-6-2.md'),
      id: 'FOR-6',
      iter: 2,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('NEGATIVE CONTROL: an invalid payload still exits 1 and prints NO answer — nothing written', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'bad.json');
    writeFileSync(f, JSON.stringify({ ...writtenReport, outcome: 'shipped' }));
    const c = captureBoth();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1', '--json']);
    c.restore();
    expect(code).toBe(1);
    // The receipt is built AFTER the bytes land, so a refused write can never
    // print one — structural, not asserted by the runner.
    expect(c.out()).toBe('');
    expect(readSidecars(reportsDir, join(dir, 'verdicts'), fsReader).reportFor('FOR-6')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the notice:/warning: findings STAY on stderr under --json — they are about the record, not the result', () => {
    // A finishing report with no usable prUrl (issue #556): the sidecar lands,
    // the notice fires. Under --json stdout must be exactly one JSON document —
    // a caller piping it into a parser cannot also be handed prose.
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'payload.json');
    const { prUrl: _dropped, ...noPrUrl } = writtenReport;
    writeFileSync(f, JSON.stringify(noPrUrl));
    const c = captureBoth();
    const code = runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1', '--json']);
    c.restore();
    expect(code).toBe(0);
    expect(() => JSON.parse(c.out()) as unknown).not.toThrow();
    expect(c.err()).toMatch(/^notice: write-report: /);
    expect(c.out()).not.toContain('notice:');
    rmSync(dir, { recursive: true, force: true });
  });

  it("NEGATIVE CONTROL: without --json the write verbs print TODAY'S single path line", () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const f = join(dir, 'payload.json');
    writeFileSync(f, JSON.stringify(writtenReport));
    const c = captureBoth();
    expect(runWriteReport([f, '--dir', reportsDir, '--id', 'FOR-6', '--iter', '1'])).toBe(0);
    c.restore();
    expect(c.out()).toBe(join(reportsDir, 'FOR-6-1.md') + '\n');
    expect(c.err()).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it("each verb's own usage names the JSON form beside the prose note", () => {
    for (const [run, verb, shape] of [
      [runValidateReport, 'validate-report', '{ verb, file, valid, errors }'],
      [runValidateVerdict, 'validate-verdict', '{ verb, file, valid, errors }'],
      [runWriteReport, 'write-report', '{ verb, path, id, iter }'],
      [runWriteVerdict, 'write-verdict', '{ verb, path, id, iter }'],
    ] as [(a: string[]) => number, string, string][]) {
      const c = captureBoth();
      expect(run(['--help'])).toBe(0);
      c.restore();
      expect(c.out()).toContain(`flotilla-engine ${verb}`);
      expect(c.out()).toContain('not JSON');
      expect(c.out()).toContain(`--json: `);
      expect(c.out()).toContain(shape);
    }
  });
});

// ─── the Scribe fidelity gates (unknown-key refusal + --expect-digest) ───────
//
// Live cause: in one wave the Scribe-written sidecar disagreed with the agent's
// returned payload in 4 of 8 rows — an undeclared top-level `verifyOutput`, and
// reworded `judgmentCalls`, `reviewerFocusItems` and `acVerification` — and the
// verb wrote every paraphrase with exit 0. Both gates live in the WRITE verbs
// only: the reader and the shared validators stay permissive, and the last
// describe below pins that a historical sidecar carrying an extra key is still
// read.

interface WriteRun {
  code: number;
  out: string;
  err: string;
  written: string[];
  body: string | null;
}

/** One write-verb call against a fresh temp dir: what it printed, and what landed. */
function runWrite(
  verb: (a: string[]) => number,
  payload: unknown,
  extra: string[] = [],
  kind: 'reports' | 'verdicts' = 'reports',
  id = 'FOR-6',
): WriteRun {
  const dir = tmp();
  const target = join(dir, kind);
  const f = join(dir, 'p.json');
  writeFileSync(f, JSON.stringify(payload));
  const io = captureBoth();
  const code = verb([f, '--dir', target, '--id', id, '--iter', '1', ...extra]);
  io.restore();
  const written = fsReader.list(target);
  const body = written.length ? readFileSync(join(target, written[0]), 'utf-8') : null;
  rmSync(dir, { recursive: true, force: true });
  return { code, out: io.out(), err: io.err(), written, body };
}

describe('write verbs — an undeclared key is refused (exit 1, nothing written, the key named)', () => {
  it('NEGATIVE CONTROL — a well-formed report and a well-formed verdict are written', () => {
    expect(runWrite(runWriteReport, writtenReport)).toMatchObject({ code: 0, written: ['FOR-6-1.md'] });
    expect(runWrite(runWriteVerdict, writtenVerdict, [], 'verdicts')).toMatchObject({
      code: 0,
      written: ['FOR-6-1.md'],
    });
  });

  it('a report with an undeclared TOP-LEVEL key (the live `verifyOutput`) → exit 1, nothing written', () => {
    const r = runWrite(runWriteReport, { ...writtenReport, verifyOutput: '20/20 green' });
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.out).toBe('');
    expect(r.err).toContain('nothing written');
    expect(r.err).toContain('undeclared key "verifyOutput"');
  });

  it('a verdict with an undeclared TOP-LEVEL key → exit 1, nothing written', () => {
    const r = runWrite(runWriteVerdict, { ...writtenVerdict, summary: 'looks fine' }, [], 'verdicts');
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('undeclared key "summary"');
  });

  it('an undeclared key inside the FILE-COUNT object is refused', () => {
    const payload = { ...writtenReport, filesChanged: { new: 1, modified: 0, renamed: 0, deleted: 1 } };
    const r = runWrite(runWriteReport, payload);
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('undeclared key "filesChanged.deleted"');
  });

  it('an undeclared key inside an AC-VERIFICATION ROW is refused', () => {
    const payload = {
      ...writtenVerdict,
      acVerification: [{ ac: '#1', met: 'met', evidence: 'x', paraphrase: 'y' }],
    };
    const r = runWrite(runWriteVerdict, payload, [], 'verdicts');
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('undeclared key "acVerification[0].paraphrase"');
  });

  it('an undeclared key inside the documented-form comparison, and inside one of its divergences, is refused', () => {
    const payload = {
      ...writtenVerdict,
      documentedFormComparison: {
        trigger: 'worker-declared',
        sources: ['https://example.invalid/doc'],
        divergences: [{ description: 'a', deliberate: true, severity: 'low' }],
        note: 'x',
      },
    };
    const r = runWrite(runWriteVerdict, payload, [], 'verdicts');
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('undeclared key "documentedFormComparison.note"');
    expect(r.err).toContain('undeclared key "documentedFormComparison.divergences[0].severity"');
  });
});

describe('write verbs — --expect-digest refuses a payload that is not the one the driver handed over', () => {
  it('a payload whose digest matches is written (report and verdict)', () => {
    const r = runWrite(runWriteReport, writtenReport, ['--expect-digest', canonicalDigest(writtenReport)]);
    expect(r.code).toBe(0);
    expect(r.written).toEqual(['FOR-6-1.md']);
    const v = runWrite(
      runWriteVerdict,
      writtenVerdict,
      ['--expect-digest', canonicalDigest(writtenVerdict)],
      'verdicts',
    );
    expect(v.code).toBe(0);
    expect(v.written).toEqual(['FOR-6-1.md']);
  });

  it('key REORDERING alone does not change the digest — a reordered file is written under the original digest', () => {
    const reordered = Object.fromEntries(Object.entries(writtenReport).reverse());
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(writtenReport));
    const r = runWrite(runWriteReport, reordered, ['--expect-digest', canonicalDigest(writtenReport)]);
    expect(r.code).toBe(0);
    expect(r.written).toEqual(['FOR-6-1.md']);
  });

  it('ONE list element reworded → exit 1, nothing written, stderr names BOTH digests', () => {
    const handed = { ...writtenReport, judgmentCalls: ['kept the alias, and said why'] };
    const transcribed = { ...handed, judgmentCalls: ['kept the alias'] };
    const expected = canonicalDigest(handed);
    const actual = canonicalDigest(transcribed);
    expect(actual).not.toBe(expected);
    const r = runWrite(runWriteReport, transcribed, ['--expect-digest', expected]);
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.out).toBe('');
    expect(r.err).toContain('payload digest mismatch — nothing written');
    expect(r.err).toContain(`expected (--expect-digest): ${expected}`);
    expect(r.err).toContain(`: ${actual}`);
  });

  it('a reworded AC-verification row on the VERDICT path is refused the same way', () => {
    const handed = { ...writtenVerdict, acVerification: [{ ac: '#1', met: 'met', evidence: 'route-cli.ts:640' }] };
    const transcribed = { ...writtenVerdict, acVerification: [{ ac: '#1', met: 'met', evidence: 'route-cli.ts' }] };
    const r = runWrite(runWriteVerdict, transcribed, ['--expect-digest', canonicalDigest(handed)], 'verdicts');
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain(canonicalDigest(handed));
    expect(r.err).toContain(canonicalDigest(transcribed));
  });

  it('the digest is taken over the payload AS READ — before a decorated issue is normalized', () => {
    const decorated = { ...writtenReport, issue: '#126' };
    // The faithful copy's digest matches, and the normalization still happens.
    const ok = runWrite(runWriteReport, decorated, ['--expect-digest', canonicalDigest(decorated)], 'reports', '126');
    expect(ok.code).toBe(0);
    expect(ok.err).toContain('notice: write-report: report.issue "#126" is a DECORATED form');
    expect(ok.body).toContain('"issue": "126"');
    // A digest of the NORMALIZED record is not what the driver computes, and it mismatches.
    const normalized = { ...writtenReport, issue: '126' };
    const bad = runWrite(runWriteReport, decorated, ['--expect-digest', canonicalDigest(normalized)], 'reports', '126');
    expect(bad.code).toBe(1);
    expect(bad.written).toEqual([]);
  });

  it('WITHOUT the flag, behaviour is unchanged — the same reworded payload is written', () => {
    const transcribed = { ...writtenReport, judgmentCalls: ['kept the alias'] };
    const r = runWrite(runWriteReport, transcribed);
    expect(r.code).toBe(0);
    expect(r.written).toEqual(['FOR-6-1.md']);
    expect(r.err).toBe('');
  });

  it('the unknown-key refusal applies WITH the flag too, even when the digest covers the extra key', () => {
    const smuggled = { ...writtenReport, verifyOutput: 'x' };
    const r = runWrite(runWriteReport, smuggled, ['--expect-digest', canonicalDigest(smuggled)]);
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('undeclared key "verifyOutput"');
  });

  it('a value that is not a digest → usage (exit 2), nothing written', () => {
    const r = runWrite(runWriteReport, writtenReport, ['--expect-digest', 'NOT-A-DIGEST']);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('is not a digest');
  });

  it('the flag with no value → usage (exit 2), nothing written', () => {
    const r = runWrite(runWriteReport, writtenReport, ['--expect-digest']);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
  });

  it('--help names the flag and both refusals, on both verbs', () => {
    for (const verb of [runWriteReport, runWriteVerdict]) {
      const io = captureBoth();
      expect(verb(['--help'])).toBe(0);
      io.restore();
      expect(io.out()).toContain('--expect-digest <digest>');
      expect(io.out()).toContain('A key the canonical schema does not declare');
    }
  });
});

describe('the reader stays permissive — a HISTORICAL sidecar carrying an extra key is still read', () => {
  it('reads a report sidecar with an undeclared top-level key and a verdict with an undeclared AC-row key', () => {
    const dir = tmp();
    const reportsDir = join(dir, 'reports');
    const verdictsDir = join(dir, 'verdicts');
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });
    // Written the way a pre-gate Scribe wrote them: through the one renderer,
    // carrying the extra keys the write verb would now refuse.
    writeFileSync(
      join(reportsDir, 'FOR-6-1.md'),
      renderSidecarBody('WorkerReport', 'FOR-6', 1, { ...writtenReport, verifyOutput: '20/20 green' }),
    );
    writeFileSync(
      join(verdictsDir, 'FOR-6-1.md'),
      renderSidecarBody('ReviewerVerdict', 'FOR-6', 1, {
        ...writtenVerdict,
        acVerification: [{ ac: '#1', met: 'met', evidence: 'x', note: 'extra' }],
      }),
    );
    const idx = readSidecars(reportsDir, verdictsDir, fsReader);
    expect(idx.reportFor('FOR-6')?.report.tests).toBe('20/20 green');
    expect(idx.verdictFor('FOR-6')?.verdict.acVerification[0].ac).toBe('#1');
    expect(idx.corruptFor('FOR-6')).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── write-verdict --payload-encoding base64 ────────────────────────────────
//
// The verdict Scribe copied a long JSON verdict out of prose and missed
// --expect-digest in two of five rounds of one wave. The driver now hands it
// the base64 token of that JSON instead, and this flag decodes it. The driver's
// encoder is evaluated from its own marked region and round-tripped through
// the REAL verb here — that is the pin between the encoder and this decoder.

const DRIVER_SOURCE = readFileSync(join(__dirname, '..', 'driver', 'wave-start-inflight.js'), 'utf-8');

/** The driver's inlined `base64Utf8`, evaluated as the harness would run it. */
function driverBase64Utf8(): (text: string) => string {
  const begin = DRIVER_SOURCE.indexOf('// BASE64-UTF8:BEGIN');
  const end = DRIVER_SOURCE.indexOf('// BASE64-UTF8:END');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${DRIVER_SOURCE.slice(begin, end)}\nreturn base64Utf8`)();
}

/** A verdict carrying every character class the live failures had. */
const HARD_VERDICT = {
  ...writtenVerdict,
  workerReportDigest: 'said "done" → 20/20; C:\\tmp\\x &amp; <b>bold</b>',
  acVerification: [
    { ac: 'nested "quotes \'inside\' quotes" ⇒ ✓', met: 'met', evidence: '&lt;tag&gt; Grüße – 漢字 🚀 👩‍💻 \\n' },
  ],
  reviewerFocusItems: ['a real newline:\nand a tab:\tend', 'backslash-quote: \\"'],
};

/** One write-verdict call on a RAW payload file (the base64 path is not JSON). */
function runWriteRaw(raw: string, extra: string[]): WriteRun {
  const dir = tmp();
  const target = join(dir, 'verdicts');
  const f = join(dir, 'p.b64');
  writeFileSync(f, raw);
  const io = captureBoth();
  const code = runWriteVerdict(['--verdict-file', f, '--verdicts-dir', target, '--id', 'FOR-6', '--iter', '1', ...extra]);
  io.restore();
  const written = fsReader.list(target);
  const body = written.length ? readFileSync(join(target, written[0]), 'utf-8') : null;
  rmSync(dir, { recursive: true, force: true });
  return { code, out: io.out(), err: io.err(), written, body };
}

/** The JSON inside a rendered sidecar body. */
const sidecarJson = (body: string | null): unknown =>
  JSON.parse((/```json\n([\s\S]*)\n```/.exec(body ?? '') as RegExpExecArray)[1]);

describe('write-verdict --payload-encoding base64 — the verdict Scribe copies ASCII, the verb decodes it', () => {
  const encode = driverBase64Utf8();

  it('the DRIVER encoder agrees with an independent reference (Buffer) on the hard verdict', () => {
    const json = JSON.stringify(HARD_VERDICT);
    expect(encode(json)).toBe(Buffer.from(json, 'utf8').toString('base64'));
    // Every padding remainder, and the empty string.
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', '→', '🚀']) {
      expect(encode(s), s).toBe(Buffer.from(s, 'utf8').toString('base64'));
    }
  });

  it('ROUND TRIP — driver encode → decode → digest match → sidecar equal to the canonical payload', () => {
    const json = JSON.stringify(HARD_VERDICT);
    const r = runWriteRaw(encode(json), ['--payload-encoding', 'base64', '--expect-digest', canonicalDigest(HARD_VERDICT)]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.written).toEqual(['FOR-6-1.md']);
    expect(sidecarJson(r.body)).toEqual(HARD_VERDICT);
    // Byte-for-byte what the JSON path renders for the same payload.
    expect(r.body).toBe(renderSidecarBody('ReviewerVerdict', 'FOR-6', 1, HARD_VERDICT));
  });

  it('whitespace and line breaks inside the token are tolerated', () => {
    const wrapped = encode(JSON.stringify(HARD_VERDICT)).replace(/(.{40})/g, '$1\r\n  ') + '\n\n';
    const r = runWriteRaw(wrapped, ['--payload-encoding', 'base64', '--expect-digest', canonicalDigest(HARD_VERDICT)]);
    expect(r.code).toBe(0);
    expect(sidecarJson(r.body)).toEqual(HARD_VERDICT);
  });

  it('a token that decodes to a DIFFERENT verdict still misses the digest (exit 1, nothing written)', () => {
    const other = { ...HARD_VERDICT, workerReportDigest: 'reworded' };
    const r = runWriteRaw(encode(JSON.stringify(other)), [
      '--payload-encoding', 'base64', '--expect-digest', canonicalDigest(HARD_VERDICT),
    ]);
    expect(r.code).toBe(1);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('payload digest mismatch');
  });

  it('INVALID base64 → exit 2, nothing written, and the message says base64 failed', () => {
    const token = encode(JSON.stringify(HARD_VERDICT));
    for (const bad of [`${token.slice(0, 20)}!${token.slice(21)}`, token.slice(0, -1), '====', '   \n']) {
      const r = runWriteRaw(bad, ['--payload-encoding', 'base64']);
      expect(r.code, bad).toBe(2);
      expect(r.written, bad).toEqual([]);
      expect(r.out, bad).toBe('');
      expect(r.err, bad).toContain('invalid base64');
      expect(r.err, bad).not.toContain('invalid JSON');
      expect(r.err, bad).toContain('nothing written');
    }
  });

  it('base64 whose bytes are not UTF-8 → exit 2, named as a base64 decode failure', () => {
    const r = runWriteRaw(Buffer.from([0xff, 0xfe, 0x7b]).toString('base64'), ['--payload-encoding', 'base64']);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('invalid base64');
    expect(r.err).toContain('not UTF-8');
  });

  it('VALID base64 but INVALID JSON after decoding → exit 2, nothing written, and the message says JSON failed', () => {
    const r = runWriteRaw(encode('{"verdict": "approve", → not json'), ['--payload-encoding', 'base64']);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.out).toBe('');
    expect(r.err).toContain('valid base64, but invalid JSON after decoding');
    expect(r.err).toContain('nothing written');
  });

  it('an unknown encoding value, or the flag with no value, is a usage error — nothing written', () => {
    for (const extra of [['--payload-encoding', 'hex'], ['--payload-encoding']]) {
      const r = runWriteRaw(JSON.stringify(writtenVerdict), extra);
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.written).toEqual([]);
    }
    const hex = runWriteRaw(JSON.stringify(writtenVerdict), ['--payload-encoding', 'hex']);
    expect(hex.err).toContain('--payload-encoding takes one of json|base64, got "hex"');
  });

  it('--payload-encoding json is the explicit default — a plain JSON file is written exactly as without the flag', () => {
    const r = runWriteRaw(JSON.stringify(HARD_VERDICT), ['--payload-encoding', 'json']);
    expect(r.code).toBe(0);
    expect(r.body).toBe(renderSidecarBody('ReviewerVerdict', 'FOR-6', 1, HARD_VERDICT));
  });

  it('WITHOUT the flag a base64 file is read as JSON, as before — refused as unparseable, never decoded', () => {
    const r = runWriteRaw(encode(JSON.stringify(writtenVerdict)), []);
    expect(r.code).toBe(2);
    expect(r.written).toEqual([]);
    expect(r.err).toContain('cannot read/parse');
  });

  it('write-report does not accept the flag — the report Scribe is unchanged', () => {
    const dir = tmp();
    const f = join(dir, 'p.json');
    writeFileSync(f, JSON.stringify(writtenReport));
    const io = captureBoth();
    const code = runWriteReport([f, '--dir', join(dir, 'reports'), '--id', 'FOR-6', '--iter', '1', '--payload-encoding', 'json']);
    io.restore();
    rmSync(dir, { recursive: true, force: true });
    expect(code).toBe(2);
  });
});
