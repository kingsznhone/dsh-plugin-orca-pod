/** Shared helpers for the Orca pod DSH bundle. */

import { errorMessage, PodError } from "../kernel/index.ts";

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
