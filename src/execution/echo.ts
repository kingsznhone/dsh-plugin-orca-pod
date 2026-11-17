/**
 * The echo executor (§6.3) and its script validator. The script describes
 * timing, suspensions and result, so the network, state machine, approval loop
 * and blob path can be exercised without an agent.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { PodError } from "../kernel/index.ts";
import { parseTaskRelay } from "../security/index.ts";
import { isRecord } from "../protocol/index.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor, Suspension } from "./executor.ts";
import { abortError } from "./process.ts";

type EchoStep = { at_ms: number; suspend: Suspension };

type EchoFinal = { state: "completed" | "failed" | "hang"; text: string };

type EchoArtifact = { name: string; content: string };

export type EchoScript = {
  steps: EchoStep[];
  final: EchoFinal;
  artifacts: EchoArtifact[];
};

const ECHO_LIMITS = {
  max_steps: 8,
  max_total_ms: 60_000,
  max_text_bytes: 8 * 1024,
  max_artifacts: 4,
  max_artifact_bytes: 4 * 1024,
} as const;

function need(ok: boolean, message: string): asserts ok {
  if (!ok) throw new PodError("bad_echo_script", message);
}

function ensureKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) need(allowed.includes(key), `${where}: unknown field "${key}"`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseSuspend(raw: unknown, where: string): Suspension {
  need(isRecord(raw), `${where}: suspend must be an object`);
  need(raw.kind === "permission", `${where}: suspend.kind must be "permission"`);
  ensureKeys(raw, ["kind", "tool", "requested", "relay"], where);
  const { tool, requested, relay } = raw;
  need(typeof tool === "string" && isRecord(requested), `${where}: permission needs tool and requested object`);
  return {
    kind: "permission",
    tool,
    requested,
    ...(relay === undefined ? {} : { relay: parseTaskRelay(relay, `${where}.relay`, "bad_echo_script") }),
  };
}

/**
 * Validate an echo script and return it in normalized form. Anything unknown,
 * out of order, or over a limit fails here — before a task is created (§6.3).
 */
export function parseEchoScript(raw: unknown): EchoScript {
  if (raw === undefined || raw === null) {
    return { steps: [], final: { state: "completed", text: "echo" }, artifacts: [] };
  }
  need(isRecord(raw), "echo must be an object");
  ensureKeys(raw, ["steps", "final", "artifacts"], "echo");

  const rawSteps = raw.steps ?? [];
  need(Array.isArray(rawSteps), "echo.steps must be an array");
  need(rawSteps.length <= ECHO_LIMITS.max_steps, `echo.steps must be <= ${ECHO_LIMITS.max_steps}`);
  let previous = -1;
  const steps = rawSteps.map((rawStep: unknown, index): EchoStep => {
    const at = `echo.steps[${index}]`;
    need(isRecord(rawStep), `${at} must be an object`);
    ensureKeys(rawStep, ["at_ms", "suspend"], at);
    const atMs = rawStep.at_ms;
    need(typeof atMs === "number" && Number.isInteger(atMs) && atMs >= 0, `${at}.at_ms must be a non-negative integer`);
    need(atMs > previous, "echo.steps.at_ms must strictly increase");
    need(atMs <= ECHO_LIMITS.max_total_ms, `echo.steps.at_ms must be <= ${ECHO_LIMITS.max_total_ms}`);
    previous = atMs;
    return { at_ms: atMs, suspend: parseSuspend(rawStep.suspend, `${at}.suspend`) };
  });

  const rawFinal = raw.final ?? { state: "completed", text: "echo" };
  need(isRecord(rawFinal), "echo.final must be an object");
  ensureKeys(rawFinal, ["state", "text"], "echo.final");
  const { state } = rawFinal;
  need(
    state === "completed" || state === "failed" || state === "hang",
    'echo.final.state must be "completed", "failed" or "hang"',
  );
  const text = rawFinal.text ?? "";
  need(typeof text === "string", "echo.final.text must be a string");
  need(
    byteLength(text) <= ECHO_LIMITS.max_text_bytes,
    `echo.final.text must be <= ${ECHO_LIMITS.max_text_bytes} bytes`,
  );

  const rawArtifacts = raw.artifacts ?? [];
  need(Array.isArray(rawArtifacts), "echo.artifacts must be an array");
  need(rawArtifacts.length <= ECHO_LIMITS.max_artifacts, `echo.artifacts must be <= ${ECHO_LIMITS.max_artifacts}`);
  const artifacts = rawArtifacts.map((rawArtifact: unknown, index): EchoArtifact => {
    const at = `echo.artifacts[${index}]`;
    need(isRecord(rawArtifact), `${at} must be an object`);
    ensureKeys(rawArtifact, ["name", "content"], at);
    const { name, content } = rawArtifact;
    need(typeof name === "string" && name.length > 0 && !/[\\/]/.test(name), `${at}.name must be a plain file name`);
    need(typeof content === "string", `${at}.content must be a string`);
    need(
      byteLength(content) <= ECHO_LIMITS.max_artifact_bytes,
      `${at}.content must be <= ${ECHO_LIMITS.max_artifact_bytes} bytes`,
    );
    return { name, content };
  });

  return { steps, final: { state, text }, artifacts };
}

/** Deterministic executor used for connectivity, protocol, and approval probes (§6.3). */
export class EchoExecutor implements LocalExecutor {
  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
    if (input.model !== undefined || input.reasoningEffort !== undefined) {
      const wanted = [
        input.model === undefined ? "" : `model ${input.model.provider}/${input.model.model}`,
        input.reasoningEffort === undefined ? "" : `reasoning effort "${input.reasoningEffort}"`,
      ];
      yield {
        type: "failed",
        text: `the echo executor cannot select ${wanted.filter(Boolean).join(" and ")}; only the ACP executor supports per-task models`,
        reason: "model_unsupported",
      };
      return;
    }
    const { steps, final, artifacts } = input.echo;
    let lastAt = 0;
    for (const step of steps) {
      await sleep(step.at_ms - lastAt, undefined, { signal });
      lastAt = step.at_ms;
      // Suspension time is not counted: the next delay is measured from at_ms.
      yield { type: "suspend", suspend: step.suspend };
    }
    for (const artifact of artifacts) yield { type: "artifact", name: artifact.name, content: artifact.content };
    if (final.state === "hang") {
      // Only tasks/cancel or TTL can end it (§6.3).
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(abortError());
        else signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return;
    }
    yield { type: final.state, text: final.text };
  }
}
