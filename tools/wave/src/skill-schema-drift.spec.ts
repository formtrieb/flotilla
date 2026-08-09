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
import { WORKTREE_COUNT_ADVISORY_THRESHOLD } from './worktree-cleanup';
import { HUMAN_GATED_WORKER } from './wave-md-rw';

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

const WAVE_START_SKILL_MD = join(
  __dirname,
  '../../../.claude/skills/wave-start/SKILL.md',
);

// The wave-create half of the human lane (issue #323). A row is CLASSIFIED
// human-gated at create time and HELD at start time, so the token is written
// out on both sides of the wave and both sides need pinning — a pin that
// covered only wave-start would leave the classification prose free to drift.
const WAVE_CREATE_SKILL_MD = join(
  __dirname,
  '../../../.claude/skills/wave-create/SKILL.md',
);

const CREATE_MECHANICS_MD = join(
  __dirname,
  '../../../.claude/skills/wave-create/reference/create-mechanics.md',
);

// The Reviewer half of the sibling-prediction contract (issue #419, plus the
// fourth-copy pin added for issue #431). Check 5's coverage denominator is
// stated in FOUR places — the operator-facing skill, its runnable checks
// reference, the reviewerBrief the driver composes, and the Reviewer's own
// agent definition (its system prompt) — so all four are read here and pinned
// together. The agent-definition copy is pinned in its REDUCED form only: it
// structurally cannot carry a per-row interpolated value (no `${issue.*}`
// exists in a static system prompt), so its pin asserts the outcome
// vocabulary, the coverage-line duty, and an explicit deferral to the
// dispatched reviewerBrief for the mechanics — never the full brief-side
// contract.
const WAVE_REVIEWER_SKILL_MD = join(
  __dirname,
  '../../../.claude/skills/wave-reviewer/SKILL.md',
);

const REVIEWER_CHECKS_MD = join(
  __dirname,
  '../../../.claude/skills/wave-reviewer/reference/reviewer-checks.md',
);

const WAVE_REVIEWER_AGENT_MD = join(
  __dirname,
  '../../../.claude/agents/wave-reviewer.md',
);

const DRIVER_WORKER_REPORT_ANCHOR =
  '// ── inlined from wave-shared (copy of WORKER_REPORT_SCHEMA) ──';

const DRIVER_REVIEWER_VERDICT_ANCHOR =
  '// ── inlined from wave-shared (copy of REVIEWER_VERDICT_SCHEMA — uniform Reviewer: NO briefProfile) ──';

const WAVE_SHARED_REVIEWER_VERDICT_ANCHOR =
  '// --- inlined from reviewer-verdict-schema.ts (REVIEWER_VERDICT_JSON_SCHEMA) ---';

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

// ─── the Documented-Form Comparison field (ADR-0030) ────────────────────────
//
// ADR-0030 adds a flat optional `documentedFormComparison` to the Reviewer
// verdict. Unlike the WORKER_REPORT copies, the REVIEWER_VERDICT copies carry
// NO deliberate shape difference between wave-shared and the driver — the
// engine const has no top-level combinator, so both copies must equal it
// exactly. Before this block the driver's REVIEWER_VERDICT_SCHEMA copy was
// pinned by nothing at all: it could drift from the engine const silently, and
// a driver whose schema omits the field rejects every verdict that carries it
// at the agent({ schema }) boundary (additionalProperties: false).

type ReviewerVerdictSchemaShape = {
  required: string[];
  properties: Record<string, unknown> & {
    documentedFormComparison?: {
      type?: string;
      additionalProperties?: boolean;
      required?: string[];
      properties?: {
        trigger?: { enum?: string[] };
        sources?: { minItems?: number };
        divergences?: { items?: { required?: string[] } };
      };
    };
  };
};

describe('skill-schema-drift — documentedFormComparison rides BOTH verdict copies (ADR-0030)', () => {
  const sharedMd = readFileSync(SKILL_MD, 'utf-8');
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  function sharedVerdictSchema(md: string): ReviewerVerdictSchemaShape {
    return extractInlinedSchema(
      md,
      WAVE_SHARED_REVIEWER_VERDICT_ANCHOR,
      'REVIEWER_VERDICT_SCHEMA',
    ) as ReviewerVerdictSchemaShape;
  }

  function driverVerdictSchema(md: string): ReviewerVerdictSchemaShape {
    return extractInlinedSchema(
      md,
      DRIVER_REVIEWER_VERDICT_ANCHOR,
      'REVIEWER_VERDICT_SCHEMA',
    ) as ReviewerVerdictSchemaShape;
  }

  it("the DRIVER's REVIEWER_VERDICT_SCHEMA copy deep-equals the engine const (previously pinned by nothing)", () => {
    expect(driverVerdictSchema(driverMd)).toEqual(
      plain(REVIEWER_VERDICT_JSON_SCHEMA),
    );
  });

  it('the driver verdict copy is boundary-safe — no top-level anyOf/oneOf/allOf', () => {
    // The whole reason `documentedFormComparison` is flat-optional rather than
    // conditionally required: a schema-root conditional means a top-level
    // combinator, which this boundary rejects outright (W5-F1).
    expect(() =>
      assertBoundarySafe(
        driverVerdictSchema(driverMd),
        'workflow-driver.md REVIEWER_VERDICT_SCHEMA',
      ),
    ).not.toThrow();
  });

  /** Both verdict-schema copies, loaded lazily so a failure names its file. */
  const BOTH_COPIES: Array<[string, () => ReviewerVerdictSchemaShape]> = [
    ['wave-shared/SKILL.md', () => sharedVerdictSchema(sharedMd)],
    ['workflow-driver.md', () => driverVerdictSchema(driverMd)],
  ];

  /** The same two copies as raw source + extraction anchor, for the regressions. */
  const BOTH_SOURCES: Array<[string, string, string]> = [
    ['wave-shared/SKILL.md', sharedMd, WAVE_SHARED_REVIEWER_VERDICT_ANCHOR],
    ['workflow-driver.md', driverMd, DRIVER_REVIEWER_VERDICT_ANCHOR],
  ];

  it.each(BOTH_COPIES)(
    'the %s copy carries documentedFormComparison as a FLAT OPTIONAL field',
    (_label, load) => {
      const schema = load();
      // Optional: absent from required[] — a row with an executable core path
      // fires no trigger and pays nothing.
      expect(schema.required).not.toContain('documentedFormComparison');
      // ...but present in properties: with additionalProperties:false, a copy
      // that omits it would REJECT every verdict that reports a comparison.
      expect(schema.properties).toHaveProperty('documentedFormComparison');
    },
  );

  it.each(BOTH_COPIES)(
    'the %s copy pins the block shape: three triggers, sources minItems 1, classified divergences',
    (_label, load) => {
      const field = load().properties.documentedFormComparison;
      expect(field?.type).toBe('object');
      expect(field?.additionalProperties).toBe(false);
      expect(field?.required).toEqual(['trigger', 'sources', 'divergences']);
      expect(field?.properties?.trigger?.enum).toEqual([
        'issue-declared',
        'worker-declared',
        'deferred-core-path',
      ]);
      // minItems:1 is the STRUCTURAL half of ADR-0030's no-restatement rule:
      // a comparison must cite at least one document the Reviewer read itself.
      // Drop it and the duty becomes dischargeable by restating the Worker.
      expect(field?.properties?.sources?.minItems).toBe(1);
      expect(field?.properties?.divergences?.items?.required).toEqual([
        'description',
        'deliberate',
      ]);
    },
  );

  it.each(BOTH_SOURCES)(
    'negative control — a %s copy that DROPS the field is caught (it would reject every comparison-bearing verdict)',
    (_label, md, anchor) => {
      const regressed = md.replace(/\n\s*documentedFormComparison: \{/, '\n    __dropped: {');
      expect(regressed).not.toEqual(md); // the replace actually matched
      const schema = extractInlinedSchema(
        regressed,
        anchor,
        'REVIEWER_VERDICT_SCHEMA',
      ) as ReviewerVerdictSchemaShape;
      expect(schema.properties).not.toHaveProperty('documentedFormComparison');
      // ...and the deep-equal pin above is what fails on it.
      expect(schema).not.toEqual(plain(REVIEWER_VERDICT_JSON_SCHEMA));
    },
  );

  it.each(BOTH_SOURCES)(
    "negative control — a %s copy that relaxes sources to minItems 0 is caught (the no-restatement rule's structural half)",
    (_label, md, anchor) => {
      const regressed = md.replace(
        /sources: \{ type: 'array', minItems: 1,/,
        "sources: { type: 'array', minItems: 0,",
      );
      expect(regressed).not.toEqual(md); // the replace actually matched
      const schema = extractInlinedSchema(
        regressed,
        anchor,
        'REVIEWER_VERDICT_SCHEMA',
      ) as ReviewerVerdictSchemaShape;
      expect(
        schema.properties.documentedFormComparison?.properties?.sources?.minItems,
      ).toBe(0);
      expect(schema).not.toEqual(plain(REVIEWER_VERDICT_JSON_SCHEMA));
    },
  );

  it('negative control — a verdict copy that makes the field REQUIRED is caught (it must stay optional)', () => {
    // Making it required would break the common case outright: every row with
    // an executable core path fires no trigger, so its verdict has no field to
    // supply, and a required field would reject the verdict at the boundary.
    const regressed = driverMd.replace(
      "required: ['verdict','branchReviewed','riskClass','workerReportDigest','acVerification','reviewerFocusItems'],",
      "required: ['verdict','branchReviewed','riskClass','workerReportDigest','acVerification','reviewerFocusItems','documentedFormComparison'],",
    );
    expect(regressed).not.toEqual(driverMd); // the replace actually matched
    const schema = extractInlinedSchema(
      regressed,
      DRIVER_REVIEWER_VERDICT_ANCHOR,
      'REVIEWER_VERDICT_SCHEMA',
    ) as ReviewerVerdictSchemaShape;
    expect(schema.required).toContain('documentedFormComparison');
    expect(schema).not.toEqual(plain(REVIEWER_VERDICT_JSON_SCHEMA));
  });
});

describe('skill-schema-drift — the Documented-Form duty is briefed, not only schema-shaped (ADR-0030)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  it("the Worker brief carries the declare-and-self-compare clause (defense-in-depth)", () => {
    expect(driverMd).toContain('UNEXECUTABLE CORE PATH');
    expect(driverMd).toMatch(/read it in this dispatch, do not recall it from memory/i);
  });

  it('the Reviewer brief names the field and the no-restatement constraint', () => {
    expect(driverMd).toContain('documentedFormComparison');
    expect(driverMd).toMatch(/only source is the Worker's report is\s+invalid/);
  });

  it('the driver states the flat-optional rationale (the schema cannot carry the condition)', () => {
    // The condition lives in contract prose because a schema-root conditional
    // is exactly the shape the agent boundary rejects (W5-F1) — if that
    // rationale is deleted, the next author "fixes" it back into an anyOf.
    expect(driverMd).toMatch(/FLAT \+ OPTIONAL/);
    expect(driverMd).toContain('W5-F1');
  });
});

/**
 * WAVE_CLI is filled from the configured `engine.cli` binding (ADR-0032).
 *
 * This block used to pin the opposite invariant — that WAVE_CLI *defaulted* to
 * the published npm package, with the vendored form documented as its fallback
 * (FOR-122, DA-F1). ADR-0032 superseded that: a second authority stating a
 * default form is precisely the doc-drift the ADR records (by 2026-07-30 this
 * driver and `setup-mechanics.md` disagreed about which form even *was* the
 * default), so the driver now states no form at all and reads the consumer's
 * binding instead. The DA-F1 evidence is not discarded — it survives as the
 * driver's rationale for why the binding is a per-repo SETUP-TIME decision, and
 * is pinned as such below.
 */
describe('skill-schema-drift — workflow-driver.md WAVE_CLI is filled from the configured binding (ADR-0032)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * Extract the `const WAVE_CLI = '...'` value verbatim. Throws (rather than
   * returning undefined) if the constant is missing, so a renamed/reshaped
   * constant fails loud instead of silently passing every assertion below.
   * Its EXISTENCE in this shape is itself the Convention-12 invariant: a
   * compose-time JS string literal, never a shell variable or runtime lookup.
   */
  function extractWaveCliConst(md: string): string {
    const m = md.match(/^const WAVE_CLI = '([^']*)'$/m);
    if (!m) {
      throw new Error("const WAVE_CLI = '...' not found in workflow-driver.md");
    }
    return m[1];
  }

  it('WAVE_CLI names NO invocation form — it points at the configured binding', () => {
    const value = extractWaveCliConst(driverMd);
    // No form, in either direction. Hardcoding one here is what re-creates the
    // two-authorities-disagree drift ADR-0032 exists to end.
    expect(value).not.toContain('npx @formtrieb/flotilla-engine');
    expect(value).not.toContain('node_modules/.bin/flotilla-engine');
    expect(value).not.toContain('tools/wave/node_modules');
    expect(value).not.toContain('tools/wave/src/cli.ts');
    // What it DOES carry: the placeholder naming where the value comes from,
    // plus the proxy prefix (Convention 1) that survives the ADR untouched.
    expect(value).toContain('engine.cli');
    expect(value).toContain('NODE_USE_ENV_PROXY=1');
  });

  it('the driver states the binding rule the constant is filled from', () => {
    expect(driverMd).toContain('wave.config.json');
    expect(driverMd).toMatch(/filled from .{0,40}configured .{0,20}engine\.cli/i);
    // An absent binding is a STOP, not a cue to pick a form — the half of the
    // rule a reader is most likely to improvise past.
    expect(driverMd).toMatch(/ABSENT `engine\.cli` is a STOP/);
  });

  it('the DA-F1 evidence survives as the rationale for a per-repo binding', () => {
    // The finding that killed a vendored default for plugin consumers is why
    // the binding is a setup-time decision at all. Deleting it would leave the
    // rule with no observed failure behind it, which is how a rule gets
    // "simplified" away by the next author.
    expect(driverMd).toContain('DA-F1');
    expect(driverMd).toMatch(/vendored `tools\/wave` and no local `tsx` binary/);
  });

  it('negative control — extractWaveCliConst would catch a HARDCODED form, either one', () => {
    const placeholder = extractWaveCliConst(driverMd);

    for (const hardcoded of [
      'NODE_USE_ENV_PROXY=1 npx @formtrieb/flotilla-engine',
      'NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts',
      'NODE_USE_ENV_PROXY=1 ./node_modules/.bin/flotilla-engine',
    ]) {
      const regressed = driverMd.replace(
        `const WAVE_CLI = '${placeholder}'`,
        `const WAVE_CLI = '${hardcoded}'`,
      );
      expect(regressed).not.toEqual(driverMd); // the replace actually matched something
      const value = extractWaveCliConst(regressed);
      expect(value).toBe(hardcoded);
      expect(value).not.toContain('engine.cli'); // …which the assertion above rejects
    }
  });

  it('negative control — a WAVE_CLI moved into the shell is not a JS constant any more', () => {
    // The Convention-12 regression this extractor doubles as a guard against:
    // the "helpful" refactor that turns the compose-time literal into a runtime
    // lookup. It stops being `const WAVE_CLI = '...'`, so the extractor throws.
    const regressed = driverMd.replace(
      /^const WAVE_CLI = '[^']*'$/m,
      'const WAVE_CLI = `$(node -e "…engine.cli…")`',
    );
    expect(regressed).not.toEqual(driverMd);
    expect(() => extractWaveCliConst(regressed)).toThrow(/not found in workflow-driver\.md/);
  });
});

describe('skill-schema-drift — workflow-driver.md path constants are shell-quoted (FOR-122, DA-F2)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * True iff the bare, UNQUOTED interpolation form (`--dir ${name}`) is
   * present anywhere in the source. A quoted form (`--dir "${name}"`) does
   * NOT contain this exact substring, because the `"` character sits between
   * the literal prefix and the `${` — so this is a precise discriminator
   * between the two forms, not a fuzzy heuristic. It works wherever the
   * literal prefix is fixed; where it is not, scan instead (see
   * `unquotedRepoRootPaths` below).
   */
  function hasUnquotedInterpolation(md: string, needle: string): boolean {
    return md.includes(needle);
  }

  /**
   * Every `${REPO_ROOT}/…` PATH interpolation in the driver that is NOT
   * immediately preceded by a `"`. Returns a small context window around each
   * offender so a failure names the site instead of just asserting `false`.
   *
   * Why a scan rather than a fixed-prefix substring: after the Scribe's `cd`
   * was retired (#251) the literal prefix differs per call site — the engine
   * call's is a JS interpolation (`${verb} `), the payload declaration's is a
   * markdown backtick, the heredoc fallback's is `> `. A `hasUnquotedInterpolation`
   * needle can only express one of them, and the iteration-1 defect this
   * replaces was the backtick one. The invariant itself is uniform, so assert
   * it uniformly: REPO_ROOT reaching a shell as part of a path is always
   * quoted. (The one REPO_ROOT occurrence that is legitimately bare — step 1's
   * `pwd`-comparison literal — has no `/` after it and is correctly not
   * matched: it is a value to compare against, never a shell word.)
   */
  function unquotedRepoRootPaths(md: string): string[] {
    const needle = '${REPO_ROOT}/';
    const out: string[] = [];
    for (let i = md.indexOf(needle); i !== -1; i = md.indexOf(needle, i + 1)) {
      if (md[i - 1] !== '"') out.push(md.slice(Math.max(0, i - 40), i + 40));
    }
    return out;
  }

  it('the Scribe brief interpolates REPO_ROOT shell-quoted at every path position', () => {
    /*
     * RE-PINNED (#251). This assertion used to read
     *   expect(driverMd).toContain('cd "${REPO_ROOT}"')
     * because the Scribe brief's step 1 was a `cd` to the repo root. That step
     * is RETIRED: a dispatched agent's cwd is reset to its dispatch root before
     * every Bash call, so the `cd` never reached the step-3 engine call, which
     * resolved only because the Scribe's dispatch root already WAS the repo
     * root (workflow-driver.md §The Scribe's cwd). Step 1 is now a bare `pwd`
     * compared against the compose-time literal.
     *
     * The old pin kept PASSING across that retirement — the driver still spells
     * `cd "${REPO_ROOT}"` in prose, naming the retired split as a dead end so it
     * cannot be re-adopted — while pinning nothing that ships. What ships, and
     * what the DA-F2 regression was actually about, is REPO_ROOT reaching a
     * shell as part of a PATH: step 2's payload file (primary spelling and
     * heredoc-fallback redirect target) and step 3's payload argument.
     */
    expect(driverMd).toContain('Read your working directory — one bare ');
    expect(unquotedRepoRootPaths(driverMd)).toEqual([]);
    expect(driverMd).toContain('"${REPO_ROOT}/.flotilla/tmp/');
  });

  it('the Scribe brief --dir interpolates the sidecar dir shell-quoted', () => {
    expect(hasUnquotedInterpolation(driverMd, '--dir ${dir}')).toBe(false);
    expect(driverMd).toContain('--dir "${dir}"');
  });

  it('negative control — both detectors actually fire on the unquoted forms (would have failed pre-fix, DA-F2)', () => {
    // The exact live regression (DA-F2): this repo's own checkout path
    // contains a space and a typographic en-dash; an unquoted interpolation
    // breaks on it silently — the Scribe stage logs loud and passes its
    // payload through rather than failing the wave, so the sidecar stops
    // being written durably at exactly the moment ADR-0024 exists to
    // guarantee it is. If these detectors stopped firing on the unquoted
    // form, that regression could reappear and this spec would not catch it.
    const regressed = driverMd
      .replace('"${REPO_ROOT}/.flotilla/tmp/', '${REPO_ROOT}/.flotilla/tmp/')
      .replace('--dir "${dir}"', '--dir ${dir}');
    expect(regressed).not.toEqual(driverMd); // both replacements actually matched
    expect(unquotedRepoRootPaths(regressed).length).toBeGreaterThan(0);
    expect(hasUnquotedInterpolation(regressed, '--dir ${dir}')).toBe(true);
  });
});

describe('skill-schema-drift — the retired Scribe cd-to-REPO_ROOT split stays a documented dead end (#356)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  /**
   * The exact, quoted prose mention `scribeBrief()` step 1 names as retired
   * (workflow-driver.md §The Scribe's cwd / step 1's own "DEAD END" clause,
   * in the "path constants are shell-quoted" describe block's own comment
   * above). That #251 re-pin correctly stopped asserting this string as
   * something that SHIPS — but in doing so dropped the ONLY assertion that
   * the dead-end NOTE ITSELF still exists. A reviewer probe has since
   * unquoted this exact mention (`cd ${REPO_ROOT}` for `cd "${REPO_ROOT}"`)
   * with nothing here to fail — this describe block restores that coverage.
   */
  const DEAD_END_MENTION = 'cd "${REPO_ROOT}"';

  /**
   * Every ```bash fence in the rendered brief text. Because the whole driver
   * script is itself one big ```js markdown fence, a NESTED ```bash fence —
   * the shape an ACTUAL, runnable step takes — has its backticks individually
   * escaped in the SOURCE (`\`\`\`bash`, since a bare backtick would close the
   * enclosing JS template literal); that escaping is exactly what this regex
   * matches. There is no literal, unescaped ```bash fence anywhere in this
   * file — the driver has exactly one outer fence, the whole script.
   */
  function bashFenceBodies(md: string): string[] {
    const out: string[] = [];
    const re = /\\`\\`\\`bash\n([\s\S]*?)\\`\\`\\`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(md))) out.push(m[1]);
    return out;
  }

  /**
   * True iff the dead-end mention is present verbatim AND never inside a
   * runnable bash fence. Both halves matter: dropping the mention (or
   * corrupting it, e.g. unquoting) fails the first half; moving it INTO a
   * fence — re-adopting the retired split as a live step rather than merely
   * naming it as one to avoid — fails the second half, even though the
   * plain substring would still be present somewhere in the document.
   */
  function deadEndStillADeadEnd(md: string): boolean {
    if (!md.includes(DEAD_END_MENTION)) return false;
    return bashFenceBodies(md).every(
      (body) => !body.includes('cd "${REPO_ROOT}"') && !body.includes('cd ${REPO_ROOT}'),
    );
  }

  it('the dead-end mention is present, quoted, in prose — never inside a runnable bash fence', () => {
    expect(deadEndStillADeadEnd(driverMd)).toBe(true);
  });

  it('negative control — the check fails when the mention leaves prose, and when it turns executable (Convention 11 falsification)', () => {
    // Probe A — "leaves prose": the exact quoted mention is altered. A
    // reviewer probe already did exactly this, unquoted, live, with no check
    // here to catch it before this re-pin.
    const unquoted = driverMd.replace(DEAD_END_MENTION, 'cd ${REPO_ROOT}');
    expect(unquoted).not.toEqual(driverMd); // the replace actually matched
    expect(deadEndStillADeadEnd(unquoted)).toBe(false);

    // Probe A2 — the mention leaves prose a second way: deleted outright
    // rather than merely corrupted.
    const deleted = driverMd.replace(DEAD_END_MENTION, '');
    expect(deleted).not.toEqual(driverMd);
    expect(deadEndStillADeadEnd(deleted)).toBe(false);

    // Probe B — "turns executable": the retired form is re-adopted as a
    // live step inside an actual runnable bash fence, rather than merely
    // named in prose as one to avoid. The plain substring is still present
    // (Probe A's check alone would miss this), which is exactly why the
    // fence check exists as its own half of the predicate.
    const fenceMarker = '\\`\\`\\`bash\ncd "${REPO_ROOT}"\n\\`\\`\\`';
    const reAdopted = `${driverMd}\n${fenceMarker}\n`;
    expect(reAdopted.includes(DEAD_END_MENTION)).toBe(true); // substring alone still present
    expect(deadEndStillADeadEnd(reAdopted)).toBe(false); // but the fence check catches it
  });
});

/**
 * Finds `openCh` at or after `fromIdx` and walks bracket depth to the
 * matching `closeCh`, returning the balanced substring (inclusive of both
 * delimiters). Shares the brace-walking idea `extractInlinedSchema` above
 * uses for object literals, generalized to any single delimiter pair so it
 * can also pull a `[...]` array literal or a `{...}` function body.
 *
 * Hoisted to module scope (issue #323) because a SECOND compose-time assertion
 * in the same file is now extracted the same way — `assertNotHumanGated`, the
 * human-gate backstop that sits directly beside `assertRequiredRowFields` in
 * the driver script. Two extractors walking braces slightly differently is
 * precisely the kind of near-duplicate that rots one copy silently.
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
 *
 * Hoisted to module scope alongside `extractBalanced` (issue #323): the
 * human-gate block at the foot of this file needs this SIBLING assertion to
 * state its own non-redundancy — the negative control there is precisely
 * "a fully-populated human-gated row passes `assertRequiredRowFields`", and it
 * has to run the real one to say so.
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

describe('skill-schema-drift — workflow-driver.md compose-time REQUIRED_ROW_FIELDS assertion (FOR-139)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

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

// ─── the worktree-count advisory threshold is pinned to the engine constant ───
//
// Same class of pin as the schema literals above, applied to a NUMBER instead of
// an object: the operator-facing worktree-count threshold is written out as the
// literal `12` in wave-start/SKILL.md step 4a and in start-mechanics.md (twice —
// the step-4a shell block and the dedicated prose section), while the authority
// is `WORKTREE_COUNT_ADVISORY_THRESHOLD` in tools/wave/src/worktree-cleanup.ts,
// which also owns the number's rationale and the advisory wording. A skill cannot
// `import` a TS const, so nothing coupled the two: raising the threshold in the
// engine would leave three stale literals telling an operator to sweep at a
// number the engine no longer uses (or, worse, not to).
//
// The pin is scoped to the doc REGIONS that discuss the threshold, resolved by
// stable heading anchors, and inside each region it reads EVERY
// comparison-shaped occurrence (`≤ 12`, `> 12`, `>12`, `<=12`) rather than a
// hand-listed set of sentences — so a fourth mention added later is pinned the
// day it is written, with nobody having to remember to extend a list. Anchors
// and non-empty regions both fail loud: a doc restructure that empties a region
// must break this pin rather than pass vacuously.

/** Regions of the operator docs that state the threshold, by stable anchors. */
const THRESHOLD_REGIONS: ReadonlyArray<{
  label: string;
  path: string;
  start: string;
  end: string;
}> = [
  {
    label: 'wave-start/SKILL.md step 4a',
    path: WAVE_START_SKILL_MD,
    start: '### 4a. Worktree-count advisory',
    end: '### 5. Mark each row in-flight',
  },
  {
    // Narrowed (issue #379, disclosure 357.2): this region used to run all the
    // way to "# 5. Mark each NON-HELD row in-flight", which swallowed the
    // command-line-advisory comment block (bytes, not worktrees) whole. A
    // comparison-shaped BYTE value written there by mistake would have failed
    // this pin — naming WORKTREE_COUNT_ADVISORY_THRESHOLD, the wrong constant
    // for a byte budget. The end anchor now stops right where that block
    // starts; COMMAND_LINE_ADVISORY_REGIONS below owns everything from there
    // to "# 4b." under its OWN rule (see the dedicated describe block).
    label: 'start-mechanics.md step-4a shell block',
    path: START_MECHANICS_MD,
    start: '# 4a. Worktree-count advisory',
    end: 'The engine surfaces the same verdict machine-readably: every',
  },
  {
    // Narrowed the same way, same issue: the prose twin used to run all the
    // way to "## Routing a tuple", swallowing "### The command-line term is
    // itself TWO conditions" (and the plugin/anchor/compose-currency gates
    // past it) into a region pinned to the worktree-count constant. The end
    // anchor now stops right at that subsection's own heading.
    label: 'start-mechanics.md worktree-count advisory section',
    path: START_MECHANICS_MD,
    start: '## The worktree-count advisory (step 4a)',
    end: '### The command-line term is itself TWO conditions',
  },
];

/**
 * Slice out `[start, end)` by literal anchors. Throws (never returns an empty
 * string) when either anchor is missing or out of order — a doc restructure has
 * to FAIL this pin, not silently reduce it to scanning nothing.
 */
function regionBetween(
  md: string,
  label: string,
  start: string,
  end: string,
): string {
  const from = md.indexOf(start);
  if (from < 0) {
    throw new Error(`threshold-region start anchor missing in ${label}: ${start}`);
  }
  const to = md.indexOf(end, from + start.length);
  if (to < 0) {
    throw new Error(`threshold-region end anchor missing in ${label}: ${end}`);
  }
  return md.slice(from, to);
}

/**
 * Every threshold-shaped comparison in a region: `≤ 12`, `> 12`, `>12`, `<=12`,
 * including a markdown-bolded `> **12**`. Deliberately keyed on the COMPARISON
 * operator rather than on bare digits, because these regions legitimately
 * mention other numbers (a seven-row wave, a step number, an incident date) and
 * only a compared number is the threshold. A markdown blockquote marker (`> `)
 * followed by prose does not match — the pattern requires digits.
 */
function thresholdComparisons(region: string): number[] {
  return [...region.matchAll(/(?:≤|>=|<=|>)\s*\**\s*(\d+)/g)].map((m) =>
    Number(m[1]),
  );
}

/**
 * The load-bearing assertion: every comparison in `region` is `threshold`, and
 * there is at least one. Throws with the offending values named, so a failure
 * says which number drifted rather than "expected [12,12] to equal [16,16]".
 */
function assertThresholdPinned(
  region: string,
  label: string,
  threshold: number,
): void {
  const found = thresholdComparisons(region);
  if (found.length === 0) {
    throw new Error(
      `${label}: no threshold comparison found at all — the region no longer ` +
        'states the threshold, so this pin would pass vacuously. Re-anchor it.',
    );
  }
  const drifted = found.filter((n) => n !== threshold);
  if (drifted.length > 0) {
    throw new Error(
      `${label}: threshold literal(s) ${drifted.join('/')} disagree with the ` +
        `engine's WORKTREE_COUNT_ADVISORY_THRESHOLD (${threshold}). The engine ` +
        'constant in tools/wave/src/worktree-cleanup.ts is the authority; the ' +
        'doc literal is a copy of it and must be updated together with it.',
    );
  }
}

describe('skill-schema-drift — the worktree-count threshold literal pins WORKTREE_COUNT_ADVISORY_THRESHOLD', () => {
  it.each(THRESHOLD_REGIONS.map((r) => [r.label, r] as const))(
    'every threshold comparison in %s equals the engine constant',
    (_label, region) => {
      const md = readFileSync(region.path, 'utf-8');
      const slice = regionBetween(md, region.label, region.start, region.end);
      expect(() =>
        assertThresholdPinned(
          slice,
          region.label,
          WORKTREE_COUNT_ADVISORY_THRESHOLD,
        ),
      ).not.toThrow();
      // Belt-and-braces: the helper above is the load-bearing assertion; this
      // pins the extracted values directly, so a helper that silently stopped
      // finding anything cannot hide behind a not.toThrow().
      const found = thresholdComparisons(slice);
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found)).toEqual(new Set([WORKTREE_COUNT_ADVISORY_THRESHOLD]));
    },
  );

  it.each([
    ['wave-start/SKILL.md', WAVE_START_SKILL_MD],
    ['start-mechanics.md', START_MECHANICS_MD],
  ] as const)('%s cites the engine constant as the authority', (_label, path) => {
    const md = readFileSync(path, 'utf-8');
    expect(md).toContain('WORKTREE_COUNT_ADVISORY_THRESHOLD');
    expect(md).toContain('tools/wave/src/worktree-cleanup.ts');
    // ...and names the pin itself, so the next editor learns from the doc why a
    // one-sided change fails, instead of from a red test they have to explain.
    expect(md).toContain('skill-schema-drift.spec.ts');
  });

  it.each([
    ['wave-start/SKILL.md', WAVE_START_SKILL_MD],
    ['start-mechanics.md', START_MECHANICS_MD],
  ] as const)(
    '%s states the comparison-shape narrowing at the guard citation site (issue #379, disclosure 357.1)',
    (_label, path) => {
      // An AC that cites this guard as "values stay engine-owned" is claiming
      // more than the guard enforces: thresholdComparisons() (above) only ever
      // matches a `>`/`≤`/`>=`/`<=` immediately followed by digits — a value
      // restated in prose, with no comparison operator, passes the guard
      // silently. Every citation site says so, in the same breath as the pin.
      const md = readFileSync(path, 'utf-8');
      expect(md).toMatch(/COMPARISON-SHAPED/);
      expect(md).toMatch(/prose/i);
    },
  );

  it.each(THRESHOLD_REGIONS.map((r) => [r.label, r] as const))(
    'negative control — a drifted literal in %s is caught',
    (_label, region) => {
      const md = readFileSync(region.path, 'utf-8');
      const slice = regionBetween(md, region.label, region.start, region.end);
      const drifted = WORKTREE_COUNT_ADVISORY_THRESHOLD + 4;
      // Drift exactly ONE mention — the realistic shape of this defect is a
      // partial edit, not a global rename.
      const regressed = slice.replace(
        new RegExp(`(≤|>=|<=|>)(\\s*\\**\\s*)${WORKTREE_COUNT_ADVISORY_THRESHOLD}`),
        `$1$2${drifted}`,
      );
      expect(regressed).not.toEqual(slice); // the replace actually matched
      expect(() =>
        assertThresholdPinned(
          regressed,
          region.label,
          WORKTREE_COUNT_ADVISORY_THRESHOLD,
        ),
      ).toThrow(new RegExp(`${drifted}`));
      expect(thresholdComparisons(regressed)).toContain(drifted);
    },
  );

  it('negative control — an engine-side change alone is caught (the other direction)', () => {
    // The likelier real-world order: the constant is raised, the docs are not.
    // Pinning against a *different* threshold value must fail for every region,
    // or the pin only guards doc edits and not the constant it exists to track.
    for (const region of THRESHOLD_REGIONS) {
      const md = readFileSync(region.path, 'utf-8');
      const slice = regionBetween(md, region.label, region.start, region.end);
      expect(() =>
        assertThresholdPinned(
          slice,
          region.label,
          WORKTREE_COUNT_ADVISORY_THRESHOLD + 1,
        ),
      ).toThrow(/disagree with the engine/);
    }
  });

  it('negative control — an emptied or re-titled region fails loud instead of passing vacuously', () => {
    expect(() => assertThresholdPinned('no numbers here', 'fixture', 12)).toThrow(
      /no threshold comparison found/,
    );
    expect(() =>
      regionBetween('# nothing\n', 'fixture', '### 4a. Worktree-count advisory', '### 5.'),
    ).toThrow(/start anchor missing/);
    expect(() =>
      regionBetween(
        '### 4a. Worktree-count advisory\nbody\n',
        'fixture',
        '### 4a. Worktree-count advisory',
        '### 5. Mark each row in-flight',
      ),
    ).toThrow(/end anchor missing/);
  });

  it('the extractor ignores non-threshold numbers and markdown blockquote markers', () => {
    // Guards the discriminator itself: a region mentioning a seven-row wave, a
    // step number and a date must contribute nothing, and a `> ` blockquote line
    // must not read as a `>` comparison.
    expect(
      thresholdComparisons(
        '> **This is an ADVISORY.** Live occurrence 2026-07-30, a seven-row wave, step 5.\n',
      ),
    ).toEqual([]);
    expect(thresholdComparisons('- **≤ 12** → silent\n- **> 12** → sweep\n')).toEqual([
      12, 12,
    ]);
    expect(thresholdComparisons('#   >12 → advisory; <=12 → silent\n')).toEqual([12, 12]);
  });
});

// ─── the command-line advisory subsection is carved OUT of the worktree-count
//     pin, and attributes its own failures (issue #379, disclosure 357.2) ────
//
// The two regions above are pinned to WORKTREE_COUNT_ADVISORY_THRESHOLD (12).
// Before this carve, both used to run past the command-line-advisory content —
// the comment block / prose subsection that names COMMAND_LINE_ADVISORY_THRESHOLD_BYTES
// and MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES (a pair of BYTE budgets that have
// nothing to do with worktree counting) — so a comparison-shaped byte value
// written there by mistake would have failed the worktree-count pin, naming
// the wrong constant (12) in the failure message.
//
// This subsection carries no threshold literal to pin: both engine constants
// are named, deliberately never restated as values (see the prose at "The
// command-line term is itself TWO conditions" and the matching shell-block
// comment). Its OWN rule is therefore simpler than the worktree-count pin's —
// no comparison-shaped occurrence belongs here at all — and a violation is
// reported under THIS region's own label, never the worktree-count constant's.

/** The two places (shell block + prose twin) that describe the command-line
 * advisory — carved out of THRESHOLD_REGIONS above so a byte value written
 * here is never misattributed to WORKTREE_COUNT_ADVISORY_THRESHOLD. Each entry
 * names the sibling worktree-count-pinned region it was carved out of, so the
 * negative control below can prove the carve (not just the new rule) by
 * showing the sibling region stays untouched by an injection here. */
const COMMAND_LINE_ADVISORY_REGIONS: ReadonlyArray<{
  label: string;
  path: string;
  start: string;
  end: string;
  worktreeCounterpart: (typeof THRESHOLD_REGIONS)[number];
}> = [
  {
    label: 'start-mechanics.md step-4a shell block — command-line advisory subsection',
    path: START_MECHANICS_MD,
    start: 'The engine surfaces the same verdict machine-readably: every',
    end: '# 4b. Plugin/engine lockstep gate',
    worktreeCounterpart: THRESHOLD_REGIONS[1],
  },
  {
    label: 'start-mechanics.md worktree-count advisory section — command-line advisory subsection',
    path: START_MECHANICS_MD,
    start: '### The command-line term is itself TWO conditions',
    end: '## The plugin/engine lockstep gate (step 4b)',
    worktreeCounterpart: THRESHOLD_REGIONS[2],
  },
];

/**
 * The load-bearing assertion for the carved-out subsection: it is a defect
 * for ANY comparison-shaped number to appear here at all, because both
 * COMMAND_LINE_ADVISORY_THRESHOLD_BYTES and MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES
 * are, by the prose's own stated rule, named and never restated as literals.
 * Throws naming THIS region/label and the offending value(s) — and deliberately
 * never mentions WORKTREE_COUNT_ADVISORY_THRESHOLD, so a failure here cannot
 * be misread as the worktree-count pin firing.
 */
function assertNoRestatedByteThreshold(region: string, label: string): void {
  const found = thresholdComparisons(region);
  if (found.length > 0) {
    throw new Error(
      `${label}: comparison-shaped value(s) ${found.join('/')} found. This is the ` +
        "command-line advisory subsection's own rule: COMMAND_LINE_ADVISORY_THRESHOLD_BYTES " +
        'and MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES (both in tools/wave/src/worktree-cleanup.ts) ' +
        'are named here by identifier, never restated as literals. A comparison-shaped number in ' +
        'this subsection is drift toward restating one of those byte budgets — name the constant ' +
        'instead of the value.',
    );
  }
}

describe('skill-schema-drift — the command-line advisory subsection carries no restated literal (issue #379)', () => {
  it.each(COMMAND_LINE_ADVISORY_REGIONS.map((r) => [r.label, r] as const))(
    'today, %s carries ZERO comparison-shaped occurrences',
    (_label, region) => {
      const md = readFileSync(region.path, 'utf-8');
      const slice = regionBetween(md, region.label, region.start, region.end);
      expect(thresholdComparisons(slice)).toEqual([]);
      expect(() => assertNoRestatedByteThreshold(slice, region.label)).not.toThrow();
    },
  );

  it.each(COMMAND_LINE_ADVISORY_REGIONS.map((r) => [r.label, r] as const))(
    '%s names both byte-budget constants by identifier',
    (_label, region) => {
      const md = readFileSync(region.path, 'utf-8');
      const slice = regionBetween(md, region.label, region.start, region.end);
      expect(slice).toContain('COMMAND_LINE_ADVISORY_THRESHOLD_BYTES');
      expect(slice).toContain('MAX_ARG_STRLEN_ADVISORY_THRESHOLD_BYTES');
    },
  );

  it.each(COMMAND_LINE_ADVISORY_REGIONS.map((r) => [r.label, r] as const))(
    'NEGATIVE CONTROL — a comparison-shaped byte value placed inside %s fails naming THAT subsection\'s own rule, never the worktree-count constant (disclosure 357.2, falsified live)',
    (_label, region) => {
      const md = readFileSync(region.path, 'utf-8');
      // A comparison-shaped BYTE value — the same SHAPE the worktree-count pin
      // matches (`>`/`≤`/`>=`/`<=` + digits), but a value nowhere near 12, and
      // about bytes, not worktrees. Injected right after the subsection's own
      // start anchor, so it lands inside the carved-out region and nowhere else.
      const poisoned = md.replace(
        region.start,
        `${region.start}\n\nA drifted mention: > 131072 bytes.\n`,
      );
      expect(poisoned).not.toEqual(md); // the replace actually matched

      // 1. The carved-out subsection catches it, naming ITS OWN region/rule —
      //    not the worktree-count constant.
      const poisonedSlice = regionBetween(poisoned, region.label, region.start, region.end);
      expect(thresholdComparisons(poisonedSlice)).toContain(131072);
      let thrown: Error | undefined;
      try {
        assertNoRestatedByteThreshold(poisonedSlice, region.label);
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain(region.label);
      expect(thrown!.message).toContain('131072');
      expect(thrown!.message).not.toContain('WORKTREE_COUNT_ADVISORY_THRESHOLD');

      // 2. The carve itself, not just the new rule: the sibling worktree-count
      //    -pinned region never even sees the injected value, and its own pin
      //    passes exactly as it did before the injection.
      const wc = region.worktreeCounterpart;
      const worktreeSlice = regionBetween(poisoned, wc.label, wc.start, wc.end);
      expect(thresholdComparisons(worktreeSlice)).not.toContain(131072);
      expect(() =>
        assertThresholdPinned(worktreeSlice, wc.label, WORKTREE_COUNT_ADVISORY_THRESHOLD),
      ).not.toThrow();
    },
  );

  it('the matcher itself did NOT widen — a prose (non-comparison-shaped) mention of a byte value still passes', () => {
    // The comparison-shape narrowing is deliberate and stays (reviewer hint):
    // this guard, like the worktree-count pin above, catches only occurrences
    // shaped like a comparison. A bare number in prose — "131072 bytes", no
    // leading >/≤/>=/<= — is not caught, exactly as it is not caught for the
    // worktree-count constant either (the sibling pin's own narrowing).
    expect(thresholdComparisons('the byte budget is 131072 bytes, roughly')).toEqual([]);
  });
});

// ─── the human-gated Worker literal is pinned to HUMAN_GATED_WORKER ──────────
//
// Third class of pin in this file, after the schema objects and the threshold
// number: a STRING TOKEN. The engine owns `HUMAN_GATED_WORKER`
// (tools/wave/src/wave-md-rw.ts) and its `humanHeldRowIds` owns the predicate;
// the skills reach that same predicate by grepping the Plan-Table `Worker` cell
// and therefore carry the literal `HITL-required` in their own prose, code
// blocks and the driver script. A skill cannot `import` a TS const, so before
// this pin nothing coupled the two: re-spelling the constant would leave five
// documents instructing an operator to hold on a token the engine no longer
// recognises — and the failure mode is the worst available, because a grep for
// a token nothing matches reports "no human-gated rows" and the wave dispatches
// straight past the gate.
//
// ── Why a CENSUS and not a pattern ───────────────────────────────────────────
//
// The threshold pin above could key on a comparison operator (`> 12`), which
// gave it a discriminator independent of the number itself. A bare token has no
// such syntax around it, and the obvious substitutes were MEASURED and rejected
// in this slice rather than assumed:
//
//   - A shape-derived regex (the constant's own segment lengths, i.e.
//     `\b\w{4}[-_]\w{8}\b`) was run against the shipped skills tree and matched
//     70+ unrelated tokens — `file-conflict`, `wave-reviewer`, `hand-composed`,
//     `with-concerns`. A pin that noisy is a pin that gets deleted.
//   - A "contains requir/hitl" net fails from the other side: `public-api-approval-required`,
//     `require_capture` and `REQUIRED_ROW_FIELDS` are all live, legitimate
//     tokens in these very files.
//
// So the pin counts EXACT occurrences of the engine constant per document, and
// records the counts. That is the same stance `index.spec.ts` takes for the root
// export surface, and it catches both directions:
//
//   - ENGINE MOVES, docs do not → every count collapses to 0 and every document
//     fails. This is the direction that matters; the engine is the authority.
//   - A DOC MOVES, engine does not → that document's count drops and it fails,
//     whatever the drifted spelling is — a shape-BLIND check, which is exactly
//     the property the two rejected patterns could not offer.
//   - A doc grows a NEW mention → the count rises and the pin fails. That is the
//     check working, not a false positive: a sixth place carrying the token is a
//     decision someone should have typed a number for.
//
// The two EXECUTABLE copies get an exact structural pin on top of the census —
// the padded-cell grep one-liner and the driver's `HUMAN_GATED_WORKERS` array
// are extracted by their surrounding syntax and compared token-for-token, so
// they cannot drift even within an unchanged count.

/**
 * Every document that writes the human-gated Worker literal out, with how many
 * times it does so. A wrong number here fails loudly and names the file; see the
 * block comment above for why the count is the pin.
 */
const HUMAN_GATE_LITERAL_CENSUS: ReadonlyArray<{
  label: string;
  path: string;
  occurrences: number;
}> = [
  { label: 'wave-start/SKILL.md', path: WAVE_START_SKILL_MD, occurrences: 4 },
  { label: 'wave-start/reference/start-mechanics.md', path: START_MECHANICS_MD, occurrences: 5 },
  { label: 'wave-start/reference/workflow-driver.md', path: WORKFLOW_DRIVER_MD, occurrences: 3 },
  { label: 'wave-create/SKILL.md', path: WAVE_CREATE_SKILL_MD, occurrences: 3 },
  { label: 'wave-create/reference/create-mechanics.md', path: CREATE_MECHANICS_MD, occurrences: 2 },
];

/** How many times `token` occurs in `md` (plain substring, non-overlapping). */
function countOccurrences(md: string, token: string): number {
  if (token.length === 0) throw new Error('countOccurrences: empty token');
  let n = 0;
  let from = 0;
  for (;;) {
    const at = md.indexOf(token, from);
    if (at < 0) return n;
    n += 1;
    from = at + token.length;
  }
}

/**
 * Every token written into a PADDED PLAN-TABLE CELL grep pattern, i.e. the
 * operator-facing detector `grep -E '\|[[:space:]]*<token>[[:space:]]*\|'`.
 * Keyed entirely on the surrounding POSIX bracket-expression syntax, never on
 * the token's own spelling — a pin that searched for the engine's current value
 * could only ever find agreement with itself.
 */
function paddedCellGrepTokens(md: string): string[] {
  return [
    ...md.matchAll(/\\\|\[\[:space:\]\]\*(.+?)\[\[:space:\]\]\*\\\|/g),
  ].map((m) => m[1]);
}

/**
 * Load the driver's compose-time human gate (`HUMAN_GATED_WORKERS` +
 * `assertNotHumanGated`) straight out of the shipped workflow-driver.md — the
 * same eval-the-source approach {@link loadAssertionModule} uses for its sibling
 * assertion, and for the same reason: the driver is pasted into a Workflow
 * `script` sandbox with no filesystem and no imports, so there is no module to
 * require. A rename or reshape of either declaration fails this extraction
 * loudly rather than silently testing a stale copy hard-coded into this spec.
 */
function loadHumanGateModule(md: string): {
  HUMAN_GATED_WORKERS: string[];
  assertNotHumanGated: (issue: Record<string, unknown>) => void;
} {
  const constNeedle = 'const HUMAN_GATED_WORKERS = ';
  const constIdx = md.indexOf(constNeedle);
  if (constIdx < 0) {
    throw new Error('const HUMAN_GATED_WORKERS = [...] not found in workflow-driver.md');
  }
  const constSrc = extractBalanced(md, constIdx + constNeedle.length, '[', ']');

  const assertNeedle = 'function assertNotHumanGated(issue) ';
  const assertIdx = md.indexOf(assertNeedle, constIdx);
  if (assertIdx < 0) {
    throw new Error('function assertNotHumanGated(issue) {...} not found in workflow-driver.md');
  }
  const assertSrc = extractBalanced(md, assertIdx + assertNeedle.length, '{', '}');

  const src = `
    const HUMAN_GATED_WORKERS = ${constSrc};
    function assertNotHumanGated(issue) ${assertSrc}
    return { HUMAN_GATED_WORKERS, assertNotHumanGated };
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return Function(src)();
}

describe("skill-schema-drift — the skills' human-gated Worker literal pins HUMAN_GATED_WORKER", () => {
  it.each(HUMAN_GATE_LITERAL_CENSUS.map((d) => [d.label, d] as const))(
    '%s carries exactly the recorded number of engine-constant occurrences',
    (_label, doc) => {
      const md = readFileSync(doc.path, 'utf-8');
      const found = countOccurrences(md, HUMAN_GATED_WORKER);
      // Non-vacuity first: a census entry that dropped to zero must read as a
      // drift, never as "this file was simply not about the gate after all".
      expect(found).toBeGreaterThan(0);
      expect(found).toBe(doc.occurrences);
    },
  );

  it.each(HUMAN_GATE_LITERAL_CENSUS.map((d) => [d.label, d] as const))(
    '%s cites the engine constant by NAME as the authority',
    (_label, doc) => {
      // The literal alone would leave a reader with a magic string and nowhere
      // to look. Naming the constant is what makes the copy legible AS a copy —
      // and it is what tells the next editor which side is authoritative.
      const md = readFileSync(doc.path, 'utf-8');
      expect(md).toContain('HUMAN_GATED_WORKER');
    },
  );

  it('NEGATIVE CONTROL — a single drifted mention in any document is caught', () => {
    // The realistic shape of this defect is a PARTIAL edit: one sentence
    // re-spelled, the others left alone. Drift exactly one occurrence per
    // document and require every document to notice.
    for (const doc of HUMAN_GATE_LITERAL_CENSUS) {
      const md = readFileSync(doc.path, 'utf-8');
      const drifted = md.replace(HUMAN_GATED_WORKER, 'HITL_required');
      expect(drifted).not.toEqual(md); // the replace actually matched
      expect(countOccurrences(drifted, HUMAN_GATED_WORKER)).toBe(doc.occurrences - 1);
      expect(countOccurrences(drifted, HUMAN_GATED_WORKER)).not.toBe(doc.occurrences);
    }
  });

  it('NEGATIVE CONTROL — an engine-side rename alone is caught (the other direction)', () => {
    // The likelier real-world order, and the dangerous one: the constant is
    // re-spelled, the docs are not. Every document must then read as ZERO
    // occurrences of the new value — i.e. every document fails, rather than the
    // gate quietly grepping for a token no spine will ever carry.
    const renamed = 'needs-a-human';
    expect(renamed).not.toBe(HUMAN_GATED_WORKER);
    for (const doc of HUMAN_GATE_LITERAL_CENSUS) {
      const md = readFileSync(doc.path, 'utf-8');
      expect(countOccurrences(md, renamed)).toBe(0);
      expect(countOccurrences(md, renamed)).not.toBe(doc.occurrences);
    }
  });

  it('NEGATIVE CONTROL — the counter itself is not vacuous', () => {
    expect(countOccurrences('a-b a-b a-b', 'a-b')).toBe(3);
    expect(countOccurrences('nothing here', 'a-b')).toBe(0);
    expect(() => countOccurrences('x', '')).toThrow(/empty token/);
  });
});

/**
 * The two regions of start-mechanics.md that carry the WORKER-cell detector, by
 * stable anchors — the step-3b shell block and its prose section.
 *
 * Scoping matters here and the unscoped version was measured wrong before it was
 * fixed: the padded-cell grep shape is a house idiom, and step 2's in-flight
 * detector uses the identical syntax over the STATE cell
 * (`\|[[:space:]]*(dispatched|re-dispatched)[[:space:]]*\|`). A whole-file
 * extraction therefore pulled a state alternation into a worker-token pin. The
 * regions below are the two places the WORKER axis is detected, and nowhere else.
 */
const HUMAN_GATE_GREP_REGIONS: ReadonlyArray<{
  label: string;
  start: string;
  end: string;
}> = [
  {
    label: 'start-mechanics.md step-3b shell block',
    start: '# 3b. The HUMAN gate',
    end: '# 4. Host auth-preflight',
  },
  {
    label: 'start-mechanics.md human-gate section',
    start: '## The human gate (step 3b)',
    end: '## The worktree-count advisory (step 4a)',
  },
];

describe('skill-schema-drift — the padded-cell grep detector pins HUMAN_GATED_WORKER', () => {
  const mechanicsMd = readFileSync(START_MECHANICS_MD, 'utf-8');

  it.each(HUMAN_GATE_GREP_REGIONS.map((r) => [r.label, r] as const))(
    'every token in the padded Worker-cell grep in %s equals the engine constant',
    (_label, region) => {
      const slice = regionBetween(mechanicsMd, region.label, region.start, region.end);
      const tokens = paddedCellGrepTokens(slice);
      // Non-vacuity: the detector is the operator's copy of the predicate and it
      // must actually be present. An extractor that quietly found nothing would
      // pass the equality below forever — which is exactly what a doc
      // restructure that moved the grep out of this region would produce.
      expect(tokens.length).toBeGreaterThan(0);
      expect(new Set(tokens)).toEqual(new Set([HUMAN_GATED_WORKER]));
    },
  );

  it('NEGATIVE CONTROL — a drifted token inside a grep pattern is caught', () => {
    for (const region of HUMAN_GATE_GREP_REGIONS) {
      const slice = regionBetween(mechanicsMd, region.label, region.start, region.end);
      const regressed = slice.replace(
        `[[:space:]]*${HUMAN_GATED_WORKER}[[:space:]]*`,
        '[[:space:]]*HITL_required[[:space:]]*',
      );
      expect(regressed).not.toEqual(slice); // the replace actually matched
      const tokens = paddedCellGrepTokens(regressed);
      expect(tokens).toContain('HITL_required');
      expect(new Set(tokens)).not.toEqual(new Set([HUMAN_GATED_WORKER]));
    }
  });

  it('NEGATIVE CONTROL — a re-titled or emptied region fails loud instead of passing vacuously', () => {
    expect(() =>
      regionBetween('# nothing\n', 'fixture', '# 3b. The HUMAN gate', '# 4.'),
    ).toThrow(/start anchor missing/);
    expect(() =>
      regionBetween('# 3b. The HUMAN gate\nbody\n', 'fixture', '# 3b. The HUMAN gate', '# 4.'),
    ).toThrow(/end anchor missing/);
  });

  it('the extractor reads the token by its SURROUNDINGS, not by its spelling', () => {
    // Proves the discriminator is independent of the constant's current value —
    // the property that lets this pin see a drift at all.
    expect(
      paddedCellGrepTokens(
        "grep -E '\\|[[:space:]]*anything-at-all[[:space:]]*\\|'\n",
      ),
    ).toEqual(['anything-at-all']);
    expect(paddedCellGrepTokens('no grep here\n')).toEqual([]);
  });

  it("the step-2 STATE detector is deliberately OUT of scope — it is a different axis", () => {
    // Guards the scoping decision itself, so a later widening of the regions
    // re-breaks this test rather than silently re-importing the state
    // alternation into a worker-token pin.
    const stateRegion = regionBetween(
      mechanicsMd,
      'start-mechanics.md in-flight detector',
      '## The in-flight row detector (step 2, verified)',
      '## The human gate (step 3b)',
    );
    const stateTokens = paddedCellGrepTokens(stateRegion);
    expect(stateTokens.length).toBeGreaterThan(0);
    expect(stateTokens).not.toContain(HUMAN_GATED_WORKER);
    expect(stateTokens.join(' ')).toMatch(/dispatched/);
  });
});

// ─── the driver's compose-time human gate is pinned by extraction ────────────
//
// `assertNotHumanGated` is the structural backstop for start-mechanics step 3b:
// a human-gated row that reaches `agent()` has no failure of its own to hit —
// every field interpolates, the worktree checks out, the Worker runs to
// completion against a blocker an agent cannot clear by construction, and the
// wave spends a full agent budget on a report that reads ordinary.
//
// Its sibling `assertRequiredRowFields` has been pinned by extraction since
// FOR-139. This one was not: it was falsified only by a one-off scratch script
// in its landing dispatch, so nothing committed kept it honest. Same extraction,
// same file, same reason — the driver has no importable module, so the shipped
// markdown IS the source of truth and this spec runs it.

describe('skill-schema-drift — workflow-driver.md compose-time human gate (issue #323)', () => {
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');

  it("the driver's HUMAN_GATED_WORKERS array pins the engine constant", () => {
    // The compose-time-filled copy of the token, extracted from the shipped
    // script rather than transcribed. This is the strongest of the three literal
    // pins: an exact array comparison against the engine value.
    const { HUMAN_GATED_WORKERS } = loadHumanGateModule(driverMd);
    expect(HUMAN_GATED_WORKERS).toEqual([HUMAN_GATED_WORKER]);
  });

  it('a human-gated row THROWS, naming both the row id and the offending worker', () => {
    const { assertNotHumanGated } = loadHumanGateModule(driverMd);
    const row = { id: '11', worker: HUMAN_GATED_WORKER };
    expect(() => assertNotHumanGated(row)).toThrow(/11/);
    expect(() => assertNotHumanGated(row)).toThrow(new RegExp(HUMAN_GATED_WORKER));
    // …and says what to DO, or the throw is a puzzle rather than a backstop.
    expect(() => assertNotHumanGated(row)).toThrow(/remove it from ISSUES/);
  });

  it('an ordinary AFK row passes without throwing', () => {
    const { assertNotHumanGated } = loadHumanGateModule(driverMd);
    expect(() => assertNotHumanGated({ id: '42', worker: 'background' })).not.toThrow();
    expect(() => assertNotHumanGated({ id: '43', worker: 'background-heavy' })).not.toThrow();
    expect(() => assertNotHumanGated({ id: '44', worker: 'foreground' })).not.toThrow();
  });

  it("a MISSING worker is not this predicate's business (the documented split)", () => {
    // The driver documents these as deliberately separate predicates:
    // REQUIRED_ROW_FIELDS asks "is this field present enough to interpolate?"
    // and this one asks "may this row be dispatched at all?". Merging them would
    // make a missing `worker` read as a human gate — a wiring bug reported as a
    // hold, sending the Coordinator to look for a human who does not exist.
    const { assertNotHumanGated } = loadHumanGateModule(driverMd);
    expect(() => assertNotHumanGated({ id: '45' })).not.toThrow();
    expect(() => assertNotHumanGated({ id: '46', worker: undefined })).not.toThrow();
  });

  it('the match is EXACT — a worker that merely contains the token is not gated', () => {
    // The engine-side reader matches the parsed Worker CELL exactly (never a
    // substring of the row's line); the driver's `includes` over an array of
    // whole tokens is the same discipline, and this pins it. A row whose worker
    // is `background` while its TITLE mentions the gate must dispatch normally.
    const { assertNotHumanGated } = loadHumanGateModule(driverMd);
    expect(() =>
      assertNotHumanGated({ id: '47', worker: `not-${HUMAN_GATED_WORKER}` }),
    ).not.toThrow();
    expect(() =>
      assertNotHumanGated({
        id: '48',
        worker: 'background',
        title: `wire the ${HUMAN_GATED_WORKER} gate through wave-start`,
      }),
    ).not.toThrow();
  });

  it('NEGATIVE CONTROL — the SIBLING assertion does not catch this, so the pin is not redundant', () => {
    // The exact evidence Convention 11 asks for, in the shape FOR-139's own AC4
    // control uses: the new check must be seen to catch something the
    // already-pinned neighbour lets through. `assertRequiredRowFields` inspects
    // PRESENCE only, so a fully-populated human-gated row sails past it — which
    // is why a second, separate assertion exists at all.
    const { assertRequiredRowFields } = loadAssertionModule(driverMd);
    const gatedButComplete: Record<string, unknown> = {
      id: '11',
      slug: 'rotate-the-credential',
      branch: 'wave/11-rotate-the-credential',
      risk: 'cross-feature-refactor',
      model: 'sonnet',
      anchorSha: 'deadbeefcafe',
      coordinatorBranch: 'main',
      issueSpec: 'Rotate the PAT in the keychain.',
      prTitle: 'chore: rotate the credential',
      closePhrase: 'Closes #11',
      siblingBranches: '(none — last in-flight issue)',
      worker: HUMAN_GATED_WORKER,
    };

    // The pinned neighbour is silent about it…
    expect(() => assertRequiredRowFields(gatedButComplete)).not.toThrow();
    // …and the gate this block pins is not.
    const { assertNotHumanGated } = loadHumanGateModule(driverMd);
    expect(() => assertNotHumanGated(gatedButComplete)).toThrow(/human-gated/);
  });

  it('NEGATIVE CONTROL — loadHumanGateModule fails loud if either declaration is renamed/removed', () => {
    expect(() => loadHumanGateModule('# no gate here\n')).toThrow(
      /HUMAN_GATED_WORKERS.*not found/,
    );
    expect(() =>
      loadHumanGateModule("const HUMAN_GATED_WORKERS = ['x']\n# and nothing else\n"),
    ).toThrow(/assertNotHumanGated.*not found/);
  });
});

// ─── Check 5's coverage denominator rides all FOUR contract copies (#419, #431) ───
//
// The Reviewer predicts merge-tree conflicts against its sibling in-flight
// branches. The driver runs the rows with NO barrier — by design, so row B's
// Worker runs while row A's Reviewer already runs — which means a sibling branch
// may simply not be on `origin` when a Reviewer reaches for it. Observed four
// times in ONE wave, each reported honestly and each partial. The fourth is the
// class this pin exists for: the sibling branch was present but still AT THE WAVE
// ANCHOR, so its diff was empty and `git merge-tree` returned exit 0 plus one tree
// hash — byte-identical to what a genuinely clean prediction returns. Partial
// coverage that is indistinguishable from full coverage is the failure mode, and
// no command output separates them; only a tip-vs-anchor comparison does.
//
// The remedy is contract text, and it is stated in FOUR hand-maintained places
// with nothing coupling them — the same shape as the schema-literal pins above:
//
//   - wave-reviewer/SKILL.md                      — the operator's view
//   - wave-reviewer/reference/reviewer-checks.md  — the runnable detail
//   - wave-start/reference/workflow-driver.md     — the reviewerBrief ACTUALLY dispatched
//   - .claude/agents/wave-reviewer.md             — the Reviewer's OWN system prompt
//
// The driver copy is the one that reaches a running Reviewer, so a drift there is
// the one that silently stops happening; it is also the only copy that can
// interpolate the row's own `anchorSha`, which is what makes the at-anchor
// comparison executable rather than merely described. Both properties are pinned
// separately below.
//
// The FOURTH copy (issue #431) sat outside the #419 row's declared Files and was
// missed entirely — a Reviewer dispatched from that system prompt was still being
// taught the old denominator-less form (a bare fetch + merge-tree loop, no
// four-outcome vocabulary) even after the other three copies moved. It is pinned
// here in its REDUCED form only: a static system prompt cannot carry a per-row
// interpolated value, so the agent-definition copy is required to state the
// outcome vocabulary and the coverage-line duty (shared assertions, below) PLUS
// an explicit deferral to the dispatched reviewerBrief for the mechanics it
// structurally cannot carry — never the full brief-side contract, which would be
// pinning text that is not, and cannot be, there.
//
// Two further hardenings ride along (disclosed against the #419 pins, neither a
// defect in the shipped text): the anchor-interpolation pin now rejects an
// ESCAPED, non-interpolating `\${issue.anchorSha}` — a plain `toContain` cannot
// tell that apart from the real interpolation, since the literal substring
// `${issue.anchorSha}` still appears inside it. And `refusesAtAnchorAsClean` now
// requires `vacuous` and the `never … clean` refusal to sit within ONE bounded,
// self-contained span rather than merely existing independently anywhere in the
// region — the old existence-anywhere form happened to pass for
// reviewer-checks.md only because that copy states the refusal in two separate
// places (the `at-anchor` heading, and the tip-comparison prose), either of which
// alone supplied both words; the pin's correctness should not rest on that
// incidental duplication.
//
// Deliberately NOT pinned into existence here: any ReviewerVerdict schema shape.
// The coverage line lives INSIDE the existing advisory strings in
// `reviewerFocusItems`, so the other half of this contract is that the schema did
// NOT move — asserted explicitly, because "we added a reporting duty" is exactly
// the change that grows a field by reflex.

/**
 * The four per-sibling prediction outcomes Check 5 must enumerate. Every one is
 * load-bearing, and the split is the whole point: two of them are real coverage
 * (`predicted-clean`, `predicted-conflict`) and two are NOT coverage at all
 * (`not-on-origin`, `at-anchor`). A copy that names three has quietly dropped a
 * way for a Reviewer to be blind — and `at-anchor` is the one a reader deletes
 * as redundant, because it is the one whose command output looks like success.
 */
const SIBLING_PREDICTION_OUTCOMES = [
  'predicted-clean',
  'predicted-conflict',
  'not-on-origin',
  'at-anchor',
] as const;

/**
 * The canonical opening of the mandatory coverage line. All four copies write it
 * out verbatim so a Reviewer emits ONE recognisable shape and a Coordinator can
 * find it — the denominator is worth nothing if every verdict phrases it freshly.
 */
const COVERAGE_LINE_PREFIX = 'Sibling merge-tree coverage:';

/** The bold-caps opener of the reviewerBrief's own sibling-coverage clause. */
const DRIVER_SIBLING_COVERAGE_OPENER =
  '**SIBLING MERGE-TREE PREDICTION REPORTS ITS COVERAGE DENOMINATOR.**';

/**
 * A genuine, unescaped `${issue.anchorSha}` interpolation — the `(?<!\\)`
 * negative lookbehind is the whole point. `\${issue.anchorSha}` (an escaped
 * dollar sign, which prints the literal template text at dispatch time instead
 * of interpolating the row's SHA) still contains the substring
 * `${issue.anchorSha}`, so a plain `toContain` cannot distinguish the two —
 * only a check that inspects the character immediately before the `$` can.
 */
const ANCHOR_INTERPOLATION = /(?<!\\)\$\{issue\.anchorSha\}/;

/**
 * Slice the text BETWEEN two literal anchors — `[start.length, end)`, the start
 * anchor itself excluded — failing loud on a missing/out-of-order anchor or an
 * empty region, because a doc restructure must BREAK this pin rather than quietly
 * reduce it to scanning nothing.
 *
 * Two deliberate departures from `regionBetween` above, both about failure
 * legibility rather than taste. (1) Its throw message is worded for the threshold
 * pins ("threshold-region start anchor missing"); a Check-5 anchor failing under
 * that wording sends the next reader to the wrong constant entirely. (2) It slices
 * from `from`, INCLUDING its own start anchor — correct there, where a threshold
 * literal can sit in the heading line itself, but it makes an emptiness check
 * unreachable: the region always contains at least the anchor. Excluding the
 * anchor here is what lets "the anchors survived a restructure that gutted
 * everything between them" fail instead of pass.
 */
function contractRegion(md: string, label: string, start: string, end: string): string {
  const from = md.indexOf(start);
  if (from < 0) {
    throw new Error(`sibling-coverage region start anchor missing in ${label}: ${start}`);
  }
  const contentFrom = from + start.length;
  const to = md.indexOf(end, contentFrom);
  if (to < 0) {
    throw new Error(`sibling-coverage region end anchor missing in ${label}: ${end}`);
  }
  const region = md.slice(contentFrom, to);
  if (region.trim().length === 0) {
    throw new Error(`sibling-coverage region is EMPTY in ${label} — the pin would pass vacuously`);
  }
  return region;
}

/**
 * The tightest stretch of `region` that contains ALL FOUR outcomes, measured in
 * characters from the start of the first to the end of the last — or `null` when
 * one of them is absent entirely.
 *
 * A plain "every outcome appears somewhere in this copy" check was tried first
 * and FALSIFIED live: dropping `at-anchor` from the driver's vocabulary list left
 * it still passing, because the term survived further down in the worked example
 * and in the prose that calls it vacuous. Presence-anywhere cannot tell
 * "enumerated" from "mentioned in passing", and the drift that matters — a copy
 * that quietly stops offering an outcome as a CHOICE — is exactly the one it
 * misses. Span is the discriminator: a real enumeration puts the four within a
 * few hundred characters of each other; a term surviving only in scattered prose
 * cannot.
 */
function enumerationSpan(region: string): number | null {
  const marks: Array<{ at: number; outcome: string }> = [];
  for (const outcome of SIBLING_PREDICTION_OUTCOMES) {
    for (let from = 0; ; ) {
      const at = region.indexOf(outcome, from);
      if (at < 0) break;
      marks.push({ at, outcome });
      from = at + 1;
    }
  }
  marks.sort((a, b) => a.at - b.at);
  let best: number | null = null;
  for (let i = 0; i < marks.length; i++) {
    const seen = new Set<string>();
    for (let j = i; j < marks.length; j++) {
      seen.add(marks[j].outcome);
      if (seen.size === SIBLING_PREDICTION_OUTCOMES.length) {
        const span = marks[j].at + marks[j].outcome.length - marks[i].at;
        if (best === null || span < best) best = span;
        break;
      }
    }
  }
  return best;
}

/**
 * The widest an honest enumeration may be, in characters. Chosen from measurement,
 * not taste — the four numbers this pin sits between were all read off a run:
 *
 *   -  70  wave-reviewer/SKILL.md         (slash-separated inline list)
 *   -  76  workflow-driver.md             (pipe-separated inline list)
 *   - 111  reviewer-checks.md Check 5     (the coverage-line worked example)
 *   - 409  the falsified driver copy      (`at-anchor` dropped from the list,
 *                                          surviving only in the prose below it)
 *
 * 250 leaves the widest shipped copy better than 2× of headroom and still lands
 * well under the falsified value. Deliberately loose at that: this pin exists to
 * catch a DROPPED choice, not to police how much a table row may say. A future
 * rewrite that legitimately widens an enumeration past it fails with the measured
 * span in the message — re-tune the constant then, and record the new reading here.
 *
 * What it does NOT catch, stated plainly so nobody over-reads a green run: a copy
 * that keeps ANY ONE complete enumeration passes. Drop `at-anchor` from Check 5's
 * table while leaving the coverage-line example intact and this pin stays green —
 * the vocabulary is still communicated, which is the property being pinned.
 */
const MAX_ENUMERATION_SPAN = 250;

/**
 * The denominator examples a copy writes after {@link COVERAGE_LINE_PREFIX} —
 * `3/5`, `0/N`. Read OUT of the copy by shape rather than hard-listed here, so an
 * author who rewrites the example keeps the pin instead of tripping it.
 */
function coverageDenominatorExamples(region: string): string[] {
  return [
    ...region.matchAll(
      new RegExp(`${COVERAGE_LINE_PREFIX}\\s*(\\d+/(?:\\d+|N))`, 'g'),
    ),
  ].map((m) => m[1]);
}

/**
 * Does this copy state the at-anchor case as VACUOUS *and* refuse it as clean —
 * as ONE self-contained statement? Both halves are required and neither is
 * sufficient. Naming the outcome without the refusal leaves "the branch was
 * there, merge-tree exited 0, call it clean" wide open — which is precisely the
 * reading four honest Reviewer reports could not rule out — and refusing it
 * without the word `vacuous` drops the reason, which is the only thing that
 * makes the refusal survive an editor.
 *
 * `vacuous` and the `never … clean` refusal must sit within one bounded,
 * period-free span of EACH OTHER (either order) — not merely exist somewhere,
 * anywhere, independently in the region. An earlier, existence-anywhere version
 * of this check passed reviewer-checks.md only because that copy happens to
 * state the refusal in two separate places (the `at-anchor` heading, and the
 * tip-comparison prose) — either alone supplies both words, so the check's real
 * behaviour rested on that incidental duplication rather than on a single,
 * provably self-contained refusal ever being present. Requiring co-location
 * makes ONE statement both sufficient and necessary, for every copy alike —
 * it no longer depends on the refusal being stated twice anywhere.
 */
function refusesAtAnchorAsClean(region: string): boolean {
  if (!region.includes('at-anchor')) return false;
  const vacuousThenNeverClean = /\bvacuous\b[^.]{0,160}\bnever\b[^.]{0,160}\bclean\b/i;
  const neverCleanThenVacuous = /\bnever\b[^.]{0,160}\bclean\b[^.]{0,160}\bvacuous\b/i;
  return vacuousThenNeverClean.test(region) || neverCleanThenVacuous.test(region);
}

describe('skill-schema-drift — sibling merge-tree prediction states its coverage denominator (#419)', () => {
  const reviewerSkillMd = readFileSync(WAVE_REVIEWER_SKILL_MD, 'utf-8');
  const reviewerChecksMd = readFileSync(REVIEWER_CHECKS_MD, 'utf-8');
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');
  const reviewerAgentMd = readFileSync(WAVE_REVIEWER_AGENT_MD, 'utf-8');

  /** Check 5's own section of the runnable checks reference. */
  function checksCheck5(md: string): string {
    return contractRegion(md, 'reviewer-checks.md', '## Check 5 —', '## Check 6 —');
  }

  /** The reviewerBrief's sibling-coverage clause, scoped to itself so a match
   * cannot be satisfied by an unrelated sentence elsewhere in a 1000-line file. */
  function driverClause(md: string): string {
    return contractRegion(
      md,
      'workflow-driver.md reviewerBrief',
      DRIVER_SIBLING_COVERAGE_OPENER,
      '**If this slice ships a NEW check**',
    );
  }

  /** Check 5's own section of the Reviewer's agent definition (its system
   * prompt) — the fourth copy (#431), scoped the same way as the checks
   * reference so a match cannot be satisfied by an unrelated sentence
   * elsewhere in the file. */
  function agentCheck5(md: string): string {
    return contractRegion(
      md,
      'wave-reviewer.md agent definition',
      '### 5. Sibling merge-tree prediction',
      '### 6. Documented-form comparison',
    );
  }

  /** The four copies, sliced. wave-reviewer/SKILL.md is taken whole: it is the
   * Reviewer's own operator doc end to end, and its statement of this contract is
   * deliberately spread across three sections (what a verdict rests on, the
   * boundary, Common Mistakes) — an anchor pair would pin one third of it. The
   * agent-definition copy carries the REDUCED form (see block comment above) —
   * it satisfies the same shared assertions below (outcome vocabulary, coverage
   * line, at-anchor refusal, advisory-only) because that much genuinely lives in
   * its reduced text; the per-row anchor-interpolation assertion further down
   * stays scoped to the driver copy alone, because only the driver carries that
   * value at all. */
  const COPIES: Array<[string, string]> = [
    ['wave-reviewer/SKILL.md', reviewerSkillMd],
    ['reviewer-checks.md Check 5', checksCheck5(reviewerChecksMd)],
    ['workflow-driver.md reviewerBrief', driverClause(driverMd)],
    ['wave-reviewer.md agent definition (reduced form)', agentCheck5(reviewerAgentMd)],
  ];

  it.each(COPIES)('%s enumerates all FOUR per-sibling outcomes', (_label, region) => {
    for (const outcome of SIBLING_PREDICTION_OUTCOMES) {
      expect(region).toContain(outcome);
    }
    // …and enumerates them, rather than merely containing the four words
    // somewhere. See enumerationSpan's docstring for the live falsification that
    // made the difference load-bearing.
    const span = enumerationSpan(region);
    expect(span).not.toBeNull();
    expect(span).toBeLessThanOrEqual(MAX_ENUMERATION_SPAN);
  });

  it.each(COPIES)(
    '%s requires the coverage line, with a denominator-shaped example',
    (_label, region) => {
      expect(region).toContain(COVERAGE_LINE_PREFIX);
      // Not just the words: an example that actually shows a denominator. A
      // "coverage" sentence with no `n/N` in it does not tell a Reviewer what
      // the line is counting against.
      expect(coverageDenominatorExamples(region).length).toBeGreaterThan(0);
      // `0/N` — "nothing was predictable from here" — is a REPORTABLE result,
      // not an excuse to omit the line. Stated in every copy.
      expect(region).toMatch(/0\/N/);
    },
  );

  it.each(COPIES)('%s names at-anchor VACUOUS and refuses it as clean', (_label, region) => {
    expect(refusesAtAnchorAsClean(region)).toBe(true);
  });

  it.each(COPIES)(
    '%s keeps sibling findings ADVISORY — the coverage line never escalates a verdict',
    (_label, region) => {
      expect(region).toMatch(/advisory/i);
      expect(region).toMatch(/never\b[^.]{0,200}changes-requested/i);
    },
  );

  it('the reviewerBrief instructs the at-anchor comparison against the anchor IT carries', () => {
    // The comparison is only meaningful against THIS row's anchor, and the brief
    // is the only one of the four copies where that value exists at dispatch
    // time. A copy that says "compare against the wave anchor" without
    // interpolating it hands the Reviewer a rule it cannot execute — the same
    // failure shape as the bad-anchor first round (W2-F1) one level down.
    //
    // A plain `toContain('${issue.anchorSha}')` cannot tell a real interpolation
    // apart from an ESCAPED, non-interpolating `\${issue.anchorSha}` — the
    // substring `${issue.anchorSha}` still appears inside the escaped form, so a
    // mutation that breaks the interpolation (and prints the literal template
    // text at dispatch time instead of the row's SHA) would still satisfy a bare
    // substring check. Require the `$` to NOT be escaped.
    const clause = driverClause(driverMd);
    expect(clause).toMatch(ANCHOR_INTERPOLATION);
    expect(clause).toContain('git rev-parse FETCH_HEAD');
  });

  it('NEGATIVE CONTROL — an escaped, non-interpolating anchor form is caught', () => {
    // The mutation a plain `toContain` cannot see: escape the `$` so the
    // template no longer interpolates. `\${issue.anchorSha}` renders as that
    // literal text at dispatch time — every Reviewer would receive the SAME
    // uninterpolated string instead of its own row's SHA — yet the substring
    // `${issue.anchorSha}` is still sitting right there inside it.
    const clause = driverClause(driverMd);
    // Escape EVERY occurrence — the clause interpolates the anchor twice (the
    // vacuity explanation, and the fetch-tip comparison itself), and a mutation
    // that broke only one would leave the other genuinely interpolating.
    const escaped = clause.split('${issue.anchorSha}').join('\\${issue.anchorSha}');
    expect(escaped).not.toEqual(clause); // the replace actually matched
    expect(escaped).toContain('${issue.anchorSha}'); // …a bare toContain still passes
    expect(escaped).not.toMatch(ANCHOR_INTERPOLATION); // …the hardened pin does not
    expect(clause).toMatch(ANCHOR_INTERPOLATION); // control: the real copy passes
  });

  it('wave-reviewer.md Check 5 defers to the dispatched reviewerBrief for the per-row mechanics it cannot carry', () => {
    // The reduced-form half of the #431 fix: the agent definition is a static
    // system prompt, so it structurally cannot interpolate `${issue.anchorSha}`
    // (that assertion stays scoped to the driver copy above, on purpose — it
    // would be a vacuous pin here, asserting text that cannot exist). What it
    // MUST do instead is say so, explicitly, rather than silently omitting the
    // mechanics and leaving a Reviewer to assume there are none.
    const region = agentCheck5(reviewerAgentMd);
    expect(region).toMatch(/reviewerBrief/);
    expect(region).toMatch(/\bcannot\b[^.]{0,160}\bcarry\b/i);
  });

  it('NEGATIVE CONTROL — a wave-reviewer.md rewrite that drops the reviewerBrief deferral is caught', () => {
    const region = agentCheck5(reviewerAgentMd);
    const noDeferral = region.replace(
      /\*\*This section states the contract, not the per-row mechanics\.\*\*[\s\S]*$/,
      '',
    );
    expect(noDeferral).not.toEqual(region); // the strip actually matched
    expect(noDeferral).not.toMatch(/reviewerBrief/);
    expect(noDeferral).not.toMatch(/\bcannot\b[^.]{0,160}\bcarry\b/i);
    // The rest of the reduced-form contract (outcome vocabulary, coverage line,
    // at-anchor refusal) survives the strip — this control isolates the
    // deferral clause, it does not also re-prove the shared assertions above.
    expect(enumerationSpan(noDeferral)).not.toBeNull();
  });

  it('NO ReviewerVerdict schema change — the driver copy still deep-equals the engine const, and no outcome token leaks into it', () => {
    // The other half of the contract: this is a REPORTING duty discharged inside
    // the existing `reviewerFocusItems` strings. If a later edit "helps" by
    // modelling the outcomes as a field, both halves of this assertion fail —
    // the deep-equal first, and the token scan second, naming the leak.
    const schema = extractInlinedSchema(
      driverMd,
      DRIVER_REVIEWER_VERDICT_ANCHOR,
      'REVIEWER_VERDICT_SCHEMA',
    );
    expect(schema).toEqual(plain(REVIEWER_VERDICT_JSON_SCHEMA));
    const literal = JSON.stringify(schema);
    for (const outcome of SIBLING_PREDICTION_OUTCOMES) {
      expect(literal).not.toContain(outcome);
    }
    expect(literal).not.toContain(COVERAGE_LINE_PREFIX);
  });

  it.each(SIBLING_PREDICTION_OUTCOMES.map((o) => [o] as const))(
    'NEGATIVE CONTROL — a copy that drops the "%s" outcome is caught',
    (outcome) => {
      // Shape-blind on purpose: every outcome is dropped in turn from every
      // copy, so no single term is the only one actually guarded. `at-anchor`
      // is the term at real risk — it reads as redundant next to
      // `predicted-clean` until you know its output is identical.
      for (const [, region] of COPIES) {
        const stripped = region.split(outcome).join('<dropped>');
        expect(stripped).not.toEqual(region); // the strip actually matched
        expect(stripped).not.toContain(outcome);
        expect(enumerationSpan(stripped)).toBeNull();
      }
    },
  );

  it('NEGATIVE CONTROL — an outcome dropped from the LIST but surviving in prose is still caught', () => {
    // The live falsification, kept as a regression: this is the shape the
    // presence-only predecessor of this pin let through. Only the driver's
    // enumeration occurrence of `at-anchor` is removed; the copy still names the
    // outcome further down (the vacuity prose, the coverage-line example), so a
    // `toContain` check keeps passing and only the SPAN moves.
    const clause = driverClause(driverMd);
    const listOnly = clause.replace(' | \\`at-anchor\\`', '');
    expect(listOnly).not.toEqual(clause); // the replace actually matched
    expect(listOnly).toContain('at-anchor'); // presence-only would still pass…
    const span = enumerationSpan(listOnly);
    expect(span).not.toBeNull();
    expect(span!).toBeGreaterThan(MAX_ENUMERATION_SPAN); // …the span pin does not
  });

  it('NEGATIVE CONTROL — a copy that keeps the outcome but calls at-anchor clean is caught', () => {
    // The subtle regression this whole block exists for: the term survives, the
    // refusal does not. `refusesAtAnchorAsClean` must fail on text that still
    // NAMES `at-anchor` — so it cannot be passing on the term's mere presence.
    for (const [, region] of COPIES) {
      const softened = region
        .replace(/vacuous/gi, 'noted')
        .replace(/never/gi, 'usually not');
      expect(softened).toContain('at-anchor'); // still named…
      expect(refusesAtAnchorAsClean(softened)).toBe(false); // …and no longer refused
      expect(refusesAtAnchorAsClean(region)).toBe(true); // control: the real copy passes
    }
  });

  it('NEGATIVE CONTROL — scattered, non-co-located `vacuous` and `never … clean` no longer satisfy the pin', () => {
    // The blind spot disclosed against the #419 pins: an existence-anywhere
    // version of `refusesAtAnchorAsClean` (`region.includes` / independent
    // `.test()` calls, no proximity requirement) is satisfiable by TWO
    // unrelated sentences that happen to each supply half the evidence — which
    // is exactly reviewer-checks.md's shape (the `at-anchor` heading states the
    // refusal once; the tip-comparison prose restates it again), so the old
    // check's correctness there rested on that incidental duplication rather
    // than on one self-contained statement ever being required. Reconstruct
    // that shape synthetically — `vacuous` and the `never … clean` refusal
    // present, but pulled apart into two unrelated sentences separated by an
    // unrelated paragraph — and confirm the CURRENT, co-location-based pin
    // correctly refuses it, unlike the existence-anywhere predecessor it
    // replaced (reconstructed inline below for the contrast, not imported —
    // that version no longer exists in this file on purpose).
    const existenceAnywherePredecessor = (r: string): boolean =>
      r.includes('at-anchor') && /vacuous/i.test(r) && /never\b[^.]{0,160}\bclean\b/i.test(r);

    const scattered = [
      'This paragraph names `at-anchor` and calls the tip-mismatch case vacuous,',
      'for reasons unrelated to any refusal.',
      '',
      'A wholly separate later paragraph, about a different topic entirely,',
      'happens to say the working tree must never be left anything but clean.',
    ].join('\n');

    expect(scattered).toContain('at-anchor');
    expect(existenceAnywherePredecessor(scattered)).toBe(true); // the old blind spot
    expect(refusesAtAnchorAsClean(scattered)).toBe(false); // the hardened pin is not fooled

    // Control: every real copy's genuine, self-contained refusal still passes
    // the hardened pin — the fix narrows what is ACCEPTED, it does not also
    // narrow what the shipped copies actually say.
    for (const [, region] of COPIES) {
      expect(refusesAtAnchorAsClean(region)).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — a coverage sentence with no denominator does not satisfy the pin', () => {
    // "we mention coverage" is not "we report a denominator". The matcher is
    // keyed on the `n/N` SHAPE right after the canonical prefix, so prose that
    // drops the fraction fails even with the prefix intact.
    const denominatorless = `(advisory) ${COVERAGE_LINE_PREFIX} predicted where possible.`;
    expect(denominatorless).toContain(COVERAGE_LINE_PREFIX);
    expect(coverageDenominatorExamples(denominatorless)).toEqual([]);
    // …and the shape it should have had:
    expect(
      coverageDenominatorExamples(`(advisory) ${COVERAGE_LINE_PREFIX} 3/5 predicted`),
    ).toEqual(['3/5']);
    expect(coverageDenominatorExamples(`${COVERAGE_LINE_PREFIX} 0/N predicted`)).toEqual([
      '0/N',
    ]);
  });

  it('NEGATIVE CONTROL — contractRegion fails loud on a missing anchor or an emptied region', () => {
    expect(() => checksCheck5('# a checks file with no Check 5\n')).toThrow(
      /start anchor missing in reviewer-checks\.md/,
    );
    expect(() => driverClause('a driver with no reviewerBrief clause')).toThrow(
      /start anchor missing in workflow-driver\.md reviewerBrief/,
    );
    expect(() => agentCheck5('# an agent definition with no Check 5\n')).toThrow(
      /start anchor missing in wave-reviewer\.md agent definition/,
    );
    // A restructure that leaves both anchors adjacent must FAIL, not pass on an
    // empty string — the vacuous-pass failure mode this whole file guards for.
    expect(() =>
      contractRegion(
        `${DRIVER_SIBLING_COVERAGE_OPENER}**If this slice ships a NEW check**`,
        'synthetic',
        DRIVER_SIBLING_COVERAGE_OPENER,
        '**If this slice ships a NEW check**',
      ),
    ).toThrow(/EMPTY in synthetic/);
  });
});

// ─── The FETCH_HEAD named-ref clause rides all FOUR contract copies (#407) ───
//
// The Reviewer diffs the branch under review, not just its siblings (Check 5
// above). A live occurrence showed the SAME shared-checkout hazard on that
// PRIMARY diff: a Reviewer diffing `<anchor>..FETCH_HEAD` briefly got another
// row's two-file diff, because a sibling Reviewer's own `git fetch` — in the
// same shared checkout — overwrote the single, shared `FETCH_HEAD` ref
// mid-dispatch. Nothing failed loudly; the wrong tree was plausible, and a
// Reviewer who didn't happen to look twice would have verified it and
// reported it as verified.
//
// The remedy: fetch the branch under review into a STABLE NAMED REF keyed on
// the row id (`refs/review/<id>`, immune to a sibling's own fetch because the
// ref name differs per row), and ASSERT the resolved SHA against the
// Worker-reported commit before trusting it — abort loudly
// (`questions-blocking`) on any mismatch. `FETCH_HEAD` is never read.
//
// Stated in FOUR hand-maintained copies, the same shape as the Check-5 pins
// above:
//
//   - wave-reviewer/SKILL.md                      — the operator's view
//   - wave-reviewer/reference/reviewer-checks.md  — the runnable detail, and
//                                                    the PRIMARY teaching site
//                                                    for the ADR-0034 rationale
//   - wave-start/reference/workflow-driver.md     — the reviewerBrief ACTUALLY dispatched
//   - .claude/agents/wave-reviewer.md             — the Reviewer's OWN system prompt
//
// A path constant for the agent-definition file is declared LOCAL to this
// block rather than added to the shared consts region above: issue #431
// (Check 5's fourth-copy pin, landing on a sibling branch to this one)
// independently adds its own agent.md path constant up there. A second,
// differently-named constant here keeps this block's diff clear of that
// region entirely, so the two rows' additions to this SAME file don't collide
// on the same lines — a predicted merge conflict between the two rows over
// this shared file is expected and advisory regardless (both touch it;
// neither touches the other's own new block).

const FETCH_HEAD_CLAUSE_AGENT_MD = join(
  __dirname,
  '../../../.claude/agents/wave-reviewer.md',
);

/**
 * The canonical, backtick-tolerant "FETCH_HEAD is never read" statement. Two
 * copies state it as inline code immediately followed by the words
 * (`` `FETCH_HEAD` is never read ``); one states a SECOND, standalone
 * occurrence with no backticks at all (a repeated noun, not a repeated code
 * span). A plain substring match would have to pick one spelling; this regex
 * accepts either.
 */
const NEVER_READ_RE = /FETCH_HEAD`?\s+is never read/;

/** The stable named ref path every copy must prescribe. */
const NAMED_REF_PATH = 'refs/review/';

/**
 * Mismatch-abort language: a resolved SHA that disagrees with the
 * Worker-reported commit must abort loudly, never proceed quietly.
 * Proximity-scoped for the same reason `refusesAtAnchorAsClean` above is —
 * both words appearing SOMEWHERE in a region does not show they are talking
 * about each other.
 */
const MISMATCH_ABORT_RE = /mismatch[^.]{0,220}questions-blocking/i;

describe('skill-schema-drift — the FETCH_HEAD named-ref clause rides all FOUR contract copies (#407)', () => {
  const reviewerSkillMd = readFileSync(WAVE_REVIEWER_SKILL_MD, 'utf-8');
  const reviewerChecksMd = readFileSync(REVIEWER_CHECKS_MD, 'utf-8');
  const driverMd = readFileSync(WORKFLOW_DRIVER_MD, 'utf-8');
  const agentMd = readFileSync(FETCH_HEAD_CLAUSE_AGENT_MD, 'utf-8');

  /** The clause's own section in reviewer-checks.md — the primary teaching site. */
  function checksClause(md: string): string {
    return contractRegion(md, 'reviewer-checks.md', '## The branch ref —', '## The diff base —');
  }

  /** The clause's own section in the dispatched reviewerBrief. */
  function driverClause(md: string): string {
    return contractRegion(
      md,
      'workflow-driver.md reviewerBrief',
      '## Resolve the branch — a stable named ref',
      '## Workspace setup (do first)',
    );
  }

  /** The clause's own section in the Reviewer's agent definition (system prompt). */
  function agentClause(md: string): string {
    return contractRegion(
      md,
      'wave-reviewer.md agent definition',
      '## Resolve the branch — a stable named ref',
      '## Checks (run all',
    );
  }

  /** The four copies, sliced. wave-reviewer/SKILL.md is taken whole — its
   * statement of this clause is deliberately spread across two sections
   * ("What a sound verdict rests on" and "Common Mistakes"), the same reason
   * the Check-5 pins above take it whole rather than anchor a sub-region. */
  const COPIES: Array<[string, string]> = [
    ['wave-reviewer/SKILL.md', reviewerSkillMd],
    ['reviewer-checks.md', checksClause(reviewerChecksMd)],
    ['workflow-driver.md reviewerBrief', driverClause(driverMd)],
    ['wave-reviewer.md agent definition', agentClause(agentMd)],
  ];

  it.each(COPIES)('%s prescribes the stable named ref path', (_label, region) => {
    expect(region).toContain(NAMED_REF_PATH);
  });

  it.each(COPIES)('%s states FETCH_HEAD is never read', (_label, region) => {
    expect(region).toMatch(NEVER_READ_RE);
  });

  it.each(COPIES)('%s aborts loudly on a SHA mismatch (questions-blocking)', (_label, region) => {
    expect(region).toMatch(MISMATCH_ABORT_RE);
  });

  it('the PRIMARY teaching site (reviewer-checks.md) cites the silent-to-loud rationale (ADR-0034)', () => {
    const region = checksClause(reviewerChecksMd);
    expect(region).toContain('ADR-0034');
    expect(region).toMatch(/silent/i);
    expect(region).toMatch(/loud/i);
  });

  it("the driver copy interpolates THIS row's branch and id — not a generic placeholder", () => {
    // The mechanics are only executable against a real row; a copy that says
    // "fetch the branch" without interpolating which one hands the Reviewer a
    // rule it cannot run — the same failure shape the Check-5 pins guard
    // against for `${issue.anchorSha}` above. And the point of the whole
    // clause is undone if the driver copy still tells the Reviewer to read
    // FETCH_HEAD for the branch under review.
    const clause = driverClause(driverMd);
    expect(clause).toContain('${issue.branch}');
    expect(clause).toContain('refs/review/${issue.id}');
    expect(clause).not.toContain('git rev-parse FETCH_HEAD');
  });

  it('NEGATIVE CONTROL — contractRegion fails loud on a missing anchor', () => {
    expect(() => checksClause('# no clause here\n')).toThrow(
      /start anchor missing in reviewer-checks\.md/,
    );
    expect(() => driverClause('# no clause here\n')).toThrow(
      /start anchor missing in workflow-driver\.md reviewerBrief/,
    );
    expect(() => agentClause('# no clause here\n')).toThrow(
      /start anchor missing in wave-reviewer\.md agent definition/,
    );
  });

  it.each(COPIES)(
    'NEGATIVE CONTROL — %s: dropping the named-ref path is caught',
    (_label, region) => {
      const stripped = region.split(NAMED_REF_PATH).join('<dropped>');
      expect(stripped).not.toEqual(region); // the strip actually matched
      expect(stripped).not.toContain(NAMED_REF_PATH);
    },
  );

  it.each(COPIES)(
    'NEGATIVE CONTROL — %s: softening "is never read" to "should not be read" is caught',
    (_label, region) => {
      const softened = region.replace(NEVER_READ_RE, 'FETCH_HEAD should not be read');
      expect(softened).not.toEqual(region); // the replace actually matched
      expect(softened).not.toMatch(NEVER_READ_RE);
    },
  );

  it.each(COPIES)(
    'NEGATIVE CONTROL — %s: dropping the mismatch-abort language is caught',
    (_label, region) => {
      const stripped = region.replace(/questions-blocking/gi, '<dropped>');
      expect(stripped).not.toMatch(MISMATCH_ABORT_RE);
    },
  );

  it('NEGATIVE CONTROL — dropping ADR-0034 from the primary teaching site is caught', () => {
    const region = checksClause(reviewerChecksMd);
    const stripped = region.replace(/ADR-0034/g, '<dropped>');
    expect(stripped).not.toEqual(region); // the strip actually matched
    expect(stripped).not.toContain('ADR-0034');
  });
});
