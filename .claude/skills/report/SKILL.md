---
name: report
description: Use when a consumer's agent has a fully-analyzed finding ABOUT FLOTILLA ITSELF — a bug, a wiring gap, a dead pointer, doc drift — discovered while running the installed plugin/engine in a consumer repo, and it is ready to file upstream at flotilla's own public repo in the house format. Triggers on "report this to flotilla", "file this upstream", "this looks like a flotilla bug, not ours", "report this finding to the maintainers", "file an issue against flotilla".
---

# report

Compose a consumer-side finding **about flotilla itself** into flotilla's house
shape — Gap + Provenance — and, only on the operator's explicit confirmation,
file it as a bare issue at flotilla's own public repo
(`github.com/formtrieb/flotilla`). This is the composing half of the wave-retro
PRD's `external` finding-status transport: **transport stays human — no second
tracker binding.** The finding was found by *this* consumer's agent, running
*this* consumer's flotilla installation; the issue belongs on *flotilla's*
tracker, not this consumer's own.

Your job is the **judgment and the interview** — recognizing a flotilla-shaped
finding, gathering Gap and Provenance honestly, composing the house format, and
never filing without an explicit yes. There is no engine mechanics file to
offload to: this skill's engine surface is exactly zero (see Boundary below),
so unlike every other skill in this pipeline it never shells `{{wave-cli}}` at
all.

## When to use

- The operator (or your own investigation) has fully analyzed a bug, gap, dead
  pointer, doc-drift, or drift-guard miss **in flotilla's own plugin, skills, or
  engine** — not in this consumer's own code — and wants it filed where
  flotilla's maintainers will see it.
- The finding surfaced naturally while running an ordinary flotilla skill
  (`wave-start`, `triage`, …) in this consumer repo, and the consumer's agent
  is standing right next to the full context: the command that failed, the
  output it produced, the doc it contradicts.

## When NOT to use

- A finding about **this consumer's own repo or code**. This skill's only
  target is the flotilla project itself — never a general-purpose bug-report
  tool.
- An unanalyzed hunch. This skill **composes**; it does not investigate. Do
  your own investigation first — reproduce if you can, read the flotilla
  doc/skill/source the finding is about — so the Gap section can carry real
  evidence rather than a guess dressed as one.
- Anything this consumer's own `wave.config.json` / tracker already covers.
  This skill exists because an *upstream* finding has nowhere else to go — a
  finding about this consumer's own code goes through this consumer's own
  triage/`to-issues`, as always.

## Boundary — this skill touches flotilla's tracker, never this consumer's

This is the one rule that makes this skill safe to run inside an arbitrary
consumer repo. Read it before the procedure below.

- **Never shells `{{wave-cli}}` or any other engine verb.** The engine's
  tracker binding (`wave.config.json`'s `store`) points at *this consumer's*
  tracker — GitHub Issues, Linear, or MarkdownFs, whichever they configured.
  Filing upstream is a different repo and a different concern; growing the
  engine a second tracker binding is exactly the coupling the wave-retro PRD's
  `external` status and this skill both exist to avoid. Filing happens through
  the operator's own ordinary `gh` access instead (see Procedure step 4) — "no
  token sharing, no new credential surface," because a public repo needs only
  the credential the operator already has.
- **Never reads `wave.config.json`, `.claude/settings.local.json`, or any
  `.env`-class file.** Not even for the non-secret parts (`store.kind`,
  `engine.cli`) — those are exactly the two halves of "the consumer's
  engine/tracker binding," and this skill's whole safety property is that it
  never touches that binding at all, structurally, not merely "doesn't use it
  for filing." Every Provenance fact this skill needs instead comes from
  **asking the operator** (Procedure step 2) — the same agent that found the
  bug already knows what it's running.
- **Never reads a settings file or dumps an environment** to answer a
  Provenance question. Convention 8's value-free-evidence posture
  (`.claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md`)
  applies in full: no `${VAR:-default}`-style echoes, no `printenv`/`env`/`set`,
  no `cat` of a gitignored file, no pasting the contents of any settings file
  into the Gap's evidence — not even "just this one non-secret field." If a
  Provenance fact isn't already known, ask; don't go looking for it in a file
  that might also hold a credential.
- **Consent-first, structurally — not just as a policy note.** Every path
  through this skill that could result in `gh issue create` running passes
  through the single render-and-confirm step (Procedure step 3). There is no
  "operator seems confident, skip the render" shortcut and no default-yes: an
  unanswered, ambiguous, or declined prompt means **do not file** and the skill
  stops there, cleanly, with the composed text still available for the
  operator to paste anywhere else it might be useful.

## The house format

A filed report is deliberately a **bare** issue — title + `Gap` + `Provenance`,
no Header-Block, no eligibility label — the same existence-not-readiness shape
any wave-provenance disclosure gets (ADR-0027). Whoever triages it upstream
runs the identical premise-currency check any wave-provenance bare issue gets.

A filed report is written in **English** — the title and every authored line of
Gap and Provenance — regardless of the language the consumer session happens to
run in. flotilla's public repo, docs, and triage all operate in English; a
report in the session's language hands upstream triage a translation job first.
The conversation *around* the report (the interview, the render, the confirm
question) stays in whatever language the operator is speaking — only the
composed artifact is English. One exception inside the artifact: **verbatim
evidence stays verbatim** — quoted command output, error text, and doc excerpts
go in exactly as captured, whatever language they arrived in.

```markdown
> *This report was composed by an AI agent from a consumer session and filed
> only after the operator's explicit confirmation.*

## Gap

**Symptom:** one to three sentences — what was observed, plainly.

**Evidence:** the exact command(s) run and the exact output/behavior observed,
verbatim (scrubbed of secrets per Convention 8 below) — or the exact doc/code
citation (path + quoted excerpt) the finding contradicts. Observation, not
paraphrase: state what was measured, not what it probably means.

**Hypothesis** *(optional, only when not verified):* a possible cause or fix,
explicitly labeled as a hypothesis, never phrased as a settled diagnosis. Omit
this subsection entirely rather than let an unverified guess read as fact —
the later triage pass investigates fresh precisely because a confident-sounding
guess gets implemented as if it were true (ADR-0027's `filed:` rule, the #303
lesson).

## Provenance

- **Consumer form:** `installed` (the ordinary case — this consumer runs the
  published plugin + npm package) or `vendored` (this session is running
  flotilla's own source-form repo against itself) — CONTEXT.md's *Source form /
  Installed form* pair, "vendored" naming the engine layer specifically
  (ADR-0032).
- **Plugin version:** the flotilla plugin version this consumer has installed
  (`n/a — source form` if consumer form is `vendored`).
- **Engine version:** the `@formtrieb/flotilla-engine` version this consumer is
  pinned to (or the vendored `tools/wave` state, for `vendored`).
- **Store kind:** `markdown` / `github` / `linear` — which `IssueStore` this
  consumer's own `wave.config.json` selects. (Asked, never read — Boundary
  above.)
- **Harness:** Claude Code CLI, the Claude Code VS Code extension, or another
  driver, whichever this session is actually running under.
```

## Procedure

### 1. Confirm the finding is analyzed, not merely suspected

This skill does not investigate. If the finding is still a hunch, stop and
investigate first (reproduce it, read the flotilla doc/skill/source it touches)
— come back once you have a symptom and real evidence, not before.

### 2. Gather Gap and Provenance — interview, don't excavate

Ask the operator for whatever you don't already know from the conversation.
For Provenance specifically, **ask rather than inspect** — per the Boundary
above, this skill never opens `wave.config.json` or any settings file to find
the answer, even the non-secret parts. If the operator doesn't know a field
offhand (e.g. the exact plugin version), it's fine to suggest a value-free,
non-binding way *they* can check (e.g. "your `package.json`'s
`@formtrieb/flotilla-engine` devDependency entry would have the engine
version") — but you don't run that check yourself against config/binding
files, and an honest "unknown" is better than a guess.

Before folding any pasted command output into the Gap's evidence, scan it for
anything that looks like a credential, token, or secret value and strip it —
Convention 8's value-free-evidence posture applies to this skill's evidence
exactly as it does to every wave-shared brief.

### 3. Compose, then render — always, before any filing

Fill the template above completely. Then **render the entire composed issue,
verbatim, in the chat** — title, disclaimer line, Gap, Provenance, all of it —
exactly as it would be filed. Ask a plain, unambiguous question: *"File this at
`formtrieb/flotilla`? (yes/no)"*

- **Explicit yes** → proceed to step 4.
- **No, silence, an edit request, or anything else** → do not file. On an edit
  request, apply it, then re-render the *updated* text and ask again — the
  confirmation is always on the text that is about to be filed, never on an
  earlier draft.

### 4. File — only after step 3's explicit yes

File through the operator's own ordinary `gh` access, scoped to the public
repo by name — never through `{{wave-cli}}`, never through this consumer's own
store:

```bash
gh issue create --repo formtrieb/flotilla --title "<the confirmed title>" --body-file <path-to-the-confirmed-body>
```

Use `--body-file` (not `--body`) so the multi-line composed text survives
shell-quoting intact; write the confirmed body to a throwaway file first. On
success `gh` prints the created issue's URL — report it back to the operator.
On failure (auth, network, rate limit), report the error `gh` printed,
verbatim; do not retry with a different credential source and do not fall back
to reading any settings/secret file to "check what's configured" (Boundary,
Convention 8) — an operator-visible `gh` auth error is the correct outcome to
surface, exactly as it is when `gh` fails for any other reason.

## Common Mistakes

- **Filing without rendering first, "because the finding is obviously right."**
  Confidence is not consent. Every filing path goes through step 3's full
  render, no exceptions for a finding that looks clear-cut.
- **Treating a declined or unanswered prompt as a soft yes.** Only an explicit
  affirmative proceeds to step 4. Ambiguity means stop.
- **Reading `wave.config.json` or a settings file to "just grab the store
  kind."** Ask the operator. The Boundary section's point is structural: this
  skill never opens that file at all, not "opens it but doesn't misuse it."
- **Filing through the engine (`issue-store create` / `{{wave-cli}}`).** That
  writes to *this consumer's own* tracker. Upstream filing goes through the
  operator's own `gh`, against the named public repo, full stop.
- **Pasting raw command/tool output into the Gap without scanning it first.**
  A credential can ride along in output that otherwise looks harmless (a
  verbose log, a config dump). Scrub before it goes in the evidence.
- **Writing a confident diagnosis instead of an observation.** Only a
  *verified* causal claim belongs in the Gap as fact; everything else is an
  explicitly labeled Hypothesis, or omitted (ADR-0027's `filed:` rule).
- **Investigating from scratch.** This skill composes an already-analyzed
  finding; it is not a debugging tool. If the finding isn't analyzed yet, go
  analyze it, then come back.
- **Composing the report in the consumer session's language.** The interview
  and the confirm question follow the operator's language; the filed artifact
  does not — title, Gap, and Provenance are English (The house format above),
  with only verbatim evidence kept as captured.
- **Using this for a finding about the consumer's own repo.** Wrong tracker
  entirely — this skill's one and only target is flotilla's own public repo.
