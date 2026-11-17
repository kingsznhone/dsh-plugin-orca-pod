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

type SchemaError = ReturnType<typeof Value.Errors>[number];

function messageOf(error: SchemaError): string {
  const allowed = (error.params as { allowedValues?: unknown[] }).allowedValues;
  return error.keyword === "enum" && Array.isArray(allowed)
    ? `must be one of ${allowed.map((value) => JSON.stringify(value)).join(", ")}`
    : error.message;
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
  let copy: unknown;
  try {
    copy = structuredClone(raw);
  } catch {
    return { ok: false, issue: { path: [], message: "must be plain data" } };
  }
  const value = Value.Clean(schema, copy);
  if (Value.Check(schema, value)) return { ok: true, value };
  const [first] = Value.Errors(schema, value);
  return {
    ok: false,
    issue:
      first === undefined
        ? { path: [], message: "is invalid" }
        : { path: pointerPath(first.instancePath), message: messageOf(first) },
  };
}

/** `"<path> <message>"`, or the bare message for the value itself. */
export function describeIssue(issue: SchemaIssue): string {
  return issue.path.length === 0 ? issue.message : `${issue.path.join(".")} ${issue.message}`;
}
