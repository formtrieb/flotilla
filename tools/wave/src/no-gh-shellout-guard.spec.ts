/**
 * no-gh-shellout-guard.spec.ts — the engine's structural immunity to the
 * sandboxed-`gh` failure, asserted instead of assumed.
 *
 * ## The finding this guard makes durable
 *
 * Under the Claude Code sandbox on macOS, a `gh` call placed in any NESTED
 * SHELL CONTEXT — a `for`/`while` body, a command substitution, a subshell, or
 * a `bash <file>` script — fails with
 * `tls: failed to verify certificate: x509: OSStatus -26276`, while the
 * identical call as a TOP-LEVEL SIMPLE COMMAND succeeds. Four controls narrow
 * it to the sandbox rather than to the network, the rate limit or TLS in
 * general: a single-iteration loop fails (not repetition), `curl` and
 * `git`-over-HTTPS pass in the identical nested form (not the network), and
 * the failing form passes with the sandbox off (the sandbox is the layer).
 *
 * The status code is deliberately NOT identified beyond its text. An earlier
 * revision of this comment asserted `OSStatus -26276` was
 * `errSecInternalComponent`; that is FALSE — Apple's shipped `SecBase.h`
 * defines `errSecInternalComponent = -2070`, and the literal `26276` occurs
 * nowhere in the macOS SDK at all (nearest documented neighbours:
 * `errSecNotSigner = -26267`, `errSecDecode = -26275`). The number places the
 * failure in the Security framework's error range and licenses nothing
 * further, so no constant is named for it — guessing a second one would
 * repeat the defect. Nothing here depends on the retraction: the conclusion
 * rests on the sandbox-off control arm, and `curl`, `git` and Node's `fetch`
 * are OBSERVED unaffected in the identical nested form rather than argued to
 * be. The full six-form / four-control measurement is recorded in
 * `docs/adr/0015-triage-is-a-tracker-agnostic-triage-facet.md`'s evidence
 * note, and the operator-facing invocation-form rule in
 * `.claude/skills/wave-shared/reference/convention-12-no-command-in-a-shell-variable.md`.
 *
 * **flotilla's engine is immune, and this file is why that stays true.** The
 * engine reaches its host through exactly two seams:
 *
 *   - **Node's `fetch`** — `adapters/github/github-http.ts` (`defaultGitHubHttp`)
 *     and `adapters/linear/linear-http.ts`. Node's `fetch` verifies against
 *     Node's own bundled CA store rather than reaching trust evaluation by the
 *     path `gh` uses, and was unaffected across the measurement.
 *   - **`git`, spawned argv-form** — the landing seam, the API factory,
 *     `files-drift`, `merge-order`, `worktree-cleanup`, `dor-gate`, `ff-guard`,
 *     `compose-driver`, `markdown-fs-store`. Measured passing inside the same
 *     nested form that fails `gh`.
 *
 * No engine module spawns `gh` at all — which is what makes every wave verb
 * immune, and what was asserted nowhere until this file. A guard, not a
 * config block: shipping a harness `sandbox.network` / `excludedCommands`
 * entry would re-couple a deliberately harness-agnostic engine to one harness
 * (CHARTER §4, ADR-0009).
 *
 * ## SCOPE — stated here and carried in the refusal message itself
 *
 * This guard polices **the engine's own sources**: every production TypeScript
 * module under `tools/wave/src/`, plus the shipped non-TypeScript assets
 * (`bin/`, `hooks/`, `driver/`). It **deliberately does not police consumer or
 * operator bash** — a skill's prose, a Coordinator's hand-typed command, a
 * script an operator authors and runs with `bash <file>`. That surface is
 * exactly where the exposure lives, and it is governed by a documented rule
 * (Convention 12's invocation-form section), not by a test: the engine cannot
 * see, gate, or lint the commands a human or an agent types at a terminal, and
 * a guard that pretended otherwise would be a false assurance.
 *
 * ## Why this is a SEMANTIC scan and never a text search
 *
 * A text search for `gh` in the engine's sources is not merely noisy, it is
 * unusable: `adapters/github/github-issues-store.ts` binds a local named `gh`
 * more than a dozen times (`const gh = await this.api.getIssue(n)`), and eight
 * other modules mention `gh` in prose explaining why they do NOT call it. So
 * the subject is a **child-process spawn**, resolved through the TypeScript
 * compiler API: a call counts only when its callee resolves — through the
 * import-alias chain — to an export of `node:child_process`. That is also what
 * keeps `/re/.exec(s)` out of the result set: `exec` IS a child-process
 * spawner name, and the engine calls `RegExp.prototype.exec` roughly thirty
 * times; only the declaration-file check tells the two apart.
 *
 * Family and idiom: `credential-discovery-drift.spec.ts` (the closest
 * precedent — same compiler-API scan, same alias resolution, same
 * dynamic-call-site allowlist with a staleness check in both directions),
 * `barrel-drift.spec.ts`, `sandbox-scaffold-guard.spec.ts` (whose permanent
 * in-spec positive/negative controls this file also copies). Spec-only: no new
 * runtime module, nothing shipped, nothing wired.
 *
 * ## What a wrapper does to this guard, and why that is still safe
 *
 * If a future module wrapped `execFileSync` in a helper (`runGit(args)`), a
 * `gh` call routed through that helper would present a non-literal program
 * argument at the real spawner. It does not slip through: it lands in the
 * DYNAMIC bucket, which must be explicitly allowlisted with a reason. The
 * guard's failure mode is "you must write down why", never silence.
 *
 * Path note: this file lives at `tools/wave/src/`, so `__dirname` is the
 * engine's own source root — the same anchor every guard in this family uses.
 */

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import ts from 'typescript';
import fastGlob from 'fast-glob';
import { describe, it, expect } from 'vitest';

// ─── the production module surface ───────────────────────────────────────────

const SRC_DIR = __dirname; // tools/wave/src
const WAVE_ROOT = resolve(SRC_DIR, '..'); // tools/wave
const TSCONFIG_PATH = join(WAVE_ROOT, 'tsconfig.json');

/**
 * Every PRODUCTION engine module: `src/**\/*.ts` minus specs and fixtures.
 * Specs are excluded deliberately — this very file spawns nothing, but sibling
 * specs DO spawn (`echo-guard.spec.ts` drives the real hook as a child
 * process), and holding test scaffolding to a production rule would be
 * backwards. Discovered fresh on every run, so a module added tomorrow is
 * scanned with nothing here to update.
 */
const PRODUCTION_RELATIVE_FILES = fastGlob
  .sync(['**/*.ts'], {
    cwd: SRC_DIR,
    ignore: ['**/*.spec.ts', '__fixtures__/**'],
  })
  .sort();

/** `./relative/module/path` (no `.ts`) — how the allowlists below spell a module. */
function moduleLabel(relativeFile: string): string {
  return './' + relativeFile.replace(/\.ts$/, '');
}

const MODULE_LABEL_TO_ABS_PATH = new Map<string, string>(
  PRODUCTION_RELATIVE_FILES.map((rel) => [moduleLabel(rel), join(SRC_DIR, rel)]),
);

// ─── the real production TS program ──────────────────────────────────────────

/** The repo's own tsconfig options — the same ones `npm run typecheck` uses. */
function compilerOptions(): ts.CompilerOptions {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `failed to read tsconfig.json at ${TSCONFIG_PATH}: ${configFile.error.messageText}`,
    );
  }
  return ts.parseJsonConfigFileContent(configFile.config, ts.sys, WAVE_ROOT).options;
}

const COMPILER_OPTIONS = compilerOptions();

/**
 * A compiler host rooted at `tools/wave`, optionally serving ONE extra file
 * from memory.
 *
 * The current-directory override is load-bearing and was found the hard way:
 * `ts.createCompilerHost` takes its current directory from `process.cwd()`,
 * which under this suite is the REPO root, not `tools/wave`. From there
 * `types: ["node"]` cannot find `tools/wave/node_modules/@types/node`, every
 * `node:child_process` import resolves to nothing, and `execFileSync` comes
 * back as the `unknown` symbol — so the guard would match zero call sites and
 * pass, silently, for the worst possible reason. Pinning the host's current
 * directory to `tools/wave` makes both programs resolve the same way no matter
 * where the process was started.
 *
 * **The tripwire for a regression here is the PERMANENT CONTROLS block at the
 * bottom of this file, not the non-vacuity test.** Measured, by deleting this
 * very line and running the spec: seven of the eight control tests fail
 * (`expected +0 to be 1`) — the fixture-read control, all four POSITIVE
 * controls, the four-planted-spawns count, and the DYNAMIC control — while the
 * non-vacuity test stays GREEN, because it counts globbed files and call sites
 * in the REAL program rather than resolved spawner symbols in the control
 * fixture. The NEGATIVE control ("the sanctioned `git` seam is not flagged")
 * also stays green, and vacuously so: nothing is flagged when nothing
 * resolves, which is precisely why a negative control can never be the
 * tripwire. Credit the assertions that actually fire, so a future reader
 * trusting this comment looks at the guard that would really catch them.
 */
function createHost(virtual?: { path: string; text: string }): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  host.getCurrentDirectory = () => WAVE_ROOT;
  if (!virtual) return host;

  const baseGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    if (fileName === virtual.path) {
      return ts.createSourceFile(fileName, virtual.text, languageVersionOrOptions, true);
    }
    return baseGetSourceFile.call(host, fileName, languageVersionOrOptions, onError, shouldCreate);
  };
  const baseFileExists = host.fileExists;
  host.fileExists = (fileName) =>
    fileName === virtual.path || baseFileExists.call(host, fileName);
  const baseReadFile = host.readFile;
  host.readFile = (fileName) =>
    fileName === virtual.path ? virtual.text : baseReadFile.call(host, fileName);
  return host;
}

function loadRealProgram(): { program: ts.Program; checker: ts.TypeChecker } {
  const program = ts.createProgram({
    rootNames: [...MODULE_LABEL_TO_ABS_PATH.values()],
    options: COMPILER_OPTIONS,
    host: createHost(),
  });
  return { program, checker: program.getTypeChecker() };
}

const { program: realProgram, checker: realChecker } = loadRealProgram();

// ─── spawner recognition ─────────────────────────────────────────────────────

/**
 * Every `node:child_process` export that starts a child process. `fork` is
 * included for completeness: it starts a Node module rather than a host CLI, so
 * it can never BE `gh`, but a `fork` appearing in the engine would still owe a
 * sanctioned-programs entry saying so.
 */
const SPAWNER_NAMES = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);

/**
 * The two spawners whose FIRST argument is a whole shell command line rather
 * than a program name. Everything else takes argv form: `(program, args[])`.
 */
const SHELL_LINE_SPAWNERS = new Set(['exec', 'execSync']);

/** Programs that are themselves a shell — their argv carries command lines. */
const SHELL_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
]);

/**
 * Resolve a symbol through any import/re-export alias chain to its original
 * declaration. Without it, `execFileSync` as imported into a call site is an
 * ALIAS symbol and would never be recognised. Cycle-guarded, as in
 * `barrel-drift.spec.ts` and `credential-discovery-drift.spec.ts`.
 */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let sym = symbol;
  let guard = 0;
  while ((sym.flags & ts.SymbolFlags.Alias) !== 0 && guard < 50) {
    const next = checker.getAliasedSymbol(sym);
    if (next === sym) break;
    sym = next;
    guard += 1;
  }
  return sym;
}

/**
 * The spawner name when this callee really is a `node:child_process` spawner,
 * else `null`. BOTH halves are load-bearing: the name filters out unrelated
 * functions, and the declaration-file check is the only thing separating
 * `child_process.exec` from the ~30 `RegExp.prototype.exec` calls the engine
 * makes.
 */
function spawnerNameOf(checker: ts.TypeChecker, callee: ts.Expression): string | null {
  const symbol = checker.getSymbolAtLocation(callee);
  if (!symbol) return null;
  const resolved = resolveAlias(checker, symbol);
  const name = resolved.getName();
  if (!SPAWNER_NAMES.has(name)) return null;
  const declaredInChildProcess = (resolved.getDeclarations() ?? []).some((d) =>
    /child_process\.d\.ts$/.test(d.getSourceFile().fileName),
  );
  return declaredInChildProcess ? name : null;
}

// ─── reading the command out of a call site ──────────────────────────────────

/**
 * The string an expression denotes, or `null` when it is not statically
 * knowable. Reads the TYPE, not the text, so a bare literal and an identifier
 * bound to `const X = 'git'` both resolve — the same rule
 * `credential-discovery-drift.spec.ts` uses for its credential names.
 */
function literalStringOf(checker: ts.TypeChecker, expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  const type = checker.getTypeAtLocation(expression);
  return type.isStringLiteral() ? type.value : null;
}

/** Every statically knowable element of an array-literal argument. */
function literalElementsOf(checker: ts.TypeChecker, argument: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(argument)) return [];
  const out: string[] = [];
  for (const element of argument.elements) {
    if (ts.isSpreadElement(element)) continue;
    const value = literalStringOf(checker, element);
    if (value !== null) out.push(value);
  }
  return out;
}

/** `{ shell: true }` (or any non-`false` `shell`) turns argv form into a shell line. */
function declaresShellOption(checker: ts.TypeChecker, args: readonly ts.Expression[]): boolean {
  for (const argument of args) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteralLike(property.name)
          ? property.name.text
          : null;
      if (name !== 'shell') continue;
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
      return true;
    }
  }
  return false;
}

/** Shell keywords and prefixes that sit BEFORE the command word in a segment. */
const NON_COMMAND_PREFIXES = new Set([
  'do',
  'done',
  'then',
  'else',
  'elif',
  'fi',
  'if',
  'while',
  'until',
  'for',
  'in',
  'case',
  'esac',
  '!',
  'time',
  'env',
  'exec',
  'command',
  'sudo',
  'nohup',
  'eval',
  '{',
  '}',
  '(',
  ')',
]);

/**
 * The command words a shell command line would run. Deliberately
 * OVER-approximating at the segment boundaries (it splits on every operator and
 * substitution opening that can start a new command) and deliberately
 * conservative about what counts as a command word (leading assignments and
 * shell keywords are skipped). A guard that over-approximates fails loudly and
 * is corrected; one that under-approximates is silent, which is the failure
 * mode this whole file exists to refuse.
 *
 * The engine's live tree reaches this function ZERO times — it spawns argv-form
 * only — so its behaviour is pinned entirely by the permanent controls below.
 */
function commandWordsOf(shellLine: string): string[] {
  const segments = shellLine.split(/\|\||&&|\$\(|[;|&\n()`{}]/);
  const words: string[] = [];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    for (const raw of tokens) {
      const token = raw.replace(/^['"]+/, '').replace(/['"]+$/, '');
      if (token.length === 0) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue; // VAR=value prefix
      if (NON_COMMAND_PREFIXES.has(token)) continue;
      words.push(basename(token));
      break; // the first real token of a segment is its command word
    }
  }
  return words;
}

/** One production child-process spawn. */
interface SpawnCallSite {
  /** `./adapters/github/github-api-factory` */
  modulePath: string;
  line: number;
  /** `execFileSync`, `spawnSync`, … */
  spawner: string;
  /** Source text of the first argument — what a reader greps for, and the allowlist key. */
  argumentText: string;
  /** The program's basename when statically knowable (argv form), else `null`. */
  program: string | null;
  /** Command words found in any shell-command-line position at this call. */
  shellCommandWords: string[];
  /** Whether anything about this call's command was statically knowable. */
  resolved: boolean;
}

function collectSpawnCallSites(
  program: ts.Program,
  checker: ts.TypeChecker,
  modules: Map<string, string>,
): SpawnCallSite[] {
  const sites: SpawnCallSite[] = [];

  for (const [label, absPath] of modules) {
    const sourceFile = program.getSourceFile(absPath);
    if (!sourceFile) {
      throw new Error(`source file not found in the TS program: ${absPath}`);
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments.length > 0) {
        const spawner = spawnerNameOf(checker, node.expression);
        if (spawner !== null) {
          const first = node.arguments[0];
          const firstLiteral = literalStringOf(checker, first);
          const shellLines: string[] = [];
          let programName: string | null = null;

          if (SHELL_LINE_SPAWNERS.has(spawner)) {
            if (firstLiteral !== null) shellLines.push(firstLiteral);
          } else {
            programName = firstLiteral === null ? null : basename(firstLiteral);
            if (firstLiteral !== null && declaresShellOption(checker, node.arguments)) {
              shellLines.push(firstLiteral);
            }
            const argvArgument = node.arguments[1];
            if (
              programName !== null &&
              SHELL_PROGRAMS.has(programName) &&
              argvArgument !== undefined
            ) {
              // `bash -c '<line>'` — the argv carries the command line.
              for (const element of literalElementsOf(checker, argvArgument)) {
                shellLines.push(element);
              }
            }
          }

          const shellCommandWords = shellLines.flatMap(commandWordsOf);
          sites.push({
            modulePath: label,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            spawner,
            argumentText: first.getText(sourceFile),
            program: programName,
            shellCommandWords,
            resolved: firstLiteral !== null,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return sites;
}

const SPAWN_CALL_SITES = collectSpawnCallSites(
  realProgram,
  realChecker,
  MODULE_LABEL_TO_ABS_PATH,
);

function formatSites(sites: SpawnCallSite[]): string {
  if (sites.length === 0) return '(none)';
  return sites
    .map((s) => `${s.modulePath}:${s.line} — ${s.spawner}(${s.argumentText}, …)`)
    .join('\n');
}

// ─── the offence, and the refusal it prints ──────────────────────────────────

/** `gh`, however it is spelled at a call site. */
function isGh(word: string): boolean {
  const bare = basename(word).toLowerCase();
  return bare === 'gh' || bare === 'gh.exe';
}

/** Every call site that spawns `gh` — argv-form program or shell command word. */
function ghSpawns(sites: SpawnCallSite[]): SpawnCallSite[] {
  return sites.filter(
    (s) =>
      (s.program !== null && isGh(s.program)) || s.shellCommandWords.some((w) => isGh(w)),
  );
}

/**
 * The refusal. It names the two sanctioned seams — because a role told "no"
 * and not told "instead, this" reaches for the next unsafe form — and it
 * states this guard's own scope, so nobody reads a green run as a promise
 * about consumer or operator bash.
 */
const REFUSAL =
  'An engine module spawns `gh` as a child process. Under the Claude Code sandbox on macOS ' +
  'a `gh` call in any nested shell context (a loop body, a command substitution, a subshell, ' +
  'a `bash <file>` script) fails with `x509: OSStatus -26276` while the identical top-level ' +
  'call succeeds — so a `gh` spawn inside the engine would fail depending on how the caller ' +
  'happened to be invoked. Use a SANCTIONED SEAM instead: (1) Node\'s `fetch`, through the ' +
  'adapter HTTP seam (`adapters/github/github-http.ts` / `adapters/linear/linear-http.ts`) — ' +
  'Node\'s own CA bundle, unaffected in every context; or (2) `git`, spawned argv-form ' +
  "(`execFileSync('git', [...])`) — measured passing inside the same nested form that fails " +
  '`gh`. Evidence: docs/adr/0015-triage-is-a-tracker-agnostic-triage-facet.md (evidence note) ' +
  'and wave-shared Convention 12 (invocation form). ' +
  'SCOPE: this guard polices the engine\'s own sources only — the production TypeScript ' +
  'modules under tools/wave/src/ plus the shipped bin/, hooks/ and driver/ assets. It ' +
  'deliberately does NOT police consumer or operator bash; that surface is governed by the ' +
  'documented invocation-form rule, not by this test.';

// ─── the sanctioned programs, and the dynamic-call-site allowlist ────────────

/**
 * Every program the engine is sanctioned to spawn, with the reason. Today the
 * list has one member, and that IS the finding: the engine's only child process
 * is `git`, and everything else goes over `fetch`.
 */
const SANCTIONED_PROGRAMS: Record<string, string> = {
  git: 'The local-repo seam. `git` is unaffected by the sandboxed-`gh` failure as a ' +
    'MEASURED fact, not an inferred one — it passed over HTTPS inside the identical ' +
    'nested form that fails `gh` (only a harmless `failed to store: 100001` ' +
    'keychain-WRITE warning). No mechanism is claimed for why; see this file\'s header ' +
    'on the retracted status-code identification. Used argv-form everywhere: no shell, ' +
    'no quoting hazard, no command line to nest.',
};

/**
 * Every production spawn whose command is deliberately NOT statically knowable,
 * keyed by module label then by the first argument's source text, with the
 * reason a reader needs in order to trust it instead of re-litigating it.
 *
 * A dynamic spawn is not automatically fine — it is precisely where a `gh`
 * could hide from this guard — so each one has to earn its exception.
 */
const DYNAMIC_SPAWN_ALLOWLIST: Record<string, Record<string, string>> = {
  './credential-resolver': {
    shell:
      'The ADR-0029 credential-lookup seam: `<VAR>_CMD` is a CONSUMER-supplied ' +
      'command run through the platform shell (`/bin/sh -c`, or ComSpec on Windows), ' +
      'because ADR-0029 rejected an argv whitespace-split — it breaks the quoting real ' +
      'lookup tools need (`op read "op://vault/item/field"`). The program is the shell, ' +
      'chosen at runtime by platform, and the command is the consumer\'s, so neither is ' +
      'knowable here BY DESIGN. This is also the one engine path that inherits the ' +
      'sandboxed-nested-context restriction: a consumer pointing `<VAR>_CMD` at a ' +
      'keychain-backed helper runs it as a child of a shell, which is exactly the nested ' +
      'context the measurement identified. That is a documented consumer-facing caveat ' +
      '(Convention 12, invocation form), not something this guard can fix — and it is ' +
      'not a `gh` spawn: the engine names no command here at all.',
  },
};

// ─── the shipped non-TypeScript assets ───────────────────────────────────────

/**
 * The engine's shipped JavaScript: the bin entrypoint, the two `PreToolUse`
 * hooks, and the composed-driver template. The TS program above cannot see
 * them, and they ARE engine sources — the driver in particular is a file the
 * harness executes. They spawn nothing at all today, so the honest assertion
 * over them is the stronger one: no child-process module is imported. Someone
 * who later needs a spawn there fails this and is sent to widen the semantic
 * scan rather than to slip past it.
 */
const SHIPPED_ASSET_FILES = fastGlob
  .sync(['bin/**/*.{js,cjs,mjs}', 'hooks/**/*.{js,cjs,mjs}', 'driver/**/*.{js,cjs,mjs}'], {
    cwd: WAVE_ROOT,
  })
  .sort();

/** `require('child_process')` / `from 'node:child_process'`, in either spelling. */
const CHILD_PROCESS_IMPORT = /(?:require\(\s*|from\s+)['"](?:node:)?child_process['"]/;

// ─── permanent controls (Convention 11), run through the SAME finder ─────────

/**
 * A planted source pushed through `collectSpawnCallSites` + `ghSpawns` — the
 * very functions the live assertions use — so "the check works" stays
 * distinguishable from "the check cannot fail" on EVERY run, not once by hand
 * in a PR description. The file is virtual: it is served from memory at a path
 * inside `src/`, so `node:child_process` resolves exactly as it does for a real
 * module, and nothing is ever written to the tree.
 */
const CONTROL_MODULE_LABEL = './__no-gh-guard-control__';
const CONTROL_VIRTUAL_PATH = join(SRC_DIR, '__no-gh-guard-control__.ts');

const CONTROL_SOURCE = [
  "import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';",
  '',
  '// NEGATIVE control — the sanctioned seam. Must NOT be flagged.',
  'export function sanctionedGit(): string {',
  "  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' });",
  '}',
  '',
  '// POSITIVE control 1 — the plain argv-form shell-out.',
  'export function plantedArgv(): string {',
  "  return execFileSync('gh', ['pr', 'create', '--fill'], { encoding: 'utf-8' });",
  '}',
  '',
  '// POSITIVE control 2 — a shell command line.',
  'export function plantedShellLine(): string {',
  '  return execSync(\'gh pr view 1 --json url\', { encoding: \'utf-8\' });',
  '}',
  '',
  '// POSITIVE control 3 — the exact nested form the measurement found failing.',
  'export function plantedNestedLoop(): void {',
  '  spawn(\'bash\', [\'-c\', \'for id in 1 2; do gh issue view "$id"; done\']);',
  '}',
  '',
  '// POSITIVE control 4 — an absolute path, so the basename read is exercised.',
  'export function plantedAbsolutePath(): string {',
  "  return spawnSync('/opt/homebrew/bin/gh', ['auth', 'status']).stdout?.toString() ?? '';",
  '}',
  '',
  '// DYNAMIC control — nothing statically knowable, the wrapper-shaped case.',
  'export function dynamicProgram(binary: string): void {',
  "  spawnSync(binary, ['--version']);",
  '}',
  '',
].join('\n');

function analyzeControlSource(): SpawnCallSite[] {
  const program = ts.createProgram({
    rootNames: [CONTROL_VIRTUAL_PATH],
    options: COMPILER_OPTIONS,
    host: createHost({ path: CONTROL_VIRTUAL_PATH, text: CONTROL_SOURCE }),
  });
  return collectSpawnCallSites(
    program,
    program.getTypeChecker(),
    new Map([[CONTROL_MODULE_LABEL, CONTROL_VIRTUAL_PATH]]),
  );
}

const CONTROL_SITES = analyzeControlSource();
const CONTROL_OFFENCES = ghSpawns(CONTROL_SITES);

// ─── the checks ──────────────────────────────────────────────────────────────

describe('no-`gh`-shellout guard — the engine reaches its host through `fetch` and `git`, never `gh`', () => {
  it('scans a realistic surface (a guard that matches nothing is green for the wrong reason)', () => {
    // Three halves, all of which must be non-vacuous: the module sweep must see
    // the engine, the spawner match must find real calls, and the shipped-asset
    // sweep must find the files it claims to police.
    expect(PRODUCTION_RELATIVE_FILES.length).toBeGreaterThanOrEqual(50);
    expect(SPAWN_CALL_SITES.length, formatSites(SPAWN_CALL_SITES)).toBeGreaterThanOrEqual(15);
    expect(SHIPPED_ASSET_FILES.length, SHIPPED_ASSET_FILES.join(', ')).toBeGreaterThanOrEqual(4);
  });

  it('THE GUARD: no engine module spawns `gh` as a child process', () => {
    const offences = ghSpawns(SPAWN_CALL_SITES);
    expect(offences, `${REFUSAL}\n\nOffending call sites:\n${formatSites(offences)}`).toEqual([]);
  });

  it('the shipped bin/, hooks/ and driver/ assets spawn nothing at all', () => {
    // These are engine sources the TypeScript program cannot see. They import no
    // child-process module today, which is a stronger statement than "no `gh`"
    // and a cheaper one to hold. A spawn added here must widen the semantic scan
    // above rather than land unwatched.
    const spawning = SHIPPED_ASSET_FILES.filter((rel) =>
      CHILD_PROCESS_IMPORT.test(readFileSync(join(WAVE_ROOT, rel), 'utf-8')),
    );
    expect(
      spawning,
      'These shipped engine assets now import a child-process module, and this guard\'s ' +
        'TypeScript scan cannot see them. Extend the scan to cover them (or, better, keep ' +
        'them spawn-free).\n' +
        REFUSAL,
    ).toEqual([]);
  });

  it('every program the engine spawns is a sanctioned seam, named with its reason', () => {
    const unsanctioned = SPAWN_CALL_SITES.filter(
      (s) => s.program !== null && !Object.hasOwn(SANCTIONED_PROGRAMS, s.program),
    );
    expect(
      unsanctioned,
      'These call sites spawn a program that is not on SANCTIONED_PROGRAMS. Adding one is ' +
        'a decision, not a formality: state why that binary is safe to spawn from every ' +
        'context the engine runs in.\n' +
        formatSites(unsanctioned),
    ).toEqual([]);
  });

  it('and every sanctioned program is still actually spawned (no stale entry)', () => {
    const spawned = new Set(
      SPAWN_CALL_SITES.map((s) => s.program).filter((p): p is string => p !== null),
    );
    const stale = Object.keys(SANCTIONED_PROGRAMS).filter((p) => !spawned.has(p));
    expect(stale, `stale SANCTIONED_PROGRAMS entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('every spawn whose command is not statically knowable is allowlisted with a reason', () => {
    const dynamic = SPAWN_CALL_SITES.filter((s) => !s.resolved);
    const unaccounted = dynamic.filter((s) => {
      const forModule = DYNAMIC_SPAWN_ALLOWLIST[s.modulePath];
      return !(forModule && Object.hasOwn(forModule, s.argumentText));
    });
    expect(
      unaccounted,
      'These call sites spawn a command this guard cannot read, so a `gh` could hide ' +
        'behind one. Each needs an entry in DYNAMIC_SPAWN_ALLOWLIST stating why that is ' +
        'correct:\n' +
        formatSites(unaccounted),
    ).toEqual([]);
  });

  it('every dynamic-allowlist entry names a call site that still exists (no stale entry)', () => {
    // A stale exception would silently absolve a FUTURE dynamic spawn that
    // happens to reuse the same module and argument spelling — the same
    // both-directions reconciliation the credential-discovery guard holds its
    // own allowlist to.
    const live = new Set(
      SPAWN_CALL_SITES.filter((s) => !s.resolved).map((s) => `${s.modulePath}#${s.argumentText}`),
    );
    const stale: string[] = [];
    for (const [mod, entries] of Object.entries(DYNAMIC_SPAWN_ALLOWLIST)) {
      for (const argument of Object.keys(entries)) {
        if (!live.has(`${mod}#${argument}`)) stale.push(`${mod}#${argument}`);
      }
    }
    expect(stale, `stale DYNAMIC_SPAWN_ALLOWLIST entries: ${stale.join(', ')}`).toEqual([]);
  });

  it("the refusal names both sanctioned seams and states this guard's own scope", () => {
    // The refusal is the whole teaching surface of a guard like this one: a
    // reader who trips it sees this text and nothing else.
    expect(REFUSAL).toContain('fetch');
    expect(REFUSAL).toContain('git');
    expect(REFUSAL).toContain('github-http.ts');
    expect(REFUSAL).toContain('OSStatus -26276');
    // …and the scope, in both directions: what it covers, and what it does not.
    expect(REFUSAL).toContain('tools/wave/src/');
    expect(REFUSAL).toMatch(/does NOT police consumer or operator bash/);
  });
});

describe('no-`gh`-shellout guard — permanent controls: the check is shown failing on every run', () => {
  it('the control fixture is read at all (its sanctioned `git` seam is found)', () => {
    const git = CONTROL_SITES.filter((s) => s.program === 'git');
    expect(git.length, formatSites(CONTROL_SITES)).toBe(1);
  });

  it('NEGATIVE control: the sanctioned `git` seam is not flagged', () => {
    expect(CONTROL_OFFENCES.map((s) => s.program)).not.toContain('git');
  });

  it('POSITIVE control: a plain `execFileSync(\'gh\', …)` is caught', () => {
    const caught = CONTROL_OFFENCES.filter(
      (s) => s.spawner === 'execFileSync' && s.program === 'gh',
    );
    expect(caught.length, formatSites(CONTROL_OFFENCES)).toBe(1);
  });

  it('POSITIVE control: `gh` inside a shell command line is caught', () => {
    const caught = CONTROL_OFFENCES.filter((s) => s.spawner === 'execSync');
    expect(caught.length, formatSites(CONTROL_OFFENCES)).toBe(1);
    expect(caught[0].shellCommandWords).toContain('gh');
  });

  it('POSITIVE control: `gh` in the nested loop body the measurement found failing is caught', () => {
    // `bash -c 'for id in 1 2; do gh issue view "$id"; done'` — the literal
    // shape of the failing form, so the controls cover the hazard as observed
    // and not only its tidiest spelling.
    const caught = CONTROL_OFFENCES.filter((s) => s.spawner === 'spawn');
    expect(caught.length, formatSites(CONTROL_OFFENCES)).toBe(1);
    expect(caught[0].shellCommandWords).toContain('gh');
  });

  it('POSITIVE control: an absolute-path `gh` is caught by basename', () => {
    const caught = CONTROL_OFFENCES.filter(
      (s) => s.spawner === 'spawnSync' && s.program === 'gh',
    );
    expect(caught.length, formatSites(CONTROL_OFFENCES)).toBe(1);
  });

  it('the four planted spawns are caught and nothing else is', () => {
    expect(CONTROL_OFFENCES.length, formatSites(CONTROL_OFFENCES)).toBe(4);
  });

  it('DYNAMIC control: an unreadable program lands in the dynamic bucket, not in silence', () => {
    const dynamic = CONTROL_SITES.filter((s) => !s.resolved);
    expect(dynamic.length, formatSites(CONTROL_SITES)).toBe(1);
    expect(dynamic[0].argumentText).toBe('binary');
    // It is NOT an offence — the guard cannot claim it spawns `gh` — but it is
    // also not invisible: on the real tree this bucket forces an allowlist
    // entry with a reason.
    expect(CONTROL_OFFENCES).not.toContain(dynamic[0]);
  });
});
