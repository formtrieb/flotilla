/**
 * skill-descriptions-guard.spec.ts — the YAML `description` in every skill's and
 * the Reviewer agent's frontmatter is written for the person installing flotilla,
 * not for the person who built it.
 *
 * ## The class this guards, and why the description line specifically
 *
 * The description is the **first** thing a consumer ever reads. The harness
 * renders the skill listing — one line per skill, that line — before any skill
 * has run, before any prose is loaded, before any term could have been
 * introduced. Every other surface in this corpus gets a chance to explain
 * itself first; this one does not, and it is read by someone who has been in
 * none of the rooms where the vocabulary was invented.
 *
 * It shipped in the maintainer's register anyway. A single listing, as it stood
 * before this guard, told a first-time adopter about a `Status:draft` spine,
 * `DoR`, the `WAL`, the `coarse ledger`, rows that are `HELD`, a `cap=1`
 * re-dispatch, `STOP→needs-attention`, and a bare `(ADR-0023)` pointing at a
 * file the npm package does not even ship. None of it was wrong; all of it was
 * addressed to the wrong reader.
 *
 * ## Two tiers, because the two failure modes are not the same shape
 *
 * **Tier 1 — id patterns.** A decision-record number, this repo's own tracker
 * key, a retro finding id, a convention number, a path into the evidence tree.
 * These are structurally recognizable: they are *shapes*, they carry no meaning
 * to anyone outside this repository, and a regex catches them exhaustively. A
 * pointer is not a translation — the reader who would have to open a file in
 * THIS repository to finish the sentence has not been told anything.
 *
 * **Tier 2 — a curated stop-list.** Internal state vocabulary has no shape to
 * match: `HELD`, `WAL`, `coarse ledger` are ordinary-looking words. So the
 * second tier is a hand-maintained list, and it is deliberately narrow. See the
 * VOCABULARY TRADEOFF note on {@link INTERNAL_VOCABULARY} for what that costs
 * and what widening it obliges.
 *
 * **Tier 3 — the trigger phrases survive.** A rewrite that reads beautifully
 * and drops `"start the wave <slug>"` has broken skill selection: the model
 * matches on this line, so the phrases are load-bearing text, not decoration.
 * A pure prose guard would have been perfectly green while the pipeline stopped
 * responding to the words its own documentation tells people to say. This tier
 * is why the rewrite could be made at all without a live selection test.
 *
 * **Tier 4 — the point of view.** The platform's own skill-authoring guidance
 * is unambiguous, and it is a rule about *discovery*, not about taste:
 *
 * > **Always write in third person**. The description is injected into the
 * > system prompt, and inconsistent point-of-view can cause discovery problems.
 * > Good: "Processes Excel files and generates reports" · Avoid: "I can help
 * > you process Excel files" · Avoid: "You can use this to process Excel files"
 *
 * That is the seam where this repo's own operator-register convention does NOT
 * reach. The register mandates direct address for output an operator READS —
 * this line is not that. It is system-prompt surface the model reads while
 * choosing a skill, before any operator is in the conversation at all, so the
 * platform's rule governs and the convention does not apply here. Six
 * descriptions drifted into second person and are corrected in the same diff
 * that adds this tier.
 *
 * ## The angle-bracket placeholders, and why they are still here
 *
 * The same authoring page says a `description` "Cannot contain XML tags", and
 * ten trigger-phrase placeholders across six descriptions (`<slug>` ×8,
 * `<branch>` ×1, `<goal>` ×1, counted at the description level) look like they
 * might be caught by that. They were tested rather than guessed at, against the
 * platform's own validator (`claude plugin validate --strict`), with controls:
 *
 *   - a control skill with no `description` key at all WARNED, proving the
 *     validator does read frontmatter descriptions;
 *   - a probe carrying `<slug>`/`<branch>`/`<goal>` inside trigger phrases
 *     passed clean;
 *   - a probe carrying a genuinely well-formed `<example>…</example>` element
 *     and a self-closing `<br/>` ALSO passed clean;
 *   - a probe with a 1,260-character description passed clean too.
 *
 * So the placeholders are byte-preserved: nothing rejects them, and tier 3
 * pins them verbatim anyway (the phrases are stored WITH their angle brackets),
 * which means a future rewrite cannot quietly "fix" them either.
 *
 * The last probe is the one worth remembering here: the shipped validator does
 * not enforce the documented 1,024-character ceiling. This guard is therefore
 * not a duplicate of an upstream check — on that bound it is the only check in
 * reach, which is exactly why it owes a real failing-side control rather than
 * an assertion about `String.prototype.padEnd`.
 *
 * ## Tier 5 — the document is valid YAML, and both readers agree on it
 *
 * Every tier above reads the description through a hand-rolled line extractor.
 * That extractor is *lenient in exactly the way the runtime is*, which is why
 * this whole corpus could be green for a hundred waves while five descriptions
 * were not valid YAML at all: an unquoted plain scalar containing `: `
 * (colon-space) is a mapping ambiguity, and a strict parser rejects the
 * document outright. `claude plugin validate --strict` said so once, on CLI
 * 2.1.232; nothing in this repository could, because the engine's dependency
 * doctrine (`node:*` plus `fast-glob` plus `micromatch`) meant no YAML parser
 * existed anywhere in `tools/wave` to disagree with the hand reader.
 *
 * "Said so once" is deliberate. Re-measured on CLI 2.1.233 with paired
 * controls — a no-description control skill still WARNS, so enumeration is
 * working; a control skill whose description is an unquoted colon-space plain
 * scalar passes clean — the validator no longer reports this class at all.
 * Borrowed strictness is not a check: it changed under this corpus inside a
 * single patch version, in the lenient direction, and the corpus would have
 * learned nothing. That is the whole argument for owning the class here.
 *
 * So tier 5 brings a real YAML parser in — as a **devDependency imported only
 * from this spec**, which is the one seam where that is free: the engine's
 * RUNTIME dependency list is untouched, exactly as `vitest` itself is a
 * devDependency. And it asserts two things, not one:
 *
 *   1. **The frontmatter parses.** A document a strict parser rejects is a
 *      document whose fields a strict consumer drops — today the runtime
 *      harness is lenient enough to read them anyway, but that leniency is
 *      unspecified, and a parser tightening in any harness release would take
 *      the descriptions with it.
 *   2. **The two readers agree.** The parsed `description` must equal the hand
 *      extraction, for every member of the population. This is the half that
 *      earns its keep: a document can parse *cleanly* and still not mean what
 *      the hand reader thinks it says, and then every tier above is measuring a
 *      string the model never sees. That is not hypothetical — see
 *      {@link KNOWN_UNGUARDED}.
 *
 * ## What this guard cannot do
 *
 * It cannot tell whether a description is *good*. "Does this sentence help a
 * stranger" is a judgement, and the runtime speech behaviour it belongs to
 * stays prose by decision. What is structurally checkable, and all that is
 * claimed here, is that no internal token reaches the listing, no trigger
 * phrase was lost on the way, and the register is the one the platform asks for.
 *
 * It also cannot observe **selection**. Whether the harness still picks each
 * skill when a person types its trigger phrase is only visible in a live
 * session, and no amount of file reading substitutes for that. Tier 3 is the
 * strongest proxy available from here — it proves the matched text survived —
 * and the live check stays deliberately outside this file, with the operator.
 * Nothing in this spec should grow into an attempt to fake it.
 *
 * Every predicate has a negative control beside it (wave-shared Convention 11),
 * and the strongest of them are not invented: they are the descriptions AS THEY
 * ACTUALLY SHIPPED, kept verbatim as fixtures, so the guard is proven red
 * against the exact corpus it was written to fix.
 *
 * Pure test — zero production change.
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is tools/wave/src —
 * three levels above the repo root.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastGlob from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../../..');
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');

/** The Reviewer subagent — same surface, same rule, different directory. */
const REVIEWER_AGENT_REL = '.claude/agents/wave-reviewer.md';

/**
 * The population floor. Fourteen skills plus one agent ship today. Pinned
 * exactly rather than as a floor: a guard that quietly stopped finding
 * frontmatter would be green for the wrong reason, and a fifteenth skill is a
 * deliberate edit here — plus a `REQUIRED_TRIGGER_PHRASES` entry below — in the
 * same diff that adds it. The `goal` station is the first to have gone through
 * that ritual, bumping this const from 14.
 */
const DESCRIBED_SURFACE_COUNT = 15;

// ─── reading the surface ─────────────────────────────────────────────────────

/**
 * The YAML frontmatter block of a described surface, fences excluded.
 *
 * Shared by the hand extractor below and by tier 5's strict parse, so both
 * readers are demonstrably looking at the SAME bytes — an agreement assertion
 * over two differently-delimited slices would prove nothing.
 */
export function frontmatterBlockOf(md: string, label: string): string {
  if (!md.startsWith('---\n')) {
    throw new Error(`${label} does not open with YAML frontmatter — nothing to scan.`);
  }
  const close = md.indexOf('\n---', 3);
  if (close < 0) {
    throw new Error(`${label} has an unterminated YAML frontmatter block.`);
  }
  return md.slice(4, close + 1);
}

/**
 * Decode a single-line YAML scalar exactly as it is written after
 * `description:` — plain, single-quoted, or double-quoted.
 *
 * The corpus was entirely plain scalars until five of them turned out not to be
 * valid YAML (tier 5's header). Quoting is the fix that leaves the decoded text
 * byte-identical, so the hand reader has to learn quoting or it would start
 * scanning a value with stray quote characters welded to both ends — and tier 3
 * would go red on a corpus that had not changed a word.
 *
 * Deliberately narrow, and loud where it is narrow: single-quoted style has
 * exactly one escape (`''` → `'`) and no backslash semantics at all, which is
 * why the five quoted descriptions use it. Double-quoted style is decoded for
 * the escapes YAML's own examples use and THROWS on anything else, rather than
 * quietly returning a string the real parser would not have produced. A silent
 * divergence here is the precise failure tier 5 exists to detect, so the hand
 * reader must never manufacture one.
 */
function decodeSingleLineScalar(raw: string, label: string): string {
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new Error(
        `${label}'s description opens a single-quoted YAML scalar that does not close on the ` +
          `same line. Keep the description on one line, or teach the extractor the new shape.`,
      );
    }
    const inner = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] !== "'") {
        out += inner[i];
        continue;
      }
      if (inner[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      throw new Error(
        `${label}'s description carries a lone apostrophe inside a single-quoted YAML scalar. ` +
          `Inside single quotes an apostrophe is written twice ('') — a lone one ends the ` +
          `scalar early and silently truncates the listing line.`,
      );
    }
    return out;
  }

  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      throw new Error(
        `${label}'s description opens a double-quoted YAML scalar that does not close on the ` +
          `same line. Keep the description on one line, or teach the extractor the new shape.`,
      );
    }
    const inner = raw.slice(1, -1);
    const ESCAPES: Readonly<Record<string, string>> = {
      '\\': '\\',
      '"': '"',
      '/': '/',
      n: '\n',
      t: '\t',
    };
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i];
      if (ch === '"') {
        throw new Error(
          `${label}'s description carries an unescaped double quote inside a double-quoted YAML ` +
            `scalar. Write it as \\" — or use single-quoted style, which the rest of the corpus ` +
            `uses precisely because these descriptions are full of quoted trigger phrases.`,
        );
      }
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const decoded = ESCAPES[inner[i + 1] ?? ''];
      if (decoded === undefined) {
        throw new Error(
          `${label}'s description uses the backslash escape \\${inner[i + 1] ?? '<end of line>'} ` +
            `inside a double-quoted YAML scalar, which this extractor does not decode. Teach it ` +
            `the escape rather than letting the two readers drift apart.`,
        );
      }
      out += decoded;
      i += 1;
    }
    return out;
  }

  return raw;
}

/**
 * The `description:` value out of a file's YAML frontmatter, decoded.
 *
 * Throws rather than returning `null` on every unexpected shape — no
 * frontmatter, no `description:` key, an empty value, or a multi-line YAML
 * scalar the single-line reader below would silently truncate. A guard whose
 * extractor degrades to "" scans nothing and passes everything, which is the
 * failure mode this whole file exists to make impossible.
 */
export function readFrontmatterDescription(md: string, label: string): string {
  const block = frontmatterBlockOf(md, label);
  const lines = block.split('\n');
  const at = lines.findIndex((line) => line.startsWith('description:'));
  if (at < 0) {
    throw new Error(`${label} has frontmatter but no description: key — the listing line is empty.`);
  }
  const value = lines[at].slice('description:'.length).trim();
  // A folded/literal scalar (`description: >-` / `|`) or a wrapped value puts
  // the text on the FOLLOWING lines. Reading only the key line would return a
  // one-character string that trivially passes every predicate below.
  const next = lines[at + 1] ?? '';
  if (value === '' || value === '>' || value === '>-' || value === '|' || value === '|-') {
    throw new Error(
      `${label}'s description is a multi-line or empty YAML scalar. This guard reads the ` +
        `single-line form the whole corpus uses; teach the extractor the new shape rather than ` +
        `letting it scan a truncated value.`,
    );
  }
  if (/^\s+\S/.test(next) && !next.startsWith('  #')) {
    throw new Error(
      `${label}'s description continues onto an indented line — the extractor would scan only ` +
        `its first line. Keep the description on one line, or teach the extractor the new shape.`,
    );
  }
  return decodeSingleLineScalar(value, label);
}

/**
 * What a strict YAML parser makes of a surface's frontmatter.
 *
 * Returned as a result rather than thrown so the assertion can name the file
 * AND quote the parser's own complaint — "one of fifteen frontmatters is
 * invalid" sends a reader hunting; the path plus `Nested mappings are not
 * allowed in compact mappings` sends them to the line.
 */
export type StrictFrontmatterRead =
  | { readonly ok: true; readonly description: string }
  | { readonly ok: false; readonly error: string };

/** Parse a surface's frontmatter with a real YAML parser and read `description`. */
export function strictParseDescription(md: string, label: string): StrictFrontmatterRead {
  let doc: unknown;
  try {
    doc = parseYaml(frontmatterBlockOf(md, label), { strict: true, prettyErrors: false });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { ok: false, error: 'frontmatter did not parse to a mapping' };
  }
  const value = (doc as Record<string, unknown>).description;
  if (typeof value !== 'string') {
    return { ok: false, error: `description parsed to ${typeof value}, not a string` };
  }
  return { ok: true, description: value };
}

/** Every described surface, repo-relative, sorted: the 13 skills plus the agent. */
function listDescribedSurfaces(): string[] {
  const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `.claude/skills/${entry.name}/SKILL.md`)
    .filter((rel) => {
      try {
        readFileSync(join(REPO_ROOT, rel), 'utf-8');
        return true;
      } catch {
        return false;
      }
    });
  return [...skills, REVIEWER_AGENT_REL].sort();
}

const SURFACES = listDescribedSurfaces();
const DESCRIPTIONS = new Map(
  SURFACES.map(
    (rel) =>
      [rel, readFrontmatterDescription(readFileSync(join(REPO_ROOT, rel), 'utf-8'), rel)] as const,
  ),
);

// ─── tier 1: the id patterns ─────────────────────────────────────────────────

/**
 * Internal id shapes. Each one is a reference the reader cannot resolve without
 * this repository open beside them.
 *
 * SCOPE NOTE, stated rather than hidden: these are flotilla's OWN id shapes, not
 * a generic "uppercase key followed by digits". The generic form was considered
 * and rejected — it fires on `UTF-8`, `ISO-8601`, `RFC-7231`, `SHA-256`, all of
 * which a description may legitimately name because they mean the same thing to
 * every reader on earth. The distinguishing property of the banned shapes is not
 * that they are keys; it is that they are keys into THIS repository.
 */
const INTERNAL_ID_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // Decision-record numbers, in every spelling the corpus has used: `ADR-0023`,
  // `(ADR-0023)`, `adr-39`.
  ['a decision-record number (ADR-N)', /\bADR-\d+/i],
  // This repo's own tracker key. A consumer's key differs, which is precisely
  // why naming ours in a shipped description is meaningless to them.
  ["the maintainer's tracker key (FOR-N)", /\bFOR-\d+/i],
  // Retro finding ids — `KW-F4`, `W5-F2`. The trailing group starts with a
  // letter, so no digit-suffix pattern above can reach them.
  ['a retro finding id (KW-F4)', /\b[A-Z]{1,4}\d*-F\d+\b/],
  // Convention numbers. The conventions are real and load-bearing — inside
  // skill prose, where the agent reads them. In the listing they are a number
  // with nothing behind it.
  ['a convention number ("Convention N")', /\bConvention\s+\d+\b/i],
  // Paths into the evidence tree. Neither directory ships in the npm package or
  // the plugin clone, so the pointer is dead at exactly the moment it is read.
  ['a path into the evidence tree', /\bdocs\/(?:adr|retros)\//i],
];

// ─── tier 2: the curated stop-list ───────────────────────────────────────────

/**
 * Internal state vocabulary — the words that look like ordinary English (or
 * like a harmless acronym) and are not.
 *
 * VOCABULARY TRADEOFF, stated rather than hidden: a curated list is by
 * construction incomplete. Tomorrow's internal coinage clears it, and this
 * guard will be green while a stranger reads a word that means nothing to them.
 * That is accepted: the alternative — banning domain vocabulary wholesale —
 * would fire on `wave`, `spine`, `claim` and `worker`, which are the terms the
 * descriptions have to use to say what the skills do at all, and two of which
 * live inside trigger phrases that must survive verbatim.
 *
 * Widening the list therefore takes a negative control in the SAME diff proving
 * the added entry does not fire on a shipped description.
 *
 * The first six entries are not a guess — they are exactly the tokens the
 * pre-rewrite listing put in front of the first fully-external consumer.
 */
const INTERNAL_VOCABULARY: ReadonlyArray<readonly [string, RegExp]> = [
  // — the six measured in the audit —
  ['DoR — "definition of ready", an acronym with no expansion in sight', /\bDoR\b|\bDOR\b/],
  ['WAL — "write-ahead log", a storage term used as a status word', /\bWAL\b/],
  ['HELD — an internal row state', /\bHELD\b/],
  ['"coarse ledger" — the internal name for the tracker projection', /\bcoarse\s+ledger\b/i],
  ['STOP→needs-attention — an internal routing edge', /\bSTOP\s*(?:→|->)\s*needs-attention\b/i],
  ['a Status: value from the wave file', /\bStatus:\s*(?:draft|ready|in-flight|closed)\b/],
  // — the rest of the curated surface —
  ['"soft-claim" — the internal name for a claim', /\bsoft-claims?\b/i],
  ['cap=1 — the internal re-dispatch bound', /\bcap\s*=\s*1\b/i],
  ['WAVE.md — an internal filename', /\bWAVE\.md\b/],
  ['"wave-anchor" — the internal name for the commit a batch starts from', /\bwave-anchor\b/i],
  ['"Header-Block" — the internal name for the planning header', /\bHeader-Block\b/i],
  ['"wave-eligible" — an internal eligibility term', /\bwave-eligible\b/i],
  // Schema and interface type names. These are engine identifiers; a consumer
  // never types one and never sees one except in a stack trace.
  ['an internal schema name', /\b(?:WorkerReport|ReviewerVerdict|IssueView)\b/],
  ['an internal interface name', /\b(?:IssueStore|SpineStore|MarkdownFsStore)\b/],
];

/** Every tier-1 and tier-2 predicate, as one scan. Returns the labels that fired. */
export function internalTokensIn(description: string): string[] {
  return [...INTERNAL_ID_PATTERNS, ...INTERNAL_VOCABULARY]
    .filter(([, re]) => re.test(description))
    .map(([label]) => label);
}

// ─── tier 3: the trigger phrases ─────────────────────────────────────────────

/**
 * The phrases the model matches on when it picks a skill. Every one of these is
 * a phrase the project's own documentation tells a person to say out loud, so
 * each is pinned as a LITERAL substring — a paraphrase is a regression even
 * when it reads better.
 *
 * `wave-shared` and the Reviewer agent carry none by design: neither is ever
 * chosen by the model. Their entries are empty on purpose, and the pair of
 * assertions below pins that as a deliberate absence rather than an oversight.
 */
const REQUIRED_TRIGGER_PHRASES: Readonly<Record<string, readonly string[]>> = {
  '.claude/skills/goal/SKILL.md': [
    '"cut a goal"',
    '"what is left before <goal>"',
    '"add this to the goal"',
    '"goal status"',
  ],
  '.claude/skills/triage/SKILL.md': [
    '"triage this issue"',
    '"review incoming bugs"',
    '"prepare this for an agent"',
  ],
  '.claude/skills/to-prd/SKILL.md': [
    '"write a PRD"',
    '"turn this into a PRD"',
    '"draft a product requirements doc"',
  ],
  '.claude/skills/to-issues/SKILL.md': [
    '"turn this into issues"',
    '"create implementation tickets"',
    '"make these wave-ready"',
  ],
  '.claude/skills/report/SKILL.md': [
    '"report this to flotilla"',
    '"file this upstream"',
    '"report this finding to the maintainers"',
    '"file an issue against flotilla"',
  ],
  // grill-with-docs never carried a quoted trigger list; its selection rides on
  // the closing "Use when …" sentence, which is pinned verbatim instead.
  '.claude/skills/grill-with-docs/SKILL.md': [
    "stress-test a plan against their project's language and documented decisions",
  ],
  '.claude/skills/wave-setup/SKILL.md': [
    '"set up flotilla"',
    '"configure the wave store"',
    '"init wave config"',
    '"initialize flotilla for this repo"',
  ],
  '.claude/skills/wave-plan/SKILL.md': ['"plan a wave"', '"what can run next"', '"cross-wave check"'],
  '.claude/skills/wave-create/SKILL.md': [
    '"create the wave"',
    '"materialize wave <slug>"',
    '"build the spine for these issues"',
  ],
  '.claude/skills/wave-start/SKILL.md': [
    '"start the wave <slug>"',
    '"dispatch wave <slug>"',
    '"run wave-start"',
  ],
  '.claude/skills/wave-reviewer/SKILL.md': [
    '"review this wave row"',
    '"what does the wave-reviewer check"',
    '"run the reviewer on <branch>"',
  ],
  '.claude/skills/wave-close/SKILL.md': [
    '"close the wave <slug>"',
    '"finalise wave <slug>"',
    '"archive wave <slug>"',
  ],
  '.claude/skills/wave-resume/SKILL.md': [
    '"resume wave <slug>"',
    '"the coordinator died — pick up wave <slug>"',
    '"reconcile and resume"',
  ],
  '.claude/skills/wave-shared/SKILL.md': [],
  [REVIEWER_AGENT_REL]: [],
};

/** Which of a surface's required trigger phrases are missing from its description. */
export function missingTriggerPhrases(rel: string, description: string): string[] {
  return (REQUIRED_TRIGGER_PHRASES[rel] ?? []).filter((phrase) => !description.includes(phrase));
}

// ─── tier 4: the point of view ───────────────────────────────────────────────

/**
 * Second-person address. The platform's authoring guidance asks for third
 * person on this field specifically, because the line is injected into the
 * system prompt and a mixed register measurably hurts skill discovery.
 *
 * The pattern is pronouns only, not mood. `Use when …` — the opener the whole
 * corpus shares, and the one the platform's own examples use — is imperative,
 * not second person, and must stay legal: it is the documented shape for saying
 * *when* a skill applies.
 *
 * SCOPE NOTE, stated rather than hidden: this catches second person, not first.
 * The authoring page names both ("I can help you process Excel files" is its
 * other counter-example) — but that sentence contains `you` and is caught here
 * anyway, and a purely first-person description (`I process Excel files`) has
 * never appeared in this corpus. Adding an `\bI\b|\bwe\b` tier would need its
 * own negative control AND a false-positive control, since those two letters
 * turn up inside ordinary prose far more readily than `you` does. Left undone
 * on purpose; the day a first-person description lands, that is the diff that
 * owes the predicate.
 */
const SECOND_PERSON_ADDRESS = /\byou(?:r|rs|rself|rselves)?\b/gi;

/**
 * The distinct second-person pronouns in a description, lowercased and sorted.
 * Empty means the line reads in third person.
 *
 * Returns the matches rather than a boolean so the failure message can quote
 * the offending word: "reads in second person" sends an author hunting, and
 * `["your"]` sends them to the word.
 */
export function secondPersonAddressIn(description: string): string[] {
  const found = [...description.matchAll(SECOND_PERSON_ADDRESS)].map((m) => m[0].toLowerCase());
  return [...new Set(found)].sort();
}

// ─── the documented length ceiling ───────────────────────────────────────────

/**
 * The platform's documented frontmatter ceiling for `description`: non-empty,
 * at most 1,024 characters. Named and exported so the bound is exercised as a
 * PREDICATE rather than re-typed as a literal inside each assertion — the
 * earlier form asserted `padEnd(1025).length > 1024`, which is a true statement
 * about the standard library and says nothing about this guard.
 *
 * Measured in UTF-16 code units, which is what `String.length` counts. Every
 * description in this corpus is far enough from the bound (the widest sits
 * around 600) that the difference from a code-point or byte count cannot
 * decide anything here; if a description ever approaches 1,024, re-check which
 * unit the platform counts before trusting this margin.
 */
export const DESCRIPTION_CHARACTER_LIMIT = 1024;

/** True when a description is past the documented ceiling and would be rejected. */
export function exceedsDescriptionLimit(description: string): boolean {
  return description.length > DESCRIPTION_CHARACTER_LIMIT;
}

// ─── tier 5: strict YAML validity, and reader agreement ──────────────────────

/**
 * Surfaces that are IN the population, KNOWN to fail tier 5 today, and that the
 * diff introducing tier 5 could not touch: both lie outside its declared file
 * globs, and a wave row reaching past its declared globs is precisely what the
 * cross-wave file-conflict map cannot reason about. They are pinned here with
 * the half of tier 5 each one fails, so the carve-out is a named, one-line-to-
 * delete entry rather than a silently narrowed population.
 *
 * The entries are **self-retiring**: the cell below asserts each listed surface
 * STILL fails the named half. Fix one and this file goes red, demanding the
 * entry be deleted in the same diff — an exemption cannot outlive its defect.
 *
 *   - `.claude/agents/wave-reviewer.md` — the SIXTH colon-space plain scalar
 *     (`answers with exactly one verdict: approve, …`). The finding that
 *     prompted tier 5 counted five, because `claude plugin validate`
 *     enumerates *skills* and never visited the agent; a strict parse over this
 *     guard's own population finds six. Formal invalidity, no measured runtime
 *     loss.
 *
 *   - `.claude/skills/triage/SKILL.md` — the reader disagreement, and the more
 *     serious of the two. Its plain scalar contains ` #` (inside the trigger
 *     phrase `"is #42 ready for an agent?"`), which YAML reads as a comment
 *     introducer: the document parses CLEANLY and the description simply ends
 *     55 characters early, dropping two trigger phrases. That is not a
 *     hypothetical about some future parser tightening — the live harness skill
 *     listing injected into the session that added this tier ends triage's
 *     description at `…, "is`, byte-for-byte where the parser ends it. Tiers
 *     1–4 are green on that surface only because the hand reader keeps a tail
 *     the model never receives.
 */
const KNOWN_UNGUARDED: Readonly<Record<string, 'strict-parse' | 'reader-agreement'>> = {
  [REVIEWER_AGENT_REL]: 'strict-parse',
  '.claude/skills/triage/SKILL.md': 'reader-agreement',
};

/** The population tier 5 holds today: everything except the pinned exemptions. */
function tierFiveSurfaces(): string[] {
  return listDescribedSurfaces().filter(
    (rel) => !Object.prototype.hasOwnProperty.call(KNOWN_UNGUARDED, rel),
  );
}

// ─── the descriptions exactly as they shipped, kept as fixtures ──────────────

/**
 * Four pre-rewrite descriptions, verbatim. They are the negative control this
 * guard most needs: a seeded violation proves the regex works, but only the real
 * corpus proves the guard would have CAUGHT THE THING IT WAS BUILT FOR.
 *
 * Do not "tidy" these. They are historical evidence, and each one is asserted
 * below against the exact set of labels it must produce.
 */
const AS_SHIPPED_BEFORE_THE_REWRITE: Readonly<Record<string, string>> = {
  'wave-start':
    'Use when dispatching a Status:draft or Status:ready WAVE.md spine — auto-flip draft→ready ' +
    'via spine set-status, flip to in-flight, re-verify DOR + conflict-map + intra-wave ' +
    'Blocked-by membership + the human gate (HELD and human-gated rows are skipped, never ' +
    'dispatched), fan out Workers (worktree-isolated, schema-validated WorkerReport) then ' +
    'universal Reviewers (schema-validated ReviewerVerdict), route each Verdict ' +
    'deterministically, cap=1 re-dispatch, STOP→needs-attention. Ends at every non-HELD row ' +
    'in-review — NEVER merges.',
  'wave-create':
    'Use when materializing an approved wave from a chosen set of issue ids — run DoR + ' +
    'cross-wave (file conflicts AND intra-wave Blocked-by pairs, both surface+ask ' +
    'default-abort), render the WAVE.md spine, and set the queued soft-claim. Spine-first (WAL).',
  'wave-close':
    "Use when finishing a wave's host-side work — recompute the advisory merge order, clean up " +
    'agent worktrees, flag stuck rows, and archive the spine. Re-entrant + idempotent; opt-in ' +
    '--auto partial-arms the order-free rows through the engine host-pr verb and exits (ADR-0023).',
  'wave-resume':
    'Use when a wave Coordinator was killed mid-wave and you need to reconstruct state and ' +
    'resume — read the spine (WAL authority), reconcile against live worktrees + on-disk ' +
    'sidecars + merged PRs, re-project the coarse ledger, then re-dispatch only what the ' +
    'reconciler says.',
};

/**
 * The six descriptions that carried second-person address, verbatim as they
 * stood the moment before tier 4 landed. Same discipline as the block above and
 * for the same reason: a synthetic "you should do this" fixture proves the
 * regex compiles, but only the real corpus proves the predicate would have
 * caught the drift that actually happened.
 *
 * Note what the six have in common — every one of them is a sentence about what
 * the OPERATOR does ("you choose", "shows you", "your issues"), written by
 * someone with the operator register correctly in mind and applied to the one
 * surface it does not govern. That is why the tier exists: the mistake is a
 * reasonable one, so a reviewer will not reliably catch it by eye.
 *
 * Do not "tidy" these.
 */
const AS_SHIPPED_IN_SECOND_PERSON: Readonly<Record<string, string>> = {
  'wave-plan':
    'Changes nothing: you choose which ones to run and hand them to wave-create.',
  'wave-create':
    'Use when turning a chosen set of issue ids into a wave you can actually run — re-checks ' +
    'that every issue has what an agent needs, shows you any overlapping files and any issue in ' +
    'the batch that has to wait for another one.',
  'wave-setup':
    'writes the one `wave.config.json` every other flotilla skill reads: which issue tracker ' +
    'your issues live on, which of them agents are allowed to pick up.',
  'wave-start': 'Anything that goes wrong is flagged on the tracker for you.',
  'report':
    'found while running flotilla in your own repo, and it is ready to file upstream at ' +
    "flotilla's own public repo in the format its maintainers expect.",
  'grill-with-docs':
    'Grilling session that challenges your plan against the vocabulary the project already uses ' +
    'and the decisions it has already recorded.',
};

// ─── the guard ───────────────────────────────────────────────────────────────

describe('skill-descriptions-guard — the listing a consumer reads first carries no internal token', () => {
  it('finds the whole population (a guard that matches nothing is green for the wrong reason)', () => {
    expect(SURFACES).toHaveLength(DESCRIBED_SURFACE_COUNT);
    // Both halves of the pipeline plus the agent. The front half is listed
    // explicitly because it is the half a consumer meets FIRST — someone
    // adopting flotilla reaches `triage` and `to-issues` long before any wave
    // skill runs, and a population that quietly covered only the back half
    // would leave the first impression unguarded.
    expect(SURFACES).toContain('.claude/skills/goal/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/triage/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/to-prd/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/to-issues/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/report/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/grill-with-docs/SKILL.md');
    expect(SURFACES).toContain('.claude/skills/wave-start/SKILL.md');
    expect(SURFACES).toContain(REVIEWER_AGENT_REL);
  });

  it('every surface has a non-trivial description (an empty listing line teaches nothing)', () => {
    for (const rel of SURFACES) {
      const description = DESCRIPTIONS.get(rel) as string;
      expect(description.length, `${rel}'s description is too short to say what the skill does`).
        toBeGreaterThan(80);
    }
  });

  it('every description stays inside the documented limit of 1024 characters', () => {
    // Not a house preference — the platform's own frontmatter contract, read
    // from the Agent Skills authoring page: `description` is required, must be
    // non-empty, and is capped at 1,024 characters. A rewrite that trades a
    // terse internal token for a paragraph of plain language is exactly the
    // change that walks into that ceiling, so the ceiling is pinned here rather
    // than discovered by a consumer whose skill silently fails to load — and
    // measurement says nothing upstream will catch it first: `claude plugin
    // validate --strict` accepted a 1,260-character description without a word.
    // The widest description in the corpus today sits around 600.
    for (const rel of SURFACES) {
      const description = DESCRIPTIONS.get(rel) as string;
      expect(
        exceedsDescriptionLimit(description),
        `${rel}'s description is ${description.length} characters — past the ` +
          `${DESCRIPTION_CHARACTER_LIMIT}-character frontmatter limit. Plain language costs ` +
          `words; cut the least load-bearing clause, never a trigger phrase.`,
      ).toBe(false);
    }
  });

  it.each(listDescribedSurfaces())('%s reads in third person, as the platform asks', (rel) => {
    const description = DESCRIPTIONS.get(rel) as string;
    const pronouns = secondPersonAddressIn(description);
    expect(
      pronouns,
      `${rel}'s description addresses the reader directly (${pronouns.join(', ')}). This field ` +
        `is injected into the system prompt and read by the MODEL at selection time, not by an ` +
        `operator mid-conversation, so the operator register does not reach it — the platform's ` +
        `authoring guidance asks for third person here and warns that a mixed point of view ` +
        `hurts discovery. Say what the skill does, not what the reader does:\n\n  ${description}`,
    ).toEqual([]);
  });

  it.each(listDescribedSurfaces())('%s reads consumer-first — no internal token', (rel) => {
    const description = DESCRIPTIONS.get(rel) as string;
    const offenders = internalTokensIn(description);
    expect(
      offenders,
      `${rel}'s frontmatter description carries internal references. This line is rendered in ` +
        `the skill listing BEFORE anything runs, to someone who has never opened this ` +
        `repository — state the one-line consequence in plain language instead of naming the ` +
        `token:\n  ${offenders.join('\n  ')}\n\n  ${description}`,
    ).toEqual([]);
  });

  it.each(listDescribedSurfaces())('%s keeps every trigger phrase it is selected on', (rel) => {
    const description = DESCRIPTIONS.get(rel) as string;
    const missing = missingTriggerPhrases(rel, description);
    expect(
      missing,
      `${rel}'s description no longer carries the phrases the model matches on. A rewrite that ` +
        `reads better and drops a trigger phrase has silently disconnected the skill — restore ` +
        `these verbatim, quotes included:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the two never-model-invoked surfaces carry no trigger phrases, deliberately', () => {
    // Pinned so the empty entries above read as a decision rather than a gap.
    // `wave-shared` is loaded by name by its siblings and says so in its own
    // frontmatter; the Reviewer agent is dispatched by wave-start, never chosen.
    expect(REQUIRED_TRIGGER_PHRASES['.claude/skills/wave-shared/SKILL.md']).toEqual([]);
    expect(REQUIRED_TRIGGER_PHRASES[REVIEWER_AGENT_REL]).toEqual([]);
    const waveShared = readFileSync(join(REPO_ROOT, '.claude/skills/wave-shared/SKILL.md'), 'utf-8');
    expect(waveShared).toContain('disable-model-invocation: true');
  });

  it('every angle-bracket placeholder sits inside a phrase tier 3 pins verbatim', () => {
    // The placeholders stay by DECISION, and the decision rests on measurement:
    // the platform's own validator accepts them (header, "The angle-bracket
    // placeholders"). This pins the decision structurally instead of leaving it
    // in a comment — every occurrence lives inside a trigger phrase tier 3
    // already holds byte-exact, so a respelling cannot land quietly, and a new
    // placeholder introduced OUTSIDE a pinned phrase goes loud here rather than
    // drifting unguarded.
    const inventory: Record<string, number> = {};
    for (const rel of SURFACES) {
      const description = DESCRIPTIONS.get(rel) as string;
      for (const token of description.match(/<[a-z]+>/g) ?? []) {
        inventory[token] = (inventory[token] ?? 0) + 1;
        expect(
          (REQUIRED_TRIGGER_PHRASES[rel] ?? []).some((phrase) => phrase.includes(token)),
          `${rel}'s description carries the placeholder ${token} outside every pinned trigger ` +
            `phrase, so tier 3 would not notice it being respelled. Either put it inside a ` +
            `phrase this guard holds verbatim, or do not spell it with angle brackets.`,
        ).toBe(true);
      }
    }
    // The whole inventory, so a placeholder appearing or vanishing is a
    // deliberate edit here rather than a silent corpus change.
    expect(inventory).toEqual({ '<goal>': 1, '<slug>': 8, '<branch>': 1 });
  });

  it.each(tierFiveSurfaces())(
    '%s frontmatter is valid YAML, and the strict parser and the hand reader agree on it',
    (rel) => {
      const md = readFileSync(join(REPO_ROOT, rel), 'utf-8');
      const strict = strictParseDescription(md, rel);
      expect(
        strict.ok ? '' : strict.error,
        `${rel}'s YAML frontmatter does not parse under a strict parser. Every reader that has ` +
          `ever looked at this corpus — the runtime harness, and this file's own hand extractor ` +
          `— happens to be lenient enough to read it anyway, and none of that leniency is ` +
          `specified anywhere. The commonest cause is an UNQUOTED description containing ": " ` +
          `(colon-space), which YAML reads as a nested mapping. Wrap the value in single quotes ` +
          `(doubling any apostrophe): the decoded text is unchanged.`,
      ).toBe('');

      // The half that catches a document which parses cleanly and still does
      // not say what the hand reader thinks. Without this, every tier above
      // could be green against a string the model never receives.
      const parsed = (strict as { description: string }).description;
      const extracted = DESCRIPTIONS.get(rel) as string;
      expect(
        parsed,
        `${rel}'s two readers disagree about its description. The hand extractor scans one ` +
          `string and the YAML parser produces another, so tiers 1-4 are measuring text the ` +
          `model may never see. Most often an unquoted value carries a YAML metacharacter — ` +
          `" #" starts a comment and silently truncates the rest of the line.\n\n` +
          `  hand reader (${extracted.length} chars): ${extracted}\n` +
          `  YAML parser (${parsed?.length} chars): ${parsed}`,
      ).toBe(extracted);
    },
  );

  it('the tier-5 exemptions are exactly the two known defects, and each still fails', () => {
    // Self-retiring: the moment either surface is fixed, this cell goes red and
    // the entry must be deleted, which puts the surface back in the guarded
    // population above. An exemption cannot quietly outlive its defect.
    expect(Object.keys(KNOWN_UNGUARDED).sort()).toEqual(
      ['.claude/agents/wave-reviewer.md', '.claude/skills/triage/SKILL.md'].sort(),
    );
    for (const rel of Object.keys(KNOWN_UNGUARDED)) {
      expect(SURFACES, `${rel} is exempted from tier 5 but is not in the population`).toContain(rel);
    }

    // The agent: invalid YAML outright.
    const agent = readFileSync(join(REPO_ROOT, REVIEWER_AGENT_REL), 'utf-8');
    const agentRead = strictParseDescription(agent, REVIEWER_AGENT_REL);
    expect(
      agentRead.ok,
      `${REVIEWER_AGENT_REL} now parses under a strict YAML parser. Delete its KNOWN_UNGUARDED ` +
        `entry in this same diff so tier 5 starts holding it.`,
    ).toBe(false);

    // triage: parses cleanly, means something else.
    const triageRel = '.claude/skills/triage/SKILL.md';
    const triage = readFileSync(join(REPO_ROOT, triageRel), 'utf-8');
    const triageRead = strictParseDescription(triage, triageRel);
    expect(triageRead.ok, `${triageRel} no longer parses at all — that is a different defect`).toBe(
      true,
    );
    const triageParsed = (triageRead as { description: string }).description;
    const triageExtracted = DESCRIPTIONS.get(triageRel) as string;
    expect(
      triageParsed,
      `${triageRel}'s two readers now agree. Delete its KNOWN_UNGUARDED entry in this same diff ` +
        `so tier 5 starts holding it.`,
    ).not.toBe(triageExtracted);
    // …and the concrete consequence, pinned so the follow-up has its evidence:
    // two trigger phrases tier 3 believes are present never reach the model.
    expect(triageExtracted).toContain('"prepare this for an agent"');
    expect(triageParsed).not.toContain('"prepare this for an agent"');
    expect(triageParsed).not.toContain('"is #42 ready for an agent?"');
    expect(triageParsed.length).toBeLessThan(triageExtracted.length);
  });

  it('the YAML parser stays a spec-only devDependency — the runtime graph never imports it', () => {
    // The dependency doctrine this tier had to negotiate: `tools/wave` ships
    // raw TS with `fast-glob` + `micromatch` + `tsx` and nothing else, so a
    // parser reachable from the published import graph would be a contract
    // change, not a test tool. Pinned here rather than stated once in a report,
    // because a stated check decays the first time someone reaches for a
    // convenient import.
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['fast-glob', 'micromatch', 'tsx']);
    expect(Object.keys(pkg.devDependencies)).toContain('yaml');

    const runtimeModules = fastGlob
      .sync(['**/*.ts'], { cwd: __dirname, ignore: ['**/*.spec.ts', '__fixtures__/**'] })
      .sort();
    // A population floor, so a discovery that silently found nothing cannot
    // pass this by scanning an empty list.
    expect(runtimeModules.length).toBeGreaterThan(30);

    const importers = runtimeModules.filter((rel) =>
      /(?:from|require\()\s*['"]yaml['"]/.test(readFileSync(join(__dirname, rel), 'utf-8')),
    );
    expect(
      importers,
      `these runtime modules import the YAML parser, which ships only as a devDependency: the ` +
        `published package would fail to resolve it. Keep the parser inside spec files:\n  ` +
        `${importers.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every surface in the population has a trigger-phrase entry (no silent opt-out)', () => {
    // A new skill whose path is absent from the table would pass the trigger
    // predicate by scanning an empty list — the same "green for the wrong
    // reason" shape the population count guards against, one level down.
    for (const rel of SURFACES) {
      expect(
        Object.prototype.hasOwnProperty.call(REQUIRED_TRIGGER_PHRASES, rel),
        `${rel} has no entry in REQUIRED_TRIGGER_PHRASES. Add its trigger phrases — or an ` +
          `explicit empty list if it is never model-invoked — rather than leaving it unscanned.`,
      ).toBe(true);
    }
  });
});

// ─── negative controls (Convention 11) ───────────────────────────────────────

describe('skill-descriptions-guard — negative controls: the guard is red on the corpus it replaced', () => {
  it.each(Object.keys(AS_SHIPPED_BEFORE_THE_REWRITE))(
    "%s's pre-rewrite description is caught",
    (skill) => {
      const before = AS_SHIPPED_BEFORE_THE_REWRITE[skill];
      expect(internalTokensIn(before).length).toBeGreaterThan(0);
    },
  );

  it('each pre-rewrite description is caught for the exact reasons it was rewritten', () => {
    // Not just "goes red" — red for the RIGHT tokens. A guard that fired on all
    // four for one incidental reason would look identical from the count alone.
    expect(internalTokensIn(AS_SHIPPED_BEFORE_THE_REWRITE['wave-start']).sort()).toEqual(
      [
        'DoR — "definition of ready", an acronym with no expansion in sight',
        'HELD — an internal row state',
        'STOP→needs-attention — an internal routing edge',
        'WAVE.md — an internal filename',
        'a Status: value from the wave file',
        'an internal schema name',
        'cap=1 — the internal re-dispatch bound',
      ].sort(),
    );
    expect(internalTokensIn(AS_SHIPPED_BEFORE_THE_REWRITE['wave-create']).sort()).toEqual(
      [
        'DoR — "definition of ready", an acronym with no expansion in sight',
        'WAL — "write-ahead log", a storage term used as a status word',
        'WAVE.md — an internal filename',
        '"soft-claim" — the internal name for a claim',
      ].sort(),
    );
    expect(internalTokensIn(AS_SHIPPED_BEFORE_THE_REWRITE['wave-close'])).toEqual([
      'a decision-record number (ADR-N)',
    ]);
    expect(internalTokensIn(AS_SHIPPED_BEFORE_THE_REWRITE['wave-resume']).sort()).toEqual(
      [
        'WAL — "write-ahead log", a storage term used as a status word',
        '"coarse ledger" — the internal name for the tracker projection',
      ].sort(),
    );
  });

  it('every single predicate fires on a minimal example of its own shape', () => {
    // One example per pattern, so a predicate that was silently unreachable
    // (a typo'd alternation, a `\b` in the wrong place) cannot hide behind a
    // sibling that matched the same fixture.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['a decision-record number (ADR-N)', 'lands once the checks go green (ADR-0023).'],
      ["the maintainer's tracker key (FOR-N)", 'tracked upstream as FOR-77.'],
      ['a retro finding id (KW-F4)', 'the public-API pairing advisory (KW-F4).'],
      ['a convention number ("Convention N")', 'as Convention 16 requires.'],
      ['a path into the evidence tree', 'see docs/adr/0039-user-directed-output.md for why.'],
      ['DoR — "definition of ready", an acronym with no expansion in sight', 're-runs the DoR gate.'],
      ['WAL — "write-ahead log", a storage term used as a status word', 'the spine is the WAL.'],
      ['HELD — an internal row state', 'a HELD row is skipped.'],
      ['"coarse ledger" — the internal name for the tracker projection', 're-projects the coarse ledger.'],
      ['STOP→needs-attention — an internal routing edge', 'routes STOP→needs-attention.'],
      ['a Status: value from the wave file', 'dispatching a Status:draft spine.'],
      ['"soft-claim" — the internal name for a claim', 'sets the queued soft-claim.'],
      ['cap=1 — the internal re-dispatch bound', 'one cap=1 re-dispatch.'],
      ['WAVE.md — an internal filename', 'renders the WAVE.md spine.'],
      ['"wave-anchor" — the internal name for the commit a batch starts from', 'against the wave-anchor SHA.'],
      ['"Header-Block" — the internal name for the planning header', 'decorating with the wave Header-Block.'],
      ['"wave-eligible" — an internal eligibility term', 'draws the wave-eligible candidate set.'],
      ['an internal schema name', 'returns a schema-validated ReviewerVerdict.'],
      ['an internal interface name', 'reads through the IssueStore.'],
    ];
    for (const [label, fixture] of cases) {
      expect(internalTokensIn(fixture), `no predicate fired on: ${fixture}`).toContain(label);
    }
    // …and the coverage is total: every declared predicate appears above, so a
    // newly added stop-list entry cannot arrive without its own example.
    const exercised = new Set(cases.map(([label]) => label));
    for (const [label] of [...INTERNAL_ID_PATTERNS, ...INTERNAL_VOCABULARY]) {
      expect(
        exercised.has(label),
        `the predicate "${label}" has no example proving it can fire. Add one in the same diff ` +
          `that adds the predicate — an unreachable pattern is indistinguishable from a working ` +
          `one while the corpus is clean.`,
      ).toBe(true);
    }
  });

  it('a violation seeded into a LIVE description goes red', () => {
    // The seed is applied to the real shipped string, not to a hand-written
    // fixture: it proves the predicate reaches the actual surface, in its actual
    // wording, with only the token added.
    const live = DESCRIPTIONS.get('.claude/skills/wave-start/SKILL.md') as string;
    expect(internalTokensIn(live)).toEqual([]);
    expect(internalTokensIn(`${live} Rows that are HELD are skipped.`)).toEqual([
      'HELD — an internal row state',
    ]);
    expect(internalTokensIn(live.replace('never merges', 'never merges (ADR-0023)'))).toEqual([
      'a decision-record number (ADR-N)',
    ]);
  });

  it('a dropped trigger phrase goes red, and the predicate is not a substring accident', () => {
    const rel = '.claude/skills/wave-start/SKILL.md';
    const live = DESCRIPTIONS.get(rel) as string;
    expect(missingTriggerPhrases(rel, live)).toEqual([]);

    const dropped = live.replace('"dispatch wave <slug>", ', '');
    expect(dropped).not.toEqual(live); // the replace actually matched
    expect(missingTriggerPhrases(rel, dropped)).toEqual(['"dispatch wave <slug>"']);

    // A paraphrase keeps every word and still breaks selection. The phrases are
    // pinned WITH their quotes precisely so this case is caught.
    const paraphrased = live.replace('"start the wave <slug>"', 'starting the wave');
    expect(paraphrased).not.toEqual(live);
    expect(missingTriggerPhrases(rel, paraphrased)).toEqual(['"start the wave <slug>"']);
  });

  it('the vocabulary predicates do NOT fire on the domain words the descriptions must use', () => {
    // The other half of the tradeoff: this list is narrow so that the words a
    // description cannot do without stay legal. Two of them — `spine` and
    // `wave-ready` — live inside trigger phrases that must survive verbatim, so
    // a stop-list that reached them would make the two tiers contradict.
    const legal = [
      'build the spine for these issues',
      'make these wave-ready',
      'one batch of issues that can safely run side by side',
      'marks the issues as taken so a second batch will not grab them',
      'a background agent works the issue in its own copy of the repo',
      'the wave was interrupted part-way and has to be picked up',
      'checks that have to pass before anything is proposed for merge',
      'the status of each pull request',
      'held up by a review',
    ];
    for (const sentence of legal) {
      expect(internalTokensIn(sentence), `false positive on: ${sentence}`).toEqual([]);
    }
  });

  it('the length predicate itself goes true on an over-limit description', () => {
    // This is the one predicate whose bound could be typo'd by an order of
    // magnitude and stay green forever, because the corpus is nowhere near it.
    //
    // The control it replaced did not test that. It asserted
    // `live.padEnd(1025, 'x').length > 1024` — a true statement about
    // `String.prototype.padEnd` that would have held with the guard's bound set
    // to 10, to 100000, or deleted outright. It never called the thing under
    // test. `exceedsDescriptionLimit` exists so there IS a thing to call.
    const live = DESCRIPTIONS.get('.claude/skills/wave-start/SKILL.md') as string;
    expect(exceedsDescriptionLimit(live)).toBe(false);

    // The real shipped line, pushed one character past the ceiling.
    expect(exceedsDescriptionLimit(live.padEnd(DESCRIPTION_CHARACTER_LIMIT + 1, 'x'))).toBe(true);

    // Both sides of the boundary, so an off-by-one in either direction is
    // caught: exactly at the limit is legal, one past it is not.
    expect(exceedsDescriptionLimit('x'.repeat(DESCRIPTION_CHARACTER_LIMIT - 1))).toBe(false);
    expect(exceedsDescriptionLimit('x'.repeat(DESCRIPTION_CHARACTER_LIMIT))).toBe(false);
    expect(exceedsDescriptionLimit('x'.repeat(DESCRIPTION_CHARACTER_LIMIT + 1))).toBe(true);

    // …and the bound is the documented one, not a number that drifted.
    expect(DESCRIPTION_CHARACTER_LIMIT).toBe(1024);
  });

  it.each(Object.keys(AS_SHIPPED_IN_SECOND_PERSON))(
    "%s's second-person description, as it shipped, is caught",
    (skill) => {
      expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON[skill]).length).toBeGreaterThan(0);
    },
  );

  it('each second-person description is caught on the exact pronoun it carried', () => {
    // Red for the RIGHT word, not merely red. Four of the six drifted through
    // `your` and two through `you`; a predicate that collapsed both into one
    // alternation that only ever matched `you` would look identical from a
    // count of failures alone.
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['wave-plan'])).toEqual(['you']);
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['wave-create'])).toEqual(['you']);
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['wave-setup'])).toEqual(['your']);
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['wave-start'])).toEqual(['you']);
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['report'])).toEqual(['your']);
    expect(secondPersonAddressIn(AS_SHIPPED_IN_SECOND_PERSON['grill-with-docs'])).toEqual(['your']);
  });

  it("the point-of-view predicate fires on the platform documentation's own counter-examples", () => {
    // Anchored to the authoring page rather than to this repo's taste: these
    // are the two forms it names under "Avoid", and the one it names as "Good".
    expect(secondPersonAddressIn('You can use this to process Excel files')).toEqual(['you']);
    expect(secondPersonAddressIn('I can help you process Excel files')).toEqual(['you']);
    expect(secondPersonAddressIn('Processes Excel files and generates reports')).toEqual([]);
    // Its own effective example, which is the register this corpus writes in:
    // an imperative opener plus a third-person clause about the user.
    expect(
      secondPersonAddressIn(
        'Extract text and tables from PDF files, fill forms, merge documents. Use when working ' +
          'with PDF files or when the user mentions PDFs, forms, or document extraction.',
      ),
    ).toEqual([]);
  });

  it('every second-person form the predicate claims to cover actually fires', () => {
    // One example per alternation branch, so a branch that was silently
    // unreachable cannot hide behind a sibling matching the same fixture.
    expect(secondPersonAddressIn('this is for you.')).toEqual(['you']);
    expect(secondPersonAddressIn('your repo.')).toEqual(['your']);
    expect(secondPersonAddressIn('the choice is yours.')).toEqual(['yours']);
    expect(secondPersonAddressIn('do it yourself.')).toEqual(['yourself']);
    expect(secondPersonAddressIn('decide among yourselves.')).toEqual(['yourselves']);
    // Contractions: the apostrophe is a word boundary, so `\byou\b` reaches them.
    expect(secondPersonAddressIn("you're the operator.")).toEqual(['you']);
    expect(secondPersonAddressIn("you'll be asked first.")).toEqual(['you']);
    // Case-insensitive, and de-duplicated across a sentence.
    expect(secondPersonAddressIn('You choose. Your call. you decide.')).toEqual(['you', 'your']);
  });

  it('the point-of-view predicate does NOT fire on words that merely contain "you"', () => {
    // The whole risk of a pronoun regex is the substring hit. `\b` earns its
    // place here: without it every one of these would go red.
    const legal = [
      'a youthful project with young contributors',
      'this batch is younger than the spine it was cut from',
      'Yourcenar is a proper noun and Youngstown is a place',
      'Use when planning the next wave — one batch of issues that can safely run side by side.',
      'Lists which issues are ready to be picked up, then checks them for overlapping files.',
      'Use when the user mentions a stuck row, or when a batch has to be picked up where it stopped.',
      'writes the one wave.config.json every other flotilla skill reads',
    ];
    for (const sentence of legal) {
      expect(secondPersonAddressIn(sentence), `false positive on: ${sentence}`).toEqual([]);
    }
  });

  it('second person seeded into a LIVE description goes red', () => {
    // Same shape as the internal-token seed above: applied to the real shipped
    // string, so it proves the predicate reaches the actual surface in its
    // actual wording, with only the pronoun added.
    const rel = '.claude/skills/wave-plan/SKILL.md';
    const live = DESCRIPTIONS.get(rel) as string;
    expect(secondPersonAddressIn(live)).toEqual([]);

    const regressed = live.replace(
      'a person picks which ones to run and hands them to wave-create',
      'you choose which ones to run and hand them to wave-create',
    );
    expect(regressed).not.toEqual(live); // the replace actually matched
    expect(secondPersonAddressIn(regressed)).toEqual(['you']);
  });

  it('the description as it shipped INVALID is caught, and quoting it changes no text', () => {
    // wave-plan's description exactly as it stood at the wave anchor: an
    // unquoted plain scalar carrying `nothing: a person`. Historical evidence,
    // like the fixtures above — do not "tidy" it.
    //
    // One fixture, two claims. It goes red under tier 5's strict half, proving
    // the tier would have caught the corpus it was written for; and the SAME
    // text, single-quoted, parses and decodes back to itself byte-for-byte,
    // proving the fix is a pure encoding change. Nothing about the shipped
    // wording is pinned here beyond this historical string, so a future rewrite
    // of the live description is free.
    const asShipped =
      'Use when planning the next wave — one batch of issues that can safely run side by side. ' +
      'Lists which issues are ready to be picked up, then checks them for overlapping files, ' +
      'both against each other and against the issues another batch has already taken. Changes ' +
      'nothing: a person picks which ones to run and hands them to wave-create. Triggers on ' +
      '"plan a wave", "what can run next", "cross-wave check".';

    const invalid = `---\nname: wave-plan\ndescription: ${asShipped}\n---\nbody\n`;
    const before = strictParseDescription(invalid, 'wave-plan (as shipped)');
    expect(before.ok).toBe(false);
    expect((before as { error: string }).error).toMatch(/mapping/i);

    // …while the lenient hand reader was, and still is, perfectly happy — which
    // is exactly why nothing in this repository could see the defect.
    expect(readFrontmatterDescription(invalid, 'wave-plan (as shipped)')).toBe(asShipped);

    // The fix, computed rather than re-typed: wrap in single quotes, double any
    // apostrophe. Both readers then agree, on the original text.
    const quoted = `'${asShipped.replace(/'/g, "''")}'`;
    const fixed = `---\nname: wave-plan\ndescription: ${quoted}\n---\nbody\n`;
    const after = strictParseDescription(fixed, 'wave-plan (quoted)');
    expect(after.ok).toBe(true);
    expect((after as { description: string }).description).toBe(asShipped);
    expect(readFrontmatterDescription(fixed, 'wave-plan (quoted)')).toBe(asShipped);

    // …and the apostrophe case is exercised too, since wave-plan's own text has
    // none: the three quoted descriptions that DO carry one ride on this rule.
    const withApostrophe = "checks one issue's finished work: read-only.";
    const q2 = `---\ndescription: '${withApostrophe.replace(/'/g, "''")}'\n---\n`;
    expect(strictParseDescription(q2, 'x')).toEqual({ ok: true, description: withApostrophe });
    expect(readFrontmatterDescription(q2, 'x')).toBe(withApostrophe);
  });

  it('the reader-agreement half fails independently, on a document that parses cleanly', () => {
    // The strict half and the agreement half must be able to go red on their
    // own, or a green pair proves only that one of them works. This fixture
    // parses without a complaint — and still means something different to each
    // reader, because ` #` opens a YAML comment.
    const md = '---\nname: x\ndescription: plain value # the hand reader keeps this tail\n---\n';

    const strict = strictParseDescription(md, 'x');
    expect(strict.ok, 'the fixture must PARSE — otherwise it exercises the other half').toBe(true);

    const parsed = (strict as { description: string }).description;
    const extracted = readFrontmatterDescription(md, 'x');
    expect(parsed).toBe('plain value');
    expect(extracted).toBe('plain value # the hand reader keeps this tail');
    // The comparison the guard cell makes, shown failing.
    expect(parsed).not.toBe(extracted);
  });

  it('the scalar decoder fails loud rather than inventing a value the parser would not produce', () => {
    // Every throw here is a shape that, decoded generously, would make the hand
    // reader and the YAML parser disagree silently — the one outcome tier 5
    // exists to prevent, and the one it could not detect if the extractor
    // itself were the thing diverging.
    expect(() => readFrontmatterDescription("---\ndescription: 'no closing quote\n---\n", 'x')).
      toThrow(/single-quoted YAML scalar that does not close/);
    expect(() => readFrontmatterDescription("---\ndescription: 'it's ambiguous'\n---\n", 'x')).
      toThrow(/lone apostrophe/);
    expect(() => readFrontmatterDescription('---\ndescription: "no closing quote\n---\n', 'x')).
      toThrow(/double-quoted YAML scalar that does not close/);
    expect(() => readFrontmatterDescription('---\ndescription: "a \\u00e9 escape"\n---\n', 'x')).
      toThrow(/does not decode/);

    // …and the shapes it DOES decode round-trip against the real parser.
    for (const line of [
      `description: 'quoted, with "phrases" inside'`,
      `description: 'an apostrophe: it''s here'`,
      'description: "double quoted with a \\"phrase\\" inside"',
      'description: "a tab\\there and a slash\\/there"',
      'description: plain, unquoted, still fine',
    ]) {
      const md = `---\n${line}\n---\n`;
      const strict = strictParseDescription(md, line);
      expect(strict.ok, `fixture did not parse: ${line}`).toBe(true);
      expect(readFrontmatterDescription(md, line)).toBe((strict as { description: string }).description);
    }
  });

  it('the extractor fails loud instead of scanning nothing', () => {
    expect(() => readFrontmatterDescription('# no frontmatter\n', 'x')).toThrow(
      /does not open with YAML frontmatter/,
    );
    expect(() => readFrontmatterDescription('---\nname: x\n', 'x')).toThrow(/unterminated/);
    expect(() => readFrontmatterDescription('---\nname: x\n---\n', 'x')).toThrow(
      /no description: key/,
    );
    expect(() => readFrontmatterDescription('---\ndescription: >-\n  folded\n---\n', 'x')).toThrow(
      /multi-line or empty YAML scalar/,
    );
    expect(() =>
      readFrontmatterDescription('---\ndescription: starts here\n  and wraps\n---\n', 'x'),
    ).toThrow(/continues onto an indented line/);
    // …and the shape the corpus actually uses is read whole.
    expect(readFrontmatterDescription('---\nname: x\ndescription: one line.\n---\nbody\n', 'x')).toBe(
      'one line.',
    );
  });
});
