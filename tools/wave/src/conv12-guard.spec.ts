import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * conv12-guard.spec.ts — the executable specification of the `PreToolUse`
 * guard over a Bash command string (`tools/wave/hooks/conv12-guard.cjs`,
 * ADR-0034 Promotion; scanner and answer set rebuilt under ADR-0052).
 *
 * Like the echo-guard's spec beside it, this SPAWNS the hook rather than
 * importing it: the guard is a zero-dependency CommonJS script living outside
 * `src/` (clear of the agent-write-denied settings-adjacent paths), and the
 * spawn drives the real `PreToolUse` contract end to end — tool-call JSON on
 * stdin, decision on the exit code, message on stderr. Hermetic: an explicit
 * empty child environment on every case (the guard reads no config, but the
 * discipline is uniform across the hooks suite).
 *
 * ## What each answer kind asserts (ADR-0052)
 *
 * The guard now answers in THREE kinds, and each has its own assertion shape,
 * because the whole point of the third kind is that it must not be mistaken for
 * the other two:
 *
 *   - **A decided BLOCK** asserts exit 2, the FOUND wording, the mechanism, all
 *     three rewrite remedies, and — new with ADR-0052 — that the message does
 *     NOT recite Convention 12's rule sentence as though the rule had been
 *     checked. The predicate and the rule disagree in five of seven measured
 *     probe shapes; a message that states the rule is claiming a check it never
 *     ran.
 *   - **A decided PASS** asserts exit 0 AND empty stderr. Silence is the only
 *     honest shape for "nothing found": a non-verdict that also exits 0 is
 *     distinguishable from it only by the fact that it says something.
 *   - **An ABSTENTION** asserts exit 2 (this guard's declared Resolution bias),
 *     that the message names the shape the scanner could not parse, and the
 *     NEGATIVE that carries the doctrine: it makes no claim about an expansion.
 *     A guard that hedges in the vocabulary of a finding has not abstained.
 *
 * Every blocking case also asserts the message carries no `.claude/` path: the
 * refusal ships verbatim to installed-form consumers whose skills live in the
 * plugin clone, so a repo-local pointer would be dead where it is read
 * (Convention 14 — the why travels inline).
 *
 * ## The falsification record (Convention 11)
 *
 * The blocked cases double as it. The first is byte-shaped like the live failure
 * that occurred hours before this guard was first written — `set -- $pair` in a
 * Coordinator flip loop. The two `false-negative` cases are the shapes the
 * PREVIOUS scanner passed silently, measured in the FOR-437 grill: an unbalanced
 * `"` inside a quoted-delimiter heredoc body, and one inside a `#` comment, each
 * followed by a real `git checkout $BRANCH`. Run against the shipped scanner at
 * this row's anchor they both exit 0; they are here because they are the two
 * directions of one root cause, and a regression in either is a silent one.
 */

const GUARD = join(__dirname, '..', 'hooks', 'conv12-guard.cjs');

function run(stdin: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [GUARD], { input: stdin, encoding: 'utf8', env: {} });
  return { status: r.status, stderr: r.stderr };
}

function bash(command: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

const BLOCKED: Array<[string, string]> = [
  ['the live flip-loop failure shape (unquoted $pair after set --)', 'for pair in "431 a" "428 b"; do set -- $pair; echo $1; done'],
  ['a command held in a variable, invoked unquoted', 'CLI="npx tsx tools/wave/src/cli.ts"; $CLI spine read wave.md'],
  ['flags held in a variable, expanded unquoted in argument position', 'wave_cli issue-store transition 431 queued $CFG'],
  ['the braced form', 'echo ${WAVE_FILE} | tee log.txt'],
  ['an unquoted expansion inside an unquoted command substitution', 'echo $(basename $WAVE_FILE)'],
  ['an unquoted expansion after a quoted span ends', 'echo "ok: " $RESULT'],
  // A substitution's body is its own command line — entering `$( )` RESETS the
  // quote context, exactly as bash re-parses it. Without that reset the frame
  // stack would turn the false-positive repair into a new false-negative class.
  ['an unquoted expansion inside a QUOTED command substitution', 'echo "$(cat $FILE)"'],
  ['an unquoted expansion inside a quoted backtick substitution', 'echo "`cat $FILE`"'],
  ['the braced value-substituting form, unquoted', 'echo ${NAME:-"fallback"}'],
  // The false negative the FOR-437 grill measured on live traffic: `$f` twice
  // unquoted inside substitutions, hidden from the flat scanner by the outer
  // quote that never closed.
  [
    'the measured false negative (unquoted $f inside two substitutions)',
    "for f in wf-*.json; do echo \"$f: $(grep -c 'NT-' $f) NT-mentions, $(wc -c < $f) bytes\"; done",
  ],
];

/**
 * The two silent false-pass channels, pinned by the mechanism that closes each.
 * Both were probed in the grill with a real `git checkout $BRANCH` after the
 * unbalanced quote, and both passed the shipped scanner.
 */
const FALSE_NEGATIVES_CLOSED: Array<[string, string]> = [
  [
    'mechanism: a heredoc BODY is skipped to its terminator, so an unbalanced " inside it never opens a quote',
    'cat > x.sh <<\'EOF\'\necho "unbalanced\nEOF\ngit checkout $BRANCH',
  ],
  [
    'mechanism: a # comment is skipped to end of line, so an unbalanced " inside it never opens a quote',
    '# a note about an unbalanced " quote\ngit checkout $BRANCH',
  ],
];

const ALLOWED: Array<[string, string]> = [
  ['a double-quoted expansion (word-split-safe)', 'git -C "$REPO" worktree list --porcelain'],
  ['a single-quoted literal dollar (no expansion)', "grep -n '$VAR' docs/notes.md"],
  ['a bare command substitution (not a parameter expansion)', 'A=$(git rev-parse HEAD) && git rev-parse --verify "$A^{commit}"'],
  ['the sanctioned value-free presence test (double-quoted)', '[ -n "$GITHUB_TOKEN" ] && echo set'],
  ['shell specials and positionals (out of the class)', 'bash script.sh; echo $?; echo $#'],
  ['arithmetic expansion without an inner dollar', 'echo $((3 + 4))'],
  ['arithmetic expansion WITH an inner dollar (nothing inside one is field-split)', 'echo $((N + 1)) $((X * 2))'],
  ['an escaped dollar (literal)', 'echo \\$HOME stays literal'],
  ['a JSON heredoc body (content inside double-quoted JSON strings)', 'cat > "/tmp/x.json" <<\'EOF\'\n{"tests":"2948 passed","lint":"clean"}\nEOF'],
  ['a plain command with no dollar at all', 'npm ci --prefix tools/wave'],
  // The five FOR-437 control shapes, one variable at a time. The last two were
  // REFUSED by the shipped scanner and are correct shell.
  ['control 1 — bare substitution, no quotes', 'X=$(node -e 1)'],
  ['control 2 — inner quote, no outer', 'X=$(echo "$Y")'],
  ['control 3 — outer quote, no inner', 'X="$(node -e 1)"'],
  ['control 4 — outer AND inner quote (was refused)', 'X="$(echo "$Y")"'],
  ['control 5 — the same shape in argument position (was refused)', 'jq . "$(dirname "$Y")"'],
  // Parity-dependence is gone: depth is modelled, so a fifth level is as safe
  // as the fourth. The shipped scanner passed the first of these by accident
  // (four quotes balancing) and refused the second.
  ['triple nesting', 'echo "$(basename "$(dirname "$P")")"'],
  ['quadruple nesting', 'echo "$(dirname "$(basename "$(dirname "$P")")")"'],
  // The dominant false-refusal shape on live traffic: 359 of the 381 commands a
  // construct allowlist would have deferred. It is the escape hatch the guard's
  // own refusal message prescribes.
  ['the script-file heredoc the refusal message itself prescribes', 'cat > "$TMPDIR/x.sh" <<\'SCRIPT\'\necho hi\nSCRIPT'],
  ['a heredoc with an UNQUOTED delimiter (body is stdin data either way)', 'cat > out.txt <<EOF\nvalue is $HOME\nEOF'],
  ['a tab-stripping heredoc', 'cat <<-EOF\n\tindented body\n\tEOF'],
  ['a single-quoted jq program (its $name is jq\'s variable, never a shell expansion)', "jq -n --slurpfile titles t.json '($titles[0] | map($chosen))'"],
  ['a single-quoted awk program', "awk '{print $1, $NF}' log.txt"],
  ['a quoted backtick substitution with a quoted expansion inside', 'echo "`basename "$P"`"'],
  ['the braced value-substituting form, QUOTED', 'echo "${NAME:-"fallback"}"'],
  ['a # comment naming an expansion that never runs', 'ls -la   # look at $HOME later'],
];

/**
 * ADR-0052's Abstention: the scanner's OWN broken invariant, never a construct
 * allowlist. Three shapes, one per invariant.
 */
const ABSTENTIONS: Array<[string, string, string]> = [
  ['an unterminated heredoc', 'cat > x.sh <<\'SCRIPT\'\necho hi\n', 'unterminated heredoc'],
  ['an unclosed double quote', 'echo "hello', 'unclosed double quote'],
  ['an unclosed command substitution', 'echo $(basename /a/b', 'unclosed command substitution'],
];

describe('conv12-guard: decided blocks', () => {
  for (const [label, command] of [...BLOCKED, ...FALSE_NEGATIVES_CLOSED]) {
    it(`blocks ${label}`, () => {
      const { status, stderr } = run(bash(command));
      expect(status).toBe(2);
      expect(stderr).toContain('conv12-guard: FOUND an UNQUOTED parameter expansion');
      expect(stderr).toContain('NOT field-split');
      expect(stderr).toContain('write the value out literally');
      expect(stderr).toContain('bash <file>');
      expect(stderr).not.toContain('.claude/');
      // ADR-0052 decision 4 — the message states what it CHECKED, never the
      // broader rule it serves. The predicate and Convention 12's rule disagree
      // in five of seven measured probe shapes.
      expect(stderr).not.toContain('Never hold a command or its flags in a shell variable');
      // …and it never borrows the Abstention's vocabulary.
      expect(stderr).not.toContain('ABSTENTION');
    });
  }
});

describe('conv12-guard: decided passes', () => {
  for (const [label, command] of ALLOWED) {
    it(`passes ${label}`, () => {
      const { status, stderr } = run(bash(command));
      expect(status).toBe(0);
      expect(stderr).toBe('');
    });
  }
});

describe('conv12-guard: Abstention (ADR-0052) — the third answer kind', () => {
  for (const [label, command, shape] of ABSTENTIONS) {
    it(`abstains on ${label}, and blocks (declared Resolution bias)`, () => {
      const { status, stderr } = run(bash(command));
      expect(status).toBe(2);
      expect(stderr).toContain('conv12-guard: ABSTENTION');
      expect(stderr).toContain('reached NO verdict');
      expect(stderr).toContain(shape);
      // The load-bearing negative: an Abstention is a statement about the
      // guard, never a finding. It must not assert an expansion, in either
      // direction, and it must not wear a decided refusal's wording.
      expect(stderr).not.toContain('FOUND an UNQUOTED parameter expansion');
      expect(stderr).not.toContain('.claude/');
    });
  }

  it('an Abstention wins over a finding collected before the invariant broke', () => {
    // Both answers block, so the ordering changes the MESSAGE, not the outcome:
    // a finding is only as good as the state machine that classified the
    // quoting around it, and a scanner that ended inconsistent must not assert
    // one. That is the overclaim ADR-0052 exists to stop.
    const { status, stderr } = run(bash('git checkout $BRANCH && cat <<EOF\nbody\n'));
    expect(status).toBe(2);
    expect(stderr).toContain('conv12-guard: ABSTENTION');
    expect(stderr).not.toContain('FOUND an UNQUOTED parameter expansion');
  });
});

describe('conv12-guard: non-verdicts name themselves and keep the pass direction', () => {
  it('names the stdin-unreadable branch', () => {
    // fd 0 opened WRITE-only: `readFileSync(0)` throws EBADF, which is the only
    // way to reach this branch from outside — an empty or closed stdin reads as
    // the empty string and lands in the payload branch below.
    const writeOnly = openSync('/dev/null', 'w');
    const r = spawnSync(process.execPath, [GUARD], {
      encoding: 'utf8',
      env: {},
      stdio: [writeOnly, 'pipe', 'pipe'],
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('conv12-guard: NON-VERDICT (stdin-unreadable)');
    expect(r.stderr).toContain('No check ran');
  });

  it('names the payload-unparseable branch on empty stdin', () => {
    const { status, stderr } = run('');
    expect(status).toBe(0);
    expect(stderr).toContain('conv12-guard: NON-VERDICT (payload-unparseable)');
  });

  it('names the payload-unparseable branch on malformed JSON', () => {
    const { status, stderr } = run('{not json');
    expect(status).toBe(0);
    expect(stderr).toContain('conv12-guard: NON-VERDICT (payload-unparseable)');
  });

  it('names the command-absent branch for a Bash call with no command', () => {
    const { status, stderr } = run(JSON.stringify({ tool_name: 'Bash', tool_input: {} }));
    expect(status).toBe(0);
    expect(stderr).toContain('conv12-guard: NON-VERDICT (command-absent)');
  });

  it('a non-Bash tool call is OUT OF SUBJECT — a decided pass, silently', () => {
    // Not a non-verdict: the guard's declared subject is a Bash command string,
    // and "this is not my subject" is a decision. Naming it on every Read/Edit
    // call would be noise, not honesty.
    const { status, stderr } = run(
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/$X' } }),
    );
    expect(status).toBe(0);
    expect(stderr).toBe('');
  });
});

describe('conv12-guard: the Guard declaration is present and machine-readable (ADR-0052)', () => {
  const source = readFileSync(GUARD, 'utf8');

  it('declares its Subject', () => {
    expect(source).toContain('**Subject.**');
  });

  it('declares a Resolution bias, and it is BLOCKS', () => {
    expect(source).toContain('**Resolution bias — BLOCKS.**');
  });

  it('declares an Unmodelled set', () => {
    expect(source).toContain('**Unmodelled set, named rather than assumed away.**');
  });

  it('names the predicate-vs-rule gap as the first Unmodelled member', () => {
    // The gap is measured, not suspected: `eval "$CMD"`, `bash -c "$CMD"` and
    // `git log "$F"` with flags in `$F` all violate Convention 12's rule and all
    // pass this predicate. It is declared rather than left to be discovered.
    expect(source).toContain('The predicate is narrower than Convention 12');
  });
});
