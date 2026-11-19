/**
 * Environment variable the task executor sets to "1" in every session it
 * spawns. An agent running a task must not start another one: tasks are
 * single-hop (§7.9), so the plugin's `send` refuses while it is set. This keeps
 * a well-behaved agent from cascading; it is not a security boundary, since the
 * agent runs as the same OS user as the node.
 */
export const IN_TASK_ENV = "ORCA_POD_IN_TASK";

/**
 * Where a task session reaches this machine's node, and the token the node's
 * local routes take (§5.6). The executor sets both next to `IN_TASK_ENV`; the
 * plugin inside the task uses them for the `orca_pod` file methods.
 */
export const NODE_URL_ENV = "ORCA_POD_NODE_URL";
export const NODE_TOKEN_ENV = "ORCA_POD_NODE_TOKEN";
