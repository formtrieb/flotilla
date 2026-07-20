# The real GitHubApi is raw-`fetch` REST+GraphQL behind a GitHub-local seam, wired by a CLI-edge factory

The P8 production `GitHubApi` (the seam `GitHubIssuesStore` talks to, until now only an in-memory fake) is implemented with **raw `fetch`** against GitHub's **REST** (issue CRUD, labels, comments) plus **GraphQL** (the closing-PR probe only) — **not** `@octokit` (which would break the engine's deliberate dependency floor: `node:*` + `fast-glob` + `micromatch`) and **not** the `gh` CLI (whose creds are sandbox-denied here, forcing a subprocess + `dangerouslyDisableSandbox` per call; `github.com` is, by contrast, a sandbox-allowed host). The network side-effect sits behind a **new, GitHub-adapter-local `GitHubHttp` seam** — *not* an extension of host-pr's cross-host `HttpProbe` — and the impl is constructed by a **CLI-edge factory** (`createGitHubApiFromEnv`) so `buildStore` stays a pure assembler.

## The GitHub-local `GitHubHttp` seam (not host-pr's `HttpProbe`)

host-pr's `HttpProbe` is deliberately **cross-host** (GitHub *and* Bitbucket): `GET|POST` only, Basic-auth (`Authorization: Basic …`) baked into `defaultHttpProbe`. The real `GitHubApi` needs more than that contract can carry:

- **PATCH** (`setBody`, `nativeClose` → `state=closed`), **DELETE** (`removeLabel`) — outside `GET|POST`.
- a **`POST /graphql`** call with `Authorization: token <PAT>` for the closing probe.

So the impl gets its **own** `GitHubHttp` seam, local to the github adapter: `GET/POST/PATCH/DELETE` + GraphQL, token auth, `request → { status, json }` (no response headers — see pagination). `defaultGitHubHttp()` wraps global `fetch`; tests inject a **fixture probe** (canned `{status, json}` per route, zero network) — the same injection idiom as host-pr's `HttpProbe` and merge-order's `GitProbe`. The earlier `github-api.ts` header note ("wraps host-pr's `HttpProbe` underneath") is **superseded** by this ADR: the verb + auth needs outgrew that aspiration; keeping host-pr's cross-host abstraction pristine beats one shared-but-polluted boundary.

## `getClosingState` via GraphQL `closedByPullRequestsReferences`

The closing probe (ADR-0005: distinguishes `merged` → `done` from `closed-unmerged` → `needs-attention`) resolves through a single GraphQL query on `Issue.closedByPullRequestsReferences(includeClosedPrs: true)` → the closing PRs with their `merged` boolean + `url`. It is the purpose-built API for exactly this question and yields the `ClosingPrState` shape directly. The REST `/issues/{n}/timeline` alternative stays Basic-auth-only but needs fragile event-correlation + a second call; it is the **documented escape hatch** only if a build-time spike finds the GraphQL path problematic. Single runtime path, no auto-fallback.

## Wiring: a CLI-edge factory keeps `buildStore` pure

`buildStore` is a tested **pure assembler** (config → store). Reading `process.env` / shelling `git remote` inside it would break that invariant. Instead the impurity lives at the **CLI edge**: `createGitHubApiFromEnv()` (called by `issue-store-cli` / `resume-cli`) reads **`GITHUB_TOKEN`** from the env (sandbox-readable + CI-standard; `gh auth token` would read sandbox-denied `~/.config/gh`), auto-detects **owner/repo** via the existing `detectHost(git remote origin)` (zero-config; optional config override), constructs `RealGitHubApi(owner, repo, creds, GitHubHttp)`, and injects it as `deps.githubApi`. `buildStore`'s signature is unchanged; its `github`-without-api **deferral throw stays** as the safety net for "github store, nobody injected an api."

## Cross-cutting contract details

- **Pagination.** `listOpenIssues` (and `getComments`) page to **exhaustion** via `per_page=100` + a **count heuristic** (keep paging while a full page returns; stop on a short/empty one) — header-free, so the seam stays `{status, json}`. The in-memory fake returns all in one shot, so a **seam-level fixture test** (full page → short page → assert complete) closes the conformance gap the fake cannot.
- **Errors are fail-fast + typed.** Any non-2xx → a typed `GitHubApiError(status, op)`; the CLI exits non-zero, the skill routes (`401` → STOP/auth, else → `needs-attention`). A **construction-time auth preflight** (`GET /user` inside the factory) fails a bad token loudly up-front, mirroring the wave-shared "preflight at the top" convention. **No retry-with-backoff** in M1 (the 5000/h authenticated limit is never approached by a small wave; honoring `Retry-After` would force response-headers back into the seam) — explicitly P-future.
- **Tests stay hermetic.** Full fixture-probe unit coverage (request-shaping, response-parsing, pagination, GraphQL parse, error-mapping); the **live proof is the P8 e2e runbook** on a sandbox fork, not a committed networked spec.

## Considered Options

- **Raw `fetch` REST + GraphQL behind a GitHub-local seam** (chosen) — zero new deps (holds the engine floor), sandbox-friendly, fully fixture-testable, GraphQL only where REST is weak (the closing probe). Cost: a second network seam parallel to host-pr's, and a hand-written request layer.
- **`gh` CLI subprocess** (rejected) — auth-transparent + matches the early "GitHub (gh CLI)" PRD wording, but gh creds are sandbox-denied (subprocess + `dangerouslyDisableSandbox` per call), and unit-testing means mocking spawned processes.
- **`@octokit/rest` + `@octokit/graphql`** (rejected) — best ergonomics, but heavy npm deps that break the deliberate engine dependency-minimalism (CHARTER §4).
- **Extend host-pr's shared `HttpProbe`** (rejected) — one engine-wide network boundary, but coalesces two different host contracts (Bitbucket Basic/`GET|POST` vs GitHub token/REST+GraphQL/`PATCH|DELETE`) into one polluted abstraction.

## Consequences

- **New surface:** `GitHubHttp` seam + `defaultGitHubHttp()` + `RealGitHubApi` (all 10 methods) + `createGitHubApiFromEnv()` at the CLI edge; the `store-factory` deferral throw is retained, not removed. No change to `GitHubIssuesStore` (it already speaks only the seam) — the conformance suite stays green unchanged.
- **Harness-agnostic engine intact (ADR-0009):** the engine still imports no harness primitive; `fetch` is a Node built-in, the token/owner/repo come in through a thin CLI-edge factory, and skills shell the CLI as before.
- **`gh` is still used by skills for PR *creation*** (the worker terminator's `gh pr create … Closes #N`, ADR-0004) — this ADR governs the **engine's `GitHubApi`** (issue/label/comment/close/closing-probe), not the skill-side PR open. The two are deliberately separate hosts of GitHub I/O. **(Amended — [ADR-0023](0023-landing-is-partial-arm-through-the-engine-host-seam.md), 2026-07-16:)** superseded, staged — every host write moves behind the engine `host-pr` verbs (`create|arm|merge|status`, find-before-create included): `gh` leaves the landing path immediately and the creation path as a fast-follow slice. The GitHub impls ride this ADR's `GitHubHttp` seam; host-pr's cross-host `HttpProbe` boundary stays.
- **M2 hardening, deliberately deferred:** retry-with-backoff + `Retry-After` (needs response-headers in the seam), `Link`-header pagination, a committed env-gated live spec, and a config-supplied token/owner/repo override beyond the env/`detectHost` defaults.
