/**
 * UI data surface (§9.2): the panel needs local task lists, change events,
 * pending approvals, workspace browsing and artifact links without driving the
 * model through a tool round-trip.
 */

import { parseSettings } from "../src/node/settings.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createOrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import type { OrcaNode } from "../src/node/orca-node.ts";
import type { PodEvent } from "../src/protocol/events.ts";
import type { MembershipTimings } from "../src/membership/membership.ts";
import type { TaskView } from "../src/protocol/task.ts";
import { isTerminal } from "../src/protocol/task.ts";
import { shortenNodeId } from "../src/security/identity.ts";
import { waitFor } from "./support/harness.ts";
import { createPodAdmin } from "../src/plugin/admin.ts";
import type { PodTaskRow } from "../src/plugin/admin.ts";
import type { PodHandle } from "../src/plugin/lifecycle.ts";
import { createApprovalBroker } from "../src/plugin/broker.ts";
import { createTracker } from "../src/plugin/tracker.ts";
import type { Logger } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/protocol/peer.ts";

const LEAF = fakeNodeId("orca-node-leaf");

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

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

async function makeNode(workgroupId: WorkgroupId, password: string): Promise<OrcaNode> {
  const config = await createOrcaNodeConfig({
    workgroup_id: workgroupId,
    workgroup_password: password,
    data_root: tempDir(),
    port: 0,
  });
  const node = createOrcaNode({ config, storage: createPersistentStorage(config), timings: FAST });
  started.push(node);
  return node;
}

/** An echo script that finishes with one text artifact. */
const ARTIFACT = {
  echo: { steps: [], final: { state: "completed", text: "done" }, artifacts: [{ name: "out.txt", content: "hello" }] },
};

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function text(body: string) {
  return { role: "user" as const, parts: [{ kind: "text" as const, text: body }] };
}

/** Two joined persistent orca nodes; `b` is the target of dispatches. */
async function startPair(): Promise<{ a: OrcaNode; b: OrcaNode }> {
  const workgroupId = wg(`wg-ui-${Math.random().toString(16).slice(2, 8)}`);
  const password = "ui-surface-password";
  const a = await makeNode(workgroupId, password);
  const b = await makeNode(workgroupId, password);
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
    config: { ...parseSettings({ workgroup_id: "wg-ui", workgroup_password: "pw" }), data_root: "/data" },
    configured: true,
    rememberedPeers: [],
    adopt: async () => {},
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
    reset: async () => {},
    dispose: async () => {},
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

  it("fetches a member's file by who published it and its sha256", async () => {
    const { a, b } = await startPair();
    const submitted = await a.sendTask(b.endpoints[0]!, { message: text("produce an artifact"), metadata: ARTIFACT });
    const view = await waitFor(
      () => a.getTask(b.endpoints[0]!, submitted.id),
      (current: TaskView) => isTerminal(current.status.state),
      { label: "artifact task completes" },
    );
    const blobId = view.artifacts![0]!.artifactId;

    // a dials b where b answers; the reference carries no address.
    expect(await readAll((await a.fetchBlob(b.orcaNodeId, blobId)).stream)).toBe("hello");
    // b answered: its 404 stands, no other address is tried.
    await expect(a.fetchBlob(b.orcaNodeId, "0".repeat(64))).rejects.toMatchObject({ code: "blob_not_found" });
  });

  it("exposes workspace paths, notes and artifact links through the admin surface", async () => {
    const { a, b } = await startPair();
    const broker = createApprovalBroker(() => b);
    const admin = createPodAdmin(
      handleFor(b),
      createTracker(() => b, broker, logger),
      broker,
    );
    writeFileSync(join(admin.workspace()!.notes, "STATUS.md"), "handoff notes");

    const workspace = admin.workspace()!;
    expect(workspace.notes_files).toEqual(["STATUS.md"]);

    const submitted = await a.sendTask(b.endpoints[0]!, { message: text("produce an artifact"), metadata: ARTIFACT });
    const rows = await waitFor(
      () => admin.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && isTerminal(row.state)),
      { label: "artifact task completes" },
    );
    const row = rows.find((entry) => entry.id === submitted.id)!;
    expect(row).toMatchObject({ peer: b.endpoints[0], cancellable: false, who: a.self().display_name });
    expect(row.artifacts).toEqual([{ name: "out.txt", blob_id: expect.any(String), bytes: 5, node: b.orcaNodeId }]);
    // The panel saves it through this node.
    const artifact = row.artifacts[0]!;
    expect(await readAll((await admin.blob(b.orcaNodeId, artifact.blob_id)).stream)).toBe("hello");

    expect(admin.members().map((peer) => peer.orca_node_id)).toContain(a.self().orca_node_id);
  });

  it("merges local tasks and dispatches into one list and tells where each can be cancelled", async () => {
    const { a, b } = await startPair();
    const broker = createApprovalBroker(() => b);
    const adminA = createPodAdmin(
      handleFor(a),
      createTracker(() => a, broker, logger),
      broker,
    );
    const adminB = createPodAdmin(
      handleFor(b),
      createTracker(() => b, broker, logger),
      broker,
    );

    const submitted = await a.sendTask(b.endpoints[0]!, {
      message: text("keep working"),
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitFor(
      () => adminB.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && row.cancellable),
      { label: "task runs on b" },
    );

    // The origin knows it only through its dispatch log: the target is the peer's URL and
    // there are no artifact links this node could sign.
    const dispatched = adminA.recent(10).find((row) => row.id === submitted.id)!;
    expect(dispatched).toMatchObject({
      peer: b.endpoints[0],
      who: b.self().display_name,
      cancellable: true,
      artifacts: [],
    });

    // The target runs it locally: the row addresses its own URL, and a call there works.
    const local = adminB.recent(10).find((row) => row.id === submitted.id)!;
    expect(local.peer).toBe(b.endpoints[0]);
    expect(adminB.recent(10).filter((row) => row.id === submitted.id)).toHaveLength(1);
    const detail = await adminB.task(local.peer, local.id);
    expect(detail).toMatchObject({ origin: a.self().display_name, dispatch: null });
    expect((await adminB.cancel(local.peer, local.id)).status.state).toBe("canceled");
    await waitFor(
      () => adminB.recent(10),
      (list: PodTaskRow[]) =>
        list.some((row) => row.id === submitted.id && row.state === "canceled" && !row.cancellable),
      { label: "cancelled on b" },
    );
  });

  it("serves a remote task with its dispatch record and no artifact link this node cannot sign", async () => {
    const { a, b } = await startPair();
    const broker = createApprovalBroker(() => a);
    const adminA = createPodAdmin(
      handleFor(a),
      createTracker(() => a, broker, logger),
      broker,
    );
    const submitted = await a.sendTask(b.endpoints[0]!, { message: text("produce an artifact"), metadata: ARTIFACT });
    await waitFor(
      () => b.listTasks(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );

    const detail = await adminA.task(b.endpoints[0]!, submitted.id);
    expect(detail.task.id).toBe(submitted.id);
    expect(detail.dispatch).toMatchObject({ task_id: submitted.id, peer: b.endpoints[0] });
    expect(detail.artifacts).toEqual([{ name: "out.txt", blob_id: expect.any(String), bytes: 5, node: b.orcaNodeId }]);
    expect(detail.origin).toBe(a.self().display_name);
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
                  requested: { tool_call_id: "call-1" },
                  requested_by: LEAF,
                  current_mode: "read-only",
                  requested_mode: "workspace-write",
                },
              },
            },
          ],
        },
      },
    };
    const broker = createApprovalBroker(() => b);
    const tracker = createTracker(
      () => ({ getTask: async () => suspended, annotateDispatch() {}, nodeIdOf: () => undefined }),
      broker,
      logger,
      {
        intervalMs: 20,
      },
    );
    const admin = createPodAdmin(handleFor(b), tracker, broker);
    let notified = 0;
    const offAdmin = admin.subscribe(() => {
      notified += 1;
    });
    tracker.track(
      { id: SessionId("agent-1"), status: "idle", inject() {}, followup() {} },
      "http://127.0.0.1:1",
      suspended.id,
    );
    const approvals = await waitFor(
      () => admin.approvals(),
      (list) => list.length === 1,
      { label: "pending approval appears" },
    );
    // The tracker and the broker both know the task: one entry, answerable by the UI.
    expect(approvals).toMatchObject([
      {
        id: `http://127.0.0.1:1|${suspended.id}`,
        task_id: suspended.id,
        tool: "write_file",
        agent_id: "agent-1",
        from: shortenNodeId(LEAF),
      },
    ]);
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
      () => b.listTasks(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes" },
    );
    await expect(admin.approve(b.endpoints[0]!, submitted.id)).rejects.toThrow(/no pending permission request/);
  });
});
