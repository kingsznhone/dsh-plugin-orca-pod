import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { PodError } from "./errors.ts";

/**
 * Content-addressed blob store (§5.6): an in-memory store and a disk store
 * (with GC and a size quota) share one contract.
 */
type BlobRecord = {
  blob_id: string;
  size: number;
  name: string | null;
  media_type: string | null;
  expires_at: string | null;
};

type StoredBlob = BlobRecord & { bytes: Buffer };

/** Streaming read handle: the caller pipes `stream` instead of buffering. */
type BlobRead = {
  stream: Readable;
  size: number;
  record: BlobRecord;
};

/** Raised when a streamed body exceeds the declared maximum (§5.6). */
function tooLarge(limit: number): PodError {
  return new PodError("blob_too_large", `blob body exceeds ${limit} bytes`);
}

function recordOf(blob: BlobRecord): BlobRecord {
  return {
    blob_id: blob.blob_id,
    size: blob.size,
    name: blob.name,
    media_type: blob.media_type,
    expires_at: blob.expires_at,
  };
}

export interface BlobStore {
  /** Store bytes; returns the content hash. Same bytes => same id, no duplicate. */
  put(bytes: Buffer | Uint8Array, options?: { name?: string; media_type?: string }): StoredBlob;
  /** Streamed upload; never buffers the body (§5.6). */
  putStream(stream: Readable, options?: { name?: string; media_type?: string; maxBytes?: number }): Promise<BlobRecord>;
  /** Streamed download; avoids reading the whole blob into memory. */
  openRead(blobId: string): BlobRead | undefined;
  /** Size and metadata of a blob, without reading or opening its content. */
  stat(blobId: string): BlobRecord | undefined;
  /** Copy a blob into `destination` (its directory must exist) without buffering it (task inputs, §6.7). */
  copyTo(blobId: string, destination: string): Promise<boolean>;
  get(blobId: string): StoredBlob | undefined;
  has(blobId: string): boolean;
  /** Best-effort TTL sweep; returns the number of removed blobs (§5.6). */
  gc(): number;
}

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createMemoryBlobStore(ttlMs: number | null = null): BlobStore {
  const blobs = new Map<string, StoredBlob>();
  const store: BlobStore = {
    put(bytes, options): StoredBlob {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const blobId = sha256Hex(buffer);
      const existing = blobs.get(blobId);
      if (existing) return { ...existing };
      const blob: StoredBlob = {
        blob_id: blobId,
        size: buffer.length,
        name: options?.name ?? null,
        media_type: options?.media_type ?? null,
        expires_at: ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString(),
        bytes: buffer,
      };
      blobs.set(blobId, blob);
      return { ...blob };
    },
    async putStream(stream, options): Promise<BlobRecord> {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (options?.maxBytes !== undefined && size > options.maxBytes) {
          throw tooLarge(options.maxBytes);
        }
        chunks.push(buffer);
      }
      const result = store.put(Buffer.concat(chunks), options);
      return recordOf(result);
    },
    openRead(blobId): BlobRead | undefined {
      const blob = blobs.get(blobId);
      if (!blob) return undefined;
      return { stream: Readable.from(blob.bytes), size: blob.size, record: recordOf(blob) };
    },
    stat(blobId) {
      const blob = blobs.get(blobId);
      return blob && recordOf(blob);
    },
    async copyTo(blobId, destination) {
      const blob = blobs.get(blobId);
      if (!blob) return false;
      await writeFile(destination, blob.bytes);
      return true;
    },
    get(blobId) {
      const blob = blobs.get(blobId);
      return blob ? { ...blob } : undefined;
    },
    has(blobId) {
      return blobs.has(blobId);
    },
    gc() {
      const now = Date.now();
      let removed = 0;
      for (const [blobId, blob] of blobs) {
        if (blob.expires_at !== null && Date.parse(blob.expires_at) <= now) {
          blobs.delete(blobId);
          removed += 1;
        }
      }
      return removed;
    },
  };
  return store;
}

/** Default retention for blobs nobody referenced (§5.6). */
export const DEFAULT_BLOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The one retention constant: uploads, published files and direct links. */
export const DEFAULT_BLOB_TTL_S = Math.floor(DEFAULT_BLOB_TTL_MS / 1000);

type FsBlobStoreOptions = {
  ttlMs?: number | null;
  now?: () => number;
  /** Total size the store may hold; an upload that would pass it is refused. Unset means unlimited. */
  maxBytes?: number;
};

const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;

/** A `.part` file nobody has written to for this long belongs to a crashed upload. */
export const PART_GRACE_MS = 10 * 60 * 1000;

type Meta = { size: number; name: string | null; media_type: string | null; expires_at: string | null };

/**
 * Disk blob store: content-addressed files under `<root>/<aa>/<sha256>`, with a
 * small JSON sidecar holding name/media type/expiry. Bytes are written to a
 * temp file and renamed, so a crashed write never looks like a complete blob;
 * `gc()` removes the temp files such a crash leaves behind.
 */
export function createFsBlobStore(root: string, options: FsBlobStoreOptions = {}): BlobStore {
  const ttlMs = options.ttlMs ?? DEFAULT_BLOB_TTL_MS;
  const now = options.now ?? Date.now;
  const quota = options.maxBytes ?? Number.POSITIVE_INFINITY;
  mkdirSync(root, { recursive: true });

  const pathFor = (blobId: string): string => join(root, blobId.slice(0, 2), blobId);
  const metaFor = (blobId: string): string => `${pathFor(blobId)}.json`;

  function readMeta(blobId: string): Meta | undefined {
    try {
      return JSON.parse(readFileSync(metaFor(blobId), "utf8")) as Meta;
    } catch {
      return undefined;
    }
  }

  function* committed(): Generator<{ blobId: string; meta: Meta }> {
    for (const prefix of readdirSync(root, { withFileTypes: true })) {
      if (!prefix.isDirectory()) continue;
      for (const entry of readdirSync(join(root, prefix.name))) {
        if (!entry.endsWith(".json")) continue;
        const blobId = entry.slice(0, -".json".length);
        const meta = readMeta(blobId);
        if (meta) yield { blobId, meta };
      }
    }
  }

  // The quota counts bytes committed plus bytes of uploads still streaming in.
  let used = 0;
  let inflight = 0;
  for (const { meta } of committed()) used += meta.size;

  const quotaExceeded = (): PodError => new PodError("quota_exceeded", `the blob store is full (${quota} bytes)`);

  const expiry = (): string | null => (ttlMs === null ? null : new Date(now() + ttlMs).toISOString());

  function commit(blobId: string, meta: Meta): void {
    const metaTemp = `${metaFor(blobId)}.part`;
    writeFileSync(metaTemp, JSON.stringify(meta));
    renameSync(metaTemp, metaFor(blobId));
    used += meta.size;
  }

  function dropStalePart(path: string): void {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && Date.now() - stat.mtimeMs > PART_GRACE_MS) rmSync(path, { force: true });
  }

  function stat(blobId: string): BlobRecord | undefined {
    if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
    const meta = readMeta(blobId);
    return meta && { blob_id: blobId, ...meta };
  }

  return {
    put(bytes, putOptions): StoredBlob {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const blobId = sha256Hex(buffer);
      const existingMeta = readMeta(blobId);
      if (existingMeta) {
        return { blob_id: blobId, ...existingMeta, bytes: readFileSync(pathFor(blobId)) };
      }
      if (used + inflight + buffer.length > quota) throw quotaExceeded();
      const final = pathFor(blobId);
      mkdirSync(dirname(final), { recursive: true });
      const temp = `${final}.${randomBytes(6).toString("hex")}.part`;
      writeFileSync(temp, buffer);
      renameSync(temp, final);
      const meta: Meta = {
        size: buffer.length,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: expiry(),
      };
      commit(blobId, meta);
      return { blob_id: blobId, ...meta, bytes: buffer };
    },
    get(blobId) {
      if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
      const meta = readMeta(blobId);
      if (!meta) return undefined;
      return { blob_id: blobId, ...meta, bytes: readFileSync(pathFor(blobId)) };
    },
    has(blobId) {
      return BLOB_ID_PATTERN.test(blobId) && existsSync(pathFor(blobId));
    },
    async putStream(stream, putOptions) {
      const hasher = createHash("sha256");
      const temp = join(root, `.upload-${randomBytes(6).toString("hex")}.part`);
      let size = 0;
      async function* meter(source: AsyncIterable<Buffer | string>): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (putOptions?.maxBytes !== undefined && size + buffer.length > putOptions.maxBytes) {
            throw tooLarge(putOptions.maxBytes);
          }
          if (used + inflight + buffer.length > quota) throw quotaExceeded();
          size += buffer.length;
          inflight += buffer.length;
          hasher.update(buffer);
          yield buffer;
        }
      }
      try {
        await pipeline(stream, meter, createWriteStream(temp));
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      } finally {
        inflight -= size;
      }
      const blobId = hasher.digest("hex");
      const existingMeta = readMeta(blobId);
      if (existingMeta) {
        rmSync(temp, { force: true });
        return { blob_id: blobId, ...existingMeta };
      }
      const final = pathFor(blobId);
      mkdirSync(dirname(final), { recursive: true });
      renameSync(temp, final);
      const meta: Meta = {
        size,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: expiry(),
      };
      commit(blobId, meta);
      return { blob_id: blobId, ...meta };
    },
    openRead(blobId) {
      const record = stat(blobId);
      const path = pathFor(blobId);
      if (!record || !existsSync(path)) return undefined;
      return { stream: createReadStream(path), size: record.size, record };
    },
    stat,
    async copyTo(blobId, destination) {
      if (!BLOB_ID_PATTERN.test(blobId) || !existsSync(pathFor(blobId))) return false;
      await copyFile(pathFor(blobId), destination);
      return true;
    },
    gc() {
      const at = now();
      let removed = 0;
      let kept = 0;
      // Orphans of a crashed write: `.upload-*.part` in the root, temp files in the prefix directories.
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isFile() && entry.name.endsWith(".part")) dropStalePart(path);
        if (!entry.isDirectory()) continue;
        for (const name of readdirSync(path)) if (name.endsWith(".part")) dropStalePart(join(path, name));
      }
      for (const { blobId, meta } of committed()) {
        if (meta.expires_at !== null && Date.parse(meta.expires_at) <= at) {
          rmSync(pathFor(blobId), { force: true });
          rmSync(metaFor(blobId), { force: true });
          removed += 1;
        } else {
          kept += meta.size;
        }
      }
      used = kept;
      return removed;
    },
  };
}
