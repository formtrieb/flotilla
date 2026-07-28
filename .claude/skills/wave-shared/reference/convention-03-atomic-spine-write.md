## Convention 3 — one atomic spine write per state flip

The spine (`.flotilla/waves/<slug>.md`) is the resume-authoritative ledger (ADR-0002 WAL). Every state flip is **one atomic spine write** — read the spine, apply exactly one row's change, flush. Never batch two flips into one read-modify-write; never leave the spine mid-edit. The discipline:

- One flip = one `readSpine` → mutate one row → flush. If the process dies, resume reads a spine that is either fully pre-flip or fully post-flip — never a torn half.
- The tracker transition (`issue-store transition`) and the spine write are paired, but the **spine is authority**: on GitHub the rung is *derived*, so a crash after the spine flush is recoverable (resume re-asserts the claim); a crash after a tracker write but before the spine flush is the dangerous inversion — always flush the spine to reflect the new state as the durable record.
- Sidecar reports/verdicts live under `.flotilla/waves/<slug>/reports/` and `.flotilla/waves/<slug>/verdicts/` (relative to the spine's own directory) — write the artefact, then the spine row that references it, as separate atomic steps.
