// API surface tests: the retired v1 write routes, the preserved historical
// read route, and the HTTP controls that must survive the cutover.
//
// The Clarity/Stacks ingestion tests are gone with the code they tested. What is
// preserved here is the part that still describes real behaviour:
//   - v1 write routes answer 410 with an explicit native pointer (not 404, not
//     401 — a retired endpoint must not imply that a token would work)
//   - the legacy read route still serves rows and is documented as historical
//   - body caps, CORS, security headers and error handling
//
// Native ingestion is covered by ./native-e2e.test.ts (real anvil) and
// ./indexer.test.ts (state machine).

import { describe, expect, test } from "bun:test";

import app, { readCappedBody } from "../app";
import { GONE_BODY } from "../handlers/retired-v1";
import { MAX_BODY_BYTES, MAX_OFFSET } from "../lib/limits";
import { createEnv } from "./d1";

const jsonPost = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

const req = (path: string, init: RequestInit = {}, env = createEnv()) => app.request(path, init, env as never);

describe("retired v1 write routes", () => {
  test.each(["/webhook", "/webhook/chainhooks", "/webhook/indexer"])("%s answers 410 Gone", async (path) => {
    const res = await req(path, jsonPost({}));
    expect(res.status).toBe(410);
  });

  test("the 410 body names the native replacement", async () => {
    const res = await req("/webhook", jsonPost({}));
    expect(await res.json()).toEqual(GONE_BODY);
    expect(GONE_BODY.replacement.read).toBe("GET /v2/assertions");
    expect(GONE_BODY.legacyReadOnly).toBe("GET /assertions");
  });

  test("a retired route answers 410 even WITH a valid-looking bearer", async () => {
    // The endpoint is gone for everyone. Returning 401 here would falsely imply
    // that the right token still works.
    const res = await req("/webhook", jsonPost({}, { Authorization: "Bearer webhook-secret" }));
    expect(res.status).toBe(410);
  });

  test("a retired route answers 410 on GET as well as POST", async () => {
    expect((await req("/webhook/chainhooks")).status).toBe(410);
  });

  test("410 responses carry the security headers", async () => {
    const res = await req("/webhook", jsonPost({}));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });
});

describe("historical read route", () => {
  test("GET /assertions still serves the legacy table", async () => {
    const res = await req("/assertions");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("GET /assertions still rejects a bad offset", async () => {
    for (const off of ["-1", "1.5", "abc", "", String(MAX_OFFSET + 1)]) {
      expect((await req(`/assertions?offset=${off}`)).status).toBe(400);
    }
  });

  test("GET /assertions still applies CORS from the allowlist", async () => {
    const env = createEnv({ sqlite: true, env: { CORS_ORIGINS: "https://ok.example" } });
    const ok = await app.request("/assertions", { headers: { Origin: "https://ok.example" } }, env as never);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://ok.example");
    const bad = await app.request("/assertions", { headers: { Origin: "https://evil.example" } }, env as never);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("GET /assertions answers an OPTIONS preflight", async () => {
    const res = await req("/assertions", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  test("a D1 failure on the read route surfaces as 500 unexpected_error", async () => {
    const env = createEnv();
    (env.MUO_DB as unknown as { prepare: () => never }).prepare = () => {
      throw new Error("d1 unavailable");
    };
    const res = await app.request("/assertions", {}, env as never);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "unexpected_error" });
  });
});

describe("HTTP controls", () => {
  test("GET /health is 200", async () => {
    expect((await req("/health")).status).toBe(200);
  });

  test("an unknown path is 404", async () => {
    expect((await req("/nope")).status).toBe(404);
  });

  test("a trailing slash on /assertions is trimmed", async () => {
    expect((await req("/assertions/")).status).toBe(301);
  });

  test("an oversized declared content-length is 413 before the body is read", async () => {
    const res = await req("/webhook", {
      method: "POST",
      headers: { "content-length": String(MAX_BODY_BYTES + 1) },
      body: "{}",
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the rate limiter answers 429 with Retry-After", async () => {
    const env = createEnv({ env: { RATE_LIMITER: { limit: async () => ({ success: false }) } } });
    const res = await app.request("/assertions", {}, env as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });

  test("429 responses carry the security headers", async () => {
    const env = createEnv({ env: { RATE_LIMITER: { limit: async () => ({ success: false }) } } });
    const res = await app.request("/assertions", {}, env as never);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("every ordinary response carries the three security headers", async () => {
    const res = await req("/health");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("readCappedBody", () => {
  test("accepts a body exactly at the cap", async () => {
    const out = await readCappedBody(new Request("http://x/", { method: "POST", body: "abcd" }), 4);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).byteLength).toBe(4);
  });

  test("rejects a streamed body above the cap with no content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("abcdefgh"));
        c.close();
      },
    });
    const req2 = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const out = await readCappedBody(req2, 4);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(413);
  });

  test("rejects an understated content-length once the stream exceeds the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64));
        c.close();
      },
    });
    const req2 = new Request("http://x/", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "content-length": "1" },
    } as RequestInit);
    expect((await readCappedBody(req2, 8)) instanceof Response).toBe(true);
  });

  test("returns an empty buffer for a bodyless request", async () => {
    const out = await readCappedBody(new Request("http://x/", { method: "POST" }), 16);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).byteLength).toBe(0);
  });
});
