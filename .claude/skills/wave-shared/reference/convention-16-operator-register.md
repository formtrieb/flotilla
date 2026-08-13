## Convention 16 — user-directed output holds the operator register

**Three audiences read what this pipeline produces, and only one of them was ever written for.** The executing agent reads the skill prose. The maintainer reads the decision records and the retros. The **Operator** — the person at the live session — reads the agent's *own output*, and until this convention existed that surface was governed by nothing at all: it inherited the maintainer's vocabulary by default, because no rule said otherwise.

> **The register is a property of the output, not of the reader.** Every line an agent prints for the person at the session is operator-directed, whether the person is a first-time adopter, a consumer developer, or the maintainer who wrote the skill. There is no "they'll know what I mean" exemption — the register does not change with who is guessed to be sitting there.

This convention governs **what crosses to the human**. Skill prose keeps its load-bearing *why* and keeps its citations in the provenance positions Convention 14 assigns them; nothing about that changes. What changes is the sentence the agent actually types into the session.

### The five clauses

**1. Translation.** An internal reference never appears in operator-directed text: decision-record numbers, convention numbers, finding ids, wave slugs, retro paths, spec section markers. State the **one-line consequence** instead.

- ✗ `Row 3 is HELD per ADR-0036; see docs/retros/2026-08-13-consumer-w1.md (KW-F4).`
- ✓ `Row 3 is waiting for you: it needs a human decision before an agent may touch it. Nothing else in the wave is blocked by it.`

The test is mechanical: if the reader would have to open a file in *this* repository to understand the sentence, the sentence is not finished.

**2. First-use introduction.** A domain term the operator should meet gets a **half-sentence introduction at its first use per session**, then flows freely for the rest of that session. Not a glossary dump up front, not a re-introduction every time — once, where it first matters.

- ✓ `I'm opening a wave — one batch of issues that can safely run in parallel — for these four tickets.`
- Later in the same session: ✓ `The wave is dispatched.`

The mini-glossary below is the source for those half-sentences.

**3. Direct address.** Speak to the person: **"du" / "you"**. **Operator** is the *prose role term* used when writing *about* the role (in this file, in the glossary, in a decision record) — it is never the salutation, and the agent never addresses the human as "the Coordinator". The Coordinator is the **session**, never the person; a skill that writes "the Coordinator must decide" is naming the wrong party for a decision only a human can make.

**4. The operator block.** **Every skill run ends with an operator block** — three items, in this order:

> **What happened** → **where it lives** → **what you do next**

Each item names a place, a shape, or a consequence, never a bare status word. "Done ✓" is not an operator block; "the spine for this wave is written to `.flotilla/waves/<slug>.md`, four rows queued, nothing dispatched yet — say *start the wave* when you want the agents to run" is. The block is the one part of the run the operator is guaranteed to read, so it carries the whole handoff: a run that ends without it has told the person nothing they can act on.

**5. Language.** Operator-directed text **follows the operator's language**. Artifacts stay **English** — issues, pull requests, decision records, spine entries, commit messages, sidecars. The two are separate surfaces with separate audiences: a German-language session produces German output and English artifacts, and neither borrows the other's rule.

### The form switch — strict installed, pointer-tolerant in source

The register is not identical in both distribution forms, and the difference is bound to the form binding that already exists — there is no new signal, no flag, and nothing to configure:

| Form | Who runs it | Rule |
| --- | --- | --- |
| **Installed form** | every consumer (plugin + published engine) | **Strict.** No internal token reaches the operator. Ever. |
| **Source form** | flotilla's own repository, the only one | The plain text comes first and must stand alone; **one compact reference pointer may follow it**. |

Source form's tolerance is a *suffix privilege*, not a licence to write in the maintainer register: `…it only merges once the checks go green (ADR-0023)` is the sanctioned shape. `…per ADR-0023` is not — strip the pointer and nothing is left.

A consumer-repo operator who *wants* the pointers asks for them in the session. That is a conversation, never a configuration knob.

### The operator mini-glossary — the half-sentence for each term

These are the introductions clause 2 asks for. Use them close to verbatim; they are deliberately short enough to sit inside another sentence.

| Term | Half-sentence introduction |
| --- | --- |
| **Wave** | one batch of issues dispatched together because none of them touch the same files |
| **Spine** | the wave's own markdown file on this branch, holding what was planned and what has happened so far |
| **Worker** | a background agent that does one issue on its own branch, in its own copy of the repo |
| **Reviewer** | a second agent that re-runs the tests and judges the first one's work before anything is proposed for merge |
| **Operator** | you — the person the session is working for, and the one who decides at every stop |
| **HELD** | a row deliberately parked for a human decision; no agent will touch it until you release it |
| **arm** | switching a pull request to "merge itself as soon as the checks pass", instead of merging it right now |
| **claim** | a marker on a ticket saying this wave has taken it, so a second wave does not pick up the same work |
| **Disclosure** | something an agent found that was outside its own job, written down so it does not get lost when the wave closes |
| **needs-attention** | a flag on a ticket meaning something went wrong and a human should look, independent of how far the work got |

Anything not on this list still gets a half-sentence the first time it appears; the table is the settled wording for the ten that recur, not the boundary of the clause.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the long form and the glossary above.
- **A byte-identical short clause in every SKILL.md body**, all thirteen of them. It carries the register rule, the direct address, the form switch, and a pointer back here. It is planted from one source constant and a drift guard deep-equals every copy against it, so the thirteen cannot diverge.
- **The pointer is a sibling-path read** — `../wave-shared/reference/convention-16-operator-register.md`, resolved against the reading skill's own directory. That spelling is identical project-local, in a plugin clone, and in a vendored copy; it needs no namespace and no skill invocation, which is how the front-half skills (`triage`, `to-prd`, `to-issues`) reach this file without loading `wave-shared`'s schemas at all.
- **`wave-shared/SKILL.md`** — the number-allocation register's counter and its one-liner, so a reader who never opens `reference/` still meets the rule.
- **No engine, schema, or spine surface.** The runtime speech behaviour is prose, deliberately: what a guard can check is that the clause is *present and identical everywhere*, not that a sentence was written in the right voice.

### Common Mistakes

- **Printing the token and the translation.** `The row is HELD — it needs a human decision first.` is still a breach in installed form: the reader met the internal word anyway. Translate *instead of* naming, not *in addition to*.
- **Introducing a term in the operator block only.** By then the operator has read six paragraphs that already used it. First use means first use.
- **Ending on a status word.** "Wave created." satisfies nothing. Where the file is and what the person says next are two thirds of the block.
- **Writing the artifact in the session's language.** An issue body, a pull-request body, a spine entry and a commit message are English on every store and in every session; only the talking is translated.
- **Addressing the human as "the Coordinator".** The Coordinator is the session. Write "you" to the person, and "the Operator" only when writing *about* the role.
- **Treating the source-form pointer as the register.** The pointer is a suffix on a sentence that already works without it. If deleting the parenthesis leaves the sentence incomplete, the sentence was never in the register.
- **Assuming the reader is a maintainer because the repository is flotilla's own.** The form switch relaxes the *pointer* rule, not the plain-language one.

### Provenance

- **ADR-0039** — the decision this convention carries: the audiences, the five clauses, the form switch, the two structural guards it decides on (a descriptions guard over the frontmatter, and the clause drift guard over these thirteen bodies), and the rejected options — strict-everywhere with no switch, pointer-compromise everywhere, the full convention text copied into each skill. The decision record lives with the others under `docs/adr/`.
- **ADR-0040** — the sibling-path read this file's pointer rides. Cross-skill loading is a file read against the loading skill's own base directory; this convention's long form is its first non-execution consumer.
- **Triggered by the first fully-external consumer run** (2026-08-13, installed form, `linear` store, Bitbucket code host) and its three field reports. The audit that followed measured the cause rather than guessing at it: no skill carried any rule for addressing the human, the frontmatter descriptions a consumer meets first carried internal tokens, several skills addressed the human as the Coordinator, and report steps prescribed finding ids into human-read output. Convention 14 had already named the symptom — shipped prose reading as an internal diary — but governs citation placement inside skill *prose*; the agent's own output was ungoverned until this convention.
