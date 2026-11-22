/**
 * The permission requests a dispatched task waits on (design.md 6.4): the tracker
 * sees them while it follows the task, holds them for the UI, and carries the
 * user's answer to the remote task.
 */

import { SessionId } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it } from "vitest";

import { Tracker } from "../src/plugin/tracker.ts";
import { DispatchLog } from "../src/task/dispatch-log.ts";
import type { PermissionRequest, TaskView } from "../src/task/wire.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { idlePod, logger, podRunning } from "./fixtures/pod.ts";
import { openDb } from "./fixtures/runner.ts";

const PEER = fakeNodeId("NODE02");
const TASK = "TASK01";

const REQUEST: PermissionRequest = {
  request_id: "req-1",
  task_id: TASK,
  tool: "write_file",
  requested: { path: "report.md" },
  requested_by: PEER,
  current_mode: "read-only",
  requested_mode: "workspace-write",
};

function suspended(request: PermissionRequest = REQUEST): TaskView {
  return {
    kind: "task",
    id: TASK,
    contextId: "CTX01",
    status: {
      state: "input-required",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "agent", parts: [{ kind: "data", data: { permission_request: request } }] },
    },
  };
}

function resumed(): TaskView {
  return {
    kind: "task",
    id: TASK,
    contextId: "CTX01",
    status: { state: "working", timestamp: "2026-01-01T00:00:01.000Z" },
  };
}

const trackers: Tracker[] = [];

/** Wait until `check` holds, polling every few milliseconds. */
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.stop();
});

/**
 * A running pod whose one peer runs `TASK`, which this node dispatched from
 * session-1, and a started tracker that follows it. `node.view` is what the peer
 * answers a read with; the task stays as it is until the test changes it.
 */
async function following(view: TaskView = suspended()) {
  const node = {
    view,
    approved: [] as TaskView[],
    denied: [] as Array<{ view: TaskView; reason: string }>,
    failNext: false,
  };
  const row = {
    id: PEER,
    displayName: "node two",
    async getTask() {
      return node.view;
    },
    async approve(task: TaskView) {
      if (node.failNext) {
        node.failNext = false;
        throw new Error("peer unreachable");
      }
      node.approved.push(task);
      return resumed();
    },
    async deny(task: TaskView, reason: string) {
      node.denied.push({ view: task, reason });
      return resumed();
    },
  };
  const dispatches = new DispatchLog(openDb());
  // The tracker names the node by id; the panel by whatever it sends back, and this one node answers to every reference.
  const pod = podRunning({ dispatches, mesh: { get: () => row, resolve: () => row } });
  const tracker = new Tracker(pod, logger, () => undefined);
  trackers.push(tracker);
  dispatches.recordSend(PEER, view, SessionId("session-1"));
  tracker.start();
  if (view.status.state === "input-required") await until(() => tracker.approvals().length === 1);
  return { node, tracker };
}

describe("permission requests the tracker holds", () => {
  it("holds the request a task waits on, with the view the user decides on", async () => {
    const { tracker } = await following();
    expect(tracker.approvals()).toEqual([
      { node: PEER, view: suspended(), request: REQUEST, agentId: SessionId("session-1") },
    ]);
  });

  it("approves on the remote task and shows the request no more, though it has not polled since", async () => {
    const { node, tracker } = await following();
    expect((await tracker.approve(PEER, TASK)).status.state).toBe("working");
    expect(node.approved.map((view) => view.id)).toEqual([TASK]);
    // The next poll is a second away: until then nothing but this answer may speak for the task.
    expect(tracker.approvals()).toEqual([]);
  });

  it("denies with the given reason, or a default one", async () => {
    const { node, tracker } = await following();
    await tracker.deny(PEER, TASK, "not this time");
    await until(() => tracker.approvals().length === 1);
    await tracker.deny(PEER, TASK);
    expect(node.denied.map((entry) => entry.reason)).toEqual(["not this time", "denied from the UI"]);
  });

  it("keeps the request when the remote call fails, so the user can retry", async () => {
    const { node, tracker } = await following();
    node.failNext = true;
    await expect(tracker.approve(PEER, TASK)).rejects.toThrow(/peer unreachable/);
    expect(tracker.approvals()).toHaveLength(1);
    await tracker.approve(PEER, TASK);
    expect(tracker.approvals()).toEqual([]);
  });

  it("refuses a decision without a waiting request or a running node", async () => {
    const { tracker } = await following(resumed());
    await expect(tracker.approve(PEER, TASK)).rejects.toThrow(/no pending permission request/);
    await expect(new Tracker(idlePod(), logger, () => undefined).deny(PEER, TASK)).rejects.toThrow(/not running/);
  });
});
