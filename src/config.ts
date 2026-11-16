import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deriveWorkgroupKey } from "./crypto.ts";
import { isNodeId, loadOrCreateIdentity, shortenNodeId } from "./identity.ts";
import { nodeSettings, parseSettings, type NodeSettings, type Settings } from "./settings.ts";

/** What `config.json` holds: the node settings plus the identity and the derived workgroup key. */
export type OrcaNodeConfig = NodeSettings & {
  orca_node_id: string;
  display_name: string;
  workgroup_id: string;
  data_root: string;
  key_base64: string;
};

export function defaultDataRoot(): string {
  return process.env.ORCA_POD_HOME ?? join(homedir(), ".orca-pod");
}

export function configPath(dataRoot: string): string {
  return join(dataRoot, "config.json");
}

/**
 * Config to persist after `serve` learns its listen URL, or null when nothing
 * changes. Explicitly configured endpoints (public/LAN URLs) always win over
 * the listen address; only an empty list is learned, and a `port: 0` bind still
 * needs its real port written back.
 */
export function endpointWriteback(config: OrcaNodeConfig, listenUrl: string): OrcaNodeConfig | null {
  const learned = Number(new URL(listenUrl).port);
  const port = Number.isInteger(learned) && learned > 0 ? learned : config.port;
  if (config.endpoints.length === 0) return { ...config, endpoints: [listenUrl], port };
  if (config.port === 0 && port !== 0) return { ...config, port };
  return null;
}

/**
 * Settings (plus the workgroup password) to a persistable config: parse once,
 * load or create the identity under `data_root` (the orca node id is its
 * Ed25519 public key, §7.1), derive the workgroup key. The password is not kept.
 */
export function createOrcaNodeConfig(input: Partial<Settings>): OrcaNodeConfig {
  const settings = parseSettings(input);
  const { workgroup_id, workgroup_password, data_root = defaultDataRoot() } = settings;
  if (workgroup_id === undefined || workgroup_password.length === 0) {
    throw new Error("workgroup_id and workgroup_password are required");
  }
  const orcaNodeId = loadOrCreateIdentity(data_root).orcaNodeId;
  return {
    ...nodeSettings(settings),
    workgroup_id,
    data_root,
    orca_node_id: orcaNodeId,
    display_name: settings.display_name ?? shortenNodeId(orcaNodeId),
    key_base64: deriveWorkgroupKey(workgroup_id, workgroup_password).toString("base64"),
  };
}

export async function loadConfig(path: string): Promise<OrcaNodeConfig> {
  return validateConfig(JSON.parse(await readFile(path, "utf8")));
}

/** Read a persisted config: the same field parser as every other source, plus the identity and key. */
export function validateConfig(value: unknown): OrcaNodeConfig {
  const settings = parseSettings(value);
  const { orca_node_id, key_base64 } = value as Record<string, unknown>;
  if (!isNodeId(orca_node_id)) throw new Error("config.orca_node_id must be an Ed25519 public key");
  if (typeof key_base64 !== "string") throw new Error("config.key_base64 must be a string");
  for (const key of ["workgroup_id", "display_name", "data_root"] as const) {
    if (settings[key] === undefined) throw new Error(`config.${key} is required`);
  }
  return { ...nodeSettings(settings), orca_node_id, key_base64 } as OrcaNodeConfig;
}

/** Write atomically; the file holds the workgroup key, so it is owner-only from the start. */
export async function saveConfig(path: string, config: OrcaNodeConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export function workgroupKey(config: OrcaNodeConfig): Buffer {
  return Buffer.from(config.key_base64, "base64");
}
