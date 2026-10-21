import { rateLimits, type DbOrTx } from "@flock/db";
import { sql } from "drizzle-orm";

/**
 * Fixed-window counter in Postgres. Returns true if the action is allowed.
 * One upsert per call; good enough for auth/checkout endpoints at MVP scale.
 */
export async function hitRateLimit(db: DbOrTx, key: string, limit: number, windowMs: number, now = new Date()): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const result = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${rateLimits.windowStart} = ${windowStart.toISOString()}::timestamptz then ${rateLimits.count} + 1 else 1 end`,
        windowStart: sql`${windowStart.toISOString()}::timestamptz`,
      },
    })
    .returning({ count: rateLimits.count });
  return (result[0]?.count ?? 1) <= limit;
}
