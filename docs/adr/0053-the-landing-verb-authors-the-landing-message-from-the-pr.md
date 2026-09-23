# The landing verb authors the landing message from the PR, and a consumer may cede it to the host

flotilla chooses its merge *method* explicitly on every landing (`--method`, default `squash`), but it never chose the *message*. Both landing paths sent the host a method and nothing else, so the host composed the squash commit from its own repository setting. On GitHub's defaults that setting splits by commit count. A single-commit PR lands under **its commit's subject and body**, and a multi-commit PR lands under the **PR title** with **every branch commit message concatenated** as its body. This ADR makes the message a choice flotilla makes, the way the method already is.

## What was measured

Grilled 2026-09-23 from issue #935, against the landing verbs, both host adapters, this repository's own settings and its landed history.

- **The gap is on both paths.** A direct merge sends `{ merge_method }` and nothing else. Arming sends `enablePullRequestAutoMerge` a node id and a merge method, although that mutation accepts `commitHeadline` and `commitBody`. The Bitbucket merge accepts a `message` and is sent none.
- **The repository runs GitHub's defaults:** squash title `COMMIT_OR_PR_TITLE`, squash body `COMMIT_MESSAGES`.
- **The PR title flotilla authors mostly never lands.** Over the last 30 merged PRs, 23 of the 29 single-commit PRs landed under a subject that differs from their PR title. For example, #951 was titled *"Three residues around the staleness advisory…"* and landed as *"The staleness advisory's commit cap is pinned…"*. Meanwhile the pipeline invests in that title: a readiness advisory checks that it reads without issue numbers, `--pr-title` exists to override it, and the Worker brief tells the Worker the title is, *"on a single-commit squash, what lands on the default branch"*. That is the inverse of what happens.
- **#935's incident is the multi-commit half.** A Worker corrected a false sentence in a follow-up commit instead of amending a pushed one, which is the right move under the commit policy. The concatenated squash body then carried the false sentence and its correction into permanent history.

The fault is not length. It is that unreviewed text reached history unfiltered, while the one reviewed text, the PR body, did not.

## Decision

1. **The landing verb authors the landing message.** On every landing, whether direct merge or arm, and on every host, it sends a title and a body. The title is the PR's own title with the host's number suffix (` (#N)` on GitHub). The body is the PR's own body. This applies to every PR the verb lands, wave rows and Coordinator-direct PRs alike.
2. **The body is the PR body, verbatim.** It is the only text in the pipeline a Reviewer has read, it is the final and corrected state, and the Worker brief already asks for it to be *"the durable record"*. It carries the closing line, which does nothing on the default branch because the PR merge has already closed the issue.
3. **The message is read when the landing verb runs.** A direct merge reads the PR and merges at once. Arming hands the host the title and body it reads at that moment, and the host freezes them until the PR lands. `arm`'s result reports the frozen title and the body's byte length, so the caller sees what will land. An edit to the PR after arming is reached by arming again. Whether the host accepts a re-arm as a refresh, or needs a disable and re-enable, is measured by the implementation; the rule is the same either way.
4. **A consumer may cede the message to the host.** The landing verbs gain `--commit-message pr|host`, default `pr`, built exactly like `--method`, so the verbs stay store-blind and read no config. `host` sends no message, and the repository's own squash setting governs as before. The Coordinator composes the flag from a config key, `landing.commitMessage`, that only the skills read, and `config validate` checks its value. The case is a consumer whose history is machine-read, such as semantic-release, commitlint or a changelog generator, whose Worker commits follow a convention that flotilla's prose PR titles do not.

## Considered Options

- **Leave the message to the host and recommend a repository setting** (rejected). `wave-setup` would advise switching GitHub's squash title to the PR title, and the host preflight would flag a divergent setting. It costs no code and respects the repository. But it is GitHub-only, since Bitbucket has no such setting. It would also leave the pipeline's own title discipline, and the Worker brief's claim, true only for consumers who happened to follow the advice.
- **An empty body: title and number only** (rejected). This keeps history lean, but removes the *why* from `git log` and `git blame`. That record is exactly what this repository's long commit bodies already try to keep, from the wrong source.
- **A short engine-composed body, the PR body's first paragraph plus a link** (rejected). It is a new cutting rule with its own edge cases, in order to shorten a text whose length was never the defect.
- **No escape hatch** (rejected). A machine-read history would break silently, and the consumer would notice only when a release failed to appear.
- **`host` as the default, `pr` opt-in** (rejected). This keeps the brief's claim false for every consumer who does not know the switch exists.
- **A config key read by the verb itself** (rejected). The `host-pr` group is store-blind by design, and `--config` is accepted and ignored on every verb in it. The flag keeps the verb blind, and the skills, which already read the config, compose it.

## Consequences

- **Semver (ADR-0035):** Minor with a heads-up. A flag and a config key are added and nothing is removed. What lands in every consumer's history changes for the same input, and the release notes say so and name `landing.commitMessage: "host"` as the way back.
- **The Worker brief's title claim becomes true on both commit counts.** The brief is corrected in the same diff. It also says that the Worker's own commit messages no longer reach the default branch under the default, so the PR body, not the commit, is where the record goes.
- **The call sites that compose the flag:** wave-close's partial-arm and advisory merge-order steps, the close mechanics, and the host-landing-seam convention that every caller follows.
- **CONTEXT.md:** **Landing message** enters.
- **Rows:** one engine row carries the flag, both hosts, both paths, the frozen-message report on `arm`, and the re-arm measurement. A second row carries the config key, its validation, the skills that compose the flag, and the brief's corrected claim. The second consumes the first's flag.
- This record lands Coordinator-direct (ADR-0033: it closes no issue). The implementation goes through reviewed wave rows cut from #935.
