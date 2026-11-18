import { EventBus } from "../../src/core/events.ts";
import { generateNodeIdentity } from "../../src/core/identity.ts";
import { DEFAULT_TASK_TIMEOUT_S } from "../../src/core/constants.ts";
import { DiskBlobRegistry, MemoryFileBlobStore } from "../../src/core/blobs.ts";
import type { OrcaNodeId, PeerView } from "../../src/core/wire/peer.ts";
import { MeshContext } from "../../src/mesh/context.ts";
import { Mesh } from "../../src/mesh/mesh.ts";
import type { OrcaNode } from "../../src/mesh/orca-node.ts";
import { HttpPeerClient } from "../../src/mesh/peer-client.ts";
import { EndpointScreen } from "../../src/mesh/screening.ts";
import { resolveClock, type MeshTimings } from "../../src/mesh/timings.ts";
import { DispatchLog } from "../../src/task/dispatch-log.ts";
import { MemoryDispatchStore } from "../../src/task/dispatch-store.ts";
import type { DispatchEvent } from "../../src/task/wire.ts";
import { wg } from "../fixtures/ids.ts";

/**
 * A node table on a clock the test moves by hand, with no network: nothing it
 * dials answers. For the table's own rules (state from silence, the directory,
 * tombstones), not for contact.
 */
export function testMesh(timings: Partial<MeshTimings> = {}) {
  let now = 1000;
  const identity = generateNodeIdentity();
  const workgroup = wg("mesh-test");
  const key = Buffer.alloc(32, 7);
  const clock = resolveClock({ monotonicMs: () => now, wallIso: () => new Date(now).toISOString() });
  const ctx = new MeshContext(
    identity,
    workgroup,
    key,
    new HttpPeerClient(identity, key, workgroup, {
      fetch: async () => {
        throw new Error("no outbound calls in a table test");
      },
      timeoutMs: 100,
    }),
    new DispatchLog(new MemoryDispatchStore(), new EventBus<DispatchEvent>()),
    new DiskBlobRegistry(new MemoryFileBlobStore()),
    new EndpointScreen({}),
    clock,
    { warn() {} },
  );
  const mesh = new Mesh(
    ctx,
    { display_name: "self", endpoints: ["http://127.0.0.1:1"], max_task_ttl_s: DEFAULT_TASK_TIMEOUT_S },
    { timings },
  );
  return {
    mesh,
    ctx,
    clock,
    advance(ms: number): void {
      now += ms;
    },
    /** A greeting from `id`, as the route hands it to the mesh: an explicit member, heard just now. */
    greeted(id: OrcaNodeId, endpoints = ["http://127.0.0.1:11811"]): OrcaNode {
      mesh.answer(id, { self: { display_name: `node-${id}`, endpoints }, busy: null, digest: "" }, endpoints);
      return mesh.require(id);
    },
    /** A signed message from `id` arrived now. */
    hear(id: OrcaNodeId): void {
      mesh.require(id).heard(clock.monotonicMs(), clock.wallIso());
    },
  };
}

/** A record as a remote list carries it. */
export function listed(
  id: OrcaNodeId,
  endpoint = "http://127.0.0.1:11811",
  overrides: Partial<PeerView> = {},
): PeerView {
  return {
    orca_node_id: id,
    display_name: `node-${id}`,
    endpoints: [endpoint],
    runtime: null,
    runtime_digest: `digest-${id}`,
    state: "online",
    busy: null,
    last_recv_at: null,
    ...overrides,
  };
}
