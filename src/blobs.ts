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

type PutStreamOptions = {
  name?: string;
  media_type?: string;
  maxBytes?: number;
  /** Digest the uploader declared (`X-Pod-Body-SHA256`). */
  sha256?: string;
};

function digestMismatch(declared: string, actual: string): PodError {
  return new PodError("blob_digest_mismatch", `declared sha256 ${declared}, received ${actual}`);
}

/** Later of two expiries; `null` means "never expires" and wins. */
function laterExpiry(current: string | null, next: string | null): string | null {
  if (current === null || next === null) return null;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

export interface BlobStore {
  /**
   * Store bytes; returns the content hash. Same bytes => same id, no duplicate;
   * storing them again extends the expiry as if they were new.
   */
  put(bytes: Buffer | Uint8Array, options?: { name?: string; media_type?: string }): StoredBlob;
  /**
   * Streamed upload; never buffers the body (§5.6). With `sha256`, bytes whose
   * digest differs are discarded and the call fails with `blob_digest_mismatch`
   * instead of being stored under their real digest.
   */
  putStream(stream: Readable, options?: PutStreamOptions): Promise<BlobRecord>;
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
  const expiry = (): string | null => (ttlMs === null ? null : new Date(Date.now() + ttlMs).toISOString());
  const store: BlobStore = {
    put(bytes, options): StoredBlob {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const blobId = sha256Hex(buffer);
      const existing = blobs.get(blobId);
      if (existing) {
        existing.expires_at = laterExpiry(existing.expires_at, expiry());
        return { ...existing };
      }
      const blob: StoredBlob = {
        blob_id: blobId,
        size: buffer.length,
        name: options?.name ?? null,
        media_type: options?.media_type ?? null,
        expires_at: expiry(),
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
      const bytes = Buffer.concat(chunks);
      const actual = sha256Hex(bytes);
      if (options?.sha256 !== undefined && options.sha256 !== actual) throw digestMismatch(options.sha256, actual);
      return recordOf(store.put(bytes, options));
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
 * small JSON sidecar holding name/media type/expiry.
 *
 * The sidecar is the commit marker. Bytes go to a temp file that is renamed
 * into place, and only then is the sidecar written (also temp + rename). A
 * crash between the two leaves a data file without a sidecar: it is not a blob
 * (`has`/`get`/`stat` all say no), the next upload of the same bytes completes
 * it, and `gc()` removes it after the `.part` grace period. A sidecar whose data
 * file vanished is likewise not a blob and is dropped by `gc()`.
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

  /** The sidecar of a complete blob: both files present. */
  function committedMeta(blobId: string): Meta | undefined {
    if (!BLOB_ID_PATTERN.test(blobId)) return undefined;
    const meta = readMeta(blobId);
    return meta !== undefined && existsSync(pathFor(blobId)) ? meta : undefined;
  }

  function* sidecars(): Generator<{ blobId: string; meta: Meta }> {
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
  for (const { meta } of sidecars()) used += meta.size;

  const quotaExceeded = (): PodError => new PodError("quota_exceeded", `the blob store is full (${quota} bytes)`);

  const expiry = (): string | null => (ttlMs === null ? null : new Date(now() + ttlMs).toISOString());

  function writeMeta(blobId: string, meta: Meta): void {
    const metaTemp = `${metaFor(blobId)}.${randomBytes(6).toString("hex")}.part`;
    writeFileSync(metaTemp, JSON.stringify(meta));
    renameSync(metaTemp, metaFor(blobId));
  }

  /**
   * The bytes are already stored: count this as a new upload and extend the
   * expiry, so a re-upload made just before a task cannot expire under it.
   */
  function refresh(blobId: string, meta: Meta): Meta {
    const expires_at = laterExpiry(meta.expires_at, expiry());
    if (expires_at === meta.expires_at) return meta;
    const next = { ...meta, expires_at };
    writeMeta(blobId, next);
    return next;
  }

  /** Place finished bytes (a temp file) and write the sidecar that commits them. */
  function commit(blobId: string, temp: string, meta: Meta): void {
    // A sidecar left without its data was already counted at startup.
    const stale = readMeta(blobId);
    if (stale !== undefined) used -= stale.size;
    const final = pathFor(blobId);
    mkdirSync(dirname(final), { recursive: true });
    renameSync(temp, final);
    writeMeta(blobId, meta);
    used += meta.size;
  }

  function dropStale(path: string, at: number): void {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat !== undefined && at - stat.mtimeMs > PART_GRACE_MS) rmSync(path, { force: true });
  }

  function stat(blobId: string): BlobRecord | undefined {
    const meta = committedMeta(blobId);
    return meta && { blob_id: blobId, ...meta };
  }

  return {
    put(bytes, putOptions): StoredBlob {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      const blobId = sha256Hex(buffer);
      const existing = committedMeta(blobId);
      if (existing) return { blob_id: blobId, ...refresh(blobId, existing), bytes: buffer };
      if (used + inflight + buffer.length > quota) throw quotaExceeded();
      const final = pathFor(blobId);
      mkdirSync(dirname(final), { recursive: true });
      const temp = `${final}.${randomBytes(6).toString("hex")}.part`;
      writeFileSync(temp, buffer);
      const meta: Meta = {
        size: buffer.length,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: expiry(),
      };
      commit(blobId, temp, meta);
      return { blob_id: blobId, ...meta, bytes: buffer };
    },
    get(blobId) {
      const meta = committedMeta(blobId);
      if (!meta) return undefined;
      return { blob_id: blobId, ...meta, bytes: readFileSync(pathFor(blobId)) };
    },
    has(blobId) {
      return committedMeta(blobId) !== undefined;
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
      if (putOptions?.sha256 !== undefined && putOptions.sha256 !== blobId) {
        // The uploader signed a different digest: these bytes are not what was
        // authorized, so they are not kept under any id.
        rmSync(temp, { force: true });
        throw digestMismatch(putOptions.sha256, blobId);
      }
      const existing = committedMeta(blobId);
      if (existing) {
        rmSync(temp, { force: true });
        return { blob_id: blobId, ...refresh(blobId, existing) };
      }
      const meta: Meta = {
        size,
        name: putOptions?.name ?? null,
        media_type: putOptions?.media_type ?? null,
        expires_at: expiry(),
      };
      commit(blobId, temp, meta);
      return { blob_id: blobId, ...meta };
    },
    openRead(blobId) {
      const record = stat(blobId);
      if (!record) return undefined;
      return { stream: createReadStream(pathFor(blobId)), size: record.size, record };
    },
    stat,
    async copyTo(blobId, destination) {
      if (committedMeta(blobId) === undefined) return false;
      await copyFile(pathFor(blobId), destination);
      return true;
    },
    gc() {
      const at = now();
      let removed = 0;
      let kept = 0;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        // Orphans of a crashed upload: `.upload-*.part` in the root.
        if (entry.isFile() && entry.name.endsWith(".part")) dropStale(path, at);
        if (!entry.isDirectory()) continue;
        for (const name of readdirSync(path)) {
          const file = join(path, name);
          // Temp files of a crashed write, and data files whose sidecar was never written.
          if (name.endsWith(".part")) dropStale(file, at);
          else if (BLOB_ID_PATTERN.test(name) && !existsSync(`${file}.json`)) dropStale(file, at);
        }
      }
      for (const { blobId, meta } of sidecars()) {
        const missing = !existsSync(pathFor(blobId));
        if (missing || (meta.expires_at !== null && Date.parse(meta.expires_at) <= at)) {
          rmSync(pathFor(blobId), { force: true });
          rmSync(metaFor(blobId), { force: true });
          if (!missing) removed += 1;
        } else {
          kept += meta.size;
        }
      }
      used = kept;
      return removed;
    },
  };
}
