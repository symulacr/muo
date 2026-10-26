import type { IconSvgElement } from "@hugeicons/react";
import { Alert01Icon, CancelCircleIcon, CheckmarkCircle02Icon, Clock01Icon, HelpCircleIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import type { AssertionStatus } from "@muo/core/native";
import { Badge } from "@muo/utils/ui/badge";

export type Tone = readonly [label: string, chip: string, icon: IconSvgElement, motion: string];
const LIVE = "motion-safe:animate-pulse";
const DRAW = "motion-safe:animate-draw motion-safe:[stroke-dasharray:48] motion-safe:[stroke-dashoffset:48]";
const AMBER = "bg-amber-500/15 text-amber-700 dark:text-amber-400";
const EMERALD = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";

export const STATUS: Record<AssertionStatus | "awaiting", Tone> = Object.assign(Object.create(null), {
  open: ["Open", "bg-primary/15 text-primary", InformationCircleIcon, LIVE],
  disputed: ["Disputed", AMBER, Alert01Icon, DRAW],
  settled: ["Settled", EMERALD, CheckmarkCircle02Icon, DRAW],
  rejected: ["Rejected", "bg-destructive/15 text-destructive", CancelCircleIcon, ""],
  unresolved: ["Unresolved", "bg-muted text-muted-foreground", HelpCircleIcon, ""],
  awaiting: ["Settleable", EMERALD, Clock01Icon, LIVE],
});

export function StatusBadge({ status }: { status: AssertionStatus | "awaiting" }) {
  const [label, chip, icon, motion] = STATUS[status];
  return <Badge className={chip}>{[<HugeiconsIcon key="i" icon={icon} strokeWidth={2} className={motion} />, label]}</Badge>;
}
