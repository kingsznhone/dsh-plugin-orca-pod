/** `orca-node fetch`: download a file a member published, by `<node id>/<sha256>`. */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { parseBlobRef } from "../protocol/blob.ts";
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

  const hash = createHash("sha256");
  let size = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  const partial = `${output}.part`;
  try {
    await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), hashing, createWriteStream(partial));
    const digest = hash.digest("hex");
    if (digest !== ref.blob)
      throw new Error(`the file fetched as ${ref.blob} hashes to ${digest}; nothing was written`);
    await rename(partial, output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  const result = { path: output, size };
  process.stdout.write(`${flags.json === true ? JSON.stringify(result) : output}\n`);
  return 0;
}
