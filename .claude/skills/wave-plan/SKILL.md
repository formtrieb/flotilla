---
name: wave-plan
description: Use when planning the next wave — one batch of issues that can safely run side by side. Lists which issues are ready to be picked up, then checks them for overlapping files, both against each other and against the issues another batch has already taken. Changes nothing: you choose which ones to run and hand them to wave-create. Triggers on "plan a wave", "what can run next", "cross-wave check".
---

# wave-plan

Answer "which eligible issues could form the next wave, and can they run alongside what's already in flight?" This is the strategic layer — read-only, advisory, and the only output is a report. Materializing one approved wave into a spine and worktrees is `wave-create`'s job.

Your job is the **judgment** — reading the report, flagging what needs attention, and helping the human pick the right set of ids. The CLI plumbing (the four commands, the exact sequence, the worked `CrossWaveResult` sample) lives in [reference/plan-mechanics.md](reference/plan-mechanics.md) — reach for it once you need to drive the engine. You never touch a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

**M1 scope: candidate draw + cross-wave report + PRD panel + the read-only goal panel + the dispatch-cost estimate. No batch-sizing heuristics** — sizing by worker-mix, risk-mix, or wallclock estimates is a soft CHARTER idea, not an M1 requirement. Do not invent heuristics. The dispatch-cost estimate (step 3c) is **not** an exception to that rule: it is arithmetic over the set in front of you, reported so the human can see the bill. It scores nothing, ranks nothing, filters nothing, and recommends no size.

## When to Use

- Planning the next wave from the backlog: you need to know which issues are eligible and whether running them beside current claims is safe.
- Running a cross-wave check before handing ids to `wave-create`.
- Reviewing the PRD panel to find un-sliced planning documents.
- Reading the goal panel to see which named finish line each candidate serves — display only, never a reason to include a row.

Do **not** use this to slice work into issues (`to-issues`), to triage an issue (`triage`), or to materialize a wave into a spine and worktrees (`wave-create`). wave-plan is the advisory pass; wave-create is the authoritative materialization.

## THE FLOTILLA BOUNDARY — wave-plan persists nothing

**wave-plan is strictly read-only.** It draws candidates and runs the cross-wave check; it does not write the claim ledger, does not set any issue state, and does not touch the spine. Every write — the `queued` soft-claim, the spine creation — happens in `wave-create`, after the human has approved the selected ids. If you find yourself reaching for `issue-store transition`, **stop** — that is wave-create's job.

## Procedure

### 1. Draw candidates

```bash
{{wave-cli}} issue-store listOpen
```

This returns the wave-eligible `IssueView[]` for this repo. The eligibility OR-set comes from `wave.config.json` (the `store.eligibility` field) — the CLI op hardcodes the `'wave-ready'` capability token; you pass no eligibility arg. Every issue in the result is already eligible.

**Include `HITL-required` rows — do not exclude them.** A `worker === 'HITL-required'` issue is real wave work that the Operator must see; it enters the wave but is human-gated, not autonomously dispatchable (ADR-0012). `wave-plan` **flags** these rows — mark them clearly so the Operator knows they need a human to act before a Worker picks them up. They are a `wave-plan` concern. They are not `ready-for-human` (that is triage's "outside flotilla entirely" terminal, which never appears here — explained below).

> **`HITL-required` ≠ `ready-for-human`.** `HITL-required` is a **Worker** value (the `IssueView.worker` field, ADR-0012) — it means the issue *is* wave work, but a human must act before the Worker runs. Detection: `IssueView.worker === 'HITL-required'`. It is present in `listOpen` because it is eligible. `ready-for-human` is a **triage terminal** (ADR-0015) — work a human does entirely outside flotilla, which never enters a wave and therefore never appears in `listOpen`. Do not confuse them.

**PRDs never appear in `listOpen`** — `to-prd` publishes via the Document facet (ADR-0011), never eligibility-stamped, so no filtering is needed. The PRD panel is a separate step below.

### 1b. GitHub blockedBy-mirror envelope (github consumers only)

**Before planning wide on a github-store consumer** — a candidate set with many `blockedBy`-carrying rows, or one you plan to feed a bulk `to-issues` create/decorate pass — know that each such filing also mirrors its `blockedBy` refs into GitHub's native issue-dependencies API, one `addBlockedBy` POST per unmirrored ref (`GithubIssuesStore.mirrorBlockedBy`). That is on top of the read-side GET every `read()` already pays, and it walks toward GitHub's own **secondary rate limits** (a content-creation ceiling and a points budget on `POST`/`PATCH`/`PUT`/`DELETE` calls — full figures and sources: [to-issues/reference/filing-mechanics.md](../to-issues/reference/filing-mechanics.md)) faster than the row count alone suggests.

This is a **read-and-proceed** note, not a gate: the mirror is deliberately un-throttled (triage decision), and a rate-limited or refused mirror POST degrades **harmlessly** — the authoritative body-codec `## Blocked by` write already landed, `read()` still unions codec ∪ native so the DoR gate sees the real blocker either way, and the next `create`/`annotate` re-attempts whatever a stalled pass left unmirrored. Nothing here changes what you report or how you size the wave; it is context for *why* a github consumer's dependency labels might lag the body text for a while after a wide filing pass, not a reason to shrink the set.

### 2. Draw current claims

```bash
{{wave-cli}} issue-store listClaimed
```

Returns every issue currently `queued` or `in-flight` across all waves — the full set flotilla has claimed. This is the "already claimed" side for the cross-wave check.

### 3. Run the cross-wave check

Feed `(candidates)` and `(claimed)` to `cross-wave` — **always pass `--repo-root`** (the consumer repo root, i.e. the dir containing `wave.config.json`). An `IssueView` is structurally a valid `ScopedIssue` (`{id, files}`), so the `listOpen` and `listClaimed` arrays are valid inputs verbatim — extra fields are ignored.

The result distinguishes two overlap kinds:

- **`crossWaveConflicts`** — a candidate overlaps a *claimed* issue from another wave (those workers are already running or queued). This is the launch-gate concern: if `parallelSafe === false`, these two waves must serialize. Report these prominently — the Operator must decide.
- **`intraWaveConflicts`** — two candidates overlap each other (both within the proposed wave). These are not blockers; the Operator must sequence them within the wave if both are included. Report them so the human can decide the order.
- **`parallelSafe`** — `true` iff `crossWaveConflicts` is empty. The clear signal — but only trustworthy when read alongside `warnings` below.
- **`warnings`** (FOR-38, present only when non-empty) — one entry per glob `Files` pattern that could not be expanded against the working tree, naming the issue id and pattern text. This is the "I could not evaluate these patterns" signal — it must never be read as "these patterns overlap nothing". It should never appear as long as you pass `--repo-root`; if it does, say so explicitly in the report and do not present `parallelSafe: true` as a clean all-clear.

**Both lists are canonical and deduplicated at the source.** Every cell has `a < b`, and each unordered pair appears exactly once — even when `candidates` and `claimed` overlap (an issue can legitimately be in both, e.g. it is already queued from a prior plan). Read the report directly; no mental deduplication of repeated pairs is needed.

Report: "disjoint → parallel-safe" or "overlaps at `<file>` → serialize" (or sequence within-wave for intra-wave conflicts). Give enough detail that the Operator can act: which issue ids, which files.

### 3b. Public-API-change pairing advisory (KW-F4)

The step-3 file-overlap check is structurally blind to *semantic* cross-suite conflicts. Two candidates that each change a **global contract** can force landing rework even with **disjoint `Files`** — an API-wide change in one meets a new or success-path test in the other on the reconciled merge. That is exactly what broke 27 test assertions on the first Linear consumer wave, past a green conflict-map: **both** colliding rows carried `Risk: public-API-change`.

So surface it at plan time, the same advisory way intra-wave Blocked-by pairs are surfaced downstream — a pairing the **human decides on**, never an auto-exclusion. When **two or more** candidates in the proposed set carry `Risk: public-API-change`, flag them as an advisory pairing. Derive it skill-side from the candidate `risk` fields already in hand from `listOpen` — no engine call, nothing persisted (see [reference/plan-mechanics.md](reference/plan-mechanics.md)). The advisory reads: *these rows each change a global contract; expect landing rework on the reconciled merge even though their `Files` are disjoint — plan the wave-close reconciled-merge verify, and consider serializing them or splitting them across waves.* The Operator decides whether to run them together, sequence them, or split them; wave-plan only raises the flag.

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

Returns `DocumentView[]` (`{ id, title, body }`). List every PRD and **flag the ones with no open slices** — `○` iff no candidate's `parent` field equals the PRD id (exact string match, derived from the already-loaded `listOpen` results). A PRD is never a candidate — the Document facet and the issue facet are entirely separate (ADR-0011).

**Report the flag as what it derives: `○` means "no open slices", never "never sliced".** The two are indistinguishable from the candidate set alone, because a closed slice leaves that set carrying its `parent` backlink with it — so a fully-shipped PRD renders exactly like one that was never sliced, and the false-positive rate **grows with the repo's history** instead of staying constant. So the action a `○` row prescribes is a **check, not a slice**: look for slices carrying that PRD as `parent` among **closed** issues too (a tracker search for the PRD id, or its cross-reference list). Found → sliced and shipped, leave it alone. None anywhere → genuinely never sliced, and only then does `to-issues` apply. Legend: `✓` has open slices · `○` no open slices — shipped or never sliced, check which. Derivation, the rejected engine-side alternative, and the live occurrence: [reference/plan-mechanics.md](reference/plan-mechanics.md).

### 4b. Goal panel — membership is display, never candidacy

A **Goal** is a named finish line whose members live in one container on the tracker; the `goal` station cuts and curates it. This panel *reads* that membership and nothing else.

Run it wherever a goal container resolves: the github and markdown stores carry a default, and a linear consumer must declare `store.goal.container` in `wave.config.json` for one to exist at all. Where nothing resolves, the op refuses by design and names that config key — there is simply no panel, so skip the step and say so. Never work around the refusal by reaching for a tracker CLI, and never treat an empty panel as a finding: a consumer that keeps no goals is the ordinary case.

```bash
{{wave-cli}} issue-store goal-list
```

Returns `GoalView[]` (`{ id, title, description, container, memberIds }`). Use it for exactly two read-only things, both derived skill-side from the already-loaded `listOpen` results — no second engine call, nothing persisted:

- **A column.** Beside each candidate, name the goal whose `memberIds` contains its id (exact string match, the same discipline the PRD panel's `parent` match uses). The human choosing a set can then see which finish line each row moves.
- **A filter.** "Show me only the candidates in that goal" narrows what is *displayed*. It never narrows, widens, or reorders what is eligible.

**Membership authorizes nothing** (the goal station's own boundary — ADR-0044). A goal member is a candidate because it is eligible and passes DoR, and for no other reason; a non-member that is eligible is not demoted. So do not rank, score, sort, or pre-select by membership, and **never add a row to the candidate set that `listOpen` did not return** — a goal member missing from the pool is the readiness gate working, and the answer is to sharpen it (`triage`, then `to-issues`), never to reach past the gate here. Goals are also never cross-wave inputs: `cross-wave` takes candidates and claims, and a container id is neither.

### 5. Present the report; pick ids

Present the full picture:
- Eligible candidates with their Risk, Worker, and Blocked-by. Flag any `HITL-required` rows.
  > **Count `blockedBy` by narrowing the union — never with a bare `.length`.** It is `'none' | IssueRef[]`, and `'none'.length` is `4`: an unblocked row otherwise reports four blockers standing next to a genuine three, and the table reads as internally consistent. Neither TypeScript nor the JSON you actually read will stop you — `jq`: `if (.blockedBy | type) == "array" then (.blockedBy | length) else 0 end`; JS: `Array.isArray(b) ? b.length : 0`. Why, and the live occurrence: [reference/plan-mechanics.md](reference/plan-mechanics.md).
- Cross-wave result: parallel-safe or serialize (with the conflicting files and issue ids).
- Intra-wave conflicts, if any, so the Operator can plan the sequence.
- Public-API-change pairing advisory: any two-or-more `public-API-change` candidates flagged as a pairing — expect reconciled-merge landing rework even with disjoint `Files`; the human decides whether to serialize or split them across waves.
- **Dispatch-cost estimate for the set** (step 3c): full-pipeline rows × ~4 agents, `foreground` rows named beside it at their reduced cost (Reviewer + verdict Scribe; zero Worker-side, because the session implements them itself), the heavy-row count, and any `HITL-required` rows named as excluded. If the human is weighing two candidate sets, give the line for each — one per set, so the comparison is visible without re-deriving it.
- PRD panel: has open slices (✓) and no open slices (○ — shipped or never sliced; say which the check found, or that it is still unchecked).
- Goal panel, where a finish line is bound: which one each candidate serves. It is a column you can filter on — it never makes a row a candidate, never orders the set, and never adds a row the eligible pool did not already contain.

**Persist nothing.** The human picks the ids they want in the wave and hands them to `wave-create`.

## Common Mistakes

- **Excluding `HITL-required`.** These rows are real wave work. Include and flag them; do not drop them from the report.
- **Taking `.length` of `blockedBy`.** It is a union — `'none' | IssueRef[]` — and `'none'.length === 4`, so the row with **no** blockers reports more than one with three, and beside a real count the table looks internally consistent. TypeScript does not catch it: `.length` is valid on both members, so it infers `number` with no narrowing prompt (`.map` *is* caught — the loud failure is the lucky one). And the skill layer reads this as JSON from the CLI, not as TypeScript at all. Narrow with `Array.isArray` / a `type` test first. Live: a consumer published exactly that table to its operator.
- **Reading the PRD panel's `○` as "never sliced".** It derives "no **open** slices". A closed slice takes its `parent` backlink out of the candidate set with it, so a fully-shipped PRD is indistinguishable from a never-sliced one — and the error rate grows with the repo's history rather than staying constant. Check for closed slices before reaching for `to-issues`; live, six of seven flagged rows were fully shipped and slicing them again was the prescribed action.
- **Treating a PRD as a candidate.** A PRD is never in `listOpen`; it only appears in the PRD panel via `listDocuments`. Do not include it in the candidate set or cross-wave inputs.
- **Reading goal membership as candidacy.** A goal is a planning artifact and grants no execution rights: the eligibility set plus DoR stays the only gate into a wave. Render membership as a column or a filter — never as a reason to include, rank, order, or pre-select a row, and never as a source of ids the eligible pool did not return (sight, never permission — ADR-0044).
- **Persisting state from wave-plan.** wave-plan is advisory — it writes nothing. The `queued` claim and the spine creation happen in `wave-create`.
- **Inventing heuristics.** Do not score, rank, or filter candidates by wallclock, worker-mix, or risk-mix. Present the eligible set; the Operator decides. The step-3c cost line is not a heuristic — it is arithmetic over the set, reported and then left alone.
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

## Operator register (Convention 16)

**Everything you print for the person at this session is operator-directed output, and it holds one register.** Plain language, direct address ("du"/"you"), self-explaining. Translate every internal reference — a decision-record number, a convention number, a finding id, a wave slug, a retro path — into the one-line consequence it carries for them, instead of naming it. Introduce a domain term with a half-sentence the first time it appears in a session, then use it freely. End the run with an operator block: what happened → where it lives → what you do next. Operator-directed text follows the operator's own language; the artifacts you write — issues, PRs, decision records, spine entries — stay English. **Installed form is strict** — no internal token reaches the operator. **Source form**, flotilla's own repo, may append one compact reference pointer after the plain text. Full clause text, the operator mini-glossary, and the mistakes it closes: [wave-shared/reference/convention-16-operator-register.md](../wave-shared/reference/convention-16-operator-register.md), read as a file beside this skill's own directory — no skill invocation, no namespace to guess.
