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

  it('the seventh occurrence (2026-07-28, after the convention rewrite bound every role): the recorded argful, redirected form', () => {
    // The occurrence that triggered this filing — per the convention's own
    // doctrine, the response to a recurrence is removing the affordance, not an
    // eighth reminder. Spelled in the LITERAL form the catalogue quotes from the
    // Worker's own disclosure (`docs/skills/wave-shared/reference/convention-08-secret-safe-briefs.md`),
    // not the bare-`printenv` family-level stand-in this case used to carry —
    // the catalogue entry and this regression case now agree byte-for-byte.
    expectBlocked(runGuard('printenv GITHUB_TOKEN >/dev/null 2>&1; echo exit:$?', CONFIGURED_ENV));
  });

  it('the eighth occurrence (2026-07-28, credential-skills-half wave, Worker): the pipe-consumed printenv GITHUB_TOKEN | wc -c', () => {
    // Only the byte count reached tool output — the pipe consumed the value
    // before anything printed it, so no credential leaked and no rotation was
    // needed. Still an occurrence: the whole-environment-dump affordance was
    // reached for, past the clause that names it verbatim, which is exactly
    // why it is worth pinning — it is the variant that LOOKS harmless and
    // would be easiest to talk oneself into. Asserted on the PIPED form
    // specifically (not folded into the bare-printenv case above), and on
    // family 3's own "targets the secret directly" detail rather than only
    // the generic blocked contract, so a future narrowing of family 3 to just
    // the unpiped shape cannot silently un-cover this one.
    const result = runGuard('printenv GITHUB_TOKEN | wc -c', CONFIGURED_ENV);
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
    expect(result.stderr).toContain('worse than a bare dump');
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
// 4b. Family 3 — position-aware carve-outs (the row-226 / close-time FP cluster)
// ---------------------------------------------------------------------------
//
// Two evidenced false-positive shapes from one wave (2026-07-29-publish-prep-
// and-guards, rows 216/226, plus a Coordinator close-time reproduction): the
// dump word appearing in a SEARCH-PATTERN argument or a heredoc BODY was read
// as an invocation because family 3's head detection didn't know it was inside
// a literal (never re-parsed-as-a-command) span. Reconstructed here rather
// than quoted byte-for-byte — the exact live commands are not preserved
// verbatim in the provenance — but each is a faithful, independently-confirmed
// reproduction of the reported shape (confirmed against the PRE-FIX matcher
// before this carve-out existed; see the PR evidence for the falsification
// transcript, Convention 11).
describe('echo-guard family 3 — position-aware carve-outs (literal spans are not invocations)', () => {
  it('a search-PATTERN argument, backtick-quoted inside single quotes, is not a whole-environment dump (row 226)', () => {
    // The Reviewer's `grep -n` for the literal dump word inside this very spec
    // file, written with the word backtick-quoted the way the doc catalogue
    // quotes it — a search PATTERN, never executed as a command.
    expectAllowed(runGuard("grep -n '`printenv`' tools/wave/src/echo-guard.spec.ts", CONFIGURED_ENV));
  });

  it('a heredoc BODY that merely mentions the dump word is not a whole-environment dump (Coordinator, close 2026-07-30)', () => {
    // A `gh issue create --body "$(cat <<'EOF' … EOF)"` construction whose
    // body PROSE opens a line with the dump word — argument/stdin DATA for
    // `cat`, never a command in its own right.
    const body = [
      'gh issue create --title "echo-guard FP" --body "$(cat <<\'EOF\'',
      'printenv triggered a false positive when it was the first word of a report line.',
      "EOF",
      ')"',
    ].join('\n');
    expectAllowed(runGuard(body, CONFIGURED_ENV));
  });

  it('does NOT weaken a REAL bare backtick command substitution — only a single-quoted one is carved out', () => {
    // Outside single quotes a backtick pair IS real command substitution in
    // bash; the carve-out must never reach this shape.
    expectBlocked(runGuard('echo `printenv`', {}));
  });

  it('does NOT weaken a REAL command substitution embedded inside a heredoc body', () => {
    // Real bash evaluates `$(…)` inside a heredoc body before the body reaches
    // its reader, regardless of whether the delimiter itself is quoted — the
    // carve-out only folds the newline, never the `$(` split point.
    const body = ["cat <<'EOF'", 'printenv leaked via $(printenv) on this line', 'EOF'].join('\n');
    expectBlocked(runGuard(body, {}));
  });

  it('does NOT let an apostrophe inside DOUBLE-quoted prose pair up with a later quote and swallow a real trailing invocation', () => {
    // "don't" must never be mistaken for a single-quote delimiter that could
    // pair with some unrelated LATER quote and blank the real `&& printenv`
    // sitting between them.
    expectBlocked(runGuard('git commit -m "don\'t call printenv" && printenv', {}));
  });
});

// ---------------------------------------------------------------------------
// 4c. Family 3 — the double-quoted search-PATTERN carve-out (2026-07-30,
// post-#248 datapoint), plus its parenthesized-alternation resolution
// (2026-07-30, same day, one shape further out)
// ---------------------------------------------------------------------------
//
// One step past the row-226 / close-time cluster above: a read-only `rg`
// invocation whose search PATTERN was DOUBLE-quoted, not single-quoted,
// listing the dump word as one alternation term among several
// (`"printenv|env|set"`). The row-226 carve-out only neutralized
// single-quoted spans, so the live `|` inside the double-quoted pattern still
// split the string, isolating `env` as its own segment — a bare, argument-free
// command head that matches family 3's whole-environment-dump check exactly.
// Reproduces the reported shape: searching skill docs for occurrences of a
// guarded word, alongside other alternation terms, in a quoted regex.
//
// That fix's own docstring flagged one shape it deliberately did not chase: a
// PARENTHESIZED alternation (`"(printenv|env)"`) still isolated the bare word,
// because `(`/`)` stayed blanket-live inside double quotes so a genuine
// `$(...)` would not be blinded. The cases below close that residual with a
// POSITION-aware rule instead of a blanket one — see the module docstring's
// paren rule and `neutralizeQuotedSpans()` — and the negative controls prove
// the narrower rule still catches a real (including nested) `$(...)`.
describe('echo-guard family 3 — the double-quoted search-PATTERN carve-out (2026-07-30)', () => {
  it('AC1: a guarded word as an alternation term in a DOUBLE-quoted search pattern is not a whole-environment dump', () => {
    expectAllowed(runGuard('rg -n "printenv|env|set" .claude/skills', {}));
  });

  it('AC1: the same alternation pattern, single-quoted, still passes (no regression on the row-226 carve-out)', () => {
    expectAllowed(runGuard("rg -n 'printenv|env|set' .claude/skills", {}));
  });

  it('AC1: the same guarded word in COMMAND position still blocks, even alongside the now-allowed quoted pattern', () => {
    const result = runGuard('printenv | rg -n "printenv|env|set" .claude/skills', {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('negative control: a REAL trailing dump after a semicolon, outside the quotes, still blocks', () => {
    // The benign quoted search stays benign; the semicolon-separated dump
    // AFTER it — genuinely at the top level, never inside any quotes — must
    // still be caught. Proves the ';' inert-character treatment is scoped to
    // INSIDE a double-quoted span only, never to a real top-level separator.
    const result = runGuard('rg -n "printenv|env|set" .claude/skills; printenv', {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('negative control: prose semicolons and pipes INSIDE a double-quoted argument stay inert (no dump, no crash)', () => {
    expectAllowed(runGuard('git commit -m "fixed the env; printenv issue, see report|log"', {}));
  });

  it('negative control: a REAL command substitution embedded inside a double-quoted argument still blocks — $ and a backtick stay LIVE there', () => {
    // "$(printenv)" must not be swallowed by the same treatment that now
    // blanks ';' and '|' inside double quotes — $ and ` are genuinely live
    // inside double quotes in real bash and are deliberately excluded from
    // the inert set.
    expectBlocked(runGuard('echo "current token check: $(printenv)"', {}));
  });

  it('negative control: a REAL backtick command substitution embedded inside a double-quoted argument still blocks', () => {
    expectBlocked(runGuard('echo "current token check: `printenv`"', {}));
  });

  it('AC1 (resolved 2026-07-30): a PARENTHESIZED alternation inside double quotes no longer isolates the bare word', () => {
    // "(printenv|env)" used to still split on the live ( and ) — the
    // parenthesized-alternation flavor of the same FP family, one shape
    // further out than the row-226/close-time cluster. The resolved rule: a
    // `(`/`)` inside double quotes is live ONLY when it is provably one half
    // of a real `$(...)` pair (see the module docstring's paren rule); a bare
    // `(` with no `$` immediately before it — exactly this shape — carries no
    // expansion meaning of its own and is now as inert as the `;`/`|` already
    // carved out. Regression test derived from the live occurrence this
    // issue records.
    expectAllowed(runGuard('rg -n "(printenv|env)" .claude/skills', {}));
  });

  it('AC1: the same parenthesized-alternation shape, single-quoted, still passes (unchanged carve-out)', () => {
    expectAllowed(runGuard("rg -n '(printenv|env)' .claude/skills", {}));
  });

  it('AC1: a parenthesized alternation as an argument to a REAL command still leaves that command head reachable', () => {
    // The double-quoted pattern itself is neutralized to prose, but the
    // command carrying it — rg — is still the reported head; nothing about
    // the carve-out swallows the invocation itself.
    const result = runGuard('printenv | rg -n "(printenv|env)" .claude/skills', {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('AC2 negative control: a NESTED command substitution inside double quotes still blocks', () => {
    // "$(echo $(printenv))" — every paren here is either a genuine `$(`
    // opener or a closer with a live opener still outstanding, so the
    // one-counter paren rule keeps the whole thing live, exactly as before
    // this carve-out existed. Proves the fix does not blind the guard to a
    // nested form just because it now tracks paren liveness positionally.
    const result = runGuard('echo "check: $(echo $(printenv))"', {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('AC2 negative control: a bare parenthesized alternation followed by a REAL trailing command substitution still blocks the substitution', () => {
    // The now-inert "(printenv|env)" prose must not consume the liveness of
    // an unrelated, later, genuine $(...) in the same double-quoted string.
    const result = runGuard('echo "pattern (printenv|env) then $(printenv)"', {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });
});

// ---------------------------------------------------------------------------
// 4e. Family 3 — the quote-NESTING fix (2026-07-31): an embedded quote inside
// a live `$(...)` substitution opens its OWN nested scope instead of closing
// the OUTER double-quoted wrapper
// ---------------------------------------------------------------------------
//
// One shape further out than 4c/4d, and a distinct residual from the
// parenthesized-alternation fix above: that fix is POSITION-aware liveness
// for `(`/`)`; this is quote-STATE nesting. Observed live during wave
// 2026-07-30-hitl-gate-and-guards, on the very row that landed the
// parenthesized-alternation fix: a Worker's commit message, written with the
// system-recommended `git commit -m "$(cat <<'EOF' … EOF)"` heredoc form,
// quoted that fix's own guarded example — "(printenv|env)" — straight inside
// the heredoc BODY as prose. The OLD single-level double-quote scanner read
// that embedded `"` as CLOSING the outer `-m "..."` wrapper, re-exposing the
// rest of the commit message as unprotected top-level text and isolating
// `printenv` and `env` as bare command heads (reproduced against the PRE-FIX
// matcher below, Convention 11). Reconstructed here rather than quoted
// byte-for-byte — the exact live commit message is not preserved verbatim in
// the provenance — but it is a faithful, independently-confirmed reproduction
// of the reported shape: the same quoted-substitution commit form, quoting
// the same guarded example this repo's own history introduced.
describe('echo-guard family 3 — the quote-nesting fix (2026-07-31)', () => {
  it('AC: the live-observed shape — a guarded example quoted inside a heredoc-wrapped commit message — passes the guard', () => {
    const body = [
      'git commit -m "$(cat <<\'EOF\'',
      'fix(echo-guard): parenthesized alternation in double quotes passes without blinding substitution detection',
      '',
      'Regression test derived from a rg search whose pattern was "(printenv|env)" -- previously',
      'isolated as a bare env head.',
      '',
      'Closes #318',
      'EOF',
      ')"',
    ].join('\n');
    expectAllowed(runGuard(body, {}));
  });

  it('AC: a simpler, single-line version of the same shape — a RAW (unescaped) quote nested inside a live $(...) — passes', () => {
    // The minimal reproduction of the exact mechanism, without a heredoc:
    // `echo "..."` genuinely nested inside `$(...)`, itself inside the outer
    // `-m "..."` wrapper — real bash re-parses `$(...)`'s content from
    // scratch, so the inner `"..."` is its own independent quoted string,
    // not a character that closes the outer one.
    expectAllowed(runGuard('git commit -m "$(echo "note: (printenv|env) example")"', {}));
  });

  it('negative control: a genuinely UNBALANCED embedded quote does not hide a REAL trailing dump outside the whole construct', () => {
    // The heredoc body's embedded quote never closes ("unterminated example)
    // — a malformed shape a Worker should never intentionally write, but the
    // safety invariant must hold anyway: `&& printenv`, genuinely at the top
    // level AFTER the whole `-m "$(...)" ` argument, must still be reachable.
    // Proves the nesting fix can only WIDEN what counts as inert prose on a
    // malformed input, never SUPPRESS a real invocation sitting outside it.
    const body = [
      'git commit -m "$(cat <<\'EOF\'',
      'see "unterminated example',
      'EOF',
      ')" && printenv',
    ].join('\n');
    const result = runGuard(body, {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('negative control: a REAL command substitution alongside the quoted example, inside the same heredoc body, still blocks', () => {
    // The quoted "(printenv|env)" example stays inert prose, but a genuine
    // $(printenv) sitting right next to it in the same message must still be
    // caught — the nesting fix must not blind family 3 to the one construct
    // it exists to keep reachable.
    const body = [
      'git commit -m "$(cat <<\'EOF\'',
      'see "(printenv|env)" for the pattern, and confirm via $(printenv) locally',
      'EOF',
      ')"',
    ].join('\n');
    const result = runGuard(body, {});
    expectBlocked(result);
    expect(result.stderr).toContain('whole-environment dump');
  });

  it('negative control: the pre-existing single-line REAL command substitution inside double quotes is unaffected', () => {
    // Same shape as the 4c negative control above, re-asserted here so this
    // describe block also pins the property in isolation from the heredoc
    // form specifically.
    expectBlocked(runGuard('echo "current token check: $(printenv)"', {}));
  });
});

// ---------------------------------------------------------------------------
// 4d. Family 2 — the KEEP decision for the value-substituting-expansion
// shape in quoted/prose position (2026-07-30, same-day sibling datapoint)
// ---------------------------------------------------------------------------
//
// Same triage session as the family-3 carve-out above surfaced a structurally
// identical shape one family over: a search PATTERN merely quoting the
// `${NAME:-…}` SYNTACTIC SHAPE for a name that is not even credential-shaped.
// Family 2 has no literal-span awareness at all — it scans the raw command
// text regardless of quoting — so this stays blocked. Decided here as a KEEP,
// not a gap: see the module docstring's False-positive budget note for the
// rationale (family 3's isolated-command-head signal has no equivalent in a
// syntactic-form check).
describe('echo-guard family 2 — the KEEP decision, pinned (2026-07-30)', () => {
  it('a search PATTERN merely quoting the ${NAME:-…} SHAPE for a non-credential name still blocks — deliberate, not carved', () => {
    const result = runGuard("grep -rn '${DEPLOY_TARGET:-' .claude/skills", {});
    expectBlocked(result);
    expect(result.stderr).toContain('value-substituting expansion');
    expect(result.stderr).toContain('DEPLOY_TARGET');
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
