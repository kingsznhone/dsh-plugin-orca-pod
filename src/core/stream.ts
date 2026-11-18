/**
 * Everything `source` yields, as one buffer; null as soon as it yields more than
 * `maxBytes`. Stopping at the cap ends the iteration, which cancels the source,
 * so an over-long stream is never buffered whole.
 */
export async function readAll(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
