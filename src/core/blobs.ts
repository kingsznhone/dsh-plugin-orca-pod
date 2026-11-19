/**
 * How a file is named across the mesh (§5.6): by the member that published it
 * and the sha256 of its bytes, written `<orca_node_id>/<sha256>`. The name holds
 * no address: whoever fetches it asks its own node, which dials that member the
 * way its heartbeat does, so a reverse proxy or a second interface in front of
 * the publisher changes nothing.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, rmSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StatementSync } from "node:sqlite";

import { z } from "zod";

import { PodError } from "./errors.ts";
import type { SqliteDb } from "./sqlite.ts";
import { OrcaNodeIdSchema } from "./ids.ts";

/** A blob id is the sha256 of the file, as lowercase hex. */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;
export const BlobIdSchema = z.string().regex(BLOB_ID_PATTERN, "must be a lowercase sha256 hex digest");

/** A published file's name: the member that published it and the sha256 of its bytes. */
export const BlobRefSchema = z.object({ node: OrcaNodeIdSchema, blob_id: BlobIdSchema });
export type BlobRef = z.infer<typeof BlobRefSchema>;

/** Write a name as `<orca_node_id>/<sha256>`, the text `parseBlobRef` reads back. */
export function formatBlobRef({ node, blob_id }: BlobRef): string {
  return `${node}/${blob_id}`;
}

/** Read `<orca_node_id>/<sha256>`; null when the text is not one. */
export function parseBlobRef(text: string): BlobRef | null {
  const [node, blob_id, ...rest] = text.trim().split("/");
  if (rest.length > 0) return null;
  const parsed = BlobRefSchema.safeParse({ node, blob_id });
  return parsed.success ? parsed.data : null;
}

/** How long a published file stays downloadable unless its publisher says otherwise (§5.6): 7 days. */
const DEFAULT_BLOB_TTL_S = 7 * 24 * 60 * 60;

// Published files (§5.6)

type FileBlob = {
  /** sha256 of the file contents; doubles as the content address. */
  blob_id: string;
  /** Absolute path on this orca node: the registry's own copy of the file. */
  path: string;
  size: number;
  expires_at: string | null;
};

/** A published file, open for streaming. */
export type OpenedBlob = { stream: Readable; size: number | undefined };

/**
 * Durable file-blob mapping (§5.6), in the same database as tasks so one
 * `data_root` holds all node state. This node writes rows when it publishes a
 * file and the gateway reads them, which is why publishing needs no network route at all.
 */
class FileBlobStore {
  /** Prepared on first use, because the database opens after the store is built. */
  private statements:
    | { upsert: StatementSync; selectOne: StatementSync; selectExpired: StatementSync; remove: StatementSync }
    | undefined;

  constructor(private readonly handle: SqliteDb) {}

  save(blob: FileBlob): void {
    if (!this.handle.closed) this.prepared().upsert.run(blob.blob_id, blob.path, blob.size, blob.expires_at);
  }

  get(blobId: string): FileBlob | undefined {
    const row = this.handle.closed ? undefined : (this.prepared().selectOne.get(blobId) as FileBlob | undefined);
    return row && { ...row, size: Number(row.size) };
  }

  /** Every file whose time ran out at or before `at` (an ISO timestamp). */
  expired(at: string): FileBlob[] {
    if (this.handle.closed) return [];
    return (this.prepared().selectExpired.all(at) as FileBlob[]).map((row) => ({ ...row, size: Number(row.size) }));
  }

  delete(blobId: string): void {
    if (!this.handle.closed) this.prepared().remove.run(blobId);
  }

  private prepared(): NonNullable<FileBlobStore["statements"]> {
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
      // ISO timestamps of one format compare as text.
      selectExpired: db.prepare(
        "SELECT blob_id, path, size, expires_at FROM file_blobs WHERE expires_at IS NOT NULL AND expires_at <= ?",
      ),
      remove: db.prepare("DELETE FROM file_blobs WHERE blob_id = ?"),
    };
    return this.statements;
  }
}

/**
 * A pass-through that hashes (sha256) and counts what flows through it: a file
 * is named by this digest when it is published and checked against it when it
 * is fetched (§5.6).
 */
function sha256Tap(): {
  stream: Transform;
  digest(): { sha: string; size: number };
} {
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

/**
 * Write a fetched file to `path`: the bytes go to `<path>.part` first and are
 * moved into place only when their sha256 is the one the file is named by (§5.6).
 * Nothing is left behind on failure.
 */
export async function saveBlob(opened: OpenedBlob, path: string, sha: string): Promise<{ size: number }> {
  const tap = sha256Tap();
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

/** How often expired files are swept away while the node runs. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * File-backed blob registry (§5.6).
 *
 * Files move between nodes by link only: a node publishes a file of its own,
 * and whoever needs it pulls the bytes from that node's gateway. A name is
 * `<orca_node_id>/<sha256>` (`formatBlobRef`), while the `blob_id` itself is the
 * bare sha256. Tasks know nothing of files: whoever hands one over writes its
 * name into the text it sends.
 *
 * Publishing copies the file into the registry's own directory, named by its
 * hash, so a later change to the original changes nothing a fetcher gets. The
 * registry keeps what it copied for the file's TTL and then deletes the copy
 * with its row (`sweep`).
 *
 * Registration is a local capability: publishing a path is equivalent to reading
 * it. Only this machine reaches it (the `orca_pod` tool, through this process or
 * the node's local routes); peers only ever see the name, never a path.
 */
export class FileBlobRegistry {
  private readonly store: FileBlobStore;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    db: SqliteDb,
    /** Where the copies live; every file in it belongs to this registry. */
    private readonly dir: string,
  ) {
    this.store = new FileBlobStore(db);
  }

  /** Sweep the expired files now, then every hour until `stop()`. */
  start(): void {
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /**
   * Copy a file in and name it by its sha256. Publishing the same bytes again
   * keeps the one copy and the later of the two expiries; a TTL of 0 never expires.
   */
  async register(path: string, ttlS: number = DEFAULT_BLOB_TTL_S): Promise<FileBlob> {
    await mkdir(this.dir, { recursive: true });
    const partial = join(this.dir, `.${randomUUID()}.part`);
    const tap = sha256Tap();
    let sha: string;
    let size: number;
    try {
      await pipeline(createReadStream(resolve(path)), tap.stream, createWriteStream(partial));
      ({ sha, size } = tap.digest());
      // The same bytes are already here (and may be streaming to someone): keep that copy.
      if (existsSync(join(this.dir, sha))) await rm(partial, { force: true });
      else await rename(partial, join(this.dir, sha));
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const requested = ttlS > 0 ? new Date(Date.now() + ttlS * 1000).toISOString() : null;
    const previous = this.store.get(sha);
    const blob: FileBlob = {
      blob_id: sha,
      path: join(this.dir, sha),
      size,
      expires_at: previous === undefined ? requested : FileBlobRegistry.later(previous.expires_at, requested),
    };
    this.store.save(blob);
    return { ...blob };
  }

  /** The file behind a blob id, or the error the gateway answers: not found, expired, or gone from disk (§5.6). */
  open(blobId: string): OpenedBlob {
    const file = this.store.get(blobId);
    if (!file) throw new PodError("blob_not_found");
    if (file.expires_at !== null && Date.parse(file.expires_at) <= Date.now()) throw new PodError("blob_expired");
    if (!existsSync(file.path)) throw new PodError("blob_file_missing");
    return { stream: createReadStream(file.path), size: file.size };
  }

  /** Delete every file whose time ran out, its row and its copy. */
  private sweep(): void {
    for (const blob of this.store.expired(new Date().toISOString())) {
      // Only a copy this registry made is its to delete: a row an older version
      // wrote names the publisher's own file, which stays where it is.
      const inside = relative(this.dir, blob.path);
      const owned = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
      try {
        if (owned) rmSync(blob.path, { force: true });
      } catch {
        // Still open for a download (Windows): keep the row, so the next sweep tries again.
        continue;
      }
      this.store.delete(blob.blob_id);
    }
  }

  /** The later of two expiries; null (never) wins. */
  private static later(left: string | null, right: string | null): string | null {
    if (left === null || right === null) return null;
    return left > right ? left : right;
  }
}
