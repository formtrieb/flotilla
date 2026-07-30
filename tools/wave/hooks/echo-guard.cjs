#!/usr/bin/env node
'use strict';

/**
 * echo-guard.cjs — the `PreToolUse` Echo-Guard (Convention 8, grill-settled).
 *
 * A zero-dependency CommonJS matcher over a Bash tool call's COMMAND STRING,
 * run before the command executes. It rejects the secret-echo shapes Convention
 * 8 forbids — the shapes the permission layer provably cannot express, because
 * a `Bash(...)` rule is a command-PREFIX matcher and the dangerous element can
 * sit anywhere in an arbitrary command, under any interpreter.
 *
 * ## Honest scope — a speed bump, not an anchor
 *
 * This is a TEXT matcher over the command. `V=GITHUB_TOKEN; echo "${!V}"` walks
 * straight past it, and so does any deliberate string assembly. That limitation
 * is recorded up front rather than discovered later: the guard is worth having
 * precisely because it fires without anyone remembering the rule, and worth not
 * overselling. **Passing this guard is not evidence that a command is safe.**
 * The structural anchors remain the tracked `permissions.deny` entries and the
 * ADR-0029 Lookup-Command indirection; this guard sits on top of them.
 *
 * Two vectors are deliberately NOT this guard's: reading a gitignored
 * settings/secrets file (owned by the tracked `permissions.deny` Read/`cat`
 * entries — the file-read anchor) and the DIRECT invocation of a configured
 * `<VAR>_CMD` lookup command (owned by the tracked Lookup-Command deny entry,
 * ADR-0029). Family 4 below extends the latter to the WRAPPED forms a prefix
 * matcher cannot reach; it does not replace the anchor.
 *
 * ## Failure mode — hard-block, and fail OPEN on the guard's own crash
 *
 * A match exits **2** with a teaching message on stderr: the blocking channel of
 * the `PreToolUse` contract. Hard-block, not warn-and-confirm — AFK roles have
 * no human to confirm, and for the Coordinator a dismissable warning is the
 * eight-times-evidenced failure mode ("a rule that has been read and then
 * violated is not under-communicated").
 *
 * **The guard FAILS OPEN on its own crash.** Any internal error — malformed
 * stdin, an unreadable payload, an unexpected exception — exits 0 and lets the
 * command through. That is a deliberate trade for a speed bump that sits behind
 * real anchors: a guard that bricks every Bash call when its own parsing breaks
 * costs more than the vector it closes. A crash is therefore silent-permissive,
 * not silent-denying, and this note is the record of that choice.
 *
 * ## The four families
 *
 * 1. **Credential-name expansion.** ANY `$`-expansion of a credential-shaped
 *    variable name — the configured credential names (derived from the
 *    `<VAR>_CMD` entries present at hook runtime) plus the suffix classes
 *    `_TOKEN` / `_KEY` / `_SECRET` / `_PAT` / `_PASSWORD` / `_CMD` — anywhere in
 *    the command, EXCEPT inside the sanctioned presence-test template.
 * 2. **Value-substituting expansion.** `${NAME:-…}` / `${NAME:=…}` / `${NAME:?…}`
 *    for ANY letter-initial name (positional parameters excluded by
 *    construction). The catalogue's own lesson is that a rule closes only the
 *    vector it names, so the form is denied independently of the name.
 * 3. **Whole-environment dumps.** Every `printenv` invocation (with or without
 *    an argument — `printenv GITHUB_TOKEN` is *worse*, not better), a bare `env`
 *    (the documented `env -u NAME cmd` runner form passes), and an exactly-bare
 *    `set` (flag forms like `set -e` pass).
 * 4. **Wrapped Lookup-Command.** Any command containing a configured `<VAR>_CMD`
 *    VALUE as a substring, the values read from the environment at hook runtime
 *    (so this is config-driven and consumer-portable, never hardcoded). This
 *    upgrades `echo $(…)` and shell-wrapper forms from prefix-unreachable to
 *    caught. Accidents type the command verbatim; deliberate string assembly
 *    stays outside the honest scope above.
 *
 * ## False-positive budget
 *
 * Pinned by spec (`../src/echo-guard.spec.ts`): the sanctioned presence test
 * `[ -n "$VAR" ] && echo set`, the `env -u NAME cmd` runner form, and the
 * allowlisted engine-CLI invocation shapes all pass untouched. Measured at
 * grill time, the pipeline's operational surfaces contain zero legitimate
 * value-substituting expansions (every fallback-form string in the skills is
 * warning PROSE, not an executed command), so the composed set's real FP
 * surface is near zero. A benign FP costs one rephrase, guided by the rejection
 * message.
 *
 * **One FP class is a KEPT, deliberate decision, not a gap** (assessed fresh
 * 2026-07-30, alongside the family-3 double-quote fix below, precisely
 * because that fix invites the question "why not this too?"): a command whose
 * ARGUMENT quotes an unsafe VALUE-SUBSTITUTING form as prose — e.g.
 * `git commit -m "... ${VAR:-no} ..."`, or a search PATTERN that merely
 * mentions the `${NAME:-default}` SHAPE for a name that is not even
 * credential-shaped — is blocked by family 2, because the matcher reads
 * command text and cannot tell prose from an expansion the shell will
 * perform. **Decision: KEEP, do not carve.** Family 3's dump-word detection
 * is narrow enough to widen safely — it fires only when an ISOLATED command
 * HEAD, with no arguments, exactly equals a dump word, a strong "this is not
 * data" signal once literal spans are excluded. Family 2 has no equivalent
 * narrow signal: `${NAME:-value}` is a SYNTACTIC FORM, not a command head, and
 * that exact substring is indistinguishable — by the characters immediately
 * around it — from one sitting inside a nested `$(...)` or an unquoted
 * heredoc the shell WILL evaluate. Narrowing family 2 the way family 3 was
 * narrowed below would need real quote-context-aware parsing of an
 * expansion's OWN operand, not just the head of the command carrying it; the
 * false-positive cost (one rephrase, guided by the rejection message) stays
 * cheaper than that risk. Rephrase the argument.
 *
 * **Family 3 is position-aware about three literal (never re-parsed-as-a-command)
 * spans**, the first two added after a 2026-07-29 same-day FP cluster (a
 * Reviewer's `grep -n` search PATTERN for the dump word, quoted in backticks
 * inside single quotes, and a Coordinator `gh issue create` heredoc BODY that
 * merely mentioned the word as the first word of a line), the third added
 * 2026-07-30 one carve-out further out than that cluster (a read-only `rg`
 * invocation whose DOUBLE-quoted search pattern listed the
 * dump word as one alternation term among several — `rg "printenv|env|set"
 * docs/`, one segment of which is `env`, isolated by the live `|` and
 * matching family 3's bare-`env` head exactly):
 *
 *   - **A single-quoted string.** Bash performs ZERO expansion inside single
 *     quotes — no `$`, no backtick command substitution, nothing — so a
 *     backtick-quoted mention of a dump word inside one (`grep -n '`printenv`'
 *     file`) is never a real invocation. `neutralizeQuotedSpans()` blanks
 *     every SEGMENT_SPLIT trigger character it finds there before family 3's
 *     head detection runs.
 *   - **A double-quoted string — but only its genuinely INERT characters.**
 *     Unlike a single-quoted span, `$` and a backtick ARE live inside double
 *     quotes in real bash (`"$(printenv)"` really does run `printenv`), so
 *     those two stay untouched unconditionally. What DOES get blanked inside
 *     a double-quoted span — `;`, `|`, `&`, `{`, `}`, and a literal embedded
 *     newline — has NO special meaning there at all in real bash; it is
 *     exactly as inert as it is inside single quotes, which is what makes a
 *     pipe-joined alternation list in a quoted search PATTERN
 *     (`"printenv|env|set"`) prose, not three separate command heads. An
 *     apostrophe like the one in `"don't …"` is still never mistaken for a
 *     single-quote delimiter, because the double-quote branch never watches
 *     for `'` at all — only its own closing `"` ends it.
 *     **`(` and `)` are POSITION-aware, resolving the earlier residual.**
 *     The structural fact that settles this: real command substitution
 *     requires the `$(` OPENER — a bare `(` sitting in double-quoted prose
 *     with no `$` immediately before it is not an expansion by itself, in
 *     real bash, ever. So `neutralizeQuotedSpans()` tracks how many `$(`
 *     openers are currently outstanding inside the CURRENT double-quoted
 *     span (one counter, reset per span — not a nested-paren parser): a `(`
 *     is live and increments the counter ONLY when the character
 *     immediately before it in the ORIGINAL command is `$`; a `)` is live
 *     and decrements the counter ONLY while it is still above zero. Every
 *     other `(`/`)` — a bare opener with nothing live behind it, or a closer
 *     with no outstanding live opener — is exactly as inert as `;` or `|`
 *     and gets blanked the same way, which is what turns
 *     `"(printenv|env)"` into prose instead of an isolated `env` head. A
 *     REAL `$(...)`, including one nested inside another
 *     (`"$(echo $(printenv))"`), keeps every one of its parens live, because
 *     each is either a genuine `$(` opener or a closer with a live opener
 *     still outstanding — a one-token lookbehind is enough; no lookahead or
 *     bracket-pairing logic is needed to get that right.
 *   - **A heredoc BODY.** It is argument/stdin DATA for whatever reads it, not
 *     a further sequence of top-level commands, so a bare line that happens to
 *     open with the dump word must not manufacture a fake per-line command
 *     head the way a real top-level newline would. `neutralizeHeredocBodies()`
 *     folds a heredoc's body lines into the line that opened it (spaces
 *     standing in for the newlines) before family 3 runs. Nothing inside the
 *     body other than the newline itself is touched — an embedded `$(…)`
 *     command substitution, which real bash DOES evaluate before the body
 *     reaches its reader, stays exactly as reachable as it was before this
 *     carve-out existed.
 *
 * All three carve-outs are scoped to family 3's own head detection only —
 * families 1, 2 and 4 still scan the ORIGINAL command text unchanged, so a
 * genuine credential expansion or wrapped Lookup-Command hidden inside any of
 * them is none of family 3's business to begin with and stays caught by its
 * own family (see the KEEP decision above for family 2 specifically). None of
 * the three weakens the piped, command-substitution or command-head
 * invocation forms: those either never enter a quoted or heredoc span, or —
 * for a genuine `$(...)` / backtick command substitution specifically, the
 * paren rule above included — stay deliberately live inside one.
 *
 * ============================================================================
 * ## OPERATOR STEP (HITL) — ready to paste, deliberately NOT applied by an agent
 * ============================================================================
 *
 * `.claude/settings.json` is agent-write-denied, so the wiring is an
 * operator-present step. An agent that pre-applies it has committed a defect.
 * Merge this `hooks` block into `.claude/settings.json` as a sibling of `env`
 * and `permissions`:
 *
 * ```json
 * "hooks": {
 *   "PreToolUse": [
 *     {
 *       "matcher": "Bash",
 *       "hooks": [
 *         {
 *           "type": "command",
 *           "command": "node \"$CLAUDE_PROJECT_DIR/tools/wave/hooks/echo-guard.cjs\""
 *         }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * Verify it live, without executing anything unsafe — the guard rejects the
 * command, so nothing is ever expanded:
 *
 * ```bash
 * printf '%s' '{"tool_name":"Bash","tool_input":{"command":"printenv"}}' \
 *   | node tools/wave/hooks/echo-guard.cjs; echo "exit=$?"   # expect exit=2
 * ```
 *
 * ## STAGE-2 GATE — the consumer scaffold is NOT shipped by this slice
 *
 * `wave-setup`'s tracked-settings scaffold gains the identical hooks block plus
 * a script copy for every consumer — unconditionally, like the deny anchors
 * (the vector is universal, no per-consumer judgment) — but **only after this
 * guard has survived one real flotilla wave with no false-positive incident**.
 * That is the FOR-81 / ADR-0029 live-gate pattern: dogfood first, scaffold
 * second. Until that gate is met, the block above stays a flotilla-local
 * operator step. The gate is restated in Convention 8 so the next wave planner
 * reads it where they already look.
 */

// ---------------------------------------------------------------------------
// Family definitions
// ---------------------------------------------------------------------------

/** Suffix classes that make a variable name credential-shaped (family 1). */
const CREDENTIAL_NAME_SUFFIXES = ['_TOKEN', '_KEY', '_SECRET', '_PAT', '_PASSWORD', '_CMD'];

/** The ADR-0029 Lookup-Command variable suffix. */
const LOOKUP_COMMAND_SUFFIX = '_CMD';

/**
 * Minimum length a configured Lookup-Command VALUE must have before family 4
 * substring-matches on it. A three-character value would match half the world;
 * a real lookup command (`security find-generic-password …`, `op read …`) is
 * comfortably longer.
 */
const MIN_LOOKUP_VALUE_LENGTH = 12;

/**
 * The ONE sanctioned presence test: `[ -n "$VAR" ] && echo set` (and its `[[`,
 * `-z`, unquoted and `${VAR}` spellings). Matched segments are excised before
 * family 1 scans, which is exactly what keeps the sanctioned form passing while
 * `[ -n "$TOK" ] && echo "$TOK"` still blocks on its second expansion.
 */
const SANCTIONED_PRESENCE_TEST_SRC = '\\[\\[?\\s+-[nz]\\s+"?\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?"?\\s+\\]\\]?';

/** Any `$`-expansion of a letter-initial name — `$N`, `${N}`, `${N:-x}`, `${!N}`. */
const ANY_EXPANSION_SRC = '\\$\\{?!?([A-Za-z_][A-Za-z0-9_]*)';

/** The convention's own candidate regex: a VALUE-SUBSTITUTING expansion. */
const VALUE_SUBSTITUTING_SRC = '\\$\\{([A-Za-z_][A-Za-z0-9_]*):[-=?]';

/**
 * Simple-command boundaries, for family 3's head detection. Splitting on
 * command substitution and grouping too means `echo $(printenv)` and
 * `{ printenv; }` are reached, not just top-level heads.
 */
const SEGMENT_SPLIT = /\$\(|\|\||&&|[;|\n&()`{}]/;

/** Build a fresh global regex — module-level `lastIndex` state is a bug farm. */
function g(source) {
  return new RegExp(source, 'g');
}

// ---------------------------------------------------------------------------
// Environment-derived configuration (family 1's names, family 4's values)
// ---------------------------------------------------------------------------

/**
 * The credential names this consumer has actually configured, derived from the
 * `<VAR>_CMD` entries in the environment: `GITHUB_TOKEN_CMD` contributes both
 * `GITHUB_TOKEN_CMD` and `GITHUB_TOKEN`. Config-driven, so a consumer whose
 * next store adapter needs a differently-named credential is covered without
 * editing this file.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Set<string>}
 */
function configuredCredentialNames(env) {
  const names = new Set();
  for (const key of Object.keys(env || {})) {
    if (!key.endsWith(LOOKUP_COMMAND_SUFFIX)) continue;
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    names.add(key);
    names.add(key.slice(0, -LOOKUP_COMMAND_SUFFIX.length));
  }
  return names;
}

/**
 * The configured Lookup-Command VALUES family 4 substring-matches on, keyed by
 * their variable name. Only the NAME is ever surfaced in a rejection message.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ key: string, value: string }[]}
 */
function configuredLookupCommands(env) {
  const out = [];
  for (const key of Object.keys(env || {})) {
    if (!key.endsWith(LOOKUP_COMMAND_SUFFIX)) continue;
    const raw = env[key];
    if (typeof raw !== 'string') continue;
    const value = normalizeWhitespace(raw);
    if (value.length < MIN_LOOKUP_VALUE_LENGTH) continue;
    out.push({ key, value });
  }
  return out;
}

/** @param {string} name @param {Set<string>} configured */
function isCredentialShaped(name, configured) {
  if (configured.has(name)) return true;
  return CREDENTIAL_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** @param {string} text */
function normalizeWhitespace(text) {
  return text.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Family 3 — simple-command head detection
// ---------------------------------------------------------------------------

/**
 * Split a command into simple-command segments and return each one's head word
 * plus its remaining arguments, skipping leading `VAR=value` assignment
 * prefixes (so `NODE_USE_ENV_PROXY=1 npx …` heads on `npx`, not the assignment).
 *
 * @param {string} command
 * @returns {{ head: string, rest: string[] }[]}
 */
function commandHeads(command) {
  const heads = [];
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    if (i >= words.length) continue;
    const head = words[i].replace(/^["']|["']$/g, '').replace(/^.*\//, '');
    if (!head) continue;
    heads.push({ head, rest: words.slice(i + 1) });
  }
  return heads;
}

// ---------------------------------------------------------------------------
// Family 3 — position-aware carve-outs (literal spans, never real invocations)
// ---------------------------------------------------------------------------

/**
 * The individual characters SEGMENT_SPLIT reacts to. `$(`, `||` and `&&` are
 * each anchored by one of these single characters, so blanking the anchor
 * defuses the two-character form too — no need to match it separately.
 */
const SEGMENT_SPLIT_CHARS = new Set(['`', '\n', ';', '|', '&', '(', ')', '{', '}', '$']);

/**
 * The subset of SEGMENT_SPLIT_CHARS that stays UNCONDITIONALLY live inside a
 * DOUBLE-quoted span in real bash, independent of position: `$` starts
 * `$var`, `${...}` and `$(...)`; a backtick starts legacy command
 * substitution. Blanking either would blind family 3's head detection to a
 * genuine `"$(printenv)"`.
 *
 * `(` and `)` are deliberately NOT here — they carry no expansion meaning of
 * their own inside double quotes; they only matter as the two halves of a
 * `$(...)` pair. `neutralizeQuotedSpans()` decides their liveness
 * POSITIONALLY instead of by blanket character-class membership: live only
 * when it is provably one half of a real `$(` / `)` command-substitution
 * pair (see the paren rule in the module docstring's double-quoted-string
 * bullet, and the fuller walkthrough on `neutralizeQuotedSpans` itself).
 * That is what resolves the PARENTHESIZED-alternation flavor of this FP
 * family (`"(printenv|env)"`) without blinding the guard to a genuine, even
 * nested, command substitution.
 */
const DOUBLE_QUOTE_LIVE_CHARS = new Set(['$', '`']);

/** @param {Set<string>} chars @param {string} text */
function blankChars(chars, text) {
  let out = '';
  for (const ch of text) out += chars.has(ch) ? ' ' : ch;
  return out;
}

/**
 * Blank every SEGMENT_SPLIT trigger character that falls inside a quoted
 * span — a single-quoted span in full, a double-quoted span for its
 * genuinely inert characters only (`DOUBLE_QUOTE_LIVE_CHARS` stays untouched
 * there, plus a `(`/`)` that is provably one half of a real `$(...)` pair —
 * see the paren rule below).
 *
 * Bash performs ZERO expansion inside single quotes — no `$`, no backtick
 * command substitution, nothing — so nothing inside one is ever a further
 * command; a backtick pair used there as markdown-style quoting (a search
 * PATTERN argument, e.g. `grep -n '`printenv`' file`) must not be read as
 * command substitution.
 *
 * A double-quoted span is different in kind, not just degree: `$` and a
 * backtick really do expand there (`"$(printenv)"` really runs `printenv`),
 * so those stay untouched unconditionally (`DOUBLE_QUOTE_LIVE_CHARS`). Every
 * OTHER SEGMENT_SPLIT character (`;`, `|`, `&`, `{`, `}`, an embedded literal
 * newline) has no special meaning inside double quotes in real bash at all —
 * it is exactly as inert there as it is inside single quotes — so a
 * pipe-joined alternation list in a quoted search PATTERN
 * (`"printenv|env|set"`) is prose, not three command heads, and gets
 * blanked the same way a single-quoted one already is. An apostrophe like
 * the one in `"don't …"` is never mistaken for a single-quote delimiter that
 * could pair with some unrelated LATER quote and blank real command text
 * sitting between them, because the double-quote branch below never treats
 * `'` as special at all — only its own closing `"` ends it.
 *
 * **The paren rule.** `(` and `)` sit between those two extremes: unlike `$`
 * and a backtick they are NOT unconditionally live, but unlike `;`/`|`/`&`
 * they are not unconditionally inert either — real command substitution
 * genuinely needs them. The structural signal that resolves this: command
 * substitution requires the `$(` OPENER; a bare `(` with no `$` immediately
 * before it is not an expansion by itself, in real bash, ever. So this scan
 * tracks how many `$(` openers are currently outstanding inside the CURRENT
 * double-quoted span — one counter, reset at the start of each new
 * double-quoted span, no pairing or nesting parser required. A `(` is live
 * (and increments the counter) only when the ORIGINAL command's
 * immediately-preceding character is `$`; a `)` is live (and decrements the
 * counter) only while it is still above zero. Everything else — a bare `(`
 * opened from nothing, or a `)` with no live opener outstanding — is exactly
 * as inert as `;` or `|` and gets blanked the same way, which is what turns
 * a PARENTHESIZED alternation in a quoted search PATTERN
 * (`"(printenv|env)"`) into prose instead of an isolated `env` head. A
 * genuine `$(...)`, even nested (`"$(echo $(printenv))"`), keeps every one
 * of its parens live, because each is either a real `$(` opener or a closer
 * with a live opener still outstanding — the one-token lookbehind is
 * sufficient; no lookahead or bracket-matching is needed.
 *
 * A hand-rolled quote-state scan, not a shell parser — it exists only to
 * defuse the evidenced false-positive shapes without touching a real
 * invocation.
 *
 * @param {string} command
 * @returns {string}
 */
function neutralizeQuotedSpans(command) {
  let out = '';
  /** @type {'none' | 'single' | 'double'} */
  let state = 'none';
  // Count of `$(` openers seen inside the CURRENT double-quoted span that
  // have not yet been closed by a live `)` — the paren rule above. Reset at
  // the start of every new double-quoted span.
  let liveParenDepth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (state === 'double') {
      if (ch === '\\' && i + 1 < command.length) {
        out += ch + command[i + 1];
        i += 1;
        continue;
      }
      if (ch === '(') {
        // Live ONLY as the opener of a real `$(...)` — i.e. only when the
        // character immediately before it in the ORIGINAL command (not the
        // partially-neutralized output) is `$`. A bare `(` with nothing live
        // behind it carries no expansion meaning inside double quotes at
        // all, so it is exactly as inert as `;` or `|`.
        if (command[i - 1] === '$') {
          liveParenDepth += 1;
          out += ch;
        } else {
          out += ' ';
        }
        continue;
      }
      if (ch === ')') {
        // Live only while a `$(` opened above is still outstanding; a `)`
        // with none outstanding closes nothing live.
        if (liveParenDepth > 0) {
          liveParenDepth -= 1;
          out += ch;
        } else {
          out += ' ';
        }
        continue;
      }
      const blank = SEGMENT_SPLIT_CHARS.has(ch) && !DOUBLE_QUOTE_LIVE_CHARS.has(ch);
      out += blank ? ' ' : ch;
      if (ch === '"') state = 'none';
      continue;
    }
    if (state === 'single') {
      if (ch === "'") {
        state = 'none';
        out += ch;
        continue;
      }
      out += SEGMENT_SPLIT_CHARS.has(ch) ? ' ' : ch;
      continue;
    }
    out += ch;
    if (ch === "'") state = 'single';
    else if (ch === '"') {
      state = 'double';
      liveParenDepth = 0;
    }
  }
  return out;
}

/** Matches a heredoc-opening token: `<<`, optional `-`, optional quote, the delimiter word. */
const HEREDOC_INTRO_SRC = "<<-?\\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\\1";

/**
 * Fold every heredoc's BODY lines into the line that opened it, spaces
 * standing in for the newlines that separated them.
 *
 * A heredoc body is argument/stdin DATA for whatever reads it, never a
 * further sequence of top-level commands — so a body line that happens to
 * open with a dump word (`printenv leaked in row 226…`, the first word of a
 * `gh issue create` heredoc BODY paragraph) must not manufacture a fake
 * per-line command head the way a real top-level newline would. Nothing
 * inside the body OTHER than the newline is touched: an embedded `$(…)`
 * command substitution — which real bash DOES evaluate before the body
 * reaches its reader, regardless of whether the delimiter itself is quoted —
 * stays exactly as reachable to family 3 as it was before this carve-out
 * existed, because its own `$(` split point is untouched by this function.
 *
 * @param {string} command
 * @returns {string}
 */
function neutralizeHeredocBodies(command) {
  const lines = command.split('\n');
  const introRe = new RegExp(HEREDOC_INTRO_SRC);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i += 1;
    // A line can open more than one heredoc in real bash; tracking only the
    // LAST delimiter on the line is an adequate simplification for a guard
    // whose job here is just "don't manufacture a fake per-line head."
    let delim = null;
    let remainder = line;
    let match;
    while ((match = introRe.exec(remainder))) {
      delim = match[2];
      remainder = remainder.slice(match.index + match[0].length);
    }
    if (delim === null) continue;
    const closeExact = new RegExp('^[ \\t]*' + delim + '$');
    const bodyLines = [];
    while (i < lines.length && !closeExact.test(lines[i])) {
      bodyLines.push(lines[i]);
      i += 1;
    }
    if (bodyLines.length > 0) {
      out[out.length - 1] += ' ' + bodyLines.join(' ');
    }
    if (i < lines.length) {
      out.push(lines[i]); // the closing delimiter line itself, untouched
      i += 1;
    }
  }
  return out.join('\n');
}

/**
 * All family-3 carve-outs composed: heredoc bodies folded first (so a
 * heredoc's own quoted delimiter token, e.g. `'EOF'`, is still intact and
 * self-contained when the quoted-span pass runs next), then single- and
 * double-quoted spans neutralized. Scoped to family 3's OWN head detection
 * only — families 1, 2 and 4 still scan the original, unmodified command
 * text, so a genuine credential expansion or wrapped Lookup-Command hidden
 * inside any of these spans stays caught by its own family.
 *
 * @param {string} command
 * @returns {string}
 */
function literalSpanNeutralized(command) {
  return neutralizeQuotedSpans(neutralizeHeredocBodies(command));
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/**
 * @typedef {{ family: string, detail: string }} Violation
 */

/**
 * Evaluate one command string against the four families.
 *
 * @param {string} command the raw Bash command the tool call would run
 * @param {Record<string, string | undefined>} [env] the hook-runtime environment
 * @returns {Violation[]} empty when the command passes
 */
function evaluateCommand(command, env) {
  if (typeof command !== 'string' || command.trim() === '') return [];
  const environment = env || {};
  const configured = configuredCredentialNames(environment);

  /** @type {Violation[]} */
  const violations = [];

  // --- Family 1 — any $-expansion of a credential-shaped name ---------------
  // The sanctioned presence test is excised first; everything that remains is
  // an expansion nobody sanctioned.
  const outsideSanctioned = command.replace(g(SANCTIONED_PRESENCE_TEST_SRC), ' <sanctioned-presence-test> ');
  const reportedNames = new Set();
  for (const match of outsideSanctioned.matchAll(g(ANY_EXPANSION_SRC))) {
    const name = match[1];
    if (!isCredentialShaped(name, configured)) continue;
    if (reportedNames.has(name)) continue;
    reportedNames.add(name);
    violations.push({
      family: 'credential-name expansion',
      detail:
        `the command expands $${name}, a credential-shaped variable, outside the sanctioned presence test — ` +
        'the expansion substitutes the VALUE into tool output',
    });
  }

  // --- Family 2 — a value-substituting expansion of ANY name ----------------
  const reportedForms = new Set();
  for (const match of command.matchAll(g(VALUE_SUBSTITUTING_SRC))) {
    const name = match[1];
    if (reportedForms.has(name)) continue;
    reportedForms.add(name);
    violations.push({
      family: 'value-substituting expansion',
      detail:
        `\${${name}:…} is a value-substituting expansion (the :- / := / :? operators), not a presence test — ` +
        'on the branch that matters, the branch where the variable IS set, it evaluates to the variable\'s own contents',
    });
  }

  // --- Family 3 — whole-environment dumps -----------------------------------
  // Head detection runs over the LITERAL-SPAN-NEUTRALIZED text (single-quoted
  // spans and heredoc bodies), not the raw command — see literalSpanNeutralized()
  // above. Families 1, 2 and 4 above and below still scan the raw `command`.
  const reportedDumps = new Set();
  for (const { head, rest } of commandHeads(literalSpanNeutralized(command))) {
    let dump = null;
    if (head === 'printenv') {
      dump =
        rest.length > 0
          ? '`printenv <VAR>` targets the secret directly — it is worse than a bare dump, not better'
          : '`printenv` prints every set variable, secrets included';
    } else if (head === 'env' && rest.length === 0) {
      dump = 'a bare `env` prints every set variable, secrets included (the `env -u NAME cmd` runner form is fine)';
    } else if (head === 'set' && rest.length === 0) {
      dump = 'a bare `set` prints every set variable, secrets included (flag forms like `set -e` are fine)';
    }
    if (dump === null || reportedDumps.has(head)) continue;
    reportedDumps.add(head);
    violations.push({ family: 'whole-environment dump', detail: dump });
  }

  // --- Family 4 — a wrapped configured Lookup-Command ------------------------
  const haystack = normalizeWhitespace(command);
  for (const { key, value } of configuredLookupCommands(environment)) {
    if (!haystack.includes(value)) continue;
    violations.push({
      family: 'wrapped Lookup-Command',
      detail:
        `the command contains the configured ${key} lookup command — its stdout IS the secret, ` +
        'and no role in this pipeline executes it outside the engine (ADR-0029)',
    });
  }

  return violations;
}

/**
 * The teaching rejection message: what fired, why it is a leak, and the two
 * sanctioned alternatives — a presence test for an ambient variable, and the
 * engine's value-free preflight probe for "can the credential be resolved?".
 *
 * @param {Violation[]} violations
 * @returns {string}
 */
function rejectionMessage(violations) {
  const findings = violations.map((v) => `  - ${v.family}: ${v.detail}`).join('\n');
  return [
    '[echo-guard] BLOCKED — Convention 8 (secret-safe tool output).',
    '',
    'This command was rejected BEFORE it ran because it matches a secret-echo shape:',
    findings,
    '',
    'Why: tool output is not ephemeral — it is the session transcript on disk, long-lived',
    'and read by humans and downstream agents alike. A value that reaches stdout has left',
    'containment, and the only remedy afterwards is rotating the credential.',
    '',
    'Sanctioned alternatives:',
    '  - "is the ambient variable set?" — the ONE sanctioned presence test:',
    '        [ -n "$VAR" ] && echo set',
    '  - "can the credential actually be resolved?" — the engine\'s value-free preflight',
    '    probe, never a hand-run lookup:',
    '        flotilla-engine credential-probe --all',
    '    (wave-start step 4 / wave-close phase 2. ADR-0029: a configured <VAR>_CMD',
    '     Lookup-Command\'s stdout IS the secret, so no role runs it outside the engine.)',
    '',
    'Full doctrine: .claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md',
    'Scope note: this guard is a speed bump over the command TEXT, not an anchor — it does',
    'not see indirect expansion. Passing it is not proof that a command is safe.',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The PreToolUse entry point
// ---------------------------------------------------------------------------

/**
 * Decide on one hook payload. Returns the process exit code: 2 blocks, 0 allows.
 * Anything that is not a Bash tool call with a non-empty command is allowed —
 * this hook has no opinion about other tools.
 *
 * @param {unknown} payload the parsed `PreToolUse` stdin JSON
 * @param {Record<string, string | undefined>} env
 * @param {(text: string) => void} writeStderr
 * @returns {0 | 2}
 */
function decide(payload, env, writeStderr) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const toolName = input.tool_name;
  if (typeof toolName === 'string' && toolName !== 'Bash') return 0;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const violations = evaluateCommand(command, env);
  if (violations.length === 0) return 0;
  writeStderr(rejectionMessage(violations));
  return 2;
}

/* c8 ignore start — the process boundary is covered by spawning the script. */
if (require.main === module) {
  let code = 0;
  try {
    const raw = require('node:fs').readFileSync(0, 'utf-8');
    code = decide(JSON.parse(raw), process.env, (text) => process.stderr.write(text));
  } catch (err) {
    // FAIL OPEN — see the "Failure mode" note above. The guard never becomes
    // the reason a session cannot run a command.
    code = 0;
    try {
      const reason = err && err.message ? err.message : String(err);
      process.stderr.write(`[echo-guard] internal error — failing open: ${reason}\n`);
    } catch (_ignored) {
      /* nothing left to do */
    }
  }
  process.exit(code);
}
/* c8 ignore stop */

module.exports = {
  evaluateCommand,
  rejectionMessage,
  decide,
  commandHeads,
  configuredCredentialNames,
  configuredLookupCommands,
  isCredentialShaped,
  CREDENTIAL_NAME_SUFFIXES,
  MIN_LOOKUP_VALUE_LENGTH,
  neutralizeQuotedSpans,
  neutralizeHeredocBodies,
  literalSpanNeutralized,
};
