"use client";

/**
 * next-themes provider (class strategy; `.dark` is wired in globals.css via
 * `@custom-variant dark`). Defaults to the system preference; the header menu
 * exposes a manual toggle.
 */
import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
