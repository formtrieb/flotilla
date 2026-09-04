# wave-start — the Workflow driver

The single dispatch mechanism (ADR-0016: no dual prose-vs-driver selector, no express variant in M1). `wave-start` runs one engine verb — `compose-driver` — which writes the finished script, hands the harness Workflow tool that file as its `scriptPath`, then routes the returned tuples (see [start-mechanics.md](start-mechanics.md)).

> ## Where the script lives — it is not in this document any more
>
> **The dispatch script ships as an engine package asset: `tools/wave/driver/wave-start-inflight.js`.** It used to be a fenced code block here, extracted and hand-filled at every dispatch; the engine's `compose-driver` verb fills it now (see [Composing the driver](#composing-the-driver--one-verb-no-transcription) below). Every symbol this document reasons about lives in that one file, under the same names — the two `*_SCHEMA` literals and `SCRIBE_RESULT_SCHEMA`, the compose-time constants `REPO_ROOT` / `WAVE_CLI` / `REPORTS_DIR` / `VERDICTS_DIR` / `REVIEWER_AGENT`, the `ISSUES` row template and its branch derivation, `REQUIRED_ROW_FIELDS` / `isMissingField` / `assertRequiredRowFields`, `HUMAN_GATED_WORKERS` / `assertNotHumanGated`, `workerBrief()` / `reviewerBrief()` / `scribeBrief()`, the Scribe stage wrapper, and the `pipeline()` fan-out. A citation anywhere that names one of those symbols "in `workflow-driver.md`" resolves through this one hop: the reasoning is here, the code is there.

> **The CLI + the agent-tool schema are the source of truth for shapes.** The two inlined `*_SCHEMA` literals are **copies** of the exported consts in `tools/wave/src/worker-report-schema.ts` + `reviewer-verdict-schema.ts` — the Workflow script runs in a no-fs, no-import sandbox, so it cannot `import` them. The `skill-schema-drift` spec reads these literals from the **wave-shared** skill and from the **shipped driver** (`tools/wave/driver/wave-start-inflight.js`) and deep-equals them against the exported engine consts — if they drift, that spec fails loud. **The canonical copies live in `wave-shared/SKILL.md`; keep these in sync with those, never hand-edit one copy in isolation.**

## Why this copy's `WORKER_REPORT_SCHEMA` drops `anyOf` — the prUrl invariant is brief-enforced here, not schema-enforced

`wave-shared`'s canonical `WORKER_REPORT_SCHEMA` literal carries a top-level `anyOf` (the `outcome: done`/`done-with-concerns` ⇒ `prUrl`-required invariant). The agent tool's `input_schema` validation **rejects a top-level `anyOf`/`oneOf`/`allOf` outright** — `input_schema does not support oneOf, allOf, or anyOf at the top level` — so the copy pasted into `agent({ schema })` below **omits it, deliberately**. This is not a drift from the canonical literal; it is the one shape difference the agent boundary forces (live-confirmed regression: **W5-F1**, `docs/retros/2026-07-19-hardening-w5.md` — the first Workflow dispatch of that wave failed instantly this way, 0 tokens, all 4 Workers, before a single agent ran, because the canonical `anyOf`-bearing literal had been pasted here verbatim).

**The `prUrl`-on-`done`/`done-with-concerns` invariant still holds on this path — it is enforced by the Worker brief, not the schema.** `workerBrief()`'s Termination step 4 ("Confirm the PR by asking the HOST") and its Report section both state the requirement in prose; there is no structural rejection at the `agent({ schema })` boundary here for a `done` report that omits `prUrl`. **And that is now a placement decision, not only a shape the boundary forces:** a boundary-portable form of the same invariant is no longer hypothetical — measured with positive and negative controls, a top-level `if`/`then` is **accepted at this boundary and genuinely enforced**, including its conditional half. It is still the wrong rung for this rule, because the antecedent is `outcome` — a field the Worker itself authors. The same probes watched an agent told to report a finishing outcome for which it had no URL: it neither invented a URL nor failed, it reported a *non-finishing* outcome instead. A root conditional here would convert "the field is missing" into "the field is present and the outcome is wrong" — a loud failure traded for a quiet one ([ADR-0034](../../../../docs/adr/0034-a-rule-earns-its-enforcement-tier.md) Amendment 2026-08-14). `tools/wave/src/skill-schema-drift.spec.ts` asserts this literal stays free of any top-level combinator, with a negative control proving that assertion actually fires — so the W5-F1 regression cannot silently ship again.

**And the brief is no longer the only tier that holds it.** Prose was not converging: three live occurrences across waves, the brief strengthened between them, each one a Worker that ran the host re-query correctly, read a `url` back, and then wrote a finishing report without it. So the invariant now also sits at the **engine's sidecar-write gate** — `write-report` emits a loud exit-0 `notice:` when a report carrying a finishing outcome reaches the write with a `prUrl` that is missing or empty, and **writes the sidecar anyway.** Three properties are load-bearing and none of them is negotiable. It is a **notice, never a refusal**: the report is valid data about work that genuinely happened, the missing URL is a finding *about* that report, and refusing the write would cost a finished row the durable record ADR-0024's whole Scribe stage exists to guarantee. **Usable means non-empty**, because an empty-string `prUrl` is the neighbouring failure class that actually shipped (issue #303), not a hypothetical. And it **does not replace the Coordinator's terminator re-query** — the gate makes the omission loud where it happens; the backstop still recovers the URL. The notice rides the Scribe's `notice` field into `SIDECAR-WRITE NOTICE <kind> <id>` in the Coordinator's log, which is what makes a silent omission a logged one ([ADR-0034](../../../../docs/adr/0034-a-rule-earns-its-enforcement-tier.md): a rule earns its enforcement tier).

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

## The Scribe can be blocked by the harness safety classifier — an absorbed failure class

A dispatched Scribe is a live subagent, and the harness runs its own safety classifier
over what an agent transcript looks like it is doing. On one live wave
(2026-08-15-goal-facet, row 570, iteration 1), the verdict-Scribe persisting a
schema-validated `approve` `ReviewerVerdict` was refused mid-transcript — `[Self-Approval]`:
from inside the Scribe's own isolated transcript, writing an `approve` it never witnessed
being produced read as fabricating a review approval feeding a public-API merge pipeline.
The verdict was genuine — the schema-validated return of the independent `wave-reviewer`
agent, one pipeline stage earlier, in-band in the same workflow's journal — and the
documented recovery held exactly as designed: the Coordinator wrote the sidecar through
`write-verdict` at routing time (§Degenerate `n = 1`), so nothing was lost.

**This is an absorbed failure class, not a broken invariant.** The Scribe stage's claim
stays best-effort, exactly as ADR-0024 built it: try/catch, passthrough, a loud
`SIDECAR-WRITE FAILED` log, and the routing-time recovery are the whole answer here, not a
gap to close. One occurrence across every wave run so far does not justify a structural
change (ADR-0034 occurrence arithmetic). The provenance clause and filing-clerk framing
`scribeBrief()` now carries (above — the producing agent's pipeline label, "same workflow
run, one stage earlier, journal-recorded", and the statement that persisting an approve is
not approval by the writer) ship **unproven, as probability-lowering**: a synthetic probe of
a harness safety classifier has no reproducible positive control, so a live wave's Scribe
stage is the only measurement available, and the datum below is the whole of it so far.

**The non-determinism datum (2026-08-15).** One block, one pass: the very next wave's
verdict-Scribe ran the same brief shape, carrying another `approve` verdict, and passed
clean — sidecar present, nothing in that wave's spine disclosing a failure. The classifier's
refusal is measured non-deterministic on the same brief shape, which is why this fix ships
as text the classifier can read, not a mechanism change.

**The recurrence ledger.** Each further occurrence of this failure class — a Scribe (either
brief kind) refused by the harness classifier — is a wave-scoped disclosure, dispositioned
as an append to issue #577 (reopen or reference-file, per its own close protocol), never a
fresh ticket. **The tripwire is three total blocks**, counted across every wave: at that
count, open an escalation grill on the named target — the Reviewer persisting its OWN
verdict through the write verb, unisolated, in the same session where the engine and sidecar
directories already live, with a provenance-complete transcript and validate-then-write
already covering shape. That fork needs its own grill and an ADR-0024 amendment; it is
deliberately not decided or built here.

This finding rides the same `SCRIBE_RESULT_SCHEMA` shape as an entirely different one: the
engine's sidecar-write-gate `notice:` (§Why this copy's `WORKER_REPORT_SCHEMA` drops `anyOf`,
above) is a finding **about a report's content** — a `prUrl` missing at a write that still
succeeded — while a classifier block is a finding about **whether the write ran at all**,
surfaced before the verb is ever reached. Two different findings, riding the same Scribe
result shape; keep them apart when reading a wave's disclosures.

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

## `--body-file` — how a Worker's PR body reaches the host at all

`create` takes its body from **exactly one** of `--body <body>` (inline) and `--body-file <path>` (read verbatim). Both, or neither, is an exit-2 usage error naming both flags; an unreadable path is an exit-2 usage error naming the path. All three are decided before any routing, credential resolve or request — a body mistake never costs a network call.

**The Worker brief uses the file form, and the reason is asymmetric between the two call sites above.** A worktree-isolated Worker's `host-pr create` was refused **in the field, on a consumer's harness** — reported with the guard's verbatim wording, not reproduced here (see the measurement below) — by a worktree-isolation guard when `--body` was a long multi-paragraph string with blank-line breaks — the guard reporting it could not be shown not to be a git command — while a comparably informative single-paragraph body passed on the first attempt. The terminator never meets this: it runs from the main checkout with no worktree isolation, and in the same session opened eight multi-paragraph-bodied PRs across two repositories without one refusal. **The failure is therefore invisible from the place this brief is authored and reachable only from the place a Worker stands** — which is precisely why the brief prescribed the shape that gets refused for as long as it did.

**A file fixes it whatever the guard's predicate is, and earns its place twice over.** The body leaves the command line entirely, so no heuristic about the command's shape can reach it; and a multi-KB quoted argument is a shell-quoting hazard and a command-length hazard on any host, isolated or not. The guard's predicate was never inspected (it is harness-side); the file form does not depend on knowing it.

**The predicate was measured rather than assumed, and the measurement came back negative — which is why the fix is structural.** From a worktree-isolated flotilla dispatch, the previously-refused shape (`host-pr create --body "<multi-paragraph, blank-line separated>"`, pointed at a remote with no shipped adapter so nothing reached a network) was **not** refused, at roughly 900 bytes or at several kilobytes; the new `--body-file` shape was not refused either. The same dispatch's guard demonstrably *can* refuse — a `node --check "$TMPDIR/…"` call in the same session came back "…so what it runs cannot be shown not to be git. Refusing to run it" — so the all-pass is not the artifact of a check that cannot fire. The honest conclusion: the refusal is real (it was reported with its verbatim wording by the consumer that hit it) but not reproducible on demand across harness versions and hosts. A caller therefore cannot tell from inside whether its own call will be refused, which is precisely the case in which a rule about how to phrase a body is worth less than removing the body from the command line — and the command-length and quoting grounds hold on their own regardless.

**The deeper cost it retires is not the refusal.** The brief used to ask the Worker for "a one-paragraph summary" — so a Worker who followed the template literally never tripped the guard *and never wrote a real PR body either*. Across four waves a Coordinator had to recover Worker-authored PR bodies out of agent transcripts, because a substantive body was either refused or never composed. `--body-file` is what makes a substantive Worker-authored body possible at all; surviving the guard is the half that was reported, not the whole of it. The Worker brief now asks for the record, not the summary.

**One property the file must keep.** The close-phrase guard is line-anchored, so the store-kind close phrase (wave-shared Convention 4) has to own its own line *inside the file*. `--body-file` reads the bytes verbatim — blank lines, indentation and any trailing newline preserved, nothing trimmed — so the line the Worker wrote is the line the guard reads. A file body and the same bytes passed inline are indistinguishable downstream: same refusal, same reuse rewrite, same printed JSON.

## Composing the driver — one verb, no transcription

```bash
{{wave-cli}} compose-driver \
  --spine .flotilla/waves/<slug>.md \
  --config wave.config.json \
  --anchor <COORDINATOR_HEAD_SHA> \
  --out <consumer-root>/.flotilla/tmp/<slug>/driver.js \
  [--plugin-manifest <plugin-clone-root>/.claude-plugin/plugin.json] \
  [--reviewer-agent <name>] [--coordinator-branch <b>] [--deps-setup "<cmd>"] \
  [--row-meta '{"<id>":{"prTitle":"…","reviewerHints":["…"],"note":"…"}}']
```

It writes the finished script to `--out` — the path the harness Workflow tool
takes as its `scriptPath`, unchanged in shape — and prints ONE JSON receipt:
the rows composed, each row's branch, model, iteration, risk, worker and
grant-count, the anchor, the Reviewer agent name and how it was derived, the
template path and its byte size. Read the receipt; do not re-derive any of it.

**Keep `--out` inside the repo** — under the Scribe's gitignored `.flotilla/tmp/`,
not in the `/tmp` scratch directory the run's other files use. Those files are
read by the engine; this one is read by the harness, and the Workflow tool can
only start from a script file the session is already allowed to read — a path
outside the working directory would first need `/add-dir` or a Read allow rule.
Inside the repo, nothing needs adding, and `worktree-cleanup` sweeps the file
at close with the rest of `.flotilla/tmp/`.

**Every value the old currency checklist policed is now filled from a source.**
The repo root and the two absolute sidecar dirs come from `--repo-root` (or the
cwd) plus the spine's own slug; `WAVE_CLI` from the config's `engine.cli`
(ADR-0032) with the `NODE_USE_ENV_PROXY=1` prefix; the roster — id, slug,
branch, model tier, iteration — from the spine's Plan-Table and dispatch-log
(so it byte-matches the Coordinator's own `spine set-branch` write, ADR-0021);
each row's `issueSpec` from `issue-store read` + `triage-read`, embedded
verbatim; the verify-gate block from the config's `verify` profile and
`depsSetup` through the five-level precedence below;
`closePhrase` from `store.kind` (Convention 4); `scopeGrants` from
this row's `scope-extension` disclosures in the spine (ADR-0041); `anchorSha`
from `--anchor`, **verified with `git rev-parse --verify <sha>^{commit}`
before anything is written** — the host-side anchor-resolvability gate, folded
in. Nothing is typed twice, so nothing can disagree with itself.

**Four compose-time refusals, before any `agent()` fan-out.** A row whose
Worker is human-gated, or `foreground`, is refused with its own message and its
own remedy; a row missing any `REQUIRED_ROW_FIELDS` entry is refused naming the
row and the field; an anchor that does not resolve is refused naming the SHA;
and a row with **no install step and a gitignored engine binding** is refused
naming the binding and the path (below).
The shipped script keeps its own copies of the first two as the backstop for a
hand-edited script, and `tools/wave/src/skill-schema-drift.spec.ts` pins those
copies to the engine's own `REQUIRED_ROW_FIELDS` and `HUMAN_GATED_WORKER`, so
the two cannot disagree.

### `depsSetup` — five precedence levels, and one refusal

The row's dependency-install step is resolved most-specific-first
(ADR-0032 amendment 2026-09-04):

1. **the row's own `--row-meta` `depsSetup`** — one row installs differently;
2. **the compose call's `--deps-setup` flag** — one answer for this compose;
3. **`engine.install` in the wave config** — the consumer's standing setup-time
   binding, written by `wave-setup` beside `engine.cli`;
4. **the install-shaped command in the row's own verify profile** — a
   derivation, and a good one, but still a guess about intent;
5. **nothing.**

A blank at any level is **not an answer** — it falls through rather than
resolving to an empty step. There is deliberately no way to spell "confirmed:
no install needed": level 5 renders as a **deferral** in all three
workspace-setup sites (iteration-1 Worker, re-dispatch Worker, Reviewer) —
*"no install step was recorded for this consumer — verify this worktree can run
the verify gate and the engine CLI before the first engine call"*.

The wording that replaces asserted a consumer answer the composer never had
("consumer confirmed at wave-setup: nothing gitignored here — no install step
needed"), and it was **false on the first consumer that read it**: both Workers
of a two-row wave found their own `engine.cli` binary missing — that consumer
binds `./node_modules/.bin/flotilla-engine` and gitignores `node_modules/` — and
each installed by hand before any engine verb resolved.

**The refusal is the half a deferral cannot cover.** An honest deferral is the
right answer where the row can still do its work. It is the wrong answer where
`engine.cli` ITSELF resolves through a gitignored path: the binary is absent
from every dispatched worktree, so the row could neither run its verify gate nor
open its PR, however carefully it read. `compose-driver` therefore measures the
repo with `git check-ignore` — index-aware, so the question is *"would this path
be absent from a fresh worktree"*, and a TRACKED file under an ignored directory
composes normally — and exits non-zero naming the binding, the ignored path, and
the setup-time fix. The probe runs at most once per compose, and only when some
row reached level 5.

The receipt reports **which level answered**, per row, as `depsSetupSource`
(`row-meta` | `flag` | `engine.install` | `verify` | `none`). Read it rather
than inferring from the command string: a level-3 and a level-4 answer are
frequently the same bytes and are not the same claim.

**The Reviewer agent name is derived, never spelled (issue #677).** In
flotilla's own SOURCE form the agent is registered under its bare definition
name; an installed plugin registers it NAMESPACED as `<plugin>:<agent>`. A
Coordinator that pasted the fence verbatim into an installed-form dispatch had
its Stage-3 `agent()` call fail to resolve — the drift that made this whole row
necessary. The verb reads the plugin manifest's `name` and the agent
definition's frontmatter `name`, picks the shape by the same `engine.cli`
discriminator step 4b uses, and honours `--reviewer-agent` as the override.
Where no manifest is reachable (an installed consumer whose plugin clone the
engine cannot know about — the engine is TOLD, exactly as `version --expect` is
told the plugin version), the verb REFUSES and names both flags rather than
guessing a spelling.

**The compose-fresh-or-verify rule and its seeded currency checklist are
RETIRED**, and the retirement is structural rather than editorial: they existed
because a composed script was a hand-made COPY of this document's fence, and a
copy can go stale the instant the document is edited under it. There is no copy
any more. The script is read from the package at every compose, and the two
occurrences that rule was seeded from — a frozen template that outlived the
cwd-persistence fix, and a Reviewer-isolation posture claim the repo had already
falsified — are both shapes that require a second hand-maintained copy to exist.

### The recompose-refetch rule — the tracker-currency sibling (ADR-0041)

**Every compose re-fetches the row's issue spec, unconditionally — and this is now the VERB's behaviour rather than a Coordinator discipline.** `compose-driver` reads every dispatchable row through `issue-store read` + `triage-read` on every run and re-embeds the result as `issue.issueSpec`; there is no cache, no flag and no "only if I annotated this row since last time." That holds for a re-dispatch iteration (§Re-dispatch below) and for a wave-resume `redispatch` hand-off alike (`wave-resume/SKILL.md` step 8 hands its `redispatch` rows back to `wave-start`'s dispatch step, which is this same verb — so nothing wave-resume-specific has to restate the rule). That condition is exactly the remembering whose failure produced the observed gap — live occurrence, wave `2026-08-13-consumer-boundary-a`, row 499's two review rounds: the Coordinator DID grant a scope extension and DID write it to the tracker via `annotate`, and the round-2 brief still carried the pre-grant spec, because nothing forced the re-embed the fix requires. A conditional rule is also blind to a third-party tracker write the Coordinator never made itself — an unconditional one is not.

This used to be the tracker-currency SIBLING of the compose-fresh-or-verify rule, one level down: that rule asked whether the script TEXT still matched this document, this one asks whether each row's EMBEDDED SPEC still matches the tracker. The first question no longer exists — the script is read from the package, not copied — and the second is answered by the verb, on every run. Same remedy either way: re-derive fresh, never inherit a previous compose's answer.

**The grant rides along as data, not only as a widened glob.** A recompose that re-fetches `issueSpec` alone still hands the Reviewer a widened Files list with no way to tell a GRANTED widening from an accidental one — a widened glob never conveys that a decision was made, by whom, or what it is bound to. The optional `scopeGrants` field (§Per-row data below) is the other half of the fix: it is what makes the grant itself, not merely its effect on the glob, visible to both briefs. It is sourced as a **projection** of this row's `scope-extension`-disposition disclosures in the spine, built fresh at every compose alongside `issueSpec` — never authored by hand, and never a second source of truth: the spine stays the sole durable record.

**The same-round boundary is deliberate, not a gap this rule is meant to close.** Row objects are sealed at fan-out (§Harness constraint above) — a grant spoken at routing time (`start-mechanics.md` step 7.0a) reaches only the NEXT compose. The round already in flight keeps whatever `scopeGrants` it was dispatched with (ordinarily none, for a row's first grant), and its Reviewer may still have to re-derive the forcing with an honest caveat if it is asked to verify an out-of-glob touch before the grant reaches it. That is the documented fallback (ADR-0041 Decision 4) and it stays correct behavior: closing it would mean injecting live spine state into an already-dispatched brief, which breaks fan-out sealing for a case the fallback already handles.

**Resume is not a separate case.** `wave-resume` never composes a brief itself — its own reconciliation ends at step 8, which hands every `redispatch` row back to `wave-start`'s dispatch step, i.e. the same `compose-driver` call. A resumed re-dispatch is therefore an ordinary compose, with no wave-resume-specific wiring required: the unconditional re-fetch and the `scopeGrants` projection both apply exactly as they do for a cap=1 re-dispatch.

## Composition constraints — the properties the verb preserves

These were **authoring constraints** while a Coordinator filled the script in by
hand. They are now properties of `compose-driver` and of the shipped template,
kept here because each one is a decision with evidence behind it, and because the
numbered list is cited by name from elsewhere in the skill surface.

1. **Per-row data is embedded in the script body** as `const ISSUES = [...]` —
   the Workflow `args` channel does not reliably deliver a large nested payload.
   The verb substitutes the array into the template; nothing depends on `args`.
2. **Briefs are composed in-script** by helpers that string-interpolate the
   structured fields — a function field cannot survive JSON serialization.
3. **Every Worker is anchored to the wave-anchor SHA** (`git reset --hard
   <anchorSha>`) so the Reviewer diffs against that SHA, not `main`. Presence
   and RESOLVABILITY are now both checked, and both at compose time: the
   template's `REQUIRED_ROW_FIELDS` assertion tests presence, and the verb runs
   `git rev-parse --verify <sha>^{commit}` before writing anything. That second
   check used to be a separate Coordinator-side step because the Workflow script
   has no filesystem of its own (§Harness constraint) — the verb does, so it
   runs there. Live occurrence: a fabricated anchor SHA with a correct 7-char
   prefix passed compose and reached four parallel briefs; all four Workers
   independently caught it themselves.
4. **The compose-time constants are filled from sources, never authored.**
   `REPO_ROOT` (absolute, and **shell-quoted** wherever it is interpolated into a
   brief — see its own note in the shipped driver), `WAVE_CLI` (from the
   consumer's configured `engine.cli`, read out of `wave.config.json`),
   `REVIEWER_AGENT` (from the plugin manifest + the agent definition), and the
   two **absolute** sidecar dirs `REPORTS_DIR` / `VERDICTS_DIR`. `WAVE_CLI` has
   **no default of its own**: the binding lives in exactly one place per repo and
   the driver reads it rather than restating a form (ADR-0032). An **absent**
   `engine.cli` is a STOP, not a cue to pick a spelling — `wave-setup` has not
   finished in that repo, and `compose-driver` refuses with exit 2 saying so.
   The engine validates the field as **repo-relative and non-absolute**, which is
   exactly the property this constant needs: the tracked `.claude/settings.json`
   permission allowlist a dispatched agent inherits can only match
   **repo-relative** invocation prefixes — an absolute form would embed a machine-
   and client-specific path that a public repo's tracked settings must never
   carry. Worker and Reviewer worktrees carry **tracked files only** (see "A
   worktree carries tracked files only" below), so that tracked allowlist is the
   *only* permission source they inherit; an absolute-form engine call from a
   Worker's termination step or a Scribe would hit the permission gate mid-wave
   and break AFK dispatch, which is why the config refuses one outright. A
   Worker's worktree needs no extra step for the configured binding to resolve:
   its post-checkout cwd already *is* a repo-relative root, and every one of its
   Bash calls starts back at that root. A Scribe, running in the **session cwd**
   (no worktree isolation), gets the same property from the same mechanism —
   **not** from a `cd`, which never reaches the call that would need it (§The
   Scribe's cwd, above). `REPORTS_DIR` / `VERDICTS_DIR` stay absolute regardless.
5. **Free-form brief text never has to be hand-escaped into a JS literal.** The
   verb serializes every row field through `JSON.stringify`, so an apostrophe in
   an issue title, a reviewer hint or an embedded spec cannot break the script's
   parse. **Observed failure shape (W17-F1):** the first Workflow launch of a
   wave failed at the script parser — not at any `agent()` call — because a
   hand-composed `reviewerHint` carried a backslash-escaped apostrophe inside a
   single-quoted string. Cost was zero (no agent had started, no state was
   touched), but the whole compose round was lost. That class is now closed by
   construction.
6. **Never hold the engine CLI — or any command — in a shell variable in your own
   Coordinator shell, and never let an empty capture flow onward (wave-shared
   Convention 12).** This constraint is about the shell *you* type into while
   routing, not about the script: `CLI="<the configured engine.cli value>"; $CLI
   spine set-row-state …` exits **127** under zsh (no word-splitting of an
   unquoted expansion) and runs **nothing** — five occurrences, the most recent of
   which produced an empty PR URL that was then written to the spine as a value.
   Bind a function instead (`wave_cli() { … "$@"; }`) and iterate a real array
   rather than `for x in $LIST`. **And obey the call boundary on every capture you
   subsequently *use*** — a PR URL, an id, a SHA: verify it in the SAME Bash call
   that produced it, or do not capture it at all and re-query its source in the
   call that needs it (`host-pr status --branch <b>` for a PR URL). A shell
   function and a shell variable are both session state, and shell state does not
   survive between Bash calls. The `WAVE_CLI` constant is the safe shape by
   contrast, and stays that way precisely because it is a compose-time JS string
   that no shell ever expands.
7. **`REQUIRED_ROW_FIELDS` names every scalar field the briefs interpolate, in
   exactly one place.** It is an exported engine constant
   (`tools/wave/src/compose-driver.ts`) that the verb enforces at compose time,
   and the shipped script carries a pinned copy as its own backstop — so a
   Coordinator wiring a row never has to grep every `workerBrief`/`reviewerBrief`
   for its `${issue.*}` interpolations. A field added to a brief but not to that
   list is exactly how the narrow `assertAnchorSha` (anchorSha-only) predecessor
   of this assertion missed `branch` one wave-generation later. It asks "is this
   field present enough to interpolate?" — never "does this value resolve?"
   (constraint 3 owns that), and never "may this row be dispatched at all?"
   (`assertNotHumanGated` and the verb's `foreground` refusal own that).

## A worktree carries tracked files only (FOR-32, W4-F4)

`isolation: 'worktree'` gives Worker and Reviewer alike a **fresh checkout of tracked files** — nothing gitignored comes along. **That parity is checkout provisioning only, a different mechanism from the isolation guard's own asymmetry:** [wave-shared Convention 13](../../wave-shared/reference/convention-13-one-bash-call-per-step.md)'s Catalog entry 1 records that the command-complexity refusal (a bare `$VAR` expansion refused outright) is reproduced from the Worker's `agent()` call, which sets `isolation: 'worktree'` explicitly (Stage 1), and is **not** established as refused from the Reviewer's `agent()` call, which carries no `isolation` key at all (Stage 3) — two mechanisms, not one, so a skimming reader should not conflate "both worktrees are provisioned the same way" with "both dispatches carry the same guard." Two consumer paths are commonly gitignored, and both briefs below assume they exist unless the Coordinator fills the gap:

- **The dependency directory.** If it is gitignored (the ordinary case for a lockfile-managed dependency tree), a fresh worktree has it **absent, not merely un-installed** — the verify gate the brief tells the agent to run cannot run at all without an install step first. The Reviewer brief hits the identical wall: it independently re-runs the same verify commands in its own worktree.
- **The store config** (e.g. `wave.config.json`). If it is gitignored, it is likewise **absent** from the worktree, so an agent standing inside that checkout cannot resolve a tracker id against a store it has no config for — a bare `issueRef` is unreadable from there.

Neither gap is flotilla's to close generically with a hardcoded command — the dependency dir, the install command, and the config's location are all **consumer-specific**. The mitigation is two per-row inputs the composer fills (`depsSetup` / `issueSpec` below), sourced from the consumer's own setup. The install half is no longer a Coordinator hand-off at all: `wave-setup` writes it into the config as `engine.install`, and the composer resolves it through the precedence above — the loop where a Coordinator re-supplied it per wave is what let it be absent, silently, on the one consumer whose binding needed it most.

## A gate the sandbox withholds — the clause both briefs now carry ([ADR-0049](../../../../docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md))

The section above is about what a worktree **lacks**. This one is about what a dispatched agent **may not do about it**.

Live occurrence: a consumer's first wave took 5h46 of wallclock, of which roughly five hours were one permission prompt. The Worker ran the gates its brief demands, they failed inside the sandbox, it retried with the sandbox off, and the harness asked — in the Coordinator's own window, shortly after four in the morning, with nobody there. Everything else in that run was silent and correct. **No allowlist entry could ever have answered it:** a `permissions.allow` entry can permit a *command*; it cannot permit *disabling the sandbox*. And the brief itself pointed both ways at once — it already named the danger ("a permission dialog mid-AFK-dispatch has nobody to answer it and stalls your row", policy clause 11) and two clauses later forbade the only click-free way out ("never drop a gate because its literal form was refused").

Three things changed, and they sit at three different tiers:

1. **`VerifyCommand.needs`** — a verify command declares what it must reach, as a closed set of three requirement classes (`writes` paths outside the worktree, `network` hosts, `host: true` for the class that cannot be narrowed). The engine learns the *need*; the skill tier translates it into whatever binding the harness has. `config validate` refuses any other key or value shape, naming the set. Optional, so a config that predates it is unchanged.
2. **`composeIssueSpec` renders each command's needs beside it**, which puts the data in front of both roles at once — the Worker brief and the Reviewer brief embed the same spec, and the Reviewer independently re-runs the same commands into the identical wall. It is rendered the way an ADR-0041 scope grant travels: as a fact the far end reads, never as a judgment the far end re-derives. A row whose commands declare nothing composes byte-identically to before.
3. **Worker policy clause 12 and the Reviewer's own paragraph** carry the floor: *a dispatched agent never escalates its own permissions, attended or not*. The retry-with-the-sandbox-off path is retired by name. A verify command refused for a permission reason is reported as **not run, with the reason**, through channels the report already has — never re-run un-sandboxed, never dropped silently — and the acceptance criteria it would have backed land in the Reviewer's deferred valve under its fourth trigger, `capability-gated`, beside merge-, prod- and human-gated. The human act moves from a blocking click to a non-blocking Disposition.

**Why the floor is a brief clause and not a Convention.** One consumer, one occurrence, one file — this driver's two briefs — earns the prose tier ([ADR-0034](../../../../docs/adr/0034-a-rule-earns-its-enforcement-tier.md)), with ADR-0049 as its why. It is also a *safety property* rather than an optimisation: setup can never enumerate every gate a consumer will cut tomorrow, so the floor has to hold whatever the setup's quality.

**Attendance is not a property a run can carry**, which is why the clause is unconditional rather than flagged. The reporting operator was present at dispatch and absent when the prompt came; a brief that said "unless someone is watching" would have been true at 03:45 and false at 03:52.

**No return-schema change.** The Worker reports through `tests` / `lint` and `judgmentCalls`; the Reviewer through `acVerification[].met` (`deferred` / `partial`) and `reviewerFocusItems`. Both schema literals are untouched, so the byte-identical drift guards and the plugin/engine lockstep stay out of play — and `capability-gated` is emphatically **not** a new `documentedFormComparison.trigger` value: a capability-gated deferral on a row's core path fires the existing `deferred-core-path` trigger, exactly as any other deferral does.

**The setup half is issue #716**, blocked by this one, and it is not restated here: `wave-setup`'s side of the decision — asking the needs question, translating `writes`/`network` into the tracked settings, keeping `host` operator-local as the `docker` rule already does for its class, and measuring each `needs`-bearing command inside the sandbox — belongs to that row, and so does ADR-0049's one deliberately open assumption about how a project-tracked sandbox block composes with an operator's own. What holds here regardless of how that lands is the floor in point 3.

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

## The script — read it in the package, not here

```
tools/wave/driver/wave-start-inflight.js
```

That file **is** the script: the two schema literals, `SCRIBE_RESULT_SCHEMA`,
the five compose-time constants, the `ISSUES` row template with its per-field
comments, the branch derivation, both compose-time assertions, the two
workspace-setup templates, `workerBrief()`, `reviewerBrief()`, `scribeBrief()`,
the Scribe stage wrapper and the `pipeline()` fan-out — in that order, under
those names, with every rationale comment this document's sections above expand
on. It ships in the npm package (`files` lists `driver`, exactly as it lists
`hooks`), so it is present in a consumer's install and in this repo alike.

**Do not copy it anywhere.** `compose-driver` reads it from the package at every
compose and writes the filled result to `--out`; a second copy is precisely the
thing whose staleness the retired compose-fresh-or-verify rule existed to police.
The stage layout, the per-stage dispatch options and the rendered brief text are
pinned by `tools/wave/src/compose-driver.spec.ts`, which runs a composed driver
against stubs for the four Workflow-tool primitives; the literals and clauses
this document reasons about are pinned by
`tools/wave/src/skill-schema-drift.spec.ts`, which reads the shipped file
directly.

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
