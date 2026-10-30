"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { CSSProperties, PropsWithChildren } from "react";
import type { ToasterProps } from "sonner";
import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon, Loading03Icon, MultiplicationSignCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider, useTheme } from "next-themes";
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react";
import { Toaster as Sonner } from "sonner";

import type { Address, MezoChainId } from "@muo/core/native";
import { isAddress, MEZO_CHAIN_IDS } from "@muo/core/native";

import type { AppConfig, ConfigIssue } from "@/lib/config";
import type { Eip1193Provider, WalletInfo } from "@/lib/wallet-eip1193";
import { resolveConfig } from "@/lib/config";
import { getPublicClient } from "@/lib/mezo-client";
import { discoverWallets, ensureChain, isUserRejection, readAccounts, readChainId, requestAccounts } from "@/lib/wallet-eip1193";

export const QUERY_OPTS = { defaultOptions: { queries: { staleTime: 30_000 } } };
let browserQueryClient: QueryClient | undefined;
export const getQueryClient = () => {
  if (typeof window === "undefined") return new QueryClient(QUERY_OPTS);
  browserQueryClient ??= new QueryClient(QUERY_OPTS);
  return browserQueryClient;
};

export type WalletContextType = {
  wallets: readonly WalletInfo[];
  walletId: string | null;
  provider: Eip1193Provider | null;
  address: Address | null;
  chainId: MezoChainId | null;
  connected: boolean;
  connecting: boolean;
  /** Present when the last connect attempt failed; cleared on a successful connect. */
  error: string | null;
  connect: (walletId?: string) => Promise<boolean>;
  disconnect: () => void;
};

export const WalletContext = createContext<WalletContextType | null>(null);
export const useWallet = (): WalletContextType => {
  const value = use(WalletContext);
  if (!value) throw new Error("useWallet must be used within AppProviders");
  return value;
};

export type ConfigContextType = { config: AppConfig | null; issues: readonly ConfigIssue[]; ready: boolean };
export const ConfigContext = createContext<ConfigContextType | null>(null);
export const useAppConfig = (): ConfigContextType => {
  const value = use(ConfigContext);
  if (!value) throw new Error("useAppConfig must be used within AppProviders");
  return value;
};

/** Config that is guaranteed valid, for components that cannot act without it. */
export const useRequiredConfig = (): AppConfig | null => {
  const { config } = useAppConfig();
  return config;
};

function WalletProvider({ children }: PropsWithChildren) {
  const { config } = useAppConfig();
  const [wallets, setWallets] = useState<readonly WalletInfo[]>([]);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<MezoChainId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => discoverWallets((next) => setWallets(next)), []);

  const disconnect = useCallback(() => {
    setWalletId(null);
    setProvider(null);
    setAddress(null);
    setChainId(null);
    setError(null);
  }, []);

  const connect = useCallback(
    async (requestedId?: string) => {
      if (!config) {
        setError("The portal is not configured for a Mezo network. Check the public environment variables.");
        return false;
      }
      const target = requestedId ? wallets.find((w) => w.id === requestedId) : (wallets.find((w) => w.id === walletId) ?? wallets[0]);
      if (!target) {
        setError("No browser wallet was detected. Install a Mezo-compatible wallet and reload.");
        return false;
      }
      setConnecting(true);
      setError(null);
      try {
        const accounts = await requestAccounts(target.provider);
        const account = accounts[0];
        if (!account) {
          setError("The wallet did not share an account.");
          return false;
        }
        const switched = await ensureChain(target.provider, config.chainId);
        if (!switched) {
          setError(`Switch your wallet to ${config.chainName} (chain ${config.chainId}) to continue.`);
          return false;
        }
        const liveChainId = await readChainId(target.provider);
        if (liveChainId !== config.chainId) {
          setError(`Your wallet is on chain ${liveChainId}; ${config.chainName} is required.`);
          return false;
        }
        setWalletId(target.id);
        setProvider(target.provider);
        setAddress(account);
        setChainId(config.chainId);
        return true;
      } catch (e) {
        if (isUserRejection(e)) {
          setError(null);
          return false;
        }
        setError(e instanceof Error ? e.message : "The wallet could not connect.");
        return false;
      } finally {
        setConnecting(false);
      }
    },
    [config, wallets, walletId]
  );

  // Keep the session honest: any account/chain change re-reads or clears state.
  useEffect(() => {
    if (!provider) return;
    const onAccountsChanged = (...args: unknown[]) => {
      const next = args[0];
      if (!Array.isArray(next) || next.length === 0) {
        disconnect();
        return;
      }
      const first = next[0];
      setAddress(typeof first === "string" && isAddress(first.toLowerCase()) ? (first.toLowerCase() as Address) : null);
    };
    const onChainChanged = (...args: unknown[]) => {
      const raw = args[0];
      if (typeof raw !== "string") {
        setChainId(null);
        return;
      }
      const parsed = Number.parseInt(raw, 16);
      setChainId(parsed === MEZO_CHAIN_IDS.testnet || parsed === MEZO_CHAIN_IDS.mainnet ? (parsed as MezoChainId) : null);
    };
    const onDisconnect = () => disconnect();

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider, disconnect]);

  // Re-read the account once on mount of a provider, in case the wallet restored a session.
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    void (async () => {
      try {
        const accounts = await readAccounts(provider);
        if (!cancelled && accounts[0]) setAddress(accounts[0]);
      } catch {
        // A wallet that refuses eth_accounts is simply not connected.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const value = useMemo<WalletContextType>(
    () => ({
      wallets,
      walletId,
      provider,
      address,
      chainId,
      connected: address !== null && provider !== null,
      connecting,
      error,
      connect,
      disconnect,
    }),
    [wallets, walletId, provider, address, chainId, connecting, error, connect, disconnect]
  );

  return <WalletContext value={value}>{children}</WalletContext>;
}

export const arbiterQueryKey = (chainId: MezoChainId | null, coreAddress: Address | null, address: Address | null) =>
  ["isArbiter", chainId, coreAddress, address] as const;

/** Reads MuoCore.isArbiter. Errors are surfaced, never silently coerced to `false`. */
export const useIsArbiter = (): UseQueryResult<boolean> => {
  const { config } = useAppConfig();
  const { address, chainId } = useWallet();
  return useQuery<boolean>({
    queryKey: arbiterQueryKey(chainId, config?.coreAddress ?? null, address),
    enabled: Boolean(config && address && chainId === config.chainId),
    retry: 1,
    queryFn: async () => {
      if (!config || !address) return false;
      const { muoCoreAbi } = await import("@muo/core/abi");
      const client = getPublicClient(config.chainId, config.rpcUrl);
      return (await client.readContract({
        address: config.coreAddress,
        abi: muoCoreAbi,
        functionName: "isArbiter",
        args: [address],
      })) as boolean;
    },
  });
};

const STYLE = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--border-radius": "var(--radius)",
} as CSSProperties;
const ic = (icon: typeof Alert02Icon, className = "size-4") => <HugeiconsIcon icon={icon} strokeWidth={2} className={className} />;
const ICONS = {
  success: ic(CheckmarkCircle02Icon),
  info: ic(InformationCircleIcon),
  warning: ic(Alert02Icon),
  error: ic(MultiplicationSignCircleIcon),
  loading: ic(Loading03Icon, "size-4 animate-spin"),
};
const TOAST_OPTS = { classNames: { toast: "cn-toast" } };
function Toaster(props: ToasterProps) {
  const { theme = "light" } = useTheme();
  const t = theme === "dark" || theme === "system" ? theme : "light";
  return <Sonner theme={t} className="toaster group" icons={ICONS} style={STYLE} toastOptions={TOAST_OPTS} {...props} />;
}

function ConfigProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ConfigContextType>({ config: null, issues: [], ready: false });
  useEffect(() => {
    const resolved = resolveConfig();
    setState(resolved.ok ? { config: resolved.config, issues: [], ready: true } : { config: null, issues: resolved.issues, ready: true });
  }, []);
  return <ConfigContext value={state}>{children}</ConfigContext>;
}

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={getQueryClient()}>
      <ThemeProvider attribute="class" disableTransitionOnChange>
        <ConfigProvider>
          <WalletProvider>{children}</WalletProvider>
        </ConfigProvider>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
