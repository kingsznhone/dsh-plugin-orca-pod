import type { FastifyInstance, FastifyRequest } from "fastify";

import { MAX_MODEL_OFFERS } from "../../node/settings.ts";
import { DEFAULT_CLOCK_SKEW_MS, verifyAdmissionProof, type AdmissionKind } from "../../security/index.ts";
import { PodError } from "../../kernel/index.ts";
import { EXPLICIT_DIAL_POLICY, isDirectLoopbackRequest, screenEndpoint } from "../net.ts";
import {
  membersDigest,
  normalizeEndpoints,
  runtimeDigest,
  type BusyState,
  type HeartbeatResponse,
  type JoinResponse,
  type MembersResponse,
  type ModelOffer,
  type ModelSelection,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
} from "../../protocol/index.ts";
import type { GatewayDeps } from "./index.ts";

type AdmissionBody = {
  workgroup_id: string;
  orca_node_id: string;
  ts: number;
  nonce: string;
  proof: string;
};

type JoinBody = AdmissionBody & {
  display_name: string;
  endpoints: string[];
  runtime?: RuntimeInfo | null;
  max_task_ttl_s?: number;
  models?: ModelOffer[];
  default_model?: ModelSelection | null;
  default_reasoning_effort?: string | null;
};

type HeartbeatBody = AdmissionBody & { digest?: string; busy?: BusyState | null };

type ChildLinkBody = { parent_task_id: string; peer: string; child_task_id: string };

const text = { type: "string" };
const nonEmpty = { type: "string", minLength: 1 };

const admissionProperties = {
  workgroup_id: text,
  orca_node_id: text,
  ts: { type: "integer" },
  nonce: text,
  proof: text,
};
const admissionRequired = ["workgroup_id", "orca_node_id", "ts", "nonce", "proof"];

const busySchema = {
  type: ["object", "null"],
  required: ["task_id", "origin_orca_node", "since"],
  properties: { task_id: text, origin_orca_node: text, since: text },
};

const runtimeSchema = {
  type: ["object", "null"],
  required: ["os", "arch", "cpu", "memory", "node", "captured_at"],
  properties: {
    os: {
      type: "object",
      required: ["family", "name", "version"],
      properties: { family: text, name: text, version: text },
    },
    arch: text,
    cpu: {
      type: "object",
      required: ["model", "logical_cores"],
      properties: { model: text, logical_cores: { type: "integer" } },
    },
    memory: { type: "object", required: ["total_bytes"], properties: { total_bytes: { type: "number" } } },
    node: { type: "object", required: ["version"], properties: { version: text } },
    captured_at: text,
  },
};

const joinSchema = {
  type: "object",
  required: [...admissionRequired, "display_name", "endpoints"],
  properties: {
    ...admissionProperties,
    display_name: text,
    endpoints: { type: "array", items: text },
    runtime: runtimeSchema,
    max_task_ttl_s: { type: "number", exclusiveMinimum: 0 },
    models: {
      type: "array",
      maxItems: MAX_MODEL_OFFERS,
      items: {
        type: "object",
        required: ["provider", "model"],
        additionalProperties: false,
        properties: { provider: nonEmpty, model: nonEmpty, name: text, description: text },
      },
    },
    default_model: {
      type: ["object", "null"],
      required: ["provider", "model"],
      additionalProperties: false,
      properties: { provider: nonEmpty, model: nonEmpty, reasoning_effort: nonEmpty },
    },
    default_reasoning_effort: { type: ["string", "null"], pattern: "\\S" },
  },
};

const heartbeatSchema = {
  type: "object",
  required: admissionRequired,
  properties: { ...admissionProperties, digest: text, busy: busySchema },
};

const childLinkSchema = {
  type: "object",
  required: ["parent_task_id", "peer", "child_task_id"],
  properties: { parent_task_id: nonEmpty, peer: nonEmpty, child_task_id: nonEmpty },
};

const taskQuerySchema = {
  type: "object",
  required: ["task"],
  properties: { task: nonEmpty },
};

/**
 * Admission (section 7.1): the Ed25519 signature proved which node is calling;
 * the password-derived proof shows it still holds the workgroup secret.
 * Heartbeats repeat it so a node whose password changed drops out within a few
 * ticks.
 */
function admit(deps: GatewayDeps, kind: AdmissionKind, caller: string, body: AdmissionBody): void {
  if (body.workgroup_id !== deps.orcaNode.workgroup_id) {
    throw new PodError("workgroup_mismatch", "workgroup_id does not match this orca node");
  }
  if (body.orca_node_id !== caller) {
    throw new PodError("bad_request", "orca_node_id does not match the authenticated orca node");
  }
  if (Math.abs(Date.now() - body.ts) > DEFAULT_CLOCK_SKEW_MS) {
    throw new PodError("clock_skew", "admission proof timestamp outside the skew window");
  }
  const fields = { workgroupId: body.workgroup_id, orcaNodeId: caller, ts: body.ts, nonce: body.nonce };
  if (!verifyAdmissionProof(kind, deps.workgroupKey, fields, body.proof)) {
    throw new PodError("bad_proof", "workgroup admission proof does not verify");
  }
  if (!deps.nonceCache.remember(`${kind}:${caller}:${body.nonce}`)) {
    throw new PodError("nonce_replay", "admission nonce already used");
  }
}

/** Roster view including self, digested together. */
function roster(deps: GatewayDeps): { self: SelfRecord; members: PeerView[]; digest: string } {
  const self = deps.orcaNode.self();
  const members = [...deps.peers.list(), self];
  return { self, members, digest: membersDigest(members) };
}

/**
 * The endpoints of a joining node this node is willing to dial back (§7.7).
 * The joiner proved the password, so public addresses are fine, but what it
 * declares is still input: link-local (cloud metadata), multicast and
 * unspecified addresses are dropped, and so are loopback addresses unless the
 * join itself came over loopback (a remote machine cannot be reached at our
 * 127.0.0.1, so such an endpoint could only aim our heartbeats at a local
 * service). The transport repeats the check on every connection.
 */
async function dialableEndpoints(declared: string[], request: FastifyRequest): Promise<string[]> {
  const policy = { ...EXPLICIT_DIAL_POLICY, allowLoopbackPeers: isDirectLoopbackRequest(request) };
  // A name that does not resolve from here is kept: it is not known to be bad,
  // and the transport screens whatever it resolves to when it is dialed.
  const verdicts = await Promise.all(declared.map((endpoint) => screenEndpoint(endpoint, policy)));
  const allowed = declared.filter((_, index) => verdicts[index] !== "refused");
  if (allowed.length === 0) {
    throw new PodError("endpoint_refused", `none of the declared endpoints may be dialed: ${declared.join(", ")}`);
  }
  return allowed;
}

export function clusterRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.get("/health", { config: { access: "public" } }, async () => ({
    status: "ok",
    // Public identity hint: a CLI or a first-time caller uses it to bind the
    // target id into the request signature (the id is a public key).
    orca_node_id: deps.orcaNode.orca_node_id,
  }));

  app.get("/.well-known/agent-card.json", { config: { access: "public" } }, async () => {
    const self = deps.orcaNode.self();
    const [primary] = self.endpoints;
    return {
      name: self.display_name,
      url: primary ? `${primary}/a2a` : "",
      max_task_ttl_s: self.max_task_ttl_s,
    };
  });

  app.post<{ Body: JoinBody }>(
    "/cluster/join",
    { config: { access: "join" }, schema: { body: joinSchema } },
    async (request) => {
      const body = request.body;
      admit(deps, "join", request.auth.orcaNodeId, body);
      const declared = normalizeEndpoints(body.endpoints);
      if (declared === null) {
        throw new PodError("bad_request", "endpoints must be 1-8 distinct http(s) URLs");
      }
      const endpoints = await dialableEndpoints(declared, request);
      const runtime = body.runtime ?? null;
      deps.peers.upsert({
        orca_node_id: body.orca_node_id,
        display_name: body.display_name,
        endpoints,
        runtime,
        runtime_digest: runtimeDigest(runtime),
        state: "online",
        busy: null,
        last_recv_at: new Date().toISOString(),
        max_task_ttl_s: body.max_task_ttl_s,
        models: body.models,
        default_model: body.default_model,
        default_reasoning_effort: body.default_reasoning_effort,
      });
      const { self, digest } = roster(deps);
      const response: JoinResponse = { self, members: deps.peers.list(), members_digest: digest };
      return response;
    },
  );

  app.post<{ Body: HeartbeatBody }>(
    "/cluster/heartbeat",
    { config: { access: "member" }, schema: { body: heartbeatSchema } },
    async (request) => {
      const body = request.body;
      const caller = request.auth.orcaNodeId;
      admit(deps, "heartbeat", caller, body);
      if (caller !== deps.orcaNode.orca_node_id && !deps.peers.touch(caller)) {
        throw new PodError("unknown_orca_node");
      }
      const peer = deps.peers.get(caller);
      if (body.busy !== undefined && peer) deps.peers.upsert({ ...peer, busy: body.busy });

      const { members, digest } = roster(deps);
      const response: HeartbeatResponse = {
        from: deps.orcaNode.orca_node_id,
        busy: deps.tasks.busy(),
        members_digest: digest,
        members: body.digest === digest ? null : members,
      };
      return response;
    },
  );

  app.get("/cluster/members", { config: { access: "member" } }, async () => {
    const { members, digest } = roster(deps);
    const response: MembersResponse = { members_digest: digest, members };
    return response;
  });

  app.post("/cluster/leave", { config: { access: "member" } }, async (request) => {
    deps.peers.remove(request.auth.orcaNodeId);
    return { ok: true };
  });

  // Local control: tell this node that one of its local tasks delegated
  // `child_task_id` to `peer`, so it can relay the child's permission requests
  // automatically (section 7.12).
  app.post<{ Body: ChildLinkBody }>(
    "/cluster/child-link",
    { config: { access: "local" }, schema: { body: childLinkSchema } },
    async (request) => {
      const { parent_task_id: parentTaskId, peer, child_task_id: childTaskId } = request.body;
      deps.orcaNode.linkChildTask(parentTaskId, peer, childTaskId);
      return { ok: true };
    },
  );

  // Local control: read one of this node's task views so the CLI can inherit
  // `metadata.pod` (hop/chain/root) when it dispatches a child task (section 5.1).
  app.get<{ Querystring: { task: string } }>(
    "/cluster/task",
    { config: { access: "local" }, schema: { querystring: taskQuerySchema } },
    async (request) => {
      const { task } = request.query;
      const view = deps.tasks.get(task);
      if (view === null) throw new PodError("task_not_found", `unknown task ${task}`);
      return view;
    },
  );
}
