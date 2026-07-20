import { describe, it, expect } from 'vitest';
import { resume, type ResumeInputs } from './resume';
import { spineStoreFromSource } from './spine-store';
import type { WorktreeEntry } from './worktree-cleanup';
import type { SidecarIndex, ReportHit, VerdictHit } from './sidecar';
import type { WorkerReport } from './worker-report-schema';
import type { ReviewerVerdict } from './reviewer-verdict-schema';

// ── fixtures ─────────────────────────────────────────────────────────────────
interface RowSpec { id: string; state: string; iter?: number }

/** Build a minimal valid WAVE.md spine with the given plan-table rows + dispatch-log. */
function spineFor(rows: RowSpec[]): ReturnType<typeof spineStoreFromSource> {
  const tableRows = rows
    .map(
      (r) =>
        `| ${r.id} | T ${r.id} | background | mechanical | quick-verify | — | ${r.state} | ${r.iter ?? 1} | — |`,
    )
    .join('\n');
  const dispatch = rows
    .map((r) => `  - "${r.id} → agent a${r.id} (sonnet)  branch wave-orch/${r.id}-thing"`)
    .join('\n');
  const src = `# Wave 2026-06-06 — test

**Status:** in-flight

## Plan-Table

| ID  | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |
| --- | ----- | ------ | ---- | -------- | -- | ----- | ---- | ------------------ |
${tableRows}

## PR-Log

| Created | ID | PR | Closes | Merged | Notes |
| ------- | -- | -- | ------ | ------ | ----- |
| — | — | — | — | — | _(none)_ |

## Resume-Metadata

\`\`\`yaml
dispatch-log:
${dispatch}
\`\`\`
`;
  return spineStoreFromSource(src);
}

const wt = (id: string, dirty = false): WorktreeEntry => ({
  path: `/repo/.claude/worktrees/agent-${id}`,
  branch: `wave-orch/${id}-thing`,
  head: 'abc1234',
  dirty,
});

const stubReport = {} as WorkerReport;
const stubVerdict = {} as ReviewerVerdict;

function sidecars(opts: {
  reports?: Record<string, number>;
  verdicts?: Record<string, number>;
  corrupt?: string[];
}): SidecarIndex {
  return {
    reportFor: (id): ReportHit | null =>
      opts.reports && id in opts.reports ? { iter: opts.reports[id], report: stubReport } : null,
    verdictFor: (id): VerdictHit | null =>
      opts.verdicts && id in opts.verdicts ? { iter: opts.verdicts[id], verdict: stubVerdict } : null,
    corruptFor: (id) =>
      opts.corrupt?.includes(id)
        ? [{ id, iter: 1, kind: 'report' as const, reason: 'bad' }]
        : [],
  };
}

function run(rows: RowSpec[], worktrees: WorktreeEntry[], sc: SidecarIndex) {
  const inputs: ResumeInputs = { spine: spineFor(rows).spine(), worktrees, sidecars: sc };
  return resume(inputs);
}
const rowOf = (r: ReturnType<typeof run>, id: string) => r.rows.find((x) => x.id === id)!;

// ── the decision-table matrix ────────────────────────────────────────────────
describe('resume() — per-row reconciliation decision table', () => {
  it('planned + no worktree + no sidecar → redispatch (spawn never landed)', () => {
    const r = run([{ id: '01', state: 'planned' }], [], sidecars({}));
    expect(rowOf(r, '01').decision).toBe('redispatch');
    expect(rowOf(r, '01').reconstructedState).toBe('planned');
    expect(rowOf(r, '01').coarse).toBe('queued');
  });

  it('dispatched + clean worktree + no sidecar → adopt (worker died mid-run)', () => {
    const r = run([{ id: '02', state: 'dispatched' }], [wt('02')], sidecars({}));
    expect(rowOf(r, '02').decision).toBe('adopt');
    expect(rowOf(r, '02').worktree).not.toBeNull();
    expect(rowOf(r, '02').coarse).toBe('in-flight');
  });

  it('dispatched + DIRTY worktree + no sidecar → adopt (WIP preserved, noted)', () => {
    const r = run([{ id: '03', state: 'dispatched' }], [wt('03', true)], sidecars({}));
    expect(rowOf(r, '03').decision).toBe('adopt');
    expect(rowOf(r, '03').notes.some((n) => /dirty/.test(n))).toBe(true);
  });

  it('dispatched + report sidecar → adopt, disk-correct to report-in (beats spine flip)', () => {
    const r = run([{ id: '04', state: 'dispatched' }], [wt('04')], sidecars({ reports: { '04': 1 } }));
    expect(rowOf(r, '04').decision).toBe('adopt');
    expect(rowOf(r, '04').reconstructedState).toBe('report-in');
    expect(rowOf(r, '04').reportIter).toBe(1);
  });

  it('report-in + report + verdict (same iter) → adopt, disk-correct to verdict-in', () => {
    const r = run([{ id: '05', state: 'report-in' }], [wt('05')], sidecars({ reports: { '05': 1 }, verdicts: { '05': 1 } }));
    expect(rowOf(r, '05').reconstructedState).toBe('verdict-in');
    expect(rowOf(r, '05').decision).toBe('adopt');
  });

  it('fresh report (iter 2) + stale verdict (iter 1) → report-in, NOT verdict-in', () => {
    const r = run([{ id: '06', state: 'reviewing' }], [wt('06')], sidecars({ reports: { '06': 2 }, verdicts: { '06': 1 } }));
    expect(rowOf(r, '06').reconstructedState).toBe('report-in');
    expect(rowOf(r, '06').reportIter).toBe(2);
    expect(rowOf(r, '06').verdictIter).toBe(1);
  });

  it('report-in claimed + no worktree + no sidecar → needs-attention (orphan, fatal)', () => {
    const r = run([{ id: '07', state: 'report-in' }], [], sidecars({}));
    expect(rowOf(r, '07').decision).toBe('needs-attention');
    expect(r.fatals.map((f) => f.id)).toContain('07');
  });

  it('sidecar present but no worktree → adopt from disk (committed work survives), not redispatch', () => {
    const r = run([{ id: '08', state: 'dispatched' }], [], sidecars({ reports: { '08': 1 } }));
    expect(rowOf(r, '08').decision).toBe('adopt');
    expect(rowOf(r, '08').reconstructedState).toBe('report-in');
  });

  it('pr-created → keep (past the gate; coarse in-review)', () => {
    const r = run([{ id: '09', state: 'pr-created' }], [], sidecars({}));
    expect(rowOf(r, '09').decision).toBe('keep');
    expect(rowOf(r, '09').reconstructedState).toBe('pr-created');
    expect(rowOf(r, '09').coarse).toBe('in-review');
  });

  it('failed → keep (terminal; claim held, coarse in-flight)', () => {
    const r = run([{ id: '10', state: 'failed' }], [], sidecars({}));
    expect(rowOf(r, '10').decision).toBe('keep');
    expect(rowOf(r, '10').coarse).toBe('in-flight');
  });

  // ── parked (ADR-0022 — terminal + claim-releasing) ────────────────────────
  it('parked → keep (terminal; coarse null = no claim, re-projected as unclaim)', () => {
    const r = run([{ id: '12', state: 'parked' }], [], sidecars({}));
    expect(rowOf(r, '12').decision).toBe('keep');
    expect(rowOf(r, '12').reconstructedState).toBe('parked');
    expect(rowOf(r, '12').coarse).toBeNull();
  });

  // ADR-0022 §Decisions 4: "a leftover worktree from a `failed → parked` row is
  // never adopted — no work-carryover promise". Without `parked` in TERMINAL the
  // worktree branch below would win and flip the decision to `adopt`, silently
  // resurrecting a row the Coordinator deliberately took out of the wave.
  it('parked with a leftover worktree → still keep, never adopt (no work-carryover)', () => {
    const r = run([{ id: '13', state: 'parked' }], [wt('13')], sidecars({}));
    expect(rowOf(r, '13').decision).toBe('keep');
    expect(rowOf(r, '13').coarse).toBeNull();
  });

  // The re-projection idempotence the ADR requires: a parked row carrying a
  // stale report sidecar must NOT reconstruct forward to `report-in` (which
  // would re-claim it in-flight and re-tell the lie on every resume).
  it('parked with a stale report sidecar → not reconstructed forward, claim stays released', () => {
    const r = run([{ id: '14', state: 'parked' }], [], sidecars({ reports: { '14': 1 } }));
    expect(rowOf(r, '14').reconstructedState).toBe('parked');
    expect(rowOf(r, '14').decision).toBe('keep');
    expect(rowOf(r, '14').coarse).toBeNull();
  });

  it('corrupt sidecar → needs-attention (never silently routed), fatal', () => {
    const r = run([{ id: '11', state: 'report-in' }], [wt('11')], sidecars({ corrupt: ['11'] }));
    expect(rowOf(r, '11').decision).toBe('needs-attention');
    expect(r.fatals.map((f) => f.id)).toContain('11');
  });

  it('unknown spine state → needs-attention, fatal', () => {
    const r = run([{ id: '12', state: 'bogus-state' }], [], sidecars({}));
    expect(rowOf(r, '12').decision).toBe('needs-attention');
    expect(r.fatals.map((f) => f.id)).toContain('12');
  });

  it('joins the worktree by branch (dispatch-log), not by path', () => {
    const r = run([{ id: '02', state: 'dispatched' }], [wt('02')], sidecars({}));
    expect(rowOf(r, '02').branch).toBe('wave-orch/02-thing');
    expect(rowOf(r, '02').worktree?.path).toContain('agent-02');
  });
});
