## Convention 5 — the sidecar write path (verb-written, at agent-return)

Sidecars — the durable Worker-report / Reviewer-verdict records under `.flotilla/waves/<slug>/reports|verdicts/` — are the WAL the resume doctrine ("disk beats a non-landed spine flip", ADR-0002) stands on. **The invariant (ADR-0024): every sidecar comes into being through the engine write verb, at the moment its agent returns — never hand-formatted, never bundled after routing.** This is the P-1 live-gate fix: a Coordinator death used to leave zero sidecars because they were written last, in a batch, after the Workflow returned.

- **The write verbs own the format.** `write-report`/`write-verdict` are the printers paired with the `sidecar.ts` reader (the way `renderSpine` is paired with `readSpine`, ADR-0016). They **validate-then-write** — an invalid payload is refused (exit 1, nothing written), the filename is engine-computed (`<id>-<iter>.md`, the caller cannot misname it), the body is the fenced-json block the reader parses, the target dir is `mkdir -p`'d, and a same-iter re-write is last-writer-wins. Full flags + exit codes: [reference/routing-mechanics.md](reference/routing-mechanics.md).

  | Verb | Renders | Cross-check |
  |---|---|---|
  | `write-report <json> --dir <reportsDir> --id <id> --iter <n>` | `<reportsDir>/<id>-<iter>.md` (fenced `WorkerReport`) | `report.issue` must be prefix-compatible with `--id` (the reader's rule) — else exit 1 |
  | `write-verdict <json> --dir <verdictsDir> --id <id> --iter <n>` | `<verdictsDir>/<id>-<iter>.md` (fenced `ReviewerVerdict`) | none (a verdict has no issue field — like the reader) |

- **Who runs the verb — per path.** On the Workflow-driver path, two cheap **Scribe** `agent()` stages run the verb (`worker → scribe(report) → reviewer → scribe(verdict)`) so the record is durable seconds after each agent returns, before any Coordinator routing (workflow-driver.md). On the degenerate inline path (`n = 1`, or an inline Reviewer re-dispatch), the Coordinator is its own Scribe — same verb, run immediately at agent-return. The old bundled post-routing write is gone.
- **A Scribe failure never discards the tuple.** The driver's Scribe stage passes the report/verdict through regardless and logs loud; at routing, the Coordinator checks each sidecar's existence and writes a *missing* one through the same verb (the documented recovery path, not the default).
- **`SCRIBE_RESULT_SCHEMA` is driver-local — NOT one of the drift-pinned copies.** The Scribe's `{ ok, path, error? }` return shape lives only in the Workflow driver; no engine const corresponds to it, so `skill-schema-drift.spec.ts` does not pin it and must not be extended to. Only `WORKER_REPORT_SCHEMA` / `REVIEWER_VERDICT_SCHEMA` above are drift-pinned.
