import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { deriveWorkgroupKey } from "./crypto.ts";
import {
  DEFAULT_PORT,
  generateOrcaNodeId,
  isPermissionMode,
  isWorkgroupId,
  type OrcaNodeId,
  type PermissionMode,
  type WorkgroupId,
} from "./protocol.ts";

export type BindConfig = {
  host: string;
  port: number;
};

export type ExecutorKind = "echo" | "headless" | "acp";

/** Local executor choice and its options; origin cannot override these (§6.2). */
export type HeadlessExecutorConfig = {
  command?: string;
  profile?: string;
  permission_mode?: string;
  approval_policy?: "ask" | "never";
  extra_args?: string[];
};

/** One MCP server handed to the ACP session at session/new (§6.15). */
export type AcpMcpServer = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** ACP executor options: the `dsh --profile acp` stdio server (§6.15). */
export type AcpExecutorConfig = {
  command?: string;
  profile?: string;
  extra_args?: string[];
  /** MCP servers passed to session/new — how an ACP agent gets extra tools. */
  mcp_servers?: AcpMcpServer[];
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
  executor?: ExecutorKind;
  headless?: HeadlessExecutorConfig;
  acp?: AcpExecutorConfig;
  /** Local ceiling for tasks this orca node runs; origin sessions can only narrow it (§7.10). */
  permission_mode?: PermissionMode;
  /** Auto-reject parked approvals after this many seconds; unset waits forever (§7.12). */
  approval_timeout_s?: number;
  /** Allow candidate endpoints on public IPs (§7.7). Default: private ranges only. */
  allow_public_peers?: boolean;
  /** Reject loopback candidate endpoints; defaults to allowing them for same-host meshes (§7.7). */
  allow_loopback_peers?: boolean;
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
  executor?: ExecutorKind;
  headless?: HeadlessExecutorConfig;
  acp?: AcpExecutorConfig;
  permissionMode?: PermissionMode;
  approvalTimeoutS?: number;
  allowPublicPeers?: boolean;
  allowLoopbackPeers?: boolean;
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
  if (
    options.approvalTimeoutS !== undefined &&
    (!Number.isFinite(options.approvalTimeoutS) || options.approvalTimeoutS <= 0)
  ) {
    throw new Error("approvalTimeoutS must be a positive number of seconds");
  }
  if (options.permissionMode !== undefined && !isPermissionMode(options.permissionMode)) {
    throw new Error('permissionMode must be "read-only", "workspace-write", or "danger-full-access"');
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
    ...(options.executor ? { executor: options.executor } : {}),
    ...(options.headless ? { headless: options.headless } : {}),
    ...(options.acp ? { acp: options.acp } : {}),
    ...(options.permissionMode ? { permission_mode: options.permissionMode } : {}),
      ...(options.approvalTimeoutS !== undefined ? { approval_timeout_s: options.approvalTimeoutS } : {}),
  ...(options.allowPublicPeers !== undefined ? { allow_public_peers: options.allowPublicPeers } : {}),
  ...(options.allowLoopbackPeers !== undefined ? { allow_loopback_peers: options.allowLoopbackPeers } : {}),
  };
}

export async function loadConfig(path: string): Promise<OrcaNodeConfig> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}

function parseHeadlessConfig(value: unknown): HeadlessExecutorConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config.headless must be an object");
  }
  const record = value as Record<string, unknown>;
  const config: HeadlessExecutorConfig = {};
  for (const key of ["command", "profile", "permission_mode"] as const) {
    const raw = record[key];
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.length === 0) throw new Error(`config.headless.${key} must be a non-empty string`);
      config[key] = raw;
    }
  }
  const approval = record["approval_policy"];
  if (approval !== undefined) {
    if (approval !== "ask" && approval !== "never") throw new Error('config.headless.approval_policy must be "ask" or "never"');
    config.approval_policy = approval;
  }
  const extra = record["extra_args"];
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.some((item) => typeof item !== "string")) {
      throw new Error("config.headless.extra_args must be a string array");
    }
    config.extra_args = extra as string[];
  }
  return config;
}

function parseAcpConfig(value: unknown): AcpExecutorConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("config.acp must be an object");
  }
  const record = value as Record<string, unknown>;
  const config: AcpExecutorConfig = {};
  for (const key of ["command", "profile"] as const) {
    const raw = record[key];
    if (raw !== undefined) {
      if (typeof raw !== "string" || raw.length === 0) throw new Error(`config.acp.${key} must be a non-empty string`);
      config[key] = raw;
    }
  }
  const extra = record["extra_args"];
  if (extra !== undefined) {
    if (!Array.isArray(extra) || extra.some((item) => typeof item !== "string")) {
      throw new Error("config.acp.extra_args must be a string array");
    }
    config.extra_args = extra as string[];
  }
  const mcpServers = record["mcp_servers"];
  if (mcpServers !== undefined) {
    if (!Array.isArray(mcpServers)) throw new Error("config.acp.mcp_servers must be an array");
    config.mcp_servers = mcpServers.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new Error(`config.acp.mcp_servers[${index}] must be an object`);
      }
      const entry = item as Record<string, unknown>;
      if (typeof entry["name"] !== "string" || entry["name"].length === 0) {
        throw new Error(`config.acp.mcp_servers[${index}].name must be a non-empty string`);
      }
      if (typeof entry["command"] !== "string" || entry["command"].length === 0) {
        throw new Error(`config.acp.mcp_servers[${index}].command must be a non-empty string`);
      }
      const server: AcpMcpServer = { name: entry["name"], command: entry["command"] };
      if (entry["args"] !== undefined) {
        if (!Array.isArray(entry["args"]) || entry["args"].some((arg) => typeof arg !== "string")) {
          throw new Error(`config.acp.mcp_servers[${index}].args must be a string array`);
        }
        server.args = entry["args"] as string[];
      }
      if (entry["env"] !== undefined) {
        const env = entry["env"];
        if (typeof env !== "object" || env === null || Array.isArray(env)) {
          throw new Error(`config.acp.mcp_servers[${index}].env must be an object`);
        }
        const parsed: Record<string, string> = {};
        for (const [key, raw] of Object.entries(env)) {
          if (typeof raw !== "string") throw new Error(`config.acp.mcp_servers[${index}].env.${key} must be a string`);
          parsed[key] = raw;
        }
        server.env = parsed;
      }
      return server;
    });
  }
  return config;
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
  const executor = record["executor"];
  if (executor !== undefined) {
    if (executor !== "echo" && executor !== "headless" && executor !== "acp") {
      throw new Error('config.executor must be "echo", "headless" or "acp"');
    }
    config.executor = executor;
  }
  const headless = parseHeadlessConfig(record["headless"]);
  if (headless) config.headless = headless;
  const acp = parseAcpConfig(record["acp"]);
  if (acp) config.acp = acp;
  const permissionMode = record["permission_mode"];
  if (permissionMode !== undefined) {
    if (!isPermissionMode(permissionMode)) {
      throw new Error('config.permission_mode must be "read-only", "workspace-write", or "danger-full-access"');
    }
    config.permission_mode = permissionMode;
  }
  const approvalTimeout = record["approval_timeout_s"];
  if (approvalTimeout !== undefined) {
    if (typeof approvalTimeout !== "number" || !Number.isFinite(approvalTimeout) || approvalTimeout <= 0) {
      throw new Error("config.approval_timeout_s must be a positive number of seconds");
    }
    config.approval_timeout_s = approvalTimeout;
  }
  for (const key of ["allow_public_peers", "allow_loopback_peers"] as const) {
    const value = record[key];
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error(`config.${key} must be a boolean`);
      config[key] = value;
    }
  }
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
