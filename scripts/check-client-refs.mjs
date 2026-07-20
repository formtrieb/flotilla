#!/usr/bin/env node
// De-client denylist gate (ADR-0026).
//
// This script ships PUBLIC — its pattern list would name exactly what it
// guards, so the patterns live in a gitignored, untracked local file
// (`.declient-denylist`, one pattern per line, `#`-comments) that is never
// committed. On a machine without that file the check SKIPS LOUDLY rather
// than silently reporting success — absence must never look like a pass.
// Zero deps: node:* only.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DENYLIST_FILENAME = '.declient-denylist';

/**
 * Parse a denylist file's raw text into an ordered list of patterns.
 * Blank lines and lines whose first non-whitespace character is `#` are
 * comments and are skipped.
 * @param {string} content
 * @returns {string[]}
 */
export function parsePatterns(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Scan a single file's text content for case-insensitive substring hits
 * against every pattern, line by line.
 * @param {string} content
 * @param {string[]} patterns
 * @returns {{ line: number, pattern: string }[]}
 */
export function scanFileContent(content, patterns) {
  if (patterns.length === 0) return [];
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const lowerLine = lines[i].toLowerCase();
    for (const pattern of patterns) {
      if (lowerLine.includes(pattern.toLowerCase())) {
        hits.push({ line: i + 1, pattern });
      }
    }
  }
  return hits;
}

/**
 * Read + scan one file on disk. Unreadable files (binary decode oddities
 * aside, real I/O failures — gone symlinks, permission errors) are treated
 * as no-hit rather than fatal, since the tracked tree can contain files a
 * text scan has no business rejecting the whole run over.
 * @param {string} absPath
 * @param {string[]} patterns
 * @returns {{ line: number, pattern: string }[]}
 */
export function scanFile(absPath, patterns) {
  let content;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  return scanFileContent(content, patterns);
}

/**
 * List every git-tracked file in `repoRoot`, repo-root-relative.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function getTrackedFiles(repoRoot) {
  const output = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * Run the full check. Pure over its inputs (no process.exit / no console
 * I/O) so it is directly unit-testable.
 * @param {{ repoRoot: string, denylistPath: string }} opts
 * @returns {
 *   | { status: 'skipped' }
 *   | { status: 'clean', scanned: number }
 *   | { status: 'hits', scanned: number, hits: { file: string, line: number, pattern: string }[] }
 * }
 */
export function runCheck({ repoRoot, denylistPath }) {
  if (!existsSync(denylistPath)) {
    return { status: 'skipped' };
  }

  const patterns = parsePatterns(readFileSync(denylistPath, 'utf8'));
  const trackedFiles = getTrackedFiles(repoRoot);

  const hits = [];
  for (const relFile of trackedFiles) {
    // the denylist file itself is untracked (gitignored) so it can never
    // appear in `trackedFiles`, and needs no special-case exclusion here.
    const absFile = path.join(repoRoot, relFile);
    for (const hit of scanFile(absFile, patterns)) {
      hits.push({ file: relFile, line: hit.line, pattern: hit.pattern });
    }
  }

  if (hits.length > 0) {
    return { status: 'hits', scanned: trackedFiles.length, hits };
  }
  return { status: 'clean', scanned: trackedFiles.length };
}

function printAndExit(result) {
  if (result.status === 'skipped') {
    // Loud + shaped nothing like the zero-hits success summary below —
    // a skip must never be mistakable for a pass.
    console.log(
      `SKIPPED - no denylist on this machine (${DENYLIST_FILENAME} not found at repo root; this check is a cut-time + local guard, not a public CI guarantee)`,
    );
    process.exit(0);
  }

  if (result.status === 'hits') {
    for (const hit of result.hits) {
      console.log(`${hit.file}:${hit.line}: ${hit.pattern}`);
    }
    console.log(
      `\nFAIL - ${result.hits.length} hit(s) across ${result.scanned} scanned tracked files.`,
    );
    process.exit(1);
  }

  console.log(`OK - scanned ${result.scanned} tracked files, 0 hits`);
  process.exit(0);
}

function main() {
  const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const denylistPath = path.join(repoRoot, DENYLIST_FILENAME);
  printAndExit(runCheck({ repoRoot, denylistPath }));
}

// Only run as a CLI when invoked directly (`node scripts/check-client-refs.mjs`),
// not when imported by the co-located test file. Compare resolved file URLs
// rather than raw strings so paths containing spaces/special characters
// (this repo's own path does) still match correctly.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}

// exported for tests that want to resolve "this file's own path" robustly
export const __filename = fileURLToPath(import.meta.url);
