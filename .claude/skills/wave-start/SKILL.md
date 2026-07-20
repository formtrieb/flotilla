---
name: wave-start
description: Use when dispatching a Status:draft or Status:ready WAVE.md spine — auto-flip draft→ready via spine set-status, flip to in-flight, re-verify DOR + conflict-map + intra-wave Blocked-by membership (HELD rows are skipped, never dispatched), fan out Workers (worktree-isolated, schema-validated WorkerReport) then universal Reviewers (schema-validated ReviewerVerdict), route each Verdict deterministically, cap=1 re-dispatch, STOP→needs-attention. Ends at every non-HELD row in-review — NEVER merges. Triggers on "start the wave <slug>", "dispatch wave <slug>", "run wave-start".
---

# wave-start

Run the in-flight dispatch loop for one `Status: ready` spine: flip it to `in-flight`, fan out the Workers in isolated worktrees, dispatch a Reviewer for **every** row, route each Verdict through the tested state-machine, and bring every row to `in-review`. **This skill never merges and never closes** — it ends with each issue `in-review` (fine state `pr-created`, coarse rung `in-review`) and a PR open. Landing is `wave-close` (later P7.4 / M2).

Your job is the **judgment**: deciding the dispatch order, reacting to each routed outcome (transition / re-dispatch / STOP), and choosing what to do when the loop STOPs (flag `needs-attention`, ping the Coordinator). The mechanical glue — composing the Workflow script, the exact routing-verb invocations, the WAL ordering — lives in [reference/workflow-driver.md](reference/workflow-driver.md) and [reference/start-mechanics.md](reference/start-mechanics.md). You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

Load **wave-shared** by name first — it owns the canonical agent-boundary JSON schemas (`WORKER_REPORT_SCHEMA`, `REVIEWER_VERDICT_SCHEMA`) you paste into the Workflow driver, plus the auth-preflight / deterministic-routing / atomic-spine conventions this skill obeys.

## When to Use

- A wave spine exists at `.flotilla/waves/<slug>.md` with `Status: draft` or `Status: ready` (created by `wave-create`; `draft → ready` auto-flip is handled by step 1 below).
- You are ready to dispatch — there is a live checkout and host write-auth.

Do **not** use this to plan (`wave-plan`), materialize a spine (`wave-create`), or land PRs (`wave-close`). Do **not** run it on a spine in any state other than `draft` or `ready` (reach those via `wave-plan`/`wave-create`), or while another wave is already `in-flight`.

## THE FLOTILLA BOUNDARY — what wave-start guarantees and refuses

- **Spine-first WAL (ADR-0002).** Every state change writes the durable spine (`spine set-row-state`, the fine `IssueState`) **before** the tracker ledger (`issue-store transition`, the coarse `ClaimRung`). A crash between the two leaves the spine authoritative and the rung re-assertable from it. Never invert.
- **Ends at `in-review`. Never merges.** The loop terminates each row at fine state `pr-created` + coarse rung `in-review`. `approved → pr-created` opens a PR through the engine (`{{wave-cli}} host-pr create` — find-before-create idempotent, never `gh pr create`), its body carrying the store-kind close phrase (`wave-shared` Convention 4); it does **not** merge, fast-forward, or close the issue. `done` is the derived bookend a merged PR produces out-of-band (ADR-0002) — wave-start never writes it.
- **Single mechanism — the Workflow driver.** flotilla has one dispatch path: a Workflow script that fans out `agent({ schema, isolation: 'worktree' })` Workers then Reviewers (ADR-0016 de-couples the Ur's dual prose-vs-driver selector — there is no "express prose" variant in M1). For `n = 1` the script degenerates to a one-element fan-out; the routing is identical.
- **Universal Reviewer dispatch.** Every row gets a Reviewer regardless of Risk. Risk does **not** gate whether the Reviewer runs (it never did in the Ur either; ADR-0016 also drops the Risk→brief-profile map — the reviewer is uniform).
- **Parking is a scripted, human-decided disposition — never automatic (ADR-0022).** A row that cannot be dispatched this pass (an unresolved intra-wave blocker, step 3) or that STOPs and will not be salvaged this wave (step 8) can be taken out of the wave and returned to the pool for a future draw — but only when you, the Coordinator, decide to. flotilla never parks a row on its own. Parking is **terminal** (entry only from `planned` or `failed`, no un-park — re-entry is a fresh row in a future wave's spine) and **silent** (never flagged `needs-attention`; it does not gate this wave's completion).

## Procedure

### 1. Load + status-gate

`{{wave-cli}} spine read .flotilla/waves/<slug>.md` prints the spine **as raw markdown**. Read off the frontmatter `**Status:**` line, the Plan-Table rows (`id`, `state`, `risk`, `reviewer`, `pr`, `iter`, sidecar links), and the `## Conflict-Map`.

Read the frontmatter `**Status:**` and act:
- `draft` → auto-flip to `ready` first: `{{wave-cli}} spine set-status <spine> ready` (the Coordinator's commit-to-scope; `wave-create` always leaves it `draft`). This is idempotent — if Status is already `ready`, the verb is a byte-identical no-op. FAIL if the verb exits non-zero.
- `ready` → proceed directly to step 2.
- `in-flight` → STOP `(blocking) wave already in-flight — finish it or set its rows failed/abandoned`.
- anything else → STOP `(advisory) wave is not ready`.

> **Frontmatter `**Status:**` is the human scope-marker, not the running signal.** It is a *parser-consumed* line (`readSpine` captures `Frontmatter.status`), so a skill must use `spine set-status` — never hand-edit it — to preserve the byte-preserving round-trip the `renderSpine`/`SpineStore` design exists to protect (ADR-0016). The running in-flight signal is the per-row `State` column, flipped by the `spine set-row-state` verb (step 5).

### 2. Concurrency invariant — max 1 in-flight wave

A wave is "in-flight" iff at least one of its Plan-Table rows is in a running State (`dispatched` or `re-dispatched`). Before dispatching, audit **every other** `.flotilla/waves/*.md` spine for such a row:

```bash
# For each OTHER spine, count Plan-Table rows whose State cell is dispatched|re-dispatched.
# spine read prints raw markdown; the State cell is pipe-delimited and may be space-padded.
{{wave-cli}} spine read <other-spine> | grep -cE '\|[[:space:]]*(dispatched|re-dispatched)[[:space:]]*\|'
```

The total across all *other* spines MUST be 0. `> 0` → STOP `(blocking) another wave is in-flight — pick one and finish/abandon`. (This skill's **own** spine is exempt — on idempotent re-entry it may already carry running rows.) This is the *wave*-level guard; within a wave, all rows dispatch in parallel (step 6).

> **Do NOT grep the frontmatter for `status: in-flight`.** The spine frontmatter is `**Status:**` markdown (not YAML `status:`), and per ADR-0016 the frontmatter status is the human scope-marker, not the running state — the durable running signal is the per-row `State` column written by `set-row-state`. Read the rows, not the header.

### 3. Re-verify DOR + Conflict-Map, resolve Blocked-by membership (drift + hold gate)

The create→start gap can invalidate the spine. Re-run both gates against the live checkout, then resolve each row's `Blocked by` against the wave's own membership (FOR-8) from the **same** `cross-wave` call:

- **DOR per row.** `{{wave-cli}} dor --id <id> --repo-root <consumer-root>`. A row whose `overall` flipped to `FAIL` since `wave-create` (e.g. a Files glob now matches nothing because the file was deleted) → STOP `(blocking) DOR drift on <id> — re-run wave-create or fix the issue`. `warn`/`deferred` never gate.
- **Conflict-Map.** Re-run `cross-wave` over the row `IssueView`s + `issue-store listClaimed`; compare `intraWaveConflicts` against the spine's `## Conflict-Map`. A cell that became non-empty since `wave-create` → STOP `(blocking) Conflict-Map drift — files now overlap; re-plan`.
- **Blocked-by membership resolution (the explicit HELD step).** The same `cross-wave` result also carries `intraWaveBlockedByPairs: { blocked, blocker, resolved }[]` — pairs where a row's blocker is another row in THIS wave (engine-resolved: `tools/wave/src/cross-wave.ts`'s `findIntraWaveBlockedByPairs`, spec-covered in `cross-wave.spec.ts`). For every pair with `resolved === false` (the blocker's `IssueView.status` has not yet reached `in-review`/`done`), mark the `blocked` id **HELD**. A HELD row is **never dispatched this pass**: exclude it from the Worker fan-out (step 6) and from the in-flight flip (step 5) — its Plan-Table `State` stays `planned`, its `ClaimRung` stays whatever it already was (do not transition it). This is not a drift STOP and not a `needs-attention` flag — a HELD row is expected, ordinary sequencing, not an anomaly. Re-running `wave-start` later (once the blocker lands) picks it up normally, since `resolved` is re-derived fresh from the live `IssueView.status` on every entry.

- **Park a HELD row instead of waiting, when that is the right call (ADR-0022 §Consequences).** Waiting is the default disposition for a HELD row — it costs nothing and resumes automatically once the blocker resolves. But "wait within the wave" is a choice, not the only option: if you judge the blocker will not land in a useful timeframe, or the row simply should not ride this wave any further, take it out and release it back to the pool instead. A HELD row is still `planned` (it was never dispatched), which is one of the two legal entry states into `parked` — so park it directly, spine first (WAL):

  ```bash
  {{wave-cli}} spine set-row-state "$SPINE" "$ID" parked   # fine state, FIRST — from planned
  {{wave-cli}} issue-store unclaim "$ID"                    # releases the claim → available
  ```

  This is a **scripted disposition you choose, never something wave-start does on its own** — nothing in the routing chain parks a row automatically. A parked row is **terminal**: it does not re-enter this wave, and there is **no un-park** — the issue is back in the derived `available` pool, and re-entry is a fresh row a future `wave-create` draws, never a reverse edge on this row. It is also **silent**: do not flag it `needs-attention` — parking is a deliberate decision, not an anomaly, and it does not gate this wave's completion (step 9 reports it plainly, same as a HELD row, just without the "waiting on" clause).

Drift here means the wave's plan is stale — stop and let the Coordinator re-materialize, do not dispatch against a stale spine. A HELD or parked row is different from drift: report it (step 9), do not stop the wave over it, and proceed dispatching every other, still-dispatchable row.

### 4. Host auth-preflight (one-shot, before the flip)

Verify host write-auth **once**, up-front, so a dead token surfaces as a single STOP rather than N Workers each 401-ing on PR-open mid-flight. `{{wave-cli}} detect-host "$(git -C <consumer-root> remote get-url origin)"` → `{ host, workspace, repo }`, then verify auth for that host (GitHub: `gh auth status`).
- authenticated → silent, proceed to the flip.
- `unknown` host (not a github/bitbucket write target) → proceed silently (no auth needed).
- auth failed → STOP **before the flip**, wave stays `ready`, no Worker dispatched: `(blocking) host auth failed — refresh credentials, then re-run wave-start`.

### 5. Mark each row in-flight (WAL: spine first)

For each **non-HELD** row (step 3's membership resolution — skip any id marked HELD) in **Plan-Table row order**: `{{wave-cli}} spine set-row-state <spine> <id> dispatched` (the fine `IssueState`, **first** — the durable WAL record), then `{{wave-cli}} spine set-branch <spine> <id> wave/<id>-<slug> --model <model>`, then `{{wave-cli}} issue-store transition <id> in-flight` (the coarse `ClaimRung`). Spine first (both spine writes), then the rung. The frontmatter `**Status:**` line was already set to `ready` in step 1 — the running signal is the per-row `State` column, not the frontmatter. (Exact sequence in [reference/start-mechanics.md](reference/start-mechanics.md).)

> **The dispatch WAL records both the fine state AND the branch (ADR-0021)** before the Worker spawns — the branch is resume's *only* durable row→worktree link (`branchesByIssueId` reads it; with it empty, `resume()` redispatches committed rows and discards their work). The recorded `wave/<id>-<slug>` MUST byte-match the branch each Worker checks out in the Workflow driver — same `id` + per-row `slug` (workflow-driver.md), never the wave-level slug.

### 6. Dispatch + review (the Workflow script)

Compose and run the Workflow driver — full skeleton + authoring constraints in [reference/workflow-driver.md](reference/workflow-driver.md). In one screen:

- **Compose-time anchor assertion, before any `agent()` fan-out (W2-F1).** The driver asserts every `ISSUES` row's `anchorSha` is present, non-empty, and not the literal string `"undefined"` — throwing with the offending row id — before the `pipeline()` call starts. This is the fail-loud fix for a real live-wave defect (`2026-07-16-hardening-w2`): the Coordinator defined the wave anchor as a constant but never wired it into the per-row objects, so every Worker/Reviewer brief interpolated `"undefined"` as its diff base. Workers survived by coincidence (fresh worktree HEAD already equalled the anchor); Reviewers correctly returned spurious `questions-blocking` against the malformed diff base, costing a full re-review round. `reviewerBrief` reads `anchorSha` off the same asserted `ISSUES` row object on every call, including a re-dispatch, so no brief can carry an unasserted value.
- **Dispatch order / tiebreak = Plan-Table row order, over the non-HELD rows only** (step 3). The spine is the dispatch order; ties resolve by row position, never by id or risk. A row HELD on an unresolved intra-wave blocker is left out of `ISSUES` entirely this pass — it is not dispatched, not failed, just not yet due.
- **Max-1-in-flight assertion is per-wave, not per-row** — the whole layer fans out concurrently (`agent(isolation: 'worktree')` per row). The concurrency invariant in step 2 is the *wave*-level guard; within the wave, all rows dispatch in parallel.
- Each Worker returns a **schema-validated `WorkerReport`** (`agent({ schema: WORKER_REPORT_SCHEMA })`). Each report pipelines into a `wave-reviewer` `agent({ agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_SCHEMA })` returning a **schema-validated `ReviewerVerdict`**. The schema boundary kills the report-fabrication class — no number is re-typed from prose.
- **Each sidecar is persisted at agent-return by a Scribe stage (ADR-0024), not by the Coordinator afterward.** The pipeline is `worker → scribe(report) → reviewer → scribe(verdict)`: a cheap `agent()` runs the paired `write-report`/`write-verdict` verb the moment each agent returns, so the durable record exists **before** the Coordinator routes anything (the P-1 fix — a mid-wave kill no longer loses finished work). A Scribe failure never drops the row: the stage passes the report/verdict through and logs loud (`wave-shared` Convention 5).
- The script returns a compact `[{ id, risk, iteration, report, verdict }, …]` array. The Coordinator routes each tuple (next sub-step).

### 7. Route each returned tuple (Coordinator, deterministic — WAL)

For each tuple, route through the tested verbs — **never by eye** (full invocation in [reference/start-mechanics.md](reference/start-mechanics.md)):

0. **Sidecar existence check first (the recovery path, not the default).** Before routing a tuple, confirm its Scribe-written sidecars are on disk — `ls .flotilla/waves/<slug>/reports/<id>-<iter>.md` (and the verdict path). Both normally already exist (the Scribe stages wrote them at agent-return, step 6). If one is **missing** (a Scribe stage failed and logged loud), the Coordinator writes it now **through the same verb** — `{{wave-cli}} write-report <tuple-report-json> --dir .flotilla/waves/<slug>/reports --id <id> --iter <iter>` (or `write-verdict`) — never hand-format, never bundle. This is the documented recovery, not the normal path: on the happy path the files are already there and this check is a no-op.
1. **Worker-phase gate first.** `{{wave-cli}} route-outcome --outcome <report.outcome> --state <dispatched|re-dispatched>` → `{ event, outcome }`. A `worker-done` (outcome → `{ type: 'transition', nextState: 'report-in' }`) proceeds to review-routing; any other outcome (`blocked`/`needs-context`) short-circuits — apply its `outcome` directly (a `transition` to `re-dispatched`, or a `stop`).
2. **Reviewer-phase routing.** `{{wave-cli}} route-verdict --verdict <verdict.verdict> --iteration <iter> --risk <verdict.riskClass> --state reviewing` → `{ event, outcome }`. `riskClass` is read straight off the typed verdict — the G3 fast-path bug is structurally impossible.
3. **Apply the `outcome` (WAL — spine first, then rung):**
   - `{ type: 'transition', nextState: 'approved' }` → run the **terminator**: open the PR through the engine — `{{wave-cli}} host-pr create --branch <branch> --title <title> --body <body>` (`approved → pr-created`), **never `gh pr create`**. It is find-before-create idempotent (the Worker that reported an open `prUrl` already opened it; the terminator's create re-pins the same PR — no duplicate). The `--body` carries the **store-kind close phrase** (`wave-shared` Convention 4 — read `store.kind` off `wave.config.json`: `github` → `Closes #<N>`, `linear` → `Fixes <TEAM-NN>`, e.g. `Fixes EX-16`; never hardcode `Closes #N`), and that is the only tracker id the title/body may name (mention discipline). Then `spine set-row-state <id> pr-created` + `spine set-row-pr <id> <PR-URL>` (the `.url` from the create JSON, or the Worker's reported `prUrl`), then `issue-store transition <id> in-review`.
   - `{ type: 'transition', nextState: 're-dispatched' }` → the **cap=1 re-dispatch**: `spine set-row-state <id> re-dispatched` first, then re-dispatch the same Worker at iteration 2 with the Verdict's `changes-requested` items (or the missing context) appended to the brief. The cap of 1 is enforced **by `transition()` itself** — a 2nd `changes-requested` or `needs-context` returns a `stop`, never another re-dispatch.
   - `{ type: 'stop', reason, severity }` → **STOP handling**, next step.
   - `{ type: 'warn' }` / `{ type: 'noop' }` → log + continue.

### 8. STOP → flag needs-attention

A `stop` outcome (`public-api-approval-required`, `reviewer-questions-blocking`, `re-dispatch-cap-exhausted`, `same-file-conflict`, `worker-failed`, `worker-stalled`) halts that row. Set the orthogonal `needs-attention` flag on the tracker so a concurrent wave / human sees it, then ping the Coordinator:

```bash
{{wave-cli}} issue-store flag <id> \
  --kind <recoverable-stop|terminal-failure> \
  --question "<the Coordinator decision needed>" \
  --option "<option A>" --option "<option B>"
```

- `recoverable-stop` (`reviewer-questions-blocking`, `public-api-approval-required`, `worker-stalled` warn, `re-dispatch-cap-exhausted`): the wave can resume after a human decision.
- `terminal-failure` (`worker-failed`, `same-file-conflict` blocking): the row cannot proceed without re-planning.

Do **not** auto-proceed past a STOP — these are the human gates the protocol preserves. The flag is orthogonal to the rung: a flagged row keeps its current `ClaimRung` (`read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged), so resume can still see where it was.

**The flag records that a decision is needed — it is not the decision.** When you (or the Coordinator, after investigation) resolve a `terminal-failure` STOP, the menu has more than one exit; do not default to `abandoned` just because it is the terminal state you already know:

1. **Retry within this wave.** Fix the problem and re-run `wave-start` — no extra state write; the existing cap=1 re-dispatch already governs how far a retry can go.
2. **Abandon** — the work will never be done in this line. This is the pre-existing path; it keeps the claim and the flag, and a human resolves it later.
3. **Park it instead of abandoning (ADR-0022) — when the work is fine but belongs in a *future* wave, not endlessly re-flagged in this one.** A stopped row is still in a live state (`dispatched`/`re-dispatched`/`reviewing`), and `parked`'s only legal entries are `planned` and `failed` — a live row resolves through its existing stop path (`failed`) first. Spine first (WAL), then the claim release, then clear the flag you just set (parking answers its own question):

   ```bash
   {{wave-cli}} spine set-row-state "$SPINE" "$ID" failed    # record the terminal outcome — from the live state
   {{wave-cli}} spine set-row-state "$SPINE" "$ID" parked    # the disposition — from failed
   {{wave-cli}} issue-store unclaim "$ID"                     # releases the claim → available
   {{wave-cli}} issue-store clear-flag "$ID"                  # parked is terminal + silent — not needs-attention
   ```

   Choosing "park" over "abandon" is exactly the live-gate defect ADR-0022 closes: `abandoned` means *never* — recording a row you intend to re-plan as `abandoned` lies to the next planner and leaves its claim stuck on the board. Like the step-3 disposition, this is **never automatic** — nothing routes a STOPped row to `parked` on its own; only the Coordinator writes it, and only from `planned`/`failed`. There is **no un-park**: once released, the id is out of this wave for good — re-entry is a fresh row a future wave draws from the pool, never a reverse edge here. A parked row does not gate this wave's completion.

### Recovery: a bad-anchor first round (W2-F1)

The compose-time assertion (step 6) is the fail-loud fix going forward; it does not retroactively fix a round already dispatched with a bad anchor (e.g. a wave started before this assertion existed, or a hand-composed brief outside the driver). If a Reviewer verdict flags the diff base as malformed and the Coordinator confirms the anchor interpolated into that round's briefs was wrong — missing, empty, or the literal `"undefined"` — this is the scripted recovery, proven live in `2026-07-16-hardening-w2`:

1. **Re-dispatch the affected Reviewers only**, with the corrected `anchorSha`. Reuse the Worker's already-produced report/branch verbatim.
2. **Do not re-dispatch the Worker.** The defect is Coordinator input (a bad brief), not branch content — the Worker's commits are unaffected by which SHA the Reviewer diffs against.
3. **Do not consume the re-dispatch cap.** `route-verdict`'s cap=1 governs `changes-requested`/`needs-context` rounds against real branch content; a round invalidated purely by a Coordinator-side composition bug is not that — treat the corrected-anchor Reviewer round as the row's one real review round, not a second one.

Full mechanics: [reference/workflow-driver.md](reference/workflow-driver.md) §Recovery protocol.

### 9. Report (sidecars already written — no bundled write here)

**Sidecars are NOT written in this step (ADR-0024).** They were persisted at agent-return by the Scribe stages (step 6) and re-checked at routing (step 7.0) — the old bundled, post-routing write that this step used to do is **removed**: it was the P-1 kill window (a Coordinator death before this step left zero durable records). Do not re-format or re-write a sidecar here; if a sidecar was missing it was already written through `write-report`/`write-verdict` in step 7.0. The sidecars live at `.flotilla/waves/<slug>/reports/<id>-<iter>.md` and `.../verdicts/<id>-<iter>.md` (a sibling `<slug>/` subdir of `.flotilla/waves/`; the spine's sidecar cell points at `./<slug>/reports/<id>-1.md` relative to the spine's own directory).

This step is **report-only**. When every non-HELD, non-parked row is at `pr-created` / `in-review` (or flagged `needs-attention`): print the spine path, the per-row final state (including any HELD rows and which unresolved blocker(s) they're waiting on, and any rows parked this pass — plainly, without a flag), and the open-PR URLs. **State that the wave is NOT closed** — the next step is `wave-close` (which passes `parked` rows through its terminality gate silently, per ADR-0022) or a later `wave-start` re-entry to pick up any HELD row once its blocker resolves.

## Common Mistakes

- **Merging or closing from wave-start.** The loop ends at `in-review` / `pr-created`. Never merge or fast-forward here — that is `wave-close`. `done` is derived from a merged PR out-of-band, never written by this skill.
- **Hardcoding `Closes #N` in the PR body.** The close phrase is store-kind-derived (`wave-shared` Convention 4): `github` → `Closes #N`, `linear` → `Fixes <TEAM-NN>`. Read `store.kind` off `wave.config.json`, never assume GitHub's phrase.
- **Opening the PR with `gh pr create` (or any raw `gh`/`curl`).** The PR-open is an engine call — `{{wave-cli}} host-pr create` (find-before-create idempotent, `wave-shared` Convention 4). `gh` is sandbox-denied and its TLS fought the proxy in every live run; the engine verb uses the same `fetch` path arm/merge/status do.
- **Routing by eye.** Always `route-outcome` / `route-verdict`; never hand-synthesize the `WaveEvent` or hand-read `riskClass` from prose. The verbs wrap the tested adapters — hand-routing reintroduces the G3 fast-path bug.
- **Rung-first.** WAL is spine-first always: `spine set-row-state` (fine) before `issue-store transition` (coarse). A rung with no spine state orphans the claim.
- **Grepping frontmatter for the in-flight check.** The frontmatter is `**Status:**` markdown and is the human scope-marker, not the running state. Count Plan-Table rows whose `State` is `dispatched`/`re-dispatched` (step 2).
- **Hand-editing the frontmatter `**Status:**` line.** It is parser-consumed — always use `spine set-status` (never a manual edit); the verb targets the exact line surgically and preserves the byte-preserving round-trip. The per-row `State` column is the durable running signal; the frontmatter status is advisory/human-facing.
- **Dispatching against a stale spine.** Re-verify DOR + Conflict-Map at start (step 3). The create→start gap can invalidate either; a drift STOP is mandatory.
- **Skipping the Reviewer for low-risk rows.** Dispatch is universal — Risk selects nothing about whether the Reviewer runs (ADR-0016 — the reviewer is uniform; there is no brief-profile gate).
- **Re-dispatching more than once.** The cap is 1, enforced inside `transition()`. Do not loop a 3rd Worker attempt — a 2nd `changes-requested`/`needs-context` returns a `stop` you must flag, not re-dispatch.
- **Auth-preflight per Worker.** Verify host auth once, up-front, before the flip — not lazily per terminator (the dead-token-for-the-whole-wave failure).
- **Proceeding past a STOP.** Flag `needs-attention` and ping; never auto-continue a `stop` outcome.
- **Dispatching a HELD row anyway, or flagging it `needs-attention`.** A row whose intra-wave blocker is not yet `in-review`/`done` (FOR-8, step 3) is HELD, not stopped and not anomalous — leave its `State` at `planned`, exclude it from `ISSUES` (step 6), and report it plainly. Do not dispatch it "to save a round-trip" and do not raise a flag over ordinary sequencing.
- **Re-dispatching the Worker, or consuming the re-dispatch cap, on a bad-anchor recovery.** A Reviewer round invalidated by a Coordinator-side anchor bug (recovery protocol, above) is Coordinator input, not branch content — re-dispatch the Reviewer only, with the corrected anchor, and do not count it against the cap=1.
- **Conflating HELD with `parked` (ADR-0022).** HELD is a live wait: the claim stays intact, the state stays `planned`, and the row rejoins this same wave automatically once its blocker resolves. `parked` is a deliberate exit: the claim is released, the state is terminal, and the row never rejoins this wave — re-entry is a fresh row a future wave draws from the pool. Do not park a row just because it is HELD (waiting is still the default), and do not treat a parked row as if it were still waiting its turn here.
- **Parking (or STOP-disposing) a row automatically, without a Coordinator decision.** Neither the HELD-row park (step 3) nor the STOP-menu park (step 8) is something wave-start does on its own — nothing in the routing chain writes `parked`. It is always an explicit Coordinator choice, and only from `planned` or `failed`.
- **Introducing an un-park path, or re-dispatching a parked row.** There is no reverse edge (ADR-0022 §Decisions 6). Once a row is `parked` and unclaimed, leave it alone — a future wave's `wave-create` draws it fresh from the pool as a new row, never this one resurrected.
- **Flagging a parked row `needs-attention`, or leaving a stale flag on one you just parked.** Parking is terminal *and silent* — it already answers the question a flag would raise. If the row was flagged before you decided to park it (the step 8 STOP path), clear the flag (`issue-store clear-flag <id>`) as part of the disposition.
- **Recording a row you intend to re-plan as `abandoned`.** `abandoned` means "never"; a row that will come back in a future wave is `parked` ("later"). Recording it `abandoned` lies to the next planner and leaves the claim stuck on the board — this is the live-gate defect ADR-0022 exists to fix.
- **Bundling the sidecar writes into step 9 after routing.** That is the removed P-1 kill window. Sidecars are written by the Scribe stages **at agent-return** (step 6), through `write-report`/`write-verdict`; step 9 is report-only. A missing sidecar is written at routing (step 7.0) through the same verb — never hand-formatted, never batched at the end.
- **Hand-formatting a sidecar.** The `write-report`/`write-verdict` verbs own the format (engine-computed `<id>-<iter>.md`, fenced json, validate-then-write). A hand-typed sidecar drifts from the reader and resurfaces as "corrupt" at resume. Always go through the verb.
- **Letting a Scribe failure STOP the row.** A sidecar-write failure is logged loud and recovered at routing (step 7.0) — it is not a `worker-failed` STOP. The Worker's report is still in-band; only the durable copy needs re-writing, through the verb.
