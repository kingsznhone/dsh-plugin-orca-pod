/**
 * File-backed blob registry (§5.6).
 *
 * A task that produced a file on this orca node can publish it instead of
 * uploading a copy: the registry maps the file's sha256 to its local path and a
 * TTL. The child then appends the returned blob URL to its summary, and the
 * origin pulls the bytes only if it wants them.
 *
 * Registration is a local capability, not an HTTP route: publishing a path is
 * equivalent to reading it, and a shared workgroup key cannot prove which node
 * signed a request (any member could sign as any `orca_node_id`). The CLI
 * therefore writes the mapping straight into the node's SQLite database; peers
 * only ever see content-addressed URLs, never a path.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BLOB_TTL_MS } from "./blobs.ts";

export type FileBlob = {
  /** sha256 of the file contents; doubles as the content address. */
  blob_id: string;
  /** Absolute path on this orca node. */
  path: string;
  size: number;
  expires_at: string | null;
};

/** Durable mapping storage; the SQLite implementation lives in `sqlite.ts`. */
export type FileBlobStore = {
  save(blob: FileBlob): void;
  get(blobId: string): FileBlob | undefined;
  /** Optional: SQLite handles need closing so Windows can delete the data dir. */
  close?(): void;
};

export type FileBlobRegistry = {
  register(path: string, ttlS?: number): Promise<FileBlob>;
  get(blobId: string): FileBlob | undefined;
  has(blobId: string): boolean;
};

/** Published files share the blob retention window (§5.6). */
export const DEFAULT_FILE_BLOB_TTL_S = Math.floor(DEFAULT_BLOB_TTL_MS / 1000);

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

/**
 * With a store the mapping survives restarts and is shared with the CLI; without
 * one (unit tests, in-memory orca nodes) it lives in a `Map` for the process.
 */
export function createFileBlobRegistry(store?: FileBlobStore): FileBlobRegistry {
  const entries = new Map<string, FileBlob>();
  return {
    async register(path: string, ttlS: number = DEFAULT_FILE_BLOB_TTL_S): Promise<FileBlob> {
      const absolute = resolve(path);
      const { sha, size } = await hashFile(absolute);
      const blob: FileBlob = {
        blob_id: sha,
        path: absolute,
        size,
        expires_at: ttlS > 0 ? new Date(Date.now() + ttlS * 1000).toISOString() : null,
      };
      if (store) store.save(blob);
      else entries.set(sha, blob);
      return { ...blob };
    },
    get(blobId: string): FileBlob | undefined {
      const blob = store ? store.get(blobId) : entries.get(blobId);
      return blob ? { ...blob } : undefined;
    },
    has(blobId: string): boolean {
      return (store ? store.get(blobId) : entries.get(blobId)) !== undefined;
    },
  };
}
