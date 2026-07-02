import { cn } from "@/lib/utils";

/**
 * Mono-text pill for meta values (payout tier, counts, coords). Ink surface /
 * paper text — the prototype's monospace badge.
 */
export function Pill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-foreground px-2.5 py-0.5 font-mono text-xs text-background",
        className,
      )}
    >
      {children}
    </span>
  );
}
