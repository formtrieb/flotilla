# Phase 6 — Archive (the last phase — terminal-only, idempotent, layout-aware)

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

`issue-store create` now **rejects** a bare input (no Header-Block) whose `bodySections` is absent, `[]`, or every entry's `markdown` is blank — a usage error (exit 2), before any write (#278). Before this guard, `classifyCreateInput` judged only the Header-Block group and never looked at `bodySections`, so a bare `--input` that forgot the Gap/Provenance prose still filed successfully — silently, with an empty body. That is exactly how it happened: ten dispositions filed from one wave's disclosures all landed on the tracker with **0 body chars**; the text survived only because the spine was still archived, and triage had to reconstruct the Provenance section and Agent Brief from that archive by hand. Read the CLI's usage message on rejection — it names the fix (`bodySections`), not just the failure.

*Considered and set aside:* a second guard where the close flow reads back the filed issue's body before recording `filed:<id>`. The reject-at-create guard above already makes an empty-body bare issue impossible to write in the first place, so a read-back would only re-detect a failure the write path can no longer produce; not worth the extra round trip unless a future gap proves this one insufficient.

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

After archiving, print a close summary: wave slug, **which archive mode ran** (`tracked (git mv + commit)` or `untracked/ignored (plain mv, no commit)`), per-row final state, advisory merge order, any `needs-attention` flags, next human steps (merge PRs in the printed order).

## Common Mistakes

- **Archiving over an open disclosure.** The gate (`spine check-disclosures`) demands **that** a disposition exists for every disclosed entry — it never judges its quality; `dropped:<reason>` passes exactly like `resolved-in-slice` does. Do not hand-wave past a non-zero exit, do not hand-edit the spine's `## Disclosures` table to make it read clear, and do not skip the re-check after dispositioning — disposition every open entry through `spine set-disposition`, then re-run `check-disclosures` and confirm `0 open` before touching the archive move.
- **Archiving before terminal.** The terminality gate (all rows `pr-created`/`approved`/`failed`/`abandoned`/`parked`) must hold. A row still `dispatched`/`reviewing` means the wave isn't done.
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
