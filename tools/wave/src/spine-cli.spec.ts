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
