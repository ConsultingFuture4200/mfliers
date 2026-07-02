"use client";

/**
 * Sign-out control for the global site header. Client component (Auth.js's
 * `signOut` runs client-side); returns the user to the public landing.
 */
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export default function SignOutButton() {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid="sign-out-button"
      onClick={() => void signOut({ callbackUrl: "/" })}
    >
      Sign out
    </Button>
  );
}
