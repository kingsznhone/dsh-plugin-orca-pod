/**
 * What the pod lifecycle keeps behind `PodStores` and what must outlive a node
 * restart (§7.3, §9.2): the workgroup password and the plugin config (the DSH
 * credential store and config editor, or memory without a host). The peers
 * joined at runtime are `peers-file.ts`.
 */

import { isDeepStrictEqual } from "node:util";

import type { Context } from "@deepseek-ai/cordis";
import type { Entry } from "@deepseek-ai/cordis-plugin-loader";
import type { CredentialRef } from "@deepseek-ai/dsh-credentials";
// `ctx.configEditor` is injected by this plugin; the service package owns the type.
import type {} from "@deepseek-ai/dsh-config-editor";

import { parseSettings, type ConfigFields } from "../node/settings.ts";

/**
 * A raw plugin config as stored in the profile. The Loader has checked it
 * against the plugin's `Config` schema, but it is not canonical yet (that is
 * `parseSettings`' job), and keys this version does not know are kept as they
 * are so a write never drops them.
 */
export type RawConfig = ConfigFields & { [key: string]: unknown };

/**
 * Persistence the lifecycle needs from its host. In DSH these are the
 * credential seam and the config editor (`HostPodStores`); without a host,
 * `MemoryPodStores` keeps both in memory.
 */
export interface PodStores {
  /**
   * Whether the host restarts the plugin by itself after a config write (the DSH
   * Loader does). When it does not, the lifecycle applies the written config
   * itself.
   */
  readonly restartsOnWrite: boolean;
  /** The stored password behind a credential reference; undefined when absent or empty. */
  readSecret(ref: CredentialRef): Promise<string | undefined>;
  writeSecret(ref: CredentialRef, value: string): Promise<void>;
  clearSecret(ref: CredentialRef): Promise<void>;
  /**
   * Persist the next plugin config, derived from the stored raw one. Resolves to
   * the stored config, or to null when `change` changes nothing. With
   * `restartsOnWrite` the host restarts the plugin (the lifecycle is disposed
   * before the promise settles). Never call it from inside the lifecycle queue:
   * a host restart waits for that queue to drain.
   */
  writeConfig(change: (raw: RawConfig) => RawConfig): Promise<RawConfig | null>;
}

/**
 * The lifecycle's persistence on a DSH host (§7.3): the password in the
 * credential store, settings in this plugin's profile entry. A config write goes
 * through `configEditor.edit`, which validates it with `Config`, writes the
 * profile patch and has the Loader restart this plugin with the new config.
 */
export class HostPodStores implements PodStores {
  readonly restartsOnWrite = true;

  constructor(private readonly ctx: Pick<Context, "credentials" | "configEditor" | "fiber">) {}

  async readSecret(ref: CredentialRef): Promise<string | undefined> {
    return (await this.ctx.credentials.resolve(ref))?.value;
  }

  writeSecret(ref: CredentialRef, value: string): Promise<void> {
    return this.ctx.credentials.set(ref, value);
  }

  clearSecret(ref: CredentialRef): Promise<void> {
    return this.ctx.credentials.unset(ref);
  }

  async writeConfig(change: (raw: RawConfig) => RawConfig): Promise<RawConfig | null> {
    const entry: Entry | undefined = this.ctx.fiber.entry;
    if (entry === undefined)
      throw new Error("orca-pod was not loaded from a profile entry; its config cannot be saved");
    const current = structuredClone((entry.options.config ?? {}) as RawConfig);
    const next = change(structuredClone(current));
    if (isDeepStrictEqual(next, current)) return null;
    await this.ctx.configEditor.edit(entry, (raw) => change(raw));
    return next;
  }
}

/**
 * Stores for a pod without a DSH host (tests, smoke runs): the raw config and
 * the secrets live in memory. Nothing restarts the plugin after a write, so the
 * lifecycle applies the config itself.
 */
export class MemoryPodStores implements PodStores {
  readonly restartsOnWrite = false;
  readonly secrets = new Map<string, string>();
  private current: RawConfig;

  constructor(raw: RawConfig = {}) {
    this.current = structuredClone(raw);
  }

  /** The config as stored now. */
  raw(): RawConfig {
    return structuredClone(this.current);
  }

  async readSecret(ref: CredentialRef): Promise<string | undefined> {
    const value = this.secrets.get(ref);
    return value === undefined || value.length === 0 ? undefined : value;
  }

  async writeSecret(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) throw new Error("an empty credential cannot be stored; remove it instead");
    this.secrets.set(ref, value);
  }

  async clearSecret(ref: CredentialRef): Promise<void> {
    this.secrets.delete(ref);
  }

  async writeConfig(change: (raw: RawConfig) => RawConfig): Promise<RawConfig | null> {
    const next = change(structuredClone(this.current));
    if (isDeepStrictEqual(next, this.current)) return null;
    // A config the settings parser refuses is not stored.
    parseSettings(next);
    this.current = next;
    return structuredClone(next);
  }
}
