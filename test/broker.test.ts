import { describe, expect, it } from "vitest";

import { PanelModel } from "../src/plugin/panel.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import type { PermissionRequest, TaskView } from "../src/task/wire.ts";
import { DispatchLog } from "../src/task/dispatch-log.ts";
import { openDb } from "./fixtures/runner.ts";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, labelId } from "./fixtures/ids.ts";
import { catalogFeed, idlePod, podRunning, logger } from "./fixtures/pod.ts";

const PEER = fakeNodeId("NODE02");

function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 5);
    };
    tick();
  });
}
const TASK = "TASK01";

const REQUEST: PermissionRequest = {
  request_id: "req-1",
  task_id: TASK,
  tool: "write_file",
  requested: { path: "report.md" },
  requested_by: labelId("NODE02"),
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

function fakeNode(): {
  approved: TaskView[];
  denied: Array<{ view: TaskView; reason?: string }>;
  failNext: boolean;
  dispatches: DispatchLog;
} {
  const node = {
    approved: [] as TaskView[],
    // The tracker's work: what this node dispatched and has not seen end.
    dispatches: new DispatchLog(openDb(), { warn() {} }),
    denied: [] as Array<{ view: TaskView; reason?: string }>,
    failNext: false,
    mesh: {
      // The broker names the node by what the panel sends back; this one node answers to every reference.
      get: () => row,
      resolve: () => row,
    },
  };
  const row = {
    id: PEER,
    // The task stays suspended in what the tracker reads: it has not polled again since the decision.
    async getTask() {
      return suspended({ ...REQUEST, requested_by: fakeNodeId("NODE02") });
    },
    async approve(view: TaskView) {
      if (node.failNext) {
        node.failNext = false;
        throw new Error("peer unreachable");
      }
      node.approved.push(view);
      return resumed();
    },
    async deny(view: TaskView, reason?: string) {
      node.denied.push({ view, reason });
      return resumed();
    },
  };
  return node as unknown as ReturnType<typeof fakeNode>;
}

const park = (broker: ApprovalBroker, request = REQUEST) =>
  broker.park({ node: PEER, view: suspended(request), request, agentId: "session-1" });

describe("approval broker", () => {
  it("keeps one prompt per request id and replaces it when the request changes", () => {
    const broker = new ApprovalBroker(idlePod());
    park(broker);
    const first = broker.list()[0]!;
    expect(first).toEqual({ node: PEER, task_id: TASK, request: REQUEST, agent_id: "session-1" });
    expect(first.request).toBe(REQUEST);

    park(broker);
    expect(broker.list()).toEqual([first]);

    park(broker, { ...REQUEST, request_id: "req-2" });
    expect(broker.list()).toHaveLength(1);
    expect(broker.list()[0]!.request.request_id).toBe("req-2");
  });

  it("approves the parked request on the remote task and withdraws the prompt", async () => {
    const node = fakeNode();
    const broker = new ApprovalBroker(podRunning(node));
    park(broker);
    const task = await broker.approve(PEER, TASK);
    expect(task.status.state).toBe("working");
    expect(node.approved).toHaveLength(1);
    expect(node.approved[0]!.id).toBe(TASK);
    expect(broker.list()).toEqual([]);
  });

  it("denies with the given reason, or a default one", async () => {
    const node = fakeNode();
    const broker = new ApprovalBroker(podRunning(node));
    park(broker);
    await broker.deny(PEER, TASK, "not this time");
    park(broker);
    await broker.deny(PEER, TASK);
    expect(node.denied.map((entry) => entry.reason)).toEqual(["not this time", "denied from the UI"]);
    expect(broker.list()).toEqual([]);
  });

  it("keeps the prompt when the remote call fails so the user can retry", async () => {
    const node = fakeNode();
    const broker = new ApprovalBroker(podRunning(node));
    park(broker);
    node.failNext = true;
    await expect(broker.approve(PEER, TASK)).rejects.toThrow(/peer unreachable/);
    expect(broker.list()).toHaveLength(1);
    await broker.approve(PEER, TASK);
    expect(broker.list()).toEqual([]);
  });

  it("rejects a decision without a pending prompt or a running node", async () => {
    const broker = new ApprovalBroker(podRunning(fakeNode()));
    await expect(broker.approve(PEER, TASK)).rejects.toThrow(/no pending permission request/);
    await expect(new ApprovalBroker(idlePod()).deny(PEER, TASK)).rejects.toThrow(/not running/);
  });

  it("drops a prompt on withdraw and every prompt on clear", () => {
    const broker = new ApprovalBroker(idlePod());
    park(broker);
    expect(broker.list()).toHaveLength(1);
    broker.withdraw(PEER, TASK);
    expect(broker.list()).toEqual([]);
    park(broker);
    broker.clear();
    expect(broker.list()).toEqual([]);
    // With nothing parked both are harmless.
    broker.withdraw(PEER, TASK);
    broker.clear();
    expect(broker.list()).toEqual([]);
  });

  it("is what the panel model approves and denies through", async () => {
    const node = fakeNode();
    const pod = podRunning(node);
    const broker = new ApprovalBroker(pod);
    const panel = new PanelModel(pod, broker, catalogFeed());

    park(broker);
    expect(broker.list()).toHaveLength(1);
    expect((await panel.approve(PEER, TASK)).status.state).toBe("working");
    expect(broker.list()).toEqual([]);

    park(broker);
    await panel.deny(PEER, TASK, "no");
    expect(node.denied.at(-1)!.reason).toBe("no");
  });

  it("shows an answered request no more, even though the tracker has not polled since", async () => {
    const node = fakeNode();
    const pod = podRunning(node);
    const broker = new ApprovalBroker(pod);
    const tracker = new Tracker(pod, broker, logger, () => undefined);
    const panel = new PanelModel(pod, broker, catalogFeed());
    try {
      node.dispatches.recordSend(PEER, suspended(REQUEST), SessionId("session-1"));
      tracker.start();
      await waitFor(() => broker.list().length === 1);

      await panel.approve(PEER, TASK);
      // The next poll is a second away: until then nothing but the broker may speak for this task.
      expect(broker.list()).toEqual([]);
    } finally {
      tracker.stop();
    }
  });
});
