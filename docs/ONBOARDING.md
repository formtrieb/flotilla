# Onboarding: adopting flotilla in a consumer repo

flotilla installs. The skills come as a Claude Code plugin, the engine from the public npm registry, and neither requires you to copy anything into your repo. Vendor-copy — the path every consumer used before `0.1.0-beta.0` — still works and is documented at the bottom as a fallback, but it is no longer the way in.

For current release status — what's stable, what's proven, what changed release to release — see [README.md](../README.md) and [CHANGELOG.md](../CHANGELOG.md). This document covers adoption mechanics only.

## What you install

Two pieces, deliberately decoupled — a plugin install runs no `npm install`, so the engine cannot live inside the plugin directory:

- **The plugin** — the Claude Code skills. The wave lifecycle: `wave-setup`, `wave-plan`, `wave-create`, `wave-start`, `wave-reviewer`, `wave-close`, `wave-resume`, `wave-shared` (shared conventions/schemas). The planning front half: `goal`, `triage`, `to-prd`, `to-issues`. Two utilities: `report` (file a fully-analyzed finding about flotilla itself upstream at flotilla's repo — consent-first, it never files without your explicit go) and `grill-with-docs` (stress-test a design decision against your domain docs). Plus the Reviewer agent.
- **The engine** — [`@formtrieb/flotilla-engine`](https://www.npmjs.com/package/@formtrieb/flotilla-engine) on npm. You do not install this by hand: running the `wave-setup` skill (step 3 below) scaffolds it as a pinned `devDependency` and records the ONE resulting invocation form — for an ordinary Node consumer, the pinned local binary `./node_modules/.bin/flotilla-engine` — under `engine.cli` in `wave.config.json`. From that point every skill reads the configured value; none of them resolve the engine at call time (ADR-0032).

## The adoption path, end to end

| # | Step | What happens — and what to watch |
| --- | --- | --- |
| 1 | **Install the plugin.** In Claude Code, inside the repo you want to run waves in: `/plugin marketplace add formtrieb/flotilla`, then `/plugin install flotilla@formtrieb` | The skills are now available; the engine is not yet installed (that's step 3). |
| 2 | *(Optional)* **Poke at the engine**: `npx @formtrieb/flotilla-engine` | Should print the verb list. This is the exploration-only bootstrap form — unpinned, not recorded anywhere, and slow (~82s per call vs. ~1.2s pinned, because registry resolution runs on every invocation). A sanity check that the package resolves at all, nothing more; it never runs again once step 3 has completed. If it does not print the verb list, **stop here** rather than debugging it from inside a wave later. |
| 3 | **Run the `wave-setup` skill** in Claude Code inside your repo | It interviews you on three things — which issue tracker/store, the eligibility label set that marks an issue wave-grabbable, and an optional verify profile (build/test commands to run against an agent's changed files) — installs the engine as a pinned local package, and writes `wave.config.json` with the ONE invocation form under `engine.cli` (ADR-0032). Every skill from here on reads that binding. |
| 4 | **Let `wave-setup` validate and preflight** | Three checks in order: `config validate` (does the JSON parse into a valid `WaveConfig`?), `store-preflight` (do the *live* tracker preconditions hold — tracker↔host integration, workflow-state catalog?), `host-pr preflight` (does the *live* code-host posture hold — PR-merge token, "Allow auto-merge," required checks? Store-blind, so it runs identically regardless of tracker). **Fix anything flagged before continuing.** |
| 5 | **Name a finish line — `goal`** *(optional, any time)* | Cuts a named finish line as a container bound in `wave.config.json` — `store.goal.container`, a setup-time config fact: GitHub defaults to its Milestone, the markdown store to its goal file, Linear has no default and refuses loudly until you set one. Three passes: **cut** mints the container and files its opening frontier as bare placeholder tickets — no planning header, no readiness marker, so nothing it creates is wave-eligible on its own; **curation** joins members, including the handoff when a placeholder is sliced by `to-prd`/`to-issues`; **status** reads the five-state frontier and writes nothing. Sight, never permission: membership never stamps eligibility, never dispatches, and the station never declares the goal reached — closing the container is your act on the tracker. |
| 6 | **Get issues wave-ready** | `triage` works incoming issues into a ready state; `to-prd`/`to-issues` turn a plan or spec into wave-eligible issues (each carrying a declared file scope, a risk/worker classification, and acceptance criteria) — or hand-author issues in the same shape. |
| 7 | **Run `wave-plan`** | Draws the current wave-eligible candidate set and cross-checks it against anything another wave already has claimed. Read-only and advisory — you pick which ids go into a wave. |
| 8 | **Run `wave-create`** with the chosen ids | Materializes a spine (the durable per-wave orchestration record) and sets the soft `queued` claim on each issue. |
| 9 | **Run `wave-start`** | Every row gets a Worker (worktree-isolated agent) and, once the Worker reports, a universal Reviewer (schema-validated verdict, deterministic routing to approve / request-changes / stop). Ends with every non-held row in-review — **it never merges anything.** |
| 10 | **Review and land the PRs, then run `wave-close`** | Land through your normal code-host flow, or through the engine's `host-pr` verbs where wired. `wave-close` computes the advisory merge order (accounting for declared file overlap between rows), cleans up the agent worktrees, and archives the spine. |
| 11 | **Coordinator died mid-wave? Run `wave-resume`** | Don't restart from scratch. It reconciles state from the spine (the write-ahead-log authority), the live worktrees, and the on-disk sidecars, then re-dispatches only what actually needs it. |

## Preconditions checklist

Work through this before your first real wave — most of these fail silently rather than loudly if skipped.

| Precondition | Why it matters | How to check |
| --- | --- | --- |
| **Host integration for auto-`done` — GitHub Issues** | A merged PR whose body contains `Closes #N` (or `Fixes #N`) auto-closes the issue — this is what the engine's closing-probe reads as "done." | `store-preflight` probes what it can; the magic-word convention itself is not machine-checkable and needs a human confirmation. |
| **Host integration for auto-`done` — Linear** | Without the Linear↔GitHub integration installed on the team/repo pair, a merged PR never creates the attachment the closing-probe reads, and no row will ever resolve to `done`. Every wave PR's body must carry `Fixes <TEAM-NN>` (e.g. `Fixes EX-16`) — Linear's phrase, not GitHub's. | Install the integration before the first wave. If you genuinely cannot, there is an opt-in `states.doneState` config fallback (documented in the `wave-setup` skill) — set it deliberately, not speculatively. |
| **Protected default branch / PR route** | Every wave branch must land via a pull request against a protected default branch — never a direct push, never a fast-forward-only/no-PR merge mode. Resume, the merge-order computation, and the closing-probe all depend on PRs being the landing mechanism. | Repo settings: branch protection/ruleset on the default branch; `host-pr preflight` checks the code-host posture ("Allow auto-merge," required checks, merge token). |
| **Credentials** | `GITHUB_TOKEN` (github store + `host-pr` verbs) and `LINEAR_API_KEY` (linear store) resolve through the engine's one credential seam (ADR-0029). | See [Credentials](#credentials) below — the path is chosen by environment lifetime, not placement preference. |
| **Proxy (Node ≥ 24)** | Node's global `fetch` does not honor proxy environment variables by default — engine CLI calls that hit the network need `NODE_USE_ENV_PROXY=1`, or a proxy bypass masquerades as a misleading "unreachable host"/auth failure. | The **standing source** is the tracked settings `env` block — `wave-setup` scaffolds `{"env": {"NODE_USE_ENV_PROXY": "1"}}` into `.claude/settings.json`, and every command your harness runs inherits it. Prefixing each call explicitly is the documented fallback for before `wave-setup` has run, or for a harness without settings-env support. |
| **AFK permission allowlist** | A wave runs unattended — every command a dispatched Worker/Reviewer runs passes through your harness's permission gate, and an un-allowlisted command means an agent stalls on a prompt nobody is there to answer. | `wave-setup` scaffolds the allowlist: worktree git operations, the engine CLI as the ONE entry matching your configured `engine.cli` binding (plus its `NODE_USE_ENV_PROXY=1`-prefixed twin) — **not** the exploration-only `npx` bootstrap form, which has no ongoing role after setup and earns no entry. Check the output covers **your verify-profile commands**, which it cannot guess. |
| **Worktree-brief inputs** | A worktree checkout carries **tracked files only** — anything gitignored (a dependency directory, `wave.config.json` itself) is simply absent there. | Decide upfront: if your dependency directory is gitignored, what install command does each dispatched agent run first? If `wave.config.json` is gitignored, the Coordinator must embed the full issue spec (title, body, acceptance criteria, declared files, risk) into each dispatch brief rather than a bare tracker id. Both are Coordinator-composition inputs, not engine config — record them wherever you compose dispatch briefs. |

### Credentials

Both keys resolve through the engine's one credential seam (ADR-0029): a per-project **lookup command**, configured as `<VAR>_CMD` in the tracked settings `env` block, wins over the ambient `<VAR>` and fails loud rather than falling back silently. Two first-class paths, **chosen by environment lifetime, not a placement preference** — and no third rung:

| Environment | Path | Mechanics |
| --- | --- | --- |
| **Long-lived interactive machine** (an operator's laptop, a persistent dev box) | **Lookup-command scaffold** — the default; `wave-setup` scaffolds it | Three artifacts: a keychain item holding the secret; the `<VAR>_CMD` entry in the **tracked** `.claude/settings.json` `env` block naming the lookup command (never the secret itself); a matching `permissions.deny` entry blocking the harness's own Bash tool from running that lookup command directly. |
| **Ephemeral environment** (CI) | **Ambient variable** — first-class by design, no deprecation horizon | CI injects a per-job-scoped token into a minutes-lived environment with no keychain to speak of. |
| Not yet ready for the scaffold | **direnv + keychain**, scoped to the project directory | An explicit half-measure, stated as such — never a global shell-profile export, which reopens the exact wrong-scope problem the scaffold exists to close (one over-broad token shared across every repo the operator touches). |

The nuances that have bitten before:

- **Why the tracked settings file:** `wave-start` dispatches every Worker/Reviewer into a worktree that carries **tracked files only**, so the gitignored `.claude/settings.local.json` never reaches it (verified live against a dispatched worktree). That is exactly why the `<VAR>_CMD` entry has to live in the tracked `.claude/settings.json` — and why the raw secret must never be placed in either settings file. Both adapters talk raw HTTP to their own API — no `gh`/`git` subprocess dependency — and the engine fails loudly and immediately if a required key is missing.
- **A present token is not a scoped token.** Check `GITHUB_TOKEN` against the engine's actual call surface before a wave — the full table (classic PAT scopes vs. fine-grained repository permissions, endpoint by endpoint) is in the `wave-setup` skill's `reference/setup-mechanics.md`. Call out **`workflow` scope (classic) / `Workflows: Read and write` (fine-grained)** specifically if any wave row's declared Files touch `.github/workflows/**` — GitHub refuses a `git push` that adds/modifies a workflow file without it, independent of every other scope being correct, and this has stopped a wave at the push step before with no warning ahead of time.
- **`GITHUB_TOKEN` and `gh`'s own auth are two different credentials.** The engine only ever talks to `GITHUB_TOKEN` over raw HTTP — it never shells out to `gh`. `gh`'s login matters only if you run a `gh` command yourself outside the wave pipeline (e.g. `gh repo create`, which needs a permission the wave token deliberately does not have). Check `gh auth status` and `GITHUB_TOKEN`'s presence independently; a mixed failure between the two otherwise reads as one confusing error.
- **`LINEAR_API_KEY` cannot substitute for the Linear↔GitHub integration.** The key lets the engine read/write Linear issues; it has no bearing on whether a merged PR ever creates the closing attachment. Both are separate preconditions — a correctly-scoped key on a workspace with no integration installed will run a wave that never resolves a row to `done`, silently.

## Fallback: vendor-copy

Installing is the way in. Copying still works, and there are repos where it is the right call — a harness that cannot install plugins, an air-gapped environment with no registry access, or a consumer who wants to fork the skills and diverge rather than track upstream.

Two directories, both self-contained:

- **`tools/wave/`** — the engine. Plain TypeScript, no build step, its own `package.json`.
- **`.claude/skills/`** — the skills. Merge rather than overwrite if you already have unrelated skills there.

Copy `tools/wave/` at the same relative path, then `cd tools/wave && npm ci`. `wave-setup` (step 3 above) then binds `engine.cli` to that vendored path directly — the same way flotilla's own dogfood config does — rather than to the pinned-package form the ordinary Node path uses. From there the path is identical from step 3 onward: every skill still reads the one configured `engine.cli` value, it just names the vendored binary instead of `./node_modules/.bin/flotilla-engine`.

What you give up is the thing the install exists to provide: pulling a fix forward becomes a re-copy and a manual reconciliation of whatever you changed locally, rather than a version bump.

## Where to go next

- [README.md](../README.md) — the pipeline diagram, the skill table, and current release status.
- [CHANGELOG.md](../CHANGELOG.md) — what changed release to release, including what each release has and has not proven yet.
- [docs/CHARTER.md](CHARTER.md) — the full architecture and the reasoning behind each seam.
- [CONTEXT.md](../CONTEXT.md) — the domain glossary (what a Coordinator, a Worker, a Reviewer, a Spine, a claim rung, etc. mean precisely).
- [docs/adr/](adr/) — the individual decisions, one per file, each with the options that were rejected and why. [ADR-0032](adr/0032-engine-invocation-is-a-setup-time-binding.md) records the setup-time engine binding this document teaches.
- [CLAUDE.md](../CLAUDE.md) — if you're contributing to flotilla itself, not just consuming it in your own repo.
