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
 * **Resolution bias — SPLIT: rules (1) and (2) BLOCK, rules (3) and (4)
 * PASS.** One word would be a lie here, so the declaration carries two, and
 * the two halves are set out below in that order. **The split IS the
 * resolution, not an open finding** — see "the passing half" below for the
 * ruling and its ground.
 *
 * **The blocking half — rules (1) and (2).** A convention file whose
 * declaration line this reader cannot resolve to exactly one well-formed
 * declaration fails: zero lines, two lines, a line not directly under the
 * heading, an off-ladder rung word, a rung naming nothing, a rung whose
 * artifact shape disagrees with it, or a backticked path that does not
 * resolve in the clone. None of those degrade to "no declaration found, carry
 * on" — {@link declarationOf} returns `null` and the assertion on it is what
 * goes red.
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
 * **The passing half — rules (3) and (4) — and the ruling that keeps it
 * that way.** The dependency direction and the maintainer-only citation are
 * each a SINGLE REGEX OVER PROSE, and prose such a regex does not recognize
 * yields no finding, which reads as clean: see members 4 and 5 of the
 * Unmodelled set. Writing the bias down is what surfaced the divergence, and
 * the divergence is now RULED ON rather than left open: **the split is the
 * resolution.**
 *
 * The ground is a property of the instrument, not a preference. A single
 * regex over prose cannot distinguish "prose I do not recognize" from "prose
 * with no finding" — a non-match is the same event in both cases, so the
 * scanner never reaches a state it could call inconsistent and there is no
 * moment at which it could honestly abstain. Forcing these two rules to block
 * would therefore produce refusals with nothing behind them, which is the
 * failure ADR-0052 decision 3 rules out: an Abstention is triggered by the
 * Guard's OWN broken invariant, never by a construct allowlist, and a regex
 * that matched nothing has no broken invariant to report. Rules (1) and (2)
 * take the other direction because they genuinely have one — rule (1) parses
 * a structured line against a closed vocabulary and can find that line
 * absent, doubled or misplaced; rule (2) sums bytes and throws on a file it
 * cannot read. One guard, two kinds of subject, two answers, declared per
 * rule rather than averaged into a single word that would be false for half
 * the file.
 *
 * No rule changes with this ruling and no verdict set moves; what changed is
 * that the bias line above is now honest about both halves. The keeper in
 * `guard-declaration-keeper.spec.ts` reads that line, and a `SPLIT` bias that
 * failed to name both directions would fail there.
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
 * **UNCHANGED by the row that renames "wave anchor" to the glossary's
 * per-round Anchor wherever shipped prose still used the retired term**
 * (issue #997), which spent 3 B of that headroom on
 * `reference/convention-11-prove-the-check-can-fail.md` alone: its "is that
 * check's failing condition new with this slice" question now reads "absent
 * at the round's Anchor SHA" rather than "absent at the wave anchor SHA". At
 * anchor `84fa1abc38b2c0e10cedc3f414a2ba89f184abc1` the class measured
 * **167,178 B**; the edit lands it at **167,181 B** over the same 18 files,
 * and that rounded UP to the next full KB is still **168,000 B** — this
 * constant already. Headroom is 819 B, still a rounding fact and not a budget.
 *
 * Why this number: **RAISED by the row that fills wave
 * `2026-09-25-review-signals-and-round-hygiene`'s close-time reference-doc
 * gaps** (issue #998), in the diff that causes the growth. Its one
 * standing-load edit is entirely inside
 * `reference/convention-05-sidecar-write-path.md`: a new bullet describing
 * `route-tuple`'s routing-time repair of a sidecar that disagrees with the
 * payload it is handed (issue #977's own shipped behaviour, undocumented
 * until now) — the divergence compare, the passed-payload-wins rule, the
 * `warning:` line, and the `repaired` result key beside `recovered`.
 *
 * At this row's anchor commit `07a32f9ca2099c71465bc2ebaa5e94427a062c5a` the
 * class measured **165,704 B** over 18 files — 296 B under the previous
 * 166,000 B ceiling (issue #1006 had already spent 235 B of that headroom on
 * the host-landing-seam convention's `--expect-head` line without needing a
 * raise). This row's edit adds **1,474 B**, landing the class at
 * **167,178 B** over the same 18 files, so the ceiling moves to that sum
 * rounded UP to the next full KB (1 KB = 1000 B): **168,000 B**. The 822 B of
 * headroom that leaves is a fact about the rounding rule, not a budget.
 *
 * Previously: 166,000 B — **RAISED by the row that documents a `.claude/**`
 * restore half-applying under the sandbox write-deny and adds the null-result
 * classifier-refusal measurement that follows from it** (issue #994), whose
 * reasoning is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that documents a `.claude/**` restore
 * half-applying under the sandbox write-deny and adds the null-result
 * classifier-refusal measurement that follows from it** (issue #994), in the
 * diff that causes the growth. Its one standing-load edit is entirely inside
 * `reference/convention-13-one-bash-call-per-step.md`: a new Catalog entry 7
 * (a multi-path `git checkout`/`merge`/`pull` half-applying under the
 * `.claude/**` write-deny — a Worker's falsification-restore and the
 * between-rounds default-branch update, each with its own working form) and
 * a matching addition to the closing "Live occurrences" pointer sentence.
 * The full symptom detail, the raw per-attempt measurement table (30
 * file-editing-tool edit-and-revert cycles across three targets, zero
 * refusals) and the reproduction record went to the `evidence/` sibling, the
 * class no run reads and neither pinned measure counts.
 *
 * At that row's anchor commit `de2e1c3536cb641e04f5863c7a1952a657240ec5` the
 * class measured **163,078 B** over 18 files — 922 B under the previous
 * 164,000 B ceiling. That row's edit added **2,391 B**, landing the class at
 * **165,469 B** over the same 18 files, so the ceiling moved to that sum
 * rounded UP to the next full KB (1 KB = 1000 B): **166,000 B**. The 531 B of
 * headroom that left was a fact about the rounding rule, not a budget.
 *
 * Before that: 164,000 B — **RAISED by the row that names the landing
 * message's two exceptions wherever the shipped prose says what lands under
 * `pr`** (issue #980, ADR-0053 dated note 2026-09-25), whose reasoning is
 * kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that names the landing message's two
 * exceptions wherever the shipped prose says what lands under `pr`** (issue
 * #980, ADR-0053 dated note 2026-09-25), in the diff that causes the growth.
 * Its one standing-load edit is a single clause in
 * `reference/convention-07-host-landing-seam.md` — "not under a merge queue (it
 * composes its own commit) or `--method rebase` (no single commit)" — because
 * that sentence is the convention every arm/merge caller follows, and it
 * promised without condition what a queue or a rebase never delivers. The
 * vendor quotes behind the two exceptions went to the ADR's dated note, which
 * neither pinned population counts.
 *
 * At that row's anchor commit `9098c29d71545656ea98e24029d1822022179657` the
 * class measured **162,981 B** over 18 files — 19 B under the previous
 * 163,000 B ceiling. That row's edit added **97 B**, landing the class at
 * **163,078 B** over the same 18 files, so the ceiling moved to that sum
 * rounded UP to the next full KB (1 KB = 1000 B): **164,000 B**. The 922 B of
 * headroom that left was a fact about the rounding rule, not a budget.
 *
 * Before that: 163,000 B — **RAISED by the row that catalogues three
 * command-shape occurrences** (issue #954), whose reasoning is kept below (in
 * ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that catalogues three command-shape
 * occurrences the catalogue did not carry, and adds the file-editing tool's
 * byte-verification caveat** (issue #954), in the diff that causes the growth.
 * `reference/convention-13-one-bash-call-per-step.md` gains a sixth Catalog
 * entry (an absolute-quoted-path runner refusal, refused with a shape-specific
 * generated message rather than fusion or a `$VAR` shape), a short caveat
 * sentence on Catalog entry 2's file-editing-tool remedy — the "no occurrence
 * on record has it refused" claim is about refusals only, not byte fidelity —
 * a clause on Catalog entry 4 naming a third occurrence (an accepted fused call
 * that landed correctly, caught only by its row's own disclosure), and a
 * matching addition to the closing "Live occurrences" pointer sentence. Every
 * station table, verbatim refusal text and the caveat's own full narrative
 * (the escape-sequence-to-raw-codepoint conversion this row measured) went to
 * the `evidence/` sibling, the class no run reads and neither pinned
 * population counts.
 *
 * At this row's anchor commit `ee53d4ef07b8dea0973b8d3daeabacbeec2feed8` the
 * class measured **161,176 B** over 18 files — 824 B under the previous
 * 162,000 B ceiling. This row's edit adds **1,409 B**, landing the class at
 * **162,585 B** over the same 18 files, so the ceiling moves to that sum
 * rounded UP to the next full KB (1 KB = 1000 B): **163,000 B**. The 415 B of
 * headroom that leaves is a fact about the rounding rule, not a budget.
 *
 * **UNCHANGED by the row that composes the landing verbs' `--commit-message`
 * from `landing.commitMessage` (ADR-0053, issue #964), which spent 396 B of
 * that headroom** on its one standing-load file,
 * `reference/convention-07-host-landing-seam.md`: the canonical arm and merge
 * forms now carry `--commit-message <pr|host>`, and one paragraph states where
 * its value comes from. At that row's anchor commit
 * `902d76c5ebf556a2d089f2589634695b140f145a` the class measured **162,585 B**
 * over 18 files; the edit lands it at **162,981 B** over the same 18 files, and
 * 162,981 B rounded UP to the next full KB is 163,000 B — this constant
 * already. A raise here would be a pre-bought one. Headroom is 19 B, which is
 * still a rounding fact and still not a budget; the loaded-corpus constant
 * below did have to ratchet, and says why.
 *
 * Previously: 162,000 B — **RAISED by the row that catalogues two live occurrences of
 * a brief clause reaching its limit** (issue #917), in the diff that causes the
 * growth. Its only standing-load edits are two short additions to
 * `reference/convention-13-one-bash-call-per-step.md`: the Catalog's entry 4
 * line gains a clause noting that two later occurrences show "accepted"
 * silently validating the wrong checkout rather than only skipping a dialog,
 * and the closing "Live occurrences" pointer sentence gains the same two
 * occurrences plus a pointer to an open question the row leaves unresolved.
 * Every occurrence's own detail — both Convention 13 entries, the new
 * Convention 8 guard-collision entry, and the open-question section itself —
 * went to the `evidence/` siblings, the class no run reads and neither pinned
 * population counts.
 *
 * At that row's anchor commit `7d603e59f3bb559649eed5d40bc8ffc7ee4bad94` the
 * class measured **160,919 B** over 18 files — 81 B under the previous
 * 161,000 B ceiling. That row's edit added **257 B**, landing the class at
 * **161,176 B** over the same 18 files, so the ceiling moved to that sum
 * rounded UP to the next full KB (1 KB = 1000 B): **162,000 B**. The 824 B of
 * headroom that left was a fact about the rounding rule, not a budget.
 *
 * Before that: 161,000 B — **RAISED by the row that rebuilds `conv12-guard.cjs`'s
 * scanner and gives it ADR-0052's third answer kind** (flotilla#710), in the
 * diff that causes the growth. The hook's observable behaviour changed in a way
 * an operator meets mid-wave and cannot infer: it now has an **Abstention** —
 * an answer that blocks, in the vocabulary of a non-verdict, and that must not
 * be read as a finding — and the shape it used to refuse wrongly
 * (`jq . "$(dirname "$Y")"`, measured at 60% of all its refusals on live
 * traffic) now passes. One paragraph in `reference/`'s half one carries exactly
 * that: the three answer kinds, what to do with an Abstention, and the pointer
 * to the declared Unmodelled set. **1,029 B.** The measurement behind it — the
 * controls, the 3750-command replay, the before/after table, the two
 * false-negative channels — went to the `evidence/` sibling, the class no run
 * reads, which is why the standing load pays a paragraph and not the several KB
 * the record itself costs.
 *
 * At that row's anchor commit `65108c75fdac708f538709be2828aa3884fec41f` the
 * class measured **159,926 B** over 18 files — 74 B under the previous 160,000 B
 * ceiling. This row's single `reference/convention-12-no-command-in-a-shell-variable.md`
 * edit lands it at **160,955 B** over the same 18 files, so the ceiling moves to
 * that sum rounded UP to the next full KB (1 KB = 1000 B): **161,000 B**. The
 * 45 B of headroom that leaves is a fact about the rounding rule, not a budget.
 *
 * **NOT raised by issue #910 (2026-09-22), which spent NEGATIVE bytes here.**
 * That row re-measured Convention 13's Catalog entry 1 against the current
 * harness — five stations, all re-run live — and had to rewrite three catalog
 * entries and two Common Mistakes bullets to say what it found. It paid for them
 * by deleting the same evidence-pointer parenthetical that the same reference
 * file repeated seven times, keeping one full-path occurrence and letting the
 * other six read "in the evidence sidecar" as the catalog entries already did.
 * Net **−36 B**: the class lands at **160,919 B** over the same 18 files, so the
 * round-up is still 161,000 B and this constant stays exactly where it is. Every
 * measurement that row made — the station table, the probe log, the size ladder,
 * both current refusal texts — went to the `evidence/` sibling, the class no run
 * reads. Headroom is 81 B, which is still a rounding fact and still not a budget.
 *
 * Previously: 160,000 B — **RAISED by the row that corrected Convention 13's
 * Catalog entry 2**, in the diff that caused that growth. That
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
 * Before that: 159,000 B — row #858's ratchet to its own landed measure of
 * 158,998 B, closing the loop row 824 (ADR-0051's canonical-spelling rewrite)
 * left open when it raised this ceiling precautionarily; before that 160,000 B
 * (row 824's raise), and before that 159,000 B — the ADR-0050 wave's own closing
 * ratchet row (#815), measured at 158,779 B on that wave's landed `main` and
 * rounded up the same way. Lowering a ceiling is still free: the next ratchet row
 * takes this back down to its own landed measure.
 */
const SHARED_STANDING_LOAD_CEILING_BYTES = 168_000; // RAISED by issue #998 — see the docblock above.
// NOT raised or lowered by issue #818 (the wave-shared schema-copies-to-evidence move): the two
// WORKER_REPORT_SCHEMA/REVIEWER_VERDICT_SCHEMA literals and their notes moved out of
// wave-shared/SKILL.md into its evidence/ sibling (excluded from this measure by definition), leaving
// a short pointer in their place. That row's own edit re-measures the population at 159,720 B over
// the same 18 files — 8,280 B of headroom, up from row #997's 819 B — and leaves this constant
// exactly where row #998 set it, for a later ratchet row to lower.

/**
 * The loaded corpus — every `.md` a run can reach, `evidence/` excluded.
 *
 * **UNCHANGED by the row that renames "wave anchor" to the glossary's
 * per-round Anchor wherever shipped prose still used the retired term, and
 * closes the landing-message dated-note gap** (issue #997), which spent
 * 456 B of that headroom across four files: wave-close's `SKILL.md`
 * self-repair-hazard bullet, reworded to hold for both a land-at-close wave
 * and one that re-anchors between rounds (+234 B), and its
 * `phase-4a-self-repair-pull.md` twin, reworded the same way (+198 B);
 * wave-shared's `reference/convention-11-prove-the-check-can-fail.md`
 * (+3 B, the standing-load spend above); and wave-start's `SKILL.md`, whose
 * W2-F1 retro rewords "the Coordinator defined the wave anchor as a
 * constant" to "a single constant for the whole wave", keeping the historical
 * fact (one constant, not per-round) without the retired term (+21 B). At
 * anchor `84fa1abc38b2c0e10cedc3f414a2ba89f184abc1` the population measured
 * **1,275,517 B**; the edit lands it at **1,275,973 B** over the same 57
 * files, and that rounded UP to the next full KB is still **1,276,000 B** —
 * this constant already. Headroom is 27 B, still a rounding fact and not a
 * budget.
 *
 * Why this number: **RAISED by the row that fills wave
 * `2026-09-25-review-signals-and-round-hygiene`'s close-time reference-doc
 * gaps** (issue #998), in the diff that causes the growth. Five shipped
 * reference copies had gone stale or stayed silent about behaviour that
 * already shipped: wave-close's `close-mechanics.md` names `probes`,
 * `detached` and `unaccounted` in the `worktree-cleanup` result shape
 * (+290 B); its `phase-3-worktree-cleanup.md` gains the read-each-reviewed-
 * head-before-the-sweep paragraph and the consequence of skipping it (ADR-0055,
 * +1,307 B); wave-shared's `reference/convention-05-sidecar-write-path.md`
 * gains the routing-time sidecar-divergence-repair bullet (issue #977's own
 * shipped behaviour, +1,474 B, the standing-load raise above); wave-start's
 * `SKILL.md` between-rounds item 5 names the exit-code read, the
 * `erroredStillListed` shape and the follow-up branch-deletion call (+571 B),
 * and its `start-mechanics.md` twin carries the same in invocation form
 * (+1,065 B).
 *
 * At this row's anchor commit `07a32f9ca2099c71465bc2ebaa5e94427a062c5a` the
 * population measured **1,270,810 B** over 57 files — 190 B under the
 * previous 1,271,000 B ceiling. This row's edit lands it at **1,275,517 B**
 * over the same 57 files, +4,707 B, so the ceiling moves to that sum rounded
 * UP to the next full KB (1 KB = 1000 B): **1,276,000 B**. The shared standing
 * load is touched by one of the five files (`convention-05-sidecar-write-path.md`);
 * its own ceiling raise is documented above.
 *
 * Previously: 1,271,000 B — **RAISED by the row that makes every wave landing
 * pass the reviewed head** (issue #1006, ADR-0055), whose reasoning is kept
 * below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that makes every wave landing pass the
 * reviewed head** (issue #1006, ADR-0055), in the diff that causes the growth.
 * Each skill step that lands a wave row now passes `--expect-head` with the
 * commit `refs/review/<id>` points at, states the abstention when the ref is
 * missing, and states the no-commit-after-verdict rule: wave-start's
 * `SKILL.md` between-rounds step 1 (+567 B) and its `start-mechanics.md`
 * invocation (+323 B); wave-close's `SKILL.md` — the phase-3 read-before-sweep
 * sentence, the phase-4/4b flag and the rule section (+1,006 B) — its
 * `close-mechanics.md` resolution section and command rows (+814 B),
 * `phase-4b-partial-arm.md` (+592 B) and `phase-4-advisory-merge-order.md`
 * (+210 B); and the host-landing-seam convention (+235 B).
 *
 * At that row's anchor commit `710e8dcc204b274160af3ee564bd4c097e4c260a` the
 * population measured **1,267,063 B** over 57 files — 937 B under the previous
 * 1,268,000 B ceiling. That row's edit landed it at **1,270,810 B** over the
 * same 57 files, +3,747 B, so the ceiling moved to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,271,000 B**.
 *
 * Before that: 1,268,000 B — **RAISED by the row that gives an Operator's
 * answer to a Reviewer's question a documented path back to a re-review**
 * (issue #992), whose reasoning is kept below (in ITS voice, so "this row"
 * there means that row).
 *
 * Why that number: **RAISED by the row that gives an Operator's answer to a
 * Reviewer's question a documented path back to a re-review** (issue #992), in
 * the diff that causes the growth. wave-start's `SKILL.md` step 8 gains the
 * four-step path for an answered `reviewer-questions-blocking` — the criterion
 * rewrite (never a hint), the probe removal, the `--reviewer-only` round
 * (+1,256 B); `start-mechanics.md` gains the matching `compose-driver
 * --reviewer-only` invocation in §8, the flag and the receipt's `mode` in step
 * 6, and the new refusal (+1,404 B); `workflow-driver.md` gains the mode
 * paragraph beside the compose-time refusals (+612 B). The live occurrence and
 * the hand-patched copy the flag replaces went to the `wave-start` `evidence/`
 * siblings, which this population excludes.
 *
 * At this row's anchor commit `3b3dac2d6978b4957d9292e260472898c4a9134a` the
 * population measured **1,263,791 B** over 57 files — 209 B under the previous
 * 1,264,000 B ceiling. This row's edit lands it at **1,267,063 B** over the
 * same 57 files, +3,272 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,268,000 B**. The shared standing load is
 * NOT touched: none of the three files is a member of that population.
 *
 * Previously: 1,264,000 B — **RAISED by the row that closes the three observed
 * ways a stamped Reviewer probe outlives its review** (issue #991), whose
 * reasoning is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that closes the three observed ways a
 * stamped Reviewer probe outlives its review** (issue #991), in the diff that
 * causes the growth. Every Reviewer-facing copy gains the revert-and-verify-
 * clean rule for the Reviewer's own probe edits — the agent definition
 * (+340 B), wave-reviewer's `SKILL.md` (+285 B) and its `reviewer-checks.md`
 * (+361 B); wave-start's `SKILL.md` step 8 names what a Reviewer STOP leaves
 * standing and when to remove it, and its step-7 running set gains the two
 * resumed states (+680 B together); `start-mechanics.md` gains the matching
 * removal invocation and running set (+701 B); wave-close's phase-3 reference
 * moves to the path-ends-in-the-stamp wording and the five-state running set
 * (+131 B). The live occurrences behind all three went to the `wave-start` and
 * `wave-close` `evidence/` siblings, which this population excludes.
 *
 * At this row's anchor commit `87904ba1a8aafaeb16816918aa34e74c58916abb` the
 * population measured **1,261,293 B** over 57 files — 707 B under the previous
 * 1,262,000 B ceiling. This row's edit lands it at **1,263,791 B** over the
 * same 57 files, +2,498 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,264,000 B**. The shared standing load is
 * NOT touched: none of the six files is a member of that population.
 *
 * Previously: 1,262,000 B — **RAISED by the row that documents a `.claude/**`
 * restore half-applying under the sandbox write-deny** (issue #994), whose
 * reasoning is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that documents a `.claude/**` restore
 * half-applying under the sandbox write-deny and rewrites the between-rounds
 * default-branch update to fetch + `merge --ff-only`** (issue #994), in the
 * diff that causes the growth. Three loaded files grow: `wave-shared`'s
 * `reference/convention-13-one-bash-call-per-step.md` gains Catalog entry 7
 * and its "Live occurrences" addition (+2,391 B, the standing-load raise
 * above), wave-start's `SKILL.md` between-rounds step 2 is rewritten from a
 * one-line `git pull` mention to the fetch/merge/HEAD-check form with the
 * sandbox sentence (+566 B), and its `reference/start-mechanics.md` gains the
 * matching invocation-by-invocation rewrite of that same step (+647 B). The
 * two symptoms' full detail and the classifier-refusal measurement's raw
 * per-attempt table went to the `wave-shared` and `wave-start` `evidence/`
 * siblings, which this population excludes by definition.
 *
 * At this row's anchor commit `de2e1c3536cb641e04f5863c7a1952a657240ec5` the
 * population measured **1,257,689 B** over 57 files — 311 B under the previous
 * 1,258,000 B ceiling. This row's edit lands it at **1,261,293 B** over the
 * same 57 files, +3,604 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,262,000 B**. The 707 B of headroom that
 * leaves is a fact about the rounding rule, not a budget.
 *
 * Previously: 1,258,000 B — **RAISED by the row that names the landing
 * message's two exceptions wherever the shipped prose says what lands under
 * `pr`** (issue #980, ADR-0053 dated note 2026-09-25), whose reasoning is
 * kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that names the landing message's two
 * exceptions wherever the shipped prose says what lands under `pr`** (issue
 * #980, ADR-0053 dated note 2026-09-25), in the diff that causes the growth.
 * A merge queue composes its own commit and ignores the message; a rebase
 * landing replays the commits with no single message to shape — and six
 * loaded files said without condition that the PR's title and body land. Each
 * gains one clause where a Coordinator or an operator reads it: wave-close's
 * `close-mechanics.md` `--commit-message` resolution (+213 B) and
 * `phase-4b-partial-arm.md` frozen-at-arming line (+174 B), wave-setup's
 * reference `commitMessage` paragraph (+153 B) and its `SKILL.md` landing
 * concern (+119 B), wave-start's `workflow-driver.md` landing sentence
 * (+130 B), and the host-landing-seam convention (+97 B, that row's own
 * standing-load raise). The vendor quotes behind the two exceptions went to
 * the ADR's dated note, which this population does not count.
 *
 * At that row's anchor commit `9098c29d71545656ea98e24029d1822022179657` the
 * population measured **1,256,803 B** over 57 files — 197 B under the previous
 * 1,257,000 B ceiling. That row's edit landed it at **1,257,689 B** over the
 * same 57 files, +886 B, so the ceiling moved to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,258,000 B**. The 311 B of headroom that
 * left was a fact about the rounding rule, not a budget.
 *
 * Before that: 1,257,000 B — **RAISED by the row that gives a wave that lands
 * each round a documented between-rounds sequence** (issue #976), whose
 * reasoning is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that gives a wave that lands each round
 * a documented between-rounds sequence, naming `close-row` before the next
 * round's compose** (issue #976), in the diff that causes the growth. The
 * Coordinator reads the sequence, and its why, every round a wave lands before
 * dispatching the next: wave-start's `SKILL.md` gains its own `### Between
 * rounds` section (+2,050 B) and the mechanics reference gains the matching
 * `## Between rounds` invocation copy (+1,867 B); wave-close's
 * `phase-5-done-reconcile.md` gains the no-op-at-close note the sequence's
 * idempotence relies on (+696 B). The live occurrence behind it — the
 * six-round wave whose Coordinator ran this by hand every round — went to the
 * `wave-start` `evidence/` sibling, which this population excludes by
 * definition.
 *
 * At this row's anchor commit `5aea0cbe2d7546f02f11664124f6228efbd8fd91` the
 * population measured **1,252,190 B** over 57 files — 810 B under the previous
 * 1,253,000 B ceiling. This row's edit lands it at **1,256,803 B** over the
 * same 57 files, +4,613 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,257,000 B**. The 197 B of headroom that
 * leaves is a fact about the rounding rule, not a budget. The shared standing
 * load is NOT touched: none of the three files is a member of that population
 * (only `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are).
 *
 * Previously: 1,253,000 B — **RAISED by the row that has `route-tuple`'s
 * sidecar step repair a report or verdict sidecar that disagrees with the
 * payload it is handed** (issue #977), whose reasoning is kept below (in ITS
 * voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that has `route-tuple`'s sidecar step
 * repair a report or verdict sidecar that disagrees with the payload it is
 * handed** (issue #977), in the diff that causes the growth. The Coordinator
 * reads the repair where it reads the recovery of a missing sidecar: wave-start's
 * `SKILL.md` step-7 routing item names it (+161 B) and the mechanics
 * reference's step-7a sequence comment states it (+319 B). The live occurrence
 * behind it went to the `wave-start` `evidence/` sibling, which this
 * population excludes by definition.
 *
 * At that row's anchor commit `59e3f14ac7f8852dac6e9d1a3f3489ceacb9aafb` the
 * population measured **1,251,710 B** over 57 files — 290 B under the previous
 * 1,252,000 B ceiling. That row's edit landed it at **1,252,190 B** over the
 * same 57 files, +480 B, so the ceiling moved to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,253,000 B**. The shared standing load was
 * NOT touched: neither file is a member of that population (only
 * `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are).
 *
 * Previously: 1,252,000 B — **RAISED by the row that makes a stamped probe live
 * only while its row runs at the probe's own iteration** (issue #974), whose
 * reasoning is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that makes a stamped probe live only
 * while its row runs at the probe's own iteration, and makes the Reviewer's
 * stamp instruction unambiguous** (issue #974, ADR-0042 Correction
 * 2026-09-25), in the diff that causes the growth. The liveness rule and the
 * stamp sentence both live in copies a Coordinator or a Reviewer acts on as it
 * reads them: wave-close's phase-3 reference restates `removed`/`live-row` for
 * the corrected rule and names `probes` in its result-key paragraph (+342 B);
 * wave-start's mechanics reference rewrites step 7d's rule and its WHY
 * (+283 B), and its `SKILL.md` step-7 items name the sweep before the
 * re-compose and state the corrected rule (+98 B); wave-resume's mechanics
 * reference names `probes` in the result shape it lists (+180 B); the
 * Reviewer's agent definition (+149 B), the reviewer skill's `SKILL.md`
 * (+115 B) and the wave-setup permission scaffold's probe bullet (+77 B) say
 * the path handed to `git worktree add` must itself end in the stamp. The live
 * reads behind it — the Reviewer's copy-of-the-spine removal and the wave's
 * four sweep readings — went to the `wave-start` and `wave-close` `evidence/`
 * siblings, which this population excludes by definition. The driver asset
 * (`tools/wave/driver/wave-start-inflight.js`), `CONTEXT.md` and the ADR are
 * not `.md` files under `.claude/skills` or `.claude/agents`, so none of their
 * bytes are priced here.
 *
 * At this row's anchor commit `32910da481715c6721d61ba5098dc85b20b58551` the
 * population measured **1,250,159 B** over 57 files — 841 B under the previous
 * 1,251,000 B ceiling. This row's edit lands it at **1,251,403 B** over the
 * same 57 files, +1,244 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,252,000 B**. The 597 B of headroom that
 * leaves is a fact about the rounding rule, not a budget. The shared standing
 * load is NOT touched: none of the seven files is a member of that population
 * (only `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are).
 *
 * **UNCHANGED by the row that gives the landed-sibling check's
 * `refs/review/base/<id>` a review-ref namespace of its own (issue #978), which
 * spent 307 B of that headroom** on wave-close's phase-3 reference alone: it
 * names the base ref, the `review-base` namespace and the fourth documented
 * form, with a pointer to the measured reading now in the `evidence/` sibling.
 * At anchor `49747d7489bc4c7d23355d408c8ec6e8cc80d11e` the population measured
 * **1,251,403 B**; the edit lands it at **1,251,710 B** over the same 57 files,
 * and that rounded UP to the next full KB is 1,252,000 B — this constant
 * already. Headroom is 290 B, still a rounding fact and not a budget.
 *
 * Previously: 1,251,000 B — **RAISED by the row that has the Reviewer read a
 * `git merge-tree` result by its exit status instead of by conflict markers on
 * stdout** (issue #975), whose reasoning is kept below (in ITS voice, so "this
 * row" there means that row).
 *
 * Why that number: **RAISED by the row that has the Reviewer read a
 * `git merge-tree` result by its exit status instead of by conflict markers on
 * stdout** (issue #975), in the diff that causes the growth. The two-argument
 * form never prints the markers — they go into the tree it writes — so every
 * copy of the sibling-prediction recipe has to state the criterion that
 * replaces them where a Reviewer reads it: the reviewer skill's checks
 * reference gains the Check 5 subsection with the three exit-status cases and
 * the exit-status wording in both command comments, the outcome table and the
 * coverage-line example (+917 B); its `SKILL.md` gains one bullet (+337 B);
 * the Reviewer's agent definition gains one sentence in its Check 5 (+297 B).
 * Every sentence is an instruction a Reviewer acts on while it reads it. The
 * measurements and live occurrences behind it went to the new
 * `wave-reviewer/evidence/reviewer-checks.md`, which this population excludes
 * by definition, so none of that is priced here. The driver asset the same row
 * edits (`tools/wave/driver/wave-start-inflight.js`) is not a `.md` under
 * `.claude/skills`, so its bytes are not priced here either.
 *
 * At this row's anchor commit `e2666d786c34346caf421374f9be855ac5ec6955` the
 * population measured **1,248,608 B** over 57 files — 392 B under the previous
 * 1,249,000 B ceiling. This row's edit lands it at **1,250,159 B** over the
 * same 57 files, +1,551 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,251,000 B**. The 841 B of headroom that
 * leaves is a fact about the rounding rule, not a budget. The shared standing
 * load is NOT touched: none of the three files is a member of that population
 * (only `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are).
 *
 * Previously: 1,249,000 B — **RAISED by the row that composes the landing
 * verbs' `--commit-message` from the new `landing.commitMessage` config key**
 * (ADR-0053, issue #964), whose reasoning is kept below (in ITS voice, so
 * "this row" there means that row).
 *
 * Why that number: **RAISED by the row that composes the landing verbs'
 * `--commit-message` from the new `landing.commitMessage` config key**
 * (ADR-0053, issue #964), in the diff that causes the growth. Every call site
 * the ADR names has to say so where it is read, because the verbs themselves
 * never read the config: wave-close's close mechanics gain the one
 * `--commit-message` resolution section and the flag on both command-table
 * rows (+844 B), its phase-4 merge and phase-4b arm invocations carry the flag
 * (+271 B, +388 B, the latter with the frozen-at-arming note), and its
 * `SKILL.md` phase-4 line names the rule (+108 B); the host-landing-seam
 * convention's canonical form carries the flag and the one-paragraph rule
 * (+396 B); wave-setup documents the key, its default and the machine-read-
 * history case it exists for in `SKILL.md` (+1,015 B) and its shape and
 * refusal in `setup-mechanics.md` (+963 B); and wave-start's
 * `workflow-driver.md` says what reaches the default branch beside the title
 * rule (+384 B). All of it is an instruction a Coordinator or a setup session
 * acts on at the moment it reads it, so none of it belongs in an `evidence/`
 * sibling. The Worker-brief correction the same row makes lives in the driver
 * asset (`tools/wave/driver/wave-start-inflight.js`), which is not a `.md`
 * under `.claude/skills`, so none of its bytes are priced here.
 *
 * At this row's anchor commit `902d76c5ebf556a2d089f2589634695b140f145a` the
 * population measured **1,243,745 B** over 57 files — 255 B under the
 * previous 1,244,000 B ceiling. This row's edit lands it at **1,248,114 B**
 * over the same 57 files, +4,369 B, so the ceiling moves to that sum rounded UP
 * to the next full KB (1 KB = 1000 B): **1,249,000 B**. The 886 B of headroom
 * that leaves is a fact about the rounding rule, not a budget.
 *
 * **UNCHANGED by the maintainer change that allowlists `git ls-remote origin`
 * for the Reviewer's remote-tip confirmation (issue #979), which spent 494 B of
 * this headroom** on one allow entry in the scaffold's JSON block and one
 * rationale bullet beside the merge-tree entry's, both in
 * `wave-setup/reference/setup-mechanics.md`: the population lands at
 * **1,248,608 B** over the same 57 files, and 1,248,608 B rounded UP to the
 * next full KB is 1,249,000 B — this constant already. A raise here would be a
 * pre-bought one. The shared standing load is NOT touched: the edited file is
 * not a member of that population (only `wave-shared/SKILL.md` plus
 * `wave-shared/reference/*.md` are).
 *
 * Previously: 1,244,000 B — **RAISED by the row that gives the path form's
 * silently-dropped `--pr-title` a worked invocation and an operator-facing
 * note** (issue #955), whose reasoning is kept below (in ITS voice, so "this
 * row" there means that row).
 *
 * Why that number: **RAISED by the row that gives the path form's silently-
 * dropped `--pr-title` a worked invocation and an operator-facing note**
 * (issue #955), in the diff that causes the growth. The shared standing load
 * is NOT a subset of this edit: the one corpus file it touches,
 * `to-issues/reference/filing-mechanics.md`, is a member of the loaded
 * corpus but not of `wave-shared/reference/*.md`, so only this constant
 * ratchets. The added text is a new Gate 10 bullet in the Self-check section
 * plus the worked `dor --id <id> --pr-title '<title>' --config <path>`
 * invocation the shipped-invocation guard now resolves — both are
 * instructions an operator acts on at the moment they read the reference, so
 * neither belongs in an `evidence/` sibling.
 *
 * At this row's anchor commit `500853f1c75eebeea997ac63b3d5fd347bf0afa0` the
 * population measured **1,242,545 B** over 57 files — 455 B under the previous
 * 1,243,000 B ceiling. This row's edit lands it at **1,243,211 B** over the
 * same 57 files, +666 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,244,000 B**. The 789 B of headroom that
 * leaves is a fact about the rounding rule, not a budget.
 *
 * **UNCHANGED by the row that names the conflict-marker floor's dependency on
 * `source-encoding-guard.spec.ts` (issue #956), which spent 534 B of this
 * headroom** on one sentence apiece in
 * `wave-reviewer/reference/reviewer-checks.md`'s Check 2 (+278 B) and
 * `.claude/agents/wave-reviewer.md`'s own Check 2 bullet (+256 B): the
 * population lands at **1,243,745 B** over the same 57 files, and 1,243,745 B
 * rounded UP to the next full KB is 1,244,000 B — this constant already. A
 * raise here would be a pre-bought one. The shared standing load is NOT
 * touched: neither edited file is a member of that population (only
 * `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are), so that class
 * stays at its own unchanged measure. Headroom is 255 B, which is still a
 * rounding fact and still not a budget. The row's other two edits
 * (`source-encoding-guard.spec.ts` and this file) are `tools/wave/src/*.ts`,
 * outside both populations by construction, so none of their bytes are priced
 * here either.
 *
 * Previously: 1,243,000 B — **RAISED by the same row that catalogues three
 * command-shape occurrences the catalogue did not carry, and adds the
 * file-editing tool's byte-verification caveat** (issue #954), whose reasoning
 * is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the same row that catalogues three
 * command-shape occurrences the catalogue did not carry, and adds the
 * file-editing tool's byte-verification caveat** (issue #954), in the diff
 * that causes the growth. The shared standing load is a SUBSET of this
 * population, so the one `wave-shared/reference/convention-13-one-bash-call-per-step.md`
 * edit moves both measures by the same **1,409 B** and both ceilings ratchet
 * in this one diff — the reasoning for the edit itself is on that constant and
 * is not repeated here. The driver asset this row also edits
 * (`tools/wave/driver/wave-start-inflight.js`) is not a `.md` under
 * `.claude/skills`, and the evidence sidecar it edits is excluded by
 * definition, so none of either file's bytes are priced here.
 *
 * At that row's anchor commit `ee53d4ef07b8dea0973b8d3daeabacbeec2feed8` the
 * population measured **1,241,136 B** over 57 files — 864 B under the previous
 * 1,242,000 B ceiling. That row's edit landed it at **1,242,545 B** over the
 * same 57 files, +1,409 B, so the ceiling moved to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,243,000 B**. The 455 B of headroom that
 * left was a fact about the rounding rule, not a budget.
 *
 * Before that: 1,242,000 B — **RAISED by the row that teaches the sweep to
 * collect the Reviewer's stamped probe checkout** (issue #961), whose reasoning
 * is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that teaches the sweep to collect the
 * Reviewer's stamped probe checkout** (issue #961), in the diff that causes the
 * growth. ADR-0042 Amendment 2026-09-23 decisions 13–14 make the probe its own
 * sweep population and move its collection to the Coordinator, and three
 * operator documents have to say so where they are read: wave-close's phase-3
 * reference gains the `probes` section — the key, its two new skip reasons,
 * and what a close still collects (+2,468 B); wave-start's mechanics reference
 * gains step 7d, the exact routing-step command and why it must run before any
 * re-compose (+1,531 B), and its `SKILL.md` the step-7 line that prescribes it
 * (+839 B); the wave-setup permission scaffold's "named, not reaped"
 * justification is replaced by the stamp sweep (+99 B), and wave-close's
 * `SKILL.md` phase-3 line names the population (+56 B). Every sentence is an
 * instruction an operator or a Coordinator acts on, so none of it could go to
 * an `evidence/` sibling instead.
 *
 * At that row's anchor commit `c01a76609a0755570fc0ef44dc2d31b36337d543` the
 * population measured **1,236,143 B** over 57 files — 857 B under the previous
 * 1,237,000 B ceiling. That row's edit landed it at **1,241,136 B** over the
 * same 57 files, +4,993 B, so the ceiling moved to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,242,000 B**. The 864 B of headroom that
 * left was a fact about the rounding rule, not a budget. The shared standing
 * load was NOT raised by it: none of the five files is a member of that
 * population, so that class stayed at 161,176 B against its unchanged
 * 162,000 B ceiling.
 *
 * Before that: 1,237,000 B — the raise by the row that rewrites the Reviewer's
 * sibling prediction (issue #960), whose reasoning is kept below (in ITS voice,
 * so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that rewrites the Reviewer's sibling
 * prediction** (issue #960), in the diff that causes the growth. The prediction
 * used to assume a sibling's branch tip is what the row will collide with; in a
 * wave that lands by squash and re-anchors every round that assumption broke in
 * every direction observed live, and the replacement recipe is Reviewer
 * contract text that has to live in every copy the drift spec pins: a fifth
 * outcome (`landed`) with the one default-branch merge-tree that covers it, an
 * `ls-remote`-first tip confirmation that never reads a fetch's exit code, the
 * round's anchor in place of the wave's, a coverage line that names why each
 * sibling is uncovered instead of asking for a re-run nothing reads, and the
 * probe checkout's stamp (ADR-0042 Amendment 2026-09-23). Four corpus files
 * carry it, the reviewer skill's checks reference first — its Check 5, the
 * runnable detail, gains two subsections and the fifth table row (+2,741 B) —
 * then the reviewer skill's own `SKILL.md` (+1,450 B), the Reviewer's agent
 * definition (+1,443 B) and the wave-start skill's workflow-driver reference
 * (+222 B, the `siblingBranches` source and the round's-anchor wording). None of it is
 * evidence — every sentence is an instruction a Reviewer or an operator acts
 * on — so none of it could go to an `evidence/` sibling instead.
 *
 * At this row's anchor commit `b84405666082116ecbe96644d4e56a0ded8b4846` the
 * population measured **1,230,287 B** over 57 files — 713 B under the previous
 * 1,231,000 B ceiling. This row's edit lands it at **1,236,143 B** over the
 * same 57 files, +5,856 B, so the ceiling moves to that sum rounded UP to the
 * next full KB (1 KB = 1000 B): **1,237,000 B**. The 857 B of headroom that
 * leaves is a fact about the rounding rule, not a budget. The shared standing
 * load is NOT raised: none of the four files is a member of that population
 * (only `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are), so that
 * class stays at 161,176 B against its unchanged 162,000 B ceiling.
 *
 * Previously: 1,231,000 B — the raise by the row that turns the PR-title
 * readiness advisory on for the store-backed path (issue #934), whose reasoning
 * is kept below (in ITS voice, so "this row" there means that row).
 *
 * Why that number: **RAISED by the row that turns the PR-title readiness
 * advisory on for the store-backed path** (issue #934), in the diff that causes
 * the growth. Its one corpus-population edit is a paragraph in
 * `to-issues/SKILL.md`'s self-check step: the tenth readiness gate shipped
 * running on the file path and `deferred` on `dor --id` — the ONE form a
 * decoration pass actually runs — so no operator-facing text could truthfully
 * say the check was available where a person would meet it. Turning it on makes
 * that sentence writable, and the row's last acceptance criterion is to write
 * it: what the line answers by id, what `--pr-title` is for, that the advisory
 * never blocks a row, and what a `deferred` on that line does and does not
 * mean. Four facts, because a reader who has three of them still guesses at the
 * fourth.
 *
 * At this row's anchor commit `a7e72ed517988c110a203a23b7cfae774d3c75df` the
 * population measured **1,229,353 B** over 57 files — 647 B under the previous
 * 1,230,000 B ceiling (the headroom the brief-clause-occurrences row left, and
 * this row's decoration measured again). This row's edit lands it at
 * **1,230,287 B** over the same 57 files, +934 B, so the ceiling moves to that
 * sum rounded UP to the next full KB (1 KB = 1000 B): **1,231,000 B**. The 713 B
 * of headroom that leaves is a fact about the rounding rule, not a budget. The
 * shared standing load is NOT raised, because the edited `SKILL.md` — the
 * `to-issues` one — is not a member of that population (only
 * `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are), so that class
 * stays at 161,176 B against its unchanged 162,000 B ceiling.
 *
 * Previously: 1,230,000 B — the raise by the row that corrects three out-of-glob
 * spots one wave's rows left behind (issue #916), whose reasoning is kept below
 * (in ITS voice, so "this row" there means that row) because the chain back
 * through the `conv12-guard` scanner row and #858 to the ADR-0050 wave is what
 * makes each step auditable.
 *
 * Why that number: **RAISED by the row that corrects three out-of-glob spots
 * this wave's rows left behind** (issue #916), in the diff that causes the
 * growth. Its one corpus-population edit is a paragraph in
 * `wave-setup/reference/throwaway-consumer.md`, replacing a stale claim that
 * the harness declines a dispatched agent's write to the tracked settings file
 * "by design" with the actual, narrower finding ADR-0049's 2026-09-06
 * amendment records — the deny is scoped per TOOL SURFACE, not a blanket
 * decline — which is necessarily longer than the sentence it corrects.
 *
 * At this row's anchor commit `fe1b84579e9374b5d1478b0c327eaa9c46a38f67` the
 * population measured **1,228,613 B** over 57 files — 387 B under the previous
 * 1,229,000 B ceiling. This row's edit lands it at **1,229,096 B** over the
 * same 57 files, so the ceiling moves to that sum rounded UP to the next full
 * KB (1 KB = 1000 B): **1,230,000 B**. The 904 B of headroom that leaves is a
 * fact about the rounding rule, not a budget. The shared standing load is NOT
 * raised: `throwaway-consumer.md` is not a member of that population (only
 * `wave-shared/SKILL.md` plus `wave-shared/reference/*.md` are), so that class
 * stays at 160,919 B against its unchanged 161,000 B ceiling.
 *
 * **UNCHANGED by the brief-clause-occurrences row (issue #917), which spent
 * 257 B of this headroom** on the same two
 * `reference/convention-13-one-bash-call-per-step.md` additions that raise
 * the shared standing load above: the population lands
 * at **1,229,353 B** over the same 57 files, and 1,229,353 B rounded UP to
 * the next full KB is 1,230,000 B — this constant already. A raise here would
 * be a pre-bought one, the thing the diff-twin duty exists to make visible.
 * The row's other three edits — the Convention 8 evidence addition and the
 * two Convention 13 evidence additions — are `evidence/` files, excluded from
 * this population by definition, so none of their bytes are priced here.
 *
 * Previously: 1,229,000 B — **RAISED by the same `conv12-guard` scanner row
 * that raises the constant above** (flotilla#710), in the diff that causes the
 * growth. The shared standing load is a SUBSET of this population, so the one
 * `wave-shared/reference/convention-12-no-command-in-a-shell-variable.md` edit
 * moves both measures by the same **1,029 B** and both ceilings ratchet in this
 * one diff — the reasoning for the edit itself is on that constant and is not
 * repeated here. The replay, the controls and the before/after table went to
 * the `evidence/` sibling, which this population excludes by definition and
 * which therefore costs nothing here.
 *
 * At that row's anchor commit `65108c75fdac708f538709be2828aa3884fec41f` the
 * population measured **1,227,620 B** over 57 files — 380 B under the previous
 * 1,228,000 B ceiling. That row's edit landed it at **1,228,649 B** over the
 * same 57 files, so the ceiling moved to that sum rounded UP to the next full
 * KB (1 KB = 1000 B): **1,229,000 B**. The 351 B of headroom that left was a
 * fact about the rounding rule, not a budget.
 *
 * **NOT raised by issue #910 (2026-09-22), for the same reason as the sibling
 * above:** its one reference-file edit was a net **−36 B**, so this population
 * landed at **1,228,613 B** over the same 57 files, the round-up was still
 * 1,229,000 B, and that constant stayed. That row's bulk — a station table, a
 * probe log, a seven-rung size ladder and two verbatim refusal texts — went to
 * `evidence/`, which this population excludes, so none of it was priced here.
 *
 * Previously: 1,228,000 B — the raise by the row that closed the four residues
 * the Convention 13 Catalog correction left behind (issue #911), whose reasoning
 * is kept below (in ITS voice, so "this row" there means that row) because the
 * chain back through the Catalog correction and the `models`-config row to the
 * ADR-0050 wave is what makes each step auditable.
 *
 * > Why this number: **RAISED by the row that closes the four residues the
 * > Convention 13 Catalog correction left behind** (issue #911), in the diff that
 * > causes the growth. One of those residues is a claim that over-reaches its
 * > evidence — the corrected entry said the SAME 46-B body was refused through all
 * > three destinations, when only two of the three legs carry it — and correcting
 * > it costs more words than making it did: the entry now separates the pair that
 * > shares a body (which is what establishes that the redirect target is not part
 * > of the trigger) from the third leg that does not, and restates the conclusion
 * > as resting on the pair. The other reference-file bytes are a probe command
 * > re-rendered to match the matrix verbatim and one pointer word. Everything
 * > bulky — the three-way refusal-string drift table, the measurement that no
 * > engine matcher depends on that string, the per-leg body detail — went to the
 * > `evidence/` sibling, which this population excludes by definition and which
 * > therefore costs nothing here.
 * >
 * > At anchor commit `c0355f8b255a4487ae21fe820430b17487a59873` (`git rev-parse
 * > HEAD` on this row's branch tip, before this row's own edit) the population
 * > measured **1,226,890 B** over 57 files — 110 B under the 1,227,000 B ceiling
 * > the Catalog correction left. This row's single
 * > `wave-shared/reference/convention-13-one-bash-call-per-step.md` edit adds
 * > **391 B**, landing the population at **1,227,281 B** over the same 57 files, so
 * > the ceiling moves to that sum rounded UP to the next full KB (1 KB = 1000 B):
 * > **1,228,000 B**. The shared standing load is NOT raised: the same 391 B land it
 * > at 159,926 B against its unchanged 160,000 B ceiling, which had 465 B free.
 * >
 * > Previously: 1,227,000 B — the Convention 13 Catalog correction's own raise,
 * > whose reasoning is kept below (in ITS voice, so "this row" there means that
 * > row) because the chain back through the `models`-config row and #858 to the
 * > ADR-0050 wave is what makes each step auditable.
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
 * > Lowering a ceiling is still free; the next ratchet row takes this back down
 * > to its own landed measure. This raise leaves 719 B of headroom, which is a
 * > fact about the rounding rule rather than a budget — the next row that adds
 * > reading cost raises again, in its own diff.
 * >
 * > UNCHANGED by the PR-title advisory row (issue #912), which spent 339 B of
 * > that headroom on `to-issues/SKILL.md`'s one-line title rule: the population
 * > lands at 1,227,620 B over the same 57 files, and 1,227,620 B rounded UP to the
 * > next full KB is 1,228,000 B — this constant already. A raise here would be a
 * > pre-bought one. (The shared standing load is untouched: that row's only
 * > corpus file is not in the class, which stays at 159,926 B.)
 *
 * Lowering a ceiling is still free; the next ratchet row takes this back down
 * to its own landed measure.
 */
const LOADED_CORPUS_CEILING_BYTES = 1_276_000; // RAISED by issue #998 — see the docblock above.
// NOT raised or lowered by issue #817 (wave-setup's second residual-form diet): that row's own
// edit re-measures the population at 1,270,990 B over the same 57 files — 5,010 B of headroom,
// up from row #998's 27 B — and leaves this constant exactly where row #998 set it, for a later
// ratchet row to lower.
// NOT raised or lowered by issue #818 (the wave-shared schema-copies-to-evidence move): the two
// schema literals and their notes moved out of wave-shared/SKILL.md into its evidence/ sibling
// (excluded from this measure by definition) and wave-reviewer/SKILL.md's schema-reach sentence grew
// by 358 B to match the new home, net −7,103 B. That row's own edit re-measures the population at
// 1,263,887 B over the same 57 files — 12,113 B of headroom, up from row #817's 5,010 B — and leaves
// this constant exactly where row #998 set it, for a later ratchet row to lower.
// NOT raised by issue #1004 (annotate's `filesAdd`): its one filing-mechanics.md paragraph adds 456 B,
// re-measured at 1,264,343 B over the same 57 files — 11,657 B of headroom left under row #998's value.

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
 * The agent-definition tree (`.claude/agents/**\/*.md`) — a corrected reading
 * (issue #916). A prior row grew one Reviewer-definition line from 155 B to
 * 399 B, searched this guard and the rest of the shipped-guard family for a
 * byte budget covering that file, and reported finding NONE. That claim does
 * not survive a read of {@link SKILL_DIRS} above: it names `.claude/agents`
 * alongside `.claude/skills`, so every agent-definition file is already a
 * member of {@link LOADED_CORPUS_FILES} and already priced against
 * {@link LOADED_CORPUS_CEILING_BYTES} — the same whole-corpus ceiling every
 * skill body and reference file answers to. The tree IS measured; the prior
 * row's search missed the ceiling it was already inside.
 *
 * What is genuinely true, and the shape the confusion took: the tree has NO
 * measure at {@link SHARED_STANDING_LOAD_CEILING_BYTES}'s finer granularity.
 * That ceiling's own population is `wave-shared/SKILL.md` plus
 * `wave-shared/reference/*.md` only (see {@link sharedStandingLoadFiles}) — a
 * fixed, small, always-loaded set no agent file has ever belonged to, by
 * construction rather than by omission. A line growing inside one agent file
 * moves the whole-corpus sum by that many bytes and nothing else; it has no
 * standing-load-sized ceiling of its own to also move.
 *
 * Left OPEN, deliberately, and not decided here: whether the agent-definition
 * tree wants a measure at that finer granularity — a ceiling sized to itself
 * rather than folded into the 57-file whole-corpus sum. Today it has exactly
 * the one measure above (currently a small fraction of the whole-corpus
 * ceiling — the console line below prints the live share) and none finer;
 * whether that is enough headroom-visibility for a tree a Reviewer reads on
 * every dispatch is a question for a future row, not this one. No ceiling
 * constant's population changes here and no guard's subject widens — this
 * block only prints and pins what is already true of the two populations
 * declared above.
 */
const AGENT_DEFINITION_FILES = LOADED_CORPUS_FILES.filter((f) => f.startsWith('.claude/agents/'));
const AGENT_DEFINITION_BYTES = sumBytes(AGENT_DEFINITION_FILES);
const MIN_AGENT_DEFINITION_FILES = 1; // 1 at landing (wave-reviewer.md)

console.log(
  `[loaded-corpus-guard] agent-definition tree: ${AGENT_DEFINITION_BYTES} B over ` +
    `${AGENT_DEFINITION_FILES.length} file(s) — ` +
    `${((AGENT_DEFINITION_BYTES / LOADED_CORPUS_BYTES) * 100).toFixed(1)}% of the loaded corpus; ` +
    `not a member of the shared standing load (see the doc comment above)`,
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

describe('loaded-corpus-guard — the agent-definition tree has one measure, not two (issue #916)', () => {
  it('finds the agent-definition tree, and it is already inside the loaded corpus population', () => {
    expect(AGENT_DEFINITION_FILES.length).toBeGreaterThanOrEqual(MIN_AGENT_DEFINITION_FILES);
    for (const file of AGENT_DEFINITION_FILES) {
      expect(file.startsWith('.claude/agents/')).toBe(true);
      expect(LOADED_CORPUS_FILES).toContain(file);
    }
    expect(AGENT_DEFINITION_BYTES).toBeGreaterThan(0);
  });

  it('no agent-definition file is a member of the shared standing load — that ceiling does not cover this tree', () => {
    for (const file of AGENT_DEFINITION_FILES) {
      expect(SHARED_STANDING_LOAD_FILES).not.toContain(file);
    }
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
