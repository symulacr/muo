"use client";

import { useQuery } from "@tanstack/react-query";

import { useAppConfig } from "@/components/providers/app-providers";
import { getPublicClient } from "@/lib/mezo-client";

export const blockQueryKey = (chainId: number | null, rpcUrl: string | null) => ["block", chainId, rpcUrl] as const;

/** How long a block height stays "live" before the UI must stop claiming freshness. */
export const BLOCK_STALE_MS = 30_000;

export type BlockState = {
  blockNumber: number | null;
  /** True only when the last successful read is recent and the query is not erroring. */
  live: boolean;
  error: string | null;
  updatedAt: number | null;
};

/**
 * Polls Mezo block height over HTTP.
 *
 * No WebSocket endpoint is assumed. Errors and staleness are surfaced so the UI can
 * avoid claiming a live connection it does not have.
 */
export const useMezoBlock = (): BlockState => {
  const { config } = useAppConfig();
  const query = useQuery<{ blockNumber: number; at: number }>({
    queryKey: blockQueryKey(config?.chainId ?? null, config?.rpcUrl ?? null),
    enabled: Boolean(config),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: 2,
    queryFn: async () => {
      if (!config) throw new Error("Not configured.");
      const client = getPublicClient(config.chainId, config.rpcUrl);
      const blockNumber = await client.getBlockNumber();
      return { blockNumber: Number(blockNumber), at: Date.now() };
    },
  });

  const updatedAt = query.data?.at ?? null;
  const blockNumber = query.data?.blockNumber ?? null;
  const fresh = updatedAt !== null && Date.now() - updatedAt < BLOCK_STALE_MS;
  const live = !query.isError && blockNumber !== null && fresh;

  return {
    blockNumber,
    live,
    error: query.isError ? (query.error instanceof Error ? query.error.message : "The Mezo RPC did not respond.") : null,
    updatedAt,
  };
};
