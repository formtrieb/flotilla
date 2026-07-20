/**
 * Repo-root resolution for the wave CLIs.
 *
 * Issues live at `<root>/.scratch/<slug>/issues/<NN>-*.md` under a
 * MarkdownFsStore, so the repo root is — by construction — the nearest
 * ancestor of an issue path that contains a `.scratch/` subdirectory. THAT
 * ancestor is the authoritative root for a MarkdownFsStore consumer, and we
 * still walk for it unconditionally: it is cheap, harmless when absent, and
 * remains the only reliable anchor for a freshly-created MarkdownFsStore root
 * (see the "Footgun this fixes" note below — a bare `.scratch` root need not
 * have a sibling `package.json`).
 *
 * Footgun this fixes: the original implementation required the `.scratch` dir
 * to ALSO have a sibling `package.json`, and silently fell back to
 * `process.cwd()` when none was found. A freshly-created MarkdownFsStore root
 * has no package.json, so the real root was skipped and cwd was used —
 * making Gate-5 `blocked-by-chain-resolves` (and the conflict-map) resolve
 * sibling issues against the WRONG root. A silent wrong-root is unsafe for a
 * gate (false FAIL when the blocker does resolve; false PASS if cwd happens
 * to hold a matching `.scratch`). We now anchor purely on the `.scratch`
 * ancestor.
 *
 * FOR-48 — retiring the legacy warning: `.scratch/` is a MarkdownFsStore
 * convention (the Ur's markdown-as-tracker binding — see CONTEXT.md's "Ur"
 * entry) — GitHub/Linear-backed waves never have one anywhere in their tree,
 * so every find-repo-root consumer
 * (merge-order, dor, files-drift, conflict-map) printed a "no .scratch/
 * ancestor found" warning on EVERY run against those stores. That warning is
 * now opt-in (`warnOnFallback: true` or `WAVE_WARN_NO_SCRATCH_ROOT=1`),
 * defaulting to silent-off — the fallback to `process.cwd()` (still the
 * correct consumer root for a non-MarkdownFs consumer invoked from repo root,
 * as every wave skill does) is unchanged, just quiet by default.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface FindScratchRootOptions {
  /**
   * Print the legacy "no .scratch/ ancestor found" diagnostic to stderr when
   * falling back to `process.cwd()`. Default: `false` (silent) — resolved
   * from `env.WAVE_WARN_NO_SCRATCH_ROOT === '1'` when not passed explicitly.
   * Opt in for debugging a MarkdownFsStore root that unexpectedly isn't found;
   * every other consumer (GitHub/Linear-backed waves have no `.scratch/`
   * layout at all) should stay on the silent default.
   */
  warnOnFallback?: boolean;
  /** Injectable env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

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
 * no `.scratch/` ancestor exists at all (a stray path, or — the common case —
 * a non-MarkdownFs consumer that never has a `.scratch/` layout) do we fall
 * back to `process.cwd()`, silently unless {@link FindScratchRootOptions.warnOnFallback}
 * opts in.
 */
export function findScratchRoot(
  start: string,
  opts: FindScratchRootOptions = {},
): string {
  let dir = resolve(start);
  for (let i = 0; i < 50; i++) {
    if (hasScratchDir(dir)) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  // No .scratch ancestor anywhere — `start` is not under a MarkdownFsStore
  // root (or there simply isn't one, e.g. a GitHub/Linear-backed wave).
  // Fall back to cwd, silent by default (FOR-48) — opt in to the diagnostic
  // via `warnOnFallback` or WAVE_WARN_NO_SCRATCH_ROOT=1.
  const env = opts.env ?? process.env;
  const warn = opts.warnOnFallback ?? env.WAVE_WARN_NO_SCRATCH_ROOT === '1';
  if (warn) {
    process.stderr.write(
      `[wave] warning: no .scratch/ ancestor found above ${resolve(start)}; ` +
        `falling back to cwd (${process.cwd()}) — gate results may be unreliable.\n`,
    );
  }
  return process.cwd();
}
