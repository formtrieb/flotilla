# to-issues — filing mechanics

The engine-CLI plumbing for publishing slices. The skill body owns the **judgment** (what the slices are, their Risk/Worker/Files); this file owns the **invocation**. Reach for it only once a breakdown is approved and you are filing.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. Your setup pins how it resolves; in-repo that is `npx tsx tools/wave/src/cli.ts`. Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker.

## Commands

| Call | Purpose |
|---|---|
| `issue-store create --input <f.json>` | mint an issue → prints opaque id |
| `issue-store annotate <id> --patch <f.json>` | decorate an existing issue |
| `issue-store read <id>` | dump the `IssueView` (verify round-trip) |
| `issue-store parse-ref <id>` | invert an opaque id → `IssueRef` JSON (for `blockedBy`/`parent`) |
| `dor <path>... ` / `dor --id <id>` | Definition-of-Ready gate; self-content gates run on a path *or* a github id (ADR-0014) |
| `conflict-map <path>...` | file-overlap cells across issues |
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

### Two-pass id resolution

Publish **blockers first** so a dependent's `blockedBy` can name real ids. The skill resolves refs; the store only validates their format.

1. **Pass 1** — create every slice with no intra-batch blocker. Record `plan-local-slug → returned opaque id`.
2. **Pass 2** — for each dependent, turn each captured blocker id into an `IssueRef` and put it in `blockedBy` *before* creating that slice. **Do not parse the id yourself** — ask the engine to invert it:

   ```bash
   {{wave-cli}} issue-store parse-ref <id>   # prints the IssueRef JSON for this store
   ```

   The store that minted the id owns its format, so `parse-ref` returns the right shape (`{ slug, issue }` for markdown, `{ issue }` for github). Use it verbatim. A pre-existing cross-batch blocker is inverted the same way. `blockedBy` is `IssueRef` **objects**, never id strings — the CLI rejects a string ref.

## `decorate` mode — `AnnotatePatch`

For an already-filed, triage-ready issue lacking the Header-Block. Supply **only the missing wave fields** — `risk`, `worker`, `files`, and `parent` if it is a PRD slice. The patch is additive and surgical (omitted fields and unmodeled sections untouched).

```json
{ "risk": "isolated-refactor", "worker": "background", "files": ["src/a.ts", "src/a.spec.ts"], "parent": "412" }
```

```bash
{{wave-cli}} issue-store annotate <id> --patch <patch.json>
```

The target must already carry `Blocked by` (the patch cannot add it). If it has none, it is not actually triage-ready — add it out-of-band first, or treat the issue as a fresh `create`.

## Self-check — `dor` and `conflict-map`

`dor`'s gates split into **three** classes by what each one needs; deferral is **per-gate and capability-conditional** — keyed on what is present in the context, never on which store the issue came from (ADR-0014):

- **Self-content gates** (`header-parseable`, `ac-section`, `risk-file-count`, `ac-files-coverage`) need only the issue's own fields and run **everywhere** — markdown file or github id alike. They prove the slice is grabbable *now*, in the slicing context. Only a self-content **FAIL** blocks.
- **Working-tree gates** (`files-glob`, `literal-files-exist`) need a repo checkout. On the markdown file path the checkout is present, so they **run** (a `literal-files-exist` warn for a not-yet-created file is expected and doesn't block). On a bare github id there is no checkout, so they **defer** — re-run at `wave-create`, where a worktree exists.
- **Cross-issue gate** (`blocked-by-chain`) needs the *other* issues, not a worktree. On markdown it reads the sibling issue files; on a bare github id it **defers** in M1 — resolving it on github needs a store-membership lookup, re-homed onto `IssueStore` in P2a (ADR-0001/0014).

A deferred gate is neither pass nor fail — it shows as `deferred` in the report and never blocks. Only a self-content-gate **FAIL** does.

On a **markdown** store, `create` writes each issue to `<repoRoot>/.scratch/<slug>/issues/<NN>-<filingHint>.md` — pass those paths. On **github**, pass the issue id with `--id` (the non-file entrypoint).

```bash
{{wave-cli}} dor <repoRoot>/.scratch/<slug>/issues/<NN>-*.md ...   # or: dor --id <id>
{{wave-cli}} conflict-map <issue> <issue> ...                      # overlap cells → serialized lanes
```

Report the published list with ids and their Risk/Worker, plus any conflict-map overlap cells.

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
