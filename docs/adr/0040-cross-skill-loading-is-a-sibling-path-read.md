# Cross-skill loading is a sibling-path read, not a by-name invocation

`wave-shared` declares `disable-model-invocation: true` and teaches "siblings load it by name" — a contradiction: the flag removes the skill from the list a model may invoke, so a Coordinator cannot execute that instruction through the Skill tool in *any* context. Project-local the contradiction never surfaced, because a Coordinator in flotilla's own repo can simply Read `.claude/skills/wave-shared/` from its cwd. Installed form has no such path — and the dual-form spelling (`/wave-shared` project-local, `/flotilla:wave-shared` installed) answered only the *naming* question, never the model-invocation bar. wave-shared's own load note named the missing clean-room probe as a residual gap. On 2026-08-13 the probe ran live, unplanned: flotilla's first fully-external consumer dispatched a wave, the Coordinator could not load wave-shared, and the operator had to invoke `/flotilla:wave-shared` by hand. The gap is closed; the result is negative.

## Decision

**Agent-side cross-skill loading is a file read against the loading skill's own base directory — `../wave-shared/SKILL.md` plus every file under `../wave-shared/reference/` — one spelling in every distribution context.**

- **The anchor always exists.** The harness hands every loaded skill its own base directory; siblings sit beside it — identically in source form, in the plugin clone, and in a vendored copy. No namespace knowledge, no Skill tool, no human in the loop.
- **`disable-model-invocation: true` stays.** The flag was never the defect — it correctly keeps a library skill from auto-triggering as a standalone; the defect was a by-name loading doctrine written against it. The description becomes honest: "loaded via sibling-path read by the execution skills," not "invoked by name by its siblings."
- **Dual-form narrows to humans.** The glossary term keeps its role for by-name recommendations addressed to a person (slash commands); agent-side loading is out of its scope entirely.
- **The load note trades inference for evidence.** wave-shared's "plugin-namespaced by-name loads" section replaces its reasoned-inference passage with the live occurrence (2026-08-13, installed-form consumer: model load impossible, operator hand-invoke required) and the sibling-path remedy.
- **The interim is a release note, not onboarding.** CHANGELOG/release notes carry one known-issue line for ≤ 1.4.0 ("first wave-start: invoke `/flotilla:wave-shared` by hand once"); ONBOARDING gets no permanent paragraph — durable docs do not document a defect the fix removes.
- **The acceptance criterion is the clean-room probe, run deliberately this time**: in a repo that knows flotilla only as the installed plugin, a wave skill demonstrably gets wave-shared's content into context with no human hand. The next consumer wave is the natural site.
- **Convention 16 rides the same mechanism** (ADR-0039): its long form under `wave-shared/reference/` is the first non-execution consumer of the sibling-path read — the front half reads that one file without loading wave-shared's schemas.

## Considered Options

- **Drop the flag, model-invoke by namespaced name** (rejected) — the bare/namespaced choice stays context-dependent (the prefixed form does not exist project-local; the bare form does not exist installed), and a model-invocable library skill can auto-trigger where it never should. The read needs neither.
- **Duplicate the content into the loading skills** (rejected) — wave-shared exists precisely against that drift; its schemas are byte-for-byte copies under a drift guard for the same reason.
- **Keep the operator hand-invoke** (rejected) — canonizes today's workaround: a human as the loading mechanism of an AFK pipeline.
- **A plugin-root variable in prose** (rejected) — `${CLAUDE_PLUGIN_ROOT}` expands in config surfaces (hooks, MCP), not in skill prose, and has no project-local counterpart; the base-directory anchor is handed to the agent in both worlds.

## Consequences

- wave-start and wave-close (plus wave-close's phase-1 reference file) swap their load line for the sibling-path read; wave-shared's description and load note update; the CHANGELOG known-issue line lands. One reviewed wave row (ADR-0033); this ADR lands Coordinator-direct and closes no issue.
- ADR-0018's dual-naming anticipation ("`/wave-shared` project-local; `/flotilla:wave-shared` once packaged") is superseded *as a loading mechanism*; it stays accurate for what a human types.
- The sibling-path read is the established composition seam for future library files — Convention 16's long form (ADR-0039) is its first new consumer.

## Amendment (2026-09-16) — `${CLAUDE_SKILL_DIR}` evaluated

Filed against #537. The Decision and Considered Options above are unchanged; this fills the one gap the Considered Options left open — the harness-substituted variable a follow-up review found missing from the original evaluation.

**`${CLAUDE_SKILL_DIR}` is the harness-documented per-skill anchor.** Claude Code's own Agent Skills reference defines it: "the directory containing the skill's `SKILL.md` file. For plugin skills, this is the skill's subdirectory within the plugin, not the plugin root." That is exactly the per-skill base-directory anchor the Decision above already rests the sibling-path read on — handed to the agent as a harness-guaranteed substitution rather than left to inference.

**Two surfaces, both documented, and no third.** The harness substitutes `${CLAUDE_SKILL_DIR}` — and, for a plugin skill, `${CLAUDE_PLUGIN_ROOT}` — in exactly two places: the skill's own markdown content, and the Bash rules inside its `allowed-tools` frontmatter. Neither variable is substituted anywhere outside the skill's own file — not in a hook script, not in an MCP config entry.

**The plugin-root variable's Considered-Options entry is corrected, not re-argued.** That bullet rejected `${CLAUDE_PLUGIN_ROOT}` because it "expands in config surfaces (hooks, MCP), not in skill prose" — checked against the documentation above, that reason is wrong: `${CLAUDE_PLUGIN_ROOT}` substitutes in the identical two surfaces `${CLAUDE_SKILL_DIR}` does, skill markdown content included. The reason that still holds, and that stands in its place, is the bullet's other clause: `${CLAUDE_PLUGIN_ROOT}` is substituted **only in plugin skills** — a project-local skill (this repo's own source form) has no such variable at all, so it cannot anchor a load line that has to read identically in both distribution forms. `${CLAUDE_SKILL_DIR}` carries no such asymmetry: it substitutes in a project-local skill exactly as it does in a plugin skill.

**Standing: named, not adopted.** The bare relative sibling-path read (`../wave-shared/SKILL.md`, resolved against the skill's own base directory) stays the shipped spelling. `${CLAUDE_SKILL_DIR}` is now the named remedy for the one thing the Decision above still lists as outstanding — the clean-room probe, run from an installed-form consumer with no human hand — and that probe is what decides between the two forms, not this amendment. No load line in any skill switches to the variable here; this amendment records evaluation, not adoption.
