/** Network helpers: peer URL normalization, loopback checks, dialable ports and local addresses. */

import type { IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

import { isLoopbackAddress } from "../membership/index.ts";
import { DEFAULT_PORT, isHttpEndpoint } from "../protocol/index.ts";

/**
 * Ports the WHATWG fetch standard forbids. `undici` (and browsers) reject a
 * request whose URL names one of them with `fetch failed` / `bad port`, so an
 * orca node must never advertise such a port as its dial endpoint.
 */
const BLOCKED_FETCH_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
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
