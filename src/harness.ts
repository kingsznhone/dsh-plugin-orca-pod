import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeConfig } from "./config.ts";
import type { MembershipTimings } from "./membership.ts";
import { createOrcaNode, joinRoster, type FetchLike, type OrcaNode } from "./orca_node.ts";

export type MeshOptions = {
  nodes?: number;
  workgroupId?: string;
  password?: string;
  basePort?: number;
  displayNamePrefix?: string;
  dataRoot?: string;
  timings?: Partial<MembershipTimings>;
  /** Per-node outbound HTTP override, used to simulate jitter and partitions. */
  fetch?: (index: number) => FetchLike | undefined;
};

export type Mesh = {
  nodes: OrcaNode[];
  urls: string[];
  stop(): Promise<void>;
};

const DEFAULT_NODES = 3;
const DEFAULT_WORKGROUP_ID = "orca-dev";

/** Boot `nodes` in-process Orca nodes and converge them on the first node. */
export async function createMesh(options: MeshOptions = {}): Promise<Mesh> {
  const count = options.nodes ?? DEFAULT_NODES;
  const workgroupId = options.workgroupId ?? DEFAULT_WORKGROUP_ID;
  const password = options.password ?? randomBytes(8).toString("hex");
  const dataRoot = options.dataRoot ?? join(tmpdir(), `orca-pod-mesh-${randomBytes(8).toString("hex")}`);
  const nodes: OrcaNode[] = [];
  const urls: string[] = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const config = createNodeConfig({
        workgroupId,
        password,
        dataRoot: join(dataRoot, `node-${index}`),
        port: options.basePort ? options.basePort + index : 0,
        displayName: `${options.displayNamePrefix ?? "node"}-${index}`,
      });
      nodes.push(createOrcaNode({ config, timings: options.timings, fetch: options.fetch?.(index) }));
    }

    for (const node of nodes) {
      const { url } = await node.start();
      urls.push(url);
    }

    const bootstrapUrl = urls[0];
    if (!bootstrapUrl) throw new Error("createMesh needs at least one node");

    for (const node of nodes.slice(1)) {
      const response = await node.join(bootstrapUrl);
      await joinRoster(node, response.members);
    }

    for (const node of nodes) {
      await node.heartbeat(bootstrapUrl);
    }

    return {
      nodes,
      urls,
      async stop(): Promise<void> {
        await Promise.all(nodes.map((node) => node.stop()));
      },
    };
  } catch (error) {
    await Promise.all(nodes.map((node) => node.stop()));
    throw error;
  }
}
