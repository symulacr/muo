"use client";

import type { VariantProps } from "class-variance-authority";
import { Copy01Icon, Loading02Icon, Tick02Icon, Wallet01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import type { buttonVariants } from "@muo/utils/ui/button";
import { formatBtcBalance, formatMusdBalance } from "@muo/utils/native";
import { Badge } from "@muo/utils/ui/badge";
import { Button } from "@muo/utils/ui/button";

import { useAppConfig, useIsArbiter, useWallet } from "@/components/providers/app-providers";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useBtcBalance, useMusdBalance } from "@/hooks/use-balances";
import { cn, truncate } from "@/lib/utils";
import { ensureChain, watchMusd } from "@/lib/wallet-eip1193";

type Props = { size?: VariantProps<typeof buttonVariants>["size"] };
export const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
export const seed = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
export const identicon = (n: number) => CELLS.reduce((s, i) => (n & (1 << i) ? `${s}M${i % 3} ${Math.floor(i / 3)}h1v1h-1z` : s), "");

export function AddressBadge({ address, className }: { address: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const n = seed(address);
  return (
    <button
      type="button"
      title={address}
      aria-label={`Copy ${address}`}
      onMouseLeave={() => setCopied(false)}
      onClick={() =>
        void navigator.clipboard.writeText(address).then(
          () => setCopied(true),
          () => setCopied(false)
        )
      }
      className={cn("group inline-flex min-w-0 items-center gap-1.5 rounded-md text-muted-foreground hover:text-foreground", className)}
    >
      <svg viewBox="0 0 3 3" aria-hidden className="size-4 shrink-0 rounded-sm bg-muted">
        <path d={identicon(n)} fill={`hsl(${342 + (n % 42)} 92% 56%)`} />
      </svg>
      <span className="truncate font-mono">{truncate(address, 6, 4)}</span>
      <HugeiconsIcon
        icon={copied ? Tick02Icon : Copy01Icon}
        strokeWidth={2}
        className={copied ? "size-3 shrink-0 text-primary" : "size-3 shrink-0 opacity-0 group-hover:opacity-100"}
      />
    </button>
  );
}

function BalanceCell({ ticker, value, error }: { ticker: string; value?: string; error?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-1 rounded-lg bg-muted/60 px-4 py-3">
      <span className="font-semibold text-[10px] text-muted-foreground uppercase tracking-widest">{ticker}</span>
      <span className={cn("font-medium font-mono text-xl tabular-nums", error && "text-destructive")}>{value ?? "—"}</span>
    </div>
  );
}

function Profile({ size = "default" }: Props) {
  const { disconnect, address, chainId, provider } = useWallet();
  const { config } = useAppConfig();
  const { data: musd, isError: musdError } = useMusdBalance();
  const { data: btc, isError: btcError } = useBtcBalance();
  const { data: isArbiter } = useIsArbiter();
  const [busy, setBusy] = useState<"chain" | "asset" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const wrongChain = config !== null && chainId !== null && chainId !== config.chainId;

  // Both actions are explicit user clicks: the wallet prompts for a custom chain and,
  // separately, for displaying MUSD. Neither runs on page load.
  const addMezo = async () => {
    if (!provider || !config) return;
    setBusy("chain");
    setNotice(null);
    const ok = await ensureChain(provider, config.chainId);
    setNotice(ok ? `Switched to ${config.chainName}.` : `Your wallet did not switch to ${config.chainName}.`);
    setBusy(null);
  };

  const addMusd = async () => {
    if (!provider || !config) return;
    setBusy("asset");
    setNotice(null);
    const ok = await watchMusd(provider, config.musdAddress);
    // EIP-747 returns "request recognised", not "user accepted", so say exactly that.
    setNotice(ok ? "MUSD display request sent to your wallet." : "Your wallet did not accept the MUSD request.");
    setBusy(null);
  };

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button size={size} variant="ghost">
            {address ? <AddressBadge address={address} className="text-foreground" /> : "Wallet"}
          </Button>
        }
      />
      <DialogContent className="min-w-[30vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Wallet
            <Badge variant={wrongChain ? "destructive" : "secondary"} className="capitalize">
              {chainId === null ? "unknown chain" : config?.chainId === chainId ? config.chainName : `chain ${chainId}`}
            </Badge>
            {isArbiter && <Badge>Arbiter</Badge>}
          </DialogTitle>
        </DialogHeader>
        {wrongChain && (
          <p role="alert" className="text-destructive text-sm">
            Switch your wallet to {config?.chainName} to transact.
          </p>
        )}
        <div className="flex gap-2">
          <BalanceCell ticker="MUSD" value={formatMusdBalance(musd)} error={musdError} />
          <BalanceCell ticker="BTC" value={formatBtcBalance(btc)} error={btcError} />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void addMezo()} variant="outline" className="flex-1" disabled={busy !== null}>
            {busy === "chain" ? "Adding Mezo ..." : wrongChain ? "Switch network" : "Add Mezo network"}
          </Button>
          <Button onClick={() => void addMusd()} variant="outline" className="flex-1" disabled={busy !== null || !config}>
            {busy === "asset" ? "Adding MUSD ..." : "Add MUSD token"}
          </Button>
        </div>
        {notice && (
          <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
            {notice}
          </p>
        )}
        <Button onClick={disconnect} variant="destructive" className="w-full">
          Disconnect
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function WalletButton({ size = "default" }: Props) {
  const { connected, connect, connecting, error, wallets } = useWallet();
  if (connected) return <Profile size={size} />;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size={size} className="gap-2 font-medium" onClick={() => void connect()} disabled={connecting}>
        <HugeiconsIcon icon={connecting ? Loading02Icon : Wallet01Icon} strokeWidth={1.5} className={connecting ? "size-4 animate-spin" : "size-4"} />
        {connecting ? "Connecting ..." : "Connect Wallet"}
      </Button>
      {error && (
        <span role="alert" className="max-w-64 text-right text-destructive text-xs">
          {error}
        </span>
      )}
      {!error && wallets.length === 0 && <span className="max-w-64 text-right text-muted-foreground text-xs">No browser wallet detected.</span>}
    </div>
  );
}
