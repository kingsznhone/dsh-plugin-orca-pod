import { describe, expect, it } from "vitest";
import { generateNodeIdentity, shortenNodeId } from "../src/core/identity.ts";
import {
  isHttpEndpoint,
  isOrcaNodeId,
  isWorkgroupId,
  membersDigest,
  normalizeEndpoints,
  runtimeDigest,
  type PeerView,
  type RuntimeInfo,
  type OrcaNodeId,
} from "../src/core/wire/peer.ts";
import { labelId } from "./fixtures/ids.ts";

// 43 base64url characters decode to a 32-byte Ed25519 public key.
const VALID_NODE_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeRuntime(): RuntimeInfo {
  return {
    os: { family: "Windows", name: "Windows 11", version: "10.0.26100" },
    arch: "x64",
    cpu: { model: "AMD Ryzen 9 7950X", logical_cores: 16 },
    memory: { total_bytes: 68_719_476_736 },
    node: { version: "26.13.0" },
    captured_at: "2026-11-14T00:00:00.000Z",
  };
}

type DigestPeer = Pick<PeerView, "orca_node_id" | "endpoints" | "runtime_digest">;

function makePeer(orcaNodeId: OrcaNodeId, endpoints: string[], runtime: RuntimeInfo): DigestPeer {
  return { orca_node_id: orcaNodeId, endpoints, runtime_digest: runtimeDigest(runtime) };
}

describe("generateNodeIdentity", () => {
  it("draws the orca node id from the Ed25519 public key", () => {
    const identity = generateNodeIdentity();
    expect(identity.orcaNodeId).toHaveLength(43);
    expect(identity.orcaNodeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isOrcaNodeId(identity.orcaNodeId)).toBe(true);
  });

  it("produces 50 identities that are all distinct and valid", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const identity = generateNodeIdentity();
      expect(isOrcaNodeId(identity.orcaNodeId)).toBe(true);
      expect(seen.has(identity.orcaNodeId)).toBe(false);
      seen.add(identity.orcaNodeId);
    }
  });

  it("shortens ids for display without changing the prefix", () => {
    const identity = generateNodeIdentity();
    const short = shortenNodeId(identity.orcaNodeId);
    expect(short).toBe(`${identity.orcaNodeId.slice(0, 6)}\u2026${identity.orcaNodeId.slice(-4)}`);
  });
});

describe("isOrcaNodeId", () => {
  it("accepts a 43-character base64url public key", () => {
    expect(isOrcaNodeId(VALID_NODE_ID)).toBe(true);
    expect(isOrcaNodeId(generateNodeIdentity().orcaNodeId)).toBe(true);
  });

  it("rejects ids with the wrong length", () => {
    expect(isOrcaNodeId("ABC12")).toBe(false);
    expect(isOrcaNodeId("A".repeat(42))).toBe(false);
    expect(isOrcaNodeId("A".repeat(44))).toBe(false);
    expect(isOrcaNodeId("")).toBe(false);
  });

  it("rejects characters outside base64url", () => {
    expect(isOrcaNodeId("!".repeat(43))).toBe(false);
    expect(isOrcaNodeId(`${"A".repeat(42)}=`)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isOrcaNodeId(42)).toBe(false);
    expect(isOrcaNodeId(null)).toBe(false);
    expect(isOrcaNodeId(undefined)).toBe(false);
  });
});

describe("isWorkgroupId", () => {
  it("accepts valid workgroup ids", () => {
    expect(isWorkgroupId("orca-dev")).toBe(true);
    expect(isWorkgroupId("a1")).toBe(true);
    expect(isWorkgroupId("a".repeat(32))).toBe(true);
  });

  it("rejects uppercase workgroup ids", () => {
    expect(isWorkgroupId("Orca")).toBe(false);
  });

  it("rejects ids that start with a hyphen", () => {
    expect(isWorkgroupId("-dev")).toBe(false);
  });

  it("rejects ids that are too short", () => {
    expect(isWorkgroupId("a")).toBe(false);
  });

  it("rejects ids longer than 32 characters", () => {
    expect(isWorkgroupId("a".repeat(33))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isWorkgroupId(42)).toBe(false);
    expect(isWorkgroupId(null)).toBe(false);
    expect(isWorkgroupId(undefined)).toBe(false);
    expect(isWorkgroupId({})).toBe(false);
  });
});

describe("runtimeDigest", () => {
  it("is stable for the same runtime", () => {
    const runtime = makeRuntime();
    const digest = runtimeDigest(runtime);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(runtimeDigest({ ...runtime })).toBe(digest);
  });

  it("changes when the logical core count changes", () => {
    const runtime = makeRuntime();
    const changed: RuntimeInfo = { ...runtime, cpu: { ...runtime.cpu, logical_cores: 8 } };
    expect(runtimeDigest(changed)).not.toBe(runtimeDigest(runtime));
  });

  it("changes when the os version changes", () => {
    const runtime = makeRuntime();
    const changed: RuntimeInfo = { ...runtime, os: { ...runtime.os, version: "10.0.26101" } };
    expect(runtimeDigest(changed)).not.toBe(runtimeDigest(runtime));
  });

  it("returns none for a null runtime", () => {
    expect(runtimeDigest(null)).toBe("none");
  });
});

describe("membersDigest", () => {
  const runtime = makeRuntime();
  const alpha = makePeer(labelId("ABC123"), ["http://127.0.0.1:11811"], runtime);
  const beta = makePeer(labelId("XYZ789"), ["http://127.0.0.1:11812"], runtime);

  it("is independent of input order", () => {
    expect(membersDigest([alpha, beta])).toBe(membersDigest([beta, alpha]));
  });

  it("changes when an orca node id changes", () => {
    expect(membersDigest([{ ...alpha, orca_node_id: labelId("ABC124") }, beta])).not.toBe(membersDigest([alpha, beta]));
  });

  it("changes when an endpoint changes", () => {
    expect(membersDigest([{ ...alpha, endpoints: ["http://127.0.0.1:11813"] }, beta])).not.toBe(
      membersDigest([alpha, beta]),
    );
  });

  it("changes when a runtime digest changes", () => {
    const otherRuntime = runtimeDigest({ ...runtime, arch: "arm64" });
    expect(membersDigest([{ ...alpha, runtime_digest: otherRuntime }, beta])).not.toBe(membersDigest([alpha, beta]));
  });

  it("is a stable 64-hex digest for an empty member list", () => {
    const digest = membersDigest([]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(membersDigest([])).toBe(digest);
  });
});

describe("isHttpEndpoint", () => {
  it("accepts http and https urls", () => {
    expect(isHttpEndpoint("http://127.0.0.1:11811")).toBe(true);
    expect(isHttpEndpoint("https://pod.example.com/a2a")).toBe(true);
  });

  it("rejects non-http protocols", () => {
    expect(isHttpEndpoint("ftp://x")).toBe(false);
    expect(isHttpEndpoint("ws://127.0.0.1:11811")).toBe(false);
  });

  it("rejects strings that are not urls", () => {
    expect(isHttpEndpoint("not a url")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isHttpEndpoint(42)).toBe(false);
    expect(isHttpEndpoint(null)).toBe(false);
    expect(isHttpEndpoint(undefined)).toBe(false);
  });
});

describe("normalizeEndpoints", () => {
  it("accepts an ordered list and rejects a bare string", () => {
    expect(normalizeEndpoints(["http://a:1", "http://b:2"])).toEqual(["http://a:1", "http://b:2"]);
    expect(normalizeEndpoints("http://a:1")).toBeNull();
  });

  it("strips one trailing slash and deduplicates", () => {
    expect(normalizeEndpoints(["http://a:1/", "http://a:1", "http://b:2/"])).toEqual(["http://a:1", "http://b:2"]);
  });

  it("rejects empty, malformed and oversized lists", () => {
    expect(normalizeEndpoints([])).toBeNull();
    expect(normalizeEndpoints(undefined)).toBeNull();
    expect(normalizeEndpoints(["ftp://a:1"])).toBeNull();
    expect(normalizeEndpoints(["http://a:1", "nope"])).toBeNull();
    expect(normalizeEndpoints(Array.from({ length: 9 }, (_, i) => `http://a:${i + 1}`))).toBeNull();
  });
});

describe("id guards", () => {
  it("accepts exactly 43 base64url characters as an orca node id", () => {
    expect(isOrcaNodeId(VALID_NODE_ID)).toBe(true);
    expect(isOrcaNodeId(generateNodeIdentity().orcaNodeId)).toBe(true);
    expect(isOrcaNodeId(VALID_NODE_ID.slice(1))).toBe(false);
    expect(isOrcaNodeId(`${VALID_NODE_ID}A`)).toBe(false);
    expect(isOrcaNodeId(`${VALID_NODE_ID.slice(1)}+`)).toBe(false);
    expect(isOrcaNodeId(42)).toBe(false);
  });

  it("checks workgroup ids against the documented pattern", () => {
    expect(isWorkgroupId("wg-a")).toBe(true);
    expect(isWorkgroupId("a")).toBe(false);
    expect(isWorkgroupId("-wg")).toBe(false);
    expect(isWorkgroupId("WG")).toBe(false);
    expect(isWorkgroupId("a".repeat(33))).toBe(false);
  });
});
