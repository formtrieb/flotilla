# flotilla — Retrospektive: Wave 5 „2026-07-19-hardening-w5" (sechster Live-Lauf)

Wave: `2026-07-19-hardening-w5` · Rows: **FOR-25, FOR-29, FOR-31, FOR-32** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `32064ac` → `main` nach dem Close: `a5dfb15`.

## 0. Ergebnis in einem Satz

Wave 5 lief den **vollen Zyklus `wave-plan → wave-create → wave-start → wave-close` in einer einzigen Session** — 4er-Fan-out → **4× `done` Worker + 4× `approve` Reviewer, 0 changes-requested, cap=1 nie gefeuert, 8 Agents / 0 Fehler** → ein protokollgemäßer `public-API-change`-STOP (FOR-31) → menschliche Freigabe → 4 squash-PRs (#24/#25/#26/#27) auf `main` (`1379` Tests, tsc 0; Anchor 1370) → alle 4 Rows `done` → Spine archiviert. **Sämtliche Funde liegen wieder außerhalb des Kern-Dispatch** (dritter Lauf in Folge ohne Reibung im Fan-out) — diesmal konzentriert in `wave-close` gegen die Sandbox-Realität, plus ein Schema-Fallstrick an der Agent-Boundary beim allerersten Dispatch.

## 1. Was richtig gut funktioniert hat

- **Der ganze Zyklus in einer Sitzung, ohne Coordinator-Tod.** Von der Kandidaten-Auswahl (`wave-plan` zog 13 Kandidaten, zerlegte sie in 3 Near-Cliques + 1 freien Knoten, max. disjunkte Wave = 4) über `wave-create` (Spine + `queued`-Claims, Conflict-Map `∅`) und `wave-start` (Fan-out) bis `wave-close` (Merge + Reconcile + Archiv). Erster Lauf, der die vier Skill-Phasen an einem Stück durchspielt.
- **Der Kern-Dispatch reibungslos.** 8 Agents, 0 Fehler, 0 manuelle Kern-Interventionen, cap=1 nie ausgelöst, ~20 min. Wie w3/w4 liegen alle Funde **außerhalb** des Fan-outs.
- **Der `public-API-change`-STOP feuerte korrekt (G3-Guard).** FOR-31s `approve` lief **nicht** still in den Auto-PR, sondern über `route-verdict` → `{ type: 'stop', reason: 'public-api-approval-required' }` → `flag needs-attention` → Mensch. Der Reviewer hatte inhaltlich zugestimmt (alle 5 ACs `met`, Conformance byte-unverändert auf allen 3 Adaptern); die Freigabe blieb trotzdem menschlich, danach `clear-flag` → Terminator → `in-review` → gelandet.
- **`host-pr` trug das Landing, wo `gh` am Sandbox-TLS scheiterte.** `host-pr status|merge` (FOR-26, raw-`fetch` + `NODE_USE_ENV_PROXY=1`) mergte alle vier PRs sauber durch denselben Proxy, der `gh pr view/merge` mit `x509: OSStatus -26276` abwies. **ADR-0023 („jeder Host-Write durch die Engine-Seam") ist damit hart live bestätigt** — und der Grund, warum die Seam existiert, ist genau diese Sandbox-Unfähigkeit von `gh`.
- **`read-closing` meldete für alle vier `merged` — W3-F1/FOR-23-Fix erneut am scharfen Fall.** Die ADR-0020-Probe las die gemergte-PR-Attachment korrekt (`metadata.status`), `issue-store close` reconcilte alle vier sauber auf `done`. Dritte Wave, in der die W3-F1-Reparatur live hält.
- **FOR-32 baute den Fix für die Lücke, die es beim eigenen Dispatch selbst demonstrierte.** Ein frischer Worktree hat weder `node_modules` noch die gitignorierte `.flotilla/wave.config.json` — der Coordinator musste die Briefs von Hand um `npm ci` + die **eingebettete Spec** ergänzen (statt eines Tracker-`issueRef`, den der Worker aus dem Worktree nicht auflösen kann). Genau das generisch in die Skill-Skeleton zu heben **ist FOR-32s PR**. Selbstreferenzieller Dogfood: die Wave dispatchte FOR-32 mit dem Hand-Workaround für exakt das Problem, das FOR-32 behebt.
- **FOR-25 demonstrierte seine eigene These live — während seines eigenen Close.** Siehe W5-F4.
- **Reviewer verifizierten unabhängig.** Alle vier fuhren `npm ci` + eigenen `vitest`/`tsc`-Lauf im Wegwerf-Worktree; FOR-31s Reviewer reproduzierte TDD-Rot/Grün selbst und wies per Diff nach, dass die Conformance-Suite unverändert blieb.
- **Gemergter `main` unabhängig grün: 1379 Tests, tsc 0** (Anchor 1370 → FOR-31 brachte 9 neue Tests). Vier disjunkte Changesets, keine Kreuz-Regression.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W5-F1 — Die kanonische `WORKER_REPORT_SCHEMA` (top-level `anyOf`) wird an der Agent-Boundary abgelehnt; die zwei Schema-Kopien divergieren load-bearing.**

Der **erste** Workflow-Dispatch scheiterte sofort — alle 4 Worker, `API Error: 400 tools.9.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`, 0 Tokens, 4,8 s. Ich hatte die **kanonische** `WORKER_REPORT_SCHEMA` aus `wave-shared/SKILL.md` in den Driver kopiert — die trägt ein top-level `anyOf` (die „`done`/`done-with-concerns` ⇒ `prUrl` required"-Invariante). Die Agent-`tool.input_schema`-Validierung akzeptiert **kein** top-level `anyOf/oneOf/allOf`.

Die **Kompakt-Kopie in `workflow-driver.md` lässt das `anyOf` korrekt weg** — vermutlich genau aus diesem Grund. Damit divergieren die zwei inlined Kopien an einer load-bearing Stelle: die `wave-shared`-Fassung ist die „Wahrheit" (deep-equal gegen die Engine-Const via `skill-schema-drift.spec.ts`), aber sie ist **nicht 1:1 in den Driver kopierbar**. Wer die wave-shared-Literale wörtlich übernimmt (wie ich), fliegt auf die Nase. Nichts fängt das vor dem Dispatch ab.

Fix in dieser Wave: `anyOf` entfernt; die `prUrl`-Invariante lebt jetzt im Worker-Brief (der sie ohnehin explizit fordert). Kosten: 0 (fail-fast, vor jedem Agent-Start), aber vermeidbare Reibung.

→ **Ticket-Kandidat:** entweder `skill-schema-drift.spec.ts` um eine Assertion erweitern, die die **Boundary-Tauglichkeit** der Driver-Kopie prüft (kein top-level Kombinator), oder in `wave-shared` + `workflow-driver.md` explizit vermerken: „der Driver nutzt die `anyOf`-freie Form; die `prUrl`-on-`done`-Invariante ist **Brief-erzwungen**, nicht Schema-erzwungen an der Boundary."

**W5-F2 — `gh` ist im Sandbox unbenutzbar (TLS-durch-Proxy); `wave-close --auto` (FOR-27) ist noch nicht verdrahtet.**

Jeder `gh`-Aufruf gegen die GitHub-API scheiterte an `Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: OSStatus -26276` — der bekannte P-6/w2-F4-Proxy-TLS-Bruch. Die Engine-`host-pr`-Verbs (FOR-26) umgingen das über raw-`fetch` + `NODE_USE_ENV_PROXY=1`. Aber die aktuelle `wave-close`-Skill beschreibt das Landing noch als „P8/`gh`/manuell" und kennt die FOR-26-Verbs nicht — sie ist **stale gegen die tatsächlich verfügbare Engine-Fähigkeit**. Der Coordinator mergte manuell via `host-pr merge --branch <b> --method squash` (pro Branch).

→ **FOR-27** (bereits gefiled: `wave-close --auto` Partial-Arm-Phase, blockedBy FOR-26 — jetzt frei) würde das automatisieren und die Skill-Prosa auf die FOR-26-Verbs umstellen. Bestätigt Priorität.

**W5-F3 — Die `merge → pull → reconcile`-Reihenfolge (W4-F1) ist auf diesem Consumer sandbox-blockiert.**

Der W4-F1-Schritt (nach dem Merge `git pull`, dann reconcilen) **scheiterte halb**: der Sandbox blockt Schreibzugriff auf `.claude/skills/` (`error: unable to unlink old '.claude/skills/...': Operation not permitted`). Ein Fast-Forward, der Skill-Dateien anfasst, applizierte darum nur teilweise — `tools/wave/src`-Dateien aktualisiert, `.claude/skills/` nicht, HEAD auf dem Anchor eingefroren. Das Arbeitsverzeichnis stand danach in einem Mischzustand (FOR-31s gemergte Änderungen als vermeintliche „Modifikationen", HEAD alt). Auflösung: `git reset --hard origin/main` mit `dangerouslyDisableSandbox: true`.

Für **diesen** Lauf war es harmlos (w5 fasst die Probe-Engine — `read-closing`/`close`/`merge-order` — nicht an; FOR-31 änderte `body-codec`/`dor-gate`). Aber die Kombination ist eine Falle: für eine Wave, die `read-closing` *ändert* (wie w4), ist `merge → pull → reconcile` **load-bearing UND sandbox-blockiert** zugleich. Der W4-F1-Fund und die Sandbox-Grenze schneiden sich.

→ **Ticket-Kandidat:** `wave-close`-Mechanik um die Sandbox-Realität ergänzen — „`git pull`/`reset` braucht Sandbox-aus, wenn die Wave `.claude/skills/` anfasst; pull erst, dann reconcile."

### 🟢 KLEIN

**W5-F4 — Orphan-Worktrees + IDE-stale-Index: FOR-25 demonstriert sich selbst live, im eigenen Close.**

`worktree-cleanup` (versehentlich **ohne Args** ausgeführt, in der Annahme es drucke Usage — tatsächlich läuft es einen echten Full-Cleanup) deregistrierte alle 4 Worktrees, konnte ihre Verzeichnisse aber nicht löschen (`Directory not empty` / `Operation not permitted`). Danach war `git worktree list` sauber, die vier Dirs lagen weiter auf Platte — **exakt der W3-F4/FOR-25-Orphan-Trap** („git deregistriert, während das `rm` scheitert"). Und die Orphans ließen die IDE einen stale Checkout indizieren (die `Cannot find module 'vitest'`-Diagnostics) — wieder **wörtlich** die FOR-25-Notiz („kept an editor's language server busy indexing a stale checkout"). Entfernung brauchte `rm -rf` mit Sandbox-aus.

FOR-25 — das genau diese beiden Silent-Success-Fallen dokumentiert und in **dieser** Wave gelandet ist — beschrieb seinen eigenen Close, während er lief. Zwei kleine Nebenfunde:

- **(a)** `worktree-cleanup` **ohne Args führt einen echten Full-Cleanup aus** statt Usage zu drucken → Footgun (jede andere `*-cli`-Op druckt bei fehlenden Args Usage).
- **(b)** `host-pr status: merged` ist der **PR-Zustand** (permanent nach Merge), **keine Branch-Existenz-Prüfung**. Die FOR-25-Branch-Deletion-Verifikation kann sich nicht auf `host-pr status` stützen — Evidenz ist die `git push origin --delete`-Ausgabe (`[deleted]`) oder eine echte Branch-Liste. `host-pr merge --squash` löscht Branches **nicht** → separate Löschung nötig (FOR-25-konform von Hand).

**W5-F5 — zsh no-word-split, erneut.** `git push origin --delete $BRANCHES` mit space-getrennter Variable wurde als **ein** Refspec interpretiert (`invalid refspec`). Bereits als Betriebsnotiz bekannt ([[wave-start-driver-operational-notes]]); pro-Item-Loop oder Shell-Funktion nötig. Kein neuer Schaden, aber der Reflex sitzt noch nicht.

## 3. Was in den Backlog geht

- **W5-F1** → neues Ticket (Schema-`anyOf`-Boundary: Driver-Kopie boundary-tauglich halten / Drift-Spec erweitern / Invariante als Brief-erzwungen dokumentieren).
- **W5-F2** → **FOR-27** (bereits gefiled) — bestätigt scharf: `wave-close --auto` auf die FOR-26-`host-pr`-Verbs stellen, Skill-Prosa entstalen.
- **W5-F3** → Ticket-Kandidat (wave-close-Mechanik: Sandbox-Realität für pull/reset dokumentieren).
- **W5-F4a** → Ticket-Kandidat (`worktree-cleanup` ohne Args soll Usage drucken, nicht cleanen).
- **W5-F4b** → Notiz (Branch-Existenz ≠ `host-pr status`; ggf. ein `host-pr branch-exists` o. Ä. — niedrige Priorität).

## 4. Prep in dieser Session (kein Wave-Row)

Read-only Design-Pass auf **FOR-6** (P-1: Sidecars bei Agent-Return statt Coordinator-Post-Workflow). Kern-Erkenntnis: das Driver-JS läuft in einer no-fs/no-shell-Sandbox und der Coordinator bekommt erst am Batch-Ende Kontrolle — der Write **muss** in einem Agent passieren. Der eine offene Design-Fork: **wer schreibt das Report-Sidecar** — der worktree-isolierte Worker (kann `.flotilla/` nicht sehen → Cross-Worktree-Abs-Pfad, fragil) vs. der nicht-isolierte Reviewer (schreibt beide, im Coordinator-Checkout, einfach). Empfehlung: **Reviewer-schreibt-beide**. FOR-6 muss **nach FOR-32** laufen (gemeinsame `workflow-driver.md`, und FOR-6s Worktree-Argument verlängert exakt die Brief-Sektion, die FOR-32 gerade umgeschrieben hat).

> **Nachtrag (2026-07-19, gleicher Tag):** Der Design-Fork ist im FOR-6-Grill **gegen** diese Empfehlung entschieden — [ADR-0024](../adr/0024-sidecars-are-written-at-agent-return-by-scribes-through-paired-write-verbs.md) wählt **Scribe-Stufen** (zwei billige `agent()`-Stufen direkt nach Worker- bzw. Reviewer-Return) statt Reviewer-schreibt-beide: unter Slot-Sättigung startet der Reviewer u. U. deutlich nach dem Worker-Return, das P-1-Fenster bliebe also offen — genau das Fenster, das der Fix schließen soll. Verbindlich sind ADR-0024 + [Spec](../superpowers/specs/2026-07-19-for-6-scribe-sidecar-writes.md); dieser Absatz bleibt als Diskussionsstand stehen. FOR-32 ist in dieser Wave gelandet — FOR-6 ist frei.
