import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

import { EchoExecutor } from "../../src/execution/echo.ts";
import type { SubmitTaskInput, TaskRunner, TaskView } from "../../src/protocol/task.ts";
import { createMemoryBlobStore, createMemoryTaskStore } from "../../src/storage/memory.ts";
import { createTaskRunner, type TaskRunnerDeps } from "../../src/tasks/runner.ts";
import { createWorkspaceManager } from "../../src/tasks/workspace.ts";
import { labelId, wg } from "./ids.ts";
import type { OrcaNodeId } from "../../src/protocol/peer.ts";

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

/** Dependencies of a task runner on a fresh temp workspace; override what a test cares about. */
export function runnerDeps(overrides: Partial<TaskRunnerDeps> = {}): TaskRunnerDeps {
  const dataRoot = tempDir();
  return {
    executor: new EchoExecutor(),
    blobs: createMemoryBlobStore(),
    store: createMemoryTaskStore(),
    workspace: createWorkspaceManager({ dataRoot, workgroupId: wg("runner-test") }).ensure(),
    logger: { warn() {} },
    selfOrcaNodeId: SELF,
    workgroupId: wg("runner-test"),
    dataRoot,
    maxWorkspaceBytes: 1024 ** 3,
    maxWorkspaceFiles: 100_000,
    sendTaskMessage: async () => {},
    onEvent: () => {},
    ...overrides,
  };
}

export type TestRunner = Omit<TaskRunner, "submit"> & {
  /** The caller defaults to `ORIGIN`, as the gateway would stamp it. */
  submit(input: SubmitTaskInput & { originOrcaNode?: OrcaNodeId }): TaskView;
};

export function createTestRunner(overrides: Partial<TaskRunnerDeps> = {}): TestRunner {
  const runner = createTaskRunner(runnerDeps(overrides));
  return { ...runner, submit: (input) => runner.submit({ originOrcaNode: ORIGIN, ...input }) };
}
