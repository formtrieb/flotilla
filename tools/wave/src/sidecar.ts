/**
 * sidecar.ts — the on-disk report/verdict sidecar reader for resume (ADR-0002).
 *
 * Sidecars are the durable record of what a Worker/Reviewer produced before a
 * Coordinator kill — "disk beats a non-landed spine flip". They are written by the
 * paired `write-report` / `write-verdict` engine verbs (route-cli.ts, ADR-0024) at
 * agent-return — never hand-formatted; this file is the paired READER. Layout:
 *
 *   <reportsDir>/<id>-<iter>.md   — Worker report  (fenced ```json conforming to WORKER_REPORT_JSON_SCHEMA)
 *   <verdictsDir>/<id>-<iter>.md  — Reviewer verdict (fenced ```json conforming to REVIEWER_VERDICT_JSON_SCHEMA)
 *
 * `id` is the OPAQUE spine row id (ADR-0001 — never parsed/ordered); `iter` is the
 * trailing integer. The reader keeps the MAX-iter valid sidecar per id and tracks
 * `report.iter` and `verdict.iter` SEPARATELY (routing on resume needs both — a
 * fresh report with a stale verdict is `report-in awaiting review`, not `verdict-in`).
 * A sidecar that fails its schema validator is recorded as CORRUPT and treated as
 * absent (never silently routed, never backfilled).
 *
 * ## The bare-id contract (ADR-0001, and the reason it is enforced HERE)
 *
 * Opaque means the engine never *interprets* an id — never parses a number out of
 * it, never orders by it. It does not mean the id is free-form: the reader matches
 * a row by `reportFor(<the row id>)`, i.e. LITERALLY, so the id in a sidecar's
 * filename must be the row id **verbatim** or that sidecar is unreachable. A
 * DECORATED id — `#126`, `#126 — <the issue title>` — therefore produces a real
 * file, listed by `ls`, that no `reportFor` call can ever return. That is the
 * worst of the two failure directions this module now closes: present to the
 * operator, absent to the reader, silent in both directions.
 *
 * {@link bareIssueIdViolation} is the shape rule (filename-safe AND literally
 * matchable), {@link normalizeIssueRef} strips the decorations actually observed
 * in the wild so a decorated *payload* field can be repaired rather than refused,
 * and {@link findMisnamedSidecars} is the detector for litter already on disk —
 * the half a `[ -f <dir>/<id>-<iter>.md ]` existence probe structurally cannot
 * see, because a misnamed file fails that probe identically to a missing one.
 */

import { validateWorkerReport, type WorkerReport } from './worker-report-schema';
import {
  validateReviewerVerdict,
  type ReviewerVerdict,
} from './reviewer-verdict-schema';

/** Injected fs seam — mirrors the engine's defaultXxxProbe idiom. */
export interface SidecarReader {
  /** Filenames (not paths) in `dir`; `[]` if the dir is absent. */
  list(dir: string): string[];
  /** File contents (utf-8). */
  read(dir: string, file: string): string;
}

export interface ReportHit {
  iter: number;
  report: WorkerReport;
}
export interface VerdictHit {
  iter: number;
  verdict: ReviewerVerdict;
}
export interface CorruptSidecar {
  id: string;
  iter: number;
  kind: 'report' | 'verdict';
  reason: string;
}

/**
 * A sidecar that EXISTS on disk under a filename the reader can never resolve —
 * its filename id is not a bare id (see {@link bareIssueIdViolation}). Distinct
 * from {@link CorruptSidecar}: a corrupt sidecar is findable-but-unusable, a
 * misnamed one is not findable at all, so nothing about it surfaces unless
 * something goes looking for it by SHAPE rather than by id.
 */
export interface MisnamedSidecar {
  /** Filename as it sits in the directory, e.g. `#126-1.md`. */
  file: string;
  kind: 'report' | 'verdict';
  /** The id `parseSidecarName` read out of the filename, e.g. `#126`. */
  filenameId: string;
  iter: number;
  /** The bare row id the filename decorates — the id it SHOULD have been filed under. */
  resolvesAs: string;
  /** Why `filenameId` is not a bare id (a fragment, reads after `the id ...`). */
  reason: string;
}

export interface SidecarIndex {
  /** Max-iter VALID report for the opaque id, or null. */
  reportFor(id: string): ReportHit | null;
  /** Max-iter VALID verdict for the opaque id, or null. */
  verdictFor(id: string): VerdictHit | null;
  /** Corrupt sidecars seen for the id (failed schema validation / parse). */
  corruptFor(id: string): CorruptSidecar[];
}

/** `<opaque-id>-<iter>.md` → { id, iter } (id is everything before the last `-<digits>`). */
export function parseSidecarName(
  file: string,
): { id: string; iter: number } | null {
  const m = /^(.+)-(\d+)\.md$/.exec(file);
  if (!m) return null;
  return { id: m[1], iter: Number(m[2]) };
}

/**
 * Characters an id may not carry, for two independent and equally fatal reasons:
 *
 *  - **whitespace, `#`, `:`** — the reader matches a row id LITERALLY (opaque,
 *    ADR-0001), so any decoration produces a filename no `reportFor(<row id>)`
 *    can ever return. `#126` and `#126 — <title>` are the two forms observed live.
 *  - **`/ \ * ? " < > |`** — path separators and characters that are illegal in a
 *    filename on at least one supported platform. `<id>-<iter>.md` must be one
 *    portable filename component, not a path.
 *
 * Deliberately NOT rejected: `-` and `.` inside the id. A dashed tracker id
 * (`FOR-90`) is first-class — `parseSidecarName` splits on the LAST `-<digits>`,
 * so `FOR-90-1.md` round-trips correctly — and rejecting it would break the
 * Linear adapter outright.
 */
const UNSAFE_ID_CHAR = /[\s#/\\:*?"<>|]/;

/**
 * The bare-id shape rule. Returns `null` when `id` is a usable sidecar id, or a
 * human-legible fragment naming the violation (reads after `the id "<x>" ...`).
 *
 * This is NOT a parse of the id's meaning — ADR-0001's opacity is untouched, and
 * nothing here interprets or orders anything. It is the *filename-and-match-key*
 * contract the reader already depends on, stated once, where it can be enforced.
 */
export function bareIssueIdViolation(id: string): string | null {
  if (id.length === 0) return 'is empty';
  const bad = UNSAFE_ID_CHAR.exec(id);
  if (bad) {
    return (
      `contains ${JSON.stringify(bad[0])} — an id must be filename-safe AND ` +
      'literally matchable, so it carries no whitespace, no "#", and no path character'
    );
  }
  if (id.startsWith('.')) return 'starts with "." — not a usable filename stem';
  return null;
}

/** True iff `id` satisfies {@link bareIssueIdViolation}. */
export function isBareIssueId(id: string): boolean {
  return bareIssueIdViolation(id) === null;
}

/** Leading decoration: a `#` sigil (and any stray leading space already trimmed). */
const DECORATION_PREFIX = /^#+/;
/** Trailing punctuation left behind after the title is cut off (`#118:` → `118`). */
const DECORATION_SUFFIX = /[^0-9A-Za-z_-]+$/;

/**
 * Strip the decorations observed in the wild off an issue reference and return
 * the bare id it names: `#126` → `126`, `#118 — <the issue title>` → `118`,
 * `FOR-90 — <title>` → `FOR-90`, and an already-bare `138` → `138` unchanged.
 *
 * The rule is deliberately blunt — take the first whitespace-delimited token,
 * drop a `#` sigil, drop trailing punctuation — because it is a REPAIR of a
 * known-wrong input, never an identity function the engine routes on. Nothing
 * downstream trusts its output without comparing it to an id it was given
 * independently (route-cli's write verbs compare it to `--id`), so a wrong
 * normalization degrades to a loud refusal, never to a wrong write.
 */
export function normalizeIssueRef(raw: string): string {
  const head = raw.trim().split(/\s/)[0] ?? '';
  return head.replace(DECORATION_PREFIX, '').replace(DECORATION_SUFFIX, '');
}

/**
 * Every sidecar in `dir` whose FILENAME id is not a bare id — the files that are
 * present to an `ls` and absent to the reader.
 *
 * This is the detector an existence probe cannot be: `[ -f <dir>/<id>-<iter>.md ]`
 * answers false for a misnamed file exactly as it does for a missing one, so the
 * recovery it guards rewrites the correct file and leaves the misnamed one behind
 * as litter, undetected. Scanning by SHAPE needs no roster and no id to ask about.
 */
export function findMisnamedSidecars(
  dir: string,
  kind: 'report' | 'verdict',
  reader: SidecarReader,
): MisnamedSidecar[] {
  const out: MisnamedSidecar[] = [];
  for (const file of reader.list(dir)) {
    const named = parseSidecarName(file);
    if (!named) continue; // not a sidecar at all — out of scope, never guessed at
    const reason = bareIssueIdViolation(named.id);
    if (!reason) continue;
    out.push({
      file,
      kind,
      filenameId: named.id,
      iter: named.iter,
      resolvesAs: normalizeIssueRef(named.id),
      reason,
    });
  }
  return out;
}

/** Extract the first fenced ```json block's parsed value, or null. */
function extractJson(raw: string): unknown {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(raw);
  const body = m ? m[1] : raw;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Build a {@link SidecarIndex} from the reports + verdicts dirs via the injected
 * reader. Pure aside from the reader; no real fs unless the default reader is used.
 */
export function readSidecars(
  reportsDir: string,
  verdictsDir: string,
  reader: SidecarReader,
): SidecarIndex {
  const reports = new Map<string, ReportHit>();
  const verdicts = new Map<string, VerdictHit>();
  const corrupt: CorruptSidecar[] = [];

  for (const file of reader.list(reportsDir)) {
    const named = parseSidecarName(file);
    if (!named) continue;
    const value = extractJson(reader.read(reportsDir, file));
    const v = validateWorkerReport(value);
    if (!v.valid) {
      corrupt.push({ id: named.id, iter: named.iter, kind: 'report', reason: v.errors.join('; ') });
      continue;
    }
    const report = value as WorkerReport;
    // Optional cross-check: payload.issue should reference the same opaque id.
    // The reader is the TOLERANT half of the pair — the write verb normalizes a
    // decorated `issue` to the bare `--id` before rendering (route-cli.ts), so a
    // verb-written sidecar always satisfies this exactly; the prefix rule and the
    // normalization fallback exist for records the verb did not produce (a
    // hand-written or pre-normalization one), which must still be readable rather
    // than silently reclassified as corrupt on a resume.
    if (
      report.issue &&
      !report.issue.startsWith(named.id) &&
      !named.id.startsWith(report.issue) &&
      normalizeIssueRef(report.issue) !== named.id
    ) {
      corrupt.push({
        id: named.id,
        iter: named.iter,
        kind: 'report',
        reason: `filename id "${named.id}" disagrees with payload issue "${report.issue}"`,
      });
      continue;
    }
    const prev = reports.get(named.id);
    if (!prev || named.iter > prev.iter) reports.set(named.id, { iter: named.iter, report });
  }

  for (const file of reader.list(verdictsDir)) {
    const named = parseSidecarName(file);
    if (!named) continue;
    const value = extractJson(reader.read(verdictsDir, file));
    const v = validateReviewerVerdict(value);
    if (!v.valid) {
      corrupt.push({ id: named.id, iter: named.iter, kind: 'verdict', reason: v.errors.join('; ') });
      continue;
    }
    const verdict = value as ReviewerVerdict;
    const prev = verdicts.get(named.id);
    if (!prev || named.iter > prev.iter) verdicts.set(named.id, { iter: named.iter, verdict });
  }

  return {
    reportFor: (id) => reports.get(id) ?? null,
    verdictFor: (id) => verdicts.get(id) ?? null,
    corruptFor: (id) => corrupt.filter((c) => c.id === id),
  };
}
