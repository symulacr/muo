import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { Suspense } from "react";

import { AssertionList } from "@/components/verify/assertion-list";
import { AssertionsHeader } from "@/components/verify/assertions-header";
import { assertionsQuery } from "@/lib/assertions-query";
import { configuredApiBaseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(assertionsQuery(configuredApiBaseUrl())).catch(() => null);
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <AssertionsHeader />
      <Suspense fallback={null}>
        <HydrationBoundary state={dehydrate(queryClient)}>
          <AssertionList />
        </HydrationBoundary>
      </Suspense>
    </main>
  );
}
