# PRD candidate: Headless flotilla — the Answer protocol and the Pulse

> **Status: published 2026-09-02 as a Linear Document** in the Flotilla project (Formtrieb workspace) — the tracker copy is the PRD; this file is the in-repo draft it was published from, kept beside the records that settled it: [ADR-0047](../adr/0047-a-stops-answer-is-a-typed-disposition-bound-to-a-spine-anchored-ask.md) and [ADR-0048](../adr/0048-a-headless-coordinator-is-a-finite-pulse-on-a-leased-spine-branch.md). Slice through `/to-issues` from the tracker copy. Source: the Linear document "Headless-Skizze: der Coordinator als Puls" (same project, 2026-08-31). Sequencing: post-launch work in the visibility plan.

## Problem Statement

A wave's execution — Workers, Reviewers, re-dispatch rounds — takes hours, and today it needs a live Coordinator session on an Operator's machine for the whole span. A STOP asks in chat, so the Operator has to be at that session to answer; nothing else can answer. If the session dies, `wave-resume` recovers — but only on the same machine, because the guard against dispatching a row twice looks at local worktrees. An Operator who plans four waves for a day drives all four by hand, one at a time, at a laptop. The Companion App can *show* that a row needs attention and cannot *answer*, because the answer half of the needs-attention protocol was never designed.

## Solution / Approach

flotilla runs headless as a **Pulse**: a finite, triggered, unattended Coordinator run that reconciles from the durable homes, consumes every **Answer** a human left on the tracker, advances everything it can without a person — dispatches, routes, flags STOPs and moves on, arms what the wave's own landing authorization allows — and exits at **Quiescence** with a report. Between pulses there is no process, only state on a `spine/<slug>` branch that any authorized runner can check out: a CI job, a cloud session, another Operator's laptop. A STOP becomes an **Ask** with an engine-owned option set; the Operator answers from the tracker or from the phone; the next pulse acts on it. Humans still plan and cut every wave, still approve every public-API change, still land the overlapping tail and archive — headless moves *where* a decision is made, never *whether*.

## User Stories

1. As an Operator, I want a STOP to reach me as a question with fixed options on the tracker, so that I can decide from anywhere and a later run acts on exactly what I chose.
2. As an Operator on the Companion App, I want to see the Ask's question and options as buttons and answer with one tap plus an optional note, so that the phone is an operating surface, not a monitor.
3. As an Operator, I want to answer a Reviewer's blocking question with a note and have the Reviewer re-run with that note in its brief, so that the answer reaches the agent that asked it.
4. As an Operator, I want to grant one more round after the re-dispatch cap is exhausted, so that a recoverable row is not lost to a fixed limit — and I want that grant to be one per Ask, so that termination stays guaranteed.
5. As an Operator, I want a park or abandon decision to be an option on every Ask, so that the disposition menu is the same in chat and on the tracker.
6. As a maintainer of a public repo, I want an Answer from a non-collaborator to be ignored and reported, so that a stranger cannot trigger anything and I still see the attempt.
7. As an Operator, I want the interactive Coordinator to record my chat decision through the same Answer path, so that there is one record of every human decision regardless of where it was made.
8. As an Operator, I want to plan and cut several waves in one sitting and have pulses run them one after another, so that a day's throughput is not gated on my presence at each wave boundary.
9. As an Operator, I want a wave whose premises moved after an earlier wave landed to stop honestly — a row Ask for a failed Definition of Ready, a rewritten and disclosed Conflict-Map for new overlap — rather than be dispatched against a stale plan or aborted wholesale.
10. As an Operator, I want an intra-wave lane (rows blocked on each other) to advance inside one pulse as blockers reach review, so that a serial lane does not cost one cron period per step.
11. As an Operator, I want two runs on the same wave to be serialized structurally, so that two of us — or my laptop and CI — can never double-dispatch a row.
12. As an Operator, I want a run that died on an ephemeral runner to lose at most what it had not pushed, so that a crashed CI job costs minutes, not a wave.
13. As an Operator, I want the next pulse on a different machine to adopt a Worker branch that was pushed but whose report was not, so that finished work is never redone.
14. As an Operator, I want to give the landing authorization once per wave when I cut it, so that a pulse arms the order-free approved rows without asking again and a wave I did not authorize waits for me.
15. As an Operator, I want a wave-level STOP — a broken precondition — to fail the runner loudly with its reason recorded on the spine, so that the runner's own failure surface tells me.
16. As an Operator, I want the pulse's exit report in the operator register, so that I can read what happened, where it lives, and what I do next without knowing internals.
17. As a consumer adopting flotilla, I want a runner example scaffolded by `wave-setup` — a GitHub Actions workflow with the right timeout, concurrency, permissions, and prompt wording — so that the first headless pulse is a copy, not a design exercise.

## Implementation Decisions

Decisions, not files; the two ADRs carry the reasoning.

**Answer protocol (ADR-0047)**
- The needs-attention payload gains a STOP `reason` and an `askId`; the option set per reason is an engine-owned closed vocabulary (`park` and `abandon` on every Ask, plus at most one continuation: `approve`, `answer`+note, `retry`, `reopen`); `flag` takes the reason and derives the options.
- The spine gains an attention record per Ask (id `<row>#a<n>`, reason, kind, since; later the consumption: option, author, time), written before the tracker flag — the pause becomes a spine fact.
- The IssueStore gains an Answer facet: `answer(id, askId, option, note?)` and `readAnswer(id, askId)`, intent-shaped, realized per adapter as a sentinel-marked comment (`<!-- wave-answer v1 <ask-id> -->`) or a MarkdownFs `## Answer` block. The Ask comment and the Answer comment are a published, versioned wire contract; the comment read in both API seams widens to author, association, and creation time.
- Authorization is tracker-derived by default (GitHub write-capable association; Linear workspace member, not guest; MarkdownFs file access); a configured allowlist replaces it; rejected Answers are reported, never applied.
- Four `WaveEvent`s (`human-approve`, `human-answer`, `human-retry`, `human-reopen`) with cells legal only from the STOP's resting state (`human-retry` from `planned` self-transitions for `dor-drift`); `park`/`abandon` stay the Coordinator-set two-step. Granted rounds run outside the cap, one per Ask. Consumption is WAL-ordered: spine record → act → clear flag.
- The interactive Coordinator writes chat decisions through the same verb and consumes them through the same events.

**The pulse (ADR-0048)**
- `wave-create` creates and pushes `spine/<slug>` from the anchor and records the per-wave landing authorization through a verb; `wave-close` phase 6 becomes the archive PR from that branch; flotilla's own `.gitignore` un-ignores `.flotilla/waves/`.
- The spine and sidecar write verbs gain `--publish` (add, commit, push; engine-owned git spawn; bounded `index.lock` retry; typed rejection error). Scribes and the Coordinator publish per write. Durable means on the remote.
- The spine gains a Pulse-Log with `pulse-start` (the Lease: pushed before any dispatch; a rejected push exits without touching anything; expiry = `pulse.maxLifetime` = the runner's own timeout; `takeover-of` on an expired lease) and `pulse-end` (outcome, consumed Answers, rows moved). Interactive dispatching passes take and release the lease too.
- `resume` gains remote heads as a fourth input and adopt-by-branch decisions; it never deletes a remote branch.
- A new `wave-pulse` station composes the existing ones in fixed order: select wave (live rows first, else oldest `ready`) → lease → reconcile → consume Answers → `wave-start` in flag-and-continue mode with the drift degrades and the in-pulse lane loop → re-read Answers at quiescence → `wave-close --auto` under the wave's own authorization (arm only, never archive) → `pulse-end` → operator report.
- `wave-setup` probes for pre-existing `spine/*` refs and scaffolds the runner example; the `-p` prompt carries the explicit workflow opt-in wording (`ultracode` is ignored in print mode).

**Deep modules worth aiming for:** the Answer facet (one interface, three adapters, one conformance suite); the publish step inside the write verbs (one git seam for spine and sidecars); the lease as two spine verbs whose only external dependency is `git push`'s exit code.

## Testing Decisions

- **Conformance suite (existing seam, highest):** flag with reason → answer → readAnswer → clearFlag on all three stores, plus the rejection cases (unauthorized author, unknown option, stale ask id) — each rejection observed as a *reported* outcome, never a silent no-op.
- **State machine spec (existing):** every new event × every state — legal cells transition, illegal cells `noop`; the one-granted-round-per-Ask rule proven by a second exhaustion raising a new Ask.
- **Spine round-trip spec (existing):** attention records and Pulse-Log entries survive `renderSpine`/`readSpine` byte-preserving.
- **Seam test `wave-start → resume` (existing pattern, ADR-0021):** extend with remote heads — a pushed branch and no report yields `adopt`, neither yields `redispatch`, and a remote branch is never in the crash-clean's delete list.
- **Publish seam (new, at the verb boundary):** against a local bare remote — a write publishes; a non-fast-forward is the typed rejection; the `index.lock` retry is bounded and observed failing once (Convention 11).
- **Lease seam (new, same bare remote):** two `pulse-start` calls against one branch — the second is rejected; an expired lease is taken over and says so; a mid-run rejection aborts.
- **Skill-level:** the reference guards and the YAML guard cover the new station; the drift-spec pins the exported option-set const against any inlined copy.
- **Live gates (not unit-testable, recorded as such):** the `-p` background-wait ceiling with an hours-long Worker; tracked `permissions.allow` parity in `-p`; the first cross-machine adopt on a real consumer.

## Out of Scope

- Workers that survive a pulse (detached harvest) — v2, maybe never.
- The next wave's recommendation as an Ask the Operator answers from the phone — v2; needs a wave-less Ask surface.
- Webhook triggers; roaming pulses as the normal case; the stale-claim reaper; the rebase-train at the arm step.
- `escalate` (→ `ready-for-human`) as an Ask option — a triage act.
- Any automatic planning, creating, archiving, or mirror-pass publishing.
- The Companion App's own changes (its repo) — this PRD only fixes the contract it consumes.

## Further Notes

- Glossary terms settled: **Ask**, **Answer**, **Pulse**, **Quiescence**, **Pulse-Log**, **Lease**; the **Spine** entry now names its branch. "park-and-continue" is retired — the pattern is flag-and-continue, and a stopped row is paused, never `parked`.
- Suggested slicing order (the grill's own order): the Answer facet and option vocabulary → the four events and the spine attention record → the interactive Coordinator on the Answer path (a live-provable slice on its own) → the spine branch at `wave-create` and the archive PR → `--publish` on the write verbs → the Lease verbs → remote heads in `resume` → the `wave-pulse` station → the runner scaffold in `wave-setup`. The first three land value in the interactive topology before any headless run exists.
