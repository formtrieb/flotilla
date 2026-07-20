/**
 * Repo-root resolution for the wave CLIs.
 *
 * Issues live at `<root>/.scratch/<slug>/issues/<NN>-*.md`, so the repo root is
 * — by construction — the nearest ancestor of an issue path that contains a
 * `.scratch/` subdirectory. THAT ancestor is the authoritative root.
 *
 * Footgun this fixes: the original implementation required the `.scratch` dir to
 * ALSO have a sibling `package.json`, and silently fell back to
 * `process.cwd()` when none was found. A freshly-created MarkdownFsStore root
 * has no package.json, so the real root was skipped and cwd was used — making
 * Gate-5 `blocked-by-chain-resolves` (and the conflict-map) resolve sibling
 * issues against the WRONG root. A silent wrong-root is unsafe for a gate
 * (false FAIL when the blocker does resolve; false PASS if cwd happens to hold
 * a matching `.scratch`). We now anchor purely on the `.scratch` ancestor.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function hasScratchDir(dir: string): boolean {
  const candidate = resolve(dir, '.scratch');
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up from `start`; return the first ancestor dir that contains a
 * `.scratch/` subdir — that ancestor IS the repo root by construction. Only if
 * no `.scratch/` ancestor exists at all (a stray path) do we fall back to
 * `process.cwd()`.
 */
export function findScratchRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 50; i++) {
    if (hasScratchDir(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // No .scratch ancestor anywhere — `start` is not under a known root.
  // Fall back to cwd, but warn: a wrong root silently degrades the DOR gate.
  process.stderr.write(
    `[wave] warning: no .scratch/ ancestor found above ${resolve(start)}; ` +
      `falling back to cwd (${process.cwd()}) — gate results may be unreliable.\n`,
  );
  return process.cwd();
}
