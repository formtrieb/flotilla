# Sidecars are written at agent-return by Scribes through paired engine write verbs

The M1 live gate's sharpest finding (retro P-1) was that flotilla's real WAL was not the assumed WAL: sidecars — the durable record the whole resume doctrine ("disk beats a non-landed spine flip") stands on — were written by the Coordinator in `wave-start` step 9, *after* the Workflow returned and routing ran. A Coordinator death mid-wave left **zero sidecars on disk** despite two finished Workers with mergeable PRs; the run was saved only by hand-extracting reports from the Claude-Code workflow journal — a harness artifact flotilla does not own. P-8 compounded it: the sidecar format (fenced ```json in `<id>-<iter>.md`) was derivable only by reading `sidecar.ts`. Decision: the sidecar write moves to the moment the work exists, through engine verbs that own the format — printer paired with parser, the ADR-0016 principle. Build: FOR-6.

## The write verbs — the format gets a single owner

`write-report <json-file> --dir <reportsDir> --id <id> --iter <n>` and `write-verdict <json-file> --dir <verdictsDir> --id <id> --iter <n>` join `validate-report`/`validate-verdict` in `route-cli.ts`, paired with the reader in `sidecar.ts`:

- **Validate-then-write.** The verb runs the matching schema validator and **refuses** an invalid payload (exit 1, errors on stderr, nothing written) — a malformed sidecar is never written deliberately. Exit codes mirror `validate-*`: 0 written (path on stdout), 1 invalid, 2 usage/unreadable.
- **Filename is engine-computed** (`<id>-<iter>.md`) — the caller cannot misname the file, closing the P-8 "reader rejects as corrupt" trap. The body is the fenced ```json block the reader parses.
- **Report cross-check at write time:** `report.issue` must satisfy the reader's prefix check against `--id`, else exit 1 — fail-loud at the write point instead of "corrupt" at resume. The verdict payload has no issue field; like the reader, the verb does no payload check there.
- **`mkdir -p`** on the target dir (the `spine create` ENOENT lesson); **overwrite is last-writer-wins** — idempotent re-entries and the w2 bad-anchor recovery (a corrected verdict round at the *same* iteration) require it, and the reader keeps max-iter anyway.
- **`--dir` is explicit**, symmetric with the read side (`resume-cli --reports/--verdicts`). The `<spine-dir>/<slug>/reports|verdicts/` layout stays a skill-side convention (CONTEXT §Sidecar) — the engine owns filename + format + validation, not the directory shape.

## The Scribe stages — the record exists when the work does

The Workflow driver's pipeline gains two cheap **Scribe** stages: `worker → scribe(report) → reviewer → scribe(verdict)`. Each Scribe is a small `agent()` (cheap model, low effort) whose brief carries the **already-schema-validated** payload byte-exact (`JSON.stringify`-interpolated by the script — the `agent({schema})` boundary validated it; nothing is re-typed from prose) plus the exact CLI invocation with compose-time absolute paths (`WAVE_CLI`, the two sidecar dirs — Coordinator-filled constants, like `depsSetup`). The durable record now exists seconds after each agent returns, before any Coordinator routing — a Workflow script has no filesystem and no shell, so a subagent is the only in-driver write path.

**A Scribe failure never discards the in-band tuple.** The stage wraps its `agent()` in try/catch, passes the report/verdict through regardless, and logs loud; the Scribe itself retries the CLI call once, byte-identical. At routing, the Coordinator checks sidecar existence per tuple and writes a *missing* one through the same verb — a documented recovery path, not the default.

**The invariant is per-path**, "every sidecar comes into being through the write verb, at the moment of agent-return" — not "the Coordinator never touches a sidecar." Driver path: the Scribe stage writes (a seam test proves a verb-written sidecar is adopted by `resume()` with zero Coordinator-side writes on the happy path). Degenerate inline path (`n = 1`, or the w2-proven inline Reviewer re-dispatch): the Coordinator is its own Scribe, invoking the same verb immediately at return. What is forbidden on every path: the old bundled post-routing write (step 9), and hand-formatting a sidecar.

## Considered Options

- **Scribe stages in the driver** (chosen) — source is the validated object; runs in the session cwd where engine + `.flotilla/` exist; consumer-portable; the window shrinks from "end of wave" to "seconds after return".
- **Self-write by Worker/Reviewer** (rejected) — a consumer worktree has neither the engine nor `.flotilla/` (both live with the Coordinator); the agent would type its report twice (disk + return), exactly the re-typing class the schema boundary kills; and the disk record would predate the `agent({schema})` validation.
- **Reviewer writes the Worker's report** (rejected) — the report write would wait on the Reviewer *starting*, which under slot saturation can lag the Worker's return by arbitrary time — the P-1 window persists.
- **A `resume-cli` journal-recovery path** (rejected as the fix) — mechanizes dependence on a harness-specific artifact; P-1's explicit lesson is that flotilla's resilience must not require a journal flotilla does not own.

## Consequences

- Engine: `runWriteReport`/`runWriteVerdict` in `route-cli.ts` + `write-report`/`write-verdict` top-level verbs in `cli.ts`; a writer→reader round-trip spec plus a write→resume seam test (the `resume-dispatch-seam` pattern).
- Driver skeleton (`workflow-driver.md`): two Scribe stages, a `scribeBrief()` helper, a driver-local `SCRIBE_RESULT_SCHEMA` (`{ok, path, error?}`) — deliberately **not** pinned by the `skill-schema-drift` spec, since no engine const corresponds to it.
- `wave-start` step 9 loses the bundled write (report-only now); the routing step gains the existence check + recovery write. `wave-shared` gains the sidecar-format/write-path convention; `wave-resume` references sweep to "resume finds verb-written sidecars natively". `sidecar.ts`'s "(skill-written)" header comment becomes "verb-written".
- **Amends [ADR-0018](0018-wave-execution-runs-on-a-single-workflow-driver-with-a-shared-skill.md)** (the driver's responsibility grows a persistence duty) and makes the [ADR-0002](0002-two-scope-state-spine-authoritative-one-way-projection.md) resume doctrine literally true at work-completion time.
