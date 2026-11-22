/** The two ids every context names: an orca node and a workgroup (design.md 2.1). */

import bs58 from "bs58";
import { z } from "zod";

import { brandString, type Branded } from "@deepseek-ai/dsh-brand";

/** Length of a raw Ed25519 public key. */
const PUBLIC_KEY_BYTES = 32;

/**
 * An orca node id is the raw Ed25519 public key in base58 (Bitcoin alphabet,
 * design.md 2.1), so a valid id is self-certifying: whoever signs with the matching
 * private key owns the id, and no shared workgroup secret can stand in for it.
 * Base58 is one-to-one, so each key has exactly one id. A checked id is only
 * made by `OrcaNodeIdSchema` from a plain string.
 */
export type OrcaNodeId = Branded<"OrcaNodeId">;

/** The raw public key `id` names; undefined when the text is not base58 of 32 bytes. */
export function publicKeyOf(id: string): Uint8Array | undefined {
  const bytes = bs58.decodeUnsafe(id);
  return bytes?.length === PUBLIC_KEY_BYTES ? bytes : undefined;
}

export const OrcaNodeIdSchema = z
  .string()
  .refine((id) => publicKeyOf(id) !== undefined, "must be an Ed25519 public key in base58")
  .transform((id) => brandString<OrcaNodeId>(id));

/** The id of a raw 32-byte Ed25519 public key. */
export function nodeIdOf(publicKey: Uint8Array): OrcaNodeId {
  return OrcaNodeIdSchema.parse(bs58.encode(publicKey));
}

/** A checked workgroup id; only `WorkgroupIdSchema` makes one from a plain string. */
export type WorkgroupId = Branded<"WorkgroupId">;

export const WorkgroupIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "must match [a-z0-9][a-z0-9-]{1,31}")
  .transform((id) => brandString<WorkgroupId>(id));
