# Capability matrix — tracker × code host

A consumer choosing flotilla needs one table that says what they get with which tracker
and which code host, and what they do not — instead of reading [ADR-0023](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md)'s
amendments to learn that Bitbucket cannot arm.

**Rule for every cell below: a dated fact or `verify` — never a guess.** A cell that
reads a plain checkmark or a plain description is a fact carried by a decision record
cited in this document's own history (readable in `git log -p` on this file) or restated
here with its date; a cell that reads `verify` names the read or run that would settle
it. Later, as a sibling: generate this table from adapter-declared capabilities so it
cannot drift out from under the code — this hand-authored version is enough to launch
on.

## Tracker (issue store)

| Capability | GitHub Issues | Linear | Markdown files (local) |
| --- | --- | --- | --- |
| Claim ledger `queued / in-flight / in-review` | `wave/*` labels | workflow states, config-mapped (the board *is* the ledger) — [ADR-0020](adr/0020-linear-claims-live-in-workflow-states-triage-vocabulary-stays-labels.md) | status line |
| needs-attention flag + question payload | label + structured comment | label + structured comment | field + block |
| Wave-eligibility marker (configurable OR-set) | labels | labels | status |
| Triage states | labels | labels (+ `Canceled` for unplanned — ADR-0020) | status line |
| PRD as a document | issue with `prd` label | native Linear Document — [ADR-0017](adr/0017-linear-document-facet-maps-to-a-native-linear-document.md) | `prd.md` beside the issues |
| Slice → PRD backlink (`Parent`) | ✓ (+ free forward cross-ref) | ✓ | ✓ |
| Blocked-by between issues | header + native issue dependency | header + native relation | header only; a dependency between two *bare* issues is refused as unrepresentable (`bare-blocked-by-unrepresentable`) |
| Goal container | Milestone (the only default a consumer convention can't collide with) | Project, or Initiative — [ADR-0044](adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md)/[ADR-0045](adr/0045-a-goals-members-are-the-containers-direct-native-members.md); no default, binding is explicit | goal file |
| Frontier (derived open remainder) | ✓ | ✓ | ✓ |
| Mirror pass (publish the frontier as a native update) | refuses typed — a Milestone has no native update surface (conformance-tested, [ADR-0046](adr/0046-the-mirror-pass-publishes-derived-accounting-to-the-containers-native-update-surface.md) dec. 5) | Project / Initiative Update — shipped **2.1.0 (2026-08-17)**, spec-proven; `verify`: CHANGELOG's own 2.1.0 entry flags the first *live-workspace* publish as still outstanding at release — confirm one has run since | refuses typed — no native update surface, same rule as GitHub |
| Closing evidence `merged / closed-unmerged / closed-unknown` | full (`Closes #N`) | full with the GitHub↔Linear integration installed; without it, every close reads `closed-unknown` → `host-pr status` + `doneState` fallback ([ADR-0023](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md) amendment) | never `closed-unmerged` (structurally cannot prove a rejection — [ADR-0020](adr/0020-linear-claims-live-in-workflow-states-triage-vocabulary-stays-labels.md) amendment) |
| Closing PR recorded on the issue | `Closed-by:` body line + native `Closes #N` | `Closed-by:` body line + native attachment (idempotent upsert by URL) | `Closed-by:` body line |
| Answer protocol ([ADR-0047](adr/0047-a-stops-answer-is-a-typed-disposition-bound-to-a-spine-anchored-ask.md), **designed, not yet built**) | structured comment; author association gate (`OWNER`/`MEMBER`/`COLLABORATOR`, or a configured allowlist) | structured comment; workspace member, not a guest | `## Answer` block; gated by file access |

## Code host (landing)

| Capability | GitHub | Bitbucket Cloud |
| --- | --- | --- |
| PR create (find-before-create) | ✓ | ✓ — account email + Atlassian API token over Basic auth; a Bearer-only access token is refused for `create`, naming `BITBUCKET_EMAIL` |
| **Arm** (PR lands itself when checks pass) | ✓ GraphQL `enablePullRequestAutoMerge`; needs the repo setting *Allow auto-merge* ON and a branch protection/ruleset with required checks (see the plan footnote below) | ✗ **no per-PR arming call in the REST API** — measured 2026-08-10 against Atlassian's own OpenAPI document; the vendor's own feature request for one, [BCLOUD-22062](https://jira.atlassian.com/browse/BCLOUD-22062), has stood open since **2022-07-29** (status "Gathering Interest," re-checked 2026-09-02). What exists instead is a *merge check* — "Allow automatic merge when builds pass," a branch restriction a **human** ticks and then triggers by clicking Merge while a build runs |
| Direct merge when already clean | ✓ | ✓ |
| What `--auto` does | arms the order-free rows; the overlapping tail keeps the advisory merge-order as the human playbook | merges the clean rows synchronously, refuses the pending ones (typed `not-allowed`) → same advisory-order tail; **`armed` is unreachable on this host**, so `--auto` is synchronous here, not deferred |
| Mergeability | native `mergeable_state` | derived — Bitbucket's PR payload carries no such field, so the adapter reads the merge-check sentence literally: zero reported builds against a required minimum reads `blocked`, never `clean` |
| Posture probes (allow-auto-merge, required checks, merge token) | ✓; a visible OFF grades `fail` when required checks are present, `advisory` when none are; `unknown` (below maintain/admin rights) never blocks | advisory grading only — a visible OFF names a UI affordance for a human, not an engine capability, so there is no misconfiguration to flag ([ADR-0023](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md) 2026-08-10 amendment) |
| Merge methods | merge / squash / rebase | merge / squash; `rebase` refused deliberately — Bitbucket's API has *two* rebase strategies (`rebase_fast_forward` / `rebase_merge`) where flotilla's vocabulary has one, and the adapter will not silently pick a history shape on an unrehearsable write |
| Required-check name comparison | ✓ (named contexts) | deliberately not — Bitbucket states the requirement as a **count**, never named contexts |
| Credential shape | `GITHUB_TOKEN`/`_CMD`: classic PAT `repo` scope, or fine-grained Pull requests + Contents (Read and write) | `BITBUCKET_TOKEN`/`_CMD` + `BITBUCKET_EMAIL`: Atlassian API token over Basic auth; **four scopes** — `read`/`write:repository:bitbucket` + `read`/`write:pullrequest:bitbucket` (re-measured 2026-08-15 against Atlassian's OpenAPI spec — the pull-request pair gates every landing call, not the repository pair alone). App passwords stopped working **2026-06-09**, removed **2026-07-28** |
| **Cross-repo / cross-host waves on one tracker** | proven **2026-08-17**: two repos on two different code hosts (GitHub + Bitbucket), one shared Linear tracker, sister waves coordinating a cross-repo blocker purely through store status | same evidence, same date |
| Live-proven | flotilla itself, 600+ PRs landed | `create` + `status` proven on an external consumer, 2026-08-17; `arm`/`merge` never live-run — that consumer moves its repo to GitHub in September 2026, at which point the Bitbucket evidence for `arm`/`merge` stops being obtainable there |

**GitHub plan footnote** (docs read 2026-09-02): arming needs a branch protection rule or
ruleset with required checks — a PR with nothing pending cannot be *armed*, it is simply
merged. Protected branches are available in **public** repositories on GitHub Free and
GitHub Free for organizations, and in public **and private** repositories only on GitHub
Pro, Team, Enterprise Cloud and Enterprise Server. So on a **private repo under a free
plan there is nothing to arm**: `--auto` degrades to the direct merge of already-clean
PRs — exactly the Bitbucket line above, reached by a different road. Merge Queue follows
the same availability line and flotilla does not use it either way (a paid dependency on
private repos, rejected as the standard path in [ADR-0023](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md)'s Considered Options).

## Boundaries

- **Bitbucket Data Center is deliberately not a column.** It is a different product with
  a different API family; flotilla has no adapter and no consumer for it. The
  *Enterprise* intuition maps there, not to Cloud Premium — Premium adds enforced merge
  checks and Merge Queues, neither of which gives the engine an arming call.
- Tools whose API exposes UI affordances rather than intent (Bitbucket's merge check,
  Jira's per-project ceremony) stay behind the community *adapter wanted* mechanic with
  the conformance suite as the contract — not built until a consumer brings them.
- Cells marked `verify` are settled by a doc read with a dated citation or a live run —
  never by assumption ([ADR-0045](adr/0045-a-goals-members-are-the-containers-direct-native-members.md)'s amendment is the lesson on record: a vendor's own
  schema being permissive is not evidence of what the vendor's API actually accepts, and
  the vendor's prose can mislead even when it is being read in good faith).

## Provenance

Cut for the public-step goal on 2026-09-02, checked here against the decision records on
`main`: [ADR-0023](adr/0023-landing-is-partial-arm-through-the-engine-host-seam.md)'s
2026-08-10 and 2026-08-15 amendments, [ADR-0020](adr/0020-linear-claims-live-in-workflow-states-triage-vocabulary-stays-labels.md),
[ADR-0017](adr/0017-linear-document-facet-maps-to-a-native-linear-document.md), and
[ADR-0044](adr/0044-a-goal-binds-a-native-container-and-derives-its-frontier.md) through
[ADR-0046](adr/0046-the-mirror-pass-publishes-derived-accounting-to-the-containers-native-update-surface.md).
Two corrections made against the drafting source: the Mirror pass's GitHub/Markdown cells
moved from `verify` to a stated refusal (both are conformance-tested, not merely
designed), and BCLOUD-22062's open date corrected from "2023" to its actual filing date,
2022-07-29 (re-checked live, 2026-09-02).
