## Convention 12 — never hold a command in a shell variable, and never let an empty capture flow onward

Two failures chained, and only the first one is about shells. **An invocation form that silently does nothing**, and **a caller that accepts nothing as an answer.** The first has broken a wave five times. The second is the one that turns a failed command into a corrupted record — and it is the half that holds regardless of which shell is live, which is why it, not the shell trivia, is the structural half of this convention.

> **Promotion (ADR-0034, doctrine-budget grill 2026-08-09).** Half one is now **structurally guarded on the Coordinator surface**: a tracked `PreToolUse` hook (`tools/wave/hooks/conv12-guard.cjs`, registered in the tracked settings beside the echo-guard) blocks a Bash tool call containing an unquoted parameter expansion, with the rewrite remedies in the refusal message. The rule earned the move at its sixth silent live occurrence — three past the trigger (silent failure → Promotion candidate at the second occurrence); the seventh, an unquoted `set -- $pair` in a Coordinator flip loop, happened hours before the hook landed and is the spec's first blocked case. Dispatched worktree-isolated roles were already covered by the harness's own isolation guard (Convention 13, Catalog entry 1) — the hook closes the one surface that guard never reached. **The prose below remains load-bearing** for what a text matcher cannot see (deliberate string assembly, half two's empty-capture discipline, the call-boundary rule) — the guard is a speed bump over the shape, never the whole rule.

> **The guard's scope is deliberately WIDER than this convention's own name.** `conv12-guard.cjs` blocks **any** unquoted parameter expansion, in **any** position — a bare `$VALUE` interpolated into an argument or a string is blocked exactly like a bare `$CLI` used as a command, even though only the second is literally "a command in a shell variable." That is not an oversight: narrowing the block to command *positions* only would require the guard to parse where in the command line an expansion sits — real shell grammar, the exact thing a deliberately simple, fail-open speed bump is designed not to do (see `conv12-guard.cjs`'s own "the quote scanner, not a shell parser" note). Quoting the expansion (`"$VALUE"`) is the sanctioned form whenever a *value*, not a command, is what is meant — the guard's own refusal message teaches that remedy identically regardless of which position tripped it. **Live, 2026-08-13, this repo:** the guard blocked a bare `$id` used in VALUE position — not a command — during this repo's own coordination session, which is the first time the breadth surprised anyone; documenting it here turns that surprise into a stated contract instead of a rediscovery.

### Half one — a command in a variable does not run under zsh

```bash
CLI="npx some-package"
$CLI verb                     # zsh: exit 127 — nothing ran
```

POSIX `sh` and `bash` **word-split** an unquoted parameter expansion; **zsh does not.** So `$CLI verb` under zsh looks for a command whose name is literally `npx some-package`, finds none, and exits **127**. The same line is correct in one shell and inert in the other, which is exactly why it keeps being written by people who have written it successfully before — the reflex transfers, the shell does not.

*Precisely, in zsh's own terms* (`man zshoptions`, `man zshexpn` — the vendor documentation, read rather than recalled): what `sh`/`bash` do here is **field splitting**, and zsh performs it only when the `SH_WORD_SPLIT` option is set — *"No field splitting is done on the result unless the `SH_WORD_SPLIT` option is set"* (`zshexpn`). That option is off in native zsh and appears in the manual's **sh/ksh emulation set**, so it is exactly the compatibility switch its placement suggests. The manual also warns that its name is misleading — *"Note that this option has nothing to do with word splitting"* — because zsh reserves "word splitting" for a different operation (`${=var}`, the `z` flag). This file keeps saying "word-split" in the colloquial sense everyone greps for; the mechanism is field splitting, and the two names point at the same 127.

**Read 127 as "nothing executed," not "it failed."** No side effect happened, no partial write, no error the command itself produced — the shell never reached it. That distinction is what makes half two dangerous: a command that fails loudly leaves a non-zero exit and a message; a command that never runs leaves an empty string that looks exactly like a legitimate empty result.

**The form that survives both shells is a function**, because `"$@"` is the one expansion that preserves argument boundaries in every shell:

```bash
# The binding to use wherever `{{wave-cli}}` is resolved to a concrete
# invocation. The body is this repo's configured `engine.cli` verbatim — one
# authoritative string per repo, read out of `wave.config.json`, never guessed
# (ADR-0032). This checkout's own binding is the vendored one:
wave_cli() { NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts "$@"; }

wave_cli spine set-row-state "$SPINE" "$ID" pr-created
```

The same rule covers a **list** in a variable: `for b in $BRANCHES` is one token under zsh, not N. Iterate written-out items, a `while read` loop, or a real array (`for b in "${BRANCHES[@]}"`) — never a bare `$LIST` in a `for` head or a multi-argument position.

**Compose-time interpolation is NOT this class — do not "fix" it.** `workflow-driver.md`'s `WAVE_CLI` is a **JS** const interpolated into brief text *before any shell sees it*; the rendered brief carries the literal command string, so no expansion ever happens. That form is correct as a string and must stay one. The class is a **shell** variable expanded by a **shell** at runtime.

### Half two — the call boundary is the rule: verify a captured value in the SAME Bash call that produced it, or re-query the source

This is the half that holds no matter what shell, what command, or what went wrong upstream. A capture can come back empty because the command never ran (127), because it ran and matched nothing, because a pipe stage swallowed the error, or because the JSON had no such key — **and the consuming step cannot tell those apart, so it must refuse all of them.**

That much was always right. What was wrong was *where the refusal was allowed to live.*

#### The constraint that decides the shape: a Bash call is the unit of shell state

**Shell state does not survive from one Bash call to the next.** Environment variables, shell functions, and — in a dispatched-subagent thread — the working directory are all reset; the harness's own Bash-tool contract states it outright (*"Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile"*), and [Convention 13](convention-13-one-bash-call-per-step.md)'s cwd-reset occurrence measured the same thing live from the other side.

The consequence is not that a later-call guard is *weaker*. **It is not a guard at all.** A guard issued in a call after the capture inspects a variable that is unset in its own shell, so its answer is about that empty shell rather than about the value it names — and the operator who wrote it reads a wave that never tripped it as proof it works. This convention shipped exactly that shape: a `require_capture()` helper defined "once per session" at step 0 and invoked at step 7c, in a different Bash call, against a value captured in a third one. Three separate function definitions, five call sites, none of them in the scope of the thing they guarded.

**So the rule, stated as the constraint rather than as a helper:**

> A captured value is verified **in the same Bash call that produced it**, or it is **not captured at all** — replaced by a re-query of the source in the call that needs it.

#### Form 1 (preferred) — re-query the source, carry nothing across the boundary

The strongest form does not guard a capture; it removes the capture. Ask the authority again, in the call that needs the answer, and let *its* reply be the evidence:

```bash
# The PR URL, read back FROM THE HOST rather than carried from the call that
# opened the PR. `host-pr status` is read-only and idempotent, and its `state`
# field distinguishes the two things an empty capture cannot: a PR that exists
# (open|merged|closed-unmerged) from one that does not (none).
wave_cli host-pr status --branch "$BRANCH"
# → { ok, verb, host, branch, state: open|merged|closed-unmerged|none, url?, prUrl? }
```

`state: none` is a real answer meaning "no PR on this branch", and it arrives as data rather than as an empty string that has to be interpreted. Nothing crossed a call boundary, so nothing could be lost crossing it. This is the form [`workflow-driver.md`](../../wave-start/reference/workflow-driver.md)'s Worker Termination now prescribes, and the form the Coordinator's own terminator uses.

Re-query is available far more often than it looks: `git rev-parse` re-reads a ref, `issue-store read-closing` re-reads a ticket, `verdict-acked` re-reads the sidecar. Reach for it before reaching for a guard.

#### Form 2 — where the value genuinely cannot be re-queried: capture and check inside ONE call

When the producing command is not idempotent, or the value exists nowhere but in that one invocation's stdout, keep the capture and its check **in a single Bash call** — written inline, with `if`, never `case`/`esac` (Convention 13's Catalog entry 1: `case`/`esac` is refused outright from a worktree-isolated dispatch), and never via a helper defined in an earlier call:

```bash
# ONE Bash call. The capture, its guard, and the consuming command all live here
# together, because that is the only scope in which the variable exists.
ACKED_JSON=$(wave_cli verdict-acked "$VERDICTS" "$ID")
if [ -z "$ACKED_JSON" ] || [ "$ACKED_JSON" = "null" ] || [ "$ACKED_JSON" = "undefined" ]; then
  echo "STOP: ACKED_JSON came back empty — the command that should have produced it did not run (exit 127? no match? no such key?). Refusing to continue with an empty value." >&2
  exit 1
fi
ACKED=$(echo "$ACKED_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf-8")).acked.join(","))')
wave_cli issue-store close "$ID" "$PR_URL" --acked "$ACKED"
```

Three deliberate details, unchanged from the retired helper because each was right about the *value* even while the helper was wrong about the *scope*:

- **It rejects `null` and `undefined`, not just `''`.** `jq -r '.url'` on a missing key prints the four characters `null`, and a template renders a missing property as the literal `undefined` — both are non-empty strings that mean "absent". This mirrors `workflow-driver.md`'s `isMissingField`, which learned the same lesson on the JS side of the same wave machinery (W2-F1's `anchorSha`, then the `branch` recurrence): an absent key is not the only shape a missing value takes.
- **It prints the NAME, never the value.** A capture may be a credential, and a guard that echoes what it caught would be a secret-echo vector inside a safety mechanism (Convention 8). The name plus the fixed hint is all the diagnosis anyone needs.
- **Do not rely on `set -e` instead.** The harness runs each agent Bash call as its own shell, without `-e`; and even with it, `VAR=$(cmd | jq …)` carries the **last** stage's exit status, so a 127 on the left of a pipe is invisible to `$?`. The guard checks the value, which is the only thing that is actually true.

#### Form 3 — a worktree-isolated dispatch has no shell variables at all

**Form 2 is not available to a Worker.** Live-reproduced in this convention's own repair dispatch (issue #303, 2026-07-31, `isolation: 'worktree'`): the isolation guard refuses **any** command carrying a `$VAR` expansion — in a conditional, in a `printf`, standing alone as `test -n "$VAR"` — and it refuses it whether the variable was assigned in a previous Bash call **or in the same one**. A same-call capture-plus-`if` is refused just as flatly as the two-call split. The full probe-by-probe record, including the shapes that *do* pass, is Convention 13's Catalog entry 1.

So from a worktree-isolated role there are exactly two admissible shapes, and neither names a shell variable:

1. **The re-query** (Form 1) — `host-pr status --branch <branch>`, read off the printed JSON.
2. **A single command whose own exit status is the verdict** — no assignment, no test, nothing for the isolation guard to fail to resolve:

   ```bash
   # Prints the url and exits 0; exits NON-ZERO when `.url` is absent or null.
   # The discrimination require_capture was written for, carried by exit status
   # instead of by a variable comparison.
   jq -e -r '.url' pr-create.json
   ```

Do not prescribe a shell-variable guard to a dispatched role. It comes back refused, and a refused guard is a guard that did not run — the same defect as no guard at all, wearing a diligent-looking recipe.

#### `require_capture()` is retired

There is no canonical body to copy any more, and no "define it once per session" step. A shell function *is* session state, and the session it assumed does not exist. Every site that cited it now carries its check inline in the call that captures — or, better, does not capture. A `require_capture` found anywhere on the skill surface is a resurrection of the retired form, not a site this repair missed.

#### Guard the capture whose emptiness means "did not run" — NOT the one whose emptiness is an answer

Getting this backwards turns the guard into a false-alarm generator, which is how guards get deleted. Three live counter-examples in this very skill set, all of which **must stay unguarded**:

- `phase-4a`'s `HIT=$(git diff … | grep -E "$ENGINE_SURFACE")` — empty means *no self-repair hazard*, the good case.
- `phase-5`'s — and `resume-mechanics`' — derived `ACKED` — empty is the documented "nothing met / no verdict yet" value that `close` accepts as-is.
- `start-mechanics`' `HELD_IDS` (step 3) — empty is the ordinary wave with no unresolved intra-wave `Blocked by` pair, i.e. the answer "nothing is held". The file says so at the definition site, so the next reader does not add a guard there.

The guard goes one level up, on the capture that proves the verb *ran*: `ACKED_JSON` (the JSON `verdict-acked` printed). Empty there means the engine call did not execute, and deriving `ACKED=""` from nothing would tick nothing while looking exactly like a legitimate empty ack.

### The invocation-form corollary — a host CLI call is a TOP-LEVEL SIMPLE COMMAND, and a nested shell context is where the sandbox exemption stops

Both halves above are about what a *value* does when a shell touches it. This third rule is about what a *command* does when a shell nests it, and it is the same class of surprise: a form that is correct everywhere else is inert here, for a reason nothing in the command's own text discloses.

> **A host CLI call is written as a top-level simple command** — a step in a `;` or `&&` chain, one per Bash call. **A loop body, a command substitution `$(…)`, a subshell, or a `bash <file>` script is where the sandbox exemption stops.**

**Measured, this repo, one Coordinator session, 2026-09-08 — six forms with four controls.** Under the Claude Code sandbox on macOS, `gh` fails in every nested form with `tls: failed to verify certificate: x509: OSStatus -26276`, and passes at top level: four `gh issue view` calls in a top-level `;` chain → 4/4 pass; the same four ids in a `for` loop → 0/4; **one** call in a **single-iteration** loop → fail; inside `$(…)` → fail; inside a subshell → fail. The four controls narrow it: the single-iteration failure retires "too many calls"; `curl` (HTTP 200) and `git ls-remote` over HTTPS (pass) in the identical nested form retire "the network" and "TLS interception in general"; and the same failing form with the **sandbox off** passes, which is what names the layer. Whatever lets a top-level `gh` reach macOS trust evaluation does not reach a process spawned from a nested shell context, and `curl`, `git` and Node's `fetch` are *observed* untouched in the identical nested form rather than deduced to be. The form-by-form table is in the evidence sidecar; the architectural consequence is the evidence note on [ADR-0015](../../../../docs/adr/0015-triage-is-a-tracker-agnostic-triage-facet.md).

**A correction about the status code, recorded rather than quietly edited away.** An earlier revision of this section asserted that `OSStatus -26276` is `errSecInternalComponent`. **It is not.** Apple's shipped `SecBase.h` defines `errSecInternalComponent = -2070`, and the literal `26276` occurs nowhere in the macOS SDK at all — its nearest *documented* neighbours are `errSecNotSigner = -26267` and `errSecDecode = -26275`. The number places the failure in the Security framework's error range and licenses nothing further, so **do not name a constant for it** — guessing a second one would repeat the defect. The rule above is untouched by the retraction, because it never rested on the constant's name: it rests on the sandbox-off control arm.

#### The tension with this convention's own workaround — named, because it is real

**This convention's own guard hook sends you into a nested context.** `conv12-guard.cjs`'s refusal message teaches three remedies, and the third is *"for a loop or multi-step logic, write a script file and run it via `bash <file>`"* — which is precisely a nested shell context. [Convention 13](convention-13-one-bash-call-per-step.md)'s Catalog entry 1 arrives at the same shape from the other direction, as the fifth station that finally beats the worktree-isolation guard.

**That remedy is still correct, and it is not being withdrawn.** It solves what it was written for: the interpolation happens inside the executed file, so the tool-call text the hook and the isolation guard match carries no expansion at all. The caveat is narrower than the remedy — it is about **one command family**, not about the shape:

- **The convention's own forms stay safe inside `bash <file>`** because every host call they make goes through the **engine CLI** (`wave_cli() { … }` → `host-pr status`, `spine set-row-state`, `issue-store close`, `verdict-acked`). The engine reaches its host through Node's `fetch` and through argv-form `git`, and both are on the passing side of the controls above. Same for the other commands these recipes run: `git rev-parse`, `jq`, `grep`. None of them routes trust evaluation through Security.framework.
- **What is unsafe there is a raw `gh` an operator puts inside such a script.** The script did not create the hazard; the `gh` did. Route it through an engine verb, or keep it as a top-level simple command in its own Bash call.

#### Who is exposed and who is not

| | |
|---|---|
| **Exposed** | Hand-written **operator or agent bash** that calls `gh` directly from any nested context — a loop over ids, a `$(gh …)` capture, a subshell, a script run with `bash <file>`. |
| **Exposed (consumer-configured)** | A `<VAR>_CMD` credential-lookup command (ADR-0029) pointed at a keychain-backed helper: the engine runs it through the platform shell (`/bin/sh -c`), which is a nested context by construction. This is why the `git` control above still printed `failed to store: 100001` — a keychain **write**, denied, harmlessly. |
| **Not exposed** | **Every wave verb**, and the engine as a whole: the GitHub adapter reaches the API through Node's `fetch`, and the landing seam and the API factory shell out only to `git`. A headless Coordinator looping over rows through the engine CLI is making exactly those two kinds of call, so the loop is not a hazard for it. `tools/wave/src/no-gh-shellout-guard.spec.ts` is what keeps that true: it fails if any engine source spawns `gh`, and its refusal names the two sanctioned seams. Its scope is the engine's own sources — it deliberately does **not** police operator or consumer bash, which is why that half is this rule and not a test. |

#### What to do instead

1. **Prefer the engine verb.** `host-pr create|arm|merge|status`, `issue-store …`, `route-tuple` — the reason those verbs exist is that they take the host off the bash surface entirely. This is the same move [ADR-0015](../../../../docs/adr/0015-triage-is-a-tracker-agnostic-triage-facet.md) already made for `triage`, now with an operational payoff it did not know it was buying.
2. **If a raw `gh` is genuinely the only way**, write it as a top-level simple command, one per Bash call, in a `;`/`&&` chain — never in a loop head or body, never inside `$(…)`, never in a script you then execute. Iterate by issuing N flat calls, not by writing one loop.
3. **Never reach for the sandbox switch.** A dispatched agent may not disable the sandbox, ask for it to be disabled, or re-run anything with it off ([ADR-0049](../../../../docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md)); the sandbox-off arm above is a *measurement control* run by the operator who owns that decision, never a remedy on offer to a role. A refusal is reported, not escalated.

### The severity precedent

Why this is rated as the fifth occurrence rather than a fresh, low-severity one — a repeat of a known finding is not rated on its own cost, because a recurrence rate *is* severity — and the four-wave rating table behind that rule (history: `../evidence/convention-12-no-command-in-a-shell-variable.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader contract loads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so it is reachable by every back-half skill with **zero loader edits**.
- **`wave-close/reference/phase-4a-self-repair-pull.md`** — the branch-list loop, and the `HEAD`-vs-merged-tip verification as one self-contained call.
- **`wave-close/reference/phase-5-done-reconcile.md`** — the `ACKED_JSON` capture, its inline guard and the `issue-store close` it feeds, all in one call.
- **`wave-start/reference/start-mechanics.md`** — step 0 states the call-boundary rule (it no longer defines a helper), and step 7c re-queries the PR URL with `host-pr status` instead of carrying it.
- **`wave-shared/reference/convention-04-store-kind-close-phrase.md`** — the reviewer-verdict render, captured and consumed in one call with its emptiness guard between them. The twin of `start-mechanics`' step 7c; changing one without the other re-opens the two-dialect hazard this repair closed.
- **`wave-plan/reference/plan-mechanics.md`** and **`wave-create/reference/create-mechanics.md`** — the scratch-dir paths, written out literally so there is no capture to guard (Form 1).
- **`wave-resume/reference/resume-mechanics.md`** — the step-5 `ACKED_JSON` single-call form, the mirror of `phase-5`'s.
- **`wave-shared/reference/routing-mechanics.md`** — the `{{wave-cli}}` **binding** form (`wave_cli() { … "$@"; }`), written out at the resolution site itself rather than only linked from it, plus the call-boundary rule for what you do with a verb's output.
- **`wave-start/reference/workflow-driver.md`** — the `WAVE_CLI` compose-time note, and the Worker brief's Termination steps 3–4, where the empty `prUrl` of the `#83` gate run originated and where the host re-query now lives.

**One caveat that applies to the binding itself.** `wave_cli()` is a shell function, so it is session state under exactly the rule above: it exists only in the Bash call that defines it. Define it in the same call as the verb it runs, or invoke the configured `engine.cli` string directly. This is the one place where "bind a function, never a variable" (half one) and the call-boundary rule (half two) have to be read together — half one says *what shape the binding takes*, half two says *what scope it survives in*, and neither answers the other's question.

### Site ledger

The site-by-site record of what each site this repair reshaped used to carry and how it is reshaped now — every site is either a re-query (Form 1) or a single self-contained call (Form 2) — plus the census discipline that keeps the record honest (history: `../evidence/convention-12-no-command-in-a-shell-variable.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Common Mistakes

- **Binding `{{wave-cli}}` to a shell variable.** `CLI="npx tsx tools/wave/src/cli.ts"; $CLI spine …` is the original W4-F10 line. Bind a function — in the same Bash call that uses it.
- **Guarding a capture in a later Bash call than the one that produced it.** The variable is unset in that shell, so the check is not about the value it names. Same call, or re-query.
- **Defining a guard helper "once per session".** A shell function is session state, and there is no session across Bash calls. This is the shape this convention itself shipped for months.
- **Prescribing a shell-variable guard to a worktree-isolated role.** The isolation guard refuses any `$VAR` expansion, same call or not — the recipe reads as diligent and cannot run. Use the re-query, or a single command whose exit status is the verdict.
- **Reading exit 127 as "the command failed."** It means the command was never found and never ran — no partial effect, and an empty capture that is indistinguishable from a legitimate empty result.
- **Guarding a capture whose emptiness is a valid answer** (`grep` with no match, `ACKED` with nothing met). That is a false alarm, and false alarms are how guards get removed.
- **Trusting `set -e` or `$?` after a pipe.** A pipeline's status is the last stage's; a 127 on the left is invisible. Check the value.
- **Echoing the captured value in the guard's own failure message.** The capture may be a credential — print the variable's name (Convention 8).
- **Rating a recurrence on the cost of the recurrence.** The fourth occurrence of a finding is not a "low" — it is evidence that the previous three countermeasures were not mechanisms.

### Live occurrences (evidence)

Five silent occurrences of half one across four waves, then the countermeasure's own two failures once the fix moved to a capture guard — the four-of-nine-rows `case`/`esac` refusal, the five-of-six-Workers isolation-guard wall, and the guard's own breadth surprising this repo's own coordination session — are the wave-by-wave record behind the severity-precedent table (history: `../evidence/convention-12-no-command-in-a-shell-variable.md`, read via the sibling-path read when actually wanted, ADR-0040).
