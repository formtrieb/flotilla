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
   it stays portable. The token is a **setup-time binding, not a form chosen at
   invocation time**: it stands for the one command string a repo's
   `wave.config.json` names under `engine.cli` — authored once by `wave-setup`,
   read there, resolved host-side when an invocation is composed. There is no
   invocation-form ordering and no fallback chain to reason through: a configured
   binding that fails is a STOP (a broken install, config or release), and an
   absent one means `wave-setup` has not finished in that repo. Concrete
   invocation forms therefore appear in exactly one place — `wave-setup`'s
   scaffold — and every other skill reads the configured value. That binding is
   also what pins a repo to one distribution form per layer: a consumer runs the
   installed form (plugin + npm package), this repo runs the source form on both
   layers because it builds what it runs, and neither is a runtime choice
   (ADR-0032).
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

The skill set, its phases, and the rewrite-generic-from-the-Ur plan predate the
publication cut (ADR-0026) and survive only in the private ops archive — the
public authorities are the ADRs. Read `docs/CHARTER.md` (§4–§10) for the
engine/adapter split, `docs/adr/0009-harness-agnostic-engine-no-dispatch-host.md`
for why there is no `DispatchHost` seam, and `CONTEXT.md` for the glossary,
before authoring a skill here.
