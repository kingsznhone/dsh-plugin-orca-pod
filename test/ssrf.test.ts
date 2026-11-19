import { describe, expect, it, vi } from "vitest";

import { EndpointScreen } from "../src/mesh/screening.ts";
import { bindUrl, detectLocalEndpoints } from "../src/node/orca.ts";
import { isBlockedFetchPort, pickFreePort } from "../src/api/gateway.ts";
import { isLoopbackEndpoint } from "../src/plugin/pod.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { listed, TestNet } from "./support/net.ts";

describe("candidate endpoint filtering (§7.7)", () => {
  it("allows private ranges", async () => {
    expect(await new EndpointScreen({}).candidate("http://10.1.2.3:11811")).toBe(true);
    expect(await new EndpointScreen({}).candidate("http://172.20.0.9:11811")).toBe(true);
    expect(await new EndpointScreen({}).candidate("http://192.168.86.252:11812")).toBe(true);
    expect(await new EndpointScreen({}).candidate("http://100.64.1.10:11811")).toBe(true);
    expect(await new EndpointScreen({}).candidate("http://[fd00::1]:11811")).toBe(true);
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
      expect(await new EndpointScreen({}).candidate(endpoint)).toBe(false);
      expect(await new EndpointScreen({ allowPublicPeers: true }).candidate(endpoint)).toBe(false);
    }
  });

  it("allows loopback by default, and rejects it when disabled", async () => {
    expect(await new EndpointScreen({}).candidate("http://127.0.0.1:11811")).toBe(true);
    expect(await new EndpointScreen({}).candidate("http://[::1]:11811")).toBe(true);
    expect(await new EndpointScreen({ allowLoopbackPeers: false }).candidate("http://127.0.0.1:11811")).toBe(false);
    expect(await new EndpointScreen({ allowLoopbackPeers: false }).candidate("http://[::1]:11811")).toBe(false);
  });

  it("rejects public addresses unless allowPublicPeers is set", async () => {
    expect(await new EndpointScreen({}).candidate("http://8.8.8.8:11811")).toBe(false);
    expect(await new EndpointScreen({ allowPublicPeers: true }).candidate("http://8.8.8.8:11811")).toBe(true);
  });

  it("resolves hostnames and applies the same address policy", async () => {
    expect(await new EndpointScreen({}).candidate("http://localhost:11811")).toBe(true);
    expect(await new EndpointScreen({ allowLoopbackPeers: false }).candidate("http://localhost:11811")).toBe(false);
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
    expect(await new EndpointScreen({}).candidate("ftp://10.0.0.1/")).toBe(false);
    expect(await new EndpointScreen({}).candidate("not a url")).toBe(false);
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
  it("screens a candidate's addresses before they are dialed, but not what a node declared for itself", async () => {
    const net = new TestNet();
    const a = net.node();
    // A member whose list names a node at the cloud metadata address and at a private one.
    const lister = net.node();
    const honest = lister.mesh.greeted.bind(lister.mesh);
    vi.spyOn(lister.mesh, "greeted").mockImplementation(async (caller, request, overLoopback) => ({
      ...(await honest(caller, request, overLoopback)),
      members: [
        listed(fakeNodeId("listed-only"), "http://169.254.169.254:80", {
          endpoints: ["http://169.254.169.254:80", "http://10.0.0.99:1"],
        }),
      ],
    }));
    // A node that greets for itself from a public address.
    const remote = net.node({ endpoints: ["http://8.8.8.8:1"] });
    await a.mesh.probe(lister.url);
    await remote.mesh.probe(a.url);
    a.mesh.start();
    await net.advance(100);

    const dialed = net.dials.filter((dial) => dial.from === a.id).map((dial) => dial.url);
    // The metadata address is never dialed; the private one is.
    expect(dialed.some((url) => url.startsWith("http://169.254.169.254"))).toBe(false);
    expect(dialed.some((url) => url.startsWith("http://10.0.0.99:1"))).toBe(true);
    // The public address a member declared for itself is dialed.
    expect(dialed.some((url) => url.startsWith("http://8.8.8.8:1"))).toBe(true);
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
