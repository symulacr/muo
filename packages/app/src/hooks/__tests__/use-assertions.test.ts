import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Assertion } from "@muo/core/native";

import { AssertionsApiError, fetchAssertions } from "@/hooks/use-assertions";
import { makeRow } from "@/test-support/fixtures";

const BASE = "http://api.test";

const originalFetch = globalThis.fetch;
const setFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  globalThis.fetch = impl as unknown as typeof fetch;
};

beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("v2 assertions client", () => {
  test("requests the versioned v2 endpoint", async () => {
    let seen = "";
    setFetch(async (url) => {
      seen = url;
      return new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 });
    });
    await fetchAssertions(BASE);
    expect(seen).toBe(`${BASE}/v2/assertions`);
  });

  test("parses a { data } envelope of valid rows", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 }));
    const payload = await fetchAssertions(BASE);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rejected).toBe(0);
    expect((payload.rows[0] as Assertion).bondMusd).toBe("10");
  });

  test("accepts a bare array body", async () => {
    setFetch(async () => new Response(JSON.stringify([makeRow()]), { status: 200 }));
    expect((await fetchAssertions(BASE)).rows).toHaveLength(1);
  });

  test("never falls back to a legacy endpoint", async () => {
    const seen: string[] = [];
    setFetch(async (url) => {
      seen.push(url);
      return new Response("nope", { status: 404 });
    });
    await expect(fetchAssertions(BASE)).rejects.toThrow();
    expect(seen).toEqual([`${BASE}/v2/assertions`]);
  });

  test("surfaces a non-2xx response as a visible error", async () => {
    setFetch(async () => new Response("{}", { status: 500 }));
    await expect(fetchAssertions(BASE)).rejects.toBeInstanceOf(AssertionsApiError);
  });

  test("surfaces malformed JSON as a visible error", async () => {
    setFetch(async () => new Response("not json", { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow(/malformed JSON/i);
  });

  test("surfaces an unexpected payload shape", async () => {
    setFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow(/unexpected payload/i);
  });

  test("surfaces a network failure as a visible error", async () => {
    setFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchAssertions(BASE)).rejects.toThrow(/unreachable/i);
  });

  test("rejects every row when the whole payload is schema-invalid", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [{ bogus: true }] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow(/rejected by the schema/i);
  });

  test("keeps valid rows and counts rejected ones", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow(), { bogus: true }] }), { status: 200 }));
    const payload = await fetchAssertions(BASE);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rejected).toBe(1);
  });

  test("rejects a legacy bondSats row rather than coercing it", async () => {
    const legacy = makeRow({ bondSats: 10000 });
    delete legacy.bondMusd;
    setFetch(async () => new Response(JSON.stringify({ data: [legacy] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow(/rejected by the schema/i);
  });

  test("rejects a bond below the 10 MUSD floor", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ bondMusd: "9" })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("rejects a float bond", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ bondMusd: "10.5" })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("rejects an unknown chain id", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ chainId: 1 })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("rejects a checksummed address", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ asserter: "0x111111111111111111111111111111111111111A" })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("rejects extra writable fields", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ extra: 1 })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("rejects a bad status value", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ status: "pending" })] }), { status: 200 }));
    await expect(fetchAssertions(BASE)).rejects.toThrow();
  });

  test("accepts all five statuses", async () => {
    for (const status of ["open", "disputed", "settled", "rejected", "unresolved"]) {
      setFetch(async () => new Response(JSON.stringify({ data: [makeRow({ status })] }), { status: 200 }));
      expect((await fetchAssertions(BASE)).rows).toHaveLength(1);
    }
  });

  test("an empty list is a legitimate empty result, not an error", async () => {
    setFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const payload = await fetchAssertions(BASE);
    expect(payload.rows).toHaveLength(0);
    expect(payload.rejected).toBe(0);
  });
});

// Regression: stale-money reads through the browser HTTP cache.
//
// The API sends `Cache-Control: public, max-age=5, stale-while-revalidate=30`.
// Without an explicit cache directive, a `fetch` issued after an indexer run can
// be answered from the HTTP cache with the PREVIOUS body, so the UI shows a row
// as `open` while D1 already holds `disputed`. These tests pin the fix.
describe("v2 assertions client: cache bypass", () => {
  const captureInit = () => {
    const seen: RequestInit[] = [];
    setFetch(async (_url, init) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 });
    });
    return seen;
  };

  test("requests assertions with cache: no-store", async () => {
    const seen = captureInit();
    await fetchAssertions(BASE);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cache).toBe("no-store");
  });

  test("still sends an explicit JSON accept header", async () => {
    const seen = captureInit();
    await fetchAssertions(BASE);
    expect((seen[0]?.headers as Record<string, string> | undefined)?.accept).toBe("application/json");
  });

  test("keeps the abort timeout so a hung API cannot stall the UI", async () => {
    const seen = captureInit();
    await fetchAssertions(BASE);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("a re-read after a state change is a distinct request, not a cached body", async () => {
    // Two sequential reads must both hit the network layer. With `no-store`
    // the runtime cannot satisfy the second from cache.
    let calls = 0;
    setFetch(async () => {
      calls++;
      const status = calls === 1 ? "open" : "disputed";
      return new Response(JSON.stringify({ data: [makeRow({ status })] }), { status: 200 });
    });

    const first = await fetchAssertions(BASE);
    const second = await fetchAssertions(BASE);

    expect(calls).toBe(2);
    expect(first.rows[0]?.status).toBe("open");
    expect(second.rows[0]?.status).toBe("disputed");
  });
});
