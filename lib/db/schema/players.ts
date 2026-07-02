/**
 * Players. Mirrors `Player` in `types/domain.ts`. Email address is the
 * global login identity across all campaigns (not campaign-scoped itself —
 * `campaign_memberships` is the per-campaign join).
 */
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
});
