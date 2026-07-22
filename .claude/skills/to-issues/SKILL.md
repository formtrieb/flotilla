---
name: to-issues
description: Use when breaking a plan, spec, or PRD into independently-grabbable, wave-eligible issues on the tracker — or when decorating an already-filed issue with the wave Header-Block (Risk / Worker / Files / Blocked by). Triggers on "turn this into issues", "create implementation tickets", "make these wave-ready".
---

# to-issues

Break a plan into independently-grabbable issues using **tracer-bullet vertical slices**, and write each with the wave **Header-Block** so a wave can grab it on creation. This is the linchpin of the pipeline: downstream `wave-create` / `wave-start` only ever see what this skill files.

Your job is the **judgment** — slicing, classifying Risk/Worker, declaring Files, ordering the publish. The engine is the guardrail: it validates format, assigns ids, and runs the gates. So this skill stays on the judgment; the CLI invocation detail (commands, JSON shapes, the two-pass, the self-check) lives in [reference/filing-mechanics.md](reference/filing-mechanics.md) — reach for it once a breakdown is approved. You never write a tracker directly; everything goes through the engine CLI (`{{wave-cli}}`), which selects the configured store.

Two modes: **create** (mint new issues from a plan) and **decorate** (add the missing wave fields to an issue someone already triaged).

## When to Use

- The user has a plan, PRD, spec, or design doc and wants it turned into issues.
- The user wants existing triage-ready issues made wave-eligible (decorate).
- An upstream skill (`to-prd`, `triage`) hands off work to be sliced into a wave batch.

Do **not** triage, label, or close issues — that is the `triage` skill's dimension. This skill only writes the `wave/*`-relevant Header-Block; it never touches issue-side taxonomy labels.

## 1. Gather context

Work from what is in the conversation. If the user passes an issue reference, read it first (`issue-store read <id>`). Issue titles should use the project's domain vocabulary and respect the architectural decisions recorded for the area you touch.

## 2. Draft the slices

The invariant every slice must satisfy: **independently grabbable, self-verifiable, and conflict-bounded** (its declared Files contain the real change). *How* you reach the invariant depends on the kind of work:

- **Feature / new-behavior work → tracer-bullet vertical slices.** A thin vertical slice that cuts through ALL layers end-to-end (schema → logic → surface → tests) — **never** a horizontal slice of one layer. This is the strong default. LLMs drift toward horizontal ("add the schema", "add the API") because it feels orderly; resist it — a half-built layer is not self-verifiable, so it is not a valid slice.
- **Mechanical / isolated-refactor work → one coherent, file-bounded change.** A codemod renaming an API across 40 files, or a contained refactor, is legitimately *horizontal* and that is fine — still one independently-grabbable, verifiable, bounded unit. A **narrow, justified** carve-out, not a softening: it holds only when the slice's Risk is genuinely `mechanical` / `isolated-refactor`. Don't use "it's just a refactor" to rationalize horizontally slicing feature work — the burden of proof stays on the vertical default.

> **Same-number collision (named hygiene rule).** When two or more slices of one batch each append to the same shared numbered/ordered list — a conventions list, an ADR index, a policy-clause list — by claiming "the next free number," the conflict-map only sees the file overlap; it cannot see that both slices claim the same number. That is a *semantic* collision, invisible until landing (docs/retros/2026-07-20-landing-seam-w9.md, W9-F2: two docs slices each appended a "Convention 7" to the same list; the collision was only caught by the Reviewers' merge-tree prediction and cost a landing-time renumber). It is planable at slicing time. Two mitigations, either is enough: **(1)** assign the actual identifiers at slicing time, so each slice's body already names its distinct, non-colliding number; or **(2)** if the number can't be pinned down yet, record the landing-renumber expectation explicitly in every affected slice's body.

Also classify each slice **AFK** (an agent can **implement** it unattended) or **HITL** (needs human interaction — a design decision, a recorded decision, a review). Prefer AFK. "AFK" means *implement* unattended, not *land* unattended: a `public-API-change` slice is AFK-implementable but meets a human landing-approval STOP at merge, so its Worker is still an autonomous `background-heavy`.

## 3. Quiz the user on the breakdown

Present the slices as a numbered list. Per slice show: **Title**, **Type** (AFK/HITL), **Blocked by** (which slices must land first), **Stories covered** (if the source has them).

Then ask: is the granularity right (too coarse / too fine)? Are the dependencies correct? Should any slice split or merge? Are AFK/HITL right? **Iterate until the user approves.** Do not publish on an unconfirmed breakdown.

## 4. Compose the Header-Block per approved slice

Vocab comes from `wave.config.json` if it overrides the schema, else the `DEFAULT_WAVE_SCHEMA`.

**Risk** (required) — pick one. If unambiguous from the plan, set it; otherwise **prompt the user** (Risk is load-bearing — it routes the Worker and gates review):

| Risk | Meaning |
|---|---|
| `mechanical` | script/codemod, no judgment calls |
| `isolated-refactor` | one module/area, no cross-cutting impact |
| `cross-feature-refactor` | touches 2+ areas or shared infra |
| `public-API-change` | adds/changes a public input/output/contract |

**Worker** (required) — route from Risk + slice kind. The vocabulary is **autonomy-first and brand-free**: the value names *who must be in the loop*, not which model. The model tier is the abstract `-heavy` marker; the driver binds `heavy → <strong model>` from config — never name a model here.

| Slice profile | Worker |
|---|---|
| AFK + Risk ∈ {mechanical, isolated-refactor} | `background` |
| AFK + Risk ∈ {cross-feature-refactor, public-API-change} | `background-heavy` |
| HITL needing in-chat co-piloting | `foreground` |
| Cannot be delegated at all (pure user judgment) | `HITL-required` |

If a slice is HITL and the mode is unsignalled, prompt: `foreground` (you co-pilot in chat) vs `HITL-required` (no Worker grabs it until you act — but it is still an eligible, human-gated wave row that `wave-plan` surfaces, *not* a placeholder removed from the wave).

**Files** (required) — globs/paths the slice touches, annotation-free. Infer from the slice prose and the plan's affected-files; confirm the inferred list in **one** round-trip (don't ask field-by-field). Globs are fine (`src/adapters/*.ts`).

> **Bias toward *wider*.** Files feeds the conflict-map, which decides — *before* dispatch — whether slices may run in parallel. The two failures are not equally costly: **over-declaration** (a glob covers more than you touch) → a false-positive overlap → one needlessly serialized lane → merely slower; **under-declaration** (a real touched file missing) → a false-*negative* → the map says "parallel ok" and two workers stomp the same file at runtime. The runtime backstop catches that only *after* dispatch, with the parallel work already paid for. So **when unsure, widen the glob.** Aim the confirmation round-trip at *completeness* ("is any co-changed module missing?"), not just plausibility.

> **Co-located spec.** If a listed source file adds new testable behavior (new function, subcommand, exported symbol), list its co-located test in the same Files list (`foo.ts` → `foo.spec.ts`). This is what keeps the conflict-map honest and lets the AC-coverage gate pass.

**Blocked by** (required) — mirror the dependency chain from step 3. Resolved to real ids at publish time (the two-pass — see reference).

**Parent** (set it when slicing a PRD) — the source PRD's **opaque id string**, exactly as `publishDocument` / the `to-prd` handoff printed it (e.g. `"412"` on GitHub, `"<slug>#prd"` on markdown). It is **not** an `IssueRef` — `parent` references a *document's identity*, so you pass the raw id verbatim; **no `parse-ref`, no `{slug, issue}` construction** (that is only for `blockedBy`). This marks the PRD **consumed** and, on GitHub, renders the forward cross-reference for free. Set it in **both** modes — create *and* decorate (a PRD is often realized through a mix of new slices and already-filed issues you decorate). Omit it when the slices have no PRD source.

> **A PRD is never a `blockedBy` entry.** It is not a wave issue and never lands, so as a blocker it would stall the chain forever. The PRD *exists first* — but "exists first" is not "blocks". The only slice→PRD relationship is `parent`.

**Body** — each slice's body is `## What to build` (end-to-end behavior of the slice, *what* it does — not a layer-by-layer plan; avoid file paths/snippets in prose, they go stale; exception: a decision-encoding snippet from a prototype, trimmed) followed by `## Acceptance criteria` (a `- [ ]` checklist).

## 5. Publish

**create** — build one input per slice and publish **blockers first**, so dependents can name real ids. The ids are opaque: capture what `create` prints; never reconstruct one. Dependent refs are resolved by a two-pass that asks the engine to invert ids (never parse an id by hand).

**decorate** — add only the *missing* wave fields (`risk`/`worker`/`files`, plus `parent` if it is a PRD slice). **Never supply `acceptanceCriteria`** — it silently replaces the human-authored AC.

Exact commands, JSON shapes, and the two-pass steps: [reference/filing-mechanics.md](reference/filing-mechanics.md).

## 6. Self-check

Run `dor` on each published issue: its **self-content gates** (header-parseable, risk-file-count, AC-coverage) prove the slice is grabbable *now* — on every store, github included. Working-tree and cross-issue gates (e.g. `literal-files-exist`, `blocked-by-chain`) show `deferred` when run on a bare github id and are re-checked at `wave-create`; only a self-content FAIL blocks (ADR-0014). For a batch that may share files, run `conflict-map` and surface the overlap cells so the user can plan serialized lanes. Commands: [reference/filing-mechanics.md](reference/filing-mechanics.md).

## Common Mistakes

- **Horizontal slices of feature work.** "Add the schema" is a layer, not a tracer bullet — feature slices reach end-to-end. (A genuinely `mechanical`/`isolated-refactor` slice MAY be horizontal — the narrow carve-out, not a license.)
- **Parsing ids by hand.** Never split an id on `#`, derive a slug, or build an `IssueRef` shape yourself — the id is opaque; use `issue-store parse-ref`. And never derive an id from filingHint/title — capture the printed id.
- **A PRD in `blockedBy`.** The PRD is the `parent`, never a blocker — it never lands, so it would stall the chain.
- **Supplying AC on decorate.** It replaces the existing human-authored AC. Decorate only the missing wave fields (risk/worker/files, plus `parent` if a PRD slice).
- **Publishing on an unconfirmed breakdown.** Quiz and iterate first.
- **Tracker-specific assumptions.** Don't assume a particular tracker, branch ritual, or build tool — no markdown-files-as-tracker, no `git mv` to a `done/` folder, no direct-push-to-main. The store behind the CLI is config-selected; stay tracker-agnostic and reach the engine only through `{{wave-cli}}`.
- **An AC whose opening scope outreaches the declared Files.** An acceptance criterion that opens wider than the Files it's paired with makes full satisfaction structurally impossible — the Worker can never close the gap without scope-creep, so the row lands with an honest partial at best. Fix it at slicing time, not after: either qualify the AC down to the enumerated scope, or widen Files to match (the bias-toward-wider rule above applies to AC reach too — when unsure, widen). Seen live: an unqualified "no reference doc anywhere still presents the old behavior" clause reached over a Files list that named only a subset of the docs it touched; the Worker disclosed the gap via Convention 9 instead of scope-creeping, the Reviewer ticked an honest partial with precise evidence, and a one-line follow-up PR closed the cause.
