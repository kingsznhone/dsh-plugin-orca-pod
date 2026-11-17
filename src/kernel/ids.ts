import { randomBytes } from "node:crypto";

const TASK_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID-shaped task id: 48-bit millisecond timestamp + 80 random bits, base32.
 * Time-ordered, 26 chars, unguessable enough to act as a capability handle (§5.5).
 */
export function newTaskId(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  // `&` on numbers truncates to 32 bits, so mask as a bigint. Shifting the ten
  // random bytes in below the timestamp leaves it in the top 48 bits.
  let value = BigInt(Math.trunc(now)) & 0xffff_ffff_ffffn;
  for (let index = 0; index < 10; index += 1) value = (value << 8n) | BigInt(random[index] ?? 0);
  let out = "";
  for (let index = 0; index < 26; index += 1) {
    out = TASK_ID_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}
