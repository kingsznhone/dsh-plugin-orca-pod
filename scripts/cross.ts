/**
 * Cross-machine manual test: runs one orca node in this process, with an identity
 * made fresh on every run, so two machines can be pointed at each other by hand.
 *
 *   node --import tsx scripts/cross.ts serve --workgroup <id> --password <secret> [--port 11811] [--host 0.0.0.0]
 *   node --import tsx scripts/cross.ts join  --peer <url> --workgroup <id> --password <secret> [--name guest]
 *   node --import tsx scripts/cross.ts task  --peer <url> --workgroup <id> --password <secret> [--text hello] [--script '<json>']
 *
 * Both sides run the scripted test executor (`test/support/script.ts`), so no
 * model credentials are needed: the task's text is a script that says how it ends.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { DEFAULT_PORT } from "../src/core/constants.ts";
import { WorkgroupIdSchema } from "../src/core/ids.ts";
import type { Orca } from "../src/node/orca.ts";
import { isTerminal } from "../src/task/wire.ts";
import { newNode } from "../test/support/node.ts";
import { scriptMessage, type Script } from "../test/support/script.ts";

const OPTIONS = {
  peer: { type: "string" },
  workgroup: { type: "string" },
  password: { type: "string" },
  name: { type: "string" },
  host: { type: "string" },
  port: { type: "string" },
  endpoint: { type: "string" },
  text: { type: "string" },
  script: { type: "string" },
} as const;

type Args = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function required(value: string | undefined, key: string): string {
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

/** A node for the command line's workgroup, listening on every interface; it runs in memory. */
function nodeFor(args: Args, defaults: { name: string; port: number }): Orca {
  return newNode(
    {
      workgroup_id: WorkgroupIdSchema.parse(required(args.workgroup, "workgroup")),
      workgroup_password: required(args.password, "password"),
      display_name: args.name ?? defaults.name,
      bind_host: args.host ?? "0.0.0.0",
      port: Number(args.port ?? defaults.port),
      endpoints: args.endpoint === undefined ? [] : [args.endpoint],
    },
    { logger: console },
  );
}

/** Report the roster every two seconds until the process is stopped. */
async function watch(node: Orca): Promise<void> {
  const shutdown = async (): Promise<void> => {
    await node.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  for (;;) {
    await sleep(2000);
    const members = node.mesh.peers();
    console.log(
      `members=${members.length} digest=${node.mesh.digest().slice(0, 12)} peers=${members.map((member) => `${member.id}:${member.state}`).join(",")}`,
    );
  }
}

async function serve(args: Args): Promise<void> {
  const node = nodeFor(args, { name: `host-${process.pid}`, port: DEFAULT_PORT });
  const { url } = await node.start();
  console.log(`serving on ${url} node=${node.mesh.self.id}`);
  await watch(node);
}

async function join(args: Args): Promise<void> {
  const peer = required(args.peer, "peer");
  const node = nodeFor(args, { name: `guest-${process.pid}`, port: 0 });
  const { url } = await node.start();
  const contacted = await node.mesh.probe(peer);
  console.log(`contacted ${contacted.displayName} (${contacted.id}) at ${peer} as ${node.mesh.self.id} on ${url}`);
  console.log(
    `members=${node.mesh
      .peers()
      .map((member) => `${member.id}@${member.endpoints[0] ?? "-"}`)
      .join(",")}`,
  );
  console.log(`digest=${node.mesh.digest()}`);
  await watch(node);
}

async function task(args: Args): Promise<void> {
  const peer = required(args.peer, "peer");
  const node = nodeFor(args, { name: `task-${process.pid}`, port: 0 });
  await node.start();
  try {
    // Peer calls only reach members, so admit this node at the target first.
    const target = await node.mesh.probe(peer);
    const script: Script = args.script
      ? (JSON.parse(args.script) as Script)
      : { final: { state: "completed", text: args.text ?? "hello from host" } };
    const submitted = await target.sendTask({ message: scriptMessage(script) });
    console.log(`submitted task=${submitted.id} state=${submitted.status.state}`);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const view = await target.getTask(submitted.id);
      if (isTerminal(view.status.state)) {
        console.log(`final=${view.status.state} message=${JSON.stringify(view.status.message)}`);
        return;
      }
      await sleep(100);
    }
    console.log("timed out waiting for terminal state");
  } finally {
    await node.stop();
  }
}

const [command = "help", ...rest] = process.argv.slice(2);
const args = parseArgs({ args: rest, options: OPTIONS }).values;
if (command === "serve") await serve(args);
else if (command === "join") await join(args);
else if (command === "task") await task(args);
else console.log("usage: node --import tsx scripts/cross.ts serve|join|task --workgroup <id> --password <secret> ...");
