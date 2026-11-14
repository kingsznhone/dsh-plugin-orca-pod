import { describe, expect, it } from "vitest";

import { createMembership } from "../src/membership.ts";
import { candidateEndpointAllowed } from "../src/net.ts";
import type { PeerView } from "../src/protocol.ts";

function peer(orcaNodeId: string, endpoint: string): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: orcaNodeId,
    endpoint,
    runtime: null,
    runtime_digest: "",
    state: "unknown",
    busy: null,
    last_recv_at: null,
  };
}

describe("candidate endpoint filtering (§7.7)", () => {
  it("allows private ranges", async () => {
    expect(await candidateEndpointAllowed("http://10.1.2.3:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://172.20.0.9:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://192.168.86.252:11812")).toBe(true);
    expect(await candidateEndpointAllowed("http://100.64.1.10:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://[fd00::1]:11811")).toBe(true);
  });

  it("always rejects metadata, link-local, multicast and unspecified addresses", async () => {
    const blocked = [
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]:11811",
      "http://224.0.0.1:11811",
      "http://0.0.0.0:11811",
      "http://[::]:11811",
    ];
    for (const endpoint of blocked) {
      expect(await candidateEndpointAllowed(endpoint)).toBe(false);
      expect(await candidateEndpointAllowed(endpoint, { allowPublicPeers: true })).toBe(false);
    }
  });

  it("allows loopback by default, and rejects it when disabled", async () => {
    expect(await candidateEndpointAllowed("http://127.0.0.1:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://[::1]:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://127.0.0.1:11811", { allowLoopbackPeers: false })).toBe(false);
    expect(await candidateEndpointAllowed("http://[::1]:11811", { allowLoopbackPeers: false })).toBe(false);
  });

  it("rejects public addresses unless allowPublicPeers is set", async () => {
    expect(await candidateEndpointAllowed("http://8.8.8.8:11811")).toBe(false);
    expect(await candidateEndpointAllowed("http://8.8.8.8:11811", { allowPublicPeers: true })).toBe(true);
  });

  it("resolves hostnames and applies the same address policy", async () => {
    expect(await candidateEndpointAllowed("http://localhost:11811")).toBe(true);
    expect(await candidateEndpointAllowed("http://localhost:11811", { allowLoopbackPeers: false })).toBe(false);
  });

  it("rejects non-http schemes and malformed endpoints", async () => {
    expect(await candidateEndpointAllowed("ftp://10.0.0.1/")).toBe(false);
    expect(await candidateEndpointAllowed("not a url")).toBe(false);
  });
});

describe("peer origin (§7.7)", () => {
  it("marks joined peers explicit and roster-only peers candidate", () => {
    const membership = createMembership({ selfOrcaNodeId: "AAAAAA" });
    membership.peers.upsert(peer("BBBBBB", "http://127.0.0.1:1"));
    expect(membership.originOf("BBBBBB")).toBe("explicit");
    membership.mergeRemote([peer("CCCCCC", "http://127.0.0.1:2")]);
    expect(membership.originOf("CCCCCC")).toBe("candidate");
    membership.peers.upsert(peer("CCCCCC", "http://127.0.0.1:2"));
    expect(membership.originOf("CCCCCC")).toBe("explicit");
  });
});
