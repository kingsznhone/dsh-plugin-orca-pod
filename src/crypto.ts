import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeOrcaNodeId, type OrcaNodeId } from "./protocol.ts";

export const AUTH_SCHEME = "Pod";
export const PROOF_VERSION = "pod-v1";
export const KEY_DERIVATION_SALT = "orca-pod";
export const DEFAULT_CLOCK_SKEW_MS = 60_000;
export const DEFAULT_NONCE_TTL_MS = 5 * 60_000;
export const DEFAULT_NONCE_CAPACITY = 10_000;

export type AuthErrorCode =
  | "missing_auth"
  | "malformed_auth"
  | "clock_skew"
  | "nonce_replay"
  | "bad_proof";

export class PodAuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = "PodAuthError";
    this.code = code;
  }
}

/** HKDF-SHA256(password, salt="orca-pod", info=workgroup_id) -> 32 bytes. */
export function deriveWorkgroupKey(workgroupId: string, password: string): Buffer {
  const derived = hkdfSync(
    "sha256",
    Buffer.from(password, "utf8"),
    Buffer.from(KEY_DERIVATION_SALT, "utf8"),
    Buffer.from(workgroupId, "utf8"),
    32,
  );
  return Buffer.from(derived);
}

export function bodySha256(body?: Uint8Array | string): string {
  const input = body === undefined
    ? Buffer.alloc(0)
    : typeof body === "string"
      ? Buffer.from(body, "utf8")
      : body;
  return createHash("sha256").update(input).digest("hex");
}

export type ProofFields = {
  method: string;
  path: string;
  bodySha256: string;
  ts: number;
  nonce: string;
};

export function proofInput(fields: ProofFields): string {
  return [
    PROOF_VERSION,
    fields.method.toUpperCase(),
    fields.path,
    fields.bodySha256,
    String(fields.ts),
    fields.nonce,
  ].join("|");
}

export function computeProof(key: Buffer, fields: ProofFields): string {
  return createHmac("sha256", key).update(proofInput(fields)).digest("base64url");
}

export type AuthHeaderOptions = {
  key: Buffer;
  orcaNodeId: OrcaNodeId;
  method: string;
  path: string;
  body?: Uint8Array | string;
  ts?: number;
  nonce?: string;
};

export function buildAuthHeader(options: AuthHeaderOptions): string {
  const ts = options.ts ?? Date.now();
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const proof = computeProof(options.key, {
    method: options.method,
    path: options.path,
    bodySha256: bodySha256(options.body),
    ts,
    nonce,
  });
  return `${AUTH_SCHEME} orca_node_id=${options.orcaNodeId}; ts=${ts}; nonce=${nonce}; proof=${proof}`;
}

export type ParsedAuthHeader = {
  orcaNodeId: string;
  ts: number;
  nonce: string;
  proof: string;
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
  const proof = fields.get("proof");
  if (!orcaNodeId || !ts || !nonce || !proof) return null;
  const tsValue = Number(ts);
  if (!Number.isSafeInteger(tsValue)) return null;
  return { orcaNodeId, ts: tsValue, nonce, proof };
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
  key: Buffer;
  method: string;
  path: string;
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
  const parsed = parseAuthHeader(options.header);
  if (!parsed) {
    throw new PodAuthError(
      options.header ? "malformed_auth" : "missing_auth",
      options.header ? "malformed Authorization header" : "missing Authorization header",
    );
  }
  const orcaNodeId = normalizeOrcaNodeId(parsed.orcaNodeId);
  if (!orcaNodeId) {
    throw new PodAuthError("malformed_auth", "orca_node_id in Authorization header is not a valid orca node id");
  }
  const now = options.now ?? Date.now();
  const skewMs = options.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
  if (Math.abs(now - parsed.ts) > skewMs) {
    throw new PodAuthError("clock_skew", "timestamp outside the allowed skew window");
  }
  const expected = computeProof(options.key, {
    method: options.method,
    path: options.path,
    bodySha256: bodySha256(options.body),
    ts: parsed.ts,
    nonce: parsed.nonce,
  });
  const actualBytes = Buffer.from(parsed.proof, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new PodAuthError("bad_proof", "signature does not match");
  }
  if (!options.nonceCache.remember(`${orcaNodeId}:${parsed.nonce}`, now)) {
    throw new PodAuthError("nonce_replay", "nonce already used");
  }
  return { orcaNodeId, ts: parsed.ts, nonce: parsed.nonce };
}
