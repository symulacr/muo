"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@muo/utils/ui/button";

import { AssertDialog } from "@/components/verify/assert-dialog";

const FAB = "max-sm:fixed max-sm:right-6 max-sm:bottom-6 max-sm:size-14 max-sm:rounded-full max-sm:shadow-lg";

export function AssertionsHeader() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-semibold text-2xl text-foreground">Assertions</h1>
        <Button {...{ size: "sm", "aria-label": "Assert", className: FAB, onClick: () => setOpen(true) }}>
          <HugeiconsIcon icon={Add01Icon} className="size-4" strokeWidth={2} />
          <span className="max-sm:sr-only">Assert</span>
        </Button>
      </div>
      <AssertDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
