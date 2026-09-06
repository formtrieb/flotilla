import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  verifyCommands,
  type VerifyCommand,
  type VerifyCommandNeeds,
  type VerifyConfig,
} from './verify';

// Local test fixture — an example PHP/CMS verify profile. NOT engine-exported:
// a consumer's build profile lives in its own wave.config.json (ADR-0016).
const CMS_VERIFY: VerifyConfig = {
  profiles: [
    {
      name: 'cms-php',
      appliesTo: ['cms/**'],
      commands: [
        { cwd: 'cms', command: 'composer install --no-interaction --no-progress' },
        { cwd: 'cms', command: 'vendor/bin/phpunit' },
      ],
    },
  ],
};

describe('verifyCommands', () => {
  it('CMS: a cms/ change → composer install + phpunit (cwd cms)', () => {
    const cmds = verifyCommands(['cms/site/plugins/auth/index.php'], CMS_VERIFY);
    expect(cmds).toEqual([
      { cwd: 'cms', command: 'composer install --no-interaction --no-progress' },
      { cwd: 'cms', command: 'vendor/bin/phpunit' },
    ]);
  });

  it('CMS: a non-cms/ change → none (empty)', () => {
    expect(verifyCommands(['cli/cli.mjs', 'docs/x.md'], CMS_VERIFY)).toEqual([]);
  });

  it('CMS: a mixed change-set still fires the cms profile once (deduped)', () => {
    const cmds = verifyCommands(['cli/x.mjs', 'cms/a.php', 'cms/b.php'], CMS_VERIFY);
    expect(cmds).toHaveLength(2); // not duplicated per matching file
  });

  it('unions de-duplicated commands across multiple matching profiles in order', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ command: 'build' }, { command: 'test' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ command: 'test' }, { command: 'lint' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg).map((c) => c.command)).toEqual([
      'build',
      'test',
      'lint', // 'test' not repeated
    ]);
  });

  it('empty change-set → none', () => {
    expect(verifyCommands([], CMS_VERIFY)).toEqual([]);
  });
});

// ── the declared capability requirement rides the selection (ADR-0049) ───────
//
// `needs` is data the Worker and the Reviewer both have to SEE — the Reviewer
// independently re-runs the same commands and meets the identical wall — so the
// one thing selection may never do is quietly drop it.

describe('verifyCommands — a command\'s declared needs survive selection (ADR-0049)', () => {
  const XCODE_VERIFY: VerifyConfig = {
    profiles: [
      {
        name: 'app',
        appliesTo: ['App/**'],
        commands: [
          { command: 'xcodebuild build -scheme App', needs: { writes: ['~/Library/Developer/Xcode/DerivedData'] } },
          { command: 'xcodebuild test -scheme App', needs: { host: true } },
          { command: 'swift package resolve', needs: { network: ['github.com'] } },
        ],
      },
    ],
  };

  it('passes each selected command through verbatim, needs included', () => {
    expect(verifyCommands(['App/Main.swift'], XCODE_VERIFY)).toEqual([
      { command: 'xcodebuild build -scheme App', needs: { writes: ['~/Library/Developer/Xcode/DerivedData'] } },
      { command: 'xcodebuild test -scheme App', needs: { host: true } },
      { command: 'swift package resolve', needs: { network: ['github.com'] } },
    ]);
  });

  // NEGATIVE CONTROL for the pass-through above: a profile whose commands carry
  // NO `needs` selects to objects with no `needs` key at all — not to
  // `needs: undefined`, and not to a synthesized empty declaration. This is the
  // shape the byte-identical-composition guarantee downstream rests on.
  it('NEGATIVE CONTROL: a command with no needs selects with no needs key', () => {
    const selected = verifyCommands(['cms/x.php'], CMS_VERIFY);
    expect(selected).toEqual([
      { cwd: 'cms', command: 'composer install --no-interaction --no-progress' },
      { cwd: 'cms', command: 'vendor/bin/phpunit' },
    ]);
    for (const cmd of selected) expect('needs' in cmd).toBe(false);
  });

  // The de-duplication key is `cwd + command` and deliberately does NOT include
  // `needs` — see verifyCommands' own doc comment for why the first declaration
  // wins rather than the two being merged.
  it('de-duplicates on cwd + command alone: the FIRST profile\'s needs wins', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ command: 'test' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ command: 'test', needs: { host: true } }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([{ command: 'test' }]);
    // …and the mirror image, so the assertion above is about ORDER rather than
    // about `needs` being dropped unconditionally.
    const reversed: VerifyConfig = { profiles: [cfg.profiles[1], cfg.profiles[0]] };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], reversed)).toEqual([
      { command: 'test', needs: { host: true } },
    ]);
  });
});

// ── `needs` is a NAMED type, not only an indexed one (issue #724) ────────────
//
// A compile-time assertion, so it costs nothing at runtime and fails the
// `tsc --noEmit` gate rather than only the suite: the promotion is ADDITIVE
// exactly as long as the old indexed spelling and the new name denote the SAME
// declaration. Mutual assignability in both directions is that claim; a
// structurally-similar-but-separate re-declaration would still satisfy it, and
// that is fine — it is the CONSUMER-visible property (an existing
// `NonNullable<VerifyCommand['needs']>` annotation keeps meaning what it meant)
// that is being pinned, not the identity of the AST node.
type IndexedNeeds = NonNullable<VerifyCommand['needs']>;
const _needsNameMatchesIndexedForm: VerifyCommandNeeds = {} as IndexedNeeds;
const _indexedFormMatchesNeedsName: IndexedNeeds = {} as VerifyCommandNeeds;
void _needsNameMatchesIndexedForm;
void _indexedFormMatchesNeedsName;

describe('VerifyCommandNeeds — the named shape is usable from a type position (issue #724)', () => {
  it('annotates a declaration by NAME and still selects through verbatim', () => {
    // The whole point of the promotion: this line used to require
    // `NonNullable<VerifyCommand['needs']>`.
    const needs: VerifyCommandNeeds = { network: ['github.com'], writes: ['/var/cache'] };
    const cfg: VerifyConfig = {
      profiles: [{ name: 'a', appliesTo: ['libs/**'], commands: [{ command: 'build', needs }] }],
    };
    expect(verifyCommands(['libs/x.ts'], cfg)).toEqual([{ command: 'build', needs }]);
  });
});

// ── the de-duplication key's separator is PRINTABLE (issue #724) ─────────────
//
// The key used to join `cwd` and `command` with a literal NUL byte: injective
// for free, because neither half can contain one — and the price was that git
// classified this whole module as BINARY, so a plain `git diff` of it printed
// "Binary files differ" and every reviewer of a verify change had to know to
// reach for `git diff --text`.
//
// Two separate claims are pinned below, because closing this needed two moves
// and either one could regress without the other noticing:
//
//   1. NO CONTROL CHARACTER survives anywhere in the module (the source scan) —
//      the regression this guards is someone reaching for \x00, \x01 or \x1f
//      again the next time a "separator that cannot appear in the data" is
//      wanted. It scans the whole file rather than one line on purpose: a
//      control byte ANYWHERE in the file is what makes git call it binary, so
//      the file, not the expression, is the real subject.
//   2. The replacement still DE-DUPLICATES, and still cannot collide — including
//      the case a printable separator makes possible for the first time, where a
//      command or a cwd contains the separator character itself.
describe('verify.ts — the de-duplication separator is printable (issue #724)', () => {
  const MODULE_PATH = join(__dirname, 'verify.ts');
  const source = readFileSync(MODULE_PATH, 'utf-8');

  it('contains not one control character — a plain `git diff` of it renders as text', () => {
    const offenders: string[] = [];
    for (let i = 0; i < source.length; i += 1) {
      const code = source.charCodeAt(i);
      // \n (0x0A) is the only control character a source file legitimately
      // carries. \t is excluded too: this repo indents with spaces, so a tab
      // here would itself be a finding.
      if (code === 0x0a) continue;
      if (code < 0x20 || code === 0x7f) {
        const line = source.slice(0, i).split('\n').length;
        offenders.push(`line ${line}: U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
      }
    }
    expect(offenders, `control characters in verify.ts: ${offenders.join(', ')}`).toEqual([]);
  });

  it('carries no NUL byte specifically — the exact byte that made this file diff as binary', () => {
    // Spelled as an ESCAPE, never as a literal: a literal NUL in THIS file
    // would make the spec itself diff as binary, which is the very defect
    // being closed one module over.
    expect(source.includes('\u0000')).toBe(false);
  });
});

describe('verifyCommands — the printable-separator key still de-duplicates and cannot collide (issue #724)', () => {
  it('still collapses a genuinely repeated command, cwd and all', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ cwd: 'pkg', command: 'npm test' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ cwd: 'pkg', command: 'npm test' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([
      { cwd: 'pkg', command: 'npm test' },
    ]);
  });

  it('keeps cwd in the key: the SAME command under two different cwds is two commands', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ cwd: 'one', command: 'npm test' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ cwd: 'two', command: 'npm test' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([
      { cwd: 'one', command: 'npm test' },
      { cwd: 'two', command: 'npm test' },
    ]);
  });

  // THE case a printable separator introduces and a NUL could not: the data
  // itself contains the separator character. Under a plain `cwd + ':' + command`
  // join these two DIFFERENT commands both key as "a:b:c", so the second would
  // be silently dropped from a Worker's and a Reviewer's verify gate alike —
  // the quietest possible failure, because the selection just comes back one
  // command shorter and nothing says so.
  it('CANNOT COLLIDE when the separator character appears in the data itself', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ cwd: 'a:b', command: 'c' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ cwd: 'a', command: 'b:c' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([
      { cwd: 'a:b', command: 'c' },
      { cwd: 'a', command: 'b:c' },
    ]);
  });

  // The realistic shape of the same hazard: a command that carries a colon
  // because commands routinely do (a URL, a `docker run image:tag`, a
  // `sed 's/x/y/'` with a colon in it, a scheme-prefixed path).
  it('CANNOT COLLIDE on a realistic separator-bearing command either', () => {
    const cfg: VerifyConfig = {
      profiles: [
        {
          name: 'a',
          appliesTo: ['libs/**'],
          commands: [{ cwd: 'ops', command: 'docker run app:latest test' }],
        },
        {
          name: 'b',
          appliesTo: ['apps/**'],
          commands: [{ cwd: 'ops:latest', command: 'docker run app test' }],
        },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([
      { cwd: 'ops', command: 'docker run app:latest test' },
      { cwd: 'ops:latest', command: 'docker run app test' },
    ]);
  });

  // The absent-cwd half of the same question. `undefined` and `''` are the same
  // cwd (both mean "the repo root"), so these two DO collapse — and a
  // length-prefixed key gets that right for the same arithmetic reason it keeps
  // the pair above apart: both render a length of 0.
  it('an omitted cwd and an empty-string cwd are still ONE command', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ command: 'npm test' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ cwd: '', command: 'npm test' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([{ command: 'npm test' }]);
  });

  // …and the boundary the length prefix itself creates: a cwd whose own text
  // begins with digits and a separator, which is exactly what the key's prefix
  // looks like. A parser that read the prefix greedily, or a key that omitted
  // the second separator, could confuse these two.
  it('CANNOT COLLIDE when a cwd itself looks like a length prefix', () => {
    const cfg: VerifyConfig = {
      profiles: [
        { name: 'a', appliesTo: ['libs/**'], commands: [{ cwd: '1:x', command: 'y' }] },
        { name: 'b', appliesTo: ['apps/**'], commands: [{ cwd: '1', command: ':x:y' }] },
      ],
    };
    expect(verifyCommands(['libs/x.ts', 'apps/y.ts'], cfg)).toEqual([
      { cwd: '1:x', command: 'y' },
      { cwd: '1', command: ':x:y' },
    ]);
  });
});
