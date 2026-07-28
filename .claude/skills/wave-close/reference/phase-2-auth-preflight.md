# Phase 2 — Auth preflight (skip when no host writes pending)

**Guard:** if every row's `Closed-by:` already classifies as `real-pr` (`needsPin: false`), skip the network entirely — print `no host writes pending (no-op)`.

Detect the host: `{{wave-cli}} detect-host "$(git remote get-url origin)"`. `host: unknown` → print `(advisory) unknown host — landing is manual; proceed with advisory-only` (do not STOP — the advisory path continues; the automated landing needs a `host-pr` adapter, which only `github` ships). Then verify auth before any write. On 401 → STOP with an actionable message: refresh the token and re-run.

> **You are the Coordinator and you are about to handle a credential — Convention 8 binds you, not only the briefs you compose.** `wave-close` receives no brief; the clause forbidding a secret echo lives in `workerBrief()`'s policy clause 5, which the Coordinator *authors* and never *reads*. So the sanctioned form is written out here rather than cited — a pointer is not read at the moment someone types a check.
>
> If you need to know whether a host token or tracker key is set, this is the only sanctioned form, and it is value-free:
>
> ```bash
> [ -n "$GITHUB_TOKEN" ] && echo set    # prints `set` or nothing — never the value
> ```
>
> **`${VAR:-no}` is a trap, not a presence test.** `${VAR:-fallback}` substitutes **the value** whenever the variable *is* set — the fallback branch fires only when it is *absent* — so the expression that reads as a yes/no check prints the live credential on precisely the machine that has one. `${VAR:+yes}${VAR:-no}` is the same trap wearing a disguise: the `:+` half really does print `yes`, so the output starts out looking right, and the `:-` half appends the key behind it. Also: no `printenv`, no bare `env`/`set`, and no read of a gitignored settings or `.env`-class file — the `permissions.deny` anchor blocks reading those files, but it cannot reach an already-exported environment variable. **Two of this class's six live occurrences were Coordinators running exactly this kind of check at exactly this kind of preflight step**, each costing a credential rotation (wave-shared Convention 8).

> **Landing verbs vs. the creation verb (ADR-0023).** The three **landing** verbs `host-pr arm | merge | status` are shipped — `--auto` (phase 4b) and the phase-5 done-reconcile fallback use them, and each builds the host adapter from `$GITHUB_TOKEN` with its own construction-time preflight. The **creation** verb `host-pr create` (the find-before-create PR pinning that would move Closed-by placeholders off the `gh` path) is the *staged* half (ADR-0023 decision 3) and is **not yet a CLI verb** — PR creation still rides the Worker terminator. `detect-host` runs now regardless.
