#!/usr/bin/env node
/**
 * Loopback smoke test (§10.7).
 *
 * `npm test` mixes fakes and in-process orca nodes freely. This script runs two
 * nodes in one process the way a deployment would see them: real listening
 * ports on loopback, real signed HTTP between them, the scripted test executor, and
 * a real shutdown. It joins them, dispatches one scripted task and waits for a
 * terminal state.
 *
 * Run with `npm run harness`; exits non-zero on failure and removes its
 * temporary data roots in every case.
 */

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";

import { isTerminal, messageText } from "../src/task/wire.ts";
import { createMesh, waitFor } from "../test/support/harness.ts";
import { peersOf } from "../test/support/node.ts";
import { scriptMessage } from "../test/support/script.ts";

const STEP_TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  const mesh = await createMesh({
    orcaNodes: 2,
    workgroupId: "harness",
    password: randomBytes(8).toString("hex"),
    displayNamePrefix: "harness",
  });
  try {
    const [first, second] = mesh.orcaNodes;
    const [firstUrl, secondUrl] = mesh.urls;
    if (first === undefined || second === undefined || firstUrl === undefined || secondUrl === undefined) {
      throw new Error("the mesh did not start two nodes");
    }
    console.log(`orca-node-0 up at ${firstUrl}`);
    console.log(`orca-node-1 up at ${secondUrl}`);

    const members = await waitFor(
      () => peersOf(first),
      (list) => list.some((member) => member.state === "online"),
      { timeoutMs: STEP_TIMEOUT_MS, label: "an online peer" },
    );
    // The roster does not list the node itself.
    const size = members.length + 1;
    console.log(`mesh converged: ${String(size)} members`);

    const sent = await first.mesh.resolve(secondUrl).sendTask({
      message: scriptMessage({ final: { state: "completed", text: "pong" } }),
    });
    console.log(`dispatched task ${sent.id} to orca-node-1`);

    const final = await waitFor(
      () => first.mesh.resolve(secondUrl).getTask(sent.id),
      (view) => isTerminal(view.status.state),
      { timeoutMs: STEP_TIMEOUT_MS, label: "terminal task state" },
    );
    const text = final.status.message === undefined ? "" : messageText(final.status.message);
    if (final.status.state !== "completed") {
      throw new Error(`task ${sent.id} ended as ${final.status.state}: ${text}`);
    }
    console.log(`PASS: 2 nodes, ${String(size)} members, task ${sent.id} completed`);
  } finally {
    await mesh.stop();
    if (mesh.ownsDataRoot) {
      try {
        rmSync(mesh.dataRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        // Windows may hold a WAL handle briefly; report it so a leak is visible rather than silent.
        console.warn(
          `could not remove harness temp root ${mesh.dataRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

await main();
