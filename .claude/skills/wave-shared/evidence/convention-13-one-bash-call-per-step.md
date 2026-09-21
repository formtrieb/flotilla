## Convention 13 — evidence sidecar: live occurrences

Moved out of `reference/convention-13-one-bash-call-per-step.md` per ADR-0034's Amendment (2026-08-13): `reference/` is loaded whole by every execution skill on every wave, and this history is not needed for that load. Reachable on demand via the ADR-0040 sibling-path read; the rule, and the Catalog of refused/accepted command shapes (actively cited by name from `workflow-driver.md`'s briefs), stay in the reference/ file.

**2026-09-03:** the reproduction detail this Catalog's entries used to carry inline in `reference/` moved here too, per the same amendment — entry 1's own probe transcripts and the "evidence arc" five-station table beneath it, and each of entries 2 through 5's dropped example or occurrence citation. `reference/` now keeps, per entry, only the heading, the one minimal refused/accepted code pair, and the scoped claim the catalog draws from that reproduction — plus a pointer sentence to the detail below.

**2026-09-16 (#810, ADR-0050's corpus wave, round 3):** the remaining *why* prose moved out of `reference/` too — the two mechanism derivations (Mechanism A's documented compound-command rule and hazard cases; Mechanism B's guard description and its first live occurrence), the "Splitting is not always a preceding `cd`" walkthrough's three reproductions and the Scribe's retired `cd`/engine-call split, the "Why widening the permission allowlist is the wrong fix" section's four reasons, the "The two signatures are not interchangeable" walkthrough, and — since #810 lands on top of the round-2 declaration row — each catalog entry's remaining minimal code pair plus scoped-claim paragraph (entries 1, 2, 3 and 5; entry 4 was prose-only and had no code pair to move). Each is appended below, under the mechanism section it belongs to or the Entry N heading it was drawn from. `reference/` now keeps, for these: one residual sentence per mechanism, one line per catalog entry, and a pointer to this file for each — plus the rule sentence, the Enforced-by line, the catalog's shape names, the Common Mistakes list, and the code example under "Splitting is not always a preceding `cd`" (the ✗ fused / ✗ split-but-wrong / ✓ flag-carrying trio and the closing "most tools have such a flag" paragraph), which stayed because they are the rule's own shape, not its derivation.

### Mechanism A — the permission allowlist, in full

**Failure signature: the harness raises a permission dialog mid-dispatch.** In an AFK wave there is no human at the keyboard, so the agent sits on a prompt that never gets answered and the row stalls — the retrospective finding that permission prompts are the ceiling on AFK dispatch is exactly this, and a fused command is the cheapest way to hit it.

A Worker/Reviewer worktree carries **tracked files only**, so the tracked `.claude/settings.json` `permissions.allow` list is the *only* permission source a dispatched agent inherits (wave-setup scaffolds it deliberately for that reason). Its entries are command patterns matched against the command text — `Bash(npm ci)`, `Bash(npx vitest run:*)`, `Bash(git fetch origin:*)`.

The authoritative documented form for how those patterns meet a compound command — Claude Code's own "Configure permissions" reference, §Bash → *Compound commands*, read at the source in this convention's dispatch rather than recalled:

> Claude Code is aware of shell operators, so a rule like `Bash(safe-cmd *)` won't give it permission to run the command `safe-cmd && other-cmd`. The recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule must match each subcommand independently.

So the gate a fused command faces is **strictly narrower** than the gate its allowlisted half faces alone: *every* subcommand must qualify on its own merits, and the allowlisted half carries only itself past the gate — never whatever is glued in front of it. The same reference names two `cd` combinations that prompt **even when each part is independently read-only**:

> * **`cd` with `git`**: prompts when the `cd` changes into a different directory, since running `git` in a new directory can execute that directory's hooks. […]
> * **`cd` with an output redirect**: prompts when Claude Code can't determine which directory the redirect target resolves against after the `cd` runs.

Those two are not exotic: `cd <dir> && git …` is the shape of half the workspace-setup steps in this pipeline, and `cd <dir> && <cmd> > <file>` is how an agent captures output it means to read back. The first prompts whenever the `cd` actually changes directory; the second prompts whenever the harness cannot resolve where the redirect target lands (`2>/dev/null` is the documented exception, since `/dev/null` does not depend on the working directory). Neither is rescued by anything on the allowlist.

**A correction the next reader needs, because the old framing is still greppable.** This clause used to live only inside `scribeBrief()`, phrased as *"a compound command that STARTS WITH `cd` matches no allowlist prefix … changes the command's first token to `cd`, so the rule never fires."* Right instruction, wrong mechanism — and the wrong mechanism mispredicts in **both** directions:

- it over-predicts a dialog: `cd tools/wave && npm ci`, with a `cd` target inside the working directory and `npm ci` on the allowlist, can pass — the documented rule is that a compound "runs without a prompt when each part qualifies on its own";
- it under-predicts one: `cd <dir> && git status` prompts, even though both halves are read-only commands that need no allow entry at all.

Hold the per-subcommand rule instead of the first-token story. The operational conclusion — split the call — is unchanged, and better supported: with per-subcommand matching, splitting is the only form for which "is this allowed?" has one answer instead of N.

### Mechanism B — the worktree-isolation guard, in full

**Failure signature: the command comes back rejected as too complex to verify that it stays inside the worktree.** Nobody is prompted, nothing is pending, nothing ran. The agent is simply handed a refusal — and an agent handed a refusal is free to shrug and continue, which is precisely what makes this the more dangerous of the two.

This guard is not the permission system. A dispatched agent runs in an isolated worktree, and the harness checks each Bash command against that isolation boundary; a command fusing several steps can exceed what that check can reason about, and an unverifiable command is refused rather than allowed. **Nothing on the permission allowlist reaches this decision** — it is a different mechanism asking a different question.

Live: in wave `2026-07-29-conventions-wiring` a Worker's compound `&&` command was rejected this way. The Worker **skipped the check it had been trying to run** and proceeded. No harm on that run — but "an agent silently drops a verification step" is the same family as [Convention 12](../reference/convention-12-no-command-in-a-shell-variable.md)'s half two (a step that did not run leaving a record that reads as complete) and as the empty-capture class it was written against. The report that comes back from such a run is not wrong about anything it says; it is missing a step nobody asked about.

### The two signatures are not interchangeable, in full

A dialog is **loud and blocking**: the wave stops, and whoever finds it knows something needs answering. A refusal is **quiet and non-blocking**: the agent keeps going, and the only trace is a step that never happened.

An agent that has met only the dialog reads a refusal as *"this command isn't allowed here"* and routes around it by dropping the step — the correct reading is *"this command's SHAPE cannot be verified; issue it as separate calls and it will run."* An agent that has met only the refusal expects a fused command to fail closed, and is unprepared for one that instead hangs a wave on a prompt. Naming one mechanism and leaving the other implicit teaches exactly half of a two-sided rule, which is how the second half stayed unwritten until 2026-07-29.

### Why widening the permission allowlist is the wrong fix, in full

The tempting patch is a `cd` entry in the tracked allowlist. Do not add one.

1. **Splitting costs nothing, so there is nothing to buy.** The fuse is a habit carried in from interactive shell use, not a requirement of anything here. Every step that is currently fused can be issued as its own call, and the directory can travel with the command via a flag in nearly every case.
2. **It would not reliably fix mechanism A either.** The forms that hurt most — `cd` with `git`, `cd` with a redirect — prompt on a **hazard-specific rule** (a new directory's git hooks; an unresolvable redirect target), not on a missing prefix match. The documentation makes no promise that an explicit `cd` allow entry buys those back, so the widening's payoff is unspecified exactly where the pain is.
3. **It cannot touch mechanism B at all.** The isolation guard rejects a fused command it cannot verify regardless of what any permission rule says. Even a perfectly widened allowlist leaves the second mechanism firing on the same input.
4. **The tracked allowlist ships to every consumer.** `.claude/settings.json` is the sole permission source every dispatched agent in every consumer repo inherits; widening it enlarges the unattended command surface for all of them — in exchange for a convenience that a newline already provides.

### Splitting is not always a preceding `cd`, in full — the reproductions and the Scribe repair

**Live-reproduced three times, in three separate dispatches — and, since the third, on BOTH isolation postures rather than only under `isolation: 'worktree'`:**

- *2026-07-30, this convention's own dispatch (`isolation: 'worktree'`):* `cd <worktree>/tools/wave` returned success, and the very next call's `npm ci` failed with npm's own usage error because it ran at the worktree root — `pwd` in the following call printed the worktree root, not `tools/wave`.
- *2026-07-31, issue #251's Worker dispatch (`isolation: 'worktree'`):* the same pair, minimal form. Call 1 `cd <worktree>/tools/wave` — exit 0, no output. Call 2 `pwd` — printed the **worktree root**. Nothing carried; nothing failed loudly either, which is exactly why the assumption survives unnoticed until something depends on it.
- *2026-07-31, issue #251's iteration-1 REVIEWER — the **non-isolated** datapoint, and the one this section was missing.* A Reviewer's `agent()` call sets no `isolation: 'worktree'` (the same discriminator Catalog entry 1 records for the `$VAR` refusals), so it runs in the same posture as the Scribe: dispatched, but not worktree-isolated. Reviewing this very change it measured its own dispatch and found a shell **function** defined in one call and a shell **variable** assigned in one call both gone by the next. Until then every reproduction here was `isolation: 'worktree'`, so applying the rule to the Scribe — the one non-isolated role in the pipeline, and the role whose `cd` this convention retired — was an extrapolation across the exact axis that had never been measured. It is measured now: **no shell state survives between a dispatched role's Bash calls, on either posture — not the cwd, not a variable, not a function.** Two consequences worth carrying: the Scribe's observe-never-set design rests on measurement rather than on transfer from a different posture; and a shell function is only a remedy *within one call* (see the `wave_cli()` note in [`workflow-driver.md`](../../wave-start/reference/workflow-driver.md)'s `WAVE_CLI` constant — a function is the right shape for a binding in command position, but defining it in call N buys nothing in call N+1).

**And the host's own Bash-tool description is not a safe source for this.** In the #251 dispatch the tool description handed to the agent stated that the working directory *persists* between calls (while advising absolute paths anyway) — and in that same dispatch it demonstrably did not. That is the reason this convention states a rule (*assume nothing persists*) instead of telling a role to consult its host: a role that reads the contract and believes it writes exactly the code this section exists to prevent.

**The consequence this repaired, in full:** the Scribe's old step-1 `cd "$REPO_ROOT"` / step-3 engine-call split (`scribeBrief()`) was a dispatched subagent too, so its `cd` never reached step 3 — and step 3 worked anyway, because the Scribe's dispatch root already *was* the repo root. That is **incidental safety**: a step that appears to establish a precondition, a precondition that is really being met by something else entirely, and no signal on the day the something else changes. The resolved design is in [`workflow-driver.md` §The Scribe's cwd](../../wave-start/reference/workflow-driver.md) and it removes the dependency structurally rather than re-fusing anything: **no `cd` at all**; a bare `pwd` compared against the compose-time repo-root literal, once; **every path argument absolute** (the sidecar directory flag, `--reports-dir` / `--verdicts-dir`, always was, and the payload file flag, `--report-file` / `--verdict-file`, now is — the write verb reads it against the process cwd, so a relative temp name was the same dependency wearing a different hat); and a cwd mismatch reported through the Scribe result rather than `cd`-ed around. What is left is a stated, observable precondition — the Coordinator dispatches from the repo root — instead of an assumption nothing could see.

### Live occurrences (evidence)

- **2026-07-29, wave `2026-07-29-conventions-wiring`, disclosure `184.5` — mechanism B, first written down.** A Worker's compound `&&` command was rejected as too complex to verify staying inside the worktree; the Worker skipped the check it was running and continued. Captured at verdict-routing per [ADR-0027](../../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md); the disclosure text, the Worker report and the Reviewer verdict live in that wave's spine and sidecars. This is the occurrence that turned a one-brief aside into a convention.
- **Mechanism A, on our own allowlist.** The Scribe path is where this was first hit and first documented — a `cd "$REPO_ROOT"` fused onto the engine call that writes the sidecar, against a tracked allowlist that covers the engine call exactly. Same class as the KW-F6 sandbox footgun in Convention 1, where `env -u GITHUB_TOKEN gh …` slips a `gh *` prefix rule because the command the matcher parses is not the one the rule names: a wrapper or a fused step in front of an allowlisted command is not covered by that command's entry.
- **2026-07-30, this convention's own dispatch — the cwd-reset half.** `cd <worktree>/tools/wave` in one call, `npm ci`'s usage error in the next, `pwd` back at the worktree root in the third. Recorded because the obvious remedy for a fused command ("just split it") is incomplete on the exact path a Worker runs on, and an incomplete remedy is how a rule earns a reputation for not working.
- **2026-07-30, wave `2026-07-30-arm-and-wiring`, coordinator disclosure `256.4` — mechanism B, three refusals, one wave; live-reproduced at issue #267's own dispatch.** The disclosure named three shapes (jq-piped capture with a case guard, heredoc spec append, heredoc commit message), each "correctly re-issued unfused." The Catalog (in the reference/ file) reports what live reproduction in this dispatch actually found: shape 1 is a categorical `case`/`esac` refusal, not fusion; shape 2 is narrower than fusion and only partly resolved; shape 3 confirmed as ordinary fusion. This is the occurrence the Catalog section exists to hold, and future refusals append there rather than growing this list.
- **2026-07-31, issue #303's own dispatch — the capture-guard collision resolved, and three failed remedies recorded as an arc.** Convention 12 prescribed a compound capture guard; this convention documents that shape as refused; the two met inside one Worker-brief step, and the consequence was observed (two rows reporting `done` with an empty `prUrl` while their PRs existed). Catalog entry 1 now carries all four stations — `case`/`esac` refused, the two-call `if` form inert *and* refused, the one-call fusion refused, the host re-query working — each live-reproduced here rather than inferred, plus the probe series isolating the actual discriminator (a `$VAR` expansion, not fusion and not the control structure). The Coordinator's file-based substitute is recorded as a two-observer disagreement rather than folded into the prescription.
- **2026-07-31, issue #251's own dispatch — the Scribe's `cd`/engine-call split retired, and the cwd fact re-measured.** The split obeyed this convention's letter (nothing fused, one call per step) and was resting on **incidental safety**: the `cd` never reached the engine call, which resolved only because the Scribe's dispatch root already was the repo root. Re-measured here as two bare calls — `cd <worktree>/tools/wave` (exit 0), then `pwd` (worktree root) — the second independent reproduction of the cwd reset, and in the same dispatch the host's own Bash-tool description claimed the working directory persists. That row's own iteration-1 Reviewer then supplied the **third** reproduction and the first on a **non-isolated** dispatch — a shell function and a shell variable, both gone by the next call — which is what turned the generalization to the Scribe (the pipeline's one non-isolated role) from an extrapolation into a measurement. `scribeBrief()` step 1 is now a bare `pwd` against the compose-time repo-root literal, its payload argument is absolute (the write verb reads `<json-file>` against the process cwd), and a mismatch is reported rather than `cd`-ed around; the Worker brief's verify-gate and workspace-setup sections carry the same invariant. The remedy is structural on **both** configured `engine.cli` forms — a path-free npm-first binding resolves anywhere but can bind a different engine copy from a wrong cwd, and a repo-relative vendored binding fails loud — which is why the `pwd` stays even where no path is being resolved.
- **2026-07-30, issue #305's own dispatch — Catalog entry 1's categorical claim scoped, and the Worker/Reviewer disagreement recorded.** Entry 1 asserted a bare `case`/`esac` guard is refused categorically, evidenced only by the entry-writing Worker's eight-for-eight; that row's own Reviewer had independently reproduced zero-for-three on the same three probe shapes, and the disagreement was never written down. Issue #305's Worker dispatch (`isolation: 'worktree'`) re-ran the same three shapes and got three-for-three refused, matching the original Worker. The two-observer disagreement plus a candidate discriminator (the `isolation: 'worktree'` dispatch option, set for the Worker's `agent()` call in `workflow-driver.md` and not for the Reviewer's) are now recorded in entry 1 itself, and the categorical claim is scoped to a `isolation: 'worktree'` dispatch rather than left unscoped. Issue #305's own Reviewer independently re-runs the same three probes as the second observer for this measurement; append its result to entry 1 rather than growing this list.
- **2026-08-01, wave `2026-08-01-shipped-text-and-ops-currency`, disclosure `388.3` — Catalog entry 1 gains a fifth station, a second working remedy alongside station 4's host re-query.** A Worker confirming both arms of the release workflow's version routing `select` hit the bare `case`/`esac` refusal (station 1) and, rather than re-adopting one of the three cataloged dead ends, found a shape not yet on the list: write the snippet to a script file, execute it as `bash <path-to-script>`. Its own stated reasoning — neither fusion nor a `$VAR`-expansion-in-the-command-string shape, since the interpolation happens inside the executed file rather than in the tool-call text the guard matches — is recorded in entry 1 as station 5, scoped to the control-flow case rather than the host-confirmation case station 4 already covers. Reported as a single occurrence; untested against station 2's two shapes (the `if`-guard on a captured variable, the lone `test -n "$VAR"`).
- **2026-08-03, wave `2026-08-03-currency-guards-and-deps-port`, disclosures `381.4` (Worker) and `420.1` (Reviewer) — Catalog gains entry 5, a fourth refused shape: a `for`/`do`/`done` loop.** A Worker probing several issues for a populated dependency list hit a refusal on a bare, unfused `for`/`do`/`done` loop — no capture, no redirect, only the loop variable itself referenced in the body — and re-issued it split per-command, dropping nothing; the Reviewer's disclosure flagged the catalog as not yet recording the shape. Live-reproduced independently at issue #429 (2026-08-09, this file's own dispatch): both a three-iteration and a minimal one-iteration form were refused with the guard's own message, quoted in entry 5; a control probe absent from the original disclosure — a loop whose body never references the loop variable — ran clean, showing the trigger is entry 1's `$VAR`-expansion discriminator applied to a loop's own binding, not the `for`/`do`/`done` construct itself. The split-per-command remedy re-verified clean.

### Entry 1 — the full reproduction record

Live-reproduced repeatedly in this dispatch: a bare, single-statement, entirely unfused `case … esac` — no variable, no `|` alternation, no redirect, no `;;`, even merely *defined* (never invoked) inside a shell function body — was refused every time, deterministically, across eight separate attempts. An equivalent `if`/`elif`/`else`/`fi`, carrying the identical `||`-chained condition, `>&2` message, and `exit 1`, was **not** refused, standing alone:

```bash
# ✗ refused, standing entirely alone — no fusion, no wildcard patterns, no redirect
case "$PR_URL" in
  ''|null|undefined) echo "STOP: PR_URL came back empty" >&2; exit 1 ;;
esac

# ✓ not refused — the identical guard, rewritten without case/esac
if [ -z "$PR_URL" ] || [ "$PR_URL" = "null" ] || [ "$PR_URL" = "undefined" ]; then
  echo "STOP: PR_URL came back empty — host-pr create produced no url. NOT reporting an empty prUrl." >&2
  exit 1
fi
```

**Scoped claim, replacing the unscoped one:** a bare `case`/`esac` guard — any of the three probed shapes below — is refused categorically **from a dispatch that carries `isolation: 'worktree'`** (the Worker role, and by the same driver-code reasoning, any other role a Coordinator dispatches with that option set). It is **not** established as refused — and has been directly observed clean — from a dispatch that does not carry that option (the Reviewer role, as currently dispatched by `workflow-driver.md`).

Splitting the capture from the guard (the fix this catalog would have named from the disclosure's summary alone) is still correct **and still necessary** — a capture fused onto either the `case`/`esac` or the `if` form above is refused for the ordinary fusion reason this file leads with — but it is not **sufficient**: the `case`-guard half, issued as its own call with nothing fused onto it, is refused on its own.

**That `if`-form rewrite was itself only the second station of four.** It was adopted into `workflow-driver.md`'s Termination step 4 on the strength of the `case`/`esac`-vs-`if` comparison above — and the comparison was sound as far as it went, because the `if` form really is accepted *when its condition names no shell variable*. What that probe pair never tested is the half that turned out to matter: whether the **captured variable** reaches the guard at all. It does not. The full arc is below.

**Two observers, contradictory results — and the discriminator a later measurement found.** The Worker dispatch above that produced the eight-for-eight refusal runs under `isolation: 'worktree'` — `workflow-driver.md`'s dispatch pipeline Stage 1 calls `agent(workerBrief(issue), { isolation: 'worktree', schema: WORKER_REPORT_SCHEMA, … })`. When the row that first wrote this entry went to review, its own Reviewer tried to reproduce the same refusal independently and **could not**: a bare `case`/`esac`, a PR-URL-shaped guard, and the catalogued form above all ran clean in that Reviewer's own dispatch — zero refusals across three probe shapes. The catalog, at that point, recorded only the Worker's eight-for-eight and asserted categoricity; the Reviewer's contradicting zero-for-three was never written down. That gap is what issue #305 measures.

Issue #305's own Worker dispatch (this worktree, `isolation: 'worktree'`) re-ran the same three probe shapes the Reviewer had used — a bare `case`/`esac`, a PR-URL-shaped guard, and the catalogued form verbatim — as three separate, unfused Bash calls:

```bash
# probe 1 — bare case/esac, minimal form
case "x" in
  x) echo "matched" ;;
esac

# probe 2 — PR-URL-shaped guard, no STOP/exit
case "$PR_URL" in
  '') echo "empty" ;;
esac

# probe 3 — the catalogued form, verbatim
case "$PR_URL" in
  ''|null|undefined) echo "STOP: PR_URL came back empty" >&2; exit 1 ;;
esac
```

All three were refused — **three-for-three**, matching the entry-writing Worker's eight-for-eight rather than that row's Reviewer's zero-for-three. The refusal in every case was the harness's own message, not a permission dialog: *"This agent is isolated in the worktree …, but this command is too complex to verify that it stays inside the worktree; break it into plain, separate commands."*

**The discriminating condition, named with evidence: the `isolation: 'worktree'` dispatch option itself — not the command's shape, its content, or the working directory.** `workflow-driver.md`'s dispatch pipeline sets that option explicitly on the Worker's `agent()` call (Stage 1, `isolation: 'worktree'`) and does **not** set it on the Reviewer's `agent()` call (Stage 3: `agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_SCHEMA` — no `isolation` key at all) — even though `reviewerBrief()`'s own prompt text tells the Reviewer "your own worktree also carries tracked files only," as if the two roles were symmetric. In the one place that actually configures which dispatched agents carry the worktree-isolation guard — the driver's own `agent()` calls — they are not: the option is set for the Worker only. That asymmetry is consistent with every data point gathered so far: the entry-writing Worker (`isolation` set, 8/8 refused), that row's Reviewer (`isolation` not set, 0/3 refused), and issue #305's own Worker (`isolation` set, 3/3 refused). Issue #305's own gap description additionally reports a later wave observing four independent Worker-side refusals of the same shape — Worker-side, so consistent with `isolation: 'worktree'` being set — but that wave is not named with a slug or disclosure id accessible from this dispatch, so its count is reported here as background, not independently re-verified.


**Appended, per that instruction (wave `2026-07-30-hitl-gate-and-guards`, disclosure `305.1`):** issue #305's own Reviewer for this measurement row re-ran the identical three probe shapes — bare `case`/`esac`, the PR-URL-shaped guard, and the catalogued form verbatim — in its own dispatch, which carries no `isolation: 'worktree'` option (the same absence `workflow-driver.md`'s Stage 3 `agent()` call has always had). Result: **0 of 3 refused**, matching the earlier Reviewer's zero-for-three rather than either Worker's three-for-three/eight-for-eight, and confirming — as a second independent observation, not merely a repeat of the first — that the `isolation: 'worktree'` dispatch option is the discriminator this entry names, not the command's shape, its content, or the working directory.

### The evidence arc — five stations, three of them dead ends

Each station below was adopted as *the* fix, shipped into the Worker brief, and then failed in the field. They are recorded together because the sequence is the finding: three plausible remedies for "the guard is refused" all left the guard unable to run, and the reason is the same one each time — **the guard was still being asked to inspect a shell variable.**

| # | Shape | What happened | Evidence |
|---|---|---|---|
| 1 | **`case`/`esac` guard** | **REFUSED** by the isolation guard, standing entirely alone | 8/8 (issue #267), 3/3 (issue #305), 4 of 9 rows in wave `2026-07-30-adr-0032-wave-b` (267, 278, 279, 288), 3/3 again here |
| 2 | **Two-call `if` form** — capture in call 1, `if`-guard in call 2 | **INERT, then REFUSED.** Shell state does not survive between Bash calls (the #251 class), so the guard's variable is unset in its own shell; and the isolation guard refuses the guard call outright for referencing a variable it cannot resolve | 5 of 6 Workers in wave `2026-07-31-tier-guidance-and-guards`; re-reproduced here |
| 3 | **One-call fusion** — capture and `if`-guard joined by a newline in a single call | **REFUSED.** Same call, same variable, same refusal — fusion was never the discriminator | reproduced here |
| 4 | **Host re-query** — `host-pr create` bare, then `host-pr status --branch` as a separate read-only confirmation | **WORKS.** No variable crosses anything, because no variable exists | first reached at issue #277 (PR #313), where env-vars-do-not-survive-Bash-calls was diagnosed and `host-pr status` was the resolution; re-verified end-to-end in this dispatch |
| 5 | **Script-file remedy** — write the snippet to a file, execute it as `bash <path-to-script>` | **WORKS**, for genuine local control flow rather than a value check. The `case`/`esac`/`if`/`$VAR` logic lives inside the executed file, never in the Bash tool-call text the guard matches | single occurrence: wave `2026-08-01-shipped-text-and-ops-currency`, disclosure `388.3` (Worker) — untested against station 2's two shapes |

**Live-reproduced in this dispatch (issue #303, 2026-07-31, `isolation: 'worktree'`), probe by probe.** Every line below was issued as its own Bash call; the refusal in each refused case was the harness's own *"too complex to verify that it stays inside the worktree"* message, never a permission dialog.

```bash
# ✗ REFUSED — station 1, bare case/esac (fourth independent confirmation)
case "x" in
  x) echo "matched" ;;
esac

# — station 2, in two calls —
# ✓ accepted (call 1): a bare assignment, nothing referenced
PROBE_VAL=$(echo "hello-probe")
# ✗ REFUSED (call 2): the if-guard on that variable
if [ -z "$PROBE_VAL" ]; then
  echo "EMPTY" >&2
  exit 1
fi
# ✗ REFUSED (call 2, minimal): even the barest reference, no output, no redirect
test -n "$PROBE_VAL"

# ✗ REFUSED — station 3, capture and guard fused into one call
FUSED_VAL=$(echo "hello-probe")
if [ -z "$FUSED_VAL" ]; then
  echo "STOP: came back empty" >&2
  exit 1
fi
```

**The discriminator, isolated by three further probes: a `$VAR` expansion, not the control structure, not the fusion, not the redirect.** The refusal message's closing hint (*"without the redirect"*) is boilerplate and misleads here — a redirect is neither necessary nor sufficient for the refusal:

```bash
# ✓ ACCEPTED — a multiline `if` whose condition is a COMMAND, not a variable
if jq -e -r '.url' probe-capture.json > /dev/null; then
  echo "url present"
fi

# ✗ REFUSED — the same multiline `if`, with a variable in the condition,
#   captured in this very call, and with no stderr redirect at all
VAL=$(jq -r '.url' probe-capture.json)
if [ -n "$VAL" ]; then
  echo "url present"
fi

# ✗ REFUSED — a same-call variable in a plain, non-guard position
VAL2=$(jq -r '.url' probe-capture.json)
printf 'captured: %s\n' "$VAL2"
```

So the rule a dispatched role can actually follow: **name no shell variable in the Bash tool-call text.** Three routes satisfy it, but by two different mechanisms — keep them distinct rather than folding all three into one undifferentiated "no variable" rule. Two shapes satisfy it because no variable is named anywhere, in any form, and both are accepted here —

```bash
# ✓ the re-query (station 4) — the source answers again, in this call
<engine.cli> host-pr status --branch <branch>

# ✓ a single command whose EXIT STATUS is the verdict — `jq -e` exits non-zero
#   when the key is absent or null, which is the exact discrimination the
#   retired require_capture guard was written to make
jq -e -r '.url' pr-create.json
```

Its failing branch was observed, not assumed: against a payload carrying `{"ok":false,"error":"boom"}` and no `.url`, `jq -e -r '.url'` printed `null` and exited **1**.

**The third route is station 5, below — accepted by a different mechanism, not a third variable-free shape.** Station 5's script-file remedy still names `$VAR` (its `case`/`esac`, its `if`, whatever the local control flow needs) — it just names it inside a script file's *content*, never inside the Bash *tool-call text* the guard matches. Do not read "name no shell variable" as covering all three uniformly: the first two are accepted because no variable is named anywhere; the third is accepted because the guard only ever inspects the tool-call text, and a file's content is a different string entirely. Reach for the first two when the question is host-side ("what does the source say"); reach for station 5 only for genuine local control flow with no host to ask (see station 5's own scoping note).

**A two-observer disagreement, recorded rather than resolved.** The Coordinator routing evidence that motivated this repair reports that five of six Workers in wave `2026-07-31-tier-guidance-and-guards` succeeded with a **file-based** substitute: capture `host-pr create`'s output to an in-worktree relative-path file, then "guard-and-read it in one self-contained second call (verified including its failing branch)". This dispatch reproduced the first half (a bare `> probe-capture.json` redirect to a relative path is accepted) but **not** the second: the self-contained guard-and-read call was refused here, because the form tried was `PROBE_URL=$(jq -r '.url' probe-capture.json)` followed by an `if` on `$PROBE_URL` — a shell variable, and therefore station 3 wearing a file. The likeliest reconciliation is that those Workers' second call named no variable either; but that is inference, not observation, so it is written as such. **The prescription this catalog carries is the one that survives both accounts**: no shell variable, in any call, in any position — which the `jq -e` form and the re-query both satisfy. (Station 5, below, extends the same prescription to genuine local control flow rather than a value check: the file the logic lives in is not itself a Bash call, so nothing inside it is subject to this rule at all.)

**Occurrence:** issue #303 (2026-07-31), repairing the collision between Convention 12's prescribed remedy and this convention's documented refusal. The Worker-brief Termination step that carried stations 1–3 in turn now carries station 4.

**A fifth station, found later and independently of this arc: move the guard's whole logic off the Bash call entirely.** The file-based substitute two paragraphs above failed because its *second* call still read the captured value through a shell variable — `PROBE_URL=$(jq -r '.url' probe-capture.json)` then an `if` on `$PROBE_URL` — station 3 wearing a file, refused for the same reason station 3 is refused standing alone. Wave `2026-08-01-shipped-text-and-ops-currency` (disclosure `388.3`, Worker) found a form that avoids that failure mode: write the snippet — its `case`/`esac`, its `if`, whatever `$VAR` references the logic needs — to a script file (e.g. via the Write tool, not a Bash heredoc: the write itself is then a different tool call, one the isolation guard never inspects at all), then execute the whole file in a single, flat Bash call, `bash <path-to-script>`. That call names no `case`/`esac` keyword and no `$VAR` — every trigger this entry has catalogued lives inside the file it reads, never in the string the guard matches. The Worker's own stated reasoning, recorded here because it holds up under the rest of this entry: this shape is neither fusion (mechanism (b)'s ordinary trigger) nor a `$VAR`-expansion-in-the-command-string shape (the discriminator isolated above) — the interpolation happens **inside the executed file**, not in the tool-call command text the guard matches.

```bash
# ✓ WORKS — the case/esac lives in the file; the Bash call is a flat `bash <path>`
bash version-routing-probe.sh
```

**Scope it to the control-flow need — station 4 already covers host-side confirmation.** Reach for the re-query (station 4) when the question is "what does the host say": there is nothing local to branch on, so there is nothing worth writing to a file. Reach for the script-file form when the need is genuine local control flow with no host to ask — this occurrence used it to confirm both arms of the release workflow's version routing `select` correctly.

**Single occurrence; the generalization is untested.** Confirmed only for the bare `case`/`esac` shape (station 1). Whether wrapping station 2's two refused shapes — the two-call `if`-guard on a captured variable, and the lone `test -n "$VAR"` — in the same file-and-execute form also works has not been tried. Do not read this entry as clearing either of those; append the result here, per this catalog's own append-in-shape discipline, if a future occurrence tests it.

**Occurrence:** wave `2026-08-01-shipped-text-and-ops-currency`, disclosure `388.3` (Worker). Filed bare per [ADR-0027](../../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md).

### Entry 2 — heredoc spec append, full reproduction

```bash
# ✗ refused, standing alone — heredoc-to-file, JSON body
cat > "$TMPDIR/patch.json" <<'EOF'
{ "sections": { "Acceptance criteria": "…" } }
EOF

# not refused, standing alone — the SAME curly-brace body, captured via command
# substitution instead of landing on a file redirect
PATCH="$(cat <<'EOF'
{ "sections": { "Acceptance criteria": "…" } }
EOF
)"
```

Neither the heredoc syntax alone nor brace content alone is the trigger — live-reproduced as the combination of **a literal `{`/`}` in a heredoc body landing on a `>` file redirect**. This means the disclosure's implied fix ("split it into two calls") is unverified for the actual use case this shape names — [Convention 6](../reference/convention-06-sanctioned-amend-path.md)'s `issue-store amend <id> --patch <json-file>` — because every real patch IS JSON, so every real instance of this shape carries the trigger regardless of fusion. **This dispatch could not establish a verified end-to-end recipe for landing brace-bearing content on disk via a heredoc-to-file redirect within its own time budget, and is not asserting one it did not verify.** `issue-store amend` is a Coordinator-side call — a Worker has no store access from its isolated worktree — and neither `convention-06-sanctioned-amend-path.md` nor any Coordinator-facing compose doc is inside this issue's declared Files; establishing (and then cataloging) the working recipe is left to the next occurrence or a follow-up issue rather than guessed at here.

A third probe from the same fence, standing alone, was NOT refused — a heredoc-to-file body with no curly braces at all:

```bash
# not refused, standing alone — heredoc-to-file, NO curly braces in the body
cat > "$TMPDIR/note.txt" <<'EOF'
plain text, no braces
EOF
```

This shape's occurrence citation is the same one Entry 3 below carries — both were named in the same disclosure.

### Entry 2, corrected 2026-09-21 — the trigger is a brace near the HEAD of the body, and the redirect is not part of it

**What forced the re-reproduction.** Wave `2026-09-16-engine-truth-and-verbs` produced two field
occurrences in one wave (spine disclosures `772.4` and row 755 iteration 1): a Worker's large
`cat >> <spec> <<'EOF'` append was refused, and — for 772 — the identical payload re-issued through
a `python3 - <<'EOF'` append **that redirects to no file** was refused too, while short `python3 -`
heredocs doing an in-place `str.replace` ran. The second of those contradicts the entry above, which
names "redirects straight to a file" as half of its combination. Both Workers recovered through the
file-editing tool, but each discovered the shape by trial. The entry's own rule — reproduce before
you write it down — therefore applied to the correction as much as to the original.

**The dispatch.** 22 probes, issue #869, 2026-09-21, from a Worker dispatch with
`isolation: 'worktree'`. Each probe was its own Bash call with nothing fused onto it, so every
refusal below is about that one command's own shape.

**The refusal text, verbatim, identical across all eleven refusals** — and note it is NOT the string
Entry 5 recorded in 2026-08-09, so the harness's own message has been re-worded since:

> This agent is isolated in the worktree \<worktree-path\>, but this command is too complex to verify that it stays inside the worktree. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Split it into plain, separate commands and run them from \<worktree-path\>.

(The "git operations" clause is still the boilerplate tail Entries 1 and 5 already noted: no probe
below ran a git command.)

#### The recorded refusal string has drifted — and nothing in the engine depends on it

Three recordings of "the" refusal message now sit in this repo, and no two of them are the same
string:

| recorded | wording |
|---|---|
| 2026-08-09 (Entry 5) | `…too complex to verify that it stays inside the worktree; break it into plain, separate commands. Refusing to run it — …git operations must target its own worktree. Run the equivalent from <worktree-path> without the redirect.` |
| 2026-09-21 (Entry 2, above) | `…too complex to verify that it stays inside the worktree. Refusing to run it — …git operations must target its own worktree. Split it into plain, separate commands and run them from <worktree-path>.` |
| 2026-09-22 (this row's dispatch) | `…but this command runs node with a value computed at runtime (the variable TMPDIR) (a computed argument goes after the script or --) where it cannot tell which operand is the program, next to an operand or input computed at runtime in a plain command, so what it runs cannot be shown not to be git. Refusing to run it — …git operations must target its own worktree. Run the plain command from <worktree-path>.` |

Between the first two, the remedy clause moved (from before `Refusing to run it` to after the
git-operations tail), its wording changed (`break it into` → `Split it into … and run them from`),
the clause separator changed (`;` → `.`), and the trailing `without the redirect` clause disappeared.
The third is not a re-wording of a fixed string at all: it is **generated per refused shape**, naming
the offending construct (`the variable TMPDIR`) and the specific reason inline. It was produced
live in this row's own dispatch by `cp <driver> "$TMPDIR/wsi-check.mjs" && node --check …`, and it is
a fourth independent confirmation of Entry 1's `$VAR`-expansion discriminator as a side effect.

**So the drift is a DOCUMENTATION fact, not a live breakage.** Nothing in flotilla matches on this
string. Measured in this dispatch, at the row's anchor commit:

```bash
grep -rl "isolated in the worktree" tools/wave/   # → no matches
grep -rl "Split it into plain"      tools/wave/   # → no matches
grep -rl "too complex to verify"    tools/wave/   # → tools/wave/driver/wave-start-inflight.js
```

The single hit is the driver's Worker- and Reviewer-brief PROSE — clause 11's mechanism (b) and the
Coordinator's own copy — which *describes* the refusal to a human reader in its own words and
performs no matching. The engine proper (`tools/wave/src/**`) contains the phrase zero times: no
parser, no classifier, no test fixture and no skill reads or compares this text. Repo-wide, the only
other occurrences are this file, the reference sibling, and
`evidence/convention-08-secret-safe-briefs.md` — all prose.

**The standing rule this settles:** never write a matcher against the harness's refusal wording, in
the engine or in a hook. It is a moving target across harness versions *and* now demonstrably
shape-dependent within one version. Recognise a refusal by what your call did NOT do — no output, no
exit status, nothing pending — and by this catalog's shapes, never by the words that came back.

**A note on how probe 11 is rendered.** The Catalog entry cites probe 11 as
`` echo '{ "sections": { … } }' `` — byte-identical to the matrix row below, ellipsis included. An
earlier rendering shortened it to `` echo '{ "a": 1 }' ``, a literal no probe ran; the matrix is the
record and the entry now quotes it rather than paraphrasing it.

**The matrix.** "brace at" is the position of the first `{` inside the heredoc BODY (the line after
the `<<'EOF'` line is body line 1). Byte offsets marked ≈ are computed from the command text; the
two unmarked ones were measured with `grep -bo '{'` on the file the accepted probe actually wrote.

| # | shape | braces | brace at | body | result |
|---|---|---|---|---|---|
| 1 | `cat >> <file> <<'EOF'`, plain prose | no | — | 22 B | accepted |
| 2 | `cat >> <file> <<'EOF'`, body is one JSON object | yes | line 1 / byte 0 | 46 B | **refused** |
| 3 | `cat >> <file> <<'EOF'`, long brace-free prose | no | — | 3,309 B | accepted |
| 4 | `python3 - <<'EOF'`, 4-line in-place `str.replace` | no | — | ~150 B | accepted |
| 5 | `python3 - <<'EOF'`, a dict literal on body line 1 | yes | line 1 / byte 0 | ~75 B | **refused** |
| 6 | `PATCH="$(cat <<'EOF' … EOF)"`, the same JSON object | yes | line 1 / byte 0 | 46 B | accepted |
| 7 | `cat <<'EOF'` to **stdout, no redirect at all** | yes | line 1 / byte 0 | 46 B | **refused** |
| 8 | `cat >> <file> <<'EOF'`, markdown `- [ ]` / `- [x]` checkboxes | no (square) | — | 97 B | accepted |
| 9 | `cat >> <file> <<'EOF'`, backticked commands and a `**` glob | no | — | 134 B | accepted |
| 10 | `python3 - <<'EOF'`, interpreter does the append, **no redirect** | no | — | 1,838 B payload | accepted |
| 11 | `echo '{ "sections": { … } }'` — braces, **no heredoc** | yes | n/a | 50 B | accepted |
| 12 | `printf '%s' "$PATCH" > <file>` — a `$VAR` expansion | no | — | — | accepted |
| 13 | `cat >> <file> <<'EOF'`, prose with one brace pair mid-body | yes | line 15 / byte 858 | 1,537 B | accepted |
| 14 | probe 2 re-run verbatim | yes | line 1 / byte 0 | 46 B | **refused** |
| 15 | `cat >> <file> <<'EOF'`, one line: prose then the brace pair | yes | line 1 / ≈35 B | 83 B | **refused** |
| 16 | probe 13's long body with the brace pair moved to body line 1 | yes | line 1 / ≈35 B | ~1,000 B | **refused** |
| 17 | `cat >> <file> <<'EOF'`, six prose lines, blank, brace pair | yes | line 8 / byte 475 | 524 B | accepted |
| 18 | `cat >> <file> <<'EOF'`, three prose lines, blank, brace pair | yes | line 5 / ≈160 B | ~240 B | **refused** |
| 19 | `cat >> <file> <<'EOF'`, ONE ~800-B line, then the brace pair | yes | line 2 / ≈800 B | ~880 B | **refused** |
| 20 | `cat >> <file> <<'EOF'`, five short padding lines, brace pair | yes | line 6 / ≈265 B | ~345 B | **refused** |
| 21 | same, six padding lines | yes | line 7 / ≈318 B | ~400 B | **refused** |
| 22 | same, seven padding lines | yes | line 8 / ≈370 B | ~450 B | **refused** |

**What the matrix establishes.**

- **The redirect target is not part of the trigger — and that rests on TWO legs, not three.**
  Probes 2 and 7 carry the IDENTICAL 46-B body and differ in exactly one thing: probe 2 appends to a
  file, probe 7 writes to stdout with no redirect at all. One body, two destinations, one answer —
  that pair on its own is the whole argument, and it is sound on its own. **Probe 5 is a third
  destination but NOT the same body:** its `python3 -` heredoc carries a ~75-B dict literal, not the
  46-B JSON object, so it cannot isolate the redirect the way the 2/7 pair does. What probe 5
  establishes is the NEXT bullet's point — the tool is not part of the trigger either. Stated as
  "the same body through three destinations" (as this entry's first correction did, and as the
  pull-request body that landed it did) the claim over-reaches by one leg while the conclusion it
  supports does not. This is the half of the old entry that was wrong, and it is the half the field's
  `python3 -` occurrence had already contradicted.
- **The tool is not part of it either** — `cat` and `python3` both refused (probes 2, 5, 7) and both
  ran (probes 1, 3, 4, 8, 9, 10).
- **Size is not the discriminator.** A 3,309-B brace-free append ran (probe 3), as did a 1,838-B
  brace-free interpreter append (probe 10), while a 46-B brace-bearing body refused (probes 2, 14).
  The field's "large appends were refused" reads as a correlation, not the cause. **What is NOT
  excluded:** this dispatch never put a brace-free body larger than 3,309 B in front of the guard, so
  a size threshold somewhere above that is untested, not ruled out.
- **The heredoc matters.** The same braces in a plain single-quoted argument ran (probe 11).
- **"Near the head" has no crisp threshold, and that is the operative finding.** Both accepted
  brace-bearing probes (13, 17) sit at or past body line 8 *and* past 475 B; every refusal falls
  short on at least one of the two — probe 22 at line 8 but ≈370 B, probe 19 at ≈800 B but line 2.
  Two accepted points are far too few to establish a conjunction. What they do establish is the
  negative: **no single-factor threshold fits, so a brace-bearing heredoc cannot be judged safe from
  its own text.** A shape whose refusal you cannot predict is one you stop reaching for.

**The remedy, and why it is not "a better heredoc".** Write the content with the file-editing tool.
It takes the path directly, creates the parent directory, involves no shell at all, and no occurrence
on record has it refused — including the two field occurrences, where both Workers recovered through
exactly that surface. The driver's `workerBrief()` policy clause 11 now names it for every content
write rather than only inside the sidecar-write step, which is the whole point of this correction:
the field cost was two Workers each discovering the working surface by trial.

**Probe 6 is an accepted brace shape and still a dead end.** Capturing the heredoc through a command
substitution (`PATCH="$(cat <<'EOF' … EOF)"`) was accepted here, exactly as the original entry
recorded — but what it produces is a shell variable, and a value cannot be carried from one Bash call
to the next at all (see "Splitting is not always a preceding `cd`"). It buys a capture you cannot
spend.

**One out-of-scope observation, recorded but NOT adopted.** Probe 12 — `printf '%s' "$PATCH" > <file>`,
a `$VAR` expansion in a plain argument position — was **accepted** in this dispatch. Entry 1 states
that any `$VAR` expansion is refused in any position from an `isolation: 'worktree'` dispatch, and
this single datapoint does not reproduce that. Entry 1 is explicitly out of this row's scope, so it
is left exactly as it stands: one probe, in a non-guard position, against a variable that was already
unset, is not grounds to relax a rule that three stations of Entry 1's own arc established — and the
harness message re-wording noted above is a reminder that this guard's behaviour drifts between
versions. **A follow-up that re-runs Entry 1's five stations against the current harness is what would
settle it.** Until then, keep following Entry 1.

**Occurrence:** wave `2026-09-16-engine-truth-and-verbs`, spine disclosures `772.4` and row 755
iteration 1, carved out of issue #800 at triage on 2026-09-21 and re-reproduced at issue #869's own
dispatch.

**Residues closed on 2026-09-22 (issue #911).** The correction above landed with four disclosed
loose ends, each fixed in that one follow-up row rather than carried: (1) the new Worker-brief clause
is now pinned by `tools/wave/src/skill-schema-drift.spec.ts` beside the clause-10 and prUrl pins, on
the shipped driver asset, with a negative control that deletes the clause and watches the pin fail,
and a second render-level pin in `tools/wave/src/compose-driver.spec.ts` on the brief a live dispatch
actually receives; (2) the driver's own sidecar-write step no longer called the refused shape
"heredoc-to-file-with-braces" — the half this entry refuted — and now names the trigger this entry
records; (3) the refusal-string drift is recorded above, together with the measurement that no engine
matcher depends on it; (4) the "same body through three destinations" over-reach is corrected in both
the Catalog entry and the bullet below.

### Entry 3 — heredoc commit message, full reproduction

```bash
# ✗ refused — stage and commit fused across a bare newline
git add file1 file2
git commit -m "$(cat <<'EOF'
docs(conventions): …

EOF
)"
```

Live-reproduced in this dispatch: the heredoc-in-command-substitution form standing alone — `MSG="$(cat <<'EOF' … EOF)"`, including with a curly-brace body — was **not** refused; only the fusion with the preceding stage was. Unfused: `git add file1 file2` as one call; `git commit -m "$(cat <<'EOF' … EOF)"` as the next.

**Occurrence:** Wave `2026-07-30-arm-and-wiring`, coordinator disclosure `256.4` — three named shapes, dispositioned `filed:267`. This dispatch (issue #267, 2026-07-30) live-reproduced all three rather than reconstructing them from the disclosure's summary text alone: shape 1 turned out to be a categorical `case`/`esac` refusal, not a fusion problem; shape 2 turned out narrower than "fusion" and remains only partly resolved; shape 3 confirmed as an ordinary fusion instance, matching the original framing. **Flag any future occurrence against this catalog's own reproduction record, not only against the original disclosure's three-word names** — a name alone under-describes the actual trigger, as shapes 1 and 2 here demonstrate.

### Entry 4 — fused directory-change-plus-test-runner, full reproduction

A Worker's fused `cd <dir> && <test-runner>`-shaped call — a directory change glued onto the verify-gate command that mattered, the exact shape Mechanism A's own "correction" bullets discuss theoretically — was **accepted and ran**: the permission gate raised no dialog, nothing was refused. The Worker re-issued it unfused anyway, per policy, but the acceptance itself is the data point worth keeping: it is a live occurrence of the "over-predicts a dialog" case the per-subcommand rule already names (`cd tools/wave && npm ci`, with a `cd` target inside the working directory and an already-allowlisted command, "can pass") — observed, not merely asserted from the documented rule. It does not weaken the convention — mechanism (b) is unrelated and can still refuse the identical shape outright, unconditionally — but it does mean mechanism (a)'s own trigger is not categorical: any fused command is not guaranteed a dialog, so read the per-subcommand rule as what mechanism (a) actually tests, not "any fusion prompts."

Live-reproduced in wave `2026-07-30-hitl-gate-and-guards` (disclosure `305.2`).

**Occurrence:** Wave `2026-07-30-hitl-gate-and-guards`, disclosure `305.2`.

### Entry 5 — `for`/`do`/`done` loop, full reproduction

```bash
# ✗ refused — the minimal form: one iteration, one line
for n in 371; do echo "probe $n"; done

# ✓ NOT refused — same loop, but the body never references the loop variable
for n in 371 392; do
  true
done
```

**This is not a new discriminator — it is entry 1's `$VAR`-expansion rule, confirmed on a loop's own binding.** A control probe absent from the original disclosure narrows the trigger further than "the `for`/`do`/`done` construct": a loop whose body never references the loop variable (`for n in 371 392; do true; done`) ran clean, not refused. Only once the body expands `$n` — via `echo "$n"`, or even a bare `echo "$n" > /dev/null`— does the guard refuse it. The `for` keyword and the multi-statement `do…done` body are not themselves the trigger; the loop variable is a `$VAR` expansion like any other, and entry 1's finding ("name no shell variable" from an `isolation: 'worktree'` dispatch) already covers it — this entry exists so the next agent recognizes the loop shape on sight instead of re-deriving the same discriminator from scratch.

### Entry 5, continued — dropped probes and remedy

```bash
# ✗ refused — three iterations, the loop variable referenced in the body
for n in 371 392 399; do
  echo "probe issue $n"
done

# ✓ split per-command — the remedy this shape takes, verified clean
echo "probe issue 371"
echo "probe issue 392"
echo "probe issue 399"

```

Live-reproduced in this dispatch (issue #429, 2026-08-09), standing in for the original use case — probing several issue ids for a populated dependency list — with a generic per-id command, since this dispatch has no store access to run the original probe verbatim (the same generic-stand-in practice Catalog entry 1 uses, e.g. its `echo "hello-probe"`). Both the three-iteration form and the minimal single-iteration form were refused with the harness's own message, quoted verbatim (identical across both refusals and a third probe redirecting to `/dev/null`):

> This agent is isolated in the worktree \<worktree-path\>, but this command is too complex to verify that it stays inside the worktree; break it into plain, separate commands. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Run the equivalent from \<worktree-path\> without the redirect.

(The message's "git operations" and "without the redirect" clauses are its boilerplate tail, reused verbatim even though this probe ran no git command and no redirect on the refused forms — the same boilerplate-tail behavior already noted for the `case`/`esac` refusal.)

The split-per-command re-issue — one Bash call per probed id, the loop unrolled — ran clean and dropped nothing, confirmed live in this dispatch: the same remedy this catalog prescribes for every other refused shape applies unchanged here.

**Occurrence:** Wave `2026-08-03-currency-guards-and-deps-port`, disclosures `381.4` (Worker) and `420.1` (Reviewer) — a `for`/`do`/`done` loop probing several issues for a populated dependency list was refused by the worktree-isolation guard; the Worker re-issued it split per-command and dropped nothing. That wave's spine and disclosure text are archived, not tracked, so the quoted refusal message and the no-op control probe above are this dispatch's own live reproduction (issue #429, 2026-08-09) rather than a copy of the original wording — an independent reproduction of the same shape, not a restatement of it.
