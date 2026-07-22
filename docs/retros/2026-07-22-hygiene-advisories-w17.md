# flotilla — Retrospektive: Wave 17 „2026-07-22-hygiene-advisories" (achtzehnter Live-Lauf)

Wave: `2026-07-22-hygiene-advisories` · Rows: **FOR-66, FOR-67, FOR-69** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `4af9ca6` → `main` nach dem Close: `3015826` (inkl. Followup-PR).

Besonderheit dieses Laufs: **der erste Partial-Arm mit echtem Tail** — die Conflict-Map-Zelle FOR-66×FOR-69 (`close-mechanics.md`) beschränkte `--auto` korrekt auf die eine order-freie Row, der Tail landete seriell nach Advisory-Order mit dem reconciled-Verify dazwischen. Dazu **doppelte Self-Validation im eigenen Close** (der Tail-Merge lief mit FOR-66s Minuten zuvor gelandetem `--delete-branch`; FOR-67s `--orphans`-Summary lief im selben Close) und die erste sauber durchgezogene **Partial-AC-Kette**. Mit dem Landing war der Backlog leer: alle sieben Consumer-Findings FOR-63…69 in zwei Waves an einem Tag.

## 0. Ergebnis in einem Satz

Wave 17 lief `wave-plan → Scope-Extension FOR-69 (amend+annotate vorab: +2 Files, +1 AC fürs conflict-map-`--id`-Doc-Wiring) → wave-create (Zelle 66×69 in der Spine-Conflict-Map) → wave-start (3er-Fan-out, alle opus) → **3× `approve` in Iteration 1** (FOR-69 mit AC5 `partial` — korrekt, siehe unten) → 2 G3-STOPs (FOR-66, FOR-67) human-approved → `--auto`-Partial-Arm: **nur FOR-67 gearmt → merged**; Tail seriell: FOR-66 gemergt → Pull → **reconciled-Verify 1710/1710 + tsc 0 VOR dem Tail** (FOR-69s eigener frisch dokumentierter Step, live exerziert bevor FOR-69 selbst mergte) → FOR-69 mit `--delete-branch` gemergt (`branchDeletion: deleted:true`) → Done-Reconcile 3× `merged`, `--acked` maschinell (FOR-69: 4 von 5 — AC5 ehrlich ungetickt) → Followup-PR für die Partial-Ursache → Archiv plain-mv, **Backlog leer**, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Partial-Arm hielt die Disziplin, obwohl die Prediction Entwarnung gab.** Beide Reviewer (und der FOR-66-Worker selbst) hatten die 66×69-Überlappung per `git merge-tree` als **clean** vorhergesagt — die Edits greifen ineinander (FOR-69s neuer Block sitzt hinter der Zeile, die FOR-66s Rewrite als Tail bewahrt). Trotzdem blieb die Zelle formal der un-armte Tail: `--auto` armte nur FOR-67, der Rest lief seriell nach Advisory-Order. Prediction bestätigt, Protokoll nicht aufgeweicht — genau die richtige Reihenfolge von Vertrauen und Beweis.
- **Der reconciled-Verify-Step lief, bevor die Doku, die ihn vorschreibt, gemergt war.** Zwischen Lane-Kopf (FOR-66) und Tail (FOR-69) wurde das volle Verify-Profil auf dem reconciled `main` gefahren (1710/1710 + tsc 0) — der KW-F4-Step aus dem Consumer-Retro, angewandt auf die Wave, die ihn als wave-close-Pflicht dokumentiert.
- **Doppelte Self-Validation im eigenen Close.** FOR-69s Branch wurde vom frisch gelandeten `--delete-branch` gelöscht (FOR-66, Minuten nach Landing; ebenso der Followup-Branch); FOR-67s `--orphans`-Verb lief im selben Close mit seiner neuen strukturellen Summary (`deregisteredNotDeleted`, `branchesDeleted`, `orphans` — sichtbar statt stumm). Beide KW-F6-Findings haben sich in der Wave bewiesen, die sie gebaut hat.
- **Die Partial-AC-Kette funktionierte Ende-zu-Ende.** FOR-69s AC5 war in ihrer öffnenden Klausel weiter formuliert als die declared Files reichten: eine stale Zeile in `wave-create/SKILL.md` lag außerhalb. Der Worker machte keinen Scope-Creep, sondern legte per Convention 9 offen; der Reviewer wertete `partial` mit präziser Evidenz („needs human eyes"); `verdict-acked` tickte ehrlich 4 von 5; der Coordinator entschied gegen einen iter-2-Re-Dispatch (unverhältnismäßig für eine Doc-Zeile) und für einen 1-Zeilen-Followup-PR direkt nach dem Close. Kein Cap verbrannt, kein AC gelogen, Ursache geschlossen.
- **Die Vorab-Scope-Extension (Convention-6-Zweischritt) ersparte eine Mid-Wave-Extension.** FOR-69 wurde *vor* wave-create per `amend` (Prose) + `annotate` (Files+ACs) um das in W16 offengelegte Doc-Wiring erweitert — dor re-PASS inklusive `ac-files-coverage`. Der W13-Präzedenzfall (Extension mitten im Lauf) blieb damit die Ausnahme.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W17-F1 — Workflow-Script-Parse-Fehler beim ersten Launch: Escaping in Brief-Strings.** Der erste Driver-Launch scheiterte am Parser (`\\'` innerhalb eines Single-Quote-JS-Strings in den reviewerHints) — Kosten: null (kein Agent gestartet, kein State berührt), aber die Klasse ist real: Brief-Texte mit Apostrophen gehören in Double-Quote-Strings oder umformuliert. Kandidat: ein Satz Compose-Hinweis in `workflow-driver.md` (Authoring constraints).

**W17-F2 — ACs dürfen nicht weiter reichen als die declared Files.** Die Ursache des FOR-69-Partials war kein Arbeitsfehler, sondern ein Slicing-Fehler: AC5s öffnende Klausel („kein Referenz-Doc mehr…") war unqualifiziert, während die Files-Liste eine Datei ausließ — der Worker konnte strukturell nie 5/5 erreichen. Lehre für `to-issues`: AC-Formulierungen an die Files-Grenze binden (oder die Files weiten, Bias-toward-wider gilt auch hier). Kandidat: eine Zeile im to-issues-Skill (Common Mistakes).

### 🟢 KLEIN

**W17-F3 — ENOTEMPTY ein letztes Mal mit der alten Engine (×3, erwartet).** Der Prä-Merge-Cleanup lief naturgemäß mit dem Anchor-Stand (Self-Repair-Klasse: FOR-67 fixt das Verb, das ihn räumen sollte) — deregistered-but-not-deleted ×3, manueller sandbox-off-Rest. Ab der nächsten Wave ist FOR-67s strukturelle Summary der Live-Gate: der erste Close, dessen Cleanup-JSON die Klasse benennt statt verschluckt.

**W17-F4 — Wiederholungen.** `failed to store: 100001` (Proxy-Warnung, kosmetisch) · IDE-TS-Server-Diagnostics auf Worktree-Pfaden nach Cleanup/Reset (kosmetisch; reale Gates stets grün) · zwei G3-STOPs in einer Wave = zwei Human-Klicks — bewusst in Kauf genommen (Plan-Advisory), lief reibungslos.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W17-F1** — Brief-String-Escaping im Workflow-Driver | 🟡 | **Kandidat** (Compose-Hinweis workflow-driver.md) |
| **W17-F2** — AC-Reichweite an Files-Grenze binden | 🟡 | **Kandidat** (to-issues Common Mistakes) |
| **W17-F3** — ENOTEMPTY-Rest mit alter Engine | 🟢 | Erwartet (Self-Repair); FOR-67 ist der Live-Gate der nächsten Wave |
| **W17-F4** — Wiederholungen (Proxy-Warnung, Stale-LSP, 2× G3) | 🟢 | Beobachten; kosmetisch |
