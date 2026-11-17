import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  BusyStateSchema,
  ModelOffersSchema,
  ModelSelectionSchema,
  ReasoningEffortSchema,
  RuntimeInfoSchema,
  membersDigest,
  normalizeEndpoints,
  runtimeDigest,
  type HeartbeatResponse,
  type JoinResponse,
  type MembersResponse,
  type PeerView,
  type SelfRecord,
} from "../../protocol/index.ts";
import { DEFAULT_CLOCK_SKEW_MS, verifyAdmissionProof, type AdmissionKind } from "../../security/index.ts";
import { PodError } from "../../kernel/index.ts";
import { EXPLICIT_DIAL_POLICY, screenEndpoint } from "../../membership/index.ts";
import { isDirectLoopbackRequest } from "../net.ts";
import type { GatewayDeps } from "./index.ts";
import { parseInput } from "./input.ts";

const NonEmpty = z.string().min(1);

/** Fields every admission (join, heartbeat) carries (§7.1). */
const admission = {
  workgroup_id: z.string(),
  orca_node_id: z.string(),
  ts: z.number().int(),
  nonce: z.string(),
  proof: z.string(),
};

const JoinBody = z.object({
  ...admission,
  display_name: z.string(),
  endpoints: z.array(z.string()),
  runtime: RuntimeInfoSchema.nullable().optional(),
  max_task_ttl_s: z.number().positive().optional(),
  models: ModelOffersSchema.optional(),
  default_model: ModelSelectionSchema.nullable().optional(),
  default_reasoning_effort: ReasoningEffortSchema.nullable().optional(),
});
type AdmissionBody = Pick<z.infer<typeof JoinBody>, keyof typeof admission>;

const HeartbeatBody = z.object({
  ...admission,
  digest: z.string().optional(),
  busy: BusyStateSchema.nullable().optional(),
});

const ChildLinkBody = z.object({ parent_task_id: NonEmpty, peer: NonEmpty, child_task_id: NonEmpty });

const TaskQuery = z.object({ task: NonEmpty });

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

  app.post("/cluster/join", { config: { access: "join" } }, async (request) => {
    const body = parseInput(JoinBody, request.body, "body");
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
  });

  app.post("/cluster/heartbeat", { config: { access: "member" } }, async (request) => {
    const body = parseInput(HeartbeatBody, request.body, "body");
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
  });

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
  app.post("/cluster/child-link", { config: { access: "local" } }, async (request) => {
    const {
      parent_task_id: parentTaskId,
      peer,
      child_task_id: childTaskId,
    } = parseInput(ChildLinkBody, request.body, "body");
    deps.orcaNode.linkChildTask(parentTaskId, peer, childTaskId);
    return { ok: true };
  });

  // Local control: read one of this node's task views so the CLI can inherit
  // `metadata.pod` (hop/chain/root) when it dispatches a child task (section 5.1).
  app.get("/cluster/task", { config: { access: "local" } }, async (request) => {
    const { task } = parseInput(TaskQuery, request.query, "querystring");
    const view = deps.tasks.get(task);
    if (view === null) throw new PodError("task_not_found", `unknown task ${task}`);
    return view;
  });
}
