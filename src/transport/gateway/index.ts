import type { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { NonceCache, NodeIdentity } from "../../security/index.ts";
import type { SelfRecord, TaskRunner } from "../../protocol/index.ts";
import type { FileBlobRegistry, BlobStore } from "../../storage/index.ts";
import type { PeerStore } from "../../membership/index.ts";
import { a2aRoutes } from "./a2a-routes.ts";
import { installAccessPolicy } from "./auth.ts";
import { blobRoutes } from "./blob-routes.ts";
import { clusterRoutes } from "./cluster-routes.ts";
import { installErrorHandler } from "./error-handler.ts";

type GatewayOrcaNode = {
  orca_node_id: string;
  workgroup_id: string;
  /** Live self record owned by the node: endpoints, model catalog, busy holder (§6.15). */
  self: () => SelfRecord;
  /** Local-only capability: register a child task for automatic relay (§7.12). */
  linkChildTask: (parentTaskId: string, peerUrl: string, childTaskId: string) => void;
};

export type GatewayDeps = {
  orcaNode: GatewayOrcaNode;
  identity: NodeIdentity;
  workgroupKey: Buffer;
  peers: PeerStore;
  nonceCache: NonceCache;
  /** When this gateway process started; requests older than this are replays (§7.1). */
  startedAt: number;
  tasks: TaskRunner;
  blobs: BlobStore;
  /** Files a task published by path with a TTL (§5.6). */
  fileBlobs: FileBlobRegistry;
};

/**
 * Default cap for signed requests. Authentication needs the body bytes, so the
 * body is buffered before signature verification; keep that buffer small and
 * raise the limit only where large payloads are expected (§7.1).
 */
const MAX_REQUEST_BYTES = 1024 * 1024;

/** The overload that accepts a stream parser is not part of Fastify's generic typings. */
type StreamParserRegistration = (
  contentType: string,
  parser: (request: unknown, payload: Readable, done: (error: Error | null, body?: unknown) => void) => void,
) => void;

function installBodyParsers(app: FastifyInstance): void {
  // JSON keeps its bytes for signature verification as well as the parsed value.
  app.addContentTypeParser<Buffer>("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body;
    done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
  });
  // Blob uploads (§5.6) stream raw bytes: the client signs the file digest in
  // `x-pod-body-sha256`, so the body is never buffered in memory.
  (app as unknown as { addContentTypeParser: StreamParserRegistration }).addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  // Any other media type: bytes for the signature, no parsed body.
  app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, (request: FastifyRequest, body, done) => {
    request.rawBody = body;
    done(null, undefined);
  });
}

export function createGateway(deps: GatewayDeps): FastifyInstance {
  // `forceCloseConnections`: a panel or curl may hold an idle keep-alive socket;
  // shutdown must not wait for it. Routes register no Fastify schemas: each
  // handler parses its input with zod (`input.ts`) after the access policy ran.
  const app = Fastify({ logger: false, bodyLimit: MAX_REQUEST_BYTES, forceCloseConnections: true });
  installBodyParsers(app);
  installErrorHandler(app, deps);
  installAccessPolicy(app, deps);
  clusterRoutes(app, deps);
  a2aRoutes(app, deps);
  blobRoutes(app, deps);
  return app;
}
