import { cn } from "@/lib/utils";
import type { TargetState } from "@/types/domain";

/**
 * Pill badge for a target's pin state, colored by the shared pin-state tokens.
 * red = Open · amber = Claimed · green = Posted.
 */
const LABELS: Record<TargetState, string> = {
  red: "Open",
  amber: "Claimed",
  green: "Posted",
};

const DOT: Record<TargetState, string> = {
  red: "bg-[var(--pin-red)]",
  amber: "bg-[var(--pin-amber)]",
  green: "bg-[var(--pin-green)]",
};

export function StateBadge({
  state,
  className,
}: {
  state: TargetState;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border-2 border-foreground/15 bg-card px-2.5 py-0.5 text-xs font-medium",
        className,
      )}
    >
      <span className={cn("size-2 rounded-full", DOT[state])} />
      {LABELS[state]}
    </span>
  );
}
