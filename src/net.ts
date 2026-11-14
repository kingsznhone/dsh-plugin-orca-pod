import { lookup } from "node:dns/promises";
import { createServer, isIPv4, isIPv6 } from "node:net";

/**
 * Candidate-endpoint filtering (§7.7). Endpoints an orca node learned from
 * another orca node's member list are untrusted input: dialing one must not
 * become a probe of the host's own services or the cloud metadata endpoint.
 * Explicit endpoints (config, CLI, a direct join) are not filtered here.
 */

export type CandidateDialPolicy = {
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
export async function candidateEndpointAllowed(
  endpoint: string,
  policy: CandidateDialPolicy = {},
): Promise<boolean> {
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
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161,
  179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563,
  587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (port > 0 && !isBlockedFetchPort(port)) return port;
  }
  throw new Error("could not pick a free port that fetch accepts");
}
