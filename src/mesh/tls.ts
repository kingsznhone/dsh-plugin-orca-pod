/**
 * How this node's outbound calls check who is at the other end of the TLS
 * connection (§7.7). Every node serves a self-signed certificate over its own
 * Ed25519 identity key, so the node id a call is addressed to is the key the
 * certificate must carry: the connection is pinned to it after the handshake,
 * before any request goes out. A first contact (no id yet) takes the key the
 * certificate carried and leaves it to the caller to check that the reply was
 * signed by that same key. A certificate a public CA issued for the host is
 * accepted as well: a node behind a reverse proxy (Caddy) shows the proxy's.
 */

import type { TLSSocket } from "node:tls";

import { Agent, buildConnector, type Dispatcher } from "undici";

import { nodeOfCertificate } from "../core/certificate.ts";
import type { OrcaNodeId } from "../core/ids.ts";

/**
 * The TLS 1.3 signature algorithms a node offers: Ed25519 first, for node
 * certificates (BoringSSL, which Electron's Node uses, leaves it out unless
 * asked), then what CA-issued certificates are signed with (a node behind a proxy).
 */
const NODE_SIGALGS = [
  "ed25519",
  "ecdsa_secp256r1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha256",
  "rsa_pss_rsae_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha256",
  "rsa_pkcs1_sha384",
  "rsa_pkcs1_sha512",
].join(":");

/** One call's way to its node: the dispatcher, and afterwards what the certificate showed. */
export type TlsRoute = {
  dispatcher: Dispatcher;
  /** The node whose key the certificate carried; undefined for a CA-issued one, or before any connection. */
  presented(): OrcaNodeId | undefined;
  /** The call is over: a first contact's own connection is closed. */
  release(): void;
};

/**
 * The TLS side of this node's outbound calls: one connection pool per node it
 * has addressed by id, kept for reuse, and a one-off connection for each first
 * contact. One per orca instance; `close` ends every connection.
 */
export class PeerTls {
  private readonly pinned = new Map<string, Agent>();

  /** How a call addressed to `node` goes out; `""` is a first contact. */
  route(node: string): TlsRoute {
    if (node !== "") {
      let agent = this.pinned.get(node);
      if (agent === undefined) {
        agent = PeerTls.agent(node, () => {});
        this.pinned.set(node, agent);
      }
      return { dispatcher: agent, presented: () => undefined, release: () => {} };
    }
    let seen: OrcaNodeId | undefined;
    const agent = PeerTls.agent("", (presented) => {
      seen = presented;
    });
    return { dispatcher: agent, presented: () => seen, release: () => void agent.close() };
  }

  /** Close every connection this node holds open. */
  async close(): Promise<void> {
    const agents = [...this.pinned.values()];
    this.pinned.clear();
    await Promise.all(agents.map((agent) => agent.close()));
  }

  /** A pool whose every connection must show `expected`'s key (any node's key when `""`), or a CA-issued certificate. */
  private static agent(expected: string, seen: (node: OrcaNodeId | undefined) => void): Agent {
    // No CA for node certificates: the key itself is what is checked. No session cache:
    // a resumed TLS 1.3 session does not show the certificate again, so it could not be pinned.
    const connect = buildConnector({
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      maxCachedSessions: 0,
      sigalgs: NODE_SIGALGS,
    });
    return new Agent({
      connect(options, callback) {
        if (options.protocol !== "https:") {
          callback(new Error(`orca nodes speak https only, not ${options.protocol}`), null);
          return;
        }
        connect(options, (error, socket) => {
          if (error !== null) {
            callback(error, null);
            return;
          }
          try {
            seen(PeerTls.check(socket as TLSSocket, expected));
            callback(null, socket);
          } catch (refusal) {
            socket.destroy();
            callback(refusal as Error, null);
          }
        });
      },
    });
  }

  /**
   * Accept a connection for `expected`: the certificate carries that node's key
   * (any node's on a first contact), or a public CA issued it for the host (a
   * proxy). Returns the node whose key it carried; undefined for a CA-issued one.
   */
  private static check(socket: TLSSocket, expected: string): OrcaNodeId | undefined {
    const certificate = socket.getPeerX509Certificate();
    const node = certificate === undefined ? undefined : nodeOfCertificate(certificate);
    if (node !== undefined && (expected === "" || node === expected)) return node;
    if (socket.authorized) return undefined;
    throw new Error(
      node === undefined
        ? `the certificate is not a node's and not valid for the host (${socket.authorizationError ?? "unknown"})`
        : `the certificate belongs to ${node}, not ${expected}`,
    );
  }
}
