# flotilla — Retrospektive: Wave 19 „2026-07-22-cleanup-classification" (zwanzigster Live-Lauf)

Wave: `2026-07-22-cleanup-classification` · Rows: **FOR-73** (Einzel-Row) · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `6f385f5` → `main` nach dem Close: `152cc44`.

Besonderheit dieses Laufs: **die vierte komplette Wave desselben Tages und die erste Einzel-Row-Wave überhaupt** — der Fund-zu-Fix-Umlauf schrumpfte auf unter zwei Stunden (W18-F1 mittags im Retro benannt, früh nachmittags gefiled, eine Dreiviertelstunde später gelandet). Dazu der **vierte Self-Validation-Close in Folge**: der Prä-Merge-Cleanup traf exakt die ENOTEMPTY-Zwischenform, die die Row selbst strukturell benennt — einmal mit der Prä-Fix-Engine (generisches `errors`), und Minuten später zeigte der Post-Merge-Sweep das neue Feld live in der Summary.

## 0. Ergebnis in einem Satz

Wave 19 lief `to-issues → wave-create → wave-start → wave-close --auto` in einer Session — degenerierter 1er-Fan-out (FOR-73 auf opus) → **`approve` in Iteration 1, alle 5 ACs met, 0 Re-Dispatches** → G3-STOP human-approved → Arm-Confirm (1 Klick) → `host-pr arm` outcome **`merged`** (Direct-Merge, PR sauber, keine Required Checks) → Self-Repair-Fall mechanisch detektiert (`ENGINE_SURFACE`-Hit auf das Cleanup-Verb + die CLI) → merge→pull(sandbox-off)→reconcile ohne Half-Applied-Pull → Gate **1736 Tests (+6) / tsc 0** → Done-Reconcile `merged`, `--acked 0,1,2,3,4` voll → Branch-Hygiene strukturell (Sweep ×2) → Archiv plain-mv, **Backlog leer**, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Der Retro→Backlog→Landing-Zyklus unterbot sich selbst.** W18-F1 stand mittags in der Funde-Tabelle, war 40 Minuten später als dor-PASS-Issue auf dem Board und am frühen Nachmittag gemergt — die Funde-Tabelle bleibt das Grooming, und die Einzel-Row-Wave macht den Umlauf minimal.
- **Die erste Einzel-Row-Wave bestätigt den degenerierten Pfad.** Der Workflow-Driver lief als one-element `pipeline()` (Worker → Scribe → Reviewer → Scribe, 4 Agents/0 Fehler, ~18 min) — Routing, Schema-Grenzen und Scribe-Disziplin identisch zum Fan-out; kein Sonderpfad nötig.
- **Self-Validation Nr. 4, diesmal mit Vorher-Nachher-Beweis in einem Close.** Der Prä-Merge-Cleanup traf ENOTEMPTY ×1 auf `prunable`-gelistetem Worktree — mit der Prä-Fix-Engine noch als generisches `errors` (exakt der W18-F1-Befund). Nach merge→pull führte der Sweep `erroredStillListed` als eigenes Feld in der Summary (leer, Clean-Path — der erweiterte Full-Summary-Test live). Das eigentliche Live-Gate — ein **non-empty** `erroredStillListed` — steht beim nächsten echten ENOTEMPTY-Close aus.
- **Die Self-Repair-Detection griff mechanisch, nicht aus Erinnerung.** Der `ENGINE_SURFACE`-Grep meldete den Hit (Cleanup-Verb + CLI + die wave-close-Referenz selbst), der Pull lief diszipliniert sandbox-off mit HEAD-Verifikation — kein Half-Applied-Pull, Phase 5 reconcilierte gegen die Engine, die die Wave selbst shippte.
- **Zweiter Realeinsatz des Standalone-Sweeps, korrekt konservativ.** Der Harness-Throwaway-Branch fiel sofort; der `wave/*`-Local blieb korrekt stehen, solange sein Remote existierte, und fiel erst nach dem Remote-Delete — die Remote-Existenz-Probe hält.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W19-F1 — `render-verdict` trägt fremde Tracker-Ids ungefiltert in den PR-Body.** Der Reviewer-Evidence-Text nannte den strukturellen Sibling der neuen Klasse per Id; die gerenderte `## Reviewer verdict`-Section landete damit wörtlich im PR-Body — und auf einem integrierten Tracker ist **jede** bare Id link- und act-bar (Mention-Footgun, wave-shared Convention 4; zweimal live gebrannt). Diesmal fiel es im Coordinator-Check vor dem Merge auf und wurde von Hand gescrubbt + re-pinnt — aber der Scrub ist **unverankert**: keine Brief-Klausel verpflichtet Reviewer-Evidence auf ADR-/Doc-Slug-Referenzen, kein Guard am render-Ausgang neutralisiert fremde Ids, keine Checklisten-Zeile am Terminator fordert den Grep. Drei mögliche Anker (Brief-Klausel · render-seitiger Scrub · Terminator-Checkliste); der strukturelle sitzt am Single-Owner-Render. Ticket-Kandidat (klein schneiden).

### 🟢 KLEIN

**W19-F2 — Wiederholungen.** ENOTEMPTY ×1 auf dem eigenen Worktree, nach Playbook aufgelöst (Retry → `git worktree prune` → `rm -rf` sandbox-off — die neue close-mechanics-Zeile trug, bevor sie gemergt war) · Stale-IDE-Diagnostics auf halb entfernten Worktree-Pfaden (kosmetisch) · `failed to store: 100001` (Proxy-Warnung, kosmetisch).

**W19-F3 — W18-F2 ist geschlossen: Repo-Setting „automatically delete head branches" aktiviert** (Operator-Aktion, nach diesem Lauf). Live-Test: der nächste gemergte PR — dieser Retro-PR selbst — muss seinen Remote-Branch ohne Handarbeit verlieren; der Standalone-Sweep räumt dann den Local hinterher. Greift das Setting, entfällt der letzte manuelle Schritt des armed-Pfads.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W19-F1** — fremde Tracker-Ids im render-verdict-Ausgang neutralisieren (Mention-Footgun-Anker) | 🟡 | **Kandidat** für to-issues (klein) |
| **W19-F2** — Wiederholungen (Playbook trägt, Stale-LSP, Proxy-Warnung) | 🟢 | Beobachten; kosmetisch |
| **W19-F3** — auto-delete head branches aktiviert; Live-Test am nächsten Merge | 🟢 | **Erledigt**; Gate beim nächsten PR |
