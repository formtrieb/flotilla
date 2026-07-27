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

If step 5 fails for a transient registry reason, re-run via `workflow_dispatch` rather
than cutting a second release. If it fails because the version already existed, the
version is spent — bump and start again from step 2.

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
