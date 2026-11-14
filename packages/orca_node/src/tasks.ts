import { echoScriptFrom, type ExecutorEvent, type LocalExecutor } from "@orca/executor";
import {
  isTerminal,
  newTaskId,
  TaskError,
  type A2AMessage,
  type SubmitTaskInput,
  type TaskRunner,
  type TaskState,
  type TaskView,
} from "@orca/protocol";
import type { BlobStore } from "@orca/storage";

type Running = {
  view: TaskView;
  metadata: Record<string, unknown> | undefined;
  abort: AbortController;
  iterator: AsyncGenerator<ExecutorEvent, void, unknown> | null;
  ttl: ReturnType<typeof setTimeout> | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cloneView(view: TaskView): TaskView {
  return JSON.parse(JSON.stringify(view)) as TaskView;
}

function textMessage(text: string): A2AMessage {
  return { role: "agent", parts: [{ kind: "text", text }] };
}

function suspendMessage(suspend: ExecutorEvent & { type: "suspend" }): A2AMessage {
  const data =
    suspend.suspend.kind === "blocked"
      ? {
          blocked: {
            reason: suspend.suspend.reason,
            question: suspend.suspend.question,
            ...(suspend.suspend.options ? { options: suspend.suspend.options } : {}),
          },
        }
      : {
          permission_request: {
            tool: suspend.suspend.tool,
            requested: suspend.suspend.requested,
          },
        };
  return { role: "agent", parts: [{ kind: "data", data }] };
}

export type TaskRunnerDeps = {
  executor: LocalExecutor;
  blobs: BlobStore;
  defaultTtlS?: number;
};

/**
 * Owns task records and drives executor events into the A2A state machine
 * (§4.8). One node runs one task at a time (§6.9): busy => node_busy.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tasks = new Map<string, Running>();
  const defaultTtlS = deps.defaultTtlS ?? 3600;
  let activeTaskId: string | null = null;

  function releaseSlot(rec: Running): void {
    if (activeTaskId === rec.view.id) activeTaskId = null;
  }

  function clearTtl(rec: Running): void {
    if (rec.ttl) {
      clearTimeout(rec.ttl);
      rec.ttl = null;
    }
  }

  function finish(rec: Running, state: TaskState, message?: A2AMessage, reason?: string): void {
    rec.view.status = { state, timestamp: nowIso(), ...(message ? { message } : {}), ...(reason ? { reason } : {}) };
    clearTtl(rec);
    releaseSlot(rec);
  }

  async function pump(rec: Running, resume?: A2AMessage): Promise<void> {
    const iterator = rec.iterator ?? deps.executor.run(
      { taskId: rec.view.id, contextId: rec.view.contextId, metadata: rec.metadata },
      rec.abort.signal,
    );
    rec.iterator = iterator;
    rec.view.status = { state: "working", timestamp: nowIso() };
    try {
      let step = resume === undefined ? await iterator.next() : await iterator.next(resume);
      while (!step.done) {
        const event = step.value;
        if (event.type === "suspend") {
          rec.view.status = { state: "input-required", timestamp: nowIso(), message: suspendMessage(event) };
          releaseSlot(rec);
          return;
        }
        if (event.type === "artifact") {
          const blob = deps.blobs.put(Buffer.from(event.content, "utf8"), { name: event.name });
          rec.view.artifacts = [
            ...(rec.view.artifacts ?? []),
            { artifactId: blob.blob_id, name: event.name, mediaType: "text/plain", bytes: blob.size },
          ];
        } else if (event.type === "completed") {
          finish(rec, "completed", textMessage(event.text));
          return;
        } else if (event.type === "failed") {
          finish(rec, "failed", textMessage(event.text));
          return;
        }
        step = await iterator.next();
      }
      finish(rec, "failed", textMessage("executor exited without a terminal event"), "executor_exited");
    } catch (error) {
      if (rec.abort.signal.aborted) {
        finish(rec, "canceled", undefined, rec.view.status.reason ?? "canceled");
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      finish(rec, "failed", textMessage(reason), "executor_error");
    }
  }

  function submit(input: SubmitTaskInput): TaskView {
    if (activeTaskId !== null) throw new TaskError("node_busy", "node is busy with another task");
    try {
      echoScriptFrom(input.metadata); // validate before a task exists (§6.3)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError("bad_echo_script", message);
    }
    const id = newTaskId();
    const contextId = input.message.contextId ?? id;
    const rec: Running = {
      view: {
        kind: "task",
        id,
        contextId,
        status: { state: "submitted", timestamp: nowIso() },
        metadata: input.metadata ?? {},
      },
      metadata: input.metadata,
      abort: new AbortController(),
      iterator: null,
      ttl: null,
    };
    activeTaskId = id;
    tasks.set(id, rec);
    const ttlS = Number(input.metadata?.["pod"] && (input.metadata["pod"] as { task_ttl_s?: number }).task_ttl_s) || defaultTtlS;
    rec.ttl = setTimeout(() => {
      if (!isTerminal(rec.view.status.state)) {
        rec.abort.abort();
        finish(rec, "failed", textMessage("task ttl exceeded"), "timeout");
      }
    }, ttlS * 1000);
    rec.ttl.unref?.();
    void pump(rec);
    return cloneView(rec.view);
  }

  function get(taskId: string): TaskView | null {
    const rec = tasks.get(taskId);
    return rec ? cloneView(rec.view) : null;
  }

  function resume(taskId: string, message: A2AMessage): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) throw new TaskError("task_not_found", `unknown task ${taskId}`);
    if (rec.view.status.state !== "input-required") {
      throw new TaskError("bad_request", "task is not input-required");
    }
    if (activeTaskId !== null && activeTaskId !== taskId) {
      throw new TaskError("node_busy", "node is busy with another task");
    }
    activeTaskId = taskId;
    void pump(rec, message);
    return cloneView(rec.view);
  }

  function cancel(taskId: string): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) throw new TaskError("task_not_found", `unknown task ${taskId}`);
    if (isTerminal(rec.view.status.state)) return cloneView(rec.view);
    rec.abort.abort();
    finish(rec, "canceled", undefined, "canceled");
    return cloneView(rec.view);
  }

  return { submit, get, resume, cancel };
}
