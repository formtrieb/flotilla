# flotilla — Retrospektive: Wave 6 „2026-07-19-hardening-w6" (siebter Live-Lauf)

Wave: `2026-07-19-hardening-w6` · Rows: **FOR-6, FOR-33, FOR-21** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `d948958` → `main` nach dem Close: `85734c0`.

Besonderheit dieses Laufs: beide Kern-Rows wurden **am selben Tag gegrillt, gespec't und gebaut** (FOR-6 → [ADR-0024](../adr/0024-sidecars-are-written-at-agent-return-by-scribes-through-paired-write-verbs.md), FOR-33 → [ADR-0025](../adr/0025-amend-is-a-minimal-authored-content-facet.md); beide Specs tracked und am Anchor in jedem Worker-Worktree), und die Wave trug **einen bewussten Intra-Wave-Overlap** (FOR-6↔FOR-33 auf der wave-shared-Prosa) — der erste Live-Test der „overlap is recorded, not rejected"-Identität unter voller Automatisierung.

## 0. Ergebnis in einem Satz

Wave 6 lief den vollen Zyklus `wave-plan → wave-create → wave-start → wave-close` in einer Session — 3er-Fan-out → **2× `approve` + 1× `changes-requested` mit echtem, live-reproduziertem Defekt (FOR-21: fehlendes `mkdir -p` im tracked-Archive-Snippet) → der erste sauber durchlaufene cap=1-Re-Dispatch der Serie → Iteration-2-`approve`** → ein protokollgemäßer `public-API-change`-STOP (FOR-33, G3) → menschliche Freigabe → 3 squash-PRs #30/#32/#31, der letzte nach dem **vorhergesagten und eingetretenen** wave-shared-Rebase (beide Branches beanspruchten „Convention 5"; Auflösung: Sidecar-Pfad = 5, Amend-Pfad = 6; Union-Gate **vor** dem Merge grün: 1423 = 1379 + 11 + 33) → `main d948958 → 85734c0`, **1423 Tests, tsc 0** → alle 3 `done` via `read-closing`+`close` → Archiv im **plain-mv-Modus, den FOR-21 in derselben Wave gebaut hat**.

## 1. Was richtig gut funktioniert hat

- **Der bewusste Overlap trug end-to-end.** `wave-create` zeichnete die Zelle auf, beide Reviewer *prognostizierten* den Konflikt unabhängig per `git merge-tree` (FOR-6s Reviewer: CONFLICT auf `SKILL.md`, `routing-mechanics.md` merged clean — exakt so kam es), die Arbeit lief parallel in isolierten Worktrees, nur das Landing wurde sequenziert. Der Rebase des zweiten PRs war fünf Minuten Koordinator-Handarbeit mit vollem Kontext; die rebasierte Union lief **vor** dem Merge durch den vollen Gate.
- **Der erste echte cap=1-Zyklus, sauber.** FOR-21s Reviewer fand einen realen Defekt (die `spine create`-ENOENT-Klasse, wieder: `git mv` ohne existierendes Zielverzeichnis), reproduzierte ihn live in einem Scratch-Repo, und formulierte ihn präzise. Der Iteration-2-Worker übernahm den Fix *strukturell* (Hoist über die ganze if/elif/else-Kette, spiegelbildlich zu `close-mechanics.md`) statt minimal, verifizierte alle 4 Archiv-Szenarien erneut, und der zweite Reviewer approvte. Null menschliche Intervention im Loop selbst.
- **Alle gehärteten Vorgänger hielten:** FOR-19s Anchor-Assertion (`log: anchor assertion passed`), FOR-32s Brief-Skeleton (`npm ci` + embedded Spec — kein Worker stolperte über den leeren Worktree), FOR-5s Dispatch-Log (3 Branches + Modelle vor Worker-Existenz), W5-F1s `anyOf`-freie Schema-Kopie (kein 400 beim Fan-out), Convention 4 (`Fixes FOR-N` in allen drei PR-Bodies, alle drei auto-`Done`).
- **G3 feuerte korrekt** (FOR-33 `public-API-change` → `reviewer-approve-public-api` → STOP → Flag → Mensch → clear-flag → Terminator).
- **`host-pr` trug erneut das komplette Landing** (3 Merges durch denselben Proxy, an dem `gh` TLS-scheitert); Branch-Löschung als geprüfter Schritt: 3× `[deleted]`, `git ls-remote --heads origin 'wave/*'` → 0.
- **Selbst-Konsum ohne die W4-F1-Falle:** `merge → pull → reconcile` eingehalten (Pull brauchte Sandbox-aus, wie FOR-36 es dokumentieren wird); die Probe lief mit der Post-Pull-Engine; und das Archiv lief im **untracked/plain-mv-Modus, den FOR-21 in dieser Wave gebaut hat** — diesmal schloss sich die Wave mit ihrem eigenen Fix, *ohne* sich vorher selbst zu belügen.
- **Der Amend-Verb hatte seinen ersten Produktiv-Einsatz noch in derselben Session:** `issue-store amend FOR-33 --patch …` korrigierte den veralteten Titel **seines eigenen Issues** (Round-Trip via `triage-read` verifiziert). Das System reparierte den Satz, der seine Lücke beschrieb, mit dem Verb, das die Lücke bekam.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W6-F1 — Koordinator-Shell-Kleber log Erfolg, während jede CLI-Zeile still scheiterte.**
Eine komplette Routing-Batch (Sidecars + drei Tupel-Routings) lief in einer Shell, deren cwd zwischen den Aufrufen zurückgesprungen war: **jeder** `tsx`-Aufruf scheiterte mit „no such file", aber die dekorativen `echo`-Erfolgszeilen des Skripts druckten „✓" — `set -e` griff in der zsh-Loop-Konstellation nicht. Nichts war geschrieben; gefangen nur, weil der nächste Schritt den Zustand **zurücklas** statt dem Summary zu glauben. Die Engine war unschuldig — die Verben exiten korrekt; gelogen hat der Kleber drumherum. Dieselbe Figur wie W4-F11/FOR-11: *ein Erfolgs-Claim, der nie geprüft wurde.* Zweiter Kleber-Fund derselben Klasse im selben Lauf: ein `re.sub`-Replacement-Escape-Artefakt zerstörte den Iteration-2-Driver (jedes `\n` im JSON wurde zur echten Newline) — gefangen vom Fail-loud-Parser des Workflow-Tools. **Ableitung (Betriebsnotiz, kein Engine-Ticket):** Koordinator-Skripte dekorieren nicht mit Erfolgs-echos; die Verb-Ausgaben sprechen lassen, absolute Pfade verwenden, nach jeder Batch Zustand zurücklesen.

**W6-F2 — Der PR-Titel-Mention-Footgun biss den Koordinator selbst (→ FOR-37, am selben Tag gefiled).**
Der Docs-PR #29 (die Grill-Artefakte!) nannte „FOR-6"/„FOR-33" **im Titel** — beim Merge zog Linears GitHub-Integration beide Issues auf `Done`, Stunden bevor ihre Wave überhaupt dispatcht war. Das w2/FOR-13-Mysterium ist damit deterministisch reproduziert: **eine bloße Id-Erwähnung in PR-Titel/-Body ist auf einem integrierten Tracker eine Aktion beim Merge.** Recovery: raw-GraphQL-Reopen auf `Backlog` (offengelegt; der Amend-Verb existierte noch nicht, und State ist ohnehin nicht seine Dimension). Die Worker-Briefs dieser Wave trugen die Titel-Disziplin bereits; FOR-37 macht sie zur Konvention. Beißt beim dritten Mal hoffentlich niemanden mehr.

**W6-F3 — `cross-wave` ohne `--repo-root` verwirft Glob-Overlaps stumm (→ FOR-38, gefiled).**
Dieselbe Kandidatenmenge: **17 Zellen ohne, 40 mit** `--repo-root`. Ohne Working-Tree expandieren Globs nicht — und statt laut zu werden, produziert selbst das **string-identische** Glob-Paar (`wave-shared/**` ↔ `wave-shared/**`) keine Zelle. Der Planner liest eine saubere Map und schließt „parallel-safe": unter-gemeldete Konflikte, die gefährliche Richtung. Gefunden nur, weil der Koordinator wusste, welche Zelle fehlen musste. Die Absence-as-fact-Klasse (W2-F1c/W3-F1/W4-F2), diesmal in der Parallelitäts-Entscheidung selbst.

### 🟢 KLEIN / Wiederholungen

**W6-F4 — `worktree-cleanup` nicht atomar, vierte Reproduktion in Folge (→ FOR-34, vor der Wave gefiled).** `errors: 3, removed: 0`, `git worktree list` sauber, vier Orphan-Dirs auf Platte; Entfernung brauchte Sandbox-aus. **Neue Facette:** der stale Iteration-1-Worktree hielt den FOR-21-Branch und **blockierte den Re-Dispatch aktiv** — der Iteration-2-Worker musste ihn selbst per `git worktree remove --force` deregistrieren (und legte damit das nächste Orphan-Dir an). Er tat das autonom, prüfte vorher auf ungesicherte Arbeit und legte es im `judgmentCalls` offen — genau das erhoffte Verhalten, aber es bestätigt: FOR-34s Atomarität ist kein Kosmetik-Ticket.

**W6-F5 — Stale-LSP-Diagnostics, zweimal (W4-F8-Wiederholung).** Mid-Run mischte die IDE Branch-Stände („no exported member `runWriteReport`" gegen `main` geprüft), nach dem Orphan-`rm` flutete sie „Cannot find module"-Fehler aus den gelöschten Checkouts. Beleg bleibt `tsc` auf Branch/`main` (beide 0), nie das IDE-Panel.

**W6-F6 — `merge-order`s `.scratch`-Warning + `fileCount: 0` (W4-F9-Wiederholung).** Weiterhin die einzige Zeile im Close-Output, die wie ein Fehler *aussieht*, ohne einer zu sein — für Onboarding genau falsch herum. Bleibt Teil der getrackten Ur-Entkopplung.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W6-F1** — Shell-Kleber log Erfolg bei Totalausfall; `re.sub`-Escape im Driver-Compose | 🟡 | Betriebsnotiz (kein Engine-Defekt; Runbook-Kandidat fürs Onboarding-Grill) |
| **W6-F2** — PR-Titel-Mention schloss FOR-6/33 vor ihrem Dispatch | 🟡 | **FOR-37** gefiled (wave-shared-Konvention) |
| **W6-F3** — `cross-wave` ohne repo-root: 17 vs. 40 Zellen, stumm | 🟡 | **FOR-38** gefiled (fail loud / string-Vergleich) |
| **W6-F4** — cleanup nicht atomar (4. Mal); stale Worktree blockierte Re-Dispatch | 🟢 | **FOR-34** gefiled (Atomarität + no-args-Usage) |
| **W6-F5** — Stale-LSP-Diagnostics ×2 | 🟢 | Editor-Excludes (w3-PR); Betriebsnotiz |
| **W6-F6** — `.scratch`-Warning + `fileCount: 0` | 🟢 | Teil der getrackten Ur-Entkopplung (W4-F9) |
| Gleiche Session, vor der Wave gefiled | — | **FOR-35** (Schema-Boundary `anyOf`), **FOR-36** (wave-close-Sandbox-Realität — W5-F3, in diesem Close erneut bestätigt) |

## 4. Lauf-Metriken (grob)

- **Rows:** 3 (paralleler Fan-out). **Verdicts:** 2× `approve` (iter 1) + 1× `changes-requested` → **cap=1-Re-Dispatch → `approve` (iter 2)**. **STOPs:** 1 (FOR-33 G3, protokollgemäß). **Agents:** 8 über 2 Workflows (6 + 2), **0 Fehler**; ~27 min + ~6 min; ~1,07 Mio. Subagent-Tokens, 345 Tool-Calls.
- **Modelle:** FOR-6/FOR-33 opus (`cross-feature`/`public-API`), FOR-21 sonnet (beide Iterationen).
- **PRs:** #30 (FOR-21) → #32 (FOR-6) → #31 (FOR-33, rebased) — advisory Order eingehalten; alle squash; alle drei Remote-Branches gelöscht **und verifiziert** (0 überlebende `wave/*`-Heads). `main`: `d948958 → 85734c0`.
- **Tests:** FOR-6 1390 · FOR-33 1412 · FOR-21 1379 · **rebasierte Union vor dem Merge 1423** · gemergter `main` **1423** · `tsc --noEmit` überall 0. Anchor-Baseline 1379.
- **ACs:** 13 über 3 Rows — 12 `met` in Iteration 1, FOR-21s AC1 `partial → met` in Iteration 2. **Sidecars:** 8 (inkl. `FOR-21-2.md` — Max-Iter). **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen:** 0 (vierter Lauf in Folge). **Koordinator-Vorfälle außerhalb des Kerns:** 2 (W6-F1, W6-F2).
- **Backlog danach:** 11 offen (FOR-16/17/20/27/28/30/34/35/36/37/38), **alle unblockiert**.

## 5. Meta-Reflexion

Zwei Fäden. **Erstens: die Fehlerklasse des Tages war Koordinator-Kleber, nicht Engine.** Lügende echos, ein Replacement-Escape, ein PR-Titel — alle drei Vorfälle lagen *außerhalb* der typisierten Schienen, und alles *innerhalb* (Schema-Boundary, Routing-Verben, WAL, Conformance) war im besten Sinne langweilig. Gefangen wurde jeder Kleber-Fehler von einer flotilla-Disziplin: Zustand zurücklesen statt Summary glauben (F1), Fail-loud-Parser (das `re.sub`-Artefakt), Read-back nach dem Merge (F2). Die Konsequenz ist nicht „vorsichtigere Koordinatoren", sondern die laufende Bewegung, den Kleber in die Schienen zu ziehen — FOR-27/28 tun genau das fürs Landing und die PR-Erstellung, FOR-37 für die PR-Benennung.

**Zweitens: der Selbst-Konsum wird zirkulär — und das ist jetzt ein Feature.** FOR-21s Fix regierte das Archiv seiner eigenen Wave; der Amend-Verb korrigierte als ersten Produktiv-Akt den Titel seines eigenen Issues; und die Wave dispatchte den Scribe-Mechanismus mit dem **letzten gebündelten Sidecar-Write der Geschichte** — der Coordinator-Schritt, der P-1 verursachte, hat sich in diesem Lauf selbst abgeschafft. Anders als in w4 (wo die Selbstreparatur-Falle nur durch eine gelesene Retro-Notiz vermieden wurde) war die richtige Reihenfolge diesmal Routine, nicht Glück.

**Vorwärts-Zeiger, wichtigster Punkt für die nächste Wave:** Die **Scribe-Stufen sind gebaut, getestet — und noch nie gelaufen.** Der nächste `wave-start` ist ihr Live-Gate. Nach der W3-F1-Lektion (Fake, Fixture und Produktivcode können dieselbe falsche Vermutung teilen; 1250 grüne Tests konnten sie nicht widerlegen) gilt: der ersten Scribe-Wave bewusst zusehen — existieren die Sidecars wirklich sekundengenau beim Agent-Return, bevor der Koordinator irgendetwas routet?
