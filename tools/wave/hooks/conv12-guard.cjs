#!/usr/bin/env node
'use strict';

/**
 * conv12-guard.cjs — the `PreToolUse` Convention-12 guard (ADR-0034 Promotion,
 * decided in the doctrine-budget grill 2026-08-09).
 *
 * A zero-dependency CommonJS matcher over a Bash tool call's COMMAND STRING,
 * run before the command executes. It blocks the one shape Convention 12's six
 * live occurrences share: an UNQUOTED parameter expansion (`$NAME` / `${NAME}`)
 * in the command text. Under zsh an unquoted expansion is NOT word-split, so a
 * command or flag string held in a variable arrives as a single token — the
 * call exits 127 (or runs subtly wrong) and the surrounding batch's success
 * echo prints anyway. Silent failure mode, which is what earned the rule its
 * structural tier at six occurrences (three past the Promotion trigger).
 *
 * ## Honest scope — the quote scanner, not a shell parser
 *
 * The guard scans quoting state character-by-character and flags `$` followed
 * by a letter/underscore (a parameter expansion) OUTSIDE single- and
 * double-quoted spans. Everything else deliberately passes:
 *
 *   - `"$VAR"` (double-quoted)      → word-split-safe in both shells; allowed.
 *   - `'$VAR'` (single-quoted)      → literal, no expansion at all; allowed.
 *   - `$(cmd)` / `$((expr))`        → not a parameter expansion; allowed (the
 *                                     scan continues INSIDE an unquoted `$( )`,
 *                                     so `$(echo $X)` still blocks on `$X`).
 *   - `$?` `$#` `$@` `$*` `$1` …    → specials/positionals; out of the class.
 *   - `\$NAME`                      → escaped, literal; allowed.
 *
 * Heredoc bodies are NOT special-cased: a quoted-delimiter heredoc body is
 * literal to the shell but not to this scanner. In practice JSON payload
 * bodies pass anyway (their content sits in double-quoted JSON strings); a
 * prose heredoc carrying a bare `$word` may false-positive — the remedy the
 * message teaches (write the file through the file-writing tool) is the same
 * remedy Convention 13's catalog already prescribes for heredoc shapes.
 *
 * Like the echo-guard beside it: this is a speed bump with teeth, not an
 * anchor. A deliberately assembled string walks past it. It exists because the
 * shape it matches has never once been typed on purpose in this repo's history
 * and has broken a wave six times by accident.
 *
 * ## Failure mode — hard-block, and fail OPEN on the guard's own crash
 *
 * A match exits 2 (the blocking `PreToolUse` channel) with a teaching message
 * on stderr. Any internal error — malformed stdin, unreadable payload — exits
 * 0 and lets the command through: same deliberate trade the echo-guard
 * records, a guard that bricks every Bash call on its own parse bug costs more
 * than the vector it closes.
 */

function findUnquotedExpansion(command) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && !inSingle) {
      i++; // escaped char (inside double quotes or bare) — skip it
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '$' && !inSingle && !inDouble) {
      const rest = command.slice(i + 1);
      const m = /^\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      if (m) return m[1];
    }
  }
  return null;
}

function main() {
  let raw = '';
  try {
    raw = require('node:fs').readFileSync(0, 'utf8');
  } catch {
    process.exit(0); // fail open
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // fail open
  }
  const command =
    payload && payload.tool_input && typeof payload.tool_input.command === 'string'
      ? payload.tool_input.command
      : null;
  if (!command) process.exit(0);

  const name = findUnquotedExpansion(command);
  if (!name) process.exit(0);

  // Occurrence history (Convention 14 position — provenance, not live teaching):
  // this shape recurred six times unpromoted, ten silent no-op writes behind a
  // false success echo among them (docs/adr/0034), before the seventh — an
  // unquoted `set -- $pair` in a Coordinator flip loop, hours before this hook
  // landed — became the spec's first blocked case. See conv12-guard.spec.ts and
  // wave-shared/reference/convention-12-no-command-in-a-shell-variable.md
  // ("The severity precedent" / "Live occurrences") for the dated record.
  process.stderr.write(
    `Convention-12 guard: this command contains an UNQUOTED parameter expansion ($${name}). ` +
      `Under zsh an unquoted expansion is NOT word-split — a command or flag string held in a ` +
      `variable arrives as ONE token, the call runs nothing (exit 127) or runs wrong, and any ` +
      `trailing success echo prints anyway. This guard deliberately blocks ANY unquoted expansion, ` +
      `in ANY position — a VALUE, not only a command or its flags — because narrowing the block to ` +
      `command positions only would require the shell parsing this speed bump is designed not to do. ` +
      `Rewrite instead of overriding: (1) write the value out literally in the command; ` +
      `(2) double-quote the expansion ("$${name}") — the sanctioned form whenever a value, not a ` +
      `command, is what is meant; (3) for a loop or multi-step logic, write a script file and run it ` +
      `via bash <file> — bash word-splits explicitly and the file's content is not this tool call's ` +
      `text. Never hold a command or its flags in a shell variable, and never let a captured ` +
      `value cross a Bash-call boundary — shell state does not survive between calls.\n`,
  );
  process.exit(2);
}

main();
