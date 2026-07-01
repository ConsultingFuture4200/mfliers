/**
 * Auth.js catch-all route handler (T2.2). Thin re-export per Auth.js's own
 * App Router convention — no domain logic here (constitution §6); the
 * `player-otp` provider's `authorize()` (which does the real work) lives in
 * `lib/auth/config.ts` -> `lib/auth/player.ts`.
 *
 * This is also the "verify" endpoint the card allows as an alternative to
 * a hand-written `app/api/auth/otp/verify/route.ts`: the client's
 * `signIn("player-otp", { phone, code })` call posts to
 * `/api/auth/callback/player-otp`, served by these handlers.
 */
import { handlers } from "@/lib/auth/config";

export const { GET, POST } = handlers;
