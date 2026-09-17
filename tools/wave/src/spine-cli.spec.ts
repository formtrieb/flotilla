import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSpine, SPINE_CONTRACTS } from './spine-cli';
// The router, imported to pin that its `spine` case is the ONE dispatch path
// this module's ops now flow through (issue #77).
import { main } from './cli';
import { readSpine, HUMAN_GATED_WORKER } from './wave-md-rw';
import {
  readDisclosures,
  WAVE_SCOPE_ITER_CELL,
  createSpineStore,
  defaultSpineIo,
  type SpineStore,
} from './spine-store';

const FIXTURE = readFileSync(
  join(__dirname, '__fixtures__/minimal-spine.md'),
  'utf-8',
);

// A real row id + a valid RowState lifted from the fixture's Plan-Table.
const ROW_ID = '01';
const NEW_STATE = 'dispatched';

function writeTmpSpine(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spine-cli-'));
  const path = join(dir, 'WAVE.md');
  writeFileSync(path, FIXTURE, 'utf-8');
  return path;
}

describe('spine-cli — runSpine', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('set-row-state mutates the row + flushes to disk, preserving the rest', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-row-state', path, ROW_ID, NEW_STATE]);
    expect(code).toBe(0);

    const after = readFileSync(path, 'utf-8');
    expect(after).toMatch(/\| dispatched \|/);
    // Surrounding sections are byte-preserved.
    expect(after).toContain('## Resume-Metadata');
    expect(after).toContain('branch wave-orch/01-thing');
  });

  it('read prints the spine source to stdout', () => {
    const path = writeTmpSpine();
    const code = runSpine(['read', path]);
    expect(code).toBe(0);

    const printed = stdoutSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');
    expect(printed).toContain('## Plan-Table');
    expect(printed).toContain('Wave 2026-06-06 — test');
  });

  it('set-row-pr mutates the PR cell + flushes', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-row-pr', path, ROW_ID, '#42']);
    expect(code).toBe(0);

    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('#42');
  });

  it('set-row-state missing the state arg → usage, returns 2', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-row-state', path, ROW_ID]);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('unknown op → stderr, returns 2', () => {
    const path = writeTmpSpine();
    const code = runSpine(['frobnicate', path]);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('missing op + path → usage, returns 2', () => {
    expect(runSpine([])).toBe(2);
    expect(runSpine(['read'])).toBe(2);
  });

  it('replace-closed-by with an unreadable body-file → stderr, returns 2', () => {
    const path = writeTmpSpine();
    const code = runSpine([
      'replace-closed-by',
      path,
      join(tmpdir(), 'does-not-exist-spine-cli.md'),
    ]);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('replace-closed-by writes the new body into the Closed-by block, byte-preserving the rest', () => {
    const path = writeTmpSpine();
    const dir = mkdtempSync(join(tmpdir(), 'spine-cli-body-'));
    const bodyFile = join(dir, 'closed-by.md');
    const newBody = 'Closed by PR #42 (merged 2026-06-06).';
    writeFileSync(bodyFile, newBody, 'utf-8');

    const code = runSpine(['replace-closed-by', path, bodyFile]);
    expect(code).toBe(0);

    const after = readFileSync(path, 'utf-8');
    // The new content landed inside the Closed-by section.
    expect(after).toMatch(/## Closed-by[\s\S]*Closed by PR #42 \(merged 2026-06-06\)\./);
    // The placeholder it replaced is gone.
    expect(after).not.toContain('_(none yet)_');
    // A recognizable other section is byte-preserved.
    expect(after).toContain('## Plan-Table');
    expect(after).toContain('branch wave-orch/01-thing');
  });

  it('set-row-state with an invalid state token → stderr, returns 2 (fail loud)', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-row-state', path, ROW_ID, 'not-a-real-state']);
    expect(code).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    // The durable spine is untouched (no corruption written through).
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('not-a-real-state');
  });

  it('set-row-state with an unknown row id → clean domain exit 1 (no stack trace)', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-row-state', path, '99', NEW_STATE]);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('create renders a fresh, parseable spine to the out path', () => {
    const writes: Record<string, string> = {};
    const payload = JSON.stringify({
      meta: { slug: 'demo', description: 'd', coordinator: 'at', model: 'Opus 4.8', created: '2026-06-18', lastUpdated: '2026-06-18 10:00' },
      roster: [{ id: '1', title: 'T', worker: 'background', risk: 'mechanical' }],
      conflict: { issues: [], cells: [] },
      dorCheck: 'all pass.',
    });
    const io = {
      read: (p: string) => (p === 'payload.json' ? payload : (() => { throw new Error('nope'); })()),
      write: (p: string, c: string) => { writes[p] = c; },
    };
    const code = runSpine(['create', 'out/WAVE.md', 'payload.json'], io);
    expect(code).toBe(0);
    const spine = readSpine(writes['out/WAVE.md']);
    expect(spine.planTable).toHaveLength(1);
    expect(spine.planTable[0].state).toBe('planned');
  });

  it('create returns 2 on missing args', () => {
    const io = { read: () => '', write: () => {} };
    expect(runSpine(['create', 'out/WAVE.md'], io)).toBe(2);
  });

  it('create returns 2 on unparseable payload', () => {
    const io = { read: () => 'not json', write: () => {} };
    expect(runSpine(['create', 'out/WAVE.md', 'bad.json'], io)).toBe(2);
  });

  it('set-status flips the frontmatter Status and flushes', () => {
    const path = writeTmpSpine();
    expect(runSpine(['set-status', path, 'ready'])).toBe(0);
    const after = readFileSync(path, 'utf-8');
    expect(readSpine(after).frontmatter.status).toBe('ready');
  });

  it('set-status rejects an unknown status token with usage 2', () => {
    const path = writeTmpSpine();
    expect(runSpine(['set-status', path, 'reddy'])).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
    // Spine is untouched (no corruption written through).
    const after = readFileSync(path, 'utf-8');
    expect(after).not.toContain('reddy');
  });

  it('set-status with missing args → usage 2', () => {
    const path = writeTmpSpine();
    expect(runSpine(['set-status', path])).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('set-branch records the row branch in the dispatch-log + flushes', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-branch', path, ROW_ID, 'wave/01-thing']);
    expect(code).toBe(0);
    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('wave/01-thing');
  });

  it('set-branch --model also records the dispatched model', () => {
    const path = writeTmpSpine();
    const code = runSpine(['set-branch', path, ROW_ID, 'wave/01-thing', '--model', 'claude-opus-4-8']);
    expect(code).toBe(0);
    const after = readFileSync(path, 'utf-8');
    expect(after).toContain('claude-opus-4-8');
  });

  it('set-branch with missing branch is a usage error (exit 2)', () => {
    const path = writeTmpSpine();
    expect(runSpine(['set-branch', path, ROW_ID])).toBe(2);
  });

  it('set-branch --model with no model value → usage error (exit 2)', () => {
    const path = writeTmpSpine();
    expect(runSpine(['set-branch', path, ROW_ID, 'wave/01-thing', '--model'])).toBe(2);
  });

  // ── set-row-iter (FOR-53) ────────────────────────────────────────────────
  // The minimal-spine.md fixture's row `01` has reportsVerdicts === '—', which
  // covers the Iter-only-bump path (no sidecar links). The two-link renderer
  // path is covered by a locally-composed spine below, mirroring how a real
  // renderSpine-produced wave carries `[r1](…) → [v1](…)` links.

  describe('set-row-iter', () => {
    const SIDECAR_SPINE = `# Wave 2026-07-20 — sidecar-test

**Status:** in-flight

## Plan-Table

| ID  | Title | Worker     | Risk               | Reviewer     | PR  | State         | Iter | Reports → Verdicts |
| --- | ----- | ---------- | ------------------- | ------------ | --- | ------------- | ---- | ------------------- |
| FOR-30 | Row | background | isolated-refactor | quick-verify | —   | re-dispatched | 1    | [r1](./w/reports/FOR-30-1.md) → [v1](./w/verdicts/FOR-30-1.md) |

## Closed-by

_(none yet)_
`;

    function writeTmpSidecarSpine(): string {
      const dir = mkdtempSync(join(tmpdir(), 'spine-cli-iter-'));
      const path = join(dir, 'WAVE.md');
      writeFileSync(path, SIDECAR_SPINE, 'utf-8');
      return path;
    }

    it('bumps the Iter cell + flushes (minimal fixture, no sidecar cell)', () => {
      const path = writeTmpSpine();
      const code = runSpine(['set-row-iter', path, ROW_ID, '2']);
      expect(code).toBe(0);
      const after = readFileSync(path, 'utf-8');
      const row = readSpine(after).planTable[0];
      expect(row.iter).toBe(2);
      // Surrounding sections are byte-preserved.
      expect(after).toContain('branch wave-orch/01-thing');
    });

    it('re-renders the sidecar-link cell to the new iteration', () => {
      const path = writeTmpSidecarSpine();
      const code = runSpine(['set-row-iter', path, 'FOR-30', '2']);
      expect(code).toBe(0);
      const after = readFileSync(path, 'utf-8');
      const row = readSpine(after).planTable[0];
      expect(row.iter).toBe(2);
      expect(row.reportsVerdicts).toBe(
        '[r2](./w/reports/FOR-30-2.md) → [v2](./w/verdicts/FOR-30-2.md)',
      );
      // The re-dispatched State cell (written by the routing step's paired
      // set-row-state call) is untouched by this op.
      expect(row.state).toBe('re-dispatched');
    });

    it('missing the <n> arg → usage, returns 2', () => {
      const path = writeTmpSpine();
      const code = runSpine(['set-row-iter', path, ROW_ID]);
      expect(code).toBe(2);
      expect(stderrSpy).toHaveBeenCalled();
    });

    it('a non-integer <n> → usage, returns 2 (fail loud)', () => {
      const path = writeTmpSpine();
      const code = runSpine(['set-row-iter', path, ROW_ID, 'two']);
      expect(code).toBe(2);
      expect(stderrSpy).toHaveBeenCalled();
      // The durable spine is untouched.
      const after = readFileSync(path, 'utf-8');
      expect(readSpine(after).planTable[0].iter).toBe(1);
    });

    it('a zero/negative <n> → usage, returns 2 (fail loud)', () => {
      const path = writeTmpSpine();
      expect(runSpine(['set-row-iter', path, ROW_ID, '0'])).toBe(2);
      expect(runSpine(['set-row-iter', path, ROW_ID, '-1'])).toBe(2);
    });

    it('a fractional <n> → usage, returns 2 (fail loud)', () => {
      const path = writeTmpSpine();
      expect(runSpine(['set-row-iter', path, ROW_ID, '1.5'])).toBe(2);
    });

    it('an unknown row id → clean domain exit 1 (no stack trace)', () => {
      const path = writeTmpSpine();
      const code = runSpine(['set-row-iter', path, '99', '2']);
      expect(code).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
    });
  });

  // ── Disclosures (ADR-0027) ────────────────────────────────────────────────
  //
  // The three verbs that make a disclosure durable: capture at routing
  // (`add-disclosure`), the human-decided exit (`set-disposition`), and the
  // fail-closed gate `wave-close` runs before Archive (`check-disclosures`).

  describe('disclosures', () => {
    /** All stdout written so far, joined. */
    const printed = () =>
      stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');

    it('add-disclosure captures at `open`, prints the ref, and flushes to disk', () => {
      const path = writeTmpSpine();
      const code = runSpine([
        'add-disclosure', path, ROW_ID,
        '--iter', '1',
        '--source', 'worker',
        '--text', 'the consuming call-site lies outside the declared Files globs',
      ]);
      expect(code).toBe(0);
      expect(printed().trim()).toBe('01.1');

      const after = readFileSync(path, 'utf-8');
      expect(after).toContain('## Disclosures');
      expect(after).toContain(
        '| 01.1 | 01 | 1 | worker | open | the consuming call-site lies outside the declared Files globs |',
      );
      // The fixture predates ADR-0027 — every section it already had survives.
      expect(after).toContain('branch wave-orch/01-thing');
      expect(readSpine(after).planTable[0].state).toBe('planned');
    });

    it('add-disclosure is source-neutral — worker, reviewer and coordinator land identically', () => {
      const path = writeTmpSpine();
      for (const source of ['worker', 'reviewer', 'coordinator']) {
        expect(
          runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', source, '--text', `${source} saw it`]),
        ).toBe(0);
      }
      const after = readFileSync(path, 'utf-8');
      expect(after).toMatch(/\| 01\.1 \| 01 \| 1 \| worker \| open \|/);
      expect(after).toMatch(/\| 01\.2 \| 01 \| 1 \| reviewer \| open \|/);
      expect(after).toMatch(/\| 01\.3 \| 01 \| 1 \| coordinator \| open \|/);
    });

    it('add-disclosure with a missing flag → usage 2, nothing written', () => {
      const path = writeTmpSpine();
      const before = readFileSync(path, 'utf-8');
      expect(runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker'])).toBe(2);
      expect(runSpine(['add-disclosure', path, ROW_ID, '--source', 'worker', '--text', 't'])).toBe(2);
      expect(runSpine(['add-disclosure', path, '--iter', '1', '--source', 'worker', '--text', 't'])).toBe(2);
      // `--text` present but valueless (last token) is still a usage error.
      expect(runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text'])).toBe(2);
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('add-disclosure with a non-positive-integer --iter → usage 2 (fail loud)', () => {
      const path = writeTmpSpine();
      for (const bad of ['two', '0', '-1', '1.5']) {
        expect(
          runSpine(['add-disclosure', path, ROW_ID, '--iter', bad, '--source', 'worker', '--text', 't']),
        ).toBe(2);
      }
      expect(readFileSync(path, 'utf-8')).not.toContain('## Disclosures');
    });

    it('add-disclosure with an unknown --source or row id → domain exit 1, nothing written', () => {
      const path = writeTmpSpine();
      const before = readFileSync(path, 'utf-8');
      expect(
        runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'nobody', '--text', 't']),
      ).toBe(1);
      expect(
        runSpine(['add-disclosure', path, '99', '--iter', '1', '--source', 'worker', '--text', 't']),
      ).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('set-disposition updates exactly one entry', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '2', '--source', 'reviewer', '--text', 'gap B']);

      expect(runSpine(['set-disposition', path, '01.1', 'filed:#158'])).toBe(0);

      const after = readFileSync(path, 'utf-8');
      expect(after).toContain('| 01.1 | 01 | 1 | worker | filed:#158 | gap A |');
      expect(after).toContain('| 01.2 | 01 | 2 | reviewer | open | gap B |');
    });

    it('set-disposition refuses an unknown disposition LOUD — exit 1, nothing written', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      const before = readFileSync(path, 'utf-8');

      expect(runSpine(['set-disposition', path, '01.1', 'sorted-it-out'])).toBe(1);
      // `open` is the capture default, not a decision — refused too.
      expect(runSpine(['set-disposition', path, '01.1', 'open'])).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
      expect(readFileSync(path, 'utf-8')).toBe(before);
      expect(readFileSync(path, 'utf-8')).not.toContain('sorted-it-out');
    });

    it('set-disposition on an unknown ref → domain exit 1; missing args → usage 2', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      expect(runSpine(['set-disposition', path, '01.9', 'scope-extension'])).toBe(1);
      expect(runSpine(['set-disposition', path, '01.1'])).toBe(2);
      expect(runSpine(['set-disposition', path])).toBe(2);
    });

    // ── The fail-closed gate, proven to FAIL (Convention-11 spirit) ──────────
    it('check-disclosures: green → add → RED → disposition → green again', () => {
      const path = writeTmpSpine();

      // A spine with no Disclosures section at all is already clear.
      expect(runSpine(['check-disclosures', path])).toBe(0);
      expect(printed()).toContain('archive gate CLEAR');
      stdoutSpy.mockClear();

      // Capture one disclosure — the gate must now BLOCK.
      expect(
        runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gate 8 ships inert']),
      ).toBe(0);
      stdoutSpy.mockClear();

      expect(runSpine(['check-disclosures', path])).not.toBe(0);
      const blocked = printed();
      expect(blocked).toContain('archive gate BLOCKED');
      expect(blocked).toContain('01.1');
      expect(blocked).toContain('gate 8 ships inert');
      stdoutSpy.mockClear();

      // Disposition it — and the very same check flips green.
      expect(runSpine(['set-disposition', path, '01.1', 'filed:#158'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).toBe(0);
      expect(printed()).toContain('archive gate CLEAR');
    });

    it('check-disclosures stays RED while ANY entry is open, and `dropped:<reason>` clears it (the gate never judges quality)', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'reviewer', '--text', 'gap B']);

      expect(runSpine(['set-disposition', path, '01.1', 'resolved-in-slice'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).not.toBe(0); // 01.2 still open

      expect(runSpine(['set-disposition', path, '01.2', 'dropped:noise, not a gap'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).toBe(0);
      expect(readFileSync(path, 'utf-8')).toContain('dropped:noise, not a gap');
    });

    // ── The fifth disposition (ADR-0027 Amendment 2026-09-04) ───────────────
    //
    // A consumer's wave that finds a defect in the TOOLKIT has no honest exit
    // among the first four: `filed:<id>` names the consumer's own tracker, and
    // `dropped:<reason>` reads as discarded. `upstream:<ref>` says what
    // actually happened — handed to the toolkit's own tracker — and the gate
    // counts it exactly like the other terminal values.

    it('set-disposition accepts `upstream:<ref>`, including a colon-carrying URL ref, and writes it verbatim', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '2', '--source', 'reviewer', '--text', 'gap B']);

      expect(runSpine(['set-disposition', path, '01.1', 'upstream:683'])).toBe(0);
      expect(
        runSpine([
          'set-disposition', path, '01.2',
          'upstream:https://github.com/formtrieb/flotilla/issues/683',
        ]),
      ).toBe(0);

      const after = readFileSync(path, 'utf-8');
      expect(after).toContain('| 01.1 | 01 | 1 | worker | upstream:683 | gap A |');
      expect(after).toContain(
        '| 01.2 | 01 | 2 | reviewer | upstream:https://github.com/formtrieb/flotilla/issues/683 | gap B |',
      );
      // Parsed back byte-preserving — the ref's own colons change nothing.
      expect(readDisclosures(after).map((d) => d.disposition)).toEqual([
        'upstream:683',
        'upstream:https://github.com/formtrieb/flotilla/issues/683',
      ]);
    });

    it('set-disposition refuses an EMPTY `upstream:` ref — exit 1, nothing written, vocabulary named', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      const before = readFileSync(path, 'utf-8');

      expect(runSpine(['set-disposition', path, '01.1', 'upstream:'])).toBe(1);
      expect(runSpine(['set-disposition', path, '01.1', 'upstream: '])).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
      const said = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
      expect(said).toContain('invalid disposition');
      expect(said).toContain('upstream:<ref>');
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('check-disclosures counts `upstream:` as dispositioned — an open sibling still BLOCKS, the last one clears', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'plugin agent name is wrong']);
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'reviewer', '--text', 'DoR verify wording']);
      expect(runSpine(['check-disclosures', path])).not.toBe(0);

      expect(runSpine(['set-disposition', path, '01.1', 'upstream:683'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).not.toBe(0); // 01.2 still open

      expect(runSpine(['set-disposition', path, '01.2', 'upstream:683'])).toBe(0);
      stdoutSpy.mockClear();
      expect(runSpine(['check-disclosures', path])).toBe(0);
      expect(printed()).toContain('archive gate CLEAR');
    });

    it('the BLOCKED hint names all five values, upstream among them', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
      stdoutSpy.mockClear();
      expect(runSpine(['check-disclosures', path])).not.toBe(0);
      expect(printed()).toContain(
        'resolved-in-slice | scope-extension | filed:<id> | dropped:<reason> | upstream:<ref>',
      );
    });

    it('check-disclosures is fail-CLOSED on an unreadable spine (never a silent green)', () => {
      const code = runSpine(['check-disclosures', join(tmpdir(), 'no-such-spine-adr-0027.md')]);
      expect(code).not.toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
    });

    it('check-disclosures with no path → usage 2', () => {
      expect(runSpine(['check-disclosures'])).toBe(2);
    });

    // ── The wave-scoped form (ADR-0038), additive on the same op ─────────────
    //
    // `--wave` captures a find about the wave's own machinery: no <row-id>, no
    // `--iter`, everything downstream identical. The row-scoped spelling above
    // is unchanged, which is what makes this additive on the CLI contract
    // (ADR-0035) rather than a second, incompatible verb.

    it('add-disclosure --wave captures with no row and no iter, prints a `wave.<n>` ref, and flushes', () => {
      const path = writeTmpSpine();
      const code = runSpine([
        'add-disclosure', path, '--wave',
        '--source', 'coordinator',
        '--text', 'the phase-3 sweep left an errored worktree still listed',
      ]);
      expect(code).toBe(0);
      expect(printed().trim()).toBe('wave.1');

      const after = readFileSync(path, 'utf-8');
      expect(after).toContain(
        `| wave.1 | wave | ${WAVE_SCOPE_ITER_CELL} | coordinator | open | the phase-3 sweep left an errored worktree still listed |`,
      );
      // The fixture predates ADR-0027 — the section grew, everything else held.
      expect(after).toContain('branch wave-orch/01-thing');
      expect(readSpine(after).planTable[0].state).toBe('planned');
      // A second wave-scoped capture continues the same 1-based sequence.
      expect(runSpine(['add-disclosure', path, '--wave', '--source', 'reviewer', '--text', 'another'])).toBe(0);
      expect(readDisclosures(readFileSync(path, 'utf-8')).map((d) => d.ref)).toEqual([
        'wave.1', 'wave.2',
      ]);
    });

    it('add-disclosure --wave refuses the MIXED spellings — a <row-id> or an --iter beside it is usage 2, nothing written', () => {
      const path = writeTmpSpine();
      const before = readFileSync(path, 'utf-8');
      // A positional row id alongside --wave: which scope did the operator mean?
      expect(
        runSpine(['add-disclosure', path, ROW_ID, '--wave', '--source', 'worker', '--text', 't']),
      ).toBe(2);
      // An --iter alongside --wave: a wave-scoped find comes out of no dispatch.
      expect(
        runSpine(['add-disclosure', path, '--wave', '--iter', '1', '--source', 'worker', '--text', 't']),
      ).toBe(2);
      // Both halves of the shared arg pair are still required.
      expect(runSpine(['add-disclosure', path, '--wave', '--source', 'worker'])).toBe(2);
      expect(runSpine(['add-disclosure', path, '--wave', '--text', 't'])).toBe(2);
      expect(stderrSpy).toHaveBeenCalled();
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('a `--text` whose VALUE is "--wave" stays row-scoped — the mode switch reads flags, not data', () => {
      // `args.includes('--wave')` would silently discard the operator's row
      // scope here. Disclosure text is free prose lifted from an agent report,
      // so this is data the parser must step over, not a mode switch.
      const path = writeTmpSpine();
      expect(
        runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', '--wave']),
      ).toBe(0);
      expect(printed().trim()).toBe('01.1');
      expect(readFileSync(path, 'utf-8')).toContain('| 01.1 | 01 | 1 | worker | open | --wave |');
    });

    it('add-disclosure --wave on a spine whose Plan-Table took the `wave` id → domain exit 1, nothing written', () => {
      // The sentinel shares the ref namespace with a row of the same id, so the
      // store refuses rather than mint a ref whose scope cannot be read back.
      const dir = mkdtempSync(join(tmpdir(), 'spine-cli-wave-'));
      const path = join(dir, 'WAVE.md');
      writeFileSync(path, FIXTURE.replace(/\| 01 {2}\|/, '| wave |'), 'utf-8');
      const before = readFileSync(path, 'utf-8');

      expect(runSpine(['add-disclosure', path, '--wave', '--source', 'coordinator', '--text', 't'])).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
      expect(readFileSync(path, 'utf-8')).toBe(before);
    });

    it('the archive gate counts a wave-scoped entry identically: open BLOCKS, a terminal disposition clears', () => {
      const path = writeTmpSpine();
      expect(runSpine(['check-disclosures', path])).toBe(0);
      stdoutSpy.mockClear();

      expect(
        runSpine(['add-disclosure', path, '--wave', '--source', 'coordinator', '--text', 'the sweep left residue']),
      ).toBe(0);
      stdoutSpy.mockClear();

      // A wave-scoped entry blocks on its own — no row-scoped entry in sight.
      expect(runSpine(['check-disclosures', path])).not.toBe(0);
      const blocked = printed();
      expect(blocked).toContain('archive gate BLOCKED');
      expect(blocked).toContain('wave.1');
      expect(blocked).toContain('the sweep left residue');
      // The blocked line prints the house marker, never a bare `null`.
      expect(blocked).toContain(`iter ${WAVE_SCOPE_ITER_CELL}`);
      expect(blocked).not.toContain('iter null');
      stdoutSpy.mockClear();

      // The SAME disposition verb, addressed by the ref the capture printed.
      expect(runSpine(['set-disposition', path, 'wave.1', 'filed:#487'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).toBe(0);
      expect(printed()).toContain('archive gate CLEAR');
    });

    it('a row-scoped and a wave-scoped entry block the same gate together, and each clears independently', () => {
      const path = writeTmpSpine();
      runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'row gap']);
      runSpine(['add-disclosure', path, '--wave', '--source', 'coordinator', '--text', 'wave gap']);

      expect(runSpine(['set-disposition', path, '01.1', 'resolved-in-slice'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).not.toBe(0); // wave.1 still open
      expect(runSpine(['set-disposition', path, 'wave.1', 'dropped:measured, no defect'])).toBe(0);
      expect(runSpine(['check-disclosures', path])).toBe(0);

      const after = readFileSync(path, 'utf-8');
      expect(after).toContain('| 01.1 | 01 | 1 | worker | resolved-in-slice | row gap |');
      expect(after).toContain(
        `| wave.1 | wave | ${WAVE_SCOPE_ITER_CELL} | coordinator | dropped:measured, no defect | wave gap |`,
      );
    });

    it('create renders the Disclosures section into a FRESH spine (ADR-0027)', () => {
      const writes: Record<string, string> = {};
      const payload = JSON.stringify({
        meta: { slug: 'demo', description: 'd', coordinator: 'at', model: 'Opus 4.8', created: '2026-07-28', lastUpdated: '2026-07-28 10:00' },
        roster: [{ id: '156', title: 'T', worker: 'background', risk: 'public-API-change' }],
        conflict: { issues: [], cells: [] },
        dorCheck: 'all pass.',
      });
      const io = {
        read: () => payload,
        write: (p: string, c: string) => { writes[p] = c; },
      };
      expect(runSpine(['create', 'out/WAVE.md', 'payload.json'], io)).toBe(0);
      const source = writes['out/WAVE.md'];
      expect(source).toContain('## Disclosures');
      expect(source).toContain('| Ref | Row | Iter | Source | Disposition | Text |');
      // Still a fully-parseable spine, and the new section is empty (gate clear).
      expect(readSpine(source).planTable).toHaveLength(1);
      expect(readDisclosures(source)).toEqual([]);
    });
  });
});

// ─── `--json` receipts on the seven silent writes (ADR-0051 decision 7) ───────
//
// Seven ops write and say nothing: set-row-state, set-row-iter, set-row-pr,
// set-branch, set-status, set-disposition, replace-closed-by. The Coordinator
// runs them in every routing step and every close and read their success from
// the exit code alone. With `--json` each now prints exactly one receipt of
// WHAT IT WROTE — never a re-read of the spine.
//
// Every shape below is CONTRACT FROM LANDING (ADR-0035): these assertions are
// the pin, so a later change to a key name or a value is a spec failure rather
// than a silent break of a Coordinator that parses them.

describe('spine-cli — `--json` receipts on the silent writes (ADR-0051 decision 7)', () => {
  let stdoutOut = '';
  let stderrOut = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutOut = '';
    stderrOut = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutOut += String(c);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrOut += String(c);
      return true;
    });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Run one op and hand back everything an operator can observe. */
  function run(args: string[]): { code: number; stdout: string; stderr: string } {
    stdoutOut = '';
    stderrOut = '';
    const code = runSpine(args);
    return { code, stdout: stdoutOut, stderr: stderrOut };
  }

  /** The single JSON object an op printed, parsed. Fails loud on anything else. */
  function receiptOf(out: string): Record<string, unknown> {
    expect(out.endsWith('\n'), 'a receipt is one JSON object plus a newline').toBe(true);
    return JSON.parse(out) as Record<string, unknown>;
  }

  // ── The seven shapes, one test each ──────────────────────────────────────

  it('set-row-state prints { op, spine, id, written: { state } }', () => {
    const path = writeTmpSpine();
    const { code, stdout } = run(['set-row-state', path, ROW_ID, NEW_STATE, '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'set-row-state',
      spine: resolve(path),
      id: ROW_ID,
      written: { state: NEW_STATE },
    });
    // …and the write it reports genuinely landed.
    expect(readSpine(readFileSync(path, 'utf-8')).planTable[0].state).toBe(NEW_STATE);
  });

  it('set-row-iter prints { op, spine, id, written: { iter } } — the number, not the argv string', () => {
    const path = writeTmpSpine();
    const { code, stdout } = run(['set-row-iter', path, ROW_ID, '2', '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'set-row-iter',
      spine: resolve(path),
      id: ROW_ID,
      written: { iter: 2 },
    });
    expect(readSpine(readFileSync(path, 'utf-8')).planTable[0].iter).toBe(2);
  });

  it('set-row-pr prints the cell AS WRITTEN — a preserved title included, never a re-parse', () => {
    // The acceptance criterion this row was written for. A PR cell carries a
    // rendered link AND the row's own title; a receipt that re-read the spine
    // would report the parser's idea of that cell instead of the caller's.
    const path = writeTmpSpine();
    const CELL = '[#42](https://github.com/formtrieb/flotilla/pull/42) — the row\'s own title';
    const { code, stdout } = run(['set-row-pr', path, ROW_ID, CELL, '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'set-row-pr',
      spine: resolve(path),
      id: ROW_ID,
      written: { pr: CELL },
    });
    // The receipt's own value, read back off the SPINE LINE the op wrote: the
    // two agree, which is what makes "as written" a claim and not a slogan.
    expect(readSpine(readFileSync(path, 'utf-8')).planTable[0].prCell).toBe(CELL);
  });

  it('the PR receipt is the CALLER\'s own string, even where the spine\'s BYTES differ from it', () => {
    // A PR cell carries a row title, which is free text off the tracker, so it
    // can hold a literal `|`. The byte-preserving writer escapes that to the
    // fullwidth `｜` before it can split the markdown row. The receipt reports
    // what the CALLER handed over — the `|` the Coordinator can compare against
    // its own argv — and not the spine's bytes.
    const path = writeTmpSpine();
    const CELL = '[#42](https://example.test/pull/42) — a title | with a pipe';
    const { code, stdout } = run(['set-row-pr', path, ROW_ID, CELL, '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout).written).toEqual({ pr: CELL });

    // The spine's own bytes, for contrast: escaped, and NOT what the receipt says.
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('— a title ｜ with a pipe');
    expect(raw).not.toContain('— a title | with a pipe');
    // The reader is the writer's inverse for a pipe, so a PARSED read-back
    // happens to agree with the receipt on this input.
    expect(readSpine(raw).planTable[0].prCell).toBe(CELL);

    // One input where it does NOT agree, and therefore the one that tells a
    // receipt from a re-parse by value: a PADDED cell. The writer keeps the
    // caller's spaces inside the cell; the reader trims every cell it parses.
    // The receipt still says what the caller wrote.
    const padded = writeTmpSpine();
    const PADDED_CELL = '  pr 42 landed  ';
    expect(run(['set-row-pr', padded, ROW_ID, PADDED_CELL, '--json']).code).toBe(0);
    expect(receiptOf(stdoutOut).written).toEqual({ pr: PADDED_CELL });
    expect(readSpine(readFileSync(padded, 'utf-8')).planTable[0].prCell).toBe('pr 42 landed');
  });

  it('a receipt costs NO extra read of the spine — the write is not re-read to describe itself', () => {
    // The pin for "what was written, never a re-read of the spine", made
    // mechanically rather than by comparing two strings that a lossless
    // round-trip keeps equal. `createSpineStore` reads the file exactly once at
    // construction; a receipt built by re-reading (or by `store.reload()`)
    // would make it twice. The injected SpineIo counts.
    const source = FIXTURE;
    const reads: string[] = [];
    const writes: string[] = [];
    const io = {
      read: (p: string) => {
        reads.push(p);
        return source;
      },
      write: (p: string) => {
        writes.push(p);
      },
    };
    stdoutOut = '';
    expect(runSpine(['set-row-pr', 'WAVE.md', ROW_ID, '#42', '--json'], io)).toBe(0);
    expect(reads).toEqual(['WAVE.md']);
    expect(writes).toEqual(['WAVE.md']);
    expect(receiptOf(stdoutOut).written).toEqual({ pr: '#42' });

    // The same for the one op that bypasses the store entirely (`set-row-iter`
    // writes through wave-md-rw directly): one read, one write, one receipt.
    reads.length = 0;
    writes.length = 0;
    stdoutOut = '';
    expect(runSpine(['set-row-iter', 'WAVE.md', ROW_ID, '3', '--json'], io)).toBe(0);
    expect(reads).toEqual(['WAVE.md']);
    expect(writes).toEqual(['WAVE.md']);
    expect(receiptOf(stdoutOut).written).toEqual({ iter: 3 });
  });

  // ── the store seam: the as-written claim, made falsifiable ─────────────────
  //
  // The two pins above each have a stated blind spot, and both are about the
  // SAME hole. The io counter proves no second FILE read happened — a re-parse
  // routed through `store.spine()` reads no file, so it cannot see one. The
  // value comparison separates a receipt from a re-parse only on an input where
  // the reader is not the writer's inverse (the padded cell, whose spaces the
  // parser trims); on an ORDINARY unpadded, pipe-free cell the two agree, and
  // agreement is not evidence.
  //
  // `runSpine`'s third parameter is the store seam that closes both. The cell
  // below is deliberately the easy case — no padding, no pipe, nothing the
  // round-trip would alter — so the ONLY thing separating "what the caller
  // wrote" from "what the spine now parses as" is the substituted store.
  const ORDINARY_CELL = '[#42](https://example.test/pull/42) — a plain title';

  /**
   * A store that writes for real and refuses to be READ.
   *
   * Every accessor a re-parse could reach — the parsed spine, the source, the
   * per-row state, the dispatch-log join, the disclosure readers — throws.
   * `setRowPrCell` and `flush` delegate untouched, because the write must still
   * land: a pin that proves the receipt by breaking the write would prove
   * nothing. Internal calls inside the real store go to the target directly
   * (`spineStoreFromSource` closes over its own `src`), so `flush()` is
   * unaffected by the trap in front of it.
   */
  const REPARSE_TRIPWIRE = 'tripwire: the receipt read the spine back';
  const READ_BACK_METHODS = [
    'spine',
    'source',
    'reload',
    'rowState',
    'branchesByIssueId',
    'disclosures',
    'openDisclosures',
  ];
  function throwOnRead(real: SpineStore): SpineStore {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (READ_BACK_METHODS.includes(String(prop))) {
          return () => {
            throw new Error(`${REPARSE_TRIPWIRE} (${String(prop)})`);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /** The same seam, used the other way: readers that answer, and answer WRONG. */
  function lieOnRead(real: SpineStore): SpineStore {
    const LIE = 'a cell the caller never wrote';
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'spine') {
          return () => {
            const parsed = real.spine();
            return {
              ...parsed,
              planTable: parsed.planTable.map((r) => ({ ...r, prCell: LIE })),
            };
          };
        }
        if (prop === 'source') return () => LIE;
        if (prop === 'rowState') return () => LIE;
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it('a store whose every read THROWS still yields the receipt — so nothing read the spine to build it', () => {
    const path = writeTmpSpine();
    stdoutOut = '';
    stderrOut = '';

    const code = runSpine(
      ['set-row-pr', path, ROW_ID, ORDINARY_CELL, '--json'],
      defaultSpineIo(),
      (p, io) => throwOnRead(createSpineStore(p, io)),
    );

    // Had anything re-read the spine to compose the receipt, the tripwire would
    // have thrown into the runner's catch: exit 1, empty stdout, the message on
    // stderr. All three of the next assertions would fail.
    expect(code).toBe(0);
    expect(stderrOut).toBe('');
    expect(receiptOf(stdoutOut)).toEqual({
      op: 'set-row-pr',
      spine: resolve(path),
      id: ROW_ID,
      written: { pr: ORDINARY_CELL },
    });
    // The write itself landed — the trap sits only in front of the readers.
    expect(readSpine(readFileSync(path, 'utf-8')).planTable[0].prCell).toBe(ORDINARY_CELL);
  });

  it('a store whose reads LIE is not believed — the receipt is still the caller\'s own string', () => {
    // The throwing store proves no read happened. This one proves what the
    // receipt would have said if one had: on this ordinary cell a re-parse is
    // indistinguishable by value, unless the thing being re-parsed disagrees.
    const path = writeTmpSpine();
    stdoutOut = '';

    const code = runSpine(
      ['set-row-pr', path, ROW_ID, ORDINARY_CELL, '--json'],
      defaultSpineIo(),
      (p, io) => lieOnRead(createSpineStore(p, io)),
    );

    expect(code).toBe(0);
    expect(receiptOf(stdoutOut).written).toEqual({ pr: ORDINARY_CELL });
    expect(JSON.stringify(receiptOf(stdoutOut))).not.toContain('a cell the caller never wrote');
  });

  it('the trap is ARMED — the same store makes a read-back path fail loudly', () => {
    // The control for the two cases above: a store that throws on every read is
    // only evidence if such a read really would blow up. `spine read` is the one
    // op whose whole job is `store.source()`, and it goes through the same seam.
    const path = writeTmpSpine();
    stdoutOut = '';
    stderrOut = '';

    const code = runSpine(['read', path], defaultSpineIo(), (p, io) =>
      throwOnRead(createSpineStore(p, io)),
    );

    expect(code).toBe(1);
    expect(stdoutOut).toBe('');
    expect(stderrOut).toContain(REPARSE_TRIPWIRE);
  });

  it('set-branch prints { branch }, and { branch, model } only when --model was passed', () => {
    const bare = writeTmpSpine();
    expect(run(['set-branch', bare, ROW_ID, 'wave/01-thing', '--json']).stdout).toBe(
      JSON.stringify(
        { op: 'set-branch', spine: resolve(bare), id: ROW_ID, written: { branch: 'wave/01-thing' } },
        null,
        2,
      ) + '\n',
    );

    const withModel = writeTmpSpine();
    const { code, stdout } = run([
      'set-branch', withModel, ROW_ID, 'wave/01-thing', '--model', 'claude-opus-4-8', '--json',
    ]);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'set-branch',
      spine: resolve(withModel),
      id: ROW_ID,
      written: { branch: 'wave/01-thing', model: 'claude-opus-4-8' },
    });
    // No `model` KEY at all on the bare call — not `model: null`, which would be
    // a claim about a dispatch-log line that call never wrote.
    expect(
      Object.keys(
        (receiptOf(run(['set-branch', writeTmpSpine(), ROW_ID, 'b', '--json']).stdout)
          .written) as Record<string, unknown>,
      ),
    ).toEqual(['branch']);
  });

  it('set-status prints { op, spine, written: { status } } and carries NO id (frontmatter, not a row)', () => {
    const path = writeTmpSpine();
    const { code, stdout } = run(['set-status', path, 'ready', '--json']);
    expect(code).toBe(0);
    const receipt = receiptOf(stdout);
    expect(receipt).toEqual({
      op: 'set-status',
      spine: resolve(path),
      written: { status: 'ready' },
    });
    expect('id' in receipt).toBe(false);
    expect(readSpine(readFileSync(path, 'utf-8')).frontmatter.status).toBe('ready');
  });

  it('set-disposition prints { op, spine, written: { ref, disposition } }', () => {
    const path = writeTmpSpine();
    runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
    const { code, stdout } = run(['set-disposition', path, '01.1', 'filed:#158', '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'set-disposition',
      spine: resolve(path),
      written: { ref: '01.1', disposition: 'filed:#158' },
    });
    expect(readFileSync(path, 'utf-8')).toContain('| 01.1 | 01 | 1 | worker | filed:#158 | gap A |');
  });

  it('replace-closed-by prints { op, spine, written: { bodyBytes } } — the section\'s size, in UTF-8 bytes', () => {
    const path = writeTmpSpine();
    const dir = mkdtempSync(join(tmpdir(), 'spine-cli-receipt-body-'));
    const bodyFile = join(dir, 'closed-by.md');
    // Multi-line, and with a non-ASCII character, so a byte count and a
    // code-unit count genuinely differ (`—` is 3 bytes, 1 code unit).
    const body = 'Closed by PR #42 — merged 2026-09-16.\nRow 01 landed.';
    writeFileSync(bodyFile, body, 'utf-8');

    const { code, stdout } = run(['replace-closed-by', path, bodyFile, '--json']);
    expect(code).toBe(0);
    expect(receiptOf(stdout)).toEqual({
      op: 'replace-closed-by',
      spine: resolve(path),
      written: { bodyBytes: Buffer.byteLength(body, 'utf-8') },
    });
    // Non-vacuity: the pin above would also pass on a code-unit count if the
    // body were pure ASCII. It is not.
    expect(Buffer.byteLength(body, 'utf-8')).not.toBe(body.length);
    expect(readFileSync(path, 'utf-8')).toContain('Closed by PR #42 — merged 2026-09-16.');
  });

  // ── The negative controls ────────────────────────────────────────────────

  it('WITHOUT --json every one of the seven prints nothing at all — byte-identical to before', () => {
    // The default-output pin. Each op is run on its own fresh spine, in the
    // spelling the skills actually use, and stdout is compared to the empty
    // string — not merely "no JSON".
    const bodyDir = mkdtempSync(join(tmpdir(), 'spine-cli-silent-body-'));
    const bodyFile = join(bodyDir, 'closed-by.md');
    writeFileSync(bodyFile, 'Closed by PR #42.', 'utf-8');

    const calls: readonly (readonly string[])[] = [
      ['set-row-state', '@', ROW_ID, NEW_STATE],
      ['set-row-iter', '@', ROW_ID, '2'],
      ['set-row-pr', '@', ROW_ID, '#42'],
      ['set-branch', '@', ROW_ID, 'wave/01-thing'],
      ['set-branch', '@', ROW_ID, 'wave/01-thing', '--model', 'claude-opus-4-8'],
      ['set-status', '@', 'ready'],
      ['replace-closed-by', '@', bodyFile],
    ];

    for (const call of calls) {
      const path = writeTmpSpine();
      const { code, stdout } = run(call.map((a) => (a === '@' ? path : a)));
      expect(code, `\`${call[0]}\` no longer exits 0`).toBe(0);
      expect(stdout, `\`${call[0]}\` printed something without --json`).toBe('');
    }

    // set-disposition needs a disclosure to address, so it gets its own spine.
    const path = writeTmpSpine();
    runSpine(['add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'gap A']);
    const { code, stdout } = run(['set-disposition', path, '01.1', 'scope-extension']);
    expect(code).toBe(0);
    expect(stdout).toBe('');
  });

  it('a REFUSED write prints no receipt, even with --json — usage 2 and domain 1 alike', () => {
    const path = writeTmpSpine();
    const before = readFileSync(path, 'utf-8');

    // Usage 2 — the state token is refused at the CLI boundary.
    const badState = run(['set-row-state', path, ROW_ID, 'not-a-real-state', '--json']);
    expect(badState.code).toBe(2);
    expect(badState.stdout).toBe('');

    // Domain 1 — the row id is unknown, so the mutator throws before the flush.
    const badRow = run(['set-row-state', path, '99', NEW_STATE, '--json']);
    expect(badRow.code).toBe(1);
    expect(badRow.stdout).toBe('');

    // The same, one op along: a refused disposition is exit 1 and silent.
    const badDisposition = run(['set-disposition', path, '01.1', 'sorted-it-out', '--json']);
    expect(badDisposition.code).toBe(1);
    expect(badDisposition.stdout).toBe('');

    // Nothing was written by any of the three.
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('exit codes are unchanged by --json — the flag adds stdout and nothing else', () => {
    // Pairwise: the same call with and without the flag, on its own spine.
    const cases: readonly (readonly [string[], number])[] = [
      [['set-row-state', '@', ROW_ID, NEW_STATE], 0],
      [['set-row-state', '@', ROW_ID, 'not-a-real-state'], 2],
      [['set-row-state', '@', '99', NEW_STATE], 1],
      [['set-row-iter', '@', ROW_ID, '2'], 0],
      [['set-row-iter', '@', ROW_ID, 'two'], 2],
      [['set-row-iter', '@', '99', '2'], 1],
      [['set-status', '@', 'ready'], 0],
      [['set-status', '@', 'reddy'], 2],
      [['set-branch', '@', ROW_ID], 2],
    ];
    for (const [call, expected] of cases) {
      const bare = run(call.map((a) => (a === '@' ? writeTmpSpine() : a)));
      const json = run([...call.map((a) => (a === '@' ? writeTmpSpine() : a)), '--json']);
      expect(bare.code, `\`${call.join(' ')}\` changed exit code`).toBe(expected);
      expect(json.code, `\`${call.join(' ')} --json\` changed exit code`).toBe(expected);
    }
  });

  it('a `--text` whose VALUE is "--json" is prose — the receipt switch reads flags, not data', () => {
    // The same class the `--wave` step-over closes: disclosure text is free
    // prose lifted from an agent's report, so the parser must step over it.
    const path = writeTmpSpine();
    const { code, stdout } = run([
      'add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', '--json',
    ]);
    expect(code).toBe(0);
    // `add-disclosure` prints its minted ref (it was never one of the seven),
    // and nothing else — no receipt was switched on by the text.
    expect(stdout).toBe('01.1\n');
    expect(readFileSync(path, 'utf-8')).toContain('| 01.1 | 01 | 1 | worker | open | --json |');
  });

  it('the receipt reaches an operator through the ROUTER too (Convention 9 wiring)', () => {
    // `main(['spine', …])` is the spelling the skills use; the router forwards
    // argv verbatim, and this is the assertion that says so for `--json`.
    const viaRouterPath = writeTmpSpine();
    stdoutOut = '';
    expect(main(['spine', 'set-row-state', viaRouterPath, ROW_ID, NEW_STATE, '--json'])).toBe(0);
    const viaRouter = stdoutOut;

    const directPath = writeTmpSpine();
    const direct = run(['set-row-state', directPath, ROW_ID, NEW_STATE, '--json']);

    expect(JSON.parse(viaRouter)).toEqual({
      ...(JSON.parse(direct.stdout) as Record<string, unknown>),
      spine: resolve(viaRouterPath),
    });
  });

  // ── The advertised shape ─────────────────────────────────────────────────

  it('every one of the seven NAMES its receipt shape in its own usage line (`--help`)', () => {
    const expected: Readonly<Record<string, string>> = {
      'set-row-state': '{ op, spine, id, written: { state } }',
      'set-row-iter': '{ op, spine, id, written: { iter } }',
      'set-row-pr': '{ op, spine, id, written: { pr } }',
      'set-branch': '{ op, spine, id, written: { branch, model? } }',
      'set-status': '{ op, spine, written: { status } }',
      'set-disposition': '{ op, spine, written: { ref, disposition } }',
      'replace-closed-by': '{ op, spine, written: { bodyBytes } }',
    };
    for (const [op, shape] of Object.entries(expected)) {
      const { code, stdout } = run([op, '--help']);
      expect(code, `\`spine ${op} --help\` did not exit 0`).toBe(0);
      expect(stdout, `\`spine ${op}\` does not name its receipt shape`).toContain(shape);
      expect(stdout).toContain('--json');
      // And it says what the DEFAULT still is, on the same surface.
      expect(stdout).toContain('prints nothing');
      // The continuation sentence, pinned WHOLE and capital-first (issue #758):
      // the roster folds this line onto the receipt line with a single space,
      // so a lowercase `without it` runs straight out of the shape braces
      // instead of opening a sentence. No spec held the wording before.
      expect(stdout).toContain('Without it this op prints nothing, exactly as before.');
    }
  });

  it('an op with no receipt keeps its one-line usage — the second line is not blanket text', () => {
    // `read` is a product, `check-disclosures` a gate, `add-disclosure` already
    // prints its ref: none of the three is a silent write, and none may
    // advertise a receipt it does not emit.
    for (const op of ['read', 'check-disclosures', 'add-disclosure']) {
      const { stdout } = run([op, '--help']);
      expect(stdout, `\`spine ${op}\` advertises a receipt it does not print`).not.toContain(
        'one receipt on stdout',
      );
    }
  });

  it('the seven ops that advertise a receipt are exactly the seven that print one', () => {
    // Derived from the contracts at RUNTIME, never transcribed: an op added to
    // the receipt table without a receipt (or the reverse) fails here by name.
    const advertised = Object.entries(SPINE_CONTRACTS)
      .filter(([, c]) => c.usage.some((l) => l.includes('one receipt on stdout')))
      .map(([op]) => op)
      .sort();
    expect(advertised).toEqual(
      [
        'replace-closed-by',
        'set-branch',
        'set-disposition',
        'set-row-iter',
        'set-row-pr',
        'set-row-state',
        'set-status',
      ].sort(),
    );
    // Every advertised op declares the `silent-write` output class — the class
    // ADR-0051 row V1 introduced and this row gives meaning to.
    for (const op of advertised) {
      expect(SPINE_CONTRACTS[op].output, `\`spine ${op}\` is not a silent write`).toBe(
        'silent-write',
      );
    }
  });
});

// ─── Convention 9 wiring: the new verbs are reachable through the ROUTER ──────
//
// An engine-complete-but-CLI-unreachable landing is the exact class this repo
// has hit before (the `arm --delete-branch` precedent). `cli.ts`'s `spine` case
// forwards argv verbatim, so these specs pin the whole path — `main(['spine',
// …])`, not `runSpine(…)` — end to end against a real file on disk.

describe('cli.ts routes the disclosure verbs (ADR-0027 wiring)', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('add-disclosure → check (RED) → set-disposition → check (green), all via main([\'spine\', …])', () => {
    const path = writeTmpSpine();

    expect(main(['spine', 'add-disclosure', path, ROW_ID, '--iter', '1', '--source', 'worker', '--text', 'wiring gap'])).toBe(0);
    expect(readFileSync(path, 'utf-8')).toContain('| 01.1 | 01 | 1 | worker | open | wiring gap |');

    expect(main(['spine', 'check-disclosures', path])).not.toBe(0);
    expect(main(['spine', 'set-disposition', path, '01.1', 'scope-extension'])).toBe(0);
    expect(main(['spine', 'check-disclosures', path])).toBe(0);
  });

  it('the router surfaces the same exit codes as the direct runner', () => {
    const path = writeTmpSpine();
    expect(main(['spine', 'set-disposition', path, '01.1', 'nonsense'])).toBe(
      runSpine(['set-disposition', path, '01.1', 'nonsense']),
    );
    expect(main(['spine', 'add-disclosure', path, ROW_ID, '--iter', 'x', '--source', 'worker', '--text', 't'])).toBe(2);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('the router usage text advertises the three new ops', () => {
    expect(main([])).toBe(2);
    const usage = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(usage).toContain('spine add-disclosure');
    expect(usage).toContain('spine set-disposition');
    expect(usage).toContain('spine check-disclosures');
  });

  it('the WAVE-SCOPED form reaches the store through the router too, and the gate answers on it (ADR-0038)', () => {
    // Same Convention-9 wiring claim as the row-scoped path above: engine-
    // complete but router-unreachable is the class this repo has already paid
    // for, so the whole path is pinned — `main(['spine', …])`, not `runSpine`.
    const path = writeTmpSpine();

    expect(main(['spine', 'add-disclosure', path, '--wave', '--source', 'coordinator', '--text', 'sweep residue'])).toBe(0);
    expect(readFileSync(path, 'utf-8')).toContain(
      `| wave.1 | wave | ${WAVE_SCOPE_ITER_CELL} | coordinator | open | sweep residue |`,
    );

    expect(main(['spine', 'check-disclosures', path])).not.toBe(0);
    expect(main(['spine', 'set-disposition', path, 'wave.1', 'scope-extension'])).toBe(0);
    expect(main(['spine', 'check-disclosures', path])).toBe(0);

    // The mixed spelling is refused identically through the router.
    expect(main(['spine', 'add-disclosure', path, '--wave', '--iter', '1', '--source', 'worker', '--text', 't'])).toBe(2);
  });

  it('the router usage advertises BOTH capture forms on the one op', () => {
    // Issue #758 re-pin: the roster line is now RENDERED from this op's
    // contract, so the two forms are no longer two hand-written spellings
    // printed side by side — they are one signature in which the row slot is
    // bracketed (the arity's `min: 1`, the wave-scoped form's floor) and the
    // wave-scoped switch is an optional flag. Both forms are still reachable
    // from the one line, which is what this test has always been about.
    expect(main([])).toBe(2);
    const usage = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    const line = usage.split('\n').find((l: string) => l.includes('spine add-disclosure'))!;
    expect(line).toBeDefined();
    // The row-scoped spelling: the optional row slot plus its iteration flag…
    expect(line).toContain('spine add-disclosure <spine-path> [<row-id>]');
    expect(line).toContain('[--iter <n>]');
    // …and the wave-scoped one beside it, not instead of it.
    expect(line).toContain('[--wave-scoped]');
    // The op's OWN contract section still spells the alternation out in full —
    // the roster names every flag, the contract teaches which go together.
    expect(main(['spine', 'add-disclosure', '--help'])).toBe(0);
    expect(stdoutSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toContain(
      'spine add-disclosure <spine-path> (<row-id> --iter <n> | --wave-scoped)',
    );
  });
});

// ─── the standalone path, collapsed onto the router (issue #77) ──────────────
//
// `cli.ts` has always ALSO routed `spine` to `runSpine`, which left two ways
// into one runner. The direct-run block at the bottom of spine-cli.ts no longer
// dispatches on its own: it forwards `process.argv` to `main(['spine', …])`, so
// there is exactly ONE dispatch path in the engine and `npx tsx
// tools/wave/src/spine-cli.ts <op> …` survives as a documented alias (the
// `wave-close` mechanics still spell it that way).
//
// That forwarding lives inside `require.main === module`, which no in-process
// spec can execute — so the alias is covered here by actually SPAWNING the
// module, the only way to prove the collapsed path still works end to end.

describe('spine-cli — the direct-module invocation is collapsed onto the router `spine` case', () => {
  const TSX = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const SPINE_CLI = join(__dirname, 'spine-cli.ts');

  /** Spawn `tsx spine-cli.ts <args>`; returns stdout/stderr/exit code. */
  function runAlias(args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(TSX, [SPINE_CLI, ...args], {
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        code: typeof e.status === 'number' ? e.status : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
      };
    }
  }

  it('a `read` through the alias still prints the spine and exits 0', () => {
    const path = writeTmpSpine();
    const { code, stdout } = runAlias(['read', path]);
    expect(code).toBe(0);
    expect(stdout).toContain('## Plan-Table');
    expect(stdout).toContain('Wave 2026-06-06 — test');
  });

  it('a mutating op through the alias still writes to disk and exits 0', () => {
    const path = writeTmpSpine();
    const { code } = runAlias(['set-row-state', path, ROW_ID, NEW_STATE]);
    expect(code).toBe(0);
    const after = readFileSync(path, 'utf-8');
    expect(after).toMatch(/\| dispatched \|/);
    // Surrounding sections are byte-preserved — the forwarding changed the
    // dispatch path, not the byte-preserving writer behind it.
    expect(after).toContain('## Resume-Metadata');
    expect(after).toContain('branch wave-orch/01-thing');
  });

  it('an unknown op through the alias still reports spine-cli\'s own dispatch table and exits 2', () => {
    const path = writeTmpSpine();
    const { code, stderr } = runAlias(['frobnicate', path]);
    expect(code).toBe(2);
    // The forwarding hands the op to `runSpine`, so the message is this
    // module's `default:` case — never the router's unknown-SUBCOMMAND error.
    expect(stderr).toMatch(/unknown op: frobnicate/);
    expect(stderr).not.toMatch(/unknown subcommand/);
  });

  it('the router case it forwards to is byte-identical to calling runSpine in-process', () => {
    const path = writeTmpSpine();
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out += String(c);
      return true;
    });
    try {
      const routerCode = main(['spine', 'read', path]);
      const routerOut = out;

      out = '';
      const directCode = runSpine(['read', path]);

      expect(routerCode).toBe(0);
      expect(routerCode).toBe(directCode);
      expect(routerOut).toBe(out);
      expect(routerOut).toContain('## Plan-Table');
    } finally {
      spy.mockRestore();
    }
  });

  it('the human lane reaches the standalone entrypoint too — the gate BLOCKS through the alias', () => {
    // The fold's end-to-end claim, on the one path no in-process spec can
    // execute. `check-awaiting-human` is the gate wave-close phase 6 runs, so a
    // spawn is the only proof that the whole documented spelling — argv →
    // direct-run block → router → spine-cli's table — still produces the
    // fail-closed exit an operator branches on.
    const path = writeHumanLaneSpine();
    const { code, stdout } = runAlias(['check-awaiting-human', path]);
    expect(code).toBe(1);
    expect(stdout).toContain('archive gate BLOCKED');
    // The gate cites the archive phase reference — the doc that actually
    // describes it — never ADR-0012 (which establishes the Worker vocabulary
    // and never mentions an archive gate at all).
    expect(stdout).toContain('.claude/skills/wave-close/reference/phase-6-archive.md');
    expect(stdout).not.toContain('ADR-0012');
    expect(stdout).toContain('row 11');

    const listing = runAlias(['human-gated', path]);
    expect(listing.code).toBe(0);
    expect(JSON.parse(listing.stdout).awaitingHumanIds).toEqual(['11']);
  });
});

// ─── ADR-0012 archive-gate miscitation, fixed scoped (issue #373) ────────────
//
// ADR-0012 establishes the Worker vocabulary and the human-gated Worker value
// — it never describes an archive gate. Two prose sites in wave-close/SKILL.md
// and the archive phase reference's own heading used to cite it as if it did;
// all now point at the archive phase reference instead (which DOES describe
// the gate). This block demonstrates the fix was SCOPED to those sites: the
// CORRECT ADR-0012 citations elsewhere in the same files — the Worker vocabulary
// bullet, the park exit's own ADR-0022 — are untouched, proving a blanket
// ADR-0012 sweep did not happen (that sweep would have broken these too).

describe('the awaiting-human archive-gate citation is fixed, and the fix is scoped (issue #373)', () => {
  const REPO_ROOT = join(__dirname, '..', '..', '..');
  const CLOSE_SKILL = readFileSync(
    join(REPO_ROOT, '.claude/skills/wave-close/SKILL.md'),
    'utf-8',
  );
  const ARCHIVE_PHASE_REF = readFileSync(
    join(REPO_ROOT, '.claude/skills/wave-close/reference/phase-6-archive.md'),
    'utf-8',
  );

  it('no site presents ADR-0012 as the authority for the archive gate', () => {
    // The two miscited sentences (skill summary + phase-6 two-gates prose) now
    // point at the archive phase reference instead.
    expect(CLOSE_SKILL).toContain(
      '(`spine check-awaiting-human`, [reference/phase-6-archive.md](reference/phase-6-archive.md))',
    );
    expect(CLOSE_SKILL).toContain(
      '([reference/phase-6-archive.md](reference/phase-6-archive.md), park per ADR-0022)',
    );
    // The archive phase reference's own heading no longer miscites the gate it
    // documents — it IS the authority, so it cites nothing at all here.
    expect(ARCHIVE_PHASE_REF).toContain(
      '## Awaiting-human gate — BEFORE the archive move, beside the disclosure gate\n',
    );
    expect(ARCHIVE_PHASE_REF).not.toContain('ADR-0012');
  });

  it('the CORRECT ADR-0012 citations (Worker vocabulary, human-gated Worker value) survive untouched — proof this was not a blanket sweep', () => {
    // The terminality-gate bullet correctly cites ADR-0012 for the Worker
    // VALUE itself, never for the gate — a blanket sweep over "ADR-0012" would
    // have swept this one up too. It must be untouched by the fix.
    expect(CLOSE_SKILL).toContain(
      'the `Worker` is human-gated (`HITL-required` by default, ADR-0012) and no human has acted yet',
    );

    // The park exit keeps its own, separate, correct ADR-0022 citation.
    expect(CLOSE_SKILL).toContain('park per ADR-0022');
  });
});

// ─── the advertised op vocabulary is DERIVED, not transcribed (issue #366) ────
//
// Both of this runner's advertising surfaces — `printUsage()` and the `default:`
// case's `available:` list — are rendered from the single `SPINE_OP_ARGS` table.
// Before that table each carried its own hand-typed copy of the op names, which
// is the drift the FOR-11 live-gate retro found (`set-status` advertised in one
// place and not the other). These specs read both surfaces back at RUNTIME and
// pin that they agree with each other and with what the dispatch actually
// accepts — a second transcribed list here would only ever agree with itself.

/** This runner's op vocabulary, read off its own `default:` message. */
function advertisedSpineOps(stderr: () => string, reset: () => void): string[] {
  reset();
  expect(runSpine(['__unknown_op__', '/some/spine/path.md'])).toBe(2);
  const m = /available:\s*([^\n]+)/.exec(stderr());
  expect(m, 'no `available: a, b, c` op list in the unknown-op message').not.toBeNull();
  const ops = (m as RegExpExecArray)[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(ops.length).toBeGreaterThan(0);
  return ops;
}

describe('spine-cli — the op vocabulary is one list, advertised twice', () => {
  let stderrOut = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrOut = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrOut += String(c);
      return true;
    });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const ops = () => advertisedSpineOps(() => stderrOut, () => { stderrOut = ''; });

  it('advertises the ADR-0012 human-lane pair alongside every pre-existing op', () => {
    // The claim the fold has to make good on: after moving `human-gated` and
    // `check-awaiting-human` off the router, THIS runner is the one that names
    // them. Remove either from `SPINE_OP_ARGS` and this fails by name.
    const advertised = ops();
    expect(advertised).toContain('human-gated');
    expect(advertised).toContain('check-awaiting-human');
    // …without having dropped anything on the way in.
    expect(advertised).toContain('check-disclosures');
    expect(advertised).toContain('set-status');
  });

  it('every advertised op is genuinely dispatchable — nothing advertised 404s', () => {
    // Advertising and dispatch are separate code paths, so "it is in the list"
    // is not "it is wired". Each op is invoked WITH a <spine-path> on purpose:
    // invoked bare, an op falls into the shared missing-path guard and never
    // reaches the `default:` case, so the phantom this test exists to catch
    // would slip through. With a path it reaches dispatch, and whatever happens
    // next is a USAGE or DOMAIN failure (missing args, unreadable spine) —
    // never a "not an op" one.
    for (const op of ops()) {
      stderrOut = '';
      runSpine([op, join(tmpdir(), 'no-such-spine-vocab.md')]);
      expect(stderrOut, `advertised op \`${op}\` is not dispatched`).not.toContain(
        'unknown op',
      );
    }
  });

  it('the usage block names every advertised op — the two surfaces cannot disagree', () => {
    // `printUsage()` and the `available:` list are rendered from the same table,
    // and this is the assertion that would catch a re-split into two lists.
    const advertised = ops();
    stderrOut = '';
    expect(runSpine([])).toBe(2);
    const usage = stderrOut;
    expect(usage.startsWith('usage:')).toBe(true);
    for (const op of advertised) {
      expect(usage, `\`${op}\` is advertised but missing from the usage block`).toContain(
        `  spine ${op} `,
      );
    }
  });

  // ── issue #650 — the unknown-op message ALSO lists every op, one per line ──
  //
  // Convention 11 falsification: comment out the `'ops:'` block appended in
  // spine-cli.ts's `default:` case (leaving only the pre-existing single
  // `unknown op: ...; available: a, b, c` line) and this test fails — the
  // per-op search below finds zero `spine <op> ` lines. Restoring the block
  // makes it pass again. See this row's report for the observed failing output.
  it('the unknown-op message lists every op exactly once, each naming its own arg shape, and keeps exit code 2', () => {
    const advertised = ops(); // ground truth: parsed off the pre-existing `available:` line
    stderrOut = '';
    const code = runSpine(['__still_unknown__', join(tmpdir(), 'no-such-650.md')]);
    expect(code).toBe(2);

    const lines = stderrOut.split('\n');
    for (const op of advertised) {
      const matches = lines.filter((l) => l.trim().startsWith(`spine ${op} `) || l.trim() === `spine ${op}`);
      expect(matches, `expected exactly one arg-shape line for op "${op}"`).toHaveLength(1);
    }
  });
});

// ─── the human lane, in its post-fold home (issue #366, ADR-0012) ────────────
//
// Behaviour belongs to cli.spec.ts's `spine human-gated` / `spine
// check-awaiting-human` sections, whose assertions are unchanged across the
// fold. What is pinned HERE is the fold's own claim: the two ops now dispatch
// from this table, and reaching them through the router is the same call. The
// expectation is derived by RUNNING the other path, never from a fixture — a
// transcribed JSON blob would pass a fold that quietly changed both sides.

/** A spine whose row `11` is human-gated and still `planned` (i.e. awaiting). */
function writeHumanLaneSpine(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spine-cli-human-lane-'));
  const path = join(dir, 'WAVE.md');
  writeFileSync(
    path,
    [
      '# Wave 2026-07-31 — human lane',
      '',
      '**Status:** in-flight',
      '',
      '## Plan-Table',
      '',
      '| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |',
      '| 10 | Ordinary AFK row | background | mechanical | quick-verify | — | planned | 1 | — |',
      `| 11 | Rotate the credential by hand | ${HUMAN_GATED_WORKER} | cross-feature-refactor | quick-verify | — | planned | 1 | — |`,
      '',
    ].join('\n'),
    'utf-8',
  );
  return path;
}

describe('spine-cli dispatches the human lane (issue #366 — the fold)', () => {
  let stdoutOut = '';
  let stderrOut = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutOut = '';
    stderrOut = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutOut += String(c);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrOut += String(c);
      return true;
    });
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  /** Run one spelling of an op and capture everything an operator can observe. */
  function capture(run: () => number): { code: number; stdout: string; stderr: string } {
    stdoutOut = '';
    stderrOut = '';
    const code = run();
    return { code, stdout: stdoutOut, stderr: stderrOut };
  }

  it.each([
    ['human-gated', 0],
    ['check-awaiting-human', 1],
  ] as const)(
    '`%s` dispatches from THIS table with the documented exit code',
    (op, expected) => {
      const path = writeHumanLaneSpine();
      const { code, stderr } = capture(() => runSpine([op, path]));
      expect(stderr).not.toContain('unknown op');
      expect(code).toBe(expected);
    },
  );

  it.each(['human-gated', 'check-awaiting-human'] as const)(
    '`%s` is byte-identical through the router and through this runner',
    (op) => {
      // The fold's parity claim, both directions of it: same exit code, same
      // stdout, same stderr. The expectation is the OTHER path's own output.
      const path = writeHumanLaneSpine();
      const direct = capture(() => runSpine([op, path]));
      const viaRouter = capture(() => main(['spine', op, path]));

      expect(viaRouter.code).toBe(direct.code);
      expect(viaRouter.stdout).toBe(direct.stdout);
      expect(viaRouter.stderr).toBe(direct.stderr);
      // Non-vacuity: an op that printed nothing at all would satisfy the three
      // equalities above and prove nothing.
      expect(direct.stdout.length).toBeGreaterThan(0);
    },
  );

  it.each(['human-gated', 'check-awaiting-human'] as const)(
    '`%s` keeps its OWN missing-path usage message, not the shared one',
    (op) => {
      // Each op names itself and its `--workers` flag on a missing path — the
      // reason both are handled ahead of the generic `<spine-path>` guard. The
      // shared `printUsage()` block would name neither.
      const { code, stderr } = capture(() => runSpine([op]));
      expect(code).toBe(2);
      expect(stderr).toContain(`spine ${op} requires a <spine-path>`);
      expect(stderr).toContain('--workers');
    },
  );

  it('a flag in the <spine-path> slot is a usage error, not a domain one', () => {
    const { code, stderr } = capture(() => runSpine(['human-gated', '--workers', 'x']));
    expect(code).toBe(2);
    expect(stderr).toContain('requires a <spine-path>');
  });

  it('the gate is fail-closed on an unreadable spine — exit 1, like a held row', () => {
    const { code, stdout } = capture(() =>
      runSpine(['check-awaiting-human', join(tmpdir(), 'no-such-spine-366.md')]),
    );
    expect(code).toBe(1);
    expect(stdout).not.toContain('CLEAR');
  });

  it('reads through the injected SpineIo, like every other op in this runner', () => {
    // The one deliberate divergence from a literal move: the lane reader now
    // takes its bytes from `io.read` instead of a direct `readFileSync`. The
    // default io IS `readFileSync(p, 'utf-8')`, so behaviour is unchanged — and
    // this is the assertion that says the seam is real rather than decorative.
    const source = readFileSync(writeHumanLaneSpine(), 'utf-8');
    const reads: string[] = [];
    const io = {
      read: (p: string) => {
        reads.push(p);
        return source;
      },
      write: () => {
        throw new Error('the human lane must never write');
      },
    };
    const { code, stdout } = capture(() => runSpine(['human-gated', 'WAVE.md'], io));
    expect(code).toBe(0);
    expect(reads).toHaveLength(1);
    expect(JSON.parse(stdout).awaitingHumanIds).toEqual(['11']);
  });
});
