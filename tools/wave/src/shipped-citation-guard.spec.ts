import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * shipped-citation-guard.spec.ts — the published artifact may not cite a path
 * that only flotilla's own checkout can resolve.
 *
 * ## The class, and why it needed its own guard
 *
 * flotilla runs the **source form** on both distribution layers: the skills sit
 * in this repo's `.claude/skills/`, the engine in `tools/wave/`. Every consumer
 * runs the **installed form**: the skills arrive as a plugin clone and the
 * engine as an npm package, bound through `engine.cli` (ADR-0032). A path this
 * repo can resolve is therefore *not* a path a consumer can resolve, and the
 * gap is invisible from inside the repo — everything the author checks is right
 * there on disk.
 *
 * That gap reached a stranger. The `PreToolUse` echo-guard's refusal message
 * ended on `Full doctrine: <a path under .claude/skills/…>`. The hook ships in
 * the tarball's `hooks/` directory and the setup scaffold copies it into every
 * consumer's own hooks directory, so the message travelled verbatim — and its
 * last line was dead at the one moment a consumer read it: their first refusal.
 * The first installed-form 1.0.0 consumer reported it within hours of release.
 *
 * A sweep at that point found the emitted refusal was the ONLY runtime-emitted
 * instance, plus three inert doc-comments in shipped sources citing brief/handling
 * documents that had been folded into their owning SKILL and mechanics documents
 * and existed under no spelling at all.
 *
 * ## Five rules; rules 1–3 and 5 share one subject, the artifact a consumer installs
 *
 * 1. **No form-dependent path in the guard's REFUSAL OUTPUT** — checked by
 *    running the hook *out of a freshly packed tarball*, not out of the repo
 *    tree. Reading the repo tree is what made the class invisible in the first
 *    place; packing is cheap (well under a second) and removes the assumption
 *    entirely.
 * 2. **No doc-comment in a shipped engine source citing a skill document that
 *    does not exist** — every such citation must resolve, or must not be a path
 *    at all.
 * 3. **No LABELED HEADER POINTER in a shipped engine source aiming at a markdown
 *    document that does not exist** — the same resolution demand as rule 2, over
 *    a shape rule 2 structurally could not see (see below).
 * 4. **A SPEC file is held to rules 2, 3 and 5 as well** — the one rule here whose
 *    subject is the maintainer-facing surface rather than the shipped one. It is
 *    a decision this file records rather than a scope it inherited; the reasoning
 *    is under "The spec-file question" below.
 * 5. **No UNLABELED PROSE CITATION in a shipped engine source aiming at a
 *    document that does not exist** — the same resolution demand again, over a
 *    THIRD shape rules 2 and 3 both walked past (see "Rule 5" below).
 *
 * Rule 2's second branch is deliberate and is where the fix for the three dead
 * citations went: the repair is to **name the subject** ("the Worker brief's
 * Report block, composed by `workerBrief()` in the wave-start skill's workflow
 * driver") rather than to re-spell the path. A citation with no path in it has
 * nothing for the extractor below to find, and that is the intended pass — the
 * same division of labour Convention 14's own guard draws: placement is
 * machine-checkable, compression is the author's. Rules 3 and 4 keep that branch
 * unchanged, and the repairs made under them took it.
 *
 * ## Rule 3 — the shape rules 1 and 2 both walked past
 *
 * Rule 1 scopes itself to the refusal OUTPUT; rule 2 matches only a `.claude/…md`
 * target. Between them sat a third shape, ten instances strong across five
 * shipped modules: a module-header line of the form `<Label>: <path>.md` aiming
 * at a **predecessor-system scratch tree** (`Canonical spec`, `PRD source`,
 * `Audit source`, `Parent PRD`) or at an **agents-docs tree** (`Playbook`).
 * Neither tree is in the tarball, neither is reachable by any consumer, and the
 * scratch tree never existed in this repo at all — so those pointers were dead
 * for every reader including this repo's own maintainers.
 *
 * The near-miss that proves the gap was structural rather than careless: the
 * pass that landed rule 2 corrected a citation line in three of those five
 * modules — the `Mirrors:` line in two of them, the `Canonical spec:` line in
 * the third — and left the `PRD source` / `Playbook` / `Parent PRD` lines
 * *directly beside them, in the same docstring* untouched, because rule 2
 * matches a `.claude/…md` target and none of those had one.
 *
 * **The rule resolves rather than pattern-matching a tree.** A prefix table
 * (".scratch/ and docs/agents/ are banned") would close exactly today's two
 * trees and miss tomorrow's third; and it would wrongly fire on a pointer at a
 * tree that is form-dependent but genuinely present for the reader who follows
 * it. Asking "does this document exist" is the same question rule 2 asks, and it
 * is the question that has no maintenance burden. Requiring a `.md` target is
 * what keeps it honest in the other direction: a labeled line whose value is a
 * module specifier (`Costs nothing at load time: ./cli`) or plain prose
 * (`Escape a markdown-table cell: pipes/newlines`) is not a document pointer, and
 * a rule that resolved those would be a false-positive machine.
 *
 * ## Rule 5 — the shape rules 2 and 3 both walked past a second time
 *
 * The wave that landed rule 3 removed ten LABELED pointers (`<Label>: <path>.md`)
 * and, in the same pass, deliberately did not widen rule 3 to catch a second,
 * unlabeled population wearing a different shape: a sentence of the form
 * `<Spec|Schema> is canonical in <path>` — six instances, across the same five
 * modules rule 3's ten came from (`header-parser.ts` twice), naming the identical
 * two dead trees (`.scratch/wave-orchestration/…` and `docs/agents/…`). That was
 * the right call at the time: rule 3 matches a *labeled* pointer, and a rule
 * widened to catch unlabeled prose would have gone red on files the disclosing
 * row could not touch.
 *
 * **Two live phrasings, not one.** `header-parser.ts` cites the same dead path
 * twice in different words — `Schema is canonical in docs/agents/…md` at its
 * module header, and `The Header-Block is, by schema (docs/agents/…md), the
 * frontmatter region…` seventy lines later. Grepping `canonical in` and `by
 * schema` (case-insensitive) across every `.ts` file under `src/` found exactly
 * these six lines and nowhere else — both words appear routinely elsewhere with
 * no path in sight (`canonical issueId`, `canonical numeric-string key`,
 * `Gate-1 schema-membership check`), which is what keeps
 * {@link CANONICAL_CITATION_TRIGGER} a NAMED pair of phrases rather than a
 * bare-keyword search that would have fired on every one of them.
 *
 * **The scan window is bounded to the citing paragraph, not the rest of the
 * file.** A citation can name two paths across a line-wrap (`dor-gate.ts`'s
 * "…and in\n`<path>`" and `wave-md-rw.ts`'s "…in\n`<path>`"), so the extractor
 * reads from the trigger to the next blank `*` line or the comment's own close,
 * whichever comes first — never past it, or a trigger with no internal blank
 * line before its comment closes would run on into the next doc-comment down
 * the file and start collecting paths that were never part of the citation.
 *
 * **Verified NOT in this class.** `dor-gate.ts` carries two mentions of
 * `docs/agents/wave-playbook.md` as an ILLUSTRATIVE EXAMPLE of a consumer's own
 * doc path, inside prose about the basename-fallback coverage rule — not a
 * citation of this repo's spec or schema. Neither contains either trigger
 * phrase, so {@link extractCanonicalProseCitations} does not reach them; a
 * negative control below pins that directly, from the real file, so a future
 * edit that widens either fixture re-triggers it.
 *
 * ## The spec-file question — DECIDED here, so nobody has to re-open it
 *
 * A dead citation was also found in a SPEC file's docstring
 * (`stop-condition-state-machine.spec.ts`, pointing at a wave-start reference
 * document that exists under no spelling). Spec files are excluded from the
 * package's `files` manifest — correctly, since a consumer never receives one —
 * which meant rules 1–3, all of which read the packed tarball, structurally
 * could not see it, and no other check ever would either.
 *
 * **Decision: EXTEND the net (rule 4), rather than fix the one occurrence and
 * move on.** Three things settled it:
 *
 * - *The rot is the same rot.* A spec docstring is the first thing a maintainer
 *   or an agent reads before editing the module it guards. A dead pointer there
 *   mis-teaches exactly as much as a shipped one; only the blast radius differs.
 * - *The cost was measured, not assumed.* Applying rules 2 and 3 to every spec
 *   file surfaced exactly one genuine dead pointer — the one above — plus this
 *   file's OWN prose mentions of `.claude/loop.md`, and nothing else anywhere.
 *   The surface was already clean; the rule is a ratchet, not a migration.
 * - *The machinery already existed.* Rule 4 reuses all three extractors
 *   verbatim — rule 5's included, once it existed too (see "Rule 5" above);
 *   applying it to every spec file surfaced nothing new to fix.
 *
 * **The one exemption, and why it is not a hole being dug.** This file is
 * exempt from rule 4, because a guard cannot be its own subject: its fixtures
 * *plant* dead citations on purpose, and its prose must *name* the absent paths
 * whose absence it asserts (`.claude/loop.md` is the live example — the whole
 * point of the carve-out control is that this path does not exist). The
 * exemption is one named file, and a control below pins that it stays one.
 *
 * **What rule 4 is NOT.** It does not read the tarball (spec files are not in
 * it — asserted, not assumed, by the packing test below), and it does not
 * inherit rule 1: a spec file emits nothing, so form-dependence is not its
 * problem. `echo-guard.spec.ts`'s header names this repo's vendored path for the
 * hook it spawns, and that is correct — it is a fact about the repo the reader
 * of that file is standing in.
 *
 * ## Scope boundaries, stated so they are not read as oversights
 *
 * - **Rule 1 covers the refusal message, not the fail-open line.** A crash
 *   message interpolates a runtime error string; any path in it comes from the
 *   OS, not from a citation this repo wrote down.
 * - **Rule 2 covers doc-COMMENTS, not code.** `worktree-cleanup.ts` carries
 *   `.claude/…` strings that are functional path constants describing the
 *   harness layout of whichever repo the sweep runs in — including
 *   `.claude/loop.md`, a harness-owned file that legitimately does not exist
 *   here. Those are data, not citations, and re-pointing them would be a
 *   behavior change dressed as a doc fix. The comment-line classifier below is
 *   what keeps them out, and a permanent negative control pins that.
 * - **Rule 2 asks only "does this document exist".** A citation that resolves
 *   here still names a source-form location; several shipped comments cite
 *   `.claude/agents/wave-reviewer.md`, which is real and maintained. Those are
 *   inert — a maintainer reading the source follows them, nothing emits them —
 *   so this guard requires them to be *true*, not to be form-neutral. Only
 *   EMITTED text (rule 1) has to survive the distribution boundary.
 *
 * This is a separate file from `skill-reference-guard.spec.ts` on purpose: that
 * spec scans markdown under the skills tree and has no view of TypeScript
 * doc-comments, which is precisely why three dead citations sat in shipped
 * sources undetected. Widening it would have coupled this rule to the file that
 * also asserts wave-plan prose.
 */

/** `tools/wave` — the npm package root. */
const PACKAGE_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// The dead-citation teaching — carried in the FAILURE OUTPUT, not only in a doc
// ---------------------------------------------------------------------------

/**
 * What a dead-citation failure has to teach, at the moment it fires.
 *
 * Rules 2-5 all fail on one question — "this cited document does not exist" —
 * and the answer they wanted was never obvious from the failure itself. Both
 * live occurrences of that gap ended the same way: an author under the failing
 * constraint escaped through whatever field they still controlled. One hid a
 * real, consumer-side path inside a multi-word command span the bare-path
 * regex cannot match; the other renamed a deliberately-absent planted fixture
 * to a `.txt` extension so the extractor would stop seeing it, trading fixture
 * realism for guard silence. Neither dodge was wrong about the CONTENT, and
 * neither showed up anywhere: no gate failed, no report recorded it, so the
 * next author paid the same cost again.
 *
 * Nothing new is built for that class — the mechanism already existed. Code
 * lines are data, comment lines are citations, which is exactly how this
 * guard's OWN planted fixtures have always stayed invisible to it. What was
 * missing was discoverability at the moment of pressure, and the proximal spot
 * is this message rather than a document the author is not currently reading
 * (measured: a general clause elsewhere does not hold, a specific hint at the
 * failing spot does). Rule 2's "name its subject instead" branch is one of the
 * two answers, so this text sits BESIDE that teaching rather than replacing it
 * (ADR-0043, third decision).
 */
const DEAD_CITATION_TEACHING =
  'TWO ANSWERS ARE SANCTIONED here, and re-spelling the path at a document that was ' +
  'consolidated away is neither:\n' +
  '  (1) A FIXTURE BELONGS IN CODE LINES. Code is data; comment lines are citations. ' +
  'Every extractor in this guard reads comment lines only, so a realistic planted path ' +
  'in a string literal has always passed — move the fixture into code rather than ' +
  'trading its realism for guard silence (renaming its extension is that trade).\n' +
  '  (2) A COMMENT NAMES ITS SUBJECT, NOT THE PATH. Naming the thing — "the Worker ' +
  "brief's Report block, composed by `workerBrief()` in the wave-start skill's workflow " +
  'driver" — leaves nothing for the extractor to resolve, and that is the intended pass. ' +
  'A dead-looking path in a comment invites the reader to chase it, so this is better ' +
  'prose, not a lost capability.';

/**
 * The one failure shape every "this cited document must exist" rule fails with
 * (rules 2, 3, 5, and rule 4's three applications of them): what was found,
 * then what to do about it. Composing it in one place is what keeps the
 * teaching in the FAILURE OUTPUT of all six rather than in whichever message
 * someone remembered to update.
 */
function deadCitationFailure(subject: string, dead: readonly string[]): string {
  return `${subject}:\n${dead.join('\n')}\n\n${DEAD_CITATION_TEACHING}`;
}

/** The repository root — where a `.claude/…` citation is resolved from. */
const REPO_ROOT = join(__dirname, '..', '..', '..');

/** Source extensions the citation rule applies to. */
const SOURCE_EXTENSIONS = ['.ts', '.cjs', '.mjs', '.js'];

// ---------------------------------------------------------------------------
// Rule 1 — form-dependent paths
// ---------------------------------------------------------------------------

/**
 * Path shapes that resolve in flotilla's own checkout and nowhere else. Each
 * carries the reason it cannot travel, so a future reader adding or removing an
 * entry has to argue with the reason rather than the regex.
 *
 * Deliberately a NAMED table rather than "any token containing a slash": the
 * refusal legitimately contains `/` characters that are not paths at all (the
 * `:- / := / :?` operator list in family 2's detail is the live example), and a
 * blanket rule would fire on those while teaching nothing.
 */
const FORM_DEPENDENT_PATHS: { label: string; pattern: RegExp; why: string }[] = [
  {
    label: '.claude/…',
    pattern: /\.claude\/[A-Za-z0-9._/-]+/g,
    why: "the harness directory. In the installed form the skills and agents live in the plugin clone, and this hook has been copied to the consumer's own hooks directory — so no `.claude/…` path this repo knows is the consumer's.",
  },
  {
    label: 'tools/wave/…',
    pattern: /tools\/wave\/[A-Za-z0-9._/-]+/g,
    why: "flotilla's own vendored engine tree. A consumer's engine lives under `node_modules/@formtrieb/flotilla-engine`.",
  },
  {
    label: 'docs/…',
    pattern: /(?:^|[\s(`'"[])docs\/[A-Za-z0-9._/-]+/g,
    why: 'repo documentation (ADRs, retros). It is not in the published tarball and not in a consumer checkout — cite the ADR by NUMBER instead, which is searchable in either form.',
  },
  {
    label: '.scratch/…',
    pattern: /\.scratch\/[A-Za-z0-9._/-]+/g,
    why: "the predecessor system's scratch tree, which never existed in this repo at all.",
  },
];

/** Every form-dependent path in `text`, with the reason it cannot travel. */
function findFormDependentPaths(text: string): { label: string; match: string; why: string }[] {
  const found: { label: string; match: string; why: string }[] = [];
  for (const { label, pattern, why } of FORM_DEPENDENT_PATHS) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
      found.push({ label, match: m[0].trim(), why });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Rule 2 — skill-document citations in doc-comments
// ---------------------------------------------------------------------------

/** A citation of a markdown document under the harness directory. */
const SKILL_DOC_CITATION = /\.claude\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.md/g;

/**
 * True when `line` is comment text rather than code.
 *
 * The rule the acceptance criterion states is about doc-COMMENTS, and the
 * distinction is load-bearing rather than pedantic: a `.claude/…md` string in a
 * code line is a functional path constant (`HARNESS_DENIED_FILES` in
 * `worktree-cleanup.ts` names `.claude/loop.md`, a harness-owned file that is
 * absent here by design). Requiring those to exist would be a false positive
 * that pushes an author to "fix" working behavior.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return true;
  return false;
}

/** Every skill-document citation in `source`, with its 1-indexed line. */
function extractSkillDocCitations(source: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  source.split('\n').forEach((line, index) => {
    if (!isCommentLine(line)) return;
    for (const m of line.matchAll(new RegExp(SKILL_DOC_CITATION.source, 'g'))) {
      out.push({ path: m[0], line: index + 1 });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Rule 3 — labeled header pointers at a markdown document
// ---------------------------------------------------------------------------

/**
 * A LABELED HEADER POINTER: a comment line that opens with a short `Label:` and
 * continues straight into a repo-relative path ending in `.md`.
 *
 * Three constraints, each earning its place against a measured false positive:
 *
 * - **The label must be word-shaped** (letters, digits, spaces, hyphens — no
 *   dots, no slashes, no brackets). That is what separates a pointer line
 *   (`Playbook: …`) from ordinary prose that merely contains a colon, and from
 *   a markdown link opener (`([ADR-0030](…))`) or a footnote fixture
 *   (`[^tch-06]: …`), neither of which is a pointer this repo wrote as a
 *   citation.
 * - **The target must contain a slash**, so a bare filename mentioned in prose
 *   is not mistaken for a repo-relative path.
 * - **The target must end in `.md`.** Measured: without it the extractor
 *   reports module specifiers (`./cli`) and plain prose (`pipes/newlines`) as
 *   dead documents. A pointer at a *document* is the subject; anything else is
 *   not this rule's business.
 *
 * An optional opening backtick is tolerated because several live pointers spell
 * their target in code quotes.
 */
const HEADER_POINTER =
  /^\s*(?:\/\*+|\*+|\/\/)\s*([A-Za-z][A-Za-z0-9 -]{0,40}?):\s+`?([A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+\.md)\b/;

/** Every labeled header pointer in `source`, with its 1-indexed line. */
function extractHeaderPointers(source: string): { label: string; path: string; line: number }[] {
  const out: { label: string; path: string; line: number }[] = [];
  source.split('\n').forEach((line, index) => {
    if (!isCommentLine(line)) return;
    const m = HEADER_POINTER.exec(line);
    if (m) out.push({ label: m[1], path: m[2], line: index + 1 });
  });
  return out;
}

/**
 * The ten pointers this row removed, verbatim as they stood in the five shipped
 * modules. They are the negative control that keeps rule 3 able to fail: if the
 * extractor ever stops finding these, it has stopped finding anything.
 */
const REMOVED_HEADER_POINTERS: { module: string; line: string }[] = [
  {
    module: 'worker-report-schema.ts',
    line: ' * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md',
  },
  {
    module: 'worker-report-schema.ts',
    line: ' * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 1, US-3)',
  },
  {
    module: 'reviewer-verdict-schema.ts',
    line: ' * Canonical spec: .scratch/wave-orchestration/issues/61-wave-start-workflow-driver.md',
  },
  {
    module: 'reviewer-verdict-schema.ts',
    line: ' * PRD source:     .scratch/wave-orchestration/wave-start-workflow-migration-PRD.md (§Solution 2-3, US-4/5)',
  },
  {
    module: 'stop-condition-state-machine.ts',
    line: ' * PRD source: .scratch/wave-orchestration/PRD.md §L1',
  },
  {
    module: 'stop-condition-state-machine.ts',
    line: ' * Playbook: docs/agents/wave-playbook.md §2 (Stop-Conditions)',
  },
  {
    module: 'closed-by.ts',
    line: ' * Canonical spec: .scratch/wave-orchestration/issues/55-closed-by-classifier.md',
  },
  {
    module: 'closed-by.ts',
    line: ' * Parent PRD:     .scratch/wave-orchestration/wave-close-skill-PRD.md (stories 21, 3, 4, 6)',
  },
  {
    module: 'verdict-to-event.ts',
    line: ' * Canonical spec: .scratch/wave-orchestration/issues/64-verdict-to-event-adapter.md',
  },
  {
    module: 'verdict-to-event.ts',
    line: ' * Audit source:   .scratch/wave-orchestration/autonomy-audit-2026-06-03.md §2 (G3)',
  },
];

// ---------------------------------------------------------------------------
// Rule 5 — unlabeled prose citations ("Spec/Schema is canonical in …",
// "by schema (…)") — the shape rules 2 and 3 both walked past a second time
// ---------------------------------------------------------------------------

/**
 * The two trigger phrases for an UNLABELED PROSE CITATION: prose, not a
 * `Label:` header line, naming a path as the authoritative source for a
 * module's spec or schema.
 *
 * Grepping `canonical in` and `by schema` (case-insensitive) across every
 * shipped `.ts` source under `src/` found exactly the six lines this rule was
 * written to catch, and nowhere else — which is what keeps this a NAMED pair
 * of phrases rather than a keyword search on "canonical" or "schema" alone.
 * Both words appear routinely elsewhere in these same files with no path
 * anywhere nearby (`canonical issueId`, `canonical numeric-string key`,
 * `Gate-1 schema-membership check`), and a bare-keyword rule would have fired
 * on every one of them.
 */
const CANONICAL_CITATION_TRIGGER = /\b(?:Spec|Schema)\s+is\s+canonical\s+in\b|\bby\s+schema\s*\(/gi;

/** A repo-relative path token ending in `.md`, with an optional wrapping backtick. */
const MD_PATH_TOKEN = /`?([A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+\.md)`?/g;

/**
 * Every unlabeled prose citation in `source`, with the 1-indexed line its
 * trigger phrase starts on.
 *
 * The scan window runs from the trigger to the next blank `*` comment line or
 * the comment's own close (the star-slash), whichever comes first — never
 * past it. That
 * is what lets a citation naming two paths across a line-wrap (`dor-gate.ts`,
 * `wave-md-rw.ts`) read as one citation, while a trigger with no internal
 * blank line before its comment closes (`header-parser.ts`'s second
 * occurrence) does not run on into the next doc-comment down the file and
 * start collecting paths that were never part of the citation. A template
 * path segment (`.scratch/<slug>/issues/<NN>-<slug>.md`) never satisfies
 * {@link MD_PATH_TOKEN} — `<` and `>` sit outside its character class — so a
 * paragraph merely illustrating the tree's shape is not mistaken for a
 * citation of a document in it.
 *
 * Like rules 2 and 3, this only reads comment lines: the trigger's own source
 * line must classify as a comment via {@link isCommentLine}, or the match is
 * discarded.
 */
function extractCanonicalProseCitations(source: string): { path: string; line: number }[] {
  const out: { path: string; line: number }[] = [];
  const lines = source.split('\n');
  const triggerRe = new RegExp(CANONICAL_CITATION_TRIGGER.source, CANONICAL_CITATION_TRIGGER.flags);
  for (const trigger of source.matchAll(triggerRe)) {
    const start = trigger.index ?? 0;
    const startLine = source.slice(0, start).split('\n').length;
    if (!isCommentLine(lines[startLine - 1] ?? '')) continue;

    const rest = source.slice(start);
    const blankLine = /\n[ \t]*\*[ \t]*\n/.exec(rest);
    const commentClose = /\*\//.exec(rest);
    const boundaries = [blankLine?.index, commentClose?.index].filter(
      (i): i is number => i !== undefined,
    );
    const end = boundaries.length > 0 ? Math.min(...boundaries) : rest.length;
    const window = rest.slice(0, end);

    const pathRe = new RegExp(MD_PATH_TOKEN.source, 'g');
    for (const m of window.matchAll(pathRe)) {
      out.push({ path: m[1], line: startLine });
    }
  }
  return out;
}

/**
 * The six unlabeled prose citations this row removed, verbatim as they stood
 * in the five shipped modules (`header-parser.ts` carried it twice). The
 * negative control that keeps rule 5 able to fail: if the extractor ever
 * stops finding these, it has stopped finding anything.
 */
const REMOVED_CANONICAL_CITATIONS: { module: string; line: string; paths: string[] }[] = [
  {
    module: 'conflict-map.ts',
    line: ' * Spec is canonical in `.scratch/wave-orchestration/PRD.md` §S2 + issue #07.',
    paths: ['.scratch/wave-orchestration/PRD.md'],
  },
  {
    module: 'dor-gate.ts',
    line:
      ' * Spec is canonical in `.scratch/wave-orchestration/PRD.md` §S2 and in\n' +
      ' * `.scratch/wave-orchestration/issues/05-wave-validate-skill.md`. The gates:',
    paths: [
      '.scratch/wave-orchestration/PRD.md',
      '.scratch/wave-orchestration/issues/05-wave-validate-skill.md',
    ],
  },
  {
    module: 'header-parser.ts',
    line: ' * Schema is canonical in docs/agents/issue-tracker.md §Wave-Eligibility.',
    paths: ['docs/agents/issue-tracker.md'],
  },
  {
    module: 'header-parser.ts',
    line: ' * The Header-Block is, by schema (docs/agents/issue-tracker.md §Wave-Eligibility),',
    paths: ['docs/agents/issue-tracker.md'],
  },
  {
    module: 'merge-order.ts',
    line: ' * Spec is canonical in `.scratch/wave-orchestration/issues/44-...md`.',
    paths: ['.scratch/wave-orchestration/issues/44-...md'],
  },
  {
    module: 'wave-md-rw.ts',
    line:
      ' * Spec is canonical in\n' +
      ' * `.scratch/wave-orchestration/issues/54-wave-md-rw-shared-spine-reader-writer.md`.',
    paths: ['.scratch/wave-orchestration/issues/54-wave-md-rw-shared-spine-reader-writer.md'],
  },
];

// ---------------------------------------------------------------------------
// Rule 4 — the spec-file surface (the decided extension; see the header)
// ---------------------------------------------------------------------------

/**
 * The one file exempt from rule 4, and the whole of the exemption.
 *
 * A guard cannot be its own subject: this file plants dead citations as
 * fixtures and its prose has to NAME the absent paths whose absence it
 * asserts. Everything else under `src/` is in scope.
 */
const RULE_4_EXEMPT_SPECS = ['shipped-citation-guard.spec.ts'];

// ---------------------------------------------------------------------------
// The packed artifact
// ---------------------------------------------------------------------------

let workDir = '';
/** The extracted tarball root — `<tmp>/package`, exactly what an install lays down. */
let shippedRoot = '';

/** Every file in the extracted tarball, as tarball-relative paths. */
function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'flotilla-pack-'));

  // `npm pack` runs no lifecycle scripts in this package (there is no `prepack`
  // or `prepare`), so this is a pure packaging step: local, offline, and the
  // exact file set `npm publish` would upload.
  const packed = spawnSync('npm', ['pack', '--json', '--pack-destination', workDir], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
  });
  // Fail LOUD, never skip: a guard observed only as skipped has been proven not
  // to run, which is not the same as proven to pass.
  expect(packed.error, `npm pack failed to spawn: ${packed.error?.message}`).toBeUndefined();
  expect(packed.status, `npm pack exited ${packed.status}\n${packed.stderr}`).toBe(0);

  const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0].filename;
  const tarball = join(workDir, filename);
  expect(existsSync(tarball), `packed tarball missing at ${tarball}`).toBe(true);

  const extracted = spawnSync('tar', ['-xzf', tarball, '-C', workDir], {
    encoding: 'utf-8',
    timeout: 120_000,
  });
  expect(extracted.status, `tar exited ${extracted.status}\n${extracted.stderr}`).toBe(0);

  shippedRoot = join(workDir, 'package');
  expect(existsSync(shippedRoot), `extracted package root missing at ${shippedRoot}`).toBe(true);
}, 180_000);

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the packed tarball is the subject under test', () => {
  it('ships the echo-guard hook — the premise the emitted-refusal rule rests on', () => {
    expect(existsSync(join(shippedRoot, 'hooks', 'echo-guard.cjs'))).toBe(true);
  });

  it('ships the engine sources whose doc-comments the citation rule scans', () => {
    const shipped = walk(shippedRoot);
    expect(shipped).toContain('src/worker-report-schema.ts');
    expect(shipped).toContain('src/reviewer-verdict-schema.ts');
    expect(shipped).toContain('src/stop-condition-state-machine.ts');
    // Spec files are excluded by the package's own `files` manifest, so the
    // citation rule genuinely scans the consumer-visible surface and nothing
    // more. Asserted rather than assumed — if specs ever start shipping, the
    // rule's scope silently widens and this line is where that surfaces.
    expect(shipped.some((p) => p.endsWith('.spec.ts'))).toBe(false);
  });
});

describe('rule 1 — the shipped guard emits no path only the source form resolves', () => {
  /** The two `<VAR>_CMD` Lookup-Commands flotilla configures (ADR-0029). */
  const GITHUB_LOOKUP = 'security find-generic-password -a $USER -s flotilla-github-token -w';
  const CONFIGURED_ENV = { GITHUB_TOKEN_CMD: GITHUB_LOOKUP };

  /** Run the hook AS SHIPPED and return its refusal. */
  function refuse(command: string): { code: number; stderr: string } {
    const result = spawnSync(process.execPath, [join(shippedRoot, 'hooks', 'echo-guard.cjs')], {
      input: JSON.stringify({
        session_id: 'spec',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      }),
      encoding: 'utf-8',
      timeout: 30_000,
      // Hermetic: families 1 and 4 read the consumer's `<VAR>_CMD` entries at
      // hook runtime, so inheriting the ambient environment would make the
      // assertions depend on the machine.
      env: { PATH: process.env.PATH ?? '', ...CONFIGURED_ENV },
    });
    return { code: result.status ?? -1, stderr: result.stderr ?? '' };
  }

  /** One command per family, so no single family's detail string can hide. */
  const PER_FAMILY: { family: string; command: string }[] = [
    { family: 'credential-name expansion', command: 'echo $GITHUB_TOKEN' },
    { family: 'value-substituting expansion', command: 'echo "${DEPLOY_TARGET:-none}"' },
    { family: 'whole-environment dump', command: 'printenv' },
    { family: 'wrapped Lookup-Command', command: `echo $(${GITHUB_LOOKUP})` },
  ];

  it.each(PER_FAMILY)('$family — its refusal carries no form-dependent path', ({ family, command }) => {
    const { code, stderr } = refuse(command);
    expect(code).toBe(2);
    expect(stderr).toContain(family);
    expect(findFormDependentPaths(stderr)).toEqual([]);
  });

  it('a refusal firing ALL FOUR families at once is clean — the union covers every emitted string', () => {
    const { code, stderr } = refuse(
      `printenv; echo $GITHUB_TOKEN; echo "\${DEPLOY_TARGET:-none}"; ${GITHUB_LOOKUP}`,
    );
    expect(code).toBe(2);
    // Coverage proof, not decoration: the message is a static frame plus one
    // detail line per violation, so a refusal carrying all four family details
    // exercises every string `rejectionMessage()` can ever emit. Without this
    // assertion the scan below could pass by simply not having fired.
    for (const { family } of PER_FAMILY) expect(stderr).toContain(family);

    const found = findFormDependentPaths(stderr);
    expect(
      found,
      found.map((f) => `${f.label}: ${f.match} — ${f.why}`).join('\n'),
    ).toEqual([]);
  });

  it('still teaches: why it was rejected, what to do instead, and that it matched command TEXT', () => {
    // The pointer was dropped, so the message has to stand on its own. These are
    // the three things a stranger's first refusal must tell them.
    const { stderr } = refuse('printenv');
    // Why.
    expect(stderr).toContain('session transcript on disk');
    expect(stderr).toContain('rotating the credential');
    // What to do instead — both sanctioned forms, plus the rule for the roles
    // that should run neither.
    expect(stderr).toContain('[ -n "$VAR" ] && echo set');
    expect(stderr).toContain('credential-probe --all');
    expect(stderr).toContain('worktree-isolated role runs NEITHER');
    // What the guard actually matched: the command's text, not its behavior.
    expect(stderr).toContain('COMMAND TEXT');
    expect(stderr).toContain('speed bump');
  });

  it('NEGATIVE CONTROL — the detector fires on the exact line that was removed', () => {
    // The refusal's former last line, verbatim. If this ever comes back green,
    // the rule above has stopped being able to fail and is worth nothing.
    const regression =
      '[echo-guard] BLOCKED — Convention 8 (secret-safe tool output).\n' +
      'Full doctrine: .claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md\n';
    const found = findFormDependentPaths(regression);
    expect(found.map((f) => f.match)).toContain(
      '.claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md',
    );
  });

  it.each(FORM_DEPENDENT_PATHS.map((p) => p.label))(
    'NEGATIVE CONTROL — %s is detected, so every row of the table can fail',
    (label) => {
      const sample: Record<string, string> = {
        '.claude/…': 'see .claude/skills/wave-shared/SKILL.md for more',
        'tools/wave/…': 'see tools/wave/hooks/echo-guard.cjs for more',
        'docs/…': 'see docs/adr/0029-credentials.md for more',
        '.scratch/…': 'see .scratch/wave-orchestration/PRD.md for more',
      };
      expect(findFormDependentPaths(sample[label]).map((f) => f.label)).toContain(label);
    },
  );

  it('does NOT fire on the non-path slashes the refusal legitimately contains', () => {
    // Family 2's detail names the shell operators `:- / := / :?`; the scope note
    // names `permissions.deny`. A blanket "any token with a slash" rule would
    // block both, which is why the table above is named rather than generic.
    expect(findFormDependentPaths('the :- / := / :? operators')).toEqual([]);
    expect(findFormDependentPaths('the tracked permissions.deny entries')).toEqual([]);
  });
});

describe('rule 2 — no shipped doc-comment cites a skill document that does not exist', () => {
  it('every skill-document citation in a shipped engine source resolves', () => {
    const sources = walk(shippedRoot).filter((p) => SOURCE_EXTENSIONS.some((e) => p.endsWith(e)));
    // The scan is worthless if it found nothing to scan.
    expect(sources.length).toBeGreaterThan(20);

    const dead: string[] = [];
    let checked = 0;
    for (const rel of sources) {
      const body = readFileSync(join(shippedRoot, rel), 'utf-8');
      for (const { path, line } of extractSkillDocCitations(body)) {
        checked += 1;
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} → ${path}`);
      }
    }

    // Citations that resolve are expected to exist — this pins that the
    // extractor is still finding them rather than silently matching nothing.
    expect(checked).toBeGreaterThan(0);
    expect(
      dead,
      deadCitationFailure(
        'shipped doc-comments citing a skill document that exists under no spelling',
        dead,
      ),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL — a dead citation in a doc-comment is found', () => {
    const planted = '/**\n * Mirrors: .claude/skills/wave-shared/references/worker-brief-template.md §Block 5\n */\n';
    const found = extractSkillDocCitations(planted);
    expect(found.map((c) => c.path)).toEqual([
      '.claude/skills/wave-shared/references/worker-brief-template.md',
    ]);
    expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(false);
  });

  it('NEGATIVE CONTROL — the `references/` vs `reference/` misspelling class is caught by resolution, not by spelling', () => {
    // Both spellings of the three consolidated documents are dead, so a guard
    // that merely corrected `references/` to `reference/` would swap one dead
    // path for another and stay green. Resolution is what makes that impossible.
    for (const spelling of ['reference', 'references']) {
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-shared/${spelling}/worker-brief-template.md`)),
      ).toBe(false);
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-shared/${spelling}/reviewer-brief-template.md`)),
      ).toBe(false);
      expect(
        existsSync(join(REPO_ROOT, `.claude/skills/wave-start/${spelling}/stop-condition-handling.md`)),
      ).toBe(false);
    }
  });

  it('a citation that names its subject instead of a path has nothing to resolve — the intended pass', () => {
    const named =
      "/**\n * Mirrors: the Worker brief's Report block — composed by `workerBrief()` in the\n" +
      " *          wave-start skill's workflow driver.\n */\n";
    expect(extractSkillDocCitations(named)).toEqual([]);
  });

  it('CARVE-OUT CONTROL — a `.claude/…md` string in CODE is a path constant, not a citation', () => {
    // `worktree-cleanup.ts`'s `HARNESS_DENIED_FILES` names `.claude/loop.md`, a
    // harness-owned file this repo legitimately does not have. It is data the
    // sweep matches against, and it is explicitly out of this rule's scope.
    expect(extractSkillDocCitations("const HARNESS_DENIED = ['.claude/loop.md'];\n")).toEqual([]);
    expect(existsSync(join(REPO_ROOT, '.claude/loop.md'))).toBe(false);
    // ...while the same path inside a doc-comment IS a citation.
    expect(extractSkillDocCitations(' * see .claude/loop.md\n').map((c) => c.path)).toEqual([
      '.claude/loop.md',
    ]);
  });
});

describe('rule 3 — no shipped header pointer aims at a document that does not exist', () => {
  it('every labeled header pointer in a shipped engine source resolves — the count is ZERO', () => {
    const sources = walk(shippedRoot).filter((p) => SOURCE_EXTENSIONS.some((e) => p.endsWith(e)));
    expect(sources.length).toBeGreaterThan(20);

    const dead: string[] = [];
    let checked = 0;
    for (const rel of sources) {
      const body = readFileSync(join(shippedRoot, rel), 'utf-8');
      for (const { label, path, line } of extractHeaderPointers(body)) {
        checked += 1;
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} [${label}] → ${path}`);
      }
    }

    // The scan proves nothing if the extractor matched nothing at all: several
    // pointers in shipped sources DO resolve (`Mirrors:` and `Source:` both
    // aim at `.claude/agents/wave-reviewer.md`, which is real and maintained),
    // and finding them is what shows the rule is still looking.
    expect(checked).toBeGreaterThan(0);
    expect(
      dead,
      deadCitationFailure(
        'shipped header pointers aiming at a markdown document that exists under no ' +
          'spelling (ten of these were removed by the row that added this rule)',
        dead,
      ),
    ).toEqual([]);
  });

  it.each(REMOVED_HEADER_POINTERS)(
    'NEGATIVE CONTROL — the pointer removed from $module is still detected and still dead',
    ({ line }) => {
      const found = extractHeaderPointers(`/**\n${line}\n */\n`);
      expect(found, `the extractor no longer sees: ${line}`).toHaveLength(1);
      expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(false);
    },
  );

  it('NEGATIVE CONTROL — the removed set was exactly TEN, across five modules', () => {
    // The count this row's acceptance criterion names, pinned so "zero now"
    // cannot quietly become "zero because the extractor broke".
    expect(REMOVED_HEADER_POINTERS).toHaveLength(10);
    expect(new Set(REMOVED_HEADER_POINTERS.map((p) => p.module)).size).toBe(5);
    // Every one of them aimed at a scratch tree or an agents-docs tree, and
    // neither tree exists in this repo at all — which is what made them dead
    // for every reader, not merely form-dependent for some.
    for (const { line } of REMOVED_HEADER_POINTERS) {
      expect(line).toMatch(/(?:\.scratch|docs\/agents)\//);
    }
    expect(existsSync(join(REPO_ROOT, '.scratch'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'docs/agents'))).toBe(false);
  });

  it('does NOT fire on the shapes that only look like a header pointer', () => {
    // Each of these was measured as a false positive of a looser rule, and each
    // is the reason for one of `HEADER_POINTER`'s three constraints.
    expect(extractHeaderPointers(' * Costs the barrel nothing at load time: ./cli\n')).toEqual([]);
    expect(extractHeaderPointers(' * Escape a markdown-table cell: pipes/newlines\n')).toEqual([]);
    expect(extractHeaderPointers(' * ([ADR-0030](../../../docs/adr/0030-x.md))\n')).toEqual([]);
    expect(extractHeaderPointers(' *   [^tch-06]: `.scratch/x/issues/06-e2e.md`\n')).toEqual([]);
    // ...and a pointer that names its subject instead of pathing it — the
    // intended repair, and the shape every one of the ten was rewritten into.
    expect(
      extractHeaderPointers(
        " * Provenance: the wave-start workflow-driver migration, planned in the\n" +
          " *             predecessor system flotilla was seeded from.\n",
      ),
    ).toEqual([]);
  });

  it('DOES fire on a live pointer shape that resolves — proving it reads real lines, not just fixtures', () => {
    const real = ' * Mirrors:        .claude/agents/wave-reviewer.md §"Output schema", restated at\n';
    const found = extractHeaderPointers(real);
    expect(found.map((p) => p.path)).toEqual(['.claude/agents/wave-reviewer.md']);
    expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(true);
  });
});

describe('rule 5 — no shipped module carries an unlabeled canonical/schema prose citation aiming at a path that does not resolve', () => {
  it('every unlabeled prose citation in a shipped engine source resolves — the count is ZERO', () => {
    const sources = walk(shippedRoot).filter((p) => SOURCE_EXTENSIONS.some((e) => p.endsWith(e)));
    expect(sources.length).toBeGreaterThan(20);

    const dead: string[] = [];
    for (const rel of sources) {
      const body = readFileSync(join(shippedRoot, rel), 'utf-8');
      for (const { path, line } of extractCanonicalProseCitations(body)) {
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} → ${path}`);
      }
    }

    // Unlike rules 2-4, this shape's live population in the shipped tree is
    // ZERO after this row — the six citations it removed were the entire
    // population (confirmed: `canonical in` / `by schema` appear nowhere else
    // in `src/`, see CANONICAL_CITATION_TRIGGER's own doc-comment). So this
    // scan cannot prove the extractor is still looking by finding something
    // organically; that proof is the negative controls below instead — the
    // extractor still resolving the exact six removed lines, and still firing
    // on a live synthetic citation.
    expect(
      dead,
      deadCitationFailure(
        'shipped modules carrying an unlabeled canonical/schema prose citation aiming at ' +
          'a path that exists under no spelling (six of these were removed by the row ' +
          'that added this rule)',
        dead,
      ),
    ).toEqual([]);
  });

  it.each(REMOVED_CANONICAL_CITATIONS)(
    'NEGATIVE CONTROL — the citation removed from $module is still detected and still dead',
    ({ line, paths }) => {
      const found = extractCanonicalProseCitations(`/**\n${line}\n */\n`);
      expect(found.map((f) => f.path), `the extractor no longer sees: ${line}`).toEqual(paths);
      for (const { path } of found) {
        expect(existsSync(join(REPO_ROOT, path)), `${path} unexpectedly resolved`).toBe(false);
      }
    },
  );

  it('NEGATIVE CONTROL — the removed set was exactly SIX, across five modules', () => {
    // The count this row's acceptance criterion names, pinned so "zero now"
    // cannot quietly become "zero because the extractor broke".
    expect(REMOVED_CANONICAL_CITATIONS).toHaveLength(6);
    const modules = REMOVED_CANONICAL_CITATIONS.map((c) => c.module);
    expect(new Set(modules).size).toBe(5);
    // header-parser.ts is the one module carrying it twice.
    expect(modules.filter((m) => m === 'header-parser.ts')).toHaveLength(2);
    for (const { paths } of REMOVED_CANONICAL_CITATIONS) {
      for (const path of paths) {
        expect(path).toMatch(/(?:\.scratch|docs\/agents)\//);
        expect(existsSync(join(REPO_ROOT, path))).toBe(false);
      }
    }
    expect(existsSync(join(REPO_ROOT, '.scratch'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'docs/agents'))).toBe(false);
  });

  it('does NOT fire on the illustrative doc-path examples the DoR-gate module keeps', () => {
    // Verified NOT in this class: `dor-gate.ts` uses a docs path as an
    // EXAMPLE of a consumer's own doc path, inside prose about the Files
    // gate's basename-fallback coverage rule — not a citation of this repo's
    // own spec/schema. Read verbatim from the real file (both occurrences),
    // so a future edit that widens either fixture re-triggers this control.
    const body = readFileSync(join(PACKAGE_ROOT, 'src/dor-gate.ts'), 'utf-8');
    expect(body).toContain('(e.g. `docs/agents/wave-playbook.md`)');
    expect(body).toContain('(`docs/agents/wave-playbook.md`)');
    expect(extractCanonicalProseCitations(body)).toEqual([]);
  });

  it('DOES fire on a live citation shape that resolves — proving it reads real lines, not just fixtures', () => {
    const real = ' * Spec is canonical in `.claude/agents/wave-reviewer.md` §"Output schema".\n';
    const found = extractCanonicalProseCitations(real);
    expect(found.map((c) => c.path)).toEqual(['.claude/agents/wave-reviewer.md']);
    expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(true);
  });

  it('a citation that names its subject instead of a path has nothing to resolve — the intended pass', () => {
    // The shape every one of the six was rewritten into — see the five
    // repaired modules' own `Provenance:` lines.
    const named =
      ' * Provenance:     the wave-orchestration PRD\'s §S2 (issue #07), planned in\n' +
      ' *                 the predecessor wave-orchestration system flotilla was\n' +
      ' *                 seeded from.\n';
    expect(extractCanonicalProseCitations(named)).toEqual([]);
  });
});

describe('rule 4 — a spec file is held to the same resolution rule (the DECIDED extension)', () => {
  /** Every spec file under the package's `src/`, as package-relative paths. */
  function specFiles(): string[] {
    return walk(join(PACKAGE_ROOT, 'src'))
      .map((rel) => `src/${rel}`)
      .filter((rel) => rel.endsWith('.spec.ts'))
      .filter((rel) => !RULE_4_EXEMPT_SPECS.some((name) => rel.endsWith(name)));
  }

  it('reads the REPO tree, not the tarball — spec files are not in the shipped artifact', () => {
    // Rules 1-3 pack first, on purpose. Rule 4 cannot: its subject is excluded
    // from the package's own `files` manifest. Stating that here keeps the
    // difference a decision rather than an inconsistency someone later
    // "corrects".
    expect(walk(shippedRoot).some((p) => p.endsWith('.spec.ts'))).toBe(false);
    expect(specFiles().length).toBeGreaterThan(20);
  });

  it('every skill-document citation in a spec doc-comment resolves', () => {
    const dead: string[] = [];
    for (const rel of specFiles()) {
      const body = readFileSync(join(PACKAGE_ROOT, rel), 'utf-8');
      for (const { path, line } of extractSkillDocCitations(body)) {
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} → ${path}`);
      }
    }
    expect(
      dead,
      deadCitationFailure(
        'spec doc-comments citing a document that exists under no spelling. A spec is ' +
          'the first thing an editor of its module reads, which is why this rule exists ' +
          "(see this file's \"The spec-file question\" note)",
        dead,
      ),
    ).toEqual([]);
  });

  it('every labeled header pointer in a spec doc-comment resolves', () => {
    const dead: string[] = [];
    for (const rel of specFiles()) {
      const body = readFileSync(join(PACKAGE_ROOT, rel), 'utf-8');
      for (const { label, path, line } of extractHeaderPointers(body)) {
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} [${label}] → ${path}`);
      }
    }
    expect(dead, deadCitationFailure('dead header pointers in spec files', dead)).toEqual([]);
  });

  it('every unlabeled prose citation in a spec doc-comment resolves', () => {
    const dead: string[] = [];
    for (const rel of specFiles()) {
      const body = readFileSync(join(PACKAGE_ROOT, rel), 'utf-8');
      for (const { path, line } of extractCanonicalProseCitations(body)) {
        if (!existsSync(join(REPO_ROOT, path))) dead.push(`${rel}:${line} → ${path}`);
      }
    }
    expect(
      dead,
      deadCitationFailure('dead unlabeled prose citations in spec files', dead),
    ).toEqual([]);
  });

  it('the reflexivity exemption is exactly ONE file, and it is this one', () => {
    // The exemption is the only hole rule 4 has. Pinning its size is what keeps
    // "exempt the file that fails" from becoming the way this rule is satisfied.
    expect(RULE_4_EXEMPT_SPECS).toEqual(['shipped-citation-guard.spec.ts']);
    expect(existsSync(join(PACKAGE_ROOT, 'src', RULE_4_EXEMPT_SPECS[0]))).toBe(true);
    expect(specFiles().some((rel) => rel.endsWith(RULE_4_EXEMPT_SPECS[0]))).toBe(false);
  });

  it('NEGATIVE CONTROL — a dead citation planted in a NON-exempt spec is found', () => {
    // The exact occurrence this row repaired, as it stood in
    // `stop-condition-state-machine.spec.ts`.
    const planted =
      '/**\n * Covers all 143 cells of the 11-state × 13-event matrix documented in\n' +
      ' * .claude/skills/wave-start/references/stop-condition-handling.md §Fixture-matrix.\n */\n';
    const found = extractSkillDocCitations(planted);
    expect(found.map((c) => c.path)).toEqual([
      '.claude/skills/wave-start/references/stop-condition-handling.md',
    ]);
    expect(existsSync(join(REPO_ROOT, found[0].path))).toBe(false);
    // ...and the repaired spec no longer carries it, under either spelling.
    const repaired = readFileSync(join(PACKAGE_ROOT, 'src/stop-condition-state-machine.spec.ts'), 'utf-8');
    expect(repaired).not.toContain('stop-condition-handling.md');
  });
});

describe('the dead-citation FAILURE OUTPUT teaches the two sanctioned answers (ADR-0043)', () => {
  /**
   * The message a failing `expect(…)` really carries, read off the thrown error
   * rather than off the string handed in. That difference is the whole point:
   * the teaching has to reach the author AT THE FAILURE, which is a claim about
   * the output, not about a constant sitting in this file.
   */
  function observedFailure(run: () => void): string {
    try {
      run();
    } catch (err) {
      return String((err as Error)?.message ?? err);
    }
    throw new Error('expected the assertion to FAIL — this control proves nothing if it passes');
  }

  it('a real dead citation fails with both answers in the message an author actually sees', () => {
    // Same extractor, same resolution question, same failure composer as rule 2's
    // live assertion — only the corpus is a plant.
    const planted =
      '/**\n * Mirrors: .claude/skills/wave-shared/references/worker-brief-template.md §Block 5\n */\n';
    const dead = extractSkillDocCitations(planted)
      .filter(({ path }) => !existsSync(join(REPO_ROOT, path)))
      .map(({ path, line }) => `planted:${line} → ${path}`);
    expect(dead).toHaveLength(1);

    const observed = observedFailure(() => {
      expect(
        dead,
        deadCitationFailure(
          'shipped doc-comments citing a skill document that exists under no spelling',
          dead,
        ),
      ).toEqual([]);
    });

    // What was found…
    expect(observed).toContain(dead[0]);
    // …and, in the same breath, what the two sanctioned answers are.
    expect(observed).toContain('A FIXTURE BELONGS IN CODE LINES');
    expect(observed).toContain('A COMMENT NAMES ITS SUBJECT, NOT THE PATH');
  });

  it('the teaching names the fixture answer, the subject answer, and rules out the extension dodge', () => {
    // The second occurrence's actual workaround was an extension rename, so the
    // message says that trade out loud rather than leaving it to be reinvented.
    expect(DEAD_CITATION_TEACHING).toMatch(/code lines/i);
    expect(DEAD_CITATION_TEACHING).toMatch(/comment lines are citations/i);
    expect(DEAD_CITATION_TEACHING).toMatch(/renaming its extension/i);
    expect(DEAD_CITATION_TEACHING).toMatch(/names its subject/i);
    // …and it teaches without citing anything itself: a message that carried a
    // form-dependent path would be the very defect rule 1 exists to catch.
    expect(findFormDependentPaths(DEAD_CITATION_TEACHING)).toEqual([]);
  });

  it('rule 2\'s "name its subject" branch is unchanged — the teaching sits beside the rule, never loosens it', () => {
    // Strictness is not what moved. A dead citation in a comment still fails,
    // and a subject-naming comment still passes, exactly as before.
    const stillDead = extractSkillDocCitations(
      ' * see .claude/skills/wave-shared/references/worker-brief-template.md\n',
    );
    expect(stillDead).toHaveLength(1);
    expect(existsSync(join(REPO_ROOT, stillDead[0].path))).toBe(false);
    expect(
      extractSkillDocCitations(
        " * Mirrors: the Worker brief's Report block, composed by `workerBrief()`.\n",
      ),
    ).toEqual([]);
  });
});

describe('CARVE-OUT CONTROLS — the deliberate non-members stay out of every rule\'s reach', () => {
  it('worktree-cleanup.ts\'s functional path constants are code, and no rule touches them', () => {
    // These are DATA the sweep matches against — including `.claude/loop.md`, a
    // harness-owned file that legitimately does not exist here. A naive
    // path-resolution scan goes red on them; the comment-line classifier is the
    // whole of what keeps them out, so this reads the REAL file rather than a
    // synthetic sample of it.
    const rel = 'src/worktree-cleanup.ts';
    const body = readFileSync(join(PACKAGE_ROOT, rel), 'utf-8');
    expect(body).toContain("'.claude/loop.md'");
    expect(existsSync(join(REPO_ROOT, '.claude/loop.md'))).toBe(false);

    for (const { path } of extractSkillDocCitations(body)) {
      expect(existsSync(join(REPO_ROOT, path)), `${rel} cites ${path}`).toBe(true);
    }
    for (const { path } of extractHeaderPointers(body)) {
      expect(existsSync(join(REPO_ROOT, path)), `${rel} points at ${path}`).toBe(true);
    }
  });

  it('this file\'s own planted fixtures sit in CODE lines, invisible to all three extractors', () => {
    // The fixtures are deliberately dead paths. They must stay dead AND stay
    // unreachable — if a future edit moved one into a doc-comment, the rules
    // would start failing on the guard's own evidence.
    const body = readFileSync(join(PACKAGE_ROOT, 'src/shipped-citation-guard.spec.ts'), 'utf-8');

    // Planted for their DEADNESS — each is the target of a negative control
    // that would stop meaning anything if the document came back.
    const plantedDead = [
      '.claude/skills/wave-shared/references/worker-brief-template.md',
      '.scratch/wave-orchestration/PRD.md',
    ];
    // Planted for its FORM-DEPENDENCE, not its deadness: rule 1's regression
    // fixture is the refusal's former last line, whose document is real and
    // maintained. Asserting it exists is what keeps the two reasons distinct —
    // a fixture that fails for the wrong reason teaches the wrong lesson.
    const plantedLive = ['.claude/skills/wave-shared/reference/convention-08-secret-safe-briefs.md'];

    for (const p of [...plantedDead, ...plantedLive]) {
      expect(body, `fixture went missing: ${p}`).toContain(p);
    }
    for (const p of plantedDead) {
      expect(existsSync(join(REPO_ROOT, p)), `fixture stopped being dead: ${p}`).toBe(false);
    }
    for (const p of plantedLive) {
      expect(existsSync(join(REPO_ROOT, p)), `fixture stopped resolving: ${p}`).toBe(true);
    }

    const inComments = [
      ...extractSkillDocCitations(body).map((c) => c.path),
      ...extractHeaderPointers(body).map((c) => c.path),
      ...extractCanonicalProseCitations(body).map((c) => c.path),
    ];
    for (const p of [...plantedDead, ...plantedLive]) expect(inComments).not.toContain(p);
  });

  it('merge-order.spec.ts\'s conflict-map glob fixtures are fixtures, not citations', () => {
    // That spec uses `.scratch/…` document names as conflict-map GLOB inputs.
    // They are values under test, and they are reached by no rule here: rules
    // 1-3 and 5 read the tarball (which holds no spec file) and rule 4's
    // extractors read comment lines only.
    const rel = 'src/merge-order.spec.ts';
    const body = readFileSync(join(PACKAGE_ROOT, rel), 'utf-8');
    expect(body).toContain('.scratch/wave-orchestration/issues/');
    expect(walk(shippedRoot)).not.toContain('src/merge-order.spec.ts');
    for (const { path } of extractSkillDocCitations(body)) {
      expect(existsSync(join(REPO_ROOT, path)), `${rel} cites ${path}`).toBe(true);
    }
    for (const { path } of extractHeaderPointers(body)) {
      expect(existsSync(join(REPO_ROOT, path)), `${rel} points at ${path}`).toBe(true);
    }
    expect(extractCanonicalProseCitations(body)).toEqual([]);
  });
});
