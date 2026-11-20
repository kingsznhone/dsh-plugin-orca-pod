/**
 * The node's TLS certificate (§7.7): self-signed, over the node's own Ed25519
 * identity key. The orca node id *is* that public key, so whoever dials a node
 * knows the key its certificate must carry before it connects: no CA, no
 * fingerprint to exchange, no trust on first use.
 *
 * Node's crypto signs but does not build certificates, so this is the minimal
 * DER of an X.509 v3 certificate: version, serial, the Ed25519 algorithm, one
 * common name as issuer and subject, a validity window, the key. It is made
 * afresh each time a node starts and never stored.
 */

import { createPrivateKey, createPublicKey, randomBytes, sign, type X509Certificate } from "node:crypto";

import type { NodeIdentity } from "./identity.ts";
import { nodeIdOf, type OrcaNodeId } from "./ids.ts";

/** What a TLS listener needs: the identity's private key and the certificate over it, both PEM. */
export type NodeCertificate = { key: string; cert: string };

/** The validity window: from a day back (clock skew) to ten years on; the certificate is remade at every start. */
const BACKDATE_MS = 24 * 60 * 60 * 1000;
const LIFETIME_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** id-Ed25519 (RFC 8410): 1.3.101.112. */
const OID_ED25519 = "2b6570";
/** id-at-commonName: 2.5.4.3. */
const OID_COMMON_NAME = "550403";

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);
const objectId = (hex: string): Buffer => tlv(0x06, Buffer.from(hex, "hex"));

/** A non-negative INTEGER: a leading zero byte keeps a high first bit from reading as a sign. */
function integer(bytes: Buffer): Buffer {
  return tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** UTCTime through 2049, GeneralizedTime from 2050 on (RFC 5280 §4.1.2.5). */
function time(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${digits}Z`));
}

/** The node's self-signed certificate, over its identity key. */
export function nodeCertificate(identity: NodeIdentity, now = Date.now()): NodeCertificate {
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const algorithm = sequence(objectId(OID_ED25519));
  const name = sequence(tlv(0x31, sequence(objectId(OID_COMMON_NAME), tlv(0x0c, Buffer.from("orca-pod node")))));
  // A positive serial in minimal DER: the first byte is 0x01-0x7f, so it needs no
  // sign byte and is never a leading zero (which strict parsers reject as padding).
  const serial = randomBytes(16);
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name,
    sequence(time(new Date(now - BACKDATE_MS)), time(new Date(now + LIFETIME_MS))),
    name,
    createPublicKey(privateKey).export({ type: "spki", format: "der" }),
  );
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), sign(null, tbs, privateKey)));
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    key: identity.privateKeyPem,
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}

/** The node a certificate belongs to: its key when it is an Ed25519 one, else undefined (a CA-issued certificate). */
export function nodeOfCertificate(certificate: X509Certificate): OrcaNodeId | undefined {
  const { publicKey } = certificate;
  if (publicKey.asymmetricKeyType !== "ed25519") return undefined;
  const spki = publicKey.export({ type: "spki", format: "der" });
  return nodeIdOf(spki.subarray(spki.length - 32));
}
