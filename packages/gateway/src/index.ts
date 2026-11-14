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
} from "@orca/crypto";
import {
  PROTOCOL_VERSION,
  isHttpEndpoint,
  membersDigest,
  normalizeNodeId,
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
} from "@orca/protocol";
import type { PeerStore } from "@orca/storage";

export type GatewayNode = {
  node_id: string;
  display_name: string;
  workgroup_id: string;
  endpoint: string | null;
};

export type GatewayDeps = {
  node: GatewayNode;
  key: Buffer;
  peers: PeerStore;
  nonceCache: NonceCache;
  runtime: RuntimeInfo | null;
  tasks: TaskRunner;
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };
type JsonObject = Record<string, unknown>;
type JsonRpcEnvelope = { id?: unknown; method?: string; params?: unknown };

/** Task failures are protocol-level; the HTTP status mirrors the documented code (§6.3, §6.9). */
const TASK_ERROR_STATUS: Record<string, number> = {
  bad_echo_script: 400,
  node_busy: 429,
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

/** Roster view incl. self; reads `deps.node.endpoint` live and digests self too. */
function membership(deps: GatewayDeps): {
  self: SelfRecord;
  roster: PeerView[];
  digest: string;
} {
  const self: SelfRecord = {
    node_id: deps.node.node_id,
    display_name: deps.node.display_name,
    endpoint: deps.node.endpoint ?? "",
    workgroup_id: deps.node.workgroup_id,
    protocol_version: PROTOCOL_VERSION,
    runtime: deps.runtime,
    runtime_digest: runtimeDigest(deps.runtime),
    state: "online",
    busy: null,
    last_recv_at: nowIso(),
  };
  const roster: PeerView[] = [...deps.peers.list(), self];
  return { self, roster, digest: membersDigest(roster) };
}

export function createGateway(deps: GatewayDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addContentTypeParser<Buffer>(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      (request as RawBodyRequest).rawBody = body;
      done(null, body.length === 0 ? undefined : (JSON.parse(body.toString("utf8")) as unknown));
    },
  );

  app.get("/health", async () => ({ status: "ok", version: PROTOCOL_VERSION }));

  app.get("/.well-known/agent-card.json", async () => ({
    name: deps.node.display_name,
    protocol_version: PROTOCOL_VERSION,
    url: deps.node.endpoint ? `${deps.node.endpoint}/a2a` : "",
  }));

  app.post("/a2a", async (request, reply) => {
    authenticate(request, deps);
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
          result = deps.tasks.submit({ message, metadata: params["metadata"] as SubmitTaskInput["metadata"] });
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

  app.post("/cluster/join", async (request, reply) => {
    const auth = authenticate(request, deps);
    const body = asObject(request.body);
    if (!body) return badRequest(reply, "body must be a JSON object");

    if (body["workgroup_id"] !== deps.node.workgroup_id) {
      return reply.code(400).send({ code: "workgroup_mismatch", message: "workgroup_id does not match this node" });
    }

    const nodeId = normalizeNodeId(String(body["node_id"] ?? ""));
    if (!nodeId || nodeId !== auth.nodeId) {
      return badRequest(reply, "node_id does not match the authenticated node");
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
      node_id: nodeId,
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

    const nodeId = normalizeNodeId(String(body["node_id"] ?? ""));
    if (nodeId !== auth.nodeId) {
      return badRequest(reply, "node_id does not match the authenticated node");
    }

    const isSelf = auth.nodeId === deps.node.node_id;
    if (!isSelf && !deps.peers.touch(auth.nodeId)) {
      return reply.code(404).send({ code: "unknown_node" });
    }

    const busy = body["busy"];
    if (busy !== undefined) {
      const peer = deps.peers.get(auth.nodeId);
      if (peer) deps.peers.upsert({ ...peer, busy: busy as BusyState | null });
    }

    const { roster, digest } = membership(deps);
    const response: HeartbeatResponse = {
      from: deps.node.node_id,
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
    deps.peers.remove(auth.nodeId);
    return { ok: true };
  });

  app.setErrorHandler((error: unknown, _request, reply) => {
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
