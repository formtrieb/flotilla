/**
 * skill-schema-drift.spec.ts — pins the inlined agent-boundary schema literals
 * in .claude/skills/wave-shared/SKILL.md to the exported engine consts, AND
 * guards the boundary-suitability of the separate, anyOf-free copy inlined in
 * .claude/skills/wave-start/reference/workflow-driver.md.
 *
 * The Workflow driver pastes a `const …_SCHEMA = {…}` literal into
 * `agent({ schema })` — a skill cannot `import` a TS const. Those literals are
 * hand-maintained COPIES of WORKER_REPORT_JSON_SCHEMA / REVIEWER_VERDICT_JSON_SCHEMA;
 * nothing else asserts the copies still equal the source. This spec extracts each
 * inlined literal by its stable fence comment, parses it, and deep-equals it to
 * the imported const. A drift (or a missing anchor) fails loud.
 *
 * A second, narrower concern lives alongside the drift pins (W5-F1, live: the
 * first Workflow dispatch of 2026-07-19-hardening-w5 failed instantly — "input_schema
 * does not support oneOf, allOf, or anyOf at the top level" — because the canonical
 * wave-shared `WORKER_REPORT_SCHEMA` literal, which carries a top-level `anyOf`, was
 * pasted verbatim into `agent({ schema })`). The driver's own copy in
 * workflow-driver.md deliberately omits that `anyOf`; this spec asserts that copy
 * stays free of any top-level `anyOf`/`oneOf`/`allOf`, with a negative control that
 * proves the assertion actually fires when a combinator is (re-)introduced — see
 * docs/retros/2026-07-19-hardening-w5.md (W5-F1) for the live incident.
 *
 * Pure test — zero production change. Ur precedent: issue #78 (wave-start/SKILL.md).
 *
 * Path note: this spec lives at tools/wave/src/, so __dirname is tools/wave/src —
 * three levels above the repo root. (vite `root` is tools/wave, but __dirname is
 * the spec file's own dir; the ../../../ count is correct only for __dirname.)
 * The harness LSP may emit stale "cannot find module" diagnostics for the relative
 * schema imports — only `npx vitest run` / `npx tsc --noEmit` are authoritative.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKER_REPORT_JSON_SCHEMA } from './worker-report-schema';
import { REVIEWER_VERDICT_JSON_SCHEMA } from './reviewer-verdict-schema';

const SKILL_MD = join(
  __dirname,
  '../../../.claude/skills/wave-shared/SKILL.md',
);

const WORKFLOW_DRIVER_MD = join(
  __dirname,
  '../../../.claude/skills/wave-start/reference/workflow-driver.md',
);

const START_MECHANICS_MD = join(
  __dirname,
  '../../../.claude/skills/wave-start/reference/start-mechanics.md',
);

const DRIVER_WORKER_REPORT_ANCHOR =
  '// ── inlined from wave-shared (copy of WORKER_REPORT_SCHEMA) ──';

/** Top-level JSON-Schema combinator keys the agent tool's `input_schema`
 * validator rejects outright when present at the schema root (nested is
 * fine — only the top level is agent-tool-checked). */
const TOP_LEVEL_COMBINATOR_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

/**
 * Extract one inlined object literal from SKILL.md by its fence anchor and the
 * `const <openerVar> = {` opener, walking braces to the matching close. Returns
 * the parsed structure (the literal is trusted in-repo test input — eval via
 * Function is appropriate here, matching the Ur #78 approach). Throws a clear
 * message if the anchor or opener is missing.
 */
function extractInlinedSchema(md: string, anchor: string, openerVar: string): unknown {
  const anchorIdx = md.indexOf(anchor);
  if (anchorIdx < 0) {
    throw new Error(
      `extraction anchor missing in wave-shared/SKILL.md: ${anchor}`,
    );
  }
  const opener = `const ${openerVar} = {`;
  const openerIdx = md.indexOf(opener, anchorIdx);
  if (openerIdx < 0) {
    throw new Error(
      `opener "${opener}" not found after anchor in wave-shared/SKILL.md`,
    );
  }
  const braceStart = md.indexOf('{', openerIdx);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < md.length; i++) {
    const ch = md[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error(
      `unbalanced braces extracting ${openerVar} from wave-shared/SKILL.md`,
    );
  }
  const literal = md.slice(braceStart, end + 1);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(`return (${literal})`)() as unknown;
}

/** Strip `as const` readonly typing to a plain JSON-shaped value for deep-equal. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Boundary-suitability guard (W5-F1): throws if `schema` carries a top-level
 * `anyOf`/`oneOf`/`allOf` key — the exact shape the agent tool's `input_schema`
 * validation rejects at the `agent({ schema })` boundary ("input_schema does
 * not support oneOf, allOf, or anyOf at the top level"). A schema with no
 * top-level combinator is a silent no-op; naming which key(s) offend keeps a
 * failure legible instead of a bare "objects differ".
 */
function assertBoundarySafe(schema: unknown, label: string): void {
  if (typeof schema !== 'object' || schema === null) {
    throw new Error(`${label}: not an object`);
  }
  const offending = TOP_LEVEL_COMBINATOR_KEYS.filter(
    (key) => key in (schema as Record<string, unknown>),
  );
  if (offending.length > 0) {
    throw new Error(
      `${label} carries a top-level ${offending.join('/')} — the agent tool's ` +
        'input_schema validator rejects this at the agent({ schema }) boundary ' +
        '(live: W5-F1, docs/retros/2026-07-19-hardening-w5.md). A schema pasted ' +
        'into agent({ schema }) must not use anyOf/oneOf/allOf at the top level.',
    );
  }
}

describe('skill-schema-drift — wave-shared inlined literals pin the engine consts', () => {
  const md = readFileSync(SKILL_MD, 'utf-8');

  it('WORKER_REPORT_SCHEMA inlined literal deep-equals WORKER_REPORT_JSON_SCHEMA', () => {
    const inlined = extractInlinedSchema(
      md,
      '// --- inlined from worker-report-schema.ts (WORKER_REPORT_JSON_SCHEMA) ---',
      'WORKER_REPORT_SCHEMA',
    );
    expect(inlined).toEqual(plain(WORKER_REPORT_JSON_SCHEMA));
  });

  it('the report literal carries the prUrl conditional (W3-F2 / FOR-24)', () => {
    // The deep-equal above already covers this; this pins the *intent* by name
    // so dropping the conditional from the skill copy fails with a message that
    // says what broke, not just "objects differ".
    const inlined = extractInlinedSchema(
      md,
      '// --- inlined from worker-report-schema.ts (WORKER_REPORT_JSON_SCHEMA) ---',
      'WORKER_REPORT_SCHEMA',
    ) as {
      required: string[];
      anyOf?: Array<{
        properties?: { outcome?: { enum?: string[] } };
        required?: string[];
      }>;
    };
    // Never blanket-required: an honest `blocked` report has no PR to report.
    expect(inlined.required).not.toContain('prUrl');
    const finishing = (inlined.anyOf ?? []).find((b) =>
      b.required?.includes('prUrl'),
    );
    expect(finishing?.properties?.outcome?.enum).toEqual([
      'done',
      'done-with-concerns',
    ]);
  });

  it('REVIEWER_VERDICT_SCHEMA inlined literal deep-equals REVIEWER_VERDICT_JSON_SCHEMA (post-briefProfile-removal)', () => {
    const inlined = extractInlinedSchema(
      md,
      '// --- inlined from reviewer-verdict-schema.ts (REVIEWER_VERDICT_JSON_SCHEMA) ---',
      'REVIEWER_VERDICT_SCHEMA',
    );
    expect(inlined).toEqual(plain(REVIEWER_VERDICT_JSON_SCHEMA));
  });

  it('the verdict literal carries no briefProfile (uniform Reviewer, ADR-0016)', () => {
    const inlined = extractInlinedSchema(
      md,
      '// --- inlined from reviewer-verdict-schema.ts (REVIEWER_VERDICT_JSON_SCHEMA) ---',
      'REVIEWER_VERDICT_SCHEMA',
    ) as { required: string[]; properties: Record<string, unknown> };
    expect(inlined.required).not.toContain('briefProfile');
    expect(inlined.properties).not.toHaveProperty('briefProfile');
  });

  it('fails loud when an extraction anchor is missing', () => {
    expect(() =>
      extractInlinedSchema(
        '# no anchors here\n',
        '// --- inlined from worker-report-schema.ts (WORKER_REPORT_JSON_SCHEMA) ---',
        'WORKER_REPORT_SCHEMA',
      ),
    ).toThrow(/extraction anchor missing/);
  });
});

describe('skill-schema-drift — the driver-facing schema literal is boundary-safe (W5-F1)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  function extractDriverWorkerReportSchema(md: string): Record<string, unknown> {
    return extractInlinedSchema(
      md,
      DRIVER_WORKER_REPORT_ANCHOR,
      'WORKER_REPORT_SCHEMA',
    ) as Record<string, unknown>;
  }

  it('the driver-facing WORKER_REPORT_SCHEMA literal (workflow-driver.md) carries no top-level anyOf/oneOf/allOf', () => {
    const driverSchema = extractDriverWorkerReportSchema(driverMd);
    expect(() =>
      assertBoundarySafe(driverSchema, 'workflow-driver.md WORKER_REPORT_SCHEMA'),
    ).not.toThrow();
    // Belt-and-braces: the guard above is the load-bearing assertion, but a
    // direct key check pins the exact shape without going through the helper.
    for (const key of TOP_LEVEL_COMBINATOR_KEYS) {
      expect(driverSchema).not.toHaveProperty(key);
    }
  });

  it('negative control — assertBoundarySafe fails when the canonical (anyOf-bearing) literal is pasted in its place', () => {
    // The exact live regression (W5-F1): the wave-shared canonical literal —
    // which legitimately carries a top-level anyOf, per the drift-pin above —
    // pasted verbatim into the driver slot. If this stopped throwing, that
    // regression would again ship silently past this spec.
    expect(() =>
      assertBoundarySafe(
        plain(WORKER_REPORT_JSON_SCHEMA),
        'canonical WORKER_REPORT_JSON_SCHEMA pasted as the driver copy',
      ),
    ).toThrow(/top-level anyOf/);
  });

  it.each(TOP_LEVEL_COMBINATOR_KEYS)(
    'negative control — assertBoundarySafe fails when a bare top-level %s is introduced onto the driver literal',
    (key) => {
      const regressed = { ...extractDriverWorkerReportSchema(driverMd), [key]: [] };
      expect(() =>
        assertBoundarySafe(regressed, `regressed driver schema (${key})`),
      ).toThrow(new RegExp(key));
    },
  );

  it('positive control — assertBoundarySafe does not throw on a combinator-free object', () => {
    expect(() =>
      assertBoundarySafe({ type: 'object', properties: {} }, 'clean schema'),
    ).not.toThrow();
  });
});

describe('skill-schema-drift — workflow-driver.md WAVE_CLI defaults to the published package (FOR-122, DA-F1)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * Extract the `const WAVE_CLI = '...'` value verbatim. Throws (rather than
   * returning undefined) if the constant is missing, so a renamed/reshaped
   * constant fails loud instead of silently passing every assertion below.
   */
  function extractWaveCliConst(md: string): string {
    const m = md.match(/^const WAVE_CLI = '([^']*)'$/m);
    if (!m) {
      throw new Error("const WAVE_CLI = '...' not found in workflow-driver.md");
    }
    return m[1];
  }

  it("WAVE_CLI's default resolves the published npm package, not the vendored tools/wave path", () => {
    const value = extractWaveCliConst(driverMd);
    expect(value).toContain('npx @formtrieb/flotilla-engine');
    expect(value).not.toContain('tools/wave/node_modules');
    expect(value).not.toContain('tools/wave/src/cli.ts');
  });

  it('the vendored tools/wave/node_modules form remains documented as the fallback', () => {
    // Belt-and-braces: the assertion above pins the live DEFAULT; this pins
    // that the fallback text wasn't deleted outright along with it (AC 1).
    expect(driverMd).toMatch(/tools\/wave\/node_modules\/\.bin\/tsx/);
    expect(driverMd).toMatch(/documented\s+\*{0,2}fallback\*{0,2}/i);
  });

  it('negative control — extractWaveCliConst would catch a reverted (vendored-default) constant', () => {
    // The exact live regression (DA-F1): WAVE_CLI reverted to the vendored
    // local-binary form, which resolves to nothing for a plugin consumer with
    // no in-repo tools/wave checkout. If this stopped catching the revert,
    // that regression would again ship silently past this spec.
    const regressed = driverMd.replace(
      "const WAVE_CLI = 'NODE_USE_ENV_PROXY=1 npx @formtrieb/flotilla-engine'",
      "const WAVE_CLI = 'NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts'",
    );
    expect(regressed).not.toEqual(driverMd); // the replace actually matched something
    const value = extractWaveCliConst(regressed);
    expect(value).toContain('tools/wave/node_modules');
  });
});

describe('skill-schema-drift — workflow-driver.md path constants are shell-quoted (FOR-122, DA-F2)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * True iff the bare, UNQUOTED interpolation form (`cd ${NAME}`, `--dir
   * ${name}`) is present anywhere in the source. A quoted form (`cd
   * "${NAME}"`) does NOT contain this exact substring, because the `"`
   * character sits between the literal prefix and the `${` — so this is a
   * precise discriminator between the two forms, not a fuzzy heuristic.
   */
  function hasUnquotedInterpolation(md: string, needle: string): boolean {
    return md.includes(needle);
  }

  it('the Scribe brief cd interpolates REPO_ROOT shell-quoted', () => {
    expect(hasUnquotedInterpolation(driverMd, 'cd ${REPO_ROOT}')).toBe(false);
    expect(driverMd).toContain('cd "${REPO_ROOT}"');
  });

  it('the Scribe brief --dir interpolates the sidecar dir shell-quoted', () => {
    expect(hasUnquotedInterpolation(driverMd, '--dir ${dir}')).toBe(false);
    expect(driverMd).toContain('--dir "${dir}"');
  });

  it('negative control — hasUnquotedInterpolation actually detects the unquoted form (would have failed pre-fix, DA-F2)', () => {
    // The exact live regression (DA-F2): this repo's own checkout path
    // contains a space and a typographic en-dash; `cd ${REPO_ROOT}` (no
    // quotes) breaks on it silently — the Scribe stage logs loud and passes
    // its payload through rather than failing the wave, so the sidecar stops
    // being written durably at exactly the moment ADR-0024 exists to
    // guarantee it is. If this detector stopped firing on the unquoted form,
    // that regression could reappear and this spec would not catch it.
    const regressed = driverMd
      .replace('cd "${REPO_ROOT}"', 'cd ${REPO_ROOT}')
      .replace('--dir "${dir}"', '--dir ${dir}');
    expect(regressed).not.toEqual(driverMd); // both replacements actually matched
    expect(hasUnquotedInterpolation(regressed, 'cd ${REPO_ROOT}')).toBe(true);
    expect(hasUnquotedInterpolation(regressed, '--dir ${dir}')).toBe(true);
  });
});

describe('skill-schema-drift — workflow-driver.md compose-time REQUIRED_ROW_FIELDS assertion (FOR-139)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * Finds `openCh` at or after `fromIdx` and walks bracket depth to the
   * matching `closeCh`, returning the balanced substring (inclusive of both
   * delimiters). Shares the brace-walking idea `extractInlinedSchema` above
   * uses for object literals, generalized to any single delimiter pair so it
   * can also pull a `[...]` array literal or a `{...}` function body.
   */
  function extractBalanced(
    md: string,
    fromIdx: number,
    openCh: string,
    closeCh: string,
  ): string {
    const openIdx = md.indexOf(openCh, fromIdx);
    if (openIdx < 0) {
      throw new Error(`no "${openCh}" found at/after index ${fromIdx} in workflow-driver.md`);
    }
    let depth = 0;
    for (let i = openIdx; i < md.length; i++) {
      const ch = md[i];
      if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (depth === 0) return md.slice(openIdx, i + 1);
      }
    }
    throw new Error(`unbalanced ${openCh}/${closeCh} starting at index ${openIdx} in workflow-driver.md`);
  }

  /**
   * Loads the CURRENT compose-time assertion (REQUIRED_ROW_FIELDS,
   * isMissingField, assertRequiredRowFields) straight out of the shipped
   * workflow-driver.md source, the same eval-the-literal approach the
   * schema-drift tests above use for the `*_SCHEMA` literals — the driver has
   * no importable module (it is pasted into a Workflow `script` sandbox with
   * no filesystem/import). A rename or reshape of any of the three
   * declarations fails this extraction loudly rather than silently testing a
   * stale copy hard-coded into this spec.
   */
  function loadAssertionModule(md: string): {
    REQUIRED_ROW_FIELDS: string[];
    isMissingField: (value: unknown) => boolean;
    assertRequiredRowFields: (issue: Record<string, unknown>) => void;
  } {
    const constNeedle = 'const REQUIRED_ROW_FIELDS = ';
    const constIdx = md.indexOf(constNeedle);
    if (constIdx < 0) {
      throw new Error('const REQUIRED_ROW_FIELDS = [...] not found in workflow-driver.md');
    }
    const constSrc = extractBalanced(md, constIdx + constNeedle.length, '[', ']');

    const missingNeedle = 'function isMissingField(value) ';
    const missingIdx = md.indexOf(missingNeedle, constIdx);
    if (missingIdx < 0) {
      throw new Error('function isMissingField(value) {...} not found in workflow-driver.md');
    }
    const missingSrc = extractBalanced(md, missingIdx + missingNeedle.length, '{', '}');

    const assertNeedle = 'function assertRequiredRowFields(issue) ';
    const assertIdx = md.indexOf(assertNeedle, missingIdx);
    if (assertIdx < 0) {
      throw new Error('function assertRequiredRowFields(issue) {...} not found in workflow-driver.md');
    }
    const assertSrc = extractBalanced(md, assertIdx + assertNeedle.length, '{', '}');

    const src = `
      const REQUIRED_ROW_FIELDS = ${constSrc};
      function isMissingField(value) ${missingSrc}
      function assertRequiredRowFields(issue) ${assertSrc}
      return { REQUIRED_ROW_FIELDS, isMissingField, assertRequiredRowFields };
    `;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return Function(src)();
  }

  /** A row with every REQUIRED_ROW_FIELDS entry present and valid. */
  const VALID_ROW: Record<string, unknown> = {
    id: '42',
    slug: 'demo-slug',
    branch: 'wave/42-demo-slug',
    risk: 'mechanical',
    model: 'sonnet',
    anchorSha: 'deadbeefcafe',
    coordinatorBranch: 'feat/demo',
    issueSpec: 'Do the thing.',
    prTitle: 'fix: do the thing',
    closePhrase: 'Closes #42',
    siblingBranches: '(none — last in-flight issue)',
  };

  it('AC1/AC3 — REQUIRED_ROW_FIELDS names more than just anchorSha, in one place', () => {
    const { REQUIRED_ROW_FIELDS } = loadAssertionModule(driverMd);
    expect(REQUIRED_ROW_FIELDS).toEqual(expect.arrayContaining(['anchorSha', 'branch']));
    // The original W2-F1 fix covered exactly one field; this must cover more.
    expect(REQUIRED_ROW_FIELDS.length).toBeGreaterThan(1);
    // Every field this test's own VALID_ROW carries is exactly what the
    // extracted list requires — keeps the fixture and the source in lockstep.
    expect(new Set(REQUIRED_ROW_FIELDS)).toEqual(new Set(Object.keys(VALID_ROW)));
  });

  it('a fully-populated row passes without throwing', () => {
    const { assertRequiredRowFields } = loadAssertionModule(driverMd);
    expect(() => assertRequiredRowFields({ ...VALID_ROW })).not.toThrow();
  });

  it.each(Object.keys(VALID_ROW))(
    'AC1 — a row with an ABSENT %s throws, naming both the row id and the field',
    (field) => {
      const { assertRequiredRowFields } = loadAssertionModule(driverMd);
      const row = { ...VALID_ROW };
      delete row[field];
      expect(() => assertRequiredRowFields(row)).toThrow(new RegExp(field));
      if (field !== 'id') {
        // the row's own id must still be named in the thrown message
        expect(() => assertRequiredRowFields(row)).toThrow(/42/);
      }
    },
  );

  it.each(Object.keys(VALID_ROW))(
    'AC2 — a row with the literal string "undefined" for %s throws (the template-renders-a-missing-property shape)',
    (field) => {
      const { assertRequiredRowFields } = loadAssertionModule(driverMd);
      const row = { ...VALID_ROW, [field]: 'undefined' };
      expect(() => assertRequiredRowFields(row)).toThrow(new RegExp(field));
    },
  );

  it.each(Object.keys(VALID_ROW))(
    'AC2 — a row with an empty/whitespace-only %s throws',
    (field) => {
      const { assertRequiredRowFields } = loadAssertionModule(driverMd);
      const row = { ...VALID_ROW, [field]: '   ' };
      expect(() => assertRequiredRowFields(row)).toThrow(new RegExp(field));
    },
  );

  it('AC4 — negative control: the OLD single-field assertion (anchorSha only) does NOT catch a missing branch/slug/etc, while the new one does', () => {
    // A literal snapshot of the pre-fix assertion this generalizes past
    // (FOR-139's predecessor, itself W2-F1's fix): it validated ONLY
    // anchorSha. This is the exact evidence the acceptance criteria asks
    // for — the new test table above must be seen to FAIL against this
    // narrower assertion, not merely pass against assertRequiredRowFields.
    function assertAnchorShaOnly(issue: Record<string, unknown>): void {
      const a = issue.anchorSha;
      if (a === undefined || a === null || a === 'undefined' || String(a).trim() === '') {
        throw new Error(
          `wave-start: row ${issue.id} has no valid anchorSha (got ${JSON.stringify(a)}) — wire anchorSha into ISSUES before dispatch`,
        );
      }
    }

    const rowMissingBranch = { ...VALID_ROW };
    delete rowMissingBranch.branch;
    // The single-field assertion is silent about the missing branch (this is
    // the assertion the test table above would have run against, pre-fix —
    // it must NOT throw here, or this negative control proves nothing).
    expect(() => assertAnchorShaOnly(rowMissingBranch)).not.toThrow();

    const rowMissingSlug = { ...VALID_ROW };
    delete rowMissingSlug.slug;
    expect(() => assertAnchorShaOnly(rowMissingSlug)).not.toThrow();

    const rowMissingPrTitle = { ...VALID_ROW };
    delete rowMissingPrTitle.prTitle;
    expect(() => assertAnchorShaOnly(rowMissingPrTitle)).not.toThrow();

    // ...while the new, generalized assertion catches each and names the field.
    const { assertRequiredRowFields } = loadAssertionModule(driverMd);
    expect(() => assertRequiredRowFields(rowMissingBranch)).toThrow(/branch/);
    expect(() => assertRequiredRowFields(rowMissingSlug)).toThrow(/slug/);
    expect(() => assertRequiredRowFields(rowMissingPrTitle)).toThrow(/prTitle/);
  });

  it('negative control — loadAssertionModule fails loud if the assertion is renamed/removed', () => {
    expect(() => loadAssertionModule('# no assertion here\n')).toThrow(
      /REQUIRED_ROW_FIELDS.*not found/,
    );
  });
});

describe('skill-schema-drift — issue.branch matches the Coordinator spine set-branch formula (FOR-139, AC5)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');
  const mechanicsMd = readFileSync(START_MECHANICS_MD, 'utf-8');

  /**
   * Counts CODE occurrences of the raw `wave/${issue.id}-${issue.slug}`
   * reconstruction, deliberately excluding `//`-comment lines (which may
   * legitimately mention the shape in prose, e.g. this fix's own rationale
   * comments) — only a live call site re-building the branch name instead of
   * reading `issue.branch` should count.
   */
  function countRawBranchReconstructions(md: string): number {
    const needle = 'wave/${issue.id}-${issue.slug}';
    return md
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => line.includes(needle)).length;
  }

  it('the driver derives issue.branch exactly once, as wave/${issue.id}-${issue.slug}', () => {
    expect(driverMd).toContain('issue.branch = `wave/${issue.id}-${issue.slug}`');
  });

  it('every brief call site reads issue.branch — none re-interpolates wave/${issue.id}-${issue.slug} on its own', () => {
    // Only the single derivation assignment (real code, not a comment) may
    // still construct the branch name from its parts; the Worker's
    // checkout/push/host-pr-create and the Reviewer's stated target must all
    // read the one derived value instead, so the four call sites the FOR-139
    // recurrence hit (plus the reviewer's diff-range mention) cannot diverge
    // from each other.
    expect(countRawBranchReconstructions(driverMd)).toBe(1);
  });

  it("the Coordinator's spine set-branch call (start-mechanics.md step 5) uses the identical wave/<id>-<slug> shape", () => {
    expect(mechanicsMd).toContain('"wave/$ID-$ROW_SLUG"');
  });

  it('negative control — countRawBranchReconstructions would catch a re-introduced inline branch build', () => {
    // If a future edit re-introduced `wave/${issue.id}-${issue.slug}` at a
    // call site instead of reading `issue.branch`, this count would rise
    // above 1 and the assertion above would fail — proving the count is not
    // vacuously 1 regardless of content.
    const regressed = driverMd.replace(
      '3. \\`git checkout -b ${issue.branch}\\`',
      '3. \\`git checkout -b wave/${issue.id}-${issue.slug}\\`',
    );
    expect(regressed).not.toEqual(driverMd); // the replace actually matched
    expect(countRawBranchReconstructions(regressed)).toBe(2);
  });
});
