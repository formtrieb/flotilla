#!/usr/bin/env node
/**
 * CLI entry for `/wave validate <issue-path>` + the `/wave close` deep-module
 * shell-outs (wo/59).
 *
 * Usage:
 *   npx tsx tools/wave/src/cli.ts <issue-path> [<issue-path> ...]
 *   npx tsx tools/wave/src/cli.ts dor <issue-path> [<issue-path> ...]
 *   npx tsx tools/wave/src/cli.ts files-drift <issue-path> <sha-range>
 *   npx tsx tools/wave/src/cli.ts merge-order (--spine <path> | <wave-md-path>)
 *   npx tsx tools/wave/src/cli.ts closed-by <closed-by-line>
 *   npx tsx tools/wave/src/cli.ts detect-host <remote-url>
 *   npx tsx tools/wave/src/cli.ts host-pr <create|arm|merge|status> --branch <b> [--remote <url>] [--method <m>] [--body <t> | --body-file <path>]
 *   npx tsx tools/wave/src/cli.ts worktree-cleanup (--dry-run | --spine <spine> | --branches <b1,b2> | <repo-root>) [--orphans] [--detached] [--probes-only] [...]
 *   npx tsx tools/wave/src/cli.ts resume --spine <path> --reports-dir <dir> --verdicts-dir <dir> [...]
 *   npx tsx tools/wave/src/cli.ts store-preflight [--config <path>]
 *   npx tsx tools/wave/src/cli.ts credential-probe (--all | --var <VAR> [--var <VAR> ...])
 *   npx tsx tools/wave/src/cli.ts compose-driver --spine <spine> --out <path> --anchor <sha> [...]
 *   npx tsx tools/wave/src/cli.ts route-tuple --spine <spine> --id <id> --iter <n> --report-file <path> --verdict-file <path> --anchor <sha> [--ruling <text>] [...]
 *   npx tsx tools/wave/src/cli.ts close-row --spine <spine> --id <id> [--pr-url <url>] [...]
 *   npx tsx tools/wave/src/cli.ts route-verdict --verdict <v> --iter <n> --risk <r> --state <s> [--ruling <text>]
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
 *                    branch are never deleted — but a branch in one of those two
 *                    swept shapes that a still-REGISTERED worktree holds is now
 *                    named under branchHygieneDeferred (issue #748) instead of
 *                    dropped silently at the safety floor: branch hygiene fires
 *                    on "worktree gone", so on a sandboxed harness the first
 *                    run's branch list is empty and the branches are PENDING,
 *                    not absent (measured: run 1 deleted none, the prescribed
 *                    manual recovery removed six worktrees, an identical run 2
 *                    deleted twelve). Accounting only, never a term in the exit
 *                    verdict. `--dry-run` now previews this
 *                    branch plan too, under `orphanBranches` (issue #148) — the
 *                    same `planOrphanBranchSweep` the real run executes, so a
 *                    preview that reports nothing selected is no longer followed
 *                    by a real run that deletes branches it never showed — and
 *                    that preview carries the deferrals beside the deletions.
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
 *                    --orphans finally carries the REVIEW-REF sweep (issue
 *                    #732), under `orphans.reviewRefs`: the refs a Reviewer
 *                    fetches a branch tip into — refs/review/<id>,
 *                    refs/review/sib/<id>, refs/review/base/<id> (the
 *                    landed-sibling check's default-branch tip, issue #978)
 *                    and refs/sib/<id> — which outlive the worktree, the
 *                    local branch and the remote branch alike, and
 *                    which no other pass here reaches (187 had accumulated in one
 *                    shared .git before a human swept them by hand). ONE plan
 *                    object again: a plan under --dry-run, a full result on the
 *                    real run. Scoped by the LIVE ROW IDS read off the same
 *                    --wave spine the branch filter comes from — a ref belonging
 *                    to a live row is never deleted (`live-row`), a ref name that
 *                    does not yield exactly one row-id segment is never guessed
 *                    at (`unresolvable-row`), and without a spine the sweep FAILS
 *                    CLOSED and removes nothing at all (`live-rows-unknown`).
 *                    Everything else is deleted and counted; a delete that FAILS
 *                    forces exit 1 like every other incomplete outcome, while the
 *                    three refusals never do. A wave whose EVERY row is terminal
 *                    ({@link TERMINAL_ROW_STATES}) now sweeps its OWN refs at its
 *                    own close (issue #748): before
 *                    it, every ref a wave produced belonged to one of its own
 *                    rows, so all of them read `live-row` and became sweepable
 *                    only at the NEXT wave's close. The verdict is WAVE-level,
 *                    never per-row — a per-row rule would sweep a finished
 *                    sibling's refs/sib ref from under a still-dispatched Worker
 *                    — and `liveRowIds` reports which of the three derivations
 *                    ran: the row ids on a live wave, [] on a terminal one, null
 *                    when no spine declared it.
 *                    --orphans lastly carries the COMPOSED-DRIVER sweep (issue
 *                    #748) under `orphans.drivers`: the per-wave `<slug>/`
 *                    DIRECTORY compose-driver writes its Workflow script into,
 *                    inside the same `.flotilla/tmp` root whose FILES the Scribe
 *                    sweep owns. That sweep's allowlist is on the payload name
 *                    and only ever removes a file, so the directory was reported
 *                    `not-a-scribe-payload` and swept by nothing, one per wave.
 *                    ONE plan object again. A directory goes only when its wave
 *                    is finished — the --wave spine terminal, or its spine
 *                    already in the archive location — and is otherwise skipped
 *                    `live-wave` or, when no spine answers for it at all,
 *                    `unknown-wave` (reported, never touched). A removal that
 *                    FAILS forces exit 1; both refusals never do.
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
 *                    probes (issue #961, ADR-0042 Amendment 2026-09-23) is the
 *                    SEVENTH population and needs NO flag, so every run prints
 *                    it: registered worktrees whose basename carries the stamp
 *                    `flotilla-probe-<wave-slug>-<row-id>-i<iteration>` — a
 *                    Reviewer's probe checkout, which must live OUTSIDE the
 *                    repository and so sits in no containment root; the stamp
 *                    stands in for one. The detached sweep's refusals apply
 *                    verbatim (locked, live-branch, orphan-with-real-files,
 *                    dirty); a probe that passes them is skipped `live-row`
 *                    while the --spine spine shows its row in a running state
 *                    (dispatched, re-dispatched, reviewing) at the stamp's own
 *                    iteration — or shows an Iter cell that is not a number,
 *                    which fails closed — and is removed otherwise (issue
 *                    #974: the spine never records `reviewing`, so the state
 *                    alone cannot decide). It is skipped `unknown-wave` —
 *                    named, never removed — when no declared wave-and-row pair
 *                    names it (every probe, without --spine). A plan on
 *                    --dry-run, a full CleanupResult on the run. An unstamped
 *                    out-of-root registration stays in `unaccounted`,
 *                    untouched.
 *                    --probes-only runs that population ALONE — the
 *                    Coordinator's call when it routes a round's verdicts —
 *                    and prints { dryRun, probesOnly, probes, worktreeCount,
 *                    commandLine }; it refuses --orphans, --detached and
 *                    --branches (exit 2).
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
 * requires --title plus EXACTLY ONE of --body <body> and --body-file <path>,
 * reads GITHUB_TOKEN from the env); arm/merge/status land it. `--body-file`
 * reads the body from a file verbatim and is the form to reach for whenever the
 * body is more than one paragraph — a multi-paragraph inline `--body` has been
 * refused in the field by an agent harness's worktree-isolation guard on a call
 * from an isolated worktree (not by every such guard, which is the trouble: the
 * caller cannot tell from inside), and a long quoted argument is a shell-quoting
 * hazard everywhere. Routed by detect-host (github only in M1; bitbucket/unknown
 * fail loud + typed for every verb). See host-pr-cli.ts. Exit codes:
 *   0 — create opened/reused the PR; arm/merge landed the row (merged | armed |
 *       already-merged); status probed
 *   1 — create failed (create-failed + fallbackPrefillUrl); not landed (no-pr |
 *       refused); no adapter for the host; or a host error
 *   2 — usage error — including create's body routes: --body and --body-file
 *       both given, neither given, or a --body-file path that cannot be read
 *
 * worktree-cleanup exit codes:
 *   0 — success (nothing to remove, or all selected removed cleanly). The
 *       worktreeCount advisory NEVER affects this — it is advisory by design.
 *   1 — completed with per-worktree removal errors (registered GC, --detached
 *       sweep, the stamped-probe sweep, or --orphans sweep), a failed
 *       Scribe-payload removal
 *       (orphans.scratch.errors, issue #417), a failed review-ref delete
 *       (orphans.reviewRefs.errors, issue #732), or a failed composed-driver
 *       directory removal (orphans.drivers.errors, issue #748). Every REFUSAL
 *       in this verb is accounting rather than an unfinished attempt and none
 *       of them affects this: the review-ref sweep's live-row,
 *       unresolvable-row and live-rows-unknown; the composed-driver sweep's
 *       live-wave and unknown-wave; the stamped-probe sweep's live-row and
 *       unknown-wave (issue #961); and branchHygieneDeferred, which names
 *       branches a live worktree is holding for the next run.
 *   2 — usage / unexpected error — including --probes-only combined with
 *       --orphans, --detached or --branches
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
 * `--reviewer-only` (issue #992) composes the re-review that follows an
 * answered `reviewer-questions-blocking`: each row carries its own report
 * sidecar at its current iteration, the script's Worker stage returns it
 * instead of dispatching a Worker, and its report Scribe stage is skipped. The
 * receipt's `mode` names which round the script runs.
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
 *       a missing required row field, or — under `--reviewer-only` — a row with
 *       no valid report sidecar at its iteration) or a store/domain failure
 *   2 — usage, an unreadable/invalid config, an unreadable spine, or a config
 *       with no `engine.cli` binding (a STOP — wave-setup has not finished)
 *
 * route-tuple (issue #681) — performs the whole post-return write-ahead
 * sequence for ONE returned tuple and prints one JSON result, in place of the
 * ten guarded shell calls the routing mechanics used to prescribe. In order:
 * the sidecar presence + validation check (recovering a missing record from the
 * passed `--report`/`--verdict` payload through the same renderer `write-report`
 * uses, and repairing a present one that disagrees with a valid payload — the
 * payload wins, a `warning:` names every differing field, and the step's
 * `repaired` lists it beside `recovered`), the worker-phase route, the verdict-phase route, the verdict render,
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
 * `--ruling "<the Operator's reason>"` admits the Operator-ruled, Reviewer-only
 * round that runs ABOVE the re-dispatch cap — the documented recovery from a
 * cap-exhaustion STOP. It is the only thing that opens an above-cap `--iter`
 * (without it that iteration stays refused, unchanged), and it reaches this verb
 * as well as the single `route-verdict` because this is the verb the ordinary
 * dispatch path runs. The result names the ruled cell and quotes the ruling, so
 * the round is auditable from the output. Cap accounting is untouched.
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
 * close-row — the done-reconcile for ONE merged row, in one call: it upserts the
 * row's `## PR-Log` line and its `## Closed-by` line (the two spine sections
 * `renderSpine` has always emitted and nothing ever wrote), derives the met-AC
 * indexes from the MAX-iter valid verdict sidecar through the same derivation
 * `verdict-acked` prints, and then calls the store's `close(id, prUrl, acked)`.
 * Both spine writes precede the tracker write, because the spine is the WAL a
 * resume reconstructs from. It replaces a twelve-line shell program — a capture,
 * its Convention-12 guard, a `node -e` parse and a hand-written `issue-store
 * close --acked` — that was carried as prose in two skills at once.
 *
 * It does NOT decide whether the PR merged: the evidence hierarchy (ADR-0023)
 * stays with the caller. Its own refusal is mechanical — the PR cell must
 * classify as a real PR URL under the `closed-by` classifier.
 *
 * ASYNC (it resolves a store), so `mainAsync` intercepts it before the sync
 * `main()` router, like `route-tuple` / `compose-driver`. Exit codes:
 *   0 — the row was landed; read `closing.state` (a state still reading `open`
 *       is the documented non-failing outcome `issue-store close` also has, and
 *       the same `STILL OPEN:` line says so on stderr)
 *   1 — a spine section it must write into is absent, or a spine/tracker write
 *       threw
 *   2 — usage, an unreadable config or spine, an unknown row id, or a PR cell
 *       that is not a real PR URL. Nothing is written on any of them.
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
import { resolve, join, basename, dirname } from 'node:path';
import {
  validateIssue,
  validateIssueView,
  type BlockerResolution,
  type DorResult,
} from './dor-gate';
import { loadWaveConfig } from './wave-config';
import { DISPOSITION_VOCABULARY } from './spine-store';
import type { VerifyConfig } from './verify';
import { detectDrift, type DriftResult } from './files-drift';
import {
  computeMergeOrderFromSpine,
  type MergeOrderResult,
  type ComputeMergeOrderOptions,
} from './merge-order';
import { readSpine, requireBranchesByIssueId, TERMINAL_ROW_STATES } from './wave-md-rw';
import { classifyClosedBy, needsPin } from './closed-by';
import { detectHost } from './host-pr';
import { runHostPr, HOST_PR_CONTRACTS } from './host-pr-cli';
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
  // The review-ref sweep (issue #732) — imported as its list → plan → execute
  // TRIO for the same reason the Scribe-scratch and detached sweeps above are,
  // and never as the one-shot `sweepReviewRefs`: a one-shot's plan is not
  // observable from outside, and this verb's `--dry-run` branch returns before
  // any execute, so an unpreviewable population would be one a dry run is silent
  // on rather than clean on. The one-shot stays the programmatic form and rides
  // the package-root barrel for out-of-tree callers.
  listReviewRefs,
  planReviewRefSweep,
  executeReviewRefSweep,
  // The composed-driver sweep (issue #748) — imported as the same list → plan
  // → execute trio, for the identical reason, and never as the one-shot
  // `sweepComposedDrivers`. This population is held to the issue #377 discipline
  // from its first line: ONE plan object, computed above the `--dry-run` branch,
  // printed by the preview and executed verbatim by the real run.
  listComposedDriverDirs,
  planComposedDriverSweep,
  executeComposedDriverSweep,
  // The stamped-probe sweep (issue #961) — imported as its list/plan PAIR for
  // the detached sweep's reason, never as the one-shot `sweepStampedProbes`:
  // ONE plan object, printed by the preview and handed verbatim to the same
  // `executeCleanup` every other registered population uses.
  listStampedProbeWorktrees,
  planStampedProbeSweep,
  type StampedProbeSpine,
} from './worktree-cleanup';
import { runConflictMap, runConflictMapById, CONFLICT_MAP_CONTRACT } from './conflict-map-cli';
import { runCrossWave, CROSS_WAVE_CONTRACT } from './cross-wave-cli';
import { runIssueStore, ISSUE_STORE_CONTRACTS } from './issue-store-cli';
import { runSpine, SPINE_CONTRACTS } from './spine-cli';
import { runConfig, CONFIG_CONTRACTS } from './config-cli';
import { runCredentialProbe, CREDENTIAL_PROBE_CONTRACT } from './credential-probe-cli';
import {
  runRouteVerdict,
  runRouteOutcome,
  runValidateReport,
  runValidateVerdict,
  runWriteReport,
  runWriteVerdict,
  ROUTE_CONTRACTS,
} from './route-cli';
import { findScratchRoot } from './find-repo-root';
import { flag, printJson } from './cli-utils';
import {
  defineVerb,
  hasFlag,
  helpRequested,
  positionalsOf,
  printVerbHelp,
  refuseUndeclared,
  renderInvocations,
  resolveTwin,
  type Catalog,
  type OutputClass,
  type VerbContract,
} from './verb-contract';
import {
  resolveStore,
  runStorePreflightSubcommand,
  STORE_PREFLIGHT_CONTRACT,
  // ADR-0032 — the lockstep version surface. Imported from cli-store rather
  // than defined here on purpose: `store-preflight` reports the SAME comparison
  // as an advisory, and cli.ts already depends on cli-store (the reverse
  // direction would be a circular import). One comparison, two surfaces.
  // Cycle-avoidance stays the default here; ADR-0037 is only a narrow engine-adapter exception, which this edge is not.
  compareEngineVersion,
  engineVersionExitCode,
} from './cli-store';
import { runResume, RESUME_CONTRACT } from './resume-cli';
import { runComposeDriver, COMPOSE_DRIVER_CONTRACT } from './compose-driver';
import { runRouteTuple, ROUTE_TUPLE_CONTRACT } from './route-tuple';
import { runCloseRow, CLOSE_ROW_CONTRACT } from './close-row';
import type { IssueStore } from './adapters/issue-store';
import type { IssueRef } from './contract';
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
  'close-row',
  'route-verdict',
  'route-outcome',
  'validate-report',
  'validate-verdict',
  'write-report',
  'write-verdict',
  'verdict-acked',
  'render-verdict',
  'version',
  'catalog',
] as const;
type Subcommand = (typeof KNOWN_SUBCOMMANDS)[number];

/**
 * The verbs whose BARE invocation IS their primary form, and which therefore
 * keep an exemption from the router's zero-argument guard (issue #758).
 *
 * Both are store-free engine INTROSPECTION and neither has an argument that
 * could be missing: `version` answers "what version is this engine?" (ADR-0032)
 * and `catalog` answers "what does it accept?" (ADR-0051's Catalog). Neither
 * performs an action, and both are reached for exactly where nothing else on
 * the machine is configured yet — printing usage instead would make them
 * unusable there. Every OTHER verb names a target, so a bare call to one of
 * those is a caller who left it out, and the focused usage is the answer.
 */
const BARE_FORM_VERBS: ReadonlySet<Subcommand> = new Set<Subcommand>(['version', 'catalog']);

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
    'Open, arm, merge or probe a pull request on the code host (create|arm|merge|status|preflight); create takes its body inline (--body) or from a file (--body-file).',
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
  'close-row':
    "Land one merged row: upsert its PR-Log and Closed-by lines, derive the met-AC indexes from its final verdict, then close it on the tracker.",
  'route-verdict':
    'Route a reviewer verdict + iteration + risk to its state-machine event; --ruling <text> is the Operator ruling that alone admits an iteration above the re-dispatch cap.',
  'route-outcome': 'Route a worker outcome + state to its state-machine event.',
  'validate-report': 'Validate a WorkerReport JSON file against its schema.',
  'validate-verdict': 'Validate a ReviewerVerdict JSON file against its schema.',
  'write-report': 'Validate a WorkerReport and persist it as its sidecar file.',
  'write-verdict': 'Validate a ReviewerVerdict and persist it as its sidecar file.',
  'verdict-acked': 'Derive the close --acked AC indexes from the final verdict sidecar for an id.',
  'render-verdict':
    'Render the Reviewer-verdict PR-body section from the final verdict sidecar for an id.',
  version: 'Print the engine package version, optionally checked against --expect (ADR-0032).',
  catalog:
    'Print the Catalog — every Verb contract the router collects, as JSON (ADR-0051).',
};

// ─── `--json` on this file's two prose verbs (ADR-0051 decision 7, row V5) ───
//
// **ONE table, two readers** — the same discipline `RECEIPT_SHAPES` established
// one module over (spine-cli.ts): the shape advertised by `--help` and by every
// refusal is rendered from the SAME constant the runner builds its answer to, so
// an advertised shape and an emitted shape cannot drift. The half a caller
// cannot see until it has already made the call is the emitted one, which is
// exactly why the advertised one may not be a hand-transcribed copy of it.
//
// `--json` REPLACES the prose; it never rides beside it. Without the flag both
// verbs print today's bytes, and neither one's exit code moves either way — a
// failing readiness gate still exits 1, with its JSON.

/** The shape `dor --json` prints, in BOTH of the verb's forms. */
const DOR_JSON_SHAPE =
  '{ verb, overall, issues: [ { issue, overall, gates: [ { name, status, reason? } ] } ] }';

/**
 * The shape `files-drift --json` prints: the block this verb has ALWAYS embedded
 * at the end of its prose, and nothing else. `--json` adds no field and renames
 * none — it only drops the human framing around a block that was already there,
 * which is why this verb needed no new decision of its own (row V1 declared it).
 */
const FILES_DRIFT_JSON_SHAPE = '{ status, driftedFiles, rationale, projectScopes }';

// ─── The output shapes of THIS module's `json`-class verbs (issue #913) ──────
//
// Every verb whose whole stdout is JSON declares the shape of that JSON, in the
// same notation the receipt clauses above already use, and `--help` renders it
// under `shape:`. Each was read off the verb's own EMITTER and then confirmed by
// running the verb, never off a TypeScript return type: the printers below build
// object literals with conditional spreads, so the keys a run actually carries
// are not the keys an interface declares. Where the two disagreed, the printed
// form won and the disagreement is named in place.

/**
 * One entry of every merge-order list, as `renderMergeOrder`'s `projectPr`
 * builds it — the projection, not `MergeOrderResult`'s own row type.
 *
 * `title` and `prUrl` are spread conditionally (`prUrl` also drops on `null`),
 * so both keys are genuinely ABSENT rather than `undefined` on a row that has
 * neither. Confirmed live against `__fixtures__/minimal-spine.md`, whose single
 * row prints `{ issueId, nn, fileCount, branch, title }` and no `prUrl`.
 */
const MERGE_ORDER_ENTRY_SHAPE = '{ issueId, nn, fileCount, branch, title?, prUrl? }';

/**
 * The shape `merge-order` prints (issue #913 — the verb this row was filed for).
 *
 * The lists carry OBJECTS, not branch strings, and that is the whole reason the
 * shape is stated: two shipped reference documents described this verb's output
 * as an array of branch names, and nothing rendered the real shape anywhere a
 * reader would meet it. `override` is `null` unless the spine declares one;
 * `hasOverride` is the same fact as a boolean, kept because callers read it.
 */
const MERGE_ORDER_JSON_SHAPE =
  `{ algorithmic: [ ${MERGE_ORDER_ENTRY_SHAPE} ], override: [ <same entry> ] | null, ` +
  'reason, hasOverride, notInPlay: [ <same entry> ], warnings: [ <text> ] }';

/** The shape `closed-by` prints — `class` is the six-value classification. */
const CLOSED_BY_JSON_SHAPE =
  '{ class: <real-pr|pre-fill|placeholder|sha|prose|empty>, needsPin }';

/** The shape `detect-host` prints — `HostInfo`, verbatim off `detectHost`. */
const DETECT_HOST_JSON_SHAPE =
  '{ host: <github|bitbucket|unknown>, workspace, repo }';

/** The shape `verdict-acked` prints — the met-AC indexes of the MAX-iter verdict. */
const VERDICT_ACKED_JSON_SHAPE = '{ acked: [ <ac-index> ], iter, corrupt }';

/**
 * The shape `version` prints — `compareEngineVersion`'s whole report.
 *
 * Every key is always present; four of the six are `null` on a bare read
 * (confirmed live: `{ version, expected: null, match: null, outcome:
 * "no-expectation", detail, repair: null }`).
 */
const VERSION_JSON_SHAPE = '{ version, expected, match, outcome, detail, repair }';

/**
 * The shape `worktree-cleanup` prints — and it is TWO shapes, because
 * `--dry-run` reports a PLAN and a real run reports a RESULT. They share only
 * their first two keys and their last three, so each is stated WHOLE rather
 * than as an envelope plus a diff: a single merged key list would advertise
 * `removed` on a preview that removes nothing.
 *
 * `branchFilter` is present only with `--spine`/`--branches`, and each of
 * `orphans` / `detached` / `orphanBranches` only when that sweep ran — all
 * conditional spreads, all genuinely absent otherwise. Confirmed live: a
 * `--dry-run --branches …` run printed exactly `dryRun, branchFilter, selected,
 * skipped, worktreeCount, unaccounted, commandLine`, which is this shape with
 * its three optional sweeps absent (measured before issue #961 added `probes`).
 *
 * `probes` (issue #961) is NOT conditional: the stamped-probe population needs
 * no flag, so every run prints it — the plan on the preview, the executed
 * `CleanupResult` on the run. `--probes-only` narrows a run to that one
 * population and prints a THIRD, smaller shape, stated whole on its own line.
 */
const WORKTREE_CLEANUP_JSON_SHAPE =
  '{ dryRun, branchFilter?, selected, skipped, orphans?, detached?, probes, orphanBranches?, ' +
  'worktreeCount, unaccounted, commandLine }';
const WORKTREE_CLEANUP_JSON_CONTINUATION = [
  '         Without --dry-run the RESULT shape is printed instead:',
  '           { dryRun, branchFilter?, removed, skipped, errors, deregisteredNotDeleted,',
  '             erroredStillListed, branchesDeleted, branchHygieneSkipped, branchHygieneDeferred,',
  '             orphans?, detached?, probes, worktreeCount, unaccounted, commandLine }',
  '         orphans? = { selected, skipped, scratch?, reviewRefs?, drivers? } on the preview and the',
  '         executed sweep\'s own result on the run; orphanBranches? is preview-only.',
  '         probes = the stamped-probe sweep: { selected, skipped } on the preview, a full',
  '         cleanup result on the run; skip reasons add live-row and unknown-wave.',
  '         With --probes-only: { dryRun, probesOnly, probes, worktreeCount, commandLine }.',
];

/**
 * One issue's readiness answer, as `dor --json` renders it.
 *
 * `issue` is the very token the prose header's second column carries — the
 * resolved PATH on the file form, the row ID on the `--id` form — so the two
 * renderings name the same subject and neither derives a second identity for it.
 *
 * `gates` is the gate list VERBATIM off the `DorResult`: `status` keeps the
 * gate's own four-value vocabulary (`pass` · `warn` · `fail` · `deferred`), so
 * the deferred/pass distinction the prose draws with `⊘` versus `✓` survives the
 * crossing rather than being flattened into a boolean. `reason` is absent when
 * the gate gave none — a key that carries nothing did not carry anything.
 *
 * Module-local on purpose: this is a CLI projection of `DorResult`, not a second
 * engine type, and a new exported symbol here would have to reach `index.ts`
 * (outside this row's declared Files globs — the same constraint config-cli.ts's
 * warning collector records).
 */
interface DorJsonIssue {
  readonly issue: string;
  readonly overall: 'PASS' | 'FAIL';
  readonly gates: readonly { name: string; status: string; reason?: string }[];
}

/** `dor --json`'s whole answer: every issue asked about, plus the roll-up. */
interface DorJsonResult {
  readonly verb: 'dor';
  readonly overall: 'PASS' | 'FAIL';
  readonly issues: readonly DorJsonIssue[];
}

/** One {@link DorJsonIssue} off a `DorResult` — the gate list, verbatim. */
function dorJsonIssue(issue: string, result: DorResult): DorJsonIssue {
  return {
    issue,
    overall: result.overall,
    gates: result.gates.map((gate) => ({
      name: gate.name,
      status: gate.status,
      ...(gate.reason !== undefined ? { reason: gate.reason } : {}),
    })),
  };
}

/**
 * The Verb contracts of the verbs whose RUNNERS live in this file (ADR-0051
 * decision 2: a contract lives beside its runner; the router only collects).
 *
 * Two of ADR-0051's renames land here:
 *
 *   - **worktree-cleanup's spine path is `--spine`**, with `--wave` as its
 *     silent alias (decision 5). `--wave` used to be a spine PATH here and a
 *     BOOLEAN on `spine add-disclosure` — one spelling, two value types, which
 *     is the one thing decision 5 forbids outright. After this, `--wave` is an
 *     alias everywhere and canonical nowhere.
 *   - **Three of the five named twins** (decision 6) are declared here:
 *     `merge-order --spine`, `verdict-acked --verdicts-dir --id`, and
 *     `render-verdict --verdicts-dir --id --anchor`. The named form is
 *     canonical, the positional form survives as its alias, and a MIXED call is
 *     a usage error — `verdict-acked <dir> --id X` reads to its caller as
 *     though both halves landed.
 */
const ROUTER_VERB_CONTRACTS: Readonly<Record<string, VerbContract>> = {
  dor: defineVerb({
    verb: 'dor',
    flags: [
      { canonical: '--id', value: 'one', valueType: 'id', placeholder: '<issue-id>' },
      { canonical: '--repo-root', value: 'one', valueType: 'dir' },
      { canonical: '--config', value: 'one', valueType: 'path' },
      // The DECLARED PR title (Gate 10, the PR-title advisory). Read by the
      // --id runner alone, exactly as --repo-root is: both are rendered on the
      // second form below and both are ignored by the PATH form, whose
      // variadic arity has no single row for one declared title to belong to.
      // On the --id form the OTHER half of the gate's input — the row's own
      // tracker title — needs no flag at all: the runner already holds the
      // store and reads it through the triage facet (issue #912's store-backed
      // half). So this flag states the ONE thing a tracker cannot be asked for:
      // the title the operator has DECIDED the PR should open under.
      { canonical: '--pr-title', value: 'one', valueType: 'text', placeholder: '<pr-title>' },
    ],
    positionals: { kind: 'variadic', min: 1, label: '<issue-path>' },
    output: 'prose',
    // Two genuinely different calls: the PATH form reads issue files, the --id
    // form reads the IssueStore and takes no positional at all. The runner
    // narrows the arity to zero for the second (CheckOptions.positionals), so
    // the refusal measures the call that was made — the forms below are the
    // same split, stated where a caller can see it.
    forms: [
      { accepts: ['--config'] },
      {
        positionals: { kind: 'fixed', count: 0 },
        requires: ['--id'],
        accepts: ['--repo-root', '--config', '--pr-title'],
      },
    ],
    notes: [
      '  The --id form reads the issue from the IssueStore and takes NO positional.',
      "  The --id form also reads the row's TRACKER title through the triage facet, so the",
      '  PR-title advisory (pr-title-id-independent) runs there instead of deferring; give',
      '  --pr-title to declare the title the PR will open under and the advisory passes.',
      '  The PATH form IGNORES --pr-title: it is variadic over N issue files, so one',
      '  declared title has no single row to belong to. Passing it there prints one stderr',
      '  advisory naming --pr-title, the path form and --id, and otherwise runs exactly as',
      '  though the flag were absent — same exit code, same stdout.',
    ],
    outputNote: 'text (PASS/FAIL + gate lines), not JSON',
    json: { lead: 'the same result as JSON, in BOTH forms', shape: DOR_JSON_SHAPE },
  }),
  'files-drift': defineVerb({
    verb: 'files-drift',
    flags: [],
    positionals: { kind: 'fixed', count: 2, labels: ['<issue-path>', '<sha-range>'] },
    output: 'prose',
    outputNote: 'text, with a JSON block embedded at the end',
    json: { lead: 'ONLY that block', shape: FILES_DRIFT_JSON_SHAPE },
  }),
  'merge-order': defineVerb({
    verb: 'merge-order',
    flags: [{ canonical: '--spine', value: 'one', valueType: 'path' }],
    positionals: { kind: 'fixed', count: 1, labels: ['<wave-md-path>'] },
    output: 'json',
    twin: [{ flag: '--spine', label: '<wave-md-path>' }],
    notes: ['  The spine is named EITHER by --spine or as the positional — never both.'],
    outputNote: 'JSON',
    json: {
      shape: MERGE_ORDER_JSON_SHAPE,
      trail: 'the three lists carry OBJECTS, never branch strings',
    },
  }),
  'closed-by': defineVerb({
    verb: 'closed-by',
    flags: [],
    // The line is JOINED from every positional, so an unquoted `Closed-by:` line
    // is as legal as a quoted one — variadic, and the floor is one token.
    positionals: { kind: 'variadic', min: 1, label: '<closed-by-line>' },
    output: 'json',
    outputNote: 'JSON',
    json: {
      shape: CLOSED_BY_JSON_SHAPE,
      trail: 'the exit code mirrors needsPin (0 false / 1 true)',
    },
  }),
  'detect-host': defineVerb({
    verb: 'detect-host',
    // Accepted and DISCARDED — the FOR-87/W25-F2 uniform-wrapper tolerance.
    // This verb parses a URL and resolves nothing, but `wave-shared`'s
    // auth-preflight convention documents the proxy-prefix fallback as
    // `… cli.ts detect-host <remote-url> --config <path>`, and that invocation
    // was live in the corpus when this refusal landed (found by walking all 287
    // `{{wave-cli}}` invocation lines under `.claude/` against the aggregate).
    // Declaring it keeps a documented, copy-pasteable command working; nothing
    // here reads the value.
    flags: [{ canonical: '--config', value: 'one', valueType: 'path' }],
    positionals: { kind: 'fixed', count: 1, labels: ['<remote-url>'] },
    output: 'json',
    notes: [
      '  --config is accepted and ignored (uniform-wrapper tolerance); this verb resolves no store.',
    ],
    outputNote: 'JSON',
    json: {
      shape: DETECT_HOST_JSON_SHAPE,
      trail: 'workspace/repo are `""` when the URL did not yield them; exit 1 on host `unknown`',
    },
  }),
  'worktree-cleanup': defineVerb({
    verb: 'worktree-cleanup',
    flags: [
      { canonical: '--dry-run', value: 'none', valueType: 'none' },
      { canonical: '--orphans', value: 'none', valueType: 'none' },
      { canonical: '--detached', value: 'none', valueType: 'none' },
      { canonical: '--probes-only', value: 'none', valueType: 'none' },
      { canonical: '--spine', aliases: ['--wave'], value: 'one', valueType: 'path', placeholder: '<spine>' },
      { canonical: '--branches', value: 'one', valueType: 'list', placeholder: '<b1,b2>' },
      { canonical: '--config', value: 'one', valueType: 'path' },
    ],
    // The repo-root slot is OPTIONAL — a bare `--dry-run`, a `--spine` or a
    // `--branches` call names its target another way — so the arity declares a
    // floor of zero and a rendered usage line brackets it.
    positionals: { kind: 'fixed', count: 1, min: 0, labels: ['<repo-root>'] },
    output: 'json',
    notes: [
      '  --wave is accepted as an alias of --spine.',
      '  --detached also sweeps REGISTERED detached-HEAD scratch checkouts under the',
      '  worktrees root (the E2BIG population); --dry-run previews the same plan.',
      '  Every run also sweeps stamped Reviewer probe checkouts (flotilla-probe-*),',
      '  wherever they sit, under probes: spared live-row while the --spine row is',
      '  dispatched, re-dispatched or reviewing at the stamp\'s own iteration (or',
      '  its Iter is not a number), removed otherwise; with no --spine nothing is',
      '  removed. --probes-only runs that population alone (never with --orphans,',
      '  --detached or --branches).',
    ],
    // It used to say `# prints JSON` inline on the signature line and carry no
    // `output:` line at all — the one JSON verb in the engine that advertised
    // its class a second way. One way now.
    outputNote: 'JSON',
    json: {
      shape: WORKTREE_CLEANUP_JSON_SHAPE,
      trail: 'the PLAN shape, printed with --dry-run',
      continuation: WORKTREE_CLEANUP_JSON_CONTINUATION,
    },
  }),
  'verdict-acked': defineVerb({
    verb: 'verdict-acked',
    flags: [
      { canonical: '--verdicts-dir', value: 'one', valueType: 'dir' },
      { canonical: '--id', value: 'one', valueType: 'id' },
    ],
    positionals: { kind: 'fixed', count: 2, labels: ['<verdictsDir>', '<id>'] },
    output: 'json',
    twin: [
      { flag: '--verdicts-dir', label: '<verdictsDir>' },
      { flag: '--id', label: '<id>' },
    ],
    notes: ['  ALL named or ALL positional — a mixed call is a usage error.'],
    outputNote: 'JSON',
    json: {
      shape: VERDICT_ACKED_JSON_SHAPE,
      trail: 'no verdict for the id is `{ acked: [], iter: null, corrupt: 0 }`, never an error',
    },
  }),
  'render-verdict': defineVerb({
    verb: 'render-verdict',
    flags: [
      { canonical: '--verdicts-dir', value: 'one', valueType: 'dir' },
      { canonical: '--id', value: 'one', valueType: 'id' },
      { canonical: '--anchor', value: 'one', valueType: 'sha', required: true },
    ],
    positionals: { kind: 'fixed', count: 2, labels: ['<verdictsDir>', '<id>'] },
    // stdout is the rendered markdown itself — the product, not a report.
    output: 'product',
    twin: [
      { flag: '--verdicts-dir', label: '<verdictsDir>' },
      { flag: '--id', label: '<id>' },
    ],
    notes: [
      '  The directory and the id are ALL named or ALL positional; --anchor is always named.',
    ],
    outputNote: 'text (the rendered markdown), not JSON',
    json: {
      lead: 'accepted and IGNORED — output class `product`, so the markdown IS the result.',
    },
  }),
  version: defineVerb({
    verb: 'version',
    flags: [
      { canonical: '--expect', value: 'one', valueType: 'version', placeholder: '<plugin-version>' },
    ],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      // The shape used to live HERE, as prose inside a note — a second place a
      // shape could be stated, and the reason the shape clause below exists as
      // a declared field instead (issue #913). One statement, one renderer.
      '  Resolves no store and reads no wave config.',
      '  Exit: 0 match / bare read; 1 mismatch, unreadable engine version, or',
      '  unusable expectation; 2 usage.',
    ],
    outputNote: 'JSON',
    json: {
      shape: VERSION_JSON_SHAPE,
      trail: 'every key always present; four are null on a bare read',
    },
  }),
  catalog: defineVerb({
    verb: 'catalog',
    // No flags of its own, deliberately: the Catalog is the whole aggregate or
    // it is not the Catalog. A `--verb <verb>` filter would be a second way to
    // ask a question `--help` already answers for one verb, and a reader that
    // holds the JSON can filter it itself.
    flags: [],
    positionals: { kind: 'fixed', count: 0 },
    output: 'json',
    notes: [
      '  Emits the Catalog: every Verb contract the router collects, one entry per',
      '  verb and per group op, each carrying its canonical flag spellings, their',
      '  aliases, value kinds, positional arity and output class.',
      '  Resolves no store, reads no wave config, and reaches no network.',
      // Was the `lead` of the clause below while that clause was headed
      // `--json:`. Under `shape:` (issue #913) the heading no longer names a
      // flag, so the sentence about the flag belongs with the verb's prose.
      '  The --json flag is accepted and redundant here — there is no second rendering.',
    ],
    outputNote: 'JSON — the Catalog itself, sorted by verb',
    json: {
      shape: '{ verb, verbs: [ <VerbContract>, ... ] }',
      trail: 'the contracts verbatim, never a hand-written projection of them',
    },
  }),
};

/**
 * The verb GROUPS — a group token plus an op token address one contract.
 * Collected here so the aggregate reader, the `--help` interception and the
 * later Catalog all resolve `spine add-disclosure` the same way.
 */
const VERB_GROUP_CONTRACTS: Readonly<Record<string, Readonly<Record<string, VerbContract>>>> = {
  'host-pr': HOST_PR_CONTRACTS,
  'issue-store': ISSUE_STORE_CONTRACTS,
  spine: SPINE_CONTRACTS,
  config: CONFIG_CONTRACTS,
};

/**
 * The top-level verbs whose contracts are declared in their OWN module — every
 * runner's contract lives beside it (ADR-0051 decision 2; the three that used
 * to be a stated exception in `verb-contract.ts` moved beside their runners in
 * `compose-driver.ts`, `route-tuple.ts` and `close-row.ts`). The router only
 * collects.
 */
const DELEGATED_VERB_CONTRACTS: Readonly<Record<string, VerbContract>> = {
  'conflict-map': CONFLICT_MAP_CONTRACT,
  'cross-wave': CROSS_WAVE_CONTRACT,
  resume: RESUME_CONTRACT,
  'store-preflight': STORE_PREFLIGHT_CONTRACT,
  'credential-probe': CREDENTIAL_PROBE_CONTRACT,
  ...ROUTE_CONTRACTS,
  'compose-driver': COMPOSE_DRIVER_CONTRACT,
  'route-tuple': ROUTE_TUPLE_CONTRACT,
  'close-row': CLOSE_ROW_CONTRACT,
};

/**
 * THE aggregate reader (ADR-0051 decision 2) — every Verb contract the engine
 * declares, top-level verbs and group ops alike, keyed by exactly what a caller
 * types (`route-tuple`, `spine add-disclosure`, `issue-store triage-apply`).
 *
 * Root-exported, because three later rows read it rather than re-deriving it:
 * the skill-side pin (which asserts every `{{wave-cli}}` invocation resolves to
 * a contract and uses canonical spellings), the prose-verb `--json` row (which
 * reads the output classes), and the usage-rendering row (which renders each
 * verb's usage FROM its contract instead of the hand-written lines above).
 *
 * The router COLLECTS; it declares only the nine verbs whose runners are in this
 * file.
 */
export function verbContracts(): Readonly<Record<string, VerbContract>> {
  const out: Record<string, VerbContract> = {
    ...ROUTER_VERB_CONTRACTS,
    ...DELEGATED_VERB_CONTRACTS,
  };
  for (const [group, ops] of Object.entries(VERB_GROUP_CONTRACTS)) {
    for (const [op, contract] of Object.entries(ops)) {
      out[`${group} ${op}`] = contract;
    }
  }
  return out;
}

/**
 * The contract an argv addresses, plus the arguments that belong to it —
 * `undefined` when argv names no verb this engine knows, or names a verb group
 * without a recognised op.
 *
 * ONE resolver, so the refusal, `--help` and the Catalog can never disagree
 * about which contract an invocation meant.
 */
export function contractForArgv(
  argv: readonly string[],
): { contract: VerbContract; args: string[] } | undefined {
  const first = argv[0];
  if (first === undefined) return undefined;
  const group = VERB_GROUP_CONTRACTS[first];
  if (group !== undefined) {
    const op = argv[1];
    const contract = op === undefined ? undefined : group[op];
    return contract === undefined ? undefined : { contract, args: argv.slice(2) };
  }
  const contract = verbContracts()[first];
  return contract === undefined ? undefined : { contract, args: argv.slice(1) };
}

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

// ─── The roster, RENDERED from the contracts (issues #758, #856) ─────────────
//
// Every line of the router's whole-CLI usage below is built from a Verb
// contract — its flags, its positional arity, its named-twin slots and its
// output class — and none of it is typed out by hand any more.
//
// Issue #856 finished the other half and moved the mechanism: the renderer
// itself lives in `verb-contract.ts` now, and each verb's OWN section goes
// through it too. What is left here is the roster's two settings — the uniform
// `flotilla-engine <verb>` prefix and the value-TYPE placeholders — plus the
// output note, the alias note and the `--json` clause that only a one-line
// index needs. One renderer, two surfaces; see {@link signatureForm}.
//
// The gap this closes was measurable rather than stylistic. The roster used to
// be ~50 hand-maintained lines describing the same verbs the contracts already
// describe, and a hand-maintained description of a parser drifts from it: the
// `compose-driver` line named ten of the verb's thirteen flags and silently
// omitted `--template`, `--reports-dir` and `--verdicts-dir` — three flags the
// parser has always read — while `store-preflight`'s line omitted `--expect`
// and the label-creating switch. Nothing could catch that, because the roster
// was the only place those lines existed. Rendered from `contract.flags`, an
// omission is no longer expressible: a flag the parser reads is a flag the
// roster prints, and the only way to drop one from the usage is to drop it from
// the contract, which is the same edit as dropping it from the parser.
//
// What the roster deliberately no longer carries is a SECOND copy of a verb's
// prose. Each verb's own contract section — printed by `<verb> --help` and by
// every refusal — is where the detail lives (the `--title` precedence rule, the
// `--body-file` guidance, the `--detached` sweep population); the roster names
// every verb and every group op with its full argument shape and sends the
// reader there. That is what removed the last hand-copied paragraph pairs.

/**
 * One verb's — or one group op's — ROSTER signature: the shape
 * {@link renderInvocations} renders for it, with the router's own settings.
 *
 * Two of them, and each is a deliberate difference from the verb's own section
 * (issue #856). The program is `flotilla-engine <verb>` for EVERY verb, group
 * ops and self-named modules alike — every one of them is reachable as a
 * subcommand of this one CLI, and the roster is the list of that. And the
 * relationships are OFF: a flag is listed as the independent optional the
 * contract declares it to be, and how the flags go together is taught by the
 * verb's own section one `--help` away. Sixty lines that have to scan as
 * columns cannot also be sixty paragraphs.
 */
function signatureForm(contract: VerbContract): string {
  const [line] = renderInvocations(contract, {
    program: '',
    placeholders: 'type',
    relationships: false,
  });
  return line;
}

/** What a verb's stdout IS, as the inline note the roster line ends with. */
const OUTPUT_NOTE: Readonly<Record<OutputClass, string>> = {
  prose: 'prints text, not JSON',
  json: 'prints JSON',
  'silent-write': 'prints nothing on success — the write IS the result',
  product: 'prints the artifact itself, not a report about it',
};

/**
 * One verb's — or one group op's — roster line: the rendered signature, then the
 * output class as an inline note, then the aliases named ONCE, then the verb's
 * own `--json` clause where its contract states one.
 *
 * That last clause is what row V5's `jsonFormNote()` used to do from OUTSIDE the
 * renderer, on eight hand-written roster lines. It is absorbed into the renderer
 * here and that helper is gone — one mechanism renders the roster, and the
 * `--json` shape is part of what it renders rather than a second thing bolted
 * onto lines it did not build. It stays DERIVED either way: a verb whose
 * contract declares no `--json` clause in its contract gets none here, so the
 * roster can never promise a JSON form a verb does not have.
 *
 * The clause is read back off the rendered section rather than off the
 * `JsonNote` beside it, and that is the point of reading it here: whatever a
 * verb's own `--help` prints on its `--json` line is, byte for byte, what the
 * roster carries — one text, two places, never two renderings of one shape.
 */
function rosterLine(contract: VerbContract): string {
  const signature = signatureForm(contract);
  const invocation = `  flotilla-engine ${contract.verb}${signature === '' ? '' : ` ${signature}`}`;
  const aliases = contract.flags.flatMap((f) =>
    (f.aliases ?? []).map((alias) => `${alias} → ${f.canonical}`),
  );
  const aliasNote = aliases.length === 0 ? '' : `; aliases: ${aliases.join(', ')}`;
  return `${invocation}   # ${OUTPUT_NOTE[contract.output]}${aliasNote}${jsonClause(contract)}`;
}

/**
 * A verb's own `--json` clause, off its contract — the whole clause, including
 * the continuation lines a long shape wraps onto.
 *
 * "Whole clause" is the half that needed saying: `issue-store annotate` states
 * its receipt over two lines and the second one carries the field list, so
 * taking the first line alone would end the roster's sentence on a colon and
 * drop exactly the part a caller was reading for. A continuation is recognised
 * structurally — a following line indented DEEPER than the `--json` line
 * itself — never by counting lines.
 *
 * **A `json`-class verb contributes nothing here, deliberately** (issue #913).
 * Its clause answers a different question — `shape:`, what its whole stdout IS,
 * not what a flag adds — and those shapes run to a hundred characters and more.
 * The roster is a uniform one-line index of sixty verbs; carrying them would
 * stop it scanning as columns, and `--help` is one keystroke away. The roster's
 * `# prints JSON` already says the class.
 *
 * **That rule TRIMMED one roster line, and the trim is operator-visible.**
 * `catalog` is the one `json`-class verb that already carried a clause before
 * the rule existed, so its roster line lost it: it read `# prints JSON;
 * --json: accepted and redundant — this verb has no second rendering — { verb,
 * verbs: [ <VerbContract>, ... ] } — the contracts verbatim, never a
 * hand-written projection of them`, and now reads `# prints JSON`. Measured,
 * not inferred: the zero-argument roster is 85 lines before and after, and
 * `catalog`'s is the ONLY line of the 85 that differs. Exempting it was
 * considered and rejected — one verb keeping a clause the other 35 may not
 * have would leave the roster inconsistent with its own stated rule, and that
 * shape is still one `flotilla-engine catalog --help` away.
 *
 * The lookup is by the clause's OWN heading rather than by a `--json` prefix,
 * and that precision is load-bearing: `catalog`'s prose mentions the flag, and
 * a prefix search pulled that sentence onto its roster line as though it were
 * the clause.
 */
function jsonClause(contract: VerbContract): string {
  if (contract.output === 'json') return '';
  const heading = contract.json?.label ?? '--json';
  const at = contract.usage.findIndex((l) => l.trimStart().startsWith(`${heading}: `));
  if (at === -1) return '';
  const indent = contract.usage[at].length - contract.usage[at].trimStart().length;
  const clause = [contract.usage[at]];
  for (const line of contract.usage.slice(at + 1)) {
    if (line.trim() === '' || line.length - line.trimStart().length <= indent) break;
    clause.push(line);
  }
  return `; ${clause.map((l) => l.trim()).join(' ')}`;
}

/**
 * The roster's closing prose — about the CLI as a whole, not about any one
 * verb, which is why it is the only text here that is not rendered from a
 * contract.
 */
const USAGE_TRAILER: readonly string[] = [
  // ADR-0051's glossary consequence, as a code change: "alias" is now the
  // SPELLING sense — one canonical flag spelling plus the near-synonyms it
  // silently accepts. A direct module invocation is not a second spelling of
  // a flag; it is a second way of reaching the same runner, which the
  // glossary's `Dual-form` entry is the word for. Calling it an alias here
  // made the one term the whole record turns on ambiguous at the surface a
  // stranger reads first.
  '  Every engine verb is reachable as a subcommand of THIS CLI. The direct',
  '  module invocations below still route to the same runners; the subcommand',
  '  form is the contract — prefer the form listed above:',
  '    npx tsx tools/wave/src/resume-cli.ts ...            -> the `resume` subcommand',
  '    npx tsx tools/wave/src/cli-store.ts preflight ...   -> the `store-preflight` subcommand',
  '    npx tsx tools/wave/src/spine-cli.ts <op> ...        -> the `spine` subcommand',
  '',
  '  Every verb accepts --json and --help (ADR-0051). --help prints that one',
  "  verb's contract and constructs no store and no host. Every flag has ONE",
  '  canonical spelling; the near-synonyms a verb used to take are accepted as',
  '  silent aliases, and anything a verb does not declare exits 2.',
  '',
];

/**
 * The verb-LESS form's line: `flotilla-engine <issue-path> [<issue-path> ...]`.
 *
 * It is not a verb and has no contract of its own, so its argument shape is
 * rendered from `dor`'s — the runner it reaches — with the flags stripped off:
 * the legacy positional form is exactly "the readiness gate, with no subcommand
 * token", and advertising `dor`'s flags on a line that never names `dor` would
 * invite the reader to type a call that resolves to a different verb.
 */
function verblessForm(dor: VerbContract): string {
  const [line] = renderInvocations(
    { ...dor, flags: [], forms: undefined, groups: undefined, twin: undefined },
    { program: 'flotilla-engine', placeholders: 'type', relationships: false },
  );
  return line;
}

/**
 * The router's whole-CLI usage, as lines — one rendered line per verb and per
 * group op, in the router's own dispatch order.
 *
 * Split out from {@link printUsage} (which still writes them to stderr on a
 * misinvocation) so a bare `flotilla-engine --help` can write the SAME text to
 * stdout and exit 0 — a help request is an answer, not an error, and answering
 * on stderr with exit 2 is how a `--help` ends up unreadable in a pipeline.
 *
 * `KNOWN_SUBCOMMANDS` drives the order and `verbContracts()` supplies the text,
 * so a verb that is dispatched but undeclared would crash this function rather
 * than quietly go unlisted — the same "the roster IS the dispatch table"
 * discipline `SUBCOMMAND_PURPOSE`'s typing enforces at compile time.
 */
function usageLines(): string[] {
  const all = verbContracts();
  const lines: string[] = [
    'usage:',
    // The verb-LESS form: `flotilla-engine <issue-path> ...` runs the readiness
    // gate with no subcommand token at all (the legacy positional form). It has
    // no contract of its own because it is not a verb — so its argument shape is
    // rendered from `dor`'s contract, which is the runner it reaches.
    `  ${verblessForm(all.dor)}   # the verb-less readiness gate — ${OUTPUT_NOTE[all.dor.output]}`,
  ];
  for (const verb of KNOWN_SUBCOMMANDS) {
    const group = VERB_GROUP_CONTRACTS[verb];
    if (group === undefined) {
      lines.push(rosterLine(all[verb]));
      continue;
    }
    // A verb GROUP is listed op by op: `issue-store <op> [...args]` used to
    // stand for twenty-six contracts and send the reader to a misinvocation to
    // discover any of them.
    for (const op of Object.keys(group)) lines.push(rosterLine(all[`${verb} ${op}`]));
  }
  lines.push('', `available subcommands: ${KNOWN_SUBCOMMANDS.join(', ')}`, '', ...USAGE_TRAILER);
  return lines;
}

function printUsage(): void {
  process.stderr.write(usageLines().join('\n'));
}

/**
 * ONE verb's own usage, on stderr, exit 2 — the answer to a subcommand invoked
 * with no arguments at all (issue #758).
 *
 * Before this, every such call fell back to {@link printUsage}: a bare
 * `flotilla-engine route-verdict` answered with the whole-CLI block, and the one
 * verb the caller had actually named was three lines of eighty. The contract's
 * own section is the focused answer, and it is the SAME text that verb's
 * `--help` and every one of its refusals print — the printer row 821 installed,
 * reached from one more place rather than reimplemented.
 */
function printVerbUsage(contract: VerbContract): number {
  process.stderr.write([...contract.usage, ''].join('\n'));
  return 2;
}

/**
 * The focused answer for a verb GROUP invoked with no op: that group's own
 * roster, rendered from its ops' contracts, and nothing about any other verb.
 */
function printGroupUsage(group: string): number {
  const all = verbContracts();
  const ops = Object.keys(VERB_GROUP_CONTRACTS[group]);
  process.stderr.write(
    [
      `usage: flotilla-engine ${group} <${ops.join('|')}> [...args]`,
      ...ops.map((op) => rosterLine(all[`${group} ${op}`])),
      `  \`${group} <op> --help\` prints that one op's contract.`,
      '',
    ].join('\n'),
  );
  return 2;
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
  const contract = ROUTER_VERB_CONTRACTS.dor;
  if (helpRequested(contract, paths)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, paths);
  if (refusal !== 0) return refusal;

  // The issue paths are the contract's positionals, so a flag's VALUE can never
  // be validated as an issue file (the `--config <path>` splice below used to be
  // the only thing standing between this loop and exactly that).
  const filePaths = positionalsOf(contract, paths);
  let verify: VerifyConfig | undefined;
  const configIdx = paths.indexOf('--config');
  if (configIdx !== -1) {
    const configPath = paths[configIdx + 1];
    if (configPath === undefined) {
      process.stderr.write('error: dor --config requires a <path>\n');
      return 2;
    }
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
  // ADR-0051 decision 7, row V5. Read through the SAME contract-aware scan the
  // positionals came from, so a flag's VALUE can never be mistaken for the flag.
  const wantJson = hasFlag(contract, paths, 'json');

  // issue #955: `--pr-title` is declared once on this contract (ADR-0051
  // decision 5 forbids a second declaration for one canonical spelling), so
  // it clears the unknown-flag refusal on THIS form too — but this form is
  // variadic over N issue files and has no single row for one declared title
  // to belong to, so it is read nowhere below and silently dropped. The other
  // way out named at #955 — REFUSING it here — needs per-form flag narrowing
  // in verb-contract.ts (checkUndeclared reads the contract's flags, never a
  // form's `accepts` list), which sits outside this slice's declared Files;
  // this takes the deliberate-accept branch instead. One stderr advisory, so
  // an operator who declared a title here is told it was never read — but
  // the flag is still consumed by the scan above, so the exit code and
  // stdout stay byte-identical to the same call without it.
  if (hasFlag(contract, paths, 'pr-title')) {
    process.stderr.write(
      'notice: dor: --pr-title is ignored on the path form (dor <issue-path>...) — ' +
        'it is read only on the --id form (dor --id <id> --pr-title <title>).\n',
    );
  }

  let anyFail = false;
  const outputs: string[] = [];
  // The prose and the JSON are built SIDE BY SIDE rather than one being rendered
  // from the other, and deliberately: the unreadable-file block below is
  // hand-written prose that `renderResult` does NOT reproduce byte-for-byte (it
  // spaces the reason with two spaces, this line with one), so rendering the
  // prose through a shared path to gain the JSON would have silently changed the
  // default output of the one case a caller reaches when a file is missing.
  const records: DorJsonIssue[] = [];

  for (const arg of filePaths) {
    const issuePath = resolve(arg);
    const repoRoot = findRepoRoot(issuePath);
    let source: string;
    try {
      source = readFileSync(issuePath, 'utf-8');
    } catch (err) {
      anyFail = true;
      const reason = (err as Error).message;
      outputs.push(`FAIL  ${issuePath}\n  ✗ fail  read-issue-file — ${reason}`);
      records.push({
        issue: issuePath,
        overall: 'FAIL',
        gates: [{ name: 'read-issue-file', status: 'fail', reason }],
      });
      continue;
    }
    const result = validateIssue({ repoRoot, issuePath, source, verify });
    if (result.overall === 'FAIL') anyFail = true;
    outputs.push(renderResult(issuePath, result));
    records.push(dorJsonIssue(issuePath, result));
  }

  const overall: DorJsonResult['overall'] = anyFail ? 'FAIL' : 'PASS';
  if (wantJson) {
    const answer: DorJsonResult = { verb: 'dor', overall, issues: records };
    printJson(answer);
  } else {
    process.stdout.write(outputs.join('\n\n') + '\n');
  }
  // The flag chose a RENDERING, never a verdict: this line is the one it was
  // going to return either way.
  return anyFail ? 1 : 0;
}

/**
 * The non-file Definition-of-Ready entrypoint (`dor --id <id>`, ADR-0014).
 * Async because it reads the issue from the (async) `IssueStore`; the engine
 * function {@link validateIssueView} stays pure over the `IssueView`. The store
 * is built from `--config` unless one is injected (tests). Self-content gates
 * run; the WORKING-TREE gates `defer` unless `--repo-root` names a checkout.
 *
 * The two gates whose answer lives on the STORE rather than on the view are
 * threaded here, from the store this function already holds: the cross-issue
 * gate through `resolveDeclaredBlockers` (issue #750) and the PR-title advisory
 * through one `readTriage` for the row's own title. Both stay capability-shaped
 * — a read this function could not make leaves the gate `deferred`, never
 * passing — and the pure validator stays synchronous and store-blind.
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
  const contract = ROUTER_VERB_CONTRACTS.dor;
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  // The `--id` FORM takes no positional at all — the arity declared on the
  // contract is the PATH form's — so the declared arity is narrowed for this
  // call and a stray path exits 2 instead of being silently ignored
  // (ADR-0051 decision 4).
  const refusal = refuseUndeclared(contract, args, {
    positionals: { kind: 'fixed', count: 0 },
  });
  if (refusal !== 0) return refusal;

  const id = flag(args, contract, 'id');
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

  const repoRoot = flag(args, contract, 'repo-root');

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
  const configPath = flag(args, contract, 'config');
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

  // Gate 5 (the cross-issue gate) is threaded as a CAPABILITY, issue #750: the
  // store is in hand right here — `store.read(id)` above already used it — so
  // this entry point resolves the row's declared `Blocked by:` refs and hands
  // the OUTCOMES to the gate. The gate itself stays synchronous and store-blind;
  // see `resolveDeclaredBlockers` for what "resolve" means and where it stops.
  // The exemplar id is the one the STORE reports on the view, not the one the
  // operator typed: a store that canonicalizes an id on read must be addressed
  // in its own rendering.
  const blockerResolutions = await resolveDeclaredBlockers(
    store,
    view.id,
    view.blockedBy,
  );

  // Gate 9 (the staleness advisory) is threaded by the CONTRACT, not by an
  // option: the `since` it measures from rides on `IssueView.trackerUpdatedAt`,
  // which `store.read(id)` above already populated (or deliberately left absent,
  // in which case the gate `defer`s rather than passing). `--repo-root` is what
  // turns it on, the same flag the other working-tree gates key off.

  // Gate 10 (the PR-title advisory) is threaded as a CAPABILITY, the same shape
  // Gate 5 is above — and for the same reason: the answer lives on the store
  // this entry point already holds, and the pure gate must not learn to ask for
  // it. The row's human-facing title is NOT on `IssueView` (the canonical
  // contract is wave-header-only by construction); it lives on the TRIAGE facet,
  // which is on the `IssueStore` contract and conformance-tested across all
  // three shipped stores. So the read is one extra `readTriage`, here, at the
  // caller — exactly what the gate's own deferral text has named as the missing
  // step since the gate shipped. Without it the gate `deferred` on the ONE path
  // a decoration pass actually runs (`dor --id`), which is the whole defect.
  //
  // A FAILED read is not an error for this verb. `store.read(id)` above already
  // proved the row exists and is header-parseable, so a throw here is a
  // capability gap — a store whose triage facet this call cannot reach, a
  // transient tracker failure, or an injected test double that implements
  // `read` alone — and a capability gap is what `'deferred'` means. Leaving
  // `title` undefined hands the gate exactly the state it had before this
  // threading, so it defers with ITS OWN existing reason rather than a second
  // one invented here; the notice below is what keeps that from being silent.
  let title: string | undefined;
  try {
    title = (await store.readTriage(view.id)).title;
  } catch (err) {
    process.stderr.write(
      `notice: dor: could not read the title of ${view.id} through the triage facet ` +
        `(${(err as Error).message}) — the PR-title advisory defers instead of running.\n`,
    );
  }
  // The DECLARED half, and the only half an operator supplies: `--pr-title` is
  // the row's stated PR title, which turns the advisory into a `pass` whatever
  // the tracker title contains, because nothing is derived from it at all.
  const prTitle = flag(args, contract, 'pr-title');

  const result = validateIssueView(view, {
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    ...(verify !== undefined ? { verify } : {}),
    blockerResolutions,
    ...(title !== undefined ? { title } : {}),
    ...(prTitle !== undefined ? { prTitle } : {}),
  });
  // The SAME `{ verb, overall, issues: [...] }` envelope the file form prints,
  // holding one record (ADR-0051 decision 7, row V5). One shape across both
  // forms is the point: a Coordinator that reads `dor --json` should not have to
  // know which form produced the answer before it can parse it.
  if (hasFlag(contract, args, 'json')) {
    const answer: DorJsonResult = {
      verb: 'dor',
      overall: result.overall,
      issues: [dorJsonIssue(id, result)],
    };
    printJson(answer);
  } else {
    process.stdout.write(renderResult(id, result) + '\n');
  }
  return result.overall === 'FAIL' ? 1 : 0;
}

/**
 * Read the row's declared `Blocked by:` refs against the tracker — the
 * capability `dor --id` hands to DoR Gate 5 (issue #750).
 *
 * **The seam is the closing probe, not the plain issue read.** `readClosing` is
 * already on the `IssueStore` contract, already conformance-tested in all three
 * stores, answers exactly open-versus-closed from native state plus closing-PR
 * evidence, and throws on an unknown id — which is precisely the `unresolvable`
 * arm. It also does NOT require the blocker to carry a planning Header-Block,
 * where `read()` does: an undecorated but open blocker stays resolvable here,
 * and a bare row can therefore still hold a wave row back. The per-store private
 * `unresolvedBlockers` helper the Goal frontier uses was deliberately NOT
 * promoted to the contract for this — that would be a public-API addition across
 * three implementations plus the conformance suite, for an answer the contract
 * can already give.
 *
 * **Every state below is evidence-shaped.** `open` and `closed` are read; every
 * other outcome is `unresolvable`, never a silent pass. The three closed states
 * (`merged`, `closed-unmerged`, `closed-unknown`) all mean the blocker is no
 * longer in the way of THIS row — the gate asks whether the dependency is still
 * open, not how it ended — so they collapse to `closed` here. That collapse is
 * this call's business and nobody else's: `readClosing`'s four-way distinction
 * stays intact for the resume/close done-reconcile that needs it.
 *
 * **Addressing a ref, without parsing an opaque id (ADR-0001).** `readClosing`
 * takes an id; `blockedBy` carries `IssueRef`s. The contract ships the
 * `id → IssueRef` inversion (`parseRef`) and deliberately no forward direction,
 * so this resolver never asserts an id shape. It derives a CANDIDATE id from the
 * row's OWN id — the store's own exemplar — by swapping the trailing decimal run
 * for the ref's number, and then submits that candidate to the store's own
 * `parseRef` for a veto. Both the exemplar and the veto are the store's; the
 * only thing this code contributes is a proposal, and a proposal the store
 * refuses becomes `unresolvable` → the gate `defer`s. A wrong id can therefore
 * cost evidence, never invent it.
 *
 * **A ref naming a DIFFERENT slug is `unresolvable` by rule.** `IssueRef.slug`
 * is undefined for a same-slug ref and set for a cross-slug one; a ref whose
 * slug differs from the row's own is another repo's / another team's / another
 * tree's issue. Some stores could address it (Linear resolves a cross-TEAM
 * identifier) and some structurally cannot (GitHub is repo-scoped;
 * `MarkdownFsStore.locate` ignores the slug part of an id entirely and would
 * answer about ITS OWN tree's issue of the same number — a silently wrong
 * answer). A store-blind caller cannot tell those apart, so it declines for all
 * of them. That costs a Linear consumer a resolvable cross-team blocker, and it
 * costs it as a `deferred` — the conservative direction, and the only one that
 * cannot manufacture a `pass`.
 */
async function resolveDeclaredBlockers(
  store: IssueStore,
  ownId: string,
  blockedBy: 'none' | IssueRef[],
): Promise<BlockerResolution[]> {
  // `none` needs no store call at all: nothing is declared, so nothing is read.
  // An EMPTY array is still a capability (the gate branches on presence, not
  // length) and is exactly what a `Blocked by: none` row should hand over.
  if (blockedBy === 'none') return [];

  let own: IssueRef | undefined;
  let ownError: string | undefined;
  try {
    own = store.parseRef(ownId);
  } catch (err) {
    ownError = `this store could not invert its own id "${ownId}": ${(err as Error).message}`;
  }

  const out: BlockerResolution[] = [];
  for (const ref of blockedBy) {
    if (own === undefined) {
      out.push({ ref, state: 'unresolvable', reason: ownError });
      continue;
    }
    if (ref.slug !== undefined && ref.slug !== own.slug) {
      out.push({
        ref,
        state: 'unresolvable',
        reason: 'names a different slug than this row — outside what a store-blind lookup can address',
      });
      continue;
    }
    const candidate = candidateIdFor(ownId, own, ref, store);
    if (candidate === null) {
      out.push({
        ref,
        state: 'unresolvable',
        reason: `this store's id format does not render ${ref.issue} from the row's own id "${ownId}"`,
      });
      continue;
    }
    try {
      const closing = await store.readClosing(candidate);
      out.push({ ref, state: closing.state === 'open' ? 'open' : 'closed' });
    } catch (err) {
      out.push({
        ref,
        state: 'unresolvable',
        reason: `reading "${candidate}" failed: ${(err as Error).message}`,
      });
    }
  }
  return out;
}

/**
 * The store-format-blind candidate id for `ref`, derived from the row's own id
 * and vetoed by the store's own `parseRef`; `null` when no candidate survives.
 *
 * Two checks, both on the STORE's answers rather than on an assumed shape:
 *
 *  1. the row's own id must END in the decimal rendering of its own issue number
 *     (`parseRef(ownId).issue`) — the exemplar self-check. It holds for all three
 *     shipped id shapes (`"750"`, `"FOR-480"`, `"<slug>#05"`), and a store whose
 *     ids do not work that way fails it here and gets a `deferred` rather than a
 *     wrong lookup.
 *  2. the candidate must invert back through `parseRef` to the very ref asked
 *     for. This is where a bad proposal dies.
 */
function candidateIdFor(
  ownId: string,
  own: IssueRef,
  ref: IssueRef,
  store: IssueStore,
): string | null {
  const trailing = /\d+$/.exec(ownId);
  if (trailing === null || Number(trailing[0]) !== own.issue) return null;
  const candidate =
    ownId.slice(0, ownId.length - trailing[0].length) + String(ref.issue);
  try {
    const round = store.parseRef(candidate);
    if (round.issue !== ref.issue || round.slug !== own.slug) return null;
  } catch {
    return null;
  }
  return candidate;
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
  lines.push(JSON.stringify(driftJsonBlock(result), null, 2));

  return lines.join('\n');
}

/**
 * THE block `files-drift` has always embedded at the end of its prose — now with
 * one owner, because `--json` prints the same object on its own (row V5's second
 * acceptance criterion, and the reason this verb is an output CLASS rather than
 * a special case: the machine-readable answer already existed, wrapped in human
 * framing a parser had to cut off first).
 *
 * Extracted rather than duplicated: two literals of one shape is exactly how the
 * `--json` answer and the embedded block would come to disagree about a field a
 * later row adds to only one of them.
 */
function driftJsonBlock(result: DriftResult): {
  status: DriftResult['status'];
  driftedFiles: DriftResult['driftedFiles'];
  rationale: DriftResult['rationale'];
  projectScopes: DriftResult['projectScopes'];
} {
  return {
    status: result.status,
    driftedFiles: result.driftedFiles,
    rationale: result.rationale,
    projectScopes: result.projectScopes,
  };
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
  const contract = ROUTER_VERB_CONTRACTS['files-drift'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;
  const wantJson = hasFlag(contract, args, 'json');
  // Read through the contract rather than off `args[0]`/`args[1]`: with a
  // router-global flag now MEANING something here, `files-drift --json <path>
  // <range>` would otherwise have validated `"--json"` as the issue file. Same
  // fix, same reason, as the `--config` splice `runDor` reads past above.
  const positionals = positionalsOf(contract, args);
  if (positionals.length < 2) {
    process.stderr.write(
      [
        'error: files-drift requires two arguments',
        // The CONTRACT's own section (issue #758) — this used to be a second,
        // hand-written copy of its first line, which is how a usage text comes
        // to describe a verb its parser no longer matches.
        ...contract.usage,
        '',
      ].join('\n'),
    );
    return 2;
  }

  const [issuePath, shaRange] = positionals;
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

  // Class `prose` with an embedded block: `--json` prints ONLY the block, so a
  // caller stops having to cut the human framing off the front of it. The exit
  // code below is untouched either way — a cross-project drift still exits 2
  // with its JSON.
  if (wantJson) printJson(driftJsonBlock(result));
  else process.stdout.write(renderDriftResult(result) + '\n');

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
  const contract = ROUTER_VERB_CONTRACTS['merge-order'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;

  // Named twin (ADR-0051 decision 6): `--spine <path>` is canonical because four
  // sibling verbs already spell the spine that way; the bare positional survives
  // as its alias, and passing both is a usage error.
  const twin = resolveTwin(contract, args);
  if (!twin.ok) {
    process.stderr.write([`error: ${twin.error}`, ...contract.usage, ''].join('\n'));
    return 2;
  }
  const spineArg = twin.values[0];
  if (spineArg === undefined) {
    process.stderr.write(
      [
        'error: merge-order requires one argument',
        ...contract.usage,
        '',
      ].join('\n'),
    );
    return 2;
  }

  const spinePath = resolve(spineArg);
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
  const contract = ROUTER_VERB_CONTRACTS['closed-by'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;
  if (args.length < 1) {
    process.stderr.write(
      [
        'error: closed-by requires one argument',
        ...contract.usage,
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
  const contract = ROUTER_VERB_CONTRACTS['detect-host'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;
  if (args.length < 1) {
    process.stderr.write(
      [
        'error: detect-host requires one argument',
        ...contract.usage,
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
  // The spine path and the branch literal, read THROUGH the contract — so
  // `--spine` (canonical, ADR-0051 decision 5) and `--wave` (its alias, the
  // spelling every existing `wave-close` call-site still uses) both resolve
  // here, and neither can be confused with another flag's value.
  const contract = ROUTER_VERB_CONTRACTS['worktree-cleanup'];
  const waveSpinePath = flag(args, contract, 'spine') ?? null;
  const branchesLiteral = flag(args, contract, 'branches') ?? null;

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
        `--spine: could not read spine "${absSpine}": ${(err as Error).message}`,
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
        `--spine: no branch scope could be derived from spine "${absSpine}" — ` +
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
 * Read everything `worktree-cleanup` can learn about the wave it was scoped by
 * from `--wave <spine-path>` (issue #732 for the row ids, issue #748 for the
 * terminality verdict, the slug and the waves directory) — or the fail-closed
 * {@link UNDECLARED_WAVE_SCOPE} when no spine was supplied.
 *
 * The refs this feeds are keyed by ROW ID, not by branch name, so the branch set
 * {@link resolveBranchFilter} returns cannot answer the question: a Reviewer
 * fetches `origin <branch>` into `refs/review/<id>`, and the id is the spine's
 * own row key. `requireBranchesByIssueId(readSpine(...))` is keyed by exactly
 * that key, verbatim and unparsed (a row id is OPAQUE, ADR-0001), so the map's
 * KEYS are the answer where its VALUES are the branch filter's.
 *
 * It reads the spine a second time rather than widening `resolveBranchFilter`'s
 * return shape, deliberately: that function's ONE job is to narrow the cleanup
 * scope and its fail-closed contract is load-bearing (issue #141 — an empty
 * filter used to mean "clean every worktree in the repo, including a sibling
 * wave's"). Reading twice costs one small file parse; re-plumbing a
 * safety-critical function to carry a second, unrelated payload does not.
 *
 * THE TERMINAL WAVE (issue #748). A wave every row of which has finished is
 * still a DECLARED wave — it simply has no live row left, so its own refs and
 * its own composed drivers are residue and this run may sweep them. Until now
 * it could not: every ref a wave produces belongs to one of its own rows, so at
 * its own close all ten were skipped `live-row` and became sweepable only at
 * the NEXT wave's close. The verdict is WAVE-level, never per-row — see
 * {@link TERMINAL_ROW_STATES} and the sweep's own `liveRowsDeclared` doc.
 *
 * FAIL CLOSED, same as its sibling, and in exactly the same direction as
 * before. Any outcome that leaves no id — no `--wave` at all, an unreadable
 * spine, a reader that yields nothing — returns `declared: false`, which the
 * sweeps read as "the live wave is unknown" and answer by removing NOTHING
 * (every ref skipped `live-rows-unknown`; every driver directory `unknown-wave`
 * or `live-wave`). It never throws: a spine that is genuinely broken has
 * already been refused by `resolveBranchFilter`, which runs first and turns it
 * into an exit-2 usage error; there is no path on which this function is the
 * one to discover it, and a second throw here could only ever turn one message
 * into two.
 */
function resolveLiveWaveScope(args: string[], repoRoot: string): LiveWaveScope {
  // Same contract read as `resolveBranchFilter` — `--spine` or its `--wave`
  // alias — so the two functions cannot disagree about which spine this run is
  // scoped to.
  const waveSpinePath =
    flag(args, ROUTER_VERB_CONTRACTS['worktree-cleanup'], 'spine') ?? null;
  if (waveSpinePath === null) return UNDECLARED_WAVE_SCOPE;

  const absSpine = resolve(repoRoot, waveSpinePath);
  try {
    const spine = readSpine(readFileSync(absSpine, 'utf-8'));
    const ids = Object.keys(requireBranchesByIssueId(spine));
    if (ids.length === 0) return UNDECLARED_WAVE_SCOPE;
    // WAVE-level terminality, never per-row (ADR-0042 Amendment decision 10).
    // A per-row rule would sweep a finished sibling's `refs/sib/<id>` out from
    // under a Worker still running the merge-tree prediction against it, so the
    // question is asked of the whole Plan-Table at once: either every row has
    // reached a terminal state and the wave's residue is sweepable, or none of
    // it is.
    //
    // `row.state` is the spine reader's UNVALIDATED cell text
    // (`RowState | string`), so the typed constant is widened at this one call
    // site rather than being kept as an untyped local copy (issue #772). An
    // unrecognized state is simply absent from the set and reads NON-terminal,
    // which is the safe direction: the wave stays live and its residue spared.
    const terminal =
      spine.planTable.length > 0 &&
      spine.planTable.every((row) =>
        (TERMINAL_ROW_STATES as ReadonlySet<string>).has(row.state),
      );
    return {
      declared: true,
      terminal,
      liveRowIds: terminal ? [] : ids,
      slug: basename(absSpine, '.md'),
      wavesDir: dirname(absSpine),
      // Per ROW, and from the whole Plan-Table rather than the branch-keyed
      // map above (issue #961): a stamped probe's liveness is its own row's
      // state (ADR-0042 Amendment 2026-09-23 decision 13), and every row the
      // table names is a row a Reviewer could have been dispatched for.
      rowStates: new Map(spine.planTable.map((row) => [row.id, String(row.state)])),
      // And each row's `Iter` as the reader parsed it (issue #974): a probe is
      // live only at its row's CURRENT iteration, because the spine never
      // records `reviewing` and the state alone cannot tell a running
      // Reviewer's probe from the previous iteration's. Handed over verbatim —
      // a non-numeric cell is the planner's to fail closed on, not ours to fix.
      rowIters: new Map(spine.planTable.map((row) => [row.id, row.iter])),
    };
  } catch {
    return UNDECLARED_WAVE_SCOPE;
  }
}

/**
 * The spine the stamped-probe sweep resolves ownership against (issue #961),
 * from the one `--spine` read {@link resolveLiveWaveScope} already made — or
 * `undefined` when none was declared, which the sweep reads as fail-closed:
 * every probe is `unknown-wave` and nothing is removed.
 */
function probeSpineOf(scope: LiveWaveScope): StampedProbeSpine | undefined {
  return scope.declared && scope.slug !== null
    ? { slug: scope.slug, rowStates: scope.rowStates, rowIters: scope.rowIters }
    : undefined;
}

/**
 * What `worktree-cleanup` could learn about the wave it was scoped by
 * (issue #748) — the input BOTH the review-ref sweep and the composed-driver
 * sweep read, derived once from the `--wave` spine.
 */
interface LiveWaveScope {
  /**
   * `true` when a `--wave` spine was read and its rows resolved. `false` is the
   * fail-closed state: no spine, an unreadable one, or a reader that yielded
   * nothing.
   */
  declared: boolean;
  /** `true` when EVERY Plan-Table row of that spine is in a terminal state. */
  terminal: boolean;
  /**
   * The rows this run must not touch: every row id on a live wave, and the
   * EMPTY list on a terminal one (declared, and legitimately empty — see
   * `ReviewRefPlanOptions.liveRowsDeclared`).
   */
  liveRowIds: string[];
  /** The spine's own slug (its filename without `.md`), or `null` when undeclared. */
  slug: string | null;
  /**
   * Absolute directory the spine was read from, or `null` when undeclared. It
   * is where the composed-driver sweep looks for OTHER waves' spines and for
   * the archive location beside them — derived from the path the caller
   * actually passed rather than from a second, independently-defaulted guess,
   * so a standalone run and a close ceremony agree even in a consumer that
   * keeps its spines somewhere other than the default.
   */
  wavesDir: string | null;
  /**
   * Every Plan-Table row id → its `State` cell (issue #961) — the per-row
   * liveness the stamped-probe sweep reads. Empty when undeclared.
   */
  rowStates: ReadonlyMap<string, string>;
  /**
   * Every Plan-Table row id → its `Iter` cell as the spine reader parsed it
   * (issue #974) — the other half of that liveness: a probe is live only at
   * its row's current iteration. Empty when undeclared.
   */
  rowIters: ReadonlyMap<string, number | string>;
}

/** The fail-closed answer: nothing declared, nothing terminal, nothing spared. */
const UNDECLARED_WAVE_SCOPE: LiveWaveScope = {
  declared: false,
  terminal: false,
  liveRowIds: [],
  slug: null,
  wavesDir: null,
  rowStates: new Map(),
  rowIters: new Map(),
};

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
 * `--orphans` ALSO carries the composed-driver sweep (issue #748) under
 * `orphans.drivers`, on both shapes and under the same one-plan discipline: the
 * `ComposedDriverSweepPlan` (`dir`, `present`, `wavesDir`, `selected`,
 * `skipped`) under `--dry-run`, the `ComposedDriverSweepResult` (`removed`,
 * `skipped`, `errors` beside those three) on the real run. It is the DIRECTORY
 * half of the location `orphans.scratch` already owns the FILES of: the Scribe
 * allowlist is on the payload name and only ever removes a file, so the
 * per-wave `<slug>/` directory `compose-driver` writes its Workflow script into
 * was reported `not-a-scribe-payload` and swept by nothing, one directory per
 * wave. A directory is removed only when its wave is finished — the `--wave`
 * spine's every row terminal, or its spine already in the archive location —
 * and is otherwise skipped `live-wave` (a spine exists and is not finished) or
 * `unknown-wave` (no spine answers for it: reported, never touched). A
 * non-empty `orphans.drivers.errors` drives exit 1 on the same reading as its
 * scratch sibling.
 *
 * `branchHygieneDeferred` rides beside `branchesDeleted`/`branchHygieneSkipped`
 * on the real run, and inside `orphanBranches` on the preview (issue #748): the
 * branches this sweep would decide about but that a still-registered worktree
 * holds. Branch hygiene fires on "worktree gone", so on a sandboxed harness —
 * where every worktree survives the removal call — the first run's branch list
 * is EMPTY and, until this key, nothing said twelve branches were pending
 * behind it rather than absent. Accounting only: it is never a term in the exit
 * verdict, exactly as `unaccounted` is not.
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
 * `probes` (issue #961, ADR-0042 Amendment 2026-09-23) rides EVERY run, with
 * no flag: stamped Reviewer probe checkouts, wherever they sit — the plan on
 * `--dry-run`, the executed `CleanupResult` on the run — removed unless the
 * `--spine` spine shows the probe's row running (`dispatched`, `re-dispatched`,
 * `reviewing`) at the stamp's own iteration or an `Iter` cell it cannot compare
 * (ADR-0042 Correction 2026-09-25, issue #974), and otherwise named with a
 * skip reason. No flag because the close's ordinary
 * call must reach it (decision 14: the close collects what routing missed),
 * and because it fails closed without a spine. `--probes-only` is the one
 * narrowing: the Coordinator's routing-step call, handled by
 * {@link runStampedProbeSweepAlone}.
 *
 * Idempotent: a re-run after everything is cleaned reports an empty plan and
 * exits 0 (nothing selected → nothing removed).
 *
 * Exit codes:
 *   0 — success (incl. nothing-to-do)
 *   1 — a removal error, a deregistered-but-not-deleted directory, an
 *       errored-yet-still-listed worktree (FOR-73) — from the registered GC OR
 *       (issue #238) from the `--detached` sweep OR (issue #961) the
 *       stamped-probe sweep, which ride the same three
 *       classes — an orphan-sweep removal error, (issue #417) a
 *       Scribe-scratch payload-removal error under `orphans.scratch.errors`,
 *       or (issue #748) a composed-driver directory-removal error under
 *       `orphans.drivers.errors`
 *   2 — usage / unexpected error, or `--probes-only` with a widening flag
 */
function runWorktreeCleanup(args: string[]): number {
  const contract = ROUTER_VERB_CONTRACTS['worktree-cleanup'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  // This verb's own unknown-flag list — the two `Set`s that used to live here,
  // one naming the value-less flags and one the value-taking ones — is gone,
  // folded into the ONE refusal path (ADR-0051 decision 4). The contract states
  // per flag whether it consumes the next token, which is what those Sets
  // encoded, and `--config <path>` stays accepted (FOR-87, W25-F2: every
  // sibling verb tolerates the uniform Coordinator-wrapper flag, and its value
  // is loaded below — issue #184 — rather than consumed and discarded).
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;

  const dryRun = hasFlag(contract, args, 'dry-run');
  const orphans = hasFlag(contract, args, 'orphans');
  const detached = hasFlag(contract, args, 'detached');
  const probesOnly = hasFlag(contract, args, 'probes-only');
  const positional = positionalsOf(contract, args);
  const repoRoot =
    positional.length > 0 ? resolve(positional[0]) : process.cwd();

  // `--probes-only` (issue #961) NARROWS a run to the stamped-probe population,
  // so a flag that WIDENS it is a contradiction, refused before anything is
  // read. Silently dropping one would be the fail-open shape issue #141 closed
  // for the scoping flags: the caller asked for two things and got one.
  if (probesOnly) {
    const widening = [
      ...(orphans ? ['--orphans'] : []),
      ...(detached ? ['--detached'] : []),
      ...(flag(args, contract, 'branches') !== undefined ? ['--branches'] : []),
    ];
    if (widening.length > 0) {
      process.stderr.write(
        'error: worktree-cleanup --probes-only runs the stamped-probe population alone; ' +
          `it cannot be combined with ${widening.join(', ')}\n`,
      );
      return 2;
    }
  }

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
  const configPath = flag(args, contract, 'config');
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
    // Runs in BOTH modes: under `--probes-only` its filter is unused, but its
    // refusal is not — an unreadable or branchless `--spine` is exit 2 here
    // exactly as it is on the full sweep, never a quiet "nothing removed".
    const branchFilter = resolveBranchFilter(args, repoRoot);
    if (probesOnly) {
      return runStampedProbeSweepAlone(args, repoRoot, dryRun, disposableNames);
    }
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

    // The review-ref sweep (issue #732) rides the SAME `--orphans` flag and
    // reports under the SAME `orphans` key as the scratch sweep, and its plan is
    // computed HERE, above the `--dry-run` branch, for exactly that sweep's
    // reason: preview and execution must share ONE plan object rather than two
    // calls that happen to agree.
    //
    // A FIFTH population, and the first that is not a path at all: the
    // `refs/review/<id>`, `refs/review/sib/<id>`, `refs/review/base/<id>`
    // (issue #978) and `refs/sib/<id>` refs a Reviewer fetches a branch tip
    // into. They outlive the worktree (removed above), the local branch (swept
    // below) and the remote branch (deleted by the merge), and no pass in this
    // verb previously reached a ref namespace at all — 187 of them had
    // accumulated in one shared `.git` before a human swept them by hand with
    // `git update-ref -d`.
    //
    // Scoped by `liveRowIds`, derived from the SAME `--wave` spine the branch
    // filter is derived from — see `resolveLiveRowIds` for why the ids come from
    // the spine's KEYS rather than from the branch names. Absent a spine the set
    // is undefined and the sweep FAILS CLOSED: it removes nothing and reports
    // every ref skipped `live-rows-unknown`, which is the only honest answer when
    // this run cannot tell its own wave's refs from a sibling wave's.
    //
    // Read BEFORE any removal, harmlessly: ref namespaces are disjoint by
    // construction from every worktrees root and from the scratch directory, so
    // nothing this verb removes can change what this listing saw.
    // ONE read of the `--wave` spine, feeding EVERY scoped population (issue
    // #748): the review-ref sweep below and the composed-driver sweep beside
    // it, and (issue #961) the stamped-probe sweep further down. Reading it
    // once is not merely thrift — they must agree about the wave's state, and
    // two independent reads could disagree if the spine were rewritten between
    // them. Read on every run now, not only under `--orphans`, because the
    // probe population needs no flag; the two `--orphans` populations still
    // consult it only when that flag is set, so nothing they do moves.
    const waveScope = resolveLiveWaveScope(args, repoRoot);
    const reviewRefPlan = orphans
      ? planReviewRefSweep(
          listReviewRefs({ repoRoot }),
          waveScope.declared ? waveScope.liveRowIds : undefined,
          // A TERMINAL wave declares an EMPTY live set and means it, which is
          // the one thing the id list alone cannot say (an accidentally-empty
          // list must keep failing closed). On a LIVE wave this flag is `true`
          // as well and changes nothing — the non-empty id list already made
          // the set known.
          { liveRowsDeclared: waveScope.declared },
        )
      : null;

    // The composed-driver sweep (issue #748) — the SIXTH population, and the
    // other half of the scratch directory the Scribe sweep above already owns.
    // That sweep removes only FILES matching the payload name, so the per-wave
    // `<slug>/` directory `compose-driver` writes its Workflow script into was
    // reported `not-a-scribe-payload` and left standing, one directory per
    // wave, swept by nothing — while both wave-start references promised it was
    // swept at close.
    //
    // Computed HERE, above the `--dry-run` branch, for the issue #377 reason
    // its file-sweeping sibling is: ONE plan object, printed by the preview and
    // executed verbatim by the real run, so the two cannot disagree.
    //
    // `wavesDir` comes from the `--wave` path the caller actually passed, so a
    // standalone run and a close ceremony agree about where spines live even in
    // a consumer that keeps them somewhere other than the engine's default; the
    // archive location the sweep reads is derived from that same directory.
    // `terminalSlugs` carries at most the ONE slug this run was scoped by —
    // every other directory is resolved from the filesystem alone (archived →
    // removed, a live spine → `live-wave`, no spine at all → `unknown-wave`,
    // reported and never touched).
    //
    // Read BEFORE any removal, and harmlessly: the scratch root is disjoint by
    // construction from every worktrees root this verb sweeps.
    const driverPlan = orphans
      ? planComposedDriverSweep(
          listComposedDriverDirs(repoRoot, {
            wavesDir: waveScope.wavesDir ?? undefined,
            terminalSlugs:
              waveScope.terminal && waveScope.slug !== null ? [waveScope.slug] : [],
          }),
        )
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
    const gcPlanned = new Set(
      [...plan.selected, ...plan.skipped].map((wt) => wt.path),
    );

    // The stamped-probe sweep (issue #961, ADR-0042 Amendment 2026-09-23) —
    // the SEVENTH population, and the one no containment root admits: a
    // Reviewer's probe checkout lives outside the repository, and the stamp
    // `flotilla-probe-<wave-slug>-<row-id>-i<iteration>` stands in for a root.
    //
    // NO FLAG, deliberately. The population is safe by construction — the
    // stamp admits only what flotilla named, the detached sweep's refusals
    // apply verbatim, and ownership fails CLOSED: without a `--spine` every
    // probe is `unknown-wave` and nothing is removed. So the close's ordinary
    // call reaches it (decision 14: the close collects whatever routing
    // missed), and a run that is not scoped to a wave still ACCOUNTS for every
    // stamped probe by name instead of leaving it in `unaccounted`.
    //
    // Computed HERE, above the `--dry-run` branch, for the issue #377 reason:
    // ONE plan, printed by the preview and executed verbatim by the run.
    // De-duplicated against the registered-GC plan, the way the detached sweep
    // is; the detached sweep is in turn de-duplicated against THIS plan, so a
    // stamped probe inside a containment root is judged by its row's liveness
    // rather than removed by a sweep that cannot ask the question.
    const probePlan = planStampedProbeSweep(
      listStampedProbeWorktrees({ repoRoot, disposableNames }).filter(
        (wt) => !gcPlanned.has(wt.path),
      ),
      probeSpineOf(waveScope),
    );

    const alreadyPlanned = new Set([
      ...gcPlanned,
      ...[...probePlan.selected, ...probePlan.skipped].map((wt) => wt.path),
    ]);
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
    //
    // `reviewRefPlan` is the one population above that is deliberately NOT
    // folded in, and its absence is a decision rather than the oversight this
    // comment warns about: the reconciliation reconciles `git worktree list`'s
    // COUNT against the worktree PATHS this run enumerated, and a ref has no
    // path and is not a worktree. Joining it would add names to a set whose
    // whole meaning is "registered worktrees nothing here claimed".
    //
    // `driverPlan` is not folded in either, and for the OTHER reason: its
    // entries are paths, but they are the SAME paths `scratchPlan` already
    // contributes. A `<slug>/` directory is enumerated by both populations —
    // the Scribe sweep reports it `not-a-scribe-payload` (correctly: it is not
    // a payload) and the driver sweep decides about it — so joining it here
    // would list every one of them twice in a set whose only job is to be a
    // union. Nothing is missing from the accounting; the same path is simply
    // declared once rather than twice (issue #748).
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
      // Every stamped probe, selected OR skipped (issue #961): a skip is still
      // accounting — the probe is named under `probes.skipped` with its reason —
      // so it must not ALSO read as something no population claimed.
      ...[...probePlan.selected, ...probePlan.skipped].map((wt) => wt.path),
    ];
    const countAdvisory = checkWorktreeCountAdvisory({ repoRoot, accountedPaths });
    // `advisory` carries `WorktreeCountAdvisory.message` VERBATIM — the engine
    // owns that wording (the E2BIG shape, the subagent scope, the
    // cleanup-plus-RESTART recovery), and this boundary never paraphrases it.
    // count/threshold/level ride alongside as their own named fields so a
    // consumer never has to re-derive the verdict from the prose.
    const worktreeCount = worktreeCountJson(countAdvisory);

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
    const commandLine = commandLineJson(cmdlineAdvisory);

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
                    // The SAME `reviewRefPlan` object the real run hands to
                    // `executeReviewRefSweep` (issue #732), carried WHOLE —
                    // `namespaces` and `liveRowIds` included, so a preview that
                    // selects nothing says WHY: because the namespaces held no
                    // ref, because every ref belongs to a live row, or because
                    // no spine named the live rows at all (`liveRowIds: null`).
                    ...(reviewRefPlan !== null
                      ? { reviewRefs: reviewRefPlan }
                      : {}),
                    // The SAME `driverPlan` object the real run hands to
                    // `executeComposedDriverSweep` (issue #748), carried WHOLE
                    // — `dir`, `present` and `wavesDir` included, so a preview
                    // that selects nothing says WHY: because the scratch root
                    // held no per-wave directory, because every one of them
                    // belongs to a wave that is still live, or because no spine
                    // under `wavesDir` answers for them at all.
                    ...(driverPlan !== null ? { drivers: driverPlan } : {}),
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
            // The SAME `probePlan` the real run executes (issue #961) — never
            // conditional, since the population needs no flag.
            probes: { selected: probePlan.selected, skipped: probePlan.skipped },
            ...(orphanBranchPlan !== null
              ? {
                  orphanBranches: {
                    toDelete: orphanBranchPlan.toDelete,
                    branchHygieneSkipped: orphanBranchPlan.branchHygieneSkipped,
                    // Issue #748 — what this sweep is WAITING on, previewed
                    // beside what it would delete. An empty `toDelete` on a
                    // sandboxed harness is the ordinary first reading, and
                    // without this key nothing said the branches were pending
                    // rather than absent.
                    branchHygieneDeferred: orphanBranchPlan.branchHygieneDeferred,
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

    // Execute EXACTLY the `reviewRefPlan` object the `--dry-run` branch prints
    // (issue #732). `repoRoot` IS passed, unlike the two calls above: a ref has
    // no absolute path for the plan entry to carry, so the deleting seam has to
    // be pointed at the repository whose `.git` holds it. Reported under
    // `orphans.reviewRefs` — additive to the orphan-DIRECTORY numbers and never
    // merged into them, the same reasoning that keeps `orphans.scratch` and
    // `detached` under their own keys: a `live-row` refusal read as an
    // orphan-directory skip would be actively misleading.
    const reviewRefResult =
      reviewRefPlan !== null
        ? executeReviewRefSweep(reviewRefPlan, { repoRoot })
        : null;

    // Execute EXACTLY the `driverPlan` object the `--dry-run` branch prints
    // (issue #748). `disposableNames` is threaded so the default remover's
    // ENOTEMPTY junk purge honours the consumer's own declaration, exactly as
    // the registered GC and the orphan-directory sweep above do; no `repoRoot`
    // is needed, because a plan entry already carries its absolute path.
    const driverResult =
      driverPlan !== null
        ? executeComposedDriverSweep(driverPlan, { disposableNames })
        : null;

    // Execute EXACTLY the `detachedPlan` object the `--dry-run` branch above
    // prints — same `executeCleanup` as every other removal path, so the
    // bounded retry, the incomplete-removal classification and local-branch
    // hygiene are inherited rather than reimplemented.
    const detachedResult =
      detachedPlan !== null
        ? executeCleanup(detachedPlan, { repoRoot, disposableNames })
        : null;

    // Execute EXACTLY the `probePlan` the `--dry-run` branch prints (issue
    // #961), through the same `executeCleanup` — the bounded retry and the
    // incomplete-removal classes are inherited, not reimplemented.
    const probeResult = executeCleanup(probePlan, { repoRoot, disposableNames });

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
      ...probeResult.branchesDeleted,
      ...(orphanBranchResult?.branchesDeleted ?? []),
    ];
    const branchHygieneSkipped = [
      ...result.branchHygieneSkipped,
      ...(detachedResult?.branchHygieneSkipped ?? []),
      ...probeResult.branchHygieneSkipped,
      ...(orphanBranchResult?.branchHygieneSkipped ?? []),
    ];
    // Issue #748 — the third member of that same family, folded the same way.
    // Only the standalone orphan-BRANCH sweep can produce a deferral (the
    // per-removal hygiene inside `executeCleanup` runs after a removal that
    // already succeeded, so no worktree is holding the branch by then), which
    // is why this list has exactly one source where the two above have three.
    // It is spelled as a fold anyway rather than as a direct read, so a future
    // second producer joins here instead of growing a parallel key nobody
    // reads — the reasoning the pair above already carries.
    const branchHygieneDeferred = [
      ...(orphanBranchResult?.branchHygieneDeferred ?? []),
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
          branchHygieneDeferred,
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
                  // The review-ref sweep's own whole result (issue #732) —
                  // `removed` / `skipped`-with-reason / `errors`, plus the
                  // `namespaces` it looked under and the `liveRowIds` it spared.
                  // A reader can tell what was found, what was removed, and what
                  // was left and why, without re-deriving any of it.
                  ...(reviewRefResult !== null
                    ? { reviewRefs: reviewRefResult }
                    : {}),
                  // The composed-driver sweep's own whole result (issue #748)
                  // — `removed` / `skipped`-with-reason / `errors`, plus the
                  // `dir`, `present` and `wavesDir` it resolved against. Under
                  // its own key rather than merged into the Scribe payload
                  // numbers beside it, for the same reason every sibling
                  // population here keeps one: an `unknown-wave` refusal read
                  // as a `not-a-scribe-payload` refusal would be actively
                  // misleading.
                  ...(driverResult !== null ? { drivers: driverResult } : {}),
                },
              }
            : {}),
          // The detached sweep's own CleanupResult, reported whole (removed /
          // skipped-with-reason / errors / both ENOTEMPTY-family classes) under
          // its own key rather than merged into the registered-GC numbers: the
          // populations answer different questions, and a `live-branch` skip
          // read as a GC skip would be actively misleading.
          ...(detachedResult !== null ? { detached: detachedResult } : {}),
          // The stamped-probe sweep's own CleanupResult (issue #961), whole and
          // under its own key: a `live-row` or `unknown-wave` skip read as a GC
          // or detached skip would be actively misleading.
          probes: probeResult,
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
    //
    // `orphans.reviewRefs.errors` joins the list on the same reading (issue
    // #732): a ref this run selected and then failed to delete is exactly as
    // incomplete an outcome as a directory it failed to remove. This is not a
    // change to the shipped exit contract in the sense ADR-0035 guards — the
    // pass is new, so no run that exits 0 today can start exiting 1 because of
    // it, and its REFUSALS (`live-row`, `unresolvable-row`,
    // `live-rows-unknown`) are deliberately NOT terms here: a refusal is
    // something this sweep decided not to do, never something it tried and did
    // not finish, and the standing rule (ADR-0042, and `unaccounted` directly
    // above) is that accounting is reported loudly and never made fatal.
    const anyFailure =
      result.errors.length > 0 ||
      result.deregisteredNotDeleted.length > 0 ||
      result.erroredStillListed.length > 0 ||
      (orphanResult !== null && orphanResult.errors.length > 0) ||
      (scratchResult !== null && scratchResult.errors.length > 0) ||
      (reviewRefResult !== null && reviewRefResult.errors.length > 0) ||
      // `orphans.drivers.errors` joins on the identical reading (issue #748): a
      // per-wave scratch directory this run selected and then failed to remove
      // is exactly as incomplete an outcome as a directory or a payload it
      // failed to remove. Not a change to the shipped exit contract in the
      // sense ADR-0035 guards — the pass is new, so no run that exits 0 today
      // can start exiting 1 because of it — and its REFUSALS (`live-wave`,
      // `unknown-wave`) are deliberately NOT terms here, exactly as the
      // review-ref refusals above are not.
      (driverResult !== null && driverResult.errors.length > 0) ||
      (detachedResult !== null &&
        (detachedResult.errors.length > 0 ||
          detachedResult.deregisteredNotDeleted.length > 0 ||
          detachedResult.erroredStillListed.length > 0)) ||
      // The stamped-probe sweep rides the same three incomplete-outcome classes
      // (issue #961), joining on the reading the review-ref and driver sweeps
      // joined on: a removal this run SELECTED and did not finish is exactly as
      // incomplete as any other. Only an attempted removal can move the exit —
      // its REFUSALS (`live-row`, `unknown-wave` and the detached four) are
      // accounting and are never terms here.
      stampedProbeRunFailed(probeResult);
    return anyFailure ? 1 : 0;
  } catch (err) {
    process.stderr.write(
      `error: worktree-cleanup failed: ${(err as Error).message}\n`,
    );
    return 2;
  }
}

/**
 * `worktree-cleanup --probes-only` (issue #961, ADR-0042 Amendment 2026-09-23
 * decision 14) — the stamped-probe population ALONE, for the one caller that
 * must not run anything else: the Coordinator, collecting a round's probes
 * right after it routes the round's verdicts, mid-wave. The full sweep there
 * would also run the registered GC over the wave's own branches, and on a
 * sandboxed harness every Worker worktree it selected would read EXHAUSTED and
 * turn each routing call red.
 *
 * Its own shape — `{ dryRun, probesOnly, probes, worktreeCount, commandLine }`
 * — because a GC key printed here would claim a pass that never ran.
 * `unaccounted` is left out on the reasoning `checkWorktreeCountAdvisory`
 * gives a preflight: a run that enumerates ONE population by design would name
 * every other registration as unaccounted, which is noise, not a finding. The
 * two E2BIG advisories stay, since neither ever needs a flag to be remembered.
 *
 * Exit 1 exactly when a SELECTED probe did not finish its removal (the three
 * incomplete-outcome classes); every refusal is accounting and exits 0.
 */
function runStampedProbeSweepAlone(
  args: string[],
  repoRoot: string,
  dryRun: boolean,
  disposableNames: readonly string[] | undefined,
): number {
  const probePlan = planStampedProbeSweep(
    listStampedProbeWorktrees({ repoRoot, disposableNames }),
    probeSpineOf(resolveLiveWaveScope(args, repoRoot)),
  );
  // Read BEFORE any removal, as on the full sweep, so the preview and the run
  // report the same starting population.
  const worktreeCount = worktreeCountJson(checkWorktreeCountAdvisory({ repoRoot }));
  const commandLine = commandLineJson(checkCommandLineSizeAdvisory());

  if (dryRun) {
    printJson({
      dryRun: true,
      probesOnly: true,
      probes: { selected: probePlan.selected, skipped: probePlan.skipped },
      worktreeCount,
      commandLine,
    });
    return 0;
  }

  const probeResult = executeCleanup(probePlan, { repoRoot, disposableNames });
  printJson({
    dryRun: false,
    probesOnly: true,
    probes: probeResult,
    worktreeCount,
    commandLine,
  });
  return stampedProbeRunFailed(probeResult) ? 1 : 0;
}

/**
 * Did the stamped-probe sweep leave a SELECTED probe incompletely removed
 * (issue #961)? The same three classes the detached sweep's term reads.
 */
function stampedProbeRunFailed(result: ReturnType<typeof executeCleanup>): boolean {
  return (
    result.errors.length > 0 ||
    result.deregisteredNotDeleted.length > 0 ||
    result.erroredStillListed.length > 0
  );
}

/**
 * `worktreeCount` as `worktree-cleanup` prints it (issue #238). `advisory`
 * carries `WorktreeCountAdvisory.message` VERBATIM — the engine owns that
 * wording (the E2BIG shape, the subagent scope, the cleanup-plus-RESTART
 * recovery), and this boundary never paraphrases it; count/threshold/level
 * ride alongside so a consumer never re-derives the verdict from the prose.
 * One function, so the full sweep and `--probes-only` cannot print two shapes.
 */
function worktreeCountJson(adv: ReturnType<typeof checkWorktreeCountAdvisory>): {
  count: number;
  threshold: number;
  level: 'ok' | 'advisory';
  advisory: string | null;
} {
  return {
    count: adv.count,
    threshold: adv.threshold,
    level: adv.level,
    advisory: adv.message,
  };
}

/**
 * `commandLine` as `worktree-cleanup` prints it (issue #266) — the OTHER term
 * of the same exec argument budget, with the engine's text verbatim in
 * `advisory`, exactly as `worktreeCount.advisory`.
 *
 * `maxEntryBytes`/`maxEntryThreshold` are the PER-STRING term's two numbers
 * (issue #340's second condition, surfaced by issue #377). PURELY ADDITIVE:
 * `bytes`/`threshold` are still the TOTAL pair, and nothing is re-pointed at
 * the per-string term. Without them the CLI printed the per-string VERDICT —
 * folded into `level`, stated in the verbatim `advisory` prose — while
 * withholding the two numbers a machine reader needs to act on it: the same
 * "ships the correction's premise, withholds the correction" shape the barrel
 * gap (issue #357) closed one layer up. `maxEntryBytes` is the single LARGEST
 * argv/env entry; `maxEntryThreshold` the effective MAX_ARG_STRLEN budget it
 * was compared against — execve's OTHER, independent E2BIG condition, which
 * fires on its own even when the total sits comfortably under budget.
 *
 * Byte counts only: the engine never returns an argument or a variable's name
 * or value, so nothing here can leak one into the JSON.
 */
function commandLineJson(adv: ReturnType<typeof checkCommandLineSizeAdvisory>): {
  bytes: number;
  argvBytes: number;
  envBytes: number;
  argCount: number;
  envCount: number;
  threshold: number;
  maxEntryBytes: number;
  maxEntryThreshold: number;
  level: 'ok' | 'advisory';
  advisory: string | null;
} {
  return {
    bytes: adv.bytes,
    argvBytes: adv.argvBytes,
    envBytes: adv.envBytes,
    argCount: adv.argCount,
    envCount: adv.envCount,
    threshold: adv.threshold,
    maxEntryBytes: adv.maxEntryBytes,
    maxEntryThreshold: adv.maxEntryThreshold,
    level: adv.level,
    advisory: adv.message,
  };
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
  const contract = ROUTER_VERB_CONTRACTS['verdict-acked'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;

  // Named twin (ADR-0051 decision 6): a sibling verb takes this directory and
  // this id as `--verdicts-dir`/`--id`, so this verb accepts them named as well
  // — canonically — while keeping the positional pair as their alias. A MIXED
  // call (`verdict-acked <dir> --id X`) is a usage error, because it reads to
  // its caller as though both halves landed.
  const twin = resolveTwin(contract, args);
  if (!twin.ok) {
    process.stderr.write([`error: ${twin.error}`, ...contract.usage, ''].join('\n'));
    return 2;
  }
  const verdictsDir = twin.values[0];
  const id = twin.values[1];
  if (verdictsDir === undefined || id === undefined) {
    process.stderr.write(
      [
        'error: verdict-acked requires <verdictsDir> <id>',
        ...contract.usage,
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
  const contract = ROUTER_VERB_CONTRACTS['render-verdict'];
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;
  // `--json` is ACCEPTED AND IGNORED here, and that is the output class doing
  // its job rather than an omission (ADR-0051 decision 7, row V5). This verb is
  // class `product`: the markdown it prints is the artifact a PR body carries,
  // not a report about one, so there is no second machine-readable rendering of
  // it to offer. Wrapping the markdown in a JSON string would hand a caller the
  // same bytes with an escaping problem added. Nothing below reads the flag —
  // the router-global declaration is the whole of its acceptance.

  // Named twin (ADR-0051 decision 6), same as `verdict-acked` above. `--anchor`
  // is NOT part of the twin: it has no positional spelling on any verb, so it
  // is always named and never participates in the all-named/all-positional rule.
  const twin = resolveTwin(contract, args);
  if (!twin.ok) {
    process.stderr.write([`error: ${twin.error}`, ...contract.usage, ''].join('\n'));
    return 2;
  }
  const verdictsDir = twin.values[0];
  const id = twin.values[1];
  const anchorSha = flag(args, contract, 'anchor');
  if (verdictsDir === undefined || id === undefined || anchorSha === undefined) {
    process.stderr.write(
      [
        'error: render-verdict requires <verdictsDir> <id> --anchor <sha>',
        ...contract.usage,
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
  const contract = ROUTER_VERB_CONTRACTS.version;
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  // This verb's own hand-rolled arg loop — one of the four private unknown-flag
  // lists ADR-0051 decision 4 folds into a single path — is gone. What it
  // enforced is unchanged: an unknown flag and a stray positional are both
  // usage errors, and both still exit 2. What it could not do, this path does:
  // name the nearest declared flag.
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;

  // The value-less `--expect` stays this verb's OWN check, and deliberately so:
  // it is not about a token the contract fails to declare, it is about a
  // DECLARED flag whose value went missing — the exact shape that turns a
  // version gate off when its input breaks (an unset shell variable, a `jq`
  // miss). `flag()` cannot tell it from the flag being absent, so the check is
  // positional and the message is this verb's.
  let expected: string | undefined;
  if (hasFlag(contract, args, 'expect')) {
    const value = flag(args, contract, 'expect');
    if (value === undefined || value.startsWith('--') || value.trim().length === 0) {
      return versionUsage(
        '--expect requires a <plugin-version> value — a value-less --expect is a caller whose lookup produced nothing, not a request to skip the check',
      );
    }
    expected = value;
  }

  const report = compareEngineVersion(expected);
  printJson(report);
  return engineVersionExitCode(report);
}

/**
 * The Catalog, off the router's own aggregate — every contract, verbatim.
 *
 * Two lines and no field list, which is the point: nothing here decides WHICH
 * parts of a contract the Catalog carries, so nothing here can fall behind the
 * contract. The one transformation is the SORT, and it is a presentation
 * decision rather than a content one — `verbContracts()` returns declaration
 * order (router verbs, then the delegated ones, then each group's ops), and a
 * consumer diffing two engine versions should not read a moved declaration as a
 * changed surface. The key it sorts by is the contract's own `verb`, which the
 * drift spec already holds equal to the aggregate key it is filed under.
 */
function catalogPayload(): Catalog {
  const verbs = Object.values(verbContracts()).sort((a, b) =>
    a.verb < b.verb ? -1 : a.verb > b.verb ? 1 : 0,
  );
  return { verb: 'catalog', verbs };
}

/**
 * Run the `catalog` subcommand — ADR-0051 decision 2's FOURTH reader of a Verb
 * contract, and the one 2.7.0 shipped without.
 *
 * Store-free, config-free and network-free, like `version` beside it: the
 * aggregate is built out of module constants, so this verb answers on a machine
 * where no wave config exists yet. That is also why its BARE form is its
 * primary one ({@link BARE_FORM_VERBS}) — there is no target to name.
 *
 * `--json` is accepted and changes nothing: the output class is already `json`,
 * and a verb whose only rendering is JSON has no second one to switch to.
 */
function runCatalog(args: string[]): number {
  const contract = ROUTER_VERB_CONTRACTS.catalog;
  if (helpRequested(contract, args)) return printVerbHelp(contract);
  const refusal = refuseUndeclared(contract, args);
  if (refusal !== 0) return refusal;
  printJson(catalogPayload());
  return 0;
}

function versionUsage(message: string): number {
  process.stderr.write(
    [
      `error: version: ${message}`,
      ...ROUTER_VERB_CONTRACTS.version.usage,
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

  // A BARE `--help` (ADR-0051 decision 7) — the whole-CLI usage, on stdout and
  // exit 0. Every VERB's own `--help` is answered by that verb's runner, from
  // its own contract, which is what keeps a help request from ever constructing
  // a store or a host; this case is only the no-verb one, where the router is
  // the thing being asked about.
  if (first === '--help') {
    process.stdout.write(usageLines().join('\n'));
    return 0;
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
    // {@link BARE_FORM_VERBS} are the exemptions — `version` (ADR-0032) and
    // `catalog` (ADR-0051) — and for the opposite reason worktree-cleanup lost
    // its: a bare call to either is that verb's PRIMARY form ("what version is
    // this engine?", "what does it accept?"), it performs no action at all, and
    // it is the invocation an operator reaches for when nothing else on the
    // machine is configured yet. Printing usage instead would make the verb
    // unusable exactly where it is needed most.
    //
    // What it prints, since issue #758, is THAT verb's own contract section —
    // not the whole-CLI block. Nineteen verbs used to answer a bare invocation
    // with a roster of every other verb in the engine; a caller who has already
    // named the one they want is owed its arguments, not the whole roster.
    // (This sentence read "not the catalog" until `catalog` became a verb of
    // its own; the Catalog is the contracts as DATA, not this prose block.)
    if (rest.length === 0 && !BARE_FORM_VERBS.has(first as Subcommand)) {
      if (VERB_GROUP_CONTRACTS[first] !== undefined) return printGroupUsage(first);
      return printVerbUsage(verbContracts()[first]);
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
      case 'catalog':
        // ADR-0051's Catalog. Sync and store-free for the same reason `version`
        // above is: the aggregate is built out of module constants, so nothing
        // has to be configured for this verb to answer.
        return runCatalog(rest);
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
      case 'close-row':
        // Same again: `close-row` resolves a store — the done-reconcile's whole
        // point is the tracker `close(id, prUrl, acked)` at the end of it — so
        // it is async and `mainAsync` intercepts it first. Reaching this case
        // means a caller invoked the sync `main(['close-row', ...])` path
        // directly.
        process.stderr.write(
          'error: close-row is async; invoke it via the async entrypoint (mainAsync) — e.g. the CLI binary, not the sync main()\n',
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
    // `runComposeDriver` gates `--help` and undeclared flags off its own
    // contract, exactly as every other runner does for itself.
    if (argv[0] === 'compose-driver') {
      return await runComposeDriver(argv.slice(1), injected);
    }
    // `route-tuple` is async twice over — it talks to the code HOST
    // (find-before-create, the status re-query) and it resolves a store (the
    // `in-review` rung transition) — so it is intercepted here like
    // `compose-driver` above. The interception bypasses `main()`'s zero-arg
    // guard, which is deliberate: a bare `route-tuple` has six required flags
    // and the runner's own usage names all six, which teaches far better than
    // the router's whole-CLI dump. `runRouteTuple` gates `--help` and
    // undeclared flags off its own contract, exactly as every other runner
    // does for itself.
    if (argv[0] === 'route-tuple') {
      return await runRouteTuple(argv.slice(1), injected ? { store: injected } : {});
    }
    // `close-row` resolves a store — the done-reconcile ends in the tracker's
    // own `close(id, prUrl, acked)` — so it is intercepted here like
    // `route-tuple` above. The interception bypasses `main()`'s zero-arg guard,
    // deliberately: a bare `close-row` has two required flags and the runner's
    // own usage names both, plus the refusal rule for a PR cell that is not a
    // real PR URL — which teaches far better than the router's whole-CLI dump.
    // `runCloseRow` gates `--help` and undeclared flags off its own contract,
    // exactly as every other runner does for itself.
    if (argv[0] === 'close-row') {
      return await runCloseRow(argv.slice(1), injected ? { store: injected } : {});
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
