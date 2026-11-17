/** `orca-node publish`: expose a file on this node as a signed blob URL. */

import { join } from "node:path";
import process from "node:process";

import { errorMessage } from "../kernel/errors.ts";
import type { OrcaNodeConfig } from "../node/config.ts";
import { signedBlobUrl } from "../security/crypto.ts";
import { createFileBlobRegistry } from "../storage/file-registry.ts";
import { createSqliteFileBlobStore } from "../storage/sqlite.ts";
import { DEFAULT_BLOB_TTL_S } from "../storage/stores.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localEndpoint,
  nodeIdentity,
  positiveSeconds,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "path", "ttl", "json"];

/** A published file: the blob and the signed URL it can be fetched from. */
type PublishedBlob = { blob_id: string; size: number; expires_at: string | null; url: string };

/** The path may be given as the one positional argument instead of `--path`. */
export const maxPositionals = 1;

/**
 * Publish a file of this node as a blob URL (§5.6): the way a task hands its
 * results to the origin, and the way an origin hands files to a task (it
 * writes the links into the task text). Registration writes the mapping
 * straight into the node's SQLite database; there is no HTTP route for it, so
 * only a local caller can publish paths. The URL is signed locally, lives as
 * long as the registration, and works while the node runs.
 */
async function publishFile(config: OrcaNodeConfig, path: string, ttlS?: number): Promise<PublishedBlob> {
  const base = config.endpoints[0] ?? (config.port > 0 ? localEndpoint(config) : null);
  if (base === null) {
    throw new Error("publish needs a known endpoint: set `endpoints` in the config or start the node once");
  }
  const store = createSqliteFileBlobStore(join(config.data_root, "tasks.db"));
  const blob = await createFileBlobRegistry(store)
    .register(path, ttlS)
    .catch((error: unknown) => {
      throw new Error(`cannot publish ${path}: ${errorMessage(error)}`);
    })
    .finally(() => store.close());
  // A registration without expiry still gets a link that ends: the default retention.
  const expiresMs = blob.expires_at === null ? Date.now() + DEFAULT_BLOB_TTL_S * 1000 : Date.parse(blob.expires_at);
  const exp = String(Math.floor(expiresMs / 1000));
  return {
    blob_id: blob.blob_id,
    size: blob.size,
    expires_at: blob.expires_at,
    url: signedBlobUrl(nodeIdentity(config), base, blob.blob_id, exp),
  };
}

export async function run({ flags, positionals }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const path = positionals[0] ?? required(flags.path, "path");
  const result = await publishFile(config, path, positiveSeconds(flags.ttl, "ttl"));
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : result.url}\n`);
  return 0;
}
