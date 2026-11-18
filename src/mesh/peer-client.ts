import { randomUUID } from "node:crypto";

import type { z } from "zod";

import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

import { buildAuthHeader } from "../core/signing.ts";
import { describeIssue, parseSchema } from "../core/schema.ts";
import { isPodErrorCode, PodError } from "../core/errors.ts";
import type { NodeIdentity } from "../core/identity.ts";
import { ErrorReplySchema, type ErrorReply } from "../core/wire/reply.ts";
import { RpcResultSchema } from "../task/wire.ts";
import type { OrcaNodeId, PeerView } from "../core/wire/peer.ts";
import type { A2AMethod, A2AParams, TaskView } from "../task/wire.ts";

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/*
 * The outbound client contract (§4.7): callers name the reply schema they expect,
 * and a body that does not fit it is a `peer_error`.
 */

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
};

/** A file a peer is sending: its bytes as they arrive, and their count when the peer said it. */
export type Download = { body: ReadableStream<Uint8Array>; size: number | undefined };

export type PeerClient = {
  /** Node id behind a URL: this node, a URL it dialed, or a member that advertises it. */
  idOf(endpoint: string): OrcaNodeId | undefined;
  /** `idOf`, or an `unknown_peer` error: only an explicit join may reach a stranger. */
  known(endpoint: string): OrcaNodeId;
  /** Remember that `endpoint` was answered by `nodeId` (a URL it does not advertise). */
  learn(endpoint: string, nodeId: OrcaNodeId): void;
  forget(nodeId: OrcaNodeId): void;
  /** Signed JSON request; resolves with the 2xx body, parsed by `request.reply`. */
  call<S extends z.ZodType>(endpoint: string, request: JsonRequest<S>, options?: CallOptions): Promise<z.output<S>>;
  /** Signed JSON-RPC call to `/a2a`; every method answers with a task view. */
  rpc<M extends A2AMethod>(endpoint: string, method: M, params: A2AParams<M>, options?: CallOptions): Promise<TaskView>;
  /**
   * Signed `GET` of a file, streamed: no response cap, and the deadline covers
   * the answer only, not the transfer. A failed reply is the same typed error
   * as for `call`.
   */
  download(endpoint: string, path: string, options?: CallOptions): Promise<Download>;
};

/** A hostile or broken peer must not be able to make us buffer unbounded JSON (§4.7). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** The code DSH's `deadline` stamps on an outbound call that ran out of time. */
const PEER_TIMEOUT = "PEER_TIMEOUT";

type PeerClientOptions = {
  identity: NodeIdentity;
  fetch: FetchLike;
  /** Deadline of one call unless the caller names its own (§4.7). */
  timeoutMs: number;
  /** URLs that reach this node itself; a probe of one of them is signed to its own id. */
  selfEndpoints: () => readonly string[];
  /** Members and the URLs they advertise: where an unknown URL is looked up. */
  roster: () => readonly PeerView[];
};

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

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/**
 * Read at most `MAX_RESPONSE_BYTES`: the stream is cancelled as soon as the cap
 * is crossed, so a peer cannot make us buffer what `response.text()` would.
 */
async function readCapped(label: string, response: Response): Promise<string> {
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

function parseJson(label: string, reply: Reply): unknown {
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

/** One error for both wire shapes: a peer's code if we know it, else `peer_error`. */
function remoteError(label: string, reply: Reply, body: ErrorReply | undefined): PodError {
  const data = body?.error?.data ?? body;
  const code = data?.code ?? body?.error?.message;
  const detail = typeof data?.message === "string" && data.message !== code ? ` (${data.message})` : "";
  const shown = typeof code === "string" ? code : `http_${reply.status}`;
  return new PodError(
    isPodErrorCode(code) ? code : "peer_error",
    `${label} ${reply.status}: ${shown}${detail}`,
    reply.status,
  );
}

export function createPeerClient(options: PeerClientOptions): PeerClient {
  const selfId = options.identity.orcaNodeId;
  /** URLs this node dialed, which a peer need not advertise (`localhost` vs its LAN address). */
  const dialed = new Map<string, OrcaNodeId>();

  function idOf(endpoint: string): OrcaNodeId | undefined {
    const key = trimSlash(endpoint);
    if (options.selfEndpoints().some((own) => trimSlash(own) === key)) return selfId;
    return (
      dialed.get(key) ??
      options.roster().find((peer) => peer.endpoints.some((url) => trimSlash(url) === key))?.orca_node_id
    );
  }

  function known(endpoint: string): OrcaNodeId {
    const id = idOf(endpoint);
    if (id === undefined) {
      throw new PodError("unknown_peer", `${endpoint} is not a known member; connect to it first`);
    }
    return id;
  }
  /** Sign, send within the deadline, and read the capped body; interpreting it is the caller's job. */
  async function send(request: SignedRequest, call: CallOptions): Promise<Reply> {
    const { label, endpoint, path, method, body } = request;
    const target = call.target ?? known(endpoint);
    const url = new URL(path, endpoint);
    const headers: Record<string, string> = {
      authorization: buildAuthHeader({
        identity: options.identity,
        method,
        url: `${url.pathname}${url.search}`,
        targetOrcaNodeId: target,
        body,
      }),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The deadline covers the whole answer, body included.
    return withDeadline(label, call, async (signal) => {
      const init: RequestInit & { duplex: "half" } = {
        method,
        headers,
        body,
        duplex: "half",
        // A redirect would carry a signed request to an address nobody vetted.
        redirect: "manual",
        signal,
      };
      const response = await options.fetch(url, init);
      return {
        status: response.status,
        ok: response.ok,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        text: await readCapped(label, response),
      };
    });
  }

  /**
   * Run one outbound exchange under the call's deadline, fused with the
   * caller's own cancellation (DSH's `deadline`). A deadline that elapses is
   * reported as `peer_timeout`; a caller's abort keeps its own error.
   */
  async function withDeadline<T>(
    label: string,
    call: CallOptions,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const limit = deadline(call.signal, call.timeoutMs ?? options.timeoutMs, PEER_TIMEOUT);
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

  /** A file, streamed: signed like any call, but neither buffered nor capped. */
  async function download(endpoint: string, path: string, call: CallOptions) {
    const target = call.target ?? known(endpoint);
    const url = new URL(path, endpoint);
    // The deadline covers the answer, not the transfer: a large file may stream for long.
    return withDeadline(path, call, async (signal) => {
      const response = await options.fetch(url, {
        method: "GET",
        headers: {
          authorization: buildAuthHeader({
            identity: options.identity,
            method: "GET",
            url: `${url.pathname}${url.search}`,
            targetOrcaNodeId: target,
          }),
        },
        redirect: "manual",
        signal,
      });
      if (!response.ok || response.body === null) {
        const reply: Reply = {
          status: response.status,
          ok: false,
          contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
          text: await readCapped(path, response),
        };
        throw unwrapError(path, reply);
      }
      const length = response.headers.get("content-length");
      return { body: response.body, size: length === null ? undefined : Number(length) };
    });
  }

  /** The typed error of a failed reply. */
  function unwrapError(label: string, reply: Reply): PodError {
    let body: ErrorReply | undefined;
    try {
      const parsed = ErrorReplySchema.safeParse(JSON.parse(reply.text));
      body = parsed.success ? parsed.data : undefined;
    } catch {
      // A non-JSON error page keeps the generic code.
    }
    return remoteError(label, reply, body);
  }

  /** A 2xx body parsed as JSON, or the typed error of a failed reply. */
  function unwrap(label: string, reply: Reply): unknown {
    if (reply.ok) return parseJson(label, reply);
    throw unwrapError(label, reply);
  }

  /** The 2xx body checked against what the caller expects: a peer cannot hand us a shape we did not ask for. */
  function expectReply<S extends z.ZodType>(label: string, reply: Reply, schema: S, json: unknown): z.output<S> {
    const parsed = parseSchema(schema, json);
    if (parsed.ok) return parsed.value;
    throw new PodError("peer_error", `${label} ${reply.status}: unexpected reply: ${describeIssue(parsed.issue)}`, 502);
  }

  return {
    idOf,
    known,
    learn: (endpoint, nodeId) => void dialed.set(trimSlash(endpoint), nodeId),
    forget(nodeId) {
      for (const [endpoint, id] of dialed) if (id === nodeId) dialed.delete(endpoint);
    },

    async call(endpoint, { method, path, payload, reply: schema }, call = {}) {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const reply = await send({ label: path, endpoint, path, method, body }, call);
      return expectReply(path, reply, schema, unwrap(path, reply));
    },

    async rpc(endpoint, method, params, call = {}) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
      const reply = await send({ label: method, endpoint, path: "/a2a", method: "POST", body }, call);
      const json = unwrap(method, reply);
      // A peer may also answer 200 with an error envelope.
      const envelope = ErrorReplySchema.safeParse(json);
      if (envelope.success && envelope.data.error !== undefined) throw remoteError(method, reply, envelope.data);
      return expectReply(method, reply, RpcResultSchema, json).result;
    },

    download: (endpoint, path, call = {}) => download(endpoint, path, call),
  };
}
