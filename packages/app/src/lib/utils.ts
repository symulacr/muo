import type { Hex } from "@muo/core/native";

import { configuredExplorerUrl } from "@/lib/config";

export { cn } from "@muo/utils/cn";

export function truncate(value: string, head: number, tail: number): string {
  return value.length <= head + tail ? value : `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export const with0x = (value: string): string => (value.startsWith("0x") || value.startsWith("0X") ? `0x${value.slice(2)}` : `0x${value}`);

/** Builds a Mezo explorer transaction URL. Only http(s) bases are accepted. */
export const getTransactionExplorerUrl = (hash: string): string => {
  const base = configuredExplorerUrl().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error("The configured explorer URL must use http(s).");
  const normalized = with0x(hash.replace(/^0x/i, ""));
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("A transaction hash must be 32 bytes.");
  return `${base}/tx/${normalized.toLowerCase()}`;
};

export const formatNumber = (value?: number | null) => (value == null ? undefined : new Intl.NumberFormat().format(value));

export function blocksToHuman(blocks: number, secondsPerBlock = 5): string {
  const totalSeconds = Number.isFinite(blocks) && Number.isFinite(secondsPerBlock) && blocks > 0 ? Math.round(blocks * secondsPerBlock) : 0;
  if (totalSeconds < 60) return `~${totalSeconds}s`;
  if (totalSeconds < 3600) return `~${Math.round(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `~${(totalSeconds / 3600).toFixed(1).replace(/\.0$/, "")}h`;
  return `~${(totalSeconds / 86400).toFixed(1)}d`;
}

export const shortHash = (hash: Hex | string): string => truncate(with0x(hash), 8, 6);
