/**
 * wave-config.spec.ts — TDD spec for the minimal store-selection config slice.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EngineCliBindingError,
  loadWaveConfig,
  normalizeEngineCli,
  type GitHubStoreConfig,
  type LinearStoreConfig,
  type MarkdownStoreConfig,
} from './wave-config';
// The container vocabulary as the FACET owns it — imported so the specs below
// compare the typed config field against the adapter's own closed union and its
// own parser, rather than against a second list restated in this file.
import {
  GOAL_CONTAINERS,
  GoalBindingError,
  parseGoalContainer,
  type GoalContainer,
} from './adapters/issue-store';
// The SAME engine-invocation surface, imported through the PACKAGE ROOT rather
// than the module file — proves the barrel actually re-exports it, so a
// root-only consumer can read the binding and catch its refusal typed
// (issue #273 AC#3). Aliased to avoid colliding with the direct imports above.
import {
  EngineCliBindingError as EngineCliBindingErrorFromRoot,
  normalizeEngineCli as normalizeEngineCliFromRoot,
  type EngineConfig as EngineConfigFromRoot,
  type EngineCliBindingFailure as EngineCliBindingFailureFromRoot,
  type WaveConfig as WaveConfigFromRoot,
} from './index';

function loadConfigFromString(json: string) {
  const p = join(mkdtempSync(join(tmpdir(), 'wc-')), 'wave.config.json');
  writeFileSync(p, json, 'utf8');
  return loadWaveConfig(p);
}

/** Load a github-store config carrying the given raw `engine` value. */
function loadWithEngine(engine: unknown) {
  return loadConfigFromString(JSON.stringify({ store: { kind: 'github' }, engine }));
}

/** Load a config bound to `cli` and hand back the normalized binding. */
function loadEngineCli(cli: unknown): string | undefined {
  return loadWithEngine({ cli }).engine?.cli;
}

describe('loadWaveConfig', () => {
  it('reads a markdown-store config from a tmp file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        store: {
          kind: 'markdown',
          repoRoot: '.',
          slug: '2026-06-06-x',
          eligibility: ['ready-for-agent'],
        },
      }),
    );
    const cfg = loadWaveConfig(cfgPath);
    expect(cfg).toEqual({
      store: {
        kind: 'markdown',
        repoRoot: '.',
        slug: '2026-06-06-x',
        eligibility: ['ready-for-agent'],
      },
    });
  });

  it('throws for an unknown store kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({ store: { kind: 'jira' } }));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/unknown store kind: jira/);
  });

  it('throws a clear error when the store key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({}));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/must have a "store" object/);
  });

  it('throws unknown store kind: undefined when store has no kind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'));
    const cfgPath = join(dir, 'wave.config.json');
    writeFileSync(cfgPath, JSON.stringify({ store: {} }));
    expect(() => loadWaveConfig(cfgPath)).toThrow(/unknown store kind: undefined/);
  });

  it('loads a config with a valid verify profile', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: { kind: 'github' },
      verify: { profiles: [{ name: 'p', appliesTo: ['src/**'], commands: [{ command: 'echo hi' }] }] },
    }));
    expect(cfg.verify?.profiles[0].name).toBe('p');
  });

  it('loads a config with no verify (optional)', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'github' } }));
    expect(cfg.verify).toBeUndefined();
  });

  it('throws when verify is present but has no profiles array', () => {
    expect(() => loadConfigFromString(JSON.stringify({ store: { kind: 'github' }, verify: {} })))
      .toThrow(/verify.*profiles/i);
  });

  it('accepts a linear store config with team + project', () => {
    const p = loadConfigFromString(JSON.stringify({ store: { kind: 'linear', team: 'ex', project: 'Example Project' } }));
    expect(p.store.kind).toBe('linear');
  });

  it('rejects a linear store config without team', () => {
    expect(() => loadConfigFromString(JSON.stringify({ store: { kind: 'linear' } })))
      .toThrow(/team/);
  });

  // ── opt-in done-state mapping (FOR-13) ──────────────────────────────────
  it('accepts a linear store config WITH a states.doneState mapping (AC#1)', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: {
        kind: 'linear',
        team: 'ex',
        states: { queued: 'Todo', inFlight: 'In Progress', inReview: 'In Review', doneState: 'Done' },
      },
    }));
    expect(cfg.store.kind).toBe('linear');
    expect((cfg.store as { states?: { doneState?: string } }).states?.doneState).toBe('Done');
  });

  it('accepts a linear store config WITHOUT a states.doneState mapping — the default/recommended mode (AC#1)', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: { kind: 'linear', team: 'ex', states: { queued: 'Todo' } },
    }));
    expect((cfg.store as { states?: { doneState?: string } }).states?.doneState).toBeUndefined();
  });

  it('accepts a linear store config with no `states` key at all', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'linear', team: 'ex' } }));
    expect((cfg.store as { states?: unknown }).states).toBeUndefined();
  });
});

// ── the engine-invocation binding: `engine.cli` (ADR-0032, issue #273) ───────
//
// One authoritative command string per repo, read host-side at brief-compose
// time. Three paths are specified below and they are NOT symmetric, which is
// the whole design: ABSENT is valid (unbound — the consuming skills own that
// STOP, not the engine), PRESENT-AND-WELL-FORMED is honoured and reported, and
// PRESENT-BUT-MALFORMED is a loud typed refusal rather than a quiet fall back
// to unbound.

describe('loadWaveConfig — engine.cli: the ACCEPT path (AC#1)', () => {
  it('accepts the installed form a consumer binds to, and returns it', () => {
    expect(loadEngineCli('./node_modules/.bin/flotilla-engine'))
      .toBe('./node_modules/.bin/flotilla-engine');
  });

  it('accepts the source form flotilla itself binds to — several argv words', () => {
    const sourceForm = './tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts';
    expect(loadEngineCli(sourceForm)).toBe(sourceForm);
  });

  it('accepts the punctuation real commands need — flags, scoped names, VAR= prefixes', () => {
    const rich = 'NODE_USE_ENV_PROXY=1 ./node_modules/.bin/flotilla-engine host-pr --json=1';
    expect(loadEngineCli(rich)).toBe(rich);
  });

  it('normalizes surrounding whitespace so the reported value is the invoked one', () => {
    expect(loadEngineCli('  ./node_modules/.bin/flotilla-engine\t'))
      .toBe('./node_modules/.bin/flotilla-engine');
  });
});

describe('loadWaveConfig — engine.cli: the ABSENCE path stays valid (AC#1)', () => {
  it('a config with NO engine key at all is valid and unbound — the additive guarantee', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'github' } }));
    expect(cfg.engine).toBeUndefined();
  });

  it('an existing consumer config with verify + cleanup and no engine key still validates', () => {
    const cfg = loadConfigFromString(JSON.stringify({
      store: { kind: 'linear', team: 'ex' },
      verify: { profiles: [{ name: 'p', appliesTo: ['src/**'], commands: [{ command: 'echo hi' }] }] },
      cleanup: { disposableNames: ['.build'] },
    }));
    expect(cfg.engine).toBeUndefined();
    expect(cfg.verify?.profiles).toHaveLength(1);
  });

  it('a present engine object with no cli is valid and unbound', () => {
    expect(loadWithEngine({}).engine).toEqual({});
    expect(loadEngineCli(undefined)).toBeUndefined();
  });
});

describe('loadWaveConfig — engine.cli: the REJECT path is loud and typed (AC#2)', () => {
  it('rejects an EMPTY-STRING binding, naming the field', () => {
    expect(() => loadEngineCli('')).toThrow(EngineCliBindingError);
    expect(() => loadEngineCli('')).toThrow(/engine\.cli/);
  });

  it('rejects a whitespace-only binding — trimming does not rescue it', () => {
    expect(() => loadEngineCli('   ')).toThrow(/engine\.cli.*non-empty/s);
  });

  it('rejects a NON-STRING binding (a number)', () => {
    expect(() => loadEngineCli(42)).toThrow(/engine\.cli.*must be a command string/s);
  });

  it('rejects an ARRAY binding — no fallback chains (ADR-0032 rejected that option)', () => {
    expect(() => loadEngineCli(['./a', './b'])).toThrow(/engine\.cli.*an array/s);
  });

  it('rejects a NULL binding — present-but-not-a-string is never read as unbound', () => {
    expect(() => loadEngineCli(null)).toThrow(/engine\.cli.*null/s);
  });

  it.each([
    ['command separator', './bin/engine; rm -rf /'],
    ['pipe', './bin/engine | tee log'],
    ['background', './bin/engine & sleep 1'],
    ['command substitution', './bin/engine $(whoami)'],
    ['backtick substitution', './bin/engine `whoami`'],
    ['variable expansion', './bin/engine --token $GITHUB_TOKEN'],
    ['redirect', './bin/engine > out.txt'],
    ['subshell', '(./bin/engine)'],
    ['glob', './bin/engine*'],
    ['brace expansion', './bin/{engine,other}'],
    ['quote', "./bin/engine 'a b'"],
    ['backslash', '.\\bin\\engine'],
    ['home-rooted path (machine-specific, un-allowlistable)', '~/bin/flotilla-engine'],
    ['embedded newline', './bin/engine\nrm -rf /'],
    ['invisible non-ASCII codepoint', './bin/engine\u2060'],
    ['leading-slash absolute path (machine-specific, un-allowlistable)', '/usr/local/bin/flotilla-engine'],
  ])('rejects a binding carrying a %s', (_label, cli) => {
    expect(() => loadEngineCli(cli)).toThrow(EngineCliBindingError);
    expect(() => loadEngineCli(cli)).toThrow(/engine\.cli/);
  });

  // issue #288 \u2014 a leading-slash ABSOLUTE path slipped past the character
  // allow-list unconditionally, because `/` stays legitimately allowed
  // mid-string for every repo-relative form. Repo-relative values that
  // merely CONTAIN slashes (the ordinary case) must keep working.
  it('accepts a repo-relative value containing many slashes \u2014 only a LEADING slash is refused', () => {
    const nested = './a/b/c/d/flotilla-engine --flag=./x/y';
    expect(loadEngineCli(nested)).toBe(nested);
  });

  // NEGATIVE CONTROL for the absolute-path rule (wave-shared Convention 11).
  // The two strings below differ by exactly the leading "." that makes one
  // repo-relative and the other absolute \u2014 a guard hardwired to accept fails
  // the second assertion, a guard hardwired to reject fails the first.
  it('NEGATIVE CONTROL: a leading slash is the whole difference between accept and reject', () => {
    const relative = './node_modules/.bin/flotilla-engine';
    const absolute = '/node_modules/.bin/flotilla-engine';
    expect(loadEngineCli(relative)).toBe(relative);
    expect(() => loadEngineCli(absolute)).toThrow(EngineCliBindingError);
  });

  it('rejects a non-object engine key, naming that field', () => {
    expect(() => loadWithEngine('./node_modules/.bin/flotilla-engine'))
      .toThrow(/"engine" must be an object/);
    expect(() => loadWithEngine([])).toThrow(/"engine" must be an object/);
    expect(() => loadWithEngine(null)).toThrow(/"engine" must be an object/);
  });

  // NEGATIVE CONTROL for the reject rule (wave-shared Convention 11, spec half).
  // A guard is only worth anything if it can come out either way, so these two
  // assertions run command strings differing in EXACTLY ONE character. A guard
  // hardwired to throw fails the first; a guard hardwired to pass fails the
  // second; only a guard that actually reads the character survives both.
  it('NEGATIVE CONTROL: one character is the whole difference between accept and reject', () => {
    const clean = './node_modules/.bin/flotilla-engine host-pr create';
    const poisoned = './node_modules/.bin/flotilla-engine host-pr; create';
    expect(loadEngineCli(clean)).toBe(clean);
    expect(() => loadEngineCli(poisoned)).toThrow(EngineCliBindingError);
  });
});

describe('normalizeEngineCli — the typed refusal a caller can branch on (AC#2)', () => {
  function failureOf(cli: unknown): EngineCliBindingError {
    try {
      normalizeEngineCli(cli);
    } catch (err) {
      return err as EngineCliBindingError;
    }
    throw new Error(`expected ${JSON.stringify(cli)} to be refused`);
  }

  it('carries a stable name/code/field on every refusal', () => {
    for (const bad of ['', 7, './bin/engine; boom']) {
      const err = failureOf(bad);
      expect(err).toBeInstanceOf(EngineCliBindingError);
      expect(err.name).toBe('EngineCliBindingError');
      expect(err.code).toBe('engine-cli-binding-invalid');
      expect(err.field).toBe('engine.cli');
    }
  });

  it('discriminates the four present-but-invalid shapes', () => {
    expect(failureOf(7).failure).toBe('not-a-string');
    expect(failureOf('  ').failure).toBe('empty');
    expect(failureOf('./bin/engine; boom').failure).toBe('not-plain-argv');
    expect(failureOf('/usr/local/bin/flotilla-engine').failure).toBe('absolute-path');
  });

  it('names the offending character and its index, and echoes the configured value', () => {
    const err = failureOf('./bin/engine; boom');
    expect(err.configured).toBe('./bin/engine; boom');
    expect(err.message).toMatch(/";"/);
    expect(err.message).toMatch(/index 12/);
  });

  it('names the leading "/" and index 0 for an absolute-path binding, and echoes the configured value', () => {
    const err = failureOf('/usr/local/bin/flotilla-engine');
    expect(err.failure).toBe('absolute-path');
    expect(err.configured).toBe('/usr/local/bin/flotilla-engine');
    expect(err.message).toMatch(/"\/"/);
    expect(err.message).toMatch(/index 0/);
  });

  it('reports no configured value when the binding was not a string at all', () => {
    expect(failureOf(7).configured).toBeUndefined();
  });

  it('keeps the quoted command and the index in agreement under leading whitespace', () => {
    // The index is counted against the TRIMMED command, so the message must
    // quote the trimmed command too — otherwise it points at the wrong
    // character. `configured` still carries the authored bytes.
    const err = failureOf('   ./bin/engine; boom');
    expect(err.configured).toBe('   ./bin/engine; boom');
    expect(err.message).toContain('"./bin/engine; boom"');
    expect(err.message).toMatch(/index 12/);
  });

  it('honours a caller-supplied label so a different call-site can name its own field', () => {
    expect(() => normalizeEngineCli('', 'wave-setup scaffold "engine.cli"'))
      .toThrow(/wave-setup scaffold "engine\.cli"/);
  });

  it('returns undefined for an absent binding rather than throwing', () => {
    expect(normalizeEngineCli(undefined)).toBeUndefined();
  });
});

// ── the detached sweep's declarable containment roots: `cleanup.extraRoots` ──
//
// The config half of issue #451. `DetachedSweepOptions.extraRoots` documented
// itself as the way to declare a containment root outside the worktrees root,
// but `CleanupConfig` had no matching key — so the CONFIGURED path (what
// wave-close phase 3 runs) could not declare one, and an out-of-root detached
// scratch checkout stayed registered forever. These specs pin the three
// properties the schema owes: the key is ACCEPTED, its ABSENCE keeps every
// existing config valid unchanged (the additive/semver guarantee), and a
// MALFORMED declaration is refused loudly in the same error style the sibling
// `cleanup.disposableNames` key already uses.

/** Load a config carrying the given raw `cleanup` value. */
function loadWithCleanup(cleanup: unknown) {
  return loadConfigFromString(JSON.stringify({ store: { kind: 'github' }, cleanup }));
}

describe('loadWaveConfig — cleanup.extraRoots: the ACCEPT path', () => {
  it('accepts repo-root-relative roots and returns them verbatim', () => {
    const cfg = loadWithCleanup({ extraRoots: ['scratchpad', '.probes/detached'] });
    expect(cfg.cleanup?.extraRoots).toEqual(['scratchpad', '.probes/detached']);
  });

  it('accepts an ABSOLUTE root — a containment root is a LOCATION, unlike a disposable name', () => {
    // The discriminator between the two cleanup keys: `disposableNames` refuses
    // a `/` outright (a bare entry name, matched at any depth), `extraRoots`
    // requires it to be meaningful (an absolute path is explicitly supported).
    const cfg = loadWithCleanup({ extraRoots: ['/var/tmp/agent-scratch'] });
    expect(cfg.cleanup?.extraRoots).toEqual(['/var/tmp/agent-scratch']);
  });

  it('accepts both cleanup keys side by side — neither validator rejects the other key', () => {
    const cfg = loadWithCleanup({
      disposableNames: ['.build'],
      extraRoots: ['scratchpad'],
    });
    expect(cfg.cleanup?.disposableNames).toEqual(['.build']);
    expect(cfg.cleanup?.extraRoots).toEqual(['scratchpad']);
  });

  it('accepts an EMPTY array — a declaration of nothing is a no-op, not an error', () => {
    expect(loadWithCleanup({ extraRoots: [] }).cleanup?.extraRoots).toEqual([]);
  });
});

describe('loadWaveConfig — cleanup.extraRoots: the ABSENCE path stays valid (the additive guarantee)', () => {
  it('a cleanup object with only disposableNames still validates, and reads undefined', () => {
    const cfg = loadWithCleanup({ disposableNames: ['.build'] });
    expect(cfg.cleanup?.disposableNames).toEqual(['.build']);
    expect(cfg.cleanup?.extraRoots).toBeUndefined();
  });

  it('a config with NO cleanup key at all is valid and declares nothing', () => {
    const cfg = loadConfigFromString(JSON.stringify({ store: { kind: 'github' } }));
    expect(cfg.cleanup).toBeUndefined();
  });

  it('an explicit null is read as "nothing declared" rather than refused', () => {
    // Matches how `normalizeDisposableNames` treats null on the sibling key —
    // deliberately NOT the `engine.cli` stance, whose whole point is that a
    // written-down null must not degrade quietly to unbound.
    expect(() => loadWithCleanup({ extraRoots: null })).not.toThrow();
  });
});

describe('loadWaveConfig — cleanup.extraRoots: the REJECT path is loud', () => {
  it('rejects a non-array declaration, naming the field', () => {
    expect(() => loadWithCleanup({ extraRoots: 'scratchpad' }))
      .toThrow(/cleanup\.extraRoots.*must be an array of paths/);
  });

  it('rejects an object declaration too — not merely a bare string', () => {
    expect(() => loadWithCleanup({ extraRoots: { root: 'scratchpad' } }))
      .toThrow(/must be an array of paths/);
  });

  it('rejects a non-string ENTRY, naming the offending index', () => {
    expect(() => loadWithCleanup({ extraRoots: ['scratchpad', 7] }))
      .toThrow(/cleanup\.extraRoots"\[1\] must be a string/);
  });

  it('rejects an empty / whitespace-only entry — it would resolve to the repo root itself', () => {
    expect(() => loadWithCleanup({ extraRoots: ['   '] }))
      .toThrow(/cleanup\.extraRoots"\[0\] must be a non-empty path/);
  });

  it('rejects a `~`-rooted entry — nothing expands it, so it can only mean the wrong directory', () => {
    expect(() => loadWithCleanup({ extraRoots: ['~/scratch'] }))
      .toThrow(/home-rooted/);
  });

  it('a malformed extraRoots is refused even when disposableNames beside it is perfectly valid', () => {
    // Both keys are validated; a valid sibling must not shield a bad one.
    expect(() =>
      loadWithCleanup({ disposableNames: ['.build'], extraRoots: [7] }),
    ).toThrow(/cleanup\.extraRoots"\[0\]/);
  });
});

// ── the Goal container binding: `store.goal.container` (ADR-0044 decision 4) ──
//
// The key shipped with the Goal facet as a structural read off the parsed JSON
// and worked end-to-end — but `wave.config.json`'s schema is a SEMVER CONTRACT,
// and it said nothing about a key the engine acts on. These specs pin the three
// properties the typed field owes, and one it deliberately does NOT:
//
//   ACCEPT   — every role in the facet's own vocabulary survives the load, on
//              every store variant, readable off the typed field.
//   ABSENCE  — a config with no `goal` key loads BYTE-IDENTICALLY to before the
//              field existed. That is the whole additive/Minor claim.
//   VOCAB    — the type is the ADAPTER-OWNED union, not a lookalike restated in
//              wave-config.ts that could drift away from `GOAL_CONTAINERS`.
//   NOT-VALIDATION — `loadWaveConfig` still does not grade the role. The
//              refusal ladder (unbound / unknown-container / unrealized-
//              container) stays store-side, and a spec asserting that is what
//              stops a later "while we're typing it, let's validate it too"
//              from quietly creating a second, disagreeing ladder.

/** Load a config carrying the given raw `store` object. */
function loadWithStore(store: unknown) {
  return loadConfigFromString(JSON.stringify({ store }));
}

/** The `store.goal.container` a loaded config carries, read off the TYPED field. */
function loadedRole(store: unknown): GoalContainer | undefined {
  return loadWithStore(store).store.goal?.container;
}

describe('loadWaveConfig — store.goal.container: the ACCEPT path', () => {
  it.each(GOAL_CONTAINERS)('accepts the "%s" role and reads it back off the typed field', (role) => {
    expect(loadedRole({ kind: 'github', goal: { container: role } })).toBe(role);
  });

  it('carries the field on the MARKDOWN variant', () => {
    const store = { kind: 'markdown', repoRoot: '.', slug: '2026-06-06-x', goal: { container: 'goal-file' } };
    expect(loadedRole(store)).toBe('goal-file');
  });

  it('carries the field on the GITHUB variant', () => {
    expect(loadedRole({ kind: 'github', goal: { container: 'milestone' } })).toBe('milestone');
  });

  it('carries the field on the LINEAR variant — the one store with no default', () => {
    expect(loadedRole({ kind: 'linear', team: 'ex', goal: { container: 'project' } })).toBe('project');
  });

  it('leaves the binding beside every other store key untouched', () => {
    // A realistic linear config: the goal key must not disturb, or be disturbed
    // by, the keys that were already there.
    const cfg = loadWithStore({
      kind: 'linear',
      team: 'ex',
      project: 'Example Project',
      eligibility: ['ready-for-agent'],
      states: { queued: 'Todo' },
      goal: { container: 'project' },
    });
    const store = cfg.store as LinearStoreConfig;
    expect(store.goal?.container).toBe('project');
    expect(store.team).toBe('ex');
    expect(store.eligibility).toEqual(['ready-for-agent']);
    expect(store.states?.queued).toBe('Todo');
  });

  it('is typed as the FACET vocabulary on all three variants — the compile-time half', () => {
    // These annotations only typecheck if `goal.container` really is
    // GoalContainer-typed on each variant; `tsc --noEmit` is the assertion, and
    // all four declared roles appear so none of them is accidentally excluded.
    const markdownBound: MarkdownStoreConfig = {
      kind: 'markdown',
      repoRoot: '.',
      slug: '2026-06-06-x',
      goal: { container: 'goal-file' },
    };
    const githubBound: GitHubStoreConfig = { kind: 'github', goal: { container: 'milestone' } };
    const linearBound: LinearStoreConfig = { kind: 'linear', team: 'ex', goal: { container: 'project' } };
    const linearDeferred: LinearStoreConfig = {
      kind: 'linear',
      team: 'ex',
      goal: { container: 'initiative' },
    };

    // The NARROWING assertion, and the one that catches a widening: a field
    // typed `string` would still accept every literal above, so only assigning
    // it OUT to the closed union proves the union is what it is.
    const narrowed: GoalContainer | undefined = githubBound.goal?.container;

    expect(markdownBound.goal?.container).toBe('goal-file');
    expect(narrowed).toBe('milestone');
    expect(linearBound.goal?.container).toBe('project');
    expect(linearDeferred.goal?.container).toBe('initiative');
  });
});

describe('loadWaveConfig — store.goal.container: the ABSENCE path (the additive/Minor guarantee)', () => {
  it('a config with NO goal key loads BYTE-IDENTICALLY to the authored object', () => {
    // The whole additive claim in one assertion: an existing consumer config —
    // every key it had before this field existed — round-trips unchanged, and
    // the load invents no `goal` key of its own.
    const authored = {
      store: {
        kind: 'markdown',
        repoRoot: '.',
        slug: '2026-06-06-x',
        eligibility: ['ready-for-agent'],
      },
      verify: { profiles: [{ name: 'p', appliesTo: ['src/**'], commands: [{ command: 'echo hi' }] }] },
      cleanup: { disposableNames: ['.build'] },
    };
    expect(loadConfigFromString(JSON.stringify(authored))).toEqual(authored);
  });

  it('reads undefined off the typed field when nothing is declared, on every variant', () => {
    expect(loadedRole({ kind: 'github' })).toBeUndefined();
    expect(loadedRole({ kind: 'linear', team: 'ex' })).toBeUndefined();
    expect(loadedRole({ kind: 'markdown', repoRoot: '.', slug: '2026-06-06-x' })).toBeUndefined();
  });

  it('a present goal object with no container is valid and declares nothing', () => {
    expect(loadWithStore({ kind: 'github', goal: {} }).store.goal).toEqual({});
    expect(loadedRole({ kind: 'github', goal: {} })).toBeUndefined();
  });
});

describe('store.goal.container: the typed vocabulary IS the facet\'s own', () => {
  it('every role the config field accepts is a role the FACET parser accepts', () => {
    // The drift guard the imported union buys. A second, hand-copied list in
    // wave-config.ts could add or lose a role without `GOAL_CONTAINERS`
    // noticing; this walks the facet's vocabulary through the config field and
    // back out through the facet's own parser.
    for (const role of GOAL_CONTAINERS) {
      expect(parseGoalContainer(loadedRole({ kind: 'github', goal: { container: role } }))).toBe(role);
    }
  });

  // NEGATIVE CONTROL (wave-shared Convention 11). The two configs below differ
  // by exactly one string, and the assertions pull in opposite directions: a
  // vocabulary hardwired to accept fails the second, one hardwired to reject
  // fails the first. Only a check that actually reads the value survives both.
  it('NEGATIVE CONTROL: one role name is the whole difference between accepted and refused', () => {
    expect(parseGoalContainer(loadedRole({ kind: 'github', goal: { container: 'milestone' } })))
      .toBe('milestone');
    expect(() => parseGoalContainer(loadedRole({ kind: 'github', goal: { container: 'epic' } })))
      .toThrow(GoalBindingError);
  });
});

describe('store.goal.container: typing did NOT move the refusal ladder', () => {
  // The settled direction, pinned so it cannot be undone by a well-meant later
  // row: only a STORE knows which roles it realizes and whether an ABSENT
  // binding is fatal (GitHub and MarkdownFs default, Linear refuses), so the
  // ladder has exactly one owner and the loader is not it.
  it('loads a config carrying an UNKNOWN role verbatim, rather than refusing it here', () => {
    // Widened to `unknown` the same way `readGoalContainer` widens it: the
    // interface says what a config OUGHT to carry, this file says what one DID.
    const goal: unknown = loadWithStore({ kind: 'github', goal: { container: 'epic' } }).store.goal;
    expect((goal as { container?: unknown }).container).toBe('epic');
  });

  it('loads a LINEAR config with no binding at all — `unbound` is the store\'s refusal, not the loader\'s', () => {
    expect(() => loadWithStore({ kind: 'linear', team: 'ex' })).not.toThrow();
  });

  it('the refusal a bad role DOES get is the facet\'s typed one, naming the dotted key', () => {
    const err = (() => {
      try {
        parseGoalContainer('epic');
      } catch (e) {
        return e as GoalBindingError;
      }
      throw new Error('expected "epic" to be refused');
    })();
    expect(err).toBeInstanceOf(GoalBindingError);
    expect(err.failure).toBe('unknown-container');
    expect(err.field).toBe('store.goal.container');
  });
});

describe('engine.cli is reachable from the PACKAGE ROOT (AC#3)', () => {
  it('re-exports the config type carrying the field, plus its validator and typed error', () => {
    // Compile-time half — these annotations only typecheck if the barrel really
    // re-exports the types; `tsc --noEmit` is the assertion.
    const binding: EngineConfigFromRoot = { cli: './node_modules/.bin/flotilla-engine' };
    const config: WaveConfigFromRoot = { store: { kind: 'github' }, engine: binding };
    const failure: EngineCliBindingFailureFromRoot = 'not-plain-argv';
    expect(config.engine?.cli).toBe('./node_modules/.bin/flotilla-engine');
    expect(failure).toBe('not-plain-argv');

    // Runtime half — the root-imported values are the SAME bindings, not
    // lookalikes, so a consumer's `instanceof` check against the root-imported
    // error class matches what `loadWaveConfig` actually throws.
    expect(normalizeEngineCliFromRoot).toBe(normalizeEngineCli);
    expect(EngineCliBindingErrorFromRoot).toBe(EngineCliBindingError);
    expect(() => loadEngineCli('./bin/engine; boom')).toThrow(EngineCliBindingErrorFromRoot);
  });
});
