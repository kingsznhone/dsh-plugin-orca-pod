import { createReadStream, existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PodError } from "../../kernel/errors.ts";
import type { GatewayDeps } from "./gateway.ts";
import { parseInput } from "./input.ts";

const BlobParams = z.object({ blob_id: z.string() });

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

/**
 * `GET /blobs/:blob_id` (§5.6): a file this node published, streamed from where
 * it lies. A node never receives bytes from another one: an origin that wants
 * to hand a file to a task publishes it on its own gateway and puts the link in
 * the task text, and the target fetches it, the same way an origin fetches a
 * target's results.
 */
export function blobRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/blobs/:blob_id", { config: { access: "link" } }, async (request, reply) => {
    const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
    const file = deps.fileBlobs.get(blobId);
    if (!file) throw new PodError("blob_not_found");
    if (isExpired(file.expires_at)) throw new PodError("blob_expired");
    if (!existsSync(file.path)) throw new PodError("blob_file_missing");
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(file.size))
      .send(createReadStream(file.path));
  });
}
