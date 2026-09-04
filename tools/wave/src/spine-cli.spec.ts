import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpine } from './spine-cli';
// The router, imported to pin that its `spine` case is the ONE dispatch path
// this module's ops now flow through (issue #77).
import { main } from './cli';
import { readSpine, HUMAN_GATED_WORKER } from './wave-md-rw';
import { readDisclosures, WAVE_SCOPE_ITER_CELL } from './spine-store';

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
    expect(main([])).toBe(2);
    const usage = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    // The row-scoped spelling is still advertised verbatim…
    expect(usage).toContain('spine add-disclosure <spine-path> <row-id> --iter <n>');
    // …and the wave-scoped one is advertised beside it, not instead of it.
    expect(usage).toContain('spine add-disclosure <spine-path> --wave');
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
