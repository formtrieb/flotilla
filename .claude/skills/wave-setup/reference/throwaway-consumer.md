# Throwaway consumer — the quickstart, measured

The README quickstart is validated the way a stranger meets it: a throwaway repository under the organisation, the plugin from the marketplace, the published engine bound through `engine.cli`, this skill run for real, one one-row wave on a plain issue, and the repository deleted afterwards. What the run measures is the distance between the README text and the tool's behaviour, and the misfire counter of the validation wave — the pre-launch baseline for a stranger's first ten minutes. Re-run it whenever the quickstart text or this skill changes; the scaffold below is the first instance of the golden-wave mechanic (a generated fixture consumer per unproven cell of the capability matrix).

## The scaffold — create, seed, tear down

Everything here goes through `gh`'s **own** login, never the engine's `GITHUB_TOKEN` — the two are different credentials (SKILL.md, "`GITHUB_TOKEN` vs `gh`'s own auth"). The repository is public on purpose: on a Free-plan organisation, branch protection exists only for public repositories (docs/CAPABILITIES.md, the GitHub footnote). The seeded issue is deliberately **not** in wave shape — quickstart step 3 (`triage`) is what shapes it, and that step is part of what is being measured. Save the fenced block below as a shell script under the name its usage lines show, wherever you keep your own operator scripts, and run it with `bash`; it is kept here as text so the reference guards read it with everything else.

```bash
#!/bin/bash
# Throwaway consumer for a quickstart run — create, seed, tear down.
#
#   bash throwaway-consumer.sh create   <owner/name>   # public repo, protected main, auto-merge on, one plain issue
#   bash throwaway-consumer.sh teardown <owner/name>   # deletes the repo (needs the delete_repo scope on gh's login)
set -eu
CMD="${1:-}"; REPO="${2:-}"
[ -n "$CMD" ] && [ -n "$REPO" ] || { echo "usage: $0 create|teardown <owner/name>" >&2; exit 2; }
WORK="${TMPDIR:-/tmp}/throwaway-consumer"

case "$CMD" in
  create)
    if gh repo view "$REPO" --json name >/dev/null 2>&1; then
      echo "repo exists: $REPO"
    else
      gh repo create "$REPO" --public --description "Throwaway consumer for a flotilla quickstart run — delete after use" >/dev/null
      echo "created: $REPO"
    fi
    rm -rf "$WORK"; mkdir -p "$WORK"; cd "$WORK"
    git init -q -b main .
    printf '%s\n' '# quickstart-probe' '' 'A throwaway repository. flotilla'"'"'s README quickstart is being followed here, verbatim, to measure a stranger'"'"'s first ten minutes.' '' '## Notes' '' '- Nothing in this repository is meant to last.' > README.md
    printf '%s\n' '# Changelog' '' '## Unreleased' '' '- nothing yet' > CHANGELOG.md
    git add README.md CHANGELOG.md
    git -c user.name="quickstart-probe" -c user.email="quickstart-probe@users.noreply.github.com" commit -q -m "chore: seed the throwaway consumer"
    git remote add origin "https://github.com/$REPO.git"
    git push -q -u origin main
    echo "seeded main"
    # protected default branch: a pull request is REQUIRED (zero approvals — a throwaway has no reviewers;
    # `required_pull_request_reviews: null` would mean 'no pull request required' and let write users push
    # straight to main), no force-push, no deletion; no required checks (the repo has no CI).
    printf '%s' '{"required_status_checks":null,"enforce_admins":false,"required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}' \
      | gh api -X PUT "repos/$REPO/branches/main/protection" -H "Accept: application/vnd.github+json" --input - >/dev/null
    echo "main protected"
    gh repo edit "$REPO" --enable-auto-merge --delete-branch-on-merge >/dev/null
    echo "auto-merge on, delete-branch-on-merge on"
    # one plain issue — deliberately NOT in wave shape: the quickstart's step 3 (triage) is what shapes it.
    gh issue create -R "$REPO" \
      --title "CHANGELOG lists the seed commit under Unreleased" \
      --body "CHANGELOG.md says \"nothing yet\" under Unreleased, but the repository already has its seed commit (README and CHANGELOG). Replace that line with one bullet naming the seed. Only CHANGELOG.md changes." >/dev/null
    echo "seeded issue #1"
    echo "clone for the quickstart: git clone https://github.com/$REPO.git"
    ;;
  teardown)
    gh repo delete "$REPO" --yes
    echo "deleted: $REPO"
    rm -rf "$WORK"
    ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
```

What the scaffold does **not** do, on purpose: it creates none of the thirteen labels a GitHub store needs, installs nothing, writes no `wave.config.json`. Those are the quickstart's own steps, and pre-doing them would measure a different path than the one a stranger walks.

## The measured run — 2026-09-03

Operator-driven, on a long-lived interactive machine, in a plain terminal (not an editor's integrated session), against the README as published at `25f7679` and the plugin at 2.1.0 with the engine at 2.1.0. Repository: a throwaway under the organisation, created by the scaffold above and deleted on 2026-09-03 by the Operator through GitHub's own settings page once released — the same outcome the scaffold's teardown verb produces; the engine token has no delete scope by design, so the verb runs on the operator's own `gh` login.

| Quickstart step | Wall clock | What the text said | What the tool did | Resolution |
| --- | --- | --- | --- | --- |
| 1 — install the plugin | 01:59 start | two slash commands | as written | — |
| 2 — `wave-setup`, interview + install | | "installs the engine pinned into your repo" | the repo had no Node manifest; the skill added a minimal `package.json` pinning the engine at 2.1.0 plus its lockfile and measured `npm ci` in a scratch directory | as documented (the non-Node manifest path) |
| 2 — credential scaffold | | "scaffolds the credential lookup so no token ever lands in a settings file" | the keychain item already existed on the machine; the operator chose to reuse it; the lookup command resolved with no dialog; the committed settings carry `GITHUB_TOKEN_CMD` and no token value | as documented |
| 2 — store preflight | | "preflights the live tracker … preconditions" | `state-catalog` **failed**: the fresh repository had none of the thirteen labels; no engine verb creates them and no doc named the step; the operator created them from a `gh label create` loop after `gh auth refresh` | README step 2, ONBOARDING preconditions, SKILL.md step 6 and the store-preflight table now name the label set and the hand-off; #675 asks for an engine verb that creates the missing set |
| 2 — harness settings | | "writes the permission allowlist a wave needs to run unattended" | the harness declined the skill's file-write and file-edit on `.claude/settings.json`; the skill staged the file and the operator applied it with one `! cp` from their own prompt; the Echo-Guard copy into `.claude/hooks/echo-guard.cjs` needed the sandbox override | README step 2, ONBOARDING, SKILL.md step 9 and the scaffold section now describe the hand-off as the documented path |
| 2 — done | 02:20 | | `config validate`, `store-preflight`, `host-pr preflight` all exit 0 | **21 minutes** for step 2, of which the two hand-offs above are most |
| 2 — closing checklist | | | the skill reported "this repo has no issues yet" although the seeded issue existed — it read the eligible pool | SKILL.md step 11 now says "no wave-ready issues" |
| 3 — `triage` | 02:25 start | "`triage` works an existing issue into shape … carrying a declared file scope, a risk/worker classification, and acceptance criteria" | the first pass set the readiness state, the category and the acceptance criteria and then said the planning header was still missing; a second pass on the operator's word wrote the header (files, risk, worker) and the readiness check passed | README step 3 now describes the two passes |
| 3 — readiness check | | | the verify-profile gate said "no verify config supplied" although the config file was passed — it has no `verify` block, which is correct for a repo without a build gate, but the wording says the opposite | follow-up #676 (engine wording) |
| 4 — `wave-plan`, `wave-create`, `wave-start` | 02:35 start | as written | plan read-only (one candidate, parallel-safe, ~4 agents), create wrote the spine then the `queued` claim, start ran four agents in about five minutes: Worker `done` on one file, Reviewer `approve` 4/4, PR opened with the rendered verdict, one disclosure captured and resolved in the row | as documented |
| 4 — Reviewer agent name | | the driver names the Reviewer agent `wave-reviewer` | in the installed form the agent lives under the plugin namespace; the session had to use the namespaced name | follow-up #677 (wave-start driver) |
| 4 — worktree hygiene | | | the Worker's worktree under `.claude/worktrees/` showed as untracked in `git status` — the consumer's `.gitignore` scaffold did not cover it | the `.gitignore` scaffold now carries `.claude/worktrees/` |
| 5 — land the PR, `wave-close --auto` | | "Land the PRs, then `wave-close`" | with no required checks the arm is a direct squash merge (one confirmation for the wave); phase 4a pulled main and re-swept; phase 5 closed the issue with the four confirmed criteria; the spine was archived | as documented — the README's "land the PRs" is one of two routes, the `--auto` arm being the other |
| end | 03:00 | | | **61 minutes** end to end, steps 3–5 about 35 of them |

Misfire counter of the validation wave (the pre-launch baseline for the first ten minutes): **0 in the wave itself** — no engine usage error, no hook block across plan, create, start and close, self-counted by the consumer session's `wave-close` — and **3 during `wave-setup` before it**: one Echo-Guard block on the skill's own value-substituting probe, two classifier denials of the settings-file write. The two hand-offs this run turned into documented steps are exactly where those three sit.

Two things the run surfaced that are not README disagreements: `gh`'s own keyring login was invalid while the engine's token was fine — two credentials failing independently, exactly as SKILL.md's credentials section describes — and the interview itself, the part the README describes, took well under the ten minutes; the overrun is the two hand-offs.
