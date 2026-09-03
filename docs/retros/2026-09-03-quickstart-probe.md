# Retro — quickstart probe, 2026-09-03

A stranger's first hour with flotilla, measured end to end on a throwaway consumer repo. The README quickstart was followed verbatim: plugin install → `wave-setup` → `triage` → `to-issues` (decorate) → `wave-plan` → `wave-create` → `wave-start` → `wave-close --auto`. One issue, one docs-only row, one PR. Everything landed. This document records what it cost, where the seams showed, and what would remove the friction.

**Setting.** Consumer repo `formtrieb/flotilla-quickstart-probe` (GitHub Issues, HTTPS origin, no source code, no build gate). Plugin `flotilla@formtrieb` 2.1.0, engine `@formtrieb/flotilla-engine` 2.1.0 pinned as the repo's only devDependency. Harness: Claude Code in auto mode with the Bash sandbox on. Operator present throughout; every human decision was a single-round `AskUserQuestion`. Coordinator: `claude-fable-5-1`.

## Timeline (CEST)

| Time | Step | Outcome |
|---|---|---|
| 02:01 | plugin installed, `wave-setup` invoked | — |
| 02:03 | `npm install` of the pinned engine | 3 s, 22 packages, binary + `hooks/echo-guard.cjs` present |
| 02:05 | interview (store / eligibility / verify / credential) answered in one round | all defaults |
| 02:06 | `config validate` | exit 0, `engine.cli: ./node_modules/.bin/flotilla-engine` |
| 02:07 | `store-preflight` / `host-pr preflight` | store FAIL (13 labels missing); host PASS |
| 02:08 | `.claude/settings.json` write attempted (Write, then Edit) | both denied by the auto-mode classifier |
| 02:15 | operator applied the staged settings file via `! cp` | env block, `<VAR>_CMD`, hook all proven live in-session |
| 02:19 | operator created the 13 labels by hand; `store-preflight` re-run | exit 0 |
| 02:21 / 02:25 | scaffold committed (`c05b295`) and pushed | — |
| 02:26 | `triage 1` | `enhancement` + `ready-for-agent`, Agent Brief posted |
| 02:32 | `to-issues 1` (decorate) | header block + ACs written; `dor` PASS |
| 02:35 | `wave-plan` | one candidate, parallel-safe, ~4 agents |
| 02:37 | `wave-create #1` | spine written, `queued` claim set |
| 02:40 | `wave-start` invoked | reading phase begins |
| 02:45 | Workflow driver launched | — |
| 02:50 | Workflow complete | 4 agents, 0 errors, 280 s, 46 tool uses, 137 k subagent tokens |
| 02:52 | tuple routed, PR #2 rewritten with verdict, row `pr-created` / `in-review` | — |
| 02:56 | `wave-close --auto` invoked | — |
| 02:59 | PR #2 merged by squash (`53716df`), remote + local wave branches deleted | — |
| 03:00 | issue #1 closed `done`, 4/4 ACs ticked, spine archived | — |

**Wall clock: 59 minutes from plugin install to archive.** Rough split: setup ~25 min (including the operator's own hand steps), triage + decorate ~10, plan + create ~5, start ~15 (5 min of agents, ~10 min of Coordinator reading and composing), close ~10. The "first ten minutes" the README aims at were an hour, and most of the difference was Coordinator reading, not work.

## Findings

Each finding: what happened, the evidence, the consequence, a suggestion. Ids are local to this retro (`QP-F<n>`).

### QP-F1 — `ready-for-agent` is set before the issue is wave-readable (the triage → to-issues seam)

**What happened.** `triage` moved #1 to `ready-for-agent` and posted an Agent Brief with four acceptance criteria as a comment. Immediately after, the wave-side read of the same issue failed:

```
$ flotilla-engine issue-store read 1 --config wave.config.json
error: GitHub body missing required `## Files` section
```

Only after `to-issues` (decorate mode) wrote the header block (`risk`, `worker`, `files`, `acceptanceCriteria`) did `issue-store read` and `dor` succeed.

**Evidence.** The error above, at 02:26. `dor --id 1` PASS only at 02:33, after `annotate`.

**Consequence.** The eligibility label promises "an agent can grab this" while the wave side cannot even parse the issue. Had the operator gone straight from `triage` to `wave-plan` — which is what the README's step 3 "or" reads like — `listOpen` would have hit an unreadable eligible issue. Two vocabularies (the triage terminal state and the wave header block) both claim readiness, and neither checks the other. Nothing in the flow tells a first-time operator that `ready-for-agent` is a two-skill state.

**Suggestion (any one of these closes it).**
1. `triage` writes the acceptance criteria into the issue body as the `## Acceptance criteria` section (through the same `annotate` verb `to-issues` uses) when it applies `ready-for-agent`. The comment stays the human-readable brief; the body becomes the machine source.
2. Or invert it: `ready-for-agent` may only be applied when `dor` already passes on the issue, so "ready" is one concept with one gate. `to-issues` then stamps eligibility as the last step of decoration.
3. At minimum: `to-issues` decorate lifts the ACs out of the triage brief into the body instead of forbidding `acceptanceCriteria` on decorate.

### QP-F2 — the acceptance criteria are authored twice, and the decorate rule fights the previous skill

**What happened.** The four ACs were written by `triage` into the brief comment, then again by `to-issues` into the body. `to-issues`' SKILL.md says "Never supply `acceptanceCriteria`" on decorate because it "silently replaces the human-authored AC" — but there was no human-authored AC section; the triaged issue's body had none. The Coordinator had to consciously override the rule and surface the choice to the operator as a question.

**Evidence.** The `annotate` patch at 02:32 carried the four ACs verbatim from the brief; `to-issues`' own reference names this path as the "bare-to-decorated" exception, but the SKILL body's Common Mistakes lists it as a mistake without qualification.

**Consequence.** A rule that must be broken on the ordinary path (triaged → decorated) trains agents to break rules. Duplication also means two copies that can drift.

**Suggestion.** Make the decorate rule conditional in the SKILL body: "never replace an existing `## Acceptance criteria` section; if the body has none and the triage brief has ACs, lift them." Or fix QP-F1 upstream so decorate never needs to touch ACs.

### QP-F3 — README step 3 reads as "either/or"; the path is "both, in order"

**What happened.** README: "`triage` works an existing issue into shape, **or** `to-issues` slices a plan/PRD into ready issues". For an existing issue both are required, sequentially. `wave-plan`'s own hand-off text ("use `triage` or `to-issues`") repeats the ambiguity.

**Suggestion.** "For an existing issue: `triage`, then `to-issues` (decorate). For a plan or PRD: `to-issues` alone." One sentence.

### QP-F4 — the Coordinator's reading load before a one-line dispatch

**What happened.** `wave-start` instructs the Coordinator to read `wave-shared/SKILL.md`, every file under `wave-shared/reference/`, `workflow-driver.md`, and `start-mechanics.md` before dispatching. Measured sizes:

| Read for | Bytes |
|---|---|
| `wave-setup` (SKILL + setup-mechanics) | 177 KB |
| `wave-start`: `wave-shared/SKILL.md` | 26 KB |
| `wave-start`: 16 convention files + routing-mechanics | 183 KB |
| `wave-start`: `workflow-driver.md` | 133 KB |
| `wave-start`: `start-mechanics.md` | 81 KB |
| `wave-close` (9 phase/mechanics files) | 153 KB |

`wave-start` alone is ~425 KB, on the order of 110 k tokens, before the first agent runs — for a change that touched one line of a changelog. Three convention files (13: 47 KB, 8: 30 KB, 12: 28 KB) are mostly live-occurrence catalogues, and the loader contract ("load every file under `reference/`, not a subset") makes them unskippable even though Convention 14 already says evidence belongs in provenance positions and the `evidence/` split exists.

**Consequence.** The per-wave fixed cost is dominated by reading, not by agents. On this run the four agents used 137 k tokens; the Coordinator's pre-dispatch reading was of the same order again.

**Suggestion.** Split each convention into a short *rule* file (loaded every wave) and its *catalogue/evidence* file (read on demand, cited by pointer), and let the loader contract name the rule set only. The driver and mechanics docs would shrink the same way once QP-F5 lands.

### QP-F5 — the Workflow driver is hand-transcribed from a 133 KB markdown document, every wave

**What happened.** The dispatch script (~400 lines of JS: two schemas, three brief-composing functions, the Scribe stage, the pipeline) is extracted by the Coordinator from the `## The script` fence of `workflow-driver.md`, with row data and five constants filled in by hand. The document itself carries a "compose-fresh-or-verify" rule and a seeded currency checklist that exist because this transcription has drifted before.

It drifted again here, on the first installed-form run: the driver's Stage 3 calls `agentType: 'wave-reviewer'`, but the installed plugin registers the agent as `flotilla:wave-reviewer`. The Coordinator noticed from the harness's agent listing and substituted the namespaced name; a Coordinator that pasted verbatim would have had the Reviewer dispatch fail to resolve. Captured in the archived spine as disclosure `wave.1`.

**Suggestion.** Ship the driver as a file in the engine package and add a verb that composes it: `flotilla-engine compose-driver --spine <spine> --config <cfg> --out <path>` reads the roster, `issue-store read`/`triage-read` for each dispatchable row, the worktree-brief inputs recorded at setup, and emits the finished script (the Workflow tool already accepts a `scriptPath`). That removes hand transcription, the currency checklist, the anyOf pitfall, the `agentType` namespacing question, and lets the `REQUIRED_ROW_FIELDS` assertion move into the engine where it is testable.

### QP-F6 — the post-return routing is ten shell calls with hand-written guards

**What happened.** After the Workflow returned, landing the one tuple took: sidecar existence check, disclosure capture, `route-outcome`, `route-verdict`, `render-verdict` + `host-pr create` in one guarded call, `host-pr status` + `spine set-row-state` + `spine set-row-pr` + `issue-store transition` in a second guarded call, then read-backs. The mechanics doc explains at length why each capture must be guarded in the same Bash call (five live shell-variable incidents). It worked, but the Coordinator is re-implementing a state machine in bash each wave.

**Suggestion.** One engine verb, `route-tuple --spine <spine> --id <id> --iter <n> --report <json> --verdict <json> --anchor <sha> [--title …]`, that performs the whole WAL sequence (sidecar check, routing, render, create-or-reuse, status re-query, spine writes, rung transition) and prints one JSON result. The shell disappears, and with it the class of failures the doc warns about.

### QP-F7 — `wave-setup` cannot write its own settings scaffold under the auto-mode classifier

**What happened.** Both the `Write` and the `Edit` tool on `.claude/settings.json` were refused:

```
Permission for this action was denied by the Claude Code auto mode classifier. Reason: Blocked by classifier.
```

The Bash sandbox also lists that path (and `.claude/hooks/`) as write-denied. The Coordinator staged the file in its scratchpad and handed the operator one line to run: `! cp <scratch>/settings.json .claude/settings.json`. That worked, and the file's effect was then provable in-session (env block set, `credential-probe --all` resolved, Echo-Guard hook fired on a negative control).

**Consequence.** The skill's Procedure step 9 ("write/extend the tracked `.claude/settings.json`") is not executable by the agent on a default harness. The `.claude/hooks/echo-guard.cjs` copy needed the sandbox disabled for one `cp`.

**Suggestion.** Make the staged-file + `! cp` hand-off the documented primary path in `wave-setup` (it already is for flotilla's own repo per Convention 8's "operator-applied" note), rather than something the Coordinator discovers after two refusals. Print the exact `! cp` line and the `/hooks` reload hint.

### QP-F8 — the 13 wave labels have no creation path

**What happened.** `store-preflight` failed with:

```
state-catalog: fail — the following are missing from the repository and must be created before running a wave:
"ready-for-agent", "risk/mechanical", "risk/isolated-refactor", "risk/cross-feature-refactor",
"risk/public-API-change", "worker/background", "worker/background-heavy", "worker/foreground",
"worker/HITL-required", "wave/in-review", "wave/in-flight", "wave/queued", "wave/needs-attention"
```

The engine has no verb to create them (`issue-store` ops: create/read/parse-ref/annotate/amend/transition/unclaim/flag/…, none for labels), and neither `wave-setup` nor `docs/ONBOARDING.md` names a step. The Coordinator handed the operator a `gh label create` loop; that in turn needed `gh auth refresh` first, because `gh`'s keyring token was invalid (a separate credential from the wave token — documented, but a second thing to fix in the same minute).

**Suggestion.** `store-preflight --fix` (or `issue-store ensure-labels`) that creates the missing catalogue through the engine's own credential — the token already has `Issues: write`. Failing that, the `gh label create` loop belongs in `wave-setup`'s checklist verbatim.

### QP-F9 — `dor`'s verify-coverage wording conflates "no config" with "no verify block"

**What happened.** With `--config wave.config.json` passed and the file carrying no `verify` key:

```
⊘ deferred verify-profile-coverage — No verify config supplied to this check — pass the consumer wave.config.json `verify` profiles to enable Gate 8.
```

The reference doc distinguishes "genuinely absent" (no `--config`) from "resolvable" (config loaded, profiles weighed); this output claims the former in the latter situation. Captured as disclosure `wave.2`.

**Suggestion.** When `--config` loaded and `verify` is absent, say so: "config loaded; no `verify` block — nothing to weigh; row is inspection-only."

### QP-F10 — the harness worktree directory is not in the scaffolded `.gitignore`

**What happened.** During the wave, `git status` in the primary checkout showed `?? .claude/worktrees/` — the harness's worktree location for the isolated Worker. The `wave-setup` `.gitignore` scaffold adds only `.flotilla/tmp/` (deliberately "the only flotilla-owned entry"). A consumer running `git add .claude` mid-wave, or `git add -A`, would stage a live worktree.

**Suggestion.** Add `.claude/worktrees/` to the scaffold, or name it in the setup checklist as harness-owned residue to ignore.

### QP-F11 — the archived spine still reads `Status: ready`

**What happened.** `wave-start` flipped `draft → ready` (as documented). `wave-close` never flipped it further, although `SPINE_STATUSES` includes `closed`. The archived file under `_archive/` opens with `**Status:** ready`.

**Suggestion.** `wave-close` phase 6 runs `spine set-status <spine> closed` before the move.

### QP-F12 — two credentials, one confusing minute

**What happened.** `gh auth status` reported "The token in keyring is invalid" while the engine's `GITHUB_TOKEN_CMD` lookup resolved fine. `wave-setup` documents this precisely, and the Coordinator reported both separately. It still cost the operator a `gh auth refresh` at the moment the labels had to be created (QP-F8). Removing the `gh` dependency for labels removes the confusion.

### QP-F13 — small observations, no action strictly required

- `git push` under the sandbox prints `failed to store: 100001` (the osxkeychain credential helper cannot write back). Harmless; the push succeeds. Worth one line in setup so nobody chases it.
- The Echo-Guard blocked the Coordinator's own probe once during setup for a `${VAR:-fallback}`-shaped expansion on a non-secret variable. Correct by design (family 2 denies the form, not the name), and the teaching message was good. Counted as 1 of 3 setup-time misfires; 0 during the wave itself.
- The wave-scoped disclosures (`--wave`) were the right home for QP-F5 and QP-F9. The only disposition that fit an upstream finding on a consumer repo was `dropped:<reason>`; a fifth value like `upstream:<ref>` would read more honestly for consumers that are not flotilla itself.
- The Scribe stages ran clean on `haiku` — no classifier block this time — and `write-report`/`write-verdict` both validated; the `n = 1` inline-Scribe path was never needed.
- `host-pr arm` on a clean PR with no required checks returned `outcome: merged` with a clear `reason` and `branchDeletion.deleted: true`. The reason text is exactly what an operator needs.

## What worked without friction

- Zero permission prompts across 4 agents and 46 tool uses. The scaffolded allowlist (`npm ci`, the engine binary, the `wave/`-scoped push, the worktree/merge-tree entries) covered everything the Worker and Reviewer ran.
- The spine-first ordering held at every write; every step was re-runnable and every read-back matched the write.
- The credential indirection worked end to end: the token never appeared in any output, and `credential-probe --all` proved resolution before dispatch.
- The Reviewer's verdict rendered into the PR body is the right artifact for the human at the merge button.
- The Worker honoured the declared Files scope, disclosed its one judgment call, and the Reviewer independently re-verified every AC against the anchor with commands in the evidence column.
- `wave-close --auto` with a one-line confirm, then merge, pull, reconcile, archive — fully mechanical once the operator clicked.

## Prioritised suggestions

1. **Close the triage → to-issues seam** (QP-F1, F2, F3): one readiness concept, ACs written once, README step 3 reworded.
2. **Ship the driver and the routing as engine verbs** (QP-F5, F6): `compose-driver` and `route-tuple` remove hand transcription and hand-written shell guards, and take the `agentType` and anyOf hazards out of the Coordinator's hands.
3. **Cut the per-wave reading** (QP-F4): rule/evidence split per convention; the loader loads rules only.
4. **Make setup self-sufficient on a default harness** (QP-F7, F8, F10): staged settings + `! cp` as the documented path, a label-bootstrap verb, `.claude/worktrees/` in the ignore scaffold.
5. **Small correctness fixes** (QP-F9, F11): `dor` wording, `closed` status at archive.

## Measured numbers

| Metric | Value |
|---|---|
| wall clock, install → archive | 59 min |
| agents dispatched | 4 (worker, scribe, reviewer, scribe) |
| agent wall clock | 280 s |
| agent tool uses | 46 |
| subagent tokens | 137 199 |
| Coordinator reading before `wave-start` dispatch | ~425 KB |
| Coordinator reading for `wave-close` | ~153 KB |
| permission prompts during the wave | 0 |
| Coordinator misfires during the wave (exit 2 / hook blocks) | 0 |
| Coordinator misfires during setup, before the wave existed | 3 (1 Echo-Guard block, 2 classifier denials on `.claude/settings.json`) |
| operator hand steps | 3 (`! cp` settings, `gh auth refresh` + 13 labels, the `--auto` confirm) |
| disclosures captured | 3 (1 row-scoped `resolved-in-slice`, 2 wave-scoped `dropped:` upstream findings) |

## Where each finding went

Filed upstream on 2026-09-03 from wave `2026-09-02-public-step-b`, row 647 (the quickstart validation, PR formtrieb/flotilla#678 — its README, ONBOARDING and `wave-setup` corrections plus the throwaway-consumer scaffold and the measured table):

| Finding | Went to |
|---|---|
| QP-F1, QP-F2 | #679 — one readiness concept, ACs written once |
| QP-F3 | row 647: README step 3 reworded; the underlying seam is #679 |
| QP-F4 | the private planning ticket on the plugin-clone surface, with these numbers as its measurement |
| QP-F5 | #680 — the driver ships in the engine, `compose-driver`; the agent-name gap itself is #677 |
| QP-F6 | #681 — `route-tuple` |
| QP-F7 | row 647: the staged-file + `! cp` hand-off is the documented path (README step 2, ONBOARDING, `wave-setup` step 9 and its scaffold reference) |
| QP-F8 | row 647 documents the label set and the hand-off; #675 asks for the engine verb |
| QP-F9 | #676 |
| QP-F10 | row 647: `.claude/worktrees/` joins the consumer `.gitignore` scaffold |
| QP-F11 | #682 |
| QP-F12 | documented already; removing the `gh` dependency for labels is #675 |
| QP-F13 | the `upstream:<ref>` disposition is #683; the `failed to store` line and the Echo-Guard block need no action |
| after the retro | #684 — the Operator-ruled Reviewer-only round after the cap has no routing cell; surfaced while landing row 647 itself |

## Provenance

Consumer session of 2026-09-03, 02:01–03:16 CEST, on the throwaway repository. Wave `2026-09-03-changelog-seed`, archived at `.flotilla/waves/_archive/2026-09-03-changelog-seed.md` (untracked in this repo). PR `formtrieb/flotilla-quickstart-probe#2`, merge commit `53716df`. Plugin and engine 2.1.0. Written by the Coordinator at the operator's request; the operator's own observation that opened this retro was the gap between `triage`, `to-issues` and `wave-plan`.
