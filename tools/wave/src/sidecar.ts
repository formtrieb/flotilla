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
    // optional cross-check: payload.issue should reference the same opaque id
    if (report.issue && !report.issue.startsWith(named.id) && !named.id.startsWith(report.issue)) {
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
