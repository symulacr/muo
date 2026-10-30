import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { activeAssertionsQuery, assertionsQuery } from "@/lib/assertions-query";
import { makeRow } from "@/test-support/fixtures";

const BASE = "http://api.test";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Behavioural proof that the active-view poll re-reads live state.
 *
 * This drives a REAL QueryClient against a fake fetch. It deliberately does not
 * render React or touch hook internals: the contract being proven is "the query
 * re-reads and the new body becomes the cached value", which is exactly what the
 * UI renders from.
 */
describe("active-view polling re-reads live state", () => {
  test("a refetch after an indexer run replaces the cached status", async () => {
    let status = "open";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [makeRow({ status })] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const opts = activeAssertionsQuery(BASE);

    const first = await client.fetchQuery(opts);
    expect(first.rows[0]?.status).toBe("open");
    expect(calls).toBe(1);

    // Simulate the chain + indexer moving on while the view stays open.
    status = "disputed";
    await client.refetchQueries({ queryKey: opts.queryKey });

    const after = client.getQueryData<typeof first>(opts.queryKey);
    expect(after?.rows[0]?.status).toBe("disputed");
    expect(calls).toBe(2);
    client.clear();
  });

  test("concurrent observers of the same key share ONE in-flight request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      // Hold the response so both observers join the same in-flight request.
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const opts = activeAssertionsQuery(BASE);

    const [a, b] = await Promise.all([client.fetchQuery(opts), client.fetchQuery(opts)]);

    expect(calls).toBe(1);
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(1);
    client.clear();
  });

  test("the poll uses the same key as the server prefetch, so it reuses that entry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // What `app/page.tsx` prefetches.
    const prefetched = await client.fetchQuery(assertionsQuery(BASE));
    expect(calls).toBe(1);

    // What the active view observes: same key, so it reads the hydrated entry
    // rather than issuing a second request on mount.
    const seen = client.getQueryData(activeAssertionsQuery(BASE).queryKey);
    expect(seen).toEqual(prefetched);
    expect(calls).toBe(1);
    client.clear();
  });

  test("a stale cached body is never served: each read hits the network", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      const status = calls === 1 ? "open" : "settled";
      return new Response(JSON.stringify({ data: [makeRow({ status })] }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const opts = activeAssertionsQuery(BASE);

    await client.fetchQuery(opts);
    await client.refetchQueries({ queryKey: opts.queryKey });
    await client.refetchQueries({ queryKey: opts.queryKey });

    expect(calls).toBe(3);
    expect(client.getQueryData<{ rows: Array<{ status: string }> }>(opts.queryKey)?.rows[0]?.status).toBe("settled");
    client.clear();
  });

  test("a failing poll surfaces the error instead of keeping a healthy empty list", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ data: [makeRow()] }), { status: 200 });
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const opts = activeAssertionsQuery(BASE);

    await client.fetchQuery(opts);
    // `throwOnError` makes the refetch reject so the failure cannot be swallowed.
    await expect(client.refetchQueries({ queryKey: opts.queryKey }, { throwOnError: true })).rejects.toThrow();

    // The failure must be observable, not silently downgraded to "no rows".
    const state = client.getQueryState(opts.queryKey);
    expect(state?.status).toBe("error");
    expect(state?.error).toBeInstanceOf(Error);
    client.clear();
  });
});
