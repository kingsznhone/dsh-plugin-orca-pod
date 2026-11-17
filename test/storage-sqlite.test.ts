import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSqliteTaskStore } from "../src/storage/sqlite.ts";
import type { PersistedTask } from "../src/storage/stores.ts";
import { createTestRunner } from "./fixtures/runner.ts";
import { labelId } from "./fixtures/ids.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-sqlite-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storedTask(state: PersistedTask["view"]["status"]["state"], id = "TASK0001"): PersistedTask {
  const at = new Date().toISOString();
  return {
    view: {
      kind: "task",
      id,
      contextId: "CTX1",
      status: { state, timestamp: at },
      metadata: {},
    },
    origin_orca_node: labelId("ORIGIN"),
    created_at: at,
    updated_at: at,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("sqlite task store", () => {
  it("persists records across close and reopen", () => {
    const path = join(tempDir(), "tasks.db");
    const first = createSqliteTaskStore(path);
    first.save(storedTask("completed"));
    first.close();

    const second = createSqliteTaskStore(path);
    expect(second.load("TASK0001")?.view.status.state).toBe("completed");
    expect(second.list()).toHaveLength(1);
    second.close();
  });

  it("keeps a completed task readable from a new runner", async () => {
    const path = join(tempDir(), "tasks.db");
    const store = createSqliteTaskStore(path);
    const runner = createTestRunner({ store });
    const view = runner.submit({
      message: { role: "user", parts: [{ kind: "text", text: "persist me" }] },
      metadata: { echo: { final: { state: "completed", text: "persisted" } } },
    });
    await waitFor(() => runner.get(view.id)?.status.state === "completed");

    const reopenedStore = createSqliteTaskStore(path);
    const reopened = createTestRunner({ store: reopenedStore });
    expect(reopened.get(view.id)?.status.state).toBe("completed");
    reopenedStore.close();
    store.close();
  });

  it("fails unfinished tasks as node_restart on recover", () => {
    const path = join(tempDir(), "tasks.db");
    const store = createSqliteTaskStore(path);
    store.save(storedTask("working", "WORKING1"));
    store.save(storedTask("completed", "DONE1"));

    const runner = createTestRunner({ store });
    expect(runner.recover()).toBe(1);

    const failed = runner.get("WORKING1");
    expect(failed?.status.state).toBe("failed");
    expect(failed?.status.reason).toBe("node_restart");
    expect(runner.get("DONE1")?.status.state).toBe("completed");
    store.close();
  });
});
