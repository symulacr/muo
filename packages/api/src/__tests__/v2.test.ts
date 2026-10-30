import { describe, expect, test } from "bun:test";

import type { Hex } from "@muo/core/native";
import { TESTNET_CORE } from "@muo/core/native";
import { computeAssertionId } from "@muo/utils/native";

import app, { readCappedBody } from "../app";
import { toNativeAssertion, V2_MAX_LIMIT } from "../routes/v2";

const CHAIN = 31611;
const CORE = TESTNET_CORE;
const IDENT = `0x${"11".repeat(32)}` as Hex;
const CLAIM = "0xdeadbeef" as Hex;
const ACTOR = "0x2a2a8551e30c63263dd9dbb698e57fb37c77a6b3" as Hex;
const ID = computeAssertionId(IDENT, CLAIM, 10n, 1440n, 100n);
const HASH = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** Minimal D1 double that answers the exact queries the v2 routes issue. */
const makeEnv = (
  opts: {
    rows?: Record<string, unknown>[];
    cursor?: Record<string, unknown> | null;
    counts?: { assertions: number; logs: number };
    env?: Record<string, string>;
  } = {}
) => {
  const db = {
    prepare(sql: string) {
      const stmt = {
        _sql: sql,
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async all<T>() {
          if (sql.includes('from "mezo_assertions"')) return { results: (opts.rows ?? []) as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          if (sql.includes('from "mezo_indexer_cursor"')) return (opts.cursor ?? null) as T | null;
          if (sql.includes("as assertions")) {
            const c = opts.counts ?? { assertions: 0, logs: 0 };
            return { assertions: c.assertions, logs: c.logs } as T;
          }
          if (sql.trim() === "select 1") return { 1: 1 } as T;
          return null;
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
  };
  return {
    MUO_DB: db,
    WEBHOOK_SECRET: "webhook-secret",
    CHAINHOOKS_SECRET: "chainhooks-secret",
    MUO_CORE_CONTRACT: CORE,
    MEZO_CHAIN_ID: String(CHAIN),
    MEZO_CORE_ADDRESS: CORE,
    MEZO_RPC_URL: "https://rpc.invalid.example",
    INDEXER_ADMIN_SECRET: "admin-secret",
    ...opts.env,
  } as never;
};

const row = (over: Record<string, unknown> = {}) => ({
  chain_id: CHAIN,
  core_address: CORE,
  assertion_id: ID,
  identifier: IDENT,
  claim: CLAIM,
  bond_musd: "10",
  liveness: 1440,
  status: "open",
  asserter: ACTOR,
  disputer: null,
  settler: null,
  resolver: null,
  asserted_at_block: 100,
  asserted_tx_id: HASH(1),
  disputed_at_block: null,
  disputed_tx_id: null,
  settled_at_block: null,
  settled_tx_id: null,
  resolved_at_block: null,
  resolved_tx_id: null,
  block_number: 100,
  block_hash: HASH(2),
  transaction_index: 0,
  log_index: 0,
  ...over,
});

describe("toNativeAssertion", () => {
  test("maps a stored row to the native wire shape", () => {
    const a = toNativeAssertion(row() as never);
    expect(a).toMatchObject({ id: ID, bondMusd: "10", chainId: CHAIN, coreAddress: CORE, blockNumber: 100 });
    expect(typeof a.bondMusd).toBe("string");
  });

  test("rejects a row with a numeric bond", () => {
    expect(() => toNativeAssertion(row({ bond_musd: 10 }) as never)).toThrow();
  });

  test("rejects a row with a bond below the 10 MUSD floor", () => {
    expect(() => toNativeAssertion(row({ bond_musd: "9" }) as never)).toThrow();
  });

  test("rejects a row with an unprefixed id", () => {
    expect(() => toNativeAssertion(row({ assertion_id: ID.slice(2) }) as never)).toThrow();
  });

  test("rejects a row with an unknown status", () => {
    expect(() => toNativeAssertion(row({ status: "SETTLED" }) as never)).toThrow();
  });

  test("rejects a row whose chainId is not a Mezo chain", () => {
    expect(() => toNativeAssertion(row({ chain_id: 1 }) as never)).toThrow();
  });

  test("rejects a row with an extra unexpected field shape", () => {
    expect(() => toNativeAssertion(row({ liveness: 0 }) as never)).toThrow();
  });
});

describe("GET /v2/assertions", () => {
  test("returns native rows for the configured namespace", async () => {
    const res = await app.request("/v2/assertions", {}, makeEnv({ rows: [row()] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0]).toMatchObject({ id: ID, bondMusd: "10" });
    expect("bondSats" in (body[0] ?? {})).toBe(false);
  });

  test("is 503, not an empty 200, when the native namespace is unconfigured", async () => {
    const env = makeEnv({ env: { MEZO_CHAIN_ID: "", MEZO_CORE_ADDRESS: "" } });
    const res = await app.request("/v2/assertions", {}, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "native_index_not_configured" });
  });

  test("rejects an out-of-range limit", async () => {
    for (const limit of ["0", "-1", "1.5", "abc", String(V2_MAX_LIMIT + 1)]) {
      const res = await app.request(`/v2/assertions?limit=${limit}`, {}, makeEnv());
      expect(res.status).toBe(400);
    }
  });

  test("rejects a negative, fractional or empty offset", async () => {
    for (const off of ["-1", "1.5", "abc", ""]) {
      const res = await app.request(`/v2/assertions?offset=${off}`, {}, makeEnv());
      expect(res.status).toBe(400);
    }
  });

  test("serves a 500, not a plausible row, when a stored row is invalid", async () => {
    const res = await app.request("/v2/assertions", {}, makeEnv({ rows: [row({ bond_musd: "9" })] }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "stored_row_invalid" });
  });

  test("applies CORS to /v2/* and answers preflight", async () => {
    const env = makeEnv({ env: { CORS_ORIGINS: "https://ok.example" } });
    const ok = await app.request("/v2/assertions", { headers: { Origin: "https://ok.example" } }, env);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://ok.example");
    const bad = await app.request("/v2/assertions", { headers: { Origin: "https://evil.example" } }, env);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app.request("/v2/assertions", { method: "OPTIONS", headers: { Origin: "https://ok.example" } }, env);
    expect(pre.status).toBe(204);
  });

  test("native reads are non-cacheable: Cache-Control: no-store", async () => {
    const res = await app.request("/v2/assertions", {}, makeEnv({ rows: [row()] }));
    // Native assertion/status reads are financial state; a stale body would
    // show `open` for an already-disputed assertion.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("carries the security headers", async () => {
    const res = await app.request("/v2/assertions", {}, makeEnv({ rows: [row()] }));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
  });
});

describe("GET /v2/status", () => {
  test("reports never_run honestly when there is no cursor", async () => {
    const res = await app.request("/v2/status", {}, makeEnv({ cursor: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("never_run");
    expect(body.cursor).toBeNull();
  });

  test("reports no_events, not ok, when a cursor exists but zero logs were indexed", async () => {
    const res = await app.request(
      "/v2/status",
      {},
      makeEnv({
        cursor: {
          block_number: 16_380_473,
          block_hash: HASH(9),
          log_index: -1,
          version: 0,
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          updated_at: 1,
        },
        counts: { assertions: 0, logs: 0 },
      })
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("no_events");
    expect((body.counts as { appliedLogs: number }).appliedLogs).toBe(0);
  });

  test("reports error when the cursor carries a last_error", async () => {
    const res = await app.request(
      "/v2/status",
      {},
      makeEnv({
        cursor: {
          block_number: 16_380_500,
          block_hash: HASH(9),
          log_index: 2,
          version: 3,
          lease_owner: "x",
          lease_expires_at: 1,
          last_error: "decode failed",
          updated_at: 1,
        },
        counts: { assertions: 1, logs: 2 },
      })
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("error");
    expect(body.lastError).toBe("decode failed");
  });

  test("reports ok when logs are indexed and no error is recorded", async () => {
    const res = await app.request(
      "/v2/status",
      {},
      makeEnv({
        cursor: {
          block_number: 16_380_600,
          block_hash: HASH(9),
          log_index: 2,
          version: 5,
          lease_owner: null,
          lease_expires_at: null,
          last_error: null,
          updated_at: 1,
        },
        counts: { assertions: 2, logs: 4 },
      })
    );
    expect(((await res.json()) as Record<string, unknown>).state).toBe("ok");
  });

  test("is 503 when unconfigured", async () => {
    const res = await app.request("/v2/status", {}, makeEnv({ env: { MEZO_CHAIN_ID: "" } }));
    expect(res.status).toBe(503);
  });
});

describe("POST /v2/indexer/run", () => {
  test("requires the admin secret", async () => {
    const noAuth = await app.request("/v2/indexer/run", { method: "POST" }, makeEnv());
    expect(noAuth.status).toBe(401);
    const wrong = await app.request("/v2/indexer/run", { method: "POST", headers: { Authorization: "Bearer nope" } }, makeEnv());
    expect(wrong.status).toBe(401);
  });

  test("is 503 when no admin secret is configured", async () => {
    const res = await app.request(
      "/v2/indexer/run",
      { method: "POST", headers: { Authorization: "Bearer admin-secret" } },
      makeEnv({ env: { INDEXER_ADMIN_SECRET: "" } })
    );
    expect(res.status).toBe(503);
  });

  test("rejects a non-empty body: this route takes no caller payload", async () => {
    const res = await app.request(
      "/v2/indexer/run",
      {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "content-type": "application/json" },
        body: JSON.stringify({ logs: [] }),
      },
      makeEnv()
    );
    expect(res.status).toBe(413);
  });
});

describe("readCappedBody", () => {
  test("accepts a body at the cap", async () => {
    const req = new Request("http://x/", { method: "POST", body: "abcd" });
    const out = await readCappedBody(req, 4);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).byteLength).toBe(4);
  });

  test("rejects a body above the cap even with no content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("abcdefgh"));
        c.close();
      },
    });
    const req = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    const out = await readCappedBody(req, 4);
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
    const req = new Request("http://x/", {
      method: "POST",
      body: stream,
      duplex: "half",
      headers: { "content-length": "1" },
    } as RequestInit);
    expect((await readCappedBody(req, 8)) instanceof Response).toBe(true);
  });

  test("returns an empty buffer for a bodyless request", async () => {
    const req = new Request("http://x/", { method: "POST" });
    const out = await readCappedBody(req, 16);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).byteLength).toBe(0);
  });
});
