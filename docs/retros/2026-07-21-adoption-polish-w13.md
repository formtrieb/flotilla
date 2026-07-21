# flotilla — Retrospektive: Wave 13 „2026-07-21-adoption-polish" (vierzehnter Live-Lauf)

Wave: `2026-07-21-adoption-polish` · Rows: **FOR-16, FOR-54, FOR-55, FOR-56, FOR-57** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `9443731` → `main` nach dem Close: `5bcb005`.

Besonderheit dieses Laufs: **beide W12-Live-Gates feuerten und bestanden in derselben Wave** — `host-pr preflight` lief erstmals produktiv als wave-start-Auth-Preflight, und die frisch gelandete Iter-Zellen-Mechanik bewies sich am ersten echten Re-Dispatch danach. Dazu wurde die Same-Number-Kollisionsklasse (W9-F2) zum ersten Mal **zur Compose-Zeit** entschärft statt beim Landing repariert: zwei Rows dokumentierten parallel in wave-shared, die Briefs deklarierten die Nummernvergabe explizit (eine Row pinnt Convention 9, die andere bleibt unnummeriert) — beide Reviewer verifizierten 0 Kollisionen.

## 0. Ergebnis in einem Satz

Wave 13 lief den vollen Zyklus `to-issues (FOR-57) → wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — 5er-Fan-out (FOR-54 auf opus) → **4× `approve`, 1× `changes-requested` (FOR-16: das neue `render-verdict`-CLI-Subcommand hatte 0 Coverage in der CLI-Spec)** → sauberer cap=1 Re-Dispatch mit Coordinator-Scope-Extension via `issue-store annotate` (iter-2 `approve`, +7 Tests) → G3-STOP FOR-54 human-approved (additive Feld-Aliase) → ehrlicher `--auto`-Confirm → arm FOR-54/56/57 (3× sofort `merged`, kein CI), Tail FOR-16→FOR-55 per `host-pr merge` (Merge-Trees clean wie prognostiziert) → `main 9443731 → 5bcb005`, Gate **1581 Tests (+33) / tsc 0** → Done-Reconcile 5× `merged`, `--acked` maschinell (FOR-16 aus iter-2) → Archiv plain-mv, Claim-Ledger leer, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Live-Gate 1 bestanden — die Iter-Zelle wanderte mit dem Re-Dispatch.** FOR-16s Row zeigte nach `spine set-row-iter` sofort `Iter 2` samt `r2→v2`-Sidecar-Links — exakt der Defekt, den W11-F1 fand und W12/FOR-53 fixte, diesmal im Live-Einsatz korrekt. Der Spine blieb über den ganzen Zyklus resume-ehrlich.
- **Live-Gate 2 bestanden — `host-pr preflight` als Posture-Quelle.** Debüt auf dem eigenen Repo: `pr-merge-token` pass, `allow-auto-merge` advisory (kein CI — ehrlich: „Bestätigen heißt sofortiger Merge"), `required-checks` `unknown` (403 — der nach dem Cut zurückgedrehte PAT hat kein Admin; der Check degradiert non-blocking, exakt wie ADR-0023-amendiert entworfen). Tri-State statt geratenem `off`, store-blind.
- **Same-Number-Kollision zur Compose-Zeit entschärft.** Die W9-F2-Klasse (zwei Slices claimen „die nächste freie Nummer" in derselben Liste) wurde diesmal beim Brief-Compose erkannt: FOR-55 pinnt Convention 9 per AC, FOR-16 bekam die explizite Anweisung „unnummeriert oder 10". Beide Reviewer verifizierten per grep 0 Kollisionen — Planungszeit-Prävention statt Landing-Zeit-Renumber.
- **Der Worker legte den Folge-Fund selbst offen.** FOR-16s Worker disclosed unter judgmentCalls präzise, dass `host-pr create`s reused-Pfad den komponierten Body verwirft — inklusive Zeilenverweis und Scope-Begründung (Datei außerhalb der Globs). Der Reviewer verifizierte und eskalierte es als PRIORITY-Focus-Item. Das ist die Wiring-Disclosure-Kultur, die FOR-55 in derselben Wave als Brief-Klausel formalisiert — hier schon gelebt, bevor sie gelandet war.
- **Iter-2 unter der One-Branch-per-Worktree-Constraint, protokollrein (2. Vorkommen).** Der iter-2-Worker fand seine Branch in der iter-1-Worktree ausgecheckt, wich auf `git checkout --detach FETCH_HEAD` + `git push origin HEAD:<branch>` aus — Fast-Forward, Historie intakt, Cap korrekt konsumiert. Das Muster aus W11 (FOR-30) bestätigt sich als sauberer Standardausweg.
- **Scope-Extension über den Seam.** Das iter-2-Wiring brauchte `cli.spec.ts` außerhalb der deklarierten Files — statt Brief-Freitext lief die Erweiterung als `issue-store annotate` (Files-Update auf dem Tracker), sodass DoR/files-drift ehrlich blieben.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W13-F1 — `host-pr create`s reused-Pfad PATCHt den PR-Body nicht → der Verdict-Render erreicht Worker-geöffnete PRs nicht.** FOR-16 verdrahtete den Render in den Terminator-`create`-Call — aber ein PR, den der Worker bei Termination bereits öffnete, trifft den find-before-create-`reused`-Zweig, der die URL re-pinnt und den komponierten `--body` verwirft. Der Render (samt Close-Phrase-Neukomposition) landet damit nie auf dem Live-PR. Von Worker UND Reviewer disclosed; die Auflösung braucht einen Update-on-Reuse-Slice auf `host-pr.ts`/`host-pr-cli.ts`. **→ FOR-58 gefiled (in W14 gelandet).**

**W13-F2 — Worktree-Cleanup: die Junk-Toleranz griff live nicht — dirty-Fehlklassifikation auf deregistrierten Dirs.** Beim Close scheiterte der Prä-FOR-56-Engine erwartungsgemäß mit `errors:6` (7. Reproduktion der ENOTEMPTY-Klasse, Junk-Shape exakt W12-F2). Nach merge→pull lief der frisch gemergte FOR-56-Engine erneut — und **skippte alle 6 als `dirty:true`**: Git hatte die Worktrees deregistriert (`prunable`), ein `git status` in einem deregistrierten Dir löst zum **Eltern-Repo** auf, und dessen eine ungetrackte Datei (die neue `settings.json`) machte jede Klassifikation dirty. Der Purge-Pfad feuerte nie; dazu tragen `skipped[]`-Einträge kein `reason`-Feld. Manuelle Auflösung erneut `git worktree prune` + `rm -rf` sandbox-off. **→ FOR-59 gefiled (in W14 gelandet).**

**W13-F3 — Die AFK-Lücke hat eine strukturelle Ursache: Worker-Worktrees erben nur getrackte Settings.** Analyse von ~5.500 Bash-Calls aus 50 Transcripts: die Engine-CLI-Aufrufe liefen in Formen (lokales tsx-Binary, `NODE_USE_ENV_PROXY=1`-Präfix, Absolutpfade), die keine Allowlist abdeckte — und die `settings.local.json`-Allows erreichen dispatched Agents nie, weil eine Worktree nur getrackte Dateien trägt. Fix zweiteilig: eine **getrackte** `.claude/settings.json` mit repo-relativen, auf die vier Engine-CLIs gepinnten Mustern (separater PR nach dem Close), plus die Driver-Umstellung auf repo-relative `WAVE_CLI`-Komposition. **→ getrackte Allowlist gelandet (Folge-PR); FOR-60 gefiled (in W14 gelandet).**

### 🟢 KLEIN

**W13-F4 — Lokale Branch-Akkumulation sichtbar geworden.** Nach 13 Waves: 48 `worktree-wf_*`-Harness-Throwaways + 9 `wave/*`-Locals. Squash-Merges bedeuten: `git branch -d` verweigert für immer (Tips nie Ancestors) — die Liste wächst nur. **→ als Scope-Extension in FOR-59 aufgenommen** (Branch-Hygiene nach Worktree-Removal).

**W13-F5 — Wiederholungen.** Branch-Delete-Footgun ×5 (weder arm noch merge löschen; `git push origin --delete` + `ls-remote`-Verify als Checked-Step gelaufen, 0 Überlebende). Stale-LSP-Flut nach Worktree-Removal (~9. Mal, kosmetisch; der gemergte Tip real verifiziert 1581/tsc 0).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W13-F1** — reused-Pfad ohne Body-PATCH (Render-Lücke) | 🟡 | **FOR-58 gefiled** → W14 gelandet |
| **W13-F2** — dirty-Fehlklassifikation auf prunable Dirs + fehlendes skip-reason | 🟡 | **FOR-59 gefiled** → W14 gelandet |
| **W13-F3** — AFK: tracked-settings-Vererbung + Driver-Absolutform | 🟡 | Allowlist-PR gelandet; **FOR-60 gefiled** → W14 gelandet |
| **W13-F4** — Branch-Akkumulation (squash ⇒ `-d` verweigert immer) | 🟢 | **FOR-59-Scope-Extension** |
| **W13-F5** — Branch-Delete ×5, Stale-LSP ×9 | 🟢 | Bekannt; Checked-Steps gelaufen |

## 4. Lauf-Metriken (grob)

- **Rows:** 5 (paralleler Fan-out; **Conflict-Map: 1 Zelle** FOR-16↔FOR-55 auf wave-shared/workflow-driver — bewusst mitgenommen; materialisierte sich nicht, Regionen disjunkt wie gebrieft). **Verdicts Runde 1: 4× `approve`, 1× `changes-requested`** (FOR-16) → **1 cap=1 Re-Dispatch** (iter-2 `approve`). **1 G3-STOP** (FOR-54 public-API-change, human-approved: additive `url`/`prUrl`- + `number`/`prNumber`-Aliase auf allen vier Verben). **Agents:** 20 + 4 (iter-2) = **24/24, 0 Fehler**; ~24 + ~9 min; ~1,47 Mio. Subagent-Tokens.
- **Modelle:** 1× opus (FOR-54), 4× sonnet, Scribes haiku. FOR-54 kam in Runde 1 durch (1560/1560 im Zweig).
- **Landing (`--auto`):** arm FOR-54/56/57 → 3× sofort `merged` (kein CI, FOR-51-Fallback) · Tail FOR-16→FOR-55 per `host-pr merge` → 2× `merged`, kein Rebase. Alle 5 Branches gelöscht + verifiziert. `main`: `9443731 → 5bcb005`.
- **Tests:** 1548 → **1581** (+33: FOR-16 +17 [10 Render + 7 iter-2-CLI], FOR-54 +12, FOR-56 +4; FOR-55/57 docs-only) · tsc 0 · auf dem gemergten Tip re-verifiziert. **Sidecars:** 12 (10 + 2 iter-2), at-agent-return. **Done-Reconcile:** 5× `merged` via Tracker-Attachment, `--acked` maschinell (FOR-16 aus iter-2). **Claim-Ledger:** leer. **Kern-Interventionen: 0.**
- **Same-Session-Umfeld:** FOR-57 (wave-setup Editor-Excludes) via to-issues gefiled und in derselben Wave gelandet; nach dem Close die getrackte AFK-Allowlist als eigener PR.

## 5. Meta-Reflexion

Der Lauf zeigt die Loop-Reife an zwei Stellen. Erstens: **Live-Gates als Institution funktionieren.** Zwei W12-Features gingen mit expliziten Watch-Items in diese Wave und bestanden beide unter echten Bedingungen — das ist der Unterschied zwischen „Gate grün" und „im Betrieb bewiesen", den die verb-built-but-not-wired-Funde der Vorwaven erzwungen haben. Zweitens: **Fundklassen wandern nach vorn.** Die Same-Number-Kollision wurde nicht mehr beim Landing repariert (W9), sondern beim Compose verhindert; die Wiring-Disclosure wurde nicht mehr vom Reviewer erzwungen (W11/W12), sondern vom Worker freiwillig geleistet — bevor die Klausel, die sie verlangt, überhaupt gemergt war. Prävention diffundiert vom Fund über die Konvention in die Kultur.

Der Rest des Bildes: die Reviewer-Schleife fand eine **neue, feinere Fundklasse** (verb wired, aber die CLI-Grenze untested — FOR-16s fehlender Spec-Block), und die drei 🟡-Funde dieses Laufs wurden noch am selben Tag als W14 gefiled und gelandet. Watch-Items für die Folgewaven: FOR-58s Update-on-Reuse hat sein Live-Gate erst beim nächsten echten Re-Dispatch mit Terminator-Render; die AFK-Kette (getrackte Allowlist + relativer Driver) beweist sich an der Prompt-Zahl der nächsten Wave.
