# flotilla — Retrospektive: Wave 25 „2026-07-23-hardening-vendor" (sechsundzwanzigster Live-Lauf)

Wave: `2026-07-23-hardening-vendor` · Rows: **FOR-81 / FOR-82 / FOR-83 / FOR-84 / FOR-85** (Quintett) · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `711aabe` → `main` nach dem Close: `59869f5`.

Dritte Wave des Tages und die größte seit W16 — und die **erste Fünf-Row-Wave unter dem scharfen CI-Gate**: jeder der fünf PRs musste beide Required-Checks bestehen, bevor er landen konnte. Dazu der **erste volle KW-F4-Reconciled-Verify-Durchlauf** vor einem Lane-Tail-Merge und ein Meilenstein außerhalb der Mechanik: mit FOR-85 ist `grill-with-docs` als Projekt-Skill im Repo — **ADR-0010s „no external skill required to be installed" ist zum ersten Mal wörtlich wahr**.

## 0. Ergebnis in einem Satz

Wave 25 materialisierte das Quintett (eine Conflict-Zelle 81×83 auf `.claude/settings.json`, akzeptiert als serielle Landing-Lane; KW-F4-Paar 82+84 mit eingeplantem Reconciled-Verify), der Workflow-Driver `wf_3c5452e3` fuhr **20 Agents in ~22,5 min mit 0 Fehlern** (Worker → Scribe → Reviewer → Scribe, alle 10 Sidecars verb-geschrieben), alle fünf Rows kamen mit **`approve` in Iteration 1** zurück (0 Re-Dispatches), die beiden public-API-Rows stoppten deterministisch am G3-Gate und wurden human-approved, `--auto` landete 82→84→85 order-frei und die Lane 81→83 seriell mit **grünem Reconciled-Verify (1775 Tests, tsc 0) vor dem Tail-Merge**, Done-Reconcile 5× `merged` mit vollem `--acked`, Archiv plain-mv — **Tests 1750→1775, Backlog leer, 0 Kern-Interventionen**.

## 1. Was richtig gut funktioniert hat

- **Fünf parallele PRs unter scharfem Gate, ohne Reibung.** Jeder `host-pr arm` traf einen bereits grünen PR („clean → direct merge") — die CI (~3,5 min pro PR) war durchweg schneller als die Spanne Dispatch→Close. Der `armed`-Pfad blieb diesmal arbeitslos; das ist die erwartbare Arbeitsteilung, kein Defekt: `arm` entscheidet pro PR, und die Ground-Truth ist der Outcome (ADR-0023).
- **Der KW-F4-Gate lief zum ersten Mal vollständig.** `merge-tree` sagte für den Lane-Tail einen sauberen Merge voraus — trotzdem lief das volle Verify-Profil auf der rekonziliierten Vorschau (Detach-Worktree auf `main` + Tail-Branch, frisches `npm ci`, 1775/1775, tsc 0), **bevor** der Tail-PR merged wurde. Genau der Handgriff, der auf der ersten Consumer-Wave 27 Assertions nur durch Glück rettete, ist jetzt Routine.
- **Driver-Komposition per Template + Node-Substitution.** Die Issue-Specs und Briefs wurden nicht handgeschrieben ins Skript interpoliert, sondern via `JSON.stringify` aus den `triage-read`-Bodies eingebettet (Template mit Platzhaltern, Node ersetzt) — die W17-F1-Klasse (Backslash-Apostroph in Single-Quotes) ist damit strukturell wegkomponiert. Das 33,7-KB-Skript parste im ersten Anlauf.
- **G3 hielt, ohne zu nerven.** Beide public-API-`approve`s routeten auf `stop: public-api-approval-required`; der Human-Confirm kam in-Session mit der Verdict-Evidenz auf dem Tisch (Interface-Delta, Implementer-Abdeckung, Sibling-Merge-Tree-Vorhersagen), erst danach liefen die Terminatoren. Kein `needs-attention`-Umweg nötig, weil der Mensch live war — der Flag bleibt das Async-Werkzeug.
- **Convention 8 ist jetzt dreifach verankert — und die Wave fuhr schon damit.** Der gehärtete Klausel-5-Brief (printenv-/env-/settings.local-Verbot) steckte in genau der Wave, die ihn per FOR-81 ins tracked Driver-Doc schrieb: Brief (Session) + Doc (tracked) + `permissions.deny` (strukturell). Kein Worker, Reviewer oder Scribe produzierte auch nur ein wertnahes Echo.
- **Brainstorm→Landung same-day.** Die Vormittagsfrage „wie umgehen mit Metts Grill-Skill-Dependency?" entpuppte sich beim Kontext-Graben als **entschieden-aber-nie-ausgeführt** (ADR-0010, CHARTER: „grill … ships ~as-is"); die Seed-Quelle wurde bewusst gewählt (Operator-Install statt Upstream-Stub — Upstream hat `grill-with-docs` inzwischen zu einem Zweizeiler auf `/grilling`+`/domain-modeling` zerlegt und beide FORMAT-Dateien entfernt — und statt des schwächeren `_context`-Snapshots), FOR-85 same-day gefiled und abends im Repo. PROVENANCE §2 trägt Re-Seed, Upstream-SHA und den Fork-Vermerk.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W25-F1 — `erroredStillListed` ×5 in der Wave, die den Retry-Fix shippt — und ein neues Detail der Orphan-Klasse.** Der Cleanup lief naturgemäß am Anchor-Checkout, also **ohne** den in derselben Wave landenden bounded Retry — und gegen die eigentliche Ursache (Sandbox-Write-Deny auf `.claude/worktrees/**`) hilft auch ein Retry nicht; das Residual bleibt der bewusste Mensch-Schritt (W22-F1-Grill-Ergebnis, bestätigt). **Neu** ist der Mechanismus der Leichen: die Engine löscht die `.git`-Datei des Worktrees, *bevor* das Deny den Rest stoppt — danach verweigert `git worktree remove` mit „validation failed: `.git` does not exist", obwohl der Worktree noch registriert ist. Auflösung: `rm -rf` + `git worktree prune`, sandbox-off. Ticket-Kandidat: Removal-Ordnung im Remover (`.git`-Datei **zuletzt** löschen) oder die half-removed-Klasse explizit ausweisen — ein gescheiterter Removal bliebe dann ein gültiger Worktree, den git selbst noch entfernen kann. Das eigentliche **FOR-84-Live-Gate** (erstes `retried`-Feld in freier Wildbahn) ist damit weiterhin offen — der Fix ist erst ab jetzt live.

### 🟢 KLEIN

**W25-F2 — `worktree-cleanup` nimmt kein `--config`.** Ein angehängtes `--config <pfad>` wird still als `<repo-root>`-Positional konsumiert; der Fehler manifestiert als ENOTDIR auf einem konkatenierten Phantasie-Pfad. Es ist die einzige store-nahe CLI-Oberfläche ohne `--config`-Toleranz — Kandidat: unbekannte Flags ablehnen (fail loud) oder `--config` akzeptieren-und-ignorieren, Uniformität mit allen Geschwister-Verbs.

**W25-F3 — Die `ac-files-coverage`-Heuristik kennt keine Gate-ACs.** Die Standard-Verify-Floor-AC („npm test / npm run typecheck grün") triggert das Warn „npm-Script erwähnt, `package.json` nicht in Files" — dem zu folgen würde False-Positive-Conflict-Zellen mit *jeder* anderen Row erzeugen, die dieselbe Standard-AC trägt. Zweimal in dieser Wave-Vorbereitung bewusst nicht befolgt. Kandidat: die Heuristik unterscheidet Run-only-ACs (Gates) von Change-ACs.

**W25-F4 — `NODE_USE_ENV_PROXY` steht jetzt im tracked env-Block** (FOR-83): das dokumentierte Per-Call-Prefix vor Engine-Aufrufen ist ab der nächsten Session potenziell redundant. Prüfen, dann Doku/Briefs entschlacken — bis dahin ist die Doppel-Quelle harmlos (Prefix gewinnt nie *gegen* den Block, beide setzen dasselbe).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W25-F1** — Remover löscht `.git` vor dem Deny-Stopp (half-removed-Orphans) | 🟡 | Ticket-Kandidat nächste Planung; FOR-84-Live-Gate offen |
| **W25-F2** — `worktree-cleanup` ohne `--config`-Toleranz | 🟢 | Ticket-Kandidat (klein) |
| **W25-F3** — Heuristik: Gate-ACs vs. Change-ACs | 🟢 | Ticket-Kandidat (Heuristik) |
| **W25-F4** — Proxy-Prefix vs. tracked env-Block | 🟢 | Prüf-Aktion nächste Session |

## 4. Tagesschluss

Der 23. Juli 2026 endet bei **drei Waves (W23/W24/W25), acht gelandeten Issues, neun PRs (#58–#66) und einem Repo, das morgens noch keine CI hatte und abends fünf parallele PRs durch ein scharfes Gate schleuste**: Required-Checks im Ruleset, beide Landing-Seam-Zweige gefeuert, `main` von `d4649d7` auf `59869f5`, **1750→1775 Tests**. Der Preflight liest jetzt Rulesets, die Secret-Echo-Klasse hat ihren strukturellen Anker, der Cleanup seinen bounded Retry, die Settings ihren env-Block — und die Pipeline shippt ihr Grill-Werkzeug selbst. **Backlog leer**; offen bleiben die vier W25-Fund-Kandidaten und das FOR-84-Live-Gate.
