import { createHash, createHmac, randomBytes } from "node:crypto";

import { signWithIdentity, verifyWithNodeId, type NodeIdentity } from "./identity.ts";
import { OrcaNodeIdSchema, type OrcaNodeId, type WorkgroupId } from "./ids.ts";

const AUTH_SCHEME = "Pod";
/**
 * Domain-separation tags. The request signature binds the receiver id, the workgroup
 * and the full request URL (path *and* query): a request captured from one node
 * cannot be replayed against another node or with different query parameters. A
 * reply is bound to the nonce of the request it answers.
 */
const REQUEST_DOMAIN = "orca-pod/request";
const REPLY_DOMAIN = "orca-pod/reply";

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
export type SignedRequest = {
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
export type RequestClaim = {
  /** The node the request is addressed to; empty only for a first contact, which cannot know it yet. */
  target: string;
  workgroupId: WorkgroupId;
  /** When it was sent, in ms; the receiver refuses it outside the skew window. */
  ts: number;
  /** Fresh per request (`newNonce`); the sender keeps it to check the reply against. */
  nonce: string;
};

/** What both proofs of a request are made over. */
export function signatureInput(request: SignedRequest, claim: RequestClaim): string {
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

/** The workgroup proof over `input`, made with the key derived from the password. */
export function hmacOf(key: Buffer, input: string): string {
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
