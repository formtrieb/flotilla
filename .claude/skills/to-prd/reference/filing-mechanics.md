# to-prd — filing mechanics

The engine-CLI plumbing for publishing a PRD. The skill body owns the **judgment** (what the PRD says, its scope); this file owns the **invocation**. Reach for it once the draft is confirmed.

> **The CLI is the source of truth for shapes.** Every command prints its usage with no args and validates its input on each call. The JSON below is a *worked example to scaffold you*, not the schema — if it ever disagrees with the CLI, the CLI wins.

## `{{wave-cli}}` resolution

The wave engine CLI. Your setup pins how it resolves; in-repo that is `npx tsx tools/wave/src/cli.ts`. Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — a PRD becomes a `prd`-labelled issue on GitHub, a `prd.md` on a markdown store.

## Commands

| Call | Purpose |
|---|---|
| `publishDocument --input <f.json>` | publish the PRD → prints the opaque id |
| `readDocument <id>` | verify the round-trip → `{ id, title, body }` |
| any command, no args | usage |

## `PublishDocumentInput`

A PRD is published through the store's **Document facet** — `publishDocument`, *not* `issue-store create`. The input carries only a title, a filing hint, and the PRD sections — **no** Risk/Worker/Files/AC/Header-Block (those belong to the slices `to-issues` derives later):

```json
{
  "title": "PRD: <feature title>",
  "filingHint": "prd-<kebab-key>",
  "bodySections": [
    { "heading": "Problem Statement", "markdown": "..." },
    { "heading": "Solution / Approach", "markdown": "..." },
    { "heading": "User Stories", "markdown": "1. As a ...\n2. As a ..." },
    { "heading": "Implementation Decisions", "markdown": "- ..." },
    { "heading": "Testing Decisions", "markdown": "- ..." },
    { "heading": "Out of Scope", "markdown": "- ..." }
  ]
}
```

`filingHint` is store-internal — never reconstruct the id from it.

## Publish

```bash
{{wave-cli}} publishDocument --input <prd.json>   # prints the opaque PRD id
```

Capture the printed **opaque id** (`<slug>#prd` for markdown, a bare number for GitHub) — never reconstruct one from the title or filingHint.

> If `{{wave-cli}}` resolves to an `npx` invocation and hits `EACCES` on its cache, set `npm_config_cache="$TMPDIR/npm-cache"` before the command.

## Verify round-trip

```bash
{{wave-cli}} readDocument <id>
```

A clean read with the section headings present (`## Problem Statement`, …) confirms the PRD published correctly. Then hand off: report the id + title and point the user at `to-issues` to slice it.
