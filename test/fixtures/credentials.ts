import type { Context } from "@deepseek-ai/cordis";
import type { CredentialRecord } from "@deepseek-ai/dsh-credentials";

import { PodStores } from "../../src/plugin/stores.ts";

/** The host's credential store, in memory: what `PodStores` reads and writes through `ctx.credentials`. */
export class MemoryCredentials {
  readonly secrets = new Map<string, string>();
  readonly records = new Map<string, CredentialRecord>();

  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    const value = this.secrets.get(ref);
    return value === undefined ? undefined : { value, source: "memory" };
  }

  async describe(ref: string): Promise<{ configured: boolean; writable: boolean }> {
    return { configured: (this.secrets.get(ref) ?? "").length > 0, writable: true };
  }

  async set(ref: string, value: string): Promise<void> {
    if (value.length === 0) throw new Error("an empty credential cannot be stored; remove it instead");
    this.secrets.set(ref, value);
  }

  async unset(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }

  async readRecord(key: string): Promise<CredentialRecord | undefined> {
    return this.records.get(key);
  }

  /** `mutate` answers undefined to keep what is there, the way DSH's store does. */
  async modifyRecord(
    key: string,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const next = await mutate(this.records.get(key));
    if (next !== undefined) this.records.set(key, next);
    return this.records.get(key);
  }

  async deleteRecord(key: string): Promise<void> {
    this.records.delete(key);
  }
}

/** A host that has only this credential store, as the pod and its stores take it. */
export function credentialHost(credentials = new MemoryCredentials()): Pick<Context, "credentials"> {
  return { credentials } as unknown as Pick<Context, "credentials">;
}

/** The pod's real stores over an in-memory credential store. */
export function podStores(credentials = new MemoryCredentials()): PodStores {
  return new PodStores(credentialHost(credentials));
}
