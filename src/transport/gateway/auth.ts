import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { verifyAuth, verifyBlobLinkSignature, type VerifiedAuth } from "../../security/crypto.ts";
import { PodError } from "../../kernel/errors.ts";
import { parseSchema } from "../../kernel/schema.ts";
import { isDirectLoopbackRequest } from "../net.ts";
import type { GatewayDeps } from "./gateway.ts";
import type { OrcaNodeId } from "../../protocol/peer.ts";

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
  }
  interface FastifyRequest {
    /** Set by the access hook on every route except `public` (and link downloads). */
    auth: VerifiedAuth;
    /** Raw body bytes, kept for signature verification. */
    rawBody?: Buffer;
  }
}

/** Check a capability link (§5.6); returns true when the request carries one. */
const LinkQuery = z.object({ exp: z.string(), sig: z.string() });
const LinkParams = z.object({ blob_id: z.string() });

function acceptLink(request: FastifyRequest, deps: GatewayDeps): boolean {
  const query = parseSchema(LinkQuery, request.query);
  if (!query.ok) return false;
  const params = parseSchema(LinkParams, request.params);
  if (!params.ok) return false;
  const { exp, sig } = query.value;
  if (!verifyBlobLinkSignature(deps.orcaNode.orca_node_id, params.value.blob_id, exp, sig)) {
    throw new PodError("link_invalid");
  }
  if (Number(exp) * 1000 <= Date.now()) throw new PodError("link_expired");
  return true;
}

/** Verify the signature of a request and return who signed it. */
function authenticate(request: FastifyRequest, access: Access, deps: GatewayDeps): VerifiedAuth {
  return verifyAuth({
    method: request.method,
    // The signature covers the full request target, query included: a captured
    // request cannot be replayed with different query parameters (§7.1).
    url: request.url,
    targetOrcaNodeId: deps.orcaNode.orca_node_id,
    allowEmptyTarget: access === "join",
    // Nonces live only in this process; refusing anything issued before it
    // started closes the replay window a restart would otherwise reopen.
    notBefore: deps.startedAt,
    body: request.rawBody,
    header: request.headers.authorization,
    nonceCache: deps.nonceCache,
  });
}

/** A valid signature only proves key possession: decide whether this caller may use the route. */
function authorize(access: Access, caller: OrcaNodeId, deps: GatewayDeps): void {
  if (access === "join") return;
  const self = caller === deps.orcaNode.orca_node_id;
  if (access === "local") {
    if (!self) throw new PodError("local_only", "this route is a local control");
    return;
  }
  if (!self && deps.peers.get(caller) === undefined) {
    throw new PodError(
      "not_a_member",
      "this orca node is not a member of the workgroup; join with the workgroup password first",
    );
  }
}

export function installAccessPolicy(app: FastifyInstance, deps: GatewayDeps): void {
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
    if (access === "link" && acceptLink(request, deps)) return;
    request.auth = authenticate(request, access, deps);
    authorize(access, request.auth.orcaNodeId, deps);
  });
}
