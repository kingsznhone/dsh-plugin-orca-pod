import type { FastifyInstance, FastifyRequest } from "fastify";

import { PodError } from "../core/errors.ts";
import { isDirectLoopbackRequest, normalizeEndpoints } from "../core/net.ts";
import { membersDigest, type HelloResponse, type MembersResponse, HelloRequestSchema } from "../mesh/wire.ts";
import type { Mesh } from "../mesh/mesh.ts";
import { parseInput } from "./input.ts";

/** The routes of the workgroup (§3, §7.1): `hello` and the inspection routes. */
export class ClusterRoutes {
  constructor(private readonly mesh: Mesh) {}

  register(app: FastifyInstance): void {
    app.get("/health", { config: { access: "public" } }, () => this.health());
    app.get("/.well-known/agent-card.json", { config: { access: "public" } }, () => this.agentCard());
    app.post("/cluster/hello", { config: { access: "hello" } }, (request) => this.hello(request));
    // Inspection: every record this node holds, offline ones included. No node
    // merges it into its own table.
    app.get("/cluster/members", { config: { access: "member" } }, () => this.members());
  }

  private health() {
    return {
      status: "ok",
      // Public identity hint: a first-time caller uses it to bind the target id
      // into the request signature (the id is a public key).
      orca_node_id: this.mesh.self.id,
    };
  }

  private agentCard() {
    const self = this.mesh.self.selfRecord();
    const [primary] = self.endpoints;
    return {
      name: self.display_name,
      url: primary ? `${primary}/a2a` : "",
      max_task_ttl_s: self.max_task_ttl_s,
    };
  }

  /**
   * A node greeted this one (§3.3). Both proofs already held when it got here; what
   * is left is that what the sender declared about itself is input: its endpoints
   * are screened before they are recorded (§7.7).
   */
  private async hello(request: FastifyRequest): Promise<HelloResponse> {
    const body = parseInput(HelloRequestSchema, request.body, "body");
    const caller = request.auth.orcaNodeId;
    const declared = normalizeEndpoints(body.self.endpoints);
    if (declared === null) throw new PodError("bad_request", "endpoints must be 1-8 distinct http(s) URLs");
    // A node already in the table repeats the same endpoints every few seconds, so its last verdict may be reused; a first contact is always screened afresh.
    const endpoints = await this.mesh.screening.declared(
      declared,
      isDirectLoopbackRequest(request),
      this.mesh.get(caller) === undefined,
    );
    if (endpoints.length === 0) {
      throw new PodError("endpoint_refused", `none of the declared endpoints may be dialed: ${declared.join(", ")}`);
    }
    return this.mesh.answer(caller, body, endpoints);
  }

  private members(): MembersResponse {
    const members = [...this.mesh.peers().map((node) => node.view()), this.mesh.self.selfRecord()];
    return { members_digest: membersDigest(members), members };
  }
}
