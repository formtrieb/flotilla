/**
 * The ONE `--title-file <path>` reader (issue #1065), shared by the two verbs
 * that take the flag: `host-pr create` and `route-tuple`. Each used to carry a
 * module-local twin with the same rule and the same messages, held together
 * only by parallel spec cases; one reader makes a drift between them
 * inexpressible instead of merely detectable.
 *
 * **Why the file form exists.** In the field, an agent harness's
 * worktree-isolation guard refused a Worker's `host-pr create` because its
 * quoted `--title` VALUE contained git-command text (`git reset --hard`, the
 * row's own subject) — "so what it runs cannot be shown not to be git" — and
 * `--title "$(cat f)"` was refused in turn as a value computed at runtime. The
 * refusal did not reproduce on demand from an isolated dispatch (wave-shared
 * Convention 13, Catalog entry 8), which is the argument FOR the file: a caller
 * cannot predict whether its call will be refused, and a file keeps the text off
 * the command line entirely.
 *
 * Module-local to the engine (barrel-drift allowlist): a consumer passes the
 * FLAG to either verb, never imports the reader.
 */
import { readFileSync } from 'node:fs';

/** {@link readTitleFile}'s answer: the title, or the usage message that refuses it. */
export type TitleFileRead = { ok: true; title: string } | { ok: false; message: string };

/**
 * Read a PR title from `--title-file <path>`.
 *
 * **One trailing newline is trimmed, and only one** (`\n` or `\r\n`): a file
 * written by any editor ends in a newline that is not part of the title, while
 * anything beyond it is content the caller wrote and is left alone. Unlike
 * `--body-file`, which is verbatim because the close-phrase guard is
 * line-anchored, a title is one line and has no such guard to protect.
 *
 * An absent path, an unreadable path, and an empty title (after the trim) are
 * each refused with a message naming the flag and — where there is one — the
 * path, because the path is what the caller can fix. The message carries no
 * verb prefix: each call site adds its own (`route-tuple: …`) or none
 * (`host-pr`'s usage renderer), exactly as each printed before. Pure apart from
 * the read.
 */
export function readTitleFile(path: string | undefined): TitleFileRead {
  if (path === undefined || path.length === 0) {
    return { ok: false, message: '--title-file <path> needs a path (the file whose content becomes the PR title)' };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    return { ok: false, message: `could not read --title-file "${path}": ${(err as Error).message}` };
  }
  const title = raw.replace(/\r?\n$/, '');
  if (title.length === 0) {
    return { ok: false, message: `--title-file "${path}" is empty — a PR needs a title` };
  }
  return { ok: true, title };
}
