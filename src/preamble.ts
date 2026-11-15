/**
 * Orchestration preamble for real executors (§6.14, §6.15).
 *
 * An ACP or CLI agent runs in its own profile, so it cannot see the plugin's
 * tools. The local `orca-node` CLI is the bridge: the preamble tells the agent
 * which task it is, how to reach the CLI via `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT`,
 * and how to delegate, wait, escalate, and publish produced files back to its origin.
 */

export type PreambleOptions = {
  taskId: string;
  selfOrcaNodeId?: string;
  /** Absolute path of the `orca-node` CLI entry; omitted means no preamble. */
  cliPath?: string;
  dataRoot?: string;
};

export function orchestrationPreamble(options: PreambleOptions): string | null {
  if (!options.cliPath) return null;
  const who = options.selfOrcaNodeId ? ` as orca node ${options.selfOrcaNodeId}` : "";
  // Executors export ORCA_POD_CLI/ORCA_POD_DATA_ROOT into the child environment;
  // using them keeps the preamble identical across install layouts.
  const cli = `node "$ORCA_POD_CLI" --data-root "$ORCA_POD_DATA_ROOT"`;
  const fallback = options.dataRoot === undefined
    ? `node "${options.cliPath}"`
    : `node "${options.cliPath}" --data-root "${options.dataRoot}"`;
  return [
    `[orca-pod] You are executing task ${options.taskId}${who}.`,
    `Your cwd is the shared workgroup root; notes/ holds handoff notes across tasks from this workgroup.`,
    `Read notes/STATUS.md first if it exists, and keep your notes current before you finish.`,
    `To delegate to another orca node, use the CLI instead of raw HTTP:`,
    `  ${cli} send --peer <host:port> --text - --local-task ${options.taskId} --json`,
    `  add --model <provider/model> [--reasoning-effort <effort>] only when the target advertises it.`,
    `The executor exports ORCA_POD_CLI and ORCA_POD_DATA_ROOT; the literal fallback is: ${fallback}`,
    `With --local-task, this node watches the child and parks this task when the child asks`,
    `for a permission; the origin decides once and the grant flows back. You do not need to escalate yourself.`,
    `Check a child with: ${cli} wait --peer <host:port> --task <id> --local-task ${options.taskId} --json`,
    `  (exit 0 completed, 1 failed/canceled, 2 still running, 3 needs permission)`,
    `If you need to retry an escalation by hand: ${cli} escalate --peer <child:port> --task <child task id> --local-task ${options.taskId} --json`,
    `To share a file with the origin, attach a blob URL to your summary:`,
    `  ${cli} publish <path> --json`,
    `Never approve your own permission requests; escalate them instead.`,
  ].join("\n");
}

export function withPreamble(text: string, preamble: string | null): string {
  return preamble === null ? text : `${preamble}\n\n${text}`;
}
