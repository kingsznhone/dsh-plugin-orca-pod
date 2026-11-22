/**
 * A scripted executor for tests: the task text says
 * when to suspend for a permission and how the task ends, so the network, the
 * state machine, the approval loop and the file path run without an agent.
 * The script rides in the task's text, one `SCRIPT <json>` line, and reaches
 * the executor inside the prompt like any other task text.
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

import { abortError } from "../../src/core/errors.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "../../src/executor/executor.ts";
import type { A2AMessage, SubmitTaskInput, TaskMetadata } from "../../src/task/wire.ts";

export type Script = {
  /** Suspensions for a permission, each `at_ms` after the start (time spent suspended is not counted). */
  steps?: Array<{ at_ms: number; suspend: { tool: string; requested: Record<string, unknown>; mode?: SandboxMode } }>;
  /** How the task ends; `hang` waits for a cancel or the TTL. Default: completed with "echo". */
  final?: { state: "completed" | "failed" | "hang"; text?: string };
};

const MARK = "SCRIPT ";

/** The task text that carries `script`. */
export function scriptText(script: Script): string {
  return `${MARK}${JSON.stringify(script)}`;
}

/** A task message that carries `script`. */
export function scriptMessage(script: Script): A2AMessage {
  return { role: "user", parts: [{ kind: "text", text: scriptText(script) }] };
}

/** A task that runs `script`, with whatever metadata the test adds. */
export function scriptTask(script: Script, metadata?: TaskMetadata): SubmitTaskInput {
  return { message: scriptMessage(script), ...(metadata === undefined ? {} : { metadata }) };
}

export class ScriptExecutor implements LocalExecutor {
  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
    const line = input.prompt.split("\n").find((text) => text.startsWith(MARK));
    const script: Script = line === undefined ? {} : JSON.parse(line.slice(MARK.length));
    let lastAt = 0;
    for (const { at_ms, suspend } of script.steps ?? []) {
      await sleep(at_ms - lastAt, undefined, { signal });
      lastAt = at_ms;
      yield {
        type: "suspend",
        tool: suspend.tool,
        requested: suspend.requested,
        requestedMode: suspend.mode ?? "danger-full-access",
      };
    }
    const final = script.final ?? { state: "completed", text: "echo" };
    if (final.state === "hang") {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(abortError());
        else signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });
      return;
    }
    yield { type: final.state, text: final.text ?? "" };
  }
}
