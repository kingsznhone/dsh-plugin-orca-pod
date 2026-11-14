import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createMesh, type Mesh } from "../src/index.ts";
import type { OrcaNode } from "../src/orca_node.ts";
import type { TaskState, TaskView } from "../src/protocol.ts";

let mesh: Mesh | null = null;

afterEach(async () => {
  await mesh?.stop();
  mesh = null;
});

async function twoNodes(): Promise<{ origin: OrcaNode; target: OrcaNode; targetUrl: string }> {
  mesh = await createMesh({ nodes: 2 });
  const [origin, target] = mesh.nodes;
  if (!origin || !target) throw new Error("mesh did not create two nodes");
  return { origin, target, targetUrl: target.endpoint };
}

async function waitForState(
  origin: OrcaNode,
  targetUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 3000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | null = null;
  while (Date.now() < deadline) {
    last = await origin.getTask(targetUrl, taskId);
    if (last.status.state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach ${state}; last=${last?.status.state}`);
}

function textOf(view: TaskView): string | null {
  const part = view.status.message?.parts.find((item) => item.kind === "text");
  return part && part.kind === "text" ? part.text : null;
}

describe("A2A task surface", () => {
  it("runs an echo task to completion and returns its text", async () => {
    const { origin, targetUrl } = await twoNodes();
    const submitted = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
      metadata: { echo: { final: { state: "completed", text: "hello pod" } } },
    });
    expect(submitted.kind).toBe("task");
    expect(["submitted", "working"]).toContain(submitted.status.state);

    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("hello pod");
  });

  it("suspends on blocked and resumes with the next message", async () => {
    const { origin, targetUrl } = await twoNodes();
    const submitted = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "start" }] },
      metadata: {
        echo: {
          steps: [{ at_ms: 10, suspend: { kind: "blocked", reason: "need_decision", question: "continue?" } }],
          final: { state: "completed", text: "done" },
        },
      },
    });

    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");
    const payload = suspended.status.message?.parts[0];
    expect(payload?.kind).toBe("data");
    expect(payload?.kind === "data" ? payload.data["blocked"] : null).toMatchObject({
      reason: "need_decision",
      question: "continue?",
    });

    await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "yes" }], taskId: submitted.id },
    });
    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("done");
  });

  it("stores echo artifacts as content-addressed blobs", async () => {
    const { origin, targetUrl } = await twoNodes();
    const content = "hello pod\n";
    const submitted = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "artifact" }] },
      metadata: {
        echo: {
          final: { state: "completed", text: "with artifact" },
          artifacts: [{ name: "echo.txt", content }],
        },
      },
    });

    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    const artifact = done.artifacts?.[0];
    expect(artifact).toBeDefined();
    expect(artifact?.artifactId).toBe(createHash("sha256").update(content).digest("hex"));
    expect(artifact?.bytes).toBe(Buffer.byteLength(content));
    expect(artifact?.name).toBe("echo.txt");
  });

  it("rejects an invalid echo script before creating a task", async () => {
    const { origin, targetUrl } = await twoNodes();
    await expect(
      origin.sendTask(targetUrl, {
        message: { role: "user", parts: [{ kind: "text", text: "bad" }] },
        metadata: { echo: { steps: [{ at_ms: 10 }, { at_ms: 5 }] } },
      }),
    ).rejects.toMatchObject({ code: "bad_echo_script", status: 400 });
  });

  it("returns node_busy when a task is already running", async () => {
    const { origin, targetUrl } = await twoNodes();
    const running = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, running.id, "working");

    await expect(
      origin.sendTask(targetUrl, {
        message: { role: "user", parts: [{ kind: "text", text: "second" }] },
        metadata: { echo: { final: { state: "completed", text: "nope" } } },
      }),
    ).rejects.toMatchObject({ code: "node_busy", status: 429 });

    await origin.cancelTask(targetUrl, running.id);
  });

  it("cancels a hanging task", async () => {
    const { origin, targetUrl } = await twoNodes();
    const submitted = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, submitted.id, "working");

    const canceled = await origin.cancelTask(targetUrl, submitted.id);
    expect(canceled.status.state).toBe("canceled");
    const fetched = await origin.getTask(targetUrl, submitted.id);
    expect(fetched.status.state).toBe("canceled");
  });

  it("reports unknown tasks as 404", async () => {
    const { origin, targetUrl } = await twoNodes();
    await expect(origin.getTask(targetUrl, "01JUNKNOWN")).rejects.toMatchObject({
      code: "task_not_found",
      status: 404,
    });
  });
});
