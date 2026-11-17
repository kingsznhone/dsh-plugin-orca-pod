/** What every `orca-node` subcommand shares: flags, config, the signing client and output. */

import process from "node:process";
import { parseArgs } from "node:util";

import { configPath, defaultDataRoot, loadConfig, type OrcaNodeConfig } from "../node/config.ts";
import { MembersResponseSchema, type PeerView } from "../protocol/peer.ts";
import type { PeerClient } from "../protocol/client.ts";
import type { TaskView } from "../protocol/task.ts";
import { loadIdentity, type NodeIdentity } from "../security/identity.ts";
import { createPeerClient } from "../transport/peer-client.ts";

export const OPTIONS = {
  config: { type: "string" },
  "data-root": { type: "string" },
  peer: { type: "string" },
  bind: { type: "string" },
  port: { type: "string" },
  text: { type: "string" },
  "local-task": { type: "string" },
  context: { type: "string" },
  "permission-mode": { type: "string" },
  model: { type: "string" },
  "reasoning-effort": { type: "string" },
  echo: { type: "string" },
  metadata: { type: "string" },
  task: { type: "string" },
  timeout: { type: "string" },
  ttl: { type: "string" },
  path: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export type OptionName = keyof typeof OPTIONS;

export const COMMON_OPTIONS = ["config", "data-root"] as const;

export function parseCli(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

export type Flags = ReturnType<typeof parseCli>["values"];

/** Parsed command line of one subcommand: its flags and the positionals after the command name. */
export type CommandArgs = { flags: Flags; positionals: string[] };

/** One subcommand: the options it accepts and how it runs. Resolves to the exit code, or nothing to keep running. */
export type Command = {
  options: readonly OptionName[];
  /** Positional arguments after the command name; none unless stated. */
  maxPositionals?: number;
  run(args: CommandArgs): Promise<number | undefined>;
};

export function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** A positive number of seconds, or `undefined` when the flag is absent. */
export function positiveSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`--${name} must be a positive number of seconds`);
  return seconds;
}

export async function loadNodeConfig(flags: Flags): Promise<OrcaNodeConfig> {
  if (flags.config !== undefined) return loadConfig(flags.config);
  return loadConfig(configPath(flags["data-root"] ?? defaultDataRoot()));
}

export function localEndpoint(config: OrcaNodeConfig): string {
  return config.endpoints[0] ?? `http://${config.bind_host}:${config.port}`;
}

/**
 * Local control plane: always dial loopback, never a published endpoint. The
 * gateway only accepts child links from loopback without proxy headers (§7.1).
 */
export function localControlEndpoint(config: OrcaNodeConfig): string {
  const host = config.bind_host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${host}:${config.port}`;
}

export function nodeIdentity(config: OrcaNodeConfig): NodeIdentity {
  const identity = loadIdentity(config.data_root);
  if (identity === null || identity.orcaNodeId !== config.orca_node_id) {
    throw new Error("identity.json is missing or does not match config.orca_node_id");
  }
  return identity;
}

/**
 * The one signing client of this process, with the identity read once. It reaches
 * this node (over loopback) and the members this node knows: a peer the local
 * node has not joined is refused, not joined behind the caller's back.
 */
export async function peerClient(config: OrcaNodeConfig, peer: string): Promise<PeerClient> {
  let roster: PeerView[] = [];
  const client = createPeerClient({
    identity: nodeIdentity(config),
    fetch: (url, init) => fetch(url, init),
    timeoutMs: config.request_timeout_ms ?? 30_000,
    selfEndpoints: () => [localControlEndpoint(config), localEndpoint(config), ...config.endpoints],
    roster: () => roster,
  });
  if (client.idOf(peer) === undefined) {
    const members = await client.call(localEndpoint(config), {
      method: "GET",
      path: "/cluster/members",
      reply: MembersResponseSchema,
    });
    roster = members.members;
    if (client.idOf(peer) === undefined) {
      throw new Error(`${peer} is not a member known to this node; join it first (orca-node serve --peer ${peer})`);
    }
  }
  return client;
}

function statusLine(view: TaskView): string {
  const part = view.status.message?.parts.find((item) => item.kind === "text");
  const text = part !== undefined && part.kind === "text" ? part.text : "";
  return `task ${view.id} ${view.status.state}${view.status.reason ? ` (${view.status.reason})` : ""}${text ? `: ${text}` : ""}`;
}

export function printView(view: TaskView, flags: Flags): void {
  process.stdout.write(`${flags.json === true ? JSON.stringify(view, null, 2) : statusLine(view)}\n`);
}
