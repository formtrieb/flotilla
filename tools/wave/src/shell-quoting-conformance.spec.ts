import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * shell-quoting-conformance.spec.ts — ONE corpus of shell shapes, run against
 * BOTH `PreToolUse` hook scanners, asserting each one's declared Resolution
 * bias (ADR-0052).
 *
 * ## Why this file exists at all, and why it is not a shared module
 *
 * `conv12-guard.cjs` and `echo-guard.cjs` each walk a Bash command's text with
 * their own quote/substitution state machine. The two machines answer different
 * questions — one looks for an unquoted parameter expansion, the other for a
 * secret-echo shape — but they read the SAME grammar to get there, and when
 * `conv12-guard`'s scanner was rebuilt under ADR-0052 the reference
 * implementation it was rebuilt against was the one 200 lines away.
 *
 * The obvious move from there is a shared `.cjs` scanner module. ADR-0052
 * rejects it, and the reason is distribution, not taste: `wave-setup` copies
 * each hook to a TRACKED path in the consumer repo precisely because a
 * worktree-isolated role never sees `node_modules`. A third file turns a missed
 * scaffold copy into a new silent failure mode — which is the exact class the
 * ADR exists to close. So the two scanners stay independent standalone scripts,
 * and the sharing happens HERE: one corpus, two scanners, each row carrying
 * both expected verdicts. Drift between them becomes a red test instead of a
 * discovery. It is the pattern the three `IssueStore` implementations already
 * carry — one conformance suite, unchanged across all three.
 *
 * ## What "asserting each one's declared bias" means mechanically
 *
 * A Resolution bias that lives only in prose is a claim nobody re-reads. The
 * bias assertions below PARSE the declared word out of each hook's own header
 * and then derive the expected behaviour from it, so the two can never drift
 * apart silently: change the behaviour and the assertion goes red; change the
 * declaration and the same assertion goes red. The probe is one command that
 * makes both scanners uncertain at once — an unbalanced `"` — and the two
 * resolve it in opposite directions, which is the whole of ADR-0052's second
 * decision in a single row.
 *
 * ## Scope boundary — this file asserts verdicts, never messages
 *
 * Each hook's own spec owns its message contract (`conv12-guard.spec.ts`,
 * `echo-guard.spec.ts`). Duplicating those assertions here would make one
 * wording change red in three files and teach nothing. What is genuinely shared
 * is the decision on a shell shape, so that is all this file reads — except for
 * the one place where the message IS the subject: telling an Abstention apart
 * from a decided block, which the exit code alone cannot do for a guard whose
 * bias is to block.
 */

const CONV12 = join(__dirname, '..', 'hooks', 'conv12-guard.cjs');
const ECHO = join(__dirname, '..', 'hooks', 'echo-guard.cjs');

type Verdict = 'pass' | 'block' | 'abstain';

/** Spawn one hook against one command and reduce its answer to a verdict kind. */
function verdict(guard: string, command: string): Verdict {
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: {},
  });
  if (r.status === 0) return 'pass';
  return r.stderr.includes('ABSTENTION') ? 'abstain' : 'block';
}

interface Shape {
  /** What the shape is, in the vocabulary of the grill that measured it. */
  readonly label: string;
  readonly command: string;
  readonly conv12: Verdict;
  readonly echo: Verdict;
  /** Why the two disagree, where they do. Absent when they agree. */
  readonly divergence?: string;
}

/**
 * The corpus. Membership is not arbitrary: every shape here either (a) was a
 * control in the FOR-437 grill, (b) was measured as a false refusal or a false
 * pass on live traffic, or (c) is one of the constructs ADR-0052's scanner half
 * newly models. A shape that is merely "another command" does not earn a row.
 */
const CORPUS: readonly Shape[] = [
  // ── The five original control shapes, one variable at a time ─────────────
  {
    label: 'control 1 — bare command substitution, no quotes',
    command: 'X=$(node -e 1)',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'control 2 — inner quote, no outer',
    command: 'X=$(echo "$Y")',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'control 3 — outer quote, no inner',
    command: 'X="$(node -e 1)"',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'control 4 — outer AND inner quote (the shipped scanner refused this)',
    command: 'X="$(echo "$Y")"',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'control 5 — the same shape in argument position (also refused)',
    command: 'jq . "$(dirname "$Y")"',
    conv12: 'pass',
    echo: 'pass',
  },

  // ── Depth, not parity ────────────────────────────────────────────────────
  {
    label: 'triple nesting — passed the shipped scanner only because four quotes balanced',
    command: 'echo "$(basename "$(dirname "$P")")"',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'quadruple nesting — one level further, where parity ran out',
    command: 'echo "$(dirname "$(basename "$(dirname "$P")")")"',
    conv12: 'pass',
    echo: 'pass',
  },

  // ── The two silent false-pass channels the grill probed ──────────────────
  {
    label: 'false negative 1 — unbalanced " inside a quoted-delimiter heredoc body, then a real expansion',
    command: 'cat > x.sh <<\'EOF\'\necho "unbalanced\nEOF\ngit checkout $BRANCH',
    conv12: 'block',
    echo: 'pass',
    divergence:
      'an unquoted expansion is conv12-guard’s subject and not echo-guard’s; both read the heredoc body as data.',
  },
  {
    label: 'false negative 2 — unbalanced " inside a # comment, then a real expansion',
    command: '# a note about an unbalanced " quote\ngit checkout $BRANCH',
    conv12: 'block',
    echo: 'pass',
    divergence: 'same: different subjects, same reading of the comment.',
  },
  {
    label: 'the false negative measured on live traffic — $f unquoted twice inside substitutions',
    command:
      "for f in wf-*.json; do echo \"$f: $(grep -c 'NT-' $f) NT-mentions, $(wc -c < $f) bytes\"; done",
    conv12: 'block',
    echo: 'pass',
    divergence: 'different subjects.',
  },

  // ── The constructs ADR-0052's scanner half newly models ──────────────────
  {
    label: 'a single-quoted jq program — its $name is jq’s variable, never a shell expansion',
    command: "jq -n --slurpfile titles t.json '($titles[0] | map($chosen))'",
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'arithmetic expansion — modelled and skipped, not deferred',
    command: 'echo $((3 + 4))',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'a backtick substitution with a quoted expansion inside — its own frame',
    command: 'echo "`basename "$P"`"',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: '${NAME:-"fallback"} inside double quotes — the brace frame inherits the quoting',
    command: 'echo "${NAME:-"fallback"}"',
    conv12: 'pass',
    echo: 'block',
    divergence:
      'echo-guard’s family 2 blocks EVERY value-substituting expansion by name-agnostic design (Convention 8: on the branch where the variable is set it evaluates to the contents). That is its own subject firing correctly, not a disagreement about quoting.',
  },
  {
    label: '${NAME:-"fallback"} unquoted — still an unquoted expansion',
    command: 'echo ${NAME:-"fallback"}',
    conv12: 'block',
    echo: 'block',
    divergence: 'both fire, for unrelated reasons — one on the quoting, one on the :- operator.',
  },

  // ── The dominant false-refusal shape on live traffic ─────────────────────
  {
    label:
      'the script-file heredoc — 359 of the 381 commands a construct allowlist would have deferred, and the escape hatch the refusal itself prescribes',
    command: 'cat > "$TMPDIR/x.sh" <<\'SCRIPT\'\necho hi\nSCRIPT',
    conv12: 'pass',
    echo: 'pass',
  },
  {
    label: 'a JSON payload heredoc',
    command: 'cat > "/tmp/x.json" <<\'EOF\'\n{"tests":"2948 passed","lint":"clean"}\nEOF',
    conv12: 'pass',
    echo: 'pass',
  },

  // ── Decided blocks that must survive the repair ──────────────────────────
  {
    label: 'the live flip-loop failure shape',
    command: 'for pair in "431 a" "428 b"; do set -- $pair; echo $1; done',
    conv12: 'block',
    echo: 'pass',
    divergence: 'different subjects.',
  },
  {
    label: 'an unquoted expansion inside a QUOTED substitution — the body is its own command line',
    command: 'echo "$(cat $FILE)"',
    conv12: 'block',
    echo: 'pass',
    divergence: 'different subjects.',
  },
  {
    label: 'a plainly quoted value',
    command: 'git -C "$REPO" worktree list --porcelain',
    conv12: 'pass',
    echo: 'pass',
  },

  // ── Where the two biases part company ────────────────────────────────────
  {
    label: 'an unterminated heredoc',
    command: 'cat > x.sh <<\'SCRIPT\'\necho hi\n',
    conv12: 'abstain',
    echo: 'pass',
    divergence:
      'the declared biases, on the same not-knowing: conv12-guard blocks, echo-guard widens what it treats as inert prose and passes.',
  },
  {
    label: 'an unclosed double quote',
    command: 'echo "hello',
    conv12: 'abstain',
    echo: 'pass',
    divergence: 'the declared biases again.',
  },
];

describe('shell-quoting conformance: conv12-guard over the shared corpus', () => {
  for (const shape of CORPUS) {
    it(`answers ${shape.conv12} on ${shape.label}`, () => {
      expect(verdict(CONV12, shape.command)).toBe(shape.conv12);
    });
  }
});

describe('shell-quoting conformance: echo-guard over the SAME corpus', () => {
  for (const shape of CORPUS) {
    it(`answers ${shape.echo} on ${shape.label}`, () => {
      expect(verdict(ECHO, shape.command)).toBe(shape.echo);
    });
  }
});

describe('shell-quoting conformance: every divergence is declared, not discovered', () => {
  for (const shape of CORPUS) {
    if (shape.conv12 === shape.echo) continue;
    it(`explains why the two disagree on ${shape.label}`, () => {
      // A row where the two scanners answer differently and NOBODY wrote down
      // why is the shape this suite exists to make loud. The explanation is not
      // decoration: it is what distinguishes "their subjects differ" from "one
      // of them is wrong."
      expect(shape.divergence, `undeclared divergence on: ${shape.label}`).toBeTruthy();
    });
  }
});

/**
 * The declared Resolution bias, read out of the hook's own header. Parsing it
 * rather than hard-coding it is what makes the behavioural assertions below
 * two-way: the declaration and the behaviour have to move together.
 */
function declaredBias(hookPath: string): 'BLOCKS' | 'PASSES' {
  const m = /\*\*Resolution bias — (BLOCKS|PASSES)\.\*\*/.exec(readFileSync(hookPath, 'utf8'));
  if (!m) throw new Error(`${hookPath} declares no Resolution bias (ADR-0052 requires one)`);
  return m[1] as 'BLOCKS' | 'PASSES';
}

describe('shell-quoting conformance: each hook declares a bias, and behaves as declared', () => {
  /**
   * ONE command that makes BOTH scanners uncertain: an unbalanced `"` opens a
   * quote that never closes. Trailing it is a `printenv`, which echo-guard
   * blocks outright when the quote balances (the control below) — so the probe
   * is not "a command neither cares about", it is a command one of them
   * demonstrably cares about, hidden behind the uncertainty.
   */
  const UNCERTAIN = 'git commit -m "a note with an unbalanced \' quote; printenv';
  const BALANCED_CONTROL = 'git commit -m "a note"; printenv';

  it('conv12-guard declares BLOCKS', () => {
    expect(declaredBias(CONV12)).toBe('BLOCKS');
  });

  it('echo-guard declares PASSES', () => {
    expect(declaredBias(ECHO)).toBe('PASSES');
  });

  it('the control proves the probe is a real probe — with the quote balanced, echo-guard blocks', () => {
    expect(verdict(ECHO, BALANCED_CONTROL)).toBe('block');
    expect(verdict(CONV12, BALANCED_CONTROL)).toBe('pass');
  });

  it('conv12-guard resolves the uncertainty in its DECLARED direction', () => {
    const observed = verdict(CONV12, UNCERTAIN);
    expect(observed).toBe(declaredBias(CONV12) === 'BLOCKS' ? 'abstain' : 'pass');
  });

  it('echo-guard resolves the SAME uncertainty in its DECLARED direction', () => {
    const observed = verdict(ECHO, UNCERTAIN);
    expect(observed).toBe(declaredBias(ECHO) === 'PASSES' ? 'pass' : 'block');
  });

  it('the two biases are genuinely opposite on one input', () => {
    // Stated as its own assertion because it is the claim ADR-0052 makes about
    // this family: two hooks, one directory, one class of not-knowing, opposite
    // resolutions — and both declared.
    expect(declaredBias(CONV12)).not.toBe(declaredBias(ECHO));
    expect(verdict(CONV12, UNCERTAIN)).not.toBe(verdict(ECHO, UNCERTAIN));
  });
});

describe('shell-quoting conformance: both hooks carry the full declaration', () => {
  for (const [name, path] of [
    ['conv12-guard', CONV12],
    ['echo-guard', ECHO],
  ] as const) {
    const source = readFileSync(path, 'utf8');

    it(`${name} declares its Subject`, () => {
      expect(source).toContain('**Subject.**');
    });

    it(`${name} declares an Unmodelled set`, () => {
      expect(source).toContain('**Unmodelled set, named rather than assumed away.**');
    });

    it(`${name} shares no module with its sibling — the ADR-0052 distribution rule`, () => {
      // `wave-setup` copies each hook to a tracked path in the consumer repo,
      // so a third file would turn a missed scaffold copy into a new silent
      // failure mode. Each hook must therefore stand alone: `node:` builtins
      // only, and no relative require of any kind.
      const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
      expect(requires.length).toBeGreaterThan(0);
      for (const target of requires) {
        expect(target.startsWith('node:'), `${name} requires ${target}`).toBe(true);
      }
    });
  }
});
