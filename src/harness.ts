import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrcaNodeConfig } from "./config.ts";
import type { MembershipTimings } from "./membership.ts";
import { createOrcaNode, joinRoster, type FetchLike, type OrcaNode } from "./orca_node.ts";

export type MeshOptions = {
  orcaNodes?: number;
  workgroupId?: string;
  password?: string;
  basePort?: number;
  displayNamePrefix?: string;
  dataRoot?: string;
  timings?: Partial<MembershipTimings>;
  /** Per-orca-node approval timeout; unset means parked requests wait forever (§7.12). */
  approvalTimeoutS?: number;
  /** Per-orca-node outbound HTTP override, used to simulate jitter and partitions. */
  fetch?: (index: number) => FetchLike | undefined;
};

export type Mesh = {
  orcaNodes: OrcaNode[];
  urls: string[];
  stop(): Promise<void>;
};

const DEFAULT_NODES = 3;
const DEFAULT_WORKGROUP_ID = "orca-dev";

/** Boot `orcaNodes` in-process orca nodes and converge them on the first orcaNode. */
export async function createMesh(options: MeshOptions = {}): Promise<Mesh> {
  const count = options.orcaNodes ?? DEFAULT_NODES;
  const workgroupId = options.workgroupId ?? DEFAULT_WORKGROUP_ID;
  const password = options.password ?? randomBytes(8).toString("hex");
  const dataRoot = options.dataRoot ?? join(tmpdir(), `orca-pod-mesh-${randomBytes(8).toString("hex")}`);
  const orcaNodes: OrcaNode[] = [];
  const urls: string[] = [];

  try {
    for (let index = 0; index < count; index += 1) {
      const config = createOrcaNodeConfig({
        workgroupId,
        password,
        dataRoot: join(dataRoot, `orca-node-${index}`),
        port: options.basePort ? options.basePort + index : 0,
        displayName: `${options.displayNamePrefix ?? "orca-node"}-${index}`,
        ...(options.approvalTimeoutS !== undefined ? { approvalTimeoutS: options.approvalTimeoutS } : {}),
      });
      orcaNodes.push(createOrcaNode({ config, timings: options.timings, fetch: options.fetch?.(index) }));
    }

    for (const orcaNode of orcaNodes) {
      const { url } = await orcaNode.start();
      urls.push(url);
    }

    const bootstrapUrl = urls[0];
    if (!bootstrapUrl) throw new Error("createMesh needs at least one orca node");

    for (const orcaNode of orcaNodes.slice(1)) {
      const response = await orcaNode.join(bootstrapUrl);
      await joinRoster(orcaNode, response.members);
    }

    for (const orcaNode of orcaNodes) {
      await orcaNode.heartbeat(bootstrapUrl);
    }

    return {
      orcaNodes,
      urls,
      async stop(): Promise<void> {
        await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
      },
    };
  } catch (error) {
    await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
    throw error;
  }
}
