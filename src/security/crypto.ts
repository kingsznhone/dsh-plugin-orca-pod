import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import { isOrcaNodeId } from "../protocol/peer.ts";
import type { Admission, AdmissionKind } from "../protocol/cluster.ts";
import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "./identity.ts";
import { PodError } from "../kernel/errors.ts";
import type { Grant, SignedGrant } from "../protocol/grant.ts";
import type { OrcaNodeId } from "../protocol/peer.ts";

const AUTH_SCHEME = "Pod";
/**
 * Domain-separation tags. The request signature binds the receiver id and the
 * full request URL (path *and* query): a request captured from one node cannot
 * be replayed against another node or with different query parameters.
 */
const REQUEST_DOMAIN = "orca-pod/request";
const ADMISSION_DOMAIN: Record<AdmissionKind, string> = { join: "orca-pod/join", heartbeat: "orca-pod/heartbeat" };
const GRANT_DOMAIN = "orca-pod/grant";
const BLOB_LINK_DOMAIN = "orca-pod/blob-link";
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
  const target = options.targetOrcaNodeId ?? "";
  const signature = signWithIdentity(
    options.identity,
    signatureInput({
      method: options.method,
      url: options.url,
      targetOrcaNodeId: target,
      bodySha256: options.bodySha256 ?? bodySha256(options.body),
      ts,
      nonce,
    }),
  );
  const targetField = target === "" ? "" : `target=${target}; `;
  return `${AUTH_SCHEME} orca_node_id=${options.identity.orcaNodeId}; ${targetField}ts=${ts}; nonce=${nonce}; sig=${signature}`;
}

type ParsedAuthHeader = {
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
      bodySha256: options.bodySha256 ?? bodySha256(options.body),
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

// ---------------------------------------------------------------------------
// Admission proof (§7.1): the workgroup password gates *joining* the mesh.
// ---------------------------------------------------------------------------

type AdmissionFields = {
  workgroupId: string;
  orcaNodeId: string;
  ts: number;
  nonce: string;
};

/**
 * HMAC over the admission fields, keyed by the password-derived workgroup key.
 * `join` gates entry to the mesh; `heartbeat` repeats the proof on every beat
 * (§7.1): a node whose password changed carries a proof the old mesh cannot
 * verify, so both sides stop answering and drop each other within a few ticks.
 */
export function admissionProof(kind: AdmissionKind, key: Buffer, fields: AdmissionFields): string {
  const input = [ADMISSION_DOMAIN[kind], fields.workgroupId, fields.orcaNodeId, String(fields.ts), fields.nonce].join(
    "|",
  );
  return createHmac("sha256", key).update(input).digest("base64url");
}

export function verifyAdmissionProof(
  kind: AdmissionKind,
  key: Buffer,
  fields: AdmissionFields,
  proof: string,
): boolean {
  const expected = Buffer.from(admissionProof(kind, key, fields), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A fresh admission for `kind`: this node's ids, now, a new nonce and the proof over them. */
export function createAdmission(
  kind: AdmissionKind,
  key: Buffer,
  ids: { workgroupId: string; orcaNodeId: string },
): Admission {
  const ts = Date.now();
  const nonce = randomUUID();
  const proof = admissionProof(kind, key, { ...ids, ts, nonce });
  return { workgroup_id: ids.workgroupId, orca_node_id: ids.orcaNodeId, ts, nonce, proof };
}

/** True when the proof in a received admission was made with `key` over exactly its own fields. */
export function verifyAdmission(kind: AdmissionKind, key: Buffer, admission: Admission): boolean {
  const { workgroup_id: workgroupId, orca_node_id: orcaNodeId, ts, nonce, proof } = admission;
  return verifyAdmissionProof(kind, key, { workgroupId, orcaNodeId, ts, nonce }, proof);
}

// ---------------------------------------------------------------------------
// Grants (§7.11): the origin node signs its human decision with its own key;
// deriving a child grant keeps the origin signature verifiable at every hop.
// ---------------------------------------------------------------------------

/**
 * The signature covers every grant field, including the deciding origin and the
 * request id. Writing them as canonical JSON (fixed key order, no optional
 * trailing fields) avoids the ambiguity of `|`-joined values: a grant cannot be
 * re-labelled with a different origin or replayed for another request.
 */
function grantSignatureInput(grant: Grant): string {
  return `${GRANT_DOMAIN}\n${JSON.stringify({
    grant_id: grant.grant_id,
    workgroup_id: grant.workgroup_id,
    origin_orca_node: grant.origin_orca_node,
    task_id: grant.task_id,
    target_orca_node: grant.target_orca_node,
    tool: grant.tool,
    mode: grant.mode,
    chain: grant.chain,
    request_id: grant.request_id,
    issued_at: grant.issued_at,
    expires_at: grant.expires_at,
  })}`;
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
  return signWithIdentity(identity, `${BLOB_LINK_DOMAIN}|${blobId}|${exp}`);
}

/** The capability URL of a blob on the node at `endpoint`; `exp` is epoch seconds, as text (§5.6). */
export function signedBlobUrl(identity: NodeIdentity, endpoint: string, blobId: string, exp: string): string {
  return `${endpoint.replace(/\/+$/, "")}/blobs/${blobId}?exp=${exp}&sig=${blobLinkSignature(identity, blobId, exp)}`;
}

export function verifyBlobLinkSignature(orcaNodeId: string, blobId: string, exp: string, sig: string): boolean {
  return verifyWithNodeId(orcaNodeId, `${BLOB_LINK_DOMAIN}|${blobId}|${exp}`, sig);
}
