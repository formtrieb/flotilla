# The loaded corpus is a pinned measure — a rule's Enforcement Tier decides its reading class, and growth is a diff, not a drift

Two tickets measured the same cost from two sides. #714 (installed-form consumer, 2.3.0): before a single row is dispatched, `wave-start` instructs the Coordinator to read `wave-shared/SKILL.md` and every file under `wave-shared/reference/`, then reaches two more references by pointer — on the order of 300 KB before the first agent runs, for a one-line change; the consumer disclosed reading four documents in full and the rest selectively, the only honest measurement of the gap between what is instructed and what is read. FOR-370 (the Linear twin) named the other side: the plugin ships the whole repository because skills *might* depend on `docs/`. Grilled 2026-09-16 against `main` 16bc199, with the corpus measured rather than argued:

| Measure | Value |
|---|---|
| Corpus (`.claude/skills/**/*.md` + `.claude/agents/*.md`) | 1,349,068 B — +122 KB since 2.1.0, **after** three residual-form rows landed (#509, #510, #689) |
| Shared standing load (`wave-shared/SKILL.md` + `reference/*`) | 200,472 B; `reference/` alone 162 KB at 2.3.0 (right after #689) → 173 KB now |
| wave-setup pair (`SKILL.md` + `setup-mechanics.md`) | 205 KB before #509 → 174 KB after → **236 KB now**, 16 % above its own pre-diet size |
| Growth since 2.3.0, four step-load files | +99 KB (setup-mechanics +29, workflow-driver +26 — regrown after #680 shipped the script into the engine —, phase-3-worktree-cleanup +25, wave-setup SKILL +19) |
| Structural enforcement declared in a fixed form, per convention file | 0 of 16 — Convention 8 carries a 10 KB design narrative of the Echo-Guard hook in the always-loaded tier; Convention 12 does not name its own hook as enforcement |
| Convention citations across 107 archived spines (ADR-0034's ledger; Coordinator-side, spine text only) | 0–18 waves per convention; Conventions 1, 2, 3, 5 and 6 cited in zero spines under every spelling tried — see Amendment 2026-09-21 for the matching rule and why this is a different population from the row below |
| Convention citations across 794 archived sidecars (`reports/` + `verdicts/` files beneath the archive; agent-side) | 0–477 files per convention (Convention 2: 1 file; Convention 3: 0 files; Convention 6: 3 files), counted by the same matching rule as the spine row above (Amendment 2026-09-21). A third, still different population: the hundreds of driver-asset citations (9/10/11/8/13) come through the driver asset itself, which carries 54 KB of brief text naming Conventions 1, 4, 8–13 |
| Skill instructions that *read* `docs/` at runtime | 1 (the contributor README — not a skill body); 100 `docs/` citations in 33 of 65 files, all pointers |

Three findings shaped the decision. The always-loaded tier holds design narrative for rules that already have structure — the "promotion without walk-back" ADR-0034 names as a silent doctrine violation, at file scale, unenforced, and measurably outrun twice. Growth lands in the pointer-reached mechanics files, which cost per wave just as surely (every `wave-start` runs every step, every close every phase). And FOR-370's thesis — skill citations into `docs/` are evidence, load-bearing knowledge is skill-local — is already true in the corpus, only nowhere pinned.

## Decision

**Three reading classes, decided by when a file is read — never called tiers** (the word is already taken twice, CONTEXT.md "Flagged ambiguities"):

- **Standing load** — read before acting, on every run, whatever step follows: the invoked skill's own `SKILL.md`, `wave-shared/SKILL.md`, every file under `wave-shared/reference/`. Loaded whole, so a `Convention <n>` citation always resolves (ADR-0028 stands: no enumerated minimum, no index).
- **Step load** — named by the procedure step that needs it, read then: every `*-mechanics.md`, the driver reference, and from now on **`wave-close`'s phase files**. The pointer is the only entry; a file no step names is unreachable by design.
- **Evidence** — read by no skill at runtime: a convention's or a skill's `evidence/` sibling, `docs/adr/`, `docs/retros/`, CHARTER. Reached on an explicit want, by a human or on a pointer deliberately followed. Every `docs/` citation in a skill is this class — a pointer to *why*, never a dependency on *what*.

**A rule's Enforcement Tier (ADR-0034) decides which class its prose belongs in, and the file says so in a fixed line.** Directly under each `## Convention N — …` heading:

```
**Enforced by:** <rung> — <artifact>[; <rung> — <artifact> (<which half>)]
```

with the rung vocabulary closed to ADR-0034's ladder (engine refusal · schema boundary · drift-spec · hook · brief prose · reference doc). A convention whose halves sit on different rungs names each — Convention 12: *hook `tools/wave/hooks/conv12-guard.cjs` (half one); reference doc — this file (half two)*. A rule with a structural rung appears in the standing load in its **residual form** (the rule, its one-line why, the pointer to the structure, its Common Mistakes); a rule on a prose rung keeps its full prose there, because the prose *is* the enforcement — that is what makes an omission loud rather than silently incomplete, the constraint #714 asked the design to honour. Everything a structure now carries — derivations, mechanism narratives, incident histories — moves to the same-named `evidence/` sibling, one pointer sentence left behind. The guard (`skill-reference-guard.spec.ts` or a sibling spec) checks four things, all mechanical: exactly one declaration per convention file; every backticked artifact path in it resolves in the clone (self-policing, as the consumer-scaffold pairs are — a hook that vanishes turns its declaration red instead of into a lie); rung words from the closed vocabulary; a structural rung names at least one artifact. **The residual-form shape itself is not mechanised.** A heading whitelist was considered and rejected: it is defeated by writing under an allowed heading — the author-controlled escape ADR-0043 describes — and Conventions 4 and 12 legitimately carry rule content in sub-sections.

**Growth is made loud by two pinned measures, named constants in the guard beside `HIGHEST_ALLOCATED_CONVENTION`:**

| Constant | Population | Measured 2026-09-16 |
|---|---|---|
| `SHARED_STANDING_LOAD_CEILING_BYTES` | `wave-shared/SKILL.md` + `wave-shared/reference/*.md` — the number #714 measured | 200,472 B |
| `LOADED_CORPUS_CEILING_BYTES` | every `.md` under `.claude/skills/**` and `.claude/agents/` **except `**/evidence/**`** — standing load plus step load, everything a run can read | 1,288,002 B |

The predicate is *measured sum ≤ constant*, the constant is the measured sum **rounded up to the next full KB** (a wording fix passes; a new paragraph does not), and the guard prints the current sum on every run. **Lowering is free** — a walk-back row lowers the bytes and leaves the constant alone; a final row of the wave lowers the constant to the new measure. **Raising happens only in the same diff**, with a one-line why beside the number — ADR-0034's diff-twin duty, in a form nobody can forget. The second constant is the valve's definition: with the standing load capped, the only place text can go without a visible bump is `evidence/`, the class no run reads — never a mechanics file. `evidence/` is therefore no longer wave-shared's alone: any skill may own one (`wave-start`, `wave-close`, `wave-setup` first), reached by the same sibling-path read (ADR-0040).

**Step load follows the same discipline with the engine verb as its structure.** A mechanics section about a mechanism an engine verb now owns (`compose-driver`, `route-tuple`, `close-row`, `worktree-cleanup`) keeps the invocation, the exit codes and what the verb refuses; its derivation and incident history go to the skill's `evidence/`. `wave-close`'s "load every file under `reference/`" line goes: each phase step names its phase file, `close-mechanics.md` (exit-code tables, cross-phase) is named once in step 1. Nothing outside `wave-close` cites a phase except by pointer (wave-resume's link to phase 3, the engine's stderr naming phase 6), and phases run in sequence — a forward citation resolves when its phase is reached.

**The dependency direction is pinned; the plugin clone is not narrowed.** Two further guard predicates: no shipped skill or agent body *instructs* a runtime read of `docs/` (population: `SKILL.md` bodies, `reference/`, agents — the contributor README is not a skill body); and no citation of a maintainer-only file (`docs/RELEASING.md` first; the list is a named const) in the shipped corpus — the rule the Operator stated on 2026-09-16 over #781, structural once #801 removes the three current sites. That delivers what FOR-370 wanted from its first two steps — a docs restructuring cannot break an installed skill, a consumer session is not pointed into contributor doctrine — without changing the install surface. ADR-0031 stands unamended: the clone stays full, `docs/` citations stay class (b) with their existence predicate (which runs in source form, where `docs/` exists, so a dead pointer still fails). Narrowing `marketplace.json` is refiled as its own decision after FOR-481's measurement of what the runtime pieces are (manifest hooks or scaffolded copies), because that measurement decides what a narrowed payload must carry.

## Considered Options

- **A named minimum per skill, the rest on demand** (#714's own sketch) — rejected: an enumerated minimum is the per-convention index ADR-0028 rejected (every addition a conflict on a shared file), and it produces exactly the failure #714 feared — a document off the list is invisible, not loud. The loud property comes from structure or from full prose, never from a list.
- **Shrink prose into verbs under a byte cap per file** (the MoplaDS consumer analysis) — rejected as stated: it is the absolute per-file budget ADR-0034 refused (arbitrary, instantly violated, a mass rewrite by the back door). What survives of it is the verb-as-structure criterion for step load, above.
- **Heading whitelist for reference files** — rejected, see the Decision: an author-side escape, and it would forbid legitimate rule sub-sections.
- **One constant over the standing load only** — rejected during the grill: it leaves a 668 KB step-load valve open, which is where the measured growth already goes; text would migrate from the capped class into the uncapped one and still be read every wave.
- **Narrow the plugin clone now** (FOR-370 step 3) — deferred, not rejected: its benefits arrive through the two predicates, its input is FOR-481's probe, and its cost is an install-surface change for every consumer at once.
- **Run FOR-481's manifest-hook probe inside this grill** — deferred: it needs a worktree-isolated dispatch under the same containment root a live wave was sweeping, and with the narrowing deferred its input is deferred.

## Consequences

- One wave of ten rows, in three rounds, landing in 2.6.0, each PR body recording bytes before → after for its files and its class (the #689 form): (1) the guard row alone — declaration lines in all 16 convention files, the four declaration predicates, both constants at today's rounded measure, the `docs/`-runtime-read and maintainer-file predicates; (2) in parallel, disjoint files — `wave-close` phases to step load; walk-backs of Conventions 8, 12, 13 and 4 into `evidence/`; step-load walk-backs of `workflow-driver.md`, `phase-3-worktree-cleanup.md` and `start-mechanics.md` into new `wave-start/evidence/` and `wave-close/evidence/`; (3) the ratchet row alone — both constants lowered to the measured result, the wave's delta named. #801 lands before (1).
- Named and not in this wave: the wave-setup pair (236 KB, read once per repo, its diet outrun) — its own row later; the drift-pinned schema copies in `wave-shared/SKILL.md` (7 KB the Coordinator no longer pastes since `compose-driver`).
- CONTEXT.md gains **Standing load**, **Step load** and **Evidence (reading class)** under a new `### Reading classes` group, and the "tier"/"evidence" flags. ADR-0034 and ADR-0028 carry one amendment each (the per-class measure vs the per-file rejection; the phase directory and per-skill `evidence/`). ADR-0031 is untouched.
- Minor, with a consumer heads-up in the 2.6.0 Upgrading section: `wave-close` no longer reads its whole `reference/` directory up front, and `evidence/` directories appear beside `reference/` in more skills.
- This ADR closes no issue and lands Coordinator-direct (ADR-0033, Convention 15). #714 closes on the rows; FOR-370 closes with steps 1–2 delivered and step 3 handed to the decision beside FOR-481.

## Amendment 2026-09-21 — the ledger row named only the spines but its three per-convention figures were the sidecars'; both populations are now named and measured separately

*Measurement-provenance correction, not a change of the decision — the demotion side of the decision (moving narrative out of the always-loaded tier costs a Coordinator nothing) is unaffected.*

The measurement-table row above used to read "Convention citations across 106 archived spines (ADR-0034's ledger)" with the value "Coordinator-side, spine text only: 0–15 waves per convention (Convention 3: none; 2: one; 6: three)". The three named per-convention figures do not reproduce against the archived spines under any spelling of a convention citation — they reproduce **exactly** against a different population, the archived sidecars, while the heading named only the spines. The word "sidecars" here means the `reports/` and `verdicts/` files beneath the archive, one level below the spine files themselves — agent-side artifacts, not the Coordinator-side spine text the row's own heading promised.

**The two populations, each measured separately:**

- **107 archived spines** (ADR-0034's ledger; Coordinator-side, spine text only). Per-convention range: 0–18 waves. Conventions 1, 2, 3, 5 and 6 are cited in zero spines.
- **794 archived sidecars** (every `reports/` and `verdicts/` file beneath the archive; agent-side). Per-convention range: 0–477 files. Convention 2: 1 file; Convention 3: 0 files; Convention 6: 3 files.

**Matching rule (so a re-run reproduces rather than re-derives).** For each convention number *N*, count the files in the population whose text matches a citation of that convention in any of its spellings: case-sensitive `Convention N`; the same, case-insensitive; the hyphenated form `Convention-N`; and the short forms (`Conv N`, `Conv.N`). Equivalently, the case-insensitive regex `/\bConv(?:ention)?[\s-]*N\b/i`, with *N* substituted for the convention number. A file counts once for a convention regardless of how many times it cites it.

The contrast between the two populations is worth keeping rather than collapsing into one row, because it *is* the finding this ledger exists to supply: Coordinator-side prose cites conventions rarely — five of sixteen not at all, across a 0–18 range — while agent-side sidecars cite them heavily, up to 477 of 794 files for one convention. That is the demotion-side thesis (moving narrative out of the always-loaded standing-load tier costs a Coordinator nothing) measured from the other end.

Both figures stay dated 2026-09-16 and are transcribed here from the measurement that found this gap, not re-measured for this amendment: the archive is gitignored and absent from a dispatched worktree, and two further waves have been archived since 2026-09-16, so a fresh run would not reproduce the same counts even for the corrected method.

Provenance: filed bare as issue #840 from wave `2026-09-16-reading-classes-and-corpus-diet`, row 815 (the ratchet row, PR #839) — that row's ledger acceptance criterion was graded `deferred` as capability-gated (the ledger needs the gitignored archive, absent from a dispatched worktree); the Coordinator then ran the ledger on its own checkout to answer it, found the reconciliation failure above, and filed the two-population finding as #840.
