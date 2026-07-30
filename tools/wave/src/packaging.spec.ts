import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * packaging.spec.ts — asserts the *actually published* npm file set reaches
 * every runtime directory the toolkit ships on disk, not just `src`/`bin`.
 *
 * ## Why this exists
 *
 * `package.json`'s `files` array is a hand-maintained allowlist. It drifted
 * once already: `hooks/echo-guard.cjs` (the Echo-Guard `PreToolUse` script a
 * consumer's stage-2 scaffold points at) was never added to `files`, so it
 * shipped in every repo checkout but in *no* published npm/plugin install —
 * a clean-room gap invisible from inside this repo, because `npm test` here
 * never runs against the published artifact.
 *
 * ## Why this probes `npm pack`, not `package.json.files`
 *
 * A spec that re-reads `package.json.files` and asserts against itself would
 * pass even if `files` were wrong — it proves the array is internally
 * consistent, not that anything actually ships. `npm pack --dry-run --json`
 * is the same resolution npm runs at publish time (glob + ignore rules, not
 * just the raw array), so it is the honest ground truth for "what a
 * consumer's `npm install` actually receives."
 *
 * ## Why the directory list is derived, not copied from today's `files`
 *
 * Hardcoding `['src', 'bin', 'hooks']` here would only catch a *second*
 * regression of the exact directories that exist today — it would still miss
 * the next runtime-adjacent directory added to the package root and never
 * wired into `files`, which is precisely the failure class this issue is
 * about. Instead this reads the package root's actual directory listing at
 * test time: every top-level directory is a candidate runtime directory
 * unless it is `node_modules` (npm's own dependency tree, never republished)
 * or a dot-directory (tooling metadata). Add a new top-level directory with
 * runtime content and forget to list it in `files`, and this test fails for
 * that directory by name — without anyone touching this spec file first.
 */

const PACKAGE_ROOT = join(__dirname, '..');

const NEVER_PUBLISHED_DIR = (name: string): boolean =>
  name === 'node_modules' || name.startsWith('.');

function runtimeDirectoryNames(): string[] {
  return readdirSync(PACKAGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !NEVER_PUBLISHED_DIR(name));
}

function publishedFilePaths(): string[] {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

describe('published npm package file set', () => {
  it('derives at least one candidate runtime directory from the filesystem', () => {
    // Guards the derivation itself: if this ever comes back empty the rest
    // of the suite below would vacuously pass, which is worse than not
    // running at all.
    expect(runtimeDirectoryNames().length).toBeGreaterThan(0);
  });

  it('ships every top-level runtime directory the toolkit has on disk', () => {
    const dirs = runtimeDirectoryNames();
    const published = publishedFilePaths();

    for (const dir of dirs) {
      const hasFileFromDir = published.some((p) => p === dir || p.startsWith(`${dir}/`));
      expect(
        hasFileFromDir,
        `expected the published package to include a file under "${dir}/" ` +
          `(derived from the on-disk directory listing), but none of the ` +
          `${published.length} published paths matched. Published paths: ` +
          JSON.stringify(published),
      ).toBe(true);
    }
  });

  it('specifically covers the Echo-Guard hook script', () => {
    // Named regression pin for this issue: the hook a stage-2 consumer
    // scaffold points at must be reachable from a plain `npm install`.
    const published = publishedFilePaths();
    expect(published).toContain('hooks/echo-guard.cjs');
  });
});
