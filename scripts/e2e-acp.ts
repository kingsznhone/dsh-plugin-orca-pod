/**
 * Real `dsh --profile acp` smoke test: a task runs through AcpExecutor.
 * Needs model credentials in the environment.
 *
 *   DEEPSEEK_API_KEY=... node --import tsx scripts/e2e-acp.ts
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkgroupIdSchema } from "../src/core/ids.ts";
import { isTerminal, messageText } from "../src/task/wire.ts";
import { newNode } from "../test/support/node.ts";

const prompt = process.argv[2] ?? "Reply with exactly the word pong";
const root = await mkdtemp(join(tmpdir(), "orca-e2e-acp-"));
const node = newNode({
  workgroup_id: WorkgroupIdSchema.parse("e2e-acp"),
  workgroup_password: "e2e-password",
  data_root: root,
  port: 0,
  executor: "acp",
  acp: {},
});
await node.start();

const endpoint = node.mesh.self.endpoints[0] ?? "";
const startedAt = Date.now();
let view = await node.mesh.resolve(endpoint).sendTask({
  message: {
    role: "user",
    parts: [{ kind: "text", text: prompt }],
    contextId: "ctx-e2e-acp",
  },
});
const taskId = view.id;

while (!isTerminal(view.status.state) && Date.now() - startedAt < 120_000) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  view = await node.mesh.resolve(endpoint).getTask(taskId);
}

const sessions = await readFile(join(root, "state", "e2e-acp", "sessions.json"), "utf8").catch(() => "");

console.log(
  JSON.stringify(
    {
      state: view.status.state,
      text: view.status.message === undefined ? "" : messageText(view.status.message),
      reason: view.status.reason ?? null,
      ms: Date.now() - startedAt,
      sessions: sessions.trim(),
    },
    null,
    2,
  ),
);

await node.stop();
