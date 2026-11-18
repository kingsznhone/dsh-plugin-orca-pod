/**
 * How a file is named across the mesh (§5.6): by the member that published it
 * and the sha256 of its bytes, written `<orca_node_id>/<sha256>`. The name holds
 * no address: whoever fetches it asks its own node, which dials that member the
 * way its heartbeat does, so a reverse proxy or a second interface in front of
 * the publisher changes nothing.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

import { PodError } from "./errors.ts";
import { openDb } from "./sqlite.ts";
import { type OrcaNodeId, OrcaNodeIdSchema } from "./wire/peer.ts";

/** A blob id is the sha256 of the file, as lowercase hex. */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;
export const BlobIdSchema = z.string().regex(BLOB_ID_PATTERN, "must be a lowercase sha256 hex digest");

/** A published file: who published it and what its bytes hash to. */
export type BlobRef = { node: OrcaNodeId; blob: string };

export const blobRefText = ({ node, blob }: BlobRef): string => `${node}/${blob}`;

const BlobRefSchema = z.object({ node: OrcaNodeIdSchema, blob: BlobIdSchema });

/** Read `<orca_node_id>/<sha256>`; null when the text is not one. */
export function parseBlobRef(text: string): BlobRef | null {
  const [node, blob, ...rest] = text.trim().split("/");
  if (rest.length > 0) return null;
  const parsed = BlobRefSchema.safeParse({ node, blob });
  return parsed.success ? parsed.data : null;
}

/** How long a published file stays downloadable unless `publish --ttl` says otherwise (§5.6). */
export const DEFAULT_BLOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The same retention in seconds: published files and the links to them. */
export const DEFAULT_BLOB_TTL_S = Math.floor(DEFAULT_BLOB_TTL_MS / 1000);

// Published files (§5.6)

export type FileBlob = {
  /** sha256 of the file contents; doubles as the content address. */
  blob_id: string;
  /** Absolute path on this orca node. */
  path: string;
  size: number;
  expires_at: string | null;
};

/** Mapping storage; the durable implementation lives in `sqlite.ts`. */
export type FileBlobStore = {
  save(blob: FileBlob): void;
  get(blobId: string): FileBlob | undefined;
  /** SQLite handles need closing so Windows can delete the data dir. */
  close(): void;
};

/** A published file, open for streaming. */
export type OpenedBlob = { stream: Readable; size: number | undefined };

export type FileBlobRegistry = {
  register(path: string, ttlS?: number): Promise<FileBlob>;
  get(blobId: string): FileBlob | undefined;
  has(blobId: string): boolean;
  /** The file behind a blob id, or the error the gateway answers: not found, expired, or gone from disk (§5.6). */
  open(blobId: string): OpenedBlob;
};

/** A mapping that lives as long as the process: unit tests and in-memory orca nodes. */
export function createMemoryFileBlobStore(): FileBlobStore {
  const entries = new Map<string, FileBlob>();
  return {
    save(blob) {
      entries.set(blob.blob_id, blob);
    },
    get: (blobId) => entries.get(blobId),
    close() {},
  };
}

/**
 * Durable file-blob mapping (§5.6), in the same database as tasks so one
 * `data_root` holds all node state. The CLI writes rows directly; the gateway
 * reads them, which is why publishing needs no network route at all.
 */
export function createSqliteFileBlobStore(path: string): FileBlobStore {
  const handle = openDb(path);
  handle.db.exec(
    `CREATE TABLE IF NOT EXISTS file_blobs (
       blob_id TEXT PRIMARY KEY,
       path TEXT NOT NULL,
       size INTEGER NOT NULL,
       expires_at TEXT
     )`,
  );
  const upsert = handle.db.prepare(
    `INSERT INTO file_blobs (blob_id, path, size, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(blob_id) DO UPDATE SET path = excluded.path, size = excluded.size, expires_at = excluded.expires_at`,
  );
  const selectOne = handle.db.prepare("SELECT blob_id, path, size, expires_at FROM file_blobs WHERE blob_id = ?");
  return {
    save(blob: FileBlob): void {
      if (!handle.closed()) upsert.run(blob.blob_id, blob.path, blob.size, blob.expires_at);
    },
    get(blobId: string): FileBlob | undefined {
      const row = handle.closed() ? undefined : (selectOne.get(blobId) as FileBlob | undefined);
      return row && { ...row, size: Number(row.size) };
    },
    close: handle.close,
  };
}

/**
 * File-backed blob registry (§5.6).
 *
 * Files move between nodes by link only: a node publishes a file of its own,
 * and whoever needs it pulls the bytes from that node's gateway. The registry
 * maps the file's sha256 to its local path and a TTL. A task appends the name
 * of a result to its summary; an origin puts the names of the files it hands
 * over into the task text. A name is `<orca_node_id>/<sha256>` (`blobRefText`),
 * while the `blob_id` itself is the bare sha256.
 *
 * Registration is a local capability, not an HTTP route: publishing a path is
 * equivalent to reading it. The CLI therefore writes the mapping straight into
 * the node's SQLite database; peers only ever see that name, never a path.
 */

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
