import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { identityPath, loadIdentity, loadOrCreateIdentity } from "../src/core/identity.ts";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "orca-identity-"));

describe("node identity file", () => {
  it("has no identity before the first start, and keeps the one it creates", async () => {
    const root = tempRoot();
    expect(loadIdentity(root)).toBeNull();
    const created = await loadOrCreateIdentity(root);
    expect(loadIdentity(root)?.orcaNodeId).toBe(created.orcaNodeId);
    expect((await loadOrCreateIdentity(root)).orcaNodeId).toBe(created.orcaNodeId);
  });

  it("refuses a damaged identity file instead of silently making a new node (B6)", async () => {
    const root = tempRoot();
    await loadOrCreateIdentity(root);
    const before = readFileSync(identityPath(root), "utf8");
    writeFileSync(identityPath(root), "{ not json");
    expect(() => loadIdentity(root)).toThrow(/valid Ed25519 private key/);
    await expect(loadOrCreateIdentity(root)).rejects.toThrow(/valid Ed25519 private key/);
    // Nothing overwrote the damaged file: the owner can still restore it.
    expect(readFileSync(identityPath(root), "utf8")).toBe("{ not json");
    expect(before).not.toBe("{ not json");
  });

  it("gives processes that start together the same identity (B19)", async () => {
    const root = tempRoot();
    const ids = await Promise.all(Array.from({ length: 5 }, async () => (await loadOrCreateIdentity(root)).orcaNodeId));
    expect(new Set(ids).size).toBe(1);
    expect(loadIdentity(root)?.orcaNodeId).toBe(ids[0]);
  });
});
