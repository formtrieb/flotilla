---
name: wave-plan
description: Use when planning the next wave — draw the wave-eligible candidate set and run the cross-wave parallel-safety check against what other waves already claimed. Read-only/advisory; the human picks ids and hands them to wave-create. Triggers on "plan a wave", "what can run next", "cross-wave check".
---

# wave-plan

Answer "which eligible issues could form the next wave, and can they run alongside what's already in flight?" This is the strategic layer — read-only, advisory, and the only output is a report. Materializing one approved wave into a spine and worktrees is `wave-create`'s job.

Your job is the **judgment** — reading the report, flagging what needs attention, and helping the human pick the right set of ids. The CLI plumbing (the four commands, the exact sequence, the worked `CrossWaveResult` sample) lives in [reference/plan-mechanics.md](reference/plan-mechanics.md) — reach for it once you need to drive the engine. You never touch a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

**M1 scope: candidate draw + cross-wave report + PRD panel + the dispatch-cost estimate. No batch-sizing heuristics** — sizing by worker-mix, risk-mix, or wallclock estimates is a soft CHARTER idea, not an M1 requirement. Do not invent heuristics. The dispatch-cost estimate (step 3c) is **not** an exception to that rule: it is arithmetic over the set in front of you, reported so the human can see the bill. It scores nothing, ranks nothing, filters nothing, and recommends no size.

## When to Use

- Planning the next wave from the backlog: you need to know which issues are eligible and whether running them beside current claims is safe.
- Running a cross-wave check before handing ids to `wave-create`.
- Reviewing the PRD panel to find un-sliced planning documents.

Do **not** use this to slice work into issues (`to-issues`), to triage an issue (`triage`), or to materialize a wave into a spine and worktrees (`wave-create`). wave-plan is the advisory pass; wave-create is the authoritative materialization.

## THE FLOTILLA BOUNDARY — wave-plan persists nothing

**wave-plan is strictly read-only.** It draws candidates and runs the cross-wave check; it does not write the claim ledger, does not set any issue state, and does not touch the spine. Every write — the `queued` soft-claim, the spine creation — happens in `wave-create`, after the human has approved the selected ids. If you find yourself reaching for `issue-store transition`, **stop** — that is wave-create's job.

## Procedure

### 1. Draw candidates

```bash
{{wave-cli}} issue-store listOpen
```

This returns the wave-eligible `IssueView[]` for this repo. The eligibility OR-set comes from `wave.config.json` (the `store.eligibility` field) — the CLI op hardcodes the `'wave-ready'` capability token; you pass no eligibility arg. Every issue in the result is already eligible.

**Include `HITL-required` rows — do not exclude them.** A `worker === 'HITL-required'` issue is real wave work that the coordinator must see; it enters the wave but is human-gated, not autonomously dispatchable (ADR-0012). `wave-plan` **flags** these rows — mark them clearly so the coordinator knows they need a human to act before a Worker picks them up. They are a `wave-plan` concern. They are not `ready-for-human` (that is triage's "outside flotilla entirely" terminal, which never appears here — explained below).

> **`HITL-required` ≠ `ready-for-human`.** `HITL-required` is a **Worker** value (the `IssueView.worker` field, ADR-0012) — it means the issue *is* wave work, but a human must act before the Worker runs. Detection: `IssueView.worker === 'HITL-required'`. It is present in `listOpen` because it is eligible. `ready-for-human` is a **triage terminal** (ADR-0015) — work a human does entirely outside flotilla, which never enters a wave and therefore never appears in `listOpen`. Do not confuse them.

**PRDs never appear in `listOpen`** — `to-prd` publishes via the Document facet (ADR-0011), never eligibility-stamped, so no filtering is needed. The PRD panel is a separate step below.

### 2. Draw current claims

```bash
{{wave-cli}} issue-store listClaimed
```

Returns every issue currently `queued` or `in-flight` across all waves — the full set flotilla has claimed. This is the "already claimed" side for the cross-wave check.

### 3. Run the cross-wave check

Feed `(candidates)` and `(claimed)` to `cross-wave` — **always pass `--repo-root`** (the consumer repo root, i.e. the dir containing `wave.config.json`). An `IssueView` is structurally a valid `ScopedIssue` (`{id, files}`), so the `listOpen` and `listClaimed` arrays are valid inputs verbatim — extra fields are ignored.

The result distinguishes two overlap kinds:

- **`crossWaveConflicts`** — a candidate overlaps a *claimed* issue from another wave (those workers are already running or queued). This is the launch-gate concern: if `parallelSafe === false`, these two waves must serialize. Report these prominently — the coordinator must decide.
- **`intraWaveConflicts`** — two candidates overlap each other (both within the proposed wave). These are not blockers; the coordinator must sequence them within the wave if both are included. Report them so the human can decide the order.
- **`parallelSafe`** — `true` iff `crossWaveConflicts` is empty. The clear signal — but only trustworthy when read alongside `warnings` below.
- **`warnings`** (FOR-38, present only when non-empty) — one entry per glob `Files` pattern that could not be expanded against the working tree, naming the issue id and pattern text. This is the "I could not evaluate these patterns" signal — it must never be read as "these patterns overlap nothing". It should never appear as long as you pass `--repo-root`; if it does, say so explicitly in the report and do not present `parallelSafe: true` as a clean all-clear.

**Both lists are canonical and deduplicated at the source.** Every cell has `a < b`, and each unordered pair appears exactly once — even when `candidates` and `claimed` overlap (an issue can legitimately be in both, e.g. it is already queued from a prior plan). Read the report directly; no mental deduplication of repeated pairs is needed.

Report: "disjoint → parallel-safe" or "overlaps at `<file>` → serialize" (or sequence within-wave for intra-wave conflicts). Give enough detail that the coordinator can act: which issue ids, which files.

### 3b. Public-API-change pairing advisory (KW-F4)

The step-3 file-overlap check is structurally blind to *semantic* cross-suite conflicts. Two candidates that each change a **global contract** can force landing rework even with **disjoint `Files`** — an API-wide change in one meets a new or success-path test in the other on the reconciled merge. That is exactly what broke 27 test assertions on the first Linear consumer wave, past a green conflict-map: **both** colliding rows carried `Risk: public-API-change`.

So surface it at plan time, the same advisory way intra-wave Blocked-by pairs are surfaced downstream — a pairing the **human decides on**, never an auto-exclusion. When **two or more** candidates in the proposed set carry `Risk: public-API-change`, flag them as an advisory pairing. Derive it skill-side from the candidate `risk` fields already in hand from `listOpen` — no engine call, nothing persisted (see [reference/plan-mechanics.md](reference/plan-mechanics.md)). The advisory reads: *these rows each change a global contract; expect landing rework on the reconciled merge even though their `Files` are disjoint — plan the wave-close reconciled-merge verify, and consider serializing them or splitting them across waves.* The coordinator decides whether to run them together, sequence them, or split them; wave-plan only raises the flag.

### 3c. Dispatch-cost estimate — one line per candidate set

**Report what the set would cost to dispatch, before anyone commits to it.** A wave's price is paid in agent dispatches, and the number is not intuitive from a row count: the driver runs **~4 agents per dispatched row** — `worker → scribe(report) → reviewer → scribe(verdict)` — so a set that reads as "just six small tickets" is roughly two dozen agents, and a `cap=1` re-dispatch on a row adds up to four more. **A `foreground` row is the one exception**: per the coordinator-direct boundary (ADR-0033), the Coordinator implements it directly, so the Worker and its report-Scribe never dispatch — the row still costs Reviewer + verdict Scribe (~2 agents), just not the full tuple. Left un-surfaced, that arithmetic only becomes visible after the day is spent (a measured day: ~150 agents, a quarter of the week's plan, in one sitting).

Report **the headline, the foreground carve-out, the heavy count, and one exclusion**, derived skill-side from the candidate fields already in hand (see [reference/plan-mechanics.md](reference/plan-mechanics.md) — no engine call, nothing persisted):

- **Full-pipeline rows × ~4 agents** — the headline estimate: every dispatchable row that is not `foreground` runs the whole tuple.
- **Foreground rows, named beside the headline at their reduced cost** — a `worker === 'foreground'` row (ADR-0012 vocabulary) is Coordinator-implemented per the coordinator-direct boundary (ADR-0033): Worker-side cost is zero, but the row still closes a tracker issue, so its Reviewer still dispatches, followed by the verdict Scribe. Each one costs **Reviewer + verdict Scribe (~2 agents)**, not the full tuple — name the count and its own reduced cost beside the headline rather than folding it into the `× 4` multiplication, which is exactly what overstates a set that contains foreground rows.
- **Heavy-row count** — rows that will run on the `-heavy` tier on either side: a `-heavy` Worker (`IssueView.worker`, ADR-0012), or a Risk of `cross-feature-refactor` / `public-API-change`, which routes the *Reviewer* to `-heavy` too (ADR-0007 Amendment 2026-07-31) — this can still apply to a `foreground` row on Risk, even though its Worker side is free. These dominate the spend, so the count travels next to the total rather than inside it — twelve mechanical rows and twelve heavy rows are the same headline and a very different bill.
- **Rows excluded from the estimate** — `HITL-required` rows cost nothing until a human acts, so name them and leave them out of the multiplication rather than silently folding them in.

Present it as a **line**, alongside the parallel-safety verdict — the human is choosing a set, and this is one of the facts about the set. Then stop: **do not** recommend a size, propose a cheaper subset, rank candidates by cost, or drop a row because the number looks large — the estimate scores nothing, ranks nothing, filters nothing, and recommends no size, foreground carve-out included. The budget decision stays human at planning time; wave-plan's job is that the decision is *informed*, not that it is made.

> **Deliberately no wave-cadence rule.** There is no "N waves per day" guidance to give, because cadence is **pool-shaped**: the conflict map dictates the largest safe set, and the measured cost driver is **row count, not wave count** — splitting the same rows across more waves buys nothing and costs more close ceremonies. Report the cost of the set; never convert it into a rule about how often to run.

### 4. PRD panel

```bash
{{wave-cli}} issue-store listDocuments
```

Returns `DocumentView[]` (`{ id, title, body }`). List every PRD and **flag the un-consumed ones** — a PRD is consumed iff at least one candidate's `parent` field equals the PRD id (exact string match, derived from the already-loaded `listOpen` results). An un-consumed PRD has no slices yet; flag it with "run `to-issues` to slice". A PRD is never a candidate — the Document facet and the issue facet are entirely separate (ADR-0011).

### 5. Present the report; pick ids

Present the full picture:
- Eligible candidates with their Risk, Worker, and Blocked-by. Flag any `HITL-required` rows.
- Cross-wave result: parallel-safe or serialize (with the conflicting files and issue ids).
- Intra-wave conflicts, if any, so the coordinator can plan the sequence.
- Public-API-change pairing advisory (KW-F4): any two-or-more `public-API-change` candidates flagged as a pairing — expect reconciled-merge landing rework even with disjoint `Files`; the human decides whether to serialize or split them across waves.
- **Dispatch-cost estimate for the set** (step 3c): full-pipeline rows × ~4 agents, `foreground` rows named beside it at their reduced cost (Reviewer + verdict Scribe; zero Worker-side — ADR-0033's coordinator-direct boundary), the heavy-row count, and any `HITL-required` rows named as excluded. If the human is weighing two candidate sets, give the line for each — one per set, so the comparison is visible without re-deriving it.
- PRD panel: consumed (✓) and un-consumed (needs slicing).

**Persist nothing.** The human picks the ids they want in the wave and hands them to `wave-create`.

## Common Mistakes

- **Excluding `HITL-required`.** These rows are real wave work. Include and flag them; do not drop them from the report.
- **Treating a PRD as a candidate.** A PRD is never in `listOpen`; it only appears in the PRD panel via `listDocuments`. Do not include it in the candidate set or cross-wave inputs.
- **Persisting state from wave-plan.** wave-plan is advisory — it writes nothing. The `queued` claim and the spine creation happen in `wave-create`.
- **Inventing heuristics.** Do not score, rank, or filter candidates by wallclock, worker-mix, or risk-mix. Present the eligible set; the coordinator decides. The step-3c cost line is not a heuristic — it is arithmetic over the set, reported and then left alone.
- **Omitting the dispatch-cost line because the set "looks small".** Row count is exactly the intuition the line exists to correct: ~4 agent dispatches per row means six rows is roughly two dozen agents. Report it for every set you present.
- **Folding `foreground` rows into the `× 4` headline.** A `foreground` row is Coordinator-implemented (ADR-0033's coordinator-direct boundary): Worker-side cost is zero, but the Reviewer and verdict Scribe still dispatch. Multiplying it into the full-tuple headline overstates the set — name it beside the headline at its own ~2-agent cost instead.
- **Turning the cost line into advice.** Report rows × ~4 agents, the foreground carve-out, the heavy count, and the excluded `HITL-required` rows — then stop. Recommending a smaller wave, proposing a cheaper subset, or dropping a row because the number looks large is the sizing heuristic this skill does not do.
- **Deriving a wave-cadence rule from the cost line.** Cadence is pool-shaped: the conflict map dictates the largest safe set, and the cost driver is row count, not wave count. Splitting the same rows over more waves adds close ceremonies and saves nothing.
- **Confusing `crossWaveConflicts` with `intraWaveConflicts`.** Cross-wave overlaps (candidate↔claimed) are the launch-gate concern. Intra-wave overlaps (candidate↔candidate) are a sequencing concern within the wave. Report them distinctly.
- **Conflating `HITL-required` (Worker) with `ready-for-human` (triage terminal).** `ready-for-human` never enters a wave and never appears in `listOpen`. `HITL-required` is in the eligible set and must be surfaced.
- **Reaching for raw `gh`.** wave-plan never touches a tracker directly — everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.
- **Omitting `--repo-root` on `cross-wave` (FOR-38).** This is not a harmless shortcut — it silently degrades glob-pattern conflict detection to exact-text matching only, and a live finding showed it drop conflict cells (17 vs. 40 on the same roster). Always pass it. If `cross-wave` ever returns a non-empty `warnings`, surface it — do not report `parallelSafe: true` as clean when patterns went unevaluated.
- **Treating a green file-overlap check as proof two `public-API-change` rows are safe together (KW-F4).** Two or more `public-API-change` candidates in one wave predict landing rework even with disjoint `Files` — the semantic cross-suite conflict the file map cannot see. Surface them as an advisory pairing (step 3b), the same way intra-wave Blocked-by pairs are surfaced; the human decides, do not auto-exclude.
- **Reaching for a path-only `conflict-map` (or a tsx one-off) on store-backed ids.** wave-plan's overlap reasoning goes through `cross-wave` on the `IssueView[]` arrays, not the standalone `conflict-map` CLI. If you *do* reach for `conflict-map` directly on a github/linear roster, it is no longer path-only: `conflict-map --id <id> [--id <id> ...] [--repo-root <dir>] [--config <path>]` is the store-backed (non-file) entrypoint that reads each id's `Files` from the `IssueStore` — never export paths or hand-roll a tsx script to feed it.
