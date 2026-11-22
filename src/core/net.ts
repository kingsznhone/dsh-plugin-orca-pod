/** The canonical form of a peer address, as a person or a tool writes one. */

import { DEFAULT_PORT } from "./constants.ts";

/**
 * Split `host[:port]` or `[ipv6][:port]` into the host and the port text (`undefined` when there is no colon,
 * empty string when there is one with nothing after it).
 */
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
 * The one canonical form of a peer address: `https://host:port` with no path
 * and no trailing slash. Accepts a bare `host`, `host:port` (default port `DEFAULT_PORT`)
 * and bare IPv6 literals. Nodes speak https only (design.md 6.2): `https://` without a
 * port means 443 (a node behind a proxy); `http://`, which older settings and
 * peers wrote, is read as https, on the node port when it names none.
 */
export function normalizePeerUrl(peer: string): string {
  const trimmed = peer.trim();
  if (trimmed.length === 0) throw new Error("peer address is required");
  const schemeMatch = /^(https?):\/\//i.exec(trimmed);
  const rest = (schemeMatch === null ? trimmed : trimmed.slice(schemeMatch[0].length)).replace(/\/+$/, "");
  if (rest.length === 0) throw new Error(`peer address must include a host: ${trimmed}`);
  if (rest.includes("/") || rest.includes("?") || rest.includes("#")) {
    throw new Error(`peer address must be host[:port], without a path: ${trimmed}`);
  }
  const { host, portText } = splitHostPort(rest, trimmed);
  if (host.length === 0) throw new Error(`peer address must include a host: ${trimmed}`);
  const fallbackPort = schemeMatch?.[1]?.toLowerCase() === "https" ? 443 : DEFAULT_PORT;
  const port = portText === undefined || portText.length === 0 ? fallbackPort : Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid peer port: ${portText ?? ""}`);
  const url = `https://${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (!URL.canParse(url)) throw new Error(`peer address must be an https host[:port]: ${trimmed}`);
  return url;
}

/** An endpoint as nodes dial it: https, which is all a node serves (design.md 6.2); an `http://` one is read as https. */
export function asHttps(endpoint: string): string {
  return endpoint.replace(/^http:\/\//i, "https://");
}
