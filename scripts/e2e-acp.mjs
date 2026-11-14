/**
 * Real `dsh --profile acp` smoke test — same shape as e2e-headless.ts, but the
 * task runs through AcpExecutor. Needs model credentials in the environment.
 *
 *   DEEPSEEK_API_KEY=... node scripts/e2e-acp.mjs
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrcaNode, createOrcaNodeConfig, createPersistentStorage } from "orca-pod";

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const root = await mkdtemp(join(tmpdir(), "orca-e2e-acp-"));
const config = createOrcaNodeConfig({
  workgroupId: "e2e-acp",
  password: "e2e-password",
  dataRoot: root,
  port: 0,
  executor: "acp",
  acp: {},
});
const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
await node.start();

const startedAt = Date.now();
const submitted = await node.sendTask(node.endpoint, {
  message: {
    role: "user",
    parts: [{ kind: "text", text: "Reply with exactly the word pong" }],
    contextId: "ctx-e2e-acp",
  },
});

let view = submitted;
while (!TERMINAL.has(view.status.state) && Date.now() - startedAt < 120_000) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  view = await node.getTask(node.endpoint, submitted.id);
}

const part = view.status.message?.parts[0];
const text = part !== undefined && part.kind === "text" ? part.text : "";
const sessions = await readFile(join(root, "workgroups", "e2e-acp", ".pod", "sessions.json"), "utf8").catch(
  () => "",
);

console.log(
  JSON.stringify(
    {
      state: view.status.state,
      text,
      reason: view.status.reason ?? null,
      ms: Date.now() - startedAt,
      sessions: sessions.trim(),
    },
    null,
    2,
  ),
);

await node.stop();
