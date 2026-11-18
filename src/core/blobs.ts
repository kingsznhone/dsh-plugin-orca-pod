/**
 * How a file is named across the mesh (§5.6): by the member that published it
 * and the sha256 of its bytes, written `<orca_node_id>/<sha256>`. The name holds
 * no address: whoever fetches it asks its own node, which dials that member the
 * way its heartbeat does, so a reverse proxy or a second interface in front of
 * the publisher changes nothing.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StatementSync } from "node:sqlite";

import { z } from "zod";

import { PodError } from "./errors.ts";
import type { SqliteDb } from "./sqlite.ts";
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

/** Mapping storage; the durable implementation is `SqliteFileBlobStore`. */
export interface FileBlobStore {
  save(blob: FileBlob): void;
  get(blobId: string): FileBlob | undefined;
}

/** A published file, open for streaming. */
export type OpenedBlob = { stream: Readable; size: number | undefined };

/** Open a file some member published, wherever it lives (§5.6); supplied by whoever owns the mesh. */
export type FetchBlob = (ref: BlobRef, signal?: AbortSignal) => Promise<OpenedBlob>;

export interface FileBlobRegistry {
  register(path: string, ttlS?: number): Promise<FileBlob>;
  get(blobId: string): FileBlob | undefined;
  has(blobId: string): boolean;
  /** The file behind a blob id, or the error the gateway answers: not found, expired, or gone from disk (§5.6). */
  open(blobId: string): OpenedBlob;
}

/** A mapping that lives as long as the process: unit tests and in-memory orca nodes. */
export class MemoryFileBlobStore implements FileBlobStore {
  private readonly entries = new Map<string, FileBlob>();

  save(blob: FileBlob): void {
    this.entries.set(blob.blob_id, blob);
  }

  get(blobId: string): FileBlob | undefined {
    return this.entries.get(blobId);
  }
}

/**
 * Durable file-blob mapping (§5.6), in the same database as tasks so one
 * `data_root` holds all node state. This node writes rows when it publishes a
 * file and the gateway reads them, which is why publishing needs no network route at all.
 */
export class SqliteFileBlobStore implements FileBlobStore {
  /** Prepared on first use, because the database opens after the store is built. */
  private statements: { upsert: StatementSync; selectOne: StatementSync } | undefined;

  constructor(private readonly handle: SqliteDb) {}

  save(blob: FileBlob): void {
    if (!this.handle.closed) this.prepared().upsert.run(blob.blob_id, blob.path, blob.size, blob.expires_at);
  }

  get(blobId: string): FileBlob | undefined {
    const row = this.handle.closed ? undefined : (this.prepared().selectOne.get(blobId) as FileBlob | undefined);
    return row && { ...row, size: Number(row.size) };
  }

  private prepared(): NonNullable<SqliteFileBlobStore["statements"]> {
    if (this.statements !== undefined) return this.statements;
    const { db } = this.handle;
    db.exec(
      `CREATE TABLE IF NOT EXISTS file_blobs (
         blob_id TEXT PRIMARY KEY,
         path TEXT NOT NULL,
         size INTEGER NOT NULL,
         expires_at TEXT
       )`,
    );
    this.statements = {
      upsert: db.prepare(
        `INSERT INTO file_blobs (blob_id, path, size, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(blob_id) DO UPDATE SET path = excluded.path, size = excluded.size, expires_at = excluded.expires_at`,
      ),
      selectOne: db.prepare("SELECT blob_id, path, size, expires_at FROM file_blobs WHERE blob_id = ?"),
    };
    return this.statements;
  }
}

/**
 * A pass-through that hashes (sha256) and counts what flows through it: a file
 * is named by this digest when it is published and checked against it when it
 * is fetched (§5.6). It fails the stream once more than `maxBytes` have passed.
 */
export function sha256Tap(maxBytes = Number.POSITIVE_INFINITY): {
  stream: Transform;
  digest(): { sha: string; size: number };
} {
  const hash = createHash("sha256");
  let size = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      if (size > maxBytes) done(new PodError("blob_too_large", `the file is larger than ${maxBytes} bytes`));
      else done(null, chunk);
    },
  });
  return { stream, digest: () => ({ sha: hash.digest("hex"), size }) };
}

/**
 * Write a fetched file to `path`: the bytes go to `<path>.part` first and are
 * moved into place only when their sha256 is the one the file is named by (§5.6)
 * and they stay within `maxBytes`. Nothing is left behind on failure.
 */
export async function saveBlob(
  opened: OpenedBlob,
  path: string,
  sha: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<{ size: number }> {
  const tap = sha256Tap(maxBytes);
  const partial = `${path}.part`;
  try {
    await pipeline(opened.stream, tap.stream, createWriteStream(partial));
    const digest = tap.digest();
    if (digest.sha !== sha) {
      throw new PodError("peer_error", `the file fetched as ${sha} hashes to ${digest.sha}; nothing was written`, 502);
    }
    await rename(partial, path);
    return { size: digest.size };
  } catch (error) {
    opened.stream.destroy();
    await rm(partial, { force: true });
    throw error;
  }
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
 * equivalent to reading it. Only this node's own code (the `orca_pod` tool, the
 * task runner) registers files; peers only ever see the name, never a path.
 */
export class DiskBlobRegistry implements FileBlobRegistry {
  constructor(private readonly store: FileBlobStore) {}

  async register(path: string, ttlS: number = DEFAULT_BLOB_TTL_S): Promise<FileBlob> {
    const absolute = resolve(path);
    const { sha, size } = await DiskBlobRegistry.hashFile(absolute);
    const blob: FileBlob = {
      blob_id: sha,
      path: absolute,
      size,
      expires_at: ttlS > 0 ? new Date(Date.now() + ttlS * 1000).toISOString() : null,
    };
    this.store.save(blob);
    return { ...blob };
  }

  get(blobId: string): FileBlob | undefined {
    const blob = this.store.get(blobId);
    return blob && { ...blob };
  }

  has(blobId: string): boolean {
    return this.store.get(blobId) !== undefined;
  }

  open(blobId: string): OpenedBlob {
    const file = this.store.get(blobId);
    if (!file) throw new PodError("blob_not_found");
    if (file.expires_at !== null && Date.parse(file.expires_at) <= Date.now()) throw new PodError("blob_expired");
    if (!existsSync(file.path)) throw new PodError("blob_file_missing");
    return { stream: createReadStream(file.path), size: file.size };
  }

  private static async hashFile(path: string): Promise<{ sha: string; size: number }> {
    const tap = sha256Tap();
    await pipeline(createReadStream(path), tap.stream, async (source: AsyncIterable<Buffer>) => {
      for await (const _chunk of source) {
        // Only the digest is wanted; the bytes are dropped.
      }
    });
    return tap.digest();
  }
}
