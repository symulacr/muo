import { createStore } from "mipd";
import { getAddress } from "viem";

import type { Address, MezoChainId } from "@muo/core/native";
import { MEZO_NETWORKS, normalizeAddress } from "@muo/core/native";

/** Minimal EIP-1193 provider surface used by the portal. */
export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
};

export type WalletInfo = {
  /** Stable identifier: the EIP-6963 rdns when available, else the announced uuid. */
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
};

/**
 * Module-scope EIP-6963 store.
 *
 * `createStore()` dispatches `eip6963:requestProvider` and keeps its announce listener
 * for the lifetime of the page, which EIP-6963 requires. Never call `destroy()` here.
 * `reset()` re-requests providers so a wallet injected after load is still discovered.
 */
const store = createStore();

/** Reads a non-EIP-6963 legacy injected provider, if one exists. */
export const readInjectedProvider = (): Eip1193Provider | null => {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { ethereum?: unknown }).ethereum;
  return isProvider(injected) ? injected : null;
};

const isProvider = (v: unknown): v is Eip1193Provider => typeof v === "object" && v !== null && typeof (v as { request?: unknown }).request === "function";

const toWalletInfo = (detail: { info: { uuid: string; name?: string; icon?: string; rdns?: string }; provider: Eip1193Provider }): WalletInfo => ({
  id: detail.info.rdns ?? detail.info.uuid,
  name: detail.info.name ?? "Browser wallet",
  icon: detail.info.icon,
  provider: detail.provider as Eip1193Provider,
});

/** Current wallets: EIP-6963 announcements first, then a single legacy injected provider as failover. */
export const currentWallets = (): WalletInfo[] => {
  const found = store
    .getProviders()
    .filter((d) => isProvider(d.provider))
    .map((d) => toWalletInfo(d as never));
  if (found.length > 0) return found;
  const injected = readInjectedProvider();
  return injected ? [{ id: "injected", name: "Browser wallet", provider: injected }] : [];
};

/**
 * Subscribes to wallet announcements.
 *
 * Returns an unsubscribe function. The underlying EIP-6963 listener deliberately outlives
 * this subscription, so it is safe to call on React cleanup.
 */
export const discoverWallets = (onChange: (wallets: WalletInfo[]) => void): (() => void) => {
  if (typeof window === "undefined") {
    onChange([]);
    return () => {};
  }
  onChange(currentWallets());
  const unsubscribe = store.subscribe(() => onChange(currentWallets()));
  // Re-ask after mount so a provider injected after page load is still picked up.
  store.reset();
  return unsubscribe;
};

export const readChainId = async (provider: Eip1193Provider): Promise<number> => {
  const raw = await provider.request({ method: "eth_chainId" });
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error("The wallet returned an invalid chain id.");
  return Number.parseInt(raw, 16);
};

export const readAccounts = async (provider: Eip1193Provider): Promise<Address[]> => {
  const raw = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(raw)) return [];
  const out: Address[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    try {
      out.push(normalizeAddress(entry));
    } catch {
      // Ignore malformed entries rather than failing the whole session.
    }
  }
  return out;
};

export const requestAccounts = async (provider: Eip1193Provider): Promise<Address[]> => {
  const raw = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(raw)) throw new Error("The wallet did not return an account.");
  const out: Address[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    try {
      out.push(normalizeAddress(entry));
    } catch {
      // Ignore malformed entries.
    }
  }
  return out;
};

/** Reads an EIP-1193 error code, unwrapping MetaMask Mobile's nested `data.originalError`. */
const errorCode = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; data?: { originalError?: { code?: unknown } } };
  if (typeof e.code === "number") return e.code;
  const nested = e.data?.originalError?.code;
  return typeof nested === "number" ? nested : undefined;
};

/** 4902 = chain not added to the wallet yet. Any other failure must not trigger a second prompt. */
const CHAIN_NOT_ADDED = 4902;

/** Adds and/or switches the wallet to the configured Mezo chain. */
export const ensureChain = async (provider: Eip1193Provider, chainId: MezoChainId): Promise<boolean> => {
  const current = await readChainId(provider);
  if (current === chainId) return true;
  const network = MEZO_NETWORKS[chainId];
  const hexChainId = `0x${chainId.toString(16)}`;

  const confirmed = async (): Promise<boolean> => {
    try {
      return (await readChainId(provider)) === chainId;
    } catch {
      return false;
    }
  };

  // A switch that succeeds can still not match: re-read rather than trusting the null result.
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
    return await confirmed();
  } catch (error) {
    // 4001 (user rejected) and everything else must abort here. Only 4902 means "add it first".
    if (errorCode(error) !== CHAIN_NOT_ADDED) return false;
  }

  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexChainId,
          chainName: network.name,
          nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
          rpcUrls: [network.rpcUrl],
          blockExplorerUrls: [network.explorerUrl],
        },
      ],
    });
  } catch {
    return false;
  }

  // Adding does not select the chain (EIP-3085); switch again and confirm.
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChainId }] });
  } catch {
    return false;
  }
  return await confirmed();
};

/** EIP-1193 user rejection (4001). A generic `-32000` is NOT a cancellation. */
export const isUserRejection = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 4001) return true;
  const name = (error as { name?: unknown }).name;
  return name === "UserRejectedRequestError";
};

/**
 * Explicitly registers the Mezo network (EIP-3085). Call this ONLY from a user action:
 * prompting on page load is hostile and wallets warn about it. Adding does not select
 * the chain, so follow with `ensureChain`.
 */
export const addChainToWallet = async (provider: Eip1193Provider, chainId: MezoChainId): Promise<boolean> => {
  const network = MEZO_NETWORKS[chainId];
  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: `0x${chainId.toString(16)}`,
          chainName: network.name,
          nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
          rpcUrls: [network.rpcUrl],
          blockExplorerUrls: [network.explorerUrl],
        },
      ],
    });
    return true;
  } catch {
    return false;
  }
};

/**
 * EIP-747: asks the wallet to DISPLAY an ERC-20 token.
 *
 * Two spec details drive this signature:
 *  - `options.address` MUST be EIP-55 checksummed, so a lowercase config address is
 *    converted here rather than sent raw.
 *  - A `true` result means the wallet RECOGNISED the request, not that the user
 *    accepted or that the token is now listed. Never branch UI on the boolean.
 * It is also a display hint only: the app's own accounting must stay on `eth_call`.
 */
export const watchMusd = async (provider: Eip1193Provider, address: Address, symbol = "MUSD", decimals = 18): Promise<boolean> => {
  try {
    const result = await provider.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: { address: getAddress(address), symbol, decimals } },
    });
    return result === true;
  } catch {
    return false;
  }
};
