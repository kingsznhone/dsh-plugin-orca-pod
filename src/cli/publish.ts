/** `orca-node publish`: expose a produced file as a signed blob URL. */

import { join } from "node:path";
import process from "node:process";

import { errorMessage } from "../kernel/errors.ts";
import { signedBlobUrl } from "../security/crypto.ts";
import { createFileBlobRegistry } from "../storage/file-registry.ts";
import { createSqliteFileBlobStore } from "../storage/sqlite.ts";
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

/** What `publish` prints: the blob and the signed URL it can be fetched from. */
type PublishedBlob = { blob_id: string; size: number; expires_at: string | null; url: string };

/** The path may be given as the one positional argument instead of `--path`. */
export const maxPositionals = 1;

/**
 * Publish a produced file as a blob URL (§5.6). Registration writes the mapping
 * straight into the node's SQLite database — there is no HTTP route for it, so
 * only a local caller can publish paths. The URL is signed locally and works
 * while the node runs.
 */
export async function run({ flags, positionals }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const path = positionals[0] ?? required(flags.path, "path");
  const ttlS = positiveSeconds(flags.ttl, "ttl");
  const store = createSqliteFileBlobStore(join(config.data_root, "tasks.db"));
  const blob = await createFileBlobRegistry(store)
    .register(path, ttlS)
    .catch((error: unknown) => {
      throw new Error(`cannot publish ${path}: ${errorMessage(error)}`);
    })
    .finally(() => store.close());
  const exp = String(Math.floor((Date.now() + 24 * 3600 * 1000) / 1000));
  const base = config.endpoints[0] ?? (config.port > 0 ? localEndpoint(config) : null);
  if (base === null) {
    throw new Error("publish needs a known endpoint: set `endpoints` in the config or run `orca-node serve` once");
  }
  const result: PublishedBlob = {
    blob_id: blob.blob_id,
    size: blob.size,
    expires_at: blob.expires_at,
    url: signedBlobUrl(nodeIdentity(config), base, blob.blob_id, exp),
  };
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : result.url}\n`);
  return 0;
}
