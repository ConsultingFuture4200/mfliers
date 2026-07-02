import { cn } from "@/lib/utils";
import type { TargetState } from "@/types/domain";

const BG: Record<TargetState, string> = {
  red: "bg-[var(--pin-red)]",
  amber: "bg-[var(--pin-amber)]",
  green: "bg-[var(--pin-green)]",
};

/**
 * Teardrop map marker (the prototype's `border-radius: 50% 50% 50% 0` drop,
 * rotated) colored by target state. When `flierUrl` is set (a posted/green
 * pin), the campaign flier thumbnail shows inside the drop — the public
 * "flier is live on the pin" affordance (never a player's private photo).
 * Used for HTML markers, the no-map fallback list, and the detail sheet.
 */
export function Pin({
  state,
  flierUrl,
  size = 28,
  className,
}: {
  state: TargetState;
  flierUrl?: string | null;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "relative inline-flex -rotate-45 items-center justify-center rounded-tl-full rounded-tr-full rounded-br-full border-2 border-black/30 shadow-md",
        BG[state],
        className,
      )}
    >
      {flierUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={flierUrl}
          alt=""
          className="size-[70%] rotate-45 rounded-full object-cover"
        />
      ) : (
        <span className="size-[30%] rotate-45 rounded-full bg-white/85" />
      )}
    </span>
  );
}
