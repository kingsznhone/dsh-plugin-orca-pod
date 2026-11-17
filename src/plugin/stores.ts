/**
 * Where the pod lifecycle keeps what must outlive a node restart (§7.3, §9.2):
 * the workgroup password and the plugin config behind `PodStores` (the DSH
 * credential store and config editor, or memory without a host), and the peers
 * joined at runtime in `<data_root>/peers.json`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { Context, Logger } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
// `ctx.configEditor` is injected by this plugin; the service package owns the type.
import type {} from "@deepseek-ai/dsh-config-editor";

import { errorMessage } from "../kernel/errors.ts";
import { isRecord } from "../kernel/schema.ts";
import { parseSettings, type Settings } from "../node/settings.ts";
import { normalizePeerUrl } from "../transport/net.ts";
import type { PodHandle } from "./lifecycle.ts";

/** Settings as the profile stores them: every key optional, `null` or absent means "default". */
export type ConfigFields = { [K in keyof Settings]?: Settings[K] | null };

/**
 * A raw plugin config as stored in the profile. The Loader has checked it
 * against the plugin's `Config` schema, but it is not canonical yet (that is
 * `parseSettings`' job), and keys this version does not know are kept as they
 * are so a write never drops them.
 */
export type RawConfig = ConfigFields & { [key: string]: unknown };

/**
 * Persistence the lifecycle needs from its host. In DSH these are the
 * credential seam and the config editor (`createHostStores`);
 * without a host, `createMemoryStores` keeps both in memory.
 */
export interface PodStores {
  /** The stored password behind a credential reference; undefined when absent or empty. */
  readSecret(ref: string): Promise<string | undefined>;
  writeSecret(ref: string, value: string): Promise<void>;
  clearSecret(ref: string): Promise<void>;
  /**
   * Persist the next plugin config, derived from the stored raw one. Resolves to
   * false when `change` changes nothing. On true the host applies the config the
   * way it applies any config change: in DSH the Loader restarts the plugin (this
   * handle is disposed before the promise settles), in memory the handle adopts
   * it. Never call it from inside the lifecycle queue: a host restart waits for
   * that queue to drain.
   */
  writeConfig(change: (raw: RawConfig) => RawConfig): Promise<boolean>;
  /** In-memory stores only: the handle that receives config writes. */
  attach?(handle: PodHandle): void;
}

/**
 * The lifecycle's persistence on a DSH host (§7.3): the password in the
 * credential store, settings in this plugin's profile entry. A config write goes
 * through `configEditor.edit`, which validates it with `Config`, writes the
 * profile patch and has the Loader restart this plugin with the new config.
 */
export function createHostStores(ctx: Pick<Context, "credentials" | "configEditor" | "fiber">): PodStores {
  return {
    async readSecret(ref) {
      const hit = await ctx.credentials.resolve(ref as CredentialRef);
      return hit === undefined || hit.value.length === 0 ? undefined : hit.value;
    },
    writeSecret: (ref, value) => ctx.credentials.set(ref as CredentialRef, value),
    clearSecret: (ref) => ctx.credentials.unset(ref as CredentialRef),
    async writeConfig(change) {
      const entry: Entry | undefined = ctx.fiber.entry;
      if (entry === undefined)
        throw new Error("orca-pod was not loaded from a profile entry; its config cannot be saved");
      const current = structuredClone((entry.options.config ?? {}) as RawConfig);
      if (isDeepStrictEqual(change(structuredClone(current)), current)) return false;
      await ctx.configEditor.edit(entry, (raw) => change(raw));
      return true;
    },
  };
}

/**
 * Stores for a pod without a DSH host (tests, smoke runs): the raw config and
 * the secrets live in memory, and a config write is handed to the attached
 * handle the way the Loader would restart the plugin.
 */
export function createMemoryStores(raw: RawConfig = {}): PodStores & {
  secrets: Map<string, string>;
  raw(): RawConfig;
  attach(handle: PodHandle): void;
} {
  let current: RawConfig = structuredClone(raw);
  const secrets = new Map<string, string>();
  let attached: PodHandle | null = null;
  return {
    secrets,
    raw: () => structuredClone(current),
    attach(handle) {
      attached = handle;
    },
    async readSecret(ref) {
      const value = secrets.get(ref);
      return value === undefined || value.length === 0 ? undefined : value;
    },
    async writeSecret(ref, value) {
      if (value.length === 0) throw new Error("an empty credential cannot be stored; remove it instead");
      secrets.set(ref, value);
    },
    async clearSecret(ref) {
      secrets.delete(ref);
    },
    async writeConfig(change) {
      const next = change(structuredClone(current));
      if (isDeepStrictEqual(next, current)) return false;
      const parsed = parseSettings(next);
      current = next;
      await attached?.adopt(parsed);
      return true;
    },
  };
}

/** Treat "file does not exist" as an empty install; other read errors are logged. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Path of the runtime peer state next to the persisted orca node config. */
export function peerStatePath(dataRoot: string): string {
  return join(dataRoot, "peers.json");
}

/** Peers remembered from earlier runs; a missing or unreadable file means none. */
export async function loadRememberedPeers(dataRoot: string, logger: Logger): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(peerStatePath(dataRoot), "utf8"));
    const peers = isRecord(parsed) && Array.isArray(parsed.peers) ? parsed.peers : [];
    return peers.filter((peer): peer is string => typeof peer === "string").map(normalizePeerUrl);
  } catch (error) {
    if (!isMissingFile(error)) logger.warn(`orca-pod: ignoring unreadable peer state: ${errorMessage(error)}`);
    return [];
  }
}

export async function saveRememberedPeers(dataRoot: string, peers: string[]): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(peerStatePath(dataRoot), `${JSON.stringify({ peers }, null, 2)}\n`, "utf8");
}
