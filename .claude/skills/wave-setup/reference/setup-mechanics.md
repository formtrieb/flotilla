# wave-setup — setup mechanics

The engine-CLI plumbing for authoring and validating `wave.config.json`. The skill body owns the **judgment** (which store, which eligibility set, whether verify applies); this file owns the **invocation** and the exact config shapes. Reach for it once you know what to write.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. Your setup pins how it resolves; in-repo that is `npx tsx tools/wave/src/cli.ts`. `config validate` does **not** need the store config — it *is* the config check, so it takes the path directly. For other commands that need the store config, place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

## Commands

| Call | Purpose |
|---|---|
| `config validate <path>` | validate a `WaveConfig` JSON file |
| any command, no args | usage |

### Exit codes for `config validate`

| Code | Meaning |
|---|---|
| `0` | valid — the config parsed and all required fields are present |
| `1` | invalid or unreadable — a field failed validation, or the file could not be read/parsed; the error names the cause |
| `2` | usage error — wrong number of arguments or unrecognized flag |

On exit 1, read the error, fix the named field in the JSON, and re-run. Do not pass the config to downstream skills until you get exit 0.

## Store-preflight (`cli-store preflight`) — tracker facts

`config validate` proves the JSON parses; **the store-preflight proves the live TRACKER preconditions hold** (FOR-12). It probes them *for real* through the engine's existing API seam — no separate integration script. The code-host posture (merge token, allow-auto-merge, required-checks) is a **separate owner** — see the host-preflight section below (ADR-0023 amendment: one fact, one owner).

> **Different entrypoint.** The preflight is its own runnable module, **not** a `{{wave-cli}}` (`cli.ts`) subcommand — invoke `tools/wave/src/cli-store.ts` directly:
>
> ```bash
> npx tsx tools/wave/src/cli-store.ts preflight --config wave.config.json
> ```
>
> `--config` selects the store config (default `wave.config.json`). Like the other store-touching verbs, this one builds the real store — a `github` config needs `GITHUB_TOKEN`, a `linear` config needs `LINEAR_API_KEY`, in the ambient env (dogfood in the sandbox: prefix `NODE_USE_ENV_PROXY=1` so the raw-fetch adapters honour the harness proxy on Node ≥ 24).

### What it checks (per store kind)

Each check reports `pass` / `fail` / `not-applicable`; the report `ok` is `true` iff no check is `fail` (a `not-applicable` never blocks).

| Check (`name`) | `github` | `linear` | `markdown` |
|---|---|---|---|
| `tracker-host-integration` | n/a (GitHub is its own host) | **probed** — Linear↔GitHub integration installed? (n/a when `states.doneState` is set — the FOR-13 fallback) | n/a |
| `state-catalog` | n/a (claims are labels) | **probed** — team catalog covers every configured claim state (`Todo`/`In Progress`/`In Review` + `Backlog`/`Canceled` + `doneState`) | n/a |

The report is JSON on stdout:

```json
{
  "ok": false,
  "storeKind": "linear",
  "checks": [
    { "name": "tracker-host-integration", "status": "pass", "detail": "…" },
    { "name": "state-catalog", "status": "fail", "detail": "Configured workflow states missing from the team catalog: \"In Review\". Create them in Linear (or fix the states map) before running a wave." }
  ]
}
```

### Exit codes for `cli-store preflight`

| Code | Meaning |
|---|---|
| `0` | every check passed or is `not-applicable` — safe to hand off to `wave-plan`/`wave-create` |
| `1` | a precondition FAILED loudly (read the failing check's `detail` — it names the gap), **or** the probe/host itself threw (bad token, unreachable host) |
| `2` | usage error, or the config was unreadable/invalid |

On exit 1 from a `fail`, fix the named gap (create the missing Linear state, install the integration or set `states.doneState`) and re-run. Do not hand the config to downstream skills until the preflight exits 0.

## Host-preflight (`host-pr preflight`) — code-host posture

The code-host landing posture has its own owner, the host seam (ADR-0023 amendment / W10-F1): `host-pr preflight` probes the code host **directly**, so it is **store-blind** — no `--config`, no store built, identical on a `github`, `linear`, *or* `markdown` wave (landing always happens on the code host). It is a landing verb, so it lives on the engine CLI:

```bash
{{wave-cli}} host-pr preflight    # detect-host-routed; NO --config, NO --branch
# → { ok, verb: "preflight", host, checks: [ { name, status, detail }, … ] }
```

It builds the posture reader from `$GITHUB_TOKEN` (the same construction-time token check as `host-pr arm|merge|status`); prefix `NODE_USE_ENV_PROXY=1` under a proxied sandbox. `--remote <url>` overrides the detected remote (default `git remote get-url origin`). It takes **no `--branch`** — required checks are read against the repo's **default branch**.

### What it checks (every store kind — code host only)

Each check's `status` is one of `pass` / `fail` / `advisory` / `unknown` (the shared check-status union); `ok` is `true` iff no check is `fail` — `advisory` and `unknown` never block.

| Check (`name`) | Meaning |
|---|---|
| `pr-merge-token` | `pass` if `GITHUB_TOKEN` can merge PRs on the bound repo; `fail` (with a write-access fix) if not. |
| `allow-auto-merge` | `pass` when the repo setting is ON. A visible **OFF** grades by context: **required checks present → `fail`** (arming is structurally impossible; the fix instruction names Settings → General → Pull Requests / `allow_auto_merge=true`), **none → `advisory`** (a clean PR direct-merges today). `unknown` when the token cannot see the setting (below maintain/admin) — never blocks, never demands admin. |
| `required-checks` | report-only: `advisory` whether present (names the contexts; `--auto` arms) or absent (confirming means an immediate merge); `unknown` when the branch-protection read needs admin the token lacks. |

### Exit codes for `host-pr preflight`

| Code | Meaning |
|---|---|
| `0` | nothing `fail`ed (checks may be `advisory`/`unknown`) — the code host can land rows under `--auto` |
| `1` | a check `fail`ed (read its `detail` — it names the fix), the host has no adapter (`code: "adapter-not-implemented"` — bitbucket/unknown), or the host errored / `GITHUB_TOKEN` was missing |
| `2` | usage error |

On exit 1 from a `fail`, apply the fix the `detail` names (grant the token write access; tick "Allow auto-merge") and re-run. A no-CI repo where `allow-auto-merge` is `advisory` is a valid `--auto` consumer — it does not block.

## `WaveConfig` fields

| Field | Required | Shape |
|---|---|---|
| `store` | yes | `MarkdownStoreConfig`, `GitHubStoreConfig`, or `LinearStoreConfig` (see below) |
| `verify` | no | `VerifyConfig` — omit entirely if the consumer has no build gate |

### `MarkdownStoreConfig`

| Field | Required | Shape |
|---|---|---|
| `kind` | yes | `"markdown"` |
| `repoRoot` | yes | absolute path string |
| `slug` | yes | kebab-key string (identifies the issue set) |
| `eligibility` | no | `string[]` — defaults to `["ready-for-agent"]` |

### `GitHubStoreConfig`

| Field | Required | Shape |
|---|---|---|
| `kind` | yes | `"github"` |
| `eligibility` | no | `string[]` — defaults to `["ready-for-agent"]` |

> There is **no `repo` field** on `GitHubStoreConfig`. The `gh` ambient context (the current directory's tracked remote) supplies the repo. Adding a `repo` field will fail validation.

### `LinearStoreConfig`

| Field | Required | Shape |
|---|---|---|
| `kind` | yes | `"linear"` |
| `team` | yes | Linear team key or display name (e.g. `"EX"` or `"Example"`) — owns the workflow-state catalog + label namespace. Use the exact team key as Linear displays it (identifiers read `EX-16` → key `EX`); the lookup is case-sensitive. |
| `project` | no | Linear project display name — scopes `listOpen` to that project; omit for a whole-team draw. Omitting `project` also disables PRD publishing — `to-prd`/`publishDocument` refuses to mint an orphan Document without a bound project (ADR-0017). |
| `eligibility` | no | `string[]` — defaults to `["ready-for-agent"]` |
| `states` | no | `{ queued?, inFlight?, inReview?, doneState? }` — claim-rung → workflow-state-name overrides; defaults to `{"queued": "Todo", "inFlight": "In Progress", "inReview": "In Review"}` (no default `doneState` — see below) |
| `categoryLabels` | no | `Record<string, string>` — triage-category → existing label name (e.g. `{"bug": "Bug", "enhancement": "Improvement"}`) |

#### `states.doneState` — the opt-in no-integration fallback (FOR-13)

**Leave this unset. That is the recommended mode for every consumer with a working Linear↔GitHub integration** — `done` stays fully DERIVED from the tracker's own closing signal (ADR-0002/0020), and the close path is a byte-for-byte no-op-or-reconcile (it only records the closing PR + ticks ACs).

Set `states.doneState` **only** for a consumer workspace that genuinely has **no Linear↔GitHub integration installed** (so the tracker's own probe can never see a PR merge, ever — not a timing issue, a structural one). With it set, once the wave itself has confirmed a row's PR merged, the close path forces a transition to the named workflow state — but only when the issue isn't already terminal (a real integration catching up, or a genuine unmerged close, both win over the fallback and are never overwritten). Each forced transition posts a loud advisory comment on the issue itself, naming the merged PR and reiterating that derived-done remains the preferred mode — that comment is the audit trail distinguishing "closed via the fallback because there's no integration" from "closed for real."

`doneState` must name a state that already exists in the team's own workflow (any category works — pick whichever terminal column this consumer already uses to mean "done", e.g. `"Done"`).

```json
{
  "store": {
    "kind": "linear",
    "team": "EX",
    "states": { "doneState": "Done" }
  }
}
```

> `team` is required — it is how the adapter resolves the workflow-state catalog and the label namespace at construction time. There is no `repo` field here either: the PR itself is still a GitHub artifact; `team`/`project` identify the Linear issue tracker only.

### `VerifyConfig`

| Field | Required | Shape |
|---|---|---|
| `profiles` | yes | `VerifyProfile[]` |

Each `VerifyProfile`:

| Field | Required | Shape |
|---|---|---|
| `name` | yes | string identifier for the profile |
| `appliesTo` | yes | `string[]` of globs — the profile runs when any changed file matches |
| `commands` | yes | `{ cwd?: string; command: string }[]` — run in order; first non-zero exit halts |

`cwd` is optional on each command; if absent, the command runs from the repo root.

## Example configs

### markdown store (dev / dogfood)

```json
{
  "store": {
    "kind": "markdown",
    "repoRoot": "/abs/path/to/repo",
    "slug": "2026-06-18-my-wave",
    "eligibility": ["ready-for-agent"]
  }
}
```

### github store (the M1 target)

No `repo` field — the `gh` ambient context supplies it. `verify` is included here because this consumer (a PHP CMS consumer) has a build gate; omit the entire `verify` key if the consumer does not.

```json
{
  "store": {
    "kind": "github",
    "eligibility": ["ready-for-agent"]
  },
  "verify": {
    "profiles": [
      {
        "name": "cms",
        "appliesTo": ["cms/**"],
        "commands": [
          { "command": "composer install" },
          { "command": "vendor/bin/phpunit" }
        ]
      }
    ]
  }
}
```

The `cms` profile above is a real consumer's own configuration — it is **not** a flotilla default or a template to copy verbatim. Compose the `verify` block from the consumer's actual build gate.

### linear store (ADR-0020 — the Example Project example)

`team` is required; `project` scopes the candidate draw to one Linear project (omit it for a whole-team draw). `states`/`categoryLabels` are shown here overriding the defaults to match this consumer's own workflow-state and label names — omit either key entirely to take the default.

```json
{
  "store": {
    "kind": "linear",
    "team": "EX",
    "project": "Example Project",
    "eligibility": ["ready-for-agent"],
    "states": { "queued": "Todo", "inFlight": "In Progress", "inReview": "In Review" },
    "categoryLabels": { "bug": "Bug", "enhancement": "Improvement" }
  }
}
```

Before writing this config, walk through the SKILL.md "Linear operational preconditions" checklist with the consumer (GitHub integration installed, `Fixes <TEAM-NN>` PR-body convention, PR-route discipline, `Backlog` vs `Todo` team convention) — none of it is engine-checkable, so `config validate` passing does not mean these hold.

#### linear store, no Linear↔GitHub integration (the opt-in `doneState` fallback, FOR-13)

Only for a consumer that confirmed at the preconditions checklist above that they will **not** install the Linear↔GitHub integration. Everything else is identical to the example above; the one addition is `states.doneState`, naming an existing workflow state this team already treats as "done":

```json
{
  "store": {
    "kind": "linear",
    "team": "EX",
    "project": "Example Project",
    "eligibility": ["ready-for-agent"],
    "states": { "queued": "Todo", "inFlight": "In Progress", "inReview": "In Review", "doneState": "Done" }
  }
}
```

Do not add `doneState` speculatively "just in case" — an installed integration already derives `done` correctly, and the fallback only exists to cover the structural gap when there is no integration to derive it from.

## Validation round-trip

Once the JSON is written, validate before handing off to downstream skills:

```bash
{{wave-cli}} config validate wave.config.json
```

Or with an explicit path (dogfood / temp file — use `$TMPDIR`, not a hardcoded `/tmp`: the harness always points `$TMPDIR` at a sandbox-writable directory):

```bash
{{wave-cli}} config validate "$TMPDIR/my-wave-config.json"
```

Exit 0 means the engine will accept it. Any other exit code means there is a problem — the error output names the field; fix it and re-run.

Then, once `config validate` passes, prove the live **tracker** preconditions (integration, state catalog) with the store-preflight, and the live **code-host** posture (merge token, allow-auto-merge, required-checks) with the host-preflight:

```bash
npx tsx tools/wave/src/cli-store.ts preflight --config wave.config.json   # tracker facts
{{wave-cli}} host-pr preflight                                            # code-host posture (store-blind)
```

Exit 0 from each means every check passed / is `not-applicable` / is `advisory`/`unknown`. On exit 1, the failing check's `detail` names the exact gap — fix it in Linear/GitHub or the config and re-run. Only after `config validate` **and both preflights** exit 0 is the config ready for `wave-plan`/`wave-create`.

## AFK harness config scaffold: env block + permission allowlist (`.claude/settings.json`)

The SKILL.md "Scaffolding the tracked permission allowlist and env block" precondition owns the **judgment** (what must be in the env block and on the allowlist, and why `docker` stays off it); this is the concrete scaffold. Write it to the consumer repo's **tracked** `.claude/settings.json` — the ONLY permission *and* environment source an AFK Worker/Reviewer worktree inherits (a worktree carries tracked files only, so the gitignored `.claude/settings.local.json` never reaches it). This is a separate file from `wave.config.json` and is not validated by any engine verb; it is a harness config the consumer commits.

> **The env block, first — the structural fix.** A consumer pattern proven live (the second consumer's tracked settings, observed 2026-07-22): set `NODE_USE_ENV_PROXY=1` in the tracked `env` block and every engine-CLI invocation in the repo inherits it — no per-call prefix, no way to forget it. The raw-fetch adapters need this under a proxied sandbox (wave-shared Convention 1); baking the flag only into allowlist entries instead is fragile in two directions from a single miss — an un-prefixed call silently drops the proxy (a false-`unreachable`/mis-authenticated failure) *and* fails the allowlist's literal prefix match at the same time, hitting the permission gate mid-wave.
>
> **Both engine-CLI invocation forms, deliberately doubled on the allowlist.** With the env block in place the per-call `NODE_USE_ENV_PROXY=1` prefix is *redundant* for every in-repo invocation, so the allowlist names the **prefix-free** forms (both binary styles) as the primary path. The **env-prefixed** forms stay on the allowlist too — they remain valid for existing briefs written before the env block existed and for cross-repo habits that still type the prefix — so neither invocation style hits the gate. The driver's `WAVE_CLI` defaults to the npx-free local binary (`./tools/wave/node_modules/.bin/tsx …`) to dodge the shared-npm-cache-lock `ECOMPROMISED` deaths under fan-out (consumer retro KW-F7), with `npx tsx …` as the documented fallback — so the allowlist names **both** binary styles, each with and without the prefix. Naming only the `npx` form is the exact KW-F3 miss that briefed Workers onto a gated path.

```json
{
  "env": {
    "NODE_USE_ENV_PROXY": "1"
  },
  "permissions": {
    "allow": [
      "Bash(./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts:*)",
      "Bash(NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts:*)",
      "Bash(npx tsx tools/wave/src/cli.ts:*)",
      "Bash(NODE_USE_ENV_PROXY=1 npx tsx tools/wave/src/cli.ts:*)",
      "Bash(git worktree:*)",
      "Bash(git fetch:*)",
      "Bash(git checkout:*)",
      "Bash(git branch:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git reset:*)",
      "Bash(git push:*)",
      "Bash(npm ci:*)"
    ],
    "deny": [
      "Read(.claude/settings.local.json)",
      "Read(**/.claude/settings.local.json)",
      "Read(.env)",
      "Read(.env.*)",
      "Read(**/.env)",
      "Read(**/.env.*)",
      "Bash(cat .claude/settings.local.json:*)",
      "Bash(less .claude/settings.local.json:*)",
      "Bash(more .claude/settings.local.json:*)",
      "Bash(head .claude/settings.local.json:*)",
      "Bash(tail .claude/settings.local.json:*)",
      "Bash(cat .env:*)",
      "Bash(less .env:*)",
      "Bash(more .env:*)",
      "Bash(head .env:*)",
      "Bash(tail .env:*)"
    ]
  }
}
```

- **`env` block** — sets `NODE_USE_ENV_PROXY: "1"` for every command the harness runs in this repo (Bash and the engine CLI alike). This is the recommended mode for every consumer under a proxied sandbox; it makes the per-call prefix on the allowlist entries below redundant, not required — see the rationale above.
- **Engine-CLI invocation forms** — the first four allowlist entries: the npx-free local binary and the `npx` fallback, each named **prefix-free** (the form every in-repo call now resolves to, thanks to the env block) **and** env-prefixed (kept for backwards compatibility with existing briefs and cross-repo habits). If this consumer runs the engine from a different repo-relative path, scaffold that prefix instead — the invariant is *both invocation forms for both binary styles*, not this exact path.
- **Worker git verbs** — `worktree/fetch/checkout/branch/add/commit/reset/push`: the workspace-setup and termination surface (anchor, branch, stage, commit, push) every Worker and Reviewer runs.
- **Deps installer** — the last entry is a placeholder: replace `npm ci` with the consumer's actual `depsSetup` command(s) (`composer install`, `npm ci --prefix tools/wave`, …). It is the **first** Worker step and installs the local `tsx` binary the npx-free `WAVE_CLI` resolves against, so it must be allowlisted too.
- **`deny` block — the secret-echo structural anchor (wave-shared Convention 8, FOR-81).** Three live occurrences of the same class — a Worker's flawed `${VAR:-no}` echo, a Worker's `printenv` whole-environment dump, then a Reviewer's `cat` of the gitignored `.claude/settings.local.json` while hunting a config precedent — each found a vector the previous prose hardening hadn't named. A brief clause depends on an agent having read and internalized it; a `permissions.deny` entry does not. These entries block the `Read` tool, and — as far as the permission syntax can express it — Bash's read-shaped command forms (`cat`/`less`/`more`/`head`/`tail`), against the two file classes every consumer's harness can hold live credentials in: the gitignored local settings file and any `.env`-class file. Scaffold this **identically** to flotilla's own tracked `.claude/settings.json` — the vector is universal, not consumer-specific, so there is no per-consumer judgment to exercise here (unlike the allow-list, which does vary by the consumer's own engine-invocation path). The brief clause (wave-start's `workerBrief()` policy clause 5) stays in place as defense-in-depth on top of this anchor, not a replacement for it.

### Sandbox `excludedCommands` — network git verbs for an SSH origin

When `git remote get-url origin` is an **SSH** remote (`git@…`), the network git verbs must run outside the sandbox's network denial. That is **not just `push`** — `git fetch` (the Worker's anchor fetch at setup) and `git pull` (wave-close's `main` pull) are network operations too. Include all three in the sandbox `excludedCommands` guidance for an SSH origin:

```
git fetch, git pull, git push
```

An **HTTPS** origin that authenticates through the harness proxy does not need this — it is an SSH-origin concern.

### `docker` — kept OUT of the tracked `excludedCommands` (host-escape)

Do **not** scaffold a `docker`-star entry into the tracked `excludedCommands`. A tracked un-sandboxed `docker` grants a host escape to **every future agent of the repo**, not just this wave's Workers — a security review on the first Linear consumer wave flagged exactly this. The proven pattern:

- **Operator-local only.** If the operator needs docker un-sandboxed, it goes in their **untracked** `.claude/settings.local.json`, never the tracked file that Workers inherit.
- **Brief the Worker for graceful degradation** (the Coordinator embeds this in the row's `issueSpec`/verify expectations when a verify step touches docker):
  1. **Socket-free floor, always** — `docker compose config` (validates the compose file) and `bash -n` (syntax-checks scripts) need no daemon; run them unconditionally.
  2. **Live path only when reachable** — run the actual `docker` / `docker compose up` path **only when the docker socket happens to be reachable**.
  3. **Precise deferral disclosure otherwise** — when the socket is unreachable, the Worker names in its report exactly which checks were deferred, so the Reviewer reads a deferred-not-passed signal rather than a false green.
