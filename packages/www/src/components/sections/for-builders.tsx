"use client";

import { ApartmentIcon, ArrowLeftRightIcon, BitcoinTransactionIcon, Chart01Icon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@muo/utils/ui/tabs";

export const tabs = [
  ["prediction", "Prediction Markets", Chart01Icon, '"Bitcoin spot price exceeded $120,000 before Mezo block 4,500,000 per Skip Connect BTC/USD"'],
  ["defi", "DeFi Protocols", BitcoinTransactionIcon, '"Mezo MUSD/BTC Pool reserves exceeded 10,000,000 MUSD at Mezo block 3,200,000"'],
  ["crosschain", "Cross-Chain", ArrowLeftRightIcon, '"Wormhole NTT bridged 50,000 MUSD from Ethereum tx 0x7f3a...9c2b to Mezo mainnet"'],
  ["insurance", "Insurance", SecurityCheckIcon, '"Trove 0x8C5D...2749 collateral ratio fell below 110% MCR at Mezo block 3,150,400"'],
  ["rwa", "Real-World Assets", ApartmentIcon, '"U.S. Treasury 6-month T-bill yield was 5.27% at auction on March 11, 2026 per TreasuryDirect"'],
] as const;

export function ForBuilders() {
  return (
    <section id="for-builders" aria-label="For builders" className="scroll-mt-14 bg-secondary py-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 sm:px-6">
        <h2 className="font-mono text-muted-foreground text-xs uppercase tracking-wider">For builders</h2>
        <Tabs defaultValue="prediction">
          <TabsList className="mb-10 h-auto! min-h-9 w-full flex-wrap gap-1 py-1">
            {tabs.map(([id, label, icon]) => (
              <TabsTrigger key={id} value={id} className="gap-2 px-4 py-2 font-mono text-xs uppercase tracking-wider">
                <HugeiconsIcon icon={icon} className="size-5 shrink-0" />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {tabs.map(([id, , , claim]) => (
            <TabsContent key={id} value={id} className="grid gap-6">
              <div className="rounded-lg border border-border bg-background/80 px-5 py-4 font-mono text-foreground text-sm leading-relaxed">{claim}</div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </section>
  );
}
