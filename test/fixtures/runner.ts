import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { DEFAULT_RESULT_MAX_BYTES, DEFAULT_TASK_TIMEOUT_S } from "../../src/core/constants.ts";
import { SqliteDb, storeDbPath } from "../../src/core/sqlite.ts";
import type { OrcaNodeId } from "../../src/core/wire/peer.ts";
import { EchoExecutor } from "../../src/executor/echo.ts";
import type { LocalExecutor } from "../../src/executor/executor.ts";
import { SingleSlotTaskRunner } from "../../src/task/runner.ts";
import type { SubmitTaskInput, TaskView } from "../../src/task/wire.ts";
import { Workspace } from "../../src/task/workspace.ts";
import { labelId, wg } from "./ids.ts";

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
  const db = new SqliteDb(storeDbPath(dataRoot));
  db.open();
  dbs.push(db);
  return db;
}

export const SELF = labelId("SELF");
export const ORIGIN = labelId("ORIGIN");

/** What a task runner is built from, flat: its collaborators and its options. */
export type RunnerSetup = ConstructorParameters<typeof SingleSlotTaskRunner>[3] & {
  executor: LocalExecutor;
  db: SqliteDb;
  workspace: Workspace;
};

/** A runner setup on a fresh temp workspace; override what a test cares about. */
export function runnerSetup(overrides: Partial<RunnerSetup> = {}): RunnerSetup {
  const dataRoot = tempDir();
  const workspace = new Workspace(dataRoot, wg("runner-test"));
  workspace.ensure();
  return {
    executor: new EchoExecutor(),
    db: openDb(dataRoot),
    workspace,
    logger: { warn() {} },
    selfOrcaNodeId: SELF,
    workgroupId: wg("runner-test"),
    taskTimeoutS: DEFAULT_TASK_TIMEOUT_S,
    resultMaxBytes: DEFAULT_RESULT_MAX_BYTES,
    maxWorkspaceBytes: 1024 ** 3,
    maxWorkspaceFiles: 100_000,
    ...overrides,
  };
}

/** A runner whose caller defaults to `ORIGIN`, as the gateway would stamp it. */
export class TestRunner extends SingleSlotTaskRunner {
  override submit(input: SubmitTaskInput & { originOrcaNode?: OrcaNodeId }): TaskView {
    return super.submit({ originOrcaNode: ORIGIN, ...input });
  }
}

/** A real runner; it is not started, so nothing measures the workspace until a test calls `start()`. */
export function createTestRunner(overrides: Partial<RunnerSetup> = {}): TestRunner {
  const setup = runnerSetup(overrides);
  return new TestRunner(setup.executor, setup.db, setup.workspace, setup);
}
