/**
 * Architecture guard: the runtime import graph of `src/` stays acyclic and
 * only points downwards through the bounded contexts.
 *
 *   kernel ← protocol ← security ← storage ← { membership, tasks, execution, delegation }
 *          ← transport ← node ← { plugin, cli }
 *
 * - `import type` / `export type` are erased and do not count; an import whose
 *   specifiers are all inline `type` still does (it is emitted as `import {}`).
 * - Contexts in the same layer may use each other, but only through `index.ts`.
 * - A cross-context import must name the other context's `index.ts`; the
 *   assembly points (`node/`, `plugin/`, `cli/`) may reach inside.
 * - Storage implementations (every `storage/` file except `index.ts`) are wired
 *   only by the assembly points.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Layer of each context; a lower layer never imports a higher one. */
const LAYERS: Record<string, number> = {
  kernel: 0,
  protocol: 1,
  security: 2,
  storage: 3,
  membership: 4,
  tasks: 4,
  execution: 4,
  delegation: 4,
  transport: 5,
  node: 6,
  plugin: 7,
  cli: 7,
  /** `src/index.ts`, the package entry. */
  root: 8,
};

/** The one layer whose contexts collaborate sideways (through `index.ts`). */
const PEER_LAYER = 4;

const ASSEMBLY = new Set(["node", "plugin", "cli", "root"]);

/**
 * Known violations, as `from -> to` paths relative to `src/`. Only removals are
 * allowed: a fixed edge must leave this list, and a new violation fails.
 */
const ALLOWED_VIOLATIONS: string[] = [
  "membership/mesh.ts -> transport/net.ts",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const toKey = (path: string): string => relative(SRC, path).split(sep).join("/");

/** Matches `import`/`export` statements with a `from` clause and bare side-effect imports. */
const STATEMENT =
  /^[ \t]*(import|export)[ \t]+(type[ \t]+)?(?:\{[^}]*\}|\*(?:[ \t]+as[ \t]+\w+)?|\w+(?:[ \t]*,[ \t]*\{[^}]*\})?)\s*from\s*["']([^"']+)["']|^[ \t]*import[ \t]*["']([^"']+)["']/gm;

/** Runtime imports of one module, as keys relative to `src/`. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const targets: string[] = [];
  for (const match of text.matchAll(STATEMENT)) {
    if (match[2] !== undefined) continue;
    const specifier = match[3] ?? match[4];
    if (specifier === undefined || !specifier.startsWith(".")) continue;
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
  if (targetLayer > sourceLayer || (targetLayer === sourceLayer && sourceLayer !== PEER_LAYER)) {
    return `${source} (layer ${sourceLayer}) must not import ${target} (layer ${targetLayer})`;
  }
  const isIndex = to === `${target}/index.ts`;
  if (target === "storage" && !isIndex && !ASSEMBLY.has(source)) {
    return "storage implementations are wired only by node/, plugin/ and cli/";
  }
  if (!isIndex && !ASSEMBLY.has(source)) return `cross-context imports go through ${target}/index.ts`;
  return null;
}

const files = sourceFiles(SRC);
const graph = new Map(files.map((file) => [toKey(file), runtimeImports(file)]));

describe("architecture", () => {
  it("parses a non-trivial import graph", () => {
    expect(graph.size).toBeGreaterThan(20);
    for (const [from, targets] of graph) {
      for (const to of targets) expect(graph.has(to), `${from} imports missing ${to}`).toBe(true);
    }
  });

  it("has no import cycles", () => {
    expect(cycles(graph)).toEqual([]);
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
});
