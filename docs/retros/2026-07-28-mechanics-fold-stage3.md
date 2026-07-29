# flotilla — Retrospektive: Wave „2026-07-28-mechanics-fold-stage3" (ADR-0028 Stage 3, rekonstruiert)

Wave: `2026-07-28-mechanics-fold-stage3` · Row: **176** (Einzel-Row, bewusst — die Wave läuft dem residualen close-mechanics-Paar {123, 158} allein voraus, per ADR-0028-Amendment 2026-07-28) · Store: GitHub Issues · Anchor: `02d5fee` → gemergt als `dd8fc2f` (PR #178, „refactor(wave-close): fold close-mechanics worked sequences into phase files (ADR-0028 stage 3) (#178)", 2026-07-28 13:21:05 +0200) · Tests: 1976 → 1976 (unverändert — docs-only-Slice), `tsc` 0.

**Diese Retro ist am 2026-07-29 rückwirkend rekonstruiert**, nicht am Lauftag selbst geschrieben — sie fehlte, weil die Wave zwischen zwei größeren Retro-Bögen (Disclosure-Wave davor, Credential-Skills-Wave danach) lief und keine eigene bekam. Die Rekonstruktion stützt sich ausschließlich auf das archivierte Spine (`.flotilla/waves/_archive/2026-07-28-mechanics-fold-stage3.md`), den Worker-Report und Reviewer-Verdict der einen Row (`reports/176-1.md`, `verdicts/176-1.md`), den gemergten Commit `dd8fc2f` und dessen Diffstat. Wo diese Quellen keine Aussage hergeben — z. B. Operator-seitige Beobachtungen während des Laufs, oder etwas, das nur „im Moment" sichtbar gewesen wäre — sagt diese Retro das explizit, statt eine Beobachtung zu erfinden.

## 0. Ergebnis in einem Satz

Eine Einzel-Row-Wave (Issue 176: „Fold close-mechanics into the phase files") lief `create → start → close` sauber durch — 1 Agent-Paar (Worker + Reviewer), `approve` in Iteration 1, 8 Dateien geändert (108 Zeilen eingefügt, 494 gelöscht — netto ein deutlich schlankeres `close-mechanics.md`), 1976 Tests unverändert grün, `tsc` sauber, 0 Konfliktmarker, 0 Re-Dispatches — und ein einziger, selbst offengelegter Convention-8-Vorfall während der PR-Open-Vorbereitung.

## 1. Was aus dem Record ablesbar ist

- **Der Fold selbst war vollständig und mit Ausschöpfung des Diff-Deltas verifiziert.** Der Reviewer bestätigte alle vier ACs mit direkter Beleg-Führung — kein phasennummeriertes Segment blieb doppelt, `close-mechanics.md` behielt nur den Cross-Phase-Rest (CLI-Resolution, Commands-Tabelle, Exit-Code-Tabellen, die beiden JSON-Shapes, Disclaimer), die ADR-0016-Notiz wanderte korrekt nach `phase-4-advisory-merge-order.md`, und jede der acht Phasen-Dateien wurde einzeln auf exakte, nicht nur plausible Übernahme geprüft (u. a. Byte-für-Byte-Abgleich der `phase-5`-Extraktionszeile und des `phase-6`-Idempotenz-Guards gegen die entfernte `close-mechanics`-Fassung).
- **Der Worker ging über die zwei benannten Vorfix-Claims hinaus und löste eine dritte, unbenannte Selbstwiderspruch-Stelle auf** (die alte `gh pr merge --delete-branch`-Fußangel vs. die bereits gewirkte `host-pr merge --delete-branch`-Fassung) — der Reviewer verifizierte die technische Richtigkeit der gewählten Fassung direkt gegen `tools/wave/src/adapters/github/real-github-api.ts:360-374`, statt sie nur für plausibel zu halten.
- **Der einzige offene Punkt im Verdict war menschlich zu entscheiden, nicht mechanisch:** die Convention-8-Selbstoffenlegung (siehe Fund unten) — als „(needs human eyes)" markiert, mit der ausdrücklichen Feststellung, dass kein Wert je gedruckt wurde.

## 2. Funde

### 🟡 MITTEL

**MFS-F1 — Ein `printenv`-Aufruf mit Zielargument während der Token-Verfügbarkeitsprüfung vor `host-pr create`, self-disclosed.** Wörtlich aus dem Worker-Report: *„While checking GITHUB_TOKEN availability before the host-pr create call, I ran `printenv GITHUB_TOKEN >/dev/null 2>&1; echo exit:$?` — printenv is on the explicit do-not-run list under SECRET-SAFE (policy clause 5) regardless of output redirection. No value was ever printed (only an exit code reached my output), but disclosing per the letter of the rule rather than silently moving on."*

Präzise, weil load-bearing für die Convention-8-Katalog-Korrektur, die diese Retro auslöst: die tatsächlich ausgeführte Form war **`printenv GITHUB_TOKEN`** — mit Zielargument, Ausgabe nach `/dev/null` umgeleitet — **nicht** ein argumentloser `printenv` ohne jede Umleitung. Der Reviewer bestätigte den Vorfall unabhängig (eigenes Zitat im Verdict: „the very file being edited (phase-2-auth-preflight.md) states 'no printenv' as an absolute SECRET-SAFE rule regardless of redirection, and that same file's own history records this incident class as having previously cost a credential rotation") und eskalierte ihn als menschlich zu entscheidenden Punkt, nicht als mechanischen Defekt. Rolle: **Worker** — direkt aus dem Report zitiert, keine Ableitung aus einem Muster.

Kein Value verließ die Maschine (Redirect nach `/dev/null`, nur der Exit-Code erreichte die Ausgabe); keine Rotation war nötig. Die Affordanz selbst — `printenv` überhaupt aufzurufen, unabhängig von Umleitung oder Argument — ist trotzdem genau die, die Convention 8 verbietet, und ist damit ein echtes Vorkommen, kein Fehlalarm.

### Kein weiterer Fund

Der Record trägt keine zweite Beobachtung dieser Größenordnung. Die übrigen Reviewer-`reviewerFocusItems` (Phase-3/4-Reconciliation, AC3-Grep-Probe, Phase-5-Transkription, Phase-6-Guard, Convention-7-Link, SKILL.md-Common-Mistakes-Wortlaut) sind allesamt bestätigte Nicht-Funde — der Reviewer schreibt explizit „all check out cleanly — no open item remains on any of them." Diese Retro erfindet keinen zweiten Fund, um den Abschnitt zu füllen.

## 3. Was der Record nicht hergibt

Diese Wave hat keine eigene Randnotiz-Sektion in einer Folge-Retro erhalten (anders als z. B. Wave 34 in `docs/retros/2026-07-27-consumer-gaps-machinery-w32-w33.md`), weil zu ihrem Zeitpunkt keine Retro für sie existierte, die eine hätte tragen können — das ist exakt die Lücke, die diese Datei schließt. Operative Beobachtungen jenseits von Spine, Report und Verdict (z. B. wie lange der Lauf tatsächlich dauerte, ob der Operator zwischen Dispatch und Review am Rechner war) sind aus dem archivierten Record nicht rekonstruierbar und werden hier nicht behauptet.
