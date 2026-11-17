import { describe, expect, it } from "vitest";
import { generateNodeIdentity } from "../src/security/identity.ts";
import type { Grant } from "../src/protocol/grant.ts";
import {
  DEFAULT_CLOCK_SKEW_MS,
  NonceCache,
  admissionProof,
  buildAuthHeader,
  deriveWorkgroupKey,
  parseAuthHeader,
  signGrant,
  verifyAdmissionProof,
  verifyAuth,
  verifyGrant,
  type VerifyAuthOptions,
} from "../src/security/crypto.ts";
import { PodError, type PodErrorCode } from "../src/kernel/errors.ts";
import { wg, fakeNodeId } from "./fixtures/ids.ts";

const WORKGROUP_ID = wg("orca-dev");
const PASSWORD = "correct horse battery staple";
const METHOD = "POST";
const PATH = "/a2a/message";
const TARGET = "target-orca-node";

/** `verifyAuth` with the receiver id and restart cutoff every real caller supplies. */
function verify(
  options: Partial<VerifyAuthOptions> & Pick<VerifyAuthOptions, "method" | "url" | "header" | "nonceCache">,
) {
  return verifyAuth({ targetOrcaNodeId: TARGET, notBefore: 0, ...options });
}

function freshKey(): Buffer {
  return deriveWorkgroupKey(WORKGROUP_ID, PASSWORD);
}

function expectAuthError(code: PodErrorCode, action: () => void): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PodError);
  if (!(caught instanceof PodError)) {
    throw new Error(`expected PodError with code ${code}`);
  }
  expect(caught.code).toBe(code);
}

describe("deriveWorkgroupKey", () => {
  it("derives 32 bytes", () => {
    expect(freshKey()).toHaveLength(32);
  });

  it("uses the memory-hard KDF (known vector)", () => {
    // scrypt(password, "orca-pod\x00<workgroup>", N=2^15, r=8, p=1, len=32).
    expect(freshKey().toString("hex")).toBe("91ccc5f4970b3dfd334eec59e845b15fcc2a416c89ae93505fdfff4ca1f54361");
  });

  it("is deterministic", () => {
    expect(freshKey().equals(freshKey())).toBe(true);
  });

  it("differs by workgroup id", () => {
    const other = deriveWorkgroupKey(wg("orca-other"), PASSWORD);
    expect(other.equals(freshKey())).toBe(false);
  });

  it("differs by password", () => {
    const other = deriveWorkgroupKey(WORKGROUP_ID, "different password");
    expect(other.equals(freshKey())).toBe(false);
  });
});

describe("buildAuthHeader + verifyAuth", () => {
  const URL_WITH_QUERY = `${PATH}?task=t_01JABD&x=1`;

  it("roundtrips and returns the signing orca node id", () => {
    const identity = generateNodeIdentity();
    const body = JSON.stringify({ task_id: "t_01JABD", message: "hello" });
    const header = buildAuthHeader({ identity, method: METHOD, url: URL_WITH_QUERY, targetOrcaNodeId: TARGET, body });

    expect(header).toContain(`orca_node_id=${identity.orcaNodeId}`);
    expect(header).toContain(`target=${TARGET}`);
    const verified = verify({
      method: METHOD,
      url: URL_WITH_QUERY,
      targetOrcaNodeId: TARGET,
      body,
      header,
      nonceCache: new NonceCache(),
    });
    expect(verified.orcaNodeId).toBe(identity.orcaNodeId);
    expect(verified.nonce.length).toBeGreaterThan(0);
  });

  it("binds the query string and the target into the signature", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, url: URL_WITH_QUERY, targetOrcaNodeId: TARGET });

    expectAuthError("bad_signature", () =>
      verify({
        method: METHOD,
        url: `${PATH}?task=other`,
        targetOrcaNodeId: TARGET,
        header,
        nonceCache: new NonceCache(),
      }),
    );
    expectAuthError("wrong_target", () =>
      verify({
        method: METHOD,
        url: URL_WITH_QUERY,
        targetOrcaNodeId: "another-orca-node",
        header,
        nonceCache: new NonceCache(),
      }),
    );
  });

  it("rejects a signed request without a target unless the route allows it", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, url: PATH });
    expectAuthError("wrong_target", () =>
      verify({ method: METHOD, url: PATH, targetOrcaNodeId: TARGET, header, nonceCache: new NonceCache() }),
    );
    expect(
      verify({
        method: METHOD,
        url: PATH,
        targetOrcaNodeId: TARGET,
        allowEmptyTarget: true,
        header,
        nonceCache: new NonceCache(),
      }).orcaNodeId,
    ).toBe(identity.orcaNodeId);
  });

  it("rejects a request issued before this process started with stale_request", () => {
    const identity = generateNodeIdentity();
    const now = Date.now();
    const header = buildAuthHeader({ identity, method: METHOD, url: PATH, targetOrcaNodeId: TARGET, ts: now - 5_000 });
    expectAuthError("stale_request", () =>
      verify({
        method: METHOD,
        url: PATH,
        targetOrcaNodeId: TARGET,
        notBefore: now - 1_000,
        header,
        nonceCache: new NonceCache(),
      }),
    );
  });

  it("rejects a tampered body with bad_signature", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, url: PATH, targetOrcaNodeId: TARGET, body: "original" });
    expectAuthError("bad_signature", () =>
      verify({
        method: METHOD,
        url: PATH,
        targetOrcaNodeId: TARGET,
        body: "tampered",
        header,
        nonceCache: new NonceCache(),
      }),
    );
  });

  it("rejects a stale timestamp with clock_skew", () => {
    const identity = generateNodeIdentity();
    const now = Date.now();
    const header = buildAuthHeader({
      identity,
      method: METHOD,
      url: PATH,
      targetOrcaNodeId: TARGET,
      ts: now - DEFAULT_CLOCK_SKEW_MS - 1_000,
    });
    expectAuthError("clock_skew", () =>
      verify({ method: METHOD, url: PATH, targetOrcaNodeId: TARGET, header, nonceCache: new NonceCache(), now }),
    );
  });

  it("rejects a request issued before the process started", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({
      identity,
      method: METHOD,
      url: PATH,
      targetOrcaNodeId: TARGET,
      ts: Date.now() - 5_000,
    });
    expectAuthError("stale_request", () =>
      verify({ method: METHOD, url: PATH, header, nonceCache: new NonceCache(), notBefore: Date.now() - 1_000 }),
    );
  });

  it("rejects a replayed nonce", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({ identity, method: METHOD, url: PATH, targetOrcaNodeId: TARGET });
    const nonceCache = new NonceCache();
    verify({ method: METHOD, url: PATH, targetOrcaNodeId: TARGET, header, nonceCache });
    expectAuthError("nonce_replay", () =>
      verify({ method: METHOD, url: PATH, targetOrcaNodeId: TARGET, header, nonceCache }),
    );
  });

  it("rejects a missing header with missing_auth", () => {
    expectAuthError("missing_auth", () =>
      verify({ method: METHOD, url: PATH, header: undefined, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a malformed header with malformed_auth", () => {
    expectAuthError("malformed_auth", () =>
      verify({ method: METHOD, url: PATH, header: "Bearer nope", nonceCache: new NonceCache() }),
    );
  });

  it("rejects a header carrying a non-Ed25519 orca node id", () => {
    expectAuthError("malformed_auth", () =>
      verify({
        method: METHOD,
        url: PATH,
        header: "Pod orca_node_id=ABC123; ts=1; nonce=n; sig=s",
        nonceCache: new NonceCache(),
      }),
    );
  });
});

describe("parseAuthHeader", () => {
  it("parses the identity, target, timestamp, nonce and signature", () => {
    const identity = generateNodeIdentity();
    const header = buildAuthHeader({
      identity,
      method: METHOD,
      url: PATH,
      targetOrcaNodeId: "target-orca-node",
      ts: 1_700_000_000_000,
      nonce: "abc",
    });
    const parsed = parseAuthHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.orcaNodeId).toBe(identity.orcaNodeId);
    expect(parsed?.target).toBe("target-orca-node");
    expect(parsed?.ts).toBe(1_700_000_000_000);
    expect(parsed?.nonce).toBe("abc");
    expect(parsed?.signature.length).toBeGreaterThan(0);
  });

  it("returns null for garbage", () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("")).toBeNull();
    expect(parseAuthHeader("Bearer token")).toBeNull();
    expect(parseAuthHeader("Pod orca_node_id=x; ts=1; nonce=n")).toBeNull();
  });
});

describe("join admission proof", () => {
  const fields = { workgroupId: WORKGROUP_ID, orcaNodeId: fakeNodeId("x"), ts: 1_700_000_000_000, nonce: "n1" };

  it("verifies with the derived workgroup key", () => {
    const proof = admissionProof("join", freshKey(), fields);
    expect(verifyAdmissionProof("join", freshKey(), fields, proof)).toBe(true);
  });

  it("does not let a join proof stand in for a heartbeat proof", () => {
    const proof = admissionProof("join", freshKey(), fields);
    expect(verifyAdmissionProof("heartbeat", freshKey(), fields, proof)).toBe(false);
  });

  it("is deterministic per field set", () => {
    expect(admissionProof("join", freshKey(), fields)).toBe(admissionProof("join", freshKey(), fields));
  });

  it("rejects a different password, node or nonce", () => {
    const proof = admissionProof("join", freshKey(), fields);
    const wrongKey = deriveWorkgroupKey(WORKGROUP_ID, "different password");
    expect(verifyAdmissionProof("join", wrongKey, fields, proof)).toBe(false);
    expect(verifyAdmissionProof("join", freshKey(), { ...fields, orcaNodeId: fakeNodeId("y") }, proof)).toBe(false);
    expect(verifyAdmissionProof("join", freshKey(), { ...fields, nonce: "n2" }, proof)).toBe(false);
  });
});

describe("grants", () => {
  const identity = generateNodeIdentity();
  const grant: Grant = {
    grant_id: "g-1",
    workgroup_id: WORKGROUP_ID,
    origin_orca_node: identity.orcaNodeId,
    task_id: "t-1",
    target_orca_node: fakeNodeId("z"),
    tool: "write_file",
    mode: "allow_once",
    request_id: "req-1",
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
