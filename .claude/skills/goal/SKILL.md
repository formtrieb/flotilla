---
name: goal
description: Use when a project needs a named finish line on the tracker — creating it, deciding which issues belong to it, and reading what is still open before it is reached. It files the first round of work as plain placeholder tickets that carry no readiness marker, so nothing it creates can be picked up by a background agent until a person sharpens it, and its status pass only reports — it never declares the finish line reached. Triggers on "cut a goal", "what is left before <goal>", "add this to the goal", "goal status".
---

# goal

A **Goal** is a named finish line: a set of issues living in **one container on your tracker** — a GitHub Milestone, a Linear Project, a file on the local markdown store — plus its **Frontier**, the derived remainder of members that are not finished yet. This station is the fourth planning station, beside `triage`, `to-prd` and `to-issues`, and it runs in three passes:

| Pass | Writes? | What it does |
|---|---|---|
| **cut** | yes | mints the container and files its opening frontier as **bare** tickets — title, prose, provenance line — with the dependencies you already know drawn between them |
| **curation** | yes | joins a member to the goal, including the handoff when a placeholder outgrows itself and its slices join in its place |
| **status** | no | reports the five-state frontier and stops |

Your job is the **judgment** — what the finish line is, what its opening frontier contains, which issue belongs to it, and what the report means. The engine is the guardrail: it owns the container binding, the bare filing shape, and the frontier derivation, and it deliberately exposes no verb for dispatching or for declaring a goal finished. So this skill stays on the judgment; the CLI invocation detail lives in [reference/goal-mechanics.md](reference/goal-mechanics.md) and the report's own shape in [reference/frontier-report.md](reference/frontier-report.md) — reach for them once a pass is confirmed. You never write a tracker directly; every read and write goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

## When to Use

- A release, a launch, or any other finish line needs naming, and the first round of work it implies needs to exist before anyone can say what it is.
- An issue should join an existing finish line, or a placeholder has been sliced and its slices should join in its place.
- Someone asks "what is still open before we get there?"

Do **not** use this skill to make a member ready for a background agent — `triage` decides *whether* it is ready and `to-issues` writes the planning header it needs. Do not use it to capture a design as a PRD (`to-prd`) or to choose what runs next (`wave-plan`). And do not use it to run anything: this station dispatches nothing, ever.

## THE FLOTILLA BOUNDARY — sight, never permission

**Goal membership informs planning and authorizes nothing.** This is the one rule that makes the station safe to hand a planning agent, and every clause below is structural rather than a promise:

- **The station never stamps eligibility.** Cut files **bare** issues — no planning header, no readiness marker — so nothing it creates can be drawn into a wave on its own. Sharpening bare → ready stays where it lives: `triage`'s answerability test and `to-issues` decorate-mode. If you find yourself reaching for `issue-store annotate` here, **stop** — that is `to-issues`' job.
- **The station never dispatches.** The Goal facet has no dispatch verb and never will, so there is nothing here to reach for. An issue enters a wave because it is *eligible and passes the readiness gate* — never because it is in a Goal.
- **Downstream, membership is display only.** `wave-plan` may read the facet for a read-only goal panel or filter, exactly as it surfaces PRDs today. Every execution skill from `wave-create` onward is blind to the facet by design; do not teach one to read it.
- **The station never declares the finish line reached.** There is no close verb on the facet. Status reports that the frontier is empty; closing the container is **your** act in the tracker. The station owes the accounting, never the declaration — and because there is no durable marker to write, an agent has nowhere to record a release authorization for itself.

## Per-pass human yes

**Every writing pass previews its writes and takes an explicit confirm, and no pass inherits an earlier pass's approval.** A confirmed cut authorizes exactly the container and the members it previewed; a curation pass run five minutes later previews and asks again. Present the preview as the concrete list of writes — the container's name, each member's title, each dependency edge, each membership join — and wait for a yes before the first call. The status pass is read-only and needs no confirm.

## The container binding

Which native container a Goal is realized as is a **setup-time config fact**, `store.goal.container` in `wave.config.json` — never a choice made at call time and never one this skill makes for you. GitHub defaults to its Milestone, the only native container with direct issue membership; the markdown store defaults to its goal file; **Linear has no default at all** and refuses loudly, because live consumer conventions disagree about what a Linear project means. A refusal names the config key and the roles the store ships — read it, fix the config, re-run. Never work around it by reaching for a tracker CLI. Full binding detail and the refusal shapes: [reference/goal-mechanics.md](reference/goal-mechanics.md).

## Pass 1 — cut

**Existence first.** At a cut you know *that* a workstream must exist long before anyone can say *what* it is, so the members are filed bare and sharpened later.

1. **Name the finish line.** One title a stranger can read, plus a short prose description of what being finished means. Do not encode a date, a status, or a checklist in it — completion is a query over the members, not a sentence in the container.
2. **Draft the opening frontier.** One placeholder per workstream that must exist. Each carries a title, a paragraph of prose saying what the workstream is *for*, and a **provenance line** naming where the cut came from (the session, the design record, the conversation). Draw a dependency where you already know one — a placeholder may depend on another placeholder even while neither is specifiable yet.
3. **Preview and confirm.** Print the container, every member title, every dependency edge, and stop. **Do not file anything until the person says yes.**
4. **File, blockers first.** Mint the container, then file each member as a bare issue through the engine CLI, then join each to the container. Blocker-before-dependent, so a dependent can name a real id. Capture every printed id — they are opaque; never reconstruct one from a title. Commands, input shapes, and the id-inversion step: [reference/goal-mechanics.md](reference/goal-mechanics.md).
5. **Report.** Name the goal, its members, and the next step for each: every one of them is a placeholder, and none of them can be picked up until it is sharpened.

> **The bare dependency is realized natively.** A dependency between two bare members becomes a real tracker relation — a GitHub issue dependency, a Linear issue relation — and writes no header line, so the members stay bare. The local markdown store cannot represent it and **refuses** rather than faking it; on that store, either file the member without the edge and record the dependency when it is sharpened, or file it decorated through `to-issues` in the first place.

## Pass 2 — curation

**The frontier is deliberately editable, and every edit is a human act.**

- **Joining.** One call joins one issue to one goal. It is idempotent, and it touches membership only — never the claim marker, never the triage state, never eligibility, never open/closed. Any issue may join: one you filed at the cut, one that already existed, a slice someone wrote last month.
- **The slicing handoff.** When a bare member outgrows its placeholder, it becomes a PRD (`to-prd`) whose slices (`to-issues`) join the goal by curation — **the slices join, the PRD does not**. A PRD is consumed rather than finished, so it has no completion state to query and can never be a member; it belongs to the goal derivedly, through its slices. The superseded placeholder then closes — and closing it is your act in the tracker, or `triage`'s won't-fix route where that is the honest verdict. This station names the placeholder and hands it over; it does not close it.
- **Leaving.** There is no leave verb. A member leaves by being removed from the container in the tracker, which is where you do it; the station reads the result on the next status pass.
- **Preview and confirm, per pass.** List each join, each handoff, and what the frontier will look like afterwards. Then ask. A yes given to a cut is not a yes to a curation pass.

## Pass 3 — status

Read-only, free, and the pass most runs will be. Ask the engine for the frontier and render it; derive nothing yourself and write nothing at all.

Each member reads as exactly one of five states — one finished bookend and four open ones:

| Reading | What it means | Who moves it |
|---|---|---|
| `done` | closed on the tracker | nobody; it is finished |
| `in-motion` | a wave has claimed it | the wave that holds it |
| `actionable` | ready, unblocked, unclaimed | a wave could pick it up now |
| `blocked` | waiting on a dependency nothing has resolved | whatever it waits on |
| `unready` | bare — it needs sharpening before any wave can draw it | `triage`, then `to-issues` |

Render the distribution, then name names: **who is `unready`** (and which of the two sharpening skills each one needs), **who is `blocked` and on what**, and who is moving. A blocker the store could not resolve counts as unresolved, never as clear — say so rather than presenting the member as free. Report shape, the operator translations for each reading, and the worked example: [reference/frontier-report.md](reference/frontier-report.md).

**On an empty frontier, report it and stop.** Say that every member is finished and that the remaining step is yours: **close the container in the tracker.** Do not close it, do not write a release marker, do not file a note beside it — there is deliberately nowhere to write one, and a freshly-minted, still-unpopulated container also reads as empty.

End every pass with the operator block: what happened → where it lives → what you do next.

## Common Mistakes

- **Stamping readiness at the cut.** A bare member has no planning header and no readiness marker on purpose — existence is recorded, wave-readiness is not implied. Decorating it here collapses two separate decisions into one and puts unsharpened work in front of a background agent.
- **Treating membership as candidacy.** A goal is a planning artifact; the readiness gate is the only thing that lets work into a wave. A member that is in the goal and not eligible stays out, and that is the design working.
- **Closing the container.** The station reports an empty frontier and stops. The declaration is a human act in the tracker; there is no verb here for it and adding one would hand an agent its own release authorization.
- **Making a PRD a member.** A PRD is consumed, never done, so it has no completion state to query. Its slices are the members; the PRD belongs to the goal only through them.
- **Riding an earlier approval.** Each writing pass previews and asks for itself. A cut approved this morning authorizes nothing this afternoon.
- **Filing members through a tracker CLI.** Every write goes through the engine CLI, which resolves credentials and selects the configured store. Reaching past it is the defect class the triage facet already retired once.
- **Spelling a dependency reference by hand.** Ids are opaque. Ask the engine to invert one; never split an id on a separator or rebuild it from a title or a filing hint.
- **Picking a container when the config does not name one.** A store that binds no default refuses on purpose. Set the key in the config; do not choose a container on the consumer's behalf.
- **Reading a goal panel as a wave plan.** Membership is a display column. It never orders, ranks, or qualifies candidates.

## Provenance

- **[ADR-0044](../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md)** — the decision this station carries: bare frontier tickets at the cut, the goal as an issue-set boundary orthogonal to PRDs, the facet on the store, the config-bound container role, the derived-never-written frontier, and *sight, never permission*. The file is `docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md`, beside the other decision records.
- The five readings and the classification ladder are the engine's, in `tools/wave/src/goal-frontier.ts` — this skill renders them and never re-derives them.
- The requirements arrived as counter-examples from an evaluation of a third-party planning-map tool: a planning/execution boundary that was only prose, an agent that wrote itself a release authorization into a map's free-prose notes, a planning-to-execution seam that never became typed, and remote writes against a tracker nobody had consented to. Each is closed structurally above rather than by instruction.

## Operator register (Convention 16)

**Everything you print for the person at this session is operator-directed output, and it holds one register.** Plain language, direct address ("du"/"you"), self-explaining. Translate every internal reference — a decision-record number, a convention number, a finding id, a wave slug, a retro path — into the one-line consequence it carries for them, instead of naming it. Introduce a domain term with a half-sentence the first time it appears in a session, then use it freely. End the run with an operator block: what happened → where it lives → what you do next. Operator-directed text follows the operator's own language; the artifacts you write — issues, PRs, decision records, spine entries — stay English. **Installed form is strict** — no internal token reaches the operator. **Source form**, flotilla's own repo, may append one compact reference pointer after the plain text. Full clause text, the operator mini-glossary, and the mistakes it closes: [wave-shared/reference/convention-16-operator-register.md](../wave-shared/reference/convention-16-operator-register.md), read as a file beside this skill's own directory — no skill invocation, no namespace to guess.
