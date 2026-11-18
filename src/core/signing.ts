import { createHash, randomBytes, scryptSync } from "node:crypto";

import { PodError } from "./errors.ts";
import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "./identity.ts";
import { isOrcaNodeId, type OrcaNodeId, type WorkgroupId } from "./wire/peer.ts";

const AUTH_SCHEME = "Pod";
/**
 * Domain-separation tags. The request signature binds the receiver id and the
 * full request URL (path *and* query): a request captured from one node cannot
 * be replayed against another node or with different query parameters.
 */
const REQUEST_DOMAIN = "orca-pod/request";
const KEY_DERIVATION_SALT = "orca-pod";
/** scrypt parameters: ~32 MiB, one derivation per start, ~100ms (§7.1). */
const KEY_DERIVATION_N = 1 << 15;
const KEY_DERIVATION_R = 8;
const KEY_DERIVATION_P = 1;
const KEY_DERIVATION_MAX_MEM = 64 * 1024 * 1024;
export const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_NONCE_TTL_MS = 5 * 60_000;
const DEFAULT_NONCE_CAPACITY = 10_000;

/**
 * scrypt(password, salt="orca-pod\x00<workgroup_id>") -> 32 bytes.
 *
 * Memory-hard on purpose: the workgroup key backs the join/heartbeat HMAC
 * proofs over plaintext HTTP, so HKDF's cheap output made every sniffed proof
 * an offline dictionary target. scrypt is paid once per process start; the
 * salt binds the derivation to the workgroup id so the same password yields a
 * different key in another group.
 */
export function deriveWorkgroupKey(workgroupId: WorkgroupId, password: string): Buffer {
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
  const input = body === undefined ? Buffer.alloc(0) : typeof body === "string" ? Buffer.from(body, "utf8") : body;
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Request authentication (§7.1): every request is signed by the sending
// node's Ed25519 key; the orca node id *is* the public key, so verifying the
// signature also authenticates the identity. The workgroup password is used
// only for mesh admission (`admissionProof`), never to sign requests.
// ---------------------------------------------------------------------------

type SignatureFields = {
  method: string;
  /** Request target on the receiver, path *and* query included (§7.1). */
  url: string;
  /** The node the request is addressed to; empty only for a first join. */
  targetOrcaNodeId: string;
  bodySha256: string;
  ts: number;
  nonce: string;
};

function signatureInput(fields: SignatureFields): string {
  return [
    REQUEST_DOMAIN,
    fields.method.toUpperCase(),
    fields.targetOrcaNodeId,
    fields.url,
    fields.bodySha256,
    String(fields.ts),
    fields.nonce,
  ].join("|");
}

type AuthHeaderOptions = {
  identity: NodeIdentity;
  method: string;
  url: string;
  targetOrcaNodeId?: string;
  body?: Uint8Array | string;
  ts?: number;
  nonce?: string;
};

export function buildAuthHeader(options: AuthHeaderOptions): string {
  const ts = options.ts ?? Date.now();
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const target = options.targetOrcaNodeId ?? "";
  const signature = signWithIdentity(
    options.identity,
    signatureInput({
      method: options.method,
      url: options.url,
      targetOrcaNodeId: target,
      bodySha256: bodySha256(options.body),
      ts,
      nonce,
    }),
  );
  const targetField = target === "" ? "" : `target=${target}; `;
  return `${AUTH_SCHEME} orca_node_id=${options.identity.orcaNodeId}; ${targetField}ts=${ts}; nonce=${nonce}; sig=${signature}`;
}

type ParsedAuthHeader = {
  /** As sent; `verifyAuth` checks that it is a node id. */
  orcaNodeId: string;
  target: string;
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
  const signature = fields.get("sig");
  if (!orcaNodeId || !ts || !nonce || !signature) return null;
  const tsValue = Number(ts);
  if (!Number.isSafeInteger(tsValue)) return null;
  return { orcaNodeId, target: fields.get("target") ?? "", ts: tsValue, nonce, signature };
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
  url: string;
  /** This node's id; a request addressed to another node is rejected. */
  targetOrcaNodeId: string;
  /** `/cluster/join` cannot know the receiver's id before first contact. */
  allowEmptyTarget?: boolean;
  /** Reject requests issued before this process started: blocks restart replay. */
  notBefore: number;
  body?: Uint8Array | string;
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
  if (!options.header) throw new PodError("missing_auth", "missing Authorization header");
  const parsed = parseAuthHeader(options.header);
  if (!parsed) throw new PodError("malformed_auth", "malformed Authorization header");
  if (!isOrcaNodeId(parsed.orcaNodeId)) {
    throw new PodError("malformed_auth", "orca_node_id in the Authorization header is not an Ed25519 public key");
  }
  const now = options.now ?? Date.now();
  const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (Math.abs(now - parsed.ts) > skewMs) {
    throw new PodError("clock_skew", "timestamp outside the allowed skew window");
  }
  if (parsed.ts < options.notBefore) {
    throw new PodError("stale_request", "timestamp predates this node process; restart replay rejected");
  }
  if (parsed.target === "") {
    if (options.allowEmptyTarget !== true) {
      throw new PodError("wrong_target", "request is not bound to a target orca node");
    }
  } else if (parsed.target !== options.targetOrcaNodeId) {
    throw new PodError("wrong_target", "request is addressed to another orca node");
  }
  const valid = verifyWithNodeId(
    parsed.orcaNodeId,
    signatureInput({
      method: options.method,
      url: options.url,
      targetOrcaNodeId: parsed.target,
      bodySha256: bodySha256(options.body),
      ts: parsed.ts,
      nonce: parsed.nonce,
    }),
    parsed.signature,
  );
  if (!valid) throw new PodError("bad_signature", "signature does not match");
  if (!options.nonceCache.remember(`${parsed.orcaNodeId}:${parsed.nonce}`, now)) {
    throw new PodError("nonce_replay", "nonce already used");
  }
  return { orcaNodeId: parsed.orcaNodeId, ts: parsed.ts, nonce: parsed.nonce };
}
