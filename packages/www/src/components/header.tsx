"use client";

import { ArrowUpRight01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { useRef, useState } from "react";

import { Button } from "@muo/utils/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@muo/utils/ui/sheet";

import { NAV_LINKS } from "@/consts/nav";

const Logo = () => (
  <Link href="/" className="flex items-center gap-2">
    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
      <span className="font-bold font-mono text-xs tracking-tighter">MUO</span>
    </div>
    <span className="sr-only">Mezo Upbeat Oracle</span>
  </Link>
);

const NAV_LINK_CLS =
  "flex items-center gap-1 rounded-md px-3 py-1.5 font-medium text-muted-foreground text-sm transition-colors hover:text-muted-foreground/80";
const NavLink = ({ label, href, external, onNavigate }: (typeof NAV_LINKS)[number] & { onNavigate?: (href: string) => void }) => (
  <Link
    {...{
      href,
      target: external ? "_blank" : undefined,
      rel: external ? "noopener noreferrer" : undefined,
      onClick: onNavigate ? () => onNavigate(href) : undefined,
      className: NAV_LINK_CLS,
    }}
  >
    {[label, external && <HugeiconsIcon key="a" icon={ArrowUpRight01Icon} strokeWidth={1.5} className="size-3.5 opacity-50" />]}
  </Link>
);

const links = (onNavigate?: (href: string) => void) =>
  NAV_LINKS.map((link) => <NavLink key={link.href} {...link} onNavigate={link.external ? undefined : onNavigate} />);

export function Header() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<string | null>(null);
  const closeTo = (href: string) => {
    anchor.current = href.slice(1);
    setOpen(false);
  };
  const onDone = (isOpen: boolean) => {
    if (!isOpen && anchor.current) {
      document.getElementById(anchor.current)?.scrollIntoView({ behavior: "smooth" });
      anchor.current = null;
    }
  };
  return (
    <header className="fixed top-0 z-40 w-full bg-transparent backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-1 md:flex">{links()}</nav>
        <Sheet open={open} onOpenChange={setOpen} onOpenChangeComplete={onDone}>
          <SheetTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open menu" className="md:hidden" />}>
            <HugeiconsIcon icon={Menu01Icon} strokeWidth={1.5} className="size-5 text-muted-foreground" />
          </SheetTrigger>
          <SheetContent side="right" className="w-64">
            <SheetHeader className="border-border/60 border-b">
              {[
                <SheetTitle key="t" className="sr-only">
                  Navigation
                </SheetTitle>,
                <Logo key="l" />,
              ]}
            </SheetHeader>
            <nav className="flex flex-col gap-1 px-2 pt-2">{links(closeTo)}</nav>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}
