import type { FastifyInstance, FastifyRequest } from "fastify";

import { verifyAuth, type NonceCache, type VerifiedAuth } from "../core/signing.ts";
import { PodError } from "../core/errors.ts";
import { isDirectLoopbackRequest } from "../core/net.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { Membership } from "../mesh/membership.ts";

/**
 * Who may call a route (§7.1). Every route declares one in `config.access`;
 * registering a route without it fails at startup.
 *
 * - `public`: anyone (health, agent card).
 * - `join`:   signed by any node key; the signature may omit the receiver id,
 *             because a first join cannot know it yet.
 * - `member`: signed by this node or by a peer still in the roster. A valid
 *             signature only proves key possession: anyone can generate a key.
 * - `local`:  this node itself, over loopback with no proxy headers; "local" is a
 *             transport fact plus the node's own signature, never a claim.
 */
type Access = "public" | "join" | "member" | "local";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
    /** Errors are answered as JSON-RPC envelopes. */
    rpc?: boolean;
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
    private readonly membership: Membership,
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
      // Refused before any signature work: a local control is never reachable from off the machine.
      if (access === "local" && !isDirectLoopbackRequest(request)) {
        throw new PodError("local_only", "this route is a local control");
      }
      request.auth = this.authenticate(request, access);
      this.authorize(access, request.auth.orcaNodeId);
    });
  }

  /** Verify the signature of a request and return who signed it. */
  private authenticate(request: FastifyRequest, access: Access): VerifiedAuth {
    return verifyAuth({
      method: request.method,
      // The signature covers the full request target, query included: a captured
      // request cannot be replayed with different query parameters (§7.1).
      url: request.url,
      targetOrcaNodeId: this.selfId,
      allowEmptyTarget: access === "join",
      // Nonces live only in this process; refusing anything issued before it
      // started closes the replay window a restart would otherwise reopen.
      notBefore: this.startedAt,
      body: request.rawBody,
      header: request.headers.authorization,
      nonceCache: this.nonces,
    });
  }

  /** A valid signature only proves key possession: decide whether this caller may use the route. */
  private authorize(access: Access, caller: OrcaNodeId): void {
    if (access === "join") return;
    const self = caller === this.selfId;
    if (access === "local") {
      if (!self) throw new PodError("local_only", "this route is a local control");
      return;
    }
    if (!self && this.membership.get(caller) === undefined) {
      throw new PodError(
        "not_a_member",
        "this orca node is not a member of the workgroup; join with the workgroup password first",
      );
    }
  }
}
