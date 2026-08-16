# goal — the frontier report

How to turn one `goal-frontier` answer into the status pass's report. The skill body owns the boundary (read-only, never a declaration); this file owns the **rendering**.

## What the engine answers

`issue-store goal-frontier <goalId>` prints one object:

```json
{
  "goalId": "7",
  "readings": [
    { "id": "412", "state": "done", "unresolvedBlockers": [] },
    { "id": "431", "state": "blocked", "unresolvedBlockers": [{ "issue": 412 }] },
    { "id": "433", "state": "unready", "unresolvedBlockers": [] }
  ],
  "counts": { "done": 1, "in-motion": 0, "blocked": 1, "actionable": 0, "unready": 1 },
  "open": [
    { "id": "431", "state": "blocked", "unresolvedBlockers": [{ "issue": 412 }] },
    { "id": "433", "state": "unready", "unresolvedBlockers": [] }
  ],
  "complete": false
}
```

- `readings` — one per member, in the order the container listed them. Every state key is present in `counts`, zeroes included, so an absent state reads `0` rather than nothing.
- `open` — the frontier itself: every reading that is not `done`.
- `complete` — `open` is empty. **A reported fact, never an instruction to act.**

**Derive nothing yourself.** The classification is the engine's, and re-deriving it from an issue list is how two answers to one question start disagreeing. Read the JSON and render it. **One vocabulary at every member granularity** (ADR-0045 decision 2): whatever the members are — issues under `milestone`/`project`/`goal-file`, projects under `initiative` — this is the one shape the engine ever answers. Read `GoalView.container` (`goal-read`) first if you need to know which: it decides how you TALK about `readings[].id` (an issue's title, or a project's), never how you read the JSON itself.

## The five readings, and what each one costs the reader

| Reading | Engine's rule | Say it to the operator as | The next move, and whose |
|---|---|---|---|
| `done` | closed on the tracker — a project's own `completed`/`canceled` status, the mirror of an issue's terminal state | "finished" | none |
| `in-motion` | carries a wave claim (or a needs-a-human flag raised over one); for a project member, ALSO the project's own `started`/`paused` status | "a batch has already taken this one" — or, for a project, "somebody moved it" | the batch holding it, or whoever moved the project |
| `actionable` | ready, unblocked, unclaimed — for a project member, at least one OPEN issue inside carries the eligibility marker | "ready to be picked up in the next batch" | the next planning pass |
| `blocked` | at least one dependency nothing has resolved | "waiting on X" — **name X** | whatever it waits on |
| `unready` | carries no readiness marker at all — an issue with no planning header, or a project with no eligible open issue inside (an EMPTY project reads this way too, for exactly the same reason a bare ticket does) | "still just a placeholder — nobody can pick it up until it is written up" | for an issue: sharpen it, `triage` then `to-issues`. For a project: triage and decorate an issue *inside* it — the project itself has nothing on it to sharpen |

Two rules the ladder settles, worth knowing before you second-guess a reading:

- **A closed member is `done` whatever else it still carries.** A stale claim or a stale flag left on an issue that later closed does not make it look like it is still moving.
- **A claimed member reads `in-motion`, not `blocked`.** It is somebody's problem right now; reporting it as blocked would invite a second batch to wait on it instead of seeing it move. `paused` reads `in-motion` for the same reason — `blocked` asserts a *named* unresolved dependency, which a merely-paused project does not carry — which is exactly why the native-state column below matters: without it, "paused" and "actively being worked" render as the same word.

## Under an initiative binding — render the native project state beside the reading

The frontier's five readings are the whole classification, but under `initiative` two DIFFERENT native project states collapse into `in-motion`, and the reading alone cannot tell the reader which:

| Native project state | What it contributes | Reads as |
|---|---|---|
| `completed` | the project's own terminal state | `done` |
| `canceled` | the project's own terminal state | `done` |
| `started` | a person is actively driving the project | `in-motion` |
| `paused` | a person parked the project — no NAMED blocker, so it is not `blocked` | `in-motion` |
| `planned` | nothing on its own — UNLESS an issue inside is itself wave-claimed, which reads `in-motion` regardless of the project's own status | `in-motion` if an issue inside is claimed, else whatever the OTHER issues inside decide — `blocked` / `actionable` / `unready` |
| `backlog` | same as `planned` | same as `planned` |

`goal-frontier`'s JSON does not carry this column — it carries the five-state reading only, per [goal-mechanics.md](goal-mechanics.md#pass-3--status). So render it from what you already know when you know it (you just moved the project, or the tracker is in front of you), and otherwise say plainly that the reading folds `started` and `paused` (and even, in the `backlog`/`planned` case, "nobody moved the project but a wave already claimed a row inside it") together: several different native facts can land on the same one word, and `in-motion` alone cannot tell the reader which. Naming the ambiguity is the honest rendering; inventing a specific native word the JSON never gave you is not — the same `actionable`-is-a-positive-claim discipline the unresolved-blocker rule below applies, one column over.

## Rendering

Report in this order. It is the order the reader needs, not the order the JSON arrives in:

1. **The headline.** The goal's name, and how many of its members are finished out of how many — and, if there are zero members at all, say that instead of a headline built on a zero denominator (see "Empty membership vs. completion" below).
2. **The distribution.** All five counts on one line, zeroes included — a state with nothing in it is a fact.
3. **Who is `unready`.** Name each one and say which sharpening step it needs: for an issue member, `triage` when the question is whether the work is real and answerable at all, `to-issues` when the work is understood and only its planning header is missing; for a project member, that the project itself needs an issue inside it triaged and decorated — the project has no header of its own to sharpen. This is the largest bucket on a fresh goal by construction, and it is the bucket a person can act on today.
4. **Who is `blocked`, and on what.** Name the blocker every time. `unresolvedBlockers` carries the references precisely so a blocked reading names what it waits on rather than merely asserting that it waits.
5. **Who is `in-motion`, and — under `initiative` — which native state moved them there when you know it.** Name them; they need nothing from the reader, but do not let "in-motion" imply a precision about `started` vs. `paused` the JSON didn't give you.
6. **The operator block.** What happened → where it lives → what you do next.

> **A blocker the store could not resolve counts as unresolved, never as clear.** `actionable` is a positive claim that *nothing* blocks the member, so an edge the store cannot see must never be able to counterfeit one. If a reading is `blocked` on something you cannot resolve to a live issue, say exactly that — do not present the member as free.

## Worked shape

> **1.0.0 — the contract freeze: 1 of 3 finished.**
> done 1 · in motion 0 · blocked 1 · ready to pick up 0 · still a placeholder 1
>
> **Still a placeholder (1).** "The second host's landing verbs" — it exists as a note and nothing more. It needs writing up before any background agent can take it: sort out what it actually asks for, then give it the planning header a batch needs.
>
> **Waiting (1).** "The credential seam survives a second code host" waits on the one above. Nothing to do until that one moves.
>
> **What happened:** I read the finish line's current state — nothing was changed. **Where it lives:** the container on your tracker holds the membership; there is no separate file. **What you do next:** the placeholder is the only thing standing still — say *triage that one* and we sharpen it.

## Empty membership vs. completion

`readings.length === 0` (equivalently: every `counts` value is `0`) and "every member is `done`" both derive `complete: true` — an empty remainder is empty either way — but they are not the same fact, and the report says which one it is looking at rather than leaning on the one shared word:

- **Zero members** (`readings.length === 0`): this goal has nothing filed or joined yet. There is nothing to say about progress, because there is no membership to have progress on — say so plainly ("this goal has no members yet") rather than rendering a "0 of 0 finished" headline that reads like an accomplishment.
- **Every member `done`** (`readings.length > 0 && complete`): this is genuine completion — go to "The empty frontier" below.

## The empty frontier

When `complete` is `true` **and `readings.length > 0`**, say three things and stop:

1. Every member is finished.
2. The remaining step is **yours**: close the container in the tracker.
3. Nothing was written — and there is nowhere for this station to write a "released" marker even if it wanted one.

**Never close the container, and never file a note beside it.** Goal state is the container plus this query, and nothing else: free prose beside a goal is exactly where a planning agent once wrote itself a release authorization and then executed against a live server. A freshly-minted, still-unpopulated container ALSO reports `complete: true` — an empty remainder is empty — which is exactly why "Empty membership vs. completion" above is checked first: reporting a genuinely empty goal with the three completion lines above would read as an accomplishment nobody earned.

## The mirror pass reads this same JSON, but renders it differently

`goal-publish-update` (Pass 4 — mirror; [SKILL.md](../SKILL.md#pass-4--mirror), [goal-mechanics.md](goal-mechanics.md#pass-4--mirror)) also derives from a `GoalFrontier`, and its receipt (`GoalUpdateReceipt.frontier`) is the exact shape documented above. **Its wording is not this file's wording.** The operator translations in the table above ("finished", "ready to be picked up in the next batch", "still just a placeholder…") are this station's own status-pass prose, chosen for the person driving this session right now. The mirror's anchor uses the engine's OWN fixed reader-facing words — `done` / `in motion` / `ready to pick up` / `blocked` / `awaiting sharpening` — chosen for a stakeholder reading a tracker timeline later, who may never open this skill at all. **Never reuse one table's words for the other pass's preview** — the exact anchor vocabulary, the per-member line shape, and the empty-frontier sentence the mirror publishes verbatim are in [goal-mechanics.md](goal-mechanics.md#pass-4--mirror), not here.

The two rules just above this section still hold identically for the mirror's anchor: a closed member reads `done` whatever else it carries, and a claimed member reads `in motion` rather than `blocked` for the same reason. Only the WORDS differ between the two passes' renderings — the underlying classification is the one ladder, read once.

(The mirror pass was designed under the working name "health write-mirror"; that name is retired — see [goal-mechanics.md](goal-mechanics.md#the-retired-name).)

## Where the design lives

The frontier's five readings, their precedence, and the deliberate absence of a close verb are recorded in [ADR-0044](../../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md). One vocabulary at every member granularity, the project-member fact mapping (`closed`/`claimed`/`eligible`/`unresolvedBlockers` per native project status), and workspace-wide `listGoals` under `initiative` are [ADR-0045](../../../../docs/adr/0045-a-goals-members-are-the-containers-direct-native-members.md). The mirror pass — which reads this exact `GoalFrontier` shape at write time but renders it in its own fixed words rather than this file's operator translations (see the section just above) — is [ADR-0046](../../../../docs/adr/0046-the-mirror-pass-publishes-derived-accounting-to-the-containers-native-update-surface.md). The classification ladder itself is engine code, in `tools/wave/src/goal-frontier.ts`, which documents the reason for each rung's position; the project-member fact mapping is in `tools/wave/src/adapters/linear/linear-issues-store.ts` (`goalProjectMemberFacts`).
