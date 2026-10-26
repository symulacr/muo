"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { Address, MezoChainId } from "@muo/core/native";
import { musdAbi } from "@muo/core/abi";

import { useAppConfig, useWallet } from "@/components/providers/app-providers";
import { getInjectedPublicClient, getPublicClient } from "@/lib/mezo-client";

export const balancesQueryKey = (chainId: MezoChainId | null, musdAddress: Address | null, address: Address | null) =>
  ["balances", chainId, musdAddress, address] as const;

/**
 * Prefer the wallet's own node so displayed balances match the wallet; fall back to the configured RPC.
 *
 * Memoised: `getInjectedPublicClient` allocates a client, unlike the keyed cache behind
 * `getPublicClient`, so calling it directly in render would build a new client per render.
 */
const useReadClient = () => {
  const { config } = useAppConfig();
  const { provider, chainId } = useWallet();
  const chainIdMatch = config !== null && chainId === config.chainId;
  return useMemo(() => {
    if (!config) return null;
    return chainIdMatch && provider ? getInjectedPublicClient(provider, config.chainId) : getPublicClient(config.chainId, config.rpcUrl);
  }, [config, provider, chainIdMatch]);
};

/** MUSD ERC-20 balance in base units (18 decimals). BigInt end to end. */
export const useMusdBalance = () => {
  const { config } = useAppConfig();
  const { address, chainId } = useWallet();
  const client = useReadClient();
  return useQuery<bigint>({
    queryKey: balancesQueryKey(chainId, config?.musdAddress ?? null, address),
    enabled: Boolean(config && address && chainId === config.chainId && client),
    queryFn: async () => {
      if (!config || !address || !client) throw new Error("Wallet not connected.");
      return (await client.readContract({
        address: config.musdAddress,
        abi: musdAbi,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
    },
  });
};

/** Native BTC balance in wei (18 decimals on Mezo). */
export const useBtcBalance = () => {
  const { config } = useAppConfig();
  const { address, chainId } = useWallet();
  const client = useReadClient();
  return useQuery<bigint>({
    queryKey: [...balancesQueryKey(chainId, null, address), "native"],
    enabled: Boolean(config && address && chainId === config.chainId && client),
    queryFn: async () => {
      if (!address || !client) throw new Error("Wallet not connected.");
      return client.getBalance({ address });
    },
  });
};
