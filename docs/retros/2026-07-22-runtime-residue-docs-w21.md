# flotilla — Retrospektive: Wave 21 „2026-07-22-runtime-residue-docs" (zweiundzwanzigster Live-Lauf)

Wave: `2026-07-22-runtime-residue-docs` · Rows: **FOR-75, FOR-76** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `fc0c85e` → `main` nach dem Close: `7d8f534`.

Besonderheit dieses Laufs: **das Consumer-Import-Duo** — beide Slices entstammen wörtlich der Funde-Tabelle der zweiten Consumer-Wave (deren Retro-Doc-Slug `2026-07-22-postgres-ci`), gefiled und gelandet am selben Abend. Mit ~8 Minuten Workflow-Laufzeit der schnellste Lauf bisher — und der erste echte Fan-out seit dem Retro-Polish-Trio.

## 0. Ergebnis in einem Satz

Wave 21 lief `to-issues → wave-create → wave-start → wave-close --auto` in einer Session — 2er-Fan-out (beide sonnet) → **2× `approve` in Iteration 1, alle ACs met, 0 Re-Dispatches** → kein G3 (beide non-public-API) → Arm-Confirm (1 Klick, inkl. offen ausgewiesenem Security-Fund, unten) → beide `host-pr arm` outcome **`merged`** → Pull sandbox-off (Skill-Files im Diff) → Gate **1747 Tests / tsc 0** → Done-Reconcile 2× `merged`, `--acked` voll → Archiv plain-mv, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Der Auto-Id-Scrub bestand seinen ersten Live-Einsatz, eine Wave nach seinem Landing.** Beide Terminator-Renders liefen durch die neue ownId-Engine: fremde id-förmige Tokens automatisch per Word-Joiner neutralisiert (1× bzw. 3×), nur die eigene Id blieb scannbar — null Handarbeit, wo einen Tag zuvor noch zwei Coordinators (upstream und consumer) unabhängig voneinander von Hand scrubbten.
- **Der armed-Pfad ist end-to-end handarbeitsfrei bestätigt.** Auto-Delete räumte beide Remote-Branches, der Standalone-Sweep alle vier Locals (zwei `wave/*`, zwei Harness-Throwaways) — zwischen Arm-Confirm und archiviertem Spine kein manueller Branch-Schritt.
- **Der Consumer→Upstream-Loop schloss sich am selben Abend.** PC-F2 wurde zur wave-shared Convention 10 (Nummer beim Slicing gepinnt, Drift-Literale byte-unberührt), PC-F3 zur sandbox-off-Zeile im close-mechanics-Playbook — und beide Reviewer verifizierten die Struktur-Treue (Convention-8/9-Muster, Klauselnummern 1–7 unangetastet) explizit.
- **Datei-disjunkter Fan-out ohne Reibung:** beide Reviewer fuhren die Sibling-merge-tree-Prediction, beide sauber — die Conflict-Map-∅-Vorhersage hielt am realen Merge.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W21-F1 — SECRET-SAFE-Verstoß trotz Brief-Klausel: der Worker druckte den Live-Token ins Transkript.** Der FOR-75-Worker prüfte die Token-Verfügbarkeit per `printenv GITHUB_TOKEN` statt der sanktionierten value-freien Form — der Live-Wert landete im Tool-Output, also im Session-Transkript auf Disk (zweites Vorkommen der Klasse nach W8-F1; Convention 8 samt Klausel stand im Brief). Der Worker legte es selbst offen, der Reviewer bestätigte unabhängig: nichts in Repo, Commit oder PR. **Operator-Aktion: Token-Rotation (Präzedenz W8-F1), zugesagt.** Die eigentliche Lehre: **die Brief-Klausel allein verhindert die Klasse nicht zuverlässig** — ein Agent improvisiert Diagnostik am Brief vorbei. Ad-hoc-Härtung ab dem Folgelauf: explizites `printenv`-Verbot in der Klausel (der nächste Lauf blieb clean). Struktur-Anker-Kandidaten für ein Ticket: Deny-Hook auf `printenv`-Pattern im Worker-Kontext oder Secret-Ausblendung aus der Worker-Umgebung. Beobachten, ob das Klausel-Verbot trägt; Ticket beim nächsten Vorkommen.

### 🟢 KLEIN

**W21-F2 — `erroredStillListed` ×2, Playbook trägt.** Beide Worktrees trafen die Zwischenform; strukturell gemeldet, nach der (in dieser Wave frisch dokumentierten) sandbox-off-Zeile geräumt.

**W21-F3 — Wiederholungen.** Stale-IDE-Diagnostics auf toten Worktree-Pfaden · `failed to store: 100001` (kosmetisch) · Squash-Locals brauchen den Sweep bzw. `-D`.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W21-F1** — printenv-Klasse trotz Brief-Klausel (Struktur-Anker: Hook/Deny oder Env-Ausblendung) | 🟡 | **Operator-Aktion Rotation zuerst**; Klausel-Verbot beobachten, Ticket beim nächsten Vorkommen |
| **W21-F2** — erroredStillListed-Regelmäßigkeit | 🟢 | Beobachten (siehe auch W22-Retro) |
| **W21-F3** — Wiederholungen | 🟢 | Beobachten; kosmetisch |
