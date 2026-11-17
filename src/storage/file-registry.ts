/**
 * File-backed blob registry (§5.6).
 *
 * Files move between nodes by link only: a node publishes a file of its own,
 * and whoever needs it pulls the bytes from that node's gateway. The registry
 * maps the file's sha256 to its local path and a TTL. A task appends the URL of
 * a result to its summary; an origin puts the URLs of the files it hands over
 * into the task text.
 *
 * Registration is a local capability, not an HTTP route: publishing a path is
 * equivalent to reading it. The CLI therefore writes the mapping straight into
 * the node's SQLite database; peers only ever see content-addressed URLs, never
 * a path.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PodError } from "../kernel/errors.ts";

import { DEFAULT_BLOB_TTL_S, type FileBlob, type FileBlobRegistry, type FileBlobStore } from "./stores.ts";

/**
 * A pass-through that hashes (sha256) and counts what flows through it: a file
 * is named by this digest when it is published and checked against it when it
 * is fetched (§5.6).
 */
export function sha256Tap(): { stream: Transform; digest(): { sha: string; size: number } } {
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, digest: () => ({ sha: hash.digest("hex"), size }) };
}

async function hashFile(path: string): Promise<{ sha: string; size: number }> {
  const tap = sha256Tap();
  await pipeline(createReadStream(path), tap.stream, async (source: AsyncIterable<Buffer>) => {
    for await (const _chunk of source) {
      // Only the digest is wanted; the bytes are dropped.
    }
  });
  return tap.digest();
}

export function createFileBlobRegistry(store: FileBlobStore): FileBlobRegistry {
  return {
    async register(path: string, ttlS: number = DEFAULT_BLOB_TTL_S): Promise<FileBlob> {
      const absolute = resolve(path);
      const { sha, size } = await hashFile(absolute);
      const blob: FileBlob = {
        blob_id: sha,
        path: absolute,
        size,
        expires_at: ttlS > 0 ? new Date(Date.now() + ttlS * 1000).toISOString() : null,
      };
      store.save(blob);
      return { ...blob };
    },
    get(blobId: string): FileBlob | undefined {
      const blob = store.get(blobId);
      return blob && { ...blob };
    },
    has(blobId: string): boolean {
      return store.get(blobId) !== undefined;
    },
    open(blobId: string) {
      const file = store.get(blobId);
      if (!file) throw new PodError("blob_not_found");
      if (file.expires_at !== null && Date.parse(file.expires_at) <= Date.now()) throw new PodError("blob_expired");
      if (!existsSync(file.path)) throw new PodError("blob_file_missing");
      return { stream: createReadStream(file.path), size: file.size };
    },
  };
}
