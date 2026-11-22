import { SessionId } from "@deepseek-ai/dsh-session";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DispatchLog } from "../src/task/dispatch-log.ts";
import { nodeParts } from "./support/node.ts";
import type { TaskView } from "../src/task/wire.ts";
import { Orca } from "../src/node/orca.ts";
import { SqliteDb } from "../src/core/sqlite.ts";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import { ScriptExecutor, scriptMessage } from "./support/script.ts";

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

function view(id: string, state: TaskView["status"]["state"]): TaskView {
  return { kind: "task", id, contextId: `ctx-${id}`, status: { state, timestamp: new Date().toISOString() } };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-dispatches-"));
  roots.push(root);
  return root;
}

/** The dispatch log of the database at `file`, the way a node process opens it. */
function logAt(file: string): { log: DispatchLog; db: SqliteDb } {
  const db = new SqliteDb(file);
  db.open();
  return { log: new DispatchLog(db), db };
}

describe("dispatch log on disk (design.md 4.2)", () => {
  it("survives a reopen, with the node and the dispatching session", () => {
    const file = join(tempRoot(), "tasks.db");
    const first = logAt(file);
    first.log.recordSend(NODE, view("task-1", "working"), SessionId("session-7"));
    first.log.recordSend(NODE, view("task-2", "completed"));
    first.db.close();

    const reopened = logAt(file);
    const byId = new Map(reopened.log.list().map((item) => [item.task_id, item]));
    expect(byId.get("task-1")).toMatchObject({ state: "working", node: NODE, agent_id: "session-7" });
    expect(byId.get("task-2")).toMatchObject({ state: "completed" });
    reopened.db.close();
  });

  it("marks only in-flight entries unknown on restart", () => {
    const { log, db } = logAt(join(tempRoot(), "tasks.db"));
    for (const [id, state] of [
      ["running", "working"],
      ["parked", "input-required"],
      ["done", "completed"],
      ["failed", "failed"],
    ] as const) {
      log.recordSend(NODE, view(id, state));
    }
    log.markInFlightUnknown();
    const byId = new Map(log.list().map((item) => [item.task_id, item]));
    expect(byId.get("running")).toMatchObject({ state: "unknown", last_error: "origin_restart" });
    expect(byId.get("parked")?.state).toBe("unknown");
    expect(byId.get("done")?.state).toBe("completed");
    expect(byId.get("failed")?.state).toBe("failed");
    db.close();
  });

  it("creates SQLite indexes and serves recent dispatches with default limit 10, paging and filters", () => {
    const file = join(tempRoot(), "tasks.db");
    const { log, db } = logAt(file);
    const otherNode = fakeNodeId("dispatch-other");

    for (let i = 1; i <= 15; i += 1) {
      const id = `task-${String(i).padStart(2, "0")}`;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const target = i % 2 === 0 ? otherNode : NODE;
      const state = i === 15 ? "working" : i % 3 === 0 ? "failed" : "completed";
      log.recordSend(target, view(id, state));
      // Pin distinct timestamps so ordering and `before` cursor pagination are deterministic.
      db.db
        .prepare(
          "UPDATE dispatches SET payload = json_set(payload, '$.updated_at', ?), updated_at = ? WHERE task_id = ?",
        )
        .run(ts, ts, id);
    }

    // Default limit is 10, newest first.
    const firstPage = log.recent();
    expect(firstPage).toHaveLength(10);
    expect(firstPage.map((item) => item.task_id)).toEqual([
      "task-15",
      "task-14",
      "task-13",
      "task-12",
      "task-11",
      "task-10",
      "task-09",
      "task-08",
      "task-07",
      "task-06",
    ]);

    // Cursor pagination (`before`) fetches older records beyond the default 10.
    const older = log.recent(10, { before: firstPage.at(-1)!.updated_at });
    expect(older.map((item) => item.task_id)).toEqual(["task-05", "task-04", "task-03", "task-02", "task-01"]);

    // Point lookup and filters (`state`, `node`).
    expect(log.get("task-03")).toMatchObject({ task_id: "task-03", state: "failed", node: NODE });
    expect(log.get("missing")).toBeUndefined();
    expect(log.recent(10, { state: "failed" }).map((item) => item.task_id)).toEqual([
      "task-12",
      "task-09",
      "task-06",
      "task-03",
    ]);
    expect(log.recent(5, { node: otherNode }).map((item) => item.task_id)).toEqual([
      "task-14",
      "task-12",
      "task-10",
      "task-08",
      "task-06",
    ]);

    // Verify secondary and partial indexes exist and SQLite query planner uses them.
    const indexes = (
      db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dispatches'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain("idx_dispatches_updated_at");
    expect(indexes).toContain("idx_dispatches_open");

    const recentPlan = (
      db.db
        .prepare("EXPLAIN QUERY PLAN SELECT payload FROM dispatches ORDER BY updated_at DESC, task_id DESC LIMIT 10")
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" ");
    expect(recentPlan).toContain("idx_dispatches_updated_at");

    const openPlan = (
      db.db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT payload FROM dispatches WHERE json_extract(payload, '$.state') NOT IN ('completed', 'failed', 'canceled') ORDER BY updated_at",
        )
        .all() as Array<{ detail: string }>
    )
      .map((row) => row.detail)
      .join(" ");
    expect(openPlan).toContain("idx_dispatches_open");
    db.close();
  });
});

describe("origin dispatch log (design.md 4.2)", () => {
  it("records a dispatched task and its last known state", async () => {
    const peerRoot = tempRoot();
    const peerConfig = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: peerRoot,
      bind_host: "127.0.0.1",
      port: 0,
    });
    const peer = new Orca(...peerConfig, { executor: new ScriptExecutor() });
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
    let origin = new Orca(...originConfig);
    await origin.start();
    nodes.push(origin);
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);

    const view = await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).sendTask(
      {
        message: scriptMessage({
          steps: [{ at_ms: 30, suspend: { tool: "write_file", requested: {} } }],
          final: { state: "completed", text: "done" },
        }),
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
    expect(record).toMatchObject({ node: peer.mesh.self.id, agent_id: "session-1" });
    expect(["submitted", "working"]).toContain(record?.state);

    // Restart the origin: in-flight dispatches become unknown, never "failed".
    await origin.stop();
    nodes = nodes.filter((node) => node !== origin);
    origin = new Orca(...originConfig);
    await origin.start();
    nodes.push(origin);

    const recovered = origin.dispatches.list().find((item) => item.task_id === view.id);
    expect(recovered).toMatchObject({
      state: "unknown",
      last_error: "origin_restart",
      node: peer.mesh.self.id,
      agent_id: "session-1",
    });
  });
});
