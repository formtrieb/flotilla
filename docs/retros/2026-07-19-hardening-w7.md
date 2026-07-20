# flotilla — Retrospektive: Wave 7 „2026-07-19-hardening-w7" (achter Live-Lauf)

Wave: `2026-07-19-hardening-w7` · Rows: **FOR-34, FOR-36, FOR-37, FOR-38** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `a3862b3` → `main` nach dem Close: `99ebf73`.

Besonderheit dieses Laufs: das **pre-cut-Härtungs-Quartett aus ADR-0026** (die letzte Härtungs-Wave vor dem Publication-Cut), zugleich das **Live-Gate der Scribe-Stufen** (ADR-0024 — gebaut in w6, hier zum ersten Mal gelaufen) und der **erste Produktiv-Einsatz des Workflow-Resume-Caches**. Der ganze Zyklus `wave-create → wave-start → wave-close` lief in einer Session, die am selben Tag auch den Publication-Grill (ADR-0026), das W8-Ticket-Filing und das neue Ops-Durability-Repo hervorgebracht hatte.

## 0. Ergebnis in einem Satz

Wave 7 lief den vollen Zyklus — 4er-Fan-out → **3× `approve` in Runde 1 + 1× `changes-requested` mit echtem Fund (FOR-36: ein fremdes Issue-Id im eigenen PR-Body — der Mention-Footgun, in exakt der Wave, die seine Konvention dokumentiert) → sauberer cap=1-Re-Dispatch (Iteration 2 = reiner PR-Metadaten-Fix, Branch-Tip verifiziert unverändert) → `approve`** — plus **ein Reviewer-Tod durch das Permission-Gate (FOR-34), protokollrein per Workflow-Resume geheilt** (14 Agents aus dem Cache, nur Reviewer + Verdict-Scribe liefen neu, kein Cap verbraucht) → 4 squash-PRs #38/#36/#35/#37 in Advisory-Order → `main a3862b3 → 99ebf73`, **Union-Gate 1443 Tests (= 1423 + 6 + 14, exakt die Vorhersage), tsc 0** → alle 4 `done` via `read-closing`+`close` mit der Post-Pull-Engine → Archiv plain-mv → Ops-Repo gepusht. **0 STOPs** (keine public-API-Row im Roster).

## 1. Was richtig gut funktioniert hat

- **Das Scribe-Live-Gate: bestanden, mit Beweis.** Die Sidecar-mtimes sind minutenweise gestaffelt (23:43 → 00:01) — jeder Report/Verdict wurde sekundengenau beim Agent-Return durch `write-report`/`write-verdict` geschrieben, nichts gebatcht. Der Härtetest kam ungeplant: als FOR-34s Reviewer starb, lagen bereits **4 Reports + 3 Verdicts durabel auf Platte**. Genau das P-1-Szenario der ersten Live-Wave — diesmal ohne Verlustfenster. Die Workflow-Logs zeigen zusätzlich jede Scribe-Bestätigung (`sidecar written: …`).
- **Workflow-Resume als Recovery-Pfad, erster Produktiv-Einsatz.** Nach dem Reviewer-Tod: `resumeFromRunId` → die 14 abgeschlossenen Agents replayten aus dem Cache, nur der Reviewer + sein Verdict-Scribe liefen live (~7,7 min statt ~28). Kein Worker-Re-Dispatch, kein Cap-Verbrauch — es gab nie einen abgeschlossenen Review-Round, also war nichts zu zählen (dieselbe Logik wie die w2-Bad-Anchor-Recovery).
- **Der zweite saubere cap=1-Zyklus der Serie (FOR-36).** Der Reviewer fing den Body-Mention per unabhängigem Host-Read, `route-verdict` lieferte `re-dispatched`, der Iteration-2-Worker patchte ausschließlich die PR-Metadaten (Read-back: einziger `FOR-\d+`-Treffer im Body ist die Close-Phrase; `git ls-remote`: Tip unverändert), der Iteration-2-Reviewer approvte. Coordinator-as-Scribe auf dem Inline-Pfad, beide Iter-2-Sidecars verb-geschrieben — die per-Pfad-Invariante aus ADR-0024 hielt auf beiden Pfaden.
- **Reviewer-Tiefe erneut auf FOR-21-Niveau:** FOR-34s (Resume-)Reviewer reproduzierte den `git worktree remove`-Footgun **und** den Fix unabhängig in Scratch-Repos (chmod-000-Fixture: pre-fix deregistriert git trotz Exit 255; post-fix wirft `rmSync` vor jedem git-Aufruf); FOR-38s Reviewer verifizierte die +14 Tests und die 40-Zellen-Regression; FOR-36s Reviewer bestand auf dem einen Blocking-Item, obwohl alle ACs met waren.
- **Alle gehärteten Vorgänger hielten:** FOR-19s Anchor-Assertion (`anchor assertion passed for 4 rows`), FOR-32s Brief-Skeleton (kein Worker stolperte über den leeren Worktree), FOR-5s Dispatch-Log (4 Branches + Modelle vor Worker-Existenz — Resume-Voraussetzung), W5-F1s `anyOf`-freie Schema-Kopie (kein 400), Convention 4 (4× `Fixes FOR-NN`, 4× Attachment gefunden), und die **frisch gemergte FOR-36-Doku wurde beim eigenen Close erstmals als Routine befolgt** (merge → pull *sandbox-off* → reconcile; der Pull lief vollständig, HEAD-Check, Union-Gate exakt).
- **`host-pr` trug erneut das komplette Landing:** 4 Merges + `status`-Read-backs; Branch-Löschung als geprüfter Schritt (4× `[deleted]`, `git ls-remote 'wave/*'` → 0).
- **Erste Wave mit Remote-Durability:** das neue Ops-Repo (`.flotilla/` als nested Git, Branch `ops`) wurde spine-first mitgepflegt — Spine-Erstellung, Dispatch-Stand und Close/Archiv sind je ein gepushter Commit; ein Maschinenverlust hätte zu keinem Zeitpunkt Wave-Zustand gekostet.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W7-F1 — Das Permission-Gate kann einen Background-Subagent töten; die Fehlermeldung ist leer.**
FOR-34s Reviewer starb 82 Log-Zeilen tief, mitten in einer vorbildlichen Live-Repro: ein `chmod 755` auf ein selbst angelegtes Scratchpad-Fixture wurde vom Gate abgelehnt („The user doesn't want to proceed… / Request interrupted") → Agent tot, Pipeline-Row → `null`. Zwei Kanten daran: (a) ein Background-Agent kann nicht nachfragen — die Ablehnung ist für ihn terminal; (b) der Workflow meldete nur `pipeline[0] failed:` **mit leerer Message** — die Diagnose gelang erst über `journal.jsonl` + das Agent-Transkript. Die Recovery (Resume, Reviewer-only, kein Cap) war billig, *weil* Scribe-WAL + Journal den Zustand trugen. **Ableitung (Betriebsnotiz + Runbook-Kandidat, kein Engine-Ticket):** nach jedem Workflow mit `agents_error > 0` zuerst das Journal lesen, dann Resume erwägen; Reviewer-Briefs können Scratch-Fixtures so bauen, dass keine chmod/Ownership-Spiele nötig sind. Die leere Fehlermeldung ist eine Harness-Kante, kein flotilla-Verb.

**W7-F2 — Der Mention-Footgun biss in der Wave, die ihn dokumentiert — Brief-Verbote schützen nicht, der Review-Gate tut es.**
FOR-36s Worker schrieb „FOR-30" in seinen PR-Body, obwohl der Brief das Verbot explizit trug **und** der Worker es sich selbst als Reviewer-Focus-Item #4 notierte („confirm no other issue id…"). Alle ACs waren met — das `changes-requested` kam allein aus dem Focus-Item. Bemerkenswert dreifach: die Schwester-Row (FOR-37) machte die Disziplin zeitgleich zur wave-shared-Konvention; der Fund beweist, dass die Konvention einen *prüfenden* Gegenpart braucht (der Reviewer-Check „no foreign ids in PR title/body" gehört in jede Review — hier stand er im Brief und trug); und die Recovery zeigte die minimal-invasive Form (PR-Metadaten via Host-API, kein Commit, kein Branch-Touch).

### 🟢 KLEIN / Wiederholungen

**W7-F3 — 5. Repro deregister-despite-failed-rm — beim Cleanup der Wave, die den Fix trägt.** Phase 3 (Cleanup vor Merge, W3-F3-Ordnung) lief protokollgemäß mit der Pre-FOR-34-Engine: FOR-34s eigener Worktree schlug mit „Directory not empty" fehl, git deregistrierte trotzdem, 1,4-MB-Orphan blieb (Hand-`rm`, Sandbox aus). Minuten später mergte der Fix. Der nächste `wave-close` läuft erstmals mit dem atomaren Verb — **Watch-Item für w8**.

**W7-F4 — `host-pr merge`-Response trägt kein `merged`-Feld; der Koordinator-Parser riet und log falsch.** Die Merge-Antwort (`prUrl`, `sha`, `reason`) wurde vom Ad-hoc-Parser als „NOT-MERGED" gedruckt, obwohl alle vier Merges saßen; `host-pr status --branch` (state: `merged`) klärte es. Dieselbe W6-F1-Figur in klein: nicht das Echo interpretieren, den Zustand zurücklesen. Doku-Kandidat: close-mechanics nennt das Response-Shape (kann in FOR-27 aufgehen).

**W7-F5 — Stale-LSP-Flut nach Worktree-Removal (3. Wiederholung, W4-F8/W6-F5).** Nach dem Cleanup flutete die IDE „Cannot find module"-Fehler aus den gelöschten Checkouts. Beleg bleibt `tsc` (0 auf `main`), nie das Panel.

**W7-F6 — `merge-order`s `.scratch`-Warning + `fileCount: 0` (W4-F9/W6-F6-Wiederholung).** Unverändert kosmetisch, unverändert Teil der getrackten Ur-Entkopplung.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W7-F1** — Permission-Gate tötet Background-Agent; leere Pipeline-Fehlermeldung; Resume-Recovery | 🟡 | Betriebsnotiz + Runbook-Kandidat (Harness-Kante, kein Engine-Defekt; Resume-Pfad hat sich bewährt) |
| **W7-F2** — Mention-Footgun trotz Brief-Verbot; Reviewer-Gate fing ihn | 🟡 | Keine — die Konvention landete in derselben Wave (FOR-37); der prüfende Reviewer-Check ist Teil der Briefs |
| **W7-F3** — 5. Orphan-Repro beim eigenen Cleanup | 🟢 | Durch FOR-34 (in dieser Wave gemergt) strukturell geschlossen; w8-Close ist das Live-Gate |
| **W7-F4** — `host-pr merge`-Response-Shape ungeraten | 🟢 | Betriebsnotiz; Doku-Beifang für FOR-27 |
| **W7-F5** — Stale-LSP ×N | 🟢 | Bekannt; Editor-Excludes + `tsc`-Disziplin |
| **W7-F6** — `.scratch`-Warning | 🟢 | Teil der getrackten Ur-Entkopplung (W4-F9) |

## 4. Lauf-Metriken (grob)

- **Rows:** 4 (paralleler Fan-out, Conflict-Map ∅). **Verdicts:** 3× `approve` (iter 1) + 1× `changes-requested` → **cap=1-Re-Dispatch → `approve` (iter 2)**. **STOPs:** 0 (keine public-API-Row). **Agents:** 15 im Haupt-Workflow (4 Worker + 4 Report-Scribes + 4 Reviewer + 3 Verdict-Scribes; 1 Fehler = W7-F1) + 2 live im Resume + 2 inline (Iter-2-Worker/-Reviewer) = **19, davon 1 Fehler**; ~28,5 min + ~7,7 min + ~1,5 min; ~1,99 Mio. Subagent-Tokens, ~467 Tool-Calls.
- **Modelle:** 4× sonnet-Worker (alle Rows mechanical/isolated-refactor), Scribes haiku, Reviewer sonnet.
- **PRs:** #38 (FOR-34) → #36 (FOR-36) → #35 (FOR-37) → #37 (FOR-38) — advisory Order eingehalten; alle squash; alle vier Remote-Branches gelöscht **und verifiziert** (0 überlebende `wave/*`-Heads). `main`: `a3862b3 → 99ebf73`.
- **Tests:** FOR-34 1429 (+6) · FOR-36/37 je 1423 (docs-only) · FOR-38 1437 (+14) · **gemergter `main` 1443 = 1423 + 6 + 14, exakt die Vorhersage** · `tsc --noEmit` überall 0. Anchor-Baseline 1423.
- **ACs:** 12 über 4 Rows — **alle 12 `met` in Runde 1**; das eine `changes-requested` kam aus einem Blocking-Focus-Item (PR-Metadaten), nicht aus einer AC-Verfehlung. **Sidecars:** 10 (inkl. 2× Iter-2). **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen (Routing/Schema/WAL):** 0 — dazu 1 Infrastruktur-Recovery (Resume nach W7-F1) und 1 manuelle Orphan-Räumung im Close (W7-F3).
- **Backlog danach:** 12 offen (FOR-16/17/20/27/28/30/35 + **FOR-39…43**, die W8-Publication-Tickets), alle unblockiert.

## 5. Meta-Reflexion

Die Fehlerklasse dieses Laufs war zum ersten Mal **weder Engine noch Koordinator-Kleber, sondern Harness-Infrastruktur** — ein Permission-Gate, das einen Agenten tötet, und eine leere Fehlermeldung darüber. Dass die Recovery sieben Minuten kostete statt einer Runde, liegt an drei Dingen, die die letzten Wellen gebaut haben: die Scribes hatten jeden Zustand schon auf Platte, das Journal machte den Tod diagnostizierbar, und das Resume ersetzte exakt einen Agenten. Die w6-These („Kleber in die Schienen ziehen") bekommt damit ein Korollar: **auch gegen Infrastruktur-Ausfälle ist die beste Verteidigung, dass die Schienen den Zustand tragen.**

Und die Selbst-Konsum-Zirkularität hatte ihren bisher dichtesten Moment: FOR-34 wurde beim Landing **vom eigenen Bug gebissen** (5. Repro, Minuten vor dem Merge des Fixes), FOR-36s Merge-Sequenz wurde beim eigenen Close **erstmals als dokumentierte Routine befolgt**, und FOR-37s Disziplin wurde in derselben Stunde gebrochen (W7-F2), gefangen und kanonisiert. Das System testet seine Fixes inzwischen zuverlässig an sich selbst — im Guten wie im Peinlichen.

**Vorwärts-Zeiger:** Das Quartett war die letzte Härtungs-Wave vor dem Cut (ADR-0026). Als Nächstes: **W8, die Publication-Wave** (FOR-39…43 — De-Clienting, README/Onboarding, Denylist-Gate, Prune; die letzte private Wave), dann der Cut-Runbook-Tanz. Watch-Items für w8: der erste Close mit dem **atomaren `worktree-cleanup`** (FOR-34s Live-Gate) und der erste `wave-plan` mit **`cross-wave` fail-loud** (FOR-38s Live-Gate).
