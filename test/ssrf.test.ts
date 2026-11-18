import { describe, expect, it } from "vitest";

import { createMembership } from "../src/mesh/membership.ts";
import { candidateEndpointAllowed } from "../src/mesh/screening.ts";
import {
  bindUrl,
  detectLocalEndpoints,
  isBlockedFetchPort,
  isLoopbackEndpoint,
  pickFreePort,
} from "../src/core/net.ts";
import type { PeerView, OrcaNodeId } from "../src/core/wire/peer.ts";
import { labelId } from "./fixtures/ids.ts";

function peer(orcaNodeId: OrcaNodeId, endpoint: string): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: orcaNodeId,
    endpoints: [endpoint],
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

  it("never picks a port that fetch refuses to dial", async () => {
    expect(isBlockedFetchPort(6000)).toBe(true);
    expect(isBlockedFetchPort(6667)).toBe(true);
    // Later additions to the WHATWG list. Windows may hand out ports as low as
    // 1024 when the dynamic range was moved, so these are reachable by port 0.
    expect(isBlockedFetchPort(4190)).toBe(true);
    expect(isBlockedFetchPort(6679)).toBe(true);
    expect(isBlockedFetchPort(11811)).toBe(false);
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(isBlockedFetchPort(port)).toBe(false);
  });

  it("rejects non-http schemes and malformed endpoints", async () => {
    expect(await candidateEndpointAllowed("ftp://10.0.0.1/")).toBe(false);
    expect(await candidateEndpointAllowed("not a url")).toBe(false);
  });

  it("detects advertised endpoints with IPv4 first and no loopback", () => {
    const urls = detectLocalEndpoints(11811);
    for (const url of urls) {
      expect(url).toMatch(/^http:\/\//);
      expect(isLoopbackEndpoint(url)).toBe(false);
    }
    // Loopback-only advertise lists are useless across machines and are dropped.
    expect(isLoopbackEndpoint("http://127.0.0.1:11811")).toBe(true);
    expect(isLoopbackEndpoint("http://[::1]:11811")).toBe(true);
    expect(isLoopbackEndpoint("http://192.168.1.20:11811")).toBe(false);
    // IPv4 comes before IPv6 so the primary URL is the reliable LAN path.
    const firstV6 = urls.findIndex((url) => url.includes("["));
    if (firstV6 >= 0) expect(urls.slice(firstV6).every((url) => url.includes("["))).toBe(true);
  });
});

describe("peer origin (§7.7)", () => {
  it("marks joined peers explicit and roster-only peers candidate", () => {
    const membership = createMembership({ selfOrcaNodeId: labelId("AAAAAA") });
    membership.peers.upsert(peer(labelId("BBBBBB"), "http://127.0.0.1:1"));
    expect(membership.originOf(labelId("BBBBBB"))).toBe("explicit");
    membership.mergeRemote([peer(labelId("CCCCCC"), "http://127.0.0.1:2")]);
    expect(membership.originOf(labelId("CCCCCC"))).toBe("candidate");
    membership.peers.upsert(peer(labelId("CCCCCC"), "http://127.0.0.1:2"));
    expect(membership.originOf(labelId("CCCCCC"))).toBe("explicit");
  });
});

describe("bind address URLs (B21)", () => {
  it("brackets IPv6 literals and keeps host names, by DSH's bind rule", () => {
    expect(bindUrl("192.168.1.2", 11811)).toBe("http://192.168.1.2:11811");
    expect(bindUrl("fd00::5", 11811)).toBe("http://[fd00::5]:11811");
    expect(bindUrl("::ffff:127.0.0.1", 11811)).toBe("http://127.0.0.1:11811");
    expect(bindUrl("localhost", 11811)).toBe("http://localhost:11811");
    // A zone id has no URL form.
    expect(bindUrl("fe80::1%eth0", 11811)).toBeUndefined();
    for (const url of detectLocalEndpoints(11811)) expect(URL.canParse(url)).toBe(true);
  });
});
