# wave-start — start mechanics: evidence

**2026-09-16 — walked back from `reference/start-mechanics.md` (issue #814, ADR-0050's step-load criterion).** The reference file keeps every step's invocation, its exit codes and what the verb refuses; the derivations, mechanism narratives and incident histories that used to sit beside those steps live here instead. Nothing here is read by a skill, an agent or the driver at runtime — this is the `evidence` reading class ADR-0050 defines: reached on an explicit want, by a human or a deliberately-followed pointer, never a dependency of a run. Where the reference file still needs the *rule* a paragraph below used to argue for, it states the rule in one sentence and points here for the "why".

## Why the human lane exists — the measured constraint, not the folk version

The gate is worth having only if rows are classified `HITL-required` for real reasons, so know what the constraint actually measured out to be on the row that motivated this lane — a row whose work touched paths a dispatched agent could not update.

**Measured, end-to-end:** the blocker was the **Bash sandbox's write-deny on specific paths**. The agent's file-editing tool wrote the target file *fine*; what failed was **git plumbing under the sandbox, which could not unlink it**. Two consequences follow, and both matter when you are deciding whether a row belongs in this lane:

- **"An agent cannot write there" is the over-broad reading, and it is wrong.** Taken literally it classifies as human-gated a large set of rows an agent can in fact implement unattended, which costs exactly what this gate is supposed to save. The narrow, measured claim is about one tool path under one sandbox policy — not about agent write capability in general.
- **The remedy is therefore path- and tool-shaped, not personnel-shaped.** A row blocked this way may stop being human-gated when the sandbox policy or the write path changes, with nothing about the work itself having moved. Re-read the Worker value when that happens instead of treating it as settled.

Keep the distinction when you write a step-9 report: name the human action (`rotate the PAT in the keychain`, `approve the settings change`), never a blanket "agents can't write here".

## Release semantics — the standing rule, not a provisional shape

This is a **settled decision**, re-confirmed after the gate landed, and it is worth stating in full because its cost is real and someone will eventually propose paying it down. The rule has three parts, and they hold together:

1. **Per-pass confirmation.** The release question is asked fresh on every `wave-start` pass over the wave. It is never inherited from an earlier pass.
2. **HOLD is the unattended default.** No answer means held. This is the whole point: the gate must behave correctly when nobody is watching, which is the condition it exists for.
3. **No durable release marker.** Nothing is written when a human says yes — no state, no label, no spine field, no sidecar. Release is expressed by the row simply *dispatching*: it moves past `planned` and stops matching the predicate.

**The cost, stated plainly:** an **attended** Coordinator re-answers the same question on every pass over a wave that still holds a human-gated row. On a wave re-entered several times in a day that is a small, repeated tax on the one person who is present.

**Why we pay it anyway.** A durable "released" marker would be a second source of truth about whether a human has acted, and it would be **stale by default** — written once, then read on every later pass, including passes where the world has moved (the credential was rotated back, the sandbox policy changed, the row was re-planned). The gate's whole value is that its answer is *current*. This is the same reasoning the HELD seam already uses one level up: `wave-start` re-derives the intra-wave `resolved` set fresh on every entry rather than recording it, for exactly this reason. Two seams, one rule — and the state the gate reads (`planned`) is already durable, in the spine, which is the WAL authority. Adding a marker would not make anything more durable; it would only make one of the two records able to lie.

**What would change the decision.** Not "it was asked twice today" — that is the cost, already priced in. It would take a measured case where the *per-pass* question produced a **wrong** answer that a durable marker would have prevented: a human who said yes, and whose yes was then lost in a way that cost a wave. Until that exists, per-pass + HOLD + no marker is the rule, and a proposal to add a release marker should be read as a proposal to add a second source of truth.

## The worktree-count advisory — mechanism, live occurrences, and the asymmetry with a STOP

**The mechanism.** The agent harness composes its sandbox profile with one filesystem-deny entry per **registered** git worktree, and caches that profile for the whole session. Nothing about a single worktree is expensive; the *population* is. Once the profile exceeds the OS `exec` argument limit, every process spawn fails with `E2BIG` ("argument list too long") — the Coordinator's Bash calls and **every subagent's**, since a subagent inherits the same cached profile. Live occurrence 2026-07-30 during the resume of a seven-row wave, on the third dispatch run of the day; the subagent scope was confirmed with a minimal probe agent that hit the identical `E2BIG`.

**Why it belongs in the preflight, before the flip.** The failure has no partial mode. A wave dispatched into a session already past the limit does not degrade — every Worker's first shell call dies, and the wave consumes its whole agent budget on calls that could not have succeeded. Measuring costs one `git` invocation.

**Why the threshold is set where it is.** One full seven-row wave plus its reviewer checkouts has to stay *under* the threshold, or the advisory becomes standing noise and gets ignored — an advisory that fires during ordinary operation is an advisory nobody reads any more.

**Advisory, not a gate — and this is a deliberate asymmetry with step 4.** A failed host-auth or credential probe STOPs the wave because the failure is *measured* (the token really did not authenticate). The worktree threshold is a *heuristic* about a harness-side limit nothing here can measure; converting it into a refusal would block a legitimately wide multi-wave day on a number no one can verify from inside the engine. `> 12` therefore reports and lets the Coordinator decide, and that decision is named in the step-9 report.

### Two terms, not one — the incident that proved the one-term model wrong

The reference file's model — read `worktreeCount` *and* `commandLine`, always — exists because a **second** live occurrence proved a count-only model incomplete, and in the most expensive way available: an operator following it would have swept worktrees and fixed nothing.

**Measured** (wave `2026-07-30-arm-and-wiring`, row 250, worker disclosure 250.3): a real `E2BIG` at **~1019.5 KB of command line across just three argv entries**, with **166 sandbox deny paths of which only 15 were worktree-derived**. It was recovered by **compressing the PR body being passed as an argument** — no worktree was removed, and none needed to be. Two readings fall out of those numbers. The population term was about a *ninth* of the deny paths, and those paths' own bytes are a rounding error next to a megabyte of argv, so sweeping everything could not have brought that spawn under the limit. And three arguments is not an accumulation: a **single** oversized argument — a PR body, a composed agent brief, a file list — reaches the limit on its own, in a session whose worktree count is pristine.

**What that does to the threshold guidance.** A count at or under the threshold means *this term* is fine; it does not mean the next spawn will succeed. A Coordinator that answers every `E2BIG` with a worktree sweep will, on this incident's shape, restart a session and hit the identical failure on the very next call — diagnose which term blew before reaching for either remedy.

### Why an operator needs the per-string condition and not just the total

A total safely under budget is *not* an all-clear. One oversized argument — a PR body, a composed agent brief, a pasted file list — can exceed the per-string cap on its own while the total sits nowhere near the total threshold, and the spawn dies anyway. `checkCommandLineSizeAdvisory` checks both and returns `level: advisory` when **either** trips, so reading `level` is sufficient; reading the printed `commandLine.threshold` is **not**, because that field carries the total threshold alone.

**The recovery differs per term, which is the whole point of separating them.** The population term is swept (plus the harness restart below). The command-line term is **shrunk at the caller** — compress the oversized body or brief, or pass it by file — and *no sweep and no restart move it at all*. Within the command-line term the two conditions refine that further: for the total, shrink the command line *overall*; for the per-string cap, shrink **the one oversized entry** — split it, compress it, or pass it by file. Trimming several small arguments is a real fix for the total and does nothing at all for the per-string cap.

### Why cleanup alone does not recover an already-failing session

**Step 3 (the harness restart) is not optional and is not intuitive.** The profile is cached, so removing the worktrees fixes the population while the running session keeps the deny list it already built — every Bash spawn keeps dying. This was verified live: `git worktree remove` + `git worktree prune` did not restore the session, and only a harness restart did. Sweep *then* restart; a report that says "cleaned up, retrying" without the restart is describing a retry that cannot work.

**Between waves, not only before one.** The incident was the third dispatch run of a single day, and its residue came from the first two runs plus a previous session's leftovers. A multi-wave day wants this count re-read after every close, which is where [wave-close phase 3](../../wave-close/reference/phase-3-worktree-cleanup.md) picks it up.

## The anchor-resolvability gate — pre-verb history and the live occurrence

**It used to be step 4c, run by hand; it is now the verb's (issue #680).** Nothing INSIDE the composed script can check this: a Workflow `script` has no filesystem or git access (§Harness constraint, [workflow-driver.md](../reference/workflow-driver.md)). `compose-driver` is not the script — it is engine code with a real filesystem — so it runs the check itself, per compose, before it writes anything.

**Why it is a refusal and not left to the Reviewer.** A bad anchor reaches every row's Worker (`git reset --hard <anchorSha>`) AND every row's Reviewer (the diff base) individually — the defect is discovered N times, once per dispatched agent, instead of once. The recovery-protocol section of the reference file documents the cost of a bad anchor caught only downstream (two Reviewers returning spurious `questions-blocking` against the literal string `"undefined"`); an unresolvable-but-well-formed SHA is the same failure shape one layer earlier.

**Live occurrence.** A fabricated anchor SHA with a correct 7-character prefix passed compose and reached four parallel Worker/Reviewer briefs; all four Workers independently caught it themselves during their own workspace-setup `git rev-parse HEAD` confirmation — four agent budgets spent discovering, individually, a defect one check catches once, before any of them runs.

## The driver compose gate — the retired transcription's history

There used to be a **compose-currency gate** here, at step 4d: every dispatch extracted the Workflow script from `workflow-driver.md`'s `## The script` fence and filled it in by hand, so the thing about to be dispatched was a COPY — and a stale copy of the whole driver is a defect nothing INSIDE the copy can detect, because a copy's own assertions are exactly as out of date as the rest of it. The gate asked, before any row was composed, whether the script had been freshly extracted or currency-checked against a seeded checklist.

**There is no copy any more.** The script ships as an engine package asset (`tools/wave/driver/wave-start-inflight.js`) and `compose-driver` reads it from the package on every run. The failure class the gate existed for — a document edited out from under a script someone kept around — cannot occur, so the gate goes rather than being restated. Its two motivating occurrences (a frozen template that outlived the cwd-persistence fix; a compose-fresh anchor-diff that caught a falsified reviewer-isolation claim one wave later) stay recorded in [workflow-driver.md](../reference/workflow-driver.md) as the evidence for why the transcription had to end.

## The plugin/engine lockstep gate — why a STOP, not an advisory

**Why a STOP here, when step 4a is only an advisory.** The asymmetry is the same one that separates the host-auth probe from the worktree count: a lockstep skew is **measured**, not heuristic. A mismatched engine is a *different program* from the one the composed briefs describe — verbs it lacks, flags whose shape moved, exit codes that changed meaning — and the failure lands inside dispatched Workers, one per row, after the coarse ledger already says `in-flight`. There is no partial mode worth having and no cheaper moment to notice: the check costs one process spawn and runs *before* the flip.

## Verified routing outputs — the full table

`route-tuple` derives both `--state` values and runs both routes itself, so these are no longer calls you make — they are the table of what it resolves, and the reference for reading `steps[]`. The single verbs below still exist and still print exactly this, which is what makes a one-cell question answerable without running a whole route.

| Invocation | Output |
|---|---|
| `route-outcome --outcome done --state dispatched` | `{"event":"worker-done","outcome":{"type":"transition","nextState":"report-in"}}` |
| `route-verdict --verdict approve --iter 1 --risk mechanical --state reviewing` | `{"event":"reviewer-approve","outcome":{"type":"transition","nextState":"approved"}}` |
| `route-verdict --verdict approve --iter 1 --risk public-API-change --state reviewing` | `{"event":"reviewer-approve-public-api","outcome":{"type":"stop","reason":"public-api-approval-required","severity":"blocking"}}` |
| `route-verdict --verdict changes-requested --iter 1 --risk isolated-refactor --state reviewing` | `{"event":"reviewer-changes-requested-1st","outcome":{"type":"transition","nextState":"re-dispatched"}}` |
| `route-verdict --verdict changes-requested --iter 2 --risk isolated-refactor --state re-dispatched` | `{"event":"reviewer-changes-requested-2nd","outcome":{"type":"stop","reason":"re-dispatch-cap-exhausted","severity":"error"}}` |
| `route-verdict --verdict approve --iter 3 --risk mechanical --state reviewing` (no ruling) | exit 1 — `iteration 3 is out of range. Expected an integer in [1, 2] (re-dispatch cap = 1).` |
| `route-verdict --verdict approve --iter 3 --risk mechanical --state reviewing --ruling "<reason>"` | `{"event":"reviewer-approve","outcome":{"type":"transition","nextState":"approved"},"ruled":{"cell":"reviewer-approve-ruled","ruling":"<reason>"}}` |
| `route-verdict --verdict changes-requested --iter 3 --risk mechanical --state re-dispatched --ruling "<reason>"` | `{"event":"reviewer-changes-requested-2nd","outcome":{"type":"stop","reason":"re-dispatch-cap-exhausted","severity":"error"},"ruled":{"cell":"reviewer-changes-requested-ruled","ruling":"<reason>"}}` |

The public-API `approve` STOPs (it never silently fast-paths to the auto-PR) and the 2nd `changes-requested` STOPs (the cap=1, enforced inside `transition()`) are the two load-bearing routes — verified against the live CLI.

The last three rows are the **Operator-ruled round**: the documented Reviewer-only re-dispatch outside the cap, and the refusal that still stands without it. Note the pairing — the ruled `approve` reaches the state an ordinary `approve` reaches, and the ruled `changes-requested` reaches the cap-exhaustion STOP, so a ruled round never buys the row another one. Full table, and the shape of the ruling itself: `wave-shared/reference/routing-mechanics.md` §"The Operator-ruled round".

## The PR title/body reuse rule — why it is worth a paragraph

Before the reuse rule (`route-tuple`'s title/body handling on a PR reuse), one change carried THREE titles — the Worker's commit subject and the title it opened the PR with, the row title the terminator wrote over it on reuse, and the Worker's again on the squash commit that landed (a single-commit PR takes its subject from the commit). Preserving the live title collapses all three back into one.
