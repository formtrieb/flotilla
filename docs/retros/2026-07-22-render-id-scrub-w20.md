# flotilla — Retrospektive: Wave 20 „2026-07-22-render-id-scrub" (einundzwanzigster Live-Lauf)

Wave: `2026-07-22-render-id-scrub` · Rows: **FOR-74** (Einzel-Row) · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `28c6a51` → `main` nach dem Close: `6bdbd8c`.

Besonderheit dieses Laufs: **die fünfte komplette Wave desselben Tages** — und die mit der schönsten Pointe: die Verdict-Section *über den Id-Scrub* war selbst voller scannbarer Test-Fixture-Ids und brauchte den letzten manuellen Scrub der Geschichte, selbst-konsistent mit genau der Methode, die der PR einführt. Parallel lief die zweite Consumer-Wave (Retro-Doc-Slug `2026-07-22-postgres-ci`) und traf **unabhängig dieselbe Fundklasse** (dort PC-F4, von Hand per U+2011 entschärft) — der Fix dieser Wave schließt beide Vorkommen.

## 0. Ergebnis in einem Satz

Wave 20 lief `to-issues → wave-create → wave-start → wave-close --auto` in einer Session — 1er-Fan-out (FOR-74 auf opus) → **`approve` in Iteration 1, alle 4 ACs met, 0 Re-Dispatches** → G3-STOP human-approved (inkl. bewusst breiter Regex-Reichweite, unten) → Arm-Confirm → `host-pr arm` outcome **`merged`** → Self-Repair-Fall (CLI + Driver-Doku) → merge→pull(sandbox-off)→reconcile → Gate **1747 Tests (+17) / tsc 0** → 🎯 **FOR-73-Live-Gate GEFEUERT: erstes non-empty `erroredStillListed`** im Prä-Merge-Cleanup → Auto-Delete ×2 bestätigt + Orphan-Sweep → Done-Reconcile `merged`, `--acked` voll → Archiv plain-mv, **Backlog leer**, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Das offene Live-Gate der Vorwave feuerte im eigenen Close — und bestand.** Der Prä-Merge-Cleanup traf erneut die ENOTEMPTY-Zwischenform, und die eine Wave zuvor gelandete Klassifikation meldete sie **strukturell**: `erroredStillListed` non-empty (voller WorktreeEntry mit Branch und Head), `errors` leer, exit 1. Vorher/Nachher-Beweis über zwei aufeinanderfolgende Waves; die Consumer-Wave sah dieselbe Klassifikation am selben Tag zweimal korrekt (PC-F3 drüben).
- **Der armed-Pfad ist end-to-end handarbeitsfrei.** Das frisch aktivierte Repo-Setting räumte den Remote-Branch zum zweiten Mal automatisch; der Standalone-Sweep fegte danach beide Locals strukturell. Zwischen Arm-Confirm und archiviertem Spine lag kein einziger manueller Branch-Schritt mehr.
- **Same-day-Cross-Validierung durch den Consumer, in beide Richtungen.** Die parallele Consumer-Wave traf die Mention-Klasse unabhängig (PC-F4: Sibling-Branch-Namen und Focus-Item-Ids im Render — deren Coordinator entschärfte von Hand per U+2011); FOR-74 schließt beide Vorkommen strukturell, der Consumer braucht nur den nächsten Engine-Resync. Umgekehrt lieferte der Consumer den Beweis, den das eigene Repo nie erzeugen kann: **`armed`-bei-pending** wurde dort am Retro-PR live beobachtet (PC-F7) — beide ADR-0023-Zweige (clean→Direct-Merge, pending→armed→Auto-Merge) sind damit live verifiziert.
- **Die Ironie als Abschlussbeweis:** Die gerenderte Verdict-Section über den Id-Scrub trug selbst 10 Sorten scannbarer Ids (Test-Fixtures, AC-Ordinals, Doc-Refs — darunter vier echte Workspace-Issues). Der letzte manuelle Scrub lief selbst-konsistent per U+2060; Scan danach: 0 Tokens. Ab dem nächsten Close macht das der gelandete Fix am Render-Ausgang automatisch.
- **G3 trug die eigentliche Design-Entscheidung.** Die bewusst breite Regex (auch bare `#N`-Ordinals auf jedem Store, auch `ADR-`/`SHA-`-förmige Tokens — unsichtbar neutralisiert, visuell identisch) war vom Worker als needs-human-eyes offengelegt, vom Reviewer gespiegelt und wurde am Gate bewusst bestätigt — fail-safe über präzise, weil der Joiner Over-Matching folgenlos macht.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W20-F1 — Offenes Live-Gate: U+2060 muss GitHubs echtes Markdown→HTML-Rendering überleben.** Die Spec beweist den Round-Trip (Token nicht scannbar, Joiner-Strip stellt das Original wieder her); dass die Integration auch im *gerenderten* PR-Body nicht matcht, ist plausibel (U+2060 ist non-ignorable), aber erst am nächsten Close mit echter fremder Id in Evidence live belegt. Vom Reviewer explizit geflaggt — beim nächsten Vorkommen prüfen, kein Ticket vorab.

**W20-F2 — Consumer-Import PC-F2: Worker-gestartete Compose-Stacks überleben das Worktree-Cleanup.** Der Consumer-Lane-Worker ließ sein Compose-Projekt (Container, Volume, Netz, belegter Port) nach dem Cleanup weiterlaufen — `worktree-cleanup` kennt nur Git-Artefakte, keine Runtime-Ressourcen. Consumer-Mitigation etabliert (Brief-Klausel „Host-Stack mitnutzen"); der generische Anker fehlt upstream: eine Runtime-Hinterlassenschafts-Klausel im Worker-Brief (workflow-driver) und/oder ein Cleanup-Sweep für `wf_*`-benannte Compose-Projekte. Ticket-Kandidat (Zuschnitt offen: Brief-only vs. Cleanup-Erweiterung).

### 🟢 KLEIN

**W20-F3 — PC-F4 ist durch diese Wave bereits geschlossen.** Kein Ticket; die Empfehlung an den Consumer ist der nächste Engine-Resync (der Fix liegt ab `6bdbd8c` upstream). Der dortige Hand-Scrub (U+2011) und der hiesige (U+2060) bestätigen einander als Interim-Praxis.

**W20-F4 — PC-F3-Betriebsnotiz ist upstream abgedeckt, ein Wort fehlt.** Die close-mechanics-Playbook-Zeile zur neuen Klasse nennt `git worktree prune` + `rm -rf`, aber nicht, dass das `rm` unter `.claude/worktrees/` typisch **sandbox-off** braucht (drei Live-Vorkommen heute, zwei beim Consumer). Ein-Wort-Ergänzung — beim nächsten Doc-Touch mitnehmen, kein eigenes Ticket.

**W20-F5 — Wiederholungen.** Stale-IDE-Diagnostics auf toten Worktree-Pfaden (kosmetisch, ×3 heute) · `failed to store: 100001` (kosmetisch) · Squash-Merge-Locals brauchen `-D` bzw. den Sweep.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W20-F1** — U+2060 vs. echtes GitHub-Rendering | 🟡 | Live-Gate beim nächsten Foreign-Id-Close; kein Ticket vorab |
| **W20-F2** — Runtime-Hinterlassenschaften (Consumer-Import PC-F2) | 🟡 | **Kandidat** für to-issues (Zuschnitt: Brief-Klausel vs. Cleanup-Sweep) |
| **W20-F3** — PC-F4 durch FOR-74 geschlossen | 🟢 | Kein Ticket; Consumer-Resync empfohlen |
| **W20-F4** — sandbox-off-Wort in der Playbook-Zeile | 🟢 | Beim nächsten Doc-Touch; kein eigenes Ticket |
| **W20-F5** — Wiederholungen | 🟢 | Beobachten; kosmetisch |
