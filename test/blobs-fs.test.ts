import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Readable } from "node:stream";

import { PART_GRACE_MS } from "../src/blobs.ts";
import { createFsBlobStore, sha256Hex } from "../src/storage.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-blobs-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fs blob store", () => {
  it("stores content-addressed bytes with metadata", () => {
    const store = createFsBlobStore(tempDir());
    const bytes = Buffer.from("hello blob\n");
    const blob = store.put(bytes, { name: "hello.txt", media_type: "text/plain" });

    expect(blob.blob_id).toBe(sha256Hex(bytes));
    expect(blob.size).toBe(bytes.length);
    expect(store.has(blob.blob_id)).toBe(true);
    expect(store.get(blob.blob_id)?.bytes.equals(bytes)).toBe(true);
    expect(store.get(blob.blob_id)?.name).toBe("hello.txt");
  });

  it("dedupes identical bytes", () => {
    const store = createFsBlobStore(tempDir());
    const first = store.put(Buffer.from("same"));
    const second = store.put(Buffer.from("same"));
    expect(second.blob_id).toBe(first.blob_id);
  });

  it("survives a store reopen", () => {
    const root = tempDir();
    const first = createFsBlobStore(root);
    const blob = first.put(Buffer.from("durable"));

    const second = createFsBlobStore(root);
    expect(second.has(blob.blob_id)).toBe(true);
    expect(second.get(blob.blob_id)?.bytes.toString()).toBe("durable");
  });

  it("collects expired blobs on gc", () => {
    let now = 1_000_000;
    const store = createFsBlobStore(tempDir(), { ttlMs: 1000, now: () => now });
    const blob = store.put(Buffer.from("short lived"));

    expect(store.gc()).toBe(0);
    now += 1500;
    expect(store.gc()).toBe(1);
    expect(store.has(blob.blob_id)).toBe(false);
    expect(store.get(blob.blob_id)).toBeUndefined();
  });

  it("reports a blob's size without reading it", () => {
    const store = createFsBlobStore(tempDir());
    const blob = store.put(Buffer.from("twelve bytes"), { name: "t.txt" });
    expect(store.stat(blob.blob_id)).toMatchObject({ blob_id: blob.blob_id, size: 12, name: "t.txt" });
    expect(store.stat("a".repeat(64))).toBeUndefined();
    expect(store.stat("../escape")).toBeUndefined();
  });

  it("removes the temp files of crashed uploads once they are stale, and only then", () => {
    const root = tempDir();
    const store = createFsBlobStore(root);
    const blob = store.put(Buffer.from("kept"));
    const prefixDir = join(root, blob.blob_id.slice(0, 2));
    mkdirSync(join(root, "ab"), { recursive: true });
    const orphans = [
      join(root, ".upload-deadbeef.part"),
      join(root, "ab", `${"b".repeat(64)}.0123.part`),
      join(prefixDir, `${blob.blob_id}.json.part`),
    ];
    const fresh = join(root, ".upload-fresh.part");
    for (const path of [...orphans, fresh]) writeFileSync(path, "partial");
    const old = new Date(Date.now() - PART_GRACE_MS - 60_000);
    for (const path of orphans) utimesSync(path, old, old);

    store.gc();

    for (const path of orphans) expect(existsSync(path)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(store.get(blob.blob_id)?.bytes.toString()).toBe("kept");
  });

  it("refuses uploads that would pass the store quota and frees room when blobs expire", async () => {
    let now = 1_000_000;
    const store = createFsBlobStore(tempDir(), { ttlMs: 1000, now: () => now, maxBytes: 10 });
    store.put(Buffer.from("123456"));

    expect(() => store.put(Buffer.from("abcdef"))).toThrowError(expect.objectContaining({ code: "quota_exceeded" }));
    await expect(store.putStream(Readable.from([Buffer.from("abc"), Buffer.from("defg")]))).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    // A refused stream leaves no temp file behind and the store still takes what fits.
    expect(store.put(Buffer.from("abcd")).size).toBe(4);
    // The same content is not charged twice.
    expect(store.put(Buffer.from("123456")).size).toBe(6);

    now += 1500;
    expect(store.gc()).toBe(2);
    expect(store.put(Buffer.from("0123456789")).size).toBe(10);
  });

  it("discards streamed bytes whose digest differs from the declared one", async () => {
    const root = tempDir();
    const store = createFsBlobStore(root);
    const payload = Buffer.from("actual bytes");
    await expect(
      store.putStream(Readable.from([payload]), { sha256: sha256Hex(Buffer.from("declared bytes")) }),
    ).rejects.toMatchObject({ code: "blob_digest_mismatch" });
    expect(store.has(sha256Hex(payload))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    // The matching digest is accepted as usual.
    const stored = await store.putStream(Readable.from([payload]), { sha256: sha256Hex(payload) });
    expect(stored.blob_id).toBe(sha256Hex(payload));
  });

  it("extends the expiry when the same bytes are uploaded again", async () => {
    let now = 1_000_000;
    const root = tempDir();
    const store = createFsBlobStore(root, { ttlMs: 1000, now: () => now });
    const first = store.put(Buffer.from("again"));
    now += 800;
    const second = await store.putStream(Readable.from([Buffer.from("again")]));
    expect(Date.parse(second.expires_at ?? "")).toBeGreaterThan(Date.parse(first.expires_at ?? ""));
    now += 500;
    // Past the first expiry, inside the refreshed one.
    expect(store.gc()).toBe(0);
    expect(store.has(first.blob_id)).toBe(true);
    // A reopened store reads the refreshed sidecar.
    expect(createFsBlobStore(root, { ttlMs: 1000, now: () => now }).stat(first.blob_id)?.expires_at).toBe(
      second.expires_at,
    );
  });

  it("does not treat data without a sidecar as a blob, completes it on re-upload, and collects it", () => {
    let now = Date.now();
    const root = tempDir();
    const store = createFsBlobStore(root, { now: () => now });
    const bytes = Buffer.from("crashed before the sidecar");
    const blobId = sha256Hex(bytes);
    const dataPath = join(root, blobId.slice(0, 2), blobId);
    mkdirSync(join(root, blobId.slice(0, 2)), { recursive: true });
    writeFileSync(dataPath, bytes);

    expect(store.has(blobId)).toBe(false);
    expect(store.get(blobId)).toBeUndefined();
    expect(store.stat(blobId)).toBeUndefined();

    // Within the grace period gc leaves it (an upload may be finishing it)...
    expect(store.gc()).toBe(0);
    expect(existsSync(dataPath)).toBe(true);
    // ...and once it is stale, the orphan goes.
    now += PART_GRACE_MS + 60_000;
    store.gc();
    expect(existsSync(dataPath)).toBe(false);

    // The same bytes uploaded again are a complete blob.
    writeFileSync(dataPath, bytes);
    expect(store.put(bytes).blob_id).toBe(blobId);
    expect(store.has(blobId)).toBe(true);
  });

  it("rejects path-like blob ids", () => {
    const store = createFsBlobStore(tempDir());
    expect(store.has("../../etc/passwd")).toBe(false);
    expect(store.get("../escape")).toBeUndefined();
  });
});
