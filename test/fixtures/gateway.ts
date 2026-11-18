import { randomBytes } from "node:crypto";

import { DiskBlobRegistry, MemoryFileBlobStore, type FileBlobRegistry } from "../../src/core/blobs.ts";
import { generateNodeIdentity, type NodeIdentity } from "../../src/core/identity.ts";
import { ModelCatalog } from "../../src/core/model-catalog.ts";
import { buildAuthHeader } from "../../src/core/signing.ts";
import type { RuntimeInfo, WorkgroupId } from "../../src/core/wire/peer.ts";
import { Gateway } from "../../src/api/gateway.ts";
import { BlobFetcher } from "../../src/mesh/blob-fetcher.ts";
import { Membership } from "../../src/mesh/membership.ts";
import { HttpPeerClient } from "../../src/mesh/peer-client.ts";
import { SelfProfile } from "../../src/mesh/self-profile.ts";
import { Workgroup } from "../../src/mesh/workgroup.ts";
import type { SingleSlotTaskRunner } from "../../src/task/runner.ts";
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
  membership: Membership;
  profile: SelfProfile;
  tasks: SingleSlotTaskRunner;
  blobs: FileBlobRegistry;
  /** Reaches members; a test that wants a file from one spies on `files.fetch`. */
  files: BlobFetcher;
  /** The header a caller holding `identity` signs a request to this gateway with. */
  sign(method: string, path: string, body?: Uint8Array | string): string;
};

export type GatewayHarnessOptions = {
  tasks?: SingleSlotTaskRunner;
  blobs?: FileBlobRegistry;
  workgroup?: WorkgroupId;
  displayName?: string;
};

/** A gateway built from real parts, on its own identity and an empty roster. No outbound call succeeds. */
export function createGatewayHarness(options: GatewayHarnessOptions = {}): GatewayHarness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const profile = new SelfProfile(
    {
      orca_node_id: identity.orcaNodeId,
      workgroup_id: options.workgroup ?? wg("orca-dev"),
      display_name: options.displayName ?? "gateway-test",
    },
    RUNTIME,
    new ModelCatalog(),
  );
  profile.setEndpoints([GATEWAY_ENDPOINT]);
  const membership = new Membership(identity.orcaNodeId);
  const client = new HttpPeerClient(identity, profile, membership, {
    fetch: async () => {
      throw new Error("no outbound calls in a gateway test");
    },
    timeoutMs: 1000,
  });
  const mesh = new Workgroup(key, membership, client, profile, { logger: { warn() {} }, dial: {} });
  const blobs = options.blobs ?? new DiskBlobRegistry(new MemoryFileBlobStore());
  const files = new BlobFetcher(blobs, mesh, client, identity.orcaNodeId);
  const tasks = options.tasks ?? createTestRunner();
  const gateway = new Gateway(profile, membership, tasks, files, key);
  return {
    gateway,
    app: gateway.app,
    key,
    identity,
    orcaNodeId: identity.orcaNodeId,
    membership,
    profile,
    tasks,
    blobs,
    files,
    sign: (method, url, body) =>
      buildAuthHeader({ identity, method, url, targetOrcaNodeId: identity.orcaNodeId, body }),
  };
}
