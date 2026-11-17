/**
 * Storage contracts (§5.5, §5.6, §8.3). Business code depends on these
 * interfaces only; the memory and SQLite implementations next to this
 * file are wired by the assembly points (`node/`, `plugin/`, `cli/`).
 */

import type { Readable } from "node:stream";

import type { DispatchEntry } from "../protocol/dispatch.ts";
import type { OrcaNodeId } from "../protocol/peer.ts";
import type { TaskView } from "../protocol/task.ts";

// Tasks (§5.5)

/**
 * Durable task record (§5.5). The view is the A2A `TaskView` the gateway
 * serves; the extra fields belong to the local store only.
 */
export type PersistedTask = {
  view: TaskView;
  origin_orca_node: OrcaNodeId;
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

// Origin-side dispatch log (§8.3); what the entries mean is decided in `tasks/delegation.ts` (`markInFlightUnknown`).

export type DispatchStore = {
  save(entry: DispatchEntry): void;
  get(taskId: string): DispatchEntry | undefined;
  list(): DispatchEntry[];
  remove(taskId: string): void;
  close(): void;
};
