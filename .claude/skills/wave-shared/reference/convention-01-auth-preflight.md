## Convention 1 — auth-preflight (detect-host → verify)

Before **any** tracker write in an execution skill, confirm the host is reachable and authenticated. flotilla never shells a tracker CLI directly — it goes through the engine's host seam.

1. `detect-host` — resolves the configured store and its host (e.g. `github`).
2. Verify auth for that host through the engine (the engine owns the `GitHubApi` seam; the skill never runs raw `gh`). A failed preflight aborts the dispatch **before** any claim or spine flip — you never want a half-authenticated run that claims an issue it cannot later transition.

This is a precondition, not a routing step: run it once at the top of `wave-start` / `wave-reviewer` / `wave-close`, surface a clear abort on failure.

> **Raw-fetch adapters vs. a sandboxed harness (proxy requirement).** The real `GitHubApi`/`LinearApi` impls talk over raw `fetch` (ADR-0019/0020) — no `gh`/`git` subprocess. The `host-pr` landing verbs (ADR-0023) are raw-fetch too. Under a sandboxed harness that forces outbound HTTP through a proxy, Node's global `fetch` ignores the proxy env by default and the call fails with `EPERM`/`ECONNREFUSED` (a false "unreachable host / unauthenticated" surface). On **Node ≥ 24**, every engine CLI call that hits the network — the auth-preflight, `issue-store *`, `read-closing`, the store-preflight, and `host-pr arm|merge|status` — needs **`NODE_USE_ENV_PROXY=1`** set so raw `fetch` honours `HTTP(S)_PROXY`.
>
> **The tracked settings `env` block is the standing source for this flag.** `wave-setup` scaffolds `{"env": {"NODE_USE_ENV_PROXY": "1"}}` into the consumer's tracked `.claude/settings.json` (wave-setup's "Scaffolding the tracked permission allowlist and env block"), and flotilla's own tracked settings carry it the same way — every command the harness runs in that repo inherits the flag process-wide, with no per-call prefix and no way to forget it. The explicit per-call prefix is the **documented fallback**, for a context where no tracked env block (yet) applies — a fresh consumer repo before `wave-setup` has run, or a harness without settings-env support:
>
> ```bash
> NODE_USE_ENV_PROXY=1 npx tsx tools/wave/src/cli.ts detect-host <remote-url> --config <path>
> ```
>
> A local-git-only command (`git worktree`, `git push`) does not need this — it is a raw-`fetch`-only concern. If auth-preflight fails inside a proxied sandbox and no tracked env block covers this repo yet, check this flag before concluding the token is bad.

> **Sandbox footgun (KW-F6) — `env -u GITHUB_TOKEN gh …` does not match a `gh *` allowlist/excludedCommands prefix.** A sandbox rule keyed on the `gh *` command prefix never fires on an `env`-wrapped invocation: the command the sandbox actually parses starts with **`env`**, not `gh`, so `env -u GITHUB_TOKEN gh …` slips the prefix match entirely. flotilla's sanctioned path never shells `gh` (all host writes go through the engine's raw-`fetch` seam, above), so this cannot bite there — but if you ever reach for a raw `gh` diagnostic under a sandbox, know that wrapping it in `env` defeats the very `gh` prefix rule you were relying on to scope it.
