/**
 * The echo executor (§6.3) and its script validator. The script describes
 * timing, suspensions and result, so the network, state machine, approval loop
 * and blob path can be exercised without an agent.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { PodError, abortError } from "../core/errors.ts";
import { parseOrThrow } from "../core/schema.ts";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { describeModelRequest } from "../core/wire/model.ts";
import {
  EchoScriptSchema,
  type EchoScript,
  type ExecuteInput,
  type ExecutorEvent,
  type LocalExecutor,
} from "./executor.ts";

/**
 * Validate an echo script and return it in normalized form. Anything unknown,
 * out of order, or over a limit fails here — before a task is created (§6.3).
 */
export function parseEchoScript(raw: unknown): EchoScript {
  return parseOrThrow(EchoScriptSchema, raw ?? {}, (issue) => {
    return new PodError("bad_echo_script", `${["echo", ...issue.path].join(".")} ${issue.message}`);
  });
}

/** Deterministic executor used for connectivity, protocol, and approval probes (§6.3). */
export class EchoExecutor implements LocalExecutor {
  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined> {
    if (input.model !== undefined || input.reasoningEffort !== undefined) {
      yield {
        type: "failed",
        text: `the echo executor cannot select ${describeModelRequest(input.model, input.reasoningEffort)}; only the ACP executor supports per-task models`,
        reason: "model_unsupported",
      };
      return;
    }
    const { steps, final } = input.echo;
    let lastAt = 0;
    for (const step of steps) {
      await sleep(step.at_ms - lastAt, undefined, { signal });
      lastAt = step.at_ms;
      // Suspension time is not counted: the next delay is measured from at_ms.
      const { mode, ...suspend } = step.suspend;
      yield { type: "suspend", suspend: { ...suspend, requestedMode: mode } };
    }
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
