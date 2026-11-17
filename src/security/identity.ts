import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isOrcaNodeId } from "../protocol/index.ts";

/**
 * Per-node identity (§7.1): an Ed25519 keypair created at first start. The
 * orca node id *is* the public key, so any request a node signs proves which
 * node sent it — no shared workgroup secret can impersonate another node.
 */
export type NodeIdentity = {
  /** base64url of the raw 32-byte Ed25519 public key. */
  orcaNodeId: string;
  /** base64url of the raw public key; same as `orcaNodeId`, kept for clarity. */
  publicKey: string;
  /** PKCS#8 PEM of the private half. Stored only in `<data_root>/identity.json`. */
  privateKeyPem: string;
};

const RAW_KEY_BYTES = 32;

/** Short label for UI/logs: first 6 and last 4 characters. */
export function shortenNodeId(orcaNodeId: string): string {
  if (orcaNodeId.length <= 12) return orcaNodeId;
  return `${orcaNodeId.slice(0, 6)}…${orcaNodeId.slice(-4)}`;
}

function rawPublicKeyBase64(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = Buffer.from(der).subarray(-RAW_KEY_BYTES);
  return raw.toString("base64url");
}

function identityFromPrivateKeyPem(privateKeyPem: string): NodeIdentity {
  const publicKey = createPublicKey({ key: privateKeyPem, format: "pem" });
  const orcaNodeId = rawPublicKeyBase64(publicKey);
  return { orcaNodeId, publicKey: orcaNodeId, privateKeyPem };
}

export function generateNodeIdentity(): NodeIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const orcaNodeId = rawPublicKeyBase64(publicKey);
  return { orcaNodeId, publicKey: orcaNodeId, privateKeyPem };
}

export function signWithIdentity(identity: NodeIdentity, message: string | Uint8Array): string {
  return edSign(null, Buffer.from(message), identity.privateKeyPem).toString("base64url");
}

export function verifyWithNodeId(orcaNodeId: string, message: string | Uint8Array, signature: string): boolean {
  if (!isOrcaNodeId(orcaNodeId)) return false;
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

export function loadIdentity(dataRoot: string): NodeIdentity | null {
  const path = identityPath(dataRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const privateKeyPem = record.private_key_pem;
    if (typeof privateKeyPem !== "string" || privateKeyPem.length === 0) return null;
    return identityFromPrivateKeyPem(privateKeyPem);
  } catch {
    return null;
  }
}

function saveIdentity(dataRoot: string, identity: NodeIdentity): string {
  const path = identityPath(dataRoot);
  mkdirSync(dataRoot, { recursive: true });
  const payload = {
    orca_node_id: identity.orcaNodeId,
    public_key: identity.publicKey,
    private_key_pem: identity.privateKeyPem,
    created_at: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** Load the node identity, creating and persisting one on first start. */
export function loadOrCreateIdentity(dataRoot: string): NodeIdentity {
  const existing = loadIdentity(dataRoot);
  if (existing) return existing;
  const identity = generateNodeIdentity();
  saveIdentity(dataRoot, identity);
  return identity;
}
