import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { PodError } from "./errors.ts";
import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "./identity.ts";
import { isOrcaNodeId, isWorkgroupId, type OrcaNodeId, type WorkgroupId } from "./wire/peer.ts";

const AUTH_SCHEME = "Pod";
/**
 * Domain-separation tags. The request signature binds the receiver id, the workgroup
 * and the full request URL (path *and* query): a request captured from one node
 * cannot be replayed against another node or with different query parameters. A
 * reply is bound to the nonce of the request it answers.
 */
const REQUEST_DOMAIN = "orca-pod/request";
const REPLY_DOMAIN = "orca-pod/reply";
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
 * Memory-hard on purpose: the workgroup key backs the HMAC proof of every
 * request over plaintext HTTP, so HKDF's cheap output made every sniffed proof
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
// Request authentication (§7.1): every request carries two proofs in its
// Authorization header, over the same input. `sig` is the sending node's
// Ed25519 signature: the orca node id *is* the public key, so verifying it
// authenticates the node and shows that method, path, receiver and body were not
// changed. `proof` is an HMAC with the workgroup key derived from the password:
// it shows the sender is in the workgroup *now*, so a node whose password changed
// is refused on its very next request. Neither alone is enough: anyone can make a
// key pair, and a password alone would let one member speak as another.
// ---------------------------------------------------------------------------

type SignatureFields = {
  method: string;
  /** Request target on the receiver, path *and* query included (§7.1). */
  url: string;
  /** The node the request is addressed to; empty only for a first contact. */
  targetOrcaNodeId: string;
  workgroupId: string;
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
    fields.workgroupId,
  ].join("|");
}

function hmacOf(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("base64url");
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "base64url");
  const b = Buffer.from(right, "base64url");
  return a.length === b.length && timingSafeEqual(a, b);
}

type AuthHeaderOptions = {
  identity: NodeIdentity;
  /** The workgroup key: what the `proof` is made with. */
  key: Buffer;
  workgroupId: WorkgroupId;
  method: string;
  url: string;
  targetOrcaNodeId?: string;
  body?: Uint8Array | string;
  ts?: number;
  nonce?: string;
};

/** A fresh request nonce. The caller keeps it to check the reply against. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function buildAuthHeader(options: AuthHeaderOptions): string {
  const ts = options.ts ?? Date.now();
  const nonce = options.nonce ?? newNonce();
  const target = options.targetOrcaNodeId ?? "";
  const input = signatureInput({
    method: options.method,
    url: options.url,
    targetOrcaNodeId: target,
    workgroupId: options.workgroupId,
    bodySha256: bodySha256(options.body),
    ts,
    nonce,
  });
  const signature = signWithIdentity(options.identity, input);
  const proof = hmacOf(options.key, input);
  const targetField = target === "" ? "" : `target=${target}; `;
  return `${AUTH_SCHEME} id=${options.identity.orcaNodeId}; wg=${options.workgroupId}; ${targetField}ts=${ts}; nonce=${nonce}; sig=${signature}; proof=${proof}`;
}

type ParsedAuthHeader = {
  /** As sent; `verifyAuth` checks that it is a node id. */
  orcaNodeId: string;
  workgroupId: string;
  target: string;
  ts: number;
  nonce: string;
  signature: string;
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
  const orcaNodeId = fields.get("id");
  const workgroupId = fields.get("wg");
  const ts = fields.get("ts");
  const nonce = fields.get("nonce");
  const signature = fields.get("sig");
  const proof = fields.get("proof");
  if (!orcaNodeId || !workgroupId || !ts || !nonce || !signature || !proof) return null;
  const tsValue = Number(ts);
  if (!Number.isSafeInteger(tsValue)) return null;
  return { orcaNodeId, workgroupId, target: fields.get("target") ?? "", ts: tsValue, nonce, signature, proof };
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
  /** The workgroup this node is in; a request for another is rejected. */
  workgroupId: WorkgroupId;
  /** The workgroup key the `proof` must have been made with. */
  key: Buffer;
  /** A first contact cannot know the receiver's id before it has met it. */
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
    throw new PodError("malformed_auth", "id in the Authorization header is not an Ed25519 public key");
  }
  if (!isWorkgroupId(parsed.workgroupId)) {
    throw new PodError("malformed_auth", "wg in the Authorization header is not a workgroup id");
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
  if (parsed.workgroupId !== options.workgroupId) {
    throw new PodError("workgroup_mismatch", "workgroup_id does not match this orca node");
  }
  const input = signatureInput({
    method: options.method,
    url: options.url,
    targetOrcaNodeId: parsed.target,
    workgroupId: parsed.workgroupId,
    bodySha256: bodySha256(options.body),
    ts: parsed.ts,
    nonce: parsed.nonce,
  });
  if (!verifyWithNodeId(parsed.orcaNodeId, input, parsed.signature)) {
    throw new PodError("bad_signature", "signature does not match");
  }
  // After the signature, so only a node that exists can make a caller learn the workgroup was wrong.
  if (!sameText(hmacOf(options.key, input), parsed.proof)) {
    throw new PodError("bad_proof", "workgroup proof does not verify");
  }
  if (!options.nonceCache.remember(`${parsed.orcaNodeId}:${parsed.nonce}`, now)) {
    throw new PodError("nonce_replay", "nonce already used");
  }
  return { orcaNodeId: parsed.orcaNodeId, ts: parsed.ts, nonce: parsed.nonce };
}

// ---------------------------------------------------------------------------
// Reply authentication (§7.1): the answering node signs what it says, bound to
// the nonce of the request, so a reply can be neither changed nor moved to answer
// another request. `subject` is the sha256 of the body, or, for a streamed file
// whose hash is not known before the first byte, `blob:<blob_id>`: the bytes are
// then checked against the name the file was published under.
// ---------------------------------------------------------------------------

const REPLY_HEADER = "pod-reply";

type ReplyFields = { nonce: string; status: number; subject: string };

function replyInput({ nonce, status, subject }: ReplyFields): string {
  return [REPLY_DOMAIN, nonce, String(status), subject].join("|");
}

/** The `Pod-Reply` header value an answering node sends. */
export function buildReplyHeader(identity: NodeIdentity, fields: ReplyFields): string {
  return `id=${identity.orcaNodeId}; sig=${signWithIdentity(identity, replyInput(fields))}`;
}

/** The name of the reply header, lower case as Fastify and `fetch` both see it. */
export const REPLY_HEADER_NAME = REPLY_HEADER;

/**
 * The node that signed a reply, or null when the header is absent, malformed or
 * its signature does not hold for these fields.
 */
export function verifyReplyHeader(header: string | null | undefined, fields: ReplyFields): OrcaNodeId | null {
  if (!header) return null;
  const values = new Map<string, string>();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    values.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  const id = values.get("id");
  const signature = values.get("sig");
  if (!id || !signature || !isOrcaNodeId(id)) return null;
  return verifyWithNodeId(id, replyInput(fields), signature) ? id : null;
}
