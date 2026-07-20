# flotilla — Retrospektive: Wave 10 „2026-07-20-evidence-polish" (elfter Live-Lauf)

Wave: `2026-07-20-evidence-polish` · Rows: **FOR-17, FOR-20, FOR-45, FOR-46, FOR-47** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `6512415` → `main` nach dem Close: `cc18f4a`.

Besonderheit dieses Laufs: **das erste Roster mit leerer Conflict-Map** — bewusst als maximales unabhängiges Set aus dem Konfliktgraphen gezogen — und darauf **der erste `wave-close --auto`** (ADR-0023 Partial-Arm). Dazu drei weitere Premieren im selben Lauf: der **erste Live-G3-STOP** (public-API-Freigabe am Verdict-Routing), das **`host-pr create`-Terminator-Debüt** (alle fünf PRs über den Engine-Seam geöffnet) und das **`verdict-acked`-Debüt** im Done-Reconcile — das Verb, das eine Row dieser Wave selbst gebaut hat.

## 0. Ergebnis in einem Satz

Wave 10 lief den vollen Zyklus `wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — 5er-Fan-out → **5× `approve` in Runde 1, 0 Re-Dispatches, 20/20 Agents, 0 Fehler, ein planmäßiger G3-STOP (public-API-Freigabe, aufgelöst)** → Partial-Arm-Confirm (eine Tabelle, ein Klick, ehrliche No-CI-Ansage) → 5 PRs #9/#10/#8/#6/#7 gelandet (1× arm-Direkt-Merge, 1× Retry-Merge, 3× `host-pr merge` nach `refused` — der Fund des Laufs) → `main 6512415 → cc18f4a`, Gate **1487 Tests (+30) / tsc 0** → Done-Reconcile 5× `merged` via Tracker-Attachment mit **maschinell abgeleiteten `--acked`-Sets** → Archiv plain-mv, Claim-Ledger leer.

## 1. Was richtig gut funktioniert hat

- **Konflikt-Topologie als Planungswerkzeug.** Das Roster war kein Zufall, sondern das errechnete maximale unabhängige Set des Backlog-Konfliktgraphen (5 von 9 Kandidaten, null Zellen). Alle fünf Reviewer bestätigten unabhängig per `git merge-tree`: keine Kollision, in keiner Paarung. Die Merges komponierten additiv bis in die Testzahlen (1457 + 5 + 20 + 5 = 1487) — das Planungsversprechen „disjunkt heißt ordnungsfrei landbar" hielt bis zum Schluss.
- **Der G3-Gate-Ernstfall lief lehrbuchmäßig.** FOR-20s `approve` mit `riskClass: public-API-change` stoppte am Verdict-Routing (`public-api-approval-required`), wurde geflaggt, dem Menschen mit Verdict-Evidenz vorgelegt, freigegeben, Flag gecleart, Terminator angewendet. Und beim Landing kam **kein zweites Risk-Gate** — exakt die ADR-0023-Arbeitsteilung („die public-API-Frage wurde am Routing schon beantwortet").
- **`host-pr create` trug den ganzen Fan-out.** Fünf PRs, fünf `outcome: created`, null `gh` im Dispatch-Pfad; `prTitle`/`closePhrase` kamen Coordinator-geliefert (der Worktree hat keinen Store-Config), und die Mention-Disziplin wurde von den Reviewern mechanisch verifiziert (Regex über Titel+Body via API: exakt eine bare Id pro PR, die Close-Phrase).
- **Die `--auto`-Confirm war ehrlich statt bequem.** Linear-Store → `allow-auto-merge`/`required-checks` als `not-applicable` ausgewiesen, Posture „per-PR at arm time", und die Ansage **„keine Required Checks — Bestätigen heißt sofortiger Merge"** stand wörtlich im Confirm. Ein Klick pro Wave, dann Arm-and-Exit ohne Polling — und der Refused-Pfad (unten) lief mit klarer `reason` und den dokumentierten Optionen, nicht als Ratespiel.
- **`verdict-acked` schloss W9-F4 im Debüt.** Alle fünf `--acked`-Sets kamen maschinell aus den Verdict-Sidecars (5/7/4/3/4 Met-Indexe) — kein manuelles Verdict-Ablesen mehr; das Motivations-Beispiel aus dem letzten Retro war zugleich der erste Produktionseinsatz des Fixes.
- **Der Store-Preflight meldete die Linear-Integration erstmals als echten Probe-PASS** („a merged PR creates the closing attachment") — was W9 nur empirisch wusste, ist jetzt eine geprüfte Precondition.
- **Selbstreparatur-Disziplin, dritte Iteration:** merge → pull-to-completion (sandbox-off, `rev-parse`-verifiziert) → reconcile. Der Reconcile lief mit der Engine, die die Wave selbst gebaut hat — inklusive des `verdict-acked`-Verbs aus Row 1.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W10-F1 — Partial-Arm degeneriert auf einem Allow-auto-merge-OFF-Repo: nach dem ersten Merge liest jeder weitere PR „behind/recomputing" und `arm` verweigert.**
Der erste saubere PR (#9) wurde von `host-pr arm` korrekt direkt gemergt. Damit kippten die vier übrigen — obwohl datei-disjunkt und konfliktfrei — für GitHub kurzzeitig auf behind/recomputing, `arm` nahm den Auto-Merge-Pfad, und das Repo verweigerte: **„The repository does not permit auto-merge"** (`refused` ×4). Ein idempotenter Retry landete #10 (im Fenster wieder clean); #8/#6/#7 gingen über `host-pr merge` — die „merge-by-hand"-Option des dokumentierten Refused-Pfads, hier durch den Wave-Confirm vorautorisiert. Wichtig: **der Preflight konnte das Setting nicht sehen** (`not-applicable` auf einem Linear-Store — die ADR-0023-Blindstelle, wie designed; das Arm-Outcome ist die Ground Truth). Zwei Auswege, beide human-entscheidbar: (a) **„Allow auto-merge" im Repo aktivieren** — dann armt ein checks-pending-PR echt, und ein cleaner merged direkt; (b) **Engine-Design-Frage**: soll `arm` bei `refused` + mergeable auf Direkt-Merge zurückfallen? Das verwässert möglicherweise die Arm-Semantik (der Aufrufer bat um *arm intent*, nicht um *merge now*) — Ticket-Kandidat, vorher kurz grillen.

### 🟢 KLEIN / Wiederholungen

**W10-F2 — Der alte Cleaner scheiterte erwartungsgemäß erneut (ENOTEMPTY ×5).** Self-Repair-Klassiker in Reinform: der Fix (Junk-Toleranz + Retry) landete *in dieser Wave* (#8), aber der Close lief noch mit der Vor-Wave-Engine — manuelles `rm -rf` mit Sandbox-off, wie im Skill dokumentiert. **Der nächste wave-close ist das Live-Gate für den Fix.**

**W10-F3 — Cross-Row-Nachzügler, diszipliniert liegengelassen:** das neue `verdict-acked`-CLI-Verb hat keinen direkten cli.spec-Test (Primitive einzeln getestet, Komposition manuell verifiziert); `wave-shared`/`wave-resume` rufen `close` noch ohne `--acked` (der Resume-Pfad-Tick fehlt); und `close-mechanics.md` dokumentiert noch die 3-State-`ClosingState`-Form ohne `closed-unknown` — pikanterweise die Doku exakt der Semantik, die FOR-20 in derselben Wave erweitert hat. Alle drei von Workern/Reviewern selbst geflaggt, alle out-of-scope der jeweiligen Files-Globs. Ticket-Kandidaten.

**W10-F4 — Wiederholungen:** die `.scratch/`-Legacy-Warning feuerte im `merge-order`-Lauf (ihr Killer FOR-48 war zum Zeitpunkt schon gefiled und wartet im Backlog); Stale-LSP-Flut nach Worktree-Removal (6. Mal).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W10-F1** — Arm-Sequencing auf Allow-auto-merge-OFF-Repo | 🟡 | Human-Entscheid: Repo-Setting aktivieren; parallel Ticket-Kandidat „arm-Fallback refused+mergeable→direct-merge" (erst grillen) |
| **W10-F2** — Alter Cleaner ENOTEMPTY ×5 | 🟢 | Fix bereits gelandet (in dieser Wave); nächster Close = Live-Gate |
| **W10-F3** — verdict-acked cli.spec · Resume-Pfad-`--acked` · stale ClosingState-Doku | 🟢 | Ticket-Kandidaten (gesammelt filen) |
| **W10-F4** — `.scratch/`-Warning · Stale-LSP ×6 | 🟢 | Ersteres: Killer bereits gefiled (Backlog); Letzteres bekannt |

## 4. Lauf-Metriken (grob)

- **Rows:** 5 (paralleler Fan-out, **Conflict-Map ∅ — Premiere**). **Verdicts: 5× `approve` in Runde 1** — 0 `changes-requested`, cap=1 unberührt, **1 STOP: der erste Live-G3** (`public-api-approval-required`, aufgelöst per Human-Freigabe + clear-flag). **Agents:** 20/20 (5 Worker + 5 Report-Scribes + 5 Reviewer + 5 Verdict-Scribes), **0 Fehler**; ~36 min; ~1,32 Mio. Subagent-Tokens, 498 Tool-Calls.
- **Modelle:** 1× opus-Worker (public-API), 4× sonnet-Worker, Scribes haiku.
- **Landing (erster `--auto`):** Confirm-Table → Arm aller 5 order-free Rows → #9 `merged` (arm, direkt), #10 `merged` (arm-Retry), #8/#6/#7 `merged` (`host-pr merge` nach `refused`, vorautorisiert). Alle 5 Branches gelöscht **und verifiziert** (0 Überlebende). `main`: `6512415 → cc18f4a`.
- **Tests:** 1457 → **1487** (+30: Konformanz-Block closed-unknown +20, verdict-acked-Specs +5, Cleanup-Härtung +5) · `tsc` 0 · additiv komponiert, auf dem gemergten Tip re-verifiziert. **ACs: 23 über 5 Rows — alle 23 `met` in Runde 1.** **Sidecars:** 10, at-agent-return. **Done-Reconcile:** 5× `merged` via Tracker-Attachment (Tier 1), `--acked` maschinell. **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen:** 0 (siebter Lauf in Folge).
- **Backlog danach:** 4 offen (FOR-16/30/35/48, alle unblockiert; Hub FOR-16 mit 2 Zellen) + die W10-Ticket-Kandidaten.

## 5. Meta-Reflexion

Diese Wave hat die Landungsautomatik getestet, indem sie sie **benutzt** hat — und der einzige Reibungspunkt war keine Engine-Lücke, sondern eine Repo-Setting-Realität, die genau an der Stelle sichtbar wurde, die ADR-0023 als bewusste Blindstelle dokumentiert („Posture per-PR at arm time; das Arm-Outcome ist die Ground Truth"). Dass der Refused-Pfad dann mit klarer Reason und den vordokumentierten Optionen auffing, statt zu raten oder zu blockieren, ist der eigentliche Reifegrad-Beweis: **das System degradierte kontrolliert, nicht chaotisch.**

Die zweite Erkenntnis ist die Verdichtung der Feedback-Schleife: ein Fund aus dem W9-Retro (`--acked` von Hand) wurde am selben Tag als Issue gefiled, in der nächsten Wave gebaut und **im Close derselben Wave produktiv benutzt**. Retro → Ticket → Build → Einsatz in unter einem Tag — der Kreislauf, für den die Pipeline gebaut wurde, dreht jetzt in Tagesfrequenz. Und das dritte Muster wiederholt sich zum dritten Mal, jetzt mit Namen: **eine Wave, die ihr eigenes Werkzeug verbessert, testet es frühestens beim nächsten Lauf** — der Cleaner-Fix aus #8 wartet auf den nächsten Close, wie `--auto` auf diese Wave gewartet hat.

**Vorwärts-Zeiger:** Der Allow-auto-merge-Entscheid (Setting vs. arm-Fallback-Grill) vor dem nächsten `--auto`-Lauf; das Rest-Roster FOR-16/30/35/48 um den Hub FOR-16 schneiden; die W10-F3-Nachzügler filen. Watch-Items: der erste Close mit dem gehärteten Cleaner (W10-F2), und ob ein aktiviertes Allow-auto-merge den Arm-Pfad für N>1 wirklich durchgängig macht.
