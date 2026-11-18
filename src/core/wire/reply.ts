/** The error body and the acknowledgement both transports answer with (§4.7). */

import { z } from "zod";

/**
 * Read a peer's error leniently: a body we cannot make sense of keeps the
 * generic code. The gateway's `{code, message}` and the same inside a JSON-RPC
 * `error.data` both parse, and so does a 200 reply carrying an `error` envelope.
 */
export const ErrorReplySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  error: z
    .object({
      message: z.string().optional(),
      data: z.object({ code: z.string().optional(), message: z.string().optional() }).optional(),
    })
    .optional(),
});
export type ErrorReply = z.infer<typeof ErrorReplySchema>;

/** A reply that carries only an acknowledgement (leave). */
export const AckSchema = z.object({ ok: z.literal(true) });
