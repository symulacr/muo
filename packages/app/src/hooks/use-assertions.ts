"use client";

import { useQuery } from "@tanstack/react-query";

import { useAppConfig } from "@/components/providers/app-providers";
import { activeAssertionsQuery } from "@/lib/assertions-query";
import { configuredApiBaseUrl } from "@/lib/config";

export type { AssertionsPayload } from "@/lib/assertions-query";
// Re-exported so existing imports keep working; the definitions live in the
// server-safe module so `app/page.tsx` can prefetch them.
export { AssertionsApiError, assertionsQuery, assertionsQueryKey, fetchAssertions } from "@/lib/assertions-query";

/**
 * Subscribes the ACTIVE view to the assertion list and keeps it fresh.
 *
 * Polling is attached HERE, not in `assertionsQuery`, for two reasons:
 *
 *  1. `app/page.tsx` prefetches the same options in a Server Component. A timer
 *     there would be meaningless at best and a leak at worst, so the shared
 *     options stay timer-free and only the client observer opts in.
 *  2. The interval is owned by the observer, so TanStack Query starts it when a
 *     component mounts and stops it on unmount. There is no module-level
 *     `setInterval`, no manual teardown, and nothing to leak.
 *
 * Coalescing and dedup are the library's: this is the SAME query key the
 * prefetch and every other observer use, so concurrent observers share one
 * in-flight request and one cache entry. The interval only ever triggers a
 * refetch of that single entry.
 *
 * `refetchIntervalInBackground: false` (set in the shared options) means a
 * hidden tab stops polling; a background tab must not keep hitting the API.
 */
export const useAssertions = () => {
  const { config } = useAppConfig();
  const base = config?.apiBaseUrl ?? configuredApiBaseUrl();
  // A plain query, not `useSuspenseQuery`: a suspended failure renders the `fallback`
  // (null) forever and leaves the list blank with no error. Plain `useQuery` exposes
  // `isError`, which the list already renders as a retry panel.
  return useQuery(activeAssertionsQuery(base));
};
