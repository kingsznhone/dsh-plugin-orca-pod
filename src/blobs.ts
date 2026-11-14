import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Content-addressed blob store (§5.6). The prototype keeps bytes in memory;
 * the disk/SQLite implementation keeps the same contract and adds GC.
 */
export type StoredBlob = {
  blob_id: string;
  size: number;
  name: string | null;
  media_type: string | null;
  expires_at: string | null;
  bytes: Buffer;
};

export interface BlobStore {
  /** Store bytes; returns the content hash. Same bytes => same id, no duplicate. */
  put(bytes: Buffer | Uint8Array, options?: { name?: string; media_type?: string }): StoredBlob;
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
  return {
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
