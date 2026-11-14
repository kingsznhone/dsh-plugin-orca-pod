import { createHash, randomBytes } from "node:crypto";

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
  };
}

/** Random token for /blobs/{id}/link short-lived download URLs (§5.6). */
export function newLinkToken(): string {
  return randomBytes(18).toString("base64url");
}
