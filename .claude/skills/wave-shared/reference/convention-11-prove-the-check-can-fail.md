## Convention 11 — prove the check can fail (a slice shipping a NEW check shows it going red, or discloses that it could not)

A check that works and a check that cannot fail are indistinguishable from their output. Both print green. Both satisfy an acceptance criterion phrased *"the check passes"*. Both survive a Reviewer's re-run of the verify profile, and both survive it just as convincingly. The two worlds differ **only** on the input the check exists to catch — and nothing in the ordinary wave obliges anyone to produce that input. This is the wiring-gap shape Convention 9 answers, one layer over: the risk sits where no acceptance criterion is pointed, so no role is required to look.

**A slice that introduces a new check must demonstrate that check failing on the input it exists to catch, and report the demonstration — or report, in the same channel, that it could not falsify the check and why.**

### Are you in the class? — two mechanical questions

Ask them of the diff, never of the effort:

1. **After this diff, does a check exist that reports pass/fail** — a test, an assertion, a guard, a smoke probe, a lint rule, a CI gate, a preflight, a validator, a schema constraint?
2. **Is that check's failing condition new with this slice** — absent at the wave anchor SHA?

Two yeses ⇒ in the class. There is deliberately no third question about whether the falsification is worth the time: **cost is not a trigger condition.** It is an input to the *"could not falsify"* disclosure below, which is where an expensive falsification is meant to land — not a reason the class quietly stops applying.

The unit is the **check's behaviour**, not the file. An existing spec file gaining a new assertion, or an existing guard gaining a new condition, is a new check for this purpose: the added assertion has never been observed failing on anything.

### What counts as a falsification

Produce the input the check exists to catch, in the cheapest way that is real — invert the code the check guards, remove the guard, feed the malformed payload, cut the wiring — then:

1. **Run the check and observe its own FAIL state**, verbatim: the failing line, the assertion message, the non-zero exit.
2. **Restore the original state.** The inversion is temporary and never lands.
3. **Re-run and observe green again**, so the restore is verified rather than assumed.

Two near-misses that do not count:

- **The deferred trap.** A check whose only observed state is `deferred` / `skipped` / `not-applicable` has not been proven to fail — it has been proven *not to run*. That state is neither the pass nor the fail: a gate that answers `deferred` for every input green-lights everything while looking like it is working. Observing a `deferred` on your falsification input is a **failed falsification attempt** (report it as one, below) — never the demonstration.
- **A pre-existing red.** *"The suite was red before my fix and green after"* is evidence the code changed; it says nothing about a check the same commit introduced. The falsification exercises the **new** check against the **new** code.

### The demonstration is only half the duty — the report is the other half

A Worker that inverts the code, sees red, restores it, and then reports only *"tests green"* has produced the evidence and thrown it away.

**The falsification note goes into the `WorkerReport`'s `judgmentCalls`, mirrored into `reviewerFocusItems`** — the same disclosure route Conventions 9 and 10 use, deliberately not a new mechanism. That route already carries it to the Reviewer (`reviewerBrief()` renders both arrays verbatim), already persists it in the report sidecar at agent-return (ADR-0024), and already presents it to the Coordinator at routing as a capturable disclosure (ADR-0027). It names four things:

- **which check** — `file:line`, or the check's name;
- **what was broken** to falsify it, precisely enough to repeat;
- **the observed failure** — the actual failing output, not "it failed";
- **that the original state was restored and re-verified green.**

### "Could not falsify, and here is why" is a legitimate reported outcome

Some checks cannot be falsified cheaply from a worktree: the failing input needs credentials the sandbox denies, a live remote, a merge, an image nobody can rebuild here. **A duty with no honest exit does not get met — it gets claimed.** So the exit is explicit and costs nothing: report, in the same `judgmentCalls` → `reviewerFocusItems` channel, that the check was not falsified, what was attempted or why the attempt is unavailable here, and **what input would falsify it**. That last part is what makes it actionable rather than an apology.

An unfalsified check disclosed this way is worth strictly more than a green tick nobody can trace: the Reviewer sees exactly which assertion is unproven, and the Coordinator has a disposition to make (ADR-0027) instead of a silence to notice. What is **not** legitimate is the third option — saying nothing, or asserting a falsification without the observed failing output.

### What is NOT in the class

- **A slice that changes behaviour already covered by checks that exist.** Those checks have been failing on other people's mistakes for a while; their ability to fail is established, and re-proving it every wave is exactly the ritual this convention is written to avoid.
- **A refactor that moves, renames, or re-homes an existing check** without changing what it asserts.
- **A slice whose green is incidental** — the verify profile ran, as it does on every row. Convention 11 is about a check the slice **ships**, never about the gates the slice **passes**.

### The Reviewer side of the same coin

The [ADR-0004 Amendment 2026-07-28](../../../../docs/adr/0004-ac-ground-truth-is-the-reviewer-verdict.md) binds the Reviewer to the mirrored duty: an outcome-phrased AC (*"the guard is enforced"*, *"the gate blocks X"*, *"the check exists"*) earns `met` only on evidence that **exercises** the outcome, and the Reviewer holds a probe license to exercise it itself — a failing probe is `not-met`.

Convention 11 is the Worker-side dual. The role that already has the code inverted and the harness warm produces the evidence, instead of leaving the Reviewer to reconstruct it from a cold start. The two are independent: a Reviewer's probe does not excuse a missing Worker falsification, and a Worker's falsification does not excuse the Reviewer from its own re-verification.

### Where the clause lives

`workerBrief()`'s policy-clauses list (`.claude/skills/wave-start/reference/workflow-driver.md`) — the text a Worker actually receives — plus the directed read in `reviewerBrief()`'s `## Your checks`. The Coordinator's compose-and-routing duties are in `.claude/skills/wave-start/reference/start-mechanics.md`. This section documents the convention those encode.

### Live occurrences (evidence)

- **The source case — a consumer wave, clause written by hand into one brief.** The slice added an authorization guard plus a smoke probe asserting the guard holds; the brief said *prove the probe can go red*. The Worker removed the guard, rebuilt the image, ran the smoke, got the expected failing line, restored the guard, and verified green again. That run produced the strongest single piece of evidence any wave had produced — from a clause that existed in exactly one brief and nowhere in the standing conventions. (That consumer's retro lives in its own archive, not this repo; this convention is the upstream generalization, so the next consumer does not have to rediscover the clause.)
- **2026-07-27, W33-F1 — Gate 8 shipped inert** (docs/retros/2026-07-27-consumer-gaps-machinery-w32-w33.md). `verify-profile-coverage` answered `deferred — "No verify config supplied"` for every input, because `runDor`/`runDorById` never threaded the verify profile through to `validateIssue`. The gate landed spec-covered and green; the only state it was ever observed in was `deferred`. It was caught by a human recalculating the coverage by hand at a later wave-create — the deferred trap above, live.
- **2026-07-27, the FOR-120 Reviewer's control experiment** (docs/retros/2026-07-27-plugin-consumer-w1.md). Not a failure — the practice, performed voluntarily by the *other* role. Rather than trust the Worker's type-check, that Reviewer reproduced it independently **and ran its own control case** (`symbolName` → `symbolNameTypo`), confirming the check caught a deliberate break. That control case is precisely what this convention asks the Worker to have already done, one stage earlier.
- **The in-repo idiom.** `tools/wave/src/skill-schema-drift.spec.ts` carries a named `negative control —` test beside each of its guards, five in total, for exactly this reason: without one, `expect(...).not.toThrow()` passes identically whether the guard works or the guard is inert.
