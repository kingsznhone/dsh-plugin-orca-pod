/**
 * How a file is named across the mesh (§5.6): by the member that published it
 * and the sha256 of its bytes, written `<orca_node_id>/<sha256>`. The name holds
 * no address: whoever fetches it asks its own node, which dials that member the
 * way its heartbeat does, so a reverse proxy or a second interface in front of
 * the publisher changes nothing.
 */

import { z } from "zod";

import { type OrcaNodeId, OrcaNodeIdSchema } from "./peer.ts";

/** A blob id is the sha256 of the file, as lowercase hex. */
export const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/;
export const BlobIdSchema = z.string().regex(BLOB_ID_PATTERN, "must be a lowercase sha256 hex digest");

/** A published file: who published it and what its bytes hash to. */
export type BlobRef = { node: OrcaNodeId; blob: string };

export const blobRefText = ({ node, blob }: BlobRef): string => `${node}/${blob}`;

const BlobRefSchema = z.object({ node: OrcaNodeIdSchema, blob: BlobIdSchema });

/** Read `<orca_node_id>/<sha256>`; null when the text is not one. */
export function parseBlobRef(text: string): BlobRef | null {
  const [node, blob, ...rest] = text.trim().split("/");
  if (rest.length > 0) return null;
  const parsed = BlobRefSchema.safeParse({ node, blob });
  return parsed.success ? parsed.data : null;
}
