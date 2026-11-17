import type { z } from "zod";

/** Where an input failed its schema (`path` relative to the checked value) and why. */
export type SchemaIssue = { path: string[]; message: string };

/**
 * Parse untrusted input against a zod schema. Objects declared with
 * `z.object` drop the keys they do not describe (the result is a new value;
 * the caller's is not touched), transforms produce the canonical form, and on
 * failure the first issue is reported with its path.
 */
export function parseSchema<T extends z.ZodType>(
  schema: T,
  raw: unknown,
): { ok: true; value: z.output<T> } | { ok: false; issue: SchemaIssue } {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };
  const [first] = result.error.issues;
  return {
    ok: false,
    issue:
      first === undefined
        ? { path: [], message: "is invalid" }
        : { path: first.path.map((segment) => String(segment)), message: first.message },
  };
}

/** `"<path> <message>"`, or the bare message for the value itself. */
export function describeIssue(issue: SchemaIssue): string {
  return issue.path.length === 0 ? issue.message : `${issue.path.join(".")} ${issue.message}`;
}
