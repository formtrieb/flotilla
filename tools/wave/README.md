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
npx @formtrieb/flotilla-engine compose-driver --spine path/to/WAVE.md --out driver.js --anchor <sha>
npx @formtrieb/flotilla-engine route-tuple --spine path/to/WAVE.md --id <id> --iter 1 --report r.json --verdict v.json --anchor <sha>
```

The full subcommand list, flags, and exit-code semantics are documented at the top of [`src/cli.ts`](src/cli.ts).

### `compose-driver` — the dispatch driver, composed rather than transcribed

The Workflow dispatch script ships as a package asset, `driver/wave-start-inflight.js`, alongside the hooks. `compose-driver` reads it, fills its five compose-time constants and its per-row `ISSUES` array from the wave spine, the wave config and the issue store, and writes the finished script to `--out` — the file a Claude Code Workflow run takes as its `scriptPath`. It prints one JSON receipt naming the rows composed, each row's branch and model tier, the wave anchor, and the Reviewer agent name it derived. The file form is a deliberate departure from the harness's inline default: it keeps the composed script inspectable and replayable, and the file must sit inside the repo (the gitignored `.flotilla/tmp/`) where the session may read it — the harness refuses to start a workflow from a path it is not allowed to read.

```bash
npx @formtrieb/flotilla-engine compose-driver \
  --spine .flotilla/waves/<slug>.md \
  --config wave.config.json \
  --anchor "$(git rev-parse HEAD)" \
  --out /tmp/driver.js \
  [--plugin-manifest <plugin-clone>/.claude-plugin/plugin.json] [--reviewer-agent <name>] \
  [--coordinator-branch <b>] [--deps-setup "<install cmd>"] [--row-meta '<json>']
```

**The engine still calls no agent-harness primitive.** This verb writes a file; the harness runs it. The schema-validated-return guarantee that makes a dispatched agent unable to fabricate a result is a property of the driver script's own `agent({ schema })` calls, not of this package.

### `route-tuple` — the whole post-return sequence for one row, as one call

When a dispatched row returns its `{ report, verdict }` pair, landing it takes a fixed sequence: confirm the durable sidecars, route the worker outcome, route the reviewer verdict, render the verdict section, open-or-reuse the pull request, re-query the host for its URL, write the spine's row state and PR cell, and move the tracker rung to `in-review`. `route-tuple` performs that sequence in one process, in that order, and prints one JSON result naming every step and what it returned.

```bash
npx @formtrieb/flotilla-engine route-tuple \
  --spine .flotilla/waves/<slug>.md \
  --id <row-id> --iter 1 \
  --report .flotilla/tmp/<slug>/report-<id>.json \
  --verdict .flotilla/tmp/<slug>/verdict-<id>.json \
  --anchor "$(git rev-parse HEAD)" \
  --config wave.config.json \
  [--title "<pr title>"] [--base main] [--remote <url>] [--ruling "<operator reason>"]
```

Read `disposition` for the answer. `pr-created` landed the pull request and the rung; `re-dispatched` wrote the spine's row state and iteration bump and nothing else; `stop` reports the halt with its reason and performs no write at all — flagging the row for a human is a separate, deliberate call. Every step reports `performed` or `performed-before`, so re-running the verb on the same tuple reuses the open pull request rather than opening a second one, appends no second verdict section to its body, and does not re-transition a rung that already reads `in-review`.

### `--ruling` — the one round above the re-dispatch cap

A second changes-requested exhausts the re-dispatch cap and halts the row. The documented recovery is an operator ruling: fix the world, then re-run the **review only**, outside the cap, with the row's iteration bumped so the round's records land under it. `--ruling "<the operator's own reason>"` is what admits that round — on `route-tuple` and on the single `route-verdict` verb alike — and it is the only thing that opens an iteration above the cap.

```bash
npx @formtrieb/flotilla-engine route-verdict \
  --verdict approve --iteration 3 --risk mechanical --state reviewing \
  --ruling "<why this round exists, as the operator stated it>"
```

The flag takes a stated reason rather than a switch: a blank value, a bare token, or anything under three words is refused, so a ruled round cannot be produced without saying why it exists. Without the flag, an above-cap iteration stays refused with the message it has always printed. Cap accounting is untouched — a ruled approval reaches the state an ordinary approval reaches, and a ruled changes-requested lands back on the same cap-exhaustion halt, so a further round takes a further ruling. On a ruled round the printed result carries a `ruled` object naming the routing cell and quoting the ruling, which is what makes the round auditable from the output alone.

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
