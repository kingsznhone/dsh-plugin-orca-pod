import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";

import { EventBus } from "../src/core/events.ts";
import { DispatchLog } from "../src/task/dispatch-log.ts";
import { MemoryDispatchStore } from "../src/task/dispatch-store.ts";
import type { DispatchEvent, TaskView } from "../src/task/wire.ts";

function view(id: string, state: TaskView["status"]["state"], reason?: string): TaskView {
  return { kind: "task", id, contextId: `ctx-${id}`, status: { state, timestamp: "2026-01-01T00:00:00.000Z", reason } };
}

function log() {
  const store = new MemoryDispatchStore();
  const events = new EventBus<DispatchEvent>();
  const seen: DispatchEvent[] = [];
  events.subscribe((event) => seen.push(event));
  return { log: new DispatchLog(store, events), store, seen };
}

describe("DispatchLog", () => {
  it("records a send once and keeps its creation time on the next one", () => {
    const { log: dispatches, store, seen } = log();
    dispatches.recordSend("http://peer", view("t1", "submitted"));
    const first = store.get("t1");
    expect(first).toMatchObject({ task_id: "t1", peer: "http://peer", context_id: "ctx-t1", state: "submitted" });

    dispatches.recordSend("http://peer", view("t1", "working"));
    expect(store.get("t1")?.created_at).toBe(first?.created_at);
    expect(store.get("t1")?.state).toBe("working");
    expect(seen.map((event) => event.type)).toEqual(["dispatch", "dispatch"]);
  });

  it("never creates an entry from a read, and only writes when something changed", () => {
    const { log: dispatches, store, seen } = log();
    dispatches.refresh(view("ghost", "working"));
    expect(store.list()).toEqual([]);

    dispatches.recordSend("http://peer", view("t1", "working"));
    seen.length = 0;
    dispatches.refresh(view("t1", "working"));
    expect(seen).toEqual([]);
    dispatches.refresh(view("t1", "failed", "timeout"));
    expect(store.get("t1")).toMatchObject({ state: "failed", last_error: "timeout" });
    expect(seen).toHaveLength(1);
  });

  it("stores the dispatching session with the entry and keeps it through later reads", () => {
    const { log: dispatches, store } = log();
    dispatches.recordSend("http://peer", view("t1", "working"), SessionId("session-1"));
    expect(store.get("t1")?.agent_id).toBe("session-1");
    dispatches.refresh(view("t1", "completed"));
    expect(store.get("t1")).toMatchObject({ state: "completed", agent_id: "session-1" });

    // A dispatch without a session (the CLI, a host without sessions) records none.
    dispatches.recordSend("http://peer", view("t2", "working"));
    expect(store.get("t2")).not.toHaveProperty("agent_id");
  });
});
