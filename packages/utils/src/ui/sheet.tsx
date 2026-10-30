import type * as React from "react";
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { cnx } from "../cn";
import { Button } from "./button";

const SHEET_OVERLAY_BASE =
  "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs";
const SHEET_SLIDE =
  "data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem]";
const SHEET_EDGE =
  "data-[side=bottom]:inset-x-0 data-[side=top]:inset-x-0 data-[side=left]:inset-y-0 data-[side=right]:inset-y-0 data-[side=top]:top-0 data-[side=right]:right-0 data-[side=bottom]:bottom-0 data-[side=left]:left-0 data-[side=bottom]:h-auto data-[side=left]:h-full data-[side=right]:h-full data-[side=top]:h-auto data-[side=left]:w-3/4 data-[side=right]:w-3/4 data-[side=bottom]:border-t data-[side=left]:border-r data-[side=top]:border-b data-[side=right]:border-l data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm";
const SHEET_CONTENT_BASE = `fixed z-50 flex flex-col gap-4 bg-background bg-clip-padding text-sm shadow-lg transition duration-200 ease-in-out ${SHEET_SLIDE} ${SHEET_EDGE} data-ending-style:opacity-0 data-starting-style:opacity-0`;

type SheetContentProps = SheetPrimitive.Popup.Props & { side?: "top" | "right" | "bottom" | "left" };

const Sheet = (props: SheetPrimitive.Root.Props) => <SheetPrimitive.Root data-slot="sheet" {...props} />;
const SheetTrigger = (props: SheetPrimitive.Trigger.Props) => <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
const SheetHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="sheet-header" className={cnx("flex flex-col gap-1.5 p-4", className)} {...props} />
);
const SheetFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="sheet-footer" className={cnx("mt-auto flex flex-col gap-2 p-4", className)} {...props} />
);
const SheetTitle = ({ className, ...props }: SheetPrimitive.Title.Props) => (
  <SheetPrimitive.Title data-slot="sheet-title" className={cnx("font-medium text-foreground", className)} {...props} />
);

function SheetContent({ className, children, side = "right", ...props }: SheetContentProps) {
  return (
    <SheetPrimitive.Portal data-slot="sheet-portal">
      <SheetPrimitive.Backdrop data-slot="sheet-overlay" className={SHEET_OVERLAY_BASE} />
      <SheetPrimitive.Popup data-slot="sheet-content" data-side={side} className={cnx(SHEET_CONTENT_BASE, className)} {...props}>
        {children}
        <SheetPrimitive.Close data-slot="sheet-close" render={<Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger };
