import { isAbsolute } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { BlobIdSchema, formatBlobRef, type FileBlobRegistry } from "../core/blobs.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import { OrcaNodeIdSchema } from "../core/ids.ts";
import type { Mesh } from "../mesh/mesh.ts";
import { sendBlob } from "./blob-routes.ts";
import { parseInput } from "./input.ts";

const PublishBody = z.object({
  path: z.string().refine(isAbsolute, "must be an absolute path"),
  ttl_s: z.number().int().min(0).optional(),
});

const FetchParams = z.object({ node: OrcaNodeIdSchema, blob_id: BlobIdSchema });

/**
 * What a process on this machine asks of its node (§5.6): a task session, which
 * runs in another `dsh` process and has no node of its own, publishes files and
 * fetches other members' through these. Access is `local`: the node's token,
 * which only the executor hands out.
 */
export class LocalRoutes {
  constructor(
    private readonly mesh: Mesh,
    private readonly blobs: FileBlobRegistry,
  ) {}

  register(app: FastifyInstance): void {
    // Copy a file of this machine into the registry and name it.
    app.post("/local/blobs", { config: { access: "local" } }, async (request) => {
      const { path, ttl_s } = parseInput(PublishBody, request.body, "body");
      const blob = await this.blobs.register(path, ttl_s).catch((error: unknown) => {
        throw new PodError("bad_request", `cannot publish ${path}: ${errorMessage(error)}`);
      });
      return {
        ref: formatBlobRef({ node: this.mesh.self.id, blob_id: blob.blob_id }),
        size: blob.size,
        expires_at: blob.expires_at,
      };
    });

    // A file any member published, this one included, fetched the way the node fetches it.
    app.get("/local/blobs/:node/:blob_id", { config: { access: "local" } }, async (request, reply) => {
      const { node, blob_id: blobId } = parseInput(FetchParams, request.params, "params");
      return sendBlob(reply, await this.mesh.require(node).fetchBlob(blobId));
    });
  }
}
