import { SessionId } from "@deepseek-ai/dsh-session";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../src/core/events.ts";
import { DispatchLog } from "../src/task/dispatch-log.ts";
import { nodeParts } from "./support/node.ts";
import type { DispatchEntry } from "../src/task/wire.ts";
import { Orca } from "../src/node/orca.ts";
import { SqliteDb } from "../src/core/sqlite.ts";
import { SqliteDispatchStore } from "../src/task/dispatch-store.ts";
import { fakeNodeId, wg } from "./fixtures/ids.ts";

const WORKGROUP = wg("orca-dispatches");
const PASSWORD = "dispatch-secret";

let nodes: Orca[] = [];
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const NODE = fakeNodeId("dispatch-target");

function entry(overrides: Partial<DispatchEntry> & Pick<DispatchEntry, "task_id" | "state">): DispatchEntry {
  const now = new Date().toISOString();
  return { node: NODE, created_at: now, updated_at: now, ...overrides };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-dispatches-"));
  roots.push(root);
  return root;
}

describe("dispatch store (13.4)", () => {
  it("survives a reopen", () => {
    const file = join(tempRoot(), "tasks.db");
    const db = new SqliteDb(file);
    db.open();
    const store = new SqliteDispatchStore(db);
    store.save(entry({ task_id: "task-1", state: "working" }));
    store.save(entry({ task_id: "task-2", state: "completed" }));
    db.close();

    const reopenedDb = new SqliteDb(file);

    reopenedDb.open();
    const reopened = new SqliteDispatchStore(reopenedDb);
    const byId = new Map(reopened.list().map((item) => [item.task_id, item]));
    expect(byId.get("task-1")).toMatchObject({ state: "working" });
    expect(byId.get("task-2")).toMatchObject({ state: "completed" });
    expect(reopened.get("task-1")?.node).toBe(NODE);
    reopenedDb.close();
  });

  it("persists the dispatching agent so tracking can resume after a restart", () => {
    const file = join(tempRoot(), "tasks.db");
    const db = new SqliteDb(file);
    db.open();
    const store = new SqliteDispatchStore(db);
    store.save(entry({ task_id: "task-1", state: "working", agent_id: SessionId("session-7") }));
    db.close();

    const reopenedDb = new SqliteDb(file);

    reopenedDb.open();
    const reopened = new SqliteDispatchStore(reopenedDb);
    expect(reopened.get("task-1")?.agent_id).toBe("session-7");
    reopenedDb.close();
  });

  it("marks only in-flight entries unknown on restart", () => {
    const file = join(tempRoot(), "tasks.db");
    const db = new SqliteDb(file);
    db.open();
    const store = new SqliteDispatchStore(db);
    store.save(entry({ task_id: "running", state: "working" }));
    store.save(entry({ task_id: "parked", state: "input-required" }));
    store.save(entry({ task_id: "done", state: "completed" }));
    store.save(entry({ task_id: "failed", state: "failed" }));

    new DispatchLog(store, new EventBus()).markInFlightUnknown();
    expect(store.get("running")).toMatchObject({ state: "unknown", last_error: "origin_restart" });
    expect(store.get("parked")?.state).toBe("unknown");
    expect(store.get("done")?.state).toBe("completed");
    expect(store.get("failed")?.state).toBe("failed");
    db.close();
  });
});

describe("origin dispatch log (13.4)", () => {
  it("records a dispatched task and its last known state", async () => {
    const peerRoot = tempRoot();
    const peerConfig = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: peerRoot,
      bind_host: "127.0.0.1",
      port: 0,
    });
    const peer = new Orca(...peerConfig);
    await peer.start();
    nodes.push(peer);

    const originRoot = tempRoot();
    const originConfig = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: originRoot,
      bind_host: "127.0.0.1",
      port: 0,
    });
    let origin = new Orca(...originConfig, { persistent: true });
    await origin.start();
    nodes.push(origin);
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);

    const view = await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).sendTask(
      {
        message: { role: "user", parts: [{ kind: "text", text: "slow echo" }] },
        metadata: {
          echo: {
            steps: [{ at_ms: 30, suspend: { kind: "permission", tool: "write_file", requested: {} } }],
            final: { state: "completed", text: "done" },
          },
        },
      },
      { agentId: SessionId("session-1") },
    );

    const deadline = Date.now() + 5000;
    let record = origin.dispatches.list().find((item) => item.task_id === view.id);
    while (record === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      record = origin.dispatches.list().find((item) => item.task_id === view.id);
    }
    // The target answers `submitted` while it prepares the task, `working` once the executor runs.
    // The dispatching session is written with the entry, not added afterwards.
    expect(record).toMatchObject({ node: peer.orcaNodeId, agent_id: "session-1" });
    expect(["submitted", "working"]).toContain(record?.state);

    // Restart the origin: in-flight dispatches become unknown, never "failed".
    await origin.stop();
    nodes = nodes.filter((node) => node !== origin);
    origin = new Orca(...originConfig, { persistent: true });
    await origin.start();
    nodes.push(origin);

    const recovered = origin.dispatches.list().find((item) => item.task_id === view.id);
    expect(recovered).toMatchObject({
      state: "unknown",
      last_error: "origin_restart",
      node: peer.orcaNodeId,
      agent_id: "session-1",
    });
  });
});
