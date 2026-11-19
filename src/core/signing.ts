import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { PodError } from "./errors.ts";
import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "./identity.ts";
import { OrcaNodeIdSchema, WorkgroupIdSchema, type OrcaNodeId, type WorkgroupId } from "./ids.ts";

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
const CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_CAPACITY = 10_000;

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

/** A request as both proofs cover it: what is sent, and where on the receiver. */
type SignedRequest = {
  method: string;
  /** Request target on the receiver, path *and* query included (§7.1). */
  url: string;
  body?: Uint8Array | string;
};

/**
 * What the sender states about a request in its header, covered by both proofs
 * together with the request. The sender's id is not part of it: it is the key
 * the signature is checked with.
 */
type RequestClaim = {
  /** The node the request is addressed to; empty only for a first contact, which cannot know it yet. */
  target: string;
  workgroupId: WorkgroupId;
  /** When it was sent, in ms; the receiver refuses it outside the skew window. */
  ts: number;
  /** Fresh per request (`newNonce`); the sender keeps it to check the reply against. */
  nonce: string;
};

function signatureInput(request: SignedRequest, claim: RequestClaim): string {
  return [
    REQUEST_DOMAIN,
    request.method.toUpperCase(),
    claim.target,
    request.url,
    bodySha256(request.body),
    String(claim.ts),
    claim.nonce,
    claim.workgroupId,
  ].join("|");
}

function hmacOf(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("base64url");
}

/** A fresh request nonce. The caller keeps it to check the reply against. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** The `Authorization` header of a request: the claim, the sender's signature, and the proof made with the workgroup `key`. */
export function buildAuthHeader(
  identity: NodeIdentity,
  key: Buffer,
  request: SignedRequest,
  claim: RequestClaim,
): string {
  const input = signatureInput(request, claim);
  const signature = signWithIdentity(identity, input);
  const proof = hmacOf(key, input);
  const target = claim.target === "" ? "" : `target=${claim.target}; `;
  return `${AUTH_SCHEME} id=${identity.orcaNodeId}; wg=${claim.workgroupId}; ${target}ts=${claim.ts}; nonce=${claim.nonce}; sig=${signature}; proof=${proof}`;
}

/** An `Authorization` header as received: who claims to send it, what it claims, and the two proofs, not yet checked. */
type AuthHeader = { orcaNodeId: OrcaNodeId; claim: RequestClaim; signature: string; proof: string };

/** Read an `Authorization` header; null when it is not one of this protocol (a field missing, an id that is not one). */
export function parseAuthHeader(header: string | undefined): AuthHeader | null {
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
  const sender = OrcaNodeIdSchema.safeParse(fields.get("id"));
  const workgroup = WorkgroupIdSchema.safeParse(fields.get("wg"));
  const ts = Number(fields.get("ts") || Number.NaN);
  const nonce = fields.get("nonce");
  const signature = fields.get("sig");
  const proof = fields.get("proof");
  if (!sender.success || !workgroup.success || !Number.isSafeInteger(ts) || !nonce || !signature || !proof) return null;
  return {
    orcaNodeId: sender.data,
    claim: { target: fields.get("target") ?? "", workgroupId: workgroup.data, ts, nonce },
    signature,
    proof,
  };
}

/** Bounded set of recently seen nonces. remember() returns false on replay. */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  remember(key: string): boolean {
    const now = Date.now();
    this.prune(now);
    if (this.seen.has(key)) return false;
    if (this.seen.size >= NONCE_CAPACITY) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(key, now + NONCE_TTL_MS);
    return true;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > now) break;
      this.seen.delete(key);
    }
  }
}

type VerifyAuthOptions = {
  /** The request as it arrived. */
  request: SignedRequest;
  header: string | undefined;
  /** This node's id; a request addressed to another node is rejected. */
  selfOrcaNodeId: string;
  /** The workgroup this node is in; a request for another is rejected. */
  workgroupId: WorkgroupId;
  /** The workgroup key the `proof` must have been made with. */
  key: Buffer;
  /** A first contact cannot know the receiver's id before it has met it. */
  allowEmptyTarget?: boolean;
  /** Reject requests issued before this process started: blocks restart replay. */
  notBefore: number;
  nonceCache: NonceCache;
};

/** Who sent a request whose proofs held. */
export type VerifiedAuth = { orcaNodeId: OrcaNodeId };

export function verifyAuth(options: VerifyAuthOptions): VerifiedAuth {
  if (!options.header) throw new PodError("missing_auth", "missing Authorization header");
  const parsed = parseAuthHeader(options.header);
  if (!parsed) throw new PodError("malformed_auth", "malformed Authorization header");
  const { claim } = parsed;
  if (Math.abs(Date.now() - claim.ts) > CLOCK_SKEW_MS) {
    throw new PodError("clock_skew", "timestamp outside the allowed skew window");
  }
  if (claim.ts < options.notBefore) {
    throw new PodError("stale_request", "timestamp predates this node process; restart replay rejected");
  }
  if (claim.target === "") {
    if (options.allowEmptyTarget !== true) {
      throw new PodError("wrong_target", "request is not bound to a target orca node");
    }
  } else if (claim.target !== options.selfOrcaNodeId) {
    throw new PodError("wrong_target", "request is addressed to another orca node");
  }
  if (claim.workgroupId !== options.workgroupId) {
    throw new PodError("workgroup_mismatch", "workgroup_id does not match this orca node");
  }
  const input = signatureInput(options.request, claim);
  if (!verifyWithNodeId(parsed.orcaNodeId, input, parsed.signature)) {
    throw new PodError("bad_signature", "signature does not match");
  }
  // After the signature, so only a node that exists can make a caller learn the workgroup was wrong.
  const expected = Buffer.from(hmacOf(options.key, input), "base64url");
  const proof = Buffer.from(parsed.proof, "base64url");
  if (expected.length !== proof.length || !timingSafeEqual(expected, proof)) {
    throw new PodError("bad_proof", "workgroup proof does not verify");
  }
  if (!options.nonceCache.remember(`${parsed.orcaNodeId}:${claim.nonce}`)) {
    throw new PodError("nonce_replay", "nonce already used");
  }
  return { orcaNodeId: parsed.orcaNodeId };
}

// ---------------------------------------------------------------------------
// Reply authentication (§7.1): the answering node signs what it says, bound to
// the nonce of the request, so a reply can be neither changed nor moved to answer
// another request. `subject` is the sha256 of the body, or, for a streamed file
// whose hash is not known before the first byte, `blob:<blob_id>`: the bytes are
// then checked against the name the file was published under.
// ---------------------------------------------------------------------------

/** The name of the reply header, lower case as Fastify and `fetch` both see it. */
export const REPLY_HEADER = "pod-reply";

type ReplyFields = { nonce: string; status: number; subject: string };

function replyInput({ nonce, status, subject }: ReplyFields): string {
  return [REPLY_DOMAIN, nonce, String(status), subject].join("|");
}

/** The `Pod-Reply` header value an answering node sends. */
export function buildReplyHeader(identity: NodeIdentity, fields: ReplyFields): string {
  return `id=${identity.orcaNodeId}; sig=${signWithIdentity(identity, replyInput(fields))}`;
}

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
  const signature = values.get("sig");
  const id = OrcaNodeIdSchema.safeParse(values.get("id"));
  if (!id.success || !signature) return null;
  return verifyWithNodeId(id.data, replyInput(fields), signature) ? id.data : null;
}
