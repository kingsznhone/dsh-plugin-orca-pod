import type { Static, TSchema } from "typebox";
import Value from "typebox/value";

/** Where an input failed its schema (`path` relative to the checked value) and why. */
export type SchemaIssue = { path: string[]; message: string };

function pointerPath(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Parse untrusted input against a TypeBox schema: keys the schema does not
 * describe are dropped from a copy (the caller's value is not touched), then
 * the copy must match. On failure the first issue is reported; for a union
 * that is the mismatch against its first member.
 */
export function parseSchema<T extends TSchema>(
  schema: T,
  raw: unknown,
): { ok: true; value: Static<T> } | { ok: false; issue: SchemaIssue } {
  const value = Value.Clean(schema, structuredClone(raw));
  if (Value.Check(schema, value)) return { ok: true, value };
  const [first] = Value.Errors(schema, value);
  return {
    ok: false,
    issue: { path: pointerPath(first?.instancePath ?? ""), message: first?.message ?? "is invalid" },
  };
}

/** `"<path> <message>"`, or the bare message for the value itself. */
export function describeIssue(issue: SchemaIssue): string {
  return issue.path.length === 0 ? issue.message : `${issue.path.join(".")} ${issue.message}`;
}
