---
name: wave-setup
description: Use when setting up flotilla in a new consumer repo — author the `wave.config.json` (store selection + eligibility set + optional verify profile) the other wave skills read. Triggers on "set up flotilla", "configure the wave store", "init wave config", "initialize flotilla for this repo".
---

# wave-setup

Bootstrap flotilla for a consumer repo by producing the `wave.config.json` that every other wave skill reads. This is a one-time setup per consumer repo (re-run to change the store, eligibility set, or verify profile). Everything goes through the engine — the skill writes the local config file, proves it loads via `config validate`, then **runs the store-preflight** (`cli-store preflight`) to confirm the live store preconditions actually hold before any wave is planned.

Your job is the **judgment** — interviewing the three config concerns (store, eligibility, verify), composing the right JSON, and knowing which options apply to the consumer's situation. The CLI plumbing (the `config validate` / `cli-store preflight` commands, the exact JSON shapes, the worked examples) lives in [reference/setup-mechanics.md](reference/setup-mechanics.md) — reach for it once you know what to write. You write the file directly (it is local config, not a tracker artifact), then round-trip through the engine to confirm it loads cleanly and that its store preconditions hold.

## When to Use

- Setting up flotilla in a new consumer repo for the first time.
- Changing the store kind, eligibility set, or verify profile in an existing consumer repo.
- Confirming a hand-edited `wave.config.json` is valid before running `wave-plan` or `wave-create`.

Do **not** use this for per-wave work — `wave-plan` (breakdown), `wave-create` (spine + worktrees), and `wave-start` (dispatch) are the downstream wave skills. `wave-setup` is the one-time bootstrap; the wave skills are the per-batch operators.

## What the config holds

The config has three concerns. Interview them one round-trip each — don't ask field-by-field.

### 1. Store

Which issue store does this consumer use?

- **`github`** — the M1 target and the right default for any repo that uses GitHub Issues. No `repo` field: the `gh` ambient context (the current working directory's tracked remote) supplies the repo. Carries only `eligibility?`.
- **`linear`** — for consumers whose issue tracker is Linear (ADR-0020). Note what does **not** change: the PR itself is still a GitHub artifact in both known consumers — Linear is the issue tracker, not the code host. Requires `team` (the Linear team key or display name — owns the workflow-state catalog and the label namespace; use the exact key as Linear displays it, e.g. identifiers read `EX-16` → key `EX` — the lookup is case-sensitive). Carries optional `project` (scopes `listOpen` to one project; omit for a whole-team draw — omitting it also disables PRD publishing, since `to-prd`/`publishDocument` refuses to mint an orphan Document without a bound project), `eligibility?`, `states?` (claim-rung → workflow-state-name overrides; default `{"queued": "Todo", "inFlight": "In Progress", "inReview": "In Review"}`), and `categoryLabels?` (triage-category → existing label name, e.g. `{"bug": "Bug", "enhancement": "Improvement"}`).
- **`markdown`** — for dev/dogfood on a local filesystem. Requires `repoRoot` (absolute path) and `slug` (a kebab-key identifying the issue set, e.g. `2026-06-18-my-wave`). Carries `eligibility?`.

If the consumer is on GitHub Issues, start with `github`. Reach for `linear` when the consumer's issue tracker is Linear. Reach for `markdown` only when there is no GitHub repo or when the user is working in an isolated local context.

#### Linear operational preconditions

A misconfigured `linear` store fails quietly — the claim ledger or the closing probe silently drifts rather than erroring loudly (design spec §Operational preconditions, ADR-0020). Two of these are now **probed for real** by the store-preflight (Procedure step 5) — do not just assert them; the rest are team conventions the engine cannot see, so walk through them with the consumer **before** writing the config.

**Probed by `cli-store preflight` (step 5) — the checklist RUNS these, it does not merely assert them:**

1. **Linear's GitHub integration is installed** and connected to the code repo. Without it, a merged PR never creates the attachment `readClosing` reads, so a `linear` wave's rows never resolve to `done`. (If the consumer deliberately runs integration-less, the opt-in `states.doneState` fallback covers it — the preflight then reports this `not-applicable` rather than failing.)
2. **The team's workflow-state catalog covers every configured claim state** — `Todo` / `In Progress` / `In Review` plus the `Backlog` / `Canceled` targets, plus `doneState` if you set one. A fresh workspace missing e.g. `In Review` would otherwise throw on the first `setState` mid-wave; the preflight surfaces the exact missing state at setup.

**Confirm with the consumer — not engine-checkable:**

3. **Wave PRs carry the tracker's magic-word close phrase** in the PR body — for `linear` that is `Fixes <TEAM-NN>` (e.g. `Fixes EX-16`), not GitHub's `Closes #N`. This is the store-kind close-phrase convention (`wave-shared`); it both closes the issue and creates the merged-PR attachment.
4. **PR-route discipline**: wave branches land via PRs against a protected `main`. A fast-forward-only merge mode (no PR, no merge commit) never produces the closing attachment the probe needs.
5. **Team convention**: humans park new/backlog work in `Backlog`; `Todo` means wave-claimed. This is an accepted human-drag hazard (the spine/WAL reconciles the drift, ADR-0002) — make sure the consumer's team knows the convention before turning the wave loop on.

Run the preflight (step 5) to prove 1–2 for real, and confirm 3–5 by hand — a `config validate` PASS only proves the JSON is well-formed, and the preflight cannot see the human conventions.

#### Operational preconditions (all stores)

Two preconditions apply regardless of store kind:

- **The ambient PR-merge token** (`github` store): the store-preflight probes whether the `GITHUB_TOKEN` can merge PRs on the bound repo — a token that can read issues but not land PRs fails the preflight loudly at setup rather than at merge time. (For a `linear` store the PR still merges on GitHub with the consumer's own credentials — the preflight reports this `not-applicable` because the Linear tracker cannot see the code-host token.)
- **AFK permission posture** (not engine-checkable — confirm with the consumer). A wave runs unattended: `wave-start` fans out Workers and Reviewers that execute **without a human at the keyboard**, so every command they run passes through the harness permission gate. If the wave commands are not on the consumer's allowlist, the agents will stall on a permission prompt no one answers. Confirm the consumer's harness config permits — headless — the wave's command surface: **worktree ops** (`git worktree add/remove`, `git fetch/reset/checkout/commit/push` on the wave branch), the **verify commands** for their build gate (the `verify` profile commands, e.g. `composer install` / `vendor/bin/phpunit`), and the **engine CLI** (`npx tsx tools/wave/src/*.ts …`). This is a checklist item, not something the engine can verify — the harness owns the gate, not flotilla.
- **Worktree-brief inputs** (not engine-checkable — confirm with the consumer, FOR-32/W4-F4). `wave-start` dispatches Workers and Reviewers into `isolation: 'worktree'` — a fresh checkout of **tracked files only**; anything gitignored is simply absent there. Two consumer answers decide what the Coordinator must fill into every dispatch brief, so ask them now rather than re-deriving them at the first wave's fan-out:
  1. **Is the dependency directory gitignored?** (the ordinary case for a lockfile-managed tree — e.g. `node_modules`, `vendor`). If yes, record the exact install command(s) the Coordinator embeds as that row's dependency-install step (`workflow-driver.md`'s `depsSetup`) — without it, a fresh worktree has no dependencies and the verify gate cannot run at all, for the Worker or the Reviewer. If nothing is gitignored here, record that explicitly (no install step needed).
  2. **Is the store config (this `wave.config.json`) gitignored?** If yes, a Worker/Reviewer standing inside its own worktree cannot resolve a tracker id against a store it has no config for — record that the Coordinator must embed the **full issue spec** (title, body, acceptance criteria, declared Files globs, risk) into each brief (`issueSpec`) rather than pass a bare tracker reference.

  Record both answers alongside the config (e.g. in the setup report handed to the Coordinator) — they are Coordinator-composition inputs, not `WaveConfig` fields; the engine has no verb to check them.

### 2. Eligibility (the Eligibility OR-set)

The set of issue-side triage states that make an issue wave-grabbable. `wave-plan` includes an issue if it carries **any** state in this set (OR semantics). Default: `["ready-for-agent"]`.

This is the **only** coupling between the triage pipeline and the wave pipeline: `triage` flips an issue into a state in this set; `wave-plan` picks it up from there. The value names come from the consumer's triage schema — never hardcode a native tracker label.

For most consumers, the default is correct. Ask only when the consumer's triage vocabulary differs — e.g. they use a differently-named ready label (`["agent-ready"]`) or genuinely have **more than one** wave-eligible state (the OR-set then lists all of them).

> **Never add `ready-for-human` to the eligibility set.** `ready-for-human` is triage's *not-wave-work* terminal — work a human does entirely outside flotilla, which never enters a wave (ADR-0015). Human-gated *wave* work is a different thing: a `ready-for-agent` issue whose **Worker** is `HITL-required`. Such issues are already grabbable under the default `["ready-for-agent"]` eligibility, and `wave-plan` surfaces them flagged human-gated. Adding `ready-for-human` would wrongly pull non-wave work into the roster.

### 3. Verify (optional)

A `VerifyConfig` of build/test profiles that the engine runs against an agent's changed files before a PR is opened. Each profile declares which file globs it applies to and the commands to run.

**There is no `DEFAULT_VERIFY`.** Verify is purely consumer configuration — omit it entirely if the consumer has no build gate. Do not invent a default or guess at a standard command; ask the consumer what their build/test setup is.

A real consumer's CMS profile (`cms/**` → `composer install` + `vendor/bin/phpunit`) is an example of what a real consumer provides — it is that consumer's own content, not a flotilla default. Do not import it into other consumer configs.

## Procedure

1. **Interview the three concerns.** One round-trip per concern (store kind → eligibility → verify). For store: ask which tracker the consumer uses; if it's Linear, also gather the team, the optional project, and whether the default workflow-state names or category-label names need overriding (`states`/`categoryLabels`), and walk through the Linear operational preconditions above. For eligibility: confirm the default is right or gather the custom set. For verify: ask whether they have a build gate and, if yes, what files it applies to and what commands to run. Don't ask field-by-field — one structured question per concern.

2. **Compose the JSON.** From the answers, assemble the `WaveConfig`. The exact shapes are in [reference/setup-mechanics.md](reference/setup-mechanics.md).

3. **Write the file.** Default path: `wave.config.json` at the consumer repo's root. The consumer commits it alongside their codebase.

   > **In the flotilla toolkit repo itself, no config is committed.** flotilla is the toolkit, not a consumer — it has no wave store of its own. Dogfood use (`wave-plan` / `wave-create` within this repo for testing) uses `--config <path>` to point at a temp config file. Never commit a `wave.config.json` to the flotilla repo root.

4. **Validate.** Run the `config validate` verb (exact command and exit codes: [reference/setup-mechanics.md](reference/setup-mechanics.md)). Exit 0 means valid. On a non-zero exit, read the reported field, fix it in the JSON, and re-run. Do not hand the config to downstream skills until it exits 0.

5. **Preflight the store.** Run the `cli-store preflight` verb (exact command, report shape, and exit codes: [reference/setup-mechanics.md](reference/setup-mechanics.md)). This goes past `config validate` — it probes the *live* store preconditions **for real** through the API seam: the tracker↔GitHub integration, the workflow-state catalog covers every configured claim state, and (github) whether the ambient token can merge PRs. Exit 0 means every check passed or is `not-applicable`. On exit 1, read the failing check's `detail` (it names the exact gap — a missing `In Review` state, a read-only token, an absent integration), fix it in Linear/GitHub or the config, and re-run. This is the step that stops asserting the machine-checkable preconditions and actually **runs** them; the non-checkable ones (magic-word phrase, PR-route discipline, team convention, AFK permission allowlist) still need the by-hand confirmation from the preconditions checklists above.

6. **Report.** Print where the file landed (absolute path), the preflight result, the two worktree-brief answers (is the dependency dir gitignored + the install command, is the store config gitignored) so the Coordinator has them ready at the first wave's dispatch, and the next step: `wave-plan` (issue breakdown + wave roster) or `wave-create` (if a breakdown is already approved).

## Common Mistakes

- **Committing a real config into the flotilla toolkit repo.** flotilla is the toolkit — it has no issue store. The `wave.config.json` belongs to the consumer repo, not here.
- **Inventing a `DEFAULT_VERIFY` or guessing a command.** Verify is purely consumer config. If the consumer has no build gate, omit `verify` entirely.
- **Hardcoding a native label instead of the canonical eligibility role.** Pass canonical role names (e.g. `"ready-for-agent"`); the adapter resolves them to the store's native representation from config.
- **Adding a `schema` or `triageSchema` override.** Vocab file-override is deferred — engine defaults only in M1. Do not invent a config field for it; the engine will reject unknown fields.
- **Skipping `config validate` or `cli-store preflight`.** Writing the file is not enough — `config validate` proves the engine can parse it, and `cli-store preflight` proves the *live* store preconditions hold (integration, state catalog, merge token). Round-trip through both before handing off to downstream skills.
- **Asserting the store preconditions instead of running the preflight.** Do not read the checklist and tell the consumer "assuming the integration is installed and the states exist." Run `cli-store preflight` — it probes them for real and names the exact gap on failure. The only preconditions you confirm by hand are the ones the engine genuinely cannot see (magic-word phrase, PR-route discipline, team convention, AFK permission allowlist).
- **Setting a `repo` field on a `github` store config.** The `gh` ambient context supplies the repo; there is no `repo` field on `GitHubStoreConfig`. Adding one will fail validation.
- **Forgetting the AFK permission allowlist.** A wave runs unattended — Workers/Reviewers pass every command through the harness permission gate. If the wave's command surface (worktree ops, verify commands, engine CLI) is not allowlisted, the agents stall on prompts no one answers. This is not engine-checkable; confirm it with the consumer at setup.
- **Skipping the worktree-brief questions.** A worktree checkout carries tracked files only — if the dependency dir or the store config is gitignored, the Coordinator needs that answer *before* composing the first wave's dispatch briefs, not after a Worker fails on a missing dependency or a Reviewer can't resolve a bare tracker id. Ask and record both at setup (FOR-32/W4-F4).
- **Skipping the human-confirmed Linear preconditions.** The preflight covers the integration and the state catalog, but it cannot see whether PRs carry `Fixes <TEAM-NN>`, whether the repo is on the PR route, or whether the team parks work in `Backlog`. Walk through those three by hand before handing a `linear` config to `wave-plan`/`wave-create`.
- **Treating Linear as the code host.** A `linear` store config does not change where PRs live — they are still GitHub PRs. `team`/`project` identify the Linear issue tracker only.
