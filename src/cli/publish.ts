/** `orca-node publish`: make a file of this node fetchable by any member, under `<node id>/<sha256>`. */

import process from "node:process";

import { errorMessage } from "../kernel/errors.ts";
import { blobRefText } from "../protocol/blob.ts";
import { createFileBlobRegistry } from "../storage/file-registry.ts";
import { createSqliteFileBlobStore, storeDbPath } from "../storage/sqlite.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  positiveSeconds,
  required,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "path", "ttl", "json"];

/** The path may be given as the one positional argument instead of `--path`. */
export const maxPositionals = 1;

/**
 * Publish a file of this node (§5.6): the way a task hands its results to the
 * origin, and the way an origin hands files to a task. It prints the file's
 * name, `<node id>/<sha256>`, which goes into the summary or the task text;
 * whoever needs the file runs `orca-node fetch` with it. Registration writes
 * the mapping straight into the node's SQLite database; there is no HTTP route
 * for it, so only a local caller can publish paths.
 */
export async function run({ flags, positionals }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const path = positionals[0] ?? required(flags.path, "path");
  const store = createSqliteFileBlobStore(storeDbPath(config.data_root));
  const blob = await createFileBlobRegistry(store)
    .register(path, positiveSeconds(flags.ttl, "ttl"))
    .catch((error: unknown) => {
      throw new Error(`cannot publish ${path}: ${errorMessage(error)}`);
    })
    .finally(() => store.close());
  const ref = blobRefText({ node: config.orca_node_id, blob: blob.blob_id });
  const result = { ref, size: blob.size, expires_at: blob.expires_at };
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : ref}\n`);
  return 0;
}
