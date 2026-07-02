import { cn } from "@/lib/utils";

/**
 * Mycofest brand mark: a teardrop map pin (the prototype's rotated
 * `border-radius: 50% 50% 50% 0` drop) + wordmark. `wordmark={false}` renders
 * just the mark (e.g. compact mobile header).
 */
export function Logo({
  className,
  wordmark = true,
  size = "md",
}: {
  className?: string;
  wordmark?: boolean;
  size?: "sm" | "md";
}) {
  const dot = size === "sm" ? "size-4" : "size-5";
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        aria-hidden
        className={cn(
          "inline-block -rotate-45 rounded-tl-full rounded-tr-full rounded-br-full border-2 border-foreground/30 bg-[var(--pin-red)]",
          dot,
        )}
      />
      {wordmark ? (
        <span
          className={cn(
            "font-heading font-bold tracking-tight",
            size === "sm" ? "text-base" : "text-lg",
          )}
        >
          Mycofest
        </span>
      ) : null}
    </span>
  );
}
