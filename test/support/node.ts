import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNodeIdentity, type NodeIdentity } from "../../src/core/identity.ts";
import { deriveWorkgroupKey } from "../../src/core/signing.ts";
import type { PeerView, WorkgroupId } from "../../src/core/wire/peer.ts";
import { Orca } from "../../src/node/orca.ts";
import { parseSettings, type Settings } from "../../src/node/settings.ts";

type OrcaNodeOptions = ConstructorParameters<typeof Orca>[4];

/**
 * Settings of a node a test builds: a workgroup and its password are required,
 * the rest takes the defaults. `data_root` is where the node keeps its files; a
 * test that does not say gets a directory of its own under the OS temp dir.
 */
export type NodeInput = Partial<Settings> & {
  workgroup_id: WorkgroupId;
  workgroup_password: string;
  data_root?: string;
};

/**
 * What an `Orca` is built from, in the order its constructor takes it:
 * `new Orca(...nodeParts(input), options)`. A fresh identity is made unless
 * the test restarts a node that must stay itself.
 */
export function nodeParts(
  input: NodeInput,
  identity: NodeIdentity = generateNodeIdentity(),
): readonly [Settings, NodeIdentity, Buffer, string] {
  const {
    data_root = join(tmpdir(), `orca-pod-test-${randomBytes(6).toString("hex")}`),
    workgroup_password,
    ...settings
  } = input;
  return [parseSettings(settings), identity, deriveWorkgroupKey(input.workgroup_id, workgroup_password), data_root];
}

/** A node that was not started; it runs in memory unless `options.persistent` says otherwise. */
export function newNode(input: NodeInput, options?: OrcaNodeOptions, identity?: NodeIdentity): Orca {
  return new Orca(...nodeParts(input, identity), options);
}

/** What a node knows about the others: the records it lists, as peers list them. */
export function peersOf(orca: Orca): PeerView[] {
  return orca.mesh.peers().map((node) => node.view());
}
