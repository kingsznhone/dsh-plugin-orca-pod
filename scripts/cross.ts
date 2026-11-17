import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { bodySha256 } from "../src/security/crypto.ts";
import { errorMessage } from "../src/kernel/errors.ts";
import { createOrcaNodeConfig, defaultDataRoot, loadConfig, saveConfig } from "../src/node/config.ts";
import { createOrcaNode, type OrcaNode } from "../src/node/orca-node.ts";
import { DEFAULT_PORT } from "../src/protocol/constants.ts";
import { WorkgroupIdSchema } from "../src/protocol/peer.ts";

const SERVE = {
  workgroup: { type: "string" },
  password: { type: "string" },
  config: { type: "string" },
  name: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  endpoint: { type: "string" },
} as const;

const JOIN = {
  peer: { type: "string" },
  workgroup: { type: "string" },
  password: { type: "string" },
  name: { type: "string" },
  port: { type: "string" },
  endpoint: { type: "string" },
} as const;

const TASK = {
  config: { type: "string" },
  peer: { type: "string" },
  text: { type: "string" },
  echo: { type: "string" },
  "auto-resume": { type: "boolean" },
} as const;

const FETCH = {
  url: { type: "string" },
} as const;

type Values<T extends ParseArgsOptionsConfig> = ReturnType<typeof parseArgs<{ options: T }>>["values"];

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

async function withNode(orcaNode: OrcaNode, keepAlive: boolean): Promise<void> {
  const shutdown = async (): Promise<void> => {
    await orcaNode.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  if (!keepAlive) return;
  for (;;) {
    await sleep(2000);
    const members = orcaNode.members();
    console.log(
      `members=${members.length} digest=${orcaNode.membersDigest().slice(0, 12)} peers=${members.map((member) => `${member.orca_node_id}:${member.state}`).join(",")}`,
    );
  }
}

async function serve(args: Values<typeof SERVE>): Promise<void> {
  const workgroupId = WorkgroupIdSchema.parse(required(args.workgroup, "workgroup"));
  const password = required(args.password, "password");
  const configFile = args.config ?? `${defaultDataRoot()}/config.json`;
  const exists = await loadConfig(configFile).catch(() => null);
  const config =
    exists ??
    createOrcaNodeConfig({
      workgroup_id: workgroupId,
      workgroup_password: password,
      display_name: args.name ?? `host-${process.pid}`,
      bind_host: args.host ?? "0.0.0.0",
      port: Number(args.port ?? DEFAULT_PORT),
      endpoints: args.endpoint === undefined ? [] : [args.endpoint],
    });
  if (!exists) await saveConfig(configFile, config);
  const orcaNode = createOrcaNode({ config, logger: console });
  const { url } = await orcaNode.start();
  console.log(`serving on ${url} node=${orcaNode.orcaNodeId} config=${configFile}`);
  await withNode(orcaNode, true);
}

async function join(args: Values<typeof JOIN>): Promise<void> {
  const peer = required(args.peer, "peer");
  const workgroupId = WorkgroupIdSchema.parse(required(args.workgroup, "workgroup"));
  const password = required(args.password, "password");
  const config = createOrcaNodeConfig({
    workgroup_id: workgroupId,
    workgroup_password: password,
    display_name: args.name ?? `guest-${process.pid}`,
    bind_host: "0.0.0.0",
    port: Number(args.port ?? 0),
    endpoints: args.endpoint === undefined ? [] : [args.endpoint],
  });
  const orcaNode = createOrcaNode({ config, logger: console });
  const { url } = await orcaNode.start();
  const response = await orcaNode.join(peer);
  console.log(`joined ${peer} as ${orcaNode.orcaNodeId} on ${url}`);
  console.log(
    `members=${response.members.map((member) => `${member.orca_node_id}@${member.endpoints[0] ?? "-"}`).join(",")}`,
  );
  console.log(`digest=${response.members_digest}`);
  for (const member of orcaNode.members()) {
    const [memberEndpoint] = member.endpoints;
    if (memberEndpoint && memberEndpoint !== orcaNode.endpoints[0]) {
      await orcaNode.heartbeat(memberEndpoint).catch((error: unknown) => {
        console.log(`heartbeat ${memberEndpoint} failed: ${errorMessage(error)}`);
      });
    }
  }
  await withNode(orcaNode, true);
}

async function task(args: Values<typeof TASK>): Promise<void> {
  const configFile = required(args.config, "config");
  const peer = required(args.peer, "peer");
  const config = await loadConfig(configFile);
  const orcaNode = createOrcaNode({ config, logger: console });
  // Peer calls only reach members, so admit this node at the target first.
  await orcaNode.join(peer);
  const echo = args.echo
    ? (JSON.parse(args.echo) as Record<string, unknown>)
    : { final: { state: "completed", text: args.text ?? "echo from host" } };
  const submitted = await orcaNode.sendTask(peer, {
    message: { role: "user", parts: [{ kind: "text", text: args.text ?? "run echo" }] },
    metadata: { echo },
  });
  console.log(`submitted task=${submitted.id} state=${submitted.status.state}`);
  let resumed = false;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const view = await orcaNode.getTask(peer, submitted.id);
    if (view.status.state === "input-required") {
      console.log(`input-required: ${JSON.stringify(view.status.message)}`);
      if (args["auto-resume"] === true && !resumed) {
        resumed = true;
        await orcaNode.sendTask(peer, {
          message: { role: "user", parts: [{ kind: "text", text: "approved" }], taskId: submitted.id },
        });
        console.log("resumed");
      }
    }
    if (view.status.state === "completed" || view.status.state === "failed" || view.status.state === "canceled") {
      console.log(`final=${view.status.state} message=${JSON.stringify(view.status.message)}`);
      console.log(`artifacts=${JSON.stringify(view.artifacts ?? [])}`);
      await orcaNode.stop();
      return;
    }
    await sleep(100);
  }
  console.log("timed out waiting for terminal state");
  await orcaNode.stop();
}

/**
 * Fetch a published file across machines (§5.6): the link `orca-node publish`
 * printed on the other node, downloaded without any key, and checked against
 * the sha256 the link names.
 */
async function fetchBlob(args: Values<typeof FETCH>): Promise<void> {
  const url = new URL(required(args.url, "url"));
  const blobId = url.pathname.split("/").pop() ?? "";
  const response = await fetch(url);
  const bytes = Buffer.from(await response.arrayBuffer());
  console.log(`status=${response.status} bytes=${bytes.length} sha_match=${bodySha256(bytes) === blobId}`);
}

function printHelp(): void {
  console.log("usage:");
  console.log(
    `  node scripts/cross.ts serve --workgroup <id> --password <secret> [--port ${DEFAULT_PORT}] [--host 0.0.0.0] [--endpoint http://ip:port] [--name host]`,
  );
  console.log("  node scripts/cross.ts join  --peer <url> --workgroup <id> --password <secret> [--name guest]");
  console.log(
    "  node scripts/cross.ts task  --config <file> --peer <url> [--text hello] [--echo '<json>'] [--auto-resume]",
  );
  console.log("  node scripts/cross.ts fetch --url <link printed by orca-node publish>");
}

const [command = "help", ...rest] = process.argv.slice(2);
if (command === "serve") {
  await serve(parseArgs({ args: rest, options: SERVE }).values);
} else if (command === "join") {
  await join(parseArgs({ args: rest, options: JOIN }).values);
} else if (command === "task") {
  await task(parseArgs({ args: rest, options: TASK }).values);
} else if (command === "fetch") {
  await fetchBlob(parseArgs({ args: rest, options: FETCH }).values);
} else {
  printHelp();
}
