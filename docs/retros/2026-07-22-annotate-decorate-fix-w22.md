# flotilla — Retrospektive: Wave 22 „2026-07-22-annotate-decorate-fix" (dreiundzwanzigster Live-Lauf)

Wave: `2026-07-22-annotate-decorate-fix` · Rows: **FOR-77** (Einzel-Row) · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `7d8f534` → `main` nach dem Close: `e07dd19`.

Besonderheit dieses Laufs: **die siebte komplette Wave desselben Tages** — und die erste, deren Slice nicht aus einer Retro, sondern aus einer **Consumer-Memory** stammt (Gap 5 der linear-store-gaps-Notizen des Consumers): vom Lesen der Notiz bis zum gelandeten Fix vergingen unter zwei Stunden, inklusive Code-Verifikation des Bugs am Upstream-Stand vor dem Filen.

## 0. Ergebnis in einem Satz

Wave 22 lief die volle Strecke `wave-plan → wave-create → wave-start → wave-close --auto` — Plan-Draw bestätigte die Ein-Kandidaten-Menge → 1er-Fan-out (sonnet) → **`approve` in Iteration 1, 3/3 ACs met, 0 Re-Dispatches** → kein G3 → Arm-Confirm → `host-pr arm` outcome **`merged`** → **dritter Self-Repair-Fall des Tages** (der Fix betrifft den Linear-Store, durch den der Done-Reconcile selbst läuft — merge→pull→reconcile strikt eingehalten) → Gate **1750 Tests (+3) / tsc 0** → Done-Reconcile `merged` durch die frisch reparierte Engine, `--acked` voll → Archiv plain-mv, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Consumer-Memory als Backlog-Quelle funktioniert genauso gut wie eine Retro.** Gap 5 beschrieb den Defekt präzise genug, dass die Coordinator-seitige Code-Verifikation ihn in Minuten bestätigte (Prä-Patch-Description im Argument-Ausdruck, außerhalb der versprochenen Best-Effort-Grenze) — und der Consumer-Workaround („exit 1 als expected behandeln") lieferte das Abnahmekriterium gleich mit: er muss obsolet werden.
- **Der Worker dachte über die AC hinaus, im Guten:** ein dritter, nicht geforderter Boundary-Spec pinnt den Fall „nur `files` gepatcht, Body danach immer noch unparsebar → skipped mirror" — genau die Restlücke zwischen den beiden geforderten Fällen. Bestands-Mirror-Specs blieben byte-unverändert grün (85/85 im Datei-Lauf, diff-verifiziert additiv).
- **Die ad-hoc gehärtete SECRET-SAFE-Klausel (explizites `printenv`-Verbot nach dem W21-Vorfall) lief erstmals — clean.** Erste Evidenz, dass das Klausel-Verbot die Improvisations-Lücke schließt; die Beobachtung aus dem W21-Retro läuft weiter.
- **Self-Repair-Routine, dritter Fall in einem Tag:** die mechanische `ENGINE_SURFACE`-Detection meldete den Hit, der Reconcile lief erst nach dem HEAD-verifizierten Pull — und probte `merged` durch exakt den Code-Pfad, den die Row eine Viertelstunde zuvor repariert hatte.
- **Auto-Scrub dritter Live-Lauf:** wieder nur die eigene Id scannbar im PR-Body. Die Mention-Falle ist als Klasse strukturell erledigt; offen bleibt allein das Rendering-Live-Gate (unten).

## 2. Funde (nach Schwere)

### 🟢 KLEIN

**W22-F1 — `erroredStillListed` ist der Normalfall geworden, nicht die Ausnahme.** Viertes strukturelles Vorkommen in drei aufeinanderfolgenden Closes (jede Wave dieses Abends traf es auf mindestens einem Worktree): der Editor-/Indexer-Race auf `.claude/worktrees/` plus Harness-Write-Deny macht `prune + rm (sandbox-off)` faktisch zum Standard-Nachschritt jedes Cleanups. Die Klassifikation und das Playbook tragen zuverlässig — aber wenn ein manueller Schritt in 100 % der Läufe anfällt, ist er ein Automatisierungs-Kandidat. Möglicher Zuschnitt (nächste Planung, nicht dringend): ein opt-in Force-Pfad im Cleanup-Verb für die exakt klassifizierte Zwischenform, oder eine Coordinator-Checklisten-Zeile, die den Doppelschritt kodifiziert. Gegenposition: der sandbox-off-`rm` ist bewusst ein menschlicher Schritt (Write-Deny existiert aus gutem Grund) — dann ist der Status quo korrekt und nur die Häufigkeit neu.

**W22-F2 — Offene Live-Gates unverändert.** U+2060 vs. echtes GitHub-Markdown→HTML-Rendering (wartet auf den ersten Close mit echter fremder Id in Evidence) · Linear-Integrations-Nicht-Reaktion auf neutralisierte Tokens in den gemergten Bodies (gelegentlich nachschauen).

**W22-F3 — Wiederholungen.** Stale-LSP auf Worktree-Pfaden · `failed to store: 100001` · alles kosmetisch, Muster stabil.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W22-F1** — erroredStillListed als Normalfall: Force-Pfad vs. bewusster Mensch-Schritt | 🟢 | **Diskussions-Kandidat** für die nächste Planung; kein Ticket vorab |
| **W22-F2** — offene Live-Gates (Rendering, Integrations-Nicht-Reaktion) | 🟢 | Beobachten |
| **W22-F3** — Wiederholungen | 🟢 | Beobachten; kosmetisch |

## 4. Tagesschluss

Mit diesem Close endet der 22. Juli 2026 bei **sieben kompletten Waves (W16–W22), fünfzehn same-day gefiled-und-gelandeten Issues, einundzwanzig PRs und 1655→1750 Tests** — Retro→Backlog→Landing-Zyklen im Stundentakt, drei Self-Repair-Fälle, zwei am eigenen Close gefeuerte Live-Gates und ein Consumer↔Upstream-Loop, der sich am selben Abend viermal schloss. Die Resync-Empfehlung an den Consumer lautet `152cc44 → e07dd19`: ein Sprung, vier Fixes, die seine eigenen Notizen sich gewünscht haben.
