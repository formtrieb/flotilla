# flotilla — Retrospektive: Wave 4 „2026-07-16-hardening-w4" (fünfter Live-Lauf)

Wave: `2026-07-16-hardening-w4` · Rows: **FOR-22, FOR-23, FOR-24, FOR-26** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `5867eaa`.

## 0. Ergebnis in einem Satz

Wave 4 lief den **vollen Zyklus zum ersten Mal in einer Sitzung durch** — 4er-Fan-out → **4× `approve`, 0 changes-requested, 0 Re-Dispatch, 0 manuelle Kern-Dispatch-Interventionen** → zwei protokollgemäße `public-API-change`-STOPs → 4 squash-PRs (#18/#20/#19/#21) auf `main` (`5867eaa → c03bc31`, 1370 Tests) → alle 4 Rows `done` → Spine archiviert — und **W3-F1 wurde in derselben Sitzung repariert *und* live bewiesen**: `read-closing` meldete nach dem Merge für alle vier Rows korrekt `merged`, wo dieselbe Probe eine Stunde zuvor viermal `closed-unmerged` gelogen hätte. Der Preis dafür war eine neue Erkenntnis über die Reihenfolge (W4-F1).

## 1. Was richtig gut funktioniert hat

- **FOR-23s Fix im selben Lauf gebaut, gemergt und benutzt.** Die Wave reparierte die Closing-Probe, auf der `wave-close` Phase 5 steht — und schloss sich anschließend mit dem eigenen Fix. `read-closing` lieferte für alle vier Rows `{"state":"merged"}` mit korrekter PR-URL. W3-F1 ist damit nicht nur gefixt, sondern **am schärfstmöglichen Fall verifiziert**: an genau den Rows, die der Bug betroffen hätte.
- **Der zweite Lauf ohne Reibung im Kern-Dispatch.** 8 Agents, 0 Fehler, 0 manuelle Interventionen, cap=1 nie ausgelöst, kein Coordinator-Tod. Wie w3 liegen sämtliche Funde **außerhalb** des Fan-outs.
- **Die w3-Empfehlung wurde vor ihrem Ticket angewandt und wirkte — für die vier Wave-Branches.** w3 leitete ab: „Worktree-Cleanup **vor** die Merges ziehen". FOR-25, das das baut, liegt noch im Backlog; der Coordinator zog die Phasenreihenfolge trotzdem von Hand vor. Ergebnis: `gh pr merge --squash --delete-branch` löschte **alle vier Remote-Branches sauber** (0 verblieben). Das ist das zweite Mal in Folge, dass eine Retro-Empfehlung *vor* ihrer Umsetzung als Ticket gewirkt hat (w3 tat dasselbe mit FOR-19s Assertion). **Aber:** die Empfehlung beseitigte nur *eine* Ursache, nicht den Mechanismus — beim Merge des Retro-PRs #22 wenige Minuten später trat W3-F3 doch auf (→ **W4-F11**). Die erste Fassung dieses Retros schloss daraus „nicht reproduziert"; das war zu breit und ist hiermit korrigiert.
- **Der `public-API-change`-STOP feuerte zweimal korrekt (G3-Guard).** FOR-23 und FOR-24 liefen **nicht** still in den Auto-PR, sondern über `route-verdict` → `{ type: 'stop', reason: 'public-api-approval-required' }` → `flag needs-attention` → Mensch. Beide Reviewer hatten inhaltlich zugestimmt; die Freigabe blieb trotzdem menschlich.
- **FOR-19s Compose-Zeit-Assertion feuerte und hielt.** `log('anchor assertion passed for 4 rows @ 5867eaa')` — jetzt aus dem gebauten Ticket heraus, nicht mehr handgezogen wie in w3. Kein Brief trug `"undefined"`; W2-F1 ist strukturell erledigt.
- **FOR-5 + FOR-15 erneut live bestätigt.** `merge-order` zog die echten Branches aus dem Dispatch-Log (`wave/FOR-22-parked-disposition` etc.), `notInPlay: []`, `warnings: []`. Dritte Wave mit befülltem Dispatch-Log; die Read-Seite (`resume()`) blieb weiterhin unausgelöst (kein Coordinator-Tod).
- **FOR-23s Worker legte seinen eigenen Teil-Scope offen, statt ihn zu behaupten.** Er lieferte die Typ-Verbreiterung + den Linear-Adapter und **deferrierte den Cross-Store-Lift explizit an FOR-20** — inklusive der Empfehlung, FOR-20 umzuschreiben statt als Duplikat zu schließen. Sein Reviewer setzte die beiden betroffenen ACs korrekt auf `partial` (nicht `met`) und markierte sie als *disclosed deferral*. Ein stilles „met" wäre hier nicht aufgefallen.
- **Reviewer verifizierten unabhängig.** Alle vier fuhren `npm ci` + eigenen `vitest`/`tsc`-Lauf im eigenen Worktree und `git merge-tree` gegen **alle** Geschwister-Branches (durchweg konfliktfrei, deckungsgleich mit der leeren Conflict-Map). FOR-23s Reviewer wies zusätzlich per Diff nach, dass die Conformance-Suite byte-unverändert blieb — der Contract hat sich also nicht an den Adapter gebogen.
- **Gemergter `main` unabhängig grün: 1370 Tests, tsc 0.** Die vier Changesets wurden isoliert geprüft (1250/1254/1263/1353) und liefen erst nach dem Merge zusammen — keine Kreuz-Regression.

## 2. Funde (nach Schwere)

### 🔴 KRITISCH

**W4-F1 — Selbstreparatur-Falle: Die Engine, die eine Wave schließt, ist die Engine von *vor* der Wave.**

`wave-close` Phase 5 ruft `read-closing` — aus dem lokalen Checkout. Der stand beim Close auf dem **Anchor** (`5867eaa`), also auf der **ungefixten** Probe, obwohl FOR-23s Fix in PR #20 fertig vorlag. Wäre Phase 5 vor dem Merge gelaufen, hätte die Probe für alle vier nachweislich gemergten Rows `closed-unmerged` gemeldet — und die Skill-Vorschrift hätte **vier korrekt gelandete Rows als `recoverable-stop` geflaggt**, exakt der W3-F1-Schaden, in der Wave, die ihn behebt.

Die richtige Reihenfolge ist **merge → `git pull` → reconcile**: erst nach dem Pull trägt der lokale Checkout `c03bc31` und damit den Fix; danach meldeten alle vier `merged` und `issue-store close` landete sie sauber auf `done`.

**Warum das mehr ist als eine Betriebsnotiz.** flotilla ist seit 2026-07-16 sein eigener Consumer. Damit gilt strukturell: **jede Wave, die an der Maschinerie arbeitet, auf der `wave-close` selbst steht, kann sich nicht mit ihrem eigenen Fix schließen — es sei denn, jemand zieht ihn bewusst vorher herein.** Das betrifft nicht nur die Probe: `merge-order`, `worktree-cleanup`, `issue-store close`, die Routing-Verben — alles läuft aus dem Checkout, den die Wave gerade verändert. Der Dogfood-Vorteil (Fixes sofort am eigenen Leib prüfbar) hat hier seine Kehrseite: **das Werkzeug misst sich mit einer Version seiner selbst, die es gerade ersetzt hat.**

Kein Schaden entstanden — aber nur, weil der Widerspruch *erwartet* wurde. Der Fund aus w3 („`read-closing` auf Linear nicht vertrauen") lag als Betriebs-Hinweis vor und hat die Reihenfolge diktiert. Ohne diesen Vorlauf wäre der Fehler still passiert: vier Flags auf vier fertigen Rows, alle plausibel.

→ **Ticket-Kandidat:** `wave-close` sollte die Engine-Version, mit der es probt, gegen die Rows der Wave prüfen — oder mindestens laut werden, wenn eine Row Dateien der Probe selbst anfasst („diese Wave verändert `read-closing`; reconcile erst nach dem Pull").

**W4-F2 — Der `blockedBy`-Body-Codec versagt nach oben: ein unbekanntes Token wird still zu `none`.**

Beim Umschreiben von FOR-20 (per API, s. W4-F5) wurde die Sektion als

```markdown
## Blocked by

FOR-23
```

geschrieben. Die Engine las danach `blockedBy: "none"` zurück — **ohne Fehler, ohne Warnung**, und `dor --id FOR-20` meldete weiterhin **PASS**. Ursache: `body-codec.ts`s `refToString` rendert einen `IssueRef` als `` `${slug}#${issue}` `` — der kanonische Wert ist **`FOR#23`**, nicht `FOR-23`. `parseBlockedBy` erkennt alles Nicht-Passende nicht als Fehler, sondern als *Abwesenheit*.

Die Folge wäre real gewesen: FOR-20 hätte als **unblockiert** im Backlog gestanden und wäre in eine Wave ziehbar gewesen, **bevor** FOR-23 landet — genau die Abhängigkeit, die der Eintrag festhalten sollte. Gefunden nur, weil nach dem Schreiben zurückgelesen wurde (`issue-store read FOR-20`).

Das ist dieselbe Fehlerklasse wie W2-F1c und W3-F1, eine Ebene tiefer: **Abwesenheit eines Signals wird als positive Tatsache gelesen.** Ein Parser, der „unbekannt" auf „keins" abbildet, kann einen Tippfehler nicht von einer bewussten Entscheidung unterscheiden — und die DoR, die genau hier Wächter sein sollte, sieht ein wohlgeformtes `none` und winkt durch.

→ **Ticket-Kandidat:** `parseBlockedBy` sollte ein nicht-leeres, nicht-`none`, nicht-parsbares Token **laut ablehnen** (FAIL, nicht `none`). Der Nachbar-Fund: die kanonische Schreibweise ist nirgends für Menschen dokumentiert — `to-issues` erzeugt sie über den Codec, aber wer eine Sektion von Hand oder per API schreibt, hat keine Quelle außer dem Quelltext.

### 🟡 MITTEL

**W4-F3 — `worktree-cleanup` ist nicht atomar: es deregistriert auch dann, wenn das Löschen scheitert (dritte Wiederholung — W2-F6, W3-F4, jetzt W4).**
`worktree-cleanup --wave` meldete ehrlich `errors: 4, removed: 0` (`Directory not empty` bei einem, `Operation not permitted` bei dreien — die Sandbox blockt unter `.claude/`). **Trotzdem war `.git/worktrees/` danach leer** und `git worktree list` zeigte nur noch `main`: `git worktree remove` hatte die Registrierung bereits entfernt, bevor das `rm` scheiterte. Zurück blieben vier physische Orphan-Dirs, die kein git-Kommando mehr sieht — und eine IDE, die sie weiter indizierte und mit „Cannot find module 'vitest'" flutete (die `node_modules` waren halb gelöscht). Manuell per `rm -rf` mit abgeschalteter Sandbox entfernt.
**Der Fund ist jetzt dreimal derselbe und noch immer offen.** FOR-25 deckt laut Titel die *Prosa*-Hälfte (Cleanup-Reihenfolge, Branch-Löschung als geprüfter Schritt) — die Atomarität des Verbs selbst ist davon nicht abgedeckt. **Ableitung:** entweder vollständig gelingen oder den Git-State unangetastet lassen; ein Teilerfolg, der Orphans hinterlässt, ist schlechter als ein sauberer Fehlschlag.

**W4-F11 — W3-F3 reproduziert: `gh pr merge --delete-branch` exitet 0 und lässt den Remote-Branch stehen, sobald *irgendetwas* das lokale Löschen blockiert. (Nachtrag — beim Merge dieses Retros selbst gefunden.)**
Die vier Wave-Branches wurden sauber gelöscht (s. §1), also lautete der erste Schluss „W3-F3 nicht reproduziert". **Falsch.** Der Merge des Retro-PRs **#22** — Minuten später, in derselben Sitzung — reproduzierte den Fund exakt: `gh pr merge 22 --squash --delete-branch` merged sauber, **exit 0**, und ließ `docs/hardening-w4-retro` remote stehen. Ursache: das **lokale** Löschen scheiterte (der Branch war ausgecheckt — gh wechselte zwar nach `main`, aber das Löschen brach ab), und gh bricht daraufhin die Remote-Löschung ab, **ohne den Exit-Code anzufassen**. Manuell per `git push origin --delete` nachgezogen.
**Die Korrektur ist inhaltlich, nicht kosmetisch.** w3 nannte zwei Ableitungen: (a) Cleanup vor die Merges ziehen, (b) die Remote-Löschung als eigenen, geprüften Schritt führen. w4 hat (a) angewandt und daraus geschlossen, das Problem sei weg — aber (a) entfernt nur *eine* Sache, die den lokalen Branch halten kann (Worktrees). Hier hielt ihn schlicht der Umstand, dass der Coordinator darauf stand. **Der Mechanismus ist unberührt: jedes Hindernis beim lokalen Löschen verschluckt die Remote-Löschung still.**

**FOR-25 deckt das bereits ab — nachgelesen, nicht aus dem Gedächtnis beurteilt.** Der erste Reflex war, FOR-25 sei zu eng geschnitten („Phasen-Reihenfolge") und müsse re-scoped werden. Das Ticket selbst widerlegt das: sein Titel nennt beide Hälften, und AC #2 verlangt wörtlich, dass `--delete-branch`s Exit-Code *nicht* als Beleg gilt und die Löschung **separat verifiziert** wird. Kein Re-Scope nötig. Die einzige echte Verengung ist AC #1s *Begründung* — sie nennt Worktrees als die Ursache, die den Branch hält; W4-F11 zeigt, dass ein schlicht ausgecheckter Branch derselbe Blocker ist. AC #2 ist ursachen-agnostisch und bleibt unberührt gültig. → **FOR-25 unverändert; Ursachen-Liste in AC #1 erweitert.**
Nebenbei ist das dieselbe Figur, die dieses Retro als Serienthema benennt: **ein Exit-Code, der einen Erfolg behauptet, den er nie geprüft hat.** Dass ausgerechnet der Retro-PR, der das aufschreibt, dem Fund zum Opfer fiel, ist kein Zufall, sondern ein Beleg dafür, wie unauffällig die Fehlerklasse ist: sie sieht in jedem Log wie ein sauberer Lauf aus.

**W4-F4 — Ein frischer Worktree hat weder Dependencies noch Store-Config; die Skill-Referenz setzt beides stillschweigend voraus.**
`tools/wave/node_modules` **und** `.flotilla/` sind beide gitignored. Ein `agent({ isolation: 'worktree' })` bekommt damit einen Checkout, in dem (a) **kein `vitest`/`tsc` existiert** — das Verify-Gate wäre schlicht tot — und (b) **`wave.config.json` fehlt**, der Worker also den Tracker gar nicht lesen kann. `workflow-driver.md`s Brief-Skelett adressiert weder das eine noch das andere; es verweist für die Task-Spec auf `issueRef: '<tracker id …>'`, was aus dem Worktree heraus nicht auflösbar ist.
Umgangen, indem der Driver dieser Wave (a) `cd tools/wave && npm ci` als expliziten Setup-Schritt in jeden Brief setzte und (b) **die vollständige Issue-Spec (Titel, Body, ACs, Files) direkt einbettete**, statt auf den Tracker zu verweisen. Beides funktionierte auf Anhieb — aber es ist Coordinator-Wissen, das nirgends steht. **Kandidat für die `wave-setup`-Preconditions und für `workflow-driver.md`s Brief-Skelett.**

**W4-F5 — Ein Ticket inhaltlich ändern geht durch das Toolkit nicht: die Engine hat kein Update-Verb.**
`IssueStore` ist `create · read · transition · close · listOpen` plus Facetten (Triage/Document/NeedsAttention/Closing). Es gibt **kein `update`/`edit`/`setBody`/`setTitle`**. flotilla kann Issues anlegen und ihren Claim-Zustand bewegen, aber ein bestehendes Ticket **nicht umschreiben**. Für das FOR-20-Re-Scoping (vom Nutzer freigegeben) blieb nur rohes Linear-GraphQL (`issueUpdate`) — also genau die Naht, um die herum flotilla gebaut ist, umgangen.
Zweiter, unabhängiger Blocker auf demselben Weg: der Session-**Linear-MCP ist am Workspace des Server-Pilots authentifiziert** (Teams `des`/`dev`), nicht an Formtrieb — `get_issue FOR-20` → *„Could not find referenced Issue"*. Beide Gründe zusammen: kein sanktionierter Pfad.
**Warum das zählt:** FOR-23s Worker konnte seinen eigenen, sauber offengelegten Deferral **nicht im Tracker verankern** — er konnte ihn nur in den Report schreiben und hoffen, dass der Coordinator ihn aufgreift. Ein Deferral, der von der Aufmerksamkeit eines Menschen abhängt, ist der Anfang von w1-F1 („eine Fähigkeit ohne Trigger"). → **Ticket-Kandidat.**

### 🟢 NIEDRIG / Umgebung

**W4-F6 — `git pull` zerreißt den Working Tree unter der Sandbox.**
`git pull --ff-only origin main` scheiterte an `error: unable to unlink old '.claude/skills/wave-shared/SKILL.md': Operation not permitted` (die Sandbox verbietet Writes unter `.claude/skills/`). Der Checkout war zu dem Zeitpunkt aber **schon halb angewandt**: ~20 Dateien trugen den neuen Inhalt, **HEAD stand weiter auf `5867eaa`**, kein `MERGE_HEAD`, kein Lock — ein Zustand, den weder `git status` noch der Exit-Code als „kaputt" ausweisen. Repariert mit `git reset --hard origin/main` bei abgeschalteter Sandbox; nichts verloren (alle vier Branch-SHAs waren lokal==remote verifiziert, `.flotilla/` ist ohnehin gitignored). **Merke: jede git-Operation, die `.claude/` umschreibt, braucht hier die abgeschaltete Sandbox.**

**W4-F7 — FOR-21 zum zweiten Mal live bestätigt (Wiederholung von W3-F5).**
`wave-close` Phase 6 schreibt `git mv` + `git commit` vor; `.flotilla/` ist per `.gitignore:27` ignoriert. `git mv` bricht mit *„fatal: not under version control"* ab. Mit plain `mv` archiviert, nichts zu committen. FOR-21 ist weiterhin offen und deckt exakt das ab.

**W4-F8 — Veraltete IDE-Diagnostics aus Mid-Run-Worktrees erzeugten einen Fehlalarm.**
Während des Laufs meldete die IDE TypeScript-Fehler in FOR-26s Dateien (`ARM_CLEAN_STATUS_ERROR` nicht exportiert, `Cannot find module './host-pr-cli'`) — sie indizierte einen Zwischenstand im Worktree. Unabhängig gegengeprüft: `tsc --noEmit` auf dem Branch **exit 0, null Output**, alle Symbole exportiert, `host-pr-cli.ts` vorhanden, `main` sauber am Anchor, nichts geleakt. Reiht sich in die Editor-Excludes aus dem w3-PR ein (`.claude/worktrees/` gehört aus dem Index).

**W4-F9 — `merge-order`s `.scratch/`-Ancestor-Warning feuert weiter (Wiederholung von W3-F6).**
Zusätzlich sichtbar: `fileCount: 0` für **alle** Rows — auf einem Linear-Store gibt es keine Issue-Dateien auf der Platte, der „fewer Files first"-Tiebreak degeneriert also zu reinem NN-ASC. Hier folgenlos (alle Rows disjunkt), aber die Heuristik ist auf diesem Pfad wirkungslos, nicht nur laut. Teil der getrackten Ur-Entkopplung.

**W4-F10 — zsh-Wortsplitting kippte den ersten WAL-Versuch (folgenlos).**
Die Dispatch-WAL-Schleife nutzte `CLI="./…/tsx …/cli.ts"; $CLI spine set-row-state …` — zsh splittet unquotierte Variablen nicht, also suchte es ein Kommando mit dem ganzen String als Namen: **12× exit 127**. Weil 127 „nichts ausgeführt" heißt, blieb der Spine unberührt (alle Rows `planned`, Dispatch-Log leer) — verifiziert, bevor wiederholt wurde. Die spine-first-WAL-Ordnung machte den Fehlschlag folgenlos: hätte die Schleife mit dem Tracker begonnen, wären vier Claims ohne Spine-Eintrag entstanden.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W4-F1** — Selbstreparatur-Sequenz: Close probt mit der Vor-Wave-Engine | 🔴 | **Ticket-Kandidat** (Warnung, wenn eine Row die Probe selbst anfasst) |
| **W4-F2** — `parseBlockedBy` versagt nach oben: unbekanntes Token → `none`, DoR PASS | 🔴 | **Ticket-Kandidat** (laut ablehnen + Schreibweise dokumentieren) |
| **W4-F3** — `worktree-cleanup` nicht atomar ⇒ Orphans (3. Wiederholung: W2-F6/W3-F4/W4) | 🟡 | **FOR-25** deckt die Prosa-Hälfte; **Atomarität offen** |
| **W4-F4** — Worktree ohne `node_modules` + ohne `wave.config.json`; Brief-Skelett schweigt | 🟡 | **Ticket-Kandidat** (wave-setup-Preconditions + `workflow-driver.md`) |
| **W4-F5** — kein Update-Verb in der Engine; MCP am falschen Workspace | 🟡 | **Ticket-Kandidat** (Deferral nicht im Tracker verankerbar) |
| **W4-F6** — `git pull` zerreißt den Tree unter der Sandbox | 🟢 | Umgebung / Runbook |
| **W4-F7** — Archiv-`git mv` auf gitignored `.flotilla/` | 🟢 | **FOR-21** (offen, 2. Bestätigung) |
| **W4-F8** — veraltete IDE-Diagnostics aus Mid-Run-Worktrees | 🟢 | Editor-Excludes (w3-PR), kein Ticket |
| **W4-F9** — `.scratch`-Warning + `fileCount: 0` auf Linear-Store | 🟢 | Teil der getrackten Ur-Entkopplung |
| **W4-F10** — zsh-Wortsplitting im WAL-Loop (folgenlos) | 🟢 | Betriebsnotiz |
| **W3-F1 (Closing-Probe)** — `metadata.state` → `metadata.status` | 🔴 | **FOR-23 gelandet + live bewiesen** |
| **W3-F2 (`prUrl` optional)** | 🟡 | **FOR-24 gelandet** |
| **W4-F11** — W3-F3 **doch reproduziert** am Retro-PR #22: exit 0, Remote-Branch bleibt, sobald das lokale Löschen blockiert ist | 🟡 | **FOR-25** (offen) deckt es bereits — AC #2 verlangt die separate Verifikation; nur AC #1s Ursachen-Liste erweitert (nicht nur Worktrees: auch ein ausgecheckter Branch) |
| **Carryover FOR-20** — Cross-Store-Lift `closed-unknown` | 🟡 | **re-scoped**, `blockedBy: FOR#23` (jetzt erfüllt) |
| **FOR-29** — wave-create behauptet Hand-Flip `draft → ready` | 🟢 | **gefiled** (diese Sitzung) |

## 4. Lauf-Metriken (grob)

- **Rows:** 4 (paralleler Fan-out, kein Smoke-Test). **Verdicts:** **4× `approve`**, 0 changes-requested, 0 `questions-blocking`. **STOPs:** 2 (FOR-23 + FOR-24, `public-api-approval-required` — protokollgemäß, kein Defekt). **cap=1 Re-Dispatch:** nie ausgelöst.
- **Agents:** 8 (4 Worker + 4 Reviewer). **Fehler:** 0. **Laufzeit:** ~76 min Wall-Clock, ~1,43 Mio. Subagent-Tokens, 416 Tool-Calls.
- **Modelle:** FOR-22 sonnet (`isolated-refactor`); FOR-23/FOR-24 opus (`public-API-change`), FOR-26 opus (`cross-feature-refactor`).
- **PRs:** #18 (FOR-22), #20 (FOR-23), #19 (FOR-24), #21 (FOR-26) — alle squash-merged, alle vier Remote-Branches gelöscht. `main`: `5867eaa → c03bc31`.
- **Test-Totals (unabhängig re-verifiziert):** FOR-22 1250 · FOR-23 1254 · FOR-24 1263 · FOR-26 1353 · **gemergter `main` 1370** · `tsc --noEmit` 0 überall. Anchor-Baseline 1250.
- **Linear:** alle 4 `done` (`Fixes FOR-N` + `issue-store close` done-reconcile). **Claim-Ledger nach Close:** leer. **Manuelle Kern-Dispatch-Interventionen:** 0. **Coordinator-Tode:** 0.
- **AC-Bilanz:** 20 ACs über 4 Rows; **18 `met`, 2 `partial`** (beide FOR-23, beide offengelegte Deferrals → FOR-20).
- **Backlog danach:** 9 offen (FOR-29/28/27/25/21/20/17/16/6), **alle unblockiert** — FOR-26 löste FOR-27+28, FOR-23 löste FOR-20.

## 5. Meta-Reflexion

Die Serie hat ein Thema, und Wave 4 macht es explizit. w1: *eine Fähigkeit ohne Trigger* (`close()` gebaut, nie gerufen). w2: *ein Input ohne Guard* (`anchorSha` gefordert, nie assertiert) und *ein Zustand ohne Beleg* (`done` ohne Attachment ⇒ die Probe rät „abgelehnt"). w3: *eine Annahme ohne Verifikation* (Fake, Fixture und Produktivcode teilten dieselbe Vermutung). w4 liefert zweimal dieselbe Figur: **Abwesenheit wird als Tatsache gelesen.** Ein `## Blocked by`-Token, das der Parser nicht kennt, wird nicht zum Fehler — es wird zu `none`, und die DoR sieht ein wohlgeformtes „keine Abhängigkeit" und winkt durch (F2). Vier Rows ohne Merge-Beleg wären nicht „unklar" gewesen, sondern „abgelehnt" (F1, in der Gegenrichtung nur vermieden, weil w3 es vorhergesagt hatte). Das ist kein Zufall mehr, sondern eine **Haltung im Code**: an zu vielen Stellen ist der Default-Zweig eine Behauptung statt eines Eingeständnisses. Der generalisierbare Satz: **kein Parser und keine Probe darf „ich habe nichts gefunden" in „es gibt nichts" übersetzen — das sind verschiedene Aussagen, und nur eine davon ist belegt.** FOR-20s `closed-unknown` ist die erste Stelle, an der flotilla diese Unterscheidung überhaupt typisiert; F2 zeigt, dass sie an mindestens einer weiteren fehlt.

Der zweite Fund ist neu und gehört zum Dogfooding selbst. **Das Werkzeug, das die Wave schließt, ist die Version von vor der Wave.** Solange flotilla fremde Repos orchestrierte, war das folgenlos; seit es sein eigener Consumer ist, misst sich jede Wave, die an Probe, Merge-Order oder Cleanup arbeitet, mit dem Code, den sie gerade ersetzt. In diesem Lauf hat das nichts gekostet — aber nur, weil ein *Betriebs-Hinweis aus der letzten Retro* („`read-closing` auf Linear nicht vertrauen") die Reihenfolge diktierte. Das ist eine dünne Absicherung: sie hing an einer gelesenen Notiz, nicht an einer Struktur. Bemerkenswert ist die Symmetrie zum positiven Fall — zum **zweiten Mal in Folge hat eine Retro-Empfehlung gewirkt, bevor ihr Ticket gebaut war** (w3 zog FOR-19s Assertion vor, w4 zog W3-F3s Phasenreihenfolge vor). Die Retros sind damit nicht Dokumentation *über* den Prozess, sondern ein Teil *von* ihm — der einzige Mechanismus, der bisher zuverlässig Fehler verhindert hat, bevor Code sie verhindern konnte. Das ist ein Kompliment an die Praxis und eine Warnung zugleich: was nur in einer Prosa-Notiz lebt, schützt genau so lange, wie jemand sie liest.

**Und die Warnung hat sich sofort selbst bewiesen (W4-F11, Nachtrag).** Die erste Fassung dieses Abschnitts schloss, W3-F3 „blieb aus" — geschrieben in dem Moment, in dem vier Wave-Branches sauber gelöscht waren. Minuten später verschluckte der Merge des Retro-PRs, der genau diesen Satz enthielt, seinen eigenen Remote-Branch: exit 0, nichts im Log, Branch steht. Die vorgezogene Empfehlung hatte **eine Ursache** beseitigt (Worktrees halten den Branch), nicht den **Mechanismus** (jedes Hindernis beim lokalen Löschen bricht die Remote-Löschung still ab). Der Fehlschluss ist dabei aufschlussreicher als der Bug: **aus „der Fehler ist diesmal nicht aufgetreten" wurde „der Fehler ist behoben"** — Abwesenheit als Tatsache gelesen, dieselbe Figur wie F1 und F2, diesmal begangen vom Retro selbst. Wenn die Fehlerklasse robust genug ist, um in dem Dokument aufzutreten, das sie beschreibt, dann ist sie keine Eigenschaft des Codes, sondern eine des Hinsehens. Die praktische Konsequenz: **eine Empfehlung, die eine Ursache entfernt, hat nichts bewiesen, solange der Mechanismus steht** — und der Beleg dafür ist nie ein grüner Lauf, sondern nur ein Test, der den Mechanismus selbst anfasst.

Und schließlich hat sich der Fan-out zum zweiten Mal als **fertig** erwiesen: 8 Agents, 0 Fehler, 0 Interventionen, alle Verdicts belegt statt behauptet, beide public-API-STOPs protokollgemäß. Was FOR-23s Worker tat — den halben Scope **offenlegen** statt „met" zu behaupten, und dem Coordinator gleich das Re-Scoping von FOR-20 vorzuschlagen — ist das Verhalten, auf das die ganze Schema-Grenze zielt. Dass er es **nicht selbst im Tracker verankern konnte** (F5), ist die eigentliche Lücke: der Deferral war korrekt, sichtbar und begründet, und hing trotzdem daran, dass ein Mensch ihn aufgreift. Genau das ist w1-F1 in neuem Gewand. Die Härtung ist an den Rändern angekommen — und der schmalste Rand ist der zwischen einem Agenten, der etwas richtig erkennt, und einem System, das ihm keinen Ort gibt, es hinzuschreiben.
