/** Helpers the memory and disk blob stores share. */

import { PodError } from "../kernel/errors.ts";
import type { BlobLabel, BlobMeta, BlobRecord } from "./stores.ts";

/** Raised when a streamed body exceeds the declared maximum (§5.6). */
export function tooLarge(limit: number): PodError {
  return new PodError("blob_too_large", `blob body exceeds ${limit} bytes`);
}

/** The record of a blob that was just stored: its size, its label (absent parts are `null`) and when it lapses. */
export function blobMeta(size: number, label: BlobLabel | undefined, expiresAt: string | null): BlobMeta {
  return { size, name: label?.name ?? null, media_type: label?.media_type ?? null, expires_at: expiresAt };
}

export function recordOf(blob: BlobRecord): BlobRecord {
  return {
    blob_id: blob.blob_id,
    size: blob.size,
    name: blob.name,
    media_type: blob.media_type,
    expires_at: blob.expires_at,
  };
}

export function digestMismatch(declared: string, actual: string): PodError {
  return new PodError("blob_digest_mismatch", `declared sha256 ${declared}, received ${actual}`);
}

/** Later of two expiries; `null` means "never expires" and wins. */
export function laterExpiry(current: string | null, next: string | null): string | null {
  if (current === null || next === null) return null;
  return Date.parse(next) > Date.parse(current) ? next : current;
}
