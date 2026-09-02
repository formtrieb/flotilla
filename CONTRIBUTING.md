# Contributing to flotilla

Thanks for considering a contribution. This document covers what a pull request
needs in order to land, how to file a bug or an idea, and where a design
decision gets settled before it gets built.

## Before you write code

flotilla lands every change the same way: a pull request against the
protected `main` branch. Nobody — not a person, not one of flotilla's own
automated agents — pushes to `main` directly.

Two automated checks run on every pull request and both must pass before it
can merge:

- **Engine Tests (vitest)**
- **Engine Typecheck (tsc)**

Run them yourself before opening a pull request:

```bash
npm ci --prefix tools/wave
npm test --prefix tools/wave
npm run typecheck --prefix tools/wave
```

Both need to come back clean — every test green, zero type errors. A
documentation-only change runs the same two checks: part of the test suite
reads the project's own docs and source for currency, so a page that drifts
from the code it describes can fail a test even though no code changed.

## Adding a tracker or code-host adapter

flotilla talks to an issue tracker (GitHub Issues, Linear, or local markdown
files today) and a code host (GitHub, with Bitbucket support in progress)
through two small, fixed interfaces. Supporting a new one means implementing
one of those interfaces — the orchestration logic that sits above them never
needs to change.

- The tracker-side contract is the `IssueStore` interface in
  [`tools/wave/src/adapters/issue-store.ts`](tools/wave/src/adapters/issue-store.ts).
- [`tools/wave/src/adapters/conformance/issue-store-conformance.ts`](tools/wave/src/adapters/conformance/issue-store-conformance.ts)
  is the actual contract in practice: every adapter, shipped or new, runs the
  identical suite unchanged, and passing it is what "implements the interface
  correctly" means here.
- A capability matrix (`docs/CAPABILITIES.md`) tracks, tracker by tracker and
  code host by host, which capability is proven and which isn't — every cell
  is a dated, verified fact, never a guess. If you're adding an adapter, add
  the cells for it there rather than leaving the gap implicit.

A tool whose API exposes a UI affordance with no equivalent call underneath —
a merge button with nothing a program can hit, say — isn't worth a half
adapter nobody can finish testing. Open an issue describing what's missing
instead, and it'll wait as a known gap until a real consumer needs it.

## Filing a bug or an idea

Use the issue forms under **New issue** — a bug report, a finding from
running flotilla in your own project, or an adapter/feature request. Each one
applies a `needs-triage` label so it reaches the same triage step everything
else does.

If you found the problem *while running flotilla inside another project* —
not this repo — and you have Claude Code with the flotilla plugin installed
there, the `report` skill will ask you for exactly the detail the "finding
from a consumer run" form wants, show you the composed issue before anything
is sent, and file it here only once you say yes. It's usually the fastest way
to get a well-formed report in front of the maintainers.

## What happens to your pull request

Every pull request that lands here — whether a person opened it or one of
flotilla's own background agents did — is checked the same way: an
independent, read-only pass that re-runs the commands above and works through
the change's acceptance criteria before anything merges. It never edits your
branch for you; it approves, asks for a specific change, or asks a question
that needs answering first.

## Design changes and decision records

A change to *how* flotilla works, not just what it does, usually deserves a
short written decision record before the code — it's much cheaper to settle
an approach in a paragraph than to re-litigate it in a diff. Stress-testing
the idea against the project's existing decisions and its own vocabulary
first (the `grill-with-docs` skill does exactly this, if you have flotilla
running here) is the fastest way to find out whether an earlier decision
already answers the question, or needs revisiting instead of being
duplicated.

The decision records themselves live in [`docs/adr/`](docs/adr/), one file
per decision, numbered in the order each was written.
[`docs/CHARTER.md`](docs/CHARTER.md) is the architecture overview that ties
them together — read it before proposing a change to a seam it describes.

## License

By contributing, you agree that your contribution is licensed under this
project's [Apache-2.0 license](LICENSE).
