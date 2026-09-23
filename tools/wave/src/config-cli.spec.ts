import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runConfig } from './config-cli';

let stdoutBuf = '';
let stderrBuf = '';
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    stdoutBuf += String(s);
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    stderrBuf += String(s);
    return true;
  });
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function writeConfig(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const path = join(dir, 'wave.config.json');
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return path;
}

describe('config validate', () => {
  it('exits 0 and prints ok for a valid markdown config', () => {
    const path = writeConfig({ store: { kind: 'markdown', repoRoot: '/x', slug: 's' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
    expect(stdoutBuf).toMatch(/markdown/);
  });

  it('exits 0 for a github config WITHOUT building a store (no P8 deferral)', () => {
    const path = writeConfig({ store: { kind: 'github', eligibility: ['ready-for-agent'] } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0); // would be impossible if it called buildStore
    expect(stdoutBuf).toMatch(/github/);
  });

  it('exits 0 and reports the verify profile count when present', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'cms', appliesTo: ['cms/**'], commands: [{ command: 'composer install' }] }] },
    });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/1 profile/);
  });

  // ── issue #755 — the two non-rung Linear state keys at the validate seam ──
  //
  // `config validate` is the surface `wave-setup` uses to prove a freshly-written
  // config loads, so it is where a consumer finds out whether the `states` block
  // it just authored is accepted. Both keys were honoured at runtime before they
  // were typed; these pin that the documented shape and the validated shape are
  // now the same shape.

  it('exits 0 for a linear config carrying states.unclaimTarget and states.unplanned', () => {
    const path = writeConfig({
      store: {
        kind: 'linear',
        team: 'EX',
        states: { unclaimTarget: 'Icebox', unplanned: 'Discarded' },
      },
    });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
    expect(stdoutBuf).toMatch(/linear/);
  });

  it('exits 0 for the live DSW21 shape — unclaimTarget alone, beside a project and eligibility', () => {
    const path = writeConfig({
      store: {
        kind: 'linear',
        team: 'DSW',
        project: 'Example Project',
        eligibility: ['ready-for-agent'],
        states: { unclaimTarget: 'Todo' },
      },
    });
    expect(runConfig(['validate', path])).toBe(0);
  });

  it('NEGATIVE CONTROL: a linear config with NO states block validates identically — the keys are optional', () => {
    // Without this the two exits above are equally consistent with `states`
    // having become required, which would break every config written before it.
    const path = writeConfig({ store: { kind: 'linear', team: 'EX' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
  });

  it('exits 1 with a clear message for an unknown store kind', () => {
    const path = writeConfig({ store: { kind: 'svn' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/unknown store kind/);
  });

  it('exits 1 for a malformed verify (no profiles array)', () => {
    const path = writeConfig({ store: { kind: 'github' }, verify: { profiles: 'oops' } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/verify/);
  });

  it('exits 2 (usage) for a missing path', () => {
    expect(runConfig(['validate'])).toBe(2);
  });

  // issue #759: a <path> that does not RESOLVE (as opposed to being absent
  // from argv, the case above) used to reach the operator as
  // `loadWaveConfig`'s bare `readFileSync` ENOENT, unprefixed. Now it is
  // rewritten to name what was being read, matching `merge-order`'s own
  // "could not read wave file" wording (cli.ts) — same failure, same name.
  // Exit code is UNCHANGED: an invalid/unreadable config already exited 1
  // here, and stays 1 — unifying exit codes is out of scope (ADR-0035).
  it('a nonexistent <path> gets a prefixed "could not read config file" message, still exit 1', () => {
    const code = runConfig(['validate', '/definitely/does-not-exist/wave.config.json']);
    expect(code).toBe(1);
    expect(stderrBuf).toMatch(/^error: could not read config file: .*ENOENT/);
  });

  it('exits 2 (usage) for an unknown op', () => {
    expect(runConfig(['frobnicate', 'x'])).toBe(2);
  });
});

// ── the engine-invocation binding at the CLI seam (ADR-0032, issue #273) ─────
//
// `config validate` is the surface `wave-setup` uses to prove a freshly-written
// config loads, so it is also where an operator finds out WHICH engine form
// this repo is bound to — and where a malformed binding has to stop being
// invisible.

describe('config validate — engine.cli (ADR-0032)', () => {
  const INSTALLED_FORM = './node_modules/.bin/flotilla-engine';

  it('exits 0 and reports the BOUND VALUE, not merely that a binding exists (AC#1)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM } });
    const code = runConfig(['validate', path]);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/ok/i);
    expect(stdoutBuf).toContain(`engine.cli: ${INSTALLED_FORM}`);
  });

  it('reports the source form flotilla itself binds to, verbatim', () => {
    const sourceForm = './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts';
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: sourceForm } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain(`engine.cli: ${sourceForm}`);
  });

  it('exits 0 and says nothing about engine.cli when the binding is absent (AC#1)', () => {
    const path = writeConfig({ store: { kind: 'github' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).not.toMatch(/engine/);
  });

  it('exits 1 naming the field for an EMPTY-STRING binding (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: '' } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli/);
    expect(stdoutBuf).toBe(''); // never both "ok" and an error
  });

  it('exits 1 naming the field for a NON-STRING binding (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: 42 } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli.*command string/s);
  });

  it('exits 1 naming the field for a binding carrying shell metacharacters (AC#2)', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { cli: `${INSTALLED_FORM} && rm -rf /` } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.cli/);
  });

  it('exits 1 for a non-object engine key', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: INSTALLED_FORM });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/"engine" must be an object/);
  });

  // NEGATIVE CONTROL for the CLI-level gate (wave-shared Convention 11, spec
  // half): the same config differing ONLY in the binding's value must come out
  // 0 one way and 1 the other. A `config validate` that always exited 0 — the
  // silent-skip failure ADR-0032 exists to end — fails the second assertion; one
  // that always exited 1 fails the first.
  it('NEGATIVE CONTROL: the exit code turns on the binding value alone', () => {
    const good = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM } });
    const bad = writeConfig({ store: { kind: 'github' }, engine: { cli: `${INSTALLED_FORM};` } });
    expect(runConfig(['validate', good])).toBe(0);
    expect(runConfig(['validate', bad])).toBe(1);
  });
});

// ── the install binding at the same seam (issue #717, ADR-0032 amendment) ────
//
// `engine.install` is reported BESIDE `engine.cli` for the identical reason the
// invocation binding is reported at all: an operator running this line after
// `wave-setup` is asking "is this repo bound to the forms I think it is?", and
// where the invocation resolves through a gitignored path — the ordinary case —
// the command that makes the binary exist is half of that answer. Reported, not
// judged: whether an absent install step is acceptable is `compose-driver`'s
// call, made against the repo's own gitignore rather than here.

describe('config validate — engine.install (issue #717)', () => {
  const INSTALLED_FORM = './node_modules/.bin/flotilla-engine';

  it('exits 0 and echoes the install binding beside the cli binding, verbatim', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: { cli: INSTALLED_FORM, install: 'npm ci --prefix tools/wave' },
    });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain(`engine.cli: ${INSTALLED_FORM}`);
    expect(stdoutBuf).toContain('engine.install: npm ci --prefix tools/wave');
  });

  it('reports an install binding even where no cli binding is set', () => {
    const path = writeConfig({ store: { kind: 'github' }, engine: { install: 'npm ci' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain('engine.install: npm ci');
    expect(stdoutBuf).not.toMatch(/engine\.cli/);
  });

  it('exits 1 for a shell-line install command, naming the field and the rule', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: { cli: INSTALLED_FORM, install: 'cd tools/wave && npm ci' },
    });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/engine\.install/);
    expect(stderrBuf).toMatch(/plain space-separated argv word list/);
    expect(stdoutBuf).toBe(''); // never both "ok" and an error
  });

  it('exits 1 for an absolute or home-rooted install command', () => {
    for (const install of ['/usr/local/bin/install.sh', '~/bin/install.sh']) {
      stdoutBuf = '';
      stderrBuf = '';
      const path = writeConfig({ store: { kind: 'github' }, engine: { install } });
      expect(runConfig(['validate', path])).toBe(1);
      expect(stderrBuf).toMatch(/engine\.install/);
    }
  });

  // NEGATIVE CONTROL, two halves at once, exactly as the `needs` block below
  // does it. (a) The exit code turns on the install VALUE alone. (b) A config
  // WITHOUT the key prints today's line byte-for-byte — the additive guarantee,
  // asserted on the whole string rather than on the absence of a substring.
  it('NEGATIVE CONTROL: the exit code turns on the install value alone, and a config without the key prints today\'s line', () => {
    const good = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM, install: 'npm ci' } });
    const bad = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM, install: 'npm ci;' } });
    expect(runConfig(['validate', good])).toBe(0);
    expect(runConfig(['validate', bad])).toBe(1);

    stdoutBuf = '';
    const bare = writeConfig({ store: { kind: 'github' }, engine: { cli: INSTALLED_FORM } });
    expect(runConfig(['validate', bare])).toBe(0);
    expect(stdoutBuf).toBe(
      `ok: "${bare}" is a valid wave config (store.kind=github, engine.cli: ${INSTALLED_FORM})\n`,
    );
    expect(stdoutBuf).not.toMatch(/engine\.install/);
  });
});

// ── the declared capability requirement at the CLI seam (ADR-0049) ───────────
//
// `config validate` is where an operator finds out whether the `needs` they
// declared at setup actually landed — and where a declaration the skill tier has
// no translation for has to stop being invisible. The refusal itself is
// `loadWaveConfig`'s; what this block pins is that it reaches the CLI as an
// exit-1 with the closed set named, and that the reporting half is conditional.

describe('config validate — verify command needs (ADR-0049)', () => {
  /** A github config whose one verify profile carries `commands` verbatim. */
  function writeWithCommands(commands: unknown[]): string {
    return writeConfig({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'app', appliesTo: ['App/**'], commands }] },
    });
  }

  it('exits 0 and reports the declared needs WITH their denominator', () => {
    const path = writeWithCommands([
      { command: 'npm ci' },
      { command: 'xcodebuild test -scheme App', needs: { host: true } },
    ]);
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain('1 of 2 verify command(s) declare a sandbox need');
  });

  it('exits 1 naming the field AND the closed set for an unknown needs key', () => {
    const path = writeWithCommands([{ command: 'xcodebuild test', needs: { gpu: true } }]);
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/verify\.profiles\[0\]\.commands\[0\]\.needs/);
    expect(stderrBuf).toMatch(/unknown key "gpu"/);
    expect(stderrBuf).toMatch(/"writes".*"network".*"host"/s);
    expect(stdoutBuf).toBe(''); // never both "ok" and an error
  });

  it('exits 1 for a wrong value shape, naming the closed set', () => {
    const path = writeWithCommands([{ command: 'xcodebuild test', needs: { host: false } }]);
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/host must be literally true/);
    expect(stderrBuf).toMatch(/"writes".*"network".*"host"/s);
  });

  // NEGATIVE CONTROL, two halves at once. (a) The exit code turns on the needs
  // VALUE alone — same config, same profile count, 0 one way and 1 the other, so
  // this gate cannot be one that always passes or always fails. (b) The report
  // is silent when nothing is declared: today's line, unchanged, for a config
  // written before the field existed.
  it('NEGATIVE CONTROL: the exit code turns on the needs value alone, and a needs-free config prints today\'s line', () => {
    const good = writeWithCommands([{ command: 'xcodebuild test', needs: { host: true } }]);
    const bad = writeWithCommands([{ command: 'xcodebuild test', needs: { host: 'yes' } }]);
    expect(runConfig(['validate', good])).toBe(0);
    expect(runConfig(['validate', bad])).toBe(1);

    stdoutBuf = '';
    const bare = writeWithCommands([{ command: 'npm ci' }, { command: 'npm test' }]);
    expect(runConfig(['validate', bare])).toBe(0);
    expect(stdoutBuf).toBe(
      `ok: "${bare}" is a valid wave config (store.kind=github, verify: 1 profile(s))\n`,
    );
    expect(stdoutBuf).not.toMatch(/needs|sandbox/);
  });
});

// ── the non-fatal findings the loader used to read past (issue #761) ─────────
//
// Fifteen scratch configs measured at 2.4.0 all printed `ok`: a typo at top
// level, a typo nested in any known block, a non-object `goal`, a non-array
// `eligibility`, a numeric `categoryLabels`, profiles that were not objects, and
// an absolute path in an install-prefix argument. The only refusals anywhere
// were inside `needs`. Every block below pins one of those as a WARNING —
// named, on stderr, exit code untouched.
//
// THE REFUSAL IS THE TRAP, and it is why each block carries its own exit
// assertion rather than only a message match: `wave.config.json` is a semver
// contract (ADR-0035), so a check here that refused would be a major at blast
// radius zero. `expect(code).toBe(0)` beside every warning is what says these
// additions stayed additive.

/** Every warning line stderr carried, with the `warning: ` prefix stripped. */
function warningLines(): string[] {
  return stderrBuf
    .split('\n')
    .filter((l) => l.startsWith('warning: '))
    .map((l) => l.slice('warning: '.length));
}

describe('config validate — unknown keys are named, never refused (issue #761)', () => {
  it('a typo at TOP LEVEL is named with its block, and still exits 0', () => {
    const path = writeConfig({ store: { kind: 'github' }, verifyy: { profiles: [] } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toMatch(/^ok:/);
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('the wave config root');
    expect(warningLines()[0]).toContain('"verifyy"');
    // The closed set is spelled out, the way every refusal in wave-config.ts
    // spells its own — an author who mistyped is one line from the fix.
    expect(warningLines()[0]).toContain('store, verify, cleanup, engine, models');
  });

  it.each([
    ['store', { kind: 'github', eligibilty: ['x'] }, 'eligibilty'],
    ['store.goal', { kind: 'github', goal: { containerr: 'milestone' } }, 'containerr'],
  ])('a typo NESTED in %s is named with its block', (block, store, typo) => {
    const path = writeConfig({ store });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain(`wave config "${block}"`);
    expect(warningLines()[0]).toContain(`"${typo}"`);
  });

  it('names a typo in cleanup, engine, verify and each verify profile/command', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      cleanup: { disposableNamez: ['target'] },
      engine: { instal: 'npm ci' },
      verify: {
        profiles: [
          { name: 'a', appliesTo: ['**'], commandz: [], commands: [{ command: 'x', cwdd: 'y' }] },
        ],
      },
    });
    expect(runConfig(['validate', path])).toBe(0);
    const all = warningLines().join('\n');
    expect(all).toContain('wave config "cleanup" carries the unknown key "disposableNamez"');
    expect(all).toContain('wave config "engine" carries the unknown key "instal"');
    expect(all).toContain('wave config "verify.profiles[0]" carries the unknown key "commandz"');
    expect(all).toContain(
      'wave config "verify.profiles[0].commands[0]" carries the unknown key "cwdd"',
    );
  });

  it("the known set is the STORE KIND's own — \"team\" is a linear key and a github typo", () => {
    // Without the per-kind split, the union of all three variants' keys would
    // accept `team` on a github store and `repoRoot` on a linear one, which is
    // exactly the class of mistake this warning exists for.
    const linear = writeConfig({ store: { kind: 'linear', team: 'EX' } });
    expect(runConfig(['validate', linear])).toBe(0);
    expect(warningLines()).toEqual([]);

    stderrBuf = '';
    const github = writeConfig({ store: { kind: 'github', team: 'EX' } });
    expect(runConfig(['validate', github])).toBe(0);
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('"team"');
  });

  it('NEGATIVE CONTROL: a fully-declared config warns about nothing, and the typo\'d one still exits 0', () => {
    // Half one: the warning is not something this walk says about everything — a
    // config whose every block is populated with declared keys is silent.
    const clean = writeConfig({
      store: {
        kind: 'linear',
        team: 'EX',
        project: 'P',
        eligibility: ['ready-for-agent'],
        states: {
          queued: 'Todo',
          inFlight: 'In Progress',
          inReview: 'In Review',
          unclaimTarget: 'Backlog',
          unplanned: 'Canceled',
          doneState: 'Done',
        },
        categoryLabels: { bug: 'Bug' },
        goal: { container: 'project' },
      },
      verify: {
        profiles: [
          { name: 'a', appliesTo: ['**'], commands: [{ cwd: 'x', command: 'y', needs: { host: true } }] },
        ],
      },
      cleanup: { disposableNames: ['target'], extraRoots: ['/scratch'] },
      engine: { cli: './node_modules/.bin/flotilla-engine', install: 'npm ci' },
    });
    expect(runConfig(['validate', clean])).toBe(0);
    expect(warningLines()).toEqual([]);

    // Half two: the typo'd config exits 0 TOO. A warning that moved the exit
    // code would be the refusal this row is forbidden to add.
    stderrBuf = '';
    const typod = writeConfig({ store: { kind: 'github' }, unknownTop: true });
    expect(runConfig(['validate', typod])).toBe(0);
    expect(warningLines()).toHaveLength(1);
  });
});

describe('config validate — a value whose SHAPE is not what its key is read as (issue #761)', () => {
  it('a non-object `goal` is REPORTED, not accepted as ok in silence', () => {
    // `goal: "milestone"` reads like a shorthand and is not one: the container
    // binding is read off `store.goal.container`, so a string carries none.
    const path = writeConfig({ store: { kind: 'github', goal: 'milestone' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('"store.goal" must be an object');
    expect(warningLines()[0]).toContain('a string ("milestone")');
    expect(warningLines()[0]).toContain('store.goal.container');
  });

  it('a container role that is no role at all is named — through the vocabulary\'s own parser', () => {
    // The store-INDEPENDENT half of the binding question. Whether a store
    // REALIZES a role, and whether an absent binding is fatal, stay store-side
    // (ADR-0044 decision 4) and are the store-preflight's `goalBinding` reading.
    const path = writeConfig({ store: { kind: 'github', goal: { container: 'not-a-real-container' } } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('"not-a-real-container"');
    expect(warningLines()[0]).toContain('milestone | project | initiative | goal-file');
  });

  it('NEGATIVE CONTROL: a real role is silent — on the same key, the same config', () => {
    const path = writeConfig({ store: { kind: 'github', goal: { container: 'milestone' } } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
  });

  it('reports a non-array eligibility, a non-object states and a non-object categoryLabels', () => {
    const path = writeConfig({
      store: { kind: 'linear', team: 'EX', eligibility: 'not-an-array', states: 5, categoryLabels: 5 },
    });
    expect(runConfig(['validate', path])).toBe(0);
    const all = warningLines().join('\n');
    expect(all).toContain('"store.eligibility" must be an array');
    expect(all).toContain('"store.states" must be an object');
    expect(all).toContain('"store.categoryLabels" must be an object');
  });

  it('reports a non-string eligibility entry without refusing the config', () => {
    const path = writeConfig({ store: { kind: 'github', eligibility: ['ready-for-agent', 7] } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines().join('\n')).toContain('"store.eligibility[1]" must be a string');
  });

  it('profiles that are not objects are reported AND still counted — the count never silently shrinks', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      verify: { profiles: ['not-an-object', { commands: 'nope' }] },
    });
    expect(runConfig(['validate', path])).toBe(0);
    const all = warningLines().join('\n');
    expect(all).toContain('"verify.profiles[0]" must be an object');
    expect(all).toContain('"verify.profiles[1].commands" must be an array');
    // The measured 2.4.0 line said `verify: 2 profile(s)` for exactly this
    // config and still does — the count is the loader's reading, unchanged.
    expect(stdoutBuf).toContain('verify: 2 profile(s)');
  });

  it('NEGATIVE CONTROL: the well-shaped spelling of each of those blocks is silent', () => {
    const path = writeConfig({
      store: {
        kind: 'linear',
        team: 'EX',
        eligibility: ['ready-for-agent'],
        states: { queued: 'Todo' },
        categoryLabels: { bug: 'Bug' },
        goal: { container: 'project' },
      },
      verify: { profiles: [{ name: 'a', appliesTo: ['**'], commands: [{ command: 'x' }] }] },
    });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
  });
});

describe("config validate — an absolute path in an engine binding's ARGUMENT position (issue #761, folded #746)", () => {
  it('names the spelling — and does NOT refuse it', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: { install: 'npm ci --prefix /abs/tools/wave' },
    });
    expect(runConfig(['validate', path])).toBe(0); // a warning, never a refusal
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('wave config "engine.install"');
    expect(warningLines()[0]).toContain('"/abs/tools/wave"');
    expect(warningLines()[0]).toContain('ARGUMENT');
    // …and the binding still reaches the summary line verbatim: reported, never
    // rewritten.
    expect(stdoutBuf).toContain('engine.install: npm ci --prefix /abs/tools/wave');
  });

  it('applies to engine.cli by the same rule', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: { cli: './node_modules/.bin/flotilla-engine --config /abs/wave.config.json' },
    });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()[0]).toContain('wave config "engine.cli"');
    expect(warningLines()[0]).toContain('"/abs/wave.config.json"');
  });

  it('CONTRAST: the same absolute path at index 0 is still REFUSED, exit 1 — the rule that exists is untouched', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: { install: '/abs/tools/wave/install.sh' },
    });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toMatch(/must be repo-relative/);
    expect(stdoutBuf).toBe('');
  });

  it('NEGATIVE CONTROL: the repo-relative prefix — the one the refusal itself offers — is silent', () => {
    const path = writeConfig({
      store: { kind: 'github' },
      engine: {
        cli: './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts',
        install: 'npm ci --prefix tools/wave',
      },
    });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
  });
});

// ── models — the tier→model-id block (ADR-0012 Amendment 2026-09-21) ────────
//
// The loader refuses the block's unusable SHAPES (a non-object, a non-string
// value, an empty id — pinned in wave-config.spec.ts). What is left for this
// verb is the finding the loader deliberately reads past: a MISSPELLED key,
// which binds nothing in silence and would otherwise surface as a wave running
// on whatever model happened to be coordinating it.

describe('config validate — the models block (ADR-0012 Amendment 2026-09-21)', () => {
  const MODELS = {
    heavy: 'consumer-heavy-id',
    standard: 'consumer-standard-id',
    scribe: 'consumer-scribe-id',
  };

  it('a fully-declared models block validates with ZERO warnings, and reports what it bound', () => {
    const path = writeConfig({ store: { kind: 'github' }, models: MODELS });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
    expect(stdoutBuf).toContain(
      'models: heavy="consumer-heavy-id", standard="consumer-standard-id", scribe="consumer-scribe-id"',
    );
  });

  it('an unknown key under models is ONE warning naming the block\'s declared keys, exit 0', () => {
    const path = writeConfig({ store: { kind: 'github' }, models: { ...MODELS, scribes: 'x' } });
    expect(runConfig(['validate', path])).toBe(0); // never a refusal
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('wave config "models"');
    expect(warningLines()[0]).toContain('"scribes"');
    expect(warningLines()[0]).toContain('heavy, standard, scribe');
    // The count rides on the ok line too, so a piped stdout never reads clean.
    expect(stdoutBuf).toContain('1 warning(s)');
  });

  it('NEGATIVE CONTROL — the same config with the key spelled right draws no warning at all', () => {
    // The pair that makes the warning above mean something: without it, "one
    // warning" is compatible with a walk that fires on every models block.
    const path = writeConfig({ store: { kind: 'github' }, models: { scribe: 'x' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
  });

  it('a malformed models block is REFUSED by the loader, exit 1, with the key named', () => {
    // The other half of the tier: the shapes that are not a typo but an
    // unusable binding do not come back as advice.
    const path = writeConfig({ store: { kind: 'github' }, models: { heavy: '' } });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toContain('wave config "models.heavy"');
    expect(stdoutBuf).toBe('');
  });

  it('--json carries the models warning inside the answer, not as a stderr line', () => {
    const path = writeConfig({ store: { kind: 'github' }, models: { heavyy: 'x' } });
    expect(runConfig(['validate', path, '--json'])).toBe(0);
    expect(stderrBuf).toBe('');
    const answer = JSON.parse(stdoutBuf) as {
      ok: boolean;
      warnings: { block: string; path: string; kind: string }[];
    };
    expect(answer.ok).toBe(true);
    expect(answer.warnings).toHaveLength(1);
    expect(answer.warnings[0].block).toBe('models');
    expect(answer.warnings[0].path).toBe('models.heavyy');
    expect(answer.warnings[0].kind).toBe('unknown-key');
  });
});

describe('config validate — landing.commitMessage (ADR-0053)', () => {
  // `config validate` is the surface `wave-setup` proves a freshly-written config
  // with, so it is where an author learns whether the landing choice took. The
  // three cases of the acceptance criterion, at this seam: the two values
  // accepted, an absent key accepted as `pr`, and any other value rejected with
  // the key and both values named.

  it('exits 0 for "pr" and for "host", and reports the declared value on the ok line', () => {
    for (const value of ['pr', 'host']) {
      stdoutBuf = '';
      stderrBuf = '';
      const path = writeConfig({ store: { kind: 'github' }, landing: { commitMessage: value } });
      expect(runConfig(['validate', path]), value).toBe(0);
      expect(warningLines(), value).toEqual([]);
      expect(stdoutBuf, value).toContain(`landing.commitMessage: ${value}`);
    }
  });

  it('exits 0 for an ABSENT key — and says nothing, so an existing config prints today\'s line', () => {
    // Absent means `pr`. The line stays byte-identical to the one printed before
    // the key existed: every summary segment is conditional (issue #761).
    const bare = writeConfig({ store: { kind: 'markdown', repoRoot: '/x', slug: 's' } });
    expect(runConfig(['validate', bare])).toBe(0);
    expect(stdoutBuf).toBe(`ok: "${bare}" is a valid wave config (store.kind=markdown)\n`);
    expect(stderrBuf).toBe('');
  });

  it('exits 0 for a present landing block with no commitMessage, and reports nothing about it', () => {
    const path = writeConfig({ store: { kind: 'github' }, landing: {} });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
    expect(stdoutBuf).not.toContain('landing');
  });

  it('exits 1 for any other value, naming the key and BOTH allowed values', () => {
    for (const bad of ['squash', 'PR', '', null, 1]) {
      stdoutBuf = '';
      stderrBuf = '';
      const path = writeConfig({ store: { kind: 'github' }, landing: { commitMessage: bad } });
      expect(runConfig(['validate', path]), JSON.stringify(bad)).toBe(1);
      expect(stderrBuf, JSON.stringify(bad)).toContain('wave config "landing.commitMessage"');
      expect(stderrBuf, JSON.stringify(bad)).toContain('"pr" or "host"');
      expect(stdoutBuf, JSON.stringify(bad)).toBe('');
    }
  });

  it('exits 1 for a landing block that is not an object', () => {
    const path = writeConfig({ store: { kind: 'github' }, landing: 'host' });
    expect(runConfig(['validate', path])).toBe(1);
    expect(stderrBuf).toContain('wave config "landing" must be an object');
  });

  it('--json answers ok:false with the same message for a rejected value, still exit 1', () => {
    const path = writeConfig({ store: { kind: 'github' }, landing: { commitMessage: 'squash' } });
    expect(runConfig(['validate', path, '--json'])).toBe(1);
    const answer = JSON.parse(stdoutBuf) as { ok: boolean; message: string };
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('wave config "landing.commitMessage" must be "pr" or "host"');
  });

  it('an unknown key under landing is ONE warning naming the declared key, exit 0', () => {
    const path = writeConfig({ store: { kind: 'github' }, landing: { commitMesage: 'host' } });
    expect(runConfig(['validate', path])).toBe(0); // a typo is never a refusal
    expect(warningLines()).toHaveLength(1);
    expect(warningLines()[0]).toContain('wave config "landing"');
    expect(warningLines()[0]).toContain('"commitMesage"');
    expect(warningLines()[0]).toContain('declares are: commitMessage');
  });

  it('NEGATIVE CONTROL — the same config with the key spelled right draws no warning', () => {
    const path = writeConfig({ store: { kind: 'github' }, landing: { commitMessage: 'host' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(warningLines()).toEqual([]);
  });

  it('NEGATIVE CONTROL — the top-level "landing" key itself is a declared key, not a typo', () => {
    // Before this key existed, `landing` at the root drew an unknown-key warning.
    const path = writeConfig({ store: { kind: 'github' }, landing: { commitMessage: 'pr' } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stderrBuf).not.toContain('unknown key');
  });
});

describe('config validate — the summary line reports what the loader actually read (issue #761)', () => {
  it('names the claim states, the eligibility markers, the category labels, the cleanup block and the goal binding', () => {
    const path = writeConfig({
      store: {
        kind: 'linear',
        team: 'EX',
        eligibility: ['ready-for-agent', 'wave-ready'],
        states: { queued: 'Todo', unclaimTarget: 'Icebox' },
        categoryLabels: { bug: 'Bug' },
        goal: { container: 'initiative' },
      },
      cleanup: { disposableNames: ['target'], extraRoots: ['/scratch'] },
    });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain('store.eligibility: "ready-for-agent", "wave-ready"');
    expect(stdoutBuf).toContain('store.states: queued="Todo", unclaimTarget="Icebox"');
    expect(stdoutBuf).toContain('store.categoryLabels: bug="Bug"');
    expect(stdoutBuf).toContain('store.goal.container: initiative');
    expect(stdoutBuf).toContain('cleanup.disposableNames: "target"');
    expect(stdoutBuf).toContain('cleanup.extraRoots: "/scratch"');
  });

  it('counts the warnings on the line itself, so a piped stdout never reads clean while stderr says otherwise', () => {
    const path = writeConfig({ store: { kind: 'github', eligibilty: ['x'] }, unknownTop: 1 });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toContain('2 warning(s)');
  });

  it("NEGATIVE CONTROL: a config declaring none of them prints TODAY'S line, byte for byte", () => {
    // The additive guarantee, asserted on the whole string rather than on the
    // absence of a substring — every new segment is conditional, so a config
    // that says nothing more says nothing more.
    const bare = writeConfig({ store: { kind: 'markdown', repoRoot: '/x', slug: 's' } });
    expect(runConfig(['validate', bare])).toBe(0);
    expect(stdoutBuf).toBe(`ok: "${bare}" is a valid wave config (store.kind=markdown)\n`);
    expect(stderrBuf).toBe('');
  });
});

// ─── row V5 — `config validate --json` (ADR-0051 decision 7) ────────────────
//
// The verb is output class `prose` and its result is DATA: ok-or-error, the
// message, and — since issue #761 — the warnings the loader reads past. A
// Coordinator or a pulse that needed the verdict used to parse the one prose
// line and the `warning:` lines off two different streams; this is that result,
// keyed.
//
// Contract from landing (ADR-0035): the shape below is pinned here, the default
// output is pinned byte-identically beside it, and the exit code is asserted on
// every case — `--json` chose a rendering, never a verdict.

/** The parsed `config validate --json` answer. */
interface ConfigJsonAnswer {
  verb: string;
  config: string;
  ok: boolean;
  message: string;
  warnings: { block: string; path: string; kind: string; message: string }[];
}

describe('config validate --json (row V5)', () => {
  it('prints { verb, config, ok, message, warnings } on stdout and NOTHING on stderr', () => {
    const path = writeConfig({ store: { kind: 'markdown', repoRoot: '/x', slug: 's' } });
    expect(runConfig(['validate', path, '--json'])).toBe(0);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(answer).toEqual({
      verb: 'config validate',
      config: path,
      ok: true,
      message: `"${path}" is a valid wave config (store.kind=markdown)`,
      warnings: [],
    });
    expect(stderrBuf).toBe('');
  });

  it("`message` is the prose line's own sentence — one summary, two renderings", () => {
    const path = writeConfig({
      store: { kind: 'linear', team: 'EX', goal: { container: 'initiative' } },
      verify: { profiles: [{ name: 'x', appliesTo: ['**'], commands: [{ command: 'true' }] }] },
    });
    expect(runConfig(['validate', path])).toBe(0);
    const prose = stdoutBuf;
    stdoutBuf = '';
    stderrBuf = '';
    expect(runConfig(['validate', path, '--json'])).toBe(0);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(prose).toBe(`ok: ${answer.message}\n`);
  });

  it("carries the issue-#761 warnings INSIDE the answer, with the loader's four keys", () => {
    const path = writeConfig({ store: { kind: 'github', eligibilty: ['x'] }, unknownTop: 1 });
    expect(runConfig(['validate', path, '--json'])).toBe(0);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(answer.ok).toBe(true);
    expect(answer.warnings).toHaveLength(2);
    for (const w of answer.warnings) {
      expect(Object.keys(w).sort()).toEqual(['block', 'kind', 'message', 'path']);
      expect(typeof w.message).toBe('string');
    }
    expect(answer.warnings.map((w) => w.kind)).toEqual(['unknown-key', 'unknown-key']);
    expect(answer.warnings.map((w) => w.path)).toEqual(['unknownTop', 'store.eligibilty']);
  });

  it('renders the SAME findings the prose form puts on stderr — same count, same messages', () => {
    const path = writeConfig({
      store: { kind: 'github', eligibilty: ['x'] },
      engine: { cli: './node_modules/.bin/flotilla-engine --config /abs/wave.config.json' },
    });
    expect(runConfig(['validate', path])).toBe(0);
    const prose = warningLines();
    expect(prose.length).toBeGreaterThan(1);
    stdoutBuf = '';
    stderrBuf = '';
    expect(runConfig(['validate', path, '--json'])).toBe(0);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(answer.warnings.map((w) => w.message)).toEqual(prose);
    // …and stderr is now silent, because the findings rode INSIDE the answer.
    expect(stderrBuf).toBe('');
  });

  it('an INVALID config answers ok:false with the loader\'s own message, still exit 1', () => {
    const path = writeConfig({ store: { kind: 'nonsense' } });
    // The prose form first, to capture the message the loader actually threw.
    expect(runConfig(['validate', path])).toBe(1);
    const proseError = stderrBuf.trim().slice('error: '.length);
    stdoutBuf = '';
    stderrBuf = '';

    expect(runConfig(['validate', path, '--json'])).toBe(1);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(answer.ok).toBe(false);
    expect(answer.message).toBe(proseError);
    // A refused load never reached the collector, so nothing was found.
    expect(answer.warnings).toEqual([]);
    expect(stderrBuf).toBe('');
  });

  // issue #759: same prefixed-ENOENT fix as the prose-form pin above, read
  // through --json — the rendering differs, the message must not.
  it('a nonexistent <path> under --json carries the SAME prefixed message, still exit 1', () => {
    const missing = '/definitely/does-not-exist/wave.config.json';
    expect(runConfig(['validate', missing])).toBe(1);
    const proseError = stderrBuf.trim().slice('error: '.length);
    stdoutBuf = '';
    stderrBuf = '';

    expect(runConfig(['validate', missing, '--json'])).toBe(1);
    const answer = JSON.parse(stdoutBuf) as ConfigJsonAnswer;
    expect(answer.ok).toBe(false);
    expect(answer.message).toBe(proseError);
    expect(answer.message).toMatch(/^could not read config file: .*ENOENT/);
    expect(answer.warnings).toEqual([]);
  });

  it('NEGATIVE CONTROL: without --json both streams are byte-identical to today', () => {
    const path = writeConfig({ store: { kind: 'github', eligibilty: ['x'] } });
    expect(runConfig(['validate', path])).toBe(0);
    expect(stdoutBuf).toBe(
      `ok: "${path}" is a valid wave config (store.kind=github, 1 warning(s))\n`,
    );
    expect(stderrBuf.startsWith('warning: ')).toBe(true);
    expect(stdoutBuf).not.toContain('"ok"');
  });

  it('`--json` AHEAD of the op is read as the op and exits 2 — the group grammar, pinned', () => {
    // The positional-grammar decision this row took deliberately. `config` is
    // one of four verb GROUPS, and on all four the op token comes first; making
    // this ONE group accept the flag ahead of its op would buy a private
    // grammar nobody could generalise from. The usage says so in words; this
    // says so in behaviour.
    const path = writeConfig({ store: { kind: 'github' } });
    expect(runConfig(['--json', 'validate', path])).toBe(2);
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toMatch(/usage/);
    // …and the very same call with the flag AFTER the op is accepted.
    stdoutBuf = '';
    stderrBuf = '';
    expect(runConfig(['validate', path, '--json'])).toBe(0);
  });

  it('the usage names the JSON form beside the prose note, and states where the flag goes', () => {
    expect(runConfig(['validate', '--help'])).toBe(0);
    expect(stdoutBuf).toContain('output: text (a one-line ok/error message), not JSON');
    expect(stdoutBuf).toContain(
      '--json: the same verdict as JSON, warnings included — { verb, config, ok, message, warnings: [ { block, path, kind, message } ] }',
    );
    expect(stdoutBuf).toContain('--json FOLLOWS the op');
  });
});
