## Convention 7 — the host landing seam + the done-reconcile evidence hierarchy

Landing (arm / merge) and the host-side merge probe are **code-host** writes/reads, not tracker ones, and they all go through the engine's **`host-pr`** verb group (ADR-0023) — never raw `gh` (its creds are sandbox-denied and its TLS stack fought both the keychain and the proxy MITM cert, live-proven). Three shipped verbs, detect-host-routed, with `github` the one shipped adapter; the Bitbucket pilot implements the same interface and inherits them with no new skills:

- **`host-pr arm --branch <b>`** — the `--auto` landing intent (wave-close phase 4b). It decides **per PR**: checks pending → **enable auto-merge** (GraphQL); already clean → **direct merge now** (REST). Idempotent (`already-merged` on a re-run). Outcomes: `armed` / `merged` / `already-merged` / `refused` / `no-pr`.
- **`host-pr merge --branch <b>`** — merge now, no arm intent (the caller already decided).
- **`host-pr status --branch <b>`** — the merge probe: `{ state: open|merged|closed-unmerged|none, url? }`. `none` ("no PR for this branch") is a valid answer, not a failure.

None take `--config` — landing talks to the **code host**, not the tracker; the adapter builds from `$GITHUB_TOKEN`. Under a proxied sandbox, the tracked `env` block is the standing source for the proxy flag (Convention 1); prefix `NODE_USE_ENV_PROXY=1` explicitly only where no tracked env block applies. The creation verb `host-pr create` is the *staged* half (ADR-0023 decision 3) and is not yet a CLI verb — PR creation still rides the Worker terminator.

**The done-reconcile evidence hierarchy — tracker attachment > host PR state > nothing.** Both `wave-close` (phase 5) and `wave-resume` (step 5) land a merged row `done` the same way, consulting evidence in this order:

1. **Tracker attachment** — `issue-store read-closing <id>`. On a native-integration tracker a merged PR attaches and this reports `merged` directly.
2. **Host PR state** — `host-pr status --branch <b>`, consulted **only when tier 1 cannot see a merge** (a no-integration workspace — Linear without the GitHub integration, or the Bitbucket pilot — where `read-closing` stays `open` / `closed-unknown` even after the PR lands). The host answers "did the PR for this branch merge?" mechanically.
3. **Nothing** — when neither tier proves a merge, leave the row `in-review` and report; a later touch reconciles.

On a merge proven by *either* tier, derive `--acked` first — `{{wave-cli}} verdict-acked <verdictsDir> <id>` (FOR-17, ADR-0004; the single-owner derivation of the reviewer-met AC indexes from that row's FINAL Reviewer verdict — never hand-parse `acVerification[]`) — then `issue-store close <id> <prUrl> --acked <indexes>` records the closing facts + the cosmetic AC tick and, on a `states.doneState` store, fires the FOR-13 done-state fallback. This **replaces the old out-of-band human-confirmation step** with a probe — a human is never asked to hand-assert a merge the host can report. Both execution skills derive `--acked` the same way before every merged-row `close` call — see `wave-close`'s [reference/close-mechanics.md](../../wave-close/reference/close-mechanics.md) and `wave-resume`'s [reference/resume-mechanics.md](../../wave-resume/reference/resume-mechanics.md) for the worked invocation; never call `close` on a merged row without it (the FOR-17 dead-wire bug).

**Arm-and-exit, not watch.** `--auto` arms and exits; the host completes merges server-side (surviving a dead Coordinator). Late merges — and an armed PR whose checks later fail — reconcile on the next `wave-close` / `wave-resume` touch, not live. This latency is accepted and documented, never papered over with a poll loop.
