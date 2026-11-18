/**
 * UI data surface (§9.2): the panel needs local task lists, change events,
 * pending approvals, workspace browsing and artifact links without driving the
 * model through a tool round-trip.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { OrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import type { PodEvent } from "../src/node/events.ts";
import type { MembershipTimings } from "../src/mesh/membership.ts";
import type { TaskView } from "../src/task/wire.ts";
import { isTerminal } from "../src/task/wire.ts";
import { shortenNodeId } from "../src/core/identity.ts";
import { waitFor } from "./support/harness.ts";
import { PodAdmin } from "../src/plugin/admin.ts";
import type { PodTaskRow } from "../src/plugin/admin.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import { Tracker, type TrackerOptions } from "../src/plugin/tracker.ts";
import { catalogFeed, lifecycleWithNode } from "./fixtures/pod.ts";
import type { Logger } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/wire/peer.ts";

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
  const node = new OrcaNode(config, { storage: createPersistentStorage(config), timings: FAST });
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
  await a.mesh.join(b.profile.endpoints[0]!);
  await waitFor(
    () => a.membership.list(),
    (members) => members.some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"),
    { label: "a sees b online" },
  );
  return { a, b };
}

/** A pod over an already running node: its lifecycle, approval broker, tracker and admin surface. */
function podOver(node: OrcaNode, options?: TrackerOptions) {
  const lifecycle = lifecycleWithNode(node);
  const broker = new ApprovalBroker(lifecycle);
  const tracker = new Tracker(lifecycle, broker, logger, options);
  return { lifecycle, broker, tracker, admin: new PodAdmin(lifecycle, tracker, broker, catalogFeed()) };
}

describe("UI data surface", () => {
  it("lists local tasks and emits task, members and dispatch events", async () => {
    const { a, b } = await startPair();
    const eventsOnA: PodEvent[] = [];
    const eventsOnB: PodEvent[] = [];
    const offA = a.events.subscribe((event) => eventsOnA.push(event));
    const offB = b.events.subscribe((event) => eventsOnB.push(event));
    // A throwing listener must not break the node or other listeners.
    const offThrower = b.events.subscribe(() => {
      throw new Error("broken UI listener");
    });

    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, {
      message: text("hello from a"),
      metadata: { echo: { steps: [], final: { state: "completed", text: "done" }, artifacts: [] } },
    });
    const finished = await waitFor(
      () => b.tasks.list(),
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
    expect(a.delegation.log.list().map((entry) => entry.task_id)).toContain(submitted.id);

    offA();
    offB();
    offThrower();
    const before = eventsOnA.length;
    await a.delegation.sendTask(b.profile.endpoints[0]!, { message: text("second") });
    expect(eventsOnA.length).toBe(before);
  });

  it("fetches a member's file by who published it and its sha256", async () => {
    const { a, b } = await startPair();
    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, {
      message: text("produce an artifact"),
      metadata: ARTIFACT,
    });
    const view = await waitFor(
      () => a.delegation.getTask(b.profile.endpoints[0]!, submitted.id),
      (current: TaskView) => isTerminal(current.status.state),
      { label: "artifact task completes" },
    );
    const blobId = view.artifacts![0]!.artifactId;

    // a dials b where b answers; the reference carries no address.
    expect(await readAll((await a.blobs.fetch(b.orcaNodeId, blobId)).stream)).toBe("hello");
    // b answered: its 404 stands, no other address is tried.
    await expect(a.blobs.fetch(b.orcaNodeId, "0".repeat(64))).rejects.toMatchObject({ code: "blob_not_found" });
  });

  it("exposes workspace paths, notes and artifact links through the admin surface", async () => {
    const { a, b } = await startPair();
    const { admin } = podOver(b);
    writeFileSync(join(admin.workspace()!.notes, "STATUS.md"), "handoff notes");

    const workspace = admin.workspace()!;
    expect(workspace.notes_files).toEqual(["STATUS.md"]);

    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, {
      message: text("produce an artifact"),
      metadata: ARTIFACT,
    });
    const rows = await waitFor(
      () => admin.recent(10),
      (list: PodTaskRow[]) => list.some((row) => row.id === submitted.id && isTerminal(row.state)),
      { label: "artifact task completes" },
    );
    const row = rows.find((entry) => entry.id === submitted.id)!;
    expect(row).toMatchObject({
      peer: b.profile.endpoints[0],
      cancellable: false,
      who: a.profile.record().display_name,
    });
    expect(row.artifacts).toEqual([{ name: "out.txt", blob_id: expect.any(String), bytes: 5, node: b.orcaNodeId }]);
    // The panel saves it through this node.
    const artifact = row.artifacts[0]!;
    expect(await readAll((await admin.blob(b.orcaNodeId, artifact.blob_id)).stream)).toBe("hello");

    expect(admin.members().map((peer) => peer.orca_node_id)).toContain(a.orcaNodeId);
  });

  it("merges local tasks and dispatches into one list and tells where each can be cancelled", async () => {
    const { a, b } = await startPair();
    const { admin: adminA } = podOver(a);
    const { admin: adminB } = podOver(b);

    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, {
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
      peer: b.profile.endpoints[0],
      who: b.profile.record().display_name,
      cancellable: true,
      artifacts: [],
    });

    // The target runs it locally: the row addresses its own URL, and a call there works.
    const local = adminB.recent(10).find((row) => row.id === submitted.id)!;
    expect(local.peer).toBe(b.profile.endpoints[0]);
    expect(adminB.recent(10).filter((row) => row.id === submitted.id)).toHaveLength(1);
    const detail = await adminB.task(local.peer, local.id);
    expect(detail).toMatchObject({ origin: a.profile.record().display_name, dispatch: null });
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
    const { admin: adminA } = podOver(a);
    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, {
      message: text("produce an artifact"),
      metadata: ARTIFACT,
    });
    await waitFor(
      () => b.tasks.list(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes on b" },
    );

    const detail = await adminA.task(b.profile.endpoints[0]!, submitted.id);
    expect(detail.task.id).toBe(submitted.id);
    expect(detail.dispatch).toMatchObject({ task_id: submitted.id, peer: b.profile.endpoints[0] });
    expect(detail.artifacts).toEqual([{ name: "out.txt", blob_id: expect.any(String), bytes: 5, node: b.orcaNodeId }]);
    expect(detail.origin).toBe(a.profile.record().display_name);
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
    vi.spyOn(b.delegation, "getTask").mockResolvedValue(suspended);
    const { tracker, admin } = podOver(b, { intervalMs: 20 });
    tracker.track(
      { id: SessionId("agent-1"), status: "idle", inject() {}, followup() {} } as unknown as Agent,
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
    tracker.stop();

    // Approving a task that is not blocked on a permission request is reported.
    const submitted = await a.delegation.sendTask(b.profile.endpoints[0]!, { message: text("finished quickly") });
    await waitFor(
      () => b.tasks.list(),
      (tasks) => tasks.some((task) => task.id === submitted.id && isTerminal(task.status.state)),
      { label: "task completes" },
    );
    await expect(admin.approve(b.profile.endpoints[0]!, submitted.id)).rejects.toThrow(/no pending permission request/);
  });
});
