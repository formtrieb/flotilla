import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * echo-guard.spec.ts — the executable specification of the `PreToolUse`
 * Echo-Guard (`tools/wave/hooks/echo-guard.cjs`, Convention 8, grill-settled).
 *
 * ## Why this spec SPAWNS the guard instead of importing it
 *
 * The guard is a zero-dependency CommonJS script that lives OUTSIDE `src/`
 * deliberately — it must sit clear of the settings-adjacent, agent-write-denied
 * paths so an AFK Worker can author it at all, and it must run under a bare
 * `node` with no transpiler in the loop. Spawning it drives the real
 * `PreToolUse` contract end to end: tool-call JSON on stdin, decision on the
 * exit code, teaching message on stderr. An in-process import would test a
 * function; this tests the hook.
 *
 * Every case passes an EXPLICIT child environment. The guard's family 1 and
 * family 4 are config-driven — they read the consumer's `<VAR>_CMD` entries at
 * hook runtime — so inheriting the ambient environment would make the suite
 * depend on whether the machine running it happens to have configured a
 * credential. Hermetic by construction instead.
 *
 * ## What a "reject" case asserts
 *
 * Exit code 2 (the blocking channel) AND the teaching message: it names
 * Convention 8, and it names both sanctioned alternatives — the value-free
 * presence test and the engine's value-free preflight probe. A guard that
 * blocks without teaching just moves the failure; a role that is told "no" and
 * not told "instead, this" reaches for the next unsafe form.
 *
 * ## Scope, restated so it is not overread
 *
 * The guard is a TEXT matcher over the command — a speed bump, not an anchor.
 * `V=GITHUB_TOKEN; echo "${!V}"` walks past it, and the last describe block pins
 * that honestly rather than pretending otherwise.
 */

const GUARD = join(__dirname, '..', 'hooks', 'echo-guard.cjs');

/**
 * The two `<VAR>_CMD` Lookup-Commands flotilla itself configures (ADR-0029).
 * Family 4 substring-matches on these VALUES; family 1 derives the credential
 * names `GITHUB_TOKEN` / `LINEAR_API_KEY` from these KEYS.
 */
const GITHUB_LOOKUP = 'security find-generic-password -a $USER -s flotilla-github-token -w';
const LINEAR_LOOKUP = 'security find-generic-password -a $USER -s flotilla-linear-key -w';

const CONFIGURED_ENV: Record<string, string> = {
  GITHUB_TOKEN_CMD: GITHUB_LOOKUP,
  LINEAR_API_KEY_CMD: LINEAR_LOOKUP,
};

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Feed one `PreToolUse` payload to the real script; return its decision. */
function runGuard(command: string, env: Record<string, string> = {}, toolName = 'Bash'): GuardResult {
  const payload = JSON.stringify({
    session_id: 'spec',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { command },
  });
  return runGuardRaw(payload, env);
}

/** Feed raw stdin bytes to the script — used for the fail-open cases. */
function runGuardRaw(stdin: string, env: Record<string, string> = {}): GuardResult {
  const result = spawnSync(process.execPath, [GUARD], {
    input: stdin,
    encoding: 'utf-8',
    timeout: 30_000,
    // Explicit env: PATH only, plus the case's own configuration. Nothing about
    // the developer's machine leaks into the assertions.
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Assert the blocking contract AND the teaching content of the message. */
function expectBlocked(result: GuardResult): void {
  expect(result.code).toBe(2);
  expect(result.stderr).toContain('[echo-guard] BLOCKED');
  expect(result.stderr).toContain('Convention 8');
  // Both sanctioned alternatives, every time — the teaching part of the message.
  expect(result.stderr).toContain('[ -n "$VAR" ] && echo set');
  expect(result.stderr).toContain('credential-probe');
  // And the honest-scope note, so nobody reads a pass as a safety proof.
  expect(result.stderr).toContain('speed bump');
}

function expectAllowed(result: GuardResult): void {
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
}

// ---------------------------------------------------------------------------
// 1. The catalogue — every live occurrence in Convention 8's evidence list
// ---------------------------------------------------------------------------
//
// One case per occurrence, spelled with that occurrence's LITERAL form. This is
// the regression net for the class the convention documents: eight occurrences
// in nine days, of which the first three each found a new vector and the rest
// found none at all.

describe('echo-guard — the Convention 8 catalogue, occurrence by occurrence', () => {
  it('W8-F1 (2026-07-20, publication wave, Worker): the ${VAR:-no} diagnostic echo', () => {
    expectBlocked(runGuard('echo "${GITHUB_TOKEN:-no}"', CONFIGURED_ENV));
  });

  it('W21-F1 (2026-07-22, runtime-residue-docs wave, Worker): printenv GITHUB_TOKEN', () => {
    expectBlocked(runGuard('printenv GITHUB_TOKEN', CONFIGURED_ENV));
  });

  it('W23-F1 (2026-07-23, ci-verify-setup-env wave, Reviewer): the gitignored-file read is NOT this guard\'s vector', () => {
    // Pinned deliberately as a PASS, and it is not a gap: the file-read vector
    // has its own structural anchor — the tracked `permissions.deny` Read and
    // `cat`/`less`/`head`/`tail` entries against `.claude/settings.local.json`
    // and the `.env` class. The guard owns the four ECHO families; duplicating
    // the deny anchor here would add a second place to keep in sync and close
    // nothing that is currently open. This case exists so the division of
    // labour is asserted rather than assumed — if someone later widens the
    // guard to file reads, this case fails and forces the decision to be
    // re-made explicitly.
    expectAllowed(runGuard('cat .claude/settings.local.json', CONFIGURED_ENV));
  });

  it('W28-F1 (2026-07-26, plugin-beta wave, Coordinator): W8-F1\'s exact form, six days later', () => {
    expectBlocked(runGuard('echo "GITHUB_TOKEN=${GITHUB_TOKEN:-no}"', CONFIGURED_ENV));
  });

  it('W28-F2 (2026-07-26, plugin-beta wave, Worker): straight through a clause naming the exact command', () => {
    expectBlocked(runGuard('printenv GITHUB_TOKEN', CONFIGURED_ENV));
  });

  it('DA-F11 (2026-07-27, first plugin-consumer wave, Coordinator): the compound :+ / :- form', () => {
    // The `:+` half prints a convincing `yes`, so the output STARTS correct and
    // looks like it worked; the `:-` half appends the live key right behind it.
    expectBlocked(runGuard('echo "${LINEAR_API_KEY:+yes}${LINEAR_API_KEY:-no}"', CONFIGURED_ENV));
  });

  it('the seventh occurrence (2026-07-28, after the convention rewrite bound every role): bare printenv', () => {
    // The occurrence that triggered this filing — per the convention's own
    // doctrine, the response to a recurrence is removing the affordance, not an
    // eighth reminder.
    expectBlocked(runGuard('printenv', CONFIGURED_ENV));
  });
});

// ---------------------------------------------------------------------------
// 2. Family 1 — any $-expansion of a credential-shaped name
// ---------------------------------------------------------------------------

describe('echo-guard family 1 — credential-name expansion', () => {
  it('blocks a BARE direct expansion of a credential-named variable', () => {
    const result = runGuard('echo $GITHUB_TOKEN', CONFIGURED_ENV);
    expectBlocked(result);
    expect(result.stderr).toContain('credential-name expansion');
    expect(result.stderr).toContain('$GITHUB_TOKEN');
  });

  it('blocks the braced spelling of the same expansion', () => {
    expectBlocked(runGuard('echo "${GITHUB_TOKEN}"', CONFIGURED_ENV));
  });

  it('blocks a credential-shaped name by SUFFIX even when nothing is configured', () => {
    // No `<VAR>_CMD` in the environment at all — the suffix classes still fire,
    // which is what makes the guard useful on a consumer before it adopts the
    // Lookup-Command indirection.
    for (const name of ['ACME_TOKEN', 'ACME_KEY', 'ACME_SECRET', 'ACME_PAT', 'ACME_PASSWORD', 'ACME_CMD']) {
      expectBlocked(runGuard(`echo $${name}`, {}));
    }
  });

  it('blocks the expansion wherever it sits — inside printf, node -e, a heredoc line', () => {
    expectBlocked(runGuard('printf "%s\\n" "$LINEAR_API_KEY"', CONFIGURED_ENV));
    expectBlocked(runGuard('node -e "console.log(process.argv[1])" "$GITHUB_TOKEN"', CONFIGURED_ENV));
    expectBlocked(runGuard('git commit -m "token was $GITHUB_TOKEN"', CONFIGURED_ENV));
  });

  it('blocks a second, unsanctioned expansion that rides along with a sanctioned presence test', () => {
    // The excision is surgical: the `$TOKEN` inside the test bracket is exempt,
    // the one in the `echo` is not.
    expectBlocked(runGuard('[ -n "$GITHUB_TOKEN" ] && echo "$GITHUB_TOKEN"', CONFIGURED_ENV));
  });

  it('leaves an ordinary, non-credential variable alone', () => {
    expectAllowed(runGuard('echo "$HOME/scratch" && cd "$TMPDIR"', CONFIGURED_ENV));
  });
});

// ---------------------------------------------------------------------------
// 3. Family 2 — the value-substituting expansion, for ANY name
// ---------------------------------------------------------------------------

describe('echo-guard family 2 — value-substituting expansion (the form, not the name)', () => {
  it('blocks a ${NAME:-…} fallback of an arbitrary NON-credential name', () => {
    // The catalogue's own lesson: a rule closes only the vector it names. No
    // suffix heuristic would have predicted `DEPLOY_TARGET`, and the operator
    // that leaks is the same one.
    const result = runGuard('echo "${DEPLOY_TARGET:-staging}"', CONFIGURED_ENV);
    expectBlocked(result);
    expect(result.stderr).toContain('value-substituting expansion');
    expect(result.stderr).toContain('DEPLOY_TARGET');
  });

  it('blocks the := and :? spellings too', () => {
    expectBlocked(runGuard('echo "${SOME_VAR:=default}"', {}));
    expectBlocked(runGuard('echo "${SOME_VAR:?must be set}"', {}));
  });

  it('does NOT fire on a positional parameter — excluded by construction (letter-initial names only)', () => {
    expectAllowed(runGuard('set -- a b; echo "${1:-none}"', {}));
  });
});

// ---------------------------------------------------------------------------
// 4. Family 3 — whole-environment dumps
// ---------------------------------------------------------------------------

describe('echo-guard family 3 — whole-environment dumps', () => {
  it('blocks printenv WITH an argument', () => {
    const result = runGuard('printenv LINEAR_API_KEY', CONFIGURED_ENV);
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
    expect(result.stderr).toContain('worse than a bare dump');
  });

  it('blocks printenv WITHOUT an argument', () => {
    expectBlocked(runGuard('printenv', {}));
  });

  it('blocks a bare env', () => {
    const result = runGuard('env', {});
    expectBlocked(result);
    expect(result.stderr).toContain('a bare `env`');
  });

  it('blocks an EXACTLY-bare set', () => {
    const result = runGuard('set', {});
    expectBlocked(result);
    expect(result.stderr).toContain('a bare `set`');
  });

  it('blocks a dump hidden behind a pipe, a command substitution or a brace group', () => {
    expectBlocked(runGuard('printenv | grep TOKEN', {}));
    expectBlocked(runGuard('echo $(printenv)', {}));
    expectBlocked(runGuard('{ printenv; } > /tmp/e', {}));
    expectBlocked(runGuard('git status && printenv', {}));
  });

  it('blocks an absolute-path spelling of the same dump', () => {
    expectBlocked(runGuard('/usr/bin/printenv', {}));
  });

  it('leaves the flag forms of set alone', () => {
    expectAllowed(runGuard('set -e', {}));
    expectAllowed(runGuard('set -o pipefail', {}));
    expectAllowed(runGuard('set -euo pipefail', {}));
  });

  it('leaves an unrelated command that merely MENTIONS a dump word alone', () => {
    expectAllowed(runGuard('grep -rn printenv docs/', {}));
  });
});

// ---------------------------------------------------------------------------
// 5. Family 4 — a wrapped configured Lookup-Command
// ---------------------------------------------------------------------------

describe('echo-guard family 4 — the wrapped Lookup-Command (ADR-0029)', () => {
  it('blocks a WRAPPED configured lookup command — the form the deny anchor cannot reach', () => {
    // The tracked `permissions.deny` entry anchors the DIRECT command form
    // only; `echo $(…)` and `sh -c` wrappers are not reachable by a prefix
    // matcher. That residual is exactly what this family closes.
    const result = runGuard(`echo $(${GITHUB_LOOKUP})`, CONFIGURED_ENV);
    expectBlocked(result);
    expect(result.stderr).toContain('wrapped Lookup-Command');
    expect(result.stderr).toContain('GITHUB_TOKEN_CMD');
    // The rejection names the VARIABLE, never re-prints the lookup's output.
    expect(result.stderr).not.toContain('flotilla-github-token');
  });

  it('blocks a shell-wrapper spelling of the same lookup', () => {
    expectBlocked(runGuard(`sh -c '${LINEAR_LOOKUP}'`, CONFIGURED_ENV));
  });

  it('blocks the direct form as well — the guard does not depend on the deny anchor firing first', () => {
    expectBlocked(runGuard(GITHUB_LOOKUP, CONFIGURED_ENV));
  });

  it('is CONFIG-DRIVEN: the same command passes where no lookup is configured', () => {
    // Consumer-portable by construction — nothing about flotilla's own keychain
    // items is hardcoded in the guard.
    expectAllowed(runGuard(GITHUB_LOOKUP, {}));
  });

  it('ignores an empty or implausibly short lookup value rather than matching everything', () => {
    expectAllowed(runGuard('git status --porcelain', { GITHUB_TOKEN_CMD: '' }));
    expectAllowed(runGuard('git status --porcelain', { GITHUB_TOKEN_CMD: 'x' }));
  });
});

// ---------------------------------------------------------------------------
// 6. The false-positive budget — pinned, each as its own case
// ---------------------------------------------------------------------------
//
// Measured at grill time: the pipeline's operational surfaces contain zero
// legitimate value-substituting expansions (every fallback-form string in the
// skills is warning PROSE, not an executed command), so the composed set's real
// FP surface is near zero. These cases are the contract that keeps it there.

describe('echo-guard — the false-positive budget passes untouched', () => {
  it('the ONE sanctioned presence test passes', () => {
    expectAllowed(runGuard('[ -n "$GITHUB_TOKEN" ] && echo set', CONFIGURED_ENV));
  });

  it('every spelling of the sanctioned presence test passes', () => {
    expectAllowed(runGuard('[[ -n "$LINEAR_API_KEY" ]] && echo set', CONFIGURED_ENV));
    expectAllowed(runGuard('[ -n "${GITHUB_TOKEN}" ] && echo set', CONFIGURED_ENV));
    expectAllowed(runGuard('[ -z "$GITHUB_TOKEN" ] && echo missing', CONFIGURED_ENV));
  });

  it('the `env -u NAME cmd` runner form passes', () => {
    // The documented workaround for a PAT that may not create repositories:
    // `env -u GITHUB_TOKEN gh repo create …`. It never prints the environment;
    // it removes one variable and runs a command.
    expectAllowed(runGuard('env -u GITHUB_TOKEN gh repo create formtrieb/thing --private', CONFIGURED_ENV));
  });

  it('the allowlisted engine-CLI invocation shapes pass', () => {
    // Exactly the shapes `.claude/settings.json` `permissions.allow` names.
    const shapes = [
      'NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts credential-probe --all',
      'NODE_USE_ENV_PROXY=1 tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts host-pr create --branch wave/1-x --title t --body b',
      'NODE_USE_ENV_PROXY=1 npx tsx tools/wave/src/cli.ts issue-store list-open --config .flotilla/wave.config.json',
      'NODE_USE_ENV_PROXY=1 npx @formtrieb/flotilla-engine cross-wave --repo-root .',
      './node_modules/.bin/tsx src/cli.ts spine read WAVE.md',
      'npx tsx src/issue-store-cli.ts transition 192 in-review',
    ];
    for (const shape of shapes) {
      expectAllowed(runGuard(shape, CONFIGURED_ENV));
    }
  });

  it('the ordinary verify gates pass', () => {
    expectAllowed(runGuard('cd tools/wave && npx vitest run', CONFIGURED_ENV));
    expectAllowed(runGuard('cd tools/wave && npx tsc --noEmit', CONFIGURED_ENV));
    expectAllowed(runGuard('git diff --cached --name-only | head', CONFIGURED_ENV));
  });
});

// ---------------------------------------------------------------------------
// 7. The PreToolUse contract itself — including the fail-OPEN property
// ---------------------------------------------------------------------------

describe('echo-guard — the PreToolUse contract', () => {
  it('a clean command exits 0 and says nothing at all', () => {
    const result = runGuard('git status --porcelain', CONFIGURED_ENV);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('has no opinion about a non-Bash tool call', () => {
    expectAllowed(runGuard('printenv', CONFIGURED_ENV, 'Read'));
  });

  it('FAILS OPEN on malformed stdin rather than bricking every Bash call', () => {
    // Deliberate: a speed bump that sits behind real anchors must never become
    // the reason a session cannot run a command. Documented in the script's own
    // doc note, asserted here so it is a property and not an accident.
    const result = runGuardRaw('not json at all', CONFIGURED_ENV);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('failing open');
  });

  it('FAILS OPEN on empty stdin', () => {
    expect(runGuardRaw('', CONFIGURED_ENV).code).toBe(0);
  });

  it('allows a payload that carries no command at all', () => {
    const result = runGuardRaw(JSON.stringify({ tool_name: 'Bash', tool_input: {} }), CONFIGURED_ENV);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 8. Honest scope — pinned so nobody reads this guard as an anchor
// ---------------------------------------------------------------------------

describe('echo-guard — the honest scope, asserted rather than assumed', () => {
  it('indirect expansion walks straight past it (a speed bump, not an anchor)', () => {
    // Convention 8's own assessment names this exact bypass. Pinning it as a
    // PASS is the point: the guard is worth having because it fires without
    // anyone remembering the rule, and worth not overselling. If someone later
    // believes the guard closes the vector, this case says otherwise in one line.
    expectAllowed(runGuard('V=GITHUB_TOKEN; echo "${!V}"', CONFIGURED_ENV));
  });
});
