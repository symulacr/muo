"use client";

import Link from "next/link";
import { toast } from "sonner";

import type { TxOutcome } from "@/lib/mezo-tx";
import { describeError } from "@/lib/mezo-errors";
import { getTransactionExplorerUrl, shortHash } from "@/lib/utils";

const POSITION = { position: "top-center" } as const;

const TxLink = ({ hash }: { hash: string }) => {
  let href: string | null = null;
  try {
    href = getTransactionExplorerUrl(hash);
  } catch {
    href = null;
  }
  const label = shortHash(hash);
  return href ? (
    <Link target="_blank" rel="noopener noreferrer" href={href} className="font-mono text-xs underline">
      {label}
    </Link>
  ) : (
    <span className="font-mono text-xs">{label}</span>
  );
};

export const notifyConfirmed = (hash: string) => toast.success("Transaction confirmed.", { ...POSITION, description: <TxLink hash={hash} /> });

/**
 * Reports an uncertain outcome with its hash and an explicit reconciliation prompt.
 * Never claims success and never invites an automatic retry.
 */
export const notifyUncertain = (hash: string, reason: string) =>
  toast.warning("Transaction status is uncertain.", {
    ...POSITION,
    description: (
      <span className="flex flex-col gap-1">
        <span>{reason}</span>
        <span>
          Check the explorer before retrying: <TxLink hash={hash} />
        </span>
      </span>
    ),
    duration: 20_000,
  });

export const notifyFailure = (reason: string) =>
  toast.error(<span className="text-destructive">Transaction failed.</span>, { ...POSITION, description: reason });

export const notifyCancelled = () => toast.info("Transaction cancelled.", { ...POSITION });

/** Maps a TxOutcome to the appropriate toast. Returns true only for confirmed writes. */
export const reportOutcome = (outcome: TxOutcome): boolean => {
  switch (outcome.status) {
    case "confirmed":
      notifyConfirmed(outcome.hash);
      return true;
    case "uncertain":
      notifyUncertain(outcome.hash, outcome.reason);
      return false;
    case "cancelled":
      notifyCancelled();
      return false;
    default:
      notifyFailure(outcome.reason);
      return false;
  }
};

/** Reports a thrown error without leaking calldata or wallet internals. */
export const notifyError = (error: unknown, title = "Something went wrong.") => {
  toast.error(<span className="text-destructive">{title}</span>, { ...POSITION, description: describeError(error) });
};
