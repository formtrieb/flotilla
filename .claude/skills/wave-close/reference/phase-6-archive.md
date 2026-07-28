# Phase 6 — Archive (the last phase — terminal-only, idempotent, layout-aware)

**Guard (terminal-only):** archive only when every row is finalised (no row `dispatched`/`reviewing`/etc.). If any row is still pending → do NOT archive; print `wave not yet terminal (skipped)`.

**Guard (idempotent):** `<wave-file>` already under `.flotilla/waves/_archive/` → print `already archived (no-op)`.

**A consumer's `.flotilla/` may or may not be git-tracked.** flotilla's own dogfood repo keeps it gitignored (toolkit, not consumer); most consumer repos track it (the spine is the durable WAL, so committing it enables resume from a fresh clone — see the setup convention in `wave-setup`). `git mv` fails outright on an ignored/untracked path, so the archive step **detects the spine's actual git-tracked status and picks the matching move, every time** — never assume from the consumer type or from what the last wave did. It also re-checks whether the move already happened, so a second run is a no-op rather than a failed move:

```bash
SLUG=<slug>   # e.g. 2026-06-19-foo

mkdir -p ".flotilla/waves/_archive"   # unconditional — both branches' first-ever
                                       # run needs the destination dir to exist
                                       # before the move; idempotent to re-run.

if [ -f ".flotilla/waves/_archive/$SLUG.md" ] && [ ! -f ".flotilla/waves/$SLUG.md" ]; then
  echo "already archived (no-op)"           # re-run: destination populated, source gone
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

(See [close-mechanics.md](close-mechanics.md) for the full worked version of this check, including the sidecar-folder half of the idempotency test.)

Archive moves the spine **and** its sidecar folder together, side by side in `_archive/` — flat layout either way. **Never archive to `done/`** — there is no `done/` close ceremony in flotilla (that is an Ur binding). The tracked move is reversible with `git mv` back if the wave is accidentally closed early; the untracked move is reversible with a plain `mv` back (there is no commit to revert). Re-running never fails just because the move already happened — the idempotency check above runs before mode-detection, in either mode.

**Durability consequence (report, don't decide):** an **untracked/ignored `.flotilla/`** means the wave's spine, sidecars, and archive exist **only on the machine that ran the wave** — a fresh clone (a teammate, CI, a new machine) has no wave history at all, only whatever landed in the actual PRs. A **tracked `.flotilla/`** carries that history along with the repo. This slice only makes the archive mechanics honest about whichever answer a consumer has already chosen (via `.gitignore`) — it does **not** recommend one default over the other. That recommendation (should `wave.config.json` / `.flotilla/waves/` be tracked by default for a new consumer) is explicitly deferred to the publication/onboarding PRD, where the wider "what does a new consumer see on `git clone`" question is decided.

After archiving, print a close summary: wave slug, **which archive mode ran** (`tracked (git mv + commit)` or `untracked/ignored (plain mv, no commit)`), per-row final state, advisory merge order, any `needs-attention` flags, next human steps (merge PRs in the printed order).

## Common Mistakes

- **Archiving before terminal.** The terminality gate (all rows `pr-created`/`approved`/`failed`/`abandoned`/`parked`) must hold. A row still `dispatched`/`reviewing` means the wave isn't done.
- **Archiving to `done/`.** flotilla archives to `_archive/`; there is no `done/` close ceremony.
- **Assuming `.flotilla/` is (or isn't) git-tracked and always running `git mv`.** A gitignored/untracked spine makes `git mv` fail outright (P-11 — the first live wave hit this and hand-typed a plain `mv` as a manual workaround). Detect the actual tracked status of the spine file for *this* archive, every time — do not assume from the consumer type, and do not assume from what the previous wave's archive did.
- **Running the archive before the needs-attention phase.** Flag stuck rows first; archive last.
