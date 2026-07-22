# wave-plan — plan mechanics

The engine-CLI plumbing for drawing candidates and running the cross-wave check. The skill body owns the **judgment** (which candidates to propose, how to read the overlap report); this file owns the **invocation** and exact shapes. Reach for it once you are ready to run the engine.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. Your setup pins how it resolves; in-repo that is `npx tsx tools/wave/src/cli.ts`. Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker. Place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

## Commands

| Call | Purpose |
|---|---|
| `issue-store listOpen` | draw the wave-eligible candidate set (`IssueView[]`) |
| `issue-store listClaimed` | draw all currently claimed issues — `queued` + `in-flight` (`IssueView[]`) |
| `issue-store listDocuments` | draw the PRD panel (`DocumentView[]`) |
| `cross-wave --candidates <f.json> --claimed <f.json> --repo-root <dir>` | cross-wave parallel-safety check (`CrossWaveResult`) |

`cross-wave` is wave-plan's overlap path (it unions candidates and claims). The standalone `conflict-map` CLI is a different, narrower tool — if you ever reach for it on a github/linear roster for a quick overlap check, it is **not** path-only: `conflict-map --id <id> [--id <id> ...] [--repo-root <dir>] [--config <path>]` is the store-backed (non-file) entrypoint that reads each id's `Files` from the `IssueStore`, so a bare store id no longer forces exporting paths or hand-rolling a tsx one-off (bare `conflict-map <path>...` stays the file form).

## Exact sequence

```bash
T=$(mktemp -d)

# 1. Draw candidates (eligibility OR-set is config-driven; no eligibility arg)
{{wave-cli}} issue-store listOpen    > "$T/candidates.json"   # IssueView[]

# 2. Draw current claims (queued + in-flight across all waves)
{{wave-cli}} issue-store listClaimed > "$T/claimed.json"      # IssueView[]

# 3. Cross-wave check
{{wave-cli}} cross-wave \
  --candidates "$T/candidates.json" \
  --claimed    "$T/claimed.json" \
  --repo-root  "$REPO"                                        # CrossWaveResult

# 4. PRD panel
{{wave-cli}} issue-store listDocuments                        # DocumentView[]
```

`$REPO` is the consumer repo root (the dir containing `wave.config.json`). **Always pass `--repo-root` explicitly** (FOR-38) — a live finding showed the same candidate roster produce 17 conflict cells without it vs. 40 with it, purely from glob `Files` patterns that silently failed to expand. Omitting it does not fall back to `process.cwd()` (that silent-guess behavior was the bug); it instead degrades glob comparison to exact-pattern-text matching and returns a `warnings` array naming every unexpanded pattern — treat any non-empty `warnings` as a sign the report is incomplete, not as a clean parallel-safe read.

## `IssueView` is a valid `ScopedIssue[]` input

`cross-wave` accepts `ScopedIssue[]` (`{id, files}`) for its `--candidates` and `--claimed` files. `IssueView` is a structural superset of `ScopedIssue` — extra fields (`risk`, `worker`, `status`, …) are ignored. The `listOpen` and `listClaimed` JSON arrays are therefore valid `--candidates`/`--claimed` inputs verbatim; no transformation is needed.

## Output is canonical and deduplicated — compare directly

`cross-wave` combines `--candidates` and `--claimed` as a **set union keyed by id**, not a concatenation. An issue that appears in both files (legitimate — e.g. it is already queued from a prior plan, or you are re-running the check for a wave whose own rows are soft-claimed) contributes exactly one entry to the underlying conflict computation. The result: every cell in **both** `intraWaveConflicts` and `crossWaveConflicts` has `a < b` (canonical lexicographic order) and each unordered pair appears **exactly once** — no repeats to mentally collapse, even when `candidates` and `claimed` fully overlap. Compare the arrays directly against the spine's `## Conflict-Map` or against each other; no de-duplication step is needed on the consumer side.

## Worked `CrossWaveResult` sample

```json
{
  "parallelSafe": false,
  "crossWaveConflicts": [
    {
      "a": "101",
      "b": "55",
      "files": ["src/adapters/github/github-issues-store.ts"]
    }
  ],
  "intraWaveConflicts": [
    {
      "a": "101",
      "b": "104",
      "files": ["src/contract.ts", "src/contract.spec.ts"]
    }
  ]
}
```

**How to read it:**

- `parallelSafe: false` — there is at least one candidate that overlaps a currently-claimed issue in another wave. This is the launch-gate signal for `wave-create`: when `parallelSafe === false`, running this proposed wave in parallel with the currently-claimed set would cause background workers to race the overlapping files.
- `crossWaveConflicts` — each cell pairs a candidate with an already-claimed issue from another wave that overlap at the listed `files`. The two ids `a`/`b` are bare id strings in canonical lexicographic order (either side may be the candidate; `cell.files` is the overlap). These are the cross-wave races; the coordinator must decide whether to serialize (wait for the other wave to finish) or accept an explicit mitigation. There is no silent override: `wave-create` will re-check and default to abort when `parallelSafe === false`.
- `intraWaveConflicts` — each cell is two candidates within the proposed wave that overlap. They are not a launch-gate concern but they must be sequenced: the coordinator should plan which of the two ships first. Record them in the wave's conflict-map (rendered into the spine by `wave-create`).
- `warnings` (present only when non-empty, FOR-38) — one entry per glob `Files` pattern that could not be expanded because `--repo-root` was missing, naming the issue id and the exact pattern text. This should never happen when you pass `--repo-root` per the sequence above; if you see it, the report is incomplete — do not treat a clean `parallelSafe: true` alongside a non-empty `warnings` as a real all-clear.

When `parallelSafe: true` (no `crossWaveConflicts`) **and no `warnings`**, the proposed candidates can run alongside currently-claimed work without file races. `parallelSafe: true` with a non-empty `warnings` means "no conflict found among what could be checked" — not "no conflicts exist".

## PRD consumed-flag derivation

A PRD is **consumed** iff at least one candidate's `parent` field equals the PRD id (exact string match, no normalization). The `parent` field on `IssueView` is the opaque PRD id the slice was filed with — the same value `to-issues` stored as the `Parent` backlink (ADR-0013). Derivation from the already-loaded candidates array:

```
consumed(prd) = candidates.some(c => c.parent === prd.id)
```

An un-consumed PRD has no slices yet. Flag it: "run `to-issues` to slice". A PRD is never in `candidates` — the Document facet and the issue facet are separate, and a PRD carries no eligibility marker.

## Public-API-change pairing derivation (KW-F4)

The public-API-change pairing advisory (SKILL step 3b) is derived **skill-side** from the candidate `risk` fields already loaded by `listOpen` — there is no engine call and nothing is persisted (wave-plan writes nothing). The file-overlap check cannot see it: two rows that each change a global contract can force landing rework with **disjoint `Files`**, the semantic cross-suite conflict the file map is blind to (it broke 27 test assertions on the first Linear consumer wave, past a green conflict-map — both rows were `public-API-change`).

```
apiChangers = candidates.filter(c => c.risk === 'public-API-change')
// two or more → surface the whole set as ONE advisory pairing
```

When `apiChangers` has **two or more** members, surface them as an advisory pairing — the same human-decided, never-auto-excluded treatment `intraWaveBlockedByPairs` get downstream (wave-create). The advisory: each row changes a global contract, so expect reconciled-merge landing rework even though the `Files` are disjoint; plan the wave-close reconciled-merge verify, and consider serializing the pair or splitting it across waves. The coordinator decides; wave-plan only raises it.

## Exit codes for `cross-wave`

| Code | Meaning |
|---|---|
| `0` | success (result on stdout) |
| `1` | domain failure (`crossWaveCheck` threw) |
| `2` | usage error (missing `--candidates`/`--claimed`) **or** an unreadable/malformed input JSON file |

Exit 0 does **not** mean parallel-safe — it means the command ran and produced a result. Read `parallelSafe` in the JSON. A non-empty `warnings` array is also non-fatal (still exit `0`) — the CLI echoes it to stderr as well as including it in the stdout JSON, since it means the result is degraded, not wrong to trust as "checked".
