import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { BlobIdSchema, type OpenedBlob } from "../core/blobs.ts";
import type { Mesh } from "../mesh/mesh.ts";
import { parseInput } from "./input.ts";

const BlobParams = z.object({ blob_id: BlobIdSchema });

/**
 * Files move by name, never by URL (§5.6): a file is the sha256 a member
 * published, and whoever needs it asks the node that published it, which its own
 * node finds the way its heartbeat does. The gateway never accepts bytes pushed by
 * a peer: there is no upload route.
 */
export class BlobRoutes {
  constructor(private readonly mesh: Mesh) {}

  register(app: FastifyInstance): void {
    // A file this node published, for a member's signed request. The reply is a
    // stream, so its signature covers its status and the file's name (`blobReply`).
    app.get("/blobs/:blob_id", { config: { access: "member", blobReply: true } }, async (request, reply) => {
      const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
      return BlobRoutes.send(reply, await this.mesh.self.fetchBlob(blobId));
    });
  }

  private static send(reply: FastifyReply, { stream, size }: OpenedBlob): FastifyReply {
    reply.header("content-type", "application/octet-stream");
    if (size !== undefined) reply.header("content-length", String(size));
    return reply.send(stream);
  }
}
