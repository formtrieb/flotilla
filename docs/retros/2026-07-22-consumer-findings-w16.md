# flotilla — Retrospektive: Wave 16 „2026-07-22-consumer-findings" (siebzehnter Live-Lauf)

Wave: `2026-07-22-consumer-findings` · Rows: **FOR-63, FOR-64, FOR-65, FOR-68** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `a19819c` → `main` nach dem Close: `4af9ca6`.

Besonderheit dieses Laufs: **die erste Wave, deren Backlog vollständig aus dem Retro eines Consumers stammt** — die sieben Findings der ersten Linear-Consumer-Wave (`2026-07-21-keycloak-auth`, dsw21-mopla-server) wurden am selben Vormittag gegen den Upstream-Code validiert, als FOR-63…69 gefiled und die ersten vier davon noch am selben Tag gelandet. Der Consumer→Upstream-Rückkanal, für den die Retro-Disziplin existiert, hat damit seinen ersten vollen Umlauf.

## 0. Ergebnis in einem Satz

Wave 16 lief `to-issues → wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — Retro-Validierung vorab (der KW-F1-Defekt wurde vor dem Filen per Code-Read am Upstream bestätigt, nicht geglaubt), 4er-Fan-out (FOR-63/64 sonnet, FOR-65/68 opus) → **4× `approve` in Iteration 1, alle ACs met, 0 Re-Dispatches** → G3-STOP FOR-65 (public-API) human-approved → Ein-Wave-Confirm → alle vier order-free gearmt → sofort `merged` (kein CI, Conflict-Map ∅) → `main a19819c → 4af9ca6`, Gate **1676 Tests (+21) / tsc 0** auf dem reconciled main → Done-Reconcile 4× `merged` (tier-1), `--acked` maschinell → Archiv plain-mv, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Die Retro→Backlog-Pipeline trug.** Alle sieben Consumer-Findings wurden vor dem Filen upstream verifiziert (KW-F1: Emissionsreihenfolge + fehlender Metadata-Filter im Parser exakt wie beschrieben; KW-F7.4: `conflict-map` path-only während `dor` längst `--id` hatte), sauber geschnitten (dor 7/7 PASS), und die zwei bekannten Overlap-Zellen (FOR-65×67, FOR-66×69) flossen direkt in die Wave-Komposition — die drei public-API-Rows wurden bewusst auf zwei Waves verteilt, exakt die KW-F4-Heuristik, die FOR-69 später als wave-plan-Advisory dokumentierte.
- **Der Cross-Check der Batch lief als letzter Einsatz des tsx-One-offs** (store-read `{issueId, files}` → `computeConflictMap`) — dem dokumentierten KW-F7.4-Workaround, den FOR-65 in derselben Wave abschaffte. Ab jetzt: `conflict-map --id`.
- **FOR-63s Worker ging begründet über die AC hinaus.** Die AC verlangte Metadata „vor `## Files`"; der Worker emittierte sie vor *allen* Sections — weil eine freie bodySection unmittelbar vor `## Files` denselben Absorptions-Defekt reproduziert hätte, den der Fix beseitigt. Der Reviewer verifizierte den Prä-Fix-Defekt unabhängig am Anchor-SHA (kein „mental revert", sondern Code-Read) und korrigierte nebenbei eine kosmetische Zähl-Ungenauigkeit im Worker-Report (+5 Tests, nicht +6) — genau die Körnung, für die die unabhängige Re-Verifikation existiert.
- **FOR-64 validierte sich am eigenen Close.** Der verify-after-write-Guard der Linear-Transitions lief nach merge→pull→reconcile bereits live in den `close`-Aufrufen seiner eigenen Wave — vier Read-backs, null Mismatches. Die skill-seitigen Read-backs (der Stopgap seit dem Consumer-Vorfall) sind damit im Engine-Seam verankert.
- **FOR-65s Convention-9-Disclosure wurde direkt zur nächsten Scope-Entscheidung.** Der Worker legte offen, dass die Skill-Referenzdocs (path-only-Form, One-off-Workaround) außerhalb seiner Files liegen — statt Scope-Creep. Die Coordinator-Antwort: FOR-69 wurde vor W17 per amend+annotate um genau diese Docs erweitert.
- **Router-Purismus zahlte sich aus.** Ein Coordinator-seitiger Assert-Fehlschlag (siehe W16-F3) kostete nichts: `route-outcome`/`route-verdict` sind seiteneffektfrei, der Re-Run war trivial, kein State wurde angefasst.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W16-F1 — ENOTEMPTY, vierter Lauf in Folge: deregistered-but-not-deleted auf allen vier Worktrees.** `worktree-cleanup` meldete `errors:4, removed:0`, `git worktree list` war leer, die Dirs lagen physisch da; der manuelle `rm -rf` brauchte sandbox-off, weil die Sandbox `.claude/agents/`- und `.vscode/`-Pfade *innerhalb der Worktrees* verweigert. Kein neuer Fund, sondern die dritte Live-Reproduktion der FOR-67-Klasse am Tag ihres Filings — als Evidenz direkt in den FOR-67-Brief der Folgewave eingegangen.

**W16-F2 — `host-pr merge` ließ alle vier Remote-Branches stehen.** Der Checked-Step fand 4 Überlebende, Löschung per Hand (`git push origin --delete` ×4). Ebenfalls Live-Bestätigung eines frisch gefilten Tickets (FOR-66) am Tag seines Filings.

### 🟢 KLEIN

**W16-F3 — Assert-Falle: die Router-CLI pretty-printet JSON.** Coordinator-Asserts der Form `grep '"nextState":"report-in"'` schlagen fehl, weil die CLI `"nextState": "report-in"` (mit Space) emittiert. Lehre für die Driver-Praxis: Router-Output **JSON-parsen**, nie string-matchen. Keine Engine-Änderung nötig — die Verbs selbst waren korrekt.

**W16-F4 — Wiederholungen.** `failed to store: 100001` bei `git fetch`/`ls-remote` über den Proxy (kosmetisch, wiederkehrend, unerklärt — Ergebnisse jeweils korrekt) · Stale-IDE-Diagnostics auf Worktree-Dateien nach Cleanup/Reset (TS-Server ohne node_modules-Kontext; real-Gate stets grün).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W16-F1** — ENOTEMPTY deregistered-but-not-deleted ×4 | 🟡 | War bereits als FOR-67 gefiled; **in W17 gelandet** |
| **W16-F2** — Remote-Branch-Handarbeit nach host-pr merge | 🟡 | War bereits als FOR-66 gefiled; **in W17 gelandet** |
| **W16-F3** — Router-Asserts JSON-parsen statt grep | 🟢 | Coordinator-Praxis; keine Engine-Änderung |
| **W16-F4** — Wiederholungen (Proxy-Warnung, Stale-LSP) | 🟢 | Beobachten; kosmetisch |
