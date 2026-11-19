import type { z } from "zod";

/** A plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse untrusted input against a zod schema. Objects declared with `z.object`
 * drop the keys they do not describe (the result is a new value; the caller's is
 * not touched) and transforms produce the canonical form. On failure `fail`
 * turns the first problem into the error to throw: `"<path> <message>"`, the
 * path starting at `root` when one is given (`body.self.endpoints`), or the bare
 * message when the value itself failed and there is no root.
 */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  fail: (problem: string) => Error,
  root?: string,
): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  const path = [...(root === undefined ? [] : [root]), ...(issue?.path.map(String) ?? [])].join(".");
  const message = issue?.message ?? "is invalid";
  throw fail(path.length === 0 ? message : `${path} ${message}`);
}
