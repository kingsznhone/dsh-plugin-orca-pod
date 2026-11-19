import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

import { publicKeyOf, type OrcaNodeId } from "./ids.ts";

/**
 * Per-node identity (§7.1): an Ed25519 keypair created at first start. The
 * orca node id *is* the public key, so any request a node signs proves which
 * node sent it — no shared workgroup secret can impersonate another node.
 *
 * This module signs and verifies; making a key, and keeping it (the DSH
 * credential store, §3.6), is the plugin's business (`plugin/stores.ts`).
 */
export type NodeIdentity = {
  /** base58 of the raw 32-byte Ed25519 public key. */
  orcaNodeId: OrcaNodeId;
  /** PKCS#8 PEM of the private half; it leaves the process only as the store's record. */
  privateKeyPem: string;
};

/** SPKI header of an Ed25519 public key (RFC 8410): SEQUENCE(30 2a) + OID(1.3.101.112) + BIT STRING. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Short label for UI/logs: first 6 and last 4 characters (any text works; labels also shorten unknown keys). */
export function shortenNodeId(orcaNodeId: string): string {
  if (orcaNodeId.length <= 12) return orcaNodeId;
  return `${orcaNodeId.slice(0, 6)}…${orcaNodeId.slice(-4)}`;
}

export function signWithIdentity(identity: NodeIdentity, message: string | Uint8Array): string {
  return edSign(null, Buffer.from(message), identity.privateKeyPem).toString("base64url");
}

export function verifyWithNodeId(orcaNodeId: OrcaNodeId, message: string | Uint8Array, signature: string): boolean {
  const raw = publicKeyOf(orcaNodeId);
  if (raw === undefined) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return edVerify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
