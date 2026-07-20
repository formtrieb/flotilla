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
