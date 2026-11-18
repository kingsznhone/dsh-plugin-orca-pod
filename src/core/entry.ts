/**
 * Environment variable the task executor sets to "1" in every session it
 * spawns. An agent running a task must not start another one: tasks are
 * single-hop (§7.9), so the plugin's `send` refuses while it is set. This keeps
 * a well-behaved agent from cascading; it is not a security boundary, since the
 * agent runs as the same OS user as the node.
 */
export const IN_TASK_ENV = "ORCA_POD_IN_TASK";

/** True inside a session the task executor spawned (see `IN_TASK_ENV`). */
export function runningInTask(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[IN_TASK_ENV] === "1";
}
