import { describe, expect, it, vi } from "vitest";

import { EndpointScreen } from "../src/mesh/screening.ts";
import { bindUrl, detectLocalEndpoints } from "../src/node/orca.ts";
import { isBlockedFetchPort, pickFreePort } from "../src/api/gateway.ts";
import { isLoopbackEndpoint } from "../src/plugin/pod.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { listed, TestNet } from "./support/net.ts";

/** A candidate named in a member list from another machine. */
const fromElsewhere = (endpoint: string) => new EndpointScreen().candidate(endpoint, false);
/** A candidate named in a member list that arrived over loopback, from a node on this machine. */
const fromThisMachine = (endpoint: string) => new EndpointScreen().candidate(endpoint, true);

describe("candidate endpoint filtering (design.md 6.6)", () => {
  it("allows private ranges", async () => {
    expect(await fromElsewhere("https://10.1.2.3:11811")).toBe(true);
    expect(await fromElsewhere("https://172.20.0.9:11811")).toBe(true);
    expect(await fromElsewhere("https://192.168.86.252:11812")).toBe(true);
    expect(await fromElsewhere("https://100.64.1.10:11811")).toBe(true);
    expect(await fromElsewhere("https://[fd00::1]:11811")).toBe(true);
  });

  it("always rejects metadata, link-local, multicast and unspecified addresses", async () => {
    const blocked = [
      "https://169.254.169.254/latest/meta-data",
      "https://[::ffff:169.254.169.254]:80",
      "https://[::ffff:a9fe:a9fe]:80",
      "https://[0:0:0:0:0:ffff:a9fe:a9fe]:80",
      "https://[fe80::1]:11811",
      "https://224.0.0.1:11811",
      "https://[::ffff:224.0.0.1]:11811",
      "https://[::ffff:e000:1]:11811",
      "https://0.0.0.0:11811",
      "https://[::ffff:0.0.0.0]:11811",
      "https://[::ffff:0:0]:11811",
      "https://[::]:11811",
      "https://[0:0:0:0:0:0:0:0]:11811",
    ];
    for (const endpoint of blocked) {
      expect(await fromElsewhere(endpoint), endpoint).toBe(false);
      expect(await fromThisMachine(endpoint), endpoint).toBe(false);
    }
  });

  it("allows loopback only from a list that came from this machine", async () => {
    // One machine runs one node: another machine's loopback address names this machine.
    expect(await fromElsewhere("https://127.0.0.1:11811")).toBe(false);
    expect(await fromElsewhere("https://[::1]:11811")).toBe(false);
    expect(await fromElsewhere("https://[::ffff:127.0.0.1]:11811")).toBe(false);
    expect(await fromElsewhere("https://[::ffff:7f00:1]:11811")).toBe(false);
    // Nodes sharing this machine (tests, development) list each other at loopback.
    expect(await fromThisMachine("https://127.0.0.1:11811")).toBe(true);
    expect(await fromThisMachine("https://[::1]:11811")).toBe(true);
    expect(await fromThisMachine("https://[::ffff:127.0.0.1]:11811")).toBe(true);
    expect(await fromThisMachine("https://[::ffff:7f00:1]:11811")).toBe(true);
  });

  it("allows public and private IPv4-mapped IPv6 and non-prefix short hextets", async () => {
    expect(await fromElsewhere("https://[::ffff:10.1.2.3]:11811")).toBe(true);
    expect(await fromElsewhere("https://[::ffff:a01:203]:11811")).toBe(true);
    expect(await fromElsewhere("https://[::ffff:8.8.8.8]:11811")).toBe(true);
    // `fe8::1` is `0fe8::1` (public), not `fe80::/10`; `ff::1` is `00ff::1`, not multicast `ff00::/8`.
    expect(await fromElsewhere("https://[fe8::1]:11811")).toBe(true);
    expect(await fromElsewhere("https://[ff::1]:11811")).toBe(true);
  });

  it("allows public addresses: a mesh may span a cloud server or public IPv6", async () => {
    expect(await fromElsewhere("https://8.8.8.8:11811")).toBe(true);
    expect(await fromElsewhere("https://[2001:db8::1]:11811")).toBe(true);
  });

  it("resolves hostnames and applies the same address policy", async () => {
    expect(await fromElsewhere("https://localhost:11811")).toBe(false);
    expect(await fromThisMachine("https://localhost:11811")).toBe(true);
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
    expect(await fromElsewhere("ftp://10.0.0.1/")).toBe(false);
    expect(await fromElsewhere("not a url")).toBe(false);
  });

  it("detects advertised endpoints with IPv4 first and no loopback", () => {
    const urls = detectLocalEndpoints(11811);
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\//);
      expect(isLoopbackEndpoint(url)).toBe(false);
    }
    // Loopback-only advertise lists are useless across machines and are dropped.
    expect(isLoopbackEndpoint("https://127.0.0.1:11811")).toBe(true);
    expect(isLoopbackEndpoint("https://[::1]:11811")).toBe(true);
    expect(isLoopbackEndpoint("https://192.168.1.20:11811")).toBe(false);
    // IPv4 comes before IPv6 so the primary URL is the reliable LAN path.
    const firstV6 = urls.findIndex((url) => url.includes("["));
    if (firstV6 >= 0) expect(urls.slice(firstV6).every((url) => url.includes("["))).toBe(true);
  });
});

describe("peer origin (design.md 6.6)", () => {
  it("screens a candidate's addresses before they are dialed, but not what a node declared for itself", async () => {
    const net = new TestNet();
    const a = net.node();
    // A member whose list names a node at the cloud metadata address and at a private one.
    const lister = net.node();
    const honest = lister.mesh.greeted.bind(lister.mesh);
    vi.spyOn(lister.mesh, "greeted").mockImplementation(async (caller, request, overLoopback) => ({
      ...(await honest(caller, request, overLoopback)),
      members: [
        listed(fakeNodeId("listed-only"), "https://169.254.169.254:80", {
          endpoints: ["https://169.254.169.254:80", "https://10.0.0.99:1"],
        }),
      ],
    }));
    // A node that greets for itself from a public address.
    const remote = net.node({ endpoints: ["https://8.8.8.8:1"] });
    await a.mesh.probe(lister.url);
    await remote.mesh.probe(a.url);
    a.mesh.start();
    await net.advance(100);

    const dialed = net.dials.filter((dial) => dial.from === a.id).map((dial) => dial.url);
    // The metadata address is never dialed; the private one is.
    expect(dialed.some((url) => url.startsWith("https://169.254.169.254"))).toBe(false);
    expect(dialed.some((url) => url.startsWith("https://10.0.0.99:1"))).toBe(true);
    // The public address a member declared for itself is dialed.
    expect(dialed.some((url) => url.startsWith("https://8.8.8.8:1"))).toBe(true);
  });

  it("dials a listed loopback address only when the list came from this machine", async () => {
    const net = new TestNet();
    const a = net.node();
    /** A member whose list names one more node, at `listedAt`. */
    const listing = (options: { endpoints?: string[] }, name: string, listedAt: string) => {
      const lister = net.node(options);
      const honest = lister.mesh.greeted.bind(lister.mesh);
      vi.spyOn(lister.mesh, "greeted").mockImplementation(async (caller, request, overLoopback) => ({
        ...(await honest(caller, request, overLoopback)),
        members: [listed(fakeNodeId(name), listedAt)],
      }));
      return lister;
    };
    // Another machine (10.0.0.x) lists a node at loopback: that address would be this machine.
    const remote = listing({}, "remote-listed", "https://127.0.0.1:7001");
    // A node on this machine (reached at loopback) lists another node on this machine.
    const local = listing({ endpoints: ["https://127.0.0.1:7000"] }, "local-listed", "https://127.0.0.1:7002");
    await a.mesh.probe(remote.url);
    await a.mesh.probe(local.url);
    a.mesh.start();
    await net.advance(100);

    const dialed = net.dials.filter((dial) => dial.from === a.id).map((dial) => dial.url);
    expect(dialed.some((url) => url.startsWith("https://127.0.0.1:7001"))).toBe(false);
    expect(dialed.some((url) => url.startsWith("https://127.0.0.1:7002"))).toBe(true);
  });

  it("screens endpoints declared in a probe response and refuses when none are allowed", async () => {
    const net = new TestNet();
    const a = net.node();
    const replyWith = (
      endpoints: string[],
      options?: { peerEndpoints?: string[]; members?: ReturnType<typeof listed>[] },
    ) => {
      const peer = net.node(options?.peerEndpoints ? { endpoints: options.peerEndpoints } : {});
      const honest = peer.mesh.greeted.bind(peer.mesh);
      vi.spyOn(peer.mesh, "greeted").mockImplementation(async (caller, request, overLoopback) => {
        const response = await honest(caller, request, overLoopback);
        return {
          ...response,
          self: { ...response.self, endpoints },
          members: options?.members ?? response.members,
        };
      });
      return peer;
    };

    // Forbidden link-local, IPv4-mapped metadata, and remote loopback are all refused.
    for (const bad of [
      ["https://169.254.169.254:80"],
      ["https://[::ffff:169.254.169.254]:80"],
      ["https://127.0.0.1:22"],
    ]) {
      const bystander = fakeNodeId(`bystander-${bad[0]}`);
      const peer = replyWith(bad, { members: [listed(bystander, "https://10.0.0.88:11811")] });
      await expect(a.mesh.probe(peer.url)).rejects.toMatchObject({ code: "endpoint_refused" });
      expect(a.mesh.get(peer.id)).toBeUndefined();
      expect(a.mesh.get(bystander)).toBeUndefined();
    }

    // Mixed declarations keep only the allowed endpoints, so heartbeats never dial the forbidden ones.
    const mixed = replyWith(["https://169.254.169.254:80", "https://[::ffff:a9fe:a9fe]:80", "https://10.0.0.77:11811"]);
    const admitted = await a.mesh.probe(mixed.url);
    expect(admitted.endpoints).toEqual(["https://10.0.0.77:11811"]);

    // Probing a same-machine node over loopback still accepts its loopback endpoint.
    const local = replyWith(["https://127.0.0.1:7100"], { peerEndpoints: ["https://127.0.0.1:7100"] });
    const localAdmitted = await a.mesh.probe(local.url);
    expect(localAdmitted.endpoints).toEqual(["https://127.0.0.1:7100"]);
  });
});

describe("bind address URLs (design.md 3.1)", () => {
  it("brackets IPv6 literals and keeps host names, by DSH's bind rule", () => {
    expect(bindUrl("192.168.1.2", 11811)).toBe("https://192.168.1.2:11811");
    expect(bindUrl("fd00::5", 11811)).toBe("https://[fd00::5]:11811");
    expect(bindUrl("::ffff:127.0.0.1", 11811)).toBe("https://127.0.0.1:11811");
    expect(bindUrl("localhost", 11811)).toBe("https://localhost:11811");
    // A zone id has no URL form.
    expect(bindUrl("fe80::1%eth0", 11811)).toBeUndefined();
    for (const url of detectLocalEndpoints(11811)) expect(URL.canParse(url)).toBe(true);
  });
});
