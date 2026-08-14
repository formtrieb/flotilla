## Convention 4 — the store-kind close phrase (PR body)

The magic word a merged PR's body must carry to close/link the issue is **derived from the configured store kind** (`wave.config.json`'s `store.kind`), not hardcoded — a PR is always a GitHub artifact in both known consumers, but the phrase the *tracker* recognizes differs (ADR-0020):

| `store.kind` | Close phrase | Example |
|---|---|---|
| `github` | `Closes #<issue-number>` | `Closes #42` |
| `linear` | `Fixes <TEAM-NN>` | `Fixes EX-16` |

Read `store.kind` off the consumer's `wave.config.json` (the same file `{{wave-cli}}` resolves via `--config`) and compose the PR body with the matching phrase whenever a terminator opens a PR (`wave-start`'s `approved → pr-created` step). For a `linear` store this phrase is also what creates the merged-PR attachment `issue-store read-closing` reads (the Linear closing probe, ADR-0020) — get the phrase wrong and the row never resolves past `in-review`/`pr-created` even though the code merged.

`linear`'s Linear-GitHub-integration precondition (installed + connected to the code repo) must already hold for this to work at all — `wave-setup`'s Linear operational-preconditions checklist confirms it before the store is ever configured.

**Opening the PR goes through the engine — `{{wave-cli}} host-pr create`, never `gh pr create`.** The PR-open is the ADR-0023 last mile: every host write goes through the engine host seam, and `create` is that verb (`gh`'s creds are sandbox-denied and its TLS fought the proxy MITM cert in every live run — creation only ever worked sandbox-off). It is **find-before-create idempotent about *creation***: an OPEN PR already on the branch is reused (`outcome: reused`) rather than duplicated, a missing one is created (`outcome: created`) — so a cap=1 re-dispatch onto the same branch never opens a second PR.

> ⚠️ **`create` is a WRITE, and reuse REWRITES the PR's title and body.** "Idempotent" here covers creation only; it says nothing about content. A reuse re-writes the live PR's title **and** body to the `--title`/`--body` you pass (`updated: true` discloses it) — last-writer-wins, which is exactly what the terminator needs so a re-dispatch's freshly composed render reaches the live PR. It also means **running `create` twice with different arguments changes the PR twice.** A live consumer wave lost a real PR's title and body to a single exploratory `--title probe --body probe` call (docs/retros/2026-07-27-plugin-consumer-w1.md, DA-F6). **To find out whether a branch already has a PR, use the read-only `{{wave-cli}} host-pr status --branch <branch>` verb** — never `create`. `status` reports `state` (`open` | `merged` | `closed-unmerged` | `none`), `url`, `number`, and `mergeability`, and writes nothing.

**The one rewrite `create` refuses.** Because the close phrase lives in that body, a rewrite that drops it is the expensive silent failure: the PR merges normally, the row never reaches `done`, and the wave looks finished with one issue quietly open. So a reuse whose passed body carries **no** close phrase, over a live PR body that **does**, is **refused** — exit 1, `outcome: reuse-refused`, a `reason` naming the phrase at risk, and **no write at all**. A legitimate re-dispatch is unaffected (a composed render always carries its phrase), and `--allow-close-phrase-loss` is the deliberate override for a human replacing a PR body wholesale. The check is presence, not identity: a body carrying a *different* phrase passes, and a live body that was never readable is never refused on (absence of evidence is not a finding).

**Compose the phrase on its own line — that is what the guard recognizes.** A hyphenated technical token is structurally identical to a Linear reference (`resolves UTF-8` has the same shape as `Fixes EX-8`), so the guard tells a real phrase from coincidental prose by the one thing that actually differs: a real phrase owns its line, and prose never does. A phrase buried mid-sentence (`Summary of the work. Closes #42 as part of the batch.`) is therefore **not** recognized and **not** protected — the guard declines to fire rather than risk refusing a legitimate rewrite it misread.

The `--body` you pass carries the store-kind close phrase above, verbatim, and per the mention-footgun below it is the **only** tracker id the title or body may contain:

```bash
{{wave-cli}} host-pr create --branch <branch> --title "<title, no bare tracker id>" \
  --body "<summary>

<the store-kind close phrase, on its own line — e.g. Fixes EX-16>"
# exit 0 → stdout JSON carries .url (outcome: created | reused) — pin that as the row's PR URL.
# exit 1 + outcome: reuse-refused → the body you passed would have dropped the live PR's close
#   phrase; nothing was written. Fix the body (or pass --allow-close-phrase-loss deliberately).
# create reads the host's credential from the environment (never printed) — GITHUB_TOKEN
# on a github remote; BITBUCKET_TOKEN + BITBUCKET_EMAIL on a bitbucket one (the Atlassian
# API-token Basic pair, ADR-0023 amendment 2026-08-10). unknown hosts fail loud + typed
# like the landing verbs.

# Read-only alternative — use THIS to ask whether a branch already has a PR:
{{wave-cli}} host-pr status --branch <branch>
```

**Recorded decision — the guard is sufficient; there is no `--no-update` reuse form.** The obvious alternative was a non-rewriting reuse (re-pin the URL, leave the content alone) as the general-case default or an opt-in flag. It is deliberately *not* shipped: (1) the terminator's rewrite is load-bearing — a reuse that skipped the update is precisely the W13-F1 defect the update-on-reuse slice fixed, where a Worker-opened PR never received the verdict render; (2) the case a `--no-update` flag would serve — "does this branch have a PR?" — is already answered, read-only and completely, by `host-pr status`, so the flag would add a second way to do the same thing with a write verb; and (3) the actual damage was never "the body changed", it was "the close phrase vanished", which is exactly what the guard refuses. Revisit only if a caller appears that must reuse a PR *and* must not touch its content *and* cannot use `status` — none exists today.

### The flip side — a bare mention is also an action

Convention 4 governs the phrase that closes an issue **on purpose**. Nothing governed the flip side until now: on a tracker with a native GitHub integration, the integration does not distinguish "the phrase that means close this" from "any other sighting of this issue's id" — it links **every** bare issue id it finds in a merged PR's title or body, and a linked issue is an issue the integration can act on. **An issue id belongs in a PR title or body only when closing that issue at merge is intended.** Do not name a bare tracker id to reference, credit, or contextualize other work — that reference is itself a close-shaped action on an integrated tracker, whether or not a Convention-4 close phrase is present anywhere.

**KW-F5 — a working close phrase is itself the warning, not the all-clear.** The first Linear consumer wave confirmed this: its store-kind close phrases resolved rows correctly, which is direct proof the GitHub↔Linear integration is *live and connected* on that workspace — and a live integration is exactly what acts on a **bare** id too. If `Fixes <TEAM-NN>` closes a row here, then a stray `<TEAM-NN>` anywhere in a PR title or body is acted on with the same reach. So the close phrase working is a reason to keep id-scrub discipline **strict**, never a signal that the tracker is lenient about incidental mentions.

The sanctioned alternative for docs/meta PRs that legitimately discuss other work — an ADR write-up, a retro, a wave-shared change spanning multiple rows — is to reference the **ADR number or spec/doc slug** (`ADR-0024`, `2026-07-19-hardening-w6`), never the bare tracker id. An ADR/spec identifier names the artifact without being integration-linked.

When this footgun *does* fire, the detection side is the closing probe: an issue closed by a stray mention leaves **no closing-PR evidence**, so `issue-store read-closing` reports it `closed-unknown` — the fourth outcome, an "evidence claim, not a verdict" (ADR-0020). The done-reconcile must **report** such a row, never auto-flag it as a rejection: `closed-unmerged` is reserved for a PR that was found and did not merge, and a mention-closed row is not that. Prevention (this convention) and honest detection (`closed-unknown`) are the two halves of the same W2-F1c defect.

This is a real footgun, not a hypothetical — it has fired twice, on a bare title mention with no close phrase anywhere in the body (history: `../evidence/convention-04-store-kind-close-phrase.md`, read via the sibling-path read when actually wanted, ADR-0040).

### The reviewer-verdict render — the other half of the PR body

Convention 4 governs *closing* the issue; this governs *informing the merge decision*. The close phrase alone leaves the human who reviews and lands the PR blind to what the Reviewer actually found — the verdict, the AC-verification table, re-run test counts, advisories — none of which lives anywhere the human looks. **A render lives where its reader lives, and a machine never reads a render back:** the sidecar (`.flotilla/waves/<slug>/verdicts/<id>-<iter>.md`) stays the full typed authority a machine resumes/routes from — never trimmed; the PR is the *one* human-facing render, written once at PR-open; the tracker carries state + pointers only (rung, AC ticks, PR attachment) — a prose result parked on the ticket would tax `listOpen`/`readTriage` on every future planning cycle.

`{{wave-cli}} render-verdict <verdictsDir> <id> --anchor <sha>` is the single-owner render (`renderVerdictSection()`, `reviewer-verdict-schema.ts`): it reads the MAX-iter valid ReviewerVerdict sidecar for `<id>` — the same `sidecar.ts` reader `verdict-acked` uses — and prints a compact `## Reviewer verdict` markdown section (verdict + iteration, the per-AC table, re-run verify counts, anchor SHA, advisories) to stdout. Call it at the `approved → pr-created` terminator (wave-start's PR-open step, right where the store-kind close phrase above is composed) and fold its output into the `--body` passed to `host-pr create`. Because the sidecar reader always resolves the LATEST iteration, a changes-requested → re-dispatch cycle's PR body carries the verdict that actually approved the row, never the stale first one:

```bash
# ONE Bash call. The render is captured and CONSUMED here, in the call that
# produced it — it is the PR body's own input, so it never crosses a call
# boundary (Convention 12, half two). The guard is INLINE for that reason: a
# check issued in a later call would inspect a variable that is unset in its own
# shell, which is not a weaker guard but no guard at all.
VERDICT_SECTION=$({{wave-cli}} render-verdict "$VERDICTS" "$ID" --anchor "$ANCHOR_SHA")
if [ -z "$VERDICT_SECTION" ] || [ "$VERDICT_SECTION" = "null" ]; then
  echo "STOP: VERDICT_SECTION came back empty — render-verdict did not run. Refusing to open a PR whose body silently omits the verdict." >&2
  exit 1
fi
{{wave-cli}} host-pr create --branch <branch> --title "<title>" \
  --body "<summary>

$VERDICT_SECTION

<the store-kind close phrase, on its own line>"
```

**Why this capture is in the guarded class.** An empty `VERDICT_SECTION` never means "there was no verdict" — `render-verdict` either finds a valid MAX-iter sidecar and prints a section, or it fails. So emptiness means the verb *did not run*, and the `--body` above would then be composed **without** the render while still reading as a complete PR body: the close phrase present, the summary present, and the one section the human lands the PR on silently gone. That is the same failure shape as the empty PR URL of the `#83` gate run — a missing value that looks exactly like a legitimate one — which is why it stops the terminator rather than degrading quietly. `wave-start/reference/start-mechanics.md`'s step 7c is this same site inside the live dispatch sequence and carries the identical guard; the two are one shape and must not diverge.

Kept compact by construction — this is a projection of the sidecar, not the full typed payload — because a re-dispatch Worker or a rebase resolver reading PR context reads this render too.
