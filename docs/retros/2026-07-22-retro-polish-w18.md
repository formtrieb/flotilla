# flotilla — Retrospektive: Wave 18 „2026-07-22-retro-polish" (neunzehnter Live-Lauf)

Wave: `2026-07-22-retro-polish` · Rows: **FOR-70, FOR-71, FOR-72** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `105cfdd` → `main` nach dem Close: `1eccbb0` (inkl. Followup-PR).

Besonderheit dieses Laufs: **die dritte komplette Wave desselben Tages, vollständig aus den Retros der ersten beiden gespeist** — der kürzeste Fund-zu-Fix-Umlauf bisher (W17-F1/F2 morgens im Retro benannt, mittags gefiled, nachmittags gelandet). Dazu der dritte Self-Validation-Close in Folge: der Standalone-Branch-Sweep räumte Minuten nach seinem eigenen Landing die sechs Locals seiner eigenen Wave — und schloss damit same-day die 14-Branch-Lücke, die der Operator am Vormittag von Hand fegen musste.

## 0. Ergebnis in einem Satz

Wave 18 lief `wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — 3er-Fan-out (FOR-72 auf opus) → **3× `approve` in Iteration 1, alle ACs met, 0 Re-Dispatches** → G3-STOP FOR-72 human-approved (inkl. bewusst verengter Harness-Signatur, unten) → alle drei order-free gearmt → sofort `merged` → merge→pull→reconcile (Self-Repair-Fall: der Sweep ändert das Cleanup-Verb selbst) → Gate **1730 Tests (+20) / tsc 0** → **Live-Beweis: `--orphans` räumte 6 verwaiste Locals strukturell** (`branchesDeleted`, danach nur `main`) → Done-Reconcile 3× `merged`, `--acked` voll → Followup-PR fürs Doc-Wiring des Sweeps → Archiv plain-mv, **Backlog leer**, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Der Retro→Backlog→Landing-Zyklus schloss sich innerhalb von Stunden.** Beide Doc-Slices entstammen wörtlich den Funde-Tabellen des Vormittags; der Sweep dem dreifach reproduzierten Hygiene-Fund plus der frischen 14-Branch-Evidenz. Nichts davon wartete eine Woche auf ein Grooming — die Funde-Tabelle IST das Grooming.
- **Die Escaping-Regel bewährte sich, bevor ihre Doku landete.** Der W18-Driver wurde bereits nach der W17-F1-Lehre komponiert (Apostroph-sanierte Brief-Strings) und parste im ersten Anlauf — Authoring-Constraint 5 landete quasi nachlaufend zu seiner eigenen ersten Anwendung.
- **FOR-72s Verengungs-Judgment war die richtige Sorte Vorsicht.** Die AC sagte `worktree-*`, der Worker implementierte nur `worktree-wf_*` — weil allein die Workflow-Driver-Form den Tip-on-Anchor garantiert, der einen bedingungslosen Force-Delete sicher macht; ein beliebiger `worktree-*`-Branch könnte nutzererstellt sein. Per Spec-Test dokumentiert, als needs-human-eyes markiert, am G3-Gate bestätigt. Der Live-Beweis folgte im eigenen Close: 6 Locals strukturell geräumt, der aktuelle Branch strukturell unantastbar.
- **`conflict-map --id` hatte seinen ersten Produktionseinsatz** im Filing-Self-Check des Trios — der tsx-One-off ist Geschichte. Beiläufig wurde auch der Mixing-Guard live validiert (ein fehlgeschlagener Aufruf mit gemischten Formen erzeugte exakt den vorgesehenen Usage-Error).
- **Vierter G3-Zyklus des Tages, Routine ohne Abnutzung:** typisierte Verdicts, deterministisches Routing, ein Klick pro public-API-Row, `verdict-acked` maschinell.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W18-F1 — Die ENOTEMPTY-Klasse hat eine dritte Erscheinungsform, die die neue Klassifikation knapp verfehlt.** Der Prä-Merge-Cleanup traf erneut ENOTEMPTY ×3 — aber die Worktrees waren diesmal weder sauber deregistriert (der `deregisteredNotDeleted`-Fall) noch entfernt: `git worktree list` führte sie weiter als **`prunable`**. Ergebnis: die Hits landen im generischen `errors`-Feld, das neue Klassifikationsfeld bleibt leer. Kein Defekt — die Summary ist vollständig sichtbar (der eigentliche Gate bestand) und `errors` ist vertretbar — aber die Zwischenform „prunable-gelistet + Dir auf Disk" verdient entweder eine eigene Benennung in der Klassifikation oder eine dokumentierte Einordnung als `errors`-Unterfall. Ticket-Kandidat (klein schneiden).

**W18-F2 — Auf dem armed-Pfad bleibt die Remote-Branch-Hygiene Handarbeit.** `--auto` armt; ein gearmter Direct-Merge löscht konstruktionsgemäß keinen Remote-Branch (das Merge-Flag ist bewusst merge-only; arm übergibt an den Host). Drei Remote-Branches brauchten erneut den manuellen Sweep. Zwei saubere Auswege, einer davon codefrei: das Repo-Setting „automatically delete head branches" aktivieren (Operator-Aktion, deckt genau den armed-Pfad — die dokumentierte arm-Story), oder eine Post-Merge-Delete-Probe im arm-Verb. Empfehlung: erst das Setting, Ticket nur falls es nicht greift.

### 🟢 KLEIN

**W18-F3 — zsh-No-Word-Split, zweites Vorkommen dieser Session.** Ein Filing-Self-Check-Loop über eine `$IDS`-Variable lief als Ein-Token-Schleife (zsh splittet unquoted Variablen nicht) — Kosten: ein Re-Run mit explizit gelisteten Ids. Coordinator-Praxis, keine Engine-Änderung: Ids ausschreiben oder Arrays nutzen.

**W18-F4 — Wiederholungen.** Half-Applied-Pull beim Followup exakt nach dem dokumentierten 4a-Playbook aufgelöst (HEAD-frozen erkannt via `rev-parse`, sandbox-off Reset — das Playbook trägt) · `failed to store: 100001` (Proxy-Warnung, kosmetisch) · Stale-IDE-Diagnostics auf Worktree-Pfaden (kosmetisch).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W18-F1** — ENOTEMPTY-Zwischenform „prunable-gelistet" in der Klassifikation benennen | 🟡 | **Kandidat** für to-issues (klein) |
| **W18-F2** — armed-Pfad-Branch-Hygiene: Repo-Setting „auto-delete head branches" aktivieren | 🟡 | **Operator-Aktion** zuerst; Ticket nur bei Nichtgreifen |
| **W18-F3** — zsh-No-Word-Split in Coordinator-Loops | 🟢 | Praxis-Notiz; keine Engine-Änderung |
| **W18-F4** — Wiederholungen (4a-Playbook trägt, Proxy-Warnung, Stale-LSP) | 🟢 | Beobachten; kosmetisch |
