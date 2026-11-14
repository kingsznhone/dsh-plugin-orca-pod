import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import { createHeadlessExecutor } from "../src/headless.ts";
import type { ExecuteInput, ExecutorEvent } from "../src/executor.ts";
import { createOrcaNode, createPersistentStorage } from "../src/orca_node.ts";

const FAKE_DSH = fileURLToPath(new URL("./fixtures/fake-dsh.mjs", import.meta.url));

async function collect(
  stream: AsyncGenerator<ExecutorEvent, void, unknown>,
): Promise<{ events: ExecutorEvent[]; error: Error | null }> {
  const events: ExecutorEvent[] = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    return { events, error: error as Error };
  }
  return { events, error: null };
}

async function withMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  process.env.FAKE_DSH_MODE = mode;
  try {
    return await run();
  } finally {
    delete process.env.FAKE_DSH_MODE;
  }
}

function executor(): ReturnType<typeof createHeadlessExecutor> {
  return createHeadlessExecutor({ command: process.execPath, extra_args: [FAKE_DSH] });
}

async function podDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orca-headless-"));
}

function input(pod: string, overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    taskId: "task-1",
    contextId: "context-1",
    originOrcaNode: "ORIGIN",
    prompt: "do it",
    podDir: pod,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.FAKE_DSH_MODE;
  delete process.env.FAKE_DSH_ARGS_FILE;
});

describe("HeadlessExecutor", () => {
  it("maps final.text to a completed event and records the session id", async () => {
    const pod = await podDir();
    const { events, error } = await withMode("ok", () => collect(executor().run(input(pod), new AbortController().signal)));
    expect(error).toBeNull();
    expect(events).toEqual([{ type: "completed", text: "fake done" }]);
    const sessions = JSON.parse(await readFile(join(pod, "sessions.json"), "utf8"));
    expect(sessions["ORIGIN|context-1"]).toBe("session-fake-1");
  });

  it("passes the prompt text to dsh", async () => {
    const pod = await podDir();
    const { events } = await withMode("echo-prompt", () =>
      collect(executor().run(input(pod, { prompt: "build the thing" }), new AbortController().signal)),
    );
    const completed = events[0] as { type: string; text: string };
    expect(completed.type).toBe("completed");
    expect(completed.text).toContain("[orca-pod]");
    expect(completed.text).toContain("build the thing");
  });

  it("fails the task when dsh reports an error", async () => {
    const pod = await podDir();
    const { events } = await withMode("error", () => collect(executor().run(input(pod), new AbortController().signal)));
    expect(events[0]).toMatchObject({ type: "failed", text: "boom" });
    expect((events[0] as { reason?: string }).reason).toBeUndefined();
  });

  it("carries the dsh error code as the task reason", async () => {
    const pod = await podDir();
    const { events } = await withMode("error-code", () =>
      collect(executor().run(input(pod), new AbortController().signal)),
    );
    expect(events).toEqual([{ type: "failed", text: "boom", reason: "AUTH_MISSING" }]);
  });

  it("carries dsh token usage on the terminal event", async () => {
    const pod = await podDir();
    const { events } = await withMode("usage", () => collect(executor().run(input(pod), new AbortController().signal)));
    expect(events).toEqual([
      {
        type: "completed",
        text: "fake done",
        usage: { input_tokens: 11, output_tokens: 22, cache_read_tokens: 3 },
      },
    ]);
  });

  it("fails when dsh exits without a final event", async () => {
    const pod = await podDir();
    const { events } = await withMode("nofinal", () => collect(executor().run(input(pod), new AbortController().signal)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "failed" });
  });

  it("resumes the stored session for the same origin + context", async () => {
    const pod = await podDir();
    await writeFile(join(pod, "sessions.json"), JSON.stringify({ "ORIGIN|context-1": "session-xyz" }));
    const argsFile = join(pod, "args.json");
    process.env.FAKE_DSH_ARGS_FILE = argsFile;
    const { events } = await withMode("resume-check", () =>
      collect(executor().run(input(pod), new AbortController().signal)),
    );
    expect(events).toEqual([{ type: "completed", text: "resumed" }]);
    const args = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args.argv).toContain("--session-id");
    expect(args.argv).toContain("session-xyz");
  });

  it("aborts the child process when the task is cancelled", async () => {
    const pod = await podDir();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300).unref();
    const { error } = await withMode("hang", () => collect(executor().run(input(pod), controller.signal)));
    expect(error?.name).toBe("AbortError");
  });

  it("runs through createOrcaNode with cwd = workspace work/ and resumes the session", async () => {
    const dataRoot = await podDir();
    const pod = join(dataRoot, "workgroups", "orca-dev");
    const argsFile = join(pod, "args.json");
    process.env.FAKE_DSH_ARGS_FILE = argsFile;
    const config = createOrcaNodeConfig({
      workgroupId: "orca-dev",
      password: "correct horse",
      dataRoot,
      port: 0,
      executor: "headless",
      headless: { command: process.execPath, extra_args: [FAKE_DSH] },
    });
    const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    await node.start();
    const sendAndWait = async (text: string) => {
      const submitted = await withMode("ok", () =>
        node.sendTask(node.endpoint, {
          message: { role: "user", parts: [{ kind: "text", text }], contextId: "ctx-1" },
        }),
      );
      const deadline = Date.now() + 5_000;
      let view = await node.getTask(node.endpoint, submitted.id);
      while (view.status.state !== "completed" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        view = await node.getTask(node.endpoint, submitted.id);
      }
      expect(view.status.state).toBe("completed");
      return view;
    };
    try {
      const first = await sendAndWait("run the tests");
      expect(first.status.message?.parts[0]).toEqual({ kind: "text", text: "fake done" });
      const firstArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(firstArgs.prompt).toContain("[orca-pod]");
      expect(firstArgs.prompt).toContain("run the tests");
      expect(firstArgs.argv).toContain("--add-dir");
      expect(firstArgs.cwd.endsWith(join("workgroups", "orca-dev", "work"))).toBe(true);
      expect(firstArgs.sessionId).toBeUndefined();

      await sendAndWait("again");
      const secondArgs = JSON.parse(await readFile(argsFile, "utf8"));
      expect(secondArgs.sessionId).toBe("session-fake-1");
    } finally {
      await node.stop();
    }
  }, 15_000);
});
