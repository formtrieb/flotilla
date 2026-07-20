# `needs-attention` is an orthogonal attention flag, not a coarse-ledger state

`needs-attention` is **not** a `coarse(fineState)` projection — it is an **orthogonal attention flag** that coexists with the coarse ledger (concretely, `wave/needs-attention` sits *alongside* `wave/in-flight` etc.: "in flight, paused, awaiting a human"). It is **set** when a STOP fires (recoverable) or a terminal failure occurs (`failed`/`abandoned`), and **explicitly cleared** on resolution. This dissolves the one-way-sink and category-error problems the coarse projection introduced — the Ur had no coarse layer, so a STOP was a pure in-session ping and resolution was the ordinary forward `transition()`; flotilla keeps that mechanism verbatim and only adds the flag's set/clear discipline around it.

## Behaviour

- **Recoverable STOP** (e.g. the hard-coded public-API approval, a blocking reviewer question): the fine state is **preserved** (paused at `reviewing`/`verdict-in`/`approved`). On answer → **clear the flag**; the wave continues via the normal forward transition and the coarse projection follows. There is **no reverse coarse transition** — the flag simply goes away.
- **Terminal failure** / `abandoned`: cleared by **dispositioning** — retry → `available`/`queued`; abandon → close (a `wontfix` triage decision); escalate → `ready-for-human` (out of the wave, the other Q3 category).
- **The flag carries a serialized payload** in a tracker comment: the **kind** (recoverable-STOP vs terminal-failure), the question/decision, and the available options. This is the **headless-async (mode II) bridge** — an async resolver reads the payload to tell "answerable" from "dead" and to know the choices, without a live session.

## Consequences

- The state machine's forward transitions are untouched; only the projection layer gains flag set/clear.
- Parallels ADR-0003 (orthogonal label dimensions) and ADR-0002 (one-way projection): `needs-attention` joins `available`/`done` as state that is *not* a written rung of the `queued → in-flight → in-review` ledger.

## Amendment — the write path is a `needs-attention` facet on `IssueStore` (P7.4 grill, 2026-06-19)

This ADR's original "no engine change" line is **superseded**: the flag's *read* side was modelled (`CoarseState` carries `needs-attention` and `read().status` gives it precedence), but no *write* path existed (`ClaimRung` is `queued|in-flight|in-review`; `coarse()` never emits the flag), so the set/clear was deferred to P7. P7.4 builds it as a **tracker-agnostic `needs-attention` facet on `IssueStore`** (`flag(id, payload)` / `clearFlag(id)`), parallel to the **Triage facet** (ADR-0015) and the **Document facet** (ADR-0011), realized per adapter through the `GitHubApi` seam — GitHub: a `wave/needs-attention` label (orthogonal to `wave/<rung>`) + the kind/question/options payload as a structured issue comment; MarkdownFs: a `**Needs-Attention:**` line + payload; Linear (M2): a label/state + comment. So the flag **and** its payload are tracker-visible to humans and concurrent waves (the point of the bridge), never `gh`-shelled by a skill, and covered by the cross-store conformance suite. The spine additionally records the pause so `resume` treats the row as paused. Set by: the cap=1 `re-dispatch-cap-exhausted` STOP (ADR-0005 amendment), a PR closed without merge (ADR-0005 amendment), and corrupt/orphan sidecars at `resume`.

## Considered Options

- **`needs-attention` as a 6th coarse-ledger column** (rejected) — a sticky one-way sink with no clear-on-resolution, and a category error (a paused issue's fine state still projects to `in-flight`).
