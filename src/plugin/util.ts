/** Shared helpers for the Orca pod DSH bundle. */

import { errorMessage, PodError } from "../errors.ts";
import type { HostContext } from "./dsh.ts";

/** Read a host service that may be absent without declaring it in `inject`. */
export function service<T>(ctx: HostContext, name: string): T | undefined {
  return ctx.get(name) as T | undefined;
}

/**
 * Wrap an error with the operation that failed, keeping the pod error code (and
 * its status) when the failure came from a pod call.
 */
export function describeError(operation: string, error: unknown): Error {
  if (error instanceof PodError) {
    return new PodError(error.code, `${operation} [${error.code}]: ${error.message}`, error.status);
  }
  return new Error(`${operation}: ${errorMessage(error)}`);
}
