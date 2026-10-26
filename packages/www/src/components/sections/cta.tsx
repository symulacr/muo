import Link from "next/link";

import { Button } from "@muo/utils/ui/button";

import { ASSERT_APP_URL, DOCS_URL } from "@/consts/nav";

const BTN = "h-12 rounded-sm px-8 font-mono uppercase tracking-wider";
const PRIMARY = `${BTN} bg-primary-foreground text-primary hover:bg-primary-foreground/90`;
const GHOST = `${BTN} border border-primary-foreground/40 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground`;
const link = (href: string, label: string) => <Link href={href}>{label}</Link>;

export function Cta() {
  return (
    <section
      id="cta"
      aria-label="Get started"
      className="flex min-h-[60vh] scroll-mt-14 flex-col items-center justify-center gap-8 bg-primary px-6 text-center"
    >
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="lg" className={PRIMARY} render={link(ASSERT_APP_URL, "Open app")} />
        <Button size="lg" variant="ghost" className={GHOST} render={link(DOCS_URL, "Read the docs")} />
      </div>
    </section>
  );
}
