/**
 * The ONE `--title-file` reader (title-file.ts), pinned on its own. Both verbs
 * that take the flag — `host-pr create` and `route-tuple` — import it; their
 * own specs keep pinning the flag through the verb (wiring + printed message),
 * this one pins the reader's rule and that no second reader exists.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTitleFile } from './title-file';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('readTitleFile — the shared --title-file reader', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'title-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  function file(content: string, name = 't.txt'): string {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  }

  it('trims ONE trailing newline (`\\n` or `\\r\\n`), and only one', () => {
    expect(readTitleFile(file('T\n', 'a'))).toEqual({ ok: true, title: 'T' });
    expect(readTitleFile(file('T\r\n', 'b'))).toEqual({ ok: true, title: 'T' });
    expect(readTitleFile(file('T\n\n', 'c'))).toEqual({ ok: true, title: 'T\n' });
    expect(readTitleFile(file('T', 'd'))).toEqual({ ok: true, title: 'T' });
  });

  it('carries git-command text and shell metacharacters verbatim', () => {
    const title = "fix: `git reset --hard` fallback, $HOME and 'quotes'";
    expect(readTitleFile(file(`${title}\n`))).toEqual({ ok: true, title });
  });

  it('refuses an absent path, an empty title and an unreadable path — with the messages both verbs print', () => {
    const needs = '--title-file <path> needs a path (the file whose content becomes the PR title)';
    expect(readTitleFile(undefined)).toEqual({ ok: false, message: needs });
    expect(readTitleFile('')).toEqual({ ok: false, message: needs });
    const empty = file('', 'empty');
    expect(readTitleFile(empty)).toEqual({ ok: false, message: `--title-file "${empty}" is empty — a PR needs a title` });
    const nl = file('\n', 'nl');
    expect(readTitleFile(nl)).toEqual({ ok: false, message: `--title-file "${nl}" is empty — a PR needs a title` });
    const missing = join(dir, 'missing.txt');
    const r = readTitleFile(missing);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.message).toMatch(new RegExp(`^could not read --title-file "${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": `));
  });

  it('is the ONLY readTitleFile in the engine source, and both verbs import it', () => {
    const sources = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf-8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.includes('__fixtures__'));
    const declaring = sources.filter((f) => /function readTitleFile\s*\(/.test(readFileSync(join(SRC_DIR, f), 'utf-8')));
    expect(declaring).toEqual(['title-file.ts']);
    for (const verb of ['host-pr-cli.ts', 'route-tuple.ts']) {
      expect(readFileSync(join(SRC_DIR, verb), 'utf-8'), verb).toContain("import { readTitleFile } from './title-file';");
    }
  });
});
