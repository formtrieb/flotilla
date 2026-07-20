# flotilla — Retrospektive: Wave 1 „2026-07-16-hardening-w1" (zweiter Live-Lauf)

Wave: `2026-07-16-hardening-w1` · Rows: **FOR-5, FOR-9, FOR-10, FOR-13** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla` · Anchor: `a89fcdc`.

## 0. Ergebnis in einem Satz

Wave 1 lief end-to-end sauber durch — Smoke-Test (FOR-9) → paralleler Fan-out (FOR-5/10/13) → **4× `approve`**, **0 changes-requested, 0 STOP** → 4 squash-PRs auf `main` → **alle 4 Linear-Issues auto-`Done`** —, und das obwohl der Coordinator mitten im Lauf starb (Session-Neustart) und die Wave in Parallel-Sessions zu Ende getragen wurde: **0 manuelle Kern-Dispatch-Interventionen** gegenüber 6 im ersten Live-Lauf.

## 1. Was richtig gut funktioniert hat

- **Schema-Boundary + deterministisches Routing hielten.** Alle 4 Worker lieferten schema-validierte `WorkerReport`s, alle 4 Reviewer schema-validierte `ReviewerVerdict`s. Kein Wert wurde aus Prosa re-getippt; `route-verdict`/`route-outcome` blieben ungenutzt-weil-nötig (alle `approve` → Terminator).
- **Reviewer-Tiefe übertraf den Report.** Bei **FOR-9** und **FOR-5** reproduzierte der Reviewer das TDD-Rot/Grün selbst (Fix gestasht → Rot in exakter Symptom-Form → restauriert → Grün) und re-verifizierte Verify unabhängig in Wegwerf-Worktrees gegen die Anchor-SHA. Stärkere Bestätigung als der Report allein — genau der Zweck der universellen Reviewer-Dispatch.
- **Cross-Wave-Disjunktheit bestätigt.** Alle Sibling-`merge-tree`-Checks: 0 Konflikt-Marker; die 4 Changesets waren file-disjunkt wie bei `wave-plan`/`wave-create` vorhergesagt (`intraWaveConflicts=∅`). Merge in beliebiger Reihenfolge, keine Rebase-Kollision.
- **Der Reviewer fing Report-Ungenauigkeiten, die die Schema-Totals nicht fangen.** FOR-10-Worker meldete „27 neue Tests" (real 15); FOR-13-Worker nannte Baseline 1115 (real 1116, Delta 8 statt 9). Die verify-gate-relevanten **Totals stimmten exakt** — die Drift lag nur in der Freitext-Erzählung, und der Reviewer als zweite Instanz griff.
- **Linear Auto-`Done` via GitHub-Integration.** Alle 4 PR-Bodies trugen die store-korrekte Close-Phrase `Fixes FOR-N` (Convention 4) → alle 4 Issues schlossen beim Merge automatisch. Kein manueller Panel-Move (der P-2/P-5-Schmerz des ersten Laufs).
- **Worktree-Deps-Absicherung + Reviewer-Wegwerf-Worktree** (beide im Brief vorgegeben) funktionierten — kein Verify-Scheitern an fehlendem `node_modules`, keine Coordinator-Tree-Mutation durch den read-only Reviewer.

## 2. Funde (nach Schwere)

### 🟠 HOCH

**F1 — `wave-close` ruft nie `IssueStore.close()`; FOR-13s doneState-Fallback ist gebaut, aber operativ tot.**
Der FOR-13-Reviewer (needs-human-eyes, cross-cutting): **kein** M1-Skill (`wave-close`/`wave-resume`/`wave-start`) ruft je `close()`. `wave-close` löscht bei `readClosing='merged'` nur ein stale Flag; `wave-resume` sagt explizit „kein done-Rung, Claim so lassen". Der doneState-Fallback ist store-seitig korrekt gebaut + getestet (AC erfüllt), hat aber **keinen operativen Trigger** — das „drei gemergte Issues hingen ewig in-review"-Szenario aus FOR-13s **eigener Motivation ist damit noch nicht end-to-end gefixt**. Konsistent mit FOR-13s Files-Glob, der `wave-close`/`wave-resume` bewusst ausschließt (Scope-Split) → **braucht ein Wiring-Ticket** (§3, F1).

### 🟡 MITTEL

**F2 — `merge-order.ts` bleibt Ur-gekoppelt → falsch auf Linear-IDs.**
FOR-5-Worker + Reviewer: `merge-order.ts` hat sein **eigenes** `extractSpineBranches` (`wave-orch/`, numerische `NN`, `.scratch/`), von FOR-5 unberührt. ADR-0021s „merge-order ist gratis gefixt (durch den befüllten Dispatch-Log)" gilt nur für Ur-numerische IDs, **nicht** für Linear `FOR-N`, bis `merge-order.ts` entkoppelt ist. → **bereits FOR-15**; durch den FOR-5-Merge jetzt **entblockt**. FOR-15 *muss* die Regex-Entkopplung einschließen, sonst produziert die Merge-Order-Advisory auf einer Linear-Wave `null`.

**F3 — Prozess/Dogfood: Coordinator-Tod ohne Dispatch-Log.**
Dieser Lauf lief **ohne** FOR-5s Dispatch-Log (FOR-5 wurde ja gerade erst gebaut). Der Coordinator starb im FOR-9-Smoke-Test (Session-Neustart). Die Wave kam nur durch, weil Parallel-Sessions den Dispatch zu Ende trugen — **nicht** weil `resume()` funktionierte: ohne Dispatch-Log hätte `resume()` die committeten Rows redispatcht und die Arbeit verworfen (exakt FOR-5s Bug, ADR-0021). Bestätigt die Dringlichkeit von FOR-5 (jetzt gelandet); künftige Waves haben das Log. **Kein neues Ticket.**

### 🟢 NIEDRIG / Umgebung

**F4 — Worker-Report-Prosa-Genauigkeit.** FOR-10 („27" statt 15), FOR-13 (Baseline 1115 statt 1116). Schema-validierte Totals + AC-Evidenz stimmten; nur die Freitext-Breakdowns drifteten, vom Reviewer gefangen. Kein Funktions-/Coverage-Gap. Optional: ein Worker-Report-Self-Consistency-Hinweis im Brief.

**F5 — `wave-start` Drift-Gate Doc-Parität.** FOR-9s Source-Fix wirkt automatisch auch für `wave-start`s Recipe, aber der explizite Dedup-Callout in den `wave-start`-Docs fehlt (war außerhalb FOR-9s Globs). Verhalten korrekt; reine Doku. Optional Fast-Follow.

**F6 — Test-Hardening-Kandidaten (alle low-risk).** (a) `cross-wave` `byId`-Tie-Break (candidates gewinnen bei Duplikat-ID) ist nicht für Feld-Divergenz zwischen candidate-/claimed-Snapshot getestet (FOR-9). (b) `BRANCH_REF`-Heuristik: `wave-orch/54-ish` (Bindestrich direkt nach Token, kein echter Slug) könnte false-positive matchen; nicht von den Rejection-Tests abgedeckt (FOR-5). (c) branch-byte-match (`$ROW_SLUG` vs Worker-`checkout`) ist Skill-Prosa, **nicht** test-covered — beim nächsten `wave-start`-Dogfood prüfen (FOR-5).

**F7 — Coordinator-Sign-off: FOR-10 unscoped `listAllWorktrees()`.** Der Reviewer verifizierte unabhängig, dass der unscoped Scan **nötig** (nicht stilistisch) ist: ein `redispatch`-Row hat per `resume.ts`-Logik im geteilten Snapshot immer `worktree=null`, ein Wiederverwenden wäre ein unerreichbarer No-op. Der Scan ist durch exakten Branch-Namen-Match gated → kann keine Sibling-Wave anfassen. **Sign-off erteilt** — Design sound + getestet.

**F8 — Umgebung: Sandbox-TLS + FS-Restriktionen.** `gh pr merge` scheiterte am Sandbox-Proxy-Cert (`OSStatus -26276`); der `ff`-Merge an der `.claude/skills/`-Schreibsperre (halb-applizierter Working-Tree, per `reset --hard origin/main` bereinigt). Beide mit sandbox-off gelöst. Reiht sich in **FOR-12** (proxy-sandbox-doc) ein und gehört ins Coordinator-Runbook. Nicht flotillas Schuld, aber flotilla-relevant.

## 3. Funde → Tickets

| Fund | Schwere | Status |
|---|---|---|
| **F1** — `close()` in `wave-close` done-reconcile verdrahten (FOR-13 operativ machen) | 🟠 | **NEU** — zu filen (verwandt mit, aber distinkt von FOR-17) |
| **F2** — `merge-order.ts` Linear-ID-Entkopplung | 🟡 | **FOR-15** (durch FOR-5 entblockt; Regex-Fix muss rein) |
| **F3** — Dispatch-Log / resume | 🟡 | **FOR-5 gelandet** (kein Ticket) |
| **F4** — Worker-Report-Prosa | 🟢 | optional, nicht gefiled |
| **F5** — Drift-Gate-Doc-Parität | 🟢 | optional |
| **F6** — Test-Hardening (3×) | 🟢 | optional |
| **F7** — unscoped worktrees | 🟢 | Sign-off erteilt (kein Ticket) |
| **F8** — Sandbox TLS/FS | 🟢 | **FOR-12** |

## 4. Lauf-Metriken (grob)

- **Rows:** 4 (1 Smoke-Test + 3 Fan-out). **Verdicts:** 4× `approve`, 0 changes-requested, 0 questions-blocking, 0 STOP. **cap=1 Re-Dispatch:** nie ausgelöst.
- **PRs:** #3 (FOR-9), #4 (FOR-13), #5 (FOR-5), #6 (FOR-10) — alle squash-merged, alle Branches gelöscht.
- **Test-Totals (unabhängig re-verifiziert):** FOR-9 1119 · FOR-5 1122 · FOR-13 1124 · FOR-10 1137 · `tsc --noEmit` 0 überall.
- **Linear:** alle 4 auto-`Done` bei Merge (GitHub-Integration + `Fixes FOR-N`).
- **Manuelle Kern-Dispatch-Interventionen:** 0 (erster Lauf: 6). **Coordinator-Tode:** 1 — überlebt via Parallel-Session-Pickup (aber siehe F3: nicht via `resume()`).

## 5. Meta-Reflexion

Der zweite Live-Lauf bestätigt die Kern-These: **Schema-Boundary + deterministisches Routing + universeller Reviewer als zweite Instanz** tragen einen AFK-Fan-out ohne Coordinator-Babysitting. Der wertvollste Fund (F1) kam **vom Reviewer, nicht vom Gate** — die `needs-human-eyes`-Kategorie funktioniert als Eskalationskanal für genau die cross-cutting Lücken, die kein mechanisches Gate sieht. Das Muster hinter F1 ist beobachtenswert: **eine Store-Fähigkeit ohne Skill-Trigger** (`close()` gebaut, nirgends gerufen) — beim nächsten Facetten-Review gezielt danach suchen.
