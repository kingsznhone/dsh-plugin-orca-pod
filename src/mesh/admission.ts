import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";
import type { Admission, AdmissionKind } from "./wire.ts";

const ADMISSION_DOMAIN: Record<AdmissionKind, string> = { join: "orca-pod/join", heartbeat: "orca-pod/heartbeat" };

// ---------------------------------------------------------------------------
// Admission proof (§7.1): the workgroup password gates *joining* the mesh.
// ---------------------------------------------------------------------------

type AdmissionFields = {
  workgroupId: WorkgroupId;
  orcaNodeId: OrcaNodeId;
  ts: number;
  nonce: string;
};

/**
 * HMAC over the admission fields, keyed by the password-derived workgroup key.
 * `join` gates entry to the mesh; `heartbeat` repeats the proof on every beat
 * (§7.1): a node whose password changed carries a proof the old mesh cannot
 * verify, so both sides stop answering and drop each other within a few ticks.
 */
export function admissionProof(kind: AdmissionKind, key: Buffer, fields: AdmissionFields): string {
  const input = [ADMISSION_DOMAIN[kind], fields.workgroupId, fields.orcaNodeId, String(fields.ts), fields.nonce].join(
    "|",
  );
  return createHmac("sha256", key).update(input).digest("base64url");
}

export function verifyAdmissionProof(
  kind: AdmissionKind,
  key: Buffer,
  fields: AdmissionFields,
  proof: string,
): boolean {
  const expected = Buffer.from(admissionProof(kind, key, fields), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A fresh admission for `kind`: this node's ids, now, a new nonce and the proof over them. */
export function createAdmission(
  kind: AdmissionKind,
  key: Buffer,
  ids: { workgroupId: WorkgroupId; orcaNodeId: OrcaNodeId },
): Admission {
  const ts = Date.now();
  const nonce = randomUUID();
  const proof = admissionProof(kind, key, { ...ids, ts, nonce });
  return { workgroup_id: ids.workgroupId, orca_node_id: ids.orcaNodeId, ts, nonce, proof };
}

/** True when the proof in a received admission was made with `key` over exactly its own fields. */
export function verifyAdmission(kind: AdmissionKind, key: Buffer, admission: Admission): boolean {
  const { workgroup_id: workgroupId, orca_node_id: orcaNodeId, ts, nonce, proof } = admission;
  return verifyAdmissionProof(kind, key, { workgroupId, orcaNodeId, ts, nonce }, proof);
}
