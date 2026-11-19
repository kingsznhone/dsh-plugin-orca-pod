import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNodeIdentity, type NodeIdentity } from "../../src/core/identity.ts";
import { deriveWorkgroupKey } from "../../src/core/signing.ts";
import { createOrcaNodeConfig, type OrcaNodeConfig } from "../../src/node/config.ts";
import { Orca } from "../../src/node/orca.ts";

type OrcaNodeOptions = ConstructorParameters<typeof Orca>[3];
import type { PeerView } from "../../src/core/wire/peer.ts";
import { parseSettings, type Settings } from "../../src/node/settings.ts";

/**
 * Settings of a node a test builds: a workgroup and its password are required,
 * the rest takes the defaults. `data_root` is where the node keeps its files; a
 * test that does not say gets a directory of its own under the OS temp dir.
 */
export type NodeInput = Partial<Settings> &
  Required<Pick<Settings, "workgroup_id" | "workgroup_password">> & { data_root?: string };

/**
 * What an `Orca` is built from, in the order its constructor takes it:
 * `new Orca(...nodeParts(input), options)`. A fresh identity is made unless
 * the test restarts a node that must stay itself.
 */
export function nodeParts(
  input: NodeInput,
  identity: NodeIdentity = generateNodeIdentity(),
): readonly [OrcaNodeConfig, NodeIdentity, Buffer] {
  const { data_root = join(tmpdir(), `orca-pod-test-${randomBytes(6).toString("hex")}`), ...settings } = input;
  return [
    createOrcaNodeConfig(parseSettings(settings), identity, data_root),
    identity,
    deriveWorkgroupKey(input.workgroup_id, input.workgroup_password),
  ];
}

/** A node that was not started; it runs in memory unless `options.persistent` says otherwise. */
export function newNode(input: NodeInput, options?: OrcaNodeOptions, identity?: NodeIdentity): Orca {
  return new Orca(...nodeParts(input, identity), options);
}

/** What a node knows about the others: the records it lists, as peers list them. */
export function peersOf(orca: Orca): PeerView[] {
  return orca.mesh.peers().map((node) => node.view());
}
