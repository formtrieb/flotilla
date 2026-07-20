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
  ROW_STATES,
  setFrontmatterStatus,
  SPINE_STATUSES,
} from './wave-md-rw';
import { ISSUE_STATES } from './stop-condition-state-machine';

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
