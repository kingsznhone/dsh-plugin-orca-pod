import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deriveWorkgroupKey } from "./crypto.ts";
import {
  DEFAULT_PORT,
  generateOrcaNodeId,
  isWorkgroupId,
  type OrcaNodeId,
  type WorkgroupId,
} from "./protocol.ts";

export type BindConfig = {
  host: string;
  port: number;
};

export type OrcaNodeConfig = {
  orca_node_id: OrcaNodeId;
  display_name: string;
  workgroup_id: WorkgroupId;
  endpoint: string | null;
  bind: BindConfig;
  data_root: string;
  key_base64: string;
  created_at: string;
};

export type CreateOrcaNodeConfigOptions = {
  workgroupId: string;
  password: string;
  dataRoot?: string;
  host?: string;
  port?: number;
  displayName?: string;
  orcaNodeId?: OrcaNodeId;
  endpoint?: string | null;
};

export function defaultDataRoot(): string {
  return process.env.ORCA_POD_HOME ?? join(homedir(), ".orca-pod");
}

export function configPath(dataRoot: string): string {
  return join(dataRoot, "config.json");
}

export function createOrcaNodeConfig(options: CreateOrcaNodeConfigOptions): OrcaNodeConfig {
  if (!isWorkgroupId(options.workgroupId)) {
    throw new Error("workgroup id must match [a-z0-9][a-z0-9-]{1,31}");
  }
  if (!options.password) {
    throw new Error("password must not be empty");
  }
  const key = deriveWorkgroupKey(options.workgroupId, options.password);
  return {
    orca_node_id: options.orcaNodeId ?? generateOrcaNodeId(),
    display_name: options.displayName ?? `orca-${generateOrcaNodeId()}`,
    workgroup_id: options.workgroupId,
    endpoint: options.endpoint ?? null,
    bind: { host: options.host ?? "127.0.0.1", port: options.port ?? DEFAULT_PORT },
    data_root: options.dataRoot ?? defaultDataRoot(),
    key_base64: key.toString("base64"),
    created_at: new Date().toISOString(),
  };
}

export async function loadConfig(path: string): Promise<OrcaNodeConfig> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}

export function validateConfig(value: unknown): OrcaNodeConfig {
  if (typeof value !== "object" || value === null) throw new Error("config must be an object");
  const record = value as Record<string, unknown>;
  const bind = record["bind"];
  if (typeof bind !== "object" || bind === null) throw new Error("config.bind must be an object");
  const bindRecord = bind as Record<string, unknown>;
  const config: OrcaNodeConfig = {
    orca_node_id: String(record["orca_node_id"] ?? ""),
    display_name: String(record["display_name"] ?? ""),
    workgroup_id: String(record["workgroup_id"] ?? ""),
    endpoint: typeof record["endpoint"] === "string" ? record["endpoint"] : null,
    bind: {
      host: String(bindRecord["host"] ?? "127.0.0.1"),
      port: Number(bindRecord["port"] ?? DEFAULT_PORT),
    },
    data_root: String(record["data_root"] ?? defaultDataRoot()),
    key_base64: String(record["key_base64"] ?? ""),
    created_at: String(record["created_at"] ?? new Date().toISOString()),
  };
  if (!isWorkgroupId(config.workgroup_id)) throw new Error("config.workgroup_id is invalid");
  if (!config.key_base64) throw new Error("config.key_base64 is missing");
  return config;
}

export async function saveConfig(path: string, config: OrcaNodeConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export function workgroupKey(config: OrcaNodeConfig): Buffer {
  return Buffer.from(config.key_base64, "base64");
}
