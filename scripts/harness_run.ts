#!/usr/bin/env node
/**
 * Real-process smoke test (§10.7).
 *
 * `npm test` runs orca nodes in-process with a fake executor. This script runs
 * two actual `orca-node serve` processes, joins them through the CLI, dispatches
 * one Echo task, and waits for a terminal state. It is the regression harness
 * for things in-process tests cannot see: CLI argument handling, config files,
 * real ports, startup logging, and process shutdown.
 *
 * Run with `npm run harness`; exits non-zero on failure and cleans up its
 * temporary data roots in every case.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { configPath, createOrcaNodeConfig, saveConfig } from "../src/node/config.ts";
import { waitFor } from "../test/support/harness.ts";
import { isTerminal, type TaskView } from "../src/protocol/task.ts";
import { type MembersResponse, WorkgroupIdSchema } from "../src/protocol/peer.ts";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../lib/cli/main.js", import.meta.url));
const NODE = process.execPath;
const START_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 30_000;

type RunningNode = {
  label: string;
  child: ChildProcess;
  /** Resolves with the URL printed once the HTTP listener is up. */
  url: Promise<string>;
  stop(): Promise<void>;
};

function startNode(label: string, configFile: string, extra: string[]): RunningNode {
  const child = spawn(NODE, ["--no-warnings", CLI, "serve", "--config", configFile, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  const url = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} did not start within ${START_TIMEOUT_MS}ms\n${stderr}`));
    }, START_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-4000);
      const match = /listening on (http:\/\/\S+)/.exec(stdout);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${label} exited early (code ${String(code)}, signal ${String(signal)})\n${stderr}`));
    });
  });

  return {
    label,
    child,
    url,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
      child.kill();
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          setTimeout(resolve, 5000);
        }),
      ]);
    },
  };
}

async function runCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(NODE, ["--no-warnings", CLI, ...args], {
    timeout: STEP_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env },
  });
  return stdout;
}

function textOf(view: TaskView): string {
  const parts = view.status.message?.parts ?? [];
  return parts.map((part) => (part.kind === "text" ? part.text : "")).join(" ");
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "orca-pod-harness-"));
  const workgroupId = WorkgroupIdSchema.parse("harness");
  const password = randomBytes(8).toString("hex");
  const running: RunningNode[] = [];
  try {
    const writeConfig = async (index: number): Promise<string> => {
      const dataRoot = join(root, `orca-node-${index}`);
      const config = await createOrcaNodeConfig({
        workgroup_id: workgroupId,
        workgroup_password: password,
        data_root: dataRoot,
        port: 0,
        display_name: `harness-${index}`,
      });
      const file = configPath(dataRoot);
      await saveConfig(file, config);
      return file;
    };
    const firstFile = await writeConfig(0);
    const secondFile = await writeConfig(1);

    const first = startNode("orca-node-0", firstFile, []);
    running.push(first);
    const firstUrl = await first.url;
    console.log(`orca-node-0 up at ${firstUrl}`);

    // A freshly configured node joins at startup through `--peer`, exactly like
    // an operator bootstrapping a second machine into an existing mesh.
    const second = startNode("orca-node-1", secondFile, ["--peer", firstUrl]);
    running.push(second);
    const secondUrl = await second.url;
    console.log(`orca-node-1 up at ${secondUrl}`);

    const members = await waitFor(
      async () => JSON.parse(await runCli(["--config", firstFile, "members", "--json"])) as MembersResponse,
      (response) => response.members.filter((member) => member.state === "online").length >= 2,
      { timeoutMs: STEP_TIMEOUT_MS, label: "two online members" },
    );
    console.log(`mesh converged: ${String(members.members.length)} members`);

    const sent = JSON.parse(
      await runCli(["--config", firstFile, "send", "--peer", secondUrl, "--text", "harness ping", "--json"]),
    ) as TaskView;
    console.log(`dispatched task ${sent.id} to orca-node-1`);

    const final = await waitFor(
      async () =>
        JSON.parse(
          await runCli(["--config", firstFile, "status", "--peer", secondUrl, "--task", sent.id, "--json"]),
        ) as TaskView,
      (view) => isTerminal(view.status.state),
      { timeoutMs: STEP_TIMEOUT_MS, label: "terminal task state" },
    );
    if (final.status.state !== "completed") {
      throw new Error(`task ${sent.id} ended as ${final.status.state}: ${textOf(final)}`);
    }
    console.log(`PASS: 2 processes, ${String(members.members.length)} members, task ${sent.id} completed`);
  } finally {
    for (const node of running.reverse()) await node.stop();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      // Windows may hold a WAL handle briefly; report it so a leak is visible rather than silent.
      console.warn(
        `could not remove harness temp root ${root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

await main();
