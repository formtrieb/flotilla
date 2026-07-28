## Convention 2 — the deterministic routing chain

Routing is **never** hand-synthesised from prose. The chain is, in order:

```
typed return  →  route-{verdict,outcome}  →  issue-store transition  →  spine write
```

- **Worker phase.** The Worker returns a `WorkerReport` (validated against `WORKER_REPORT_SCHEMA` at the agent boundary). Feed its typed `outcome` + the issue's current state to `route-outcome --outcome <o> --state <s>`. It prints `{ event, outcome }` — the `event` is the `WaveEvent` the engine derived; the `outcome` is the resulting fine state. The transition is then applied via `issue-store transition`.
- **Reviewer phase.** The Reviewer returns a `ReviewerVerdict` (validated against `REVIEWER_VERDICT_SCHEMA`). Feed its typed `verdict` + `riskClass` + the iteration + the issue's state to `route-verdict --verdict <v> --iteration <1|2> --risk <riskValue> --state <s>`. It bifurcates on `riskClass` (the G3 guard) and prints `{ event, outcome }`.
- **Apply.** Take the `outcome`/`event` from the router and call `issue-store transition <id> <target-rung>` — the router decided, the transition executes. A `questions-blocking` verdict or a `blocked` worker outcome routes to **needs-attention** via `issue-store flag` (see below), not a rung transition.

The router CLIs are pure wrappers over the engine's `verdictToEvent` / `outcomeToEvent` adapters — they cannot invent an event. If you ever find yourself reading a number or a verdict word out of the subagent's prose to decide a transition, stop: that is the fabrication class this whole chain exists to kill. Use the typed field.

### needs-attention is orthogonal to the rung

When the chain routes to a STOP (`questions-blocking`, `blocked`, or any recoverable/terminal stall), set the **needs-attention flag** — it is orthogonal to the claim rung (ADR-0006), not a rung value:

```
issue-store flag <id> --kind <recoverable-stop|terminal-failure> --question "<q>" --option "<o>" [--option "<o>" ...]
```

`clear-flag <id>` removes it once resolved. The flag carries a `NeedsAttentionPayload` (`{ kind, question, options }`) so the human sees the exact decision to make. On GitHub this is the `wave/needs-attention` label + a structured comment; the rung label (`wave/<rung>`) is untouched.
