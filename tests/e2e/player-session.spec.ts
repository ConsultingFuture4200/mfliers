import { expect, test } from "@playwright/test";
import { encode } from "next-auth/jwt";

/**
 * Player session persistence (T2.2 e2e acceptance criterion: "Session
 * principal type is player and persists across a page reload.")
 *
 * This sandbox has no live email provider configured (see `.env.example` —
 * the `RESEND_API_KEY`/`SMTP_*` vars are empty, so `lib/auth/email.ts`
 * falls back to logging the code), so a true end-to-end run through the UI
 * (request an emailed code, read it, type it in, submit) can't happen here.
 * What this test *does* exercise for real: the actual Auth.js session
 * mechanism this app is wired to — `next-auth/jwt`'s `encode`, the exact
 * cookie name/salt Auth.js derives its encryption key from
 * (`authjs.session-token`, per `@auth/core`'s `defaultCookies`), the app's
 * own `/api/auth/session` route (`app/api/auth/[...nextauth]/route.ts` ->
 * `lib/auth/config.ts`), and its `session` callback (`sessionFromToken`).
 * It mints a session token exactly the way a real `player-otp` sign-in
 * would (same encode call, same secret, same salt) rather than stubbing the
 * endpoint, so a regression in cookie handling, the session callback, or
 * route wiring would still fail this test — only the email round-trip is
 * skipped.
 */
test("a player session persists across a page reload", async ({
  page,
  context,
  baseURL,
}) => {
  const secret = process.env.AUTH_SECRET;
  test.skip(!secret, "AUTH_SECRET not configured in this environment");

  const cookieName = "authjs.session-token";
  const playerId = "e2e-test-player-id";

  const value = await encode({
    token: { playerId, principalType: "player", sub: playerId },
    secret: secret!,
    salt: cookieName,
  });

  await context.addCookies([
    {
      name: cookieName,
      value,
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto("/login");

  const before = await page.request.get("/api/auth/session");
  const beforeBody = await before.json();
  expect(beforeBody.principalType).toBe("player");
  expect(beforeBody.playerId).toBe(playerId);

  await page.reload();

  const after = await page.request.get("/api/auth/session");
  const afterBody = await after.json();
  expect(afterBody.principalType).toBe("player");
  expect(afterBody.playerId).toBe(playerId);
});
