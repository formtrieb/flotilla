/**
 * markdown-fs-store.ts — the Ur-parity IssueStore over a `.scratch/` markdown tree.
 *
 * Parity is scoped honestly (the adversarial review corrected the original
 * "byte-faithful inverse pair" claim): what is Ur-parity is the **path layout**
 * (`.scratch/<slug>/issues/<NN>-*.md`, `done/` on close), the H1, the six-field
 * Header-Block, the AC checklist, and the move-to-`done/` close. What is NOT Ur
 * is the per-issue **`**Wave-Status:**`** claim line — the Ur kept claims in the
 * spine, never the issue file; this is a deliberate flotilla-new coarse
 * projection (ADR-0002 permits it).
 *
 * Write discipline: create() serializes a fresh file; transition()/close() do
 * **surgical line edits** on the existing file — they never re-serialize from a
 * `HeaderBlock`, so unmodeled header fields (Created/Type/…) and Files
 * annotations the parser doesn't round-trip are preserved.
 */

import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createHeaderParser,
  serializeHeaderBlock,
  DEFAULT_WAVE_SCHEMA,
  type HeaderBlock,
} from '../header-parser';
import { extractAcBody } from '../dor-gate';
import type {
  IssueView,
  CoarseState,
  WaveSchema,
  IssueRef,
  TriageSchema,
  TriageView,
  ApplyTriageInput,
} from '../contract';
import { DEFAULT_TRIAGE_SCHEMA } from '../contract';
import {
  DEFAULT_ELIGIBILITY,
  validateAmendPatch,
  type IssueStore,
  type IssueStoreConformanceHooks,
  type CreateInput,
  type AnnotatePatch,
  type AmendPatch,
  type ListScope,
  type ClaimRung,
  type NeedsAttentionPayload,
  type PublishDocumentInput,
  type DocumentView,
  type ClosingState,
  withTriageDisclaimer,
} from './issue-store';
import { upsertSection } from './body-codec';

const STATUS_FIELD = 'Status';
const CLOSED_BY_FIELD = 'Closed-by';
/** flotilla-NEW claim marker (NOT an Ur convention — see file header). */
const WAVE_STATUS_FIELD = 'Wave-Status';
const VALID_RUNGS: readonly ClaimRung[] = ['queued', 'in-flight', 'in-review'];
/** Triage facet (ADR-0015): category is a header field; comments live in a `## Triage Log` section. */
const CATEGORY_FIELD = 'Category';
const TRIAGE_LOG_HEADING = 'Triage Log';
const TRIAGE_COMMENT_MARKER = '<!-- triage-comment -->';
/** needs-attention flag (ADR-0006): orthogonal to the Wave-Status claim rung. */
const NEEDS_ATTENTION_FIELD = 'Needs-Attention';
const NEEDS_ATTENTION_HEADING = 'Needs-Attention';

export interface MarkdownFsStoreOptions {
  /** Repo root that contains the `.scratch/` tree. */
  repoRoot: string;
  /** Feature slug → `.scratch/<slug>/issues/`. Also the `<slug>#NN` id prefix. */
  slug: string;
  /** Enum vocabulary (default {@link DEFAULT_WAVE_SCHEMA}). */
  schema?: WaveSchema;
  /**
   * The eligibility OR-set (ADR-0003): a `**Status:**` whose first token is in
   * this set makes the issue wave-ready. Default `['ready-for-agent']` (the
   * built-in default). create() stamps the first token so new issues are eligible.
   */
  eligibility?: readonly string[];
  /** Triage vocabulary (default {@link DEFAULT_TRIAGE_SCHEMA}, ADR-0015). */
  triageSchema?: TriageSchema;
}

export class MarkdownFsStore implements IssueStore {
  private readonly repoRoot: string;
  private readonly slug: string;
  private readonly schema: WaveSchema;
  private readonly eligibility: readonly string[];
  private readonly triageSchema: TriageSchema;

  constructor(opts: MarkdownFsStoreOptions) {
    this.repoRoot = opts.repoRoot;
    this.slug = opts.slug;
    this.schema = opts.schema ?? DEFAULT_WAVE_SCHEMA;
    this.eligibility = opts.eligibility ?? DEFAULT_ELIGIBILITY;
    this.triageSchema = opts.triageSchema ?? DEFAULT_TRIAGE_SCHEMA;
  }

  private get openDir(): string {
    return join(this.repoRoot, '.scratch', this.slug, 'issues');
  }
  private get doneDir(): string {
    return join(this.openDir, 'done');
  }
  /** The PRD document lives beside `issues/`, never inside it (ADR-0011). */
  private get prdPath(): string {
    return join(this.repoRoot, '.scratch', this.slug, 'prd.md');
  }
  private idFor(nn: string): string {
    return `${this.slug}#${nn}`;
  }

  // ── parseRef (opaque id → IssueRef inversion, ADR-0001) ───────────────────
  /** Invert a `<slug>#NN` id into `{slug, issue}`; throws on a non-numeric id (e.g. `<slug>#prd`). */
  parseRef(id: string): IssueRef {
    const hash = id.lastIndexOf('#');
    const slug = hash >= 0 ? id.slice(0, hash) : undefined;
    const issue = Number(hash >= 0 ? id.slice(hash + 1) : id);
    if (!Number.isInteger(issue)) {
      throw new Error(
        `parseRef: id "${id}" has no numeric issue part — not a wave-issue ref ` +
          `(a PRD is referenced by its parent id string, not a blocker IssueRef).`,
      );
    }
    return slug ? { slug, issue } : { issue };
  }

  // ── create ──────────────────────────────────────────────────────────────
  async create(input: CreateInput): Promise<string> {
    await mkdir(this.openDir, { recursive: true });
    const nn = await this.nextNN();
    const fileName = `${nn}-${input.filingHint}.md`;

    const header: HeaderBlock = {
      risk: input.risk as HeaderBlock['risk'],
      worker: input.worker as HeaderBlock['worker'],
      files: input.files,
      blockedBy: input.blockedBy,
      ...(input.estimatedWallclock !== undefined
        ? { estimatedWallclock: input.estimatedWallclock }
        : {}),
      ...(input.unblocks !== undefined ? { unblocks: input.unblocks } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
    };

    const parts: string[] = [];
    parts.push(`# ${nn} — ${input.title}`, '');
    parts.push(`**${STATUS_FIELD}:** ${this.eligibility[0]}`);
    parts.push(serializeHeaderBlock(header));
    for (const section of input.bodySections ?? []) {
      parts.push('', `## ${section.heading}`, '', section.markdown.trimEnd());
    }
    parts.push('', '## Acceptance criteria', '');
    for (const ac of input.acceptanceCriteria) {
      parts.push(`- [ ] ${ac.text}`);
    }
    const content = parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';

    await writeFile(join(this.openDir, fileName), content, 'utf-8');
    return this.idFor(nn);
  }

  // ── annotate (ADR-0010 decorate write-path) ───────────────────────────────
  async annotate(id: string, patch: AnnotatePatch): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');

    // risk/worker: surgical single-line upsert (same as create writes them).
    if (patch.risk !== undefined) source = upsertField(source, 'Risk', patch.risk);
    if (patch.worker !== undefined) source = upsertField(source, 'Worker', patch.worker);
    // files: replace the `**Files:**` list block in the header region.
    if (patch.files !== undefined) source = upsertFilesBlock(source, patch.files);
    // parent: surgical single-line upsert of the PRD backlink (its opaque id
    // string, ADR-0013), placed after `**Blocked by:**` to mirror the serializer
    // order; the parser is order-free.
    if (patch.parent !== undefined) {
      source = upsertField(source, 'Parent', patch.parent, {
        afterField: 'Blocked by',
      });
    }
    // AC: replace the `## Acceptance criteria` checklist.
    if (patch.acceptanceCriteria !== undefined) {
      source = upsertAcSection(source, patch.acceptanceCriteria);
    }
    // bodySections: append each as a `## heading` section (verbatim).
    if (patch.bodySections !== undefined) {
      source = appendBodySections(source, patch.bodySections);
    }

    await writeFile(located.path, source, 'utf-8');
  }

  // ── amend (ADR-0025 — authored content: title + free-prose sections) ───────
  async amend(id: string, patch: AmendPatch): Promise<void> {
    validateAmendPatch(patch); // whole-patch validation before any write (empty / blank heading)
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');

    // Sections FIRST so a reserved-heading collision (upsertSection throws,
    // naming annotate) aborts before the title is touched — no partial write.
    // MarkdownFs Files/Blocked by are `**Field:**` header LINES, not `## `
    // sections, so upsertSection over the whole file only ever touches the body
    // prose region (What to build, …); `## Acceptance criteria` is reserved and
    // rejected, keeping AC clobber structurally impossible.
    for (const section of patch.sections ?? []) {
      source = upsertSection(source, section.heading, section.markdown);
    }
    // Title: swap only the title part of the `# NN — Title` H1; the `NN — `
    // filing prefix and the filename (cosmetic slug, ADR-0001) stay.
    if (patch.title !== undefined) {
      source = replaceH1Title(source, located.fileName, patch.title);
    }
    await writeFile(located.path, source, 'utf-8'); // single atomic write (no partial application)
  }

  // ── read ────────────────────────────────────────────────────────────────
  async read(id: string): Promise<IssueView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    const { path, inDone } = located;
    const source = await readFile(path, 'utf-8');

    const parsed = createHeaderParser(this.schema).parse(source);
    if (!parsed.ok) {
      const msg = parsed.errors.map((e) => e.message).join('; ');
      throw new Error(`Malformed issue ${id}: ${msg}`);
    }
    const h = parsed.header;

    const status: CoarseState = inDone
      ? 'done'
      : readField(source, NEEDS_ATTENTION_FIELD) !== undefined
        ? 'needs-attention'
        : (this.readRung(source) ?? 'available');

    const closedBy = readField(source, CLOSED_BY_FIELD);

    return {
      id,
      risk: h.risk,
      worker: h.worker,
      files: h.files,
      blockedBy: h.blockedBy,
      ...(h.unblocks !== undefined ? { unblocks: h.unblocks } : {}),
      ...(h.parent !== undefined ? { parent: h.parent } : {}),
      acceptanceCriteria: parseAcs(source),
      status,
      ...(closedBy !== undefined ? { closedBy } : {}),
      ...(h.estimatedWallclock !== undefined
        ? { estimatedWallclock: h.estimatedWallclock }
        : {}),
    };
  }

  // ── transition (claim ledger) ─────────────────────────────────────────────
  async transition(id: string, rung: ClaimRung): Promise<void> {
    if (!VALID_RUNGS.includes(rung)) {
      throw new Error(
        `transition() accepts only ${VALID_RUNGS.join(' | ')}; got "${rung}". ` +
          `available/done are derived bookends and must not be written.`,
      );
    }
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    const source = await readFile(located.path, 'utf-8');
    // surgical: upsert the single Wave-Status line (mutually exclusive by nature).
    const next = upsertField(source, WAVE_STATUS_FIELD, rung);
    await writeFile(located.path, next, 'utf-8');
  }

  // ── unclaim (the queued→available reverse edge) ───────────────────────────
  async unclaim(id: string): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    const source = await readFile(located.path, 'utf-8');
    const next = removeField(source, WAVE_STATUS_FIELD); // no-op if absent
    if (next !== source) await writeFile(located.path, next, 'utf-8');
  }

  // ── flag / clearFlag (the orthogonal needs-attention overlay, ADR-0006) ────
  async flag(id: string, payload: NeedsAttentionPayload): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');
    // header marker (read() derives needs-attention from this line's presence).
    source = upsertField(source, NEEDS_ATTENTION_FIELD, payload.kind);
    // the human-facing payload block (replaced wholesale if already present).
    source = upsertNeedsAttentionBlock(source, payload);
    await writeFile(located.path, source, 'utf-8');
  }

  async clearFlag(id: string): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');
    source = removeField(source, NEEDS_ATTENTION_FIELD);
    source = removeNeedsAttentionBlock(source);
    await writeFile(located.path, source, 'utf-8');
  }

  // ── close (record-only; native close = the move below for markdown) ───────
  async close(id: string, prUrl: string, ackedAcIndexes: number[]): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');

    // record the closing PR ref at its canonical position (right after Status).
    source = upsertField(source, CLOSED_BY_FIELD, prUrl, { afterField: STATUS_FIELD });
    // cosmetic AC tick — best-effort, never throws on an unmatched index (ADR-0004).
    source = tickAcs(source, ackedAcIndexes);
    // clear the claim rung and flip the lifecycle line.
    source = removeField(source, WAVE_STATUS_FIELD);
    source = upsertField(source, STATUS_FIELD, 'done');

    if (located.inDone) {
      await writeFile(located.path, source, 'utf-8');
      return; // idempotent re-close
    }
    // markdown native close: write, then move to done/.
    await mkdir(this.doneDir, { recursive: true });
    await writeFile(located.path, source, 'utf-8');
    await rename(located.path, join(this.doneDir, located.fileName));
  }

  // ── readClosing (the closing probe, ADR-0005) ─────────────────────────────
  async readClosing(id: string): Promise<ClosingState> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    if (!located.inDone) return { state: 'open' };
    // closed (lives in done/): a recorded Closed-by PR ref ⇒ merged; a done file
    // with no PR ref (e.g. closeUnplanned's wontfix) ⇒ closed-unmerged.
    const source = await readFile(located.path, 'utf-8');
    const closedBy = readField(source, CLOSED_BY_FIELD);
    return closedBy !== undefined && closedBy.trim() !== ''
      ? { state: 'merged', prUrl: closedBy.trim() }
      : { state: 'closed-unmerged' };
  }

  // ── listOpen (eligibility OR-set) ─────────────────────────────────────────
  async listOpen(_scope: ListScope): Promise<IssueView[]> {
    const names = await safeReaddir(this.openDir);
    const out: IssueView[] = [];
    for (const name of names) {
      const m = /^(\d+)-.*\.md$/.exec(name);
      if (!m) continue;
      const source = await readFile(join(this.openDir, name), 'utf-8');
      if (this.readRung(source) !== null) continue; // claimed → not available
      if (readField(source, NEEDS_ATTENTION_FIELD) !== undefined) continue; // flagged → not available
      if (!this.isEligible(source)) continue; // ADR-0003 OR-set
      out.push(await this.read(this.idFor(m[1])));
    }
    return out;
  }

  async listClaimed(): Promise<IssueView[]> {
    const names = await safeReaddir(this.openDir);
    const out: IssueView[] = [];
    for (const name of names) {
      const m = /^(\d+)-.*\.md$/.exec(name);
      if (!m) continue;
      const source = await readFile(join(this.openDir, name), 'utf-8');
      if (this.readRung(source) === null) continue; // unclaimed → skip
      out.push(await this.read(this.idFor(m[1])));
    }
    return out;
  }

  // ── Document facet (ADR-0011): a PRD lives at .scratch/<slug>/prd.md ───────
  async publishDocument(input: PublishDocumentInput): Promise<string> {
    await mkdir(join(this.repoRoot, '.scratch', this.slug), { recursive: true });
    const parts: string[] = [`# ${input.title}`, ''];
    for (const s of input.bodySections) {
      parts.push(`## ${s.heading}`, '', s.markdown.trimEnd(), '');
    }
    const content = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    await writeFile(this.prdPath, content, 'utf-8');
    return `${this.slug}#prd`;
  }

  async readDocument(id: string): Promise<DocumentView> {
    let source: string;
    try {
      source = await readFile(this.prdPath, 'utf-8');
    } catch {
      throw new Error(`Document not found: ${id}`);
    }
    const { title, body } = splitTitleBody(source);
    return { id: `${this.slug}#prd`, title, body };
  }

  async listDocuments(): Promise<DocumentView[]> {
    let source: string;
    try {
      source = await readFile(this.prdPath, 'utf-8');
    } catch {
      return []; // no prd.md in this slug folder → no document
    }
    const { title, body } = splitTitleBody(source);
    return [{ id: `${this.slug}#prd`, title, body }];
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private readRung(source: string): ClaimRung | null {
    const v = readField(source, WAVE_STATUS_FIELD);
    return v && (VALID_RUNGS as readonly string[]).includes(v)
      ? (v as ClaimRung)
      : null;
  }

  private isEligible(source: string): boolean {
    const status = readField(source, STATUS_FIELD);
    if (!status) return false;
    return this.eligibility.includes(eligibilityToken(status));
  }

  private async nextNN(): Promise<string> {
    const all = [
      ...(await safeReaddir(this.openDir)),
      ...(await safeReaddir(this.doneDir)),
    ];
    let max = 0;
    for (const name of all) {
      const m = /^(\d+)-/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return String(max + 1).padStart(2, '0');
  }

  private async locate(
    id: string,
  ): Promise<{ path: string; fileName: string; inDone: boolean } | null> {
    const hash = id.lastIndexOf('#');
    if (hash < 0) return null;
    const nn = id.slice(hash + 1);
    for (const [dir, inDone] of [
      [this.openDir, false],
      [this.doneDir, true],
    ] as const) {
      const names = await safeReaddir(dir);
      const match = names.find((n) => new RegExp(`^0*${Number(nn)}-.*\\.md$`).test(n));
      if (match) return { path: join(dir, match), fileName: match, inDone };
    }
    return null;
  }

  // ── Triage facet (ADR-0015) — state in **Status:**, comments in ## Triage Log ──
  async readTriage(id: string): Promise<TriageView> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    const source = await readFile(located.path, 'utf-8');
    const { title: h1, body } = splitTitleBody(source);
    // Drop ONLY this file's own `NN — ` filing prefix (from create()), tied to the
    // located filename's NN — never a real title that happens to start with digits
    // (e.g. an externally-authored `# 1984 — …`, whose NN won't match).
    const nn = located.fileName.match(/^(\d+)-/)?.[1];
    const title = nn ? h1.replace(new RegExp(`^${nn}\\s+—\\s+`), '') : h1;
    const statusRaw = readField(source, STATUS_FIELD);
    const state = statusRaw ? eligibilityToken(statusRaw) : undefined;
    const category = readField(source, CATEGORY_FIELD);
    const comments = parseTriageLog(source).map((body) => ({ body }));
    return {
      id,
      title,
      body,
      ...(state !== undefined && state !== '' ? { state } : {}),
      ...(category !== undefined ? { category } : {}),
      comments,
    };
  }

  async applyTriage(id: string, input: ApplyTriageInput): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    if (input.state !== undefined && !this.triageSchema.states.includes(input.state)) {
      throw new Error(
        `"${input.state}" is not a valid triage state. Expected one of: ${this.triageSchema.states.join(' | ')}.`,
      );
    }
    if (input.category !== undefined && !this.triageSchema.categories.includes(input.category)) {
      throw new Error(
        `"${input.category}" is not a valid triage category. Expected one of: ${this.triageSchema.categories.join(' | ')}.`,
      );
    }
    let source = await readFile(located.path, 'utf-8');
    if (input.state !== undefined) source = upsertField(source, STATUS_FIELD, input.state);
    if (input.category !== undefined) source = upsertField(source, CATEGORY_FIELD, input.category);
    if (input.comment !== undefined) {
      source = appendTriageComment(source, withTriageDisclaimer(input.comment));
    }
    await writeFile(located.path, source, 'utf-8');
  }

  async closeUnplanned(id: string, comment: string): Promise<void> {
    const located = await this.locate(id);
    if (!located) throw new Error(`Issue not found: ${id}`);
    let source = await readFile(located.path, 'utf-8');
    source = upsertField(source, STATUS_FIELD, this.triageSchema.unplannedState);
    source = appendTriageComment(source, withTriageDisclaimer(comment));
    source = removeField(source, WAVE_STATUS_FIELD); // drop any claim rung
    if (located.inDone) {
      await writeFile(located.path, source, 'utf-8');
      return; // idempotent re-close
    }
    await mkdir(this.doneDir, { recursive: true });
    await writeFile(located.path, source, 'utf-8');
    await rename(located.path, join(this.doneDir, located.fileName));
  }
}

/** The markdown native-close seam for the shared conformance suite. */
export const markdownConformanceHooks: IssueStoreConformanceHooks = {
  // close() already performed the git-mv-equivalent move to done/; this is a
  // no-op-or-reconcile (the issue is already natively closed for markdown).
  async simulateNativeClose() {
    /* intentionally empty — markdown self-closes inside close() */
  },
};

// ─── pure header/markdown helpers (surgical, no re-serialization) ────────────

/** Split a PRD doc (ADR-0011) into its H1 title and the prose below it. */
function splitTitleBody(source: string): { title: string; body: string } {
  const lines = source.split('\n');
  let title = '';
  let i = 0;
  let matched = false;
  for (; i < lines.length; i++) {
    const m = /^#\s+(.*)$/.exec(lines[i]);
    if (m) {
      title = m[1].trim();
      i++;
      matched = true;
      break;
    }
  }
  // No H1 (an externally-authored / hand-edited issue file) → the whole source
  // is the body; never silently drop it. H1-led callers (the store's own PRDs
  // and create()d issues) keep byte-identical behavior since matched is true.
  if (!matched) i = 0;
  return { title, body: lines.slice(i).join('\n').trim() };
}

/**
 * Replace the title part of the `# NN — Title` H1 (the Amend facet, ADR-0025),
 * preserving the `NN — ` filing prefix that {@link MarkdownFsStore.create}
 * stamps (tied to the located filename's NN, exactly as {@link splitTitleBody}/
 * `readTriage` strips it back) — so `readTriage().title` round-trips the new
 * title. An externally-authored H1 whose prefix does NOT match the filename NN
 * (e.g. `# 1984 — …`) has its whole title replaced; an H1-less file gets one
 * prepended rather than silently dropping the amend. The FILENAME is never
 * renamed (a cosmetic slug, never a key — ADR-0001).
 */
function replaceH1Title(source: string, fileName: string, newTitle: string): string {
  const nn = fileName.match(/^(\d+)-/)?.[1];
  const lines = source.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i < 0) {
    return `# ${newTitle}\n\n${source}`;
  }
  const m = /^#\s+(\d+)\s+—\s+/.exec(lines[i]);
  if (m && nn !== undefined && m[1] === nn) {
    lines[i] = `# ${nn} — ${newTitle}`; // keep the create() `NN — ` filing prefix
  } else {
    lines[i] = `# ${newTitle}`; // externally-authored H1 (no matching NN prefix)
  }
  return lines.join('\n');
}

/** Index just past the first `## ` heading line; header region is everything before. */
function firstH2Offset(source: string): number {
  const m = /^##\s+/m.exec(source);
  return m ? m.index : source.length;
}

/** Read a `**Field:**` value from the header region only (undefined if absent). */
function readField(source: string, name: string): string | undefined {
  const header = source.slice(0, firstH2Offset(source));
  const re = new RegExp(`^\\*\\*${escapeRe(name)}:\\*\\*\\s*(.*)$`, 'm');
  const m = re.exec(header);
  return m ? m[1].trim() : undefined;
}

/**
 * Surgically upsert a `**Field:** value` line in the header region. If the field
 * exists, replace its line in place (preserving everything else). Otherwise
 * insert it — after `opts.afterField` if given and present, else after the H1.
 */
function upsertField(
  source: string,
  name: string,
  value: string,
  opts: { afterField?: string } = {},
): string {
  const lines = source.split('\n');
  const h2 = lines.findIndex((l) => /^##\s+/.test(l));
  const headerEnd = h2 < 0 ? lines.length : h2;
  const fieldRe = new RegExp(`^\\*\\*${escapeRe(name)}:\\*\\*`);
  const newLine = `**${name}:** ${value}`;

  for (let i = 0; i < headerEnd; i++) {
    if (fieldRe.test(lines[i])) {
      lines[i] = newLine;
      return lines.join('\n');
    }
  }
  // insert
  let at = 0;
  if (opts.afterField) {
    const afterRe = new RegExp(`^\\*\\*${escapeRe(opts.afterField)}:\\*\\*`);
    for (let i = 0; i < headerEnd; i++) {
      if (afterRe.test(lines[i])) {
        at = i + 1;
        break;
      }
    }
  }
  if (at === 0) {
    // after the H1 (and its trailing blank line) if present, else top of header.
    const h1 = lines.findIndex((l) => /^#\s+/.test(l));
    at = h1 >= 0 ? h1 + 1 : 0;
    if (lines[at] === '') at += 1;
  }
  lines.splice(at, 0, newLine);
  return lines.join('\n');
}

/** Remove a `**Field:**` line from the header region (no-op if absent). */
function removeField(source: string, name: string): string {
  const lines = source.split('\n');
  const h2 = lines.findIndex((l) => /^##\s+/.test(l));
  const headerEnd = h2 < 0 ? lines.length : h2;
  const fieldRe = new RegExp(`^\\*\\*${escapeRe(name)}:\\*\\*`);
  for (let i = 0; i < headerEnd; i++) {
    if (fieldRe.test(lines[i])) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return source;
}

/**
 * Replace the `**Files:**` list block in the header region with `files`, leaving
 * everything else untouched. The block is the `**Files:**` line plus the `- `
 * list items immediately under it. If `**Files:**` is absent, insert a fresh
 * block at the end of the header region (just before the first `## `).
 */
function upsertFilesBlock(source: string, files: string[]): string {
  const lines = source.split('\n');
  const h2 = lines.findIndex((l) => /^##\s+/.test(l));
  const headerEnd = h2 < 0 ? lines.length : h2;
  const block = ['**Files:**', ...files.map((f) => `- ${f}`)];

  const fieldIdx = lines.findIndex(
    (l, i) => i < headerEnd && /^\*\*Files:\*\*/.test(l),
  );
  if (fieldIdx >= 0) {
    // consume the `- ` list items immediately following the **Files:** line.
    let end = fieldIdx + 1;
    while (end < headerEnd && /^[-*]\s+/.test(lines[end])) end++;
    lines.splice(fieldIdx, end - fieldIdx, ...block);
    return lines.join('\n');
  }
  // insert a fresh block at the end of the header region, blank-separated from
  // the following section the way create() always writes it (no list abutting
  // the next `## ` heading). Normalize runs of blank lines for create-parity.
  lines.splice(headerEnd, 0, ...block, '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Replace the `## Acceptance criteria` checklist with `acs`, preserving the rest
 * of the document. If the section is absent, append it at the end.
 */
function upsertAcSection(
  source: string,
  acs: { text: string; checked: boolean }[],
): string {
  const lines = source.split('\n');
  let acStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Acceptance\s+criteria\s*$/i.test(lines[i])) {
      acStart = i;
      break;
    }
  }
  const items = acs.map((a) => `- [${a.checked ? 'x' : ' '}] ${a.text}`);
  if (acStart < 0) {
    const out = source.replace(/\n+$/, '');
    return `${out}\n\n## Acceptance criteria\n\n${items.join('\n')}\n`;
  }
  // find the section end (next `## ` or EOF) and replace the checklist lines,
  // keeping any blank line right after the heading.
  let end = acStart + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  const body = ['', ...items, ''];
  lines.splice(acStart + 1, end - (acStart + 1), ...body);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Append each free-prose `## heading` section verbatim at the end of the doc. */
function appendBodySections(
  source: string,
  sections: { heading: string; markdown: string }[],
): string {
  let out = source.replace(/\n+$/, '');
  for (const s of sections) {
    out += `\n\n## ${s.heading}\n\n${s.markdown.trimEnd()}`;
  }
  return out + '\n';
}

/**
 * Upsert the `## Needs-Attention` payload block (ADR-0006): replace it wholesale
 * if present, else append it at EOF. Renders the kind, question, and options as
 * a stable, re-parseable block (the headless-async bridge reads it; flotilla
 * round-trips it but does not re-validate it).
 */
function upsertNeedsAttentionBlock(
  source: string,
  payload: NeedsAttentionPayload,
): string {
  const block = [
    `**kind:** ${payload.kind}`,
    '',
    `**question:** ${payload.question}`,
    '',
    '**options:**',
    ...payload.options.map((o) => `- ${o}`),
  ].join('\n');
  const lines = source.split('\n');
  const headingRe = new RegExp(`^##\\s+${escapeRe(NEEDS_ATTENTION_HEADING)}\\s*$`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) {
    const out = source.replace(/\n+$/, '');
    return `${out}\n\n## ${NEEDS_ATTENTION_HEADING}\n\n${block}\n`;
  }
  // replace from the heading to the next `## ` (or EOF) with a fresh block.
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  const replacement = [`## ${NEEDS_ATTENTION_HEADING}`, '', block, ''];
  lines.splice(start, end - start, ...replacement);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Remove the `## Needs-Attention` block (no-op if absent). */
function removeNeedsAttentionBlock(source: string): string {
  const lines = source.split('\n');
  const headingRe = new RegExp(`^##\\s+${escapeRe(NEEDS_ATTENTION_HEADING)}\\s*$`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return source;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  lines.splice(start, end - start);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n';
}

/**
 * Append a triage comment to the `## Triage Log` section (creating it at EOF if
 * absent). Each comment is prefixed with an HTML-comment marker so multiple
 * comments round-trip via {@link parseTriageLog} (ADR-0015).
 */
function appendTriageComment(source: string, body: string): string {
  const block = `${TRIAGE_COMMENT_MARKER}\n${body}`;
  const lines = source.split('\n');
  const headingRe = new RegExp(`^##\\s+${escapeRe(TRIAGE_LOG_HEADING)}\\s*$`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) {
    const out = source.replace(/\n+$/, '');
    return `${out}\n\n## ${TRIAGE_LOG_HEADING}\n\n${block}\n`;
  }
  // find section end (next `## ` or EOF), append the block there.
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  const head = lines.slice(0, end);
  const tail = lines.slice(end);
  // trim trailing blanks inside the section, then append a blank-separated block.
  while (head.length > start + 1 && head[head.length - 1] === '') head.pop();
  head.push('', block);
  return [...head, ...tail].join('\n');
}

/** Parse the `## Triage Log` section into comment bodies (oldest-first). */
function parseTriageLog(source: string): string[] {
  const lines = source.split('\n');
  const headingRe = new RegExp(`^##\\s+${escapeRe(TRIAGE_LOG_HEADING)}\\s*$`);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  const section = lines.slice(start + 1, end).join('\n');
  return section
    .split(TRIAGE_COMMENT_MARKER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const AC_LINE = /^- \[([ xX])\]\s*(.*)$/;

/** Parse the `## Acceptance criteria` checklist into {text, checked}[]. */
function parseAcs(source: string): { text: string; checked: boolean }[] {
  const body = extractAcBody(source);
  if (!body) return [];
  const out: { text: string; checked: boolean }[] = [];
  for (const line of body.split('\n')) {
    const m = AC_LINE.exec(line);
    if (m) out.push({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x' });
  }
  return out;
}

/** Tick the AC checkboxes at the given 0-based indexes (best-effort, cosmetic). */
function tickAcs(source: string, indexes: number[]): string {
  if (indexes.length === 0) return source;
  const want = new Set(indexes);
  const lines = source.split('\n');
  let acStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Acceptance\s+criteria\s*$/i.test(lines[i])) {
      acStart = i;
      break;
    }
  }
  if (acStart < 0) return source;
  let acIdx = 0;
  for (let i = acStart + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break; // next section
    const m = AC_LINE.exec(lines[i]);
    if (!m) continue;
    if (want.has(acIdx)) lines[i] = `- [x] ${m[2]}`;
    acIdx++;
  }
  return lines.join('\n');
}

/** The eligibility keyword = first token, ignoring a trailing prose parenthetical. */
function eligibilityToken(statusValue: string): string {
  return statusValue.replace(/\s*\(.*$/s, '').trim().split(/\s+/)[0] ?? '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
