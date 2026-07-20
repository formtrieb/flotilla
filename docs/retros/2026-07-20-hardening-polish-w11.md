# flotilla — Retrospektive: Wave 11 „2026-07-20-hardening-polish" (zwölfter Live-Lauf)

Wave: `2026-07-20-hardening-polish` · Rows: **FOR-30, FOR-35, FOR-48, FOR-51** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `02882ec` → `main` nach dem Close: `845c508`.

Besonderheit dieses Laufs: **der erste echte cap=1 Re-Dispatch, der auch gelandet ist** (FOR-30, `changes-requested` → iter-2 → `approve` → gemergt) — bisher endeten alle Waves mit Runde-1-Approvals. Dazu die schärfste Selbstreparatur bisher: die Wave, die die **arm-Degradation** fixt (FOR-51), hat diesen Fix **im eigenen Close** benutzt, um die restlichen Rows zu landen — eine Sequenzierung, die der Mensch am ehrlichen `--auto`-Confirm gewählt hat.

## 0. Ergebnis in einem Satz

Wave 11 lief den vollen Zyklus `wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — 4er-Fan-out → **3× `approve`, 1× `changes-requested` (FOR-30)** → cap=1 Re-Dispatch (iter-2 `approve`, AC3 partial→met) → „FOR-51 zuerst"-Confirm → FOR-51 via `host-pr merge`, pull, dann die 3 übrigen via `host-pr arm` (alle `merged` über FOR-51s brandneuen Fallback-Pfad) → `main 02882ec → 845c508`, Gate **1513 Tests (+26) / tsc 0** → Done-Reconcile 4× `merged` (beide Tiers), `--acked` maschinell → Archiv plain-mv, Claim-Ledger leer, 0 Kern-Interventionen (der eine Re-Dispatch ist Protokoll, keine Intervention).

## 1. Was richtig gut funktioniert hat

- **Der cap=1 Re-Dispatch bewies die Kern-Schleife end-to-end.** FOR-30s Reviewer fand einen *substanziellen* Fund, keinen kosmetischen: der neue `ENGINE_SURFACE`-Detektions-Regex matchte die `*-issues-store.ts`-Wrapper, aber nicht die Transport-Schicht darunter (`real-*-api.ts`, die Factories, `cli-store.ts`) — ein Probe-Logik-Fix, der nur dort ansetzt, wäre der Detektion entwischt (mit dem FOR-23/`real-linear-api.ts`-Präzedenzfall als Beleg). iter-2 erweiterte den Regex byte-identisch in beiden Docs, AC3 partial→met, `approve`. Der iter-2-Worker lief aus **detached HEAD** (der Branch war noch im iter-1-Worktree ausgecheckt), pushte einen neuen Commit, `host-pr create` re-pinnte PR #14 (`reused`, kein Duplikat). Deterministisch geroutet, cap nicht überschritten.
- **FOR-51 validierte sich im eigenen Close.** Der `--auto`-Confirm legte den Bootstrap-Vorbehalt offen (das Armen läuft mit dem *pre-FOR-51*-Code; auf einem allow-auto-merge-OFF-Repo kann das `refused` liefern — exakt die Degradation, die diese Wave fixt). Der Mensch wählte darauf **„FOR-51 zuerst"**: `host-pr merge` FOR-51 → pull → dann `host-pr arm` für die 3 übrigen — und die liefen mit dem gerade gelandeten Fix genau in dessen neuen Pfad: *„PR is clean — arming a clean PR is rejected by the host; the only landing action is a direct merge"* → `merged` ×3. Der Fix bewies sich **einen Commit nach dem Landen**.
- **Der ehrliche Confirm war der Hebel, nicht Zeremonie.** Weil der Confirm den Vorbehalt sichtbar machte, konnte der Mensch die sichere Reihenfolge wählen statt blind alle vier zu armen. Der Human-in-the-Loop hat hier eine echte Entscheidung getroffen, die die Automatik allein falsch gemacht hätte.
- **Konflikt-Topologie als Planungswerkzeug, zweites Mal.** Das Roster war das errechnete maximale unabhängige Set (4 von 8 Kandidaten, beide Hubs FOR-16/FOR-50 und der schwere FOR-52 bewusst zurückgelassen). Conflict-Map ∅ hielt: alle Reviewer sahen 0 Sibling-Merge-Konflikte, die Merges komponierten **additiv bis in die Testzahl** (1487 + 6 + 8 + 12 = 1513).
- **Selbstreparatur-Disziplin, vierte Iteration — diesmal am schärfsten.** Diese Wave änderte wave-close's *eigene* Maschinerie: `host-pr.ts` (FOR-51), `find-repo-root.ts`+`cli.ts` (FOR-48), die `wave-close`/`wave-shared`-Skill-Docs (FOR-30/35). Deshalb strikt **merge → pull-to-completion (sandbox-off, `rev-parse`-verifiziert) → reconcile** — zweimal (nach FOR-51, nach den 3). Der Reconcile lief mit der Engine, die die Wave selbst gebaut hat. Und FOR-48 zeigte seinen Bedarf live: `merge-order` warf die `.scratch/`-Legacy-Warnung genau in dem Lauf, der FOR-48 zum Landen brachte.
- **Done-Reconcile über beide Tiers deckungsgleich.** `read-closing` **und** `host-pr status` meldeten alle vier `merged` (Linear↔GitHub-Integration attachte sauber, Store-Preflight-PASS bestätigt). `--acked` maschinell aus den Verdict-Sidecars — FOR-30 aus **iter-2** (`0,1,2,3`), FOR-51 mit korrekt **ausgeschlossenem deferred-Index** (`0,1,2,4`).

## 2. Funde (nach Schwere)

### 🟢 KLEIN

**W11-F1 — Spine-Plan-Table `Iter`-Zelle + Sidecar-Link bleiben nach einem cap=1 Re-Dispatch stale. → GEFILED als FOR-53.** Der Engine-Scribe schrieb korrekt die iter-2-Sidecars (`FOR-30-2.md`), aber die Plan-Table-Zeile blieb bei `Iter | 1` und der Link zeigte weiter auf `r1`→`v1`; `set-row-state re-dispatched` bumpt beides nicht. Der Resume-Reader nimmt max-iter von Platte (robust, kein Datenverlust) — aber die durable Spine (der WAL) widerspricht den Sidecars, und ein Mensch sieht die iter-2-Runde nicht. Reine Observability-Lücke; Fix-Richtung im Ticket (Iter-Bump + Link-Re-Render über `wave-md-rw`, observability-only, kein neuer Reconciler-Input). Der einzige *neue* Fund des Laufs — und der erste, den überhaupt ein cap=1 Re-Dispatch sichtbar machen konnte.

### 🟢 Wiederholungen

**W11-F2 — Worktree-Cleanup unter Sandbox verweigert (`errors:5, removed:0`) → sandbox-off `removed:5, errors:0`.** Die dokumentierte Ops-Realität (harness-Worktree-Pfade sind schreib-verweigert). Wichtig zur Abgrenzung: **kein ENOTEMPTY-Junk-Fehler diesmal** — der w10-gehärtete Cleaner (Junk-Toleranz/Retry, seit `02882ec` im Anchor) bestand damit sein Live-Gate; die `errors:5` waren reines Sandbox-EPERM, das sandbox-off glatt auflöst.

**W11-F3 — Branch-Delete-Footgun ×4 (W3-F3/W4-F11-Klasse).** Weder `host-pr merge` noch `host-pr arm` löschten den Branch nach dem Merge; alle vier `wave/*` überlebten und wurden manuell per `git push origin --delete` entfernt — danach `git ls-remote` verifiziert (0 Überlebende). Bekannt und im Skill als separater Checked-Step dokumentiert; kein neuer Fund.

**W11-F4 — Stale-LSP-Flut nach Worktree-Removal (~7. Mal), plus „cannot find module"-Churn auf den Spec-Files der gelöschten Worktrees.** Kosmetisch; der gemergte `main` ist sauber (1513/tsc 0 real verifiziert). `.scratch/`-Warning: ihr Killer FOR-48 ist mit diesem Lauf **gelandet** — der nächste `merge-order` sollte sie nicht mehr werfen (W10-F4 geschlossen).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W11-F1** — Spine `Iter`/Sidecar-Link stale nach Re-Dispatch | 🟢 | **GEFILED: FOR-53** (isolated-refactor, wave-ready, DoR PASS) |
| **W11-F2** — Cleanup Sandbox-EPERM ×5 | 🟢 | Ops-Realität (sandbox-off); w10-Cleaner-Härtung Live-Gate **bestanden** (kein ENOTEMPTY) |
| **W11-F3** — Branch-Delete-Footgun ×4 | 🟢 | Bekannt (W3-F3/W4-F11); manuell gelöst + verifiziert |
| **W11-F4** — Stale-LSP ×7 · Spec-Churn · `.scratch/`-Warning | 🟢 | Ersteres bekannt; `.scratch/`-Killer (FOR-48) **jetzt gelandet** → W10-F4 geschlossen |

## 4. Lauf-Metriken (grob)

- **Rows:** 4 (paralleler Fan-out, **Conflict-Map ∅** — zweites Mal). **Verdicts Runde 1: 3× `approve`, 1× `changes-requested`** (FOR-30) → **1 cap=1 Re-Dispatch** (iter-2 `approve`). **Agents:** 16 (Runde 1: 4 Worker + 4 Report-Scribes + 4 Reviewer + 4 Verdict-Scribes) + 4 (Re-Dispatch) = **20/20, 0 Fehler**; ~44 min + ~7 min; ~1,25 Mio. Subagent-Tokens, 391 Tool-Calls.
- **Modelle:** 4× sonnet-Worker (alle isolated-refactor), Reviewer sonnet, Scribes haiku.
- **Landing (`--auto`, „FOR-51 zuerst"):** FOR-51 `host-pr merge` → `merged` → pull → die 3 übrigen `host-pr arm` → **alle `merged`** über den FOR-51-Fallback (clean-PR → arm-rejected → direct-merge). Alle 4 Branches gelöscht **und verifiziert** (0 Überlebende). `main`: `02882ec → 845c508`.
- **Tests:** 1487 → **1513** (+26: FOR-51 +12, FOR-48 +8, FOR-35 +6, FOR-30 docs +0) · `tsc` 0 · **additiv komponiert, auf dem gemergten Tip real re-verifiziert** (nicht nur pro Branch). **ACs: 16 über 4 Rows — final alle met bis auf FOR-51s 1 deferred** (AC3 nach iter-2 met). **Sidecars:** 10 (8 + 2 iter-2), at-agent-return. **Done-Reconcile:** 4× `merged` via Tracker-Attachment **und** Host-Status (beide Tiers), `--acked` maschinell. **Claim-Ledger nach Close:** leer. **Kern-Dispatch-Interventionen:** 0.
- **Backlog danach:** FOR-16 (Hub, 2 Zellen), FOR-49, FOR-50 (Hub), FOR-52 (schwer, cross-feature-refactor) + neu **FOR-53**.

## 5. Meta-Reflexion

Bisher endeten alle elf Läufe mit Runde-1-Approvals — die cap=1-Re-Dispatch-Schleife war getestet, aber nie *im Ernstfall gelandet* gelaufen. Diesmal schon, und der Fund, den sie fing, war substanziell: eine Detektions-Lücke, die eine *echte künftige* Fehlklasse (ein Transport-Layer-Probe-Fix, der der Selbstreparatur-Erkennung entwischt) durchgelassen hätte. Die Schleife find → `changes-requested` → Re-Dispatch → `approve` → landen hat damit ihren Zweck außerhalb der Unit-Tests bewiesen — inklusive der unangenehmen Mechanik-Details (detached HEAD, weil der Branch noch im iter-1-Worktree hing; `host-pr create` re-pinnt idempotent statt zu duplizieren).

Das schärfere Muster ist die **Selbstreparatur, sequenziert vom Menschen am Confirm.** Die letzten drei Retros formulierten dieselbe Lehre — „eine Wave, die ihr Werkzeug verbessert, testet es frühestens beim nächsten Lauf." Diese Wave hat das Muster gebogen: weil der Fix (FOR-51) *und* seine Nutzung (der Close) in denselben Lauf fielen, und weil der ehrliche `--auto`-Confirm den Bootstrap-Vorbehalt zeigte, konnte der Mensch **„FOR-51 zuerst"** wählen — den Fix landen, pullen, dann mit ihm den Rest armen. Der Fix hat sich einen Commit nach dem Merge selbst validiert. Das ist kein Zufall, sondern das, wofür der Human-in-the-Loop-Confirm existiert: nicht Zeremonie, sondern die eine Stelle, an der ein Mensch eine Reihenfolge wählt, die die Automatik allein nicht sieht.

**Vorwärts-Zeiger:** FOR-53 (Iter-Staleness) liegt wave-ready im Backlog; das Rest-Roster dreht sich um die beiden Hubs FOR-16/FOR-50 und den schweren FOR-52 (cross-feature-refactor, grill-gereift, ADR-0023-Amendment) — ein nächster `wave-plan` sollte um die Hubs schneiden. Watch-Items: der `Allow-auto-merge`-Entscheid aus W10-F1 steht weiter aus (auf diesem Repo direkt-mergen die Arms schlicht, weil keine Required Checks — das verdeckt die Frage, ob ein checks-pending-Repo mit aktiviertem Setting den Arm-Pfad durchgängig macht); und FOR-53 als Live-Gate für die Spine-Iter-Kohärenz, sobald es gebaut ist.
