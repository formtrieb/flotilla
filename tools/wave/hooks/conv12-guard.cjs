#!/usr/bin/env node
'use strict';

/**
 * conv12-guard.cjs — the `PreToolUse` guard over a Bash tool call's command
 * string (ADR-0034 Promotion, doctrine-budget grill 2026-08-09; scanner and
 * answer set rebuilt under ADR-0052, FOR-437 grill 2026-09-21).
 *
 * A zero-dependency CommonJS scanner, run before the command executes. It looks
 * for one shape: an UNQUOTED parameter expansion (`$NAME` / `${NAME}`) sitting
 * where the shell would field-split it. Under zsh an unquoted expansion is NOT
 * field-split, so a command or flag string held in a variable arrives as a
 * single token — the call exits 127 (or runs subtly wrong) and the surrounding
 * batch's success echo prints anyway. Silent failure mode, which is what earned
 * the rule its structural tier at six occurrences.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Guard declaration (ADR-0052)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **Subject.** The COMMAND STRING of a `Bash` tool call, read as shell text by
 * the quote/substitution state machine in {@link scanCommand}. Nothing else:
 * not the tool's other inputs, not the environment, not what the command would
 * do if it ran. A tool call that is not `Bash` is out of subject and is a
 * decided pass, silently.
 *
 * **Resolution bias — BLOCKS.** When the scanner reaches the end of the command
 * with its own state machine inconsistent — an unclosed quote, an unclosed
 * substitution level, an unterminated heredoc — it emits an **Abstention** and
 * exits 2. Standing still is cheap against this class: it has eight live
 * occurrences behind it, and the rewrite the caller is asked for costs one
 * round trip. This is the opposite of the sibling `echo-guard.cjs`, whose
 * declared bias is to PASS (its traffic is prose full of shell metacharacters,
 * and a hook that bricks every Bash call on its own parse bug costs more than
 * the vector it closes). Two hooks, one directory, opposite biases — declared
 * on both, per hook, rather than left to whichever direction the author picked.
 *
 * **The bias governs the Abstention, and the exceptions are named, not
 * smoothed over.** Four other non-verdicts keep the PASS direction and exit 0:
 * unreadable stdin, an unparseable payload, an absent command string, and this
 * guard's own crash. Each one says so on stderr — saying is mandatory, blocking
 * is discretion (ADR-0052 decision 2). A parse bug that stopped every Bash call
 * in a session is the trade both shipped hooks already refuse.
 *
 * **An Abstention is a statement about this guard, never a finding.** It names
 * the shape the scanner could not parse and asserts nothing about an expansion
 * — neither that one is there nor that none is. A decided refusal never borrows
 * its hedging, and it never borrows the Abstention's wording.
 *
 * **Unmodelled set, named rather than assumed away.** What the scanner does not
 * read, stated here rather than left for the next reader to infer from a false
 * refusal:
 *
 *  1. **The predicate is narrower than Convention 12's rule.** `eval "$CMD"`,
 *     `bash -c "$CMD"` and `git log "$F"` with flags in `$F` each violate the
 *     rule — a command or its flags held in a variable — and each passes here,
 *     because each quotes the expansion. Conversely `B=main; git checkout $B`
 *     violates nothing in the rule and blocks, because the predicate is the
 *     unquoted expansion, in any position, value or command alike. The refusal
 *     message says what was found and does not claim the rule was checked. The
 *     `eval` / `bash -c` predicate is a separate ticket with its own controls.
 *  2. **Heredoc BODIES are skipped whole.** A body is stdin data for whatever
 *     reads it, never this call's own command text. With an unquoted delimiter
 *     bash really does expand inside it, so a `$(…)` there is a real command
 *     whose own unquoted expansions this scanner never sees. Deliberate: the
 *     alternative is re-entering the scan on data, which is the direction the
 *     false refusals came from.
 *  3. **Here-strings (`<<<`).** Not a heredoc, not modelled as one. Bash does
 *     not field-split a here-string word, so `cmd <<< $X` is safe and this
 *     scanner blocks it anyway, as ordinary unquoted command text. A decided
 *     false refusal, kept because the shape is vanishingly rare here and the
 *     fix is one pair of quotes.
 *  4. **Indirect and special expansions.** `${!VAR}`, `${#VAR}`, `$@`, `$*`,
 *     `$1`, `$?`, `$$` are all out of the class — the name regex does not match
 *     them, so none is ever a finding, including the genuinely split-prone
 *     unquoted `${!VAR}` and unquoted `$@`.
 *  5. **Arithmetic bodies.** `$(( … ))` is modelled as a skip. Nothing inside
 *     one is field-split, so nothing inside one is read.
 *  6. **Deliberate string assembly.** `V=NAME; eval "echo \\$$V"` walks past,
 *     as does any command built at runtime. This is a speed bump with teeth,
 *     not an anchor: passing it is not evidence that a command is safe.
 *  7. **Everything the state machine gets wrong before it notices.** The
 *     scanner is a character walker, not a shell grammar. Where it mis-parses
 *     and still ends BALANCED, it answers with a decided verdict that may be
 *     wrong — the Abstention is a tripwire on inconsistency, not a proof of
 *     correctness.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## What the scanner models (ADR-0052's scanner half, flotilla#710)
 *
 * The predecessor walked the command with two booleans — `inSingle`,
 * `inDouble` — and had no notion of `$( )` nesting, a heredoc body, a `#`
 * comment or a backtick. Measured over 3477 distinct Bash commands from this
 * repo's own session transcripts, that cost 36 false refusals out of 60 (60%)
 * and let one genuine violation through silently. Both directions are the same
 * root cause: one flat quote state, so an inner quote closed the outer span and
 * an unbalanced quote in data opened one forever.
 *
 * What replaces it, modelled the way the sibling `echo-guard.cjs` already
 * modelled it 200 lines away (read it before changing this; it is the reference
 * implementation, deliberately NOT a shared module — see the distribution note
 * at the foot of this comment):
 *
 *   - **A frame stack, one frame per nesting level.** `'` and `"` push their
 *     own frame, so an inner quote closes only the string it opened.
 *   - **`$( )` and backticks push a frame whose quote context is RESET.** A
 *     substitution's body is its own command line, exactly as bash re-parses
 *     it, so `echo "$(cat $FILE)"` still blocks on `$FILE` while
 *     `jq . "$(dirname "$Y")"` passes.
 *   - **`${ … }` pushes a frame that INHERITS the surrounding quoting**, so
 *     `"${NAME:-"fallback"}"` parses and `${NAME:-"fallback"}` still blocks.
 *   - **Heredoc bodies are skipped to the terminator line**, delimiter-aware:
 *     `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, `<<\WORD`.
 *   - **`#` comments** are skipped from a `#` at a word boundary to end of
 *     line, outside quotes.
 *   - **`$(( … ))` is modelled and skipped**, not deferred.
 *   - **Single-quoted spans stay inert** — a jq/awk/sed program in `'…'` is
 *     literal, and `$name` inside one is that tool's variable, never a shell
 *     expansion.
 *
 * Both false-negative channels the grill found are closed by the last two
 * modelled constructs rather than by a new rule: an unbalanced `"` inside a
 * quoted-delimiter heredoc body, or inside a `#` comment, is never seen at all,
 * so the genuine `git checkout $BRANCH` after it is read at top level and
 * blocked.
 *
 * ## Distribution — why the copy goes to a TRACKED path, not the installed package
 *
 * Same rule as the Echo-Guard beside it, restated here rather than left only on
 * that neighbour: `wave-setup`'s scaffold copies this script to a TRACKED path
 * in the consumer repo, `.claude/hooks/conv12-guard.cjs`, and wires it into the
 * SAME `hooks.PreToolUse` block the Echo-Guard entry joins. That destination is
 * deliberately NOT the installed package's own copy — `node_modules` is
 * gitignored, so a dispatched, worktree-isolated role, which checks out
 * tracked files only, would never see a script left there. It is also why the
 * two scanners share no module: a third file turns a missed scaffold copy into
 * a new silent failure mode. They share a CONFORMANCE SUITE instead
 * (`../src/shell-quoting-conformance.spec.ts`), which is what makes their drift
 * loud without adding a scaffolded file. The exact scaffold commands, the
 * `hooks.PreToolUse` JSON, and flotilla's own vendored exception live in the
 * `wave-setup` skill's setup-mechanics reference, not here.
 */

/**
 * @typedef {{ kind: 'pass' }
 *   | { kind: 'block', name: string }
 *   | { kind: 'abstain', shape: string }} Verdict
 */

/**
 * @typedef {object} Frame
 * @property {'base'|'single'|'double'|'subst'|'backtick'|'arith'|'brace'} type
 * @property {boolean} quoted whether text directly in this frame is protected
 *   from field splitting. `base`, `subst` and `backtick` are false — a
 *   substitution re-parses its body as a fresh command line. `single` and
 *   `double` are true. `brace` INHERITS from the frame that pushed it.
 * @property {number} depth bare-paren depth for `subst`/`base`, paren depth
 *   for `arith`, brace depth for `brace`. Unused elsewhere.
 */

/** A `$`-introduced parameter expansion whose NAME is in the checked class. */
const EXPANSION_NAME = /^\{?([A-Za-z_][A-Za-z0-9_]*)/;

/** `<<`, optional `-`, optional whitespace, an optionally quoted delimiter word. */
const HEREDOC_INTRO = /^<<(-?)[ \t]*(['"\\]?)([A-Za-z_][A-Za-z0-9_]*)\2?/;

/** Characters that put the NEXT character at the start of a fresh word. */
const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')']);

function isNameChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * True when the character at `i` starts a fresh word — the position at which a
 * `#` is a comment introducer rather than an ordinary character.
 *
 * @param {string} s
 * @param {number} i
 */
function atWordStart(s, i) {
  return i === 0 || WORD_BREAK.has(s[i - 1]);
}

/**
 * Consume every heredoc body queued on the line that just ended.
 *
 * `pos` is the index of the `\n` that ends the opening line. Each pending
 * heredoc's body runs from the following line to the first line that is its
 * delimiter alone (leading/trailing blanks tolerated, matching the sibling
 * scanner's lenient terminator so the two agree on the same corpus).
 *
 * The body is skipped WHOLE, for either delimiter flavour — see Unmodelled set
 * member 2. A quoted delimiter additionally makes bash suppress every expansion
 * inside the body, which is why the skip is unambiguously right there; with an
 * unquoted delimiter the skip is the deliberate simplification.
 *
 * @param {string} s the full command
 * @param {number} pos index of the newline that ends the opening line
 * @param {Array<{ delim: string }>} pending heredocs opened on that line, in order
 * @returns {{ next: number, unterminated: string | null }} where scanning resumes,
 *   and the delimiter of the first heredoc that never found its terminator
 */
function consumeHeredocBodies(s, pos, pending) {
  let i = pos + 1;
  for (const hd of pending) {
    const closeExact = new RegExp('^[ \\t]*' + hd.delim + '[ \\t]*$');
    let terminated = false;
    while (i <= s.length) {
      const nl = s.indexOf('\n', i);
      const line = nl === -1 ? s.slice(i) : s.slice(i, nl);
      const lineEnd = nl === -1 ? s.length : nl;
      if (closeExact.test(line)) {
        terminated = true;
        i = lineEnd; // leave the `\n` for the main loop; `i === s.length` when absent
        break;
      }
      if (nl === -1) {
        i = s.length;
        break;
      }
      i = nl + 1;
    }
    if (!terminated) return { next: s.length, unterminated: hd.delim };
  }
  return { next: i, unterminated: null };
}

/**
 * Scan one command string and answer with one of ADR-0052's three answer kinds.
 *
 * Ordering, stated because it is a decision and not an accident: the
 * END-OF-SCAN invariant check runs FIRST against any finding the walk
 * collected. A finding is only as good as the state machine that classified the
 * quoting around it, so a scanner that ended inconsistent must not assert one —
 * that is precisely the overclaim ADR-0052 exists to stop. Both answers block
 * here, so the ordering changes the message, not the outcome.
 *
 * @param {string} command
 * @returns {Verdict}
 */
function scanCommand(command) {
  /** @type {Frame[]} */
  const stack = [{ type: 'base', quoted: false, depth: 0 }];
  /** @type {Array<{ delim: string }>} */
  let pendingHeredocs = [];
  /** @type {string | null} */
  let finding = null;
  /** @type {string | null} */
  let unterminatedHeredoc = null;

  const n = command.length;
  let i = 0;

  while (i < n) {
    const frame = stack[stack.length - 1];
    const ch = command[i];

    // ── a heredoc body starts at the newline that ends its opening line ──────
    if (ch === '\n' && pendingHeredocs.length > 0) {
      const { next, unterminated } = consumeHeredocBodies(command, i, pendingHeredocs);
      pendingHeredocs = [];
      if (unterminated !== null) {
        unterminatedHeredoc = unterminated;
        break;
      }
      i = next;
      continue;
    }

    // ── arithmetic: modelled as a balanced skip, never entered ──────────────
    if (frame.type === 'arith') {
      if (ch === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === '(') frame.depth += 1;
      else if (ch === ')') {
        frame.depth -= 1;
        if (frame.depth === 0) stack.pop();
      }
      i += 1;
      continue;
    }

    // ── single quotes: fully literal, no escapes, no expansions ─────────────
    if (frame.type === 'single') {
      if (ch === "'") stack.pop();
      i += 1;
      continue;
    }

    // ── everything else: double, base, subst, backtick, brace ───────────────
    if (ch === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }

    if (frame.type === 'double') {
      if (ch === '"') {
        stack.pop();
        i += 1;
        continue;
      }
    } else if (ch === "'") {
      stack.push({ type: 'single', quoted: true, depth: 0 });
      i += 1;
      continue;
    } else if (ch === '"') {
      stack.push({ type: 'double', quoted: true, depth: 0 });
      i += 1;
      continue;
    }

    if (ch === '`') {
      if (frame.type === 'backtick') stack.pop();
      else stack.push({ type: 'backtick', quoted: false, depth: 0 });
      i += 1;
      continue;
    }

    if (ch === '$') {
      if (command.startsWith('$((', i)) {
        stack.push({ type: 'arith', quoted: frame.quoted, depth: 2 });
        i += 3;
        continue;
      }
      if (command.startsWith('$(', i)) {
        stack.push({ type: 'subst', quoted: false, depth: 0 });
        i += 2;
        continue;
      }
      const m = EXPANSION_NAME.exec(command.slice(i + 1));
      if (m && !frame.quoted && finding === null) finding = m[1];
      if (command[i + 1] === '{') {
        stack.push({ type: 'brace', quoted: frame.quoted, depth: 1 });
        i += 2;
        continue;
      }
      if (m) {
        i += 1 + m[0].length;
        continue;
      }
      i += 1;
      continue;
    }

    if (frame.type === 'brace') {
      if (ch === '{') frame.depth += 1;
      else if (ch === '}') {
        frame.depth -= 1;
        if (frame.depth === 0) stack.pop();
      }
      i += 1;
      continue;
    }

    if (frame.type === 'double') {
      // `(`, `)`, `#`, `<<` carry no special meaning inside double quotes.
      i += 1;
      continue;
    }

    // base / subst / backtick — genuinely unquoted command text.
    if (ch === '#' && atWordStart(command, i)) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? n : nl; // leave the `\n` so a pending heredoc still opens
      continue;
    }

    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const hd = HEREDOC_INTRO.exec(command.slice(i));
      if (hd) {
        pendingHeredocs.push({ delim: hd[3] });
        i += hd[0].length;
        continue;
      }
    }

    if (ch === '(') {
      frame.depth += 1;
    } else if (ch === ')') {
      if (frame.depth > 0) frame.depth -= 1;
      else if (frame.type === 'subst') stack.pop();
      // else: an unmatched `)` at top level — a `case` pattern arm, ordinary text.
    }
    i += 1;
  }

  // ── the invariant check, ADR-0052 decision 3 ──────────────────────────────
  if (unterminatedHeredoc !== null) {
    return { kind: 'abstain', shape: `an unterminated heredoc (delimiter \`${unterminatedHeredoc}\`)` };
  }
  if (pendingHeredocs.length > 0) {
    return {
      kind: 'abstain',
      shape: `a heredoc opened with \`${pendingHeredocs[0].delim}\` whose body never begins`,
    };
  }
  if (stack.length > 1) {
    const quote = stack.find((f) => f.type === 'single' || f.type === 'double');
    if (quote) {
      return {
        kind: 'abstain',
        shape: `an unclosed ${quote.type === 'single' ? 'single' : 'double'} quote`,
      };
    }
    const open = stack[stack.length - 1];
    const label =
      open.type === 'arith'
        ? 'an unclosed arithmetic expansion `$(( … ))`'
        : open.type === 'brace'
          ? 'an unclosed brace expansion `${ … }`'
          : open.type === 'backtick'
            ? 'an unclosed backtick substitution'
            : 'an unclosed command substitution `$( … )`';
    return { kind: 'abstain', shape: label };
  }

  if (finding !== null) return { kind: 'block', name: finding };
  return { kind: 'pass' };
}

/**
 * The decided refusal. It states WHAT WAS FOUND — an unquoted expansion — and
 * says the rule it serves is broader than the test, rather than reciting
 * Convention 12 as though the rule had been checked (ADR-0052 decision 4).
 *
 * @param {string} name
 */
function refusalMessage(name) {
  return (
    `conv12-guard: FOUND an UNQUOTED parameter expansion ($${name}) in this command. ` +
    `That is what this guard checks — an expansion the shell would field-split — and it is ` +
    `narrower than the rule it serves: a command or its flags held in a variable can also ` +
    `reach the shell QUOTED, and this test passes those. Why the unquoted form is worth ` +
    `blocking: under zsh an unquoted expansion is NOT field-split, so a command or flag ` +
    `string held in a variable arrives as ONE token, the call runs nothing (exit 127) or runs ` +
    `wrong, and any trailing success echo prints anyway. The block covers ANY position — a ` +
    `VALUE as much as a command — because narrowing it to command position needs a shell ` +
    `grammar this scanner deliberately is not. Rewrite instead of overriding: ` +
    `(1) write the value out literally in the command; ` +
    `(2) double-quote the expansion ("$${name}") — the sanctioned form whenever a value, not a ` +
    `command, is what is meant; (3) for a loop or multi-step logic, write a script file and run ` +
    `it via bash <file> — bash field-splits explicitly and the file's content is not this tool ` +
    `call's text. And never let a captured value cross a Bash-call boundary — shell state does ` +
    `not survive between calls.\n`
  );
}

/**
 * The Abstention. It names the shape the scanner could not parse, states that
 * no verdict was reached, and makes NO claim about an expansion in either
 * direction (ADR-0052 decision 1).
 *
 * @param {string} shape
 */
function abstentionMessage(shape) {
  return (
    `conv12-guard: ABSTENTION — this guard read the command and reached NO verdict. ` +
    `Its quote and substitution state machine ended inconsistent: the command carries ${shape}. ` +
    `Past that point the scanner cannot tell quoted text from unquoted text, so it is not ` +
    `asserting that anything is wrong here — no finding is being made, and none is being ruled ` +
    `out either. This guard's declared resolution bias is to BLOCK when it cannot decide, ` +
    `because standing still is the cheap side of this particular class. Two ways forward: ` +
    `close the shape so the command parses (a heredoc needs its terminator on a line of its ` +
    `own; a quote needs its partner), or move the content out of the command line entirely — ` +
    `write the script or payload with the file-writing tool and run bash <file>, which is the ` +
    `remedy for every heredoc shape regardless of this guard.\n`
  );
}

/**
 * Non-verdicts that keep the PASS direction and exit 0. Each one NAMES itself:
 * saying is mandatory, blocking is discretion (ADR-0052 decision 2).
 *
 * @param {string} reason a short kebab slug identifying the branch
 * @param {string} detail one sentence of what was not read
 */
function nonVerdictMessage(reason, detail) {
  return (
    `conv12-guard: NON-VERDICT (${reason}) — ${detail} No check ran, so nothing here is ` +
    `evidence that this call is safe. Passing, because a guard that cannot read its own input ` +
    `must not become the reason a session stops.\n`
  );
}

/**
 * Decide on one `PreToolUse` payload.
 *
 * @param {unknown} payload the parsed stdin JSON
 * @param {(text: string) => void} writeStderr
 * @returns {0 | 2}
 */
function decide(payload, writeStderr) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const toolName = input.tool_name;
  if (typeof toolName === 'string' && toolName !== 'Bash') return 0; // out of subject
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : null;
  if (!command) {
    writeStderr(
      nonVerdictMessage(
        'command-absent',
        'the payload named a Bash tool call but carried no command string to read.',
      ),
    );
    return 0;
  }

  const verdict = scanCommand(command);
  if (verdict.kind === 'pass') return 0;
  if (verdict.kind === 'abstain') {
    writeStderr(abstentionMessage(verdict.shape));
    return 2;
  }

  // Occurrence history (Convention 14 position — provenance, not live teaching):
  // this shape recurred six times unpromoted, ten silent no-op writes behind a
  // false success echo among them (docs/adr/0034), before the seventh — an
  // unquoted `set -- $pair` in a Coordinator flip loop, hours before this hook
  // landed — became the spec's first blocked case. See conv12-guard.spec.ts and
  // wave-shared/reference/convention-12-no-command-in-a-shell-variable.md
  // ("The severity precedent" / "Live occurrences") for the dated record.
  writeStderr(refusalMessage(verdict.name));
  return 2;
}

/* c8 ignore start — the process boundary is covered by spawning the script. */
if (require.main === module) {
  let code = 0;
  const err = (text) => {
    try {
      process.stderr.write(text);
    } catch (_ignored) {
      /* nothing left to do */
    }
  };
  let raw = null;
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch (e) {
    err(
      nonVerdictMessage(
        'stdin-unreadable',
        `the hook payload could not be read from stdin (${e && e.message ? e.message : String(e)}).`,
      ),
    );
    process.exit(0);
  }
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    err(
      nonVerdictMessage(
        'payload-unparseable',
        `the hook payload on stdin is not JSON this guard can parse (${e && e.message ? e.message : String(e)}).`,
      ),
    );
    process.exit(0);
  }
  try {
    code = decide(payload, err);
  } catch (e) {
    // FAIL OPEN, and say so — the fifth non-verdict. A parse bug in this guard
    // must not stop every Bash call in the session (ADR-0052, rejected option 3).
    err(
      nonVerdictMessage(
        'guard-crashed',
        `this guard threw while scanning the command (${e && e.message ? e.message : String(e)}).`,
      ),
    );
    code = 0;
  }
  process.exit(code);
}
/* c8 ignore stop */

module.exports = {
  scanCommand,
  decide,
  refusalMessage,
  abstentionMessage,
  nonVerdictMessage,
};
