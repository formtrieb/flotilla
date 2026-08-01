# Releasing flotilla

Cutting a release is a **human action**. Nothing in this repository releases itself: no
push to `main` publishes anything, and no agent is authorised to perform the step that
does. This document is the procedure for the human.

## What a release consists of

Two manifests carry the same version number and are released as one unit:

| File | Artifact |
|---|---|
| `tools/wave/package.json` | the npm package `@formtrieb/flotilla-engine` |
| `.claude-plugin/plugin.json` | the Claude Code plugin |

They must never disagree. A consumer who installs the plugin at one version and the
engine at another gets a combination nobody has run.

## The one distinction that matters

**Pushing a git tag publishes nothing. Publishing a GitHub Release publishes to npm.**

`.github/workflows/release.yml` triggers on `release: published` and on
`workflow_dispatch` — and deliberately on nothing else, no `push:` trigger of any kind.
So:

- `git tag -a … && git push origin <tag>` → **safe.** Fires no workflow. A tag is just a
  marker, and it can be created after the fact for a version that already shipped.
- Publishing a GitHub Release (or dispatching the workflow by hand) → **irreversible.**
  It runs the gates and then `npm publish`. A version number that reaches the registry
  can never be reused, by anyone, ever.

Keep that asymmetry in mind at every step below. Tagging is cheap; releasing is not.

## Before you cut anything

A version already on the registry cannot be republished — the publish step fails and the
release is left half-done. Check what is actually out there first:

```bash
npm view @formtrieb/flotilla-engine versions dist-tags
```

If the version in `tools/wave/package.json` already appears in that list, **bump it
before doing anything else.** Do not tag first and discover this afterwards.

## Procedure

1. **Verify `main` is where you think it is** and that both gates are green on it.
   `Engine Tests (vitest)` and `Engine Typecheck (tsc)` are required checks, so anything
   merged has passed them — but a release is a bad moment to assume.

2. **Bump both manifests** to the new version in a single commit, and land it through a
   PR like any other change. `main` is protected; the release commit is not an exception.

3. **Update `CHANGELOG.md`** in that same PR. The entry describes what a consumer gets,
   including what is not yet proven — see the existing entry for the tone.

4. **Create the annotated tag** on the merge commit, and push it:

   ```bash
   git tag -a v<version> -m "flotilla v<version>" <sha>
   git push origin v<version>
   ```

   The tag name is `v` plus the exact string in the manifests — `v0.1.0-beta.1`, not
   `v0.1.0-beta`. The registry version and the tag must be greppable as the same thing.
   This step fires nothing; you can stop here and continue later.

5. **Publish the GitHub Release** from that tag, with the changelog entry as its body.
   **This is the irreversible step.** It fires `release.yml`, which re-runs both engine
   gates and then publishes to npm via the OIDC exchange.

6. **Confirm the publish.** The run log should show the gates passing and
   `npm publish` succeeding; `npm view @formtrieb/flotilla-engine versions` should show
   the new version, and the release should carry a provenance attestation.

7. **Close what the release resolved — nothing else will.** An issue whose fix reaches a
   consumer only by being published is resolved *by this release*, not by any pull
   request, and that is the one shape the close machinery does not handle on its own:

   ```bash
   # The engine call is this repo's own `engine.cli` binding, verbatim — releasing
   # flotilla happens here, in the source form, so it is not `flotilla-engine`.
   # Run it from the repo root with --config; from .flotilla/ the github store
   # resolves owner/repo off the wrong cwd remote.
   ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts \
     issue-store close <id> <bump-PR-url> --config .flotilla/wave.config.json
   gh issue close <id> --reason completed   # the state flip — do not skip
   ```

   The first command is deliberately not a native close (ADR-0005: for a wave row the
   merged PR's `Closes #N` does that job, and closing early would drop the claim while
   the merge is still in flight). A release-bump PR names no issues, so for these the
   flip has no other actor: the command exits 0, writes `Closed-by:`, and leaves the
   issue **open**. It looks like it worked. Twice now it did not — #339 at 1.0.0 and
   #397 at 1.0.1, both rescued by hand afterwards, which is why this step is written
   down. Afterwards `issue-store read-closing <id>` reads `closed-unknown`; that is the
   correct answer for an issue no PR references, not a defect.

   If the release resolves an issue that also wants a verification hop in a real
   consumer repo — anything the CHANGELOG listed as not yet proven — run it before
   closing, and record the evidence on the issue.

## If step 5 fails

Publishing the Release is what fires the workflow, and the workflow can fail in three
different ways once it starts — each calling for a different response. Confusing them
either burns a version number that can never be reused, or leaves a real defect in the
workflow for the next release to hit again.

**A — Transient registry failure.** A network blip or a registry-side hiccup, nothing
wrong in the commit or the tag. Re-run via `workflow_dispatch` rather than cutting a
second release.

**B — The version already exists on the registry.** The publish step is rejected
because that exact version number is already out there (the check under "Before you
cut anything" above exists to catch this earlier). The version is spent: bump it and
start again from step 2. Never re-run toward the same version number.

**C — A non-transient failure in the release workflow or the package itself.** Not a
network fluke and not a spent version — a real defect the gates didn't catch, surfacing
at the worst possible moment. This needs a code fix, and it is the one path here that
touches a tag you already pushed.

**Ordering: fix → merge → move tag → dispatch. Invariant protected: the tag names the
commit that was actually published — never a commit whose publish attempt failed.**

1. **Fix the defect** and land it on `main` through a PR like any other change —
   `main` stays protected even mid-release.

2. **Move the tag** you already pushed in step 4 onto the new commit:

   ```bash
   git tag -f -a v<version> -m "flotilla v<version>" <new-sha>
   git push origin v<version> --force
   ```

   This is the one place in this procedure where force-pushing a tag is correct. The
   commit the tag pointed at before never actually published — its publish attempt
   failed — so the tag never named published content in the first place; moving it
   onto the fix commit is what makes "the tag names what's published" true, not a
   break of it.

   **Side effect, immediate:** a GitHub Release is already published from this tag —
   publishing that Release is what triggered the failing run — and retargeting the
   tag underneath it demotes that Release to a **draft**, with an untagged-style URL.
   This is cosmetic; the npm registry has no idea GitHub Release objects exist. But
   the version's public release notes are now invisible until a human restores them
   (step 4).

3. **Re-fire the release via `workflow_dispatch`** — not by touching the Release
   object. This run publishes from the fix commit the moved tag now points to; confirm
   it the same way as step 6 above.

4. **Re-publish the demoted draft.** Once the real publish in step 3 has succeeded, a
   human opens the draft Release from step 2 and publishes it again, restoring it as
   the visible Release for this version. That action is itself a "Release published"
   event, so it **fires the workflow a second time** — on the same commit, already
   published successfully in step 3. This duplicate run reaches `npm publish` and gets
   rejected under failure mode B, one section up: the version already exists.
   **Expected. Harmless. Not a signal to re-run anything.** If a run goes red right
   after a tag move, check `npm view @formtrieb/flotilla-engine versions` before
   assuming something is actually broken — if the version is already there, this is
   that duplicate run, not a new failure.

Live occurrence: the `v0.1.0-beta.1` follow-up release took exactly this path. The
floating npm install this workflow does on purpose (`npm install -g npm@^11.5.1` — a
floor with no ceiling) had picked up a newer 11.x carrying two publish-time validations
`0.1.0-beta.0` never hit: a `bin` entry with a `./` prefix is silently stripped at
publish (the package would have shipped without its binary), and a prerelease version
is refused without an explicit `--tag`. The `--tag` rejection is what actually stopped
the run — before the bin-stripping could ship silently broken. Both were fixed in one
commit, the tag was moved onto it, `workflow_dispatch` completed the publish, and the
demoted draft was republished by hand exactly as described above.

## Two strings the registry matches literally

Neither is validated when the trusted publisher is saved, so a mismatch surfaces only
mid-release. Both are documented at length in the header of
[`.github/workflows/release.yml`](../.github/workflows/release.yml); in short:

- **The workflow filename** must stay `release.yml`. Renaming it breaks publishing until
  the trusted publisher on npmjs.com is edited to match. Edit the registry side first.
- **`repository.url` in `tools/wave/package.json`** must point at the repository this
  workflow runs in, or provenance is refused.

There is no registry credential anywhere in this repository, and the package is
configured on the registry to refuse token-based publishes outright. The only way in is
the OIDC exchange from that workflow. Do not add a token path "just in case" — that is
the thing the whole arrangement exists to prevent.

## Outstanding: `0.1.0-beta.0` shipped without a tag

The first release was published by a one-time bootstrap workflow (since retired and
deleted) rather than through the procedure above, so the version exists on npm with no
corresponding tag or GitHub Release.

The provenance attestation records the commit it was built from:

```
gitHead: 7faa60dee669184295d85b8f507df10188f68ab7
```

Creating the missing tag retroactively is safe — per the distinction above, a tag push
fires nothing:

```bash
git tag -a v0.1.0-beta.0 -m "flotilla v0.1.0-beta.0" 7faa60d
git push origin v0.1.0-beta.0
```

**Do not publish a GitHub Release from that tag.** `0.1.0-beta.0` is already on the
registry; a Release would fire the workflow, the publish would be rejected as a duplicate,
and the failure would look like a broken release pipeline rather than the expected
outcome it is. The next release from this repository is `0.1.0-beta.1` or later.
