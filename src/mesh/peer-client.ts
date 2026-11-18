import type { z } from "zod";

import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

import { buildAuthHeader } from "../core/signing.ts";
import { describeIssue, parseSchema } from "../core/schema.ts";
import { isPodErrorCode, PodError } from "../core/errors.ts";
import type { NodeIdentity } from "../core/identity.ts";
import { ErrorReplySchema, type ErrorReply } from "../core/wire/reply.ts";
import type { OrcaNodeId, PeerView } from "../core/wire/peer.ts";

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export type HttpMethod = "GET" | "POST";

export type CallOptions = {
  /** Aborts the call; the deadline still applies. */
  signal?: AbortSignal;
  /** Replaces the client's default deadline (heartbeats are shorter). */
  timeoutMs?: number;
  /**
   * Receiver id the signature is bound to (§7.1). Left out, it is the member
   * behind the URL and an unknown URL fails; naming it is for callers that
   * already know which node they are dialing (`""` for a first join).
   */
  target?: string;
};

/** A signed JSON request and the schema its 2xx reply must satisfy. */
export type JsonRequest<S extends z.ZodType> = {
  method: HttpMethod;
  path: string;
  payload?: unknown;
  reply: S;
  /** Names the call in error messages; the path when left out. */
  label?: string;
};

/** A file a peer is sending: its bytes as they arrive, and their count when the peer said it. */
export type Download = { body: ReadableStream<Uint8Array>; size: number | undefined };

/** What the client needs to know about this node: the URLs that reach it. */
export type SelfEndpoints = { readonly endpoints: readonly string[] };

/** What the client needs to know about the mesh: the members and the URLs they advertise. */
export type Roster = { list(): readonly PeerView[] };

/** Knobs of the client that are not collaborators. */
export type PeerClientOptions = {
  fetch: FetchLike;
  /** Deadline of one call unless the caller names its own (§4.7). */
  timeoutMs: number;
};

/** A hostile or broken peer must not be able to make us buffer unbounded JSON (§4.7). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The code DSH's `deadline` stamps on an outbound call that ran out of time. */
const PEER_TIMEOUT = "PEER_TIMEOUT";

/** What one signed request is made of; `body` is JSON text. */
type SignedRequest = {
  /** Names the call in error messages. */
  label: string;
  endpoint: string;
  path: string;
  method: HttpMethod;
  body: string | undefined;
};

type Reply = { status: number; ok: boolean; contentType: string; text: string };

/** One error for both wire shapes: a peer's code if we know it, else `peer_error`. */
export function remoteError(label: string, status: number, body: ErrorReply | undefined): PodError {
  const data = body?.error?.data ?? body;
  const code = data?.code ?? body?.error?.message;
  const detail = typeof data?.message === "string" && data.message !== code ? ` (${data.message})` : "";
  const shown = typeof code === "string" ? code : `http_${status}`;
  return new PodError(isPodErrorCode(code) ? code : "peer_error", `${label} ${status}: ${shown}${detail}`, status);
}

/**
 * The outbound client (§4.7): every request is signed with this node's key,
 * bound to the node it is addressed to, and runs under a deadline. Callers name
 * the reply schema they expect, and a body that does not fit it is a `peer_error`.
 */
export class HttpPeerClient {
  /** URLs this node dialed, which a peer need not advertise (`localhost` vs its LAN address). */
  private readonly dialed = new Map<string, OrcaNodeId>();

  constructor(
    private readonly identity: NodeIdentity,
    /** URLs that reach this node itself; a probe of one of them is signed to its own id. */
    private readonly self: SelfEndpoints,
    /** Members and the URLs they advertise: where an unknown URL is looked up. */
    private readonly roster: Roster,
    private readonly options: PeerClientOptions,
  ) {}

  /** Node id behind a URL: this node, a URL it dialed, or a member that advertises it. */
  idOf(endpoint: string): OrcaNodeId | undefined {
    const key = HttpPeerClient.trimSlash(endpoint);
    if (this.self.endpoints.some((own) => HttpPeerClient.trimSlash(own) === key)) return this.identity.orcaNodeId;
    return (
      this.dialed.get(key) ??
      this.roster.list().find((peer) => peer.endpoints.some((url) => HttpPeerClient.trimSlash(url) === key))
        ?.orca_node_id
    );
  }

  /** `idOf`, or an `unknown_peer` error: only an explicit join may reach a stranger. */
  known(endpoint: string): OrcaNodeId {
    const id = this.idOf(endpoint);
    if (id === undefined) {
      throw new PodError("unknown_peer", `${endpoint} is not a known member; connect to it first`);
    }
    return id;
  }

  /** Remember that `endpoint` was answered by `nodeId` (a URL it does not advertise). */
  learn(endpoint: string, nodeId: OrcaNodeId): void {
    this.dialed.set(HttpPeerClient.trimSlash(endpoint), nodeId);
  }

  forget(nodeId: OrcaNodeId): void {
    for (const [endpoint, id] of this.dialed) if (id === nodeId) this.dialed.delete(endpoint);
  }

  /** Signed JSON request; resolves with the 2xx body, parsed by `request.reply`. */
  async call<S extends z.ZodType>(
    endpoint: string,
    { method, path, payload, reply: schema, label = path }: JsonRequest<S>,
    options: CallOptions = {},
  ): Promise<z.output<S>> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const reply = await this.send({ label, endpoint, path, method, body }, options);
    if (!reply.ok) throw HttpPeerClient.unwrapError(label, reply);
    // A peer cannot hand us a shape we did not ask for.
    const parsed = parseSchema(schema, HttpPeerClient.parseJson(label, reply));
    if (parsed.ok) return parsed.value;
    throw new PodError("peer_error", `${label} ${reply.status}: unexpected reply: ${describeIssue(parsed.issue)}`, 502);
  }

  /**
   * Signed `GET` of a file, streamed: no response cap, and the deadline covers
   * the answer only, not the transfer. A failed reply is the same typed error
   * as for `call`. A file is signed like any call, but neither buffered nor capped.
   */
  async download(endpoint: string, path: string, call: CallOptions = {}): Promise<Download> {
    const target = call.target ?? this.known(endpoint);
    const url = new URL(path, endpoint);
    // The deadline covers the answer, not the transfer: a large file may stream for long.
    return this.withDeadline(path, call, async (signal) => {
      const response = await this.options.fetch(url, {
        method: "GET",
        headers: { authorization: this.authorization("GET", url, target) },
        redirect: "manual",
        signal,
      });
      if (!response.ok || response.body === null) {
        const reply: Reply = {
          status: response.status,
          ok: false,
          contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
          text: await HttpPeerClient.readCapped(path, response),
        };
        throw HttpPeerClient.unwrapError(path, reply);
      }
      const length = response.headers.get("content-length");
      return { body: response.body, size: length === null ? undefined : Number(length) };
    });
  }

  /** Sign, send within the deadline, and read the capped body; interpreting it is the caller's job. */
  private async send(request: SignedRequest, call: CallOptions): Promise<Reply> {
    const { label, endpoint, path, method, body } = request;
    const target = call.target ?? this.known(endpoint);
    const url = new URL(path, endpoint);
    const headers: Record<string, string> = { authorization: this.authorization(method, url, target, body) };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The deadline covers the whole answer, body included.
    return this.withDeadline(label, call, async (signal) => {
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
      return {
        status: response.status,
        ok: response.ok,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        text: await HttpPeerClient.readCapped(label, response),
      };
    });
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
  /** The signature of one request: bound to the node it is addressed to, and to the body when there is one. */
  private authorization(method: HttpMethod, url: URL, target: string, body?: string): string {
    return buildAuthHeader({
      identity: this.identity,
      method,
      url: `${url.pathname}${url.search}`,
      targetOrcaNodeId: target,
      body,
    });
  }

  private static trimSlash(url: string): string {
    return url.replace(/\/+$/, "");
  }

  /**
   * Read at most `MAX_RESPONSE_BYTES`: the stream is cancelled as soon as the cap
   * is crossed, so a peer cannot make us buffer what `response.text()` would.
   */
  private static async readCapped(label: string, response: Response): Promise<string> {
    const tooLarge = (): PodError =>
      new PodError("peer_error", `${label} ${response.status}: response body is too large`, 502);
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw tooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
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
      return JSON.parse(reply.text) as unknown;
    } catch {
      throw new PodError("peer_error", `${label} ${reply.status}: response is not valid JSON`, 502);
    }
  }

  /** The typed error of a failed reply. */
  private static unwrapError(label: string, reply: Reply): PodError {
    let body: ErrorReply | undefined;
    try {
      const parsed = ErrorReplySchema.safeParse(JSON.parse(reply.text));
      body = parsed.success ? parsed.data : undefined;
    } catch {
      // A non-JSON error page keeps the generic code.
    }
    return remoteError(label, reply.status, body);
  }
}
