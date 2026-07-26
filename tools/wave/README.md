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

## Full documentation

This package is one half of flotilla's engine/adapter split (see the repo's architecture overview). For the wave lifecycle, the Claude Code skills that drive it, the tracker adapters, and the project's own conventions, see the main repository:

**[github.com/formtrieb/flotilla](https://github.com/formtrieb/flotilla)**

## License

Apache-2.0 — see [LICENSE](LICENSE).
