/**
 * skill-clause-drift.spec.ts — the Convention 16 operator-register clause is
 * present and BYTE-IDENTICAL in every shipped SKILL.md body, deep-equalled
 * against the one source constant below.
 *
 * ## The class this guards
 *
 * The operator register is a speech rule: every line an agent prints for the
 * person at the session is plain-language, directly addressed, and free of
 * internal references. A rule like that cannot be enforced by inspecting an
 * answer — a guard sees files, not voice. What IS structurally checkable, and
 * what this file checks, is that every skill still CARRIES the rule, in one
 * wording, with nothing drifted.
 *
 * Why a copy per skill rather than one shared file every skill loads: the front
 * half (`triage`, `to-prd`, `to-issues`) never loads `wave-shared` at all, and
 * coupling it to that skill's schemas and routing mechanics to reach one
 * paragraph is the rejected option. So the short clause is planted thirteen
 * times and the long form sits under `wave-shared/reference/`, reached by a
 * sibling-path read against the reading skill's own directory.
 *
 * Thirteen hand-maintained copies is exactly the shape that rots one copy
 * silently, which is why this guard is a peer of `skill-schema-drift.spec.ts`
 * — same idea (a copy pinned to one source), applied to a paragraph of prose
 * instead of a schema literal. `toEqual` on strings is a byte comparison: a
 * changed dash, a re-wrapped line, a dropped sentence in ONE body all fail
 * here, naming the file.
 *
 * ## Three further predicates ride the same corpus
 *
 * 2. **The long form is complete** — five clauses, the installed/source form
 *    switch, and the ten-term operator mini-glossary. A pointer into an empty
 *    file is worse than no pointer.
 * 3. **The number-allocation register names 16** and pairs the number with its
 *    own one-liner. (`skill-reference-guard.spec.ts` owns the counter itself;
 *    what is asserted here is the CONTENT — that the register's description is
 *    about the operator register and not a stranded predecessor's.)
 * 4. **The corrections the clause rollout carries**: no skill addresses the
 *    human as "the Coordinator" (the Coordinator is the session, never the
 *    person), and wave-plan's report prescription no longer instructs printing
 *    finding ids or decision-record numbers into operator-directed output.
 *
 * Every predicate has a negative control beside it (wave-shared Convention 11):
 * a seeded divergence must be seen to go red, or a green run proves only that
 * the check cannot fail.
 *
 * Pure test — zero production change.
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is tools/wave/src —
 * three levels above the repo root. (vite `root` is tools/wave, but __dirname is
 * the spec file's own dir; the ../../../ count is correct only for __dirname.)
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '../../..');
const SKILLS_DIR = join(REPO_ROOT, '.claude/skills');

/**
 * The long form the short clause points at. Its own directory placement is
 * load-bearing: `wave-shared/reference/` is the directory the loader reads
 * whole, and it is reachable from any skill by a sibling-path read.
 */
const LONG_FORM_REL = '.claude/skills/wave-shared/reference/convention-16-operator-register.md';

/** The loader whose number-allocation register allocates convention numbers. */
const WAVE_SHARED_REL = '.claude/skills/wave-shared/SKILL.md';

/** wave-plan, whose step-5 report prescription is corrected by this rollout. */
const WAVE_PLAN_REL = '.claude/skills/wave-plan/SKILL.md';

/**
 * The population floor. Thirteen skills ship today; a guard that silently
 * stopped finding bodies would be green for the wrong reason, and "13" is also
 * the number the convention itself states, so it is pinned exactly rather than
 * as a floor. A fourteenth skill is a deliberate edit here AND a planted clause
 * in the same diff — which is the point.
 */
const SHIPPED_SKILL_COUNT = 13;

/**
 * THE SOURCE CONSTANT. Every SKILL.md body carries this string verbatim.
 *
 * Four things it must carry, and each is asserted separately below so a
 * failure says which half was lost rather than just "strings differ": the
 * register rule, the direct address, the installed/source form switch, and the
 * sibling-path read pointer at the long form.
 *
 * Edit protocol: change it HERE, then re-plant all thirteen copies in the same
 * diff. A copy edited alone fails this spec by design.
 */
const OPERATOR_REGISTER_CLAUSE = `## Operator register (Convention 16)

**Everything you print for the person at this session is operator-directed output, and it holds one register.** Plain language, direct address ("du"/"you"), self-explaining. Translate every internal reference — a decision-record number, a convention number, a finding id, a wave slug, a retro path — into the one-line consequence it carries for them, instead of naming it. Introduce a domain term with a half-sentence the first time it appears in a session, then use it freely. End the run with an operator block: what happened → where it lives → what you do next. Operator-directed text follows the operator's own language; the artifacts you write — issues, PRs, decision records, spine entries — stay English. **Installed form is strict** — no internal token reaches the operator. **Source form**, flotilla's own repo, may append one compact reference pointer after the plain text. Full clause text, the operator mini-glossary, and the mistakes it closes: [wave-shared/reference/convention-16-operator-register.md](../wave-shared/reference/convention-16-operator-register.md), read as a file beside this skill's own directory — no skill invocation, no namespace to guess.
`;

/** Every shipped SKILL.md, repo-relative, sorted — the guarded population. */
function listSkillBodies(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `.claude/skills/${entry.name}/SKILL.md`)
    .filter((rel) => {
      try {
        readFileSync(join(REPO_ROOT, rel), 'utf-8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

const SKILL_BODIES = listSkillBodies();
const SOURCES = new Map(
  SKILL_BODIES.map((rel) => [rel, readFileSync(join(REPO_ROOT, rel), 'utf-8')] as const),
);

/**
 * The clause AS IT SITS in one body, sliced from its heading to the end of the
 * paragraph that follows it (a blank line, or end of file). Returns `null` when
 * the heading is absent at all — which is a different failure from a drifted
 * copy and gets its own message.
 *
 * Slicing rather than substring-matching is what makes this a DRIFT guard
 * instead of a presence check: a body that carries the heading and a rewritten
 * paragraph passes `includes(HEADING)` and fails this.
 */
function extractPlantedClause(md: string): string | null {
  const heading = OPERATOR_REGISTER_CLAUSE.split('\n')[0];
  const at = md.indexOf(heading);
  if (at < 0) return null;
  const rest = md.slice(at);
  // The clause is a heading + one blank line + one paragraph. Its end is the
  // next blank line after that paragraph, or the end of the document.
  const bodyStart = rest.indexOf('\n\n');
  if (bodyStart < 0) return rest;
  const afterBlank = bodyStart + 2;
  const end = rest.indexOf('\n\n', afterBlank);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('skill-clause-drift — the Convention 16 clause is byte-identical in all 13 SKILL.md bodies', () => {
  it('finds the whole population (a guard that matches nothing is green for the wrong reason)', () => {
    expect(SKILL_BODIES).toHaveLength(SHIPPED_SKILL_COUNT);
    // Both halves of the pipeline are in scope: the front half never loads
    // wave-shared, which is precisely why the clause is planted rather than
    // loaded, and a population that quietly covered only the back half would
    // leave the audience the convention was written for unguarded.
    expect(SKILL_BODIES).toContain('.claude/skills/triage/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/to-prd/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/to-issues/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/report/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/grill-with-docs/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/wave-shared/SKILL.md');
    expect(SKILL_BODIES).toContain('.claude/skills/wave-start/SKILL.md');
  });

  it.each(listSkillBodies())('%s carries the clause byte-identically', (rel) => {
    const md = SOURCES.get(rel) as string;
    const planted = extractPlantedClause(md);
    expect(
      planted,
      `${rel} carries no operator-register clause at all. Every SKILL.md body plants the ` +
        `byte-identical clause from OPERATOR_REGISTER_CLAUSE in this spec — a skill without it ` +
        `ships with no rule for how it talks to the person running it.`,
    ).not.toBeNull();
    expect(
      planted,
      `${rel}'s operator-register clause has DRIFTED from the source constant. Thirteen ` +
        `hand-maintained copies rot one at a time; re-plant this body from ` +
        `OPERATOR_REGISTER_CLAUSE rather than editing the copy, and if the WORDING is what ` +
        `should change, change the constant and re-plant all thirteen in the same diff.`,
    ).toEqual(OPERATOR_REGISTER_CLAUSE);
  });

  it('the clause carries all four required halves (a failure names which one was lost)', () => {
    // The register rule itself — translate, introduce, close with an operator block.
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/operator-directed output/);
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/Translate every internal reference/);
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(
      /what happened → where it lives → what you do next/,
    );
    // Direct address.
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/direct address \("du"\/"you"\)/);
    // The form switch — strict installed, one pointer tolerated in source form.
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/Installed form is strict/);
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/Source form/);
    // The sibling-path read pointer: `../<sibling>/…` against the reading
    // skill's own directory — no namespace, no Skill-tool invocation.
    expect(OPERATOR_REGISTER_CLAUSE).toContain(
      '(../wave-shared/reference/convention-16-operator-register.md)',
    );
    expect(OPERATOR_REGISTER_CLAUSE).toMatch(/no skill invocation/);
  });

  it('negative control — a seeded divergence in ONE body goes red (Convention 11)', () => {
    // Four shapes, each a real way a copy rots: a reworded sentence, a dropped
    // half, a swapped dash, and an outright deletion. All four must be caught,
    // and the presence-only check that would MISS the first three is asserted
    // alongside so the difference between the two is visible here rather than
    // taken on faith.
    const clean = SOURCES.get('.claude/skills/triage/SKILL.md') as string;
    expect(extractPlantedClause(clean)).toEqual(OPERATOR_REGISTER_CLAUSE);
    const heading = OPERATOR_REGISTER_CLAUSE.split('\n')[0];

    const reworded = clean.replace(
      'Plain language, direct address',
      'Plain language, informal address',
    );
    expect(reworded).not.toEqual(clean); // the replace actually matched
    expect(extractPlantedClause(reworded)).not.toEqual(OPERATOR_REGISTER_CLAUSE);
    expect(reworded.includes(heading)).toBe(true); // a presence check would pass

    const halfDropped = clean.replace('**Installed form is strict** — no internal token reaches the operator. ', '');
    expect(halfDropped).not.toEqual(clean);
    expect(extractPlantedClause(halfDropped)).not.toEqual(OPERATOR_REGISTER_CLAUSE);
    expect(halfDropped.includes(heading)).toBe(true); // a presence check would pass

    const dashSwapped = clean.replace(
      'what happened → where it lives → what you do next',
      'what happened -> where it lives -> what you do next',
    );
    expect(dashSwapped).not.toEqual(clean);
    expect(extractPlantedClause(dashSwapped)).not.toEqual(OPERATOR_REGISTER_CLAUSE);
    expect(dashSwapped.includes(heading)).toBe(true); // a presence check would pass

    const deleted = clean.replace(OPERATOR_REGISTER_CLAUSE, '');
    expect(deleted).not.toEqual(clean);
    expect(extractPlantedClause(deleted)).toBeNull();
  });

  it('negative control — extractPlantedClause slices the clause, it does not just find the heading', () => {
    // Pins the extractor's own contract: a body whose clause paragraph has been
    // replaced wholesale still carries the heading, and the extractor must
    // return the REPLACEMENT (which then fails the deep-equal) rather than the
    // source constant it was hoping for.
    const forged = `# x\n\n${OPERATOR_REGISTER_CLAUSE.split('\n')[0]}\n\nSomething else entirely.\n\n## Tail\n`;
    const sliced = extractPlantedClause(forged);
    expect(sliced).not.toBeNull();
    expect(sliced).toContain('Something else entirely.');
    expect(sliced).not.toEqual(OPERATOR_REGISTER_CLAUSE);
    expect(extractPlantedClause('# nothing here\n')).toBeNull();
  });
});

// ─── the long form the clause points at ──────────────────────────────────────

describe('skill-clause-drift — the long form carries the five clauses, the form switch, and the glossary', () => {
  const longForm = readFileSync(join(REPO_ROOT, LONG_FORM_REL), 'utf-8');

  it('opens with the convention heading the loader keys on', () => {
    // The reference directory is read whole and every file carries its own
    // `## Convention N — …` heading; a file that loses it stops resolving a
    // sibling's `Convention 16` citation.
    expect(longForm.startsWith('## Convention 16 — ')).toBe(true);
  });

  /** The five clauses, by the concept each one owns. */
  const FIVE_CLAUSES: ReadonlyArray<readonly [string, RegExp]> = [
    ['translation', /\*\*1\. Translation\.\*\*/],
    ['first-use introduction', /\*\*2\. First-use introduction\.\*\*/],
    ['direct address', /\*\*3\. Direct address\.\*\*/],
    ['the operator block', /\*\*4\. The operator block\.\*\*/],
    ['language', /\*\*5\. Language\.\*\*/],
  ];

  it.each(FIVE_CLAUSES)('states clause: %s', (_label, re) => {
    expect(re.test(longForm)).toBe(true);
  });

  it('states the installed/source form switch, both directions', () => {
    expect(longForm).toMatch(/Installed form/);
    expect(longForm).toMatch(/Source form/);
    // The switch is only a switch if BOTH sides are stated: strict for every
    // consumer, one trailing pointer tolerated in flotilla's own repo. A file
    // that names only the strict half reads as "strict everywhere", which is
    // the rejected option.
    expect(longForm).toMatch(/[Ss]trict/);
    expect(longForm).toMatch(/compact reference pointer/);
  });

  /** The ten terms the mini-glossary owes a half-sentence introduction. */
  const GLOSSARY_TERMS = [
    'Wave',
    'Spine',
    'Worker',
    'Reviewer',
    'Operator',
    'HELD',
    'arm',
    'claim',
    'Disclosure',
    'needs-attention',
  ] as const;

  it.each(GLOSSARY_TERMS)('the mini-glossary introduces %s', (term) => {
    // Each term sits in its own table row as `| **<term>** | <half-sentence> |`,
    // so the assertion is about the ENTRY existing, not about the word merely
    // appearing somewhere in the prose above.
    const row = new RegExp(`^\\|\\s*\\*\\*${term}\\*\\*\\s*\\|\\s*\\S`, 'm');
    expect(
      row.test(longForm),
      `the operator mini-glossary has no entry for "${term}". The glossary is what clause 2's ` +
        `half-sentence introductions are read out of — a term with no entry gets introduced ` +
        `differently by every skill that meets it.`,
    ).toBe(true);
  });

  it('negative control — the glossary predicate fails on a term that is merely mentioned', () => {
    // "Coordinator" appears in the long form's prose (clause 3 says not to use
    // it as an address) but is deliberately NOT a glossary entry: it names the
    // session, never a person the operator has to meet. If the predicate were
    // a bare `includes(term)` it would pass here, which is the whole point.
    expect(longForm).toContain('Coordinator');
    expect(/^\|\s*\*\*Coordinator\*\*\s*\|/m.test(longForm)).toBe(false);
  });
});

// ─── the number-allocation register's CONTENT ────────────────────────────────

describe('skill-clause-drift — the number register names 16 and describes THIS convention', () => {
  const register = SOURCES.get(WAVE_SHARED_REL) as string;

  it('the counter reads 16', () => {
    expect(register).toContain('the highest allocated Convention number is **16**');
  });

  it('the one-liner beneath it is about the operator register, not a stranded predecessor', () => {
    // The register's own content rule: the number and its one-liner are
    // REPLACED together. Bumping the counter alone strands the previous
    // convention's description under a heading that no longer matches it —
    // which is the defect this pairing assertion exists to catch, and which a
    // counter-only check structurally cannot see.
    const oneLiner = /^\*\*16 — .+\*\* \(\[convention-16-operator-register\.md\]\(reference\/convention-16-operator-register\.md\)\):/m;
    expect(oneLiner.test(register)).toBe(true);
    const line = (oneLiner.exec(register) as RegExpExecArray)[0];
    expect(line.toLowerCase()).toContain('operator register');
    // …and the superseded description is gone: the register is a counter plus
    // ONE description, never an accumulating index.
    expect(/^\*\*15 — /m.test(register)).toBe(false);
  });

  it('negative control — a stale one-liner under a bumped counter is caught', () => {
    const regressed = register.replace(
      /^\*\*16 — .+$/m,
      '**15 — the Coordinator-direct boundary** ([convention-15-coordinator-direct-boundary.md](reference/convention-15-coordinator-direct-boundary.md)): no PR that closes a tracker issue lands without a Reviewer verdict.',
    );
    expect(regressed).not.toEqual(register); // the replace actually matched
    expect(regressed).toContain('the highest allocated Convention number is **16**'); // counter still bumped
    const oneLiner = /^\*\*16 — .+\*\* \(\[convention-16-operator-register\.md\]\(reference\/convention-16-operator-register\.md\)\):/m;
    expect(oneLiner.test(regressed)).toBe(false); // …but the pairing is broken
    expect(/^\*\*15 — /m.test(regressed)).toBe(true);
  });
});

// ─── the corrections the clause rollout carries ──────────────────────────────

/**
 * "The Coordinator" used as an ADDRESS — the human being asked to decide.
 *
 * Deliberately a curated stop-list of decision verbs rather than a ban on the
 * word: `Coordinator` is a canonical glossary term for the SESSION and appears
 * correctly all over the corpus ("the Coordinator implements a foreground row
 * itself", "the Coordinator must fill anchorSha into every brief"). What is
 * wrong is naming the session where only a person can act — asking it,
 * telling it, or having it decide/pick/choose.
 *
 * VOCABULARY TRADEOFF, stated rather than hidden: a curated list is by
 * construction incomplete, and an address phrased with an out-of-list verb
 * clears this predicate. It is kept narrow because the corpus legitimately
 * carries "the Coordinator confirms", "the Coordinator routes", "the
 * Coordinator writes" and "the Coordinator can clean up" — all session acts —
 * and widening to those verbs would fire on correct prose. Widening the list
 * therefore takes a negative control in the SAME diff proving the added verb
 * does not fire on a shipped sentence.
 */
const COORDINATOR_AS_ADDRESS: ReadonlyArray<RegExp> = [
  /\b(?:ask|asks|asking|tell|tells|telling)\s+the\s+coordinator\b/i,
  /\bthe\s+coordinator\s+(?:decides|picks|chooses|wants|knows|can\s+act)\b/i,
  /\bthe\s+coordinator\s+must\s+(?:decide|see|sequence|pick|choose)\b/i,
  // Notification verbs — the shape a STOP reaches for. A session does not get
  // pinged; only a person does, so "ping the Coordinator" is an address even
  // though no decision verb follows it. The `\b` before `ping` is load-bearing:
  // without it this fires on "Skipping the Coordinator's own observations",
  // which is correct session usage and ships in this very corpus (negative
  // control below).
  /\b(?:ping|pings|pinging|notify|notifies|notifying|alert|alerts|alerting)\s+the\s+coordinator\b/i,
  // The attributive noun form, which no verb pattern above can reach: a
  // `--question "<the Coordinator decision needed>"` placeholder is text that
  // lands in a human-read tracker field, so it addresses the reader of that
  // field — the Operator.
  /\bthe\s+coordinator(?:'s)?\s+decision\b/i,
];

function coordinatorAddresses(md: string): string[] {
  return md
    .split('\n')
    .flatMap((line, i) =>
      COORDINATOR_AS_ADDRESS.some((re) => re.test(line)) ? [`${i + 1}: ${line.trim().slice(0, 120)}`] : [],
    );
}

/**
 * The internal-reference shapes clause 1 forbids in operator-directed text:
 * a decision-record number, a retro finding id, or a path into the evidence
 * tree. Same shapes Convention 14 governs the PLACEMENT of inside skill prose
 * — here the question is different, and narrower: whether a skill instructs
 * the agent to print one INTO the report a human reads.
 */
const INTERNAL_REFERENCE = /\bADR-\d{4}\b|\bdocs\/(?:adr|retros)\/[A-Za-z0-9._/-]+|\b[A-Z]{1,4}\d*-F\d+\b/g;

/**
 * The step-5 region of wave-plan — the section that prescribes, line by line,
 * what goes into the report the Operator reads. Sliced by its own heading and
 * the next `## ` heading; a restructure that removes either anchor must FAIL
 * this rather than silently scan nothing.
 */
function planReportPrescription(md: string): string {
  const start = md.indexOf('### 5. Present the report; pick ids');
  if (start < 0) {
    throw new Error(
      "wave-plan's step-5 report-prescription heading is missing — this guard scopes itself by " +
        'that anchor and must not degrade to scanning an empty region.',
    );
  }
  const end = md.indexOf('\n## ', start);
  if (end < 0) {
    throw new Error("no closing '## ' heading after wave-plan's step-5 section");
  }
  return md.slice(start, end);
}

describe('skill-clause-drift — the rollout corrections (the human is not "the Coordinator")', () => {
  it.each(listSkillBodies())('%s does not address the human as the Coordinator', (rel) => {
    const offenders = coordinatorAddresses(SOURCES.get(rel) as string);
    expect(
      offenders,
      `${rel} names the Coordinator where only a person can act. The Coordinator is the SESSION, ` +
        `never the person — the human directing it is the Operator. Address them directly ` +
        `("du"/"you") in output, and write "the Operator" when naming the role in prose:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it("wave-plan's report prescription prints no finding id and no decision-record number", () => {
    const region = planReportPrescription(SOURCES.get(WAVE_PLAN_REL) as string);
    expect(region.length).toBeGreaterThan(200); // the region is real, not an empty slice
    const tokens = [...region.matchAll(INTERNAL_REFERENCE)].map((m) => m[0]);
    expect(
      tokens,
      `wave-plan's step-5 section prescribes what goes INTO the report a human reads, so an ` +
        `internal reference there is an instruction to print it. State the one-line consequence ` +
        `instead — the tokens belong in the surrounding skill prose, not in the report.`,
    ).toEqual([]);
  });

  it('negative control — both predicates fire on the exact wordings this rollout removed', () => {
    // (a) the Coordinator-as-address shapes, verbatim as they stood.
    expect(
      coordinatorAddresses('surface the cross-wave overlap and **ask the Coordinator, default abort**.'),
    ).toHaveLength(1);
    expect(
      coordinatorAddresses('Present the eligible set; the coordinator decides.'),
    ).toHaveLength(1);
    expect(
      coordinatorAddresses('This is the launch-gate concern — the coordinator must decide.'),
    ).toHaveLength(1);
    expect(
      coordinatorAddresses('mark them clearly so the coordinator knows they need a human to act'),
    ).toHaveLength(1);
    // The two shapes the wave-start rollout removed, which the original three
    // patterns could not reach: a notification verb with no decision verb
    // behind it, and the attributive noun inside a flag-question placeholder.
    expect(
      coordinatorAddresses('flag `needs-attention` on the tracker, then ping the Coordinator:'),
    ).toHaveLength(1);
    expect(
      coordinatorAddresses('  --question "<the Coordinator decision needed>" \\'),
    ).toHaveLength(1);
    // …and the session usages the corpus legitimately carries do NOT fire.
    expect(coordinatorAddresses('the Coordinator implements it directly in a foreground row')).toEqual([]);
    expect(coordinatorAddresses('the Coordinator must fill anchorSha into every dispatch brief')).toEqual([]);
    expect(coordinatorAddresses('disclose it so the Coordinator can clean up after landing')).toEqual([]);
    expect(coordinatorAddresses('if a Reviewer flags the diff base and the Coordinator confirms it')).toEqual([]);
    // The near-miss that motivated the `\b` in the notification pattern: this
    // line ships in wave-start's Common Mistakes and contains the literal
    // substring "ping the Coordinator" inside "Skipping". A pattern without the
    // word boundary turns a correct session usage into a false blocker.
    expect(
      coordinatorAddresses("Skipping the Coordinator's own observations, or mis-attributing `--source`."),
    ).toEqual([]);
    // The attributive-noun pattern is scoped to `decision` on purpose — the
    // corpus legitimately describes what the session decided.
    expect(coordinatorAddresses('the Coordinator decided the dispatch order from the spine')).toEqual([]);

    // (b) the report prescription, with the two tokens this rollout removed put
    // back exactly where they stood. Same extractor, same region slice.
    const plan = SOURCES.get(WAVE_PLAN_REL) as string;
    const regressed = plan
      .replace(
        '- Public-API-change pairing advisory: any two-or-more',
        '- Public-API-change pairing advisory (KW-F4): any two-or-more',
      )
      .replace(
        'zero Worker-side, because the session implements them itself',
        "zero Worker-side — ADR-0033's coordinator-direct boundary",
      );
    expect(regressed).not.toEqual(plan); // both replacements actually matched
    const tokens = [...planReportPrescription(regressed).matchAll(INTERNAL_REFERENCE)].map((m) => m[0]);
    expect(tokens).toEqual(['KW-F4', 'ADR-0033']);
  });

  it('negative control — the region slicer fails loud instead of scanning nothing', () => {
    expect(() => planReportPrescription('# wave-plan\n\nno step 5 here\n')).toThrow(
      /report-prescription heading is missing/,
    );
    expect(() =>
      planReportPrescription('### 5. Present the report; pick ids\n\nnothing closes this\n'),
    ).toThrow(/no closing/);
  });
});
