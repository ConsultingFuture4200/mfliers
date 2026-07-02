"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Light/dark toggle. Guards against hydration mismatch (next-themes resolves
 * the theme only on the client) by rendering a stable placeholder until mounted.
 */
export function ThemeToggle({
  variant = "ghost",
}: {
  variant?: "ghost" | "outline";
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  // Standard next-themes hydration guard: the resolved theme is only known
  // client-side, so mark mounted after the first paint to avoid a mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      aria-label="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted && isDark ? (
        <Sun className="size-4" />
      ) : (
        <Moon className="size-4" />
      )}
    </Button>
  );
}
