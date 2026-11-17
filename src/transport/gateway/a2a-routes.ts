import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PodError } from "../../kernel/index.ts";
import type { A2AMessage, SubmitTaskInput, TaskView } from "../../protocol/index.ts";
import type { GatewayDeps } from "./index.ts";
import { parseInput } from "./input.ts";

const AnyObject = z.record(z.string(), z.unknown());

/** The JSON-RPC envelope; `params` is checked per method below. */
const Envelope = z.object({ id: z.unknown().optional(), method: z.string(), params: z.unknown().optional() });

/**
 * Only the outline is checked here: loose objects keep the fields the gateway
 * does not look at. The task runner validates message parts and metadata, and
 * the relay request is checked when it is escalated.
 */
const Message = z.looseObject({ parts: z.array(z.unknown()), taskId: z.string().optional() });
const TaskId = z.looseObject({ id: z.string() });

const PARAMS = {
  "message/send": z.looseObject({ message: Message, metadata: AnyObject.optional() }),
  "tasks/get": TaskId,
  "tasks/cancel": TaskId,
  "tasks/escalate": z.looseObject({
    taskId: z.string(),
    relay: z.looseObject({ peer: z.string(), task_id: z.string(), request: AnyObject }),
  }),
};

type Method = keyof typeof PARAMS;

function isMethod(method: string): method is Method {
  return Object.hasOwn(PARAMS, method);
}

function dispatch(deps: GatewayDeps, method: string, raw: unknown, caller: string): TaskView {
  if (!isMethod(method)) throw new PodError("unsupported", `unsupported method ${method}`);
  switch (method) {
    case "message/send": {
      // The runner validates the parts and metadata.pod; the gateway only checked the outline.
      const params = parseInput(PARAMS[method], raw, "params");
      const message = params.message as A2AMessage;
      return message.taskId
        ? deps.tasks.resume(message.taskId, message, caller)
        : deps.tasks.submit({
            message,
            metadata: params.metadata as SubmitTaskInput["metadata"],
            originOrcaNode: caller,
          });
    }
    case "tasks/get": {
      const { id } = parseInput(PARAMS[method], raw, "params");
      const view = deps.tasks.get(id);
      if (!view) throw new PodError("task_not_found", `unknown task ${id}`);
      return view;
    }
    case "tasks/escalate": {
      // Local control used by the CLI: the agent parks its own task because a
      // child task needs an approval that only this task's origin can give.
      const { taskId, relay } = parseInput(PARAMS[method], raw, "params");
      return deps.tasks.escalate(taskId, relay, caller);
    }
    case "tasks/cancel": {
      const { id } = parseInput(PARAMS[method], raw, "params");
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
    const { id, method, params } = parseInput(Envelope, request.body, "body");
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      result: dispatch(deps, method, params, request.auth.orcaNodeId),
    };
  });
}
