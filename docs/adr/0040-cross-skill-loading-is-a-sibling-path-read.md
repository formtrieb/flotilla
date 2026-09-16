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
