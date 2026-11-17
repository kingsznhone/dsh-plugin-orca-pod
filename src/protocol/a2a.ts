/** The A2A JSON-RPC surface and the error body both transports answer with (§4.7). */

import { z } from "zod";

import { TaskRelaySchema } from "./grant.ts";
import { A2AMessageSchema, TaskMetadataSchema, TaskViewSchema } from "./task.ts";

const TaskIdParams = z.looseObject({ id: z.string() });

/**
 * Parameters per method. The caller builds them against `z.input` of these
 * schemas and the gateway parses with the same ones, so both sides name the
 * same shape. Every method answers with a task view.
 */
export const A2A_PARAMS = {
  "message/send": z.looseObject({ message: A2AMessageSchema, metadata: TaskMetadataSchema.optional() }),
  "tasks/get": TaskIdParams,
  "tasks/cancel": TaskIdParams,
  /** Local control used by the CLI: park a task whose child needs an approval only the origin can give (§7.12). */
  "tasks/escalate": z.looseObject({ taskId: z.string(), relay: TaskRelaySchema }),
};
export type A2AMethod = keyof typeof A2A_PARAMS;
export type A2AParams<M extends A2AMethod> = z.input<(typeof A2A_PARAMS)[M]>;

export function isA2AMethod(method: string): method is A2AMethod {
  return Object.hasOwn(A2A_PARAMS, method);
}

/** The JSON-RPC request envelope; `params` is checked per method. */
export const RpcRequestSchema = z.object({
  id: z.unknown().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** The success envelope of an A2A call. */
export const RpcResultSchema = z.object({ result: TaskViewSchema });

/** What a failed call answers: a code from `PodErrorCode` and a message, plus a busy node's hint. */
export type ErrorBody = {
  code: string;
  message: string;
  retry_after_s?: number;
  holder?: unknown;
};

/**
 * Read a peer's error leniently: a body we cannot make sense of keeps the
 * generic code. The gateway's `{code, message}` and the same inside a JSON-RPC
 * `error.data` both parse, and so does a 200 reply carrying an `error` envelope.
 */
export const ErrorReplySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({
      message: z.string().optional(),
      data: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
    })
    .optional(),
});
export type ErrorReply = z.infer<typeof ErrorReplySchema>;

/** A reply that carries only an acknowledgement (leave, child-link). */
export const AckSchema = z.object({ ok: z.literal(true) });
