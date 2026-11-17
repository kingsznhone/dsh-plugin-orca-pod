/**
 * The echo executor (§6.3) and its script validator. The script describes
 * timing, suspensions and result, so the network, state machine, approval loop
 * and blob path can be exercised without an agent.
 */

import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import { PodError } from "../kernel/errors.ts";
import { parseSchema } from "../kernel/schema.ts";
import { RequestedAccessSchema } from "../protocol/grant.ts";
import { describeModelRequest } from "../protocol/model.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "./executor.ts";
import { abortError } from "../kernel/errors.ts";

const ECHO_LIMITS = {
  max_steps: 8,
  max_total_ms: 60_000,
  max_text_bytes: 8 * 1024,
  max_artifacts: 4,
  max_artifact_bytes: 4 * 1024,
} as const;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** A string that is at most `max` bytes in UTF-8. */
const boundedText = (max: number) => z.string().refine((text) => byteLength(text) <= max, `must be <= ${max} bytes`);

const EchoSuspendSchema = z.strictObject({
  kind: z.literal("permission", 'must be "permission"'),
  tool: z.string(),
  requested: RequestedAccessSchema,
});

const EchoStepSchema = z.strictObject({
  at_ms: z
    .number("must be a non-negative integer")
    .int("must be a non-negative integer")
    .min(0, "must be a non-negative integer")
    .max(ECHO_LIMITS.max_total_ms, `must be <= ${ECHO_LIMITS.max_total_ms}`),
  suspend: EchoSuspendSchema,
});

const EchoFinalSchema = z.strictObject({
  state: z.enum(["completed", "failed", "hang"], 'must be "completed", "failed" or "hang"'),
  text: boundedText(ECHO_LIMITS.max_text_bytes).default(""),
});

const EchoArtifactSchema = z.strictObject({
  name: z
    .string()
    .min(1, "must be a plain file name")
    .regex(/^[^\\/]+$/, "must be a plain file name"),
  content: boundedText(ECHO_LIMITS.max_artifact_bytes),
});

/**
 * An echo script: when to suspend for a permission, how the task ends, which
 * artifacts it leaves. It rides in `metadata.echo`, so it is a wire shape:
 * anything unknown, out of order or over a limit is refused (§6.3).
 */
export const EchoScriptSchema = z.strictObject({
  steps: z
    .array(EchoStepSchema)
    .max(ECHO_LIMITS.max_steps, `must be <= ${ECHO_LIMITS.max_steps}`)
    .refine(
      (steps) => steps.every((step, index) => index === 0 || step.at_ms > (steps[index - 1]?.at_ms ?? -1)),
      "at_ms must strictly increase",
    )
    .default([]),
  final: EchoFinalSchema.default({ state: "completed", text: "echo" }),
  artifacts: z
    .array(EchoArtifactSchema)
    .max(ECHO_LIMITS.max_artifacts, `must be <= ${ECHO_LIMITS.max_artifacts}`)
    .default([]),
});
export type EchoScript = z.output<typeof EchoScriptSchema>;

/**
 * Validate an echo script and return it in normalized form. Anything unknown,
 * out of order, or over a limit fails here — before a task is created (§6.3).
 */
export function parseEchoScript(raw: unknown): EchoScript {
  const parsed = parseSchema(EchoScriptSchema, raw ?? {});
  if (parsed.ok) return parsed.value;
  throw new PodError("bad_echo_script", `${["echo", ...parsed.issue.path].join(".")} ${parsed.issue.message}`);
}

/** Deterministic executor used for connectivity, protocol, and approval probes (§6.3). */
export class EchoExecutor implements LocalExecutor {
  async *run(input: ExecuteInput, signal: AbortSignal): AsyncGenerator<ExecutorEvent, void, void> {
    if (input.model !== undefined || input.reasoningEffort !== undefined) {
      yield {
        type: "failed",
        text: `the echo executor cannot select ${describeModelRequest(input.model, input.reasoningEffort)}; only the ACP executor supports per-task models`,
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
