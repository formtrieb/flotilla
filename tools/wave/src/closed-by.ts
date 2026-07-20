/**
 * closed-by.ts — pure classifier for `Closed-by:` lines.
 *
 * Canonical spec: .scratch/wave-orchestration/issues/55-closed-by-classifier.md
 * Parent PRD:     .scratch/wave-orchestration/wave-close-skill-PRD.md (stories 21, 3, 4, 6)
 *
 * This module answers the question "does this `Closed-by:` row still need a
 * real PR opened and pinned?" — a single tested predicate (`needsPin`) backed
 * by a six-class classifier (`classifyClosedBy`) and a canonical formatter
 * (`renderPinned`).
 *
 * Classification precedence (strongest signal wins):
 *   real-pr      — a real GitHub or Bitbucket PR URL appears anywhere in the line
 *   pre-fill     — a Bitbucket pre-fill URL appears anywhere in the line (no real PR)
 *   placeholder  — the literal `<PR-URL pending>` (or another `<…>` placeholder)
 *   sha          — a bare commit SHA (hex ≥ 7 chars, no URL prefix)
 *   prose        — any other non-empty text
 *   empty        — blank / whitespace-only
 *
 * Pure functions, no I/O, no seam needed.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The six classes a `Closed-by:` line can resolve to.
 *
 * | Class         | Meaning                                                                    |
 * |---------------|----------------------------------------------------------------------------|
 * | `real-pr`     | A real GitHub `/pull/<N>` or Bitbucket `/pull-requests/<N>` URL            |
 * | `pre-fill`    | A Bitbucket `…/pull-requests/new?source=<branch>…` pre-fill link          |
 * | `placeholder` | A `<PR-URL pending>` or similar `<…>` placeholder literal                 |
 * | `sha`         | A bare commit SHA (7–40 hex digits, no URL or prose surrounding it)        |
 * | `prose`       | Non-empty free text that matches none of the above                         |
 * | `empty`       | Blank or whitespace-only                                                   |
 */
export type ClosedByClass =
  | 'real-pr'
  | 'pre-fill'
  | 'placeholder'
  | 'sha'
  | 'prose'
  | 'empty';

// ─── Regexes (module-private) ─────────────────────────────────────────────────

/**
 * Matches a real GitHub PR URL: `https://github.com/<owner>/<repo>/pull/<N>`.
 * Optional trailing query/hash/path after the issue number.
 */
const GITHUB_REAL_PR_RE =
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i;

/**
 * Matches a real Bitbucket PR URL:
 * `https://bitbucket.org/<ws>/<repo>/pull-requests/<N>`.
 * The path MUST end at `/<N>` (no `new?source=` or further path segments that
 * would make it a pre-fill URL).
 */
const BITBUCKET_REAL_PR_RE =
  /https?:\/\/bitbucket\.org\/[^/\s]+\/[^/\s]+\/pull-requests\/\d+(?:[/?#][^\s]*)?/i;

/**
 * Matches a Bitbucket pre-fill URL: `…/pull-requests/new?source=<branch>…`.
 */
const BITBUCKET_PRE_FILL_RE =
  /https?:\/\/bitbucket\.org\/[^/\s]+\/[^/\s]+\/pull-requests\/new\?source=[^\s]*/i;

/**
 * Matches any `<…>` placeholder (angle-bracket delimited, non-whitespace content).
 * Specifically designed to catch `<PR-URL pending>` and similar.
 */
const PLACEHOLDER_RE = /<[^>\s][^>]*>/;

/**
 * Matches a bare commit SHA: 7–40 lowercase or uppercase hex digits that
 * occupy the **entire** trimmed line (or constitute a standalone token when
 * there is no other meaningful content around them).
 *
 * We use a whole-string match on the trimmed line so that a SHA embedded
 * inside a URL or prose sentence is NOT classified as `sha`.
 */
const BARE_SHA_RE = /^[0-9a-f]{7,40}$/i;

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify the value portion of a `Closed-by:` line (the part after the
 * `**Closed-by:**` or `Closed-by:` prefix, already trimmed).
 *
 * Classification uses a strongest-signal-wins cascade:
 * 1. If a real PR URL appears anywhere → `real-pr`
 * 2. If a pre-fill URL appears anywhere → `pre-fill`
 * 3. If a `<…>` placeholder appears anywhere → `placeholder`
 * 4. If blank/whitespace → `empty`
 * 5. If the whole trimmed value is a bare commit SHA → `sha`
 * 6. Otherwise → `prose`
 *
 * @param line — The full raw text of the `Closed-by:` line (including any
 *               `**Closed-by:**` markdown prefix). The function strips the
 *               prefix itself; callers may pass the full line or just the value.
 */
export function classifyClosedBy(line: string): ClosedByClass {
  // Strip the common `**Closed-by:**` or `Closed-by:` markdown prefix so the
  // regexes operate on the value only.
  const value = stripPrefix(line).trim();

  // Priority 1 — real PR URL (strongest signal, wins over embedded prose)
  if (GITHUB_REAL_PR_RE.test(value) || hasRealBitbucketPr(value)) {
    return 'real-pr';
  }

  // Priority 2 — pre-fill URL
  if (BITBUCKET_PRE_FILL_RE.test(value)) {
    return 'pre-fill';
  }

  // Priority 3 — placeholder
  if (PLACEHOLDER_RE.test(value)) {
    return 'placeholder';
  }

  // Priority 4 — empty
  if (value === '') {
    return 'empty';
  }

  // Priority 5 — bare SHA
  if (BARE_SHA_RE.test(value)) {
    return 'sha';
  }

  // Priority 6 — prose (catch-all for non-empty free text)
  return 'prose';
}

// ─── needsPin ────────────────────────────────────────────────────────────────

/**
 * Returns `true` when the `Closed-by:` line still needs a real PR opened
 * and its URL pinned — i.e. the class is `pre-fill` or `placeholder`.
 *
 * `real-pr`, `prose`, `sha`, and `empty` all return `false`; a `real-pr`
 * row is already finalised, while `prose`/`sha`/`empty` are unconventional
 * and not actionable by the automated close flow.
 */
export function needsPin(line: string): boolean {
  const cls = classifyClosedBy(line);
  return cls === 'pre-fill' || cls === 'placeholder';
}

// ─── renderPinned ─────────────────────────────────────────────────────────────

/**
 * Produce the canonical pinned `Closed-by:` line for a given real PR URL.
 *
 * Format: `**Closed-by:** <realUrl>` (bold prefix, one space, the URL).
 *
 * @param realUrl — A real PR URL (GitHub or Bitbucket).  The caller is
 *                  responsible for passing a valid URL; this function does NOT
 *                  validate the URL format.
 */
export function renderPinned(realUrl: string): string {
  return `**Closed-by:** ${realUrl}`;
}

// ─── Helpers (module-private) ─────────────────────────────────────────────────

/**
 * Strip the `**Closed-by:**` or `Closed-by:` markdown prefix from a line,
 * leaving only the value portion.
 */
function stripPrefix(line: string): string {
  // Bold-markdown prefix: `**Closed-by:**`
  const boldMatch = line.match(/^\*{1,2}[Cc]losed-by:\*{1,2}\s*(.*)/s);
  if (boldMatch) return boldMatch[1];

  // Plain prefix: `Closed-by:`
  const plainMatch = line.match(/^[Cc]losed-by:\s*(.*)/s);
  if (plainMatch) return plainMatch[1];

  // No recognised prefix — treat the whole line as the value
  return line;
}

/**
 * Returns true if the value contains a Bitbucket PR URL that is a *real* PR
 * (has a numeric ID) rather than a pre-fill URL (`/new?source=…`).
 *
 * We need this helper because the Bitbucket real-PR pattern and the pre-fill
 * pattern both contain `/pull-requests/` — the real one ends in `/<N>`, the
 * pre-fill ends in `/new?source=`.  The pre-fill regex is more specific, so
 * we check for pre-fill first in the main cascade; this helper is only called
 * from the real-PR priority slot and must therefore exclude pre-fill URLs.
 */
function hasRealBitbucketPr(value: string): boolean {
  return BITBUCKET_REAL_PR_RE.test(value) && !BITBUCKET_PRE_FILL_RE.test(value);
}
