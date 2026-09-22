/**
 * import-graph-guard.spec.ts — the general acyclicity guard for the engine's
 * own module graph (issue #915).
 *
 * ## The gap this closes
 *
 * `load-order-drift.spec.ts` covers ONE cycle — `host-pr.ts` ↔
 * `adapters/bitbucket/bitbucket-api.ts`, accepted by ADR-0037 on the condition
 * that both crossing reads stay call-time-only — by importing those two
 * modules in both orders and reading the crossing bindings. It answers "does
 * THAT cycle still behave?" It cannot answer "is there a SECOND one?", because
 * it never looks at the graph; it looks at two files it was told about.
 *
 * Until this file existed, nothing in the suite looked at the graph. The
 * create-side acceptance-criteria row (#907) added a new one-way edge from
 * `adapters/issue-store.ts` to `adapters/body-codec.ts`, and its Reviewer
 * verified the acyclicity claim BY HAND — read the codec's import block, saw
 * the single type-only import of `../contract`, confirmed the call-time read
 * site. That verification was correct and it was also unrepeatable: the next
 * edge is caught by a reader who happens to look, or it is not caught.
 *
 * ## What a cycle actually costs here
 *
 * The engine ships as raw TypeScript under `"type": "commonjs"` (no build
 * step — CLAUDE.md §Conventions), so a consumer loads these modules through
 * CJS interop. A cycle of MODULE-EVALUATION-TIME edges means one side reads
 * the other's binding before that side has finished evaluating, and gets
 * `undefined` — not an error, not a crash, a silently wrong value baked in
 * under whichever load order arrived first. That is ADR-0034's
 * silent-failure class, and it is why this guard partitions edges by WHEN
 * they are read rather than treating every arrow the same:
 *
 *   - `value`    — a static `import`/`export … from` that survives to
 *                  runtime. Evaluated when the importing module is evaluated.
 *                  A cycle here is the dangerous one.
 *   - `type`     — `import type`, `export type … from`, an all-`type`
 *                  specifier list, or an `import('…')` in type position.
 *                  ERASED by the compiler; no runtime edge exists at all, so a
 *                  cycle of these cannot produce the class above.
 *   - `deferred` — a `require('…')` or a runtime `import('…')` inside a
 *                  function body or a guarded block. A real runtime edge, but
 *                  read at CALL time, after both modules have finished
 *                  evaluating — the same property ADR-0037 imposes on the
 *                  Bitbucket cycle by hand.
 *
 * Both graphs are checked. The evaluation-time graph (`value` only) is the
 * load-order-safety question; the full graph (all three kinds) is the
 * "is anything entangled at all" question. Every cycle either graph contains
 * must be named in {@link PERMITTED_CYCLES} with its reason — and the
 * comparison runs in BOTH directions, so a declaration whose cycle has since
 * been broken goes red too, rather than lingering as a stale exemption.
 *
 * ## What this guard deliberately does NOT do
 *
 * It does not restructure anything. The two cycles the graph contains today
 * are REPORTED, with their reasons and the mechanism that makes each safe —
 * not refactored away and not silently skipped. An acyclicity guard that
 * arrives by editing the graph it is about to measure has measured its own
 * edit.
 *
 * It is also not a layering guard: it says nothing about which module MAY
 * import which. `adapters/**` importing upward, `index.ts` re-exporting the
 * world, a CLI module reaching into an adapter — all pass here. The only
 * property is acyclicity, per edge class.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import fastGlob from 'fast-glob';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// ─── the scanned population ──────────────────────────────────────────────────

/** `tools/wave/src` — this spec sits in it, so `__dirname` IS the graph root. */
const SRC_ROOT = realpathSync(__dirname);

/** `tools/wave` — used only to resolve the `heldBy` paths the declarations cite. */
const WAVE_ROOT = resolve(SRC_ROOT, '..');

/**
 * Discovered dynamically through `fast-glob` — the same tool the engine itself
 * depends on and the same discovery `barrel-drift.spec.ts` uses, for the same
 * reason: a module added to `src/` tomorrow is scanned with nothing in this
 * file to update. Spec files and fixtures are out of the population; see
 * member 1 of the Unmodelled set.
 */
const NON_MODULE_GLOBS = ['**/*.spec.ts', '**/*.test.ts', '**/__fixtures__/**'];

// ─── the graph model ─────────────────────────────────────────────────────────

/** When the edge is read. See the header comment for what each one costs. */
type EdgeKind = 'value' | 'type' | 'deferred';

interface ImportEdge {
  /** Graph-root-relative, POSIX-separated: `adapters/body-codec.ts`. */
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  /** The specifier exactly as written: `'./body-codec'`. */
  readonly specifier: string;
  /** 1-based, so a failure message points at a line a reader can open. */
  readonly line: number;
  /** The statement's own source text, whitespace-collapsed and capped. */
  readonly text: string;
}

/**
 * A named non-verdict (ADR-0052). The guard read its subject and could not
 * place an edge it can see — it says so, by module, construct and detail, and
 * it never words that as a cycle finding.
 */
interface Abstention {
  readonly module: string;
  readonly construct: string;
  readonly detail: string;
}

interface ImportGraph {
  readonly root: string;
  /** Graph-root-relative labels, sorted. */
  readonly modules: readonly string[];
  readonly edges: readonly ImportEdge[];
  readonly abstentions: readonly Abstention[];
}

/** One strongly-connected component that is genuinely cyclic, plus one concrete path through it. */
interface GraphCycle {
  /** The component's members, sorted — this is the cycle's identity. */
  readonly members: readonly string[];
  /** A deterministic shortest closed walk through those members; every edge on it is named. */
  readonly path: readonly ImportEdge[];
}

// ─── the scanner ─────────────────────────────────────────────────────────────

const label = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');

const collapse = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 140 ? `${one.slice(0, 137)}…` : one;
};

/**
 * `import …` / `export … from …`. Type-only in three shapes, all of which the
 * compiler erases: the `type` keyword on the clause, an all-`type` specifier
 * list, and (for exports) the `type` keyword on the declaration. A MIXED list
 * — one value specifier beside any number of `type` ones — is a value edge,
 * because the value specifier survives to runtime and drags the whole module
 * evaluation with it.
 */
function staticEdgeKind(node: ts.ImportDeclaration | ts.ExportDeclaration): EdgeKind {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return 'value'; // bare side-effect import — the most eager edge there is
    if (clause.isTypeOnly) return 'type';
    if (clause.name) return 'value'; // a default binding is a value binding
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
      return bindings.elements.every((element) => element.isTypeOnly) ? 'type' : 'value';
    }
    return 'value'; // namespace import, or an empty list
  }
  if (node.isTypeOnly) return 'type';
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause) && clause.elements.length > 0) {
    return clause.elements.every((element) => element.isTypeOnly) ? 'type' : 'value';
  }
  return 'value'; // `export * from …`, or a namespace re-export
}

/**
 * The `moduleResolution: "bundler"` shapes this repo actually writes:
 * extensionless (`'./body-codec'`), a directory with an `index.ts`, and an
 * explicit path. Anything not starting with `.` is out of the graph by
 * construction — member 2 of the Unmodelled set.
 */
function resolveRelativeSpecifier(fromAbs: string, specifier: string): string | null {
  const base = resolve(dirname(fromAbs), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
  }
  return null;
}

/**
 * Whether `node` sits somewhere a `require()` call does NOT run unconditionally
 * at the point the module is first evaluated top-to-bottom — inside a function
 * body (only runs when later CALLED) or inside a guarded block: an
 * if/else/for/while/do/try/catch/switch arm (only runs when that branch is
 * taken). Walks the parent chain up to the `SourceFile`; the first
 * function-like or control-flow ancestor found settles it, so nesting depth
 * doesn't matter.
 *
 * This is the enclosing-scope check the header comment's `deferred` bullet
 * already promised ("inside a function body or a guarded block") and issue
 * #936 closes: without it, a `require()` sitting directly in a module's
 * top-level statement list — no function, no guard, as eager as a static
 * `import` — was read as `deferred` anyway, because "deferred" meant nothing
 * more than "not a static import".
 *
 * The engine's one real relative `require()` edge today
 * (`spine-cli.ts` → `cli.ts`) sits inside `if (require.main === module) { … }`
 * — a guarded block, not a function body — and this check keeps it classified
 * `deferred`, matching {@link PERMITTED_CYCLES}'s `heldBy` for that cycle.
 */
function isDeferredScope(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current) ||
      ts.isSwitchStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isDefaultClause(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/**
 * Parse every module in `rootDir` with the TypeScript compiler's own parser
 * and return the graph plus every place the reader could not reach a verdict.
 *
 * The parser rather than a regex on purpose: an import-shaped line inside a
 * template literal, a block comment or a string is not an import, and
 * `compose-driver.ts` ships driver-script text by the kilobyte. A regex reads
 * those as edges and can invent a cycle out of documentation; `createSourceFile`
 * cannot, because it knows the difference.
 */
function buildImportGraph(rootDir: string): ImportGraph {
  const root = realpathSync(rootDir);
  const moduleAbs = fastGlob
    .sync('**/*.ts', { cwd: root, ignore: NON_MODULE_GLOBS, absolute: true, onlyFiles: true })
    .map((path) => realpathSync(path))
    .sort();
  const inGraph = new Set(moduleAbs);
  const edges: ImportEdge[] = [];
  const abstentions: Abstention[] = [];

  for (const abs of moduleAbs) {
    const from = label(root, abs);
    const source = ts.createSourceFile(
      abs,
      readFileSync(abs, 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS,
    );

    // The guard's own broken invariant, ADR-0052 decision 3: a module whose
    // AST is not a faithful reading of its text. Open-world — not a construct
    // allowlist — and it contributes NO edges, because half a parse is a
    // graph that is not the one that ships.
    const parseDiagnostics =
      (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.length > 0) {
      abstentions.push({
        module: from,
        construct: 'module source',
        detail: `the TypeScript parser reported ${parseDiagnostics.length} syntax diagnostic(s); no edge was read from this module`,
      });
      continue;
    }

    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const record = (node: ts.Node, specifier: string, kind: EdgeKind, construct: string): void => {
      if (!specifier.startsWith('.')) return; // external package or node: builtin — out of the graph
      const target = resolveRelativeSpecifier(abs, specifier);
      if (target === null) {
        abstentions.push({
          module: from,
          construct,
          detail: `relative specifier ${JSON.stringify(specifier)} (line ${lineOf(node)}) resolves to no file on disk`,
        });
        return;
      }
      if (!inGraph.has(target)) {
        abstentions.push({
          module: from,
          construct,
          detail: `relative specifier ${JSON.stringify(specifier)} (line ${lineOf(node)}) resolves to ${label(root, target)}, which is outside the scanned module set`,
        });
        return;
      }
      edges.push({
        from,
        to: label(root, target),
        kind,
        specifier,
        line: lineOf(node),
        text: collapse(node.getText(source)),
      });
    };

    const abstain = (node: ts.Node, construct: string, detail: string): void => {
      abstentions.push({ module: from, construct, detail: `${detail} (line ${lineOf(node)})` });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          record(node, node.moduleSpecifier.text, staticEdgeKind(node), 'import declaration');
        } else {
          abstain(node, 'import declaration', 'the module specifier is not a string literal');
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          record(node, node.moduleSpecifier.text, staticEdgeKind(node), 're-export declaration');
        } else {
          abstain(node, 're-export declaration', 'the module specifier is not a string literal');
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (ts.isStringLiteral(expression)) {
          record(node, expression.text, 'value', 'import-equals declaration');
        } else {
          abstain(node, 'import-equals declaration', 'the module reference is not a string literal');
        }
      } else if (ts.isImportTypeNode(node)) {
        // `typeof import('./cli')` / `import('./x').Foo` — a TYPE position, erased.
        const argument = node.argument;
        if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
          record(node, argument.literal.text, 'type', 'import type node');
        } else {
          abstain(node, 'import type node', 'the module specifier is not a string literal');
        }
      } else if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        if (isDynamicImport || isRequire) {
          const construct = isDynamicImport ? 'dynamic import()' : 'require() call';
          const first = node.arguments[0];
          if (first && ts.isStringLiteral(first)) {
            // A dynamic import() is asynchronous regardless of where it sits —
            // it never blocks the importing module's own evaluation, so it
            // stays `deferred` unconditionally. A require() is synchronous:
            // only a `require()` that ALSO sits inside a function body or a
            // guarded block earns `deferred`; one sitting bare in a module's
            // top-level statement list is exactly as eager as a static
            // import, and #936 is what makes that distinction real instead of
            // asserted.
            const kind: EdgeKind = isDynamicImport || isDeferredScope(node) ? 'deferred' : 'value';
            record(node, first.text, kind, construct);
          } else {
            abstain(node, construct, 'the module specifier is not a string literal');
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);
  }

  return { root, modules: moduleAbs.map((abs) => label(root, abs)), edges, abstentions };
}

// ─── cycle detection ─────────────────────────────────────────────────────────

/** One edge per (from, to) pair for the selected kinds, deterministically chosen. */
function adjacencyFor(graph: ImportGraph, kinds: readonly EdgeKind[]): Map<string, ImportEdge[]> {
  const wanted = new Set<EdgeKind>(kinds);
  const byPair = new Map<string, ImportEdge>();
  for (const edge of graph.edges) {
    if (!wanted.has(edge.kind)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    const existing = byPair.get(key);
    if (!existing || edge.line < existing.line) byPair.set(key, edge);
  }
  const out = new Map<string, ImportEdge[]>();
  for (const node of graph.modules) out.set(node, []);
  const ordered = [...byPair.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  for (const edge of ordered) {
    let list = out.get(edge.from);
    if (!list) {
      list = [];
      out.set(edge.from, list);
    }
    list.push(edge);
  }
  return out;
}

/** Tarjan. 64 modules today; the recursion depth is bounded by the module count. */
function stronglyConnectedComponents(
  nodes: readonly string[],
  adjacency: Map<string, ImportEdge[]>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const connect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const edge of adjacency.get(v) ?? []) {
      const w = edge.to;
      if (!index.has(w)) {
        connect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      components.push(component.sort());
    }
  };

  for (const node of [...nodes].sort()) if (!index.has(node)) connect(node);
  return components;
}

/**
 * The shortest closed walk from `start` back to `start` staying inside
 * `members`, BFS over sorted adjacency so the answer is the same on every run
 * and on every machine. Every edge on that walk is returned — which is what
 * makes the rendered report name the path rather than just the pair.
 */
function representativeCycle(
  start: string,
  members: ReadonlySet<string>,
  adjacency: Map<string, ImportEdge[]>,
): ImportEdge[] {
  const arrivedBy = new Map<string, ImportEdge>();
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const edge of adjacency.get(node) ?? []) {
        if (!members.has(edge.to)) continue;
        if (edge.to === start) {
          const path = [edge];
          let cursor = node;
          while (cursor !== start) {
            const previous = arrivedBy.get(cursor)!;
            path.unshift(previous);
            cursor = previous.from;
          }
          return path;
        }
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        arrivedBy.set(edge.to, edge);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return [];
}

/** Every cycle in `graph` restricted to `kinds`, as SCCs with one concrete path each. */
function findCycles(graph: ImportGraph, kinds: readonly EdgeKind[]): GraphCycle[] {
  const adjacency = adjacencyFor(graph, kinds);
  const cycles: GraphCycle[] = [];
  for (const component of stronglyConnectedComponents(graph.modules, adjacency)) {
    const members = new Set(component);
    const selfEdge =
      component.length === 1 &&
      (adjacency.get(component[0]) ?? []).some((edge) => edge.to === component[0]);
    if (component.length < 2 && !selfEdge) continue;
    cycles.push({ members: component, path: representativeCycle(component[0], members, adjacency) });
  }
  return cycles.sort((a, b) => cycleKey(a).localeCompare(cycleKey(b)));
}

/**
 * A cycle's identity is its MEMBER SET, not the path chosen through it: a new
 * module joining an existing tangle changes the key and goes red, where a
 * path-keyed comparison could report the same string while the tangle grew.
 */
const cycleKey = (cycle: { readonly members: readonly string[] }): string =>
  [...cycle.members].sort().join(' + ');

const renderEdge = (edge: ImportEdge): string =>
  `${edge.from} --[${edge.kind}: ${JSON.stringify(edge.specifier)} @ line ${edge.line}]--> ${edge.to}`;

const renderCycle = (cycle: GraphCycle): string =>
  [`cycle over { ${cycle.members.join(', ')} }`, ...cycle.path.map((edge) => `    ${renderEdge(edge)}`)].join('\n');

const renderCycles = (cycles: readonly GraphCycle[]): string =>
  cycles.length === 0 ? '(none)' : cycles.map(renderCycle).join('\n');

const renderAbstentions = (abstentions: readonly Abstention[]): string =>
  abstentions.length === 0
    ? '(none)'
    : abstentions.map((a) => `  ${a.module} — ${a.construct}: ${a.detail}`).join('\n');

/** Reachability over the selected kinds — the one-way half of the adapter→codec check. */
function reachableFrom(graph: ImportGraph, start: string, kinds: readonly EdgeKind[]): string[] {
  const adjacency = adjacencyFor(graph, kinds);
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    for (const edge of adjacency.get(queue.shift()!) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      queue.push(edge.to);
    }
  }
  return [...seen].sort();
}

// ─── Guard declaration (ADR-0052) ────────────────────────────────────────────

/**
 * **Subject.** One structured text and nothing else: the `import` / `export …
 * from` / `import type` / `require()` / dynamic-`import()` statements of every
 * non-spec `.ts` file under `tools/wave/src`, read through the TypeScript
 * compiler's own parser ({@link buildImportGraph}). Relative specifiers only,
 * resolved to files in that same set. Nothing here opens a module's BODY, and
 * nothing here type-checks: an edge is a written specifier, not a used symbol.
 *
 * **Resolution bias — BLOCKS.** Every shape this reader cannot place fails the
 * suite as a named Abstention rather than quietly dropping out of the graph
 * ({@link Abstention}, asserted empty in the "abstains on nothing" block
 * below). Three trigger it, and all three are the guard's OWN broken
 * invariant rather than a construct allowlist (ADR-0052 decision 3): a module
 * whose parse reports a syntax diagnostic, a relative specifier that resolves
 * to no file, and a module specifier that is not a string literal.
 *
 * That direction is chosen for THIS subject because of what a dropped edge
 * costs. The verdict is acyclicity — a property of the WHOLE graph, where one
 * unread edge is exactly the one that closes the loop. A guard that resolves
 * an unreadable module toward passing reports "acyclic" about a graph that is
 * not the one that ships, in the vocabulary of a guard that checked. The thing
 * it would be hiding is ADR-0034's silent class: a cycle of evaluation-time
 * edges yields `undefined`, not an exception, under whichever load order
 * arrives first. A red `npm test` in front of the author is cheap; that is
 * not. On today's graph all three triggers measure EMPTY — a tripwire, not a
 * workload.
 *
 * One branch resolves toward passing and it is a DECIDED pass, not a
 * non-verdict: a specifier that does not start with `.` is not resolved at all
 * (member 2 below). An external package cannot import an engine module back,
 * so it cannot be on a cycle — that is the subject's boundary, not a shape the
 * reader failed to parse.
 *
 * **Unmodelled set, named rather than assumed away.**
 *
 *  1. **Spec files and fixtures** ({@link NON_MODULE_GLOBS}). They are leaves:
 *     nothing non-spec imports a spec (the same observation
 *     `barrel-drift.spec.ts` relies on for its root-name narrowing), they are
 *     excluded from the published package (`package.json` `files`:
 *     `!src/**\/*.spec.ts`), and a cycle that only exists once the test runner
 *     has loaded a spec reaches no consumer. The exclusion is not assumed
 *     safe: a module that DID import a spec file resolves outside the scanned
 *     set and is reported as an Abstention, with a control below.
 *  2. **Non-relative specifiers.** `node:*` builtins, `fast-glob`,
 *     `micromatch`, `typescript` and every other package are not nodes. See
 *     the decided-pass paragraph above.
 *  3. **Conditional and dead edges.** An `import` inside a branch that never
 *     runs, a `require()` behind a feature flag, a re-export of a symbol
 *     nobody uses — all are edges here. This reader counts what is WRITTEN;
 *     it does not evaluate, tree-shake, or ask whether a binding is used.
 *  4. **`require.resolve()` and every other path-shaped call.** Only a call
 *     whose callee is the bare identifier `require`, or the `import` keyword,
 *     is an edge. `require.resolve('./x')` is a property access, produces no
 *     edge, and is not an Abstention either — it locates a file without
 *     loading it. The engine writes none today.
 *  5. **Whether a call-time read is genuinely call-time.** For the ADR-0037
 *     cycle that condition is the whole safety argument, and it is
 *     `load-order-drift.spec.ts`'s subject, not this one. This guard sees an
 *     edge; that one loads both modules in both orders and reads the crossing
 *     bindings. Neither substitutes for the other, which is why the
 *     declaration below cites it as the cycle's `heldBy`.
 *
 *     (Formerly a member here: whether a `require()` sits inside a function
 *     body or a guarded block rather than bare at module top level. Closed by
 *     issue #936 — {@link isDeferredScope} makes that check real, so a
 *     `require()` reachable unconditionally at module-evaluation time is now
 *     classified `value`, not `deferred`. The one deferred edge in the graph
 *     today, `spine-cli.ts` → `cli.ts`, sits inside `if (require.main ===
 *     module)` and stays `deferred`; {@link PERMITTED_CYCLES} still records it
 *     by hand.)
 *  6. **One representative path per component.** A strongly-connected
 *     component with several distinct cycles through it renders ONE of them —
 *     the deterministic shortest walk from its lexicographically smallest
 *     member. The component's MEMBER SET is the identity that is compared, so
 *     nothing about the tangle can change without changing the verdict; but
 *     the printed path is an example, not an enumeration.
 *  7. **Module resolution beyond three shapes.** `paths` mappings, `exports`
 *     conditions, `.js`-suffixed specifiers and case-insensitive filesystems
 *     are not modelled; {@link resolveRelativeSpecifier} tries the literal
 *     path, `+ '.ts'` and `/index.ts`. Anything else is an Abstention, which
 *     is the blocking direction, not a silent miss.
 */

// ─── the declared permitted cycles ───────────────────────────────────────────

interface PermittedCycle {
  /**
   * `evaluation-time` — present in the `value`-only graph, and therefore in
   * the full graph too. `full` — present only once `type`/`deferred` edges are
   * counted.
   */
  readonly graph: 'evaluation-time' | 'full';
  /** The component's members, exactly as the scanner labels them. */
  readonly members: readonly string[];
  /** Why the cycle exists. */
  readonly reason: string;
  /** The property that keeps it out of the silent-`undefined` class. */
  readonly condition: string;
  /** Where that property is enforced or made visible — a real path, checked below. */
  readonly heldBy: string;
  /** The decision record that settled it. */
  readonly citation: string;
}

/**
 * Every cycle the engine's graph is allowed to contain, each with the reason a
 * reader needs in order to trust it rather than re-litigate it. Nothing is
 * skipped silently: a cycle absent from this list fails, and an entry whose
 * cycle no longer exists fails too.
 */
const PERMITTED_CYCLES: readonly PermittedCycle[] = [
  {
    graph: 'evaluation-time',
    members: ['adapters/bitbucket/bitbucket-api.ts', 'host-pr.ts'],
    reason:
      'host-pr.ts imports BITBUCKET_EMAIL_VAR and bitbucketCreateCreds from the Bitbucket adapter; ' +
      'the adapter imports AutoMergeUnavailableError and DEFAULT_MERGE_METHOD back. An adapter-owned ' +
      'canonical fact is imported, not re-spelled — the alternative was two spellings of the same ' +
      'constant drifting apart.',
    condition:
      'both crossing reads stay CALL-TIME-ONLY — inside function bodies and default parameters, ' +
      'never at module evaluation. A top-level read across either edge resolves to undefined under ' +
      'whichever load order arrives first.',
    heldBy: 'src/load-order-drift.spec.ts',
    citation: 'ADR-0037',
  },
  {
    graph: 'full',
    members: ['cli.ts', 'spine-cli.ts'],
    reason:
      'cli.ts statically imports runSpine from spine-cli.ts for its `spine` case; spine-cli.ts ' +
      'forwards its own direct-module invocation back to cli.ts so `tsx spine-cli.ts <op>` stays a ' +
      'working alias with exactly one dispatch path in the engine instead of two (issue #77).',
    condition:
      'the back edge is a require(), not a static import, and it sits behind ' +
      '`if (require.main === module)` — it runs only when spine-cli.ts is the process entrypoint, ' +
      'after its own exports are fully initialised. The evaluation-time graph therefore does not ' +
      'contain this cycle at all, which is why it is declared against the full graph.',
    heldBy: 'src/spine-cli.ts',
    citation: 'issue #77, and the comment above the require in spine-cli.ts',
  },
];

const declaredKeys = (graph: PermittedCycle['graph'] | 'any'): string[] =>
  PERMITTED_CYCLES.filter((entry) => graph === 'any' || entry.graph === graph)
    .map((entry) => cycleKey(entry))
    .sort();

/**
 * The verdict, in both directions at once.
 *
 * `undeclared` — a cycle the graph contains that nothing in
 * {@link PERMITTED_CYCLES} accounts for. The regression this guard exists for.
 *
 * `stale` — a declaration whose cycle is gone. Just as much a defect: an
 * exemption nobody can retire is an exemption nobody re-reads, and the next
 * reader takes it for a live constraint. Leaving it also re-arms the hole,
 * because a future cycle over the same members would land pre-approved.
 */
function reconcileAgainstDeclaration(
  found: readonly GraphCycle[],
  declared: readonly string[],
): { undeclared: string[]; stale: string[] } {
  const foundKeys = new Set(found.map(cycleKey));
  const declaredSet = new Set(declared);
  return {
    undeclared: [...foundKeys].filter((key) => !declaredSet.has(key)).sort(),
    stale: [...declaredSet].filter((key) => !foundKeys.has(key)).sort(),
  };
}

// ─── the real graph, built once for this file ────────────────────────────────

const realGraph = buildImportGraph(SRC_ROOT);
const evaluationTimeCycles = findCycles(realGraph, ['value']);
const fullGraphCycles = findCycles(realGraph, ['value', 'type', 'deferred']);

const edgeBetween = (from: string, to: string): ImportEdge[] =>
  realGraph.edges.filter((edge) => edge.from === from && edge.to === to);

// ─── the population and the non-verdict channel ──────────────────────────────

describe('import-graph guard — the population it reads', () => {
  it('discovers every non-spec engine module and no spec file', () => {
    expect(realGraph.modules.length).toBeGreaterThan(50);
    expect(realGraph.modules.filter((module) => module.endsWith('.spec.ts'))).toEqual([]);
    // A handful of known members, spread across the tree, so a discovery that
    // silently stopped at the top level cannot pass this.
    for (const expected of [
      'index.ts',
      'contract.ts',
      'host-pr.ts',
      'adapters/body-codec.ts',
      'adapters/issue-store.ts',
      'adapters/bitbucket/bitbucket-api.ts',
      'adapters/conformance/issue-store-conformance.ts',
      'adapters/github/github-issues-store.ts',
      'adapters/linear/linear-issues-store.ts',
    ]) {
      expect(realGraph.modules).toContain(expected);
    }
  });

  it('reads edges of all three kinds, so no classification arm is dead', () => {
    const byKind = (kind: EdgeKind): number => realGraph.edges.filter((edge) => edge.kind === kind).length;
    expect(byKind('value')).toBeGreaterThan(100);
    expect(byKind('type')).toBeGreaterThan(20);
    expect(byKind('deferred')).toBeGreaterThan(0);
  });

  it('abstains on nothing in the current graph — the tripwire, not a workload (ADR-0052)', () => {
    // An Abstention is a statement about the READER, never a finding about the
    // graph: it says a shape could not be placed, and the declared bias is
    // that such a shape fails rather than vanishing from the edge set.
    expect(
      renderAbstentions(realGraph.abstentions),
      `the import-graph reader could not place the following, so the acyclicity verdict below would ` +
        `be about a graph that is not the one that ships:\n${renderAbstentions(realGraph.abstentions)}`,
    ).toBe('(none)');
  });
});

// ─── AC3: type-only vs value classification, on real examples ────────────────

describe('import-graph guard — edge classification (type-only vs value vs deferred)', () => {
  it('classifies a real `import type` as type-only: adapters/body-codec.ts → contract.ts', () => {
    const edges = edgeBetween('adapters/body-codec.ts', 'contract.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('type');
    expect(edges[0].specifier).toBe('../contract');
    expect(edges[0].text).toContain('import type');
  });

  it('classifies a real value import as value: adapters/issue-store.ts → adapters/body-codec.ts', () => {
    const edges = edgeBetween('adapters/issue-store.ts', 'adapters/body-codec.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('value');
    expect(edges[0].specifier).toBe('./body-codec');
    expect(edges[0].text).toContain('assertAcceptanceCriteriaShape');
  });

  it('classifies an all-`type` specifier list as type-only: index.ts → types.ts', () => {
    // `export { type SchemaValidation } from './types'` — the inline-`type`
    // spelling, erased exactly like the keyword spelling above.
    const edges = edgeBetween('index.ts', 'types.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('type');
    expect(edges[0].text).toContain('type SchemaValidation');
  });

  it('classifies a MIXED specifier list as value: adapters/markdown-fs-store.ts → header-parser.ts', () => {
    // `import { createHeaderParser, …, type HeaderBlock } from '../header-parser'`.
    // One value specifier is enough: the module is evaluated at import time
    // whatever else is on the list.
    const edges = edgeBetween('adapters/markdown-fs-store.ts', 'header-parser.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('value');
    expect(edges[0].text).toContain('type HeaderBlock');
  });

  it('classifies per STATEMENT, not per module pair: markdown-fs-store.ts → contract.ts carries both kinds', () => {
    const kinds = edgeBetween('adapters/markdown-fs-store.ts', 'contract.ts')
      .map((edge) => edge.kind)
      .sort();
    expect(kinds).toEqual(['type', 'value']);
  });

  it('classifies a real require() as deferred: spine-cli.ts → cli.ts', () => {
    const deferred = edgeBetween('spine-cli.ts', 'cli.ts').filter((edge) => edge.kind === 'deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0].text).toContain("require('./cli')");
    // …and the forward edge is a plain static value import, which is what
    // makes this pair a cycle in the full graph and not in the other one.
    expect(edgeBetween('cli.ts', 'spine-cli.ts').map((edge) => edge.kind)).toEqual(['value']);
  });
});

// ─── require() enclosing-scope classification (issue #936) ───────────────────

describe('import-graph guard — require() enclosing-scope classification (issue #936)', () => {
  it('AC1: a bare top-level require() — no function, no guard — is classified `value`, not `deferred`', () => {
    // Exactly the hazard the header comment names: as eager as a static
    // import, and now read as one.
    withFixtureGraph(
      {
        'a.ts': "const b = require('./b');\nexport { b };\n",
        'b.ts': 'export const b = 1;\n',
      },
      (graph) => {
        const edges = graph.edges.filter((edge) => edge.from === 'a.ts' && edge.to === 'b.ts');
        expect(edges).toHaveLength(1);
        expect(edges[0].kind).toBe('value');
        expect(edges[0].text).toContain("require('./b')");
        expect(graph.abstentions).toEqual([]);
      },
    );
  });

  it('AC2: a require() inside a function body is still classified deferred', () => {
    withFixtureGraph(
      {
        'a.ts': "export function load() {\n  const b = require('./b');\n  return b;\n}\n",
        'b.ts': 'export const b = 1;\n',
      },
      (graph) => {
        const edges = graph.edges.filter((edge) => edge.from === 'a.ts' && edge.to === 'b.ts');
        expect(edges).toHaveLength(1);
        expect(edges[0].kind).toBe('deferred');
      },
    );
  });

  it('AC2: a require() inside a guarded block (an if-statement) at module top level is still classified deferred', () => {
    // The shape of the engine's one real deferred edge, reproduced as a
    // fixture: guarded, not inside a function, and still safe — the same
    // "function body OR a guarded block" the header comment names.
    withFixtureGraph(
      {
        'a.ts': "if (require.main === module) {\n  const b = require('./b');\n  void b;\n}\n",
        'b.ts': 'export const b = 1;\n',
      },
      (graph) => {
        const edges = graph.edges.filter((edge) => edge.from === 'a.ts' && edge.to === 'b.ts');
        expect(edges).toHaveLength(1);
        expect(edges[0].kind).toBe('deferred');
      },
    );
  });

  it('AC2: the engine\'s one real deferred edge (spine-cli.ts → cli.ts) still classifies deferred after the fix', () => {
    // Same assertion as the "classifies a real require() as deferred" case
    // above, restated here as this issue's own regression pin: the fix must
    // not reclassify the one edge it was explicitly built not to disturb.
    const deferred = edgeBetween('spine-cli.ts', 'cli.ts').filter((edge) => edge.kind === 'deferred');
    expect(deferred).toHaveLength(1);
    expect(deferred[0].text).toContain("require('./cli')");
    // It sits inside `if (require.main === module)`, a guarded block — not a
    // function body — which is exactly the shape `isDeferredScope` has to
    // recognize for this pin to hold, confirmed at source rather than assumed.
    const source = readFileSync(join(SRC_ROOT, 'spine-cli.ts'), 'utf8');
    expect(source).toContain('if (require.main === module) {');
    expect(source).toMatch(/if \(require\.main === module\) \{\s*\n\s*const \{ main \} = require\('\.\/cli'\)/);
  });

  it('AC3 negative control: a cycle closed through a bare top-level require() makes the evaluation-time assertion fail', () => {
    // Before this fix, `b.ts`'s back edge would have been read `deferred` and
    // this cycle would never have reached the evaluation-time graph at all —
    // exactly the hazard the Gap describes as "currently theoretical". This
    // control makes it concrete rather than described.
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'b.ts': "const a = require('./a');\nexport { a };\n",
      },
      (graph) => {
        const forward = graph.edges.filter((edge) => edge.from === 'a.ts' && edge.to === 'b.ts');
        const back = graph.edges.filter((edge) => edge.from === 'b.ts' && edge.to === 'a.ts');
        expect(forward.map((edge) => edge.kind)).toEqual(['value']);
        // The fix, isolated: this back edge is `value` now, where the
        // pre-#936 reader would have read it `deferred` and hidden the cycle
        // from the evaluation-time graph entirely.
        expect(back.map((edge) => edge.kind)).toEqual(['value']);

        const cycles = findCycles(graph, ['value']);
        expect(cycles.map(cycleKey)).toEqual(['a.ts + b.ts']);

        // Run through the SAME reconciliation the two real acyclicity
        // assertions call: an empty declaration list reports this cycle as
        // UNDECLARED — the fail state the guard's evaluation-time assertion
        // exists to produce.
        expect(reconcileAgainstDeclaration(cycles, [])).toEqual({
          undeclared: ['a.ts + b.ts'],
          stale: [],
        });
      },
    );
  });
});

// ─── AC1 / AC5 / AC7: the verdict ────────────────────────────────────────────

describe('import-graph guard — acyclicity', () => {
  it('the evaluation-time graph contains exactly the cycles declared permitted', () => {
    expect(
      reconcileAgainstDeclaration(evaluationTimeCycles, declaredKeys('evaluation-time')),
      `evaluation-time (static value import) cycles found:\n${renderCycles(evaluationTimeCycles)}\n\n` +
        `An UNDECLARED cycle here is the silent-undefined class (ADR-0034): whichever module is ` +
        `entered second reads the first's not-yet-assigned bindings. Either break it, or declare it ` +
        `in PERMITTED_CYCLES with the property that keeps it safe. A STALE entry means the cycle it ` +
        `names is gone — retire the entry rather than leaving a pre-approval behind.`,
    ).toEqual({ undeclared: [], stale: [] });
  });

  it('the full graph contains exactly the cycles declared permitted, counting type and deferred edges', () => {
    expect(
      reconcileAgainstDeclaration(fullGraphCycles, declaredKeys('any')),
      `full-graph cycles found (value + type + deferred):\n${renderCycles(fullGraphCycles)}`,
    ).toEqual({ undeclared: [], stale: [] });
  });

  it('reports the ADR-0037 cycle by naming every edge on the path, not just the pair (AC1)', () => {
    const cycle = evaluationTimeCycles.find(
      (candidate) => cycleKey(candidate) === 'adapters/bitbucket/bitbucket-api.ts + host-pr.ts',
    );
    expect(cycle, `evaluation-time cycles:\n${renderCycles(evaluationTimeCycles)}`).toBeDefined();
    const rendered = renderCycle(cycle!);
    // Both edges, each with its direction, its kind and the specifier as written.
    expect(rendered).toContain(
      'adapters/bitbucket/bitbucket-api.ts --[value: "../../host-pr"',
    );
    expect(rendered).toContain(
      '--[value: "./adapters/bitbucket/bitbucket-api"',
    );
    expect(cycle!.path).toHaveLength(2);
    expect(cycle!.path.map((edge) => edge.from)).toEqual([
      'adapters/bitbucket/bitbucket-api.ts',
      'host-pr.ts',
    ]);
    expect(cycle!.path.map((edge) => edge.to)).toEqual([
      'host-pr.ts',
      'adapters/bitbucket/bitbucket-api.ts',
    ]);
  });

  it('every permitted cycle carries a reason, a condition, a citation and a heldBy that exists (AC5)', () => {
    expect(PERMITTED_CYCLES.length).toBeGreaterThan(0);
    for (const entry of PERMITTED_CYCLES) {
      expect(entry.members.length, cycleKey(entry)).toBeGreaterThan(0);
      expect(entry.reason.length, `${cycleKey(entry)} — reason`).toBeGreaterThan(80);
      expect(entry.condition.length, `${cycleKey(entry)} — condition`).toBeGreaterThan(40);
      expect(entry.citation.length, `${cycleKey(entry)} — citation`).toBeGreaterThan(0);
      // The cited holder is a real file, so a declaration cannot go on citing
      // a guard that was deleted.
      expect(existsSync(join(WAVE_ROOT, entry.heldBy)), `${cycleKey(entry)} — heldBy ${entry.heldBy}`).toBe(true);
      // And every member is a module the scanner actually found.
      for (const member of entry.members) expect(realGraph.modules).toContain(member);
    }
  });

  it('the rendered path of each permitted cycle stays inside its declared members', () => {
    for (const cycle of fullGraphCycles) {
      const members = new Set(cycle.members);
      expect(cycle.path.length, renderCycle(cycle)).toBeGreaterThan(0);
      for (const edge of cycle.path) {
        expect(members.has(edge.from), renderCycle(cycle)).toBe(true);
        expect(members.has(edge.to), renderCycle(cycle)).toBe(true);
      }
    }
  });
});

// ─── AC4: the adapter→codec edge the create-side guard introduced ────────────

describe('import-graph guard — the adapters/issue-store.ts → adapters/body-codec.ts edge (#907)', () => {
  it('exists, as a single value edge importing the shared entry-shape rule', () => {
    const edges = edgeBetween('adapters/issue-store.ts', 'adapters/body-codec.ts');
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('value');
    expect(edges[0].specifier).toBe('./body-codec');
  });

  it('is ONE-WAY: the codec has no edge of any kind back to the issue-store module', () => {
    expect(edgeBetween('adapters/body-codec.ts', 'adapters/issue-store.ts')).toEqual([]);
  });

  it('is one-way TRANSITIVELY: nothing reachable from the codec reaches the issue-store module', () => {
    // The strong form. A direct-edge check would pass while a two-hop path
    // back through a third module quietly closed the loop.
    const reachable = reachableFrom(realGraph, 'adapters/body-codec.ts', ['value', 'type', 'deferred']);
    expect(reachable, `reachable from adapters/body-codec.ts: ${reachable.join(', ')}`).not.toContain(
      'adapters/issue-store.ts',
    );
    // Today that closure is a single type-only hop, which is the fact the #907
    // Reviewer verified by hand and this pins mechanically.
    expect(reachable).toEqual(['contract.ts']);
  });

  it('puts neither module on any cycle, in either graph', () => {
    for (const cycles of [evaluationTimeCycles, fullGraphCycles]) {
      for (const cycle of cycles) {
        expect(cycle.members, renderCycle(cycle)).not.toContain('adapters/body-codec.ts');
        expect(cycle.members, renderCycle(cycle)).not.toContain('adapters/issue-store.ts');
      }
    }
  });
});

// ─── AC2 + Convention 11: permanent controls, through the SAME functions ─────

/**
 * Every control below builds a REAL directory of REAL `.ts` files and pushes
 * it through {@link buildImportGraph} and {@link findCycles} — the same two
 * functions every assertion above runs on. A control that re-implemented the
 * predicate would prove the control works, which is not the question.
 */
function withFixtureGraph<T>(files: Record<string, string>, body: (graph: ImportGraph) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'import-graph-guard-'));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const abs = join(dir, relativePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents, 'utf8');
    }
    return body(buildImportGraph(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('import-graph guard — controls (Convention 11: the check is shown failing)', () => {
  it('NEGATIVE control: an acyclic fixture graph yields no cycles in either graph', () => {
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = b;\n",
        'b.ts': "import type { C } from './c';\nexport const b: C = 1;\n",
        'c.ts': 'export type C = number;\n',
      },
      (graph) => {
        expect(graph.abstentions).toEqual([]);
        expect(findCycles(graph, ['value'])).toEqual([]);
        expect(findCycles(graph, ['value', 'type', 'deferred'])).toEqual([]);
      },
    );
  });

  it('POSITIVE control: a seeded two-module value cycle is found, and the report names BOTH edges', () => {
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'b.ts': "import { a } from './a';\nexport const b = () => a;\n",
      },
      (graph) => {
        const cycles = findCycles(graph, ['value']);
        expect(cycles.map(cycleKey)).toEqual(['a.ts + b.ts']);
        const rendered = renderCycle(cycles[0]);
        expect(rendered).toContain('a.ts --[value: "./b" @ line 1]--> b.ts');
        expect(rendered).toContain('b.ts --[value: "./a" @ line 1]--> a.ts');
        expect(cycles[0].path).toHaveLength(2);
      },
    );
  });

  it('POSITIVE control: a seeded three-module cycle names every edge on the path, in order', () => {
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'b.ts': "import { c } from './c';\nexport const b = () => c;\n",
        'c.ts': "import { a } from './a';\nexport const c = () => a;\n",
        // A fourth module that depends on the tangle without joining it.
        'd.ts': "import { a } from './a';\nexport const d = a;\n",
      },
      (graph) => {
        const cycles = findCycles(graph, ['value']);
        expect(cycles.map(cycleKey)).toEqual(['a.ts + b.ts + c.ts']);
        expect(cycles[0].path.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
          'a.ts->b.ts',
          'b.ts->c.ts',
          'c.ts->a.ts',
        ]);
        expect(renderCycle(cycles[0]).split('\n')).toHaveLength(4);
      },
    );
  });

  it('POSITIVE control: a seeded SELF-import is a cycle of one', () => {
    withFixtureGraph({ 'a.ts': "import { x } from './a';\nexport const x = 1;\nexport const y = x;\n" }, (graph) => {
      const cycles = findCycles(graph, ['value']);
      expect(cycles.map(cycleKey)).toEqual(['a.ts']);
      expect(renderCycle(cycles[0])).toContain('a.ts --[value: "./a" @ line 1]--> a.ts');
    });
  });

  it('a seeded TYPE-ONLY cycle is absent from the evaluation-time graph and present in the full one', () => {
    // The classification is load-bearing, not decorative: erased edges cannot
    // produce the undefined-at-evaluation class, and treating them as if they
    // could would force a refactor that buys nothing.
    withFixtureGraph(
      {
        'a.ts': "import type { B } from './b';\nexport type A = B | null;\n",
        'b.ts': "import type { A } from './a';\nexport type B = A extends null ? number : string;\n",
      },
      (graph) => {
        expect(findCycles(graph, ['value'])).toEqual([]);
        expect(findCycles(graph, ['value', 'type', 'deferred']).map(cycleKey)).toEqual(['a.ts + b.ts']);
      },
    );
  });

  it('a seeded DEFERRED cycle is absent from the evaluation-time graph and present in the full one', () => {
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b();\n",
        'b.ts': "export const b = () => require('./a');\n",
      },
      (graph) => {
        expect(findCycles(graph, ['value'])).toEqual([]);
        const full = findCycles(graph, ['value', 'type', 'deferred']);
        expect(full.map(cycleKey)).toEqual(['a.ts + b.ts']);
        expect(renderCycle(full[0])).toContain('b.ts --[deferred: "./a"');
      },
    );
  });

  it('a seeded mixed-kind cycle is caught in the full graph even when no single kind closes it alone', () => {
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = b;\n",
        'b.ts': "import type { C } from './c';\nexport const b: C = 1;\n",
        'c.ts': "export type C = number;\nexport const reload = () => require('./a');\n",
      },
      (graph) => {
        expect(findCycles(graph, ['value'])).toEqual([]);
        expect(findCycles(graph, ['type'])).toEqual([]);
        expect(findCycles(graph, ['deferred'])).toEqual([]);
        expect(findCycles(graph, ['value', 'type', 'deferred']).map(cycleKey)).toEqual([
          'a.ts + b.ts + c.ts',
        ]);
      },
    );
  });

  it('ABSTAINS, by name, on a relative specifier that resolves to nothing — and invents no edge', () => {
    withFixtureGraph({ 'a.ts': "import { gone } from './gone';\nexport const a = gone;\n" }, (graph) => {
      expect(graph.edges).toEqual([]);
      expect(graph.abstentions).toHaveLength(1);
      expect(graph.abstentions[0].module).toBe('a.ts');
      expect(graph.abstentions[0].construct).toBe('import declaration');
      expect(graph.abstentions[0].detail).toContain('resolves to no file on disk');
      // The declared bias: this is what the real-graph assertion above asserts
      // against, so an unplaceable specifier fails rather than disappearing.
      expect(renderAbstentions(graph.abstentions)).not.toBe('(none)');
    });
  });

  it('ABSTAINS, by name, on an import that leaves the scanned module set — the spec-file exclusion is checked, not assumed', () => {
    withFixtureGraph(
      {
        'a.ts': "import { helper } from './helper.spec';\nexport const a = helper;\n",
        'helper.spec.ts': 'export const helper = 1;\n',
      },
      (graph) => {
        expect(graph.modules).toEqual(['a.ts']);
        expect(graph.edges).toEqual([]);
        expect(graph.abstentions).toHaveLength(1);
        expect(graph.abstentions[0].detail).toContain('outside the scanned module set');
      },
    );
  });

  it('ABSTAINS, by name, on a module the parser cannot read — and reads no edge out of it', () => {
    withFixtureGraph(
      {
        'broken.ts': "import { b } from './b';\nexport const oops = (((;\n",
        'b.ts': 'export const b = 1;\n',
      },
      (graph) => {
        expect(graph.abstentions).toHaveLength(1);
        expect(graph.abstentions[0].module).toBe('broken.ts');
        expect(graph.abstentions[0].construct).toBe('module source');
        expect(graph.abstentions[0].detail).toContain('syntax diagnostic');
        // The edge it could have read is NOT in the graph: a half-parsed
        // module contributes nothing, and the Abstention is the answer.
        expect(graph.edges).toEqual([]);
      },
    );
  });

  it('ABSTAINS, by name, on a require() whose specifier is not a literal', () => {
    withFixtureGraph(
      { 'a.ts': 'export const load = (name: string) => require(name);\n' },
      (graph) => {
        expect(graph.edges).toEqual([]);
        expect(graph.abstentions).toHaveLength(1);
        expect(graph.abstentions[0].construct).toBe('require() call');
        expect(graph.abstentions[0].detail).toContain('not a string literal');
      },
    );
  });

  it('reads an import-shaped line inside a template literal or a comment as PROSE, not as an edge', () => {
    // The reason this guard parses rather than greps: `compose-driver.ts`
    // ships driver-script text by the kilobyte, and a regex would read the
    // scripts it writes as edges of the module that writes them.
    withFixtureGraph(
      {
        'a.ts':
          'export const template = `\n' +
          "import { b } from './b';\n" +
          '`;\n' +
          '// import { b } from "./b";\n' +
          '/*\n' +
          "import { b } from './b';\n" +
          '*/\n',
        'b.ts': "export const b = () => require('./a');\n",
      },
      (graph) => {
        expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['b.ts->a.ts']);
        expect(findCycles(graph, ['value', 'type', 'deferred'])).toEqual([]);
      },
    );
  });

  it('CONTROL for the one-way check: the same reachability predicate reports a back edge when one exists', () => {
    // The real AC4 assertion above is only meaningful if this predicate can
    // say "no". A fixture reproducing the #907 shape — store → codec — plus
    // the back edge the real graph does not have.
    withFixtureGraph(
      {
        'store.ts': "import { assertShape } from './codec';\nexport const create = () => assertShape(1);\n",
        'codec.ts': "import type { View } from './contract';\nexport const assertShape = (x: unknown): View => x as View;\n",
        'contract.ts': 'export type View = unknown;\n',
      },
      (clean) => {
        expect(reachableFrom(clean, 'codec.ts', ['value', 'type', 'deferred'])).toEqual(['contract.ts']);
      },
    );
    withFixtureGraph(
      {
        'store.ts': "import { assertShape } from './codec';\nexport const create = () => assertShape(1);\n",
        'codec.ts': "import { create } from './store';\nexport const assertShape = (x: unknown) => create() ?? x;\n",
        'contract.ts': 'export type View = unknown;\n',
      },
      (seeded) => {
        expect(reachableFrom(seeded, 'codec.ts', ['value', 'type', 'deferred'])).toContain('store.ts');
        expect(findCycles(seeded, ['value']).map(cycleKey)).toEqual(['codec.ts + store.ts']);
      },
    );
  });

  it('CONTROL for the declaration comparison: an undeclared cycle and a stale declaration each fail, through the SAME reconciliation', () => {
    // Both directions of the verdict the two real acyclicity assertions run —
    // exercised on fixture graphs through `reconcileAgainstDeclaration`, the
    // same function those assertions call, so neither direction is a claim.
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'b.ts': "import { a } from './a';\nexport const b = () => a;\n",
        'c.ts': "import { d } from './d';\nexport const c = () => d;\n",
        'd.ts': "import { c } from './c';\nexport const d = () => c;\n",
      },
      (graph) => {
        const cycles = findCycles(graph, ['value']);
        expect(cycles.map(cycleKey)).toEqual(['a.ts + b.ts', 'c.ts + d.ts']);

        // In step — the shape every green run of the real assertions produces.
        expect(reconcileAgainstDeclaration(cycles, ['a.ts + b.ts', 'c.ts + d.ts'])).toEqual({
          undeclared: [],
          stale: [],
        });

        // A cycle nothing accounts for: reported by name, in `undeclared`.
        expect(reconcileAgainstDeclaration(cycles, ['a.ts + b.ts'])).toEqual({
          undeclared: ['c.ts + d.ts'],
          stale: [],
        });

        // An exemption whose cycle is gone: reported by name, in `stale`.
        expect(
          reconcileAgainstDeclaration(cycles, ['a.ts + b.ts', 'c.ts + d.ts', 'e.ts + f.ts']),
        ).toEqual({ undeclared: [], stale: ['e.ts + f.ts'] });

        // And a declaration that drifted in BOTH directions at once.
        expect(reconcileAgainstDeclaration(cycles, ['a.ts + b.ts', 'e.ts + f.ts'])).toEqual({
          undeclared: ['c.ts + d.ts'],
          stale: ['e.ts + f.ts'],
        });
      },
    );
  });

  it('CONTROL: a cycle key is the MEMBER SET, so a module JOINING an existing tangle changes the verdict', () => {
    // The reason the identity is the component rather than the rendered path:
    // a path-keyed comparison can print the same two-module string while a
    // third module quietly joins the component.
    const declared = ['a.ts + b.ts'];
    withFixtureGraph(
      {
        'a.ts': "import { b } from './b';\nexport const a = () => b;\n",
        'b.ts': "import { c } from './c';\nexport const b = () => c;\n",
        'c.ts': "import { a } from './a';\nexport const c = () => a;\n",
      },
      (grown) => {
        expect(reconcileAgainstDeclaration(findCycles(grown, ['value']), declared)).toEqual({
          undeclared: ['a.ts + b.ts + c.ts'],
          stale: ['a.ts + b.ts'],
        });
      },
    );
  });
});
