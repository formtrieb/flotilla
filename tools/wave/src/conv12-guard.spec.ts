import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * conv12-guard.spec.ts — the executable specification of the `PreToolUse`
 * Convention-12 guard (`tools/wave/hooks/conv12-guard.cjs`, ADR-0034 Promotion,
 * doctrine-budget grill 2026-08-09).
 *
 * Like the echo-guard's spec beside it, this SPAWNS the hook rather than
 * importing it: the guard is a zero-dependency CommonJS script living outside
 * `src/` (clear of the agent-write-denied settings-adjacent paths), and the
 * spawn drives the real `PreToolUse` contract end to end — tool-call JSON on
 * stdin, decision on the exit code, teaching message on stderr. Hermetic: an
 * explicit empty child environment on every case (the guard reads no config,
 * but the discipline is uniform across the hooks suite).
 *
 * A "block" case asserts exit 2 AND the teaching message: it names the
 * convention, the zsh no-word-split mechanism, and all three rewrite remedies
 * (literal / quoted / script file) — a guard that blocks without teaching just
 * moves the failure. It also asserts the message carries no `.claude/` path:
 * the refusal ships verbatim to installed-form consumers whose skills live in
 * the plugin clone, so a repo-local pointer would be dead where it is read
 * (Convention 14 — the why travels inline).
 *
 * The blocked cases below double as the falsification record (Convention 11):
 * the first one is byte-shaped like the live failure that occurred hours before
 * this guard was written — `set -- $pair` in a Coordinator flip loop, six calls
 * refused — so the guard is demonstrably observed FAILING the input it exists
 * to catch, not merely passing clean input.
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
];

const ALLOWED: Array<[string, string]> = [
  ['a double-quoted expansion (word-split-safe)', 'git -C "$REPO" worktree list --porcelain'],
  ['a single-quoted literal dollar (no expansion)', "grep -n '$VAR' docs/notes.md"],
  ['a bare command substitution (not a parameter expansion)', 'A=$(git rev-parse HEAD) && git rev-parse --verify "$A^{commit}"'],
  ['the sanctioned value-free presence test (double-quoted)', '[ -n "$GITHUB_TOKEN" ] && echo set'],
  ['shell specials and positionals (out of the class)', 'bash script.sh; echo $?; echo $#'],
  ['arithmetic expansion without an inner dollar', 'echo $((3 + 4))'],
  ['an escaped dollar (literal)', 'echo \\$HOME stays literal'],
  ['a JSON heredoc body (content inside double-quoted JSON strings)', 'cat > "/tmp/x.json" <<\'EOF\'\n{"tests":"2948 passed","lint":"clean"}\nEOF'],
  ['a plain command with no dollar at all', 'npm ci --prefix tools/wave'],
];

describe('conv12-guard: blocked shapes', () => {
  for (const [label, command] of BLOCKED) {
    it(`blocks ${label}`, () => {
      const { status, stderr } = run(bash(command));
      expect(status).toBe(2);
      expect(stderr).toContain('Convention-12 guard');
      expect(stderr).toContain('NOT word-split');
      expect(stderr).toContain('write the value out literally');
      expect(stderr).toContain('bash <file>');
      expect(stderr).not.toContain('.claude/');
    });
  }
});

describe('conv12-guard: allowed shapes', () => {
  for (const [label, command] of ALLOWED) {
    it(`passes ${label}`, () => {
      const { status, stderr } = run(bash(command));
      expect(status).toBe(0);
      expect(stderr).toBe('');
    });
  }
});

describe('conv12-guard: fail-open contract', () => {
  it('passes on empty stdin', () => {
    expect(run('').status).toBe(0);
  });
  it('passes on malformed JSON', () => {
    expect(run('{not json').status).toBe(0);
  });
  it('passes on a non-Bash payload with no command', () => {
    expect(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/$X' } })).status).toBe(0);
  });
});
