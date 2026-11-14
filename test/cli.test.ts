import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configPath, createOrcaNodeConfig, saveConfig, type OrcaNodeConfig } from "../src/config.ts";
import { createOrcaNode, createPersistentStorage, type OrcaNode } from "../src/index.ts";
import { sha256Hex } from "../src/storage.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], input?: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ["--no-warnings", CLI, ...args],
      { env: process.env, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error !== null && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code: number }).code)
          : error === null
            ? 0
            : 1;
        resolve({ code, stdout, stderr });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

describe("orca-node CLI", () => {
  let root: string;
  let config: OrcaNodeConfig;
  let node: OrcaNode;
  let endpoint: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "orca-cli-test-"));
    config = createOrcaNodeConfig({
      workgroupId: "cli-test",
      password: "correct horse",
      dataRoot: root,
      port: 0,
    });
    await saveConfig(configPath(root), config);
    node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    endpoint = (await node.start()).url;
    // `serve` records the listen address; tests start the node in-process, so do it here.
    await saveConfig(configPath(root), { ...config, endpoint });
  });

  afterAll(async () => {
    await node.stop();
  });

  it("sends a task and waits for it to complete", async () => {
    const sent = await runCli(["send", "--data-root", root, "--peer", endpoint, "--text", "hello cli", "--json"]);
    expect(sent.code).toBe(0);
    const created = JSON.parse(sent.stdout) as { id: string; status: { state: string } };
    expect(created.id).toMatch(/^[0-9A-Z]{26}$/);

    const waited = await runCli(["wait", "--data-root", root, "--peer", endpoint, "--task", created.id, "--timeout", "5", "--json"]);
    expect(waited.code).toBe(0);
    const done = JSON.parse(waited.stdout) as { status: { state: string } };
    expect(done.status.state).toBe("completed");
  });

  it("returns 3 when the task needs permission", async () => {
    const script = JSON.stringify({
      echo: {
        steps: [{ at_ms: 0, suspend: { kind: "blocked", reason: "need_input", question: "continue?" } }],
        final: { state: "completed", text: "done" },
      },
    });
    const sent = await runCli(["send", "--data-root", root, "--peer", endpoint, "--text", "needs permission", "--metadata", script, "--json"]);
    expect(sent.code).toBe(0);
    const created = JSON.parse(sent.stdout) as { id: string };

    const waited = await runCli(["wait", "--data-root", root, "--peer", endpoint, "--task", created.id, "--timeout", "5", "--json"]);
    expect(waited.code).toBe(3);
    const view = JSON.parse(waited.stdout) as { status: { state: string } };
    expect(view.status.state).toBe("input-required");
    await node.cancelTask(endpoint, created.id);
  });

  it("returns 2 when the task is still running", async () => {
    const script = JSON.stringify({ echo: { final: { state: "hang" } } });
    const sent = await runCli(["send", "--data-root", root, "--peer", endpoint, "--text", "hang", "--metadata", script, "--json"]);
    expect(sent.code).toBe(0);
    const created = JSON.parse(sent.stdout) as { id: string };

    const waited = await runCli(["wait", "--data-root", root, "--peer", endpoint, "--task", created.id, "--timeout", "1", "--json"]);
    expect(waited.code).toBe(2);
    const view = JSON.parse(waited.stdout) as { status: { state: string } };
    expect(view.status.state).toBe("working");
    await node.cancelTask(endpoint, created.id);
  });

  it("reads the task text from stdin", async () => {
    const sent = await runCli(["send", "--data-root", root, "--peer", endpoint, "--text", "-", "--json"], "piped task text\n");
    expect(sent.code).toBe(0);
    const created = JSON.parse(sent.stdout) as { id: string };
    const waited = await runCli(["wait", "--data-root", root, "--peer", endpoint, "--task", created.id, "--timeout", "5", "--json"]);
    expect(waited.code).toBe(0);
  });

  it("reports the local member list", async () => {
    const listed = await runCli(["members", "--data-root", root, "--peer", endpoint]);
    expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    expect(listed.stdout).toContain(config.orca_node_id);
    expect(listed.stdout).toContain("digest");
  });

  it("accepts global flags before the subcommand", async () => {
    const listed = await runCli(["--data-root", root, "members", "--peer", endpoint, "--json"]);
    expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    const response = JSON.parse(listed.stdout) as { members: { orca_node_id: string }[] };
    expect(response.members.some((member) => member.orca_node_id === config.orca_node_id)).toBe(true);
  });

  it("fails with a clear error when the peer is unreachable", async () => {
    const failed = await runCli(["send", "--data-root", root, "--peer", "http://127.0.0.1:1", "--text", "x", "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("orca-node:");
  });

  it("escalate reports a child that is not waiting for permission", async () => {
    const sent = await runCli(["send", "--data-root", root, "--peer", endpoint, "--text", "quick", "--json"]);
    expect(sent.code).toBe(0);
    const created = JSON.parse(sent.stdout) as { id: string };
    const escalated = await runCli([
      "escalate", "--data-root", root, "--peer", endpoint, "--task", created.id, "--local-task", created.id, "--json",
    ]);
    expect(escalated.code).toBe(1);
    expect(escalated.stderr).toContain("not waiting for permission");
  });

  it("publishes a produced file as a signed blob URL without any HTTP route", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-cli-publish-"));
    const filePath = join(dir, "report.md");
    const content = Buffer.from("# cli publish\n");
    await writeFile(filePath, content);

    const published = await runCli(["--data-root", root, "publish", filePath, "--json"]);
    expect(published.code, published.stderr).toBe(0);
    const body = JSON.parse(published.stdout) as { blob_id: string; size: number; url: string };
    expect(body.blob_id).toBe(sha256Hex(content));
    expect(body.size).toBe(content.length);

    const response = await fetch(body.url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true);

    // The CLI writes the mapping locally; there is no registration endpoint to
    // abuse from another orca node (a shared workgroup key cannot prove identity).
    const register = await fetch(`${endpoint}/blobs/register`, { method: "POST", body: "{}" });
    expect(register.status).toBe(404);
  });
});
