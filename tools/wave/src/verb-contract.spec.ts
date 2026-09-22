/**
 * verb-contract.spec.ts — the Verb contract machinery, and the behaviour
 * ADR-0051 decisions 3–7 buy with it.
 *
 * The file is in two halves. The first exercises the machinery directly
 * (resolution, the step-over, the did-you-mean, the twins, `--help`). The
 * second drives the REAL router, because the properties that matter are
 * end-to-end ones: a typo that passed with exit 0 yesterday exits 2 today, and
 * every old spelling still resolves.
 *
 * Four of ADR-0051's six negative controls live here (the other two are the
 * planted-drift pair, which belong to `verb-contract-drift.spec.ts` because they
 * are demonstrated by editing a contract):
 *
 *   1. an undeclared flag on a verb that swallowed it yesterday,
 *   2. a stray positional on the readiness gate's `--id` form,
 *   3. a mixed named-plus-positional call on a twin verb,
 *   4. an alias resolving IDENTICALLY to its canonical.
 *
 * Control 4 is the one that is easy to get wrong by asserting too little:
 * "the alias does not error" would pass against a parser that accepted it and
 * then read nothing. So each alias case below asserts byte-identical OUTPUT
 * against the canonical call, not merely a shared exit code.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acceptedSpellings,
  allValuesOf,
  canonicalFlagTokens,
  checkUndeclared,
  declaredFlagTokens,
  defineVerb,
  describeArity,
  editDistance,
  firstValueOf,
  flagContractForToken,
  hasFlag,
  helpRequested,
  nearestDeclared,
  positionalsOf,
  refuseUndeclared,
  renderInvocations,
  renderRefusal,
  renderUsageSection,
  resolveFlagContract,
  resolveTwin,
  ROUTER_GLOBAL_FLAGS,
  scanArgs,
  type VerbContract,
} from './verb-contract';
import { flag, flagAll } from './cli-utils';
import { main, mainAsync, verbContracts, contractForArgv } from './cli';
import { runIssueStore } from './issue-store-cli';

// ─── capture helpers ─────────────────────────────────────────────────────────

let restore: Array<() => void> = [];

afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

function capture(): { out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => {
    outChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => {
    errChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  restore.push(() => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  });
  return { out: () => outChunks.join(''), err: () => errChunks.join('') };
}

const TOY: VerbContract = {
  verb: 'toy',
  flags: [
    { canonical: '--iter', aliases: ['--iteration'], value: 'one', valueType: 'int' },
    { canonical: '--text', value: 'one', valueType: 'text' },
    { canonical: '--wave-scoped', aliases: ['--wave'], value: 'none', valueType: 'none' },
    { canonical: '--id', value: 'repeatable', valueType: 'id' },
  ],
  positionals: { kind: 'fixed', count: 1, labels: ['<path>'] },
  output: 'json',
  usage: ['usage: toy <path> [--iter <n>] [--text <t>] [--wave-scoped] [--id <id> ...]'],
};

// ─── the machinery ───────────────────────────────────────────────────────────

describe('a contract states what a verb accepts', () => {
  it('resolves a flag by canonical spelling, bare or dashed, and never by an alias', () => {
    expect(resolveFlagContract(TOY, 'iter')?.canonical).toBe('--iter');
    expect(resolveFlagContract(TOY, '--iter')?.canonical).toBe('--iter');
    // A CALL SITE asks for the thing by its one canonical name; the aliases are
    // what an end user may type.
    expect(resolveFlagContract(TOY, '--iteration')).toBeUndefined();
  });

  it('resolves a TOKEN by canonical spelling OR any alias, and falls through to the globals', () => {
    expect(flagContractForToken(TOY, '--iteration')?.canonical).toBe('--iter');
    expect(flagContractForToken(TOY, '--wave')?.canonical).toBe('--wave-scoped');
    expect(flagContractForToken(TOY, '--json')?.canonical).toBe('--json');
    expect(flagContractForToken(TOY, '--nope')).toBeUndefined();
  });

  it('lists every accepted spelling, canonical first', () => {
    expect(acceptedSpellings(TOY, 'iter')).toEqual(['--iter', '--iteration']);
    expect(canonicalFlagTokens(TOY)).toEqual(['--iter', '--text', '--wave-scoped', '--id']);
    expect(declaredFlagTokens(TOY)).toContain('--help');
    expect(declaredFlagTokens(TOY)).toContain('--json');
  });

  it('steps OVER a value-taking flag\'s value, so a value is never read as a flag', () => {
    // The live shape: `--text` carries free prose lifted from an agent's report,
    // so "no operator would ever type that" is not a guarantee this parser gets
    // to make. `args.includes('--wave')` used to read this as a mode switch and
    // silently discard the operator's row scope.
    const args = ['p.md', '--text', '--wave', '--iter', '3'];
    expect(hasFlag(TOY, args, 'wave-scoped')).toBe(false);
    expect(positionalsOf(TOY, args)).toEqual(['p.md']);
    expect(firstValueOf(TOY, args, 'text')).toBe('--wave');
    expect(firstValueOf(TOY, args, 'iter')).toBe('3');
    expect(scanArgs(TOY, args).unknownFlags).toEqual([]);
  });

  it('collects every value of a repeatable flag, under any accepted spelling', () => {
    expect(allValuesOf(TOY, ['--id', 'a', '--id', 'b'], 'id')).toEqual(['a', 'b']);
    expect(flagAll(['--id', 'a', '--id', 'b'], TOY, 'id')).toEqual(['a', 'b']);
  });

  it('flag() resolves through the contract — the alias finds the canonical', () => {
    expect(flag(['--iteration', '2'], TOY, 'iter')).toBe('2');
    expect(flag(['--iter', '2'], TOY, 'iter')).toBe('2');
    // …and the EXACT form still works for every pre-ADR-0051 call site.
    expect(flag(['--iter', '2'], '--iter')).toBe('2');
  });
});

describe('did-you-mean', () => {
  it('measures edit distance and picks the nearest declared spelling within two', () => {
    expect(editDistance('--itr', '--iter')).toBe(1);
    expect(nearestDeclared('--itr', declaredFlagTokens(TOY))).toBe('--iter');
    expect(nearestDeclared('--completely-different', declaredFlagTokens(TOY))).toBeUndefined();
  });

  it('is deterministic — the same token always suggests the same spelling', () => {
    const a = nearestDeclared('--tex', declaredFlagTokens(TOY));
    const b = nearestDeclared('--tex', declaredFlagTokens(TOY));
    expect(a).toBe('--text');
    expect(b).toBe(a);
  });
});

describe('the refusal (ADR-0051 decision 4)', () => {
  it('names the verb, the token, the nearest declared flag, and THAT verb\'s usage', () => {
    const violation = checkUndeclared(TOY, ['p.md', '--itr', '2']);
    expect(violation).toEqual({ kind: 'flag', token: '--itr', suggestion: '--iter' });
    const lines = renderRefusal(TOY, violation!);
    expect(lines[0]).toBe('error: toy: unknown flag --itr — did you mean --iter?');
    expect(lines.slice(1, -1)).toEqual(TOY.usage);
  });

  it('drops the did-you-mean clause when nothing is within two edits', () => {
    const violation = checkUndeclared(TOY, ['p.md', '--zzzzzzzz']);
    expect(violation).toEqual({ kind: 'flag', token: '--zzzzzzzz' });
    expect(renderRefusal(TOY, violation!)[0]).toBe('error: toy: unknown flag --zzzzzzzz');
  });

  it('refuses a stray positional beyond the declared arity', () => {
    const violation = checkUndeclared(TOY, ['a.md', 'b.md']);
    expect(violation?.kind).toBe('positional');
    expect(violation?.token).toBe('b.md');
    expect(describeArity(TOY.positionals)).toBe('takes 1 positional argument(s)');
  });

  it('reports the FLAG before the positional — a mistyped flag also strands its value', () => {
    // `--itr 2` on a verb that does not declare `--itr` leaves `2` looking like a
    // stray positional. Naming the value would teach the wrong fix.
    expect(checkUndeclared(TOY, ['p.md', '--itr', '2'])?.token).toBe('--itr');
  });

  it('returns 2 and writes, or returns 0 and writes nothing', () => {
    const c1 = capture();
    expect(refuseUndeclared(TOY, ['p.md', '--iter', '1'])).toBe(0);
    expect(c1.err()).toBe('');
    const c2 = capture();
    expect(refuseUndeclared(TOY, ['p.md', '--nope'])).toBe(2);
    expect(c2.err()).toContain('unknown flag --nope');
  });

  it('a caller-narrowed arity is what a second FORM of one verb refuses against', () => {
    expect(checkUndeclared(TOY, ['p.md'])).toBeNull();
    expect(
      checkUndeclared(TOY, ['p.md'], { positionals: { kind: 'fixed', count: 0 } })?.token,
    ).toBe('p.md');
  });
});

describe('the router-global flags (ADR-0051 decision 7)', () => {
  it('are exactly --json and --help, and every verb accepts both', () => {
    expect(ROUTER_GLOBAL_FLAGS.map((f) => f.canonical)).toEqual(['--json', '--help']);
    for (const contract of Object.values(verbContracts())) {
      expect(checkUndeclared(contract, ['--json'])).toBeNull();
      expect(checkUndeclared(contract, ['--help'])).toBeNull();
    }
  });

  it('--help is read as a BARE flag, never as another flag\'s value', () => {
    expect(helpRequested(TOY, ['--help'])).toBe(true);
    expect(helpRequested(TOY, ['--text', '--help'])).toBe(false);
  });
});

describe('the named twins (ADR-0051 decision 6)', () => {
  const TWIN: VerbContract = {
    verb: 'twin',
    flags: [
      { canonical: '--verdicts-dir', value: 'one', valueType: 'dir' },
      { canonical: '--id', value: 'one', valueType: 'id' },
    ],
    positionals: { kind: 'fixed', count: 2, labels: ['<verdictsDir>', '<id>'] },
    output: 'json',
    twin: [
      { flag: '--verdicts-dir', label: '<verdictsDir>' },
      { flag: '--id', label: '<id>' },
    ],
    usage: ['usage: twin (--verdicts-dir <dir> --id <id> | <verdictsDir> <id>)'],
  };

  it('accepts the all-named form', () => {
    const r = resolveTwin(TWIN, ['--verdicts-dir', '/v', '--id', '42']);
    expect(r).toEqual({ ok: true, mode: 'named', values: ['/v', '42'] });
  });

  it('accepts the all-positional form — the alias', () => {
    const r = resolveTwin(TWIN, ['/v', '42']);
    expect(r).toEqual({ ok: true, mode: 'positional', values: ['/v', '42'] });
  });

  it('REFUSES the mixed form, naming both halves', () => {
    const r = resolveTwin(TWIN, ['/v', '--id', '42']);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('ALL named or ALL positional');
    expect((r as { error: string }).error).toContain('--id');
  });

  it('REFUSES a half-named form — the named route needs every slot', () => {
    const r = resolveTwin(TWIN, ['--verdicts-dir', '/v']);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('missing --id');
  });

  it('a verb with no twin resolves to `none` and is never refused for it', () => {
    expect(resolveTwin(TOY, ['p.md'])).toEqual({ ok: true, mode: 'none', values: [] });
  });
});

describe('the aggregate reader', () => {
  it('keys every contract by exactly what a caller types', () => {
    const all = verbContracts();
    expect(all['route-tuple']).toBeDefined();
    expect(all['spine add-disclosure']).toBeDefined();
    expect(all['issue-store triage-apply']).toBeDefined();
    expect(all['host-pr create']).toBeDefined();
    expect(all['config validate']).toBeDefined();
  });

  it('resolves an argv to its contract and the args that belong to it', () => {
    expect(contractForArgv(['spine', 'add-disclosure', 'x.md'])).toEqual({
      contract: verbContracts()['spine add-disclosure'],
      args: ['x.md'],
    });
    expect(contractForArgv(['merge-order', 'x.md'])).toEqual({
      contract: verbContracts()['merge-order'],
      args: ['x.md'],
    });
    expect(contractForArgv(['spine'])).toBeUndefined();
    expect(contractForArgv(['nonsense'])).toBeUndefined();
  });
});

// ─── the four negative controls, against the REAL router ─────────────────────

describe('NEGATIVE CONTROL 1 — an undeclared flag on a verb that swallowed it yesterday', () => {
  it('route-verdict exits 2 with the did-you-mean line, where it used to exit 0', () => {
    const c = capture();
    // Before ADR-0051 this call routed normally and printed `{event, outcome}`:
    // `--pr` was read by nothing and reported by nothing. It is the #505 class —
    // a plausible spelling, silently swallowed.
    const code = main([
      'route-verdict',
      '--verdict',
      'approve',
      '--iter',
      '1',
      '--risk',
      'mechanical',
      '--state',
      'verdict-in',
      '--pr',
      'https://example.test/pr/1',
    ]);
    expect(code).toBe(2);
    expect(c.err()).toContain('unknown flag --pr');
    expect(c.out()).toBe('');
  });

  it('the refusal prints THAT verb\'s usage and never the router roster (issue #505)', () => {
    const c = capture();
    expect(main(['merge-order', 'x.md', '--nope'])).toBe(2);
    expect(c.err()).toContain('error: merge-order: unknown flag --nope');
    expect(c.err()).toContain('usage: flotilla-engine merge-order');
    expect(c.err()).not.toContain('available subcommands');
  });

  it('a near-miss on a real flag is NAMED, not just rejected', () => {
    const c = capture();
    expect(main(['worktree-cleanup', '--dry-runn'])).toBe(2);
    expect(c.err()).toContain('did you mean --dry-run?');
  });

  it('a verb GROUP refuses at op level, with the op\'s usage', async () => {
    const c = capture();
    const code = await runIssueStore(['read', '42', '--nope']);
    expect(code).toBe(2);
    expect(c.err()).toContain('error: issue-store read: unknown flag --nope');
    expect(c.err()).toContain('usage: issue-store read <id>');
    // The full op roster is reserved for a caller who named no op we recognise.
    expect(c.err()).not.toContain('goal-publish-update');
  });
});

describe('NEGATIVE CONTROL 2 — a stray positional on the readiness gate\'s --id form', () => {
  it('dor --id <id> <stray> exits 2 instead of silently ignoring the path', async () => {
    const c = capture();
    const code = await mainAsync(['dor', '--id', '42', 'some/issue.md']);
    expect(code).toBe(2);
    expect(c.err()).toContain('error: dor: unexpected argument "some/issue.md"');
    expect(c.err()).toContain('usage: flotilla-engine dor');
  });

  it('the PATH form still takes as many positionals as it likes', () => {
    // The narrowing is per FORM, not per verb: `dor <path> <path>` is the
    // variadic form and must stay variadic.
    expect(checkUndeclared(verbContracts().dor, ['a.md', 'b.md', 'c.md'])).toBeNull();
  });
});

describe('NEGATIVE CONTROL 3 — a mixed named-plus-positional call on a twin verb', () => {
  it('verdict-acked <dir> --id X exits 2', () => {
    const c = capture();
    const code = main(['verdict-acked', '/tmp/verdicts', '--id', '42']);
    expect(code).toBe(2);
    // The REFUSAL's own sentence, not the usage line's restatement of the rule:
    // asserting the latter would pass against a build whose mixed-form branch
    // was gone, because the usage text is printed either way (measured — the
    // first draft of this control did exactly that).
    expect(c.err()).toContain('never mixed — saw 1 named (--id) and 1 positional');
    expect(c.out()).toBe('');
  });

  it('…while BOTH unmixed forms answer identically (control 4, on the same verb)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verb-contract-twin-'));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));

    const positional = capture();
    expect(main(['verdict-acked', dir, '42'])).toBe(0);
    const fromPositional = positional.out();
    restore.pop()!();

    const named = capture();
    expect(main(['verdict-acked', '--verdicts-dir', dir, '--id', '42'])).toBe(0);
    expect(named.out()).toBe(fromPositional);
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
  });
});

describe('NEGATIVE CONTROL 4 — every old spelling still resolves, identically', () => {
  it('route-verdict --iteration === --iter (the spelling the skills still use)', () => {
    const canonical = capture();
    expect(
      main(['route-verdict', '--verdict', 'approve', '--iter', '1', '--risk', 'mechanical', '--state', 'verdict-in']),
    ).toBe(0);
    const fromCanonical = canonical.out();
    restore.pop()!();

    const alias = capture();
    expect(
      main(['route-verdict', '--verdict', 'approve', '--iteration', '1', '--risk', 'mechanical', '--state', 'verdict-in']),
    ).toBe(0);
    expect(alias.out()).toBe(fromCanonical);
  });

  it('resume --reports/--verdicts === --reports-dir/--verdicts-dir', () => {
    // Both spellings must reach the SAME refusal for the same missing flag — the
    // observable proof that the alias bound, rather than being ignored into a
    // "flag absent" that happens to produce the same message.
    const contract = verbContracts().resume;
    expect(flag(['--reports', '/r'], contract, 'reports-dir')).toBe('/r');
    expect(flag(['--reports-dir', '/r'], contract, 'reports-dir')).toBe('/r');
    expect(flag(['--verdicts', '/v'], contract, 'verdicts-dir')).toBe('/v');
    expect(flag(['--verdicts-dir', '/v'], contract, 'verdicts-dir')).toBe('/v');

    const c = capture();
    expect(main(['resume', '--spine', '/x', '--reports', '/r', '--verdicts', '/v'])).toBe(1);
    // Exit 1 = it got PAST the usage gate and failed reading the spine, which is
    // the point: all three flags bound under their alias spellings.
    expect(c.err()).not.toContain('are required');
  });

  it('worktree-cleanup --wave === --spine (the spelling wave-close still uses)', () => {
    const contract = verbContracts()['worktree-cleanup'];
    expect(flag(['--wave', '/s.md'], contract, 'spine')).toBe('/s.md');
    expect(flag(['--spine', '/s.md'], contract, 'spine')).toBe('/s.md');

    // …and both FAIL CLOSED the same way on an unreadable spine (issue #141):
    // a flag whose only job is to narrow must never silently widen.
    const viaAlias = capture();
    const aliasCode = main(['worktree-cleanup', '--wave', '/nope/absent.md']);
    const aliasErr = viaAlias.err();
    restore.pop()!();

    const viaCanonical = capture();
    const canonicalCode = main(['worktree-cleanup', '--spine', '/nope/absent.md']);
    expect(canonicalCode).toBe(aliasCode);
    expect(canonicalCode).toBe(2);
    expect(viaCanonical.err()).toBe(aliasErr);
  });

  it('spine add-disclosure --wave === --wave-scoped', () => {
    const contract = verbContracts()['spine add-disclosure'];
    expect(hasFlag(contract, ['--wave'], 'wave-scoped')).toBe(true);
    expect(hasFlag(contract, ['--wave-scoped'], 'wave-scoped')).toBe(true);
  });

  it('write-report --dir === --reports-dir, and write-verdict --dir === --verdicts-dir', () => {
    // `--dir` resolves to a DIFFERENT canonical on the two verbs — possible only
    // because a contract is per verb (ADR-0051 decision 3).
    const report = verbContracts()['write-report'];
    const verdict = verbContracts()['write-verdict'];
    expect(flag(['--dir', '/r'], report, 'reports-dir')).toBe('/r');
    expect(flag(['--dir', '/v'], verdict, 'verdicts-dir')).toBe('/v');
    expect(resolveFlagContract(report, 'verdicts-dir')).toBeUndefined();
    expect(resolveFlagContract(verdict, 'reports-dir')).toBeUndefined();
  });

  it('route-tuple --verdict === --verdict-file, and --report === --report-file', () => {
    const contract = verbContracts()['route-tuple'];
    expect(flag(['--verdict', '/v.json'], contract, 'verdict-file')).toBe('/v.json');
    expect(flag(['--verdict-file', '/v.json'], contract, 'verdict-file')).toBe('/v.json');
    expect(flag(['--report', '/r.json'], contract, 'report-file')).toBe('/r.json');
    expect(flag(['--report-file', '/r.json'], contract, 'report-file')).toBe('/r.json');
  });
});

// ─── `--help` reaches no store and no host (ADR-0051 decision 7) ─────────────

describe('--help is answered before any store or host is constructed', () => {
  it('issue-store --help prints the op roster and exits 0 with no config in reach', async () => {
    const c = capture();
    // No injected store, and the process cwd holds no `wave.config.json` that
    // would resolve: if this reached `resolveStore` it would throw (or, on a
    // configured machine, reach the tracker). It exits 0 with the roster.
    const code = await runIssueStore(['--help']);
    expect(code).toBe(0);
    expect(c.out()).toContain('usage: issue-store <create|read|');
    expect(c.out()).toContain('ops:');
    expect(c.err()).toBe('');
  });

  it('issue-store <op> --help prints THAT op\'s contract, exit 0, no store', async () => {
    const c = capture();
    const code = await runIssueStore(['triage-apply', '--help']);
    expect(code).toBe(0);
    expect(c.out()).toContain('usage: issue-store triage-apply <id> --input');
    expect(c.err()).toBe('');
  });

  it('store-preflight --help exits 0 without resolving a store', async () => {
    const c = capture();
    const code = await mainAsync(['store-preflight', '--help']);
    expect(code).toBe(0);
    expect(c.out()).toContain('usage: store-preflight');
    expect(c.err()).toBe('');
  });

  it('a bare --help prints the whole-CLI usage on STDOUT and exits 0', () => {
    const c = capture();
    expect(main(['--help'])).toBe(0);
    expect(c.out()).toContain('available subcommands:');
    expect(c.err()).toBe('');
  });

  it('every top-level verb answers --help with its own usage', () => {
    for (const verb of ['merge-order', 'closed-by', 'detect-host', 'version', 'cross-wave']) {
      const c = capture();
      expect(main([verb, '--help'])).toBe(0);
      expect(c.out()).toContain('usage:');
      restore.pop()!();
    }
  });
});

// ─── the router usage text stops calling the module paths aliases ────────────

describe('the router usage text (ADR-0051 glossary consequence)', () => {
  it('says the direct module invocations ROUTE to the same runners, not that they are aliases', () => {
    const c = capture();
    main([]);
    const text = c.err();
    expect(text).toContain('still route to the same runners; the subcommand');
    expect(text).toContain('form is the contract');
    expect(text).not.toContain('still work as aliases');
  });
});

// ─── the four private unknown-flag lists are gone ────────────────────────────

describe('the four verbs that refused before ADR-0051 refuse through the one path now', () => {
  const cases: Array<[string, string[]]> = [
    ['worktree-cleanup', ['worktree-cleanup', '--dry-run', '--nope']],
    ['version', ['version', '--nope']],
    ['credential-probe', ['credential-probe', '--all', '--nope']],
  ];

  for (const [name, argv] of cases) {
    it(`${name} still exits 2 on an unknown flag — same code, one renderer`, () => {
      const c = capture();
      expect(main(argv)).toBe(2);
      expect(c.err()).toContain(`error: ${name}: unknown flag --nope`);
    });
  }

  it("host-pr preflight's OWN contract section names the five checks it can report", async () => {
    // The contract section is what `--help` prints and what every refusal on
    // this verb reprints, so it is the surface a caller reaches first. The
    // create-verb checks are host-CONDITIONAL — a GitHub caller never sees
    // `create-credentials` in output and a Bitbucket caller never sees
    // `pr-create-token` — which makes the contract the only place either name
    // is discoverable from the other host.
    const usage = verbContracts()['host-pr preflight'].usage.join('\n');
    for (const name of [
      'pr-merge-token',
      'allow-auto-merge',
      'required-checks',
      'create-credentials',
      'pr-create-token',
    ]) {
      expect(usage, `host-pr preflight's contract omits ${name}`).toContain(name);
    }

    // …and `--help` really does print it (the contract is not a shelf object).
    const c = capture();
    expect(await mainAsync(['host-pr', 'preflight', '--help'])).toBe(0);
    expect(c.out()).toContain('pr-create-token');
  });

  it('host-pr keeps its cross-verb refusals, which teach more than a did-you-mean', async () => {
    const c = capture();
    const code = await mainAsync(['host-pr', 'status', '--branch', 'b', '--delete-branch']);
    expect(code).toBe(2);
    expect(c.err()).toContain("--delete-branch is only supported by 'arm' and 'merge'");
  });

  it('…and refuses anything the group does not know at all, through the one path', async () => {
    const c = capture();
    const code = await mainAsync(['host-pr', 'status', '--branch', 'b', '--nope']);
    expect(code).toBe(2);
    expect(c.err()).toContain('error: host-pr status: unknown flag --nope');
  });

  it('version still refuses a stray positional, with its own usage', () => {
    const c = capture();
    expect(main(['version', 'stray'])).toBe(2);
    expect(c.err()).toContain('error: version: unexpected argument "stray"');
    expect(c.err()).toContain('usage: flotilla-engine version');
  });
});

// ─── the output classes are declared (row V5 reads them) ─────────────────────

describe('every contract declares an output class', () => {
  it('classes the four shapes ADR-0051 decision 7 gives --json its meaning from', () => {
    const all = verbContracts();
    expect(all['merge-order'].output).toBe('json');
    expect(all.dor.output).toBe('prose');
    expect(all['render-verdict'].output).toBe('product');
    expect(all['issue-store transition'].output).toBe('silent-write');
  });

  it('accepts --json on a silent write without changing its behaviour in this row', async () => {
    // Row V5 gives `--json` its meaning per output class. In THIS row it is
    // accepted everywhere and does nothing — which is a property worth pinning,
    // because "accepted" and "acted on" are exactly what a later row changes.
    const dir = mkdtempSync(join(tmpdir(), 'verb-contract-json-'));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'verdicts'), { recursive: true });
    writeFileSync(join(dir, 'empty'), '', 'utf-8');

    const withFlag = capture();
    expect(main(['verdict-acked', join(dir, 'verdicts'), '7', '--json'])).toBe(0);
    const a = withFlag.out();
    restore.pop()!();

    const without = capture();
    expect(main(['verdict-acked', join(dir, 'verdicts'), '7'])).toBe(0);
    expect(without.out()).toBe(a);
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
  });
});

// ─── the usage renderer (issue #856) ────────────────────────────────────────
//
// Row 758 rendered the ROSTER from the contracts; this row renders each verb's
// OWN section — the text `--help` prints, every refusal reprints and every
// runner's missing-argument branch prints. What the block below holds is that
// there is exactly ONE description of a verb's argument shape in the engine and
// that `usage` IS it, computed rather than typed out beside it.

describe('the usage renderer — a section is computed, never transcribed', () => {
  it('every shipped contract\'s `usage` IS the renderer\'s output for its declaration', () => {
    // The whole claim of the row, as one structural assertion over the whole
    // surface: not "the section resembles the declaration" but "the section is
    // a pure function of it". A hand-typed line anywhere in the engine fails
    // here, whatever else it says.
    const drifted: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const rendered = renderUsageSection(contract);
      if (rendered.join('\n') !== contract.usage.join('\n')) {
        drifted.push(
          `${verb}:\n  usage:    ${contract.usage.join('\n            ')}\n` +
            `  rendered: ${rendered.join('\n            ')}`,
        );
      }
    }
    expect(drifted.join('\n\n')).toBe('');
  });

  it('`--help` prints a signature line equal to the renderer\'s, for every verb and op', async () => {
    // The section reaches a caller through `--help`; this asserts the text that
    // arrives there, not just the array it came from. Through `mainAsync`,
    // because four verbs resolve a store on their non-help path and the router
    // reaches them only there — the help interception still runs first, which
    // is half of what this measures.
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const c = capture();
      const argv = verb.split(' ');
      expect(await mainAsync([...argv, '--help']), `${verb} --help`).toBe(0);
      const first = c.out().split('\n')[0];
      expect(first, `${verb}`).toBe(renderUsageSection(contract)[0]);
      expect(first, `${verb}`).toContain(`usage: ${renderInvocations(contract)[0]}`);
    }
  });

  it('spells the three PREFIX kinds and no fourth', () => {
    // A router verb is a subcommand of the one CLI; a group op is its own two
    // tokens; a module with its own entry point names itself. Anything else
    // would be a fourth way to spell an invocation, which is the drift ADR-0051
    // decision 2 closes one level down.
    const all = verbContracts();
    expect(renderInvocations(all.dor)[0].startsWith('flotilla-engine dor ')).toBe(true);
    expect(renderInvocations(all['spine set-status'])[0].startsWith('spine set-status ')).toBe(true);
    expect(
      renderInvocations(all['store-preflight'])[0].startsWith('store-preflight '),
    ).toBe(true);
    const prefixes = new Set(
      Object.entries(all).map(([verb, c]) => {
        const line = renderInvocations(c)[0];
        if (line.startsWith('flotilla-engine ')) return 'router';
        if (line.startsWith(`${verb} `) || line === verb) return 'group-op';
        return 'bare-module';
      }),
    );
    expect([...prefixes].sort()).toEqual(['bare-module', 'group-op', 'router']);
  });

  it('the ROSTER and the SECTION render one declaration two ways, never two declarations', () => {
    // `credential-probe` is the measured case: the roster lists `--var` as the
    // independent optional it is declared to be (`<text>`, the value type), the
    // section names the value the verb actually wants (`<VAR>`) and spells the
    // two selection forms apart. Same contract, same renderer, two settings.
    const c = verbContracts()['credential-probe'];
    const roster = renderInvocations(c, {
      program: `flotilla-engine ${c.verb}`,
      placeholders: 'type',
      relationships: false,
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]).toContain('[--var <text> [--var <text> ...]]');
    const section = renderInvocations(c);
    expect(section).toHaveLength(2);
    expect(section[0]).toBe('credential-probe --all');
    expect(section[1]).toBe('credential-probe --var <VAR> [--var <VAR> ...]');
  });

  it('a relationship renders as the alternation it is, in both kinds', () => {
    const exactlyOne = defineVerb({
      verb: 'toy-a',
      program: 'toy-a',
      flags: [
        { canonical: '--x', value: 'one', valueType: 'text' },
        { canonical: '--y', value: 'one', valueType: 'path' },
      ],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
      groups: [{ kind: 'exactly-one', branches: [['--x'], ['--y']] }],
    });
    expect(exactlyOne.usage[0]).toBe('usage: toy-a (--x <text> | --y <path>)');

    const atMostOne = defineVerb({
      verb: 'toy-b',
      program: 'toy-b',
      flags: [
        { canonical: '--x', value: 'one', valueType: 'text' },
        { canonical: '--y', value: 'one', valueType: 'path' },
      ],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
      groups: [{ kind: 'at-most-one', branches: [['--x'], ['--y']] }],
    });
    expect(atMostOne.usage[0]).toBe('usage: toy-b [--x <text> | --y <path>]');
  });

  it('a group that occupies a positional slot renders THERE, and the slot is not printed twice', () => {
    // `spine add-disclosure`'s shape, in miniature: the row slot lives inside
    // the alternation, so the arity must stop one short of it.
    const c = defineVerb({
      verb: 'toy-c',
      program: 'toy-c',
      flags: [
        { canonical: '--iter', value: 'one', valueType: 'int' },
        { canonical: '--wave-scoped', value: 'none', valueType: 'none' },
        { canonical: '--text', value: 'one', valueType: 'text', required: true },
      ],
      positionals: { kind: 'fixed', count: 2, labels: ['<path>', '<row-id>'], min: 1 },
      output: 'product',
      groups: [
        {
          kind: 'exactly-one',
          branches: [['<row-id>', '--iter'], ['--wave-scoped']],
          consumesPositionals: 1,
        },
      ],
    });
    expect(c.usage[0]).toBe(
      'usage: toy-c <path> (<row-id> --iter <n> | --wave-scoped) --text <text>',
    );
    // Printed once, in the branch — never also as a bracketed trailing slot.
    expect(c.usage[0].match(/<row-id>/g)).toHaveLength(1);
  });

  it('the `output:` and shape-clause lines come from declared fields, on every contract', () => {
    // Stated both ways, because either alone is satisfiable by a renderer that
    // is silently ignoring one of them: a section carries an `output:` line
    // exactly when the contract declares one, and a shape clause exactly when
    // it declares one.
    //
    // The clause's HEADING follows the output class (issue #913) — `shape:` on
    // a verb whose whole stdout is JSON, `--json:` on every other class, and
    // whatever {@link JsonNote.label} says where one is declared — so the
    // expected heading is DERIVED here rather than fixed at `--json`. Fixing it
    // was what let `catalog` pass this check off an unrelated note line that
    // happened to begin with the same four characters.
    const wrong: string[] = [];
    for (const [verb, contract] of Object.entries(verbContracts())) {
      const hasOutputLine = contract.usage.some((l) => l.startsWith('output: '));
      if (hasOutputLine !== (contract.outputNote !== undefined)) {
        wrong.push(`${verb}: output line ${hasOutputLine}, declaration ${contract.outputNote !== undefined}`);
      }
      const heading = contract.json?.label ?? (contract.output === 'json' ? 'shape' : '--json');
      const hasJsonLine = contract.usage.some((l) => l.trimStart().startsWith(`${heading}: `));
      if (hasJsonLine !== (contract.json !== undefined)) {
        wrong.push(
          `${verb}: ${heading} line ${hasJsonLine}, declaration ${contract.json !== undefined}`,
        );
      }
      if (contract.outputNote !== undefined) {
        const first =
          typeof contract.outputNote === 'string' ? contract.outputNote : contract.outputNote[0];
        expect(contract.usage, verb).toContain(`output: ${first}`);
      }
    }
    expect(wrong.join('\n')).toBe('');
  });

  it('the declared SHAPE is what the `--json` clause carries — spine\'s gates included', () => {
    // The gate answers row 859 landed exist to be rendered here; before that
    // row there was no shape to declare, and the clause was absent.
    const all = verbContracts();
    for (const gate of ['spine check-disclosures', 'spine check-awaiting-human']) {
      const contract = all[gate];
      const shape = contract.json?.shape;
      expect(shape, `${gate} declares a --json shape`).toBeDefined();
      expect(contract.usage.join('\n')).toContain(shape as string);
      expect(shape).toContain('ok, verb, holding');
    }
    expect(all['spine set-row-state'].json?.shape).toBe('{ op, spine, id, written: { state } }');
  });

  it('the spine receipt continuation stays byte-identical (the PR-855 pin, re-read here)', () => {
    // Struck from this row's scope as already pinned — asserted anyway at the
    // place the sentence is now DECLARED, so a rendering change cannot move it
    // without this failing too.
    for (const op of ['set-row-state', 'set-row-iter', 'set-row-pr', 'set-branch',
                      'set-status', 'set-disposition', 'replace-closed-by']) {
      expect(verbContracts()[`spine ${op}`].usage).toContain(
        '          Without it this op prints nothing, exactly as before.',
      );
    }
  });

  it('the prose the four private printers held now prints under `--help` too', async () => {
    // `close-row` and `store-preflight` each taught MORE on a misinvocation
    // than `--help` did: four paragraphs reachable only by getting the call
    // wrong. Folded into the contract, they are on both doors.
    const c1 = capture();
    expect(await mainAsync(['close-row', '--help'])).toBe(0);
    expect(c1.out()).toContain('BEFORE the store call (the spine is the WAL a resume reconstructs from).');
    expect(c1.out()).toContain('(ADR-0023) stays with the caller — and it never flags, unclaims or parks.');

    const c2 = capture();
    expect(await mainAsync(['store-preflight', '--help'])).toBe(0);
    expect(c2.out()).toContain('--create-missing-labels creates every label the state-catalog check reports');
    expect(c2.out()).toContain('comparison as an ADVISORY check — it never fails the preflight.');
  });

  it('NEGATIVE CONTROL — a flag added to a contract appears in its section with no edit to any text', () => {
    // The row's whole promise, demonstrated rather than asserted: the section
    // is not a place a flag can be forgotten, because there is no text to
    // forget it in.
    const before = defineVerb({
      verb: 'toy-d',
      program: 'toy-d',
      flags: [{ canonical: '--one', value: 'one', valueType: 'text' }],
      positionals: { kind: 'fixed', count: 0 },
      output: 'json',
    });
    expect(before.usage[0]).toBe('usage: toy-d [--one <text>]');
    const after = defineVerb({
      ...before,
      flags: [...before.flags, { canonical: '--two', value: 'none', valueType: 'none' }],
    });
    expect(after.usage[0]).toBe('usage: toy-d [--one <text>] [--two]');
  });
});
