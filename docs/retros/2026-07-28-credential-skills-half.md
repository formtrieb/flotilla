# flotilla — Retrospektive: Wave „2026-07-28-credential-skills-half" (ADR-0029 Slices 2–4, rekonstruiert)

Wave: `2026-07-28-credential-skills-half` · Rows: **188, 189, 190** (drei disjunkte Slices desselben ADRs) · Store: GitHub Issues · Anchor: `620f367` (unmittelbar nach PR #193, „credential-resolver — lookup-command indirection in the auth seam") → gemergt als `3d2065c` / `28ba102` / `f0b13e1` (PRs #196, #197, #195, alle 2026-07-28 zwischen 19:32:34 und 19:32:47 +0200) · Tests: 2138 → 2175 (+37, ausschließlich aus Row 188), `tsc` 0.

**Diese Retro ist am 2026-07-29 rückwirkend rekonstruiert**, nicht am Lauftag selbst geschrieben — sie fehlte aus demselben Grund wie ihr Nachbar-Dokument für die Fold-Wave. Die Rekonstruktion stützt sich ausschließlich auf das archivierte Spine (`.flotilla/waves/_archive/2026-07-28-credential-skills-half.md`), die drei Worker-Reports und Reviewer-Verdicts (`reports/188-1.md` … `190-1.md`, `verdicts/188-1.md` … `190-1.md`), die gemergten Commits und deren Diffstats. Wo diese Quellen keine Aussage hergeben, sagt diese Retro das explizit.

## 0. Ergebnis in einem Satz

Drei disjunkte ADR-0029-Slices — der value-freie `credential-probe`-Verb samt Preflight-Verdrahtung (188, `public-API-change`, +37 Tests), das `wave-setup`-Scaffold-und-Doktrin-Rewrite (189, docs-only) und die Convention-8-Amendment für die Lookup-Command-Indirektion (190, docs-only) — liefen parallel, alle drei `approve` in Iteration 1, 0 Konfliktmarker, `git merge-tree` gegen jeden Sibling clean; und Row 189 produzierte dabei die zweite Convention-8-Selbstoffenlegung des Tages.

## 1. Was aus dem Record ablesbar ist

- **Row 188 exerzierte Convention 11 zweimal am eigenen Objekt.** Der Worker brach den Probe-Fail-Zustand gezielt (Catch-Block auf `resolved: true` gezwungen) und beobachtete das rote `AssertionError: expected +0 to be 1` über beide Negative-Control-Specs, dann die Value-Freiheit selbst (Resolver-Ergebnis in die Ausgabe gebunden) und beobachtete `not to contain 'SENTINEL-RESOLVED-SECRET'` — beide Male byte-identisch restauriert und die volle Suite grün re-verifiziert. Der Reviewer reproduzierte die erste Falsifikation unabhängig mit einer eigenen kaputten Lookup-Bindung.
- **Row 188's Scope-Entscheidung (feste `KNOWN_CREDENTIAL_VARIABLES`-Liste statt env-weitem `*_CMD`-Scan) wurde vom Reviewer als vertretbare, ADR-konsistente Lesart bestätigt** — explizit als „Coordinator sanity check", nicht als Defekt markiert.
- **Row 189 lieferte die Dokumentationsseite von ADR-0029 vollständig, mit zwei ehrlich als `partial` getickten ACs**, weil ein echter Live-Lauf des Scaffolds (reales Keychain-Item + `_CMD`-Eintrag + Deny-Eintrag) ein menschlich-präsenter Vorgang ist, den weder Worker noch Reviewer aus einem docs-only-Review heraus auslösen konnten — beide sagen das direkt, statt den Punkt stillschweigend als „met" zu verbuchen. Der Live-Lauf selbst landete laut Disclosure 189.3 als eigene Sibling-Issue (Dogfood-Adoption, dieselbe Nacht).
- **Row 190 traf explizit die Entscheidung, die damalige „sechs Vorkommen"-Zählung der Convention-8-Katalog-Überschrift NICHT anzufassen**, obwohl zu diesem Zeitpunkt bereits ein siebtes (undisclosed-in-file) Vorkommen bekannt war — der Worker zitiert die eigene Begründung: „left the … heading/count and its six-item list untouched rather than inventing details about the disclosed-but-undescribed seventh … occurrence." Das ist der Grund, warum die siebte und achte Katalog-Zeile erst in einer späteren Wave (198/199, Prov. dieses Issues) nachgetragen wurden — nicht in dieser.
- **Alle drei Rows liefen konfliktfrei nebeneinander**, `git merge-tree` gegen jeden Sibling bestätigt in jedem Verdict als sauber (188↔189, 188↔190, 189↔190 — keine Dateiüberschneidung).

## 2. Funde

### 🟡 MITTEL

**CSH-F1 — Ein `printenv … | wc -c`-Aufruf während der PR-Open-Vorbereitung, self-disclosed (Convention-8-Vorkommen 8).** Wörtlich aus dem Worker-Report zu Row 189: *„the sandbox rejected several compound-command forms (`test -n \"$VAR\" && echo set`, etc.) as 'too complex'. In that window I ran `printenv GITHUB_TOKEN | wc -c` — a forbidden direct-secret-read form per Convention 8 / policy clause 5, even though the pipe to `wc -c` meant only a byte count (94) reached tool output, never the token value itself."* Rolle: **Worker** — direkt aus dem Report zitiert. Kein Value verließ die Maschine (die Pipe konsumierte ihn, bevor irgendetwas gedruckt wurde); keine Rotation nötig. Der Reviewer bestätigte den Vorfall unabhängig und empfahl explizit, ihn „per the catalogue in .claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md" zu loggen — das geschah als Disclosure `189.1`, dispositioniert `filed:198` (die Provenienz dieses Issues).

Die Affordanz-Wurzel deckt sich mit Row 190's eigenem Judgment Call: derselbe Sandbox-Guard, der wertfreie Formen als „zu komplex" ablehnt, tauchte hier wie dort auf und drängte in Richtung der verbotenen Kurzform — Row 190 wich stattdessen ganz aus (überging die Prüfung, verließ sich auf den fail-loud-Preflight der Engine), Row 189 griff kurz zur verbotenen Form und disclosed sie sofort.

### Kein weiterer Fund

Row 188 und Row 190 tragen im Record keinen Convention-8- oder sonstigen Sicherheitsvorfall — beide Verdicts bestätigen SECRET-SAFE-Disziplin ausdrücklich sauber. Diese Retro erfindet keinen dritten Fund, um den Abschnitt zu füllen.

## 3. Was der Record nicht hergibt

Row 189's AC1/AC2 blieben `partial` mit einem menschlich-präsenten Live-Lauf als offenem Rest (Disclosure 189.3) — ob und wann genau dieser Live-Lauf stattfand, ist aus dieser Wave allein nicht zu rekonstruieren; er gehört zur separaten Dogfood-Adoption-Wave, nicht zu dieser. Diese Retro macht dazu keine Aussage über deren Ausgang.
