import type { FastifyInstance } from "fastify";
import { PodError } from "../../kernel/errors.ts";
import { A2A_PARAMS, RpcRequestSchema, isA2AMethod } from "../../protocol/a2a.ts";
import type { TaskView } from "../../protocol/task.ts";
import type { GatewayDeps } from "./gateway.ts";
import { parseInput } from "./input.ts";
import type { OrcaNodeId } from "../../protocol/peer.ts";

function dispatch(deps: GatewayDeps, method: string, raw: unknown, caller: OrcaNodeId): TaskView {
  if (!isA2AMethod(method)) throw new PodError("unsupported", `unsupported method ${method}`);
  switch (method) {
    case "message/send": {
      // The schema checked the message parts and metadata.pod; the runner reads them as typed.
      const { message, metadata } = parseInput(A2A_PARAMS[method], raw, "params");
      return message.taskId
        ? deps.tasks.resume(message.taskId, message, caller)
        : deps.tasks.submit({ message, metadata, originOrcaNode: caller });
    }
    case "tasks/get": {
      const { id } = parseInput(A2A_PARAMS[method], raw, "params");
      const view = deps.tasks.get(id);
      if (!view) throw new PodError("task_not_found", `unknown task ${id}`);
      return view;
    }
    case "tasks/cancel": {
      const { id } = parseInput(A2A_PARAMS[method], raw, "params");
      const origin = deps.tasks.originOf(id);
      if (origin === null) throw new PodError("task_not_found", `unknown task ${id}`);
      // Only the origin (or this orca node itself, e.g. local control paths) may cancel.
      if (caller !== origin && caller !== deps.orcaNode.orca_node_id) {
        throw new PodError("not_task_origin", "only the task origin may cancel it");
      }
      return deps.tasks.cancel(id);
    }
  }
}

export function a2aRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.post("/a2a", { config: { access: "member", rpc: true } }, async (request) => {
    const { id, method, params } = parseInput(RpcRequestSchema, request.body, "body");
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: dispatch(deps, method, params, request.auth.orcaNodeId),
    };
  });
}
