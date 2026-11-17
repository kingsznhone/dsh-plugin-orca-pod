/** `orca-node fetch`: download a file a member published, by `<node id>/<sha256>`. */

import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { parseBlobRef } from "../protocol/blob.ts";
import { sha256Tap } from "../storage/file-registry.ts";
import {
  COMMON_OPTIONS,
  loadNodeConfig,
  localControlEndpoint,
  peerClient,
  type CommandArgs,
  type OptionName,
} from "./shared.ts";

export const options: readonly OptionName[] = [...COMMON_OPTIONS, "output", "json"];

/** The reference is the one positional argument. */
export const maxPositionals = 1;

/**
 * Fetch a published file (§5.6). The CLI asks its own node, which knows where
 * the publisher answers (the addresses it heartbeats); the bytes are written
 * next to `--output` first and moved into place only when their sha256 matches
 * the reference.
 */
export async function run({ flags, positionals }: CommandArgs): Promise<number> {
  const config = await loadNodeConfig(flags);
  const text = positionals[0];
  const ref = text === undefined ? null : parseBlobRef(text);
  if (ref === null) throw new Error("fetch needs a file reference <orca node id>/<sha256>, as publish printed it");
  const output = resolve(flags.output ?? ref.blob);
  const local = localControlEndpoint(config);
  const client = await peerClient(config, local);
  const { body } = await client.download(local, `/cluster/blob?node=${ref.node}&blob=${ref.blob}`, {
    target: config.orca_node_id,
  });

  const tap = sha256Tap();
  const partial = `${output}.part`;
  let size: number;
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), tap.stream, createWriteStream(partial));
    const digest = tap.digest();
    if (digest.sha !== ref.blob)
      throw new Error(`the file fetched as ${ref.blob} hashes to ${digest.sha}; nothing was written`);
    await rename(partial, output);
    size = digest.size;
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const result = { path: output, size };
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : output}\n`);
  return 0;
}
