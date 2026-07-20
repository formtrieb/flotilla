---
name: wave-plan
description: Use when planning the next wave — draw the wave-eligible candidate set and run the cross-wave parallel-safety check against what other waves already claimed. Read-only/advisory; the human picks ids and hands them to wave-create. Triggers on "plan a wave", "what can run next", "cross-wave check".
---

# wave-plan

Answer "which eligible issues could form the next wave, and can they run alongside what's already in flight?" This is the strategic layer — read-only, advisory, and the only output is a report. Materializing one approved wave into a spine and worktrees is `wave-create`'s job.

Your job is the **judgment** — reading the report, flagging what needs attention, and helping the human pick the right set of ids. The CLI plumbing (the four commands, the exact sequence, the worked `CrossWaveResult` sample) lives in [reference/plan-mechanics.md](reference/plan-mechanics.md) — reach for it once you need to drive the engine. You never touch a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

**M1 scope: candidate draw + cross-wave report + PRD panel. No batch-sizing heuristics** — sizing by worker-mix, risk-mix, or wallclock estimates is a soft CHARTER idea, not an M1 requirement. Do not invent heuristics.

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
- PRD panel: consumed (✓) and un-consumed (needs slicing).

**Persist nothing.** The human picks the ids they want in the wave and hands them to `wave-create`.

## Common Mistakes

- **Excluding `HITL-required`.** These rows are real wave work. Include and flag them; do not drop them from the report.
- **Treating a PRD as a candidate.** A PRD is never in `listOpen`; it only appears in the PRD panel via `listDocuments`. Do not include it in the candidate set or cross-wave inputs.
- **Persisting state from wave-plan.** wave-plan is advisory — it writes nothing. The `queued` claim and the spine creation happen in `wave-create`.
- **Inventing heuristics.** Do not score, rank, or filter candidates by wallclock, worker-mix, or risk-mix. Present the eligible set; the coordinator decides.
- **Confusing `crossWaveConflicts` with `intraWaveConflicts`.** Cross-wave overlaps (candidate↔claimed) are the launch-gate concern. Intra-wave overlaps (candidate↔candidate) are a sequencing concern within the wave. Report them distinctly.
- **Conflating `HITL-required` (Worker) with `ready-for-human` (triage terminal).** `ready-for-human` never enters a wave and never appears in `listOpen`. `HITL-required` is in the eligible set and must be surfaced.
- **Reaching for raw `gh`.** wave-plan never touches a tracker directly — everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.
- **Omitting `--repo-root` on `cross-wave` (FOR-38).** This is not a harmless shortcut — it silently degrades glob-pattern conflict detection to exact-text matching only, and a live finding showed it drop conflict cells (17 vs. 40 on the same roster). Always pass it. If `cross-wave` ever returns a non-empty `warnings`, surface it — do not report `parallelSafe: true` as clean when patterns went unevaluated.
