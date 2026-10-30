"use client";

import type { MouseEvent } from "react";
import { Alert01Icon, CheckmarkCircle02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

import type { Assertion } from "@muo/core/native";
import { Button } from "@muo/utils/ui/button";
import { SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@muo/utils/ui/sheet";

import type { ResolveResult } from "@/hooks/use-assertion";
import type { TxOutcome } from "@/lib/mezo-tx";
import { useWallet } from "@/components/providers/app-providers";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { AssertionDetail, NodeTrack } from "@/components/verify/assertion-detail";
import { STATUS, StatusBadge } from "@/components/verify/status-badge";
import { useDisputeAssertion, useResolveAssertion, useSettleAssertion } from "@/hooks/use-assertion";
import { claimFromHex } from "@/lib/claim";
import { reportOutcome } from "@/lib/tx-toast";
import { cn, shortHash } from "@/lib/utils";

export const RESOLUTIONS = [
  ["settled", "bg-emerald-600 text-white hover:bg-emerald-600/90"],
  ["rejected", "bg-destructive text-white hover:bg-destructive/90"],
  ["unresolved", "bg-secondary text-secondary-foreground hover:bg-secondary/80"],
] as const satisfies readonly [ResolveResult, string][];

/**
 * Dispute/settle eligibility as a pure function.
 *
 * `blocksLeft >= 0` keeps the window open through the expiry block, matching
 * `MuoCore.isWindowClosed` (`block.number > expiryBlock`). A disconnected or
 * self-matching account can never dispute.
 */
export function disputeWindow(
  assertion: Pick<Assertion, "status" | "assertedAtBlock" | "liveness" | "asserter">,
  currentBlock: number | null,
  address: string | null
) {
  const blocksLeft = currentBlock === null ? null : assertion.assertedAtBlock + assertion.liveness - currentBlock;
  const open = assertion.status === "open" && blocksLeft !== null;
  const isSelf = address !== null && assertion.asserter.toLowerCase() === address.toLowerCase();
  return { blocksLeft, canDispute: open && blocksLeft >= 0 && address !== null && !isSelf, canSettle: open && blocksLeft < 0 };
}

/** Hook wrapper around `disputeWindow` that reads the connected account. */
export function useDisputeWindow(assertion: Assertion, currentBlock: number | null) {
  const { address } = useWallet();
  return disputeWindow(assertion, currentBlock, address);
}

type ActionsProps = { assertion: Assertion; canDispute: boolean; canSettle: boolean; isArbiter: boolean; wide?: boolean };

type ActionItem = { label: string; icon: typeof Alert01Icon; className: string; run: () => Promise<unknown> };

function Actions({ assertion, canDispute, canSettle, isArbiter, wide }: ActionsProps) {
  const dispute = useDisputeAssertion(assertion.id);
  const settle = useSettleAssertion(assertion.id);
  const resolve = useResolveAssertion(assertion.id);
  const TERMINAL = new Set(["confirmed", "failed", "cancelled"]);
  const pending = [dispute, settle, resolve].some((t) => t.state.phase !== null && !TERMINAL.has(t.state.phase));

  const items: ActionItem[] = [];
  if (canDispute) items.push({ label: "Dispute", icon: Alert01Icon, className: "bg-destructive/10 text-destructive", run: () => dispute.mutate() });
  if (canSettle) items.push({ label: "Settle", icon: CheckmarkCircle02Icon, className: "", run: () => settle.mutate() });
  if (isArbiter && assertion.status === "disputed") {
    for (const [r, className] of RESOLUTIONS) {
      items.push({ label: STATUS[r][0], icon: STATUS[r][2], className, run: () => resolve.mutate(r) });
    }
  }

  return items.map(({ label, icon, className, run }) => (
    <Button
      key={label}
      size={wide ? "default" : "sm"}
      className={cn(wide && "w-full", className)}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        void run().then((outcome) => reportOutcome(outcome as TxOutcome));
      }}
    >
      <HugeiconsIcon icon={pending ? Loading03Icon : icon} className={cn("size-4", pending && "animate-spin")} strokeWidth={2} />
      {label}
    </Button>
  ));
}

export function AssertionCard({
  assertion,
  currentBlock,
  isArbiter,
  onOpen,
}: {
  assertion: Assertion;
  currentBlock: number | null;
  isArbiter: boolean;
  onOpen: (id: string) => void;
}) {
  const claimText = useMemo(() => claimFromHex(assertion.claim), [assertion.claim]);
  const { canDispute, canSettle } = useDisputeWindow(assertion, currentBlock);
  return (
    <Card onClick={() => onOpen(assertion.id)} className="cursor-pointer gap-2 py-5 transition-shadow hover:shadow-md">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <StatusBadge status={canSettle ? "awaiting" : assertion.status} />
        <NodeTrack assertion={assertion} currentBlock={currentBlock} />
      </CardHeader>
      <CardContent>
        <p className="line-clamp-2 min-h-10 text-foreground text-sm leading-relaxed lg:line-clamp-1 lg:min-h-fit">{claimText}</p>
      </CardContent>
      {(canDispute || canSettle) && (
        <CardFooter className="gap-2 pt-3">
          <Actions assertion={assertion} canDispute={canDispute} canSettle={canSettle} isArbiter={isArbiter} />
        </CardFooter>
      )}
    </Card>
  );
}

export function AssertionSheet({ assertion, currentBlock, isArbiter }: { assertion: Assertion; currentBlock: number | null; isArbiter: boolean }) {
  const { canDispute, canSettle } = useDisputeWindow(assertion, currentBlock);
  return (
    <SheetContent side="right" className="flex flex-col gap-0 p-0 lg:w-[40vw] lg:max-w-[40vw]!">
      <SheetHeader className="gap-2 border-border border-b px-5 py-4">
        <StatusBadge status={canSettle ? "awaiting" : assertion.status} />
        <SheetTitle className="truncate font-mono font-normal text-muted-foreground text-xs">{shortHash(assertion.id)}</SheetTitle>
      </SheetHeader>
      {currentBlock !== null && <AssertionDetail assertion={assertion} currentBlock={currentBlock} />}
      {(canDispute || canSettle || (isArbiter && assertion.status === "disputed")) && (
        <SheetFooter className="border-border border-t">
          <Actions assertion={assertion} canDispute={canDispute} canSettle={canSettle} isArbiter={isArbiter} wide />
        </SheetFooter>
      )}
    </SheetContent>
  );
}

export type { MouseEvent };
