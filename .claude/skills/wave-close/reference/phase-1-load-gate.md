# Phase 1 — Load wave-shared + gate

Load **wave-shared** first — `/wave-shared` project-local, `/flotilla:wave-shared` once consumed via the installed plugin (wave-shared's own [plugin-namespaced by-name loads](../../wave-shared/SKILL.md) note has the finding) — for its auth-preflight and atomic-spine conventions.

Read the spine: `{{wave-cli}} spine read <wave-file>`. Confirm the terminality gate (all rows terminal — `pr-created`, `approved`, `failed`, `abandoned`, or `parked`; none `dispatched`/`reviewing`/etc.).

If a `<wave-file>` already lives under `.flotilla/waves/_archive/`, this is a re-run on an archived wave — phases 2–4 still run as idempotent no-ops and phase 5 reports `already archived`; do not STOP.
