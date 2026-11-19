/**
 * Files between two real nodes (§5.6): files are not part of a task. The origin
 * publishes one and names it in the task text; the task fetches it by that name
 * and publishes what it hands back, naming it in its result; the origin fetches
 * that. The agent here does what the task's `orca_pod` file methods have the
 * target node do (its local routes, tested on their own in `blobs.test.ts`).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { formatBlobRef, parseBlobRef, saveBlob } from "../src/core/blobs.ts";
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

const FILE_NAME = /[1-9A-HJ-NP-Za-km-z]{32,44}\/[0-9a-f]{64}/;

describe("file hand-off", () => {
  it("moves a file to a task and one back, by the names written in the texts", async () => {
    const seen: string[] = [];
    let target: Orca | undefined;
    const agent: LocalExecutor = {
      async *run(input): AsyncGenerator<ExecutorEvent> {
        const node = target as Orca;
        // fetch: the name the origin wrote, saved where the agent works.
        const ref = parseBlobRef(FILE_NAME.exec(input.prompt)?.[0] ?? "");
        if (ref === null) throw new Error("the task text names no file");
        const input_ = join(input.workspaceDir, "in.txt");
        await saveBlob(await node.mesh.require(ref.node).fetchBlob(ref.blob_id), input_, ref.blob_id);
        const text = readFileSync(input_, "utf8");
        seen.push(text);
        // publish: what the agent hands back, named in its result.
        const output = join(input.workspaceDir, "out.txt");
        writeFileSync(output, text.toUpperCase());
        const published = await node.mesh.self.publish(output);
        yield { type: "completed", text: `converted: ${published.ref}` };
      },
    };
    const origin = await startNode();
    target = await startNode(agent);
    await connectAll([origin, target]);

    const source = join(tempRoot(), "in.txt");
    writeFileSync(source, "hello from the origin");
    const published = parseBlobRef((await origin.mesh.self.publish(source)).ref)!;
    const name = formatBlobRef({ node: origin.mesh.self.id, blob_id: published.blob_id });
    const submitted = await origin.mesh.resolve(target.mesh.self.endpoints[0] as string).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: `convert ${name}` }] },
    });

    const done = await waitFor(
      () => origin.mesh.resolve((target as Orca).mesh.self.endpoints[0] as string).getTask(submitted.id),
      (view) => isTerminal(view.status.state),
      { label: "the task to finish" },
    );

    expect(done.status.state).toBe("completed");
    expect(seen).toEqual(["hello from the origin"]);
    const result = done.status.message?.parts[0];
    const back = parseBlobRef(FILE_NAME.exec(result?.kind === "text" ? result.text : "")?.[0] ?? "");
    expect(back?.node).toBe(target.mesh.self.id);

    const saved = join(tempRoot(), "out.txt");
    await saveBlob(await origin.mesh.require(back!.node).fetchBlob(back!.blob_id), saved, back!.blob_id);
    expect(readFileSync(saved, "utf8")).toBe("HELLO FROM THE ORIGIN");
  });

  it("serves a published file after the original is gone: the node keeps its own copy", async () => {
    const target = await startNode();
    const origin = await startNode();
    await connectAll([origin, target]);

    const source = join(tempRoot(), "gone.txt");
    writeFileSync(source, "soon deleted");
    const published = parseBlobRef((await origin.mesh.self.publish(source)).ref)!;
    rmSync(source);

    const saved = join(tempRoot(), "copy.txt");
    await saveBlob(
      await target.mesh.require(origin.mesh.self.id).fetchBlob(published.blob_id),
      saved,
      published.blob_id,
    );
    expect(readFileSync(saved, "utf8")).toBe("soon deleted");
  });
});
