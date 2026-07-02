import { cn } from "@/lib/utils";

/**
 * Bordered stat tile for numbers ($ earned, approved count, coverage). Bold
 * 2px editorial border; label in mono, value in the heading font.
 */
export function StatCard({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border-2 border-foreground/15 bg-card p-4",
        className,
      )}
    >
      <span className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-heading text-2xl font-bold leading-none">
        {value}
      </span>
      {hint ? (
        <span className="text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
}
