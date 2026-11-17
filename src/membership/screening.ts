import { lookup } from "node:dns/promises";
import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import { isIPv4, isIPv6 } from "node:net";

/**
 * Endpoint screening (§7.7).
 *
 * - Candidates (endpoints learned from another node's member list) are checked
 *   against the configured policy before the heartbeat loop dials them:
 *   private ranges yes, public only when allowed, loopback unless disabled.
 * - Endpoints a node declares in its own join are checked with
 *   `EXPLICIT_DIAL_POLICY` (public addresses are fine) before they are recorded.
 * - Link-local (cloud metadata), multicast and unspecified addresses are never
 *   accepted. Explicit endpoints (config, CLI, a direct join) are not filtered.
 */
export type DialPolicy = {
  /** Public addresses are off by default; private ranges are the normal case. */
  allowPublicPeers?: boolean;
  /** Set false to reject loopback targets; allowed by default for same-host meshes. */
  allowLoopbackPeers?: boolean;
};

/** Policy for endpoints a node declares for itself: only the always-forbidden ranges are refused. */
export const EXPLICIT_DIAL_POLICY: DialPolicy = { allowPublicPeers: true, allowLoopbackPeers: true };

type AddressClass = "loopback" | "link-local" | "private" | "public" | "reserved";

function ipv4Class(address: string): AddressClass {
  const [a = 0, b = 0] = address.split(".").map(Number);
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
  if (lower === "::") return "reserved";
  if (/^fe[89ab]/.test(lower)) return "link-local";
  if (/^f[cd]/.test(lower)) return "private";
  if (/^ff/.test(lower)) return "reserved";
  if (lower.startsWith("::ffff:")) return ipv4Class(lower.slice("::ffff:".length));
  return "public";
}

/** Loopback by DSH's own rule (`isLoopbackHost`: 127/8, `::1` and their mapped forms); the other classes are ours. */
function addressClass(address: string): AddressClass {
  if (isLoopbackHost(address)) return "loopback";
  return isIPv4(address) ? ipv4Class(address) : ipv6Class(address);
}

function addressAllowed(address: string, policy: DialPolicy): boolean {
  const cls = addressClass(address);
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

/**
 * True when an endpoint may be dialed under this policy right now (§7.7). The
 * answer can change with DNS, so callers keep it only briefly.
 */
export async function candidateEndpointAllowed(endpoint: string, policy: DialPolicy = {}): Promise<boolean> {
  return (await screenEndpoint(endpoint, policy)) === "allowed";
}

/** What screening an endpoint concluded: it may be dialed, must not be, or its name does not resolve from here. */
export type ScreenVerdict = "allowed" | "refused" | "unresolved";

/**
 * Screen one endpoint: `refused` when the URL is unusable or a literal or
 * resolved address is forbidden, `unresolved` when the name does not resolve
 * from here right now, else `allowed`. A caller that only needs to keep known
 * bad addresses out (a join) can accept `unresolved`.
 */
export async function screenEndpoint(endpoint: string, policy: DialPolicy = {}): Promise<ScreenVerdict> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "refused";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "refused";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIPv4(host) || isIPv6(host)) return addressAllowed(host, policy) ? "allowed" : "refused";
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return "unresolved";
  }
  if (addresses.length === 0) return "unresolved";
  return addresses.every((entry) => addressAllowed(entry.address, policy)) ? "allowed" : "refused";
}
