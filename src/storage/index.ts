/**
 * Storage contracts (§5.5, §5.6, §8.3). Business code depends on these
 * interfaces only; the memory, disk and SQLite implementations next to this
 * file are wired by the assembly points (`node/`, `plugin/`, `cli/`).
 */

import type { Readable } from "node:stream";

import type { TaskState, TaskView } from "../protocol/index.ts";

// Tasks (§5.5)

/**
 * Durable task record (§5.5). The view is the A2A `TaskView` the gateway
 * serves; the extra fields belong to the local store only.
 */
export type PersistedTask = {
  view: TaskView;
  origin_orca_node: string;
  created_at: string;
  updated_at: string;
};

/**
 * Task store contract. One process writes it, one process reads it (§5.5):
 * no pooling, no service, no shared database.
 */
export interface TaskStore {
  save(task: PersistedTask): void;
  load(taskId: string): PersistedTask | undefined;
  list(): PersistedTask[];
  /** Durable stores release their handle; memory stores have nothing to close. */
  close(): void;
}

// Content-addressed blobs (§5.6): an in-memory store and a disk store (with GC and a size quota) share one contract.

/** Metadata of one stored blob; its id is the sha256 of the bytes. */
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

export type PutStreamOptions = {
  name?: string;
  media_type?: string;
  maxBytes?: number;
  /** Digest the uploader declared (`X-Pod-Body-SHA256`). */
  sha256?: string;
};

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

/** Default retention for blobs nobody referenced (§5.6). */
export const DEFAULT_BLOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The one retention constant: uploads, published files and direct links. */
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

export type FileBlobRegistry = {
  register(path: string, ttlS?: number): Promise<FileBlob>;
  get(blobId: string): FileBlob | undefined;
  has(blobId: string): boolean;
};

// Origin-side dispatch log (§8.3); what the entries mean is decided in `delegation/dispatch-log.ts`.

export type DispatchEntry = {
  /** Task id returned by the target. */
  task_id: string;
  /** Target endpoint the task was dispatched to. */
  peer: string;
  context_id?: string;
  /** Last observed task state; `unknown` once a restart cut the origin off from it. */
  state: TaskState | "unknown";
  last_error?: string;
  /** When the dispatching task was itself a local task, its id (for automatic relay). */
  parent_local_task_id?: string;
  /**
   * DSH session that dispatched the task (§8.3). Persisted so the host can
   * resume background tracking after a restart, when the in-memory tracker is
   * empty but the remote task may still be running.
   */
  agent_id?: string;
  created_at: string;
  updated_at: string;
};

export type DispatchStore = {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  remove(taskId: string): void;
  close(): void;
};
