import { lookup } from "node:dns/promises";
import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Endpoint screening (design.md 6.6).
 *
 * - Private and public addresses may be dialed: a mesh may span a VPN, public
 *   IPv6 or a cloud server, and only members, who proved the password, declare
 *   endpoints or hand out lists.
 * - Loopback is accepted only when it came from this machine: an endpoint a node
 *   declared in a `hello` that arrived over loopback, or a candidate in a member
 *   list that arrived over loopback. One machine runs one node, so a loopback
 *   address from anywhere else names this machine, never the node it is meant
 *   for, and could only aim our heartbeats at a local service. Same-machine
 *   meshes (tests, development) still work, because there everything is loopback.
 * - Link-local (cloud metadata), multicast and unspecified addresses are never
 *   accepted. Explicit endpoints (settings, a direct join) are not filtered.
 */

type AddressClass = "loopback" | "link-local" | "private" | "public" | "reserved";

function ipv4OctetsClass(a: number, b: number): AddressClass {
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 0 || a >= 224) return "reserved";
  return "public";
}

function ipv4Class(address: string): AddressClass {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return ipv4OctetsClass(a, b);
}

/** Parse an IPv6 literal (with optional `%zone` or dotted-quad IPv4 tail) into eight 16-bit groups. */
function parseIpv6(address: string): number[] | null {
  const bare = address.split("%", 1)[0] ?? "";
  let normalized = bare;
  const lastColon = bare.lastIndexOf(":");
  if (lastColon !== -1 && bare.includes(".")) {
    const tail = bare.slice(lastColon + 1);
    if (!isIPv4(tail)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    normalized = `${bare.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0]?.split(":") ?? []);
  const right = halves.length === 2 && halves[1] !== "" ? (halves[1]?.split(":") ?? []) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...left, ...Array<string>(missing).fill("0"), ...right];
  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function ipv6Class(address: string): AddressClass {
  const groups = parseIpv6(address);
  if (groups === null) return "reserved";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) return "reserved";
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return "loopback";
  // IPv4-mapped IPv6 (`::ffff:0:0/96`), whether spelled as dotted quad or WHATWG-normalized hex.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return ipv4OctetsClass(g6 >> 8, g6 & 0xff);
  }
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xfe00) === 0xfc00) return "private";
  if ((g0 & 0xff00) === 0xff00) return "reserved";
  return "public";
}

/** Loopback by DSH's own rule (`isLoopbackHost`: 127/8, `::1` and their mapped forms); the other classes are ours. */
function addressClass(address: string): AddressClass {
  if (isLoopbackHost(address)) return "loopback";
  return isIPv4(address) ? ipv4Class(address) : ipv6Class(address);
}

function addressAllowed(address: string, fromThisMachine: boolean): boolean {
  const cls = addressClass(address);
  switch (cls) {
    case "loopback":
      return fromThisMachine;
    case "link-local":
    case "reserved":
      return false;
    case "private":
    case "public":
      return true;
  }
}

/** Whether a URL names this machine by a loopback IP literal (`127.0.0.1`, `[::1]`). */
export function isLoopbackUrl(endpoint: string): boolean {
  try {
    return isLoopbackHost(new URL(endpoint).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** What screening an endpoint concluded: it may be dialed, must not be, or its name does not resolve from here. */
type ScreenVerdict = "allowed" | "refused" | "unresolved";

/**
 * Screen one endpoint: `refused` when the URL is unusable or a literal or
 * resolved address is forbidden, `unresolved` when the name does not resolve
 * from here right now, else `allowed`. A caller that only needs to keep known
 * bad addresses out (a join) can accept `unresolved`.
 */
async function screenEndpoint(endpoint: string, fromThisMachine: boolean): Promise<ScreenVerdict> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "refused";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "refused";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host) || isIPv6(host)) return addressAllowed(host, fromThisMachine) ? "allowed" : "refused";
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return "unresolved";
  }
  if (addresses.length === 0) return "unresolved";
  return addresses.every((entry) => addressAllowed(entry.address, fromThisMachine)) ? "allowed" : "refused";
}

/** How long one screening conclusion is reused (design.md 6.6). */
const SCREENING_TTL_MS = 60_000;

type Cached<T> = { value: T; until: number };

/**
 * What this node has concluded about endpoints it was told of, kept briefly: a
 * lookup per heartbeat would be wasteful, but a conclusion kept for the whole
 * process would never notice that a name now points somewhere else.
 *
 * Two kinds of endpoint come through here (design.md 6.6): a candidate, learned from
 * someone else's member list, is screened before it is dialed; the endpoints a
 * node declares for itself in its `hello` are screened before they are recorded.
 * Both follow the same rule; `fromThisMachine` says whether the list or the
 * `hello` arrived over loopback.
 */
export class EndpointScreen {
  private readonly candidates = new Map<string, Cached<boolean>>();
  private readonly declarations = new Map<string, Cached<string[]>>();

  /** Whether a candidate endpoint may be dialed; `fromThisMachine`: the list that named it arrived over loopback. */
  async candidate(endpoint: string, fromThisMachine: boolean): Promise<boolean> {
    const key = `${fromThisMachine}|${endpoint}`;
    const cached = this.candidates.get(key);
    if (cached !== undefined && cached.until > Date.now()) return cached.value;
    const value = (await screenEndpoint(endpoint, fromThisMachine)) === "allowed";
    this.candidates.set(key, { value, until: Date.now() + SCREENING_TTL_MS });
    return value;
  }

  /**
   * The endpoints a node declared in its `hello` that this node is willing to dial
   * back. The sender proved the password, but what it declares is still input:
   * link-local (cloud metadata), multicast and unspecified addresses are dropped,
   * and so are loopback addresses unless the request itself came over loopback.
   * A name that does not resolve from here is kept: it is not known to be bad.
   * `fresh` screens again instead of reusing the last conclusion: a first contact
   * always does.
   */
  async declared(declared: readonly string[], overLoopback: boolean, fresh: boolean): Promise<string[]> {
    const key = `${overLoopback}|${declared.join(",")}`;
    const cached = this.declarations.get(key);
    if (!fresh && cached !== undefined && cached.until > Date.now()) return cached.value;
    const verdicts = await Promise.all(declared.map((endpoint) => screenEndpoint(endpoint, overLoopback)));
    const allowed = declared.filter((_, index) => verdicts[index] !== "refused");
    this.declarations.set(key, { value: allowed, until: Date.now() + SCREENING_TTL_MS });
    return allowed;
  }
}
