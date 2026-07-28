## Convention 4 — the store-kind close phrase (PR body)

The magic word a merged PR's body must carry to close/link the issue is **derived from the configured store kind** (`wave.config.json`'s `store.kind`), not hardcoded — a PR is always a GitHub artifact in both known consumers, but the phrase the *tracker* recognizes differs (ADR-0020):

| `store.kind` | Close phrase | Example |
|---|---|---|
| `github` | `Closes #<issue-number>` | `Closes #42` |
| `linear` | `Fixes <TEAM-NN>` | `Fixes EX-16` |

Read `store.kind` off the consumer's `wave.config.json` (the same file `{{wave-cli}}` resolves via `--config`) and compose the PR body with the matching phrase whenever a terminator opens a PR (`wave-start`'s `approved → pr-created` step). For a `linear` store this phrase is also what creates the merged-PR attachment `issue-store read-closing` reads (the Linear closing probe, ADR-0020) — get the phrase wrong and the row never resolves past `in-review`/`pr-created` even though the code merged.

`linear`'s Linear-GitHub-integration precondition (installed + connected to the code repo) must already hold for this to work at all — `wave-setup`'s Linear operational-preconditions checklist confirms it before the store is ever configured.

**Opening the PR goes through the engine — `{{wave-cli}} host-pr create`, never `gh pr create`.** The PR-open is the ADR-0023 last mile: every host write goes through the engine host seam, and `create` is that verb (`gh`'s creds are sandbox-denied and its TLS fought the proxy MITM cert in every live run — creation only ever worked sandbox-off). It is **find-before-create idempotent**: an OPEN PR already on the branch is reused (`outcome: reused`) **and its title/body are re-written to the `--title`/`--body` you pass** (`updated: true` discloses it), a missing one is created (`outcome: created`) — so a cap=1 re-dispatch onto the same branch never opens a duplicate, yet the render you compose still reliably lands on the live PR (last-writer-wins; the render is written once at PR-open). The `--body` you pass carries the store-kind close phrase above, verbatim, and per the mention-footgun below it is the **only** tracker id the title or body may contain:

```bash
{{wave-cli}} host-pr create --branch <branch> --title "<title, no bare tracker id>" \
  --body "<summary>

<the store-kind close phrase, on its own line — e.g. Fixes EX-16>"
# exit 0 → stdout JSON carries .url (outcome: created | reused) — pin that as the row's PR URL.
# create reads GITHUB_TOKEN from the environment (never printed); github-only in M1,
# bitbucket/unknown fail loud + typed like the landing verbs.
```

### The flip side — a bare mention is also an action

Convention 4 governs the phrase that closes an issue **on purpose**. Nothing governed the flip side until now: on a tracker with a native GitHub integration, the integration does not distinguish "the phrase that means close this" from "any other sighting of this issue's id" — it links **every** bare issue id it finds in a merged PR's title or body, and a linked issue is an issue the integration can act on. **An issue id belongs in a PR title or body only when closing that issue at merge is intended.** Do not name a bare tracker id to reference, credit, or contextualize other work — that reference is itself a close-shaped action on an integrated tracker, whether or not a Convention-4 close phrase is present anywhere.

**KW-F5 — a working close phrase is itself the warning, not the all-clear.** The first Linear consumer wave confirmed this: its store-kind close phrases resolved rows correctly, which is direct proof the GitHub↔Linear integration is *live and connected* on that workspace — and a live integration is exactly what acts on a **bare** id too. If `Fixes <TEAM-NN>` closes a row here, then a stray `<TEAM-NN>` anywhere in a PR title or body is acted on with the same reach. So the close phrase working is a reason to keep id-scrub discipline **strict**, never a signal that the tracker is lenient about incidental mentions.

The sanctioned alternative for docs/meta PRs that legitimately discuss other work — an ADR write-up, a retro, a wave-shared change spanning multiple rows — is to reference the **ADR number or spec/doc slug** (`ADR-0024`, `2026-07-19-hardening-w6`), never the bare tracker id. An ADR/spec identifier names the artifact without being integration-linked.

When this footgun *does* fire, the detection side is the closing probe: an issue closed by a stray mention leaves **no closing-PR evidence**, so `issue-store read-closing` reports it `closed-unknown` — the fourth outcome, an "evidence claim, not a verdict" (ADR-0020). The done-reconcile must **report** such a row, never auto-flag it as a rejection: `closed-unmerged` is reserved for a PR that was found and did not merge, and a mention-closed row is not that. Prevention (this convention) and honest detection (`closed-unknown`) are the two halves of the same W2-F1c defect.

Two live occurrences are the evidence this is a real footgun, not a hypothetical:

- **w2 (2026-07-16):** `FOR-13` resolved to `Done` mid-session with the trigger unconfirmed at the time — PR #9's title/body named "FOR-13" though FOR-13 was not the row that PR landed (docs/retros/2026-07-16-hardening-w2.md).
- **2026-07-19:** a docs-only PR (#29) whose **title** mentioned `FOR-6` and `FOR-33` — no Convention-4 close phrase anywhere in the body — was squash-merged, and the Linear GitHub integration moved both issues to `Done` before either had even been dispatched in the wave that was about to build them. Recovery required an out-of-band state reset (raw-GraphQL reopen) before the wave could run.

### The reviewer-verdict render — the other half of the PR body

Convention 4 governs *closing* the issue; this governs *informing the merge decision*. The close phrase alone leaves the human who reviews and lands the PR blind to what the Reviewer actually found — the verdict, the AC-verification table, re-run test counts, advisories — none of which lives anywhere the human looks. **A render lives where its reader lives, and a machine never reads a render back:** the sidecar (`.flotilla/waves/<slug>/verdicts/<id>-<iter>.md`) stays the full typed authority a machine resumes/routes from — never trimmed; the PR is the *one* human-facing render, written once at PR-open; the tracker carries state + pointers only (rung, AC ticks, PR attachment) — a prose result parked on the ticket would tax `listOpen`/`readTriage` on every future planning cycle.

`{{wave-cli}} render-verdict <verdictsDir> <id> --anchor <sha>` is the single-owner render (`renderVerdictSection()`, `reviewer-verdict-schema.ts`): it reads the MAX-iter valid ReviewerVerdict sidecar for `<id>` — the same `sidecar.ts` reader `verdict-acked` uses — and prints a compact `## Reviewer verdict` markdown section (verdict + iteration, the per-AC table, re-run verify counts, anchor SHA, advisories) to stdout. Call it at the `approved → pr-created` terminator (wave-start's PR-open step, right where the store-kind close phrase above is composed) and fold its output into the `--body` passed to `host-pr create`. Because the sidecar reader always resolves the LATEST iteration, a changes-requested → re-dispatch cycle's PR body carries the verdict that actually approved the row, never the stale first one:

```bash
VERDICT_SECTION=$({{wave-cli}} render-verdict "$VERDICTS" "$ID" --anchor "$ANCHOR_SHA")
{{wave-cli}} host-pr create --branch <branch> --title "<title>" \
  --body "<summary>

$VERDICT_SECTION

<the store-kind close phrase, on its own line>"
```

Kept compact by construction — this is a projection of the sidecar, not the full typed payload — because a re-dispatch Worker or a rebase resolver reading PR context reads this render too.
