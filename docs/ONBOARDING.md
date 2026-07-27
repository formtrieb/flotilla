# Onboarding: adopting flotilla in a consumer repo

flotilla installs. The skills come as a Claude Code plugin, the engine from the public npm registry, and neither requires you to copy anything into your repo. Vendor-copy — the path every consumer used before `0.1.0-beta.0` — still works and is documented at the bottom as a fallback, but it is no longer the way in.

**This is a beta.** Not because the orchestration is new — it has driven flotilla's own development across thirty-plus live waves — but because the install path in front of it is. [CHANGELOG.md](../CHANGELOG.md) names exactly which parts have not been proven yet, including one that matters here: the end-to-end gate *through the installed plugin* has not been run, so if something in this document is wrong, that is the likeliest place. Reports welcome.

## What you install

Two pieces, deliberately decoupled — a plugin install runs no `npm install`, so the engine cannot live inside the plugin directory:

- **The plugin** — the Claude Code skills that drive the engine: `wave-setup`, `wave-plan`, `wave-create`, `wave-start`, `wave-reviewer`, `wave-close`, `wave-resume`, `wave-shared` (shared conventions/schemas), plus the planning front half `triage`, `to-prd`, `to-issues`, and the Reviewer agent.
- **The engine** — [`@formtrieb/flotilla-engine`](https://www.npmjs.com/package/@formtrieb/flotilla-engine) on npm. You do not install this yourself; the skills resolve it as `npx @formtrieb/flotilla-engine`, which needs nothing present in your repo.

## The adoption path, end to end

1. **Install the plugin.** In Claude Code, inside the repo you want to run waves in:
   ```
   /plugin marketplace add formtrieb/flotilla
   /plugin install flotilla@formtrieb
   ```
2. **Check the engine resolves.** Nothing to install — this should print the verb list:
   ```bash
   npx @formtrieb/flotilla-engine
   ```
   If it does not, stop here rather than debugging it from inside a wave later.
3. **Run the `wave-setup` skill** (invoke it in Claude Code inside your repo). It interviews you on three things — which issue tracker/store you're using, the eligibility label set that marks an issue wave-grabbable, and an optional verify profile (build/test commands to run against an agent's changed files) — and writes `wave.config.json`.
4. **Let `wave-setup` validate and preflight the config.** It runs `config validate` (does the JSON parse into a valid `WaveConfig`?) and then `cli-store preflight` (do the *live* store preconditions actually hold — tracker↔host integration, workflow-state catalog, PR-merge token?). Fix anything either step flags before continuing; do not hand a config to the next step until both exit clean.
5. **Get issues wave-ready.** Use `triage` to work incoming issues into a ready state, `to-prd`/`to-issues` to turn a plan or spec into wave-eligible issues (each carrying a declared file scope, a risk/worker classification, and acceptance criteria) — or hand-author issues in the same shape if you're not starting from a PRD.
6. **Run `wave-plan`** to draw the current wave-eligible candidate set and cross-check it against anything another wave already has claimed. Read-only and advisory — you pick which ids go into a wave.
7. **Run `wave-create`** with the chosen ids to materialize a spine (the durable per-wave orchestration record) and set the soft `queued` claim on each issue.
8. **Run `wave-start`** to dispatch. Every row gets a Worker (a worktree-isolated agent that implements it) and, once the Worker reports, a universal Reviewer (schema-validated verdict, deterministic routing to approve / request-changes / stop). `wave-start` ends with every non-held row in-review — it never merges anything.
9. **Review and land the PRs** — through your normal code-host flow, or through the engine's `host-pr` verbs where wired. Then run **`wave-close`** to compute the advisory merge order (accounting for any declared file overlap between rows), clean up the agent worktrees, and archive the spine.
10. **If your Coordinator session dies mid-wave**, don't restart from scratch — run **`wave-resume`**. It reconciles state from the spine (the write-ahead-log authority), the live worktrees, and the on-disk sidecars, then re-dispatches only what actually needs it.

## Preconditions checklist

Work through this before your first real wave — most of these fail silently rather than loudly if skipped.

- **Tracker choice + host integration for auto-`done`.**
  - **GitHub Issues:** a merged PR whose body contains `Closes #N` (or `Fixes #N`) auto-closes the issue — this is what the engine's closing-probe reads as "done."
  - **Linear:** install the Linear↔GitHub integration on the team/repo pair, and make sure every wave PR's body carries `Fixes <TEAM-NN>` (e.g. `Fixes EX-16`) — not GitHub's phrase. Without the integration, a merged PR never creates the attachment the closing-probe reads, and no row will ever resolve to `done`. If you genuinely cannot install the integration, there is an opt-in `states.doneState` config fallback (documented in the `wave-setup` skill) — set it deliberately, not speculatively.
  - `wave-setup`'s preflight step (`cli-store preflight`) probes what it can automatically; the magic-word convention and PR-route discipline below are not machine-checkable and need a human confirmation.
- **Protected default branch / PR route.** Every wave branch must land via a pull request against a protected default branch — never a direct push, never a fast-forward-only/no-PR merge mode. Resume, the merge-order computation, and the closing-probe all depend on PRs being the landing mechanism.
- **Environment keys.** `GITHUB_TOKEN` for a `github` store and for the engine's PR-landing (`host-pr`) verbs; `LINEAR_API_KEY` for a `linear` store. Both adapters talk raw HTTP to their API — there is no `gh`/`git` subprocess dependency for reading or writing issues. Export whichever key(s) your store config needs before running any wave skill; the engine fails loudly and immediately if the key is missing.
- **Proxy note.** If you're running on Node ≥ 24 behind a harness or environment that routes outbound traffic through a proxy, Node's global `fetch` does not honor proxy environment variables by default — engine CLI calls that hit the network need `NODE_USE_ENV_PROXY=1` set so the raw-`fetch` adapters route correctly. Without it you'll see a misleading "unreachable host" or auth failure that is actually a proxy bypass. The **standing source** for this flag is the tracked settings `env` block — `wave-setup` scaffolds `{"env": {"NODE_USE_ENV_PROXY": "1"}}` into your repo's tracked `.claude/settings.json` (step 3 below), and every command your harness runs then inherits it with no per-call prefix. Prefixing each call explicitly is the **documented fallback** for before `wave-setup` has run, or for a harness without settings-env support.
- **AFK permission allowlist.** A wave runs unattended: `wave-start` dispatches Workers and Reviewers that execute without a human at the keyboard, so every command they run passes through your agent harness's permission gate. Before running a wave headless, confirm your harness allowlists the wave's command surface — worktree git operations (`git worktree add/remove`, fetch/reset/checkout/commit/push on wave branches), your verify-profile commands, and the engine CLI itself. An un-allowlisted command means an agent stalls on a prompt nobody is there to answer. `wave-setup` scaffolds this allowlist, with `npx @formtrieb/flotilla-engine` as the canonical engine entry — a consumer with no vendored copy needs nothing beyond what it writes. Check its output covers **your verify-profile commands**, which it cannot guess.
- **Worktree-brief inputs.** A worktree checkout carries tracked files only — anything gitignored (a dependency directory, `wave.config.json` itself) is simply absent there. Decide upfront: if your dependency directory is gitignored, what's the install command each dispatched agent needs to run first; if `wave.config.json` is gitignored, the Coordinator needs to embed the full issue spec (title, body, acceptance criteria, declared files, risk) into each dispatch brief rather than a bare tracker id, since the agent has no config to resolve one against. Both answers are Coordinator-composition inputs, not engine config — record them wherever you compose dispatch briefs.

## Fallback: vendor-copy

Installing is the way in. Copying still works, and there are repos where it is the right call — a harness that cannot install plugins, an air-gapped environment with no registry access, or a consumer who wants to fork the skills and diverge rather than track upstream.

Two directories, both self-contained:

- **`tools/wave/`** — the engine. Plain TypeScript, no build step, its own `package.json`.
- **`.claude/skills/`** — the skills. Merge rather than overwrite if you already have unrelated skills there.

Copy `tools/wave/` at the same relative path, since the fallback invocation forms name it literally, then `cd tools/wave && npm ci`. From there the path above is identical from step 3 onward — the vendored CLI and the published package route to the same engine, so nothing downstream changes.

What you give up is the thing the install exists to provide: pulling a fix forward becomes a re-copy and a manual reconciliation of whatever you changed locally, rather than a version bump.

## Where to go next

- [docs/CHARTER.md](CHARTER.md) — the full architecture and the reasoning behind each seam.
- [CONTEXT.md](../CONTEXT.md) — the domain glossary (what a Coordinator, a Worker, a Reviewer, a Spine, a claim rung, etc. mean precisely).
- [docs/adr/](adr/) — the individual decisions, one per file, each with the options that were rejected and why.
- [CLAUDE.md](../CLAUDE.md) — if you're contributing to flotilla itself, not just consuming it in your own repo.
