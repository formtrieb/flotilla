# flotilla — Retrospektive: die Dreier-Nachtfahrt

Waves: `2026-07-29-docs-resync` (Rows **199, 201, 185, 157, 158**) · `2026-07-29-engine-lastmile` (**150, 151, 177**) · `2026-07-29-guards` (**192, 112**) · Store: github (`formtrieb/flotilla`) · Anchor: `a0994c0` → `main` nach dem Close: `0b40c20` · Tests: 2175 → **2274** (+99).

Besonderheit dieses Laufs: **die erste Mehr-Wave-Nachtfahrt** — drei Waves sequenziell in einer Session, geplant um Mitternacht, dispatcht zwischen 01:47 und 09:15, gelandet um 10:20; der Operator schlief während Wave B. Zugleich der erste volle Lauf nach der ADR-0029-Adoption (Credentials ausschließlich Keychain-Lookup) und der Lauf, in dem drei frisch gebaute Mechanismen ihr erstes Live-Gate sahen: die Workflow-Suspension über Session-Schlaf, das Spec-Defekt-Recovery per Reviewer-Re-Round, und — Stunden nach dem eigenen Merge — der Echo-Guard.

## 0. Ergebnis in einem Satz

`triage → 2× grill → decorate → 3× (create → start) → 3× close` in einer Session: 10 Rows, 40 Agents (20+12+8), **0 Agent-Fehler**, 9/10 `approve` in Iteration 1, 1× `questions-blocking` (ein Spec-Defekt der Dekoration, nicht des Branches — Reviewer-only-Re-Round ohne Cap-Verbrauch), alle 10 PRs beim Arm **sofort** gemerged, reconciled `main` grün, 12 Issues `done` mit maschinell getickten ACs, 3 Spines archiviert — aber *ganz* AFK war es nicht: **2–4 Permission-Prompts liefen über den Menschen, und einer davon hielt Wave B ~7 Stunden an.**

## 1. Was richtig gut funktioniert hat

- **ADR-0029 hat sein Nacht-Gate bestanden.** Drei `credential-probe`-Preflights und jede Worker-/Terminator-Invocation lösten den Keychain-Lookup **promptlos** auf; der ambient Token blieb die ganze Nacht abwesend. Operator-Urteil am Morgen: „Keychain lief super." Die Indirektion ist damit unter realer AFK-Last belegt, nicht nur im Live-Gate der Adoption.
- **Ein suspendierter Workflow ist kein toter Workflow.** Wave B schlief mitsamt der Session ein (~02:00) und lief beim Wake (~09:00) einfach zu Ende — 12/12 Agents, die letzten Sidecars entstanden nach dem Aufwachen durch dieselben Scribe-Stages. `wave-resume` stand bereit und wurde **nicht gebraucht**: die Tupel kamen in-band. Session-Schlaf ≠ Coordinator-Tod — das entspannt die Nachtfahrt-Kalkulation erheblich.
- **Die Schema-Grenze + deterministisches Routing haben getragen.** Kein Wert wurde aus Prosa abgetippt; `route-outcome`/`route-verdict` liefen teils mehrfach (idempotent) und die einzige Nicht-Standard-Route der Nacht (`questions-blocking`) kam als getipptes `stop` heraus, nicht als Interpretation.
- **Die Reviewer haben Substanz geliefert, dreimal verschieden.** Der 150er-Worker korrigierte die im Issue behauptete Fehler-Mechanik **mit Messung** (der echte Pfad war ein verschluckter `readdirSync` in einem bare `catch`, nicht der beschriebene no-force-Refusal) und der Reviewer reproduzierte es unabhängig; der 151er-Reviewer fing einen Spec-Defekt, den der Koordinator selbst verursacht hatte (NF-F2); der 112er-Lauf exerzierte das Worked Example des Documented-Form-ADRs — alle drei historischen Divergenzen gefunden.
- **Convention 11 in beide Richtungen, am Guard.** Der Echo-Guard wurde nicht nur grün getestet: geplante unsafe Kommandos wurden verbatim rejected beobachtet **und** die Spec wurde gegen einen gezielt neutralisierten Guard rot beobachtet (9/40, exakt die Dump-Fälle), dann restauriert.
- **Der Kreis schloss sich noch am selben Vormittag.** Stunden nach dem Merge blockte der frisch gepastete Hook seinen **ersten Live-Befehl — einen des Koordinators** (harmlose Wiring-Probe mit `${NOT_A_REAL_TOKEN:-x}`): beide Matcher-Familien feuerten, die Teaching-Message kam, das Kommando lief nie. Der Guard erreicht strukturell genau die Rolle, die acht Katalog-Occurrences lang kein Brief erreicht hat.
- **`verdict-acked` blieb präzise:** die 192er-Row bekam 5 von 6 ACs getickt — die ehrlich-partielle AC6 (Coordinator-Close-Note, vom Worker korrekt als außerhalb seines Remits deklariert) blieb offen, bis der Koordinator sie selbst erfüllte.

## 2. Funde (nach Schwere)

### 🔴 HOCH

**NF-F1 — Permission-Prompts sind die AFK-Decke; die tracked Allowlist kannte nur die Engine, nicht die Arbeit.** 2–4 Bash-Aufrufe der Nacht brauchten einen menschlichen Klick, und ein weiterer hielt Wave B von ~02:00 bis ~09:00 an — der Operator approvte ihn beim Aufwachen, erst dann lief der Workflow zu Ende. Der Transcript-Scan zeigt die Quellen: **Worker-seitig** die gesamte Workspace-Mechanik (`git fetch/reset/checkout/add/commit/push`, `npm ci`, `npx vitest run`, `npx tsc --noEmit`) — ein Worktree erbt **nur tracked Settings** (FOR-16/54–57), und die tracked Allowlist trug ausschließlich Engine-CLI-Formen; **Coordinator-seitig** lange Compound-Kommandos und `node -e`-Formen, die kein Prefix-Match je abdecken wird. Die Maschinerie (Spine, Schemas, Routing, Suspension) war die ganze Nacht nicht der Engpass — die Permission-Schicht war es.

*Fix, bereits angewendet:* 16 eng geschnittene tracked-Allowlist-Einträge (Operator-Edit, agent-write-denied by design), u. a. `git push origin wave/:*` — auf Wave-Branches gescoped, `main` bleibt strukturell unerreichbar — plus die Paritätslücken `resume-cli`/`spine-cli`. *Residual, gefiled:* das wave-setup-Scaffold dokumentiert für Consumer nur die Engine-Formen — jeder Consumer trifft dieselbe Decke bei seiner ersten AFK-Wave. *Lesson:* **„AFK" ist eine Eigenschaft der Permission-Schicht, nicht nur des Protokolls** — die Allowlist gehört zum Dispatch-Kontrakt wie der Brief.

### 🟡 MITTEL

**NF-F2 — Eine Dekorations-AC wurde ungeprüft aus dem Issue-Body übernommen und widersprach dem shipped Design.** Der 151er-Body schlug selbst vor, eine No-Match-Row solle das Gate „failen"; die Dekoration übernahm das wörtlich — aber Gate 8 ist per dokumentiertem, getestetem FOR-127-Kontrakt advisory-only (warnt, failt nie). Der Worker folgte korrekt Policy-Klausel 1 (Repo-Policy gewinnt, warn implementiert), der Reviewer gab `questions-blocking`, und die Auflösung — AC-Amend + **Reviewer-only-Re-Round ohne Cap-Verbrauch**, in Analogie zum Bad-Anchor-Protokoll (Coordinator-Input-Defekt, nicht Branch-Content) — funktionierte auf Anhieb, ist aber nirgends als Protokoll dokumentiert. *Zwei Vorschläge:* (a) to-issues-Dekorationsregel: ein body-suggested AC wird gegen das shipped Verhalten verifiziert, bevor er AC wird; (b) das Recovery-Protokoll im Workflow-Driver nennt neben dem Bad-Anchor- auch den Spec-Defekt-Fall (gleiche drei Regeln: Reviewer-only, Worker unangetastet, Cap unberührt).

**NF-F3 — Grill-Settlements leben im Triage-Kommentar; der Worker liest nur den Body.** Die Wave-C-Kompo musste die Agent Briefs (die gesamten gesettelten Entscheidungen zu Echo-Guard und Documented-Form) von Hand in die `issueSpec`s einbetten — die Bodies allein hätten den Workern die Hälfte der Entscheidungen vorenthalten, und nichts im Compose-Pfad hätte das bemerkt. *Vorschlag:* entweder hebt die Dekoration gesettelte Briefs strukturell in den Body (amend), oder die wave-start-Kompo-Doku macht „issueSpec = Body **+ letzter Agent Brief**" zur Regel.

**NF-F4 — Zehnmal `erroredStillListed` beim Close; der Fix dafür saß in einem der zu schließenden PRs.** Alle zehn Worktrees der Nacht verweigerten die Engine-Removal deterministisch (Sandbox-Denial-Klasse) — exakt der Defekt, den Row 150 in derselben Close-Runde fixte. Der dokumentierte Manual-Step (rm + prune, Sandbox aus) griff; die **nächste Wave ist der Beweis**, dass die Klasse mit dem gemergten Fix zu ist. Kein neues Ticket — beobachten.

### ⚪ NIEDRIG

**NF-F5 — Die W17-F1/Convention-12-Klasse traf den Koordinator selbst.** Beim Wave-A-Setup lag die Engine-CLI in einer zsh-Shell-Variable — kein Word-Split, nichts lief, eine Compose-Runde verloren; die Shell-Funktion aus den Betriebsnotizen fixte es. Das dekorierte Issue zu genau dieser Klasse liegt auf dem Board; dieser Lauf bestätigt seine Priorität ohne weiteres Zutun.

## 3. Metriken

| | A `docs-resync` | B `engine-lastmile` | C `guards` |
|---|---|---|---|
| Rows / Agents | 5 / 20 | 3 / 12 | 2 / 8 |
| Laufzeit | ~17 min | ~30 min (+ ~7 h Suspension) | ~34 min |
| Iteration-1-Approves | 5/5 | 2/3 (151: Re-Round nach AC-Amend) | 2/2 |
| Cap=1-Re-Dispatches | 0 | 0 | 0 |

Gesamt: 10 PRs + 1 ADR-PR gemerged, 12 Issues geschlossen (10 Rows + 2 Konsolidierungen), 3 bare Follow-ups aus Disclosures gefiled, 1 needs-attention-Flag gesetzt und same-session aufgelöst. Der Operator-Handgriff-Zähler der Nacht: **2–4 Permission-Approves + 1 morgendlicher Stall-Approve** — alle derselben Klasse (NF-F1), keine davon Protokoll-Arbeit.
