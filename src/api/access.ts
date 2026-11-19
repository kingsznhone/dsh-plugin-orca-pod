import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { PodError } from "../core/errors.ts";
import { verifyWithNodeId } from "../core/identity.ts";
import { OrcaNodeIdSchema, WorkgroupIdSchema, type OrcaNodeId, type WorkgroupId } from "../core/ids.ts";
import { hmacOf, signatureInput, type RequestClaim } from "../core/signing.ts";

const CLOCK_SKEW_MS = 60_000;
const NONCE_TTL_MS = 5 * 60_000;
const NONCE_CAPACITY = 10_000;

/**
 * Who may call a route (§7.1). Every route declares one in `config.access`;
 * registering a route without it fails at startup.
 *
 * - `public`: anyone (health, agent card).
 * - `hello`:  a node of this workgroup, known or not yet met: both proofs hold
 *             (the node's signature and the workgroup HMAC), and the signature
 *             may omit the receiver id, because a first contact cannot know it.
 * - `member`: the same, addressed to this node by id. A valid signature only
 *             proves key possession and the HMAC only that the sender knows the
 *             password; together they say a node that is in the workgroup now
 *             sent exactly this request. The member table does not gate anything:
 *             it only says who is online and where to dial.
 * - `local`:  a process on this machine that holds the node's local token (a task
 *             session, which the executor hands it to). No signature: the token
 *             lives as long as the node and never leaves the machine (§5.6).
 */
type Access = "public" | "hello" | "member" | "local";

/** Headers a reverse proxy adds; their presence means the socket peer is not the real client. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

/** True when the request came over a loopback socket and carries no proxy header. */
export function isDirectLoopbackRequest(request: {
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: IncomingHttpHeaders;
}): boolean {
  return (
    isLoopbackHost(request.socket?.remoteAddress ?? "") &&
    PROXY_HEADERS.every((name) => request.headers[name] === undefined)
  );
}

/** The header a local route reads its token from. */
export const LOCAL_TOKEN_HEADER = "x-orca-local";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
    /** Errors are answered as JSON-RPC envelopes. */
    rpc?: boolean;
    /** The reply is a file stream: its signature covers its status and `blob_id`, not its bytes. */
    blobReply?: boolean;
  }
  interface FastifyRequest {
    /** Set by the access hook on every route except `public`. */
    auth: VerifiedAuth;
    /** Raw body bytes, kept for signature verification. */
    rawBody?: Buffer;
  }
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
class NonceCache {
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

/** Who sent a request whose proofs held. */
type VerifiedAuth = { orcaNodeId: OrcaNodeId };

export class AccessPolicy {
  private readonly nonces = new NonceCache();
  /** When this gateway started; requests older than this are replays (§7.1). */
  private readonly startedAt = Date.now();

  constructor(
    private readonly selfId: OrcaNodeId,
    private readonly workgroupId: WorkgroupId,
    /** The workgroup key the proof of every request must have been made with (§7.1). */
    private readonly key: Buffer,
    /** What a local route takes (`local`). */
    private readonly localToken: string,
  ) {}

  install(app: FastifyInstance): void {
    app.addHook("onRoute", (route) => {
      if (route.config?.access === undefined) {
        throw new Error(`${String(route.method)} ${route.url} declares no config.access`);
      }
    });

    // preValidation: the body is parsed (signature needs its bytes) but not yet
    // schema-checked, so an unauthenticated caller learns nothing from a 400.
    app.addHook("preValidation", async (request) => {
      const { access } = request.routeOptions.config;
      // `undefined`: no route matched, so Fastify answers 404 without a signature check.
      if (access === undefined || access === "public") return;
      if (access === "local") return this.checkLocal(request);
      request.auth = this.authenticate(request, access);
    });
  }

  /** A local route answers only the holder of this node's local token. */
  private checkLocal(request: FastifyRequest): void {
    const given = Buffer.from(String(request.headers[LOCAL_TOKEN_HEADER] ?? ""));
    const expected = Buffer.from(this.localToken);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new PodError("missing_auth", "local routes take this node's local token");
    }
  }

  /** Verify both proofs of a request and return who sent it. */
  private authenticate(request: FastifyRequest, access: Access): VerifiedAuth {
    const header = request.headers.authorization;
    if (!header) throw new PodError("missing_auth", "missing Authorization header");
    const parsed = parseAuthHeader(header);
    if (!parsed) throw new PodError("malformed_auth", "malformed Authorization header");
    const { claim } = parsed;
    if (Math.abs(Date.now() - claim.ts) > CLOCK_SKEW_MS) {
      throw new PodError("clock_skew", "timestamp outside the allowed skew window");
    }
    // Nonces live only in this process; refusing anything issued before it
    // started closes the replay window a restart would otherwise reopen.
    if (claim.ts < this.startedAt) {
      throw new PodError("stale_request", "timestamp predates this node process; restart replay rejected");
    }
    if (claim.target === "") {
      // A first contact (`hello`) cannot know the receiver's id before it has met it.
      if (access !== "hello") throw new PodError("wrong_target", "request is not bound to a target orca node");
    } else if (claim.target !== this.selfId) {
      throw new PodError("wrong_target", "request is addressed to another orca node");
    }
    if (claim.workgroupId !== this.workgroupId) {
      throw new PodError("workgroup_mismatch", "workgroup_id does not match this orca node");
    }
    // The signature covers the full request target, query included: a captured
    // request cannot be replayed with different query parameters (§7.1).
    const input = signatureInput({ method: request.method, url: request.url, body: request.rawBody }, claim);
    if (!verifyWithNodeId(parsed.orcaNodeId, input, parsed.signature)) {
      throw new PodError("bad_signature", "signature does not match");
    }
    // After the signature, so only a node that exists can make a caller learn the workgroup was wrong.
    const expected = Buffer.from(hmacOf(this.key, input), "base64url");
    const proof = Buffer.from(parsed.proof, "base64url");
    if (expected.length !== proof.length || !timingSafeEqual(expected, proof)) {
      throw new PodError("bad_proof", "workgroup proof does not verify");
    }
    if (!this.nonces.remember(`${parsed.orcaNodeId}:${claim.nonce}`)) {
      throw new PodError("nonce_replay", "nonce already used");
    }
    return { orcaNodeId: parsed.orcaNodeId };
  }
}
