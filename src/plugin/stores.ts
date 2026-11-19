/**
 * What the pod keeps in the DSH credential store (§3.6): the workgroup password
 * and the node's private key. Both are machine-wide, because a machine has one
 * node however many DSH profiles it runs (§3.9). Settings are not secrets and
 * live in `settings-file.ts`; the peers joined at runtime in `peers-file.ts`.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

import type { Context } from "@deepseek-ai/cordis";
import { credentialKey, credentialRef, type CredentialRecord } from "@deepseek-ai/dsh-credentials";
import bs58 from "bs58";

import { errorMessage } from "../core/errors.ts";
import type { NodeIdentity } from "../core/identity.ts";
import { nodeIdOf } from "../core/ids.ts";
import { z } from "zod";

const RAW_KEY_BYTES = 32;
/** PKCS#8 header of an Ed25519 private key (RFC 8410) up to the 32-byte seed. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** The identity of a private key: its node id is the raw public key in base58 (§7.1). */
function identityOfKey(privateKey: KeyObject): NodeIdentity {
  return {
    // The raw public key is the last bytes of its SPKI encoding.
    orcaNodeId: nodeIdOf(
      Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" })).subarray(-RAW_KEY_BYTES),
    ),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function generateNodeIdentity(): NodeIdentity {
  return identityOfKey(generateKeyPairSync("ed25519").privateKey);
}

/** The private key as it is stored: its 32-byte seed in base58. */
export function exportIdentity(identity: NodeIdentity): string {
  const der = createPrivateKey(identity.privateKeyPem).export({ format: "der", type: "pkcs8" });
  return bs58.encode(Buffer.from(der).subarray(-RAW_KEY_BYTES));
}

/** The identity of a stored private key; throws when the text is not a base58 Ed25519 seed. */
export function importIdentity(text: string): NodeIdentity {
  const seed = Buffer.from(bs58.decode(text));
  if (seed.length !== RAW_KEY_BYTES) throw new Error(`an Ed25519 private key is ${RAW_KEY_BYTES} bytes`);
  return identityOfKey(
    createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" }),
  );
}

/** The reference of the workgroup password: one name for the whole machine, also an environment variable a headless host can export. */
export const PASSWORD_REF = credentialRef("ORCA_POD_PASSWORD");

/** The record of the node's Ed25519 private key; it belongs to this plugin, which is why it is a record and not a reference. */
export const NODE_KEY = credentialKey("orca-pod", "node");

/** What a grant record holding the node key carries: the Ed25519 seed in base58. */
const NodeKeyPayloadSchema = z.object({ ed25519: z.string() });

/** The private key a record holds: `{ ed25519: <base58 seed> }` in a grant record's payload. */
function identityOf(record: CredentialRecord): NodeIdentity {
  const payload = record.kind === "grant" ? NodeKeyPayloadSchema.safeParse(record.payload) : undefined;
  if (payload?.success !== true) {
    throw new Error("the node key in the credential store is not an Ed25519 key; delete it to make a new identity");
  }
  try {
    return importIdentity(payload.data.ed25519);
  } catch (error) {
    throw new Error(
      `the node key in the credential store is damaged (${errorMessage(error)}); delete it to make a new identity`,
    );
  }
}

/** A grant record holding a node's private key. */
function recordOf(identity: NodeIdentity): CredentialRecord {
  return { kind: "grant", payload: { ed25519: exportIdentity(identity) } };
}

/**
 * The pod's persistence: the password and the node key in the host's
 * `ctx.credentials`. Two processes that ask for the identity at the same time
 * get the same key: the write is exclusive in the store.
 */
export class PodStores {
  constructor(private readonly ctx: Pick<Context, "credentials">) {}

  async readPassword(): Promise<string | undefined> {
    // An empty password counts as none.
    return (await this.ctx.credentials.resolve(PASSWORD_REF))?.value || undefined;
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
