import { afterEach, describe, expect, it } from "vitest";

import { createMesh, type Mesh } from "./support/harness.ts";
import type { Orca } from "../src/node/orca.ts";
import type { TaskState, TaskView } from "../src/task/wire.ts";

let mesh: Mesh | null = null;

afterEach(async () => {
  await mesh?.stop();
  mesh = null;
});

async function twoNodes(): Promise<{ origin: Orca; target: Orca; targetUrl: string }> {
  mesh = await createMesh({ orcaNodes: 2 });
  const [origin, target] = mesh.orcaNodes;
  if (!origin || !target) throw new Error("mesh did not create two orca nodes");
  return { origin, target, targetUrl: target.mesh.self.endpoints[0]! };
}

async function waitForState(
  origin: Orca,
  targetUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 3000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | null = null;
  while (Date.now() < deadline) {
    last = await origin.mesh.resolve(targetUrl).getTask(taskId);
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
    const submitted = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
      metadata: { echo: { final: { state: "completed", text: "hello pod" } } },
    });
    expect(submitted.kind).toBe("task");
    expect(["submitted", "working"]).toContain(submitted.status.state);
    // The view names the node that dispatched the task, so the panel can show it
    // without a second lookup (§9.2).
    expect(submitted.metadata?.pod?.origin_orca_node).toBe(origin.orcaNodeId);

    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("hello pod");
  });

  it("answers a resume with 429 orca_node_busy while another task holds the slot", async () => {
    const { origin, targetUrl } = await twoNodes();
    const parked = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "start" }] },
      metadata: {
        echo: {
          steps: [{ at_ms: 10, suspend: { kind: "permission", tool: "write_file", requested: { path: "a.txt" } } }],
          final: { state: "completed", text: "done" },
        },
      },
    });
    const suspended = await waitForState(origin, targetUrl, parked.id, "input-required");
    const holder = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, holder.id, "working");

    await expect(origin.mesh.resolve(targetUrl).approve(suspended)).rejects.toMatchObject({
      code: "orca_node_busy",
      status: 429,
    });
    expect((await origin.mesh.resolve(targetUrl).getTask(parked.id)).status.state).toBe("input-required");

    await origin.mesh.resolve(targetUrl).cancelTask(holder.id);
    await origin.mesh.resolve(targetUrl).approve(suspended);
    expect(textOf(await waitForState(origin, targetUrl, parked.id, "completed"))).toBe("done");
  });

  it("rejects an invalid echo script before creating a task", async () => {
    const { origin, targetUrl } = await twoNodes();
    await expect(
      origin.mesh.resolve(targetUrl).sendTask({
        message: { role: "user", parts: [{ kind: "text", text: "bad" }] },
        metadata: { echo: { steps: [{ at_ms: 10 }, { at_ms: 5 }] } },
      }),
    ).rejects.toMatchObject({ code: "bad_echo_script", status: 400 });
  });

  it("returns orca_node_busy when a task is already running", async () => {
    const { origin, targetUrl } = await twoNodes();
    const running = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, running.id, "working");

    await expect(
      origin.mesh.resolve(targetUrl).sendTask({
        message: { role: "user", parts: [{ kind: "text", text: "second" }] },
        metadata: { echo: { final: { state: "completed", text: "nope" } } },
      }),
    ).rejects.toMatchObject({ code: "orca_node_busy", status: 429 });

    await origin.mesh.resolve(targetUrl).cancelTask(running.id);
  });

  it("cancels a hanging task", async () => {
    const { origin, targetUrl } = await twoNodes();
    const submitted = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, submitted.id, "working");

    const canceled = await origin.mesh.resolve(targetUrl).cancelTask(submitted.id);
    expect(canceled.status.state).toBe("canceled");
    const fetched = await origin.mesh.resolve(targetUrl).getTask(submitted.id);
    expect(fetched.status.state).toBe("canceled");
  });

  it("lets only the origin cancel a task", async () => {
    mesh = await createMesh({ orcaNodes: 3 });
    const [origin, target, other] = mesh.orcaNodes;
    if (!origin || !target || !other) throw new Error("mesh did not create three orca nodes");
    const targetUrl = target.mesh.self.endpoints[0]!;
    const submitted = await origin.mesh.resolve(targetUrl).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { final: { state: "hang", text: "" } } },
    });
    await waitForState(origin, targetUrl, submitted.id, "working");

    await expect(other.mesh.resolve(targetUrl).cancelTask(submitted.id)).rejects.toMatchObject({
      code: "not_task_origin",
      status: 403,
    });

    const canceled = await origin.mesh.resolve(targetUrl).cancelTask(submitted.id);
    expect(canceled.status.state).toBe("canceled");
  });

  it("reports unknown tasks as 404", async () => {
    const { origin, targetUrl } = await twoNodes();
    await expect(origin.mesh.resolve(targetUrl).getTask("01JUNKNOWN")).rejects.toMatchObject({
      code: "task_not_found",
      status: 404,
    });
  });
});
