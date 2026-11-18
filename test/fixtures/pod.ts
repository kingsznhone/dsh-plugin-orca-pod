import type { Context, Logger } from "@deepseek-ai/cordis";
import { vi } from "vitest";

import { parseSettings } from "../../src/node/settings.ts";
import type { OrcaNode } from "../../src/node/orca-node.ts";
import { ModelCatalogFeed } from "../../src/plugin/catalog.ts";
import { Pod } from "../../src/plugin/pod.ts";
import { MemoryPodStores } from "../../src/plugin/stores.ts";

export const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

/** A catalog feed that follows no host services: `watch` is never called on it. */
export function catalogFeed(): ModelCatalogFeed {
  return new ModelCatalogFeed({ inject() {} } as unknown as Pick<Context, "inject">, logger);
}

/** A real pod that was never started: no node, nothing configured. */
export function idlePod(config: Record<string, unknown> = {}, stores = new MemoryPodStores(), root?: string): Pod {
  return new Pod(parseSettings(config), logger, stores, catalogFeed(), root);
}

/**
 * A pod that is running the given node, the way one that started it
 * would be. Tests pass the few parts of a node they exercise.
 */
export function podRunning(node: unknown): Pod {
  const pod = idlePod();
  vi.spyOn(pod, "status", "get").mockReturnValue({ kind: "running", run: { node: node as OrcaNode, port: 0 } });
  return pod;
}
