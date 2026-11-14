import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  blobLinkSignature,
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
  type TaskRelay,
  type A2AMessage,
  type SubmitTaskInput,
} from "./protocol.ts";
import { BlobTooLargeError, type BlobStore, type PeerStore } from "./storage.ts";
import { createFileBlobRegistry, type FileBlobRegistry } from "./blob-files.ts";

export type GatewayOrcaNode = {
  orca_node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoint: string | null;
  /** Per-task budget advertised to peers; origins size tasks to it (§6.9). */
  max_task_ttl_s?: number;
  /** Local-only capability: register a child task for automatic relay (§7.12). */
  linkChildTask?: (parentTaskId: string, peerUrl: string, childTaskId: string) => void;
};

export type GatewayDeps = {
  orcaNode: GatewayOrcaNode;
  key: Buffer;
  peers: PeerStore;
  nonceCache: NonceCache;
  runtime: RuntimeInfo | null;
  tasks: TaskRunner;
  blobs: BlobStore;
  /** Files a task published by path with a TTL (§5.6). Optional for direct gateway fixtures. */
  fileBlobs?: FileBlobRegistry;
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
  not_task_origin: 403,
  permission_denied: 409,
  grant_invalid: 409,
  grant_expired: 409,
  ancestor_call_forbidden: 403,
  escalation_required: 409,
  duplicate_input_name: 409,
  input_blob_missing: 400,
  too_many_inputs: 400,
  inputs_too_large: 400,
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
function linkSignatureValid(key: Buffer, blobId: string, exp: string, sig: string): boolean {
  const actual = Buffer.from(sig, "base64url");
  const expected = Buffer.from(blobLinkSignature(key, blobId, exp), "base64url");
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

/** Fallback for stores without `putStream`: buffer a streamed body, bounded. */
async function collectBody(stream: Readable | undefined, maxBytes: number): Promise<Buffer> {
  if (stream === undefined) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new BlobTooLargeError(maxBytes);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authenticate(
  request: FastifyRequest,
  deps: GatewayDeps,
  bodySha256?: string,
): VerifiedAuth {
  return verifyAuth({
    key: deps.key,
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
    body: (request as RawBodyRequest).rawBody,
    ...(bodySha256 === undefined ? {} : { bodySha256 }),
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
    ...(deps.orcaNode.max_task_ttl_s === undefined ? {} : { max_task_ttl_s: deps.orcaNode.max_task_ttl_s }),
  };
  const roster: PeerView[] = [...deps.peers.list(), self];
  return { self, roster, digest: membersDigest(roster) };
}

export function createGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_BLOB_BYTES });
  const fileBlobs = deps.fileBlobs ?? createFileBlobRegistry();

  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as RawBodyRequest).rawBody = body;
      done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
    },
  );

  // Blob uploads (§5.6) stream raw bytes: the client signs the file digest in
  // `x-pod-body-sha256`, so the body is never buffered in memory. The overload
  // that accepts a stream parser is not part of Fastify's generic typings.
  type StreamParserRegistration = (
    contentType: string,
    parser: (
      request: unknown,
      payload: Readable,
      done: (error: Error | null, body?: unknown) => void,
    ) => void,
  ) => void;
  (app as unknown as { addContentTypeParser: StreamParserRegistration }).addContentTypeParser(
    "application/octet-stream",
    (_request, payload, done) => {
      done(null, payload);
    },
  );
  app.addContentTypeParser<Buffer>("*", { parseAs: "buffer" }, rawBodyParser);

  app.get("/health", async () => ({ status: "ok", version: PROTOCOL_VERSION }));

  app.get("/.well-known/agent-card.json", async () => ({
    name: deps.orcaNode.display_name,
    protocol_version: PROTOCOL_VERSION,
    url: deps.orcaNode.endpoint ? `${deps.orcaNode.endpoint}/a2a` : "",
    ...(deps.orcaNode.max_task_ttl_s === undefined
      ? {}
      : { max_task_ttl_s: deps.orcaNode.max_task_ttl_s }),
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
          result = deps.tasks.resume(message.taskId, message, auth.orcaNodeId);
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
      } else if (body.method === "tasks/escalate") {
        // Local control used by the CLI: the agent parks its own task because a
        // child task needs an approval that only this task's origin can give.
        if (auth.orcaNodeId !== deps.orcaNode.orca_node_id) {
          throw new TaskError("bad_request", "tasks/escalate is a local control");
        }
        result = deps.tasks.escalate(
          String(params["taskId"] ?? ""),
          params["relay"] as TaskRelay,
          auth.orcaNodeId,
        );
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
    // Streaming uploads sign the digest up front, so auth is verified before
    // any body bytes are read; the store hashes while it writes (§5.6).
    const declaredHeader = request.headers["x-pod-body-sha256"];
    const declared = typeof declaredHeader === "string" ? declaredHeader : undefined;
    if (declared === undefined || !/^[0-9a-f]{64}$/.test(declared)) {
      return reply.code(400).send({ code: "blob_digest_missing", message: "x-pod-body-sha256 is required" });
    }
    authenticate(request, deps, declared);
    const rawName = (request.query as { name?: unknown }).name;
    let name: string | undefined;
    if (rawName !== undefined) {
      if (typeof rawName !== "string" || badBlobName(rawName)) {
        return reply.code(400).send({ code: "bad_blob_name" });
      }
      name = rawName;
    }
    const existed = deps.blobs.has(declared);
    const stream = request.body as Readable | undefined;
    let record;
    try {
      record =
        deps.blobs.putStream !== undefined && stream !== undefined
          ? await deps.blobs.putStream(stream, { name, maxBytes: MAX_BLOB_BYTES })
          : deps.blobs.put(await collectBody(stream, MAX_BLOB_BYTES), { name });
    } catch (error) {
      if (error instanceof BlobTooLargeError) return reply.code(413).send({ code: "blob_too_large" });
      throw error;
    }
    if (record.blob_id !== declared) {
      return reply.code(400).send({ code: "blob_digest_mismatch" });
    }
    return reply.code(existed ? 200 : 201).send({
      blob_id: record.blob_id,
      size: record.size,
      name: record.name,
      expires_at: record.expires_at,
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
    // Stream when the store supports it; only the small in-memory test store
    // buffers the whole blob (§5.6).
    const read = deps.blobs.openRead?.(blobId);
    if (read) {
      const expiresAt = read.record.expires_at;
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
        read.stream.destroy();
        return reply.code(410).send({ code: "blob_expired" });
      }
      return reply
        .header("content-type", read.record.media_type ?? "application/octet-stream")
        .header("content-length", String(read.size))
        .send(read.stream);
    }
    const blob = deps.blobs.get(blobId);
    const file = blob ? undefined : fileBlobs.get(blobId);
    if (!blob && !file) return reply.code(404).send({ code: "blob_not_found" });
    const expiresAt = blob ? blob.expires_at : file!.expires_at;
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
      return reply.code(410).send({ code: "blob_expired" });
    }
    if (blob) return reply.header("content-type", "application/octet-stream").send(blob.bytes);
    try {
      await stat(file!.path);
    } catch {
      return reply.code(410).send({ code: "blob_file_missing" });
    }
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(file!.size))
      .send(createReadStream(file!.path));
  });

  app.post("/blobs/:blob_id/link", async (request, reply) => {
    authenticate(request, deps);
    const { blob_id: blobId } = request.params as { blob_id: string };
    if (!deps.blobs.has(blobId)) return reply.code(404).send({ code: "blob_not_found" });
    const expiresAtMs = Date.now() + BLOB_LINK_TTL_S * 1000;
    const exp = String(Math.floor(expiresAtMs / 1000));
    const sig = blobLinkSignature(deps.key, blobId, exp);
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
    const peerTtl = body["max_task_ttl_s"];

    deps.peers.upsert({
      orca_node_id: orcaNodeId,
      display_name: displayName,
      endpoint,
      runtime,
      runtime_digest: runtimeDigest(runtime),
      state: "online",
      busy: null,
      last_recv_at: nowIso(),
      ...(typeof peerTtl === "number" && Number.isFinite(peerTtl) && peerTtl > 0
        ? { max_task_ttl_s: peerTtl }
        : {}),
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

  /**
   * Local control: tell this node that one of its local tasks delegated `child_task_id`
   * to `peer`, so the node can relay the child's permission requests automatically
   * (§7.12). A shared workgroup key cannot prove which node signed, so "local only"
   * is a transport fact (loopback, no proxy headers), not a signature claim (§7.1).
   */
  app.post("/cluster/child-link", async (request, reply) => {
    const remote = request.socket.remoteAddress ?? "";
    const proxied =
      request.headers["x-forwarded-for"] !== undefined ||
      request.headers["forwarded"] !== undefined ||
      request.headers["x-real-ip"] !== undefined;
    const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (proxied || !loopback) {
      return reply.code(403).send({ code: "local_only", message: "child links are a local control" });
    }
    authenticate(request, deps);
    const body = asObject(request.body);
    if (!body) return badRequest(reply, "body must be a JSON object");
    const parentTaskId = body["parent_task_id"];
    const peer = body["peer"];
    const childTaskId = body["child_task_id"];
    if (typeof parentTaskId !== "string" || typeof peer !== "string" || typeof childTaskId !== "string") {
      return badRequest(reply, "parent_task_id, peer and child_task_id must be strings");
    }
    if (deps.orcaNode.linkChildTask === undefined) {
      return reply.code(400).send({ code: "bad_request", message: "this orca node cannot relay child tasks" });
    }
    try {
      deps.orcaNode.linkChildTask(parentTaskId, peer, childTaskId);
    } catch (error) {
      return badRequest(reply, error instanceof Error ? error.message : String(error));
    }
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
