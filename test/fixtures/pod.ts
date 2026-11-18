import type { Context, Logger } from "@deepseek-ai/cordis";
import { vi } from "vitest";

import { parseSettings } from "../../src/node/settings.ts";
import type { OrcaNode } from "../../src/node/orca-node.ts";
import { ModelCatalogFeed } from "../../src/plugin/catalog.ts";
import { PodLifecycle } from "../../src/plugin/lifecycle.ts";
import { MemoryPodStores } from "../../src/plugin/stores.ts";

export const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** A catalog feed that follows no host services: `watch` is never called on it. */
export function catalogFeed(): ModelCatalogFeed {
  return new ModelCatalogFeed({ inject() {} } as unknown as Pick<Context, "inject">, logger);
}

/** A real lifecycle that was never started: no node, nothing configured. */
export function idleLifecycle(
  config: Record<string, unknown> = {},
  stores = new MemoryPodStores(),
  root?: string,
): PodLifecycle {
  return new PodLifecycle(parseSettings(config), logger, stores, catalogFeed(), root);
}

/**
 * A lifecycle that answers `node` with the given object, the way one that
 * started a node would. Tests pass the few parts of a node they exercise.
 */
export function lifecycleWithNode(node: unknown): PodLifecycle {
  const lifecycle = idleLifecycle();
  vi.spyOn(lifecycle, "node", "get").mockReturnValue(node as OrcaNode);
  return lifecycle;
}
