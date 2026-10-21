import { authChallenges, sessions, users, type DbOrTx } from "@flock/db";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { constantTimeEqual, randomToken, sha256 } from "../crypto";
import type { Deps } from "../deps";

export const LOGIN_CHALLENGE_TTL_MS = 10 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const LOGIN_PAYLOAD_PREFIX = "l_";

export interface TelegramProfile {
  id: number;
  username?: string | null;
  firstName: string;
  lastName?: string | null;
}

/** Only allow same-site relative redirect targets. */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (value.length > 512) return null;
  return value;
}

export async function createLoginChallenge(
  deps: Pick<Deps, "db" | "config" | "now">,
  meta: { returnTo?: string | null; ip?: string | null; userAgent?: string | null },
) {
  const token = randomToken();
  const browserSecret = randomToken();
  const expiresAt = new Date(deps.now().getTime() + LOGIN_CHALLENGE_TTL_MS);
  const [row] = await deps.db
    .insert(authChallenges)
    .values({
      tokenHash: sha256(token),
      browserSecretHash: sha256(browserSecret),
      returnTo: safeReturnTo(meta.returnTo),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    })
    .returning({ id: authChallenges.id });
  if (!row) throw new Error("failed to create challenge");
  const payload = `${LOGIN_PAYLOAD_PREFIX}${token}`;
  return {
    challengeId: row.id,
    /** Goes into an HTTP-only cookie: `<challengeId>.<browserSecret>`. */
    browserCookie: `${row.id}.${browserSecret}`,
    deepLink: `https://t.me/${deps.config.telegram.botUsername}?start=${payload}`,
    appLink: `tg://resolve?domain=${deps.config.telegram.botUsername}&start=${payload}`,
    expiresAt,
  };
}

/** Called when the bot receives `/start l_<token>` from an authenticated Telegram user. */
export async function claimLoginChallenge(db: DbOrTx, token: string, telegramUserId: number, now: Date) {
  const [row] = await db
    .update(authChallenges)
    .set({ status: "claimed", claimedByTelegramUserId: telegramUserId })
    .where(and(eq(authChallenges.tokenHash, sha256(token)), eq(authChallenges.status, "pending"), gt(authChallenges.expiresAt, now)))
    .returning({ id: authChallenges.id });
  return row ?? null;
}

export async function upsertTelegramUser(db: DbOrTx, profile: TelegramProfile, opts: { botChatStarted?: boolean } = {}) {
  const [user] = await db
    .insert(users)
    .values({
      telegramUserId: profile.id,
      telegramUsername: profile.username ?? null,
      firstName: profile.firstName,
      lastName: profile.lastName ?? null,
      botChatStarted: opts.botChatStarted ?? false,
    })
    .onConflictDoUpdate({
      target: users.telegramUserId,
      set: {
        telegramUsername: profile.username ?? null,
        firstName: profile.firstName,
        lastName: profile.lastName ?? null,
        ...(opts.botChatStarted ? { botChatStarted: true, botBlockedAt: null } : {}),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!user) throw new Error("failed to upsert user");
  return user;
}

/** Confirm button pressed. Only the Telegram user who claimed the challenge may confirm it. */
export async function confirmLoginChallenge(db: DbOrTx, challengeId: string, profile: TelegramProfile, now: Date) {
  return db.transaction(async (tx) => {
    const user = await upsertTelegramUser(tx, profile, { botChatStarted: true });
    const [row] = await tx
      .update(authChallenges)
      .set({ status: "confirmed", userId: user.id, confirmedAt: now })
      .where(
        and(
          eq(authChallenges.id, challengeId),
          eq(authChallenges.status, "claimed"),
          eq(authChallenges.claimedByTelegramUserId, profile.id),
          gt(authChallenges.expiresAt, now),
        ),
      )
      .returning({ id: authChallenges.id });
    return row ? user : null;
  });
}

export async function rejectLoginChallenge(db: DbOrTx, challengeId: string, telegramUserId: number) {
  const [row] = await db
    .update(authChallenges)
    .set({ status: "rejected" })
    .where(
      and(
        eq(authChallenges.id, challengeId),
        eq(authChallenges.status, "claimed"),
        eq(authChallenges.claimedByTelegramUserId, telegramUserId),
      ),
    )
    .returning({ id: authChallenges.id });
  return row ?? null;
}

export type ChallengePollResult =
  | { state: "pending" | "claimed" }
  | { state: "expired" | "rejected" | "invalid" }
  | { state: "signed_in"; sessionToken: string; sessionExpiresAt: Date; userId: string; returnTo: string | null };

/**
 * Browser polls with its cookie. On `confirmed`, atomically consume and mint a session.
 */
export async function pollLoginChallenge(
  deps: Pick<Deps, "db" | "now">,
  browserCookie: string | undefined,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<ChallengePollResult> {
  const parsed = parseChallengeCookie(browserCookie);
  if (!parsed) return { state: "invalid" };
  const now = deps.now();
  const [challenge] = await deps.db.select().from(authChallenges).where(eq(authChallenges.id, parsed.challengeId)).limit(1);
  if (!challenge || !constantTimeEqual(challenge.browserSecretHash, sha256(parsed.browserSecret))) return { state: "invalid" };
  if (challenge.status === "rejected") return { state: "rejected" };
  if (challenge.status === "consumed") return { state: "invalid" };
  if (challenge.expiresAt <= now && challenge.status !== "confirmed") return { state: "expired" };
  if (challenge.status === "pending" || challenge.status === "claimed") return { state: challenge.status };
  if (challenge.status !== "confirmed" || !challenge.userId) return { state: "invalid" };

  return deps.db.transaction(async (tx) => {
    const [consumed] = await tx
      .update(authChallenges)
      .set({ status: "consumed", consumedAt: now })
      .where(and(eq(authChallenges.id, challenge.id), eq(authChallenges.status, "confirmed")))
      .returning({ userId: authChallenges.userId });
    if (!consumed?.userId) return { state: "invalid" } as const;
    const session = await createSession(tx, consumed.userId, now, meta);
    return { state: "signed_in", ...session, userId: consumed.userId, returnTo: challenge.returnTo } as const;
  });
}

function parseChallengeCookie(value: string | undefined) {
  if (!value) return null;
  const [challengeId, browserSecret] = value.split(".");
  if (!challengeId || !browserSecret || !/^[0-9a-f-]{36}$/.test(challengeId)) return null;
  return { challengeId, browserSecret };
}

export async function createSession(db: DbOrTx, userId: string, now: Date, meta: { ip?: string | null; userAgent?: string | null }) {
  const sessionToken = randomToken();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256(sessionToken),
    expiresAt: sessionExpiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  return { sessionToken, sessionExpiresAt };
}

/** Resolve a session cookie to its user. Touches last_seen_at at most every 10 minutes. */
export async function getSessionUser(db: DbOrTx, sessionToken: string | undefined, now: Date) {
  if (!sessionToken || sessionToken.length > 100) return null;
  const [row] = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(sessionToken)), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row) return null;
  if (now.getTime() - row.session.lastSeenAt.getTime() > 10 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.session.id));
  }
  return { sessionId: row.session.id, user: row.user };
}

export async function revokeSession(db: DbOrTx, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(sessionToken)));
}

export async function pruneAuth(db: DbOrTx, now: Date) {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(authChallenges).where(lt(authChallenges.expiresAt, new Date(now.getTime() - 24 * 3_600_000)));
  await db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
}
