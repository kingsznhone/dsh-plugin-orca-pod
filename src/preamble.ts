/**
 * Orchestration preamble for real executors (§6.14, §6.15).
 *
 * A headless or ACP agent runs in its own profile, so it cannot see the plugin's
 * tools. The local `orca-node` CLI is the bridge: the preamble tells the agent
 * which task it is, where the CLI lives, and how to delegate, wait, escalate,
 * and publish produced files back to its origin.
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
  const cli = `node "${options.cliPath}"`;
  const rootFlag = options.dataRoot === undefined ? "" : ` --data-root "${options.dataRoot}"`;
  return [
    `[orca-pod] You are executing task ${options.taskId}${who}.`,
    `To delegate to another orca node, use the CLI instead of raw HTTP:`,
    `  ${cli} send${rootFlag} --peer <host:port> --text - --json`,
    `Check it with: ${cli} wait${rootFlag} --peer <host:port> --task <id> --local-task ${options.taskId} --json`,
    `  (exit 0 completed, 1 failed/canceled, 2 still running, 3 needs permission)`,
    `With --local-task, wait pushes a child permission request up to this task's origin`,
    `automatically; if you need to retry it by hand: ${cli} escalate${rootFlag} --peer <child:port> --task <child task id> --local-task ${options.taskId} --json`,
    `To share a file with the origin, attach a blob URL to your summary:`,
    `  ${cli} publish${rootFlag} <path> --json`,
    `Never approve your own permission requests; escalate them instead.`,
  ].join("\n");
}

export function withPreamble(text: string, preamble: string | null): string {
  return preamble === null ? text : `${preamble}\n\n${text}`;
}
