/**
 * ff-guard.ts — true-fast-forward safety predicate for the Coordinator
 * branch-sync (`feat/new-design-system` → `main`). See Wave Playbook §7.1.
 *
 * The branch-sync invariant is FF-ONLY: a `git push origin <branch>:main` must
 * never create a merge commit on `main`. This module answers "is pushing
 * <branch> to <base> a true fast-forward?" deterministically, so the
 * FF-vs-merge-commit distinction stops being LLM judgment (audit Finding §3).
 *
 * Pure function modulo one side-effect: git ancestry/count, isolated behind the
 * injectable `FfProbe` seam (same pattern as merge-order.ts's `GitProbe`), so
 * the spec is fully hermetic — no real branches required.
 *
 * wave-orchestration #62.
 */

import { execFileSync } from 'node:child_process';

/**
 * Git seam. The default implementation shells out to git; the spec injects a
 * fixture so tests need no real branches.
 */
export interface FfProbe {
  /**
   * `git merge-base --is-ancestor <ancestor> <descendant>` — `true` when
   * `<ancestor>` is reachable from `<descendant>` (exit 0).
   */
  isAncestor(ancestor: string, descendant: string): boolean;
  /**
   * `git rev-list --count <from>..<to>` — the number of commits reachable from
   * `<to>` but not from `<from>`.
   */
  countAhead(from: string, to: string): number;
}

/**
 * A true fast-forward (`ff: true`) means `base` is an ancestor of `branch`, so
 * `git push origin branch:base` advances `base` with no merge commit.
 * `ahead: 0` on a true FF means already-synced (an idempotent no-op).
 * On `ff: false`, `behind` is the count of commits on `base` not on `branch`
 * (what a reconcile — `git merge origin/main` — would need to bring in first).
 */
export type FfResult =
  | { ff: true; ahead: number }
  | { ff: false; behind: number; ahead: number };

export interface FfGuardOptions {
  /** Branch (or ref) being pushed. Default `'HEAD'`. */
  branch?: string;
  /** Push destination ref. Default `'origin/main'`. */
  base?: string;
  /** Repo root for the default probe (ignored when `git` is injected). */
  repoRoot?: string;
  /** Injectable git seam. Defaults to {@link defaultFfProbe}. */
  git?: FfProbe;
}

/**
 * Decide whether pushing `branch` onto `base` is a true fast-forward.
 *
 * @example
 *   const r = isFastForward({ branch: 'feat/new-design-system' });
 *   if (!r.ff) stop(`not a fast-forward — ${r.behind} commit(s) behind main`);
 *   else if (r.ahead === 0) log('already synced — nothing to push');
 *   else push();
 */
export function isFastForward(opts: FfGuardOptions = {}): FfResult {
  const branch = opts.branch ?? 'HEAD';
  const base = opts.base ?? 'origin/main';
  const git = opts.git ?? defaultFfProbe(opts.repoRoot ?? process.cwd());

  // True FF ⇔ base is an ancestor of branch (branch is ahead-only of base).
  const ff = git.isAncestor(base, branch);
  const ahead = git.countAhead(base, branch); // commits on branch not on base

  if (ff) {
    return { ff: true, ahead };
  }
  const behind = git.countAhead(branch, base); // commits on base not on branch
  return { ff: false, behind, ahead };
}

/** Default git-shelling probe (mirrors merge-order.ts's `defaultGitProbe`). */
export function defaultFfProbe(repoRoot: string): FfProbe {
  const run = (args: string[]): { ok: boolean; out: string } => {
    try {
      const out = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { ok: true, out };
    } catch (err) {
      const out =
        typeof (err as { stdout?: unknown }).stdout === 'string'
          ? (err as { stdout: string }).stdout
          : '';
      return { ok: false, out };
    }
  };

  return {
    isAncestor(ancestor: string, descendant: string): boolean {
      // exit 0 → ancestor; any non-zero (incl. 1, "not a valid object") → not.
      return run(['merge-base', '--is-ancestor', ancestor, descendant]).ok;
    },
    countAhead(from: string, to: string): number {
      const res = run(['rev-list', '--count', `${from}..${to}`]);
      if (!res.ok) return 0;
      const n = Number.parseInt(res.out.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    },
  };
}
