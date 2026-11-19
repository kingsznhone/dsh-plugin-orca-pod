import { describe, expect, it, vi } from "vitest";
import { generateNodeIdentity, type NodeIdentity } from "../src/core/identity.ts";
import {
  NonceCache,
  bodySha256,
  buildAuthHeader,
  buildReplyHeader,
  deriveWorkgroupKey,
  newNonce,
  parseAuthHeader,
  verifyAuth,
  verifyReplyHeader,
} from "../src/core/signing.ts";
import { PodError, type PodErrorCode } from "../src/core/errors.ts";
import { wg } from "./fixtures/ids.ts";

const WORKGROUP_ID = wg("orca-dev");
const PASSWORD = "correct horse battery staple";
const METHOD = "POST";
const PATH = "/a2a/message";
const TARGET = "target-orca-node";

function freshKey(): Buffer {
  return deriveWorkgroupKey(WORKGROUP_ID, PASSWORD);
}

const KEY = freshKey();

/** How far a request's timestamp may be from the receiver's clock. */
const CLOCK_SKEW_MS = 60_000;

type VerifyAuthOptions = Parameters<typeof verifyAuth>[0];

/** A header as a node of the workgroup builds it: both proofs, bound to `TARGET`. */
function header(
  identity: NodeIdentity,
  options: {
    url?: string;
    body?: string;
    ts?: number;
    nonce?: string;
    target?: string;
    key?: Buffer;
    workgroup?: typeof WORKGROUP_ID;
  } = {},
): string {
  const build = (): string =>
    buildAuthHeader({
      identity,
      key: options.key ?? KEY,
      workgroupId: options.workgroup ?? WORKGROUP_ID,
      method: METHOD,
      url: options.url ?? PATH,
      targetOrcaNodeId: options.target ?? TARGET,
      body: options.body,
      nonce: options.nonce ?? newNonce(),
    });
  if (options.ts === undefined) return build();
  // A header is stamped with the time it is built: build it at `ts`.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(options.ts);
    return build();
  } finally {
    vi.useRealTimers();
  }
}

/** `verifyAuth` the way the gateway calls it: the receiver, its workgroup and key, and the restart cutoff. */
function verify(
  options: Partial<VerifyAuthOptions> & Pick<VerifyAuthOptions, "method" | "url" | "header" | "nonceCache">,
) {
  return verifyAuth({ targetOrcaNodeId: TARGET, workgroupId: WORKGROUP_ID, key: KEY, notBefore: 0, ...options });
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
    const signed = header(identity, { url: URL_WITH_QUERY, body });

    expect(signed).toContain(`id=${identity.orcaNodeId}`);
    expect(signed).toContain(`wg=${WORKGROUP_ID}`);
    expect(signed).toContain(`target=${TARGET}`);
    expect(signed).toContain("proof=");
    const verified = verify({
      method: METHOD,
      url: URL_WITH_QUERY,
      body,
      header: signed,
      nonceCache: new NonceCache(),
    });
    expect(verified.orcaNodeId).toBe(identity.orcaNodeId);
  });

  it("binds the query string and the target into the signature", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { url: URL_WITH_QUERY });

    expectAuthError("bad_signature", () =>
      verify({ method: METHOD, url: `${PATH}?task=other`, header: signed, nonceCache: new NonceCache() }),
    );
    expectAuthError("wrong_target", () =>
      verify({
        method: METHOD,
        url: URL_WITH_QUERY,
        targetOrcaNodeId: "another-orca-node",
        header: signed,
        nonceCache: new NonceCache(),
      }),
    );
  });

  it("rejects a signed request without a target unless the route allows it", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { target: "" });
    expectAuthError("wrong_target", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
    expect(
      verify({ method: METHOD, url: PATH, allowEmptyTarget: true, header: signed, nonceCache: new NonceCache() })
        .orcaNodeId,
    ).toBe(identity.orcaNodeId);
  });

  it("rejects a request issued before this process started with stale_request", () => {
    const identity = generateNodeIdentity();
    const now = Date.now();
    const signed = header(identity, { ts: now - 5_000 });
    expectAuthError("stale_request", () =>
      verify({ method: METHOD, url: PATH, notBefore: now - 1_000, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a tampered body with bad_signature", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { body: "original" });
    expectAuthError("bad_signature", () =>
      verify({ method: METHOD, url: PATH, body: "tampered", header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a stale timestamp with clock_skew", () => {
    const identity = generateNodeIdentity();
    const now = Date.now();
    const signed = header(identity, { ts: now - CLOCK_SKEW_MS - 1_000 });
    expectAuthError("clock_skew", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("rejects a replayed nonce", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity);
    const nonceCache = new NonceCache();
    verify({ method: METHOD, url: PATH, header: signed, nonceCache });
    expectAuthError("nonce_replay", () => verify({ method: METHOD, url: PATH, header: signed, nonceCache }));
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
        header: `Pod id=ABC123; wg=${WORKGROUP_ID}; ts=1; nonce=n; sig=s; proof=p`,
        nonceCache: new NonceCache(),
      }),
    );
  });
});

describe("the two proofs of a request", () => {
  it("refuses a node that is not in the workgroup now: right signature, wrong password", () => {
    const identity = generateNodeIdentity();
    const otherPassword = deriveWorkgroupKey(WORKGROUP_ID, "a password that was changed");
    const signed = header(identity, { key: otherPassword });
    expectAuthError("bad_proof", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("refuses a request for another workgroup before looking at the proofs", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { workgroup: wg("orca-other") });
    expectAuthError("workgroup_mismatch", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("does not let the password stand in for the signature: another node's header cannot be re-signed", () => {
    // Whoever knows the password still cannot speak as a node it holds no key of: the
    // proof covers exactly the input the signature does, so changing the id breaks the signature.
    const identity = generateNodeIdentity();
    const impostor = generateNodeIdentity();
    const signed = header(identity).replace(`id=${identity.orcaNodeId}`, `id=${impostor.orcaNodeId}`);
    expectAuthError("bad_signature", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("does not let the signature stand in for the password: anyone can make a key pair", () => {
    const stranger = generateNodeIdentity();
    const signed = header(stranger, { key: Buffer.alloc(32, 1) });
    expectAuthError("bad_proof", () =>
      verify({ method: METHOD, url: PATH, header: signed, nonceCache: new NonceCache() }),
    );
  });

  it("binds the proof to the body as well", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { body: "original" });
    // A proof over another body fails exactly like the signature does, before the proof is consulted.
    expectAuthError("bad_signature", () =>
      verify({ method: METHOD, url: PATH, body: "tampered", header: signed, nonceCache: new NonceCache() }),
    );
  });
});

describe("parseAuthHeader", () => {
  it("parses the identity, workgroup, target, timestamp, nonce and both proofs", () => {
    const identity = generateNodeIdentity();
    const signed = header(identity, { target: "target-orca-node", ts: 1_700_000_000_000, nonce: "abc" });
    const parsed = parseAuthHeader(signed);
    expect(parsed).not.toBeNull();
    expect(parsed?.orcaNodeId).toBe(identity.orcaNodeId);
    expect(parsed?.workgroupId).toBe(WORKGROUP_ID);
    expect(parsed?.target).toBe("target-orca-node");
    expect(parsed?.ts).toBe(1_700_000_000_000);
    expect(parsed?.nonce).toBe("abc");
    expect(parsed?.signature.length).toBeGreaterThan(0);
    expect(parsed?.proof.length).toBeGreaterThan(0);
  });

  it("returns null for garbage", () => {
    expect(parseAuthHeader(undefined)).toBeNull();
    expect(parseAuthHeader("")).toBeNull();
    expect(parseAuthHeader("Bearer token")).toBeNull();
    expect(parseAuthHeader("Pod id=x; ts=1; nonce=n")).toBeNull();
    // Both proofs are required: a header without the workgroup proof is not a request of this protocol.
    expect(parseAuthHeader("Pod id=x; wg=orca-dev; ts=1; nonce=n; sig=s")).toBeNull();
  });
});

describe("reply signature", () => {
  const identity = generateNodeIdentity();
  const fields = { nonce: "request-nonce", status: 200, subject: bodySha256('{"ok":true}') };

  it("names the node that signed, over the nonce, the status and the body", () => {
    expect(verifyReplyHeader(buildReplyHeader(identity, fields), fields)).toBe(identity.orcaNodeId);
  });

  it("does not hold for another request's nonce: a reply cannot be moved", () => {
    const signed = buildReplyHeader(identity, fields);
    expect(verifyReplyHeader(signed, { ...fields, nonce: "another-nonce" })).toBeNull();
  });

  it("does not hold for another status or another body", () => {
    const signed = buildReplyHeader(identity, fields);
    expect(verifyReplyHeader(signed, { ...fields, status: 500 })).toBeNull();
    expect(verifyReplyHeader(signed, { ...fields, subject: bodySha256('{"ok":false}') })).toBeNull();
  });

  it("is refused when absent, malformed, or signed in another id's name", () => {
    expect(verifyReplyHeader(undefined, fields)).toBeNull();
    expect(verifyReplyHeader("garbage", fields)).toBeNull();
    const other = generateNodeIdentity();
    const forged = buildReplyHeader(identity, fields).replace(identity.orcaNodeId, other.orcaNodeId);
    expect(verifyReplyHeader(forged, fields)).toBeNull();
  });

  it("covers a streamed file by its name instead of its body", () => {
    const stream = { nonce: "n", status: 200, subject: `blob:${"a".repeat(64)}` };
    expect(verifyReplyHeader(buildReplyHeader(identity, stream), stream)).toBe(identity.orcaNodeId);
    expect(
      verifyReplyHeader(buildReplyHeader(identity, stream), { ...stream, subject: `blob:${"b".repeat(64)}` }),
    ).toBeNull();
  });
});
