/**
 * files-drift.ts — Reviewer-side drift detection for a wave-eligible issue.
 *
 * Encodes the policy clarified in wave-orchestration#39 (wo/39):
 *
 *   `Files:` is the **plan-time glob** used to compute the Conflict-Map and
 *   DOR-Gate an issue. It is NOT a hard commit-time contract.
 *
 *   - **Same-project drift** (acceptable / advisory): all touched files in the
 *     commit range stay inside the issue's declared project scope.
 *   - **Cross-project drift** (blocking): the commit touches files outside the
 *     declared project scope.
 *
 * ## Project-scope derivation
 *
 * The "declared project scope" is derived as the **deepest common prefix** of
 * all normalised paths in the `Files:` header, up to the first `/`-boundary
 * that identifies the project root. Formally:
 *
 *   1. Strip glob wildcards and take the directory prefix of each path.
 *   2. Compute the common directory prefix across all paths.
 *   3. Normalise to the deepest 2–3 segment prefix that still covers all
 *      declared files (e.g. `libs/example-ds/` from `libs/example-ds/vite.config.mts`
 *      and `libs/example-ds/eslint.config.mjs`).
 *
 * **Multi-project issues**: when declared `Files:` spans two or more top-level
 * project roots (e.g. `libs/foo/a.ts` + `libs/bar/b.ts`), every declared root
 * contributes its own allowed scope. Files inside ANY declared scope are
 * `same-project-drift`; files outside ALL declared scopes are `cross-project-drift`.
 *
 * **Edge cases**:
 *   - If `Files:` is empty → `projectScopes` is `[]`; every commit file is
 *     `cross-project-drift`.
 *   - If `Files:` contains a single concrete file path → scope is the directory
 *     of that file.
 *
 * ## Git integration
 *
 * `detectDrift()` accepts an optional `changedFiles` list (for testing). When
 * absent, it calls `git diff --name-only <sha-range>` via `execFileSync`. This
 * keeps the core logic pure and fully testable without spawning git.
 */

import { execFileSync } from 'node:child_process';
import { parseHeaderBlock } from './header-parser';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The three possible drift statuses. */
export type DriftStatus =
  | 'clean'
  | 'same-project-drift'
  | 'cross-project-drift';

/** Structured output from `detectDrift()`. */
export interface DriftResult {
  /** Overall drift classification. */
  status: DriftStatus;
  /**
   * Files from the commit range that are outside the declared `Files:` paths
   * but still inside the project scope (same-project drift), OR outside the
   * project scope entirely (cross-project drift).
   *
   * Empty when `status === 'clean'`.
   */
  driftedFiles: string[];
  /** Human-readable explanation of the classification. */
  rationale: string;
  /** Derived project scopes (directory prefixes). */
  projectScopes: string[];
}

export interface DetectDriftOptions {
  /** Absolute path to the issue markdown file. */
  issuePath: string;
  /** Raw source of the issue markdown file. */
  source: string;
  /**
   * Git commit-SHA range to inspect (e.g. `abc123..def456`, `HEAD~3..HEAD`).
   * Used to call `git diff --name-only <range>` when `changedFiles` is absent.
   *
   * Passed as a single argument to `git diff` — no shell interpolation.
   */
  shaRange: string;
  /**
   * Absolute path to the git repo root. Used as `cwd` for the git command.
   * Defaults to `process.cwd()`.
   */
  repoRoot?: string;
  /**
   * Pre-computed list of files changed in the range (repo-root-relative paths).
   * When provided, the git command is skipped — useful for tests.
   */
  changedFiles?: string[];
}

// ─── Project-scope derivation ─────────────────────────────────────────────────

/**
 * Strip glob characters from a path entry and return the leading directory
 * path (up to but not including the first glob segment).
 *
 * Examples:
 *   `libs/example-ds/vite.config.mts` → `libs/example-ds`
 *   `libs/example-ds/**\/src/*.ts`      → `libs/example-ds`
 *   `tools/wave/src/dor-gate.ts`     → `tools/wave/src`
 *   `some-root-file.ts`              → `` (empty → root scope)
 */
export function pathToScopeDir(entry: string): string {
  const parts = entry.split('/');
  const globIdx = parts.findIndex((p) => /[*?[\]{}]/.test(p));
  const concreteParts =
    globIdx === -1 ? parts.slice(0, -1) : parts.slice(0, globIdx);
  return concreteParts.join('/');
}

/**
 * Return true when `a` and `b` are in a containment relationship:
 * one is a directory prefix of the other (or they are equal).
 *
 * Examples (true):
 *   'libs/example-ds'      + 'libs/example-ds/src'  → true (a contains b)
 *   'libs/example-ds/src'  + 'libs/example-ds'      → true (b contains a)
 *   'libs/example-ds'      + 'libs/example-ds'      → true (equal)
 *
 * Examples (false):
 *   'libs/foo'  + 'libs/bar'   → false (siblings — independent projects)
 *   ''          + 'libs/foo'   → true  (root scope contains everything)
 */
function isContained(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === '') return true; // root contains everything
  if (b === '') return true; // root contains everything
  return b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Derive the set of project-scope directory prefixes from an issue's `Files:`
 * entries.
 *
 * **Algorithm — containment-based merging:**
 *   Two scope dirs are merged only when one is a directory prefix of the other
 *   (containment relationship). When `libs/example-ds/src` meets
 *   `libs/example-ds`, they merge to `libs/example-ds` (the shallower path).
 *   When `libs/foo` meets `libs/bar`, they stay independent (siblings).
 *
 * This is intentionally different from "deepest common prefix": the deepest
 * common prefix of `libs/foo` and `libs/bar` is `libs`, but that would
 * incorrectly label a change to `libs/baz` as same-project drift. The policy
 * (wo/39) requires project-level granularity, not workspace-level.
 *
 * For a **single-project** issue (all entries under the same root), returns
 * `[shallowCommonAncestor]` within that project.
 *
 * For a **multi-project** issue (entries from different roots), returns one
 * scope per distinct project root.
 *
 * An empty `Files:` list returns `[]` (every changed file is cross-project
 * drift relative to an undeclared scope).
 */
export function deriveProjectScopes(files: string[]): string[] {
  if (files.length === 0) return [];

  // Convert each Files: entry to its scope directory.
  const scopeDirs = files.map(pathToScopeDir);

  // Collect distinct scopes by folding. Two scope dirs merge only when one is
  // a proper ancestor/descendant of the other (containment). Siblings stay
  // independent.
  const distinctScopes: string[] = [];

  for (const candidate of scopeDirs) {
    let merged = false;
    for (let i = 0; i < distinctScopes.length; i++) {
      const existing = distinctScopes[i];
      if (isContained(candidate, existing)) {
        // Merge: keep the shallower (shorter) path as the scope.
        distinctScopes[i] =
          candidate.length <= existing.length ? candidate : existing;
        merged = true;
        break;
      }
    }
    if (!merged) {
      distinctScopes.push(candidate);
    }
  }

  return distinctScopes;
}

/**
 * Return `true` when `filePath` (repo-root-relative, forward-slashes) is
 * inside at least one of the provided scope directory prefixes.
 *
 * A scope of `''` (empty string) means the entire repo is in-scope.
 */
export function isInsideScope(filePath: string, scopes: string[]): boolean {
  if (scopes.length === 0) return false;
  return scopes.some((scope) => {
    if (scope === '') return true; // root scope covers everything
    return filePath === scope || filePath.startsWith(scope + '/');
  });
}

// ─── Git helper ───────────────────────────────────────────────────────────────

/**
 * Run `git diff --name-only <shaRange>` via execFileSync (no shell
 * interpolation) and return the list of changed files (repo-root-relative,
 * forward-slashes). Returns an empty list on error.
 */
export function getChangedFilesFromGit(
  shaRange: string,
  repoRoot: string,
): string[] {
  try {
    const output = execFileSync('git', ['diff', '--name-only', shaRange], {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Issue-tracker bookkeeping exemption ─────────────────────────────────────

/**
 * Pattern that matches the issue-tracker close-rename path family:
 *   `.scratch/<any-slug>/issues/<anything>` (incl. `done/` subdirectory)
 *
 * This matches any of:
 *   .scratch/wave-orchestration/issues/75-foo.md
 *   .scratch/wave-orchestration/issues/done/75-foo.md
 *   .scratch/some-feature/issues/done/01-bar.md
 *
 * Intentionally scoped to `.scratch/<slug>/issues/...` ONLY — it cannot mask
 * a real out-of-scope code change (e.g. `tools/wave/src/foo.ts`).
 */
const ISSUE_TRACKER_BOOKKEEPING_RE = /^\.scratch\/[^/]+\/issues\//;

/**
 * Return `true` when a changed file is wave issue-tracker bookkeeping — the
 * structural `.scratch/<slug>/issues/...` close-rename that every wave issue
 * close produces. These paths are never project code and must not count as
 * drift.
 */
export function isIssueTrackerBookkeeping(filePath: string): boolean {
  return ISSUE_TRACKER_BOOKKEEPING_RE.test(filePath);
}

// ─── Core detection ───────────────────────────────────────────────────────────

/**
 * Detect drift between a wave issue's `Files:` declaration and the actual
 * commit range.
 *
 * Returns a `DriftResult` with:
 *   - `status: 'clean'` — every changed file is inside the declared scope and
 *     matches a declared Files: entry (exact or glob).
 *   - `status: 'same-project-drift'` — some changed files are inside the
 *     project scope but were not declared in `Files:`. Acceptable per wo/39
 *     (advisory, not blocking).
 *   - `status: 'cross-project-drift'` — at least one changed file is outside
 *     the declared project scope. Blocking per wo/39 unless the cross-project
 *     change is a documented logical no-op.
 *
 * **Issue-tracker bookkeeping exemption:** changed files whose paths match
 * `.scratch/<slug>/issues/...` (incl. the `done/` rename target) are always
 * exempt from drift classification — they are wave bookkeeping, not project
 * code. The exemption is scoped tightly; it cannot mask a real out-of-scope
 * code change. See issue #75.
 */
export function detectDrift(opts: DetectDriftOptions): DriftResult {
  const parsed = parseHeaderBlock(opts.source);
  if (!parsed.ok) {
    return {
      status: 'cross-project-drift',
      driftedFiles: [],
      rationale: `Could not parse issue header: ${parsed.errors.map((e) => e.message).join('; ')}`,
      projectScopes: [],
    };
  }

  const declaredFiles = parsed.header.files;
  const projectScopes = deriveProjectScopes(declaredFiles);

  const repoRoot = opts.repoRoot ?? process.cwd();
  const rawChangedFiles =
    opts.changedFiles ?? getChangedFilesFromGit(opts.shaRange, repoRoot);

  // Strip issue-tracker bookkeeping paths (.scratch/*/issues/**) before drift
  // classification. These are structural wave close-rename paths — they are
  // never project code and must not count as drift. The exemption is scoped
  // tightly to this path family and cannot mask a real out-of-scope code change.
  const changedFiles = rawChangedFiles.filter(
    (f) => !isIssueTrackerBookkeeping(f),
  );

  if (changedFiles.length === 0) {
    return {
      status: 'clean',
      driftedFiles: [],
      rationale:
        projectScopes.length > 0
          ? `No files changed in range "${opts.shaRange}" — declared project scope(s): ${projectScopes.map((s) => `\`${s || '.'}\``).join(', ')}.`
          : `No files changed in range "${opts.shaRange}".`,
      projectScopes,
    };
  }

  // Partition changed files: cross-project (outside all scopes) vs
  // inside-scope (may or may not be declared).
  const crossProjectFiles: string[] = [];
  const inScopeFiles: string[] = [];

  for (const file of changedFiles) {
    if (projectScopes.length === 0 || !isInsideScope(file, projectScopes)) {
      crossProjectFiles.push(file);
    } else {
      inScopeFiles.push(file);
    }
  }

  if (crossProjectFiles.length > 0) {
    const scopeDesc =
      projectScopes.length > 0
        ? projectScopes.map((s) => `\`${s || '.'}\``).join(', ')
        : '(no declared scope)';
    return {
      status: 'cross-project-drift',
      driftedFiles: crossProjectFiles,
      rationale: [
        `${crossProjectFiles.length} file(s) changed outside the declared project scope (${scopeDesc}):`,
        ...crossProjectFiles.map((f) => `  • ${f}`),
        '',
        'Cross-project drift is (blocking) per wo/39 unless the cross-project change is a logical no-op',
        '(e.g. workspace-wide formatter run).',
      ].join('\n'),
      projectScopes,
    };
  }

  // All changed files are inside the project scope. Check whether any are
  // undeclared by matching against the declared Files: globs.
  let matchFn: (file: string, patterns: string[]) => boolean;
  try {
    // micromatch is available as a transitive dep (used by dor-gate.ts).
    const mm = require('micromatch') as typeof import('micromatch');
    matchFn = (file, patterns) => mm.isMatch(file, patterns, { dot: true });
  } catch {
    // Fallback: plain equality check.
    matchFn = (file, patterns) => patterns.includes(file);
  }

  const undeclaredFiles = inScopeFiles.filter(
    (f) => !matchFn(f, declaredFiles),
  );

  if (undeclaredFiles.length > 0) {
    const scopeDesc = projectScopes.map((s) => `\`${s || '.'}\``).join(', ');
    return {
      status: 'same-project-drift',
      driftedFiles: undeclaredFiles,
      rationale: [
        `${undeclaredFiles.length} file(s) changed inside the declared project scope (${scopeDesc}) but not listed in Files::`,
        ...undeclaredFiles.map((f) => `  • ${f}`),
        '',
        'Same-project drift is (advisory) per wo/39 — Workers may rename declared paths',
        'or add same-project follow-up files (e.g. lint-fix, config) to make the change pass.',
      ].join('\n'),
      projectScopes,
    };
  }

  // All changed files are declared.
  const scopeDesc =
    projectScopes.length > 0
      ? projectScopes.map((s) => `\`${s || '.'}\``).join(', ')
      : '(no declared scope)';
  return {
    status: 'clean',
    driftedFiles: [],
    rationale: `All ${changedFiles.length} changed file(s) are within the declared project scope (${scopeDesc}) and match declared Files: entries.`,
    projectScopes,
  };
}
