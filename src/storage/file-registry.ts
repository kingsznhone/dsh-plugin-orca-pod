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
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_BLOB_TTL_S, type FileBlob, type FileBlobRegistry, type FileBlobStore } from "./stores.ts";

async function hashFile(path: string): Promise<{ sha: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await new Promise<void>((settle, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => settle());
  });
  return { sha: hash.digest("hex"), size };
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
  };
}
