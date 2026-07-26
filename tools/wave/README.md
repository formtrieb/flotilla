# @formtrieb/flotilla-engine

The pure-TypeScript orchestration engine behind [flotilla](https://github.com/formtrieb/flotilla), a portable, Claude-Code-native wave-orchestration toolkit. It owns the state machine, the file-conflict/parallelism math (`computeConflictMap`), the merge-order algorithm, the definition-of-ready (DoR) validator, and the schemas a Worker's report and a Reviewer's verdict must satisfy. It imports only `node:*`, `fast-glob`, and `micromatch` — no tracker, no code host, no agent-harness primitives — so it is harness-agnostic by construction. The tracker- and host-specific adapters (GitHub Issues, Linear, git-host PR routing, …) live in the parent flotilla repository, not in this package.

Ships as raw TypeScript source (`src/`) with no build step — `tsc --noEmit` is the type gate, both in this repository and for anyone consuming the package directly.

## Usage

Run any engine subcommand without installing anything:

```bash
npx @formtrieb/flotilla-engine <sub> [...args]
```

For example:

```bash
npx @formtrieb/flotilla-engine dor path/to/ISSUE.md
npx @formtrieb/flotilla-engine files-drift path/to/ISSUE.md <sha-range>
npx @formtrieb/flotilla-engine merge-order path/to/WAVE.md
npx @formtrieb/flotilla-engine host-pr status --branch <branch>
```

The full subcommand list, flags, and exit-code semantics are documented at the top of [`src/cli.ts`](src/cli.ts).

The CLI works with a plain, unmodified Node runtime — no setup step, no loader flag, nothing to install beyond the package itself. The shipped `flotilla-engine` binary brings its own TypeScript loader in-process before it does anything else, so this is true regardless of how the package was installed.

## Programmatic use

Importing the module entrypoint (`import … from '@formtrieb/flotilla-engine'` or `require('@formtrieb/flotilla-engine')`) is a different story: **that path additionally requires a TypeScript loader**, on top of the package itself. `main` points at raw `src/index.ts`, and a plain runtime deliberately refuses to strip types for files that live under `node_modules` — that refusal isn't something a consumer can configure away for a dependency. Without a loader, importing the package raises exactly this:

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for files under node_modules, for ".../node_modules/@formtrieb/flotilla-engine/src/index.ts"
```

Register a loader first and the same import resolves normally. `tsx` is already a dependency of this package, so it is already present in a consumer's `node_modules` once the package is installed — no extra install needed:

```bash
node -r tsx/cjs -e "console.log(Object.keys(require('@formtrieb/flotilla-engine')).length)"
# => 93
```

This was verified end to end against a **cold-installed tarball** — `npm pack` this package, `npm install` the resulting `.tgz` into a scratch project, then run the invocation above against that installed copy — not against a repo checkout, which resolves `main` differently (via the workspace's own dev tooling) and would not reproduce what a real consumer hits.

The reason for the split: the engine ships raw TypeScript with no build step, by design, so anything that imports it programmatically must bring the same type-stripping loader the CLI bundles for itself.

## Full documentation

This package is one half of flotilla's engine/adapter split (see the repo's architecture overview). For the wave lifecycle, the Claude Code skills that drive it, the tracker adapters, and the project's own conventions, see the main repository:

**[github.com/formtrieb/flotilla](https://github.com/formtrieb/flotilla)**

## License

Apache-2.0 — see [LICENSE](LICENSE).
