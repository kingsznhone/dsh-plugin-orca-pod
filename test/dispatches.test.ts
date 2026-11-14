import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import type { DispatchEntry } from "../src/dispatches.ts";
import { createOrcaNode, createPersistentStorage, type OrcaNode } from "../src/orca_node.ts";
import { createSqliteDispatchStore } from "../src/sqlite.ts";

const WORKGROUP = "orca-dispatches";
const PASSWORD = "dispatch-secret";

let nodes: OrcaNode[] = [];
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function entry(overrides: Partial<DispatchEntry> & Pick<DispatchEntry, "task_id" | "state">): DispatchEntry {
  const now = new Date().toISOString();
  return { peer: "http://127.0.0.1:9", created_at: now, updated_at: now, ...overrides };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-dispatches-"));
  roots.push(root);
  return root;
}

describe("dispatch store (13.4)", () => {
  it("survives a reopen and keeps the parent link", () => {
    const file = join(tempRoot(), "tasks.db");
    const store = createSqliteDispatchStore(file);
    store.save(entry({ task_id: "task-1", state: "working", parent_local_task_id: "parent-1" }));
    store.save(entry({ task_id: "task-2", state: "completed" }));
    store.close();

    const reopened = createSqliteDispatchStore(file);
    const byId = new Map(reopened.list().map((item) => [item.task_id, item]));
    expect(byId.get("task-1")).toMatchObject({ state: "working", parent_local_task_id: "parent-1" });
    expect(byId.get("task-2")).toMatchObject({ state: "completed" });
    expect(reopened.get("task-1")?.peer).toBe("http://127.0.0.1:9");
    reopened.close();
  });

  it("marks only in-flight entries unknown on restart", () => {
    const file = join(tempRoot(), "tasks.db");
    const store = createSqliteDispatchStore(file);
    store.save(entry({ task_id: "running", state: "working" }));
    store.save(entry({ task_id: "parked", state: "input-required" }));
    store.save(entry({ task_id: "done", state: "completed" }));
    store.save(entry({ task_id: "failed", state: "failed" }));

    expect(store.markUnknown()).toBe(2);
    expect(store.get("running")).toMatchObject({ state: "unknown", last_error: "origin_restart" });
    expect(store.get("parked")?.state).toBe("unknown");
    expect(store.get("done")?.state).toBe("completed");
    expect(store.get("failed")?.state).toBe("failed");
    store.close();
  });

  it("removes entries", () => {
    const store = createSqliteDispatchStore(join(tempRoot(), "tasks.db"));
    store.save(entry({ task_id: "task-1", state: "working" }));
    store.remove?.("task-1");
    expect(store.list()).toEqual([]);
    store.close();
  });
});

describe("origin dispatch log (13.4)", () => {
  it("records a dispatched task and its last known state", async () => {
    const peerRoot = tempRoot();
    const peerConfig = createOrcaNodeConfig({
      workgroupId: WORKGROUP,
      password: PASSWORD,
      dataRoot: peerRoot,
      host: "127.0.0.1",
      port: 0,
    });
    const peer = createOrcaNode({ config: peerConfig });
    await peer.start();
    nodes.push(peer);

    const originRoot = tempRoot();
    const originConfig = createOrcaNodeConfig({
      workgroupId: WORKGROUP,
      password: PASSWORD,
      dataRoot: originRoot,
      host: "127.0.0.1",
      port: 0,
    });
    let origin = createOrcaNode({ config: originConfig, storage: createPersistentStorage(originConfig) });
    await origin.start();
    nodes.push(origin);
    await origin.join(peer.endpoint);

    const view = await origin.sendTask(peer.endpoint, {
      message: { role: "user", parts: [{ kind: "text", text: "slow echo" }] },
      metadata: {
        echo: {
          steps: [{ at_ms: 30, suspend: { kind: "permission", tool: "write_file", requested: {} } }],
          final: { state: "completed", text: "done" },
        },
      },
    });

    const deadline = Date.now() + 5000;
    let record = origin.listDispatches().find((item) => item.task_id === view.id);
    while (record === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      record = origin.listDispatches().find((item) => item.task_id === view.id);
    }
    expect(record).toMatchObject({ peer: peer.endpoint, state: "working" });

    // Restart the origin: in-flight dispatches become unknown, never "failed".
    await origin.stop();
    nodes = nodes.filter((node) => node !== origin);
    origin = createOrcaNode({ config: originConfig, storage: createPersistentStorage(originConfig) });
    await origin.start();
    nodes.push(origin);

    const recovered = origin.listDispatches().find((item) => item.task_id === view.id);
    expect(recovered).toMatchObject({ state: "unknown", last_error: "origin_restart", peer: peer.endpoint });
  });
});
