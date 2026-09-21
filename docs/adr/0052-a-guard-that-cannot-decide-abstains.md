# A guard that cannot decide abstains: three answer kinds, a declared resolution bias, a named unmodelled set

The engine's DoR gate carries `deferred` on the written ground that *"I do not know when this row was last touched" must not read the same as "nothing moved"*. The Reviewer carries `questions-blocking` for the same reason. The ten shipped **Guards** — two `PreToolUse` hooks and eight drift specs — carry two answers, and when one of them cannot decide it resolves the not-knowing silently, in whichever direction its author happened to pick, wearing the vocabulary of a check that did decide. This ADR gives that family the third answer, and makes the direction a declared property rather than an accident.

## What was measured

Grilled 2026-09-21 against the shipped `conv12-guard.cjs`, with controls, from FOR-437.

**Synthetic, one variable at a time.** The trigger is an outer double quote wrapping a `$( )` that itself contains a double-quoted expansion: the outer quote opens the scanner's quoted state, the inner quote reads as closing it. `X="$(echo "$Y")"` and `jq . "$(dirname "$Y")"` are refused as *"this command contains an UNQUOTED parameter expansion (`$Y`)"* — correct shell, false diagnosis. Two further results were not in the ticket:

- **The same root cause produces false negatives.** A lone unbalanced `"` inside a quoted-delimiter heredoc body, or inside a `#` comment, opens the quote state and never closes it; every genuine unquoted expansion after that point reads as quoted and walks through. Both probes were built to contain a real `git checkout $BRANCH`; both passed.
- **Where the scanner is right, it is right by parity, not by understanding.** `echo "$(basename "$(dirname "$P")")"` passes because four quotes happen to balance. Add one level and it refuses.

**On live traffic** — 3477 distinct Bash commands from 38 of this repo's session transcripts:

| | |
| -- | -- |
| Refusals the shipped guard has issued on this corpus | 60 |
| …of them false | **36 (60%)** |
| Genuine violations it let through | 1 |
| Blocks after the repair below | 25, all genuine |
| Abstentions after the repair, on the same corpus | **0** |

The one false negative is `for f in wf-*.json; do echo "$f: $(grep -c 'NT-' $f) NT-mentions, $(wc -c < $f) bytes"; done` — `$f` unquoted twice inside a substitution, hidden by the outer quote. The dominant false-refusal shape is `cat > "$TMPDIR/x.sh" <<'SCRIPT'`: **the guard blocks the escape hatch its own refusal message prescribes.**

**The predicate is not the rule.** The message names Convention 12 — *never hold a command or its flags in a shell variable* — as though that is what ran. Of seven probe shapes, five disagree: `CMD="git checkout main"; eval "$CMD"`, `bash -c "$CMD"` and `git log "$F"` with flags in `$F` all violate the rule and all pass; `B=main; git checkout $B` violates nothing and blocks. The width in one direction is admitted in the message; the narrowness in the other is stated nowhere.

**The repair already exists, 200 lines away.** `echo-guard.cjs` in the same directory carries a per-`$( )` frame stack with correctly scoped nested quotes, pinned in both directions by regression tests, and heredoc handling that knows a quoted delimiter suppresses every expansion — verified against real bash after its own predecessor claimed the opposite. It also names its residual in prose: *"named rather than assumed away."* And when it reaches its limit it **widens what it treats as inert prose** — it resolves toward passing, and says so only in a comment. Two hooks, one directory, one class of not-knowing, opposite silent resolutions, neither declared in the answer.

## Decision

1. **A Guard answers in three kinds: decided-block, decided-pass, and Abstention.** An Abstention is a statement about the Guard — it read its subject and reached no verdict — and names the shape it could not parse. It never words itself as a finding, and a decided answer never borrows its hedging.

2. **Saying is mandatory; blocking is discretion.** Every non-verdict is named, including the three branches that today exit 0 in silence on unreadable stdin, unparseable JSON and an absent command. What a non-verdict *does* is the Guard's **Resolution bias**, declared beside its subject and chosen per subject: `conv12-guard` blocks (standing still is cheap, and the class has eight live occurrences behind it), `echo-guard` passes (its traffic is prose full of shell metacharacters, and a hook that bricks every Bash call on its own parse bug costs more than the vector it closes). An undeclared bias is a defect, not a default.

3. **Abstention is triggered by the Guard's own broken invariant, never by a construct allowlist.** A closed-world predicate — enumerate what is modelled, abstain on everything else — was measured at **11.0% of live traffic**, 359 of those 381 being the heredoc that writes a script file. Open world instead: the Guard abstains exactly when its state machine ends inconsistent — an unclosed quote, an unclosed substitution level, an unterminated heredoc. That is five lines, it is provable, and it catches precisely the silent false-pass channel. **On today's corpus the class measures empty, and that is the point: it is a tripwire, not a workload.**

4. **The Unmodelled set is declared, not discovered.** Each Guard states the constructs it does not read. A Guard's refusal message states what it checked, never the broader rule it serves.

**Scope: all ten Guards** — two hooks and eight drift specs. The comfort that "a spec failure is read by a human" is false inside a wave: ADR-0043's two live occurrences were both drift specs firing wrongly at a *Worker*, who read the failure himself and silently dodged it — a fixture renamed to `.txt` at six sites, a real path hidden inside a command span. The DoR gate's `deferred` and the Reviewer's `questions-blocking` are cited as precedent and are **not** rebound; nothing there is broken.

## Considered Options

- **A closed-world construct list** (rejected) — the honest-sounding form; in practice the list would have to enumerate the shell, and the measurement shows it swallowing one command in nine, starting with the sanctioned escape hatch.
- **Align every Guard on fail-closed** (rejected) — one rule and nothing to remember, but `echo-guard` chose the opposite direction deliberately and with reasons; under a uniform rule it would block on any unbalanced quote in a commit message, which is its normal traffic, not its edge case.
- **Every non-verdict blocks, including the guard's own crash** (rejected) — a parse bug in a Guard would stop every Bash call in the session; both shipped hooks already record that trade in the other direction, and this ADR keeps it by separating *saying* from *blocking*.
- **Repair `conv12-guard` and write no doctrine** (rejected) — the observation has now been made twice in the same ticket and once more in this grill; the next Guard would inherit nothing.
- **A shared `.cjs` scanner module for both hooks** (rejected) — `wave-setup` copies each hook to a *tracked* path in the consumer repo precisely because a worktree-isolated role never sees `node_modules`; a third file turns a missed scaffold copy into a new silent failure mode, which is the class this ADR exists to close. Sharing happens at the **conformance suite** instead: one corpus of shell shapes run against both scanners, asserting each one's declared bias — the pattern the three `IssueStore` implementations already carry.
- **Extend the predicate to `eval` / `bash -c` now** (deferred, filed) — a real gap, but a new predicate with unmeasured false-positive surface, introduced in the same diff that first measures the Abstention class at zero. The message stops overclaiming now; the predicate is its own ticket with its own controls.

## Consequences

- `CONTEXT.md` gains **Guard**, **Abstention**, **Resolution bias** and **Unmodelled set** under Doctrine, plus the flagged ambiguity separating a Gate that *defers* (its data source was absent, the check never ran) from a Guard that *abstains* (it read and could not conclude). "Residual" is deliberately not reused — ADR-0034's **residual form** is the shrunken prose after a Promotion.
- flotilla#710 becomes the scanner half: per-`$( )` quote frames plus modelled heredoc, `#` comment, backtick and arithmetic. Measured effect on this corpus: 36 false refusals gone, 1 false negative caught, abstentions 0.
- The refusal message loses the sentence that states Convention 12 as though it had been checked, and gains the two sanctioned rewrites without the claim. A follow-on ticket carries the `eval` / `bash -c` predicate.
- A shared shell-quoting conformance spec is added, run against both hook scanners and asserting each one's declared **Resolution bias**; the eight drift specs declare bias and Unmodelled set in prose only, since their scanners are not shell scanners.
- FOR-437's count is corrected: the family is ten Guards, not nine — `loaded-corpus-guard` landed with ADR-0050 after the ticket was written.
- No engine, schema or spine change. This ADR closes no issue and lands Coordinator-direct (ADR-0033).
