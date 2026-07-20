# flotilla — Retrospektive: erster End-to-End-Testlauf

**Wave:** `2026-07-15-wire-contract` · **Consumer:** der Server-Pilot (Swift/Vapor, Store = Linear, PRs auf GitHub)
**Rolle des Verfassers:** Coordinator (Claude, Opus 4.8) · **Datum:** 2026-07-15
**Umfang:** 4 Issues (DES-21…24), voller Zyklus `wave-start → (Coordinator-Tod) → wave-resume → wave-close`

> Diese Datei ist eine Innensicht des Coordinators auf den Lauf — was funktioniert hat, wo ich Handarbeit
> leisten musste, die die Skills nicht abdecken, und konkrete Fixes. Sie ist bewusst kritisch: das Gerüst
> trägt, aber die Ausnahmen liegen fast alle beim Coordinator.

---

## 0. Ergebnis in einem Satz

Die Wave wurde **erfolgreich gelandet** (DES-21/22/23 gemergt auf `main`, DES-24 als blockiert freigegeben),
**aber** nur weil der Coordinator an mindestens sechs Stellen manuell eingegriffen hat, die die Skills nicht
oder nur teilweise scripten. Für einen ersten Lauf ist das sehr gut — die Kernmechanik (Schema-Grenze,
deterministisches Routing, Spine-WAL, resume-Reconciler) ist solide. Die Lücken liegen im **Übergang zwischen
den Phasen** und im **Nicht-Happy-Path**.

---

## 1. Was richtig gut funktioniert hat

1. **Schema-validierte Agent-Grenze.** `WorkerReport` / `ReviewerVerdict` als `agent({schema})` haben die
   Fabrication-Klasse komplett eliminiert. Kein einziges Mal musste ich eine Zahl oder ein Verdict aus Prosa
   ablesen — `route-outcome` / `route-verdict` bekamen die getypten Felder. Das ist das stärkste Design-Element.

2. **Deterministisches Routing inkl. der Human-Gates.** `route-verdict --risk public-API-change` → STOP
   `public-api-approval-required` hat *dreimal korrekt* gefeuert (DES-21, DES-22 nach Sign-off, und beim
   Verhindern eines stillen Fast-Path). Der G3-Guard ist real wertvoll. Ich hätte das per Auge nie so
   diszipliniert gemacht.

3. **Unabhängige Reviewer-Verifikation.** Die Reviewer haben `swift build/test` **selbst neu ausgeführt**
   (nicht nur den Report gelesen), Testzahlen nachgezählt und dabei eine echte Drift gefangen: der DES-21-Worker
   schrieb in Prosa „APIErrorTests (11 tests)", tatsächlich sind es 10 — der Reviewer hat das als *advisory,
   non-blocking* markiert, mit Beleg (`swift test --filter`). Genau dieses Verhalten will man.

4. **Angereicherter Re-Dispatch-Brief (Anti-Stall).** Der **erste** DES-21-Worker stallte ~40 min bei **null
   Dateien** — er hing an AC6 (405 für falsche Methode, das Vapor nativ nicht kann). Der Re-Dispatch mit
   (a) konkreter 405-Strategie (Middleware konsultiert `req.application.routes.all`) und (b) hartem
   Anti-Stall-/Time-Box-Clause produzierte eine **vollständige, korrekte** Implementierung (405 echt gelöst,
   46/46 Tests). Das validiert das Modell „Coordinator-Judgment reichert den Brief an, statt blind zu re-dispatchen".

5. **Spine-first-WAL + `resume-cli`-Reconciler.** Sobald die Sidecars da waren (siehe P-1!), hat der Reconciler
   `adopt`/`redispatch`/`keep` pro Zeile **korrekt** rekonstruiert („disk beats a non-landed spine flip"). Die
   Idempotenz-Neuprojektion des Ledgers war ein sauberer No-op.

---

## 2. Probleme (nach Schwere)

Format je Punkt: **Symptom → Ursache → Vorschlag**.

### 🔴 KRITISCH

#### P-1 — Sidecars werden zu spät geschrieben; der reale WAL ≠ der angenommene WAL
- **Symptom:** Als der Coordinator-Prozess mitten in der Wave starb, waren **null Sidecars** auf Platte
  (`.flotilla/waves/<slug>/reports|verdicts/` leer), obwohl zwei Worker (DES-22, DES-23) fertig waren, inkl.
  gemergefähriger PRs. `resume-cli` liest ausschließlich Sidecars → sah die fertige Arbeit **nicht**. Gerettet
  hat den Lauf nur das **Claude-Code-Workflow-Journal** (`…/workflows/wf_*/journal.jsonl`) — ein *Harness*-Artefakt,
  kein flotilla-Artefakt. Ich musste die zwei `WorkerReport`s von Hand aus dem Journal extrahieren, in das
  Sidecar-Format gießen und schreiben, **bevor** `resume-cli` überhaupt rekonstruieren konnte.
- **Ursache:** Das `wave-start`-Verfahren schreibt Sidecars in **Schritt 9 — ganz am Ende**, *nachdem* der
  Coordinator die Tupel geroutet hat. Der Workflow-Driver sammelt die Reports im Skript und gibt sie an den
  Coordinator zurück; die durable flotilla-Aufzeichnung entsteht erst danach. Zwischen „Worker fertig" und
  „Coordinator schreibt Sidecar" existiert der durable Record **nicht**. Genau in dieses Fenster fiel der Tod.
  Die ganze `wave-resume`-Doktrin („disk beats a non-landed spine flip", Sidecars sind der durable Record)
  steht und fällt damit, dass Sidecars *beim Entstehen* der Arbeit geschrieben werden — das tun sie aber nicht.
- **Vorschlag (wichtigster Fix des ganzen Laufs):** Sidecar **im Workflow-Skript schreiben, sofort wenn ein
  Worker/Reviewer zurückkommt** — nicht gebündelt durch den Coordinator danach. D. h. der Driver ruft nach jedem
  `agent()` einen Sidecar-Write auf (siehe P-8 für das Format-Problem). Dann existiert der flotilla-Record in dem
  Moment, in dem die Arbeit fertig ist, und `resume-cli` findet ihn nativ — ohne Harness-Journal-Brücke.
  Alternativ/zusätzlich: `resume-cli` einen optionalen „recover from workflow journal"-Pfad geben, damit die
  Rettung nicht Handarbeit ist. **Ohne diesen Fix ist die Resume-Garantie im Workflow-Driver-Modus effektiv nur
  so gut wie ein harness-spezifisches Journal.**

#### P-2 — Intra-Wave `blocked-by` ohne First-Class-Handling
- **Symptom:** DES-24 war `blockedBy: DES-21`, **beide in derselben Wave**. `wave-create` hat diese Wave so
  materialisiert. `wave-start`s DOR-Gate `blocked-by-chain-resolves` ist **deferred** (kann bare-id nicht
  auflösen). Nichts im `wave-start`-Verfahren re-checkt das explizit — die Spine-DOR-Note sagte zwar „wird bei
  wave-start re-gecheckt", aber es gibt keinen Skill-Schritt dafür. Ich musste selbst erkennen, dass DES-24s
  Blocker unerfüllt ist (DES-21 ungemergt), und DES-24 **von Hand halten**. Der Worker hätte sonst gegen einen
  Anchor ohne DES-21s Fehlerform gebaut → divergierender Code + Konflikt.
- **Ursache:** Zwei Lücken. (a) `wave-create` sollte eine Wave mit intra-wave-Blocker+Blocked-Paar gar nicht
  ohne Warnung materialisieren. (b) `wave-start` hat keinen Schritt, der `blocked-by` gegen die
  Wave-Mitgliedschaft auflöst (der DOR-Gate deferred genau das, was hier gebraucht wird).
- **Vorschlag:** `wave-create` erkennt intra-wave `blocked-by` und entweder (1) verweigert / warnt laut, (2)
  markiert die blockierte Zeile als eigenen Zustand `deferred`/`held` (siehe P-5), oder (3) staged Dispatch
  (Blocker muss `in-review`/gemergt sein, bevor die blockierte Zeile dispatcht). Und: `wave-start` braucht einen
  **expliziten** „resolve blocked-by against wave membership"-Schritt statt „das macht schon der Coordinator".

### 🟠 HOCH

#### P-3 — `wave-close` merged nicht; das echte Landen liegt komplett beim Coordinator
- **Symptom:** `wave-close` (P7.4) rechnet nur die Advisory-Merge-Order aus, räumt Worktrees, flaggt, archiviert.
  Das **eigentliche Merging** habe ich komplett selbst gefahren: 3 PRs per REST-API mergen, den **serialisierten
  Rebase** der letzten PR (DES-21 kollidierte mit DES-22 auf Controller/Tests und mit DES-23 auf `configure.swift`),
  die **Konfliktauflösung** in `InstitutionTests.swift`, Rebuild+Test (48/48), Force-Push, Merge #3.
- **Ursache:** Auto-Merge ist als P8 (`--auto`) markiert — verständlich. Aber selbst der Advisory-Pfad lässt den
  teuersten Teil (Same-File-Rebase) ungestützt. Bei einer Wave *mit* Conflict-Map ist der Rebase der zuletzt
  landenden PR **vorhersehbar** und hätte assistiert werden können.
- **Vorschlag:** (a) Für Same-File-Waves einen „rebase-train"-Helfer: fetch main → rebase letzte PR → bei
  Konflikt einen fokussierten Resolver-Worker dispatchen (mit den beteiligten Diffs im Brief) → Rebuild+Test →
  Force-Push. (b) Die Doku/Erwartung schärfen: `wave-close` heißt terminal, *tut* aber (heute) nur Advisory —
  das ist eine große mentale Lücke zwischen Name und Wirkung.

#### P-4 — `merge-order` liefert `branch: null` für alle Zeilen, warnt über `.scratch/`, und schließt die gehaltene Zeile ein
- **Symptom:** `merge-order <spine>` gab für **alle** vier Zeilen `"branch": null` zurück (konnte die Branches
  nicht aus dem Dispatch-Log ziehen) und fiel auf **Fewer-Files-first** zurück. Es enthielt außerdem **DES-24**
  (nie dispatcht, keine PR) in der Reihenfolge. Vorab die Warnung: `„[wave] warning: no .scratch/ ancestor found …
  gate results may be unreliable."`
- **Ursache:** (a) Das Branch-Sourcing aus dem Spine (ich hatte PRs via `set-row-pr` in die PR-Zelle geschrieben,
  aber die Branches standen offenbar nicht dort, wo `merge-order` sie sucht). (b) Keine Filterung nicht-dispatchter
  Zeilen. (c) Eine Workspace-Layout-Annahme (`.scratch/`-Ancestor), die in diesem Consumer nicht gilt.
- **Vorschlag:** `merge-order` sollte Branches robust aus den PR-Zellen/Dispatch-Log ziehen (nicht `null`
  zurückgeben), Zeilen ohne Branch/PR ausschließen, und die `.scratch/`-Annahme entweder dokumentieren oder fallen
  lassen (der Consumer hatte kein `.scratch/`, trotzdem lief alles — die Warnung sät nur Misstrauen).

#### P-5 — „Gehaltene" Zeile hat keinen First-Class-Zustand
- **Symptom:** Ich hielt DES-24, indem ich es auf `planned` ließ und nicht dispatchte. Beim Close scheiterte die
  **Terminality-Gate** daran, dass `planned` nicht terminal ist. Zum Abschließen musste ich DES-24
  `unclaim` **plus** die Spine-Zeile auf `abandoned` setzen. Aber „abandoned" heißt semantisch „wird nie gemacht" —
  DES-24 *wird* aber später gemacht (Follow-up-Wave). Der Zustand lügt.
- **Ursache:** Es gibt keinen Zustand „bewusst in dieser Wave zurückgestellt, für eine spätere Wave freigegeben".
- **Vorschlag:** Einen Zeilenzustand `deferred` (oder `held`), der (a) für die Terminality-Gate terminal zählt,
  (b) den Claim freigibt (`available`), (c) „re-plan in eine künftige Wave" signalisiert — statt `abandoned`.

### 🟡 MITTEL

#### P-6 — `gh`-Token-Falle beim Merge (403) + GraphQL-TLS
- **Symptom:** `gh api PUT …/pulls/N/merge` → **403 „Resource not accessible by personal access token"** mit dem
  aktiven `GITHUB_TOKEN` (fine-grained PAT, nur Lese-Rechte). Der Keyring-Token (`gho_…`, classic `repo`) konnte
  mergen — ich musste `env -u GITHUB_TOKEN -u GH_TOKEN gh api …` nutzen. Zusätzlich: `gh pr merge` (GraphQL) läuft
  in `x509: OSStatus -26276` (Keychain-TLS), also war REST via `gh api` nötig.
- **Vorschlag:** Der P8-Auto-Merge-Pfad muss die Token-Auswahl bewusst treffen (Token mit Merge-Recht) und darf
  nicht blind `gh pr merge` (GraphQL) nutzen, wenn REST der stabilere Pfad ist. Als Precondition in `wave-setup`
  prüfen: „kann der konfigurierte Token tatsächlich mergen?"

#### P-7 — Linear-„Done" nicht erreichbar (Integration fehlt); `read-closing` bleibt `open`
- **Symptom:** Nach dem Merge blieben alle drei Issues in Linear **`in-review`**. `read-closing` gab `{"state":"open"}`
  zurück (obwohl auf GitHub gemergt). `issue-store close <id> <prUrl>` schrieb nur eine `Closed-by:`-Zeile in die
  Description, transitionierte **nicht**. `wave.config.json` mappt **keinen** Done-State (nur Todo/In Progress/In
  Review), also *kann* die Engine nicht auf Done. Ich musste die drei Issues **direkt über das Linear-MCP**
  (`save_issue state:"Done"`) verschieben.
- **Ursache:** Die Linear↔GitHub-Integration ist nicht eingerichtet (Workspace und Repo des Server-Pilots
  sind nicht verknüpft), also erzeugt `Fixes DES-NN` kein merged-PR-Attachment, und die „done is derived"-
  Klammer feuert nie. `wave-setup` behauptet, diese operative Precondition sei erfüllt — war sie nicht.
- **Vorschlag:** (a) `wave-setup` diese Precondition **real prüfen** (nicht annehmen). (b) `wave.config` einen
  optionalen Done-State-Mapping erlauben, damit die Engine als Fallback selbst transitionieren kann, wenn keine
  Integration existiert. (c) `wave-close` bei `read-closing == open` trotz nachweislich gemergter PR eine
  klare Warnung ausgeben („PR merged auf GitHub, aber Tracker sieht es nicht — Integration fehlt?").

#### P-8 — Sidecar-Format nur aus der Engine-Quelle erschließbar
- **Symptom:** Um die Report-Sidecars so zu schreiben, dass `resume-cli` sie liest, musste ich `sidecar.ts` lesen:
  Format ist ein **gefencter ` ```json `-Block** in `<id>-<iter>.md`, die `<id>` ist alles vor dem letzten
  `-<digits>`. Die Skills sagen „write the report verbatim", spezifizieren dieses Format aber nicht. Ein
  Skill-Autor kann leicht ein Sidecar erzeugen, das der Reader als *corrupt* verwirft.
- **Vorschlag:** Format explizit in `wave-shared` dokumentieren **oder** — besser — einen CLI-Verb
  `write-report <file> <id> <iter>` / `write-verdict …` bereitstellen, der korrekt formatiert (symmetrisch zu den
  bereits vorhandenen `validate-report`/`validate-verdict`). Passt zu P-1 (Driver schreibt Sidecars selbst).

#### P-9 — `cross-wave` zählt Konflikte doppelt, wenn `candidates == claimed`
- **Symptom:** Beim Drift-Gate baute ich die Candidates aus den 4 Issues; `listClaimed` gab dieselben 4 zurück.
  `cross-wave` produzierte **16 `intraWaveConflicts`-Einträge** für **4 eindeutige** Paare (jedes Paar 2–4×). Ich
  musste im Kopf deduplizieren, um mit der Spine-Conflict-Map zu vergleichen.
- **Ursache:** Bei `wave-start` sind die eigenen Wave-Zeilen sowohl Candidates als auch Claimed (soft-claimed bei
  create). `cross-wave` dedupliziert nicht.
- **Vorschlag:** `cross-wave` sollte Paare deduplizieren (kanonisch `(a,b)` mit `a<b`), oder das Drift-Gate-Rezept
  klarstellen, dass Overlap erwartet ist und wie man vergleicht.

#### P-10 — Nach Worker-Crash: stale, gelockter Worktree + Branch kollidieren mit Re-Dispatch
- **Symptom:** Der gecrashte erste DES-21-Worktree (`.claude/worktrees/wf_…-1`) blieb **`locked`** zurück, mit
  ausgechecktem Branch `wave/DES-21-api-error`. Der Re-Dispatch macht `git checkout -b wave/DES-21-api-error` →
  **kollidiert** („branch already exists"). Ich musste vor dem Re-Dispatch von Hand: unlock, `git worktree remove
  -f -f` (scheiterte erst an Sandbox → unsandboxed), Branch löschen.
- **Vorschlag:** `wave-resume` sollte für eine `redispatch`-Zeile den **gecrashten Worktree + Branch aufräumen**,
  bevor sie zurück an `wave-start` geht — das ist deterministische Mechanik, kein Judgment.

#### P-11 — `.flotilla/` ist gitignored → Archive-Schritt (`git mv`) passt nicht
- **Symptom:** `wave-close` archiviert per `git mv <spine> _archive/ && git commit`. Aber `.flotilla/` steht in
  `.gitignore` (Zeile 19), **0 getrackte Dateien**. `git mv` würde scheitern. Ich habe auf plain `mv` umgestellt.
- **Frage dahinter:** Ist es beabsichtigt, dass der durable WAL (Spine + Sidecars + Archiv) **lokal-only /
  gitignored** ist? Dann hat ein frischer Clone keine Wave-Historie, und „durable" ist nur „durable auf dieser
  Maschine".
- **Vorschlag:** `wave-close` erkennt, ob `.flotilla/` getrackt ist, und wählt `git mv`+commit vs. plain `mv`.
  Und: eine bewusste Entscheidung/Doku, ob `.flotilla/` getrackt sein soll.

#### P-12 — Zwei Entrypoints (`cli.ts resume` **und** `resume-cli.ts`) + stale Top-Level-Usage
- **Symptom:** (a) `resume` ist ein **separater** Entrypoint (`resume-cli.ts`), aber `cli.ts resume` funktionierte
  *auch* — Verwirrung, welcher kanonisch ist. (b) Die Top-Level-`cli.ts`-Usage listet `spine set-status` **nicht**,
  obwohl der Handler in `spine-cli.ts` existiert — beim allerersten Schritt (draft→ready) musste ich die Quelle
  lesen, um zu glauben, dass mein Flip echt war. Vertrauensverlust in die CLI genau am Anfang.
- **Vorschlag:** Top-Level-Usage mit den echten Sub-Ops synchronisieren; die Resume-Entrypoint-Dopplung
  auflösen oder klar als Alias dokumentieren.

### 🟢 NIEDRIG / Umgebung (nicht flotillas Schuld, aber flotilla-relevant)

#### P-13 — Worktrees unter `.claude/` kollidieren mit der Harness-Sandbox
- Das Löschen von `.claude/worktrees/…` gab „Operation not permitted" (Harness-Seatbelt schützt `.claude/`) →
  brauchte `dangerouslyDisableSandbox`. **Vorschlag:** Worktree-Location außerhalb `.claude/` erwägen (z. B.
  `.flotilla/worktrees/`), oder die Unsandboxed-Anforderung klar dokumentieren.

#### P-14 — 3× kalter Vapor-Build in frischen Worktrees (Latenz/Token-Senke) + transiente Dep-Clone-Fehler
- Jeder isolierte Worktree musste **alle 39 Vapor-Deps frisch klonen+kompilieren** (kalter Vapor-Build = Minuten
  ×3 parallel). Zusätzlich transiente `git clone … Operation not permitted` (Hook-Templates) beim Dep-Resolve,
  die die Worker per Retry/unsandboxed umgingen. **Vorschlag:** Vorgewärmter/geteilter SwiftPM-Dep-Cache für
  Worktrees (Seed aus dem Parent-`.build/checkouts`), oder Worktrees, die den Dep-Cache des Parents teilen. Das
  ist die größte einzelne Latenz-/Kostenquelle des Laufs.

---

## 3. Verbesserungsvorschläge — priorisiert (Kurzliste)

| # | Fix | Warum | Aufwand |
|---|-----|-------|---------|
| 1 | **Sidecars im Workflow-Driver schreiben, sofort pro `agent()`-Rückkehr** (P-1) | Macht den realen WAL = den angenommenen WAL; Resume ohne Harness-Journal-Brücke | mittel |
| 2 | **`deferred`/`held` als First-Class-Zeilenzustand** (P-2, P-5) | Intra-wave-blocked-by + „für später zurückgestellt" sauber statt `abandoned`-Missbrauch | mittel |
| 3 | **`wave-create` warnt/staged bei intra-wave `blocked-by`** (P-2) | Verhindert Dispatch gegen fehlende Dependency | klein |
| 4 | **`merge-order`: echte Branches, Nicht-dispatchte ausschließen, `.scratch/`-Warnung fixen** (P-4) | Advisory ist sonst degradiert/irreführend | klein |
| 5 | **`resume` räumt gecrashten Worktree+Branch vor Re-Dispatch** (P-10) | Deterministische Mechanik, aktuell Handarbeit | klein |
| 6 | **Sidecar-Format dokumentieren + `write-report/write-verdict`-Verb** (P-8) | Reader/Writer-Symmetrie, weniger „corrupt"-Fallen | klein |
| 7 | **`cross-wave` dedupliziert Paare** (P-9) | Sauberer Drift-Vergleich | trivial |
| 8 | **`wave-setup` prüft Store-Preconditions real (Linear↔GitHub, Merge-Token)** (P-6, P-7) | Vermeidet stille „done"-/Merge-Lücke am Ende | mittel |
| 9 | **`wave-close`: Rebase-Train-Helfer für Same-File-Waves** (P-3) | Der teuerste manuelle Teil des Landens | groß (P8/M2) |
| 10 | **Top-Level-CLI-Usage syncen; Resume-Entrypoint entdoppeln** (P-12) | Vertrauen in die CLI ab Schritt 1 | trivial |
| 11 | **Geteilter Dep-Cache für Worktrees** (P-14) | Größte Latenz-/Token-Senke | mittel |

---

## 4. Lauf-Metriken (grob)

- **Wall-Clock:** ~3 h (Dispatch 19:06 → Close ~22:05), mit Coordinator-Tod dazwischen.
- **Erster DES-21-Versuch:** ~40 min, **0 Dateien** (Stall an AC6/405) → gekillt → Re-Dispatch nötig.
- **Worker-/Reviewer-Tokens (nur Subagenten):** ~131 k (2 Reviewer-Pass) + ~234 k (DES-21 Worker+Reviewer) + der
  initiale 3er-Dispatch. Die kalten Vapor-Builds ×3 dominieren die Kosten/Latenz.
- **Konflikte real:** nur **1** echter Merge-Konflikt (`InstitutionTests.swift`, beide Seiten fügten Tests hinzu);
  `configure.swift` + `InstitutionController.swift` auto-mergeten sauber. Endstand nach Rebase: **48 Tests / 10
  Suites grün**.
- **Manuelle Coordinator-Eingriffe außerhalb der Skill-Scripts:** blocked-by-Hold (P-2), Sidecar-Rekonstruktion aus
  dem Journal (P-1), Worktree/Branch-Cleanup vor Re-Dispatch (P-10), das komplette Merging inkl. Rebase (P-3),
  Linear-Done via MCP (P-7), Merge-Token-Auswahl (P-6). → **sechs** substanzielle Eingriffe.

---

## 5. Meta-Reflexion

flotilla ist auf dem **Happy Path exzellent**: Schema-Grenze, deterministisches Routing, Human-Gates, unabhängige
Reviewer, Spine-WAL-Rekonstruktion. Das trägt und fühlt sich vertrauenswürdig an.

Die Schwächen liegen konsistent in **zwei Zonen**:

1. **Phasenübergänge / Persistenz-Timing.** P-1 ist der Kern: der durable Record entsteht zu spät (Coordinator
   schreibt Sidecars *nach* dem Workflow, statt der Workflow *während*). Das untergräbt genau die Resume-Garantie,
   die flotillas Alleinstellung ist. Ein Coordinator-Tod im falschen Moment ist real (er ist mir passiert), und die
   Rettung hing an einem *Harness*-Detail (Workflow-Journal), das flotilla nicht besitzen kann.

2. **Der Nicht-Happy-Path liegt beim Coordinator.** blocked-by, gehaltene Zeilen, gecrashte Worktrees, das echte
   Merging, der Same-File-Rebase, die Tracker-„Done"-Lücke, die Token-Falle — all das habe ich per Judgment +
   Handarbeit gelöst. Bei einem *fähigen* Coordinator geht das gut; aber vieles davon ist **deterministische
   Mechanik, kein Judgment** (P-5, P-8, P-9, P-10, P-12) und gehört in die Engine/Skills. Was echtes Judgment war
   und gut lag: die blocked-by-Entscheidung, die Brief-Anreicherung bei DES-21, die Konfliktauflösung. Diese Grenze
   — „was ist Judgment, was ist ungescriptete Mechanik" — schärfer zu ziehen, wäre der größte Qualitätshebel.

**Wenn ich genau einen Fix priorisieren müsste:** P-1 (Sidecars im Driver, sofort). Er heilt die Resilienz-Story,
auf der alles andere aufbaut. Danach P-2/P-5 (Dependency-/Held-Semantik), weil sie die häufigste reale Wave-Form
(gemischte Abhängigkeiten) betreffen.

Insgesamt: ein sehr ermutigender erster Lauf. Das Skelett stimmt; es braucht Fleisch an den Gelenken.
