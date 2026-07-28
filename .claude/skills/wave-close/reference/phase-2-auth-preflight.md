# Phase 2 — Auth preflight (skip when no host writes pending)

**Guard:** if every row's `Closed-by:` already classifies as `real-pr` (`needsPin: false`), skip the network entirely — print `no host writes pending (no-op)`.

Detect the host: `{{wave-cli}} detect-host "$(git remote get-url origin)"`. `host: unknown` → print `(advisory) unknown host — landing is manual; proceed with advisory-only` (do not STOP — the advisory path continues; the automated landing needs a `host-pr` adapter, which only `github` ships). Then verify auth before any write. On 401 → STOP with an actionable message: refresh the token and re-run.

> **Landing verbs vs. the creation verb (ADR-0023).** The three **landing** verbs `host-pr arm | merge | status` are shipped — `--auto` (phase 4b) and the phase-5 done-reconcile fallback use them, and each builds the host adapter from `$GITHUB_TOKEN` with its own construction-time preflight. The **creation** verb `host-pr create` (the find-before-create PR pinning that would move Closed-by placeholders off the `gh` path) is the *staged* half (ADR-0023 decision 3) and is **not yet a CLI verb** — PR creation still rides the Worker terminator. `detect-host` runs now regardless.
