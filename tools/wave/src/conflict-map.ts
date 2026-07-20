/**
 * Conflict-Map computer — deep module 3 of the wave-orchestration PRD §S2.
 *
 * Spec is canonical in `.scratch/wave-orchestration/PRD.md` §S2 + issue #07.
 *
 * Input:  Map<IssueID, FileGlob[]>          (the Files: header of each issue)
 * Output: Map<(IssueID, IssueID), File[]>    (intersection matrix; pairs only,
 *                                            non-empty cells only)
 *
 * Pure function modulo one side-effect: glob expansion via fast-glob (honors
 * the `repoRoot` option, so tests point at a fixtures dir). All set-arithmetic
 * is deterministic — same input + same repo state → same output.
 *
 * Used by `/wave create` (#07) at plan-time to surface same-file collisions
 * before the wave flips draft → ready. The Coordinator decides per-cell:
 * defer, drop, or sequence.
 *
 * `repoRoot` is optional (FOR-38): without it, glob-pattern `Files` entries
 * cannot be expanded against a real working tree, so they are compared only
 * by exact pattern text (byte-identical globs still collide — they overlap
 * by definition) and every such entry is named in the returned `warnings`.
 * This never silently shrinks the conflict set — the live finding this fixed
 * showed the same candidate roster producing 17 cells without `repoRoot` vs.
 * 40 with it, purely from dropped/unexpandable glob entries.
 */

import fastGlob from 'fast-glob';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseHeaderBlock } from './header-parser';

export interface IssueGlobs {
  /**
   * Stable issue identifier.
   * For paths under `.scratch/<slug>/issues/` the format is `<slug>#<NN>`
   * (e.g. `claude-automation-gaps#01`).
   * For non-standard paths it falls back to the bare NN prefix (or filename
   * stem) to preserve ad-hoc invocation behaviour.
   */
  issueId: string;
  /** Raw entries from the Files header — paths or globs, no annotations. */
  files: string[];
}

export interface ConflictCell {
  /** Issue IDs in lexicographic order so each pair appears once (a < b). */
  a: string;
  b: string;
  /** Intersecting concrete files, sorted for deterministic output. */
  files: string[];
}

export interface ConflictMap {
  /** All issue IDs that contributed to the computation, in input order. */
  issues: string[];
  /** Non-empty intersections only. Empty when every issue is fully disjoint. */
  cells: ConflictCell[];
  /**
   * Present (non-empty) only when at least one glob-pattern `Files` entry
   * could not be expanded because `repoRoot` was not supplied (FOR-38). Each
   * entry names the offending issue id and the exact pattern text — the
   * "unexpanded pattern" naming the acceptance criteria call for. Absent
   * (never an empty array) whenever every glob was expanded normally, so
   * existing callers that don't check for it see no shape change.
   *
   * This is the fail-loud/warn signal for the absence-as-fact class
   * (W2-F1c/W3-F1/W4-F2, and now cross-wave/conflict-map itself, per the
   * generalized clause in docs/retros/2026-07-16-hardening-w4.md §5): "I
   * could not evaluate this pattern" must never silently read as "this
   * pattern overlaps nothing".
   */
  warnings?: string[];
}

export interface ComputeOptions {
  /**
   * Absolute path to the repo root. Globs expand relative to this.
   *
   * Optional (FOR-38): when omitted, glob-pattern `Files` entries cannot be
   * expanded against a working tree at all. Rather than silently treating
   * that as "matches nothing" (which would under-report conflicts — the
   * dangerous direction), each such entry is compared only by **exact
   * pattern text** against other issues' unexpanded entries — two issues
   * declaring the byte-identical glob still produce a conflict cell, since
   * that overlaps by definition — and a `warnings` entry is added naming the
   * issue id + pattern that could not be expanded. Concrete (non-glob) paths
   * are unaffected — they were always compared as literal strings, no
   * filesystem needed. Passing a real `repoRoot` is unaffected and behaves
   * exactly as before this option became optional.
   */
  repoRoot?: string;
}

/**
 * Compute the intersection matrix across the Files lists of N issues.
 *
 * Concrete paths are taken as-is — the same policy DOR-Gate gate 2 uses
 * (a concrete path may be a net-new file the issue will create; we cannot
 * tell from outside). Glob entries are expanded via fast-glob against the
 * repo tree; only entries with at least one match contribute to the
 * intersection.
 *
 * Cells are emitted only when the intersection is non-empty. The pair order
 * is canonical (a < b lexicographically) so a 3-issue wave with one overlap
 * produces exactly one cell, never two.
 */
export function computeConflictMap(
  inputs: IssueGlobs[],
  opts: ComputeOptions,
): ConflictMap {
  const issues = inputs.map((i) => i.issueId);
  const warnings: string[] = [];
  const expanded = new Map<string, Set<string>>();
  for (const input of inputs) {
    expanded.set(
      input.issueId,
      expandFiles(input.files, opts.repoRoot, input.issueId, warnings),
    );
  }

  const cells: ConflictCell[] = [];
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const aId = inputs[i].issueId;
      const bId = inputs[j].issueId;
      // A duplicate issueId would yield a degenerate self-cell {a:id, b:id},
      // violating the ConflictCell `a < b` invariant. Skip it (an issue never
      // conflicts with itself). [flotilla engine fix vs the Ur seed — back-portable]
      if (aId === bId) continue;
      const [first, second] = aId < bId ? [aId, bId] : [bId, aId];
      const intersection = intersect(
        expanded.get(first) ?? new Set(),
        expanded.get(second) ?? new Set(),
      );
      if (intersection.length > 0) {
        cells.push({ a: first, b: second, files: intersection });
      }
    }
  }

  return { issues, cells, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Marks a set entry as an unexpanded glob pattern rather than a real file
 * path — so two issues declaring the byte-identical pattern text still
 * intersect (AC2: "overlap by definition") without being confusable with an
 * actual concrete path a real file happens to share. See {@link ComputeOptions.repoRoot}.
 */
function unexpandedMarker(pattern: string): string {
  return `(unexpanded glob) ${normalize(pattern)}`;
}

function expandFiles(
  entries: string[],
  repoRoot: string | undefined,
  issueId: string,
  warnings: string[],
): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    if (isLikelyGlob(entry)) {
      if (repoRoot === undefined) {
        // No repo root to expand against — fall loud rather than silently
        // treating this pattern as matching nothing (FOR-38). Record it as
        // an unexpanded-pattern marker (exact-text overlap only) plus a
        // named warning; never drop it outright.
        out.add(unexpandedMarker(entry));
        warnings.push(
          `${issueId}: file pattern "${entry}" could not be expanded — no repoRoot was ` +
            `supplied, so it was compared only by exact pattern text against other issues' ` +
            `unexpanded patterns; real file-level overlaps this pattern would match are NOT ` +
            `detected. Pass repoRoot (CLI: --repo-root) to enable full glob expansion.`,
        );
        continue;
      }
      const matches = fastGlob.sync(entry, {
        cwd: repoRoot,
        dot: true,
        onlyFiles: true,
      });
      for (const match of matches) out.add(normalize(match));
    } else {
      out.add(normalize(entry));
    }
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  const out: string[] = [];
  for (const item of smaller) {
    if (larger.has(item)) out.push(item);
  }
  return out.sort();
}

function isLikelyGlob(entry: string): boolean {
  return /[*?[\]{}]/.test(entry);
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/');
}

// ─── issue-file convenience loader ─────────────────────────────────────────

/**
 * Read N issue files, parse each Header-Block, and return the IssueGlobs
 * shape the conflict-map computer wants. Issue IDs are derived from the path:
 * for standard `.scratch/<slug>/issues/<NN>-<name>.md` paths the ID is
 * `<slug>#<NN>`; non-standard paths fall back to bare NN (or filename stem).
 * Issues whose header fails to parse are skipped — /wave validate is the
 * authoritative DOR-check for that.
 */
export function loadIssueGlobs(issuePaths: string[]): IssueGlobs[] {
  const out: IssueGlobs[] = [];
  for (const path of issuePaths) {
    const id = extractIssueId(path);
    const source = readFileSync(resolve(path), 'utf-8');
    const parsed = parseHeaderBlock(source);
    if (!parsed.ok) continue;
    out.push({ issueId: id, files: parsed.header.files });
  }
  return out;
}

/**
 * Derive a stable issue identifier from a file path.
 *
 * - Standard path `.scratch/<slug>/issues/<NN>-<name>.md`
 *   → `<slug>#<NN>` (e.g. `claude-automation-gaps#01`)
 * - Non-standard path (ad-hoc invocation, test fixtures outside .scratch, etc.)
 *   → bare NN prefix from the filename, or the full filename stem as last resort.
 *
 * Exported for unit-testing the extraction logic directly.
 */
export function extractIssueId(issuePath: string): string {
  // Normalise separators so the regex works on Windows paths too.
  const normalised = issuePath.replace(/\\/g, '/');
  // Match the canonical .scratch/<slug>/issues/<NN>... structure.
  const slugMatch = /\.scratch\/([^/]+)\/issues\/(\d+)/.exec(normalised);
  if (slugMatch) {
    return `${slugMatch[1]}#${slugMatch[2]}`;
  }
  // Fallback: bare NN from filename prefix, or full filename stem.
  const filename = normalised.split('/').pop() ?? normalised;
  const nnMatch = /^(\d+)/.exec(filename);
  return nnMatch ? nnMatch[1] : filename.replace(/\.md$/, '');
}
