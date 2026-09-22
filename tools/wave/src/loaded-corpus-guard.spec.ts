/**
 * loaded-corpus-guard.spec.ts — the reading-class guard: what a run is
 * instructed to read, measured in bytes, and where each doctrine rule says its
 * enforcement lives.
 *
 * ## Why this is a sibling spec and not more of `skill-reference-guard.spec.ts`
 *
 * That file answers one question about the shipped skill corpus — *does this
 * reference resolve, and is it in the right place?* This file answers a
 * different one — *how much of that corpus does a run read, and is each rule's
 * stated enforcement real?* Same population, different subject, and the subject
 * here owns two pinned numbers that a later row is expected to come back and
 * lower. Keeping them in a small file makes that row a small diff.
 *
 * ## The four things this guard holds
 *
 *   **(1) The declaration line.** Directly under every
 *   `## Convention N — …` heading sits exactly one line of the fixed form
 *
 *       **Enforced by:** <rung> — <artifact>[; <rung> — <artifact> (<which half>)]
 *
 *   with the rung vocabulary CLOSED to the Enforcement-Tier ladder (engine
 *   refusal · schema boundary · drift-spec · hook · brief prose · reference
 *   doc). Four mechanical predicates, and only mechanical ones — the residual
 *   FORM of a promoted rule's prose is deliberately not mechanised (member 1
 *   of the Unmodelled set in the Guard declaration below):
 *
 *     - exactly one declaration per convention file, directly under the heading;
 *     - every rung word comes from the closed ladder;
 *     - a STRUCTURAL rung names at least one artifact, of the shape that rung
 *       implies — an `engine refusal` names an engine module, a `drift-spec`
 *       names a `*.spec.ts`, a `hook` names a hook asset. A rung whose artifact
 *       disagrees with it is a mislabelled rung, which is the failure a
 *       shape-only check cannot see;
 *     - every backticked path inside a declaration RESOLVES in the clone. This
 *       is the half that makes the line worth anything: a declaration naming a
 *       hook that has since been deleted turns the guard red instead of
 *       quietly becoming a lie. Self-policing in the same spirit as
 *       `skill-reference-guard.spec.ts`'s consumer-scaffold pairs.
 *
 *   A rule on a PROSE rung says so plainly — the rung word itself is the plain
 *   statement, and the check that keeps it honest is that a prose rung may not
 *   name a hook or a spec as its enforcement. Dressing prose up in a structural
 *   artifact is the one way the line could mislead while still parsing.
 *
 *   **(2) Two pinned byte measures**, one per reading class that a run actually
 *   reads:
 *
 *     - `SHARED_STANDING_LOAD_CEILING_BYTES` over `wave-shared/SKILL.md` plus
 *       `wave-shared/reference/*.md` — read before acting, on every run.
 *     - `LOADED_CORPUS_CEILING_BYTES` over every `.md` under `.claude/skills/**`
 *       and `.claude/agents/`, **except `**\/evidence/**`** — standing load plus
 *       step load, everything a run can reach.
 *
 *   The second constant is the first one's valve definition: with the standing
 *   load capped, text pushed out of it has exactly one destination that raises
 *   no measure — an `evidence/` sibling, the class no skill reads at runtime —
 *   and never a mechanics file, which costs per wave just as surely.
 *
 *   **(3) The dependency direction.** No `SKILL.md` body, `reference/` file or
 *   agent file *instructs* a runtime read of a `docs/…` path. Citations are
 *   untouched and stay governed by the existing resolution predicate: a pointer
 *   to *why* is the Evidence class working as designed, a dependency on *what*
 *   is a docs restructuring able to break an installed skill. The contributor
 *   README is deliberately out of the population — it is a document for people
 *   working on flotilla, not a skill body, and its own "Read `docs/CHARTER.md`"
 *   sentence is the positive control below that proves the detector fires.
 *
 *   **(4) No maintainer-only citation.** `MAINTAINER_ONLY_FILES` names the
 *   documents that describe a flotilla maintainer's duties; no shipped skill or
 *   agent file may point a consumer session at one.
 *
 * ## The ratchet, stated once because it is the whole mechanism
 *
 * **Lowering a ceiling is free. Raising one happens only in the same diff that
 * causes the growth, with a one-line why beside the number.** A walk-back row
 * lowers the bytes and leaves the constant alone; a ratchet row lowers the
 * constant to the new measure. Each constant is set to the measured sum on the
 * day it lands, rounded UP to the next full KB (1 KB = 1000 B, the unit the
 * decision record itself uses), so a wording fix passes and a new paragraph does
 * not. The guard prints both current sums on every run, so the number is visible
 * without reading this file.
 *
 * Both measures are per reading CLASS, never per file. That distinction is
 * load-bearing: an absolute per-file budget was considered and rejected
 * (arbitrary, instantly violated, a mass rewrite through the back door), and a
 * per-class measure shares none of those properties — text moving between files
 * inside a class does not escape it, and legitimate growth raises it visibly.
 *
 * Provenance: `docs/adr/0050-the-loaded-corpus-is-a-pinned-measure-and-a-rules-enforcement-tier-decides-its-reading-class.md`,
 * with the ladder and the diff-twin duty in
 * `docs/adr/0034-a-rule-earns-its-enforcement-tier.md`.
 *
 * Pure test — zero production change.
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is three levels
 * below the clone root.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The clone root — every path in this file is clone-relative. */
const CLONE_ROOT = resolve(__dirname, '../../..');

/** The two shipped skill/agent trees. */
const SKILL_DIRS = ['.claude/skills', '.claude/agents'] as const;

/** The Evidence reading class: read by no skill at runtime, so it is outside
 * every measure below. This is the valve — the one destination walked-back prose
 * can go to without raising a pinned number. */
const EVIDENCE_DIR_NAME = 'evidence';

/** The contributor-facing README. Not a skill body: it is written for someone
 * working ON flotilla, so its `docs/` reads are correct prose, and it is out of
 * the dependency-direction population for that reason (never because its
 * sentence would pass — it would not; see the positive control). */
const CONTRIBUTOR_README = '.claude/skills/README.md';

const CONVENTION_REFERENCE_DIR = '.claude/skills/wave-shared/reference';

// ─── Guard declaration (ADR-0052) ────────────────────────────────────────────

/**
 * **Subject.** The same markdown population `skill-reference-guard.spec.ts`
 * reads, asked a different question: the BYTE SIZE of every `.md` under
 * `.claude/skills/` and `.claude/agents/` (minus `evidence/`), the single
 * `**Enforced by:**` line in each convention reference file, and — by regex,
 * per sentence — prose in a shipped instruction file that tells a reader to
 * go and read a `docs/…` path at runtime.
 *
 * **Resolution bias — BLOCKS.** A convention file whose declaration line this
 * reader cannot resolve to exactly one well-formed declaration fails: zero
 * lines, two lines, a line not directly under the heading, an off-ladder rung
 * word, a rung naming nothing, a rung whose artifact shape disagrees with it,
 * or a backticked path that does not resolve in the clone. None of those
 * degrade to "no declaration found, carry on" —
 * {@link declarationOf} returns `null` and the assertion on it is what goes
 * red.
 *
 * The reason is what this line IS. Under ADR-0034 the declaration is the
 * residual left behind after a rule's prose was cut down, and its whole value
 * is that a reader can trust it without checking: an unreadable or absent
 * declaration is a rule whose rung is unstated, and two of them are two
 * answers to one question. A declaration naming a hook that has since been
 * deleted would otherwise quietly become a lie that reads exactly like the
 * truth. The two byte ceilings take the same direction from the other
 * side — a sum over files that cannot be read throws at `statSync`, never
 * silently shrinks toward passing — and floor counts
 * ({@link MIN_CONVENTION_FILES} and its siblings) refuse the other silent
 * green, a population that emptied.
 *
 * One branch resolves toward passing and it is a DECIDED pass: a `docs/…`
 * path inside a markdown LINK target is excluded from the dependency
 * direction rule by construction, because a citation is a pointer to *why*
 * and is the Evidence class working as designed. It is the rule's subject
 * boundary, not a shape the reader failed to parse.
 *
 * **The bias above is NOT uniform across this file's four rules, and that is
 * declared rather than smoothed over.** Rules (1) and (2) block, as stated.
 * Rules (3) and (4) — the dependency direction and the maintainer-only
 * citation — are single regexes over prose, and prose they do not recognize
 * yields no finding and therefore passes: see members 4 and 5 of the
 * Unmodelled set. Writing the bias down is what surfaced that split; it is
 * NOT corrected here, because correcting it would change a verdict set. The
 * divergence is filed as a finding instead.
 *
 * **Unmodelled set, named rather than assumed away.**
 *
 *  1. **The residual FORM of a promoted rule's prose.** Deliberately not
 *     mechanised: a heading whitelist is defeated by writing under an allowed
 *     heading, and Conventions 4 and 12 legitimately carry rule content in
 *     sub-sections. Only the four mechanical predicates above are checked.
 *  2. **Whether a declared rung is TRUE.** The check is that the rung word is
 *     on the closed ladder, that its artifact has the shape the rung implies,
 *     and that the path resolves. Nothing here opens the named spec or hook
 *     to confirm it enforces the rule the convention states.
 *  3. **Markdown grammar.** {@link extractDeclarations} matches a line
 *     prefix; {@link sitsDirectlyUnderHeading} counts blank lines. Neither
 *     knows a fence from prose, so a declaration line quoted inside a code
 *     block counts as a second declaration — which is the blocking bias
 *     above, not a silent pass.
 *  4. **English, in the dependency direction rule.**
 *     {@link DOCS_READ_INSTRUCTION} is a verb list, a 60-character window and
 *     a path shape. An instruction to read a `docs/…` file phrased with a
 *     verb outside {@link READ_VERB}, or with the path further than that
 *     window from the verb, or split across a sentence boundary, is not
 *     found. A false NEGATIVE is the direction this member leans.
 *  5. **Spelling, in the maintainer-only citation rule.** {@link citesPath}
 *     builds one regex per named file and tolerates leading `../` hops.
 *     A consumer pointed at a maintainer document by a rephrased title, a
 *     moved path, or a link whose text names it without its path is not
 *     found. This member leans the same way as member 4.
 *  6. **Everything outside the two populations.** `evidence/` files, the
 *     contributor README, `docs/` itself, and every non-markdown shipped
 *     asset contribute to no measure and are read by no rule. A run that
 *     reads bytes from outside them is a cost this guard does not see.
 */

// ─── populations ─────────────────────────────────────────────────────────────

/** Every `.md` under `dir`, clone-relative, sorted. `skipEvidence` drops any
 * path with an `evidence/` segment. */
function listMarkdown(dir: string, skipEvidence: boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const full = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (skipEvidence && entry.name === EVIDENCE_DIR_NAME) continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(CLONE_ROOT, full).split(sep).join('/'));
      }
    }
  };
  walk(join(CLONE_ROOT, dir));
  return out.sort();
}

/** The **standing load**: read before acting, on every run, whatever step
 * follows. `wave-shared`'s own loader reads the whole `reference/` directory, so
 * the population is the directory, not a list inside it. */
function sharedStandingLoadFiles(): string[] {
  return [
    '.claude/skills/wave-shared/SKILL.md',
    ...listMarkdown(CONVENTION_REFERENCE_DIR, true),
  ].sort();
}

/** The **loaded corpus**: standing load plus step load — everything a run can
 * be instructed to read. `evidence/` is excluded by definition. */
function loadedCorpusFiles(): string[] {
  return SKILL_DIRS.flatMap((dir) => listMarkdown(dir, true)).sort();
}

function sumBytes(files: readonly string[]): number {
  return files.reduce((total, f) => total + statSync(join(CLONE_ROOT, f)).size, 0);
}

const SHARED_STANDING_LOAD_FILES = sharedStandingLoadFiles();
const LOADED_CORPUS_FILES = loadedCorpusFiles();
const SHARED_STANDING_LOAD_BYTES = sumBytes(SHARED_STANDING_LOAD_FILES);
const LOADED_CORPUS_BYTES = sumBytes(LOADED_CORPUS_FILES);

// ─── the two pinned measures ─────────────────────────────────────────────────

/**
 * The shared standing load — `wave-shared/SKILL.md` + `wave-shared/reference/*.md`,
 * loaded whole before any back-half skill acts.
 *
 * Why this number: **RAISED by the row that corrects Convention 13's Catalog
 * entry 2**, in the diff that causes the growth, as the ratchet requires. That
 * entry named the wrong discriminator — it said a heredoc is refused "only when
 * a heredoc redirects straight to a file and its body contains `{`/`}`" — and a
 * field occurrence in wave `2026-09-16-engine-truth-and-verbs` had already
 * contradicted the redirect half of it. The corrected entry has to carry what 22
 * live probes established (neither the redirect target nor the tool is part of
 * the trigger, payload size is not it either, and the positional boundary is not
 * crisp enough to predict) *and* the remedy a Worker is meant to reach for
 * instead — the file-editing tool — so it is necessarily longer than the one
 * sentence it replaces. Everything that is evidence rather than rule went to the
 * `evidence/` sibling, the class no run reads, which is why the growth is 1,226 B
 * and not the several KB the probe matrix itself costs.
 *
 * At anchor commit `b9e3c4201f3d57bd44f49db7ef6649e0261e53eb` (`git rev-parse
 * HEAD` on this row's branch tip, before this row's own edit) the class measured
 * **158,309 B** over 18 files — 691 B under the 159,000 B ceiling, not the 2 B
 * this row's own issue text assumed (that figure was stale by two landings).
 * This row's single `reference/convention-13-one-bash-call-per-step.md` edit adds
 * **1,226 B**, landing the class at **159,535 B** over the same 18 files, so the
 * ceiling moves to that sum rounded UP to the next full KB (1 KB = 1000 B):
 * **160,000 B**. The 465 B of headroom that leaves is a fact about the rounding
 * rule, not a budget. (Issue #911, the row that closes that correction's four
 * disclosed residues, spent 391 B of it on the same file and left this constant
 * alone — 159,926 B is still inside 160,000 B. Its sibling below did have to
 * ratchet; the live sums are printed on every run either way.)
 *
 * Previously: 159,000 B — row #858's ratchet to its own landed measure of
 * 158,998 B, closing the loop row 824 (ADR-0051's canonical-spelling rewrite)
 * left open when it raised this ceiling precautionarily; before that 160,000 B
 * (row 824's raise), and before that 159,000 B — the ADR-0050 wave's own closing
 * ratchet row (#815), measured at 158,779 B on that wave's landed `main` and
 * rounded up the same way. Lowering a ceiling is still free: the next ratchet row
 * takes this back down to its own landed measure.
 */
const SHARED_STANDING_LOAD_CEILING_BYTES = 160_000;

/**
 * The loaded corpus — every `.md` a run can reach, `evidence/` excluded.
 *
 * Why this number: **RAISED by the row that closes the four residues the
 * Convention 13 Catalog correction left behind** (issue #911), in the diff that
 * causes the growth. One of those residues is a claim that over-reaches its
 * evidence — the corrected entry said the SAME 46-B body was refused through all
 * three destinations, when only two of the three legs carry it — and correcting
 * it costs more words than making it did: the entry now separates the pair that
 * shares a body (which is what establishes that the redirect target is not part
 * of the trigger) from the third leg that does not, and restates the conclusion
 * as resting on the pair. The other reference-file bytes are a probe command
 * re-rendered to match the matrix verbatim and one pointer word. Everything
 * bulky — the three-way refusal-string drift table, the measurement that no
 * engine matcher depends on that string, the per-leg body detail — went to the
 * `evidence/` sibling, which this population excludes by definition and which
 * therefore costs nothing here.
 *
 * At anchor commit `c0355f8b255a4487ae21fe820430b17487a59873` (`git rev-parse
 * HEAD` on this row's branch tip, before this row's own edit) the population
 * measured **1,226,890 B** over 57 files — 110 B under the 1,227,000 B ceiling
 * the Catalog correction left. This row's single
 * `wave-shared/reference/convention-13-one-bash-call-per-step.md` edit adds
 * **391 B**, landing the population at **1,227,281 B** over the same 57 files, so
 * the ceiling moves to that sum rounded UP to the next full KB (1 KB = 1000 B):
 * **1,228,000 B**. The shared standing load is NOT raised: the same 391 B land it
 * at 159,926 B against its unchanged 160,000 B ceiling, which had 465 B free.
 *
 * Previously: 1,227,000 B — the Convention 13 Catalog correction's own raise,
 * whose reasoning is kept below (in ITS voice, so "this row" there means that
 * row) because the chain back through the `models`-config row and #858 to the
 * ADR-0050 wave is what makes each step auditable.
 *
 * > Why this number: **RAISED by the same Convention 13 Catalog correction that
 * > raises the constant above**, in the diff that causes the growth. The shared
 * > standing load is a SUBSET of this population, so the one
 * > `wave-shared/reference/convention-13-one-bash-call-per-step.md` edit moves
 * > both measures by the same bytes and both ceilings ratchet in this one diff —
 * > the reasoning for the edit itself is on that constant and is not repeated
 * > here. The probe matrix that backs it went to the `evidence/` sibling, which
 * > this population excludes by definition and which therefore costs nothing
 * > here.
 * >
 * > At anchor commit `b9e3c4201f3d57bd44f49db7ef6649e0261e53eb` (`git rev-parse
 * > HEAD` on this row's branch tip, before this row's own edit) the population
 * > measured **1,224,896 B** over 57 files — 104 B under the 1,225,000 B ceiling
 * > the `models`-config row left. This row's own edit adds **1,226 B**, landing
 * > the population at **1,226,122 B** over the same 57 files, so the ceiling
 * > moves to that sum rounded UP to the next full KB (1 KB = 1000 B):
 * > **1,227,000 B**. (A self-referential SHA naming this row's own landing commit
 * > is not printable here — the hash covers the file's own bytes — so the anchor
 * > above is the closest verifiable fixed point.)
 * >
 * > Previously: 1,225,000 B — the `models`-config row's raise, whose own
 * > reasoning is kept below (in ITS voice, so "this row" there means that row)
 * > because the chain back through #858 to the ADR-0050 wave is what makes each
 * > step auditable.
 *
 * > Why this number: **RAISED by the row that ships the `models` config key**
 * > (ADR-0012 Amendment 2026-09-21), in the diff that causes the growth, as the
 * > ratchet requires. That row is the only ceiling raiser of its wave, and it
 * > adds operator-facing text in five places: `wave-setup`'s fourth interview
 * > concern and the `ModelsConfig` section + `WaveConfig` table row in its
 * > reference (the two largest), the corrected human-gate paragraph in
 * > `wave-start/reference/workflow-driver.md`, the standing-binding sentence in
 * > `wave-start/SKILL.md`, and the un-deferred clause in
 * > `wave-start/reference/start-mechanics.md`.
 * >
 * > At anchor commit `bb8c6af0603d33e9aa06e2900d3feccff0325960` the population
 * > measured **1,219,768 B** over 57 files — 232 B under the 1,220,000 B ceiling
 * > row #842 left. This row's own edit measures **1,224,896 B** over the same 57
 * > files, +5,128 B, so the ceiling moves to that sum rounded UP to the next full
 * > KB: **1,225,000 B**. The shared standing load is NOT raised: it measures
 * > 158,309 B against its unchanged 159,000 B ceiling (this row's one
 * > `wave-shared/SKILL.md` edit costs 133 B of the 824 B that class had free).
 * >
 * > Previously: 1,220,000 B — row #842's raise, whose own reasoning is kept
 * > below (in ITS voice, so "this row" there means #842) because the chain back
 * > through #858 to the ADR-0050 wave is what makes each step auditable.
 *
 * > Row #858 (the ratchet before it) left 54 B of
 * > headroom over its own anchor measure — 1,218,946 B against the 1,219,000 B
 * > ceiling — and its own comment named this row by number as the one meant to
 * > spend it, on `wave-start/reference/start-mechanics.md`. This row's step 7c
 * > reading clause adds 922 B to that file, landing the population at
 * > **1,219,868 B**, 868 B past that headroom. One full KB is the finest step
 * > the whole-KB-boundary rule admits, so the ceiling moves from 1,219,000 B to
 * > **1,220,000 B**.
 * >
 * > At anchor commit `3b4b8c4efc9ead706933c3cfd8ecc12578d1a3f9` (`git rev-parse
 * > HEAD` on this row's branch tip, before this row's own edit — unchanged from
 * > row #858's own anchor below, since nothing touched `.claude/skills/**` or
 * > `.claude/agents/` in the two commits between them) the population still
 * > measured **1,218,946 B**. This row's own edit is what moves it: measured
 * > **1,219,868 B** over the same 57 files with the step 7c clause applied,
 * > rounded UP to the next full KB (1 KB = 1000 B): **1,220,000 B**.
 *
 * > Previously: 1,219,000 B — row #858's ratchet, re-measured unchanged at
 * > 1,218,946 B at anchor `9e2e237b7759f68ce6a161164783c79476a1a508`, over the
 * > same cause as the constant above (the ADR-0051 wave's row 824 raise, made
 * > load-bearing by sibling row #762 — see that row's own history for the
 * > chain back to the ADR-0050 wave's 1,218,000 B).
 *
 * Lowering a ceiling is still free; the next ratchet row takes this back down
 * to its own landed measure. This raise leaves 719 B of headroom, which is a
 * fact about the rounding rule rather than a budget — the next row that adds
 * reading cost raises again, in its own diff.
 *
 * UNCHANGED by the PR-title advisory row (issue #912), which spent 339 B of
 * that headroom on `to-issues/SKILL.md`'s one-line title rule: the population
 * lands at 1,227,620 B over the same 57 files, and 1,227,620 B rounded UP to the
 * next full KB is 1,228,000 B — this constant already. A raise here would be a
 * pre-bought one. (The shared standing load is untouched: that row's only
 * corpus file is not in the class, which stays at 159,926 B.)
 */
const LOADED_CORPUS_CEILING_BYTES = 1_228_000;

/** Population floors. A measure over an empty population is green for the worst
 * possible reason, so both walkers have to keep finding files. */
const MIN_STANDING_LOAD_FILES = 17; // 18 at landing (SKILL.md + 17 reference files)
const MIN_CORPUS_FILES = 50; // 57 at landing
const MIN_CONVENTION_FILES = 16; // every allocated Convention number has a file
const MIN_INSTRUCTION_FILES = 40; // 54 shipped SKILL.md / reference/ / agent files at landing (corrected: replicating this predicate over the landing-day tree gives 54, not the 47 first written here)
const MIN_DOCS_CITING_FILES = 15; // 18 of those cite docs/ at landing — the class the predicate must not empty

// The guard prints both sums on every run, so the current cost is readable
// without opening this file.
console.log(
  `[loaded-corpus-guard] shared standing load: ${SHARED_STANDING_LOAD_BYTES} B over ` +
    `${SHARED_STANDING_LOAD_FILES.length} files — ceiling ${SHARED_STANDING_LOAD_CEILING_BYTES} B, ` +
    `headroom ${SHARED_STANDING_LOAD_CEILING_BYTES - SHARED_STANDING_LOAD_BYTES} B`,
);
console.log(
  `[loaded-corpus-guard] loaded corpus: ${LOADED_CORPUS_BYTES} B over ` +
    `${LOADED_CORPUS_FILES.length} files (evidence/ excluded) — ceiling ${LOADED_CORPUS_CEILING_BYTES} B, ` +
    `headroom ${LOADED_CORPUS_CEILING_BYTES - LOADED_CORPUS_BYTES} B`,
);

/**
 * The ceiling predicate, as a function so the real assertion and the
 * one-byte-over negative control run the SAME code. Returns `null` when the
 * class is within its ceiling, otherwise the operator-readable refusal.
 */
function ceilingViolation(label: string, sum: number, ceiling: number): string | null {
  if (sum <= ceiling) return null;
  return (
    `${label}: measured ${sum} B exceeds the pinned ceiling ${ceiling} B by ${sum - ceiling} B. ` +
    `Lowering a ceiling is free; RAISING one happens only in the diff that causes the growth, ` +
    `with a one-line why beside the number. If this diff genuinely adds reading cost, raise the ` +
    `constant to the new measure rounded up to the next full KB and say why. If it does not, the ` +
    `text belongs in an evidence/ sibling — the one class no run reads.`
  );
}

/** A ceiling must sit on a whole-KB boundary — the rounding rule, asserted
 * rather than trusted. */
function isWholeKb(ceiling: number): boolean {
  return ceiling % 1000 === 0;
}

// ─── the declaration line ────────────────────────────────────────────────────

/** The Enforcement-Tier ladder, as a CLOSED vocabulary. Ordered by the ladder's
 * own ranking (cheapest rent first); the order is documentation here, the
 * membership is the check. */
const ENFORCEMENT_RUNGS = [
  'engine refusal',
  'schema boundary',
  'drift-spec',
  'hook',
  'brief prose',
  'reference doc',
] as const;

type Rung = (typeof ENFORCEMENT_RUNGS)[number];

/** The two prose rungs. Everything else is structural and owes an artifact. */
const PROSE_RUNGS: readonly Rung[] = ['brief prose', 'reference doc'];

const isRung = (candidate: string): candidate is Rung =>
  (ENFORCEMENT_RUNGS as readonly string[]).includes(candidate);

const DECLARATION_PREFIX = '**Enforced by:** ';

/** An engine module — the artifact an `engine refusal` (or a `schema boundary`)
 * rung has to name. A spec is explicitly NOT one: a spec is the `drift-spec`
 * rung, and naming one under `engine refusal` claims a refusal that does not
 * exist at runtime. */
const isEngineModule = (path: string): boolean =>
  /^tools\/wave\/src\/[A-Za-z0-9._-]+\.ts$/.test(path) && !path.endsWith('.spec.ts');

/** A drift spec — the artifact a `drift-spec` rung has to name. */
const isDriftSpec = (path: string): boolean =>
  /^tools\/wave\/src\/[A-Za-z0-9._-]+\.spec\.ts$/.test(path);

/** A shipped hook asset — the artifact a `hook` rung has to name. */
const isHookAsset = (path: string): boolean =>
  /^tools\/wave\/hooks\/[A-Za-z0-9._-]+\.cjs$/.test(path);

/** What each rung's artifact must look like. `null` means the rung is a prose
 * rung and names no structure at all. */
const RUNG_ARTIFACT: Readonly<
  Record<Rung, { readonly structural: boolean; readonly shape: ((p: string) => boolean) | null; readonly label: string }>
> = {
  'engine refusal': {
    structural: true,
    shape: isEngineModule,
    label: 'an engine module under `tools/wave/src/` (not a spec)',
  },
  'schema boundary': {
    structural: true,
    shape: isEngineModule,
    label: 'the schema module under `tools/wave/src/` that carries the boundary',
  },
  'drift-spec': { structural: true, shape: isDriftSpec, label: 'a `*.spec.ts` under `tools/wave/src/`' },
  'hook': { structural: true, shape: isHookAsset, label: 'a `.cjs` hook under `tools/wave/hooks/`' },
  'brief prose': {
    structural: false,
    shape: null,
    label: 'the brief text a dispatched role is handed — never a hook and never a spec',
  },
  'reference doc': {
    structural: false,
    shape: null,
    label: 'a document read per session (`this file` is the ordinary answer) — never a hook and never a spec',
  },
};

interface DeclarationSegment {
  /** The rung word exactly as written — kept raw so an off-vocabulary word is
   * reportable rather than silently dropped. */
  readonly rawRung: string;
  /** The rung, or `null` when `rawRung` is not on the ladder. */
  readonly rung: Rung | null;
  /** Everything after the rung's own ` — ` separator. */
  readonly artifactText: string;
  /** Backticked, slash-bearing paths inside `artifactText`. */
  readonly paths: readonly string[];
}

interface Declaration {
  readonly file: string;
  readonly line: string;
  /** 0-based index of the line in the file — used to pin "directly under the
   * heading". */
  readonly lineIndex: number;
  readonly segments: readonly DeclarationSegment[];
}

/**
 * Split a declaration's body into rung segments. The separator is `; ` followed
 * by something shaped like `<rung word(s)> — `, so a semicolon inside a
 * parenthetical why never splits a segment, and an OFF-ladder rung in second
 * position still becomes its own segment (and is therefore still reportable)
 * rather than disappearing into the previous one's prose.
 */
const SEGMENT_SPLIT = /;\s+(?=[a-z][a-z -]{2,20} — )/;

/** A backticked path: at least one `/`, no spaces, no placeholders. */
const BACKTICKED_PATH = /`([A-Za-z0-9._][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)+)`/g;

function parseSegment(raw: string): DeclarationSegment {
  const dash = raw.indexOf(' — ');
  const rawRung = (dash === -1 ? raw : raw.slice(0, dash)).trim();
  const artifactText = dash === -1 ? '' : raw.slice(dash + ' — '.length).trim();
  return {
    rawRung,
    rung: isRung(rawRung) ? rawRung : null,
    artifactText,
    paths: [...artifactText.matchAll(BACKTICKED_PATH)].map((m) => m[1]),
  };
}

/** Every `**Enforced by:**` line in one file, with its line index. */
function extractDeclarations(md: string, file: string): Declaration[] {
  const lines = md.split('\n');
  const out: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(DECLARATION_PREFIX)) continue;
    const body = line.slice(DECLARATION_PREFIX.length).trim();
    out.push({
      file,
      line,
      lineIndex: i,
      segments: body.split(SEGMENT_SPLIT).map(parseSegment),
    });
  }
  return out;
}

/** The convention reference files, clone-relative, sorted by number. */
function conventionFiles(): string[] {
  return listMarkdown(CONVENTION_REFERENCE_DIR, true)
    .filter((f) => /\/convention-\d{2}-[a-z0-9-]+\.md$/.test(f))
    .sort();
}

const CONVENTION_FILES = conventionFiles();
const SOURCES = new Map(
  LOADED_CORPUS_FILES.map((f) => [f, readFileSync(join(CLONE_ROOT, f), 'utf-8')] as const),
);
const sourceOf = (file: string): string => {
  const body = SOURCES.get(file);
  if (body === undefined) throw new Error(`${file} is not in the corpus population`);
  return body;
};

/** The declaration of one convention file, or `null` when it has none. */
function declarationOf(file: string): Declaration | null {
  const found = extractDeclarations(sourceOf(file), file);
  return found.length === 1 ? found[0] : null;
}

/** Does `declaration` sit directly under the file's `## Convention N — …`
 * heading — i.e. is it the first non-blank line after it? */
function sitsDirectlyUnderHeading(md: string, declaration: Declaration): boolean {
  const lines = md.split('\n');
  if (!/^## Convention \d+ — /.test(lines[0] ?? '')) return false;
  for (let i = 1; i < declaration.lineIndex; i++) {
    if (lines[i].trim() !== '') return false;
  }
  return declaration.lineIndex > 0;
}

/** Every reason one declaration is not well-formed. Empty array = it holds. */
function declarationViolations(declaration: Declaration): string[] {
  const problems: string[] = [];
  for (const segment of declaration.segments) {
    if (segment.rung === null) {
      problems.push(
        `rung "${segment.rawRung}" is not on the closed ladder ` +
          `(${ENFORCEMENT_RUNGS.join(' · ')}). A rule is enforced on one of those rungs or on none.`,
      );
      continue;
    }
    if (segment.artifactText === '') {
      problems.push(`rung "${segment.rung}" names nothing after its em dash.`);
      continue;
    }
    const spec = RUNG_ARTIFACT[segment.rung];
    if (spec.structural) {
      if (segment.paths.length === 0) {
        problems.push(
          `structural rung "${segment.rung}" names no backticked artifact — it must name ${spec.label}. ` +
            `A structural claim with no artifact behind it is the promotion-without-structure case.`,
        );
      } else if (spec.shape !== null && !segment.paths.some(spec.shape)) {
        problems.push(
          `rung "${segment.rung}" names [${segment.paths.join(', ')}], none of which is ${spec.label}. ` +
            `The rung word and the artifact must agree — a mislabelled rung reads as structure and enforces nothing.`,
        );
      }
    } else {
      const dressedUp = segment.paths.filter((p) => isHookAsset(p) || isDriftSpec(p));
      if (dressedUp.length > 0) {
        problems.push(
          `prose rung "${segment.rung}" names ${dressedUp.join(', ')} — a hook or a spec is STRUCTURE. ` +
            `Either the rung is wrong or the artifact is; a prose rung has to say so plainly.`,
        );
      }
    }
    for (const path of segment.paths) {
      if (!existsSync(resolve(CLONE_ROOT, path))) {
        problems.push(
          `the artifact \`${path}\` does not resolve in the clone. A declaration naming a deleted ` +
            `hook, spec or module is a lie the reader cannot detect — rename the pointer or move the rule's rung.`,
        );
      }
    }
  }
  return problems;
}

// ─── the dependency direction: no runtime read of docs/ ──────────────────────

/**
 * The population for the two dependency-direction predicates: every shipped
 * `SKILL.md` body, every `reference/` file and every agent file. `evidence/` is
 * out by construction (no skill reads it at runtime), and the contributor README
 * is out because it is not a skill body.
 */
function isShippedInstructionFile(file: string): boolean {
  if (file === CONTRIBUTOR_README) return false;
  if (file.split('/').includes(EVIDENCE_DIR_NAME)) return false;
  return file.endsWith('/SKILL.md') || file.includes('/reference/') || file.startsWith('.claude/agents/');
}

const INSTRUCTION_FILES = LOADED_CORPUS_FILES.filter(isShippedInstructionFile);

const READ_VERB = '(?:re-)?read(?:s|ing)?|opens?|opening|loads?|loading|consults?|consulting|cat|inspects?|inspecting';
const DOCS_PATH = '(?:\\.{1,2}\\/)*docs\\/[A-Za-z0-9._/-]+';

/**
 * A read VERB governing a `docs/…` path within one sentence. The window stops at
 * sentence punctuation and at a newline, so the verb and the path have to be in
 * the same breath.
 */
const DOCS_READ_INSTRUCTION = new RegExp(`\\b(?:${READ_VERB})\\b([^.!?\\n]{0,60}?)(${DOCS_PATH})`, 'gi');

interface DocsReadInstruction {
  readonly file: string;
  readonly path: string;
  readonly excerpt: string;
}

/**
 * Sentences that *instruct* a read of `docs/`. A markdown LINK target is
 * excluded by construction — the declared-pass branch above. What this finds
 * is the other shape: prose or a command telling a reader to go and read a
 * contributor document at runtime.
 */
function docsReadInstructions(md: string, file: string): DocsReadInstruction[] {
  const out: DocsReadInstruction[] = [];
  for (const match of md.matchAll(DOCS_READ_INSTRUCTION)) {
    if (/\]\($/.test(match[1])) continue; // a markdown link target — a citation
    out.push({
      file,
      path: match[2],
      excerpt: md.slice(Math.max(0, match.index - 40), match.index + match[0].length).replace(/\n/g, ' '),
    });
  }
  return out;
}

/** A `docs/` citation in either shape — a markdown-link target or a backticked
 * path. Deliberately NOT a `/g` regex: it is used as a per-file boolean, and a
 * global regex carries `lastIndex` across calls, which silently skips every
 * other file (observed while landing this spec: 15 files counted instead of 18 —
 * corrected: the neighbouring `MIN_DOCS_CITING_FILES` comment and the landing
 * row's own report both give 18 as the true per-file count; the 30 first
 * written here did not match either).
 */
const DOCS_CITATION = /(?:\]\(|`)(?:\.{1,2}\/)*docs\/[A-Za-z0-9._/-]+/;

// ─── maintainer-only files ───────────────────────────────────────────────────

/**
 * Documents that describe a flotilla MAINTAINER's duties. A consumer session
 * reads the shipped skills; it must never be pointed at one of these, because
 * the procedure in them is not a step the consumer has, and following it would
 * be following somebody else's release.
 *
 * Every entry must resolve in the clone: an entry naming a file that no longer
 * exists is a stale prohibition, and the assertion below deletes it by going
 * red. The release procedure comes first because it is the site the rule was
 * stated over.
 */
const MAINTAINER_ONLY_FILES = [
  'docs/RELEASING.md', // the release procedure — the maintainer's own checklist, never a consumer step
  'CONTRIBUTING.md', // how to contribute TO flotilla; a consumer contributes to their own repo
  'PROVENANCE.md', // this repo's seed-point record — history of the toolkit, not of the consumer
] as const;

/** A citation of `path`, bare or backticked or as a link target, with any
 * number of leading `../` hops. */
function citesPath(md: string, path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\.{1,2}/)*${escaped}\\b`).test(md);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('loaded-corpus-guard — the two pinned reading-class measures', () => {
  it('finds both populations (a measure over an empty population is green for the worst reason)', () => {
    expect(SHARED_STANDING_LOAD_FILES.length).toBeGreaterThanOrEqual(MIN_STANDING_LOAD_FILES);
    expect(LOADED_CORPUS_FILES.length).toBeGreaterThanOrEqual(MIN_CORPUS_FILES);
    expect(SHARED_STANDING_LOAD_BYTES).toBeGreaterThan(0);
    expect(LOADED_CORPUS_BYTES).toBeGreaterThan(0);
  });

  it('the standing-load population is exactly wave-shared/SKILL.md plus wave-shared/reference/*.md', () => {
    expect(SHARED_STANDING_LOAD_FILES).toContain('.claude/skills/wave-shared/SKILL.md');
    for (const file of SHARED_STANDING_LOAD_FILES) {
      if (file === '.claude/skills/wave-shared/SKILL.md') continue;
      expect(file.startsWith(`${CONVENTION_REFERENCE_DIR}/`)).toBe(true);
      // One directory level only — the loader reads the directory, not a tree.
      expect(file.slice(CONVENTION_REFERENCE_DIR.length + 1)).not.toContain('/');
    }
    // …and the standing load is a SUBSET of the corpus: one class inside the other.
    for (const file of SHARED_STANDING_LOAD_FILES) expect(LOADED_CORPUS_FILES).toContain(file);
  });

  it('the corpus population is every .md a run can reach, and excludes every evidence/ directory', () => {
    for (const file of LOADED_CORPUS_FILES) {
      expect(file.startsWith('.claude/skills/') || file.startsWith('.claude/agents/')).toBe(true);
      expect(file.split('/')).not.toContain(EVIDENCE_DIR_NAME);
    }
    // The exclusion is real rather than vacuous: the walker DOES skip an
    // evidence/ directory when one exists — `wave-close/evidence/`,
    // `wave-shared/evidence/`, `wave-start/evidence/` and, as of issue #734,
    // `wave-setup/evidence/` all carry real files today, so this is a STRICT
    // inequality against the live clone, not a synthetic-only proof. The
    // synthetic-tree predicate below (`the evidence/ exclusion is
    // load-bearing`) stays as the permanent, file-independent control for the
    // path SHAPE, so the exclusion is still provably general — not "true
    // because these four directories happen to exist right now".
    const withEvidence = SKILL_DIRS.flatMap((dir) => listMarkdown(dir, false));
    expect(withEvidence.length).toBeGreaterThan(LOADED_CORPUS_FILES.length);
  });

  it('the shared standing load is within its pinned ceiling', () => {
    expect(
      ceilingViolation('shared standing load', SHARED_STANDING_LOAD_BYTES, SHARED_STANDING_LOAD_CEILING_BYTES),
    ).toBeNull();
  });

  it('the loaded corpus is within its pinned ceiling', () => {
    expect(ceilingViolation('loaded corpus', LOADED_CORPUS_BYTES, LOADED_CORPUS_CEILING_BYTES)).toBeNull();
  });

  it('each ceiling sits on a whole-KB boundary (the rounding rule, asserted not trusted)', () => {
    expect(isWholeKb(SHARED_STANDING_LOAD_CEILING_BYTES)).toBe(true);
    expect(isWholeKb(LOADED_CORPUS_CEILING_BYTES)).toBe(true);
    // A ceiling may sit ABOVE the measure (lowering is free — a walk-back row
    // drops bytes and leaves the constant alone), but never more than a
    // kilobyte above the rounded measure: that would be a pre-bought raise, the
    // one thing the diff-twin duty exists to make visible.
    expect(SHARED_STANDING_LOAD_CEILING_BYTES - SHARED_STANDING_LOAD_BYTES).toBeGreaterThanOrEqual(0);
    expect(LOADED_CORPUS_CEILING_BYTES - LOADED_CORPUS_BYTES).toBeGreaterThanOrEqual(0);
  });

  it('negative control — a corpus ONE BYTE over its ceiling fails the same predicate', () => {
    const oneByteOver = ceilingViolation(
      'loaded corpus',
      LOADED_CORPUS_CEILING_BYTES + 1,
      LOADED_CORPUS_CEILING_BYTES,
    );
    expect(oneByteOver).not.toBeNull();
    expect(oneByteOver as string).toContain('exceeds the pinned ceiling');
    expect(oneByteOver as string).toContain('by 1 B');
    // …and the same predicate on the standing load, from the other direction:
    // exactly AT the ceiling passes, so the boundary is `<=`, not `<`.
    expect(
      ceilingViolation('shared standing load', SHARED_STANDING_LOAD_CEILING_BYTES, SHARED_STANDING_LOAD_CEILING_BYTES),
    ).toBeNull();
  });

  it('the evidence/ exclusion is load-bearing — the walker skips such a directory where one exists', () => {
    // Several evidence/ directories are real in the clone today (the test
    // above already exercises the walker against them as a strict
    // inequality). This predicate stays as a permanent, path-shape-only
    // control (no file read, no clone dependency) so a FUTURE evidence/ path
    // under a skill that does not carry one yet is covered identically —
    // `isShippedInstructionFile` must read the shape, not a fixed allowlist.
    expect(isShippedInstructionFile('.claude/skills/wave-start/evidence/driver-history.md')).toBe(false);
    const asCorpusPath = '.claude/skills/wave-start/evidence/driver-history.md'.split('/');
    expect(asCorpusPath).toContain(EVIDENCE_DIR_NAME);
  });
});

describe('loaded-corpus-guard — every convention file declares its Enforcement Tier', () => {
  it('finds every convention reference file (a guard that matches nothing is green for the wrong reason)', () => {
    expect(CONVENTION_FILES.length).toBeGreaterThanOrEqual(MIN_CONVENTION_FILES);
    for (const file of CONVENTION_FILES) expect(SHARED_STANDING_LOAD_FILES).toContain(file);
  });

  it('each carries exactly ONE declaration line, directly under its Convention heading', () => {
    for (const file of CONVENTION_FILES) {
      const md = sourceOf(file);
      const found = extractDeclarations(md, file);
      expect(
        found.length,
        `${file} carries ${found.length} "${DECLARATION_PREFIX.trim()}" lines — exactly one is required. ` +
          `The line is the residual form's pointer to the enforcing structure; two of them means two answers ` +
          `to one question, none means the rule's rung is unstated.`,
      ).toBe(1);
      expect(
        sitsDirectlyUnderHeading(md, found[0]),
        `${file}'s declaration is at line ${found[0].lineIndex + 1}, not directly under its ` +
          `"## Convention N — " heading. A reader meets the rule and its rung together or not at all.`,
      ).toBe(true);
    }
  });

  it('every rung is on the closed ladder, agrees with the artifact it names, and that artifact resolves', () => {
    for (const file of CONVENTION_FILES) {
      const declaration = declarationOf(file);
      expect(declaration, `${file} has no single declaration to check`).not.toBeNull();
      expect(
        declarationViolations(declaration as Declaration),
        `${file}: ${(declaration as Declaration).line}`,
      ).toEqual([]);
    }
  });

  it('the population really does exercise every rung shape it can (the vocabulary is used, not decorative)', () => {
    const used = new Set<string>();
    for (const file of CONVENTION_FILES) {
      for (const segment of (declarationOf(file) as Declaration).segments) used.add(segment.rawRung);
    }
    // Structural and prose rungs are BOTH live in the corpus — if one side ever
    // emptied, half of these predicates would stop being exercised and nobody
    // would notice.
    expect([...used].some((r) => isRung(r) && !PROSE_RUNGS.includes(r as Rung))).toBe(true);
    expect([...used].some((r) => isRung(r) && PROSE_RUNGS.includes(r as Rung))).toBe(true);
    for (const rung of used) expect(ENFORCEMENT_RUNGS).toContain(rung);
  });

  it('Convention 12 names its two halves separately, on two different rungs', () => {
    const file = `${CONVENTION_REFERENCE_DIR}/convention-12-no-command-in-a-shell-variable.md`;
    expect(CONVENTION_FILES).toContain(file);
    const declaration = declarationOf(file) as Declaration;
    expect(declaration).not.toBeNull();
    expect(
      declaration.segments.length,
      `Convention 12's halves sit on different rungs — the hook holds the unquoted expansion, the prose ` +
        `holds the empty-capture discipline — so the declaration names two segments, not one.`,
    ).toBe(2);
    const rungs = declaration.segments.map((s) => s.rung);
    expect(new Set(rungs).size).toBe(2);
    expect(rungs).toContain('hook');
    // …and the hook it names is the one that actually ships.
    expect(declaration.segments.find((s) => s.rung === 'hook')?.paths).toContain(
      'tools/wave/hooks/conv12-guard.cjs',
    );
    // Each half is identified, so a reader knows which is which.
    expect(declaration.line).toMatch(/half one/);
    expect(declaration.line).toMatch(/half two/);
  });

  it('negative control — a convention file with NO declaration line fails the same predicate', () => {
    const file = `${CONVENTION_REFERENCE_DIR}/convention-15-coordinator-direct-boundary.md`;
    const stripped = sourceOf(file)
      .split('\n')
      .filter((l) => !l.startsWith(DECLARATION_PREFIX))
      .join('\n');
    expect(extractDeclarations(stripped, file)).toEqual([]);
    // …and the live file is not in that state.
    expect(extractDeclarations(sourceOf(file), file)).toHaveLength(1);
  });

  it('negative control — a declaration naming a DEAD artifact path fails the same predicate', () => {
    const planted = parseSegment('hook — `tools/wave/hooks/conv12-guard-renamed.cjs` (half one)');
    expect(existsSync(resolve(CLONE_ROOT, planted.paths[0]))).toBe(false);
    const problems = declarationViolations({
      file: 'planted.md',
      line: `${DECLARATION_PREFIX}hook — \`tools/wave/hooks/conv12-guard-renamed.cjs\` (half one)`,
      lineIndex: 2,
      segments: [planted],
    });
    expect(problems.join(' ')).toContain('does not resolve in the clone');
  });

  it('negative control — an OFF-VOCABULARY rung fails the same predicate', () => {
    const planted = parseSegment('lint rule — `tools/wave/src/route-tuple.ts`');
    expect(planted.rung).toBeNull();
    const problems = declarationViolations({
      file: 'planted.md',
      line: `${DECLARATION_PREFIX}lint rule — \`tools/wave/src/route-tuple.ts\``,
      lineIndex: 2,
      segments: [planted],
    });
    expect(problems.join(' ')).toContain('is not on the closed ladder');
    // The path itself resolves — so the ONLY reason this fails is the rung word,
    // which is what makes it a control for the vocabulary rather than for
    // resolution.
    expect(existsSync(resolve(CLONE_ROOT, 'tools/wave/src/route-tuple.ts'))).toBe(true);
  });

  it('negative control — a STRUCTURAL rung with no artifact, and one whose artifact disagrees with it', () => {
    const bare = parseSegment('engine refusal — the engine owns this one');
    expect(bare.rung).toBe('engine refusal');
    expect(
      declarationViolations({ file: 'planted.md', line: 'x', lineIndex: 2, segments: [bare] }).join(' '),
    ).toContain('names no backticked artifact');

    // A spec named under `engine refusal` — the mislabelled-rung case a
    // shape-only check reads as satisfied. The path RESOLVES; the rung is wrong.
    const mislabelled = parseSegment('engine refusal — `tools/wave/src/skill-reference-guard.spec.ts`');
    expect(existsSync(resolve(CLONE_ROOT, mislabelled.paths[0]))).toBe(true);
    expect(
      declarationViolations({ file: 'planted.md', line: 'x', lineIndex: 2, segments: [mislabelled] }).join(' '),
    ).toContain('none of which is');
  });

  it('negative control — a PROSE rung dressed up in a structural artifact fails', () => {
    const dressedUp = parseSegment('reference doc — `tools/wave/hooks/conv12-guard.cjs`');
    expect(dressedUp.rung).toBe('reference doc');
    expect(existsSync(resolve(CLONE_ROOT, dressedUp.paths[0]))).toBe(true); // resolves; still wrong
    expect(
      declarationViolations({ file: 'planted.md', line: 'x', lineIndex: 2, segments: [dressedUp] }).join(' '),
    ).toContain('a hook or a spec is STRUCTURE');
  });

  it('positive control — each live declaration shape parses into the segments it claims', () => {
    // `brief prose` naming the driver asset is legitimate: the brief text IS the
    // enforcement, and the file that carries it is neither a hook nor a spec.
    const briefProse = parseSegment('brief prose — `tools/wave/driver/wave-start-inflight.js` (the policy clause)');
    expect(briefProse.rung).toBe('brief prose');
    expect(declarationViolations({ file: 'p.md', line: 'x', lineIndex: 2, segments: [briefProse] })).toEqual([]);

    // A prose rung naming no path at all is legitimate too.
    const selfProse = parseSegment('reference doc — this file. A prose rung by design.');
    expect(selfProse.rung).toBe('reference doc');
    expect(selfProse.paths).toEqual([]);
    expect(declarationViolations({ file: 'p.md', line: 'x', lineIndex: 2, segments: [selfProse] })).toEqual([]);

    // A semicolon inside a parenthetical why does NOT split a segment.
    const oneSegment = parseSegment('engine refusal — `tools/wave/src/spine-cli.ts` (one op; one flush)');
    expect(`engine refusal — \`tools/wave/src/spine-cli.ts\` (one op; one flush)`.split(SEGMENT_SPLIT)).toHaveLength(1);
    expect(oneSegment.rung).toBe('engine refusal');
  });
});

describe('loaded-corpus-guard — the dependency direction: no runtime read of docs/', () => {
  it('finds the population, and the contributor README is not in it', () => {
    expect(INSTRUCTION_FILES.length).toBeGreaterThanOrEqual(MIN_INSTRUCTION_FILES);
    expect(INSTRUCTION_FILES).not.toContain(CONTRIBUTOR_README);
    expect(LOADED_CORPUS_FILES).toContain(CONTRIBUTOR_README); // in the BYTES, out of this predicate
    // Each of the three shapes the reading classes name is represented.
    expect(INSTRUCTION_FILES.some((f) => f.endsWith('/SKILL.md'))).toBe(true);
    expect(INSTRUCTION_FILES.some((f) => f.includes('/reference/'))).toBe(true);
    expect(INSTRUCTION_FILES.some((f) => f.startsWith('.claude/agents/'))).toBe(true);
  });

  it('no shipped skill body, reference file or agent file INSTRUCTS a read of a docs/ path', () => {
    const offenders = INSTRUCTION_FILES.flatMap((f) => docsReadInstructions(sourceOf(f), f));
    expect(
      offenders.map((o) => `${o.file}: …${o.excerpt}…`),
      `a shipped instruction file tells its reader to read a docs/ path at runtime. ` +
        `docs/ is the Evidence reading class: a pointer to WHY, never a dependency on WHAT. Cite the ` +
        `document (a link or a backticked path) and carry the load-bearing sentence in the skill itself, ` +
        `so a docs restructuring cannot break an installed skill.`,
    ).toEqual([]);
  });

  it('citations stay allowed — the population is full of them and none of them is an offender', () => {
    const cited = INSTRUCTION_FILES.filter((f) => DOCS_CITATION.test(sourceOf(f)));
    expect(
      cited.length,
      'the corpus cites docs/ in many files; if this ever reached zero the predicate above would be ' +
        'green because there is nothing left to get wrong.',
    ).toBeGreaterThanOrEqual(MIN_DOCS_CITING_FILES);
  });

  it('positive control — the contributor README\'s own docs/ read DOES fire the detector', () => {
    // The README is out of the population by DECISION, not because it would
    // pass. This is the single runtime-read instruction the corpus measurement
    // found, and running it through the same detector is what proves the
    // detector can see the shape at all.
    const readme = sourceOf(CONTRIBUTOR_README);
    const found = docsReadInstructions(readme, CONTRIBUTOR_README);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found[0].path.startsWith('docs/')).toBe(true);
  });

  it('negative control — a planted docs/ read instruction in a real population file fails the same predicate', () => {
    const host = `${CONVENTION_REFERENCE_DIR}/convention-14-citation-placement.md`;
    expect(INSTRUCTION_FILES).toContain(host);
    expect(docsReadInstructions(sourceOf(host), host)).toEqual([]);

    const planted = `${sourceOf(host)}\n\nBefore placing a citation, read \`docs/CHARTER.md\` §4 for the split.\n`;
    const offenders = docsReadInstructions(planted, host);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].path).toBe('docs/CHARTER.md');

    // …and a command form is caught too, not only prose.
    expect(docsReadInstructions('Run `cat docs/RELEASING.md` first.\n', host)).toHaveLength(1);
  });

  it('a markdown-link citation is NOT an instruction, even in a sentence with a read verb', () => {
    // The live shape this exemption exists for: four corpus sentences pair a
    // read verb with an ADR link. They are citations, and class-(b)/(a)
    // resolution already governs them.
    const citation =
      'The SHA assert is what matters, `FETCH_HEAD` is never read ' +
      '([ADR-0034](../../../docs/adr/0034-a-rule-earns-its-enforcement-tier.md)).\n';
    expect(docsReadInstructions(citation, '.claude/skills/wave-reviewer/SKILL.md')).toEqual([]);
  });
});

describe('loaded-corpus-guard — no maintainer-only file is cited in the shipped corpus', () => {
  it('the const names the release procedure first, and every entry still exists', () => {
    expect(MAINTAINER_ONLY_FILES[0]).toBe('docs/RELEASING.md');
    expect(MAINTAINER_ONLY_FILES.length).toBeGreaterThanOrEqual(1);
    for (const file of MAINTAINER_ONLY_FILES) {
      expect(
        existsSync(resolve(CLONE_ROOT, file)),
        `${file} is listed as maintainer-only but does not exist. A prohibition on a file nobody can ` +
          `cite is dead weight — delete the entry in the diff that deleted the file.`,
      ).toBe(true);
    }
  });

  it('no shipped skill or agent file cites one', () => {
    const offenders: string[] = [];
    for (const file of INSTRUCTION_FILES) {
      const md = sourceOf(file);
      for (const maintainerFile of MAINTAINER_ONLY_FILES) {
        if (citesPath(md, maintainerFile)) offenders.push(`${file} → ${maintainerFile}`);
      }
    }
    expect(
      offenders,
      `a shipped skill or agent file points its reader at a maintainer-only document. Those describe ` +
        `flotilla's own release and contribution duties; a consumer session has no such step, and following ` +
        `one would be following somebody else's procedure. State the duty where it belongs — this repo's ` +
        `own contributor docs — and leave the shipped skill silent about it.`,
    ).toEqual([]);
  });

  it('negative control — a planted maintainer-file citation fails the same predicate', () => {
    const host = `${CONVENTION_REFERENCE_DIR}/convention-15-coordinator-direct-boundary.md`;
    expect(citesPath(sourceOf(host), 'docs/RELEASING.md')).toBe(false);

    // The exact shape row #801's predecessor removed: a release-checklist
    // pointer inside an acceptance criterion's prose.
    expect(citesPath('After the wave lands, follow `docs/RELEASING.md` step 3.\n', 'docs/RELEASING.md')).toBe(true);
    // …and the link-target form, which a bare-path matcher would walk past.
    expect(citesPath('see [the release procedure](../../../../docs/RELEASING.md)\n', 'docs/RELEASING.md')).toBe(true);
    // A near-miss must NOT fire: a different file in the same directory.
    expect(citesPath('see `docs/RELEASE-NOTES.md`\n', 'docs/RELEASING.md')).toBe(false);
  });
});
