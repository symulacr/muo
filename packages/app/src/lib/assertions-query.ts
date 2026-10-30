// Server-safe assertion query definition.
//
// Deliberately NOT a "use client" module: `app/page.tsx` is a Server Component and
// prefetches this query. Importing a client-marked module from a Server Component
// throws at runtime ("Attempted to call ... from the server"), so the query
// definition and the fetch live here, and only the React hook lives in the
// client module.

import { queryOptions } from "@tanstack/react-query";
import * as z from "zod/mini";

import type { Assertion } from "@muo/core/native";
import { assertionSchema } from "@muo/core/native";

const API_TIMEOUT_MS = 8_000;

export class AssertionsApiError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = "AssertionsApiError";
    this.detail = detail;
  }
}

export type AssertionsPayload = { rows: Assertion[]; rejected: number };

/**
 * Fetches and validates the versioned v2 assertion list.
 *
 * There is deliberately no fallback to a legacy endpoint: a malformed row or an
 * unavailable API raises a visible error instead of rendering an empty list.
 *
 * `cache: "no-store"` is load-bearing, not defensive noise. The API sends
 * `Cache-Control: public, max-age=5, stale-while-revalidate=30`, so a plain
 * `fetch` after an indexer run can be served the PREVIOUS body from the browser
 * HTTP cache for up to 5 seconds. That shows a financial row as `open` while D1
 * already holds `disputed` -- a stale-money display bug, not a DB bug.
 * Assertion state is money-adjacent, so it is always read fresh.
 */
export const fetchAssertions = async (apiBaseUrl: string): Promise<AssertionsPayload> => {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/v2/assertions`, {
      cache: "no-store",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new AssertionsApiError("The assertions service is unreachable.", cause instanceof Error ? cause.message : "Network request failed.");
  }
  if (!response.ok) {
    throw new AssertionsApiError("The assertions service returned an error.", `HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AssertionsApiError("The assertions service returned malformed JSON.", "Response body was not JSON.");
  }

  const envelope = z.object({ data: z.array(z.unknown()) }).safeParse(body);
  const rows = envelope.success ? envelope.data.data : Array.isArray(body) ? (body as unknown[]) : null;
  if (rows === null) {
    throw new AssertionsApiError("The assertions service returned an unexpected payload.", "Expected an array or a { data } envelope.");
  }

  const parsed: Assertion[] = [];
  let rejected = 0;
  for (const row of rows) {
    const result = assertionSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
    else rejected += 1;
  }
  if (rejected > 0 && parsed.length === 0) {
    throw new AssertionsApiError(
      "Every assertion row was rejected by the schema.",
      `${rejected} row(s) failed validation -- the client and service disagree on the wire format.`
    );
  }
  return { rows: parsed, rejected };
};

export const assertionsQueryKey = (apiBaseUrl: string) => ["assertions", "v2", apiBaseUrl] as const;

/**
 * How often an ACTIVE view re-reads the list, in milliseconds.
 *
 * The portal has no push channel: the indexer is an explicit operator action, so
 * the only way a resolved/disputed row reaches an open page is by re-reading.
 * Without this, a page opened before an indexer run keeps showing the pre-index
 * snapshot until the user reloads, which renders stale money state as if it were
 * live. Five seconds bounds that staleness without hammering the API.
 */
export const ASSERTIONS_REFETCH_INTERVAL_MS = 5_000;

/**
 * Base query options. Deliberately contains NO timer and NO polling:
 * `app/page.tsx` is a Server Component and prefetches this, and a server render
 * must never schedule an interval. Polling is attached by the client observer in
 * `useAssertions`, which is the only place a timer is legal.
 */
export const assertionsQuery = (apiBaseUrl: string) =>
  queryOptions({
    queryKey: assertionsQueryKey(apiBaseUrl),
    queryFn: () => fetchAssertions(apiBaseUrl),
    // A focus refetch is a cheap correctness win for a money-adjacent view.
    refetchOnWindowFocus: true,
    // Never poll in the background: a hidden tab must not keep hitting the API.
    refetchIntervalInBackground: false,
  });

/**
 * Options for the ACTIVE view: the shared options plus a bounded poll.
 *
 * Extracted as a pure function so the polling contract can be asserted without
 * rendering React. The hook spreads exactly this, so what the tests pin is what
 * the component actually uses.
 *
 * Note what is NOT here: no `setInterval`, no module state, no subscription. The
 * interval is a plain number that TanStack Query turns into a timer owned by the
 * observer's lifecycle, which is why unmounting the view stops the polling.
 */
export const activeAssertionsQuery = (apiBaseUrl: string) => ({
  ...assertionsQuery(apiBaseUrl),
  refetchInterval: ASSERTIONS_REFETCH_INTERVAL_MS,
});
