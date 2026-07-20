# Worker is brand-free and autonomy-first; model tier resolves through config, not the tracker label

The `Worker` vocabulary is **autonomy-first and free of model-brand names**: `background · background-heavy · foreground · HITL-required`. The primary axis a Worker value encodes is **autonomy** (who must be in the loop) — `background` = fully-autonomous AFK · `foreground` = a human co-pilots in chat · `HITL-required` = no agent grabs it until a human acts. The secondary axis — **model tier** — is carried only as an abstract `-heavy` marker; the binding `heavy → <concrete model id>` lives in the skill/driver config, **never in the tracker label**. This replaces the Ur-seeded set (`background-sonnet · background-opus · foreground-opus · HITL-required`), which baked a volatile model brand into a durable, human-visible label.

## Why

The Ur's enum conflated two orthogonal dimensions in one string: a **stable** autonomy class and a **volatile** model tier. Two problems followed:

- **Model brand names rot in durable tracker labels.** A `worker/background-sonnet` label written onto a GitHub issue in June misleads the moment the model line-up turns (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 already churn fast). `Risk` was deliberately *frozen* as a load-bearing key (ADR-0007) — a brand name is the opposite of freezable, yet it sat in the same class of label.
- **Asymmetry + combinatorial blowup.** `foreground-opus` names a model; `HITL-required` does not (correctly — none runs). A third tier (`haiku`) would force `background-haiku`, `foreground-haiku`, … The brand axis multiplies the autonomy axis for no planning benefit.

Splitting the brand out is cheap and safe because **the engine does not switch on `Worker` values** — ADR-0007 records `Worker` as the one *freely trimmable* enum (it drives no string-keyed engine behaviour; only `Risk` does). The interpretation lives entirely in the skills/driver, so changing the default vocabulary cannot silently no-op an engine gate.

This also resolves two adjacent muddles on the **autonomy** axis:

- **`HITL-required` is a legitimate, eligible wave candidate — not a PRD-like non-unit.** It is real wave work at a node in the dependency graph (it may block downstream AFK slices); the coordinator *must* see it to prompt the human in time. So it stays eligibility-stamped and surfaces in `wave-plan`, where the driver treats it as "not autonomously dispatchable — human gate" (the `needs-attention` bridge, ADR-0006). The PRD-eligibility-pollution that ADR-0011 removed does **not** apply here: a PRD is a *document*, an HITL slice is a *work step*. That document-vs-work-step cut is exactly the one ADR-0011 draws — keep it.
- **AFK means "implement unattended," not "implement *and land* unattended."** A `public-API-change` slice can be built by a fully-autonomous `background-heavy` worker; it simply cannot *land* without the merge-time approval STOP (ADR-0007's `public-api-approval-required` guard, which fires at the verdict phase, not at dispatch). Landing approval is an orthogonal, automatic wave gate — not a `Worker` attribute. Had AFK required "land unattended," `background-heavy` (whose whole purpose is the cross-feature / public-API risk classes) would be self-contradictory.

## Considered Options

- **Brand-free, autonomy-first vocabulary; tier→model in config** (chosen) — one `Worker` field (minimal contract change, fits "route from Risk"); the load-bearing routing key stays stable across model generations; the human-visible label stops asserting a model choice that later silently stops being true.
- **Keep the Ur's coupled enum as opaque profile ids** (rejected) — "`background-sonnet`" as just-a-profile-name is defensible only if the name is *not* a brand; the label is human-visible (CONTEXT: "human-visible"), so a brand-named profile id still lies to a human reader as models churn. The honest version of "opaque profile id" is precisely the brand-free set.
- **Split into two fields: `autonomy` + `model-tier`** (rejected) — cleaner axes, but a bigger contract change, two labels per issue, and it commits the *model tier* to planning time when it is better read as a dispatch-time decision the driver can resolve (and re-tune) from `-heavy` + current availability.
- **Drop the tier from the issue entirely (autonomy-only `Worker`)** (rejected) — loses the slicer's useful static signal "this risky slice wants the strong model"; `-heavy` keeps that signal without naming a brand.

## Consequences

- **Default vocabulary changes:** `header-parser`'s `DEFAULT_WAVE_SCHEMA.workerValues` becomes `['background', 'background-heavy', 'foreground', 'HITL-required']`. This is a **deliberate deviation from the Ur** (flotilla's own guidance is not to re-import Ur specifics); the set is config-governed precisely so flotilla's default may differ. ADR-0007's "canonical Worker set" line is updated to match.
- **`to-issues` routing table** maps `AFK + Risk∈{mechanical, isolated-refactor} → background`, `AFK + Risk∈{cross-feature-refactor, public-API-change} → background-heavy`, HITL → `foreground` / `HITL-required`. The skill's AFK definition is narrowed to "implement unattended," with an explicit note that `public-API-change` slices will meet a landing-approval STOP.
- **Tier→model binding** is a skill/driver config concern (P7 `wave-start`): `heavy → <today's strong model>`, default tier → standard model. The engine never sees a concrete model id.
- **Transparency / re-tuning:** the *actually-dispatched* model is recorded by the **driver** in the spine dispatch-log at dispatch time — **not** self-reported in the `WorkerReport` (a model asked for its own identity hallucinates it). This gives consumers the `background-heavy → <model> @ <time>` signal to re-tune the tier binding, while the issue label stays brand-free. (P7 `wave-start` / spine work item.)
- **No new "non-eligible issue" path is needed in `to-issues`:** the only thing it ever files is eligible wave work; documents go through ADR-0011's Document facet.
