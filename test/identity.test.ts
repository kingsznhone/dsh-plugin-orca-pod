import { describe, expect, it } from "vitest";

import {
  exportIdentity,
  generateNodeIdentity,
  importIdentity,
  signWithIdentity,
  verifyWithNodeId,
} from "../src/core/identity.ts";

/** A seed of 32 bytes, two of them leading zeros, in base58 (Bitcoin alphabet): what an identity is stored as. */
const SEED_WITH_LEADING_ZEROS = "11CiMQsCUhqABwwLyCFeX2iPnBZX3s28dUUCBrirhs";

describe("node identity", () => {
  it("is exported as the base58 of its 32-byte seed and imported back as the same node", () => {
    const identity = generateNodeIdentity();
    const text = exportIdentity(identity);
    expect(text).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);

    const again = importIdentity(text);
    expect(again.orcaNodeId).toBe(identity.orcaNodeId);
    // The imported key signs as the same node.
    const signature = signWithIdentity(again, "hello");
    expect(verifyWithNodeId(identity.orcaNodeId, "hello", signature)).toBe(true);
    expect(verifyWithNodeId(identity.orcaNodeId, "hullo", signature)).toBe(false);
  });

  it("keeps leading zero bytes of the seed as leading ones", () => {
    expect(exportIdentity(importIdentity(SEED_WITH_LEADING_ZEROS))).toBe(SEED_WITH_LEADING_ZEROS);
  });

  it("refuses text that is not an Ed25519 seed", () => {
    expect(() => importIdentity("0OIl")).toThrow(/base58/i);
    // 31 bytes of 7.
    expect(() => importIdentity("7DUeBUtEcb7nujVZRJmeBju3X1mo6PpnWNtJ9EBhdY")).toThrow(/32 bytes/);
  });
});
