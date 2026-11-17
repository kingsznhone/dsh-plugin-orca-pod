import { type PRNG, ulid } from "ulid";

/**
 * Task id: a ULID (48-bit millisecond timestamp + 80 random bits, Crockford base32).
 * Time-ordered, 26 chars, unguessable enough to act as a capability handle (§5.5).
 * The `ulid` package draws the random part from `crypto.getRandomValues`; `prng`
 * exists only so tests can pin it.
 */
export function newTaskId(now: number = Date.now(), prng?: PRNG): string {
  return ulid(now, prng);
}
