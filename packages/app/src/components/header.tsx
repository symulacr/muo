"use client";

import { ArrowUpRight01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Button } from "@muo/utils/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@muo/utils/ui/sheet";

import { cn } from "@/lib/utils";

import { WalletButton } from "./wallet-button";

export const NAV_LINKS = [
  { label: "Verify", href: "/", external: false },
  { label: "Docs", href: process.env.NEXT_PUBLIC_DOCS_URL ?? "/docs", external: !!process.env.NEXT_PUBLIC_DOCS_URL },
] as const;

const Logo = () => (
  <Link href="/" className="flex items-center gap-2">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <span className="font-bold font-mono text-xs tracking-tighter">MUO</span>
    </div>
    <span className="sr-only">Mezo Upbeat Oracle</span>
  </Link>
);

function NavLinks({ onClick }: { onClick?: () => void }) {
  const pathname = usePathname();
  return NAV_LINKS.map(({ label, href, external }) => (
    <Link
      key={href}
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-md px-3 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:text-primary/80",
        !external && pathname === href && "text-primary"
      )}
    >
      {label}
      {external && <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={1.5} className="size-3.5 opacity-50" />}
    </Link>
  ));
}

export function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 w-full border-border/60 border-b bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/60">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">
          <NavLinks />
        </nav>
        <div className="hidden md:flex">
          <WalletButton />
        </div>
        <div className="flex items-center gap-2 md:hidden">
          <WalletButton size="sm" />
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open menu" />}>
              <HugeiconsIcon icon={Menu01Icon} strokeWidth={1.5} className="size-5" />
            </SheetTrigger>
            <SheetContent side="right" className="w-64">
              <SheetHeader className="border-border/60 border-b">
                <Logo />
                <SheetTitle className="sr-only">Menu</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-2 pt-2">
                <NavLinks onClick={() => setOpen(false)} />
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
