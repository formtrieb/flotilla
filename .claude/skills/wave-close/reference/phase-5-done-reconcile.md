# Phase 5 — Done-reconcile + needs-attention for stuck rows

Probe each terminal row's closing state, then either **land it `done`** (a merged PR), **flag it** (a genuinely rejected PR / stuck row), or **report it** (no merge evidence either way).

**Read the outcome as a claim about evidence, not as a verdict.** The probe reports what it *found*, and the four outcomes are not equally alarming. Only `closed-unmerged` means "a PR was rejected" — `closed-unknown` means "nothing was found", which is not the same thing and must never be auto-flagged.

**Evidence hierarchy for a merge (ADR-0023): tracker attachment > host PR state > nothing.** `read-closing` (the tracker attachment) is the primary probe. When it **cannot see a merge** — `open` on a no-integration workspace where the tracker never attaches the PR, or `closed-unknown` where it found no PR either way — fall to the **host** for the evidence the tracker lacks: `{{wave-cli}} host-pr status --branch <branch>` answers "is the PR for this branch merged?" mechanically (`{ state: "open"|"merged"|"closed-unmerged"|"none", url? }`). Its `state` supplies the merge fact, and `issue-store close <id> <prUrl>` fires the FOR-13 `doneState` fallback on a `merged` answer — this **replaces the old out-of-band human-confirmation step** with a probe. Only when *both* the tracker and the host lack merge evidence is the answer "nothing" (report, leave `in-review`).

**Skip `parked` rows entirely — do not probe them** (ADR-0022). A parked row has no branch and no PR, so `read-closing` has nothing to find; its claim was already released at park time. Report it under the parked rubric below and move on.

**Deriving `--acked` before every `close` on a merged row (FOR-17 — the dead `--acked` wire, ADR-0004).** `issue-store close` has always accepted `--acked 0,2,3` to tick the reviewer-met ACs on the tracker for human visibility — no skill ever passed it. Whenever the probe below (directly or via a host fallback) confirms a row **merged**, derive the acked indexes from that row's FINAL Reviewer verdict through the single-owner engine verb **before** calling close — never parse `acVerification[]` by hand here:

```bash
{{wave-cli}} verdict-acked <verdictsDir> <id>
# → { "acked": [0, 2], "iter": 2, "corrupt": 0 }
```

`<verdictsDir>` is `.flotilla/waves/<slug>/verdicts` — the same sidecar dir wave-start's Reviewer stage writes to (wave-shared Convention 5). The verb reads the **MAX-iter valid** verdict sidecar for the id, so after a changes-requested → re-dispatch cycle the answer always comes from the **latest** iteration, never a stale one. A missing or schema-invalid verdict sidecar is not a failure — `acked: []` (nothing to tick, `close` still lands the row `done`); this is COSMETIC ONLY (ADR-0004) — the tick is human-facing and is never re-read as gate input, so an empty `acked` never blocks the close. Close-time, not verdict-time, is the deliberate moment to apply it: ticking at approve would overstate an AC if the PR later closed unmerged, and this step only runs once a merge is confirmed.

```bash
{{wave-cli}} issue-store read-closing <id>   # → { state: "open"|"merged"|"closed-unmerged"|"closed-unknown", prUrl? }

# merged → derive --acked from the FINAL verdict, THEN close (see above). The
# CLI prints the acked/iter/corrupt object as JSON on stdout; extract just the
# comma-joined acked array before passing it through (never hand-parse
# acVerification[] instead of using this verb's output):
ACKED_JSON=$({{wave-cli}} verdict-acked "$VERDICTS" <id>)   # → { "acked": [...], "iter": ..., "corrupt": ... }

# GUARD THE CAPTURE THAT PROVES THE VERB RAN (wave-shared Convention 12). An
# empty ACKED_JSON does not mean "no ACs were met" — it means `verdict-acked`
# produced nothing, and the only ways that happens are ways you must not
# continue past: the engine CLI was never invoked (a command held in a shell
# variable, exit 127 — the five-occurrence class), or it exited non-zero. The
# next line would derive ACKED="" from it, and `close` would accept that as a
# legitimate "nothing met" and tick nothing — a silent wrong answer.
require_capture ACKED_JSON "$ACKED_JSON" || exit 1        # helper: Convention 12 / phase-4a

ACKED=$(echo "$ACKED_JSON" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf-8")).acked.join(","))')
# ACKED itself is deliberately NOT guarded: "" is a documented, legitimate value
# here (nothing met / no verdict sidecar yet) and `close` accepts it as-is.
# Guarding it would be a false alarm on the ordinary case — Convention 12's
# "guard the capture whose emptiness means *did not run*, not the one whose
# emptiness is an answer" rule, with both halves of it live on these two lines.
{{wave-cli}} issue-store close <id> <prUrl> --acked "$ACKED"  # $ACKED may be "" (nothing met / no verdict yet)

# closed-unmerged (a PR was FOUND and it did not merge) → flag recoverable-stop
{{wave-cli}} issue-store flag <id> \
  --kind recoverable-stop \
  --question "PR was closed without merging — reopen, re-dispatch, or abandon?" \
  --option reopen --option re-dispatch --option abandon

# closed-unknown → NO flag. Report it and ask the human. See the rubric below.
```

- **`merged` → land the row `done`** via the **done-reconcile**: derive `--acked` (above), then `{{wave-cli}} issue-store close <id> <prUrl> --acked <indexes>` (the `prUrl` is `readClosing`'s). This is the operational trigger that reaches `done` for a merged row — the wire the live gate found missing (F1) — and, with `--acked` wired, also the checklist tick the live gate found dead (FOR-17): the issue's AC checklist now reads as done for exactly what the Reviewer verified, partial/not-met ACs stay unticked. `close` is **idempotent no-op-or-reconcile**: on a native-integration tracker the merged PR already flipped the coarse projection, so `close` only records the closing PR + the cosmetic AC tick; a re-entrant wave-close re-run never double-posts (re-deriving `--acked` and re-ticking the same indexes is itself idempotent). Do **not** re-implement close — it is the existing `IssueStore.close()` verb. Then clear any stale flag: `{{wave-cli}} issue-store clear-flag <id>`.
- **`closed-unmerged` → `recoverable-stop`** — the store **found a linked PR and it did not merge**: a genuinely rejected PR. It is NOT auto-moved back to `available`; doing so would let another wave re-grab the issue and redo deliberately-rejected work. The human dispositions it (reopen / re-dispatch from scratch / abandon).
- **`closed-unknown` → consult the host, then report only if still unproven** — the row is closed but `read-closing` found **no PR evidence either way**. This is *absence of evidence*, not evidence of rejection, so never flag on it alone (auto-flagging here raised `recoverable-stop` on three genuinely-merged rows in the wave that found it — the exact false alarm this outcome exists to prevent). Fall to the host (evidence hierarchy): `{{wave-cli}} host-pr status --branch <branch>`. `state: merged` → the PR did land, the tracker just never attached it → derive `--acked` (above), then `{{wave-cli}} issue-store close <id> <prUrl> --acked <indexes>` (FOR-13 fallback), done. `state: closed-unmerged` → the host proves a real rejection → flag `closed-unmerged` (below). `state: open`/`none` → still no merge evidence anywhere → report **`closed-unknown — closed, but no merged-PR evidence found; confirm before landing`**, naming the id, and let the human say what happened. **Never guess** between merged and rejected — the host answer decides, and only a genuinely silent host falls back to the human.
- **`open` → PR still in review; no flag** — the human merges it in the advisory order (or `--auto` armed it in phase 4b); a later re-run reconciles it. **No-integration workspace with `states.doneState` set (FOR-13):** the probe can **never** report `merged` (there is no tracker↔host integration to see the merge) — it stays `open` after the PR lands. Do **not** wait for an out-of-band human confirmation: consult the host directly — `{{wave-cli}} host-pr status --branch <branch>`. On `state: merged`, derive `--acked` (above) and land the row with the SAME `{{wave-cli}} issue-store close <id> <prUrl> --acked <indexes>` — on a store with `states.doneState` this fires the FOR-13 fallback (mapped done-state transition + a loud advisory), landing the ticket even without the integration. On `state: open`/`none`, the PR genuinely has not merged; leave the row `in-review` for the next touch. `close` is idempotent, so re-runs stay safe.
- **`failed`/`abandoned`** rows were already flagged by `wave-start`; do not double-flag unless `readClosing` also returns `closed-unmerged`.
- **`parked` → report, never flag** (ADR-0022). Report it as **`parked — released for re-planning`**, naming the issue id so the human can see what left the wave. Do **not** flag it, do **not** `close` it, do **not** `unclaim` it again (the claim was released at park time; re-running is harmless but pointless). The question a needs-attention flag would raise — "what should happen to this row?" — is already answered: it is coming back in a future wave, drawn fresh from the pool. Flagging it would be the exact false alarm the state exists to remove.

The flag is **orthogonal to the coarse rung** — the row stays at its current rung (`in-review` / `failed` / `abandoned`); `read().status` gives `needs-attention` precedence in the projection, but the underlying rung is unchanged. A `done` row (closed PR) reads `done` regardless of any lingering flag (closed wins over the flag).

## Common Mistakes

- **Flagging — or probing — a `parked` row.** `parked` is terminal *and silent* (ADR-0022): the claim is already released and the disposition is already decided. Do not `read-closing` it (there is no PR to find, so the probe can say nothing useful — it reads `closed-unknown` at best), do not flag it, do not `close` it. Report `parked — released for re-planning` and move on.
- **Leaving a `merged` row at `in-review` (only clearing its flag).** A merged PR must be landed `done` via `{{wave-cli}} issue-store close <id> <prUrl> --acked <indexes>` — that is the done-reconcile (F1). Clearing a stale flag alone does not reach `done`, and in a no-integration `states.doneState` workspace nothing else ever will.
- **Re-implementing close.** `close` is the existing `IssueStore.close()` verb — idempotent no-op-or-reconcile, and the FOR-13 fallback lives inside it. Call the verb; never hand-roll a state transition or a "done" write in the skill.
- **Calling `close` without `--acked` (FOR-17 — the dead wire).** `close` has always accepted `--acked 0,2,3`; every closed issue used to read "not done yet" on the tracker because no skill ever passed it. On every merged row, derive the indexes first via `{{wave-cli}} verdict-acked <verdictsDir> <id>` (the single-owner engine verb) and pass them straight through — never hand-parse `acVerification[]` in the skill, and never skip the flag because "it's optional".
- **Deriving `ACKED` from an unguarded `ACKED_JSON` capture (wave-shared Convention 12).** If the `verdict-acked` call never executed — the five-occurrence "command held in a shell variable, exit 127" class — its capture is empty, `ACKED` derives to `""`, and `close` lands the row `done` with nothing ticked while looking exactly like the legitimate "nothing met" case. Guard the JSON (the capture that proves the verb *ran*); leave the derived `ACKED` unguarded (its emptiness is a real answer).
- **Deriving `--acked` at verdict-in instead of at close.** The tick fires at `close`, once a merge is confirmed — never earlier. An `approve` verdict whose PR later closes unmerged must never have ticked anything; deriving `--acked` any earlier than the merged-row close call would overstate what actually landed.
- **Re-reading the AC tick as gate input anywhere.** The ADR-0004 boundary holds unconditionally: the tick `--acked` writes is cosmetic/human-facing only. No gate, probe, or later wave may read it back — `acVerification[]` on the Reviewer verdict stays the sole ground truth.
- **Auto-moving `closed-unmerged` back to `available`.** A rejected PR re-grabbed by another wave redoes deliberately-rejected work. Flag it `recoverable-stop`; the human disposes.
- **Treating `closed-unknown` as a rejected PR.** They are different claims: `closed-unmerged` means a PR was found and it did not merge; `closed-unknown` means nothing was found. Never flag `closed-unknown` on the tracker probe alone — consult `host-pr status` first (the evidence hierarchy): the host's `merged` lands it, its `closed-unmerged` is the only evidence that justifies a flag, and only a silent host (`open`/`none`) falls back to the human. Flagging on the bare tracker probe raises `recoverable-stop` on rows that are simply done — the live defect this outcome exists to fix.
- **Skipping the `host-pr status` fallback in the done-reconcile.** On a no-integration workspace `read-closing` can never report `merged`, so a merged row sits `open` forever if you stop at the tracker probe. The evidence hierarchy (ADR-0023) is tracker attachment > host PR state > nothing: when the tracker can't see the merge, `host-pr status` supplies it and `close` fires the FOR-13 fallback. There is no out-of-band human-confirmation step any more.
- **Double-flagging `failed`/`abandoned` rows.** `wave-start` already flagged these. Only re-flag if `readClosing` also shows `closed-unmerged`.
- **Treating `needs-attention` as a rung.** It is orthogonal — the row keeps its rung; the flag is the human signal layered on top.
