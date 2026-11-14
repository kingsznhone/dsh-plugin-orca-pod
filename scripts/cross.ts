import { setTimeout as sleep } from "node:timers/promises";
import { createNodeConfig, defaultDataRoot, loadConfig, saveConfig } from "@orca/config";
import { createNode, type OrcaNode } from "@orca/orca-node";

type Args = Map<string, string>;

function parseArgs(argv: readonly string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!flag?.startsWith("--")) continue;
    const value = rest[index + 1];
    if (value && !value.startsWith("--")) {
      args.set(flag.slice(2), value);
      index += 1;
    } else {
      args.set(flag.slice(2), "true");
    }
  }
  return { command, args };
}

function required(args: Args, key: string): string {
  const value = args.get(key);
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

async function withNode(node: OrcaNode, keepAlive: boolean): Promise<void> {
  const shutdown = async (): Promise<void> => {
    await node.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  if (!keepAlive) return;
  for (;;) {
    await sleep(2000);
    const members = node.members();
    console.log(`members=${members.length} digest=${node.membersDigest().slice(0, 12)}`);
  }
}

async function serve(args: Args): Promise<void> {
  const workgroupId = required(args, "workgroup");
  const password = required(args, "password");
  const configFile = args.get("config") ?? `${defaultDataRoot()}/config.json`;
  const exists = await loadConfig(configFile).catch(() => null);
  const config = exists ?? createNodeConfig({
    workgroupId,
    password,
    displayName: args.get("name") ?? `host-${process.pid}`,
    host: args.get("host") ?? "0.0.0.0",
    port: Number(args.get("port") ?? 11811),
    endpoint: args.get("endpoint") ?? null,
  });
  if (!exists) await saveConfig(configFile, config);
  const node = createNode({ config });
  const { url } = await node.start();
  console.log(`serving on ${url} node=${node.nodeId} config=${configFile}`);
  await withNode(node, true);
}

async function join(args: Args): Promise<void> {
  const peer = required(args, "peer");
  const workgroupId = required(args, "workgroup");
  const password = required(args, "password");
  const config = createNodeConfig({
    workgroupId,
    password,
    displayName: args.get("name") ?? `guest-${process.pid}`,
    host: "0.0.0.0",
    port: Number(args.get("port") ?? 0),
    endpoint: args.get("endpoint") ?? null,
  });
  const node = createNode({ config });
  const { url } = await node.start();
  const response = await node.join(peer);
  console.log(`joined ${peer} as ${node.nodeId} on ${url}`);
  console.log(`members=${response.members.map((member) => `${member.node_id}@${member.endpoint}`).join(",")}`);
  console.log(`digest=${response.members_digest}`);
  for (const member of node.members()) {
    if (member.endpoint && member.endpoint !== node.endpoint) {
      await node.heartbeat(member.endpoint).catch((error: unknown) => {
        console.log(`heartbeat ${member.endpoint} failed: ${String(error)}`);
      });
    }
  }
  await withNode(node, true);
}

async function task(args: Args): Promise<void> {
  const configFile = required(args, "config");
  const peer = required(args, "peer");
  const config = await loadConfig(configFile);
  const node = createNode({ config });
  const echo = args.get("echo")
    ? (JSON.parse(required(args, "echo")) as Record<string, unknown>)
    : { final: { state: "completed", text: args.get("text") ?? "echo from host" } };
  const submitted = await node.sendTask(peer, {
    message: { role: "user", parts: [{ kind: "text", text: args.get("text") ?? "run echo" }] },
    metadata: { echo },
  });
  console.log(`submitted task=${submitted.id} state=${submitted.status.state}`);
  let resumed = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const view = await node.getTask(peer, submitted.id);
    if (view.status.state === "input-required") {
      console.log(`input-required: ${JSON.stringify(view.status.message)}`);
      if (args.get("auto-resume") === "true" && !resumed) {
        resumed = true;
        await node.sendTask(peer, {
          message: { role: "user", parts: [{ kind: "text", text: "approved" }], taskId: submitted.id },
        });
        console.log("resumed");
      }
    }
    if (view.status.state === "completed" || view.status.state === "failed" || view.status.state === "canceled") {
      console.log(`final=${view.status.state} message=${JSON.stringify(view.status.message)}`);
      console.log(`artifacts=${JSON.stringify(view.artifacts ?? [])}`);
      await node.stop();
      return;
    }
    await sleep(100);
  }
  console.log("timed out waiting for terminal state");
  await node.stop();
}

function printHelp(): void {
  console.log("usage:");
  console.log("  node scripts/cross.ts serve --workgroup <id> --password <secret> [--port 11811] [--host 0.0.0.0] [--endpoint http://ip:port] [--name host]");
  console.log("  node scripts/cross.ts join  --peer <url> --workgroup <id> --password <secret> [--name guest]");
  console.log("  node scripts/cross.ts task  --config <file> --peer <url> [--text hello] [--echo '<json>'] [--auto-resume true]");
}

const { command, args } = parseArgs(process.argv.slice(2));
if (command === "serve") {
  await serve(args);
} else if (command === "join") {
  await join(args);
} else if (command === "task") {
  await task(args);
} else {
  printHelp();
}
