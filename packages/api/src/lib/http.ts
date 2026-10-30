// Shared HTTP helpers.
//
// Extracted from `app.ts` so `routes/v2.ts` can use `readCappedBody` without
// importing `app.ts`, which imports `routes/v2.ts`. That cycle worked under Bun
// but is fragile under a bundler's module-init order.

/**
 * Read the request body with a hard byte cap.
 *
 * `Content-Length` is advisory: it is absent on a chunked body and can be
 * omitted or understated by any client. This counts the actual bytes and aborts
 * as soon as the cap is exceeded, so the limit applies to the stream.
 *
 * Returns a `Response` when the cap is exceeded (the caller must return it), or
 * the buffered `Uint8Array` otherwise.
 */
export async function readCappedBody(req: Request, maxBytes: number): Promise<Uint8Array | Response> {
  const tooLarge = () =>
    new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });

  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return tooLarge();
  }
  if (req.body === null) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return tooLarge();
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
