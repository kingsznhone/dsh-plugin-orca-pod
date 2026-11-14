/**
 * LocalExecutor: the target-node side of task execution (§6.1). Phase 0 only
 * needs the deterministic Echo stand-in; the full echo script machine (steps,
 * suspends, artifacts) lands later.
 */
export type ExecuteInput = {
  taskId: string;
  contextId?: string;
  runRoot: string;
  metadata?: Record<string, unknown>;
};

export type ExecuteResult = {
  state: "completed" | "failed";
  text: string;
  artifacts?: Array<{ name: string; content: string }>;
};

export interface LocalExecutor {
  execute(input: ExecuteInput, signal?: AbortSignal): Promise<ExecuteResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads `metadata.echo.final.text` when the script declares it; anything else
 * (missing script, non-object echo, non-string text) falls back to "echo".
 */
function declaredEchoText(metadata: Record<string, unknown> | undefined): string | null {
  const echo = metadata?.["echo"];
  if (!isRecord(echo)) return null;
  const final = echo["final"];
  if (!isRecord(final)) return null;
  const text = final["text"];
  return typeof text === "string" ? text : null;
}

/** Deterministic executor used for connectivity and protocol probes (§6.3). */
export class EchoExecutor implements LocalExecutor {
  async execute(input: ExecuteInput, signal?: AbortSignal): Promise<ExecuteResult> {
    if (signal?.aborted) throw new Error("aborted");
    return { state: "completed", text: declaredEchoText(input.metadata) ?? "echo" };
  }
}
