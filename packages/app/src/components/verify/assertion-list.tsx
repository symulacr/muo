"use client";

import { useCallback, useState } from "react";

import type { Assertion } from "@muo/core/native";
import { Sheet } from "@muo/utils/ui/sheet";

import { useAppConfig, useIsArbiter } from "@/components/providers/app-providers";
import { AssertionCard, AssertionSheet } from "@/components/verify/assertion-card";
import { LiveNode } from "@/components/verify/assertion-detail";
import { useAssertions } from "@/hooks/use-assertions";
import { useMezoBlock } from "@/hooks/use-block";

const EMPTY_CLS =
  "flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 text-balance rounded-lg border-dashed p-12 text-center font-medium text-lg tracking-tight";
const ERROR_CLS = "flex w-full flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-8 text-center";

export function AssertionList() {
  const { config, issues } = useAppConfig();
  const { data: payload, isPending, error, refetch, isFetching } = useAssertions();
  const block = useMezoBlock();
  const { data: isArbiter } = useIsArbiter();
  const [openId, setOpenId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // No monotonic latch: a single overstated height would permanently advance the UI
  // clock and offer Settle before the window really closed on-chain.
  const currentBlock = block.blockNumber;

  const assertions: Assertion[] = payload?.rows ?? [];
  const selected = openId === null ? null : (assertions.find((a) => a.id === openId) ?? null);
  const openSheet = useCallback((id: string) => {
    setOpenId(id);
    setSheetOpen(true);
  }, []);

  if (config === null) {
    return (
      <div role="alert" className={ERROR_CLS}>
        <p className="font-semibold text-destructive">The portal is not configured.</p>
        <ul className="flex flex-col gap-1 text-muted-foreground text-sm">
          {issues.map((issue) => (
            <li key={issue.field}>{issue.message}</li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">Set the public Mezo environment variables, then reload.</p>
      </div>
    );
  }

  // Keyed on the retained error, not on `isError`. A polled query flips back to pending on
  // every refetch, so `isError` held only briefly and the failure panel disappeared.
  if (error !== null && payload === undefined) {
    return (
      <div role="alert" className={ERROR_CLS}>
        <p className="font-semibold text-destructive">The assertions could not be loaded.</p>
        <p className="text-muted-foreground text-sm">{error instanceof Error ? error.message : "Unknown error."}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          disabled={isFetching}
        >
          {isFetching ? "Retrying ..." : "Retry"}
        </button>
      </div>
    );
  }

  return (
    <>
      <LiveNode connected={block.live} block={currentBlock} />
      {block.error && (
        <p role="status" className="mb-3 text-right text-muted-foreground text-xs">
          Block height unavailable: {block.error}
        </p>
      )}
      {payload && payload.rejected > 0 && (
        <p role="status" className="mb-3 text-right text-amber-600 text-xs">
          {payload.rejected} assertion(s) were rejected by the client schema and are not shown.
        </p>
      )}
      {/*
        The active view re-reads the list on an interval, so rows can change under
        the reader. Saying so is the difference between "this is live" and
        silently swapping money state. Kept to one muted line and only shown while
        a background refetch is actually in flight.
      */}
      {isFetching && payload && (
        <p role="status" aria-live="polite" className="mb-3 text-right text-muted-foreground text-xs">
          Updating ...
        </p>
      )}
      {isPending ? null : assertions.length === 0 ? (
        <div data-slot="empty" className={EMPTY_CLS}>
          No assertions
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {assertions.map((a) => (
            <AssertionCard
              key={a.id}
              assertion={a}
              currentBlock={a.status === "open" ? currentBlock : null}
              isArbiter={isArbiter === true}
              onOpen={openSheet}
            />
          ))}
        </div>
      )}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        {selected && <AssertionSheet assertion={selected} currentBlock={currentBlock} isArbiter={isArbiter === true} />}
      </Sheet>
    </>
  );
}
