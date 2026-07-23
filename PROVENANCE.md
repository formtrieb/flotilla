# Provenance

flotilla was **seeded by copy** (not git-subtree — CHARTER §2) from two upstream
sources. This file records the exact seed points so a future maintainer can diff
against them to back-port an engine fix, and so the upstream licenses are honored.

flotilla's own license is **Apache-2.0** (see [LICENSE](LICENSE)); the seeded
material below is **MIT**, which Apache-2.0 permits incorporating provided the MIT
notice is retained (reproduced at the end of this file).

---

## 1. Engine — `tools/wave/` ← the Ur's `tools/wave/`

- **Source:** the Ur (the frozen predecessor system flotilla was seeded from and generalized against), `tools/wave/src/`. The Ur's own identity is not named here — see CONTEXT.md's `Provenance` glossary for what the alias covers.
- **Seed commit:** `092798fb0f0ca9c092af58b273e4dc2a2eb84371` (branch `feat/new-design-system`, 2026-06-06).
- **Seeded in:** P0 (this commit). The TypeScript engine is the **only** surface kept
  manually in sync with the Ur (CHARTER §4); it imports only `node:*` + `fast-glob` +
  `micromatch`.

**What was copied:** all of `tools/wave/src/*.ts` (18 modules + 16 specs), **except:**

| Excluded at seed | Why | Lands in |
|---|---|---|
| `gate-runner.ts` | the check layer / the Ur's ADR-0005 Pure-I/O check — consumer-specific, rebuilt generic as a flat `checks[]` config (no Pure-I/O re-import) | P6 |
| `gate-runner.spec.ts` | tests the above; also the only file with an `@angular/*` coupling (would not build standalone) | P6 |
| `skill-schema-drift.spec.ts` | a *skill* drift-guard — reads `.claude/skills/wave-start/SKILL.md` (not yet seeded); tests the skill, not an engine module | P7 |

**What changed at seed (mechanical, build-only — no logic touched):**
- Replaced the Nx/Vite build with a standalone toolchain: `package.json`
  (`@flotilla/wave-engine`, plain `vitest`/`tsc` scripts), `tsconfig.json`
  (the Ur's package-scope path aliases dropped, no `experimentalDecorators`), `vitest.config.ts`
  (no `nxViteTsPaths` plugin).
- Trimmed the `gate-runner` re-export from `src/index.ts` (replaced with a pointer note).

**Verified at seed:** `vitest run` → 15 files / 612 tests green; `tsc --noEmit` → 0 errors.

**Post-seed engine fixes (flotilla-side, back-portable to the Ur):**
- `conflict-map.ts` — skip the degenerate self-cell when two inputs share an
  `issueId` (preserves the `ConflictCell` `a < b` invariant). Surfaced by the P4
  cross-wave review; harmless in practice (store `listOpen`/`listClaimed` are
  disjoint) but a real invariant fix worth porting back. Marked in-code.

> Residual Ur-isms still present (genericized later, not P0): doc-comment examples
> referencing `nx run …` in `worker-report-schema.ts` / `dor-gate.ts`, and the
> `header-parser` still in engine form (becomes `createHeaderParser(schema)` + the
> `IssueView` adapter boundary in P1).

---

## 2. Front-half skills ← github.com/mattpocock/skills

- **Source:** `github.com/mattpocock/skills` (public).
- **License — confirmed at source (2026-06-06):** root `LICENSE` = **MIT**,
  `Copyright (c) 2026 Matt Pocock`
  ([blob](https://github.com/mattpocock/skills/blob/main/LICENSE)). The installed
  copies carried no co-located LICENSE; the upstream notice was verified directly
  (ADR-0010).
- **Skills seeded (P7, 2026-06-06):** `to-issues`, `to-prd`, `triage` — copied from
  the local install at `~/.claude/skills/{to-issues,to-prd,triage}` and rewritten
  generic (flotilla-first, GitHub-Issues-first, tracker-agnostic). `grill-me` was
  already present as a pre-existing project skill and was not re-seeded.
  `grill-with-docs` was **not** shipped at P7 — flotilla's references to it (this
  CLAUDE.md's skill-pipeline line, `triage`'s step 4, `to-prd`'s handoff line)
  resolved only on a machine where the operator had personally installed it,
  breaking ADR-0010's "no external skill required to be installed" promise for
  that one leg. Re-seeded 2026-07-23 (FOR-85, ADR-0010 execution): `SKILL.md`,
  `CONTEXT-FORMAT.md`, `ADR-FORMAT.md` copied byte-identical from the local
  operator install at `~/.claude/skills/grill-with-docs/` into
  `.claude/skills/grill-with-docs/` — no rewrite, no rename, since the content
  was already fully generic (assumes only `CONTEXT.md` + `docs/adr/`, flotilla's
  own conventions). From this point the project skill shadows the operator's
  user-level install (most specific wins); future grill improvements belong
  in-repo.
- **Upstream `main` tip SHA at seed time (2026-06-06):** `be55a7970319ede7965edbb02b5e41cba1ca82c9`
  (obtained via `git ls-remote https://github.com/mattpocock/skills main`; the
  verification reference point noted at ADR-0010 was `aaf2453`, 2026-05-31).
- **Upstream `main` tip SHA at the 2026-07-23 grill-with-docs re-seed:**
  `ed37663cc5fbef691ddfecd080dff42f7e7e350d` (obtained via
  `git ls-remote https://github.com/mattpocock/skills refs/heads/main`).
- **Upstream restructure note (2026-07-23):** upstream's `grill-with-docs` has
  since been restructured into a 245-byte stub that delegates to `/grilling` +
  `/domain-modeling` and no longer ships `CONTEXT-FORMAT.md` / `ADR-FORMAT.md`.
  flotilla's copy is a **deliberate fork of the proven, battle-tested version**
  installed locally at seed time, not a resync candidate — do not replace it
  with the upstream stub.
- **Status:** `to-issues`/`to-prd`/`triage` seeded + rewritten generic (P7);
  `grill-with-docs` seeded verbatim, forked from upstream (2026-07-23).

---

## Retained upstream MIT notice

The following notice covers the Matt-Pocock-seeded front-half skills (§2) and is
reproduced per the MIT License terms:

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
