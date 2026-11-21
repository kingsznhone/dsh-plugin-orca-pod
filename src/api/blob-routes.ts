import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { BlobIdSchema, isPathWithinRoot, type OpenedBlob } from "../core/blobs.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import { OrcaNodeIdSchema } from "../core/ids.ts";
import type { Mesh } from "../mesh/mesh.ts";
import { parseInput } from "./input.ts";

const BlobParams = z.object({ blob_id: BlobIdSchema });

const PublishBody = z.object({
  path: z.string().refine(isAbsolute, "must be an absolute path"),
  ttl_s: z.number().int().min(0).optional(),
});

const FetchParams = z.object({ node: OrcaNodeIdSchema, blob_id: BlobIdSchema });

/**
 * Files move by name, never by URL (§5.6): a file is the sha256 a member
 * published, and whoever needs it asks the node that published it, which its own
 * node finds the way its heartbeat does. The gateway never accepts bytes pushed by
 * a peer: there is no upload route.
 *
 * Members fetch this node's files over a signed request. A process on this
 * machine (a task session, which runs in another `dsh` process and has no node of
 * its own) publishes files and fetches other members' through the `local` routes:
 * access is the node's token, which only the executor hands out.
 */
export class BlobRoutes {
  constructor(
    private readonly mesh: Mesh,
    /** Only files inside this directory (the workgroup workspace) may be published through `/local/blobs`. */
    private readonly publishRoot: string,
  ) {}

  register(app: FastifyInstance): void {
    // A file this node published, for a member's signed request. The reply is a
    // stream, so its signature covers its status and the file's name (`blobReply`).
    app.get("/blobs/:blob_id", { config: { access: "member", blobReply: true } }, async (request, reply) => {
      const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
      return BlobRoutes.send(reply, await this.mesh.self.fetchBlob(blobId));
    });

    // Copy a file from this node's workgroup workspace into the registry and name it.
    app.post("/local/blobs", { config: { access: "local" } }, async (request) => {
      const { path, ttl_s } = parseInput(PublishBody, request.body, "body");
      const target = await this.resolvePublishPath(path);
      return this.mesh.self.publish(target, ttl_s).catch((error: unknown) => {
        if (error instanceof PodError) throw error;
        throw new PodError("bad_request", `cannot publish ${path}: ${errorMessage(error)}`);
      });
    });

    // A file any member published, this one included, fetched the way the node fetches it.
    app.get("/local/blobs/:node/:blob_id", { config: { access: "local" } }, async (request, reply) => {
      const { node, blob_id: blobId } = parseInput(FetchParams, request.params, "params");
      return BlobRoutes.send(reply, await this.mesh.require(node).fetchBlob(blobId));
    });
  }

  /** Resolve `path` (following symlinks) and require it to lie strictly inside `this.publishRoot`. */
  private async resolvePublishPath(path: string): Promise<string> {
    let realRoot: string;
    try {
      realRoot = await realpath(this.publishRoot);
    } catch {
      realRoot = resolve(this.publishRoot);
    }
    const candidate = resolve(path);
    let realTarget: string;
    try {
      realTarget = await realpath(candidate);
    } catch (error) {
      let parent: string;
      try {
        parent = await realpath(dirname(candidate));
      } catch {
        parent = dirname(candidate);
      }
      if (!isPathWithinRoot(realRoot, join(parent, basename(candidate)))) {
        throw new PodError("path_outside_workspace", `cannot publish ${path}: path is outside the workgroup workspace`);
      }
      throw new PodError("bad_request", `cannot publish ${path}: ${errorMessage(error)}`);
    }
    if (!isPathWithinRoot(realRoot, realTarget)) {
      throw new PodError("path_outside_workspace", `cannot publish ${path}: path is outside the workgroup workspace`);
    }
    return realTarget;
  }

  /** Answer with a file's bytes; the caller checks them against the sha256 it asked for. */
  private static send(reply: FastifyReply, { stream, size }: OpenedBlob): FastifyReply {
    reply.header("content-type", "application/octet-stream");
    if (size !== undefined) reply.header("content-length", String(size));
    return reply.send(stream);
  }
}
