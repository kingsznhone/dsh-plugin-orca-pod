/**
 * The files of a task (§3.8): what the origin attaches is fetched into
 * `inbox/<task_id>/` before the agent starts; what the agent leaves in
 * `outbox/<task_id>/` is published when the task ends.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { blobRefText, type FetchBlob } from "../src/core/blobs.ts";
import { MAX_TASK_FILES } from "../src/core/constants.ts";
import type { ExecuteInput, ExecutorEvent, LocalExecutor } from "../src/executor/executor.ts";
import { isTerminal, PodTaskMetadataSchema, type TaskView } from "../src/task/wire.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { createTestRunner, runnerSetup, type TestRunner } from "./fixtures/runner.ts";

const PUBLISHER = fakeNodeId("publisher");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A member's file, served from memory: `fetchBlob` answers with these bytes for their hash. */
function published(files: Record<string, string>): { fetchBlob: FetchBlob; refs: Record<string, string> } {
  const byHash = new Map(Object.values(files).map((text) => [sha256(text), text]));
  const refs = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [name, blobRefText({ node: PUBLISHER, blob: sha256(text) })]),
  );
  return {
    refs,
    fetchBlob: async ({ blob }) => {
      const text = byHash.get(blob);
      if (text === undefined) throw new Error("no such file");
      return { stream: Readable.from([Buffer.from(text)]), size: Buffer.byteLength(text) };
    },
  };
}

function submit(runner: TestRunner, files: { ref: string; name: string }[]): TaskView {
  return runner.submit({
    message: { role: "user", parts: [{ kind: "text", text: "use the files" }] },
    metadata: { pod: { files } },
  });
}

async function finished(runner: TestRunner, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const view = runner.get(taskId);
    if (view && isTerminal(view.status.state)) return view;
    if (Date.now() > deadline) throw new Error("timed out waiting for a terminal task");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Run `body` as the whole agent: it sees the input and may write the outbox. */
function agent(body: (input: ExecuteInput) => string): LocalExecutor {
  return {
    async *run(input): AsyncGenerator<ExecutorEvent> {
      yield { type: "completed", text: body(input) };
    },
  };
}

describe("task inbox", () => {
  it("fetches the attached files into inbox/<task_id>/ before the agent starts and lists them in the prompt", async () => {
    const { fetchBlob, refs } = published({ "report.txt": "quarterly numbers" });
    const seen: { content: string; prompt: string }[] = [];
    const setup = runnerSetup({
      fetchBlob,
      executor: agent((input) => {
        const path = join(input.workspaceDir, "inbox", input.taskId, "report.txt");
        seen.push({ content: readFileSync(path, "utf8"), prompt: input.prompt });
        return "read it";
      }),
    });
    const runner = createTestRunner(setup);

    const view = submit(runner, [{ ref: refs["report.txt"] as string, name: "report.txt" }]);
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("completed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content).toBe("quarterly numbers");
    expect(seen[0]?.prompt).toContain(`"inbox/${view.id}/report.txt"`);
    // The shared workspace does not keep the task's files.
    await vi.waitFor(() => expect(existsSync(setup.workspace.inbox(view.id))).toBe(false));
  });

  it("fails the task as input_unavailable when a file cannot be fetched, and never starts the agent", async () => {
    let started = false;
    const runner = createTestRunner({
      fetchBlob: async () => {
        throw new Error("publisher is offline");
      },
      executor: agent(() => {
        started = true;
        return "should not run";
      }),
    });

    const view = submit(runner, [{ ref: blobRefText({ node: PUBLISHER, blob: sha256("x") }), name: "x.txt" }]);
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("failed");
    expect(done.status.reason).toBe("input_unavailable");
    expect(done.status.message?.parts[0]).toMatchObject({ text: expect.stringContaining("publisher is offline") });
    expect(started).toBe(false);
  });

  it("refuses bytes that do not hash to the name the file was published under", async () => {
    const { refs } = published({ "a.txt": "what the name promises" });
    const runner = createTestRunner({
      fetchBlob: async () => ({ stream: Readable.from([Buffer.from("something else")]), size: 14 }),
      executor: agent(() => "should not run"),
    });

    const view = submit(runner, [{ ref: refs["a.txt"] as string, name: "a.txt" }]);
    const done = await finished(runner, view.id);

    expect(done.status.reason).toBe("input_unavailable");
    expect(done.status.message?.parts[0]).toMatchObject({ text: expect.stringContaining("nothing was written") });
  });

  it("refuses a file larger than the workspace quota", async () => {
    const { fetchBlob, refs } = published({ "big.bin": "x".repeat(100) });
    const runner = createTestRunner({ fetchBlob, maxWorkspaceBytes: 10, executor: agent(() => "should not run") });

    const view = submit(runner, [{ ref: refs["big.bin"] as string, name: "big.bin" }]);
    const done = await finished(runner, view.id);

    expect(done.status.reason).toBe("input_unavailable");
    expect(done.status.message?.parts[0]).toMatchObject({ text: expect.stringContaining("larger than") });
  });
});

describe("task files on the wire", () => {
  const ref = blobRefText({ node: PUBLISHER, blob: sha256("x") });

  it("takes plain names and refs", () => {
    expect(PodTaskMetadataSchema.safeParse({ files: [{ ref, name: "a.txt" }] }).success).toBe(true);
  });

  it.each([
    ["a path", { ref, name: "dir/a.txt" }],
    ["a parent directory", { ref, name: ".." }],
    ["a name that could collide with a download in progress", { ref, name: "a.txt.part" }],
    ["a ref that names no file", { ref: "not-a-ref", name: "a.txt" }],
  ])("refuses %s", (_label, file) => {
    expect(PodTaskMetadataSchema.safeParse({ files: [file] }).success).toBe(false);
  });

  it("refuses two files with one name, and too many files", () => {
    const same = [
      { ref, name: "a.txt" },
      { ref, name: "a.txt" },
    ];
    expect(PodTaskMetadataSchema.safeParse({ files: same }).success).toBe(false);
    const many = Array.from({ length: MAX_TASK_FILES + 1 }, (_, index) => ({ ref, name: `f${index}` }));
    expect(PodTaskMetadataSchema.safeParse({ files: many }).success).toBe(false);
  });
});

describe("task outbox", () => {
  function writeOutbox(input: ExecuteInput, files: Record<string, string>): void {
    const dir = join(input.workspaceDir, "outbox", input.taskId);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  }

  it("publishes what the agent left in outbox/<task_id>/ as artifacts, from a copy the agent cannot change", async () => {
    const setup = runnerSetup({
      executor: agent((input) => {
        writeOutbox(input, { "summary.md": "# done" });
        return "finished";
      }),
    });
    const runner = createTestRunner(setup);

    const view = runner.submit({ message: { role: "user", parts: [{ kind: "text", text: "go" }] } });
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("completed");
    expect(done.artifacts).toEqual([{ artifactId: sha256("# done"), name: "summary.md", bytes: 6 }]);
    const blob = setup.blobs.get(sha256("# done"));
    expect(blob).toBeDefined();
    // The published copy lives outside the agent's workspace.
    expect(blob?.path.startsWith(setup.workspace.root)).toBe(false);
    expect(readFileSync(blob?.path as string, "utf8")).toBe("# done");
    await vi.waitFor(() => expect(existsSync(setup.workspace.outbox(view.id))).toBe(false));
  });

  it("publishes the outbox of a failed task too", async () => {
    const runner = createTestRunner({
      executor: {
        async *run(input): AsyncGenerator<ExecutorEvent> {
          writeOutbox(input, { "partial.log": "got this far" });
          yield { type: "failed", text: "gave up", reason: "agent_error" };
        },
      },
    });

    const view = runner.submit({ message: { role: "user", parts: [{ kind: "text", text: "go" }] } });
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("failed");
    expect(done.artifacts?.map((artifact) => artifact.name)).toEqual(["partial.log"]);
  });

  it("hands back at most MAX_TASK_FILES files and names the rest in the result", async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_TASK_FILES + 2 }, (_, i) => [`f${i}.txt`, `file ${i}`]));
    const runner = createTestRunner({
      executor: agent((input) => {
        writeOutbox(input, files);
        return "all done";
      }),
    });

    const view = runner.submit({ message: { role: "user", parts: [{ kind: "text", text: "go" }] } });
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("completed");
    expect(done.artifacts).toHaveLength(MAX_TASK_FILES);
    const text = JSON.stringify(done.status.message);
    expect(text).toContain("all done");
    expect(text).toContain("not handed back");
    expect(text).toContain(`f${MAX_TASK_FILES}.txt (more than ${MAX_TASK_FILES} files)`);
  });

  it("does not hand back a file larger than the workspace quota", async () => {
    const runner = createTestRunner({
      executor: agent((input) => {
        writeOutbox(input, { "huge.bin": "x".repeat(50), "small.txt": "ok" });
        return "all done";
      }),
      maxWorkspaceBytes: 40,
    });

    const view = runner.submit({ message: { role: "user", parts: [{ kind: "text", text: "go" }] } });
    const done = await finished(runner, view.id);

    expect(done.status.state).toBe("completed");
    expect(done.artifacts?.map((artifact) => artifact.name)).toEqual(["small.txt"]);
    expect(JSON.stringify(done.status.message)).toContain("huge.bin (larger than 40 bytes)");
  });

  it("hands nothing back, and says nothing, when the outbox is empty", async () => {
    const runner = createTestRunner({ executor: agent(() => "no files") });
    const view = runner.submit({ message: { role: "user", parts: [{ kind: "text", text: "go" }] } });
    const done = await finished(runner, view.id);

    expect(done.artifacts).toBeUndefined();
    expect(JSON.stringify(done.status.message)).not.toContain("outbox");
  });
});
