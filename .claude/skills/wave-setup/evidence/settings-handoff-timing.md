# Settings hand-off — timing measurements

Evidence class — moved out of [../SKILL.md](../SKILL.md) (issue #734) so these historical timing notes stop costing every run its bytes. Neither measurement changes a rule; both explain why a step exists the shape it does.

## Why `--create-missing-labels` exists

Measured live on a fresh consumer (2026-09-03), before the `store-preflight --create-missing-labels` flag existed: the label hand-off, not the interview, was where a stranger's first ten minutes went — clearing thirteen missing labels one `gh label create` at a time. The flag turns that hand-off into a single re-run.

## Cost of the AFK harness config + guard-hook hand-offs

Measured live (2026-09-03), on the harness build current at that date, before this file's two-path revision (issue #734): staging `.claude/settings.json` plus both guard-hook copies and completing the operator hand-off for all three together cost about ten minutes of a fresh setup, one approval each. The two-path rule ([reference/setup-mechanics.md](../reference/setup-mechanics.md#afk-harness-config-scaffold-env-block--permission-allowlist-claudesettingsjson)) can now skip the hand-off (and its cost) entirely whenever the harness permits the edit tool that session.
