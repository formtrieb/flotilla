import { describe, it, expect } from 'vitest';
import { verifyCommands, type VerifyConfig } from './verify';

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
