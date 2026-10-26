import type * as React from "react";

import { cn } from "@/lib/utils";

const slot =
  (s: string, base: string) =>
  ({ className, ...props }: React.ComponentProps<"div">) => <div data-slot={s} className={cn(base, className)} {...props} />;
export const Card = slot(
  "card",
  "flex flex-col gap-6 overflow-hidden rounded-xl bg-card py-6 text-card-foreground text-sm shadow-xs ring-1 ring-foreground/10 has-[>img:first-child]:pt-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl"
);
export const CardHeader = slot("card-header", "grid auto-rows-min items-start gap-1 rounded-t-xl px-6 [.border-b]:pb-6");
export const CardContent = slot("card-content", "px-6");
export const CardFooter = slot("card-footer", "flex items-center rounded-b-xl px-6 [.border-t]:pt-6");
