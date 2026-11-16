import type { FastifyInstance, FastifyRequest } from "fastify";

import { verifyAuth, verifyBlobLinkSignature, type VerifiedAuth } from "../crypto.ts";
import { PodError } from "../errors.ts";
import { isDirectLoopbackRequest } from "../net.ts";
import type { GatewayDeps } from "./index.ts";

/**
 * Who may call a route (§7.1). Every route declares one in `config.access`;
 * registering a route without it fails at startup.
 *
 * - `public`: anyone (health, agent card).
 * - `join`:   signed by any node key; the signature may omit the receiver id,
 *             because a first join cannot know it yet.
 * - `member`: signed by this node or by a peer still in the roster. A valid
 *             signature only proves key possession: anyone can generate a key.
 * - `link`:   `member`, or an unsigned capability link signed by this node.
 * - `local`:  this node itself, over loopback with no proxy headers; "local" is a
 *             transport fact plus the node's own signature, never a claim.
 */
type Access = "public" | "join" | "member" | "link" | "local";

declare module "fastify" {
  interface FastifyContextConfig {
    access?: Access;
    /** Errors are answered as JSON-RPC envelopes. */
    rpc?: boolean;
    /** The body is streamed; its sha256 is signed in `x-pod-body-sha256` instead of hashed here. */
    streamed?: boolean;
  }
  interface FastifyRequest {
    /** Set by the access hook on every route except `public` (and link downloads). */
    auth: VerifiedAuth;
    /** Raw body bytes, kept for signature verification; absent for streamed bodies. */
    rawBody?: Buffer;
  }
}

function requireLoopback(request: FastifyRequest): void {
  if (!isDirectLoopbackRequest(request)) throw new PodError("local_only", "this route is a local control");
}

/** Check a capability link (§5.6); returns true when the request carries one. */
function acceptLink(request: FastifyRequest, deps: GatewayDeps): boolean {
  const { exp, sig } = request.query as { exp?: string; sig?: string };
  if (exp === undefined || sig === undefined) return false;
  const { blob_id: blobId } = request.params as { blob_id: string };
  if (!verifyBlobLinkSignature(deps.orcaNode.orca_node_id, blobId, exp, sig)) {
    throw new PodError("link_invalid");
  }
  if (Number(exp) * 1000 <= Date.now()) throw new PodError("link_expired");
  return true;
}

export function installAccessPolicy(app: FastifyInstance, deps: GatewayDeps): void {
  const selfId = deps.orcaNode.orca_node_id;

  app.addHook("onRoute", (route) => {
    if (route.config?.access === undefined) {
      throw new Error(`${String(route.method)} ${route.url} declares no config.access`);
    }
  });

  // preValidation: the body is parsed (signature needs its bytes) but not yet
  // schema-checked, so an unauthenticated caller learns nothing from a 400.
  app.addHook("preValidation", async (request) => {
    const { access, streamed } = request.routeOptions.config;
    // `undefined`: no route matched, so Fastify answers 404 without a signature check.
    if (access === undefined || access === "public") return;
    if (access === "local") requireLoopback(request);
    if (access === "link" && acceptLink(request, deps)) return;

    request.auth = verifyAuth({
      method: request.method,
      // The signature covers the full request target, query included: a captured
      // request cannot be replayed with different query parameters (§7.1).
      url: request.url,
      targetOrcaNodeId: selfId,
      allowEmptyTarget: access === "join",
      // Nonces live only in this process; refusing anything issued before it
      // started closes the replay window a restart would otherwise reopen.
      notBefore: deps.startedAt,
      body: request.rawBody,
      bodySha256: streamed ? (request.headers["x-pod-body-sha256"] as string | undefined) : undefined,
      header: request.headers.authorization,
      nonceCache: deps.nonceCache,
    });

    const caller = request.auth.orcaNodeId;
    if (access === "join") return;
    if (access === "local") {
      if (caller !== selfId) throw new PodError("local_only", "this route is a local control");
      return;
    }
    if (caller !== selfId && deps.peers.get(caller) === undefined) {
      throw new PodError(
        "not_a_member",
        "this orca node is not a member of the workgroup; join with the workgroup password first",
      );
    }
  });
}
