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
- **Filing a bare `filed:<id>` issue with no `bodySections`.** `issue-store create` now rejects this loud (exit 2, #278) — but if you hit that rejection, it means the `--input` was composed without the Gap/Provenance prose, not that the guard is wrong. Fix the `--input`, don't route around the check.
