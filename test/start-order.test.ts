/**
 * Binding the port is the first thing a node does (§3.9): it is the lock that
 * keeps a second process on this machine away from the data root. A process that
 * cannot bind must not have touched what the running one keeps there.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteDb, storeDbPath } from "../src/core/sqlite.ts";
import type { Orca } from "../src/node/orca.ts";
import { SqliteTaskStore } from "../src/task/task-store.ts";
import { wg } from "./fixtures/ids.ts";
import { waitFor } from "./support/harness.ts";
import { newNode } from "./support/node.ts";

let nodes: Orca[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("starting a node on a data root another process is running on", () => {
  it("fails on the port and leaves the running process's tasks and dispatches as they are", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-start-order-"));
    roots.push(root);
    const input = { workgroup_id: wg("start-order"), workgroup_password: "pw", data_root: root, port: 0 };

    const running = newNode(input, { persistent: true });
    nodes.push(running);
    const { port, url } = await running.start();

    // A task of the running process, still working.
    const submitted = await running.mesh.resolve(url).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitFor(
      () => running.tasks.get(submitted.id)?.status.state,
      (state) => state === "working",
      { label: "the task to be working" },
    );

    // Another process of the same machine: same data root, same port.
    const second = newNode({ ...input, port }, { persistent: true });
    nodes.push(second);
    await expect(second.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    await second.stop();

    // What the running process keeps in the database is untouched: the task was not
    // failed as "interrupted by a restart", and its dispatch was not marked unknown.
    const db = new SqliteDb(storeDbPath(root));
    db.open();
    try {
      expect(new SqliteTaskStore(db).load(submitted.id)?.view.status.state).toBe("working");
    } finally {
      db.close();
    }
    expect(running.tasks.get(submitted.id)?.status.state).toBe("working");
  });
});
