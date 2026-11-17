import type { FastifyInstance } from "fastify";

import { PodError } from "../../kernel/index.ts";
import type { A2AMessage, SubmitTaskInput, TaskRelay, TaskView } from "../../protocol/index.ts";
import type { GatewayDeps } from "./index.ts";

type A2aParams = {
  message: A2AMessage;
  metadata?: SubmitTaskInput["metadata"];
  id: string;
  taskId: string;
  relay: TaskRelay;
};

/** `params` is only guaranteed to hold the fields of the method it was validated for. */
type A2aBody = { id?: unknown; method: string; params: A2aParams };

/** The params a method needs; the schema below requires them only for that method. */
const REQUIRED_PARAMS: Record<string, string[]> = {
  "message/send": ["message"],
  "tasks/get": ["id"],
  "tasks/cancel": ["id"],
  "tasks/escalate": ["taskId", "relay"],
};

const bodySchema = {
  type: "object",
  required: ["method"],
  properties: {
    method: { type: "string" },
    params: {
      type: "object",
      properties: {
        message: {
          type: "object",
          required: ["parts"],
          properties: { parts: { type: "array" }, taskId: { type: "string" } },
        },
        metadata: { type: "object" },
        id: { type: "string" },
        taskId: { type: "string" },
        relay: {
          type: "object",
          required: ["peer", "task_id", "request"],
          properties: {
            peer: { type: "string" },
            task_id: { type: "string" },
            request: { type: "object" },
          },
        },
      },
    },
  },
  allOf: Object.entries(REQUIRED_PARAMS).map(([method, required]) => ({
    if: { required: ["method"], properties: { method: { const: method } } },
    then: { required: ["params"], properties: { params: { type: "object", required } } },
  })),
};

function dispatch(deps: GatewayDeps, { method, params }: A2aBody, caller: string): TaskView {
  switch (method) {
    case "message/send":
      return params.message.taskId
        ? deps.tasks.resume(params.message.taskId, params.message, caller)
        : deps.tasks.submit({ message: params.message, metadata: params.metadata, originOrcaNode: caller });
    case "tasks/get": {
      const view = deps.tasks.get(params.id);
      if (!view) throw new PodError("task_not_found", `unknown task ${params.id}`);
      return view;
    }
    case "tasks/escalate":
      // Local control used by the CLI: the agent parks its own task because a
      // child task needs an approval that only this task's origin can give.
      return deps.tasks.escalate(params.taskId, params.relay, caller);
    case "tasks/cancel": {
      const origin = deps.tasks.originOf(params.id);
      if (origin === null) throw new PodError("task_not_found", `unknown task ${params.id}`);
      // Only the origin (or this orca node itself, e.g. local control paths) may cancel.
      if (caller !== origin && caller !== deps.orcaNode.orca_node_id) {
        throw new PodError("not_task_origin", "only the task origin may cancel it");
      }
      return deps.tasks.cancel(params.id);
    }
    default:
      throw new PodError("unsupported", `unsupported method ${method}`);
  }
}

export function a2aRoutes(app: FastifyInstance, deps: GatewayDeps): void {
  app.post<{ Body: A2aBody }>(
    "/a2a",
    { config: { access: "member", rpc: true }, schema: { body: bodySchema } },
    async (request) => ({
      jsonrpc: "2.0",
      id: request.body.id ?? null,
      result: dispatch(deps, request.body, request.auth.orcaNodeId),
    }),
  );
}
