/**
 * What the pod keeps in the DSH credential store (§3.6): the workgroup password
 * and the node's private key. Both are machine-wide, because a machine has one
 * node however many DSH profiles it runs (§3.9). Settings are not secrets and
 * live in `settings-file.ts`; the peers joined at runtime in `peers-file.ts`.
 */

import type { Context } from "@deepseek-ai/cordis";
import { credentialKey, credentialRef, type CredentialRecord } from "@deepseek-ai/dsh-credentials";

import { exportIdentity, generateNodeIdentity, importIdentity, type NodeIdentity } from "../core/identity.ts";
import { isRecord } from "../core/schema.ts";

/** The reference of the workgroup password: one name for the whole machine, also an environment variable a headless host can export. */
export const PASSWORD_REF = credentialRef("ORCA_POD_PASSWORD");

/** The record of the node's Ed25519 private key; it belongs to this plugin, which is why it is a record and not a reference. */
export const NODE_KEY = credentialKey("orca-pod", "node");

/** What the pod needs from its host: the DSH credential store (`HostPodStores`), or memory without a host. */
export interface PodStores {
  /** The stored password; undefined when absent or empty. */
  readPassword(): Promise<string | undefined>;
  /** Whether a password is stored, without reading it: the panel's "password set". */
  passwordConfigured(): Promise<boolean>;
  writePassword(value: string): Promise<void>;
  clearPassword(): Promise<void>;
  /** The node's identity, or undefined while none was ever made; it never creates one. */
  readIdentity(): Promise<NodeIdentity | undefined>;
  /**
   * The node's identity, made on first use. Two processes that ask at the same
   * time get the same key: the write is exclusive in the store.
   */
  identity(): Promise<NodeIdentity>;
  deleteIdentity(): Promise<void>;
}

/** The private key a record holds: `{ ed25519: <base58 seed> }` in a grant record's payload. */
function identityOf(record: CredentialRecord): NodeIdentity {
  const payload = record.kind === "grant" && isRecord(record.payload) ? record.payload : undefined;
  if (typeof payload?.ed25519 !== "string") {
    throw new Error("the node key in the credential store is not an Ed25519 key; delete it to make a new identity");
  }
  try {
    return importIdentity(payload.ed25519);
  } catch (error) {
    throw new Error(
      `the node key in the credential store is damaged (${error instanceof Error ? error.message : String(error)}); delete it to make a new identity`,
    );
  }
}

/** A grant record holding a node's private key. */
function recordOf(identity: NodeIdentity): CredentialRecord {
  return { kind: "grant", payload: { ed25519: exportIdentity(identity) } };
}

/** The pod's persistence on a DSH host: the password and the node key in `ctx.credentials`. */
export class HostPodStores implements PodStores {
  constructor(private readonly ctx: Pick<Context, "credentials">) {}

  async readPassword(): Promise<string | undefined> {
    return (await this.ctx.credentials.resolve(PASSWORD_REF))?.value;
  }

  async passwordConfigured(): Promise<boolean> {
    return (await this.ctx.credentials.describe(PASSWORD_REF)).configured;
  }

  writePassword(value: string): Promise<void> {
    return this.ctx.credentials.set(PASSWORD_REF, value);
  }

  clearPassword(): Promise<void> {
    return this.ctx.credentials.unset(PASSWORD_REF);
  }

  async readIdentity(): Promise<NodeIdentity | undefined> {
    const record = await this.ctx.credentials.readRecord(NODE_KEY);
    return record === undefined ? undefined : identityOf(record);
  }

  async identity(): Promise<NodeIdentity> {
    const record = await this.ctx.credentials.modifyRecord(NODE_KEY, async (current) =>
      current === undefined ? recordOf(generateNodeIdentity()) : undefined,
    );
    if (record === undefined) throw new Error("the credential store did not keep the node key");
    return identityOf(record);
  }

  deleteIdentity(): Promise<void> {
    return this.ctx.credentials.deleteRecord(NODE_KEY);
  }
}

/** Stores for a pod without a DSH host (tests): everything lives in memory. */
export class MemoryPodStores implements PodStores {
  password: string | undefined;
  private node: NodeIdentity | undefined;

  constructor(options: { password?: string; identity?: NodeIdentity } = {}) {
    this.password = options.password;
    this.node = options.identity;
  }

  async readPassword(): Promise<string | undefined> {
    return this.password === undefined || this.password.length === 0 ? undefined : this.password;
  }

  async passwordConfigured(): Promise<boolean> {
    return (await this.readPassword()) !== undefined;
  }

  async writePassword(value: string): Promise<void> {
    if (value.length === 0) throw new Error("an empty credential cannot be stored; remove it instead");
    this.password = value;
  }

  async clearPassword(): Promise<void> {
    this.password = undefined;
  }

  async readIdentity(): Promise<NodeIdentity | undefined> {
    return this.node;
  }

  async identity(): Promise<NodeIdentity> {
    this.node ??= generateNodeIdentity();
    return this.node;
  }

  async deleteIdentity(): Promise<void> {
    this.node = undefined;
  }
}
