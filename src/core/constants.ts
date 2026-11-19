/** Port an orca node listens on, and the port a bare peer host defaults to (§4). */
export const DEFAULT_PORT = 11811;

/**
 * The executors a node can run tasks with. `acp` drives a real DSH session over
 * ACP; `echo` is the scripted machine for tests. It lives here, in a module
 * that imports nothing, so the panel bundle can offer the choice without
 * pulling in the executor implementation and zod.
 */
export const EXECUTOR_KINDS = ["acp", "echo"] as const;
