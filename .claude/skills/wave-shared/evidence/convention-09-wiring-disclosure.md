## Convention 9 — evidence sidecar: wiring-disclosure live occurrences

Moved out of `reference/convention-09-wiring-disclosure.md` per ADR-0034's Amendment (2026-08-13): `reference/` is loaded whole by every execution skill on every wave, and this history is not needed for that load. Reachable on demand via the ADR-0040 sibling-path read; the rule itself stays in the reference/ file.

### Live occurrences (evidence)

Two consecutive cap=1 re-dispatches were caused by exactly this class — each caught only at review, each costing a full iteration-2 round (~9 min, ~200k tokens):

- **W11 — FOR-30** (docs/retros/2026-07-20-hardening-polish-w11.md): the new `ENGINE_SURFACE` detection regex matched the wrapper stores but not the transport layer beneath them (`real-*-api.ts`, the factories, `cli-store.ts`) — spec-covered, gate green, caught by the Reviewer; iter-2 widened the regex.
- **W12 — FOR-53** (docs/retros/2026-07-20-preflight-hardening-w12.md): `setRowIter` + the `spine set-row-iter` CLI verb landed correct and spec-covered, but a repo-wide grep for the new verb name returned 0 hits — the consuming call site (`start-mechanics.md` Step 7d) still invoked only the old `set-row-state re-dispatched`. Caught by the Reviewer; iter-2 wired it via a Coordinator scope extension to exactly the two named files.
