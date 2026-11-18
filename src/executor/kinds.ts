/**
 * The executors a node can run tasks with. This module imports nothing, so the
 * settings schema and the panel's choice list share it without the panel
 * bundle pulling in zod.
 *
 * `acp` drives a real DSH session over ACP; `echo` is the scripted machine for tests.
 */
export const EXECUTOR_KINDS = ["acp", "echo"] as const;

export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];
