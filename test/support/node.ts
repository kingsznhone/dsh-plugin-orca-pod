import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NodeIdentity } from "../../src/core/identity.ts";
import type { PeerView } from "../../src/mesh/wire.ts";
import type { OrcaNodeId, WorkgroupId } from "../../src/core/ids.ts";
import { Orca } from "../../src/node/orca.ts";
import { parseSettings, type Settings } from "../../src/node/settings.ts";
import { generateNodeIdentity } from "../../src/plugin/stores.ts";
import { deriveWorkgroupKey } from "../../src/plugin/pod.ts";
import { ScriptExecutor } from "./script.ts";

type OrcaNodeOptions = ConstructorParameters<typeof Orca>[4];

/** Every identity `nodeParts` handed out, by node id: a test that signs as a node it built looks it up here. */
const identities = new Map<OrcaNodeId, NodeIdentity>();

/** The identity of a node a test built from `nodeParts`. */
export function identityOf(node: Orca): NodeIdentity {
  const identity = identities.get(node.mesh.self.id);
  if (identity === undefined) throw new Error(`${node.mesh.self.id} was not built from nodeParts`);
  return identity;
}

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
  identities.set(identity.orcaNodeId, identity);
  return [parseSettings(settings), identity, deriveWorkgroupKey(input.workgroup_id, workgroup_password), data_root];
}

/** A node that was not started; it runs scripted tasks (`ScriptExecutor`) unless `options` names an executor. */
export function newNode(input: NodeInput, options?: OrcaNodeOptions, identity?: NodeIdentity): Orca {
  return new Orca(...nodeParts(input, identity), { executor: new ScriptExecutor(), ...options });
}

/** What a node knows about the others: the records it lists, as peers list them. */
export function peersOf(orca: Orca): PeerView[] {
  return orca.mesh.peers().map((node) => node.view());
}
