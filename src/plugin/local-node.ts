import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { LOCAL_TOKEN_HEADER } from "../api/access.ts";
import type { BlobRef, OpenedBlob } from "../core/blobs.ts";
import { NODE_TOKEN_ENV, NODE_URL_ENV } from "../core/entry.ts";

/** A file once published: its name across the mesh, its size, and when it stops being downloadable (null: never). */
export type PublishedFile = { ref: string; size: number; expires_at: string | null };

/**
 * This machine's node as a task session reaches it (§5.6). The plugin inside a
 * task runs in another `dsh` process and has no node of its own, so its file
 * methods go through the node's local routes, at the address and with the token
 * the executor put into the task's environment.
 */
export class LocalNode {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  /** The node the executor named; null when it named none (a task an older node started). */
  static fromEnv(): LocalNode | null {
    const url = process.env[NODE_URL_ENV];
    const token = process.env[NODE_TOKEN_ENV];
    return url && token ? new LocalNode(url, token) : null;
  }

  /** Have the node copy a file of this machine into its registry. */
  async publish(path: string, ttlS: number | undefined, signal: AbortSignal): Promise<PublishedFile> {
    const response = await this.call("/local/blobs", signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ttlS === undefined ? { path } : { path, ttl_s: ttlS }),
    });
    return (await response.json()) as PublishedFile;
  }

  /** A file any member published, as the node fetches it; the caller checks the bytes against the sha256. */
  async open(ref: BlobRef, signal: AbortSignal): Promise<OpenedBlob> {
    const response = await this.call(`/local/blobs/${ref.node}/${ref.blob}`, signal);
    if (response.body === null) throw new Error("this machine's node answered without the file");
    const length = response.headers.get("content-length");
    return {
      stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      size: length === null ? undefined : Number(length),
    };
  }

  private async call(
    path: string,
    signal: AbortSignal,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    const response = await fetch(new URL(path, this.url), {
      ...init,
      headers: { ...init.headers, [LOCAL_TOKEN_HEADER]: this.token },
      signal,
    });
    if (response.ok) return response;
    const answer = (await response.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(`this machine's node answered ${response.status}${answer?.message ? `: ${answer.message}` : ""}`);
  }
}
