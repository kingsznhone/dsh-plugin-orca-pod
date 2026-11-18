import type { FastifyInstance } from "fastify";
import { PodError } from "../core/errors.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { SingleSlotTaskRunner } from "../task/runner.ts";
import { A2A_PARAMS, RpcRequestSchema, isA2AMethod, type TaskView } from "../task/wire.ts";
import { parseInput } from "./input.ts";

/** The A2A JSON-RPC surface (§4.7): submit, read and cancel tasks. */
export class A2aRoutes {
  constructor(
    private readonly selfId: OrcaNodeId,
    private readonly tasks: SingleSlotTaskRunner,
  ) {}

  register(app: FastifyInstance): void {
    app.post("/a2a", { config: { access: "member", rpc: true } }, async (request) => {
      const { id, method, params } = parseInput(RpcRequestSchema, request.body, "body");
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        result: this.dispatch(method, params, request.auth.orcaNodeId),
      };
    });
  }

  private dispatch(method: string, raw: unknown, caller: OrcaNodeId): TaskView {
    if (!isA2AMethod(method)) throw new PodError("unsupported", `unsupported method ${method}`);
    switch (method) {
      case "message/send": {
        // The schema checked the message parts and metadata.pod; the runner reads them as typed.
        const { message, metadata } = parseInput(A2A_PARAMS[method], raw, "params");
        return message.taskId
          ? this.tasks.resume(message.taskId, message, caller)
          : this.tasks.submit({ message, metadata, originOrcaNode: caller });
      }
      case "tasks/get": {
        const { id } = parseInput(A2A_PARAMS[method], raw, "params");
        const view = this.tasks.get(id);
        if (!view) throw new PodError("task_not_found", `unknown task ${id}`);
        return view;
      }
      case "tasks/cancel": {
        const { id } = parseInput(A2A_PARAMS[method], raw, "params");
        const origin = this.tasks.originOf(id);
        if (origin === null) throw new PodError("task_not_found", `unknown task ${id}`);
        // Only the origin (or this orca node itself, e.g. local control paths) may cancel.
        if (caller !== origin && caller !== this.selfId) {
          throw new PodError("not_task_origin", "only the task origin may cancel it");
        }
        return this.tasks.cancel(id);
      }
    }
  }
}
