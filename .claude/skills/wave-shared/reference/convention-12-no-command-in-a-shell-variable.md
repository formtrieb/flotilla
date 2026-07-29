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
# The binding to use wherever `{{wave-cli}}` is resolved to a concrete invocation.
wave_cli() { NODE_USE_ENV_PROXY=1 npx @formtrieb/flotilla-engine "$@"; }
# …or, for a consumer still vendoring tools/wave (this repo, dogfooding):
wave_cli() { NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts "$@"; }

wave_cli spine set-row-state "$SPINE" "$ID" pr-created
```

The same rule covers a **list** in a variable: `for b in $BRANCHES` is one token under zsh, not N. Iterate written-out items, a `while read` loop, or a real array (`for b in "${BRANCHES[@]}"`) — never a bare `$LIST` in a `for` head or a multi-argument position.

**Compose-time interpolation is NOT this class — do not "fix" it.** `workflow-driver.md`'s `WAVE_CLI` is a **JS** const interpolated into brief text *before any shell sees it*; the rendered brief carries the literal command string, so no expansion ever happens. That form is correct as a string and must stay one. The class is a **shell** variable expanded by a **shell** at runtime.

### Half two — a step that captures a value it then uses must fail loudly on an empty capture

This is the half that holds no matter what shell, what command, or what went wrong upstream. A capture can come back empty because the command never ran (127), because it ran and matched nothing, because a pipe stage swallowed the error, or because the JSON had no such key — **and the consuming step cannot tell those apart, so it must refuse all of them.**

```bash
require_capture() {   # require_capture <NAME> <captured-value>
  case "$2" in
    ''|null|undefined)
      echo "STOP: $1 came back empty — the command that should have produced it did not run (exit 127? no match? no such key?). Refusing to continue with an empty value." >&2
      return 1
      ;;
  esac
}
```

Three deliberate details:

- **It rejects `null` and `undefined`, not just `''`.** `jq -r '.url'` on a missing key prints the four characters `null`, and a template renders a missing property as the literal `undefined` — both are non-empty strings that mean "absent". This mirrors `workflow-driver.md`'s `isMissingField`, which learned the same lesson on the JS side of the same wave machinery (W2-F1's `anchorSha`, then the `branch` recurrence): an absent key is not the only shape a missing value takes.
- **It prints the NAME, never the value.** A capture may be a credential, and a guard that echoes what it caught would be a secret-echo vector inside a safety mechanism (Convention 8). The name plus the fixed hint is all the diagnosis anyone needs.
- **Do not rely on `set -e` instead.** The harness runs each agent Bash call as its own shell, without `-e`; and even with it, `VAR=$(cmd | jq …)` carries the **last** stage's exit status, so a 127 on the left of a pipe is invisible to `$?`. The guard checks the value, which is the only thing that is actually true.

At the call site, one line before the value is used:

```bash
PR_URL=$(wave_cli host-pr create --branch "$BRANCH" --title "$TITLE" --body "$BODY" | jq -r '.url')
require_capture PR_URL "$PR_URL" || exit 1
wave_cli spine set-row-pr "$SPINE" "$ID" "$PR_URL"       # never reached on an empty capture
```

#### Guard the capture whose emptiness means "did not run" — NOT the one whose emptiness is an answer

Getting this backwards turns the guard into a false-alarm generator, which is how guards get deleted. Two live counter-examples in this very skill set, both of which **must stay unguarded**:

- `phase-4a`'s `HIT=$(git diff … | grep -E "$ENGINE_SURFACE")` — empty means *no self-repair hazard*, the good case.
- `phase-5`'s derived `ACKED` — empty is the documented "nothing met / no verdict yet" value that `close` accepts as-is.

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
- **`wave-close/reference/phase-4a-self-repair-pull.md`** — the branch-list loop and the `HEAD` verification.
- **`wave-close/reference/phase-5-done-reconcile.md`** — the `ACKED_JSON` capture that feeds `issue-store close`.
- **`wave-start/reference/workflow-driver.md`** — the `WAVE_CLI` compose-time note, and the Worker brief's Termination step 3, where the empty `prUrl` of the `#83` gate run originated.

**Sites known to still carry an unguarded capture, outside the slice that wrote this file** (named here so they are findable rather than rediscovered): `wave-start/reference/start-mechanics.md`'s `PR_URL=$(… | jq -r '.url')` → `spine set-row-pr` at step 7c — the closest in-repo analogue of the `#83` gate failure — and `wave-resume/reference/resume-mechanics.md`'s `ACKED_JSON` capture. (`wave-shared/reference/routing-mechanics.md`'s `{{wave-cli}}` resolution section used to describe the CLI as a command string without saying how to bind it — the ADR-0031 dual-form pass closed that: it now points here for the function form.)

### Common Mistakes

- **Binding `{{wave-cli}}` to a shell variable.** `CLI="npx tsx tools/wave/src/cli.ts"; $CLI spine …` is the original W4-F10 line. Bind a function.
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
