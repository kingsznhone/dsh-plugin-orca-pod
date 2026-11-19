/** The two ids every context names: an orca node and a workgroup (§7.1). */

import { z } from "zod";

import { brandString, type Branded } from "@deepseek-ai/dsh-brand";

/**
 * An orca node id is the base64url-encoded raw Ed25519 public key (§7.1), so a
 * valid id is self-certifying: whoever signs with the matching private key owns
 * the id, and no shared workgroup secret can stand in for it. 43 characters
 * always decode to exactly 32 bytes. A checked id is only made by
 * `OrcaNodeIdSchema` from a plain string.
 */
export type OrcaNodeId = Branded<"OrcaNodeId">;

export const OrcaNodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "must be an Ed25519 public key (43 base64url chars)")
  .transform((id) => brandString<OrcaNodeId>(id));

/** A checked workgroup id; only `WorkgroupIdSchema` makes one from a plain string. */
export type WorkgroupId = Branded<"WorkgroupId">;

export const WorkgroupIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "must match [a-z0-9][a-z0-9-]{1,31}")
  .transform((id) => brandString<WorkgroupId>(id));
