# wave-start — the Workflow driver

The single dispatch mechanism (ADR-0016: no dual prose-vs-driver selector, no express variant in M1). `wave-start` composes this script with the current wave's rows filled into `ISSUES`, invokes the Workflow tool, then routes the returned tuples (see [start-mechanics.md](start-mechanics.md)).

> **The CLI + the agent-tool schema are the source of truth for shapes.** The two inlined `*_SCHEMA` literals are **copies** of the exported consts in `tools/wave/src/worker-report-schema.ts` + `reviewer-verdict-schema.ts` — the Workflow script runs in a no-fs, no-import sandbox, so it cannot `import` them. The `skill-schema-drift` spec reads these literals from the **wave-shared** skill and deep-equals them against the exported engine consts — if they drift, that spec fails loud. **The canonical copies live in `wave-shared/SKILL.md`; keep these in sync with those, never hand-edit one copy in isolation.**

## Why this copy's `WORKER_REPORT_SCHEMA` drops `anyOf` — the prUrl invariant is brief-enforced here, not schema-enforced

`wave-shared`'s canonical `WORKER_REPORT_SCHEMA` literal carries a top-level `anyOf` (the `outcome: done`/`done-with-concerns` ⇒ `prUrl`-required invariant). The agent tool's `input_schema` validation **rejects a top-level `anyOf`/`oneOf`/`allOf` outright** — `input_schema does not support oneOf, allOf, or anyOf at the top level` — so the copy pasted into `agent({ schema })` below **omits it, deliberately**. This is not a drift from the canonical literal; it is the one shape difference the agent boundary forces (live-confirmed regression: **W5-F1**, `docs/retros/2026-07-19-hardening-w5.md` — the first Workflow dispatch of that wave failed instantly this way, 0 tokens, all 4 Workers, before a single agent ran, because the canonical `anyOf`-bearing literal had been pasted here verbatim).

**The `prUrl`-on-`done`/`done-with-concerns` invariant still holds on this path — it is enforced by the Worker brief, not the schema.** `workerBrief()`'s Termination step 4 ("Confirm the PR by asking the HOST") and its Report section both state the requirement in prose; there is no structural rejection at the `agent({ schema })` boundary here for a `done` report that omits `prUrl` (unlike a hypothetical boundary-portable form of the canonical `anyOf`, which would reject it structurally). `tools/wave/src/skill-schema-drift.spec.ts` asserts this literal stays free of any top-level combinator, with a negative control proving that assertion actually fires — so the W5-F1 regression cannot silently ship again.

## Harness constraint that shapes the decomposition (read first)

A Workflow `script` is plain JS with **no filesystem and no local-module import** — it cannot `import tools/wave/src/*` or read a file. Its `agent()` calls, however, are full subagents (bash, fs, all tools). So the driver splits in two:

| Sub-phase | Runs | Why |
|---|---|---|
| **Dispatch + Review + Scribe**: fan out Workers, collect schema-validated `WorkerReport`s, **persist each report sidecar (Scribe stage)**, pipeline each into a `wave-reviewer`, collect schema-validated `ReviewerVerdict`s, **persist each verdict sidecar (Scribe stage)** | **inside the Workflow script** (`pipeline()` + `agent()`) | the `agent()`-heavy parallel part; schema validation at the `agent({schema})` boundary kills the report-fabrication class. A Workflow script has no fs/shell of its own, so the sidecar write is delegated to a cheap `agent()` — the **Scribe** — that runs the paired `write-report`/`write-verdict` verb (ADR-0024) |
| **Route + mutate**: `route-outcome`/`route-verdict` → `spine set-row-state` + `issue-store transition` + the terminator (renders the verdict via `render-verdict` into the PR body it opens with `host-pr create`) | **the Coordinator, after the Workflow returns**, via `{{wave-cli}}` calls | the script can't `import` the engine; spine writes must be **sequential** on the Coordinator branch (an in-script parallel writer would race the byte-preserving spine round-trip) |

## The Scribe stages — the durable record exists the moment the work does (ADR-0024)

The single sharpest live-gate finding (retro P-1) was that sidecars — the durable record the whole resume doctrine ("disk beats a non-landed spine flip") stands on — used to be written by the Coordinator *after* the Workflow returned and routing ran. A Coordinator death mid-wave left **zero sidecars on disk** despite finished Workers with mergeable PRs. The fix moves the write to the moment the agent returns, through the engine verbs that own the format:

- **`pipeline()` gains two cheap Scribe stages**: `worker → scribe(report) → reviewer → scribe(verdict)`. Each Scribe is a small `agent()` (`model: 'haiku', effort: 'low'`) whose brief carries the **already-schema-validated** payload byte-exact (`JSON.stringify`-interpolated — the `agent({schema})` boundary validated it; nothing is re-typed from prose) plus the exact `write-report`/`write-verdict` invocation. The report is durable **before the review even starts**; each record exists seconds after its agent returns, before any Coordinator routing.
- **A Scribe failure never discards the in-band tuple.** The stage wraps its `agent()` in try/catch, **passes the report/verdict through regardless**, and `log()`s loud (`SIDECAR-WRITE FAILED <id>`). A `pipeline()` stage that *throws* drops the row to `null` — which would convert a *successful* Worker into a `worker-failed` STOP and discard finished work. Structurally forbidden here: the Scribe stage returns its passthrough value in every branch, and the Scribe itself retries the CLI call once, byte-identical.
- **`SCRIBE_RESULT_SCHEMA` is driver-local — deliberately NOT drift-pinned.** No engine const corresponds to it (unlike the two `*_SCHEMA` copies), so `skill-schema-drift.spec.ts` does not — and must not — pin it. It is a plain `{ ok, path, error?, notice? }` shape with no top-level `anyOf`/`oneOf`/`allOf` (boundary-safe, W5-F1). `notice` is the exit-0 channel: the write verb reports a normalized decorated id or misnamed litter on stderr while still succeeding, and the Scribe reports a cwd that did not match the compose-time `REPO_ROOT` on a write that succeeded anyway (§The Scribe's cwd) — `error` may only be set on failure, so without `notice` each of those exit-0 findings would die at the one stage that saw it.

### The Scribe scratch location has a lifecycle — it is swept, ignored, and never durable

The payload file step 2 writes is a **hand-off**, not a record: the durable sidecar is what step 3's verb persists under `.flotilla/waves/<slug>/reports|verdicts/`. The moment step 3 returns, the payload under `.flotilla/tmp/` is residue. Three properties close the loop, and they are deliberately split across three owners rather than piled onto the Scribe:

- **The name is deterministic** (`<kind>-<row id>-<iteration>.json`), so the Scribe's own retry overwrites rather than accumulates. That is the *within-a-row* half, and it is all the brief itself needs to know.
- **The close sweeps it.** A wave still leaves two files per row behind, forever, and for several wave-generations **no cleanup path touched them at all** — not wave-close, not wave-resume, not start-mechanics (measured by a repo-wide grep: four driver sites, two spec sites, zero cleanup sites). The engine now sweeps the directory on the `--orphans` pass every close already runs, reporting under `orphans.scratch` — [wave-close phase 3](../../wave-close/reference/phase-3-worktree-cleanup.md#the-scribe-scratch-sweep--a-repo-internal-location-that-had-no-lifecycle-issue-355) owns the reading guide, and [phase 6](../../wave-close/reference/phase-6-archive.md) is where the close confirms it actually ran.
- **The consumer ignores it.** flotilla's own repo gitignores `.flotilla/` wholesale, so this gap is invisible here — but the recommended consumer posture is to **track** `.flotilla/` (the spine is the durable WAL, committed for resume), and there a payload written mid-wave is untracked litter in the tree a `git add .flotilla` would sweep into a commit. [wave-setup's `.gitignore` scaffold](../../wave-setup/reference/setup-mechanics.md#gitignore-scaffold--the-scribe-scratch-path-issue-355) records the one line that closes it.

The sweep and the ignore rule are belt and braces on purpose: the sweep runs once, at close, while a wave is in flight for hours before that — the ignore line is what protects the window.

## The Scribe's cwd — a precondition observed once, never a `cd` carried forward

The Scribe is the one role in this pipeline that is **not** worktree-isolated: it runs in the session cwd. Its brief used to open by `cd`-ing to the absolute `REPO_ROOT` and then call the repo-relative `WAVE_CLI` two steps later. That split read as Convention-13-clean (nothing fused, one call per step) and was in fact resting on **incidental safety**: the `cd` never reached the engine call at all, and the call resolved anyway because the Scribe's dispatch cwd already *was* the repo root. Nothing in the design said so, nothing checked it, and the step that looked like it established the precondition was the one step that could not.

**The measured fact this file and [wave-shared Convention 13](../../wave-shared/reference/convention-13-one-bash-call-per-step.md) state identically: a dispatched agent's cwd is reset to its dispatch root before *every* Bash call** — the worktree root for a worktree-isolated role, the session cwd for one (like the Scribe) without isolation. Two consequences, and the second is the useful one:

1. A `cd` issued in call N is invisible in call N+1. It can never establish a precondition for a later step, so a `cd`-then-engine-call split is not a *safe* version of the fused form — it is a *silent* one.
2. Because the reset target is identical for every call, **cwd is a per-agent constant, not carried state.** One bare `pwd` therefore characterizes every Bash call the agent will ever make. That is what lets the resolved design *verify* the cwd without ever *setting* it — and it is why the remedy is not "re-check it before each call" either.

So the Scribe brief below **opens with a bare `pwd`** and compares it against the compose-time `REPO_ROOT` literal rendered into its own text — no `cd`, and no shell variable (Convention 13's Catalog entry 1: a `$VAR` expansion is refused outright from a worktree-isolated dispatch, and a brief must not teach a shape that cannot run for the roles that inherit it); **passes every path argument absolute** — `--dir` always was, and the payload `<json-file>` now is too, because the verb resolves that argument with `readFileSync(file)` against the process cwd (`tools/wave/src/route-cli.ts`, `runWriteSidecar`), which made a bare relative temp name the same cwd dependency wearing a different hat; and **treats a cwd mismatch as a finding to report, never as something to `cd` around.**

**What remains is a precondition, not a persistence assumption — and that difference is the whole repair.** A persistence assumption is unobservable and defaults to "it worked last time"; a precondition is stated, checked in one call, and attributable when it fails. It is also not the Scribe's to fix: it belongs to the Coordinator, which dispatches from the repo root and fills `REPO_ROOT` from that same root (`git rev-parse --show-toplevel`).

**Both configured `engine.cli` forms (ADR-0032) are covered, and they fail differently — which is why the `pwd` stays even where the binding carries no path:**

| configured form | what a wrong dispatch cwd does to the Scribe's step-3 call |
|---|---|
| **path-free, npm-first** (`npx @scope/<engine-package> …`) | **Measured, not inferred** (see the measurement below): the command names no path, so nothing resolves *against* the cwd — but the package lookup behind it begins at the cwd and walks up, so a wrong cwd changes **which copy answers**, not whether one does. Two cwds, one byte-identical command, two different engine copies, **both exit 0 with nothing on stderr**: a silent wrong-version write, the one failure shape no exit code reports. |
| **repo-relative, vendored** (`./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts` — flotilla's own binding) | the path resolves against the cwd, so a wrong cwd fails loud and immediately, nothing is written, and the Scribe reports it through `ok:false`. |

**The measurement behind row 1 (2026-07-31, issue #355 — npm/npx 11.12.1, macOS).** The npm-first row above was **asserted** from first principles for several waves before anyone ran it. It has now been exercised: two sibling "consumer checkouts" were each given their own local copy of the *same* bin name under `node_modules/.bin/`, each printing a distinct identity, and one identical `npx --no-install <bin>` was invoked from four cwds.

| cwd the identical command was run from | which copy answered | exit |
|---|---|---|
| `consumerA/` (holds copy **A**) | **A** | `0` |
| `consumerB/` (holds copy **B**) | **B** | `0`, stderr empty |
| `consumerA/sub/deeper/` (holds none) | **A** — the lookup walked **up** | `0` |
| a directory with no copy anywhere up-tree | none locally; npx reached the registry (`npm error code E404 … GET https://registry.npmjs.org/…`) | `1` |

Three readings, and the third is a **correction** the asserted wording did not carry:

1. **The claim holds where it matters.** Rows 1–2 are the same command differing only in cwd, and they bound different engine copies. Nothing in the exit code, and nothing on stderr, distinguishes them. A Scribe that wrote its sidecar through the wrong copy would report `ok:true` and a real path.
2. **"Walks up" is literal.** Row 3 answered from a directory two levels above the cwd — so a wrong cwd *inside* the right repo is still the right copy, and the failure needs a wrong cwd in a *different* tree (a sibling checkout, another worktree with its own install). That is exactly the shape a multi-worktree wave session produces.
3. **The silence is CONDITIONAL on a rival copy existing.** Row 4 — no copy anywhere up-tree — did not silently do the wrong thing; it failed loud, exit `1`. So the npm-first form is not universally silent, as the pre-measurement wording implied. It is silent precisely when a *different* valid copy is reachable from the wrong cwd, which is why the `pwd` check stays: the dangerous case is the one that looks like success.

Neither form is rescued by a `cd` (it does not survive), by fusing one on (Convention 13, both mechanisms), or by making `WAVE_CLI` absolute: the config layer validates `engine.cli` as **repo-relative and non-absolute** precisely so the tracked-settings allowlist can match it (Authoring constraint #4), so an absolute form trades a checkable cwd precondition for a permission dialog mid-AFK-dispatch with nobody to answer it. What *does* generalize is the part the resolved design uses — make every argument absolute, and observe the one thing left that cannot be.

## The bare-id contract — why the id is fixed at both ends of the write

A sidecar is filed as `<id>-<iter>.md` and resolved by `reportFor(<the row id>)`. Opaque (ADR-0001) means the engine never *interprets* that id; it does not mean the id is free-form, because "never interpret it" is precisely what forces a LITERAL match. So a decorated id — `#126`, `#126 — <the issue title>` — produces a real, well-formed, schema-valid file that no row can ever resolve: **present to an `ls`, absent to a resume**, with nothing loud anywhere. That is strictly worse than a sidecar that was never written, which at least fails the routing-time existence check honestly.

Two values feed the write, and they come from opposite places — so the driver fixes them differently:

| Value | Comes from | Rule |
|---|---|---|
| `--id` | the compose-time `ISSUES` row (Coordinator) | **Never varied, by anyone.** The Scribe brief forbids substituting it, and the engine refuses a non-bare `--id` with exit 2 — because the caller facing a refusal reaches for the argument it controls, and that reach is what produced the misfiled records in the first place. |
| the report's `issue` field | the Worker (an agent told the field's name, historically not its shape) | **Stated in the Worker brief** as the bare id, and **normalized by the engine** when it arrives decorated (exit 0 + a `notice:`). A repair, not a refusal — a refusal here is exactly what a caller routes around. |

The live incident (`2026-07-27-consumer-gaps`): three of six Workers decorated the field. Two sidecars landed under a name the reader could not resolve, and would have read as "no durable record" on a resume while the operator stared at a populated directory; the third was refused outright and only existed because a human noticed. Both directions are now closed at the boundary, and the routing-time recovery reports misnamed litter it used to walk past (wave-shared Convention 5).

## PR-open reuse-refusal — what `host-pr create` guarantees (and refuses) the caller

Two call sites in this pipeline open a PR through the engine's find-before-create seam (`host-pr create`, ADR-0019) — the Worker's own Termination step 3 below, and the terminator's CALL 1 (`start-mechanics.md` step 7c). Both used to read only the exit-0 happy path (parse `.url`, move on) and discard everything else the verb can return. That silently converted one specific failure into a false success: a refused rewrite reaching a later "does a PR exist for this branch?" re-query, which answers yes — because the PR does exist — while the caller's own intended content never landed on it.

**The contract, stated once.** `create` is find-before-create: a branch with no open PR gets one created (exit 0, `outcome: "created"`); a branch that already has one open gets it REUSED, with its title/body RE-WRITTEN to the passed values (exit 0, `outcome: "reused"`, `updated: true`) — last-writer-wins, so a cap=1 re-dispatch onto the same branch never opens a duplicate. The one rewrite `create` refuses outright is the one whose damage is silent: dropping the close phrase (wave-shared Convention 4) the LIVE body currently carries, by passing a new body that carries none. That refusal is `exit 1`, `outcome: "reuse-refused"`, a `reason`, and — the detail that matters most for a caller reading the JSON quickly — **no write at all**: the live PR's title and body are exactly what they were before the call. `--allow-close-phrase-loss` is the deliberate override that permits that one rewrite anyway.

**Why a composed render should never legitimately trigger it.** The refusal fires on the body the CALLER passes, not on the branch's history: it is `hasClosePhrase(newBody) === false` while the live body already carries one. Every body either caller here composes carries the close phrase by construction — the Worker's under policy clause 6 below, the terminator's as the rendered `## Reviewer verdict` section above the store-kind close phrase (`start-mechanics.md` step 7c). **A composed render always passes this guard.** A `reuse-refused` reaching either call site is therefore not a routine branch of the happy path to route around — it is evidence that THIS call's own composed body is missing its close phrase, a compose defect. Neither caller ever has a legitimate reason to reach for `--allow-close-phrase-loss`: doing so would deliberately ship the exact damage the guard exists to stop, in response to a signal that the real bug is upstream, in the body that was passed.

**The refused payload still carries the PR's URL — on purpose, and that is the trap.** `create`'s refusal response includes the reused PR's `url` (`alignedPrRef`), because the PR genuinely is this branch's PR; the rewrite was refused, not the PR's existence. That is exactly what makes the refusal payload resemble the success payload at a glance, and exactly why "does a PR exist at this URL" is the wrong question to ask next. Both call sites below now read `create`'s own exit code / `outcome` FIRST, before any later status re-query's answer is allowed to stand in for "did my rewrite land."

## The compose-fresh-or-verify rule — a composed driver copy is coupled to this document

Every wave dispatch composes the Workflow script from this file — the `## The script` fence below, with the current wave's rows filled into `ISSUES` and the compose-time constants (Authoring constraints below) filled in. That composition is a COPY, and a copy can go stale the instant this document is edited out from under it: a Coordinator session that keeps a previously-extracted copy around (a scratch file, a re-used compose from an earlier wave in the same session) is dispatching against what this document USED to say, not what it says now.

**The rule.** At every dispatch, the Coordinator either:

1. **Composes fresh** — extracts the script verbatim from this document's current `## The script` fence at compose time, or
2. **Verifies a reused copy's currency** — if a previously-composed copy is reused rather than freshly extracted, diffs it against this document's CURRENT script and walks the currency-assertion checklist below BEFORE that copy is dispatched.

A copy that is neither freshly extracted nor currency-checked is not eligible to dispatch. This is deliberately a RULE, not a single mechanical check like `assertRequiredRowFields` — it targets drift between the DOCUMENT and a COPY of it, which nothing inside the copy itself can detect (a stale copy's own assertions are exactly as stale as the rest of it). `start-mechanics.md` step 4d names this rule as a gate before any row is composed into `ISSUES`.

**The seeded currency-assertion checklist.** Each item below is a drift signal this document has already paid for once, either by a live incident or by the very fix that answers it — this list exists so the next one is checked instead of re-discovered:

- **Stage-3 (Reviewer) `agent()` call carries `model: issue.model`.** A missing `model` key is the tell for a copy that predates the ADR-0007 Amendment 2026-07-31 model-tier binding — it silently re-inherits the Coordinator's own session model for every Reviewer (the pre-existing "CURRENCY CHECK" comment beside the pipeline's Stage-3 call, below, is this exact item — do not delete that comment when re-extracting).
- **The workspace-setup `pwd` step states cwd as a RESET CONSTANT, never a persisted one.** The correct premise: cwd is reset to the dispatch root before every Bash call, so one `pwd` characterizes every later call and a `cd` never reaches a later step. A copy whose Scribe brief (or Worker workspace-setup) still opens with a `cd` to `REPO_ROOT` "so a later call resolves against it" is carrying the falsified premise §The Scribe's cwd exists to retire (Occurrence 1 below).
- **`reviewerBrief()`'s SECRET-SAFE clause states the Reviewer's OWN measured isolation posture** — no `isolation` key on the Reviewer's `agent()` call (Stage 3) — never the Worker's (`isolation: 'worktree'`, Stage 1). A copy that states the Worker's posture for the Reviewer is carrying the falsified claim `#356` corrected (Occurrence 2 below).
- **Termination step 4 is the `host-pr status --branch` re-query recipe**, never a `PR_URL=$(...)` capture-then-guard shape. A copy still prescribing a capture-plus-guard predates the Convention-12/13 fix and will teach the Worker a shape the worktree-isolation guard refuses outright.
- **The two inlined `*_SCHEMA` literals deep-equal the exported engine consts**, `anyOf`-free. `skill-schema-drift.spec.ts` is the automated form of this one for what ships on `main`; the checklist item is for a HAND diff when comparing two composed copies that may not both be on `main` yet.
- **`REQUIRED_ROW_FIELDS` names every scalar field the copy's OWN `workerBrief`/`reviewerBrief` actually interpolate.** A field added to a brief but not to that array is exactly how the narrow `anchorSha`-only predecessor of this assertion missed `branch` one wave-generation later (Authoring constraint #7 below).

**Both motivating occurrences, recorded as evidence.**

- **Occurrence 1 — a frozen template outlived the cwd-persistence fix.** `docs/retros/2026-07-30-beta1-double-wave.md` (finding DW-F3): a Convention-13 row and, independently, the Echo-Guard row both measured that cwd does NOT persist between a dispatched subagent's Bash calls that same wave — yet the Scribe brief actually dispatched that wave still opened with a `cd` to `REPO_ROOT` in call 1 and ran its engine verb in call 3, resting on the incidental fact that the dispatch root already was the repo root, not on anything the brief itself established. The wave's own Coordinator compensated by hand, per row, rather than by re-extracting a corrected copy — the ten ad-hoc currency assertions this rule exists to replace with a mechanism. `#353` (the fix carried in this document today: step 1 is a bare `pwd` compared against the compose-time literal, never a `cd`) is what closed it.
- **Occurrence 2 — the rule's first measured payoff, one wave later.** `#356` (landed as commit `e41c016`, "restore the dead-end assertion, reconcile the reviewer-isolation posture, bound the shell-function remedy"): `reviewerBrief()`'s SECRET-SAFE clause stated the Reviewer's `agent()` call carried the WORKER's measured isolation posture (`isolation: 'worktree'`) instead of its own (no `isolation` key at all, Stage 3) — a claim the repo had just falsified by adding the Worker-scoped posture note in the first place. A **compose-fresh anchor-diff** — diffing the freshly-extracted script against the previous compose before that wave's dispatch — caught the mismatch before it reached a Reviewer brief. This is the first occasion the rule (informally applied) paid for itself measurably, rather than being argued for in the abstract.

## Authoring constraints

1. **Embed per-row data in the script body** as `const ISSUES = [...]` — the Workflow `args` channel does not reliably deliver a large nested payload. Never depend on external `args` for structured input.
2. **Compose briefs in-script** via a helper that string-interpolates the structured fields — a function field cannot survive JSON serialization through `args`.
3. **Anchor every Worker to the wave-anchor SHA** (`git reset --hard <anchorSha>`) so the Reviewer (wave-reviewer) can diff against that SHA, not `main`. **This is presence-checked here (Authoring constraint #7's `REQUIRED_ROW_FIELDS`), never resolvability-checked** — `isMissingField` only tests presence/non-emptiness, so a well-formed but FABRICATED SHA (a correct-looking short prefix that names no real commit) passes it exactly like a real one and reaches every brief individually. `start-mechanics.md` step 4c is the host-side gate that catches that case once, before compose — the Workflow script itself has no filesystem/git access to check it from inside (§Harness constraint above), so this cannot be folded into the compose-time JS assertion; it stays a Coordinator-side precondition instead. Live occurrence: a fabricated anchor SHA with a correct 7-char prefix passed compose and reached four parallel briefs; all four Workers independently caught it themselves.
4. **Fill the Scribe compose-time constants** — `REPO_ROOT` (absolute, and **shell-quoted** wherever it is interpolated into a brief — see its own note below), `WAVE_CLI` (**filled from the consumer's configured `engine.cli`**, read out of `wave.config.json` at compose time — see its comment below), and the two **absolute** sidecar dirs (`REPORTS_DIR` / `VERDICTS_DIR`, `.flotilla/waves/<slug>/reports|verdicts` — likewise shell-quoted wherever interpolated), just as you fill `depsSetup`. `WAVE_CLI` has **no default of its own**: the binding lives in exactly one place per repo, and the driver reads it rather than restating a form (ADR-0032). An **absent** `engine.cli` is a STOP, not a cue to pick a spelling — `wave-setup` has not finished in that repo, and nothing should be dispatched until it has. The engine validates the field as **repo-relative and non-absolute** on the consumer's behalf, which is exactly the property this constant needs: the tracked `.claude/settings.json` permission allowlist a dispatched agent inherits can only match **repo-relative** invocation prefixes — an absolute form would embed a machine- and client-specific path that a public repo's tracked settings must never carry. Worker and Reviewer worktrees carry **tracked files only** (see "A worktree carries tracked files only" below), so that tracked allowlist is the *only* permission source they inherit; an absolute-form engine call from a Worker's termination step or a Scribe would hit the permission gate mid-wave and break AFK dispatch, which is why the config refuses one outright. A Worker's worktree needs no extra step for the configured binding to resolve: its post-checkout cwd already *is* a repo-relative root, and every one of its Bash calls starts back at that root. A Scribe, running in the **session cwd** (no worktree isolation), gets the same property from the same mechanism — **not** from a `cd`, which never reaches the call that would need it (§The Scribe's cwd, above). Its brief therefore *observes* the cwd once with a bare `pwd` and reports a mismatch instead of `cd`-ing around it; `REPO_ROOT` is the literal that `pwd` output is compared against and the base of the payload's absolute path, never a directory the Scribe changes into. `REPORTS_DIR` / `VERDICTS_DIR` stay absolute regardless — sidecar dirs are addressed independent of the Scribe's cwd entirely.
5. **Never backslash-escape an apostrophe inside a single-quoted JS string when composing a brief.** Composed brief text (`reviewerHints`, `issueSpec`, `prTitle`, and any other free-form field interpolated into the script body) is natural language and will routinely contain apostrophes — a `\'` inside a `'...'`-delimited literal parses fine to the human eye but is exactly the kind of thing to get wrong under compose pressure. Use a double-quoted string for that literal, or rephrase to drop the apostrophe. **Observed failure shape (W17-F1):** the first Workflow launch of a wave failed at the script parser — not at any `agent()` call — because a composed `reviewerHint` carried a backslash-escaped apostrophe inside a single-quoted string; the parser's error pointed at the escaped quote. Cost was zero (no agent had started, no state was touched), but the whole compose round was lost and had to be redone.
6. **Never hold the engine CLI — or any command — in a shell variable in your own Coordinator shell, and never let an empty capture flow onward (wave-shared Convention 12).** This constraint is about the shell *you* type into while composing and routing, not about the script: `CLI="<the configured engine.cli value>"; $CLI spine set-row-state …` exits **127** under zsh (no word-splitting of an unquoted expansion) and runs **nothing** — five occurrences, the most recent of which produced an empty PR URL that was then written to the spine as a value. Bind a function instead (`wave_cli() { … "$@"; }`) and iterate a real array rather than `for x in $LIST`. **And obey the call boundary on every capture you subsequently *use*** — a PR URL, an id, a SHA: verify it in the SAME Bash call that produced it, or do not capture it at all and re-query its source in the call that needs it (`host-pr status --branch <b>` for a PR URL). A shell function and a shell variable are both session state, and shell state does not survive between Bash calls — which is why the retired `require_capture` helper, defined at one step and invoked at another, could never fire on the value it named. The `WAVE_CLI` constant below is the safe shape by contrast, and stays that way precisely because it is a compose-time JS string that no shell ever expands (see its own comment).
7. **Check a composed row against `REQUIRED_ROW_FIELDS`, not against a re-derived reading of every brief.** The full set of scalar fields the briefs below interpolate is named in exactly one place — the `REQUIRED_ROW_FIELDS` array right before `assertRequiredRowFields` — so a Coordinator wiring a new row never has to grep every `workerBrief`/`reviewerBrief` for `${issue.*}` to find out what it must supply. A field added to a brief but not to that array is exactly how the narrow `assertAnchorSha` (anchorSha-only) predecessor of this assertion missed `branch` one wave-generation later.

## A worktree carries tracked files only (FOR-32, W4-F4)

`isolation: 'worktree'` gives Worker and Reviewer alike a **fresh checkout of tracked files** — nothing gitignored comes along. **That parity is checkout provisioning only, a different mechanism from the isolation guard's own asymmetry:** [wave-shared Convention 13](../../wave-shared/reference/convention-13-one-bash-call-per-step.md)'s Catalog entry 1 records that the command-complexity refusal (a bare `$VAR` expansion refused outright) is reproduced from the Worker's `agent()` call, which sets `isolation: 'worktree'` explicitly (Stage 1), and is **not** established as refused from the Reviewer's `agent()` call, which carries no `isolation` key at all (Stage 3) — two mechanisms, not one, so a skimming reader should not conflate "both worktrees are provisioned the same way" with "both dispatches carry the same guard." Two consumer paths are commonly gitignored, and both briefs below assume they exist unless the Coordinator fills the gap:

- **The dependency directory.** If it is gitignored (the ordinary case for a lockfile-managed dependency tree), a fresh worktree has it **absent, not merely un-installed** — the verify gate the brief tells the agent to run cannot run at all without an install step first. The Reviewer brief hits the identical wall: it independently re-runs the same verify commands in its own worktree.
- **The store config** (e.g. `wave.config.json`). If it is gitignored, it is likewise **absent** from the worktree, so an agent standing inside that checkout cannot resolve a tracker id against a store it has no config for — a bare `issueRef` is unreadable from there.

Neither gap is flotilla's to close generically with a hardcoded command — the dependency dir, the install command, and the config's location are all **consumer-specific**. The mitigation is two per-row inputs the Coordinator supplies (`depsSetup` / `issueSpec` below), sourced from the consumer's own setup — `wave-setup`'s preconditions record exactly these two answers so the Coordinator has them ready at compose time instead of re-deriving them wave after wave.

## The human gate — a human-gated row never reaches `agent()`

A row whose `Worker` is human-gated (`HITL-required` by default, ADR-0012) is real wave work — planned, claimed, tracked — that **no agent may pick up until a human acts**. `start-mechanics.md` step 3b holds such a row in the human lane and leaves it out of `ISSUES`. This file carries the backstop for that exclusion: `assertNotHumanGated`, run over every row **before any `agent()` fan-out**, right beside `assertRequiredRowFields`.

**Why an assertion and not just the instruction.** This failure has no symptom of its own. Every required field is present, every brief interpolates cleanly, the worktree checks out, and the Worker runs to completion — against a blocker that is, by construction, not something an agent can clear. The wave spends a full agent budget and returns a report that looks ordinary. That is the same shape as the two defects the neighbouring assertion exists for (`anchorSha`, then `branch`): an exclusion the Coordinator is *told* to apply, applied by hand, per wave, until one pass forgets. The fix is the same too — make the composed array itself refuse.

**Deliberately its own predicate, not a `REQUIRED_ROW_FIELDS` entry.** That list asks *is this field present enough to interpolate?* and its remedy is to wire the value in. This one asks *may this row be dispatched at all?* and its remedy is to take the row out. Merging them would make a missing `worker` read as a pass and a human-gated one read as a wiring bug.

**The token is compose-time-filled, like `WAVE_CLI`.** `Worker` is a config-governed enum (ADR-0007), so `HUMAN_GATED_WORKERS` is the consumer's set, defaulting to the engine's `HUMAN_GATED_WORKER` (`tools/wave/src/wave-md-rw.ts`, whose `humanHeldRowIds` owns the same predicate engine-side). The script cannot `import` it — no filesystem, no local modules — so it is pasted, exactly as the two `*_SCHEMA` literals are.

**Scope: this is a backstop, not the gate.** It throws for the whole `pipeline()` rather than skipping the offending row, because a human-gated row in `ISSUES` means the upstream hold did not run — and the rest of that composition is then worth re-checking too. The gate that lets the other rows dispatch normally is step 3b, upstream, where the row is simply never added.

## Re-dispatch (iteration ≥ 2): teardown-before-dispatch + tracking-free checkout (W26-F1)

A cap=1 re-dispatch (`route-verdict`'s `changes-requested` → `re-dispatched`, start-mechanics.md step 7d) sends the SAME Worker back onto the SAME branch — `wave/<id>-<slug>` already exists, carrying the iteration-1 commits, and the fresh iteration-2 worktree must land on it, not discard it. Two structural traps live here, both hit for the first time live in `2026-07-23-w25-followups-w26` (finding W26-F1):

1. **The branch is still held by the iteration-1 worktree's own `git worktree` registration.** A checkout of the same branch name from a *second*, iteration-2 worktree fails against that registration. **The Coordinator tears it down BEFORE the iteration-2 dispatch fires** — `{{wave-cli}} worktree-cleanup --branches "wave/<id>-<slug>"` (the scoped `--branches` escape hatch, `cli.ts`) — see start-mechanics.md step 7d. Live occurrence: the iteration-2 Worker found the branch still registered to its iteration-1 worktree and had to unregister it by hand before its own checkout could proceed.
2. **A tracking checkout writes to the shared `.git/config`.** `git checkout -B <branch> origin/<branch>` (or any checkout form that sets up upstream tracking) writes an upstream-tracking entry into the MAIN repo's `.git/config` — the one file every worktree shares — and that write is sandbox-write-denied for a worktree-isolated agent. The checkout half-applies (the branch switches; the config write is refused) and strands the agent mid-switch. **The iteration-2 workspace-setup brief below (`workerBrief()`'s `issue.iteration > 1` branch) uses a TRACKING-FREE form instead** — `git fetch origin <branch>` then `git checkout -B <branch> FETCH_HEAD` (or the explicit iteration-1 head SHA — `issue.iteration1HeadSha`, threaded from the iteration-1 `WorkerReport.commitShas`' last entry, for a head-verify) — which never touches the shared config. Live occurrence: a Worker's tracking checkout stranded it mid-switch; recovery was a manual `git symbolic-ref` (its working tree byte-verified first).

Both are threaded into `workerBrief()` below: whenever `issue.iteration > 1` it renders a DIFFERENT `## Workspace setup` block (this doc's own §Re-dispatch workspace setup, inline in the script). The `issue.iteration === 1` rendering — the default, and the one the schema-drift spec's neighboring pins exercise — is unchanged.

## The script (paste into the Workflow tool)

```js
export const meta = {
  name: 'wave-start-inflight',
  description: 'Dispatch + review one ready wave; return schema-validated reports + verdicts',
  phases: [{ title: 'Dispatch' }, { title: 'Review' }],
}

// ── inlined from wave-shared (copy of WORKER_REPORT_SCHEMA) ──
// anyOf-free by design (agent tool's input_schema rejects a top-level anyOf/oneOf/allOf,
// W5-F1) — the prUrl-on-done/done-with-concerns invariant is BRIEF-enforced below, not
// schema-enforced. See "Why this copy drops anyOf" above; skill-schema-drift.spec.ts pins it.
const WORKER_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome','issue','branch','commitShas','filesChanged','tests','lint','judgmentCalls','reviewerFocusItems'],
  properties: {
    outcome: { type: 'string', enum: ['done','done-with-concerns','needs-context','blocked'] },
    issue: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 },
    worktree: { type: 'string' },
    commitShas: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    prUrl: { type: 'string' },
    filesChanged: { type: 'object', additionalProperties: false, required: ['new','modified','renamed'],
      properties: { new: { type: 'integer', minimum: 0 }, modified: { type: 'integer', minimum: 0 }, renamed: { type: 'integer', minimum: 0 } } },
    tests: { type: 'string', minLength: 1 }, regressionSweep: { type: 'string' },
    lint: { type: 'string', minLength: 1 }, conflictMarkers: { type: 'string' },
    judgmentCalls: { type: 'array', items: { type: 'string' } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
  },
}

// ── inlined from wave-shared (copy of REVIEWER_VERDICT_SCHEMA — uniform Reviewer: NO briefProfile) ──
const REVIEWER_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict','branchReviewed','riskClass','workerReportDigest','acVerification','reviewerFocusItems'],
  properties: {
    verdict: { type: 'string', enum: ['approve','changes-requested','questions-blocking'] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: ['mechanical','isolated-refactor','cross-feature-refactor','public-API-change'] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ac','met','evidence'],
      properties: { ac: { type: 'string', minLength: 1 }, met: { type: 'string', enum: ['met','partial','not-met','deferred'] }, evidence: { type: 'string' } } } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' }, gitStateSane: { type: 'boolean' },
    // Documented-Form Comparison (ADR-0030) — FLAT + OPTIONAL. The duty is
    // conditional ("required when a trigger fired"), but a conditional at the
    // schema ROOT means a top-level anyOf/if, which this boundary rejects
    // outright (W5-F1) — so the condition lives in the Reviewer contract prose
    // (.claude/agents/wave-reviewer.md, Check 6), exactly as the prUrl
    // invariant above is brief-enforced rather than schema-enforced on this
    // copy. `sources` minItems:1 is the STRUCTURAL half of the no-restatement
    // rule: a comparison must cite a document the Reviewer read itself.
    documentedFormComparison: {
      type: 'object', additionalProperties: false,
      required: ['trigger','sources','divergences'],
      properties: {
        trigger: { type: 'string', enum: ['issue-declared','worker-declared','deferred-core-path'] },
        sources: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        divergences: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['description','deliberate'],
          properties: { description: { type: 'string', minLength: 1 }, deliberate: { type: 'boolean' } } } },
      },
    },
  },
}

// ── Scribe result — DRIVER-LOCAL, deliberately NOT drift-pinned (ADR-0024) ──
// No engine const corresponds to this; do NOT add it to skill-schema-drift.
// Boundary-safe: a plain object, no top-level anyOf/oneOf/allOf (W5-F1).
const SCRIBE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'path'],
  properties: {
    ok: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' },
    // `notice` carries an EXIT-0 finding through — a normalized decorated id or
    // misnamed litter the write verb printed on stderr, and (brief step 1) a cwd
    // that did not match the compose-time REPO_ROOT even though the write still
    // succeeded, which on a path-free engine binding is the ONLY signal that the
    // wrong engine copy may have answered. Without it the only channel the Scribe
    // has is `error`, which it may only set on failure, so an exit-0 finding would
    // be dropped at exactly the stage that saw it.
    notice: { type: 'string' },
  },
}

// ── Scribe compose-time constants (Coordinator-filled, like depsSetup) ──
// REPO_ROOT is the one ABSOLUTE-by-necessity constant: Scribes run in the
// session cwd (no worktree isolation), so their brief carries this literal
// twice — as the cwd its step-1 `pwd` is compared against, and as the base of
// the ABSOLUTE payload path its step-3 engine call passes. It is NEVER a
// directory the Scribe changes into: a `cd` cannot reach step 3 (cwd is reset
// to the dispatch root before every Bash call), and the brief names that
// retired step as a dead end rather than leaving it to be re-derived
// (§The Scribe's cwd, above). Fill it from `git rev-parse --show-toplevel` in
// the Coordinator's own session — the same root the wave is dispatched from.
// It is interpolated SHELL-QUOTED wherever it reaches a brief — always
// shell-quoted, never bare — because an absolute repo path is precisely where
// spaces and non-ASCII characters live, and an unquoted interpolation breaks
// silently on one: the Scribe stage logs loud and passes its payload through
// rather than failing the wave (ADR-0024 exists so the sidecar becomes durable
// the moment the work does; an unquoted REPO_ROOT quietly reopens exactly that
// window). Live-verified against a checkout path containing both a space and a
// typographic en-dash (this repo's own worktree path) — the unquoted form
// fails outright (`No such file or directory`) on the retired `cd` and on any
// path argument built from it alike; the quoted form succeeds. That is why the
// payload path below is quoted too, not only the sidecar `--dir`.
const REPO_ROOT = '<absolute repo root, e.g. "/abs/path/to/flotilla">'
// WAVE_CLI IS FILLED FROM THE CONSUMER'S CONFIGURED BINDING — `engine.cli` in
// its `wave.config.json`, read once at compose time and pasted here verbatim.
// It has NO DEFAULT OF ITS OWN and states NO INVOCATION FORM: the binding lives
// in exactly one place per repo, and this constant reads it (ADR-0032). An
// ABSENT `engine.cli` is a STOP — `wave-setup` has not finished in that repo —
// never a cue to pick a spelling and never a chain to walk. If the configured
// binding fails at runtime, that is a needs-attention finding about a broken
// install, config or release; a Worker reports it, it does not route around it.
//
// The config layer validates the value as REPO-RELATIVE AND NON-ABSOLUTE, which
// is precisely the property this constant needs. The tracked
// `.claude/settings.json` permission allowlist a dispatched agent inherits can
// only match REPO-RELATIVE invocation prefixes — an absolute form would embed a
// machine- and client-specific path a public repo's tracked settings must never
// carry. Worker AND Reviewer worktrees carry tracked files only (see "A worktree
// carries tracked files only" above) — that tracked allowlist is the ONLY
// permission source they inherit, so an absolute-form engine call from a
// Worker's termination step or a Scribe would hit the permission gate mid-wave
// and break AFK dispatch. A Worker's post-checkout cwd already IS a
// repo-relative root, so the configured binding resolves there unchanged.
//
// Two live findings shaped the field's validation and are why "just try the
// other form" is not on offer here. A marketplace plugin consumer has no
// vendored `tools/wave` and no local `tsx` binary, so a vendored-form
// invocation resolved to nothing on every Worker termination step and every
// Scribe call (DA-F1). Going the other way, an unpinned `npx` invocation costs
// ~82 s per call against ~1.2 s for a pinned local binary, and contends on the
// shared npm cache lock under fan-out (`ECOMPROMISED`, KW-F7). Neither is a
// form to rank above the other: each is simply wrong for a repo whose install
// posture says so, which is what makes the binding a SETUP-TIME decision.
// depsSetup (Worker step 4, the FIRST step) installs whatever the configured
// binding resolves through, so the binary exists before the terminator's
// WAVE_CLI call — keep depsSetup first for this reason as well as the
// verify-gate one.
// (Provenance: ADR-0032; `docs/retros/2026-07-27-plugin-consumer-w1.md` DA-F1.)
//
// WAVE_CLI also carries an explicit NODE_USE_ENV_PROXY=1 prefix (wave-shared
// Convention 1's raw-fetch-vs-proxied-sandbox fix). The tracked settings `env`
// block — scaffolded by wave-setup, and set the same way in flotilla's own
// tracked `.claude/settings.json` — is the STANDING source for this flag once
// it applies: every command the harness runs already inherits it, which makes
// this prefix REDUNDANT-BUT-HARMLESS wherever that block is present. The
// prefix stays on the constant anyway because it is LOAD-BEARING for any
// consumer WITHOUT that tracked block yet (a fresh repo before wave-setup has
// run, or a harness without settings-env support) — the driver has no way to
// know which posture a given consumer is in, so it keeps the belt-and-braces
// form rather than assume the block is present.
//
// WAVE_CLI IS A COMPOSE-TIME JS CONSTANT — IT MUST NEVER BECOME A SHELL
// VARIABLE (wave-shared Convention 12). It is interpolated into brief TEXT by
// this script, before any shell exists, so every rendered brief carries the
// literal command string and no expansion ever happens. That is what makes it
// safe. Reading the value out of config does NOT change that shape: what moves
// is where the string comes from, not what it is. The failure this note
// forecloses is the "helpful" refactor that turns the constant into a runtime
// lookup in the agent's shell — `CLI=$(… engine.cli …); $CLI verb` — under zsh
// an unquoted expansion is NOT word-split, so that looks for a command whose
// name is the whole configured string, exits 127, and runs NOTHING. That exact
// line has broken a wave four times before the guard below existed (W4-F10 /
// W5-F5 / W18-F3 and the gate run that filed Convention 12). If a shell
// binding is genuinely wanted somewhere, it is a FUNCTION —
// `wave_cli() { NODE_USE_ENV_PROXY=1 <the configured value> "$@"; }` — never a
// variable in command position. That remedy is bounded, and stated no wider
// than it holds: a shell function is a fix only WITHIN the one Bash call
// that defines it — a function is session state exactly like a variable,
// and no shell state survives between a dispatched role's Bash calls, on
// either dispatch posture (measured live, wave-shared Convention 13,
// §Splitting is not always a preceding `cd`). Defining `wave_cli()` in call
// N buys nothing in call N+1; it is not a substitute for carrying a value
// across calls, which nothing here is.
const WAVE_CLI = 'NODE_USE_ENV_PROXY=1 <engine.cli from wave.config.json, verbatim>'
// REPORTS_DIR / VERDICTS_DIR stay ABSOLUTE regardless — sidecar dirs are
// addressed independent of the cwd the Scribe was dispatched into, and there is
// no `cd` anywhere in its brief for that cwd to have been moved by: the Scribe
// OBSERVES its cwd once and never sets it (§The Scribe's cwd, above). Absolute
// is what makes these two dirs indifferent to the observation's outcome — a
// cwd mismatch is a finding to report, never a reason `--dir` resolves
// somewhere else. Like REPO_ROOT, both are interpolated SHELL-QUOTED wherever
// they reach a brief (the Scribe's `--dir "${dir}"` call, below) for the same
// reason.
const REPORTS_DIR = '<absolute .flotilla/waves/<slug>/reports>'
const VERDICTS_DIR = '<absolute .flotilla/waves/<slug>/verdicts>'

const j = (items) => (items.length ? items : ['none']).map(s => `- ${s}`).join('\n')

// ── Per-row data — Coordinator fills this from the spine before invoking ──
// Each: { id, slug, worker, risk, iteration, model, anchorSha, coordinatorBranch,
//         depsSetup, issueSpec, prTitle, closePhrase, reviewerHints, siblingBranches,
//         iteration1HeadSha? }
// `worker` is copied straight off the row's Plan-Table Worker cell. It is not
// interpolated into any brief — it exists so `assertNotHumanGated` below can
// refuse to compose a row no agent may pick up (see §The human gate).
// `branch` is NOT authored here — it is DERIVED, once, immediately below (see
// its own comment) from `id` + `slug`, the same two fields already in this
// list. Never add a hand-authored `branch:` to a row literal; the derivation
// step overwrites it regardless, and a hand-authored value is exactly the
// "Coordinator sets it, forgets to wire it into the array the driver reads"
// shape this whole assertion exists to make impossible.
// iteration1HeadSha is OPTIONAL and iteration>1-only (a re-dispatch, §Re-dispatch
// above): the iteration-1 Worker's last commit SHA, read off the iteration-1
// WorkerReport's `commitShas` (last entry) — the Coordinator already holds that
// report when composing the re-dispatch (it is the same `report` in the routed
// `{ id, risk, iteration, report, verdict }` tuple). Absent on iteration 1.
const ISSUES = [
  {
    id: 'NN',
    slug: 'short-slug',
    // The row's Plan-Table Worker cell, verbatim. A human-gated value here is a
    // compose-time throw, never a dispatch — the row should have been excluded
    // upstream at start-mechanics.md step 3b (§The human gate, below).
    worker: 'background',          // background | background-heavy | foreground | HITL-required
    risk: 'mechanical',            // mechanical | isolated-refactor | cross-feature-refactor | public-API-change
    iteration: 1,
    // Binds BOTH the Worker (Stage 1) and the Reviewer (Stage 3, ADR-0007
    // Amendment 2026-07-31) — one Risk-derived tier for the whole row.
    model: 'sonnet',               // 'opus' for cross-feature-refactor / public-API-change, else 'sonnet'
    anchorSha: '<COORDINATOR_HEAD_SHA>',   // git rev-parse HEAD at dispatch time — the wave anchor
    coordinatorBranch: 'feat/<slug>',
    // The consumer's own dependency-install command(s) — from the wave-setup
    // preconditions answer for "is the dependency dir gitignored?". Empty
    // string only if the consumer confirmed nothing is gitignored there.
    // COMPOSE IT UNFUSED (wave-shared Convention 13): this string is the FIRST
    // command every Worker and Reviewer runs, so a fused `cd <depsDir> &&
    // <installCmd>` here teaches the shape the briefs' own clause forbids —
    // and hits both mechanisms it names (a permission gate that requires every
    // subcommand of a compound to match a rule independently; a worktree-
    // isolation guard that can reject a fused command as too complex to
    // verify). Prefer the installer's own directory flag, which is also the
    // form that survives a cwd reset between an agent's Bash calls.
    depsSetup: '<consumer dependency-install command, directory carried BY the command, e.g. "npm ci --prefix <depsDir>" / "composer install -d <depsDir>">',
    // The FULL issue spec embedded verbatim — title, body, acceptance criteria,
    // declared Files globs, risk. NOT a tracker id/path: the store config that
    // would resolve one may itself be gitignored and absent from this worktree.
    issueSpec: '<embed title + body + acceptance criteria + Files globs + risk here>',
    // The PR-open inputs the Worker passes to `host-pr create` (the Worker has no
    // wave.config.json in its worktree, so the Coordinator supplies both):
    //   prTitle     — the PR title. Composed WITHOUT any bare tracker id
    //                 (mention discipline, wave-shared Convention 4).
    //   closePhrase — the store-kind close phrase, derived from wave.config.json's
    //                 store.kind: github → 'Closes #<N>', linear → 'Fixes <TEAM-NN>'.
    //                 It is the ONLY tracker id allowed anywhere in the PR title/body.
    prTitle: '<PR title — no bare tracker id>',
    closePhrase: '<Closes #NN | Fixes TEAM-NN — store-kind-derived (Convention 4)>',
    reviewerHints: ['Verify <thing 1>.', 'Confirm <thing 2>.'],
    siblingBranches: '(none — last in-flight issue)',
  },
]

// ── Derive the row's own branch name ONCE (AC5, FOR-139) ──
// Every call site below — the Worker's `git checkout -b`, its `git push
// origin`, its `host-pr create --branch`, and the Reviewer's stated review
// target — reads `issue.branch`; none of them re-interpolates
// `wave/${issue.id}-${issue.slug}` separately. A DERIVED value cannot
// silently diverge from the id/slug it derives from the way a hand-authored
// SECOND field could — which is exactly the shape a live recurrence took: a
// Coordinator set `branch` on its own row objects and never copied it into
// the array the driver reads, so `${issue.branch}` rendered the literal
// string "undefined" at all five of its call sites (the four here plus the
// sibling-branch list every Reviewer uses for merge-tree prediction). Six
// Workers each invented their own branch name rather than create one
// literally called `undefined`; three Reviewers correctly halted at input
// validation; the spine's dispatch log recorded six branches that never
// existed. This formula MUST byte-match the Coordinator's own `spine
// set-branch "$SPINE" "$ID" "wave/$ID-$ROW_SLUG"` call (start-mechanics.md
// step 5) — same id, same slug, same `wave/<id>-<slug>` shape — because
// $ID/$ROW_SLUG there are bound from the SAME roster row that fills
// issue.id/issue.slug here (start-mechanics.md's own note on that line).
// Demonstrably the same value, not merely conventionally the same: both
// read off one roster row, and REQUIRED_ROW_FIELDS below refuses to let
// either half of that row be missing/blank/"undefined".
ISSUES.forEach((issue) => { issue.branch = `wave/${issue.id}-${issue.slug}` })

// ── Compose-time required-field assertion — run BEFORE any agent() fan-out ──
// Generalizes the original W2-F1 fix, which validated ONLY anchorSha: the
// anchor SHA was defined as a constant but never wired into the per-row
// objects, so every brief interpolated the literal string "undefined" as its
// diff base. The IDENTICAL failure recurred one wave-generation later, on
// `branch` instead (see the derivation comment above), with a WIDER blast
// radius. A guard shaped like `assert(oneNamedField)` does not generalize by
// being read; it generalizes by covering the set. REQUIRED_ROW_FIELDS below
// IS that set, named in exactly ONE place a Coordinator can check a composed
// row against — instead of leaving the set to be inferred by reading every
// brief for its `${issue.*}` interpolations (Authoring constraint #7 above).
//
// Deliberately EXCLUDED, with reasons (not merely forgotten):
//   - depsSetup, iteration1HeadSha — legitimately optional; both briefs
//     guard their interpolation with `|| <fallback text>` already.
//   - reviewerHints — an array, not a scalar. An EMPTY array is valid ("no
//     hints yet" — `j()` already renders it as `- none`); a naive
//     string-emptiness check would wrongly reject that valid empty case
//     (`String([]) === ''`), so it is out of scope for this assertion.
//   - iteration — a number compared (`issue.iteration > 1`), not rendered
//     into text on the path that would ever see it; an absent value
//     misroutes to the iteration-1 branch rather than rendering "undefined",
//     a different failure shape from the one this assertion targets.
//   - worker — a DIFFERENT predicate with a DIFFERENT remedy, so it gets its
//     own assertion (assertNotHumanGated, below) rather than a slot here.
//     This list asks "is the field present enough to interpolate?" and its
//     fix is to wire the value in; the worker check asks "may this row be
//     dispatched at all?" and its fix is to REMOVE the row from ISSUES.
//     Folding the two together would let a missing worker read as a pass and
//     a human-gated one read as a wiring bug.
const REQUIRED_ROW_FIELDS = [
  'id', 'slug', 'branch', 'risk', 'model', 'anchorSha', 'coordinatorBranch',
  'issueSpec', 'prTitle', 'closePhrase', 'siblingBranches',
]

// A template renders a missing/undefined property as the LITERAL STRING
// "undefined" — never a thrown error, never a blank interpolation. Both live
// occurrences (W2-F1's anchorSha, and the branch recurrence above) took
// exactly this shape. An absent key is therefore not the only failure shape
// worth rejecting: the literal "undefined" and an empty/whitespace-only
// string are the two others a template can silently produce, and each must
// fail exactly as loud as an absent key.
function isMissingField(value) {
  return (
    value === undefined ||
    value === null ||
    value === 'undefined' ||
    String(value).trim() === ''
  )
}

function assertRequiredRowFields(issue) {
  for (const field of REQUIRED_ROW_FIELDS) {
    if (isMissingField(issue[field])) {
      throw new Error(`wave-start: row ${issue.id} has no valid ${field} (got ${JSON.stringify(issue[field])}) — wire ${field} into ISSUES before dispatch`)
    }
  }
}
ISSUES.forEach(assertRequiredRowFields)

// ── Compose-time HUMAN GATE — also BEFORE any agent() fan-out (§The human gate) ──
// A human-gated Worker means no agent may pick the row up until a human acts
// (ADR-0012). start-mechanics.md step 3b already excludes such a row from ISSUES;
// this is the structural backstop for that exclusion, in the same place and for
// the same reason as the assertion above — an instruction a Coordinator can
// forget becomes a throw the fan-out cannot get past. A held row that reaches
// here has no failure of its own to hit: every brief interpolates fine, the
// Worker runs, and it burns a full agent budget on the one blocker an agent
// cannot clear by construction.
// The default token is the engine's HUMAN_GATED_WORKER (tools/wave/src/wave-md-rw.ts);
// a consumer that re-spelled or trimmed its config-governed Worker vocabulary
// fills its own token(s) in here at compose time, exactly like WAVE_CLI.
const HUMAN_GATED_WORKERS = ['HITL-required']

function assertNotHumanGated(issue) {
  if (HUMAN_GATED_WORKERS.includes(issue.worker)) {
    throw new Error(`wave-start: row ${issue.id} has a human-gated worker (${issue.worker}) and must not be dispatched — hold it in the human lane and remove it from ISSUES`)
  }
}
ISSUES.forEach(assertNotHumanGated)

// The iteration-1 (default) workspace setup — unchanged from before the
// re-dispatch teardown/tracking-free-checkout fix (W26-F1) except for its
// checkout target, which now reads the derived `issue.branch` (FOR-139)
// rather than re-interpolating `wave/${issue.id}-${issue.slug}` inline.
const WORKSPACE_SETUP_ITER1 = (issue) => `## Workspace setup (do first)
1. \`pwd\` — confirm you are in a worktree (not the parent path). **This is the one cwd
   check you need and the only one you can have:** your cwd is reset to this same dispatch
   root before EVERY Bash call you make, so what \`pwd\` prints here is where each step
   below starts — the git commands in step 2, the checkout, the install, every verify
   command, and every Termination step alike. It is a constant you OBSERVE, not state you
   can SET: a \`cd\` in one call is invisible in the next (wave-shared Convention 13,
   §Splitting is not always a preceding \`cd\`), so never issue one to set up a later step,
   and never fuse one onto the command that matters.
2. Anchor to the wave anchor SHA:
   \`\`\`bash
   git fetch origin ${issue.coordinatorBranch} 2>&1 | tail -3
   git reset --hard ${issue.anchorSha}
   git status --porcelain      # MUST be empty
   git rev-parse HEAD          # MUST equal ${issue.anchorSha}
   \`\`\`
3. \`git checkout -b ${issue.branch}\`
4. Install dependencies. A worktree checkout carries **tracked files only** — if
   this consumer's dependency directory is gitignored (the ordinary case for a
   lockfile-managed tree), it is **absent here, not merely un-installed**, and
   the verify gate below cannot run at all — and, wherever this consumer's
   configured \`engine.cli\` binding resolves through that same directory (the
   ordinary case: a pinned local binary), the terminator's engine CLI call (see
   Termination step 3) has nothing to resolve either — without this step first:
   \`\`\`bash
   ${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
   \`\`\``

// The iteration≥2 (re-dispatch) workspace setup (W26-F1, §Re-dispatch above):
// the wave branch ALREADY EXISTS, carrying the iteration-1 commits — this
// worker continues on it, it does not re-anchor to anchorSha and branch fresh.
// The checkout is TRACKING-FREE (fetch + checkout -B against FETCH_HEAD, or the
// explicit iteration-1 head SHA) so it never writes upstream-tracking into the
// shared .git/config of the main repo (sandbox-write-denied for a worktree-
// isolated agent — a tracking checkout half-applies and strands the switch).
// The Coordinator has already deregistered the iteration-1 worktree that held
// this branch (start-mechanics.md step 7d), so the checkout below is never
// blocked by a stale `git worktree` registration.
const WORKSPACE_SETUP_REDISPATCH = (issue) => `## Workspace setup (do first) — RE-DISPATCH, iteration ${issue.iteration}
1. \`pwd\` — confirm you are in a worktree (not the parent path). **This is the one cwd
   check you need and the only one you can have:** your cwd is reset to this same dispatch
   root before EVERY Bash call you make, so what \`pwd\` prints here is where each step
   below starts — the fetch and checkout in step 2, the install, every verify command, and
   every Termination step alike. It is a constant you OBSERVE, not state you can SET: a
   \`cd\` in one call is invisible in the next (wave-shared Convention 13, §Splitting is
   not always a preceding \`cd\`), so never issue one to set up a later step, and never
   fuse one onto the command that matters.
2. This is a re-dispatch: \`${issue.branch}\` ALREADY EXISTS,
   carrying your iteration-1 commits — do not discard them, do not re-anchor to
   the wave anchor SHA and branch fresh. Land on the existing branch with a
   TRACKING-FREE checkout — never \`git checkout -B <branch> origin/<branch>\`,
   which writes upstream-tracking into the SHARED .git/config of the MAIN repo
   (sandbox-write-denied for a worktree-isolated agent; that form half-applies
   and strands the switch mid-way — live occurrence W26-F1, recovered only by
   hand via \`git symbolic-ref\`):
   \`\`\`bash
   git fetch origin ${issue.branch} 2>&1 | tail -3
   git checkout -B ${issue.branch} FETCH_HEAD
   git status --porcelain      # MUST be empty
   git rev-parse HEAD          # MUST equal ${issue.iteration1HeadSha || 'the fetched branch tip (see step 2)'}
   \`\`\`
   (The Coordinator already deregistered the iteration-1 worktree that held
   this branch before this dispatch — start-mechanics.md step 7d — so this
   checkout is never blocked by a stale worktree registration.)
3. Install dependencies. A worktree checkout carries **tracked files only** — if
   this consumer's dependency directory is gitignored (the ordinary case for a
   lockfile-managed tree), it is **absent here, not merely un-installed**, and
   the verify gate below cannot run at all — and, wherever this consumer's
   configured \`engine.cli\` binding resolves through that same directory (the
   ordinary case: a pinned local binary), the terminator's engine CLI call (see
   Termination step 3) has nothing to resolve either — without this step first:
   \`\`\`bash
   ${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
   \`\`\``

function workerBrief(issue) {
  const workspaceSetup = issue.iteration > 1
    ? WORKSPACE_SETUP_REDISPATCH(issue)
    : WORKSPACE_SETUP_ITER1(issue)

  return `You are a Wave Worker executing issue #${issue.id} in an isolated worktree.

${workspaceSetup}

## Task spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so the complete issue spec — title, body,
acceptance criteria, declared Files globs, risk — is embedded below rather than
pointed at by id. Implement it fully, satisfying every acceptance criterion, and
stay strictly within the declared Files globs.

${issue.issueSpec}

## Policy clauses (obey verbatim)
1. AC-vs-repo-policy conflict: repo policy wins; flag under Judgment calls.
2. Commit policy: new commits only — never \`git commit --amend\` on a pushed commit.
3. PR-only: push your branch + open a PR; NEVER push to the protected default branch.
4. Conflict-marker check before committing:
   \`\`\`bash
   git diff --cached --name-only | xargs -I{} grep -l '^<<<<<<<\\|^>>>>>>>\\|^=======$' {} 2>/dev/null | head
   \`\`\`
5. SECRET-SAFE: never echo any environment variable's VALUE — not even with fallback syntax like \${VAR:-no}. Never run whole-environment dumps (\`printenv\`, \`env\`, bare \`set\`). Never read a gitignored settings/secret file (e.g. \`cat .claude/settings.local.json\`, any \`.env\`-class file) — not even "to check config". Check availability value-free only: \`[ -n "$GITHUB_TOKEN" ] && echo set\`. Tool output must never contain a secret. **AS A WORKTREE-ISOLATED ROLE, YOU DO NOT RUN THIS PRESENCE TEST AT ALL — sanctioned form or not.** The Coordinator's own value-free credential-probe preflight already proved every configured credential resolves, once, before you were dispatched — there is nothing left here for you to check. If a credential nonetheless fails to resolve mid-slice, the call that needed it (\`host-pr create\`, Termination step 3) returns a typed error; report that as \`blocked\`, never pre-empt it with a presence check of your own (wave-shared Convention 8's isolated-role rule — the same worktree-isolation guard policy clause 11 names has rejected this exact sanctioned form, live, when a worktree-isolated role ran it).
6. MENTION DISCIPLINE: the PR title and body must not contain ANY bare tracker id except the single close phrase (\`${issue.closePhrase}\`, Termination step 3 below) — reference ADR numbers or doc slugs instead.
7. WIRING DISCLOSURE (wave-shared Convention 9): if your slice introduces a new verb, subcommand, or exported interface, name the consuming call-site(s) that now invoke it in your report — or explicitly disclose under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`) that the wiring lies outside your declared Files globs, so the Coordinator can grant a scope extension or plan the wiring before the review round.
8. RUNTIME RESIDUE (wave-shared Convention 10): if your slice starts any runtime resource — a compose project, a container, a background server, anything holding a port, a volume, or a network — tear it down before termination, or explicitly disclose the surviving resource under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`) so the Coordinator can clean up after landing.
9. PROVE THE CHECK CAN FAIL (wave-shared Convention 11): if your slice introduces a NEW check — a test, an assertion, a guard, a smoke probe, a lint rule, a CI gate, a preflight, a validator — break the thing that check exists to catch, run the check, and observe its own FAIL state; then restore the original state and re-verify green. Report the falsification under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`): which check, what you broke, the observed failing output verbatim, and that you restored it. A green check is compatible with "the check works" AND "the check cannot fail", and no acceptance criterion distinguishes them. Two mechanical questions decide whether you are in this class — does a pass/fail check exist after your diff, and is its failing condition new with this slice — and "is the falsification worth the time" is deliberately NOT one of them: an expensive falsification belongs in the disclosure, not outside the class. A check observed only as \`deferred\`/\`skipped\` has NOT been proven to fail (it has been proven not to run) — that is a failed falsification attempt, not a demonstration. If you could not falsify it, say so in the same channel with the reason and what input WOULD falsify it — "could not falsify, and here is why" is a legitimate reported outcome; silence and an unevidenced claim are not. A slice that only changes behaviour already covered by EXISTING checks is not in this class.
10. UNEXECUTABLE CORE PATH — DECLARE, THEN SELF-COMPARE (ADR-0030): if the core path of your change **cannot be executed from this environment** — it needs a real release, a production credential, a merged PR, a human action, an external service you cannot reach — declare it explicitly under \`judgmentCalls\` (mirrored in \`reviewerFocusItems\`), naming WHICH path is unreachable and WHY. Then find the authoritative documented form for that mechanism — the vendor's own documentation, the spec, the reference example — **read it in this dispatch, do not recall it from memory** — compare your change against it, and report EVERY divergence in the same channel, each marked deliberate (you departed on purpose AND commented the reason at the point of departure) or not. A divergence is NOT automatically a defect: deliberate, commented departures are legitimate and must survive review intact. What is not legitimate is an undeclared one. Live occurrence: a release workflow shipped with three divergences from the registry vendor's documented example — a missing \`registry-url\`, dependency caching left on in a release build (which the vendor advises against on supply-chain grounds), and an outdated action version. Every acceptance criterion was verified and every one held; the core path (an OIDC credential exchange that cannot run before a real release exists) was reachable by no test, no local run and no reviewer, so the documented form was the only evidence available — and no acceptance criterion asked for it, because ACs describe what a change should DO and this is a question about what it should LOOK LIKE. Your self-comparison is defense-in-depth; the Reviewer runs its own comparison independently, and that one is the anchor.
11. ONE BASH CALL PER STEP (wave-shared Convention 13): never fuse a setup step onto the command that matters — \`cd X && <command>\` — into one compound Bash call. **Two unrelated mechanisms break on that shape, with opposite signatures, and knowing only one of them is how the other bites.** (a) **The permission gate.** The harness splits a command on \`&&\`, \`||\`, \`;\`, \`|\`, \`|&\`, \`&\` and newlines and requires EVERY subcommand to match a permission rule independently — so the tracked-allowlist entry covering your engine or verify call carries only THAT subcommand past the gate, never the \`cd\` glued in front of it; and \`cd\` paired with \`git\`, or with an output redirect, prompts even when both halves are read-only commands. A permission dialog mid-AFK-dispatch has nobody to answer it and stalls your row. (b) **The worktree-isolation guard.** A fused command can come back REJECTED as too complex to verify that it stays inside your worktree — no dialog, nothing pending, nothing run. That refusal is about the command's SHAPE, never about the check being unrunnable here: re-issue it as separate calls. **NEVER silently skip a step because its fused form was refused** — a Worker did exactly that, dropping the check it was running and continuing; a verification step that did not run, in a report that reads as complete, is the defect (same family as Convention 12's empty capture). And do not "fix" either mechanism by asking for a \`cd\` allowlist entry — splitting costs nothing, and mechanism (b) would reject the fused form regardless. **Carry the directory IN the command wherever a flag exists** (\`npm ci --prefix <dir>\`, \`git -C <dir> …\`, \`--root\`/\`--cwd\`): your cwd is reset to your dispatch root before every Bash call, so a \`cd\` issued as its own call does NOT reach the next one — splitting a fused \`cd X && <cmd>\` into two calls leaves the command running in the wrong directory, which is a quieter defect than the fusion was. Your workspace-setup \`pwd\` is the one cwd fact you have, it holds for every call, and you never buy anything back by re-fusing. **Mechanism (b) is not limited to \`&&\`, and most refusals are not fusion at all.** Three shapes have been live-reproduced as refused with nothing fused onto them: a bare \`case\`/\`esac\`; an \`if\`-guard testing a shell variable; and any other command naming a shell variable, including a lone \`test -n "$VAR"\` — whether that variable was set in an earlier Bash call or in the same one. **The discriminator is the \`$VAR\` expansion, not the punctuation**, so "split it" is not a general remedy and re-fusing is not either. Your cwd and every shell variable are reset between your Bash calls regardless, which is why a value must never be carried from one call to the next: re-query its source in the call that needs it (your own Termination step 4 below does exactly that, via \`host-pr status\`), or use a single command whose exit status is the answer. Before re-deriving a fix by hand, read the "Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch" section in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\` — entry 1's evidence arc records three remedies that looked right and could not run, so you do not re-adopt one of them.

## Verification gates (run the consumer's verify profile — from wave.config.json verify)
Run the commands the VerifyGate selects for your changed files; report exact counts.
**Carry the directory IN each command** — \`npm test --prefix <dir>\`, \`npx vitest run --root <dir>\`, \`git -C <dir> …\` — because every one of these calls starts at the dispatch root your workspace-setup \`pwd\` printed, never wherever a previous call ended up. A verify command written as \`cd <dir> && <cmd>\` is two faults at once: a fusion (policy clause 11, both mechanisms) AND a cwd-persistence assumption — and re-issuing it as \`cd <dir>\` then \`<cmd>\` in two calls fixes neither, because the second call starts back at the dispatch root and runs the gate in the wrong directory (live: a \`cd <worktree>/tools/wave\` returned success and the very next call's \`npm ci\` still ran at the worktree root). If the consumer's profile hands you a fused or \`cd\`-prefixed command, run its flag-carrying equivalent and say so in your report — but never drop a gate because its literal form was refused, and never report a count for a command that did not run.

## Termination
1. Commit all work in one commit.
2. \`git push origin ${issue.branch}\` (never \`-u\`, never to default).
3. Open the PR **through the engine — never \`gh pr create\`** (\`gh\`'s creds are sandbox-denied and its TLS fought the proxy in every live run; this verb uses the same \`fetch\` path the landing verbs do). Find-before-create is idempotent: a PR already open on this branch (e.g. a cap=1 re-dispatch onto the same branch) is **reused, never duplicated — and its title/body are re-written to the \`--title\`/\`--body\` you pass** (\`updated: true\` in the JSON discloses it), so the body you compose reliably lands on the live PR (last-writer-wins). Compose a PR body whose last line is the store-kind close phrase, then run:
   \`\`\`bash
   # WAVE_CLI carries this consumer's configured engine.cli binding, which the
   # config layer validated as repo-relative — so it resolves from this
   # worktree's own root: a worktree checkout is a full copy of tracked files,
   # and step 4 above (depsSetup) already installed whatever binary the binding
   # resolves through. That root is where THIS call starts too, because every
   # Bash call of yours starts there (workspace setup step 1) — not because an
   # earlier call left you in it. Do not prefix a cd; there is nothing to set up.
   ${WAVE_CLI} host-pr create \\
     --branch ${issue.branch} \\
     --title "${issue.prTitle}" \\
     --body "<one-paragraph summary of what you changed>

${issue.closePhrase}"
   # exit 0 → stdout is one JSON object; its .url (outcome: created | reused) is your prUrl.
   #
   # exit NON-ZERO → READ .outcome IN THAT SAME JSON BEFORE DOING ANYTHING ELSE.
   # This is not a case step 4 papers over — see "PR-open reuse-refusal" earlier
   # in this document.
   #   outcome create-failed → the create attempt itself failed; .fallbackPrefillUrl
   #     is the manual-open fallback. Report blocked.
   #   outcome reuse-refused → the close-phrase guard stopped a REWRITE: the body
   #     you just passed above is missing ${issue.closePhrase} (re-read it — the
   #     guard checks the body YOU pass, never the live one). .url still names
   #     the branch's existing PR, but the refusal made NO write at all — the PR
   #     is exactly as it was before this call, and that URL is not evidence
   #     anything landed. Never reach for --allow-close-phrase-loss to get past
   #     this: it deliberately discards the close phrase, the one outcome this
   #     guard exists to stop, and your composed body above is supposed to carry
   #     it already. Fix the body so it genuinely carries the close phrase and
   #     re-run create (idempotent, find-before-create); if it refuses again,
   #     report blocked with the printed .reason — never let step 4's re-query
   #     of that same URL read as success for a rewrite that never happened.
   \`\`\`
   The body MUST carry the close phrase \`${issue.closePhrase}\` on its own line (wave-shared Convention 4 — reads GITHUB_TOKEN from your env, never printed), and that is the **only** tracker id the title or body may name (mention discipline, policy clause 6): do not reference any other issue id anywhere.

   Run that command **bare** — no \`|\`, no \`$( )\`, no assignment. Its JSON lands in your tool output, where you can read it; you do not need it in a shell variable, and step 4 explains why you must not put it in one.
4. **Confirm the PR by asking the HOST, in a separate Bash call — never by carrying a value from step 3** (wave-shared Convention 12, half two). Reporting an empty/absent \`prUrl\` on a \`done\` outcome is the live failure this step exists to stop: the Reviewer skips its PR-body check ("PR is not yet opened"), the Coordinator's terminator reads it as "no PR exists" and opens a duplicate, and the spine records nothing. **The confirmation is a re-query, not a guard on a capture**, because in your dispatch a guard on a capture cannot run at all:
   \`\`\`bash
   ${WAVE_CLI} host-pr status --branch ${issue.branch}
   # → { ok, verb, host, branch, state: open|merged|closed-unmerged|none, url?, prUrl? }
   \`\`\`
   Read the answer off that JSON:
   - \`state\` is \`open\` (or \`merged\`/\`closed-unmerged\`) **and** \`url\` is present → the PR exists and the host says so. **That \`url\` is your prUrl — carry it into your Report verbatim (see below).**
   - \`state\` is \`none\`, or no \`url\` came back → **no PR was created.** Step 3 did not do what it looked like it did. Re-run \`host-pr create\` (it is find-before-create, so re-running is safe and never duplicates) and re-query; if it still reports \`none\`, report \`blocked\` with what the two calls printed.

   **This step confirms the PR EXISTS — it is not, on its own, proof that step 3's rewrite landed as intended.** A \`reuse-refused\` outcome at step 3 makes NO write, so of course the PR is still there and this re-query still finds it — that is expected, not evidence of success. If step 3 returned a non-zero exit or \`outcome: reuse-refused\`, this step's \`state: open\`/\`url\`-present answer does not override that: carry step 3's own outcome forward (see its comment above), never let this step's mere confirmation that a PR exists stand in for "my rewrite succeeded."

   Never report \`outcome: done\` with a missing, empty, \`null\`, or \`undefined\` \`prUrl\`. An honest \`blocked\` is a correct answer; a \`done\` carrying an empty URL is not.

   **Why a re-query and not a capture guard — read this before you improvise a shorter form.** Three earlier versions of this step prescribed a capture plus a guard, and all three were unrunnable from a worktree-isolated dispatch. \`case\`/\`esac\` is refused standing alone. Splitting the capture into call 1 and the guard into call 2 fails twice over: shell state does not survive between your Bash calls, so the guard would inspect an unset variable — and the isolation check refuses that guard call outright for naming a variable it cannot resolve. Fusing them back into one call is refused too. The discriminator is not fusion and not the control structure: it is the **\`$VAR\` expansion**, refused in any position, in any call. The full station-by-station reproduction is Catalog entry 1 in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\`. \`host-pr status\` sidesteps every one of them by carrying nothing across a call boundary — the host is asked again, and answers again.

   If you need the URL on disk rather than in your tool output, redirect the re-query to a relative-path file in your worktree — it lands in your dispatch root, which is where the reading call starts too — and read it back with a **single command whose exit status is the verdict** — still no shell variable: \`${WAVE_CLI} host-pr status --branch ${issue.branch} > pr-status.json\` in one call, then \`jq -e -r '.url' pr-status.json\` in the next (it exits non-zero when \`.url\` is absent or null). Delete the file before you commit. \`jq\` carries its own tracked allow entry (\`Bash(jq -e -r '.url':*)\`, issue #345) — this fallback no longer risks an un-allowlisted mid-AFK permission prompt on the one command in this step that never had a citation; see setup-mechanics.md's AFK harness config scaffold for the entry and its rationale.

## Report — emit as your FINAL message, matching the WorkerReport schema:
outcome, issue, branch, worktree, commitShas, prUrl, filesChanged{new,modified,renamed},
tests, lint, conflictMarkers, judgmentCalls[], reviewerFocusItems[].

**\`issue\` MUST be the BARE opaque tracker id — exactly \`${issue.id}\`, and nothing else.**
Not \`#${issue.id}\`, not \`${issue.id} — <the issue title>\`, not a URL, not a branch name.
That field is the key your own durable record is filed and resolved under: a row id is
OPAQUE (ADR-0001), which means the reader never parses it — it matches it LITERALLY. A
decorated value is the one field on this report that can make your finished work
unfindable, and it fails in the quietest way available: the file exists, an \`ls\` shows
it, and a resume asking for row \`${issue.id}\` gets nothing back. Live occurrence: three
of six Workers in one wave decorated this field; two records landed under a name nothing
could resolve, and the third was not written at all.

**On \`done\`/\`done-with-concerns\`, \`prUrl\` MUST be exactly the \`url\` value Termination
step 4's \`host-pr status\` re-query answered — never omitted, never re-typed from memory,
never left blank because you already saw it once during Termination.** There is no other
legitimate source for this field and no legitimate reason for it to be absent on these two
outcomes. Live occurrence (the W3-F2 recurrence class): two Workers in consecutive waves
ran the fresh re-query correctly, read a \`url\` back, and then wrote a \`done\` report with
\`prUrl\` absent anyway — step 4 told them how to CONFIRM the PR, not, explicitly enough,
how to CARRY that value into THIS field of THIS report. State it here, as the one place it
counts: the value is that re-query's \`url\`, verbatim, or the report is not \`done\`.

## Reviewer-handoff hints (from Coordinator)
${j(issue.reviewerHints)}`
}

// reviewerBrief only ever reads `issue.anchorSha` / `issue.branch` off the same
// ISSUES row object assertRequiredRowFields already validated — including on a
// re-dispatch (cap=1 Worker re-run, or the bad-anchor Reviewer-only recovery
// below): there is no second code path that could re-derive or re-interpolate
// an unasserted anchor or branch.
function reviewerBrief(issue, report) {
  return `You are the Wave Reviewer for issue #${issue.id} (${issue.slug}).

## What to review
Branch: \`${issue.branch}\`
Risk class: \`${issue.risk}\`   (dispatch is universal — Risk does NOT gate whether you run)
Wave anchor SHA (diff base — NOT main): \`${issue.anchorSha}\`
Sibling in-flight branches: ${issue.siblingBranches}

## Workspace setup (do first)
Your own worktree also carries **tracked files only**. If this consumer's
dependency directory is gitignored, it is absent here too, and you cannot
re-run the verify commands below without installing first:
\`\`\`bash
${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
\`\`\`

**ONE BASH CALL PER STEP** (wave-shared Convention 13) — it binds you exactly as it binds the Worker, and this install is the first place it bites. Never fuse a setup step onto the command that matters (\`cd X && <command>\`) into one compound Bash call. Two unrelated mechanisms break on that shape, with opposite signatures: **the permission gate** splits a command on \`&&\`/\`||\`/\`;\`/\`|\`/\`&\`/newlines and requires EVERY subcommand to match a rule independently — so an allowlisted verify command carries only itself past the gate, never the \`cd\` in front of it, and a dialog mid-dispatch has nobody to answer it; and **the worktree-isolation guard** can REJECT a fused command as too complex to verify that it stays inside your worktree — no dialog, nothing run. A refusal is about the command's SHAPE, not about the check: re-issue it as separate calls. **NEVER drop a verify command or a floor check because its fused form was refused** — reporting a check as run when it was skipped is the exact failure this clause exists to stop, and it is yours to avoid as well as to catch in the Worker's evidence. Your cwd is reset to your dispatch root before every one of your Bash calls, so one \`pwd\` characterizes all of them and a preceding \`cd\` characterizes none: carry the directory in the command where a flag exists (\`npm ci --prefix <dir>\`, \`git -C <dir> …\`, \`--root\`/\`--cwd\`) rather than trusting a \`cd\` to reach the next call. **A bare newline joining two statements in one call is the same shape as \`&&\`, just quieter — and most refusals are not fusion at all:** \`case\`/\`esac\` has been observed refused standing entirely alone, and so has any command naming a **shell variable** — an \`if\`-guard on one, or a lone \`test -n "$VAR"\` — whether the variable was set in an earlier Bash call or in the same one. Shell state does not survive between your Bash calls either, so a value must be re-queried in the call that needs it rather than carried. Before re-deriving a split by hand, check the "Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch" section in \`wave-shared/reference/convention-13-one-bash-call-per-step.md\` for what was actually verified — entry 1's evidence arc records three remedies that looked right and could not run. When reviewing a Worker's evidence for THIS convention, treat a Worker's own citation of that catalog as legitimate rather than a shortcut — including a Worker reporting it COULD NOT verify a working form for a cataloged shape (the catalog's own heredoc-spec-append entry is exactly that outcome, honestly reported rather than guessed). **And check what the Worker's PR evidence rests on:** its Termination step now confirms the PR with a \`host-pr status --branch\` re-query, so a report whose \`prUrl\` traces back to a shell-variable capture is following a recipe the brief no longer carries.

**SECRET-SAFE** (wave-shared Convention 8): never echo any environment variable's VALUE — not even with fallback syntax like \${VAR:-no}. Never run whole-environment dumps (\`printenv\`, \`env\`, bare \`set\`). Never read a gitignored settings/secret file (e.g. \`cat .claude/settings.local.json\`, any \`.env\`-class file) — not even "to check config". Tool output must never contain a secret. **YOU DO NOT PROBE, EITHER** (wave-shared Convention 8's isolated-role rule): you never check whether a credential is set — sanctioned presence-test form or not. The Coordinator's own value-free credential-probe preflight already proved every configured credential resolves, once, before this row was dispatched, so there is nothing left here for you to check. **This is a policy rule, not a guard-driven one — say so precisely, per the measured posture (wave-shared Convention 13's Catalog entry 1):** unlike the Worker, whose \`agent()\` call sets \`isolation: 'worktree'\` explicitly (Stage 1), your own \`agent()\` call carries no \`isolation\` key at all (Stage 3) — the worktree-isolation guard's command-complexity refusal is established from the Worker's dispatch, not from yours. That sanctioned form (\`[ -n "$VAR" ] && echo set\`) is exactly the command the guard has rejected outright, live, when a Worker ran it (policy clause 11 above) — but that refusal is not established for your own dispatch, so the reason you skip this check is the policy rule itself, never a guard you are relying on to reject the form here. Nothing in your own review touches a credential regardless: you never call \`host-pr\` and never read a secret.

## Original issue spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so you cannot look the issue up yourself
either — the full spec (title, body, acceptance criteria, declared Files
globs, risk) is embedded below; use it for the per-AC verification.

${issue.issueSpec}

## Worker Report digest
Outcome: ${report.outcome}
Commit SHAs: ${report.commitShas.join(', ')}
PR URL: ${report.prUrl || '<pending>'}
Tests: ${report.tests}
Lint: ${report.lint}
Conflict markers: ${report.conflictMarkers || 'clean'}
Judgment calls:
${j(report.judgmentCalls)}
Reviewer focus items (Worker-appended):
${j(report.reviewerFocusItems)}

## Your checks
Run the wave-reviewer contract (see .claude/agents/wave-reviewer.md): re-run the verify
commands + the floor checks against \`${issue.anchorSha}..${issue.branch}\`,
per-AC met/partial/not-met with evidence (against the embedded spec above), sibling
merge-tree prediction.

**If this slice ships a NEW check** — a test, an assertion, a guard, a smoke probe, a
lint rule, a CI gate, a preflight, a validator — the Worker owed a falsification note
(wave-shared Convention 11): which check, what was broken, the observed failing output,
and confirmation that the original state was restored. It arrives in the Judgment calls /
Reviewer focus items above. Read it and check it against the diff. Two things it is not:
a note that reports only a green check has not falsified anything, and a check observed
only as \`deferred\`/\`skipped\` has been proven not to run, not proven able to fail.
An explicit "could not falsify, and here is why" is a legitimate Worker outcome — treat
it as a disclosure to carry forward, never as a defect to request changes over. Its
TOTAL absence on a slice that ships a new check is a finding: say so under
\`reviewerFocusItems\` rather than filling the gap silently yourself. And an AC phrased
as an outcome ("the check exists", "the guard is enforced") earns \`met\` only on
outcome-exercising evidence — the Worker's falsification, or your own probe.

**If this row's core path cannot be executed from your review environment**, the
DOCUMENTED-FORM COMPARISON is required (ADR-0030, agent contract Check 6). Three
raisers, any one of which fires it and none of which is a precondition: the ACs
covering that path landed \`deferred\`; an issue AC asked for the comparison; or the
Worker declared the unexecutable path above. Identify the authoritative documented
form for the mechanism (vendor documentation, spec), **read it yourself in this
dispatch**, compare the change on the branch against it, and report EVERY divergence
via the \`documentedFormComparison\` field — each marked \`deliberate\` (a commented
departure) or not. It is its own reported outcome: never fold it into
\`acVerification[]\`, and never flip the verdict on a divergence alone. \`sources\`
must name what YOU read — a comparison whose only source is the Worker's report is
invalid, and the schema rejects an empty \`sources\` at this boundary.

## Evidence discipline (mention footgun — wave-shared Convention 4)
Your \`acVerification[].evidence\` and \`reviewerFocusItems[]\` are folded verbatim into
the PR body at the terminator. On a tracker with a native GitHub integration, every bare
tracker id there is linkable and actable — a stray sibling id closes/links the wrong row.
**Reference ADR numbers or doc slugs (\`ADR-0024\`, \`2026-07-19-hardening-w6\`), never a
foreign tracker id, when you name related work.** The row's own id (\`${issue.id}\`, the
close target) is the one id that belongs there. The engine's render-side scrub neutralizes
any other id-shaped token as a structural backstop — treat that as a safety net, not a
license to reach for a bare id.

Return a JSON object matching the ReviewerVerdict schema:
verdict, branchReviewed, riskClass, workerReportDigest, acVerification[], reviewerFocusItems[]
— plus documentedFormComparison{trigger, sources[], divergences[]} whenever a trigger fired.`
}

// ── Scribe: persist ONE sidecar at agent-return through the paired write verb ──
// The brief carries the already-validated payload byte-exact (JSON.stringify) —
// nothing is re-typed. The Scribe writes it to a temp file VERBATIM, runs the
// engine verb (engine-computed <id>-<iter>.md name, fenced json, mkdir -p,
// last-writer-wins), retries once on a non-zero exit, and returns { ok, path }.
function scribeBrief(kind, issue, iter, payload) {
  const dir = kind === 'report' ? REPORTS_DIR : VERDICTS_DIR
  const verb = kind === 'report' ? 'write-report' : 'write-verdict'
  return `You are a Wave Scribe. Persist one ${kind} sidecar THROUGH THE ENGINE — do not reformat, re-type, or "fix" anything in the payload.

**\`--id\` IS NOT YOURS TO VARY.** It is fixed below as \`${issue.id}\` — the compose-time
row id, straight off the wave spine — and it alone decides which row this sidecar is filed
under. If the verb refuses, the refusal IS the answer: report it and let the Coordinator's
routing-time recovery handle it. Do NOT re-run with a different \`--id\` — not the payload's
own id field, not a decorated form, not anything you derived. A varied \`--id\` does not
rescue the write; it files a real, well-formed record under a name the reader can never
resolve for row \`${issue.id}\` — present to an \`ls\`, absent to a resume, silent both ways.
That substitution, made once as a reasonable-looking workaround after a refusal, is the
whole reason this clause exists. (The engine now refuses a decorated \`--id\` outright with
exit 2, so the workaround fails loudly instead of half-working — do not go hunting for a
spelling that gets past it. A decorated id in the PAYLOAD is a different matter: the verb
normalizes that one itself and tells you it did.)

1. **Read your working directory — one bare \`pwd\`, as its own Bash call, and never a \`cd\`.**
   Expected output, exactly: \`${REPO_ROOT}\` (the compose-time absolute repo root).
   Your cwd is **reset to your dispatch root before every Bash call you make**, so it is a
   constant you OBSERVE, not state you can SET: this one \`pwd\` characterizes step 3 as
   surely as it characterizes this step, and nothing you run here can change what step 3
   starts in. That is also why the retired form of this step — \`cd "${REPO_ROOT}"\` as
   call 1, the engine call as call 3 — is a DEAD END and must not be re-added: it never
   reached step 3 (it only ever looked like it did, because the dispatch root already was
   the repo root), and fusing it onto step 3 so that it would reach is refused twice over
   (wave-shared Convention 13, both mechanisms — the standing rule for every dispatched
   role). The permission gate splits a command on \`&&\`/\`||\`/\`;\`/\`|\`/\`&\`/newlines and
   requires EVERY subcommand to match a rule independently — the tracked
   \`.claude/settings.json\` allowlist covers the WAVE_CLI invocation exactly, but that
   entry covers only THAT subcommand and never a \`cd\` fused in front of it, so the fused
   form can raise a permission dialog mid-AFK-dispatch with nobody there to answer it
   (same class as the \`env -u ... gh\` wrapper footgun that defeats a \`gh *\` allowlist
   prefix, wave-shared Convention 1's KW-F6 sandbox-footgun note — now observed on our
   own allowlist); and the worktree-isolation guard can REJECT a fused command outright as
   too complex to verify, with no dialog and nothing run.
   **If \`pwd\` prints anything else:** do NOT \`cd\`, do NOT vary the command, and do NOT
   skip the write — every path argument in step 3 is absolute, so the only cwd-sensitive
   part left is the WAVE_CLI binding itself. Run step 3 anyway and report the mismatch
   verbatim: in \`notice\` (prefixed \`cwd-mismatch:\`) if the verb still exits 0, in
   \`error\` if it does not. A repo-relative binding fails loud there and writes nothing;
   a path-free one may quietly succeed against a DIFFERENT engine copy than this repo's,
   and your \`notice\` is then the only trace it happened. Either way the fix is the
   Coordinator's precondition — dispatch the wave from the repo root — never a workaround
   of yours.
2. Write the payload below — the single line that follows this paragraph — EXACTLY,
   byte-for-byte (no edits), to this ABSOLUTE path, spelled here shell-quoted exactly
   as step 3 spells it:
   \`"${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json"\`
   ABSOLUTE because the verb reads that argument against the process cwd, so a bare
   relative name would put back into step 3 exactly the dependency step 1 exists to
   retire. QUOTED because an absolute repo root is precisely where spaces and non-ASCII
   characters live — this repo's own checkout path carries both a space and a
   typographic en-dash — and an unquoted path argument breaks on one; every shell
   position this path reaches therefore keeps its quotes, the payload file no less than
   the sidecar \`--dir\`. Prefer your file-writing TOOL over a shell heredoc: it takes
   the path directly — WITHOUT those quotes, which are the shell spelling and not part
   of the filename — creates the parent directory, and involves no shell at all, which
   also sidesteps the heredoc-to-file-with-braces shape Convention 13's Catalog records
   as refused (and every JSON payload carries braces by construction). If you do use a
   heredoc, its redirect target is that same path, quoted —
   \`cat > "${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json" <<'EOF'\` — and
   the directory must already exist, from an equally quoted
   \`mkdir -p "${REPO_ROOT}/.flotilla/tmp"\` in its own prior call. The name is
   deterministic, so a retry overwrites rather than accumulates.

   **The heredoc alternative is measured, not merely asserted.** The
   three write shapes on record for an echo-guard false positive on this exact
   write path — a quoted heredoc (the fallback form above), an inline node-eval
   string literal, and a tee-fed heredoc — were re-run against the CURRENT
   \`tools/wave/hooks/echo-guard.cjs\` with a guarded-pattern payload (a sidecar
   whose own evidence text quotes the guard's dump-word examples — \`$(printenv)\`,
   \`\`printenv\`\` — as prose, mirroring the live #347 trigger). All three passed
   unmodified: the guard's quote-nesting fix and its quoted-heredoc-body
   inertness fix (both documented in Convention 8) together clear every one of
   them for this payload class, and each write also verified byte-exact once
   allowed through. The pre-settled decision rule for this measurement (if any
   shape still blocked, the payload write would become unconditionally
   file-first for the guarded-pattern class, with the heredoc alternative
   removed) therefore does not fire — the prefer-file-first text above stays
   exactly as written, and this paragraph is where the measurement is recorded,
   per that rule. A negative control (the identical payload through an
   UNQUOTED heredoc delimiter, where the guard's quoted-body inertness fix does
   NOT apply) was blocked as expected, confirming the harness can observe a
   block and the all-pass result above is not an artifact of a check that
   cannot fail.
${JSON.stringify(payload)}
3. As a SEPARATE Bash call — its text starting EXACTLY with the WAVE_CLI form,
   so it matches the allowlist prefix from token one — run:
   ${WAVE_CLI} ${verb} "${REPO_ROOT}/.flotilla/tmp/${kind}-${issue.id}-${iter}.json" --dir "${dir}" --id ${issue.id} --iter ${iter}
   (exit 0 → the absolute written path is printed on stdout; exit 1 → invalid payload, or a payload naming a DIFFERENT row than --id; exit 2 → usage/unreadable, or a --id that is not a bare id)
   Every path in that command is absolute and shell-quoted; nothing in it depends on a
   previous call having moved you anywhere.
4. If the exit code is non-zero, retry the SAME command ONCE, BYTE-IDENTICAL — same --id, same --dir, same --iter. If it fails again, report the failure; never vary an argument to buy a zero.
Return { ok: <true iff the verb exited 0>, path: <the absolute path it printed, or ''>, error: <stderr, only on failure — and the step-1 cwd mismatch too, if there was one>, notice: <on an EXIT-0 run only: any \`notice:\` or \`warning:\` line the verb printed, verbatim, plus a \`cwd-mismatch:\` line if step 1 found one — a normalized decoration, a misnamed leftover in the sidecar dir, or a write made from the wrong cwd is a finding the Coordinator must see, and an exit-0 run is exactly where it would otherwise be dropped> }.`
}

// The stage wrapper ALWAYS returns `passthrough` — a throw here would drop the
// row to null (→ a spurious worker-failed STOP that discards finished work). A
// Scribe failure is logged loud; the Coordinator's routing-time existence check
// (SKILL.md step 7) writes any missing sidecar through the same verb.
async function scribe(kind, issue, iter, payload, passthrough) {
  try {
    const r = await agent(scribeBrief(kind, issue, iter, payload), {
      label: `scribe-${kind}:${issue.id}`, phase: 'Dispatch',
      model: 'haiku', effort: 'low', schema: SCRIBE_RESULT_SCHEMA,
    })
    if (!r.ok) log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${r.error || 'unknown'}`)
    else if (r.notice) log(`SIDECAR-WRITE NOTICE ${kind} ${issue.id}: ${r.notice}`)
  } catch (e) {
    log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${e.message}`)
  }
  return passthrough
}

// ── Dispatch loop (worker → scribe(report) → reviewer → scribe(verdict)) ──
phase('Dispatch')
const results = await pipeline(
  ISSUES,
  // Stage 1 — Worker: worktree-isolated, schema-validated WorkerReport
  (issue) => agent(workerBrief(issue), {
    label: `worker:${issue.id}`, phase: 'Dispatch',
    isolation: 'worktree', schema: WORKER_REPORT_SCHEMA,
    model: issue.model,
  }),
  // Stage 2 — Scribe(report): durable BEFORE the review even starts. Passes the
  // report through unchanged so the Reviewer stage still receives it.
  (report, issue) => scribe('report', issue, issue.iteration, report, report),
  // Stage 3 — Reviewer: universal dispatch, schema-validated ReviewerVerdict.
  // Risk routes the Reviewer's model tier: standard for mechanical/isolated-
  // refactor, heavy otherwise; scope, checklist, and universal dispatch stay
  // unchanged — this binds WHICH model, never WHETHER or WHAT the Reviewer
  // reviews, and decouples the Reviewer's cost from whichever model happens
  // to coordinate the session (ADR-0007 Amendment 2026-07-31).
  //
  // CURRENCY CHECK for a re-extracted/reused copy of this script: this call
  // must carry `model: issue.model` verbatim, mirroring the Worker's Stage-1
  // binding above. A Stage-3 `agent()` call with no `model` key at all is the
  // tell for a copy that predates this binding — it silently re-inherits the
  // Coordinator's own session model for every Reviewer, mechanical rows
  // included, which was a first-order driver of the 2026-07-30 cost
  // measurement this amendment answers.
  (report, issue) => agent(reviewerBrief(issue, report), {
    label: `review:${issue.id}`, phase: 'Review',
    agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_SCHEMA,
    model: issue.model,
  }).then((verdict) => ({ report, verdict })),
  // Stage 4 — Scribe(verdict): persist the verdict, then build the routing tuple.
  (rv, issue) => scribe('verdict', issue, issue.iteration, rv.verdict,
    { id: issue.id, risk: issue.risk, iteration: issue.iteration, report: rv.report, verdict: rv.verdict }),
)
return results.filter(Boolean)
```

`pipeline()` (not `parallel()`) is deliberate: issue B's Worker runs while issue A's Reviewer already runs — no barrier. A Stage-1 (Worker) throw drops that row to `null` (the `.filter(Boolean)`); the Coordinator routes a missing row as a `worker-failed` STOP. The **Scribe** stages never throw — they always return their passthrough value — so a sidecar-write failure never converts a finished Worker into a lost row. The fan-out order follows `ISSUES`, which the Coordinator fills in **Plan-Table row order** — the dispatch-order tiebreak.

## Degenerate `n = 1`

A single-row wave is a one-element `pipeline()` — identical routing, no fan-out gain. The Coordinator may instead dispatch the one Worker + Reviewer inline and apply the same `route-outcome`/`route-verdict` chain. The determinism (typed fields, tested routing) holds either way.

**On the inline path the Coordinator is its own Scribe (ADR-0024).** The sidecar invariant is per-path — *every sidecar comes into being through the write verb, at the moment of agent-return*, not "a subagent always writes it". So when the Coordinator dispatches inline (the `n = 1` case, or the w2-proven inline Reviewer re-dispatch), it runs the same `write-report` / `write-verdict` verb **itself, immediately** as each agent returns — before routing. What is forbidden on **every** path: the old bundled post-routing write, and hand-formatting a sidecar.

## Recovery protocol — a bad-anchor first round (W2-F1)

`assertRequiredRowFields` throwing at compose time is the fail-loud path for the *next* wave; it does nothing for a wave already dispatched before this assertion existed (or before it covered a given field), or for any other source of a bad diff base a Reviewer catches downstream (e.g. a Coordinator hand-composed the brief outside this script). If a Reviewer verdict comes back `questions-blocking`/flags the diff base as malformed, and the Coordinator confirms the anchor interpolated into that round's briefs was wrong (missing, empty, or `"undefined"`):

1. **Re-dispatch the affected Reviewers only**, each with a corrected `issue.anchorSha` — call `reviewerBrief(issue, report)` again with the fixed `issue` object (or an inline `agent()` call carrying the same corrected value). Reuse the **same** Worker `report` / branch already produced; do not touch it. **Scribe the corrected verdict through `write-verdict` at the same `iter`** — last-writer-wins overwrites the bad-anchor verdict sidecar (the reader keeps max-iter either way); on this inline re-dispatch the Coordinator is its own Scribe (§Degenerate `n = 1`).
2. **Do not re-dispatch the Worker.** The defect is Coordinator input (a bad brief), not branch content — the Worker's commits are unaffected by which SHA the *Reviewer* diffs against.
3. **Do not consume the re-dispatch cap.** `route-verdict`'s cap=1 counts `changes-requested`/`needs-context` rounds against real branch content; a Reviewer round invalidated by a Coordinator-side composition bug is not that — treat the corrected-anchor Reviewer round as the row's real (only) review round, not a second one.

This is the scripted version of what happened live in `2026-07-16-hardening-w2`: two Reviewers returned spurious `questions-blocking` against the literal string `"undefined"`; both were re-dispatched with the corrected anchor, both then returned `approve`, and the wave closed with 0 Worker re-dispatches and the cap untouched.
