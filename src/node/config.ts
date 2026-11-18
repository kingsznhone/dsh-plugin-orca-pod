import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { PROFILES_DIR } from "@deepseek-ai/dsh-app-boot";
import { DSH_HOME_ENV, resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { deriveWorkgroupKey } from "../core/signing.ts";
import { loadOrCreateIdentity, shortenNodeId } from "../core/identity.ts";
import { describeIssue, parseSchema } from "../core/schema.ts";
import { OrcaNodeIdSchema, type OrcaNodeId, type WorkgroupId } from "../core/wire/peer.ts";
import { nodeSettings, parseSettings, type NodeSettings, type Settings } from "./settings.ts";

/** What `config.json` holds: the node settings plus the identity and the derived workgroup key. */
export type OrcaNodeConfig = NodeSettings & {
  orca_node_id: OrcaNodeId;
  display_name: string;
  workgroup_id: WorkgroupId;
  data_root: string;
  key_base64: string;
};

/**
 * Default data directory: an explicit `ORCA_POD_HOME`, else this DSH profile's
 * directory, else the DSH home (`$DSH_HOME`, default `~/.dsh`). One profile
 * therefore owns one identity, port and task store, and two profiles never
 * share them. There is no fallback to any earlier location.
 *
 * The host process does not always export `DSH_PROFILE_DIR` to its own plugins
 * (only to the shells it spawns), so the plugin also passes the loader
 * `baseUrl` — the profile directory for a profile-scoped host.
 */
export function defaultDataRoot(
  env: Record<string, string | undefined> = process.env,
  baseUrl?: string,
  /** The DSH home as the host resolved it (`ctx.dshHomePath()`); otherwise DSH's own rule over `env`. */
  dshHome?: string,
): string {
  const explicit = nonEmpty(env.ORCA_POD_HOME);
  if (explicit !== undefined) return resolve(explicit);
  const profile = nonEmpty(env.DSH_PROFILE_DIR) ?? profileDirFrom(baseUrl);
  if (profile !== undefined) return resolve(profile, "orca-pod");
  return resolve(resolveDshHome(dshHome, env), "orca-pod");
}

/** The environment variables `defaultDataRoot` reads. */
export const DATA_ROOT_ENV = ["ORCA_POD_HOME", "DSH_PROFILE_DIR", DSH_HOME_ENV] as const;

/** A trimmed environment value, or undefined when unset or blank. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** The profile directory behind a loader `baseUrl`, when it names one. */
function profileDirFrom(baseUrl?: string): string | undefined {
  if (baseUrl === undefined || baseUrl.length === 0) return undefined;
  const path = baseUrl.startsWith("file:") ? filePathOf(baseUrl) : baseUrl;
  if (path === undefined || !isAbsolute(path)) return undefined;
  // A profile lives at `<DSH home>/<PROFILES_DIR>/<name>` (DSH's own layout).
  return basename(dirname(path)) === PROFILES_DIR ? path : undefined;
}

/** The path a `file:` URL names, or undefined when it is not a valid one. */
function filePathOf(url: string): string | undefined {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
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
export async function createOrcaNodeConfig(input: Partial<Settings>): Promise<OrcaNodeConfig> {
  const settings = parseSettings(input);
  const { workgroup_id, workgroup_password, data_root = defaultDataRoot() } = settings;
  if (workgroup_id === undefined || workgroup_password.length === 0) {
    throw new Error("workgroup_id and workgroup_password are required");
  }
  const orcaNodeId = (await loadOrCreateIdentity(data_root)).orcaNodeId;
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

/** The two fields only a persisted config has besides the settings: who the node is and its workgroup key. */
const PersistedIdentitySchema = z.object({ orca_node_id: OrcaNodeIdSchema, key_base64: z.string() });

/** Read a persisted config: the same field parser as every other source, plus the identity and key. */
export function validateConfig(value: unknown): OrcaNodeConfig {
  const settings = parseSettings(value);
  const identity = parseSchema(PersistedIdentitySchema, value);
  if (!identity.ok) throw new Error(`config.${describeIssue(identity.issue)}`);
  const { workgroup_id, display_name, data_root } = settings;
  if (workgroup_id === undefined) throw new Error("config.workgroup_id is required");
  if (display_name === undefined) throw new Error("config.display_name is required");
  if (data_root === undefined) throw new Error("config.data_root is required");
  return { ...nodeSettings(settings), workgroup_id, display_name, data_root, ...identity.value };
}

/** Write atomically; the file holds the workgroup key, so it is owner-only from the start. */
export async function saveConfig(path: string, config: OrcaNodeConfig): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
}

export function workgroupKey(config: OrcaNodeConfig): Buffer {
  return Buffer.from(config.key_base64, "base64");
}
