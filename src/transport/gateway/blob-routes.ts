import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { BlobIdSchema } from "../../protocol/blob.ts";
import { OrcaNodeIdSchema } from "../../protocol/peer.ts";
import type { OpenedBlob } from "../../storage/stores.ts";
import type { GatewayDeps } from "./gateway.ts";
import { parseInput } from "./input.ts";

const BlobParams = z.object({ blob_id: BlobIdSchema });
const FetchQuery = z.object({ node: OrcaNodeIdSchema, blob: BlobIdSchema });

function send(reply: FastifyReply, { stream, size }: OpenedBlob): FastifyReply {
  reply.header("content-type", "application/octet-stream");
  if (size !== undefined) reply.header("content-length", String(size));
  return reply.send(stream);
}

/**
 * Files move by name, never by URL (§5.6): a file is the sha256 a member
 * published, and whoever needs it asks its own node, which finds that member's
 * address the way its heartbeat does. The gateway never accepts bytes pushed by
 * a peer (there is no upload route); a local caller's request makes this node
 * fetch the file from its publisher on demand and forward it.
 */
export function blobRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  // A file this node published, for a member's signed request.
  app.get("/blobs/:blob_id", { config: { access: "member" } }, async (request, reply) => {
    const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
    return send(reply, deps.fileBlobs.open(blobId));
  });

  // Local control for the CLI: any member's file, fetched by this node (§5.6).
  app.get("/cluster/blob", { config: { access: "local" } }, async (request, reply) => {
    const { node, blob } = parseInput(FetchQuery, request.query, "querystring");
    return send(reply, await deps.orcaNode.fetchBlob(node, blob));
  });
}
