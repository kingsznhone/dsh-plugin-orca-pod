import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { PodError } from "../core/errors.ts";

import { NonceCache, verifyAuth, type VerifiedAuth } from "../core/signing.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/ids.ts";

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
    return verifyAuth({
      // The signature covers the full request target, query included: a captured
      // request cannot be replayed with different query parameters (§7.1).
      request: { method: request.method, url: request.url, body: request.rawBody },
      header: request.headers.authorization,
      selfOrcaNodeId: this.selfId,
      workgroupId: this.workgroupId,
      key: this.key,
      allowEmptyTarget: access === "hello",
      // Nonces live only in this process; refusing anything issued before it
      // started closes the replay window a restart would otherwise reopen.
      notBefore: this.startedAt,
      nonceCache: this.nonces,
    });
  }
}
