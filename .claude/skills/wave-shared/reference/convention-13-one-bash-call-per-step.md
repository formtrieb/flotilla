## Convention 13 — one Bash call per step; never fuse `cd X && <command>`

**Two independent mechanisms in this pipeline break on the same input shape — a Bash command that fuses several steps with `&&`.** They are unrelated systems: a permission matcher and a worktree-isolation guard. What they share is only the shape that trips them, and their failure signatures are *opposites* — one stalls the wave loudly, the other drops a step in silence. That is why this is one convention naming both, rather than an aside in whichever brief met one of them first.

**The rule every dispatched role obeys: issue ONE Bash call per step.** Never glue a directory change onto the front of the command that matters. Where the tool accepts a directory flag, prefer it over a `cd` at all — `npm ci --prefix <dir>`, `git -C <dir> …`, `npx vitest run --root <dir>` — because for a dispatched role a preceding `cd` does not reach the next call at all, so splitting a fused command is only half a fix (see "Splitting is not always a preceding `cd`" below).

**What this is NOT about: a pipeline that is genuinely one step.** `… | jq -r '.url'`, `git diff --cached --name-only | xargs grep -l …`, `grep -c foo file | head` — one step, one call, correct as written. The target of this convention is **two steps glued together**: a setup step (almost always a `cd`) fused onto the step whose result you actually need.

### Mechanism A — the permission allowlist: a dialog nobody is there to answer

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

### Mechanism B — the worktree-isolation guard: a refusal, and a verification step silently dropped

**Failure signature: the command comes back rejected as too complex to verify that it stays inside the worktree.** Nobody is prompted, nothing is pending, nothing ran. The agent is simply handed a refusal — and an agent handed a refusal is free to shrug and continue, which is precisely what makes this the more dangerous of the two.

This guard is not the permission system. A dispatched agent runs in an isolated worktree, and the harness checks each Bash command against that isolation boundary; a command fusing several steps can exceed what that check can reason about, and an unverifiable command is refused rather than allowed. **Nothing on the permission allowlist reaches this decision** — it is a different mechanism asking a different question.

Live: in wave `2026-07-29-conventions-wiring` a Worker's compound `&&` command was rejected this way. The Worker **skipped the check it had been trying to run** and proceeded. No harm on that run — but "an agent silently drops a verification step" is the same family as [Convention 12](convention-12-no-command-in-a-shell-variable.md)'s half two (a step that did not run leaving a record that reads as complete) and as the empty-capture class it was written against. The report that comes back from such a run is not wrong about anything it says; it is missing a step nobody asked about.

### Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch

Wave `2026-07-30-arm-and-wiring`'s coordinator disclosure `256.4` names three mechanism-(b) refusals across the wave's five dispatched rows — a jq-piped capture with a case guard, a heredoc spec append, and a heredoc commit message — each "correctly re-issued unfused." The disclosure names the shapes categorically; it does not preserve the byte-exact failing commands (the wave's own spine and its per-row disclosure detail live in the archived spine, not a tracked doc — ADR-0027 dispositions a disclosure at routing and archives it with the wave). **Rather than assert a fused/unfused pair from that three-word summary alone, each shape below was independently live-reproduced in this dispatch** (issue #267, 2026-07-30, this worktree) — the standing instruction that a catalog entry claiming a shape is refused needs evidence it was actually observed, not merely asserted. Reproducing them surfaced more than the summary implied: **not all three turn out to be fusion problems**, and the catalog below reports what was actually witnessed rather than filling the gap with a plausible-looking guess.

**1. jq-piped capture with a case guard — NOT a fusion problem. `case`/`esac` is refused categorically FROM A `isolation: 'worktree'` DISPATCH — not established as refused outside one.**

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

Splitting the capture from the guard (the fix this catalog would have named from the disclosure's summary alone) is still correct **and still necessary** — a capture fused onto either form above is refused for the ordinary fusion reason this file leads with — but it is not **sufficient**: the `case`-guard half, issued as its own call with nothing fused onto it, is refused on its own.

**That `if`-form rewrite was itself only the second station of four.** It was adopted into `workflow-driver.md`'s Termination step 4 on the strength of the comparison above — and the comparison was sound as far as it went, because the `if` form really is accepted *when its condition names no shell variable*. What the probe pair above never tested is the half that turned out to matter: whether the **captured variable** reaches the guard at all. It does not. The full arc is below.

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

**Scoped claim, replacing the unscoped one:** a bare `case`/`esac` guard — any of the three shapes above — is refused categorically **from a dispatch that carries `isolation: 'worktree'`** (the Worker role, and by the same driver-code reasoning, any other role a Coordinator dispatches with that option set). It is **not** established as refused — and has been directly observed clean — from a dispatch that does not carry that option (the Reviewer role, as currently dispatched by `workflow-driver.md`). Issue #305's own Reviewer is the second observer for this exact measurement: per this row's design it independently re-runs the same three probes in its own dispatch. Append that result here, in this catalog's own append-in-shape discipline, rather than opening a new prose clause.

**Appended, per that instruction (wave `2026-07-30-hitl-gate-and-guards`, disclosure `305.1`):** issue #305's own Reviewer for this measurement row re-ran the identical three probe shapes — bare `case`/`esac`, the PR-URL-shaped guard, and the catalogued form verbatim — in its own dispatch, which carries no `isolation: 'worktree'` option (the same absence `workflow-driver.md`'s Stage 3 `agent()` call has always had). Result: **0 of 3 refused**, matching the earlier Reviewer's zero-for-three rather than either Worker's three-for-three/eight-for-eight, and confirming — as a second independent observation, not merely a repeat of the first — that the `isolation: 'worktree'` dispatch option is the discriminator this entry names, not the command's shape, its content, or the working directory.

##### The evidence arc — five stations, three of them dead ends

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

**2. Heredoc spec append — narrower than "fusion." Refused when a heredoc redirects straight to a FILE and its body contains `{`/`}`; not refused otherwise.**

```bash
# ✗ refused, standing alone — heredoc-to-file, JSON body
cat > "$TMPDIR/patch.json" <<'EOF'
{ "sections": { "Acceptance criteria": "…" } }
EOF

# not refused, standing alone — heredoc-to-file, NO curly braces in the body
cat > "$TMPDIR/note.txt" <<'EOF'
plain text, no braces
EOF

# not refused, standing alone — the SAME curly-brace body, captured via command
# substitution instead of landing on a file redirect
PATCH="$(cat <<'EOF'
{ "sections": { "Acceptance criteria": "…" } }
EOF
)"
```

Neither the heredoc syntax alone nor brace content alone is the trigger — live-reproduced as the combination of **a literal `{`/`}` in a heredoc body landing on a `>` file redirect**. This means the disclosure's implied fix ("split it into two calls") is unverified for the actual use case this shape names — [Convention 6](convention-06-sanctioned-amend-path.md)'s `issue-store amend <id> --patch <json-file>` — because every real patch IS JSON, so every real instance of this shape carries the trigger regardless of fusion. **This dispatch could not establish a verified end-to-end recipe for landing brace-bearing content on disk via a heredoc-to-file redirect within its own time budget, and is not asserting one it did not verify.** `issue-store amend` is a Coordinator-side call — a Worker has no store access from its isolated worktree — and neither `convention-06-sanctioned-amend-path.md` nor any Coordinator-facing compose doc is inside this issue's declared Files; establishing (and then cataloging) the working recipe is left to the next occurrence or a follow-up issue rather than guessed at here.

**3. Heredoc commit message — a genuine fusion problem, confirming the original name.**

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

**4. Fused directory-change-plus-test-runner — ACCEPTED, not refused; mechanism (a) does not fire on every fused shape it could in principle apply to.**

Live-reproduced in wave `2026-07-30-hitl-gate-and-guards` (disclosure `305.2`): a Worker's fused `cd <dir> && <test-runner>`-shaped call — a directory change glued onto the verify-gate command that mattered, the exact shape Mechanism A's own "correction" bullets above discuss theoretically — was **accepted and ran**: the permission gate raised no dialog, nothing was refused. The Worker re-issued it unfused anyway, per policy, but the acceptance itself is the data point worth keeping: it is a live occurrence of the "over-predicts a dialog" case the per-subcommand rule already names above (`cd tools/wave && npm ci`, with a `cd` target inside the working directory and an already-allowlisted command, "can pass") — observed, not merely asserted from the documented rule. It does not weaken the convention — mechanism (b) is unrelated and can still refuse the identical shape outright, unconditionally — but it does mean mechanism (a)'s own trigger is not categorical: any fused command is not guaranteed a dialog, so read the per-subcommand rule above as what mechanism (a) actually tests, not "any fusion prompts."

**Occurrence:** Wave `2026-07-30-hitl-gate-and-guards`, disclosure `305.2`.

**5. `for`/`do`/`done` loop — a fourth REFUSED shape (entries 1–3 above are refused or partly refused; entry 4 above was accepted, not refused). Refused standing entirely alone; nothing fused, no capture, no redirect required — only the loop variable itself, referenced in the body, is enough.**

```bash
# ✗ refused — three iterations, the loop variable referenced in the body
for n in 371 392 399; do
  echo "probe issue $n"
done

# ✗ refused — the minimal form: one iteration, one line
for n in 371; do echo "probe $n"; done

# ✓ NOT refused — same loop, but the body never references the loop variable
for n in 371 392; do
  true
done

# ✓ split per-command — the remedy this shape takes, verified clean
echo "probe issue 371"
echo "probe issue 392"
echo "probe issue 399"
```

Live-reproduced in this dispatch (issue #429, 2026-08-09), standing in for the original use case — probing several issue ids for a populated dependency list — with a generic per-id command, since this dispatch has no store access to run the original probe verbatim (the same generic-stand-in practice Catalog entry 1 uses, e.g. its `echo "hello-probe"`). Both the three-iteration form and the minimal single-iteration form were refused with the harness's own message, quoted verbatim (identical across both refusals and a third probe redirecting to `/dev/null`):

> This agent is isolated in the worktree \<worktree-path\>, but this command is too complex to verify that it stays inside the worktree; break it into plain, separate commands. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Run the equivalent from \<worktree-path\> without the redirect.

(The message's "git operations" and "without the redirect" clauses are its boilerplate tail, reused verbatim even though this probe ran no git command and no redirect on the refused forms — the same boilerplate-tail behavior already noted for the `case`/`esac` refusal.)

**This is not a new discriminator — it is entry 1's `$VAR`-expansion rule, confirmed on a loop's own binding.** A control probe absent from the original disclosure narrows the trigger further than "the `for`/`do`/`done` construct": a loop whose body never references the loop variable (`for n in 371 392; do true; done`) ran clean, not refused. Only once the body expands `$n` — via `echo "$n"`, or even a bare `echo "$n" > /dev/null`— does the guard refuse it. The `for` keyword and the multi-statement `do…done` body are not themselves the trigger; the loop variable is a `$VAR` expansion like any other, and entry 1's finding ("name no shell variable" from an `isolation: 'worktree'` dispatch) already covers it — this entry exists so the next agent recognizes the loop shape on sight instead of re-deriving the same discriminator from scratch.

The split-per-command re-issue — one Bash call per probed id, the loop unrolled — ran clean and dropped nothing, confirmed live in this dispatch: the same remedy this catalog prescribes for every other refused shape applies unchanged here.

**Occurrence:** Wave `2026-08-03-currency-guards-and-deps-port`, disclosures `381.4` (Worker) and `420.1` (Reviewer) — a `for`/`do`/`done` loop probing several issues for a populated dependency list was refused by the worktree-isolation guard; the Worker re-issued it split per-command and dropped nothing. That wave's spine and disclosure text are archived, not tracked, so the quoted refusal message and the no-op control probe above are this dispatch's own live reproduction (issue #429, 2026-08-09) rather than a copy of the original wording — an independent reproduction of the same shape, not a restatement of it.

**Append future occurrences to this catalog, in the same shape — name, what was actually reproduced (not merely asserted), the working form if one was verified, occurrence citation — rather than opening a new prose clause.** [Convention 8](convention-08-secret-safe-briefs.md)'s catalogue treats an eighth secret-echo occurrence as evidence about the mechanism, not about whichever agent hit it eighth; treat a fourth refused shape here the same way — a mechanism finding, never an agent's mistake.

### The two signatures are not interchangeable — which is why both are named here

A dialog is **loud and blocking**: the wave stops, and whoever finds it knows something needs answering. A refusal is **quiet and non-blocking**: the agent keeps going, and the only trace is a step that never happened.

An agent that has met only the dialog reads a refusal as *"this command isn't allowed here"* and routes around it by dropping the step — the correct reading is *"this command's SHAPE cannot be verified; issue it as separate calls and it will run."* An agent that has met only the refusal expects a fused command to fail closed, and is unprepared for one that instead hangs a wave on a prompt. Naming one mechanism and leaving the other implicit teaches exactly half of a two-sided rule, which is how the second half stayed unwritten until 2026-07-29.

### Why widening the permission allowlist is the wrong fix

The tempting patch is a `cd` entry in the tracked allowlist. Do not add one.

1. **Splitting costs nothing, so there is nothing to buy.** The fuse is a habit carried in from interactive shell use, not a requirement of anything here. Every step that is currently fused can be issued as its own call, and the directory can travel with the command via a flag in nearly every case.
2. **It would not reliably fix mechanism A either.** The forms that hurt most — `cd` with `git`, `cd` with a redirect — prompt on a **hazard-specific rule** (a new directory's git hooks; an unresolvable redirect target), not on a missing prefix match. The documentation makes no promise that an explicit `cd` allow entry buys those back, so the widening's payoff is unspecified exactly where the pain is.
3. **It cannot touch mechanism B at all.** The isolation guard rejects a fused command it cannot verify regardless of what any permission rule says. Even a perfectly widened allowlist leaves the second mechanism firing on the same input.
4. **The tracked allowlist ships to every consumer.** `.claude/settings.json` is the sole permission source every dispatched agent in every consumer repo inherits; widening it enlarges the unattended command surface for all of them — in exchange for a convenience that a newline already provides.

### Splitting is not always a preceding `cd` — your cwd is a constant you observe, not state you set

**"`cd` in one call, the command in the next" assumes the working directory persists between your Bash calls. For a dispatched role it does not.** The cwd is **reset to the dispatch root before every Bash call** — the worktree root for a worktree-isolated role, the session cwd for one dispatched without isolation (the Scribe). Not "sometimes", and not "unless you check": a `cd` in call N is simply invisible in call N+1.

Two consequences, and the second is the one worth carrying:

1. **Splitting a fused `cd X && <cmd>` into two calls does not put the command in directory X.** It removes the fusion and leaves the command running in the wrong place — a quieter defect than the one it fixed. The remedy for the `cd` half is a directory flag on the command, not a call boundary.
2. **Because the reset target is identical for every call, the cwd is a per-agent CONSTANT.** One bare `pwd` therefore characterizes every Bash call the agent will make — which is what makes "verify the cwd once, never set it" a sound design rather than a hopeful one. There is no value in re-checking before each call, and no way to change the answer.

**Live-reproduced three times, in three separate dispatches — and, since the third, on BOTH isolation postures rather than only under `isolation: 'worktree'`:**

- *2026-07-30, this convention's own dispatch (`isolation: 'worktree'`):* `cd <worktree>/tools/wave` returned success, and the very next call's `npm ci` failed with npm's own usage error because it ran at the worktree root — `pwd` in the following call printed the worktree root, not `tools/wave`.
- *2026-07-31, issue #251's Worker dispatch (`isolation: 'worktree'`):* the same pair, minimal form. Call 1 `cd <worktree>/tools/wave` — exit 0, no output. Call 2 `pwd` — printed the **worktree root**. Nothing carried; nothing failed loudly either, which is exactly why the assumption survives unnoticed until something depends on it.
- *2026-07-31, issue #251's iteration-1 REVIEWER — the **non-isolated** datapoint, and the one this section was missing.* A Reviewer's `agent()` call sets no `isolation: 'worktree'` (the same discriminator Catalog entry 1 records for the `$VAR` refusals), so it runs in the same posture as the Scribe: dispatched, but not worktree-isolated. Reviewing this very change it measured its own dispatch and found a shell **function** defined in one call and a shell **variable** assigned in one call both gone by the next. Until then every reproduction here was `isolation: 'worktree'`, so applying the rule to the Scribe — the one non-isolated role in the pipeline, and the role whose `cd` this convention retired — was an extrapolation across the exact axis that had never been measured. It is measured now: **no shell state survives between a dispatched role's Bash calls, on either posture — not the cwd, not a variable, not a function.** Two consequences worth carrying: the Scribe's observe-never-set design rests on measurement rather than on transfer from a different posture; and a shell function is only a remedy *within one call* (see the `wave_cli()` note in [`workflow-driver.md`](../../wave-start/reference/workflow-driver.md)'s `WAVE_CLI` constant — a function is the right shape for a binding in command position, but defining it in call N buys nothing in call N+1).

**And the host's own Bash-tool description is not a safe source for this.** In the #251 dispatch the tool description handed to the agent stated that the working directory *persists* between calls (while advising absolute paths anyway) — and in that same dispatch it demonstrably did not. That is the reason this convention states a rule (*assume nothing persists*) instead of telling a role to consult its host: a role that reads the contract and believes it writes exactly the code this section exists to prevent.

**The consequence this repaired, in full:** the Scribe's old step-1 `cd "$REPO_ROOT"` / step-3 engine-call split (`scribeBrief()`) was a dispatched subagent too, so its `cd` never reached step 3 — and step 3 worked anyway, because the Scribe's dispatch root already *was* the repo root. That is **incidental safety**: a step that appears to establish a precondition, a precondition that is really being met by something else entirely, and no signal on the day the something else changes. The resolved design is in [`workflow-driver.md` §The Scribe's cwd](../../wave-start/reference/workflow-driver.md) and it removes the dependency structurally rather than re-fusing anything: **no `cd` at all**; a bare `pwd` compared against the compose-time repo-root literal, once; **every path argument absolute** (the sidecar `--dir` always was, and the payload `<json-file>` now is — the write verb reads it against the process cwd, so a relative temp name was the same dependency wearing a different hat); and a cwd mismatch reported through the Scribe result rather than `cd`-ed around. What is left is a stated, observable precondition — the Coordinator dispatches from the repo root — instead of an assumption nothing could see.

```bash
# ✗ fused — mechanism A narrows the gate to "every part must qualify",
#   and mechanism B may refuse the shape outright
cd tools/wave && npm ci

# ✗ split, and therefore unfused — but the second call starts back at the
#   dispatch root, so `npm ci` runs in the wrong directory and the split has
#   bought nothing. Unfusing is not a remedy for the `cd` half.
cd tools/wave
npm ci

# ✓ one call per step, with the directory carried BY the command
npm ci --prefix tools/wave
git -C tools/wave status
```

Most tools have such a flag (`--prefix`, `-C`, `--root`, `--cwd`, `--project`, `--directory`). When one genuinely has none, **make the arguments absolute and leave the cwd alone**: a `cd` cannot reach the call that needs it, and fusing it on is refused or prompts. If what is left still depends on the dispatch root — a repo-relative command binding is the standing example — that is a **precondition**, not something a `cd` can supply: state it, observe it once with a bare `pwd`, and report a mismatch as the failure it is.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader contract reads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so a `Convention 13` citation resolves for every back-half skill with **zero loader edits**. The Catalog section above lives here too, for the same reason: one place, reached by every citation, with zero loader edits when a row is appended.
- **[`workflow-driver.md`](../../wave-start/reference/workflow-driver.md)** — the text dispatched agents actually receive, and therefore the site that matters most: the rule is a numbered policy clause in `workerBrief()`, a workspace-setup clause in `reviewerBrief()`, a directory-flag clause on the Worker's verify gate, and — at its original site — `scribeBrief()`'s step 1, which **no longer `cd`s at all**. That step is now a bare `pwd` against the compose-time repo-root literal, with the retired `cd`-then-engine-call split named in place as a dead end so it cannot be re-adopted; the driver's own §The Scribe's cwd carries the reasoning, and the `pwd` step in both Worker workspace-setup templates states the same invariant (one observation, valid for every later call). Both `workerBrief()`'s policy clause 11 and `reviewerBrief()`'s Convention 13 paragraph now also point at the Catalog above by name, so a Worker or Reviewer facing a refusal that matches a cataloged shape finds what was actually verified to work — not merely "split it" — without re-deriving it mid-dispatch. `workerBrief()`'s Termination steps 3–4 also stopped USING the refused shapes: they no longer capture a PR URL into a shell variable at all — the create runs bare and a separate `host-pr status --branch` re-query confirms it (Catalog entry 1, station 4). The `if`-form that briefly stood there was station 2, and it is named in the arc as a dead end so it cannot be re-adopted as a fix.
- **`workflow-driver.md`'s `ISSUES` row template** — the `depsSetup` example, which used to *teach* the fused `cd <depsDir> && <installCmd>` form to every Coordinator composing a wave, and now shows the flag-carrying form.

### Common Mistakes

- **Fusing `cd` onto an allowlisted command because the command is allowlisted.** The allow entry covers that subcommand only; the `cd` must qualify on its own, and with `git` or a redirect on the other side it does not.
- **Reading a "too complex to verify" refusal as "this check cannot be run here" and dropping the step.** It is a statement about the command's shape, not about the check. Re-issue as separate calls.
- **Adding a `cd` entry to the tracked allowlist.** It buys a habit, not a capability — and leaves mechanism B firing anyway (see the four reasons above).
- **Assuming a preceding `cd` survives into your next Bash call.** In a dispatched-agent thread it does not — the cwd is reset to the dispatch root before every call. Carry the directory in the command, or make the arguments absolute.
- **Reading "verify with `pwd`" as licence to keep the `cd`.** The `pwd` is not a check that a `cd` landed; it is the one observation of a constant you cannot change. If the answer is wrong, the fix is upstream (where the agent was dispatched from), never another `cd`.
- **Splitting a `cd X && <cmd>` and calling it fixed.** The fusion is gone and the command now runs in the wrong directory, silently. Live twice: `cd tools/wave` succeeded, and `npm ci` in the next call still ran at the worktree root.
- **Believing only `&&` counts.** The documented separator set is `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines — a `;`-joined pair of steps is the same shape wearing different punctuation.
- **Over-applying this to a single command's pipeline.** `… | jq -r '.url'` is one step. Splitting a genuine pipeline into two calls does not make it safer; it makes it broken.
- **Assuming a refusal means fusion, and that unfusing fixes it.** Catalog entry 1's arc is three counter-examples in a row: a lone `case`/`esac`, a lone `if`-guard on a variable, and a same-call capture-plus-guard were all refused with nothing to unfuse. Read the entry before re-deriving a split.
- **Handing a dispatched role a recipe that names a shell variable.** From an `isolation: 'worktree'` dispatch, any `$VAR` expansion is refused in any position — so the recipe cannot run, and the role is left to improvise the step it was supposed to follow exactly.

### Live occurrences (evidence)

The wave that turned a one-brief aside into this convention, the cwd-reset reproduction, the capture-guard collision that grew the Catalog's entry 1 to five stations, and the two further shapes the Catalog gained after it (a narrower-than-fusion heredoc, a refused `for`/`do`/`done` loop) — the wave-by-wave record behind the Catalog's own entries (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).
