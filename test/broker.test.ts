import { describe, expect, it } from "vitest";

import { PanelModel } from "../src/plugin/panel.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import type { PermissionRequest } from "../src/core/wire/grant.ts";
import type { TaskView } from "../src/task/wire.ts";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, labelId } from "./fixtures/ids.ts";
import { catalogFeed, idlePod, podRunning, logger } from "./fixtures/pod.ts";

const PEER = "http://127.0.0.1:11812";

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
} {
  const node = {
    approved: [] as TaskView[],
    denied: [] as Array<{ view: TaskView; reason?: string }>,
    failNext: false,
    // What the panel model reads to label the nodes in an approval.
    profile: { record: () => ({ orca_node_id: labelId("SELF00"), display_name: "self", endpoints: [] as string[] }) },
    membership: { list: () => [] as unknown[] },
    client: { idOf: () => undefined },
    delegation: {
      // The task stays suspended in what the tracker reads: it has not polled again since the decision.
      async getTask() {
        return suspended({ ...REQUEST, requested_by: fakeNodeId("NODE02") });
      },
      async approveTask(_peer: string, view: TaskView) {
        if (node.failNext) {
          node.failNext = false;
          throw new Error("peer unreachable");
        }
        node.approved.push(view);
        return resumed();
      },
      async denyTask(_peer: string, view: TaskView, reason?: string) {
        node.denied.push({ view, reason });
        return resumed();
      },
    },
  };
  return node as unknown as ReturnType<typeof fakeNode>;
}

const park = (broker: ApprovalBroker, request = REQUEST) =>
  broker.park({ peer: PEER, view: suspended(request), request, agentId: "session-1" });

describe("approval broker", () => {
  it("keeps one prompt per request id and replaces it when the request changes", () => {
    const broker = new ApprovalBroker(idlePod());
    park(broker);
    const first = broker.list()[0]!;
    expect(first).toMatchObject({
      peer: PEER,
      task_id: TASK,
      request_id: "req-1",
      agent_id: "session-1",
      tool: "write_file",
    });
    expect(first.request).toBe(REQUEST);

    park(broker);
    expect(broker.list()).toEqual([first]);

    park(broker, { ...REQUEST, request_id: "req-2" });
    expect(broker.list()).toHaveLength(1);
    expect(broker.list()[0]!.id).not.toBe(first.id);
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
    expect(panel.approvals()).toEqual([
      {
        id: `${PEER}|${TASK}`,
        peer: PEER,
        task_id: TASK,
        tool: "write_file",
        requested: '{"path":"report.md"}',
        from: "NODE02",
        current_mode: "read-only",
        requested_mode: "workspace-write",
        agent_id: "session-1",
      },
    ]);
    expect((await panel.approve(PEER, TASK)).status.state).toBe("working");
    expect(panel.approvals()).toEqual([]);

    park(broker);
    await panel.deny(PEER, TASK, "no");
    expect(node.denied.at(-1)!.reason).toBe("no");
  });

  it("shows an answered request no more, even though the tracker has not polled since", async () => {
    const node = fakeNode();
    const pod = podRunning(node);
    const broker = new ApprovalBroker(pod);
    const tracker = new Tracker(pod, broker, logger, { intervalMs: 60_000 });
    const panel = new PanelModel(pod, broker, catalogFeed());
    try {
      const agent = { id: SessionId("session-1"), status: "idle", inject() {}, followup() {} } as unknown as Agent;
      tracker.track(agent, PEER, TASK);
      await waitFor(() => broker.list().length === 1);
      expect(panel.approvals()).toHaveLength(1);

      await panel.approve(PEER, TASK);
      // The next poll is a minute away: until then nothing but the broker may speak for this task.
      expect(panel.approvals()).toEqual([]);
    } finally {
      tracker.stop();
    }
  });
});
