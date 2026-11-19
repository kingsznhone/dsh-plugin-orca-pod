import { randomBytes } from "node:crypto";

import { afterEach } from "vitest";

import { FileBlobRegistry } from "../../src/core/blobs.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../../src/node/orca.ts";
import { generateNodeIdentity, type NodeIdentity } from "../../src/core/identity.ts";
import { buildAuthHeader, newNonce } from "../../src/core/signing.ts";
import type { RuntimeInfo } from "../../src/mesh/wire.ts";
import type { WorkgroupId } from "../../src/core/ids.ts";
import { Gateway } from "../../src/api/gateway.ts";
import { MeshContext } from "../../src/mesh/context.ts";
import { Mesh } from "../../src/mesh/mesh.ts";
import { HttpPeerClient } from "../../src/mesh/peer-client.ts";
import { EndpointScreen } from "../../src/mesh/screening.ts";
import { resolveClock } from "../../src/mesh/timings.ts";
import { DispatchLog } from "../../src/task/dispatch-log.ts";
import type { SingleSlotTaskRunner } from "../../src/task/runner.ts";
import { wg } from "./ids.ts";
import { createTestRunner, openDb, tempDir } from "./runner.ts";

export const GATEWAY_ENDPOINT = "http://orca-node.test";

const RUNTIME: RuntimeInfo = {
  os: { family: "linux", name: "Linux", version: "6" },
  arch: "x64",
  cpu: { model: "test", logical_cores: 2 },
  memory: { total_bytes: 1 },
  node: { version: "v24" },
  captured_at: "2026-01-01T00:00:00.000Z",
};

/** Gateways listening during a test; closed after it. */
const listening: Gateway[] = [];

afterEach(async () => {
  for (const gateway of listening.splice(0)) await gateway.close();
});

export type GatewayHarness = {
  gateway: Gateway;
  app: Gateway["app"];
  /** Where the gateway listens on loopback; it starts listening on the first call. */
  url(): Promise<string>;
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  workgroup: WorkgroupId;
  mesh: Mesh;
  tasks: SingleSlotTaskRunner;
  blobs: FileBlobRegistry;
  /** What the local routes take (`x-orca-local`). */
  localToken: string;
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
  const db = openDb();
  const blobs = options.blobs ?? new FileBlobRegistry(db, tempDir("orca-blobs-"));
  const localToken = randomBytes(16).toString("base64url");
  const context = new MeshContext(
    identity,
    workgroup,
    new HttpPeerClient(identity, key, workgroup, {
      fetch: async () => {
        throw new Error("no outbound calls in a gateway test");
      },
      timeoutMs: 1000,
    }),
    new DispatchLog(db, { warn() {} }),
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
  const gateway = new Gateway(mesh, tasks, key, identity, { token: localToken, blobs });
  const signAs: GatewayHarness["signAs"] = (caller, method, path, extra = {}) =>
    buildAuthHeader(
      caller,
      extra.key ?? key,
      { method, url: path, body: extra.body },
      {
        target: extra.target ?? identity.orcaNodeId,
        workgroupId: extra.workgroup ?? workgroup,
        ts: Date.now(),
        nonce: newNonce(),
      },
    );
  let base: Promise<string> | undefined;
  const listen = (): Promise<string> => {
    if (base === undefined) {
      listening.push(gateway);
      base = gateway.listen("127.0.0.1", 0);
    }
    return base;
  };
  return {
    gateway,
    app: gateway.app,
    url: listen,
    key,
    identity,
    orcaNodeId: identity.orcaNodeId,
    workgroup,
    mesh,
    tasks,
    blobs,
    localToken,
    sign: (method, path, body) => signAs(identity, method, path, { body }),
    signAs,
  };
}
