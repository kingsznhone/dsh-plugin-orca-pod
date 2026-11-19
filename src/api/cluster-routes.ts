import type { FastifyInstance, FastifyRequest } from "fastify";

import { isDirectLoopbackRequest } from "./access.ts";
import { type HelloResponse, HelloRequestSchema } from "../mesh/wire.ts";
import type { Mesh } from "../mesh/mesh.ts";
import { parseInput } from "./input.ts";

/** The routes of the workgroup (§3, §7.1): the public `health` check and `hello`. */
export class ClusterRoutes {
  constructor(private readonly mesh: Mesh) {}

  register(app: FastifyInstance): void {
    app.get("/health", { config: { access: "public" } }, () => this.health());
    app.post("/cluster/hello", { config: { access: "hello" } }, (request) => this.hello(request));
  }

  private health() {
    return {
      status: "ok",
      // Public identity hint: a first-time caller uses it to bind the target id
      // into the request signature (the id is a public key).
      orca_node_id: this.mesh.self.id,
    };
  }

  /** A node greeted this one (§3.3); both proofs already held when it got here. */
  private hello(request: FastifyRequest): Promise<HelloResponse> {
    const body = parseInput(HelloRequestSchema, request.body, "body");
    return this.mesh.greeted(request.auth.orcaNodeId, body, isDirectLoopbackRequest(request));
  }
}
