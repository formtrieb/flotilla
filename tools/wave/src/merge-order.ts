/**
 * Merge-order computer — extracts `/wave start` Phase 5 step 3a (the
 * fewer-Files:-first algorithm from Wave 8 §L22) into a testable function and
 * extends it with stacked-branch detection (Wave 10 §L30).
 *
 * Spec is canonical in `.scratch/wave-orchestration/issues/44-...md`.
 *
 * Two orders come out of `computeMergeOrder`:
 *
 *   - `algorithmic` — the strict heuristic order: fewer files in the issue's
 *     `Files:` header merges first; tiebreak by lower NN (stable ascending).
 *     Correct for **disjoint** branches off feat HEAD (minimises rebase scope
 *     on the second lander).
 *
 *   - `override`   — `null` when every branch is disjoint. When a *stacked*
 *     subgraph exists (one wave-orch branch built off another's tip), the
 *     stacked nodes are emitted in **topological** order (parent before child,
 *     i.e. stacked-build order = rebase-free), followed by the disjoint nodes in
 *     the algorithmic order. This is the order the human-Coordinator had to
 *     reconstruct by hand in Wave 10 Row A (#26 → #28 → #29).
 *
 * Pure function modulo one side-effect: branch ancestry probing via git. That
 * side-effect is isolated behind the injectable `GitProbe` seam (same pattern
 * as `files-drift.ts`'s `changedFiles` injection) so the spec drives it with
 * fixtures WITHOUT any real `wave-orch/*` branches needing to exist.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseHeaderBlock } from './header-parser';
import { readSpine } from './wave-md-rw';
import type { ConflictMap, ConflictCell } from './conflict-map';

/**
 * A single PR / branch participating in the merge order.
 *
 * `issueId` is the same slug-qualified ID the Conflict-Map uses (`<slug>#<NN>`
 * for standard paths, bare NN otherwise) so the two structures join cleanly.
 */
export interface PR {
  /** Slug-qualified issue identifier — `<slug>#<NN>` or bare NN. */
  issueId: string;
  /** Numeric NN parsed from the issue (drives the stable tiebreak). */
  nn: number;
  /** Count of entries in the issue's `Files:` header (the sort key). */
  fileCount: number;
  /**
   * The wave-orch branch name for this issue, when known
   * (`wave-orch/<NN>-<slug>`). Used for stacked-branch detection. `null` when
   * the branch could not be resolved (no override is emitted for it).
   */
  branch: string | null;
  /** Optional short title, surfaced in CLI/Closed-by rendering. */
  title?: string;
  /**
   * The row's PR URL, when known (spine-self-contained path only — see
   * `buildSpinePrs`). `undefined` on the MarkdownFs/`loadPrs` path, which has
   * no PR-cell concept; `null` when the spine's PR cell is still the `—`
   * placeholder. Used alongside `branch` to decide whether a row was ever
   * dispatched (FOR-15 AC2) — a PR alone is proof of dispatch even before a
   * branch has been recorded.
   */
  prUrl?: string | null;
}

export interface MergeOrderResult {
  /** Strict heuristic order: fewer Files: first, NN ASC tiebreak. */
  algorithmic: PR[];
  /**
   * Stacked-build override: `null` when all branches are disjoint, otherwise
   * the topological (stacked-build) order for the stacked subgraph followed by
   * the disjoint nodes in algorithmic order.
   */
  override: PR[] | null;
  /** Human-readable rationale for the chosen order(s). */
  reason: string;
  /**
   * Rows excluded from `algorithmic`/`override` because they were never
   * dispatched (still `planned`, with no recorded branch and no PR) — listed
   * separately for visibility rather than silently dropped (FOR-15 AC2).
   * Populated only by the spine-self-contained path (`buildSpinePrs`), which
   * has Plan-Table row state to make that call; always `[]` on the
   * MarkdownFs/`loadPrs` path, which has no such state to consult.
   */
  notInPlay: PR[];
  /**
   * Advisory warnings collected while resolving branches. Currently the only
   * source is the `.scratch` NN-glob fallback (`resolveExactOrGlob`) firing on
   * the MarkdownFs/Ur path — a real risk (Wave 2026-06-03 §L3: a stale
   * same-NN branch can shadow the real one). Always `[]` on the
   * spine-self-contained path, which never consults the glob (FOR-15 AC3) —
   * its Plan-Table `id` already IS the join key and its `branch` is already
   * resolved by `readSpine` from the dispatch-log, so the glob has nothing to
   * add and no meaning (there is no `wave-orch/<NN>-*` convention to probe).
   */
  warnings: string[];
}

/**
 * Git-ancestry seam. The default implementation shells out to git; the spec
 * injects a fixture so tests are hermetic (no real branches required).
 */
export interface GitProbe {
  /**
   * Resolve the wave-orch branch name for an issue (e.g. NN=29 →
   * `wave-orch/29-...`). Returns `null` when no matching branch is found
   * locally or on origin. The default implementation may `git fetch` a missing
   * branch so the subsequent ancestry probe has the objects it needs.
   */
  resolveBranch(nn: number, issueId: string): string | null;
  /**
   * `git merge-base --is-ancestor <ancestor> <descendant>` — returns `true`
   * when `<ancestor>` is reachable from `<descendant>` (i.e. `<descendant>` is
   * stacked on `<ancestor>`).
   */
  isAncestor(ancestor: string, descendant: string): boolean;
}

export interface ComputeMergeOrderOptions {
  /** Absolute path to the repo root. Git commands run with this `cwd`. */
  repoRoot?: string;
  /** Injectable git seam. Defaults to {@link defaultGitProbe}. */
  git?: GitProbe;
  /**
   * Exact per-issue branch names sourced from the spine (dispatch-log /
   * Plan-Table), keyed by canonical `issueId`. When an entry exists for an
   * issue, it is used **verbatim** as that issue's branch — the `GitProbe`'s
   * NN-glob `resolveBranch` is consulted ONLY as a last-resort fallback for
   * issues the spine declares no branch for.
   *
   * This closes the Wave 2026-06-03 §L3 defect: the NN-glob mis-resolves (or
   * returns `null`) when a stale prior-wave branch shares the issue's NN on
   * origin (`wave-orch/09-composite-required-roles` shadowing this wave's
   * `wave-orch/09-a11y-affected-axe`), which silently dropped stacked detection
   * and ordered a child before its parent. Sourcing the exact name from the
   * spine makes resolution unambiguous regardless of same-NN stale branches.
   */
  branchesByIssueId?: Record<string, string>;
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Compute the recommended merge order across the issues of one wave.
 *
 * @param issuePaths Absolute (or cwd-relative) paths to the issue files in the
 *   wave. Each file's `Files:` header gives the fileCount sort key and the NN
 *   tiebreak; issues whose header fails to parse are skipped (the same policy
 *   `loadIssueGlobs` uses — `/wave validate` is the authoritative DOR-check).
 * @param conflictMap The pairwise Conflict-Map (consumed for the `reason`
 *   string and to know which pairs overlap; the algorithmic order itself is a
 *   pure file-count sort and does not depend on the cells).
 * @param opts Repo root + injectable git seam.
 */
export function computeMergeOrder(
  issuePaths: string[],
  conflictMap: ConflictMap,
  opts: ComputeMergeOrderOptions = {},
): MergeOrderResult {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const git = opts.git ?? defaultGitProbe(repoRoot);
  const branchesByIssueId = opts.branchesByIssueId ?? {};
  const warnings: string[] = [];
  const prs = loadPrs(issuePaths, git, branchesByIssueId, warnings);
  return orderPrs(prs, conflictMap, git, { warnings });
}

/**
 * Extra context threaded through {@link orderPrs} and echoed verbatim into its
 * result — collected by the caller (`computeMergeOrder`'s `loadPrs`, or
 * `computeMergeOrderFromSpine`'s `buildSpinePrs`) since `orderPrs` itself never
 * resolves branches or reads Plan-Table state.
 */
export interface OrderPrsExtra {
  /** See {@link MergeOrderResult.notInPlay}. Defaults to `[]`. */
  notInPlay?: PR[];
  /** See {@link MergeOrderResult.warnings}. Defaults to `[]`. */
  warnings?: string[];
}

/**
 * Order an already-built PR set (the machinery after `loadPrs`). Pure modulo the
 * injected {@link GitProbe}. Extracted so a caller that sources PRs from
 * somewhere other than issue files on disk — a GitHub spine with no `.scratch`
 * tree (ADR-0019) — reuses the identical sort + stack + override logic.
 */
export function orderPrs(
  prs: PR[],
  conflictMap: ConflictMap,
  git: GitProbe,
  extra: OrderPrsExtra = {},
): MergeOrderResult {
  const notInPlay = extra.notInPlay ?? [];
  const warnings = extra.warnings ?? [];
  if (prs.length === 0) {
    return {
      algorithmic: [],
      override: null,
      reason: 'Empty wave — no issues to order.',
      notInPlay,
      warnings,
    };
  }
  const algorithmic = sortAlgorithmic(prs);
  if (prs.length === 1) {
    return {
      algorithmic,
      override: null,
      reason: 'Single issue — no merge-order constraints.',
      notInPlay,
      warnings,
    };
  }
  const stack = detectStack(prs, git);
  if (stack.edges.length === 0) {
    return {
      algorithmic,
      override: null,
      reason: buildDisjointReason(conflictMap),
      notInPlay,
      warnings,
    };
  }
  const override = buildOverride(algorithmic, stack);
  return {
    algorithmic,
    override,
    reason: buildStackedReason(stack, algorithmic),
    notInPlay,
    warnings,
  };
}

// ─── Issue loading ─────────────────────────────────────────────────────────

function loadPrs(
  issuePaths: string[],
  git: GitProbe,
  branchesByIssueId: Record<string, string>,
  warnings: string[],
): PR[] {
  const out: PR[] = [];
  for (const path of issuePaths) {
    const issueId = extractIssueId(path);
    const nn = extractNn(path, issueId);
    const source = readIssueSource(path);
    if (source === null) continue;
    const parsed = parseHeaderBlock(source);
    if (!parsed.ok) continue;
    out.push({
      issueId,
      nn,
      fileCount: parsed.header.files.length,
      branch: resolveExactOrGlob(issueId, nn, branchesByIssueId, git, warnings),
      title: extractTitle(source),
    });
  }
  return out;
}

/**
 * Resolve an issue's branch, preferring the **exact** name the spine declared
 * (Wave 2026-06-03 §L3 fix) over the {@link GitProbe}'s NN-glob.
 *
 * - When `branchesByIssueId` carries a name for this `issueId`, return it
 *   verbatim — no git probe, so a stale prior-wave branch sharing the NN can
 *   never shadow it.
 * - Otherwise fall back to `git.resolveBranch(nn, issueId)` (the NN-prefix
 *   glob), the historical behaviour, for issues the spine left without a branch.
 *   A glob HIT (a non-null result) is exactly the risky case the §L3 defect
 *   came from — it may be the real branch, or it may be a stale prior-wave
 *   branch that merely shares the NN — so it is recorded as an advisory
 *   `warnings` entry (FOR-15 AC3). A glob MISS (`null`) carries no such risk
 *   (nothing downstream can be misled by "not found") and is not warned about.
 *   This path is the Ur/`.scratch` one; the spine-self-contained path
 *   (`buildSpinePrs`) never calls this function at all — see its docstring.
 */
function resolveExactOrGlob(
  issueId: string,
  nn: number,
  branchesByIssueId: Record<string, string>,
  git: GitProbe,
  warnings: string[],
): string | null {
  const exact = branchesByIssueId[issueId];
  if (exact) return exact;
  const resolved = git.resolveBranch(nn, issueId);
  if (resolved) {
    warnings.push(
      `${issueId}: branch resolved via the .scratch NN-glob fallback (wave-orch/${nn}-*) — ` +
        `no exact spine branch was declared, so this may be a stale same-NN branch shadowing ` +
        `the real one (Wave 2026-06-03 §L3); verify before trusting any stacked override involving it.`,
    );
  }
  return resolved;
}

/**
 * Build the PR set DIRECTLY from a spine's Plan-Table + Conflict-Map, with no
 * issue files on disk (ADR-0019 — the GitHub/Linear case). `fileCount` is the
 * spine-derivable proxy = the issue's CONFLICT FOOTPRINT (distinct files it
 * overlaps on across all Conflict-Map cells). A fully-disjoint issue has
 * footprint 0, so the fewer-files-first sort degrades gracefully to the NN
 * tiebreak. `conflictMap` MUST be the verbatim `readSpine(source).conflictMap`
 * (bare ids), NOT `parseWaveSpine`'s map (which drops bare ids via
 * tableIdToIssueId).
 *
 * Branch resolution (FOR-15, retro F2): unlike `loadPrs`'s `.scratch` case —
 * whose `issueId` is slug-qualified (`wave-orchestration#29`) and therefore
 * NOT the bare Plan-Table id, requiring an NN→path indirection to join — this
 * path's `issueId` IS the Plan-Table row's own `id` verbatim (`FOR-15`, a bare
 * GitHub number, legacy `wave-orch/NN`, …). That id is already what
 * `readSpine` keyed `row.branch` by when it resolved it from the dispatch-log
 * (ADR-0021, tracker-agnostic since FOR-5). So `row.branch` IS the exact
 * branch already — no `GitProbe.resolveBranch` NN-glob is needed, or wanted:
 * that glob assumes a `wave-orch/<NN>-*` naming convention with no meaning
 * here, and could only ever mis-resolve (Wave 2026-06-03 §L3) rather than
 * help. This is why this path never calls `resolveExactOrGlob` and therefore
 * never contributes a `.scratch`-glob `warnings` entry (FOR-15 AC3) — an
 * explicit `branchesByIssueId` override still wins when the caller supplies one.
 *
 * Rows that were NEVER DISPATCHED — still `planned`, with no branch and no PR
 * — are excluded from the returned in-play set and reported separately as
 * `notInPlay` (FOR-15 AC2): they are not real PRs yet, so ordering them
 * alongside dispatched rows would be meaningless advice. `state` is the
 * authority for "dispatched"; a `dispatched`+ row with no branch YET recorded
 * (e.g. a pre-ADR-0021 spine) still counts as in-play — branch/PR are only
 * corroborating signals for a `planned` row, not a substitute for the state.
 *
 * @param source Raw spine file CONTENT (not a path) — passed directly to `readSpine`.
 */
function buildSpinePrs(
  source: string,
  conflictMap: ConflictMap,
  branchesByIssueId: Record<string, string>,
): { prs: PR[]; notInPlay: PR[] } {
  const spine = readSpine(source);
  const footprint = new Map<string, Set<string>>();
  for (const cell of conflictMap.cells) {
    for (const id of [cell.a, cell.b]) {
      const set = footprint.get(id) ?? new Set<string>();
      for (const f of cell.files) set.add(f);
      footprint.set(id, set);
    }
  }
  const prs: PR[] = [];
  const notInPlay: PR[] = [];
  for (const row of spine.planTable) {
    const issueId = row.id.trim();
    if (!issueId) continue;
    const nnMatch = /(\d+)\s*$/.exec(issueId);
    const nn = nnMatch ? Number(nnMatch[1]) : Number.NaN;
    const branch = branchesByIssueId[issueId] ?? row.branch ?? null;
    const pr: PR = {
      issueId,
      nn,
      fileCount: footprint.get(issueId)?.size ?? 0,
      branch,
      prUrl: row.prUrl ?? null,
      title: row.title || undefined,
    };
    const neverDispatched = row.state === 'planned' && !branch && !pr.prUrl;
    if (neverDispatched) {
      notInPlay.push(pr);
    } else {
      prs.push(pr);
    }
  }
  return { prs, notInPlay };
}

/**
 * Read an issue file, falling back to the `issues/done/<file>` location when
 * the live path is gone. The close lifecycle `git mv`s an issue into `done/` in
 * the same commit that closes it, so a spine footnote pointing at the live
 * `issues/<NN>-...md` path goes stale once the wave closes (the Wave 10 §L25
 * stale-path class). The fallback keeps `merge-order` working both at
 * Phase-5-close time (live path) and on an already-archived spine (done path).
 * Returns `null` when neither location is readable.
 */
function readIssueSource(path: string): string | null {
  const abs = resolve(path);
  try {
    return readFileSync(abs, 'utf-8');
  } catch {
    // Insert `/done` before the filename: .../issues/29-x.md → .../issues/done/29-x.md
    const doneAbs = abs.replace(
      /([/\\])issues([/\\])(?!done[/\\])/,
      '$1issues$2done$2',
    );
    if (doneAbs !== abs) {
      try {
        return readFileSync(doneAbs, 'utf-8');
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Derive a stable issue identifier from a file path. Mirrors
 * `conflict-map.ts`'s `extractIssueId` exactly so the two structures key the
 * same way (`<slug>#<NN>` standard, bare NN / stem fallback).
 */
export function extractIssueId(issuePath: string): string {
  const normalised = issuePath.replace(/\\/g, '/');
  const slugMatch = /\.scratch\/([^/]+)\/issues\/(\d+)/.exec(normalised);
  if (slugMatch) {
    return `${slugMatch[1]}#${slugMatch[2]}`;
  }
  const filename = normalised.split('/').pop() ?? normalised;
  const nnMatch = /^(\d+)/.exec(filename);
  return nnMatch ? nnMatch[1] : filename.replace(/\.md$/, '');
}

/** Parse the numeric NN from the issue id (`slug#29` → 29) or path filename. */
function extractNn(issuePath: string, issueId: string): number {
  const fromId = /#(\d+)$/.exec(issueId);
  if (fromId) return Number(fromId[1]);
  const bare = /^(\d+)$/.exec(issueId);
  if (bare) return Number(bare[1]);
  const filename = issuePath.replace(/\\/g, '/').split('/').pop() ?? '';
  const fromFile = /^(\d+)/.exec(filename);
  return fromFile ? Number(fromFile[1]) : Number.NaN;
}

/** Pull the short title from the issue's H1 (`# 29 — foo` → `foo`). */
function extractTitle(source: string): string | undefined {
  const line = source.split(/\r?\n/).find((l) => /^#\s+/.test(l));
  if (!line) return undefined;
  const text = line.replace(/^#\s+/, '').trim();
  // Strip a leading `NN — ` / `NN -` prefix if present.
  const stripped = text.replace(/^\d+\s*[—-]\s*/, '').trim();
  return stripped.length > 0 ? stripped : text;
}

// ─── Algorithmic order ─────────────────────────────────────────────────────

/**
 * Fewer-Files:-first, NN-ASC tiebreak. Stable: `Array.prototype.sort` in V8 is
 * stable, and the comparator falls through to NN so equal file counts order by
 * ascending NN deterministically. (Wave 8 §L22 heuristic.)
 */
function sortAlgorithmic(prs: PR[]): PR[] {
  return [...prs].sort((a, b) => {
    if (a.fileCount !== b.fileCount) return a.fileCount - b.fileCount;
    return a.nn - b.nn;
  });
}

// ─── Stacked-branch detection ──────────────────────────────────────────────

interface StackEdge {
  /** Ancestor PR (lower in the stack — merges first). */
  parent: PR;
  /** Descendant PR (built off the ancestor's tip). */
  child: PR;
}

interface StackInfo {
  /** Direct parent→child edges discovered via `--is-ancestor`. */
  edges: StackEdge[];
  /** All issueIds that participate in any stacked subgraph. */
  stackedIds: Set<string>;
}

/**
 * Build the stack-DAG by probing every ordered pair `(A, B)` with
 * `git merge-base --is-ancestor branch(A) branch(B)`. A `true` result means A
 * is a proper ancestor of B → B is stacked on A.
 *
 * To keep the DAG minimal (and the topological order unambiguous) we reduce to
 * **direct** edges: an edge A→B is kept only when there is no intermediate C
 * with A→C and C→B. This collapses the transitive `wave-orch/29 → wave-orch/34`
 * relation into the chain `29 → 32 → 34`.
 */
function detectStack(prs: PR[], git: GitProbe): StackInfo {
  // Only PRs with a resolved branch can participate.
  const withBranch = prs.filter((p): p is PR & { branch: string } =>
    Boolean(p.branch),
  );

  // ancestors[child.issueId] = Set of ancestor issueIds
  const ancestors = new Map<string, Set<string>>();
  for (const child of withBranch) {
    const set = new Set<string>();
    for (const ancestor of withBranch) {
      if (ancestor.issueId === child.issueId) continue;
      if (git.isAncestor(ancestor.branch, child.branch)) {
        set.add(ancestor.issueId);
      }
    }
    ancestors.set(child.issueId, set);
  }

  const byId = new Map(withBranch.map((p) => [p.issueId, p]));
  const edges: StackEdge[] = [];
  const stackedIds = new Set<string>();

  for (const child of withBranch) {
    const childAncestors = ancestors.get(child.issueId) ?? new Set();
    for (const parentId of childAncestors) {
      // Keep only DIRECT edges: skip parentId if some other ancestor C of the
      // child is itself a descendant of parentId (i.e. parentId is an ancestor
      // of C and C is an ancestor of child → parentId→child is transitive).
      const isTransitive = [...childAncestors].some(
        (cId) =>
          cId !== parentId && (ancestors.get(cId)?.has(parentId) ?? false),
      );
      if (isTransitive) continue;

      const parent = byId.get(parentId);
      if (!parent) continue;
      edges.push({ parent, child });
      stackedIds.add(parent.issueId);
      stackedIds.add(child.issueId);
    }
  }

  return { edges, stackedIds };
}

// ─── Override construction ─────────────────────────────────────────────────

/**
 * Build the override order: the stacked subgraph in topological (stacked-build)
 * order — parent before child — followed by the disjoint nodes in their
 * algorithmic order.
 *
 * Disjoint nodes "interleaved by fewer-files-first" (per the AC) means: keep
 * their relative algorithmic order. We emit the whole stacked block first
 * (it is the operational priority — it must land in build order regardless of
 * file count), then append the non-stacked nodes in algorithmic order. This
 * reproduces Wave 10's final order: #26 → #28 → #29 (stack), then #25/#24/#27/
 * #30 (disjoint, fewer-files-first).
 */
function buildOverride(algorithmic: PR[], stack: StackInfo): PR[] {
  const stacked = algorithmic.filter((p) => stack.stackedIds.has(p.issueId));
  const disjoint = algorithmic.filter((p) => !stack.stackedIds.has(p.issueId));
  const ordered = topoSort(stacked, stack.edges);
  return [...ordered, ...disjoint];
}

/**
 * Kahn topological sort over the stacked subgraph. Ties between roots (no
 * incoming edge) are broken by ascending NN so the order is deterministic even
 * for forked stacks. For a linear stack this yields the build order directly.
 */
function topoSort(nodes: PR[], edges: StackEdge[]): PR[] {
  const indegree = new Map<string, number>();
  const adj = new Map<string, PR[]>();
  for (const n of nodes) {
    indegree.set(n.issueId, 0);
    adj.set(n.issueId, []);
  }
  for (const { parent, child } of edges) {
    const parentAdj = adj.get(parent.issueId);
    if (parentAdj === undefined || !indegree.has(child.issueId)) continue;
    parentAdj.push(child);
    indegree.set(child.issueId, (indegree.get(child.issueId) ?? 0) + 1);
  }

  // Ready set: nodes with indegree 0, kept NN-sorted for determinism.
  const ready = nodes
    .filter((n) => (indegree.get(n.issueId) ?? 0) === 0)
    .sort((a, b) => a.nn - b.nn);
  const out: PR[] = [];

  let node = ready.shift();
  while (node !== undefined) {
    out.push(node);
    for (const next of adj.get(node.issueId) ?? []) {
      const d = (indegree.get(next.issueId) ?? 0) - 1;
      indegree.set(next.issueId, d);
      if (d === 0) {
        ready.push(next);
        ready.sort((a, b) => a.nn - b.nn);
      }
    }
    node = ready.shift();
  }

  // Cycle guard (shouldn't happen for a real git ancestry DAG): append any
  // remaining nodes in NN order so we never silently drop a PR.
  if (out.length < nodes.length) {
    const seen = new Set(out.map((n) => n.issueId));
    for (const n of [...nodes].sort((a, b) => a.nn - b.nn)) {
      if (!seen.has(n.issueId)) out.push(n);
    }
  }

  return out;
}

// ─── Reason strings ────────────────────────────────────────────────────────

function buildDisjointReason(conflictMap: ConflictMap): string {
  if (conflictMap.cells.length === 0) {
    return 'All branches disjoint — algorithmic order (fewer Files: first, NN ASC tiebreak); no stacked branches detected.';
  }
  const pairs = conflictMap.cells
    .map((c) => `${c.a} ↔ ${c.b} on ${c.files.join(', ')}`)
    .join('; ');
  return `Fewer-Files:-first order (NN ASC tiebreak); no stacked branches detected. Conflict-Map overlaps: ${pairs}.`;
}

function buildStackedReason(stack: StackInfo, algorithmic: PR[]): string {
  const chains = describeChains(stack);
  const algoIds = algorithmic.map((p) => p.issueId).join(' → ');
  return (
    `Stacked branches detected (${chains}); override emits the stacked subgraph in ` +
    `topological build-order (parent before child, rebase-free), then disjoint nodes ` +
    `fewer-Files:-first. Algorithmic (disjoint-assumption) order would be: ${algoIds}.`
  );
}

/** Render the stack edges as readable chains, e.g. `wave-orch/29 → wave-orch/32 → wave-orch/34`. */
function describeChains(stack: StackInfo): string {
  return stack.edges
    .map(
      (e) =>
        `${e.parent.branch ?? e.parent.issueId} → ${e.child.branch ?? e.child.issueId}`,
    )
    .join(', ');
}

// ─── Default git probe (real side-effects, isolated here) ──────────────────

/**
 * Default {@link GitProbe} backed by real git. All shelling-out lives here so
 * the rest of the module is pure and the spec can swap a fixture probe.
 *
 * - `resolveBranch` looks for `wave-orch/<NN>-*` locally; if absent it consults
 *   `git ls-remote --heads origin` and `git fetch`es the branch so the
 *   subsequent ancestry probe has the objects. Returns `null` if nothing
 *   matches.
 * - `isAncestor` runs `git merge-base --is-ancestor` (exit 0 ⇒ true, exit 1 ⇒
 *   false; any other failure ⇒ false, treated as "not stacked").
 */
export function defaultGitProbe(repoRoot: string): GitProbe {
  const run = (args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, out };
    } catch (err) {
      const out =
        typeof (err as { stdout?: unknown }).stdout === 'string'
          ? (err as { stdout: string }).stdout
          : '';
      return { ok: false, out };
    }
  };

  const branchPrefix = (nn: number): string => `wave-orch/${nn}-`;

  return {
    resolveBranch(nn: number): string | null {
      const prefix = branchPrefix(nn);

      // 1. Local branches.
      const local = run([
        'branch',
        '--list',
        '--format=%(refname:short)',
        `${prefix}*`,
      ]);
      const localMatch = firstNonEmptyLine(local.out);
      if (localMatch) return localMatch;

      // 2. Remote heads via ls-remote.
      const remote = run(['ls-remote', '--heads', 'origin', `${prefix}*`]);
      const remoteRef = parseLsRemoteHead(remote.out);
      if (remoteRef) {
        // Fetch so --is-ancestor has the objects; ignore failure (probe stays
        // best-effort — a missing fetch just means no override is emitted).
        run(['fetch', 'origin', remoteRef]);
        return `origin/${remoteRef}`;
      }

      return null;
    },

    isAncestor(ancestor: string, descendant: string): boolean {
      // merge-base --is-ancestor exits 0 (true) or 1 (false). Our `run` maps
      // exit 0 → ok:true; any non-zero (incl. 1, and "not a valid object") →
      // ok:false. That is exactly the semantics we want: only a clean exit 0
      // counts as "stacked".
      const res = run(['merge-base', '--is-ancestor', ancestor, descendant]);
      return res.ok;
    },
  };
}

function firstNonEmptyLine(out: string): string | null {
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

/** Parse the branch short-name from the first `ls-remote --heads` line. */
function parseLsRemoteHead(out: string): string | null {
  for (const line of out.split('\n')) {
    const m = /\srefs\/heads\/(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// ─── Repo-root finder (used by parseWaveSpine for repo-root-relative paths) ──

/**
 * Walk up from `start` until a directory containing `package.json` is found.
 * Returns that directory (the repo root). Falls back to `start` itself when
 * nothing is found within 20 levels (so the caller can still attempt a
 * `resolve(fallback, rel)` that will simply not exist — graceful degradation).
 *
 * This is needed because cross-slug spine footnotes use **repo-root-relative**
 * paths (e.g. `.scratch/wave-orchestration/issues/29-...md`) while legacy
 * footnotes use **spine-relative** paths (e.g. `../../wave-orchestration/...`).
 */
function findRepoRootFrom(start: string): string {
  let dir = resolve(start);
  // If `start` is a file, begin from its directory.
  if (!existsSync(dir) || dir.endsWith('.md')) {
    dir = dirname(dir);
  }
  for (let i = 0; i < 20; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

// ─── Plan-Table fallback: locate issue files by NN ─────────────────────────

/**
 * Locate an issue file for a given numeric NN under any slug in the repo.
 *
 * Searches `<repoRoot>/.scratch/<slug>/issues/<NN>-*.md` for all `slug`
 * directories, then the `done/` variant — mirroring the {@link readIssueSource}
 * live→done fallback so this works both for open issues and already-closed ones.
 * Returns the first match (the NN is unique within a wave), or `null` when
 * nothing is found. Read errors at the `readdirSync` level are swallowed so a
 * permissions/ENOENT on one slug directory does not abort the whole scan.
 *
 * Used by the Plan-Table fallback in {@link parseWaveSpine}: when a spine has no
 * `[^source-*]` / `[^<slug>-<NN>]` footnotes and no `**Source issues**` bullets,
 * we derive issue identity from the Plan-Table rows and locate each issue file by
 * its NN — keeping the CLI useful for footnote-less spines (wave-driver-followups
 * §L4, #84).
 */
function findIssuePathByNN(nn: number, repoRoot: string): string | null {
  const scratchDir = resolve(repoRoot, '.scratch');
  let slugs: string[];
  try {
    slugs = readdirSync(scratchDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }

  const nnPrefix = `${nn}-`;
  const nnPrefixPadded = `${String(nn).padStart(2, '0')}-`;

  for (const slug of slugs) {
    for (const sub of ['issues', 'issues/done'] as const) {
      const dir = resolve(scratchDir, slug, sub);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      const match = entries.find(
        (f) =>
          (f.startsWith(nnPrefix) || f.startsWith(nnPrefixPadded)) &&
          f.endsWith('.md'),
      );
      if (match) return resolve(dir, match);
    }
  }
  return null;
}

// ─── WAVE.md spine parsing (for the CLI subcommand) ────────────────────────

export interface ParsedSpine {
  /**
   * Absolute issue file paths, derived from the spine's issue-file footnotes.
   * Both the legacy `[^source-*]` form (linked path) and the cross-slug
   * `[^<slug>-<NN>]` form (bare backtick path) are supported — the parser is
   * value-keyed on the resolved issue-file target.
   */
  issuePaths: string[];
  /** Conflict-Map reconstructed from the spine's `## Conflict-Map` list. */
  conflictMap: ConflictMap;
  /**
   * Exact per-issue branch names lifted from the spine (dispatch-log →
   * Plan-Table), keyed by canonical `issueId` (`<slug>#<NN>`). Feeds
   * `computeMergeOrder`'s `branchesByIssueId` so branch resolution never has to
   * fall back to the same-NN-ambiguous glob (Wave 2026-06-03 §L3). Empty when
   * the spine declares no branches yet (e.g. a `planned` spine pre-dispatch).
   */
  branchesByIssueId: Record<string, string>;
}

/**
 * Parse a WAVE.md spine into the three inputs `computeMergeOrder` needs.
 *
 * Two structures are read inline (the spine schema is stable enough for a
 * regex reader, the same stance `/wave start` takes); the third — the exact
 * per-issue branch names — is delegated to #54's shared {@link readSpine}
 * structured reader so this module no longer carries its own dispatch-log
 * dialect.
 *
 *   1. **Issue paths** from the spine's issue-file footnotes. Two formats are
 *      recognised (value-keyed — authority is the issue-file path, not the label
 *      prefix):
 *
 *      - Legacy: `[^source-<key>]: Source: [...](<rel-path>)` (linked path)
 *      - Cross-slug: `[^<slug>-<NN>]: \`<rel-path>\`` (bare backtick path)
 *
 *      The link/backtick target resolves relative to the spine's directory. Any
 *      footnote whose resolved target contains `.scratch/` is accepted, so future
 *      label conventions remain forward-compatible. The footnote label (e.g.
 *      `wo-29`) is still used as the join key so the Conflict-Map list's
 *      slug-prefixed IDs (`wo/29`) re-key to the canonical issueId
 *      (`wave-orchestration#29`) correctly.
 *
 *   2. **Conflict-Map cells** from the `## Conflict-Map` "Conflict list"
 *      numbered items: `N. **A ↔ B** at \`file\` [and \`file\`...]`. Each item
 *      becomes one `ConflictCell` keyed by canonical issueIds.
 *
 *   3. **Exact branch names** via {@link readSpine}: its `dispatchLog`
 *      (`08 → … branch wave-orch/08-…`) and `planTable` rows carry the exact
 *      `wave-orch/<NN>-…` name per issue NN. Each is re-keyed from its NN to the
 *      canonical issueId (via the same footnote→path bridge) so it joins the
 *      `computeMergeOrder` PR set. This is the Wave 2026-06-03 §L3 fix: the
 *      exact name, not an NN glob, drives stacked detection — so a stale prior-
 *      wave branch sharing the NN can no longer shadow resolution.
 *
 * @param source   Raw spine markdown.
 * @param spineDir Absolute directory of the spine file (link targets resolve
 *                 against it). Defaults to cwd.
 */
export function parseWaveSpine(
  source: string,
  spineDir: string = process.cwd(),
): ParsedSpine {
  const lines = source.split(/\r?\n/);

  // Repo root — needed to resolve cross-slug footnote paths that are
  // repo-root-relative (`.scratch/...`) rather than spine-relative (`../../...`).
  const repoRoot = findRepoRootFrom(spineDir);

  // 1. Footnotes → { footnoteKey → absolute issue path }.
  //
  //    Two formats are recognised (value-keyed: authority is the issue-file path,
  //    not the label prefix):
  //
  //    Legacy single-slug form (backward-compatible):
  //      [^source-wo-29]: Source: [`...`](../wave-orchestration/issues/29-...md)
  //      → relative path uses `../` → resolved against spineDir.
  //
  //    Cross-slug form (slug-prefixed label, bare backtick path):
  //      [^wo-29]: `.scratch/wave-orchestration/issues/29-...md`
  //      → repo-root-relative path (starts with `.scratch/`) → resolved against
  //        repoRoot, NOT spineDir (the spine can live anywhere under the repo).
  //
  //    Any footnote whose path contains `.scratch/` is accepted regardless of the
  //    label prefix, so future label conventions remain forward-compatible. The
  //    label (`footKey`) is still used as the join key for the Conflict-Map step.
  const FOOTNOTE_LEGACY = /^\[\^([^\]]+)\]:.*\]\(([^)]+)\)/;
  const FOOTNOTE_BACKTICK = /^\[\^([^\]]+)\]:\s*`([^`]+)`/;
  const ISSUE_PATH_RE = /\.scratch\//;

  // `**Source issues**` bullet form (footnote-less `/wave create` spines, #80):
  //
  //   - 73 → `.scratch/wave-orchestration/issues/73-....md`          (backtick)
  //   - 73 → [73-name](.scratch/wave-orchestration/issues/73-....md) (linked)
  //
  // A bullet carries no `[^key]:` prefix, so neither footnote regex fires and
  // the spine yields zero issues (the live failure #80 fixes). This additive
  // branch reads the bullet, value-keyed on the bare NN, and resolves the path
  // exactly as the footnote matcher does. It fires ONLY on lines the footnote
  // regexes skipped — footnotes start with `[^`, bullets with `-`/`*` — so
  // footnote spines are byte-identical. The `.scratch/` gate (below) still
  // rejects any non-issue bullet (`- None …`, `- #77 …`), and a truly empty
  // spine (no footnotes AND no bullets) still yields 0 issues (the done/72
  // contract). The linked form is tried first so a `[..](path)` is read as a
  // link target, never as a backtick path.
  const BULLET_LINKED = /^[-*]\s+(\d+)\s*(?:→|->)\s*\[[^\]]*\]\(([^)]+)\)/;
  const BULLET_BACKTICK = /^[-*]\s+(\d+)\s*(?:→|->)\s*`([^`]+)`/;

  const keyToPath = new Map<string, string>();
  const issuePaths: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    let footKey: string | null = null;
    let rel: string | null = null;

    // Try legacy link form first.
    const mLegacy = FOOTNOTE_LEGACY.exec(trimmed);
    if (mLegacy) {
      footKey = mLegacy[1].trim();
      rel = mLegacy[2].trim();
    } else {
      // Try cross-slug backtick form.
      const mBacktick = FOOTNOTE_BACKTICK.exec(trimmed);
      if (mBacktick) {
        footKey = mBacktick[1].trim();
        rel = mBacktick[2].trim();
      } else {
        // Try the `**Source issues**` bullet form (#80) — value-keyed on NN.
        const mBullet =
          BULLET_LINKED.exec(trimmed) ?? BULLET_BACKTICK.exec(trimmed);
        if (mBullet) {
          footKey = mBullet[1].trim(); // bare NN
          rel = mBullet[2].trim();
        }
      }
    }

    if (!footKey || !rel) continue;
    // Value-keyed gate: only accept footnotes whose line or resolved path
    // references a `.scratch/...` issue file. For the legacy linked form the
    // `rel` is a spine-relative path like `../test-feature/issues/...md` that
    // does not literally contain `.scratch/` — but the full line does (the
    // backtick-quoted display text carries the repo-root-relative path). So we
    // test the raw trimmed line, not just `rel`.
    if (!ISSUE_PATH_RE.test(trimmed)) continue;

    // Resolve the path: repo-root-relative paths start with `.scratch/`
    // (no leading `../`); spine-relative paths use `../` to navigate up.
    const isRepoRootRelative = rel.startsWith('.scratch/');
    const abs = isRepoRootRelative
      ? resolve(repoRoot, rel)
      : resolve(spineDir, rel);
    keyToPath.set(footKey, abs);
    issuePaths.push(abs);
  }

  // 1b. Plan-Table fallback (#84) — when no footnotes AND no `**Source issues**`
  //     bullets were found (e.g. wave-driver-followups §L4: a `/wave start`-
  //     dispatched spine has a Plan-Table but no explicit issue-path list), fall
  //     back to the Plan-Table rows.  For each row we:
  //       (a) parse the numeric NN from the ID cell (e.g. "81", "wo/81" → 81),
  //       (b) locate the actual issue file via {@link findIssuePathByNN},
  //       (c) key it by the bare NN string (matching `extractSpineBranches`'s
  //           `nnToIssueId` lookup so the branch map is populated correctly).
  //
  //     The existing footnote-driven path is untouched — the fallback fires
  //     ONLY when `issuePaths.length === 0` so a footnote-bearing spine is
  //     byte-identical in behaviour.
  if (issuePaths.length === 0) {
    const spine = readSpine(source);
    for (const row of spine.planTable) {
      const nnMatch = /(\d+)\s*$/.exec(row.id);
      if (!nnMatch) continue;
      const nn = Number(nnMatch[1]);
      if (!Number.isFinite(nn)) continue;
      const abs = findIssuePathByNN(nn, repoRoot);
      if (!abs) continue;
      // Key the path by bare NN so the Conflict-Map and branch-extraction steps
      // can join correctly (bare NN is the join key for Plan-Table-only spines).
      keyToPath.set(String(nn), abs);
      issuePaths.push(abs);
    }
  }

  // 2. Conflict-list items → cells.
  //    1. **wo/29 ↔ wo/32** at `file` and `file`
  const CONFLICT_ITEM = /^\d+\.\s+\*\*(.+?)\s*↔\s*(.+?)\*\*\s+at\s+(.+)$/;
  const cells: ConflictCell[] = [];
  for (const line of lines) {
    const m = CONFLICT_ITEM.exec(line.trim());
    if (!m) continue;
    const aId = tableIdToIssueId(m[1].trim(), keyToPath);
    const bId = tableIdToIssueId(m[2].trim(), keyToPath);
    const files = [...m[3].matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
    if (!aId || !bId || files.length === 0) continue;
    const [a, b] = aId < bId ? [aId, bId] : [bId, aId];
    cells.push({ a, b, files: files.sort() });
  }

  // 3. Exact branch names via the shared structured reader (#54). The reader
  //    keys branches by NN (dispatch-log entry head / Plan-Table ID cell); we
  //    re-key each to the canonical issueId so it joins the PR set in
  //    computeMergeOrder. Read-only use of the Spine view — never touch `lines`.
  const branchesByIssueId = extractSpineBranches(source, issuePaths);

  const issues = issuePaths.map((p) => extractIssueId(p));
  return { issuePaths, conflictMap: { issues, cells }, branchesByIssueId };
}

/**
 * Build the `issueId → exact branch` map from the spine via #54's
 * {@link readSpine}. The reader exposes two branch sources keyed by issue NN —
 * the `dispatchLog` (`08 → … branch wave-orch/08-…`, the canonical source) and
 * the `planTable` rows (`branch` resolved from the same dispatch-log). Both are
 * re-keyed from NN to the canonical issueId (`<slug>#<NN>`) using the footnote
 * paths, so the result joins `computeMergeOrder`'s PR set directly.
 *
 * Dispatch-log wins over Plan-Table when both carry a branch for the same NN
 * (they are the same value in practice — the Plan-Table `branch` is itself
 * resolved from the dispatch-log — but the explicit precedence keeps the
 * source-of-truth unambiguous). Read-only: we consult the structured `Spine`
 * view and never mutate its public `lines` array (#54 review advisory).
 */
function extractSpineBranches(
  source: string,
  issuePaths: string[],
): Record<string, string> {
  // NN → canonical issueId, from the footnote paths.
  const nnToIssueId = new Map<string, string>();
  for (const path of issuePaths) {
    const issueId = extractIssueId(path);
    const nnMatch = /#(\d+)$/.exec(issueId);
    const nn = nnMatch
      ? String(Number(nnMatch[1]))
      : (() => {
          const fromFile = /(\d+)/.exec(
            path.replace(/\\/g, '/').split('/').pop() ?? '',
          );
          return fromFile ? String(Number(fromFile[1])) : null;
        })();
    if (nn !== null && !nnToIssueId.has(nn)) nnToIssueId.set(nn, issueId);
  }

  const spine = readSpine(source);
  const out: Record<string, string> = {};

  // Plan-Table first (lower precedence), then dispatch-log (overwrites).
  for (const row of spine.planTable) {
    if (!row.branch) continue;
    const issueId = nnToIssueId.get(normaliseNn(row.id));
    if (issueId) out[issueId] = row.branch;
  }
  for (const entry of spine.dispatchLog) {
    if (!entry.id || !entry.branch) continue;
    const issueId = nnToIssueId.get(normaliseNn(entry.id));
    if (issueId) out[issueId] = entry.branch;
  }

  return out;
}

/**
 * Normalise an NN-bearing token to its canonical numeric-string key. Strips a
 * `slug/` prefix (`wo/29` → `29`) and zero-padding (`08` → `8`) so dispatch-log
 * heads, Plan-Table IDs, and footnote NNs all collide on one key.
 */
function normaliseNn(token: string): string {
  const m = /(\d+)\s*$/.exec(token.replace(/\//g, '/').trim());
  return m ? String(Number(m[1])) : token.trim();
}

/**
 * Map a Plan-Table / Conflict-list ID (`wo/29`, `smdx/03`) to the canonical
 * issueId (`wave-orchestration#29`) via the footnote map. The conflict-list
 * uses `slug/NN` (slash); footnote keys use `slug-NN` (dash) — normalise both.
 * Falls back to the raw token (dash→hash) when no footnote matches.
 */
function tableIdToIssueId(
  tableId: string,
  keyToPath: Map<string, string>,
): string | null {
  // `wo/29` → footnote key `wo-29`.
  const footKey = tableId.replace(/\//g, '-');
  const path = keyToPath.get(footKey);
  if (path) return extractIssueId(path);
  // Fallback: treat `slug/NN` as `slug#NN` directly.
  const m = /^(.+)\/(\d+)$/.exec(tableId);
  if (m) return `${m[1]}#${m[2]}`;
  return null;
}

/**
 * Convenience for the CLI: read a spine file, parse it, run computeMergeOrder.
 * Kept here (not in the CLI) so it is unit-testable without spawning a process.
 *
 * Two paths depending on whether issue files are found on disk:
 *
 * - MarkdownFs / `.scratch` case (`issuePaths.length > 0`): issue files were
 *   located on disk → read their `Files:` headers for the real fileCount
 *   (the historical path, unchanged).
 *
 * - GitHub / spine-self-contained case (`issuePaths.length === 0`, ADR-0019):
 *   no issue files on disk. Re-read the Conflict-Map verbatim via
 *   `readSpine(source).conflictMap` (bare ids survive — `parseWaveSpine`'s
 *   `tableIdToIssueId` drops bare numbers) and build PRs from the Plan-Table
 *   with a conflict-footprint fileCount proxy.
 */
export function computeMergeOrderFromSpine(
  spinePath: string,
  opts: ComputeMergeOrderOptions = {},
): MergeOrderResult {
  const abs = resolve(spinePath);
  const source = readFileSync(abs, 'utf-8');
  const { issuePaths, conflictMap, branchesByIssueId } = parseWaveSpine(source, dirname(abs));

  const repoRoot = opts.repoRoot ?? process.cwd();
  const git = opts.git ?? defaultGitProbe(repoRoot);
  const branches = { ...branchesByIssueId, ...opts.branchesByIssueId };

  // MarkdownFs / `.scratch` case: issue files were located on disk → read their
  // `Files:` headers for the real fileCount (the historical path, unchanged).
  if (issuePaths.length > 0) {
    return computeMergeOrder(issuePaths, conflictMap, { ...opts, git, branchesByIssueId: branches });
  }

  // GitHub / spine-self-contained case (ADR-0019): no issue files on disk.
  // Re-read the Conflict-Map verbatim (bare ids survive) + build PRs from the
  // Plan-Table with a conflict-footprint fileCount. No `git` is threaded into
  // `buildSpinePrs` for branch resolution (FOR-15) — it reads `row.branch`
  // directly; `git` is still needed below, for `orderPrs`'s stacked-branch
  // ancestry probe over the (correctly-resolved) branches.
  const spineConflictMap = readSpine(source).conflictMap;
  const { prs, notInPlay } = buildSpinePrs(source, spineConflictMap, branches);
  return orderPrs(prs, spineConflictMap, git, { notInPlay });
}
