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

Before the reuse rule (`route-tuple`'s title/body handling on a PR reuse), one change carried THREE titles — the Worker's commit subject and the title it opened the PR with, the row title the terminator wrote over it on reuse, and the Worker's again on the squash commit that landed (under the host's own default squash message, before ADR-0053, a single-commit PR took its subject from the commit). Preserving the live title collapses all three back into one.

## Step 7d — why the probe sweep reads the iteration (issue #974)

The first liveness rule (ADR-0042 Amendment 2026-09-23) spared a stamped probe only while its row read `reviewing`. No writer on the dispatch path ever writes that state: step 5 writes `dispatched`, and `route-tuple` writes only `re-dispatched` or `pr-created`. So while a Reviewer ran, its row read `dispatched` (Iter 1) or `re-dispatched` (Iter 2), and the gate never fired. The implementing row's own Reviewer showed it: against a copy of the live spine of wave `2026-09-23-sibling-truth-and-landing-message`, `worktree-cleanup --probes-only` selected and removed a clean probe carrying that Reviewer's own running stamp. Only the call's placement — after the round's last tuple, before any re-compose — had been protecting a running probe.

The same wave's four live reads of the routing call: round 2 removed the one stamped probe and left an unstamped probe alone; round 3 removed nothing, because the Reviewer made `<stamp>/probe` (the stamp as a parent directory) and the sweep matches the registered checkout's own basename; round 4 removed nothing, since no probe was made; round 6, with the hint that the path handed to `git worktree add` must itself end in the stamp, removed the stamped probe. The corrected rule (ADR-0042 Correction 2026-09-25) reads the row's `Iter` beside its state; the stamp wording now says what round 6's hint said.

## Step 8 — a Reviewer STOP leaves its probe standing (issue #991)

A Reviewer STOP (`reviewer-questions-blocking`, `public-api-approval-required`) writes nothing to the spine, so the row keeps reading `dispatched` (or `re-dispatched`) at the stamp's iteration, and step 7d's sweep spares the finished Reviewer's probe `live-row` until the row moves. In round 3 of wave `2026-09-25-review-signals-and-round-hygiene` two Reviewer-only re-reviews ran at the SAME iteration as the stopped review; each would have collided with the stamped directory still standing, and the Coordinator removed it by hand before each. Neither step 8 nor the ruled-round recipe said to at the time. Making a STOP write to the spine, or having the engine force-release a stopped row's probe, was left out of scope: the removal is the Coordinator's, by hand, before a same-iteration re-review and at the latest before the close.

The resumed states are the same gap from the other side: no routing writer writes `report-in` or `verdict-in`, but `resume()` reconstructs both, and a resumed Reviewer running under either would have had its own probe removable. Not observed; the running set now carries both.

## Step 8 — the path from an answered question back to a re-review (issue #992)

**Live occurrence** (wave `2026-09-25-review-signals-and-round-hygiene`, disclosures `978.5`, all iteration 1). Round 3 returned `questions-blocking` on how to read one acceptance criterion, and the Operator ruled. A Reviewer-only re-review carrying the ruling as its FIRST `reviewerHint` returned `questions-blocking` again — the Reviewer's reason: a Coordinator hint is not ground truth for marking a criterion met against that criterion's own wording. Only after the criterion itself was rewritten in the ticket (annotate, one criterion changed, the rest byte-identical) did a third review approve. That is why step 2 of the path rewrites the criterion and forbids the hint.

**Three mechanics were used, none documented at the time.** (1) No verb composed a Reviewer-only round: the Coordinator composed an ordinary driver and patched a copy, so Stage 1 returned the saved Worker report and Stage 2 passed it through, keeping the schema and the verdict Scribe. `compose-driver --reviewer-only` now fills that mode into the shipped template instead. (2) The re-review overwrote the verdict sidecar at the same iteration (last-writer-wins); the first verdict survived only in the disclosures and the journal. The Operator ruled at triage that the superseded verdict is NOT preserved separately — the question and the ruling are captured as spine disclosures, which already outlive the overwrite. (3) The lingering stamped probe had to be removed first — the step-8 paragraph above this one.

Out of scope by the same triage: an engine verb that rewrites acceptance criteria (the rewrite stays a `to-issues` decorate act), and the mechanism for removing a stopped row's probe.

## Step 7a — why the sidecar step compares a present record with its payload (issue #977)

**Live occurrence** (wave `2026-09-23-sibling-truth-and-landing-message`, row 957, iteration 1, disclosure 957.3): the WorkerReport the Workflow returned carried `prUrl`, the Scribe-written sidecar `reports/957-1.md` for the same row and iteration did not, and `write-report`'s absent-`prUrl` notice fired on that sidecar write. `route-tuple` re-queried the host and opened nothing twice, so the row landed correctly — but the durable record disagreed with the in-band one, and a resume that read the sidecar alone would have seen a finished Worker with no PR. Where the field was lost (the Scribe's payload composition, the driver hand-off, or the verb) was not established. In the wave that followed, the first three report sidecars all kept their `prUrl` (the Coordinator's premise re-check for this row), so the loss is intermittent.

**Why a comparison at routing, and not a change to the Scribe.** An intermittent loss upstream is not something a stronger brief reliably closes, and the sidecar step is the one place that holds both copies at once. It used to read the passed payload only when the sidecar was missing, so a present-but-divergent record went unseen. It now compares the two after the write path's own normalisation (validation, plus the `issue` reconciliation on the report half), and on a divergence the **passed payload wins** (Operator ruling at triage): the sidecar is rewritten through the same renderer and writer the missing-sidecar recovery uses, routing proceeds from the payload, and the step lists the half under `repaired`. An unreadable or invalid payload leaves a valid sidecar alone — a payload the recovery would refuse to recover from may not overwrite a valid record either.

**What stays silent, by construction.** Key order is not a divergence (two hands serialise the same record), and a Reviewer-only round that overwrote its verdict sidecar at the same iteration (last-writer-wins) routes with the matching payload — equal after the overwrite, so nothing is written and nothing is said. Two such rounds ran in the wave above.

## The between-rounds sequence — why it had to be written down (issue #976)

**Live occurrence.** Wave `2026-09-23-sibling-truth-and-landing-message` landed each of its six rounds before dispatching the next, re-anchoring every round. No step in this skill or in `wave-close` ever ran `close-row` between rounds, so the Coordinator ran it by hand, for every landed row, before each re-compose. The per-round sequence, as actually run: land → pull → `close-row` per landed row → probe sweep → worktree/branch/ref cleanup → re-anchor → re-compose. The round-2 compose then showed the round-1 rows annotated `(landed)`, confirming the annotation works only when that hand-run step happens — skip it, and a landed sibling would have read `(pr-created)` instead, sending that round's Reviewer down the every-other-sibling tip-prediction recipe against a branch and worktree already gone.

Filed bare at the wave's close (disclosure 960.3, all iteration 1) for a person to sharpen before an agent could pick it up — the Coordinator was already running the sequence by hand every round; this row is what writes it into the skill itself, so the next wave that lands per round does not have to re-derive it.

## The between-rounds pull half-applies under the sandbox write-deny (issue #994)

**Symptom 1 (Worker, disclosure 975.4).** A worktree-isolated Worker's revert-and-restore falsification (policy clause 9 / wave-shared Convention 11) ran `git checkout <anchor> -- <driver> .claude/skills/wave-reviewer/reference/reviewer-checks.md`; it failed with `unable to unlink old '.claude/skills/…': Operation not permitted` (exit 255) and HALF-applied — the driver path reverted, the `.claude/skills/wave-reviewer/reference/reviewer-checks.md` path was left staged at its anchor version in the index while its working-tree content never changed. The Worker recovered without escalating: an index-only reset for the half-applied path, and its file-editing tool for the `.claude/skills/**` content. No brief warned a Worker this shape could happen before this row.

**Symptom 2 (Coordinator, disclosure 976.2).** Every round of wave `2026-09-23-sibling-truth-and-landing-message` — the wave the between-rounds sequence above (issue #976) was itself written down from — used `git -C "$REPO" pull` for step 2 as documented at the time. In this repo's own sandboxed session a pull or merge that has to write a `.claude/**` path half-applies the same way the Worker's checkout did; every round actually ran `git fetch` + `git merge --ff-only origin/main` OUTSIDE THE SANDBOX instead, undocumented until this row. Consumers on the installed form carry no `.claude/skills` in-repo, so this symptom is plausibly flotilla-only.

**The fix, in both places.** Policy clause 9 (`workerBrief()`, `tools/wave/driver/wave-start-inflight.js`) now tells a Worker to use its file-editing tool for any `.claude/**` restore, never a shell `git checkout`/`git restore`, and to read `git status --porcelain` after any restore that touches such a path — a shell form can print `Operation not permitted` for exactly one path in a multi-path command while the rest reverts correctly, leaving that one path staged at its old content with nothing in the exit status to distinguish it from a clean revert. The between-rounds sequence (`SKILL.md` step 2, `start-mechanics.md`'s invocation-by-invocation block) now runs `fetch` + `merge --ff-only` instead of `pull`, states the same sandbox sentence, and confirms HEAD actually moved by comparing it against `origin/<default-branch>` rather than trusting the merge's own exit code — a half-applied merge exits 0.

**The classifier-refusal question this row also had to settle, before bounding a retry.** The Gap's own "Added from the environment-profile grill" section records two earlier occurrences (disclosures 754.1 and 777.6) of the auto-mode classifier itself refusing an Edit on a `.claude/**` path ("Self-Modification" / "Modify Shared Resources") — a different mechanism from the sandbox write-deny above, and one an identical retry cleared in both prior occurrences. This row's own dispatch re-measured it live rather than assuming the pattern still holds: 30 identical file-editing-tool edit-and-revert cycles (10 on a `.claude/skills/**` file, 10 on a `.claude/agents/**` file, 10 on a control file outside `.claude/`) found **zero classifier refusals** — a null result, recorded in full in `wave-shared/evidence/convention-13-one-bash-call-per-step.md` and in this row's own PR body. Per the acceptance criterion this measurement was run to satisfy: a null result keeps the brief's STOP `blocked` on an unresolvable `.claude/**` restore as-is, rather than inventing a bounded-retry allowance the measurement did not earn.
