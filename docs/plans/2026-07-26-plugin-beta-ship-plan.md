# Ship plan — flotilla `v0.1.0-beta` as a Claude Code plugin

**Status:** proposed · **Date:** 2026-07-26 · **Target:** first public beta + announcement

This is the scoping/checklist doc for turning flotilla from a *vendor-copy-only* toolkit
into an **installable Claude Code plugin**, shippable as a public beta. It is deliberately
concrete: each workstream below is sized to be an independently-grabbable issue with a
declared file scope, so the whole plan can be dogfooded as a flotilla wave.

## Locked decisions

- **Engine ships as an npm package** — `@formtrieb/flotilla-engine`, and `{{wave-cli}}` resolves
  to `npx @formtrieb/flotilla-engine <subcommand>` (chosen over bundling the engine inside the
  plugin dir). Rationale: `npx` resolves the engine's runtime deps (`fast-glob`,
  `micromatch`, `tsx`) itself, so the plugin sidesteps both the `${CLAUDE_PLUGIN_ROOT}`
  path-pinning *and* the "a plugin install runs no `npm install`" bootstrap problem. The
  engine stays fully decoupled from the plugin install dir.
- **Beta scope, not 1.0** — one shipped tracker adapter proven live (GitHub Issues), the
  plugin installable from this repo as its own marketplace, docs updated. Polish and the
  standalone `flotilla` CLI are explicit non-goals (below).

## Where we already are (the good news)

Most of the work is done; what remains is almost entirely *packaging*, not engineering.

- **Engine** (`tools/wave/`): **1800 tests green, `tsc --noEmit` clean.** Conflict-map,
  merge-order, DoR, resume, host-pr, coarse projection, and three store adapters
  (Markdown-FS, GitHub, Linear) over one conformance suite.
- **13 skills** fully authored (`triage`, `to-prd`, `to-issues`, `wave-setup`, `wave-plan`,
  `wave-create`, `wave-start`, `wave-reviewer`, `wave-close`, `wave-resume`, `wave-shared`)
  plus the `wave-reviewer` agent.
- **Docs**: 26 ADRs, CHARTER, CONTEXT, PROVENANCE, 27 retros, Apache-2.0, CI with required
  status checks on `main`.

The ONBOARDING doc and `.claude/skills/README.md` already name "npm CLI" and "Claude-Code
plugin" as *future tracks, not built* — this plan builds the plugin track.

---

## Workstream 1 — Engine → publishable npm package `@formtrieb/flotilla-engine`

**Why first:** everything else references the resolved CLI. Critical path.

**Entrypoint unification (the real work).** The skills do *not* reach the engine only through
the `cli.ts` router. Direct module invocations exist that the npm `bin` must also cover:

| Direct invocation in skills | Count | Router has it? |
|---|---|---|
| `cli-store.ts preflight` (store-preflight) | 3× | no — separate module by design |
| `resume-cli.ts` (resume reconcile) | 6× | **no `resume` case in `cli.ts`** |
| `spine-cli.ts` | 1× | router *has* a `spine` case (redundant path) |

Decision for the package: **fold the direct-invoked modules in as router subcommands**
(`store-preflight`, `resume`) so the entire surface is `npx @formtrieb/flotilla-engine <sub>` —
consistent with the existing `{{wave-cli}} <sub>` idiom. Alternative (multiple `bin`s) is
rejected as less uniform.

**Tasks**
- [ ] Add router subcommands delegating to `cli-store.ts` (preflight) and `resume-cli.ts`;
      collapse the redundant `spine` path. Keep `skill-schema-drift.spec.ts` + the CLI specs
      green.
- [ ] `package.json`: drop `private: true`; set `version: 0.1.0-beta.0`; add `bin`
      (a shim invoking `tsx` on `cli.ts` — preserves the charter's *no build step*),
      `files` whitelist, `publishConfig.access: public`, `license`, `repository`,
      `engines.node`.
- [ ] Move `tsx` from `devDependencies` → `dependencies` (raw-TS runtime needs it).
- [ ] Prove `npx @formtrieb/flotilla-engine dor …` runs from a clean temp dir (npx cold-installs).
- [x] **Publish — route settled, and it is not a token.** The scope is `@formtrieb`, already
      owned by the intended account and already carrying published packages, so the original
      "confirm availability" blocker is closed. Publishing goes through **npm trusted
      publishing**: the registry mints a short-lived credential for a workflow it has been
      told to trust, so no long-lived `NPM_TOKEN` exists to leak or rotate, and provenance is
      attached automatically for a public repo publishing a public package. The remaining
      human action is registry-side configuration, not a secret handed to CI.

**Files:** `tools/wave/package.json`, `tools/wave/src/cli.ts`, new `tools/wave/bin/*`,
maybe `tools/wave/src/{cli-store,resume-cli,spine-cli}.ts`.
**Risk:** medium (touches the router that every skill shells into).

## Workstream 2 — Pin `{{wave-cli}}` resolution to the package

The 21 files using the `{{wave-cli}}` *placeholder* do **not** change — only its *resolution
definition* and the handful of direct-module invocations do.

**Tasks**
- [ ] Update the resolution definition (`.claude/skills/README.md`,
      `.claude/skills/wave-setup/reference/setup-mechanics.md`) from
      `npx tsx tools/wave/src/cli.ts` → `npx @formtrieb/flotilla-engine`.
- [ ] Rewrite the direct `npx tsx tools/wave/src/{cli-store,resume-cli}.ts` invocations in
      the setup/resume mechanics to the new subcommand form.
- [ ] Update the tracked permission allowlist in `.claude/settings.json` **and** the
      allowlist `wave-setup` scaffolds — from the `tools/wave/src/cli.ts` forms to
      `npx @formtrieb/flotilla-engine`. (Per the plugin spec, allowlists cannot live in the
      plugin manifest — this stays a consumer-side `wave-setup` concern, which it already is.)

**Files:** `.claude/skills/README.md`, `.claude/skills/wave-setup/reference/setup-mechanics.md`,
`.claude/skills/wave-resume/reference/resume-mechanics.md`, `.claude/settings.json`.
**Risk:** low-medium (mechanical, but AFK agents stall if an allowlist entry is wrong).

## Workstream 3 — Plugin manifest + layout

**Tasks**
- [ ] Add `.claude-plugin/plugin.json`: `name: flotilla`, `version`, `description`, `author`,
      `homepage`, `license`, `keywords`. Point the manifest at the *existing* dirs so
      dogfooding isn't disturbed: `"skills": ["./.claude/skills"]` (the `skills` field
      **adds** to the default `skills/`), `"agents": ["./.claude/agents"]`.
- [ ] Namespacing fallout: cross-skill name references (`wave-shared`, loaded by name) become
      `/flotilla:wave-shared` once packaged (ADR-0018 already anticipated this). Audit and
      update by-name references across the skills.
- [ ] Validate `claude plugin validate --strict`.
- [ ] **Empirically confirm** the plugin (pointing at `./.claude/skills`) and flotilla's own
      project-level `.claude/skills` don't double-register/conflict when developing in this
      same repo. If they do, decide: move skills to a root `skills/` and have the repo consume
      its own plugin.

**Files:** new `.claude-plugin/plugin.json`, by-name refs in `.claude/skills/**`.
**Risk:** medium (the double-registration question is unproven until tested).

## Workstream 4 — Marketplace (repo is its own marketplace)

**Tasks**
- [ ] Add `.claude-plugin/marketplace.json`: `name`, `owner`, one plugin entry
      `{ name: "flotilla", source: "./" }` (a repo can be both marketplace and the plugin it
      lists via a `./` source).
- [ ] Smoke-test the install flow in a scratch session:
      `/plugin marketplace add formtrieb/flotilla` → `/plugin install flotilla@<marketplace>`.

**Files:** new `.claude-plugin/marketplace.json`.
**Risk:** low.

## Workstream 5 — Live GitHub-Issues gate wave

CHARTER names exactly this as the planned live proof: one real wave end-to-end on the public
repo, GitHub-Issues store, driven through the installed plugin + published engine. GitHub
Issues is simultaneously the least live-proven adapter and the primary OSS onboarding path.

**Tasks**
- [ ] Author a small real wave of ≥2 issues on `formtrieb/flotilla`, run
      `wave-setup → plan → create → start → close` via the plugin, land the PRs.
- [ ] Capture it as a retro (`docs/retros/`) — doubles as the LinkedIn narrative ("flotilla's
      own plugin packaging shipped as a flotilla wave").

**Risk:** medium (first live GitHub-adapter exercise; may surface adapter gaps).

## Workstream 6 — Release hygiene + docs

**Tasks**
- [ ] `CHANGELOG.md` + annotated `v0.1.0-beta` tag.
- [ ] Rewrite the "not built / vendor-copy only" sections of `README.md` and
      `docs/ONBOARDING.md` into real install instructions; add a visible **Beta** banner.
      Keep vendor-copy documented as the fallback path.

**Files:** `README.md`, `docs/ONBOARDING.md`, new `CHANGELOG.md`.
**Risk:** low.

---

## Sequencing

```
W1 (engine pkg) ──▶ W2 (resolution + allowlist)  ── critical path, land together
W3 (manifest) ──┐
W4 (marketplace) ┴─ independent of W1/W2, can run in parallel
        └────────▶ W5 (live gate) ── needs W1–W4 all landed
                            └──────▶ W6 (release + docs) ── last
```

W1+W2 and W3+W4 touch **disjoint file scopes** → they are a clean two-wave (or four-row)
flotilla batch. Dogfooding the packaging through flotilla itself is both the fastest path and
the best possible launch story.

## Non-goals for the beta (say so out loud)

- **Standalone `flotilla` CLI** (`npx flotilla …`) — the engine package is enough; the
  separate CLI stays a post-beta track.
- **Linear live-gate** — Linear is already the more-proven dogfood adapter; GitHub is the OSS
  path we prove now.
- **Bundling the engine in the plugin / `${CLAUDE_PLUGIN_ROOT}` wiring** — explicitly not the
  chosen route.
- **Hooks / MCP servers in the plugin** — not needed for the skill-driven flow.

## Open questions / external blockers

1. ~~**npm `@flotilla` scope** — available/claimable?~~ **Resolved, and the answer changed the
   name.** The package is `@formtrieb/flotilla-engine`: `formtrieb` is the owner in every
   namespace (npm scope, plugin marketplace, GitHub org) and `flotilla` is the product in every
   namespace. The old spelling made `flotilla` the *scope* — i.e. the owner — while the same
   word means the *product* on the plugin side; one term, two meanings. The scope is owned
   already, five public packages sit under it, and the `<product>-<part>` shape of their names
   is what `flotilla-engine` follows. Unscoped `flotilla` is taken on npm by someone else,
   which is a second reason the old scope was the wrong bet.
2. **Plugin ↔ project-skills double-registration** in the self-dogfooding repo (W3) — resolve
   empirically before committing the manifest layout.
3. **Marketplace name** — pick the identifier users type in `flotilla@<name>` (e.g.
   `flotilla` vs `formtrieb`).

## Rough size

~1–2 focused days of work; no architectural change. The critical path is
**W1 → W2 → install once → run one real wave.**
