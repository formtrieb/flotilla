## Convention 13 — one Bash call per step; never fuse `cd X && <command>`

**Enforced by:** brief prose — `tools/wave/driver/wave-start-inflight.js` (the policy clause every dispatched role is handed; both mechanisms are the harness's own, so there is nothing here to promote this to).

**Two independent mechanisms in this pipeline break on the same input shape — a Bash command that fuses several steps with `&&`.** They are unrelated systems: a permission matcher and a worktree-isolation guard. What they share is only the shape that trips them, and their failure signatures are *opposites* — one stalls the wave loudly, the other drops a step in silence. That is why this is one convention naming both, rather than an aside in whichever brief met one of them first.

**The rule every dispatched role obeys: issue ONE Bash call per step.** Never glue a directory change onto the front of the command that matters. Where the tool accepts a directory flag, prefer it over a `cd` at all — `npm ci --prefix <dir>`, `git -C <dir> …`, `npx vitest run --root <dir>` — because for a dispatched role a preceding `cd` does not reach the next call at all, so splitting a fused command is only half a fix (see "Splitting is not always a preceding `cd`" below).

**What this is NOT about: a pipeline that is genuinely one step.** `… | jq -r '.url'`, `git diff --cached --name-only | xargs grep -l …`, `grep -c foo file | head` — one step, one call, correct as written. The target of this convention is **two steps glued together**: a setup step (almost always a `cd`) fused onto the step whose result you actually need.

### Mechanism A — the permission allowlist: a dialog nobody is there to answer

**The harness's tracked permission allowlist matches a compound Bash command per subcommand, never as a whole** — a `cd` fused onto an allowlisted command is never covered by that command's own entry, and the resulting dialog has nobody there to answer it mid-AFK-dispatch. The documented compound-command rule this rests on, its two `cd`-with-`git`/`cd`-with-redirect hazard cases, and the correction to an earlier mis-framing of the trigger (it is per-subcommand matching, not a first-token check) are in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Mechanism B — the worktree-isolation guard: a refusal, and a verification step silently dropped

**The harness's own worktree-isolation guard can refuse a compound Bash command outright as too complex to verify that it stays inside the dispatched agent's worktree** — no dialog, nothing pending, nothing run, and an agent handed that refusal is free to shrug and continue, dropping whatever step it was trying to run (the same family as [Convention 12](convention-12-no-command-in-a-shell-variable.md)'s half two: a step that did not run, leaving a record that reads as complete). This guard is not the permission system and nothing on the allowlist reaches its decision. The live occurrence that first wrote this mechanism down is in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Catalog — three shapes named in one wave's disclosure, live-reproduced in this dispatch

Refused/accepted command shapes, cited by name from `workflow-driver.md`'s briefs — each independently live-reproduced rather than asserted from a disclosure summary alone. The provenance (wave `2026-07-30-arm-and-wiring`, disclosure `256.4`) and what live reproduction found beyond the original three-word names are recorded at Entry 3 in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

**1. jq-piped capture with a `case`/`esac` guard** — not a fusion problem: a bare `case`/`esac` is refused categorically from an `isolation: 'worktree'` dispatch (the Worker role), not established as refused from one that lacks it (the Reviewer role) — the code pair, the scoped claim and the five-station evidence arc are in the evidence sidecar.

**2. Heredoc carrying a `{`/`}` near the head of its body** — **name and trigger both corrected 2026-09-21.** The entry used to read "heredoc spec append — refused only when a heredoc redirects straight to a file and its body contains `{`/`}`", and the redirect half is wrong. Re-reproduced across 22 probes in one dispatch, across three refused legs that are **not one body**. Two of them are: the same 46-B brace-bearing body was refused through `cat >> <file>` and through `cat` writing to stdout with **no redirect at all** — one body, two destinations, one answer. That pair alone is what establishes that **the redirect target is not part of the trigger**, and the conclusion rests on it. The third leg — `python3 -` reading its program from stdin — carried a *different* body (a ~75-B dict literal), so it cannot isolate the redirect; what it adds is that the tool is not part of the trigger either. Size is not it either (a 3,309-B brace-free append ran clean, as did a brace-free `python3 -` append), and braces outside a heredoc are fine (`echo '{ "sections": { … } }'` ran). **And "near the head" is not a crisp threshold.** The identical brace pair was refused at body line 8 / ≈370 B in and accepted at body line 8 / 475 B in; refused at body line 2 / ≈800 B in and accepted at body line 15 / 858 B in. Line depth and byte depth both move the answer and neither decides it, so **no brace-bearing heredoc can be predicted safe from its own text** — which is why the remedy is not a better heredoc. **Write the content with your file-editing tool instead:** it takes the path directly, creates the parent directory, involves no shell at all, and no occurrence on record has it refused. The driver's Worker brief (policy clause 11) now says so for every content write, not only inside its sidecar-write step. The full probe matrix, the two field occurrences it corrects, the one accepted brace-bearing shape that is nonetheless a dead end, and the drift in the harness's own refusal wording are in the evidence sidecar.

**3. Heredoc commit message** — a genuine fusion problem, confirming the original name: stage and commit as two separate calls — the code pair and reproduction detail are in the evidence sidecar.

**4. Fused directory-change-plus-test-runner** — accepted, not refused: mechanism (a) does not fire on every fused shape it could in principle apply to, so read the per-subcommand rule above as what mechanism (a) actually tests, not "any fusion prompts" — detail in the evidence sidecar.

**5. `for`/`do`/`done` loop** — refused whenever the loop body references the loop variable, confirming entry 1's `$VAR`-expansion discriminator on a loop's own binding rather than naming a new one — the code pair and full reasoning are in the evidence sidecar.

**Append future occurrences to this catalog, in the same shape — name, what was actually reproduced (not merely asserted), the working form if one was verified, occurrence citation — rather than opening a new prose clause.** [Convention 8](convention-08-secret-safe-briefs.md)'s catalogue treats an eighth secret-echo occurrence as evidence about the mechanism, not about whichever agent hit it eighth; treat a fourth refused shape here the same way — a mechanism finding, never an agent's mistake.

### The two signatures are not interchangeable — which is why both are named here

A dialog is loud and blocking; a refusal is quiet and non-blocking — and an agent that has met only one mechanism misreads the other's failure. The full walkthrough of what each misreading looks like, and why naming one mechanism and leaving the other implicit is how the second half stayed unwritten until 2026-07-29, is in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Why widening the permission allowlist is the wrong fix

The tempting patch is a `cd` entry in the tracked allowlist — do not add one. The four reasons it fails (splitting costs nothing; it would not reliably fix mechanism A either; it cannot touch mechanism B at all; the tracked allowlist ships to every consumer) are in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

### Splitting is not always a preceding `cd` — your cwd is a constant you observe, not state you set

**"`cd` in one call, the command in the next" assumes the working directory persists between your Bash calls. For a dispatched role it does not.** The cwd is **reset to the dispatch root before every Bash call** — the worktree root for a worktree-isolated role, the session cwd for one dispatched without isolation (the Scribe). Not "sometimes", and not "unless you check": a `cd` in call N is simply invisible in call N+1, so splitting a fused `cd X && <cmd>` into two calls does not put the command in directory X — it removes the fusion and leaves the command running in the wrong place, a quieter defect than the one it fixed. Because the reset target is identical for every call, the cwd is a per-agent CONSTANT: one bare `pwd` characterizes every Bash call the agent will make, which is what makes "verify the cwd once, never set it" a sound design rather than a hopeful one.

The three live reproductions this rests on (including the non-isolated-role datapoint that generalized it beyond the Worker, and the host's-own-tool-description caveat), and the Scribe's retired `cd`/engine-call split this repaired — a step that looked like it established a precondition while something else entirely was actually meeting it — are in the evidence sidecar (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).

```bash
# ✗ fused — mechanism A narrows the gate to "every part must qualify",
#   and mechanism B may refuse the shape outright
cd tools/wave && npm ci

# ✗ split, and therefore unfused — but the second call starts back at the
#   dispatch root, so `npm ci` runs in the wrong directory and the split has
#   bought nothing. Unfusing is not a remedy for the `cd` half.
cd tools/wave
npm ci

# ✓ one call per step, with the directory carried BY the command
npm ci --prefix tools/wave
git -C tools/wave status
```

Most tools have such a flag (`--prefix`, `-C`, `--root`, `--cwd`, `--project`, `--directory`). When one genuinely has none, **make the arguments absolute and leave the cwd alone**: a `cd` cannot reach the call that needs it, and fusing it on is refused or prompts. If what is left still depends on the dispatch root — a repo-relative command binding is the standing example — that is a **precondition**, not something a `cd` can supply: state it, observe it once with a bare `pwd`, and report a mismatch as the failure it is.

### Where the clause lives

- **This file**, under `wave-shared/reference/` — the loader contract reads *every* file in that directory (see `wave-shared/SKILL.md`, "Load every file under reference/"), so a `Convention 13` citation resolves for every back-half skill with **zero loader edits**. The Catalog section's shape entries — the refused/accepted forms `workflow-driver.md`'s briefs cite by name — stay here too, for the same reason: one place, reached by every citation, with zero loader edits when a row is appended. Each entry's own station tables, probe-by-probe transcripts and occurrence citations live in the sibling `wave-shared/evidence/convention-13-one-bash-call-per-step.md` instead, reachable from the entry's own pointer sentence via the ADR-0040 sibling-path read — not part of the per-wave load, but one read away when actually wanted.
- **[`wave-start-inflight.js`](../../../../tools/wave/driver/wave-start-inflight.js)** — the packaged driver asset, the text dispatched agents actually receive, and therefore the site that matters most: the rule is a numbered policy clause in `workerBrief()`, a workspace-setup clause in `reviewerBrief()`, a directory-flag clause on the Worker's verify gate, and — at its original site — `scribeBrief()`'s step 1, which **no longer `cd`s at all**. That step is now a bare `pwd` against the compose-time repo-root literal, with the retired `cd`-then-engine-call split named in place as a dead end so it cannot be re-adopted; the driver's own §The Scribe's cwd carries the reasoning, and the `pwd` step in both Worker workspace-setup templates states the same invariant (one observation, valid for every later call). Both `workerBrief()`'s policy clause 11 and `reviewerBrief()`'s Convention 13 paragraph now also point at the Catalog above by name, so a Worker or Reviewer facing a refusal that matches a cataloged shape finds what was actually verified to work — not merely "split it" — without re-deriving it mid-dispatch. `workerBrief()`'s Termination steps 3–4 also stopped USING the refused shapes: they no longer capture a PR URL into a shell variable at all — the create runs bare and a separate `host-pr status --branch` re-query confirms it (Catalog entry 1, station 4). The `if`-form that briefly stood there was station 2, and it is named in the arc as a dead end so it cannot be re-adopted as a fix.
- **`workflow-driver.md`'s `ISSUES` row template** — the `depsSetup` example, which used to *teach* the fused `cd <depsDir> && <installCmd>` form to every Coordinator composing a wave, and now shows the flag-carrying form.

### Common Mistakes

- **Fusing `cd` onto an allowlisted command because the command is allowlisted.** The allow entry covers that subcommand only; the `cd` must qualify on its own, and with `git` or a redirect on the other side it does not.
- **Reading a "too complex to verify" refusal as "this check cannot be run here" and dropping the step.** It is a statement about the command's shape, not about the check. Re-issue as separate calls.
- **Adding a `cd` entry to the tracked allowlist.** It buys a habit, not a capability — and leaves mechanism B firing anyway (see the evidence sidecar's four reasons).
- **Assuming a preceding `cd` survives into your next Bash call.** In a dispatched-agent thread it does not — the cwd is reset to the dispatch root before every call. Carry the directory in the command, or make the arguments absolute.
- **Reading "verify with `pwd`" as licence to keep the `cd`.** The `pwd` is not a check that a `cd` landed; it is the one observation of a constant you cannot change. If the answer is wrong, the fix is upstream (where the agent was dispatched from), never another `cd`.
- **Splitting a `cd X && <cmd>` and calling it fixed.** The fusion is gone and the command now runs in the wrong directory, silently. Live twice: `cd tools/wave` succeeded, and `npm ci` in the next call still ran at the worktree root.
- **Believing only `&&` counts.** The documented separator set is `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines — a `;`-joined pair of steps is the same shape wearing different punctuation.
- **Over-applying this to a single command's pipeline.** `… | jq -r '.url'` is one step. Splitting a genuine pipeline into two calls does not make it safer; it makes it broken.
- **Assuming a refusal means fusion, and that unfusing fixes it.** Catalog entry 1's arc is three counter-examples in a row: a lone `case`/`esac`, a lone `if`-guard on a variable, and a same-call capture-plus-guard were all refused with nothing to unfuse. Read the entry before re-deriving a split.
- **Handing a dispatched role a recipe that names a shell variable.** From an `isolation: 'worktree'` dispatch, any `$VAR` expansion is refused in any position — so the recipe cannot run, and the role is left to improvise the step it was supposed to follow exactly.

### Live occurrences (evidence)

The wave that turned a one-brief aside into this convention, the cwd-reset reproduction, the capture-guard collision that grew the Catalog's entry 1 to five stations, and the two further shapes the Catalog gained after it (a narrower-than-fusion heredoc, a refused `for`/`do`/`done` loop) — the wave-by-wave record behind the Catalog's own entries (history: `../evidence/convention-13-one-bash-call-per-step.md`, read via the sibling-path read when actually wanted, ADR-0040).
