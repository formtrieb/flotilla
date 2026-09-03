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
 *   npx tsx tools/wave/src/cli.ts compose-driver --spine <spine> --out <path> --anchor <sha> [...]
 *   npx tsx tools/wave/src/cli.ts route-tuple --spine <spine> --id <id> --iter <n> --report <path> --verdict <path> --anchor <sha> [...]
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
 *                    --orphans further carries the Scribe scratch sweep (issue
 *                    #355) of `.flotilla/tmp` payload files, under
 *                    `orphans.scratch` — a plan under --dry-run, a full result
 *                    on the real run (issue #377). ONE plan object, computed
 *                    above the --dry-run branch and executed verbatim by the
 *                    real run; previously the sweep lived inside
 *                    executeOrphanSweep's one-shot, which --dry-run returns
 *                    before ever reaching, so a dry run was silent on this
 *                    population rather than clean. A payload removal that FAILS
 *                    forces exit 1 (issue #417), the same as every other
 *                    incomplete outcome above — it used to reach the JSON and
 *                    no exit code at all.
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
 *                    The containment root defaults to the marker-derived
 *                    worktrees root. A consumer whose agents make their scratch
 *                    checkouts elsewhere declares those roots in the wave
 *                    config's `cleanup.extraRoots` (issue #451) — no flag; the
 *                    key is read from --config and unioned with the
 *                    marker-derived roots. Undeclared, an out-of-root checkout
 *                    is left strictly alone (the conservative default).
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
 *                    unaccounted (issue #557) rides beside it on BOTH shapes,
 *                    under the same no-flag rule: { entries, level, notice },
 *                    naming every REGISTERED worktree that is neither the
 *                    primary checkout nor in any population this run enumerated
 *                    (GC, orphans, scratch, detached). It closes the state the
 *                    count could only hint at — counted, named by no list — and
 *                    an entry whose directory is already gone is marked
 *                    `prunable`. ADVISORY TOO (ADR-0042 Decision 3): a non-empty
 *                    `entries` NEVER contributes to the exit code.
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
 * compose-driver (issue #680) — composes the Workflow dispatch driver instead
 * of leaving a Coordinator to transcribe it. Reads the spine (every row in a
 * dispatchable state, with its branch/slug/iteration/model), the wave config
 * (the `engine.cli` binding, the store kind, the verify profile) and the store
 * (`read` + `triage-read` per row, unconditionally, at every compose), then
 * substitutes the five compose-time constants and the `ISSUES` array into the
 * SHIPPED driver template (`driver/wave-start-inflight.js`, a package asset
 * exactly as `hooks/` is) and writes the finished script to `--out` — the file
 * the harness's Workflow tool takes as its `scriptPath`. Prints one JSON
 * receipt: the rows composed, the model and branch per row, the anchor, the
 * Reviewer agent name and how it was derived, the template and its size.
 *
 * THE ENGINE STILL DISPATCHES NOTHING (ADR-0009). This verb writes a file; the
 * harness runs it; the schema-validated-return guarantee stays a property of
 * the driver script's own `agent({ schema })` calls. No agent-harness primitive
 * is called from engine code, here or anywhere.
 *
 * ASYNC (it resolves a store), so `mainAsync` intercepts it before the sync
 * `main()` router, like `issue-store` / `store-preflight`. Exit codes:
 *   0 — the script was written; the receipt is on stdout
 *   1 — a compose refusal (an unresolvable anchor, a human-gated or foreground
 *       row, a row with no recorded branch, an underivable Reviewer agent name,
 *       a missing required row field) or a store/domain failure
 *   2 — usage, an unreadable/invalid config, an unreadable spine, or a config
 *       with no `engine.cli` binding (a STOP — wave-setup has not finished)
 *
 * route-tuple (issue #681) — performs the whole post-return write-ahead
 * sequence for ONE returned tuple and prints one JSON result, in place of the
 * ten guarded shell calls the routing mechanics used to prescribe. In order:
 * the sidecar presence + validation check (recovering a missing record from the
 * passed `--report`/`--verdict` payload through the same renderer `write-report`
 * uses), the worker-phase route, the verdict-phase route, the verdict render,
 * find-before-create of the PR, the host status re-query, the two spine writes
 * (row state, PR cell), and the `in-review` rung transition. Every step reports
 * `performed` or `performed-before`, so a re-run on the same tuple is a
 * described no-op rather than a duplicate PR.
 *
 * Two things it deliberately does NOT do. **Disclosure capture stays a separate
 * call** — step 7.0a is judgment, and the Coordinator's own observation is the
 * one source no payload carries. **It never flags and never dispatches**: a
 * `stop` outcome is reported with its reason and performs no spine, host or
 * tracker write, and a re-dispatch writes the spine row state and the iteration
 * bump only.
 *
 * ASYNC (host I/O plus a resolved store), so `mainAsync` intercepts it before
 * the sync `main()` router, like `host-pr` / `issue-store` / `compose-driver`.
 * Exit codes:
 *   0 — the sequence completed; read `disposition` (`pr-created` |
 *       `re-dispatched` | `stop`). A `stop` is a ROUTED outcome, not a failure.
 *   1 — a refusal: an unrecoverable sidecar, a routing `noop` (a caller bug), a
 *       failed create, a refused reuse, a status re-query that found no PR, or a
 *       spine/tracker write that threw
 *   2 — usage, an unreadable/invalid config, or an unreadable spine
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
  // The Scribe scratch sweep (issue #355), imported as its list → plan →
  // execute TRIO rather than as the one-shot `sweepScribeScratch` the engine
  // folds into `executeOrphanSweep` (issue #377). Same reason the detached
  // sweep below is imported as a pair: the one-shot cannot preview, and this
  // verb's `--dry-run` branch returns before any execute — so while the sweep
  // lived inside that opaque call, a dry run was silent on the population, never
  // clean. The one-shot stays the programmatic form and rides the package-root
  // barrel for out-of-tree callers.
  listScribeScratchEntries,
  planScribeScratchSweep,
  executeScribeScratchSweep,
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
  // The SECOND E2BIG term (issue #266). The count advisory above models only
  // the harness-injected half of the exec argument budget; this one measures
  // the command line the spawn itself carries. Imported next to its sibling
  // because the whole point of the correction is that the two are read
  // together — a `worktreeCount` printed alone is the model that sent an
  // operator sweeping worktrees for a megabyte-of-argv failure.
  checkCommandLineSizeAdvisory,
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
  // Cycle-avoidance stays the default here; ADR-0037 is only a narrow engine-adapter exception, which this edge is not.
  compareEngineVersion,
  engineVersionExitCode,
} from './cli-store';
import { runResume } from './resume-cli';
import { runComposeDriver } from './compose-driver';
import { runRouteTuple } from './route-tuple';
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
  'compose-driver',
  'route-tuple',
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

/**
 * A one-line purpose per subcommand (issue #650) — printed on the unknown-
 * subcommand path below, alongside the pre-existing `available: <list>` line,
 * so the first misgrip a stranger's Coordinator makes (a plausible spelling —
 * `transition` for `spine set-row-state`, `close` for `closed-by`,
 * `conflict-map` for `cross-wave`) gets an answer instead of a bare word to
 * re-guess from. Typed as `Record<Subcommand, string>` — the SAME union
 * `KNOWN_SUBCOMMANDS` derives — so a subcommand added to one without the other
 * is a compile error: this table cannot drift from the router's own dispatch.
 */
const SUBCOMMAND_PURPOSE: Readonly<Record<Subcommand, string>> = {
  dor: 'Run the DOR-Gate validator against one or more issues (default when no subcommand is given).',
  'files-drift':
    'Detect same-project vs cross-project file drift for a wave issue against a sha-range.',
  'merge-order': 'Compute the recommended merge order for a wave from its WAVE.md spine.',
  'closed-by': 'Classify a `Closed-by:` line into { class, needsPin }.',
  'detect-host': 'Parse a git remote URL into { host, workspace, repo }.',
  'host-pr':
    'Open, arm, merge or probe a pull request on the code host (create|arm|merge|status|preflight).',
  'worktree-cleanup': 'List, plan, and (unless --dry-run) remove pushed-and-clean agent worktrees.',
  'conflict-map': 'Compute the file-overlap conflict matrix across a set of issues.',
  'cross-wave': 'Check whether a candidate batch is parallel-safe against an already-claimed batch.',
  'issue-store': 'Run one IssueStore operation — create, read, transition, close, and the goal facet ops.',
  spine: 'Read or mutate the WAVE.md orchestration spine (Plan-Table, disclosures, the human lane).',
  config: 'Validate a wave.config.json file.',
  resume: 'Reconcile a wave spine against live worktrees, reports and verdicts after an interruption.',
  'store-preflight': 'Probe the configured tracker for the preconditions wave-setup requires.',
  'credential-probe':
    'Check whether every configured credential can be resolved right now (ADR-0029).',
  'compose-driver':
    'Compose the Workflow dispatch driver from the spine, the config and the store, and write it to --out.',
  'route-tuple':
    'Perform the whole post-return sequence for one returned tuple — sidecar check, routing, verdict render, create-or-reuse, status re-query, spine writes, rung transition — and print one result.',
  'route-verdict': 'Route a reviewer verdict + iteration + risk to its state-machine event.',
  'route-outcome': 'Route a worker outcome + state to its state-machine event.',
  'validate-report': 'Validate a WorkerReport JSON file against its schema.',
  'validate-verdict': 'Validate a ReviewerVerdict JSON file against its schema.',
  'write-report': 'Validate a WorkerReport and persist it as its sidecar file.',
  'write-verdict': 'Validate a ReviewerVerdict and persist it as its sidecar file.',
  'verdict-acked': 'Derive the close --acked AC indexes from the final verdict sidecar for an id.',
  'render-verdict':
    'Render the Reviewer-verdict PR-body section from the final verdict sidecar for an id.',
  version: 'Print the engine package version, optionally checked against --expect (ADR-0032).',
};

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
      // Every line below carries an inline OUTPUT-FORMAT note (issue #505 —
      // the `dor`-prints-text surprise class: five sibling verbs print JSON,
      // and nothing said which of the others didn't) — text/JSON/nothing, so a
      // caller knows how to consume a verb's stdout without probing it first.
      '  flotilla-engine <issue-path> [<issue-path> ...]   # prints text (PASS/FAIL per issue), not JSON',
      '  flotilla-engine dor [--config <path>] <issue-path> [<issue-path> ...]   # prints text (PASS/FAIL + gate lines), not JSON',
      '  flotilla-engine dor --id <issue-id> [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore; prints text, same as the file form',
      '  flotilla-engine files-drift <issue-path> <sha-range>   # prints text, with a JSON block embedded at the end',
      '  flotilla-engine merge-order <wave-md-path>   # prints JSON',
      '  flotilla-engine closed-by <closed-by-line>   # prints JSON',
      '  flotilla-engine detect-host <remote-url>   # prints JSON',
      '  flotilla-engine worktree-cleanup (--dry-run | --wave <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [--detached] [...]   # prints JSON',
      '    --detached   also sweep REGISTERED detached-HEAD scratch checkouts under the worktrees root (the E2BIG population); --dry-run previews the same plan',
      '  flotilla-engine conflict-map <issue-path> [<issue-path> ...]   # prints JSON',
      '  flotilla-engine conflict-map --id <issue-id> [--id <id> ...] [--repo-root <dir>] [--config <path>]   # non-file: read from the IssueStore; prints JSON',
      '  flotilla-engine cross-wave --candidates <path> --claimed <path> [--repo-root <dir>]   # prints JSON',
      '  flotilla-engine host-pr <create|arm|merge|status|preflight> --branch <b> [--remote <url>] [--method <m>]   # prints JSON on every verb (see `host-pr <verb>`\'s own usage error for that verb\'s contract)',
      '  flotilla-engine issue-store <op> [...args] [--config <path>]   # per-op output — most read ops print JSON, create/publishDocument print the plain id as text, several mutation ops print nothing on success (see `issue-store <op>`\'s own usage error for that op\'s contract)',
      // This ONE line must name every op spine-cli's own dispatch table reports
      // — cli.spec.ts's FOR-11 guard reads the first `flotilla-engine spine `
      // line and asserts each real op appears in it. Detail lines may follow.
      '  flotilla-engine spine <create|read|set-row-state|set-row-iter|set-row-pr|set-branch|replace-closed-by|set-status|add-disclosure|set-disposition|check-disclosures|human-gated|check-awaiting-human> <spine-path> [...args]   # per-op output — mostly JSON on reads; several write ops print nothing or a bare id/ref on success',
      '    spine add-disclosure <spine-path> <row-id> --iter <n> --source <worker|reviewer|coordinator> --text <t>   # ADR-0027: capture at verdict-routing',
      '    spine add-disclosure <spine-path> --wave --source <worker|reviewer|coordinator> --text <t>   # ADR-0038: wave-scoped capture — no row, no iteration; the window runs to the archive',
      '    spine set-disposition <spine-path> <disclosure-ref> <resolved-in-slice|scope-extension|filed:ID|dropped:REASON>',
      '    spine check-disclosures <spine-path>   # fail-closed archive gate: exit != 0 iff an `open` disclosure remains',
      // The ADR-0012 human-lane pair. Dispatched by spine-cli's own table like
      // every other spine op (issue #366 folded them out of this file's `spine`
      // case), so the FOR-11 guard above already forces them onto the one-line
      // op list; these two lines add the per-op detail an operator needs.
      '    spine human-gated <spine-path> [--workers <a,b>]   # ADR-0012: list the wave\'s human lane (JSON); empty is a legitimate answer, never a gate',
      '    spine check-awaiting-human <spine-path> [--workers <a,b>]   # fail-closed archive gate: exit != 0 iff a human-gated row still holds a live claim',
      '  flotilla-engine config validate <path>   # prints text (a one-line ok/error message), not JSON',
      '  flotilla-engine resume --spine <path> --reports <dir> --verdicts <dir> [--repo-root <dir>] [--marker <m>] [--force]   # prints JSON',
      '  flotilla-engine store-preflight [--config <path>]   # prints JSON',
      '  flotilla-engine credential-probe (--all | --var <VAR> [--var <VAR> ...])   # ADR-0029: value-free auth probe — never prints a secret; prints JSON',
      '  flotilla-engine compose-driver --spine <spine> --out <path> --anchor <sha> [--config <path>] [--repo-root <dir>] [--reviewer-agent <name>] [--plugin-manifest <path>] [--coordinator-branch <b>] [--deps-setup <cmd>] [--row-meta <json|path>]   # writes the Workflow driver script to --out; prints a JSON receipt',
      '  flotilla-engine route-tuple --spine <spine> --id <id> --iter <n> --report <path> --verdict <path> --anchor <sha> [--config <path>] [--title <text>] [--repo-root <dir>] [--remote <url>] [--base <branch>] [--reports-dir <dir>] [--verdicts-dir <dir>]   # the whole post-return sequence for one row; prints one JSON result',
      '  flotilla-engine route-verdict --verdict <v> --iteration <1|2> --risk <r> --state <s>   # prints JSON',
      '  flotilla-engine route-outcome --outcome <o> --state <s>   # prints JSON',
      '  flotilla-engine validate-report <file>   # prints text ("valid"), not JSON',
      '  flotilla-engine validate-verdict <file>   # prints text ("valid"), not JSON',
      '  flotilla-engine write-report <json-file> --dir <reportsDir> --id <id> --iter <n>   # prints text (the written file path), not JSON',
      '  flotilla-engine write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>   # prints text (the written file path), not JSON',
      '  flotilla-engine verdict-acked <verdictsDir> <id>   # prints JSON',
      '  flotilla-engine render-verdict <verdictsDir> <id> --anchor <sha>   # prints text (the rendered markdown), not JSON',
      '  flotilla-engine version [--expect <plugin-version>]   # ADR-0032: the engine version, and the lockstep comparison (alias: --version); prints JSON',
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
  // can actually run instead of always deferring for "no config reached this
  // check". Absent (the pre-existing, still-supported form) → `verify` stays
  // undefined and Gate 8 defers exactly as before this fix — no behavior change
  // for the many existing bare `dor <path>...` call sites.
  //
  // issue #676: a config that DID load but carries no `verify` block at all
  // must NOT collapse back onto that same undefined-`verify` deferral — from
  // the operator's chair that reads as "you forgot --config" when --config
  // was right there. So a loaded config with no `verify` key is normalized to
  // an explicit `{ profiles: [] }` here rather than left `undefined`: Gate 8
  // already treats that shape as "a config loaded; it declares zero
  // profiles" (see `NOTE_VERIFY_PROFILES_EMPTY` in dor-gate.ts) — `verify`
  // stays `undefined` after this block ONLY when `--config` itself was never
  // supplied, which is exactly the case that deferral should name.
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
      verify = loadWaveConfig(configPath).verify ?? { profiles: [] };
    } catch (err) {
      process.stderr.write(
        `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  // Gate 9 (the staleness advisory) needs no threading here at all, and that is
  // deliberate rather than an omission: on this path the row's tracker-update
  // instant IS the issue file's own mtime, which `validateIssue` reads from the
  // `issuePath` it already receives. The `ValidateOptions.trackerUpdatedAt`
  // override exists for a caller that holds a better answer; the CLI does not,
  // so it passes none.
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
  // always deferring with "no config reached this check" — the gate
  // previously had no way to see `--config` at all. Loaded independently of
  // `resolveStore` above (which only surfaces the config to build the STORE,
  // not to the caller) so this stays a one-line addition rather than a
  // `resolveStore` signature change reaching into cli-store.ts (out of this
  // slice's declared Files). Absent `--config` (the pre-existing form, and
  // every test that passes an `injected` store without one) leaves `verify`
  // undefined — Gate 8 defers exactly as before this fix.
  //
  // issue #676: same normalization as `runDor` above — a config that DID
  // load but carries no `verify` block at all is coerced to `{ profiles: [] }`
  // rather than left `undefined`, so Gate 8 can tell "no config reached this
  // check" (still genuinely `verify === undefined`, only when `--config`
  // itself was never passed) apart from "a config loaded and declares zero
  // profiles" (`NOTE_VERIFY_PROFILES_EMPTY` in dor-gate.ts).
  const configPath = flag(args, '--config');
  let verify: VerifyConfig | undefined;
  if (configPath !== undefined) {
    try {
      verify = loadWaveConfig(configPath).verify ?? { profiles: [] };
    } catch (err) {
      process.stderr.write(
        `error: could not load --config ${configPath}: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  // Gate 9 (the staleness advisory) is threaded by the CONTRACT, not by an
  // option: the `since` it measures from rides on `IssueView.trackerUpdatedAt`,
  // which `store.read(id)` above already populated (or deliberately left absent,
  // in which case the gate `defer`s rather than passing). `--repo-root` is what
  // turns it on, the same flag the other working-tree gates key off.
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
        'usage: flotilla-engine files-drift <issue-path> <sha-range>   # prints text, with a JSON block embedded at the end',
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
      // notInPlay covers two reasons a row is excluded above, listed here
      // instead of silently dropped: (FOR-15) never dispatched — still
      // `planned`, no branch, no PR; and (ADR-0022, issue #636) `parked` — a
      // row deliberately taken out of THIS wave, held before dispatch
      // (`planned → parked`) or released at a STOP (`failed → parked`). A
      // parked row's missing branch is the correct, expected shape, not a
      // dispatch-log gap to go chase. warnings carries the DIFFERENT case
      // that IS a gap to chase: the `.scratch` NN-glob fallback on the
      // MarkdownFs path, and (issue #141) an in-play (never parked, never
      // never-dispatched) row whose branch could not be recovered on the
      // spine-self-contained path. The two keys are what let a reader tell
      // "genuinely has/needs no branch" (notInPlay) from "I could not find
      // its branch" (warnings) — see MergeOrderResult.
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
        'usage: flotilla-engine merge-order <wave-md-path>   # prints JSON',
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
        'usage: flotilla-engine closed-by <closed-by-line>   # prints JSON',
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
        'usage: flotilla-engine detect-host <remote-url>   # prints JSON',
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
 * `cleanup?.extraRoots` (issue #451) is threaded off the SAME single load, into
 * `listDetachedScratchpadWorktrees` — the detached sweep's ADDITIONAL
 * containment roots, absolute or repo-root-relative, unioned with the
 * marker-derived ones. The engine option had documented itself as the way to
 * declare such a root since the sweep landed, but nothing read it from config,
 * so the CONFIGURED path (this verb, which is what wave-close phase 3 runs)
 * could not declare one at all: an out-of-root detached scratch checkout stayed
 * registered forever, counted by `worktreeCount` and selected by nothing. Same
 * fail-loud stance as its sibling above — a malformed declaration is refused by
 * `loadWaveConfig` and surfaces here as exit 1. NO new flag: config-only
 * threading is the precedent this verb already set for `disposableNames`, and
 * the usage line below is unchanged because nothing about the CLI's argument
 * vocabulary is. Absent a declaration, the roots are exactly the marker-derived
 * ones — an out-of-root checkout is left strictly alone, byte-identical to
 * before the key existed.
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
 * `--orphans` also carries the Scribe scratch sweep (issue #355) under
 * `orphans.scratch`, on BOTH shapes (issue #377): the ScratchSweepPlan
 * (`dir`, `present`, `selected`, `skipped`) under `--dry-run`, the
 * ScratchSweepResult (`dir`, `present`, `removed`, `skipped`, `errors`) on the
 * real run. ONE plan object, computed above the `--dry-run` branch and executed
 * verbatim by the real run — so a preview reporting nothing selected is
 * followed by a run that removes nothing, structurally rather than by
 * agreement. Previously the sweep was reached only through
 * `executeOrphanSweep`'s internal one-shot, which the dry-run branch returns
 * before ever calling: a dry run was documented to be SILENT on this
 * population, never clean.
 *
 * A non-empty `orphans.scratch.errors` on the real run drives exit 1 (issue
 * #417), like every other incomplete-outcome class: a payload removal that
 * failed used to reach this JSON and no exit code at all, because the verdict
 * read `orphans.errors` (orphan DIRECTORIES only) and never the sweep's own
 * list one level down. `--dry-run` is unaffected — a plan has no `errors`.
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
 * `unaccounted` (issue #557, ADR-0042) is printed beside it on BOTH shapes and
 * under the same unconditional no-flag rule: `{ entries, level, notice }`, with
 * each entry naming `path`, `branch` and `prunable`. It answers the one question
 * the pair above could not: `worktreeCount` counts EVERY registration, but a
 * worktree outside every containment root is named by no sweep list at all —
 * `detached.selected` and `detached.skipped` both empty while the count includes
 * it — and the only remedy on offer was a documented hand-diff of the count
 * against the union of every array in this JSON. Measured live at a wave close
 * (a Reviewer's probe checkout in a per-session harness scratchpad, which
 * `cleanup.extraRoots` structurally cannot name because the path changes every
 * session). The reconciliation is computed by the engine, off the SAME
 * `git worktree list` read that produced `count`, from the population paths this
 * function hands it — so the count and the accounting cannot answer about two
 * different moments.
 *
 * WHICH paths are declared accounted, and why the GC LISTING rather than the GC
 * plan: `plan.selected`/`plan.skipped` drop every worktree outside an active
 * `--wave`/`--branches` filter, so accounting against them would report a
 * SIBLING wave's live worktree as unaccounted — it is in the GC population, just
 * out of this run's scope. The listing (`worktrees`) is the population; the plan
 * is this run's slice of it. Orphan directories and Scribe scratch payloads
 * cannot intersect the registered set by construction (an orphan is precisely a
 * directory git has forgotten; a payload is a file), but both are declared
 * anyway so the accounting states the whole union rather than relying on that
 * disjointness holding forever.
 *
 * A population this run did NOT enumerate (no `--detached`, no `--orphans`)
 * accounts for nothing, and its members therefore land in `unaccounted` — which
 * is the honest answer, not a defect: "this run named nothing here" is exactly
 * what the field reports, and the notice names `--detached` + `cleanup.extraRoots`
 * as the remedy where one applies.
 *
 * ADVISORY, NEVER A FAILURE (ADR-0042 Decision 3): `unaccounted` contributes no
 * term to `anyFailure` below. The set has a legitimate PERMANENT inhabitant — a
 * human's own long-lived second worktree — so a red close would push exactly the
 * wrong fix. Per ADR-0035 this is an additive report key on a shipped exit
 * contract, and the exit contract itself does not move.
 *
 * `commandLine` (issue #266) rides beside it on both shapes, under the same
 * unconditional rule: `{ bytes, argvBytes, envBytes, argCount, envCount,
 * threshold, maxEntryBytes, maxEntryThreshold, level, advisory }` from
 * `checkCommandLineSizeAdvisory`, again with the engine's text verbatim and
 * non-null exactly when `level` is `'advisory'`.
 * `maxEntryBytes`/`maxEntryThreshold` (issue #340's PER-STRING condition,
 * surfaced by issue #377) are the sibling pair of `bytes`/`threshold` for
 * execve's OTHER independent E2BIG condition — added purely additively, with no
 * existing key renamed, retyped or re-pointed. They were the one part of the
 * measurement the CLI withheld: the per-string verdict already reached an
 * operator folded into `level` and stated in the `advisory` prose, while the two
 * numbers behind it were not machine-readable from this JSON at all.
 * It is the OTHER term of the same exec argument budget — the command line this
 * spawn carries — and it is printed here precisely because the count alone
 * misled once: the live occurrence blew the budget with ~1019.5 KB across 3
 * args while only 15 of 166 sandbox deny paths were worktree-derived, so the
 * sweep this verb performs would have moved nothing. Advisory too, on the same
 * grounds, and likewise never part of the exit code.
 *
 * Idempotent: a re-run after everything is cleaned reports an empty plan and
 * exits 0 (nothing selected → nothing removed).
 *
 * Exit codes:
 *   0 — success (incl. nothing-to-do)
 *   1 — a removal error, a deregistered-but-not-deleted directory, an
 *       errored-yet-still-listed worktree (FOR-73) — from the registered GC OR
 *       (issue #238) from the `--detached` sweep, which rides the same three
 *       classes — an orphan-sweep removal error, or (issue #417) a
 *       Scribe-scratch payload-removal error under `orphans.scratch.errors`
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
          'usage: flotilla-engine worktree-cleanup [<repo-root>] [--dry-run] [--wave <spine>] [--branches <b1,b2>] [--orphans] [--detached] [--config <path>]   # prints JSON',
          '',
        ].join('\n'),
      );
      return 2;
    }
    positional.push(a);
  }
  const repoRoot =
    positional.length > 0 ? resolve(positional[0]) : process.cwd();

  // The consumer's cleanup declarations (issue #184 — the last-mile wiring gap
  // left by issue #115 — and issue #451 for `extraRoots`): `loadWaveConfig`
  // already validates BOTH keys at config-load time (the engine's own
  // `normalizeDisposableNames` for the names, the config layer's own
  // path-shaped rule for the roots), so a bad declaration fails loud here
  // rather than being silently narrowed. Absent --config (the pre-existing
  // form) leaves both undefined — every entry point below already treats that
  // as a no-op.
  //
  // ONE load, both keys read off it: a second `loadWaveConfig` call for the
  // second key would parse and re-validate the same file twice and could report
  // its failure twice, which is how one config error turns into two confusing
  // messages.
  const configPath = flag(args, '--config');
  let disposableNames: readonly string[] | undefined;
  let extraRoots: readonly string[] | undefined;
  if (configPath !== undefined) {
    try {
      const cleanup = loadWaveConfig(configPath).cleanup;
      disposableNames = cleanup?.disposableNames;
      extraRoots = cleanup?.extraRoots;
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

    // The Scribe scratch sweep (issue #355) rides the SAME `--orphans` flag and
    // reports under the SAME `orphans` key — but its plan is computed HERE,
    // above the `--dry-run` branch, for exactly the reason `detachedPlan` below
    // is (issue #377). It used to be reached one level down, inside
    // `executeOrphanSweep`, which folds in the one-shot `sweepScribeScratch` —
    // list, plan and remove inside a single opaque call. A caller cannot see,
    // print, or share the plan that call makes, and the `--dry-run` branch
    // returns BEFORE any execute, so a dry run neither previewed nor swept this
    // population: it was silent on it, never clean. Unfolding the one-shot into
    // its list → plan → execute parts is the same move the detached sweep
    // already made, and it buys the same structural guarantee — preview and
    // execution cannot disagree, because there is only one plan to disagree
    // about.
    //
    // Read BEFORE any removal, like `worktreeCount` below, and harmlessly so:
    // the Scribe scratch directory is a repo path (`.flotilla/tmp`) disjoint by
    // construction from every worktrees root this verb sweeps, so no removal
    // below can change what this listing saw.
    const scratchPlan = orphans
      ? planScribeScratchSweep(listScribeScratchEntries(repoRoot))
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
    //
    // `extraRoots` (issue #451) is the consumer's own containment-root
    // declaration, read from `cleanup.extraRoots` above. It reaches the sweep
    // HERE and nowhere else, which is exactly right: it widens only the
    // CONTAINMENT test of this one population — the registered GC and the
    // orphan-directory sweep both key on the marker-derived roots and their
    // name prefixes, and neither is in scope for a declared scratch root.
    // Because this is the single plan both branches below share, a declaration
    // reaches the preview and the real run by construction, never by two
    // agreeing reads. Undeclared (`undefined`) leaves the roots exactly as the
    // markers derived them — the conservative default, byte-identical to
    // before the key existed.
    const alreadyPlanned = new Set(
      [...plan.selected, ...plan.skipped].map((wt) => wt.path),
    );
    const detachedPlan = detached
      ? planDetachedScratchpadSweep(
          listDetachedScratchpadWorktrees({
            repoRoot,
            disposableNames,
            extraRoots,
          }).filter((wt) => !alreadyPlanned.has(wt.path)),
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
    //
    // `accountedPaths` (issue #557) turns the same call into the count-vs-lists
    // reconciliation as well — see this function's doc comment for why the GC
    // LISTING (`worktrees`) is declared rather than `plan.selected`/`skipped`,
    // and why a population this run did not enumerate legitimately accounts for
    // nothing. Every population computed above is folded in here, in one place,
    // so a future population that forgets to join this union shows up as a
    // WRONGLY-unaccounted entry (loud) rather than as a silently-missing one.
    const accountedPaths = [
      ...worktrees.map((wt) => wt.path),
      ...(orphanPlan !== null
        ? [...orphanPlan.selected, ...orphanPlan.skipped].map((o) => o.path)
        : []),
      ...(scratchPlan !== null
        ? [...scratchPlan.selected, ...scratchPlan.skipped].map((e) => e.path)
        : []),
      ...(detachedPlan !== null
        ? [...detachedPlan.selected, ...detachedPlan.skipped].map((wt) => wt.path)
        : []),
    ];
    const countAdvisory = checkWorktreeCountAdvisory({ repoRoot, accountedPaths });
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

    // The count-vs-lists reconciliation (issue #557), printed as `worktreeCount`'s
    // sibling under the same no-flag-to-remember rule and with `notice` carrying
    // the engine's TEXT verbatim — the same engine-owns-the-wording boundary
    // `worktreeCount.advisory` observes. `entries` is the machine-readable half
    // (`path`, `branch`, `prunable` per entry) so a reader never re-derives the
    // finding from the prose, and `level` is the verdict `notice` is non-null for.
    //
    // The `?? ` fallbacks are unreachable in this verb — `accountedPaths` is
    // always passed above, so the engine always reconciles — and exist only so
    // the shape is total for the type checker rather than asserted non-null.
    const unaccounted = {
      entries: countAdvisory.unaccounted?.entries ?? [],
      level: countAdvisory.unaccounted?.level ?? 'ok',
      notice: countAdvisory.unaccounted?.notice ?? null,
    };

    // The SECOND E2BIG term (issue #266), printed as `worktreeCount`'s sibling
    // on both output shapes and under the same no-flag-to-remember rule. The
    // count above proxies only the harness-injected half of the exec argument
    // budget; this measures the command line THIS spawn carries (argv + env),
    // which the live occurrence proved can blow the budget on its own — ~1019.5
    // KB across 3 args with only 15 of 166 deny paths worktree-derived, fixed
    // by compressing the argument and by no sweep at all. Reporting the two
    // terms side by side is what stops an operator reading a clean `count` as
    // an E2BIG all-clear, and what makes visible that this verb's own work
    // moves exactly one of them.
    //
    // Measured from `process.argv`/`process.env` — a real, first-hand
    // observation of the exec that is running, not an estimate: the env half is
    // what EVERY sibling spawn in this session also pays. Byte counts only; the
    // engine never returns an argument or a variable's name or value, so
    // nothing here can leak one into the JSON.
    const cmdlineAdvisory = checkCommandLineSizeAdvisory();
    // `advisory` carries `CommandLineSizeAdvisory.message` VERBATIM, exactly as
    // `worktreeCount.advisory` does — same engine-owns-the-wording boundary.
    const commandLine = {
      bytes: cmdlineAdvisory.bytes,
      argvBytes: cmdlineAdvisory.argvBytes,
      envBytes: cmdlineAdvisory.envBytes,
      argCount: cmdlineAdvisory.argCount,
      envCount: cmdlineAdvisory.envCount,
      threshold: cmdlineAdvisory.threshold,
      // The PER-STRING term's two numbers (issue #340's second condition,
      // surfaced here by issue #377). PURELY ADDITIVE: every key above keeps its
      // name, its type and its meaning — `bytes`/`threshold` are still the TOTAL
      // pair, and nothing is re-pointed at the per-string term.
      //
      // Without them the CLI printed the per-string VERDICT — folded into
      // `level`, and stated in the verbatim `advisory` prose — while withholding
      // the two numbers a machine reader needs to act on it. That is the same
      // "ships the correction's premise, withholds the correction" shape the
      // barrel gap (issue #357) closed one layer up, recurring at the CLI
      // boundary. `maxEntryBytes` is the single LARGEST argv/env entry;
      // `maxEntryThreshold` is the effective MAX_ARG_STRLEN budget it was
      // compared against — the exact sibling of `bytes`/`threshold` for execve's
      // OTHER, independent E2BIG condition, which fires on its own even when the
      // total sits comfortably under budget.
      //
      // Byte counts only, like every number beside them: the engine never
      // returns an argument or a variable's name or value, so nothing here can
      // leak one into the JSON.
      maxEntryBytes: cmdlineAdvisory.maxEntryBytes,
      maxEntryThreshold: cmdlineAdvisory.maxEntryThreshold,
      level: cmdlineAdvisory.level,
      advisory: cmdlineAdvisory.message,
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
                    // The SAME `scratchPlan` object the real run hands to
                    // `executeScribeScratchSweep` (issue #377) — the preview
                    // this branch used to omit entirely. Carried WHOLE,
                    // `dir`/`present` included, so "did not look" and "looked
                    // and found nothing" stay as distinguishable in the preview
                    // as they already are in the result.
                    ...(scratchPlan !== null ? { scratch: scratchPlan } : {}),
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
            // Printed on the PREVIEW too, and identical to the real run's own
            // (issue #557): the reconciliation is read BEFORE any removal, from
            // the same plans both branches share, so a `--dry-run` never hides a
            // population the run would then report.
            unaccounted,
            commandLine,
          },
          null,
          2,
        ) + '\n',
      );
      return 0;
    }

    const result = executeCleanup(plan, { repoRoot, disposableNames });
    // `executeOrphanSweep` is called WITHOUT `repoRoot` on purpose (issue #377).
    // That option has exactly ONE effect inside the engine — it gates the
    // one-shot Scribe-scratch fold — and this CLI now owns that sweep as an
    // explicit plan-then-execute pair so the `--dry-run` branch above can
    // preview it. Re-adding `repoRoot` here would run the scratch sweep TWICE:
    // the engine's own pass would delete the payloads, and the explicit pass
    // below would then fail to remove files that are already gone, filling
    // `orphans.scratch.errors` with removals that in fact succeeded. Nothing
    // else in `executeOrphanSweep` reads it — the orphan-DIRECTORY removals work
    // off the absolute paths the plan already carries.
    const orphanResult = orphanPlan !== null ? executeOrphanSweep(orphanPlan) : null;

    // Execute EXACTLY the `scratchPlan` object the `--dry-run` branch prints
    // (issue #377) — no options needed, because a plan entry already carries its
    // absolute path. Reported under `orphans.scratch`: the same key, and the
    // same whole-result shape, the engine produced while it folded the sweep in
    // itself. Additive to the orphan-DIRECTORY numbers and never merged into
    // them — a `not-a-scribe-payload` skip read as an orphan-directory skip
    // would be actively misleading, the same reasoning that keeps the detached
    // sweep under its own key.
    const scratchResult =
      scratchPlan !== null ? executeScribeScratchSweep(scratchPlan) : null;

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
          // The orphan-DIRECTORY result plus the Scribe scratch sweep's own
          // whole result under `orphans.scratch` (issue #377) — the same key,
          // in the same place, that `executeOrphanSweep`'s internal fold used to
          // put it; only the plan it executed is now the one the `--dry-run`
          // branch above printed.
          ...(orphanResult !== null
            ? {
                orphans: {
                  ...orphanResult,
                  ...(scratchResult !== null ? { scratch: scratchResult } : {}),
                },
              }
            : {}),
          // The detached sweep's own CleanupResult, reported whole (removed /
          // skipped-with-reason / errors / both ENOTEMPTY-family classes) under
          // its own key rather than merged into the registered-GC numbers: the
          // populations answer different questions, and a `live-branch` skip
          // read as a GC skip would be actively misleading.
          ...(detachedResult !== null ? { detached: detachedResult } : {}),
          worktreeCount,
          // Issue #557 — the same object the `--dry-run` branch above printed,
          // computed once from the pre-removal plans. It is what a reader
          // reconciles `worktreeCount.count` against instead of hand-diffing the
          // count against the union of every array in this JSON.
          unaccounted,
          commandLine,
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
    //
    // `orphans.scratch.errors` is IN this list (issue #417) — a failed
    // Scribe-payload removal is exactly as incomplete an outcome as a failed
    // directory removal, and now exits 1 like every other class here. It was
    // outside the list for a structural reason, not a deliberate one: the
    // scratch sweep used to sit INSIDE `executeOrphanSweep`, whose own `errors`
    // field carries orphan DIRECTORIES only, so its errors sat one level down
    // under `orphans.scratch` and no term of this verdict ever read them. The
    // verb therefore printed the failure and exited 0 — the operator (or the
    // close ceremony) branching on the exit status saw nothing, while the
    // payload was still on disk. Issue #377 surfaced the sweep's plan to
    // `--dry-run`, which changes what is PREVIEWED and never what the verb
    // exits with, and left this to its own row precisely because it IS a
    // behaviour change to the exit contract. `--dry-run` stays unaffected: it
    // returns above, and a ScratchSweepPlan has no `errors` field at all.
    //
    // `unaccounted` is deliberately NOT a term here (issue #557, ADR-0042
    // Decision 3), and its absence is a decision rather than an oversight. Every
    // class in this expression is something this run TRIED and did not finish;
    // an unaccounted worktree is something no sweep ever owned. The set also has
    // a legitimate PERMANENT inhabitant — a human's own long-lived second
    // worktree — so a red close over it would push exactly the wrong fix
    // (putting a human workspace under containment to silence the alarm). Per
    // ADR-0035 an additive report key is one thing and a new failure condition
    // on a shipped exit contract is another. Same standing as `worktreeCount`
    // and `commandLine`: reported loudly, never fatal.
    const anyFailure =
      result.errors.length > 0 ||
      result.deregisteredNotDeleted.length > 0 ||
      result.erroredStillListed.length > 0 ||
      (orphanResult !== null && orphanResult.errors.length > 0) ||
      (scratchResult !== null && scratchResult.errors.length > 0) ||
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
        'usage: flotilla-engine verdict-acked <verdictsDir> <id>   # prints JSON',
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
        'usage: flotilla-engine render-verdict <verdictsDir> <id> --anchor <sha>   # prints text (the rendered markdown), not JSON',
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
        // A PURE forward: every `spine` op — the human lane (`human-gated`,
        // `check-awaiting-human`) included — is dispatched by spine-cli's own
        // table. Those two briefly lived HERE instead, because the slice that
        // added them had this file in its declared scope and `spine-cli.ts`
        // outside it; issue #366 folded them home as the pure move that comment
        // promised (same args, same JSON, same exit codes). Nothing is
        // intercepted on the way through, so there is exactly ONE spine dispatch
        // table and `spine-cli.ts`'s direct-run block — which forwards to this
        // very case — reaches all of it.
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
      case 'compose-driver':
        // Same again: `compose-driver` re-reads every dispatchable row through
        // `issue-store read` / `triage-read` (the recompose-refetch rule, now
        // the verb's own behaviour rather than a Coordinator discipline), so it
        // resolves a store and is async. `mainAsync` intercepts it first.
        process.stderr.write(
          'error: compose-driver is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
        );
        return 2;
      case 'route-tuple':
        // Same again, twice over: `route-tuple` does host I/O (find-before-
        // create, the status re-query) AND resolves a store (the `in-review`
        // rung transition), so it is async on both counts. `mainAsync`
        // intercepts it first; reaching this case means a caller invoked the
        // sync `main(['route-tuple', ...])` path directly.
        process.stderr.write(
          'error: route-tuple is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
        );
        return 2;
    }
  }

  // Unknown subcommand: token looks like a keyword, not a file path.
  //
  // Issue #650 — the first misgrip a stranger's Coordinator makes. The
  // original one-line `available: <list>` message survives BYTE-FOR-BYTE
  // (cli.spec.ts's FOR-11 guard parses it at runtime); what is NEW is the
  // block below it — one line per KNOWN_SUBCOMMANDS entry paired with its
  // SUBCOMMAND_PURPOSE, so a plausible-but-wrong spelling gets the whole verb
  // roster with a reason to pick each one, not just a comma-separated list of
  // bare names to re-guess from.
  if (looksLikeSubcommand(first)) {
    process.stderr.write(
      [
        `unknown subcommand: ${first}; available: ${KNOWN_SUBCOMMANDS.join(', ')}`,
        '',
        'available subcommands:',
        ...KNOWN_SUBCOMMANDS.map((cmd) => `  ${cmd}  ${SUBCOMMAND_PURPOSE[cmd]}`),
        '',
      ].join('\n'),
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
    // `compose-driver` resolves a store — it re-reads every dispatchable row
    // through `read`/`readTriage` at every compose, unconditionally — so it is
    // async and intercepted here, exactly like `store-preflight` above. The
    // interception bypasses `main()`'s zero-arg guard, so the runner owns that
    // case itself: a bare `compose-driver` has no meaningful default —
    // --spine/--out/--anchor are all required — and its own usage names all
    // three, which is a better answer than the router's whole-CLI usage dump.
    if (argv[0] === 'compose-driver') {
      return await runComposeDriver(argv.slice(1), injected);
    }
    // `route-tuple` is async twice over — it talks to the code HOST
    // (find-before-create, the status re-query) and it resolves a store (the
    // `in-review` rung transition) — so it is intercepted here like
    // `compose-driver` above. The interception bypasses `main()`'s zero-arg
    // guard, which is deliberate: a bare `route-tuple` has six required flags
    // and the runner's own usage names all six, which teaches far better than
    // the router's whole-CLI dump.
    if (argv[0] === 'route-tuple') {
      return await runRouteTuple(argv.slice(1), injected ? { store: injected } : {});
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
