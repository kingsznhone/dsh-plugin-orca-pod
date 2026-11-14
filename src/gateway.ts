import { createHmac, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  PodAuthError,
  verifyAuth,
  type NonceCache,
  type VerifiedAuth,
} from "./crypto.ts";
import {
  PROTOCOL_VERSION,
  isHttpEndpoint,
  membersDigest,
  normalizeOrcaNodeId,
  runtimeDigest,
  TaskError,
  type BusyState,
  type HeartbeatResponse,
  type JoinResponse,
  type MembersResponse,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
  type TaskRunner,
  type TaskView,
  type A2AMessage,
  type SubmitTaskInput,
} from "./protocol.ts";
import { sha256Hex, type BlobStore, type PeerStore } from "./storage.ts";

export type GatewayOrcaNode = {
  orca_node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoint: string | null;
};

export type GatewayDeps = {
  orcaNode: GatewayOrcaNode;
  key: Buffer;
  peers: PeerStore;
  nonceCache: NonceCache;
  runtime: RuntimeInfo | null;
  tasks: TaskRunner;
  blobs: BlobStore;
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };
type JsonObject = Record<string, unknown>;
type JsonRpcEnvelope = { id?: unknown; method?: string; params?: unknown };

/** Task failures are protocol-level; the HTTP status mirrors the documented code (§6.3, §6.9). */
const TASK_ERROR_STATUS: Record<string, number> = {
  bad_echo_script: 400,
  orca_node_busy: 429,
  task_not_found: 404,
  bad_request: 400,
  unsupported: 400,
};

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: "bad_request", message });
}

/** Blob channel limits and link TTL (§5.6). */
const MAX_BLOB_BYTES = 256 * 1024 * 1024;
const BLOB_LINK_TTL_S = 300;

/** Short-lived link token (§5.6): HMAC over blob id + expiry, no server-side state. */
function linkSignature(key: Buffer, blobId: string, exp: string): string {
  return createHmac("sha256", key).update(`link|${blobId}|${exp}`).digest("base64url");
}

function linkSignatureValid(key: Buffer, blobId: string, exp: string, sig: string): boolean {
  const actual = Buffer.from(sig, "base64url");
  const expected = Buffer.from(linkSignature(key, blobId, exp), "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Names are hints only (§5.6): reject separators, traversal and absolute/drive paths. */
function badBlobName(name: string): boolean {
  return (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    /^[A-Za-z]:/.test(name)
  );
}

/** Raw body parser: keeps bytes for signature verification and exposes no parsed body. */
function rawBodyParser(
  request: FastifyRequest,
  body: Buffer,
  done: (error: Error | null, payload?: unknown) => void,
): void {
  (request as RawBodyRequest).rawBody = body;
  done(null, undefined);
}

function authenticate(request: FastifyRequest, deps: GatewayDeps): VerifiedAuth {
  return verifyAuth({
    key: deps.key,
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
    body: (request as RawBodyRequest).rawBody,
    header: request.headers.authorization,
    nonceCache: deps.nonceCache,
  });
}

/** Roster view incl. self; reads `deps.orcaNode.endpoint` live and digests self too. */
function membership(deps: GatewayDeps): {
  self: SelfRecord;
  roster: PeerView[];
  digest: string;
} {
  const self: SelfRecord = {
    orca_node_id: deps.orcaNode.orca_node_id,
    display_name: deps.orcaNode.display_name,
    endpoint: deps.orcaNode.endpoint ?? "",
    workgroup_id: deps.orcaNode.workgroup_id,
    protocol_version: PROTOCOL_VERSION,
    runtime: deps.runtime,
    runtime_digest: runtimeDigest(deps.runtime),
    state: "online",
    busy: deps.tasks.busy(),
    last_recv_at: nowIso(),
  };
  const roster: PeerView[] = [...deps.peers.list(), self];
  return { self, roster, digest: membersDigest(roster) };
}

export function createGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BLOB_BYTES });

  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as RawBodyRequest).rawBody = body;
      done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
    },
  );

  // Blob uploads (§5.6) are raw bytes; signature verification needs the raw body too.
  app.addContentTypeParser<Buffer>("application/octet-stream", { parseAs: "buffer" }, rawBodyParser);
  app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, rawBodyParser);

  app.get("/health", async () => ({ status: "ok", version: PROTOCOL_VERSION }));

  app.get("/.well-known/agent-card.json", async () => ({
    name: deps.orcaNode.display_name,
    protocol_version: PROTOCOL_VERSION,
    url: deps.orcaNode.endpoint ? `${deps.orcaNode.endpoint}/a2a` : "",
  }));

  app.post("/a2a", async (request, reply) => {
    const auth = authenticate(request, deps);
    const body = asObject(request.body) as JsonRpcEnvelope | null;
    if (!body || typeof body.method !== "string") {
      return badRequest(reply, "body must be a JSON-RPC request");
    }
    const id = body.id ?? null;
    const params = asObject(body.params) ?? {};
    try {
      let result: TaskView;
      if (body.method === "message/send") {
        const message = asObject(params["message"]) as A2AMessage | null;
        if (!message || !Array.isArray(message.parts)) {
          return badRequest(reply, "params.message with parts is required");
        }
        if (typeof message.taskId === "string" && message.taskId.length > 0) {
          result = deps.tasks.resume(message.taskId, message);
        } else {
          result = deps.tasks.submit({
            message,
            metadata: params["metadata"] as SubmitTaskInput["metadata"],
            originOrcaNode: auth.orcaNodeId,
          });
        }
      } else if (body.method === "tasks/get") {
        const taskId = String(params["id"] ?? "");
        const view = deps.tasks.get(taskId);
        if (!view) throw new TaskError("task_not_found", `unknown task ${taskId}`);
        result = view;
      } else if (body.method === "tasks/cancel") {
        result = deps.tasks.cancel(String(params["id"] ?? ""));
      } else {
        throw new TaskError("unsupported", `unsupported method ${body.method}`);
      }
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (error instanceof TaskError) {
        if (error.code === "orca_node_busy") {
          reply.code(429).header("retry-after", "30").send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: "orca_node_busy",
              data: { code: "orca_node_busy", retry_after_s: 30, holder: deps.tasks.busy() },
            },
          });
          return reply;
        }
        const status = TASK_ERROR_STATUS[error.code] ?? 500;
        reply.code(status).send({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: error.code, data: { message: error.message } },
        });
        return reply;
      }
      throw error;
    }
  });

  app.post("/blobs", async (request, reply) => {
    authenticate(request, deps);
    const body = (request as RawBodyRequest).rawBody ?? Buffer.alloc(0);
    const blobId = sha256Hex(body);
    if (request.headers["x-pod-body-sha256"] !== blobId) {
      return reply.code(400).send({ code: "blob_digest_mismatch" });
    }
    const rawName = (request.query as { name?: unknown }).name;
    let name: string | undefined;
    if (rawName !== undefined) {
      if (typeof rawName !== "string" || badBlobName(rawName)) {
        return reply.code(400).send({ code: "bad_blob_name" });
      }
      name = rawName;
    }
    const existed = deps.blobs.has(blobId);
    const blob = deps.blobs.put(body, { name });
    return reply.code(existed ? 200 : 201).send({
      blob_id: blob.blob_id,
      size: blob.size,
      name: blob.name,
      expires_at: blob.expires_at,
    });
  });

  app.get("/blobs/:blob_id", async (request, reply) => {
    const { blob_id: blobId } = request.params as { blob_id: string };
    const query = request.query as { exp?: unknown; sig?: unknown };
    if (typeof query.exp === "string" && typeof query.sig === "string") {
      if (!linkSignatureValid(deps.key, blobId, query.exp, query.sig)) {
        return reply.code(403).send({ code: "link_invalid" });
      }
      if (Number(query.exp) * 1000 <= Date.now()) {
        return reply.code(410).send({ code: "link_expired" });
      }
    } else {
      authenticate(request, deps);
    }
    const blob = deps.blobs.get(blobId);
    if (!blob) return reply.code(404).send({ code: "blob_not_found" });
    if (blob.expires_at !== null && Date.parse(blob.expires_at) <= Date.now()) {
      return reply.code(410).send({ code: "blob_expired" });
    }
    return reply.header("content-type", "application/octet-stream").send(blob.bytes);
  });

  app.post("/blobs/:blob_id/link", async (request, reply) => {
    authenticate(request, deps);
    const { blob_id: blobId } = request.params as { blob_id: string };
    if (!deps.blobs.has(blobId)) return reply.code(404).send({ code: "blob_not_found" });
    const expiresAtMs = Date.now() + BLOB_LINK_TTL_S * 1000;
    const exp = String(Math.floor(expiresAtMs / 1000));
    const sig = linkSignature(deps.key, blobId, exp);
    return {
      url: `${deps.orcaNode.endpoint ?? ""}/blobs/${blobId}?exp=${exp}&sig=${sig}`,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  });

  app.post("/cluster/join", async (request, reply) => {
    const auth = authenticate(request, deps);
    const body = asObject(request.body);
    if (!body) return badRequest(reply, "body must be a JSON object");

    if (body["workgroup_id"] !== deps.orcaNode.workgroup_id) {
      return reply.code(400).send({ code: "workgroup_mismatch", message: "workgroup_id does not match this orca node" });
    }

    const orcaNodeId = normalizeOrcaNodeId(String(body["orca_node_id"] ?? ""));
    if (!orcaNodeId || orcaNodeId !== auth.orcaNodeId) {
      return badRequest(reply, "orca_node_id does not match the authenticated orca node");
    }

    const displayName = body["display_name"];
    if (typeof displayName !== "string") {
      return badRequest(reply, "display_name must be a string");
    }

    const endpoint = body["endpoint"];
    if (!isHttpEndpoint(endpoint)) {
      return badRequest(reply, "endpoint must be an http(s) URL");
    }

    const runtimeValue = body["runtime"] ?? null;
    if (runtimeValue !== null && (typeof runtimeValue !== "object" || Array.isArray(runtimeValue))) {
      return badRequest(reply, "runtime must be an object or null");
    }
    const runtime = runtimeValue as RuntimeInfo | null;

    deps.peers.upsert({
      orca_node_id: orcaNodeId,
      display_name: displayName,
      endpoint,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: null,
      last_recv_at: nowIso(),
    });

    const { self, digest } = membership(deps);
    const response: JoinResponse = {
      self,
      members: deps.peers.list(),
      members_digest: digest,
    };
    return response;
  });

  app.post("/cluster/heartbeat", async (request, reply) => {
    const auth = authenticate(request, deps);
    const body = asObject(request.body);
    if (!body) return badRequest(reply, "body must be a JSON object");

    const orcaNodeId = normalizeOrcaNodeId(String(body["orca_node_id"] ?? ""));
    if (orcaNodeId !== auth.orcaNodeId) {
      return badRequest(reply, "orca_node_id does not match the authenticated orca node");
    }

    const isSelf = auth.orcaNodeId === deps.orcaNode.orca_node_id;
    if (!isSelf && !deps.peers.touch(auth.orcaNodeId)) {
      return reply.code(404).send({ code: "unknown_orca_node" });
    }

    const busy = body["busy"];
    if (busy !== undefined) {
      const peer = deps.peers.get(auth.orcaNodeId);
      if (peer) deps.peers.upsert({ ...peer, busy: busy as BusyState | null });
    }

    const { roster, digest } = membership(deps);
    const response: HeartbeatResponse = {
      from: deps.orcaNode.orca_node_id,
      busy: deps.tasks.busy(),
      members_digest: digest,
      members: body["digest"] === digest ? null : roster,
    };
    return response;
  });

  app.get("/cluster/members", async (request) => {
    authenticate(request, deps);
    const { roster, digest } = membership(deps);
    const response: MembersResponse = { members_digest: digest, members: roster };
    return response;
  });

  app.post("/cluster/leave", async (request) => {
    const auth = authenticate(request, deps);
    deps.peers.remove(auth.orcaNodeId);
    return { ok: true };
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send({ code: "blob_too_large" });
      return;
    }
    if (error instanceof PodAuthError) {
      reply.code(401).send({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof SyntaxError) {
      reply.code(400).send({ code: "bad_request", message: "invalid JSON body" });
      return;
    }
    reply.code(500).send({ code: "internal", message: "internal server error" });
  });

  return app;
}
