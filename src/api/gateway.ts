import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from "fastify";

import type { NonceCache } from "../core/signing.ts";
import type { NodeIdentity } from "../core/identity.ts";
import type { SelfRecord, OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import type { FileBlobRegistry, OpenedBlob } from "../core/blobs.ts";
import type { Membership } from "../mesh/membership.ts";
import { a2aRoutes } from "./a2a-routes.ts";
import { installAccessPolicy } from "./access.ts";
import { blobRoutes } from "./blob-routes.ts";
import { clusterRoutes } from "./cluster-routes.ts";
import { PodError, POD_ERROR_STATUS } from "../core/errors.ts";

type GatewayOrcaNode = {
  orca_node_id: OrcaNodeId;
  workgroup_id: WorkgroupId;
  /** Live self record owned by the node: endpoints, model catalog, busy holder (§6.15). */
  self: () => SelfRecord;
  /** A file a member published, streamed from wherever that member answers (§5.6). */
  fetchBlob: (nodeId: OrcaNodeId, blobId: string, signal?: AbortSignal) => Promise<OpenedBlob>;
};

export type GatewayDeps = {
  orcaNode: GatewayOrcaNode;
  identity: NodeIdentity;
  workgroupKey: Buffer;
  peers: Membership;
  nonceCache: NonceCache;
  /** When this gateway process started; requests older than this are replays (§7.1). */
  startedAt: number;
  tasks: SingleSlotTaskRunner;
  /** Files a task published by path with a TTL (§5.6). */
  fileBlobs: FileBlobRegistry;
};

/**
 * Default cap for signed requests. Authentication needs the body bytes, so the
 * body is buffered before signature verification; keep that buffer small and
 * raise the limit only where large payloads are expected (§7.1).
 */
const MAX_REQUEST_BYTES = 1024 * 1024;

function installBodyParsers(app: FastifyInstance): void {
  // JSON keeps its bytes for signature verification as well as the parsed value.
  app.addContentTypeParser<Buffer>("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body;
    done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
  });
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

const BUSY_RETRY_AFTER_S = 30;

/** Anything that is not already a PodError is either the caller's malformed input or a bug. */
function toPodError(error: unknown): PodError {
  if (error instanceof PodError) return error;
  const { code } = error as FastifyError;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new PodError("body_too_large", "request body exceeds the size limit");
  }
  if (error instanceof SyntaxError) return new PodError("bad_request", "invalid JSON body");
  return new PodError("internal", "internal server error");
}

/**
 * The one place an error becomes an HTTP response: `{ code, message }` with the
 * status from `POD_ERROR_STATUS`. Routes marked `rpc` wrap the same body in a
 * JSON-RPC error envelope; a busy node also reports its holder and when to retry.
 */
function installErrorHandler(app: FastifyInstance, deps: GatewayDeps): void {
  app.setErrorHandler((error, request, reply) => {
    const pod = toPodError(error);
    const busy = pod.code === "orca_node_busy";
    const body = {
      code: pod.code,
      message: pod.message,
      ...(busy ? { retry_after_s: BUSY_RETRY_AFTER_S, holder: deps.tasks.busy() } : {}),
    };
    if (busy) reply.header("retry-after", String(BUSY_RETRY_AFTER_S));
    const rpcId = (request.body as { id?: unknown } | null | undefined)?.id ?? null;
    return reply
      .code(POD_ERROR_STATUS[pod.code])
      .send(
        request.routeOptions.config.rpc
          ? { jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: pod.code, data: body } }
          : body,
      );
  });
}
