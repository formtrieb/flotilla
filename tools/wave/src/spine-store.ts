/**
 * spine-store.ts — the single read/write seam onto the WAVE.md orchestration
 * spine (CHARTER §6). For every section wave-md-rw already owns, this is a thin,
 * byte-preserving wrapper over the EXISTING string→string primitives: it
 * reimplements nothing, delegates every mutation, and re-parses after each write
 * so callers never touch readSpine / setRowState directly.
 *
 * The one section this module owns OUTRIGHT is `## Disclosures` (ADR-0027) — see
 * the Disclosures block below. Its printer and parser are defined here as a pair
 * (the ADR-0016 principle), which is why this file carries a small private line
 * model + table helpers of its own: wave-md-rw's equivalents are module-private
 * and that module is outside this slice's declared Files.
 *
 * The spine is the durable write-ahead log that makes resume possible (ADR-0002):
 * the caller commits intent (setRowState / upsertDispatchLogEntry) BEFORE the
 * irreversible side-effect (worktree create, worker spawn), so a kill between the
 * two is recoverable. ADR-0027 extends that doctrine to disclosures: captured at
 * the moment of knowledge, enforced at archive (the terminal boundary), so a
 * Coordinator death in between loses nothing. ADR-0038 states how far "the
 * moment of knowledge" reaches: the capture window spans verdict-routing through
 * every close phase and ends hard at the archive — which is why this module
 * carries TWO capture constructors, one per scope, and one gate over both.
 */

import {
  readSpine,
  setRowState,
  setRowIter,
  setRowPrCell,
  upsertPrLogRow,
  upsertDispatchLogEntry,
  upsertDispatchLogModel,
  replaceClosedByBlock,
  setFrontmatterStatus,
  branchesByIssueId,
  type Spine,
  type RowState,
  type PrLogRowInput,
} from './wave-md-rw';

// ─── Disclosures (ADR-0027) ───────────────────────────────────────────────────
//
// A *disclosure* is a Convention-9 wiring gap, a Convention-10 runtime residue,
// or a same-shaped Reviewer/Coordinator finding. It is captured into the spine
// where it surfaces — at verdict-routing, or during any close phase while the
// spine is still live (ADR-0038) — and must carry a disposition before the wave
// archives.
//
// The section is engine-rendered AND engine-parsed — never hand-authored by a
// skill, never grep-parsed by one (ADR-0027 rejects the skill-side-markdown
// option explicitly; the counting gate reads an exit code, not prose).
//
// Entries are SOURCE-NEUTRAL: Worker prose, Reviewer verdict and Coordinator
// observation land in the same table with the same shape.

/** Who observed the gap. Source-neutral storage — this is provenance, not kind. */
export const DISCLOSURE_SOURCES = ['worker', 'reviewer', 'coordinator'] as const;
export type DisclosureSource = (typeof DISCLOSURE_SOURCES)[number];

// ─── Wave-scoped disclosures (ADR-0038) ──────────────────────────────────────
//
// A find about the wave's OWN machinery — the worktree sweep, a preflight
// posture, the merge-order tool — is owned by no Plan-Table row and comes out of
// no dispatch iteration, so the row-scoped capture above has nothing to validate
// it against. ADR-0038 makes that shape first-class rather than hanging it on an
// arbitrary "affected" row (the option the ADR rejected: it corrupts row-scoped
// counting and has no answer at all for a find with no affected row).
//
// The storage is the SAME table, deliberately: a wave-scoped entry renders,
// parses, dispositions and counts exactly like a row-scoped one — two sentinel
// cells are the whole difference, so the archive gate needed no change at all.

/**
 * The sentinel that occupies a wave-scoped entry's `Row` cell — and therefore
 * the prefix of its ref (`wave.1`, `wave.2`, …).
 *
 * It shares the ordinal namespace with any row of the same id, which is why
 * {@link addWaveDisclosureToSource} refuses to capture at all when the
 * Plan-Table actually holds a row spelled `wave`.
 */
export const WAVE_SCOPE_ROW = 'wave';

/**
 * The `Iter` cell a wave-scoped entry renders: the spine's house
 * not-applicable marker (the same em dash the Plan-Table's empty `PR` /
 * `Reports → Verdicts` cells carry). Parsed back as `iter: null`.
 */
export const WAVE_SCOPE_ITER_CELL = '—';

/**
 * The capture-time default. Deliberately NOT settable through
 * {@link setDispositionInSource}: `open` is what capture writes, and the
 * dispositioning step is a one-way door out of it.
 */
export const OPEN_DISPOSITION = 'open';

/** The two closed-form dispositions (ADR-0027). */
export const DISPOSITION_LITERALS = [
  'resolved-in-slice',
  'scope-extension',
] as const;

/** The two parameterised dispositions — `filed:<id>` / `dropped:<reason>`. */
export const DISPOSITION_PREFIXES = ['filed:', 'dropped:'] as const;

/** Human-readable rendering of the vocabulary, for error messages + usage text. */
export const DISPOSITION_VOCABULARY =
  'resolved-in-slice | scope-extension | filed:<id> | dropped:<reason>';

/** One parsed `## Disclosures` entry. */
export interface Disclosure {
  /**
   * The stable address `<row-id>.<ordinal>` (e.g. `156.1`, `FOR-90.2`) — or
   * `wave.<ordinal>` for a wave-scoped entry (ADR-0038).
   * The ordinal is 1-based PER ROW and never reused — there is no delete verb,
   * so a ref, once printed, addresses the same entry for the life of the spine.
   * Dot-joined on purpose: `<id>-<n>` is already the sidecar report/verdict
   * spelling, and a disclosure-ref must not read like a sidecar path.
   */
  ref: string;
  /**
   * The Plan-Table row this disclosure was raised against — or
   * {@link WAVE_SCOPE_ROW} when the find is about the wave's own machinery and
   * belongs to no row (ADR-0038).
   */
  rowId: string;
  /** 1-based ordinal within `rowId`. */
  ordinal: number;
  /**
   * The dispatch iteration the disclosure came out of — `null` for a
   * wave-scoped entry, which came out of no dispatch at all (ADR-0038).
   */
  iter: number | null;
  source: DisclosureSource;
  /** `open` at capture; one of {@link DISPOSITION_VOCABULARY} once dispositioned. */
  disposition: string;
  /** The gap itself, one line (see {@link normalizeDisclosureText}). */
  text: string;
  /** 0-indexed source line of this entry's table row. */
  line: number;
}

/** What a caller supplies at ROW-scoped capture; `disposition` is always `open`. */
export interface DisclosureInput {
  rowId: string;
  iter: number;
  source: DisclosureSource;
  text: string;
}

/**
 * What a caller supplies at WAVE-scoped capture (ADR-0038). Deliberately a
 * SEPARATE input type rather than an optional-field widening of
 * {@link DisclosureInput}: the two fields it drops are exactly the two the
 * row-scoped constructor validates, so "no row, no iteration" is a shape the
 * type system states rather than a runtime combination to police.
 */
export interface WaveDisclosureInput {
  source: DisclosureSource;
  text: string;
}

const DISCLOSURES_HEADING = '## Disclosures';
const DISCLOSURES_HEADING_RE = /^##\s+Disclosures\s*$/;
const DISCLOSURES_TABLE_HEADER =
  '| Ref | Row | Iter | Source | Disposition | Text |';
const DISCLOSURES_TABLE_SEP = '|---|---|---|---|---|---|';
const DISCLOSURE_CELLS = 6;

/** Private line model — mirrors wave-md-rw's, which is not exported. */
interface LineModel {
  lines: string[];
  crlf: boolean;
  trailingNewline: boolean;
}

function splitLines(source: string): LineModel {
  const crlf = /\r\n/.test(source);
  const trailingNewline = /\r?\n$/.test(source);
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

/**
 * Escape a literal `|` with the fullwidth vertical line (U+FF5C) so a cell can
 * never split its row. Paired with {@link splitDisclosureRow}, which unescapes
 * on read — the same idiom (and the same accepted lossy edge for a literal
 * `｜` in the input) wave-md-rw's table writers use.
 */
function escapeDisclosureCell(value: string): string {
  return value.replace(/\|/g, '｜');
}

function splitDisclosureRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim().replace(/｜/g, '|'));
}

function isSeparatorRow(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))
  );
}

/** [start, end) line span of the `## Disclosures` section, or `null`. */
function findDisclosuresSection(
  lines: string[],
): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (DISCLOSURES_HEADING_RE.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * True for a disposition `set-disposition` accepts. `open` is excluded on
 * purpose — it is the capture default, not a decision.
 */
export function isSettableDisposition(value: string): boolean {
  if ((DISPOSITION_LITERALS as readonly string[]).includes(value)) return true;
  return DISPOSITION_PREFIXES.some(
    (prefix) =>
      value.startsWith(prefix) && value.slice(prefix.length).trim().length > 0,
  );
}

/**
 * Collapse a disclosure's prose to one line. Disclosures are lifted from a
 * WorkerReport's `judgmentCalls` / a ReviewerVerdict's prose, which can carry
 * newlines and runs of whitespace; a markdown table cell cannot. Normalising
 * (rather than rejecting) keeps capture cheap at routing — the alternative
 * makes the Coordinator hand-reflow prose at the exact hour ADR-0027 is
 * protecting.
 */
export function normalizeDisclosureText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Render one entry's table row. Paired with {@link readDisclosures}.
 *
 * A `null` iter — the wave-scoped case (ADR-0038) — renders the house
 * not-applicable marker {@link WAVE_SCOPE_ITER_CELL}; every other cell is
 * written exactly as before, so a row-scoped entry's bytes are unchanged.
 */
export function renderDisclosureRow(d: Disclosure): string {
  const c = escapeDisclosureCell;
  const iterCell = d.iter === null ? WAVE_SCOPE_ITER_CELL : String(d.iter);
  return `| ${c(d.ref)} | ${c(d.rowId)} | ${iterCell} | ${c(d.source)} | ${c(d.disposition)} | ${c(d.text)} |`;
}

/**
 * Render the whole `## Disclosures` section (heading + scaffolded table), as
 * appended to a spine that does not have one.
 *
 * The header + separator are scaffolded even with zero entries, for the same
 * reason renderSpine scaffolds the dispatch-log's fenced-YAML key: an empty
 * heading is not a write target. (`upsertPrLogRow` throws "table is malformed"
 * on a bare heading — this section does not repeat that.)
 */
export function renderDisclosuresSection(
  entries: readonly Disclosure[] = [],
): string {
  return [
    DISCLOSURES_HEADING,
    '',
    DISCLOSURES_TABLE_HEADER,
    DISCLOSURES_TABLE_SEP,
    ...entries.map(renderDisclosureRow),
    '',
  ].join('\n');
}

/**
 * Parse the `## Disclosures` section. Paired with {@link renderDisclosureRow}
 * (ADR-0016) — re-rendering a parsed entry reproduces its source line byte for
 * byte.
 *
 * BACKWARD COMPATIBLE: a spine WITHOUT the section (every spine archived before
 * ADR-0027) yields `[]` rather than throwing — same stance readSpine takes for
 * a missing section.
 *
 * Within the section it is STRICT, mirroring readPlanTable: this is the
 * resume-authoritative WAL and the section is 100% engine-rendered, so a
 * malformed header or a wrong-cell-count data row is corruption, not a legacy
 * shape. It throws — which the fail-closed archive gate surfaces as non-zero
 * (a lenient skip would make a corrupted section read as "0 open" and let the
 * archive through, the exact inversion the gate exists to prevent).
 */
export function readDisclosures(source: string): Disclosure[] {
  const { lines } = splitLines(source);
  const section = findDisclosuresSection(lines);
  if (!section) return [];

  const out: Disclosure[] = [];
  let sawHeader = false;
  for (let i = section.start + 1; i < section.end; i++) {
    const line = lines[i];
    const cells = splitDisclosureRow(line);
    if (cells.length === 0) continue; // blank line / prose
    if (isSeparatorRow(cells)) continue;
    if (!sawHeader) {
      sawHeader = true;
      if (cells.length !== DISCLOSURE_CELLS) {
        throw new Error(
          `readDisclosures: malformed "## Disclosures" header at line ${i + 1} — ` +
            `expected ${DISCLOSURE_CELLS} cells, found ${cells.length}: "${line.trim()}"`,
        );
      }
      continue;
    }
    if (cells.length !== DISCLOSURE_CELLS) {
      throw new Error(
        `readDisclosures: malformed disclosure row at line ${i + 1} — ` +
          `expected ${DISCLOSURE_CELLS} cells, found ${cells.length}: "${line.trim()}"`,
      );
    }
    const [ref, rowId, iterRaw, sourceRaw, disposition, text] = cells;
    const ordinalMatch = /\.(\d+)$/.exec(ref);
    if (!ordinalMatch) {
      throw new Error(
        `readDisclosures: malformed disclosure ref "${ref}" at line ${i + 1} — ` +
          'expected "<row-id>.<ordinal>".',
      );
    }
    // The wave-scoped sentinel (ADR-0038) is the ONE non-numeric Iter cell the
    // parser accepts; everything else is still held to a positive integer.
    let iter: number | null = null;
    if (iterRaw !== WAVE_SCOPE_ITER_CELL) {
      iter = Number(iterRaw);
      if (!Number.isInteger(iter) || iter < 1) {
        throw new Error(
          `readDisclosures: malformed Iter "${iterRaw}" at line ${i + 1} — ` +
            `expected a positive integer or "${WAVE_SCOPE_ITER_CELL}" (wave-scoped, ADR-0038).`,
        );
      }
    }
    if (!(DISCLOSURE_SOURCES as readonly string[]).includes(sourceRaw)) {
      throw new Error(
        `readDisclosures: unknown disclosure source "${sourceRaw}" at line ${i + 1} — ` +
          `expected one of: ${DISCLOSURE_SOURCES.join(', ')}.`,
      );
    }
    out.push({
      ref,
      rowId,
      ordinal: Number(ordinalMatch[1]),
      iter,
      source: sourceRaw as DisclosureSource,
      disposition,
      text,
      line: i,
    });
  }
  return out;
}

/** The undispositioned entries — exactly what blocks the archive. */
export function openDisclosures(source: string): Disclosure[] {
  return readDisclosures(source).filter(
    (d) => d.disposition === OPEN_DISPOSITION,
  );
}

/**
 * Append the `## Disclosures` section (heading + empty scaffolded table) unless
 * the spine already has one. Byte-identical no-op when it does.
 *
 * Appended at EOF so every EXISTING section's [start, end) span is untouched —
 * `## Closed-by`'s body simply now ends at this heading instead of EOF, which is
 * what `replaceClosedByBlock` already splices against.
 *
 * `spine create` composes this onto `renderSpine`'s output, so every freshly
 * created wave carries the section from birth; `addDisclosureToSource` calls it
 * so a pre-ADR-0027 spine grows one on first capture.
 */
export function ensureDisclosuresSection(source: string): string {
  const model = splitLines(source);
  const existingSection = findDisclosuresSection(model.lines);
  if (existingSection) {
    // Present — but a heading ALONE is not a write target. Scaffold the header +
    // separator if they are missing, so `addDisclosure` is total. (`upsertPrLogRow`
    // throws "table is malformed" in exactly this situation; this section does
    // not repeat that trap.)
    for (let i = existingSection.start + 1; i < existingSection.end; i++) {
      if (splitDisclosureRow(model.lines[i]).length > 0) return source;
    }
    const padded = model.lines[existingSection.start + 1] === '';
    model.lines.splice(
      existingSection.start + (padded ? 2 : 1),
      0,
      ...(padded ? [] : ['']),
      DISCLOSURES_TABLE_HEADER,
      DISCLOSURES_TABLE_SEP,
    );
    return joinLines(model);
  }
  const sectionLines = renderDisclosuresSection().split('\n');
  // One blank line of separation from whatever the spine currently ends with.
  if (model.lines.length > 0 && model.lines[model.lines.length - 1] !== '') {
    model.lines.push('');
  }
  model.lines.push(...sectionLines);
  // renderDisclosuresSection ends with a '' element; drop the duplicate that
  // would otherwise appear when the source already had a trailing newline.
  if (
    model.trailingNewline &&
    model.lines[model.lines.length - 1] === ''
  ) {
    model.lines.pop();
  }
  return joinLines(model);
}

/**
 * Capture a disclosure at `open`. Returns the mutated source and the created
 * entry (whose `ref` is what `set-disposition` later addresses).
 *
 * Every vocabulary/shape rule is enforced HERE, in the domain, not at the CLI
 * boundary: unlike `setRowState` — whose writer stamps any string verbatim into
 * a cell, leaving the CLI as the only place a typo can be caught — this section
 * has a real constructor that owns its invariants. A caller that reaches the
 * store with a bad token gets a throw regardless of which front end it came
 * through.
 */
export function addDisclosureToSource(
  source: string,
  input: DisclosureInput,
): { source: string; disclosure: Disclosure } {
  const text = normalizeDisclosureText(input.text ?? '');
  if (!text) {
    throw new Error('addDisclosure: --text is empty; a disclosure needs a gap description.');
  }
  if (!(DISCLOSURE_SOURCES as readonly string[]).includes(input.source)) {
    throw new Error(
      `addDisclosure: unknown source "${input.source}"; expected one of: ${DISCLOSURE_SOURCES.join(', ')}.`,
    );
  }
  if (!Number.isInteger(input.iter) || input.iter < 1) {
    throw new Error(
      `addDisclosure: invalid iter "${input.iter}"; expected a positive integer.`,
    );
  }
  const rowId = (input.rowId ?? '').trim();
  if (!rowId) {
    throw new Error('addDisclosure: <row-id> is empty.');
  }
  // Fail loud on an unknown row — mirrors setRowState's stance. A typo'd row id
  // would otherwise park the disclosure on a row nobody looks at, which is the
  // silent-loss failure ADR-0027 exists to close.
  const planTable = readSpine(source).planTable;
  if (!planTable.some((r) => r.id === rowId)) {
    throw new Error(
      `addDisclosure: no Plan-Table row with id "${rowId}".`,
    );
  }

  return insertDisclosureEntry(source, {
    rowId,
    iter: input.iter,
    source: input.source,
    text,
  });
}

/**
 * Capture a WAVE-SCOPED disclosure at `open` (ADR-0038) — a find about the
 * wave's own machinery, owned by no Plan-Table row and no iteration. Additive
 * beside {@link addDisclosureToSource} (ADR-0035): the row-scoped constructor
 * above is untouched, down to its error strings.
 *
 * Same two vocabulary rules as row-scoped capture (non-empty text, a known
 * source — a close-phase find is a Coordinator find, and `coordinator` is
 * already in the vocabulary), and ONE rule of its own: the `wave` sentinel must
 * actually be free. A Plan-Table row spelled `wave` would share this entry's
 * ref namespace, so the scope of an already-minted ref could no longer be read
 * back off the spine — refuse rather than mint it.
 */
export function addWaveDisclosureToSource(
  source: string,
  input: WaveDisclosureInput,
): { source: string; disclosure: Disclosure } {
  const text = normalizeDisclosureText(input.text ?? '');
  if (!text) {
    throw new Error('addDisclosure: --text is empty; a disclosure needs a gap description.');
  }
  if (!(DISCLOSURE_SOURCES as readonly string[]).includes(input.source)) {
    throw new Error(
      `addDisclosure: unknown source "${input.source}"; expected one of: ${DISCLOSURE_SOURCES.join(', ')}.`,
    );
  }
  const planTable = readSpine(source).planTable;
  if (planTable.some((r) => r.id === WAVE_SCOPE_ROW)) {
    throw new Error(
      `addDisclosure: cannot capture wave-scoped — the Plan-Table has a row with id "${WAVE_SCOPE_ROW}", ` +
        'which is the wave-scoped sentinel; capture it against that row instead.',
    );
  }

  return insertDisclosureEntry(source, {
    rowId: WAVE_SCOPE_ROW,
    iter: null,
    source: input.source,
    text,
  });
}

/**
 * The shared write half of both capture verbs: materialize the section, mint
 * the next ordinal within `rowId`, and splice one rendered row in.
 *
 * Every input is already validated by the caller — this helper enforces no
 * vocabulary of its own, which is why it stays module-private (the constructors
 * above are the domain's only doors in).
 */
function insertDisclosureEntry(
  source: string,
  entry: {
    rowId: string;
    iter: number | null;
    source: DisclosureSource;
    text: string;
  },
): { source: string; disclosure: Disclosure } {
  const withSection = ensureDisclosuresSection(source);
  const model = splitLines(withSection);
  const section = findDisclosuresSection(model.lines);
  if (!section) {
    throw new Error('addDisclosure: "## Disclosures" section could not be created.');
  }

  const existing = readDisclosures(withSection);
  const ordinal =
    existing
      .filter((d) => d.rowId === entry.rowId)
      .reduce((max, d) => Math.max(max, d.ordinal), 0) + 1;
  const disclosure: Disclosure = {
    ref: `${entry.rowId}.${ordinal}`,
    rowId: entry.rowId,
    ordinal,
    iter: entry.iter,
    source: entry.source,
    disposition: OPEN_DISPOSITION,
    text: entry.text,
    line: -1, // filled in below, once the insert point is known
  };

  // Insert after the last table row in the section (header/separator included),
  // so the surrounding sections stay byte-identical.
  let insertAfter = -1;
  for (let i = section.start + 1; i < section.end; i++) {
    if (splitDisclosureRow(model.lines[i]).length > 0) insertAfter = i;
  }
  if (insertAfter === -1) {
    throw new Error('addDisclosure: "## Disclosures" table is malformed (no header/separator).');
  }
  disclosure.line = insertAfter + 1;
  model.lines.splice(insertAfter + 1, 0, renderDisclosureRow(disclosure));
  return { source: joinLines(model), disclosure };
}

/**
 * Set exactly one entry's disposition, addressed by its `ref`.
 *
 * Refuses an out-of-vocabulary disposition by throwing — including `open`,
 * which is the capture default, not a decision. The gate demands only THAT a
 * disposition exists; it never judges quality (`dropped:<reason>` passes), so
 * the human override stays cheap and explicit.
 */
export function setDispositionInSource(
  source: string,
  ref: string,
  disposition: string,
): string {
  if (!isSettableDisposition(disposition)) {
    throw new Error(
      `set-disposition: invalid disposition "${disposition}"; expected one of: ${DISPOSITION_VOCABULARY}.`,
    );
  }
  const entries = readDisclosures(source);
  const matches = entries.filter((d) => d.ref === ref);
  if (matches.length === 0) {
    const known = entries.map((d) => d.ref).join(', ') || '(none)';
    throw new Error(
      `set-disposition: no disclosure with ref "${ref}"; known refs: ${known}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `set-disposition: ref "${ref}" is ambiguous — ${matches.length} entries share it.`,
    );
  }
  const model = splitLines(source);
  const target = matches[0];
  model.lines[target.line] = renderDisclosureRow({ ...target, disposition });
  return joinLines(model);
}

/** Injected fs seam — mirrors the engine's defaultXxxProbe idiom. */
export interface SpineIo {
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface SpineStore {
  /** Current structured view (re-parsed after each write). */
  spine(): Spine;
  /** Current mutated source, ready for disk (byte-identical on a no-op). */
  source(): string;
  /** Re-read from disk (rebinds source + spine); for human-edit-between-ops recovery. */
  reload(): void;
  /** Persist source() to disk via the injected SpineIo. */
  flush(): void;

  setRowState(id: string, state: RowState): void;
  /**
   * Bump the row's `Iter` cell (and re-render its sidecar-link cell to the same
   * iteration's paths — observability only, FOR-53).
   *
   * It arrives on the store late, and for one reason: the cap=1 re-dispatch
   * writes the row STATE and this bump as a PAIR, and the pair must share one
   * flush. `spine set-row-iter` could stay off the store while it was a lone
   * CLI op — it reads and writes the file directly and says so — but a caller
   * that mixes the store (for the state) with the raw writer (for the iter)
   * flushes the store's pristine source over the raw write. `route-tuple`'s
   * re-dispatch branch is exactly that caller, so the op comes home.
   *
   * Throws when no Plan-Table row matches `id`, like every sibling writer.
   */
  setRowIter(id: string, iter: number): void;
  setRowPrCell(id: string, prCell: string): void;
  upsertPrLogRow(input: PrLogRowInput): void;
  /** The dispatch-log is the DURABLE branch home; Plan-Table.branch is derived-only. */
  upsertDispatchLogEntry(id: string, branch: string): void;
  /** Record the actually-dispatched model in the dispatch-log (ADR-0012); co-exists with the branch. */
  upsertDispatchLogModel(id: string, model: string): void;
  replaceClosedByBlock(body: string): void;
  setFrontmatterStatus(status: string): void;

  // ── Disclosures (ADR-0027) ─────────────────────────────────────────────────
  /** Every captured disclosure, in source order. `[]` on a pre-ADR-0027 spine. */
  disclosures(): Disclosure[];
  /** Only the `open` ones — a non-empty result is what blocks the archive. */
  openDisclosures(): Disclosure[];
  /** Materialize the `## Disclosures` section if absent; byte-identical no-op otherwise. */
  ensureDisclosuresSection(): void;
  /** Capture one ROW-scoped disclosure at `open`; returns the created entry (its `ref` is the address). */
  addDisclosure(input: DisclosureInput): Disclosure;
  /**
   * Capture one WAVE-scoped disclosure at `open` (ADR-0038) — no row, no
   * iteration. Same return contract as {@link SpineStore.addDisclosure}, and
   * the entry it mints is counted by the archive gate identically.
   */
  addWaveDisclosure(input: WaveDisclosureInput): Disclosure;
  /** Disposition exactly one entry, addressed by `ref`. Throws outside the vocabulary. */
  setDisposition(ref: string, disposition: string): void;

  branchesByIssueId(): Record<string, string>;
  rowState(id: string): RowState | string | null;
}

/** Construct a SpineStore over a source string (pure — no disk). */
export function spineStoreFromSource(initial: string, path?: string, io?: SpineIo): SpineStore {
  let src = initial;
  let parsed = readSpine(src);

  const rebind = (next: string) => {
    src = next;
    parsed = readSpine(src);
  };

  return {
    spine: () => parsed,
    source: () => src,
    reload() {
      if (!io || !path) throw new Error('reload() requires a disk-backed SpineStore');
      rebind(io.read(path));
    },
    flush() {
      if (!io || !path) throw new Error('flush() requires a disk-backed SpineStore');
      io.write(path, src);
    },
    setRowState(id, state) {
      rebind(setRowState(src, id, state));
    },
    setRowIter(id, iter) {
      rebind(setRowIter(src, id, iter));
    },
    setRowPrCell(id, prCell) {
      rebind(setRowPrCell(src, id, prCell));
    },
    upsertPrLogRow(input) {
      rebind(upsertPrLogRow(src, input));
    },
    upsertDispatchLogEntry(id, branch) {
      rebind(upsertDispatchLogEntry(src, id, branch));
    },
    upsertDispatchLogModel(id, model) {
      rebind(upsertDispatchLogModel(src, id, model));
    },
    replaceClosedByBlock(body) {
      rebind(replaceClosedByBlock(src, body));
    },
    setFrontmatterStatus(status) {
      rebind(setFrontmatterStatus(src, status));
    },
    // ── Disclosures (ADR-0027) ───────────────────────────────────────────────
    // Read straight off `src` rather than off `parsed`: the Disclosures section
    // is owned by THIS module, not by wave-md-rw's `Spine` view.
    disclosures: () => readDisclosures(src),
    openDisclosures: () => openDisclosures(src),
    ensureDisclosuresSection() {
      rebind(ensureDisclosuresSection(src));
    },
    addDisclosure(input) {
      const { source: next, disclosure } = addDisclosureToSource(src, input);
      rebind(next);
      return disclosure;
    },
    addWaveDisclosure(input) {
      const { source: next, disclosure } = addWaveDisclosureToSource(src, input);
      rebind(next);
      return disclosure;
    },
    setDisposition(ref, disposition) {
      rebind(setDispositionInSource(src, ref, disposition));
    },
    branchesByIssueId: () => branchesByIssueId(parsed),
    rowState: (id) => parsed.planTable.find((r) => r.id === id)?.state ?? null,
  };
}

/** Node fs-backed SpineIo (the only disk-touching code; isolated here). */
export function defaultSpineIo(): SpineIo {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    read: (p) => fs.readFileSync(p, 'utf-8'),
    write: (p, c) => fs.writeFileSync(p, c, 'utf-8'),
  };
}

/** Construct a disk-backed SpineStore (reads `path` now via `io`). */
export function createSpineStore(path: string, io: SpineIo = defaultSpineIo()): SpineStore {
  return spineStoreFromSource(io.read(path), path, io);
}
