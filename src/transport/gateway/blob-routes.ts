import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { signedBlobUrl } from "../../security/crypto.ts";
import { DEFAULT_BLOB_TTL_S } from "../../storage/stores.ts";
import { PodError } from "../../kernel/errors.ts";
import { BODY_SHA256_HEADER } from "../../protocol/constants.ts";
import type { BlobLinkResponse, BlobUploadResponse } from "../../protocol/a2a.ts";
import type { GatewayDeps } from "./gateway.ts";
import { parseInput } from "./input.ts";

/** The one route that legitimately receives more than the default body limit (§5.6). */
const MAX_BLOB_BYTES = 256 * 1024 * 1024;
/** §5.6: a direct link lives as long as the blob it points at (one TTL). */
const BLOB_LINK_TTL_S = DEFAULT_BLOB_TTL_S;

/** Names are hints only (§5.6): no separators, traversal or drive prefixes. */
const SAFE_BLOB_NAME = /^(?![A-Za-z]:)(?![\s\S]*\.\.)[^/\\]+$/;

const BlobDigest = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase sha256 hex digest");
const BlobParams = z.object({ blob_id: z.string() });
const UploadQuery = z.object({ name: z.string().regex(SAFE_BLOB_NAME, "must be a plain file name").optional() });

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.now();
}

export function blobRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  // The signature covers the file digest (`streamed`), so access is decided
  // before any body bytes are read; the store hashes while it writes (§5.6).
  app.post(
    "/blobs",
    { bodyLimit: MAX_BLOB_BYTES, config: { access: "member", streamed: true } },
    async (request, reply) => {
      const declared = parseInput(BlobDigest, request.headers[BODY_SHA256_HEADER], `headers.${BODY_SHA256_HEADER}`);
      const query = parseInput(UploadQuery, request.query, "querystring");
      const existed = deps.blobs.has(declared);
      const stream = (request.body as Readable | undefined) ?? Readable.from([]);
      // The store checks the digest before committing: mismatched bytes are discarded.
      const record = await deps.blobs.putStream(stream, {
        name: query.name,
        maxBytes: MAX_BLOB_BYTES,
        sha256: declared,
      });
      const uploaded: BlobUploadResponse = {
        blob_id: record.blob_id,
        size: record.size,
        name: record.name,
        expires_at: record.expires_at,
      };
      return reply.code(existed ? 200 : 201).send(uploaded);
    },
  );

  app.get("/blobs/:blob_id", { config: { access: "link" } }, async (request, reply) => {
    const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
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
  });

  app.post("/blobs/:blob_id/link", { config: { access: "member" } }, async (request) => {
    const { blob_id: blobId } = parseInput(BlobParams, request.params, "params");
    if (!deps.blobs.has(blobId)) throw new PodError("blob_not_found");
    const expiresAtMs = Date.now() + BLOB_LINK_TTL_S * 1000;
    const exp = String(Math.floor(expiresAtMs / 1000));
    const [primary] = deps.orcaNode.self().endpoints;
    const link: BlobLinkResponse = {
      url: signedBlobUrl(deps.identity, primary ?? "", blobId, exp),
      expires_at: new Date(expiresAtMs).toISOString(),
    };
    return link;
  });
}
