import { randomBytes } from "node:crypto";

import { DiskBlobRegistry, MemoryFileBlobStore, type FileBlobRegistry } from "../../src/core/blobs.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../../src/core/constants.ts";
import { EventBus } from "../../src/core/events.ts";
import { generateNodeIdentity, type NodeIdentity } from "../../src/core/identity.ts";
import { buildAuthHeader } from "../../src/core/signing.ts";
import type { RuntimeInfo, WorkgroupId } from "../../src/core/wire/peer.ts";
import { Gateway } from "../../src/api/gateway.ts";
import { MeshContext } from "../../src/mesh/context.ts";
import { Mesh } from "../../src/mesh/mesh.ts";
import { HttpPeerClient } from "../../src/mesh/peer-client.ts";
import { EndpointScreen } from "../../src/mesh/screening.ts";
import { resolveClock } from "../../src/mesh/timings.ts";
import { DispatchLog } from "../../src/task/dispatch-log.ts";
import { MemoryDispatchStore } from "../../src/task/dispatch-store.ts";
import type { SingleSlotTaskRunner } from "../../src/task/runner.ts";
import type { DispatchEvent } from "../../src/task/wire.ts";
import { wg } from "./ids.ts";
import { createTestRunner } from "./runner.ts";

export const GATEWAY_ENDPOINT = "http://orca-node.test";

const RUNTIME: RuntimeInfo = {
  os: { family: "linux", name: "Linux", version: "6" },
  arch: "x64",
  cpu: { model: "test", logical_cores: 2 },
  memory: { total_bytes: 1 },
  node: { version: "v24" },
  captured_at: "2026-01-01T00:00:00.000Z",
};

export type GatewayHarness = {
  gateway: Gateway;
  app: Gateway["app"];
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  workgroup: WorkgroupId;
  mesh: Mesh;
  tasks: SingleSlotTaskRunner;
  blobs: FileBlobRegistry;
  /** The header a caller holding `identity` and the workgroup key signs a request to this gateway with. */
  sign(method: string, path: string, body?: Uint8Array | string): string;
  /** The same for any other caller: its own key pair, and a workgroup key and id the test may get wrong on purpose. */
  signAs(
    caller: NodeIdentity,
    method: string,
    path: string,
    options?: { body?: Uint8Array | string; key?: Buffer; workgroup?: WorkgroupId; target?: string },
  ): string;
};

export type GatewayHarnessOptions = {
  tasks?: SingleSlotTaskRunner;
  blobs?: FileBlobRegistry;
  workgroup?: WorkgroupId;
  displayName?: string;
};

/** A gateway built from real parts, on its own identity and a table with only itself in it. No outbound call succeeds. */
export function createGatewayHarness(options: GatewayHarnessOptions = {}): GatewayHarness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const workgroup = options.workgroup ?? wg("orca-dev");
  const blobs = options.blobs ?? new DiskBlobRegistry(new MemoryFileBlobStore());
  const context = new MeshContext(
    identity,
    workgroup,
    key,
    new HttpPeerClient(identity, key, workgroup, {
      fetch: async () => {
        throw new Error("no outbound calls in a gateway test");
      },
      timeoutMs: 1000,
    }),
    new DispatchLog(new MemoryDispatchStore(), new EventBus<DispatchEvent>()),
    blobs,
    new EndpointScreen({}),
    resolveClock(),
    { warn() {} },
  );
  const mesh = new Mesh(context, {
    display_name: options.displayName ?? "gateway-test",
    endpoints: [GATEWAY_ENDPOINT],
    runtime: RUNTIME,
    max_task_ttl_s: DEFAULT_TASK_TIMEOUT_S,
  });
  const tasks = options.tasks ?? createTestRunner();
  const gateway = new Gateway(mesh, tasks, key, identity);
  const signAs: GatewayHarness["signAs"] = (caller, method, path, extra = {}) =>
    buildAuthHeader({
      identity: caller,
      key: extra.key ?? key,
      workgroupId: extra.workgroup ?? workgroup,
      method,
      url: path,
      targetOrcaNodeId: extra.target ?? identity.orcaNodeId,
      body: extra.body,
    });
  return {
    gateway,
    app: gateway.app,
    key,
    identity,
    orcaNodeId: identity.orcaNodeId,
    workgroup,
    mesh,
    tasks,
    blobs,
    sign: (method, path, body) => signAs(identity, method, path, { body }),
    signAs,
  };
}
