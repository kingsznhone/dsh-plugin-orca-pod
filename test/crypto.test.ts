import { describe, expect, it } from "vitest";
import { generateNodeIdentity } from "../src/identity.ts";
import type { Grant } from "../src/protocol.ts";
import {
  DEFAULT_CLOCK_SKEW_MS,
  NonceCache,
  PodAuthError,
  blobLinkSignature,
  bodySha256,
  buildAuthHeader,
  buildJoinProof,
  deriveWorkgroupKey,
  parseAuthHeader,
  signGrant,
  verifyAuth,
  verifyBlobLinkSignature,
  verifyGrant,
  verifyJoinProof,
  type AuthErrorCode,
} from "../src/crypto.ts";

const WORKGROUP_ID = "orca-dev";
const PASSWORD = "correct horse battery staple";
const METHOD = "POST";
const PATH = "/a2a/message";

function freshKey(): Buffer {
  return deriveWorkgroupKey(WORKGROUP_ID, PASSWORD);
}

function expectAuthError(code: AuthErrorCode, action: () => void): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PodAuthError);
  if (!(caught instanceof PodAuthError)) {
    throw new Error(`expected PodAuthError with code ${code}`);
  }
  expect(caught.code).toBe(code);
}

describe("deriveWorkgroupKey", () => {
  it("derives 32 bytes", () => {
    expect(freshKey()).toHaveLength(32);
  });

  it("is deterministic", () => {
    expect(freshKey().equals(freshKey())).toBe(true);
  });

  it("differs by workgroup id", () => {
    const other = deriveWorkgroupKey("orca-other", PASSWORD);
    expect(other.equals(freshKey())).toBe(false);
  });

  it("differs by password", () => {
    const other = deriveWorkgroupKey(WORKGROUP_ID, "different password");
    expect(other.equals(freshKey())).toBe(false);
  });
});

describe("buildAuthHeader + verifyAuth", () => {
  it("roundtrips and returns the signing orca node id", () => {
    const identity = generateNodeIdentity();
    const body = JSON.stringify({ task_id: "t_01JABD", message: "hello" });
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH, body });

    expect(header).toContain(`orca_node_id=${identity.orcaNodeId}`);
    const verified = verifyAuth({ method: METHOD, path: PATH, body, header, nonceCache: new NonceCache() });
    expect(verified.orcaNodeId).toBe(identity.orcaNodeId);
    expect(verified.nonce.length).toBeGreaterThan(0);
  });

  it("signs a caller-provided body digest for streamed bodies", () => {
    const identity = generateNodeIdentity();
    const digest = bodySha256("streamed");
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH, bodySha256: digest });
    const verified = verifyAuth({
      method: METHOD,
      path: PATH,
      bodySha256: digest,
      header,
      nonceCache: new NonceCache(),
    });
    expect(verified.orcaNodeId).toBe(identity.orcaNodeId);
  });

  it("rejects a tampered body with bad_signature", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH, body: "original" });
    expectAuthError("bad_signature", () =>
      verifyAuth({ method: METHOD, path: PATH, body: "tampered", header, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a stale timestamp with clock_skew", () => {
    const identity = generateNodeIdentity();
    const now = Date.now();
    const header = buildAuthHeader({
      identity,
      method: METHOD,
      path: PATH,
      ts: now - DEFAULT_CLOCK_SKEW_MS - 1_000,
    });
    expectAuthError("clock_skew", () =>
      verifyAuth({ method: METHOD, path: PATH, header, nonceCache: new NonceCache(), now }),
    );
  });

  it("rejects a replayed nonce", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH });
    const nonceCache = new NonceCache();
    verifyAuth({ method: METHOD, path: PATH, header, nonceCache });
    expectAuthError("nonce_replay", () => verifyAuth({ method: METHOD, path: PATH, header, nonceCache }));
  });

  it("rejects a missing header with missing_auth", () => {
    expectAuthError("missing_auth", () =>
      verifyAuth({ method: METHOD, path: PATH, header: undefined, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a malformed header with malformed_auth", () => {
    expectAuthError("malformed_auth", () =>
      verifyAuth({ method: METHOD, path: PATH, header: "Bearer nope", nonceCache: new NonceCache() }),
    );
  });

  it("rejects a header carrying a non-Ed25519 orca node id", () => {
    expectAuthError("malformed_auth", () =>
      verifyAuth({
        method: METHOD,
        path: PATH,
        header: "Pod orca_node_id=ABC123; ts=1; nonce=n; sig=s",
        nonceCache: new NonceCache(),
      }),
    );
  });
});

describe("parseAuthHeader", () => {
  it("parses the identity, timestamp, nonce and signature", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH, ts: 1_700_000_000_000, nonce: "abc" });
    const parsed = parseAuthHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.orcaNodeId).toBe(identity.orcaNodeId);
    expect(parsed?.ts).toBe(1_700_000_000_000);
    expect(parsed?.nonce).toBe("abc");
    expect(parsed?.signature.length).toBeGreaterThan(0);
  });

  it("accepts the legacy proof field name", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, path: PATH });
    expect(parseAuthHeader(header.replace("; sig=", "; proof="))).not.toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("")).toBeNull();
    expect(parseAuthHeader("Bearer token")).toBeNull();
    expect(parseAuthHeader("Pod orca_node_id=x; ts=1; nonce=n")).toBeNull();
  });
});

describe("join admission proof", () => {
  const fields = { workgroupId: WORKGROUP_ID, orcaNodeId: "x".repeat(43), ts: 1_700_000_000_000, nonce: "n1" };

  it("verifies with the derived workgroup key", () => {
    const proof = buildJoinProof(freshKey(), fields);
    expect(verifyJoinProof(freshKey(), fields, proof)).toBe(true);
  });

  it("is deterministic per field set", () => {
    expect(buildJoinProof(freshKey(), fields)).toBe(buildJoinProof(freshKey(), fields));
  });

  it("rejects a different password, node or nonce", () => {
    const proof = buildJoinProof(freshKey(), fields);
    const wrongKey = deriveWorkgroupKey(WORKGROUP_ID, "different password");
    expect(verifyJoinProof(wrongKey, fields, proof)).toBe(false);
    expect(verifyJoinProof(freshKey(), { ...fields, orcaNodeId: "y".repeat(43) }, proof)).toBe(false);
    expect(verifyJoinProof(freshKey(), { ...fields, nonce: "n2" }, proof)).toBe(false);
  });
});

describe("grants", () => {
  const identity = generateNodeIdentity();
  const grant: Grant = {
    grant_id: "g-1",
    workgroup_id: WORKGROUP_ID,
    origin_orca_node: identity.orcaNodeId,
    task_id: "t-1",
    target_orca_node: "z".repeat(43),
    tool: "write_file",
    mode: "allow_once",
    chain: [identity.orcaNodeId],
    issued_at: new Date(0).toISOString(),
    expires_at: new Date(60_000).toISOString(),
  };

  it("verifies against the signing origin node", () => {
    const signed = signGrant(identity, grant);
    expect(signed.sig.length).toBeGreaterThan(0);
    expect(verifyGrant(identity.orcaNodeId, signed)).toBe(true);
  });

  it("rejects a tampered grant", () => {
    const signed = signGrant(identity, grant);
    expect(verifyGrant(identity.orcaNodeId, { ...signed, tool: "delete_everything" })).toBe(false);
  });

  it("rejects verification against a different origin", () => {
    const signed = signGrant(identity, grant);
    expect(verifyGrant(generateNodeIdentity().orcaNodeId, signed)).toBe(false);
  });
});

describe("blob link signatures", () => {
  const identity = generateNodeIdentity();
  const exp = "1700000000";

  it("roundtrips", () => {
    const sig = blobLinkSignature(identity, "abc123", exp);
    expect(verifyBlobLinkSignature(identity.orcaNodeId, "abc123", exp, sig)).toBe(true);
  });

  it("rejects a different blob or expiry", () => {
    const sig = blobLinkSignature(identity, "abc123", exp);
    expect(verifyBlobLinkSignature(identity.orcaNodeId, "def456", exp, sig)).toBe(false);
    expect(verifyBlobLinkSignature(identity.orcaNodeId, "abc123", "1700000001", sig)).toBe(false);
  });
});
