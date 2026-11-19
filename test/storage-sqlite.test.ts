import { describe, expect, it } from "vitest";

import { SqliteDb } from "../src/core/sqlite.ts";
import { storeDbPath } from "../src/node/orca.ts";
import { createTestRunner, tempDir, type TestRunner } from "./fixtures/runner.ts";

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A runner over the database of `root`, the way a node process opens it. */
function runnerOn(root: string): { runner: TestRunner; db: SqliteDb } {
  const db = new SqliteDb(storeDbPath(root));
  db.open();
  return { runner: createTestRunner({ db }), db };
}

const task = (text: string, state: "completed" | "hang") => ({
  message: { role: "user" as const, parts: [{ kind: "text" as const, text }] },
  metadata: { echo: { final: { state, text } } },
});

describe("the task table", () => {
  it("keeps a finished task readable from the next process", async () => {
    const root = tempDir("orca-sqlite-");
    const first = runnerOn(root);
    const view = first.runner.submit(task("persist me", "completed"));
    await waitFor(() => first.runner.get(view.id)?.status.state === "completed");
    first.db.close();

    const second = runnerOn(root);
    expect(second.runner.get(view.id)?.status.state).toBe("completed");
    expect(second.runner.list(10).map((stored) => stored.id)).toEqual([view.id]);
    second.db.close();
  });

  it("fails what the last process left unfinished as node_restart, and leaves what ended", async () => {
    const root = tempDir("orca-sqlite-");
    const first = runnerOn(root);
    const done = first.runner.submit(task("done", "completed"));
    await waitFor(() => first.runner.get(done.id)?.status.state === "completed");
    const working = first.runner.submit(task("never ends", "hang"));
    await waitFor(() => first.runner.get(working.id)?.status.state === "working");
    // The process goes away with the task still working.
    first.db.close();

    const second = runnerOn(root);
    second.runner.start();
    expect(second.runner.get(working.id)?.status).toMatchObject({ state: "failed", reason: "node_restart" });
    expect(second.runner.get(done.id)?.status.state).toBe("completed");
    second.db.close();
  });
});
