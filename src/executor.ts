/**
 * LocalExecutor (§6.1) plus the Phase-0 EchoExecutor script machine (§6.3).
 * The echo script describes timing, suspensions, and result so the network,
 * state machine, approval loop, and blob path can be exercised without an agent.
 */

import type { PermissionRequest } from "./protocol.ts";

/**
 * A child task one hop down is waiting for permission. The echo script carries
 * the child's request snapshot so the task runner can turn it into this orca
 * node's own `permission_request` without a network call (§7.12 relay prototype).
 */
export type EchoRelay = {
  /** Child task's orca node endpoint. */
  peer: string;
  /** Child task id that is waiting. */
  task_id: string;
  /** The child's permission request, as observed by the agent. */
  request: PermissionRequest;
};

export type EchoSuspend =
  | { kind: "blocked"; reason: string; question: string; options?: string[] }
  | { kind: "permission"; tool: string; requested: Record<string, unknown>; relay?: EchoRelay };

export type EchoStep = { at_ms: number; suspend: EchoSuspend };

export type EchoFinal = { state: "completed" | "failed" | "hang"; text: string };

export type EchoArtifact = { name: string; content: string };

export type EchoScript = {
  steps: EchoStep[];
  final: EchoFinal;
  artifacts: EchoArtifact[];
};

export type ExecutorEvent =
  | { type: "suspend"; suspend: EchoSuspend }
  | { type: "artifact"; name: string; content: string }
  | { type: "completed"; text: string }
  | { type: "failed"; text: string };

export type ExecuteInput = {
  taskId: string;
  contextId?: string;
  /** Text of the task message (or the resume message). */
  prompt?: string;
  /** Origin orca node; part of the session binding key (§6.10). */
  originOrcaNode?: string;
  /** Group workspace `work/` dir; the executor's cwd when present (§6.7). */
  workspaceDir?: string;
  /** Group workspace `.pod/` dir; executors keep their own state here. */
  podDir?: string;
  metadata?: Record<string, unknown>;
};

export interface LocalExecutor {
  run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, unknown>;
}

export const ECHO_LIMITS = {
  max_steps: 8,
  max_total_ms: 60_000,
  max_text_bytes: 8 * 1024,
  max_artifacts: 4,
  max_artifact_bytes: 4 * 1024,
} as const;

export class EchoScriptError extends Error {
  readonly code: string = "bad_echo_script";
  constructor(message: string) {
    super(message);
    this.name = "EchoScriptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new EchoScriptError(`${where}: unknown field "${key}"`);
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function validateRelay(raw: unknown, where: string): EchoRelay | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new EchoScriptError(`${where}: relay must be an object`);
  ensureKeys(raw, ["peer", "task_id", "request"], where);
  const peer = raw["peer"];
  const taskId = raw["task_id"];
  const request = raw["request"];
  if (typeof peer !== "string" || peer.length === 0) {
    throw new EchoScriptError(`${where}.peer must be a non-empty string`);
  }
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new EchoScriptError(`${where}.task_id must be a non-empty string`);
  }
  if (!isRecord(request)) throw new EchoScriptError(`${where}.request must be an object`);
  ensureKeys(
    request,
    ["request_id", "task_id", "tool", "requested", "requested_by", "via", "expires_at"],
    `${where}.request`,
  );
  const requestId = request["request_id"];
  const childTaskId = request["task_id"];
  const tool = request["tool"];
  const requested = request["requested"];
  const requestedBy = request["requested_by"];
  const via = request["via"];
  const expiresAt = request["expires_at"];
  if (
    typeof requestId !== "string" ||
    typeof childTaskId !== "string" ||
    typeof tool !== "string" ||
    typeof requestedBy !== "string" ||
    typeof expiresAt !== "string"
  ) {
    throw new EchoScriptError(
      `${where}.request needs string request_id, task_id, tool, requested_by and expires_at`,
    );
  }
  if (!isRecord(requested)) throw new EchoScriptError(`${where}.request.requested must be an object`);
  if (!Array.isArray(via) || via.some((hop) => typeof hop !== "string")) {
    throw new EchoScriptError(`${where}.request.via must be a string array`);
  }
  return {
    peer,
    task_id: taskId,
    request: {
      request_id: requestId,
      task_id: childTaskId,
      tool,
      requested,
      requested_by: requestedBy,
      via: via as string[],
      expires_at: expiresAt,
    },
  };
}

function validateSuspend(raw: unknown, where: string): EchoSuspend {
  if (!isRecord(raw)) throw new EchoScriptError(`${where}: suspend must be an object`);
  const kind = raw["kind"];
  if (kind === "blocked") {
    ensureKeys(raw, ["kind", "reason", "question", "options"], where);
    const reason = raw["reason"];
    const question = raw["question"];
    if (typeof reason !== "string" || typeof question !== "string") {
      throw new EchoScriptError(`${where}: blocked needs reason and question strings`);
    }
    const options = raw["options"];
    if (options !== undefined) {
      if (!Array.isArray(options) || options.some((option) => typeof option !== "string")) {
        throw new EchoScriptError(`${where}: options must be a string array`);
      }
    }
    return { kind: "blocked", reason, question, ...(options ? { options: options as string[] } : {}) };
  }
  if (kind === "permission") {
    ensureKeys(raw, ["kind", "tool", "requested", "relay"], where);
    const tool = raw["tool"];
    const requested = raw["requested"];
    if (typeof tool !== "string" || !isRecord(requested)) {
      throw new EchoScriptError(`${where}: permission needs tool and requested object`);
    }
    const relay = validateRelay(raw["relay"], `${where}.relay`);
    return { kind: "permission", tool, requested, ...(relay ? { relay } : {}) };
  }
  throw new EchoScriptError(`${where}: suspend.kind must be "blocked" or "permission"`);
}

/**
 * Validate an echo script and return it in normalized form. Anything unknown,
 * out of order, or over a limit fails here — before a task is created (§6.3).
 */
export function validateEchoScript(raw: unknown): EchoScript {
  if (raw === undefined || raw === null) {
    return { steps: [], final: { state: "completed", text: "echo" }, artifacts: [] };
  }
  if (!isRecord(raw)) throw new EchoScriptError("echo must be an object");
  ensureKeys(raw, ["steps", "final", "artifacts"], "echo");

  const rawSteps = raw["steps"] ?? [];
  if (!Array.isArray(rawSteps)) throw new EchoScriptError("echo.steps must be an array");
  if (rawSteps.length > ECHO_LIMITS.max_steps) {
    throw new EchoScriptError(`echo.steps must be <= ${ECHO_LIMITS.max_steps}`);
  }
  const steps: EchoStep[] = [];
  let previous = -1;
  for (const [index, rawStep] of rawSteps.entries()) {
    if (!isRecord(rawStep)) throw new EchoScriptError(`echo.steps[${index}] must be an object`);
    ensureKeys(rawStep, ["at_ms", "suspend"], `echo.steps[${index}]`);
    const atMs = rawStep["at_ms"];
    if (typeof atMs !== "number" || !Number.isInteger(atMs) || atMs < 0) {
      throw new EchoScriptError(`echo.steps[${index}].at_ms must be a non-negative integer`);
    }
    if (atMs <= previous) throw new EchoScriptError("echo.steps.at_ms must strictly increase");
    if (atMs > ECHO_LIMITS.max_total_ms) {
      throw new EchoScriptError(`echo.steps.at_ms must be <= ${ECHO_LIMITS.max_total_ms}`);
    }
    previous = atMs;
    steps.push({ at_ms: atMs, suspend: validateSuspend(rawStep["suspend"], `echo.steps[${index}].suspend`) });
  }

  const rawFinal = raw["final"] ?? { state: "completed", text: "echo" };
  if (!isRecord(rawFinal)) throw new EchoScriptError("echo.final must be an object");
  ensureKeys(rawFinal, ["state", "text"], "echo.final");
  const state = rawFinal["state"];
  if (state !== "completed" && state !== "failed" && state !== "hang") {
    throw new EchoScriptError('echo.final.state must be "completed", "failed" or "hang"');
  }
  const text = rawFinal["text"] ?? "";
  if (typeof text !== "string") throw new EchoScriptError("echo.final.text must be a string");
  if (byteLength(text) > ECHO_LIMITS.max_text_bytes) {
    throw new EchoScriptError(`echo.final.text must be <= ${ECHO_LIMITS.max_text_bytes} bytes`);
  }

  const rawArtifacts = raw["artifacts"] ?? [];
  if (!Array.isArray(rawArtifacts)) throw new EchoScriptError("echo.artifacts must be an array");
  if (rawArtifacts.length > ECHO_LIMITS.max_artifacts) {
    throw new EchoScriptError(`echo.artifacts must be <= ${ECHO_LIMITS.max_artifacts}`);
  }
  const artifacts: EchoArtifact[] = [];
  for (const [index, rawArtifact] of rawArtifacts.entries()) {
    if (!isRecord(rawArtifact)) throw new EchoScriptError(`echo.artifacts[${index}] must be an object`);
    ensureKeys(rawArtifact, ["name", "content"], `echo.artifacts[${index}]`);
    const name = rawArtifact["name"];
    const content = rawArtifact["content"];
    if (typeof name !== "string" || name.length === 0 || /[\\/]/.test(name)) {
      throw new EchoScriptError(`echo.artifacts[${index}].name must be a plain file name`);
    }
    if (typeof content !== "string") throw new EchoScriptError(`echo.artifacts[${index}].content must be a string`);
    if (byteLength(content) > ECHO_LIMITS.max_artifact_bytes) {
      throw new EchoScriptError(`echo.artifacts[${index}].content must be <= ${ECHO_LIMITS.max_artifact_bytes} bytes`);
    }
    artifacts.push({ name, content });
  }

  return { steps, final: { state, text }, artifacts };
}

export function echoScriptFrom(metadata: Record<string, unknown> | undefined): EchoScript {
  return validateEchoScript(metadata?.["echo"]);
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    if (signal.aborted) {
      clearTimeout(timer);
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Deterministic executor used for connectivity, protocol, and approval probes (§6.3). */
export class EchoExecutor implements LocalExecutor {
  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, unknown> {
    const script = echoScriptFrom(input.metadata);
    let lastAt = 0;
    for (const step of script.steps) {
      await sleep(step.at_ms - lastAt, signal);
      lastAt = step.at_ms;
      // Suspension time is not counted: the next delay is measured from at_ms.
      yield { type: "suspend", suspend: step.suspend };
    }
    for (const artifact of script.artifacts) {
      yield { type: "artifact", name: artifact.name, content: artifact.content };
    }
    if (script.final.state === "completed") {
      yield { type: "completed", text: script.final.text };
      return;
    }
    if (script.final.state === "failed") {
      yield { type: "failed", text: script.final.text };
      return;
    }
    // hang: only tasks/cancel or TTL can end it (§6.3).
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(abortError());
      else signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }
}
