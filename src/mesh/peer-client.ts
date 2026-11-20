import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { z } from "zod";

import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

import { POD_ERROR_STATUS, PodError, type PodErrorCode } from "../core/errors.ts";
import type { OpenedBlob } from "../core/blobs.ts";
import { readAll } from "../core/stream.ts";
import { buildAuthHeader, bodySha256, newNonce, REPLY_HEADER, verifyReplyHeader } from "../core/signing.ts";
import { parseOrThrow } from "../core/schema.ts";
import type { NodeIdentity } from "../core/identity.ts";
import type { OrcaNodeId, WorkgroupId } from "../core/ids.ts";
import { type Dispatcher, fetch as undiciFetch } from "undici";
import type { PeerTls, TlsRoute } from "./tls.ts";

/** Whether a peer's error code is one this node knows. */
function isPodErrorCode(value: unknown): value is PodErrorCode {
  return typeof value === "string" && Object.hasOwn(POD_ERROR_STATUS, value);
}

/**
 * Read a peer's error leniently: a body we cannot make sense of keeps the
 * generic code. The gateway's `{code, message}` and the same inside a JSON-RPC
 * `error.data` both parse.
 */
const ErrorReplySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({
      message: z.string().optional(),
      data: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
    })
    .optional(),
});
type ErrorReply = z.infer<typeof ErrorReplySchema>;

/**
 * Outbound HTTP: undici's `fetch` in a running node. The `dispatcher` the client
 * passes is what pins the TLS connection to the node addressed (`PeerTls`); a
 * test's fake network ignores it, a test that wraps the real one passes it on.
 */
export type FetchLike = (url: URL, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;

/**
 * undici's own `fetch`, which takes the `PeerTls` dispatchers: the global one
 * belongs to the undici bundled in Node and is not meant to take this package's.
 * The two describe the same Fetch API, so the reply is the global `Response`.
 */
export const nodeFetch: FetchLike = (url, init) =>
  undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

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

/**
 * Deadline of one call unless the caller names its own (§4.7): a peer that
 * accepts the connection and then stalls would otherwise hang a tool call or the
 * tracker.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** A hostile or broken peer must not be able to make us buffer unbounded JSON (§4.7). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The code DSH's `deadline` stamps on an outbound call that ran out of time. */
const PEER_TIMEOUT = "PEER_TIMEOUT";

type Reply = { status: number; ok: boolean; contentType: string; bytes: Buffer; from: OrcaNodeId };

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
    /** Outbound HTTP; tests inject packet loss, delay and partitions. */
    private readonly fetch: FetchLike,
    /** Pins each call's TLS connection to the node it is addressed to (§7.7). */
    private readonly tls: PeerTls,
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
    const route = this.tls.route(options.target);
    // The deadline covers the whole answer, body included.
    const reply = await this.withDeadline(label, options, async (signal) => {
      const init: RequestInit & { duplex: "half"; dispatcher: Dispatcher } = {
        method,
        headers,
        body,
        duplex: "half",
        // A redirect would carry a signed request to an address nobody vetted.
        redirect: "manual",
        signal,
        dispatcher: route.dispatcher,
      };
      const response = await this.fetch(url, init);
      const bytes = await HttpPeerClient.readCapped(label, response);
      const from = this.signedBy(label, response, options.target, {
        nonce,
        status: response.status,
        subject: bodySha256(bytes),
      });
      HttpPeerClient.sameNode(label, route, from);
      return {
        status: response.status,
        ok: response.ok,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        bytes,
        from,
      };
    }).finally(() => route.release());
    if (!reply.ok) throw HttpPeerClient.unwrapError(label, reply.status, reply.bytes);
    // A peer cannot hand us a shape we did not ask for.
    const parsed = parseOrThrow(schema, HttpPeerClient.parseJson(label, reply), (problem) => {
      return new PodError("peer_error", `${label} ${reply.status}: unexpected reply: ${problem}`, 502);
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
  async download(endpoint: string, blobId: string, call: CallOptions): Promise<OpenedBlob> {
    const path = `/blobs/${blobId}`;
    const url = new URL(path, endpoint);
    const nonce = newNonce();
    const route = this.tls.route(call.target);
    // The deadline covers the answer, not the transfer: a large file may stream for long.
    // Releasing a first contact's connection lets the transfer finish before it closes.
    return this.withDeadline(path, call, async (signal) => {
      const response = await this.fetch(url, {
        method: "GET",
        headers: { authorization: this.authorization("GET", url, call.target, nonce) },
        redirect: "manual",
        signal,
        dispatcher: route.dispatcher,
      });
      const { status } = response;
      if (!response.ok || response.body === null) {
        const bytes = await HttpPeerClient.readCapped(path, response);
        const subject = response.ok ? `blob:${blobId}` : bodySha256(bytes);
        this.signedBy(path, response, call.target, { nonce, status, subject });
        throw HttpPeerClient.unwrapError(path, status, bytes);
      }
      const from = this.signedBy(path, response, call.target, { nonce, status, subject: `blob:${blobId}` });
      HttpPeerClient.sameNode(path, route, from);
      const length = response.headers.get("content-length");
      return {
        stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        size: length === null ? undefined : Number(length),
      };
    }).finally(() => route.release());
  }

  /**
   * A first contact's binding (§7.7): the reply must be signed by the node whose
   * key the TLS certificate carried, so whoever answered the handshake is the node
   * that answered the request. A known node's connection was pinned before the
   * request went out; a CA-issued certificate (a proxy) carries no node key.
   */
  private static sameNode(label: string, route: TlsRoute, from: OrcaNodeId): void {
    const presented = route.presented();
    if (presented !== undefined && presented !== from) {
      throw new PodError(
        "peer_error",
        `${label}: the TLS certificate belongs to ${presented}, but the reply is signed by ${from}`,
        502,
      );
    }
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
    const limit = deadline(call.signal, call.timeoutMs ?? REQUEST_TIMEOUT_MS, PEER_TIMEOUT);
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
    return buildAuthHeader(
      this.identity,
      this.key,
      { method, url: `${url.pathname}${url.search}`, body },
      { target, workgroupId: this.workgroupId, ts: Date.now(), nonce },
    );
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

  /** The typed error of a failed reply, for both wire shapes: a peer's code if we know it, else `peer_error`. */
  private static unwrapError(label: string, status: number, bytes: Buffer): PodError {
    let body: ErrorReply | undefined;
    try {
      const parsed = ErrorReplySchema.safeParse(JSON.parse(bytes.toString("utf8")));
      body = parsed.success ? parsed.data : undefined;
    } catch {
      // A non-JSON error page keeps the generic code.
    }
    const data = body?.error?.data ?? body;
    const code = data?.code ?? body?.error?.message;
    const detail = typeof data?.message === "string" && data.message !== code ? ` (${data.message})` : "";
    const shown = typeof code === "string" ? code : `http_${status}`;
    return new PodError(isPodErrorCode(code) ? code : "peer_error", `${label} ${status}: ${shown}${detail}`, status);
  }
}
