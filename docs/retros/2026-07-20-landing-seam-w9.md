# flotilla — Retrospektive: Wave 9 „2026-07-20-landing-seam" (zehnter Live-Lauf)

Wave: `2026-07-20-landing-seam` · Rows: **FOR-27, FOR-28, FOR-44** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `0be605a` → `main` nach dem Close: `b57d3da`.

Besonderheit dieses Laufs: **die erste Wave, die vollständig gegen das öffentliche Repo lief** — geplant, dispatcht, reviewt, gelandet und geschlossen am Tag des Cuts, in einer Session. Ihre drei Rows landeten die beiden ADR-0023-Build-Slices (`wave-close --auto` Partial-Arm als Skill-Text; `host-pr create` + `gh` verlässt den Creation-Pfad) plus die Secret-Safe-Brief-Regel aus dem W8-F1-Fund. Der Close war dabei sein eigenes Live-Gate: gelandet wurde bereits über die `host-pr`-Verbs, die die Vorwellen gebaut hatten — und der Done-Reconcile lief nach dem Pull bereits über die Evidence-Hierarchie-Semantik, die diese Wave selbst formuliert hat.

## 0. Ergebnis in einem Satz

Wave 9 lief den vollen Zyklus `wave-plan → wave-create → wave-start → wave-close` in einer Session — 3er-Fan-out → **3× `approve` in Runde 1, 0 Re-Dispatches, 0 STOPs, 12/12 Agents, 0 Fehler, dritter fehlerfreier Scribe-Lauf** → 3 squash-PRs #3/#4/#2 in Advisory-Order inkl. der **exakt wie von beiden Reviewern vorhergesagten Convention-Nummern-Kollision** (Landing-Seam behielt 7, Secret-Safe wurde beim Landen zu 8) → `main 0be605a → b57d3da`, Gate **1457 Tests (+14) / tsc 0** → alle 3 `done` via Reconcile — und der Done-Reconcile war zugleich **der bestandene Linear-Integration-Proof am öffentlichen Repo**: alle drei `read-closing`-Probes meldeten `merged` über das Tracker-Attachment (Tier 1), das Watch-Item aus dem Cut ist erledigt.

## 1. Was richtig gut funktioniert hat

- **Grill-Ökonomie: gesettelte ADRs wurden exekutiert, nicht neu verhandelt.** Beide Heavy-Slices waren durch den Auto-Merge-Grill vom 2026-07-16 (ADR-0023) bereits vollständig geformt; das Planning bestätigte das statt neu zu grillen, und die Worker exekutierten die Slices 1:1. Die zwei echten Judgment-Calls — der Name `--pre-authorized` (das ADR ließ ihn offen) und die Erweiterung der Evidence-Hierarchie auf `closed-unknown` — wurden offengelegt, vom Reviewer einzeln verifiziert und als „needs human eyes" markiert statt still entschieden.
- **Die vorhergesagte Kollision wurde ökonomisch gelandet.** Beide Reviewer sagten per `git merge-tree` exakt denselben Konflikt voraus: zwei Docs-Rows appenden beide eine „Convention 7" an dieselbe Liste. Die Advisory-Order (fewer-files-first) passte zur Renumber-Ökonomie — FOR-27 (4 Referenzen) landete zuerst und behielt die 7, FOR-44 (2 Referenzen) wurde beim Branch-Update auf 8 umnummeriert, Gate grün, squash. Der eine echte Merge-Konflikt der Wave kostete Minuten, nicht Runden.
- **`host-pr merge`/`status` hatten ihr Live-Debüt als Landungs-Transport** — drei Squash-Merges + Read-back-Status über den Engine-Seam, kein `gh` auf irgendeinem Pfad. Die Read-back-Disziplin (Status nach Merge, nie die erste Response) lief sauber durch.
- **Die Secret-Safe-Regel schützte die Worker, die sie formalisierten.** Der Coordinator hatte die W8-F1-Lektion als Brief-Clause 5 in alle drei Worker-Briefs vorweggenommen — kein Token-Echo in diesem Lauf, und die Row, die die Regel dauerhaft in `wave-shared`/Driver einbaute, arbeitete bereits unter ihr.
- **Mention-Disziplin hielt erneut, jetzt reviewer-verifiziert per API.** Alle drei PR-Titel/-Bodies trugen exakt eine bare Tracker-Id — die eigene Close-Phrase; beide Opus-Reviewer prüften das mechanisch (Regex über Titel+Body via GitHub-API) statt per Augenschein.
- **merge → pull → reconcile griff wie dokumentiert.** Alle drei Rows berührten `.claude/skills/**`, also lief der Pull sandbox-off und wurde per `git rev-parse HEAD` gegen den Merge-Tip verifiziert — kein Half-Pull; der Reconcile probte anschließend mit der Engine-Semantik, die die Wave selbst gerade gelandet hatte.
- **Alle gehärteten Vorgänger hielten:** Anchor-Assertion, anyOf-freies Driver-Schema, Dispatch-Log vor Worker-Existenz, Scribe-Sidecars at-agent-return (6/6), Convention 4 (3× korrekte `linear`-Close-Phrase), separater Branch-Deletion-Check.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W9-F1 — `worktree-cleanup` scheiterte auf macOS an allen drei Worktrees, mit Encoding-Verdacht im Fehlerpfad.**
Der Engine-Cleanup meldete 3× `ENOTEMPTY` (`removed: 0`), die Registrierungen blieben intakt (`prunable`), die Verzeichnisse lagen teilgeleert auf Platte — Verdacht: Finder-`.DS_Store`, mitten im Traversal erzeugt (eines lag im Worktree-Root). Auffällig: die Fehlermeldung renderte den en-dash-Repo-Pfad als Mojibake („Projects â Clients") — ein Encoding-Verdacht im rm-Pfad der Engine, den es auf Nicht-ASCII-Pfaden zu prüfen gilt. Der manuelle `rm -rf` brauchte zusätzlich Sandbox-off (worktree-interne `.claude/agents`/`.vscode`-Pfade sind write-denied). Ticket-Kandidat: macOS-Härtung des Cleanups (`.DS_Store`-Toleranz/Retry + Pfad-Encoding im Fehlertext), plus die Betriebsnotiz, dass der Nachräum-Schritt Sandbox-off einplanen muss.

### 🟢 KLEIN / Wiederholungen

**W9-F2 — Gleiche-Nummer-Kollision ist eine planbare Klasse.** Die Conflict-Map sah die Datei-Überlappung, aber dass zwei Rows derselben Wave beide „die nächste freie Convention-Nummer" beanspruchen, ist eine *semantische* Kollision, die schon beim Slicing sichtbar wäre. Optionen fürs Planning: `to-issues` vergibt Sektions-Nummern beim Slicen, oder das Landing-Renumber wird als Norm dokumentiert. Kleiner Ticket-Kandidat.

**W9-F3 — Out-of-Scope-Advisories aus dem host-pr-Slice, korrekt liegengelassen:** die `LandingNotImplementedError`-Message nennt `create` noch nicht; drei narrative „gh pr create"-Kommentare im Engine-Code beschreiben den alten Zustand; die Mention-Disziplin hat keine eigene nummerierte Brief-Policy-Clause (teilgedeckt: der neue Terminator-Text trägt sie inline). Alles Ticket-Kandidaten klein — die Worker blieben diszipliniert in ihren deklarierten Globs.

**W9-F4 — `--acked` wurde von Hand aus dem Verdict abgelesen.** Die Met-Indexe für `issue-store close` stammten aus manueller Verdict-Lektüre — exakt die Lücke, die der geplante Engine-Helfer (Met-Index-Ableitung aus dem typisierten Verdict) schließen soll; dieser Lauf ist sein Motivations-Beispiel.

**W9-F5 — Wiederholungen:** `merge-order` druckt weiterhin die Ur-`.scratch/`-Legacy-Warning; Stale-LSP-Flut nach Worktree-Removal (5. Mal).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W9-F1** — Cleanup ENOTEMPTY ×3 + Encoding-Verdacht + Sandbox-off-Nachräumen | 🟡 | Ticket-Kandidat (macOS-Härtung `worktree-cleanup`) |
| **W9-F2** — Gleiche-Nummer-Kollision zweier Docs-Rows | 🟢 | Ticket-Kandidat klein (Planning-Hygiene) |
| **W9-F3** — Fehlermeldung/Kommentare/Policy-Clause-Nachzügler | 🟢 | Ticket-Kandidaten klein (gesammelt filen) |
| **W9-F4** — `--acked` von Hand | 🟢 | Betriebsnotiz — Motivations-Beispiel für den geplanten Met-Index-Helfer |
| **W9-F5** — Legacy-Warning · Stale-LSP ×5 | 🟢 | Bekannt/getrackt |

## 4. Lauf-Metriken (grob)

- **Rows:** 3 (paralleler Fan-out; Conflict-Map: Volldreieck über `wave-shared/SKILL.md`, FOR-28↔FOR-44 zusätzlich `workflow-driver.md`). **Verdicts: 3× `approve` in Runde 1** — 0 `changes-requested`, cap=1 nie berührt, 0 STOPs (keine public-API-Row). **Agents:** 12/12 im einen Workflow (3 Worker + 3 Report-Scribes + 3 Reviewer + 3 Verdict-Scribes), **0 Fehler**; ~31 min; ~0,91 Mio. Subagent-Tokens, 306 Tool-Calls.
- **Modelle:** 2× opus-Worker (cross-feature) + 1× sonnet-Worker (mechanical), Scribes haiku.
- **PRs:** #3 → #4 → #2 (Advisory-Order, fewer-files-first), alle squash über `host-pr merge`; FOR-44 mit Branch-Update + Convention-Renumber vor dem Squash. Alle drei Wave-Branches gelöscht **und verifiziert** (REST-Merge löscht nie selbst — der separate Check fing alle drei). `main`: `0be605a → b57d3da`.
- **Tests:** 1443 → **1457** (+14, `host-pr create`-Specs) · `tsc` 0. **ACs: 12 über 3 Rows — alle 12 `met` in Runde 1.** **Sidecars:** 6, at-agent-return. **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen:** 0 (sechster Lauf in Folge).
- **Done-Reconcile:** 3× `merged` via Tracker-Attachment (Tier 1) — **Linear-Integration-Proof am öffentlichen Repo bestanden**, `close` mit manuell abgelesenen `--acked`-Indexen. Archiv: plain-mv (untracked `.flotilla/`).
- **Backlog danach:** 5 offen (FOR-16/17/20/30/35, alle unblockiert) + die W9-Ticket-Kandidaten.

## 5. Meta-Reflexion

Diese Wave hat die Landungsautomatik gebaut und wurde vom halben Ergebnis bereits gelandet: `host-pr merge`/`status` trugen den Close als Transport, die frisch gemergte Evidence-Hierarchie trug den Reconcile — nur `--auto` selbst wartet auf seinen ersten Ernstfall in der nächsten Wave. Der Selbstbezug wird dabei zur Routine statt zur Falle: die Regel aus dem letzten Retro schützte als Brief-Clause schon die Worker, die sie formal einbauten, und der vorhergesagte Konflikt war beim Landen ein Playbook-Schritt, kein Zwischenfall.

Die eigentliche Erkenntnis ist die **Vorhersage-Qualität der Review-Ebene**: beide Reviewer lieferten nicht nur Verdicts, sondern präzise Merge-Tree-Prognosen inklusive der semantischen Kollision, die die Conflict-Map strukturell nicht sehen kann — und genau diese Prognose machte das Landen planbar. Gleichzeitig zeigt W9-F2 die Kehrseite: was der Reviewer am Ende sieht, hätte das Slicing am Anfang vermeiden können. Planungs-Hygiene für append-artige Docs-Änderungen ist billiger als das eleganteste Landing-Renumber.

**Vorwärts-Zeiger:** Die nächste Wave kann den vollen ADR-0023-Pfad ernsthaft fahren — `host-pr create` im Worker-Terminator und `wave-close --auto` mit Partial-Arm-Confirm. Davor: die W9-Ticket-Kandidaten filen und den konflikt-dichten Rest-Backlog (FOR-16/17/20/30/35) neu schneiden. Watch-Items: erster `--auto`-Lauf (Arm-Verhalten ohne Required-Checks — „confirming means immediate merge"), und ob der Cleanup-Fix W9-F1 die macOS-Klasse wirklich schließt.
