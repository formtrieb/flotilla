## Convention 10 — runtime residue (a Worker tears down or discloses self-started stacks)

A Worker's slice can start more than files-on-disk — a compose project, a container, a background server, anything holding a port, a volume, or a network. `worktree-cleanup` knows only git artifacts (worktrees, branches); nothing in the Worker brief otherwise requires runtime teardown, so a self-started runtime resource can silently outlive its worktree. **A Worker that starts any runtime resource in the course of its slice must tear it down before termination, or explicitly disclose the surviving resource under `judgmentCalls` — mirrored in `reviewerFocusItems`, the same disclosure shape as Convention 9 — so the Coordinator can clean up after landing.**

The clause itself lives in `workerBrief()`'s policy-clauses list (`.claude/skills/wave-start/reference/workflow-driver.md`) — the text a Worker actually receives; this section documents the convention it encodes. The engine stays untouched here: runtime-resource knowledge (docker, ports) deliberately does not enter the node-pure core (the two-layer split, CHARTER §4) — a structural cleanup sweep remains a possible future slice only if this convention proves insufficient in practice.

A disclosure raised under this convention does not stop at the brief: `wave-start` captures it into the spine's `## Disclosures` section at verdict-routing, source-neutral, and it must reach a disposition other than `open` before the wave archives ([ADR-0027](../../../../docs/adr/0027-disclosures-are-spine-captured-at-routing-and-dispositioned-before-archive.md)).

### Live occurrence (evidence)

A consumer wave's self-started compose project survived worktree cleanup and later blocked a local reproduction — the incident this convention generalizes from, ad-hoc per-wave clause turned standing rule (history: `../evidence/convention-10-runtime-residue.md`, read via the sibling-path read when actually wanted, ADR-0040).
