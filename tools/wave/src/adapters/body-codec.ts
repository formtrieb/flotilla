/**
 * body-codec.ts — shared markdown-body codec used by the GitHub and Linear adapters.
 *
 * Serializes/parses the issue BODY for wave header-block fields. On both GitHub and
 * Linear the wave header-block lives differently from MarkdownFsStore's `**Field:**`
 * lines (CHARTER §5 mapping): `risk`/`worker` are LABELS (not body), while
 * `files`/`blockedBy`/`unblocks`/`acceptanceCriteria` live as `##` body sections
 * (the Matt-Pocock template shape that to-issues decorates — ADR-0010).
 * `closedBy`/`estimatedWallclock` are managed `**Field:**` lines.
 *
 * For M1 these body sections are AUTHORITATIVE (read-source of truth): the native
 * issue-dependencies API is new/unverified, and body parity with MarkdownFsStore
 * keeps the create→read round-trip testable against the in-memory fake.
 */

import type { IssueRef, BlockedBy } from '../contract';

export interface ParsedBody {
  files: string[];
  blockedBy: BlockedBy;
  unblocks?: IssueRef[];
  /** Backlink to the PRD this slice came from; the PRD's opaque id string (ADR-0013), read from a `**Parent:**` line. */
  parent?: string;
  acceptanceCriteria: { text: string; checked: boolean }[];
  estimatedWallclock?: string;
  closedBy?: string;
}

export interface BodyInput {
  files: string[];
  blockedBy: BlockedBy;
  unblocks?: IssueRef[];
  /** Backlink to the PRD this slice came from; the PRD's opaque id string (ADR-0013), rendered as a `**Parent:** #<id>` line — the `#` lights up GitHub's cross-reference on the PRD. */
  parent?: string;
  acceptanceCriteria: { text: string; checked: boolean }[];
  estimatedWallclock?: string;
  /** Free-prose sections (What to build, …) written verbatim, first. */
  bodySections?: { heading: string; markdown: string }[];
}

const AC_LINE = /^- \[([ xX])\]\s*(.*)$/;

/** `##` section names this codec owns — a free `bodySections` heading must not collide. */
const RESERVED_SECTIONS = ['files', 'blocked by', 'unblocks', 'acceptance criteria'];

/** Compose a fresh issue body. Managed sections follow the free prose sections. */
export function serializeBody(input: BodyInput): string {
  const parts: string[] = [];

  // Compose-side belt (FOR-63 / consumer KW-F1): emit the `**Parent:**` /
  // `**Estimated wallclock:**` metadata lines BEFORE every `##` section —
  // including the free bodySections — so no section's sectionBody() read can
  // ever absorb them, regardless of which optional sections (Unblocks, a free
  // bodySection) happen to be present. The prior layout emitted them AFTER the
  // last section, which meant they landed textually INSIDE whichever section
  // was last when there was no `## Unblocks` to shield `## Blocked by` — the
  // exact defect this fixes. `parseRefs` below independently filters stray
  // metadata lines out of any ref-list section, so a body already filed in
  // that legacy order still parses (belt AND suspenders, not belt-replaces-
  // suspenders).
  if (input.parent !== undefined) {
    // Render the opaque PRD id as `#<id>` so GitHub lights up the cross-reference
    // on the PRD (ADR-0013); read() strips the `#` back to the opaque id.
    parts.push(`**Parent:** ${parentToLine(input.parent)}`, '');
  }
  if (input.estimatedWallclock !== undefined) {
    parts.push(`**Estimated wallclock:** ${input.estimatedWallclock}`, '');
  }

  for (const s of input.bodySections ?? []) {
    // A bodySection heading equal to a managed section name would write a
    // duplicate `##` header that sectionBody() reads FIRST, silently shadowing
    // the real files/blockedBy/AC data on round-trip. Fail-fast at write.
    if (RESERVED_SECTIONS.includes(s.heading.trim().toLowerCase())) {
      throw new Error(
        `bodySections heading "${s.heading}" collides with a managed section ` +
          `(${RESERVED_SECTIONS.join(', ')}); rename it before create().`,
      );
    }
    parts.push(`## ${s.heading}`, '', s.markdown.trimEnd(), '');
  }
  parts.push('## Files', '');
  for (const f of input.files) parts.push(`- ${f}`);
  parts.push('');

  parts.push('## Blocked by', '');
  parts.push(input.blockedBy === 'none' ? 'none' : input.blockedBy.map(refToString).join(', '));
  parts.push('');

  if (input.unblocks && input.unblocks.length > 0) {
    parts.push('## Unblocks', '', input.unblocks.map(refToString).join(', '), '');
  }

  parts.push('## Acceptance criteria', '');
  for (const ac of input.acceptanceCriteria) parts.push(`- [ ] ${ac.text}`);

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Parse a stored body back into its fields. Throws on a missing required section. */
export function parseBody(body: string): ParsedBody {
  const files = parseList(sectionBody(body, 'Files'));
  if (files === null) throw new Error('GitHub body missing required `## Files` section');

  const blockedRaw = sectionBody(body, 'Blocked by');
  const blockedBy = parseBlockedBy(blockedRaw);

  const acBody = sectionBody(body, 'Acceptance criteria');
  if (acBody === null) {
    throw new Error('GitHub body missing required `## Acceptance criteria` section');
  }
  const acceptanceCriteria = parseAcs(acBody);

  const unblocksRaw = sectionBody(body, 'Unblocks');
  const unblocks =
    unblocksRaw && unblocksRaw.trim() ? parseRefs(unblocksRaw) : undefined;

  const parentRaw = readLine(body, 'Parent');
  const parent = parentRaw ? parentFromLine(parentRaw) : undefined;

  const estimatedWallclock = readLine(body, 'Estimated wallclock');
  const closedBy = readLine(body, 'Closed-by');

  return {
    files,
    blockedBy,
    ...(unblocks !== undefined ? { unblocks } : {}),
    ...(parent !== undefined ? { parent } : {}),
    acceptanceCriteria,
    ...(estimatedWallclock !== undefined ? { estimatedWallclock } : {}),
    ...(closedBy !== undefined ? { closedBy } : {}),
  };
}

/** Surgically upsert a `**Field:** value` line near the top of the body. */
export function upsertLine(body: string, name: string, value: string): string {
  const lines = body.split('\n');
  const re = new RegExp(`^\\*\\*${escapeRe(name)}:\\*\\*`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `**${name}:** ${value}`;
      return lines.join('\n');
    }
  }
  // insert at the very top (above the first prose/section) so it is easy to find.
  return `**${name}:** ${value}\n\n` + body;
}

/** Tick the AC checkboxes at the given 0-based indexes (best-effort, cosmetic). */
export function tickAcs(body: string, indexes: number[]): string {
  if (indexes.length === 0) return body;
  const want = new Set(indexes);
  const lines = body.split('\n');
  let inAc = false;
  let acIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Acceptance\s+criteria\s*$/i.test(lines[i])) {
      inAc = true;
      continue;
    }
    if (inAc && /^##\s+/.test(lines[i])) inAc = false;
    if (!inAc) continue;
    const raw = lines[i];
    const m = AC_LINE.exec(raw.trim()); // match parseAcs (trims) so indexes agree
    if (!m) continue;
    if (want.has(acIdx)) {
      const indent = raw.slice(0, raw.length - raw.trimStart().length);
      lines[i] = `${indent}- [x] ${m[2]}`; // preserve any leading indentation
    }
    acIdx++;
  }
  return lines.join('\n');
}

/**
 * Replace the body content under a `## <name>` heading with `bodyLines`,
 * preserving every other section/line. If the section is absent, append a fresh
 * one at the end (keeping AC last is NOT enforced — annotate orders its calls).
 * Used by the decorate write-path (ADR-0010) to surgically update Files / AC
 * without re-serializing the whole body (which would drop unmodeled prose).
 */
export function replaceSection(body: string, name: string, bodyLines: string[]): string {
  const lines = body.split('\n');
  let start = -1;
  const headRe = new RegExp(`^##\\s+${escapeRe(name)}\\s*$`, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (headRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  const block = ['', ...bodyLines, ''];
  if (start < 0) {
    const trimmed = body.replace(/\n+$/, '');
    return `${trimmed}\n\n## ${name}\n${block.join('\n')}`.replace(/\n{3,}/g, '\n\n');
  }
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  lines.splice(start + 1, end - (start + 1), ...block);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Upsert a FREE `## <heading>` section (the Amend facet's section writer,
 * ADR-0025): replace its content if the heading is already present (FIRST match,
 * case-insensitive — the same matching {@link parseBody}'s `sectionBody` reads
 * with), append a fresh section if it is absent. Sibling of {@link replaceSection},
 * differing only in the reserved-heading guard and the free-prose (string) input.
 *
 * Closes the shadow-duplicate hazard {@link appendBodySections} leaves: a
 * same-heading *append* produces two `## <heading>` sections, and `sectionBody`
 * reads the FIRST — silently shadowing the new content. Replacing the first
 * match instead means the read-back always sees what was just written.
 *
 * Throws on a {@link RESERVED_SECTIONS} heading (Files / Blocked by / Unblocks /
 * Acceptance criteria) — those are modeled Header-Block sections owned by
 * `annotate` (decorate, ADR-0010); amend must not be able to clobber them.
 */
export function upsertSection(body: string, heading: string, markdown: string): string {
  if (RESERVED_SECTIONS.includes(heading.trim().toLowerCase())) {
    throw new Error(
      `amend cannot write the managed section "${heading}" ` +
        `(${RESERVED_SECTIONS.join(', ')}) — those belong to \`annotate\` (decorate). ` +
        `Change Files / Acceptance criteria / Blocked by / Unblocks through annotate, not amend.`,
    );
  }
  return replaceSection(body, heading, markdown.trimEnd().split('\n'));
}

/** Append free-prose `## heading` sections verbatim at the end of the body. */
export function appendBodySections(
  body: string,
  sections: { heading: string; markdown: string }[],
): string {
  let out = body.replace(/\n+$/, '');
  for (const s of sections) {
    if (RESERVED_SECTIONS.includes(s.heading.trim().toLowerCase())) {
      throw new Error(
        `bodySections heading "${s.heading}" collides with a managed section ` +
          `(${RESERVED_SECTIONS.join(', ')}); rename it before annotate().`,
      );
    }
    out += `\n\n## ${s.heading}\n\n${s.markdown.trimEnd()}`;
  }
  return out + '\n';
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** The text under a `## <name>` heading up to the next `## ` (null if absent). */
function sectionBody(body: string, name: string): string | null {
  const re = new RegExp(`^##\\s+${escapeRe(name)}\\s*$`, 'im');
  const m = re.exec(body);
  if (!m) return null;
  const after = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(after);
  return next ? after.slice(0, next.index) : after;
}

/** Markdown list items (`- x`) → string[] (null if section absent). */
function parseList(section: string | null): string[] | null {
  if (section === null) return null;
  const out: string[] = [];
  for (const line of section.split('\n')) {
    const m = /^[-*]\s+(.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

function parseAcs(section: string): { text: string; checked: boolean }[] {
  const out: { text: string; checked: boolean }[] = [];
  for (const line of section.split('\n')) {
    const m = AC_LINE.exec(line.trim());
    if (m) out.push({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x' });
  }
  return out;
}

/**
 * Parse the `## Blocked by` section — **fail-loud** (FOR-31 / W4-F2).
 *
 * `none` and the empty section mean "no blockers". Any other content is a
 * declaration of dependencies and must parse *completely*: a token that is not a
 * legitimate issue ref throws, and a partially-parseable list throws too rather
 * than silently dropping the unrecognised entries. The pre-FOR-31 code mapped an
 * unrecognised token to `'none'`, so a hand-written `FOR-23` (the wire form is
 * `FOR#23`, see {@link refToString}) decoded to "no blockers" and passed the DoR
 * gate on a still-blocked row — reporting the *absence* of a dependency it had
 * merely failed to read. "I found nothing" and "there is nothing" are different
 * claims; only one of them is evidence. This mirrors the file-path parser
 * (`header-parser.ts`'s `parseIssueRefList`), which already fails loud.
 */
function parseBlockedBy(section: string | null): BlockedBy {
  if (section === null) return 'none';
  const trimmed = section.trim();
  if (trimmed === '' || /^none$/im.test(trimmed)) return 'none';
  const refs = parseRefs(trimmed, { strict: true, field: 'Blocked by' });
  return refs.length > 0 ? refs : 'none';
}

const REF_RE = /^(?:([a-z0-9][a-z0-9-]*)#)?#?(\d+)$/i;

/**
 * A codec-own bold-metadata line (`**Parent:**`, `**Estimated wallclock:**`, …).
 * `serializeBody` now emits these before the first `##` section (see the belt
 * comment there), but a body already filed in the legacy order (metadata after
 * the last section) still carries them inside whichever section happened to be
 * last — most commonly `## Blocked by` when there is no `## Unblocks` to shield
 * it (consumer KW-F1 / FOR-63). {@link parseRefs} filters lines matching this
 * shape out of a ref-list section BEFORE tokenizing, so dropping them never
 * weakens fail-loud: a genuinely malformed ref token still throws naming
 * itself, and a section containing ONLY metadata lines (no refs) reads as `none`.
 */
const BOLD_METADATA_LINE = /^\*\*[^*]+:\*\*/;

/**
 * Tokenise a comma/newline/bullet-delimited ref list into {@link IssueRef}s.
 *
 * By default (`unblocks`) an unrecognised token is skipped. In `strict` mode
 * (blocked-by) an unrecognised token throws, naming the offending token, the
 * section, and the canonical spelling — so a malformed dependency list can never
 * be mistaken for its absence.
 */
function parseRefs(
  text: string,
  opts: { strict?: boolean; field?: string } = {},
): IssueRef[] {
  const tokens = text
    .split('\n')
    .filter((line) => !BOLD_METADATA_LINE.test(line.trim()))
    .join('\n')
    .replace(/^[-*]\s+/gm, '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: IssueRef[] = [];
  for (const tok of tokens) {
    const m = REF_RE.exec(tok);
    if (!m) {
      if (opts.strict) {
        throw new Error(
          `\`## ${opts.field ?? 'Blocked by'}\` contains "${tok}", which is not a ` +
            `parseable issue ref. Expected the canonical \`<slug>#NN\` (e.g. \`FOR#23\`) ` +
            `or the slug-less \`#NN\` — NOT the human-readable \`FOR-23\`. Derive the ` +
            `canonical form with \`issue-store parse-ref <id>\`.`,
        );
      }
      continue;
    }
    out.push(m[1] ? { slug: m[1], issue: Number(m[2]) } : { issue: Number(m[2]) });
  }
  return out;
}

function readLine(body: string, name: string): string | undefined {
  // [ \t]* not \s* — \s spans newlines and would swallow the next line as the value.
  const re = new RegExp(`^\\*\\*${escapeRe(name)}:\\*\\*[ \\t]*(.*)$`, 'm');
  const m = re.exec(body);
  if (!m) return undefined;
  const value = m[1].trim();
  return value === '' ? undefined : value; // a value-less line reads as absent
}

function refToString(ref: IssueRef): string {
  return ref.slug ? `${ref.slug}#${ref.issue}` : `#${ref.issue}`;
}

/** Render a PRD id as the `**Parent:**` value — `#<id>` lights GitHub's cross-ref (ADR-0013). Idempotent. */
export function parentToLine(id: string): string {
  return id.startsWith('#') ? id : `#${id}`;
}

/** Read a `**Parent:**` value back to the opaque PRD id (strip the cross-ref `#`). Inverse of {@link parentToLine}. */
function parentFromLine(raw: string): string {
  return raw.startsWith('#') ? raw.slice(1) : raw;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
