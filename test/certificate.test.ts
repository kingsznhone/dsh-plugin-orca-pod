import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import { nodeCertificate, nodeOfCertificate } from "../src/core/certificate.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";

describe("node certificate (§7.7)", () => {
  it("is a self-signed certificate over the node's own identity key", () => {
    const identity = generateNodeIdentity();
    const { key, cert } = nodeCertificate(identity);
    expect(key).toBe(identity.privateKeyPem);
    const parsed = new X509Certificate(cert);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.publicKey.asymmetricKeyType).toBe("ed25519");
    // The key the certificate carries is the node id: what a caller pins.
    expect(nodeOfCertificate(parsed)).toBe(identity.orcaNodeId);
    expect(new Date(parsed.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(parsed.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
  });

  it("is valid DER every time: the random serial never needs padding", () => {
    // A serial whose first byte came out 0x00 (or needed a sign byte) is invalid
    // DER; OpenSSL 3 refuses such a certificate. One in 256 would hit it.
    const identity = generateNodeIdentity();
    for (let round = 0; round < 2000; round += 1) {
      const parsed = new X509Certificate(nodeCertificate(identity).cert);
      expect(nodeOfCertificate(parsed)).toBe(identity.orcaNodeId);
    }
  });
});
