import { createPublicClient, createWalletClient, custom, http } from "viem";
import { mezo, mezoTestnet } from "viem/chains";

import type { Address, MezoChainId } from "@muo/core/native";

import type { Eip1193Provider } from "@/lib/wallet-eip1193";

/** Canonical chain metadata ships with viem; do not hand-roll it (names, RPCs, explorer, multicall3). */
const CHAIN = { 31611: mezoTestnet, 31612: mezo } as const;

/**
 * Read client over the configured public Mezo RPC.
 *
 * Uses plain HTTP polling -- there is no assumed WebSocket endpoint. Created lazily
 * per (chainId, rpcUrl) so a misconfiguration cannot break module evaluation.
 */
const publicClients = new Map<string, ReturnType<typeof createPublicClient>>();

export const getPublicClient = (chainId: MezoChainId, rpcUrl: string) => {
  const key = `${chainId}:${rpcUrl}`;
  const existing = publicClients.get(key);
  if (existing) return existing;
  const client = createPublicClient({
    chain: CHAIN[chainId],
    transport: http(rpcUrl, { timeout: 15_000, retryCount: 2 }),
    pollingInterval: 4_000,
  });
  publicClients.set(key, client);
  return client;
};

/** Write client bound to an injected EIP-1193 provider. */
export const getWalletClient = (provider: Eip1193Provider, chainId: MezoChainId, account: Address) =>
  createWalletClient({ account, chain: CHAIN[chainId], transport: custom(provider) });

/**
 * Read client bound to the wallet's OWN node.
 *
 * Balances read here match what the user sees in their wallet. The configured public
 * RPC can be a different node, so the two can disagree; prefer this whenever a provider
 * is available and fall back to `getPublicClient` otherwise.
 */
export const getInjectedPublicClient = (provider: Eip1193Provider, chainId: MezoChainId) =>
  createPublicClient({ chain: CHAIN[chainId], transport: custom(provider) });

export type PublicClient = ReturnType<typeof getPublicClient>;
