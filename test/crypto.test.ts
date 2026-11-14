import { describe, expect, it } from "vitest";
import { generateNodeId } from "../src/protocol.ts";
import {
  NonceCache,
  PodAuthError,
  bodySha256,
  buildAuthHeader,
  deriveWorkgroupKey,
  parseAuthHeader,
  verifyAuth,
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
  it("roundtrips with a fresh NonceCache and returns the node id", () => {
    const key = freshKey();
    const nodeId = generateNodeId();
    const body = JSON.stringify({ task_id: "t_01JABD", message: "hello" });
    const header = buildAuthHeader({ key, nodeId, method: METHOD, path: PATH, body });

    const verified = verifyAuth({
      key,
      method: METHOD,
      path: PATH,
      body,
      header,
      nonceCache: new NonceCache(),
    });

    expect(verified.nodeId).toBe(nodeId);
  });

  it("rejects a tampered body with bad_proof", () => {
    const key = freshKey();
    const header = buildAuthHeader({
      key,
      nodeId: generateNodeId(),
      method: METHOD,
      path: PATH,
      body: "original",
    });

    expectAuthError("bad_proof", () => {
      verifyAuth({
        key,
        method: METHOD,
        path: PATH,
        body: "tampered",
        header,
        nonceCache: new NonceCache(),
      });
    });
  });

  it("rejects a replayed header with nonce_replay", () => {
    const key = freshKey();
    const header = buildAuthHeader({
      key,
      nodeId: generateNodeId(),
      method: METHOD,
      path: PATH,
      body: "replay-me",
    });
    const nonceCache = new NonceCache();

    verifyAuth({ key, method: METHOD, path: PATH, body: "replay-me", header, nonceCache });

    expectAuthError("nonce_replay", () => {
      verifyAuth({ key, method: METHOD, path: PATH, body: "replay-me", header, nonceCache });
    });
  });

  it("rejects a timestamp outside the skew window with clock_skew", () => {
    const key = freshKey();
    const header = buildAuthHeader({
      key,
      nodeId: generateNodeId(),
      method: METHOD,
      path: PATH,
      ts: Date.now() - 5 * 60_000,
    });

    expectAuthError("clock_skew", () => {
      verifyAuth({ key, method: METHOD, path: PATH, header, nonceCache: new NonceCache() });
    });
  });

  it("rejects a missing header with missing_auth", () => {
    expectAuthError("missing_auth", () => {
      verifyAuth({
        key: freshKey(),
        method: METHOD,
        path: PATH,
        header: undefined,
        nonceCache: new NonceCache(),
      });
    });
  });

  it("rejects a malformed header with malformed_auth", () => {
    expectAuthError("malformed_auth", () => {
      verifyAuth({
        key: freshKey(),
        method: METHOD,
        path: PATH,
        header: "Bearer x",
        nonceCache: new NonceCache(),
      });
    });
  });
});

describe("bodySha256", () => {
  it("hashes an empty body to 64 hex characters", () => {
    expect(bodySha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a string body to 64 hex characters", () => {
    expect(bodySha256("hello pod")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bodies", () => {
    expect(bodySha256("alpha")).not.toBe(bodySha256("beta"));
  });
});

describe("parseAuthHeader", () => {
  it("parses a Pod auth header", () => {
    expect(parseAuthHeader("Pod node_id=ABC123; ts=1; nonce=n1; proof=p1")).toEqual({
      nodeId: "ABC123",
      ts: 1,
      nonce: "n1",
      proof: "p1",
    });
  });

  it("returns null for missing or non-Pod headers", () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("Bearer x")).toBeNull();
  });
});
