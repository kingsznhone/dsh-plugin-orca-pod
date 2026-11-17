import type { z } from "zod";

import { PodError } from "../../kernel/errors.ts";
import { describeIssue, parseSchema } from "../../kernel/schema.ts";

/**
 * Validate one part of a request inside its handler. Routes register no
 * Fastify schema: validation runs after the access policy (`preValidation`),
 * so an unauthenticated caller still learns nothing from a 400, and the
 * parsed value (unknown keys dropped) is what the handler uses.
 */
export function parseInput<T extends z.ZodType>(schema: T, raw: unknown, part: string): z.output<T> {
  const result = parseSchema(schema, raw);
  if (result.ok) return result.value;
  throw new PodError(
    "bad_request",
    `${part}${result.issue.path.length === 0 ? " " : "."}${describeIssue(result.issue)}`,
  );
}
