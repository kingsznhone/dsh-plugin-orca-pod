import { describe, expect, it } from "vitest";
import { shortenNodeId } from "../src/core/identity.ts";
import { EndpointsSchema, membersDigest, runtimeDigest, type PeerView, type RuntimeInfo } from "../src/mesh/wire.ts";
import { OrcaNodeIdSchema, WorkgroupIdSchema, nodeIdOf, publicKeyOf, type OrcaNodeId } from "../src/core/ids.ts";
import { labelId } from "./fixtures/ids.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";

const acceptsNodeId = (value: unknown) => OrcaNodeIdSchema.safeParse(value).success;
const acceptsWorkgroupId = (value: unknown) => WorkgroupIdSchema.safeParse(value).success;

// Base58 of a 32-byte Ed25519 public key: each leading zero byte is a "1", so the all-zero key is 32 of them.
const VALID_NODE_ID = "1".repeat(32);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

function makePeer(orcaNodeId: OrcaNodeId, endpoints: string[], runtime: RuntimeInfo): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: orcaNodeId,
    endpoints,
    runtime,
    runtime_digest: runtimeDigest(runtime),
    state: "online",
    busy: null,
    last_recv_at: null,
  };
}

describe("generateNodeIdentity", () => {
  it("draws the orca node id from the Ed25519 public key", () => {
    const identity = generateNodeIdentity();
    expect(identity.orcaNodeId).toMatch(BASE58);
    expect(publicKeyOf(identity.orcaNodeId)).toHaveLength(32);
    expect(acceptsNodeId(identity.orcaNodeId)).toBe(true);
  });

  it("produces 50 identities that are all distinct and valid", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const identity = generateNodeIdentity();
      expect(acceptsNodeId(identity.orcaNodeId)).toBe(true);
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

describe("OrcaNodeIdSchema", () => {
  it("accepts a 32-byte public key in base58", () => {
    expect(acceptsNodeId(VALID_NODE_ID)).toBe(true);
    expect(acceptsNodeId(generateNodeIdentity().orcaNodeId)).toBe(true);
    const key = new Uint8Array(32).fill(0xff);
    expect(publicKeyOf(nodeIdOf(key))).toEqual(key);
  });

  it("rejects ids that do not decode to 32 bytes", () => {
    expect(acceptsNodeId("ABC12")).toBe(false);
    expect(acceptsNodeId("1".repeat(31))).toBe(false);
    expect(acceptsNodeId("1".repeat(33))).toBe(false);
    expect(acceptsNodeId(`${generateNodeIdentity().orcaNodeId}z`)).toBe(false);
    expect(acceptsNodeId("")).toBe(false);
  });

  it("rejects characters outside the base58 alphabet, base64url ones included", () => {
    const id = generateNodeIdentity().orcaNodeId;
    for (const char of ["0", "O", "I", "l", "_", "-", "+", "/"]) {
      expect(acceptsNodeId(`${char}${id.slice(1)}`)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    expect(acceptsNodeId(42)).toBe(false);
    expect(acceptsNodeId(null)).toBe(false);
    expect(acceptsNodeId(undefined)).toBe(false);
  });
});

describe("WorkgroupIdSchema", () => {
  it("accepts valid workgroup ids", () => {
    expect(acceptsWorkgroupId("orca-dev")).toBe(true);
    expect(acceptsWorkgroupId("a1")).toBe(true);
    expect(acceptsWorkgroupId("a".repeat(32))).toBe(true);
  });

  it("rejects uppercase workgroup ids", () => {
    expect(acceptsWorkgroupId("Orca")).toBe(false);
  });

  it("rejects ids that start with a hyphen", () => {
    expect(acceptsWorkgroupId("-dev")).toBe(false);
  });

  it("rejects ids that are too short", () => {
    expect(acceptsWorkgroupId("a")).toBe(false);
  });

  it("rejects ids longer than 32 characters", () => {
    expect(acceptsWorkgroupId("a".repeat(33))).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(acceptsWorkgroupId(42)).toBe(false);
    expect(acceptsWorkgroupId(null)).toBe(false);
    expect(acceptsWorkgroupId(undefined)).toBe(false);
    expect(acceptsWorkgroupId({})).toBe(false);
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

describe("EndpointsSchema", () => {
  const endpoints = (value: unknown) => {
    const parsed = EndpointsSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  };

  it("accepts an ordered list of http(s) URLs, reading http as https (nodes serve https only), and rejects a bare string", () => {
    expect(endpoints(["http://a:1", "https://pod.example.com/a2a"])).toEqual([
      "https://a:1",
      "https://pod.example.com/a2a",
    ]);
    expect(endpoints("http://a:1")).toBeNull();
  });

  it("strips one trailing slash and deduplicates", () => {
    expect(endpoints(["https://a:1/", "http://a:1", "https://b:2/"])).toEqual(["https://a:1", "https://b:2"]);
  });

  it("rejects other protocols, text that is not a URL, and more than eight", () => {
    expect(endpoints(["ftp://a:1"])).toBeNull();
    expect(endpoints(["ws://127.0.0.1:11811"])).toBeNull();
    expect(endpoints(["http://a:1", "nope"])).toBeNull();
    expect(endpoints([42])).toBeNull();
    expect(endpoints(undefined)).toBeNull();
    expect(endpoints(Array.from({ length: 9 }, (_, i) => `http://a:${i + 1}`))).toBeNull();
  });
});
