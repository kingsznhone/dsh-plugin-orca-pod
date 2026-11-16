import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  it("rejects path-like blob ids", () => {
    const store = createFsBlobStore(tempDir());
    expect(store.has("../../etc/passwd")).toBe(false);
    expect(store.get("../escape")).toBeUndefined();
  });
});
