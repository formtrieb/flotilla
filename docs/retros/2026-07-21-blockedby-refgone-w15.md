# flotilla — Retrospektive: Wave 15 „2026-07-21-blockedby-refgone" (sechzehnter Live-Lauf)

Wave: `2026-07-21-blockedby-refgone` · Rows: **FOR-61, FOR-62** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` (öffentlich) · Anchor: `8625563` → `main` nach dem Close: `8eca587`.

Besonderheit dieses Laufs: **das erste Null-Konflikt-Roster seit W10** (komplett disjunkte Files → beide Rows order-free, kein Tail), und ein Reviewer-Fund der feinsten bisherigen Körnung — ein *toter, aber untesteter* Code-Zweig, der die Kern-AC semantisch verletzte, obwohl kein realer Aufruf ihn je erreicht. Dazu wurde die dritte Wave in Folge same-day aus den Funden des Vortags-/Vormittags-Close gebaut und gelandet.

## 0. Ergebnis in einem Satz

Wave 15 lief `to-issues → wave-plan → wave-create → wave-start → wave-close --auto` in einer Session — 2er-Fan-out (FOR-61 auf opus) → **1× `approve` (FOR-61), 1× `changes-requested` (FOR-62: der Success-Zweig der Remote-Probe inferierte „gone" aus leerem stdout — strukturwidrig zur AC)** → sauberer cap=1 Re-Dispatch (iter-2: non-throwing ⇒ unconditionally `present`, Spec-Lock, plus die Coordinator-Auflösung des Skip-Reason-Items als additives `branchHygieneSkipped[]`) → G3-STOP FOR-61 human-approved → Ein-Wave-Confirm → **beide Rows gearmt → sofort `merged`** (kein CI, kein Tail) → `main 8625563 → 8eca587`, Gate **1655 Tests (+28) / tsc 0, additiv exakt** → Done-Reconcile 2× `merged`, `--acked` maschinell (FOR-62 aus iter-2) → Archiv plain-mv, Claim-Ledger leer, Backlog danach leer, 0 Kern-Interventionen.

## 1. Was richtig gut funktioniert hat

- **Der Reviewer fand einen toten-aber-falschen Zweig — die bisher feinste Fundkörnung.** FOR-62s `probeRemoteRef` behandelte den nie eintretenden Fall „exit 0 + leerer stdout" per stdout-Inferenz als `gone` — empirisch unerreichbar (`git ls-remote --exit-code` liefert für no-match exit 2, live gegen origin verifiziert), aber im Widerspruch zur load-bearing AC („strukturell, nie aus leerem Output inferiert") und vom eigenen Doc-Kommentar dementiert. Kein Test hätte es je gefangen (der einzige Mock-Test assertete nur die Invocation-Shape). Dass die Schleife diese Klasse — semantische AC-Verletzung ohne Runtime-Symptom — zieht, ist ihr bisher stärkster Qualitätsbeleg.
- **FOR-61s Opus-Worker navigierte einen echten Contract-Konflikt sauber per Judgment-Call.** AC2 verlangte annotate-Mirroring „neu hinzugekommener Refs", aber das shared `AnnotatePatch` trägt bewusst kein blockedBy-Feld — und AC3/AC4 verbieten Shared-File-Änderungen. Statt den Contract aufzuweichen, realisierte der Worker annotate als **additiven Codec-vs-Native-Delta-Reconcile** (jeder kanonische Body-Ref, der nativ fehlt, wird nachgezogen) — disclosed, vom Reviewer explizit als akzeptable AC-Lesart bestätigt. Die Richtungsfrage (Blocker = Source von `type:'blocks'`, exakt invers zum bestehenden Read) ist als benannte e2e-verify-Konstanten gepinnt, nach dem ADR-0020-Muster.
- **Null-Konflikt-Partial-Arm: der `--auto`-Idealfall lief erstmals vollständig.** Beide Rows in keiner Conflict-Map-Zelle → beide gearmt, beide sofort `merged`, kein Advisory-Tail, kein Hand-Merge. Die Confirm-Ehrlichkeit („kein CI ⇒ Bestätigen = sofortiger Merge") + G3 davor blieben die einzigen menschlichen Berührpunkte des Landings.
- **Der Pull lief erstmals sandboxed durch.** W15s Diff berührte keine `.claude/skills/**`-Dateien — `fetch` + `reset --hard` liefen ohne Sandbox-Ausnahme, `rev-parse`-Verify grün. Der dokumentierte sandbox-off-Moment ist also nicht strukturell, sondern exakt skills-diff-bedingt — eine nützliche Präzisierung der W5-F3-Regel.
- **Iter-2-Mechanik inzwischen Routine:** Detached-HEAD-Ausweich (Branch von der iter-1-Worktree gehalten, 3. Vorkommen), Iter-Zelle + r2/v2-Links korrekt, `verdict-acked` zog die Ticks aus dem Max-Iter-Verdict.

## 2. Funde (nach Schwere)

### 🟡 MITTEL

**W15-F1 — Die Branch-Hygiene hängt an Removal-Events: der dokumentierte manuelle ENOTEMPTY-Fallback verwaist Branches dauerhaft.** Als die drei Wave-Worktrees manuell geräumt werden mussten (W15-F2), fand der nachfolgende Cleanup-Lauf keine Worktrees mehr — und die Hygiene (Throwaway-Delete + remote-ref-gone) lief nie, weil sie nur pro Removal-Event feuert. Ergebnis: 2 `wave/*` + 3 `worktree-wf_*` Locals blieben stehen und brauchten den manuellen `-D`-Sweep, den FOR-62 gerade abschaffen sollte. Fund-Richtung: die Hygiene zusätzlich **standalone** über das Dispatch-Log laufen lassen (Branches prüfen, auch wenn keine Worktree mehr existiert). Ticket-Kandidat.

**W15-F2 — Die ENOTEMPTY-Klasse hat einen ungedeckten Rest: REGISTRIERTE Worktrees mit `node_modules` + offenem Editor.** Dritter Lauf in Folge mit `errors:3` vor dem Merge — diesmal weder Junk-Shape (FOR-56 deckt Orphan-Junk) noch dirty-Fehlklassifikation (FOR-59 deckt Orphan-Status): die Worktrees waren noch registriert, hielten `node_modules` (gitignored, physisch groß) und vermutlich Editor-Handles (die IDE war offen — der Footgun, den FOR-57 tags zuvor als Precondition dokumentierte, live am eigenen Repo). Auflösung erneut manuell force-remove + `rm -rf` sandbox-off. Fund-Richtung: entweder ENOTEMPTY-Retry mit Backoff auf dem registrierten Pfad, oder dokumentiert-akzeptierter manueller Rest — zusammen mit W15-F1 entscheiden. Ticket-Kandidat.

### 🟢 KLEIN

**W15-F3 — Die neuen Cleanup-Result-Felder sind CLI-unsichtbar.** `cli.ts` destrukturiert nur `removed`/`skipped`/`errors` ins JSON — weder das ältere `branchesDeleted` noch das frische `branchHygieneSkipped` erscheinen im CLI-Output (Reviewer-Fund, pre-existing, keine Regression). Wer die Hygiene beobachten will, sieht sie derzeit nicht. Kandidat: CLI-Emission vervollständigen (gleiche Klasse wie die FOR-54-Feldnamen-Ehrlichkeit).

**W15-F4 — Wiederholungen.** Branch-Delete-Footgun ×7 (Checked-Step gelaufen, 0 Überlebende) · Stale-LSP ×~11 (kosmetisch; Tip real verifiziert 1655/tsc 0) · Prä-Merge-Cleanup-errors auf laufenden Wave-Worktrees ×3 (bekanntes Muster; Auflösung gehört zu W15-F1/F2).

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **W15-F1** — Hygiene nur bei Removal-Events; standalone-Lauf übers Dispatch-Log fehlt | 🟡 | **Kandidat** für to-issues |
| **W15-F2** — ENOTEMPTY-Rest: registrierte Worktrees + node_modules + Editor-Handles | 🟡 | **Kandidat** (mit F1 zusammen schneiden) |
| **W15-F3** — `branchesDeleted`/`branchHygieneSkipped` CLI-unsichtbar | 🟢 | **Kandidat** (CLI-Emission) |
| **W15-F4** — Wiederholungen (Branch-Delete ×7, Stale-LSP, Prä-Merge-errors) | 🟢 | Bekannt; Checked-Steps gelaufen |

## 4. Lauf-Metriken (grob)

- **Rows:** 2 (paralleler Fan-out; **Conflict-Map: 0 Zellen** — erstes vollständig disjunktes Roster seit W10). **Verdicts Runde 1: 1× `approve`, 1× `changes-requested`** → **1 cap=1 Re-Dispatch** (iter-2 `approve`). **1 G3-STOP** (FOR-61, human-approved). **Agents:** 8 + 4 (iter-2) = **12/12, 0 Fehler**; ~23 + ~11 min; ~0,80 Mio. Subagent-Tokens.
- **Modelle:** 1× opus (FOR-61), 1× sonnet; Scribes haiku.
- **Landing (`--auto`):** arm FOR-61 + FOR-62 → **2× sofort `merged`** (kein CI, kein Tail — der Partial-Arm-Idealfall). Beide Branches remote gelöscht + verifiziert; lokal manueller Sweep (W15-F1). `main`: `8625563 → 8eca587`.
- **Tests:** 1627 → **1655** (+28: FOR-61 +16, FOR-62 +12 [9 iter-1 + 3 iter-2]) · tsc 0 · additiv exakt, auf dem gemergten Tip re-verifiziert. **Sidecars:** 6 (4 + 2 iter-2), at-agent-return. **Done-Reconcile:** 2× `merged`, `--acked` maschinell (FOR-62 aus iter-2). **Claim-Ledger:** leer. **Backlog:** leer. **Kern-Interventionen: 0.**

## 5. Meta-Reflexion

Zwei Beobachtungen tragen über diese Wave hinaus. Erstens: **die Fundkörnung wird feiner, nicht gröber.** Von „Verb nicht verdrahtet" (W11/W12) über „CLI-Grenze untested" (W13) zu „toter Zweig widerspricht der AC-Semantik" (W15) — die Schleife findet inzwischen Fehlerklassen, die kein Gate und kein realer Lauf je manifestiert hätte. Das ist der Punkt, an dem die universelle Review-Dispatch-Entscheidung (ADR-0016) nicht mehr nur Regressionen fängt, sondern Spezifikationstreue erzwingt.

Zweitens: **die Cleanup-Domäne ist der hartnäckigste Rest.** Drei Slices in drei Waves (FOR-56, FOR-59, FOR-62) haben je eine reale Teilklasse geschlossen — und jede Wave legte die nächste frei (Junk → Orphan-Status → Event-Bindung/Editor-Handles). Das ist kein Whack-a-Mole-Versagen, sondern die normale Topologie eines Randes zwischen Git-Semantik, Dateisystem und einem lebenden Editor; aber es lohnt, W15-F1/F2 als *einen* durchdachten Schnitt zu planen statt als vierten Einzel-Patch.

**Offene Live-Gates:** FOR-61s nativer Mirror beweist sich am ersten `wave-create` mit echtem blockedBy-Ref (der kommende Consumer-Backlog liefert das absehbar); FOR-58s update-on-reuse am nächsten Re-Dispatch mit Terminator-Render. **Vorwärts-Zeiger:** Der Backlog ist leer, die Adoption-Lücken der letzten drei Waves sind geschlossen — der nächste Schritt ist das Consumer-Onboarding auf dem Server-Piloten (wave-setup mit beiden Preflights im Consumer-Repo).
