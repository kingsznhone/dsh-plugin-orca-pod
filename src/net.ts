import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { createServer, isIPv4, isIPv6, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

import { DEFAULT_PORT, isHttpEndpoint } from "./protocol.ts";

/**
 * Candidate-endpoint filtering (§7.7). Endpoints an orca node learned from
 * another orca node's member list are untrusted input: dialing one must not
 * become a probe of the host's own services or the cloud metadata endpoint.
 * Explicit endpoints (config, CLI, a direct join) are not filtered here.
 */

type CandidateDialPolicy = {
  /** Public addresses are off by default; private ranges are the normal case. */
  allowPublicPeers?: boolean;
  /** Set false to reject loopback candidates; allowed by default for same-host meshes. */
  allowLoopbackPeers?: boolean;
};

type AddressClass = "loopback" | "link-local" | "private" | "public" | "reserved";

function ipv4Class(address: string): AddressClass {
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 0 || a >= 224) return "reserved";
  return "public";
}

function ipv6Class(address: string): AddressClass {
  const lower = address.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower === "::") return "reserved";
  if (/^fe[89ab]/.test(lower)) return "link-local";
  if (/^f[cd]/.test(lower)) return "private";
  if (/^ff/.test(lower)) return "reserved";
  if (lower.startsWith("::ffff:")) return ipv4Class(lower.slice("::ffff:".length));
  return "public";
}

function addressAllowed(address: string, policy: CandidateDialPolicy): boolean {
  const cls = isIPv4(address) ? ipv4Class(address) : ipv6Class(address);
  switch (cls) {
    case "loopback":
      return policy.allowLoopbackPeers !== false;
    case "link-local":
    case "reserved":
      return false;
    case "private":
      return true;
    case "public":
      return policy.allowPublicPeers === true;
  }
}

/** True when a candidate endpoint may be dialed under this policy (§7.7). */
export async function candidateEndpointAllowed(endpoint: string, policy: CandidateDialPolicy = {}): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host) || isIPv6(host)) return addressAllowed(host, policy);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => addressAllowed(entry.address, policy));
  } catch {
    return false;
  }
}

/**
 * Ports the WHATWG fetch standard forbids. `undici` (and browsers) reject a
 * request whose URL names one of them with `fetch failed` / `bad port`, so an
 * orca node must never advertise such a port as its dial endpoint.
 */
const BLOCKED_FETCH_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** True when `fetch` refuses to connect to this port. */
export function isBlockedFetchPort(port: number): boolean {
  return BLOCKED_FETCH_PORTS.has(port);
}

/**
 * Pick a free loopback port that `fetch` may dial.
 *
 * `listen(0)` lets the kernel choose, but it may choose one of the blocked
 * ports above; peers would then fail to reach this orca node with `bad port`.
 * The probe closes immediately; the caller listens on the returned port.
 */
export async function pickFreePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (!isBlockedFetchPort(port)) return port;
  }
}

/** True for an IP literal on this machine: 127.0.0.0/8, `::1`, or an IPv4-mapped loopback. */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  if (isIPv4(address)) return ipv4Class(address) === "loopback";
  return isIPv6(address) && ipv6Class(address) === "loopback";
}

/** True for URLs that dial the local machine only. */
export function isLoopbackEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || isLoopbackAddress(host);
  } catch {
    return false;
  }
}

/** Headers a reverse proxy adds; their presence means the socket peer is not the real client. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

/** True when the request came over a loopback socket and carries no proxy header. */
export function isDirectLoopbackRequest(request: {
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: IncomingHttpHeaders;
}): boolean {
  return (
    isLoopbackAddress(request.socket?.remoteAddress) &&
    PROXY_HEADERS.every((name) => request.headers[name] === undefined)
  );
}

/**
 * Advertised-URL suggestions for the panel wizard and for nodes that listen on
 * a wildcard address: every non-internal IPv4/IPv6 address of this machine on
 * the given port. IPv4 comes first (the reliable LAN path); link-local IPv6
 * (`fe80::/10`, needs a zone id) is skipped.
 */
export function detectLocalEndpoints(port: number): string[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family === "IPv6") {
        if (/^fe80:/i.test(address.address)) continue;
        ipv6.push(`http://[${address.address}]:${port}`);
      } else {
        ipv4.push(`http://${address.address}:${port}`);
      }
    }
  }
  return [...new Set([...ipv4, ...ipv6])];
}

/** Listen-address choices for setup UIs: loopback, every interface, then each detected local address. */
export function bindChoices(port: number): string[] {
  const hosts = detectLocalEndpoints(port).map((url) => new URL(url).hostname.replace(/^\[|\]$/g, ""));
  return [...new Set(["127.0.0.1", "::", ...hosts])];
}

/**
 * The one canonical form of a peer address: `scheme://host:port` with no path
 * and no trailing slash. Accepts a bare `host`, `host:port` (default port `DEFAULT_PORT`)
 * and bare IPv6 literals; an explicit scheme without a port gets its own default.
 */
export function normalizePeerUrl(peer: string): string {
  const trimmed = peer.trim();
  if (trimmed.length === 0) throw new Error("peer address is required");
  const schemeMatch = /^(https?):\/\//i.exec(trimmed);
  const scheme = schemeMatch?.[1]?.toLowerCase() ?? "http";
  const rest = (schemeMatch === null ? trimmed : trimmed.slice(schemeMatch[0].length)).replace(/\/+$/, "");
  if (rest.length === 0) throw new Error(`peer address must include a host: ${trimmed}`);
  if (rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    throw new Error(`peer address must be host[:port], without a path: ${trimmed}`);
  }
  let host: string;
  let portText: string | undefined;
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    const after = rest.slice(close + 1);
    if (close === -1 || (after.length > 0 && !after.startsWith(":"))) {
      throw new Error(`invalid IPv6 peer address: ${trimmed}`);
    }
    host = rest.slice(1, close);
    portText = after.slice(1);
  } else {
    const [name = "", suffix, ...more] = rest.split(":");
    // More than one colon and no brackets is a bare IPv6 literal without a port.
    [host, portText] = suffix !== undefined && more.length === 0 ? [name, suffix] : [rest, undefined];
  }
  if (host.length === 0) throw new Error(`peer address must include a host: ${trimmed}`);
  const fallbackPort = schemeMatch === null ? DEFAULT_PORT : scheme === "https" ? 443 : 80;
  const port = portText === undefined || portText.length === 0 ? fallbackPort : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid peer port: ${portText ?? ""}`);
  const url = `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (!isHttpEndpoint(url)) throw new Error(`peer address must be an http(s) host[:port]: ${trimmed}`);
  return url;
}
