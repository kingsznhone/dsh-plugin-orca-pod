/**
 * Task inputs (§6.7): a task's attachments are blobs the origin uploaded
 * before creating the task. The target materializes them under
 * `<workspace>/inputs/<task_id>/` before the executor starts, lists them in the
 * prompt as cwd-relative paths, and deletes the directory when the task ends.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "../src/executor.ts";
import type { TaskRunner, TaskView } from "../src/protocol.ts";
import { createMemoryBlobStore } from "../src/storage.ts";
import { createTaskRunner } from "../src/tasks.ts";
import { createWorkspaceManager } from "../src/workspace.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-inputs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function message(text = "use the files") {
  return { role: "user" as const, parts: [{ kind: "text" as const, text }] };
}

/** Executor that records the prompt and the files it can see while running. */
function recordingExecutor(seen: Record<string, string>): LocalExecutor {
  return {
    async *run(input: ExecuteInput): AsyncGenerator<ExecutorEvent, void, unknown> {
      for (const name of ["alpha.txt", "beta.txt"]) {
        const path = join(input.workspaceDir as string, "inputs", input.taskId, name);
        if (existsSync(path)) seen[name] = readFileSync(path, "utf8");
      }
      yield { type: "completed", text: "read them" };
    },
  };
}

async function waitForTerminal(runner: TaskRunner, taskId: string, timeoutMs = 5_000): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = runner.get(taskId);
    if (view && ["completed", "failed", "canceled"].includes(view.status.state)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for a terminal task");
}

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("task inputs", () => {
  it("materializes attachments before the run, lists them in the prompt, then deletes them", async () => {
    const dataRoot = tempDir();
    const workspace = createWorkspaceManager({ dataRoot, workgroupId: "inputs-test" }).ensure();
    const blobs = createMemoryBlobStore();
    const alpha = blobs.put(Buffer.from("alpha"), { name: "alpha.txt" });
    const beta = blobs.put(Buffer.from("beta"), { name: "beta.txt" });
    const seen: Record<string, string> = {};
    const prompts: string[] = [];
    const runner = createTaskRunner({
      executor: {
        async *run(input: ExecuteInput): AsyncGenerator<ExecutorEvent, void, unknown> {
          prompts.push(input.prompt ?? "");
          for (const name of ["alpha.txt", "beta.txt"]) {
            const path = join(input.workspaceDir as string, "inputs", input.taskId, name);
            if (existsSync(path)) seen[name] = readFileSync(path, "utf8");
          }
          yield { type: "completed", text: "read them" };
        },
      },
      blobs,
      workspace,
    });

    const view = runner.submit({
      message: message(),
      metadata: {
        pod: {
          inputs: [
            { blob_id: alpha.blob_id, name: "alpha.txt" },
            { blob_id: beta.blob_id, name: "beta.txt" },
          ],
        },
      },
    });
    const done = await waitForTerminal(runner, view.id);

    expect(done.status.state).toBe("completed");
    expect(seen).toEqual({ "alpha.txt": "alpha", "beta.txt": "beta" });
    const prompt = prompts[0] as string;
    expect(prompt).toContain(`- inputs/${view.id}/alpha.txt`);
    expect(prompt).toContain(`- inputs/${view.id}/beta.txt`);
    expect(prompt).toContain("deleted when the task ends");
    // The materialized directory is gateway-owned and gone once the task ends.
    expect(existsSync(join(workspace.inputs, view.id))).toBe(false);
  });

  it("rejects duplicate names before creating a task", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "inputs-test" }).ensure();
    const blobs = createMemoryBlobStore();
    const blob = blobs.put(Buffer.from("x"), { name: "same.txt" });
    const runner = createTaskRunner({ executor: recordingExecutor({}), blobs, workspace });

    expect(
      errorCode(() =>
        runner.submit({
          message: message(),
          metadata: {
            pod: {
              inputs: [
                { blob_id: blob.blob_id, name: "same.txt" },
                { blob_id: blob.blob_id, name: "same.txt" },
              ],
            },
          },
        }),
      ),
    ).toBe("duplicate_input_name");
    expect(runner.busy()).toBeNull();
  });

  it("rejects unsafe input names", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "inputs-test" }).ensure();
    const blobs = createMemoryBlobStore();
    const blob = blobs.put(Buffer.from("x"), { name: "x.txt" });
    const runner = createTaskRunner({ executor: recordingExecutor({}), blobs, workspace });

    for (const name of ["../escape.txt", "a/b.txt", ".hidden", ""]) {
      expect(
        errorCode(() =>
          runner.submit({ message: message(), metadata: { pod: { inputs: [{ blob_id: blob.blob_id, name }] } } }),
        ),
      ).toBe("bad_request");
    }
  });

  it("enforces the local file-count limit", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "inputs-test" }).ensure();
    const blobs = createMemoryBlobStore();
    const blob = blobs.put(Buffer.from("x"), { name: "x.txt" });
    const runner = createTaskRunner({ executor: recordingExecutor({}), blobs, workspace, maxInputFiles: 1 });

    expect(
      errorCode(() =>
        runner.submit({
          message: message(),
          metadata: {
            pod: {
              inputs: [
                { blob_id: blob.blob_id, name: "one.txt" },
                { blob_id: blob.blob_id, name: "two.txt" },
              ],
            },
          },
        }),
      ),
    ).toBe("too_many_inputs");
  });

  it("enforces the local byte limit before writing anything", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "inputs-test" }).ensure();
    const blobs = createMemoryBlobStore();
    const blob = blobs.put(Buffer.from("0123456789"), { name: "big.txt" });
    const runner = createTaskRunner({ executor: recordingExecutor({}), blobs, workspace, maxInputBytes: 5 });

    expect(
      errorCode(() =>
        runner.submit({ message: message(), metadata: { pod: { inputs: [{ blob_id: blob.blob_id, name: "big.txt" }] } } }),
      ),
    ).toBe("inputs_too_large");
    expect(readdirSync(workspace.inputs)).toEqual([]);
  });

  it("fails the submit when a referenced blob is gone", () => {
    const workspace = createWorkspaceManager({ dataRoot: tempDir(), workgroupId: "inputs-test" }).ensure();
    const runner = createTaskRunner({ executor: recordingExecutor({}), blobs: createMemoryBlobStore(), workspace });

    expect(
      errorCode(() =>
        runner.submit({
          message: message(),
          metadata: { pod: { inputs: [{ blob_id: "a".repeat(64), name: "gone.txt" }] } },
        }),
      ),
    ).toBe("input_blob_missing");
    expect(runner.busy()).toBeNull();
  });
});
