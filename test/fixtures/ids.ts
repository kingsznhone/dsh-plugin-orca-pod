import { createHash } from "node:crypto";

import { brandString } from "@deepseek-ai/dsh-brand";

import { nodeIdOf, type OrcaNodeId, type WorkgroupId, WorkgroupIdSchema } from "../../src/core/ids.ts";

/** A well-formed orca node id (32 bytes in base58) for a label, for tests that need ids but no keys. */
export function fakeNodeId(label: string): OrcaNodeId {
  return nodeIdOf(createHash("sha256").update(label).digest());
}

/**
 * A short label (`"SELF"`, `"BBBBBB"`) typed as a node id, for unit tests below
 * the wire (membership, task metadata, the runner) that never check an id's
 * form. Anything that crosses the wire or verifies a signature needs `fakeNodeId`.
 */
export const labelId = (label: string): OrcaNodeId => brandString<OrcaNodeId>(label);

/** A workgroup id from a literal, checked by the real schema. */
export const wg = (id: string): WorkgroupId => WorkgroupIdSchema.parse(id);
