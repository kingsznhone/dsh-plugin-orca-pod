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
  type BusyState,
  type HeartbeatResponse,
  type JoinResponse,
  type MembersResponse,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
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
};

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };
type JsonObject = Record<string, unknown>;

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
    url: deps.node.endpoint ?? "",
  }));

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
