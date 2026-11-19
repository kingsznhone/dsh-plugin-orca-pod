/** Port an orca node listens on, and the port a bare peer host defaults to (§4). */
export const DEFAULT_PORT = 11811;

/** Deadline of one outbound call to a peer unless `request_timeout_ms` says otherwise (§4.7). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Hard cap on one task's lifetime unless `task_timeout_s` says otherwise; peers see it as `max_task_ttl_s` (§6.9). */
export const DEFAULT_TASK_TIMEOUT_S = 3600;

/** Inline result summary cap unless `result_max_bytes` says otherwise; longer summaries are truncated (§6.11). */
export const DEFAULT_RESULT_MAX_BYTES = 32 * 1024;

/**
 * The executors a node can run tasks with. `acp` drives a real DSH session over
 * ACP; `echo` is the scripted machine for tests. It lives here, in a module
 * that imports nothing, so the panel bundle can offer the choice without
 * pulling in the executor implementation and zod.
 */
export const EXECUTOR_KINDS = ["acp", "echo"] as const;

export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
