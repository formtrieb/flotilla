/**
 * Shared WAVE.md reader/writer — the structured spine reader + byte-preserving
 * targeted mutators that `/wave start` deferred (PRD §"New shared module —
 * WAVE.md reader/writer", stories 20/8/17).
 *
 * Spec is canonical in
 * `.scratch/wave-orchestration/issues/54-wave-md-rw-shared-spine-reader-writer.md`.
 *
 * Two halves:
 *
 *   - **read** — {@link readSpine} parses a spine into a structured {@link Spine}
 *     view: frontmatter (`Status`/`Coordinator`/`Created`/`Last-updated`),
 *     Plan-Table rows (incl. resolved `branch` + `state`), PR-Log rows, the
 *     Resume-Metadata `dispatch-log`, and the Conflict-Map list. Every element
 *     records the 0-indexed *source line* it came from so the writers can target
 *     exactly its span.
 *
 *   - **write** — four targeted mutators ({@link setRowState},
 *     {@link setRowPrCell}, {@link upsertPrLogRow}, {@link replaceClosedByBlock})
 *     that re-emit the file with **only the intended span changed**. The round-
 *     trip property holds at the byte level: read → no-op write → output is
 *     byte-identical to input (the writers operate on line spans, never a full
 *     re-serialize).
 *
 * Design stance (matches `merge-order.ts`'s inline `parseWaveSpine`): the spine
 * schema is stable enough for a line/regex reader. Unlike `parseWaveSpine`
 * (which extracts only the two inputs `computeMergeOrder` needs), this module is
 * the *complete* structured view + the write side, shared by both skills so the
 * Plan-Table / PR-Log / Closed-by edits stop relying on two ad-hoc regex
 * dialects.
 *
 * Both `/wave start` and `/wave close` consume this. This issue (#54) ships the
 * module + tests only; rewiring `/wave start`'s inline edits onto it is an
 * explicit follow-up.
 */

import type { ConflictMap, ConflictCell } from './conflict-map';
export type { ConflictMap, ConflictCell } from './conflict-map';

// ─── Issue-state enum (spine Plan-Table `State` column) ───────────────────────

/**
 * The 11 granular issue states from the Plan-Table `State` column (PRD §F4,
 * Playbook §5). Mirrored from `stop-condition-state-machine.ts`'s `ISSUE_STATES`
 * — kept as its own const here so the reader/writer does not depend on the
 * state-machine module just for the literal set, but the values are identical
 * (pinned by the parity guard in `wave-md-rw.spec.ts`; keep the two in sync).
 */
export const ROW_STATES = [
  'planned',
  'dispatched',
  'report-in',
  'reviewing',
  'verdict-in',
  're-dispatched',
  'approved',
  'pr-created',
  'failed',
  'abandoned',
  // ADR-0022 — the claim-releasing terminal. Durably recorded here (the spine is
  // the WAL authority) BEFORE the tracker claim is dropped via `unclaim`.
  'parked',
] as const;

export type RowState = (typeof ROW_STATES)[number];

// ─── Structured view ──────────────────────────────────────────────────────────

export interface Frontmatter {
  status: string | null;
  coordinator: string | null;
  created: string | null;
  lastUpdated: string | null;
  /**
   * 0-indexed source line of each captured field, for targeted frontmatter
   * writes (not exposed as a mutator in #54, but recorded so a follow-up can
   * add `setLastUpdated` without re-parsing).
   */
  lines: {
    status: number | null;
    coordinator: number | null;
    created: number | null;
    lastUpdated: number | null;
  };
}

/**
 * One Plan-Table row. The PR cell is parsed two ways: `prCell` is the raw cell
 * text (e.g. `[PR#56](https://…)` or `—`), `prUrl` is the extracted href (or
 * `null`), and `branch` is the `wave-orch/<NN>-…` branch derived from the
 * dispatch-log / PR-Log notes when resolvable (PR cells do not themselves carry
 * the branch name — see {@link resolveBranches}).
 */
export interface PlanTableRow {
  id: string;
  title: string;
  worker: string;
  risk: string;
  reviewer: string;
  /** Raw PR-cell text, trimmed. `—` when no PR yet. */
  prCell: string;
  /** Href extracted from the PR cell, or `null`. */
  prUrl: string | null;
  /** `wave-orch/<NN>-…` branch when resolvable from the spine, else `null`. */
  branch: string | null;
  state: RowState | string;
  /** The `Iter` column as a number when numeric, else the raw string. */
  iter: number | string;
  /** Raw `Reports → Verdicts` cell (report/verdict links live here). */
  reportsVerdicts: string;
  /** 0-indexed source line of this table row. */
  line: number;
}

export interface PrLogRow {
  created: string;
  id: string;
  /** Raw PR cell text. */
  prCell: string;
  prUrl: string | null;
  closes: string;
  merged: string;
  notes: string;
  /** 0-indexed source line of this PR-Log row. */
  line: number;
}

export interface DispatchLogEntry {
  /** Raw entry text inside the YAML list item quotes, e.g. `08 → agent … branch wave-orch/08-…`. */
  raw: string;
  /** Issue NN parsed from the entry head (`08 → …` → `08`), or `null`. */
  id: string | null;
  /** `wave-orch/<NN>-…` branch parsed from the entry, or `null`. */
  branch: string | null;
  /**
   * Actually-dispatched model id parsed from a `model <id>` token (ADR-0012),
   * or `null`. Recorded by the driver at dispatch time as a re-tuning signal
   * (`background-heavy → <model>`); the engine never parses or acts on its value.
   */
  model: string | null;
  /** 0-indexed source line of this dispatch-log item. */
  line: number;
}

export interface ClosedByBlock {
  /** Heading line `## Closed-by`, 0-indexed. `null` when no Closed-by section. */
  headingLine: number | null;
  /**
   * The block body lines (everything after the `## Closed-by` heading up to the
   * next `## ` heading or EOF), 0-indexed [start, end) span over source lines.
   * `start === end` for an empty body.
   */
  bodyStart: number;
  bodyEnd: number;
  /** The raw body text (joined source lines), for inspection. */
  body: string;
}

export interface Spine {
  /** The exact source, split on `\n` (line terminators stripped). */
  readonly lines: string[];
  /** Whether the source used CRLF (`\r\n`) terminators. */
  readonly crlf: boolean;
  /** Whether the source ended with a trailing newline. */
  readonly trailingNewline: boolean;
  frontmatter: Frontmatter;
  planTable: PlanTableRow[];
  prLog: PrLogRow[];
  dispatchLog: DispatchLogEntry[];
  conflictMap: ConflictMap;
  closedBy: ClosedByBlock;
}

// ─── Line model (round-trip foundation) ───────────────────────────────────────

interface LineModel {
  lines: string[];
  crlf: boolean;
  trailingNewline: boolean;
}

/**
 * Split a source string into a line model that re-joins byte-identically.
 *
 * We detect CRLF vs LF and whether a trailing newline is present, so
 * {@link joinLines} reconstructs the exact original bytes from the (possibly
 * mutated) line array. Mixed terminators are normalised to the dominant style
 * on re-join — real spines are uniformly LF, so this only matters defensively.
 */
function splitLines(source: string): LineModel {
  const crlf = /\r\n/.test(source);
  const trailingNewline = /\r?\n$/.test(source);
  // Split on either terminator; the terminators themselves are reconstructed.
  const body = trailingNewline ? source.replace(/\r?\n$/, '') : source;
  const lines =
    body.length === 0 && trailingNewline ? [''] : body.split(/\r?\n/);
  return { lines, crlf, trailingNewline };
}

function joinLines(model: LineModel): string {
  const eol = model.crlf ? '\r\n' : '\n';
  const joined = model.lines.join(eol);
  return model.trailingNewline ? joined + eol : joined;
}

// ─── Reader ───────────────────────────────────────────────────────────────────

const FRONTMATTER_FIELD = /^\*\*([^*:]+):\*\*\s*(.*)$/;
const HEADING = /^(#+)\s+(.*)$/;

/**
 * Parse a WAVE.md spine into the structured {@link Spine} view.
 *
 * Pure and total: missing sections yield empty collections / `null` fields
 * rather than throwing, so a `draft` spine (empty PR-Log, no Closed-by body)
 * reads cleanly. Every captured element records its 0-indexed source line for
 * the targeted writers.
 */
export function readSpine(source: string): Spine {
  const model = splitLines(source);
  const { lines } = model;

  const frontmatter = readFrontmatter(lines);
  const planTable = readPlanTable(lines);
  const prLog = readPrLog(lines);
  const dispatchLog = readDispatchLog(lines);
  const conflictMap = readConflictMap(lines);
  const closedBy = readClosedBy(lines);

  resolveBranches(planTable, dispatchLog);

  return {
    lines,
    crlf: model.crlf,
    trailingNewline: model.trailingNewline,
    frontmatter,
    planTable,
    prLog,
    dispatchLog,
    conflictMap,
    closedBy,
  };
}

function readFrontmatter(lines: string[]): Frontmatter {
  const fm: Frontmatter = {
    status: null,
    coordinator: null,
    created: null,
    lastUpdated: null,
    lines: {
      status: null,
      coordinator: null,
      created: null,
      lastUpdated: null,
    },
  };
  // Frontmatter fields live before the first `## ` heading.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    const m = FRONTMATTER_FIELD.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const value = m[2].trim();
    switch (name) {
      case 'Status':
        fm.status = value;
        fm.lines.status = i;
        break;
      case 'Coordinator':
        fm.coordinator = value;
        fm.lines.coordinator = i;
        break;
      case 'Created':
        fm.created = value;
        fm.lines.created = i;
        break;
      case 'Last-updated':
        fm.lastUpdated = value;
        fm.lines.lastUpdated = i;
        break;
      default:
        break;
    }
  }
  return fm;
}

/** Find the [start, end) line span of a `## <name>` section. */
function findSection(
  lines: string[],
  name: string,
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length === 2 && m[2].trim() === name) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m && m[1].length === 2) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Split a markdown table row `| a | b |` into trimmed cell strings.
 * Splits on EVERY `|` (the writers guarantee cell content never contains a raw
 * pipe — see escapeCell), then unescapes the fullwidth `｜` back to `|`.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim().replace(/｜/g, '|'));
}

/**
 * Escape literal pipes in a single table-cell value with the fullwidth
 * vertical line (U+FF5C) so the cell cannot split its row. Paired with
 * splitTableRow, which unescapes on read — a `|` round-trips through every
 * writer; a literal `｜` in the input reads back as `|` (accepted lossy edge,
 * P8 hardening). Every table-row writer MUST route cell content through this.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '｜');
}

/** True for a markdown table separator row (`| --- | --- |`). */
function isSeparatorRow(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
  );
}

const PR_LINK = /\[[^\]]*\]\((https?:\/\/[^)]+)\)/;

/** Extract the first href from a PR cell, or `null` for `—` / plain text. */
function extractPrUrl(cell: string): string | null {
  const m = PR_LINK.exec(cell);
  return m ? m[1] : null;
}

function readPlanTable(lines: string[]): PlanTableRow[] {
  const section = findSection(lines, 'Plan-Table');
  if (!section) return [];
  const rows: PlanTableRow[] = [];
  let sawHeader = false;
  for (let i = section.start + 1; i < section.end; i++) {
    const line = lines[i];
    const cells = splitTableRow(line);
    if (cells.length === 0) continue; // not a table row (prose, blank, footnote)
    if (isSeparatorRow(cells)) continue;
    if (!sawHeader) {
      // First non-separator table row is the header (`| ID | Title | … |`).
      // The header defines the schema: a non-9-column header is an Ur-legacy
      // table (`| ID | Title |`, read by merge-order's footnote parser) —
      // "no flotilla Plan-Table", not corruption. Strictness below applies
      // only within flotilla-rendered 9-column tables.
      sawHeader = true;
      if (cells.length !== 9) return [];
      continue;
    }
    // The spine is the resume-authoritative WAL: a data row with the wrong
    // cell count must fail LOUD — a silent skip makes the row vanish from
    // resume, and a shifted parse (extra raw pipe) is worse than vanishing.
    if (cells.length !== 9) {
      throw new Error(
        `readSpine: malformed Plan-Table row at line ${i + 1} — ` +
          `expected 9 cells, found ${cells.length}: "${line.trim()}"`,
      );
    }
    const prCell = cells[5];
    const iterRaw = cells[7];
    const iterNum = Number(iterRaw);
    rows.push({
      id: stripFootnote(cells[0]),
      // The `[^source-NN]` footnote marker rides on the Title cell in real
      // spines (e.g. `Shared WAVE.md reader/writer[^source-54]`); strip it so
      // the structured title is the human-readable text, not the ref marker.
      title: stripFootnote(cells[1]),
      worker: cells[2],
      risk: cells[3],
      reviewer: cells[4],
      prCell,
      prUrl: extractPrUrl(prCell),
      branch: null, // resolved later
      state: cells[6],
      iter: Number.isFinite(iterNum) && iterRaw !== '' ? iterNum : iterRaw,
      reportsVerdicts: cells[8],
      line: i,
    });
  }
  return rows;
}

/**
 * Strip Markdown footnote markers (`[^source-54]`) from a cell so the structured
 * value is the human-readable text. The marker is a reference, not content; it
 * stays in the raw source line (which the writers never rewrite for read-only
 * fields), so reading it out of the structured view loses nothing.
 */
function stripFootnote(cell: string): string {
  return cell.replace(/\[\^[^\]]+\]/g, '').trim();
}

function readPrLog(lines: string[]): PrLogRow[] {
  const section = findSection(lines, 'PR-Log');
  if (!section) return [];
  const rows: PrLogRow[] = [];
  let sawHeader = false;
  for (let i = section.start + 1; i < section.end; i++) {
    const cells = splitTableRow(lines[i]);
    if (cells.length === 0) continue; // not a table row (prose, blank)
    if (isSeparatorRow(cells)) continue;
    if (!sawHeader) {
      // Header-gated like readPlanTable: a non-6-column header means this is
      // not a flotilla PR-Log table — empty, not corrupt.
      sawHeader = true;
      if (cells.length !== 6) return [];
      continue;
    }
    // Same loud-failure stance as readPlanTable: the PR-Log feeds merge-order
    // and wave-close — a malformed row must never be skipped or parsed shifted.
    if (cells.length !== 6) {
      throw new Error(
        `readSpine: malformed PR-Log row at line ${i + 1} — ` +
          `expected 6 cells, found ${cells.length}: "${lines[i].trim()}"`,
      );
    }
    // Skip the placeholder "no PRs yet" row (ID cell is `—`).
    if (cells[1] === '—' || cells[1] === '') continue;
    const prCell = cells[2];
    rows.push({
      created: cells[0],
      id: cells[1],
      prCell,
      prUrl: extractPrUrl(prCell),
      closes: cells[3],
      merged: cells[4],
      notes: cells[5],
      line: i,
    });
  }
  return rows;
}

const DISPATCH_ITEM = /^\s*-\s+"(.*)"\s*$/;
// The dispatch-log id is the leading token before the arrow. Tracker-agnostic
// (ADR-0021): flotilla ids are `DES-21`/`FOR-5` (Linear) or a GitHub number, not
// just the Ur's numeric `NN` — so capture any non-whitespace run, not `\d+`.
const DISPATCH_HEAD = /^\s*(\S+?)\s*(?:→|->)/;
// The recorded branch. flotilla dispatches on `wave/<id>-<slug>` (id may be
// alphanumeric, e.g. `wave/DES-21-…`); the Ur used `wave-orch/<NN>-…`. Match
// BOTH prefixes so a real flotilla branch is recovered by branchesByIssueId —
// without this the ADR-0021 write path records a branch resume() can't read
// back (silent redispatch, the very failure ADR-0021 closes). The post-slash
// `…-…` (a hyphen with a slug after it) is load-bearing: it distinguishes a
// real branch (`wave-orch/54-wave-md-rw`) from a bare prose reference to
// another row's prefix (`… stacked on wave-orch/54 once …`), which must stay
// unmatched — both real prefixes' branches always carry the `<id>-<slug>` tail.
const BRANCH_REF = /\b(wave(?:-orch)?\/[^\s")]*-[^\s")]+)/;
// A structured `model <id>` token (ADR-0012). The literal keyword + whitespace
// is required, so `(sonnet)` and substrings like `remodel` are NOT matched. The
// value class stays format-blind — the engine never constrains a model id
// (ADR-0012). Caveat: dispatch-log entries are driver-written; prose containing a
// standalone `model <word>` would be captured, but `.model` is inert (no engine
// path consumes it), so a mis-parse is cosmetic, not behavioural.
const MODEL_REF = /\bmodel\s+([^\s")]+)/;

function readDispatchLog(lines: string[]): DispatchLogEntry[] {
  const section = findSection(lines, 'Resume-Metadata');
  if (!section) return [];
  const out: DispatchLogEntry[] = [];
  let inDispatchLog = false;
  for (let i = section.start + 1; i < section.end; i++) {
    const line = lines[i];
    if (/^\s*dispatch-log:\s*$/.test(line)) {
      inDispatchLog = true;
      continue;
    }
    if (!inDispatchLog) continue;
    // Dispatch-log ends at the next top-level YAML key (`notes:` etc.) or the
    // closing fence.
    if (
      /^```/.test(line.trim()) ||
      /^[A-Za-z][\w-]*:\s/.test(line) ||
      /^[A-Za-z][\w-]*:\s*$/.test(line)
    ) {
      break;
    }
    const m = DISPATCH_ITEM.exec(line);
    if (!m) continue;
    const raw = m[1];
    const headMatch = DISPATCH_HEAD.exec(raw);
    const branchMatch = BRANCH_REF.exec(raw);
    const modelMatch = MODEL_REF.exec(raw);
    out.push({
      raw,
      id: headMatch ? headMatch[1] : null,
      branch: branchMatch ? branchMatch[1] : null,
      model: modelMatch ? modelMatch[1] : null,
      line: i,
    });
  }
  return out;
}

const CONFLICT_ITEM = /^\d+\.\s+\*\*(.+?)\s*↔\s*(.+?)\*\*\s+at\s+(.+)$/;

function readConflictMap(lines: string[]): ConflictMap {
  const section = findSection(lines, 'Conflict-Map');
  if (!section) return { issues: [], cells: [] };
  const cells: ConflictCell[] = [];
  const ids = new Set<string>();
  for (let i = section.start + 1; i < section.end; i++) {
    const m = CONFLICT_ITEM.exec(lines[i].trim());
    if (!m) continue;
    const aId = m[1].trim();
    const bId = m[2].trim();
    const files = [...m[3].matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
    if (!aId || !bId || files.length === 0) continue;
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    cells.push({ a, b, files: [...files].sort() });
    ids.add(aId);
    ids.add(bId);
  }
  return { issues: [...ids], cells };
}

export interface SpineMeta {
  slug: string;
  description: string;
  coordinator: string;
  model: string;
  created: string;
  lastUpdated: string;
}

export interface SpineRosterRow {
  id: string;
  title: string;
  worker: string;
  risk: string;
}

const PLAN_TABLE_HEADER =
  '| ID | Title | Worker | Risk | Reviewer | PR | State | Iter | Reports → Verdicts |';
const PLAN_TABLE_SEP = '|---|---|---|---|---|---|---|---|---|';

/**
 * Render a fresh WAVE.md spine (ADR-0016). Owns every parser-consumed section
 * (frontmatter, Plan-Table, Conflict-Map); `dorCheck` is the one opaque,
 * skill-supplied section. Rows are created at fine-state `planned`
 * (coarse() → queued), Reviewer is the uniform `universal` decoration, PR `—`,
 * Iter `1`. Paired with readSpine — see the round-trip spec.
 */
export function renderSpine(
  meta: SpineMeta,
  roster: SpineRosterRow[],
  conflict: ConflictMap,
  dorCheck: string,
): string {
  const rows = roster.map((r) => {
    // The spine is the FLAT file .flotilla/waves/<slug>.md; its directory is
    // .flotilla/waves/. The sidecar dirs are the SIBLING subdir
    // .flotilla/waves/<slug>/reports/ and .flotilla/waves/<slug>/verdicts/.
    // A link relative to the spine's directory therefore MUST include the <slug>/
    // segment — './<slug>/reports/...' resolves correctly to the sibling subdir.
    // (Display/path-correctness only — resume discovers via --reports/--verdicts dirs.)
    const sidecar = escapeCell(
      `[r1](./${meta.slug}/reports/${r.id}-1.md) → [v1](./${meta.slug}/verdicts/${r.id}-1.md)`,
    );
    // Every roster-supplied cell goes through escapeCell: a bare `|` in ANY
    // cell (real GitHub titles contain them; worker/risk vocab is consumer
    // config) would shift every downstream column when splitTableRow splits.
    return `| ${escapeCell(r.id)} | ${escapeCell(r.title)} | ${escapeCell(r.worker)} | ${escapeCell(r.risk)} | universal | — | planned | 1 | ${sidecar} |`;
  });
  return [
    `# Wave ${meta.created} — ${meta.slug} (${meta.description})`,
    '',
    '**Status:** draft',
    `**Coordinator:** ${meta.coordinator} + ${meta.model}`,
    `**Created:** ${meta.created}`,
    `**Last-updated:** ${meta.lastUpdated}`,
    '',
    '## Plan-Table',
    '',
    PLAN_TABLE_HEADER,
    PLAN_TABLE_SEP,
    ...rows,
    '',
    '## DOR-check',
    '',
    dorCheck,
    '',
    '## Conflict-Map',
    '',
    renderConflictMap(conflict),
    '',
    '## PR-Log',
    '',
    '## Resume-Metadata',
    '',
    // The dispatch-log is the DURABLE branch home (ADR-0021): resume() joins
    // worktrees to rows by the branch read from here. An empty *heading* is not
    // a write target — upsertDispatchLogToken throws "no dispatch-log: key"
    // without it, so a freshly-created spine could never record a branch.
    // Scaffold the fenced-YAML key (the form readDispatchLog is built around)
    // so wave-start's `spine set-branch` has a home to write into.
    '```yaml',
    'dispatch-log:',
    '```',
    '',
    '## Closed-by',
    '',
  ].join('\n');
}

/**
 * Render the `## Conflict-Map` body (no heading) in the CONFLICT_ITEM format
 * readConflictMap parses: `N. **a ↔ b** at `f1`, `f2``. Empty cells → the
 * disjoint one-liner. Printer paired with readConflictMap (ADR-0016).
 *
 * @precondition Input is assumed canonical — i.e. the direct output of
 * `computeConflictMap`: pairs in `a < b` lexicographic order, `files` sorted.
 */
export function renderConflictMap(cm: ConflictMap): string {
  if (cm.cells.length === 0) {
    return '∅ — all issues pairwise disjoint.';
  }
  return cm.cells
    .map((c, i) => {
      const files = c.files.map((f) => '`' + f + '`').join(', ');
      return `${i + 1}. **${c.a} ↔ ${c.b}** at ${files}`;
    })
    .join('\n');
}

function readClosedBy(lines: string[]): ClosedByBlock {
  const section = findSection(lines, 'Closed-by');
  if (!section) {
    return {
      headingLine: null,
      bodyStart: lines.length,
      bodyEnd: lines.length,
      body: '',
    };
  }
  const bodyStart = section.start + 1;
  const bodyEnd = section.end;
  const body = lines.slice(bodyStart, bodyEnd).join('\n');
  return { headingLine: section.start, bodyStart, bodyEnd, body };
}

/**
 * Fill each Plan-Table row's `branch` from the dispatch-log (primary) — the
 * dispatch-log entry `08 → agent … branch wave-orch/08-…` is the canonical
 * branch source. PR cells carry only the PR URL, not the branch name, so a row
 * with a PR but no dispatch-log entry keeps `branch: null` (the same best-effort
 * stance `merge-order.ts` takes).
 */
function resolveBranches(
  planTable: PlanTableRow[],
  dispatchLog: DispatchLogEntry[],
): void {
  const byId = new Map<string, string>();
  for (const entry of dispatchLog) {
    if (entry.id && entry.branch && !byId.has(entry.id)) {
      byId.set(entry.id, entry.branch);
    }
  }
  for (const row of planTable) {
    const branch = byId.get(row.id);
    if (branch) row.branch = branch;
  }
}

// ─── Writers (byte-preserving targeted mutators) ──────────────────────────────

/**
 * Replace cell `index` of the Plan-Table-style row at `lineIdx` with
 * `newValue`, preserving the surrounding markdown table padding exactly except
 * for the one cell. Returns the rewritten full line.
 *
 * Padding policy: the original cell's leading/trailing spaces inside the pipes
 * are preserved where possible — we re-pad the new value to the original cell's
 * visual width (left-aligned) so the column does not visually jump. When the new
 * value is wider than the original cell, the cell grows (markdown tables tolerate
 * ragged widths; the row stays valid).
 */
function replaceCell(line: string, index: number, newValue: string): string {
  // Single choke point for targeted cell writes (setRowState, setRowPrCell):
  // escape a literal `|` in the incoming value before it can split the row.
  newValue = escapeCell(newValue);
  // Tokenise on pipes, keeping the segments so we only touch one.
  const trimmed = line;
  const firstPipe = trimmed.indexOf('|');
  if (firstPipe === -1) return line;
  // Split preserving the raw segments between pipes (with their padding).
  const segments: string[] = [];
  let buf = '';
  let started = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '|') {
      if (started) segments.push(buf);
      buf = '';
      started = true;
      segments.push('|');
      continue;
    }
    buf += ch;
  }
  // Trailing segment after the last pipe (usually empty for `… |`).
  if (started) segments.push(buf);

  // segments looks like: ['<lead>', '|', ' cell0 ', '|', ' cell1 ', '|', …, '<trail>']
  // Cell segments are at odd parity *after* the first '|'. Collect their indices.
  const cellSegmentIdx: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] === '|') {
      // The segment after this pipe (if it exists and is not a pipe) is a cell.
      const next = i + 1;
      if (next < segments.length && segments[next] !== '|') {
        cellSegmentIdx.push(next);
      }
    }
  }
  if (index < 0 || index >= cellSegmentIdx.length) return line;

  const segIdx = cellSegmentIdx[index];
  const original = segments[segIdx];
  // Preserve leading/trailing whitespace of the original cell padding.
  const lead = original.match(/^\s*/)?.[0] ?? ' ';
  const trail = original.match(/\s*$/)?.[0] ?? ' ';
  const oldContent = original.trim();
  // Re-pad: keep original total width if the new value is not wider, else grow.
  const targetWidth = oldContent.length;
  let padded = newValue;
  if (newValue.length < targetWidth) {
    padded = newValue + ' '.repeat(targetWidth - newValue.length);
  }
  segments[segIdx] = `${lead}${padded}${trail}`;
  return segments.join('');
}

/**
 * Flip the `State` column of the Plan-Table row whose ID is `id` to `state`.
 * Only the State cell's bytes change; the rest of the line (and file) is
 * untouched. Throws if no row matches `id` (callers know their wave's IDs).
 */
export function setRowState(
  source: string,
  id: string,
  state: RowState,
): string {
  const model = splitLines(source);
  const spine = readSpine(source);
  const row = spine.planTable.find((r) => r.id === id);
  if (!row) {
    throw new Error(`setRowState: no Plan-Table row with id "${id}".`);
  }
  // State is column index 6 (ID, Title, Worker, Risk, Reviewer, PR, State, …).
  model.lines[row.line] = replaceCell(model.lines[row.line], 6, state);
  return joinLines(model);
}

/**
 * Set the `PR` cell of the Plan-Table row whose ID is `id`. `prCell` is the raw
 * cell content (e.g. `[PR#56](https://…)`). Only that cell's bytes change.
 */
export function setRowPrCell(
  source: string,
  id: string,
  prCell: string,
): string {
  const model = splitLines(source);
  const spine = readSpine(source);
  const row = spine.planTable.find((r) => r.id === id);
  if (!row) {
    throw new Error(`setRowPrCell: no Plan-Table row with id "${id}".`);
  }
  // PR is column index 5.
  model.lines[row.line] = replaceCell(model.lines[row.line], 5, prCell);
  return joinLines(model);
}

export interface PrLogRowInput {
  created: string;
  id: string;
  /** Raw PR cell content. */
  prCell: string;
  closes: string;
  merged: string;
  notes: string;
}

/**
 * Upsert a PR-Log row keyed by `id`.
 *
 * - If a real PR-Log row with that `id` exists, its line is replaced in place
 *   (only that line's bytes change).
 * - Otherwise the row is appended after the last existing PR-Log row (or after
 *   the placeholder "no PRs yet" row, which it replaces on first insert), so the
 *   surrounding sections stay byte-identical.
 *
 * Throws if the spine has no `## PR-Log` section.
 */
export function upsertPrLogRow(source: string, input: PrLogRowInput): string {
  const model = splitLines(source);
  const section = findSection(model.lines, 'PR-Log');
  if (!section) {
    throw new Error('upsertPrLogRow: spine has no "## PR-Log" section.');
  }
  const newLine = renderPrLogRow(input);

  const spine = readSpine(source);
  const existing = spine.prLog.find((r) => r.id === input.id);
  if (existing) {
    model.lines[existing.line] = newLine;
    return joinLines(model);
  }

  // No matching real row. Find where to insert: locate the table header +
  // separator, then the last data line (real row or placeholder).
  let headerLine = -1;
  let separatorLine = -1;
  let lastDataLine = -1;
  let placeholderLine = -1;
  for (let i = section.start + 1; i < section.end; i++) {
    const cells = splitTableRow(model.lines[i]);
    if (cells.length < 6) continue;
    if (isSeparatorRow(cells)) {
      separatorLine = i;
      continue;
    }
    if (headerLine === -1) {
      headerLine = i;
      continue;
    }
    lastDataLine = i;
    if (cells[1] === '—' || cells[1] === '') placeholderLine = i;
  }

  if (placeholderLine !== -1 && spine.prLog.length === 0) {
    // Replace the placeholder row with the first real row.
    model.lines[placeholderLine] = newLine;
    return joinLines(model);
  }

  const insertAfter = lastDataLine !== -1 ? lastDataLine : separatorLine;
  if (insertAfter === -1) {
    throw new Error(
      'upsertPrLogRow: "## PR-Log" table is malformed (no separator/header).',
    );
  }
  model.lines.splice(insertAfter + 1, 0, newLine);
  return joinLines(model);
}

function renderPrLogRow(input: PrLogRowInput): string {
  // All six cells are caller-supplied (notes/prCell are free text) — escape
  // each so a literal `|` cannot shift the columns splitTableRow reads back.
  const c = escapeCell;
  return `| ${c(input.created)} | ${c(input.id)} | ${c(input.prCell)} | ${c(input.closes)} | ${c(input.merged)} | ${c(input.notes)} |`;
}

/**
 * Replace the entire body of the `## Closed-by` section with `body` (the text
 * between the `## Closed-by` heading and the next `## ` heading / EOF). The
 * heading line itself, every preceding section, and every following section stay
 * byte-identical.
 *
 * `body` is inserted verbatim as its own lines; pass it WITHOUT a leading or
 * trailing blank-line convention unless you want them (the writer re-creates the
 * one blank line after the heading and before the next section to match the
 * spine's house style only when `body` is non-empty and the original had them).
 *
 * Throws if the spine has no `## Closed-by` section.
 */
export function replaceClosedByBlock(source: string, body: string): string {
  const model = splitLines(source);
  const section = findSection(model.lines, 'Closed-by');
  if (!section) {
    throw new Error(
      'replaceClosedByBlock: spine has no "## Closed-by" section.',
    );
  }
  const bodyStart = section.start + 1;
  const bodyEnd = section.end;
  const bodyLines = body.split('\n');
  // Splice out the old body [bodyStart, bodyEnd) and insert the new body lines.
  model.lines.splice(bodyStart, bodyEnd - bodyStart, ...bodyLines);
  return joinLines(model);
}

// ─── Branch recording ─────────────────────────────────────────────────────────

/**
 * Return the `NN → branchName` map derived from the dispatch-log entries of
 * `spine`. Only entries with both an `id` and a `branch` are included.
 * Convenience accessor for callers that need `branchesByIssueId` without going
 * through the full `extractSpineBranches` NN-rekey in `merge-order.ts`.
 *
 * This mirrors the shape of `merge-order.ts`'s `extractSpineBranches` output
 * but keys by the raw NN string rather than the canonical footnote-path issueId,
 * making it useful for round-trip tests (`branchesByIssueId(spine)[id] ===
 * branch`).
 */
export function branchesByIssueId(spine: Spine): Record<string, string> {
  const out: Record<string, string> = {};
  // Plan-Table first (lower precedence), then dispatch-log (overwrites).
  for (const row of spine.planTable) {
    if (row.id && row.branch) out[row.id] = row.branch;
  }
  for (const entry of spine.dispatchLog) {
    if (entry.id && entry.branch) out[entry.id] = entry.branch;
  }
  return out;
}

/**
 * A single `key → value` token recorded inside a dispatch-log entry's quoted
 * raw text. Both `branch` and `model` are such tokens (ADR-0012 for `model`).
 */
interface DispatchToken {
  /** Locates the existing token in an entry's raw text (non-global regex). */
  matchRe: RegExp;
  /** Replacement for the matched token — the full new token text. */
  replacement: string;
  /** Full token to append when the entry has none yet, e.g. `branch <b>` / `model <m>`. */
  append: string;
}

/**
 * Upsert one {@link DispatchToken} for issue `id` in the spine's
 * `## Resume-Metadata` dispatch-log block — the shared scaffold behind
 * {@link upsertDispatchLogEntry} (branch) and {@link upsertDispatchLogModel}.
 *
 * Behaviour:
 * - Entry exists for `id` AND already carries this token → the token is replaced.
 * - Entry exists for `id` but lacks this token → the token is appended to it.
 * - No entry for `id` → a minimal new entry `"<id> → <token>"` is appended after
 *   the last dispatch-log item (or right after the `dispatch-log:` key if empty).
 *
 * Identity-preserving (re-emits the file; never mutates `Spine.lines` in place
 * — #54 advisory): only the targeted dispatch-log list item line changes.
 *
 * Throws if the spine has no `## Resume-Metadata` section or no `dispatch-log:`
 * key within it.
 */
function upsertDispatchLogToken(
  source: string,
  id: string,
  token: DispatchToken,
): string {
  const model = splitLines(source);

  // Locate the Resume-Metadata section and the dispatch-log key + items.
  const section = findSection(model.lines, 'Resume-Metadata');
  if (!section) {
    throw new Error(
      'upsertDispatchLog: spine has no "## Resume-Metadata" section.',
    );
  }

  let dispatchLogKeyLine = -1;
  let lastItemLine = -1;
  let existingEntryLine = -1;
  let existingEntryRaw = '';

  for (let i = section.start + 1; i < section.end; i++) {
    const line = model.lines[i];
    if (/^\s*dispatch-log:\s*$/.test(line)) {
      dispatchLogKeyLine = i;
      continue;
    }
    if (dispatchLogKeyLine === -1) continue;
    // Stop at closing fence or next top-level YAML key.
    if (
      /^```/.test(line.trim()) ||
      /^[A-Za-z][\w-]*:\s/.test(line) ||
      /^[A-Za-z][\w-]*:\s*$/.test(line)
    ) {
      break;
    }
    const m = DISPATCH_ITEM.exec(line);
    if (!m) continue;
    lastItemLine = i;
    const raw = m[1];
    const headMatch = DISPATCH_HEAD.exec(raw);
    if (headMatch && headMatch[1] === id) {
      existingEntryLine = i;
      existingEntryRaw = raw;
    }
  }

  if (dispatchLogKeyLine === -1) {
    throw new Error(
      'upsertDispatchLog: "## Resume-Metadata" has no "dispatch-log:" key.',
    );
  }

  if (existingEntryLine !== -1) {
    // Update the existing entry: replace this token, or append it if absent.
    const updatedRaw = token.matchRe.test(existingEntryRaw)
      ? existingEntryRaw.replace(token.matchRe, token.replacement)
      : `${existingEntryRaw} ${token.append}`;
    model.lines[existingEntryLine] = `  - "${updatedRaw}"`;
    return joinLines(model);
  }

  // No existing entry — insert a new minimal entry.
  const newLine = `  - "${id} → ${token.append}"`;
  const insertAfter = lastItemLine !== -1 ? lastItemLine : dispatchLogKeyLine;
  model.lines.splice(insertAfter + 1, 0, newLine);
  return joinLines(model);
}

/**
 * Record (or update) the `wave-orch/*` branch name for issue `id` in the spine's
 * dispatch-log — the durable per-issue branch record that `branchesByIssueId`
 * reads back to power `--wave`-scoped worktree-cleanup. See
 * {@link upsertDispatchLogToken} for the replace/append/new-entry behaviour.
 */
export function upsertDispatchLogEntry(
  source: string,
  id: string,
  branch: string,
): string {
  return upsertDispatchLogToken(source, id, {
    matchRe: BRANCH_REF,
    replacement: branch,
    append: `branch ${branch}`,
  });
}

/**
 * Record (or update) the actually-dispatched `model <id>` for issue `id` in the
 * spine's dispatch-log (ADR-0012). The driver calls this at dispatch time as a
 * re-tuning signal (`background-heavy → <model>`); it co-exists with the branch
 * token and never alters it. See {@link upsertDispatchLogToken}.
 */
export function upsertDispatchLogModel(
  source: string,
  id: string,
  model: string,
): string {
  return upsertDispatchLogToken(source, id, {
    matchRe: MODEL_REF,
    replacement: `model ${model}`,
    append: `model ${model}`,
  });
}

// ─── Frontmatter status mutator ───────────────────────────────────────────────

/** Valid frontmatter Status values (human scope-state; the per-row State is the WAL signal). */
export const SPINE_STATUSES = ['draft', 'ready', 'in-flight', 'closed'] as const;
export type SpineStatus = (typeof SPINE_STATUSES)[number];

/**
 * Surgically flip the frontmatter `**Status:**` line to `status`. Only that
 * line's value bytes change (byte-identical on a no-op). Throws when the spine
 * has no Status field. Mirrors `setRowState`'s targeted-line discipline.
 */
export function setFrontmatterStatus(source: string, status: string): string {
  const model = splitLines(source);
  const fm = readFrontmatter(model.lines);
  if (fm.lines.status === null) {
    throw new Error('setFrontmatterStatus: spine has no **Status:** frontmatter field.');
  }
  const i = fm.lines.status;
  model.lines[i] = model.lines[i].replace(/^(\s*\*\*Status:\*\*\s*).*$/, `$1${status}`);
  return joinLines(model);
}
