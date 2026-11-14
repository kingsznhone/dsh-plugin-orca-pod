import { echoScriptFrom, type ExecutorEvent, type LocalExecutor } from "./executor.ts";
import {
  isTerminal,
  newTaskId,
  TaskError,
  type A2AMessage,
  type BusyState,
  type SubmitTaskInput,
  type TaskRunner,
  type TaskState,
  type TaskView,
} from "./protocol.ts";
import { createMemoryTaskStore, type BlobStore, type TaskStore } from "./storage.ts";
import type { Workspace } from "./workspace.ts";

type Running = {
  view: TaskView;
  metadata: Record<string, unknown> | undefined;
  origin_orca_node: string;
  prompt: string;
  created_at: string;
  since: string;
  abort: AbortController;
  iterator: AsyncGenerator<ExecutorEvent, void, unknown> | null;
  ttl: ReturnType<typeof setTimeout> | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function messageText(message: A2AMessage): string {
  return message.parts
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
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
  /** Durable store (§5.5). Defaults to memory so protocol tests stay isolated. */
  store?: TaskStore;
  /** Group workspace; becomes the executor cwd when present (§6.7). */
  workspace?: Workspace;
  defaultTtlS?: number;
};

/**
 * Owns task records and drives executor events into the A2A state machine
 * (§4.8). One orca node runs one task at a time (§6.9): busy => orca_node_busy.
 */
export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const tasks = new Map<string, Running>();
  const store = deps.store ?? createMemoryTaskStore();
  const defaultTtlS = deps.defaultTtlS ?? 3600;
  let activeTaskId: string | null = null;

  function persist(rec: Running): void {
    store.save({
      view: cloneView(rec.view),
      origin_orca_node: rec.origin_orca_node,
      created_at: rec.created_at,
      updated_at: nowIso(),
    });
  }

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
    persist(rec);
  }

  async function pump(rec: Running, resume?: A2AMessage): Promise<void> {
    const iterator =
      rec.iterator ??
      deps.executor.run(
        {
          taskId: rec.view.id,
          contextId: rec.view.contextId,
          prompt: rec.prompt,
          originOrcaNode: rec.origin_orca_node,
          ...(deps.workspace ? { workspaceDir: deps.workspace.work, podDir: deps.workspace.pod } : {}),
          metadata: rec.metadata,
        },
        rec.abort.signal,
      );
    rec.iterator = iterator;
    rec.view.status = { state: "working", timestamp: nowIso() };
    persist(rec);
    try {
      let step = resume === undefined ? await iterator.next() : await iterator.next(resume);
      while (!step.done) {
        const event = step.value;
        if (event.type === "suspend") {
          rec.view.status = { state: "input-required", timestamp: nowIso(), message: suspendMessage(event) };
          releaseSlot(rec);
          persist(rec);
          return;
        }
        if (event.type === "artifact") {
          const blob = deps.blobs.put(Buffer.from(event.content, "utf8"), { name: event.name });
          rec.view.artifacts = [
            ...(rec.view.artifacts ?? []),
            { artifactId: blob.blob_id, name: event.name, mediaType: "text/plain", bytes: blob.size },
          ];
          persist(rec);
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
    if (activeTaskId !== null) throw new TaskError("orca_node_busy", "orca node is busy with another task");
    try {
      echoScriptFrom(input.metadata); // validate before a task exists (§6.3)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TaskError("bad_echo_script", message);
    }
    const id = newTaskId();
    const contextId = input.message.contextId ?? id;
    const createdAt = nowIso();
    const rec: Running = {
      view: {
        kind: "task",
        id,
        contextId,
        status: { state: "submitted", timestamp: createdAt },
        metadata: input.metadata ?? {},
      },
      metadata: input.metadata,
      origin_orca_node: input.originOrcaNode ?? "unknown",
      prompt: messageText(input.message),
      created_at: createdAt,
      since: createdAt,
      abort: new AbortController(),
      iterator: null,
      ttl: null,
    };
    activeTaskId = id;
    tasks.set(id, rec);
    persist(rec);
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
    if (rec) return cloneView(rec.view);
    const stored = store.load(taskId);
    return stored ? cloneView(stored.view) : null;
  }

  function resume(taskId: string, message: A2AMessage): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) {
      if (!store.load(taskId)) throw new TaskError("task_not_found", `unknown task ${taskId}`);
      throw new TaskError("bad_request", "task is not input-required");
    }
    if (rec.view.status.state !== "input-required") {
      throw new TaskError("bad_request", "task is not input-required");
    }
    if (activeTaskId !== null && activeTaskId !== taskId) {
      throw new TaskError("orca_node_busy", "orca node is busy with another task");
    }
    activeTaskId = taskId;
    void pump(rec, message);
    return cloneView(rec.view);
  }

  function cancel(taskId: string): TaskView {
    const rec = tasks.get(taskId);
    if (!rec) {
      const stored = store.load(taskId);
      if (!stored) throw new TaskError("task_not_found", `unknown task ${taskId}`);
      return cloneView(stored.view);
    }
    if (isTerminal(rec.view.status.state)) return cloneView(rec.view);
    rec.abort.abort();
    finish(rec, "canceled", undefined, "canceled");
    return cloneView(rec.view);
  }

  function busy(): BusyState | null {
    if (activeTaskId === null) return null;
    const rec = tasks.get(activeTaskId);
    if (!rec) return null;
    return { task_id: rec.view.id, origin_orca_node: rec.origin_orca_node, since: rec.since };
  }

  /** §8.3: a restart never silently resumes work; every unfinished task fails. */
  function recover(): number {
    let count = 0;
    for (const stored of store.list()) {
      if (isTerminal(stored.view.status.state)) continue;
      const message = textMessage("task was interrupted by an orca node restart");
      store.save({
        view: {
          ...stored.view,
          status: { state: "failed", timestamp: nowIso(), message, reason: "node_restart" },
        },
        origin_orca_node: stored.origin_orca_node,
        created_at: stored.created_at,
        updated_at: nowIso(),
      });
      count += 1;
    }
    return count;
  }

  return { submit, get, resume, cancel, busy, recover };
}
