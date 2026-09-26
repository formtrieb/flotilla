# `engine.cli`/`engine.install` — the symlinked-prefix mechanism, in full

Evidence class — moved out of [SKILL.md](../SKILL.md#engine-invocation-enginecli) and [reference/setup-mechanics.md](../reference/setup-mechanics.md#engineconfig) (issue #817, 2026-09-26) so the repo-relative-directory rule stays in both docs as its one-sentence form; this file is the mechanism and the measurement behind it, kept once instead of twice.

## The rule this backs

Any directory argument in `engine.cli`/`engine.install` (a `--prefix`, a `-C`, a `cwd`) must be written repo-relative — never as an absolute path. Absolute is not merely a style preference: reached through a symlinked scratch or temp root, it breaks `npm ci` outright.

## The mechanism

npm decides whether an install root is a plain node or a symlinked one with a single comparison in `@npmcli/arborist`'s `load-actual.js`: `normalize(prefix) === realpath(prefix)`. When the two differ, the ideal tree's root is built as a *link* at a `../../..`-shaped location the lockfile has no entry for — `validateLockfile` then reports `Missing: <basename>@<version> from lock file`, and the exit code is `EUSAGE`. The name in that message comes from `@npmcli/name-from-folder` — the prefix **directory's basename** — never from the manifest's own `name` field, which is why the error reads as an unrelated, nonexistent package rather than as a path problem.

## The measurement

Measured on npm 11.17.0, 2026-07-31 (issue #725). Positive and negative control on the *same* directory: reached as `/tmp/claude-501/…/tools/wave` (through the macOS `/tmp` → `/private/tmp` symlink) the install fails `EUSAGE`, `Missing: wave@2.4.0 from lock file`; reached as `/private/tmp/claude-501/…/tools/wave` it succeeds. A repo-relative prefix cannot reach the failing branch at all, because npm resolves it against the process's own working directory, which the OS always reports physically.

Two corollaries, both measured: no `npm ci` flag rescues the symlinked form (`--install-links`, `--install-strategy=nested`, `--legacy-peer-deps`, `--omit=dev` all still fail), and `npm install` "survives" it only by never running the lockfile-vs-manifest comparison at all — swapping the verb trades the guarantee away rather than satisfying it. The engine does **not** currently refuse an absolute path in an argument position (`normalizeEngineInstall` checks index 0 of the whole binding only), so this rule is on the author, not on the validator.

This mechanism is independently pinned, hermetically (no npm subprocess, no network), in `tools/wave/src/wave-config.spec.ts`'s `'the symlinked-prefix mechanism the install form avoids (issue #725)'` suite, and the install line's rule is re-documented beside the driver template's own copy of it in `tools/wave/src/compose-driver.spec.ts` — both outside this skill's declared Files globs, cited here for a reader who wants the mechanism re-verified independently of this prose.
