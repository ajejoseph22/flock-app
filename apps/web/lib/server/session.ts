import "server-only";
import { ensureCreator, getCreatorByUserId, getSessionUser } from "@flock/core";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { deps } from "./deps";

export const SESSION_COOKIE = "flock_session";
export const LOGIN_COOKIE = "flock_login";

export function cookieBase() {
  return { httpOnly: true, sameSite: "lax" as const, secure: deps().config.appUrl.startsWith("https://"), path: "/" };
}

/** The signed-in user for this request, or null. Memoised per request. */
export const currentUser = cache(async () => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const d = deps();
  const result = await getSessionUser(d.db, token, d.now());
  return result?.user ?? null;
});

export type SessionUser = NonNullable<Awaited<ReturnType<typeof currentUser>>>;

export function loginUrl(returnTo: string) {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function requireUser(returnTo: string): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect(loginUrl(returnTo));
  return user;
}

/** Creator pages: signing in to the dashboard makes you a creator (idempotent). */
export const requireCreator = cache(async (returnTo = "/dashboard") => {
  const user = await requireUser(returnTo);
  const creator = await ensureCreator(deps().db, user);
  return { user, creator };
});

/** For actions/route handlers: creator if one exists, never creates. */
export async function creatorForAction() {
  const user = await currentUser();
  if (!user) return null;
  const creator = await getCreatorByUserId(deps().db, user.id);
  return creator ? { user, creator } : null;
}

export function isAdmin(user: SessionUser | null) {
  return Boolean(user && deps().config.adminTelegramUserIds.includes(user.telegramUserId));
}

export async function requireAdmin() {
  const user = await currentUser();
  if (!isAdmin(user)) notFound();
  return user!;
}
