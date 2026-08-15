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
  "open": [ "…every reading that is not done…" ],
  "complete": false
}
```

- `readings` — one per member, in the order the container listed them. Every state key is present in `counts`, zeroes included, so an absent state reads `0` rather than nothing.
- `open` — the frontier itself: every reading that is not `done`.
- `complete` — `open` is empty. **A reported fact, never an instruction to act.**

**Derive nothing yourself.** The classification is the engine's, and re-deriving it from an issue list is how two answers to one question start disagreeing. Read the JSON and render it.

## The five readings, and what each one costs the reader

| Reading | Engine's rule | Say it to the operator as | The next move, and whose |
|---|---|---|---|
| `done` | closed on the tracker | "finished" | none |
| `in-motion` | carries a wave claim, or a needs-a-human flag raised over one | "a batch has already taken this one" | the batch holding it |
| `actionable` | ready, unblocked, unclaimed | "ready to be picked up in the next batch" | the next planning pass |
| `blocked` | at least one dependency nothing has resolved | "waiting on X" — **name X** | whatever it waits on |
| `unready` | carries no readiness marker at all | "still just a placeholder — nobody can pick it up until it is written up" | sharpen it: sort it out, then write its planning header |

Two rules the ladder settles, worth knowing before you second-guess a reading:

- **A closed member is `done` whatever else it still carries.** A stale claim or a stale flag left on an issue that later closed does not make it look like it is still moving.
- **A claimed member reads `in-motion`, not `blocked`.** It is somebody's problem right now; reporting it as blocked would invite a second batch to wait on it instead of seeing it move.

## Rendering

Report in this order. It is the order the reader needs, not the order the JSON arrives in:

1. **The headline.** The goal's name, and how many of its members are finished out of how many.
2. **The distribution.** All five counts on one line, zeroes included — a state with nothing in it is a fact.
3. **Who is `unready`.** Name each one and say which sharpening step it needs: `triage` when the question is whether the work is real and answerable at all, `to-issues` when the work is understood and only its planning header is missing. This is the largest bucket on a fresh goal by construction, and it is the bucket a person can act on today.
4. **Who is `blocked`, and on what.** Name the blocker every time. `unresolvedBlockers` carries the references precisely so a blocked reading names what it waits on rather than merely asserting that it waits.
5. **Who is `in-motion`.** Name them; they need nothing from the reader.
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

## The empty frontier

When `complete` is `true`, say three things and stop:

1. Every member is finished.
2. The remaining step is **yours**: close the container in the tracker.
3. Nothing was written — and there is nowhere for this station to write a "released" marker even if it wanted one.

**Never close the container, and never file a note beside it.** Goal state is the container plus this query, and nothing else: free prose beside a goal is exactly where a planning agent once wrote itself a release authorization and then executed against a live server. A freshly-minted, still-unpopulated container also reports `complete: true` — an empty remainder is empty — which is the second reason the station only ever reports it.

## Where the design lives

The frontier's five readings, their precedence, and the deliberate absence of a close verb are recorded in [ADR-0044](../../../../docs/adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md); the classification ladder itself is engine code, in `tools/wave/src/goal-frontier.ts`, which documents the reason for each rung's position.
