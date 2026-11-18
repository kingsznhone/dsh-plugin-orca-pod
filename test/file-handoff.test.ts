/**
 * Files between two real nodes (§3.8): the origin hands a file to a task, the
 * target fetches it into the task's inbox before the agent starts, and what the
 * agent leaves in its outbox comes back as an artifact the origin can fetch.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { saveBlob } from "../src/core/blobs.ts";
import type { ExecutorEvent, LocalExecutor } from "../src/executor/executor.ts";
import { nodeParts } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import { isTerminal } from "../src/task/wire.ts";
import { wg } from "./fixtures/ids.ts";
import { connectAll, waitFor } from "./support/harness.ts";

let nodes: Orca[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-handoff-"));
  roots.push(root);
  return root;
}

async function startNode(executor?: LocalExecutor): Promise<Orca> {
  const config = nodeParts({
    workgroup_id: wg("orca-handoff"),
    workgroup_password: "handoff-secret",
    data_root: tempRoot(),
    bind_host: "127.0.0.1",
    port: 0,
  });
  const node = new Orca(...config, { executor });
  nodes.push(node);
  await node.start();
  return node;
}

describe("file hand-off", () => {
  it("carries a file to the task's inbox and its outbox back to the origin", async () => {
    const seen: string[] = [];
    const agent: LocalExecutor = {
      async *run(input): AsyncGenerator<ExecutorEvent> {
        const text = readFileSync(join(input.workspaceDir, "inbox", input.taskId, "in.txt"), "utf8");
        seen.push(text);
        const outbox = join(input.workspaceDir, "outbox", input.taskId);
        mkdirSync(outbox, { recursive: true });
        writeFileSync(join(outbox, "out.txt"), text.toUpperCase());
        yield { type: "completed", text: "converted" };
      },
    };
    const origin = await startNode();
    const target = await startNode(agent);
    await connectAll([origin, target]);

    const source = join(tempRoot(), "in.txt");
    writeFileSync(source, "hello from the origin");
    const published = await origin.publish(source);
    const submitted = await origin.mesh.resolve(target.mesh.self.endpoints[0] as string).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "convert it" }] },
      metadata: {
        pod: { files: [{ ref: `${origin.orcaNodeId}/${published.blob_id}`, name: "in.txt" }] },
      },
    });

    const done = await waitFor(
      () => origin.mesh.resolve(target.mesh.self.endpoints[0] as string).getTask(submitted.id),
      (view) => isTerminal(view.status.state),
      { label: "the task to finish" },
    );

    expect(done.status.state).toBe("completed");
    expect(seen).toEqual(["hello from the origin"]);
    const [artifact] = done.artifacts ?? [];
    expect(artifact?.name).toBe("out.txt");

    const output = join(tempRoot(), "out.txt");
    const opened = await origin.mesh.require(target.orcaNodeId).fetchBlob(artifact?.artifactId as string);
    await saveBlob(opened, output, artifact?.artifactId as string);
    expect(readFileSync(output, "utf8")).toBe("HELLO FROM THE ORIGIN");
  });

  it("fails the task as input_unavailable when the origin no longer has the file", async () => {
    const target = await startNode();
    const origin = await startNode();
    await connectAll([origin, target]);

    const source = join(tempRoot(), "gone.txt");
    writeFileSync(source, "soon deleted");
    const published = await origin.publish(source);
    rmSync(source);
    const submitted = await origin.mesh.resolve(target.mesh.self.endpoints[0] as string).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "use it" }] },
      metadata: { pod: { files: [{ ref: `${origin.orcaNodeId}/${published.blob_id}`, name: "gone.txt" }] } },
    });

    const done = await waitFor(
      () => origin.mesh.resolve(target.mesh.self.endpoints[0] as string).getTask(submitted.id),
      (view) => isTerminal(view.status.state),
      { label: "the task to fail" },
    );

    expect(done.status.state).toBe("failed");
    expect(done.status.reason).toBe("input_unavailable");
  });
});
