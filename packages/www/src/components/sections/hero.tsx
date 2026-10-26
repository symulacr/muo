import Link from "next/link";

import { Button } from "@muo/utils/ui/button";

import { ASSERT_APP_URL, DOCS_URL } from "@/consts/nav";

const GRID = {
  backgroundImage: "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
  backgroundSize: "86px 86px",
};
const BTN = "h-12 rounded-sm px-8 font-mono uppercase tracking-wider";
const GHOST = `${BTN} border border-primary/40 text-primary hover:bg-primary/10 hover:text-primary`;
const link = (href: string, label: string) => <Link href={href}>{label}</Link>;

export function Hero() {
  return (
    <section
      id="hero"
      className="relative flex min-h-screen scroll-mt-14 flex-col items-center justify-center gap-8 overflow-hidden bg-zinc-900 px-4 text-center sm:px-6"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.03]" style={GRID} />
      <h1 className="font-bold font-mono text-4xl text-primary tracking-tight sm:text-6xl">Mezo Upbeat Oracle</h1>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" className={BTN} render={link(ASSERT_APP_URL, "Assert a claim")} />
        <Button size="lg" variant="ghost" className={GHOST} render={link(DOCS_URL, "Read the docs")} />
      </div>
    </section>
  );
}
