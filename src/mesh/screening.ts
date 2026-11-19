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
type DialPolicy = {
  /** Public addresses are off by default; private ranges are the normal case. */
  allowPublicPeers?: boolean;
  /** Set false to reject loopback targets; allowed by default for same-host meshes. */
  allowLoopbackPeers?: boolean;
};

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

/** What screening an endpoint concluded: it may be dialed, must not be, or its name does not resolve from here. */
type ScreenVerdict = "allowed" | "refused" | "unresolved";

/**
 * Screen one endpoint: `refused` when the URL is unusable or a literal or
 * resolved address is forbidden, `unresolved` when the name does not resolve
 * from here right now, else `allowed`. A caller that only needs to keep known
 * bad addresses out (a join) can accept `unresolved`.
 */
async function screenEndpoint(endpoint: string, policy: DialPolicy): Promise<ScreenVerdict> {
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

/** How long one screening conclusion is reused (§7.7). */
const SCREENING_TTL_MS = 60_000;

type Cached<T> = { value: T; until: number };

/**
 * What this node has concluded about endpoints it was told of, kept briefly: a
 * lookup per heartbeat would be wasteful, but a conclusion kept for the whole
 * process would never notice that a name now points somewhere else.
 *
 * Two kinds of endpoint come through here (§7.7): a candidate, learned from
 * someone else's member list, is screened under the node's own policy before it
 * is dialed; the endpoints a node declares for itself in its `hello` are screened
 * before they are recorded, under the policy of explicit contact.
 */
export class EndpointScreen {
  private readonly candidates = new Map<string, Cached<boolean>>();
  private readonly declarations = new Map<string, Cached<string[]>>();

  constructor(private readonly policy: DialPolicy) {}

  /** Whether a candidate endpoint may be dialed. */
  async candidate(endpoint: string): Promise<boolean> {
    const cached = this.candidates.get(endpoint);
    if (cached !== undefined && cached.until > Date.now()) return cached.value;
    const value = (await screenEndpoint(endpoint, this.policy)) === "allowed";
    this.candidates.set(endpoint, { value, until: Date.now() + SCREENING_TTL_MS });
    return value;
  }

  /**
   * The endpoints a node declared in its `hello` that this node is willing to dial
   * back. The sender proved the password, so public addresses are fine, but what
   * it declares is still input: link-local (cloud metadata), multicast and
   * unspecified addresses are dropped, and so are loopback addresses unless the
   * request itself came over loopback (a remote machine cannot be reached at our
   * 127.0.0.1, so such an endpoint could only aim our heartbeats at a local
   * service). A name that does not resolve from here is kept: it is not known to
   * be bad. `fresh` screens again instead of reusing the last conclusion: a first
   * contact always does.
   */
  async declared(declared: readonly string[], overLoopback: boolean, fresh: boolean): Promise<string[]> {
    const key = `${overLoopback}|${declared.join(",")}`;
    const cached = this.declarations.get(key);
    if (!fresh && cached !== undefined && cached.until > Date.now()) return cached.value;
    // Only the always-forbidden ranges are refused, and loopback unless the request came over it.
    const policy = { allowPublicPeers: true, allowLoopbackPeers: overLoopback };
    const verdicts = await Promise.all(declared.map((endpoint) => screenEndpoint(endpoint, policy)));
    const allowed = declared.filter((_, index) => verdicts[index] !== "refused");
    this.declarations.set(key, { value: allowed, until: Date.now() + SCREENING_TTL_MS });
    return allowed;
  }
}
