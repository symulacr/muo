"use client";

import { Alert01Icon, BitcoinShieldIcon, Blockchain01Icon, CheckmarkCircle02Icon, Clock01Icon, TickDouble02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { useMemo } from "react";

import type { Assertion } from "@muo/core/native";
import { formatBondMusd } from "@muo/utils/native";

import { AddressBadge } from "@/components/wallet-button";
import { claimFromHex } from "@/lib/claim";
import { cn, formatNumber, getTransactionExplorerUrl } from "@/lib/utils";

export const ICONS = [Blockchain01Icon, Alert01Icon, TickDouble02Icon, CheckmarkCircle02Icon] as const;
export const NAMES = ["Asserted", "Disputed", "Resolved", "Settled"] as const;
export const stageOf = (a: Assertion) => (a.settledTxId ? 3 : a.resolvedTxId ? 2 : a.disputedTxId ? 1 : 0);
const ICON_CLS = "size-3.5";

const Bar = ({ pct, overdue }: { pct: number; overdue: boolean }) => (
  <div role="progressbar" aria-label="Liveness" aria-valuenow={Math.round(pct)} className="h-1 overflow-hidden rounded-full bg-border">
    <div className={cn("h-full transition-[width] duration-500", overdue ? "bg-emerald-500" : "bg-primary")} style={{ width: `${pct}%` }} />
  </div>
);

export const LiveNode = ({ connected, block }: { connected: boolean; block: number | null }) => (
  <p className="mb-4 flex items-center justify-end gap-1.5 font-mono text-muted-foreground text-xs tabular-nums">
    <span className={cn("size-1.5 rounded-full", connected ? "animate-pulse bg-primary" : "bg-border")} />
    {block === null ? "—" : `#${formatNumber(block)}`}
    {!connected && <span className="text-muted-foreground/70">(not live)</span>}
  </p>
);

const TxLink = ({ hash, block }: { hash: string; block: number | null }) => {
  let href: string | null = null;
  try {
    href = getTransactionExplorerUrl(hash);
  } catch {
    href = null;
  }
  const label = block === null ? `${hash.slice(0, 10)}…` : `#${formatNumber(block)}`;
  return href ? (
    <Link target="_blank" rel="noopener noreferrer" href={href} className="font-mono text-[10px] text-muted-foreground tabular-nums underline">
      {label}
    </Link>
  ) : (
    <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{label}</span>
  );
};

export function NodeTrack({ assertion: a, currentBlock, detail }: { assertion: Assertion; currentBlock: number | null; detail?: boolean }) {
  const at = stageOf(a);
  const left = currentBlock === null ? null : a.assertedAtBlock + a.liveness - currentBlock;
  const actors = [a.asserter, a.disputer, a.resolver, a.status === "settled" ? a.settler : null];
  const blocks: Array<number | null> = [a.assertedAtBlock, a.disputedAtBlock ?? null, a.resolvedAtBlock ?? null, a.settledAtBlock ?? null];
  const txs: Array<string | null> = [a.assertedTxId, a.disputedTxId ?? null, a.resolvedTxId ?? null, a.settledTxId ?? null];
  return (
    <div className="flex flex-col gap-2">
      <ol role="img" aria-label={`Stage ${at + 1} of 4`} className={cn("flex gap-1", detail && "grid grid-cols-4")}>
        {NAMES.map((name, i) => (
          <li key={name} className={cn("flex flex-col items-center gap-1 text-center", !txs[i] && "opacity-40")}>
            <span
              className={cn(
                "flex items-center justify-center rounded-full",
                detail ? "size-7 border" : "size-1.5",
                i <= at ? (detail ? "border-primary bg-primary/10 text-primary" : "bg-primary") : detail ? "border-border text-muted-foreground" : "bg-border",
                i === at && "animate-pulse"
              )}
            >
              {detail && <HugeiconsIcon icon={ICONS[i]} className="size-4" strokeWidth={2} />}
            </span>
            {detail && (
              <span className="font-medium text-[11px] capitalize leading-none">
                {i === 2 && (a.status === "rejected" || a.status === "unresolved") ? a.status : name}
              </span>
            )}
            {detail && txs[i] && <TxLink hash={txs[i]} block={blocks[i] ?? null} />}
            {detail && actors[i] && <AddressBadge address={actors[i] as string} className="text-[10px]" />}
          </li>
        ))}
      </ol>
      {a.status === "open" && left !== null && a.liveness > 0 && (
        <Bar pct={Math.min(100, Math.max(0, ((a.liveness - left) / a.liveness) * 100))} overdue={left < 0} />
      )}
    </div>
  );
}

export function AssertionDetail({ assertion: a, currentBlock }: { assertion: Assertion; currentBlock: number | null }) {
  const claim = useMemo(() => claimFromHex(a.claim), [a.claim]);
  const left = currentBlock === null ? null : a.assertedAtBlock + a.liveness - currentBlock;
  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
      <blockquote className="border-primary/40 border-l-2 pl-3.5 text-foreground text-sm leading-relaxed">{claim}</blockquote>
      <p className="flex items-center gap-1.5 font-mono text-muted-foreground text-xs tabular-nums">
        <HugeiconsIcon icon={BitcoinShieldIcon} className={ICON_CLS} strokeWidth={1.5} />
        {formatBondMusd(a.bondMusd)} MUSD <span aria-hidden>·</span>
        <HugeiconsIcon icon={Clock01Icon} className={ICON_CLS} strokeWidth={1.5} />
        {formatNumber(a.liveness)} blocks <span aria-hidden>·</span>
        {left === null ? "—" : left >= 0 ? `${formatNumber(left)} left` : "ready"}
      </p>
      <NodeTrack assertion={a} currentBlock={currentBlock} detail />
    </div>
  );
}
