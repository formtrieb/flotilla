# Risk is a load-bearing behaviour key; the enum vocab is config-authoritative, Risk behaviour frozen until M2

The enum vocabulary (`Risk`, `Worker`) has **one authoritative source: `wave.config`**, populated by the `wave-setup` binding interview. The Ur's sets ship in P0 only as the interview's **default proposal**; there is no separate "trim during P1" hardcode — trimming is an *interview act*. Every consumer reads `wave.config`: the header-parser/validator, dor-gate, the reviewer routing, the `to-issues` prompt, and the `risk/*` label scheme.

But **`Risk` is not a free-trim membership enum** — specific Risk *strings* key three engine behaviours, so renaming or trimming a value silently no-ops the keyed logic:

- **dor-gate Gate 4** — `header.risk === 'mechanical' && count > 5` and `header.risk === 'cross-feature-refactor' && count === 1` (Risk-specific file-count heuristics).
- **reviewer-profile routing** — `riskClass` bifurcates `quick-verify` vs `full-review` (`reviewer-verdict-schema` / the Ur §6 matrix: `mechanical`/`isolated-refactor` → quick-verify, `cross-feature-refactor`/`public-API-change` → full-review).
- **the hard-STOP** — `verdict-to-event.ts`: `risk === 'public-API-change'` routes to `public-api-approval-required` (the G3 guard).

Canonical sets: Risk = `mechanical · isolated-refactor · cross-feature-refactor · public-API-change`; Worker = `background · background-heavy · foreground · HITL-required` (brand-free, autonomy-first — **ADR-0012** supersedes the Ur's `background-sonnet · background-opus · foreground-opus · HITL-required`; `Worker` remains the freely-trimmable enum, so this default change drives no string-keyed engine behaviour).

Note the phase at which `public-API-change` bites: the hard-STOP is a **landing** gate (verdict phase), **not** a dispatch gate. A `public-API-change` slice is still fully AFK-*implementable* by an autonomous `background-heavy` worker; it only cannot *merge* without the `public-api-approval-required` approval. "AFK" therefore means "implement unattended," not "land unattended" (ADR-0012).

## Decision

- **M1 freezes Risk.** The Risk set and its string-keyed behaviours are kept verbatim; the wiki pilot's wave uses the Ur's Risk set as-is. **Only `Worker` is freely trimmable** (it drives no string-keyed engine behaviour). Membership validation reads `wave.config`, but the values are the frozen set.
- **M2 lifts the Risk→behaviour MAP into config:** each Risk → `{ reviewerProfile, requiresStop, dorRules }`, so dor-gate Gate-4 / routing / `verdict-to-event` consume the map instead of literals — enabling per-consumer Risk taxonomies.
- **Document the routing matrix + public-API hard-STOP** in CHARTER §8 (they appeared in no flotilla doc).

## Considered Options

- **Freeze Risk for M1, lift the behaviour-map in M2** (chosen) — small, safe; the wiki pilot needs no new Risk taxonomy.
- **Membership-array injection alone** (rejected) — `createHeaderParser(schema)` injecting `RISK_VALUES` does **not** parameterize the string-keyed Gate-4/routing/STOP behaviours; it creates a silent-break trap where a trimmed/renamed Risk no-ops a gate. The M1-PRD §2a claim that this "propagates to dor-gate + conflict-map + files-drift in one move" is corrected: conflict-map/files-drift reference Risk zero times; the real consumers are string-keyed.
- **Full behaviour-map lift in M1** (rejected) — overkill for one consumer that uses the stock set.

## Amendment 2026-07-31 — Risk gains a dispatch-side reviewer model-tier consumer; scope universality stands

Context correction first: the "reviewer-profile routing" bullet above described the **Ur seed state**; ADR-0016 deliberately de-coupled flotilla from it — the Reviewer's scope, checklist, and dispatch are universal, and `quick-verify`/`full-review` never keyed any flotilla engine behaviour (today they survive only as fixture strings in specs). That de-coupling stands untouched.

What changes: the uniform strong-model Reviewer became a measured cost driver (2026-07-30: ~150 agents/day, 26 % of the weekly plan in one day; every row's Reviewer re-runs the full verify suite on the strong model regardless of Risk). Decision:

- **Risk derives the Reviewer's *model tier* at dispatch**, mirroring the Worker routing that has existed since ADR-0012: `mechanical`/`isolated-refactor` → standard tier, `cross-feature-refactor`/`public-API-change` → `-heavy`. Tiers bind to concrete models **in the driver config only** (brand-free, ADR-0012's rule) — reverting or re-tiering is a config line, never an ADR.
- **Model tier, never scope tier.** One checklist, one verdict schema, universal dispatch (every row still gets its Reviewer — Risk gates *which model*, never *whether*). No `quick-verify` through the back door.
- **Zero engine surface.** The derivation lives in the dispatch driver (skill-side); the spine's `Reviewer` column stays a uniform vestigial decoration (ADR-0016), no schema or format change, no consumer resync beyond the plugin skill update.

Rejected: **scope tiers** (the Ur coupling ADR-0016 killed — stays dead); **upgrading `-heavy` above the standard model as part of this change** (answers a cost finding with a cost increase; the heavy classes already have the Coordinator over every verdict and, for `public-API-change`, the human landing STOP — if practice shows the heavy Reviewer under-catching, the upgrade is one config line away).

Safety net unchanged: cap=1 re-dispatch, floor checks, ADR-0004 evidence bar, G3 hard-STOP.
