/**
 * compose-driver.ts — compose the Workflow dispatch driver from the spine, the
 * wave config and the IssueStore, instead of transcribing it by hand.
 *
 * ## What this replaces
 *
 * The dispatch script used to live as a fenced code block inside the wave-start
 * skill's `workflow-driver.md` reference document. Every wave, a Coordinator
 * extracted that fence, filled five compose-time constants and a per-row
 * `ISSUES` array into the copy by hand, and dispatched the result. That copy is
 * a COPY, so the document grew a compose-fresh-or-verify rule and a seeded
 * currency checklist to police it — and it drifted anyway: the fence named the
 * Reviewer agent by its bare definition name while an installed plugin
 * registers it namespaced, so a Coordinator that pasted verbatim had its
 * Stage-3 dispatch fail to resolve.
 *
 * The script now ships as a package asset (`driver/wave-start-inflight.js`) and
 * this module fills it in. There is no second copy left to go stale, so the
 * currency machinery retires with it.
 *
 * ## What this is NOT
 *
 * It is not a dispatch host. The engine calls no agent-harness primitive here:
 * it reads a template, substitutes constants, and writes a file. The HARNESS
 * runs that file, and the schema-validated-return guarantee — a dispatched
 * agent cannot silently fabricate a result — stays a property of the driver
 * script's own `agent({ schema })` calls (ADR-0009; the clarifying sentence
 * lives in the standing orientation and the charter).
 *
 * ## The two assertions that moved in
 *
 * {@link assertRequiredRowFields} and {@link assertDispatchableWorker} run HERE,
 * at compose time, over rows this module built. The template keeps its own
 * copies as the in-script backstop for a hand-edited script; the drift spec
 * pins those copies to {@link REQUIRED_ROW_FIELDS} and to the engine's
 * `HUMAN_GATED_WORKER`, so the two can no longer disagree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { IssueStore } from './adapters/issue-store';
import type { IssueView, TriageView } from './contract';
import { flag, printJson } from './cli-utils';
import { readDisclosures } from './spine-store';
import { loadWaveConfig, type WaveConfig } from './wave-config';
import { readSpine, HUMAN_GATED_WORKER } from './wave-md-rw';
import { verifyCommands, type VerifyCommand } from './verify';
import { resolveStore } from './cli-store';

// ─── The shipped template ─────────────────────────────────────────────────────

/**
 * The driver template's path inside the engine package. `driver/` is a package
 * asset directory (listed in `package.json`'s `files`, exactly as `hooks/` is),
 * so this resolves identically in this repo's source form and in a consumer's
 * `node_modules` install.
 */
export const DRIVER_TEMPLATE_PATH = resolve(__dirname, '..', 'driver', 'wave-start-inflight.js');

/**
 * The `engine.cli` substring that identifies flotilla's own SOURCE form. It is
 * the same discriminator the plugin/engine lockstep gate uses: a binding that
 * invokes the vendored TypeScript entry is this repo dogfooding itself; every
 * other binding is a consumer running the installed form (ADR-0032).
 */
export const SOURCE_FORM_ENGINE_CLI_MARKER = 'tools/wave/src/cli.ts';

/** The Worker value that means "a human co-pilots this in chat" — never an AFK dispatch. */
export const FOREGROUND_WORKER = 'foreground';

// ─── Row shape ────────────────────────────────────────────────────────────────

/**
 * One granted scope extension, projected from this row's `scope-extension`
 * disclosures in the spine (ADR-0041). The spine stays the sole durable record;
 * this is the compose-time READING of it, rebuilt on every compose.
 */
export interface ScopeGrant {
  paths: string[];
  reason: string;
  grantedAtIteration: number;
  disclosureRef: string;
}

/**
 * One `ISSUES` entry, exactly as the template's own per-row comment documents
 * it. `branch` is deliberately absent: the script derives it once from
 * `id` + `slug`, and a hand-authored second field is the shape that recurrence
 * took. {@link assertRequiredRowFields} is still run against the DERIVED value,
 * so the assertion covers the same set the script's own copy does.
 */
export interface DriverRow {
  id: string;
  slug: string;
  worker: string;
  risk: string;
  iteration: number;
  model: string;
  anchorSha: string;
  coordinatorBranch: string;
  depsSetup: string;
  issueSpec: string;
  scopeGrants?: Array<ScopeGrant | string>;
  prTitle: string;
  closePhrase: string;
  reviewerHints: string[];
  siblingBranches: string;
  iteration1HeadSha?: string;
}

/**
 * Every scalar field a composed row must carry before any `agent()` fan-out —
 * the single place the set is named, and the value the template's own
 * `REQUIRED_ROW_FIELDS` literal is pinned to.
 *
 * `branch` is on the list even though {@link DriverRow} does not declare it:
 * the derived value is what every brief interpolates, so the derived value is
 * what has to be checked. The deliberate exclusions (depsSetup,
 * iteration1HeadSha, reviewerHints, scopeGrants, iteration, worker) carry their
 * reasons in the template's own comment above the literal — worker in
 * particular because it asks a different question with a different remedy, and
 * gets {@link assertDispatchableWorker} instead of a slot here.
 */
export const REQUIRED_ROW_FIELDS = [
  'id',
  'slug',
  'branch',
  'risk',
  'model',
  'anchorSha',
  'coordinatorBranch',
  'issueSpec',
  'prTitle',
  'closePhrase',
  'siblingBranches',
] as const;

/**
 * A template renders a missing property as the LITERAL STRING `"undefined"` —
 * never a throw, never a blank. So an absent key is not the only shape worth
 * rejecting: `"undefined"` and an empty/whitespace-only string are the two
 * others a template can silently produce.
 */
export function isMissingField(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === 'undefined' ||
    String(value).trim() === ''
  );
}

/** Throw naming the row and the field if any {@link REQUIRED_ROW_FIELDS} entry is unusable. */
export function assertRequiredRowFields(row: Record<string, unknown>): void {
  for (const field of REQUIRED_ROW_FIELDS) {
    if (isMissingField(row[field])) {
      throw new Error(
        `compose-driver: row ${String(row.id)} has no valid ${field} ` +
          `(got ${JSON.stringify(row[field])}) — the row cannot be composed into ISSUES`,
      );
    }
  }
}

/**
 * Refuse a row no background agent may pick up. Two different refusals, kept
 * apart because their remedies differ: a human-gated row waits for a person
 * (ADR-0012), a `foreground` row is worked in chat. Neither is a wiring bug,
 * and neither belongs in a fan-out.
 */
export function assertDispatchableWorker(
  row: { id: string; worker: string },
  humanGatedWorkers: readonly string[] = [HUMAN_GATED_WORKER],
): void {
  if (humanGatedWorkers.includes(row.worker)) {
    throw new Error(
      `compose-driver: row ${row.id} has a human-gated worker (${row.worker}) and must not be ` +
        'dispatched — hold it in the human lane and leave it out of this compose',
    );
  }
  if (row.worker === FOREGROUND_WORKER) {
    throw new Error(
      `compose-driver: row ${row.id} has a ${FOREGROUND_WORKER} worker and must not be ` +
        'dispatched to a background agent — work it in chat and leave it out of this compose',
    );
  }
}

// ─── Small derivations ────────────────────────────────────────────────────────

/**
 * The branch formula, in one place. It MUST byte-match the Coordinator's own
 * `spine set-branch <spine> <id> wave/<id>-<slug>` call and the template's own
 * one-line derivation — all three read the same id + slug off one roster row.
 */
export function branchFor(id: string, slug: string): string {
  return `wave/${id}-${slug}`;
}

/** The heavier Risk classes, whose rows bind the heavy model tier for BOTH roles (ADR-0007). */
const HEAVY_RISKS = ['cross-feature-refactor', 'public-API-change'];

/** The default model tier for a Risk, used only when the spine records none. */
export function modelForRisk(risk: string): string {
  return HEAVY_RISKS.includes(risk) ? 'opus' : 'sonnet';
}

/**
 * The store-kind close phrase (wave-shared Convention 4). `markdown` takes the
 * GitHub spelling deliberately: the local markdown store is a dev/dogfood
 * tracker, but the PR it closes still lands on a code host that reads
 * `Closes #<n>`.
 */
export function closePhraseFor(storeKind: string, id: string): string {
  return storeKind === 'linear' ? `Fixes ${id}` : `Closes #${id}`;
}

/**
 * Strip the bare tracker ids a PR title may not carry (mention discipline,
 * wave-shared Convention 4). Deliberately NARROW: `#<digits>` tokens and the
 * row's own literal id, never a general `<TEAM>-<digits>` sweep — that shape
 * also matches `ADR-0041`, and a title-mangling default is worse than a title
 * the Coordinator overrides through `--row-meta`.
 */
export function stripBareIds(title: string, id: string): string {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(/#\d+/g, '')
    .replace(new RegExp(`(^|[\\s(\\[])${escaped}(?=$|[\\s):\\]—-])`, 'g'), '$1')
    .replace(/^[\s:—–-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True for a verify command that installs this consumer's dependency tree. */
const DEPS_SETUP_RE =
  /(?:^|[\s/])(?:npm|pnpm|yarn|bun)\s+(?:ci|install)\b|composer\s+install\b|bundle\s+install\b|pip\s+install\b|poetry\s+install\b|go\s+mod\s+download\b|cargo\s+fetch\b|mix\s+deps\.get\b/;

/**
 * The first verify command that installs dependencies, or `''` when the profile
 * declares none. A worktree carries tracked files only, so this is the FIRST
 * command every Worker and Reviewer runs; the template's own `|| <fallback>`
 * renders the empty case as "nothing gitignored here".
 */
export function depsSetupFrom(commands: readonly VerifyCommand[]): string {
  const hit = commands.find((c) => DEPS_SETUP_RE.test(c.command));
  return hit ? hit.command : '';
}

/**
 * Render one verify command's DECLARED NEEDS as data beside it (ADR-0049
 * decision 5) — the same way a scope grant travels in the brief rather than
 * being re-derived at the far end (ADR-0041).
 *
 * Both roles need it and for the same reason: the Reviewer independently re-runs
 * these exact commands and meets the identical wall, so it must have the same
 * data the Worker had. It is rendered as a fact about the command — what the
 * command must reach — and never as an instruction to go and get it.
 *
 * `''` for a command with no declaration, which is what keeps a needs-free
 * config composing byte-identically to how it did before the field existed.
 */
function renderVerifyNeeds(needs: VerifyCommand['needs']): string {
  if (!needs) return '';
  const parts: string[] = [];
  if (needs.writes?.length) {
    parts.push(`writes outside the worktree: ${needs.writes.map((p) => `\`${p}\``).join(', ')}`);
  }
  if (needs.network?.length) {
    parts.push(`network hosts: ${needs.network.map((h) => `\`${h}\``).join(', ')}`);
  }
  if (needs.host) {
    parts.push('host: a capability that cannot be narrowed to a path or a host — a daemon socket, a simulator, a device');
  }
  if (parts.length === 0) return '';
  return `  (declared needs — ${parts.join('; ')})`;
}

/** Render one verify command for the embedded spec, directory carried in the command. */
function renderVerifyCommand(cmd: VerifyCommand): string {
  const base = cmd.cwd
    ? `\`${cmd.command}\`  (the profile declares cwd \`${cmd.cwd}\` — carry it IN the command, never \`cd\` first)`
    : `\`${cmd.command}\``;
  return `${base}${renderVerifyNeeds(cmd.needs)}`;
}

// ─── The embedded issue spec ──────────────────────────────────────────────────

export interface IssueSpecInput {
  id: string;
  title: string;
  body: string;
  risk: string;
  worker: string;
  files: readonly string[];
  verify: readonly VerifyCommand[];
  /** An optional Coordinator note for THIS row, from `--row-meta`. */
  note?: string;
}

/**
 * The full spec a Worker and its Reviewer both read, embedded VERBATIM rather
 * than pointed at by id: the store config that would resolve an id may itself
 * be gitignored, and a worktree carries tracked files only.
 */
export function composeIssueSpec(input: IssueSpecInput): string {
  const parts: string[] = [];
  parts.push(`# ${input.title}`);
  parts.push('');
  parts.push(`Issue id (bare): ${input.id}`);
  parts.push(`Risk: ${input.risk}`);
  parts.push(`Worker: ${input.worker}`);
  parts.push('Declared Files globs — stay strictly inside these:');
  for (const glob of input.files.length ? input.files : ['(none declared)']) {
    parts.push(`- ${glob}`);
  }
  parts.push('');
  parts.push(input.body.trim());
  if (input.note && input.note.trim()) {
    parts.push('');
    parts.push('## Notes from the Coordinator (read before you start)');
    parts.push('');
    parts.push(input.note.trim());
  }
  parts.push('');
  parts.push(
    "## Verify gate (from this consumer's wave.config.json verify — run ALL of them, " +
      'regardless of which files you touched. Carry the directory IN each command, never `cd` first.)',
  );
  for (const cmd of input.verify) {
    parts.push(`- ${renderVerifyCommand(cmd)}`);
  }
  if (input.verify.length === 0) {
    parts.push('- (this consumer declares no verify profile matching this row\'s files)');
  }
  // The rule beside the data, and ONLY when there is data for it to be beside —
  // so a consumer that declares no needs anywhere composes exactly the spec it
  // composed before this field existed (ADR-0049).
  if (input.verify.some((cmd) => renderVerifyNeeds(cmd.needs) !== '')) {
    parts.push('');
    parts.push(
      'A command above carrying **declared needs** names what it must reach outside this worktree. ' +
        'A declaration is not a grant: if the sandbox refuses that command anyway, the need is declared ' +
        'but NOT provided. Report it as not run, with the refusal reason — never re-run it with the ' +
        'sandbox off, never widen your own permissions, and never drop it silently (ADR-0049).',
    );
  }
  return parts.join('\n');
}

// ─── The scope-grant projection ───────────────────────────────────────────────

/**
 * Project this row's `scope-extension`-dispositioned disclosures into the
 * template's `scopeGrants` shape (ADR-0041). Path extraction is deliberately
 * literal — backticked tokens that look like a path — and degrades to the
 * template's own STRING entry form when a disclosure states its paths in prose,
 * because `renderGrants` renders either.
 */
export function projectScopeGrants(
  spineSource: string,
  rowId: string,
): Array<ScopeGrant | string> {
  const out: Array<ScopeGrant | string> = [];
  for (const d of readDisclosures(spineSource)) {
    if (d.rowId !== rowId) continue;
    if (d.disposition !== 'scope-extension') continue;
    const paths = [...d.text.matchAll(/`([^`]+)`/g)]
      .map((m) => m[1])
      .filter((token) => token.includes('/') || token.includes('.'));
    if (paths.length === 0) {
      out.push(`\`${d.ref}\` (iteration ${d.iter ?? 1}, ${d.source}): ${d.text}`);
      continue;
    }
    out.push({
      paths,
      reason: d.text,
      grantedAtIteration: d.iter ?? 1,
      disclosureRef: d.ref,
    });
  }
  return out;
}

// ─── The Reviewer agent name ──────────────────────────────────────────────────

export interface ReviewerAgentResolution {
  /** The name a Stage-3 `agent({ agentType })` call must use where it runs. */
  name: string;
  /** How it was arrived at. */
  form: 'source' | 'installed' | 'override';
  /** The plugin manifest's own `name`, when one was read. */
  pluginName: string | null;
  /** The agent definition's frontmatter `name`, when one was read. */
  agentName: string | null;
  /** The manifest actually read, when one was. */
  manifestPath: string | null;
}

/** Read the `name:` out of an agent definition's YAML frontmatter. */
export function agentDefinitionName(source: string): string | null {
  const fm = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const line = fm[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^name\s*:\s*/, '').trim().replace(/^['"]|['"]$/g, '') || null;
}

export interface ReviewerAgentInput {
  /** `--reviewer-agent`, when the Coordinator names it outright. */
  override?: string;
  /** The consumer's configured `engine.cli` — the form discriminator. */
  engineCli: string;
  /** The plugin manifest to read, when one is available. */
  manifestPath: string | null;
  /** Injected reader so the resolution is testable without a plugin clone on disk. */
  readFileOrNull: (path: string) => string | null;
}

/**
 * Resolve the Reviewer agent's REGISTERED name for the form the skills are
 * running in — the gap that made a verbatim paste fail on the first
 * installed-form run.
 *
 * Both halves are READ, never spelled here: the agent's own name comes from the
 * agent definition's frontmatter, the namespace from the plugin manifest's
 * `name`. Which of the two shapes applies is the same ADR-0032 discriminator
 * the lockstep gate uses. An explicit override wins over both, and an installed
 * form with neither a manifest nor an override is a loud refusal rather than a
 * guessed spelling — the engine cannot know which clone the running skills came
 * from, so it is TOLD (the same division of labour `version --expect` draws).
 */
export function resolveReviewerAgent(input: ReviewerAgentInput): ReviewerAgentResolution {
  if (input.override && input.override.trim()) {
    return {
      name: input.override.trim(),
      form: 'override',
      pluginName: null,
      agentName: null,
      manifestPath: null,
    };
  }

  const form: 'source' | 'installed' = input.engineCli.includes(SOURCE_FORM_ENGINE_CLI_MARKER)
    ? 'source'
    : 'installed';

  const manifestRaw = input.manifestPath ? input.readFileOrNull(input.manifestPath) : null;
  if (manifestRaw === null) {
    throw new Error(
      'compose-driver: cannot derive the Reviewer agent name — no plugin manifest was readable at ' +
        `${input.manifestPath ?? '<none supplied>'}. Pass --plugin-manifest <path to the plugin ` +
        "clone's .claude-plugin/plugin.json>, or name the agent outright with --reviewer-agent <name>.",
    );
  }

  let manifest: { name?: unknown; agents?: unknown };
  try {
    manifest = JSON.parse(manifestRaw) as { name?: unknown; agents?: unknown };
  } catch (err) {
    throw new Error(
      `compose-driver: the plugin manifest at ${input.manifestPath} is not valid JSON — ` +
        `${(err as Error).message}`,
    );
  }
  const pluginName = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!pluginName) {
    throw new Error(
      `compose-driver: the plugin manifest at ${input.manifestPath} declares no "name" — ` +
        'the installed form needs it to namespace the Reviewer agent.',
    );
  }

  const pluginRoot = dirname(dirname(input.manifestPath as string));
  const declared = Array.isArray(manifest.agents)
    ? (manifest.agents as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  const candidates = declared.length
    ? declared
    : ['./.claude/agents/wave-reviewer.md'];

  let agentName: string | null = null;
  for (const rel of candidates) {
    const source = input.readFileOrNull(resolve(pluginRoot, rel));
    if (source === null) continue;
    const name = agentDefinitionName(source);
    if (name && name.endsWith('wave-reviewer')) {
      agentName = name;
      break;
    }
    if (name && agentName === null) agentName = name;
  }

  if (!agentName) {
    throw new Error(
      'compose-driver: cannot derive the Reviewer agent name — the plugin manifest at ' +
        `${input.manifestPath} names no readable agent definition carrying a frontmatter ` +
        '`name:`. Name the agent outright with --reviewer-agent <name>.',
    );
  }

  return {
    name: form === 'source' ? agentName : `${pluginName}:${agentName}`,
    form,
    pluginName,
    agentName,
    manifestPath: input.manifestPath,
  };
}

// ─── The substitution ─────────────────────────────────────────────────────────

/**
 * Index just past the balanced `open`/`close` region starting at or after
 * `from`, skipping string literals, template literals and comments so a bracket
 * inside prose (the template is dense with both) cannot unbalance the walk.
 */
function balancedEnd(src: string, from: number, open: string, close: string): number {
  const start = src.indexOf(open, from);
  if (start < 0) throw new Error(`compose-driver: no "${open}" found in the driver template`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const endC = src.indexOf('*/', i + 2);
      i = endC < 0 ? src.length : endC + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      for (; i < src.length; i++) {
        if (src[i] === '\\') {
          i++;
          continue;
        }
        if (src[i] === quote) break;
      }
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`compose-driver: unbalanced ${open}/${close} in the driver template`);
}

/** Replace a single-quoted placeholder constant with a real JSON-encoded value. */
function fillStringConst(src: string, name: string, value: string): string {
  const re = new RegExp(`^const ${name} = '[^']*'$`, 'm');
  if (!re.test(src)) {
    throw new Error(
      `compose-driver: the driver template has no \`const ${name} = '…'\` line to fill — ` +
        'the template and this composer have drifted.',
    );
  }
  return src.replace(re, () => `const ${name} = ${JSON.stringify(value)}`);
}

export interface ComposeDriverScriptInput {
  template: string;
  repoRoot: string;
  waveCli: string;
  reportsDir: string;
  verdictsDir: string;
  reviewerAgent: string;
  rows: DriverRow[];
}

/**
 * The whole substitution, and the only place the template is edited. Everything
 * outside the five constants and the `ISSUES` array is carried through
 * byte-for-byte — which is what makes "the composed script is the template with
 * its constants filled" a checkable claim rather than a hope.
 */
export function composeDriverScript(input: ComposeDriverScriptInput): string {
  let src = input.template;
  src = fillStringConst(src, 'REPO_ROOT', input.repoRoot);
  src = fillStringConst(src, 'WAVE_CLI', input.waveCli);
  src = fillStringConst(src, 'REPORTS_DIR', input.reportsDir);
  src = fillStringConst(src, 'VERDICTS_DIR', input.verdictsDir);
  src = fillStringConst(src, 'REVIEWER_AGENT', input.reviewerAgent);

  const needle = 'const ISSUES = ';
  const at = src.indexOf(needle);
  if (at < 0) {
    throw new Error(
      'compose-driver: the driver template has no `const ISSUES = [ … ]` array to fill — ' +
        'the template and this composer have drifted.',
    );
  }
  const arrayStart = at + needle.length;
  const arrayEnd = balancedEnd(src, arrayStart, '[', ']');
  return (
    src.slice(0, arrayStart) + JSON.stringify(input.rows, null, 2) + src.slice(arrayEnd)
  );
}

// ─── The CLI runner ───────────────────────────────────────────────────────────

/** The states a row must be in to be composed into this dispatch. */
const DISPATCHABLE_STATES = ['dispatched', 're-dispatched'];

/** Per-row Coordinator overrides, keyed by bare row id (`--row-meta`). */
export interface RowMeta {
  prTitle?: string;
  reviewerHints?: string[];
  note?: string;
  depsSetup?: string;
  siblingBranches?: string;
  iteration1HeadSha?: string;
  model?: string;
}

function usage(message: string): number {
  process.stderr.write(
    `error: ${message}\n` +
      'usage: flotilla-engine compose-driver --spine <spine> --out <path> --anchor <sha>\n' +
      '         [--config <path>] [--repo-root <dir>] [--reviewer-agent <name>]\n' +
      '         [--plugin-manifest <path>] [--coordinator-branch <b>] [--deps-setup <cmd>]\n' +
      '         [--row-meta <json|path>] [--template <path>] [--reports-dir <dir>] [--verdicts-dir <dir>]\n',
  );
  return 2;
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function parseRowMeta(value: string | undefined): Record<string, RowMeta> {
  if (value === undefined) return {};
  const raw = value.trim().startsWith('{') ? value : readFileOrNull(value);
  if (raw === null) {
    throw new Error(`compose-driver: --row-meta names neither inline JSON nor a readable file: ${value}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('compose-driver: --row-meta must be a JSON object keyed by bare row id');
  }
  return parsed as Record<string, RowMeta>;
}

/**
 * Verify the anchor resolves to a real commit in this checkout — folding in the
 * host-side gate that used to sit beside the compose step as a Coordinator
 * discipline. Presence is not resolvability: a well-formed but FABRICATED SHA
 * passes every field assertion and reaches every brief individually.
 */
function assertAnchorResolves(repoRoot: string, sha: string): void {
  try {
    execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${sha}^{commit}`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    throw new Error(
      `compose-driver: --anchor ${sha} does not resolve to a commit in ${repoRoot} — ` +
        're-derive it (git rev-parse HEAD at dispatch time) before composing.',
    );
  }
}

function currentBranch(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** The wave slug a spine path names — `<slug>.md` → `<slug>`. */
export function slugFromSpinePath(spinePath: string): string {
  const base = spinePath.split(/[\\/]/).pop() ?? spinePath;
  return base.replace(/\.md$/i, '');
}

/**
 * `compose-driver` — read the spine, the config and the store; write the
 * finished Workflow script; print one receipt.
 */
export async function runComposeDriver(
  args: string[],
  injected?: IssueStore,
): Promise<number> {
  const spinePath = flag(args, '--spine');
  const outPath = flag(args, '--out');
  const anchor = flag(args, '--anchor');
  if (!spinePath) return usage('compose-driver requires --spine <spine>');
  if (!outPath) return usage('compose-driver requires --out <path>');
  if (!anchor) return usage('compose-driver requires --anchor <sha>');

  const configPath = flag(args, '--config') ?? 'wave.config.json';
  let config: WaveConfig;
  try {
    config = loadWaveConfig(configPath);
  } catch (err) {
    process.stderr.write(`error: could not load --config ${configPath}: ${(err as Error).message}\n`);
    return 2;
  }

  const engineCli = config.engine?.cli?.trim() ?? '';
  if (!engineCli) {
    process.stderr.write(
      'error: compose-driver: the wave config declares no `engine.cli` binding. That is a STOP, ' +
        'not a cue to pick a spelling — wave-setup has not finished in this repo (ADR-0032).\n',
    );
    return 2;
  }

  const repoRoot = resolve(flag(args, '--repo-root') ?? process.cwd());
  const spineAbs = isAbsolute(spinePath) ? spinePath : resolve(repoRoot, spinePath);
  const slug = slugFromSpinePath(spineAbs);

  let spineSource: string;
  try {
    spineSource = readFileSync(spineAbs, 'utf8');
  } catch (err) {
    process.stderr.write(`error: could not read --spine ${spineAbs}: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    assertAnchorResolves(repoRoot, anchor);

    const templatePath = flag(args, '--template') ?? DRIVER_TEMPLATE_PATH;
    const template = readFileSync(templatePath, 'utf8');

    const manifestFlag = flag(args, '--plugin-manifest');
    const defaultManifest = join(repoRoot, '.claude-plugin', 'plugin.json');
    const manifestPath = manifestFlag ?? (existsSync(defaultManifest) ? defaultManifest : null);
    const reviewer = resolveReviewerAgent({
      override: flag(args, '--reviewer-agent'),
      engineCli,
      manifestPath,
      readFileOrNull,
    });

    const rowMeta = parseRowMeta(flag(args, '--row-meta'));
    const spine = readSpine(spineSource);
    const modelByRow = new Map<string, string>();
    for (const entry of spine.dispatchLog) {
      if (entry.id && entry.model) modelByRow.set(entry.id, entry.model);
    }

    const dispatchable = spine.planTable.filter((r) => DISPATCHABLE_STATES.includes(String(r.state)));
    if (dispatchable.length === 0) {
      process.stderr.write(
        `error: compose-driver: no row in ${spineAbs} is in a dispatchable state ` +
          `(${DISPATCHABLE_STATES.join(' | ')}) — flip the rows in-flight before composing.\n`,
      );
      return 1;
    }

    const coordinatorBranch =
      flag(args, '--coordinator-branch') ?? (currentBranch(repoRoot) || 'main');
    const globalDepsSetup = flag(args, '--deps-setup');
    const store = await resolveStore(args, injected);

    // Branches first: every row's `siblingBranches` is the OTHER rows' branches,
    // so the whole roster has to exist before any single row is composed.
    const roster = dispatchable.map((row) => {
      const branch = row.branch ?? '';
      const slugFromBranch = branch.startsWith(`wave/${row.id}-`)
        ? branch.slice(`wave/${row.id}-`.length)
        : '';
      return { row, branch, rowSlug: slugFromBranch };
    });

    const missingBranch = roster.filter((r) => !r.branch || !r.rowSlug);
    if (missingBranch.length > 0) {
      process.stderr.write(
        'error: compose-driver: no `wave/<id>-<slug>` branch is recorded for row(s) ' +
          `${missingBranch.map((r) => r.row.id).join(', ')} — run \`spine set-branch\` first ` +
          '(the dispatch WAL records the branch BEFORE the Worker spawns, ADR-0021).\n',
      );
      return 1;
    }

    const rows: DriverRow[] = [];
    for (const { row, branch, rowSlug } of roster) {
      const meta = rowMeta[row.id] ?? {};
      const view: IssueView = await store.read(row.id);
      const triage: TriageView = await store.readTriage(row.id);
      const verify = config.verify ? verifyCommands(view.files, config.verify) : [];
      const iteration = typeof row.iter === 'number' ? row.iter : Number(row.iter) || 1;
      const siblings = roster.filter((r) => r.row.id !== row.id).map((r) => r.branch);

      const composed: DriverRow = {
        id: row.id,
        slug: rowSlug,
        worker: view.worker,
        risk: view.risk,
        iteration,
        model: meta.model ?? modelByRow.get(row.id) ?? modelForRisk(view.risk),
        anchorSha: anchor,
        coordinatorBranch,
        depsSetup: meta.depsSetup ?? globalDepsSetup ?? depsSetupFrom(verify),
        issueSpec: composeIssueSpec({
          id: row.id,
          title: triage.title,
          body: triage.body,
          risk: view.risk,
          worker: view.worker,
          files: view.files,
          verify,
          note: meta.note,
        }),
        scopeGrants: projectScopeGrants(spineSource, row.id),
        prTitle: meta.prTitle ?? stripBareIds(triage.title, row.id),
        closePhrase: closePhraseFor(config.store.kind, row.id),
        reviewerHints: meta.reviewerHints ?? [],
        siblingBranches:
          meta.siblingBranches ??
          (siblings.length ? siblings.join(', ') : '(none — no sibling branches in this wave)'),
      };
      if (meta.iteration1HeadSha) composed.iteration1HeadSha = meta.iteration1HeadSha;

      assertDispatchableWorker(composed);
      assertRequiredRowFields({ ...composed, branch });
      rows.push(composed);
    }

    const script = composeDriverScript({
      template,
      repoRoot,
      waveCli: `NODE_USE_ENV_PROXY=1 ${engineCli}`,
      reportsDir: flag(args, '--reports-dir') ?? join(repoRoot, '.flotilla', 'waves', slug, 'reports'),
      verdictsDir: flag(args, '--verdicts-dir') ?? join(repoRoot, '.flotilla', 'waves', slug, 'verdicts'),
      reviewerAgent: reviewer.name,
      rows,
    });

    const outAbs = isAbsolute(outPath) ? outPath : resolve(repoRoot, outPath);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, script, 'utf8');

    printJson({
      ok: true,
      verb: 'compose-driver',
      out: outAbs,
      scriptBytes: Buffer.byteLength(script, 'utf8'),
      template: templatePath,
      templateBytes: statSync(templatePath).size,
      wave: slug,
      anchor,
      reviewerAgent: reviewer.name,
      reviewerAgentForm: reviewer.form,
      pluginName: reviewer.pluginName,
      waveCli: `NODE_USE_ENV_PROXY=1 ${engineCli}`,
      rows: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        branch: branchFor(r.id, r.slug),
        model: r.model,
        iteration: r.iteration,
        risk: r.risk,
        worker: r.worker,
        scopeGrants: (r.scopeGrants ?? []).length,
      })),
    });
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    return 1;
  }
}
