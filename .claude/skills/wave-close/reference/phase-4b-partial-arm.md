# Phase 4b — `--auto` — partial-arm confirm + arm-and-exit (opt-in)

**Skip this whole section unless the Coordinator was invoked as `wave-close --auto`.** The default path is phase 4's printed order followed by a human merge. `--auto` is opt-in with human-confirm as the default posture (ADR-0005/0023); it never merges `main`, never fast-forwards, and never watches. When it is set, do **not** hand-merge the order-free rows in phase 4 — arm them here instead.

`--auto` is a **partial-arm**: the Coordinator presents **one confirm for this wave**, then hands exactly the **order-free** rows (those in *no* `## Conflict-Map` pair) to the engine's `host-pr arm` verb. The overlapping tail is **never armed** — its phase-4 advisory order stays the human playbook, so the ordered-landing strength survives automation.

**One confirm per wave — a table, one line per terminal PR:**

| Column | Source |
|---|---|
| **PR** | the row's PR URL (`read-closing`'s `prUrl`, or `{{wave-cli}} host-pr status --branch <branch>`'s `url`) |
| **row** | issue id + wave branch (sourced from the spine dispatch-log) |
| **verdict** | the Reviewer verdict (`approve` is the eligibility floor — below) |
| **conflict prediction** | **order-free** (in no `## Conflict-Map` pair → *will arm*) or **overlapping** (named in a pair → *not armed*; follow the advisory order) |
| **repo posture** | `host-pr preflight`'s `allow-auto-merge` + `required-checks` checks — the same on every store kind (below); on `unknown`, "posture unknown — the arm outcome decides" |

Then **one** confirm for the whole wave. On confirm → arm the order-free rows. On decline → arm nothing; fall back to the printed advisory order.

**Which rows arm — mechanical eligibility, no risk re-gate.** A row is armed iff **all** hold: Reviewer verdict is `approve`, it carries **no** `needs-attention` flag, it has an **open PR**, and it is **order-free** (in no `## Conflict-Map` pair, read from the spine section already in hand from phase 1). There is **no second risk gate at landing** — a `public-API-change` row already met its human STOP at verdict routing (the G3 guard in `route-verdict`); re-gating here would double-ask the same human. A row in any Conflict-Map pair is the overlapping tail: print it with the phase-4 advisory order, never arm it.

**Repo posture (the confirm's last column) — probed, never dictated (ADR-0023 amendment).** Run the **host-preflight** — the code-host posture probe. It is **store-blind**: no `--config`, detect-host-routed, so it gives a **real** answer on **every** store kind (github, linear, *and* markdown), because landing always happens on the code host. This is the W10-F1 fix: the store-preflight used to report these `not-applicable` on a linear store, leaving the arm outcome as the only truth (under a proxied sandbox, the tracked `env` block is the standing source for the proxy flag — wave-shared Convention 1; prefix `NODE_USE_ENV_PROXY=1` explicitly only where no tracked env block applies):

```bash
{{wave-cli}} host-pr preflight   # detect-host-routed; NO --config → { ok, verb: "preflight", host, checks: [ { name, status, detail }, … ] }
```

Read two checks:

- **`allow-auto-merge`** — the CI-repo precondition. `fail` (GitHub's default is OFF) *with required checks present* means a checks-pending PR **cannot** be armed; surface the check's `detail` (it names the exact fix) and land that row via the advisory order instead. `advisory` (OFF but no required checks) is fine — an already-clean PR direct-merges without it. `unknown` means the token cannot see the setting (below maintain/admin): never blocks, and the confirm says **"posture unknown — the arm outcome decides"**.
- **`required-checks`** — **report-only**, never a blocker. `advisory` with an `absent` posture (no CI) is a valid `--auto` repo: the confirm must state **"no required checks — confirming means immediate merge"** (honest — the click merges now, backed by the Worker's verify run and the Reviewer's independent one). A `present` posture → the armed PRs land themselves once those checks pass. `unknown` (the branch-protection read needs admin the token lacks) → the confirm says so; the arm intent is decided per-PR anyway.

**The probe is advisory — the arm outcome is the ground truth.** `host-pr preflight` informs the confirm; it never gates it. On any `unknown`, state "posture unknown — the arm outcome decides" and proceed: `host-pr arm`'s per-PR outcome (`merged` vs `armed` vs `refused`, below) is the authority a static probe cannot be (a behind/recomputing race is not probeable).

**Arm each order-free row through the engine host seam** (never raw `gh` — ADR-0023: every host write goes through `host-pr`), **requesting branch deletion** the same way phase 4's `host-pr merge --delete-branch` does (consumer KW-F6) — `arm` threads the identical `--delete-branch` flag, so a landing driven through this skill actually deletes the head branch on the paths that merge immediately:

```bash
{{wave-cli}} host-pr arm --branch <wave-branch> --delete-branch   # detect-host-routed; NO --config (landing talks to the code host, not the tracker)
# → { ok, verb: "arm", host, branch, method: "squash", outcome, prNumber?, prUrl?, reason, branchDeletion? }
```

`host-pr arm` itself decides the mechanism per PR — **checks pending → enable auto-merge** (GraphQL); **already clean → direct merge now** (REST). Read the `outcome`, and — with `--delete-branch` — what to expect of the branch per outcome:

- `armed` — auto-merge enabled; the PR lands itself when its checks pass. Nothing more this run. **Branch deletion is DEFERRED**: `arm` has no synchronous merge moment to delete from yet, so the request is recorded in `reason` rather than acted on — no `branchDeletion` key is present. Once the host completes the merge server-side, deletion depends on the repo's "Automatically delete head branches" setting (Settings → General → Pull Requests); flotilla cannot delete it from this call.
- `merged` — the PR was already clean and merged immediately (the no-required-checks / all-green case). **Branch deletion happens synchronously** here: the response carries `branchDeletion: { branch, deleted, error? }`. A failed delete is a reported degradation (`deleted:false`), never an arm failure.
- `already-merged` — idempotent no-op (a prior run armed/merged it). Safe on every re-run.
- `refused` — the host declined (branch behind `main`, `allow-auto-merge` OFF, or not mergeable). **Flag `recoverable-stop`** with the returned `reason`:
  ```bash
  {{wave-cli}} issue-store flag <id> --kind recoverable-stop \
    --question "auto-merge could not arm — <reason>; rebase then re-run wave-close --auto, or merge by hand" \
    --option rebase-and-retry --option merge-by-hand
  ```
  Rebase-train automation is M2 — `--auto` only arms; it does not rebase.
- `no-pr` — no open PR for the branch (should not reach here — an open PR is an eligibility floor). Report it.

**Arm-and-exit — no watch, no poll (ADR-0023).** After arming, do **not** wait for the armed PRs to merge. The host completes them server-side (this is exactly why arming was chosen — it survives a dead Coordinator). Proceed to phase 5 (done-reconcile) and phase 6 (archive) as on the default path, then exit. Whatever has not merged yet reconciles on the **next** `wave-close` / `wave-resume` touch (idempotent, archived spines included). **Accepted, documented latency:** an armed PR whose checks later *fail* is not watched — it surfaces only on that next touch, never live. State this; do not promise live monitoring.

Because `host-pr arm` may merge a clean PR **immediately** — possibly one of this wave's own rows — re-run the phase-4a pull after arming, before phase 5: the same self-repair discipline (W5-F3), now for server-side merges, so phase 5 reconciles against the merged engine and not the pre-merge one.

**Headless refuses `--auto` without explicit pre-authorization.** The per-wave confirm is a human click. A headless run (no human to answer it) must **never self-confirm**: `wave-close --auto` with no human present **STOPs** unless the explicit pre-authorization flag `--pre-authorized` was passed. `--pre-authorized` is the human's advance authorization and the **only** headless bypass of the confirm (ADR-0023). Without it, headless `--auto` prints `--auto needs a human to confirm the per-wave arm, or explicit --pre-authorized to proceed unattended` and stops before arming anything.

## Common Mistakes

- **Arming an overlapping row, or hand-merging one before checking `--auto`.** Only **order-free** rows (in no `## Conflict-Map` pair) arm; the overlapping tail keeps the phase-4 advisory order as the human playbook (ADR-0023). Arming a predicted-overlap row is the exact loss partial-arm exists to prevent.
- **Re-gating risk at landing.** Arming eligibility is mechanical — `approve` + no `needs-attention` flag + open PR + order-free. There is **no** second risk gate: the `public-API-change` human STOP already fired at verdict routing (G3). Do not re-ask.
- **Watching or polling after `--auto` arms.** Arm-and-exit (ADR-0023): the host completes merges server-side; a re-run reconciles late merges. An armed PR whose checks later fail surfaces on the next `wave-close`/`wave-resume` touch, not live — do not build a watch loop.
- **Letting a headless `--auto` self-confirm.** The per-wave confirm is a human click; headless `--auto` STOPs unless `--pre-authorized` was passed (the only headless bypass, ADR-0023). Never auto-answer the confirm.
- **Assuming `--delete-branch` deleted the branch on an `armed` outcome.** Only an immediate `merged` outcome deletes synchronously (`branchDeletion` in the response); `armed` defers the merge itself to the host, so deletion is recorded as deferred in `reason`, not acted on. Reading `armed` as "branch gone" is wrong until the host's own auto-delete setting (or a later reconcile) catches up.
