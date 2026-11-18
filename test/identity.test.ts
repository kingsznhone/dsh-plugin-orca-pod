import { describe, expect, it } from "vitest";

import {
  decodeBase58,
  encodeBase58,
  exportIdentity,
  generateNodeIdentity,
  importIdentity,
  signWithIdentity,
  verifyWithNodeId,
} from "../src/core/identity.ts";

describe("base58", () => {
  it("encodes the way the Bitcoin alphabet does", () => {
    expect(encodeBase58(Buffer.from("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(encodeBase58(Buffer.alloc(0))).toBe("");
  });

  it("keeps leading zero bytes as leading ones", () => {
    expect(encodeBase58(Buffer.from([0, 0, 1]))).toBe("112");
    expect(decodeBase58("112")).toEqual(Buffer.from([0, 0, 1]));
  });

  it("round-trips random bytes", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, () => Math.floor(Math.random() * 256)));
      expect(decodeBase58(encodeBase58(bytes))).toEqual(bytes);
    }
  });

  it("refuses a character outside the alphabet", () => {
    expect(() => decodeBase58("0OIl")).toThrow(/not a base58 character/);
  });
});

describe("node identity", () => {
  it("is exported as the base58 of its 32-byte seed and imported back as the same node", () => {
    const identity = generateNodeIdentity();
    const text = exportIdentity(identity);
    expect(decodeBase58(text)).toHaveLength(32);

    const again = importIdentity(text);
    expect(again.orcaNodeId).toBe(identity.orcaNodeId);
    // The imported key signs as the same node.
    const signature = signWithIdentity(again, "hello");
    expect(verifyWithNodeId(identity.orcaNodeId, "hello", signature)).toBe(true);
    expect(verifyWithNodeId(identity.orcaNodeId, "hullo", signature)).toBe(false);
  });

  it("refuses text that is not an Ed25519 seed", () => {
    expect(() => importIdentity("not*base58")).toThrow();
    expect(() => importIdentity(encodeBase58(Buffer.alloc(31, 7)))).toThrow(/32 bytes/);
  });
});
