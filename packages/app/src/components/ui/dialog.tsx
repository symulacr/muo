import type * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@muo/utils/ui/button";

import { cn } from "@/lib/utils";

const Dialog = (props: DialogPrimitive.Root.Props) => <DialogPrimitive.Root data-slot="dialog" {...props} />;
const DialogTrigger = (props: DialogPrimitive.Trigger.Props) => <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
const DialogHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="dialog-header" className={cn("flex flex-col gap-2", className)} {...props} />
);
const DialogFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
  <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
const DialogTitle = ({ className, ...props }: DialogPrimitive.Title.Props) => (
  <DialogPrimitive.Title data-slot="dialog-title" className={cn("font-medium leading-none", className)} {...props} />
);

const OVERLAY_CLS =
  "data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/10 duration-100 data-closed:animate-out data-open:animate-in supports-backdrop-filter:backdrop-blur-xs";
const CONTENT_CLS =
  "data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 rounded-xl bg-background p-6 text-sm outline-none ring-1 ring-foreground/10 duration-100 data-closed:animate-out data-open:animate-in sm:max-w-md";
function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={OVERLAY_CLS} />
      <DialogPrimitive.Popup data-slot="dialog-content" className={cn(CONTENT_CLS, className)} {...props}>
        {children}
        <DialogPrimitive.Close data-slot="dialog-close" render={<Button variant="ghost" className="absolute top-4 right-4" size="icon-sm" />}>
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger };
