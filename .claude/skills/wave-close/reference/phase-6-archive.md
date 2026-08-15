# Phase 6 — Archive (the last phase — terminal-only, idempotent, layout-aware)

## Backstop before the gate — is anything you found still uncaptured?

**Before running the gate below: any Coordinator find from phases 1–5 that is not yet a spine entry? Capture it now** — `{{wave-cli}} spine add-disclosure <wave-file> <row-id> --iter <n> --source coordinator --text "<the gap>"`, or `--wave` in place of `<row-id> --iter <n>` when no row owns it — because the archive move at the bottom of this file closes the capture window for good (ADR-0038). This is a backstop, not the rule: the rule is capture at discovery, in the phase where the find surfaced (wave-close SKILL.md body). The gate itself cannot help here — it forces a disposition onto what was recorded and can never force capture.

## Disclosure gate — BEFORE the archive move (ADR-0027)

**Run this first, every time, before either Guard below.** It is a mechanical existence check, not a judgment call:

```bash
{{wave-cli}} spine check-disclosures <wave-file>
```

Read the **exit code only** — this gate never grep-parses the spine's `## Disclosures` table (the convention-coupled parse-back class, #141/#146 fixed that once already). Exit `0` → `disclosures: 0 open of N — archive gate CLEAR`, continue straight to the Guards below. **Non-zero exit → BLOCKED: do not archive**, regardless of how few rows are open or how late in the day it is.

On a non-zero exit, the checked step is: **name every open disclosure the command printed, and give each one a disposition — chosen from exactly these four, no others accepted (not even `open` itself):**

`resolved-in-slice | scope-extension | filed:<id> | dropped:<reason>`

Set each one through the engine, never by hand-editing the spine:

```bash
{{wave-cli}} spine set-disposition <wave-file> <disclosure-ref> <disposition>
```

Then re-run `check-disclosures` — repeat until it reports `0 open`. Only then proceed to the Guards below. The gate demands **that** a disposition exists for every open entry; it never judges the disposition's quality — `dropped:<reason>` clears the gate exactly like `resolved-in-slice` does. That split is deliberate (ADR-0027): existence is enforced mechanically here, quality stays a human call.

### Disposition defaults — which disposition to reach for (ADR-0027 Amendment 2026-07-31)

**The gate above is untouched by these defaults.** It still checks existence only, and it still passes any of the four values. What follows is the *quality* half the gate deliberately does not enforce: the defaults that stop "every disclosure is durable" from silently becoming "every disclosure gets its own ticket". Left unchecked that is what it becomes — one wave closed 9 issues and filed 10 new ones, a 1:1 replacement rate, while the same day's bundled close turned 13 disclosures into 4 tickets.

**1. Triviality default — a disclosure earns its OWN ticket only when it names a mechanism defect with an observed consequence.** The predicate, not a class list:

> Would this, left unfixed, **change the behaviour of an agent, a guard, or a gate in a future wave**?

- **Yes** → it earns its own ticket. A detection gap in a guard qualifies on its own terms — no special-case rule for security-relevant holes is needed, because a hole *is* a mechanism defect with an observed consequence.
- **No** → it defaults into a bundle. Measurement residue, dead code, doc staleness, catalog upkeep all land here.

The Coordinator may **promote** a bundle-default item to its own ticket on judgment — a constructed reproduction, say, earns promotion by judgment rather than automatically. Evidence for the predicate may come from **any** spine source: Worker prose, Reviewer confirmation, or the Coordinator's own observation. They land identically, exactly as capture does.

**2. Bundles are thematic, never per-wave.** A thematic bundle — doc-reconciliation, HITL-gate follow-ups — has coherent Files, one Risk, one Worker, and decorates later into a **single grabbable row**. A per-wave hygiene bundle mixes whatever this particular wave happened to stir up: its Files scope becomes a conflict-map hub and fails "files-scope sound" structurally, trading a wave's worth of parallelism for a few minutes of close-time convenience. If the only thing the items share is the wave they came from, that is not a theme.

**3. `filed:<id>` N:1 *is* the bundling mechanism — there is nothing else to learn.** Several disclosures carrying the **same** filed id **are** the bundle. There is no `bundled:` token, no bundle id, and no fifth disposition value; the four above remain the whole vocabulary. Give each item in the bundle the same `filed:<id>`:

```bash
{{wave-cli}} spine set-disposition <wave-file> <disclosure-ref-1> filed:<id>
{{wave-cli}} spine set-disposition <wave-file> <disclosure-ref-2> filed:<id>
```

**4. A bundle accepts appends only while it is still bare.** A still-bare, same-theme bundle filed by an *earlier* wave takes further items: point the new disclosures at `filed:<existing-id>` and amend that issue with a provenance line for each (`issue-store amend`, Convention 6 — the amend facet, never a raw tracker write). **Once the bundle has been decorated, its scope is frozen**: file a fresh bundle instead. Never widen the Files declaration of an issue that may already sit in a conflict map or under a claim — that is a silent cross-wave hazard, not an edit.

**5. Author the observation, never the unverified diagnosis.** A `filed:` body carries **symptom + evidence + provenance**. A causal claim or a fix prescription goes in **only when it has been verified**; otherwise mark it explicitly as a hypothesis. The later Worker then investigates fresh instead of implementing a diagnosis written at the end of a long day — and a wrong one written at close time is faithfully implemented, because the ticket reads as settled. This is why a verify-before-file gate at close was rejected rather than added: it demands the highest-judgment work at the structurally worst hour, and it would not have caught the case that motivated the rule — that misdiagnosis survived several live looks and fell only when the fix was exercised. Fresh investigation catches cause-attribution errors; a close-time check does not.

**Premise currency is NOT checked here.** A bare filed issue whose premise has already gone stale on `main` is caught at the *next* step in its lifecycle — `triage` verifies the premise of any wave-provenance issue against current `main` before recommending, regardless of category, with a `superseded`-close as the cheap exit. Do not re-derive that check at close time; file the observation and let triage do the verification with a fresh head.

**`filed:<id>` — the existence-not-readiness split (ADR-0027).** `filed:<id>` records only that a **bare** issue now exists for the gap — created inline (`issue-store create`, or the host CLI per the ADR's interim note) with a title, the gap description, and a **provenance line** (wave slug, row id, iteration) — **deliberately without an eligibility label**. That bare issue is not wave-ready yet. Decoration (Risk / Worker / Files / Blocked-by, the eligibility label) is a separate, *later* `to-issues` decorate-mode step, done with the **next** wave's planning context — a wiring-gap follow-up's Files are precisely the call sites outside the old slice, which wants the wider-lens planning pass, not a rushed guess at close time. Do not decorate at disposition time; filing (existence) and deciding wave-readiness (decoration) are two different steps on purpose.

**Filing the bare issue — worked `--input` shape.** A bare issue has no Header-Block to fall back on, so `bodySections` **is** its entire authored content — the Gap text and the provenance line ride there or they ride nowhere. Compose the `--input` file explicitly, never as an afterthought typed alongside the disposition call:

```json
{
  "title": "<the disclosure's one-line summary>",
  "filingHint": "<kebab-slug>",
  "bodySections": [
    { "heading": "Gap", "markdown": "<the disclosure's Gap text, verbatim>" },
    { "heading": "Provenance", "markdown": "<wave slug, row id, iteration>" }
  ]
}
```

```bash
{{wave-cli}} issue-store create --input <input.json>
```

`issue-store create` now **rejects** a bare input (no Header-Block) whose `bodySections` is absent, `[]`, or every entry's `markdown` is blank — a usage error (exit 2), before any write. Before #278, no such check existed anywhere: `classifyCreateInput` judged only the Header-Block group to decide bare vs. decorated and never looked at `bodySections`, so a bare `--input` that forgot the Gap/Provenance prose still filed successfully — silently, with an empty body. That is exactly how it happened: ten dispositions filed from one wave's disclosures all landed on the tracker with **0 body chars**; the text survived only because the spine was still archived, and triage had to reconstruct the Provenance section and Agent Brief from that archive by hand. #278 first added the rejection as a predicate applied at the CLI layer, outside the classifier; #309 then moved that same requirement into `classifyCreateInput` itself, so today the classifier — not the CLI — is the single owner of the whole bare/decorated invariant, body content included. Read the CLI's usage message on rejection — it names the fix (`bodySections`), not just the failure.

*Considered and set aside:* a second guard where the close flow reads back the filed issue's body before recording `filed:<id>`. The reject-at-create guard above already makes an empty-body bare issue impossible to write in the first place, so a read-back would only re-detect a failure the write path can no longer produce; not worth the extra round trip unless a future gap proves this one insufficient.

## Awaiting-human gate — BEFORE the archive move, beside the disclosure gate

**Run this second, every time, after `check-disclosures` and before either Guard below.** Like the disclosure gate it is a mechanical existence check, not a judgment call, and like it you read the **exit code only**:

```bash
{{wave-cli}} spine check-awaiting-human <wave-file>
```

Exit `0` → `awaiting-human: 0 of N human-gated rows — archive gate CLEAR`, continue to the Guards below. **Non-zero exit → BLOCKED: do not archive.**

**Why this gate exists — the stranded claim (ADR-0036).** An awaiting-human row sits at `planned` — neither running nor finalised, so the terminality Guard structurally cannot see it — and its tracker claim is **still live** (`queued`; nothing ever dispatched it, so nothing ever released it). Archive past it and the issue reads as **claimed** to every future `wave-plan` with no live spine left to reconcile against — no self-healing path from there. The design rationale (why fail-closed rather than advisory, why its own gate rather than a stricter terminality read, the considered alternatives) lives in ADR-0036, not here.

**Fail-closed in both directions.** An awaiting-human row blocks the archive, and so does a spine that cannot be read or parsed — unknown is blocked. Same stance as `check-disclosures` (ADR-0036).

**Two exits, and only these two.** The gate's own output prints both; neither is a default, and the Operator picks:

1. **The human acts.** Do the gated work, then let `wave-start` dispatch the row on a later pass. It leaves `planned`, stops matching the gate, and the wave finishes normally. Choose this when the wave is still live and the human action is imminent.
2. **Park + unclaim** (ADR-0022) — the row leaves this wave for re-planning:
   ```bash
   {{wave-cli}} spine set-row-state <wave-file> <id> parked
   {{wave-cli}} issue-store unclaim <id>
   ```
   `parked` is terminal **and** claim-releasing, so the row drops out of the gate *and* out of the terminality Guard's pending set. Choose this when the human action is not going to happen on this wave's clock. The issue comes back in a future wave, drawn fresh from the pool.

Then re-run `check-awaiting-human` and confirm `0 awaiting` before touching the archive move.

**The gate does NOT fire on a parked row, and that is load-bearing** (ADR-0022). A parked row's claim was already released at park time, so it is precisely the shape an archive may proceed past. A gate that still blocked on it would refuse to archive a wave that had already taken the gate's own prescribed remedy — exit 2 would become a trap instead of an exit. The engine gets this for free rather than by special case: the predicate is *human-gated **∧** still `planned`* (`humanHeldRowIds`, `tools/wave/src/wave-md-rw.ts`), and parking moves the row off `planned`. A **released** human-gated row — one a human acted on, which then dispatched on an earlier pass — drops out for exactly the same reason.

**Listing without gating.** To see the wave's human lane without branching on it (step 9's report, a mid-wave look), use the sibling listing verb, which emits JSON and always exits `0` on a readable spine:

```bash
{{wave-cli}} spine human-gated <wave-file>
```

Its `rows[]` carries every human-gated row with its `state` and an `awaitingHuman` flag; `awaitingHumanIds` is the gate's own set. An **empty** lane is a legitimate answer, not a failure — do not put an emptiness guard on it.

## Scratch confirmation — the last place the Scribe scratch sweep can still be caught (issue #355)

**Confirm, then archive.** Phase 3 is where the Scribe scratch directory (`.flotilla/tmp/`) is actually swept — on the `--orphans` pass, reported under `orphans.scratch` ([phase 3's reading guide](phase-3-worktree-cleanup.md#the-scribe-scratch-sweep--a-repo-internal-location-that-had-no-lifecycle-issue-355)). This phase does not re-sweep; it is where the close **states which of the three readings it got**, because this is the last step before the wave's own record is moved out of reach:

- `orphans.scratch.removed` non-empty → name the count in the close summary.
- `orphans.scratch.present: false` → the directory did not exist. An honest no-op; say so rather than saying nothing.
- **the `scratch` key was ABSENT, or phase 3's output was never read** → the sweep's outcome is *unknown*, not clean. Re-run phase 3's execute command now (it is idempotent) and read the key, before the move below.

**Why the confirmation belongs to the archive and not to phase 3 alone.** `.flotilla/tmp/` sits beside `.flotilla/waves/`, so it is the archive step — not the cleanup step — that operates in the same directory the residue lives in, and it is the archive step that (in a **tracked** `.flotilla/` consumer) makes a `git mv` + `git commit`. The commit itself only carries what `git mv` staged, so an unswept payload does **not** ride into the archive commit — but it does stay behind as untracked litter in the tree the *next* wave's gates read, in exactly the directory a `git add .flotilla` would sweep whole. This step is cheap because it is a read of output phase 3 already produced; the reason it exists is that "cleanup ran" and "cleanup's scratch result was read" are two different claims, and only the second one is evidence.

**This never blocks the archive.** Unlike the two gates above, this is a reporting obligation, not a fail-closed gate — a payload left on disk costs a stale file, not a stranded claim. Report it; do not hold the wave open for it.

**Guard (terminal-only):** archive only when every row is finalised (no row `dispatched`/`reviewing`/etc.). If any row is still pending → do NOT archive; print `wave not yet terminal (skipped)`.

**Guard (idempotent):** `<wave-file>` already under `.flotilla/waves/_archive/` → print `already archived (no-op)`.

**A consumer's `.flotilla/` may or may not be git-tracked.** flotilla's own dogfood repo keeps it gitignored (toolkit, not consumer); most consumer repos track it (the spine is the durable WAL, so committing it enables resume from a fresh clone — see the setup convention in `wave-setup`). `git mv` fails outright on an ignored/untracked path, so the archive step **detects the spine's actual git-tracked status and picks the matching move, every time** — never assume from the consumer type or from what the last wave did. It also re-checks whether the move already happened, so a second run is a no-op rather than a failed move:

```bash
SLUG=<slug>   # e.g. 2026-06-19-foo

mkdir -p ".flotilla/waves/_archive"   # unconditional — both branches' first-ever
                                       # run needs the destination dir to exist
                                       # before the move; idempotent to re-run.

if [ -f ".flotilla/waves/_archive/$SLUG.md" ] && [ -d ".flotilla/waves/_archive/$SLUG/" ] \
   && [ ! -f ".flotilla/waves/$SLUG.md" ]; then
  echo "already archived (no-op)"           # re-run: BOTH halves of the destination
                                             # populated (spine file + sidecar folder),
                                             # source gone — check the folder too, not
                                             # only the spine file, or a partially
                                             # re-run archive reads as fully done
elif git ls-files --error-unmatch ".flotilla/waves/$SLUG.md" >/dev/null 2>&1; then
  # Tracked: git mv preserves history and needs a commit.
  ARCHIVE_MODE="tracked (git mv + commit)"
  git mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
  git mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
  git commit -m "chore(wave): archive $SLUG → _archive/ (operational close)"
else
  # Ignored/untracked: git mv would fail here; plain mv, no commit to make.
  ARCHIVE_MODE="untracked/ignored (plain mv, no commit)"
  mv ".flotilla/waves/$SLUG.md"  ".flotilla/waves/_archive/$SLUG.md"
  mv ".flotilla/waves/$SLUG/"     ".flotilla/waves/_archive/$SLUG/"
fi
```

Archive moves the spine **and** its sidecar folder together, side by side in `_archive/` — flat layout either way. **Never archive to `done/`** — there is no `done/` close ceremony in flotilla (that is an Ur binding). The tracked move is reversible with `git mv` back if the wave is accidentally closed early; the untracked move is reversible with a plain `mv` back (there is no commit to revert). Re-running never fails just because the move already happened — the idempotency check above runs before mode-detection, in either mode.

**Durability consequence (report, don't decide):** an **untracked/ignored `.flotilla/`** means the wave's spine, sidecars, and archive exist **only on the machine that ran the wave** — a fresh clone (a teammate, CI, a new machine) has no wave history at all, only whatever landed in the actual PRs. A **tracked `.flotilla/`** carries that history along with the repo. This slice only makes the archive mechanics honest about whichever answer a consumer has already chosen (via `.gitignore`) — it does **not** recommend one default over the other. That recommendation (should `wave.config.json` / `.flotilla/waves/` be tracked by default for a new consumer) is explicitly deferred to the publication/onboarding PRD, where the wider "what does a new consumer see on `git clone`" question is decided.

After archiving, print a close summary: wave slug, **which archive mode ran** (`tracked (git mv + commit)` or `untracked/ignored (plain mv, no commit)`), per-row final state, advisory merge order, any `needs-attention` flags, **the Scribe scratch reading from the confirmation step above** (N payloads swept / directory absent / outcome unknown and re-run), next human steps (merge PRs in the printed order).

## Common Mistakes

- **Archiving over an open disclosure.** The gate (`spine check-disclosures`) demands **that** a disposition exists for every disclosed entry — it never judges its quality; `dropped:<reason>` passes exactly like `resolved-in-slice` does. Do not hand-wave past a non-zero exit, do not hand-edit the spine's `## Disclosures` table to make it read clear, and do not skip the re-check after dispositioning — disposition every open entry through `spine set-disposition`, then re-run `check-disclosures` and confirm `0 open` before touching the archive move.
- **Archiving before terminal.** The terminality gate (all rows `pr-created`/`approved`/`failed`/`abandoned`/`parked`) must hold. A row still `dispatched`/`reviewing` means the wave isn't done.
- **Archiving past an awaiting-human row and stranding its live claim.** This is *not* covered by the terminality Guard: the row sits at `planned`, which is neither running nor finalised, so "nothing is `dispatched`" reads as safe when it is not. Its `queued` claim was never released (nothing ever dispatched it), and once the spine is in `_archive/` no future `wave-plan` has anything to reconcile the claim against — it has to be found and dropped by hand. Run `spine check-awaiting-human` and take one of the two exits it prints (the human acts, or park + unclaim); do not hand-wave past a non-zero exit, and do not hand-edit the spine's `State` cell to make it read clear.
- **Treating a `parked` row as an awaiting-human blocker.** It is not one, and the gate deliberately does not fire on it (ADR-0022): parking releases the tracker claim, which is the whole hazard. Blocking on a parked row would refuse to archive a wave that had already taken the gate's own prescribed exit.
- **Archiving to `done/`.** flotilla archives to `_archive/`; there is no `done/` close ceremony.
- **Assuming `.flotilla/` is (or isn't) git-tracked and always running `git mv`.** A gitignored/untracked spine makes `git mv` fail outright (P-11 — the first live wave hit this and hand-typed a plain `mv` as a manual workaround). Detect the actual tracked status of the spine file for *this* archive, every time — do not assume from the consumer type, and do not assume from what the previous wave's archive did.
- **Running the archive before the needs-attention phase.** Flag stuck rows first; archive last.
- **Defaulting to one `filed:` ticket per disclosure.** The gate passes either way, which is exactly why the default matters: 1:1 filing turns a wave's disclosures into a wave's worth of new meta-work. Apply the triviality predicate — own ticket only for a mechanism defect with an observed consequence; everything else bundles.
- **Filing a per-wave hygiene bundle.** "Everything this wave stirred up" is not a theme. Its Files scope becomes a conflict-map hub and fails files-scope soundness structurally. Bundle by theme, or file separately.
- **Inventing a `bundled:` token or a bundle id.** The disposition vocabulary is exactly four values. Several disclosures sharing one `filed:<id>` *are* the bundle — N:1 is the whole mechanism.
- **Appending to an already-decorated bundle.** A bundle takes appends only while it is still bare. Once it carries Risk / Worker / Files it may already sit in a conflict map or under a claim, and widening its Files declaration is a silent cross-wave hazard. File a fresh bundle.
- **Writing a causal diagnosis into a `filed:` body to "save the next agent time".** An unverified cause written at close time is faithfully implemented, because the ticket reads as settled. Author symptom + evidence + provenance; mark any hypothesis as one.
- **Verifying a disclosure's premise before filing it.** That check belongs to `triage`, on the bare→ready transition, against current `main` — not to the close ceremony, which is the worst hour for the highest-judgment work.
- **Filing a bare `filed:<id>` issue with no `bodySections`.** `issue-store create` now rejects this loud (exit 2, #278) — but if you hit that rejection, it means the `--input` was composed without the Gap/Provenance prose, not that the guard is wrong. Fix the `--input`, don't route around the check.
- **Archiving without stating the Scribe scratch reading.** "Phase 3 ran" is not the same claim as "phase 3's `orphans.scratch` was read." An absent key means the sweep never looked — re-run phase 3's execute command (idempotent) and read it before the move. This is a reporting obligation, never a reason to hold the wave open.
