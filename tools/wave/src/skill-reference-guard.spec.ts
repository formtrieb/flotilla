/**
 * skill-reference-guard.spec.ts — the anchor-aware tripwire over every shipped
 * skill/agent markdown file (ADR-0031).
 *
 * A Claude-Code plugin consumer receives the **full repository at a pinned SHA**
 * (`.claude-plugin/marketplace.json` declares `"source": "./"`), so skill
 * references do not fail by absence from the package — `docs/adr/`,
 * `docs/retros/` and `tools/wave/src/` all ship. What fails is the **resolution
 * anchor**: a consumer session's cwd is the *consumer* repo, never the clone.
 * ADR-0031 therefore splits every file-path-shaped reference into three classes,
 * each judged against its own anchor, and this spec is the guard that keeps all
 * three predicates true:
 *
 *   (a) anchored markdown links   — `[x](../../../docs/adr/0004-….md)`
 *       anchor: the SKILL FILE. Predicate: the target exists file-relative.
 *       Day-one prey: two `convention-07-host-landing-seam.md` links were one
 *       directory level short (`../wave-close/…` for a file two levels down),
 *       and `convention-05-sidecar-write-path.md` carried one level too many
 *       (`reference/routing-mechanics.md` from inside `reference/`).
 *
 *   (b) bare path citations       — `` `docs/retros/2026-07-19-hardening-w5.md` ``
 *       anchor: the PLUGIN-CLONE ROOT. Predicate: the target exists in the
 *       clone. They stay bare (ADR-0031 rejects demoting them to slugs) —
 *       existence-pinning buys rename/deletion protection at zero edit cost.
 *       Day-one prey: `.claude/skills/README.md` still cited two
 *       `docs/superpowers/plans/…` design docs that the publication cut
 *       (ADR-0026) left behind in the private archive.
 *
 *   (c) `{{wave-cli}}` resolution blocks — the engine-invocation BINDING
 *       anchor: the consumer's own `wave.config.json`. ADR-0031 originally had
 *       these blocks state two invocation forms in a fixed order (published
 *       package first, vendored in-repo form as the documented fallback);
 *       **ADR-0032 superseded that rule** after the ordering turned out to be
 *       operationally dead — 5 of 7 rows of one wave silently degraded to the
 *       fallback, and the two authority docs then disagreed about which form
 *       even *was* the default. Invocation forms now live in exactly ONE place
 *       (wave-setup's scaffold) and every other block reads the configured
 *       value. Predicate: a resolution block states the BINDING — it names the
 *       `engine.cli` field, names the config it is read from, and says what an
 *       absent binding means (a STOP pointing at wave-setup) — and it never
 *       RANKS invocation forms (no first/fallback/canonical ordering attached
 *       to a named form).
 *
 * A fourth predicate rides the same corpus but asks a different question — not
 * "does this reference resolve?" but "is it in the right PLACE?":
 *
 *   (d) citation PLACEMENT in SKILL.md bodies — wave-shared Convention 14.
 *       anchor: none; this is an editorial invariant, not a resolution one.
 *       Predicate: an ADR/retro/finding citation inside a SKILL.md body sits in
 *       a provenance position (a compact trailing pointer, a provenance block,
 *       or — best — a reference file), never in bare narrative prose inside an
 *       instruction. Skills are an agent-executed protocol, so a rule's one-line
 *       *why* must stay in place; the evidence behind that why is what turns
 *       shipped prose into an internal diary for a plugin consumer. Seeded with
 *       a named legacy allowlist of the bodies already in violation, ratcheted
 *       so those may shrink but never grow.
 *
 * The spec is deliberately structural, not a smoke test: the four predicates
 * are separately assertable, each allowlist is a named const in this file with a
 * one-line justification per entry (so every widening is visible in the diff
 * that makes it), and population FLOOR counts fail loud if an extractor ever
 * silently stops seeing references — a guard that matches nothing is green for
 * the wrong reason. Permanent negative controls push planted dead references
 * through the *same* extraction-and-resolution helpers the real assertions use
 * (Convention 11), so "the check works" is distinguishable from "the check
 * cannot fail".
 *
 * ADR-0031's fourth decision is pinned here too: narrowing the package surface
 * away from `"source": "./"` must be a LOUD decision. `CLONE_ROOT_PREFIXES` is
 * asserted to exist at the clone root, so shipping only `.claude/skills/` turns
 * this spec red instead of quietly emptying the class-(b) population.
 *
 * Pure test — zero production change. Precedent: skill-schema-drift.spec.ts
 * (anchor consts, negative control, header rationale comment).
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is tools/wave/src —
 * three levels above the repo root. (vite `root` is tools/wave, but __dirname is
 * the spec file's own dir; the ../../../ count is correct only for __dirname.)
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The plugin-clone root — the resolution anchor for class (b). */
const CLONE_ROOT = resolve(__dirname, '../../..');

/** The two shipped skill/agent trees. Vendored skills (grill-with-docs) are
 * deliberately NOT excluded: they ship in the clone like every other skill and
 * a dead link there fails a consumer identically (ADR-0031, rejected option). */
const SKILL_DIRS = ['.claude/skills', '.claude/agents'] as const;

/**
 * Clone-root top-level prefixes a bare path citation may name. Kept as an
 * explicit const rather than derived from a directory listing so the class-(b)
 * population is deterministic — and so ADR-0031's "narrowing the package
 * surface is a loud decision" has something to fail against (see the existence
 * assertion below).
 */
const CLONE_ROOT_PREFIXES = [
  'docs/', // ADRs, retros, CHARTER — the citation-heavy evidence tree
  'tools/', // the engine sources skills point at by path
  '.claude/', // skills, agents, tracked settings
  '.claude-plugin/', // the marketplace manifest that makes the clone the install surface
  '.github/', // the CI workflow the landing seam depends on
  'scripts/', // repo scripts referenced from skill prose
] as const;

/**
 * Paths that exist only at RUNTIME and are gitignored, so they are absent from
 * the clone by construction (ADR-0031: "only gitignored artifacts are absent").
 * Citing them is correct prose; asserting their existence would be a category
 * error, so they are filtered out of the class-(b) population entirely rather
 * than allowlisted per occurrence.
 */
const RUNTIME_ARTIFACT_PREFIXES = [
  '.flotilla/', // per-wave spines + sidecars — branch-local runtime state
  '.claude/worktrees/', // agent worktrees created and torn down per wave
  '.claude/settings.local.json', // operator-local permissions (gitignored, never read)
  '.claude/projects/', // harness-local session data
  'tools/wave/node_modules/', // installed dependencies — the one absence ADR-0031 names
  'tools/wave/coverage/', // test output
] as const;

/**
 * Class-(a) links that legitimately resolve to nothing. Every entry carries its
 * justification on one line; a widening is therefore visible in the diff that
 * makes it. Keyed `<clone-relative file>::<raw link target>`.
 */
const ANCHORED_LINK_ALLOWLIST: ReadonlyArray<{ file: string; target: string; why: string }> = [
  {
    file: '.claude/skills/grill-with-docs/CONTEXT-FORMAT.md',
    target: './src/ordering/CONTEXT.md',
    why: 'Illustrative CONTEXT-MAP.md sample inside a ```md fence — names a hypothetical consumer bounded context, not a flotilla file.',
  },
  {
    file: '.claude/skills/grill-with-docs/CONTEXT-FORMAT.md',
    target: './src/billing/CONTEXT.md',
    why: 'Same illustrative CONTEXT-MAP.md sample — a second hypothetical bounded context in the worked example.',
  },
  {
    file: '.claude/skills/grill-with-docs/CONTEXT-FORMAT.md',
    target: './src/fulfillment/CONTEXT.md',
    why: 'Same illustrative CONTEXT-MAP.md sample — the third hypothetical bounded context in the worked example.',
  },
];

/**
 * Class-(d) legacy: the SKILL.md bodies that already carried narrative
 * citations when Convention 14 landed. Deliberately NOT a mass rewrite — a
 * placement-only sweep would conflict with every open row declaring these
 * files, for a defect that costs nothing while it sits. The list is a
 * **ratchet**, enforced by the tests below: `seeded` is the occurrence count
 * measured at landing and acts as a CEILING (a new violation in an
 * already-listed file still fails), and an entry whose file has reached zero
 * must be deleted (an allowlist that outlives its reason is a hole). Clean a
 * body up when you are editing it anyway and drop its entry in the same diff.
 */
const CITATION_PLACEMENT_LEGACY: ReadonlyArray<{ file: string; seeded: number; why: string }> = [
  {
    file: '.claude/skills/wave-shared/SKILL.md',
    seeded: 6,
    why: 'The plugin-namespaced-by-name-load section is a two-paragraph evidence argument (clean-room retro finding DA-F3) living in the body; relocating it means moving it to a reference file, not repositioning a pointer.',
  },
  {
    file: '.claude/skills/wave-setup/SKILL.md',
    seeded: 4,
    why: 'The keychain live-gate prose argues against a wrong reading of the credential ADR by name, twice, plus a doubled-invocation-prefix rationale — the argument is the instruction here, so the fix is structural.',
  },
  {
    file: '.claude/skills/wave-start/SKILL.md',
    seeded: 3,
    why: 'Three inline "per ADR-NNNN" rationale mentions in gate prose and Common Mistakes; mechanical to convert to trailing pointers, deferred to the next edit of this file.',
  },
  {
    file: '.claude/skills/wave-close/SKILL.md',
    seeded: 1,
    why: 'One Common-Mistakes bullet closes on "the live-gate defect ADR-NNNN exists to fix"; a trailing pointer is the whole fix, deferred to the next edit of this file.',
  },
  {
    file: '.claude/skills/wave-resume/SKILL.md',
    seeded: 1,
    why: 'The done-reconcile probe names the ADR that owns the evidence hierarchy mid-sentence; rewording touches load-bearing probe prose, so it waits for a row that is already in there.',
  },
  {
    file: '.claude/skills/wave-reviewer/SKILL.md',
    seeded: 1,
    why: 'The "Related" section is a narrative provenance paragraph about a clean-room finding; it wants a provenance heading, which is a structural edit rather than a placement one.',
  },
];

/** Population floors. A guard that stops matching is green for the wrong
 * reason; these are the measured populations at the landing SHA, minus a small
 * margin so ordinary prose edits do not churn the spec. */
const MIN_SKILL_DOCS = 40; // 48 markdown files at landing
const MIN_ANCHORED_LINKS = 60; // 77 anchored markdown links at landing
const MIN_BARE_CITATIONS = 70; // 88 bare path citations at landing
const EXPECTED_RESOLUTION_BLOCKS = 10; // the canonical `{{wave-cli}}` definition sites
const MIN_SKILL_BODIES = 10; // 12 SKILL.md bodies at landing
const MIN_BODY_CITATIONS = 130; // 146 ADR/retro/finding citations in those bodies at landing

/**
 * The Convention number currently on top of `wave-shared`'s number-allocation
 * register. Sibling skills cite conventions BY NUMBER, so numbers are never
 * re-used and never renumbered — which makes the register the collision-hygiene
 * mechanism (two slices planned in parallel cannot both silently land "the next
 * one"). Bumping this const is therefore a three-part edit that must land in one
 * diff: the new `convention-NN-*.md` reference file, the register's heading
 * number AND its one-liner (replaced together — see the pairing test below), and
 * this line.
 */
const HIGHEST_ALLOCATED_CONVENTION = 16;

/** The config field every resolution block must name (ADR-0032). */
const BINDING_FIELD = /\bengine\.cli\b/;

/** …and the config file it is read from, named rather than implied. */
const BINDING_SOURCE = /wave\.config\.json|\bwave config\b/i;

/**
 * The absent-binding STOP, asserted at SENTENCE scope: one sentence must carry
 * all three of an absence word, the refusal, and the pointer at setup. Scoping
 * it to a sentence is what stops three unrelated words scattered across a long
 * block from satisfying the rule by coincidence.
 */
const ABSENCE_WORD = /\babsent\b|\bmissing\b|\bunbound\b|\bnot configured\b|\bno binding\b/i;
const STOP_WORD = /\bstops?\b/i;
const SETUP_POINTER = /\bwave-setup\b|\bsetup\b/i;

/**
 * The concrete invocation forms a block can NAME. Naming one is not itself a
 * violation — wave-setup's own block legitimately names the pre-setup bootstrap
 * form and flotilla's documented vendored exception, and CONTEXT.md's re-scoped
 * "dual-form" still covers prose references. What ADR-0032 forbids is *ranking*
 * them, which is why this list is only ever consulted together with the ranking
 * language below.
 */
const INVOCATION_FORM_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: 'npx published-package form', re: /npx\s+@formtrieb\/flotilla-engine/ },
  { label: 'installed local-binary form', re: /node_modules\/\.bin\/flotilla-engine/ },
  {
    label: 'vendored in-repo form',
    re: /tools\/wave\/(?:src\/(?:cli|spine-cli|resume-cli)\.ts|node_modules\/\.bin\/tsx)/,
  },
];

/**
 * Ranking language — the words that turn a named form into an *ordered
 * alternative*. Deliberately NOT a bare `/fallback/` sweep over the block:
 * "there is no fallback chain" is the rule being STATED, not broken, and a
 * block-scoped word match cannot tell the two apart. Pairing this with a named
 * form **in the same sentence** is what distinguishes "this form comes first,
 * that one is the fallback" (the ADR-0031 shape, now a violation) from "the
 * fallback chain is abolished" (the ADR-0032 rule) and from "flotilla binds
 * engine.cli to the vendored form" (an incidental naming).
 *
 * VOCABULARY TRADEOFF — settled, not silent (issue #314, Hole 2). This is a
 * fixed enumeration, not a parser, so it is necessarily incomplete: a block
 * that ranks two forms using ONLY out-of-list vocabulary clears this predicate
 * undetected. The list below is deliberately NOT widened to cover ordinary
 * ranking words `instead`, `before`, `after`, `default` — each already appears
 * in the live corpus in a sentence that is a required negative control, and
 * co-occurs there with a named invocation form:
 *   - wave-setup's block ends "...every other consumer binds to the pinned
 *     local package instead." — states WHICH form a consumer binds to; ranks
 *     nothing.
 *   - the same block opens its exploration-path sentence with "Before that
 *     binding exists at all — the one-time window before `wave-setup` has ever
 *     run..." — temporal scoping of when a form is even reachable, not an
 *     ordering between two forms.
 * Adding any of those four words would turn both sentences into false-positive
 * RANKS violations the moment the hard-wrap fix (above) or any future change
 * widens what counts as "the same sentence" — which is exactly why the two
 * holes move together and this list stays as narrow as it is. The residual gap
 * this leaves is accepted, not hidden: widening this list requires a new
 * negative-control assertion in the SAME diff proving the added word does not
 * fire on an innocent sentence already shipped (the two above are exactly that
 * kind of proof, and both are asserted below) — never a silent addition.
 */
const FORM_RANKING_LANGUAGE =
  /\bdual[- ]form\b|\bcanonical\b|\bfall(?:s|en)?\s+back\b|\bfallbacks?\b|\bfirst\b|\bsecond\b|\botherwise\b|\bif that fails\b|\beither form\b|\bboth forms?\b|\bboth reach\b|\bwhichever form\b|\bprefer(?:s|red)?\b/i;

// ─── extraction ─────────────────────────────────────────────────────────────

interface Reference {
  /** Clone-relative path of the file the reference was found in. */
  readonly file: string;
  /** The raw reference text exactly as written. */
  readonly target: string;
}

interface ResolutionBlock {
  readonly file: string;
  readonly heading: string;
  readonly body: string;
}

/** Every shipped skill/agent markdown file, clone-relative, sorted. */
function listSkillDocs(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(CLONE_ROOT, full).split(sep).join('/'));
      }
    }
  };
  for (const dir of SKILL_DIRS) walk(join(CLONE_ROOT, dir));
  return out.sort();
}

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Class (a): markdown link targets that resolve **file-relative**. Absolute
 * paths, fragment-only links and URLs (any `scheme:` prefix) are not
 * file-relative references and are out of the class. Fenced code blocks are NOT
 * stripped — the grill-with-docs worked example lives inside a ```md fence and
 * is exactly the kind of reference the allowlist exists for.
 */
function extractAnchoredLinks(md: string, file: string): Reference[] {
  const out: Reference[] = [];
  for (const match of md.matchAll(MARKDOWN_LINK)) {
    const raw = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, mailto:, …
    if (raw.startsWith('#')) continue; // in-page fragment
    if (raw.startsWith('/')) continue; // absolute — not file-relative
    const target = raw.split('#')[0];
    if (!target) continue;
    out.push({ file, target: raw });
  }
  return out;
}

/** Resolve a class-(a) reference against its anchor: the skill file's own dir. */
function resolveAnchoredLink(ref: Reference): boolean {
  const target = ref.target.split('#')[0];
  return existsSync(resolve(CLONE_ROOT, dirname(ref.file), target));
}

/**
 * Class-(a) EXTENSION: the `#anchor` fragment. Until this addition,
 * `resolveAnchoredLink` (above) stripped the fragment with `.split('#')[0]`
 * before testing existence — a link whose FILE resolves and whose HEADING
 * does not was therefore indistinguishable from a correct one. This is the
 * other half of the same address, verified against the target file's own
 * headings.
 *
 * SLUG ALGORITHM — SCOPE DECISION (recorded here and in the PR body). This
 * implements a documented ASCII SUBSET of GitHub's real heading-slug
 * algorithm, not the exact rendering behaviour: reproducing that exactly
 * would mean embedding GitHub's own Unicode-punctuation table (the
 * `github-slugger` package), a dependency this test-only file does not carry
 * and the corpus does not need. The subset:
 *
 *   1. a markdown link `[label](url)` inside a heading collapses to its
 *      LABEL — the url must never leak its own word-characters (a path
 *      segment like `docs`/`adr`/`0030`) into the slug;
 *   2. lowercase;
 *   3. every character that is not an ASCII letter, digit, underscore,
 *      space, or hyphen is DROPPED. This reproduces both live corner cases
 *      already in the corpus (asserted below against the real headings, not
 *      synthetic ones): a parenthesised `(issue #355)` collapses to a
 *      trailing `-issue-355` (the parens and `#` are dropped, the digits
 *      survive); an em-dash leaves a DOUBLE hyphen (the dash character is
 *      dropped, but its two flanking spaces are NOT collapsed — each becomes
 *      its own hyphen in step 4, which is what produces the double hyphen);
 *   4. each remaining space becomes exactly ONE hyphen, one at a time — a
 *      run of N spaces becomes a run of N hyphens, never collapsed to one;
 *   5. a slug that repeats within one file gets GitHub's own de-duplication
 *      suffix (`-1`, `-2`, …) in heading order, the same behaviour
 *      `github-slugger` implements.
 *
 * BOUNDARY, stated so a reader can tell a deliberate limit from an
 * oversight: GitHub's real algorithm keeps non-ASCII LETTERS (accented
 * Latin, CJK, …) as slug content; this subset drops them along with every
 * other stripped character, same as any other punctuation. No heading in the
 * guarded corpus contains one (checked at authoring time — every `^#`
 * heading in `.claude/skills/**` and `.claude/agents/**` is ASCII prose, the
 * only non-ASCII characters present being em/en dashes and smart quotes,
 * both already handled by step 3). This is therefore a live but currently
 * UNEXERCISED boundary, not a known-wrong case: a heading that does someday
 * carry such a character would slug SHORTER here than GitHub's real anchor,
 * so a genuinely correct link into it FAILS this check rather than silently
 * passing. The guard fails CLOSED at the boundary, never open — an
 * unverifiable slug reads as a dead one, not as a skip.
 */
function slugifyHeading(rawHeadingText: string): string {
  const labelOnly = rawHeadingText.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const lowered = labelOnly.toLowerCase();
  const stripped = lowered.replace(/[^a-z0-9_ -]/g, '');
  return stripped.replace(/ /g, '-');
}

const HEADING_LINE = /^#{1,6}\s+(.*)$/;

/** Every heading TEXT in a markdown file, in document order, fenced code
 * excluded (a `#`-prefixed shell comment inside a fence is not a heading —
 * same fence-tracking discipline as `extractCitations` uses). */
function extractHeadingTexts(md: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_LINE.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** The full anchor SET a markdown file exposes — GitHub's own
 * de-duplication suffix applied to a repeated slug, in heading order. */
function headingAnchors(md: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const text of extractHeadingTexts(md)) {
    const base = slugifyHeading(text);
    const priorOccurrences = seen.get(base) ?? 0;
    seen.set(base, priorOccurrences + 1);
    anchors.add(priorOccurrences === 0 ? base : `${base}-${priorOccurrences}`);
  }
  return anchors;
}

type AnchorFragmentVerdict = 'no-fragment' | 'ok' | 'dead' | 'out-of-scope';

/**
 * SCOPE DECISION (recorded here and in the PR body): a fragment resolves
 * ONLY against a target file inside the guarded population `SOURCES` already
 * holds — every markdown file under `.claude/skills/` and `.claude/agents/`
 * (`SKILL_DOCS`). A fragment whose target FILE resolves (the class-(a)
 * dead-path predicate above already proved that) but which sits OUTSIDE that
 * population — an ADR, a retro, `CONTEXT.md`, anything this guard has never
 * read the headings of — is judged `'out-of-scope'` and treated as a FAILURE
 * by the assertion below, never silently skipped: this guard has nothing to
 * verify such a fragment against, and trusting an anchor it never inspected
 * is exactly the silent pass this row exists to close. Widening the guarded
 * population to cover a real future case is a deliberate, loud edit to
 * `SKILL_DIRS` — not a silent exemption carved out here.
 */
function verifyAnchorFragment(ref: Reference): AnchorFragmentVerdict {
  const hashIndex = ref.target.indexOf('#');
  if (hashIndex === -1) return 'no-fragment';
  const fragment = ref.target.slice(hashIndex + 1);
  if (!fragment) return 'no-fragment';
  const targetPath = ref.target.slice(0, hashIndex);
  const absolute = resolve(CLONE_ROOT, dirname(ref.file), targetPath);
  const cloneRelative = relative(CLONE_ROOT, absolute).split(sep).join('/');
  const source = SOURCES.get(cloneRelative);
  if (source === undefined) return 'out-of-scope';
  return headingAnchors(source).has(fragment) ? 'ok' : 'dead';
}

const INLINE_CODE = /`([^`\n]+)`/g;
/** A bare, placeholder-free, slash-bearing path — no spaces (a command
 * fragment has them), no `<…>`/`$`/`*` (a template or glob has them). */
const BARE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+\/?$/;

/**
 * Class (b): inline-code spans that name a clone-root-relative path. Gated on
 * `CLONE_ROOT_PREFIXES` so a *file*-relative code span (`reference/foo.md`)
 * never lands in the clone-root class, and filtered against
 * `RUNTIME_ARTIFACT_PREFIXES` so gitignored runtime paths are not asserted to
 * exist in a clone that by definition does not carry them.
 */
function extractBarePathCitations(md: string, file: string): Reference[] {
  const out: Reference[] = [];
  for (const match of md.matchAll(INLINE_CODE)) {
    const target = match[1].trim();
    if (!BARE_PATH.test(target)) continue;
    if (!CLONE_ROOT_PREFIXES.some((p) => target.startsWith(p))) continue;
    if (
      RUNTIME_ARTIFACT_PREFIXES.some(
        (p) => target === p.replace(/\/$/, '') || target.startsWith(p),
      )
    ) {
      continue;
    }
    out.push({ file, target });
  }
  return out;
}

/** Resolve a class-(b) reference against its anchor: the plugin-clone root. */
function resolveCloneRootCitation(ref: Reference): boolean {
  return existsSync(resolve(CLONE_ROOT, ref.target));
}

const RESOLUTION_HEADING = /^(#{1,6})\s+(.*\{\{wave-cli\}\}.*\bresolution\b.*)$/i;

/**
 * Class (c): the canonical `{{wave-cli}}` resolution blocks — a markdown
 * section whose heading names `{{wave-cli}}` and the word "resolution". The
 * block runs to the next heading of any level. Narrative engine-path mentions
 * outside such a section are class-(b) identifiers, not invocations, and are
 * deliberately left alone (ADR-0031).
 */
function extractResolutionBlocks(md: string, file: string): ResolutionBlock[] {
  const lines = md.split('\n');
  const out: ResolutionBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = RESOLUTION_HEADING.exec(lines[i]);
    if (!head) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]); j++) {
      body.push(lines[j]);
    }
    out.push({ file, heading: head[2].trim(), body: body.join('\n') });
  }
  return out;
}

/**
 * A blank line ends a paragraph. So does a blank BLOCKQUOTE line — a line that
 * is nothing but an optional leading `>` (and whitespace) — since a `>`-prefixed
 * admonition wraps its own paragraphs the same way plain prose does.
 */
const PARAGRAPH_BREAK = /^\s*>?\s*$/;

/**
 * Fold hard-wrapped markdown lines within one paragraph into a single line, so
 * a bare editor-wrap line break stops acting as a sentence boundary (issue
 * #314, Hole 1). Before this fold, `sentences()` split on EVERY raw line break
 * — including one inserted purely by a wrap column — so a named invocation
 * form on one physical line and its ranking word on the next were never seen
 * co-occurring. Demonstrated live: the pre-ADR-0032 `.claude/skills/README.md`
 * carried "...keeps the vendored `npx tsx tools/wave/src/cli.ts` / local-binary
 * forms as a\nfallback — both reach the identical router.)" — one authored
 * sentence, wrapped across two physical lines — and the sweep missed it (see
 * the regression test below, which reproduces this exact historical text and
 * pins that the OLD per-line splitter really did miss it).
 *
 * A genuine paragraph break — a blank line, or a blank blockquote line (`>`
 * alone) — is NOT folded: it still starts a new paragraph, which is what keeps
 * `.claude/skills/wave-shared/reference/convention-01-auth-preflight.md`'s
 * "documented fallback" sentence and its blockquoted `npx tsx
 * tools/wave/src/cli.ts` code sample (separated by a blank `>` line, a genuine
 * paragraph break, not a wrap) from being folded INTO one sentence just because
 * the wrap-scope widened — that pairing is a real, load-bearing negative
 * control (its subject is the proxy env flag, never the `engine.cli` binding),
 * and is asserted below.
 */
function joinHardWraps(body: string): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const raw of body.split('\n')) {
    if (PARAGRAPH_BREAK.test(raw)) {
      if (current.length > 0) paragraphs.push(current.join(' '));
      current = [];
    } else {
      current.push(raw.trim());
    }
  }
  if (current.length > 0) paragraphs.push(current.join(' '));
  return paragraphs.join('\n\n');
}

/**
 * Split a block body into sentences. A sentence-ender followed by whitespace,
 * or a line break, ends one — and markdown closers (`**`, a backtick, a closing
 * paren) are allowed to sit between the two, since a bolded sentence ends
 * `it.**` rather than `it.`. An inline-code path (`wave.config.json`) never
 * splits: its dot is followed by a letter, not by whitespace.
 *
 * `:` and `;` deliberately do NOT end a sentence. Both routinely join a claim
 * to its consequence in this corpus ("an absent binding is a STOP: finish
 * wave-setup"), and splitting there would tear the absent-binding statement in
 * half and fail a block that states the rule perfectly well.
 *
 * The body is folded through `joinHardWraps` FIRST, so only a genuine
 * paragraph break still counts as a line break here — a hard wrap inside a
 * paragraph no longer does (issue #314, Hole 1).
 */
function sentences(body: string): string[] {
  return joinHardWraps(body)
    .replace(/([.!?][)\]*_`"'”’]*)\s+/g, '$1\n') // a sentence break becomes a line break
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every concrete invocation form NAMED in a fragment, by label. */
function namedForms(fragment: string): string[] {
  return INVOCATION_FORM_PATTERNS.filter((f) => f.re.test(fragment)).map((f) => f.label);
}

/**
 * The class-(c) predicate (ADR-0032). Returns `null` when the block states the
 * binding, or a human-legible reason when it does not — naming which half is
 * missing keeps a failure actionable instead of a bare boolean.
 *
 * Two halves, and both matter. The POSITIVE half is what the block must say:
 * `engine.cli`, the config it lives in, and the consequence of its absence. The
 * NEGATIVE half is what it must not do: rank invocation forms. A block that
 * merely *names* a form is fine (wave-setup's does, twice, for the pre-setup
 * bootstrap path and flotilla's own vendored exception); a block that attaches
 * ordering language to a named form is the superseded ADR-0031 shape.
 */
function bindingFormViolation(block: ResolutionBlock): string | null {
  const body = block.body;

  if (!BINDING_FIELD.test(body)) {
    return 'never names the `engine.cli` binding — a resolution block states WHERE the invocation comes from (the configured `engine.cli`), not which form to use (ADR-0032)';
  }
  if (!BINDING_SOURCE.test(body)) {
    return 'names `engine.cli` but not the wave config it is read from — a reader has to be told which file carries the binding, not just the field name';
  }

  const lines = sentences(body);
  const hasAbsentStop = lines.some(
    (s) => ABSENCE_WORD.test(s) && STOP_WORD.test(s) && SETUP_POINTER.test(s),
  );
  if (!hasAbsentStop) {
    return 'never says what an ABSENT binding means — it is a STOP pointing at wave-setup, never a cue to guess a form; state that in one sentence (absence + stop + wave-setup)';
  }

  const ranked = lines
    .map((s) => [s, namedForms(s)] as const)
    .filter(([s, forms]) => forms.length > 0 && FORM_RANKING_LANGUAGE.test(s));
  if (ranked.length > 0) {
    const [sentence, forms] = ranked[0];
    return (
      `RANKS invocation forms — ADR-0032 abolished the ordering, so forms live only in wave-setup's ` +
      `scaffold and every other block reads the configured value. Offending sentence names ` +
      `[${forms.join(', ')}] alongside ordering language: "${sentence.slice(0, 160)}"`
    );
  }

  return null;
}

/**
 * Class (d): the citation shapes Convention 14 governs — an ADR number, a
 * `docs/adr/` or `docs/retros/` path, or a retro finding id (`W5-F1`, `DA-F3`,
 * `KW-F4`). These are *evidence* identifiers: they justify a rule to a
 * maintainer reading backwards and change nothing an executing agent does next,
 * which is exactly why their placement — not their presence — is the invariant.
 */
const CITATION_TOKEN = /\bADR-\d{4}\b|\bdocs\/(?:adr|retros)\/[A-Za-z0-9._/-]+|\b[A-Z]{1,4}\d*-F\d+\b/g;

/** A heading whose section exists to hold provenance. Text under one of these
 * is a provenance block — the second sanctioned position. */
const PROVENANCE_HEADING =
  /provenance|live occurrence|evidence|background|references|see also|history|further reading|where the clause lives/i;

/** Where a citation sits, relative to Convention 14's three sanctioned positions. */
type CitationPlacement = 'narrative' | 'trailing-pointer' | 'provenance-block';

interface Citation {
  readonly file: string;
  /** 1-indexed line, so a failure message points at something openable. */
  readonly line: number;
  readonly token: string;
  readonly placement: CitationPlacement;
  readonly text: string;
}

/**
 * Blank out every parenthetical group, innermost first, replacing it with
 * spaces so byte offsets in the masked line still align with the raw line. A
 * citation that survives masking was in bare running prose; one that does not
 * was inside a parenthetical — the compact-trailing-pointer form. (Markdown
 * link TARGETS are parenthesized by construction and therefore masked too,
 * which is correct: a link target is a pointer. A link LABEL sits in `[…]` and
 * stays visible, which is also correct — `[ADR-0018](…)` mid-sentence is a
 * citation in narrative prose no matter how it is marked up.)
 */
function maskParentheticals(line: string): string {
  let masked = line;
  for (;;) {
    const next = masked.replace(/\([^()]*\)/g, (m) => ' '.repeat(m.length));
    if (next === masked) return masked;
    masked = next;
  }
}

/**
 * Class (d) extraction: every citation in a markdown body, tagged with the
 * position it occupies. Fenced code is skipped entirely — a command or a sample
 * naming a path is not narrative prose — and headings drive the
 * provenance-block state for the lines that follow them.
 *
 * What this deliberately does NOT judge: whether a parenthetical is genuinely
 * *compact*. A three-sentence parenthetical recounting a wave satisfies this
 * predicate and defeats the convention; placement is machine-checkable,
 * compression is the author's. Convention 14 says so in the same words.
 */
function extractCitations(md: string, file: string): Citation[] {
  const out: Citation[] = [];
  const lines = md.split('\n');
  let inFence = false;
  let underProvenance = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      underProvenance = PROVENANCE_HEADING.test(heading[1]);
      continue;
    }
    const masked = maskParentheticals(line);
    for (const m of line.matchAll(CITATION_TOKEN)) {
      const at = m.index as number;
      const stillVisible = masked.slice(at, at + m[0].length) === m[0];
      out.push({
        file,
        line: i + 1,
        token: m[0],
        placement: underProvenance
          ? 'provenance-block'
          : stillVisible
            ? 'narrative'
            : 'trailing-pointer',
        text: line.trim(),
      });
    }
  }
  return out;
}

/** The class-(d) predicate, per file: citations sitting in bare narrative prose. */
function narrativeCitations(citations: readonly Citation[]): Citation[] {
  return citations.filter((c) => c.placement === 'narrative');
}

// ─── the corpus, read once ───────────────────────────────────────────────────

const SKILL_DOCS = listSkillDocs();
const SOURCES = new Map(
  SKILL_DOCS.map((f) => [f, readFileSync(join(CLONE_ROOT, f), 'utf-8')] as const),
);

const ALL_ANCHORED = SKILL_DOCS.flatMap((f) =>
  extractAnchoredLinks(SOURCES.get(f) as string, f),
);
const ALL_CITATIONS = SKILL_DOCS.flatMap((f) =>
  extractBarePathCitations(SOURCES.get(f) as string, f),
);
const ALL_BLOCKS = SKILL_DOCS.flatMap((f) =>
  extractResolutionBlocks(SOURCES.get(f) as string, f),
);

/** Class (d)'s population is the SKILL.md **bodies** only — the files a reader
 * must hold to act. Reference files are where deep provenance is supposed to
 * go, so asserting the rule against them would forbid the sanctioned position;
 * the agent brief in `.claude/agents/` is a dispatched brief, not a skill body. */
const SKILL_BODIES = SKILL_DOCS.filter((f) => f.endsWith('/SKILL.md'));
const ALL_CITATIONS_IN_BODIES = SKILL_BODIES.flatMap((f) =>
  extractCitations(SOURCES.get(f) as string, f),
);

const isAllowlisted = (ref: Reference): boolean =>
  ANCHORED_LINK_ALLOWLIST.some((e) => e.file === ref.file && e.target === ref.target);

// ─── the population itself ───────────────────────────────────────────────────

describe('skill-reference-guard — the population is the whole shipped skill/agent surface', () => {
  it('enumerates every skill and agent markdown file, vendored skills included', () => {
    expect(SKILL_DOCS.length).toBeGreaterThanOrEqual(MIN_SKILL_DOCS);
    // Named spot-checks: the agent file, a first-party skill, and the VENDORED
    // skill ADR-0031 explicitly refused to exclude structurally.
    expect(SKILL_DOCS).toContain('.claude/agents/wave-reviewer.md');
    expect(SKILL_DOCS).toContain('.claude/skills/wave-shared/SKILL.md');
    expect(SKILL_DOCS).toContain('.claude/skills/grill-with-docs/SKILL.md');
    expect(SKILL_DOCS).toContain('.claude/skills/grill-with-docs/CONTEXT-FORMAT.md');
  });

  it('the clone really is the full-repo install surface (ADR-0031 premise, pinned)', () => {
    // If a future packaging change narrows `"source": "./"`, this is the first
    // thing that goes red — deliberately, so the ADR gets revisited explicitly
    // instead of the class-(b) population silently emptying out.
    for (const prefix of CLONE_ROOT_PREFIXES) {
      expect(
        existsSync(join(CLONE_ROOT, prefix.replace(/\/$/, ''))),
        `clone-root prefix "${prefix}" is missing — the package surface narrowed; ADR-0031 must be revisited`,
      ).toBe(true);
    }
  });
});

// ─── class (a): anchored markdown links resolve file-relative ────────────────

describe('skill-reference-guard — class (a): anchored markdown links resolve file-relative', () => {
  it('finds the anchored-link population (a guard that matches nothing is green for the wrong reason)', () => {
    expect(ALL_ANCHORED.length).toBeGreaterThanOrEqual(MIN_ANCHORED_LINKS);
  });

  it('every anchored link resolves against its own skill file', () => {
    const dead = ALL_ANCHORED.filter(
      (ref) => !isAllowlisted(ref) && !resolveAnchoredLink(ref),
    ).map((ref) => `${ref.file} → ${ref.target}`);
    expect(
      dead,
      `dead anchored markdown link(s) — the target must exist RELATIVE TO THE SKILL FILE ` +
        `(a consumer session's cwd is the consumer repo, never the clone). Fix the ` +
        `path, or add it to ANCHORED_LINK_ALLOWLIST with a one-line justification:\n  ` +
        dead.join('\n  '),
    ).toEqual([]);
  });

  it('the two convention-07 landing-seam links carry their full directory depth (AC1)', () => {
    const seam = ALL_ANCHORED.filter(
      (r) => r.file === '.claude/skills/wave-shared/reference/convention-07-host-landing-seam.md',
    );
    const targets = seam.map((r) => r.target);
    expect(targets).toContain('../../wave-close/reference/close-mechanics.md');
    expect(targets).toContain('../../wave-resume/reference/resume-mechanics.md');
    // The pre-fix spelling was one level short; pin that it never comes back.
    expect(targets).not.toContain('../wave-close/reference/close-mechanics.md');
    expect(targets).not.toContain('../wave-resume/reference/resume-mechanics.md');
  });

  it('every allowlist entry is still a real, still-dead reference', () => {
    // An allowlist that outlives its reason is a hole. If an entry's link is
    // gone (or has started resolving), the entry must go too.
    for (const entry of ANCHORED_LINK_ALLOWLIST) {
      const found = ALL_ANCHORED.find(
        (r) => r.file === entry.file && r.target === entry.target,
      );
      expect(
        found,
        `stale allowlist entry: ${entry.file} → ${entry.target} is no longer written anywhere`,
      ).toBeDefined();
      expect(
        resolveAnchoredLink(found as Reference),
        `obsolete allowlist entry: ${entry.file} → ${entry.target} now resolves; drop the exception`,
      ).toBe(false);
      expect(entry.why.length).toBeGreaterThan(20); // a justification, not a shrug
    }
  });

  it('negative control — a planted dead anchored link fails the same predicate', () => {
    // Same extractor, same resolver, same corpus file as the real assertion.
    const host = '.claude/skills/wave-shared/reference/convention-07-host-landing-seam.md';
    const planted = extractAnchoredLinks(
      'see [close mechanics](../wave-close/reference/close-mechanics.md) for the invocation\n',
      host,
    );
    expect(planted).toHaveLength(1);
    expect(isAllowlisted(planted[0])).toBe(false);
    expect(resolveAnchoredLink(planted[0])).toBe(false); // the exact pre-fix spelling
  });

  it('positive control — the corrected link resolves through the same pipeline', () => {
    const host = '.claude/skills/wave-shared/reference/convention-07-host-landing-seam.md';
    const planted = extractAnchoredLinks(
      'see [close mechanics](../../wave-close/reference/close-mechanics.md) for the invocation\n',
      host,
    );
    expect(resolveAnchoredLink(planted[0])).toBe(true);
  });
});

// ─── class (a) extension: #anchor fragments resolve against real headings ────

describe('skill-reference-guard — class (a) extension: #anchor fragments resolve against target headings', () => {
  it('the slug derivation reproduces both live corner cases already in the corpus (real headings, not synthetic ones)', () => {
    // (1) a parenthesised issue reference collapses to a trailing `-issue-NNN`
    // form — the real heading behind `#gitignore-scaffold--the-scribe-scratch-
    // path-issue-355`, cited from three different skill files.
    expect(
      slugifyHeading('`.gitignore` scaffold — the Scribe scratch path (issue #355)'),
    ).toBe('gitignore-scaffold--the-scribe-scratch-path-issue-355');

    // (2) an em-dash leaves a DOUBLE hyphen behind — the real heading behind
    // `#the-scribe-scratch-sweep--a-repo-internal-location-that-had-no-
    // lifecycle-issue-355`. Both corner cases (the parenthesised issue AND
    // the em-dash) live in this single heading at once.
    expect(
      slugifyHeading(
        'The Scribe scratch sweep — a repo-internal location that had no lifecycle (issue #355)',
      ),
    ).toBe('the-scribe-scratch-sweep--a-repo-internal-location-that-had-no-lifecycle-issue-355');

    // A markdown link inside a heading contributes its LABEL only — the
    // url's own word-characters (`docs`, `adr`, `0030`, …) must not leak in.
    expect(
      slugifyHeading(
        '6. Documented-form comparison *(required when the row\'s core path is unexecutable — [ADR-0030](../../docs/adr/0030-deferred-core-path-requires-documented-form-comparison.md))*',
      ),
    ).not.toMatch(/docs|deferred|comparison-md/);
  });

  it('every real #anchor fragment in the corpus resolves against its target headings (a guard that matches nothing is green for the wrong reason)', () => {
    const withFragments = ALL_ANCHORED.filter((ref) => ref.target.includes('#'));
    expect(withFragments.length).toBeGreaterThan(0);
    const bad = withFragments
      .map((ref) => [ref, verifyAnchorFragment(ref)] as const)
      .filter(([, verdict]) => verdict === 'dead' || verdict === 'out-of-scope')
      .map(([ref, verdict]) => `${ref.file} → ${ref.target}  [${verdict}]`);
    expect(
      bad,
      `cross-reference link(s) whose #anchor fragment does not resolve against the target ` +
        `file's own headings ('dead'), or whose target file sits outside the guarded ` +
        `.claude/skills+.claude/agents population this guard reads headings from ` +
        `('out-of-scope' — see verifyAnchorFragment's docstring for why that fails rather ` +
        `than skips). Fix the heading reference, or the heading itself:\n  ` + bad.join('\n  '),
    ).toEqual([]);
  });

  it('negative control — a planted dead fragment on a real, guarded target file fails the same predicate', () => {
    const planted: Reference = {
      file: '.claude/skills/wave-setup/SKILL.md',
      target: 'reference/setup-mechanics.md#this-heading-does-not-exist-anywhere',
    };
    expect(verifyAnchorFragment(planted)).toBe('dead');
  });

  it('positive control — a live fragment on a real, guarded target resolves through the same pipeline', () => {
    const live: Reference = {
      file: '.claude/skills/wave-setup/SKILL.md',
      target: 'reference/setup-mechanics.md#github-token-permissions',
    };
    expect(verifyAnchorFragment(live)).toBe('ok');
  });

  it('a link with no fragment is untouched by this predicate — the dead-path check alone still governs it', () => {
    const noFragment: Reference = {
      file: '.claude/skills/wave-plan/SKILL.md',
      target: '../wave-shared/SKILL.md',
    };
    expect(verifyAnchorFragment(noFragment)).toBe('no-fragment');
  });

  it('out-of-scope — a fragment into a real file outside .claude/skills and .claude/agents fails CLOSED, not silently', () => {
    // The target file genuinely exists and the class-(a) dead-path predicate
    // already resolves it — proving 'out-of-scope' below is a scope
    // decision, not a disguised dead-path failure.
    const outside: Reference = {
      file: '.claude/skills/wave-reviewer/SKILL.md',
      target: '../../../docs/adr/0004-ac-ground-truth-is-the-reviewer-verdict.md#amendment-2026-07-28',
    };
    expect(resolveAnchoredLink(outside)).toBe(true);
    expect(verifyAnchorFragment(outside)).toBe('out-of-scope');
  });

  it('a repeated heading slug within one file gets the same de-duplication suffix GitHub uses', () => {
    const anchors = headingAnchors('## Setup\n\nbody\n\n## Setup\n\nbody again\n\n## Setup\n\nonce more\n');
    expect(anchors).toEqual(new Set(['setup', 'setup-1', 'setup-2']));
  });
});

// ─── class (b): bare path citations resolve clone-root-relative ──────────────

describe('skill-reference-guard — class (b): bare path citations resolve clone-root-relative', () => {
  it('finds the bare-citation population', () => {
    expect(ALL_CITATIONS.length).toBeGreaterThanOrEqual(MIN_BARE_CITATIONS);
  });

  it('every bare path citation exists in the plugin clone', () => {
    const dead = [
      ...new Set(
        ALL_CITATIONS.filter((ref) => !resolveCloneRootCitation(ref)).map(
          (ref) => `${ref.target}  (cited in ${ref.file})`,
        ),
      ),
    ];
    expect(
      dead,
      `bare path citation(s) naming something the plugin clone does not carry. ` +
        `These are evidence identifiers read CLONE-ROOT-relative — the predicate ` +
        `is existence, which is what buys rename/deletion protection. Repoint the ` +
        `prose at what survives (do NOT demote the citation to a slug — ADR-0031 ` +
        `rejected that), or, for a genuinely gitignored runtime path, add its ` +
        `prefix to RUNTIME_ARTIFACT_PREFIXES:\n  ` +
        dead.join('\n  '),
    ).toEqual([]);
  });

  it('the retro and ADR citations really are in the population (they are the rename-protection case)', () => {
    const targets = new Set(ALL_CITATIONS.map((r) => r.target));
    expect([...targets].some((t) => t.startsWith('docs/retros/'))).toBe(true);
    expect([...targets].some((t) => t.startsWith('tools/wave/src/'))).toBe(true);
  });

  it('negative control — a planted dead bare citation fails the same predicate', () => {
    const planted = extractBarePathCitations(
      'the plan lives in `docs/superpowers/plans/2026-06-06-p7-overview.md` — read it first\n',
      '.claude/skills/README.md',
    );
    expect(planted).toHaveLength(1);
    expect(resolveCloneRootCitation(planted[0])).toBe(false); // the real day-one prey
  });

  it('positive control — a live citation resolves, and a runtime artifact is out of class', () => {
    const live = extractBarePathCitations(
      'see `docs/CHARTER.md` for the split\n',
      '.claude/skills/README.md',
    );
    expect(live).toHaveLength(1);
    expect(resolveCloneRootCitation(live[0])).toBe(true);

    // Gitignored runtime paths must never enter the class — asserting their
    // existence in a clone would be a category error, not a finding.
    expect(
      extractBarePathCitations(
        'the spine is `.flotilla/waves/<slug>.md` and permissions sit in `.claude/settings.local.json`\n',
        '.claude/skills/wave-close/SKILL.md',
      ),
    ).toEqual([]);

    // A file-relative code span is class (a) territory, not clone-root.
    expect(
      extractBarePathCitations('full flags: `reference/routing-mechanics.md`\n', '.claude/skills/x.md'),
    ).toEqual([]);
  });
});

// ─── class (c): `{{wave-cli}}` resolution blocks state the binding ───────────

describe('skill-reference-guard — class (c): every {{wave-cli}} resolution block states the binding', () => {
  it('finds every canonical resolution block', () => {
    expect(ALL_BLOCKS.length).toBe(EXPECTED_RESOLUTION_BLOCKS);
    // Named spot-checks across the pipeline's two halves, so renaming a heading
    // out of the pattern cannot quietly shrink the population.
    const files = new Set(ALL_BLOCKS.map((b) => b.file));
    for (const f of [
      '.claude/skills/wave-close/reference/close-mechanics.md',
      '.claude/skills/wave-plan/reference/plan-mechanics.md',
      '.claude/skills/wave-start/reference/start-mechanics.md',
      '.claude/skills/wave-shared/reference/routing-mechanics.md',
      '.claude/skills/wave-setup/reference/setup-mechanics.md',
      '.claude/skills/wave-resume/reference/resume-mechanics.md',
      '.claude/skills/wave-create/reference/create-mechanics.md',
      '.claude/skills/triage/reference/triage-mechanics.md',
      '.claude/skills/to-issues/reference/filing-mechanics.md',
      '.claude/skills/to-prd/reference/filing-mechanics.md',
    ]) {
      expect(files, `no {{wave-cli}} resolution block found in ${f}`).toContain(f);
    }
  });

  it('every resolution block states the binding and ranks no invocation form', () => {
    const offenders = ALL_BLOCKS.map((b) => [b, bindingFormViolation(b)] as const)
      .filter(([, why]) => why !== null)
      .map(([b, why]) => `${b.file}: ${why}`);
    expect(
      offenders,
      `{{wave-cli}} resolution block(s) not stated as a BINDING (ADR-0032). A block reads ` +
        `\`engine.cli\` out of the wave config and says an absent binding is a STOP pointing ` +
        `at wave-setup; it never orders invocation forms, because ADR-0032 abolished the ` +
        `fallback chain and left the forms themselves in exactly one place — wave-setup's ` +
        `scaffold:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('the wave-setup block passes on its MERITS, not on an incidental form pair', () => {
    // This block is the one place invocation forms legitimately appear (the
    // pre-setup bootstrap path and flotilla's own vendored exception), so it is
    // the sharpest test of the predicate's discrimination: it must pass BECAUSE
    // it states the binding rule, and the naming of two forms must not be what
    // carries it. The superseded predicate passed this block for exactly the
    // wrong reason — it read that incidental pair as a compliant dual-form
    // statement — which is how a green guard stopped asserting what it was
    // written to assert.
    const setup = ALL_BLOCKS.filter(
      (b) => b.file === '.claude/skills/wave-setup/reference/setup-mechanics.md',
    );
    expect(setup).toHaveLength(1);
    expect(bindingFormViolation(setup[0])).toBeNull();
    // It really does name forms — so the pass above is the discrimination
    // working, not an absence of anything to discriminate.
    expect(namedForms(setup[0].body).length).toBeGreaterThanOrEqual(2);
    // …and it really does state the rule the predicate credits it for.
    expect(BINDING_FIELD.test(setup[0].body)).toBe(true);
    expect(BINDING_SOURCE.test(setup[0].body)).toBe(true);
  });

  it('negative control — a planted DUAL-FORM block fails the rewritten predicate (AC4)', () => {
    // The exact superseded shape, verbatim in spirit: two forms, ordered, with
    // one named the canonical resolution and the other the documented fallback.
    // It even names `engine.cli` and the config file, so it clears the positive
    // half — what rejects it is the RANKING, which is the whole point.
    const planted: ResolutionBlock = {
      file: 'x.md',
      heading: '`{{wave-cli}}` resolution',
      body:
        'The wave engine CLI, stated dual-form: the canonical resolution is the published npm ' +
        'package `npx @formtrieb/flotilla-engine`, recorded as `engine.cli` in `wave.config.json`. ' +
        'The vendored in-repo form `npx tsx tools/wave/src/cli.ts` stays documented as the ' +
        'fallback; both reach the identical router. An absent binding is a STOP — finish ' +
        'wave-setup first.',
    };
    const why = bindingFormViolation(planted);
    expect(why).toMatch(/RANKS invocation forms/);
    expect(why).toMatch(/npx published-package form/);

    // …and the same body with the ranking removed passes, so the rejection is
    // attributable to the ordering and to nothing else in the plant.
    expect(
      bindingFormViolation({
        ...planted,
        body:
          'The wave engine CLI. `{{wave-cli}}` IS the command string `wave.config.json` names ' +
          'under `engine.cli`. An absent binding is a STOP: finish wave-setup before running ' +
          'a verb.',
      }),
    ).toBeNull();
  });

  /**
   * Verbatim reproduction (git commit `3767cb0`, the ADR-0031 shape, before
   * PR #313 rewrote it to ADR-0032) of the two violating clauses inside
   * `.claude/skills/README.md`'s "1. Sync engine ops" list item — hard-wrapped
   * exactly as authored. Clause 1 ("canonical" + the npx form) sits on one
   * un-wrapped physical line. Clause 2 ("fallback"/"both reach" + the vendored
   * form) straddles a wrap: the form is on one physical line, the ranking
   * words on the next.
   */
  const README_PRE_ADR0032_PARAGRAPH =
    '   Each SKILL.md writes the engine invocation as the token **`{{wave-cli}}`** so\n' +
    '   it stays portable. The canonical resolution is **`npx @formtrieb/flotilla-engine\n' +
    '   <subcommand>`** — the published npm package `wave-setup` scaffolds onto the\n' +
    "   consumer's own allowlist, so a plugin consumer never needs a vendored\n" +
    '   `tools/wave` path. (This repo is simultaneously the plugin source and a\n' +
    '   dogfood consumer of its own skills, so its own tracked allowlist additionally\n' +
    '   keeps the vendored `npx tsx tools/wave/src/cli.ts` / local-binary forms as a\n' +
    '   fallback — both reach the identical router.)\n' +
    '   The router (`tools/wave/src/cli.ts`) dispatches to the per-subcommand runner\n' +
    '   and returns a JSON result + a meaningful exit code. Subcommands:\n' +
    '   `dor`, `files-drift`, `merge-order`, `closed-by`, `detect-host`,\n' +
    '   `worktree-cleanup`, `conflict-map`, `cross-wave`, `issue-store`, `spine`,\n' +
    '   `resume`. The store behind `issue-store` is chosen from `wave.config.json`\n' +
    '   (Markdown-FS or GitHub Issues), so skills never hard-code a tracker — they\n' +
    '   stay tracker-agnostic by construction.\n';

  /** Clause 2 alone (the missed one), isolated so a co-located violation can be
   * attributed to the wrap fix specifically and not to clause 1's presence. */
  const README_PRE_ADR0032_FALLBACK_CLAUSE =
    '   `tools/wave` path. (This repo is simultaneously the plugin source and a\n' +
    '   dogfood consumer of its own skills, so its own tracked allowlist additionally\n' +
    '   keeps the vendored `npx tsx tools/wave/src/cli.ts` / local-binary forms as a\n' +
    '   fallback — both reach the identical router.)\n';

  /**
   * The PRE-FIX sentence splitter (issue #314) — kept ONLY as falsification
   * evidence (Convention 11). It is `sentences()` exactly as it shipped before
   * this fix: no hard-wrap fold, so every raw line break — wrap-induced or
   * not — ends a "sentence".
   */
  function preFixSentences(body: string): string[] {
    return body
      .replace(/([.!?][)\]*_`"'”’]*)\s+/g, '$1\n')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  it('regression — a hard-wrapped named form and its ranking word, reproduced verbatim from the pre-ADR-0032 README, is now detected (AC1, issue #314 Hole 1)', () => {
    // Falsification (Convention 11): the OLD per-line splitter really did miss
    // the second clause. It caught clause 1 (the form and "canonical" share an
    // un-wrapped physical line) but never saw clause 2's form and its ranking
    // words co-occur, because a bare wrap-induced line break split them apart —
    // this is the exact day-one miss the issue describes ("the sweep flagged
    // ONE — the second straddled a wrap").
    const preFixHits = preFixSentences(README_PRE_ADR0032_PARAGRAPH).filter(
      (s) => namedForms(s).length > 0 && FORM_RANKING_LANGUAGE.test(s),
    );
    expect(preFixHits).toHaveLength(1);
    expect(preFixHits[0]).toMatch(/canonical/);
    expect(preFixHits.some((s) => /fallback/.test(s) || /both reach/.test(s))).toBe(false);

    // The fix: through the fold-then-split pipeline, BOTH clauses now surface —
    // the wrap no longer defeats co-location.
    const fixedHits = sentences(README_PRE_ADR0032_PARAGRAPH).filter(
      (s) => namedForms(s).length > 0 && FORM_RANKING_LANGUAGE.test(s),
    );
    expect(fixedHits.length).toBeGreaterThanOrEqual(2);
    expect(fixedHits.some((s) => /canonical/.test(s))).toBe(true);
    expect(fixedHits.some((s) => /fallback/.test(s) && /both reach/.test(s))).toBe(true);

    // End to end through the real predicate: clause 2 ALONE (no "canonical"
    // anywhere in scope) is enough to trip a RANKS violation once the wrap is
    // folded — isolating that the fold, not the vocabulary, is what changed.
    const isolated: ResolutionBlock = {
      file: 'x.md',
      heading: '`{{wave-cli}}` resolution',
      body:
        'The wave engine CLI. `{{wave-cli}}` IS the command string `wave.config.json` names ' +
        'under `engine.cli`. An absent binding is a STOP: finish wave-setup before running ' +
        'a verb.\n\n' +
        README_PRE_ADR0032_FALLBACK_CLAUSE,
    };
    expect(namedForms(README_PRE_ADR0032_FALLBACK_CLAUSE).length).toBeGreaterThan(0);
    const why = bindingFormViolation(isolated);
    expect(why).toMatch(/RANKS invocation forms/);
    expect(why).toMatch(/vendored in-repo form/);
  });

  it('negative control — the live wave-setup "instead" sentence and the convention-01 wrapped fallback+invocation pair still pass after the hard-wrap fix (AC2, issue #314)', () => {
    // wave-setup's own block genuinely co-locates a named vendored form with
    // "instead" in one (un-wrapped) sentence, and must keep passing: "instead"
    // states WHICH form a consumer binds to, not an ordering between two forms
    // (the reason FORM_RANKING_LANGUAGE excludes it — see its docstring).
    const setup = ALL_BLOCKS.filter(
      (b) => b.file === '.claude/skills/wave-setup/reference/setup-mechanics.md',
    );
    expect(setup).toHaveLength(1);
    const insteadSentence = sentences(setup[0].body).find(
      (s) => /\binstead\b/.test(s) && namedForms(s).length > 0,
    );
    expect(
      insteadSentence,
      'expected a live sentence pairing a named form with "instead" — the negative control is vacuous without it',
    ).toBeDefined();
    expect(FORM_RANKING_LANGUAGE.test(insteadSentence as string)).toBe(false);
    expect(bindingFormViolation(setup[0])).toBeNull();

    // convention-01-auth-preflight.md is NOT a {{wave-cli}} resolution block
    // (its heading names neither token, so it never enters ALL_BLOCKS) — but it
    // carries the exact SHAPE the wrap fix could sweep up by accident: a
    // "documented fallback" sentence and a concrete vendored invocation
    // (`npx tsx tools/wave/src/cli.ts`) on separate raw lines inside a fenced
    // code sample. What keeps them apart is a genuine blank BLOCKQUOTE line
    // between them — a real paragraph break, not a wrap — which
    // `joinHardWraps` must still respect. Read live off disk, not hardcoded, so
    // a future edit to this file cannot silently stop exercising the control.
    const proxyFlagDoc = SOURCES.get(
      '.claude/skills/wave-shared/reference/convention-01-auth-preflight.md',
    ) as string;
    expect(proxyFlagDoc).toMatch(/documented fallback/);
    expect(namedForms(proxyFlagDoc).length).toBeGreaterThan(0);

    const synthetic: ResolutionBlock = {
      file: '.claude/skills/wave-shared/reference/convention-01-auth-preflight.md',
      heading: '`{{wave-cli}}` resolution',
      body:
        'The wave engine CLI. `{{wave-cli}}` IS the command string `wave.config.json` names ' +
        'under `engine.cli`. An absent binding is a STOP: finish wave-setup before running ' +
        'a verb.\n\n' +
        proxyFlagDoc,
    };
    const ranked = sentences(synthetic.body).filter(
      (s) => namedForms(s).length > 0 && FORM_RANKING_LANGUAGE.test(s),
    );
    expect(ranked).toEqual([]);
    expect(bindingFormViolation(synthetic)).toBeNull();
  });

  it('negative controls — each missing half of the binding statement is named', () => {
    const stated: ResolutionBlock = {
      file: 'x.md',
      heading: '`{{wave-cli}}` resolution',
      body:
        'The wave engine CLI. `{{wave-cli}}` IS the command string this repo\'s ' +
        '`wave.config.json` names under `engine.cli`. An absent binding is a STOP: it means ' +
        'wave-setup has not finished here.',
    };
    expect(bindingFormViolation(stated)).toBeNull();

    expect(
      bindingFormViolation({ ...stated, body: 'The wave engine CLI. Your setup pins how it resolves.' }),
    ).toMatch(/never names the `engine\.cli` binding/);

    expect(
      bindingFormViolation({
        ...stated,
        body: 'The wave engine CLI. Read `engine.cli`. An absent binding is a STOP — finish wave-setup.',
      }),
    ).toMatch(/not the wave config it is read from/);

    expect(
      bindingFormViolation({
        ...stated,
        body: 'The wave engine CLI. `engine.cli` in `wave.config.json` is the binding.',
      }),
    ).toMatch(/never says what an ABSENT binding means/);

    // The three absent-STOP words must land in ONE sentence — scattered across
    // a block they are a coincidence, not a statement.
    expect(
      bindingFormViolation({
        ...stated,
        body:
          'The wave engine CLI. `engine.cli` in `wave.config.json` is the binding. ' +
          'Run wave-setup once per repo. A failing verb is a STOP. Nothing is absent here.',
      }),
    ).toMatch(/never says what an ABSENT binding means/);
  });

  it('positive control — naming a form WITHOUT ranking it is not a violation', () => {
    // The discrimination the predicate has to make, in isolation: wave-setup's
    // shape (forms named for a bootstrap path and a documented exception) vs.
    // the ADR-0031 shape (forms ordered as invocation alternatives).
    const incidental =
      'The wave engine CLI. `{{wave-cli}}` IS the command string `wave.config.json` names under ' +
      '`engine.cli`. An absent binding is a STOP: wave-setup has not finished. ' +
      'Before that binding exists, a prospective consumer can explore with `npx ' +
      '@formtrieb/flotilla-engine <verb>`. flotilla itself binds `engine.cli` to ' +
      '`./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts`, because it builds what it runs.';
    expect(namedForms(incidental)).toHaveLength(2);
    expect(
      bindingFormViolation({ file: 'x.md', heading: '`{{wave-cli}}` resolution', body: incidental }),
    ).toBeNull();

    // Stating that the fallback chain is ABOLISHED is the rule, not a breach of
    // it — a block-scoped word match could not tell those apart, which is why
    // the ranking check is sentence-scoped and form-gated.
    expect(
      bindingFormViolation({
        file: 'x.md',
        heading: '`{{wave-cli}}` resolution',
        body:
          `${incidental} There is no invocation-form ordering and no fallback chain to reason ` +
          'through — ADR-0032 abolished both.',
      }),
    ).toBeNull();
  });

  it('negative control — a resolution block that loses its heading drops out of the population', () => {
    // The extractor is heading-driven, so "rename the heading" is the way this
    // guard could be defeated without a single reference changing. Pin that the
    // pattern is what it claims to be.
    expect(
      extractResolutionBlocks('## `{{wave-cli}}` resolution\n\nbody\n', 'x.md'),
    ).toHaveLength(1);
    expect(
      extractResolutionBlocks('## `{{wave-cli}}` resolution + the `resume` subcommand\n\nbody\n', 'x.md'),
    ).toHaveLength(1);
    expect(extractResolutionBlocks('## CLI setup\n\nbody\n', 'x.md')).toHaveLength(0);
  });
});

// ─── class (d): Convention 14 — citations sit in provenance positions ────────

describe('skill-reference-guard — class (d): Convention 14 citation placement in SKILL.md bodies', () => {
  it('finds the SKILL.md-body citation population (a guard that matches nothing is green for the wrong reason)', () => {
    expect(SKILL_BODIES.length).toBeGreaterThanOrEqual(MIN_SKILL_BODIES);
    expect(SKILL_BODIES).toContain('.claude/skills/wave-shared/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/wave-start/SKILL.md');
    // Reference files are the sanctioned home for deep provenance, so they must
    // NOT be in this class — asserting the rule against them would forbid the
    // very position the convention recommends.
    expect(SKILL_BODIES).not.toContain(
      '.claude/skills/wave-shared/reference/convention-14-citation-placement.md',
    );
    // The agent brief in .claude/agents/ is a dispatched brief, not a skill
    // body, and is kept out of this class ONLY by the `/SKILL.md` filename
    // filter above — no file under .claude/agents/ happens to be named
    // SKILL.md today. Pin the exclusion the same way the reference-file
    // exclusion is pinned just above, so a future agent brief literally named
    // SKILL.md cannot silently enter the population (the negative control
    // below proves this pin is not vacuous).
    expect(SKILL_BODIES).not.toContain('.claude/agents/wave-reviewer.md');
    expect(ALL_CITATIONS_IN_BODIES.length).toBeGreaterThanOrEqual(MIN_BODY_CITATIONS);
    // The convention codifies what the corpus already does nine times out of
    // ten; if narrative placement were ever the majority the predicate would be
    // measuring something other than what it claims.
    expect(narrativeCitations(ALL_CITATIONS_IN_BODIES).length).toBeLessThan(
      ALL_CITATIONS_IN_BODIES.length / 2,
    );
  });

  it('negative control — a hypothetical agents-brief literally named SKILL.md would enter the population under the same filter (pins why the exclusion assertion above is needed)', () => {
    // Same predicate SKILL_BODIES is derived from (`f.endsWith('/SKILL.md')`),
    // applied to a synthetic path that does not exist in this corpus today.
    // The exclusion of .claude/agents/ from this class is filename-coincidental,
    // not structural: plant the one shape that would defeat it and watch it
    // pass the very filter that is supposed to keep agent briefs out.
    const hypotheticalAgentBrief = '.claude/agents/SKILL.md';
    expect(SKILL_DOCS).not.toContain(hypotheticalAgentBrief); // not real today
    expect(
      [...SKILL_DOCS, hypotheticalAgentBrief].filter((f) => f.endsWith('/SKILL.md')),
    ).toContain(hypotheticalAgentBrief);
    // Which is exactly what the dedicated pin above guards against: had this
    // hypothetical file been real, `expect(SKILL_BODIES).not.toContain(...)`
    // for it would have failed instead of silently letting a dispatched agent
    // brief into the Convention 14 population.
  });

  it('no SKILL.md body outside the legacy allowlist carries a citation in narrative prose', () => {
    const offenders = narrativeCitations(ALL_CITATIONS_IN_BODIES)
      .filter((c) => !CITATION_PLACEMENT_LEGACY.some((e) => e.file === c.file))
      .map((c) => `${c.file}:${c.line}  [${c.token}]  ${c.text.slice(0, 110)}`);
    expect(
      offenders,
      `citation(s) sitting in bare narrative prose inside a SKILL.md body (Convention 14). ` +
        `Keep the rule and its ONE-LINE why exactly where it is — an unexplained invariant ` +
        `invites an executing agent to improve it — and move the evidence to a provenance ` +
        `position: a compact trailing pointer "(ADR-NNNN)", a section under a provenance ` +
        `heading, or a reference file. Do NOT delete the citation, and do NOT add a new ` +
        `CITATION_PLACEMENT_LEGACY entry — that list is a shrinking legacy, not an escape hatch:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('every legacy entry is still needed, has not grown, and carries a justification (the ratchet)', () => {
    expect(
      new Set(CITATION_PLACEMENT_LEGACY.map((e) => e.file)).size,
      'duplicate file in CITATION_PLACEMENT_LEGACY — one entry per body',
    ).toBe(CITATION_PLACEMENT_LEGACY.length);

    for (const entry of CITATION_PLACEMENT_LEGACY) {
      expect(
        SKILL_BODIES,
        `stale legacy entry: ${entry.file} is no longer a shipped SKILL.md body`,
      ).toContain(entry.file);

      const actual = narrativeCitations(
        ALL_CITATIONS_IN_BODIES.filter((c) => c.file === entry.file),
      ).length;

      expect(
        actual,
        `obsolete legacy entry: ${entry.file} now places every citation in a provenance ` +
          `position — drop the entry (an allowlist that outlives its reason is a hole)`,
      ).toBeGreaterThan(0);
      expect(
        actual,
        `${entry.file} grew from ${entry.seeded} narrative citation(s) to ${actual}. The ` +
          `seeded count is a CEILING: a legacy body may shrink, never grow. Place the new ` +
          `citation as a trailing pointer instead of adding it to the pile.`,
      ).toBeLessThanOrEqual(entry.seeded);
      expect(entry.why.length).toBeGreaterThan(20); // a justification, not a shrug
    }
  });

  it('Convention 15 is registered under the number 15, with no same-number collision', () => {
    const conventionFile =
      '.claude/skills/wave-shared/reference/convention-15-coordinator-direct-boundary.md';
    expect(SKILL_DOCS).toContain(conventionFile);
    expect((SOURCES.get(conventionFile) as string).startsWith('## Convention 15 — ')).toBe(true);

    // Numbers are cited by siblings and are therefore never re-used and never
    // renumbered: filename number and heading number must agree, and no two
    // files may claim the same number.
    const numbered = SKILL_DOCS.filter((f) =>
      /^\.claude\/skills\/wave-shared\/reference\/convention-\d{2}-/.test(f),
    );
    const numberOf = (f: string): number => Number(/convention-(\d{2})-/.exec(f)?.[1]);
    const numbers = numbered.map(numberOf);
    expect(numbers.length).toBeGreaterThanOrEqual(15);
    expect(
      new Set(numbers).size,
      `two convention reference files claim the same number: ${numbered.join(', ')}`,
    ).toBe(numbers.length);
    expect(Math.max(...numbers)).toBe(HIGHEST_ALLOCATED_CONVENTION);
    for (const f of numbered) {
      expect(
        (SOURCES.get(f) as string).startsWith(`## Convention ${numberOf(f)} — `),
        `${f} does not open with "## Convention ${numberOf(f)} — " — filename and heading disagree`,
      ).toBe(true);
    }

    // The loader's allocation register names the same number, so two slices
    // planned in parallel cannot both reach for "the next one" and both land 15.
    expect(SOURCES.get('.claude/skills/wave-shared/SKILL.md') as string).toContain(
      `the highest allocated Convention number is **${HIGHEST_ALLOCATED_CONVENTION}**`,
    );
  });

  it('the register REPLACED its one-liner along with its counter (the register\'s own rule)', () => {
    // The register holds exactly two things: the heading's embedded number and
    // a one-liner for whichever convention currently holds it. Bumping only the
    // number strands the PREVIOUS convention's description under a heading that
    // no longer matches it — the defect the content-shape decision closes, and
    // one a counter-only assertion cannot see. So pin the pairing itself: the
    // register's one-liner must open with the allocated number and point at the
    // reference file that carries it.
    const register = SOURCES.get('.claude/skills/wave-shared/SKILL.md') as string;
    const n = HIGHEST_ALLOCATED_CONVENTION;
    const oneLiner = new RegExp(
      `^\\*\\*${n} — .+\\*\\* \\(\\[convention-${n}-[a-z0-9-]+\\.md\\]\\(reference/convention-${n}-[a-z0-9-]+\\.md\\)\\):`,
      'm',
    );
    expect(
      oneLiner.test(register),
      `the number-allocation register names ${n} as the highest allocated Convention number, but ` +
        `carries no matching "**${n} — <description>** ([convention-${n}-….md](reference/convention-${n}-….md)): …" ` +
        `one-liner. Replace the heading number AND the one-liner together — a stale description ` +
        `under a bumped counter is the exact defect the register's content shape exists to prevent.`,
    ).toBe(true);

    // …and the SUPERSEDED convention's one-liner is gone, so the register never
    // accumulates a second description (it is a counter, not an index — the
    // per-convention index line is what ADR-0028 rejected).
    expect(
      new RegExp(`^\\*\\*${n - 1} — `, 'm').test(register),
      `the register still carries a one-liner for Convention ${n - 1}. It holds ONE description — ` +
        `the newest — never an accumulating index.`,
    ).toBe(false);
  });

  it('negative control — a planted narrative citation fails the same predicate', () => {
    // Same extractor, same predicate, same allowlist filter as the real
    // assertion above, on a real corpus body that is NOT on the legacy list.
    const host = '.claude/skills/wave-plan/SKILL.md';
    expect(CITATION_PLACEMENT_LEGACY.some((e) => e.file === host)).toBe(false);
    const original = SOURCES.get(host) as string;
    expect(narrativeCitations(extractCitations(original, host))).toEqual([]);

    const planted = extractCitations(
      `${original}\n## Planted\n\nThe cross-wave check stays advisory because ADR-0007 made Risk config-authoritative, as W4-F1 showed.\n`,
      host,
    );
    const offenders = narrativeCitations(planted).filter(
      (c) => !CITATION_PLACEMENT_LEGACY.some((e) => e.file === c.file),
    );
    expect(offenders.map((c) => c.token)).toEqual(['ADR-0007', 'W4-F1']);
  });

  it('positive control — the same citation passes in each of the three sanctioned positions', () => {
    const host = '.claude/skills/wave-plan/SKILL.md';

    // (1) compact trailing pointer
    expect(
      extractCitations(
        'Risk is config-authoritative and never re-derived from prose (ADR-0007).\n',
        host,
      ).map((c) => c.placement),
    ).toEqual(['trailing-pointer']);

    // (2) provenance block
    expect(
      extractCitations('### Live occurrences (evidence)\n\nADR-0007 settled this after W4-F1.\n', host).map(
        (c) => c.placement,
      ),
    ).toEqual(['provenance-block', 'provenance-block']);

    // (3) fenced code — a command or sample naming a path is not narrative prose
    expect(
      extractCitations(
        '```bash\ngrep -n Risk docs/adr/0007-risk-is-a-load-bearing-key-config-authoritative.md\n```\n',
        host,
      ),
    ).toEqual([]);

    // And the design choice that decides the ambiguous case: a markdown link's
    // LABEL is narrative text, its TARGET is a pointer.
    expect(
      extractCitations(
        'Per [ADR-0016](../../../docs/adr/0016-spine-creation-is-an-engine-owned-renderspine.md) the frontmatter is markdown.\n',
        host,
      ).map((c) => c.placement),
    ).toEqual(['narrative', 'trailing-pointer']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wave-plan currency — two flags must keep stating what they DERIVE
//
// Both assertions below pin prose that a consumer field report paid for. They
// are currency assertions in the same family as the ones above: the risk is not
// that the wording is wrong today, but that a later edit quietly restores the
// claim the fix retired, and nothing else in the suite would notice — these are
// skill DOCS, so vitest and tsc pass over them trivially.
//
// (1) The PRD panel's flag derives "this PRD has no OPEN slices". It cannot
//     derive "never sliced": a closed slice leaves the candidate set carrying
//     its `parent` backlink with it, so a fully-shipped PRD and a never-sliced
//     one render identically, and the false-positive rate GROWS with repo
//     history. Live: the first external 1.0.0 consumer's panel flagged six of
//     seven PRDs, all six fully shipped; the retired wording's prescribed
//     action would have re-sliced six finished planning documents.
//
// (2) `blockedBy` is `'none' | IssueRef[]`, and `'none'.length === 4` — so a
//     bare `.length` reports FOUR blockers for a row that has none, beside a
//     genuine count that makes the table look consistent. Types do not catch
//     it (`.length` is valid on both members); the skill layer reads the field
//     as CLI JSON anyway. Live: a consumer published that table to its operator.
// ─────────────────────────────────────────────────────────────────────────────
describe('skill-reference-guard — wave-plan currency: derived flags state what they derive', () => {
  const SKILL = '.claude/skills/wave-plan/SKILL.md';
  const MECHANICS = '.claude/skills/wave-plan/reference/plan-mechanics.md';

  /** The retired claim, in the two spellings the fix removed. */
  const claimsNeverSliced = (body: string): boolean =>
    /An un-consumed PRD has no slices yet/.test(body) ||
    /consumed\(prd\)\s*=/.test(body) ||
    /flag the un-consumed ones/.test(body);

  /**
   * Lines that read a `length` off the union WITHOUT narrowing it first.
   *
   * Line-scoped rather than body-scoped on purpose: both documents must QUOTE
   * the wrong idiom in order to forbid it, and inside the correct `jq` recipe
   * the substring `.blockedBy | length` legitimately appears — guarded, on the
   * same line, by the `type` test that makes it correct. A body-wide regex
   * would therefore fire on the very wording that fixes the bug. What is
   * actually forbidden is an UNGUARDED read, so that is what the predicate
   * looks for.
   */
  const unNarrowedLengthLines = (body: string): string[] =>
    body
      .split('\n')
      .filter((line) => /\.blockedBy\s*\|\s*length|blockedBy\.length/.test(line))
      .filter((line) => !/Array\.isArray|type\)\s*==\s*"array"/.test(line));

  it('the PRD flag is stated as "no open slices", and the never-sliced claim is gone', () => {
    for (const file of [SKILL, MECHANICS]) {
      const body = SOURCES.get(file) as string;
      expect(body, `${file} is missing from the corpus`).toBeTruthy();
      expect(
        claimsNeverSliced(body),
        `${file} still claims the PRD flag derives "never sliced"/"un-consumed". It derives ` +
          `"no OPEN slices" — a closed slice takes its parent backlink out of the candidate ` +
          `set, so a shipped PRD is indistinguishable from a never-sliced one.`,
      ).toBe(false);
      expect(
        /no open slices/i.test(body),
        `${file} must state the flag as "no open slices" — the phrase is what keeps the ` +
          `panel from asserting something it cannot know.`,
      ).toBe(true);
    }
  });

  it('the flagged-PRD action is a check, not a slice imperative', () => {
    const skill = SOURCES.get(SKILL) as string;
    expect(
      /check, not a slice/i.test(skill),
      'wave-plan SKILL step 4 must prescribe a CHECK for a flagged PRD — following a bare ' +
        '"run to-issues to slice" re-slices finished PRDs on any repo with shipped history.',
    ).toBe(true);
    expect(
      /closed/i.test(skill),
      'the prescribed check must name CLOSED issues as where the missing evidence lives — ' +
        'that is the one place that distinguishes "sliced and shipped" from "never sliced".',
    ).toBe(true);
  });

  it('the blockedBy union is named where the skill layer reads it, with the narrowing idiom', () => {
    const mechanics = SOURCES.get(MECHANICS) as string;
    expect(
      /'none'\s*\|\s*IssueRef\[\]/.test(mechanics),
      'plan-mechanics must name the blockedBy union beside the ScopedIssue composition note — ' +
        'the asymmetry (one field explained, the neighbouring one silent) is what made a ' +
        'consumer trust a bare count.',
    ).toBe(true);
    expect(
      /'none'\.length === 4/.test(mechanics),
      'plan-mechanics must state the concrete trap value: ‘none’.length === 4.',
    ).toBe(true);
    expect(
      /Array\.isArray/.test(mechanics),
      'plan-mechanics must give the narrowing idiom, not only the warning.',
    ).toBe(true);

    const skill = SOURCES.get(SKILL) as string;
    expect(
      /Array\.isArray/.test(skill),
      'wave-plan SKILL step 5 asks the Coordinator to report Blocked-by per candidate — it must ' +
        'prescribe the narrowing read there, at the step where the wrong one gets typed.',
    ).toBe(true);
  });

  it('neither document leaves an un-narrowed .length read of the union', () => {
    for (const file of [SKILL, MECHANICS]) {
      const body = SOURCES.get(file) as string;
      expect(
        unNarrowedLengthLines(body),
        `${file} has a line reading length off blockedBy without narrowing it first — that is ` +
          `the exact shape that reports 4 blockers for an unblocked row.`,
      ).toEqual([]);
    }
  });

  it('negative control — the retired wordings fail the same predicates', () => {
    // Proves both predicates can actually fire (wave-shared Convention 11): a
    // green assertion is compatible with "the check works" AND "the check
    // cannot fail", and nothing else here distinguishes them.
    expect(claimsNeverSliced('An un-consumed PRD has no slices yet. Flag it.')).toBe(true);
    expect(claimsNeverSliced('consumed(prd) = candidates.some(c => c.parent === prd.id)')).toBe(true);
    expect(claimsNeverSliced('List every PRD and flag the un-consumed ones — a PRD is consumed iff')).toBe(true);
    expect(unNarrowedLengthLines(`jq -r '.[] | .blockedBy | length'`)).toHaveLength(1);
    expect(unNarrowedLengthLines('const n = row.blockedBy.length')).toHaveLength(1);

    // And that they do NOT fire on the current, corrected wording — including
    // the correct `jq` recipe, whose own text CONTAINS the forbidden substring
    // and is exempted only by the narrowing test sitting on the same line.
    expect(claimsNeverSliced('The panel flags PRDs with no open slices; check closed issues before slicing.')).toBe(false);
    expect(unNarrowedLengthLines('Array.isArray(b) ? b.length : 0')).toEqual([]);
    expect(
      unNarrowedLengthLines(`if (.blockedBy | type) == "array" then (.blockedBy | length) else 0 end`),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wave-setup currency — the store-preflight verb name agrees across the skill
// pair.
//
// Issue #77 folded the once-separate `cli-store.ts` entrypoint into the
// `cli.ts` router and renamed its verb to `store-preflight`
// (setup-mechanics.md's own "Unified subcommand form" note documents this as
// the canonical name since the unification). SKILL.md kept spelling the
// retired `cli-store preflight` form in five places even after the reference
// file it points readers at had already moved on — the two halves of one
// skill disagreeing about the name of the verb they both instruct an agent to
// run. This is a currency assertion in the same family as wave-plan's above:
// the risk is not that today's wording is wrong, but that a later edit
// quietly reintroduces the retired spelling in one file without the other,
// and nothing else in the suite would notice — these are skill DOCS, so
// vitest and tsc pass over them trivially.
// ─────────────────────────────────────────────────────────────────────────────
describe('skill-reference-guard — wave-setup currency: the store-preflight verb name agrees across the skill pair', () => {
  const SKILL = '.claude/skills/wave-setup/SKILL.md';
  const MECHANICS = '.claude/skills/wave-setup/reference/setup-mechanics.md';

  /** The unified spelling since issue #77 — setup-mechanics.md's own "Unified
   * subcommand form" note is the canonical source for this name. */
  const CANONICAL_STORE_PREFLIGHT_VERB = 'store-preflight';

  /**
   * Every inline-code span spelling either the retired or the unified verb.
   * Scoped to exactly these two candidates — not a bare `/preflight/` sweep —
   * so a legitimate different verb (`host-pr preflight`, a separate owner
   * entirely) never enters this population.
   */
  const STORE_PREFLIGHT_VERB_SPAN = /`(cli-store preflight|store-preflight)`/g;

  const storePreflightVerbSpellings = (body: string): string[] =>
    [...body.matchAll(STORE_PREFLIGHT_VERB_SPAN)].map((m) => m[1]);

  it('setup-mechanics.md documents store-preflight as the canonical unified form (issue #77)', () => {
    const mechanics = SOURCES.get(MECHANICS) as string;
    expect(mechanics).toMatch(/Unified subcommand form/);
    expect(storePreflightVerbSpellings(mechanics)).toContain(CANONICAL_STORE_PREFLIGHT_VERB);
  });

  it('finds a store-preflight verb population in both files (a guard that matches nothing is green for the wrong reason)', () => {
    expect(storePreflightVerbSpellings(SOURCES.get(SKILL) as string).length).toBeGreaterThan(0);
    expect(storePreflightVerbSpellings(SOURCES.get(MECHANICS) as string).length).toBeGreaterThan(0);
  });

  it('SKILL.md and setup-mechanics.md agree on ONE spelling of the store-preflight verb — no occurrence of the retired `cli-store preflight` survives in either', () => {
    const skillSpellings = storePreflightVerbSpellings(SOURCES.get(SKILL) as string);
    const mechanicsSpellings = storePreflightVerbSpellings(SOURCES.get(MECHANICS) as string);
    const allSpellings = [...new Set([...skillSpellings, ...mechanicsSpellings])];
    expect(
      allSpellings,
      `the wave-setup skill pair disagrees on the store-preflight verb name — found spelling(s) ` +
        `[${allSpellings.join(', ')}] across SKILL.md and setup-mechanics.md. The unified spelling ` +
        `since issue #77 is \`${CANONICAL_STORE_PREFLIGHT_VERB}\` (setup-mechanics.md's own "Unified ` +
        `subcommand form" note); \`cli-store preflight\` is the retired pre-unification spelling and ` +
        `must not survive in either file.`,
    ).toEqual([CANONICAL_STORE_PREFLIGHT_VERB]);
  });

  it('negative control — a planted retired-spelling occurrence fails the same predicate (Convention 11)', () => {
    // Same extractor, same predicate as the real assertion above, on a
    // synthetic line reproducing the exact pre-fix SKILL.md spelling.
    const planted = 'Run the `cli-store preflight` verb (step 6) to check tracker facts.\n';
    const plantedSpellings = storePreflightVerbSpellings(planted);
    expect(plantedSpellings).toEqual(['cli-store preflight']);

    const combined = [
      ...new Set([...storePreflightVerbSpellings(SOURCES.get(MECHANICS) as string), ...plantedSpellings]),
    ];
    expect(combined).not.toEqual([CANONICAL_STORE_PREFLIGHT_VERB]);
    expect(combined).toContain('cli-store preflight');
  });
});
