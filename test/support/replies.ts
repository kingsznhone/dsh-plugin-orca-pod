import type { NodeIdentity } from "../../src/core/identity.ts";
import { bodySha256, buildReplyHeader, parseAuthHeader } from "../../src/core/signing.ts";

/** The nonce a request carried in its Authorization header: what its reply must be bound to. */
export function nonceOf(init: RequestInit): string {
  const headers = init.headers as Record<string, string>;
  return parseAuthHeader(headers.authorization)?.claim.nonce ?? "";
}

/**
 * A reply to `init` the way an answering node sends it: its body, and the
 * `Pod-Reply` signature over the request's nonce, the status and the body.
 * `signer` is whoever the test lets sign it; `sign` false sends it unsigned.
 */
export function replyTo(
  init: RequestInit,
  signer: NodeIdentity,
  body: string,
  options: { status?: number; contentType?: string; sign?: boolean; nonce?: string; signedBody?: string } = {},
): Response {
  const status = options.status ?? 200;
  const headers: Record<string, string> = { "content-type": options.contentType ?? "application/json" };
  if (options.sign !== false) {
    headers["pod-reply"] = buildReplyHeader(signer, {
      nonce: options.nonce ?? nonceOf(init),
      status,
      subject: bodySha256(options.signedBody ?? body),
    });
  }
  return new Response(body, { status, headers });
}
