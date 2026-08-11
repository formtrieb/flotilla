import { describe, it, expect } from 'vitest';
import {
  readSpine,
  renderConflictMap,
  renderSpine,
  setRowState,
  setRowIter,
  setRowPrCell,
  upsertPrLogRow,
  replaceClosedByBlock,
  upsertDispatchLogEntry,
  upsertDispatchLogModel,
  branchesByIssueId,
  requireBranchesByIssueId,
  ROW_STATES,
  setFrontmatterStatus,
  SPINE_STATUSES,
  HUMAN_GATED_WORKER,
  humanGatedRows,
  humanHeldRowIds,
} from './wave-md-rw';
import { ISSUE_STATES } from './stop-condition-state-machine';
// The shipped default Worker vocabulary. Imported for one parity assertion:
// `HUMAN_GATED_WORKER` is this module's copy of a token whose authoritative
// list lives in header-parser.ts, exactly as `ROW_STATES` mirrors the state
// machine's `ISSUE_STATES` below — so a rename there must fail loud here
// rather than leave the dispatch gate silently matching nothing.
import { WORKER_VALUES } from './header-parser';
// Imported to drive the REAL resume join (issue #141 AC6) against an
// out-of-convention branch name — the join lives in resume.ts but reads its
// branches from THIS module's `branchesByIssueId`, so the coupling under test
// is this file's. Nothing in resume.ts is modified by that issue; the test only
// pins that the join still finds a worktree when the branch is named freely.
import { resume } from './resume';
import type { WorktreeEntry } from './worktree-cleanup';
import type { SidecarIndex } from './sidecar';
// spine-store.ts owns the `## Disclosures` section (ADR-0027) outright — its
// printer/parser pair lives there and is pinned by spine-store.spec.ts. The
// import here is integration-only: it proves `renderSpine`'s scaffolded
// section is exactly what `ensureDisclosuresSection` considers "already
// present" (the acceptance criterion this issue exists to satisfy), without
// this file taking on the section's format as its own concern.
import { ensureDisclosuresSection, readDisclosures } from './spine-store';
// Same surface, but imported through the PACKAGE ROOT rather than the module
// file directly — proves the barrel actually re-exports it (issue #177's
// second acceptance criterion), aliased to avoid colliding with the
// direct-module import above.
import {
  ensureDisclosuresSection as ensureDisclosuresSectionFromRoot,
  readDisclosures as readDisclosuresFromRoot,
  addDisclosureToSource as addDisclosureToSourceFromRoot,
  addWaveDisclosureToSource as addWaveDisclosureToSourceFromRoot,
  setDispositionInSource as setDispositionInSourceFromRoot,
  WAVE_SCOPE_ROW as WAVE_SCOPE_ROW_FROM_ROOT,
  WAVE_SCOPE_ITER_CELL as WAVE_SCOPE_ITER_CELL_FROM_ROOT,
  type Disclosure as DisclosureFromRoot,
  type WaveDisclosureInput as WaveDisclosureInputFromRoot,
} from './index';

// ─── Golden fixture — a real-shape WAVE.md spine ──────────────────────────────
//
// Mirrors `.scratch/waves/2026-06-04-wave-close-epic.md` (the spine this very
// issue belongs to): frontmatter, a Plan-Table with footnote-marked IDs, a
// Conflict-Map list, a populated Resume-Metadata dispatch-log, an
// un-populated PR-Log placeholder row, and a draft Closed-by body. Trailing
// newline present (as on disk).

const SPINE = `# Wave 2026-06-04 — wave-close-epic (\`/wave close\` deep modules)

**Status:** in-flight
**Coordinator:** at//design + Opus 4.8 (1M context)
**Created:** 2026-06-04
**Last-updated:** 2026-06-04 — flipped ready→in-flight by /wave start

## Plan-Table

Rows ordered by dispatch layer.

| ID  | Title                                              | Worker            | Risk              | Reviewer     | PR  | State   | Iter | Reports → Verdicts |
| --- | -------------------------------------------------- | ----------------- | ----------------- | ------------ | --- | ------- | ---- | ------------------ |
| 54  | Shared WAVE.md reader/writer[^source-54]           | background-heavy   | isolated-refactor | quick-verify | —   | planned | 1    | [r1](./r/54-1.md)  |
| 55  | Closed-by classifier[^source-55]                   | background | mechanical        | quick-verify | —   | planned | 1    | [r1](./r/55-1.md)  |
| 58  | Merge-order exact-branch[^source-58]               | background-heavy   | isolated-refactor | quick-verify | —   | planned | 1    | [r1](./r/58-1.md)  |

[^source-54]: Source: [\`54\`](../wave-orchestration/issues/54-wave-md-rw.md)

## Conflict-Map

Pairwise intersection.

**Conflict list:**

1. **54 ↔ 55** at \`tools/wave/src/index.ts\`
2. **54 ↔ 58** at \`tools/wave/src/index.ts\` and \`tools/wave/src/cli.ts\`

## PR-Log

One row per \`pr-created\` issue.

| Created | ID  | PR  | Closes | Merged | Notes                                      |
| ------- | --- | --- | ------ | ------ | ------------------------------------------ |
| —       | —   | —   | —      | —      | _(no PRs yet — populated at \`pr-created\`)_ |

## Resume-Metadata

\`\`\`yaml
last-tick: 2026-06-04 — /wave start Phase 1 complete
in-flight-issues: []
coordinator-head: 604230ba16ccec73c6d8fe5a87d10dba82568ad2
remote-host: bitbucket (auth present)
dispatch-log:
  - "54 → agent a3e8e789be5b53f61 (opus)  branch wave-orch/54-wave-md-rw"
  - "55 → agent ac2275eb0cebcf4fb (sonnet) branch wave-orch/55-closed-by"
  - "58 → L2, held: stacked on wave-orch/54 once #54 reports in"
notes: |
  Layer plan: L1={54,55} parallel → L2=58 stacked on 54.
\`\`\`

## Closed-by

_(written at \`/wave close\` time)_

- DIARY entry: —
- All in-wave issues closed; see PR-Log for individual PR URLs.

**Wave operational close:** —
`;

describe('readSpine — structured view', () => {
  const spine = readSpine(SPINE);

  it('reads frontmatter fields', () => {
    expect(spine.frontmatter.status).toBe('in-flight');
    expect(spine.frontmatter.coordinator).toBe(
      'at//design + Opus 4.8 (1M context)',
    );
    expect(spine.frontmatter.created).toBe('2026-06-04');
    expect(spine.frontmatter.lastUpdated).toBe(
      '2026-06-04 — flipped ready→in-flight by /wave start',
    );
  });

  it('reads Plan-Table rows with footnote stripped from the ID', () => {
    expect(spine.planTable).toHaveLength(3);
    const ids = spine.planTable.map((r) => r.id);
    expect(ids).toEqual(['54', '55', '58']);
    const row54 = spine.planTable[0];
    expect(row54.title).toBe('Shared WAVE.md reader/writer');
    expect(row54.worker).toBe('background-heavy');
    expect(row54.risk).toBe('isolated-refactor');
    expect(row54.reviewer).toBe('quick-verify');
    expect(row54.state).toBe('planned');
    expect(row54.iter).toBe(1);
    expect(row54.prCell).toBe('—');
    expect(row54.prUrl).toBeNull();
  });

  it('resolves each row branch from the dispatch-log', () => {
    const byId = Object.fromEntries(
      spine.planTable.map((r) => [r.id, r.branch]),
    );
    expect(byId['54']).toBe('wave-orch/54-wave-md-rw');
    expect(byId['55']).toBe('wave-orch/55-closed-by');
    // #58 dispatch-log entry has no branch ref (held, L2) → null.
    expect(byId['58']).toBeNull();
  });

  it('reads the dispatch-log entries with parsed id + branch', () => {
    expect(spine.dispatchLog).toHaveLength(3);
    expect(spine.dispatchLog[0]).toMatchObject({
      id: '54',
      branch: 'wave-orch/54-wave-md-rw',
    });
    expect(spine.dispatchLog[2].id).toBe('58');
    expect(spine.dispatchLog[2].branch).toBeNull();
  });

  it('reads the Conflict-Map list into cells (sorted ids + files)', () => {
    expect(spine.conflictMap.cells).toEqual([
      { a: '54', b: '55', files: ['tools/wave/src/index.ts'] },
      {
        a: '54',
        b: '58',
        files: ['tools/wave/src/cli.ts', 'tools/wave/src/index.ts'],
      },
    ]);
  });

  it('reads the PR-Log, skipping the placeholder row', () => {
    expect(spine.prLog).toHaveLength(0);
  });

  it('captures the Closed-by block span + body', () => {
    expect(spine.closedBy.headingLine).not.toBeNull();
    expect(spine.closedBy.body).toContain('_(written at');
    expect(spine.closedBy.body).toContain('**Wave operational close:** —');
  });
});

describe('round-trip property — read → no-op write → byte-identical', () => {
  it('setRowState to the same state is byte-identical', () => {
    const out = setRowState(SPINE, '54', 'planned');
    expect(out).toBe(SPINE);
  });

  it('setRowPrCell to the same cell is byte-identical', () => {
    const out = setRowPrCell(SPINE, '54', '—');
    expect(out).toBe(SPINE);
  });

  it('replaceClosedByBlock with the existing body is byte-identical', () => {
    const spine = readSpine(SPINE);
    const out = replaceClosedByBlock(SPINE, spine.closedBy.body);
    expect(out).toBe(SPINE);
  });

  it('preserves a CRLF + no-trailing-newline source exactly on no-op write', () => {
    const crlf = SPINE.replace(/\n/g, '\r\n').replace(/\r\n$/, '');
    const out = setRowState(crlf, '54', 'planned');
    expect(out).toBe(crlf);
  });
});

describe('targeted-mutation span isolation', () => {
  /** Lines that differ between two same-length-line documents. */
  function changedLineIndices(a: string, b: string): number[] {
    const la = a.split('\n');
    const lb = b.split('\n');
    const max = Math.max(la.length, lb.length);
    const diff: number[] = [];
    for (let i = 0; i < max; i++) {
      if (la[i] !== lb[i]) diff.push(i);
    }
    return diff;
  }

  it('setRowState changes exactly one line (the target row) and nothing else', () => {
    const out = setRowState(SPINE, '55', 'pr-created');
    const changed = changedLineIndices(SPINE, out);
    expect(changed).toHaveLength(1);
    // The changed line is row 55 and now carries the new state.
    const line = out.split('\n')[changed[0]];
    expect(line).toContain('| 55 ');
    expect(line).toContain('pr-created');
    // Re-reading confirms only that row flipped.
    const reread = readSpine(out);
    expect(reread.planTable.find((r) => r.id === '55')?.state).toBe(
      'pr-created',
    );
    expect(reread.planTable.find((r) => r.id === '54')?.state).toBe('planned');
    expect(reread.planTable.find((r) => r.id === '58')?.state).toBe('planned');
  });

  it('setRowPrCell changes exactly one line and the re-read picks up the URL', () => {
    const cell = '[PR#56](https://bitbucket.org/x/y/pull-requests/56)';
    const out = setRowPrCell(SPINE, '54', cell);
    const changed = changedLineIndices(SPINE, out);
    expect(changed).toHaveLength(1);
    const reread = readSpine(out);
    const row = reread.planTable.find((r) => r.id === '54');
    expect(row?.prCell).toBe(cell);
    expect(row?.prUrl).toBe('https://bitbucket.org/x/y/pull-requests/56');
    // Other rows' PR cells untouched.
    expect(reread.planTable.find((r) => r.id === '55')?.prCell).toBe('—');
  });

  it('a state flip does not perturb the Conflict-Map, PR-Log, or Closed-by bytes', () => {
    const before = readSpine(SPINE);
    const out = setRowState(SPINE, '54', 'dispatched');
    const after = readSpine(out);
    expect(after.conflictMap).toEqual(before.conflictMap);
    expect(after.closedBy.body).toBe(before.closedBy.body);
    // PR-Log section text identical (compare the raw section slice).
    const sliceBefore = before.lines
      .slice(before.closedBy.bodyStart - 1)
      .join('\n');
    const sliceAfter = after.lines
      .slice(after.closedBy.bodyStart - 1)
      .join('\n');
    expect(sliceAfter).toBe(sliceBefore);
  });
});

describe('upsertPrLogRow', () => {
  it('replaces the placeholder row on first insert (no row count growth)', () => {
    const out = upsertPrLogRow(SPINE, {
      created: '2026-06-04',
      id: '54',
      prCell: '[PR#60](https://bitbucket.org/x/y/pull-requests/60)',
      closes: 'wave-orchestration#54',
      merged: '—',
      notes: 'shared spine R/W',
    });
    expect(out.split('\n')).toHaveLength(SPINE.split('\n').length);
    const reread = readSpine(out);
    expect(reread.prLog).toHaveLength(1);
    expect(reread.prLog[0]).toMatchObject({
      id: '54',
      prUrl: 'https://bitbucket.org/x/y/pull-requests/60',
      closes: 'wave-orchestration#54',
    });
    // Plan-Table + Closed-by untouched.
    expect(reread.planTable).toHaveLength(3);
    expect(reread.closedBy.body).toBe(readSpine(SPINE).closedBy.body);
  });

  it('appends a second real row after the first (one new line)', () => {
    const first = upsertPrLogRow(SPINE, {
      created: '2026-06-04',
      id: '54',
      prCell: '[PR#60](https://x/60)',
      closes: 'wo#54',
      merged: '—',
      notes: 'a',
    });
    const second = upsertPrLogRow(first, {
      created: '2026-06-04',
      id: '55',
      prCell: '[PR#61](https://x/61)',
      closes: 'wo#55',
      merged: '—',
      notes: 'b',
    });
    expect(second.split('\n')).toHaveLength(first.split('\n').length + 1);
    const reread = readSpine(second);
    expect(reread.prLog.map((r) => r.id)).toEqual(['54', '55']);
  });

  it('updates an existing real row in place (idempotent re-pin)', () => {
    const first = upsertPrLogRow(SPINE, {
      created: '2026-06-04',
      id: '54',
      prCell: '[pre-fill](https://x/new?source=wave-orch/54)',
      closes: 'wo#54',
      merged: '—',
      notes: 'pre-fill',
    });
    const pinned = upsertPrLogRow(first, {
      created: '2026-06-04',
      id: '54',
      prCell: '[PR#60](https://x/60)',
      closes: 'wo#54',
      merged: '—',
      notes: 'pinned',
    });
    // No new line — same row replaced.
    expect(pinned.split('\n')).toHaveLength(first.split('\n').length);
    const reread = readSpine(pinned);
    expect(reread.prLog).toHaveLength(1);
    expect(reread.prLog[0].prUrl).toBe('https://x/60');
    expect(reread.prLog[0].notes).toBe('pinned');
  });
});

describe('replaceClosedByBlock', () => {
  it('swaps only the Closed-by body, leaving every prior section identical', () => {
    const newBody = [
      '',
      'Wave closed 2026-06-04 by `/wave close`.',
      '',
      '- **DIARY entry:** see snippet.',
      '- All issues `pr-created`.',
      '',
    ].join('\n');
    const out = replaceClosedByBlock(SPINE, newBody);
    const before = readSpine(SPINE);
    const after = readSpine(out);

    // Everything before the Closed-by heading is byte-identical.
    const headIdx = before.closedBy.headingLine as number;
    const beforeHead = SPINE.split('\n')
      .slice(0, headIdx + 1)
      .join('\n');
    const afterHead = out
      .split('\n')
      .slice(0, headIdx + 1)
      .join('\n');
    expect(afterHead).toBe(beforeHead);

    // The new body is present; the old draft body is gone.
    expect(after.closedBy.body).toContain(
      'Wave closed 2026-06-04 by `/wave close`.',
    );
    expect(after.closedBy.body).not.toContain('_(written at');

    // Frontmatter, Plan-Table, Conflict-Map, PR-Log untouched.
    expect(after.frontmatter).toEqual(before.frontmatter);
    expect(after.planTable.map((r) => r.id)).toEqual(['54', '55', '58']);
    expect(after.conflictMap).toEqual(before.conflictMap);
  });
});

describe('writer guards', () => {
  it('setRowState throws on an unknown id', () => {
    expect(() => setRowState(SPINE, '99', 'planned')).toThrow(
      /no Plan-Table row/,
    );
  });

  it('setRowPrCell throws on an unknown id', () => {
    expect(() => setRowPrCell(SPINE, '99', '[x](https://x/1)')).toThrow(
      /no Plan-Table row/,
    );
  });

  it('all ROW_STATES are accepted by setRowState (smoke over the enum)', () => {
    for (const state of ROW_STATES) {
      const out = setRowState(SPINE, '54', state);
      expect(readSpine(out).planTable[0].state).toBe(state);
    }
  });

  it('setRowIter throws on an unknown id', () => {
    expect(() => setRowIter(SPINE, '99', 2)).toThrow(/no Plan-Table row/);
  });
});

// ─── setRowIter — Plan-Table Iter cell + sidecar-link renderer (FOR-53) ───────
//
// Closes the observability gap where a cap=1 re-dispatch leaves the Plan-Table
// row describing iteration 1 (stale `Iter` cell + `r1`/`v1` sidecar links)
// while the Scribe has already written iteration-2 sidecars to disk. This is
// observability-only — the reconciler still reads the max-iter sidecar off
// disk (ADR-0024) — so these tests assert the RENDERED cells, never a new
// reconciler input.
describe('setRowIter — bumps Iter + re-renders the sidecar-link cell (FOR-53)', () => {
  // A freshly-rendered spine carries the MODERN two-link sidecar format
  // (`[r1](…) → [v1](…)`) that renderSidecarCellForIter understands.
  const meta = {
    slug: 'demo', description: 'a demo wave', coordinator: 'at',
    model: 'Opus 4.8', created: '2026-07-20', lastUpdated: '2026-07-20 10:00 CEST',
  };
  const roster = [
    { id: 'FOR-30', title: 'Some row', worker: 'background', risk: 'isolated-refactor' },
  ];
  const rendered = renderSpine(meta, roster, { issues: [], cells: [] }, 'ok.');

  it('bumps the Iter cell and re-renders the sidecar links to <id>-<iter>', () => {
    const out = setRowIter(rendered, 'FOR-30', 2);
    const row = readSpine(out).planTable[0];
    expect(row.iter).toBe(2);
    expect(row.reportsVerdicts).toBe(
      '[r2](./demo/reports/FOR-30-2.md) → [v2](./demo/verdicts/FOR-30-2.md)',
    );
  });

  it('is the same write a cap=1 re-dispatch performs alongside set-row-state', () => {
    // Mirrors start-mechanics.md step 7d: set-row-state(id, 're-dispatched')
    // first, then set-row-iter(id, 2) — the durable spine (WAL, ADR-0002)
    // stops disagreeing with the iteration-2 sidecars already on disk.
    const reDispatched = setRowState(rendered, 'FOR-30', 're-dispatched');
    const out = setRowIter(reDispatched, 'FOR-30', 2);
    const row = readSpine(out).planTable[0];
    expect(row.state).toBe('re-dispatched');
    expect(row.iter).toBe(2);
    expect(row.reportsVerdicts).toContain('FOR-30-2.md');
    expect(row.reportsVerdicts).not.toContain('FOR-30-1.md');
  });

  it('goes through the parser-consumed renderer — byte-safety: only the row line changes', () => {
    const out = setRowIter(rendered, 'FOR-30', 2);
    const before = rendered.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before
      .map((l, i) => (l === after[i] ? null : i))
      .filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    // readSpine → renderSpine stays stable: the mutated spine re-parses
    // cleanly and every other structural element is untouched (ADR-0016).
    expect(() => readSpine(out)).not.toThrow();
    const beforeSpine = readSpine(rendered);
    const afterSpine = readSpine(out);
    expect(afterSpine.frontmatter).toEqual(beforeSpine.frontmatter);
    expect(afterSpine.conflictMap).toEqual(beforeSpine.conflictMap);
    expect(afterSpine.planTable).toHaveLength(beforeSpine.planTable.length);
  });

  it('is idempotent — re-writing the same iter twice is byte-identical on the second call', () => {
    const once = setRowIter(rendered, 'FOR-30', 2);
    const twice = setRowIter(once, 'FOR-30', 2);
    expect(twice).toBe(once);
  });

  it('leaves an unrecognised sidecar cell (the "—" no-sidecar placeholder) untouched', () => {
    // The minimal draft-spine fixture's row has reportsVerdicts === '—'.
    const minimal = `# Wave X

**Status:** draft

## Plan-Table

| ID  | Title | Worker          | Risk       | Reviewer     | PR  | State   | Iter | Reports → Verdicts |
| --- | ----- | --------------- | ---------- | ------------ | --- | ------- | ---- | ------------------ |
| 01  | Foo   | background-heavy | mechanical | quick-verify | —   | planned | 1    | —                  |
`;
    const out = setRowIter(minimal, '01', 2);
    const row = readSpine(out).planTable[0];
    expect(row.iter).toBe(2);
    expect(row.reportsVerdicts).toBe('—');
  });

  it('leaves a legacy single-link sidecar cell untouched (Iter still bumps)', () => {
    // The golden SPINE fixture's row 54 uses the pre-verdict-link shorthand
    // `[r1](./r/54-1.md)` (no ` → [v1](…)` half) — setRowIter must not guess
    // a verdicts path that was never recorded.
    const out = setRowIter(SPINE, '54', 2);
    const row = readSpine(out).planTable.find((r) => r.id === '54')!;
    expect(row.iter).toBe(2);
    expect(row.reportsVerdicts).toBe('[r1](./r/54-1.md)');
  });

  it('touches only the targeted row — sibling rows are byte-untouched', () => {
    const roster2 = [
      { id: 'A', title: 'First', worker: 'background', risk: 'mechanical' },
      { id: 'B', title: 'Second', worker: 'background', risk: 'mechanical' },
    ];
    const spine2 = renderSpine(meta, roster2, { issues: [], cells: [] }, 'ok.');
    const out = setRowIter(spine2, 'A', 2);
    const rows = readSpine(out).planTable;
    expect(rows.find((r) => r.id === 'A')?.iter).toBe(2);
    expect(rows.find((r) => r.id === 'B')?.iter).toBe(1);
    expect(rows.find((r) => r.id === 'B')?.reportsVerdicts).toContain('B-1.md');
  });

  it('handles a double-digit iteration correctly (path suffix disambiguation)', () => {
    const out = setRowIter(rendered, 'FOR-30', 12);
    const row = readSpine(out).planTable[0];
    expect(row.iter).toBe(12);
    expect(row.reportsVerdicts).toBe(
      '[r12](./demo/reports/FOR-30-12.md) → [v12](./demo/verdicts/FOR-30-12.md)',
    );
  });
});

// ─── the fine-state vocabulary is ONE contract (ADR-0007) ────────────────────
//
// `ROW_STATES` is hand-mirrored from the state-machine's `ISSUE_STATES` so the
// reader/writer need not import that module for the literal set. Nothing pinned
// the mirror, so a state added to one and not the other drifted silently — the
// spine would reject (CLI) or mis-route (resume) a state the engine considers
// legal. `parked` (ADR-0022) is the first addition since; this guard is what
// makes "the values are identical" true rather than aspirational.
describe('ROW_STATES ⇔ ISSUE_STATES parity (the mirrored vocabulary must not drift)', () => {
  it('is the same set, in the same order', () => {
    expect([...ROW_STATES]).toEqual([...ISSUE_STATES]);
  });

  it('carries parked — the spine can durably record the ADR-0022 state', () => {
    expect(ROW_STATES).toContain('parked');
  });
});

describe('parked rows in the spine (ADR-0022)', () => {
  it('setRowState → parked renders, re-parses, and touches exactly the State cell', () => {
    const out = setRowState(SPINE, '54', 'parked');
    expect(readSpine(out).planTable[0].state).toBe('parked');

    // byte-safety: only the one row's line differs from the source.
    const before = SPINE.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after
      .map((l, i) => (l === before[i] ? null : i))
      .filter((i) => i !== null);
    expect(changed).toHaveLength(1);
  });

  it('a parked row round-trips byte-identically on a no-op re-write', () => {
    const parked = setRowState(SPINE, '54', 'parked');
    expect(setRowState(parked, '54', 'parked')).toBe(parked);
  });

  it('parked survives a full read → write cycle alongside its siblings', () => {
    // park one row, flip another — the parked cell must be untouched by the
    // neighbouring write (the resume-authoritative table stays trustworthy).
    let src = setRowState(SPINE, '54', 'parked');
    src = setRowState(src, '55', 'pr-created');
    const table = readSpine(src).planTable;
    expect(table.find((r) => r.id === '54')?.state).toBe('parked');
    expect(table.find((r) => r.id === '55')?.state).toBe('pr-created');
  });
});

describe('draft-spine tolerance', () => {
  it('reads a minimal spine with no PR-Log / Conflict-Map / dispatch-log', () => {
    const minimal = `# Wave X

**Status:** draft

## Plan-Table

| ID  | Title | Worker          | Risk       | Reviewer     | PR  | State   | Iter | Reports → Verdicts |
| --- | ----- | --------------- | ---------- | ------------ | --- | ------- | ---- | ------------------ |
| 01  | Foo   | background-heavy | mechanical | quick-verify | —   | planned | 1    | —                  |

## Closed-by

_(written at close time)_
`;
    const spine = readSpine(minimal);
    expect(spine.frontmatter.status).toBe('draft');
    expect(spine.planTable).toHaveLength(1);
    expect(spine.prLog).toHaveLength(0);
    expect(spine.dispatchLog).toHaveLength(0);
    expect(spine.conflictMap.cells).toHaveLength(0);
    // No-op state write is still byte-identical.
    expect(setRowState(minimal, '01', 'planned')).toBe(minimal);
  });
});

// ─── Branch-recording: upsertDispatchLogEntry + branchesByIssueId ─────────────

/**
 * Spine that has a dispatch-log with NO branch ref in the first entry (simulates
 * a driver-dispatched wave where the Coordinator did not record branches yet).
 */
const SPINE_NO_BRANCHES = `# Wave 2026-06-06 — wave-orch-tooling-backlog

**Status:** in-flight
**Coordinator:** at//design + Sonnet 4.6
**Created:** 2026-06-06
**Last-updated:** 2026-06-06 — flipped ready→in-flight

## Plan-Table

| ID  | Title                   | Worker            | Risk              | Reviewer     | PR  | State      | Iter | Reports → Verdicts |
| --- | ----------------------- | ----------------- | ----------------- | ------------ | --- | ---------- | ---- | ------------------ |
| 83  | Record branch names     | background | isolated-refactor | quick-verify | —   | dispatched | 1    | —                  |
| 84  | Merge-order Plan-Table  | background | isolated-refactor | quick-verify | —   | dispatched | 1    | —                  |

## Conflict-Map

No conflicts.

## PR-Log

| Created | ID  | PR  | Closes | Merged | Notes                                      |
| ------- | --- | --- | ------ | ------ | ------------------------------------------ |
| —       | —   | —   | —      | —      | _(no PRs yet — populated at \`pr-created\`)_ |

## Resume-Metadata

\`\`\`yaml
last-tick: 2026-06-06
in-flight-issues: [83, 84]
coordinator-head: 22dad7e13ed40941a7df22e49b8e73baea031b71
remote-host: bitbucket (auth present)
dispatch-log:
  - "83 → agent wf_abc123 (sonnet) dispatched"
  - "84 → agent wf_def456 (sonnet) dispatched"
notes: |
  Tooling-backlog wave.
\`\`\`

## Closed-by

_(written at close time)_
`;

describe('upsertDispatchLogEntry — branch recording', () => {
  it('adds a branch on a spine whose dispatch-log entry has no branch ref', () => {
    const out = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '83',
      'wave-orch/83-record-branch-names',
    );
    // Line count unchanged (in-place replacement, not append).
    expect(out.split('\n')).toHaveLength(SPINE_NO_BRANCHES.split('\n').length);
    const spine = readSpine(out);
    // Round-trip: branchesByIssueId picks it up.
    expect(branchesByIssueId(spine)['83']).toBe(
      'wave-orch/83-record-branch-names',
    );
    // planTable row.branch is also resolved via resolveBranches.
    expect(spine.planTable.find((r) => r.id === '83')?.branch).toBe(
      'wave-orch/83-record-branch-names',
    );
    // Other rows unaffected.
    expect(spine.planTable.find((r) => r.id === '84')?.branch).toBeNull();
  });

  it('updates an existing branch ref in the dispatch-log entry', () => {
    // First, record the branch.
    const after1 = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '83',
      'wave-orch/83-record-branch-names',
    );
    // Re-record with a corrected name.
    const after2 = upsertDispatchLogEntry(
      after1,
      '83',
      'wave-orch/83-record-branch-names-corrected',
    );
    // Line count unchanged (still in-place replacement).
    expect(after2.split('\n')).toHaveLength(after1.split('\n').length);
    const spine = readSpine(after2);
    expect(branchesByIssueId(spine)['83']).toBe(
      'wave-orch/83-record-branch-names-corrected',
    );
  });

  it('is idempotent — re-writing the same branch is a no-diff operation', () => {
    const after1 = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '83',
      'wave-orch/83-record-branch-names',
    );
    const after2 = upsertDispatchLogEntry(
      after1,
      '83',
      'wave-orch/83-record-branch-names',
    );
    expect(after2).toBe(after1);
  });

  it('appends a new entry when no dispatch-log entry exists for the given id', () => {
    // Build a spine whose dispatch-log has no entry for id 99.
    const out = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '99',
      'wave-orch/99-new-issue',
    );
    // One new line was added.
    expect(out.split('\n')).toHaveLength(
      SPINE_NO_BRANCHES.split('\n').length + 1,
    );
    const spine = readSpine(out);
    expect(branchesByIssueId(spine)['99']).toBe('wave-orch/99-new-issue');
    // Existing entries untouched.
    expect(spine.dispatchLog.find((e) => e.id === '83')?.branch).toBeNull();
  });

  it('round-trip: write → parse → branchesByIssueId[id] === branch', () => {
    const id = '84';
    const branch = 'wave-orch/84-merge-order-plan-table';
    const out = upsertDispatchLogEntry(SPINE_NO_BRANCHES, id, branch);
    const spine = readSpine(out);
    expect(branchesByIssueId(spine)[id]).toBe(branch);
  });

  it('throws when the spine has no Resume-Metadata section', () => {
    const noMeta = `# Wave X

**Status:** draft

## Plan-Table

| ID  | Title | Worker | Risk | Reviewer | PR  | State   | Iter | Reports → Verdicts |
| --- | ----- | ------ | ---- | -------- | --- | ------- | ---- | ------------------ |
| 01  | Foo   | agent  | low  | quick    | —   | planned | 1    | —                  |
`;
    expect(() =>
      upsertDispatchLogEntry(noMeta, '01', 'wave-orch/01-foo'),
    ).toThrow(/Resume-Metadata/);
  });

  it('throws when Resume-Metadata has no dispatch-log key', () => {
    const noDispatchLog = `# Wave X

**Status:** draft

## Resume-Metadata

\`\`\`yaml
last-tick: 2026-06-06
\`\`\`
`;
    expect(() =>
      upsertDispatchLogEntry(noDispatchLog, '01', 'wave-orch/01-foo'),
    ).toThrow(/dispatch-log/);
  });
});

// ─── Model-recording: upsertDispatchLogModel + DispatchLogEntry.model (P7) ────
// ADR-0012: the *actually-dispatched* model is recorded by the driver in the
// spine dispatch-log at dispatch time (re-tuning signal), never self-reported.

describe('upsertDispatchLogModel + model parsing (P7, ADR-0012)', () => {
  it('records a model token and parses it back into entry.model', () => {
    const out = upsertDispatchLogModel(SPINE_NO_BRANCHES, '83', 'claude-opus-4-8');
    const entry = readSpine(out).dispatchLog.find((e) => e.id === '83');
    expect(entry?.model).toBe('claude-opus-4-8');
  });

  it('does not mistake the free-text "(sonnet)" note for a model token', () => {
    // SPINE_NO_BRANCHES entries carry "(sonnet)" as prose, not a `model` token.
    const entry = readSpine(SPINE_NO_BRANCHES).dispatchLog.find((e) => e.id === '83');
    expect(entry?.model).toBeNull();
  });

  it('records a model alongside an existing branch without disturbing it', () => {
    const withBranch = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '83',
      'wave-orch/83-foo',
    );
    const withModel = upsertDispatchLogModel(withBranch, '83', 'claude-opus-4-8');
    const spine = readSpine(withModel);
    const entry = spine.dispatchLog.find((e) => e.id === '83');
    expect(entry?.branch).toBe('wave-orch/83-foo');
    expect(entry?.model).toBe('claude-opus-4-8');
    // Branch still round-trips through the convenience accessor.
    expect(branchesByIssueId(spine)['83']).toBe('wave-orch/83-foo');
  });

  it('co-exists in either write order — model first, then branch', () => {
    const withModel = upsertDispatchLogModel(SPINE_NO_BRANCHES, '83', 'claude-opus-4-8');
    const both = upsertDispatchLogEntry(withModel, '83', 'wave-orch/83-foo');
    const entry = readSpine(both).dispatchLog.find((e) => e.id === '83');
    expect(entry?.model).toBe('claude-opus-4-8');
    expect(entry?.branch).toBe('wave-orch/83-foo');
  });

  it('replaces an existing model ref in place (line count unchanged)', () => {
    const a = upsertDispatchLogModel(SPINE_NO_BRANCHES, '83', 'claude-sonnet-4-6');
    const b = upsertDispatchLogModel(a, '83', 'claude-opus-4-8');
    expect(b.split('\n')).toHaveLength(a.split('\n').length);
    expect(readSpine(b).dispatchLog.find((e) => e.id === '83')?.model).toBe(
      'claude-opus-4-8',
    );
  });

  it('is idempotent — re-writing the same model is a no-diff operation', () => {
    const a = upsertDispatchLogModel(SPINE_NO_BRANCHES, '83', 'claude-opus-4-8');
    const b = upsertDispatchLogModel(a, '83', 'claude-opus-4-8');
    expect(b).toBe(a);
  });

  it('appends a new entry when no dispatch-log entry exists for the id', () => {
    const out = upsertDispatchLogModel(SPINE_NO_BRANCHES, '99', 'claude-opus-4-8');
    expect(out.split('\n')).toHaveLength(SPINE_NO_BRANCHES.split('\n').length + 1);
    expect(readSpine(out).dispatchLog.find((e) => e.id === '99')?.model).toBe(
      'claude-opus-4-8',
    );
  });

  it('throws when the spine has no Resume-Metadata section', () => {
    const noMeta = `# Wave X\n\n**Status:** draft\n`;
    expect(() => upsertDispatchLogModel(noMeta, '01', 'claude-opus-4-8')).toThrow(
      /Resume-Metadata/,
    );
  });
});

describe('branchesByIssueId — convenience accessor', () => {
  it('returns empty object for a spine with no branch refs', () => {
    const spine = readSpine(SPINE_NO_BRANCHES);
    // No branch refs in the dispatch-log entries.
    expect(branchesByIssueId(spine)).toEqual({});
  });

  it('returns populated map after upsertDispatchLogEntry', () => {
    const out = upsertDispatchLogEntry(
      SPINE_NO_BRANCHES,
      '83',
      'wave-orch/83-record-branch-names',
    );
    const spine = readSpine(out);
    expect(branchesByIssueId(spine)).toMatchObject({
      '83': 'wave-orch/83-record-branch-names',
    });
  });

  it('returns branches from the original SPINE fixture (dispatch-log has refs)', () => {
    const spine = readSpine(SPINE);
    const map = branchesByIssueId(spine);
    expect(map['54']).toBe('wave-orch/54-wave-md-rw');
    expect(map['55']).toBe('wave-orch/55-closed-by');
    // #58 had no branch in its dispatch-log entry.
    expect(map['58']).toBeUndefined();
  });
});

describe('renderConflictMap', () => {
  it('round-trips pairwise cells through readConflictMap', () => {
    const cm = { issues: ['#1', '#2'], cells: [{ a: '#1', b: '#2', files: ['a.ts', 'b.ts'] }] };
    const section = `## Conflict-Map\n\n${renderConflictMap(cm)}\n`;
    const back = readSpine(section).conflictMap;
    expect(back.cells).toHaveLength(1);
    expect(back.cells[0]).toEqual({ a: '#1', b: '#2', files: ['a.ts', 'b.ts'] });
  });

  it('renders the empty (disjoint) case to a no-cell body', () => {
    const section = `## Conflict-Map\n\n${renderConflictMap({ issues: [], cells: [] })}\n`;
    expect(readSpine(section).conflictMap.cells).toHaveLength(0);
  });
});

describe('renderSpine', () => {
  const meta = {
    slug: 'demo', description: 'a demo wave', coordinator: 'at',
    model: 'Opus 4.8', created: '2026-06-18', lastUpdated: '2026-06-18 10:00 CEST',
  };
  const roster = [
    { id: '1', title: 'First issue', worker: 'background', risk: 'mechanical' },
    { id: '2', title: 'Second issue', worker: 'HITL-required', risk: 'public-API-change' },
  ];
  const conflict = { issues: ['1', '2'], cells: [{ a: '1', b: '2', files: ['x.ts'] }] };

  it('round-trips frontmatter + plan-table + conflict-map through readSpine', () => {
    const spine = readSpine(renderSpine(meta, roster, conflict, 'all pass.'));
    expect(spine.frontmatter.status).toBe('draft');
    expect(spine.frontmatter.created).toBe('2026-06-18');
    expect(spine.planTable).toHaveLength(2);
    expect(spine.planTable[0]).toMatchObject({
      id: '1', title: 'First issue', worker: 'background', risk: 'mechanical',
      reviewer: 'universal', prCell: '—', state: 'planned', iter: 1,
    });
    expect(spine.conflictMap.cells[0]).toEqual({ a: '1', b: '2', files: ['x.ts'] });
  });

  it('leaves PR-Log / dispatch-log / closed-by empty at create', () => {
    const spine = readSpine(renderSpine(meta, roster, { issues: [], cells: [] }, 'ok.'));
    expect(spine.prLog).toHaveLength(0);
    expect(spine.dispatchLog).toHaveLength(0);
    expect(spine.closedBy.body.trim()).toBe('');
  });

  it('scaffolds a dispatch-log: key that upsert can write + branchesByIssueId recovers', () => {
    const rendered = renderSpine(meta, roster, conflict, 'all pass.');
    // The freshly-rendered spine must be a valid target for a branch write —
    // upsert throws "no dispatch-log: key" if renderSpine forgot to scaffold it.
    const written = upsertDispatchLogEntry(rendered, '1', 'wave/1-first');
    const spine = readSpine(written);
    expect(branchesByIssueId(spine)['1']).toBe('wave/1-first');
  });

  it('pipe in title does not shift downstream columns (Fix 1 regression)', () => {
    // A title containing `|` would, without sanitization, break splitTableRow
    // and shift every column after Title — worker would be read as risk, etc.
    const pipeRoster = [
      { id: '1', title: 'fix a | b parser', worker: 'background', risk: 'mechanical' },
    ];
    const rendered = renderSpine(meta, pipeRoster, { issues: [], cells: [] }, 'ok.');
    const spine = readSpine(rendered);
    expect(spine.planTable).toHaveLength(1);
    const row = spine.planTable[0];
    // Downstream columns must NOT be shifted.
    expect(row.worker).toBe('background');
    expect(row.risk).toBe('mechanical');
    expect(row.state).toBe('planned');
    // The title must round-trip back to its original semantic value.
    expect(row.title).toBe('fix a | b parser');
  });

  it('sidecar links include the <slug>/ segment (relative to the spine dir)', () => {
    // The spine is the FLAT file .flotilla/waves/<slug>.md — its directory is
    // .flotilla/waves/. The sidecar dirs are .flotilla/waves/<slug>/reports/ and
    // .flotilla/waves/<slug>/verdicts/ (sibling subdir, not beside a WAVE.md).
    // A link relative to the spine's directory must include the <slug>/ segment:
    // './<slug>/reports/...' resolves to .flotilla/waves/<slug>/reports/ — correct.
    const rendered = renderSpine(meta, roster, conflict, 'all pass.');
    expect(rendered).toContain('[r1](./demo/reports/1-1.md)');
    expect(rendered).toContain('[v1](./demo/verdicts/1-1.md)');
  });

  // ── Disclosures scaffolding (ADR-0027 wiring — issue #177) ──────────────────
  //
  // `spine create` used to compose `ensureDisclosuresSection` on top of this
  // function's output because the section grew in later, on spines that
  // pre-date it. That composition is now a no-op: `renderSpine` scaffolds the
  // same empty section directly, so its presence is uniform from birth and the
  // ensure path's "already there" branch is what a fresh spine actually hits.

  it('scaffolds the empty Disclosures section on every fresh spine', () => {
    const rendered = renderSpine(meta, roster, conflict, 'all pass.');
    expect(rendered).toContain('## Disclosures');
    expect(rendered).toContain('| Ref | Row | Iter | Source | Disposition | Text |');
    // It reads back as zero entries — the table is scaffolded, not populated.
    expect(readDisclosures(rendered)).toEqual([]);
    // Every pre-existing section still parses; the new tail section is additive.
    const spine = readSpine(rendered);
    expect(spine.planTable).toHaveLength(2);
    expect(spine.closedBy.body.trim()).toBe('');
  });

  it("ensureDisclosuresSection composed on top is a byte-identical no-op — the ensure path finds it already present", () => {
    const rendered = renderSpine(meta, roster, conflict, 'all pass.');
    expect(ensureDisclosuresSection(rendered)).toBe(rendered);
  });

  it('the Disclosures section is the LAST section, after Closed-by — Closed-by\'s body does not swallow it', () => {
    const rendered = renderSpine(meta, roster, conflict, 'all pass.');
    const lines = rendered.split('\n');
    const closedByIdx = lines.indexOf('## Closed-by');
    const disclosuresIdx = lines.indexOf('## Disclosures');
    expect(closedByIdx).toBeGreaterThan(-1);
    expect(disclosuresIdx).toBeGreaterThan(closedByIdx);
    expect(readSpine(rendered).closedBy.body).not.toContain('Disclosures');
  });

  it('BACKWARD COMPATIBLE: a legacy spine without the section still reads — the lenient-missing branch stays legacy tolerance', () => {
    // A pre-ADR-0027 spine (rendered before this issue existed, or hand-built
    // for a test) has no `## Disclosures` heading at all.
    const legacy = renderSpine(meta, roster, conflict, 'all pass.').replace(
      /\n## Disclosures[\s\S]*$/,
      '\n',
    );
    expect(legacy).not.toContain('## Disclosures');
    // readSpine still parses everything before it, and the disclosure reader
    // (spine-store.ts) tolerates the missing section as zero entries rather
    // than throwing.
    expect(readSpine(legacy).planTable).toHaveLength(2);
    expect(readDisclosures(legacy)).toEqual([]);
  });
});

describe('package root re-exports — the disclosure surface (issue #177)', () => {
  // The barrel (index.ts) used explicit named re-exports, so the disclosure
  // read/ensure/add/set-disposition surface — landed inside spine-store.ts —
  // was never wired onto the package root a consumer actually imports from.
  // This proves each of the four verbs, plus the `Disclosure` type, resolves
  // through './index' rather than only through the internal module path.
  const rootMeta = {
    slug: 'demo', description: 'a demo wave', coordinator: 'at',
    model: 'Opus 4.8', created: '2026-07-29', lastUpdated: '2026-07-29 10:00',
  };
  const rootRoster = [
    { id: '1', title: 'First issue', worker: 'background', risk: 'mechanical' },
  ];

  it('read/ensure/add/set-disposition + the Disclosure type are importable from the package root', () => {
    const rendered = renderSpine(rootMeta, rootRoster, { issues: [], cells: [] }, 'ok.');

    // ensure — already scaffolded by renderSpine, so this is a no-op.
    expect(ensureDisclosuresSectionFromRoot(rendered)).toBe(rendered);
    // read — zero entries on the fresh, unpopulated section.
    expect(readDisclosuresFromRoot(rendered)).toEqual([]);

    // add — captures one entry at `open`.
    const { source: withOne, disclosure } = addDisclosureToSourceFromRoot(rendered, {
      rowId: '1',
      iter: 1,
      source: 'worker',
      text: 'the barrel export lies outside the declared Files globs',
    });
    expect(disclosure.ref).toBe('1.1');

    // set-disposition — closes it out.
    const dispositioned = setDispositionInSourceFromRoot(withOne, '1.1', 'resolved-in-slice');
    const entries: DisclosureFromRoot[] = readDisclosuresFromRoot(dispositioned);
    expect(entries).toHaveLength(1);
    expect(entries[0].disposition).toBe('resolved-in-slice');
  });

  it('the WAVE-SCOPED capture verb + its two sentinel cells cross the barrel too (ADR-0038)', () => {
    // The same barrel-gap class this describe block exists for, one term later:
    // the wave-scoped half is engine-complete, and a consumer reaching the
    // package root must be able to capture AND to tell the two scopes apart in
    // a parsed entry. The compile-time half — `WaveDisclosureInput` really
    // crossing — is the annotation below, asserted by `tsc --noEmit`.
    const rendered = renderSpine(rootMeta, rootRoster, { issues: [], cells: [] }, 'ok.');

    const input: WaveDisclosureInputFromRoot = {
      source: 'coordinator',
      text: 'a close-phase find owned by no row',
    };
    const { source: withWave, disclosure } = addWaveDisclosureToSourceFromRoot(rendered, input);

    expect(disclosure.ref).toBe(`${WAVE_SCOPE_ROW_FROM_ROOT}.1`);
    expect(disclosure.iter).toBeNull();
    expect(withWave).toContain(
      `| wave.1 | ${WAVE_SCOPE_ROW_FROM_ROOT} | ${WAVE_SCOPE_ITER_CELL_FROM_ROOT} | coordinator | open |`,
    );

    // Root-only, a consumer discriminates on the same two sentinels the engine
    // writes — no private literal to re-spell.
    const parsed = readDisclosuresFromRoot(withWave);
    expect(parsed.filter((d) => d.rowId === WAVE_SCOPE_ROW_FROM_ROOT)).toHaveLength(1);

    // …and the root's own disposition verb closes it out by the printed ref.
    expect(
      readDisclosuresFromRoot(
        setDispositionInSourceFromRoot(withWave, disclosure.ref, 'filed:#487'),
      )[0].disposition,
    ).toBe('filed:#487');
  });
});

describe('setFrontmatterStatus', () => {
  // The SPINE fixture used throughout this file has **Status:** in-flight.
  it('flips the Status line, preserving the rest byte-for-byte', () => {
    const flipped = setFrontmatterStatus(SPINE, 'ready');
    expect(readSpine(flipped).frontmatter.status).toBe('ready');
    // Re-flipping back to the original value yields the original bytes.
    expect(setFrontmatterStatus(flipped, 'in-flight')).toBe(SPINE);
  });

  it('is byte-identical on a no-op flip to the same value', () => {
    const cur = readSpine(SPINE).frontmatter.status!;
    expect(setFrontmatterStatus(SPINE, cur)).toBe(SPINE);
  });

  it('throws when the spine has no Status field', () => {
    const noStatus = '# Wave x\n\n**Coordinator:** y\n\n## Plan-Table\n';
    expect(() => setFrontmatterStatus(noStatus, 'ready')).toThrow(/Status/);
  });

  it('changes exactly one line (the Status line) and nothing else', () => {
    const out = setFrontmatterStatus(SPINE, 'closed');
    const la = SPINE.split('\n');
    const lb = out.split('\n');
    const changed = la.reduce<number[]>(
      (acc, line, i) => (line !== lb[i] ? [...acc, i] : acc),
      [],
    );
    expect(changed).toHaveLength(1);
    expect(lb[changed[0]]).toContain('**Status:** closed');
  });

  it('SPINE_STATUSES exports the four expected tokens', () => {
    expect(SPINE_STATUSES).toEqual(['draft', 'ready', 'in-flight', 'closed']);
  });
});

describe('pipe-hardening — every writer cell escapes, the WAL parser fails loud (P8 carryover)', () => {
  // The spine is the resume-authoritative WAL: a raw `|` in ANY cell shifts
  // downstream columns, and a row with the wrong cell count must never vanish
  // silently — resume would simply never see that issue again.
  const meta = {
    slug: 'demo', description: 'a demo wave', coordinator: 'at',
    model: 'Opus 4.8', created: '2026-07-10', lastUpdated: '2026-07-10 10:00 CEST',
  };

  it('renderSpine escapes pipes in Worker/Risk cells, not only Title', () => {
    const roster = [
      { id: '1', title: 'plain', worker: 'HITL|required', risk: 'public|API' },
    ];
    const spine = readSpine(renderSpine(meta, roster, { issues: [], cells: [] }, 'ok.'));
    expect(spine.planTable).toHaveLength(1);
    const row = spine.planTable[0];
    expect(row.worker).toBe('HITL|required');
    expect(row.risk).toBe('public|API');
    // Downstream columns must NOT be shifted.
    expect(row.state).toBe('planned');
    expect(row.iter).toBe(1);
  });

  it('setRowPrCell with a pipe in the link text does not shift the State column', () => {
    const out = setRowPrCell(SPINE, '54', '[PR#7 | hotfix](https://example.com/pr/7)');
    const spine = readSpine(out);
    const row = spine.planTable.find((r) => r.id === '54')!;
    expect(row.prCell).toBe('[PR#7 | hotfix](https://example.com/pr/7)');
    expect(row.prUrl).toBe('https://example.com/pr/7');
    expect(row.state).toBe('planned');
    expect(row.iter).toBe(1);
  });

  it('upsertPrLogRow with a pipe in Notes round-trips without shifting columns', () => {
    const out = upsertPrLogRow(SPINE, {
      created: '2026-07-10', id: '54',
      prCell: '[PR#7](https://example.com/pr/7)',
      closes: '#54', merged: 'no', notes: 'retry | see dispatch-log',
    });
    const spine = readSpine(out);
    expect(spine.prLog).toHaveLength(1);
    expect(spine.prLog[0].merged).toBe('no');
    expect(spine.prLog[0].notes).toBe('retry | see dispatch-log');
  });

  it('readSpine throws loud on a Plan-Table data row with too few cells', () => {
    const corrupt = [
      '# Wave 2026-07-10 — demo (x)', '',
      '## Plan-Table', '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | t | w | r | universal | — | planned | 1 |', '',
    ].join('\n');
    expect(() => readSpine(corrupt)).toThrow(/Plan-Table/);
  });

  it('readSpine throws loud on a Plan-Table data row with an extra raw pipe', () => {
    // Without the guard this row parses SHIFTED (10 cells) — worse than vanishing.
    const corrupt = [
      '# Wave 2026-07-10 — demo (x)', '',
      '## Plan-Table', '',
      '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 1 | fix a | b parser | w | r | universal | — | planned | 1 | [r1](./x) |', '',
    ].join('\n');
    expect(() => readSpine(corrupt)).toThrow(/Plan-Table/);
  });

  it('tolerates an Ur-legacy 2-column Plan-Table as "no Plan-Table" (merge-order fallback shape)', () => {
    // The Ur's spines carry `| ID | Title |` tables read by merge-order's
    // footnote parser, not by readPlanTable. The header defines the schema:
    // a non-9-column header means "not a flotilla Plan-Table" — empty, not
    // corrupt. Strictness applies only within flotilla-rendered 9-col tables.
    const legacy = [
      '# Legacy wave', '',
      '## Plan-Table', '',
      '| ID  | Title |',
      '| --- | ----- |',
      '| tf/02 | Second [^source-tf-02] |', '',
    ].join('\n');
    expect(readSpine(legacy).planTable).toEqual([]);
  });

  it('readSpine throws loud on a malformed PR-Log data row', () => {
    const corrupt = [
      '# Wave 2026-07-10 — demo (x)', '',
      '## PR-Log', '',
      '| Created | ID | PR | Closes | Merged | Notes |',
      '|---|---|---|---|---|---|',
      '| 2026-07-10 | 54 | [x](https://h) | #54 | yes | note | extra |', '',
    ].join('\n');
    expect(() => readSpine(corrupt)).toThrow(/PR-Log/);
  });
});

// ─── issue #141: the dispatch-log parse-back is the writer's inverse ─────────
//
// Measured on a live wave whose Workers were dispatched on branch names outside
// the `wave/` convention: the dispatch-log recorded all six branches, and the
// parse-back returned `{}` — not a partial result, nothing. The reader keyed off
// a `wave/` | `wave-orch/` PREFIX; the writer accepts any ref and enforces no
// convention, so the two were never a round-trip. The reader now anchors on the
// writer's own `branch <ref>` keyword instead (the same way `model <id>` is
// read), which is convention-blind by construction.

/** A tracker-backed spine (bare-number ids, no footnotes) with the given dispatch-log entries. */
function spineWithDispatchLog(entries: string[]): string {
  return [
    '# Wave 2026-07-27 — free-form-branches',
    '',
    '**Status:** in-flight',
    '',
    '## Plan-Table',
    '',
    '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 131 | Alpha | background | mechanical | universal | — | dispatched | 1 | — |',
    '| 132 | Beta | background | mechanical | universal | — | dispatched | 1 | — |',
    '',
    '## Resume-Metadata',
    '',
    '```yaml',
    'dispatch-log:',
    ...entries.map((e) => `  - "${e}"`),
    '```',
    '',
  ].join('\n');
}

describe('dispatch-log branch parse-back — any ref name round-trips (issue #141)', () => {
  it('recovers branches that follow NO naming convention — the exact shape that yielded {} on a live wave', () => {
    const spine = readSpine(
      spineWithDispatchLog([
        '131 → agent wf_aaa (sonnet) branch w28/131-alpha',
        '132 → agent wf_bbb (sonnet) branch feature/132-beta',
      ]),
    );
    expect(branchesByIssueId(spine)).toEqual({
      '131': 'w28/131-alpha',
      '132': 'feature/132-beta',
    });
  });

  it('recovers a ref with no slash at all — the writer never required one', () => {
    const spine = readSpine(
      spineWithDispatchLog(['131 → agent wf_aaa branch hotfix_131']),
    );
    expect(branchesByIssueId(spine)['131']).toBe('hotfix_131');
  });

  it('resolves the Plan-Table row branch from a free-form ref too, not just the accessor', () => {
    const spine = readSpine(
      spineWithDispatchLog(['131 → agent wf_aaa branch w28/131-alpha']),
    );
    expect(spine.planTable.find((r) => r.id === '131')?.branch).toBe(
      'w28/131-alpha',
    );
  });

  it('round-trips through the WRITER for a ref outside the convention — write → read → same string', () => {
    // The property the pair must have: whatever `upsertDispatchLogEntry`
    // accepts, `readSpine` gives back. Drive it through the real writer rather
    // than a hand-authored fixture, so a future writer change cannot drift.
    for (const branch of [
      'w28/131-alpha',
      'feature/131-alpha',
      'hotfix_131',
      'users/at/131-alpha',
      'wave/131-alpha',
    ]) {
      const written = upsertDispatchLogEntry(
        spineWithDispatchLog(['131 → agent wf_aaa dispatched']),
        '131',
        branch,
      );
      expect(branchesByIssueId(readSpine(written))['131']).toBe(branch);
    }
  });

  it('replacing a free-form branch is still in-place (line count unchanged) and idempotent', () => {
    const base = spineWithDispatchLog(['131 → agent wf_aaa dispatched']);
    const a = upsertDispatchLogEntry(base, '131', 'w28/131-alpha');
    const b = upsertDispatchLogEntry(a, '131', 'w28/131-alpha-corrected');
    expect(b.split('\n')).toHaveLength(a.split('\n').length);
    expect(branchesByIssueId(readSpine(b))['131']).toBe('w28/131-alpha-corrected');
    expect(upsertDispatchLogEntry(b, '131', 'w28/131-alpha-corrected')).toBe(b);
  });

  it('a model token written alongside a free-form branch disturbs neither', () => {
    let src = spineWithDispatchLog(['131 → agent wf_aaa dispatched']);
    src = upsertDispatchLogEntry(src, '131', 'w28/131-alpha');
    src = upsertDispatchLogModel(src, '131', 'claude-opus-5');
    const entry = readSpine(src).dispatchLog.find((e) => e.id === '131');
    expect(entry?.branch).toBe('w28/131-alpha');
    expect(entry?.model).toBe('claude-opus-5');
  });

  it('still recovers a LEGACY entry that names a wave-orch ref with no `branch` keyword', () => {
    const spine = readSpine(
      spineWithDispatchLog(['131 → agent wf_aaa wave-orch/131-alpha']),
    );
    expect(branchesByIssueId(spine)['131']).toBe('wave-orch/131-alpha');
  });

  it('does NOT mistake a prose reference to another row for a branch (no `branch` keyword, no slug tail)', () => {
    // The SPINE fixture's held row: `… stacked on wave-orch/54 once #54 …`.
    const spine = readSpine(
      spineWithDispatchLog([
        '131 → L2, held: stacked on wave-orch/54 once #54 reports in',
      ]),
    );
    expect(spine.dispatchLog[0].branch).toBeNull();
    expect(branchesByIssueId(spine)).toEqual({});
  });
});

describe('requireBranchesByIssueId — the empty map is never handed back ambiguously (issue #141)', () => {
  it('throws when the dispatch-log HAS entries but yields no branch', () => {
    // SPINE_NO_BRANCHES: two `… dispatched` entries, neither recording a branch.
    // The lenient accessor answers `{}` — indistinguishable from a wave that was
    // never dispatched, and that ambiguity is what three consumers degraded on.
    const spine = readSpine(SPINE_NO_BRANCHES);
    expect(branchesByIssueId(spine)).toEqual({});
    expect(() => requireBranchesByIssueId(spine)).toThrow(
      /no branch could be recovered/,
    );
  });

  it('names the entry count and quotes the unparsed entries, so the failure is diagnosable', () => {
    const spine = readSpine(SPINE_NO_BRANCHES);
    let message = '';
    try {
      requireBranchesByIssueId(spine);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('2 entries');
    expect(message).toContain('83 → agent wf_abc123 (sonnet) dispatched');
  });

  it('does NOT throw for a genuinely un-dispatched wave (no dispatch-log entries at all)', () => {
    // A freshly-rendered spine has a scaffolded but EMPTY dispatch-log. `{}` is
    // the honest answer there — there is nothing to disagree about.
    const rendered = renderSpine(
      { slug: 'fresh', description: 'd', coordinator: 'c', model: 'm', created: '2026-07-27', lastUpdated: '2026-07-27' },
      [{ id: '1', title: 'First', worker: 'background', risk: 'mechanical' }],
      { issues: [], cells: [] },
      'PASS',
    );
    const spine = readSpine(rendered);
    expect(spine.dispatchLog).toHaveLength(0);
    expect(requireBranchesByIssueId(spine)).toEqual({});
  });

  it('does NOT throw when at least one entry yields a branch (partial recovery is a real state)', () => {
    const spine = readSpine(
      spineWithDispatchLog([
        '131 → agent wf_aaa branch w28/131-alpha',
        '132 → agent wf_bbb dispatched',
      ]),
    );
    expect(requireBranchesByIssueId(spine)).toEqual({ '131': 'w28/131-alpha' });
  });

  it('returns exactly what the lenient accessor returns whenever it does not throw', () => {
    const spine = readSpine(
      spineWithDispatchLog(['131 → agent wf_aaa branch feature/131-alpha']),
    );
    expect(requireBranchesByIssueId(spine)).toEqual(branchesByIssueId(spine));
  });
});

// ─── issue #141 AC6: the resume join, driven with an out-of-convention ref ────
//
// This is the third consumer of the empty map, and the most expensive failure:
// resume finds no branches, concludes nothing was dispatched, and re-dispatches
// rows whose work is already committed — the precise failure ADR-0021 exists to
// close. `resume()` joins its worktrees to rows via `branchesByIssueId` (it
// imports it from this module), so the branch-name shape that produced `{}` on
// the live wave is exactly what this drives.

/** A SidecarIndex with nothing on disk — no report, no verdict, no corruption. */
const NO_SIDECARS: SidecarIndex = {
  reportFor: () => null,
  verdictFor: () => null,
  corruptFor: () => [],
};

describe('resume join — a branch named outside the convention still joins its worktree (issue #141)', () => {
  const OFF_CONVENTION = 'w28/131-alpha';

  const spineSource = spineWithDispatchLog([
    `131 → agent wf_aaa (sonnet) branch ${OFF_CONVENTION}`,
    '132 → agent wf_bbb (sonnet) branch feature/132-beta',
  ]);

  const worktree = (branch: string): WorktreeEntry => ({
    path: `/repo/.claude/worktrees/wf_${branch.replace(/\W/g, '_')}`,
    branch,
    head: 'abc1234',
    dirty: false,
  });

  it('adopts the live worktree instead of re-dispatching work that is already committed', () => {
    const result = resume({
      spine: readSpine(spineSource),
      worktrees: [worktree(OFF_CONVENTION), worktree('feature/132-beta')],
      sidecars: NO_SIDECARS,
    });

    const row131 = result.rows.find((r) => r.id === '131');
    expect(row131?.branch).toBe(OFF_CONVENTION);
    expect(row131?.worktree?.branch).toBe(OFF_CONVENTION);
    // Pre-fix the branch map was {}, so `branch` was null, no worktree could be
    // matched, and a `dispatched` row fell to PRE_LANDING → 'redispatch'.
    expect(row131?.decision).toBe('adopt');
    expect(result.rows.map((r) => r.decision)).toEqual(['adopt', 'adopt']);
  });

  it('every row recovers a non-null branch — none falls back to the null-branch path', () => {
    const result = resume({
      spine: readSpine(spineSource),
      worktrees: [],
      sidecars: NO_SIDECARS,
    });
    expect(result.rows.map((r) => r.branch)).toEqual([
      OFF_CONVENTION,
      'feature/132-beta',
    ]);
  });
});

// ─── the human-gated dispatch lane (the HITL gate, issue #292) ────────────────
//
// `HITL-required` is a first-class Worker value: real wave work that ENTERS a
// wave and is merely human-gated (ADR-0012) — not the triage terminal
// `ready-for-human`, which never enters one (ADR-0015). The engine's job here is
// narrow and total: name the token in one place, and answer "which rows must a
// dispatch pass hold?" off the spine, the WAL authority for what a wave contains.
//
// The load-bearing property is the CONJUNCTION — human-gated AND still
// `planned`. That is the HELD seam reused on the worker axis: an intra-wave
// blocked row waits at `planned` too, and a row past `planned` was released by a
// human and is ordinary in-flight work. The negative controls below pin both
// halves, so a gate that degenerated to "every human-gated row, forever" fails
// here rather than in a wave that can no longer reach terminal.

describe('human-gated rows — the dispatch-time human lane', () => {
  const meta = {
    slug: 'human-lane',
    description: 'a wave carrying a human-gated row',
    coordinator: 'at',
    model: 'Opus 4.8',
    created: '2026-07-30',
    lastUpdated: '2026-07-30',
  };
  const NO_CONFLICT = { issues: [] as string[], cells: [] };

  type Row = { id: string; title: string; worker: string; risk: string };

  /** A freshly-rendered spine for `roster` — every row starts `planned`. */
  const spineOf = (roster: Row[]): string =>
    renderSpine(meta, roster, NO_CONFLICT, 'all self-content gates pass.');

  const MIXED: Row[] = [
    { id: '10', title: 'Ordinary AFK row', worker: 'background', risk: 'mechanical' },
    { id: '11', title: 'Rotate the credential by hand', worker: HUMAN_GATED_WORKER, risk: 'cross-feature-refactor' },
    { id: '12', title: 'Another AFK row', worker: 'background-heavy', risk: 'isolated-refactor' },
  ];

  const TITLE_ONLY: Row[] = [
    {
      id: '20',
      title: `wire the ${HUMAN_GATED_WORKER} gate through wave-start`,
      worker: 'background',
      risk: 'mechanical',
    },
  ];

  it('the default token is a member of the shipped Worker vocabulary (header-parser parity)', () => {
    expect([...WORKER_VALUES]).toContain(HUMAN_GATED_WORKER);
  });

  it('selects exactly the human-gated row out of a mixed roster', () => {
    const spine = readSpine(spineOf(MIXED));
    expect(humanGatedRows(spine).map((r) => r.id)).toEqual(['11']);
    expect(humanHeldRowIds(spine)).toEqual(['11']);
    // …and leaves every sibling in the table: the wave runs AROUND the hold,
    // it is not narrowed to it.
    expect(spine.planTable.map((r) => r.id)).toEqual(['10', '11', '12']);
  });

  it('NEGATIVE CONTROL — a wave with no human-gated row holds nothing', () => {
    const spine = readSpine(
      spineOf(MIXED.filter((r) => r.worker !== HUMAN_GATED_WORKER)),
    );
    expect(humanGatedRows(spine)).toEqual([]);
    expect(humanHeldRowIds(spine)).toEqual([]);
  });

  it('NEGATIVE CONTROL — the token in a TITLE is not a human-gated row (cell match, never substring)', () => {
    const source = spineOf(TITLE_ONLY);
    // the token really is present in the rendered source — the ROW is not
    expect(source).toContain(HUMAN_GATED_WORKER);
    const spine = readSpine(source);
    expect(humanGatedRows(spine)).toEqual([]);
    expect(humanHeldRowIds(spine)).toEqual([]);
  });

  it('NEGATIVE CONTROL — a human-gated row PAST `planned` is RELEASED, not held', () => {
    // The HELD-seam reuse, in one assertion: the hold is (human-gated ∧
    // planned), never human-gated alone. A human acted on an earlier pass, the
    // Coordinator dispatched the row, and it must stop reading as "awaiting a
    // human" — otherwise the gate holds its own row forever and the wave can
    // never reach terminal.
    for (const released of ROW_STATES.filter((s) => s !== 'planned')) {
      const spine = readSpine(setRowState(spineOf(MIXED), '11', released));
      expect(spine.planTable.find((r) => r.id === '11')?.state).toBe(released);
      // still a human-gated ROW (the state-blind view) …
      expect(humanGatedRows(spine).map((r) => r.id)).toEqual(['11']);
      // … but no longer a HELD one (the gate answer).
      expect(humanHeldRowIds(spine)).toEqual([]);
    }
  });

  it('NEGATIVE CONTROL — a PARKED human-gated row is not held (the archive gate\'s second exit, ADR-0022)', () => {
    // Named on its own rather than left inside the released-states loop above,
    // because a SECOND reader now depends on this one state specifically:
    // wave-close phase 6's fail-closed archive gate (`spine check-awaiting-human`)
    // blocks on this set, and `park + unclaim` is one of the two exits it
    // offers. `parked` is terminal AND claim-releasing, so a parked row must
    // stop matching — a gate that still held it would refuse to archive a wave
    // that had already taken the gate's own prescribed remedy.
    const spine = readSpine(setRowState(spineOf(MIXED), '11', 'parked'));
    expect(spine.planTable.find((r) => r.id === '11')?.state).toBe('parked');
    // still IN the lane (the state-blind view keeps describing it) …
    expect(humanGatedRows(spine).map((r) => r.id)).toEqual(['11']);
    // … and cleared BY ITS STATE, never by having left the human-gated set.
    expect(humanHeldRowIds(spine)).toEqual([]);
  });

  it('reads a heavily space-padded Worker cell (the on-disk shape)', () => {
    const rendered = spineOf(MIXED);
    const padded = rendered.replace(
      `| ${HUMAN_GATED_WORKER} |`,
      `|    ${HUMAN_GATED_WORKER}     |`,
    );
    expect(padded).not.toEqual(rendered); // the replace actually matched
    expect(humanHeldRowIds(readSpine(padded))).toEqual(['11']);
  });

  it('honours a consumer-configured token (Worker is a config-governed enum)', () => {
    const custom: Row[] = [
      { id: '30', title: 'gated on a human', worker: 'needs-a-human', risk: 'mechanical' },
      { id: '31', title: 'afk', worker: 'background', risk: 'mechanical' },
    ];
    const customSpine = readSpine(spineOf(custom));
    // under the DEFAULT set the consumer's token is invisible …
    expect(humanHeldRowIds(customSpine)).toEqual([]);
    // … under the configured set it holds …
    expect(humanHeldRowIds(customSpine, ['needs-a-human'])).toEqual(['30']);
    // … and the default token no longer does: the set IS the whole answer.
    expect(humanHeldRowIds(readSpine(spineOf(MIXED)), ['needs-a-human'])).toEqual([]);
  });

  it('NEGATIVE CONTROL — an empty accepted set holds nothing (a fully-trimmed vocabulary)', () => {
    expect(humanHeldRowIds(readSpine(spineOf(MIXED)), [])).toEqual([]);
  });

  it('matches the UNESCAPED cell value when the token itself carries a pipe', () => {
    const spine = readSpine(
      spineOf([{ id: '40', title: 'gated', worker: 'HITL|required', risk: 'mechanical' }]),
    );
    expect(spine.planTable[0].worker).toBe('HITL|required');
    expect(humanHeldRowIds(spine, ['HITL|required'])).toEqual(['40']);
  });

  it('is total on a spine with no Plan-Table at all', () => {
    const spine = readSpine('# Wave\n\n**Status:** draft\n');
    expect(humanGatedRows(spine)).toEqual([]);
    expect(humanHeldRowIds(spine)).toEqual([]);
  });
});
