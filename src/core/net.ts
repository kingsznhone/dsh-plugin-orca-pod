/** Network helpers: peer URL normalization, endpoint lists, loopback requests and local addresses. */

import type { IncomingHttpHeaders } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import { bindUrlHost, isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import { DEFAULT_PORT } from "./constants.ts";

/** Headers a reverse proxy adds; their presence means the socket peer is not the real client. */
const PROXY_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"];

/** True when the request came over a loopback socket and carries no proxy header. */
export function isDirectLoopbackRequest(request: {
  socket?: { remoteAddress?: string | undefined } | undefined;
  headers: IncomingHttpHeaders;
}): boolean {
  return (
    isLoopbackHost(request.socket?.remoteAddress ?? "") &&
    PROXY_HEADERS.every((name) => request.headers[name] === undefined)
  );
}

/**
 * The URL a node bound to `host` is dialed at, by DSH's rule for bind literals
 * (`bindUrlHost`: IPv6 bracketed, mapped loopback canonical, host names as
 * they are); undefined when the address has no URL form (an interface zone id).
 */
export function bindUrl(host: string, port: number): string | undefined {
  const urlHost = bindUrlHost(host);
  return urlHost === undefined ? undefined : `http://${urlHost}:${port}`;
}

/**
 * Advertised-URL suggestions for the panel wizard and for nodes that listen on
 * a wildcard address: every non-internal IPv4/IPv6 address of this machine on
 * the given port. IPv4 comes first (the reliable LAN path); link-local IPv6
 * (`fe80:` prefix, needs a zone id) is skipped.
 */
export function detectLocalEndpoints(port: number): string[] {
  const external = Object.values(networkInterfaces())
    .flat()
    .filter((address): address is NetworkInterfaceInfo => address !== undefined && !address.internal);
  const ipv4 = external.filter((address) => address.family !== "IPv6");
  const ipv6 = external.filter((address) => address.family === "IPv6" && !/^fe80:/i.test(address.address));
  const urls = [...ipv4, ...ipv6].map((address) => bindUrl(address.address, port));
  return [...new Set(urls.filter((url): url is string => url !== undefined))];
}

/** Split `host[:port]` or `[ipv6][:port]` into the host and the port text (`undefined` when there is none). */
function splitHostPort(rest: string, original: string): { host: string; portText: string | undefined } {
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    const after = rest.slice(close + 1);
    if (close === -1 || (after.length > 0 && !after.startsWith(":"))) {
      throw new Error(`invalid IPv6 peer address: ${original}`);
    }
    return { host: rest.slice(1, close), portText: after.slice(1) };
  }
  const [name = "", suffix, ...more] = rest.split(":");
  // More than one colon and no brackets is a bare IPv6 literal without a port.
  return suffix !== undefined && more.length === 0
    ? { host: name, portText: suffix }
    : { host: rest, portText: undefined };
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
  const { host, portText } = splitHostPort(rest, trimmed);
  if (host.length === 0) throw new Error(`peer address must include a host: ${trimmed}`);
  const fallbackPort = schemeMatch === null ? DEFAULT_PORT : scheme === "https" ? 443 : 80;
  const port = portText === undefined || portText.length === 0 ? fallbackPort : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid peer port: ${portText ?? ""}`);
  const url = `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (!isHttpEndpoint(url)) throw new Error(`peer address must be an http(s) host[:port]: ${trimmed}`);
  return url;
}

export function isHttpEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Max advertised base URLs per orca node; enough for IPv4/IPv6/LAN/public. */
const MAX_ENDPOINTS = 8;

/**
 * Validate and normalize an advertised endpoint list: http(s) base URLs with no
 * trailing slash, deduplicated, order preserved (first is preferred).
 */
export function normalizeEndpoints(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ENDPOINTS) return null;
  const endpoints: string[] = [];
  for (const item of value) {
    if (!isHttpEndpoint(item)) return null;
    const endpoint = item.endsWith("/") ? item.slice(0, -1) : item;
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints.length > 0 ? endpoints : null;
}
