## Convention 12 — evidence sidecar: live occurrences

Moved out of `reference/convention-12-no-command-in-a-shell-variable.md` per ADR-0034's Amendment (2026-08-13): `reference/` is loaded whole by every execution skill on every wave, and this history is not needed for that load. Reachable on demand via the ADR-0040 sibling-path read; the rule, the severity-precedent table, and the site ledger stay in the reference/ file.

**2026-09-03:** the severity-precedent table and the site ledger also moved here from `reference/`, per the same amendment. `reference/` now keeps the rule (both halves), the three forms, the retired-helper note, the "guard the right capture" section, and Common Mistakes; this file gains the occurrence-derived severity-rating table and the per-site reshaping record below.

**2026-09-16 (ADR-0050 corpus walk-back, #809).** Four more pieces moved out of `reference/`, per ADR-0050's residual-form rule (a prose-rung section keeps only its rule sentence in the standing load; derivations, mechanism narratives and incident histories go here, one pointer sentence left behind): the `require_capture()` retirement note's full text, including the resurrection warning, now lives just below; the invocation-form corollary's "What to do instead" remedy list is new content, added below the corollary's existing evidence coverage; and the corollary's "Who is exposed and who is not" table is **not** duplicated here — its substance was already covered by this file's own `#### Exposed, and not` bullets (2026-09-08), so `reference/`'s copy was retired rather than re-added. The corollary's "tension with this convention's own workaround" subsection is likewise retired from `reference/` without a fresh copy here, for the same reason: `#### The tension this rule has to live with` below already carries it. `reference/` shrank from 27,169 B to 21,824 B (-5,345 B); this file grew by the two additions below.

**2026-09-16 (same walk-back, second pass, #809 iteration 2).** Two more pieces moved out of `reference/`'s half one, against the same residual-form criterion: the **Promotion** blockquote (ADR-0034 doctrine-budget grill provenance — the occurrence count that earned the hook, and why the prose in `reference/` stays load-bearing regardless of it) and the **guard's-scope** paragraph beneath it (why `conv12-guard.cjs` blocks any unquoted expansion in any position rather than only command position, its parsing-complexity rationale, and the 2026-08-13 occurrence that first surprised this repo with it). Both now live in the new "Half one" section below, right after this note; the `#### 2026-08-13` bullet under Live occurrences below is repointed to that local section instead of to `reference/`, since the note it cited no longer lives there.

### Half one — the promotion history and the guard's declared scope

#### Promotion (ADR-0034, doctrine-budget grill 2026-08-09)

Half one is now **structurally guarded on the Coordinator surface**: a tracked `PreToolUse` hook (`tools/wave/hooks/conv12-guard.cjs`, registered in the tracked settings beside the echo-guard) blocks a Bash tool call containing an unquoted parameter expansion, with the rewrite remedies in the refusal message. The rule earned the move at its sixth silent live occurrence — three past the trigger (silent failure → Promotion candidate at the second occurrence); the seventh, an unquoted `set -- $pair` in a Coordinator flip loop, happened hours before the hook landed and is the spec's first blocked case. Dispatched worktree-isolated roles were already covered by the harness's own isolation guard (Convention 13, Catalog entry 1) — the hook closes the one surface that guard never reached. **The prose in `reference/` remains load-bearing** for what a text matcher cannot see (deliberate string assembly, half two's empty-capture discipline, the call-boundary rule) — the guard is a speed bump over the shape, never the whole rule.

#### The guard's scope is deliberately wider than this convention's own name

`conv12-guard.cjs` blocks **any** unquoted parameter expansion, in **any** position — a bare `$VALUE` interpolated into an argument or a string is blocked exactly like a bare `$CLI` used as a command, even though only the second is literally "a command in a shell variable." That is not an oversight: narrowing the block to command *positions* only would require the guard to parse where in the command line an expansion sits — real shell grammar, the exact thing a deliberately simple speed bump is designed not to do (since 2026-09-21 this is member 1 of the hook's declared **Unmodelled set**, in its own header — the predicate is narrower than the rule in one direction and wider in the other, and both directions are now stated there rather than left to a false refusal to teach). Quoting the expansion (`"$VALUE"`) is the sanctioned form whenever a *value*, not a command, is what is meant — the guard's own refusal message teaches that remedy identically regardless of which position tripped it. **Live, 2026-08-13, this repo:** the guard blocked a bare `$id` used in VALUE position — not a command — during this repo's own coordination session, which is the first time the breadth surprised anyone; documenting it here turns that surprise into a stated contract instead of a rediscovery.

#### The scanner repair and the third answer kind (ADR-0052, 2026-09-21/22)

The hook shipped with a quote scanner made of two booleans — `inSingle`, `inDouble` — and no notion of `$( )` nesting, a heredoc body, a `#` comment or a backtick. The FOR-437 grill measured what that cost, and the answer was symmetric.

**Synthetic, one variable at a time.** The trigger for a false refusal is *an outer double quote wrapping a `$( )` that itself contains a double-quoted expansion*: the outer quote opens the quoted state and the inner quote reads as closing it. `X="$(echo "$Y")"` and `jq . "$(dirname "$Y")"` were refused as *"this command contains an UNQUOTED parameter expansion"* — correct shell, false diagnosis. `X=$(node -e 1)`, `X=$(echo "$Y")` and `X="$(node -e 1)"` each passed, which is what isolates the trigger to the combination rather than to either quote alone. And where the scanner was right it was right **by parity, not by depth**: `echo "$(basename "$(dirname "$P")")"` passed because four quotes happened to balance, and one more level refused.

**The same root cause ran the other way, silently.** A lone unbalanced `"` inside a quoted-delimiter heredoc body, or inside a `#` comment, opened the quote state and never closed it, so every genuine unquoted expansion after that point read as quoted. Both probes carried a real `git checkout $BRANCH`; both passed.

**On live traffic.** 3477 distinct Bash commands from 38 of this repo's session transcripts, at the grill: 60 refusals, **36 of them false (60%)**, 1 genuine violation let through. The dominant false-refusal shape was `cat > "$TMPDIR/x.sh" <<'SCRIPT'` — **the escape hatch the refusal message itself prescribes**; 359 of the 381 commands a construct-allowlist predicate would have deferred were that shape, which is the measurement that made ADR-0052 reject the allowlist and choose the broken-invariant trigger instead.

**Re-measured on the repair, 2026-09-22**, over the same transcript population grown to 40 sessions and 3750 distinct commands (the corpus is a live directory, so it moves; the structure is what reproduces, not the integers):

| | shipped | repaired |
|---|---|---|
| blocks | 62 | **27** |
| …genuine (blocked by both) | 25 | 25 |
| …false refusals | **37** | 0 |
| genuine violations let through | 2 | 0 |
| Abstentions | n/a | **0** |

The two false negatives the repair catches are `for f in wf-*.json; do echo "$f: $(grep -c 'NT-' $f) NT-mentions, $(wc -c < $f) bytes"; done` (the one the grill named) and a `for f in …; do printf … "$(wc -l < tools/wave/src/$f-guard.spec.ts)"; done` from a later session — the same mechanism, `$f` unquoted inside a substitution behind an outer quote. Every one of the 27 blocks was read individually: 15 are an unquoted loop variable in argument position, 5 hold the engine CLI itself in a variable (`$CLI` / `$C` / `$E`), the rest are unquoted values. None is a false refusal.

**Abstention measured empty, and that is the point.** Zero abstentions over 3750 commands is what a tripwire on the scanner's own broken invariant is supposed to read on healthy traffic; a closed-world construct list measured 11.0% on the same population. The class is reachable — three shapes are pinned in `conv12-guard.spec.ts` — it is just not a workload.

**What the repair reuses rather than invents.** `echo-guard.cjs`, 200 lines away in the same directory, already carried the per-`$( )` frame stack with correctly scoped nested quotes and the delimiter-aware heredoc handling, both pinned in two directions by its own regression suite. It was read as the reference implementation and **not** extracted into a shared module: `wave-setup` copies each hook to a *tracked* path in the consumer repo, so a third file turns a missed scaffold copy into a new silent failure mode. The sharing happens in `tools/wave/src/shell-quoting-conformance.spec.ts` — one corpus of shell shapes, both scanners, each row carrying both expected verdicts and every divergence between them declared in the row itself.

**The two hooks' biases are opposite, and that is now declared on each.** One command demonstrates it: `git commit -m "a note with an unbalanced ' quote; printenv`. `conv12-guard` abstains and blocks; `echo-guard` widens what it treats as inert prose and passes, letting the trailing `printenv` through — which the balanced control `git commit -m "a note"; printenv` proves it would otherwise block. Neither direction is wrong; what was wrong was that neither was written down.

### Live occurrences (evidence)

- **2026-07-16, W4-F10** (`docs/retros/2026-07-16-hardening-w4.md`). The dispatch WAL loop used `CLI="./…/tsx …/cli.ts"; $CLI spine set-row-state …` — **12× exit 127**. Verified consequence-free *before* retrying: the spine was untouched, all rows `planned`, the dispatch log empty. The retro names the luck explicitly — spine-first WAL ordering is what made the no-op harmless; a tracker-first loop would have left four claims with no spine entry.
- **2026-07-19, W5-F5** (`docs/retros/2026-07-19-hardening-w5.md`). `git push origin --delete $BRANCHES` with a space-separated variable was taken as **one** refspec (`invalid refspec`). Already a known operating note at that point; the retro's own verdict was *"the reflex isn't there yet."*
- **2026-07-22, W18-F3** (`docs/retros/2026-07-22-retro-polish-w18.md`). A filing self-check loop over `$IDS` ran as a single-token loop. Cost: one re-run with the ids written out. Recorded as Coordinator practice, no engine change.
- **The `#83` gate run.** A command held in a shell variable never executed; the empty string it produced was used as a PR URL, and nothing was written to the spine. The first occurrence where the *second* half — the caller accepting nothing as an answer — did the damage rather than the shell.
- **2026-07-30, wave `2026-07-30-adr-0032-wave-b` — the countermeasure's own failure, and the reason half two is now stated as a call-boundary constraint.** Two rows (279 and 287) reported `outcome: done` with an **EMPTY `prUrl`** — precisely the shape the guard exists to prevent — while their PRs demonstrably existed and were well-formed. Both were recovered at routing via `host-pr status`, but only because the Coordinator noticed the empty field first. The guard that would have caught it was the one that could not run: the brief prescribed a `case`/`esac` capture guard, which the worktree-isolation check refused in **four of nine rows** of that wave (267, 278, 279, 288), each Worker reporting the refusal independently. A guard that is refused, and a guard that inspects an unset variable in a later call, fail in the same silent direction.
- **2026-07-31, wave `2026-07-31-tier-guidance-and-guards` — five of six Workers, one class.** Every one of them hit the same wall from a different direction: shell state does not persist between a dispatched role's Bash calls, and the isolation guard refuses even a bare reference to a variable undefined in the same call. Five independent Workers converging on one mechanism is what moved this from "a guard that needs a different dialect" to "a guard whose scope was never available".
- **2026-07-31, issue #303's own repair dispatch — the probe series behind Form 3.** `case`/`esac` refused standing alone; a two-call capture-then-guard refused at the guard; a same-call capture-plus-`if` refused too; a same-call variable referenced in a plain `printf` refused as well; a multiline `if` whose condition is a **command** (no variable) accepted; a single-statement `jq -e -r '.url' <file>` accepted, with its failing branch observed as exit 1. Recorded shape-by-shape in Convention 13's Catalog entry 1, which is where the reproduction discipline for this class lives.
- **2026-08-13, this repo's own coordination session — the guard's breadth, first observed rather than designed-around.** The guard blocked a bare `$id` used in **VALUE** position (an argument, not a command name) — surprising in the moment, since Convention 12's own name is about a command in a variable, not a value. The breadth was already deliberate (see "The guard's scope is deliberately wider than this convention's own name" above); this occurrence is the reason it is now stated as a contract instead of left implicit. The fix was the ordinary remedy #2: quote the expansion.

#### `require_capture()` is retired — the full note

There is no canonical body to copy any more, and no "define it once per session" step. A shell function *is* session state, and the session it assumed does not exist. Every site that cited it now carries its check inline in the call that captures — or, better, does not capture. A `require_capture` found anywhere on the skill surface is a resurrection of the retired form, not a site this repair missed.

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
| `wave-plan/reference/plan-mechanics.md` + `wave-create/reference/create-mechanics.md` | `T=$(mktemp -d)`, then `"$T/…"` across several documented steps | **Form 1.** The capture is **deleted**; both files name a literal scratch path (`/tmp/flotilla-plan-$SESSION`, `/tmp/flotilla-create-$SLUG`). Nothing is captured, so nothing can be empty or cross a boundary |
| `wave-start/reference/start-mechanics.md` — the scratch paths | `"$T/…"` at **seven** sites (steps 3, 7.0, 7.0a) with **no assignment anywhere in the file** — not even a `mktemp` to guard | **Form 1**, same literal dialect (`/tmp/flotilla-start-$SLUG`), and the operator-constants line now says why those constants are safe to name |

**The class named here is now closed.** Both of the sites this ledger previously carried as "still open" have been reshaped, and the judgment each needed is recorded at the site rather than only here:

- The Convention-4 `VERDICT_SECTION` twin was the last genuinely unguarded capture on the surface. Its emptiness means `render-verdict` did not run, and the PR body would then be composed *without* the rendered verdict while still reading as complete — the guarded class, and now guarded inline.
- The two `T=$(mktemp -d)` captures were judged **guarded-class, repaired by removal**. Emptiness there is never an answer (`mktemp -d` prints a path or fails) and the failure is destructive rather than merely silent: `> "$T/x.json"` with `T` unset writes at the filesystem root. Form 2 was unavailable — `create-mechanics`' sequence stops to ask a human mid-way, so the value provably could not reach its consumers in one call — which makes removal the only shape that actually holds. `plan-mechanics` took the same shape so the two read as one dialect.

**A census by capture-shape misses the worst case, and this repair proved it.** The previous pass grepped for `VAR=$(…)` and declared itself complete. `start-mechanics`' seven `"$T/…"` uses were invisible to it — because there was **no assignment to find**. `T` was never set anywhere in that file, so a grep for captures could not see the one site where the value was not merely unguarded but wholly undefined, and every `> "$T/…"` in it was a write at the filesystem root on the first run that followed the recipe literally. So: **census the USES, not the assignments** — `grep -n '\$[A-Z_]\+' ` over a mechanics file and check each name against the constants its own preamble declares. An expansion with no visible origin is the strongest form of this defect, not an absent one.

With that correction applied, the census reads: every remaining `VAR=$(…)` across `.claude/skills/` is either inside a single self-contained call, one of the deliberate non-guards below, or `start-mechanics`' `WSTATE`, whose `$([ … ] && echo a || echo b)` form cannot produce an empty value — and every `$VAR` *use* in the mechanics files resolves to either an operator-held constant its preamble declares or a literal path. Re-run both halves before adding a row to this ledger.

### The invocation-form corollary — the 2026-09-08 measurement behind it

The rule this evidence supports, stated in full in `reference/convention-12-no-command-in-a-shell-variable.md` ("The invocation-form corollary"):

> **A host CLI call is written as a top-level simple command** — a step in a `;` or `&&` chain, one per Bash call. **A loop body, a command substitution `$(…)`, a subshell, or a `bash <file>` script is where the sandbox exemption stops.**

#### The measurement — six forms, four controls, one Coordinator session

flotilla's own repo, 2026-09-08, all forms minutes apart in one session, sandbox on unless noted:

| Form | Result |
|---|---|
| `gh issue view` ×4, top-level `;` chain | 4/4 pass |
| the same four ids inside a `for` loop | 0/4 — `tls: failed to verify certificate: x509: OSStatus -26276` |
| **one** `gh` call inside a **single-iteration** `for` loop | fail |
| `gh` inside `$(…)` | fail |
| `gh` inside a subshell + pipe | fail |
| `curl https://api.github.com/rate_limit` inside the same loop form | HTTP 200 |
| `git ls-remote` over HTTPS inside the same loop form | pass (only a `failed to store: 100001` keychain-**write** warning) |
| the failing nested `gh` form, **sandbox off** | **pass** |

**What each control retires, in order.**

1. **Not the iteration count, and not the rate limit.** A single-iteration loop carrying one call fails. The trigger is the shell construct, not repetition — which is what makes this a *form* finding rather than a throttling one.
2. **Not the loop keyword.** Command substitution and a subshell fail identically. The trigger is `gh` running as a child of a nested shell context rather than as the invocation's top-level simple command.
3. **Not the network, and not TLS interception in general.** `curl` and `git`-over-HTTPS pass in the identical nested form, against the same host.
4. **The sandbox is the layer.** The identical nested form passes with the sandbox off. Whatever lets a top-level `gh` reach macOS trust evaluation does not reach a process spawned from a nested shell context. `curl`, `git` and Node's `fetch` being unaffected is part of the same measurement — an observation from rows 6 and 7 of the table, never an inference from the error text.

**A correction about the status code, recorded rather than quietly edited away.** An earlier revision of this note asserted that `OSStatus -26276` is `errSecInternalComponent`. **It is not.** Apple's shipped `SecBase.h` defines `errSecInternalComponent = -2070`, and the literal `26276` occurs nowhere in the macOS SDK at all — its nearest *documented* neighbours are `errSecNotSigner = -26267` and `errSecDecode = -26275`. The number places the failure in the Security framework's error range and licenses nothing further, so **no constant is named for it** — guessing a second one would repeat the defect, and a mechanism story assembled around a misidentified constant is exactly how the first version went wrong. The finding survives the retraction intact because control 4 above is a *control arm*, not a deduction: the sandbox-off run passes, and that is what names the layer. Caught in review of this very slice; the retraction is left standing in all four artifacts so a reader who saw the first version can see the claim withdrawn rather than vanished.

**Deliberately not diagnosed:** which harness component computes the exemption (the permission classifier's parse of the command text, or the seatbelt profile's Mach-service rules). That is a Claude Code question, not a flotilla one, and the rule does not wait on it.

**Provenance.** Consolidation pass of the MoplaDS consumer analysis (2026-09-06), findings F-3.7d / F-3.7e, verified against `main` f453e97 (2.4.0) by a verifier/refuter pair which reduced the claim from "mechanism" to "observation", then extended by the live measurement at a1cf49f and re-triaged against `main` 6c1b736. That probe **superseded** the 20×3 repeat-count measurement the finding originally asked for: the original design carried no `curl`/`git` control and no sandbox-off arm, so it would have reproduced the form-dependence at sixty calls without ever identifying the layer. More calls would not have been more evidence.

#### The tension this rule has to live with

**This convention's own guard hook sends an operator into a nested context.** `conv12-guard.cjs`'s refusal message teaches, as its third remedy, *"for a loop or multi-step logic, write a script file and run it via `bash <file>`"* — and Convention 13's Catalog entry 1 reaches the same shape independently, as the fifth station that finally beats the worktree-isolation guard. That remedy is **not withdrawn**: it solves the problem it was written for, because the expansion then lives inside the executed file rather than in the tool-call text the guards match.

The convention's own forms stay safe inside such a script for a reason that is architectural rather than lucky: they route host calls through the **engine CLI**, whose host access is Node's `fetch` and argv-form `git` — both on the passing side of control 3 — and the rest of what they run (`git rev-parse`, `jq`, `grep`) makes no network connection and performs no TLS handshake at all, so there is no comparable form for this to observe. The hazard is a raw `gh` an operator puts inside such a script, not the script.

#### Exposed, and not

- **Exposed:** hand-written operator or agent bash calling `gh` directly from any nested context.
- **Exposed, consumer-configured:** an ADR-0029 `<VAR>_CMD` lookup pointed at a keychain-backed helper — the engine runs it through `/bin/sh -c`, a nested context by construction. The `git` control's `failed to store: 100001` is the same keychain wall seen from the write side.
- **Not exposed:** every wave verb and the engine itself (GitHub over Node's `fetch`; the landing seam and the API factory over argv-form `git`), and therefore a headless Coordinator looping rows through the engine CLI. `tools/wave/src/no-gh-shellout-guard.spec.ts` holds that property in place — it fails if any engine source spawns `gh`, names the `fetch` and `git` seams in its refusal, and deliberately scopes itself to the engine's sources rather than to operator bash.

The architectural consequence is recorded as an evidence note on ADR-0015, the decision that had already moved `triage` off raw `gh` for tracker-agnosticism reasons and turns out to have bought an operational property as well.

#### What to do instead

1. **Prefer the engine verb.** `host-pr create|arm|merge|status`, `issue-store …`, `route-tuple` — the reason those verbs exist is that they take the host off the bash surface entirely. This is the same move [ADR-0015](../../../../docs/adr/0015-triage-is-a-tracker-agnostic-triage-facet.md) already made for `triage`, now with an operational payoff it did not know it was buying.
2. **If a raw `gh` is genuinely the only way**, write it as a top-level simple command, one per Bash call, in a `;`/`&&` chain — never in a loop head or body, never inside `$(…)`, never in a script you then execute. Iterate by issuing N flat calls, not by writing one loop.
3. **Never reach for the sandbox switch.** A dispatched agent may not disable the sandbox, ask for it to be disabled, or re-run anything with it off ([ADR-0049](../../../../docs/adr/0049-a-dispatched-agent-never-escalates-a-gates-capability-is-declared-provided-or-withheld.md)); the sandbox-off arm above is a *measurement control* run by the operator who owns that decision, never a remedy on offer to a role. A refusal is reported, not escalated.

