# flotilla — Retrospektive: Wave 2 „2026-07-16-hardening-w2" (dritter Live-Lauf)

Wave: `2026-07-16-hardening-w2` · Rows: **FOR-8, FOR-12, FOR-15, FOR-18** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `c01d34c`.

## 0. Ergebnis in einem Satz

Wave 2 landete end-to-end sauber — paralleler Fan-out (4 Rows) → nach einer Recovery-Schleife **4× `approve`, 0 changes-requested, 0 STOP** → 4 squash-PRs (#8–#11) auf `main` (`c01d34c → 4dd860a`) → **alle 4 Linear-Issues auto-`Done`** — **aber** die erste Review-Runde produzierte zwei `questions-blocking` durch einen **vom Coordinator selbst eingebauten Dispatch-Brief-Bug** (`anchorSha` nicht verdrahtet → Briefs sagten wörtlich `"undefined"`), sauber recovered via Reviewer-Re-Dispatch mit korrektem Anchor.

## 1. Was richtig gut funktioniert hat

- **Schema-Boundary + deterministisches Routing hielten** — auch unter dem Bug. Alle 4 Worker lieferten schema-validierte `WorkerReport`s, alle Reviewer schema-validierte `ReviewerVerdict`s. Der Bug erzeugte kein falsches Grün: die Reviewer erkannten den kaputten Input *strukturell* (malformed required input) statt ihn zu raten.
- **Erste echte Wave mit befülltem Dispatch-Log (FOR-5).** Alle 4 Branches wurden spine-first ins `## Resume-Metadata` → `dispatch-log:` geschrieben (`renderSpine` scaffoldet den Key, `spine set-branch` befüllt ihn). Der durable Row→Worktree-Link existiert damit erstmals in einem realen Lauf — die Write-Seite von ADR-0021 ist bestätigt. (Die Read-Seite, `resume()`, wurde nicht ausgelöst — kein Coordinator-Tod.)
- **Reviewer-Tiefe übertraf den Report — erneut.** Die (re-dispatchten) FOR-8- und FOR-15-Reviewer re-installierten `node_modules` in Wegwerf-Worktrees und liefen `vitest`+`tsc` **unabhängig** gegen die (korrekte) Anchor-SHA. FOR-15s Erst-Review hatte *bewusst* deferred (kaputter Anchor) statt zu raten — der Re-Review holte die unabhängige Verifikation nach (1163/1163, tsc 0).
- **Cross-Wave-Disjunktheit bestätigt** (`intraWaveConflicts=∅`). Alle Sibling-`merge-tree`-Checks: 0 Konflikt-Marker; 4 Changesets file-disjunkt wie von `wave-create` vorhergesagt. Merge in beliebiger Reihenfolge, alle `mergeable_state=clean`.
- **Reviewer fing Report-Prosa-Ungenauigkeit, die die Schema-Totals nicht fangen.** FOR-8-Worker meldete „+19 neue Cases" (real 15 neue `it()`-Blöcke, 7+15=22 = File-Total). Die gate-relevanten Totals (1169, 22 in `cross-wave.spec.ts`) stimmten exakt.
- **Linear Auto-`Done` via `Fixes FOR-N`.** Alle 4 PR-Bodies trugen die store-korrekte Close-Phrase (Convention 4) → alle 4 Issues schlossen beim Merge automatisch auf `Done`. Kein manueller Panel-Move.
- **FOR-18 gelandet ⇒ w1-Fund F1 ist code-seitig gefixt.** `close()` ist jetzt in `wave-close`/`wave-resume` done-reconcile verdrahtet (der operativ-tote doneState-Fallback hat wieder einen Trigger). Siehe aber §2/W2-F1b (FOR-13 ist noch stale).

## 2. Funde (nach Schwere)

### 🟠 HOCH

**W2-F1 — Coordinator-Dispatch-Brief-Bug: nicht-verdrahtetes `anchorSha` → `"undefined"` erreichte die Agents.**
Im Workflow-Driver war `const ANCHOR = 'c01d34c…'` definiert, aber **nie als `anchorSha` in die `ISSUES`-Objekte gesetzt** — `workerBrief`/`reviewerBrief` referenzieren `issue.anchorSha`, das war `undefined`, und die Template-Literale interpolierten den String `"undefined"` als Diff-Basis. **Wirkung asymmetrisch:** Worker überlebten (frischer Worktree-HEAD = Anchor, sauberer Baum → korrekt gearbeitet, alle Branches korrekt an `c01d34c`); **Reviewer** behandelten `undefined..origin/<branch>` korrekt als malformed required input → 2 spurious `questions-blocking` (FOR-8 reviewte trotzdem voll durch und erschloss den Anchor aus `git log`; FOR-15 stoppte per Contract hart und deferred alles). **Kosten:** eine komplette Re-Review-Runde. **Recovery** (protokoll-sauber): Reviewer mit korrektem Anchor neu dispatcht — **kein** Worker-Re-Dispatch, **kein** cap verbraucht (der Erst-Fehler war Coordinator-Input, nicht Branch-Defekt) → beide `approve`. **Empfehlung:** eine **Compose-Zeit-Assertion** im Driver (throw, wenn ein `issue.anchorSha` falsy oder `=== 'undefined'`) fängt genau diese Klasse *vor* dem Fan-out statt beim Reviewer. → **Ticket-Kandidat** (§3).

### 🟡 MITTEL

**W2-F1b — FOR-13: stale `in-flight` löste sich während des Laufs selbst auf; die Closing-Probe kann das `done` aber nicht erklären.**
`listClaimed` zeigte mitten im Lauf **FOR-13 → `in-flight`** — ein Residuum aus Wave 1 (PR gemergt, Rung nie reconciled, weil zur w1-Zeit kein Skill `close()` rief). **Am Ende der Session stand FOR-13 auf `done`** (verifiziert; `listClaimed` danach leer). **Der Auslöser ist unbestätigt** — flotilla hat FOR-13 nirgends angefasst (nicht in dieser Wave, kein `transition`/`close`-Call). Plausibelste Hypothese: der PR-Body/Titel von **#9 nennt „FOR-13" wörtlich** („…done-reconcile (FOR-13 e2e)"), und Linears GitHub-Integration verlinkt erwähnte Issue-IDs — der Merge könnte die *erwähnte* Issue mitbewegt haben; alternativ hat die w1-Integration schlicht verspätet nachgezogen. Nicht abschließend geklärt.

**Der eigentliche Fund liegt darunter:** `issue-store read-closing FOR-13` liefert **`{"state": "closed-unmerged"}`** — die Linear-Closing-Probe (ADR-0020: GitHub-Integration-Attachment + `Fixes FOR-N`) findet **kein gemergtes PR-Attachment** und kann die Done-heit damit keinem Merge zuordnen. `wave-close` Phase 5 flaggt `closed-unmerged` aber als `recoverable-stop` („PR was closed without merging — reopen, re-dispatch, or abandon?"). **Ein legitim gemergtes/erledigtes Issue, dessen Close nicht über den `Fixes`-Attachment-Pfad lief, würde also spurious als `needs-attention` geflaggt** — die Probe konflatiert „closed ohne merged-PR-Attachment" mit „PR abgelehnt". Zwei Ableitungen: (a) die Probe/Phase-5-Regel braucht eine Unterscheidung `closed-unmerged` vs. `closed-without-pr-evidence`; (b) **Footgun für PR-Bodies:** eine fremde Issue-ID im Titel/Body kann den Tracker auf *diese* Issue wirken lassen — Convention 4 regelt nur die Close-Phrase, nicht die bloße Erwähnung. → **Ticket-Kandidat** (§3).

**W2-F2 — `merge-order`-Advisory lief zur Close-Zeit auf der alten Engine → `branch:null` (der FOR-15-Bug, live demonstriert).**
`wave-close` rief `merge-order` **bevor** FOR-15 gemergt war → alle Rows kamen mit `branch:null` zurück (das Ur-gekoppelte `extractSpineBranches` liest den Linear-Dispatch-Log nicht). Für uns unkritisch (advisory + disjunkt), aber ein sauberer Live-Beleg. **Nach** dem FOR-15-Merge liefert dieselbe archivierte Spine die **echten** Branches (`wave/FOR-8-…` etc., `notInPlay: []`, `warnings: []`) — Before/After im Lauf verifiziert. → **FOR-15 gelandet, F2 geschlossen** (kein neues Ticket). Rest-Notiz: FOR-15 fixte den *spine-self-contained* Pfad (`buildSpinePrs`); das `.scratch`/Ur-numerische `extractSpineBranches` bleibt für den Fallback-Pfad gekoppelt — separat getrackt, nicht in dieser Wave.

### 🟢 NIEDRIG / Umgebung

**W2-F3 — Worker-Report-Prosa-Genauigkeit (wieder, wie w1-F4).** FOR-8 „+19" statt 15 neue `it()`-Blöcke. Schema-Totals + AC-Evidenz stimmten; nur der Freitext-Breakdown driftete, vom Reviewer gefangen. Optional: Self-Consistency-Hinweis im Worker-Brief.

**W2-F4 — Umgebung: Linear-über-Proxy langsam + gh scheitert an Proxy-TLS.** Linear-Writes über den Sandbox-Proxy (`NODE_USE_ENV_PROXY=1`) brauchten 30 s–5 min → alle Rung-Transitions mussten in den Hintergrund; `gh` (GraphQL **und** REST) scheiterte am MITM-Cert des Proxys (`OSStatus -26276`) → Sandbox nur für gh-Netz aus. Reiht sich in **FOR-12** (proxy-sandbox-doc) ein und gehört ins Coordinator-Runbook. Zusatz: die Engine-CLI per `npx tsx` hat ~8 s Cold-Start pro Call → das lokale `tools/wave/node_modules/.bin/tsx` + eine Shell-Funktion nutzen (zsh macht keine Wortteilung auf `$VAR`, Arrays 1-indiziert; `timeout` fehlt auf macOS). Als Session-Memory festgehalten.

**W2-F5 — Permission-Gates feuerten korrekt (2×), beide richtig eskaliert.** (a) Merge in protected `main` wurde geblockt (Freigabe nur von den KI-Reviewern, kein Mensch) → durch explizites User-„ja" gelöst. (b) `git reset --hard origin/main` wurde geblockt (Sorge um lokalen Spine-Verlust) → **verifiziert unbegründet**, da `.flotilla/` gitignored ist (reset fasst nur getrackte Dateien an; Spine + 8 Sidecars blieben intakt). Beide nicht umgangen, sondern eskaliert. Runbook-Notiz: `.flotilla/` gitignored ⇒ `reset --hard` ist für Spine-State sicher.

**W2-F6 — Verwaiste Worktree-Dirs nach dem Cleanup.** `worktree-cleanup` **deregistrierte** die 4 git-Worktrees (`git worktree list` → nur `main`), konnte die **physischen Dirs** aber nicht löschen (`Operation not permitted` — Sandbox blockt Schreibzugriff auf `.claude/worktrees/`) → 4 Orphan-Dirs blieben. Behoben durch Gitignore von `.claude/worktrees/` (dieser PR); physische Löschung ist ein manueller/sandbox-off-Schritt.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W2-F1** — Compose-Zeit-`anchorSha`-Assertion im Workflow-Driver | 🟠 | **NEU** — zu filen (Driver fail-loud statt Reviewer-spät) |
| **W2-F1b** — FOR-13 stale `in-flight` | 🟡 | **erledigt** — steht auf `done` (Auslöser unbestätigt, s. o.); keine Disposition nötig |
| **W2-F1c** — Closing-Probe: `closed-unmerged` ⇒ spurious `needs-attention` für legitim erledigte Issues; + Footgun „fremde Issue-ID im PR-Titel/Body" | 🟡 | **NEU** — zu filen (Probe-Semantik trennen + Convention-4-Notiz) |
| **W2-F2** — `merge-order` Linear-Branches | 🟡 | **FOR-15 gelandet** (F2 geschlossen); `.scratch`-Fallback separat getrackt |
| **W2-F3** — Worker-Report-Prosa | 🟢 | optional, nicht gefiled |
| **W2-F4** — Sandbox-Proxy (Linear/gh) + CLI-Cold-Start | 🟢 | **FOR-12** (+ Session-Memory) |
| **W2-F5** — Permission-Gates | 🟢 | funktionierte; Runbook-Notiz |
| **W2-F6** — Orphan-Worktree-Dirs | 🟢 | **dieser PR** (`.claude/worktrees/` gitignored) |

## 4. Lauf-Metriken (grob)

- **Rows:** 4 (paralleler Fan-out, kein Smoke-Test). **Verdicts:** erste Runde 2× `approve` (FOR-12/18) + 2× `questions-blocking` (FOR-8/15, anchorSha-Bug); nach Re-Review **4× `approve`**, 0 changes-requested, 0 STOP. **cap=1 Re-Dispatch:** nie ausgelöst.
- **Agents:** 8 (4 Worker + 4 Reviewer) im Haupt-Workflow + 2 Re-Review-Reviewer = 10. **Fehler:** 0.
- **PRs:** #10 (FOR-8), #8 (FOR-12), #11 (FOR-15), #9 (FOR-18) — alle squash-merged, alle Branches gelöscht. `main`: `c01d34c → 4dd860a`.
- **Test-Totals (unabhängig re-verifiziert):** FOR-8 1169 · FOR-12 1180 · FOR-15 1163 · FOR-18 1157 · `tsc --noEmit` 0 überall.
- **Linear:** alle 4 auto-`Done` bei Merge.
- **Manuelle Kern-Dispatch-Interventionen:** 0 (der Bug war Coordinator-Compose, nicht Dispatch; Recovery automatisch). **Coordinator-Tode:** 0.

## 5. Meta-Reflexion

Der dritte Live-Lauf zeigt zwei Dinge. Erstens: **die Schema-Boundary schützt auch gegen den Coordinator selbst.** Ein kaputter Dispatch-Input (`anchorSha="undefined"`) wurde nicht in ein falsches Grün gewaschen — die Reviewer erkannten den malformed Input strukturell und eskalierten, statt zu raten; die Recovery kostete eine Runde, aber kein falsches Ergebnis. Genau dafür gibt es die typed boundary. Zweitens: **die schärfsten Funde sind Meta-Funde über den Coordinator und den Ledger, nicht über die Rows** — W2-F1 (Compose-Zeit-Bug) und W2-F1c (eine Probe, die einen legitimen Close nicht erklären kann und ihn deshalb als Ablehnung flaggen würde) betreffen beide das Orchestrierungs-Layer, nicht die Worker-Arbeit. Das Muster aus w1 hält und verschiebt sich: *eine Fähigkeit ohne Trigger* (w1-F1: `close()` gebaut, nie gerufen — jetzt via FOR-18 gefixt) wird abgelöst von *ein Input ohne Guard* (W2-F1: `anchorSha` gefordert, nie assertiert) und *ein Zustand ohne Beleg* (W2-F1c: `done` ohne Attachment ⇒ die Probe rät „abgelehnt"). Alle drei sind Naht-Probleme: die Compose-Grenze und die Tracker-Grenze brauchen fail-loud-Prüfungen bzw. ehrlichere Zustands-Klassen — dort ist die nächste Härtung billiger als downstream. Bezeichnend auch: **FOR-13 wurde `done`, ohne dass flotilla es angefasst hat** — der Tracker ist eine Umwelt mit eigener Kausalität (Integrationen, Erwähnungen, Verzögerungen), kein passiver Speicher; die abgeleiteten Bookends (`available`/`done`, ADR-0002) müssen genau deshalb robust gegen Zustände sein, die flotilla nicht selbst verursacht hat.
