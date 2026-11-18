import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { BLOB_ID_PATTERN, type FileBlobRegistry, type OpenedBlob } from "../core/blobs.ts";
import { errorMessage, PodError } from "../core/errors.ts";
import type { OrcaNodeId } from "../core/wire/peer.ts";
import type { HttpPeerClient } from "./peer-client.ts";
import type { Workgroup } from "./workgroup.ts";

/**
 * Files move by name, never by URL (§5.6): a file is named by the member that
 * published it and its sha256. This node's own files come from disk; another
 * member's are fetched from the first of its addresses that answers, the way
 * its heartbeat is dialed.
 */
export class BlobFetcher {
  constructor(
    private readonly blobs: FileBlobRegistry,
    private readonly workgroup: Workgroup,
    private readonly client: HttpPeerClient,
    private readonly selfId: OrcaNodeId,
  ) {}

  /** A file this node published, streamed from disk. */
  open(blobId: string): OpenedBlob {
    return this.blobs.open(blobId);
  }

  /** A file a member published, streamed (§5.6). */
  async fetch(nodeId: OrcaNodeId, blobId: string, signal?: AbortSignal): Promise<OpenedBlob> {
    if (!BLOB_ID_PATTERN.test(blobId)) throw new PodError("bad_request", "a blob id is a lowercase sha256 hex digest");
    if (nodeId === this.selfId) return this.blobs.open(blobId);
    const addresses = await this.workgroup.endpointsOf(nodeId);
    if (addresses.length === 0) throw new PodError("unknown_orca_node", `${nodeId} is not a member of this workgroup`);
    let unreachable: unknown;
    for (const endpoint of addresses) {
      try {
        const { body, size } = await this.client.download(endpoint, `/blobs/${blobId}`, { target: nodeId, signal });
        return { stream: Readable.fromWeb(body as WebReadableStream<Uint8Array>), size };
      } catch (error) {
        // The node answered: its answer stands. Only an address that does not answer moves on to the next.
        if (error instanceof Error && error.name === "PodError") throw error;
        unreachable = error;
      }
    }
    throw new PodError("peer_not_online", `${nodeId} did not answer at any address: ${errorMessage(unreachable)}`);
  }
}
