# flotilla — Retrospektive: die Doppelwelle (beta.1-Publish + ops-guards)

Waves: `2026-07-30-beta-publish` (Row **231**, foreground co-pilot) · `2026-07-30-ops-guards` (Rows **238, 225, 217, 241**, AFK) · Store: github (`formtrieb/flotilla`) · Anchor: `5858863` → `main` nach dem Close: `6cfb18f` · Tests: 2329 → **2356** (+27).

Besonderheit dieses Laufs: **die erste echt parallele Doppelwelle** — eine Foreground-Co-Pilot-Row (Coordinator + Operator am Publish) und eine AFK-4er-Wave liefen gleichzeitig durch je die volle Pipeline, plan→create→start→close→archiviert in einer Session. Die Max-1-in-flight-Invariante wurde dafür bewusst als Co-Pilot-Ausnahme übersteuert (Präzedenz: die Dogfood-Co-Pilot-Session der Credential-PRD): die Konfliktkarte hatte Null Zellen zwischen den Sets, und der Foreground-Pfad fächert keine Worker auf. Zugleich die Premiere des kompletten ADR-0030-Bogens (deferred-core-path → Documented-Form-Comparison → Post-Release-Re-Round) und der erste Release, der die eigene npm-first-Form operational machte.

## 0. Ergebnis in einem Satz

`wave-plan → 2× (create → start) → 2× close` parallel in einer Session: 5 Rows, 19 dispatchte Agents (16 Workflow + 3 Inline-Reviewer-Runden), **0 Agent-Fehler**, 4/5 approve in Runde 1, 1× `questions-blocking` (drei Coordinator-Entscheidungsfragen, kein Code-Defekt — cap-freier Reviewer-Re-Round), **`0.1.0-beta.1` published mit `latest`-Tag und live-verifiziertem npm-first-Gate**, alle 7 PRs beim Arm sofort gemerged, reconciled `main` grün, 5 Issues `done` mit maschinell getickten ACs, 16 Disclosures dispositioniert, 5 Follow-ups gefiled, 2 Spines archiviert — aber der Release brauchte **drei Anläufe und zwei Fix-PRs**, weil die floatende npm-Toolchain seit beta.0 zwei neue Publish-Validierungen mitgebracht hatte.

## 1. Was richtig gut funktioniert hat

- **Der ADR-0030-Bogen lief zum ersten Mal end-to-end — und trug.** Runde 1: der Publish als deklarierter unexecutable Core-Path, Documented-Form-Comparison statt leerer Ticks, AC1–3 ehrlich `deferred`. Dann wurde der Core-Path durch den Release ausführbar, und der **Post-Release-Re-Round** drehte alle drei ACs auf `met` mit **eigener** Evidenz (Tarball heruntergeladen, Shasum byte-identisch zum CI-Publish-Log, Re-Exports gegrept, beide Live-Gates selbst gefahren). Ein deferred-AC ist damit kein totes Ende mehr, sondern ein Zustand mit dokumentiertem Auflösungspfad.
- **Der cap-freie Reviewer-Re-Round ist jetzt Praxis, nicht Präzedenzfall.** Zweimal in einer Session (Entscheidungsfragen auf der E2BIG-Row; AC-Refresh auf der Publish-Row), beide ohne Worker-Re-Dispatch, beide ohne Cap-Verbrauch, beide auf Anhieb sauber geroutet. Die Analogie zum Bad-Anchor-Protokoll (Coordinator-Input vs. Branch-Content) hält.
- **Das Disclosure-Gate blockte bis zum letzten menschlichen Handgriff — korrekt.** 16 Disclosures über beide Waves; das Archiv der Publish-Wave blieb gesperrt, bis der Operator das Draft-Release-Objekt publisht hatte. Genau die Fail-Closed-Semantik, für die das Gate gebaut wurde.
- **Self-Repair-Close nach Lehrbuch.** Die E2BIG-Row änderte `worktree-cleanup.ts` — exakt die Engine-Surface, mit der der Close probt. Die Phase-4a-Detektion schlug an, `merge → pull (sandbox-off, FF mechanisch verifiziert) → reconcile` wurde eingehalten, und der **frisch gemergte Sweep räumte im selben Close alle 8 Local-Branches** seiner eigenen Wave, inklusive der `worktree-wf_*`-Klasse, die der alte Code nicht kannte.
- **Die npm-first-Form schließt den Kreis.** Nach dem Publish liefen `credential-probe` und ein Host-Verb value-free über das **nackte** `npx @formtrieb/flotilla-engine` — die Form, die jeder Resolution-Block zuerst nennt, ist erstmals operational wahr. Der Workflow-Driver-Default braucht keinen vendored Fallback mehr.
- **Convention 11 in Tiefe:** die E2BIG-Row lieferte drei Falsifikationen (Selektion, Skip-Gate, Threshold), die der Reviewer **unabhängig reproduzierte** statt nur nachlas; die Echo-Guard-Row falsifizierte per git-stash-Roundtrip gegen den Prä-Fix-Matcher und bewies mit drei Negativ-Kontrollen, dass die Carve-outs die Invocation-Blocks nicht schwächen.
- **Konservatives Scoping zahlte aus:** Die Echo-Guard-FP-Fixes blieben chirurgisch auf family-3-Head-Detection beschränkt; die Grenze wurde vom Reviewer verifiziert (families 1/2/4 scannen weiter den Roh-Text).

## 2. Funde (nach Schwere)

### 🔴 HOCH

**DW-F1 — `host-pr arm` mergte einen sekundenfrischen PR direkt, weil die Required Checks noch nicht attached waren.** Der Publish-Fix-PR wurde Sekunden nach `create` gearmt; die Antwort war `merged` mit Begründung „PR is clean — no pending required checks" — obwohl das Ruleset zwei Required Checks führt (der Preflight desselben Laufs listete sie). In der Attach-Latenz zwischen PR-Öffnung und erstem Check-Report liest der Host „keine pending Checks" und `arm` wählt den Direkt-Merge. Damit existiert ein Fenster, in dem ein PR mit noch-rot-werdenden Tests landen kann; heute war der Inhalt lokal grün geprüft, aber das ist Glück der Reihenfolge, kein Mechanismus. *Fix-Kandidat, gefiled:* `arm` kennt die Required-Check-Liste bereits über die Preflight-Logik — ein Direkt-Merge sollte verweigert (oder auf echtes Armen ausgewichen) werden, solange required-benannte Checks für den Head-SHA schlicht **noch nicht berichtet** haben; „keine Checks gemeldet" ist nicht „alle Checks bestanden".

### 🟡 MITTEL

**DW-F2 — Die floatende npm-Toolchain brach den Release am schlechtesten Moment; einer der beiden Fehler hätte still ein kaputtes Paket geshippt.** `npm install -g npm@^11.5.1` (Floor ohne Ceiling, bewusst) floatete seit beta.0 in eine 11.x mit zwei neuen Publish-Validierungen: ein `./`-Präfix im bin-Feld wird beim Publish per Auto-Correct **entfernt** (das Paket wäre ohne sein Binary erschienen), und Prereleases verweigern ohne explizites `--tag`. Ironie mit Schutzwirkung: der `--tag`-Fehler brach den Run ab, **bevor** der bin-Verlust shippen konnte. Beide in-wave gefixt (bin normalisiert; versionsabgeleiteter Dist-Tag, per Operator-Entscheid explizit `latest` pre-1.0). Zwei Folge-Lektionen, beide gefiled: der **dritte Recovery-Pfad** (Fix-Commit + Tag-Move + `workflow_dispatch`) fehlt im Releasing-Doc — inklusive des versteckten Schritts, dass der **Tag-Move das bereits publizierte Release-Objekt in den Draft-Zustand zurückwirft** (untagged-URL; der Operator musste nachpublishen, der erwartbare Duplikat-rote Re-Fire-Run ist zu dokumentieren); und der setup-node-Pin-Kommentar behauptet Vendor-Konformität, die seit dem Vendor-Sprung auf die nächste Major stale ist.

**DW-F3 — cwd persistiert NICHT zwischen den Bash-Calls eines dispatchten Subagents — zwei Rows haben es unabhängig gemessen, und der Scribe-Zweischritt ruht damit auf inzidenteller Sicherheit.** Die Convention-13-Row korrigierte die Persistenz-Behauptung ihrer eigenen AC beim Erfüllen; die Echo-Guard-Row bestätigte empirisch dasselbe aus ihrem Worktree. Der Scribe-Brief (`cd` in Call 1, Engine-Verb in Call 3) funktioniert heute nur, weil das npm-first `WAVE_CLI` pfadfrei ist und die Sidecar-Dirs absolut sind — ein Consumer auf der vendored Form bräche genau hier. Strukturelle Antwort gefiled; die gelandete Convention 13 trägt die korrigierte Formulierung bereits.

**DW-F4 — Die Wiring-Gap-Klasse traf wieder, wurde aber diesmal im Review gefangen statt danach.** Fünf neue Engine-Exports der E2BIG-Row haben keinen Produktions-Consumer (CLI-Flag, Advisory-Verb, Barrel-Re-Exports — alle außerhalb der deklarierten Files). Convention 9 tat, wofür sie gebaut wurde: Worker disclosed, Reviewer eskalierte, Coordinator entschied Follow-up statt In-Wave-Scope-Extension, AC blieb ehrlich `partial`. *Dekorations-Lektion:* eine AC wie „der Dispatch-Preflight zeigt X" ist auf Doc-Ebene erfüllbar — wer die CLI-Ebene will, muss die Consumer-Surface in der AC benennen.

### ⚪ NIEDRIG

**DW-F5 — Die Sandbox-Delete-Klasse reproduzierte erwartungsgemäß (4× `erroredStillListed`, deterministisch).** Der dokumentierte Manual-Step (rm + prune, Sandbox aus) griff; **neu** ist, dass der frisch gelandete Detached-Sweep die Discovery-Hälfte komplett übernahm. Die Delete-Denial selbst ist Harness-Level und bleibt; beobachten, kein neues Ticket.

**DW-F6 — Echo-Guard-Betriebspraxis am Coordinator:** Verdict-Renders mit Guard-Tokens dürfen nie in Kommando-Text — der etablierte Umweg (Capture in Variable, Interpolation zur Laufzeit; der Hook sieht nur Kommando-Text) trug durch alle vier Terminatoren. Nach den gelandeten family-3-Carve-outs schrumpft die FP-Fläche; der Schwester-Guard (Worktree-Isolation lehnt die sanktionierte Presence-Form ab) ist als eigenes Ticket auf dem Board.

## 3. Metriken

| | A `beta-publish` | B `ops-guards` |
|---|---|---|
| Rows / Agents | 1 / 3 (Coordinator als Worker + 2 Reviewer-Runden) | 4 / 17 (16 Workflow + 1 Re-Round) |
| Laufzeit | ~1 h 45 (inkl. Release-Odyssee + Operator-Akte) | ~45 min Workflow + Routing/Close |
| Runde-1-Approves | 1/1 (AC1–3 deferred, post-release → met) | 3/4 (E2BIG: questions-blocking → Re-Round approve) |
| Cap=1-Re-Dispatches | 0 | 0 |
| Disclosures (dispositioniert) | 5/5 | 11/11 |

Gesamt: 7 PRs gemerged (3 Publish-Strecke + 4 Wave-Rows), 5 Issues `done` mit Acked-Ticks (die ehrlich-partielle E2BIG-AC2 blieb korrekt unticked), 5 bare Follow-ups aus Disclosures gefiled + 1 aus diesem Retro (DW-F1), 1 needs-attention-Flag gesetzt und same-session aufgelöst, `0.1.0-beta.1` auf der Registry mit `latest`-Tag und Provenance. Operator-Handgriffe: Release publishen, Dist-Tag-Add, Draft-Release nachpublishen, zwei Confirms — alle Protokoll-gewollt (human-gated), keiner davon Reibung der Maschinerie.
