/** Security: node identity, request signing, admission proofs and grant checks. */

export {
  DEFAULT_CLOCK_SKEW_MS,
  NonceCache,
  admissionProof,
  blobLinkSignature,
  buildAuthHeader,
  deriveWorkgroupKey,
  signGrant,
  verifyAdmissionProof,
  verifyAuth,
  verifyBlobLinkSignature,
} from "./crypto.ts";
export type { AdmissionKind, VerifiedAuth } from "./crypto.ts";
export { checkGrant, createGrantLedger, deriveChildGrant, parseSignedGrant, parseTaskRelay } from "./grants.ts";
export type { GrantLedger } from "./grants.ts";
export { identityPath, loadIdentity, loadOrCreateIdentity, shortenNodeId } from "./identity.ts";
export type { NodeIdentity } from "./identity.ts";
