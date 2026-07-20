# Publication is a hard cut to a fresh public repo — the private history becomes the ops archive

flotilla was designed and hardened inside a client engagement: the Ur seed, the wiki/server pilots, and seven live waves all predate any public ambition. The confidential references live in three places with very different reachability — the working tree's docs (fixable by editing), the squashed initial commit (fixable only by re-cutting history), and the PR bodies/reviews/issue links of the private repo (**GitHub data, not git — no `filter-repo` can rewrite them**). That last class decides the shape: the existing repo can never be flipped public, whatever we rewrite.

## Decision

**Hard cut.** A fresh public repo takes the canonical name (`formtrieb/flotilla`, Apache-2.0 — the license the repo has carried since init and PROVENANCE documents; an earlier revision of this ADR said MIT, conflating flotilla's own license with the MIT *seed* notice duty), born with a single clean initial commit of the de-cliented tree; development — including the wave dogfood — moves there. The private repo is renamed `flotilla-archive` and freezes as the ops/provenance home: full history, all PRs, and every non-shipping doc stay there, nothing is deleted.

- **Public doc-set:** CHARTER, CONTEXT, all ADRs, PROVENANCE, and the **retros** ship, de-cliented — the retros are flotilla's show-your-work artifact and stay in (German first; translation is a follow-up). The milestone PRD, CANARY, HANDOFF, plans/specs, and the CLAUDE.md status history stay private; the public repo gets a lean CLAUDE.md + real README instead. PROVENANCE keeps the MIT seed notice verbatim (the only license-bearing half); the Ur seed line is anonymized.
- **Alias set** (now CONTEXT.md `Provenance` terms): **the Ur** (predecessor system), **the wiki pilot** (the original M1 target), **the server pilot** (the consumer the M1 live gate ran on). The clear-name mapping exists only in `flotilla-archive` and in a **gitignored de-client denylist**.
- **Verification — the denylist paradox:** a check script ships public but reads its patterns from the gitignored local denylist (the `wave.config.json` split, reused). Committing the list would publish exactly what it guards. Consequence, stated honestly: the guard is a **cut-time + local pre-push guard**, not a public CI guarantee — on machines without the list it skips.
- **Durability of `.flotilla/`:** the directory becomes a **nested git repo** (still ignored by the toolkit repo — the "no spine ever lands in the toolkit" rule holds unchanged) with `flotilla-archive` as its remote; initial push happens **before** the repo dance, and the ops runbook gains a push step after every `wave-close`. `wave.config.json` carries no secrets and is committed there.
- **Distribution at the cut is vendor-copy, documented** — copy `tools/wave` + `.claude/skills`, run `wave-setup`; exactly how the pilot and the self-consumption actually onboarded. npm CLI and Claude-Code plugin are named post-publication tracks, not cut prerequisites.
- **Dogfood tracker stays on Linear** (private board, host integration repointed to the new repo). One wave on the public repo using **GitHub Issues as the store** is a planned live gate — the GitHub store is the least live-proven adapter and simultaneously the primary onboarding path of an OSS audience; it gets the server-pilot treatment.
- **Sequencing:** W7 = the hardening quartet (FOR-34/36/37/38, pairwise disjoint) runs pre-cut on familiar rails — it is also the Scribe stages' first live run. W8 = the publication wave (de-client docs · de-client retros · README/CLAUDE.md/onboarding · denylist gate), filed via `to-issues`, the last private wave; the un-waveable repo dance is an ops **runbook** (which also absorbs the W6-F1 coordinator-glue operating notes). Post-cut order: rails completion (FOR-27/28) → OSS-facing polish (FOR-16/17) → the GitHub gate wave (small rows filed on the public tracker) → FOR-20 and the remainder.

## Considered Options

- **Hard cut** (chosen) — loses the public commit trail of the seven pre-cut waves; the de-cliented retros carry that story publicly, the archive keeps the real trail privately.
- **Flip the existing repo public after a history rewrite** (rejected) — the PR/review/issue metadata is unrewritable GitHub data; the leak surface survives any git-level cleaning.
- **Public release-mirror, private dev** (rejected) — no public PR flow, double bookkeeping; contradicts the point of publishing a PR-native orchestration toolkit.
- **Migrate the dogfood backlog to public GitHub Issues** (rejected for now) — would live-prove the GitHub store permanently, but costs the open-ticket migration and the Linear adapter's only live coverage; the single gate wave buys the proof without the trade.
- **Leave `.flotilla/` ephemeral** (rejected) — machine loss would erase the only copy of every spine and sidecar the retros cite.

## Consequences

- Public history starts at the cut. A future reader wondering why is reading the answer.
- After the rename dance, stale clone URLs of the old name resolve to the **new public repo** — deliberate, but the local dev clone and the Linear host integration must be repointed explicitly (runbook steps).
- De-clienting edits shipped ADRs — a mechanical alias sweep, sanctioned here once; the aliases are glossary terms, so the docs stay readable without the mapping.
- The public repo must never accumulate new client references; retro prose is where they historically entered. The denylist guard runs where the list exists; discipline covers the rest.
