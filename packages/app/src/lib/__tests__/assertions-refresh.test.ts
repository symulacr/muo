import { describe, expect, test } from "bun:test";

import { ASSERTIONS_REFETCH_INTERVAL_MS, activeAssertionsQuery, assertionsQuery, assertionsQueryKey } from "@/lib/assertions-query";

const BASE = "http://api.test";

// These tests pin the ACTIVE-VIEW REFRESH CONTRACT as pure options, without
// rendering React or reaching into internals. The hook spreads
// `activeAssertionsQuery`, so what is asserted here is what the component uses.
describe("active-view assertions refresh contract", () => {
  test("the active view polls on a bounded interval once it has data", () => {
    const active = activeAssertionsQuery(BASE);
    expect(typeof active.refetchInterval).toBe("function");
    const int = active.refetchInterval as (q: { state: { data: unknown } }) => number | false;
    expect(int({ state: { data: [] } })).toBe(ASSERTIONS_REFETCH_INTERVAL_MS);
  });

  test("polling STOPS while the query has no data, so a failure panel cannot flicker", () => {
    const int = activeAssertionsQuery(BASE).refetchInterval as (q: { state: { data: unknown } }) => number | false;
    // Every refetch clears `error`; polling a dead API would blank the failure panel.
    expect(int({ state: { data: undefined } })).toBe(false);
  });

  test("the interval is bounded and sane, not a busy loop", () => {
    // A sub-second poll would hammer the API; a multi-minute one would let a
    // resolved row read as live for too long. Pin the order of magnitude.
    expect(ASSERTIONS_REFETCH_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    expect(ASSERTIONS_REFETCH_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });

  test("polling is DISABLED in the background", () => {
    expect(activeAssertionsQuery(BASE).refetchIntervalInBackground).toBe(false);
    expect(assertionsQuery(BASE).refetchIntervalInBackground).toBe(false);
  });

  test("the active view refetches on window focus", () => {
    expect(activeAssertionsQuery(BASE).refetchOnWindowFocus).toBe(true);
  });

  test("the server-safe base options carry NO timer", () => {
    // `app/page.tsx` prefetches these in a Server Component. A timer there would
    // be meaningless at best and a leak at worst, so the base must stay clean.
    const base = assertionsQuery(BASE);
    expect(base.refetchInterval).toBeUndefined();
  });

  test("active and base share ONE query key, so observers coalesce", () => {
    // Same key => one cache entry and one in-flight request, no matter how many
    // observers mount. This is what makes the poll a refetch, not a new query.
    // Spread first: `queryOptions` brands the tuple with a data tag, which is a
    // type-level marker only and must not affect the runtime key.
    expect([...activeAssertionsQuery(BASE).queryKey]).toEqual([...assertionsQuery(BASE).queryKey]);
    expect([...activeAssertionsQuery(BASE).queryKey]).toEqual([...assertionsQueryKey(BASE)]);
  });

  test("different API bases get distinct keys, so environments cannot collide", () => {
    expect(assertionsQueryKey(BASE)).not.toEqual(assertionsQueryKey("http://other.test"));
  });

  test("the query key is namespaced, not a bare URL", () => {
    const key = assertionsQueryKey(BASE);
    expect(key[0]).toBe("assertions");
    expect(key[1]).toBe("v2");
    expect(key).toContain(BASE);
  });

  test("the active view keeps the base queryFn, so the poll still uses no-store", async () => {
    // `queryOptions` wraps the function, so identity is not comparable. Assert the
    // behaviour that matters instead: invoking the active queryFn must still send
    // `cache: "no-store"`. The poll must never silently swap in a cache-friendly fetch.
    const seen: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const active = activeAssertionsQuery(BASE);
      await active.queryFn?.({} as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.cache).toBe("no-store");
    } finally {
      globalThis.fetch = original;
    }
  });

  test("the active view adds ONLY the interval on top of the base", () => {
    const base = assertionsQuery(BASE) as Record<string, unknown>;
    const active = activeAssertionsQuery(BASE) as Record<string, unknown>;
    const added = Object.keys(active).filter((k) => !(k in base));
    expect(added).toEqual(["refetchInterval"]);
  });
});
