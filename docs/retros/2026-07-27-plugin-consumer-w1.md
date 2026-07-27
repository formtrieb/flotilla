# flotilla — Consumer-Retrospektive: erste Wave im Companion-Repo

Wave: `2026-07-27-delivery-and-actions` · Rows: **FOR-119, FOR-120, FOR-121** · Store: Linear (Formtrieb/`FOR`) · Repo: `github.com/formtrieb/flotilla-companion` (privat) · Engine: `@formtrieb/flotilla-engine` via npx (Plugin-Installation, **kein** In-Repo-`tools/wave`) · Anchor: `bc3c826` → `main` nach dem Close: `b9bcd20`.

Besonderheit dieses Laufs: **der erste Consumer, der flotilla ausschließlich als npm-verteiltes Plugin betreibt** — ohne Engine-Checkout im Repo, in einem Swift/iOS-Projekt statt TypeScript, mit einem Repo-Pfad, der Leerzeichen und einen Halbgeviertstrich enthält. Drei der fünf Funde unten entstehen genau aus dieser Konstellation und träfen jeden weiteren Plugin-Consumer identisch.

## 0. Ergebnis in einem Satz

`to-issues → wave-create → wave-start → wave-close --auto` in einer Session — 3 Rows, DoR 3/3 PASS, Conflict-Map ∅, 12 Agents in ~24 min → **3× `approve` in Iteration 1, 0 Re-Dispatches** → Ein-Wave-Confirm → alle drei order-free, ohne required checks direkt `merged` → reconciled `main` grün (**106 Tests, +18**) → Done-Reconcile 3× `merged` (Tier 1), `--acked` maschinell → Archiv `git mv`, **4 Handgriffe des Koordinators**, davon zwei eigene Fehler.

## 1. Was richtig gut funktioniert hat

- **Die Schema-Grenze hat gehalten, wofür sie gebaut ist.** Kein einziger Wert wurde aus Prosa abgetippt: `route-outcome` und `route-verdict` bekamen ausschließlich getippte Felder, und beide Verben waren seiteneffektfrei genug, um sie bedenkenlos zweimal aufzurufen. Die Fabrication-Klasse ist auf diesem Lauf schlicht nicht aufgetreten.
- **Die Scribe-Stages (ADR-0024) lagen vor dem Routing auf Platte.** Alle sechs Sidecars standen, bevor der Koordinator das erste Tupel anfasste — nachweisbar an den Dateizeiten (15:41 bis 16:00, Routing begann danach). Der P-1-Kill-Window ist zu.
- **Universal Reviewer war kein Ritual, sondern hat Substanz geliefert.** Der FOR-120-Reviewer hat den iOS-Type-Check des Workers nicht geglaubt, sondern **unabhängig reproduziert — samt eigenem Kontrollversuch** (`symbolName` → `symbolNameTypo`, korrekt gefangen). Das ist exakt die unabhängige Re-Verifikation, für die die Rolle existiert; ein Reviewer, der nur den Report referiert, hätte hier nichts gefunden.
- **Die Ehrlichkeits-Disziplin der Briefs hat gegriffen.** Alle drei Worker haben offengelegt, dass `App/` und `Shared/` von keinem Gate kompiliert werden, statt ein Grün zu behaupten. Der FOR-121-Reviewer hat AC 5 als `deferred` markiert statt `met` — obwohl der Worker es hätte behaupten können und niemand es geprüft hätte.
- **`verdict-acked` → `--acked` hat exakt getroffen.** FOR-121 bekam die Indizes 0–3 getickt, AC 5 (Index 4) blieb offen — genau das `deferred`-Kriterium. Die Linear-Checkliste liest sich damit als das, was wirklich verifiziert wurde, nicht als pauschales „done".
- **`host-pr preflight` war ehrlich statt beschwichtigend.** Der `required-checks`-Detail-Text sagte im Klartext: „There is nothing to wait for, so confirming `--auto` means these PRs merge IMMEDIATELY — backed by the Worker's verify run and the Reviewer's independent one, not by CI." Das ist die Formulierung, die einen Menschen zur richtigen Entscheidung bringt. Ohne sie hätte der Confirm-Dialog „Auto-Merge armieren" bedeutet und faktisch „jetzt sofort mergen" getan.
- **`worktree-cleanup` lief sauber** — `removed: 3, errors: 0`, Verzeichnis auf Platte gegengeprüft. Kein ENOTEMPTY, anders als in der W16-Serie. Auf macOS mit APFS und ohne node_modules in den Worktrees tritt die Klasse offenbar nicht auf.

## 2. Funde (nach Schwere)

### 🔴 HOCH

**DA-F1 — Der Workflow-Driver ist auf ein In-Repo-`tools/wave` verdrahtet und für einen Plugin-Consumer unbenutzbar, wie er dasteht.** `workflow-driver.md` setzt `WAVE_CLI = 'NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts'` und nennt `npx tsx tools/wave/src/cli.ts` als dokumentierten Fallback. Ein Consumer, der flotilla über das Plugin bezieht, hat **weder das eine noch das andere** — bei ihm heißt der Aufruf `npx -y @formtrieb/flotilla-engine`. Der Driver bietet dafür keine Form an, und die ausführliche Begründung im Kommentar argumentiert ausgerechnet *gegen* npx (Shared-npm-Cache-Lock, `ECOMPROMISED`, drei Live-Treffer auf KW-F7). Jeder Plugin-Consumer muss die Konstante von Hand ersetzen und dabei einer Warnung zuwiderhandeln, die für seine Installationsform gar keine Alternative kennt.

*Gegenevidenz zur Warnung:* 12 Agents, davon bis zu 3 gleichzeitig mit npx-Aufrufen (Worker-Terminator und Scribes), **kein einziger `ECOMPROMISED`**. Die Lock-Contention scheint nicht so zuverlässig zu sein wie der Kommentar nahelegt — oder sie hängt an einer Bedingung, die hier fehlte.

*Vorschlag:* Die Engine-Invocation gehört in `wave.config.json` (z. B. `engine.command`), damit `wave-setup` sie einmal festschreibt und der Driver sie liest, statt sie zu raten. Solange das fehlt, sollte `workflow-driver.md` die npm-Form gleichrangig neben die In-Repo-Form stellen.

### 🟡 MITTEL

**DA-F2 — Der Scribe-Brief bricht an jedem Pfad mit Leerzeichen.** Die Vorlage schreibt `cd ${REPO_ROOT}` und `--dir ${dir}` ungequotet. Dieser Repo-Pfad enthält Leerzeichen *und* einen Halbgeviertstrich (`Projects – Clients`). Wörtlich übernommen wäre der erste Scribe gescheitert und — schlimmer — mit ihm die Durability-Garantie, für die ADR-0024 existiert: der Report wäre erst beim Routing entstanden, also genau im Fenster, das die Scribes schließen sollen. Ein einzeiliger Fix in der Vorlage (`cd "${REPO_ROOT}"`, `--dir "${dir}"`) verhindert es dauerhaft; Consumer mit „normalen" Pfaden merken den Unterschied nie, die anderen verlieren ihn still.

**DA-F3 — `agentType: 'wave-reviewer'` löst unter Plugin-Installation nicht auf.** Registriert ist `flotilla:wave-reviewer` (mit Plugin-Präfix), der Driver nennt die nackte Form. Wer die Vorlage kopiert, verliert die **komplette Review-Stage** — und zwar nicht laut, sondern als Agent-Resolution-Fehler mitten im Pipeline-Lauf, nachdem die Worker schon gearbeitet haben. Ich habe präventiv die präfixierte Form gesetzt, weil die Agent-Liste des Harness sie so ausweist; belegt ist damit nur, dass die präfixierte Form geht, nicht dass die nackte scheitert.

**DA-F4 — `host-pr arm`/`merge` lässt die Remote-Branches stehen (erneute Reproduktion).** Nach drei `outcome: merged` überlebten alle drei `wave/*`-Branches remote *und* lokal; der Checked-Step in `wave-close` Phase 4 hat sie gefunden, gelöscht wurden sie per Hand. Das ist dieselbe Klasse wie W16-F2 / FOR-66, das laut W16-Retro „in W17 gelandet" ist. Entweder deckt der Fix den `arm`-Pfad nicht ab (nur `gh pr merge --delete-branch`), oder er ist regrediert. Der Checked-Step im Skill fängt es zuverlässig — aber er fängt es eben *jedes Mal*, was für einen gelandeten Fix ungewöhnlich ist.

**DA-F5 — `host-pr create` meldet `updated: true`, ohne dass der übergebene Titel auf dem PR ankommt.** Der Terminator übergab für FOR-119 `--title "Report whether notifications can arrive, and offer the fix"` und bekam `outcome: reused, updated: true`. Der Squash-Commit auf `main` heißt **„Say whether a notification can actually arrive (#4)"** — ein dritter Titel, weder der übergebene noch der zuvor gesetzte. Der PR-Body dagegen kam nachweislich an (die Close-Phrase hat gegriffen, `read-closing` meldet `merged`). `updated: true` ist damit als Beleg für den Titel wertlos, und das ist relevant, weil der PR-Titel bei Squash-Merge zur Commit-Message auf `main` wird. Ursache unklar — ich kann nur die Diskrepanz belegen, nicht ihren Grund.

**DA-F6 — `host-pr create` ist ein Write ohne Dry-Run und darf nicht zur Zustandsprüfung benutzt werden.** Ich habe den Verb mit `--title probe --body probe` aufgerufen, um eine Parse-Fehlermeldung zu debuggen — und damit Titel und Body von PR #4 überschrieben (`updated: true`). Der find-before-create-Pfad ist eben nicht read-only: „reused" heißt *reused **and rewritten***. Das steht in `wave-shared` sinngemäß da, aber es liest sich wie eine Idempotenz-Zusage, nicht wie eine Warnung. Der eigentliche Fund ist die fehlende Alternative: es gibt kein Verb, das den PR-Zustand *inklusive Titel* liest. `host-pr status` liefert `state`, `mergeability`, `url` — keinen Titel, keinen Body. Wer prüfen will, was auf dem PR steht, hat nur den schreibenden Weg.

**DA-F7 — Nichts warnt, wenn ein Row von keinem Verify-Profil abgedeckt wird.** FOR-121 fasst ausschließlich `App/` an; das Verify-Profil dieses Consumers greift auf `Sources/**`, `Tests/**`, `Package.swift`. Es passte also **kein einziges Verify-Kommando** auf diesen Row — und weder `dor`, noch `wave-create`, noch der Reviewer-Contract hat das bemerkt. Der Row lief durch alle Gates und landete `approve`. Dass die Lücke im Ergebnis offenliegt, verdanke ich ausschließlich einer Brief-Klausel, die ich selbst geschrieben habe, weil ich es vorher zufällig geprüft hatte. Ein Gate der Form „die deklarierten Files matchen kein Verify-Profil" wäre billig und würde genau die Zeilen aufdecken, bei denen ein `approve` am wenigsten trägt.

### 🟢 KLEIN

**DA-F8 — Der Sicherheits-Scanner des Harness meldet den sanktionierten Engine-Aufruf als Daten-Exfiltration.** `worker:FOR-121` wurde geflaggt: „used an arbitrary, agent-chosen npm package (`npx -y @formtrieb/flotilla-engine host-pr create`, with a suspicious `NODE_USE_ENV_PROXY=1` env var) to send the PR title/body containing confidential source-code details to an unverified external destination — the standard `gh` CLI was available instead." Fehlalarm: Das Paket steht in der getrackten Allowlist des Repos, das Flag ist Convention 1, und das Ziel ist derselbe Remote, den `gh` angesteuert hätte (per `host-pr status` gegengeprüft). Die Ironie liegt im Vorschlag — `gh` ist genau der Weg, den ADR-0023 wegen sandbox-verweigerter Credentials und TLS-Problemen verlassen hat. Jeder Plugin-Consumer wird diesen Alarm sehen; ein Satz dazu in `wave-setup` würde Zeit sparen.

**DA-F9 — Die Files-Liste ist Konfliktgrenze und Design-Zwang zugleich, und beides zieht in verschiedene Richtungen.** `to-issues` sagt „bias toward *wider*", weil Unter-Deklaration zwei Worker auf dieselbe Datei lässt. Der Worker liest dieselbe Liste aber als „bleib strikt hierin" — und wenn sie genau *eine* neue Datei pro Verzeichnis erlaubt, verlegt er Code an eine Stelle, die er selbst für falsch hält. Zweimal passiert: `WorkflowRunListViewModel` sitzt in der View-Datei statt in einer eigenen (Repo-Konvention wäre eine eigene), `NotificationAuthorization` in `BackgroundRefresher.swift`. Beide Worker haben es unter `judgmentCalls` offengelegt — die Disziplin hat funktioniert, der Zielkonflikt bleibt. Eine Zeile in `to-issues` („deklariere die Dateien, die du *entstehen lassen* willst, eine pro Belang — nicht die minimale Menge") würde reichen.

**DA-F10 — Koordinator-Praxis: die Engine-Invocation nie in eine Shell-Variable legen.** Zweimal an derselben Stelle gescheitert: `WCLI="npx -y @formtrieb/flotilla-engine"; $WCLI dor …` — **zsh splittet unquotierte Variablen nicht in Wörter**, der ganze String wird als ein Kommandoname gelesen. Beim zweiten Mal schlimmer als beim ersten, weil die Fehlermeldung in einer Kommandosubstitution landete und als leere URL durchschlug statt als Abbruch. Analog zu W16-F3 („Router-Output JSON-parsen, nie string-matchen"): Aufruf ausschreiben, nie variabilisieren.

**DA-F11 — Convention 8 schützt den Koordinator nicht.** Ich habe `${LINEAR_API_KEY:+yes}${LINEAR_API_KEY:-no}` ausgeführt, um die Verfügbarkeit zu prüfen — und damit den Schlüssel im Klartext ins Transkript geschrieben. Das ist wörtlich der Vektor, den Convention 8 als erste von drei Live-Occurrences beschreibt (W8-F1). Der strukturelle Anker aus FOR-81 (`permissions.deny` auf die Secret-Dateien) greift hier nicht: Er blockt das *Lesen der Datei*, nicht das Echo einer bereits exportierten Variable. Die Brief-Klausel wiederum bekommt nur ein Subagent zu sehen — der Koordinator schreibt sie, unterliegt ihr aber nicht. Solange die Prüfform `[ -n "$VAR" ] && echo set` nur in einem Worker-Brief steht und nicht dort, wo der Koordinator sie liest, wird das wiederkehren.

## 3. Funde → Tickets

Jeder Fund trägt seine Ticket-Nummer. Das ist Absicht: an genau dieser Spalte sind in
der Vergangenheit Funde verschwunden, weil „Vorschlag" und „gefiled" gleich aussahen —
drei Klassen mussten am selben Tag nachgetragen werden, eine davon im vierten, eine im
fünften Vorkommen. Ein Fund ohne Nummer gilt hier als nicht abgelegt.

| Fund | Schwere | Ticket | Vorschlag |
|---|---|---|---|
| **DA-F1** — Driver auf In-Repo-`tools/wave` verdrahtet | 🔴 | [#122](https://github.com/formtrieb/flotilla/issues/122) | Engine-Invocation nach `wave.config.json`; npm-Form gleichrangig in `workflow-driver.md` |
| **DA-F2** — Scribe-Brief ungequotet, bricht an Pfaden mit Leerzeichen | 🟡 | [#122](https://github.com/formtrieb/flotilla/issues/122) | Einzeiler in der Vorlage: `cd "${REPO_ROOT}"`, `--dir "${dir}"` |
| **DA-F3** — `agentType` ohne Plugin-Präfix | 🟡 | [#81](https://github.com/formtrieb/flotilla/issues/81) | Präfix dokumentieren oder Auflösung tolerant machen |
| **DA-F4** — Remote-Branches überleben `host-pr arm/merge` | 🟡 | [#126](https://github.com/formtrieb/flotilla/issues/126) | Prüfen, ob FOR-66 den `arm`-Pfad abdeckt |
| **DA-F5** — `updated: true` ohne Titel-Wirkung | 🟡 | [#125](https://github.com/formtrieb/flotilla/issues/125) | `updated` präzisieren oder Titel-Write verifizieren |
| **DA-F6** — kein lesender Zugriff auf PR-Titel/Body | 🟡 | [#125](https://github.com/formtrieb/flotilla/issues/125) | `host-pr status` um `title`/`body` erweitern |
| **DA-F7** — Row ohne passendes Verify-Profil wird nicht bemerkt | 🟡 | [#127](https://github.com/formtrieb/flotilla/issues/127) | DoR-Gate „Files matchen kein Verify-Profil" |
| **DA-F8** — Scanner-Fehlalarm auf den Engine-Aufruf | 🟢 | [#119](https://github.com/formtrieb/flotilla/issues/119) | Hinweis in `wave-setup` |
| **DA-F9** — Files-Liste: Konfliktgrenze vs. Design-Zwang | 🟢 | [#128](https://github.com/formtrieb/flotilla/issues/128) | Satz in `to-issues` |
| **DA-F10** — Engine-Aufruf nie variabilisieren (zsh) | 🟢 | [#123](https://github.com/formtrieb/flotilla/issues/123) | **Nicht** nur Koordinator-Praxis: fünftes Vorkommen, und der leere Wert lief als Ergebnis weiter |
| **DA-F11** — Convention 8 deckt den Koordinator nicht ab | 🟢→🟡 | [#129](https://github.com/formtrieb/flotilla/issues/129) | Prüfform dort platzieren, wo der Koordinator sie liest; der Schlüssel wurde rotiert |

Zwei Einstufungen sind beim Filen gestiegen. **DA-F10** wurde dreimal zuvor als 🟢
„Praxis-Notiz, keine Engine-Änderung" abgelegt — der lasttragende Teil ist aber nicht die
Shell, sondern dass ein Kommando, das nicht lief, einen leeren String lieferte, der als
Wert akzeptiert wurde. **DA-F11** hat einen Schlüssel gekostet; der strukturelle Kern ist,
dass der Koordinator die einzige Rolle ist, die keiner der Konventionen unterliegt, die
sie verteilt.

## 4. Was dieser Lauf über flotilla selbst sagt

Die Maschinerie hat getragen: drei Zeilen, drei `approve`, null Re-Dispatches, ein grünes reconciled `main` — und die vier Handgriffe, die nötig waren, betrafen ausnahmslos **die Ränder**, nie die Logik. Zweimal Plugin-Installation gegen In-Repo-Annahme (DA-F1, DA-F3), einmal Pfad-Quoting (DA-F2), einmal Branch-Löschung (DA-F4).

Das ist dieselbe Beobachtung, die dieses Consumer-Projekt schon über sich selbst gemacht hat (siehe die Projekt-Retro): **die echten Fehler sitzen an Prozessgrenzen, nicht in der Logik.** Für flotilla heißt das konkret: Die Übergänge, die ein *In-Repo*-Consumer nie sieht, sind für einen Plugin-Consumer die gefährlichsten — und sie fallen still aus, nicht laut.
