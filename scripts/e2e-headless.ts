/**
 * Real `dsh` smoke for the HeadlessExecutor (§6.14).
 *
 *   DEEPSEEK_API_KEY=... node scripts/e2e-headless.ts
 *
 * Verifies: NDJSON -> completed + final.text, and session reuse across two
 * tasks in the same context (second task must see the first task's answer).
 * Not part of `npm test` because it calls a real model.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrcaNodeConfig } from "../src/config.ts";
import { createOrcaNode, createPersistentStorage } from "../src/orca_node.ts";

if (!process.env["DEEPSEEK_API_KEY"]) {
  console.error("DEEPSEEK_API_KEY is not set; this smoke calls a real model.");
  process.exit(1);
}

const dataRoot = mkdtempSync(join(tmpdir(), "orca-e2e-headless-"));
const config = createOrcaNodeConfig({
  workgroupId: "orca-dev",
  password: "e2e-password",
  dataRoot,
  port: 0,
  host: "127.0.0.1",
  displayName: "e2e-headless",
  executor: "headless",
  headless: {
    command: "dsh",
    profile: "headless",
    permission_mode: "read-only",
    approval_policy: "never",
  },
});
const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
await node.start();

let failures = 0;
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};

async function runTask(text: string): Promise<{ state: string; result: string; ms: number }> {
  const started = Date.now();
  const view = await node.sendTask(node.endpoint, {
    message: {
      role: "user",
      parts: [{ kind: "text", text }],
      messageId: randomUUID(),
      contextId: "ctx-e2e-headless",
    },
  });
  let latest = view;
  for (let i = 0; i < 480; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await node.getTask(node.endpoint, view.id);
    if (["completed", "failed", "canceled"].includes(latest.status.state)) break;
  }
  const part = latest.status.message?.parts?.[0];
  return {
    state: latest.status.state,
    result: part && part.kind === "text" ? part.text.trim() : "",
    ms: Date.now() - started,
  };
}

try {
  const first = await runTask("Remember the codeword: pong. Reply with exactly: stored");
  console.log("task 1:", JSON.stringify(first));
  check(first.state === "completed", "task 1 completed");
  check(first.result === "stored", "task 1 result is 'stored'");

  const second = await runTask("What is the codeword? Reply with exactly the codeword.");
  console.log("task 2:", JSON.stringify(second));
  check(second.state === "completed", "task 2 completed");
  check(second.result === "pong", "task 2 resumed the session and answers 'pong'");

  const sessions = JSON.parse(
    readFileSync(join(dataRoot, "workgroups", "orca-dev", ".pod", "sessions.json"), "utf8"),
  ) as Record<string, string>;
  const keys = Object.keys(sessions);
  check(keys.length === 1, "one bound session for (origin, context)");
  check(keys[0]?.endsWith("|ctx-e2e-headless") === true, "session key is origin|context");

  console.log(failures === 0 ? "PASS" : `FAILED (${failures})`);
} finally {
  await node.stop();
  rmSync(dataRoot, { recursive: true, force: true });
}

if (failures > 0) process.exit(1);
