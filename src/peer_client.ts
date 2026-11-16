import { randomUUID } from "node:crypto";

import { buildAuthHeader } from "./crypto.ts";
import { isPodErrorCode, PodError } from "./errors.ts";
import type { NodeIdentity } from "./identity.ts";
import type { PeerView } from "./protocol.ts";

/** Same shape as the global `fetch`, so a test can wrap it without a library. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

/** A hostile or broken peer must not be able to make us buffer unbounded JSON (§4.7). */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

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

type CallOptions = {
  /** Aborts the call; the deadline still applies. */
  signal?: AbortSignal;
  /** Replaces the client's default deadline (heartbeats are shorter, uploads longer). */
  timeoutMs?: number;
  /**
   * Receiver id the signature is bound to (§7.1). Left out, it is the member
   * behind the URL and an unknown URL fails; naming it is for callers that
   * already know which node they are dialing (`""` for a first join).
   */
  target?: string;
};

export type PeerClient = {
  /** Node id behind a URL: this node, a URL it dialed, or a member that advertises it. */
  idOf(endpoint: string): string | undefined;
  /** `idOf`, or an `unknown_peer` error: only an explicit join may reach a stranger. */
  known(endpoint: string): string;
  /** Remember that `endpoint` was answered by `nodeId` (a URL it does not advertise). */
  learn(endpoint: string, nodeId: string): void;
  forget(nodeId: string): void;
  /** Signed JSON request; resolves with the parsed 2xx body. */
  call<T>(endpoint: string, method: "GET" | "POST", path: string, payload?: unknown, options?: CallOptions): Promise<T>;
  /** Signed JSON-RPC call to `/a2a`; resolves with `result`. */
  rpc<T>(endpoint: string, method: string, params: unknown, options?: CallOptions): Promise<T>;
  /** Signed raw upload whose sha256 the caller computed first, so the body streams (§5.6). */
  upload<T>(
    endpoint: string,
    path: string,
    body: ReadableStream<Uint8Array>,
    sha256: string,
    options?: CallOptions,
  ): Promise<T>;
};

type Reply = { status: number; ok: boolean; contentType: string; text: string };

const trimSlash = (url: string): string => url.replace(/\/+$/, "");

/** Body of a failed reply: the gateway's `{code, message}`, or the same inside a JSON-RPC `error.data`. */
type ErrorBody = {
  code?: unknown;
  message?: unknown;
  error?: { message?: unknown; data?: { code?: unknown; message?: unknown } };
};

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
function remoteError(label: string, reply: Reply, body: ErrorBody | undefined): PodError {
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
  const dialed = new Map<string, string>();

  function idOf(endpoint: string): string | undefined {
    const key = trimSlash(endpoint);
    if (options.selfEndpoints().some((own) => trimSlash(own) === key)) return selfId;
    return (
      dialed.get(key) ??
      options.roster().find((peer) => peer.endpoints.some((url) => trimSlash(url) === key))?.orca_node_id
    );
  }

  function known(endpoint: string): string {
    const id = idOf(endpoint);
    if (id === undefined) {
      throw new PodError("unknown_peer", `${endpoint} is not a known member; connect to it first`);
    }
    return id;
  }

  /** Sign, send within the deadline, and read the capped body; interpreting it is the caller's job. */
  async function send(
    label: string,
    endpoint: string,
    path: string,
    method: "GET" | "POST",
    body: string | ReadableStream<Uint8Array> | undefined,
    sha256: string | undefined,
    call: CallOptions,
  ): Promise<Reply> {
    const target = call.target ?? known(endpoint);
    const url = new URL(path, endpoint);
    const headers: Record<string, string> = {
      authorization: buildAuthHeader({
        identity: options.identity,
        method,
        url: `${url.pathname}${url.search}`,
        targetOrcaNodeId: target,
        body: typeof body === "string" ? body : undefined,
        bodySha256: sha256,
      }),
    };
    if (typeof body === "string") headers["content-type"] = "application/json";
    if (sha256 !== undefined) {
      headers["content-type"] = "application/octet-stream";
      headers["x-pod-body-sha256"] = sha256;
    }
    const deadline = AbortSignal.timeout(call.timeoutMs ?? options.timeoutMs);
    const init: RequestInit & { duplex: "half" } = {
      method,
      headers,
      body,
      duplex: "half",
      signal: call.signal === undefined ? deadline : AbortSignal.any([deadline, call.signal]),
    };
    const response = await options.fetch(url, init);
    return {
      status: response.status,
      ok: response.ok,
      contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
      text: await readCapped(label, response),
    };
  }

  /** A 2xx body parsed as JSON, or the typed error of a failed reply. */
  function unwrap(label: string, reply: Reply): unknown {
    if (!reply.ok) {
      let body: ErrorBody | undefined;
      try {
        body = JSON.parse(reply.text) as ErrorBody;
      } catch {
        // A non-JSON error page keeps the generic code.
      }
      throw remoteError(label, reply, body);
    }
    return parseJson(label, reply);
  }

  return {
    idOf,
    known,
    learn: (endpoint, nodeId) => void dialed.set(trimSlash(endpoint), nodeId),
    forget(nodeId) {
      for (const [endpoint, id] of dialed) if (id === nodeId) dialed.delete(endpoint);
    },

    async call<T>(endpoint: string, method: "GET" | "POST", path: string, payload?: unknown, call: CallOptions = {}) {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      return unwrap(path, await send(path, endpoint, path, method, body, undefined, call)) as T;
    },

    async rpc<T>(endpoint: string, method: string, params: unknown, call: CallOptions = {}) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params });
      const reply = await send(method, endpoint, "/a2a", "POST", body, undefined, call);
      const envelope = unwrap(method, reply) as ErrorBody & { result: T };
      // A peer may also answer 200 with an error envelope.
      if (envelope.error !== undefined) throw remoteError(method, reply, envelope);
      return envelope.result;
    },

    async upload<T>(
      endpoint: string,
      path: string,
      body: ReadableStream<Uint8Array>,
      sha256: string,
      call: CallOptions = {},
    ) {
      return unwrap(path, await send(path, endpoint, path, "POST", body, sha256, call)) as T;
    },
  };
}
