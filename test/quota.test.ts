/**
 * Quotas and sweeps (§6.13, §5.6): a task is refused while the group workspace
 * is over its quota, and the node sweeps its blob store on a timer.
 */

import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PART_GRACE_MS } from "../src/storage/blobs.ts";
import { createOrcaNodeConfig } from "../src/node/config.ts";
import { BLOB_GC_INTERVAL_MS, createOrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import { createFsBlobStore } from "../src/storage/index.ts";
import { createTestRunner, runnerDeps } from "./fixtures/runner.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const message = { role: "user" as const, parts: [{ kind: "text" as const, text: "go" }] };

/** The workspace is measured in the background: retry until the runner has seen it. */
async function submitUntilRefused(submit: () => unknown): Promise<unknown> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      submit();
    } catch (error) {
      if ((error as { code?: string }).code === "quota_exceeded") return error;
      if ((error as { code?: string }).code !== "orca_node_busy") throw error;
    }
    if (Date.now() > deadline) throw new Error("the workspace was never refused");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("workspace quota", () => {
  it("refuses a new task while the workspace holds more bytes than its quota", async () => {
    const deps = runnerDeps({ maxWorkspaceBytes: 100 });
    writeFileSync(join(deps.workspace.root, "big.bin"), Buffer.alloc(500));
    const runner = createTestRunner(deps);

    const error = await submitUntilRefused(() => runner.submit({ message }));
    expect(error).toMatchObject({ code: "quota_exceeded", status: 507 });
    expect(runner.busy()).toBeNull();
  });

  it("refuses a new task while the workspace holds more files than its quota", async () => {
    const deps = runnerDeps({ maxWorkspaceFiles: 2 });
    for (const name of ["a", "b", "c"]) writeFileSync(join(deps.workspace.notes, name), "x");
    const runner = createTestRunner(deps);

    expect(await submitUntilRefused(() => runner.submit({ message }))).toMatchObject({ code: "quota_exceeded" });
  });

  it("measures again after a refusal, so cleaning up lifts it", async () => {
    const deps = runnerDeps({ maxWorkspaceFiles: 2 });
    const runner = createTestRunner(deps);
    const files = ["a", "b", "c"].map((name) => join(deps.workspace.notes, name));
    for (const file of files) writeFileSync(file, "x");
    await submitUntilRefused(() => runner.submit({ message }));

    for (const file of files) rmSync(file);
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const view = runner.submit({ message });
        expect(view.status.state).toBe("submitted");
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "quota_exceeded") throw error;
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  });

  it("counts what a finished task left behind", async () => {
    const runner = createTestRunner({
      maxWorkspaceFiles: 2,
      executor: {
        async *run(input) {
          for (const name of ["a", "b", "c"]) writeFileSync(join(input.workspaceDir, name), "x");
          yield { type: "completed", text: "wrote" };
        },
      },
    });
    const first = runner.submit({ message });
    expect(first.kind).toBe("task");

    expect(await submitUntilRefused(() => runner.submit({ message }))).toMatchObject({ code: "quota_exceeded" });
  });

  it("admits tasks while the workspace is within its quota", async () => {
    const deps = runnerDeps({ maxWorkspaceBytes: 1000, maxWorkspaceFiles: 10 });
    writeFileSync(join(deps.workspace.root, "small.txt"), "x");
    const runner = createTestRunner(deps);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(runner.submit({ message }).kind).toBe("task");
  });
});

describe("blob sweep", () => {
  it("runs on a timer owned by the node and stops with it", async () => {
    const root = mkdtempSync(join(tmpdir(), "orca-sweep-"));
    try {
      const config = createOrcaNodeConfig({
        workgroup_id: "sweep-test",
        workgroup_password: "pw",
        data_root: root,
        port: 0,
      });
      const storage = createPersistentStorage(config);
      const store = createFsBlobStore(join(root, "blobs"));
      const orphan = join(root, "blobs", ".upload-orphan.part");
      writeFileSync(orphan, "partial");
      const old = new Date(Date.now() - PART_GRACE_MS - 60_000);
      utimesSync(orphan, old, old);

      const timers: Array<() => void> = [];
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
        timers.push(callback);
        return { unref() {}, ref() {} } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval);
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

      const node = createOrcaNode({ config, storage: { ...storage, blobStore: store } });
      await node.start();
      // The startup sweep already removed the orphan; plant another and let the timer find it.
      const second = join(root, "blobs", ".upload-second.part");
      writeFileSync(second, "partial");
      utimesSync(second, old, old);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), BLOB_GC_INTERVAL_MS);
      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(second)).toBe(true);

      timers[0]!();
      expect(existsSync(second)).toBe(false);

      await node.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
