#!/usr/bin/env node
/**
 * resume-cli.ts — the I/O shell around the PURE resume() reconciler (ADR-0002).
 *
 * **This is the ONE canonical entrypoint for resume** (FOR-11). It used to
 * also be reachable as `cli.ts resume`, which the live-gate retro flagged as
 * a two-entrypoint trust gap (docs/retros/2026-07-15-wire-contract.md, P-12:
 * "which one is canonical?"). `cli.ts` no longer routes a `resume` subcommand
 * at all — this file, invoked directly via `npx tsx tools/wave/src/resume-cli.ts
 * ...`, is the only way in. The `wave-resume` skill has always documented it
 * this way (it is store-free — it never touches the tracker, unlike every
 * `cli.ts` subcommand).
 *
 * When a wave Coordinator is killed mid-wave, `resume` reconstructs state from
 * the three durable homes — the spine, live git worktrees, and on-disk sidecars
 * (reports/verdicts) — and prints the per-row reconstruction + decision. The
 * reconciler (resume.ts) is pure; this CLI assembles `ResumeInputs` from real
 * disk and emits the `ResumeResult` (plus a `cleanup[]` array — see below) as
 * formatted JSON.
 *
 * The three durable reads are isolated behind the injectable {@link ResumeDeps}
 * seam so the routing is fully tested without touching the real filesystem.
 *
 * Spine parser: `createSpineStore(path).spine()` — the SAME `Spine` type
 * resume()'s `ResumeInputs.spine` consumes (one parser, no duplication; the
 * spine-store wraps the wave-md-rw reader/validator).
 *
 * ── Crash-cleanup before redispatch (FOR-10) ──────────────────────────────────
 *
 * After `resume()` computes its decisions, every row with `decision ===
 * 'redispatch'` gets its crashed worktree + stale branch cleaned up BEFORE the
 * result is printed (i.e. before the row is handed back to `wave-start`) — a
 * prior crashed attempt can leave a LOCKED worktree with the wave branch still
 * checked out, which collides with a fresh `git checkout -b <branch>`. The
 * worktree lookup for this step is deliberately UNSCOPED (`listAllWorktrees`,
 * not the `--marker`-narrowed `listWorktrees` resume() itself saw) — a
 * `--marker`-scoped `wave-resume` run must still find and clean debris that
 * falls outside that narrower allowlist. See `worktree-cleanup.ts`'s
 * `cleanupCrashedRowForRedispatch`/`cleanupRedispatchRows` for the mechanics
 * (dirty-worktree work-preservation refusal, idempotency).
 *
 * Usage:
 *   npx tsx tools/wave/src/resume-cli.ts \
 *     --spine    <path>  \  WAVE.md spine
 *     --reports  <dir>   \  sidecar reports dir
 *     --verdicts <dir>   \  sidecar verdicts dir
 *     [--repo-root <dir>]   defaults to process.cwd()
 *     [--marker <m>]        narrow agent-worktree path matching to <m>; when
 *                           omitted, the engine's agent+wf_ allowlist is used
 *     [--force]             allow crash-cleanup to destroy a DIRTY crashed
 *                           worktree; without it, a dirty match is surfaced
 *                           (`blockedByDirty: true`) and left untouched
 *
 * Exit codes:
 *   0 — success (ResumeResult + cleanup[] JSON on stdout)
 *   1 — domain failure during assembly/resume (message on stderr)
 *   2 — missing required flag (usage on stderr)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resume, type ResumeInputs } from './resume';
import { createSpineStore } from './spine-store';
import {
  listAgentWorktrees,
  listAllWorktrees,
  cleanupRedispatchRows,
  type WorktreeEntry,
  type RedispatchCleanupOps,
  type RedispatchCleanupResult,
} from './worktree-cleanup';
import {
  readSidecars,
  type SidecarIndex,
  type SidecarReader,
} from './sidecar';
import { flag, printJson } from './cli-utils';

/**
 * The durable-home reads (+ the crash-cleanup seam), isolated for testing.
 * `defaultDeps` wires the real implementations; the spec injects fakes.
 */
export interface ResumeDeps {
  /** Parse the WAVE.md spine at `path` into the `Spine` resume() consumes. */
  parseSpine(path: string): ResumeInputs['spine'];
  /**
   * List live agent worktrees under `repoRoot`. When `marker` is omitted, the
   * engine's default agent+wf_ allowlist is used; when provided, it narrows
   * matching to that single marker.
   */
  listWorktrees(repoRoot: string, marker?: string): WorktreeEntry[];
  /** Build the on-disk report/verdict sidecar index. */
  readSidecars(reportsDir: string, verdictsDir: string): SidecarIndex;
  /**
   * List EVERY live worktree under `repoRoot` — no agent-path/marker
   * filtering. Used ONLY by the crash-cleanup step (FOR-10) so a
   * `--marker`-scoped resume run still finds redispatch-row debris outside
   * that narrower allowlist.
   */
  listAllWorktrees(repoRoot: string): WorktreeEntry[];
  /** Crash-cleanup side-effect seam. Defaults to real git via `defaultRedispatchCleanupOps`. */
  cleanup?: RedispatchCleanupOps;
}

/** Node fs-backed {@link SidecarReader} (the only disk-touching sidecar code). */
function defaultSidecarReader(): SidecarReader {
  return {
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        // Absent dir → no sidecars (mirrors SidecarReader.list contract).
        return [];
      }
    },
    read: (dir, file) => readFileSync(join(dir, file), 'utf-8'),
  };
}

/** The real disk-backed wiring for the durable-home reads + crash-cleanup. */
export const defaultDeps: ResumeDeps = {
  parseSpine: (path) => createSpineStore(path).spine(),
  listWorktrees: (repoRoot, marker) =>
    marker ? listAgentWorktrees(repoRoot, marker) : listAgentWorktrees(repoRoot),
  readSidecars: (reportsDir, verdictsDir) =>
    readSidecars(reportsDir, verdictsDir, defaultSidecarReader()),
  listAllWorktrees: (repoRoot) => listAllWorktrees(repoRoot),
  // `cleanup` is left undefined — cleanupRedispatchRows falls back to
  // `defaultRedispatchCleanupOps(repoRoot)` (real git) when omitted.
};

function printUsage(): void {
  process.stderr.write(
    [
      'error: --spine, --reports and --verdicts are required',
      'usage: resume --spine <path> --reports <dir> --verdicts <dir> [--repo-root <dir>] [--marker <m>] [--force]',
      '',
    ].join('\n'),
  );
}

/**
 * Run the resume CLI: assemble `ResumeInputs` from the durable homes via
 * `deps`, call the pure `resume()`, run crash-cleanup for every `redispatch`
 * row (BEFORE printing — i.e. before the row is handed back to `wave-start`),
 * and print `{ ...ResumeResult, cleanup: RedispatchCleanupResult[] }` as JSON.
 *
 * @param args - CLI argument list (typically `process.argv.slice(2)`)
 * @param deps - injectable durable-home reads (defaults to real disk)
 * @returns exit code: 0 success, 1 domain failure, 2 usage error
 */
export function runResume(args: string[], deps: ResumeDeps = defaultDeps): number {
  const spinePath = flag(args, '--spine');
  const reportsDir = flag(args, '--reports');
  const verdictsDir = flag(args, '--verdicts');
  const repoRoot = flag(args, '--repo-root') ?? process.cwd();
  const marker = flag(args, '--marker');
  const force = args.includes('--force');

  if (spinePath === undefined || reportsDir === undefined || verdictsDir === undefined) {
    printUsage();
    return 2;
  }

  try {
    const spine = deps.parseSpine(spinePath);
    const worktrees = deps.listWorktrees(repoRoot, marker);
    const sidecars = deps.readSidecars(reportsDir, verdictsDir);

    const result = resume({ spine, worktrees, sidecars });

    // Crash-cleanup runs BEFORE the result is printed/handed back — an
    // unscoped worktree scan so a --marker-narrowed resume still finds and
    // cleans a redispatch row's debris (FOR-10).
    const allWorktrees = deps.listAllWorktrees(repoRoot);
    const cleanup: RedispatchCleanupResult[] = cleanupRedispatchRows(
      result.rows,
      allWorktrees,
      { repoRoot, force, ops: deps.cleanup },
    );

    printJson({ ...result, cleanup });
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}

// Only execute when run directly (not when imported by tests).
if (require.main === module) {
  process.exit(runResume(process.argv.slice(2)));
}
