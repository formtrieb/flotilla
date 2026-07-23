# flotilla — Retrospektive: Wave 23 „2026-07-23-ci-verify-setup-env" (vierundzwanzigster Live-Lauf)

Wave: `2026-07-23-ci-verify-setup-env` · Rows: **FOR-78 + FOR-79** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `b60ce0e` → `main` nach dem Close: `d4649d7`.

Besonderheit dieses Laufs: **das Repo bekommt seine erste CI** — und der Weg dahin traf eine bis dato unbekannte STOP-Klasse: ein PAT ohne `workflow`-Scope darf das erste Workflow-File der Repo-Geschichte nicht pushen. Die Auflösung etablierte ein zweites Einsatzfeld für das Reviewer-only-Recovery-Protokoll.

## 0. Ergebnis in einem Satz

Wave 23 lief `wave-plan → wave-create → wave-start → wave-close --auto` mit einer Gabelung: FOR-79 sauber durch (**`approve` Iteration 1, 3/3 ACs met**, PR #58 direct-merged, im eigenen Close self-reconciled) — FOR-78 endete als Worker-`blocked` an der Push-Rejection (PAT ohne `workflow`-Scope), wurde nach Operator-Scope-Grant per **Coordinator-Push des unveränderten Worker-Commits + Reviewer-only-Re-Round (Cap unverbraucht)** aufgelöst, `approve` 3/3 mit AC3 live am eigenen PR bewiesen, PR #59 direct-merged — Endstand **CI live (erster main-Run grün), 1750 Tests / tsc 0, beide Rows Done mit vollem `--acked`**, Archiv plain-mv.

## 1. Was richtig gut funktioniert hat

- **Der Worker zog die Remit-Grenze exakt richtig.** Push zweimal rejected → ehrliches `blocked` mit präziser Ursachen-Analyse (Credential-Helper, Scope, „erstes Workflow-File ever") — und **bewusst kein SSH-Remote-Workaround**, obwohl ein Key vorhanden gewesen wäre: eine unreviewte Credential-/Trust-Entscheidung liegt außerhalb des Worker-Auftrags. Genau die Eskalations-Disziplin, die ADR-0012 will.
- **Das Reviewer-only-Recovery-Protokoll (W2-F1) generalisiert.** Ursprünglich für den Bad-Anchor-Fall geschrieben, trug es hier den zweiten Fall: eine Review-Runde, die an einem *Environment*-Blocker scheiterte (kein PR → AC3 unbeobachtbar), nicht am Branch-Inhalt. Re-Round nur des Reviewers, Verdict-Overwrite per last-writer-wins auf derselben Iteration, Cap unangetastet — der Worker-Commit blieb byte-identisch.
- **AC-Design mit eingebauter Probe zahlt aus:** „Der PR, der das Workflow-File einführt, ist sein eigener Probe-Lauf" machte AC3 zur Live-Evidenz statt zur Behauptung — der Re-Round-Reviewer pollte die Check-Runs am Head-Commit und tickte `met` erst auf `completed/success` × 2.
- **FOR-79 self-validierte im eigenen Close:** Die Row dokumentiert das settings-env-Muster für Consumer — und der Done-Reconcile der Wave lief bereits über die gemergten Skill-Docs (inkl. des dokumentierten Half-Applied-Pull auf `.claude/skills/**`, aufgelöst exakt nach dem Playbook-Wort, das W21 gelandet hatte).

## 2. Funde (nach Schwere)

### 🔴 GROSS

**W23-F1 — Convention-8-Klasse, drittes Vorkommen, dritter Vektor.** Der FOR-79-Reviewer `cat`ete auf der Suche nach einem env-Block-Präzedenzfall die gitignorte `.claude/settings.local.json` — live wirkende Credentials (Host-Token + Tracker-Key) landeten im Session-Transkript. Selbst offengelegt, nichts verließ die Maschine, nichts im Repo — aber: W8-F1 war Fallback-Echo, W21 war `printenv`, jetzt ein File-Read. **Jede Prosa-Härtung schloss den jeweils letzten Vektor; jedes neue Vorkommen fand einen unbenannten.** Der W21-F1-Beschluss („Struktur-Anker-Ticket beim nächsten Vorkommen") ist damit ausgelöst → **FOR-81 gefiled** (Settings-Deny-Anker + Convention-8- und Brief-Klausel-Härtung im tracked Doc). Die Credential-Rotation wurde vom Operator bewusst vertagt — als offener Punkt protokolliert.

### 🟡 MITTEL

**W23-F2 — Neue STOP-Klasse: Host-Policy-Rejection am Push (PAT-`workflow`-Scope).** Strukturell interessant: die Arbeit war fertig und verifiziert, der Blocker lag ausschließlich in der Transport-Berechtigung — `route-outcome` kennt dafür aber nur die `worker-failed`-Schiene (terminal-failure-Flag), obwohl der Fall operator-recoverable war und per Retry-within-wave auflöste. Kein akuter Ticket-Bedarf (der Fall ist per Definition einmalig pro Repo — das erste Workflow-File), aber als Playbook-Wissen festgehalten: *Push-Rejection wegen Host-Policy → Flag mit Scope-Grant-Option, Coordinator-Push + Reviewer-only-Re-Round, Cap nicht anfassen.*

### 🟢 KLEIN

**W23-F3 — `erroredStillListed` ×2 (fünftes Vorkommen).** Beide Workflow-Worktrees; `prune + rm (sandbox-off)` wie im Playbook. Weiterer Datenpunkt für die W22-F1-Diskussion (Force-Pfad vs. bewusster Mensch-Schritt) — nächste Planung.

**W23-F4 — Wiederholungen.** `failed to store: 100001` beim Credential-Helper (kosmetisch, ×2) · `.git/config`-Lock-Warnung beim Branch-Delete unter Sandbox (Delete selbst erfolgreich).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W23-F1** — Secret-Echo-Klasse, 3. Vorkommen (File-Read-Vektor) | 🔴 | **FOR-81 gefiled** (Struktur-Anker); Rotation vertagt (Operator-Entscheidung, offen) |
| **W23-F2** — STOP-Klasse Host-Policy-Rejection am Push | 🟡 | Playbook-Wissen (dieses Retro); kein Ticket — einmalig pro Repo |
| **W23-F3** — erroredStillListed 5. Vorkommen | 🟢 | Datenpunkt für W22-F1-Diskussion |
| **W23-F4** — Wiederholungen | 🟢 | Beobachten; kosmetisch |
