---
name: wave-resume
description: Use when a wave Coordinator was killed mid-wave and you need to reconstruct state and resume — read the spine (WAL authority), reconcile against live worktrees + on-disk sidecars + merged PRs, re-project the coarse ledger, then re-dispatch only what the reconciler says. Triggers on "resume wave <slug>", "the coordinator died — pick up wave <slug>", "reconcile and resume".
---

# wave-resume

Reconstruct a wave's state after a Coordinator kill and resume it. The pure reconciler (`resume()`) reads three durable homes — the **spine** (WAL authority), the **live agent worktrees**, and the **on-disk sidecars** (reports/verdicts) — and returns a per-row `adopt`/`redispatch`/`keep`/`needs-attention` decision + a coarse rung. The `resume-cli` entrypoint then **crash-cleans every `redispatch` row** — unlocks + removes any stale worktree still checked out on that row's branch and deletes the stale branch itself — before printing, so a re-dispatch never collides with leftover debris from a crashed attempt (FOR-10; a dirty crashed worktree is never destroyed silently — see step 4). The skill then applies a **4th, skill-only input the pure reconciler cannot reach**: a PR-merge done-reconcile — a row whose PR merged during the kill is landed `done` via the existing `issue-store close` verb (the same wire `wave-close` uses; on a no-integration `states.doneState` workspace this fires the FOR-13 fallback), and a closed-unmerged PR is flagged `needs-attention`. It idempotently re-projects the coarse ledger onto the tracker — and does **all of this BEFORE any re-dispatch**.

Load **wave-shared** by name first — it owns the auth-preflight / atomic-spine conventions this skill obeys (every tracker write goes through the engine seam, never raw `gh`).

Your job is the **judgment** — deriving the sidecar dirs, ordering the reconcile-before-dispatch, the done-reconcile decision, and turning corrupt/orphan sidecars into the right flag. The CLI plumbing (exact invocations, the `ResumeResult` shape, exit codes, the separate `resume-cli` entrypoint) lives in [reference/resume-mechanics.md](reference/resume-mechanics.md). You never read the tracker INTO the reconstruction (the tracker claims are healed FROM it — one-way, ADR-0002).

## When to Use

- A wave Coordinator session was killed mid-wave and you are restarting it.
- A `Status: in-flight` spine exists and you are unsure which rows landed.

Do **not** use this to plan, materialise, or operationally close a wave. Resume is the recovery step; it hands a reconciled wave back to `wave-start`.

## THE FLOTILLA BOUNDARY — spine first, reconcile before dispatch, one-way heal

This ordering is **the** load-bearing invariant of the skill. Do them in this order, every time:

> **read spine (WAL authority) → enumerate worktrees → read sidecars → `resume-cli` → done-reconcile → re-project the coarse ledger → flag the fatals → ONLY THEN consider re-dispatch.**

- **Read the spine FIRST.** The spine is the write-ahead log (ADR-0002 WAL) — it is the authority for what rows the wave contains. Every other input refines a row the spine declares; nothing invents a row the spine doesn't have.
- **Reconcile BEFORE re-dispatch.** Reconstruct every row, re-project the coarse ledger, run the done-reconcile, and flag the orphans/corrupts — then and only then hand the `redispatch` rows to `wave-start`. **No row is re-dispatched until reconciliation completes.** Re-dispatching before reconciling can duplicate landed work.
- **needs-attention rows are PAUSED.** A row flagged needs-attention (corrupt/orphan sidecar, or a closed-unmerged PR) is **never** re-dispatched — it waits for a human disposition.
- **One-way heal.** The tracker claims are written FROM the reconstruction, never read INTO it. `resume()` never reads the tracker.

## Procedure

### 1. Load wave-shared + read the spine (WAL authority)

Load **wave-shared** first (auth-preflight + atomic-spine conventions). Then read the spine: `{{wave-cli}} spine read <spine-path>`. This establishes the row set + each row's last-flushed fine state. The spine path is `.flotilla/waves/<slug>.md`.

### 2. Derive the sidecar dirs BY CONVENTION

The reports/verdicts dirs are **not stored in the spine** — there is no `sidecarRoot` field (decided 2026-06-19). They are derived from the spine path by convention: for a spine at `.flotilla/waves/<slug>.md`, the sidecars live at `.flotilla/waves/<slug>/reports/` and `.flotilla/waves/<slug>/verdicts/`. Do not hunt for them; compute them from the slug.

> **These sidecars are verb-written at agent-return (ADR-0024) — resume finds them natively.** `wave-start`'s Scribe stages persist each report/verdict through `write-report`/`write-verdict` the moment its agent returns, in the exact fenced-json format the reconciler's reader (`sidecar.ts`) parses. So a Coordinator killed mid-wave leaves the durable records already on disk — the harness-workflow-journal bridge that rescued the first live gate (retro P-1) is **no longer needed**. `resume-cli` reads these dirs directly; there is no Coordinator-side sidecar backfill to run before resuming.

### 3. Enumerate live agent worktrees

`resume-cli` enumerates them for you via `listAgentWorktrees` (the `.claude/worktrees/agent-` + `wf_` allowlist) under `--repo-root`. Pass `--marker <m>` to narrow to this wave's per-wave marker when sibling waves are live; omit it to use the engine's default allowlist. The skill never parses `git worktree list` by hand — that is the engine's job.

### 4. Call the reconciler (its own entrypoint — NOT a `cli.ts` subcommand)

The reconciler has a **separate entrypoint**, `resume-cli.ts` — it is not an `{{wave-cli}}` subverb. Invoke it directly:

`npx tsx tools/wave/src/resume-cli.ts --spine <spine-path> --reports <reports-dir> --verdicts <verdicts-dir> --repo-root <consumer-root> [--marker <m>] [--force]` → `{ rows, fatals, cleanup }`.

Each `rows[]` entry carries `reconstructedState`, a `decision` (`adopt`/`redispatch`/`keep`/`needs-attention`), the `coarse` rung to re-project, the joined `worktree`, and the latest report/verdict + iters. `fatals[]` lists rows needing manual disposition (orphaned in-flight claim, corrupt sidecar). **Disk beats a non-landed spine flip** — a row's reconstructed state is whatever the newest sidecar proves, not what the spine claims. `resume-cli` is store-free: it reads only the spine + worktrees + sidecars and never touches the tracker.

**Crash-cleanup runs automatically as part of this call (FOR-10).** For every row whose `decision === 'redispatch'`, `resume-cli` unlocks + removes any live worktree still checked out on that row's branch and deletes the stale branch — BEFORE printing, so the JSON you read has already been made safe to re-dispatch. This is reported per-row in the `cleanup[]` array (`{ branch, worktreePath, worktreeRemoved, branchDeleted, blockedByDirty, notes }`). You never invoke `git worktree unlock/remove` or `git branch -D` by hand for a redispatch row — it is already done.

- **If `blockedByDirty: true` for a cleanup entry**, a crashed worktree has UNCOMMITTED CHANGES — it was left untouched (work-preservation: never destroy silently). Surface it to the human with the `worktreePath` and require explicit confirmation before re-running `resume-cli` with `--force` (which allows that one destructive step; it does not disable any other safety check). Do not re-dispatch that row until the dirty worktree is resolved (forced-cleaned, or manually inspected/rescued).
- A `cleanup[]` entry with `worktreeRemoved: false` and `blockedByDirty: false` is a harmless no-op (no crashed worktree was found for that branch) — nothing to do.

### 4a. Sidecar-directory note for `--marker`-scoped resume runs

The crash-cleanup step uses an UNSCOPED worktree scan internally (not narrowed by `--marker`), so it still finds and cleans a redispatch row's debris even when you pass `--marker` to keep the *reconciliation itself* scoped away from a sibling wave's worktrees. It only ever acts on the exact branch of a `redispatch` row from THIS wave's spine — it cannot touch a sibling wave's worktree.

### 5. Done-reconcile (the skill-only 4th input)

The pure reconciler projects to a `ClaimRung` only — it **cannot reach `done`/`available`** (those derive from native PR-merge / eligibility, not from any fine state). For every row whose reconstructed coarse rung is `in-review`, probe its closing state: `{{wave-cli}} issue-store read-closing <id>`.

The probe follows the **ADR-0023 evidence hierarchy: tracker attachment (`read-closing`) > host PR state (`host-pr status`) > nothing** — the same hierarchy `wave-close` uses (wave-shared Convention 7). When `read-closing` cannot see a merge, the host supplies the evidence.

- `state: 'merged'` → the PR landed during the kill: **land the row `done`** via the done-reconcile — `{{wave-cli}} issue-store close <id> <prUrl>` (the `prUrl` is `readClosing`'s). This is the same wired close `wave-close` uses; do **not** re-implement it. There is no `done` *rung* to `transition` to (`done` is a derived bookend); `close` is an idempotent no-op-or-reconcile that records the closing PR — on a native-integration tracker `read().status` already derives `done` from the merged PR's store-kind close phrase (`wave-shared` Convention 4), and `close` just records the facts. Record it in the resume report; the resumed wave lands the merged row rather than leaving it `in-review`.
- `state: 'closed-unmerged'` → the PR was closed without merging: **flag needs-attention** (NOT auto-back-to-`available` — that would let another wave re-grab and redo deliberately-rejected work) — `{{wave-cli}} issue-store flag <id> --kind recoverable-stop --question "PR was closed without merging during the outage — reopen, re-dispatch, or abandon?" --option reopen --option re-dispatch --option abandon`.
- `state: 'open'` → still in review: no action; the row keeps its `in-review` rung. **No-integration workspace with `states.doneState` (FOR-13):** `read-closing` can never report `merged` — it stays `open` even after the PR merged during the outage. Do **not** wait for an out-of-band human confirmation: consult the host directly — `{{wave-cli}} host-pr status --branch <branch>`. On its `state: merged`, run the SAME `{{wave-cli}} issue-store close <id> <prUrl>` to land it via the FOR-13 fallback (mapped done-state transition + loud advisory); on `state: open`/`none` the PR genuinely has not merged, so leave the row `in-review` for the next touch. `close` is idempotent, so this is safe on a re-run.

### 6. Re-project the coarse ledger (idempotent)

For every non-fatal, non-done row, re-assert its coarse rung onto the tracker: `{{wave-cli}} issue-store transition <id> <rung>` using the `coarse` from the reconstruction. This is **idempotent** — transitioning a row to the rung it already holds is a no-op write; run it on every row without checking first. This heals the tracker FROM the reconstruction (one-way); never read the tracker to decide the rung.

### 7. Flag the fatals

For every `fatals[]` entry (orphaned in-flight claim, corrupt/orphan sidecar), flag the row needs-attention so a human dispositions it — never silently route or backfill a corrupt sidecar:
`{{wave-cli}} issue-store flag <id> --kind terminal-failure --question "<the fatal reason from the reconciliation> — disposition required" --option re-dispatch --option abandon`.
A corrupt sidecar is a `terminal-failure` (the durable artifact is unreadable — a human must decide); an orphaned in-flight claim (state claims progress but no worktree, no sidecar) is also surfaced here. **These rows are paused — never re-dispatched.**

### 8. Re-dispatch (LAST — only after all the above)

Only now hand the rows whose `decision === 'redispatch'` to `wave-start`. These are the rows where nothing landed on disk and no report/verdict/adoptable worktree exists — the spawn never landed (or a crashed attempt's debris was just cleared in step 4), so re-creating a fresh worktree is safe and collision-free. `adopt` rows resume in place (durable progress on disk — never re-dispatch, it would duplicate landed work); `keep` rows are terminal; `needs-attention` rows wait for the human. **Exception:** a redispatch row whose `cleanup[]` entry has `blockedByDirty: true` is NOT yet safe — its crashed worktree still holds uncommitted work; resolve that first (see step 4) before handing it to `wave-start`.

## Common Mistakes

- **Re-dispatching before reconciling.** Reconcile, re-project, done-reconcile, and flag — THEN dispatch. Dispatching first can duplicate work that already landed. needs-attention rows are never re-dispatched.
- **Reading the tracker into the reconstruction.** The heal is one-way: tracker claims are written FROM `resume()`, never read into it. `resume()` never reads the tracker.
- **Looking for the sidecar dirs in the spine.** They are derived by convention from the spine path (`.flotilla/waves/<slug>/{reports,verdicts}`), not stored — there is no `sidecarRoot` field.
- **Calling `resume-cli` as `{{wave-cli}} resume`.** It is a *separate entrypoint* (`npx tsx tools/wave/src/resume-cli.ts …`), not a `cli.ts` subcommand. Only `spine`/`issue-store` go through `{{wave-cli}}`.
- **Treating `merged` as a rung to `transition` to.** There is no `done` rung — `done` is a derived bookend. On `merged`, land it with `{{wave-cli}} issue-store close <id> <prUrl>` (the done-reconcile), never `transition … done` (an invalid rung). `close` records the closing facts (and, in a no-integration `states.doneState` workspace, forces the done-state) — it does not project a `done` rung.
- **Skipping the done-reconcile close on a `merged` row.** Leaving the claim untouched (the old behaviour) strands a merged row at `in-review` — worst on a no-integration `states.doneState` workspace where nothing else ever lands it. Call the `close` verb; do not re-implement it.
- **Stopping at `read-closing` on a no-integration workspace.** There `read-closing` can never report `merged`, so an `open` row that actually merged during the outage sits `in-review` forever if you stop at the tracker probe. Follow the evidence hierarchy (ADR-0023): consult `{{wave-cli}} host-pr status --branch <branch>`; its `state: merged` fires the FOR-13 `close` fallback. Do not wait for an out-of-band human confirmation — the host is the probe.
- **Auto-moving `closed-unmerged` back to `available`.** A rejected PR re-grabbed by another wave redoes deliberately-rejected work. Flag it needs-attention; the human dispositions.
- **Silently routing a corrupt sidecar.** A corrupt sidecar is a fatal → flag `terminal-failure`. Never backfill or guess its content.
- **Skipping the idempotent re-project.** Re-assert every non-fatal row's coarse rung — transitioning to the held rung is a harmless no-op; this is what heals a tracker that drifted from the spine.
- **Manually running `git worktree unlock/remove` or `git branch -D` for a redispatch row.** `resume-cli` already does this for you (step 4, FOR-10) — don't duplicate it by hand.
- **Passing `--force` by default "to be safe."** `--force` destroys a DIRTY crashed worktree (uncommitted changes). Only pass it after a human has actually looked at a `blockedByDirty: true` entry and confirmed the work in it is disposable — never as a routine flag.
- **Re-dispatching a row whose `cleanup[]` entry is `blockedByDirty: true`.** That worktree still holds uncommitted work; hand it to `wave-start` and you risk silently discarding it on the next dispatch. Resolve the dirty worktree first.

## Related

- [reference/resume-mechanics.md](reference/resume-mechanics.md) — the worked CLI sequence, `ResumeResult` shape, exit codes, the `resume-cli` entrypoint split.
- [../wave-shared/SKILL.md](../wave-shared/SKILL.md) — auth-preflight / atomic-spine conventions this skill inherits.
- [../wave-create/SKILL.md](../wave-create/SKILL.md) — materialises the spine resume reconciles against.
- [../wave-start/SKILL.md](../wave-start/SKILL.md) — the dispatch loop the reconciled `redispatch` rows are handed back to.
- [../wave-close/SKILL.md](../wave-close/SKILL.md) — the operational terminator a reconciled wave proceeds toward.
