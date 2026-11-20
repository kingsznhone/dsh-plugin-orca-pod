/**
 * UI data surface (§9.2): the panel needs local task lists, change events,
 * pending approvals, workspace browsing and file links without driving the
 * model through a tool round-trip.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBlobRef } from "../src/core/blobs.ts";
import { nodeParts, peersOf } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import { type TaskView, isTerminal } from "../src/task/wire.ts";
import { shortenNodeId } from "../src/core/identity.ts";
import { waitFor } from "./support/harness.ts";
import { PanelModel } from "../src/plugin/panel.ts";
import type { PodTaskRow } from "../src/plugin/panel-api.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import { catalogFeed, podRunning } from "./fixtures/pod.ts";
import type { Logger } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/ids.ts";
import { ScriptExecutor, scriptMessage } from "./support/script.ts";

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
  const node = new Orca(...config, { timings: FAST, executor: new ScriptExecutor() });
  started.push(node);
  return node;
}

/** A file `node` published (§5.6), as its sha256. */
async function published(node: Orca): Promise<string> {
  const path = join(tempDir(), "out.txt");
  writeFileSync(path, "hello");
  return parseBlobRef((await node.mesh.self.publish(path)).ref)!.blob_id;
}

const COMPLETES = scriptMessage({ final: { state: "completed", text: "done" } });

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
    (members) => members.some((peer) => peer.orca_node_id === b.mesh.self.id && peer.state === "online"),
    { label: "a sees b online" },
  );
  return { a, b };
}

/** A pod over an already running node: the pod, its tracker and panel model. */
function podOver(node: Orca) {
  const pod = podRunning(node);
  const tracker = new Tracker(pod, logger, () => undefined);
  return { pod, tracker, panel: new PanelModel(pod, tracker, catalogFeed()) };
}

describe("UI data surface", () => {
  it("lists local tasks, keeps the origin's dispatch log and advertises the slot", async () => {
    const { a, b } = await startPair();

    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: scriptMessage({ steps: [], final: { state: "completed", text: "done" } }),
    });
    const finished = await waitFor(
      () => b.tasks.list(10),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );
    expect(finished[0]?.id).toBe(submitted.id);
    expect(finished[0]?.status.state).toBe("completed");

    // The slot is free again, and b's own record says so.
    expect(b.mesh.self.view().busy).toBeNull();
    // a keeps an origin-side dispatch log.
    expect(a.dispatches.list().map((entry) => entry.task_id)).toContain(submitted.id);
  });

  it("advertises the task holding the slot in its own record", async () => {
    const { a, b } = await startPair();
    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: scriptMessage({ final: { state: "hang", text: "" } }),
    });
    expect(b.mesh.self.view().busy).toMatchObject({ task_id: submitted.id, origin_orca_node: a.mesh.self.id });
    await b.mesh.self.cancelTask(submitted.id);
  });

  it("fetches a member's file by who published it and its sha256", async () => {
    const { a, b } = await startPair();
    const blobId = await published(b);

    // a dials b where b answers; the reference carries no address.
    expect(await readAll((await a.mesh.require(b.mesh.self.id).fetchBlob(blobId)).stream)).toBe("hello");
    // b answered: its 404 stands, no other address is tried.
    await expect(a.mesh.require(b.mesh.self.id).fetchBlob("0".repeat(64))).rejects.toMatchObject({
      code: "blob_not_found",
    });
  });

  it("exposes the workspace path and a finished local task through the panel model", async () => {
    const { a, b } = await startPair();
    const { panel } = podOver(b);
    expect((await panel.state()).workspace_root).toBe(b.workspace.root);

    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({ message: COMPLETES });
    const rows = await waitFor(
      () => panel.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && isTerminal(row.state)),
      { label: "the task completes" },
    );
    const row = rows.find((entry) => entry.id === submitted.id)!;
    expect(row).toMatchObject({
      peer: b.mesh.self.id,
      cancellable: false,
      who: a.mesh.self.selfRecord().display_name,
    });

    expect((await panel.state()).members.map((peer) => peer.orca_node_id)).toContain(a.mesh.self.id);
    // Both directions work here, so the panel does not mark the member as blocked.
    expect((await panel.state()).members.find((peer) => peer.orca_node_id === a.mesh.self.id)).toMatchObject({
      unreachable: false,
    });
  });

  it("merges local tasks and dispatches into one list and tells where each can be cancelled", async () => {
    const { a, b } = await startPair();
    const { panel: panelA } = podOver(a);
    const { panel: panelB } = podOver(b);

    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({
      message: scriptMessage({ final: { state: "hang", text: "" } }),
    });
    await waitFor(
      () => panelB.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && row.cancellable),
      { label: "task runs on b" },
    );

    // The origin knows it only through its dispatch log: the target is the node it went to.
    const dispatched = panelA.recent(10).find((row) => row.id === submitted.id)!;
    expect(dispatched).toMatchObject({
      peer: b.mesh.self.id,
      who: b.mesh.self.selfRecord().display_name,
      cancellable: true,
    });

    // The target runs it locally: the row addresses its own node, and a call there works.
    const local = panelB.recent(10).find((row) => row.id === submitted.id)!;
    expect(local.peer).toBe(b.mesh.self.id);
    expect(panelB.recent(10).filter((row) => row.id === submitted.id)).toHaveLength(1);
    const detail = await panelB.task(local.peer, local.id);
    expect(detail).toMatchObject({ origin: a.mesh.self.selfRecord().display_name, dispatch: null });
    expect((await b.mesh.resolve(local.peer).cancelTask(local.id)).status.state).toBe("canceled");
    await waitFor(
      () => panelB.recent(10),
      (list: PodTaskRow[]) =>
        list.some((row) => row.id === submitted.id && row.state === "canceled" && !row.cancellable),
      { label: "cancelled on b" },
    );
  });

  it("serves a remote task with its dispatch record", async () => {
    const { a, b } = await startPair();
    const { panel: panelA } = podOver(a);
    const submitted = await a.mesh.resolve(b.mesh.self.endpoints[0]!).sendTask({ message: COMPLETES });
    await waitFor(
      () => b.tasks.list(10),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );

    const detail = await panelA.task(b.mesh.self.endpoints[0]!, submitted.id);
    expect(detail.task.id).toBe(submitted.id);
    expect(detail.dispatch).toMatchObject({ task_id: submitted.id, node: b.mesh.self.id });
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
    vi.spyOn(b.mesh.require(a.mesh.self.id), "getTask").mockResolvedValue(suspended);
    const { tracker, panel } = podOver(b);
    b.dispatches.recordSend(a.mesh.self.id, suspended, SessionId("agent-1"));
    tracker.start();
    const approvals = await waitFor(
      async () => (await panel.state()).approvals,
      (list) => list.length === 1,
      { label: "pending approval appears" },
    );
    // The tracker holds what it saw: one entry, answerable by the UI.
    expect(approvals).toMatchObject([
      {
        id: `${a.mesh.self.id}|${suspended.id}`,
        peer: a.mesh.self.id,
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
    await expect(tracker.approve(b.mesh.self.endpoints[0]!, submitted.id)).rejects.toThrow(
      /no pending permission request/,
    );
  });
});
