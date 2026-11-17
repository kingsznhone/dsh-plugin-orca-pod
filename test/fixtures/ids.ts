import { createHash } from "node:crypto";

/** A well-formed orca node id (43 base64url characters) for a label, for tests that need ids but no keys. */
export function fakeNodeId(label: string): string {
  return createHash("sha256").update(label).digest("base64url").slice(0, 43);
}
