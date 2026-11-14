import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

  it("rejects path-like blob ids", () => {
    const store = createFsBlobStore(tempDir());
    expect(store.has("../../etc/passwd")).toBe(false);
    expect(store.get("../escape")).toBeUndefined();
  });
});
