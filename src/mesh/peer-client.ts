import type { z } from "zod";

import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

import { readAll } from "../core/stream.ts";
import { buildAuthHeader, bodySha256, newNonce, REPLY_HEADER, verifyReplyHeader } from "../core/signing.ts";
import { describeIssue, parseOrThrow } from "../core/schema.ts";
import { isPodErrorCode, PodError } from "../core/errors.ts";
import type { NodeIdentity } from "../core/identity.ts";
import { ErrorReplySchema, type ErrorReply } from "../core/wire/reply.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/wire/peer.ts";

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

type HttpMethod = "GET" | "POST";

type CallOptions = {
  /**
   * The node the request is addressed to; the signature is bound to it and the
   * reply must come from it (§7.1). `""` is a first contact, where the reply's
   * signer is taken as the node's identity.
   */
  target: string;
  /** Aborts the call; the deadline still applies. */
  signal?: AbortSignal;
  /** Replaces the client's default deadline (heartbeats are shorter). */
  timeoutMs?: number;
};

/** A signed JSON request and the schema its 2xx reply must satisfy. */
type JsonRequest<S extends z.ZodType> = {
  method: HttpMethod;
  path: string;
  payload?: unknown;
  reply: S;
  /** Names the call in error messages; the path when left out. */
  label?: string;
};

/** What an answer to a call is: its parsed body, and the node that signed it. */
export type Answer<T> = { body: T; from: OrcaNodeId };

/** A file a peer is sending: its bytes as they arrive, and their count when the peer said it. */
type Download = { body: ReadableStream<Uint8Array>; size: number | undefined };

/** Knobs of the client that are not collaborators. */
type PeerClientOptions = {
  fetch: FetchLike;
  /** Deadline of one call unless the caller names its own (§4.7). */
  timeoutMs: number;
};

/** A hostile or broken peer must not be able to make us buffer unbounded JSON (§4.7). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The code DSH's `deadline` stamps on an outbound call that ran out of time. */
const PEER_TIMEOUT = "PEER_TIMEOUT";

type Reply = { status: number; ok: boolean; contentType: string; bytes: Buffer; from: OrcaNodeId };

/** One error for both wire shapes: a peer's code if we know it, else `peer_error`. */
export function remoteError(label: string, status: number, body: ErrorReply | undefined): PodError {
  const data = body?.error?.data ?? body;
  const code = data?.code ?? body?.error?.message;
  const detail = typeof data?.message === "string" && data.message !== code ? ` (${data.message})` : "";
  const shown = typeof code === "string" ? code : `http_${status}`;
  return new PodError(isPodErrorCode(code) ? code : "peer_error", `${label} ${status}: ${shown}${detail}`, status);
}

/**
 * The outbound client (§4.7): every request carries this node's signature and the
 * workgroup proof, is bound to the node it is addressed to, and runs under a
 * deadline; every reply must be signed by that node, over its status and body and
 * the nonce of the request. Callers name the reply schema they expect, and a body
 * that does not fit it is a `peer_error`. It knows nothing of which nodes exist:
 * who to call, and at which address, is the node object's business.
 */
export class HttpPeerClient {
  constructor(
    private readonly identity: NodeIdentity,
    /** The workgroup key behind the proof of every request (§7.1). */
    private readonly key: Buffer,
    private readonly workgroupId: WorkgroupId,
    private readonly options: PeerClientOptions,
  ) {}

  /** Signed JSON request; resolves with the 2xx body, parsed by `request.reply`, and who signed it. */
  async call<S extends z.ZodType>(
    endpoint: string,
    { method, path, payload, reply: schema, label = path }: JsonRequest<S>,
    options: CallOptions,
  ): Promise<Answer<z.output<S>>> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const url = new URL(path, endpoint);
    const nonce = newNonce();
    const headers: Record<string, string> = {
      authorization: this.authorization(method, url, options.target, nonce, body),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The deadline covers the whole answer, body included.
    const reply = await this.withDeadline(label, options, async (signal) => {
      const init: RequestInit & { duplex: "half" } = {
        method,
        headers,
        body,
        duplex: "half",
        // A redirect would carry a signed request to an address nobody vetted.
        redirect: "manual",
        signal,
      };
      const response = await this.options.fetch(url, init);
      const bytes = await HttpPeerClient.readCapped(label, response);
      const from = this.signedBy(label, response, options.target, {
        nonce,
        status: response.status,
        subject: bodySha256(bytes),
      });
      return {
        status: response.status,
        ok: response.ok,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        bytes,
        from,
      };
    });
    if (!reply.ok) throw HttpPeerClient.unwrapError(label, reply);
    // A peer cannot hand us a shape we did not ask for.
    const parsed = parseOrThrow(schema, HttpPeerClient.parseJson(label, reply), (issue) => {
      return new PodError("peer_error", `${label} ${reply.status}: unexpected reply: ${describeIssue(issue)}`, 502);
    });
    return { body: parsed, from: reply.from };
  }

  /**
   * Signed `GET` of a file a member published, streamed: no response cap, and the
   * deadline covers the answer only, not the transfer. The reply's signature
   * covers its status and the file's name, not its bytes, which are not known
   * before the first one arrives; the caller checks them against the sha256 the
   * file is named by. A failed reply is the same typed error as for `call`.
   */
  async download(endpoint: string, blobId: string, call: CallOptions): Promise<Download> {
    const path = `/blobs/${blobId}`;
    const url = new URL(path, endpoint);
    const nonce = newNonce();
    // The deadline covers the answer, not the transfer: a large file may stream for long.
    return this.withDeadline(path, call, async (signal) => {
      const response = await this.options.fetch(url, {
        method: "GET",
        headers: { authorization: this.authorization("GET", url, call.target, nonce) },
        redirect: "manual",
        signal,
      });
      const subject = response.ok ? `blob:${blobId}` : undefined;
      if (!response.ok || response.body === null) {
        const bytes = await HttpPeerClient.readCapped(path, response);
        const from = this.signedBy(path, response, call.target, {
          nonce,
          status: response.status,
          subject: subject ?? bodySha256(bytes),
        });
        throw HttpPeerClient.unwrapError(path, {
          status: response.status,
          ok: false,
          contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
          bytes,
          from,
        });
      }
      this.signedBy(path, response, call.target, { nonce, status: response.status, subject: `blob:${blobId}` });
      const length = response.headers.get("content-length");
      return { body: response.body, size: length === null ? undefined : Number(length) };
    });
  }

  /**
   * Check that a reply was signed by the node it must come from: a known node's
   * answer must be its own, and a first contact takes the signer as the identity.
   */
  private signedBy(
    label: string,
    response: Response,
    target: string,
    fields: { nonce: string; status: number; subject: string },
  ): OrcaNodeId {
    const signer = verifyReplyHeader(response.headers.get(REPLY_HEADER), fields);
    if (signer === null) {
      throw new PodError("peer_error", `${label} ${response.status}: the reply is not signed by its sender`, 502);
    }
    if (target !== "" && signer !== target) {
      throw new PodError("peer_error", `${label}: the reply was signed by ${signer}, but ${target} was addressed`, 502);
    }
    return signer;
  }

  /**
   * Run one outbound exchange under the call's deadline, fused with the
   * caller's own cancellation (DSH's `deadline`). A deadline that elapses is
   * reported as `peer_timeout`; a caller's abort keeps its own error.
   */
  private async withDeadline<T>(
    label: string,
    call: CallOptions,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const limit = deadline(call.signal, call.timeoutMs ?? this.options.timeoutMs, PEER_TIMEOUT);
    try {
      return await work(limit.signal);
    } catch (error) {
      const timeout = timeoutOf(limit.signal, PEER_TIMEOUT);
      if (timeout !== undefined)
        throw new PodError("peer_timeout", `${label}: no answer within ${timeout.timeoutMs} ms`);
      throw error;
    } finally {
      limit[Symbol.dispose]();
    }
  }

  /** The two proofs of one request: bound to the node it is addressed to, the workgroup, and the body when there is one. */
  private authorization(method: HttpMethod, url: URL, target: string, nonce: string, body?: string): string {
    return buildAuthHeader({
      identity: this.identity,
      key: this.key,
      workgroupId: this.workgroupId,
      method,
      url: `${url.pathname}${url.search}`,
      targetOrcaNodeId: target,
      nonce,
      body,
    });
  }

  /**
   * Read at most `MAX_RESPONSE_BYTES`: the stream is cancelled as soon as the cap
   * is crossed, so a peer cannot make us buffer what `response.text()` would.
   */
  private static async readCapped(label: string, response: Response): Promise<Buffer> {
    const tooLarge = (): PodError =>
      new PodError("peer_error", `${label} ${response.status}: response body is too large`, 502);
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const bytes = await readAll(response.body ?? [], MAX_RESPONSE_BYTES);
    if (bytes === null) throw tooLarge();
    return bytes;
  }

  /** A 2xx body parsed as JSON. */
  private static parseJson(label: string, reply: Reply): unknown {
    if (!reply.contentType.includes("application/json")) {
      throw new PodError(
        "peer_error",
        `${label} ${reply.status}: unexpected content type ${reply.contentType || "none"}`,
        502,
      );
    }
    try {
      return JSON.parse(reply.bytes.toString("utf8")) as unknown;
    } catch {
      throw new PodError("peer_error", `${label} ${reply.status}: response is not valid JSON`, 502);
    }
  }

  /** The typed error of a failed reply. */
  private static unwrapError(label: string, reply: Reply): PodError {
    let body: ErrorReply | undefined;
    try {
      const parsed = ErrorReplySchema.safeParse(JSON.parse(reply.bytes.toString("utf8")));
      body = parsed.success ? parsed.data : undefined;
    } catch {
      // A non-JSON error page keeps the generic code.
    }
    return remoteError(label, reply.status, body);
  }
}
