import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

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
