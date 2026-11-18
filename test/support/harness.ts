import type { FetchLike } from "../../src/mesh/peer-client.ts";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { nodeParts } from "./node.ts";
import { WorkgroupIdSchema } from "../../src/core/wire/peer.ts";
import type { MeshTimings } from "../../src/mesh/timings.ts";
import { Orca } from "../../src/node/orca.ts";

type MeshOptions = {
  orcaNodes?: number;
  workgroupId?: string;
  password?: string;
  basePort?: number;
  displayNamePrefix?: string;
  dataRoot?: string;
  timings?: Partial<MeshTimings>;
  /** Per-orca-node approval timeout; unset means parked requests wait forever (§7.12). */
  approvalTimeoutS?: number;
  /** Per-orca-node outbound HTTP override, used to simulate jitter and partitions. */
  fetch?: (index: number) => FetchLike | undefined;
};

export type Mesh = {
  orcaNodes: Orca[];
  urls: string[];
  /** Root holding every orca node's data. Removed by the caller, never by `stop()`. */
  dataRoot: string;
  /**
   * True when `createMesh` invented `dataRoot` under the OS temp directory because the
   * caller supplied none. Such a root has no other owner, so a test fixture may delete it
   * after `stop()`; a caller-supplied root is never disposable.
   */
  ownsDataRoot: boolean;
  /** Stops the mesh's nodes. Idempotent; leaves `dataRoot` untouched so it can be inspected or reused. */
  stop(): Promise<void>;
};

const DEFAULT_NODES = 3;
const DEFAULT_WORKGROUP_ID = "orca-dev";

/** Boot `orcaNodes` in-process orca nodes and converge them on the first orcaNode. */
export async function createMesh(options: MeshOptions = {}): Promise<Mesh> {
  const count = options.orcaNodes ?? DEFAULT_NODES;
  const workgroupId = WorkgroupIdSchema.parse(options.workgroupId ?? DEFAULT_WORKGROUP_ID);
  const password = options.password ?? randomBytes(8).toString("hex");
  const ownsDataRoot = options.dataRoot === undefined;
  const dataRoot = options.dataRoot ?? join(tmpdir(), `orca-pod-mesh-${randomBytes(8).toString("hex")}`);
  const orcaNodes: Orca[] = [];
  const urls: string[] = [];
  let stopped = false;

  try {
    for (let index = 0; index < count; index += 1) {
      const config = nodeParts({
        workgroup_id: workgroupId,
        workgroup_password: password,
        data_root: join(dataRoot, `orca-node-${index}`),
        port: options.basePort ? options.basePort + index : 0,
        display_name: `${options.displayNamePrefix ?? "orca-node"}-${index}`,
        approval_timeout_s: options.approvalTimeoutS,
      });
      orcaNodes.push(new Orca(...config, { timings: options.timings, fetch: options.fetch?.(index) }));
    }

    for (const orcaNode of orcaNodes) {
      const { url } = await orcaNode.start();
      urls.push(url);
    }

    await connectAll(orcaNodes);

    return {
      orcaNodes,
      urls,
      dataRoot,
      ownsDataRoot,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
      },
    };
  } catch (error) {
    await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
    throw error;
  }
}

/** Make every node known to every other: each node greets each later one, and the greeted node records its greeter. */
export async function connectAll(orcaNodes: readonly Orca[]): Promise<void> {
  for (const [index, orcaNode] of orcaNodes.entries()) {
    for (const other of orcaNodes.slice(index + 1)) {
      const [endpoint] = other.mesh.self.endpoints;
      if (endpoint === undefined) throw new Error("orca node has no endpoint; start it first");
      await orcaNode.mesh.probe(endpoint);
    }
  }
}

type WaitForOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** What is being waited for, used in the timeout error. */
  label?: string;
};

/**
 * Poll `probe` until `done` accepts its value or the timeout elapses (§10.7).
 *
 * Real-process smoke tests observe another process's state through files, HTTP,
 * or CLI output, so there is no promise to await directly. In-process tests can
 * use the same helper for convergence assertions.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  done: (value: T) => boolean,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${options.label ?? "condition"}`);
    }
    await sleep(intervalMs);
  }
}
