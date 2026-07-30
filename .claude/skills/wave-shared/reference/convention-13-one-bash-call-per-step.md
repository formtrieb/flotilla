## Convention 13 — one Bash call per step; never fuse `cd X && <command>`

**Two independent mechanisms in this pipeline break on the same input shape — a Bash command that fuses several steps with `&&`.** They are unrelated systems: a permission matcher and a worktree-isolation guard. What they share is only the shape that trips them, and their failure signatures are *opposites* — one stalls the wave loudly, the other drops a step in silence. That is why this is one convention naming both, rather than an aside in whichever brief met one of them first.

**The rule every dispatched role obeys: issue ONE Bash call per step.** Never glue a directory change onto the front of the command that matters. Where the tool accepts a directory flag, prefer it over a `cd` at all — `npm ci --prefix <dir>`, `git -C <dir> …`, `npx vitest run --root <dir>` — because a preceding `cd` does not survive into the next call in every context (see "Splitting is not always a preceding `cd`" below).

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

**1. jq-piped capture with a case guard — NOT a fusion problem. `case`/`esac` is refused categorically.**

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

Splitting the capture from the guard (the fix this catalog would have named from the disclosure's summary alone) is still correct **and still necessary** — a capture fused onto either form above is refused for the ordinary fusion reason this file leads with — but it is not **sufficient**: the `case`-guard half, issued as its own call with nothing fused onto it, is refused on its own. `workflow-driver.md`'s Termination step 4 now uses the `if` form for exactly this reason, not only a two-call split.

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

### Splitting is not always a preceding `cd` — check whether your cwd survives

**"`cd` in one call, the command in the next" assumes the working directory persists between your Bash calls, and that assumption is host-context-dependent.** In an interactive Coordinator session it does persist. In a **dispatched-subagent thread it does not**: the agent-thread contract states the cwd is reset between Bash calls, and that absolute paths are therefore the only reliable form.

Observed live in this convention's own dispatch, as two separate calls: `cd <worktree>/tools/wave` returned success, and the very next call's `npm ci` failed with npm's own usage error because it ran at the worktree root — `pwd` in the following call printed the worktree root, not `tools/wave`. The split was correct and *still* did not put the command in the right directory.

**One consequence worth knowing before you rely on a `cd`:** the Scribe's step-1 `cd "$REPO_ROOT"` / step-3 engine-call split (`scribeBrief()`) is a dispatched subagent too, so its `cd` is not guaranteed to reach step 3 either. That split is safe today for a different reason — the default `WAVE_CLI` is a **path-free** package invocation and the sidecar `--dir` is **absolute**, so nothing in step 3 depends on the cwd the `cd` was meant to establish. A consumer that swaps `WAVE_CLI` to the repo-relative vendored fallback loses that safety net, and the remedy is still not to re-fuse: make the invocation cwd-independent, or verify the cwd with `pwd` first.

```bash
# ✗ fused — mechanism A narrows the gate to "every part must qualify",
#   and mechanism B may refuse the shape outright
cd tools/wave && npm ci

# ✗ split, but relies on a cwd a dispatched agent does not keep
cd tools/wave
npm ci

# ✓ one call per step, with the directory carried BY the command
npm ci --prefix tools/wave
git -C tools/wave status
```

Most tools have such a flag (`--prefix`, `-C`, `--root`, `--cwd`, `--project`, `--directory`). When one genuinely has none, a `cd` as its own call is still the correct form in a context whose cwd persists — **verify it with a `pwd` rather than assuming it**, and never buy the guarantee back by re-fusing.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader contract reads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so a `Convention 13` citation resolves for every back-half skill with **zero loader edits**. The Catalog section above lives here too, for the same reason: one place, reached by every citation, with zero loader edits when a row is appended.
- **[`workflow-driver.md`](../../wave-start/reference/workflow-driver.md)** — the text dispatched agents actually receive, and therefore the site that matters most: the rule is a numbered policy clause in `workerBrief()`, a workspace-setup clause in `reviewerBrief()`, and — at its original site — `scribeBrief()`'s step 1, now stating the per-subcommand mechanism and citing this convention instead of carrying the whole rationale as an aside addressed to one role. Both `workerBrief()`'s policy clause 11 and `reviewerBrief()`'s Convention 13 paragraph now also point at the Catalog above by name, so a Worker or Reviewer facing a refusal that matches a cataloged shape finds what was actually verified to work — not merely "split it" — without re-deriving it mid-dispatch. `workerBrief()`'s Termination step 4 also stopped USING the refused shape: its `require_capture`-style guard is now the `if`-form Catalog entry 1 verified, not the `case`-form entry 1 names as refused.
- **`workflow-driver.md`'s `ISSUES` row template** — the `depsSetup` example, which used to *teach* the fused `cd <depsDir> && <installCmd>` form to every Coordinator composing a wave, and now shows the flag-carrying form.

### Common Mistakes

- **Fusing `cd` onto an allowlisted command because the command is allowlisted.** The allow entry covers that subcommand only; the `cd` must qualify on its own, and with `git` or a redirect on the other side it does not.
- **Reading a "too complex to verify" refusal as "this check cannot be run here" and dropping the step.** It is a statement about the command's shape, not about the check. Re-issue as separate calls.
- **Adding a `cd` entry to the tracked allowlist.** It buys a habit, not a capability — and leaves mechanism B firing anyway (see the four reasons above).
- **Assuming a preceding `cd` survives into your next Bash call.** In a dispatched-agent thread it does not. Carry the directory in the command, or verify with `pwd`.
- **Believing only `&&` counts.** The documented separator set is `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines — a `;`-joined pair of steps is the same shape wearing different punctuation.
- **Over-applying this to a single command's pipeline.** `… | jq -r '.url'` is one step. Splitting a genuine pipeline into two calls does not make it safer; it makes it broken.

### Live occurrences (evidence)

- **2026-07-29, wave `2026-07-29-conventions-wiring`, disclosure `184.5` — mechanism B, first written down.** A Worker's compound `&&` command was rejected as too complex to verify staying inside the worktree; the Worker skipped the check it was running and continued. Captured at verdict-routing per [ADR-0027](../../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md); the disclosure text, the Worker report and the Reviewer verdict live in that wave's spine and sidecars. This is the occurrence that turned a one-brief aside into a convention.
- **Mechanism A, on our own allowlist.** The Scribe path is where this was first hit and first documented — a `cd "$REPO_ROOT"` fused onto the engine call that writes the sidecar, against a tracked allowlist that covers the engine call exactly. Same class as the KW-F6 sandbox footgun in [Convention 1](convention-01-auth-preflight.md), where `env -u GITHUB_TOKEN gh …` slips a `gh *` prefix rule because the command the matcher parses is not the one the rule names: a wrapper or a fused step in front of an allowlisted command is not covered by that command's entry.
- **2026-07-30, this convention's own dispatch — the cwd-reset half.** `cd <worktree>/tools/wave` in one call, `npm ci`'s usage error in the next, `pwd` back at the worktree root in the third. Recorded because the obvious remedy for a fused command ("just split it") is incomplete on the exact path a Worker runs on, and an incomplete remedy is how a rule earns a reputation for not working.
- **2026-07-30, wave `2026-07-30-arm-and-wiring`, coordinator disclosure `256.4` — mechanism B, three refusals, one wave; live-reproduced at issue #267's own dispatch.** The disclosure named three shapes (jq-piped capture with a case guard, heredoc spec append, heredoc commit message), each "correctly re-issued unfused." The Catalog above reports what live reproduction in this dispatch actually found: shape 1 is a categorical `case`/`esac` refusal, not fusion; shape 2 is narrower than fusion and only partly resolved; shape 3 confirmed as ordinary fusion. This is the occurrence the Catalog section exists to hold, and future refusals append there rather than growing this list.
