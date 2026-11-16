import type { FastifyError, FastifyInstance } from "fastify";

import { PodError, POD_ERROR_STATUS } from "../errors.ts";
import type { GatewayDeps } from "./index.ts";

const BUSY_RETRY_AFTER_S = 30;

/** Anything that is not already a PodError is either the caller's malformed input or a bug. */
function toPodError(error: unknown): PodError {
  if (error instanceof PodError) return error;
  const { code, validation, message } = error as FastifyError;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return new PodError("body_too_large", "request body exceeds the size limit");
  }
  if (validation !== undefined) return new PodError("bad_request", message);
  if (error instanceof SyntaxError) return new PodError("bad_request", "invalid JSON body");
  return new PodError("internal", "internal server error");
}

/**
 * The one place an error becomes an HTTP response: `{ code, message }` with the
 * status from `POD_ERROR_STATUS`. Routes marked `rpc` wrap the same body in a
 * JSON-RPC error envelope; a busy node also reports its holder and when to retry.
 */
export function installErrorHandler(app: FastifyInstance, deps: GatewayDeps): void {
  app.setErrorHandler((error, request, reply) => {
    const pod = toPodError(error);
    const busy = pod.code === "orca_node_busy";
    const body = {
      code: pod.code,
      message: pod.message,
      ...(busy ? { retry_after_s: BUSY_RETRY_AFTER_S, holder: deps.tasks.busy() } : {}),
    };
    if (busy) reply.header("retry-after", String(BUSY_RETRY_AFTER_S));
    const rpcId = (request.body as { id?: unknown } | null | undefined)?.id ?? null;
    return reply
      .code(POD_ERROR_STATUS[pod.code])
      .send(
        request.routeOptions.config.rpc
          ? { jsonrpc: "2.0", id: rpcId, error: { code: -32000, message: pod.code, data: body } }
          : body,
      );
  });
}
