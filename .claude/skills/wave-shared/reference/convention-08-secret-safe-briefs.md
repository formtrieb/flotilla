## Convention 8 — secret-safe tool output (binds every role, the Coordinator included)

**Enforced by:** hook — `tools/wave/hooks/echo-guard.cjs` (the echo shape, on every role's Bash call); brief prose — `tools/wave/driver/wave-start-inflight.js` (the isolated-role no-probe rule).

An agent's tool output is not ephemeral — it is the session transcript on disk, long-lived and read by humans and downstream agents alike. **No role in this pipeline echoes an environment variable's VALUE into that output — not even with fallback syntax like `${VAR:-no}` — dumps the whole environment, or reads a gitignored settings/secrets file.**

### Who this binds — the Coordinator too, not only the briefs it composes

Read that sentence literally: this is **not** a rule about brief text. It is a rule about **tool output**, and it binds **every role that produces tool output** — Worker, Reviewer, Scribe, **and the Coordinator**.

That gap cost two credentials before the placement fix below closed it — incident history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted (ADR-0040).

The consequence is about **placement**, not only phrasing: the safe form has to sit where a role reads *while it is acting*, not only where it writes for someone else. The two auth-preflight steps a Coordinator actually executes therefore carry the form **inline** — `wave-start` step 4 (`.claude/skills/wave-start/SKILL.md`) and `wave-close` phase 2 (`.claude/skills/wave-close/reference/phase-2-auth-preflight.md`) — and neither of them merely points here for it. A pointer is not read at the moment someone types a check; that is the whole finding.

### The one sanctioned presence test

```bash
[ -n "$VAR" ] && echo set
```

Prints the literal string `set` (or nothing) — never the token, never the whole environment, never a file's contents. There is no second sanctioned form, and no "just for diagnostics" exemption.

### Isolated roles do not probe — the Coordinator's preflight already proved it

The sanctioned form above answers *how* to check presence. It does not follow that every role needs to *ask* the question in the first place. A dispatched **Worker or Reviewer runs worktree-isolated** (`isolation: 'worktree'`, `.claude/skills/wave-start/reference/workflow-driver.md`) and is never the role that establishes whether a credential resolves — the **Coordinator's own value-free credential-probe preflight** (`wave-start` step 4, `wave-close` phase 2 — `{{wave-cli}} credential-probe --all`, exit-status only, described above) already proves resolvability **once, up front, before the flip** — before a single row is dispatched.

**The isolated-role rule: do not probe, sanctioned form or not.** A dispatched role re-running a presence test mid-slice is re-asking a question the Coordinator already answered on its behalf, from a vantage point — the interactive session, pre-dispatch — that is strictly the more authoritative one: the preflight STOPS the wave *before the flip* on a credential that fails to resolve, so a Worker or Reviewer that ever reaches the point of running its own task is already operating on a proven-resolvable credential. If resolution nonetheless fails **mid-slice** — a token expired or revoked in the window between preflight and dispatch — that surfaces as a **typed engine error from the call that actually needed it** (`host-pr create` exiting non-zero with a structured error). The role reports that as `blocked`; it does not pre-empt it with a presence check of its own. A probe run from inside the worktree, seconds before the real call, proves nothing about the instant the real call executes — it cannot out-run a credential that dies in that window — so it buys the role nothing the real call's own typed failure doesn't already tell it, at the cost of one more command for the guard below to reject.

Why this is structural rather than a phrasing fix, the guard-collision incident that hit the sanctioned form itself, and the resulting falsification note — history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted (ADR-0040).

### The traps — why the unsafe forms do not look unsafe

- **`${VAR:-fallback}` substitutes the VALUE. It is not a presence test; it only reads like one.** The `:-` operator means *"use this default **when the variable is unset**"* — so on the branch that actually matters, the branch where the variable *is* set, the expansion evaluates to the variable's own contents. `echo "${GITHUB_TOKEN:-no}"` prints `no` only on a machine with no token; the instant there is one, it prints the token. Everything about the expression argues that it is safe: it is *shaped* as a yes/no question, it *names* a harmless literal, and the harmless literal is exactly the branch that never fires where the secret lives. Reading it does not reveal the bug — you have to know the operator.
  - **`${VAR:+yes}` (the `+` form) is genuinely value-free**, which is what makes the compound `${VAR:+yes}${VAR:-no}` the most convincing version of the trap: the first half really does print `yes`, so the output *starts* correct and looks like it worked, and the second half appends the live key right behind it. This is the form that fired live on 2026-07-27.
  - Prefer `[ -n "$VAR" ] && echo set` over *any* parameter-expansion form. Do not try to remember which of `:-` / `:+` / `:=` / `:?` are value-free — one sanctioned form, memorized, beats a rule you have to re-derive under time pressure.
- **Whole-environment dumps are not safe.** `printenv`, a bare `env`, a bare `set` — each prints every set variable, secrets included, regardless of which one you meant to check. `printenv GITHUB_TOKEN` is *worse*, not better: it targets the secret directly.
- **Reading a gitignored settings/secrets file is not safe.** `cat .claude/settings.local.json`, any `.env`-class file, or any other read-shaped command (`less`, `head`, `tail`, …) against one — "just to check a config precedent" is not an exemption; the file's contents land in tool output the instant it is read, live credentials included.
- **The constraint is on tool output generally, not on any enumerable command list.** A brief that never asks for `${VAR:-no}`, a `printenv`, or a `cat` of a gitignored settings file can still be defeated by any role free-styling a diagnostic mid-task. Tool output must never contain a secret — full stop — whether it originates from brief-scripted bash, an agent's improvised check, or a Coordinator's one-liner between two engine calls.

### Post-indirection — never execute the Lookup-Command (ADR-0029 amendment)

ADR-0029 changes what "the secret" is made of on an adopted consumer: a credential resolves through a per-project **Lookup-Command** (the `<VAR>_CMD` environment variable — `GITHUB_TOKEN_CMD`, `LINEAR_API_KEY_CMD`, `BITBUCKET_TOKEN_CMD`) before it falls back to the ambient variable. That command's stdout **is** the secret, so the doctrine above extends to it unchanged: **no role in this pipeline executes a configured `<VAR>_CMD` command outside the engine** — not to "see what it prints," not "just for diagnostics." The sanctioned alternative is the engine's value-free preflight probe — the same-shaped check as the presence test above, run by the auth preflight (`wave-start` step 4, `wave-close` phase 2) rather than typed by hand: it confirms the lookup resolves, exit status only, and never surfaces the output.

The `BITBUCKET_TOKEN_CMD` discovery-list incident this indirection was tightened against, and why closing this vector is a structural gain rather than one more clause — history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted (ADR-0040).

### The structural anchor — settings-deny (Convention 8 hardening)

The first three live occurrences below each found a vector the previous occurrence's prose hardening hadn't named — the class does not depend on which specific command a role reaches for, so a fix that depends on having read and internalized a clause was never going to hold structurally. The fix that does not: tracked **`permissions.deny`** entries in `.claude/settings.json` blocking the `Read` tool — and, as far as the permission syntax can express it, Bash's read-shaped command forms (`cat`, `less`, `head`, `tail`, `more`) — against the gitignored secret-bearing files themselves (`.claude/settings.local.json`, `.env`-class files). This is the **structural backstop** for the *file-read* vector; the brief clause above (`workerBrief()`'s policy clause 5) stays as **defense-in-depth** on top of it. `wave-setup`'s tracked-settings scaffold (`.claude/skills/wave-setup/reference/setup-mechanics.md`) carries the identical deny entries for every consumer, so a fresh consumer repo inherits the anchor at bootstrap rather than only after its own live occurrence.

### The structural anchor — Lookup-Command deny (ADR-0029)

The direct-execution vector gets the same fix in kind. ADR-0029 has `wave-setup` scaffold a second tracked **`permissions.deny`** entry in `.claude/settings.json`, blocking the Bash tool against the exact `<VAR>_CMD` command prefix it scaffolds for this consumer — the engine's own `child_process` spawn inside an allowlisted CLI invocation is untouched (no conflict); the deny reaches only a role typing the command itself. This is the **structural backstop** for the *direct-command* vector, the same division of labor as the file-read anchor above: the deny entry is the backstop, the never-execute clause stays as **defense-in-depth** on top of it. `wave-setup`'s tracked-settings scaffold (`.claude/skills/wave-setup/reference/setup-mechanics.md`) is the channel — the same scaffold that writes the `<VAR>_CMD` entry and the matching keychain item also writes this deny entry, so every consumer inherits this anchor at setup time, the same way it already inherits the file-read anchor.

### Can a permission-level rule anchor the *echo* vector the same way? — assessed: no

The full assessment — three independent reasons the permission layer cannot express this vector at all, and the two candidates it left behind, both since decided and built (Post-indirection above; the Echo-Guard below) — history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted (ADR-0040).

### The structural speed bump — the PreToolUse Echo-Guard (decided)

`tools/wave/hooks/echo-guard.cjs` is a zero-dependency CommonJS matcher over a Bash tool call's **command string**, run before the command executes — a `PreToolUse` hook, decided over the permission-level alternative assessed above. The hook's four composed families, its hard-block-with-teaching-message and fail-open-on-crash design, its false-positive budget, and the distribution history that met its universal-rollout gate — full design narrative: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted (ADR-0040). **The honest scope survives the decision — this is a speed bump, not an anchor.** It is a *text* matcher over the command, so `V=GITHUB_TOKEN; echo "${!V}"` walks straight past it, and so does any deliberate string assembly; **passing the guard is not evidence that a command is safe.** Two vectors are deliberately not the guard's at all: reading a gitignored settings/secrets file (the settings-deny anchor owns it) and the *direct* Lookup-Command invocation (the ADR-0029 deny entry owns it).

### Live occurrences (evidence) — eight, in nine days

The first three each found a *new vector* (a flawed `${VAR:-no}` echo, a `printenv` whole-environment dump, a Reviewer `cat`-ing a gitignored settings file); occurrences four through eight found no new vector at all — only a new addressee (the Coordinator, twice) and repeats of a vector already named. That distribution is what the "What the count is evidence about" analysis in the evidence sidecar draws on (history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Brief-side closure

Why the Reviewer brief needed this convention's base clause stated explicitly, not only pointed at — the one role with a recorded occurrence of the vector was the one role not briefed against it — and when that gap closed (history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted, ADR-0040).

### What the count is evidence about

Why eight occurrences in nine days is read as a fact about the mechanism, not about eight operators, and what that reading prescribes instead of a ninth clause (history: `../evidence/convention-08-secret-safe-briefs.md`, read via the sibling-path read when actually wanted, ADR-0040).
