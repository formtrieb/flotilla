# Phase 1 — Load wave-shared + gate

Read `../wave-shared/SKILL.md` and every file under `../wave-shared/reference/`, resolved against wave-close's own base directory (not this reference file's, which sits one level deeper) — for its auth-preflight and atomic-spine conventions.

Also read [close-mechanics.md](close-mechanics.md) once, here — the cross-phase exit-code and command tables every later phase draws on. No other phase names it.

Read the spine and confirm the terminality gate before doing anything else:

```bash
WAVE=.flotilla/waves/2026-06-19-foo.md   # this wave's spine path

{{wave-cli}} spine read "$WAVE"
```

Scan every Plan-Table row's `State` cell. Terminal = the engine's `TERMINAL_ROW_STATES`, the exported partition of `ROW_STATES` that this list is a transcription of: `pr-created` | `approved` | `failed` | `abandoned` | `parked` (`parked`: ADR-0022). The same five the `worktree-cleanup --orphans` terminal-wave verdict and the resume reconciliation read — if this list and that constant ever disagree, the constant is right. None may still be `dispatched` | `re-dispatched` | `reviewing` | `report-in` | `verdict-in`. If any row is non-terminal, STOP:

```
wave not yet terminal — N row(s) still in flight
```

If a `<wave-file>` already lives under `.flotilla/waves/_archive/`, this is a re-run on an archived wave — phases 2–4 still run as idempotent no-ops and phase 5 reports `already archived`; do not STOP.
