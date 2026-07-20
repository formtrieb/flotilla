/**
 * cross-wave.ts — the core value (CHARTER §9): "can this wave run alongside the
 * ones already running?"
 *
 * `computeConflictMap` is wave-agnostic. Feed it `(candidate wave) ∪ (everything
 * currently queued + in-flight)` and the cross-wave overlaps fall out: a cell
 * pairing a candidate with an already-claimed issue means their declared file
 * scopes intersect → serialize or split; none → parallel-safe.
 *
 * Pure: it composes the engine's conflict-map over `IssueView`-shaped inputs and
 * partitions the resulting cells; it performs no I/O (the caller supplies the
 * candidate + claimed sets from the IssueStore).
 *
 * FOR-8 folds a second, orthogonal reasoning pass into the same call: intra-wave
 * `Blocked by` membership (`intraWaveBlockedByPairs`, see below) — whether a
 * roster member is blocked by another roster member, and whether that blocker
 * has shipped far enough to no longer count. It rides the existing `cross-wave`
 * CLI verb (no new plumbing) because `candidates`/`claimed` are already fed
 * full `IssueView`s in practice — `ScopedIssue`'s optional `blockedBy`/`status`
 * fields just give the engine type permission to read what was already there.
 */

import { computeConflictMap, type ConflictCell } from './conflict-map';
import type { BlockedBy, CoarseState, IssueRef } from './contract';

/**
 * Minimal shape the check needs — `IssueView` satisfies it structurally.
 * `blockedBy`/`status` are optional: plain file-conflict callers keep passing
 * the bare `{id, files}` shape unchanged; when present (the common case, since
 * `candidates`/`claimed` are built from real `IssueView` reads) they feed
 * {@link findIntraWaveBlockedByPairs}.
 */
export interface ScopedIssue {
  id: string;
  files: string[];
  /** The issue's declared blockers, if known — `IssueView.blockedBy`. */
  blockedBy?: BlockedBy;
  /** The issue's coarse claim-state, if known — `IssueView.status`. */
  status?: CoarseState;
}

/**
 * A `Blocked by` relationship where BOTH the blocked issue and its blocker are
 * members of the same candidate roster (FOR-8) — an in-wave dependency the
 * roster itself must sequence, not a cross-wave concern. A blocker outside the
 * roster (already-closed prerequisite, or a genuine cross-wave dependency) is
 * not reported here.
 */
export interface IntraWaveBlockedByPair {
  /** The roster id carrying the `blockedBy` reference. */
  blocked: string;
  /** The roster id the reference resolves to. */
  blocker: string;
  /**
   * True iff the blocker's `status` has already reached `in-review` or `done`
   * — the point past which flotilla considers the dependency shipped
   * (`wave-shared` Convention 4's close phrase / an open PR under review).
   * False whenever `status` is missing or short of that — the safe default,
   * since an unknown state must not silently unblock a dispatch.
   */
  resolved: boolean;
}

/** Coarse states past which an intra-wave blocker no longer holds its dependents. */
const BLOCKER_RESOLVED_STATUSES = new Set<CoarseState>(['in-review', 'done']);

export interface CrossWaveInput {
  /** The wave being planned (eligible, about to be claimed). */
  candidates: ScopedIssue[];
  /** Everything already claimed by other waves (queued + in-flight). */
  claimed: ScopedIssue[];
  /**
   * Repo root — globs expand relative to it. Optional (FOR-38): without it,
   * `computeConflictMap` cannot expand glob-pattern `Files` entries against a
   * working tree, so it falls back to exact-pattern-text comparison and
   * surfaces every unexpanded pattern via {@link CrossWaveResult.warnings} —
   * see `ComputeOptions.repoRoot` for the full fail-loud/warn contract. Always
   * pass a real repoRoot in production call sites (`wave-plan`/`wave-create`
   * both do); omitting it is a degraded mode, not a supported shortcut.
   */
  repoRoot?: string;
}

export interface CrossWaveResult {
  /** True iff no candidate's scope intersects an already-claimed issue's scope. */
  parallelSafe: boolean;
  /**
   * Overlaps between a candidate and an already-claimed issue — the cross-wave
   * conflicts that block parallel launch. Each cell's `a`/`b` are issue ids in
   * canonical order (a < b) and each unordered pair appears at most once;
   * `files` are the intersecting concrete paths.
   */
  crossWaveConflicts: ConflictCell[];
  /**
   * Overlaps WITHIN the candidate set — the wave's own internal conflicts
   * (resolve by serializing the barrel write / giving one issue ownership).
   * Each cell's `a`/`b` are in canonical order (a < b) and each unordered
   * pair appears at most once.
   */
  intraWaveConflicts: ConflictCell[];
  /**
   * `Blocked by` pairs WITHIN the candidate set (FOR-8) — see
   * {@link IntraWaveBlockedByPair}. Empty when no candidate declares a
   * blockedBy ref that resolves to another candidate.
   */
  intraWaveBlockedByPairs: IntraWaveBlockedByPair[];
  /**
   * Present (non-empty) only when `repoRoot` was omitted and at least one
   * candidate or claimed issue declared a glob-pattern `Files` entry that
   * could therefore not be expanded (FOR-38) — see
   * `ComputeOptions.warnings`/`ConflictMap.warnings` for the exact contract.
   * Absent whenever every glob was expanded normally (including whenever a
   * real `repoRoot` was supplied). Surface this prominently: its absence-as-
   * fact failure mode is exactly what under-reports conflicts and makes
   * `parallelSafe` lie in the dangerous direction.
   */
  warnings?: string[];
}

/**
 * Answer "can these candidates run alongside the already-claimed work?" by
 * computing the conflict map over the union and partitioning its cells into
 * cross-wave (candidate↔claimed — the blocker) and intra-wave (candidate↔candidate).
 * Claimed↔claimed cells are ignored: that work is already running, not ours to gate.
 *
 * `candidates` and `claimed` are combined as a **set union keyed by id**, not a
 * concatenation: own-wave rows are soft-claimed at `wave-create`, so the same
 * issue routinely appears in both lists. Deduplicating at the source (rather
 * than post-filtering `computeConflictMap`'s output) is what makes each
 * unordered pair appear exactly once, canonically ordered a < b, in both
 * `intraWaveConflicts` and `crossWaveConflicts` — including when
 * `candidates` and `claimed` fully overlap.
 */
export function crossWaveCheck(input: CrossWaveInput): CrossWaveResult {
  const candidateIds = new Set(input.candidates.map((c) => c.id));
  const claimedIds = new Set(input.claimed.map((c) => c.id));

  // Union keyed by id — candidates win on duplicate id (same issue, same
  // files in practice; candidates is the more "current" read of the two).
  const byId = new Map<string, ScopedIssue>();
  for (const c of input.claimed) byId.set(c.id, c);
  for (const c of input.candidates) byId.set(c.id, c);

  const all = [...byId.values()].map((v) => ({
    issueId: v.id,
    files: v.files,
  }));
  const map = computeConflictMap(all, { repoRoot: input.repoRoot });

  const crossWaveConflicts: ConflictCell[] = [];
  const intraWaveConflicts: ConflictCell[] = [];
  for (const cell of map.cells) {
    const aCand = candidateIds.has(cell.a);
    const bCand = candidateIds.has(cell.b);
    if (aCand && bCand) {
      intraWaveConflicts.push(cell);
    } else if (aCand !== bCand) {
      // exactly one side is a candidate, the other is claimed → cross-wave
      const otherClaimed = aCand ? claimedIds.has(cell.b) : claimedIds.has(cell.a);
      if (otherClaimed) crossWaveConflicts.push(cell);
    }
    // claimed↔claimed: not our concern
  }

  return {
    parallelSafe: crossWaveConflicts.length === 0,
    crossWaveConflicts,
    intraWaveConflicts,
    // Scoped to `input.candidates` only (not the candidates∪claimed union
    // above) — "intra-wave" means both ends are roster members of THIS wave;
    // a ref resolving only inside `claimed` is someone else's dependency.
    intraWaveBlockedByPairs: findIntraWaveBlockedByPairs(input.candidates),
    ...(map.warnings && map.warnings.length > 0 ? { warnings: map.warnings } : {}),
  };
}

/**
 * Resolve each candidate's `blockedBy` refs against the candidate roster
 * itself — the "is my blocker also in this wave?" check (FOR-8). Matching is
 * done on a **normalized `(slug, number)` key** ({@link idKey}) rather than by
 * reconstructing a literal id string: the three shipped adapters each pick
 * their own slug/number join convention (`markdown-fs-store.ts`'s `<slug>#<nn>`,
 * zero-padded; `linear-issues-store.ts`'s `<TEAM>-<n>`; `github-issues-store.ts`'s
 * bare `<n>`, no slug) and none of it is a format the engine is supposed to
 * know (ADR-0001 — ids are opaque). Normalizing both sides to the same key
 * sidesteps guessing a joiner AND the zero-padding mismatch (MarkdownFs's `05`
 * vs. a ref's un-padded `5` — the same padding `dor-gate.ts`'s
 * `checkBlockedByChain`/`issueExists` re-applies on its own file-existence
 * check). `ref.slug`, when present, always wins (a genuine cross-slug/cross-team
 * reference); a slug-less ref inherits the REFERENCING issue's own slug — same
 * precedent as `dor-gate.ts`'s `checkBlockedByChain` / `linear-issues-store.ts`'s
 * `refKey`: `const slug = ref.slug ?? ownSlug`. Only pairs whose resolved
 * blocker id is ALSO a roster member are returned; a blocker outside the
 * roster (an already-closed prerequisite, or a genuine cross-wave dependency)
 * is out of scope here.
 */
function findIntraWaveBlockedByPairs(candidates: ScopedIssue[]): IntraWaveBlockedByPair[] {
  const idByKey = new Map<string, string>();
  const statusById = new Map(candidates.map((c) => [c.id, c.status]));
  for (const c of candidates) {
    const split = splitId(c.id);
    if (split) idByKey.set(idKey(split.slug, split.num), c.id);
  }

  const pairs: IntraWaveBlockedByPair[] = [];
  for (const candidate of candidates) {
    if (!candidate.blockedBy || candidate.blockedBy === 'none') continue;
    const ownSlug = splitId(candidate.id)?.slug;
    for (const ref of candidate.blockedBy) {
      const blockerId = idByKey.get(idKey(ref.slug ?? ownSlug, ref.issue));
      if (blockerId === undefined) continue; // not resolvable to a roster member
      if (blockerId === candidate.id) continue; // self-reference guard (malformed data)
      const blockerStatus = statusById.get(blockerId);
      const resolved =
        blockerStatus !== undefined && BLOCKER_RESOLVED_STATUSES.has(blockerStatus);
      pairs.push({ blocked: candidate.id, blocker: blockerId, resolved });
    }
  }
  return pairs;
}

/**
 * Split a tracker id into its slug + numeric-tail parts, recognising the two
 * shipped slug-bearing conventions (`<slug>#<n>` MarkdownFs, `<TEAM>-<n>`
 * Linear) and falling back to a bare-numeric id (GitHub — no slug). Returns
 * `undefined` for an id whose tail isn't an integer (not a wave-issue ref
 * shape at all — defensive, mirrors `parseRef`'s throw-on-non-numeric in the
 * adapters).
 */
function splitId(id: string): { slug: string | undefined; num: number } | undefined {
  const hash = id.lastIndexOf('#');
  if (hash >= 0) {
    const num = Number(id.slice(hash + 1));
    return Number.isInteger(num) ? { slug: id.slice(0, hash), num } : undefined;
  }
  const dash = /^(.+)-(\d+)$/.exec(id);
  if (dash) return { slug: dash[1], num: Number(dash[2]) };
  const bare = Number(id);
  return Number.isInteger(bare) ? { slug: undefined, num: bare } : undefined;
}

/**
 * A canonical key for matching a tracker id against an `IssueRef` (both
 * reduced to `{slug, num}` via {@link splitId}) that is agnostic to the
 * adapter's join character AND to zero-padding on the numeric part.
 * `JSON.stringify` gives an unambiguous, collision-free encoding of the pair
 * (no delimiter-character assumption about slug contents).
 */
function idKey(slug: string | undefined, num: number): string {
  return JSON.stringify([slug ?? null, num]);
}
