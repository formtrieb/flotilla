# to-issues — filing mechanics

The engine-CLI plumbing for publishing slices. The skill body owns the **judgment** (what the slices are, their Risk/Worker/Files); this file owns the **invocation**. Reach for it only once a breakdown is approved and you are filing.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker.

## Commands

| Call | Purpose |
|---|---|
| `issue-store create --input <f.json>` | mint an issue → prints opaque id |
| `issue-store annotate <id> --patch <f.json>` | decorate an existing issue |
| `issue-store read <id>` | dump the `IssueView` (verify round-trip) |
| `issue-store parse-ref <id>` | invert an opaque id → `IssueRef` JSON (for `blockedBy`/`parent`) |
| `dor <path>... --config <path>` / `dor --id <id> --config <path>` | Definition-of-Ready gate; self-content gates run on a path *or* a github id (ADR-0014); `--config` is what lets Gate 8 (`verify-profile-coverage`) resolve against the consumer's `verify` profiles instead of deferring |
| `conflict-map <path>...` / `conflict-map --id <id> [--id <id> ...]` | file-overlap cells across issues; `--id` is the store-backed (non-file) form — reads each id's `Files` from the `IssueStore` (ADR-0014) |
| any command, no args | usage |

## `create` mode — `CreateInput`

One JSON per slice. The store assigns each an **opaque id** (`<slug>#NN` for markdown, `"412"` for GitHub) — capture the printed id; never reconstruct one from the title or filingHint.

```json
{
  "title": "Human H1 title",
  "filingHint": "kebab-key",
  "risk": "isolated-refactor",
  "worker": "background",
  "files": ["src/foo.ts", "src/foo.spec.ts"],
  "blockedBy": "none",
  "parent": "412",
  "acceptanceCriteria": [{ "text": "...", "checked": false }],
  "bodySections": [{ "heading": "What to build", "markdown": "..." }]
}
```

`parent` is the source PRD's opaque id **string** (verbatim from `publishDocument`), not an `IssueRef` — include it only when these slices came from a PRD; drop the line otherwise. `## What to build` is a `bodySections` entry; each AC bullet is an `acceptanceCriteria` `{ text, checked: false }`. Optional `estimatedWallclock` / `unblocks` — only if offered.

```bash
{{wave-cli}} issue-store create --input <slice.json>   # prints the opaque id
```

### Bare create — the undecorated filing path (ADR-0027)

The wave Header-Block fields (`risk`, `worker`, `files`, `blockedBy`, `acceptanceCriteria`) are optional **as a group**: supply all five for the normal slicing path above, or **none of them** to file a **bare** issue — title + `filingHint` + `bodySections` only:

```json
{
  "title": "Gate 8 ships inert",
  "filingHint": "gate-8-ships-inert",
  "bodySections": [
    { "heading": "Gap", "markdown": "the verify config is never threaded through." },
    { "heading": "Provenance", "markdown": "wave hardening, row 3, iteration 1." }
  ]
}
```

This is the vehicle behind an ADR-0027 Disclosure's `filed:<id>` disposition — existence now, wave-readiness later via `decorate` mode below.

**Fail-loud rules** (the CLI validates the input as a whole before any write, so a rejected input files nothing):

- A **half-written Header-Block** — some of the five fields present, some not — is a usage error (exit 2), naming the missing fields. An absent Header-Block and a broken one are different claims; only the first is a bare issue.
- A bare input (no Header-Block) that still carries a **decoration-only stowaway** — `unblocks`, `parent`, or `estimatedWallclock` — is rejected the same way: those fields only make sense alongside a Header-Block.

A bare issue is **not wave-eligible until decorated**: `create` stamps no eligibility marker and no `risk/*`/`worker/*` label for it, so it never shows up in the wave-ready pool on its own. Decorate it via `annotate` (below) when it is ready to be sliced into a wave.

### Two-pass id resolution

Publish **blockers first** so a dependent's `blockedBy` can name real ids. The skill resolves refs; the store only validates their format.

1. **Pass 1** — create every slice with no intra-batch blocker. Record `plan-local-slug → returned opaque id`.
2. **Pass 2** — for each dependent, turn each captured blocker id into an `IssueRef` and put it in `blockedBy` *before* creating that slice. **Do not parse the id yourself** — ask the engine to invert it:

   ```bash
   {{wave-cli}} issue-store parse-ref <id>   # prints the IssueRef JSON for this store
   ```

   The store that minted the id owns its format, so `parse-ref` returns the right shape (`{ slug, issue }` for markdown, `{ issue }` for github). Use it verbatim. A pre-existing cross-batch blocker is inverted the same way. `blockedBy` is `IssueRef` **objects**, never id strings — the CLI rejects a string ref.

## `decorate` mode — `AnnotatePatch`

For an already-filed issue lacking the Header-Block — a triage-ready issue, **or a bare issue** from the `create` path above. Supply **only the missing wave fields**: `risk`, `worker`, `files`, `parent` (if it is a PRD slice), and — on the bare-to-decorated path specifically — `acceptanceCriteria` (a bare issue has no AC section to begin with) and any additional `bodySections` prose the decorate step wants to add. The patch is additive and surgical (omitted fields and unmodeled sections untouched); `files` and `acceptanceCriteria` each *replace* the modeled section when supplied, `bodySections` are appended verbatim.

```json
{
  "risk": "isolated-refactor",
  "worker": "background",
  "files": ["src/a.ts", "src/a.spec.ts"],
  "acceptanceCriteria": [{ "text": "the gap is closed", "checked": false }],
  "parent": "412"
}
```

```bash
{{wave-cli}} issue-store annotate <id> --patch <patch.json>
```

`blockedBy` is deliberately **not** part of `AnnotatePatch` — dependency structure is out-of-band. What that means for a target's `Blocked by` depends on the store, and it is *not* a "must already carry it" requirement:

- **GitHub / Linear** — `Blocked by` is a `##` body section; an **absent** one reads as `none` (no blockers) on read, the same as an explicit `none`. A bare issue decorated via `annotate` (risk/worker/files/acceptanceCriteria) becomes a fully readable, DoR-checkable `IssueView` with `blockedBy: 'none'` — no out-of-band step needed just to make it readable.
- **MarkdownFs** — `Blocked by` is a required `**Blocked by:**` header line, not a section with an absence-means-none default; the header parser rejects a read while it is missing. Since `annotate` cannot write it, a bare MarkdownFs issue stays unreadable after decorate until that line is added out-of-band (or the issue is filed decorated via `create` in the first place).

Either way, decorating an issue does not by itself grant wave-eligibility (the eligibility marker/label is a separate, consumer-owned step) — decorate makes the issue *readable and DoR-checkable*, eligibility is what a wave-planning step stamps on top.

### Verify the write

`annotate` is one of the nine mutating `issue-store` ops that answer success with **empty stdout** by design (#648) — the exit code is the whole signal at the call site, and on its own it says only "the write did not throw," never "the header now reads the way you meant it to." Read the header back before trusting it landed:

```bash
{{wave-cli}} issue-store read <id>                                             # IssueView
{{wave-cli}} dor --id <id> --config <path-to-wave.config.json>                 # DoR gates
```

`read`'s `IssueView` is what proves the patched fields actually landed on the tracker — `risk`/`worker`/`files`/`acceptanceCriteria` reading back exactly as supplied (and, on GitHub/Linear, `blockedBy` reading `'none'` rather than throwing, per the store note above). `dor --id` is what proves the header is now *usable*, not merely present — a header-parseable, AC-complete row the self-content gates pass, rather than a write that landed syntactically but still leaves a gate failing. Never pipe the `annotate` call through another command before checking its exit code — a pipeline reports only the last command's status, so a non-zero `annotate` can hide behind a zero downstream command.

## GitHub blockedBy-mirror operating envelope (github consumers only)

Every `create` or `decorate` call that carries a non-empty `blockedBy` on a **github**-store consumer also mirrors those refs into GitHub's native issue-dependencies API (`GithubIssuesStore.mirrorBlockedBy`, `tools/wave/src/adapters/github/github-issues-store.ts`) — best-effort, additive-only, and orthogonal to the authoritative body-codec write. That mirror costs **one `addBlockedBy` POST per unmirrored ref**, in addition to the one `getBlockedBy` GET the mirror always pays to check what is already native — the same per-call cost the Linear adapter pays for its own mirror.

**Read this before a bulk `create`/`decorate` pass** (many slices, each with fresh `blockedBy` refs, filed in a tight loop): GitHub enforces its own **secondary rate limits** on top of the primary per-hour quota — a content-creation ceiling (no more than 80 content-generating requests/minute or 500/hour) and a points budget (`POST`/`PATCH`/`PUT`/`DELETE` cost 5 points vs. 1 for `GET`, capped at 900 points/minute) — and advises spacing mutating calls at least a second apart (docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api and .../best-practices-for-using-the-rest-api). A wide batch of blocked issues filed back-to-back can walk into that envelope.

**This is deliberately not throttled** (triage decision: name the caveat, do not build throttle/backoff/retry machinery for it) — and that is safe to file against, not just a known gap: a rate-limited or otherwise refused mirror POST is swallowed per-ref, never fails the `create`/`annotate` call, and never fails `dor`. The authoritative body-codec `## Blocked by` section — the one every gate actually reads — already landed. The native mirror is a redundant, human-visible extra; `read()` unions codec ∪ native so a stalled mirror is invisible to the DoR gate, and the **next** `create`/`annotate` on that issue re-attempts whatever this pass left unmirrored. Degradation is harmless, not silent-and-wrong. Nothing in this skill needs to slow down or retry around it — just don't mistake "the dependency isn't native yet" for "the dependency didn't file."

## Self-check — `dor` and `conflict-map`

`dor`'s gates split into **three** classes by what each one needs; deferral is **per-gate and capability-conditional** — keyed on what is present in the context, never on which store the issue came from (ADR-0014):

- **Self-content gates** (`header-parseable`, `ac-section`, `risk-file-count`, `ac-files-coverage`) need only the issue's own fields and run **everywhere** — markdown file or github id alike. They prove the slice is grabbable *now*, in the slicing context. Only a self-content **FAIL** blocks.
- **Working-tree gates** (`files-glob`, `literal-files-exist`) need a repo checkout. On the markdown file path the checkout is present, so they **run** (a `literal-files-exist` warn for a not-yet-created file is expected and doesn't block). On a bare github id there is no checkout, so they **defer** — re-run at `wave-create`, where a worktree exists.
- **Cross-issue gate** (`blocked-by-chain`) needs the *other* issues, not a worktree. On markdown it reads the sibling issue files; on a bare github id it **defers** in M1 — resolving it on github needs a store-membership lookup, re-homed onto `IssueStore` in P2a (ADR-0001/0014).
- **`verify-profile-coverage` (Gate 8, advisory)** needs the consumer's `wave.config.json` `verify` block, which `dor` only ever sees when **this call** names `--config` explicitly — unlike `issue-store`/`conflict-map`, it does not fall back to a `wave.config.json` in the working directory. Two states share the same `deferred` status text but are not the same fact: **genuinely absent** — no `--config` reached this call, so the gate never had a `verify` block to weigh at all, and the defer says nothing about the row's coverage — versus **resolvable** — `--config` was passed and `verify.profiles` were actually weighed: an empty profile list `pass`es silently, a non-empty one with no `--repo-root` (the triage-time norm on a bare id, same as the working-tree gates above) legitimately **defers** pending `wave-create`'s checkout, and only a real repo root with non-empty profiles yields a concrete `pass`/`warn`. Pass `--config` as shown below so a triage-time check lands in the resolvable state rather than the genuinely-absent one.

A deferred gate is neither pass nor fail — it shows as `deferred` in the report and never blocks. Only a self-content-gate **FAIL** does.

On a **markdown** store, `create` writes each issue to `<repoRoot>/.scratch/<slug>/issues/<NN>-<filingHint>.md` — pass those paths. On **github** (and any other store-backed tracker, e.g. `linear`), pass the issue id with `--id` (the non-file entrypoint) — **both** `dor` and `conflict-map` take it, so a store-backed batch never needs a path export or a tsx one-off. Thread `--config <path-to-wave.config.json>` on every `dor` call regardless of form (per Gate 8 above):

```bash
{{wave-cli}} dor <repoRoot>/.scratch/<slug>/issues/<NN>-*.md --config <repoRoot>/wave.config.json ...  # path form
{{wave-cli}} dor --id <id> --config <repoRoot>/wave.config.json                                        # store-backed form
{{wave-cli}} conflict-map <issue> <issue> ...                      # file form: overlap cells → serialized lanes
{{wave-cli}} conflict-map --id <id> --id <id> [--repo-root <dir>]  # store-backed form: same cells, reads Files from the IssueStore
```

Report the published list with ids and their Risk/Worker, plus any conflict-map overlap cells; name any `verify-profile-coverage` `warn` explicitly, same as the working-tree/cross-issue defers above.

## Header-Block fields

| Field | Key | Required | Shape |
|---|---|---|---|
| Risk | `risk` | yes | one vocab value (config / `DEFAULT_WAVE_SCHEMA`) |
| Worker | `worker` | yes | one vocab value, autonomy-first/brand-free (routed from Risk) |
| Files | `files` | yes | `string[]` globs/paths + co-located specs |
| Blocked by | `blockedBy` | yes | `"none"` or `IssueRef[]` = `{slug?, issue}` — on the wire: `FOR#23` (see below) |
| Parent | `parent` | when from a PRD | the PRD's opaque id **string** (not an `IssueRef`) |
| Est. wallclock | `estimatedWallclock` | no | free string, only if offered |
| Unblocks | `unblocks` | no | `IssueRef[]`, only if non-obvious |

### Canonical ref spelling — `<slug>#<issue>`, never `<slug>-<issue>`

When a `Blocked by` / `Unblocks` value is written into an issue **body** (the GitHub / Linear `## Blocked by` section), the engine renders each `IssueRef` as **`<slug>#<issue>`** — e.g. `FOR#23`, or the slug-less `#23` for a same-store ref. It is **NOT** `FOR-23`: that is the human-readable tracker identifier, not the codec's wire form.

This matters if you ever hand-author or API-write a body instead of going through `issue-store create`. The codec is **fail-loud** (FOR-31): a `## Blocked by` section that is non-empty, is not `none`, and contains no parseable `<slug>#NN` / `#NN` ref is **rejected** — `read()` throws and `dor` refuses the row. It will not quietly decode to `none`. A `FOR-23` written where `FOR#23` was meant is exactly the token that gets rejected, so a real dependency can never be silently read as absent.

**Do not spell the wire form by hand.** `issue-store parse-ref <id>` is the engine's own inversion (`FOR-23` → `{ "slug": "FOR", "issue": 23 }`, rendered as `FOR#23`) and the only sanctioned way to derive it — the store that minted the id owns its format.
