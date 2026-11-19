import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { SqliteDb } from "../../src/core/sqlite.ts";
import type { OrcaNodeId } from "../../src/core/ids.ts";
import type { LocalExecutor } from "../../src/executor/executor.ts";
import type { NodeLogger } from "../../src/core/events.ts";
import { TaskSettingsSchema, type TaskSettings } from "../../src/task/record.ts";
import { SingleSlotTaskRunner } from "../../src/task/runner.ts";
import type { SubmitTaskInput, TaskView } from "../../src/task/wire.ts";
import { Workspace } from "../../src/task/workspace.ts";
import { labelId, wg } from "./ids.ts";
import { ScriptExecutor } from "../support/script.ts";

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

afterEach(() => {
  // Close before removing: Windows keeps an open database file.
  for (const db of dbs.splice(0)) db.close();
  // Windows releases SQLite handles asynchronously, so a plain rm can fail here; retrying
  // keeps the failure visible as an afterEach error instead of leaking the directory.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

export function tempDir(prefix = "orca-runner-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The database of a data root, open; it is closed after the test. */
export function openDb(dataRoot: string = tempDir("orca-db-")): SqliteDb {
  const db = new SqliteDb(join(dataRoot, "tasks.db"));
  db.open();
  dbs.push(db);
  return db;
}

export const SELF = labelId("SELF");
export const ORIGIN = labelId("ORIGIN");

/** What a task runner is built from: its collaborators and the node's task settings. */
export type RunnerSetup = {
  executor: LocalExecutor;
  db: SqliteDb;
  workspace: Workspace;
  settings: TaskSettings;
  logger: NodeLogger;
};

/** What a test may set: any collaborator, and any task setting (the rest take their defaults). */
type RunnerOverrides = Partial<Omit<RunnerSetup, "settings">> & { settings?: Partial<TaskSettings> };

/** A runner setup on a fresh temp workspace; override what a test cares about. */
export function runnerSetup(overrides: RunnerOverrides = {}): RunnerSetup {
  const dataRoot = tempDir();
  const workspace = new Workspace(dataRoot, wg("runner-test"));
  workspace.ensure();
  return {
    executor: new ScriptExecutor(),
    db: openDb(dataRoot),
    workspace,
    logger: { warn() {} },
    ...overrides,
    settings: TaskSettingsSchema.parse({
      max_workspace_bytes: 1024 ** 3,
      max_workspace_files: 100_000,
      ...overrides.settings,
    }),
  };
}

/** A runner whose caller defaults to `ORIGIN`, as the gateway would stamp it. */
export class TestRunner extends SingleSlotTaskRunner {
  override submit(input: SubmitTaskInput, origin: OrcaNodeId = ORIGIN): TaskView {
    return super.submit(input, origin);
  }

  override cancel(taskId: string, caller: OrcaNodeId = ORIGIN): TaskView {
    return super.cancel(taskId, caller);
  }
}

/** A real runner; it is not started, so nothing measures the workspace until a test calls `start()`. */
export function createTestRunner(overrides: RunnerOverrides = {}): TestRunner {
  const { executor, db, workspace, settings, logger } = runnerSetup(overrides);
  return new TestRunner(executor, db, workspace, settings, SELF, logger);
}
