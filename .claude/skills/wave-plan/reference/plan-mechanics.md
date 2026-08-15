# wave-plan — plan mechanics

The engine-CLI plumbing for drawing candidates and running the cross-wave check. The skill body owns the **judgment** (which candidates to propose, how to read the overlap report); this file owns the **invocation** and exact shapes. Reach for it once you are ready to run the engine.

> **The CLI is the source of truth for shapes.** Every command prints its usage when run with no args, and validates its input on every call. The JSON below are *worked examples to scaffold you*, not the schema — if one ever disagrees with the CLI, the CLI wins. Don't re-derive validation the engine already does; trust its error and fix the input.

## `{{wave-cli}}` resolution

The wave engine CLI. **The binding rule (ADR-0032): `{{wave-cli}}` IS the command string this repo's `wave.config.json` names under `engine.cli`** — read there, resolved host-side when an invocation is composed, and never re-derived here. There is one command string per repo and no invocation-form ordering to weigh: a configured binding that fails is a STOP/needs-attention finding — a broken install, config or release — not a cue to reach for another spelling. An **absent** `engine.cli` is a STOP too: it means `wave-setup` has not finished in this repo, so stop and finish setup before running anything here.

Every command needs the store config: run from a dir containing `wave.config.json`, or append `--config <path>`. The store (`markdown` or `github`) is selected there — you never name a tracker. Place `--config` **after** the subcommand and its op (e.g. `issue-store create --input f.json --config c.json`), never before the subcommand.

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
# SESSION = an operator-chosen tag for this planning pass — e.g. today's date
#           ("2026-08-01") or the working wave slug if one is already forming.
#           Retype it in every call below, the same operator-held-constant way
#           $REPO is retyped; pick a value distinct from any other planning
#           pass you might have running at the same time.

# A LITERAL scratch dir, deliberately NOT `T=$(mktemp -d)` — see the note below.
# `-m 700` makes it owner-only (mktemp -d's own default), and the `$SESSION`
# suffix scopes it so two planning passes running at once don't share one
# directory — see the note below.
mkdir -p -m 700 "/tmp/flotilla-plan-$SESSION"

# 1. Draw candidates (eligibility OR-set is config-driven; no eligibility arg)
{{wave-cli}} issue-store listOpen    > "/tmp/flotilla-plan-$SESSION/candidates.json"   # IssueView[]

# 2. Draw current claims (queued + in-flight across all waves)
{{wave-cli}} issue-store listClaimed > "/tmp/flotilla-plan-$SESSION/claimed.json"      # IssueView[]

# 3. Cross-wave check
{{wave-cli}} cross-wave \
  --candidates "/tmp/flotilla-plan-$SESSION/candidates.json" \
  --claimed    "/tmp/flotilla-plan-$SESSION/claimed.json" \
  --repo-root  "$REPO"                                        # CrossWaveResult

# 4. PRD panel
{{wave-cli}} issue-store listDocuments                        # DocumentView[]
```

**Why the scratch path is written out rather than captured (Convention 12, Form 1).** This sequence used to open with `T=$(mktemp -d)` and then name `"$T/…"` in steps 1–3. That capture is in the **guarded** class, not the legitimate-empty one: `mktemp -d` either creates a directory and prints its path or it fails, so an empty `T` never means "no temp dir was needed" — it means the command did not run. And the consequence is worse than a silent skip, because `> "$T/candidates.json"` with `T` unset is `> "/candidates.json"`: a **write at the filesystem root**, attempted twice.

Guarding it inline would not have been enough either, because the value is consumed across *several* steps and shell state does not survive from one Bash call to the next — `T` is unset in the shell that runs step 2 whether or not step 0 checked it. So this site takes the convention's **preferred** form: it does not guard the capture, it **removes** it. A literal path is retypeable in every call, needs nothing to survive a boundary, and has no empty state to check.

`$REPO` and `$SESSION` stay variables because they are **operator-held constants** — values you already know and can retype in each call — which is the opposite of a `mktemp` output that only ever existed in one shell's memory. That distinction, not the `$` sigil, is what the convention is about.

The dir is fixed per `$SESSION` rather than globally, so **re-running this sequence within the same planning pass** overwrites both files; each `>` rewrites its file wholesale, so a re-run within one pass is always self-consistent. Scoping by `$SESSION` is what bounds that overwrite to one pass: two planning passes running at once, given distinct `$SESSION` values, land in distinct directories and never share a write — matching how the create-pass and dispatch-pass scratch dirs are already scoped by `$SLUG`. `-m 700` restores the mode `mktemp -d` gave (owner-only, `drwx------`) — plain `mkdir -p` defaults to `0755`, which would leave `candidates.json`/`claimed.json` (the wave roster) world-readable at a predictable path inside world-writable `/tmp`; negligible on a single-operator box, exactly the hazard mktemp(1) documents on a shared one. Keep it outside the repo: planning runs against a checkout whose cleanliness other gates read, and scratch JSON inside `.flotilla/` would be committed in a consumer repo (there it is *not* gitignored — the spine is branch-local committed for resume).

`$REPO` is the consumer repo root (the dir containing `wave.config.json`). **Always pass `--repo-root` explicitly** (FOR-38) — a live finding showed the same candidate roster produce 17 conflict cells without it vs. 40 with it, purely from glob `Files` patterns that silently failed to expand. Omitting it does not fall back to `process.cwd()` (that silent-guess behavior was the bug); it instead degrades glob comparison to exact-pattern-text matching and returns a `warnings` array naming every unexpanded pattern — treat any non-empty `warnings` as a sign the report is incomplete, not as a clean parallel-safe read.

## `IssueView` is a valid `ScopedIssue[]` input

`cross-wave` accepts `ScopedIssue[]` (`{id, files}`) for its `--candidates` and `--claimed` files. `IssueView` is a structural superset of `ScopedIssue` — extra fields (`risk`, `worker`, `status`, …) are ignored. The `listOpen` and `listClaimed` JSON arrays are therefore valid `--candidates`/`--claimed` inputs verbatim; no transformation is needed.

### But `blockedBy` is a union — and one member answers `.length`

The section above says how this projection composes *elsewhere*; this one says where it does not compose the way a reader expects, because the asymmetry between the two is itself part of the trap. `blockedBy` is `'none' | IssueRef[]` — a string sentinel meaning "no blockers", or an array of refs.

**Never take `.length` of it.** `'none'.length === 4`, so a row with **no** blockers reports **four** — and standing next to a genuine `3` from a real array, the output looks internally consistent. Types do not catch it either: `.length` is valid on *both* members of the union, so it type-checks and infers `number` with no narrowing prompt. (`.map` *is* caught — iteration is the loud, lucky failure. Counting is the quiet one, and it is exactly what a "how many blockers does this row have" reflex reaches for first.) And the skill layer is not TypeScript at all: it shells into the CLI and reads **JSON**, where the sentinel is indistinguishable from a four-element array by any check short of a `type` / `Array.isArray` test.

Narrow before you count:

```bash
# jq — blockers per row, correct for both members
jq -r '.[] | "\(.id)  \(if (.blockedBy | type) == "array" then (.blockedBy | length) else 0 end)"'
```

```js
// JS — same narrowing
const blockerCount = (b) => (Array.isArray(b) ? b.length : 0)
```

Live occurrence: the first external 1.0.0 consumer published a blocker table to its operator in which the unblocked row outranked a genuinely-blocked one; it surfaced only later, when iterating the same field threw. `cross-wave` itself is unaffected — it resolves the union correctly and returned the right `intraWaveBlockedByPairs` across the same rows. This is a consumer-side trap, not an engine defect, which is why it is closed here in the document the skill layer reads rather than by changing the shape.

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
- `crossWaveConflicts` — each cell pairs a candidate with an already-claimed issue from another wave that overlap at the listed `files`. The two ids `a`/`b` are bare id strings in canonical lexicographic order (either side may be the candidate; `cell.files` is the overlap). These are the cross-wave races; the Operator decides whether to serialize (wait for the other wave to finish) or accept an explicit mitigation. There is no silent override: `wave-create` will re-check and default to abort when `parallelSafe === false`.
- `intraWaveConflicts` — each cell is two candidates within the proposed wave that overlap. They are not a launch-gate concern but they must be sequenced: the Operator plans which of the two ships first. Record them in the wave's conflict-map (rendered into the spine by `wave-create`).
- `warnings` (present only when non-empty, FOR-38) — one entry per glob `Files` pattern that could not be expanded because `--repo-root` was missing, naming the issue id and the exact pattern text. This should never happen when you pass `--repo-root` per the sequence above; if you see it, the report is incomplete — do not treat a clean `parallelSafe: true` alongside a non-empty `warnings` as a real all-clear.

When `parallelSafe: true` (no `crossWaveConflicts`) **and no `warnings`**, the proposed candidates can run alongside currently-claimed work without file races. `parallelSafe: true` with a non-empty `warnings` means "no conflict found among what could be checked" — not "no conflicts exist".

## PRD open-slice flag derivation

The panel's flag derives **"this PRD has no OPEN slices"** — and that is the whole of what the data in hand can support. A PRD is flagged iff no candidate's `parent` field equals the PRD id (exact string match, no normalization). The `parent` field on `IssueView` is the opaque PRD id the slice was filed with — the same value `to-issues` stored as the `Parent` backlink (ADR-0013). Derivation from the already-loaded candidates array:

```
hasOpenSlices(prd) = candidates.some(c => c.parent === prd.id)
```

**It does NOT derive "never sliced", and the two readings come apart with age.** `candidates` is `listOpen` — wave-eligible **open** issues. The `parent` backlink is the only evidence a PRD was ever sliced, and that evidence lives on the slices; when the last slice closes, it leaves the candidate set with them. A fully-shipped PRD and a never-sliced one therefore render identically. On a fresh repo the two readings nearly coincide; on a repo with a year of shipped PRDs the flag is almost entirely false positives — which is exactly the point at which an operator stops reading the panel at all, including for the one row that is real. Live occurrence: the first external 1.0.0 consumer's panel flagged six of seven PRDs, and all six were fully shipped — every slice filed, merged and closed, some weeks earlier.

**So a flagged PRD prescribes a CHECK, never a slice.** Establish which of the two cases it is before acting: look for slices carrying that PRD as `parent` among **closed** issues too — a tracker search for the PRD id, or the PRD's own cross-reference list on a store that renders one. Closed slices found → the PRD was sliced and shipped; leave it alone. None found anywhere, open or closed → it was genuinely never sliced, and that is the only case where `to-issues` applies.

The check is deliberately the operator's rather than the panel's: resolving it in-engine would cost a closed-slice store round-trip the panel does not make today, and it would still leave a partially-shipped PRD ambiguous. The panel's job is to stop asserting something it cannot know.

A PRD is never in `candidates` — the Document facet and the issue facet are separate, and a PRD carries no eligibility marker.

## Public-API-change pairing derivation (KW-F4)

The public-API-change pairing advisory (SKILL step 3b) is derived **skill-side** from the candidate `risk` fields already loaded by `listOpen` — there is no engine call and nothing is persisted (wave-plan writes nothing). The file-overlap check cannot see it: two rows that each change a global contract can force landing rework with **disjoint `Files`**, the semantic cross-suite conflict the file map is blind to (it broke 27 test assertions on the first Linear consumer wave, past a green conflict-map — both rows were `public-API-change`).

```
apiChangers = candidates.filter(c => c.risk === 'public-API-change')
// two or more → surface the whole set as ONE advisory pairing
```

When `apiChangers` has **two or more** members, surface them as an advisory pairing — the same human-decided, never-auto-excluded treatment `intraWaveBlockedByPairs` get downstream (wave-create). The advisory: each row changes a global contract, so expect reconciled-merge landing rework even though the `Files` are disjoint; plan the wave-close reconciled-merge verify, and consider serializing the pair or splitting it across waves. The Operator decides; wave-plan only raises it.

## Dispatch-cost estimate derivation (SKILL step 3c)

Derived **skill-side** from the `worker` and `risk` fields already loaded by `listOpen` — there is no engine call, no new verb, and nothing is persisted (wave-plan writes nothing). The multiplier is the driver's own per-row pipeline: `worker → scribe(report) → reviewer → scribe(verdict)` is **four agent dispatches for every row that runs the full tuple** (ADR-0024 put the two Scribe stages in that pipeline; ADR-0018 owns the driver). A `cap=1` re-dispatch repeats the whole tuple, so a row that fails once costs up to eight.

**A `foreground` row does not run the full tuple.** Per the coordinator-direct boundary (ADR-0033): the Coordinator implements the row itself, so Worker-side cost is zero — but the row still closes a tracker issue, so its Reviewer still dispatches, followed by the verdict Scribe. A `foreground` row therefore costs **Reviewer + verdict Scribe — two agent dispatches, not four** (there is no Worker report to scribe, so `scribe(report)` does not run either). Folding these rows into the `× 4` headline is exactly the overstatement this carve-out exists to fix.

```
dispatchable = candidates.filter(c => c.worker !== 'HITL-required')
foreground   = dispatchable.filter(c => c.worker === 'foreground')     // ADR-0033: zero Worker-side
fullPipeline = dispatchable.filter(c => c.worker !== 'foreground')

agents           = fullPipeline.length * 4      // the headline estimate
foregroundAgents = foreground.length * 2        // Reviewer + verdict Scribe only — named beside the headline, never folded in

heavy = dispatchable.filter(c =>
  c.worker.endsWith('-heavy') ||                 // heavy Worker (ADR-0012) — a foreground row never matches here
  c.risk === 'cross-feature-refactor' ||         // heavy Reviewer tier …
  c.risk === 'public-API-change')                // … (ADR-0007 Amendment 2026-07-31) — a foreground row can still land here on Risk

excluded = candidates.filter(c => c.worker === 'HITL-required')
```

Four figures, reported as one line per candidate set:

| Figure | Meaning |
|---|---|
| `fullPipeline.length × ~4` | the headline estimate — agent dispatches the full-tuple rows would spend if every one goes out once |
| `foreground.length` (× ~2 each) | Coordinator-implemented rows, named beside the headline at their reduced cost: Reviewer + verdict Scribe only, zero Worker-side (ADR-0033) |
| `heavy.length` | rows running on the `-heavy` tier on the Worker side, the Reviewer side, or both — a `foreground` row can still land here via Risk even though its Worker side is free |
| `excluded` (by id) | `HITL-required` rows — they cost nothing until a human acts, so they are named, not multiplied |

**`~` is load-bearing on both figures.** Four is the happy-path full tuple and two is the happy-path Reviewer-only tuple; re-dispatches, a `blocked` Worker that never reaches its Reviewer, and rows held at the human gate all move the real number. Report both as estimates and never as a budget the Coordinator is then held to.

**Heavy is counted, never weighted. Foreground is carved out, never dropped.** There is deliberately no cost multiplier per tier and no currency conversion — the moment the line produces a single scalar "score", it becomes the sizing heuristic wave-plan does not do. Naming `foreground` rows beside the headline is the same discipline applied to a second axis: it corrects the arithmetic, and it scores nothing, ranks nothing, filters nothing, and recommends nothing about the set — those rows are still drawn in step 1, still reported, and still eligible for the heavy flag. Figures side by side (plus the foreground carve-out and the excluded list) keep the judgment where it belongs.

**Nothing here filters the candidate set.** `dispatchable` exists to keep `HITL-required` rows out of a multiplication they do not belong in, and `foreground` exists to keep Coordinator-implemented rows out of the `× 4` multiplication they no longer belong in either — those rows are still drawn, still reported (at their own reduced cost), and still flagged (SKILL step 1). Excluding a row from one multiplication is not excluding it from the *set*.

## Exit codes for `cross-wave`

| Code | Meaning |
|---|---|
| `0` | success (result on stdout) |
| `1` | domain failure (`crossWaveCheck` threw) |
| `2` | usage error (missing `--candidates`/`--claimed`) **or** an unreadable/malformed input JSON file |

Exit 0 does **not** mean parallel-safe — it means the command ran and produced a result. Read `parallelSafe` in the JSON. A non-empty `warnings` array is also non-fatal (still exit `0`) — the CLI echoes it to stderr as well as including it in the stdout JSON, since it means the result is degraded, not wrong to trust as "checked".
