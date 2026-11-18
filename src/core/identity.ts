import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

import { errorMessage, isMissingFile } from "./errors.ts";
import { OrcaNodeIdSchema, type OrcaNodeId } from "./wire/peer.ts";

/**
 * Per-node identity (§7.1): an Ed25519 keypair created at first start. The
 * orca node id *is* the public key, so any request a node signs proves which
 * node sent it — no shared workgroup secret can impersonate another node.
 */
export type NodeIdentity = {
  /** base64url of the raw 32-byte Ed25519 public key. */
  orcaNodeId: OrcaNodeId;
  /** PKCS#8 PEM of the private half. Stored only in `<data_root>/identity.json`. */
  privateKeyPem: string;
};

/**
 * What `<data_root>/identity.json` holds. Only the private key is read back:
 * the id is derived from it, so a hand-edited id cannot disagree with the key.
 */
const IdentityFileSchema = z.object({
  orca_node_id: OrcaNodeIdSchema,
  private_key_pem: z.string().min(1),
  created_at: z.string(),
});
type IdentityFile = z.infer<typeof IdentityFileSchema>;

const RAW_KEY_BYTES = 32;

/** Short label for UI/logs: first 6 and last 4 characters (any text works; labels also shorten unknown keys). */
export function shortenNodeId(orcaNodeId: string): string {
  if (orcaNodeId.length <= 12) return orcaNodeId;
  return `${orcaNodeId.slice(0, 6)}…${orcaNodeId.slice(-4)}`;
}

/** The node id of a public key: its raw 32 bytes in base64url (§7.1). */
function nodeIdOfPublicKey(publicKey: KeyObject): OrcaNodeId {
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(-RAW_KEY_BYTES);
  return OrcaNodeIdSchema.parse(raw.toString("base64url"));
}

function identityFromPrivateKeyPem(privateKeyPem: string): NodeIdentity {
  const publicKey = createPublicKey({ key: privateKeyPem, format: "pem" });
  const orcaNodeId = nodeIdOfPublicKey(publicKey);
  return { orcaNodeId, privateKeyPem };
}

export function generateNodeIdentity(): NodeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const orcaNodeId = nodeIdOfPublicKey(publicKey);
  return { orcaNodeId, privateKeyPem };
}

export function signWithIdentity(identity: NodeIdentity, message: string | Uint8Array): string {
  return edSign(null, Buffer.from(message), identity.privateKeyPem).toString("base64url");
}

export function verifyWithNodeId(orcaNodeId: OrcaNodeId, message: string | Uint8Array, signature: string): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        // SPKI header for Ed25519 (RFC 8410): SEQUENCE(30 2a) + OID(1.3.101.112) + BIT STRING.
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(orcaNodeId, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    return edVerify(null, Buffer.from(message), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function identityPath(dataRoot: string): string {
  return join(dataRoot, "identity.json");
}

/**
 * The node identity, or null when `identity.json` does not exist yet. A file
 * that exists but cannot be read or parsed is an error, never "no identity":
 * silently generating a new key would give the node a different id (B6).
 */
export function loadIdentity(dataRoot: string): NodeIdentity | null {
  const path = identityPath(dataRoot);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw new Error(`cannot read ${path}: ${errorMessage(error)}`);
  }
  const file = IdentityFileSchema.pick({ private_key_pem: true }).safeParse(parseJson(text));
  const identity = file.success ? identityFromPrivateKeyPem(file.data.private_key_pem) : null;
  if (identity === null)
    throw new Error(
      `${path} does not hold a valid Ed25519 private key; restore it or remove it to create a new identity`,
    );
  return identity;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The identity of the node `expected`: `config.json` and `identity.json` must agree on who this node is. */
export function requireIdentity(dataRoot: string, expected: OrcaNodeId): NodeIdentity {
  const identity = loadIdentity(dataRoot);
  if (identity === null || identity.orcaNodeId !== expected) {
    throw new Error("identity.json is missing or does not match config.orca_node_id");
  }
  return identity;
}

/**
 * Load the node identity, creating and persisting one on first start. The
 * check and the write run under DSH's file lock and the write is atomic, so two
 * processes starting together end up with the same identity.
 */
export async function loadOrCreateIdentity(dataRoot: string): Promise<NodeIdentity> {
  const path = identityPath(dataRoot);
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  return withFileLock(path, async () => {
    const existing = loadIdentity(dataRoot);
    if (existing !== null) return existing;
    const identity = generateNodeIdentity();
    const payload: IdentityFile = {
      orca_node_id: identity.orcaNodeId,
      private_key_pem: identity.privateKeyPem,
      created_at: new Date().toISOString(),
    };
    await writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return identity;
  });
}
