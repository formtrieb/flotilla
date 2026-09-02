# Issue specs — flotilla `v0.1.0-beta` plugin wave (ready to file)

> **Historical (2026-07-26).** This is a planning document from before flotilla ran on itself — kept because engine doc-comments cite it as the origin of the plugin-beta workstreams, not because it is a living plan. flotilla plans on its tracker now; nothing new is filed under `docs/plans/`.

Companion to [`2026-07-26-plugin-beta-ship-plan.md`](2026-07-26-plugin-beta-ship-plan.md).
Nine finer-grained, wave-ready slices in the exact shape flotilla's own header-parser /
body-codec expect, each with a copy-paste `CreateInput` JSON. **This is the input for a live
dogfood of the GitHub-Issues adapter** — run it from a machine with a real `GITHUB_TOKEN` and
unrestricted egress (the sandbox's egress policy 403s the raw adapter path, so it can't run
there).

## How to file these (on your machine)

1. **Preconditions.** A `wave.config.json` with `{"store":"github"}` in the repo (run
   `wave-setup` if absent). `GITHUB_TOKEN` exported with issues-write on `formtrieb/flotilla`.
   On Node ≥ 24 behind a proxy: `NODE_USE_ENV_PROXY=1`.
2. **Two ways to publish:**
   - **Via the skill (recommended):** hand this file to `/to-issues`. It will re-confirm the
     breakdown with you (step 3 quiz), then run the two-pass publish itself.
   - **Direct:** `{{wave-cli}} issue-store create --input <slice>.json` per slice, **blockers
     first**. The `CreateInput` JSON per slice is below.
3. **`blockedBy` two-pass.** Every JSON below ships `"blockedBy": "none"` so pass-1 slices file
   as-is. For the dependent slices, the "Blocked by" line names the *plan-local* predecessors —
   after they're minted, invert each returned id with `{{wave-cli}} issue-store parse-ref <id>`
   and drop the resulting `IssueRef` object(s) into `blockedBy` before creating the dependent.
   Never hand-spell a ref.
4. **Self-check = the real live-gate.** After filing, run `{{wave-cli}} dor --id <id>` and
   `{{wave-cli}} conflict-map --id <a> --id <b> …` across the batch. These exercise the GitHub
   adapter's **read** path (the least live-proven surface) — that round-trip *is* Workstream 5.
5. No `parent`: these slices come from an in-repo markdown plan, not a published PRD document,
   so the field is omitted. (Optional: publish the ship plan via `to-prd` first and set
   `parent` to its id if you want the tracker back-reference.)

## Breakdown at a glance

| # | Slice | Risk | Worker | Blocked by | Type |
|---|---|---|---|---|---|
| 1a | Unify engine entrypoints under the CLI router | cross-feature-refactor | background-heavy | — | AFK |
| 1b | Make the engine a publishable npm package | public-API-change | background-heavy | — | AFK (publish = human release step) |
| 2 | Pin `{{wave-cli}}` resolution + AFK allowlist to the package | isolated-refactor | background | 1a, 1b | AFK |
| 3a | Add the plugin manifest | isolated-refactor | background | — | AFK |
| 3b | Namespace cross-skill by-name refs to `/flotilla:<skill>` | isolated-refactor | background | 3a | AFK |
| 4 | Add the marketplace manifest | isolated-refactor | background | 3a | AFK |
| 5 | Run the live GitHub-Issues gate wave + retro | isolated-refactor | HITL-required | 1b, 2, 3a, 4 | HITL |
| 6a | Rewrite README + ONBOARDING install docs | isolated-refactor | background | 2, 3a, 4 | AFK |
| 6b | CHANGELOG + `v0.1.0-beta` tag | mechanical | background | 5 | AFK (tag = human release step) |

**Parallelism:** 1a ∥ 1b ∥ 3a can all start immediately (disjoint file scopes). 2 and 3b touch
different files under `.claude/skills/**` (reference/config vs `SKILL.md` bodies) — declared
precisely below so the conflict-map keeps them in separate lanes.

---

## 1a — Unify engine entrypoints under the CLI router

**Risk** cross-feature-refactor · **Worker** background-heavy · **Blocked by** none
**Files:** `tools/wave/src/cli.ts`, `tools/wave/src/cli.spec.ts`, `tools/wave/src/cli-store.ts`, `tools/wave/src/cli-store.spec.ts`, `tools/wave/src/resume-cli.ts`, `tools/wave/src/resume-cli.spec.ts`, `tools/wave/src/spine-cli.ts`, `tools/wave/src/spine-cli.spec.ts`

The skills reach the engine through direct module invocations that the future `npx
@formtrieb/flotilla-engine <sub>` bin can't expose: `cli-store.ts preflight` (store-preflight, 3
call-sites), `resume-cli.ts` (resume, 6 call-sites, **no `resume` case in the router**), and
`spine-cli.ts` (redundant with the existing `spine` router case). Fold them into the `cli.ts`
router as first-class subcommands (`store-preflight`, `resume`; collapse the redundant spine
path) so the whole engine surface is one `{{wave-cli}} <sub>` idiom.

```json
{
  "title": "Unify engine entrypoints under the CLI router",
  "filingHint": "engine-router-unify",
  "risk": "cross-feature-refactor",
  "worker": "background-heavy",
  "files": ["tools/wave/src/cli.ts", "tools/wave/src/cli.spec.ts", "tools/wave/src/cli-store.ts", "tools/wave/src/cli-store.spec.ts", "tools/wave/src/resume-cli.ts", "tools/wave/src/resume-cli.spec.ts", "tools/wave/src/spine-cli.ts", "tools/wave/src/spine-cli.spec.ts"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "`{{wave-cli}} resume …` runs the resume reconcile that `resume-cli.ts` runs today (same output/exit codes), covered by a router spec", "checked": false },
    { "text": "`{{wave-cli}} store-preflight …` runs the store-preflight that `cli-store.ts preflight` runs today, covered by a router spec", "checked": false },
    { "text": "The redundant standalone `spine-cli` path is collapsed onto the router `spine` case (or documented as an alias); no behavior regressions", "checked": false },
    { "text": "All engine gates green: `npm test` (1800+) and `npm run typecheck` clean", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Expose the engine's currently-standalone entrypoints (`cli-store.ts preflight`, `resume-cli.ts`, `spine-cli.ts`) as `cli.ts` router subcommands so the entire engine surface is reachable as `{{wave-cli}} <sub>` — the precondition for a single npm `bin`. Preserve every existing behavior and exit code; add router-level specs mirroring the standalone specs." }
  ]
}
```

## 1b — Make the engine a publishable npm package

**Risk** public-API-change · **Worker** background-heavy · **Blocked by** none
**Files:** `tools/wave/package.json`, `tools/wave/package-lock.json`, `tools/wave/bin/wave-engine.js`

Turn `tools/wave` into `@formtrieb/flotilla-engine`, publishable and runnable as
`npx @formtrieb/flotilla-engine`. Drop `private: true`, set `version: 0.1.0-beta.0`, add a `bin`
shim that runs `tsx` over `cli.ts` (preserves the charter's *no build step*), a `files`
whitelist, `publishConfig.access: public`, `license`, `repository`, `engines.node`. Move `tsx`
from `devDependencies` → `dependencies` (raw-TS runtime needs it). The actual `npm publish` is a
human release step. (Superseded: the scope is `@formtrieb`, already owned, and publishing runs through trusted publishing from CI — there is no `NPM_TOKEN`.)

```json
{
  "title": "Make the wave engine a publishable npm package (@formtrieb/flotilla-engine)",
  "filingHint": "engine-npm-package",
  "risk": "public-API-change",
  "worker": "background-heavy",
  "files": ["tools/wave/package.json", "tools/wave/package-lock.json", "tools/wave/bin/wave-engine.js"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "`package.json` drops `private`, sets `version: 0.1.0-beta.0`, adds `bin`, `files`, `publishConfig.access: public`, `license`, `repository`, `engines.node`", "checked": false },
    { "text": "`tsx` is a runtime `dependency`; `npm run typecheck` and `npm test` still clean", "checked": false },
    { "text": "In a clean temp dir, `npx @formtrieb/flotilla-engine dor --help` (or an offline subcommand) runs via the bin shim with no build step", "checked": false },
    { "text": "`npm pack` produces a tarball containing only the whitelisted `files` (src + bin + lockfile), verified by inspection", "checked": false },
    { "text": "Publish to npm is documented as the human release step; not part of the code change", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Package the engine for `npx @formtrieb/flotilla-engine` distribution: manifest metadata, a `tsx`-based `bin` shim (no build step), a `files` whitelist, and `tsx` promoted to a runtime dependency. Prove it runs from a cold `npx` install. The `npm publish` itself is a gated human release action, called out but not automated here." }
  ]
}
```

## 2 — Pin `{{wave-cli}}` resolution + AFK allowlist to the package

**Risk** isolated-refactor · **Worker** background · **Blocked by** 1a, 1b
**Files:** `.claude/skills/README.md`, `.claude/skills/wave-setup/reference/setup-mechanics.md`, `.claude/skills/wave-resume/reference/resume-mechanics.md`, `.claude/settings.json`

Repoint the `{{wave-cli}}` *resolution definition* (not the 21 placeholder call-sites) from
`npx tsx tools/wave/src/cli.ts` to `npx @formtrieb/flotilla-engine`, and rewrite the direct
`tools/wave/src/{cli-store,resume-cli}.ts` invocations to the new subcommand form. Update the
tracked AFK permission allowlist in `.claude/settings.json` **and** the allowlist `wave-setup`
scaffolds accordingly (the plugin spec forbids shipping allowlists in the manifest — this stays
a `wave-setup`/consumer concern).

```json
{
  "title": "Pin {{wave-cli}} resolution and the AFK allowlist to @formtrieb/flotilla-engine",
  "filingHint": "wave-cli-resolution-pin",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": [".claude/skills/README.md", ".claude/skills/wave-setup/reference/setup-mechanics.md", ".claude/skills/wave-resume/reference/resume-mechanics.md", ".claude/settings.json"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "The `{{wave-cli}}` resolution definition names `npx @formtrieb/flotilla-engine` in README + setup-mechanics", "checked": false },
    { "text": "The direct `npx tsx tools/wave/src/{cli-store,resume-cli}.ts` invocations are rewritten to the unified subcommand form (`store-preflight` / `resume`)", "checked": false },
    { "text": "`.claude/settings.json` allowlist entries cover `npx @formtrieb/flotilla-engine` (both prefix-free and `NODE_USE_ENV_PROXY=1` forms); the old `tools/wave/src/cli.ts` forms are removed or retained only as fallback", "checked": false },
    { "text": "The allowlist `wave-setup` scaffolds is updated to match", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Make the npm package the canonical engine invocation everywhere it's *defined* (resolution docs + the few direct-module call-sites + the AFK allowlist), so a plugin consumer never needs a vendored `tools/wave` path. The `{{wave-cli}}` placeholder call-sites are untouched — only its resolution changes." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversions of the ids minted for **1a** and **1b** before creating this slice.

## 3a — Add the plugin manifest

**Risk** isolated-refactor · **Worker** background · **Blocked by** none
**Files:** `.claude-plugin/plugin.json`

Add `.claude-plugin/plugin.json` (`name: flotilla`, version, description, author, homepage,
license, keywords). Point it at the existing dirs so dogfooding is undisturbed:
`"skills": ["./.claude/skills"]` (the `skills` field *adds* to the default `skills/`) and
`"agents": ["./.claude/agents"]` (the `agents` field *replaces* the default). Validate with
`claude plugin validate --strict`, and confirm the plugin's skills coexist with flotilla's own
project-level `.claude/skills` when developing in this same repo (no double-registration break).

```json
{
  "title": "Add the flotilla Claude Code plugin manifest",
  "filingHint": "plugin-manifest",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": [".claude-plugin/plugin.json"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "`.claude-plugin/plugin.json` exists with `name: flotilla`, `version`, `description`, `author`, `license`, `keywords`", "checked": false },
    { "text": "`skills` points at `./.claude/skills` and `agents` at `./.claude/agents` — no skill/agent files are moved", "checked": false },
    { "text": "`claude plugin validate --strict` passes", "checked": false },
    { "text": "Confirmed empirically that the plugin and the repo's own project-level `.claude/skills` coexist without a double-registration conflict when working in-repo (documented result)", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Declare flotilla as an installable plugin by adding the manifest and pointing its component fields at the existing skill/agent directories (no file moves), then prove it validates and coexists with the self-dogfooding project skills. If a conflict surfaces, record the decision (e.g. move skills to a root `skills/`)." }
  ]
}
```

## 3b — Namespace cross-skill by-name refs to `/flotilla:<skill>`

**Risk** isolated-refactor · **Worker** background · **Blocked by** 3a
**Files:** `.claude/skills/wave-start/SKILL.md`, `.claude/skills/wave-reviewer/SKILL.md`, `.claude/skills/wave-close/SKILL.md`, `.claude/skills/wave-shared/SKILL.md`

Skills load `wave-shared` by name (ADR-0018: "project-local; `/flotilla:wave-shared` once
packaged"). First **verify** whether an unscoped by-name load still resolves when installed as a
plugin; if it does not, update the cross-skill references to the plugin-namespaced form
`/flotilla:wave-shared` (and any other cross-skill name loads). If unscoped resolves, close this
slice as a no-op with that finding recorded.

```json
{
  "title": "Namespace cross-skill by-name references for plugin distribution",
  "filingHint": "skill-namespace-refs",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": [".claude/skills/wave-start/SKILL.md", ".claude/skills/wave-reviewer/SKILL.md", ".claude/skills/wave-close/SKILL.md", ".claude/skills/wave-shared/SKILL.md"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "Determined (and recorded) whether an unscoped `wave-shared` by-name load resolves inside an installed plugin", "checked": false },
    { "text": "If scoping is required, every cross-skill by-name reference is updated to `/flotilla:<skill>`; if not, the finding is documented and no edit is made", "checked": false },
    { "text": "The skills still load `wave-shared` correctly in both in-repo (project) and installed-plugin contexts", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Make cross-skill composition survive plugin distribution. The wave back-half loads `wave-shared` by name; confirm the plugin-namespaced spelling is (or isn't) needed and apply it only if the unscoped form breaks under a plugin install." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversion of the id minted for **3a**.

## 4 — Add the marketplace manifest

**Risk** isolated-refactor · **Worker** background · **Blocked by** 3a
**Files:** `.claude-plugin/marketplace.json`

Add `.claude-plugin/marketplace.json` so `formtrieb/flotilla` is its own marketplace: `name`,
`owner`, and one plugin entry `{ "name": "flotilla", "source": "./" }` (a repo can be both the
marketplace and the plugin it lists via a `./` source). Smoke-test the install flow.

```json
{
  "title": "Add the marketplace manifest (repo as its own marketplace)",
  "filingHint": "marketplace-manifest",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": [".claude-plugin/marketplace.json"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "`.claude-plugin/marketplace.json` has `name`, `owner`, and one plugin entry `{ name: flotilla, source: \"./\" }`", "checked": false },
    { "text": "`/plugin marketplace add formtrieb/flotilla` then `/plugin install flotilla@<marketplace>` succeeds in a scratch session", "checked": false },
    { "text": "The installed plugin's wave skills are invocable as `/flotilla:<skill>`", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Make flotilla installable straight from its GitHub repo by adding the marketplace manifest that lists the plugin with a self-referential `./` source, then verifying the add→install→invoke flow end to end." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversion of the id minted for **3a**.

## 5 — Run the live GitHub-Issues gate wave + retro

**Risk** isolated-refactor · **Worker** HITL-required · **Blocked by** 1b, 2, 3a, 4
**Files:** `docs/retros/2026-07-27-github-live-gate.md`

CHARTER's named live proof: file a small real wave (≥2 issues) on `formtrieb/flotilla` using the
**installed plugin + published `@formtrieb/flotilla-engine`**, GitHub-Issues store, and run
`wave-setup → plan → create → start → close` end to end, landing the PRs. Capture it as a retro.
HITL because it needs a human driving a real wave with unrestricted egress + a real PAT.

```json
{
  "title": "Run the live GitHub-Issues gate wave and write the retro",
  "filingHint": "github-live-gate-wave",
  "risk": "isolated-refactor",
  "worker": "HITL-required",
  "files": ["docs/retros/2026-07-27-github-live-gate.md"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "A real ≥2-issue wave is driven `wave-setup → plan → create → start → close` on formtrieb/flotilla via the installed plugin + published engine, all against the GitHub-Issues store", "checked": false },
    { "text": "The GitHub adapter's read + write + closing-probe paths all exercised against real GitHub (no sandbox egress block)", "checked": false },
    { "text": "PRs land against protected `main`; issues resolve to `done` via the merged-PR close phrase", "checked": false },
    { "text": "A retro is written capturing what broke / held, usable as launch narrative", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "The end-to-end live gate for the least-proven adapter (GitHub Issues), which is simultaneously the primary OSS onboarding path. This is an operational run, not a code change — its artifact is the retro; its value is proving the full pipeline works through the shipped plugin + package." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversions of the ids minted for **1b, 2, 3a, 4**.

## 6a — Rewrite README + ONBOARDING install docs

**Risk** isolated-refactor · **Worker** background · **Blocked by** 2, 3a, 4
**Files:** `README.md`, `docs/ONBOARDING.md`

Replace the "plugin not built / vendor-copy only" language with real install instructions
(`/plugin marketplace add …` → `/plugin install …`; `npx @formtrieb/flotilla-engine` as the engine),
add a visible **Beta** banner, and keep vendor-copy documented as the fallback path.

```json
{
  "title": "Rewrite README and ONBOARDING with plugin install instructions",
  "filingHint": "install-docs-rewrite",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": ["README.md", "docs/ONBOARDING.md"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "README + ONBOARDING document the plugin install flow and `npx @formtrieb/flotilla-engine` as the primary adoption path", "checked": false },
    { "text": "The 'not built / vendor-copy only' framing is removed; vendor-copy remains documented as a fallback", "checked": false },
    { "text": "A clear Beta banner/status is present", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Turn the onboarding docs from 'future track, not built' into working install instructions for the shipped plugin + package, with vendor-copy demoted to a documented fallback and the beta status made explicit." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversions of the ids minted for **2, 3a, 4**.

## 6b — CHANGELOG + `v0.1.0-beta` tag

**Risk** mechanical · **Worker** background · **Blocked by** 5
**Files:** `CHANGELOG.md`

Add a `CHANGELOG.md` with the `0.1.0-beta` entry. The annotated `v0.1.0-beta` git tag is the
human release action (called out, not automated in the slice).

```json
{
  "title": "Add CHANGELOG and cut the v0.1.0-beta release",
  "filingHint": "changelog-beta-tag",
  "risk": "mechanical",
  "worker": "background",
  "files": ["CHANGELOG.md"],
  "blockedBy": "none",
  "acceptanceCriteria": [
    { "text": "`CHANGELOG.md` exists with a `0.1.0-beta` entry summarizing the plugin + package release", "checked": false },
    { "text": "The `v0.1.0-beta` annotated tag procedure is documented as the human release step", "checked": false }
  ],
  "bodySections": [
    { "heading": "What to build", "markdown": "Close out the beta with a changelog entry and the tag procedure. Writing the changelog is the AFK change; cutting the tag is the gated human release action." }
  ]
}
```
> **Pass 2:** set `blockedBy` to the `parse-ref` inversion of the id minted for **5**.
