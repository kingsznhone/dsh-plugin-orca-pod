import type { PodTaskMetadata } from "../protocol/index.ts";

/**
 * Metadata a child task inherits from the task whose agent created it (§5.1).
 * The gateway is the only place that increments the hop and appends the chain;
 * agents cannot write these fields themselves.
 */
export function childPodMetadata(
  parent: PodTaskMetadata | undefined,
  parentTaskId: string,
  selfOrcaNodeId: string,
): PodTaskMetadata {
  return {
    hop: (parent?.hop ?? 0) + 1,
    chain: [...(parent?.chain ?? []), selfOrcaNodeId],
    root: parent?.root ?? parentTaskId,
    ...(parent?.root_origin !== undefined ? { root_origin: parent.root_origin } : {}),
    ...(parent?.permission_mode !== undefined ? { permission_mode: parent.permission_mode } : {}),
  };
}
