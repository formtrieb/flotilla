---
name: wave-reviewer
description: Use to understand or operate the Wave Reviewer — the read-only pre-PR quality-gate dispatched per row by wave-start. Universal dispatch (every row, Risk does NOT gate), re-runs verify + floor checks against the wave-anchor SHA, returns a schema-validated ReviewerVerdict. Triggers on "review this wave row", "what does the wave-reviewer check", "run the reviewer on <branch>".
---

# wave-reviewer

The Wave Reviewer is the **agent** (`.claude/agents/wave-reviewer.md`) `wave-start` dispatches between every Worker-finish and PR-open. This skill is the operator's view of it: when it runs, what a sound verdict rests on, and the boundary it must not cross. The check mechanics live in [reference/reviewer-checks.md](reference/reviewer-checks.md); the schema-validated return contract is the agent definition itself.

## When it runs

- Automatically, per row, inside the `wave-start` Workflow script (`agent({ agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_SCHEMA })`).
- **Universal dispatch** — every row, regardless of Risk. Risk is reported (and routed on downstream), never a gate on whether the Reviewer runs (ADR-0016: the reviewer is uniform — there is no per-Risk brief profile, unlike the Ur).
- You rarely invoke it by hand. Reach for this skill to understand a verdict, or to run the same checks manually on a stuck branch.

## What a sound verdict rests on

- **Re-verification, not re-reading.** Worker-report drift is the #1 failure mode. Every "green/met/clean" claim comes from a command run in this dispatch.
- **The wave-anchor SHA as the diff base — never `main`.** Diffing against `main` surfaces the whole feature delta and hides the Worker's actual change. The anchor SHA is the wave's base; the Worker `git reset --hard`-ed to it.
- **Evidence per AC.** Every AC gets `met | partial | not-met | deferred` with a `file:line` / `commit-sha` / "deferred per marker" — and an outcome-phrased AC needs outcome-*exercising* evidence to earn `met` (see below).
- **The schema boundary.** The verdict is validated against `REVIEWER_VERDICT_JSON_SCHEMA` before the Coordinator routes it — `riskClass` is always present (the G3 guard), `briefProfile` is gone (the reviewer is uniform), and no un-modelled field survives.

## The outcome-evidence bar ([ADR-0004 Amendment 2026-07-28](../../../docs/adr/0004-ac-ground-truth-is-the-reviewer-verdict.md))

- **An AC phrased as an outcome earns `met` only on evidence that exercises the outcome** — a slice test, or the Reviewer's own probe, that *performs* the thing and asserts the result. Evidence confined to the layer the diff touched — however precise, however exact the `file:line` — caps at `partial`, with the unexercised outcome named in `evidence`. Live occurrence: #142 AC1 read *"a worktree … is removable"*; the Reviewer verified, correctly, that `planCleanup` *selects* the worktree and marked `met`; nothing ever removed one; the missing `--force` sat in the unexercised half and failed at the live gate minutes after merge.
- **The Reviewer holds a probe license.** It stays code-read-only — it never edits the diff, the branch, or the Coordinator tree — but it MAY execute temp-scoped experiments (a scratch worktree, a throwaway directory) to exercise an outcome itself when the diff alone can't prove it. Precedent: the FOR-120 Reviewer's independent control experiment. **A failing probe is `not-met`**, not a fallback to layer evidence.
- **The deferred valve.** An outcome unreachable from the review environment — merge-gated, prod-gated, human-gated — is `deferred` (or `partial` when part of the criterion is exercised), with the unexercised outcome named in `evidence` **and mirrored into `reviewerFocusItems`** — that mirror is what makes it a Disclosure ([ADR-0027](../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md)), captured at routing and dispositioned before archive. Precedent: FOR-121 AC-5's honest `deferred`.
- **No schema change.** The four-valued `met | partial | not-met | deferred` vocabulary already exists in `REVIEWER_VERDICT_JSON_SCHEMA`; this is Reviewer-contract prose only.

## The boundary

- **Read-only.** The Reviewer never edits, never merges, never pushes. It opens nothing; `wave-start`'s terminator opens the PR, and only after an `approve` routes to `pr-created`. (The probe license above runs experiments outside the Coordinator tree — it does not relax this.)
- **Sibling conflicts are advisory.** A predicted merge-tree conflict with a sibling branch is never `changes-requested` — the reviewed branch is not wrong; the Coordinator owns the merge-time decision.
- **No axe-a11y.** flotilla dropped the Ur's Angular/Storybook a11y check (provenance de-coupling).
- **verify-less configs are valid.** When `wave.config.verify` is absent, the re-run is empty (`lintTestSummary: "no verify profile"`); the absence is not a failure.

## Common Mistakes

- **Calling `met` on layer-only evidence for an outcome-phrased AC.** Confirming the diff does the right thing at the layer it touches is not confirming the outcome the AC promises — run the probe, or cap at `partial` and name what's unexercised.
- **Treating Risk as a dispatch gate.** Risk selects nothing about whether the Reviewer runs or which checks it does — the contract is uniform. It is reported as `riskClass` and routed on downstream.
- **Diffing against `main`.** Always the anchor SHA.
- **Trusting the Worker report.** Re-run every claim.
- **Promoting a sibling conflict to changes-requested.** It is always advisory.
- **Expecting a `briefProfile` field.** It was removed in P7.4 — `additionalProperties: false` rejects it now.
- **Requiring a verify profile to exist.** If `wave.config.verify` is absent, note the absence and proceed; do not STOP or treat it as a gap.

## Related

This skill is documentation-only for the Reviewer role and does not itself load `wave-shared` by name — it carries no such reference to namespace. The by-name composition finding (whether an unscoped skill load resolves under an installed plugin) lives in [`wave-shared`'s own note](../wave-shared/SKILL.md). The sibling namespacing question for *this* skill is the Reviewer's `agentType: 'wave-reviewer'` dispatch value used in the Workflow driver (`wave-start/reference/workflow-driver.md`) — already found, empirically, to require the plugin-namespaced form (`docs/retros/2026-07-27-plugin-consumer-w1.md`, finding DA-F3) — but that driver file sits outside this slice's declared Files scope.
