## Convention 10 — evidence sidecar: runtime residue live occurrence

Moved out of `reference/convention-10-runtime-residue.md` per ADR-0034's Amendment (2026-08-13): `reference/` is loaded whole by every execution skill on every wave, and this history is not needed for that load. Reachable on demand via the ADR-0040 sibling-path read; the rule itself stays in the reference/ file.

### Live occurrence (evidence)

**2026-07-22, second consumer wave, finding PC-F2** (doc slug 2026-07-22-postgres-ci): a lane Worker's self-started compose project — container, volume, network, a bound host port — survived worktree cleanup and later held the port during a local reproduction, cascading into a blocked repro session. The consumer mitigated ad-hoc with a per-wave brief clause; this convention generalizes that fix upstream so future consumers don't have to rediscover it.
