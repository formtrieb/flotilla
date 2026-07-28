import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSpine } from './spine-cli';
// The router, imported to pin that its `spine` case is the ONE dispatch path
// this module's ops now flow through (issue #77).
import { main } from './cli';
import { readSpine } from './wave-md-rw';
import { readDisclosures } from './spine-store';

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

    it('check-disclosures is fail-CLOSED on an unreadable spine (never a silent green)', () => {
      const code = runSpine(['check-disclosures', join(tmpdir(), 'no-such-spine-adr-0027.md')]);
      expect(code).not.toBe(0);
      expect(stderrSpy).toHaveBeenCalled();
    });

    it('check-disclosures with no path → usage 2', () => {
      expect(runSpine(['check-disclosures'])).toBe(2);
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
});
