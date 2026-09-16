## Convention 4 — the store-kind close phrase (PR body)

**Enforced by:** engine refusal — `tools/wave/src/compose-driver.ts` (derives the phrase from the configured store kind) and `tools/wave/src/host-pr.ts` (refuses a PR reuse that would drop it).

The magic word a merged PR's body must carry to close/link the issue is **derived from the configured store kind** (`wave.config.json`'s `store.kind`), not hardcoded — a PR is always a GitHub artifact in both known consumers, but the phrase the *tracker* recognizes differs (ADR-0020):

| `store.kind` | Close phrase | Example |
|---|---|---|
| `github` | `Closes #<issue-number>` | `Closes #42` |
| `linear` | `Fixes <TEAM-NN>` | `Fixes EX-16` |

Read `store.kind` off the consumer's `wave.config.json` (the same file `{{wave-cli}}` resolves via `--config`) and compose the PR body with the matching phrase whenever a terminator opens a PR (`wave-start`'s `approved → pr-created` step). For a `linear` store this phrase is also what creates the merged-PR attachment `issue-store read-closing` reads (the Linear closing probe, ADR-0020) — get the phrase wrong and the row never resolves past `in-review`/`pr-created` even though the code merged.

`linear`'s Linear-GitHub-integration precondition (installed + connected to the code repo) must already hold for this to work at all — `wave-setup`'s Linear operational-preconditions checklist confirms it before the store is ever configured.

**Opening the PR goes through the engine — `{{wave-cli}} host-pr create`, never `gh pr create`.** It is **find-before-create idempotent about *creation***: an OPEN PR already on the branch is reused (`outcome: reused`) rather than duplicated, a missing one is created (`outcome: created`) — so a cap=1 re-dispatch onto the same branch never opens a second PR. **`create` is a WRITE, and reuse REWRITES the PR's title and body.** A reuse re-writes the live PR's title **and** body to the `--title`/`--body` you pass (`updated: true` discloses it) — last-writer-wins, which is exactly what the terminator needs so a re-dispatch's freshly composed render reaches the live PR. **To find out whether a branch already has a PR, use the read-only `{{wave-cli}} host-pr status --branch <branch>` verb** — never `create`. **The one rewrite `create` refuses.** Because the close phrase lives in that body, a rewrite that drops it is the expensive silent failure: the PR merges normally, the row never reaches `done`, and the wave looks finished with one issue quietly open. So a reuse whose passed body carries **no** close phrase, over a live PR body that **does**, is **refused** — exit 1, `outcome: reuse-refused`, a `reason` naming the phrase at risk, and **no write at all**. A legitimate re-dispatch is unaffected (a composed render always carries its phrase), and `--allow-close-phrase-loss` is the deliberate override for a human replacing a PR body wholesale. The check is presence, not identity: a body carrying a *different* phrase passes, and a live body that was never readable is never refused on (absence of evidence is not a finding). **Compose the phrase on its own line — that is what the guard recognizes.** A phrase buried mid-sentence (`Summary of the work. Closes #42 as part of the batch.`) is therefore **not** recognized and **not** protected — the guard declines to fire rather than risk refusing a legitimate rewrite it misread. The ADR-0023/ADR-0015 rationale for routing through the engine, the exit-code walkthrough, the DA-F6 incident where a single exploratory call overwrote a live PR's title and body, and the recorded decision against a non-rewriting `--no-update` form all live in `../evidence/convention-04-store-kind-close-phrase.md`.

Hand path:

```bash
{{wave-cli}} host-pr create --branch <branch> --title "<title, no bare tracker id>" --body-file <path-to-composed-body>
```

### The flip side — a bare mention is also an action

On a tracker with a native GitHub integration, the integration does not distinguish "the phrase that means close this" from "any other sighting of this issue's id" — it links **every** bare issue id it finds in a merged PR's title or body, and a linked issue is an issue the integration can act on. **An issue id belongs in a PR title or body only when closing that issue at merge is intended.** The sanctioned alternative (ADR number or doc slug, never a bare id), the KW-F5 Linear-integration note, how the closing probe detects a mention-closed row, and the two live incidents that made this convention all live in `../evidence/convention-04-store-kind-close-phrase.md`.

### The reviewer-verdict render — the other half of the PR body

Convention 4 governs *closing* the issue; this governs *informing the merge decision*.

Hand path:

```bash
{{wave-cli}} render-verdict <verdictsDir> <id> --anchor <sha>
```

The single-owner render mechanism, when to call it in the terminator sequence, the guarded hand-run shell form (and why its empty-output check is inline, never split across calls), and the sidecar/PR/tracker responsibility split all live in `../evidence/convention-04-store-kind-close-phrase.md`.
