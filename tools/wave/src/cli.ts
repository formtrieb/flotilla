#!/usr/bin/env node
/**
 * CLI entry for `/wave validate <issue-path>` + the `/wave close` deep-module
 * shell-outs (wo/59).
 *
 * Usage:
 *   npx tsx tools/wave/src/cli.ts <issue-path> [<issue-path> ...]
 *   npx tsx tools/wave/src/cli.ts dor <issue-path> [<issue-path> ...]
 *   npx tsx tools/wave/src/cli.ts files-drift <issue-path> <sha-range>
 *   npx tsx tools/wave/src/cli.ts merge-order <wave-md-path>
 *   npx tsx tools/wave/src/cli.ts closed-by <closed-by-line>
 *   npx tsx tools/wave/src/cli.ts detect-host <remote-url>
 *   npx tsx tools/wave/src/cli.ts host-pr <create|arm|merge|status> --branch <b> [--remote <url>] [--method <m>]
 *   npx tsx tools/wave/src/cli.ts worktree-cleanup (--dry-run | --wave <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [...]
 *
 * Subcommands:
 *   dor          Run the DOR-Gate validator (default when no subcommand is given).
 *   files-drift  Detect same-project vs cross-project drift for a wave issue.
 *                Encodes the plan-time-glob policy from wo/39.
 *   merge-order  Compute the recommended merge order for a wave (algorithmic +
 *                stacked-branch override). Reads a WAVE.md spine, emits JSON.
 *                Encodes /wave start Phase 5 step 3a (wo/44).
 *
 *   The three /wave close shell-outs (wo/59) — each is a THIN router to an
 *   already-tested deep module; the CLI adds no logic of its own:
 *   closed-by        Classify a `Closed-by:` line (closed-by.ts #55) → JSON
 *                    { class, needsPin }. Backs Phase 3's "which rows need a
 *                    real PR?" gate.
 *   detect-host      Parse a git remote URL (host-pr.ts #56) → JSON
 *                    { host, workspace, repo }. Backs Phase 2/3's host detection.
 *   worktree-cleanup List + plan + (unless --dry-run) remove pushed-and-clean
 *                    agent worktrees (worktree-cleanup.ts #57) → JSON. The full
 *                    engine summary is printed — { removed, skipped, errors,
 *                    deregisteredNotDeleted, erroredStillListed, branchesDeleted,
 *                    branchHygieneSkipped } (or { selected, skipped } on
 *                    --dry-run) — so a run can never do work and show nothing
 *                    (FOR-67 W15 finding). Backs Phase 5.
 *
 *                    deregisteredNotDeleted is the "deregistered-but-not-deleted"
 *                    ENOTEMPTY class made structural: a worktree whose remover
 *                    reported success but whose directory is verified still on
 *                    disk (FOR-67 — consumer KW-F6). Its presence forces exit 1.
 *
 *                    erroredStillListed is a THIRD ENOTEMPTY-family class (FOR-73
 *                    — W18-F1): the remover THREW, yet `git worktree list` still
 *                    lists the worktree afterwards (as prunable) with its
 *                    directory on disk — an incomplete removal, distinct from a
 *                    genuine failure (which stays in errors). Its presence forces
 *                    exit 1: an operator's prune/retry case, not a defect.
 *
 *                    --orphans (FOR-67) adds a sweep of directories UNDER the
 *                    worktrees root that `git worktree list` does not know about
 *                    at all — deregistered leftovers + EMPTY leftovers from
 *                    earlier waves that --wave scoping correctly ignores. Empty/
 *                    all-junk orphans are removed (report-only under --dry-run);
 *                    an orphan holding a real file is skipped
 *                    (orphan-with-real-files). Reported under the `orphans` key.
 *                    A REGISTERED worktree is never swept, so it is parallel-safe
 *                    and independent of the --wave/--branches scoping below.
 *                    --orphans additionally sweeps orphaned LOCAL branches with
 *                    no removal event (FOR-72 — W15-F1): local wave/* branches
 *                    whose remote ref is gone, and harness worktree-wf_* base
 *                    branches whose worktree is no longer registered or on disk.
 *                    Those deletions/skips fold into branchesDeleted /
 *                    branchHygieneSkipped. The current branch and any checked-out
 *                    branch are never deleted. (Real run only — --dry-run
 *                    previews the orphan DIRECTORY plan, not branches.)
 *
 *                    Optional branch-scoped filter (issue #77 — parallel-wave safety):
 *                      --wave <spine-path>  Read the WAVE.md spine and derive the
 *                                           branch set from its Plan-Table / dispatch-log
 *                                           (via parseWaveSpine → branchesByIssueId).
 *                                           Only worktrees whose branch is in that set
 *                                           are selected. Parallel-safe: sibling waves'
 *                                           worktrees are never removed.
 *                      --branches <b1,b2>   Escape-hatch: a comma-separated list of
 *                                           branch names to restrict selection to.
 *                                           Prefer --wave; use --branches when no spine
 *                                           is available or for scripted overrides.
 *                    Without either flag the original global-GC behaviour is used
 *                    (all pushed-and-clean agent worktrees are selected). This is
 *                    still correct for single-wave / serial closes.
 *                    A bare `worktree-cleanup` with NO arguments at all prints
 *                    usage and exits 2 rather than running a real full cleanup
 *                    against cwd (FOR-34/W5-F4a) — an explicit target
 *                    (repo-root, --wave, or --branches) is required for a real
 *                    (non-dry-run) cleanup; `--dry-run` alone is still accepted
 *                    since it removes nothing.
 *
 * Behaviour:
 *   - Reads each issue file, runs the 6-Gate validator, prints a per-issue
 *     report.
 *   - Exit code: 0 if every issue is PASS or WARN-only; 1 if any issue is FAIL.
 *   - When no path is given, prints usage + exits 2.
 *   - When an unknown subcommand keyword is given, prints an error + exits 2.
 *
 * files-drift exit codes:
 *   0 — clean (no drift)
 *   1 — same-project-drift (advisory)
 *   2 — cross-project-drift (blocking) — NOTE: also used for missing args/errors
 *       (callers should check the JSON `status` field for the semantic meaning)
 *
 * closed-by exit codes:
 *   0 — needsPin: false (row already finalised / not actionable)
 *   1 — needsPin: true  (row is pre-fill / placeholder — open a real PR)
 *   2 — missing arg
 *
 * detect-host exit codes:
 *   0 — a known host (github / bitbucket) parsed
 *   1 — unknown host (caller falls back to the pre-fill / manual path)
 *   2 — missing arg
 *
 * host-pr (ADR-0019 + ADR-0023) — the host-write verb group. Every host write
 * goes through the engine host seam; `gh` is on none of these paths. `create`
 * opens the PR (find-before-create idempotent — an existing open PR is reused,
 * requires --title/--body, reads GITHUB_TOKEN from the env); arm/merge/status
 * land it. Routed by detect-host (github only in M1; bitbucket/unknown fail loud
 * + typed for every verb). See host-pr-cli.ts. Exit codes:
 *   0 — create opened/reused the PR; arm/merge landed the row (merged | armed |
 *       already-merged); status probed
 *   1 — create failed (create-failed + fallbackPrefillUrl); not landed (no-pr |
 *       refused); no adapter for the host; or a host error
 *   2 — usage error
 *
 * worktree-cleanup exit codes:
 *   0 — success (nothing to remove, or all selected removed cleanly)
 *   1 — completed with per-worktree removal errors
 *   2 — usage / unexpected error
 *
 * verdict-acked (FOR-17 — the dead --acked wire, ADR-0004) — the single-owner
 * engine derivation of `issue-store close`'s `--acked` indexes from the FINAL
 * (max-iter valid) ReviewerVerdict sidecar for an id: reads
 * `<verdictsDir>/<id>-<iter>.md` via the same sidecar reader resume uses
 * (sidecar.ts, ADR-0002/0024), then runs `metAcIndexes()`
 * (reviewer-verdict-schema.ts) over the winning verdict — never a skill-side
 * ad-hoc parse. After a changes-requested → re-dispatch cycle the max-iter
 * selection means the indexes always come from the LATEST verdict. Prints
 * `{ acked: number[], iter: number|null, corrupt: number }` — no verdict
 * sidecar (or only a corrupt one) is `{ acked: [], iter: null, corrupt }`, not
 * an error: the tick is cosmetic (ADR-0004) and a merged row may have nothing
 * on disk to derive from. Exit codes:
 *   0 — printed (with or without a verdict found)
 *   2 — usage (missing <verdictsDir>/<id>)
 *
 * render-verdict (FOR-16 — the PR body carries the reviewer-verdict summary) —
 * the single-owner engine render of the human-facing `## Reviewer verdict`
 * PR-body section from the FINAL (max-iter valid) ReviewerVerdict sidecar for
 * an id: reads `<verdictsDir>/<id>-<iter>.md` via the same sidecar reader
 * `verdict-acked` uses (sidecar.ts, ADR-0002/0024), then runs
 * `renderVerdictSection()` (reviewer-verdict-schema.ts) over the winning
 * verdict — never a skill-side hand-format. After a changes-requested →
 * re-dispatch cycle the max-iter selection means the render always carries the
 * LATEST verdict, never the first. Invoked by wave-start's `approved →
 * pr-created` terminator (the PR-open step) to compose the PR `--body`
 * alongside the store-kind close phrase (`wave-shared` Convention 4). Prints
 * the rendered markdown to stdout. Exit codes:
 *   0 — rendered (a verdict sidecar was found for <id>)
 *   1 — no verdict sidecar found for <id> (nothing to render)
 *   2 — usage (missing <verdictsDir>/<id>/--anchor)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { validateIssue, validateIssueView, type DorResult } from './dor-gate';
import { detectDrift, type DriftResult } from './files-drift';
import {
  computeMergeOrderFromSpine,
  parseWaveSpine,
  type MergeOrderResult,
  type ComputeMergeOrderOptions,
} from './merge-order';
import { classifyClosedBy, needsPin } from './closed-by';
import { detectHost } from './host-pr';
import { runHostPr } from './host-pr-cli';
import {
  listAgentWorktrees,
  planCleanup,
  executeCleanup,
  listOrphanDirs,
  planOrphanSweep,
  executeOrphanSweep,
  sweepOrphanBranches,
} from './worktree-cleanup';
import { runConflictMap, runConflictMapById } from './conflict-map-cli';
import { runCrossWave } from './cross-wave-cli';
import { runIssueStore } from './issue-store-cli';
import { runSpine } from './spine-cli';
import { runConfig } from './config-cli';
import {
  runRouteVerdict,
  runRouteOutcome,
  runValidateReport,
  runValidateVerdict,
  runWriteReport,
  runWriteVerdict,
} from './route-cli';
import { findScratchRoot } from './find-repo-root';
import { flag, printJson } from './cli-utils';
import { resolveStore } from './cli-store';
import type { IssueStore } from './adapters/issue-store';
import { readSidecars, type SidecarReader } from './sidecar';
import { metAcIndexes, renderVerdictSection } from './reviewer-verdict-schema';

// NOTE (FOR-11): `resume` is deliberately NOT in this list. The reconciler has
// its OWN separate entrypoint, `resume-cli.ts` (`npx tsx tools/wave/src/resume-cli.ts
// --spine <path> --reports <dir> --verdicts <dir> ...`) — it is store-free and
// was never meant to be a `{{wave-cli}}` subverb (the wave-resume skill has
// always documented it this way). It used to ALSO be reachable as `cli.ts
// resume`, which was the two-entrypoint confusion flagged at the live gate
// (docs/retros/2026-07-15-wire-contract.md, P-12) — that duplicate routing is
// removed here so `resume-cli.ts` is the one canonical entrypoint.
const KNOWN_SUBCOMMANDS = [
  'dor',
  'files-drift',
  'merge-order',
  'closed-by',
  'detect-host',
  'host-pr',
  'worktree-cleanup',
  'conflict-map',
  'cross-wave',
  'issue-store',
  'spine',
  'config',
  'route-verdict',
  'route-outcome',
  'validate-report',
  'validate-verdict',
  'write-report',
  'write-verdict',
  'verdict-acked',
  'render-verdict',
] as const;
type Subcommand = (typeof KNOWN_SUBCOMMANDS)[number];

const STATUS_SYMBOL: Record<string, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  deferred: '⊘',
};

/**
 * Heuristic: a token looks like a subcommand keyword (not a file path) when it
 * contains no path separators and no dots. File paths always contain either `/`
 * or `.` (e.g. `some/path.md`, `./issue.md`, `../foo.md`).
 */
function looksLikeSubcommand(token: string): boolean {
  return !token.includes('/') && !token.includes('.');
}

export function findRepoRoot(start: string): string {
  return findScratchRoot(start);
}

function renderResult(issuePath: string, result: DorResult): string {
  const header = `${result.overall === 'PASS' ? 'PASS' : 'FAIL'}  ${issuePath}`;
  const lines: string[] = [header];
  for (const gate of result.gates) {
    const symbol = STATUS_SYMBOL[gate.status] ?? '?';
    // Show warn as "⚠ warn" — distinct from "✓ pass" and "✗ fail"
    const statusLabel =
      gate.status === 'warn' ? 'warn ' : gate.status.padEnd(5);
    const reason = gate.reason ? `  — ${gate.reason}` : '';
    lines.push(`  ${symbol} ${statusLabel} ${gate.name}${reason}`);
  }
  return lines.join('\n');
}

function printUsage(): void {
  process.stderr.write(
    [
      'usage:',
      '  wave-validate <issue-path> [<issue-path> ...]',
      '  wave-validate dor <issue-path> [<issue-path> ...]',
      '  wave-validate dor --id <issue-id> [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore',
      '  wave-validate files-drift <issue-path> <sha-range>',
      '  wave-validate merge-order <wave-md-path>',
      '  wave-validate closed-by <closed-by-line>',
      '  wave-validate detect-host <remote-url>',
      '  wave-validate worktree-cleanup (--dry-run | --wave <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [...]',
      '  wave-validate conflict-map <issue-path> [<issue-path> ...]',
      '  wave-validate conflict-map --id <issue-id> [--id <id> ...] [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore',
      '  wave-validate cross-wave --candidates <path> --claimed <path> [--repo-root <dir>]',
      '  wave-validate issue-store <op> [...args] [--config <path>]',
      '  wave-validate spine <create|read|set-row-state|set-row-iter|set-row-pr|set-branch|replace-closed-by|set-status> <spine-path> [...args]',
      '  wave-validate config validate <path>',
      '  wave-validate route-verdict --verdict <v> --iteration <1|2> --risk <r> --state <s>',
      '  wave-validate route-outcome --outcome <o> --state <s>',
      '  wave-validate validate-report <file>',
      '  wave-validate validate-verdict <file>',
      '  wave-validate write-report <json-file> --dir <reportsDir> --id <id> --iter <n>',
      '  wave-validate write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>',
      '  wave-validate verdict-acked <verdictsDir> <id>',
      '  wave-validate render-verdict <verdictsDir> <id> --anchor <sha>',
      '',
      `available subcommands: ${KNOWN_SUBCOMMANDS.join(', ')}`,
      '',
      '  resume is a SEPARATE entrypoint, not a subcommand of this CLI — run:',
      '  npx tsx tools/wave/src/resume-cli.ts --spine <path> --reports <dir> --verdicts <dir> [--repo-root <dir>] [--marker <m>] [--force]',
      '',
    ].join('\n'),
  );
}

function runDor(paths: string[]): number {
  let anyFail = false;
  const outputs: string[] = [];

  for (const arg of paths) {
    const issuePath = resolve(arg);
    const repoRoot = findRepoRoot(issuePath);
    let source: string;
    try {
      source = readFileSync(issuePath, 'utf-8');
    } catch (err) {
      anyFail = true;
      outputs.push(
        `FAIL  ${issuePath}\n  ✗ fail  read-issue-file — ${(err as Error).message}`,
      );
      continue;
    }
    const result = validateIssue({ repoRoot, issuePath, source });
    if (result.overall === 'FAIL') anyFail = true;
    outputs.push(renderResult(issuePath, result));
  }

  process.stdout.write(outputs.join('\n\n') + '\n');
  return anyFail ? 1 : 0;
}

/**
 * The non-file Definition-of-Ready entrypoint (`dor --id <id>`, ADR-0014).
 * Async because it reads the issue from the (async) `IssueStore`; the engine
 * function {@link validateIssueView} stays pure over the `IssueView`. The store
 * is built from `--config` unless one is injected (tests). Self-content gates
 * run; working-tree + cross-issue gates `defer` (no checkout on a bare id).
 *
 * Exit: 0 = ready (PASS / warn / deferred only), 1 = a content-gate FAIL, a
 * store-construction failure (BEFORE op dispatch — e.g. an unreadable config
 * or a network failure standing up the tracker API client), or a store-read
 * failure; 2 = usage (missing `--id`). `resolveStore` is deliberately inside
 * this try/catch (FOR-11): a throw there used to escape uncaught, breaking
 * this function's documented always-resolves-to-a-number contract — a caller
 * that doesn't itself wrap the call in try/catch could observe an unhandled
 * rejection instead of a clean non-zero exit.
 */
export async function runDorById(
  args: string[],
  injected?: IssueStore,
): Promise<number> {
  const id = flag(args, '--id');
  if (id === undefined) {
    process.stderr.write('error: dor --id requires an <id>\n');
    return 2;
  }

  let store: IssueStore;
  try {
    store = await resolveStore(args, injected);
  } catch (err) {
    process.stderr.write(
      `error: could not resolve the issue store: ${(err as Error).message}\n`,
    );
    return 1;
  }

  let view;
  try {
    view = await store.read(id);
  } catch (err) {
    process.stderr.write(
      `error: cannot read issue ${id}: ${(err as Error).message}\n`,
    );
    return 1;
  }

  const repoRoot = flag(args, '--repo-root');
  const result = validateIssueView(view, repoRoot !== undefined ? { repoRoot } : {});
  process.stdout.write(renderResult(id, result) + '\n');
  return result.overall === 'FAIL' ? 1 : 0;
}

/** Render a DriftResult to stdout as human-readable text + JSON. */
function renderDriftResult(result: DriftResult): string {
  const statusLine =
    result.status === 'clean'
      ? '✓ clean'
      : result.status === 'same-project-drift'
        ? '⚠ same-project-drift (advisory)'
        : '✗ cross-project-drift (blocking)';

  const lines: string[] = [statusLine, '', result.rationale];

  if (result.projectScopes.length > 0) {
    lines.push(
      '',
      `Project scope(s): ${result.projectScopes.map((s) => `\`${s || '.'}\``).join(', ')}`,
    );
  }

  lines.push('', '--- JSON output ---');
  lines.push(
    JSON.stringify(
      {
        status: result.status,
        driftedFiles: result.driftedFiles,
        rationale: result.rationale,
        projectScopes: result.projectScopes,
      },
      null,
      2,
    ),
  );

  return lines.join('\n');
}

/**
 * Run the files-drift subcommand.
 *
 * Exit codes:
 *   0 — clean
 *   1 — same-project-drift (advisory — caller decides whether to block)
 *   2 — cross-project-drift (blocking) OR argument error
 */
function runFilesDrift(args: string[]): number {
  if (args.length < 2) {
    process.stderr.write(
      [
        'error: files-drift requires two arguments',
        'usage: wave-validate files-drift <issue-path> <sha-range>',
        '',
      ].join('\n'),
    );
    return 2;
  }

  const [issuePath, shaRange] = args;
  const resolvedPath = resolve(issuePath);
  const repoRoot = findRepoRoot(resolvedPath);

  let source: string;
  try {
    source = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `error: could not read issue file: ${(err as Error).message}\n`,
    );
    return 2;
  }

  const result = detectDrift({
    issuePath: resolvedPath,
    source,
    shaRange,
    repoRoot,
  });

  process.stdout.write(renderDriftResult(result) + '\n');

  switch (result.status) {
    case 'clean':
      return 0;
    case 'same-project-drift':
      return 1;
    case 'cross-project-drift':
      return 2;
  }
}

/** Render a MergeOrderResult to a compact JSON shape the skill consumes. */
function renderMergeOrder(result: MergeOrderResult): string {
  const projectPr = (p: MergeOrderResult['algorithmic'][number]) => ({
    issueId: p.issueId,
    nn: p.nn,
    fileCount: p.fileCount,
    branch: p.branch,
    ...(p.title !== undefined ? { title: p.title } : {}),
    ...(p.prUrl !== undefined && p.prUrl !== null ? { prUrl: p.prUrl } : {}),
  });
  return JSON.stringify(
    {
      algorithmic: result.algorithmic.map(projectPr),
      override: result.override ? result.override.map(projectPr) : null,
      reason: result.reason,
      hasOverride: result.override !== null,
      // FOR-15: rows never dispatched (no branch, no PR) — excluded above,
      // listed here instead of silently dropped — and advisory warnings from
      // branch resolution (currently only the `.scratch` NN-glob fallback;
      // always empty on a spine-self-contained wave — see MergeOrderResult).
      notInPlay: result.notInPlay.map(projectPr),
      warnings: result.warnings,
    },
    null,
    2,
  );
}

/**
 * Run the merge-order subcommand.
 *
 * Reads a WAVE.md spine via `computeMergeOrderFromSpine`, which handles both:
 *   - MarkdownFs / `.scratch` case (issue files on disk → real `Files:` fileCount)
 *   - GitHub / spine-self-contained case (no issue files → conflict-footprint proxy)
 *
 * Exit codes:
 *   0 — success (JSON on stdout)
 *   2 — missing arg or unreadable spine
 */
function runMergeOrder(
  args: string[],
  opts: ComputeMergeOrderOptions = {},
): number {
  if (args.length < 1) {
    process.stderr.write(
      [
        'error: merge-order requires one argument',
        'usage: wave-validate merge-order <wave-md-path>',
        '',
      ].join('\n'),
    );
    return 2;
  }

  const spinePath = resolve(args[0]);
  const repoRoot = opts.repoRoot ?? findRepoRoot(spinePath);
  let result: MergeOrderResult;
  try {
    result = computeMergeOrderFromSpine(spinePath, {
      ...opts,
      repoRoot,
    });
  } catch (err) {
    process.stderr.write(
      `error: could not read wave file: ${(err as Error).message}\n`,
    );
    return 2;
  }
  process.stdout.write(renderMergeOrder(result) + '\n');
  return 0;
}

/**
 * Run the `closed-by` subcommand — a thin router to {@link classifyClosedBy} /
 * {@link needsPin} (closed-by.ts #55). Emits `{ class, needsPin }` JSON; the
 * exit code mirrors `needsPin` so a shell can branch without parsing the JSON.
 *
 * Exit codes:
 *   0 — needsPin: false   1 — needsPin: true   2 — missing arg
 */
function runClosedBy(args: string[]): number {
  if (args.length < 1) {
    process.stderr.write(
      [
        'error: closed-by requires one argument',
        'usage: wave-validate closed-by <closed-by-line>',
        '',
      ].join('\n'),
    );
    return 2;
  }
  const line = args.join(' ');
  const cls = classifyClosedBy(line);
  const pin = needsPin(line);
  process.stdout.write(
    JSON.stringify({ class: cls, needsPin: pin }, null, 2) + '\n',
  );
  return pin ? 1 : 0;
}

/**
 * Run the `detect-host` subcommand — a thin router to {@link detectHost}
 * (host-pr.ts #56). Emits `{ host, workspace, repo }` JSON; exit 1 signals an
 * `unknown` host so the skill falls back to the pre-fill / manual path.
 *
 * Exit codes:
 *   0 — github / bitbucket   1 — unknown host   2 — missing arg
 */
function runDetectHost(args: string[]): number {
  if (args.length < 1) {
    process.stderr.write(
      [
        'error: detect-host requires one argument',
        'usage: wave-validate detect-host <remote-url>',
        '',
      ].join('\n'),
    );
    return 2;
  }
  const info = detectHost(args[0]);
  process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  return info.host === 'unknown' ? 1 : 0;
}

/**
 * Derive the branch filter set for `worktree-cleanup` from the `--wave` or
 * `--branches` flags. Returns `undefined` when neither flag is supplied (global
 * GC — the original behaviour).
 *
 * `--wave <spine-path>` reads the WAVE.md spine via `parseWaveSpine` and
 * extracts the unique branch names from the `branchesByIssueId` map. This is the
 * preferred form: the caller passes a spine, not a hand-maintained list.
 *
 * `--branches <b1,b2,...>` is the escape hatch: a caller-supplied comma-separated
 * list of branch names. Used when no spine is available or for scripted overrides.
 *
 * When both are supplied, `--wave` wins (it is the authoritative source); the
 * `--branches` value is merged in as an additive supplement.
 */
function resolveBranchFilter(
  args: string[],
  repoRoot: string,
): Set<string> | undefined {
  // Extract --wave <value> and --branches <value> from the args.
  let waveSpinePath: string | null = null;
  let branchesLiteral: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wave' && i + 1 < args.length) {
      waveSpinePath = args[i + 1];
      i++;
    } else if (args[i] === '--branches' && i + 1 < args.length) {
      branchesLiteral = args[i + 1];
      i++;
    }
  }

  if (waveSpinePath === null && branchesLiteral === null) {
    return undefined; // No filter — global GC.
  }

  const filter = new Set<string>();

  if (waveSpinePath !== null) {
    const absSpine = resolve(repoRoot, waveSpinePath);
    try {
      const source = readFileSync(absSpine, 'utf-8');
      const { branchesByIssueId } = parseWaveSpine(source, dirname(absSpine));
      for (const branch of Object.values(branchesByIssueId)) {
        if (branch) filter.add(branch);
      }
    } catch (err) {
      // Propagate as a usage error — the spine must be readable.
      throw new Error(
        `--wave: could not read spine "${absSpine}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  if (branchesLiteral !== null) {
    for (const b of branchesLiteral.split(',')) {
      const trimmed = b.trim();
      if (trimmed) filter.add(trimmed);
    }
  }

  return filter.size > 0 ? filter : undefined;
}

/**
 * Run the `worktree-cleanup` subcommand — a thin router to the worktree-cleanup
 * deep module (#57). Lists agent worktrees, plans the clean-only removal set,
 * and (unless `--dry-run`) executes it. All git side-effects live in the module
 * behind its `WorktreeRemover` seam; this routine only formats the result.
 *
 * Reached only when `main()` has already required at least one argument
 * (FOR-34) — a truly bare `worktree-cleanup` never reaches here. `args` may
 * still be just `['--dry-run']` with no repo-root/--wave/--branches; that is
 * fine because dry-run performs no removal.
 *
 * Optional branch-scoped filter (issue #77 — parallel-wave safety):
 *   --wave <spine-path>   Derive the branch set from the spine's Plan-Table /
 *                         dispatch-log (parseWaveSpine → branchesByIssueId).
 *                         Only worktrees on those branches are selected.
 *   --branches <b1,b2>    Escape-hatch: comma-separated branch list.
 * Without either flag, the original global-GC behaviour applies (all
 * pushed-and-clean agent worktrees are selected — correct for serial closes).
 *
 * Optional orphan sweep (FOR-67 — consumer KW-F6 + W15 findings; extended by
 * FOR-72 — W15-F1):
 *   --orphans             Additionally sweep (a) directories under the worktrees
 *                         root that `git worktree list` does not know about at
 *                         all (deregistered leftovers + empty leftovers from
 *                         earlier waves — reported under the `orphans` key), AND
 *                         (b, FOR-72) orphaned LOCAL branches with no removal
 *                         event: local wave/* branches whose remote ref is gone
 *                         and harness worktree-wf_* base branches whose worktree
 *                         is no longer registered or on disk. Both are
 *                         independent of --wave/--branches and parallel-safe (a
 *                         registered worktree is never an orphan; a checked-out
 *                         or current branch is never deleted). The branch
 *                         deletions/skips ride the existing branchesDeleted /
 *                         branchHygieneSkipped fields.
 *
 * Prints the FULL engine summary so a run can never do work and show nothing
 * (FOR-67): removed/skipped/errors PLUS deregisteredNotDeleted (the ENOTEMPTY
 * class), erroredStillListed (FOR-73 — a throwing removal git still lists as
 * prunable), branchesDeleted, branchHygieneSkipped (both of which, with
 * --orphans, fold in the standalone orphaned-branch sweep — FOR-72), and (with
 * --orphans) orphans.
 *
 * Idempotent: a re-run after everything is cleaned reports an empty plan and
 * exits 0 (nothing selected → nothing removed).
 *
 * Exit codes:
 *   0 — success (incl. nothing-to-do)
 *   1 — a removal error, a deregistered-but-not-deleted directory, an
 *       errored-yet-still-listed worktree (FOR-73), or an orphan-sweep removal
 *       error
 *   2 — usage / unexpected error
 */
function runWorktreeCleanup(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const orphans = args.includes('--orphans');
  // Positional args are those that don't start with '--' and are not values of
  // a known flag (--wave / --branches consume the token after them).
  const flagsWithValues = new Set(['--wave', '--branches']);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (flagsWithValues.has(args[i])) i++; // consume the value token
      continue;
    }
    positional.push(args[i]);
  }
  const repoRoot =
    positional.length > 0 ? resolve(positional[0]) : process.cwd();

  try {
    const branchFilter = resolveBranchFilter(args, repoRoot);
    const worktrees = listAgentWorktrees(repoRoot);
    const plan = planCleanup(worktrees, branchFilter);

    // The orphan sweep (FOR-67) is an additive, branch-filter-independent pass:
    // it sweeps directories under the worktrees root that `git worktree list`
    // does not know about at all (deregistered-but-not-deleted ENOTEMPTY
    // leftovers + empty leftovers from earlier waves). It is inherently
    // parallel-safe — a sibling wave's live worktree is REGISTERED, so it is
    // never seen as an orphan (--wave/--branches scoping of the registered
    // cleanup above is untouched).
    const orphanPlan = orphans ? planOrphanSweep(listOrphanDirs(repoRoot)) : null;

    if (dryRun) {
      process.stdout.write(
        JSON.stringify(
          {
            dryRun: true,
            ...(branchFilter !== undefined
              ? { branchFilter: [...branchFilter].sort() }
              : {}),
            selected: plan.selected,
            skipped: plan.skipped,
            ...(orphanPlan !== null
              ? {
                  orphans: {
                    selected: orphanPlan.selected,
                    skipped: orphanPlan.skipped,
                  },
                }
              : {}),
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    const result = executeCleanup(plan, { repoRoot });
    const orphanResult =
      orphanPlan !== null ? executeOrphanSweep(orphanPlan, { repoRoot }) : null;

    // Standalone orphaned-BRANCH sweep (FOR-72 — W15-F1, 3× reproduced): the
    // counterpart to the orphan-DIRECTORY sweep, gated on the same --orphans
    // flag. It deletes local wave branches whose remote ref is gone and harness
    // worktree-wf_* base branches whose worktree is gone, WITHOUT needing a
    // worktree-removal event in this run (the manual force-remove ENOTEMPTY-
    // fallback leaves those branches orphaned silently). Run AFTER the orphan-
    // DIR sweep so a just-removed orphan dir's throwaway branch reads as
    // eligible (its worktree is now gone from disk). Its deletions/skips ride
    // the EXISTING branchesDeleted / branchHygieneSkipped fields below, so the
    // whole sweep stays observable in one summary.
    const orphanBranchResult = orphans ? sweepOrphanBranches({ repoRoot }) : null;
    const branchesDeleted =
      orphanBranchResult !== null
        ? [...result.branchesDeleted, ...orphanBranchResult.branchesDeleted]
        : result.branchesDeleted;
    const branchHygieneSkipped =
      orphanBranchResult !== null
        ? [...result.branchHygieneSkipped, ...orphanBranchResult.branchHygieneSkipped]
        : result.branchHygieneSkipped;

    // Print the FULL cleanup summary (FOR-67 — W15 finding: branchesDeleted /
    // branchHygieneSkipped were computed by the engine but never surfaced at
    // the CLI, so a run could delete branches and show nothing). Every
    // structural field the engine returns — including the
    // deregistered-but-not-deleted class and the orphan sweep — is now printed.
    process.stdout.write(
      JSON.stringify(
        {
          dryRun: false,
          ...(branchFilter !== undefined
            ? { branchFilter: [...branchFilter].sort() }
            : {}),
          removed: result.removed,
          skipped: result.skipped,
          errors: result.errors,
          deregisteredNotDeleted: result.deregisteredNotDeleted,
          erroredStillListed: result.erroredStillListed,
          branchesDeleted,
          branchHygieneSkipped,
          ...(orphanResult !== null ? { orphans: orphanResult } : {}),
        },
        null,
        2,
      ) + '\n',
    );
    // Exit non-zero on any incomplete outcome a human/skill must notice: a
    // removal error, a deregistered-but-not-deleted directory (removal did not
    // fully complete), an errored-yet-still-listed worktree (FOR-73 — the
    // removal threw and git still lists it as prunable, a prune/retry case an
    // operator must see), or an orphan-sweep removal error.
    const anyFailure =
      result.errors.length > 0 ||
      result.deregisteredNotDeleted.length > 0 ||
      result.erroredStillListed.length > 0 ||
      (orphanResult !== null && orphanResult.errors.length > 0);
    return anyFailure ? 1 : 0;
  } catch (err) {
    process.stderr.write(
      `error: worktree-cleanup failed: ${(err as Error).message}\n`,
    );
    return 2;
  }
}

/** Node fs-backed {@link SidecarReader} — mirrors resume-cli.ts's `defaultSidecarReader`
 * (the only other disk-touching sidecar wiring), reused here rather than
 * duplicated: an absent dir reads as no sidecars, never an error. */
function defaultVerdictSidecarReader(): SidecarReader {
  return {
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    read: (dir, file) => readFileSync(join(dir, file), 'utf-8'),
  };
}

/**
 * Run the `verdict-acked` subcommand — the single-owner engine derivation of
 * `issue-store close --acked` for wave-close (FOR-17, ADR-0004). Reads the
 * MAX-iter valid ReviewerVerdict sidecar for `<id>` out of `<verdictsDir>`
 * (via {@link readSidecars}, the same max-iter-per-id reader the resume path
 * uses — so a changes-requested → re-dispatch cycle's stale iter-1 verdict is
 * never picked over the latest), then runs {@link metAcIndexes} over it. A
 * missing or schema-invalid verdict sidecar is never a failure here — it
 * prints `acked: []` (nothing to tick; the tick is cosmetic, ADR-0004), with
 * `corrupt` reporting how many malformed sidecars were seen for this id so a
 * skill/human can tell "no verdict yet" apart from "a verdict exists but
 * failed to parse".
 *
 * Exit codes: 0 — printed (found or not found); 2 — usage (missing args).
 */
function runVerdictAcked(args: string[]): number {
  const verdictsDir = args[0];
  const id = args[1];
  if (verdictsDir === undefined || id === undefined) {
    process.stderr.write(
      [
        'error: verdict-acked requires <verdictsDir> <id>',
        'usage: wave-validate verdict-acked <verdictsDir> <id>',
        '',
      ].join('\n'),
    );
    return 2;
  }
  // readSidecars wants a reportsDir too (it indexes both kinds together) — we
  // only ever read verdictFor(), so point it at a sibling path guaranteed
  // absent under verdictsDir rather than duplicate the reader's logic. The
  // default reader above treats an absent dir as "no sidecars", never an error.
  const unusedReportsDir = join(verdictsDir, '.verdict-acked-no-reports');
  const idx = readSidecars(
    unusedReportsDir,
    verdictsDir,
    defaultVerdictSidecarReader(),
  );
  const hit = idx.verdictFor(id);
  const acked = hit ? metAcIndexes(hit.verdict) : [];
  printJson({
    acked,
    iter: hit ? hit.iter : null,
    corrupt: idx.corruptFor(id).filter((c) => c.kind === 'verdict').length,
  });
  return 0;
}

/**
 * Run the `render-verdict` subcommand — the single-owner engine render of the
 * human-facing `## Reviewer verdict` PR-body section (FOR-16). Reads the
 * MAX-iter valid ReviewerVerdict sidecar for `<id>` out of `<verdictsDir>` (the
 * same {@link readSidecars} max-iter-per-id reader `verdict-acked` uses — so a
 * changes-requested → re-dispatch cycle's stale iter-1 verdict is never
 * rendered over the latest), then runs {@link renderVerdictSection} over it
 * with the supplied `--anchor` SHA. Unlike `verdict-acked`, a missing verdict
 * IS a failure here: this verb is only ever called at the `approved →
 * pr-created` terminator, by which point a verdict that routed to `approved`
 * must exist on disk — a miss means the Scribe write step was skipped, and the
 * caller should recover it (write-verdict) before opening the PR, not open a
 * PR with a silently blank verdict section.
 *
 * Exit codes: 0 — rendered; 1 — no verdict sidecar found for <id>;
 * 2 — usage (missing args).
 */
function runRenderVerdict(args: string[]): number {
  const verdictsDir = args[0];
  const id = args[1];
  const anchorSha = flag(args, '--anchor');
  if (verdictsDir === undefined || id === undefined || anchorSha === undefined) {
    process.stderr.write(
      [
        'error: render-verdict requires <verdictsDir> <id> --anchor <sha>',
        'usage: wave-validate render-verdict <verdictsDir> <id> --anchor <sha>',
        '',
      ].join('\n'),
    );
    return 2;
  }
  // Same reportsDir sidestep as verdict-acked (readSidecars indexes both kinds
  // together; we only ever read verdictFor()).
  const unusedReportsDir = join(verdictsDir, '.render-verdict-no-reports');
  const idx = readSidecars(
    unusedReportsDir,
    verdictsDir,
    defaultVerdictSidecarReader(),
  );
  const hit = idx.verdictFor(id);
  if (hit === null) {
    process.stderr.write(
      `error: render-verdict: no verdict sidecar found for "${id}" under ${verdictsDir}\n`,
    );
    return 1;
  }
  process.stdout.write(
    renderVerdictSection(hit.verdict, { iteration: hit.iter, anchorSha }) + '\n',
  );
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length === 0) {
    printUsage();
    return 2;
  }

  const first = argv[0];

  // Explicit subcommand routing.
  if (KNOWN_SUBCOMMANDS.includes(first as Subcommand)) {
    const rest = argv.slice(1);
    // A zero-length `rest` is a misinvocation for every subcommand — including
    // the flag-only subcommands (cross-wave), whose own per-flag usage only
    // appears once at least one token follows. `worktree-cleanup` used to be
    // exempted here (bare invocation ran a REAL full cleanup against cwd), but
    // that made the one CLI op capable of real destructive action the only one
    // that silently accepted zero arguments (FOR-34/W5-F4a) — a bare `--dry-run`
    // (no repo-root/--wave/--branches) is still fine, since it performs no
    // removal; only the truly arg-less call needs to require an explicit target.
    if (rest.length === 0) {
      printUsage();
      return 2;
    }
    // Route known subcommands.
    switch (first as Subcommand) {
      case 'dor':
        return runDor(rest);
      case 'files-drift':
        return runFilesDrift(rest);
      case 'merge-order':
        return runMergeOrder(rest);
      case 'closed-by':
        return runClosedBy(rest);
      case 'detect-host':
        return runDetectHost(rest);
      case 'worktree-cleanup':
        return runWorktreeCleanup(rest);
      case 'conflict-map':
        return runConflictMap(rest);
      case 'cross-wave':
        return runCrossWave(rest);
      case 'config':
        return runConfig(rest);
      case 'spine':
        return runSpine(rest);
      case 'route-verdict':
        return runRouteVerdict(rest);
      case 'route-outcome':
        return runRouteOutcome(rest);
      case 'validate-report':
        return runValidateReport(rest);
      case 'validate-verdict':
        return runValidateVerdict(rest);
      case 'write-report':
        return runWriteReport(rest);
      case 'write-verdict':
        return runWriteVerdict(rest);
      case 'verdict-acked':
        return runVerdictAcked(rest);
      case 'render-verdict':
        return runRenderVerdict(rest);
      case 'issue-store':
        // `issue-store` is async (Promise<number>) and cannot run inside this
        // sync `main()`. The async entrypoint `mainAsync()` intercepts it BEFORE
        // delegating here, so reaching this case means a caller invoked the sync
        // `main(['issue-store', ...])` path directly — route them to mainAsync.
        process.stderr.write(
          'error: issue-store is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
        );
        return 2;
      case 'host-pr':
        // Same as `issue-store`: `host-pr` is async (it does host I/O), so
        // `mainAsync` intercepts it first. Reaching here = a direct sync call.
        process.stderr.write(
          'error: host-pr is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
        );
        return 2;
    }
  }

  // Unknown subcommand: token looks like a keyword, not a file path.
  if (looksLikeSubcommand(first)) {
    process.stderr.write(
      `unknown subcommand: ${first}; available: ${KNOWN_SUBCOMMANDS.join(', ')}\n`,
    );
    return 2;
  }

  // Legacy positional form: first arg is the issue path directly.
  return runDor(argv);
}

/**
 * Async entrypoint. `main()` is sync (`: number`) but the `issue-store`
 * subcommand is async (`runIssueStore` returns `Promise<number>`). This wrapper
 * is the only place that can `await` it: it routes `issue-store` to its async
 * runner and delegates every other (sync) subcommand to `main()`.
 *
 * The two async runners are called inside a try/catch (FOR-11): `runIssueStore`
 * resolves its own store BEFORE its op-dispatch try/catch (issue-store-cli.ts),
 * so a store-construction failure (bad config, network failure standing up the
 * tracker API client) there would otherwise escape as an unhandled rejection —
 * `mainAsync` must never reject, only ever resolve to a number, so every caller
 * (the direct-run block below, a skill's own `await mainAsync(...)`) gets a
 * deterministic non-zero exit instead of depending on the runtime's unhandled-
 * rejection default.
 */
export async function mainAsync(
  argv: string[] = process.argv.slice(2),
  injected?: IssueStore,
): Promise<number> {
  try {
    if (argv[0] === 'issue-store') {
      return await runIssueStore(argv.slice(1), injected);
    }
    // `host-pr` (ADR-0023) is async host I/O — same interception as issue-store.
    // It takes no IssueStore: landing talks to the code HOST, not the tracker.
    if (argv[0] === 'host-pr') {
      return await runHostPr(argv.slice(1));
    }
    // `dor --id <id>` is the store-backed (async) form; bare `dor <path>...`
    // stays in the sync `main()`. The `--id` flag is the disambiguator (ADR-0014).
    if (argv[0] === 'dor' && argv.includes('--id')) {
      return await runDorById(argv.slice(1), injected);
    }
    // `conflict-map --id <id> [...]` is the store-backed (async) form — the same
    // ADR-0014 disambiguator as `dor --id`: bare `conflict-map <path>...` stays
    // in the sync `main()`; `--id` routes to the async store reader (which also
    // rejects a path mixed with `--id`).
    if (argv[0] === 'conflict-map' && argv.includes('--id')) {
      return await runConflictMapById(argv.slice(1), injected);
    }
    return main(argv);
  } catch (err) {
    process.stderr.write(
      `error: ${(err as Error).message ?? String(err)}\n`,
    );
    return 1;
  }
}

// Only execute when this file is run directly (not when imported by tests).
if (require.main === module) {
  mainAsync()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
      process.exit(1);
    });
}
