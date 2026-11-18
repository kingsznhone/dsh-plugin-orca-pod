import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { DiskBlobRegistry, MemoryFileBlobStore, type FileBlobRegistry } from "../../src/core/blobs.ts";
import type { OrcaNodeId } from "../../src/core/wire/peer.ts";
import { EchoExecutor } from "../../src/executor/echo.ts";
import type { LocalExecutor } from "../../src/executor/executor.ts";
import { SingleSlotTaskRunner, type TaskRunnerOptions } from "../../src/task/runner.ts";
import { MemoryTaskStore, type TaskStore } from "../../src/task/task-store.ts";
import type { SubmitTaskInput, TaskView } from "../../src/task/wire.ts";
import { ensureWorkspace, workspacePathsOf, type WorkspacePaths } from "../../src/task/workspace.ts";
import { labelId, wg } from "./ids.ts";

const dirs: string[] = [];

afterEach(() => {
  // Windows releases SQLite handles asynchronously, so a plain rm can fail here; retrying
  // keeps the failure visible as an afterEach error instead of leaking the directory.
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

export function tempDir(prefix = "orca-runner-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

export const SELF = labelId("SELF");
export const ORIGIN = labelId("ORIGIN");

/** What a task runner is built from, flat: its collaborators and its options. */
export type RunnerSetup = TaskRunnerOptions & {
  executor: LocalExecutor;
  blobs: FileBlobRegistry;
  store: TaskStore;
  workspace: WorkspacePaths;
};

/** A runner setup on a fresh temp workspace; override what a test cares about. */
export function runnerSetup(overrides: Partial<RunnerSetup> = {}): RunnerSetup {
  const dataRoot = tempDir();
  const workspace = workspacePathsOf(dataRoot, wg("runner-test"));
  ensureWorkspace(workspace);
  return {
    executor: new EchoExecutor(),
    blobs: new DiskBlobRegistry(new MemoryFileBlobStore()),
    store: new MemoryTaskStore(),
    workspace,
    logger: { warn() {} },
    selfOrcaNodeId: SELF,
    workgroupId: wg("runner-test"),
    dataRoot,
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
  return new TestRunner(setup.executor, setup.blobs, setup.store, setup.workspace, setup);
}
