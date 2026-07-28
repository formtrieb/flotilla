## Convention 10 — runtime residue (a Worker tears down or discloses self-started stacks)

A Worker's slice can start more than files-on-disk — a compose project, a container, a background server, anything holding a port, a volume, or a network. `worktree-cleanup` knows only git artifacts (worktrees, branches); nothing in the Worker brief otherwise requires runtime teardown, so a self-started runtime resource can silently outlive its worktree. **A Worker that starts any runtime resource in the course of its slice must tear it down before termination, or explicitly disclose the surviving resource under `judgmentCalls` — mirrored in `reviewerFocusItems`, the same disclosure shape as Convention 9 — so the Coordinator can clean up after landing.**

The clause itself lives in `workerBrief()`'s policy-clauses list (`.claude/skills/wave-start/reference/workflow-driver.md`) — the text a Worker actually receives; this section documents the convention it encodes. The engine stays untouched here: runtime-resource knowledge (docker, ports) deliberately does not enter the node-pure core (the two-layer split, CHARTER §4) — a structural cleanup sweep remains a possible future slice only if this convention proves insufficient in practice.

### Live occurrence (evidence)

**2026-07-22, second consumer wave, finding PC-F2** (doc slug 2026-07-22-postgres-ci): a lane Worker's self-started compose project — container, volume, network, a bound host port — survived worktree cleanup and later held the port during a local reproduction, cascading into a blocked repro session. The consumer mitigated ad-hoc with a per-wave brief clause; this convention generalizes that fix upstream so future consumers don't have to rediscover it.
