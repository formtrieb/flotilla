# flotilla — Retrospektive: Wave 32 „2026-07-27-consumer-gaps" + Wave 33 „2026-07-27-machinery-repair" (dreiunddreißigster und vierunddreißigster Live-Lauf)

Waves: `2026-07-27-consumer-gaps` (Rows 122 / 119 / 118 / 126 / 127 / 131, PRs #132–#137) und `2026-07-27-machinery-repair` (Rows 128 / 139 / 140 / 141 / 142, PRs #143–#147) · Store: GitHub Issues · Anchor W32: `5a2d20f`; Anchor W33: `862fdde` → Tagesende `c9c6c9e` · Testbestand am Tagesende: 1940, `tsc` 0.

Beide Waves waren Reparatur-Waves aus den Funden des ersten Plugin-Consumer-Laufs (Retro `2026-07-27-plugin-consumer-w1`) und der eigenen Betriebsgeschichte: elf Rows, elf `approve`, kein Re-Dispatch, beide Conflict-Maps ∅. Diese Retro ist bewusst schlank — die strukturelle Antwort auf den Tag steht nicht hier, sondern in den drei am Folgetag gesettelten Dokumenten (ADR-0027, ADR-0004-Amendment 2026-07-28, ADR-0028); hier stehen nur die Funde und die eine Beobachtung, die zu ihnen führte.

## 0. Ergebnis in einem Satz

Elf Fixes landeten sauber (Driver-Default auf npm-Package, Operator-Checkliste, Orphan-Sweep-Aufruf, Arm-Path-Branch-Deletion im Engine-Seam, Dispatch-Log-Parse-Back fail-closed, Files-Boundary-Doku, Compose-Assertion generalisiert, Gate 8, Label-Preflight, Harness-dirty-Worktree-Klassifikation) — und die Waves selbst erzeugten dabei vier neue Funde derselben Bauart wie die, die sie fixten: **ein gelandeter Fix, dessen letzte Meile nicht verdrahtet ist.**

## 1. Fund → Ticket

| # | Fund (live beobachtet) | Wo | Ticket |
|---|---|---|---|
| F1 | **Gate 8 ist inert.** `verify-profile-coverage` meldet `deferred — "No verify config supplied"` trotz befülltem `verify`-Block und `--config`: `runDor`/`runDorById` reichen die Profile nie an `validateIssue` durch. Der Row-eigene Worker hatte exakt das unter Convention 9 offengelegt, der Reviewer ehrlich `partial` getickt — live bestätigt bei der W33-Wave-Create; Coverage wurde von Hand mit derselben `micromatch`-Arithmetik nachgerechnet. | W33 wave-create | #151 |
| F2 | **Der Orphan-Sweep-Dry-Run previews nichts, der echte Lauf löscht dann.** `cli.ts`' `--dry-run`-Zweig ruft `planOrphanBranchSweep` nie auf — Preview und Execution teilen keinen Plan. Live beim Close: Dry-Run „nichts selektiert", Sekunden später löschte der echte Lauf Branches. | W32/W33 wave-close | #148 |
| F3 | **Die Arm-Path-Branch-Deletion ist gelandet und vom Skill aus unerreichbar.** Row 140 verdrahtete `--delete-branch` bis in die CLI; die Arm-Invocation in `wave-close`/`close-mechanics.md` fordert sie nicht an und beschreibt weiter das Vor-Fix-Verhalten als Regel. | W33 wave-close | #149 (blocked by #140) |
| F4 | **Der #142-Fix änderte nichts operator-sichtbar.** Die neue Klassifikation (harness-denied-Deletions = disposable) greift in `planCleanup`, aber `executeCleanup` ruft `git worktree remove` ohne `--force` — git verweigert mit derselben Meldung wie vorher. Live-Gate beim Close der eigenen Wave: der Worktree von PR #147s Row blieb stehen; Protokoll war Inspektion + `--force` + `prune` mit Sandbox aus. | W33 wave-close | #150 |
| F5 | **Wiring-Lücke als Klasse: 7 Vorkommen an einem Tag.** F1–F4 plus drei Funde des Consumer-Laufs sind dieselbe Fehlklasse — ein Slice landet vollständig und grün, aber die Verdrahtung zur letzten konsumierenden Stelle fehlt; Convention 9 *erkennt* die Lücke (Disclosure kommt ehrlich), aber nichts *disponiert* sie — Disclosures versanden im Verdict-Sidecar. | Tagesbilanz | Grill → ADR-0027 (Spine-captured Disclosures, Disposition vor Archive), ADR-0004-Amendment (Outcome-AC braucht outcome-übende Evidenz), ADR-0028 (Barrel-Split); Build-Slices #156–#160 |

## 2. Die eine Beobachtung

**Der Fix-Kreislauf divergierte: Reparatur-Waves erzeugten Funde schneller, als sie welche schlossen.** W26→W27 hatte den Kreislauf auf null konvergiert (4→2→0 Funde); dieser Tag lief 7× in dieselbe Klasse, obwohl jede einzelne Occurrence billig war — genau *weil* sie einzeln billig war, wurde sie dreimal als low eingestuft und nie strukturell beantwortet. Die Lehre ist nicht „sorgfältiger reviewen": Jede Lücke war korrekt offengelegt und ehrlich getickt. Die Lücke war ein fehlendes Pipeline-Stück — Disclosures hatten keinen Ort, an dem sie eine erzwungene Disposition bekommen. Das ist seit ADR-0027 entschieden (Vier-Wege-Disposition `resolved-in-slice | scope-extension | filed:<id> | dropped:<reason>` als Close-Gate) und wird mit #156–#158 gebaut. Zweite Hälfte derselben Lehre, jetzt ADR-0004-Amendment: **Voraussetzungen nachmessen, nicht lesen** — ein `met` auf einem outcome-formulierten AC braucht Evidenz, die das Outcome ausübt, nicht Diff-Lektüre (F1 und F4 wären sonst beide als `met` durchgegangen).

## 3. Randnotiz zur Folgewave (kein eigenes Retro)

Wave 34 „2026-07-28-barrel-split-stage1" (#152 → PR #154, der wave-shared-Split nach ADR-0028) braucht über die ADRs hinaus kein Retro. Zwei Occurrences sind festhaltenswert: **(a)** der Reviewer erfüllte die neue ADR-0004-Evidenzlatte freiwillig, eine Stunde nachdem sie entschieden war — alle vier ACs mit ausgeübter, nicht gelesener Evidenz; **(b)** ein Report-Scribe fusionierte `cd` + Engine-Call zu einem Compound-Kommando, das keinen Allowlist-Prefix matcht → Permission-Dialog mitten im AFK-Dispatch (#155, gleiche Klasse wie der env-Wrap-Footgun aus Convention 7).
