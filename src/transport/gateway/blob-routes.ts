import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";

import { blobLinkSignature } from "../../security/index.ts";
import { DEFAULT_BLOB_TTL_S } from "../../storage/index.ts";
import { PodError } from "../../kernel/index.ts";
import type { GatewayDeps } from "./index.ts";

/** The one route that legitimately receives more than the default body limit (§5.6). */
const MAX_BLOB_BYTES = 256 * 1024 * 1024;
/** §5.6: a direct link lives as long as the blob it points at (one TTL). */
const BLOB_LINK_TTL_S = DEFAULT_BLOB_TTL_S;

/** Names are hints only (§5.6): no separators, traversal or drive prefixes. */
const SAFE_BLOB_NAME = String.raw`^(?![A-Za-z]:)(?![\s\S]*\.\.)[^/\\]+$`;

const uploadSchema = {
  headers: {
    type: "object",
    required: ["x-pod-body-sha256"],
    properties: { "x-pod-body-sha256": { type: "string", pattern: "^[0-9a-f]{64}$" } },
  },
  querystring: { type: "object", properties: { name: { type: "string", pattern: SAFE_BLOB_NAME } } },
};

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

export function blobRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  // The signature covers the file digest (`streamed`), so access is decided
  // before any body bytes are read; the store hashes while it writes (§5.6).
  app.post<{ Querystring: { name?: string } }>(
    "/blobs",
    { bodyLimit: MAX_BLOB_BYTES, config: { access: "member", streamed: true }, schema: uploadSchema },
    async (request, reply) => {
      const declared = request.headers["x-pod-body-sha256"] as string;
      const existed = deps.blobs.has(declared);
      const stream = (request.body as Readable | undefined) ?? Readable.from([]);
      // The store checks the digest before committing: mismatched bytes are discarded.
      const record = await deps.blobs.putStream(stream, {
        name: request.query.name,
        maxBytes: MAX_BLOB_BYTES,
        sha256: declared,
      });
      return reply.code(existed ? 200 : 201).send({
        blob_id: record.blob_id,
        size: record.size,
        name: record.name,
        expires_at: record.expires_at,
      });
    },
  );

  app.get<{ Params: { blob_id: string } }>(
    "/blobs/:blob_id",
    { config: { access: "link" } },
    async (request, reply) => {
      const { blob_id: blobId } = request.params;
      const read = deps.blobs.openRead(blobId);
      if (read) {
        if (isExpired(read.record.expires_at)) {
          read.stream.destroy();
          throw new PodError("blob_expired");
        }
        return reply
          .header("content-type", read.record.media_type ?? "application/octet-stream")
          .header("content-length", String(read.size))
          .send(read.stream);
      }
      const file = deps.fileBlobs.get(blobId);
      if (!file) throw new PodError("blob_not_found");
      if (isExpired(file.expires_at)) throw new PodError("blob_expired");
      if (!existsSync(file.path)) throw new PodError("blob_file_missing");
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-length", String(file.size))
        .send(createReadStream(file.path));
    },
  );

  app.post<{ Params: { blob_id: string } }>(
    "/blobs/:blob_id/link",
    { config: { access: "member" } },
    async (request) => {
      const { blob_id: blobId } = request.params;
      if (!deps.blobs.has(blobId)) throw new PodError("blob_not_found");
      const expiresAtMs = Date.now() + BLOB_LINK_TTL_S * 1000;
      const exp = String(Math.floor(expiresAtMs / 1000));
      const sig = blobLinkSignature(deps.identity, blobId, exp);
      const [primary] = deps.orcaNode.self().endpoints;
      return {
        url: `${primary ?? ""}/blobs/${blobId}?exp=${exp}&sig=${sig}`,
        expires_at: new Date(expiresAtMs).toISOString(),
      };
    },
  );
}
