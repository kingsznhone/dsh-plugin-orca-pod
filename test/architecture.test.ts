/**
 * Architecture guard: the import graph of `src/` stays acyclic and only points
 * downwards through the feature contexts (D41).
 *
 *   core ← executor ← task ← mesh ← api ← node ← plugin
 *
 * - Runtime imports must point strictly down. Handing a task to a node is
 *   something done to a node, so `mesh` sits above `task`: `task` is the local
 *   execution (runner, record, store, grants, workspace) and the wire shapes.
 * - A type-only import (`import type`, `export type`) is erased and may point
 *   anywhere, but it still counts for cycles: files must not depend on each
 *   other in a loop even if only a type closes it.
 * - There are no barrel files: an importer names the file that defines what it
 *   uses, so moving code inside a context means updating its callers.
 * - SQLite stores (`Sqlite*`) are constructed only by the assembly points.
 * - `client` is the browser bundle, above everything: nothing imports it, and
 *   at runtime it imports only `core`, so no host code reaches the bundle. Its
 *   type-only imports of the wire shapes are erased like any other.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Layer of each context; a lower layer never imports a higher or an equal one. */
const LAYERS: Record<string, number> = {
  core: 0,
  executor: 1,
  task: 2,
  mesh: 3,
  api: 4,
  node: 5,
  plugin: 6,
  /** `src/index.ts`, the package entry. */
  root: 7,
  /** `src/client/`, the browser bundle built by `scripts/build-client.ts`. */
  client: 8,
};

/** Contexts the client bundle may import at runtime. */
const CLIENT_RUNTIME = new Set(["core"]);

/** Where `Sqlite*` stores may be constructed. */
const ASSEMBLY = new Set(["node", "plugin", "root"]);

/** Non-code imports the client build loads (CSS modules, inlined sounds); not part of the graph. */
const ASSET = /\.(css|mp3)$/;

/**
 * Known violations, as `from -> to` paths relative to `src/`. Only removals are
 * allowed: a fixed edge must leave this list, and a new violation fails.
 */
const ALLOWED_VIOLATIONS: string[] = [];

/** Known cycles that only a type closes, as the sorted file keys joined by `, `. Only removals are allowed. */
const ALLOWED_TYPE_CYCLES: string[] = [];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const toKey = (path: string): string => relative(SRC, path).split(sep).join("/");

/** Matches `import`/`export` statements with a `from` clause and bare side-effect imports. */
const STATEMENT =
  /^[ \t]*(import|export)[ \t]+(type[ \t]+)?(?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+\w+)?|\w+(?:[ \t]*,[ \t]*\{[^}]*\})?)\s*from\s*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']/gm;

/** Imports of one module, as keys relative to `src/`; type-only imports only when asked for. */
function importsOf(file: string, includeTypes: boolean): string[] {
  const text = readFileSync(file, "utf8");
  const targets: string[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    if (match[2] !== undefined && !includeTypes) continue;
    const specifier = match[3] ?? match[4];
    if (specifier === undefined || !specifier.startsWith(".") || ASSET.test(specifier)) continue;
    targets.push(toKey(resolve(dirname(file), specifier)));
  }
  return targets;
}

function contextOf(key: string): string {
  const slash = key.indexOf("/");
  return slash === -1 ? "root" : key.slice(0, slash);
}

/** Tarjan's strongly connected components; every component of size > 1 (or a self loop) is a cycle. */
function cycles(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const found: string[][] = [];
  const visit = (node: string): void => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowlinks.set(node, Math.min(lowlinks.get(node)!, lowlinks.get(next)!));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node)!, indices.get(next)!));
      }
    }
    if (lowlinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) found.push(component.sort());
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return found;
}

/** Why the edge `from -> to` breaks a rule, or null when it is allowed. */
function violation(from: string, to: string): string | null {
  const source = contextOf(from);
  const target = contextOf(to);
  if (source === target) return null;
  const sourceLayer = LAYERS[source];
  const targetLayer = LAYERS[target];
  if (sourceLayer === undefined) return `${from} is outside every context`;
  if (targetLayer === undefined) return `${to} is outside every context`;
  if (targetLayer >= sourceLayer) {
    return `${source} (layer ${sourceLayer}) must not import ${target} (layer ${targetLayer})`;
  }
  if (source === "client" && !CLIENT_RUNTIME.has(target)) {
    return `client may import only ${[...CLIENT_RUNTIME].join(", ")} at runtime, not ${target}`;
  }
  return null;
}

const files = sourceFiles(SRC);
const graph = new Map(files.map((file) => [toKey(file), importsOf(file, false)]));
const typedGraph = new Map(files.map((file) => [toKey(file), importsOf(file, true)]));

describe("architecture", () => {
  it("parses a non-trivial import graph", () => {
    expect(graph.size).toBeGreaterThan(20);
    for (const [from, targets] of graph) {
      for (const to of targets) expect(graph.has(to), `${from} imports missing ${to}`).toBe(true);
    }
  });

  it("has no import cycles, type-only imports included", () => {
    expect(cycles(graph)).toEqual([]);
    const found = cycles(typedGraph).map((component) => component.join(", "));
    expect(
      found.filter((entry) => !ALLOWED_TYPE_CYCLES.includes(entry)),
      "new type-only cycles",
    ).toEqual([]);
    expect(
      ALLOWED_TYPE_CYCLES.filter((entry) => !found.includes(entry)),
      "fixed cycles still listed in ALLOWED_TYPE_CYCLES",
    ).toEqual([]);
  });

  it("only lets dependencies point downwards", () => {
    const found: string[] = [];
    for (const [from, targets] of graph) {
      for (const to of new Set(targets)) {
        const reason = violation(from, to);
        if (reason !== null) found.push(`${from} -> ${to}: ${reason}`);
      }
    }
    const edge = (entry: string): string => entry.slice(0, entry.indexOf(":"));
    const unexpected = found.filter((entry) => !ALLOWED_VIOLATIONS.includes(edge(entry)));
    const fixed = ALLOWED_VIOLATIONS.filter((entry) => !found.some((item) => edge(item) === entry));
    expect(unexpected, "new dependency violations").toEqual([]);
    expect(fixed, "fixed violations still listed in ALLOWED_VIOLATIONS").toEqual([]);
  });

  it("constructs SQLite stores only in the assembly points", () => {
    const construction = /(?<!function )createSqlite\w+\(|(?<![\w.])new Sqlite(?!Db)\w+\(/;
    const offenders = files
      .filter((file) => !ASSEMBLY.has(contextOf(toKey(file))))
      .filter((file) => construction.test(readFileSync(file, "utf8")))
      .map(toKey);
    expect(offenders, "SQLite stores constructed outside node/ and plugin/").toEqual([]);
  });
});
