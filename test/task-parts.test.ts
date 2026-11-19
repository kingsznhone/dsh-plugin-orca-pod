import { SessionId } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";

import { fakeNodeId } from "./fixtures/ids.ts";
import { DispatchLog } from "../src/task/dispatch-log.ts";
import { openDb } from "./fixtures/runner.ts";
import type { TaskView } from "../src/task/wire.ts";

const NODE_A = fakeNodeId("node-a");

function view(id: string, state: TaskView["status"]["state"], reason?: string): TaskView {
  return { kind: "task", id, contextId: `ctx-${id}`, status: { state, timestamp: "2026-01-01T00:00:00.000Z", reason } };
}

function log() {
  const dispatches = new DispatchLog(openDb());
  const entry = (taskId: string) => dispatches.list().find((item) => item.task_id === taskId);
  return { dispatches, entry };
}

describe("DispatchLog", () => {
  it("records a send with the node it went to and what it answered", () => {
    const { dispatches, entry } = log();
    dispatches.recordSend(NODE_A, view("t1", "submitted"));
    expect(entry("t1")).toMatchObject({ task_id: "t1", node: NODE_A, state: "submitted" });
  });

  it("never creates an entry from an update, and only writes when something changed", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { dispatches, entry } = log();
      dispatches.update(view("ghost", "working"));
      expect(dispatches.list()).toEqual([]);

      dispatches.recordSend(NODE_A, view("t1", "working"));
      const sent = entry("t1")?.updated_at;
      vi.advanceTimersByTime(1000);
      dispatches.update(view("t1", "working"));
      expect(entry("t1")?.updated_at).toBe(sent);
      dispatches.update(view("t1", "failed", "timeout"));
      expect(entry("t1")).toMatchObject({ state: "failed", last_error: "timeout" });
      expect(entry("t1")?.updated_at).not.toBe(sent);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an entry that ended as it is, lists only the open ones, and drops an error that is gone", () => {
    const { dispatches, entry } = log();
    dispatches.recordSend(NODE_A, view("done", "working"));
    dispatches.recordSend(NODE_A, view("open", "input-required", "asked"));
    dispatches.update(view("done", "completed"));
    dispatches.fail("done", "too late");
    dispatches.update(view("done", "working"));
    expect(entry("done")).toMatchObject({ state: "completed" });
    expect(entry("done")).not.toHaveProperty("last_error");
    expect(dispatches.open().map((item) => item.task_id)).toEqual(["open"]);

    dispatches.update(view("open", "working"));
    expect(entry("open")).toMatchObject({ state: "working" });
    expect(entry("open")).not.toHaveProperty("last_error");
  });

  it("records a task the tracker could not read as failed, with the reason", () => {
    const { dispatches, entry } = log();
    dispatches.recordSend(NODE_A, view("t1", "working"));
    dispatches.fail("t1", "no answer");
    expect(entry("t1")).toMatchObject({ state: "failed", last_error: "no answer" });
    expect(dispatches.open()).toEqual([]);
  });

  it("stores the dispatching session with the entry and keeps it through later updates", () => {
    const { dispatches, entry } = log();
    dispatches.recordSend(NODE_A, view("t1", "working"), SessionId("session-1"));
    expect(entry("t1")?.agent_id).toBe("session-1");
    dispatches.update(view("t1", "completed"));
    expect(entry("t1")).toMatchObject({ state: "completed", agent_id: "session-1" });

    // A dispatch without a session (the CLI, a host without sessions) records none.
    dispatches.recordSend(NODE_A, view("t2", "working"));
    expect(entry("t2")).not.toHaveProperty("agent_id");
  });
});
