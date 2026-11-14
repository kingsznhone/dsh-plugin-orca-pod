import { describe, expect, it } from "vitest";
import {
  NODE_ID_ALPHABET,
  generateOrcaNodeId,
  isHttpEndpoint,
  isOrcaNodeId,
  isWorkgroupId,
  MAX_ENDPOINTS,
  membersDigest,
  normalizeEndpoints,
  normalizeOrcaNodeId,
  runtimeDigest,
  type PeerView,
  type RuntimeInfo,
} from "../src/protocol.ts";

const VALID_NODE_ID = "ABC123";

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

function makePeer(orcaNodeId: string, endpoints: string[], runtime: RuntimeInfo): DigestPeer {
  return { orca_node_id: orcaNodeId, endpoints, runtime_digest: runtimeDigest(runtime) };
}

describe("generateOrcaNodeId", () => {
  it("produces 6 characters drawn from the node id alphabet", () => {
    const id = generateOrcaNodeId();
    expect(id).toHaveLength(6);
    for (const char of id) expect(NODE_ID_ALPHABET).toContain(char);
  });

  it("produces 200 ids that are all valid", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(isOrcaNodeId(generateOrcaNodeId())).toBe(true);
    }
  });

  it("does not repeat on consecutive calls", () => {
    expect(generateOrcaNodeId()).not.toBe(generateOrcaNodeId());
  });
});

describe("isOrcaNodeId", () => {
  it("accepts a valid id", () => {
    expect(isOrcaNodeId(VALID_NODE_ID)).toBe(true);
    expect(isOrcaNodeId(generateOrcaNodeId())).toBe(true);
  });

  it("rejects ids with the wrong length", () => {
    expect(isOrcaNodeId("ABC12")).toBe(false);
    expect(isOrcaNodeId("ABC1234")).toBe(false);
    expect(isOrcaNodeId("")).toBe(false);
  });

  it("rejects lowercase ids", () => {
    expect(isOrcaNodeId("abc123")).toBe(false);
  });

  it("rejects the ambiguous characters I, L, O and U", () => {
    for (const char of ["I", "L", "O", "U"]) {
      expect(isOrcaNodeId(`ABC${char}23`)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(isOrcaNodeId(42)).toBe(false);
    expect(isOrcaNodeId(null)).toBe(false);
    expect(isOrcaNodeId(undefined)).toBe(false);
  });
});

describe("normalizeOrcaNodeId", () => {
  it("uppercases a lowercase id", () => {
    expect(normalizeOrcaNodeId("abc123")).toBe(VALID_NODE_ID);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOrcaNodeId("  abc123  ")).toBe(VALID_NODE_ID);
  });

  it("returns null for garbage", () => {
    expect(normalizeOrcaNodeId("not-an-orca-node-id")).toBeNull();
    expect(normalizeOrcaNodeId("")).toBeNull();
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
  const alpha = makePeer("ABC123", ["http://127.0.0.1:11811"], runtime);
  const beta = makePeer("XYZ789", ["http://127.0.0.1:11812"], runtime);

  it("is independent of input order", () => {
    expect(membersDigest([alpha, beta])).toBe(membersDigest([beta, alpha]));
  });

  it("changes when an orca node id changes", () => {
    expect(membersDigest([{ ...alpha, orca_node_id: "ABC124" }, beta])).not.toBe(
      membersDigest([alpha, beta]),
    );
  });

  it("changes when an endpoint changes", () => {
    expect(
      membersDigest([{ ...alpha, endpoints: ["http://127.0.0.1:11813"] }, beta]),
    ).not.toBe(membersDigest([alpha, beta]));
  });

  it("changes when a runtime digest changes", () => {
    const otherRuntime = runtimeDigest({ ...runtime, arch: "arm64" });
    expect(membersDigest([{ ...alpha, runtime_digest: otherRuntime }, beta])).not.toBe(
      membersDigest([alpha, beta]),
    );
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
  it("accepts a list and a single string, preserving order", () => {
    expect(normalizeEndpoints(["http://a:1", "http://b:2"])).toEqual(["http://a:1", "http://b:2"]);
    expect(normalizeEndpoints("http://a:1")).toEqual(["http://a:1"]);
  });

  it("strips one trailing slash and deduplicates", () => {
    expect(normalizeEndpoints(["http://a:1/", "http://a:1", "http://b:2/"])).toEqual([
      "http://a:1",
      "http://b:2",
    ]);
  });

  it("rejects empty, malformed and oversized lists", () => {
    expect(normalizeEndpoints([])).toBeNull();
    expect(normalizeEndpoints(undefined)).toBeNull();
    expect(normalizeEndpoints(["ftp://a:1"])).toBeNull();
    expect(normalizeEndpoints(["http://a:1", "nope"])).toBeNull();
    expect(normalizeEndpoints(Array.from({ length: MAX_ENDPOINTS + 1 }, (_, i) => `http://a:${i + 1}`))).toBeNull();
  });
});
