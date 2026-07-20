---
name: to-prd
description: Use when turning the current conversation, spec, or design discussion into a PRD published as an issue on the project tracker. Triggers on "write a PRD", "turn this into a PRD", "draft a product requirements doc", or when an upstream design session is ready to be captured as a planning artifact for slicing.
---

# to-prd

Synthesize the current conversation into a **PRD** and publish it as a single planning **document** on the tracker. The PRD is the front of the pipeline: it is **not** a wave slice — it carries no wave Header-Block and is never eligibility-stamped, so it never enters a wave. The downstream `to-issues` skill later slices it into independently-grabbable, wave-eligible issues, each backlinked to it via `Parent`.

Your job is the **judgment** — synthesizing what the conversation already established into a tight, structured PRD and confirming its scope. The engine is the guardrail: it publishes through the store's Document facet, assigns the id, and renders the body. So this skill stays on the judgment; the CLI invocation detail (commands, JSON shape, verify) lives in [reference/filing-mechanics.md](reference/filing-mechanics.md) — reach for it once the draft is confirmed. You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`).

Do **not** interview the user from scratch — synthesize what you already know. Do confirm the drafted structure before publishing.

## When to Use

- A design discussion, spec, or brainstorm in the conversation is ready to be captured as a PRD.
- The user says "write a PRD", "turn this into a PRD", "draft requirements".
- An upstream skill (e.g. `brainstorming`, `grill-with-docs`) has settled a design and hands off the writeup.

Do **not** use this to slice work into tickets — that is `to-issues`. Do not triage/label/close issues — that is `triage`. One `to-prd` call yields one planning document; `to-issues` is the **required** downstream step that turns it into wave-eligible work.

## 1. Gather context

Work from what is already in the conversation and the repo. Explore the codebase if you have not already. Use the project's domain vocabulary throughout, and respect the architectural decisions recorded for the area you touch. Do not invent requirements the conversation did not establish.

## 2. Draft the PRD sections

Carry the section set below. Keep each section tight and scannable — a PRD is read, not skimmed once and filed.

| Section | Content |
|---|---|
| **Problem Statement** | The problem the user faces, from the user's perspective. |
| **Solution / Approach** | The solution to that problem, from the user's perspective. |
| **User Stories** | A numbered list, each `As an <actor>, I want a <feature>, so that <benefit>`. Be extensive — cover all aspects. |
| **Implementation Decisions** | Modules to build/modify, interfaces, architectural decisions, schema/contract changes, specific interactions. Describe decisions, not files — paths and snippets go stale. (Exception: a prototype-produced snippet that encodes a decision more precisely than prose — a state machine, schema, type shape — trimmed to the decision-rich parts, noted as from a prototype.) |
| **Testing Decisions** | The **seams** at which the feature is tested — **use the highest seam possible, and prefer existing seams over new ones**; if a new seam is needed, propose it at the highest point you can. Plus: what makes a good test (external behavior, not implementation detail), which modules get tested, prior art in the codebase. |
| **Out of Scope** | What this PRD deliberately does not cover. |
| **Further Notes** *(optional)* | Anything else worth recording. Omit if empty. |

When sketching Implementation Decisions, actively look for **deep modules** — ones that encapsulate a lot of functionality behind a simple, testable interface that rarely changes — rather than shallow pass-through layers.

A PRD carries **no** Risk/Worker/Files/acceptance-criteria and no Header-Block — those belong to the slices `to-issues` derives. Because it is never eligibility-stamped, there are no placeholder fields to invent and no eligibility-pollution to work around: a PRD simply cannot enter a wave's candidate set.

## 3. Confirm with the user before publishing

Present the drafted structure (the title + a one-line summary per section, or the full draft if short). Ask whether the scope, the module breakdown, the user-story coverage, **and the testing seams** match expectations — the seam choice is load-bearing enough to confirm explicitly, not bury in the draft. **Iterate until the user approves. Do not publish an unconfirmed PRD.**

## 4. Publish and hand off

Publish through the store's Document facet (`publishDocument`, *not* `issue-store create`), capture the printed opaque id, and verify the round-trip with `readDocument`. Exact commands and the JSON shape: [reference/filing-mechanics.md](reference/filing-mechanics.md).

Then report the published PRD id + title and point the user at the downstream step: **run `to-issues` to slice this PRD into independently-grabbable, wave-eligible issues.**

## Common Mistakes

- **Publishing via `issue-store create`.** A PRD is a document — use `publishDocument`. `create` is the wave-slice contract and would demand Risk/Worker/Files a PRD has no business carrying. Equivalently: never treat the PRD as a wave slice — it carries no Header-Block, is never eligibility-stamped, and is never grabbed by a wave.
- **Interviewing from scratch.** Synthesize what the conversation already settled; don't re-gather established requirements.
- **Publishing unconfirmed.** Draft → confirm scope/structure → only then publish.
- **Reconstructing the id.** Capture the printed opaque id; never derive it from the title or filingHint.
- **File paths / code in prose.** Implementation Decisions describe decisions, not files — paths and snippets go stale. The one exception is a decision-encoding prototype snippet, trimmed.
- **Tracker-specific assumptions.** Don't assume a particular tracker, branch ritual, or build tool — no markdown-files-as-tracker, no `git mv` to a `done/` folder, no direct-push-to-main. The store behind the CLI is config-selected; stay tracker-agnostic and reach the engine only through `{{wave-cli}}`.
