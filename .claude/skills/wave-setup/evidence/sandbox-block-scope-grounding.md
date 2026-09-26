# The tracked `sandbox` block's scope — grounding beyond the baseline probe

Evidence class — moved out of [reference/setup-mechanics.md](../reference/setup-mechanics.md#measuring-whether-the-tracked-sandbox-block-is-honored--the-probe-issue-716-adr-0049s-one-open-assumption) (issue #817, 2026-09-26) so the go/no-go rule stays in the reference as its own compact form; this file is the documentation citation and structural analogy behind it.

## Why this grounding exists

The baseline discrimination probe (positive/negative control, in the reference doc) proves the filesystem sandbox is live and enforced against a dispatched worktree agent's own Bash calls. It does not, by itself, prove that a *declared, tracked* `sandbox.filesystem.allowWrite` entry would widen that same baseline for that same agent — a dispatched agent cannot write `.claude/settings.json` itself and then observe the effect on its own next call. Issue #716 read Claude Code's own published settings documentation rather than assume either way, ahead of running the live-gate that closes the remaining gap.

## The documentation finding

Issue #716 read Claude Code's own published settings documentation (`code.claude.com/docs/en/settings` and `/settings-reference`, fetched 2026-09-04): `sandbox.filesystem.allowWrite` and `sandbox.network.allowedDomains` — the exact two keys ADR-0049 decision 3 names — carry **"Any file"** scope, meaning nothing excludes them from a shared, project-committed `.claude/settings.json`. That is a real, load-bearing distinction the same reference draws elsewhere: twelve other `sandbox.*` subkeys (`sandbox.filesystem.disabled`, `sandbox.network.strictAllowlist`, `sandbox.bwrapPath`, and nine more — the security-sensitive ones a project file could otherwise use to *weaken* the sandbox for every future agent, not just widen a path) are restricted to user, local, or managed sources only — precisely the shape a self-widening escape would need, and precisely the shape ADR-0049 already worries about for the `host` class. `filesystem.allowWrite` / `network.allowedDomains` are not on that restricted list.

## The structural analogy

`sandbox` and `permissions` live in the identical settings file, read by the identical loader, under the identical "shared project settings" scope rule — and that rule is not theoretical: it is what issue #716's own dispatch ran under, since that worktree's own tracked `permissions.allow` (read directly, not inferred) is demonstrably what let that dispatch run its engine/git/npm calls unprompted.

This documentation-plus-analogy finding is what the reference calls **positive** — proceed to scaffold, and let the live-gate settle the rest for this consumer's own machine and harness build.
