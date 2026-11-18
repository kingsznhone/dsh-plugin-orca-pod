import type { FastifyInstance, FastifyRequest } from "fastify";

import { verifyAuth, type NonceCache, type VerifiedAuth } from "../core/signing.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";

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
 */
type Access = "public" | "hello" | "member";

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
  constructor(
    private readonly selfId: OrcaNodeId,
    private readonly workgroupId: WorkgroupId,
    /** The workgroup key the proof of every request must have been made with (§7.1). */
    private readonly key: Buffer,
    private readonly nonces: NonceCache,
    /** When this gateway process started; requests older than this are replays (§7.1). */
    private readonly startedAt: number,
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
      request.auth = this.authenticate(request, access);
    });
  }

  /** Verify both proofs of a request and return who sent it. */
  private authenticate(request: FastifyRequest, access: Access): VerifiedAuth {
    return verifyAuth({
      method: request.method,
      // The signature covers the full request target, query included: a captured
      // request cannot be replayed with different query parameters (§7.1).
      url: request.url,
      targetOrcaNodeId: this.selfId,
      workgroupId: this.workgroupId,
      key: this.key,
      allowEmptyTarget: access === "hello",
      // Nonces live only in this process; refusing anything issued before it
      // started closes the replay window a restart would otherwise reopen.
      notBefore: this.startedAt,
      body: request.rawBody,
      header: request.headers.authorization,
      nonceCache: this.nonces,
    });
  }
}
