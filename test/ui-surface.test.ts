/**
 * UI data surface (§9.2): the panel needs local task lists, change events,
 * pending approvals, workspace browsing and artifact links without driving the
 * model through a tool round-trip.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import { createOrcaNode, createPersistentStorage } from "../src/orca_node.ts";
import type { OrcaNode } from "../src/orca_node.ts";
import type { PodEvent } from "../src/events.ts";
import type { MembershipTimings } from "../src/membership.ts";
import type { TaskView } from "../src/protocol.ts";
import { isTerminal } from "../src/protocol.ts";
import { waitFor } from "../src/harness.ts";
import { createPodAdmin } from "../src/plugin/admin.ts";
import type { PodHandle } from "../src/plugin/lifecycle.ts";
import { createTracker } from "../src/plugin/tracker.ts";

const FAST: Partial<MembershipTimings> = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

const dirs: string[] = [];
const started: OrcaNode[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-ui-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const node of started.splice(0)) await node.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeNode(workgroupId: string, password: string): OrcaNode {
  const config = createOrcaNodeConfig({ workgroupId, password, dataRoot: tempDir(), port: 0 });
  const node = createOrcaNode({ config, storage: createPersistentStorage(config), timings: FAST });
  started.push(node);
  return node;
}

function text(body: string) {
  return { role: "user" as const, parts: [{ kind: "text" as const, text: body }] };
}

/** Two joined persistent orca nodes; `b` is the target of dispatches. */
async function startPair(): Promise<{ a: OrcaNode; b: OrcaNode }> {
  const workgroupId = `wg-ui-${Math.random().toString(16).slice(2, 8)}`;
  const password = "ui-surface-password";
  const a = makeNode(workgroupId, password);
  const b = makeNode(workgroupId, password);
  await a.start();
  await b.start();
  await a.join(b.endpoints[0]!);
  await waitFor(
    () => a.members(),
    (members) => members.some((peer) => peer.orca_node_id === b.self().orca_node_id && peer.state === "online"),
    { label: "a sees b online" },
  );
  return { a, b };
}

function handleFor(node: OrcaNode): PodHandle {
  return {
    ready: Promise.resolve(),
    runtime: {
      orcaNode: node,
      url: node.endpoints[0] ?? null,
      port: null,
      started_at: null,
      error: null,
    },
    config: { workgroup_id: "wg-ui", workgroup_password: "pw", port: 11811, skill_injection: false, peers: [] },
    uiConfigured: true,
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
        reset: async () => {},
  };
}

describe("UI data surface", () => {
  it("lists local tasks and emits task, members and dispatch events", async () => {
    const { a, b } = await startPair();
    const eventsOnA: PodEvent[] = [];
    const eventsOnB: PodEvent[] = [];
    const offA = a.subscribe((event) => eventsOnA.push(event));
    const offB = b.subscribe((event) => eventsOnB.push(event));
    // A throwing listener must not break the node or other listeners.
    const offThrower = b.subscribe(() => {
      throw new Error("broken UI listener");
    });

    const submitted = await a.sendTask(b.endpoints[0]!, {
      message: text("hello from a"),
      metadata: { echo: { steps: [], final: { state: "completed", text: "done" }, artifacts: [] } },
    });
    const finished = await waitFor(
      () => b.listTasks(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );
    expect(finished[0]?.id).toBe(submitted.id);
    expect(finished[0]?.status.state).toBe("completed");

    // b emitted a task event for the working transition and the completion.
    const taskEvents = eventsOnB.filter((event) => event.type === "task" && event.view.id === submitted.id);
    expect(taskEvents.length).toBeGreaterThanOrEqual(1);
    expect(taskEvents.some((event) => event.type === "task" && event.view.status.state === "completed")).toBe(true);
    // Member changes are emitted too (at least the initial roster).
    expect(eventsOnB.some((event) => event.type === "members")).toBe(true);

    // a keeps an origin-side dispatch log and announces it.
    const dispatchEvents = eventsOnA.filter(
      (event) => event.type === "dispatch" && event.entry.task_id === submitted.id,
    );
    expect(dispatchEvents.length).toBeGreaterThanOrEqual(1);
    expect(a.listDispatches().map((entry) => entry.task_id)).toContain(submitted.id);

    offA();
    offB();
    offThrower();
    const before = eventsOnA.length;
    await a.sendTask(b.endpoints[0]!, { message: text("second") });
    expect(eventsOnA.length).toBe(before);
  });

  it("mints signed blob links that the gateway accepts", async () => {
    const { b } = await startPair();
    const blobId = "a".repeat(64);
    const url = b.blobLink(blobId);
    expect(url).not.toBeNull();
    expect(url).toContain(`/blobs/${blobId}?exp=`);

    // A valid signature reaches blob lookup, which reports "not found".
    expect((await fetch(url!)).status).toBe(404);
    // Tampering with the signature is rejected before lookup.
    const tampered = url!.replace(/sig=[^&]+$/, "sig=tampered");
    expect((await fetch(tampered)).status).toBe(403);
    // An already-expired link is rejected.
    expect((await fetch(b.blobLink(blobId, -10)!)).status).toBe(410);
  });

  it("exposes workspace paths, notes and artifact links through the admin surface", async () => {
    const { a, b } = await startPair();
    const admin = createPodAdmin(handleFor(b), createTracker(() => b));
    writeFileSync(join(admin.workspace()!.notes, "STATUS.md"), "handoff notes");

    const workspace = admin.workspace()!;
    expect(workspace.notes_files).toEqual(["STATUS.md"]);
    expect(workspace.inputs_dirs).toEqual([]);

    const submitted = await a.sendTask(b.endpoints[0]!, {
      message: text("produce an artifact"),
      metadata: {
        echo: {
          steps: [],
          final: { state: "completed", text: "done" },
          artifacts: [{ name: "out.txt", content: "hello" }],
        },
      },
    });
    const tasks = await waitFor(
      () => admin.tasks(),
      (list: TaskView[]) => list.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "artifact task completes" },
    );
    const view = tasks.find((task) => task.id === submitted.id)!;
    const artifacts = admin.artifacts(view);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.name).toBe("out.txt");
    expect(artifacts[0]!.url).toContain("/blobs/");
    // The signed link serves the artifact bytes.
    const response = await fetch(artifacts[0]!.url!);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");

    expect(admin.members().map((peer) => peer.orca_node_id)).toContain(a.self().orca_node_id);
  });

  it("lists pending approvals from tracked remote tasks", async () => {
    const { a, b } = await startPair();
    const suspended: TaskView = {
      kind: "task",
      id: "task-pending",
      contextId: "ctx-pending",
      status: {
        state: "input-required",
        timestamp: new Date().toISOString(),
        message: {
          role: "agent",
          parts: [
            {
              kind: "data",
              data: {
                permission_request: {
                  request_id: "req-1",
                  task_id: "task-pending",
                  tool: "write_file",
                  requested: "write a file",
                  requested_by: "orca-node-leaf",
                  via: ["orca-node-leaf"],
                },
              },
            },
          ],
        },
      },
    };
    const tracker = createTracker(() => ({ getTask: async () => suspended }), { intervalMs: 20 });
    const admin = createPodAdmin(handleFor(b), tracker);
    let notified = 0;
    const offAdmin = admin.subscribe(() => {
      notified += 1
    });
    tracker.track(
      { id: "agent-1", status: "idle", inject() {}, followup() {} },
      "http://127.0.0.1:1",
      suspended.id,
    );
    const approvals = await waitFor(
      () => admin.approvals(),
      (list) => list.length === 1,
      { label: "pending approval appears" },
    );
    expect(approvals[0]!.taskId).toBe(suspended.id);
    expect(approvals[0]!.request?.request_id).toBe("req-1");
    await waitFor(
      () => notified,
      (count) => count > 0,
      { label: "admin listener notified" },
    );
    offAdmin();
    tracker.stop();

    // Approving a task that is not blocked on a permission request is reported.
    const submitted = await a.sendTask(b.endpoints[0]!, { message: text("finished quickly") });
    await waitFor(
      () => admin.tasks(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes" },
    );
    await expect(admin.approve(b.endpoints[0]!, submitted.id)).rejects.toThrow(/no pending permission request/);
  });
});
