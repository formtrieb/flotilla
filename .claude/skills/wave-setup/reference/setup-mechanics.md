# wave-setup — setup mechanics

The engine-CLI plumbing for authoring and validating `wave.config.json`. The skill body owns the **judgment** (which store, which eligibility set, whether verify applies); this file owns the **invocation** and the exact config shapes. Reach for it once you know what to write.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): once Procedure step 3 has authored `engine.cli` in `wave.config.json`, that configured value IS `{{wave-cli}}` — read it, never re-derive it.** Every command below means exactly the command string this repo's `wave.config.json` names. An absent `engine.cli` past that point is not something to guess at or route around — it means setup has not finished; stop and finish it before running anything else. There is no invocation-form ordering and no fallback chain to reason through — ADR-0032 abolished both.

Before that binding exists at all — the one-time window before `wave-setup` has ever run in this repo — a prospective consumer can still explore the engine with the unpinned npm bootstrap form, `npx @formtrieb/flotilla-engine <verb>`. That form is exploration-only: unpinned, untracked, and measured at roughly 82 s per call against ~1.2 s for the pinned form once installed (ADR-0032). It never appears again once Procedure step 3 has run. flotilla's own repo is the one deliberate exception to the whole scheme: it binds `engine.cli` to the vendored form, `./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts`, because it builds what it runs — every other consumer binds to the pinned local package instead.

`config validate` does **not** need the store config — it *is* the config check, so it takes the path directly. For other commands that need the store config, place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

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

## Store-preflight (`store-preflight`) — tracker facts

`config validate` proves the JSON parses; **the store-preflight proves the live TRACKER preconditions hold** (FOR-12). It probes them *for real* through the engine's existing API seam — no separate integration script. The code-host posture (merge token, allow-auto-merge, required-checks) is a **separate owner** — see the host-preflight section below (ADR-0023 amendment: one fact, one owner).

> **Unified subcommand form.** `store-preflight` is a `{{wave-cli}}` (`cli.ts` router) subcommand — issue #77 folded the once-separate `cli-store.ts` entrypoint into the router, so invoke it exactly like every other engine op:
>
> ```bash
> {{wave-cli}} store-preflight [--config wave.config.json] [--expect <plugin-version>]
> ```
>
> `--config` selects the store config (default `wave.config.json`). Like the other store-touching verbs, this one builds the real store — a `github` config needs `GITHUB_TOKEN`, a `linear` config needs `LINEAR_API_KEY`, resolved through the engine's credential seam (`credential-resolver.ts`, ADR-0029): a configured `<VAR>_CMD` first, the ambient `<VAR>` otherwise. On Node ≥ 24 under a proxied sandbox this needs `NODE_USE_ENV_PROXY=1` so the raw-fetch adapters honour the harness proxy — the tracked env block below is the standing source for that flag once it's scaffolded; prefix it explicitly (dogfood in the sandbox) only where no tracked env block applies yet.
>
> **This resolution is also the credential live-gate.** Re-running `store-preflight` right after scaffolding a `<VAR>_CMD` entry ([Credential lookup-command scaffold](#credential-lookup-command-scaffold-adr-0029) below) proves the newly-wired lookup command resolves ahead of any stray ambient variable — nothing extra to run.
>
> **`--expect <plugin-version>` (ADR-0032) additionally reports the plugin/engine lockstep comparison, as an ADVISORY-ONLY `engine-version` check.** It never fails the preflight and never moves `ok` — a version skew is a setup-time NOTICE here, not a refusal; the hard version gate that STOPs a wave over the identical comparison lives in `wave-start`'s gate phase instead (`{{wave-cli}} version --expect <plugin-version>` — see [wave-start's reference](../../wave-start/reference/start-mechanics.md)). Supply the SAME plugin version that gate derives — read from `.claude-plugin/plugin.json` at this skill's own resolution anchor (the installed-form consumer's plugin clone) — so setup and dispatch compare against one source, never two; on the source-form repo (skills and engine sharing one SHA by construction) the comparison is vacuous and `--expect` is omitted. A value-less or blank `--expect` is a usage error (exit 2, below), never a silent "no expectation" — see [Exit codes for `store-preflight`](#exit-codes-for-store-preflight).

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

### Exit codes for `store-preflight`

| Code | Meaning |
|---|---|
| `0` | every check passed or is `not-applicable`/`advisory` — safe to hand off to `wave-plan`/`wave-create` |
| `1` | a precondition FAILED loudly (read the failing check's `detail` — it names the gap), **or** the probe/host itself threw (bad token, unreachable host) |
| `2` | usage error, the config was unreadable/invalid, or `--expect` was supplied without a usable `<plugin-version>` value |

On exit 1 from a `fail`, fix the named gap (create the missing Linear state, install the integration or set `states.doneState`) and re-run. Do not hand the config to downstream skills until the preflight exits 0. The `--expect` lockstep check (above) is advisory-only by construction — it can only be `pass`/`advisory`, so it never turns a `0` into a `1`; only a value-less/blank `--expect` moves the exit code, and it moves it to `2`, not `1`.

## Host-preflight (`host-pr preflight`) — code-host posture

The code-host landing posture has its own owner, the host seam (ADR-0023 amendment / W10-F1): `host-pr preflight` probes the code host **directly**, so it is **store-blind** — no `--config`, no store built, identical on a `github`, `linear`, *or* `markdown` wave (landing always happens on the code host). It is a landing verb, so it lives on the engine CLI:

```bash
{{wave-cli}} host-pr preflight    # detect-host-routed; NO --config, NO --branch
# → { ok, verb: "preflight", host, checks: [ { name, status, detail }, … ] }
```

It builds the posture reader from the detected host's own credential (the same construction-time check as `host-pr arm|merge|status`), resolved through the same credential seam as the store preflight — a configured `<VAR>_CMD` first, the ambient `<VAR>` otherwise (ADR-0029), so re-running this after scaffolding the lookup command doubles as its live-gate too; under a proxied sandbox the tracked env block below is the standing source for `NODE_USE_ENV_PROXY=1` — prefix it explicitly only where no tracked env block applies. `--remote <url>` overrides the detected remote (default `git remote get-url origin`). It takes **no `--branch`** — required checks are read against the repo's **default branch**.

Two adapters ship, and the credential differs:

| Detected host | Credential | Notes |
|---|---|---|
| `github` | `GITHUB_TOKEN` / `GITHUB_TOKEN_CMD` | See [GitHub token permissions](#github-token-permissions) below. |
| `bitbucket` | `BITBUCKET_TOKEN` / `BITBUCKET_TOKEN_CMD`, **plus `BITBUCKET_EMAIL`** for the `create` verb | Two token *flavors* satisfy `BITBUCKET_TOKEN`, and only one of them opens a PR — see [SKILL.md's Bitbucket token section](../SKILL.md#bitbucket-token--the-two-flavors-and-which-one-host-pr-create-needs). An **Atlassian account API token**, paired with the account's own email, authenticates Basic (`--user '{atlassian_account_email}:{api_token}'`); scope it per [Bitbucket token permissions](#bitbucket-token-permissions) below. **App passwords no longer work at all** — Atlassian stopped them on 2026-06-09 and removed them on 2026-07-28. `BITBUCKET_EMAIL` is an identifier, not a secret: it belongs in the tracked `env` block next to the `BITBUCKET_TOKEN_CMD` pointer, never in the keychain. Leaving `BITBUCKET_EMAIL` unset makes the landing verbs authenticate with `Authorization: Bearer` instead — the second flavor, a **workspace or repository access token** with no account email attached; `host-pr create` cannot use that form and refuses loudly, naming `BITBUCKET_EMAIL`. |

**What the checks mean on `bitbucket`** (ADR-0023's 2026-08-10 amendment): `allow-auto-merge` reads Bitbucket's `allow_auto_merge_when_builds_pass` branch restriction on the default branch and reports `on` / `off` honestly (`unknown` only when the credential could not see it) — but it is **never a `fail`, whatever the value**, because Bitbucket Cloud exposes **no per-pull-request arming call** in its REST API. Ticking that restriction enables a *human* to click Merge and have Bitbucket watch the build; it gives the engine nothing to call. So there is no misconfiguration for an operator to fix here, and a `fail` would be permanently red on a correctly-configured consumer — noise, not a signal. `required-checks` reads Bitbucket's `require_passing_builds_to_merge` branch restriction, which states a **count** rather than named contexts, so it reports the minimum and names nothing. `pr-merge-token` reads a **user-scoped** permission endpoint, which an access token has no user context for — a `pass` there means "no evidence of a read-only credential", and its `detail` says so; the merge write remains the ground truth. `create-credentials` is the fourth check, and it is **Bitbucket-only** — it never appears in the report on any other host, because on GitHub the create credential is the same `GITHUB_TOKEN` `pr-merge-token` already grades. It reports `pass` when `BITBUCKET_EMAIL` is set and `advisory` (never `fail`) when it is absent or an empty string: the landing verbs stay unaffected either way (they authenticate with Bearer), so the gap is never fatal to `--auto`, but `host-pr create` — which the Worker terminator calls on every wave row — refuses without it, and the `detail` names that consequence up front.

### What it checks (every store kind — code host only)

Each check's `status` is one of `pass` / `fail` / `advisory` / `unknown` (the shared check-status union); `ok` is `true` iff no check is `fail` — `advisory` and `unknown` never block.

| Check (`name`) | Meaning |
|---|---|
| `pr-merge-token` | `pass` if the detected host's landing credential (`GITHUB_TOKEN` on `github`, `BITBUCKET_TOKEN` on `bitbucket`) can merge PRs on the bound repo; `fail` (with a write-access fix) if not — see the `bitbucket` note below the table for how this check reads on that host specifically. |
| `allow-auto-merge` | `pass` when the repo setting is ON. A visible **OFF** grades by context: **required checks present → `fail`** (arming is structurally impossible; the fix instruction names Settings → General → Pull Requests / `allow_auto_merge=true`), **none → `advisory`** (a clean PR direct-merges today). `unknown` when the token cannot see the setting (below maintain/admin) — never blocks, never demands admin. |
| `required-checks` | report-only: `advisory` whether present (names the contexts; `--auto` arms) or absent (confirming means an immediate merge); `unknown` when the branch-protection read needs admin the token lacks. |
| `create-credentials` | **Bitbucket-only** — omitted (`null`) from the checks array entirely on `github` and every other host, because GitHub's create credential is the same `GITHUB_TOKEN` `pr-merge-token` already grades (one fact, one owner). On `bitbucket`: `pass` when `BITBUCKET_EMAIL` is set, **`advisory`** (never `fail`) when it is absent or an empty string — the landing verbs (`arm`/`merge`/`status`/`preflight`) authenticate with Bearer and stay unaffected either way; only `host-pr create` needs the Basic-auth pair this check grades, and its `detail` names that consequence plus the fix. |

### Exit codes for `host-pr preflight`

| Code | Meaning |
|---|---|
| `0` | nothing `fail`ed (checks may be `advisory`/`unknown`) — the code host can land rows under `--auto` |
| `1` | a check `fail`ed (read its `detail` — it names the fix), the host has no adapter (`code: "adapter-not-implemented"` — any remote that is neither github nor bitbucket, including one the engine could not identify at all), or the host errored / the host credential was missing |
| `2` | usage error |

On exit 1 from a `fail`, apply the fix the `detail` names (grant the token write access; tick "Allow auto-merge") and re-run. A no-CI repo where `allow-auto-merge` is `advisory` is a valid `--auto` consumer — it does not block.

## GitHub token permissions

Neither preflight substitutes for checking scope up front — `store-preflight`/`host-pr preflight` probe *some* of the calls below, but a token that fails elsewhere (a labeling call, a `git push` touching a workflow file) still breaks mid-wave rather than at setup. This table is the engine's actual HTTP call surface (`real-github-api.ts`, `host-pr.ts`) mapped to what each form of token needs — check a token against it before a wave, don't infer scope from folklore.

| Engine call | Used by | Classic PAT scope | Fine-grained permission |
|---|---|---|---|
| `GET/POST /repos/{o}/{r}/issues`, `PATCH /issues/{n}` | store: read, create, transition, close | `repo` | Issues: Read and write |
| `POST/DELETE /issues/{n}/labels` | coarse-status projection, needs-attention flag | `repo` | Issues: Read and write |
| `GET/POST /issues/{n}/comments` | closing probe, scribe | `repo` | Issues: Read and write |
| `GET/POST /repos/{o}/{r}/pulls`, `PATCH /pulls/{n}` | `host-pr` open / read | `repo` | Pull requests: Read and write |
| `PUT /repos/{o}/{r}/pulls/{n}/merge`, the auto-merge arm mutation | `host-pr` merge / arm | `repo` | Pull requests: Read and write, **and** Contents: Read and write (writing the merge commit to the protected branch) |
| `DELETE /repos/{o}/{r}/git/refs/heads/{branch}` | branch cleanup after landing | `repo` | Contents: Read and write |
| `GET /repos/{o}/{r}` | `allow-auto-merge` posture read, default-branch resolve, `canMergePullRequests` | `repo` (or `public_repo` on a public repo) | Metadata: Read (the mandatory baseline every fine-grained token carries) |
| `GET /repos/{o}/{r}/rules/branches/{branch}` | required-checks posture read | `repo` | No single documented fine-grained permission name for this endpoint at the time of writing — treat "the token can read the repo's effective rules" as the bar, not a specific checkbox. This is why the engine never blocks on it: `getRulesetRequiredChecks` is throw-free by contract and degrades to `unknown` (never `fail`) on any read failure, including a token that can't see it. |

**`repo` (classic) covers every row above in one scope.** A fine-grained PAT does not bundle the same way — GitHub splits `repo` into separate repository permissions, so a fine-grained setup needs **`Issues`, `Pull requests`, and `Contents`, each Read and write**, named individually. Granting only the one the arm mutation needs (`Pull requests`) is the exact way a fine-grained token passes `store-preflight` (which never labels an issue) and then fails the first `addLabel`/`removeLabel` call mid-wave.

**One more gate that is not an engine API call at all: `workflow` scope (classic) / `Workflows: Read and write` (fine-grained) — only if a wave will touch `.github/workflows/**`.** This is not a GitHub REST/GraphQL permission the engine's HTTP calls exercise; it is enforced by GitHub directly on the `git push` itself, refusing a pushed commit that adds or modifies a workflow file unless the token carries it — independent of every scope above being correct. Nothing in `store-preflight`/`host-pr preflight` probes this (it is a push-time git-protocol check, not an API read), so a wave that plans to touch workflow files needs this checked by hand, against the wave's own declared Files globs, before dispatch — this is exactly the gap that STOPped a wave at the push step once already (issue-tracked as W23).

## Bitbucket token permissions

Same discipline as the GitHub table above, and the same reason it matters: neither preflight substitutes for checking scope up front. `store-preflight` never touches the code host at all, and `host-pr preflight` grades only what its four checks can see — a token can clear both and still fail the one call neither preflight probes, `host-pr create`, which is gated on `BITBUCKET_EMAIL` rather than on a scope. Two independent things to get right before the first wave: the **scope** on the token, and — per [SKILL.md's Bitbucket token section](../SKILL.md#bitbucket-token--the-two-flavors-and-which-one-host-pr-create-needs) — **which flavor** of token is being scoped (an Atlassian account API token and a workspace/repository access token are not interchangeable, and the table below applies to the account-API-token flavor, the one that can open a PR at all).

**The documented minimal set** — sufficient for every landing verb (`status`/`preflight`/`arm`/`merge`) and, paired with `BITBUCKET_EMAIL`, for `create` too:

| Scope | Grants |
|---|---|
| `read:repository:bitbucket` | reading the repo, its pull requests, and its branch-restriction/build-status posture — every read the engine's Bitbucket adapter issues |
| `write:repository:bitbucket` | opening/updating/merging a pull request, deleting the landed branch |

**`read:pipeline:bitbucket` — recommended, live-verified 2026-08-13.** Without it, `host-pr preflight`'s `allow-auto-merge` and `required-checks` checks both report `unknown` — never `fail` (a wave still runs), but the credential cannot see the build-status posture either check grades, so `--auto` cannot tell a clean row from a red-build one. Granting `read:pipeline:bitbucket` on top of the minimal pair, verified against a live Bitbucket consumer: both checks move from `unknown` to `advisory` with real content instead — `allow-auto-merge` reads whether "Allow automatic merge when builds pass" is enabled on the default branch (read as **not enabled** on that consumer's `main`), `required-checks` reports the configured passing-build count (`require_passing_builds_to_merge`, ≥1 required on that consumer). The practical consequence: the engine's refuse logic for a row whose required builds have not all reported success — REFUSED at `wave-close --auto` — only becomes reachable once this scope is granted; without it, that refuse logic never sees the data it needs to fire at all.

**`admin:repository:bitbucket` — a broader-sounding option that does not subsume the pair above.** Atlassian's own documentation is explicit: this scope grants repository *admin* features only — permissions, branch restrictions, deploy keys, default reviewers, links, deletion — and does **not** implicitly grant `read:repository:bitbucket` or `write:repository:bitbucket`. A token that already carries `admin:repository:bitbucket` for other reasons still needs the repository pair above granted **separately** before it can serve a single call the engine's Bitbucket adapter issues — there is nothing to inherit from the admin scope for that purpose. This is not a recommendation to grant it *for* flotilla specifically; it is a correction of what a token carrying it for other reasons does and does not already cover.

**Not yet re-tested: the documented pair alone, with no pull-request-specific scopes layered on top.** The minimal set above was verified sufficient for `create`/`arm`/`merge` on a live consumer that had additionally granted pull-request-specific scopes on its own judgment, alongside the repository pair — the repository pair *alone*, with nothing else added, has not been independently re-tested. Treat the table above as the documented floor, not yet a confirmed-minimal one; a maintainer re-check with exactly `read:repository:bitbucket` + `write:repository:bitbucket` and nothing else is the open item.

## `WaveConfig` fields

| Field | Required | Shape |
|---|---|---|
| `store` | yes | `MarkdownStoreConfig`, `GitHubStoreConfig`, or `LinearStoreConfig` (see below) |
| `verify` | no | `VerifyConfig` — omit entirely if the consumer has no build gate |
| `cleanup` | no | `CleanupConfig` — omit entirely unless this consumer's toolchain leaves build output inside a worktree |
| `engine` | no | `EngineConfig` — `{ cli?: string }` (ADR-0032); see below |

### `EngineConfig`

| Field | Required | Shape |
|---|---|---|
| `cli` | no | a plain space-separated argv command string — repo-relative, no shell metacharacters, no `~`-rooted path |

Absent `engine` (or an absent `cli` inside it) is valid and means unbound — the engine itself has no opinion about what a consumer should do without a binding, that STOP belongs to the consuming skill that hits it. A **present** `cli` is validated by `normalizeEngineCli` (re-exported from the package root as `normalizeEngineCli` / `EngineCliBindingError` / `EngineCliBindingFailure`, alongside the `EngineConfig`/`WaveConfig` types) and must survive an ALLOW-list of characters — ASCII letters/digits, the separating space, and `_ . / : @ = + , -` — refusing every shell metacharacter, quote, glob, control character, and non-ASCII codepoint, and refusing a `~`-rooted path (machine-specific, unusable in a tracked allowlist). A malformed value throws `EngineCliBindingError` (`code: "engine-cli-binding-invalid"`, `field: "engine.cli"`) naming the offending character and its index — `config validate` surfaces this at exit 1, not a silent read-as-unbound.

**The two values `wave-setup` ever writes here:**

```json
{ "engine": { "cli": "./node_modules/.bin/flotilla-engine" } }
```

the consumer default — every Node consumer, pinned by its own lockfile; and, only in this repo's own dogfood config:

```json
{ "engine": { "cli": "./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts" } }
```

Once written, `config validate` echoes the bound value verbatim on its `ok:` line (`engine.cli: <value>`) — see [Validation round-trip](#validation-round-trip) below.

#### The non-Node manifest

For a consumer with no existing Node install step, scaffold a minimal tracked `package.json` naming the engine as its only dependency:

```json
{
  "name": "<consumer-repo-name>-flotilla-engine",
  "private": true,
  "devDependencies": {
    "@formtrieb/flotilla-engine": "<pinned version — match the plugin's own release>"
  }
}
```

then run the install once, from the consumer repo root, to produce the lockfile and the binary:

```bash
npm install
```

This is not a second scaffold form — it produces the identical `./node_modules/.bin/flotilla-engine` binary and the identical `{ "engine": { "cli": "./node_modules/.bin/flotilla-engine" } }` config value as the ordinary Node-consumer path above. The only difference is that this `npm install` is a **new, prepended** row step rather than one more line inside an install the consumer already runs — record it as the first thing the row's `depsSetup` does (`workflow-driver.md`'s per-row dependency-install input), ahead of whatever the consumer's own build already installs, so `engine.cli` resolves before the row's first engine call. The engine needs a Node runtime regardless of what this consumer builds — this manifest makes that already-true prerequisite explicit and worktree-resolvable, not a new one.

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
| `project` | no | Linear project display name — scopes `listOpen` and the PRD Document panel to that project; omit for a whole-team draw. Omitting `project` does **not** disable PRD publishing: the Document facet falls back team-scoped — `publishDocument` parents the Document on the configured `team`, and `listDocuments` narrows server-side to that team (ADR-0017 as amended). Know the structural consequence: Linear documents `Document.team` as null for any non-team parent, so the team-filtered listing can never return a *project-attached* Document — deliberately accepted by the team-central convention. |
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

#### Measure before recording — resolution proven by execution, not inspection

A profile's `commands` describes the consumer's build gate; it is not, automatically, the exact spelling that resolves once a Worker or Reviewer is standing inside a fresh worktree checkout rather than the consumer's own already-populated working copy. Composing the JSON straight from that description and treating the string as final is exactly the trap a live wave hit at compose time (Wave `2026-07-30-arm-and-wiring`, coordinator disclosure 254.3): the bare `npx vitest run` / `npx tsc --noEmit` form looked like the obvious spelling of "run the tests, run the type-gate" and resolved to **nothing** — no local binary at the repo root, so `npx` reached for the npm registry instead of failing loud — on a consumer whose dependency directory is **nested**, not at the repo root.

**Measure it: run the command for real, and observe it resolve the local binary.** Never treat a `commands` entry as final on the strength of reading the config — that is inspection, not proof, and this is the same standard `config validate`/both preflights already hold every other precondition to.

**Resolution has two halves, and both must be measured — the binary AND the discovery root.** Naming the pinned local binary (`./tools/wave/node_modules/.bin/vitest`) closes only the first half: which vitest *executable* runs. It says nothing about which *files* that executable then goes looking for — and a correctly-pinned binary can still discover the wrong set, silently, with no non-zero exit forcing the miss into view. Evidence, measured live in this dispatch (issue #372): the pinned local binary, invoked from the repo root with **no discovery root**, resolves vitest 4.1.8 and runs — but sweeps in `scripts/check-client-refs.test.mjs`, a repo-root `node:test` file the vitest runner cannot parse as a suite, and reports **63 test files (1 failed, 62 passed)** while all **2789** vitest-owned tests still pass — a failed-suite verdict for a reason that has nothing to do with the code under test. Pinning the discovery root (`--root tools/wave`) removes the stray file from the walk entirely: **62 test files, 2789 passing tests**, matching baseline exactly. Naming the binary without naming `--root`/`-p tools/wave` reproduces this exact miss — measuring only the first half looks like a clean pass right up until a stray root-level file lands, then fails with a count that reads as a code regression rather than a discovery-root gap.

**flotilla's own repo, worked (the nested-dependency-directory case) — confirmed live in this dispatch.** The engine lives at `tools/wave/`, not the repo root, so its dependency directory (`tools/wave/node_modules`) is nested. Convention 13 rules out papering over this with a fused `cd tools/wave && npx vitest run` (the same two mechanisms — the permission gate, the worktree-isolation guard — that refuse a fused Worker step refuse a fused verify command too, wave-shared Convention 13). The measured, resolving forms carry BOTH the directory and the discovery root IN the command:

```json
{
  "verify": {
    "profiles": [
      {
        "name": "engine",
        "appliesTo": ["tools/wave/**"],
        "commands": [
          { "command": "npm ci --prefix tools/wave" },
          { "command": "./tools/wave/node_modules/.bin/vitest run --root tools/wave" },
          { "command": "./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit" }
        ]
      }
    ]
  }
}
```

confirmed by execution in this dispatch (2026-07-31, issue #372): with the discovery root pinned, the vitest form resolved **vitest 4.1.8** and ran **62 test files, 2789 passing tests**; the tsc form resolved and exited **0**. (The stale prior recording here — 2675 tests — predates the repo-root file whose presence is exactly the two-halves gap this section now documents; it is superseded by this measurement, not merely refreshed.) The plausible-looking bare-form profile below is what a Coordinator re-deriving the spelling by hand, per wave, tends to compose instead — and it is exactly the one that resolves to nothing on this repo's own shape:

```json
{
  "verify": {
    "profiles": [
      {
        "name": "engine",
        "appliesTo": ["tools/wave/**"],
        "commands": [
          { "command": "npm ci --prefix tools/wave" },
          { "command": "npx vitest run" },
          { "command": "npx tsc --noEmit" }
        ]
      }
    ]
  }
}
```

Three further spellings of this same pair are measured, with real call counts, in ["2026-07-31 pass"](#2026-07-31-pass--the-used-but-absent-direction-issue-291) below — that pass audited them from the allowlist-reconciliation angle (which spellings are *used* vs. *allowlisted*); this section is the same measured fact read from the setup angle (which spelling actually *resolves*, and is it recorded before a wave ever needs it).

**The recurrence arc — why the profile itself has to name the pinned form, not a prose warning beside it (issue #372).** The identical underlying gap — an unpinned or under-specified verify spelling standing in for the pinned one — recurred in three distinct shapes, on three separate occasions, and a warning survived none of them:

1. **The compose trap**, above: a bare `npx vitest run` / `npx tsc --noEmit` form, composed straight from the profile description and never measured, resolved to **nothing** on this repo's nested dependency directory (Wave `2026-07-30-arm-and-wiring`, coordinator disclosure 254.3).
2. **An unpinned download, even where the bare form DOES resolve.** The original filing of this issue observed the verify profile's literal `npx vitest run --root tools/wave` — note it already named the discovery root — still reach past the pinned local binary and download **vitest 4.1.10** from the network, against **4.1.8** installed under `tools/wave/node_modules`; independently reproduced by the row's own Reviewer, who re-ran both. Both versions agreed on counts that day (2760/2760 across 62 files), so no verdict was affected then — but the root half being correct did nothing to pin the binary half: the two halves fail independently, not sequentially, which is the same fact the two-halves paragraph above states from the discovery-root side.
3. **A Reviewer re-spelled the bare form anyway, despite a verbatim warning in hand.** On 2026-07-31, a wave Reviewer issued a bare `npx vitest run` mid-review — again fetching the unpinned 4.1.10 — before re-running the identical spec through the pinned `npm test` form (4.1.8, lockfile); both agreed on counts, so no verdict was affected this time either. What makes this occurrence the decisive one: the Reviewer's own brief *carried the warning against exactly this form*, and the bare form was reached for anyway.

Three occurrences, one root cause, and the third happened to someone who had just read the warning. A prose warning demonstrably does not close this — the fix has to remove the bare spelling from reach entirely, which is exactly what naming the pinned, discovery-rooted form directly inside `commands` does: there is no shorter, more-obvious-looking alternative left to compose or reach for, because the command that actually runs already **is** the correct one.

**The recorded forms are the compose-time source for the driver's verify constants.** Once measured, record the exact resolved command strings alongside the config — SKILL.md's "Worktree-brief inputs" precondition, item 3 — the same way `depsSetup` and `engine.cli` are recorded from their own items. `workflow-driver.md`'s per-row brief quotes this recorded shape when it renders the row's Verification-gates step, rather than a Coordinator re-deriving a plausible form from `wave.config.json`'s own profile description at every wave's compose time. **That re-derivation loop is retired** (issue #272): the form is proven once, here, at setup — not re-guessed, per wave, at dispatch.

### `CleanupConfig`

| Field | Required | Shape |
|---|---|---|
| `disposableNames` | no | `string[]` of **exact entry names** — extra directory/file names this consumer's toolchain leaves inside an agent worktree and considers disposable |
| `extraRoots` | no | `string[]` of additional **containment roots** (absolute or repo-root-relative paths) the `worktree-cleanup --detached` sweep considers when looking for detached scratch checkouts — unioned with the marker-derived worktrees root, never a replacement |

The two keys answer different questions: `disposableNames` names **entries** (what the build leaves *inside* a worktree); `extraRoots` names **places** (where this consumer's agents are known to make scratch checkouts *outside* the marker-derived worktrees root — only the `--detached` sweep reads it). The full teaching for `extraRoots` — why it exists, and what its absence looks like at close time (a registered checkout the sweep silently never considers) — is [wave-close's phase-3 reference](../../wave-close/reference/phase-3-worktree-cleanup.md); declare it at authoring time if such a checkout location is already known.

**Ask this question during setup whenever the consumer's build writes into the working tree.** It is the same question as `verify`, one step later in the wave: `verify` asks what the build *runs*; `disposableNames` asks what the build *leaves behind*.

Why it exists. When a wave finishes, worktree cleanup has to decide whether a leftover worktree directory holds work or debris. For a **still-registered** worktree that decision comes from `git status`, which honours `.gitignore` — gitignored build output never shows up, the worktree reads clean, and it is torn down with its build directory inside it. Nothing to configure there. But once the agent harness has already **deregistered** the worktree (the common case: the harness removes its own worktree as soon as its agent exits), all that is left is a physical directory, and the only way to classify it is to scan it. A scan knows nothing about `.gitignore` — it sees `.build/` and can only conclude "real files", so cleanup refuses the directory with `reason: orphan-with-real-files` and an operator has to `rm -rf` it by hand.

The engine's built-in disposable set knows `.DS_Store`, `.vscode/`, `.claude/` — the junk *flotilla's own* harness and editors produce. Only the consumer knows what *their* toolchain's output is called. Declared names are **unioned** with the built-in set, never a replacement.

| Toolchain | Typical value |
|---|---|
| Swift / SwiftPM | `".build"` |
| Rust / Maven | `"target"` |
| Node | `"node_modules"` |
| Python | `"__pycache__"`, `".pytest_cache"` |
| Go | `"vendor"` |

**Exact names only — a glob is rejected, not honoured.** `config validate` fails on any of: a pattern (`*`, `?`, `[`, `]`, `{`, `}`, `!` — so `".*"` and `"*.o"` are both refused), a path (`"build/debug"`), `"."`, `".."`, or `".git"`. That refusal is the point: a wildcard broad enough to catch `".build"` is also broad enough to catch `".git"`, and destroying a worktree's `.git` is exactly the failure the fixed built-in list exists to prevent. A name is matched **at any depth** and as either a directory (whole subtree) or a file, so `".build"` covers a nested `Packages/Foo/.build/` too — which is why a name is all it needs, and a path is refused.

```json
{
  "store": { "kind": "github" },
  "cleanup": {
    "disposableNames": [".build"]
  }
}
```

> **Do not declare speculatively.** Declaring a name is a claim that *anything* by that name inside a spent agent worktree is disposable. Declare what the consumer's build actually emits, and nothing else — an undeclared real file anywhere in the directory still (correctly) refuses removal, which is the behaviour you want back if a declaration ever turns out to be wrong.

> **Note on reach.** `cleanup.disposableNames` is honoured by the engine's cleanup API (`cleanAgentWorktrees`, `executeCleanup`, `listAgentWorktrees`, `listOrphanDirs`, `sweepOrphanWorktrees` — all take a `disposableNames` option, which is where the config key is threaded), and the path now works end-to-end: the `worktree-cleanup` **CLI verb** loads `--config <path>` via `loadWaveConfig` and threads `cleanup.disposableNames` into `listAgentWorktrees`, `listOrphanDirs`, and `executeCleanup` itself, so a `wave-close` run driven by `--config` picks the declaration up from the config file with no further wiring needed. `cleanup.extraRoots` rides the same `--config` path: the CLI verb threads it into the detached sweep, so a config-declared containment root is honoured by `--detached` with no further wiring either. `config validate` accepts and validates both keys at author time.

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

### `engine.cli` on a `github` store (the ordinary case)

The `engine` key composes with any store kind — shown here on `github`, unaffected by which tracker the consumer uses:

```json
{
  "store": { "kind": "github", "eligibility": ["ready-for-agent"] },
  "engine": { "cli": "./node_modules/.bin/flotilla-engine" }
}
```

This value is not consumer-specific — it is the SAME string for every Node consumer, because `npm install --save-dev @formtrieb/flotilla-engine` always produces this exact binary path. A non-Node consumer's config carries the identical value once its scaffolded manifest has been installed once (see [The non-Node manifest](#the-non-node-manifest) above) — the config never needs to know which path got it there.

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

Exit 0 means the engine will accept it. Any other exit code means there is a problem — the error output names the field; fix it and re-run. When `engine.cli` is set, the `ok:` line echoes the bound value verbatim (`engine.cli: ./node_modules/.bin/flotilla-engine`) — read it to confirm the repo is bound to the form you think it is, not merely that a binding exists; a present-but-malformed binding (a shell metacharacter, an empty string, a `~`-rooted path) is a typed `EngineCliBindingError` at exit 1 naming the offending character, never a silent read-as-unbound.

Then, once `config validate` passes, prove the live **tracker** preconditions (integration, state catalog) with the store-preflight, and the live **code-host** posture (merge token, allow-auto-merge, required-checks) with the host-preflight:

```bash
{{wave-cli}} store-preflight --config wave.config.json [--expect <plugin-version>]   # tracker facts (+ the ADR-0032 lockstep advisory, if supplied)
{{wave-cli}} host-pr preflight                            # code-host posture (store-blind)
```

Exit 0 from each means every check passed / is `not-applicable` / is `advisory`/`unknown`. On exit 1, the failing check's `detail` names the exact gap — fix it in Linear/GitHub or the config and re-run. Only after `config validate` **and both preflights** exit 0 is the config ready for `wave-plan`/`wave-create`.

Pass `--expect <plugin-version>` on this run too, for an installed-form consumer (a plugin clone): it surfaces a version skew as an advisory `engine-version` check right here, at setup time, rather than leaving it to surface only when `wave-start`'s gate phase STOPs a wave over the identical comparison later (see the Store-preflight section above). It stays advisory here by design — it never turns this exit 0 into a 1.

## `.gitignore` scaffold — the Scribe scratch path (issue #355)

Written at [Procedure step 4](../SKILL.md#procedure), alongside `wave.config.json` — the consumer repo root is already in hand for that write, and this is the same moment.

**One line, and it is the only flotilla-owned `.gitignore` entry a consumer needs.** Write it into the consumer repo's `.gitignore` at setup time, beside whatever else that file already carries:

```gitignore
# flotilla — the Scribe's per-stage hand-off payloads (wave-start, ADR-0024).
# Transient by construction: the DURABLE record is the sidecar the engine writes
# under .flotilla/waves/<slug>/reports|verdicts/, and this file is residue the
# moment that write returns. Ignored so an in-flight wave cannot leak payloads
# into a commit; SWEPT at close by `worktree-cleanup --orphans` (reported under
# `orphans.scratch`). Do not ignore `.flotilla/` wholesale — see below.
.flotilla/tmp/
```

**Why this line exists at all, given that flotilla's own repo never needed it.** This repo gitignores `.flotilla/` **wholesale** — it is the toolkit, not a consumer, and a stray in-repo spine must never land here. That blanket ignore silently covers the scratch path too, which is exactly why the gap was invisible for several wave-generations: the one repo that dogfoods the pipeline is the one repo the problem cannot appear in.

A consumer is the opposite case. The recommended posture is to **track** `.flotilla/` — the spine is the durable WAL, and committing it is what makes `wave-resume` work from a fresh clone (see the archive's own durability note in [wave-close phase 6](../../wave-close/reference/phase-6-archive.md)). With `.flotilla/` tracked and no narrower rule, every Scribe payload written during a wave is an untracked file sitting in the consumer's tree, in the same directory the consumer runs `git add .flotilla` over to commit the spine. Two files per row, for the whole in-flight duration of the wave.

**Why the ignore line does not make the close-time sweep redundant, and vice versa.** They cover different windows, and neither covers the other's:

| | covers | does not cover |
|---|---|---|
| **`.gitignore` line** | the whole **in-flight** window — a payload can never enter a commit, from the moment the Scribe writes it | the files themselves: they accumulate on disk forever, unignored-but-unremoved |
| **close-time sweep** (`worktree-cleanup --orphans`, reported at `orphans.scratch`) | the **accumulation** — payloads are physically removed once the wave closes | the hours between the write and the close, where the consumer is committing spine updates |

Scaffold both. A consumer that has only the sweep will commit a payload sooner or later; a consumer that has only the ignore line grows the directory without bound.

**Never widen it to `.flotilla/`.** Ignoring the whole directory in a consumer repo is not a stronger version of this rule — it is a different, and wrong, decision: it discards the spine's durability (the point of tracking it) to solve a scratch-file problem one line already solves. If a consumer *does* choose the gitignored posture deliberately, this line is simply redundant there, not harmful.

## AFK harness config scaffold: env block + permission allowlist (`.claude/settings.json`)

The SKILL.md "Scaffolding the tracked permission allowlist and env block" precondition owns the **judgment** (what must be in the env block and on the allowlist, and why `docker` stays off it); this is the concrete scaffold. Write it to the consumer repo's **tracked** `.claude/settings.json` — the ONLY permission *and* environment source an AFK Worker/Reviewer worktree inherits (a worktree carries tracked files only, so the gitignored `.claude/settings.local.json` never reaches it). This is a separate file from `wave.config.json` and is not validated by any engine verb; it is a harness config the consumer commits.

**Beyond the engine CLI: the measured AFK worker command block.** The engine-CLI entry covers only *how* a Worker or Reviewer invokes the engine — it says nothing about everything else a dispatched agent actually runs. The first multi-wave overnight run measured that surface for real: the workspace mechanic (`git fetch`/`reset`/`checkout`/`add`/`commit`), the wave-branch push, the Reviewer's probe-worktree creation (its "probe license" — see `wave-reviewer`'s SKILL.md), the sibling merge-tree prediction, and the verify-gate commands (`npm ci`, `npx vitest run`, `npx tsc --noEmit`) — and found **none of it** on the tracked allowlist scaffolded at the time. Consequence: 2–4 human approvals landed mid-dispatch over one night, one of which suspended a wave for roughly seven hours until the operator woke and clicked approve (docs/retros/2026-07-29-overnight-triple-wave.md, finding NF-F1). The scaffold below carries that full measured command block, not only the engine-CLI invocation form. **The allowlist is part of the dispatch contract, the same as the brief**: the AFK guarantee is a property of the permission layer, not only of the protocol — a perfectly-written brief still stalls on an un-allowlisted command with nobody there to answer the prompt.

> **The env block, first — the structural fix.** A consumer pattern proven live (the second consumer's tracked settings, observed 2026-07-22): set `NODE_USE_ENV_PROXY=1` in the tracked `env` block and every engine-CLI invocation in the repo inherits it — no per-call prefix, no way to forget it. The raw-fetch adapters need this under a proxied sandbox (wave-shared Convention 1); baking the flag only into allowlist entries instead is fragile in two directions from a single miss — an un-prefixed call silently drops the proxy (a false-`unreachable`/mis-authenticated failure) *and* fails the allowlist's literal prefix match at the same time, hitting the permission gate mid-wave.
>
> **Exactly one engine-CLI entry, doubled only for the proxy prefix (ADR-0032).** With the env block in place the per-call `NODE_USE_ENV_PROXY=1` prefix is *redundant* for every in-repo invocation, so the allowlist names the **prefix-free** form of whatever `engine.cli` is bound to as the primary path. The **env-prefixed** twin stays on the allowlist too — it remains valid for existing briefs written before the env block existed and for cross-repo habits that still type the prefix — so neither spelling hits the gate. There is nothing else to name: ADR-0032 abolished the invocation fallback chain, so a consumer's allowlist carries exactly the ONE form `engine.cli` resolved to at [Procedure step 3](../SKILL.md#procedure) — not `npx @formtrieb/flotilla-engine` (that is a pre-setup bootstrap only, never an ongoing allowlist entry), and not a vendored `tools/wave/…` form (that is flotilla's own documented exception below, never a fresh consumer's scaffold).

```json
{
  "env": {
    "NODE_USE_ENV_PROXY": "1"
  },
  "permissions": {
    "allow": [
      "Bash(./node_modules/.bin/flotilla-engine:*)",
      "Bash(NODE_USE_ENV_PROXY=1 ./node_modules/.bin/flotilla-engine:*)",
      "Bash(git fetch origin:*)",
      "Bash(git reset --hard:*)",
      "Bash(git checkout:*)",
      "Bash(git add:*)",
      "Bash(git commit -m:*)",
      "Bash(git push origin wave/:*)",
      "Bash(git worktree add:*)",
      "Bash(git merge-tree:*)",
      "Bash(npm ci)",
      "Bash(npx vitest run:*)",
      "Bash(npx tsc --noEmit)",
      "Bash(jq -e -r '.url':*)",
      "Bash(mkdir -p:*)"
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

> This scaffold is the AFK command-surface baseline every consumer gets. A consumer also adopting the credential lookup-command indirection (ADR-0029, the wave-setup default) merges a `<VAR>_CMD` entry into this same `env` block and its matching lookup-command prefix into this same `deny` array — see [Credential lookup-command scaffold](#credential-lookup-command-scaffold-adr-0029) below for the exact entries; nothing here needs to change to accommodate them, they just merge in.

- **`env` block** — sets `NODE_USE_ENV_PROXY: "1"` for every command the harness runs in this repo (Bash and the engine CLI alike). This is the recommended mode for every consumer under a proxied sandbox; it makes the per-call prefix on the allowlist entries below redundant, not required — see the rationale above.
- **The engine-CLI entry — the first two allow lines, and nothing else.** `./node_modules/.bin/flotilla-engine`, named **prefix-free** (the form every in-repo call now resolves to, thanks to the env block) **and** env-prefixed (kept for backwards compatibility with existing briefs and cross-repo habits). This is the whole entry: whatever step 3 of the Procedure bound `engine.cli` to, scaffold exactly that string, doubled only for the proxy prefix — never a second invocation path alongside it. If this consumer's `engine.cli` names a different repo-relative path (a monorepo subpackage, say), scaffold that exact string instead — the invariant is *this one value, twice*, not this literal path.

**flotilla's own repo is the one documented exception — not a second scaffold form.** This repo binds `engine.cli` to the vendored value, and its OWN tracked allowlist reflects that single substitution, not an addition: `./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts` (+ its env-prefixed twin) in place of the two lines above. That is the whole exception — one substituted pair, the same *this one value, twice* invariant the bullet above states, differing from a fresh consumer's scaffold only in which string `engine.cli` resolved to. Nothing about it is a second consumer-facing entry to reproduce.
- **The exception is exactly one pair, and no longer four entries (issue #269, reconciled).** `cli.ts`'s own router keeps three pre-unification entrypoints alive as documented ALIASES to the identical runner (its own in-source NOTE: they "survive as documented ALIASES only because live skill call-sites still spell them that way") — `resume-cli.ts`, `cli-store.ts` (its `preflight` op — see the store-preflight section above), and `spine-cli.ts`. This repo's allowlist used to carry two extra vendored-path pairs for the first and third, because two of its own skill docs still spelled them as SEPARATE entrypoints. Both call-sites have since been respelled to the unified `{{wave-cli}} <sub>` form — `wave-resume`'s SKILL.md invokes the reconciler as `{{wave-cli}} resume`, and `wave-close`'s close-mechanics.md documents spine ops as `{{wave-cli}} spine <op>` only — and those four entries were removed from the live tracked settings in the same change. No skill doc now spells any retained alias, so none of them needs an allowlist entry: `cli-store.ts`'s alias form never had one here either, which is now the uniform state rather than a gap. Deleting the aliases from the router itself is a separate engine question — they carry their own in-source contract and a third alias with its own consumers — not an allowlist one.
- **The workspace mechanic** — `git fetch origin` / `git reset --hard` / `git checkout` / `git add` / `git commit -m`: the anchor-and-branch, stage-and-commit surface every Worker's setup and termination steps run (a plain `git checkout -b <branch>` is covered by the `git checkout` entry — no separate `git branch` entry is needed). These are the exact forms measured from real dispatch (docs/retros/2026-07-29-overnight-triple-wave.md, NF-F1), not a broader `git:*`.
- **The wave-branch push — scoped, deliberately.** `Bash(git push origin wave/:*)` matches only a push whose refspec starts with `wave/` — the wave branch-naming convention every row uses. A Worker (or Reviewer) can therefore never structurally push to `main`/`master` even by mistake or a bad brief: the prefix match itself makes the protected default branch unreachable from this entry, with no reliance on the agent remembering not to. Do **not** widen this to `git push:*` — that reopens exactly the default-branch write the scoping exists to close.
- **Probe-worktree creation.** `Bash(git worktree add:*)` — the Reviewer's "probe license" (`wave-reviewer`'s SKILL.md: the Reviewer stays code-read-only but MAY create a scratch worktree to independently exercise an outcome the diff alone can't prove). Narrower than a blanket `git worktree:*`: only the creation subcommand is allowlisted, not `remove`/`prune`/`list`. That absence is **deliberate, not an omission (decided in the doctrine-budget grill, 2026-08-09)**: an allowlist pattern cannot scope `git worktree remove` to the worktree the agent itself created — any grant would reach every sibling's live worktree, trading the fan-out's parallel-safety for agent discipline — and a leftover probe checkout is exactly what the host-side lifecycle already reaps (the detached-scratchpad sweep, `worktree-cleanup --detached`, wave-close phase 3 / the dispatch preflight). Do not add a `remove`/`prune` entry when a dispatched agent asks for one; the refusal is the design.
- **Sibling merge-tree prediction.** `Bash(git merge-tree:*)` — every Reviewer dispatch with a non-empty sibling list runs `git merge-tree "$BRANCH" "origin/$SIB"` per sibling to surface an advisory predicted-conflict focus item (`wave-reviewer/reference/reviewer-checks.md`, Check 5); the sibling's own `git fetch origin "$SIB"` reuses the `git fetch origin` entry above.
- **Verify-gate commands — consumer-tunable, replace these lines for a different toolchain.** `Bash(npm ci)`, `Bash(npx vitest run:*)`, and `Bash(npx tsc --noEmit)` are **flotilla's own** verify profile (the dogfood example this repo runs) — exact forms, not a wildcard `npm:*`/`npx:*` that would allow any subcommand. A consumer whose `verify.profiles[].commands` differ (`composer install` + `vendor/bin/phpunit`, a Rust `cargo test`, …) replaces these three lines with the exact command forms their own `wave.config.json` verify profile declares — do not inherit flotilla's toolchain-specific commands into a consumer with a different one. The first entry (`npm ci`, no arguments) doubles as the **deps installer** — it is the **first** Worker step and, for a Node consumer, also installs the pinned `engine.cli` binary, so it must be allowlisted even for a consumer whose verify profile has nothing else in common with flotilla's own; a consumer with a different install command (`composer install`, `npm ci --prefix tools/wave`, …) allowlists that exact form instead.
- **The on-disk PR-URL-confirmation fallback (issue #345).** `Bash(jq -e -r '.url':*)` — `wave-start`'s driver (`workflow-driver.md`, Termination step 4) re-queries `host-pr status` to confirm a PR exists rather than trusting a captured value (wave-shared Convention 12); its documented on-disk variant, for when the URL is needed as a file rather than read straight from the tool output, redirects that re-query to a relative-path file and then reads it back with a single command whose exit status is the verdict — `jq -e -r '.url' <file>`, which exits non-zero when `.url` is absent or null. Wildcarded on the trailing filename (the recipe's own doc names `pr-status.json`; the same idiom recurs under other names — `pr-create.json`, `probe-capture.json` — in wave-shared's Convention 12/13 references) and pinned on the filter itself (`-e -r '.url'` only — never a bare `jq:*`, which would allow an arbitrary filter against an arbitrary file). This entry did not exist before issue #345: the fallback recipe had prescribed `jq` to a worktree-isolated Worker with no matching allow entry since the recipe was first written, and nothing had confirmed why an observed dispatch using it ran clean regardless (see the "Open" note in the "2026-07-31 pass" section below for what that dispatch could and could not establish) — this entry closes the gap in the "add the entry" direction, leaving the recipe text itself unchanged.
- **Sidecar/archive directory creation — Coordinator-side, not part of the dispatched-agent surface above.** `Bash(mkdir -p:*)` traces to two literal shell calls the **Coordinator** itself runs against this same tracked file, never a Worker/Reviewer worktree: `wave-create`'s materialization step (`mkdir -p .flotilla/waves/<slug>/reports .flotilla/waves/<slug>/verdicts` — `.claude/skills/wave-create/SKILL.md`, mirrored in `.claude/skills/wave-create/reference/create-mechanics.md`), needed because `spine create` does not mkdir its own parent (ENOENT otherwise); and `wave-close`'s archive phase (`mkdir -p ".flotilla/waves/_archive"`, unconditional — `.claude/skills/wave-close/reference/phase-6-archive.md`) before the spine moves in. The archive form is not hypothetical: a *missing* `mkdir -p` in that exact snippet was a live-reproduced Reviewer finding in Wave 6, predating this scaffold (`docs/retros/2026-07-19-hardening-w6.md`, FOR-21). Both calls rode along in the same NF-F1 commit as the dispatched-agent entries above even though neither runs inside a Worker/Reviewer worktree — untraced here until now. This is a different case from the engine's own internal `mkdir -p` inside `write-report`/`write-verdict` (ADR-0024, wave-shared Convention 5): that one runs inside an already-allowlisted CLI invocation — the engine process's own filesystem call, not a Bash-tool shell command — the same way `credential-resolver.ts`'s `child_process` spawn needs no allowlist entry of its own; it is not what this entry covers.
- **`deny` block — the secret-echo structural anchor (wave-shared Convention 8, FOR-81).** Convention 8 binds every role that produces tool output, the Coordinator included, and its own live-occurrences catalogue keeps growing past whatever prose the previous occurrence had hardened — a Worker's flawed `${VAR:-no}` echo, a Worker's `printenv` whole-environment dump, a Reviewer's `cat` of the gitignored `.claude/settings.local.json` while hunting a config precedent, and more since (see wave-shared's Convention 8 reference for the current, still-growing count). A brief clause depends on an agent having read and internalized it — and reaches only the roles that read one; a `permissions.deny` entry does not. These entries block the `Read` tool, and — as far as the permission syntax can express it — Bash's read-shaped command forms (`cat`/`less`/`more`/`head`/`tail`), against the two file classes every consumer's harness can hold live credentials in: the gitignored local settings file and any `.env`-class file. Scaffold this **identically** to flotilla's own tracked `.claude/settings.json` — the vector is universal, not consumer-specific, so there is no per-consumer judgment to exercise here (unlike the allow-list, which does vary by the consumer's own engine-invocation path). The brief clause (wave-start's `workerBrief()` policy clause 5) stays in place as defense-in-depth on top of this anchor for the roles it reaches, not a replacement for it.

### Echo-Guard hook scaffold — `hooks.PreToolUse` block + script copy (Convention 8 stage 2 — gate MET)

Convention 8's stage-2 gate (wave-shared's Convention 8 reference, "The structural speed bump — the PreToolUse Echo-Guard") is **met**: wave `2026-07-29-conventions-wiring` ran 12 agents (3 Workers, 3 Reviewers, 6 Scribes) across 374 tool calls with **zero Echo-Guard rejections and zero false positives** — including two rows editing documentation that quotes the unsafe forms as prose, the one false-positive class the convention names and budgets for. The scaffold below therefore ships **unconditionally, for every consumer**, on the same footing as the `permissions.deny` anchors above — there is no per-consumer judgment to exercise here either.

**Two artifacts, both required — a hooks block pointing at a script the consumer does not have is worse than no block at all:**

1. **The script copy, into a TRACKED path.** `node_modules` is gitignored, so a dispatched Worker/Reviewer worktree (tracked files only, same rule as everywhere else in this scaffold) never sees a script left there. Copy the guard out of the pinned engine package into a tracked location and commit it:

   ```bash
   mkdir -p .claude/hooks
   cp node_modules/@formtrieb/flotilla-engine/hooks/echo-guard.cjs .claude/hooks/echo-guard.cjs
   git add .claude/hooks/echo-guard.cjs
   ```

   `node_modules/@formtrieb/flotilla-engine/hooks/echo-guard.cjs` is the sibling `hooks/` directory the pinned package ships alongside the binary `engine.cli` already resolves to — the same installed package, a different subdirectory of it.

2. **The `hooks.PreToolUse` block**, merged into the consumer's tracked `.claude/settings.json` as a sibling of `env` and `permissions` — the same file the scaffold above already writes:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Bash",
           "hooks": [
             {
               "type": "command",
               "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/echo-guard.cjs\""
             }
           ]
         }
       ]
     }
   }
   ```

**flotilla's own repo is the one documented exception, not a second scaffold form** — the same shape as every other exception this file records for its own dogfood config. Its `engine.cli` binds to the vendored `tools/wave/` tree, already tracked, so step 1's copy is a no-op here; the `command` above names `tools/wave/hooks/echo-guard.cjs` directly instead of the per-consumer destination from step 1, exactly matching what this repo's own tracked `.claude/settings.json` already carries.

**Read this as landed, not as the vector being closed.** The gate being met means the hooks block and the script copy roll out everywhere; it says nothing about what the guard itself is. It remains, unchanged, what `tools/wave/hooks/echo-guard.cjs`'s own header and wave-shared's Convention 8 document: a **text matcher over the command string** — a speed bump, not an anchor. A deliberate bypass walks straight past it (`V=GITHUB_TOKEN; echo "${!V}"` is a pinned *passing* spec case, not a gap left to close). Two vectors are deliberately **not** the guard's own and do not become "handled" by this rollout: reading a gitignored settings/secrets file, and the *direct* invocation of a configured `<VAR>_CMD` lookup command — both stay owned by the `permissions.deny` entries this same scaffold already writes (the `deny` block bullet above, and [Credential lookup-command scaffold](#credential-lookup-command-scaffold-adr-0029) below). Scaffolding the guard everywhere widens *where* the speed bump sits; it does not change *what* it is.

**Landing-order note (issue #215).** Step 1 assumes the published `@formtrieb/flotilla-engine` package's installed tarball ships its `hooks/` directory — true of the package's own `files` manifest (`tools/wave/package.json`) at the time of writing, but a fact about the *published* artifact's currency on a given consumer, not about this doc. On a consumer whose installed package predates that fix, the `cp` source is simply absent and the copy fails loudly (a missing-file error), never silently — re-run `npm install` against a current version first.

**Present-but-stale is the second failure mode, and it is silent — pin the version floor.** A package can ship `hooks/echo-guard.cjs` and still carry an old copy: the `cp` succeeds, nothing errors, and the consumer runs a weaker guard than the one this doc describes (live occurrence: `0.1.0-beta.1` shipped a guard predating the family-3 quote-nesting carve-outs). The guard copy therefore has a **version floor: require `@formtrieb/flotilla-engine@>=1.0.0`** before scaffolding; on an older install, upgrade first — the loud missing-file case above is the only failure the `cp` itself will ever report. The destination shown in step 1's commands — the guard copy inside the consumer's own hooks directory — is the **fixed convention** for the copy (confirmed 2026-07-31); other docs cite the step, and the path itself rides in its fenced commands.

**Why the floor moved off the beta line (issue #391).** It read `>=0.1.0-beta.2` until the 1.0.0 contract freeze made that value stale in two ways at once: a prerelease of a superseded pre-1.0 line is not an install target this scaffold should still be blessing, and — because a prerelease comparator is the loosest thing a floor can say — it told a consumer that the *older* of two supported answers was acceptable. `1.0.0` carries every carve-out `0.1.0-beta.2` did, so raising the floor loses nothing and drops the beta line from the supported set. **Keep this value moving with the release era, not with every guard change:** the floor exists to keep a consumer off a guard that *catches less* than this doc describes, so a refusal-message or docstring change does not raise it. The pointer-free refusal that landed with this issue is exactly that case — a legibility fix, not a detection-strength one — so the floor stayed at the era's own number when `1.0.1` shipped that fix. **That is now measured rather than argued** (2026-08-01, issue #397, against both published artifacts): `1.0.0` and `1.0.1` refuse the same command identically — exit 2, same family-3 match — so a consumer pinned at the floor runs a guard of full strength with worse text, which is precisely the trade this rule exists to allow.

### Trackability verification (issue #494)

Both artifacts this scaffold writes — the tracked `.claude/settings.json` above and its tracked Echo-Guard hook copy (the `cp` destination in the Echo-Guard subsection above) — land inside `.claude/`, and a consumer's pre-existing `.gitignore` is exactly as likely to already exclude that whole directory as any other path in the repo. Writing either file then succeeds on disk with no error; `git add .claude` stages nothing and still exits 0; `git status` reports a clean tree. Nothing in that sequence is loud — a `wave-setup` run can report success with the scaffold silently absent from every future worktree, and every dispatched agent then runs with no allowlist, no env block, no echo-guard (the NF-F1 stall class, arrived at silently — see the "Beyond the engine CLI" note above). **Run this verification immediately after [Procedure step 9](../SKILL.md#procedure) writes the scaffold, before reporting success — never take a clean `git status` as proof.**

```bash
git check-ignore .claude/settings.json
git check-ignore .claude/hooks/echo-guard.cjs
```

Each call's exit code is the verdict — this is the one place in the flow that has to read an exit code rather than a JSON report, because there is no engine verb standing between the write and the consumer's own `.gitignore`:

- **Exit 1 (no match) on both** — trackable. Continue to the cross-check below.
- **Exit 0 (a match) on either** — **STOP.** Do not report success. The consumer's `.gitignore` excludes a path this scaffold depends on; fix the `.gitignore`, never the scaffold — see the narrowing recipe below.

#### The narrowing recipe — why a file negation alone cannot undo it

A consumer's pre-existing rule is commonly a wholesale directory ignore, plain and unremarkable — the ordinary output of a starter template, nothing exotic:

```gitignore
# Claude Code
.claude/
CLAUDE.md
```

**Adding `!.claude/settings.json` underneath this does not work — git's own documented traversal behavior, not a bug to route around.** Once a directory itself matches an exclude pattern, git does not descend into it to evaluate further patterns for anything inside it — `.claude/` excludes the directory as one unit, so there is nothing left for a later `!.claude/settings.json` line to re-include; git never looks inside far enough to find it. The fix has to stop excluding the directory itself and exclude its *contents* instead, one level down, so an individually-scoped negation still has something to act on:

```gitignore
.claude/*
!.claude/settings.json
!.claude/hooks/
```

`.claude/*` excludes every direct child of `.claude/` — files and subdirectories alike — without excluding `.claude/` itself, so git still descends into it. `!.claude/settings.json` then re-includes that one file; `!.claude/hooks/` re-includes the `hooks/` directory as a unit, and because nothing excludes *its* contents, `echo-guard.cjs` comes back in with it. `.claude/settings.local.json` and any other file directly under `.claude/` this recipe does not name stay ignored, exactly as intended — neither appears in a negation.

#### The `git add --dry-run` cross-check

Confirm the narrowing actually resolved the way the two `git check-ignore` calls above imply, from the staging side:

```bash
git add --dry-run .claude
```

It must list exactly the two scaffolded paths — `.claude/settings.json` and the Echo-Guard hook copy — and nothing else new under `.claude/` (an already-tracked file re-listing is expected; a *new* file beyond the two scaffolded ones is not, and is its own signal to re-check the `.gitignore` edit). A shorter or empty listing means the narrowing recipe did not take.

### Scaffold-vs-live allowlist reconciliation (issue #269)

> **This reconciliation predates the ADR-0032 scaffold rewrite above** — it diffed the live file against a scaffold that still named six engine-CLI forms (the published package, the local `tsx` binary, and the `resume-cli.ts`/`spine-cli.ts` aliases, each with and without the proxy prefix). The generic scaffold now names exactly one form, and the four `resume-cli.ts`/`spine-cli.ts` rows below have since been **removed from this repo's live tracked file** — dropped in the same change that respelled their last two call-sites to the unified subverb form (see the reconciled bullet above). Read those four rows as history: they record what the live file carried and why it stopped, not entries to look for today. Everything else this table found and dispositioned (the 16-entry stale-pre-router-path removal) is unaffected and already actioned. A fresh reconciliation pass against the new single-form baseline is a follow-up outside this slice's declared scope.

A prior slice traced exactly one live-only entry — `Bash(mkdir -p:*)`, resolved into the "Sidecar/archive directory creation" bullet above — and stopped there, on the Reviewer's own endorsement of that narrow reading. This section closes the rest: every entry this repo's own tracked `.claude/settings.json` carries beyond what the scaffold documented at the time, classified in full, so a future author never has to re-derive which extras are legitimate and which are debris.

**Scope.** This reconciliation covers `permissions.allow` only — the array the scaffold JSON block above reproduces. The `env` block is **at full parity** between the live file and the scaffold above (verified entry-for-entry: the same three `env` keys). `permissions.deny` was at parity too when this pass ran — the same 18 lines, including the ADR-0029 credential-lookup additions — but **is not any more**: see the deny-parity divergence recorded in the 2026-07-31 pass below. `enabledPlugins` (the source-form self-disable, root CLAUDE.md `### Distribution`, ADR-0032) and `hooks` (the echo-guard `PreToolUse` hook, wave-shared Convention 8) are different top-level `.claude/settings.json` keys, already documented at their own home (root CLAUDE.md; wave-shared's Convention 8 reference) — outside "the allowlist" this issue names, so not re-litigated here.

**Method.** Every string in the live file's `permissions.allow` array was diffed against every string the scaffold JSON block above lists (byte-for-byte); every live-only string was then grepped for across `.claude/skills/**` and `docs/**` (retros included) to check whether any current skill or historical record still names it.

At the time of the original pass, the live file's `npx @formtrieb/flotilla-engine` pair, the dotted vendored `cli.ts` pair, `git merge-tree`, the five workspace-mechanic git verbs, `git push origin wave/:*`, `git worktree add:*`, the three verify-gate commands, and `mkdir -p:*` all matched an entry the (then six-form) scaffold documented — no delta on any of those. Of the two engine-CLI pairs, only the vendored `cli.ts` pair is still a scaffold match today, and only against this repo's own documented exception, not the generic block — the `npx` pair no longer matches anything in the current scaffold at all (ADR-0032 demoted it to a pre-setup bootstrap; see the note above). The genuine delta at the time was the following 20 entries.

| Live entry | Classification | Disposition |
|---|---|---|
| `Bash(npx tsx tools/wave/src/resume-cli.ts:*)` | scaffold-worthy (at the time) | Folded into the scaffold JSON + bullet at the time, then reclassified as this repo's documented exception (ADR-0032 rewrite note above); **since removed from the live file** together with the call-site that spelled it. Historical row — no live entry remains. |
| `Bash(./tools/wave/node_modules/.bin/tsx tools/wave/src/resume-cli.ts:*)` | scaffold-worthy (at the time) | Same history, same removal. |
| `Bash(npx tsx tools/wave/src/spine-cli.ts:*)` | scaffold-worthy (at the time) | Same history, same removal. |
| `Bash(./tools/wave/node_modules/.bin/tsx tools/wave/src/spine-cli.ts:*)` | scaffold-worthy (at the time) | Same history, same removal. |
| `Bash(npx tsx src/cli.ts:*)` | stale | Pre-router (pre-issue-#77) direct entrypoint, spelled `src/cli.ts` — only resolvable with `tools/wave/` as cwd, since no top-level `src/` has ever existed in this repo (confirmed: no `src/cli.ts` appears anywhere in this repo's git history, and PROVENANCE.md places the engine at `tools/wave/` from the seed onward). Zero references in any tracked skill or retro. Operator handoff below. |
| `Bash(npx tsx src/issue-store-cli.ts:*)` | stale | Same class — pre-#77 separate `issue-store` entrypoint, now the `{{wave-cli}} issue-store` router subcommand; unreferenced anywhere. Operator handoff below. |
| `Bash(npx tsx src/cross-wave-cli.ts:*)` | stale | Same class — pre-#77 separate `cross-wave` entrypoint, now `{{wave-cli}} cross-wave`; unreferenced anywhere. Operator handoff below. |
| `Bash(npx tsx src/host-pr-cli.ts:*)` | stale | Same class, and stronger: `host-pr-cli.ts` isn't even one of `cli.ts`'s own three documented retained aliases (only `resume-cli.ts`, `cli-store.ts`, `spine-cli.ts` are — see the bullet above) — `host-pr` has been router-only since #77 with no retained direct form at all. Operator handoff below. |
| `Bash(./node_modules/.bin/tsx src/cli.ts:*)` | stale | Local-binary twin of the same pre-#77, `tools/wave/`-as-cwd-relative form (and there is no top-level `./node_modules` either — confirmed absent from this repo root). Operator handoff below. |
| `Bash(./node_modules/.bin/tsx src/issue-store-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(./node_modules/.bin/tsx src/cross-wave-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 npx tsx src/cli.ts:*)` | stale | `NODE_USE_ENV_PROXY=1`-prefixed twin of the same pre-#77 form. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 npx tsx src/issue-store-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 npx tsx src/cross-wave-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 npx tsx src/host-pr-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 ./node_modules/.bin/tsx src/cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 ./node_modules/.bin/tsx src/issue-store-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 ./node_modules/.bin/tsx src/cross-wave-cli.ts:*)` | stale | Same. Operator handoff below. |
| `Bash(tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts:*)` | stale | A second, un-dotted spelling of the already-scaffolded `Bash(./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts:*)`. Bash treats both identically — any command token containing `/` runs as a path relative to cwd whether or not it starts with `./` — so this is a redundant duplicate, not a distinct capability; the scaffold's own enumeration (six canonical entries, at the time) never included this bare spelling. Operator handoff below. |
| `Bash(NODE_USE_ENV_PROXY=1 tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts:*)` | stale | The `NODE_USE_ENV_PROXY=1`-prefixed twin of the same redundant un-dotted spelling. Operator handoff below. |

No entry in this reconciliation needed a **dogfood-only** disposition — every live-only entry resolved cleanly to either scaffold-worthy (folded in above) or stale (candidate for removal below). That is not a claim that a dogfood-only carve-out could never apply to a future entry — only that none of today's 20 needed one.

**Operator handoff — live-settings changes this row does NOT perform.** `.claude/settings.json` is agent-write-denied on this repo and outside this issue's declared Files (`.claude/skills/wave-setup/reference/setup-mechanics.md` only), so the classifications above are recorded here, not applied. An operator with write access to the live file should, in its own PR against `.claude/settings.json`:

1. **Remove** the 16 stale entries enumerated in the table above (the four pre-#77 `src/*-cli.ts` entrypoints, each in its `npx tsx` / local-binary × unprefixed / `NODE_USE_ENV_PROXY=1`-prefixed variants that actually exist live, plus the two redundant un-dotted `tools/wave/node_modules/.bin/tsx …` spellings).
2. ~~Leave the 4 scaffold-worthy `resume-cli.ts` / `spine-cli.ts` entries as-is.~~ **Superseded:** those four have since been removed from the live file, in the same change that respelled the last two call-sites spelling them to the unified subverb form (see the reconciled bullet above). Nothing is left to leave in place.
3. Re-run the verify gate (`npm test` / `npm run typecheck` from `tools/wave/`) after editing `.claude/settings.json` — the file itself isn't code the gate exercises, but confirming the removed forms weren't quietly load-bearing somewhere untracked is a cheap check to fold into the same PR.

**Going forward.** A new entry added to this repo's live tracked `permissions.allow` must arrive with **either**:

- a **scaffold citation** — the entry is added to the JSON block above (or an existing bullet extended to cover it) in the same change that adds it live, with its generic rationale stated inline; **or**
- an explicit **dogfood-only note** — naming, in this file or the landing PR's description, why this repo's own dogfood setup needs the entry and no generic consumer would.

An entry landing without either is exactly the drift this issue exists to close. The next reconciliation pass should find zero unclassified live-only entries, not a repeat of this one.

**Enforced, not just stated (issue #291).** The paragraph above used to be a static prose classification that nothing falsified — the reconciliation Worker disclosed exactly that gap under Convention 11's could-not-falsify channel. `tools/wave/src/allowlist-scaffold-guard.spec.ts` now runs this rule for real, in CI, on every `npm test`: it diffs the live `permissions.allow` array against this file's canonical scaffold set, the documented vendored-form exception, and the dogfood-only table below (plus a named, shrink-only seeded-legacy allowance for pre-guard stale entries an operator PR has not yet removed), and fails loud on any entry that lands without a citation. The could-not-falsify disclosure this issue was filed under is retired — the check exists now, and its own permanent negative controls (a planted uncited entry, in the spec) prove it can actually fail. **That seeded-legacy allowance is empty as of issue #345** — `.claude/settings.json` was outside issue #291's own declared Files globs, so its four seeded entries (the `npx @formtrieb/flotilla-engine` pair and the bare `npx tsx tools/wave/src/cli.ts` pair) waited for a later operator PR to actually remove them; issue #345 declared that file in its own Files globs and performed the removal (`tools/wave/src/allowlist-scaffold-guard.spec.ts`'s `SEEDED_LEGACY_ALLOW` records the disposition of each).

### 2026-07-31 pass — the used-but-absent direction (issue #291)

**The #269 reconciliation above runs in exactly one direction: live entry → is it cited?** It classified what the file *carried*; it never asked what the file *lacked*. Issue #291's guard inherits that asymmetry verbatim — its failing condition is "a live allowlist entry that is neither in the scaffold's canonical set nor dogfood-documented", which no amount of green can tell you about a command a dispatched agent runs a hundred times without an entry. A one-directional check and a complete one are indistinguishable from their output; this is the Convention 9 wiring-gap shape applied to the allowlist itself.

This pass reads the same measured facts through the allowlist lens (is the spelling on the permission surface?). ["Measure before recording"](#measure-before-recording--resolution-proven-by-execution-not-inspection) above reads the identical trap through the wave-setup PROCEDURE lens (was the resolving spelling ever measured and recorded before a Coordinator needed it?) — the gap that lens closes is issue #272, and it is why this pass's own findings below double as that section's worked evidence rather than being re-measured from scratch.

**Method (converse of the #269 method).** Every `Bash` tool call in this repo's session transcripts since 2026-07-26 was extracted from the on-disk JSONL — coordinator sessions *and* the per-worktree AFK Worker/Reviewer transcripts, which live under their own `~/.claude/projects/<worktree-path>/` roots and are missed entirely by a scan of the coordinator's project directory alone. 694 transcripts, 644 of them worker-side, 12,337 Bash calls. Each leading command form was then matched against the live `permissions.allow`.

**The finding: the two verify gates have three spellings, and the allowlist carried only one.**

| Source | Spelling | On the live allowlist before this pass |
|---|---|---|
| `wave.config.json` → `verify.profiles[].commands` | `npx vitest run` / `npx tsc --noEmit` (cwd `tools/wave`) | yes — both |
| Root `CLAUDE.md` → **Verify** | `npm test` / `npm run typecheck` (from `tools/wave/`) | **no — neither** |
| Measured Worker practice (KW-F7: parallel `npx` contends on the npm cache lock) | `./tools/wave/node_modules/.bin/vitest run`, `./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit` | **no — neither** |

An agent that reads `CLAUDE.md` — the file every session is told to read first — and runs the gate it names was running an un-allowlisted command. Measured: `npm run typecheck` 111×, `npm test` 52×, the local-binary vitest form 135×, the local-binary `tsc` form 23×, `npm ci --prefix <path>` 61×.

**Why this never showed up as a permission prompt, and why that is not reassurance.** The same scan found **zero** permission prompts across all 12,337 calls (raw grep for the prompt shape across all 120 worktree transcript roots: no hits). The gap was masked end-to-end by two allowlists that are *not* part of the dispatch contract — the operator's own user-level `~/.claude/settings.json` (`Bash(npm *)`, `Bash(npx *)`, `Bash(node *)`, `Bash(git *)`) and the gitignored `.claude/settings.local.json`. Neither reaches a fresh consumer, and the gitignored one does not even reach this repo's own Worker worktrees. This is precisely why issue #290's third acceptance criterion — *"a subsequent engine invocation and one wave step run without a new permission prompt"* — is a weak live gate: it passes on a masked-but-incomplete tracked file, and it passed on this one.

**Disposition — all five entries are dogfood-only.** None is folded into the generic scaffold JSON block above: `npm test` / `npm run typecheck` are *this repo's* npm-script names, and the two local-binary forms are the vendored source-form paths of this repo's own documented `engine.cli` exception. A fresh consumer scaffolds the exact command forms *their* `verify.profiles[].commands` declares, exactly as the verify-gate bullet already instructs.

| Live entry (added 2026-07-31) | Classification | Rationale |
|---|---|---|
| `Bash(npm test)` | dogfood-only | Root `CLAUDE.md`'s **Verify** gate spelling, and the spelling the #269 operator-handoff step 3 itself prescribes re-running. Measured 52×. |
| `Bash(npm run typecheck)` | dogfood-only | Same source, same section; the `tsc --noEmit` half. Measured 111×. Pinned to the one script — **not** `npm run *`, which would be arbitrary code execution. |
| `Bash(npm ci --prefix:*)` | dogfood-only | The engine is a vendored subpackage at `tools/wave/`, so the install runs from the repo root with `--prefix`; the prefix path varies (repo-relative and absolute forms both measured), hence the suffix wildcard on an otherwise fixed verb. Anticipated verbatim by the verify-gate bullet above (*"`npm ci --prefix tools/wave`, … allowlists that exact form instead"*). Measured 61×. The plain `Bash(npm ci)` scaffold line stays untouched beside it — byte-for-byte scaffold parity is what the #269 method diffs against. |
| `Bash(./tools/wave/node_modules/.bin/vitest run:*)` | dogfood-only | KW-F7 local-binary form; suffix wildcard because the measured calls carry `--root`/filter arguments. Measured 135×. |
| `Bash(./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit)` | dogfood-only | KW-F7 local-binary form, exact — the measured calls carry no varying argument. Measured 23×. |

**Exact-form matching against a redirected command — measured in both branches (issue #345), still open.** Every measured call carries a suffix (`npm test 2>&1 | tail -40`), and the exact-form entries (`Bash(npm test)`, `Bash(npm run typecheck)`, `Bash(./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit)`, and the pre-existing `Bash(npx tsc --noEmit)`) assume the permission matcher splits on the pipe/redirection before matching, rather than requiring the whole invoked string to equal the entry byte-for-byte. Issue #345 ran the exact-form `./tools/wave/node_modules/.bin/tsc -p tools/wave --noEmit` entry in both branches from a worktree-isolated dispatch: bare (no suffix — the literal entry text) and with a realistic redirect+pipe suffix appended (`… --noEmit 2>&1 | tail -5`, mirroring the measured Worker-practice shape). **Both branches ran clean, with no observable difference between them** — which is a real measurement, but not the falsification it might look like: this dispatch class showed zero friction on *every* command run in it over its own session, including commands with no allowlist entry at all (a bare `jq --version`, entirely unlisted, also ran clean — see the jq-entry bullet above), so a dispatch-level masking layer independent of the tracked allowlist cannot be ruled out here, the same structural problem the original note named for the user-level `Bash(npm *)` mask. **What would actually falsify this**: an environment provably running with *only* the tracked `.claude/settings.json` as its permission source (no user-level or dispatch-level allowlist/auto-approval layer active) — the piped branch should prompt or block there if the assumption is wrong, and the bare branch should not. That environment was not available to this measurement, in this dispatch or the one before it; if a future wave ever does see a permission prompt on one of these exact-form entries and not the other, that asymmetry is the falsification this note has been waiting for, and the fix is a `:*` suffix on the entry that prompted.

**Deny-parity divergence (2026-07-31, operator).** The live `permissions.deny` no longer matches the scaffold: `Read(.claude/settings.local.json)` and `Read(**/.claude/settings.local.json)` were removed by the operator after ADR-0029 moved every credential into the Keychain lookup path, leaving that file holding no secret. The scaffold above deliberately keeps **both** lines — a generic consumer's `settings.local.json` may still hold live credentials, and the vector Convention 8 catalogues (a Reviewer reading it while hunting a config precedent) is universal. Two notes for whoever reconciles next: the live file's Bash-side anchors (`cat`/`less`/`more`/`head`/`tail`) were *kept*, so the `Read` tool is now open on a path the Bash read-forms still refuse — an asymmetry, not a deliberate policy; and the two `Read` lines are a **pair by necessity**, root form plus `**/` form, because `**/` alone does not match the repo-root path (observed directly: with only the `**/` line live, a root-relative `Read` of the file succeeded). The `.env` anchors above are written as the same pair for the same reason — do not "simplify" either pair to its `**/` half.

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

## Credential lookup-command scaffold (ADR-0029)

The three artifacts: the keychain item, the `<VAR>_CMD` env entry, and its matching `permissions.deny` anchor.

The SKILL.md [Credentials](../SKILL.md#credentials) section owns the **judgment** (the two first-class paths, the live-gate vs. "ACL bind" framing, the AFK-incompatibility of per-invocation-confirmation resolvers, the direnv+keychain half-measure); this is the concrete scaffold. Like the AFK harness config above, it lands in the consumer repo's **tracked** `.claude/settings.json` — the same file, not a second one — because a dispatched Worker/Reviewer worktree carries tracked files only, and the `<VAR>_CMD` entry has to reach that worktree for the wave's own dispatched agents to resolve the credential, not only the operator's interactive session.

Run this once per credential the consumer needs — the code-host landing credential (`GITHUB_TOKEN` on `github`; `BITBUCKET_TOKEN` on `bitbucket`) plus `LINEAR_API_KEY` for a `linear` store. macOS `security` is the worked example below — the same three-artifact shape applies to any platform-native secret store or session-authenticated CLI (`op`, …), substituting that tool's own create/read invocation.

**1. The keychain item.** The default ACL (no `-T` restriction) governs *steady-state* reads without dispute — every read after the first resolves promptless, on every environment observed so far. The **first** value-read (`-w`) of a freshly created item is the part that is **environment-conditional**, not a fixed fact: on the machine this note was originally written against, it prompted the operator once, interactively, for authorization — clicking **Always Allow** on that prompt (see the live-gate below) is what made *every later* read promptless. A 2026-08-14 determination against current macOS (ADR-0029's dated amendment, filed against issue #544) found the identical sequence resolve with **no prompt at all** on its first read. Treat both as live possibilities on a fresh consumer machine, and let the live-gate below settle which applies here — never assert either direction ahead of running it. An attribute-only read (`find-generic-password` without `-w`) never triggers this prompt on either environment, so it cannot stand in as a check that the value-read path is promptless.

```bash
security add-generic-password -a $USER -s flotilla-github-token -w
```

**A GUI cross-check for operators who hit trouble with the command line above**: the same item can also be inspected in the **Keychain Access** app — search for the same service name the scaffold used (e.g. `flotilla-github-token`) to confirm the item landed under the expected name. This is strictly an existence/name check: it confirms the item is there, never a way to read the secret's value out.

**Replacing a regenerated token.** `add-generic-password` refuses outright when an item under that same account/service pair already exists — it does not overwrite. A bare re-run after rotating the token (revoked-and-reissued PAT, a new Bitbucket API token, …) leaves the *old* item, and every `_CMD` lookup keeps resolving the stale value with nothing loud to say so. Delete the existing item before re-adding:

```bash
security delete-generic-password -a $USER -s flotilla-github-token
security add-generic-password -a $USER -s flotilla-github-token -w
```

**2. The `<VAR>_CMD` entry**, merged into the same `env` block as the proxy flag:

```json
{
  "env": {
    "NODE_USE_ENV_PROXY": "1",
    "GITHUB_TOKEN_CMD": "security find-generic-password -a $USER -s flotilla-github-token -w"
  }
}
```

For a `linear` store, add `LINEAR_API_KEY_CMD` the same way, against its own keychain item:

```json
{
  "env": {
    "NODE_USE_ENV_PROXY": "1",
    "GITHUB_TOKEN_CMD": "security find-generic-password -a $USER -s flotilla-github-token -w",
    "LINEAR_API_KEY_CMD": "security find-generic-password -a $USER -s flotilla-linear-key -w"
  }
}
```

**On a Bitbucket-hosted consumer, `BITBUCKET_TOKEN_CMD` replaces `GITHUB_TOKEN_CMD` in this same block** — it is the code-host landing credential, not an addition alongside it (see [SKILL.md's Credentials](../SKILL.md#credentials) for the derivation). `BITBUCKET_EMAIL`, once this wave will run `host-pr create`, joins the same block as a **plain value, not a `_CMD` entry** — it is an identifier, not a secret, so there is no keychain item and no lookup command for it at all:

```json
{
  "env": {
    "NODE_USE_ENV_PROXY": "1",
    "BITBUCKET_TOKEN_CMD": "security find-generic-password -a $USER -s flotilla-bitbucket-token -w",
    "BITBUCKET_EMAIL": "operator@example.com"
  }
}
```

**3. The `permissions.deny` entry** — one per scaffolded `<VAR>_CMD`, the exact command string as the `Bash(...)` prefix, merged into the same `deny` array as the secret-echo anchor. `BITBUCKET_EMAIL` gets no entry here either — nothing about it is worth denying a read of, since it carries no secret:

```json
{
  "permissions": {
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
      "Bash(tail .env:*)",
      "Bash(security find-generic-password -a $USER -s flotilla-github-token -w:*)",
      "Bash(security find-generic-password -a $USER -s flotilla-linear-key -w:*)"
    ]
  }
}
```

The first block (`Read`/`cat`/`less`/`more`/`head`/`tail` against the gitignored settings/`.env` files) is the pre-existing secret-echo anchor (wave-shared Convention 8, FOR-81) — unchanged, universal, scaffolded identically for every consumer. The trailing two lines are the ADR-0029 addition: **per credential**, keyed to the exact command just written into that credential's `<VAR>_CMD` — this is what closes the residual vector (the environment now carries a pointer, so the leak class becomes "execute the lookup command directly," and this entry blocks the agent harness's own Bash tool from doing that). It anchors the direct form only — an `echo $(security …)` wrapper is out of scope here, left to the separate PreToolUse-hook candidate. It does not restrict the engine's own resolution: `credential-resolver.ts`'s `child_process` spawn runs *inside* an already-allowlisted CLI invocation (`store-preflight`, `host-pr`, a store verb), a different actor than an agent's Bash tool reaching for the command directly.

On a Bitbucket-hosted consumer, the `flotilla-github-token` line above is replaced by its `BITBUCKET_TOKEN_CMD` counterpart (`Bash(security find-generic-password -a $USER -s flotilla-bitbucket-token -w:*)`) — same substitution as the `env` block above, credential for credential, never an addition alongside the GitHub line. `BITBUCKET_EMAIL` never appears in this array: it carries no secret, so there is nothing here for it to anchor.

**The live-gate — a possible first-read Always-Allow click, then `store-preflight`.** Once all three artifacts exist, the operator runs up to three steps. The first two, when this machine's keychain needs them at all, happen **in their own terminal** (never through a dispatched Worker — any click here is a one-time human action, not something an AFK agent can or should resolve); the third confirms resolution through the engine from a **different vantage point**, not a continuation of the same bare terminal. **Whether steps 1–2 do anything is environment-conditional (ADR-0029's 2026-08-14 amendment)** — some machines need them, some resolve clean on the first try — so run step 1 and observe rather than assuming either outcome:

1. **Trigger the first read, value-free.** Run the exact `<VAR>_CMD` form with its output redirected away, so the secret is never displayed even once:

   ```bash
   security find-generic-password -a $USER -s flotilla-github-token -w > /dev/null
   ```

   **Two expected shapes, not one — either can be correct, and neither by itself is a defect.** On a machine where the default ACL's first read is interactive, this run fails before the macOS authorization dialog is answered: non-zero exit, nothing on stdout (originally observed as lookup-exit 161, twice) — the correct signal that the item isn't yet authorized for value-reads, not a broken scaffold or a wrong service name; re-running the same command is how to make the dialog reappear if it was dismissed without a click. On a machine where the first read is not interactive at all — measured live against current macOS, 2026-08-14, issue #544, ADR-0029's dated amendment — this run instead exits 0 with the secret already on stdout (redirected away, per the command above), and there is no dialog to click; skip straight to step 3.

2. **If a dialog appeared, click Always Allow** on it — not the one-time "Allow", which leaves the *next* read prompting again. This is the step that flips the item from "prompts every value-read" to "reads promptless from here on." If no dialog appeared in step 1, there is nothing to do here — the item is already reading promptless.

3. **Re-run `store-preflight`** (or any engine call that constructs the store/host client — it resolves the credential as a side effect) — **through the harness (the Claude Code session running wave-setup), not the bare terminal steps 1–2 just used:**

   ```bash
   {{wave-cli}} store-preflight --config wave.config.json
   ```

   **Why this step changes vantage point and steps 1–2 don't.** `<VAR>_CMD` lives only in the tracked settings `env` block — a channel the harness loads and a bare external shell does not. Steps 1–2 don't need it: they exercise the keychain item directly, with the literal `security …` command, to answer a question that has nothing to do with `<VAR>_CMD` at all (is the item authorized for value-reads yet?). Step 3 is different — it asks the engine to resolve `<VAR>_CMD` the same way a dispatched Worker will, so it has to run somewhere that same variable is actually set. Run it in the operator's own bare terminal anyway and it fails with a real, correctly-worded "not configured" error (e.g. `LINEAR_API_KEY is required … and neither source is configured` when the terminal has no `LINEAR_API_KEY_CMD` set) — accurate about *that terminal's* environment, and easy to misread as a broken scaffold. It is neither: the identical command, run through the harness, resolves cleanly. Live occurrence: an operator followed this step literally in a bare terminal, hit exactly this false failure, and only found the true state (`credential-probe --all` → `resolved: true` for every configured credential) by re-running inside the harness — a diagnostic round-trip this note exists to close.

A clean exit is the live-gate: the keychain item is readable — Always-Allowed if this machine's first read needed the click, or simply promptless from the start if it didn't — the `<VAR>_CMD` command is spelled correctly, and the engine's precedence resolves it ahead of any stray ambient variable. Read only the exit code — never execute the `<VAR>_CMD` value directly to "check" it; its stdout **is** the secret, and the engine's own resolution inside the preflight is the sanctioned check (SECRET-SAFE).

**The ambient path stays legitimate — do not scaffold `<VAR>_CMD` for a credential that should stay ambient.** An ephemeral CI-style environment (a per-job-scoped token injected into a minutes-lived environment with no keychain) is a first-class destination by design (ADR-0029), not a gap to close — leave `<VAR>_CMD` unset there, or set it explicitly to `""` if a repo-wide `env` block would otherwise apply it. There is no deprecation horizon for this path.
