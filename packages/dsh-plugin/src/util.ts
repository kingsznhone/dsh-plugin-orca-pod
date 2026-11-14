/** Shared error helpers for the Orca pod DSH bundle. */

/** Read a printable message from an arbitrary thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Read the Orca error code (`TaskError.code`, JSON-RPC error code) when present. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * Wrap an error with the operation that failed while keeping the Orca error
 * code available to callers and logs.
 */
export function describeError(operation: string, error: unknown): Error {
  const code = errorCode(error)
  const prefix = code === undefined ? operation : `${operation} [${code}]`
  const wrapped = new Error(`${prefix}: ${errorMessage(error)}`)
  if (code !== undefined) {
    const withCode = wrapped as Error & { code?: string }
    withCode.code = code
  }
  return wrapped
}
