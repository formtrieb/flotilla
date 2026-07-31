## Convention 15 — issue-closing work never lands without a Reviewer verdict

**The prohibition comes first, and it is stated as a prohibition on purpose: a reader who takes in only the first half must come away with the safe half.**

> **No pull request that closes a tracker issue lands without a Reviewer verdict.** Not for a doc-only diff. Not for a one-line skill edit. Not for a bundle of mechanical follow-ups. Not because the Coordinator wrote the change itself and is sure of it.

There is exactly one exception, and it is narrow: **a session-authored orchestration artifact that closes no tracker issue may land Coordinator-direct** — a retro, an ADR, a glossary or CHARTER update, config housekeeping. Nothing else.

### The test is binary, and it is about provenance — never about file class

Ask one question of the PR in front of you:

> **Does this PR close a tracker issue?**

- **Yes** → it lands through a wave row **with a Reviewer verdict**. No exceptions by file type, diff size, or confidence.
- **No** → Coordinator-direct is permitted, provided the content is the running session's own judgment output.

The boundary is deliberately drawn on **provenance**, not on what the diff touches. Two reasons, and both are load-bearing:

1. **The verdict is the acceptance-criteria ground truth** (ADR-0004). A direct lane for issue-closing work would create the first class of issue with no ground truth at all — an AC ticked by the same session that wrote the change.
2. **"Doc-only" erodes the moment it is written down.** It starts at *it's just a one-liner in a skill…* and ends wherever the day is longest. And for a doc-only change **CI is no content check whatsoever** — the engine test and typecheck gates pass trivially on prose — so the Reviewer is the *only* verification such a PR ever receives. The class that looks safest to wave through is the class with the least other cover.

A session-authored orchestration artifact is exempt for a reason that does not generalize: **there is nothing for a Reviewer to re-derive.** Its content *is* the session's judgment, produced with the human in the loop; it closes no issue and ticks no acceptance criterion. The moment such a document also closes a ticket, the exemption is gone.

### The cheap lane is a foreground row WITH a Reviewer — never a review waiver

When a row is genuinely mechanical — a thematic disclosure bundle is the standard case (ADR-0027 Amendment 2026-07-31) — the cost is cut on the **Worker** side, never on the verdict:

- The **Coordinator implements the change itself** in a `foreground` row (the ADR-0012 Worker vocabulary). Worker dispatch cost drops to zero.
- A **Reviewer is dispatched anyway** — at standard model tier for a `mechanical` row (ADR-0007 Amendment 2026-07-31), so the verdict now costs the cheap-model price.
- Every pipeline invariant stays intact and most of the saving is realized.

Dispatching a full background Worker for a bundle row is permitted and never wrong — it is merely wasteful. Skipping the Reviewer is neither.

### Reading the rule tracker-agnostically

"Closes a tracker issue" reads identically on every shipped store, so this convention needs no per-adapter wording: the store-kind close phrase (Convention 4) is what makes a PR issue-closing — `Closes #N` on `github`, `Fixes <TEAM-NN>` on `linear`, the equivalent on `MarkdownFs`. If you are composing that phrase into a PR body, you are in the reviewed lane by definition.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader reads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so a `Convention 15` citation resolves for every back-half skill with zero loader edits (ADR-0028).
- **`wave-shared/SKILL.md`** — the number-allocation register's counter and its one-liner, so a reader who never opens `reference/` still meets the rule.
- **No engine, schema, or spine surface.** The rule is a Coordinator-side discipline; there is no verb to call and no gate to pass. It travels to consumers as plugin text.

### Common Mistakes

- **Reading the exception first and the prohibition second.** The permitted list is short *because* the prohibition is the rule. If you find yourself assembling an argument for why this particular diff fits the exception, the argument itself is the signal: check whether the PR body carries a close phrase, and stop there.
- **Treating "mechanical" or "doc-only" as a review waiver.** Risk class picks the Reviewer's model tier; it never decides *whether* a Reviewer runs (ADR-0007 Amendment 2026-07-31). Universal dispatch is the invariant.
- **Landing a thematic bundle Coordinator-direct because the Coordinator wrote it.** Authorship is not provenance. The bundle closes a ticket, so it takes a verdict — implement it foreground if the cost is the concern.
- **Dispatching a background Worker for a bundle row "because the pipeline says so".** The pipeline requires the *verdict*, not the Worker. A foreground row with a Reviewer is the intended cheap lane.
- **Adding a close phrase to a retro or ADR PR "so the tracker stays tidy".** That single line moves the PR across the boundary and into the reviewed lane. If the artifact really should close a ticket, file it as a row.

### Provenance

- **[ADR-0033](../../../../docs/adr/0033-issue-closing-work-lands-only-through-a-reviewed-wave-row.md)** — the decision this convention carries, including the rejected option (a Coordinator-direct lane for mechanical doc-only bundles) and the reason the fail-closed phrasing was chosen over a permission list: `docs/adr/0033-issue-closing-work-lands-only-through-a-reviewed-wave-row.md`.
- **Formalized an existing unregulated practice.** The Coordinator had been landing retro and ADR PRs directly with no Worker and no Reviewer while every wave row ran the full pipeline. The obvious extension — letting mechanical doc-only bundles ride the same lane once thematic bundles became first-class (ADR-0027 Amendment 2026-07-31) — was rejected, and the existing practice was formalized on the provenance axis instead. ADR-0033 itself landed Coordinator-direct, which is exactly what this convention licenses: it closes no issue.
