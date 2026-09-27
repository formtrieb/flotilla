# Environment note — one worked example, config validate's own verdict

Evidence class (issue #1051, ADR-0049 Amendment 2026-09-27 decision 5b): a config `config validate` actually ran against, not a re-derived shape. The rule itself — the three triggers, the bound, the operator's-yes-only gate — lives in [SKILL.md](../SKILL.md#scaffolding-the-tracked-sandbox-block-writesnetwork--the-capability-requirement-adr-0049) and [reference/setup-mechanics.md](../reference/setup-mechanics.md#the-live-gate--run-each-needs-bearing-command-once-inside-the-now-scaffolded-sandbox); this file is the execution proof, not a second copy of it.

## The accepted config

A `needs.network`-bearing command carrying one `environmentNotes` entry — the same esbuild-under-the-sandbox observation `setup-mechanics.md`'s `VerifyConfig` section already uses as its inline example value:

```json
{
  "store": {
    "kind": "markdown",
    "repoRoot": "/abs/path/to/repo",
    "slug": "2026-09-27-my-wave",
    "eligibility": ["ready-for-agent"]
  },
  "verify": {
    "profiles": [
      {
        "name": "engine",
        "appliesTo": ["src/**"],
        "commands": [
          {
            "command": "npm run build",
            "needs": { "network": ["registry.npmjs.org"] },
            "environmentNotes": [
              "esbuild's postinstall needs registry.npmjs.org even on a warm cache; fails with no output otherwise"
            ]
          }
        ]
      }
    ]
  }
}
```

Run for real (2026-09-27):

```
$ {{wave-cli}} config validate env-note-worked-example.json
ok: "env-note-worked-example.json" is a valid wave config (store.kind=markdown, store.eligibility: "ready-for-agent", verify: 1 profile(s), 1 of 1 verify command(s) declare a sandbox need)
$ echo $?
0
```

## The negative control — the bound refuses a 4th note, live

The same config, `environmentNotes` carrying a 4th entry — one past the bound `setup-mechanics.md`'s `VerifyConfig` section states (at most 3 notes, each at most 200 characters):

```
$ {{wave-cli}} config validate env-note-worked-example-refused.json
error: wave config "verify.profiles[0].commands[0].environmentNotes" (on the verify command "npm run build") carries 4 notes, more than 3 — environmentNotes is an optional array of at most 3 non-empty strings, each at most 200 characters (ADR-0049)
$ echo $?
1
```

Exit `1`, matching the Operator ruling of 2026-09-27 (ADR-0049 note): a bound violation refuses at `config validate` time, not at `2` (a usage error) and not silently accepted then caught only at load.

Both files are the two configs above, written verbatim, run through the same `config validate` this repo's own `wave.config.json` binding resolves to — no re-derivation, no restated shape.
