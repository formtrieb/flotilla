/**
 * cli-utils.ts — the tiny shared helpers every engine CLI runner uses.
 *
 * Extracted (P7.2.0) from the byte-identical `flag()` that had been copied into
 * cross-wave-cli / issue-store-cli / resume-cli, plus the identical pretty-JSON
 * stdout pattern. Each CLI keeps its OWN usage strings local; only these two
 * mechanical helpers are shared.
 */

/** Find the value of a named flag in an args array, or undefined. */
export function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

/** Write a value to stdout as pretty (2-space) JSON with a trailing newline. */
export function printJson(x: unknown): void {
  process.stdout.write(JSON.stringify(x, null, 2) + '\n');
}
