# Bitbucket token-scope measurement provenance

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#bitbucket-token-permissions) (issue #734) so this narrative stops costing every run its bytes. The operative facts (the four-scope minimal set and the `read:pipeline:bitbucket` recommendation) stay in the reference; this file is the measurement story behind them — why each is believed, on what evidence, and what remains open.

## The documented minimal set — spec provenance

Re-measured 2026-08-15 against Atlassian's own Bitbucket Cloud REST API OpenAPI specification (`developer.atlassian.com/cloud/bitbucket/swagger.v3.json`, read fresh at triage rather than recalled). Each operation's `security` field names the OAuth-scope form of a permission — `repository`, `repository:write`, `pullrequest`, `pullrequest:write` — and the granular API-token scope picker a consumer actually uses when minting a Bitbucket token names the same four permissions with a `:bitbucket` suffix and the read half spelled out; the reference always states that granular form, so a reader can check the spec's OAuth-form annotations directly against the table there.

## Predicted-vs-live status of the four-scope set

The spec predicts the repository pair alone fails at the very first pull-request call — none of `status`/`preflight`/`arm`/`merge`/`create` can complete without `read:pullrequest:bitbucket`/`write:pullrequest:bitbucket`. The 2026-08-13 live verification pass (the same run the `read:pipeline:bitbucket` finding below cites) succeeded because the consumer had additionally granted pull-request-specific scopes on its own judgment, alongside the repository pair — that is *why* it passed, not evidence that the repository pair alone would have. A live round-trip on **exactly** these four scopes and nothing else remains the open item: stamp it once at the next Bitbucket pilot wave, the established one-time e2e-stamp pattern.

## `read:pipeline:bitbucket` — the live-verification detail

Live-verified 2026-08-13. Granting `read:pipeline:bitbucket` on top of the four-scope set, verified against a live Bitbucket consumer: both `allow-auto-merge` and `required-checks` move from `unknown` to `advisory` with real content instead of a blind spot — `allow-auto-merge` reads whether "Allow automatic merge when builds pass" is enabled on the default branch (read as **not enabled** on that consumer's `main`), `required-checks` reports the configured passing-build count (`require_passing_builds_to_merge`, ≥1 required on that consumer).

## `admin:repository:bitbucket` — the open collision, not a settled fact

A broader-sounding option that does not subsume the four scopes above. Atlassian's own documentation is explicit: this scope grants repository *admin* features only (see Atlassian's own scope documentation for the full list of what it covers) and does **not** implicitly grant any of the four scopes above. A token that already carries `admin:repository:bitbucket` for other reasons still needs the four scopes above granted **separately** before it can serve a single call the engine's Bitbucket adapter issues — there is nothing to inherit from the admin scope for that purpose. This is not a recommendation to grant it *for* flotilla specifically; it is a correction of what a token carrying it for other reasons does and does not already cover.

**The open collision:** Atlassian's per-operation spec annotates the branch-restrictions read behind the `allow-auto-merge`/`required-checks` checks as needing exactly this scope (`repository:admin` in OAuth form) — not `read:repository:bitbucket`, which is what the reference table claimed for it before 2026-08-15. This is **not** promoted into the four-scope minimal set, because whether the 2026-08-13 live pass actually needed `admin:repository:bitbucket` for that read is unresolved, not confirmed either way.

## Branch-restrictions and merge-capability reads — a recorded uncertainty

Spec annotation vs. live observation on a token whose grant set was never recorded — neither is promoted into the four-scope minimal set. Atlassian's per-operation spec annotates the branch-restrictions read behind both the `allow-auto-merge` and `required-checks` preflight checks as `repository:admin` (the collision named above), and it annotates the workspace-scoped user-permissions read behind the `pr-merge-token` merge-capability check as `account` + `repository`. Neither annotation has been checked against a token minted to exactly that scope: the 2026-08-13 live pass read both successfully, but on a token whose complete grant set was never recorded, so that pass is evidence *some* working grant set includes these reads, not evidence of which scope actually authorized them.

Consequence for a wave: all three checks already degrade gracefully by contract — `allow-auto-merge`, `required-checks`, and `pr-merge-token` report `unknown` (never `fail`) on any read they cannot resolve, so an under-scoped token here costs posture *visibility*, not a wave. No consumer needs to grant `admin:repository:bitbucket` or `account` speculatively to close this gap — grant the four scopes in the reference, and let these checks report what they can see.
