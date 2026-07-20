# wave-start — the Workflow driver

The single dispatch mechanism (ADR-0016: no dual prose-vs-driver selector, no express variant in M1). `wave-start` composes this script with the current wave's rows filled into `ISSUES`, invokes the Workflow tool, then routes the returned tuples (see [start-mechanics.md](start-mechanics.md)).

> **The CLI + the agent-tool schema are the source of truth for shapes.** The two inlined `*_SCHEMA` literals are **copies** of the exported consts in `tools/wave/src/worker-report-schema.ts` + `reviewer-verdict-schema.ts` — the Workflow script runs in a no-fs, no-import sandbox, so it cannot `import` them. The `skill-schema-drift` spec reads these literals from the **wave-shared** skill and deep-equals them against the exported engine consts — if they drift, that spec fails loud. **The canonical copies live in `wave-shared/SKILL.md`; keep these in sync with those, never hand-edit one copy in isolation.**

## Why this copy's `WORKER_REPORT_SCHEMA` drops `anyOf` — the prUrl invariant is brief-enforced here, not schema-enforced

`wave-shared`'s canonical `WORKER_REPORT_SCHEMA` literal carries a top-level `anyOf` (the `outcome: done`/`done-with-concerns` ⇒ `prUrl`-required invariant). The agent tool's `input_schema` validation **rejects a top-level `anyOf`/`oneOf`/`allOf` outright** — `input_schema does not support oneOf, allOf, or anyOf at the top level` — so the copy pasted into `agent({ schema })` below **omits it, deliberately**. This is not a drift from the canonical literal; it is the one shape difference the agent boundary forces (live-confirmed regression: **W5-F1**, `docs/retros/2026-07-19-hardening-w5.md` — the first Workflow dispatch of that wave failed instantly this way, 0 tokens, all 4 Workers, before a single agent ran, because the canonical `anyOf`-bearing literal had been pasted here verbatim).

**The `prUrl`-on-`done`/`done-with-concerns` invariant still holds on this path — it is enforced by the Worker brief, not the schema.** `workerBrief()`'s Termination step 3 ("Capture the printed `.url` as your prUrl") and its Report section both state the requirement in prose; there is no structural rejection at the `agent({ schema })` boundary here for a `done` report that omits `prUrl` (unlike a hypothetical boundary-portable form of the canonical `anyOf`, which would reject it structurally). `tools/wave/src/skill-schema-drift.spec.ts` asserts this literal stays free of any top-level combinator, with a negative control proving that assertion actually fires — so the W5-F1 regression cannot silently ship again.

## Harness constraint that shapes the decomposition (read first)

A Workflow `script` is plain JS with **no filesystem and no local-module import** — it cannot `import tools/wave/src/*` or read a file. Its `agent()` calls, however, are full subagents (bash, fs, all tools). So the driver splits in two:

| Sub-phase | Runs | Why |
|---|---|---|
| **Dispatch + Review + Scribe**: fan out Workers, collect schema-validated `WorkerReport`s, **persist each report sidecar (Scribe stage)**, pipeline each into a `wave-reviewer`, collect schema-validated `ReviewerVerdict`s, **persist each verdict sidecar (Scribe stage)** | **inside the Workflow script** (`pipeline()` + `agent()`) | the `agent()`-heavy parallel part; schema validation at the `agent({schema})` boundary kills the report-fabrication class. A Workflow script has no fs/shell of its own, so the sidecar write is delegated to a cheap `agent()` — the **Scribe** — that runs the paired `write-report`/`write-verdict` verb (ADR-0024) |
| **Route + mutate**: `route-outcome`/`route-verdict` → `spine set-row-state` + `issue-store transition` + the terminator | **the Coordinator, after the Workflow returns**, via `{{wave-cli}}` calls | the script can't `import` the engine; spine writes must be **sequential** on the Coordinator branch (an in-script parallel writer would race the byte-preserving spine round-trip) |

## The Scribe stages — the durable record exists the moment the work does (ADR-0024)

The single sharpest live-gate finding (retro P-1) was that sidecars — the durable record the whole resume doctrine ("disk beats a non-landed spine flip") stands on — used to be written by the Coordinator *after* the Workflow returned and routing ran. A Coordinator death mid-wave left **zero sidecars on disk** despite finished Workers with mergeable PRs. The fix moves the write to the moment the agent returns, through the engine verbs that own the format:

- **`pipeline()` gains two cheap Scribe stages**: `worker → scribe(report) → reviewer → scribe(verdict)`. Each Scribe is a small `agent()` (`model: 'haiku', effort: 'low'`) whose brief carries the **already-schema-validated** payload byte-exact (`JSON.stringify`-interpolated — the `agent({schema})` boundary validated it; nothing is re-typed from prose) plus the exact `write-report`/`write-verdict` invocation. The report is durable **before the review even starts**; each record exists seconds after its agent returns, before any Coordinator routing.
- **A Scribe failure never discards the in-band tuple.** The stage wraps its `agent()` in try/catch, **passes the report/verdict through regardless**, and `log()`s loud (`SIDECAR-WRITE FAILED <id>`). A `pipeline()` stage that *throws* drops the row to `null` — which would convert a *successful* Worker into a `worker-failed` STOP and discard finished work. Structurally forbidden here: the Scribe stage returns its passthrough value in every branch, and the Scribe itself retries the CLI call once, byte-identical.
- **`SCRIBE_RESULT_SCHEMA` is driver-local — deliberately NOT drift-pinned.** No engine const corresponds to it (unlike the two `*_SCHEMA` copies), so `skill-schema-drift.spec.ts` does not — and must not — pin it. It is a plain `{ ok, path, error? }` shape with no top-level `anyOf`/`oneOf`/`allOf` (boundary-safe, W5-F1).

## Authoring constraints

1. **Embed per-row data in the script body** as `const ISSUES = [...]` — the Workflow `args` channel does not reliably deliver a large nested payload. Never depend on external `args` for structured input.
2. **Compose briefs in-script** via a helper that string-interpolates the structured fields — a function field cannot survive JSON serialization through `args`.
3. **Anchor every Worker to the wave-anchor SHA** (`git reset --hard <anchorSha>`) so the Reviewer (wave-reviewer) can diff against that SHA, not `main`.
4. **Fill the Scribe compose-time constants** — `WAVE_CLI` (the absolute engine CLI invocation) and the two **absolute** sidecar dirs (`REPORTS_DIR` / `VERDICTS_DIR`, `.flotilla/waves/<slug>/reports|verdicts`), just as you fill `depsSetup`. Scribes run as plain `agent()` (no worktree isolation) in the **session cwd**, where the engine checkout and `.flotilla/` actually live — absolute paths make that explicit and independent of any agent's cwd.

## A worktree carries tracked files only (FOR-32, W4-F4)

`isolation: 'worktree'` gives Worker and Reviewer alike a **fresh checkout of tracked files** — nothing gitignored comes along. Two consumer paths are commonly gitignored, and both briefs below assume they exist unless the Coordinator fills the gap:

- **The dependency directory.** If it is gitignored (the ordinary case for a lockfile-managed dependency tree), a fresh worktree has it **absent, not merely un-installed** — the verify gate the brief tells the agent to run cannot run at all without an install step first. The Reviewer brief hits the identical wall: it independently re-runs the same verify commands in its own worktree.
- **The store config** (e.g. `wave.config.json`). If it is gitignored, it is likewise **absent** from the worktree, so an agent standing inside that checkout cannot resolve a tracker id against a store it has no config for — a bare `issueRef` is unreadable from there.

Neither gap is flotilla's to close generically with a hardcoded command — the dependency dir, the install command, and the config's location are all **consumer-specific**. The mitigation is two per-row inputs the Coordinator supplies (`depsSetup` / `issueSpec` below), sourced from the consumer's own setup — `wave-setup`'s preconditions record exactly these two answers so the Coordinator has them ready at compose time instead of re-deriving them wave after wave.

## The script (paste into the Workflow tool)

```js
export const meta = {
  name: 'wave-start-inflight',
  description: 'Dispatch + review one ready wave; return schema-validated reports + verdicts',
  phases: [{ title: 'Dispatch' }, { title: 'Review' }],
}

// ── inlined from wave-shared (copy of WORKER_REPORT_SCHEMA) ──
// anyOf-free by design (agent tool's input_schema rejects a top-level anyOf/oneOf/allOf,
// W5-F1) — the prUrl-on-done/done-with-concerns invariant is BRIEF-enforced below, not
// schema-enforced. See "Why this copy drops anyOf" above; skill-schema-drift.spec.ts pins it.
const WORKER_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome','issue','branch','commitShas','filesChanged','tests','lint','judgmentCalls','reviewerFocusItems'],
  properties: {
    outcome: { type: 'string', enum: ['done','done-with-concerns','needs-context','blocked'] },
    issue: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 },
    worktree: { type: 'string' },
    commitShas: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    prUrl: { type: 'string' },
    filesChanged: { type: 'object', additionalProperties: false, required: ['new','modified','renamed'],
      properties: { new: { type: 'integer', minimum: 0 }, modified: { type: 'integer', minimum: 0 }, renamed: { type: 'integer', minimum: 0 } } },
    tests: { type: 'string', minLength: 1 }, regressionSweep: { type: 'string' },
    lint: { type: 'string', minLength: 1 }, conflictMarkers: { type: 'string' },
    judgmentCalls: { type: 'array', items: { type: 'string' } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
  },
}

// ── inlined from wave-shared (copy of REVIEWER_VERDICT_SCHEMA — uniform Reviewer: NO briefProfile) ──
const REVIEWER_VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict','branchReviewed','riskClass','workerReportDigest','acVerification','reviewerFocusItems'],
  properties: {
    verdict: { type: 'string', enum: ['approve','changes-requested','questions-blocking'] },
    branchReviewed: { type: 'string', minLength: 1 },
    riskClass: { type: 'string', enum: ['mechanical','isolated-refactor','cross-feature-refactor','public-API-change'] },
    workerReportDigest: { type: 'string', minLength: 1 },
    acVerification: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['ac','met','evidence'],
      properties: { ac: { type: 'string', minLength: 1 }, met: { type: 'string', enum: ['met','partial','not-met','deferred'] }, evidence: { type: 'string' } } } },
    reviewerFocusItems: { type: 'array', items: { type: 'string' } },
    lintTestSummary: { type: 'string' }, gitStateSane: { type: 'boolean' },
  },
}

// ── Scribe result — DRIVER-LOCAL, deliberately NOT drift-pinned (ADR-0024) ──
// No engine const corresponds to this; do NOT add it to skill-schema-drift.
// Boundary-safe: a plain object, no top-level anyOf/oneOf/allOf (W5-F1).
const SCRIBE_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'path'],
  properties: { ok: { type: 'boolean' }, path: { type: 'string' }, error: { type: 'string' } },
}

// ── Scribe compose-time constants (Coordinator-filled, like depsSetup) ──
// ABSOLUTE — Scribes run in the session cwd where the engine + .flotilla/ live.
const WAVE_CLI = '<absolute engine CLI, e.g. "npx tsx /abs/path/to/tools/wave/src/cli.ts">'
const REPORTS_DIR = '<absolute .flotilla/waves/<slug>/reports>'
const VERDICTS_DIR = '<absolute .flotilla/waves/<slug>/verdicts>'

const j = (items) => (items.length ? items : ['none']).map(s => `- ${s}`).join('\n')

// ── Per-row data — Coordinator fills this from the spine before invoking ──
// Each: { id, slug, risk, iteration, model, anchorSha, coordinatorBranch,
//         depsSetup, issueSpec, prTitle, closePhrase, reviewerHints, siblingBranches }
const ISSUES = [
  {
    id: 'NN',
    slug: 'short-slug',
    risk: 'mechanical',            // mechanical | isolated-refactor | cross-feature-refactor | public-API-change
    iteration: 1,
    model: 'sonnet',               // 'opus' for cross-feature-refactor / public-API-change, else 'sonnet'
    anchorSha: '<COORDINATOR_HEAD_SHA>',   // git rev-parse HEAD at dispatch time — the wave anchor
    coordinatorBranch: 'feat/<slug>',
    // The consumer's own dependency-install command(s) — from the wave-setup
    // preconditions answer for "is the dependency dir gitignored?". Empty
    // string only if the consumer confirmed nothing is gitignored there.
    depsSetup: '<consumer dependency-install command, e.g. "cd <depsDir> && <installCmd>">',
    // The FULL issue spec embedded verbatim — title, body, acceptance criteria,
    // declared Files globs, risk. NOT a tracker id/path: the store config that
    // would resolve one may itself be gitignored and absent from this worktree.
    issueSpec: '<embed title + body + acceptance criteria + Files globs + risk here>',
    // The PR-open inputs the Worker passes to `host-pr create` (the Worker has no
    // wave.config.json in its worktree, so the Coordinator supplies both):
    //   prTitle     — the PR title. Composed WITHOUT any bare tracker id
    //                 (mention discipline, wave-shared Convention 4).
    //   closePhrase — the store-kind close phrase, derived from wave.config.json's
    //                 store.kind: github → 'Closes #<N>', linear → 'Fixes <TEAM-NN>'.
    //                 It is the ONLY tracker id allowed anywhere in the PR title/body.
    prTitle: '<PR title — no bare tracker id>',
    closePhrase: '<Closes #NN | Fixes TEAM-NN — store-kind-derived (Convention 4)>',
    reviewerHints: ['Verify <thing 1>.', 'Confirm <thing 2>.'],
    siblingBranches: '(none — last in-flight issue)',
  },
]

// ── Compose-time anchor assertion (W2-F1) — run BEFORE any agent() fan-out ──
// A missing/empty/stringified-"undefined" anchorSha must fail loud here, at the
// cheapest point, naming the offending row id — not silently interpolate into a
// brief and surface late as a spurious Reviewer questions-blocking (as it did in
// the 2026-07-16-hardening-w2 live wave: ANCHOR was defined but never wired into
// ISSUES, so every brief carried the literal string "undefined").
function assertAnchorSha(issue) {
  const a = issue.anchorSha
  if (a === undefined || a === null || a === 'undefined' || String(a).trim() === '') {
    throw new Error(`wave-start: row ${issue.id} has no valid anchorSha (got ${JSON.stringify(a)}) — wire anchorSha into ISSUES before dispatch`)
  }
}
ISSUES.forEach(assertAnchorSha)

function workerBrief(issue) {
  return `You are a Wave Worker executing issue #${issue.id} in an isolated worktree.

## Workspace setup (do first)
1. \`pwd\` — confirm you are in a worktree (not the parent path).
2. Anchor to the wave anchor SHA:
   \`\`\`bash
   git fetch origin ${issue.coordinatorBranch} 2>&1 | tail -3
   git reset --hard ${issue.anchorSha}
   git status --porcelain      # MUST be empty
   git rev-parse HEAD          # MUST equal ${issue.anchorSha}
   \`\`\`
3. \`git checkout -b wave/${issue.id}-${issue.slug}\`
4. Install dependencies. A worktree checkout carries **tracked files only** — if
   this consumer's dependency directory is gitignored (the ordinary case for a
   lockfile-managed tree), it is **absent here, not merely un-installed**, and
   the verify gate below cannot run at all without this step first:
   \`\`\`bash
   ${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
   \`\`\`

## Task spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so the complete issue spec — title, body,
acceptance criteria, declared Files globs, risk — is embedded below rather than
pointed at by id. Implement it fully, satisfying every acceptance criterion, and
stay strictly within the declared Files globs.

${issue.issueSpec}

## Policy clauses (obey verbatim)
1. AC-vs-repo-policy conflict: repo policy wins; flag under Judgment calls.
2. Commit policy: new commits only — never \`git commit --amend\` on a pushed commit.
3. PR-only: push your branch + open a PR; NEVER push to the protected default branch.
4. Conflict-marker check before committing:
   \`\`\`bash
   git diff --cached --name-only | xargs -I{} grep -l '^<<<<<<<\\|^>>>>>>>\\|^=======$' {} 2>/dev/null | head
   \`\`\`
5. SECRET-SAFE: never echo any environment variable's VALUE — not even with fallback syntax like \${VAR:-no}. Check availability value-free only: \`[ -n "$GITHUB_TOKEN" ] && echo set\`. Tool output must never contain a secret.
6. MENTION DISCIPLINE: the PR title and body must not contain ANY bare tracker id except the single close phrase (\`${issue.closePhrase}\`, Termination step 3 below) — reference ADR numbers or doc slugs instead.

## Verification gates (run the consumer's verify profile — from wave.config.json verify)
Run the commands the VerifyGate selects for your changed files; report exact counts.

## Termination
1. Commit all work in one commit.
2. \`git push origin wave/${issue.id}-${issue.slug}\` (never \`-u\`, never to default).
3. Open the PR **through the engine — never \`gh pr create\`** (\`gh\`'s creds are sandbox-denied and its TLS fought the proxy in every live run; this verb uses the same \`fetch\` path the landing verbs do). Find-before-create is idempotent: a PR already open on this branch (e.g. a cap=1 re-dispatch onto the same branch) is **reused**, never duplicated. Compose a PR body whose last line is the store-kind close phrase, then run:
   \`\`\`bash
   ${WAVE_CLI} host-pr create \\
     --branch wave/${issue.id}-${issue.slug} \\
     --title "${issue.prTitle}" \\
     --body "<one-paragraph summary of what you changed>

${issue.closePhrase}"
   # exit 0 → stdout is one JSON object; its .url (outcome: created | reused) is your prUrl.
   \`\`\`
   The body MUST carry the close phrase \`${issue.closePhrase}\` on its own line (wave-shared Convention 4 — reads GITHUB_TOKEN from your env, never printed), and that is the **only** tracker id the title or body may name (mention discipline, policy clause 6): do not reference any other issue id anywhere. Capture the printed \`.url\` as your prUrl.

## Report — emit as your FINAL message, matching the WorkerReport schema:
outcome, issue, branch, worktree, commitShas, prUrl, filesChanged{new,modified,renamed},
tests, lint, conflictMarkers, judgmentCalls[], reviewerFocusItems[].

## Reviewer-handoff hints (from Coordinator)
${j(issue.reviewerHints)}`
}

// reviewerBrief only ever reads `issue.anchorSha` off the same ISSUES row object
// assertAnchorSha already validated — including on a re-dispatch (cap=1 Worker
// re-run, or the bad-anchor Reviewer-only recovery below): there is no second
// code path that could re-derive or re-interpolate an unasserted anchor.
function reviewerBrief(issue, report) {
  return `You are the Wave Reviewer for issue #${issue.id} (${issue.slug}).

## What to review
Branch: \`wave/${issue.id}-${issue.slug}\`
Risk class: \`${issue.risk}\`   (dispatch is universal — Risk does NOT gate whether you run)
Wave anchor SHA (diff base — NOT main): \`${issue.anchorSha}\`
Sibling in-flight branches: ${issue.siblingBranches}

## Workspace setup (do first)
Your own worktree also carries **tracked files only**. If this consumer's
dependency directory is gitignored, it is absent here too, and you cannot
re-run the verify commands below without installing first:
\`\`\`bash
${issue.depsSetup || '# consumer confirmed at wave-setup: nothing gitignored here — no install step needed'}
\`\`\`

## Original issue spec (embedded — not a tracker reference)
The store config that would resolve a tracker id may itself be gitignored and
therefore absent from this worktree, so you cannot look the issue up yourself
either — the full spec (title, body, acceptance criteria, declared Files
globs, risk) is embedded below; use it for the per-AC verification.

${issue.issueSpec}

## Worker Report digest
Outcome: ${report.outcome}
Commit SHAs: ${report.commitShas.join(', ')}
PR URL: ${report.prUrl || '<pending>'}
Tests: ${report.tests}
Lint: ${report.lint}
Conflict markers: ${report.conflictMarkers || 'clean'}
Judgment calls:
${j(report.judgmentCalls)}
Reviewer focus items (Worker-appended):
${j(report.reviewerFocusItems)}

## Your checks
Run the wave-reviewer contract (see .claude/agents/wave-reviewer.md): re-run the verify
commands + the floor checks against \`${issue.anchorSha}..wave/${issue.id}-${issue.slug}\`,
per-AC met/partial/not-met with evidence (against the embedded spec above), sibling
merge-tree prediction.

Return a JSON object matching the ReviewerVerdict schema:
verdict, branchReviewed, riskClass, workerReportDigest, acVerification[], reviewerFocusItems[].`
}

// ── Scribe: persist ONE sidecar at agent-return through the paired write verb ──
// The brief carries the already-validated payload byte-exact (JSON.stringify) —
// nothing is re-typed. The Scribe writes it to a temp file VERBATIM, runs the
// engine verb (engine-computed <id>-<iter>.md name, fenced json, mkdir -p,
// last-writer-wins), retries once on a non-zero exit, and returns { ok, path }.
function scribeBrief(kind, issue, iter, payload) {
  const dir = kind === 'report' ? REPORTS_DIR : VERDICTS_DIR
  const verb = kind === 'report' ? 'write-report' : 'write-verdict'
  return `You are a Wave Scribe. Persist one ${kind} sidecar THROUGH THE ENGINE — do not reformat, re-type, or "fix" anything in the payload.

1. Write this EXACT JSON to a temp file, byte-for-byte via a heredoc (no edits):
${JSON.stringify(payload)}
2. Run:  ${WAVE_CLI} ${verb} <that-temp-file> --dir ${dir} --id ${issue.id} --iter ${iter}
   (exit 0 → the absolute written path is printed on stdout; exit 1 → invalid payload / id mismatch; exit 2 → usage/unreadable)
3. If the exit code is non-zero, retry the SAME command ONCE, byte-identical.
Return { ok: <true iff the verb exited 0>, path: <the absolute path it printed, or ''>, error: <stderr, only on failure> }.`
}

// The stage wrapper ALWAYS returns `passthrough` — a throw here would drop the
// row to null (→ a spurious worker-failed STOP that discards finished work). A
// Scribe failure is logged loud; the Coordinator's routing-time existence check
// (SKILL.md step 7) writes any missing sidecar through the same verb.
async function scribe(kind, issue, iter, payload, passthrough) {
  try {
    const r = await agent(scribeBrief(kind, issue, iter, payload), {
      label: `scribe-${kind}:${issue.id}`, phase: 'Dispatch',
      model: 'haiku', effort: 'low', schema: SCRIBE_RESULT_SCHEMA,
    })
    if (!r.ok) log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${r.error || 'unknown'}`)
  } catch (e) {
    log(`SIDECAR-WRITE FAILED ${kind} ${issue.id}: ${e.message}`)
  }
  return passthrough
}

// ── Dispatch loop (worker → scribe(report) → reviewer → scribe(verdict)) ──
phase('Dispatch')
const results = await pipeline(
  ISSUES,
  // Stage 1 — Worker: worktree-isolated, schema-validated WorkerReport
  (issue) => agent(workerBrief(issue), {
    label: `worker:${issue.id}`, phase: 'Dispatch',
    isolation: 'worktree', schema: WORKER_REPORT_SCHEMA,
    model: issue.model,
  }),
  // Stage 2 — Scribe(report): durable BEFORE the review even starts. Passes the
  // report through unchanged so the Reviewer stage still receives it.
  (report, issue) => scribe('report', issue, issue.iteration, report, report),
  // Stage 3 — Reviewer: universal dispatch, schema-validated ReviewerVerdict
  (report, issue) => agent(reviewerBrief(issue, report), {
    label: `review:${issue.id}`, phase: 'Review',
    agentType: 'wave-reviewer', schema: REVIEWER_VERDICT_SCHEMA,
  }).then((verdict) => ({ report, verdict })),
  // Stage 4 — Scribe(verdict): persist the verdict, then build the routing tuple.
  (rv, issue) => scribe('verdict', issue, issue.iteration, rv.verdict,
    { id: issue.id, risk: issue.risk, iteration: issue.iteration, report: rv.report, verdict: rv.verdict }),
)
return results.filter(Boolean)
```

`pipeline()` (not `parallel()`) is deliberate: issue B's Worker runs while issue A's Reviewer already runs — no barrier. A Stage-1 (Worker) throw drops that row to `null` (the `.filter(Boolean)`); the Coordinator routes a missing row as a `worker-failed` STOP. The **Scribe** stages never throw — they always return their passthrough value — so a sidecar-write failure never converts a finished Worker into a lost row. The fan-out order follows `ISSUES`, which the Coordinator fills in **Plan-Table row order** — the dispatch-order tiebreak.

## Degenerate `n = 1`

A single-row wave is a one-element `pipeline()` — identical routing, no fan-out gain. The Coordinator may instead dispatch the one Worker + Reviewer inline and apply the same `route-outcome`/`route-verdict` chain. The determinism (typed fields, tested routing) holds either way.

**On the inline path the Coordinator is its own Scribe (ADR-0024).** The sidecar invariant is per-path — *every sidecar comes into being through the write verb, at the moment of agent-return*, not "a subagent always writes it". So when the Coordinator dispatches inline (the `n = 1` case, or the w2-proven inline Reviewer re-dispatch), it runs the same `write-report` / `write-verdict` verb **itself, immediately** as each agent returns — before routing. What is forbidden on **every** path: the old bundled post-routing write, and hand-formatting a sidecar.

## Recovery protocol — a bad-anchor first round (W2-F1)

`assertAnchorSha` throwing at compose time is the fail-loud path for the *next* wave; it does nothing for a wave already dispatched before this assertion existed, or for any other source of a bad diff base a Reviewer catches downstream (e.g. a Coordinator hand-composed the brief outside this script). If a Reviewer verdict comes back `questions-blocking`/flags the diff base as malformed, and the Coordinator confirms the anchor interpolated into that round's briefs was wrong (missing, empty, or `"undefined"`):

1. **Re-dispatch the affected Reviewers only**, each with a corrected `issue.anchorSha` — call `reviewerBrief(issue, report)` again with the fixed `issue` object (or an inline `agent()` call carrying the same corrected value). Reuse the **same** Worker `report` / branch already produced; do not touch it. **Scribe the corrected verdict through `write-verdict` at the same `iter`** — last-writer-wins overwrites the bad-anchor verdict sidecar (the reader keeps max-iter either way); on this inline re-dispatch the Coordinator is its own Scribe (§Degenerate `n = 1`).
2. **Do not re-dispatch the Worker.** The defect is Coordinator input (a bad brief), not branch content — the Worker's commits are unaffected by which SHA the *Reviewer* diffs against.
3. **Do not consume the re-dispatch cap.** `route-verdict`'s cap=1 counts `changes-requested`/`needs-context` rounds against real branch content; a Reviewer round invalidated by a Coordinator-side composition bug is not that — treat the corrected-anchor Reviewer round as the row's real (only) review round, not a second one.

This is the scripted version of what happened live in `2026-07-16-hardening-w2`: two Reviewers returned spurious `questions-blocking` against the literal string `"undefined"`; both were re-dispatched with the corrected anchor, both then returned `approve`, and the wave closed with 0 Worker re-dispatches and the cap untouched.
