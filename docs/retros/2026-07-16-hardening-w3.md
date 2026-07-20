# flotilla — Retrospektive: Wave 3 „2026-07-16-hardening-w3" (vierter Live-Lauf)

Wave: `2026-07-16-hardening-w3` · Rows: **FOR-11, FOR-14, FOR-19** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `3ce08b1`.

## 0. Ergebnis in einem Satz

Wave 3 lief als **bisher sauberster Lauf** durch — paralleler Fan-out (3 Rows) → **3× `approve`, 0 changes-requested, 0 Re-Dispatch, 0 manuelle Kern-Dispatch-Interventionen** → 3 squash-PRs (#14/#15/#13) auf `main` (`3ce08b1 → 939ef3c`) → alle 3 Linear-Issues auto-`Done` → Spine archiviert — **aber** die Closing-Probe meldete für **alle drei nachweislich gemergten Rows `closed-unmerged`**, und `wave-close` Phase 5 hätte damit drei fertige Rows spurious als `needs-attention` geflaggt: der W2-F1c-Verdacht, live bestätigt und auf eine exakte Ursache heruntergebrochen (**falscher Feldname**, → FOR-23).

## 1. Was richtig gut funktioniert hat

- **Der erste Lauf ganz ohne Reibung im Kern-Dispatch.** 0 manuelle Interventionen (w1: 6), 0 spurious Verdicts (w2: 2), cap=1 nie ausgelöst, 0 Agent-Fehler bei 6 Agents. Der Fan-out ist an dieser Stelle Routine geworden — die verbleibenden Funde liegen alle *außerhalb* des Dispatch-Kerns.
- **W2-F1 ist nicht wiedergekehrt — durch die eigene Empfehlung.** Der Coordinator hat FOR-19s Fix (Compose-Zeit-`anchorSha`-Assertion) **von Hand in den Driver dieser Wave gezogen**, bevor er FOR-19 dispatchte, der ihn baut. Leicht rekursiv, aber genau der Punkt: die w2-Empfehlung war umsetzbar, *bevor* das Ticket lief, und hat ihre eigene Fehlerklasse sofort ausgeschlossen (`log('anchor asserted for all 3 rows @ 3ce08b1')`).
- **Reviewer reproduzierten Negativ-Kontrollen, statt Reports zu glauben.** FOR-14s Reviewer setzte `coarse()`s Signatur auf `ClaimRung` zurück und wies mechanisch nach, dass der *ausserhalb* des Files-Blocks liegende `resume.ts`-Eingriff eine erzwungene Folge der AC ist (genau ein tsc-Fehler, `resume.ts(181,5)`); und patchte `unclaim` in `linear-issues-store.ts`, um zu beweisen, dass die Conformance-Tests einen kaputten Claim-Release **wirklich** fangen. Das ist Verifikation, keine Report-Wiedergabe.
- **Der `public-API-change`-STOP feuerte korrekt (G3-Guard).** FOR-14s `approve` lief *nicht* still in den Auto-PR, sondern über `route-verdict` → `{ type: 'stop', reason: 'public-api-approval-required' }` → `flag needs-attention` → Mensch. Genau dafür ist die `riskClass`-Bifurkation da: der Reviewer hatte inhaltlich zugestimmt, aber neue öffentliche API (`PARKABLE_FROM`/`canPark()`) ist eine Entscheidung, die er bewusst nicht allein trifft.
- **Gemergter `main` unabhängig grün verifiziert: 1250 Tests, tsc 0.** Die drei Changesets wurden pro Row *isoliert* geprüft (1213/1244/1207) — erst nach dem Merge liefen sie zum ersten Mal **zusammen**. Der Integrations-Check ist bewusst nachgezogen worden und hat keine Kreuz-Regression gezeigt.
- **FOR-15s Fix live bestätigt.** `merge-order` zog die **echten** Branches aus dem Dispatch-Log (`wave/FOR-11-cli-trust` etc.), nicht `branch:null` — der w2-F2-Beleg in die Gegenrichtung. Und: zweite Wave mit befülltem Dispatch-Log (FOR-5); Read-Seite (`resume()`) weiterhin nicht ausgelöst (kein Coordinator-Tod).
- **Worker meldeten den Anchor-Baseline-Drift von selbst.** Der Dispatch-Brief nannte „~1122 Tests" (aus der Config, veraltet); zwei Worker maßen die echte Anchor-Baseline selbst per Stash-Round-Trip (1207) und meldeten die Diskrepanz als `judgmentCall`, statt die falsche Zahl zu bestätigen.

## 2. Funde (nach Schwere)

### 🔴 KRITISCH

**W3-F1 — Die Linear-Closing-Probe liest `metadata.state`, die Live-API liefert `metadata.status`: *jede* gemergte Row meldet `closed-unmerged`.**

`issue-store read-closing` lieferte für **alle drei** Rows `{"state": "closed-unmerged"}` — obwohl die PRs nachweislich gemergt waren (#14/#15/#13, Merge-Commits `d1e5192`/`bc495d1`/`939ef3c`) und Linear alle drei via `Fixes FOR-N` bereits selbst auf `Done` gezogen hatte. `wave-close` Phase 5 schreibt für `closed-unmerged` ein `flag --kind recoverable-stop` vor — **drei fertige Rows wären spurious geflaggt worden**. Der Coordinator ist der Skill-Vorschrift hier bewusst *nicht* gefolgt und hat stattdessen gegengeprüft (GitHub: `state=MERGED` + Merge-Commit; Linear: `status=done`).

**Ursache, exakt** — `real-linear-api.ts:577-578` (`toPrAttachment`):

```ts
const merged =
  typeof metadata === 'object' && metadata !== null &&
  (metadata as Record<string, unknown>).state === 'merged';
```

Gelesen wird **`metadata.state`**. Die Live-API liefert **`metadata.status`** — ein Feld `state` existiert auf der Attachment-Metadata **gar nicht**. Also ist `merged` *immer* `false`, `readClosing`s `attachments.find(a => a.merged)` trifft nie, und es fällt auf `return { state: 'closed-unmerged' }` durch (`linear-issues-store.ts:318`).

**Kein Sync-Lag** — live gegen FOR-11 verifiziert: das Attachment ist da, `sourceType: "github"`, Metadata trägt `status: "merged"`, `mergedAt: "2026-07-16T15:07:53Z"`, `linkKind: "closes"`, `number: 14`. Die Daten lagen die ganze Zeit vor; der Adapter schaute auf den falschen Key.

**Warum es bis hierher überlebt hat — und warum das kein Prozessversagen ist.** Dies ist eine der **8 e2e-verify-geflaggten Schema-Annahmen** aus dem ADR-0020-Build. Ihr eigener Docblock benennt sie wörtlich:

> *e2e-verify: the exact `sourceType` string and the `metadata.state === 'merged'` shape — the fixture pins this; live shape verification belongs to the e2e gate (same hermetic stance as ADR-0019).*

Der Fake **und** die Fixture kodieren **dieselbe falsche Annahme** wie der Produktivcode — die Suite ist deshalb grün gegen eine Shape, die die API nie zurückgibt. Genau dafür war der Flag da, und das e2e-Gate hat beim ersten echten Lauf der Probe geliefert. Von den zwei Annahmen im Docblock ist `sourceType === 'github'` jetzt **bestätigt korrekt**, `metadata.state` **bestätigt falsch**.

**W2-F1c war richtig — und die Ursache liegt tiefer als vermutet.** w2 hatte die *Design*-Hälfte diagnostiziert („die Probe konflatiert closed-ohne-Attachment mit PR-abgelehnt") und sie als Kanten-Fall für Issues eingeschätzt, deren Close nicht über den `Fixes`-Pfad lief. Real ist es **kein Kanten-Fall, sondern jede Row**: die Probe kann auf Linear `merged` überhaupt nie zurückgeben. → **FOR-23** (gefiled), das beide Hälften zusammen erledigt: Feldname *und* die fehlende dritte Klasse (`unknown`/`closed-without-evidence` statt „Abwesenheit von Beleg = Beweis der Ablehnung`). `ClosingState` ist öffentlicher Contract ⇒ Typ, beide Adapter und die Conformance-Suite bewegen sich zusammen (riskClass `public-API-change`). **Die Fixture muss aus der echten API stammen** — eine handgeschriebene Fixture hat den Bug überhaupt erst erzeugt.

**Betriebs-Hinweis bis FOR-23 landet:** `read-closing` auf Linear nicht vertrauen; gegen `gh pr view <n> --json state,mergeCommit` + `issue-store read <id>` gegenprüfen.

### 🟡 MITTEL

**W3-F2 — `WorkerReport.prUrl` ist optional ⇒ ein Worker kann einen PR öffnen und ihn nicht melden.**
FOR-19s Worker **öffnete PR #13** (korrekt, inkl. `Fixes FOR-19`), gab aber **kein `prUrl`** im Report zurück (`outcome: "done"`, Schema erlaubt das Feld wegzulassen). Folgen entlang der Kette: (a) der **Reviewer** meldete „PR is not yet opened (Worker report: 'PR URL: <pending>')" und konnte den PR-Body — inklusive der store-korrekten Close-Phrase, die er laut Brief prüfen soll — **nicht verifizieren**; (b) der **Coordinator** hielt den Terminator für offen und versuchte den PR zu öffnen — nur `gh pr create`s Weigerung („a pull request for branch … already exists: #13") verhinderte den Duplikat-Versuch. Ein optionales Feld, das der ganze Downstream als Tatsache liest. **Fix-Kandidaten:** `prUrl` bei `outcome ∈ {done, done-with-concerns}` **required** machen, oder dem Terminator ein find-before-create geben (für `wave-close --auto` ohnehin schon P8-deferred). → **Ticket-Kandidat** (§3).

**W3-F3 — `gh pr merge --delete-branch` lässt die Remote-Branches stehen, wenn das lokale Löschen scheitert — und exitet trotzdem 0.**
Alle drei Merges liefen mit `--delete-branch`; alle drei meldeten `failed to delete local branch … used by worktree at …` (die Worktrees hielten die Branches noch, weil `wave-close` das Cleanup erst *nach* der Merge-Phase vorsieht). Der Merge selbst war erfolgreich (**exit 0**), aber die **Remote-Branches existierten danach alle drei weiter** (`gh api repos/…/branches` verifiziert) — der lokale Fehler brach die Remote-Löschung mit ab, ohne den Exit-Code zu beeinflussen. Musste explizit per `git push origin --delete` nachgezogen werden. **Ableitung:** entweder Worktree-Cleanup **vor** den Merges ziehen (Phasen-Reihenfolge in `wave-close`), oder die Remote-Löschung als eigenen, geprüften Schritt führen — nicht als Merge-Flag-Nebenwirkung mit stillem Teilversagen.

### 🟢 NIEDRIG / Umgebung

**W3-F4 — Verwaiste Worktree-Dirs nach dem Cleanup (Wiederholung von W2-F6; der Gitignore hat sie nicht behoben).**
`worktree-cleanup` meldete `errors: 3, removed: 0` (`Directory not empty` / `Operation not permitted`) — **deregistrierte die Worktrees aber trotzdem** (`git worktree list` danach nur `main`), sodass drei physische Orphan-Dirs zurückblieben, die git nicht mehr kennt. Manuell per `rm -rf` mit abgeschalteter Sandbox entfernt (die Sandbox blockt `.claude/worktrees/*/.claude/agents/*`). Nebenbefund: FOR-19s Worker hatte in seinem Worktree ein `npm install` gefahren. **Der w2-Fix (Gitignore) adressierte nur das git-status-Rauschen, nicht die Löschung** — der eigentliche Fund („cleanup deregistriert, obwohl das Löschen scheiterte" ⇒ Orphans, die kein Tool mehr sieht) ist offen.

**W3-F5 — FOR-21 live bestätigt: `.flotilla/` ist gitignored ⇒ der Archiv-`git mv` scheitert.**
`wave-close` Phase 6 schreibt `git mv` vor; im Toolkit-Repo ist `.flotilla/` per `.gitignore:27` ignoriert (bewusst — flotilla ist das Toolkit, kein Consumer), die Dateien sind also ungetrackt. Mit plain `mv` archiviert. Genau der Fall, den **FOR-21** tickettiert (offen, nicht in dieser Wave).

**W3-F6 — `merge-order`s `.scratch/`-Ancestor-Warning feuert weiter auf einer self-contained Spine.**
`[wave] warning: no .scratch/ ancestor found above … falling back to cwd … gate results may be unreliable.` — obwohl FOR-15 laut Commit-Message „gate the .scratch-glob warning" enthielt. Das **Branch-Sourcing selbst ist korrekt** (echte Branches, `notInPlay: []`, `warnings: []`), nur die Warnung ist Lärm auf dem Pfad, für den sie nicht gedacht ist. Reiht sich in die separat getrackte Ur-Entkopplung von `extractSpineBranches` ein.

**W3-F7 — Planungs-Fund: der FOR-Backlog ist konfliktdicht; die maximale disjunkte Wave ist 3.**
`wave-plan` über die 8 kandidatenfähigen Rows (FOR-6/11/14/16/17/19/20/21) ergab **16 intra-wave Konfliktpaare**. Das Maximum-Independent-Set über diesen Graphen ist **3** — jede maximale Wave ist `{FOR-11, FOR-19} + eines aus {FOR-14, FOR-20, FOR-21}`. **FOR-17 kollidiert mit 6 von 7** und kann nur noch mit FOR-19 zusammen laufen (jetzt verbraucht). Hot-Spots: `tools/wave/src/cli.ts` (FOR-6/11/17), `.claude/skills/wave-close/**` (FOR-14/17/20/21), `wave-start/reference/workflow-driver.md` (FOR-6/16/19), `wave-shared/**` (FOR-6/16/20). **Der Rest {FOR-6, 16, 17, 20, 21} braucht ≥2 weitere Waves.** Das ist kein Defekt, sondern eine Eigenschaft des Slicings: mehrere Tickets zielen unabhängig auf dieselben Dateien. Für künftiges `to-issues`-Slicing relevant — Parallelisierbarkeit entsteht beim Schneiden, nicht beim Planen.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W3-F1** — Closing-Probe `metadata.state` vs. `metadata.status`; + fehlende dritte Klasse (absorbiert W2-F1c) | 🔴 | **FOR-23 gefiled** |
| **W3-F2** — `prUrl` optional ⇒ PR geöffnet aber nicht gemeldet (Reviewer blind, Duplikat-Risiko) | 🟡 | **FOR-24 gefiled** |
| **W3-F3** — `gh pr merge --delete-branch` lässt Remotes stehen, exit 0 | 🟡 | **FOR-25 gefiled** (Phasen-Reihenfolge: Cleanup vor Merge) |
| **W3-F4** — Cleanup deregistriert trotz Löschfehler ⇒ Orphan-Dirs (W2-F6-Wiederholung) | 🟢 | **FOR-25 gefiled** (Prosa-Hälfte); Gitignore war nicht der Fix |
| **W3-F5** — Archiv-`git mv` auf gitignored `.flotilla/` | 🟢 | **FOR-21** (offen, bestätigt) |
| **W3-F6** — `.scratch`-Warning auf self-contained Spine | 🟢 | Teil der getrackten Ur-Entkopplung |
| **W3-F7** — Backlog-Konfliktdichte (max. disjunkte Wave = 3) | 🟢 | Planungs-Notiz, kein Ticket |
| **Carryover FOR-14** — wave-start Park-Disposition (ADR-0022 §Consequences) | 🟡 | **FOR-22 gefiled** |
| Editor-Excludes (`.vscode/settings.json`) | 🟢 | **dieser PR** |

## 4. Lauf-Metriken (grob)

- **Rows:** 3 (paralleler Fan-out, kein Smoke-Test). **Verdicts:** **3× `approve`**, 0 changes-requested, 0 `questions-blocking`. **STOPs:** 1 (FOR-14, `public-api-approval-required` — protokollgemäß, kein Defekt). **cap=1 Re-Dispatch:** nie ausgelöst.
- **Agents:** 6 (3 Worker + 3 Reviewer). **Fehler:** 0. **Laufzeit:** ~24,5 min Wall-Clock, ~716k Subagent-Tokens, 327 Tool-Calls.
- **Modelle:** FOR-11/FOR-19 sonnet (`isolated-refactor`), FOR-14 opus (`public-API-change`).
- **PRs:** #14 (FOR-11), #15 (FOR-14), #13 (FOR-19) — alle squash-merged. `main`: `3ce08b1 → 939ef3c`.
- **Test-Totals (unabhängig re-verifiziert):** FOR-11 1213 · FOR-14 1244 · FOR-19 1207 · **gemergter `main` 1250** · `tsc --noEmit` 0 überall. Anchor-Baseline real 1207 (nicht die im Brief genannten ~1122).
- **Linear:** alle 3 auto-`Done` bei Merge. **Manuelle Kern-Dispatch-Interventionen:** 0. **Coordinator-Tode:** 0.

## 5. Meta-Reflexion

Der vierte Lauf schließt einen Bogen: **der Dispatch-Kern ist fertig.** Drei Waves lang waren die Funde im Fan-out selbst (w1: 6 Interventionen; w2: ein Compose-Bug, der eine Review-Runde kostete); dieser Lauf hatte dort **null**. Alles, was diesmal auffiel, liegt an den **Rändern** — an der Naht zum Tracker (F1), an der Naht zum Agent-Report (F2), an der Naht zum Host (F3), am Aufräumen (F4/F5). Das ist ein gesundes Reifezeichen, aber auch eine Verschiebung der Aufmerksamkeit: die Härtung findet ab jetzt an den Grenzen statt, nicht in der Mitte.

Der schärfste Fund ist dabei ein **erkenntnistheoretischer**, und er verlängert die Serie sauber. w1: *eine Fähigkeit ohne Trigger* (`close()` gebaut, nie gerufen). w2: *ein Input ohne Guard* (`anchorSha` gefordert, nie assertiert) und *ein Zustand ohne Beleg* (`done` ohne Attachment ⇒ die Probe rät „abgelehnt"). w3: **eine Annahme ohne Verifikation** — und zwar eine, die *als solche markiert war*. Der Docblock sagte wörtlich „e2e-verify: … the `metadata.state === 'merged'` shape"; das Gate lief zum ersten Mal; die Annahme war falsch. Das Bemerkenswerte ist nicht der Tippfehler, sondern die **Struktur**: Fake, Fixture und Produktivcode teilten *dieselbe Vermutung*, also konnten 1250 grüne Tests sie unmöglich widerlegen. **Ein Fake, der aus derselben Vermutung gebaut ist wie die Implementierung, beweist nur Selbstkonsistenz, nicht Korrektheit.** Genau deshalb ist die hermetische Haltung (ADR-0019/0020) richtig *und* unvollständig: sie braucht das e2e-Gate als einzige Instanz, die die Vermutung überhaupt anfassen kann — und deshalb muss FOR-23s Fixture aus der echten API kommen, nicht aus einer zweiten Vermutung.

Und noch etwas hat sich bewährt: **der Coordinator ist der Skill-Vorschrift bewusst nicht gefolgt.** Phase 5 schrieb „flag `recoverable-stop`" vor; drei fertige Rows wären falsch markiert worden. Der Skill war nicht falsch geschrieben — er war korrekt geschrieben auf Basis einer Probe, die lügt. Dass der Fund überhaupt entstand, lag daran, dass ein Widerspruch (*„gemergt, aber closed-unmerged?"*) nicht wegerklärt, sondern **gegen zwei unabhängige Quellen geprüft** wurde. Das ist dieselbe Bewegung, die FOR-14s Reviewer mit seinen Negativ-Kontrollen machte, nur eine Ebene höher. Die Lehre für das Runbook: **wenn Ledger und Welt widersprechen, gewinnt nicht der Ledger und nicht die Vorschrift — sondern die Nachprüfung.**
