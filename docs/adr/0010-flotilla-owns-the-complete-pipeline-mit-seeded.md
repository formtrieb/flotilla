# flotilla owns the complete skill pipeline; the front-half is seeded from Matt Pocock's MIT skills with attribution

flotilla ships the **whole pipeline as its own self-contained skills** — `triage`, `to-prd`, `to-issues`, `grill` (front-half) plus the `wave-*` execution skills — with **no external skill required to be installed**. The front-half is **seeded by copy from Matt Pocock's MIT-licensed skills** (the `wave-*` from the Ur), rewritten generic, with **MIT attribution retained in `PROVENANCE.md`**.

## Why

The motive is **control + gap-closure**. Matt's skills are excellent but have implementation gaps — most concretely, `to-issues`' template emits `## Parent / ## What to build / ## Acceptance criteria / ## Blocked by` but **no wave Header-Block** (`## Files`, Risk, Worker), so its issues are triage-`ready-for-agent` yet **wave-ineligible** to the engine (confirmed against the wiki pilot's issues #15/#17). Owning the full set lets flotilla close those gaps and deliver one coherent product, instead of carrying a dependency surface that can drift or leave holes. MIT permits the reuse provided attribution is preserved.

## `to-issues` specifics

- **Dual-mode:** either **create** a fresh issue already annotated with the wave Header-Block, or **decorate** an existing triage-ready issue (the wiki pilot's reality) by adding `Files`/`Risk`/`Worker`.
- The wave Header-Block lives **on the tracker issue** — body `## Files` + `risk/*`/`worker/*` labels — so it round-trips through `IssueView` (Ur Header-Block parity) and is human-visible. It is **not** stored in the spine (the spine holds orchestration *state*, not issue properties — ADR-0008).
- `Risk`/`Worker` values come from `wave.config` (ADR-0007); the eligibility labels stay the consumer's (ADR-0003).

## Considered Options

- **flotilla owns the complete pipeline, MIT-seeded** (chosen).
- **Compose with Matt's installed skills** (rejected) — a dependency surface plus their implementation gaps, and no control over the end-to-end result.
- **flotilla ships only a thin `wave-annotate` step over consumer-created issues** (rejected) — smaller, but it does not deliver the whole set the product wants to own.

## Consequences

- `PROVENANCE.md` (created in the P0 seed commit) records **both** seed sources and honors their licenses: the Ur's `tools/wave @ <sha>` and `Matt Pocock skills @ github.com/mattpocock/skills` (confirmed source ref via the local `.skill-lock.json`), with the upstream license notice/attribution retained.
- **License caveat — RESOLVED (2026-06-06).** The installed skills indeed carry **no co-located LICENSE file**, but the upstream license was fetched and confirmed at source: `github.com/mattpocock/skills` (public) ships a root **`LICENSE`** = **MIT**, **`Copyright (c) 2026 Matt Pocock`** ([blob](https://github.com/mattpocock/skills/blob/main/LICENSE)). All five front-half skills live under that license: `skills/engineering/{triage,to-prd,to-issues,grill-with-docs}` + `skills/productivity/grill-me`. The README imposes nothing beyond MIT. → P0 may seed by copy; it only needs to **retain the MIT notice** in `PROVENANCE.md` (block below) and **stamp the actual copy-time SHA** (`.skill-lock.json` is absent, so capture the upstream `main` tip at copy time; the verification reference point was `aaf2453` / 2026-05-31).
  - Ready-to-paste `PROVENANCE.md` attribution block:
    > **Front-half skills** (`triage`, `to-prd`, `to-issues`, `grill-me`, `grill-with-docs`) seeded by copy from **Matt Pocock's skills** — `github.com/mattpocock/skills` @ `<copy-time-sha>`, MIT License, Copyright (c) 2026 Matt Pocock — then rewritten generic. The upstream MIT notice is retained per its terms.
- flotilla's external consumers get a complete pipeline with **no external skill prerequisite**.
- §10's "self-contained, not dependent on Matt's base skill" is strengthened: the *whole* front-half is flotilla-owned, not just `to-issues`.
