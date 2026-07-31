## Convention 12 — never hold a command in a shell variable, and never let an empty capture flow onward

Two failures chained, and only the first one is about shells. **An invocation form that silently does nothing**, and **a caller that accepts nothing as an answer.** The first has broken a wave five times. The second is the one that turns a failed command into a corrupted record — and it is the half that holds regardless of which shell is live, which is why it, not the shell trivia, is the structural half of this convention.

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

### The severity precedent — why this is the fifth occurrence and not the second

| Wave | Shape | Rated |
|---|---|---|
| W4 (W4-F10) | `$CLI` in the dispatch WAL loop — 12× exit 127 | low, "operational note" |
| W5 (W5-F5) | `$BRANCHES` read as a single refspec — *"the reflex isn't there yet"* | low |
| W18 (W18-F3) | `$IDS` iterated as one token | low, "practice note; no engine change" |
| the `#83` gate run | a command in a variable never ran; the empty PR URL flowed onward and nothing was written to the spine | the occurrence that produced this file |

**Three "low" ratings are the defect this section exists to correct, and they were wrong for a nameable reason: they priced the instance and never the class.** Each instance genuinely was cheap — twelve no-ops that touched nothing, one re-run with the ids written out, one invalid refspec. But "cheap" measured the blast radius of the run that happened to be lucky, not the blast radius that was available. W4-F10 was consequence-free **only because the spine-first WAL ordering put the no-op first**; a loop that had begun with the tracker would have left four claims with no spine entry, and nothing about the mistake chose the safe ordering — the architecture did.

So the rule this convention adds to the retro-rating habit: **a repeat of a known finding is not rated on its own cost.** A recurrence rate *is* severity. A finding recurring for the fourth time has a fifth occurrence as its expected outcome, and rating that fourth one "low" is not a judgment about the instance — it is a decision to pay for a sixth. The class has now cost five debugging sessions, which no single instance's rating ever reflected.

And **"remember to" was never a mechanism.** The proof is mechanical rather than rhetorical: at the anchor of the wave that filed this, a grep for the countermeasure across `.claude/skills/` returned **nothing** — it existed only inside `docs/retros/`, which are historical records nobody reads at the moment the mistake is being made. Four findings agreed on what to do and none of them changed a file an operator reads mid-wave. That is why this is a `reference/` file the loader picks up whole and a guard written into the briefs, and not a fifth retro line.

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

### Site ledger — the sites this repair reshaped

Every site below used to capture in one Bash call and guard in a later one, through a `require_capture()` helper defined in a third. Each is now either a re-query (Form 1) or a single self-contained call (Form 2). Kept as a **record, not a to-do**:

| Site | What it carried | How it was reshaped |
|---|---|---|
| `wave-start/reference/start-mechanics.md`, step 0 | the helper definition, "once per wave-start shell session" | **deleted.** Replaced by the call-boundary rule stated in prose — there is no session for a session-scoped helper to live in |
| `wave-start/reference/start-mechanics.md`, step 7c | `PR_URL=$(host-pr create … \| jq -r '.url')` in one call, guarded in another, flowing into `spine set-row-pr` | **Form 1.** `host-pr create` runs bare; a separate call re-queries `host-pr status --branch`, and that call also carries both spine writes and the rung transition, so the URL never crosses a boundary |
| `wave-start/reference/start-mechanics.md`, step 4b | `ENGINE_CLI` / `PLUGIN_VERSION` guarded by the helper, then matched with `case`/`esac` | **Form 2**, plus the `case` replaced by an `if`+`grep -q`: read, guard and branch in one call each |
| `wave-close/reference/phase-4a-self-repair-pull.md` | its own drifted copy of the helper (it omitted the `(exit 127? no match? no such key?)` parenthetical — a second dialect of one guard), then `MERGED_TIP`/`LOCAL_HEAD` | **Form 2.** Both `git rev-parse --verify` captures, the emptiness check and the equality check are one call; the two-dialect hazard disappears with the helper |
| `wave-close/reference/phase-5-done-reconcile.md` | `ACKED_JSON` captured, then guarded by the helper `phase-4a` had defined in a different session step | **Form 2.** Capture, guard, derive `ACKED`, and call `issue-store close` — one call |
| `wave-resume/reference/resume-mechanics.md`, step 0 + step 5 | a third copy of the helper, and the `ACKED_JSON` mirror of `phase-5`'s | **Form 2**, byte-identical in shape to `phase-5`'s. The two paths are one shape and must not diverge |
| `wave-shared/reference/routing-mechanics.md` | pointed at "the canonical `require_capture` body" as the thing to copy | now points at the call-boundary rule and its two forms. Deliberately **no** guard of its own — nothing is captured there |
| `wave-start/reference/workflow-driver.md`, Termination 3–4 | `PR_URL=$(… \| jq -r '.url')` in call 1, an `if`-guard on it in call 2 — the exact shape a dispatched role cannot run | **Form 1.** Bare create, then `host-pr status --branch` as the confirmation that reads the URL from the host |
| `wave-shared/reference/convention-04-store-kind-close-phrase.md` | `VERDICT_SECTION=$({{wave-cli}} render-verdict …)` flowing straight into the composed `--body` with no check between them | **Form 2.** The capture, an inline emptiness check and the `host-pr create` it feeds are one call — the twin of `start-mechanics`' step 7c, which it must not diverge from |
| `wave-plan/reference/plan-mechanics.md` + `wave-create/reference/create-mechanics.md` | `T=$(mktemp -d)`, then `"$T/…"` across several documented steps | **Form 1.** The capture is **deleted**; both files name a literal scratch path (`/tmp/flotilla-plan`, `/tmp/flotilla-create-$SLUG`). Nothing is captured, so nothing can be empty or cross a boundary |
| `wave-start/reference/start-mechanics.md` — the scratch paths | `"$T/…"` at **seven** sites (steps 3, 7.0, 7.0a) with **no assignment anywhere in the file** — not even a `mktemp` to guard | **Form 1**, same literal dialect (`/tmp/flotilla-start-$SLUG`), and the operator-constants line now says why those constants are safe to name |

**The class named here is now closed.** Both of the sites this ledger previously carried as "still open" have been reshaped, and the judgment each needed is recorded at the site rather than only here:

- The Convention-4 `VERDICT_SECTION` twin was the last genuinely unguarded capture on the surface. Its emptiness means `render-verdict` did not run, and the PR body would then be composed *without* the rendered verdict while still reading as complete — the guarded class, and now guarded inline.
- The two `T=$(mktemp -d)` captures were judged **guarded-class, repaired by removal**. Emptiness there is never an answer (`mktemp -d` prints a path or fails) and the failure is destructive rather than merely silent: `> "$T/x.json"` with `T` unset writes at the filesystem root. Form 2 was unavailable — `create-mechanics`' sequence stops to ask a human mid-way, so the value provably could not reach its consumers in one call — which makes removal the only shape that actually holds. `plan-mechanics` took the same shape so the two read as one dialect.

**A census by capture-shape misses the worst case, and this repair proved it.** The previous pass grepped for `VAR=$(…)` and declared itself complete. `start-mechanics`' seven `"$T/…"` uses were invisible to it — because there was **no assignment to find**. `T` was never set anywhere in that file, so a grep for captures could not see the one site where the value was not merely unguarded but wholly undefined, and every `> "$T/…"` in it was a write at the filesystem root on the first run that followed the recipe literally. So: **census the USES, not the assignments** — `grep -n '\$[A-Z_]\+' ` over a mechanics file and check each name against the constants its own preamble declares. An expansion with no visible origin is the strongest form of this defect, not an absent one.

With that correction applied, the census reads: every remaining `VAR=$(…)` across `.claude/skills/` is either inside a single self-contained call, one of the deliberate non-guards below, or `start-mechanics`' `WSTATE`, whose `$([ … ] && echo a || echo b)` form cannot produce an empty value — and every `$VAR` *use* in the mechanics files resolves to either an operator-held constant its preamble declares or a literal path. Re-run both halves before adding a row to this ledger.

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

- **2026-07-16, W4-F10** (`docs/retros/2026-07-16-hardening-w4.md`). The dispatch WAL loop used `CLI="./…/tsx …/cli.ts"; $CLI spine set-row-state …` — **12× exit 127**. Verified consequence-free *before* retrying: the spine was untouched, all rows `planned`, the dispatch log empty. The retro names the luck explicitly — spine-first WAL ordering is what made the no-op harmless; a tracker-first loop would have left four claims with no spine entry.
- **2026-07-19, W5-F5** (`docs/retros/2026-07-19-hardening-w5.md`). `git push origin --delete $BRANCHES` with a space-separated variable was taken as **one** refspec (`invalid refspec`). Already a known operating note at that point; the retro's own verdict was *"the reflex isn't there yet."*
- **2026-07-22, W18-F3** (`docs/retros/2026-07-22-retro-polish-w18.md`). A filing self-check loop over `$IDS` ran as a single-token loop. Cost: one re-run with the ids written out. Recorded as Coordinator practice, no engine change.
- **The `#83` gate run.** A command held in a shell variable never executed; the empty string it produced was used as a PR URL, and nothing was written to the spine. The first occurrence where the *second* half — the caller accepting nothing as an answer — did the damage rather than the shell.
- **2026-07-30, wave `2026-07-30-adr-0032-wave-b` — the countermeasure's own failure, and the reason half two is now stated as a call-boundary constraint.** Two rows (279 and 287) reported `outcome: done` with an **EMPTY `prUrl`** — precisely the shape the guard exists to prevent — while their PRs demonstrably existed and were well-formed. Both were recovered at routing via `host-pr status`, but only because the Coordinator noticed the empty field first. The guard that would have caught it was the one that could not run: the brief prescribed a `case`/`esac` capture guard, which the worktree-isolation check refused in **four of nine rows** of that wave (267, 278, 279, 288), each Worker reporting the refusal independently. A guard that is refused, and a guard that inspects an unset variable in a later call, fail in the same silent direction.
- **2026-07-31, wave `2026-07-31-tier-guidance-and-guards` — five of six Workers, one class.** Every one of them hit the same wall from a different direction: shell state does not persist between a dispatched role's Bash calls, and the isolation guard refuses even a bare reference to a variable undefined in the same call. Five independent Workers converging on one mechanism is what moved this from "a guard that needs a different dialect" to "a guard whose scope was never available".
- **2026-07-31, issue #303's own repair dispatch — the probe series behind Form 3.** `case`/`esac` refused standing alone; a two-call capture-then-guard refused at the guard; a same-call capture-plus-`if` refused too; a same-call variable referenced in a plain `printf` refused as well; a multiline `if` whose condition is a **command** (no variable) accepted; a single-statement `jq -e -r '.url' <file>` accepted, with its failing branch observed as exit 1. Recorded shape-by-shape in Convention 13's Catalog entry 1, which is where the reproduction discipline for this class lives.
