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
 *   npx tsx tools/wave/src/cli.ts worktree-cleanup (--dry-run | --wave <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [--detached] [...]
 *   npx tsx tools/wave/src/cli.ts resume --spine <path> --reports <dir> --verdicts <dir> [...]
 *   npx tsx tools/wave/src/cli.ts store-preflight [--config <path>]
 *   npx tsx tools/wave/src/cli.ts credential-probe (--all | --var <VAR> [--var <VAR> ...])
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
 *                    branch are never deleted. `--dry-run` now previews this
 *                    branch plan too, under `orphanBranches` (issue #148) — the
 *                    same `planOrphanBranchSweep` the real run executes, so a
 *                    preview that reports nothing selected is no longer followed
 *                    by a real run that deletes branches it never showed.
 *
 *                    --detached (issue #238) adds the THIRD population: git-
 *                    REGISTERED worktrees under the worktrees root whose HEAD is
 *                    DETACHED — an agent's or reviewer's hand-made inspection
 *                    checkout. Neither pre-existing sweep can reach these: they
 *                    are registered (so the --orphans directory sweep never sees
 *                    them) and carry no `agent-`/`wf_` name prefix (so the
 *                    name-allowlisted GC filters them out), which is how they
 *                    accumulate until the harness's per-worktree sandbox-deny
 *                    profile outgrows the exec argument limit and every Bash
 *                    spawn dies with E2BIG. Reported under the `detached` key as
 *                    a full CleanupResult; a branch-bearing worktree in the same
 *                    root is skipped `live-branch` and NEVER removed (a branch
 *                    is where work is staked), a dirty one `dirty`, a locked one
 *                    `locked`. Dry-run parity is structural, not agreed: ONE
 *                    plan object is computed before the --dry-run branch, the
 *                    preview prints its selected/skipped and the real run hands
 *                    that same object to executeCleanup. Independent of the
 *                    --wave/--branches scoping (a detached worktree has no
 *                    branch to scope by) and de-duplicated against the
 *                    registered-GC plan so a detached `wf_*` worktree is never
 *                    removed twice.
 *
 *                    worktreeCount (issue #238) is printed on BOTH shapes,
 *                    unconditionally: { count, threshold, level, advisory } from
 *                    the engine's checkWorktreeCountAdvisory — `count` is the
 *                    registered-worktree population `git worktree list` reports
 *                    (primary checkout included), `threshold` the effective
 *                    WORKTREE_COUNT_ADVISORY_THRESHOLD, `level` 'ok'|'advisory',
 *                    and `advisory` the engine's advisory TEXT verbatim (non-
 *                    null exactly when level is 'advisory'). Read BEFORE any
 *                    removal, so a --dry-run and the real run report the same
 *                    starting population. ADVISORY, never a refusal — it never
 *                    affects the exit code.
 *
 *                    Optional branch-scoped filter (issue #77 — parallel-wave safety):
 *                      --wave <spine-path>  Read the WAVE.md spine and derive the
 *                                           branch set from its Plan-Table / dispatch-log
 *                                           (via readSpine → requireBranchesByIssueId —
 *                                           the spine reader, which recovers a branch
 *                                           under ANY ref name; issue #141). Only
 *                                           worktrees whose branch is in that set are
 *                                           selected. Parallel-safe: sibling waves'
 *                                           worktrees are never removed.
 *                      --branches <b1,b2>   Escape-hatch: a comma-separated list of
 *                                           branch names to restrict selection to.
 *                                           Prefer --wave; use --branches when no spine
 *                                           is available or for scripted overrides.
 *                    Either flag FAILS CLOSED (issue #141): if no branch can be
 *                    resolved the verb exits 2 having removed nothing, rather
 *                    than degrading to an unscoped sweep of every agent worktree
 *                    in the repo. A flag whose only job is to narrow must never
 *                    silently widen.
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
 *   0 — success (nothing to remove, or all selected removed cleanly). The
 *       worktreeCount advisory NEVER affects this — it is advisory by design.
 *   1 — completed with per-worktree removal errors (registered GC, --detached
 *       sweep, or --orphans sweep)
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
 * resume (issue #77 — the whole engine surface is one `<sub>` idiom) — the
 * store-free wave reconciler. Thin router to {@link runResume} (resume-cli.ts),
 * the SAME function that file's own direct-run block calls, so the router
 * spelling and the retained `npx tsx tools/wave/src/resume-cli.ts …` alias share
 * one implementation, one JSON output shape (`{ ...ResumeResult, cleanup }`) and
 * one set of exit codes. It stays on the SYNC path: resume resolves no
 * `IssueStore` — it reads only the spine, live worktrees and on-disk sidecars.
 * Exit codes:
 *   0 — success (ResumeResult + cleanup[] JSON on stdout)
 *   1 — domain failure during assembly/resume
 *   2 — missing required flag (--spine / --reports / --verdicts)
 *
 * store-preflight (issue #77) — the tracker-precondition probe `wave-setup`
 * runs. ASYNC (it resolves a store and talks to the tracker API seam), so
 * `mainAsync` intercepts it BEFORE the sync `main()` router — and before the
 * router's zero-arg guard, since a BARE `store-preflight` is legal and probes
 * against the default `wave.config.json`. Thin router to
 * {@link runStorePreflightSubcommand} (cli-store.ts), which only prepends the
 * `preflight` op token before delegating to the one runner the retained
 * `npx tsx tools/wave/src/cli-store.ts preflight …` alias also calls. Reports
 * TRACKER facts only — code-host posture is `host-pr preflight` (ADR-0023).
 * Exit codes:
 *   0 — every precondition passes (or is not-applicable)
 *   1 — a precondition FAILED loudly, or the probe/store-resolution threw
 *   2 — usage error, or an unreadable/invalid config
 *
 * credential-probe (ADR-0029 — the value-free auth preflight probe) — answers
 * "can every configured credential be resolved right now?" by running each
 * configured `<VAR>_CMD` through the ONE credential resolver and reporting by
 * exit code plus a value-free JSON summary. It replaces neither presence check
 * nor guesswork with a stronger form of either: after ADR-0029 the environment
 * carries the POINTER, so `[ -n "$GITHUB_TOKEN" ]` can be empty on a perfectly
 * configured machine, and running the `_CMD` value by hand is the one thing
 * Convention 8 forbids outright (its stdout IS the secret). Sync — the lookup
 * spawn is `spawnSync` — so it stays on the `main()` path. `--all` probes every
 * CONFIGURED credential the engine's own adapters read; `--var <VAR>` names one
 * explicitly (an out-of-tree adapter's credential, or an assertion that a
 * specific one MUST resolve — where not-configured is itself a failure). Wired
 * into wave-start step 4 and wave-close phase 2, where an AFK-hostile prompt
 * fires in the interactive session instead of mid-wave. See
 * credential-probe-cli.ts. Exit codes:
 *   0 — every probed credential resolved (or --all found none configured)
 *   1 — at least one probed credential failed to resolve
 *   2 — usage (no selection, unknown flag, stray positional)
 *
 * version (ADR-0032 — the plugin/engine lockstep gate's engine half) — prints
 * the ENGINE PACKAGE's own version as JSON, and, with `--expect <version>`,
 * compares it against a caller-supplied expectation. Resolves no store and
 * reads no config, so it is the one verb that answers on a machine where
 * nothing else is set up yet — which is precisely when a version skew has to be
 * findable. Sync, and exempt from the router's zero-arg guard: a BARE `version`
 * is its primary form, not a misinvocation. `--version` in the FIRST argv
 * position is accepted as an alias, because that is the spelling ADR-0032 and
 * the operator docs use and because the published `bin` shim deliberately
 * forwards every token to this router rather than growing a flag of its own.
 *
 * The DIVISION OF LABOUR is ADR-0032's and is the reason this verb takes the
 * expectation instead of finding it: the engine knows only its own version; the
 * expectation is the PLUGIN's version, which the Coordinator reads from the
 * plugin manifest at the skill's own resolution anchor (ADR-0031's full-clone
 * premise). The engine has no way to know which clone the running skills came
 * from, so it is told rather than guessing. Exit codes:
 *   0 — match, or a bare read with no expectation
 *   1 — mismatch, an unreadable engine version, or an unusable expectation —
 *       never a silent pass on a missing side
 *   2 — usage (an unknown flag, a stray positional, or a value-less --expect)
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
import { resolve, join } from 'node:path';
import { validateIssue, validateIssueView, type DorResult } from './dor-gate';
import { loadWaveConfig } from './wave-config';
import type { VerifyConfig } from './verify';
import { detectDrift, type DriftResult } from './files-drift';
import {
  computeMergeOrderFromSpine,
  type MergeOrderResult,
  type ComputeMergeOrderOptions,
} from './merge-order';
import { readSpine, requireBranchesByIssueId } from './wave-md-rw';
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
  planOrphanBranchSweep,
  executeOrphanBranchSweep,
  // The detached-HEAD scratchpad sweep + the worktree-count advisory (issue
  // #238). The sweep is deliberately imported as its list/plan PAIR rather than
  // as the one-shot `sweepDetachedScratchpadWorktrees`: the one-shot cannot
  // preview, and `--dry-run` parity here means the preview and the run share
  // ONE plan object, not two calls that happen to agree (see
  // `runWorktreeCleanup`). The one-shot stays the programmatic form and rides
  // the package-root barrel for out-of-tree callers.
  listDetachedScratchpadWorktrees,
  planDetachedScratchpadSweep,
  checkWorktreeCountAdvisory,
} from './worktree-cleanup';
import { runConflictMap, runConflictMapById } from './conflict-map-cli';
import { runCrossWave } from './cross-wave-cli';
import { runIssueStore } from './issue-store-cli';
import { runSpine } from './spine-cli';
import { runConfig } from './config-cli';
import { runCredentialProbe } from './credential-probe-cli';
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
import {
  resolveStore,
  runStorePreflightSubcommand,
  // ADR-0032 — the lockstep version surface. Imported from cli-store rather
  // than defined here on purpose: `store-preflight` reports the SAME comparison
  // as an advisory, and cli.ts already depends on cli-store (the reverse
  // direction would be a circular import). One comparison, two surfaces.
  compareEngineVersion,
  engineVersionExitCode,
} from './cli-store';
import { runResume } from './resume-cli';
import type { IssueStore } from './adapters/issue-store';
import { readSidecars, type SidecarReader } from './sidecar';
import { metAcIndexes, renderVerdictSection } from './reviewer-verdict-schema';

// NOTE (FOR-11 → issue #77): `resume` and `store-preflight` ARE in this list now.
//
// FOR-11 had removed the `resume` case because the reconciler was reachable both
// here and as `resume-cli.ts`, with nothing saying which was canonical — the
// two-entrypoint confusion the live gate flagged
// (docs/retros/2026-07-15-wire-contract.md, P-12). Issue #77 resolves the same
// gap the other way round, for a reason FOR-11 could not have: the engine is
// being packaged behind a SINGLE npm `bin`, so a verb that is not reachable as
// `{{wave-cli}} <sub>` is not shippable at all. This router is now the canonical
// spelling for the whole engine surface.
//
// P-12's actual objection — ambiguity — does not come back, because neither of
// these cases is a second implementation: `resume` calls `runResume`
// (resume-cli.ts) and `store-preflight` calls `runStorePreflightSubcommand`
// (cli-store.ts), the exact functions those modules' own direct-run blocks call.
// Those direct-module forms survive as documented ALIASES only because live
// skill call-sites still spell them that way (rewriting those docs is Workstream
// 2 of docs/plans/2026-07-26-plugin-beta-ship-plan.md); they route to one
// implementation with one output shape and one set of exit codes, so they cannot
// drift from the router.
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
  'resume',
  'store-preflight',
  'credential-probe',
  'route-verdict',
  'route-outcome',
  'validate-report',
  'validate-verdict',
  'write-report',
  'write-verdict',
  'verdict-acked',
  'render-verdict',
  'version',
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
      '  flotilla-engine <issue-path> [<issue-path> ...]',
      '  flotilla-engine dor [--config <path>] <issue-path> [<issue-path> ...]',
      '  flotilla-engine dor --id <issue-id> [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore',
      '  flotilla-engine files-drift <issue-path> <sha-range>',
      '  flotilla-engine merge-order <wave-md-path>',
      '  flotilla-engine closed-by <closed-by-line>',
      '  flotilla-engine detect-host <remote-url>',
      '  flotilla-engine worktree-cleanup (--dry-run | --wave <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [--detached] [...]',
      '    --detached   also sweep REGISTERED detached-HEAD scratch checkouts under the worktrees root (the E2BIG population); --dry-run previews the same plan',
      '  flotilla-engine conflict-map <issue-path> [<issue-path> ...]',
      '  flotilla-engine conflict-map --id <issue-id> [--id <id> ...] [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore',
      '  flotilla-engine cross-wave --candidates <path> --claimed <path> [--repo-root <dir>]',
      '  flotilla-engine issue-store <op> [...args] [--config <path>]',
      // This ONE line must name every op spine-cli's own dispatch table reports
      // — cli.spec.ts's FOR-11 guard reads the first `flotilla-engine spine `
      // line and asserts each real op appears in it. Detail lines may follow.
      '  flotilla-engine spine <create|read|set-row-state|set-row-iter|set-row-pr|set-branch|replace-closed-by|set-status|add-disclosure|set-disposition|check-disclosures> <spine-path> [...args]',
      '    spine add-disclosure <spine-path> <row-id> --iter <n> --source <worker|reviewer|coordinator> --text <t>   # ADR-0027: capture at verdict-routing',
      '    spine set-disposition <spine-path> <disclosure-ref> <resolved-in-slice|scope-extension|filed:ID|dropped:REASON>',
      '    spine check-disclosures <spine-path>   # fail-closed archive gate: exit != 0 iff an `open` disclosure remains',
      '  flotilla-engine config validate <path>',
      '  flotilla-engine resume --spine <path> --reports <dir> --verdicts <dir> [--repo-root <dir>] [--marker <m>] [--force]',
      '  flotilla-engine store-preflight [--config <path>]',
      '  flotilla-engine credential-probe (--all | --var <VAR> [--var <VAR> ...])   # ADR-0029: value-free auth probe — never prints a secret',
      '  flotilla-engine route-verdict --verdict <v> --iteration <1|2> --risk <r> --state <s>',
      '  flotilla-engine route-outcome --outcome <o> --state <s>',
      '  flotilla-engine validate-report <file>',
      '  flotilla-engine validate-verdict <file>',
      '  flotilla-engine write-report <json-file> --dir <reportsDir> --id <id> --iter <n>',
      '  flotilla-engine write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>',
      '  flotilla-engine verdict-acked <verdictsDir> <id>',
      '  flotilla-engine render-verdict <verdictsDir> <id> --anchor <sha>',
      '  flotilla-engine version [--expect <plugin-version>]   # ADR-0032: the engine version, and the lockstep comparison (alias: --version)',
      '',
      `available subcommands: ${KNOWN_SUBCOMMANDS.join(', ')}`,
      '',
      '  Every engine verb is reachable as a subcommand of THIS CLI. The direct',
      '  module invocations below still work as aliases and route to the very',
      '  same runners — prefer the subcommand form listed above:',
      '    npx tsx tools/wave/src/resume-cli.ts ...            -> the `resume` subcommand',
      '    npx tsx tools/wave/src/cli-store.ts preflight ...   -> the `store-preflight` subcommand',
      '    npx tsx tools/wave/src/spine-cli.ts <op> ...        -> the `spine` subcommand',
      '',
    ].join('\n'),
  );
}

function runDor(paths: string[]): number {
  // Optional `--config <path>` (FOR-151): threads the consumer's
  // wave.config.json `verify` block into Gate 8 (verify-profile-coverage) so it
  // can actually run instead of always deferring for "no verify config
  // supplied". Absent (the pre-existing, still-supported form) → `verify` stays
  // undefined and Gate 8 defers exactly as before this fix — no behavior change
  // for the many existing bare `dor <path>...` call sites.
  const filePaths = [...paths];
  let verify: VerifyConfig | undefined;
  const configIdx = filePaths.indexOf('--config');
  if (configIdx !== -1) {
    const configPath = filePaths[configIdx + 1];
    if (configPath === undefined) {
      process.stderr.write('error: dor --config requires a <path>\n');
      return 2;
    }
    filePaths.splice(configIdx, 2);
    try {
      verify = loadWaveConfig(configPath).verify;
    } catch (err) {
      process.stderr.write(
        `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  let anyFail = false;
  const outputs: string[] = [];

  for (const arg of filePaths) {
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
    const result = validateIssue({ repoRoot, issuePath, source, verify });
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

  // FOR-151: thread the consumer's wave.config.json `verify` block into
  // Gate 8 (verify-profile-coverage) so it can actually run instead of
  // always deferring with "No verify config supplied" — the gate previously
  // had no way to see `--config` at all. Loaded independently of
  // `resolveStore` above (which only surfaces the config to build the STORE,
  // not to the caller) so this stays a one-line addition rather than a
  // `resolveStore` signature change reaching into cli-store.ts (out of this
  // slice's declared Files). Absent `--config` (the pre-existing form, and
  // every test that passes an `injected` store without one) leaves `verify`
  // undefined — Gate 8 defers exactly as before this fix.
  const configPath = flag(args, '--config');
  let verify: VerifyConfig | undefined;
  if (configPath !== undefined) {
    try {
      verify = loadWaveConfig(configPath).verify;
    } catch (err) {
      process.stderr.write(
        `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  const result = validateIssueView(view, {
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(verify !== undefined ? { verify } : {}),
  });
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
        'usage: flotilla-engine files-drift <issue-path> <sha-range>',
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
      // branch resolution: the `.scratch` NN-glob fallback on the MarkdownFs
      // path, and (issue #141) an in-play row whose branch could not be
      // recovered on the spine-self-contained path. The two keys are what let a
      // reader tell "genuinely has no branch" (notInPlay) from "I could not
      // find its branch" (warnings) — see MergeOrderResult.
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
        'usage: flotilla-engine merge-order <wave-md-path>',
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
        'usage: flotilla-engine closed-by <closed-by-line>',
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
        'usage: flotilla-engine detect-host <remote-url>',
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
 * `--branches` flags. Returns `undefined` ONLY when neither flag is supplied
 * (global GC — the original behaviour). When either flag IS supplied it returns
 * a non-empty set or throws; it never returns `undefined`.
 *
 * `--wave <spine-path>` reads the WAVE.md spine through the spine reader
 * (`readSpine` + `requireBranchesByIssueId` in wave-md-rw.ts — the same reader
 * that resolves `PlanTableRow.branch` and that the resume join uses) and takes
 * the unique branch names off it. This is the preferred form: the caller passes
 * a spine, not a hand-maintained list.
 *
 * It deliberately does NOT go through `merge-order.ts`'s `parseWaveSpine`, which
 * is where it used to. That reader re-keys branches from the spine's row ids to
 * canonical issueIds via the `.scratch` footnote → issue-file bridge, so on a
 * tracker-backed wave — no `.scratch` tree, no footnotes, therefore no NN→issueId
 * map — every branch was dropped on the re-key and it returned `{}` for
 * conventionally- and unconventionally-named branches alike (issue #141;
 * measured, not inferred). `readSpine` keys by the row id verbatim, so nothing
 * is dropped.
 *
 * `--branches <b1,b2,...>` is the escape hatch: a caller-supplied comma-separated
 * list of branch names. Used when no spine is available or for scripted overrides.
 *
 * When both are supplied, `--wave` wins (it is the authoritative source); the
 * `--branches` value is merged in as an additive supplement.
 *
 * FAIL CLOSED (issue #141) — the load-bearing property. This function's ONE job
 * is to NARROW the cleanup scope, so it must never widen it. It used to end
 * `return filter.size > 0 ? filter : undefined`, and `undefined` downstream means
 * *no filter*: a command asked to clean exactly one wave's worktrees would clean
 * EVERY agent worktree in the repository, tearing down any sibling wave in
 * flight. That is the parallel-safety property the flag exists to provide,
 * inverted — and it is independent of any one parse bug, since ANY path that
 * leaves the set empty produces it. An empty filter is now an error.
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
    let source: string;
    try {
      source = readFileSync(absSpine, 'utf-8');
    } catch (err) {
      // Propagate as a usage error — the spine must be readable.
      throw new Error(
        `--wave: could not read spine "${absSpine}": ${(err as Error).message}`,
        { cause: err },
      );
    }
    try {
      // requireBranchesByIssueId, not the lenient accessor: a spine that
      // records dispatch-log entries yet yields no branch is a reader/writer
      // disagreement, and swallowing it here is precisely how the scoping flag
      // came to sweep a sibling wave's worktrees.
      for (const branch of Object.values(
        requireBranchesByIssueId(readSpine(source)),
      )) {
        if (branch) filter.add(branch);
      }
    } catch (err) {
      // Same refusal the empty-set guard below issues, reached earlier: the
      // reader itself already knows the spine is inconsistent. Both routes must
      // read alike — an operator should never have to tell "I could not scope"
      // from "nothing was in scope".
      throw new Error(
        `--wave: no branch scope could be derived from spine "${absSpine}" — ` +
          'refusing to fall back to an unscoped cleanup, which would select every ' +
          'agent worktree in the repository (including any sibling wave still in ' +
          `flight). Reader said: ${(err as Error).message}`,
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

  // Fail closed. A scoping flag WAS supplied (we returned `undefined` above
  // otherwise), so reaching here with an empty set means we cannot say which
  // worktrees are in scope — and `undefined` would answer that question with
  // "all of them". Refuse instead; the caller turns this into exit 2 having
  // removed nothing.
  if (filter.size === 0) {
    throw new Error(
      'branch scoping was requested but no branch could be resolved — refusing to ' +
        'fall back to an unscoped cleanup, which would select every agent worktree ' +
        'in the repository (including any sibling wave still in flight). ' +
        'Pass --branches <b1,b2> explicitly if you know the scope.',
    );
  }
  return filter;
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
 *                         dispatch-log (readSpine → requireBranchesByIssueId).
 *                         Only worktrees on those branches are selected.
 *   --branches <b1,b2>    Escape-hatch: comma-separated branch list.
 * Either flag fails closed (issue #141): an unresolvable scope is exit 2 with
 * nothing removed, never a fallback to the unscoped sweep.
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
 * Optional detached-scratchpad sweep (issue #238):
 *   --detached            Additionally sweep git-REGISTERED worktrees under the
 *                         worktrees root whose HEAD is DETACHED — the hand-made
 *                         inspection checkout neither pre-existing sweep can
 *                         reach (registered, so not an orphan DIRECTORY; no
 *                         `agent-`/`wf_` prefix, so filtered out of the
 *                         name-allowlisted GC). Reported under `detached`. A
 *                         branch-bearing worktree in the same root is skipped
 *                         `live-branch` and never removed. Independent of
 *                         --wave/--branches (a detached worktree has no branch
 *                         to scope by) and de-duplicated against the
 *                         registered-GC plan, so no worktree is removed twice.
 *
 * Preview/execute share ONE plan (issue #148): the orphan-branch half used to
 * be reachable only through `sweepOrphanBranches`, a single-shot plan-and-
 * delete the real run called and `--dry-run` never called at all — so
 * `--orphans --dry-run` reported nothing for branches, and the very next real
 * run could delete several with no preceding preview of that outcome. Both
 * paths now call the SAME `planOrphanBranchSweep`: `--dry-run` reports its
 * `toDelete`/`branchHygieneSkipped` under the new `orphanBranches` key and
 * deletes nothing; the real run recomputes that identical plan (necessarily
 * AFTER the orphan-DIRECTORY sweep below has run — a `worktree-wf_*` branch
 * only reads as eligible once its orphan worktree directory is actually gone
 * from disk) and executes EXACTLY it via `executeOrphanBranchSweep`, never a
 * second, independently-deciding derivation.
 *
 * Uniform-wrapper tolerance (FOR-87 — W25-F2): a Coordinator wrapper appends
 * `--config <path>` to every store-adjacent verb invocation uniformly — the
 * documented pattern every OTHER verb already tolerates. `worktree-cleanup` had
 * no case for it, so the config path silently bound as the <repo-root>
 * positional (a concatenated phantom path → a confusing ENOTDIR). `--config
 * <path>` is now accepted, same as `--wave`/`--branches` consume their value
 * token; it never reaches `positional`. Any OTHER unknown `--flag` is a hard
 * usage error (exit 2) naming the flag — never a silent positional.
 *
 * `--config` is no longer purely discarded (issue #184 — the last-mile wiring
 * gap left by issue #115): its file is loaded via `loadWaveConfig`, and
 * `cleanup?.disposableNames` is threaded into `listAgentWorktrees`,
 * `listOrphanDirs`, and `executeCleanup` below — the SAME consumer-declared
 * disposable-entry-name set `wave-config.ts` already validates at load time.
 * Before this wiring, a `wave-close` run driven by `--config` could never make
 * that declaration reach the plan; it only ever worked when a caller built the
 * engine functions directly and passed `disposableNames` itself. A load
 * failure (unreadable/invalid config) is a hard error (exit 1) rather than a
 * silent fall-through to "no extra names" — an operator who supplied a bad
 * `--config` should see why cleanup didn't honour it, not a quietly narrower
 * sweep. Absent `--config` (the pre-existing, still-supported form)
 * `disposableNames` stays `undefined` and every entry point below already
 * treats that as "no extra names" — no behavior change for existing bare
 * `worktree-cleanup` call sites.
 *
 * Prints the FULL engine summary so a run can never do work and show nothing
 * (FOR-67): removed/skipped/errors PLUS deregisteredNotDeleted (the ENOTEMPTY
 * class), erroredStillListed (FOR-73 — a throwing removal git still lists as
 * prunable), branchesDeleted, branchHygieneSkipped (both of which, with
 * --orphans, fold in the standalone orphaned-branch sweep — FOR-72), and (with
 * --orphans) orphans. `--dry-run --orphans` additionally prints
 * `orphanBranches: { toDelete, branchHygieneSkipped }` (issue #148) — the
 * branch-sweep preview the real run's branchesDeleted/branchHygieneSkipped
 * then fulfils. With `--detached`, `detached` carries the sweep's own plan
 * (dry-run) or full CleanupResult (real run), and its branch hygiene folds into
 * the same branchesDeleted / branchHygieneSkipped pair.
 *
 * `worktreeCount` (issue #238) is printed on BOTH shapes, unconditionally and
 * with no flag to remember: `{ count, threshold, level, advisory }` straight
 * from `checkWorktreeCountAdvisory`, with `advisory` carrying the engine's
 * advisory TEXT verbatim (the E2BIG shape, its subagent scope, and the
 * cleanup-plus-harness-RESTART recovery) and non-null exactly when `level` is
 * `'advisory'`. It is read BEFORE any removal, so the number a `--dry-run`
 * shows is the same starting population the real run reports. Purely advisory:
 * it never contributes to the exit code (the threshold is a heuristic about a
 * harness-side limit the engine cannot measure — see the engine constant).
 *
 * Idempotent: a re-run after everything is cleaned reports an empty plan and
 * exits 0 (nothing selected → nothing removed).
 *
 * Exit codes:
 *   0 — success (incl. nothing-to-do)
 *   1 — a removal error, a deregistered-but-not-deleted directory, an
 *       errored-yet-still-listed worktree (FOR-73) — from the registered GC OR
 *       (issue #238) from the `--detached` sweep, which rides the same three
 *       classes — or an orphan-sweep removal error
 *   2 — usage / unexpected error
 */
function runWorktreeCleanup(args: string[]): number {
  const dryRun = args.includes('--dry-run');
  const orphans = args.includes('--orphans');
  const detached = args.includes('--detached');
  // Positional args are those that don't start with '--' and are not values of
  // a known flag (--wave / --branches / --config consume the token after
  // them). `--config <path>` is accepted (FOR-87, W25-F2): every sibling verb
  // already tolerates the uniform Coordinator-wrapper flag, and without a case
  // for it here its value token fell through to `positional` (silently
  // binding as <repo-root> — a confusing ENOTDIR on a concatenated phantom
  // path). Its value is now actually loaded (issue #184 — see the doc comment
  // above this function), not merely consumed-and-discarded. Any OTHER
  // unknown `--flag` fails loud below — a flag-shaped token must never
  // silently bind as data.
  const noValueFlags = new Set(['--dry-run', '--orphans', '--detached']);
  const flagsWithValues = new Set(['--wave', '--branches', '--config']);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (flagsWithValues.has(a)) {
        i++; // consume the value token (--config's value is loaded below, issue #184)
        continue;
      }
      if (noValueFlags.has(a)) {
        continue;
      }
      process.stderr.write(
        [
          `error: worktree-cleanup: unknown flag ${a}`,
          'usage: flotilla-engine worktree-cleanup [<repo-root>] [--dry-run] [--wave <spine>] [--branches <b1,b2>] [--orphans] [--detached] [--config <path>]',
          '',
        ].join('\n'),
      );
      return 2;
    }
    positional.push(a);
  }
  const repoRoot =
    positional.length > 0 ? resolve(positional[0]) : process.cwd();

  // The consumer's cleanup.disposableNames declaration (issue #184 — the
  // last-mile wiring gap left by issue #115): `loadWaveConfig` already
  // validates the key at config-load time via the engine's own
  // `normalizeDisposableNames`, so a bad declaration fails loud here rather
  // than being silently narrowed to "no extra names". Absent --config
  // (the pre-existing form) leaves `disposableNames` undefined — every entry
  // point below already treats that as a no-op.
  const configPath = flag(args, '--config');
  let disposableNames: readonly string[] | undefined;
  if (configPath !== undefined) {
    try {
      disposableNames = loadWaveConfig(configPath).cleanup?.disposableNames;
    } catch (err) {
      process.stderr.write(
        `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  try {
    const branchFilter = resolveBranchFilter(args, repoRoot);
    const worktrees = listAgentWorktrees(repoRoot, undefined, disposableNames);
    const plan = planCleanup(worktrees, branchFilter);

    // The orphan sweep (FOR-67) is an additive, branch-filter-independent pass:
    // it sweeps directories under the worktrees root that `git worktree list`
    // does not know about at all (deregistered-but-not-deleted ENOTEMPTY
    // leftovers + empty leftovers from earlier waves). It is inherently
    // parallel-safe — a sibling wave's live worktree is REGISTERED, so it is
    // never seen as an orphan (--wave/--branches scoping of the registered
    // cleanup above is untouched).
    const orphanPlan = orphans
      ? planOrphanSweep(listOrphanDirs(repoRoot, { disposableNames }))
      : null;

    // Detached-HEAD scratchpad sweep (issue #238), gated on `--detached`. A
    // THIRD population, disjoint from neither of the two above by construction:
    // these worktrees ARE registered (so `listOrphanDirs` cannot see them) and
    // carry no `agent-`/`wf_` name prefix (so `listAgentWorktrees` filters them
    // out) — the accumulation that fed the live E2BIG incident.
    //
    // ONE PLAN, computed HERE — above the --dry-run branch — is the whole point
    // of this placement. `--dry-run` prints exactly this object's
    // `selected`/`skipped`, and the real run hands exactly this object to
    // `executeCleanup`. The orphan-BRANCH pair below still calls its planner
    // twice (unavoidably: a `worktree-wf_*` branch only reads as eligible AFTER
    // the orphan directories are physically gone), so its preview and its run
    // are two calls of one pure function. Here there is no such ordering
    // dependency, so the stronger form is available and is what ships: preview
    // and execution cannot disagree, because there is only one plan to disagree
    // about. This is also why the one-shot `sweepDetachedScratchpadWorktrees`
    // is NOT the CLI's entry point — it lists, plans and removes inside one
    // opaque call, and a caller cannot see, print, or share the plan it made.
    //
    // De-duplicated against the registered-GC plan above. Without a branch
    // filter, a `wf_*` dispatch worktree sitting on a DETACHED head qualifies
    // for BOTH populations, and the two `executeCleanup` calls below would then
    // remove it twice — the second attempt landing in `errors` for a worktree
    // that was correctly removed. Excluding anything the first plan already
    // accounted for (selected OR skipped) also keeps the report one-entry-per-
    // worktree instead of double-reporting the same path under two keys. With
    // `--wave`/`--branches` active the question does not arise: `planCleanup`
    // excludes every detached (branch: null) entry from both of its buckets, so
    // nothing is filtered out here and the detached sweep is the only reader.
    const alreadyPlanned = new Set(
      [...plan.selected, ...plan.skipped].map((wt) => wt.path),
    );
    const detachedPlan = detached
      ? planDetachedScratchpadSweep(
          listDetachedScratchpadWorktrees({ repoRoot, disposableNames }).filter(
            (wt) => !alreadyPlanned.has(wt.path),
          ),
        )
      : null;

    // Worktree-count advisory (issue #238) — the measurement half of the same
    // E2BIG hardening, surfaced unconditionally on BOTH output shapes. It is
    // deliberately not behind a flag: the engine's own rationale for the number
    // is that an advisory which only fires at the cliff is useless, and one you
    // have to remember to ask for is the same defect wearing a flag. Read here,
    // BEFORE any removal, so the number a `--dry-run` previews is the same
    // population the real run reports having started from (a post-sweep count
    // would silently answer a different question in each branch).
    const countAdvisory = checkWorktreeCountAdvisory({ repoRoot });
    // `advisory` carries `WorktreeCountAdvisory.message` VERBATIM — the engine
    // owns that wording (the E2BIG shape, the subagent scope, the
    // cleanup-plus-RESTART recovery), and this boundary never paraphrases it.
    // count/threshold/level ride alongside as their own named fields so a
    // consumer never has to re-derive the verdict from the prose.
    const worktreeCount = {
      count: countAdvisory.count,
      threshold: countAdvisory.threshold,
      level: countAdvisory.level,
      advisory: countAdvisory.message,
    };

    if (dryRun) {
      // Orphan-BRANCH preview (issue #148): planOrphanBranchSweep is the SAME
      // pure function the real run below executes via executeOrphanBranchSweep
      // — no separate, independently-deciding preview logic. Nothing is
      // deleted by a dry run, so this reads current on-disk state; the real
      // run recomputes this identical call AFTER physically removing orphan
      // directories first (see the comment below the real-run's own call),
      // so this preview reflects the branch sweep as it stands right now, one
      // directory-removal step short of the run it precedes — still the fix
      // for "dry-run shows nothing, real run deletes six": the branches a
      // remote-ref-gone or already-orphaned worktree-wf_* signal would sweep
      // are now named here instead of nowhere.
      const orphanBranchPlan = orphans ? planOrphanBranchSweep({ repoRoot }) : null;
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
            // The SAME plan object the real run executes (see its computation
            // above) — a preview that names `selected` here is a promise the
            // run below keeps by construction, not by agreement.
            ...(detachedPlan !== null
              ? {
                  detached: {
                    selected: detachedPlan.selected,
                    skipped: detachedPlan.skipped,
                  },
                }
              : {}),
            ...(orphanBranchPlan !== null
              ? {
                  orphanBranches: {
                    toDelete: orphanBranchPlan.toDelete,
                    branchHygieneSkipped: orphanBranchPlan.branchHygieneSkipped,
                  },
                }
              : {}),
            worktreeCount,
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    const result = executeCleanup(plan, { repoRoot, disposableNames });
    const orphanResult =
      orphanPlan !== null ? executeOrphanSweep(orphanPlan, { repoRoot }) : null;

    // Execute EXACTLY the `detachedPlan` object the `--dry-run` branch above
    // prints — same `executeCleanup` as every other removal path, so the
    // bounded retry, the incomplete-removal classification and local-branch
    // hygiene are inherited rather than reimplemented.
    const detachedResult =
      detachedPlan !== null
        ? executeCleanup(detachedPlan, { repoRoot, disposableNames })
        : null;

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
    //
    // Plan-then-execute explicitly (issue #148), mirroring the orphan-DIR
    // pair above and the --dry-run preview: planOrphanBranchSweep computes
    // the plan the SAME way the preview does, and executeOrphanBranchSweep
    // then executes EXACTLY that plan object — never the opaque single-shot
    // `sweepOrphanBranches`, whose internal plan a caller could not see or
    // share with a preview.
    const orphanBranchPlan = orphans ? planOrphanBranchSweep({ repoRoot }) : null;
    const orphanBranchResult =
      orphanBranchPlan !== null
        ? executeOrphanBranchSweep(orphanBranchPlan, { repoRoot })
        : null;
    // Every removal path's branch hygiene folds into ONE pair of fields, so a
    // run can never delete a branch and show nothing (the FOR-67 W15 finding).
    // The detached sweep goes through the same `executeCleanup`, so it produces
    // the same two classes and joins them here rather than growing a parallel
    // reporting key nobody reads.
    const branchesDeleted = [
      ...result.branchesDeleted,
      ...(detachedResult?.branchesDeleted ?? []),
      ...(orphanBranchResult?.branchesDeleted ?? []),
    ];
    const branchHygieneSkipped = [
      ...result.branchHygieneSkipped,
      ...(detachedResult?.branchHygieneSkipped ?? []),
      ...(orphanBranchResult?.branchHygieneSkipped ?? []),
    ];

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
          // The detached sweep's own CleanupResult, reported whole (removed /
          // skipped-with-reason / errors / both ENOTEMPTY-family classes) under
          // its own key rather than merged into the registered-GC numbers: the
          // populations answer different questions, and a `live-branch` skip
          // read as a GC skip would be actively misleading.
          ...(detachedResult !== null ? { detached: detachedResult } : {}),
          worktreeCount,
        },
        null,
        2,
      ) + '\n',
    );
    // Exit non-zero on any incomplete outcome a human/skill must notice: a
    // removal error, a deregistered-but-not-deleted directory (removal did not
    // fully complete), an errored-yet-still-listed worktree (FOR-73 — the
    // removal threw and git still lists it as prunable, a prune/retry case an
    // operator must see), or an orphan-sweep removal error. The detached sweep
    // rides the SAME three incomplete-outcome classes (it goes through the same
    // `executeCleanup`), so it must contribute to this verdict too — a sweep
    // whose removals errored while the verb still exited 0 is exactly the
    // silent-failure shape the class list above exists to prevent.
    const anyFailure =
      result.errors.length > 0 ||
      result.deregisteredNotDeleted.length > 0 ||
      result.erroredStillListed.length > 0 ||
      (orphanResult !== null && orphanResult.errors.length > 0) ||
      (detachedResult !== null &&
        (detachedResult.errors.length > 0 ||
          detachedResult.deregisteredNotDeleted.length > 0 ||
          detachedResult.erroredStillListed.length > 0));
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
        'usage: flotilla-engine verdict-acked <verdictsDir> <id>',
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
        'usage: flotilla-engine render-verdict <verdictsDir> <id> --anchor <sha>',
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
  // Thread the row's own id straight into the render: it is the close target,
  // so it passes through untouched, while every OTHER tracker-id-shaped token in
  // the Reviewer's evidence is neutralized (the mention footgun, wave-shared
  // Convention 4). The id is the same `<id>` argument this verb already resolved
  // the sidecar by — no new caller-side step at the wave-start terminator.
  process.stdout.write(
    renderVerdictSection(hit.verdict, {
      iteration: hit.iter,
      anchorSha,
      ownId: id,
    }) + '\n',
  );
  return 0;
}

/**
 * Run the `version` subcommand (ADR-0032) — a thin router to
 * {@link compareEngineVersion} / {@link engineVersionExitCode} (cli-store.ts),
 * the same pair `store-preflight --expect` reports as an advisory. The CLI adds
 * no comparison logic of its own; it only parses args and prints.
 *
 * Arg discipline is deliberately strict, and this is the load-bearing half of
 * the verb. A version gate is only worth having if it cannot be silently
 * disarmed by the invocation that was meant to arm it, so:
 *   - `--expect` with no value (or followed by another flag) is a USAGE ERROR,
 *     not "no expectation". `flag()` cannot tell those apart — a trailing
 *     `--expect` reads back `undefined`, byte-identical to the flag being
 *     absent — which is exactly the shape that turns a gate off when its input
 *     breaks (an unset shell variable, a `jq` miss);
 *   - an empty/whitespace-only expectation is refused for the same reason;
 *   - any other flag, and any stray positional, is a usage error rather than
 *     something quietly ignored.
 *
 * Prints the full {@link EngineVersionReport} as JSON, so a caller can read
 * `version` (AC: machine-readable, no store config needed), `match`, `outcome`
 * and the one-line `repair` without parsing prose.
 */
function runVersion(args: string[]): number {
  let expected: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--expect') {
      const value = args[i + 1];
      if (
        value === undefined ||
        value.startsWith('--') ||
        value.trim().length === 0
      ) {
        return versionUsage(
          '--expect requires a <plugin-version> value — a value-less --expect is a caller whose lookup produced nothing, not a request to skip the check',
        );
      }
      expected = value;
      i++;
      continue;
    }
    return versionUsage(
      a.startsWith('--')
        ? `unknown flag ${a}`
        : `unexpected argument "${a}" — version takes no positional arguments`,
    );
  }

  const report = compareEngineVersion(expected);
  printJson(report);
  return engineVersionExitCode(report);
}

function versionUsage(message: string): number {
  process.stderr.write(
    [
      `error: version: ${message}`,
      'usage: flotilla-engine version [--expect <plugin-version>]',
      '  Prints { version, expected, match, outcome, detail, repair } as JSON.',
      '  Resolves no store and reads no wave config.',
      '  Exit: 0 match / bare read; 1 mismatch, unreadable engine version, or',
      '  unusable expectation; 2 usage.',
      '',
    ].join('\n'),
  );
  return 2;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.length === 0) {
    printUsage();
    return 2;
  }

  const first = argv[0];

  // `--version` as a leading token is an ALIAS for the `version` subcommand
  // (ADR-0032). Handled before the KNOWN_SUBCOMMANDS lookup because a
  // flag-shaped token can never be a subcommand name, and before the
  // unknown-subcommand branch because `looksLikeSubcommand('--version')` is
  // true (no `/`, no `.`) — without this case the documented spelling would
  // come back "unknown subcommand: --version". The published `bin` shim
  // forwards argv verbatim and deliberately owns no flags of its own, so this
  // router is the only place the spelling can live.
  if (first === '--version') {
    return runVersion(argv.slice(1));
  }

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
    //
    // `version` is the ONE exemption (ADR-0032), and for the opposite reason
    // worktree-cleanup lost its: a bare `version` is that verb's PRIMARY form
    // ("what version is this engine?"), it performs no action at all, and it is
    // the invocation an operator reaches for when nothing else on the machine
    // is configured yet. Printing usage instead would make the verb unusable
    // exactly where it is needed most.
    if (rest.length === 0 && first !== 'version') {
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
      case 'credential-probe':
        // ADR-0029 — the value-free auth preflight probe. SYNC: the lookup
        // spawn is `spawnSync`, and it resolves no store, so it belongs here
        // rather than behind `mainAsync`'s async interceptions. A bare
        // `credential-probe` never reaches this case — the zero-arg guard above
        // prints usage first — and the runner has its own no-selection usage
        // path for `credential-probe --config x`.
        return runCredentialProbe(rest);
      case 'resume':
        // issue #77 — the store-free reconciler as a router subcommand. A thin
        // router to resume-cli.ts's `runResume` (with its real disk-backed
        // `defaultDeps`), i.e. byte-for-byte what the retained
        // `npx tsx tools/wave/src/resume-cli.ts …` alias runs: same JSON on
        // stdout, same 0/1/2 exit codes, same missing-flag usage. It belongs on
        // the SYNC path — unlike `dor --id` / `issue-store` it resolves no
        // IssueStore (it reads the spine, worktrees and sidecars only).
        return runResume(rest);
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
      case 'version':
        // ADR-0032 — the lockstep gate's engine half. Sync and store-free: it
        // reads only the engine package's own manifest, so it answers on a
        // machine where no wave config exists yet.
        return runVersion(rest);
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
      case 'store-preflight':
        // Same as `issue-store`/`host-pr`: the store-preflight resolves a store
        // and probes the tracker API seam, so it is async and `mainAsync`
        // intercepts it first. Reaching here = a direct sync call.
        process.stderr.write(
          'error: store-preflight is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
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
    // `store-preflight` (issue #77) resolves a store and probes the tracker API
    // seam, so it is async — same interception as issue-store. Intercepting it
    // HERE also (deliberately) bypasses `main()`'s zero-arg guard: a bare
    // `store-preflight` with no flags is a legal invocation that probes against
    // the default `wave.config.json`, exactly as a bare `cli-store.ts preflight`
    // does. The shim only prepends the `preflight` op token — one runner, so the
    // router spelling and the direct-module alias cannot drift.
    if (argv[0] === 'store-preflight') {
      return await runStorePreflightSubcommand(argv.slice(1), injected);
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
