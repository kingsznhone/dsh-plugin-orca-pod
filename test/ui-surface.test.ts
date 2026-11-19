/**
 * UI data surface (§9.2): the panel needs local task lists, change events,
 * pending approvals, workspace browsing and file links without driving the
 * model through a tool round-trip.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeParts } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import type { SubmitTaskInput, TaskView } from "../src/task/wire.ts";
import { isTerminal } from "../src/task/wire.ts";
import { shortenNodeId } from "../src/core/identity.ts";
import { waitFor } from "./support/harness.ts";
import { PanelModel } from "../src/plugin/panel.ts";
import type { PodTaskRow } from "../src/plugin/panel-api.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import { catalogFeed, podRunning } from "./fixtures/pod.ts";
import type { Logger } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/wire/peer.ts";
import { peersOf } from "./support/node.ts";

const LEAF = fakeNodeId("orca-node-leaf");

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

const FAST: Partial<MeshTimings> = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

const dirs: string[] = [];
const started: Orca[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-ui-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const node of started.splice(0)) await node.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function makeNode(workgroupId: WorkgroupId, password: string): Promise<Orca> {
  const config = nodeParts({
    workgroup_id: workgroupId,
    workgroup_password: password,
    data_root: tempDir(),
    port: 0,
  });
  const node = new Orca(...config, { timings: FAST });
  started.push(node);
  return node;
}

/**
 * A file `node` published, and a task whose result names it, the way a task's
 * agent hands one back (§5.6): files are not part of the task, only its text.
 */
async function handingBack(node: Orca): Promise<{ blobId: string; metadata: SubmitTaskInput["metadata"] }> {
  const path = join(tempDir(), "out.txt");
  writeFileSync(path, "hello");
  const { blob_id: blobId } = await node.blobs.register(path);
  return {
    blobId,
    metadata: { echo: { steps: [], final: { state: "completed", text: `done: ${node.orcaNodeId}/${blobId}` } } },
  };
}

async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function text(body: string) {
  return { role: "user" as const, parts: [{ kind: "text" as const, text: body }] };
}

/** Two joined persistent orca nodes; `b` is the target of dispatches. */
async function startPair(): Promise<{ a: Orca; b: Orca }> {
  const workgroupId = wg(`wg-ui-${Math.random().toString(16).slice(2, 8)}`);
  const password = "ui-surface-password";
  const a = await makeNode(workgroupId, password);
  const b = await makeNode(workgroupId, password);
  await a.start();
  await b.start();
  await a.mesh.probe(b.mesh.self.endpoints[0]!);
  await waitFor(
    () => peersOf(a),
    (members) => members.some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"),
    { label: "a sees b online" },
  );
  return { a, b };
}

/** A pod over an already running node: the pod, its approval broker, tracker and panel model. */
function podOver(node: Orca) {
  const pod = podRunning(node);
  const broker = new ApprovalBroker(pod);
  const tracker = new Tracker(pod, broker, logger, () => undefined);
  return { pod, broker, tracker, panel: new PanelModel(pod, broker, catalogFeed()) };
}

describe("UI data surface", () => {
  it("lists local tasks and emits task, members and dispatch events", async () => {
    const { a, b } = await startPair();
    type PodEvent = Parameters<Parameters<Orca["events"]["subscribe"]>[0]>[0];
    const eventsOnA: PodEvent[] = [];
    const eventsOnB: PodEvent[] = [];
    const offA = a.events.subscribe((event) => eventsOnA.push(event));
    const offB = b.events.subscribe((event) => eventsOnB.push(event));
    // A throwing listener must not break the node or other listeners.
    const offThrower = b.events.subscribe(() => {
      throw new Error("broken UI listener");
    });

    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: text("hello from a"),
      metadata: { echo: { steps: [], final: { state: "completed", text: "done" } } },
    });
    const finished = await waitFor(
      () => b.tasks.list(10),
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
    expect(a.dispatches.list().map((entry) => entry.task_id)).toContain(submitted.id);

    offA();
    offB();
    offThrower();
    const before = eventsOnA.length;
    await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({ message: text("second") });
    expect(eventsOnA.length).toBe(before);
  });

  it("fetches a member's file by who published it and its sha256", async () => {
    const { a, b } = await startPair();
    const { blobId } = await handingBack(b);

    // a dials b where b answers; the reference carries no address.
    expect(await readAll((await a.mesh.require(b.orcaNodeId).fetchBlob(blobId)).stream)).toBe("hello");
    // b answered: its 404 stands, no other address is tried.
    await expect(a.mesh.require(b.orcaNodeId).fetchBlob("0".repeat(64))).rejects.toMatchObject({
      code: "blob_not_found",
    });
  });

  it("exposes the workspace path and the files a result names through the panel model", async () => {
    const { a, b } = await startPair();
    const { panel } = podOver(b);
    expect((await panel.state()).workspace).toEqual({ root: b.workspace.root, state: b.workspace.state });

    const { blobId, metadata } = await handingBack(b);
    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: text("hand a file back"),
      metadata,
    });
    const rows = await waitFor(
      () => panel.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && isTerminal(row.state)),
      { label: "the task completes" },
    );
    const row = rows.find((entry) => entry.id === submitted.id)!;
    expect(row).toMatchObject({
      peer: b.orcaNodeId,
      cancellable: false,
      who: a.mesh.self.selfRecord().display_name,
    });
    expect(row.files).toEqual([{ node: b.orcaNodeId, blob_id: blobId }]);
    // The panel saves it through this node.
    expect(await readAll((await panel.blob(b.orcaNodeId, blobId)).stream)).toBe("hello");

    expect((await panel.state()).members.map((peer) => peer.orca_node_id)).toContain(a.orcaNodeId);
  });

  it("merges local tasks and dispatches into one list and tells where each can be cancelled", async () => {
    const { a, b } = await startPair();
    const { panel: panelA } = podOver(a);
    const { panel: panelB } = podOver(b);

    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: text("keep working"),
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitFor(
      () => panelB.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && row.cancellable),
      { label: "task runs on b" },
    );

    // The origin knows it only through its dispatch log: the target is the node it went to and
    // the log keeps no result, so it names no files.
    const dispatched = panelA.recent(10).find((row) => row.id === submitted.id)!;
    expect(dispatched).toMatchObject({
      peer: b.orcaNodeId,
      who: b.mesh.self.selfRecord().display_name,
      cancellable: true,
      files: [],
    });

    // The target runs it locally: the row addresses its own node, and a call there works.
    const local = panelB.recent(10).find((row) => row.id === submitted.id)!;
    expect(local.peer).toBe(b.orcaNodeId);
    expect(panelB.recent(10).filter((row) => row.id === submitted.id)).toHaveLength(1);
    const detail = await panelB.task(local.peer, local.id);
    expect(detail).toMatchObject({ origin: a.mesh.self.selfRecord().display_name, dispatch: null });
    expect((await panelB.cancel(local.peer, local.id)).status.state).toBe("canceled");
    await waitFor(
      () => panelB.recent(10),
      (list: PodTaskRow[]) =>
        list.some((row) => row.id === submitted.id && row.state === "canceled" && !row.cancellable),
      { label: "cancelled on b" },
    );
  });

  it("serves a remote task with its dispatch record and the files its result names", async () => {
    const { a, b } = await startPair();
    const { panel: panelA } = podOver(a);
    const { blobId, metadata } = await handingBack(b);
    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: text("hand a file back"),
      metadata,
    });
    await waitFor(
      () => b.tasks.list(10),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );

    const detail = await panelA.task(b.mesh.self.endpoints[0]!, submitted.id);
    expect(detail.task.id).toBe(submitted.id);
    expect(detail.dispatch).toMatchObject({ task_id: submitted.id, node: b.orcaNodeId });
    expect(detail.files).toEqual([{ node: b.orcaNodeId, blob_id: blobId }]);
    expect(detail.origin).toBe(a.mesh.self.selfRecord().display_name);
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
    // b dispatched a task that runs on a, which it knows from a's hello; the tracker finds it in b's log.
    vi.spyOn(b.mesh.require(a.orcaNodeId), "getTask").mockResolvedValue(suspended);
    const { tracker, panel } = podOver(b);
    b.dispatches.recordSend(a.orcaNodeId, suspended, SessionId("agent-1"));
    tracker.start();
    const approvals = await waitFor(
      async () => (await panel.state()).approvals,
      (list) => list.length === 1,
      { label: "pending approval appears" },
    );
    // The broker holds what the tracker saw: one entry, answerable by the UI.
    expect(approvals).toMatchObject([
      {
        id: `${a.orcaNodeId}|${suspended.id}`,
        peer: a.orcaNodeId,
        task_id: suspended.id,
        tool: "write_file",
        requested: '{"tool_call_id":"call-1"}',
        current_mode: "read-only",
        requested_mode: "workspace-write",
        agent_id: "agent-1",
        from: shortenNodeId(LEAF),
      },
    ]);
    tracker.stop();

    // Approving a task that is not blocked on a permission request is reported.
    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({ message: text("finished quickly") });
    await waitFor(
      () => b.tasks.list(10),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes" },
    );
    await expect(panel.approve(b.mesh.self.endpoints[0]!, submitted.id)).rejects.toThrow(
      /no pending permission request/,
    );
  });
});
