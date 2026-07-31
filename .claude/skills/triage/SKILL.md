---
name: triage
description: Use when an incoming issue needs triaging — categorizing it bug/enhancement, reproducing it, gathering missing info, or marking it ready for an AFK agent or a human. Triggers on "triage this issue", "review incoming bugs", "is #42 ready for an agent?", "prepare this for an agent".
---

# triage

Move an incoming issue through the **issue-side** triage lifecycle: classify it, gather what is missing, and land it in a terminal triage state with the right comment. This is the front of the flotilla pipeline — triage produces the *eligibility* signal that lets `wave-plan` later consider an issue grabbable.

Your job is the **judgment** — categorize, reproduce, grill if underspecified, then apply the outcome. The engine is the guardrail: triage writes through a tracker-agnostic **Triage facet** on `IssueStore` (ADR-0015), never raw `gh`. So this skill stays on the judgment; the CLI invocation detail (the three verbs, the input shapes, the vocab) lives in [reference/triage-mechanics.md](reference/triage-mechanics.md) — reach for it once you know the outcome. You never touch a tracker directly; every read and write goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

## When to Use

- An untriaged / `needs-triage` issue needs to be evaluated, classified, and routed.
- A reported bug needs reproduction before it can be acted on.
- A **wave-born** issue — one carrying a wave-provenance line, filed bare at a wave's close — needs its premise verified against current `main` before it is recommended for anything (step 2).
- An underspecified issue needs grilling into a fully-specified spec.
- An issue is ready to be marked grabbable for an AFK agent (`ready-for-agent`) or routed to a human (`ready-for-human`).

Do **not** use this to slice work into a wave batch or write the wave Header-Block (Risk / Worker / Files) — that is the **`to-issues`** skill's separate dimension. triage decides *whether* an issue is ready; `to-issues` / `wave-plan` decide *how* a ready issue is sliced into a wave. The two never overlap.

## THE FLOTILLA BOUNDARY — triage NEVER writes the wave claim ledger

This is the one rule that makes this skill flotilla's own rather than inherited. **Read it before you apply any outcome.**

- triage writes **only** through the Triage facet (`triage-apply` / `triage-close`) — the consumer's issue-side triage roles and categories (`bug`, `enhancement`, `ready-for-agent`, …). These are the consumer's taxonomy; the engine imposes none (ADR-0003).
- triage **NEVER** writes a `wave/*` claim rung and **NEVER** calls `issue-store transition`. The `wave/*` rungs — `queued → in-flight → in-review → done` (+ `needs-attention`) — are flotilla's product, written **only** by the wave skills (wave-create / wave-start / wave-close). The engine enforces the split structurally: `triage-apply` touches only the triage dimension, never the claim ledger or the open/closed state. If you reach for `transition`, **stop** — that is a category error.
- triage's **only** coupling to waves: setting an issue's state to one in the configured **eligibility set** (a real consumer uses `ready-for-agent`) is what later makes `wave-plan` see it as grabbable. You are flipping the *issue-side* eligibility signal — you are **not** claiming the issue into a wave. The first ledger write (`queued`) happens later, in the wave skills, never here.

## The state machine

Two **category** values (pick exactly one): `bug` · `enhancement`.

Five **state** values (an issue carries exactly one). An untriaged issue enters at `needs-triage`; from there it moves to one terminal state:

| State | Meaning | Apply | Comment |
|---|---|---|---|
| `needs-triage` | not yet evaluated (entry) | `triage-apply` (state) | optional, if partial progress |
| `needs-info` | blocked on the reporter | `triage-apply` (state + comment) | **Triage Notes** (template below) |
| `ready-for-agent` | fully specified, an AFK agent can land it | `triage-apply` (state + comment) — eligibility signal | **Agent Brief** (template below) |
| `ready-for-human` | needs a human (judgment / external access / manual testing) | `triage-apply` (state + comment) | Agent-Brief-shaped + *why it can't be delegated* |
| `wontfix` | will not be actioned | `triage-close` (sets the state + native close) | polite prose explanation |

The state is **single-select**: applying a new state replaces the old one — the adapter computes the native swap, so you never add/remove labels by hand. `needs-info` returns to `needs-triage` once the reporter replies. A maintainer can override any transition — if a requested one looks unusual, flag it and confirm before acting.

> **`ready-for-human` is not `HITL-required`.** `ready-for-human` is triage's "a human handles this entirely, outside flotilla" terminal — the work **never enters a wave**. Do not confuse it with the Worker value `HITL-required` (`to-issues`' dimension), which **is** wave work that `wave-plan` surfaces, just human-gated (ADR-0015). Two different "human" concepts at two different pipeline stages.

The state vocabulary is **config / consumer-defined** — it comes from `wave.config` if it overrides the schema, else the `DEFAULT_TRIAGE_SCHEMA`. You pass the **canonical** role names (`ready-for-agent`, …); the adapter resolves canonical → the store's native representation (a GitHub label, a Linear workflow-state, a MarkdownFs status line). Never hardcode a native label string.

## Procedure

### 1. Gather context

Read the issue's full triage projection — title, body, current state/category, and every prior comment:

```bash
{{wave-cli}} issue-store triage-read <id>   # prints the TriageView (see reference)
```

The `TriageView` carries the reported content (title + body) **and** the comment thread (including the reporter's replies), so you can parse prior **Triage Notes** and not re-ask resolved questions. Explore the codebase for the relevant area, using the project's domain vocabulary and respecting the architectural decisions recorded for it.

If `triage-read` shows no state, the issue is at entry — treat it as `needs-triage`.

### 2. Premise currency — for any wave-provenance issue, whatever its category

**Trigger: the issue body carries a wave-provenance line** — a wave slug, a row id, an iteration — i.e. it was filed from a wave's disclosure rather than reported by a user. That line marks an issue written at a wave's close about something a wave *observed*, and the observation ages: the premise can be repaired, refactored away, or superseded by a later wave before anyone triages the ticket.

**Verify the premise against current `main` before you recommend anything.** Read the claim the issue rests on, then go and look: does the code, the guard, the doc, or the behaviour it describes still look that way on `main` today? A wave-born issue is triaged against the tree as it is now, never against the tree the closing Coordinator was looking at.

**This check is category-independent — that is the whole point.** The reproduce step below is deliberately bugs-only, and a wave-born issue is frequently enhancement-shaped (a wiring gap, a missing guard, a doc reconciliation), so it walks past reproduction untouched. Applying the premise check only to `bug` reproduces exactly the hole this step exists to close: an issue whose premise was **already false on `main` at filing time** was triaged, decorated, dispatched and implemented anyway. Run it on every wave-provenance issue regardless of the category you are about to recommend.

**A stale premise has a cheap exit: the superseded-close.** If the premise no longer holds, do not grill it into shape and do not send it back to the reporter — there is no reporter. Close it through `triage-close` (the configured won't-fix terminal), with a comment that names *what* superseded it: the change, PR, or wave that made the premise false, and the evidence you looked at. That comment is the whole audit trail; the state is just the terminal. This is a cheap, expected outcome for a wave-born ticket, not a failure of the wave that filed it.

**Partially stale is not stale.** If the premise still holds but the details have drifted, keep the issue and fold the current reading into the brief you post in step 6 — the correction belongs in the Agent Brief, not in a fresh ticket.

This closes the bare→ready transition's missing verification step: an issue filed bare at a wave's close (ADR-0027) had no premise check anywhere in its lifecycle until it reached here. Do **not** push the check back to close time — the disposition step deliberately authors observations rather than verified diagnoses, and verification is this skill's job, done with a fresh head.

**When to triage a wave-born bare issue at all: pull-triggered, never on a clock.** A bare issue costs nothing while it sits — no claim, no eligibility, invisible to `wave-plan` — and while it stays bare it keeps *ripening*: later waves append evidence to a still-bare thematic bundle (ADR-0027 Amendment 2026-07-31), and a premise that was going to die does so before anyone spends decoration on it (live: a bare issue filed at one wave's close was largely superseded by the next wave the same morning). So triage a bare wave-born issue when a planning pass wants its theme or the pool needs depth — not reflexively at close, and not on a fixed wait. The one exception is a mechanism defect the **next** wave would hit: fast-track that one, or thread its evidence into the brief of a row that already touches the area.

### 3. Recommend

Tell the maintainer your **category** and **state** recommendation with reasoning, plus a short codebase summary relevant to the issue. Wait for direction unless this is a direct override (see Quick state override).

### 4. Reproduce (bugs only)

Before any grilling, attempt reproduction: follow the reporter's steps, trace the relevant code, run the tests/commands. Report the outcome — a confirmed repro (with the code path) makes a far stronger agent brief; a failed or under-detailed repro is a strong `needs-info` signal.

### 5. Grill (if underspecified)

If the issue needs fleshing out before it can be `ready-for-agent` / `ready-for-human`, run a `/grill-with-docs` session. Capture everything resolved into the comment you post in step 6 — fold what the grilling settled into the **Agent Brief** (for `ready-for-agent` / `ready-for-human`) or the **Triage Notes** ("established so far", for `needs-info`). The grilling output is not durable on its own; it only survives if it lands in that comment.

### 6. Apply the outcome

Apply the state, category, and matching comment in **one** `triage-apply` call (or `triage-close` for `wontfix`). The facet **prepends the AI-provenance disclaimer to every comment for you** — never add it by hand. Exact input shapes per outcome: [reference/triage-mechanics.md](reference/triage-mechanics.md).

- **`ready-for-agent`** — post an **Agent Brief** (template below). Setting this eligibility state is what later makes `wave-plan` see the issue as grabbable (per the boundary — this is *not* a wave claim).
- **`ready-for-human`** — post an Agent-Brief-shaped comment plus a note on *why* it can't be delegated (judgment call, external access, design decision, manual testing).
- **`needs-info`** — post **Triage Notes** (template below).
- **`wontfix`** — `triage-close` with a polite explanation; it sets the won't-fix state and natively closes the issue in one call.
- **`needs-triage`** — apply the state; comment only if there's partial progress to record.

## Quick state override

If the maintainer says "move #42 to ready-for-agent", trust them: confirm the exact change you're about to make (new state, comment, any close), then apply directly. Skip the recommend/grill steps. If moving to `ready-for-agent` without a grilling session, ask whether they want an Agent Brief written first.

## Agent Brief template

The brief is the authoritative spec the AFK agent works from. Be **durable** (the issue may sit for weeks): describe interfaces, types, and behavioral contracts — **never** file paths or line numbers, and never assume the current structure persists.

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
What happens now (the broken behavior for bugs; the status quo for enhancements).

**Desired behavior:**
What should happen after the work is complete. Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` — current vs expected return/behavior
- Config shape — any new options needed

**Acceptance criteria:**
- [ ] Specific, independently-verifiable criterion 1
- [ ] Specific, independently-verifiable criterion 2

**Out of scope:**
- What should NOT be changed
- Adjacent feature that seems related but is separate
```

## `ready-for-human` template

Same shape as the Agent Brief (it is still the authoritative, durable spec — describe interfaces and behavioral contracts, never file paths or line numbers), with one added section recording *why* this work can't be delegated to an AFK agent.

```markdown
## Human-Only Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Why human-only:**
The specific reason an AFK agent cannot land this — e.g. requires a judgment/design call, external system access or credentials, manual/device testing, or a decision with no objective acceptance criterion.

**Current behavior:**
What happens now (the broken behavior for bugs; the status quo for enhancements).

**Desired behavior:**
What should happen after the work is complete. Be specific about edge cases and error conditions.

**Key interfaces:**
- `TypeName` — what needs to change and why
- `functionName()` — current vs expected return/behavior

**Acceptance criteria:**
- [ ] Specific, independently-verifiable criterion 1
- [ ] Specific, independently-verifiable criterion 2

**Out of scope:**
- What should NOT be changed
```

## Triage Notes template (`needs-info`)

```markdown
## Triage Notes

**What we've established so far:**

- point 1
- point 2

**What we still need from you (@reporter):**

- specific, actionable question 1
- specific, actionable question 2
```

Put everything resolved during grilling under "established so far" so it isn't lost. Questions must be specific and actionable — never "please provide more info".

## Common Mistakes

- **Writing the wave claim ledger from triage.** Never call `issue-store transition` or write a `wave/*` rung — that is the wave skills' job. triage flips only the *issue-side* triage state (`ready-for-agent`); the claim is written later, elsewhere. (The engine enforces this — `triage-apply` cannot reach the ledger — but don't go hunting for a back door.)
- **Confusing eligibility with a claim.** Setting `ready-for-agent` makes an issue *grabbable*; it does **not** queue or claim it into any wave.
- **Doing `to-issues`' job.** triage does not slice work, declare Files, or set Risk/Worker. A `ready-for-agent` issue is handed to `to-issues` / `wave-plan` for that — different dimension.
- **Hand-rolling the label swap or the disclaimer.** The facet is single-select (the adapter swaps state for you) and prepends the AI-provenance disclaimer structurally. Don't add/remove labels or paste the disclaimer yourself.
- **Hardcoding a native label string.** Pass the canonical role; the adapter resolves it to the store's native representation from config.
- **File paths / line numbers in the agent brief.** They go stale. Describe interfaces and behavioral contracts instead.
- **Re-asking resolved questions.** Read the prior comments in the `TriageView` first.
- **Skipping reproduction on a bug.** A confirmed repro is the difference between a strong brief and a `needs-info` round-trip.
- **Triaging a wave-provenance issue without checking its premise against current `main`.** The observation was written at a wave's close and ages between then and now — a premise that has already been repaired, refactored away, or superseded produces a decorated, dispatched, implemented ticket for work that no longer exists.
- **Running the premise check on bugs only.** It is category-independent by design (step 2). Reproduction is the bugs-only step; a wave-born issue is usually enhancement-shaped and would sail past both checks if this one inherited that gate.
- **Grilling a stale-premise issue into shape instead of superseded-closing it.** There is no reporter to round-trip with. Take the cheap exit: `triage-close` with a comment naming what superseded the premise and the evidence you looked at.
- **Inventing a `superseded` state.** The vocabulary is config-defined and has no such value — a superseded-close is the ordinary won't-fix terminal; "superseded" is the *reason*, and it lives in the comment.
- **Reaching for raw `gh` (or a markdown-files-as-tracker / `git mv`-to-`done/` ritual).** triage never touches a tracker directly — every read and write goes through the engine CLI (`{{wave-cli}} issue-store triage-*`), which selects the configured store.
