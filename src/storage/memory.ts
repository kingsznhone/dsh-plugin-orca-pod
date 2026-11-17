/** In-memory stores: unit tests, harness nodes and any node created without persistent storage. */

import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { digestMismatch, laterExpiry, recordOf, sha256Hex, tooLarge } from "./blob-common.ts";
import type {
  BlobRecord,
  BlobRead,
  BlobStore,
  DispatchEntry,
  DispatchStore,
  FileBlob,
  FileBlobStore,
  PersistedTask,
  StoredBlob,
  TaskStore,
} from "./index.ts";

function cloneTask(task: PersistedTask): PersistedTask {
  return structuredClone(task);
}

/** Protocol tests and harness orca nodes use this; the CLI/plugin wire SQLite. */
export function createMemoryTaskStore(initial: readonly PersistedTask[] = []): TaskStore {
  const tasks = new Map<string, PersistedTask>();
  for (const task of initial) tasks.set(task.view.id, cloneTask(task));
  return {
    save(task: PersistedTask): void {
      tasks.set(task.view.id, cloneTask(task));
    },
    load(taskId: string): PersistedTask | undefined {
      const task = tasks.get(taskId);
      return task ? cloneTask(task) : undefined;
    },
    list(): PersistedTask[] {
      return [...tasks.values()].map(cloneTask).sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    },
    close() {},
  };
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

export function createMemoryDispatchStore(): DispatchStore {
  const entries = new Map<string, DispatchEntry>();
  const store: DispatchStore = {
    save(entry) {
      entries.set(entry.task_id, entry);
    },
    get: (taskId) => entries.get(taskId),
    list: () => [...entries.values()].sort((left, right) => left.created_at.localeCompare(right.created_at)),
    remove(taskId) {
      entries.delete(taskId);
    },
    close() {},
  };
  return store;
}
