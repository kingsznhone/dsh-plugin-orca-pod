import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Content-addressed blob store (§5.6). The prototype keeps bytes in memory;
 * the disk implementation keeps the same contract and adds GC.
 */
export type BlobRecord = {
  blob_id: string;
  size: number;
  name: string | null;
  media_type: string | null;
  expires_at: string | null;
};

export type StoredBlob = BlobRecord & { bytes: Buffer };

/** Streaming read handle: the caller pipes `stream` instead of buffering. */
export type BlobRead = {
  stream: Readable;
  size: number;
  record: BlobRecord;
};

/** Raised when a streamed body exceeds the declared maximum (§5.6). */
export class BlobTooLargeError extends Error {
  constructor(limit: number) {
    super(`blob body exceeds ${limit} bytes`);
    this.name = "BlobTooLargeError";
  }
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
  putStream?(stream: Readable, options?: { name?: string; media_type?: string; maxBytes?: number }): Promise<BlobRecord>;
  /** Streamed download; avoids reading the whole blob into memory. */
  openRead?(blobId: string): BlobRead | undefined;
  /** Copy a blob to a local file without buffering it (task inputs, §6.7). */
  copyTo?(blobId: string, destination: string): boolean;
  get(blobId: string): StoredBlob | undefined;
  has(blobId: string): boolean;
  /** Best-effort TTL sweep; returns the number of removed blobs (§5.6). */
  gc?(): number;
}

export interface FsBlobStore extends BlobStore {
  put(bytes: Buffer | Uint8Array, options?: { name?: string; media_type?: string }): StoredBlob;
  get(blobId: string): StoredBlob | undefined;
  has(blobId: string): boolean;
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
          throw new BlobTooLargeError(options.maxBytes);
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
    copyTo(blobId, destination): boolean {
      const blob = blobs.get(blobId);
      if (!blob) return false;
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, blob.bytes);
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

export type FsBlobStoreOptions = {
  ttlMs?: number | null;
  now?: () => number;
};

const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Disk blob store: content-addressed files under `<root>/<aa>/<sha256>`, with a
 * small JSON sidecar holding name/media type/expiry. Bytes are written to a
 * temp file and renamed, so a crashed write never looks like a complete blob.
 */
export function createFsBlobStore(root: string, options: FsBlobStoreOptions = {}): FsBlobStore {
  const ttlMs = options.ttlMs ?? DEFAULT_BLOB_TTL_MS;
  const now = options.now ?? Date.now;
  mkdirSync(root, { recursive: true });

  const pathFor = (blobId: string): string => join(root, blobId.slice(0, 2), blobId);
  const metaFor = (blobId: string): string => `${pathFor(blobId)}.json`;

  type Meta = { size: number; name: string | null; media_type: string | null; expires_at: string | null };

  function readMeta(blobId: string): Meta | undefined {
    try {
      return JSON.parse(readFileSync(metaFor(blobId), "utf8")) as Meta;
    } catch {
      return undefined;
    }
  }

  return {
    put(bytes, putOptions): StoredBlob {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const blobId = sha256Hex(buffer);
      const existingMeta = readMeta(blobId);
      if (existingMeta) {
        return { blob_id: blobId, ...existingMeta, bytes: readFileSync(pathFor(blobId)) };
      }
      const final = pathFor(blobId);
      mkdirSync(dirname(final), { recursive: true });
      const temp = `${final}.${randomBytes(6).toString("hex")}.part`;
      writeFileSync(temp, buffer);
      renameSync(temp, final);
      const meta: Meta = {
        size: buffer.length,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: ttlMs === null ? null : new Date(now() + ttlMs).toISOString(),
      };
      const metaTemp = `${metaFor(blobId)}.part`;
      writeFileSync(metaTemp, JSON.stringify(meta));
      renameSync(metaTemp, metaFor(blobId));
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
          size += buffer.length;
          if (putOptions?.maxBytes !== undefined && size > putOptions.maxBytes) {
            throw new BlobTooLargeError(putOptions.maxBytes);
          }
          hasher.update(buffer);
          yield buffer;
        }
      }
      try {
        await pipeline(stream, meter, createWriteStream(temp));
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      const blobId = hasher.digest("hex");
      const final = pathFor(blobId);
      const existingMeta = readMeta(blobId);
      if (existingMeta) {
        rmSync(temp, { force: true });
        return { blob_id: blobId, ...existingMeta };
      }
      mkdirSync(dirname(final), { recursive: true });
      renameSync(temp, final);
      const meta: Meta = {
        size,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: ttlMs === null ? null : new Date(now() + ttlMs).toISOString(),
      };
      const metaTemp = `${metaFor(blobId)}.part`;
      writeFileSync(metaTemp, JSON.stringify(meta));
      renameSync(metaTemp, metaFor(blobId));
      return { blob_id: blobId, ...meta };
    },
    openRead(blobId) {
      if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
      const meta = readMeta(blobId);
      if (!meta) return undefined;
      const path = pathFor(blobId);
      if (!existsSync(path)) return undefined;
      return { stream: createReadStream(path), size: meta.size, record: { blob_id: blobId, ...meta } };
    },
    copyTo(blobId, destination) {
      if (!BLOB_ID_PATTERN.test(blobId)) return false;
      const path = pathFor(blobId);
      if (!existsSync(path)) return false;
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
      return true;
    },
    gc() {
      const at = now();
      let removed = 0;
      for (const prefix of readdirSync(root, { withFileTypes: true })) {
        if (!prefix.isDirectory()) continue;
        for (const entry of readdirSync(join(root, prefix.name))) {
          if (!entry.endsWith(".json")) continue;
          const blobId = entry.slice(0, -".json".length);
          const meta = readMeta(blobId);
          if (!meta?.expires_at || Date.parse(meta.expires_at) > at) continue;
          rmSync(pathFor(blobId), { force: true });
          rmSync(metaFor(blobId), { force: true });
          removed += 1;
        }
      }
      return removed;
    },
  };
}

/** Random token for /blobs/{id}/link short-lived download URLs (§5.6). */
export function newLinkToken(): string {
  return randomBytes(18).toString("base64url");
}
