import { cn } from "@/lib/utils";

/**
 * Consistent content wrapper for non-map pages: centered max-width, responsive
 * padding, and an optional title/description header block. Map pages render
 * full-bleed and don't use this.
 */
export function PageShell({
  title,
  description,
  actions,
  children,
  className,
  width = "md",
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  width?: "sm" | "md" | "lg";
}) {
  const max =
    width === "sm" ? "max-w-md" : width === "lg" ? "max-w-5xl" : "max-w-3xl";
  return (
    <main
      className={cn("mx-auto w-full flex-1 px-4 py-8 sm:px-6", max, className)}
    >
      {title ? (
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="font-heading text-2xl font-bold">{title}</h1>
            {description ? (
              <p className="text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children}
    </main>
  );
}
