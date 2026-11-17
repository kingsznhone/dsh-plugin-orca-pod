/**
 * The outbound client contract (§4.7). Callers in `membership/` and
 * `delegation/` hold this interface; `transport/peer-client.ts` implements it.
 * It lives with the wire shapes so the dependency points down: the callers name
 * the reply schema they expect, and a body that does not fit it is a `peer_error`.
 */

import type { z } from "zod";

import type { A2AMethod, A2AParams } from "./a2a.ts";
import type { TaskView } from "./task.ts";

export type HttpMethod = "GET" | "POST";

export type CallOptions = {
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

/** A signed JSON request and the schema its 2xx reply must satisfy. */
export type JsonRequest<S extends z.ZodType> = {
  method: HttpMethod;
  path: string;
  payload?: unknown;
  reply: S;
};

/** A signed raw upload whose sha256 the caller computed first, so the body streams (§5.6). */
export type UploadRequest<S extends z.ZodType> = {
  path: string;
  body: ReadableStream<Uint8Array>;
  sha256: string;
  reply: S;
};

export type PeerClient = {
  /** Node id behind a URL: this node, a URL it dialed, or a member that advertises it. */
  idOf(endpoint: string): string | undefined;
  /** `idOf`, or an `unknown_peer` error: only an explicit join may reach a stranger. */
  known(endpoint: string): string;
  /** Remember that `endpoint` was answered by `nodeId` (a URL it does not advertise). */
  learn(endpoint: string, nodeId: string): void;
  forget(nodeId: string): void;
  /** Signed JSON request; resolves with the 2xx body, parsed by `request.reply`. */
  call<S extends z.ZodType>(endpoint: string, request: JsonRequest<S>, options?: CallOptions): Promise<z.output<S>>;
  /** Signed JSON-RPC call to `/a2a`; every method answers with a task view. */
  rpc<M extends A2AMethod>(endpoint: string, method: M, params: A2AParams<M>, options?: CallOptions): Promise<TaskView>;
  upload<S extends z.ZodType>(endpoint: string, request: UploadRequest<S>, options?: CallOptions): Promise<z.output<S>>;
};
