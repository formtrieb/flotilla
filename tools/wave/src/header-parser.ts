/**
 * Parser + serializer for the Issue-Header-Block.
 *
 * Schema is canonical in docs/agents/issue-tracker.md §Wave-Eligibility.
 * Four required + two optional bold-Markdown fields placed in the frontmatter
 * region of a `.scratch/<slug>/issues/<NN>-<slug>.md` file.
 *
 * Used by the `/wave validate` skill and by `/wave create` (#07).
 */

import type { WaveSchema, IssueRef, BlockedBy } from './contract';

export type { IssueRef, BlockedBy };

export const RISK_VALUES = [
  'mechanical',
  'isolated-refactor',
  'cross-feature-refactor',
  'public-API-change',
] as const;

export const WORKER_VALUES = [
  'background',
  'background-heavy',
  'foreground',
  'HITL-required',
] as const;

export type Risk = (typeof RISK_VALUES)[number];
export type Worker = (typeof WORKER_VALUES)[number];

/**
 * The Ur's frozen Risk + Worker sets, shipped as the built-in default vocabulary
 * (P0 note: "the Ur's enums as built-in defaults"). A consumer supplies its own
 * via `wave.config` and {@link createHeaderParser}; for M1 the Risk half stays
 * this frozen set (ADR-0007), only Worker is trimmed.
 */
export const DEFAULT_WAVE_SCHEMA: WaveSchema = {
  riskValues: RISK_VALUES,
  workerValues: WORKER_VALUES,
};

export interface HeaderBlock {
  risk: Risk;
  worker: Worker;
  /** Raw entries: paths or globs. Annotation arrows are stripped. */
  files: string[];
  blockedBy: BlockedBy;
  /** Optional. Free-form (`30min`, `2h`, `4-6h`). */
  estimatedWallclock?: string;
  /** Optional. Forward-reference; same shape as Blocked by but never `'none'`. */
  unblocks?: IssueRef[];
  /** Optional. Backlink to the PRD this slice was sliced from; the PRD's opaque id string (ADR-0013), NOT an `IssueRef`. */
  parent?: string;
}

export interface ParseError {
  line: number;
  message: string;
  field?: string;
}

export type ParseResult =
  | { ok: true; header: HeaderBlock; warnings?: ParseError[] }
  | { ok: false; errors: ParseError[] };

// ─── parser ────────────────────────────────────────────────────────────────

const FIELD_PATTERN = /^\*\*([^*:]+):\*\*\s*(.*)$/;
const LIST_ITEM_PATTERN = /^[-*]\s+(.+)$/;
const HEADING_PATTERN = /^#+\s+/;
/**
 * The Header-Block is, by schema (docs/agents/issue-tracker.md §Wave-Eligibility),
 * the frontmatter region above the first H2. An H2 (`## …`) marks the start of
 * body prose ("## What to build", "## Acceptance criteria", …) — anything below
 * it that *looks* like a header field (an Agent Brief that restates
 * `**Category:**`, `**Summary:**`, …) is documentation, not a real field.
 */
const H2_PATTERN = /^##\s+/;

interface RawField {
  name: string;
  inlineValue: string;
  listItems: string[];
  /** 1-indexed source line number of the `**Field:**` line. */
  line: number;
  /**
   * True when this field's `**Field:**` line precedes the first H2 heading
   * (i.e. it lives in the header region). Body fields below the first H2 are
   * collected but flagged so the duplicate-field guard and required-field
   * lookup in `parseHeaderBlock` can ignore them. Fields inside a fenced code
   * block are never collected at all (see `inFence`).
   */
  inHeaderRegion: boolean;
}

function collectFields(source: string): RawField[] {
  const lines = source.split(/\r?\n/);
  const fields: RawField[] = [];
  let current: RawField | null = null;
  let inFence = false;
  // The header region runs from the title down to the first H2 heading. Once
  // we pass the first `## …` line (outside any fenced code block), every field
  // collected after it is body prose and is tagged `inHeaderRegion: false`.
  // When a file has no H2 at all (e.g. a bare serialized header or a unit-test
  // fixture), the whole document stays in the header region — preserving the
  // pre-fix whole-file behaviour for those inputs.
  let inHeaderRegion = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip fenced code blocks — header-block-shaped lines inside ```…``` are
    // schema examples, not real header fields (issue #01 of this PRD inlines
    // the schema in a fenced code block, and we must not pick it up). An H2
    // *inside* a fence must not close the header region either, which is why
    // this fence handling sits before the H2 boundary check below.
    if (/^```/.test(line.trimStart())) {
      if (current) {
        fields.push(current);
        current = null;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // First H2 (outside a fence) ends the header region. Fields below it are
    // body prose — collected so an advisory shadow-warning can still find them,
    // but flagged so the dedup guard / required-field lookup ignore them.
    if (inHeaderRegion && H2_PATTERN.test(line)) {
      inHeaderRegion = false;
    }

    const fieldMatch = FIELD_PATTERN.exec(line);

    if (fieldMatch) {
      if (current) fields.push(current);
      current = {
        name: fieldMatch[1].trim(),
        inlineValue: fieldMatch[2].trim(),
        listItems: [],
        line: i + 1,
        inHeaderRegion,
      };
      continue;
    }

    if (current && current.inlineValue === '') {
      const itemMatch = LIST_ITEM_PATTERN.exec(line);
      if (itemMatch) {
        current.listItems.push(stripAnnotation(itemMatch[1]).trim());
        continue;
      }
      if (line.trim() === '') continue;
      if (HEADING_PATTERN.test(line) || line.trim().length > 0) {
        fields.push(current);
        current = null;
      }
    } else if (current) {
      fields.push(current);
      current = null;
    }
  }
  if (current) fields.push(current);
  return fields;
}

function stripAnnotation(entry: string): string {
  return entry.replace(/\s+←.*$/, '').trim();
}

function parseIssueRefList(
  raw: string,
  fieldName: string,
  line: number,
): IssueRef[] | ParseError {
  const refs: IssueRef[] = [];
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const entry of entries) {
    const cleaned = stripAnnotation(entry);
    const cross = /^([a-z0-9][a-z0-9-]*)#(\d+)$/i.exec(cleaned);
    const same = /^#(\d+)$/.exec(cleaned);
    if (cross) {
      refs.push({ slug: cross[1], issue: Number(cross[2]) });
    } else if (same) {
      refs.push({ issue: Number(same[1]) });
    } else {
      return {
        line,
        field: fieldName,
        message: `"${entry}" is not a valid issue ref. Expected "#NN" or "<slug>#NN".`,
      };
    }
  }
  return refs;
}

/**
 * A header parser bound to a specific enum vocabulary. Returned by
 * {@link createHeaderParser}; the markdown adapter holds one of these.
 */
export interface HeaderParser {
  parse(source: string): ParseResult;
}

/**
 * Build a header parser bound to a consumer's enum vocabulary (the keystone P1
 * parameterization — the vocab lives in config, not the code). Defaults to
 * {@link DEFAULT_WAVE_SCHEMA} (the Ur's frozen sets).
 */
export function createHeaderParser(
  schema: WaveSchema = DEFAULT_WAVE_SCHEMA,
): HeaderParser {
  return { parse: (source) => parseWithSchema(source, schema) };
}

/**
 * Parse against the default (the Ur's) vocabulary. Back-compat shim over
 * {@link createHeaderParser} — identical behavior to the pre-P1 parser.
 */
export function parseHeaderBlock(source: string): ParseResult {
  return parseWithSchema(source, DEFAULT_WAVE_SCHEMA);
}

function parseWithSchema(source: string, schema: WaveSchema): ParseResult {
  const raw = collectFields(source);
  const errors: ParseError[] = [];

  // Only header-region fields (above the first H2) participate in the
  // duplicate-field guard and required-field lookup. Body prose below the
  // first H2 — an Agent Brief that restates `**Category:**`, `**Summary:**`,
  // etc. — is documentation, not a real field, and must not make a valid
  // issue silently unparseable (#71). A genuine duplicate *within* the header
  // region is still a hard error.
  const headerFields = raw.filter((f) => f.inHeaderRegion);

  const byName = new Map<string, RawField>();
  for (const field of headerFields) {
    const previous = byName.get(field.name);
    if (previous) {
      errors.push({
        line: field.line,
        field: field.name,
        message: `Duplicate field "${field.name}" (first seen line ${previous.line}).`,
      });
    }
    byName.set(field.name, field);
  }

  const requiredNames = ['Risk', 'Worker', 'Files', 'Blocked by'] as const;
  const required: Partial<Record<(typeof requiredNames)[number], RawField>> =
    {};
  for (const name of requiredNames) {
    const field = byName.get(name);
    if (field) {
      required[name] = field;
    } else {
      errors.push({
        line: 0,
        field: name,
        message: `Required field "**${name}:**" is missing.`,
      });
    }
  }

  const risk = required['Risk'];
  const worker = required['Worker'];
  const files = required['Files'];
  const blockedBy = required['Blocked by'];

  if (!risk || !worker || !files || !blockedBy) {
    return { ok: false, errors };
  }

  const riskValue = risk.inlineValue as Risk;
  if (!schema.riskValues.includes(riskValue)) {
    errors.push({
      line: risk.line,
      field: 'Risk',
      message: `"${riskValue}" is not a valid Risk value. Expected one of: ${schema.riskValues.join(' | ')}.`,
    });
  }

  const workerValue = worker.inlineValue as Worker;
  if (!schema.workerValues.includes(workerValue)) {
    errors.push({
      line: worker.line,
      field: 'Worker',
      message: `"${workerValue}" is not a valid Worker value. Expected one of: ${schema.workerValues.join(' | ')}.`,
    });
  }

  if (files.listItems.length === 0 && files.inlineValue === '') {
    errors.push({
      line: files.line,
      field: 'Files',
      message: `"**Files:**" must list at least one path or glob.`,
    });
  }

  const fileEntries =
    files.listItems.length > 0
      ? files.listItems
      : files.inlineValue
          .split(',')
          .map((s) => stripAnnotation(s).trim())
          .filter((s) => s.length > 0);

  let blockedByValue: BlockedBy;
  const blockedRaw = blockedBy.inlineValue.trim();
  if (blockedRaw === '' || blockedRaw.toLowerCase() === 'none') {
    blockedByValue = 'none';
  } else {
    const parsed = parseIssueRefList(blockedRaw, 'Blocked by', blockedBy.line);
    if (!Array.isArray(parsed)) {
      errors.push(parsed);
      blockedByValue = 'none';
    } else {
      blockedByValue = parsed;
    }
  }

  let unblocks: IssueRef[] | undefined;
  const unblocksField = byName.get('Unblocks');
  if (unblocksField && unblocksField.inlineValue.trim() !== '') {
    const parsed = parseIssueRefList(
      unblocksField.inlineValue,
      'Unblocks',
      unblocksField.line,
    );
    if (Array.isArray(parsed)) {
      unblocks = parsed;
    } else {
      errors.push(parsed);
    }
  }

  // Parent is the PRD's opaque id STRING (ADR-0013), never parsed into an
  // IssueRef — a markdown PRD's `<slug>#prd` id isn't IssueRef-representable, and
  // a backlink only needs the document's identity, which the engine never parses.
  let parent: string | undefined;
  const parentField = byName.get('Parent');
  if (parentField && parentField.inlineValue.trim() !== '') {
    parent = parentField.inlineValue.trim();
  }

  let estimatedWallclock: string | undefined;
  const estField = byName.get('Estimated wallclock');
  if (estField && estField.inlineValue.trim() !== '') {
    estimatedWallclock = estField.inlineValue.trim();
  }

  if (errors.length > 0) return { ok: false, errors };

  // Advisory (non-fatal): nudge authors toward #69's convention. When a body
  // field-label (below the first H2) shadows a real header field-name, the file
  // still parses — this just surfaces the shadow so the author can rename it
  // (e.g. `**Category:**` → `**Brief category:**`). NEVER a hard error: that is
  // exactly the body-scoped failure mode #71 removes.
  const warnings: ParseError[] = [];
  for (const field of raw) {
    if (field.inHeaderRegion) continue;
    if (byName.has(field.name)) {
      warnings.push({
        line: field.line,
        field: field.name,
        message: `Body field-label "**${field.name}:**" (below the first "## " heading) shadows a header field. It is ignored by the parser; consider renaming it (e.g. "**Brief ${field.name.toLowerCase()}:**") per the issue-authoring convention.`,
      });
    }
  }

  return {
    ok: true,
    header: {
      risk: riskValue,
      worker: workerValue,
      files: fileEntries,
      blockedBy: blockedByValue,
      ...(estimatedWallclock !== undefined ? { estimatedWallclock } : {}),
      ...(unblocks !== undefined ? { unblocks } : {}),
      ...(parent !== undefined ? { parent } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── serializer ────────────────────────────────────────────────────────────

function refToString(ref: IssueRef): string {
  return ref.slug ? `${ref.slug}#${ref.issue}` : `#${ref.issue}`;
}

export function serializeHeaderBlock(header: HeaderBlock): string {
  const lines: string[] = [];
  lines.push(`**Risk:** ${header.risk}`);
  lines.push(`**Worker:** ${header.worker}`);
  lines.push(`**Files:**`);
  for (const file of header.files) {
    lines.push(`- ${file}`);
  }
  const blocked =
    header.blockedBy === 'none'
      ? 'none'
      : header.blockedBy.map(refToString).join(', ');
  lines.push(`**Blocked by:** ${blocked}`);
  if (header.parent !== undefined) {
    lines.push(`**Parent:** ${header.parent}`); // opaque PRD id string, verbatim (ADR-0013)
  }
  if (header.estimatedWallclock !== undefined) {
    lines.push(`**Estimated wallclock:** ${header.estimatedWallclock}`);
  }
  if (header.unblocks !== undefined) {
    lines.push(`**Unblocks:** ${header.unblocks.map(refToString).join(', ')}`);
  }
  return lines.join('\n');
}
