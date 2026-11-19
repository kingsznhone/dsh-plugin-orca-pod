import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";

import bs58 from "bs58";

import { OrcaNodeIdSchema, type OrcaNodeId } from "./ids.ts";

/**
 * Per-node identity (§7.1): an Ed25519 keypair created at first start. The
 * orca node id *is* the public key, so any request a node signs proves which
 * node sent it — no shared workgroup secret can impersonate another node.
 *
 * This module is pure: where the private key is kept (the DSH credential store,
 * §3.6) is the plugin's business.
 */
export type NodeIdentity = {
  /** base64url of the raw 32-byte Ed25519 public key. */
  orcaNodeId: OrcaNodeId;
  /** PKCS#8 PEM of the private half; it leaves the process only as `exportIdentity`. */
  privateKeyPem: string;
};

const RAW_KEY_BYTES = 32;
/** PKCS#8 header of an Ed25519 private key (RFC 8410) up to the 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI header of an Ed25519 public key (RFC 8410): SEQUENCE(30 2a) + OID(1.3.101.112) + BIT STRING. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Short label for UI/logs: first 6 and last 4 characters (any text works; labels also shorten unknown keys). */
export function shortenNodeId(orcaNodeId: string): string {
  if (orcaNodeId.length <= 12) return orcaNodeId;
  return `${orcaNodeId.slice(0, 6)}…${orcaNodeId.slice(-4)}`;
}

/** The node id of a public key: its raw 32 bytes in base64url (§7.1). */
function identityOf(privateKey: KeyObject): NodeIdentity {
  return {
    // The node id is the raw public key: the last bytes of its SPKI encoding.
    orcaNodeId: OrcaNodeIdSchema.parse(
      Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" }))
        .subarray(-RAW_KEY_BYTES)
        .toString("base64url"),
    ),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function generateNodeIdentity(): NodeIdentity {
  return identityOf(generateKeyPairSync("ed25519").privateKey);
}

/** The private key as it is stored: its 32-byte seed in base58. */
export function exportIdentity(identity: NodeIdentity): string {
  const der = createPrivateKey(identity.privateKeyPem).export({ format: "der", type: "pkcs8" });
  return bs58.encode(Buffer.from(der).subarray(-RAW_KEY_BYTES));
}

/** The identity of a stored private key; throws when the text is not a base58 Ed25519 seed. */
export function importIdentity(text: string): NodeIdentity {
  const seed = Buffer.from(bs58.decode(text));
  if (seed.length !== RAW_KEY_BYTES) throw new Error(`an Ed25519 private key is ${RAW_KEY_BYTES} bytes`);
  return identityOf(
    createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" }),
  );
}

export function signWithIdentity(identity: NodeIdentity, message: string | Uint8Array): string {
  return edSign(null, Buffer.from(message), identity.privateKeyPem).toString("base64url");
}

export function verifyWithNodeId(orcaNodeId: OrcaNodeId, message: string | Uint8Array, signature: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(orcaNodeId, "base64url")]),
      format: "der",
      type: "spki",
    });
    return edVerify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}
