import { communities, entitlements, telegramAccessGrants, telegramChats, users, type DbOrTx } from "@flock/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { grantDecision, reconcileAction, revokeDecision, type MemberStatus } from "../domain/access";
import { TelegramApiError } from "../errors";
import { enqueue } from "../jobs/queue";
import { tgEscape } from "../telegram-html";
import { audit, track } from "./audit";
import { notifyQuietly, refreshConnectedChat } from "./chat-connection";

type Grant = typeof telegramAccessGrants.$inferSelect;

async function lockAccess(tx: DbOrTx, userId: string, communityId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`access:${userId}:${communityId}`}, 0))`);
}

/** Desired access = any active entitlement whose access hasn't ended. Always computed fresh. */
export async function isAccessDesired(db: DbOrTx, userId: string, communityId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(and(eq(entitlements.userId, userId), eq(entitlements.communityId, communityId), eq(entitlements.status, "active"), gt(entitlements.accessEndsAt, now)))
    .limit(1);
  return Boolean(row);
}

async function getGrant(db: DbOrTx, userId: string, communityId: string): Promise<Grant | null> {
  const [g] = await db
    .select()
    .from(telegramAccessGrants)
    .where(and(eq(telegramAccessGrants.userId, userId), eq(telegramAccessGrants.communityId, communityId)))
    .limit(1);
  return g ?? null;
}

async function loadContext(db: DbOrTx, userId: string, communityId: string) {
  const [row] = await db
    .select({ user: users, community: communities })
    .from(users)
    .innerJoin(communities, eq(communities.id, communityId))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  const [chat] = await db.select().from(telegramChats).where(eq(telegramChats.communityId, communityId)).limit(1);
  return { ...row, chat: chat ?? null };
}

/**
 * Compare desired access with the grant and enqueue the Telegram operation needed to converge.
 * Called after every entitlement change and by reconciliation.
 */
export async function reconcileAccess(deps: Pick<Deps, "db" | "now">, userId: string, communityId: string) {
  return deps.db.transaction(async (tx) => {
    await lockAccess(tx, userId, communityId);
    const desired = await isAccessDesired(tx, userId, communityId, deps.now());
    const grant = await getGrant(tx, userId, communityId);
    const action = reconcileAction(desired, grant?.state ?? null);

    if (action === "issue_invite") {
      if (!grant) {
        await tx.insert(telegramAccessGrants).values({ userId, communityId, state: "pending", desired: true });
      } else {
        await tx.update(telegramAccessGrants).set({ state: "pending", desired: true }).where(eq(telegramAccessGrants.id, grant.id));
      }
      await enqueue(tx, "access.issue_invite", { userId, communityId }, { dedupeKey: `invite:${userId}:${communityId}` });
    } else if (action === "revoke") {
      await tx.update(telegramAccessGrants).set({ state: "revoking", desired: false }).where(eq(telegramAccessGrants.id, grant!.id));
      await enqueue(tx, "access.revoke", { userId, communityId }, { dedupeKey: `revoke:${userId}:${communityId}` });
    } else if (grant && grant.desired !== desired) {
      await tx.update(telegramAccessGrants).set({ desired }).where(eq(telegramAccessGrants.id, grant.id));
    }
    return { desired, action };
  });
}

/** Map a member status, accounting for `restricted` users who may or may not be in the chat. */
function effectiveStatus(m: { status: MemberStatus; isMember?: boolean }): MemberStatus {
  if (m.status === "restricted") return m.isMember ? "member" : "left";
  return m.status;
}

async function handlePermissionError(deps: Deps, err: unknown, chatRowId: string) {
  if (err instanceof TelegramApiError && (err.kind === "permission" || err.kind === "chat_not_found")) {
    await refreshConnectedChat(deps, chatRowId).catch(() => undefined);
  }
}

/** Telegram failure → grant `failed` with the reason; rethrow so the job retries with backoff. */
async function recordGrantFailure(deps: Deps, grantId: string, err: unknown, ctx: { userId: string; communityId: string; creatorId: string }) {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof TelegramApiError ? err.kind : "error";
  await deps.db.update(telegramAccessGrants).set({ state: "failed", lastError: message.slice(0, 500), lastErrorCode: code }).where(eq(telegramAccessGrants.id, grantId));
  await audit(deps.db, { actorType: "system", creatorId: ctx.creatorId, communityId: ctx.communityId, subjectUserId: ctx.userId, action: "access.grant_failed", details: { error: message.slice(0, 300), code } });
  await track(deps.db, ANALYTICS.accessGrantFailed, { userId: ctx.userId, creatorId: ctx.creatorId, communityId: ctx.communityId }, { code });
}

export type IssueInviteResult = "not_desired" | "no_chat" | "already_member" | "banned_by_admin" | "invited";

/** Create a join-request invite link for an entitled user and DM it to them. */
export async function issueInvite(deps: Deps, userId: string, communityId: string, opts: { notify?: boolean } = {}): Promise<IssueInviteResult> {
  const result = await issueInviteOnce(deps, userId, communityId, opts);
  // Entitlement may have ended while we were talking to Telegram; converge again if so.
  if (result !== "not_desired" && !(await isAccessDesired(deps.db, userId, communityId, deps.now()))) {
    await reconcileAccess(deps, userId, communityId);
  }
  return result;
}

async function issueInviteOnce(deps: Deps, userId: string, communityId: string, opts: { notify?: boolean }): Promise<IssueInviteResult> {
  const ctx = await loadContext(deps.db, userId, communityId);
  if (!ctx) return "not_desired";
  const now = deps.now();
  if (!(await isAccessDesired(deps.db, userId, communityId, now))) return "not_desired";
  let grant = await getGrant(deps.db, userId, communityId);
  if (!grant) {
    await deps.db.insert(telegramAccessGrants).values({ userId, communityId, state: "pending" }).onConflictDoNothing();
    grant = await getGrant(deps.db, userId, communityId);
    if (!grant) throw new Error("grant upsert failed");
  }
  const ids = { userId, communityId, creatorId: ctx.community.creatorId };

  if (!ctx.chat) {
    await deps.db.update(telegramAccessGrants).set({ state: "failed", lastError: "No Telegram chat is connected to this community.", lastErrorCode: "no_chat" }).where(eq(telegramAccessGrants.id, grant.id));
    return "no_chat";
  }
  const chat = ctx.chat;

  try {
    const member = await deps.telegram.getChatMember(chat.telegramChatId, ctx.user.telegramUserId).catch((err: unknown) => {
      // "user not found" for someone never in the chat is a normal answer, not a failure.
      if (err instanceof TelegramApiError && err.kind === "bad_request") return null;
      throw err;
    });
    const decision = grantDecision(member ? effectiveStatus(member) : null);

    if (decision.action === "already_member") {
      await deps.db
        .update(telegramAccessGrants)
        .set({ state: "member", joinedAt: grant.joinedAt ?? now, lastError: null, lastErrorCode: null, note: null })
        .where(eq(telegramAccessGrants.id, grant.id));
      await audit(deps.db, { actorType: "system", ...ids, subjectUserId: userId, action: "access.already_member" });
      await track(deps.db, ANALYTICS.accessGranted, ids, { via: "already_member" });
      return "already_member";
    }
    if (decision.action === "banned_by_admin") {
      await deps.db
        .update(telegramAccessGrants)
        .set({ state: "failed", lastError: "This Telegram account was banned by a community admin.", lastErrorCode: "banned_by_admin" })
        .where(eq(telegramAccessGrants.id, grant.id));
      await audit(deps.db, { actorType: "system", ...ids, subjectUserId: userId, action: "access.grant_failed", details: { code: "banned_by_admin" } });
      await track(deps.db, ANALYTICS.accessGrantFailed, ids, { code: "banned_by_admin" });
      return "banned_by_admin";
    }

    if (grant.inviteLink) {
      await deps.telegram.revokeInviteLink(chat.telegramChatId, grant.inviteLink).catch(() => undefined);
    }
    const expiresAt = new Date(now.getTime() + deps.config.access.inviteLinkTtlMs);
    const link = await deps.telegram.createJoinRequestLink(chat.telegramChatId, { name: `Flock ${grant.id.slice(0, 8)}`, expireDate: expiresAt });
    await deps.db
      .update(telegramAccessGrants)
      .set({ state: "invited", inviteLink: link, inviteLinkExpiresAt: expiresAt, lastError: null, lastErrorCode: null, note: null })
      .where(eq(telegramAccessGrants.id, grant.id));
    await audit(deps.db, { actorType: "system", ...ids, subjectUserId: userId, action: "access.invite_issued", details: { expiresAt: expiresAt.toISOString() } });

    if (opts.notify !== false) {
      const what = chat.chatType === "channel" ? "channel" : "group";
      await notifyQuietly(
        deps,
        ctx.user.telegramUserId,
        `🎉 Your membership to <b>${tgEscape(ctx.community.name)}</b> is active.\n\nTap below to request to join the ${what}. Flock approves your request automatically. This link is personal and only works for your Telegram account.`,
        [[{ text: `Join ${ctx.community.name}`.slice(0, 60), url: link }]],
      );
    }
    return "invited";
  } catch (err) {
    await handlePermissionError(deps, err, chat.id);
    await recordGrantFailure(deps, grant.id, err, ids);
    throw err;
  }
}

/** A user asked to join a connected chat. Approve iff they hold an active entitlement. */
export async function handleJoinRequest(deps: Deps, telegramUserId: number, telegramChatId: number) {
  const [chat] = await deps.db.select().from(telegramChats).where(eq(telegramChats.telegramChatId, telegramChatId)).limit(1);
  if (!chat) return "unknown_chat" as const;
  const [community] = await deps.db.select().from(communities).where(eq(communities.id, chat.communityId)).limit(1);
  const [user] = await deps.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  const now = deps.now();
  const desired = user ? await isAccessDesired(deps.db, user.id, chat.communityId, now) : false;
  const ids = { creatorId: community?.creatorId, communityId: chat.communityId, subjectUserId: user?.id ?? null };

  try {
    if (!desired || !user) {
      await deps.telegram.declineJoinRequest(telegramChatId, telegramUserId).catch((err: unknown) => {
        if (err instanceof TelegramApiError && err.kind === "request_missing") return;
        throw err;
      });
      await audit(deps.db, { actorType: "telegram", ...ids, action: "access.join_declined", details: { telegramUserId } });
      return "declined" as const;
    }

    const grant = await getGrant(deps.db, user.id, chat.communityId);
    if (grant) await deps.db.update(telegramAccessGrants).set({ note: "join_requested" }).where(eq(telegramAccessGrants.id, grant.id));

    await deps.telegram.approveJoinRequest(telegramChatId, telegramUserId).catch((err: unknown) => {
      if (err instanceof TelegramApiError && (err.kind === "already_participant" || err.kind === "request_missing")) return;
      throw err;
    });
    const values = { state: "member" as const, joinedAt: now, note: null, lastError: null, lastErrorCode: null, desired: true };
    if (grant) {
      await deps.db.update(telegramAccessGrants).set(values).where(eq(telegramAccessGrants.id, grant.id));
      if (grant.inviteLink) await deps.telegram.revokeInviteLink(telegramChatId, grant.inviteLink).catch(() => undefined);
    } else {
      await deps.db.insert(telegramAccessGrants).values({ userId: user.id, communityId: chat.communityId, ...values }).onConflictDoNothing();
    }
    await audit(deps.db, { actorType: "telegram", ...ids, action: "access.join_approved" });
    await track(deps.db, ANALYTICS.accessGranted, { userId: user.id, creatorId: community?.creatorId, communityId: chat.communityId }, { via: "join_request" });
    return "approved" as const;
  } catch (err) {
    await handlePermissionError(deps, err, chat.id);
    throw err;
  }
}

export type RevokeResult = "still_entitled" | "no_grant" | "no_chat" | "admin_not_removed" | "already_gone" | "removed";

/**
 * Remove a user whose access ended. Re-checks entitlement first; never removes owners/admins;
 * ban+unban so they can rejoin after paying again (D-007).
 */
export async function revokeAccess(deps: Deps, userId: string, communityId: string): Promise<RevokeResult> {
  const result = await revokeAccessOnce(deps, userId, communityId);
  // A payment may have landed while we were removing them; re-invite if so.
  if (result !== "still_entitled" && result !== "no_grant" && (await isAccessDesired(deps.db, userId, communityId, deps.now()))) {
    await reconcileAccess(deps, userId, communityId);
  }
  return result;
}

async function revokeAccessOnce(deps: Deps, userId: string, communityId: string): Promise<RevokeResult> {
  const ctx = await loadContext(deps.db, userId, communityId);
  const grant = await getGrant(deps.db, userId, communityId);
  if (!ctx || !grant) return "no_grant";
  const now = deps.now();
  const ids = { creatorId: ctx.community.creatorId, communityId, subjectUserId: userId };

  if (await isAccessDesired(deps.db, userId, communityId, now)) {
    await reconcileAccess(deps, userId, communityId);
    return "still_entitled";
  }
  const finish = async (result: RevokeResult, note: string | null) => {
    await deps.db
      .update(telegramAccessGrants)
      .set({ state: "revoked", revokedAt: now, note, inviteLink: null, inviteLinkExpiresAt: null, lastError: null, lastErrorCode: null, desired: false })
      .where(eq(telegramAccessGrants.id, grant.id));
    await audit(deps.db, { actorType: "system", ...ids, action: result === "removed" ? "access.revoked" : `access.revoke_${result}` });
    if (result === "removed") await track(deps.db, ANALYTICS.accessRevoked, { userId, creatorId: ctx.community.creatorId, communityId });
    return result;
  };

  if (!ctx.chat) return finish("no_chat", "no_chat");
  const chat = ctx.chat;
  try {
    if (grant.inviteLink) await deps.telegram.revokeInviteLink(chat.telegramChatId, grant.inviteLink).catch(() => undefined);
    const member = await deps.telegram.getChatMember(chat.telegramChatId, ctx.user.telegramUserId).catch((err: unknown) => {
      if (err instanceof TelegramApiError && err.kind === "bad_request") return { status: "left" as const };
      throw err;
    });
    const decision = revokeDecision(effectiveStatus(member), grant.note === "ban_in_progress");

    switch (decision.action) {
      case "skip_admin":
        return finish("admin_not_removed", "admin_not_removed");
      case "already_gone":
        return finish("already_gone", null);
      case "lift_stale_ban":
        await deps.telegram.unbanChatMember(chat.telegramChatId, ctx.user.telegramUserId, { onlyIfBanned: true });
        return finish("already_gone", null);
      case "remove": {
        // Persist intent first so a crash between ban and unban is repaired on retry (lift_stale_ban).
        await deps.db.update(telegramAccessGrants).set({ note: "ban_in_progress" }).where(eq(telegramAccessGrants.id, grant.id));
        await deps.telegram.banChatMember(chat.telegramChatId, ctx.user.telegramUserId);
        await deps.telegram.unbanChatMember(chat.telegramChatId, ctx.user.telegramUserId, { onlyIfBanned: true });
        const result = await finish("removed", null);
        await notifyQuietly(deps, ctx.user.telegramUserId, `Your membership to <b>${tgEscape(ctx.community.name)}</b> has ended, so you've been removed from the ${chat.chatType === "channel" ? "channel" : "group"}. You can rejoin any time by subscribing again.`);
        return result;
      }
    }
  } catch (err) {
    await handlePermissionError(deps, err, chat.id);
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(telegramAccessGrants)
      .set({ lastError: message.slice(0, 500), lastErrorCode: err instanceof TelegramApiError ? err.kind : "error" })
      .where(eq(telegramAccessGrants.id, grant.id));
    throw err;
  }
}

/** `chat_member` update: a user's membership in a connected chat changed. */
export async function handleMemberUpdate(deps: Pick<Deps, "db" | "now">, telegramChatId: number, telegramUserId: number, member: { status: MemberStatus; isMember?: boolean }) {
  const [chat] = await deps.db.select().from(telegramChats).where(eq(telegramChats.telegramChatId, telegramChatId)).limit(1);
  if (!chat) return;
  const [user] = await deps.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  if (!user) return;
  const grant = await getGrant(deps.db, user.id, chat.communityId);
  if (!grant) return;
  const status = effectiveStatus(member);
  const inChat = status === "member" || status === "administrator" || status === "creator";

  if (inChat && grant.state !== "member" && grant.state !== "revoking") {
    await deps.db.update(telegramAccessGrants).set({ state: "member", joinedAt: grant.joinedAt ?? deps.now(), note: null }).where(eq(telegramAccessGrants.id, grant.id));
  } else if (!inChat && (grant.state === "member" || grant.state === "invited") && grant.note !== "ban_in_progress") {
    await deps.db.update(telegramAccessGrants).set({ state: "left", note: status === "kicked" ? "removed_by_admin" : "left_voluntarily" }).where(eq(telegramAccessGrants.id, grant.id));
    const [community] = await deps.db.select({ creatorId: communities.creatorId }).from(communities).where(eq(communities.id, chat.communityId));
    await audit(deps.db, {
      actorType: "telegram",
      creatorId: community?.creatorId,
      communityId: chat.communityId,
      subjectUserId: user.id,
      action: status === "kicked" ? "access.removed_by_admin" : "access.left_chat",
    });
  }
}
