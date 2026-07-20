# flotilla — Retrospektive: Wave 8 „2026-07-20-publication-w8" (neunter Live-Lauf)

Wave: `2026-07-20-publication-w8` · Rows: **FOR-39, FOR-40, FOR-41, FOR-42, FOR-43** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `8495dc4` → `main` nach dem Close: `1daf481` (+ selbe Session ein Lizenz-Klarstellungs-PR #45 → `8b1ffbe`).

Besonderheit dieses Laufs: **die Publication-Wave aus ADR-0026 — die letzte private Wave.** Ihre fünf Rows machten den Baum selbst zum Publikationsartefakt: Kern-Docs und Retros de-clientet auf das `Provenance`-Alias-Set, die öffentliche Onboarding-Oberfläche (README · leane CLAUDE.md · `docs/ONBOARDING.md`), das Denylist-Gate, und der tree-is-manifest-Prune. Dieser Retro ist der erste, der **von Geburt an client-frei** geschrieben wurde — und er wurde vor dem Commit durch das in dieser Wave gebaute Gate geprüft.

## 0. Ergebnis in einem Satz

Wave 8 lief den vollen Zyklus `wave-plan → wave-create → wave-start → wave-close` — 5er-Fan-out → **5× `approve` in Runde 1, 0 Re-Dispatches, 0 STOPs, 20/20 Agents, zweiter fehlerfreier Scribe-Lauf** → 5 squash-PRs #44/#41/#42/#43/#40 in Advisory-Order → `main 8495dc4 → 1daf481`, Gate **1443 Tests / tsc 0 / `node --test` 14/14** → alle 5 `done` via Close-Reconcile → Archiv plain-mv — und der Close war zugleich ein dreifaches Live-Gate: **der erste vollatomare `worktree-cleanup`** (Atomicity-Fix der Vorwave, nach fünf Orphan-Repros), **das fail-loud der Konfliktkarte** schon beim Planning, und die **Cut-Generalprobe: `check-client-refs` über 185 tracked Files → 0 Treffer** — der Baum ist das Manifest, und er ist sauber.

## 1. Was richtig gut funktioniert hat

- **Drei Live-Gates in einem Close, alle bestanden.** (1) *Atomicity:* der sandboxed Cleanup schlug mit 5 Fehlern fehl und ließ **alle 5 Registrierungen intakt** — die Vor-Fix-Engine hätte an dieser Stelle 5 deregistrierte Orphans hinterlassen (die Klasse mit fünf dokumentierten Repros); der Sandbox-off-Rerun räumte 5/5, 0 Orphans auf Platte. (2) *Fail-loud:* der Kontrolllauf ohne `--repo-root` warnte laut mit jedem unexpandierten Pattern — die stille 17-vs-40-Zellen-Falle ist tot. (3) *Cut-Gate:* Denylist lokal angelegt (gitignored, per `git check-ignore` verifiziert), Checker über den ganzen Baum: **0 Treffer**.
- **Worker-Judgment über die Buchstaben hinaus, sauber offengelegt.** Der Kern-Doc-Sweep beschränkte sich nicht auf die wörtliche Patternliste: consumer-identifizierende Stack-Nennungen wurden zu Alias-Prosa, Repo-/Workspace-URLs wurden **entfernt statt aliased** (eine URL lässt sich nicht token-substituieren, ohne den Slug zu leaken), ein Verzeichnisdiagramm bekam Pseudo-Pfade, ein wörtliches Zitat aus der bald privatisierten Status-CLAUDE.md wurde zur Paraphrase. Jede dieser Entscheidungen stand in `judgmentCalls` und wurde vom Reviewer einzeln nachgeprüft — generische Stack-Beispiele ohne Consumer-Bezug blieben bewusst stehen.
- **Der Status-Snapshot-Runbook-Schritt lief VOR dem Dispatch.** Die alte Status-Historie wurde ins private Ops-Repo geschnappschusst (`STATUS.md`), bevor die Onboarding-Row die CLAUDE.md lean schrieb — kein Fenster, in dem die Historie nur in Git-History existierte. Session-Status lebt ab jetzt im Ops-Repo, nicht im public Baum.
- **Die Eskalations-Momente waren genau die richtigen.** Beide „needs human eyes"-Flags dieses Laufs (W8-F1 Token, W8-F2 Lizenz) waren Governance-Fragen, keine Code-Fragen — das System riet nicht, es eskalierte. Der Lizenz-Fall ist lehrbuchhaft: der Worker folgte der Repo-Realität statt dem Ticket-Text, der Reviewer verifizierte beide Quellen und legte den Widerspruch dem Menschen vor.
- **Alle gehärteten Vorgänger hielten:** Anchor-Assertion, Brief-Skeleton (`npm ci` + embedded Spec), Dispatch-Log vor Worker-Existenz, `anyOf`-freie Schemas, Convention 4 (5× korrekte Close-Phrase), und die **Mention-Disziplin der Vorwave: alle fünf PR-Titel/-Bodies trugen ausschließlich die eigene Id** — eine Wave nach dem Fund, der sie nötig machte.
- **Der Pull lief sandboxed vollständig durch** — diese Wave berührte keine Skill-Dateien, also griff die dokumentierte Sandbox-Bedingung nicht; die Doku der Vorwave nennt exakt diese Unterscheidung. Vorhergesagt, eingetreten.

## 2. Funde (nach Schwere)

### 🔴 ERNST (User-Aktion)

**W8-F1 — Ein Worker echo'te den Klartext-Host-Token ins lokale Agent-Transkript.**
Der Retro-Sweep-Worker prüfte früh im Lauf die Token-Verfügbarkeit mit einem fehlerhaften `${VAR:-no}`-Diagnose-Echo — und druckte damit den **live `GITHUB_TOKEN`** in seinen agent-sichtbaren Tool-Output (= Session-Transkript auf Platte). Der Worker legte es selbst offen, der Reviewer eskalierte („this review cannot verify or remediate"). Nichts wurde committet, nichts verließ die Maschine — aber Transkripte sind langlebig und werden gelesen. **Konsequenz: Token-Rotation (User-Aktion, empfohlen direkt nach diesem Close)** + Regel-Kandidat für die Shared-Konventionen: *Worker echoen niemals Umgebungsvariablen, auch nicht mit Fallback-Syntax; Verfügbarkeit prüft man mit `[ -n "$VAR" ] && echo set`.* Ticket-Kandidat.

### 🟡 MITTEL

**W8-F2 — Der Grill hatte eine Lizenz behauptet, die das Repo nie trug; aufgeflogen erst, als ein Worker die Realität abschrieb.**
ADR-0026 sagte „MIT" — aber das Repo trägt seit Init Apache-2.0, und PROVENANCE dokumentierte das die ganze Zeit. Der Grill-Optionstext hatte die MIT-*Seed*-Notice-Pflicht (die bleibt) mit flotillas eigener Lizenz vermengt, und niemand prüfte die Behauptung gegen den Baum. Der Onboarding-Worker folgte korrekt der Repo-Realität (README → Apache-2.0), der Reviewer legte den Widerspruch offen, der Mensch entschied: **Apache-2.0 bleibt**; ADR + CHARTER-Index per PR #45 korrigiert, mit Fußnote zur Herkunft des Fehlers. Die Lehre ist die Absence/Assertion-Klasse in der Governance-Etage: **eine Grill-Option, die einen Fakt behauptet, ist ein Prüfauftrag, kein Fakt.**

### 🟢 KLEIN / Wiederholungen

**W8-F3 — Eine AC-Formulierung war auf der Ziel-Node-Version nicht wörtlich ausführbar.** „`node --test scripts/` green" schlägt auf Node 24 als Verzeichnis-Argument fehl (MODULE_NOT_FOUND-Resolver-Quirk); bare `node --test` bzw. die explizite Testdatei liefern die echten 14/14. Worker und Reviewer verifizierten die Substanz mit der funktionierenden Form; die AC-Prosa war das Problem. Invocation-Präzision in ACs: Kommandos, die ein AC nennt, müssen so lauffähig sein, wie sie dastehen.

**W8-F4 — Proxy-Transienten am Host-Seam, beide vom Read-back gefangen.** Ein `status`-Read lieferte einmal `undefined` (der idempotente Re-Call klärte: „already-merged"), ein PR-Create bekam ein 503 (Retry: 201). Keine Engine-Defekte — aber die Bestätigung, dass Merge-Erfolg **nie** aus der ersten Response gelesen wird, sondern aus dem Read-back.

**W8-F5 — Wiederholungen:** Stale-LSP-Flut nach Worktree-Removal (4. Mal); `merge-order`s Legacy-Warning + `fileCount: 0` (unverändert Teil der getrackten Entkopplungs-Restarbeit).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W8-F1** — Token-Echo ins Agent-Transkript | 🔴 | **Rotation = User-Aktion (empfohlen sofort)**; Regel „nie env echoen" = Ticket-Kandidat für die Shared-Konventionen |
| **W8-F2** — Grill-behauptete Lizenz ≠ Repo-Realität | 🟡 | Erledigt in-Session (Entscheid Apache-2.0 + PR #45); Governance-Notiz: Fakten-Behauptungen in Grill-Optionen gegen den Baum prüfen |
| **W8-F3** — AC nennt nicht-lauffähige Invocation | 🟢 | Betriebsnotiz (AC-Hygiene; Substanz war grün) |
| **W8-F4** — Proxy-Transienten am Host-Seam | 🟢 | Betriebsnotiz (Read-back-Disziplin trug) |
| **W8-F5** — Stale-LSP ×4 · Legacy-Warning | 🟢 | Bekannt/getrackt |

## 4. Lauf-Metriken (grob)

- **Rows:** 5 (paralleler Fan-out, Conflict-Map ∅). **Verdicts: 5× `approve` in Runde 1** — 0 `changes-requested`, cap=1 nie berührt, 0 STOPs (keine public-API-Row). **Agents:** 20/20 im einen Workflow (5 Worker + 5 Report-Scribes + 5 Reviewer + 5 Verdict-Scribes), **0 Fehler**; ~20 min; ~1,61 Mio. Subagent-Tokens, 411 Tool-Calls.
- **Modelle:** 5× sonnet-Worker, Scribes haiku, Reviewer sonnet.
- **PRs:** #44 → #41 → #42 → #43 → #40 (Advisory-Order, NN ASC), alle squash; danach #45 (Lizenz-Klarstellung). Alle fünf Wave-Branches gelöscht **und verifiziert** (0 überlebende `wave/*`-Heads). `main`: `8495dc4 → 1daf481 → 8b1ffbe`.
- **Tests:** 1443 unverändert (Docs+Scripts-Wave; kein Engine-Code) · `tsc` 0 · **neu: `node --test` 14/14** (Denylist-Checker: hit/clean/absent). **ACs: 17 über 5 Rows — alle 17 `met` in Runde 1.** **Sidecars:** 10, gestaffelt at-agent-return. **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen:** 0 (fünfter Lauf in Folge ohne Eingriff in Routing/Schema/WAL).
- **Backlog danach:** 7 offen (FOR-16/17/20/27/28/30/35), alle unblockiert.

## 5. Meta-Reflexion

Diese Wave hat das Repo publikationsfähig gemacht, und sie hat es **im eigenen Verfahren** getan: die Slices, die den Baum säuberten, wurden von denselben Schienen dispatcht, reviewt und gelandet, die publiziert werden sollen — und das in der Wave gebaute Gate verifizierte im selben Close den Baum, der es enthält (und diesen Retro, bevor er committet wurde). Der dichteste Selbstbezug bisher, diesmal ohne Peinlichkeit: die einzige gebissene Falle (Token-Echo) wurde vom Beißenden selbst offengelegt.

Die eigentliche Erkenntnis liegt in den zwei Eskalationen: **das System hat gelernt, Governance-Fragen von Arbeitsfragen zu trennen.** Token-Leak und Lizenz-Widerspruch wurden nicht „mitgelöst", sondern präzise dem Menschen vorgelegt — mit verifizierter Faktenlage in beide Richtungen. Gleichzeitig zeigt W8-F2 die Grenze der Grill-Methode: eine Option, die einen Fakt behauptet, wird durch die Wahl nicht wahr. Fakten-Behauptungen in Entscheidungsvorlagen brauchen denselben Read-back wie Merge-Echos.

**Vorwärts-Zeiger:** Der Baum ist clean, das Gate existiert, das Runbook liegt im Ops-Repo — **als Nächstes der Cut selbst** (Rename → frisches Public-Repo → sauberer Initial-Commit → Ops-Remote/Dev-Clone/Tracker-Integration umpointen → Smoke-PR). Danach läuft alles Weitere öffentlich: Rails-Vervollständigung, OSS-Polish, und die geplante Gate-Wave auf dem Public-Tracker-Pfad. Watch-Items: der erste öffentliche Smoke-PR-Zyklus, und die Token-Rotation vor allem Weiteren.
