# flotilla skills — the Claude-Code driver layer (P7)

This directory is flotilla's **harness layer**. The engine under `tools/wave/`
is a pure, harness-agnostic TypeScript library (it imports only `node:*` +
`fast-glob` + `micromatch`); it calls no Claude-Code primitives. The skills here
*are* the driver — they are the only place that knows about Claude Code, parallel
subagent dispatch, and the schema-validated-subagent-return guarantee
(CHARTER §4 + §9: the skills *are* the Claude-Code driver — there is no
`DispatchHost` adapter; see also ADR-0009).

## How a skill talks to the engine

Each `<skill>/SKILL.md` reaches the engine in one of two ways:

1. **Sync engine ops — shell into the CLI router.** For a single deterministic
   computation (DOR gate, files-drift, merge-order, conflict-map, cross-wave,
   spine read/mutate, resume reconcile, the issue-store surface), the skill runs:

   ```sh
   {{wave-cli}} <subcommand> [...args]
   ```

   Each SKILL.md writes the engine invocation as the token **`{{wave-cli}}`** so
   it stays portable. Your setup pins how it resolves; **in-repo that is
   `npx tsx tools/wave/src/cli.ts`** (a published plugin pins it via `wave-setup`).
   The router (`tools/wave/src/cli.ts`) dispatches to the per-subcommand runner
   and returns a JSON result + a meaningful exit code. Subcommands:
   `dor`, `files-drift`, `merge-order`, `closed-by`, `detect-host`,
   `worktree-cleanup`, `conflict-map`, `cross-wave`, `issue-store`, `spine`,
   `resume`. The store behind `issue-store` is chosen from `wave.config.json`
   (Markdown-FS or GitHub Issues), so skills never hard-code a tracker — they
   stay tracker-agnostic by construction.

2. **Parallel dispatch — compose a Workflow.** The fan-out step (dispatch N AFK
   agents into isolated worktrees, collect their schema-validated returns) is a
   Workflow script the skill composes; it is *not* an engine call. The engine
   only supplies the reasoning the Workflow consumes (the conflict-map /
   cross-wave overlap analysis, the merge-order, the resume reconstruction).

## Branch + landing model

Protected `main`, **PR-only landing for everything** — never direct-push to the
default branch. The WAVE.md spine is branch-local and does not merge to `main`.

## Where the design lives

The skill set, its phases, and the rewrite-generic-from-the-Ur plan are in
`docs/superpowers/plans/2026-06-06-p7-overview.md`. The integration surface these
skills shell into (the CLI runners wired in P7.1) is in
`docs/superpowers/plans/2026-06-06-p7.1-integration-surface.md`. Read
`docs/CHARTER.md` (§4–§10) for the engine/adapter split and `CONTEXT.md` for the
glossary before authoring a skill here.
