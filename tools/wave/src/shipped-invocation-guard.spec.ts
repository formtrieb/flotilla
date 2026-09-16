import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { verbContracts } from './cli';
import { flagContractForToken, type VerbContract } from './verb-contract';

/**
 * shipped-invocation-guard.spec.ts — every engine invocation the skills, the
 * agents and the shipped driver spell has to resolve to a Verb contract, and
 * has to spell it CANONICALLY (ADR-0051 decision 9, skill-side pin).
 *
 * ## The gap this closes
 *
 * `verb-contract-drift.spec.ts` holds every `'--x'` LITERAL in the engine
 * sources to its verb's contract — the source side of decision 9. Nothing held
 * the other side. The skills are the CLI's biggest consumer (roughly 290
 * invocations across the shipped markdown) and the template every Coordinator
 * copies from, and at `931dab9` twenty-three skill, agent and driver files
 * carried a spelling ADR-0051 turns into an alias: `route-verdict --iteration`,
 * `resume --reports/--verdicts`, `worktree-cleanup --wave`,
 * `write-report/write-verdict <json> --dir`, the positional forms of
 * `verdict-acked`, `render-verdict` and `merge-order`, `route-tuple
 * --report/--verdict`, `spine add-disclosure --wave`.
 *
 * An alias is SILENT by decision 8 — no stderr note, no result field — so every
 * one of those calls exits 0 and nothing anywhere says the spelling is the
 * non-canonical one. The rewrite alone would therefore have lasted exactly
 * until the next skill edit. This spec is what makes it structure: the canonical
 * mark's third carrier, beside `--help` and the Catalog.
 *
 * ## The five rules
 *
 * For every invocation found in a shipped skill file, an agent file, or the
 * shipped driver template:
 *
 * 1. **The verb exists** — the first token names a top-level verb the router
 *    declares, or a verb GROUP (`spine`, `issue-store`, `host-pr`, `config`).
 * 2. **The op exists** — a group's second token names an op that group declares.
 *    This is where a verb-level misgrip lands (`spine set-row-stat` for
 *    `set-row-state`), which is the class ADR-0051 decision 9 names by example.
 * 3. **Every flag is declared** — a `--token` the contract does not know, and
 *    that is not one of the two router globals, fails.
 * 4. **Every spelling is canonical** — a token that resolves only through
 *    {@link FlagContract.aliases} fails, naming the canonical spelling. *An
 *    alias in a SKILL is a failure; an alias in the ENGINE is fine* — the engine
 *    accepts every alias forever (decision 1 dates no removal), and this rule is
 *    about what the shipped corpus TEACHES, not about what the parser accepts.
 * 5. **No positional form of a named twin** — the five verbs of decision 6
 *    (`merge-order`, `verdict-acked`, `render-verdict`, `write-report`,
 *    `write-verdict`) accept their arguments positionally as a surviving alias;
 *    the named form is canonical, so a documented positional call fails and is
 *    told which flags to use.
 *
 * ## What is NOT an invocation — and why that is a rule rather than a hatch
 *
 * The marker is also used to REFER to the binding rather than to call it, and
 * both shapes have to keep working. Four structural rules separate them, each
 * chosen because it describes what the text IS, not which file it sits in:
 *
 * - **A marker out of COMMAND POSITION** ({@link isCommandPosition}) — a word
 *   character on either side of it. `wave_cli()` is the binding's own
 *   definition and the shape prose cites it by (`` `wave_cli()` is a shell
 *   function ``); it is the binding NAMED, and reading it as a call would
 *   resolve `()` as a verb.
 * - **A bare mention.** `` `{{wave-cli}}` `` inside an inline code span with
 *   nothing after it — the corpus's own convention for naming the binding in
 *   prose ("read every `{{wave-cli}}` below as that one string"). Nothing
 *   follows the marker, so there is nothing to resolve.
 * - **A SCHEMATIC verb or op** — `{{wave-cli}} <verb> …`, `{{wave-cli}} spine
 *   <op>`, `{{wave-cli}} issue-store triage-*`. A token that is a placeholder
 *   (`<…>`), a template expansion (`${…}`), an optional (`[…]`) or a glob
 *   (`*`) names a CLASS of verbs, not one verb, and no contract can be
 *   resolved for it. Only the verb and op positions are read this way — a
 *   placeholder in any later position is a VALUE and is checked as one.
 * - **An ELISION** — `…` or `...` standing for "and the rest of the arguments",
 *   as in `` `VERDICT_SECTION=$({{wave-cli}} render-verdict …)` ``. It is
 *   neither a flag nor a positional; reading it as a positional would fire rule
 *   5 on every abbreviated citation in the corpus.
 *
 * What is deliberately NOT here is a per-file or per-line exemption table.
 * One prose sentence in `wave-start/reference/start-mechanics.md` used to read
 * "every {{wave-cli}} call in the steps above" — a mention wearing an
 * invocation's shape, with `call` sitting where a verb goes. It was rewritten to
 * name the subject ("every engine-CLI call") rather than exempted, because the
 * alternative is a table that grows one row per future sentence and silently
 * covers a real misgrip the day someone adds the wrong row. The failure message
 * below says so at the moment it fires.
 *
 * ## What this spec does NOT check
 *
 * **Positional ARITY, beyond rule 5.** Shipped prose abbreviates
 * (`issue-store flag "$ID" …`), and a documentation excerpt that omits a
 * required flag is not a wrong spelling. The refusal in
 * {@link checkUndeclared} is the runtime's job; this spec's subject is how a
 * call is SPELLED.
 *
 * **Values.** A placeholder, a shell variable, a quoted path — anything in a
 * value position passes untouched, which is exactly what ADR-0051 decision 9
 * requires ("Placeholder tokens are values, not flags"). The walk steps OVER
 * the value of every value-taking flag, so `--text "--wave"` can never be read
 * as a flag — the same step-over `scanArgs()` performs, and the same live bug it
 * was written for.
 */

/** The repo root. This spec lives at `tools/wave/src/`, three levels down. */
const CLONE_ROOT = resolve(__dirname, '../../..');

/** Where the shipped markdown lives. */
const MARKDOWN_ROOTS = ['.claude/skills', '.claude/agents'] as const;

/** The shipped driver template — the one JS file that composes invocations. */
const DRIVER_DIR = 'tools/wave/driver';

/**
 * The three spellings of "the engine binding, resolved" that a shipped file can
 * carry: the markdown template token, the driver script's compose-time constant,
 * and the **shell-function form** the corpus actually types in a `bash` fence
 * (`wave_cli() { NODE_USE_ENV_PROXY=1 <engine.cli> "$@"; }`, Convention 12 half
 * one — a binding lives in a function, never in a variable). All three stand in
 * the same place: immediately before a verb.
 *
 * The function form was missing when this guard first landed, and the review
 * that caught it is the argument for naming all three here rather than one
 * "canonical" spelling: two `route-verdict --iteration` calls sat in
 * `wave-shared/reference/routing-mechanics.md` — the file that TEACHES the
 * binding — and the guard read straight past them, because they were spelled
 * `wave_cli route-verdict …` and not `{{wave-cli}} route-verdict …`. A pin that
 * reads one of a corpus's three spellings is green for the wrong reason.
 */
const INVOCATION_MARKERS = ['{{wave-cli}}', '${WAVE_CLI}', 'wave_cli'] as const;

/** The verb groups: a group token plus an op token address one contract. */
const VERB_GROUPS = ['host-pr', 'issue-store', 'spine', 'config'] as const;

// ---------------------------------------------------------------------------
// Finding the invocations
// ---------------------------------------------------------------------------

/** One invocation as it was found: where it sits, and its argv. */
export interface FoundInvocation {
  /** Repo-relative path of the file it was found in. */
  readonly file: string;
  /** 1-indexed line of the MARKER — where a reader goes to fix it. */
  readonly line: number;
  /** The text from the marker to the end of the invocation, for the message. */
  readonly text: string;
  /** The argv tokens after the marker. */
  readonly tokens: readonly string[];
}

/**
 * Split one invocation's text into argv tokens.
 *
 * Quotes are honoured and stripped (`"$SPINE"` → `$SPINE`); a markdown-escaped
 * pipe (`\|`, which is how a table cell spells a literal `|`) is un-escaped
 * rather than read as a shell pipeline; and `<…>` nesting suppresses the
 * shell-operator meaning of `>` inside a placeholder, so `<json-file>` is one
 * token and not a redirect.
 *
 * The walk STOPS at the first real shell operator (`|`, `;`, `&`, a redirect,
 * or a `#` comment at a token boundary): what follows belongs to another
 * command, and reading it as this verb's arguments is how a guard invents
 * failures — `{{wave-cli}} issue-store flag "$ID" … | tee log` is one
 * invocation, not one invocation with a `tee` flag.
 *
 * An UNBALANCED `)` stops it too, and that one is load-bearing rather than
 * tidy: the corpus's guarded captures wrap an invocation in `$( … )`
 * (`VERDICT_SECTION=$({{wave-cli}} render-verdict …)`), and the marker sits
 * INSIDE the substitution, so the closing paren belongs to the assignment and
 * not to the verb. Without this, the last token of every such call would carry a
 * stray `)` — which is exactly how the elision `…)` first read as a positional
 * argument and fired the named-twin rule on a citation that spells nothing.
 */
export function tokenizeInvocation(segment: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let started = false;
  let placeholderDepth = 0;
  let parenDepth = 0;
  const flush = () => {
    if (started) out.push(cur);
    cur = '';
    started = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      else cur += c;
      started = true;
      continue;
    }
    // A markdown escape (`\|` in a table cell, `\*`, `` \` ``) contributes its
    // escaped character and never its shell meaning.
    if (c === '\\' && i + 1 < segment.length && '|`*_<>$'.includes(segment[i + 1])) {
      cur += segment[i + 1];
      started = true;
      i++;
      continue;
    }
    if (c === '\\' && i + 1 >= segment.length) break; // a dangling continuation
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === '<') {
      placeholderDepth++;
      cur += c;
      started = true;
      continue;
    }
    if (c === '>') {
      if (placeholderDepth > 0) {
        placeholderDepth--;
        cur += c;
        started = true;
        continue;
      }
      break; // a redirect — the invocation ended at the previous token
    }
    if (placeholderDepth === 0 && c === '(') {
      parenDepth++;
      cur += c;
      started = true;
      continue;
    }
    if (placeholderDepth === 0 && c === ')') {
      if (parenDepth === 0) break; // closes the `$( … )` this call sits inside
      parenDepth--;
      cur += c;
      started = true;
      continue;
    }
    if (placeholderDepth === 0 && (c === '|' || c === ';' || c === '&')) break;
    if (placeholderDepth === 0 && c === '#' && !started) break;
    if (c === ' ' || c === '\t') {
      flush();
      continue;
    }
    cur += c;
    started = true;
  }
  flush();
  return out;
}

/**
 * True when the marker at `at` stands in COMMAND position — the only place an
 * invocation can start.
 *
 * Both sides are a word boundary, and each side answers a real shape the corpus
 * carries:
 *
 * - **After.** A marker that runs straight into another character NAMES the
 *   binding rather than calling it. `wave_cli()` is the function's own
 *   definition (`wave_cli() { … "$@"; }`) and the shape every prose citation of
 *   it uses (`` `wave_cli()` is a shell function ``); `` `{{wave-cli}}` `` with
 *   the code span closing straight after it is the corpus's bare mention. Read
 *   as calls, the first would resolve `()` as a verb and the second nothing at
 *   all — two invented failures on text that spells no invocation.
 * - **Before.** A marker preceded by a word character is part of a longer
 *   identifier, not the binding. `$(wave_cli …)` and `` `wave_cli …` `` are
 *   calls; a hypothetical `my_wave_cli` is a different name.
 *
 * This is a rule about what the TEXT IS, in the same family as the schematic-verb
 * and elision rules above — deliberately not a file-or-line exemption table.
 */
function isCommandPosition(line: string, at: number, marker: string): boolean {
  const before = line[at - 1];
  const after = line[at + marker.length];
  if (before !== undefined && /[A-Za-z0-9_]/.test(before)) return false;
  return after === undefined || after === ' ' || after === '\t';
}

/**
 * Every invocation in `source`.
 *
 * An occurrence inside an inline code span ends at the span's closing backtick;
 * anywhere else it runs to the end of the line, following a trailing `\`
 * continuation onto the next line (the multi-line shell form the mechanics
 * documents use for `route-tuple` and `compose-driver`).
 */
export function extractInvocations(file: string, source: string): FoundInvocation[] {
  const lines = source.split('\n');
  const found: FoundInvocation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const marker of INVOCATION_MARKERS) {
      let at = line.indexOf(marker);
      while (at !== -1) {
        if (!isCommandPosition(line, at, marker)) {
          at = line.indexOf(marker, at + marker.length);
          continue;
        }
        const before = line.slice(0, at);
        const insideCodeSpan = (before.match(/`/g) ?? []).length % 2 === 1;
        let segment = line.slice(at + marker.length);
        if (insideCodeSpan) {
          const close = segment.indexOf('`');
          if (close !== -1) segment = segment.slice(0, close);
        } else {
          let j = i;
          while (segment.trimEnd().endsWith('\\') && j + 1 < lines.length) {
            segment = `${segment.trimEnd().slice(0, -1)} ${lines[j + 1]}`;
            j++;
          }
        }
        const text = segment.trim();
        // A BARE MENTION: the marker with nothing after it is the corpus's own
        // way of naming the binding in prose. Nothing to resolve.
        if (text.length > 0) {
          found.push({ file, line: i + 1, text, tokens: tokenizeInvocation(text) });
        }
        at = line.indexOf(marker, at + marker.length);
      }
    }
  }
  return found;
}

/** True when a token stands for a CLASS rather than naming one thing. */
export function isSchematicToken(token: string | undefined): boolean {
  if (token === undefined) return true;
  return (
    token.startsWith('<') ||
    token.startsWith('${') ||
    token.startsWith('[') ||
    token.includes('*')
  );
}

/** True when a token elides the rest of the arguments rather than being one. */
export function isElision(token: string): boolean {
  return token === '…' || token === '...';
}

// ---------------------------------------------------------------------------
// Judging one invocation
// ---------------------------------------------------------------------------

/** One rule violation, rendered the way the failure prints it. */
export interface InvocationViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: 'verb' | 'op' | 'undeclared-flag' | 'alias' | 'twin-positional';
  readonly message: string;
}

const AGGREGATE = verbContracts();

/**
 * The contract an invocation addresses, or `null` when its verb (or its group's
 * op) is schematic — the not-an-invocation answer — or `undefined` when it names
 * something this engine does not declare, which is a failure.
 */
function contractFor(
  tokens: readonly string[],
): { contract: VerbContract; args: string[] } | null | undefined {
  const head = tokens[0];
  if (isSchematicToken(head)) return null;
  if ((VERB_GROUPS as readonly string[]).includes(head)) {
    const op = tokens[1];
    if (isSchematicToken(op)) return null;
    const contract = AGGREGATE[`${head} ${op}`];
    return contract === undefined ? undefined : { contract, args: tokens.slice(2) };
  }
  const contract = AGGREGATE[head];
  return contract === undefined ? undefined : { contract, args: tokens.slice(1) };
}

/**
 * What a "this is not a verb" failure has to teach at the moment it fires.
 *
 * The two honest answers are both rewrites of the text, and neither is a new
 * exemption: a prose MENTION of the binding writes it as a bare
 * `` `{{wave-cli}}` `` (or names the subject in words), and a schematic
 * reference writes its verb as a placeholder (`<verb>`). A guard that instead
 * grew a file-and-line allowlist would cover the next real misgrip the day
 * someone added the wrong row to it.
 */
const NOT_A_VERB_TEACHING =
  'TWO ANSWERS ARE SANCTIONED, and adding an exemption to the guard is neither:\n' +
  '  (1) A PROSE MENTION NAMES THE BINDING, NOT A CALL. Write it as a bare `{{wave-cli}}` ' +
  'inside its own code span (the corpus convention — "read every `{{wave-cli}}` below as ' +
  'that one string"), or name the subject in words ("every engine-CLI call"). With nothing ' +
  'after the marker there is nothing to resolve, and that is the intended pass.\n' +
  '  (2) A SCHEMATIC REFERENCE USES A PLACEHOLDER VERB. `{{wave-cli}} <verb> …`, ' +
  '`{{wave-cli}} spine <op> …` and `{{wave-cli}} issue-store triage-*` all pass: a ' +
  '`<…>`/`${…}`/`[…]`/`*` token in the verb or op position names a class of verbs, ' +
  'not one verb.';

/** Every rule `invocation` breaks, in rule order. */
export function checkInvocation(invocation: FoundInvocation): InvocationViolation[] {
  const where = `${invocation.file}:${invocation.line}`;
  const resolved = contractFor(invocation.tokens);
  if (resolved === null) return [];
  if (resolved === undefined) {
    const head = invocation.tokens[0];
    const isGroup = (VERB_GROUPS as readonly string[]).includes(head);
    return [
      {
        file: invocation.file,
        line: invocation.line,
        rule: isGroup ? 'op' : 'verb',
        message: isGroup
          ? `${where}: \`${head} ${invocation.tokens[1]}\` — the verb group \`${head}\` declares no op \`${invocation.tokens[1]}\`.\n` +
            `    in: ${invocation.text}\n\n${NOT_A_VERB_TEACHING}`
          : `${where}: \`${head}\` is not a verb this engine declares.\n` +
            `    in: ${invocation.text}\n\n${NOT_A_VERB_TEACHING}`,
      },
    ];
  }

  const { contract, args } = resolved;
  const violations: InvocationViolation[] = [];
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (isElision(token)) continue;
    if (!token.startsWith('--')) {
      positionals++;
      continue;
    }
    const flag = flagContractForToken(contract, token);
    if (flag === undefined) {
      violations.push({
        file: invocation.file,
        line: invocation.line,
        rule: 'undeclared-flag',
        message:
          `${where}: \`${contract.verb}\` declares no flag \`${token}\`.\n` +
          `    declared: ${contract.flags.map((f) => f.canonical).join(' ')}\n` +
          `    in: ${invocation.text}`,
      });
      continue;
    }
    if (flag.canonical !== token) {
      violations.push({
        file: invocation.file,
        line: invocation.line,
        rule: 'alias',
        message:
          `${where}: \`${contract.verb} ${token}\` is an ALIAS — write \`${flag.canonical}\`.\n` +
          `    The engine still accepts \`${token}\` and always will (ADR-0051 decision 1 dates no\n` +
          `    removal), but a shipped invocation is one of the canonical mark's three carriers:\n` +
          '    the corpus teaches the spelling, so the corpus uses the canonical one.\n' +
          `    in: ${invocation.text}`,
      });
    }
    if (flag.value !== 'none') i++; // step OVER the value — never a flag
  }

  if (contract.twin !== undefined && contract.twin.length > 0 && positionals > 0) {
    violations.push({
      file: invocation.file,
      line: invocation.line,
      rule: 'twin-positional',
      message:
        `${where}: \`${contract.verb}\` was called with ${positionals} positional argument(s) — ` +
        `write the NAMED form: ${contract.twin.map((t) => t.flag).join(' ')}.\n` +
        '    The positional form survives as this verb\'s alias (ADR-0051 decision 6) and the\n' +
        '    engine still accepts it; the named form is the canonical one.\n' +
        `    in: ${invocation.text}`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

function walk(dir: string, predicate: (p: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

/** Every shipped file this guard reads, repo-relative. */
export function shippedInvocationFiles(): string[] {
  const files: string[] = [];
  for (const root of MARKDOWN_ROOTS) {
    const abs = join(CLONE_ROOT, root);
    if (!existsSync(abs)) continue;
    files.push(...walk(abs, (p) => p.endsWith('.md')));
  }
  const driverDir = join(CLONE_ROOT, DRIVER_DIR);
  if (existsSync(driverDir)) {
    files.push(...walk(driverDir, (p) => p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.cjs')));
  }
  return files.map((p) => relative(CLONE_ROOT, p));
}

/** Every invocation in the shipped corpus. */
function corpusInvocations(): FoundInvocation[] {
  return shippedInvocationFiles().flatMap((rel) =>
    extractInvocations(rel, readFileSync(join(CLONE_ROOT, rel), 'utf8')),
  );
}

describe('shipped invocations resolve to a Verb contract and spell it canonically', () => {
  it('the three subject trees are all present — the guard has something to read', () => {
    for (const root of MARKDOWN_ROOTS) {
      expect(existsSync(join(CLONE_ROOT, root)), `${root} must exist`).toBe(true);
    }
    expect(
      existsSync(join(CLONE_ROOT, DRIVER_DIR, 'wave-start-inflight.js')),
      'the shipped driver template must exist',
    ).toBe(true);
    // A guard that silently reads nothing is a guard that cannot fail. The
    // floor is deliberately well below the measured count (≈290 at the time of
    // writing) so ordinary editing never trips it, but far above zero.
    expect(corpusInvocations().length).toBeGreaterThan(100);
  });

  it('EVERY invocation in the skills, the agents and the shipped driver is canonical', () => {
    const violations = corpusInvocations().flatMap(checkInvocation);
    expect(
      violations.map((v) => v.message).join('\n\n'),
      `${violations.length} shipped invocation(s) do not resolve canonically`,
    ).toBe('');
  });

  it('the shipped driver composes BOTH write verbs in the canonical named form', () => {
    // The driver is the one subject whose invocation is composed rather than
    // written out, and it composes per KIND precisely so both spellings are
    // literals this guard can read (ADR-0051 decisions 5 and 6).
    const driver = readFileSync(join(CLONE_ROOT, DRIVER_DIR, 'wave-start-inflight.js'), 'utf8');
    expect(driver).toContain('write-report --report-file "${REPO_ROOT}/.flotilla/tmp/');
    expect(driver).toContain('write-verdict --verdict-file "${REPO_ROOT}/.flotilla/tmp/');
    expect(driver).toContain('--reports-dir "${dir}"');
    expect(driver).toContain('--verdicts-dir "${dir}"');
    // And the retired forms are gone from the composed call.
    const composed = extractInvocations('driver', driver).filter(
      (i) => i.tokens[0] === 'write-report' || i.tokens[0] === 'write-verdict',
    );
    expect(composed.length).toBe(2);
    for (const call of composed) expect(checkInvocation(call)).toEqual([]);
  });
});

describe('NEGATIVE CONTROLS — the guard is shown red on each of its rules', () => {
  /** Judge one planted line exactly as the corpus walk judges a real one. */
  const judge = (file: string, text: string): InvocationViolation[] =>
    extractInvocations(file, text).flatMap(checkInvocation);

  it('CONTROL 1 — a planted alias in a skill fails, naming file, line and canonical spelling', () => {
    const planted = [
      '# A skill file',
      '',
      '```bash',
      '{{wave-cli}} route-verdict --verdict approve --iteration 1 --risk mechanical --state reviewing',
      '```',
    ].join('\n');
    const violations = judge('.claude/skills/planted/SKILL.md', planted);
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('alias');
    expect(violations[0].file).toBe('.claude/skills/planted/SKILL.md');
    expect(violations[0].line).toBe(4);
    expect(violations[0].message).toContain('.claude/skills/planted/SKILL.md:4');
    expect(violations[0].message).toContain('`route-verdict --iteration` is an ALIAS');
    expect(violations[0].message).toContain('write `--iter`');
  });

  it('CONTROL 2 — a planted verb-level misgrip fails: `spine set-row-stat`', () => {
    const violations = judge(
      '.claude/skills/planted/SKILL.md',
      '{{wave-cli}} spine set-row-stat "$SPINE" "$ID" failed\n',
    );
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('op');
    expect(violations[0].message).toContain('the verb group `spine` declares no op `set-row-stat`');
    // And the real spelling it was a misgrip OF passes, so the control is
    // about the misgrip and not about the shape of the line.
    expect(judge('.claude/skills/planted/SKILL.md', '{{wave-cli}} spine set-row-state "$SPINE" "$ID" failed\n')).toEqual([]);
  });

  it('CONTROL 3 — a planted flag no contract declares fails, and lists what the verb does declare', () => {
    const violations = judge(
      '.claude/skills/planted/SKILL.md',
      '{{wave-cli}} merge-order --spine "$SPINE" --reverse\n',
    );
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('undeclared-flag');
    expect(violations[0].message).toContain('`merge-order` declares no flag `--reverse`');
    expect(violations[0].message).toContain('declared: --spine');
  });

  it('CONTROL 4 — a planted positional call of a named twin fails, naming the flags', () => {
    const violations = judge(
      '.claude/skills/planted/SKILL.md',
      '{{wave-cli}} verdict-acked "$VERDICTS" "$ID"\n',
    );
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('twin-positional');
    expect(violations[0].message).toContain('--verdicts-dir --id');
  });

  it('CONTROL 6 — the same alias in the `wave_cli` FUNCTION form fails, on every line that carries it', () => {
    // The shape iteration 1 of this guard read straight past, reproduced as its
    // own control so a marker dropped from INVOCATION_MARKERS can never again be
    // green. The fence is the corpus's real one: the binding is DEFINED on one
    // line and CALLED on the next, and only the call is an invocation.
    const planted = [
      '```bash',
      'wave_cli() { NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts "$@"; }',
      '',
      'wave_cli route-verdict --verdict approve --iteration 1 --risk mechanical --state reviewing',
      'wave_cli route-verdict --verdict approve --iteration 3 --risk mechanical --state reviewing \\',
      '  --ruling "Operator ruling — re-dispatch the Reviewer only."',
      '```',
    ].join('\n');
    const violations = judge('.claude/skills/wave-shared/reference/routing-mechanics.md', planted);
    // BOTH calls are reported, not just the first: the review that forced this
    // marker found one plant reported while two real ones sat in the same file.
    expect(violations.length).toBe(2);
    expect(violations.map((v) => v.rule)).toEqual(['alias', 'alias']);
    expect(violations.map((v) => v.line)).toEqual([4, 5]);
    for (const violation of violations) {
      expect(violation.file).toBe('.claude/skills/wave-shared/reference/routing-mechanics.md');
      expect(violation.message).toContain('`route-verdict --iteration` is an ALIAS');
      expect(violation.message).toContain('write `--iter`');
    }
    // The DEFINITION line above them is not an invocation and contributes nothing.
    expect(judge('.claude/skills/planted/SKILL.md', `${planted.split('\n')[1]}\n`)).toEqual([]);
  });

  it('CONTROL 5 — an unknown TOP-LEVEL verb fails, and the failure teaches the two rewrites', () => {
    const violations = judge('.claude/skills/planted/SKILL.md', '{{wave-cli}} route-tupple --spine "$SPINE"\n');
    expect(violations.length).toBe(1);
    expect(violations[0].rule).toBe('verb');
    expect(violations[0].message).toContain('`route-tupple` is not a verb this engine declares');
    expect(violations[0].message).toContain('A PROSE MENTION NAMES THE BINDING');
  });
});

describe('POSITIVE CONTROLS — what must keep passing', () => {
  const judge = (text: string): InvocationViolation[] =>
    extractInvocations('.claude/skills/positive/SKILL.md', text).flatMap(checkInvocation);

  it('placeholder tokens are VALUES, not flags — every shape the corpus uses passes', () => {
    expect(judge('{{wave-cli}} route-tuple --spine <spine-path> --id <id> --iter <n> \\\n  --report-file <p> --verdict-file <p> --anchor <sha> --config <cfg>\n')).toEqual([]);
    expect(judge('{{wave-cli}} spine set-row-state "$SPINE" "$ID" failed\n')).toEqual([]);
    expect(judge('{{wave-cli}} resume --spine "$SPINE" --reports-dir "$REPORTS" --verdicts-dir "$VERDICTS"\n')).toEqual([]);
    expect(judge('| `{{wave-cli}} route-verdict --verdict <approve\\|changes-requested> --iter <n> --risk <r> --state <s>` | JSON |\n')).toEqual([]);
  });

  it('a VALUE that looks like a flag is stepped over, never read as one', () => {
    // The live bug `scanArgs()` was written for: `args.includes('--wave')` read
    // a disclosure's free-prose `--text` as a mode switch.
    expect(judge('{{wave-cli}} spine add-disclosure "$SPINE" "$ID" --iter 1 --source worker --text "--wave and --dir are aliases"\n')).toEqual([]);
  });

  it('the `wave_cli` FUNCTION form is read as a call — and its definition and citations are not', () => {
    // Read as calls (the whole point of the third marker).
    expect(judge('wave_cli route-verdict --verdict approve --iter 1 --risk mechanical --state reviewing\n')).toEqual([]);
    expect(judge('wave_cli spine set-row-state "$SPINE" "$ID" pr-created\n')).toEqual([]);
    expect(judge('ACKED_JSON=$(wave_cli verdict-acked --verdicts-dir "$VERDICTS" --id "$ID")\n')).toEqual([]);
    // NOT read as calls: the binding named rather than called. Out of command
    // position on the right (`(` follows) or on the left (a word character
    // precedes) — `isCommandPosition`, the fourth not-an-invocation rule.
    expect(judge('wave_cli() { NODE_USE_ENV_PROXY=1 ./tools/wave/node_modules/.bin/tsx tools/wave/src/cli.ts "$@"; }\n')).toEqual([]);
    expect(judge('# The shape: wave_cli() { NODE_USE_ENV_PROXY=1 <engine.cli, verbatim> "$@"; }\n')).toEqual([]);
    expect(judge('**Bind it in the same Bash call.** `wave_cli()` is a shell function, and a shell function is session state.\n')).toEqual([]);
    expect(judge('Bind a function instead (`wave_cli() { … "$@"; }`) and iterate a real array\n')).toEqual([]);
    expect(judge('a longer identifier such as my_wave_cli route-verdict --iteration 1 is a different name\n')).toEqual([]);
  });

  it('a bare mention, a schematic verb, a schematic op and an elision are not invocations', () => {
    expect(judge('Read every `{{wave-cli}}` below as that one string.\n')).toEqual([]);
    expect(judge('`{{wave-cli}} <verb> …` for top-level verbs\n')).toEqual([]);
    expect(judge('`{{wave-cli}} spine <op> …` for spine verbs\n')).toEqual([]);
    expect(judge('`{{wave-cli}} issue-store triage-*` selects the configured store\n')).toEqual([]);
    expect(judge('`VERDICT_SECTION=$({{wave-cli}} render-verdict …)`\n')).toEqual([]);
  });

  it('a shell operator ends the invocation — what follows is another command', () => {
    expect(judge('`{{wave-cli}} issue-store flag "$ID" … | tee log`\n')).toEqual([]);
    expect(judge('{{wave-cli}} host-pr status --branch "$B" > pr-status.json\n')).toEqual([]);
  });

  it('an ENGINE-side alias stays legal — this rule is about the corpus, not the parser', () => {
    // The aggregate still declares every alias ADR-0051 keeps; the guard reads
    // them (that is how it recognises one) and never demands their removal.
    const aliasCarrying = Object.values(AGGREGATE).filter((c) =>
      c.flags.some((f) => (f.aliases ?? []).length > 0),
    );
    expect(aliasCarrying.length).toBeGreaterThan(0);
    for (const contract of aliasCarrying) {
      for (const flagContract of contract.flags) {
        for (const alias of flagContract.aliases ?? []) {
          expect(flagContractForToken(contract, alias)).toBe(flagContract);
        }
      }
    }
  });
});
