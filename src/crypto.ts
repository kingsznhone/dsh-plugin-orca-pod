import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import {
  isNodeId,
  signWithIdentity,
  verifyWithNodeId,
  type NodeIdentity,
} from "./identity.ts";
import type { Grant, OrcaNodeId, SignedGrant } from "./protocol.ts";

export const AUTH_SCHEME = "Pod";
export const PROOF_VERSION = "pod-v1";
export const JOIN_PROOF_VERSION = "pod-join-v1";
export const KEY_DERIVATION_SALT = "orca-pod";
/**
 * Key-derivation version written into `config.json`. It exists so a node with a
 * key derived by an older (cheaper) KDF cannot silently keep using it: the
 * admission proof is HMAC over public fields, so a sniffed heartbeat is an
 * offline dictionary oracle unless each guess costs memory-hard work.
 */
export const KEY_DERIVATION = "scrypt-v1";
/** scrypt parameters: ~32 MiB, one derivation per start, ~100ms (§7.1). */
export const KEY_DERIVATION_N = 1 << 15;
export const KEY_DERIVATION_R = 8;
export const KEY_DERIVATION_P = 1;
const KEY_DERIVATION_MAX_MEM = 64 * 1024 * 1024;
export const DEFAULT_CLOCK_SKEW_MS = 60_000;
export const DEFAULT_NONCE_TTL_MS = 5 * 60_000;
export const DEFAULT_NONCE_CAPACITY = 10_000;

export type AuthErrorCode =
  | "missing_auth"
  | "malformed_auth"
  | "clock_skew"
  | "nonce_replay"
  | "bad_signature";

export class PodAuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "PodAuthError";
    this.code = code;
  }
}

/**
 * scrypt(password, salt="orca-pod\x00<workgroup_id>") -> 32 bytes.
 *
 * Memory-hard on purpose: the workgroup key backs the join/heartbeat HMAC
 * proofs over plaintext HTTP, so HKDF's cheap output made every sniffed proof
 * an offline dictionary target. scrypt is paid once per process start; the
 * salt binds the derivation to the workgroup id so the same password yields a
 * different key in another group.
 */
export function deriveWorkgroupKey(workgroupId: string, password: string): Buffer {
  const salt = Buffer.concat([
    Buffer.from(KEY_DERIVATION_SALT, "utf8"),
    Buffer.from([0]),
    Buffer.from(workgroupId, "utf8"),
  ]);
  return scryptSync(Buffer.from(password, "utf8"), salt, 32, {
    N: KEY_DERIVATION_N,
    r: KEY_DERIVATION_R,
    p: KEY_DERIVATION_P,
    maxmem: KEY_DERIVATION_MAX_MEM,
  });
}

export function bodySha256(body?: Uint8Array | string): string {
  const input = body === undefined
    ? Buffer.alloc(0)
    : typeof body === "string"
      ? Buffer.from(body, "utf8")
      : body;
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Request authentication (§7.1): every request is signed by the sending
// node's Ed25519 key; the orca node id *is* the public key, so verifying the
// signature also authenticates the identity. The workgroup password is used
// only for mesh admission (`buildJoinProof`), never to sign requests.
// ---------------------------------------------------------------------------

export type SignatureFields = {
  method: string;
  path: string;
  bodySha256: string;
  ts: number;
  nonce: string;
};

export function signatureInput(fields: SignatureFields): string {
  return [
    PROOF_VERSION,
    fields.method.toUpperCase(),
    fields.path,
    fields.bodySha256,
    String(fields.ts),
    fields.nonce,
  ].join("|");
}

export type AuthHeaderOptions = {
  identity: NodeIdentity;
  method: string;
  path: string;
  body?: Uint8Array | string;
  /**
   * Digest of a body that is streamed rather than held in memory (§5.6): the
   * caller hashes the file first and signs that digest.
   */
  bodySha256?: string;
  ts?: number;
  nonce?: string;
};

export function buildAuthHeader(options: AuthHeaderOptions): string {
  const ts = options.ts ?? Date.now();
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const signature = signWithIdentity(
    options.identity,
    signatureInput({
      method: options.method,
      path: options.path,
      bodySha256: options.bodySha256 ?? bodySha256(options.body),
      ts,
      nonce,
    }),
  );
  return `${AUTH_SCHEME} orca_node_id=${options.identity.orcaNodeId}; ts=${ts}; nonce=${nonce}; sig=${signature}`;
}

export type ParsedAuthHeader = {
  orcaNodeId: string;
  ts: number;
  nonce: string;
  signature: string;
};

export function parseAuthHeader(header: string | undefined): ParsedAuthHeader | null {
  if (!header) return null;
  const match = /^Pod\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const rest = match[1] ?? "";
  const fields = new Map<string, string>();
  for (const part of rest.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    fields.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const orcaNodeId = fields.get("orca_node_id");
  const ts = fields.get("ts");
  const nonce = fields.get("nonce");
  const signature = fields.get("sig") ?? fields.get("proof");
  if (!orcaNodeId || !ts || !nonce || !signature) return null;
  const tsValue = Number(ts);
  if (!Number.isSafeInteger(tsValue)) return null;
  return { orcaNodeId, ts: tsValue, nonce, signature };
}

/** Bounded set of recently seen nonces. remember() returns false on replay. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  readonly ttlMs: number;
  readonly capacity: number;

  constructor(ttlMs: number = DEFAULT_NONCE_TTL_MS, capacity: number = DEFAULT_NONCE_CAPACITY) {
    this.ttlMs = ttlMs;
    this.capacity = capacity;
  }

  remember(key: string, now: number = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(key, now + this.ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(key);
    }
  }
}

export type VerifyAuthOptions = {
  method: string;
  path: string;
  body?: Uint8Array | string;
  /** Digest signed by a streaming client; overrides hashing `body` when set. */
  bodySha256?: string;
  header: string | undefined;
  nonceCache: NonceCache;
  now?: number;
  skewMs?: number;
};

export type VerifiedAuth = {
  orcaNodeId: OrcaNodeId;
  ts: number;
  nonce: string;
};

export function verifyAuth(options: VerifyAuthOptions): VerifiedAuth {
  const parsed = parseAuthHeader(options.header);
  if (!parsed) {
    throw new PodAuthError(
      options.header ? "malformed_auth" : "missing_auth",
      options.header ? "malformed Authorization header" : "missing Authorization header",
    );
  }
  if (!isNodeId(parsed.orcaNodeId)) {
    throw new PodAuthError("malformed_auth", "orca_node_id in the Authorization header is not an Ed25519 public key");
  }
  const now = options.now ?? Date.now();
  const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (Math.abs(now - parsed.ts) > skewMs) {
    throw new PodAuthError("clock_skew", "timestamp outside the allowed skew window");
  }
  const valid = verifyWithNodeId(
    parsed.orcaNodeId,
    signatureInput({
      method: options.method,
      path: options.path,
      bodySha256: options.bodySha256 ?? bodySha256(options.body),
      ts: parsed.ts,
      nonce: parsed.nonce,
    }),
    parsed.signature,
  );
  if (!valid) throw new PodAuthError("bad_signature", "signature does not match");
  if (!options.nonceCache.remember(`${parsed.orcaNodeId}:${parsed.nonce}`, now)) {
    throw new PodAuthError("nonce_replay", "nonce already used");
  }
  return { orcaNodeId: parsed.orcaNodeId, ts: parsed.ts, nonce: parsed.nonce };
}

// ---------------------------------------------------------------------------
// Admission proof (§7.1): the workgroup password gates *joining* the mesh.
// ---------------------------------------------------------------------------

export type JoinProofFields = {
  workgroupId: string;
  orcaNodeId: string;
  ts: number;
  nonce: string;
};

export function joinProofInput(fields: JoinProofFields): string {
  return [
    JOIN_PROOF_VERSION,
    fields.workgroupId,
    fields.orcaNodeId,
    String(fields.ts),
    fields.nonce,
  ].join("|");
}

export function buildJoinProof(key: Buffer, fields: JoinProofFields): string {
  return createHmac("sha256", key).update(joinProofInput(fields)).digest("base64url");
}

export function verifyJoinProof(key: Buffer, fields: JoinProofFields, proof: string): boolean {
  const expected = Buffer.from(buildJoinProof(key, fields), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Heartbeat admission (§7.1): membership is proven on every heartbeat, not only
// at join. A node whose password changed carries a proof the old mesh cannot
// verify, so both sides stop answering and drop each other within a few ticks —
// rotating the password removes old members instead of only blocking new ones.
// ---------------------------------------------------------------------------

export const HEARTBEAT_PROOF_VERSION = "pod-hb-v1";

export function heartbeatProofInput(fields: JoinProofFields): string {
  return [
    HEARTBEAT_PROOF_VERSION,
    fields.workgroupId,
    fields.orcaNodeId,
    String(fields.ts),
    fields.nonce,
  ].join("|");
}

export function buildHeartbeatProof(key: Buffer, fields: JoinProofFields): string {
  return createHmac("sha256", key).update(heartbeatProofInput(fields)).digest("base64url");
}

export function verifyHeartbeatProof(key: Buffer, fields: JoinProofFields, proof: string): boolean {
  const expected = Buffer.from(buildHeartbeatProof(key, fields), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Grants (§7.11): the origin node signs its human decision with its own key;
// deriving a child grant keeps the origin signature verifiable at every hop.
// ---------------------------------------------------------------------------

export const GRANT_VERSION = "pod-grant-v1";

export function grantSignatureInput(grant: Grant): string {
  return [
    GRANT_VERSION,
    grant.grant_id,
    grant.workgroup_id,
    grant.task_id,
    grant.target_orca_node,
    grant.tool,
    grant.mode,
    grant.chain.join(","),
    grant.issued_at,
    grant.expires_at,
  ].join("|");
}

export function signGrant(identity: NodeIdentity, grant: Grant): SignedGrant {
  const sig = signWithIdentity(identity, grantSignatureInput(grant));
  return { ...grant, sig };
}

/** Verify a grant against the origin node that signed it (chain[0]). */
export function verifyGrant(originOrcaNodeId: string, grant: SignedGrant): boolean {
  if (typeof grant.sig !== "string" || grant.sig.length === 0) return false;
  return verifyWithNodeId(originOrcaNodeId, grantSignatureInput(grant), grant.sig);
}

/**
 * Capability URL for a blob (§5.6): `GET /blobs/:id?exp&sig` works without a
 * request signature, so a summary can paste the URL as-is. The URL is signed by
 * the serving node itself and verified with its own public key.
 */
export function blobLinkSignature(identity: NodeIdentity, blobId: string, exp: string): string {
  return signWithIdentity(identity, `blob-link-v1|${blobId}|${exp}`);
}

export function verifyBlobLinkSignature(
  orcaNodeId: string,
  blobId: string,
  exp: string,
  sig: string,
): boolean {
  return verifyWithNodeId(orcaNodeId, `blob-link-v1|${blobId}|${exp}`, sig);
}
